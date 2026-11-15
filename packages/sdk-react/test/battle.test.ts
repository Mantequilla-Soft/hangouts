import { describe, expect, it, vi } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomContext } from '@livekit/components-react';
import { Room } from 'livekit-client';
import {
  battleLabels, battleOnAir, battlePhase, battleRemainingMs, battleResultText, battleShare, battleSide,
  fillBattle, formatBattleClock, otherSide, readBattle, RESULT_SHOW_MS, DEFAULT_BATTLE_LABELS, type Battle,
} from '../src/lib/battle.js';
import { battleTiles, coverCrop, drawBattleLayer, opponentSourceRect } from '../src/lib/battleLayout.js';
import { StreamBattleBar } from '../src/components/room/StreamBattleBar.js';
import { BattleInviteCard } from '../src/components/room/BattlePanel.js';
import type { StudioBattle } from '../src/hooks/useBattle.js';

const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function battle(over: Partial<Battle> = {}): Battle {
  return {
    id: 'b1', state: 'live', durationSec: 300,
    a: { host: 'badadib', room: 'badadib-aaa', hbd: 3, count: 2 },
    b: { host: 'fan', room: 'fan-bbb', hbd: 1, count: 1 },
    invitedAt: iso(T0 - 20_000), expiresAt: iso(T0 + 40_000),
    startedAt: iso(T0), endsAt: iso(T0 + 300_000), settleAt: iso(T0 + 310_000),
    ...over,
  };
}

describe('battle lib', () => {
  it('reads the battle from metadata JSON or an object', () => {
    expect(readBattle(undefined)).toBeNull();
    expect(readBattle('not json')).toBeNull();
    expect(readBattle({ battle: { id: 'x', state: 'nope' } })).toBeNull();
    expect(readBattle({ battle: { id: 'x', state: 'live', a: { host: 'a', room: 'r' }, b: { host: '' } } })).toBeNull();
    const b = readBattle(JSON.stringify({ battle: { ...battle(), durationSec: 'x', a: { host: 'badadib', room: 'r', hbd: -1 } } }));
    expect(b?.durationSec).toBe(300);
    expect(b?.a).toEqual({ host: 'badadib', room: 'r', hbd: 0, count: 0 });
  });

  it('derives the phase from the timestamps', () => {
    const inv = battle({ state: 'invited' });
    expect(battlePhase(null, T0)).toBeNull();
    expect(battlePhase(inv, T0)).toBe('invited');
    expect(battlePhase(inv, T0 + 40_000)).toBeNull();
    expect(battlePhase(battle(), T0 - 1)).toBe('starting');
    expect(battlePhase(battle(), T0 + 1)).toBe('live');
    expect(battlePhase(battle(), T0 + 300_000)).toBe('settling');
    const done = battle({ state: 'ended', endedAt: iso(T0 + 311_000), endReason: 'time', winner: 'a' });
    expect(battlePhase(done, T0 + 312_000)).toBe('result');
    expect(battlePhase(done, T0 + 311_000 + RESULT_SHOW_MS)).toBeNull();
    const declined = battle({ state: 'ended', endedAt: iso(T0), endReason: 'declined', winner: null });
    expect(battlePhase(declined, T0 + 1)).toBeNull();
    expect(battlePhase(declined, T0 + 1, true)).toBe('result');
    expect(battleOnAir('live')).toBe(true);
    expect(battleOnAir('starting')).toBe(true);
    expect(battleOnAir('settling')).toBe(true);
    expect(battleOnAir('result')).toBe(false);
    expect(battleOnAir(null)).toBe(false);
  });

  it('sides, shares, clocks and text', () => {
    const b = battle();
    expect(battleSide(b, 'fan-bbb')).toBe('b');
    expect(battleSide(b, 'badadib-aaa')).toBe('a');
    expect(battleSide(b, 'other', 'fan')).toBe('b');
    expect(battleSide(b, undefined, 'badadib')).toBe('a');
    expect(battleSide(b, 'x', 'y')).toBeNull();
    expect(otherSide('a')).toBe('b');
    expect(battleShare(b, 'a')).toBe(0.75);
    expect(battleShare(battle({ a: { ...b.a, hbd: 0 }, b: { ...b.b, hbd: 0 } }), 'b')).toBe(0.5);
    expect(battleRemainingMs(b, T0 + 60_000)).toBe(240_000);
    expect(battleRemainingMs(b, T0 - 3000)).toBe(3000);
    expect(battleRemainingMs(battle({ state: 'invited' }), T0)).toBe(40_000);
    expect(battleRemainingMs(b, T0 + 305_000)).toBe(0);
    expect(formatBattleClock(65_001)).toBe('1:06');
    expect(formatBattleClock(-5)).toBe('0:00');
    expect(fillBattle('{a} and {b} {c}', { a: 1, b: 'x' })).toBe('1 and x {c}');
    expect(battleLabels({ wins: 'Sieg für @{name}', tie: '' }).tie).toBe(DEFAULT_BATTLE_LABELS.tie);

    const L = battleLabels();
    const end = (over: Partial<Battle>) => battleResultText(battle({ state: 'ended', ...over }), L);
    expect(end({ endReason: 'time', winner: 'a' })).toBe('@badadib wins!');
    expect(end({ endReason: 'time', winner: 'b' })).toBe('@fan wins!');
    expect(end({ endReason: 'time', winner: 'tie' })).toBe("It's a tie!");
    expect(end({ endReason: 'dropped', endedBy: 'fan' })).toBe('The battle ended: @fan left');
    expect(end({ endReason: 'declined' })).toBe('@fan said no this time');
    expect(end({ endReason: 'expired' })).toBe('No answer from @fan');
    expect(end({ endReason: 'cancelled' })).toBe('The invite was withdrawn');
    expect(end({ endReason: 'ended' })).toBe('The battle ended early');
  });
});

describe('battle layout', () => {
  it('splits landscape in halves and portrait into a 9:16 band', () => {
    const l = battleTiles(1280, 720);
    expect(l.self).toEqual({ x: 0, y: 0, w: 637, h: 720 });
    expect(l.other.x + l.other.w).toBe(1280);
    expect(l.divider.x).toBe(637);
    const p = battleTiles(720, 1280);
    expect(p.self.w).toBe(357);
    expect(p.self.h).toBe(Math.round(357 * 16 / 9));
    expect(p.self.y).toBe(Math.round((1280 - p.self.h) / 2));
    // The crop source is the other studio's own self tile, at their size.
    expect(opponentSourceRect(854, 480)).toEqual(battleTiles(854, 480).self);
  });

  it('cover-crops a source into a box', () => {
    expect(coverCrop({ x: 0, y: 0, w: 400, h: 100 }, 100, 100)).toEqual({ x: 150, y: 0, w: 100, h: 100 });
    expect(coverCrop({ x: 10, y: 0, w: 100, h: 400 }, 100, 100)).toEqual({ x: 10, y: 150, w: 100, h: 100 });
    const bad = { x: 0, y: 0, w: 0, h: 10 };
    expect(coverCrop(bad, 10, 10)).toBe(bad);
  });

  function fakeCtx() {
    return {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fill: vi.fn(),
      fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), roundRect: vi.fn(),
      measureText: vi.fn(() => ({ width: 50 })),
      font: '', fillStyle: '', textAlign: '', textBaseline: '',
    };
  }

  it('draws self, the cropped opponent and the divider', () => {
    const ctx = fakeCtx();
    const drawSelf = vi.fn();
    const video = { videoWidth: 854, videoHeight: 480, readyState: 4 };
    const tiles = drawBattleLayer(ctx as unknown as CanvasRenderingContext2D, {
      W: 1280, H: 720, drawSelf, opponent: video as unknown as HTMLVideoElement, selfName: 'badadib', waitingText: 'wait',
    });
    expect(drawSelf).toHaveBeenCalledWith(tiles.self);
    const [src, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.drawImage.mock.calls[0];
    expect(src).toBe(video);
    // Inside the opponent's own (left) tile of their frame.
    expect(sx + sw).toBeLessThanOrEqual(battleTiles(854, 480).self.w + 0.001);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sh).toBeLessThanOrEqual(480);
    expect([dx, dy, dw, dh]).toEqual([tiles.other.x, tiles.other.y, tiles.other.w, tiles.other.h]);
    expect(ctx.fillText).toHaveBeenCalledWith('@badadib', expect.any(Number), expect.any(Number), expect.any(Number));
  });

  it('shows the waiting text until the other picture has frames', () => {
    const ctx = fakeCtx();
    delete (ctx as Partial<typeof ctx>).roundRect;
    drawBattleLayer(ctx as unknown as CanvasRenderingContext2D, {
      W: 720, H: 1280, drawSelf: () => {}, opponent: { videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement,
      selfName: 'badadib', waitingText: 'Connecting to @fan…', dividerColor: '#123',
    });
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledWith('Connecting to @fan…', expect.any(Number), expect.any(Number), expect.any(Number));
    expect(ctx.rect).toHaveBeenCalled();
    drawBattleLayer(ctx as unknown as CanvasRenderingContext2D, { W: 100, H: 50, drawSelf: () => {}, opponent: null, waitingText: 'w' });
  });
});

function render(el: ReactElement, meta: Record<string, unknown> | null, name = 'badadib-aaa'): string {
  const room = new Room();
  Object.defineProperty(room, 'metadata', { get: () => (meta ? JSON.stringify(meta) : undefined) });
  Object.defineProperty(room, 'name', { get: () => name });
  return renderToStaticMarkup(h(RoomContext.Provider, { value: room }, el));
}

describe('StreamBattleBar', () => {
  it('puts this room on the left with its share, the clock and the hint', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 60_000);
    try {
      const html = render(h(StreamBattleBar, {}), { battle: battle() }, 'fan-bbb');
      expect(html).toContain('hh-battle-bar--overlay');
      expect(html).toContain('hh-battle-bar--live');
      expect(html.indexOf('@fan')).toBeLessThan(html.indexOf('@badadib'));
      expect(html).toContain('width:25.0%');
      expect(html).toContain('4:00 left');
      expect(html).toContain('Boosts here count for @fan');
      expect(html).toContain('1 HBD');
    } finally { vi.useRealTimers(); }
  });

  it('takes labels, shows the lead-in, the counting and the winner', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0 - 2500);
      expect(render(h(StreamBattleBar, { labels: { startsIn: 'Start in {seconds}' } }), { battle: battle() })).toContain('Start in 3');
      vi.setSystemTime(T0 + 301_000);
      expect(render(h(StreamBattleBar, { variant: 'inline' }), { battle: battle() })).toContain('Counting the last boosts');
      vi.setSystemTime(T0 + 312_000);
      const won = render(h(StreamBattleBar, {}), { battle: battle({ state: 'ended', endedAt: iso(T0 + 311_000), endReason: 'time', winner: 'a' }) });
      expect(won).toContain('hh-battle-bar--won');
      expect(won).toContain('@badadib wins!');
      const lost = render(h(StreamBattleBar, {}), { battle: battle({ state: 'ended', endedAt: iso(T0 + 311_000), endReason: 'time', winner: 'a' }) }, 'fan-bbb');
      expect(lost).not.toContain('hh-battle-bar--won');
      // A declined invite: only the studio (all) sees it, and only the banner.
      const declined = { battle: battle({ state: 'ended', endedAt: iso(T0 + 311_000), endReason: 'declined', winner: null }) };
      expect(render(h(StreamBattleBar, {}), declined)).toBe('');
      const studio = render(h(StreamBattleBar, { all: true, host: 'badadib' }), declined, '');
      expect(studio).toContain('said no');
      expect(studio).not.toContain('hh-battle-bar__meter');
    } finally { vi.useRealTimers(); }
  });

  it('renders nothing without a battle, for an invite, or for a stranger room', () => {
    expect(render(h(StreamBattleBar, {}), null)).toBe('');
    expect(render(h(StreamBattleBar, {}), { host: 'badadib' })).toBe('');
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    try {
      expect(render(h(StreamBattleBar, {}), { battle: battle({ state: 'invited' }) })).toBe('');
      expect(render(h(StreamBattleBar, {}), { battle: battle() }, 'someone-else')).toBe('');
    } finally { vi.useRealTimers(); }
  });
});

describe('BattleInviteCard', () => {
  const studio = (over: Partial<StudioBattle>): StudioBattle => ({
    battle: battle({ state: 'invited' }), phase: 'invited', side: 'b', me: null, them: null, now: T0,
    link: { video: null, audio: null, opponentHere: false, roomGone: false, connected: false, error: null },
    onAir: false, busy: false, error: null, clearError: () => {}, invite: async () => true, respond: async () => {},
    end: async () => {}, candidates: async () => [], hear: true, setHear: () => {},
    ...over,
  });

  it('asks the invited host, with the time left to answer', () => {
    const html = renderToStaticMarkup(h(BattleInviteCard, { battle: studio({}) }));
    expect(html).toContain('@badadib');
    expect(html).toContain('5 minute battle');
    expect(html).toContain('0:40');
    expect(html).toContain('Accept');
    expect(html).toContain('Decline');
    expect(renderToStaticMarkup(h(BattleInviteCard, { battle: studio({ error: 'Nope' }) }))).toContain('Nope');
  });

  it('is not shown to the host who sent it, or outside an invite', () => {
    expect(renderToStaticMarkup(h(BattleInviteCard, { battle: studio({ side: 'a' }) }))).toBe('');
    expect(renderToStaticMarkup(h(BattleInviteCard, { battle: studio({ phase: 'live' }) }))).toBe('');
  });
});
