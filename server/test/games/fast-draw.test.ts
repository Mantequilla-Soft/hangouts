import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fastDrawPlugin, type Stroke } from '../../src/games/fast-draw.ts';

vi.mock('../../src/lib/word-collection.js', () => ({
  findCollection: vi.fn((id: string) => {
    const collections: Record<string, { id: string; name: string; words: string[] }> = {
      animals: {
        id: 'animals', name: 'Animals',
        words: ['elephant', 'rhinoceros', 'crocodile', 'giraffe', 'penguin', 'octopus', 'kangaroo', 'chameleon', 'wolverine', 'armadillo', 'orangutan', 'platypus'],
      },
    };
    return Promise.resolve(collections[id] ?? null);
  }),
}));

const PLAYERS = ['alice', 'bob', 'carol'];

type FastDrawState = {
  phase: string;
  drawerOrder: string[];
  currentDrawerIndex: number;
  currentWord: string;
  wordQueue: string[];
  roundStartedAt: number;
  roundDuration: number;
  guessDuration: number;
  guessPhaseStartedAt: number | null;
  revealEndsAt: number | null;
  scores: Record<string, number>;
  winThreshold: number;
  winners: string[];
  roundNumber: number;
  guesser: string | null;
  strokeSnapshot: Stroke[];
};

async function start(config?: Record<string, unknown>) {
  const result = await fastDrawPlugin.onStart({ participants: PLAYERS, config });
  return {
    result,
    state: result.state as FastDrawState,
  };
}

describe('fastDrawPlugin metadata', () => {
  it('has id fast-draw', () => expect(fastDrawPlugin.id).toBe('fast-draw'));
  it('requires 3–12 players', () => {
    expect(fastDrawPlugin.minPlayers).toBe(3);
    expect(fastDrawPlugin.maxPlayers).toBe(12);
  });
});

describe('fastDrawPlugin.onStart', () => {
  it('assigns drawer from participants', async () => {
    const { state } = await start();
    expect(PLAYERS).toContain(state.drawerOrder[0]);
  });

  it('all players have a score entry', async () => {
    const { state } = await start();
    expect(Object.keys(state.scores)).toEqual(expect.arrayContaining(PLAYERS));
  });

  it('drawer payload contains word', async () => {
    const { result, state } = await start();
    const drawer = state.drawerOrder[0]!;
    const drawerPayload = result.payloads[drawer] as { role: string; word: string };
    expect(drawerPayload.role).toBe('drawer');
    expect(typeof drawerPayload.word).toBe('string');
    expect(drawerPayload.word.length).toBeGreaterThan(0);
  });

  it('guesser payloads contain wordLength not word', async () => {
    const { result, state } = await start();
    const drawer = state.drawerOrder[0]!;
    for (const p of PLAYERS) {
      if (p === drawer) continue;
      const payload = result.payloads[p] as { role: string; wordLength: number };
      expect(payload.role).toBe('guesser');
      expect(payload.wordLength).toBe(state.currentWord.length);
      expect((payload as unknown as { word?: string }).word).toBeUndefined();
    }
  });

  it('starts in drawing phase with round 1', async () => {
    const { state } = await start();
    expect(state.phase).toBe('drawing');
    expect(state.roundNumber).toBe(1);
  });

  it('spectatorState does not reveal word during drawing phase', async () => {
    const { result } = await start();
    const spec = result.spectatorState as { revealedWord: string | null; wordLength: number };
    expect(spec.revealedWord).toBeNull();
    expect(typeof spec.wordLength).toBe('number');
  });

  it('broadcast is fast_draw_round_start', async () => {
    const { result } = await start();
    expect((result.broadcast as { type: string }).type).toBe('fast_draw_round_start');
  });

  it('respects custom winThreshold config', async () => {
    const { state } = await start({ winThreshold: 3 });
    expect(state.winThreshold).toBe(3);
  });

  it('respects custom roundDuration config', async () => {
    const { state } = await start({ roundDuration: 30 });
    expect(state.roundDuration).toBe(30);
  });

  it('guessDuration defaults to roundDuration', async () => {
    const { state } = await start({ roundDuration: 45 });
    expect(state.guessDuration).toBe(45);
  });

  it('respects custom guessDuration config independent of roundDuration', async () => {
    const { state } = await start({ roundDuration: 60, guessDuration: 20 });
    expect(state.roundDuration).toBe(60);
    expect(state.guessDuration).toBe(20);
  });
});

describe('fastDrawPlugin.onAction — guess', () => {
  it('rejects guess from the drawer', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const r = fastDrawPlugin.onAction({ from: drawer, action: { type: 'guess', word: state.currentWord }, state, participants: PLAYERS });
    expect(r.feedback?.to).toBe(drawer);
    expect(r.state).toBe(state);
  });

  it('rejects wrong guess with feedback', async () => {
    const { state } = await start();
    const guesser = PLAYERS.find((p) => p !== state.drawerOrder[0])!;
    const r = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: 'wrongword' }, state, participants: PLAYERS });
    expect(r.feedback?.to).toBe(guesser);
    expect((r.state as FastDrawState).phase).toBe('drawing');
  });

  it('correct guess sets phase to reveal and awards points', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const guesser = PLAYERS.find((p) => p !== drawer)!;
    const r = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: state.currentWord }, state, participants: PLAYERS });
    const newState = r.state as FastDrawState;
    expect(newState.phase).toBe('reveal');
    expect(newState.scores[guesser]).toBe(1);
    expect(newState.scores[drawer]).toBe(1);
    expect(newState.guesser).toBe(guesser);
    expect(r.broadcast).toMatchObject({ type: 'fast_draw_correct', guesser, word: state.currentWord });
  });

  it('spectatorState reveals word after correct guess', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const guesser = PLAYERS.find((p) => p !== drawer)!;
    const r = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: state.currentWord }, state, participants: PLAYERS });
    const spec = r.spectatorState as { revealedWord: string };
    expect(spec.revealedWord).toBe(state.currentWord);
  });

  it('rejects guess when phase is reveal', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const guesser = PLAYERS.find((p) => p !== drawer)!;
    const afterGuess = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: state.currentWord }, state, participants: PLAYERS });
    const r = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: state.currentWord }, state: afterGuess.state, participants: PLAYERS });
    expect(r.feedback?.to).toBe(guesser);
  });

  it('triggers game_over when winner reaches threshold', async () => {
    const { state } = await start({ winThreshold: 1 });
    const drawer = state.drawerOrder[0]!;
    const guesser = PLAYERS.find((p) => p !== drawer)!;
    const r = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: state.currentWord }, state, participants: PLAYERS });
    const newState = r.state as FastDrawState;
    expect(newState.phase).toBe('game_over');
    expect(newState.winners.length).toBeGreaterThan(0);
    expect(r.ended).toBe(true);
  });

  it('tie: both drawer and guesser hit threshold simultaneously', async () => {
    const { state } = await start({ winThreshold: 1 });
    const drawer = state.drawerOrder[0]!;
    const guesser = PLAYERS.find((p) => p !== drawer)!;
    // Manually pre-set both to threshold-1 (already 0, threshold is 1 so first correct guess wins)
    const r = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: state.currentWord }, state, participants: PLAYERS });
    const newState = r.state as FastDrawState;
    expect(newState.winners).toContain(drawer);
    expect(newState.winners).toContain(guesser);
  });

  it('accepts a correct guess during the guessing phase (after drawing time is up)', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const guesser = PLAYERS.find((p) => p !== drawer)!;
    const guessingState: FastDrawState = { ...state, phase: 'guessing', guessPhaseStartedAt: Date.now() };
    const r = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: state.currentWord }, state: guessingState, participants: PLAYERS });
    const newState = r.state as FastDrawState;
    expect(newState.phase).toBe('reveal');
    expect(newState.scores[guesser]).toBe(1);
    expect(newState.revealEndsAt).not.toBeNull();
  });

  it('rejects a guess once the guessing window itself has expired', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const guesser = PLAYERS.find((p) => p !== drawer)!;
    const expiredGuessingState: FastDrawState = {
      ...state,
      phase: 'guessing',
      guessPhaseStartedAt: Date.now() - (state.guessDuration + 1) * 1000,
    };
    const r = fastDrawPlugin.onAction({ from: guesser, action: { type: 'guess', word: state.currentWord }, state: expiredGuessingState, participants: PLAYERS });
    expect(r.feedback?.to).toBe(guesser);
    expect((r.state as FastDrawState).phase).toBe('guessing');
  });
});

describe('fastDrawPlugin.onAction — advance_round', () => {
  it('rejects advance_round while round is still active, silently (harmless auto-advance race, not a user mistake)', async () => {
    const { state } = await start();
    const r = fastDrawPlugin.onAction({ from: PLAYERS[0]!, action: { type: 'advance_round' }, state, participants: PLAYERS });
    expect(r.feedback).toBeUndefined();
    expect((r.state as FastDrawState).phase).toBe('drawing');
  });

  it('moves to guessing phase (not reveal) when drawing time has expired', async () => {
    const { state } = await start();
    const expiredState: FastDrawState = { ...state, roundStartedAt: Date.now() - (state.roundDuration + 1) * 1000 };
    const r = fastDrawPlugin.onAction({ from: PLAYERS[0]!, action: { type: 'advance_round' }, state: expiredState, participants: PLAYERS });
    const newState = r.state as FastDrawState;
    expect(newState.phase).toBe('guessing');
    expect(newState.guessPhaseStartedAt).not.toBeNull();
    expect(r.broadcast).toMatchObject({ type: 'fast_draw_drawing_ended', guessDuration: state.guessDuration });
    expect((r.broadcast as { word?: string }).word).toBeUndefined();
    const spec = r.spectatorState as { revealedWord: string | null };
    expect(spec.revealedWord).toBeNull();
  });

  it('rejects advance_round while the guessing window is still active, silently (same harmless race)', async () => {
    const { state } = await start();
    const guessingState: FastDrawState = { ...state, phase: 'guessing', guessPhaseStartedAt: Date.now() };
    const r = fastDrawPlugin.onAction({ from: PLAYERS[0]!, action: { type: 'advance_round' }, state: guessingState, participants: PLAYERS });
    expect(r.feedback).toBeUndefined();
    expect((r.state as FastDrawState).phase).toBe('guessing');
  });

  it('moves to reveal when the guessing window has also expired', async () => {
    const { state } = await start();
    const expiredGuessingState: FastDrawState = {
      ...state,
      phase: 'guessing',
      guessPhaseStartedAt: Date.now() - (state.guessDuration + 1) * 1000,
    };
    const r = fastDrawPlugin.onAction({ from: PLAYERS[0]!, action: { type: 'advance_round' }, state: expiredGuessingState, participants: PLAYERS });
    const newState = r.state as FastDrawState;
    expect(newState.phase).toBe('reveal');
    expect(newState.revealEndsAt).not.toBeNull();
    expect(r.broadcast).toMatchObject({ type: 'fast_draw_time_expired', word: expiredGuessingState.currentWord });
  });

  it('advances to next round from reveal when reveal has ended', async () => {
    const { state } = await start();
    const revealState: FastDrawState = { ...state, phase: 'reveal', revealEndsAt: Date.now() - 100, guesser: null };
    const r = fastDrawPlugin.onAction({ from: PLAYERS[0]!, action: { type: 'advance_round' }, state: revealState, participants: PLAYERS });
    const newState = r.state as FastDrawState;
    expect(newState.phase).toBe('drawing');
    expect(newState.roundNumber).toBe(2);
    expect(newState.currentDrawerIndex).toBe(1);
    expect(r.broadcast).toMatchObject({ type: 'fast_draw_round_start', roundNumber: 2 });
    // New payloads sent to all players
    expect(r.payloads).toBeDefined();
    expect(Object.keys(r.payloads!)).toEqual(expect.arrayContaining(PLAYERS));
  });

  it('advances round immediately when host sends advance_round during reveal (no time guard)', async () => {
    const { state } = await start();
    // revealEndsAt still in the future — host-controlled pacing ignores it
    const revealState: FastDrawState = { ...state, phase: 'reveal', revealEndsAt: Date.now() + 10000, guesser: null };
    const r = fastDrawPlugin.onAction({ from: PLAYERS[0]!, action: { type: 'advance_round' }, state: revealState, participants: PLAYERS });
    const newState = r.state as FastDrawState;
    expect(newState.phase).toBe('drawing');
    expect(r.broadcast).toBeDefined();
    const bc = r.broadcast as { type: string };
    expect(bc.type).toBe('fast_draw_round_start');
  });

  it('clears strokeSnapshot on next round', async () => {
    const { state } = await start();
    const stroke: Stroke = { id: 's1', points: [[0.1, 0.2]], color: '#000', width: 4 };
    const revealState: FastDrawState = { ...state, phase: 'reveal', revealEndsAt: Date.now() - 100, strokeSnapshot: [stroke] };
    const r = fastDrawPlugin.onAction({ from: PLAYERS[0]!, action: { type: 'advance_round' }, state: revealState, participants: PLAYERS });
    expect((r.state as FastDrawState).strokeSnapshot).toHaveLength(0);
  });
});

describe('fastDrawPlugin.onAction — canvas_sync', () => {
  it('stores stroke snapshot when sent by drawer', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const strokes: Stroke[] = [{ id: 's1', points: [[0.1, 0.2], [0.3, 0.4]], color: '#000', width: 4 }];
    const r = fastDrawPlugin.onAction({ from: drawer, action: { type: 'canvas_sync', strokes }, state, participants: PLAYERS });
    expect((r.state as FastDrawState).strokeSnapshot).toEqual(strokes);
    expect(r.broadcast).toBeUndefined();
  });

  it('rejects canvas_sync from non-drawer', async () => {
    const { state } = await start();
    const nonDrawer = PLAYERS.find((p) => p !== state.drawerOrder[0])!;
    const r = fastDrawPlugin.onAction({ from: nonDrawer, action: { type: 'canvas_sync', strokes: [] }, state, participants: PLAYERS });
    expect(r.feedback?.to).toBe(nonDrawer);
  });

  it('rejects canvas_sync once drawing time is up, even from the drawer', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const guessingState: FastDrawState = { ...state, phase: 'guessing', guessPhaseStartedAt: Date.now() };
    const r = fastDrawPlugin.onAction({ from: drawer, action: { type: 'canvas_sync', strokes: [] }, state: guessingState, participants: PLAYERS });
    expect(r.feedback?.to).toBe(drawer);
  });

  it('updates spectatorState with new strokeSnapshot', async () => {
    const { state } = await start();
    const drawer = state.drawerOrder[0]!;
    const strokes: Stroke[] = [{ id: 's1', points: [[0.5, 0.5]], color: '#f00', width: 6 }];
    const r = fastDrawPlugin.onAction({ from: drawer, action: { type: 'canvas_sync', strokes }, state, participants: PLAYERS });
    const spec = r.spectatorState as { strokeSnapshot: Stroke[] };
    expect(spec.strokeSnapshot).toEqual(strokes);
  });
});
