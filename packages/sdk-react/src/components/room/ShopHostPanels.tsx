import { useContext, useEffect, useMemo, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { HangoutsContext } from '../../context/HangoutsContext.js';
import { hostFromMetadata } from '../../lib/dataTrust.js';
import { walletSigner } from '../../lib/pointsSpend.js';
import { fillLabel } from '../../lib/liveLabels.js';
import {
  REWARDS_MAX, REWARD_COST_MAX, REWARD_COST_MIN, buyShopItem, shopQuote,
  type Bounty, type ChannelReward, type PollSuggestion, type ReadAloudEvent, type Redemption,
} from '../../lib/pointsShop.js';
import { pointsText, shopLabels, type ShopLabels } from '../../lib/shopLabels.js';
import { useBounties, useChannelRewards, usePollSuggestions, useRewardQueue } from '../../hooks/useShopHost.js';
import { useShopCatalog } from '../../hooks/useShopData.js';

/**
 * The host's points shop tools, for the studio's Live tab and for an OBS dock
 * (each panel works with the session alone; inside a LiveKit room it follows
 * the data channel, outside one it reads again every 20 s):
 *   PollSuggestionsPanel  polls viewers suggested: Run or Decline (refunds)
 *   ChannelRewardsPanel   the redemption queue (Done, Refund) and the editor
 *   BountiesPanel         open bounties: Done pays the host, Decline refunds
 * plus ReadAloudAlerts (the read-aloud messages as they arrive) and
 * BuyStreamTimeButton (+30 minutes past the free cap).
 * Each panel has a stateless *View for an integrator's own data or layout.
 */

interface LabelsProp { labels?: Partial<ShopLabels> }

const RUN_DURATIONS = [30, 60, 120, 300];
const fmtDuration = (sec: number) => (sec < 60 ? `${sec} s` : `${sec / 60} min`);

// ── suggested polls ───────────────────────────────────────────────────────

export interface PollSuggestionsViewProps extends LabelsProp {
  suggestions: PollSuggestion[];
  loading?: boolean;
  busyId?: string | null;
  error?: string | null;
  onRun: (id: string, durationSec: number) => void;
  onDecline: (id: string) => void;
}

export function PollSuggestionsView({ suggestions, loading = false, busyId = null, error = null, onRun, onDecline, labels }: PollSuggestionsViewProps) {
  const L = shopLabels(labels);
  const [duration, setDuration] = useState(60);
  return (
    <section className="hh-shophost" aria-label={L.suggestionsTitle}>
      <h4 className="hh-shophost__title">{L.suggestionsTitle}</h4>
      {loading && suggestions.length === 0 ? <p className="hh-shophost__empty">{L.loading}</p>
        : suggestions.length === 0 ? <p className="hh-shophost__empty">{L.suggestionsEmpty}</p>
          : (
            <>
              <div className="hh-pollhost__durations" role="radiogroup" aria-label={L.suggestionTimer}>
                <span>{L.suggestionTimer}</span>
                {RUN_DURATIONS.map((d) => (
                  <button key={d} type="button" role="radio" aria-checked={duration === d}
                    className={`hh-pollhost__chip${duration === d ? ' is-on' : ''}`} onClick={() => setDuration(d)}>{fmtDuration(d)}</button>
                ))}
              </div>
              <ul className="hh-shophost__list">
                {suggestions.map((s) => (
                  <li key={s.id} className="hh-shophost__row">
                    <div className="hh-shophost__info">
                      <span className="hh-shophost__main">{s.question}</span>
                      <span className="hh-shophost__meta">{s.options.join(' · ')}</span>
                      <span className="hh-shophost__meta">{fillLabel(L.suggestionFrom, { name: s.from })}</span>
                    </div>
                    <div className="hh-shophost__actions">
                      <button type="button" className="hh-btn hh-btn--primary hh-btn--small" disabled={busyId === s.id} onClick={() => onRun(s.id, duration)}>
                        {L.suggestionRun}
                      </button>
                      <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={busyId === s.id} onClick={() => onDecline(s.id)}>
                        {L.suggestionDecline}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
      {error && <p className="hh-shophost__error" role="alert">{error}</p>}
    </section>
  );
}

/** The host's (or a mod's) pending poll suggestions. Run starts the poll. */
export function PollSuggestionsPanel({ roomName, labels }: { roomName: string } & LabelsProp) {
  const s = usePollSuggestions(roomName);
  return (
    <PollSuggestionsView
      suggestions={s.suggestions} loading={s.loading} busyId={s.busyId} error={s.error} labels={labels}
      onRun={(id, d) => void s.accept(id, d)} onDecline={(id) => void s.reject(id)}
    />
  );
}

// ── channel rewards ───────────────────────────────────────────────────────

export interface RewardQueueViewProps extends LabelsProp {
  queue: Redemption[];
  loading?: boolean;
  busyId?: string | null;
  error?: string | null;
  onDone: (id: string) => void;
  onRefund: (id: string) => void;
}

export function RewardQueueView({ queue, loading = false, busyId = null, error = null, onDone, onRefund, labels }: RewardQueueViewProps) {
  const L = shopLabels(labels);
  return (
    <section className="hh-shophost" aria-label={L.queueTitle}>
      <h4 className="hh-shophost__title">{L.queueTitle}</h4>
      {loading && queue.length === 0 ? <p className="hh-shophost__empty">{L.loading}</p>
        : queue.length === 0 ? <p className="hh-shophost__empty">{L.queueEmpty}</p>
          : (
            <ul className="hh-shophost__list">
              {queue.map((r) => (
                <li key={r.id} className="hh-shophost__row">
                  <div className="hh-shophost__info">
                    <span className="hh-shophost__main">{fillLabel(L.queueLine, { name: r.from, title: r.title })}</span>
                    {r.input && <span className="hh-shophost__quote">{r.input}</span>}
                    <span className="hh-shophost__meta">{fillLabel(L.pointsPrice, { points: pointsText(r.cost) })}</span>
                  </div>
                  <div className="hh-shophost__actions">
                    <button type="button" className="hh-btn hh-btn--primary hh-btn--small" disabled={busyId === r.id} onClick={() => onDone(r.id)}>{L.queueDone}</button>
                    <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={busyId === r.id} onClick={() => onRefund(r.id)}>{L.queueRefund}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      {error && <p className="hh-shophost__error" role="alert">{error}</p>}
    </section>
  );
}

/** Check the editor's rows before PUT /channels/rewards; null when they are fine. */
export function rewardsProblem(rows: ChannelReward[], L: ShopLabels = shopLabels()): string | null {
  if (rows.length > REWARDS_MAX) return fillLabel(L.rewardsMax, { max: REWARDS_MAX });
  for (const r of rows) {
    if (!r.title.trim()) return L.errRewardName;
    if (!(Number.isInteger(r.cost) && r.cost >= REWARD_COST_MIN && r.cost <= REWARD_COST_MAX)) {
      return fillLabel(L.errRewardCost, { min: pointsText(REWARD_COST_MIN), max: pointsText(REWARD_COST_MAX) });
    }
  }
  return null;
}

export interface RewardsEditorProps extends LabelsProp {
  rewards: ChannelReward[];
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  /** Resolves the saved list, or null when it failed. */
  onSave: (rewards: ChannelReward[]) => Promise<ChannelReward[] | null>;
}

/** The host's rewards: a name, a cost, "asks for text", on or off; at most 12. */
export function RewardsEditor({ rewards, loading = false, saving = false, error = null, onSave, labels }: RewardsEditorProps) {
  const L = shopLabels(labels);
  const [rows, setRows] = useState<Array<ChannelReward & { costText: string }>>([]);
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The server's list, until the host starts editing.
  useEffect(() => {
    if (!dirty) setRows(rewards.map((r) => ({ ...r, costText: String(r.cost) })));
  }, [rewards, dirty]);
  const edit = (i: number, patch: Partial<ChannelReward & { costText: string }>) => {
    setDirty(true);
    setSaved(false);
    setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const save = async () => {
    const list: ChannelReward[] = rows.map(({ costText, ...r }) => ({ ...r, title: r.title.trim(), cost: Math.floor(Number(costText)) }));
    const p = rewardsProblem(list, L);
    setProblem(p);
    if (p) return;
    const out = await onSave(list);
    if (out) { setDirty(false); setSaved(true); }
  };
  return (
    <section className="hh-shophost" aria-label={L.rewardsTitle}>
      <h4 className="hh-shophost__title">{L.rewardsTitle}</h4>
      {loading && rows.length === 0 && <p className="hh-shophost__empty">{L.loading}</p>}
      <ul className="hh-shophost__list">
        {rows.map((r, i) => (
          <li key={r.id ?? `new-${i}`} className="hh-shophost__row hh-shophost__row--edit">
            <label className="hh-shophost__field hh-shophost__field--grow">
              <span>{L.rewardName}</span>
              <input className="hh-pollhost__input" value={r.title} maxLength={60} placeholder={L.rewardNamePlaceholder}
                onChange={(e) => edit(i, { title: e.target.value })} disabled={saving} />
            </label>
            <label className="hh-shophost__field">
              <span>{L.rewardCost}</span>
              <input className="hh-pollhost__input" type="number" inputMode="numeric" min={REWARD_COST_MIN} max={REWARD_COST_MAX} step={1}
                value={r.costText} onChange={(e) => edit(i, { costText: e.target.value })} disabled={saving} />
            </label>
            <label className="hh-shophost__check">
              <input type="checkbox" checked={r.prompt} onChange={(e) => edit(i, { prompt: e.target.checked })} disabled={saving} />
              <span>{L.rewardPrompt}</span>
            </label>
            <label className="hh-shophost__check">
              <input type="checkbox" checked={r.enabled} onChange={(e) => edit(i, { enabled: e.target.checked })} disabled={saving} />
              <span>{L.rewardEnabled}</span>
            </label>
            <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={saving}
              onClick={() => { setDirty(true); setSaved(false); setRows((all) => all.filter((_, j) => j !== i)); }}>
              {L.rewardRemove}
            </button>
          </li>
        ))}
      </ul>
      <div className="hh-shophost__actions">
        <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={saving || rows.length >= REWARDS_MAX}
          onClick={() => { setDirty(true); setSaved(false); setRows((all) => [...all, { title: '', cost: 1000, costText: '1000', prompt: false, enabled: true }]); }}>
          {L.rewardAdd}
        </button>
        <button type="button" className="hh-btn hh-btn--primary hh-btn--small" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? L.saving : L.rewardsSave}
        </button>
      </div>
      {rows.length >= REWARDS_MAX && <p className="hh-shophost__meta">{fillLabel(L.rewardsMax, { max: REWARDS_MAX })}</p>}
      {saved && !dirty && <p className="hh-shophost__saved" role="status">✓ {L.rewardsSaved}</p>}
      {(problem || error) && <p className="hh-shophost__error" role="alert">{problem ?? error}</p>}
    </section>
  );
}

/** The redemption queue on top, the host's rewards under it. `owner` is the
 *  host's account (default the signed-in user, else the room's host). */
export function ChannelRewardsPanel({ roomName, owner, labels }: { roomName: string; owner?: string | null } & LabelsProp) {
  const ctx = useContext(HangoutsContext);
  const room = useMaybeRoomContext();
  const L = shopLabels(labels);
  const q = useRewardQueue(roomName);
  const r = useChannelRewards(owner ?? ctx?.username ?? (hostFromMetadata(room?.metadata) || null));
  return (
    <div className="hh-shophost__stack">
      <p className="hh-settings__intro">{L.rewardsIntro}</p>
      <RewardQueueView queue={q.queue} loading={q.loading} busyId={q.busyId} error={q.error} labels={labels}
        onDone={(id) => void q.done(id)} onRefund={(id) => void q.refund(id)} />
      <RewardsEditor rewards={r.rewards} loading={r.loading} saving={r.saving} error={r.error} onSave={r.save} labels={labels} />
    </div>
  );
}

// ── bounties ──────────────────────────────────────────────────────────────

export interface BountiesViewProps extends LabelsProp {
  bounties: Bounty[];
  loading?: boolean;
  busyId?: string | null;
  error?: string | null;
  onDone: (id: string) => void;
  onDecline: (id: string) => void;
}

export function BountiesView({ bounties, loading = false, busyId = null, error = null, onDone, onDecline, labels }: BountiesViewProps) {
  const L = shopLabels(labels);
  return (
    <section className="hh-shophost" aria-label={L.tabBounties}>
      <p className="hh-settings__intro">{L.bountiesIntro}</p>
      {loading && bounties.length === 0 ? <p className="hh-shophost__empty">{L.loading}</p>
        : bounties.length === 0 ? <p className="hh-shophost__empty">{L.bountiesEmpty}</p>
          : (
            <ul className="hh-shophost__list">
              {bounties.map((b) => (
                <li key={b.id} className="hh-shophost__row">
                  <div className="hh-shophost__info">
                    <span className="hh-shophost__main">{b.text}</span>
                    <span className="hh-shophost__meta">{fillLabel(L.bountyBackers, { points: pointsText(b.total), count: b.backers })}</span>
                    {b.createdBy && <span className="hh-shophost__meta">{fillLabel(L.bountyBy, { name: b.createdBy })}</span>}
                  </div>
                  <div className="hh-shophost__actions">
                    <button type="button" className="hh-btn hh-btn--primary hh-btn--small" disabled={busyId === b.id} onClick={() => onDone(b.id)}>{L.bountyDone}</button>
                    <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={busyId === b.id} onClick={() => onDecline(b.id)}>{L.bountyDecline}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      {error && <p className="hh-shophost__error" role="alert">{error}</p>}
    </section>
  );
}

/** The stream's open bounties for the host. */
export function BountiesPanel({ roomName, labels }: { roomName: string } & LabelsProp) {
  const b = useBounties(roomName);
  return (
    <BountiesView bounties={b.bounties} loading={b.loading} busyId={b.busyId} error={b.error} labels={labels}
      onDone={(id) => void b.done(id)} onDecline={(id) => void b.decline(id)} />
  );
}

// ── read-aloud and stream time ────────────────────────────────────────────

/** The read-aloud messages that just came in (useReadAloud's list), as small cards. */
export function ReadAloudAlerts({ events, labels, className = '' }: { events: ReadAloudEvent[]; className?: string } & LabelsProp) {
  const L = shopLabels(labels);
  if (events.length === 0) return null;
  return (
    <div className={`hh-readaloud ${className}`.trim()} role="status" aria-live="polite">
      {events.map((e) => (
        <div key={e.id} className="hh-readaloud__card">
          <span className="hh-readaloud__icon" aria-hidden="true">🔊</span>
          <span className="hh-readaloud__text">
            <strong className="hh-readaloud__title">{L.readAloudTitle}</strong>
            <span>{fillLabel(L.readAloudAlert, { name: e.sender, message: e.message })}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export interface BuyStreamTimeButtonProps extends LabelsProp {
  /** After the time was bought: refetch GET /points/stream-extra (useStreamExtra's refresh). */
  onBought: () => void;
  className?: string;
}

/** "+30 min for 10,000 points": buys the shop item `minutes` for a free host. */
export function BuyStreamTimeButton({ onBought, labels, className = 'hh-btn hh-btn--secondary hh-btn--small' }: BuyStreamTimeButtonProps) {
  const ctx = useContext(HangoutsContext);
  const L = useMemo(() => shopLabels(labels), [labels]);
  const catalog = useShopCatalog();
  const q = catalog?.items.minutes;
  const quote = shopQuote(catalog, 'minutes');
  const minutes = typeof q?.minutes === 'number' ? q.minutes : 30;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  if (!quote.enabled || !ctx?.isAuthenticated) return null;
  const buy = async () => {
    setBusy(true);
    setNote(null);
    const out = await buyShopItem({
      apiBaseUrl: ctx.apiBaseUrl,
      token: () => ctx.apiClient.getSessionToken(),
      item: 'minutes',
      sign: walletSigner(ctx.pro, ctx.aioha),
    }).catch((err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : L.errFailed }));
    setBusy(false);
    if (!out.ok) { setNote({ ok: false, text: out.message || L.errFailed }); return; }
    setNote({ ok: true, text: fillLabel(L.minutesAdded, { minutes }) });
    onBought();
  };
  return (
    <span className="hh-buytime">
      <button type="button" className={className} disabled={busy} onClick={() => void buy()}>
        {busy ? L.buyMinutesBusy : fillLabel(L.buyMinutes, { minutes, points: pointsText(quote.price) })}
      </button>
      {note && <span className={`hh-buytime__note${note.ok ? '' : ' hh-buytime__note--error'}`} role={note.ok ? 'status' : 'alert'}>{note.text}</span>}
    </span>
  );
}
