import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The publish state lives in a module-level map, so every test re-imports the
// module (vi.resetModules). The disk (stat/unlink/createReadStream), the tus
// client and fetch are all fakes; fake timers drive the "wait for egress to
// finish writing" polling loops.
const h = vi.hoisted(() => ({
  config: {
    EMBED_API_KEY: 'embed-key',
    EMBED_UPLOAD_URL: 'https://embed.test/uploads',
    EMBED_API_URL: 'https://embed.test/api//',
  },
  stat: vi.fn(),
  unlink: vi.fn(),
  createReadStream: vi.fn(),
  uploads: [] as Array<{ source: unknown; opts: Record<string, any> }>,
  /** What a started upload does; default: finish successfully right away. */
  onStart: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({ config: h.config }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stat: h.stat,
  unlink: h.unlink,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createReadStream: h.createReadStream,
}));
vi.mock('tus-js-client', () => ({
  Upload: class {
    opts: Record<string, any>;
    constructor(source: unknown, opts: Record<string, any>) {
      this.opts = opts;
      h.uploads.push({ source, opts });
    }
    start() { h.onStart(this.opts); }
  },
}));

type VodModule = typeof import('../../src/lib/streamVodPublish.js');
let vod: VodModule;
let fetchMock: ReturnType<typeof vi.fn>;

const ROOM = 'alice-live 42';
const FILE = '/tmp/livekit-recordings/EG_1.mp4';
const base = {
  filePath: FILE,
  roomName: ROOM,
  owner: 'alice',
  title: 'My stream',
  description: 'All about it',
  tags: ['hive', 'live'],
  thumbnailUrl: 'https://img.test/thumb.png',
  duration: 61.6,
};

/** stat() answers in order; the last answer repeats. Errors are thrown. */
function statSequence(...answers: Array<number | Error>) {
  let i = 0;
  h.stat.mockImplementation(async () => {
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { size: a };
  });
}

/** Start a publish and let all of its timers and promises run out. */
async function publish(input: Partial<typeof base> = {}, runMs = 60_000) {
  const done = vod.publishRecordingToVod({ ...base, ...input });
  await vi.advanceTimersByTimeAsync(runMs);
  await done;
}

const fetchCalls = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url),
  body: JSON.parse(String((init as RequestInit).body)),
  headers: (init as RequestInit).headers as Record<string, string>,
  method: (init as RequestInit).method,
}));

beforeEach(async () => {
  vi.useFakeTimers();
  h.config.EMBED_API_KEY = 'embed-key';
  h.config.EMBED_API_URL = 'https://embed.test/api//';
  h.uploads.length = 0;
  h.stat.mockReset();
  statSequence(1000);
  h.unlink.mockReset().mockResolvedValue(undefined);
  h.createReadStream.mockReset().mockReturnValue({ fake: 'stream' });
  h.onStart.mockReset().mockImplementation((opts) => { opts.onSuccess(); });
  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  vod = await import('../../src/lib/streamVodPublish.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('publish state lookups', () => {
  it('reports no publish for a room that never started one', () => {
    expect(vod.hasPublish(ROOM)).toBe(false);
    expect(vod.getPublishState(ROOM)).toBeNull();
  });

  it('marks the room as uploading the moment a publish starts', async () => {
    h.onStart.mockImplementation(() => { /* never finishes */ });
    void vod.publishRecordingToVod(base);
    expect(vod.hasPublish(ROOM)).toBe(true);
    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'uploading', progress: 0 });
  });
});

describe('publishRecordingToVod: happy path', () => {
  it('uploads the file over tus with the room name as the permlink, then marks it published', async () => {
    await publish();

    expect(h.createReadStream).toHaveBeenCalledWith(FILE);
    expect(h.uploads).toHaveLength(1);
    const { source, opts } = h.uploads[0];
    expect(source).toEqual({ fake: 'stream' });
    expect(opts.endpoint).toBe('https://embed.test/uploads');
    expect(opts.uploadSize).toBe(1000);
    expect(opts.chunkSize).toBe(8 * 1024 * 1024);
    expect(opts.storeFingerprintForResuming).toBe(false);
    expect(opts.headers).toEqual({ 'X-API-Key': 'embed-key' });
    expect(opts.metadata).toEqual({
      filename: `${ROOM}.mp4`,
      filetype: 'video/mp4',
      frontend_app: '3speak-hangouts',
      owner: 'alice',
      short: 'false',
      duration: '62',
      permlink: ROOM,
    });
    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'published', progress: 100 });
    expect(vod.getPublishState(ROOM)?.error).toBeUndefined();
  });

  it('attaches the upload to the Hive post and sets its thumbnail on the embed API', async () => {
    await publish();

    const calls = fetchCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      url: 'https://embed.test/api/video/alice-live%2042/hive',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'embed-key' },
      body: {
        hive_author: 'alice',
        hive_permlink: ROOM,
        hive_title: 'My stream',
        hive_body: 'All about it',
        hive_tags: ['hive', 'live'],
      },
    });
    expect(calls[1]).toMatchObject({
      url: 'https://embed.test/api/video/alice-live%2042/thumbnail',
      method: 'POST',
      body: { thumbnail_url: 'https://img.test/thumb.png' },
    });
  });

  it('deletes the local recording once the embed service has it', async () => {
    await publish();
    expect(h.unlink).toHaveBeenCalledWith(FILE);
  });

  it('falls back to a default title, an empty body and no tags when the post has none', async () => {
    await publish({ title: undefined, description: undefined, tags: 'oops' as unknown as string[], thumbnailUrl: undefined });

    const calls = fetchCalls();
    expect(calls).toHaveLength(1); // no thumbnail call without a thumbnail
    expect(calls[0].body).toMatchObject({
      hive_title: `Live stream — ${ROOM}`,
      hive_body: '',
      hive_tags: [],
    });
  });

  it('sends a zero duration when the recording length is unknown', async () => {
    await publish({ duration: Number.NaN });
    expect(h.uploads[0].opts.metadata.duration).toBe('0');
  });

  it('reports upload progress as a whole percentage while the upload runs', async () => {
    let opts: Record<string, any> = {};
    h.onStart.mockImplementation((o) => { opts = o; });
    const done = vod.publishRecordingToVod(base);
    await vi.advanceTimersByTimeAsync(1_000);

    opts.onProgress(333, 1000);
    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'uploading', progress: 33 });
    opts.onProgress(10, 0);
    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'uploading', progress: 0 });

    opts.onSuccess();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'published', progress: 100 });
  });

  it('shows "processing" between the finished upload and the Hive association', async () => {
    let releaseFetch!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { releaseFetch = () => r(new Response('{}')); }));
    const done = vod.publishRecordingToVod(base);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'processing', progress: 100 });
    releaseFetch();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(vod.getPublishState(ROOM)?.status).toBe('published');
  });
});

describe('publishRecordingToVod: waiting for egress to finish writing', () => {
  it('waits for a recording that lands on disk a moment after stop', async () => {
    statSequence(new Error('ENOENT'), new Error('ENOENT'), 2048);
    await publish();

    expect(h.uploads[0].opts.uploadSize).toBe(2048);
    expect(vod.getPublishState(ROOM)?.status).toBe('published');
  });

  it('waits for the file size to settle and uploads the final size', async () => {
    statSequence(100, 200, 300, 300);
    await publish();

    expect(h.uploads[0].opts.uploadSize).toBe(300);
    expect(h.stat).toHaveBeenCalledTimes(4);
  });

  it('does not start uploading before the size has settled', async () => {
    statSequence(100, 200, 300, 300);
    const done = vod.publishRecordingToVod(base);
    await vi.advanceTimersByTimeAsync(400); // one settle check: 100 -> 200
    expect(h.uploads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(h.uploads).toHaveLength(1);
  });

  it('uploads the last known size if the file vanishes while settling', async () => {
    statSequence(500, new Error('ENOENT'));
    await publish();

    expect(h.uploads[0].opts.uploadSize).toBe(500);
  });

  it('stops waiting for the size to settle once the 30 s deadline has passed', async () => {
    let size = 0;
    h.stat.mockImplementation(async () => ({ size: (size += 10) }));
    await publish({}, 40_000);

    expect(h.uploads).toHaveLength(1);
    // ~30 s of 400 ms settle checks, never more.
    expect(h.stat.mock.calls.length).toBeGreaterThan(70);
    expect(h.stat.mock.calls.length).toBeLessThan(80);
    expect(h.uploads[0].opts.uploadSize).toBe(size);
  });

  it('fails and keeps nothing to delete when the recording never appears within 30 s', async () => {
    statSequence(new Error('ENOENT'));
    const done = vod.publishRecordingToVod(base);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(vod.getPublishState(ROOM)?.status).toBe('uploading');

    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(vod.getPublishState(ROOM)).toMatchObject({
      status: 'failed',
      error: 'Recording file never appeared on disk',
    });
    expect(h.uploads).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.unlink).not.toHaveBeenCalled();
  });
});

describe('publishRecordingToVod: failures', () => {
  it('fails straight away without an embed API key, before touching the disk', async () => {
    h.config.EMBED_API_KEY = '';
    await publish();

    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'failed', error: 'No embed API key configured' });
    expect(h.stat).not.toHaveBeenCalled();
    expect(h.uploads).toHaveLength(0);
  });

  it('marks the publish failed and keeps the local file when the tus upload errors', async () => {
    h.onStart.mockImplementation((opts) => { opts.onError(new Error('tus: 502 from embed')); });
    await publish();

    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'failed', error: 'tus: 502 from embed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.unlink).not.toHaveBeenCalled();
  });

  it('keeps the upload progress reached before a failure', async () => {
    h.onStart.mockImplementation((opts) => {
      opts.onProgress(40, 100);
      opts.onError(new Error('connection reset'));
    });
    await publish();

    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'failed', progress: 40, error: 'connection reset' });
  });

  it('records a non-Error failure as text', async () => {
    h.onStart.mockImplementation((opts) => { opts.onError('socket hang up'); });
    await publish();

    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'failed', error: 'socket hang up' });
  });

  it('never throws to the caller, even when the read stream cannot be opened', async () => {
    h.createReadStream.mockImplementation(() => { throw new Error('EACCES'); });
    await expect(publish()).resolves.toBeUndefined();

    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'failed', error: 'EACCES' });
  });

  it('still publishes when the Hive association call cannot reach the embed API', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await publish();

    expect(fetchMock).toHaveBeenCalledTimes(2); // the thumbnail call still runs
    expect(vod.getPublishState(ROOM)?.status).toBe('published');
    expect(h.unlink).toHaveBeenCalledWith(FILE);
  });

  it('still publishes when the thumbnail call fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await publish();

    expect(vod.getPublishState(ROOM)?.status).toBe('published');
  });

  it('treats a non-2xx answer from the embed API as published too (the response is not checked)', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await publish();

    expect(vod.getPublishState(ROOM)?.status).toBe('published');
  });

  it('still reports published when the local file is already gone at clean-up', async () => {
    h.unlink.mockRejectedValue(new Error('ENOENT'));
    await publish();

    expect(vod.getPublishState(ROOM)).toMatchObject({ status: 'published', progress: 100 });
  });
});

describe('sweepPublishStates', () => {
  async function settle(roomName: string, outcome: 'published' | 'failed') {
    h.onStart.mockImplementationOnce((opts) => {
      if (outcome === 'published') opts.onSuccess();
      else opts.onError(new Error('boom'));
    });
    await publish({ roomName });
  }

  it('drops published and failed states older than the cut-off', async () => {
    await settle('old-ok', 'published');
    await settle('old-bad', 'failed');
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);

    vod.sweepPublishStates();
    expect(vod.hasPublish('old-ok')).toBe(false);
    expect(vod.hasPublish('old-bad')).toBe(false);
  });

  it('keeps settled states that are younger than the cut-off', async () => {
    await settle('fresh', 'published');
    vi.advanceTimersByTime(30 * 60 * 1000);

    vod.sweepPublishStates();
    expect(vod.hasPublish('fresh')).toBe(true);
  });

  it('never drops a publish that is still uploading, however old', async () => {
    h.onStart.mockImplementation(() => { /* hangs */ });
    void vod.publishRecordingToVod({ ...base, roomName: 'stuck' });
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);

    vod.sweepPublishStates();
    expect(vod.getPublishState('stuck')?.status).toBe('uploading');
  });

  it('honours a custom maximum age', async () => {
    await settle('short-lived', 'published');
    vi.advanceTimersByTime(2_000);

    vod.sweepPublishStates(1_000);
    expect(vod.hasPublish('short-lived')).toBe(false);
  });
});
