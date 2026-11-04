import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';

const ingress = vi.hoisted(() => ({
  listIngress: vi.fn(),
  createIngress: vi.fn(),
  deleteIngress: vi.fn(),
}));

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('livekit-server-sdk')>();
  // A class, not an arrow mock: rooms.ts calls `new IngressClient(...)`.
  class FakeIngressClient {
    listIngress = ingress.listIngress;
    createIngress = ingress.createIngress;
    deleteIngress = ingress.deleteIngress;
  }
  return { ...orig, IngressClient: FakeIngressClient };
});

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(), listParticipants: vi.fn(), createRoom: vi.fn(),
    removeParticipant: vi.fn(), updateParticipant: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-obs'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

const ROOM = 'alice-obs';
let app: FastifyInstance;
let hostToken: string;

beforeAll(async () => {
  app = await buildApp();
  hostToken = await makeToken('alice');
});

beforeEach(async () => {
  vi.clearAllMocks();
  const { roomService } = await import('../../src/lib/livekit.js');
  vi.mocked(roomService.listRooms).mockResolvedValue([{
    name: ROOM,
    metadata: JSON.stringify({ title: 'Studio', host: 'alice', mode: 'standalone', visibility: 'public' }),
  }] as never);
  ingress.listIngress.mockResolvedValue([]);
  ingress.createIngress.mockResolvedValue({ ingressId: 'IN_1', streamKey: 'key123' });
});

const post = () => app.inject({
  method: 'POST',
  url: `/rooms/${ROOM}/ingress`,
  headers: { authorization: `Bearer ${hostToken}` },
  payload: {},
});

describe('POST /rooms/:name/ingress (OBS in the studio) is Pro-only', () => {
  it('403s a free host with pro_required and creates no ingress', async () => {
    const res = await post();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'pro_required' });
    expect(ingress.createIngress).not.toHaveBeenCalled();
  });

  it('sets up the ingress for a Pro host', async () => {
    const users = await import('../../src/lib/users.js');
    vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: true });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ingressId: 'IN_1', streamKey: 'key123' });
    expect(ingress.createIngress).toHaveBeenCalledTimes(1);
  });
});
