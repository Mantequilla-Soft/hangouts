import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import type { GamePlugin } from '../../src/lib/game-types.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(),
    listParticipants: vi.fn(),
    sendData: vi.fn().mockResolvedValue(undefined),
    createRoom: vi.fn(),
    deleteRoom: vi.fn(),
    removeParticipant: vi.fn(),
    updateParticipant: vi.fn(),
    updateRoomMetadata: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('host-room-abc123'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

vi.mock('../../src/lib/game-registry.js', () => ({
  GameRegistry: vi.fn(),
  gameRegistry: {
    list: vi.fn(),
    get: vi.fn(),
    register: vi.fn(),
  },
}));

vi.mock('../../src/lib/game-session-store.js', () => ({
  GameSessionStore: vi.fn(),
  gameSessionStore: {
    get: vi.fn(),
    start: vi.fn(),
    end: vi.fn(),
  },
}));

const ROOM = 'alice-test-room-xyz';
const HOST_META = JSON.stringify({ host: 'alice' });

function mockRoom(host = 'alice') {
  return [{ name: ROOM, metadata: JSON.stringify({ host }), numParticipants: 2 }];
}

function mockParticipants(identities: string[]) {
  return identities.map((id) => ({ identity: id, permission: { canPublish: true } }));
}

const mockPlugin: GamePlugin = {
  id: 'word-guess',
  name: 'Word Guess',
  description: 'Test game',
  minPlayers: 2,
  maxPlayers: 12,
  onStart: vi.fn().mockReturnValue({
    state: { assignments: { alice: 'elephant', bob: 'rhino' }, theme: 'animals', guessed: [] },
    payloads: {
      alice: { myWord: null, others: [{ identity: 'bob', word: 'rhino' }], theme: 'animals' },
      bob:   { myWord: null, others: [{ identity: 'alice', word: 'elephant' }], theme: 'animals' },
    },
    broadcast: { theme: 'animals', playerCount: 2 },
  }),
  onAction: vi.fn(),
};

const mockSession = {
  gameId: 'word-guess',
  plugin: mockPlugin,
  state: { assignments: { alice: 'elephant', bob: 'rhino' }, theme: 'animals', guessed: [] },
  payloads: {
    alice: { myWord: null, others: [{ identity: 'bob', word: 'rhino' }], theme: 'animals' },
    bob:   { myWord: null, others: [{ identity: 'alice', word: 'elephant' }], theme: 'animals' },
  },
  participants: ['alice', 'bob'],
  roomName: ROOM,
  startedAt: 1000000,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /games ───────────────────────────────────────────────────────────────

describe('GET /games', () => {
  it('returns 200 with the list of available games (public, no auth)', async () => {
    const { gameRegistry } = await import('../../src/lib/game-registry.js');
    vi.mocked(gameRegistry.list).mockReturnValue([{
      id: 'word-guess',
      name: 'Word Guess',
      description: 'Guess your word',
      minPlayers: 2,
      maxPlayers: 12,
    }]);

    const res = await app.inject({ method: 'GET', url: '/games' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].id).toBe('word-guess');
  });

  it('returns an empty array when no games are registered', async () => {
    const { gameRegistry } = await import('../../src/lib/game-registry.js');
    vi.mocked(gameRegistry.list).mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/games' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

// ─── GET /rooms/:name/game ────────────────────────────────────────────────────

describe('GET /rooms/:name/game', () => {
  it('returns 401 without a session token', async () => {
    const res = await app.inject({ method: 'GET', url: `/rooms/${ROOM}/game` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when no active game exists in the room', async () => {
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');
    vi.mocked(gameSessionStore.get).mockReturnValue(undefined);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'GET',
      url: `/rooms/${ROOM}/game`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with personalized game state for the caller', async () => {
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');
    vi.mocked(gameSessionStore.get).mockReturnValue(mockSession);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'GET',
      url: `/rooms/${ROOM}/game`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().gameId).toBe('word-guess');
    expect(res.json().participants).toEqual(['alice', 'bob']);
    expect(res.json().state).toMatchObject({ myWord: null });
  });

  it('returns null state for a participant not in the session', async () => {
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');
    vi.mocked(gameSessionStore.get).mockReturnValue(mockSession);
    const token = await makeToken('carol');  // carol not in session

    const res = await app.inject({
      method: 'GET',
      url: `/rooms/${ROOM}/game`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBeNull();
  });
});

// ─── POST /rooms/:name/game/start ─────────────────────────────────────────────

describe('POST /rooms/:name/game/start', () => {
  it('returns 401 without a session token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/start`,
      payload: { gameId: 'word-guess' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(mockRoom('alice') as any);
    const token = await makeToken('bob');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { gameId: 'word-guess' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when room does not exist', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([]);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { gameId: 'word-guess' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when gameId is not registered', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const { gameRegistry } = await import('../../src/lib/game-registry.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(mockRoom() as any);
    vi.mocked(gameRegistry.get).mockReturnValue(undefined);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { gameId: 'nonexistent-game' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when there are too few players for the game', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const { gameRegistry } = await import('../../src/lib/game-registry.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(mockRoom() as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue(mockParticipants(['alice']) as any);
    vi.mocked(gameRegistry.get).mockReturnValue(mockPlugin);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { gameId: 'word-guess' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 201 and sends data channel messages on success', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const { gameRegistry } = await import('../../src/lib/game-registry.js');
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');

    vi.mocked(roomService.listRooms).mockResolvedValue(mockRoom() as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue(
      mockParticipants(['alice', 'bob']) as any,
    );
    vi.mocked(gameRegistry.get).mockReturnValue(mockPlugin);
    vi.mocked(gameSessionStore.start).mockReturnValue(mockSession);

    const token = await makeToken('alice');
    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { gameId: 'word-guess' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().gameId).toBe('word-guess');
    expect(res.json().participants).toEqual(['alice', 'bob']);

    // Broadcast + one personalized message per participant
    expect(roomService.sendData).toHaveBeenCalledTimes(3);

    const calls = vi.mocked(roomService.sendData).mock.calls;
    const decoded = calls.map(([, data]) => JSON.parse(new TextDecoder().decode(data)));
    expect(decoded.some((m) => m.type === 'game:started')).toBe(true);
    expect(decoded.filter((m) => m.type === 'game:state')).toHaveLength(2);
  });

  it('filters out guest- and obs- identities from the participant list', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const { gameRegistry } = await import('../../src/lib/game-registry.js');
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');

    vi.mocked(roomService.listRooms).mockResolvedValue(mockRoom() as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue(
      mockParticipants(['alice', 'bob', 'guest-abc', 'obs-xyz']) as any,
    );
    vi.mocked(gameRegistry.get).mockReturnValue(mockPlugin);
    vi.mocked(gameSessionStore.start).mockReturnValue(mockSession);
    const token = await makeToken('alice');

    await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { gameId: 'word-guess' },
    });

    expect(gameSessionStore.start).toHaveBeenCalledWith(
      ROOM,
      mockPlugin,
      expect.anything(),
      ['alice', 'bob'],  // guests/obs filtered out
      expect.anything(),
      undefined, // spectatorState (mock plugin does not return one)
    );
  });
});

// ─── POST /rooms/:name/game/action ────────────────────────────────────────────

describe('POST /rooms/:name/game/action', () => {
  it('returns 401 without a session token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/action`,
      payload: { action: { type: 'guess', word: 'elephant' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when no active game exists', async () => {
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');
    vi.mocked(gameSessionStore.get).mockReturnValue(undefined);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/action`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: { type: 'guess', word: 'elephant' } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when the caller is not a game participant', async () => {
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');
    vi.mocked(gameSessionStore.get).mockReturnValue(mockSession);
    const token = await makeToken('carol');  // not in session

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/action`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: { type: 'guess', word: 'elephant' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 and sends a broadcast when action returns one', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');
    const session = { ...mockSession, state: { ...mockSession.state } };
    vi.mocked(gameSessionStore.get).mockReturnValue(session);
    vi.mocked(mockPlugin.onAction).mockReturnValue({
      state: session.state,
      broadcast: { type: 'guess_result', identity: 'alice', correct: true, word: 'elephant', allGuessed: false },
    });
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/action`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: { type: 'guess', word: 'elephant' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ended).toBe(false);

    const calls = vi.mocked(roomService.sendData).mock.calls;
    const decoded = calls.map(([, data]) => JSON.parse(new TextDecoder().decode(data)));
    expect(decoded.some((m) => m.type === 'game:broadcast')).toBe(true);
  });

  it('ends the session and broadcasts game:ended when plugin returns ended:true', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');
    const session = { ...mockSession, state: { ...mockSession.state } };
    vi.mocked(gameSessionStore.get).mockReturnValue(session);
    vi.mocked(mockPlugin.onAction).mockReturnValue({
      state: session.state,
      broadcast: { type: 'guess_result', correct: true, allGuessed: true },
      ended: true,
    });
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/game/action`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: { type: 'guess', word: 'elephant' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ended).toBe(true);
    expect(gameSessionStore.end).toHaveBeenCalledWith(ROOM);

    const calls = vi.mocked(roomService.sendData).mock.calls;
    const decoded = calls.map(([, data]) => JSON.parse(new TextDecoder().decode(data)));
    expect(decoded.some((m) => m.type === 'game:ended')).toBe(true);
  });
});

// ─── DELETE /rooms/:name/game ─────────────────────────────────────────────────

describe('DELETE /rooms/:name/game', () => {
  it('returns 401 without a session token', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/rooms/${ROOM}/game` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(mockRoom('alice') as any);
    const token = await makeToken('bob');

    const res = await app.inject({
      method: 'DELETE',
      url: `/rooms/${ROOM}/game`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when room does not exist', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([]);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'DELETE',
      url: `/rooms/${ROOM}/game`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 204, ends the session, and broadcasts game:ended', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const { gameSessionStore } = await import('../../src/lib/game-session-store.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(mockRoom() as any);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'DELETE',
      url: `/rooms/${ROOM}/game`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(gameSessionStore.end).toHaveBeenCalledWith(ROOM);

    const calls = vi.mocked(roomService.sendData).mock.calls;
    const decoded = calls.map(([, data]) => JSON.parse(new TextDecoder().decode(data)));
    expect(decoded.some((m) => m.type === 'game:ended')).toBe(true);
  });
});
