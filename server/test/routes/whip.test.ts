import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(), listParticipants: vi.fn(), createRoom: vi.fn(),
    removeParticipant: vi.fn(), updateParticipant: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-abc1234'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

vi.mock('../../src/lib/streamTemplates.js', async () => {
  const { createFakeStore } = await import('../helpers/fakeTemplateStore.js');
  return createFakeStore();
});

vi.mock('../../src/lib/headlessStreams.js', () => ({
  isTemplateBusy: vi.fn().mockReturnValue(false),
  getHeadlessStatus: vi.fn().mockReturnValue(null),
  streamCapMs: (p: boolean) => (p ? 4 : 1) * 3600_000,
  capCooldownRemaining: vi.fn().mockReturnValue(0),
  startHeadlessStream: vi.fn(),
  forwardWhipPatch: vi.fn(),
  endWhipSession: vi.fn(),
  getSessionByToken: vi.fn(),
  endHeadlessStreamForRoom: vi.fn(),
  headlessViewerIdentity: (h: string) => `${h}~watch`,
}));

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
let app: FastifyInstance;
let ipN = 0;
let ip = '10.1.0.1';
let secret = '';
let templateId = '';

type Store = Awaited<ReturnType<typeof import('../helpers/fakeTemplateStore.js')['createFakeStore']>>;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(async () => {
  ip = `10.1.${Math.floor(++ipN / 250)}.${ipN % 250 + 1}`;
  const store = await import('../../src/lib/streamTemplates.js') as unknown as Store;
  store._templates.clear();
  store._secrets.clear();
  secret = await store.getOrCreateStreamSecret('alice');
  const { defaultTemplateFields } = await import('../../src/lib/streamTemplateInput.js');
  const t = await store.insertTemplate('alice', { ...defaultTemplateFields('alice'), name: 'Morning Show', title: 'Live' }, 'morning-show');
  if (t === 'name_taken') throw new Error('setup');
  templateId = t._id.toHexString();

  const hs = await import('../../src/lib/headlessStreams.js');
  vi.mocked(hs.isTemplateBusy).mockReturnValue(false);
  vi.mocked(hs.capCooldownRemaining).mockReturnValue(0);
  vi.mocked(hs.startHeadlessStream).mockResolvedValue({
    ok: true, status: 201, answer: 'v=0\r\nanswer\r\n',
    headers: { etag: '"abc"', link: '<stun:stun.example>; rel="ice-server"', 'content-type': 'application/sdp' },
    sessionToken: 'tok_abcdefghijklmnopqrstuvwxyz012345',
  });
  const users = await import('../../src/lib/users.js');
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
});

function connect(path: string, opts: { auth?: string | null; type?: string; body?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': opts.type ?? 'application/sdp' };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${secret}`;
  return app.inject({ method: 'POST', url: path, headers, payload: opts.body ?? SDP, remoteAddress: ip });
}

describe('POST /whip/:owner/:slug', () => {
  it('starts the stream and returns the answer with OUR session Location', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    const res = await connect('/whip/alice/morning-show');
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/sdp/);
    expect(res.body).toBe('v=0\r\nanswer\r\n');
    expect(res.headers.location).toBe('https://hangouts.okinoko.io/whip/s/tok_abcdefghijklmnopqrstuvwxyz012345');
    expect(res.headers.etag).toBe('"abc"');
    expect(res.headers.link).toContain('ice-server');
    expect(String(res.headers['access-control-expose-headers'])).toContain('Location');
    const [tpl, sdp] = vi.mocked(hs.startHeadlessStream).mock.calls[0];
    expect(tpl._id.toHexString()).toBe(templateId);
    expect(sdp).toBe(SDP);
  });

  it('accepts a mixed-case owner in the URL', async () => {
    expect((await connect('/whip/Alice/morning-show')).statusCode).toBe(201);
  });

  it('401s a missing or wrong secret, and the secret of another user', async () => {
    const store = await import('../../src/lib/streamTemplates.js') as unknown as Store;
    const bobSecret = await store.getOrCreateStreamSecret('bob');
    expect((await connect('/whip/alice/morning-show', { auth: null })).statusCode).toBe(401);
    expect((await connect('/whip/alice/morning-show', { auth: 'Bearer ss_wrong' })).statusCode).toBe(401);
    expect((await connect('/whip/alice/morning-show', { auth: `Bearer ${bobSecret}` })).statusCode).toBe(401);
    // Right secret, wrong owner in the URL.
    expect((await connect('/whip/bob/morning-show')).statusCode).toBe(401);
  });

  it('401s before revealing whether a template exists', async () => {
    const res = await connect('/whip/alice/no-such-thing', { auth: 'Bearer ss_wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('404s an unknown slug or malformed address with the right secret', async () => {
    expect((await connect('/whip/alice/evening-show')).statusCode).toBe(404);
    expect((await connect('/whip/alice/Bad_Slug')).statusCode).toBe(404);
    expect((await connect('/whip/x/morning-show')).statusCode).toBe(404);
  });

  it('401s an owner with no secret yet', async () => {
    expect((await connect('/whip/carol/morning-show', { auth: `Bearer ${secret}` })).statusCode).toBe(401);
  });

  it('stops working immediately after a secret reset', async () => {
    const store = await import('../../src/lib/streamTemplates.js') as unknown as Store;
    const old = secret;
    const fresh = await store.resetStreamSecret('alice');
    expect((await connect('/whip/alice/morning-show', { auth: `Bearer ${old}` })).statusCode).toBe(401);
    expect((await connect('/whip/alice/morning-show', { auth: `Bearer ${fresh}` })).statusCode).toBe(201);
  });

  it('403s a banned owner', async () => {
    const users = await import('../../src/lib/users.js');
    vi.mocked(users.isUserBanned).mockResolvedValue(true);
    expect((await connect('/whip/alice/morning-show')).statusCode).toBe(403);
  });

  it('409s when the template is already live', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    vi.mocked(hs.isTemplateBusy).mockReturnValue(true);
    expect((await connect('/whip/alice/morning-show')).statusCode).toBe(409);
    expect(hs.startHeadlessStream).not.toHaveBeenCalled();
  });

  it('429s with Retry-After during the post-cap cooldown', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    vi.mocked(hs.capCooldownRemaining).mockReturnValue(90_500);
    const res = await connect('/whip/alice/morning-show');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('91');
  });

  it('415s a non-SDP body', async () => {
    expect((await connect('/whip/alice/morning-show', { type: 'application/json', body: '{}' })).statusCode).toBe(415);
  });

  it('passes a start failure through as plain text', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    vi.mocked(hs.startHeadlessStream).mockResolvedValue({ ok: false, status: 502, error: 'ingress_error', message: 'The ingest server failed' });
    const res = await connect('/whip/alice/morning-show');
    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('The ingest server failed');
  });

  it('rate-limits connects per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await connect('/whip/alice/morning-show', { auth: 'Bearer ss_wrong' })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[11]).toBe(429);
  });
});

describe('WHIP session URL', () => {
  const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz012345';

  it('DELETE ends a known session, 404s an unknown one', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    vi.mocked(hs.endWhipSession).mockResolvedValueOnce(true);
    expect((await app.inject({ method: 'DELETE', url: `/whip/s/${TOKEN}` })).statusCode).toBe(200);
    expect(hs.endWhipSession).toHaveBeenCalledWith(TOKEN);
    vi.mocked(hs.endWhipSession).mockResolvedValueOnce(false);
    expect((await app.inject({ method: 'DELETE', url: `/whip/s/${TOKEN}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/whip/s/short' })).statusCode).toBe(404);
  });

  it('PATCH forwards a trickle fragment with If-Match', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    vi.mocked(hs.getSessionByToken).mockReturnValue({} as never);
    vi.mocked(hs.forwardWhipPatch).mockResolvedValue({ status: 204, body: '', headers: { etag: '"e2"' } });
    const res = await app.inject({
      method: 'PATCH', url: `/whip/s/${TOKEN}`,
      headers: { 'content-type': 'application/trickle-ice-sdpfrag', 'if-match': '"abc"' },
      payload: 'a=ice-ufrag:x\r\n',
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers.etag).toBe('"e2"');
    expect(hs.forwardWhipPatch).toHaveBeenCalledWith(TOKEN, 'a=ice-ufrag:x\r\n', 'application/trickle-ice-sdpfrag', '"abc"');
  });

  it('PATCH 404s an unknown session', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    vi.mocked(hs.getSessionByToken).mockReturnValue(null);
    const res = await app.inject({
      method: 'PATCH', url: `/whip/s/${TOKEN}`,
      headers: { 'content-type': 'application/trickle-ice-sdpfrag' }, payload: 'a=x\r\n',
    });
    expect(res.statusCode).toBe(404);
  });
});
