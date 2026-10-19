import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { TrackType, TrackSource, IngressState_Status, VideoCodec } from '@livekit/protocol';

// ── LiveKit fakes: one stateful room + ingress registry ─────────────────────
const lk = vi.hoisted(() => ({
  rooms: new Map<string, { name: string; metadata: string }>(),
  participants: new Map<string, unknown[]>(),
  ingresses: new Map<string, Record<string, unknown>>(),
  createIngressCalls: [] as unknown[],
  n: 0,
}));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms.values()].filter((r) => !names || names.includes(r.name))),
    listParticipants: vi.fn(async (name: string) => lk.participants.get(name) ?? []),
    createRoom: vi.fn(async (o: { name: string; metadata: string }) => {
      lk.rooms.set(o.name, { name: o.name, metadata: o.metadata });
      return { name: o.name };
    }),
    updateRoomMetadata: vi.fn(async (name: string, metadata: string) => {
      const r = lk.rooms.get(name);
      if (r) r.metadata = metadata;
    }),
    deleteRoom: vi.fn(async (name: string) => { lk.rooms.delete(name); }),
  },
  generateRoomName: vi.fn(() => `alice-room${++lk.n}`),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('livekit-server-sdk', async (orig) => {
  const real = await orig<typeof import('livekit-server-sdk')>();
  class FakeIngressClient {
    async createIngress(input: unknown, opts: Record<string, unknown>) {
      lk.createIngressCalls.push({ input, opts });
      const info = {
        ingressId: `IN_${++lk.n}`, streamKey: `LKKEY${lk.n}`, name: opts.name, roomName: opts.roomName,
        participantIdentity: opts.participantIdentity,
        state: { status: IngressState_Status.ENDPOINT_INACTIVE, tracks: [], resourceId: '' },
      };
      lk.ingresses.set(info.ingressId, info);
      return info;
    }
    async listIngress(o: { ingressId?: string; roomName?: string }) {
      return [...lk.ingresses.values()].filter((i) => (!o?.ingressId || i.ingressId === o.ingressId) && (!o?.roomName || i.roomName === o.roomName));
    }
    async deleteIngress(id: string) { lk.ingresses.delete(id); }
  }
  return { ...real, IngressClient: FakeIngressClient };
});

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));
vi.mock('../../src/lib/permissions.js', () => ({
  canRecordVideo: vi.fn().mockResolvedValue({ ok: false }),
  canRecordAudio: vi.fn().mockResolvedValue({ ok: false }),
}));
vi.mock('../../src/routes/recording.js', () => ({
  startStandaloneVod: vi.fn().mockResolvedValue({ egressId: 'EG_1', filepath: '/tmp/x.mp4' }),
  stopStandaloneVod: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/routes/dvr.js', () => ({
  startDvrSession: vi.fn().mockResolvedValue('EG_2'),
  stopDvrSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/streamTemplates.js', async () => {
  const { createFakeStore } = await import('../helpers/fakeTemplateStore.js');
  return createFakeStore();
});

import * as hs from '../../src/lib/headlessStreams.js';
import * as store from '../../src/lib/streamTemplates.js';
import { defaultTemplateFields } from '../../src/lib/streamTemplateInput.js';
import type { TemplateDoc } from '../../src/lib/streamTemplates.js';

const fetchMock = vi.fn();

async function makeTemplate(over: Partial<TemplateDoc> = {}): Promise<TemplateDoc> {
  const t = await store.insertTemplate('alice', {
    ...defaultTemplateFields('alice'), name: `T${++lk.n}`, title: 'My stream', tags: ['obs'], ...over,
  } as never, `t${lk.n}`);
  if (t === 'name_taken') throw new Error('setup');
  return t;
}

function setIngress(id: string, status: IngressState_Status, video = { width: 1280, height: 720 }) {
  const i = lk.ingresses.get(id)!;
  i.state = { status, tracks: [], resourceId: 'RES1', video: { ...video, averageBitrate: 2_500_000, framerate: 30 } };
}

function publishHost(room: string, video = { width: 1280, height: 720 }) {
  lk.participants.set(room, [{
    identity: 'alice',
    tracks: [
      { sid: 'TR_V', type: TrackType.VIDEO, source: TrackSource.CAMERA, name: 'studio-program', ...video },
      { sid: 'TR_A', type: TrackType.AUDIO, source: TrackSource.MICROPHONE, name: 'studio-mix' },
    ],
  }]);
}

const meta = (room: string) => JSON.parse(lk.rooms.get(room)!.metadata);

beforeEach(() => {
  hs._resetHeadlessForTests();
  lk.rooms.clear(); lk.participants.clear(); lk.ingresses.clear(); lk.createIngressCalls.length = 0;
  (store as unknown as { _templates: Map<string, unknown> })._templates.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (String(url).startsWith('http://127.0.0.1:8086/w/') && init?.method === 'POST') {
      return new Response('v=0\r\nanswer\r\n', {
        status: 201,
        headers: { 'Content-Type': 'application/sdp', Location: `/w/LKKEY/RES1`, ETag: '"e1"' },
      });
    }
    if (String(url).endsWith('/api/openpods/announce')) {
      return new Response(JSON.stringify({ ok: true, permlink: 'p' }), { status: 200 });
    }
    return new Response('', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  hs._resetHeadlessForTests();
});

describe('startHeadlessStream', () => {
  it('creates a headless room + host-identity ingress and proxies the SDP', async () => {
    const t = await makeTemplate();
    const r = await hs.startHeadlessStream(t, 'v=0\r\noffer\r\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(201);
    expect(r.answer).toBe('v=0\r\nanswer\r\n');
    expect(r.headers.etag).toBe('"e1"');
    // The LiveKit stream key must never reach the client.
    expect(JSON.stringify(r)).not.toContain('LKKEY');

    const [room] = [...lk.rooms.keys()];
    const m = meta(room);
    expect(m).toMatchObject({
      host: 'alice', mode: 'standalone', headless: true, templateId: t._id.toHexString(),
      watermark: true, title: 'My stream', post: { title: 'My stream', tags: ['obs'] },
    });
    expect(m.liveAt).toBeUndefined();
    expect(m.broadcasting).toBeUndefined();
    expect(m.whipSession).toBe(createHash('sha256').update(r.sessionToken).digest('hex'));

    const { opts } = lk.createIngressCalls[0] as { opts: Record<string, any> };
    expect(opts).toMatchObject({ roomName: room, participantIdentity: 'alice', participantName: 'alice', enableTranscoding: true });
    expect(opts.video.name).toBe('studio-program');
    expect(opts.video.source).toBe(TrackSource.CAMERA);
    expect(opts.video.encodingOptions.value.videoCodec).toBe(VideoCodec.VP8);
    expect(opts.video.encodingOptions.value.layers ?? []).toHaveLength(0);
    expect(opts.audio.name).toBe('studio-mix');
    expect(opts.audio.source).toBe(TrackSource.MICROPHONE);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8086\/w\/LKKEY\d+$/);
    expect(init.body).toBe('v=0\r\noffer\r\n');

    expect(hs.isTemplateBusy(t._id.toHexString())).toBe(true);
    expect(hs.getHeadlessStatus(t._id.toHexString())).toMatchObject({ state: 'connecting', room });
  });

  it('refuses a second connect for the same template, even concurrently', async () => {
    const t = await makeTemplate();
    const [a, b] = await Promise.all([hs.startHeadlessStream(t, 'x'), hs.startHeadlessStream(t, 'x')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const failed = (a.ok ? b : a) as { status: number };
    expect(failed.status).toBe(409);
    expect(lk.rooms.size).toBe(1);
  });

  it('cleans up the room and ingress when the ingress rejects the offer', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('bad sdp', { status: 400 }));
    const t = await makeTemplate();
    const r = await hs.startHeadlessStream(t, 'garbage');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(lk.rooms.size).toBe(0);
    expect(lk.ingresses.size).toBe(0);
    expect(hs.isTemplateBusy(t._id.toHexString())).toBe(false);
  });

  it('flags Pro streams without a watermark', async () => {
    const users = await import('../../src/lib/users.js');
    vi.mocked(users.getUserStatus).mockResolvedValueOnce({ banned: false, premium: true });
    const t = await makeTemplate();
    await hs.startHeadlessStream(t, 'x');
    expect(meta([...lk.rooms.keys()][0]).watermark).toBe(false);
  });
});

describe('session lifecycle', () => {
  async function started(over: Partial<TemplateDoc> = {}) {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t = await makeTemplate(over);
    const r = await hs.startHeadlessStream(t, 'x');
    if (!r.ok) throw new Error('start failed');
    const room = [...lk.rooms.keys()][0];
    const ingressId = [...lk.ingresses.keys()][0];
    return { t, r, room, ingressId };
  }

  it('goes live on first publish: stamps liveAt/broadcasting/portrait, announces once', async () => {
    const { t, room, ingressId } = await started({ announce: { ...defaultTemplateFields('alice').announce, enabled: true, community: 'hive-181335' } });
    setIngress(ingressId, IngressState_Status.ENDPOINT_PUBLISHING, { width: 720, height: 1280 });
    publishHost(room, { width: 720, height: 1280 });
    await vi.advanceTimersByTimeAsync(2600);

    const m = meta(room);
    expect(m.broadcasting).toBe(true);
    expect(typeof m.liveAt).toBe('string');
    expect(m.portrait).toBe(true);
    expect(m.willPublishVod).toBe(false); // non-Pro
    const st = hs.getHeadlessStatus(t._id.toHexString());
    expect(st).toMatchObject({ state: 'live', room, ingress: { status: 'publishing', width: 720, height: 1280, fps: 30 } });

    await vi.advanceTimersByTimeAsync(10);
    const ann = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/openpods/announce'));
    expect(ann).toHaveLength(1);
    expect(ann[0][1].headers['X-Announce-Secret']).toBe('test-announce-secret');
    expect(JSON.parse(ann[0][1].body)).toMatchObject({
      host: 'alice', room, title: 'My stream', community: 'hive-181335', portrait: true, premium: false,
    });
    expect(hs.getHeadlessStatus(t._id.toHexString())?.announced).toEqual({ ok: true });

    // Non-Pro: no VOD, no DVR.
    const rec = await import('../../src/routes/recording.js');
    const dvr = await import('../../src/routes/dvr.js');
    expect(rec.startStandaloneVod).not.toHaveBeenCalled();
    expect(dvr.startDvrSession).not.toHaveBeenCalled();

    // Further ticks don't re-announce.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/openpods/announce'))).toHaveLength(1);
  });

  it('records a failed announce without stopping the stream', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).endsWith('/api/openpods/announce')) return new Response(JSON.stringify({ ok: false, reason: 'no_posting_authority' }), { status: 200 });
      if (init?.method === 'POST') return new Response('answer', { status: 201, headers: { Location: '/w/K/R' } });
      return new Response('', { status: 200 });
    });
    const { t, room, ingressId } = await started({ announce: { ...defaultTemplateFields('alice').announce, enabled: true } });
    setIngress(ingressId, IngressState_Status.ENDPOINT_PUBLISHING);
    publishHost(room);
    await vi.advanceTimersByTimeAsync(2600);
    await vi.advanceTimersByTimeAsync(10);
    expect(hs.getHeadlessStatus(t._id.toHexString())).toMatchObject({ state: 'live', announced: { ok: false, reason: 'no_posting_authority' } });
  });

  it('starts VOD + DVR for a Pro owner who asked for them', async () => {
    const users = await import('../../src/lib/users.js');
    const perms = await import('../../src/lib/permissions.js');
    vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: true });
    vi.mocked(perms.canRecordVideo).mockResolvedValue({ ok: true });
    const { room, ingressId } = await started({ recording: { publishVod: true, allowClips: true } });
    setIngress(ingressId, IngressState_Status.ENDPOINT_PUBLISHING);
    publishHost(room);
    await vi.advanceTimersByTimeAsync(2600);
    const rec = await import('../../src/routes/recording.js');
    const dvr = await import('../../src/routes/dvr.js');
    expect(meta(room).willPublishVod).toBe(true);
    expect(rec.startStandaloneVod).toHaveBeenCalledWith(room, expect.objectContaining({ host: 'alice' }), { publish: true, download: false, owner: 'alice' }, expect.anything());
    expect(dvr.startDvrSession).toHaveBeenCalled();
    vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: false });
    vi.mocked(perms.canRecordVideo).mockResolvedValue({ ok: false });
  });

  it('tears down a session that never publishes within 60s', async () => {
    const { t } = await started();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(lk.rooms.size).toBe(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(lk.rooms.size).toBe(0);
    expect(lk.ingresses.size).toBe(0);
    expect(hs.isTemplateBusy(t._id.toHexString())).toBe(false);
    // Never live → lastLiveAt untouched.
    expect((await store.getTemplateById(t._id.toHexString()))!.lastLiveAt).toBeNull();
    // The UI is told why, so it can ask the streamer to restart OBS.
    expect(hs.getLastHeadlessEnd(t._id.toHexString())).toMatchObject({ reason: 'never_published' });
    // A new connect clears it.
    await hs.startHeadlessStream(t, 'x');
    expect(hs.getLastHeadlessEnd(t._id.toHexString())).toBeNull();
  });

  it('tears down 20s after the ingress stops publishing, and stamps lastLiveAt', async () => {
    const { t, room, ingressId } = await started();
    setIngress(ingressId, IngressState_Status.ENDPOINT_PUBLISHING);
    publishHost(room);
    await vi.advanceTimersByTimeAsync(2600);
    setIngress(ingressId, IngressState_Status.ENDPOINT_COMPLETE);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(lk.rooms.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lk.rooms.size).toBe(0);
    expect(lk.ingresses.size).toBe(0);
    const rec = await import('../../src/routes/recording.js');
    expect(rec.stopStandaloneVod).toHaveBeenCalledWith(room);
    expect((await store.getTemplateById(t._id.toHexString()))!.lastLiveAt).toBeInstanceOf(Date);
  });

  it('ends at the time cap and puts the owner on cooldown', async () => {
    const { room, ingressId } = await started();
    setIngress(ingressId, IngressState_Status.ENDPOINT_PUBLISHING);
    publishHost(room);
    await vi.advanceTimersByTimeAsync(2600);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(lk.rooms.size).toBe(0);
    expect(hs.capCooldownRemaining('alice')).toBeGreaterThan(14 * 60 * 1000);
  });

  it('WHIP DELETE ends everything and forwards DELETE to the ingress resource', async () => {
    const { t, r, room } = await started();
    expect(await hs.endWhipSession(r.sessionToken)).toBe(true);
    expect(lk.rooms.size).toBe(0);
    expect(lk.ingresses.size).toBe(0);
    expect(hs.isTemplateBusy(t._id.toHexString())).toBe(false);
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(del?.[0]).toBe('http://127.0.0.1:8086/w/LKKEY/RES1');
    expect(await hs.endWhipSession(r.sessionToken)).toBe(false);
    expect(room).toBeTruthy();
  });

  it('endHeadlessStreamForRoom (DELETE /rooms/:name) tears the session down', async () => {
    const { t, room } = await started();
    await hs.endHeadlessStreamForRoom(room, 'host_closed');
    expect(lk.rooms.size).toBe(0);
    expect(hs.isTemplateBusy(t._id.toHexString())).toBe(false);
  });
});

describe('reconcileHeadlessRooms', () => {
  it('re-adopts a publishing headless room and tears down a dead one', async () => {
    const live = await makeTemplate();
    const dead = await makeTemplate();
    lk.rooms.set('alice-live', { name: 'alice-live', metadata: JSON.stringify({ host: 'alice', mode: 'standalone', headless: true, templateId: live._id.toHexString(), whipSession: 'h'.repeat(64), liveAt: new Date().toISOString() }) });
    lk.rooms.set('alice-dead', { name: 'alice-dead', metadata: JSON.stringify({ host: 'alice', mode: 'standalone', headless: true, templateId: dead._id.toHexString(), whipSession: 'g'.repeat(64) }) });
    lk.rooms.set('bob-studio', { name: 'bob-studio', metadata: JSON.stringify({ host: 'bob', mode: 'standalone' }) });
    lk.ingresses.set('IN_L', { ingressId: 'IN_L', streamKey: 'K', name: 'headless-alice-live', roomName: 'alice-live', participantIdentity: 'alice', state: { status: IngressState_Status.ENDPOINT_PUBLISHING, resourceId: 'R', tracks: [] } });
    lk.ingresses.set('IN_D', { ingressId: 'IN_D', streamKey: 'K2', name: 'headless-alice-dead', roomName: 'alice-dead', participantIdentity: 'alice', state: { status: IngressState_Status.ENDPOINT_COMPLETE, resourceId: '', tracks: [] } });
    lk.ingresses.set('IN_O', { ingressId: 'IN_O', streamKey: 'K3', name: 'headless-gone', roomName: 'gone', participantIdentity: 'alice', state: { status: IngressState_Status.ENDPOINT_INACTIVE, tracks: [] } });

    await hs.reconcileHeadlessRooms();

    expect([...lk.rooms.keys()].sort()).toEqual(['alice-live', 'bob-studio']);
    expect([...lk.ingresses.keys()]).toEqual(['IN_L']);
    expect(hs.getHeadlessStatus(live._id.toHexString())).toMatchObject({ state: 'live', room: 'alice-live' });
    expect(hs.isTemplateBusy(dead._id.toHexString())).toBe(false);
  });
});
