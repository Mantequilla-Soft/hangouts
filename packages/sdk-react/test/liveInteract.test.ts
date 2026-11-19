import { describe, expect, it } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomContext } from '@livekit/components-react';
import { Room } from 'livekit-client';
import { mergeChatLines, parseBacklog, type BacklogLine } from '../src/lib/chatBacklog.js';
import { DEFAULT_LIVE_LABELS, clockLabel, fillLabel, liveLabels } from '../src/lib/liveLabels.js';
import { RESULT_OPEN_MS, addResult, isFinished, leaders, optionShare, parsePoll, parsePollList, payoutFor, resultSummary, type PollView } from '../src/lib/polls.js';
import { parseRaid } from '../src/hooks/useRaid.js';
import { PollCardView, PollHostPanel, PollResult } from '../src/components/room/StreamPolls.js';
import { RaidBannerView } from '../src/components/room/RaidBanner.js';
import { StudioLivePanel } from '../src/components/room/StudioLivePanel.js';
import { BoostSettingsPanel } from '../src/components/room/BoostSettingsPanel.js';
import { HangoutsContext, type HangoutsContextValue } from '../src/context/HangoutsContext.js';

const line = (id: string, timestamp: number, identity = 'fan'): BacklogLine => ({ id, identity, name: identity, text: id, timestamp });

describe('mergeChatLines', () => {
  it('adds backlog lines under the live ones, deduped and in time order', () => {
    const held = [line('b', 20)];
    const out = mergeChatLines(held, [line('a', 10), line('b', 20), line('c', 30)]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps out deleted lines and banned chatters, and returns the same array when nothing is new', () => {
    const held = [line('b', 20)];
    expect(mergeChatLines(held, [line('b', 20)])).toBe(held);
    const out = mergeChatLines(held, [line('x', 5), line('y', 6, 'guest-bad')], new Set(['x']), new Set(['guest-bad']));
    expect(out).toBe(held);
  });
});

describe('parseBacklog', () => {
  it('keeps well-formed lines and fills a missing name', () => {
    const out = parseBacklog({ messages: [line('a', 1), { id: 'n', identity: 'fan', text: 'x', timestamp: 2 }, { id: 3 }, null] });
    expect(out.map((m) => m.id)).toEqual(['a', 'n']);
    expect(out[1].name).toBe('fan');
    expect(parseBacklog(null)).toEqual([]);
    expect(parseBacklog({ messages: 'nope' })).toEqual([]);
  });
});

describe('live labels', () => {
  it('fills placeholders, keeps unknown ones, and takes a partial translation', () => {
    expect(fillLabel(DEFAULT_LIVE_LABELS.raidLine, { name: 'badadib', count: 12 })).toBe('badadib is raiding with 12 viewers');
    expect(fillLabel('{a} {b}', { a: 1 })).toBe('1 {b}');
    const L = liveLabels({ pollBadge: 'Umfrage', votes: '' });
    expect(L.pollBadge).toBe('Umfrage');
    expect(L.votes).toBe(DEFAULT_LIVE_LABELS.votes);
    expect(liveLabels()).toBe(DEFAULT_LIVE_LABELS);
  });

  it('formats a clock', () => {
    expect(clockLabel(42)).toBe('0:42');
    expect(clockLabel(185)).toBe('3:05');
    expect(clockLabel(3729)).toBe('1:02:09');
    expect(clockLabel(-3)).toBe('0:00');
  });
});

const basePoll: PollView = {
  id: 'p1', room: 'r', host: 'badadib', kind: 'poll', question: 'Next game?',
  options: [{ label: 'Chess', votes: 3 }, { label: 'Draw', votes: 1 }],
  total: 4, status: 'open', createdAt: 0, endsAt: 60_000, offset: 30,
};
const basePrediction: PollView = {
  ...basePoll, id: 'p2', kind: 'prediction', question: 'Will I win?',
  options: [{ label: 'Yes', votes: 2, points: 300 }, { label: 'No', votes: 1, points: 100 }], total: 3, pot: 400,
};

describe('poll math', () => {
  it('shares, leaders and payouts', () => {
    expect(optionShare(basePoll, 0)).toBe(75);
    expect(optionShare(basePoll, 9)).toBe(0);
    expect(optionShare({ ...basePoll, total: 0 }, 0)).toBe(0);
    expect(optionShare(basePrediction, 1)).toBe(25);
    expect(leaders(basePoll)).toEqual([0]);
    expect(leaders({ ...basePoll, options: [{ label: 'a', votes: 0 }, { label: 'b', votes: 0 }] })).toEqual([]);
    expect(payoutFor(basePrediction, { option: 1, amount: 100 })).toBe(400);
    expect(payoutFor(basePrediction, { option: 0, amount: 150 })).toBe(200);
    expect(isFinished({ ...basePoll, status: 'resolved' })).toBe(true);
    expect(isFinished(basePoll)).toBe(false);
    expect(parsePoll({ ...basePoll, kind: 'other' })).toBeNull();
    expect(parsePoll(basePoll)).toBe(basePoll);
  });
});

describe('parseRaid', () => {
  it('reads the countdown from endsInMs, falls back to the target name for a title', () => {
    const r = parseRaid({ id: 'x', from: 'badadib', viewers: 5, endsInMs: 8000, target: { roomName: 'fan-live', host: 'fan' } }, 1000);
    expect(r).toEqual({ id: 'x', from: 'badadib', viewers: 5, endsAtLocal: 9000, target: { roomName: 'fan-live', host: 'fan', title: 'fan-live' } });
    expect(parseRaid({ id: 'x', from: 'b', target: {} })).toBeNull();
    expect(parseRaid(null)).toBeNull();
  });
});

describe('PollCardView', () => {
  it('an open poll asks for a vote with the time left', () => {
    const html = renderToStaticMarkup(h(PollCardView, { poll: basePoll, now: 18_000, canVote: true }));
    expect(html).toContain('Next game?');
    expect(html).toContain('Ends in 0:42');
    expect(html).toContain('hh-poll__choice');
    expect(html).not.toContain('hh-poll__bar');
  });

  it('after voting it shows the results and marks the choice, in the given language', () => {
    const html = renderToStaticMarkup(h(PollCardView, { poll: basePoll, now: 0, canVote: true, myVote: 0, labels: { youVoted: 'Abgestimmt', votes: 'Stimmen: {count}' } }));
    expect(html).toContain('width:75%');
    expect(html).toContain('Chess ✓');
    expect(html).toContain('Abgestimmt');
    expect(html).toContain('Stimmen: 4');
  });

  it('a signed-out viewer sees results and the sign-in hint', () => {
    const html = renderToStaticMarkup(h(PollCardView, { poll: basePoll, now: 0, canVote: false }));
    expect(html).toContain('Sign in to vote');
    expect(html).not.toContain('hh-poll__choice');
  });

  it("the host's studio copy shows the results without the sign-in hint", () => {
    const html = renderToStaticMarkup(h(PollCardView, { poll: basePoll, now: 0, canVote: false, hostView: true }));
    expect(html).not.toContain('Sign in to vote');
    expect(html).toContain('hh-poll__result');
  });

  it('a prediction shows the pot, the stake box and the balance', () => {
    const html = renderToStaticMarkup(h(PollCardView, { poll: basePrediction, now: 0, canVote: true, balance: 800 }));
    expect(html).toContain('Pot: 400 points');
    expect(html).toContain('You have 800 points');
    expect(html).toContain('hh-poll__stake-btn');
  });

  it('a resolved prediction names the winner and what you got back', () => {
    const html = renderToStaticMarkup(h(PollCardView, {
      poll: { ...basePrediction, status: 'resolved', winner: 1 }, now: 0, canVote: true, myStake: { option: 1, amount: 100 }, onDismiss: () => {},
    }));
    expect(html).toContain('No won');
    expect(html).toContain('You got 400 points back');
    expect(html).toContain('is-winner');
    expect(html).toContain('hh-poll__close');
  });

  it('a locked prediction waits for the host; a cancelled one says nobody lost points', () => {
    expect(renderToStaticMarkup(h(PollCardView, { poll: { ...basePrediction, status: 'locked' }, now: 0, canVote: true, myStake: { option: 0, amount: 50 } })))
      .toContain('You put 50 points on Yes');
    expect(renderToStaticMarkup(h(PollCardView, { poll: { ...basePrediction, status: 'locked' }, now: 0, canVote: true })))
      .toContain('Waiting for the result');
    expect(renderToStaticMarkup(h(PollCardView, { poll: { ...basePrediction, status: 'cancelled' }, now: 0, canVote: true })))
      .toContain('Cancelled, everyone keeps their points');
    expect(renderToStaticMarkup(h(PollCardView, { poll: { ...basePoll, status: 'closed' }, now: 0, canVote: true })))
      .toContain('Final results');
  });
});

describe('poll results in the chat', () => {
  const closed = (id: string, endedAt: number, over: Partial<PollView> = {}): PollView => ({ ...basePoll, id, status: 'closed', endedAt, ...over });

  it('keeps finished polls only, once each, oldest first, the newest copy winning', () => {
    let list = addResult([], { ...basePoll, id: 'open' });
    expect(list).toEqual([]);
    list = addResult(list, closed('b', 200));
    list = addResult(list, closed('a', 100));
    list = addResult(list, closed('b', 200, { total: 9 }));
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
    expect(list[1].total).toBe(9);
    expect(parsePollList({ polls: [closed('y', 2), null, { id: 1 }, closed('x', 1)] }).map((p) => p.id)).toEqual(['x', 'y']);
    expect(parsePollList('nope')).toEqual([]);
  });

  it('sums a result up in one line', () => {
    const L = { ...DEFAULT_LIVE_LABELS };
    expect(resultSummary(closed('a', 1), L)).toBe('Chess won');
    expect(resultSummary({ ...basePrediction, status: 'resolved', winner: 1 }, L)).toBe('No won');
    expect(resultSummary({ ...basePrediction, status: 'cancelled' }, L)).toBe(L.cancelled);
    expect(resultSummary(closed('a', 1, { total: 0, options: basePoll.options.map((o) => ({ ...o, votes: 0 })) }), L)).toBe('Final results');
  });

  it('shows the full card for five minutes after the end, then one line that opens it again', () => {
    const p = closed('a', 1_000_000);
    const fresh = renderToStaticMarkup(h(PollResult, { poll: p, now: 1_000_000 + RESULT_OPEN_MS - 1 }));
    expect(fresh).toContain('hh-poll__result');
    expect(fresh).toContain('Hide the result');
    expect(fresh).not.toContain('Sign in to vote');
    const old = renderToStaticMarkup(h(PollResult, { poll: p, now: 1_000_000 + RESULT_OPEN_MS, labels: { showResult: 'Ergebnis zeigen' } }));
    expect(old).toContain('hh-poll-line');
    expect(old).toContain('aria-expanded="false"');
    expect(old).toContain('Ergebnis zeigen');
    expect(old).toContain('Chess won');
    expect(old).not.toContain('hh-poll__options');
  });
});

describe('RaidBannerView', () => {
  it('says who raids where and counts down', () => {
    const html = renderToStaticMarkup(h(RaidBannerView, {
      raid: { id: 'x', from: 'badadib', viewers: 3, endsAtLocal: 0, go: false, target: { roomName: 'fan-live', host: 'fan', title: 'Fan show' } },
      secondsLeft: 7, onGo: () => {}, onStay: () => {},
      labels: { raidGoNow: 'Jetzt los' },
    }));
    expect(html).toContain('@badadib is raiding another stream');
    expect(html).toContain('Everyone watching goes along to Fan show in 7 s.');
    expect(html).toContain('Jetzt los');
    expect(html).toContain('Stay here');
  });
});

describe('studio Live tab', () => {
  function inRoom(el: ReactElement): string {
    const ctx = { apiBaseUrl: '', apiClient: { getSessionToken: () => null }, isAuthenticated: true } as unknown as HangoutsContextValue;
    return renderToStaticMarkup(h(HangoutsContext.Provider, { value: ctx }, h(RoomContext.Provider, { value: new Room() }, el)));
  }

  it('offers a poll or a prediction and the raid list', () => {
    const html = inRoom(h(StudioLivePanel, { roomName: 'badadib-live' }));
    // Polls first; Battle only when the studio passes it; Raid last.
    expect(html.match(/role="tab"[^>]*>[A-Za-z]+/g)?.map((t) => t.split('>')[1])).toEqual(['Polls', 'Raid']);
    expect(html).toContain('Start poll');
    expect(html).not.toContain('Loading');
    expect(inRoom(h(StudioLivePanel, { roomName: 'badadib-live', initialTab: 'raid' }))).toContain('Loading');
  });

  it('has the live battle when the studio passes it, on air or not', () => {
    const idle = inRoom(h(StudioLivePanel, { roomName: 'badadib-live', battle: { onAir: false, onOpen: () => {} } }));
    expect(idle.match(/role="tab"[^>]*>[A-Za-z]+/g)?.map((t) => t.split('>')[1])).toEqual(['Polls', 'Battle', 'Raid']);
    expect(idle).not.toContain('hh-subtabs__dot');
    expect(inRoom(h(StudioLivePanel, { roomName: 'badadib-live', initialTab: 'battle', battle: { onAir: false, onOpen: () => {} } }))).toContain('Start a battle');
    const on = inRoom(h(StudioLivePanel, { roomName: 'badadib-live', initialTab: 'battle', battle: { onAir: true, opponent: 'fan', onOpen: () => {} } }));
    expect(on).toContain('On air with @fan.');
    expect(on).toContain('hh-subtabs__dot');
  });

  it('the Boosts tab opens on the goal, with the history as the second tab', () => {
    const html = inRoom(h(BoostSettingsPanel, { roomName: 'badadib-live', currentConfig: undefined, onClose: () => {}, onSaved: () => {}, embedded: true }));
    expect(html.match(/role="tab"[^>]*>[A-Za-z]+/g)?.map((t) => t.split('>')[1])).toEqual(['Goal', 'History', 'Alerts', 'Amounts']);
    expect(html).toContain('Enable boosts');
    expect(html).toContain('Where viewers see it');
    expect(html).not.toContain('Preset amounts');
    expect(html).toContain('>Save<');
  });

  it('the poll form starts disabled until a question and two options are in', () => {
    const html = inRoom(h(PollHostPanel, { roomName: 'badadib-live' }));
    expect(html).toMatch(/<button type="submit" class="hh-btn hh-btn--primary" disabled="">Start poll<\/button>/);
  });
});
