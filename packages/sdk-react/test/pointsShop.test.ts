import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomContext } from '@livekit/components-react';
import { Room } from 'livekit-client';
import { readBountyPacket, readChatPacket, readPollSuggestionPacket, readReadAloudPacket, readRewardsPacket } from '../src/lib/dataTrust.js';
import { parseBacklog } from '../src/lib/chatBacklog.js';
import {
  activePinnedChat, buyShopItem, chatLook, isHiveAccount, ownsStickers, parseCosmetics, parseShopCatalog, planReadAloud, shopApi, shopQuote,
  stickerIdOf, upsertById, COSMETIC_LOOKS, NAME_COLORS,
} from '../src/lib/pointsShop.js';
import { capLabel, resolveStreamCap, FREE_STREAM_CAP_MS, PRO_STREAM_CAP_MS } from '../src/lib/streamLimits.js';
import { alertSettings } from '../src/lib/boostGoals.js';
import { DEFAULT_SHOP_LABELS, shopLabels } from '../src/lib/shopLabels.js';
import { DEFAULT_LIVE_LABELS } from '../src/lib/liveLabels.js';
import { ChatBubble, ChatSystemLine, PinnedChatBar } from '../src/components/room/ChatPanel.js';
import { BountiesView, PollSuggestionsView, RewardQueueView, RewardsEditor, rewardsProblem } from '../src/components/room/ShopHostPanels.js';
import { PointsShopMenu, availableShopActions, PointsShopDialog } from '../src/components/room/PointsShop.js';
import { __resetShopCaches, primeCosmetics, primeShopCatalog, primeSupporters } from '../src/hooks/useShopData.js';
import { HangoutsContext, type HangoutsContextValue } from '../src/context/HangoutsContext.js';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const SERVER = undefined;
const fan = { identity: 'fan', name: 'fan' };
const NOW = 1_700_000_000_000;
const API = 'https://live.test';

const ctx = (over: Partial<HangoutsContextValue> = {}) => ({
  apiBaseUrl: API, apiClient: { getSessionToken: () => 'tok' }, isAuthenticated: true, username: 'fan', pro: {}, ...over,
}) as unknown as HangoutsContextValue;

function render(el: ReactElement, c: HangoutsContextValue = ctx(), meta?: Record<string, unknown>): string {
  const room = new Room();
  if (meta) Object.defineProperty(room, 'metadata', { get: () => JSON.stringify(meta) });
  return renderToStaticMarkup(h(HangoutsContext.Provider, { value: c }, h(RoomContext.Provider, { value: room }, el)));
}

beforeEach(() => { __resetShopCaches(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('chat system lines from the points shop', () => {
  const sys = (system: Record<string, unknown>) => ({ type: 'system', id: 'x1', identity: 'badadib', name: 'badadib', text: 'Sing a song', timestamp: NOW, system });

  it('reads highlight, reward, bounty and bountydone from the server', () => {
    expect(readChatPacket(enc(sys({ kind: 'highlight', from: 'badadib', until: NOW + 60_000 })), SERVER, NOW))
      .toMatchObject({ kind: 'line', line: { id: 'x1', text: 'Sing a song', system: { kind: 'highlight', from: 'badadib', until: NOW + 60_000 } } });
    expect(readChatPacket(enc(sys({ kind: 'reward', from: 'badadib', title: 'Pick the game' })), SERVER, NOW))
      .toMatchObject({ line: { system: { kind: 'reward', from: 'badadib', title: 'Pick the game' } } });
    expect(readChatPacket(enc(sys({ kind: 'bounty', from: 'badadib', title: 'Sing', points: 500 })), SERVER, NOW))
      .toMatchObject({ line: { system: { kind: 'bounty', title: 'Sing', points: 500 } } });
    expect(readChatPacket(enc(sys({ kind: 'bountydone', from: 'badadib', title: 'Sing', points: 900 })), SERVER, NOW))
      .toMatchObject({ line: { system: { kind: 'bountydone', points: 900 } } });
  });

  it('drops them from a participant, and unknown or broken kinds', () => {
    expect(readChatPacket(enc(sys({ kind: 'highlight', from: 'fan' })), fan, NOW)).toBeNull();
    expect(readChatPacket(enc(sys({ kind: 'bounty', from: 'fan', title: 'x', points: 5 })), fan, NOW)).toBeNull();
    expect(readChatPacket(enc(sys({ kind: 'jackpot', from: 'fan' })), SERVER, NOW)).toBeNull();
    expect(readChatPacket(enc(sys({ kind: 'reward' })), SERVER, NOW)).toBeNull();
    // A negative or missing amount is 0, never shown as a debt.
    expect(readChatPacket(enc(sys({ kind: 'bounty', from: 'a', title: 't', points: -4 })), SERVER, NOW))
      .toMatchObject({ line: { system: { points: 0 } } });
  });

  it('checks the system block of backlog lines too', () => {
    const out = parseBacklog({ messages: [
      { id: 'a', identity: 'badadib', name: 'badadib', text: 't', timestamp: 1, system: { kind: 'reward', from: 'badadib', title: 'Hi' } },
      { id: 'b', identity: 'fan', name: 'fan', text: 'plain', timestamp: 2, system: { kind: 'nonsense' } },
    ] });
    expect(out[0].system).toEqual({ kind: 'reward', from: 'badadib', title: 'Hi' });
    expect(out[1].system).toBeUndefined();
  });

  it('renders each shop line from the labels', () => {
    const line = (system: unknown) => ({ id: 's', identity: 'badadib', name: 'badadib', text: '', timestamp: 1, system }) as never;
    expect(renderToStaticMarkup(h(ChatSystemLine, { msg: line({ kind: 'reward', from: 'badadib', title: 'Pick the game' }) })))
      .toContain('@badadib redeemed Pick the game');
    expect(renderToStaticMarkup(h(ChatSystemLine, { msg: line({ kind: 'bounty', from: 'badadib', title: 'Sing', points: 2500 }) })))
      .toContain('@badadib put up a bounty: Sing (2,500 points)');
    const done = renderToStaticMarkup(h(ChatSystemLine, { msg: line({ kind: 'bountydone', from: 'badadib', title: 'Sing', points: 2500 }) }));
    expect(done).toContain('@badadib completed: Sing (2,500 points)');
    expect(done).toContain('hh-chat__msg--bountydone');
    expect(renderToStaticMarkup(h(ChatSystemLine, {
      msg: line({ kind: 'reward', from: 'badadib', title: 'X' }), liveLabels: { rewardLine: '@{name} hat {title} eingelöst' },
    }))).toContain('@badadib hat X eingelöst');
  });
});

describe('the pinned highlight', () => {
  const meta = { host: 'badadib', pinnedChat: { id: 'hl-1', from: 'badadib', text: 'Hello everyone', until: NOW + 60_000 } };

  it('shows until `until`, then is gone without a refetch', () => {
    expect(activePinnedChat(meta, NOW)).toEqual({ id: 'hl-1', from: 'badadib', text: 'Hello everyone', until: NOW + 60_000 });
    expect(activePinnedChat(meta, NOW + 59_999)).not.toBeNull();
    expect(activePinnedChat(meta, NOW + 60_000)).toBeNull();
    expect(activePinnedChat({ pinnedChat: { from: 'x', text: '', until: NOW + 1 } }, NOW)).toBeNull();
    expect(activePinnedChat({}, NOW)).toBeNull();
  });

  it('draws the bar with the skinnable name and text classes', () => {
    const html = renderToStaticMarkup(h(PinnedChatBar, { pin: activePinnedChat(meta, NOW) }));
    expect(html).toContain('Pinned');
    expect(html).toContain('hh-chat__msg-name hh-chat__pinned-name');
    expect(html).toContain('Hello everyone');
    expect(renderToStaticMarkup(h(PinnedChatBar, { pin: null }))).toBe('');
  });
});

describe('stickers and cosmetics in chat', () => {
  const bubble = (over: Record<string, unknown> = {}) => render(h(ChatBubble, {
    id: 'm1', identity: 'fan', name: 'fan', text: ':st-fire:', localName: 'badadib', host: 'badadib', ...over,
  }));

  it('a :st-<id>: line is a big sticker only when the sender owns the host\'s set', () => {
    primeCosmetics(API, 'fan', parseCosmetics({ owned: [], equipped: {}, stickers: ['badadib'] }));
    const owner = bubble();
    expect(owner).toContain('hh-chat__sticker');
    expect(owner).toContain('🔥');
    expect(owner).not.toContain(':st-fire:');
    // Someone else's set, or none: plain text.
    primeCosmetics(API, 'fan', parseCosmetics({ stickers: ['someone'] }));
    expect(bubble()).toContain(':st-fire:');
    expect(bubble()).not.toContain('hh-chat__sticker"');
    primeCosmetics(API, 'fan', parseCosmetics({ stickers: ['badadib'] }));
    expect(bubble({ text: ':st-fire: and more' })).toContain(':st-fire: and more');
    expect(bubble({ text: ':st-unknown:' })).toContain(':st-unknown:');
  });

  it('pure helpers: the sticker id, ownership', () => {
    expect(stickerIdOf(':st-rocket:')).toBe('rocket');
    expect(stickerIdOf(' :st-rocket: ')).toBe('rocket');
    expect(stickerIdOf(':st-rocket:!')).toBeNull();
    expect(stickerIdOf(':st-nope:')).toBeNull();
    expect(ownsStickers(parseCosmetics({ stickers: ['BadAdib'] }), 'badadib')).toBe(true);
    expect(ownsStickers(null, 'badadib')).toBe(false);
    expect(isHiveAccount('badadib')).toBe(true);
    expect(isHiveAccount('guest-x1')).toBe(false);
    expect(isHiveAccount('obs-badadib')).toBe(false);
  });

  it('shows the name colour, the badge, the frame and the supporter mark', () => {
    primeCosmetics(API, 'fan', parseCosmetics({ owned: [], equipped: { color: 'color-gold', badge: 'badge-crown', frame: 'frame-rainbow' }, stickers: [] }));
    primeSupporters(API, 'badadib', ['Fan']);
    const html = bubble({ text: 'hi', supporters: ['fan'] });
    expect(html).toContain('hh-chat__name-tint');
    expect(html).toContain('--hh-tint:#f5b400');
    expect(html).toContain('👑');
    expect(html).toContain('hh-frame--rainbow');
    expect(html).toContain('Channel supporter');
    // Nothing equipped, not a supporter: the plain name.
    primeCosmetics(API, 'fan', parseCosmetics({}));
    const plain = bubble({ text: 'hi', supporters: [] });
    expect(plain).not.toContain('hh-chat__name-tint');
    expect(plain).not.toContain('Channel supporter');
  });

  it('a highlighted message stands out', () => {
    const html = bubble({ text: 'Look at me', highlight: true });
    expect(html).toContain('hh-chat__msg--highlight');
    expect(html).toContain(DEFAULT_LIVE_LABELS.highlightTag);
  });

  it('every cosmetic id has a look, and unknown equipped ids are ignored', () => {
    for (const id of ['color-gold', 'color-cyan', 'color-pink', 'color-green', 'color-violet', 'badge-flame', 'badge-star', 'badge-diamond', 'badge-crown',
      'frame-gold', 'frame-neon', 'frame-rainbow', 'theme-midnight', 'theme-sunset', 'theme-forest']) {
      expect(COSMETIC_LOOKS[id], id).toBeDefined();
    }
    expect(NAME_COLORS['color-violet']).toBe('#9b7bff');
    expect(parseCosmetics({ equipped: { color: 'color-nope', badge: 'color-gold' } }).equipped).toEqual({});
    expect(chatLook(parseCosmetics({ equipped: { badge: 'badge-star' } }))).toEqual({ badge: '⭐' });
  });
});

describe('read-aloud messages', () => {
  const ev = { type: 'readaloud', id: 'ra-1', room: 'r', sender: 'badadib', message: ' Hello stream ', timestamp: NOW };

  it('count only from the server', () => {
    expect(readReadAloudPacket(enc(ev), SERVER, NOW)).toEqual({ type: 'readaloud', id: 'ra-1', sender: 'badadib', message: 'Hello stream', timestamp: NOW });
    expect(readReadAloudPacket(enc(ev), fan, NOW)).toBeNull();
    expect(readReadAloudPacket(enc({ ...ev, message: '  ' }), SERVER, NOW)).toBeNull();
    expect(readReadAloudPacket(enc({ ...ev, type: 'boost' }), SERVER, NOW)).toBeNull();
  });

  it('are spoken with tts on and readAloud not false, whatever the boost minimum', () => {
    expect(planReadAloud({ timestamp: NOW }, { tts: true }, NOW)).toBe(true);
    expect(planReadAloud({ timestamp: NOW }, { tts: true, readAloud: true }, NOW)).toBe(true);
    expect(planReadAloud({ timestamp: NOW }, { tts: true, readAloud: false }, NOW)).toBe(false);
    expect(planReadAloud({ timestamp: NOW }, { tts: false }, NOW)).toBe(false);
    // A replay a minute later is not news.
    expect(planReadAloud({ timestamp: NOW }, { tts: true }, NOW + 60_000)).toBe(false);
    // ttsMinHbd plays no part: the alert settings carry it, planReadAloud ignores it.
    const a = alertSettings({ alerts: { tts: true, ttsMinHbd: 50 } });
    expect(planReadAloud({ timestamp: NOW }, a, NOW)).toBe(true);
    expect(alertSettings({ alerts: { readAloud: false } }).readAloud).toBe(false);
    expect('readAloud' in alertSettings(undefined)).toBe(false);
  });
});

describe('other server packets', () => {
  it('suggested polls, rewards and bounties only from the server', () => {
    const suggestion = { id: 'o1', from: 'badadib', question: 'Next game?', options: ['Chess', 'Go'], at: NOW };
    expect(readPollSuggestionPacket(enc({ type: 'poll-suggestion', suggestion }), SERVER)).toEqual({ type: 'poll-suggestion', suggestion });
    expect(readPollSuggestionPacket(enc({ type: 'poll-suggestion', suggestion }), fan)).toBeNull();
    expect(readPollSuggestionPacket(enc({ type: 'poll-suggestion-done', id: 'o1', status: 'refunded' }), SERVER)).toEqual({ type: 'poll-suggestion-done', id: 'o1', status: 'refunded' });
    expect(readPollSuggestionPacket(enc({ type: 'poll', poll: {} }), SERVER)).toBeNull();
    const redemption = { id: 'o2', from: 'badadib', rewardId: 'r1', title: 'Hydrate', cost: 500, at: NOW };
    expect(readRewardsPacket(enc({ type: 'reward-redeemed', redemption }), SERVER)).toEqual({ type: 'reward-redeemed', redemption });
    expect(readRewardsPacket(enc({ type: 'reward-redeemed', redemption }), fan)).toBeNull();
    const bounty = { id: 'b1', text: 'Sing', createdBy: 'badadib', status: 'open', total: 300, backers: 2 };
    expect(readBountyPacket(enc({ type: 'bounty', bounty }), SERVER)).toMatchObject({ bounty: { id: 'b1', total: 300 } });
    expect(readBountyPacket(enc({ type: 'bounty', bounty }), fan)).toBeNull();
    expect(upsertById([{ id: 'a', n: 1 }], { id: 'a', n: 2 })).toEqual([{ id: 'a', n: 2 }]);
  });
});

describe('resolveStreamCap with bought time', () => {
  it('adds the extra to the free cap, never to Pro', () => {
    expect(resolveStreamCap(false)).toMatchObject({ capMs: FREE_STREAM_CAP_MS, label: '30 minutes', extraMs: 0, isPro: false });
    expect(resolveStreamCap(false, 30 * 60_000)).toMatchObject({ capMs: FREE_STREAM_CAP_MS + 30 * 60_000, label: '1 hour', extraMs: 30 * 60_000 });
    expect(resolveStreamCap(false, 60 * 60_000).label).toBe('1 hour 30 minutes');
    expect(resolveStreamCap(true, 30 * 60_000)).toMatchObject({ capMs: PRO_STREAM_CAP_MS, extraMs: 0, isPro: true });
    expect(resolveStreamCap(false, -5).capMs).toBe(FREE_STREAM_CAP_MS);
    expect(resolveStreamCap(false, Number.NaN).capMs).toBe(FREE_STREAM_CAP_MS);
    expect(capLabel(2 * 60 * 60_000)).toBe('2 hours');
  });
});

/** A fetch that records calls and answers in turn. */
function mockFetch(...answers: Array<[number, unknown]>) {
  const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return new Response(JSON.stringify(next[1]), { status: next[0], headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

describe('host panels: routes', () => {
  it('suggested polls: list, accept with a timer, reject', async () => {
    const { calls } = mockFetch(
      [200, { suggestions: [{ id: 'o1', from: 'badadib', question: 'Q?', options: ['A', 'B'], at: 1 }, { id: 'bad' }] }],
      [201, { poll: { id: 'p1' } }],
      [200, { ok: true }],
    );
    expect(await shopApi.suggestions(API, 'badadib-live')).toHaveLength(1);
    await shopApi.acceptSuggestion(API, 'badadib-live', 'o1', 'tok', 120);
    await shopApi.rejectSuggestion(API, 'badadib-live', 'o2', 'tok');
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'GET /rooms/badadib-live/poll-suggestions',
      'POST /rooms/badadib-live/poll-suggestions/o1/accept',
      'POST /rooms/badadib-live/poll-suggestions/o2/reject',
    ]);
    expect(calls[1].body).toEqual({ durationSec: 120 });
    expect(calls[1].auth).toBe('Bearer tok');
  });

  it('rewards: the channel list, saving, the queue, done and refund', async () => {
    const { calls } = mockFetch(
      [200, { rewards: [{ id: 'r1', title: 'Hydrate', cost: 500, prompt: false, enabled: true }] }],
      [200, { rewards: [{ id: 'r1', title: 'Hydrate', cost: 600, prompt: true, enabled: true }] }],
      [200, { queue: [{ id: 'o1', from: 'badadib', rewardId: 'r1', title: 'Hydrate', cost: 600, input: 'water', at: 1 }] }],
      [200, { ok: true }],
      [200, { ok: true }],
    );
    expect((await shopApi.rewards(API, 'badadib'))[0].title).toBe('Hydrate');
    expect((await shopApi.saveRewards(API, [{ id: 'r1', title: 'Hydrate', cost: 600, prompt: true, enabled: true }], 'tok'))[0].cost).toBe(600);
    expect((await shopApi.rewardQueue(API, 'badadib-live', 'tok'))[0].input).toBe('water');
    await shopApi.rewardAction(API, 'badadib-live', 'o1', 'done', 'tok');
    await shopApi.rewardAction(API, 'badadib-live', 'o1', 'refund', 'tok');
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'GET /channels/badadib/rewards',
      'PUT /channels/rewards',
      'GET /rooms/badadib-live/rewards/queue',
      'POST /rooms/badadib-live/rewards/o1/done',
      'POST /rooms/badadib-live/rewards/o1/refund',
    ]);
    expect(calls[1].body).toEqual({ rewards: [{ id: 'r1', title: 'Hydrate', cost: 600, prompt: true, enabled: true }] });
  });

  it('bounties: open ones, done and decline; a refusal carries the server message', async () => {
    const { calls } = mockFetch(
      [200, { bounties: [{ id: 'b1', text: 'Sing', createdBy: 'badadib', status: 'open', total: 300, backers: 2 }] }],
      [200, { bounty: { id: 'b1', text: 'Sing', status: 'done', total: 300, backers: 2 } }],
      [404, { message: 'That bounty is closed.' }],
    );
    expect((await shopApi.bounties(API, 'badadib-live'))[0].total).toBe(300);
    expect((await shopApi.bountyAction(API, 'badadib-live', 'b1', 'done', 'tok'))?.status).toBe('done');
    await expect(shopApi.bountyAction(API, 'badadib-live', 'b1', 'decline', 'tok')).rejects.toThrow('That bounty is closed.');
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'GET /rooms/badadib-live/bounties',
      'POST /rooms/badadib-live/bounties/b1/done',
      'POST /rooms/badadib-live/bounties/b1/decline',
    ]);
  });

  it('stream extra time and cosmetics', async () => {
    const { calls } = mockFetch([200, { extraMs: 1_800_000 }], [200, { owned: ['color-gold'], equipped: { color: 'color-gold' }, stickers: [] }]);
    expect(await shopApi.streamExtra(API, 'tok')).toBe(1_800_000);
    expect((await shopApi.cosmetics(API, 'badadib')).equipped.color).toBe('color-gold');
    expect(calls[0].url).toBe(`${API}/points/stream-extra`);
    expect(calls[0].auth).toBe('Bearer tok');
    expect(calls[1].url).toBe(`${API}/users/badadib/cosmetics`);
  });
});

describe('host panels: views', () => {
  it('suggestions: Run and Decline per row, the timer chips, the empty state', () => {
    const html = renderToStaticMarkup(h(PollSuggestionsView, {
      suggestions: [{ id: 'o1', from: 'badadib', question: 'Next game?', options: ['Chess', 'Go'], at: 1 }],
      onRun: () => {}, onDecline: () => {},
    }));
    expect(html).toContain('Next game?');
    expect(html).toContain('Chess · Go');
    expect(html).toContain('from @badadib');
    expect(html).toContain('>Run<');
    expect(html).toContain('>Decline<');
    expect(html).toContain('1 min');
    expect(renderToStaticMarkup(h(PollSuggestionsView, { suggestions: [], onRun: () => {}, onDecline: () => {} }))).toContain(DEFAULT_SHOP_LABELS.suggestionsEmpty);
  });

  it('the reward queue and the bounties have their buttons', () => {
    const q = renderToStaticMarkup(h(RewardQueueView, {
      queue: [{ id: 'o1', from: 'badadib', rewardId: 'r1', title: 'Hydrate', cost: 1500, input: 'water', at: 1 }], onDone: () => {}, onRefund: () => {},
    }));
    expect(q).toContain('@badadib: Hydrate');
    expect(q).toContain('water');
    expect(q).toContain('1,500 points');
    expect(q).toContain('>Done<');
    expect(q).toContain('>Refund<');
    const b = renderToStaticMarkup(h(BountiesView, {
      bounties: [{ id: 'b1', text: 'Sing a song', createdBy: 'badadib', status: 'open', total: 2500, backers: 3 }], onDone: () => {}, onDecline: () => {},
    }));
    expect(b).toContain('Sing a song');
    expect(b).toContain('2,500 points from 3 backers');
    expect(b).toContain('started by @badadib');
    expect(b).toContain('>Decline<');
  });

  it('the rewards editor checks names, costs and the count', () => {
    expect(rewardsProblem([{ title: 'Hydrate', cost: 500, prompt: false, enabled: true }])).toBeNull();
    expect(rewardsProblem([{ title: ' ', cost: 500, prompt: false, enabled: true }])).toBe(DEFAULT_SHOP_LABELS.errRewardName);
    expect(rewardsProblem([{ title: 'x', cost: 50, prompt: false, enabled: true }])).toBe('A reward costs 100 to 1,000,000 points.');
    expect(rewardsProblem(Array.from({ length: 13 }, () => ({ title: 'x', cost: 500, prompt: false, enabled: true })))).toBe('At most 12 rewards.');
    const html = renderToStaticMarkup(h(RewardsEditor, { rewards: [], onSave: async () => null }));
    expect(html).toContain('+ Add a reward');
    expect(html).toContain('Save rewards');
  });
});

describe('viewer actions', () => {
  const catalog = parseShopCatalog({
    items: {
      highlight: { enabled: true, price: 500 }, readaloud: { enabled: true, price: 1000 }, suggestpoll: { enabled: true, price: 2000 },
      reward: { enabled: true, min: 100, max: 1_000_000 }, bounty: { enabled: true, min: 100 }, stickers: { enabled: false, price: 1000 },
      minutes: { enabled: true, price: 10_000, minutes: 30 },
    },
    stickers: { fire: '🔥', clap: '👏' },
    cosmetics: { 'color-gold': { kind: 'color', price: 2000 } },
    supporterMin: 10_000,
  });

  it('the catalog: prices and what is on', () => {
    expect(shopQuote(catalog, 'highlight')).toMatchObject({ enabled: true, price: 500 });
    expect(shopQuote(catalog, 'stickers').enabled).toBe(false);
    expect(shopQuote(catalog, 'nothing').enabled).toBe(false);
    // While it loads: the server's starting prices.
    expect(shopQuote(null, 'readaloud')).toEqual({ enabled: true, price: 1000 });
    expect(availableShopActions(catalog)).toEqual(['highlight', 'readaloud', 'suggestpoll', 'reward', 'bounty']);
    expect(availableShopActions(catalog, true)).not.toContain('readaloud');
  });

  it('the menu lists the items with their prices and the balance', () => {
    const html = renderToStaticMarkup(h(PointsShopMenu, { actions: availableShopActions(catalog), catalog, balance: 12_500, onPick: () => {} }));
    expect(html).toContain('You have 12,500 points');
    expect(html).toContain('Highlight a message');
    expect(html).toContain('500 points');
    expect(html).toContain('2,000 points');
    expect(html).not.toContain('Unlock stickers');
  });

  it('a dialog shows the price on its buy button and takes translated labels', () => {
    primeShopCatalog(API, catalog);
    const html = render(h(PointsShopDialog, { roomName: 'badadib-live', host: 'badadib', action: 'readaloud', onClose: () => {}, labels: { buy: 'Kaufen für {points}' } }));
    expect(html).toContain('Read-aloud message');
    expect(html).toContain('Kaufen für 1,000');
    const out = render(h(PointsShopDialog, { roomName: 'badadib-live', host: 'badadib', action: 'highlight', onClose: () => {} }), ctx({ isAuthenticated: false, username: null }));
    expect(out).toContain(DEFAULT_SHOP_LABELS.errSignIn);
  });

  it('labels: a partial translation keeps English for the rest', () => {
    const L = shopLabels({ usePoints: 'Punkte nutzen', buy: '' });
    expect(L.usePoints).toBe('Punkte nutzen');
    expect(L.buy).toBe(DEFAULT_SHOP_LABELS.buy);
    expect(shopLabels()).toBe(DEFAULT_SHOP_LABELS);
  });
});

describe('buying (POST /points/shop/buy)', () => {
  const opts = { apiBaseUrl: API, token: () => 'tok', item: 'highlight', fields: { room: 'badadib-live', text: 'Hello' }, pollMs: 1 };

  it('201: the order and the balance', async () => {
    const { calls } = mockFetch([201, { order: { id: 'o1', item: 'highlight', price: 500, status: 'done' }, balance: 9500 }]);
    expect(await buyShopItem(opts)).toEqual({ ok: true, order: { id: 'o1', item: 'highlight', price: 500, status: 'done' }, balance: 9500 });
    expect(calls[0]).toMatchObject({ url: `${API}/points/shop/buy`, method: 'POST', auth: 'Bearer tok', body: { item: 'highlight', room: 'badadib-live', text: 'Hello' } });
  });

  it('202: follows the spend until it is done', async () => {
    const onPending = vi.fn();
    const { calls } = mockFetch(
      [202, { pending: true, spendId: 'sp-1', orderId: 'o1' }],
      [200, { status: 'sent' }],
      [200, { status: 'ok', order: { id: 'o1', item: 'highlight', price: 500, status: 'done' }, balance: 42 }],
    );
    expect(await buyShopItem({ ...opts, onPending })).toMatchObject({ ok: true, order: { id: 'o1' }, balance: 42 });
    expect(onPending).toHaveBeenCalledOnce();
    expect(calls[1].url).toBe(`${API}/points/spends/sp-1`);
  });

  it('409: the server message (points back), and 428 signs with the wallet', async () => {
    mockFetch([409, { message: 'The host switched read-aloud messages off.', code: 'off' }]);
    expect(await buyShopItem({ ...opts, item: 'readaloud' })).toEqual({ ok: false, code: 'off', message: 'The host switched read-aloud messages off.' });
    const op = ['custom_json', { id: 'vsc.call', required_posting_auths: ['badadib'], json: '{}' }];
    const { calls } = mockFetch([428, { code: 'sign', op }], [201, { order: { id: 'o2', item: 'highlight', price: 500, status: 'done' }, balance: 1 }]);
    const sign = vi.fn(async () => 'cd'.repeat(20));
    expect(await buyShopItem({ ...opts, sign })).toMatchObject({ ok: true, balance: 1 });
    expect(calls[1].body).toMatchObject({ item: 'highlight', burnTx: 'cd'.repeat(20) });
  });
});
