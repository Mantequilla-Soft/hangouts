import { beforeEach, describe, expect, it, vi } from 'vitest';

// The tus client is faked: each test decides what a started upload does
// (answer with headers, report progress, succeed or fail).
const h = vi.hoisted(() => ({
  config: {
    EMBED_API_KEY: 'embed-key',
    EMBED_UPLOAD_URL: 'https://embed.test/uploads',
    STUDIO_FRONTEND_URL: 'https://studio.test',
  },
  uploads: [] as Array<{ source: unknown; opts: Record<string, any> }>,
  onStart: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({ config: h.config }));
vi.mock('tus-js-client', () => ({
  Upload: class {
    constructor(source: unknown, opts: Record<string, any>) {
      h.uploads.push({ source, opts });
      this.opts = opts;
    }
    opts: Record<string, any>;
    start() { h.onStart(this.opts); }
  },
}));

const { uploadToEmbedService } = await import('../../src/lib/embedUpload.js');

const EMBED_URL = 'https://play.test/embed?v=alice/abc123xy';
const BUFFER = Buffer.from('mp4 bytes');
const base = { buffer: BUFFER, filename: 'clip.mp4', filetype: 'video/mp4', owner: 'alice', duration: 12.4 };

/** A tus response whose headers are looked up case-sensitively from `headers`. */
const response = (headers: Record<string, string>) => ({ getHeader: (name: string) => headers[name] });

/** Default upload: one response carrying the embed URL, then success. */
function answerWith(headers: Record<string, string>) {
  h.onStart.mockImplementation((opts) => {
    opts.onAfterResponse({}, response(headers));
    opts.onSuccess();
  });
}

beforeEach(() => {
  h.config.EMBED_API_KEY = 'embed-key';
  h.uploads.length = 0;
  h.onStart.mockReset();
  answerWith({ 'X-Embed-URL': EMBED_URL });
});

describe('uploadToEmbedService', () => {
  it('uploads the buffer over tus with the recording metadata', async () => {
    await uploadToEmbedService(base);

    expect(h.uploads).toHaveLength(1);
    const { source, opts } = h.uploads[0];
    expect(source).toBe(BUFFER);
    expect(opts.endpoint).toBe('https://embed.test/uploads');
    expect(opts.chunkSize).toBe(5 * 1024 * 1024);
    expect(opts.headers).toEqual({ 'X-API-Key': 'embed-key' });
    expect(opts.metadata).toEqual({
      filename: 'clip.mp4',
      filetype: 'video/mp4',
      frontend_app: '3speak-hangouts',
      owner: 'alice',
      short: 'false',
      duration: '12',
    });
  });

  it('returns the embed URL, its permlink and a prefilled studio link', async () => {
    const result = await uploadToEmbedService(base);

    expect(result.embedUrl).toBe(EMBED_URL);
    expect(result.permlink).toBe('abc123xy');
    expect(result.owner).toBe('alice');
    const studio = new URL(result.studioUrl);
    expect(studio.origin + studio.pathname).toBe('https://studio.test/embed-studio');
    expect(Object.fromEntries(studio.searchParams)).toEqual({
      prefilled: 'true',
      permlink: 'abc123xy',
      owner: 'alice',
      embedUrl: EMBED_URL,
    });
  });

  it('marks shorts and stamps a custom frontend app', async () => {
    await uploadToEmbedService({ ...base, short: true, frontendApp: 'my-dapp' });

    expect(h.uploads[0].opts.metadata).toMatchObject({ short: 'true', frontend_app: 'my-dapp' });
  });

  it('sends no API key header when none is configured', async () => {
    h.config.EMBED_API_KEY = '';
    await uploadToEmbedService(base);

    expect(h.uploads[0].opts.headers).toEqual({});
  });

  it('reads the embed URL from a lower-case header too', async () => {
    answerWith({ 'x-embed-url': EMBED_URL });
    const result = await uploadToEmbedService(base);

    expect(result.permlink).toBe('abc123xy');
  });

  it('keeps the embed URL from an earlier response when later responses lack it', async () => {
    h.onStart.mockImplementation((opts) => {
      opts.onAfterResponse({}, response({ 'X-Embed-URL': EMBED_URL }));
      opts.onAfterResponse({}, response({}));
      opts.onSuccess();
    });
    const result = await uploadToEmbedService(base);

    expect(result.embedUrl).toBe(EMBED_URL);
  });

  it('reports progress as a whole percentage, and skips reports with no known total', async () => {
    const onProgress = vi.fn();
    h.onStart.mockImplementation((opts) => {
      opts.onProgress(1, 3);
      opts.onProgress(5, 0);
      opts.onProgress(3, 3);
      opts.onAfterResponse({}, response({ 'X-Embed-URL': EMBED_URL }));
      opts.onSuccess();
    });
    await uploadToEmbedService({ ...base, onProgress });

    expect(onProgress.mock.calls).toEqual([[33], [100]]);
  });

  it('tolerates progress events when the caller passed no progress callback', async () => {
    h.onStart.mockImplementation((opts) => {
      opts.onProgress(1, 2);
      opts.onAfterResponse({}, response({ 'X-Embed-URL': EMBED_URL }));
      opts.onSuccess();
    });
    await expect(uploadToEmbedService(base)).resolves.toMatchObject({ permlink: 'abc123xy' });
  });

  it('rejects with the tus error when the upload fails', async () => {
    h.onStart.mockImplementation((opts) => { opts.onError(new Error('tus: 413 too large')); });

    await expect(uploadToEmbedService(base)).rejects.toThrow('tus: 413 too large');
  });

  it('rejects when the embed service never sends an X-Embed-URL header', async () => {
    answerWith({});

    await expect(uploadToEmbedService(base)).rejects.toThrow('Embed service did not return an X-Embed-URL header');
  });

  it('rejects when the embed URL has no ?v= parameter', async () => {
    answerWith({ 'X-Embed-URL': 'https://play.test/embed' });

    await expect(uploadToEmbedService(base)).rejects.toThrow('Could not parse permlink from embed URL');
  });

  it('rejects when the ?v= parameter has an empty permlink', async () => {
    answerWith({ 'X-Embed-URL': 'https://play.test/embed?v=alice/' });

    await expect(uploadToEmbedService(base)).rejects.toThrow('Could not parse permlink from embed URL');
  });

  it('rejects when the embed URL is not an absolute URL', async () => {
    answerWith({ 'X-Embed-URL': '/embed?v=alice/abc' });

    await expect(uploadToEmbedService(base)).rejects.toThrow(TypeError);
  });
});
