import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { usePremiumStatus } from '../../hooks/usePremiumStatus.js';
import { useProTrial } from '../../hooks/useProTrial.js';
import { useVscSubs } from '../../hooks/useVscSubs.js';
import { buildTransferIntent } from '../../lib/vscContract.js';
import { SubscriberTicker } from './SubscriberTicker.js';
import { PRO_PERK_GROUPS, PRO_PERKS_FOOTNOTE, type ProPerkGroup } from '../../lib/proBenefits.js';

const INTERVAL_LABELS: Record<string, string> = {
  daily: 'Daily',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

const INTERVAL_DURATIONS: Record<string, string> = {
  daily: '24 hours',
  monthly: '30 days',
  yearly: '365 days',
};

/**
 * Shown whenever the on-chain offer data hasn't loaded (offer ids not
 * configured, contract still being deployed). Real intervals from the contract
 * always win over this.
 */
const STATIC_INTERVALS: Record<string, number> = {
  daily: 1,
  monthly: 10,
  yearly: 100,
};


/**
 * Display formatter: trims trailing zeros so 5.000 HBD renders as "5 HBD".
 * Amounts that go on the wire still need `.toFixed(3)` — never use this for a
 * transfer intent or deposit op.
 */
const AMOUNT_FMT = new Intl.NumberFormat('en', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
function fmtAmount(n: unknown): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return AMOUNT_FMT.format(Number(n));
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds % 60}s`;
}

/** Live "trial active for X" banner. Ticks the local clock only — the server
 *  enforces the real expiry, and the next premium refresh re-checks it. */
function TrialCountdown({ expiresAt }: { expiresAt: string }) {
  const expiryMs = Date.parse(expiresAt);
  const [remaining, setRemaining] = useState(() =>
    Number.isFinite(expiryMs) ? Math.max(0, expiryMs - Date.now()) : 0);

  useEffect(() => {
    if (!Number.isFinite(expiryMs)) return undefined;
    const tick = () => setRemaining(Math.max(0, expiryMs - Date.now()));
    tick();
    // 30s: the banner reads in hours/minutes, so per-second precision would
    // only buy extra renders.
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [expiryMs]);

  if (!Number.isFinite(expiryMs)) return null;
  const expired = remaining <= 0;
  return (
    <div className={`hh-pro__trial-active${expired ? ' hh-pro__trial-active--expired' : ''}`}>
      <span aria-hidden="true">🚀</span>
      <span>
        {expired
          ? 'Your Pro trial has ended — pick a plan below to keep your perks.'
          : <><strong>Pro trial active</strong> · {formatRemaining(remaining)} remaining</>}
      </span>
    </div>
  );
}

interface OfferRow {
  id: number;
  name?: string;
  state?: string;
  asset?: string;
  /** Hasura returns this as a NUMBER for a one-time offer (e.g. `1`), not a
   *  string — `parseFloat` copes with both, but the type must not claim
   *  otherwise or the next person will write `.trim()` on it. */
  one_time?: string | number;
  intervals?: string;
  description?: string;
}

interface SubscriptionRow {
  interval?: string;
  balance?: string;
  next_billing_at?: string;
  status?: string;
}

interface OnetimeRow {
  id: number;
  amount?: string;
  asset?: string;
  indexer_ts?: string;
}

type TxState = 'broadcasting' | 'polling' | 'done' | 'error';

export interface ProPlansProps {
  /** Grouped perks. Defaults to the 3Speak set, which includes every stream
   *  perk from the upsell so the two surfaces cannot drift apart. */
  benefitGroups?: ProPerkGroup[];
  /** Plain-string perk list. Back-compat escape hatch: when supplied it replaces
   *  the grouped layout with a flat bullet list. */
  benefits?: string[];
  /** Heading. */
  title?: string;
  subtitle?: string;
  /** Called when a subscriber in the ticker is clicked. Omit to hide navigation. */
  onSelectUser?: (username: string) => void;
  /** Hide the subscriber marquee. */
  hideSubscriberTicker?: boolean;
  /** Perk tab to open on. Defaults to the first group. */
  initialGroupId?: string;
  /** Fired on every completed purchase / top-up / cancellation, for host-app toasts. */
  onNotify?: (kind: 'success' | 'error', message: string) => void;
}

/** Parse `"monthly=5.000,yearly=50.000"` into `{ monthly: 5, yearly: 50 }`. */
function parseIntervals(intervalsStr?: string): Record<string, number> {
  if (!intervalsStr) return {};
  const result: Record<string, number> = {};
  for (const pair of intervalsStr.split(',')) {
    const [interval, price] = pair.split('=');
    if (interval && price) result[interval.trim()] = parseFloat(price);
  }
  return result;
}

/**
 * The Pro plans page: perks, live subscriber ticker, free trial, and the
 * on-chain checkout (one-time pass or recurring subscription, with an
 * automatic L1→L2 deposit when the user's Magi balance is short).
 */
export function ProPlans({
  benefitGroups = PRO_PERK_GROUPS,
  benefits,
  title = '3Speak Pro',
  subtitle = 'Unlock premium features with a decentralized subscription',
  onSelectUser,
  hideSubscriberTicker = false,
  initialGroupId,
  onNotify,
}: ProPlansProps) {
  const { username, pro } = useHangoutsContext();
  const vsc = useVscSubs();
  const { status: premiumStatus } = usePremiumStatus(username);
  const trial = useProTrial();

  // Deliberately NOT gated on hangouts authentication: a host app may only
  // establish its hangouts session lazily (3Speak signs in on /openpods, not on
  // every page), and the plans, pricing and on-chain checkout need none of it —
  // purchases are signed through the wallet. Only the trial button needs a JWT,
  // and useProTrial gates itself.
  const loggedIn = !!username;

  const [vscBalances, setVscBalances] = useState<{ hive: number; hbd: number }>({ hive: 0, hbd: 0 });
  const [subOffer, setSubOffer] = useState<OfferRow | null>(null);
  const [onetimeOffer, setOnetimeOffer] = useState<OfferRow | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionRow | null>(null);
  const [onetimePurchase, setOnetimePurchase] = useState<OnetimeRow | null>(null);
  const [loadingOffer, setLoadingOffer] = useState(true);
  // A failed lookup and a genuinely-unpublished offer are different situations.
  // Conflating them is how a LIVE service ends up advertising itself as
  // "coming soon" whenever the indexer blips.
  const [offerError, setOfferError] = useState<string | null>(null);

  // Which perk group's tab is open. Streaming first — it is what the stream
  // upsell sends people here for.
  const [activeGroupId, setActiveGroupId] = useState<string | null>(initialGroupId ?? null);

  const [selectedPlan, setSelectedPlan] = useState('monthly');
  const [topUpAmount, setTopUpAmount] = useState('');
  const [processing, setProcessing] = useState(false);
  const [txStatus, setTxStatus] = useState<{ state: TxState; msg: string } | null>(null);

  const notify = useCallback((kind: 'success' | 'error', message: string) => {
    onNotify?.(kind, message);
  }, [onNotify]);

  const activeGroup = benefitGroups.find((g) => g.id === activeGroupId) ?? benefitGroups[0];

  const isOnTrial = premiumStatus?.premium_source === 'testing' && !!premiumStatus.premium_expires_at;

  const fetchOffer = useCallback(async () => {
    setLoadingOffer(true);
    try {
      const data = await vsc.queryHasura<{ sub?: OfferRow[]; onetime?: OfferRow[] }>(`
        query {
          sub: oki_subs_offer_current(where: { id: { _eq: ${pro.subOfferId} } }) {
            id name type state asset one_time intervals description
            total_subscribers active_subscribers
          }
          onetime: oki_subs_offer_current(where: { id: { _eq: ${pro.onetimeOfferId} } }) {
            id name type state asset one_time intervals description
          }
        }
      `);
      const sub = data?.sub?.[0];
      const ot = data?.onetime?.[0];
      if (sub) {
        setSubOffer(sub);
        const first = Object.keys(parseIntervals(sub.intervals))[0];
        // Only adopt the contract's first interval when the user hasn't
        // deliberately picked the one-time pass.
        if (first) setSelectedPlan((cur) => (cur === 'onetime' ? cur : first));
      }
      if (ot) setOnetimeOffer(ot);
      setOfferError(null);
    } catch (err) {
      console.error('[ProPlans] Failed to fetch offers:', err);
      setOfferError((err as Error).message || 'Could not reach the subscription indexer');
    } finally {
      setLoadingOffer(false);
    }
  }, [vsc, pro.subOfferId, pro.onetimeOfferId]);

  const fetchSubscription = useCallback(async () => {
    if (!username) return;
    try {
      const data = await vsc.queryHasura<{
        oki_subs_subscription_current?: SubscriptionRow[];
        oki_subs_onetime_paid_events?: OnetimeRow[];
      }>(`
        query {
          oki_subs_subscription_current(where: {
            subscriber: { _eq: "hive:${username}" },
            offer_id: { _eq: ${pro.subOfferId} }
          }) {
            subscriber offer_id interval balance next_billing_at status asset subscriber_index
          }
          oki_subs_onetime_paid_events(
            where: {
              buyer: { _eq: "hive:${username}" },
              id: { _eq: ${pro.onetimeOfferId} }
            },
            order_by: { indexer_ts: desc },
            limit: 1
          ) {
            id buyer amount asset indexer_ts
          }
        }
      `);
      setSubscription(data?.oki_subs_subscription_current?.[0] ?? null);
      setOnetimePurchase(data?.oki_subs_onetime_paid_events?.[0] ?? null);
    } catch {
      // Normal for a user who has never subscribed.
      setSubscription(null);
      setOnetimePurchase(null);
    }
  }, [vsc, username, pro.subOfferId, pro.onetimeOfferId]);

  const fetchBalance = useCallback(async () => {
    if (!username) return;
    try {
      setVscBalances(await vsc.getVscBalance(username));
    } catch (err) {
      console.error('[ProPlans] Failed to fetch VSC balance:', err);
    }
  }, [vsc, username]);

  useEffect(() => {
    void fetchOffer();
    if (loggedIn) {
      void fetchSubscription();
      void fetchBalance();
    }
  }, [fetchOffer, fetchSubscription, fetchBalance, loggedIn]);

  const contractIntervals = useMemo(() => parseIntervals(subOffer?.intervals), [subOffer]);
  const intervals: Record<string, number | null> = Object.keys(contractIntervals).length > 0
    ? contractIntervals
    // On a load failure show the plan NAMES with no price rather than the
    // static preview figures: those drive the transfer.allow limit and the
    // L1 top-up amount, so guessing them would move real funds on a guess.
    : offerError
      ? { monthly: null, yearly: null }
      : STATIC_INTERVALS;

  const subAsset = subOffer?.asset || 'hbd';
  const subAssetUpper = subAsset.toUpperCase();
  const onetimePrice = onetimeOffer ? (parseFloat(String(onetimeOffer.one_time ?? '')) || 0) : 0;
  const onetimeAsset = onetimeOffer?.asset || 'hive';
  const isActive = subscription?.status === 'active';
  const currentBalance = subscription ? parseFloat(subscription.balance || '0') : 0;
  const currentInterval = subscription?.interval;
  const nextBilling = subscription?.next_billing_at
    ? new Date(parseInt(subscription.next_billing_at, 10) * 1000)
    : null;
  const hasAnyOffer = !!(subOffer || onetimeOffer);

  // A one-time pass is good for 24h from the purchase timestamp.
  const ONETIME_DURATION_MS = 24 * 60 * 60 * 1000;
  const onetimePurchaseTime = onetimePurchase?.indexer_ts
    ? new Date(onetimePurchase.indexer_ts + (onetimePurchase.indexer_ts.endsWith('Z') ? '' : 'Z'))
    : null;
  const onetimeExpiresAt = onetimePurchaseTime
    ? new Date(onetimePurchaseTime.getTime() + ONETIME_DURATION_MS)
    : null;
  const onetimeIsActive = onetimeExpiresAt ? onetimeExpiresAt > new Date() : false;
  const onetimeTimeLeft = onetimeExpiresAt ? Math.max(0, onetimeExpiresAt.getTime() - Date.now()) : 0;

  const pollWithProgress = (txId: string) =>
    vsc.pollTxStatus(txId, 120_000, ({ elapsed }) => {
      setTxStatus({ state: 'polling', msg: `Waiting for VSC confirmation… ${elapsed}s` });
    });

  /**
   * How much L1 has to be deposited for a price. The contract holds no
   * free-floating balance — funds are per-offer — so this is purely
   * "L2 balance vs price", with the gap rounded up to 0.001.
   */
  const calcDepositNeeded = (price: number, asset: string) => {
    const l2 = vscBalances[asset.toLowerCase() as 'hive' | 'hbd'] || 0;
    const remaining = price - l2;
    if (remaining <= 0) return 0;
    return Math.ceil(remaining * 1000) / 1000;
  };

  const refetchAll = () => {
    setTimeout(() => { void fetchOffer(); void fetchSubscription(); void fetchBalance(); }, 3000);
  };

  const handlePurchase = async () => {
    if (!loggedIn || processing || !username) return;

    const isOnetime = selectedPlan === 'onetime';
    const offerId = isOnetime ? pro.onetimeOfferId : pro.subOfferId;
    const price = isOnetime ? onetimePrice : intervals[selectedPlan];
    const payAsset = isOnetime ? onetimeAsset : subAsset;
    if (!price) return;

    const depositNeeded = calcDepositNeeded(price, payAsset);

    setProcessing(true);
    setTxStatus({
      state: 'broadcasting',
      msg: depositNeeded > 0
        ? `Depositing ${fmtAmount(depositNeeded)} ${payAsset.toUpperCase()} to VSC and purchasing…`
        : 'Approve the transaction in your wallet…',
    });

    try {
      const intent = buildTransferIntent(price.toFixed(3), payAsset);
      const payload = isOnetime ? `${offerId}` : `${offerId}|${selectedPlan}`;
      const result = depositNeeded > 0
        ? await vsc.depositAndCallContract(depositNeeded.toFixed(3), payAsset, username, 'pay_offer', payload, [intent])
        : await vsc.callSubsContract('pay_offer', payload, [intent]);

      const poll = await pollWithProgress(result.result!);
      if (poll.status === 'success') {
        const msg = isOnetime ? 'One-time purchase complete!' : 'Subscribed to Pro!';
        setTxStatus({ state: 'done', msg });
        notify('success', msg);
        refetchAll();
      } else {
        const msg = poll.result || 'Transaction failed';
        setTxStatus({ state: 'error', msg });
        notify('error', msg);
      }
    } catch (err) {
      const msg = (err as Error).message || 'Purchase failed';
      setTxStatus({ state: 'error', msg });
      notify('error', msg);
    } finally {
      setProcessing(false);
    }
  };

  const handleTopUp = async () => {
    if (!loggedIn || !isActive || processing || !username) return;
    const amount = parseFloat(topUpAmount);
    if (!amount || amount <= 0) {
      notify('error', 'Enter a valid amount');
      return;
    }

    // The sub's contract balance is already locked, so only the L2→L1 gap matters.
    const l2Balance = vscBalances[subAsset.toLowerCase() as 'hive' | 'hbd'] || 0;
    const depositNeeded = l2Balance < amount ? Math.ceil((amount - l2Balance) * 1000) / 1000 : 0;

    setProcessing(true);
    setTxStatus({
      state: 'broadcasting',
      msg: depositNeeded > 0
        ? `Depositing ${fmtAmount(depositNeeded)} ${subAssetUpper} to VSC and topping up…`
        : 'Approve the top-up in your wallet…',
    });

    try {
      const intent = buildTransferIntent(amount.toFixed(3), subAsset);
      const payload = `${pro.subOfferId}|${currentInterval}`;
      const result = depositNeeded > 0
        ? await vsc.depositAndCallContract(depositNeeded.toFixed(3), subAsset, username, 'pay_offer', payload, [intent])
        : await vsc.callSubsContract('pay_offer', payload, [intent]);

      const poll = await pollWithProgress(result.result!);
      if (poll.status === 'success') {
        setTxStatus({ state: 'done', msg: 'Balance topped up!' });
        notify('success', 'Balance topped up!');
        setTopUpAmount('');
        refetchAll();
      } else {
        const msg = poll.result || 'Top-up failed';
        setTxStatus({ state: 'error', msg });
        notify('error', msg);
      }
    } catch (err) {
      const msg = (err as Error).message || 'Top-up failed';
      setTxStatus({ state: 'error', msg });
      notify('error', msg);
    } finally {
      setProcessing(false);
    }
  };

  const handleCancel = async () => {
    if (!loggedIn || !isActive || processing) return;
    setProcessing(true);
    setTxStatus({ state: 'broadcasting', msg: 'Approve cancellation in your wallet…' });
    try {
      const result = await vsc.callSubsContract('cancel_subscription', `${pro.subOfferId}`, []);
      const poll = await pollWithProgress(result.result!);
      if (poll.status === 'success') {
        const msg = 'Subscription canceled. Prepaid balance refunded.';
        setTxStatus({ state: 'done', msg });
        notify('success', msg);
        refetchAll();
      } else {
        const msg = poll.result || 'Cancellation failed';
        setTxStatus({ state: 'error', msg });
        notify('error', msg);
      }
    } catch (err) {
      const msg = (err as Error).message || 'Cancellation failed';
      setTxStatus({ state: 'error', msg });
      notify('error', msg);
    } finally {
      setProcessing(false);
    }
  };

  if (!loggedIn) return null;

  const locked = isActive || onetimeIsActive;

  return (
    <div className="hh-pro">
      <div className="hh-pro__header">
        <div>
          <h2 className="hh-pro__title">🚀 {title}</h2>
          <p className="hh-pro__subtitle">{subtitle}</p>
        </div>
        {isActive && <span className="hh-pro__badge">✓ Active</span>}
      </div>

      {!hideSubscriberTicker && <SubscriberTicker onSelectUser={onSelectUser} />}

      <div className="hh-pro__grid">
        <div className="hh-pro__perks-col">
          {benefits ? (
            <ul className="hh-pro__benefits">
              {benefits.map((benefit) => (
                <li key={benefit} className="hh-pro__benefit">
                  <span aria-hidden="true">✓</span>
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <div className="hh-pro__tabs" role="tablist" aria-label="Pro benefits">
                {benefitGroups.map((group, i) => {
                  const selected = group.id === activeGroup?.id;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      role="tab"
                      id={`hh-pro-tab-${group.id}`}
                      aria-selected={selected}
                      aria-controls={`hh-pro-panel-${group.id}`}
                      // Roving tabindex: the tablist is ONE tab stop, then the
                      // arrow keys move between tiles.
                      tabIndex={selected ? 0 : -1}
                      className={`hh-pro__tab${selected ? ' hh-pro__tab--active' : ''}`}
                      onClick={() => setActiveGroupId(group.id)}
                      onKeyDown={(e) => {
                        const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                        if (!delta) return;
                        e.preventDefault();
                        const next = benefitGroups[(i + delta + benefitGroups.length) % benefitGroups.length];
                        setActiveGroupId(next.id);
                        document.getElementById(`hh-pro-tab-${next.id}`)?.focus();
                      }}
                    >
                      <span className="hh-pro__tab-icon" aria-hidden="true">{group.icon}</span>
                      <span className="hh-pro__tab-label">{group.heading}</span>
                      <span className="hh-pro__tab-count">{group.perks.length}</span>
                    </button>
                  );
                })}
              </div>

              {activeGroup && (
                <ul
                  className="hh-pro__perklist"
                  role="tabpanel"
                  id={`hh-pro-panel-${activeGroup.id}`}
                  aria-labelledby={`hh-pro-tab-${activeGroup.id}`}
                >
                  {activeGroup.perks.map((perk) => (
                    <li key={perk.title} className="hh-pro__perk">
                      <span className="hh-pro__perk-icon" aria-hidden="true">{perk.icon}</span>
                      <span className="hh-pro__perk-text">
                        <strong className="hh-pro__perk-title">{perk.title}</strong>
                        <span className="hh-pro__perk-body">{perk.body}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="hh-pro__perks-footnote">{PRO_PERKS_FOOTNOTE}</p>
            </>
          )}
        </div>

        <div className="hh-pro__plans-col">
          {/* Three mutually exclusive trial views: live countdown, the CTA, or
              nothing at all (paid sub / already claimed / trials switched off). */}
          {isOnTrial ? (
            <TrialCountdown expiresAt={premiumStatus!.premium_expires_at!} />
          ) : trial.canTrial ? (
            <div className="hh-pro__trial">
              <button
                type="button"
                className="hh-pro__trial-btn"
                onClick={() => { void trial.start(); }}
                disabled={trial.pending}
              >
                {trial.pending ? 'Starting trial…' : `🚀 Try Pro free for ${trial.trialHours}h`}
              </button>
              <span className="hh-pro__trial-note">
                One-time trial — once you start it, your account is on Pro for the next {trial.trialHours} hours.
              </span>
              {trial.error && <span className="hh-pro__trial-error">{trial.error}</span>}
            </div>
          ) : null}

          {loadingOffer ? (
            <div className="hh-pro__loading">
              <div className="hh-pro__skeleton" />
              <div className="hh-pro__skeleton hh-pro__skeleton--sm" />
            </div>
          ) : (
            <>
              {offerError ? (
                <div className="hh-pro__notice hh-pro__notice--error">
                  <span>
                    Couldn't load current pricing — the subscription indexer is unreachable.
                    Existing subscriptions are unaffected.
                  </span>
                  <button
                    type="button"
                    className="hh-pro__notice-retry"
                    onClick={() => { void fetchOffer(); void fetchSubscription(); }}
                  >
                    Retry
                  </button>
                </div>
              ) : !hasAnyOffer ? (
                <div className="hh-pro__notice">
                  <span>No plan is published on the contract yet — the pricing below is a preview.</span>
                </div>
              ) : null}

              {onetimeIsActive && onetimePurchase && onetimeExpiresAt && (
                <div className="hh-pro__onetime hh-pro__onetime--active">
                  <div className="hh-pro__onetime-header">⚡ <span>One-Time Access Active</span></div>
                  <div className="hh-pro__onetime-details">
                    <div>
                      {onetimeTimeLeft > 3600000
                        ? `${Math.floor(onetimeTimeLeft / 3600000)}h ${Math.floor((onetimeTimeLeft % 3600000) / 60000)}m remaining`
                        : onetimeTimeLeft > 60000
                          ? `${Math.floor(onetimeTimeLeft / 60000)}m remaining`
                          : 'Expiring soon'}
                    </div>
                    <div className="hh-pro__onetime-expires">Expires {onetimeExpiresAt.toLocaleString()}</div>
                  </div>
                </div>
              )}

              {onetimePurchase && !onetimeIsActive && (
                <div className="hh-pro__onetime hh-pro__onetime--expired">
                  🕘 <span>Your last one-time access expired on {onetimeExpiresAt?.toLocaleString()}</span>
                </div>
              )}

              {isActive && subscription && (
                <div className="hh-pro__status">
                  <div className="hh-pro__status-grid">
                    <div className="hh-pro__status-item">
                      <span className="hh-pro__status-label">Plan</span>
                      <span className="hh-pro__status-value">{INTERVAL_LABELS[currentInterval ?? ''] || currentInterval}</span>
                    </div>
                    <div className="hh-pro__status-item">
                      <span className="hh-pro__status-label">Prepaid Balance</span>
                      <span className="hh-pro__status-value">{fmtAmount(currentBalance)} {subAssetUpper}</span>
                    </div>
                    <div className="hh-pro__status-item">
                      <span className="hh-pro__status-label">Next Billing</span>
                      <span className="hh-pro__status-value">{nextBilling ? nextBilling.toLocaleDateString() : '—'}</span>
                    </div>
                    <div className="hh-pro__status-item">
                      <span className="hh-pro__status-label">Interval Price</span>
                      <span className="hh-pro__status-value">{fmtAmount(intervals[currentInterval ?? ''])} {subAssetUpper}</span>
                    </div>
                  </div>

                  <div className="hh-pro__topup">
                    <label className="hh-pro__topup-label" htmlFor="hh-pro-topup">Add funds to your prepaid balance</label>
                    <div className="hh-pro__topup-row">
                      <input
                        id="hh-pro-topup"
                        type="number"
                        className="hh-pro__topup-input"
                        value={topUpAmount}
                        onChange={(e) => setTopUpAmount(e.target.value)}
                        placeholder={`Amount in ${subAssetUpper}`}
                        min="0.001"
                        step="0.001"
                        disabled={processing}
                      />
                      <button
                        type="button"
                        className="hh-pro__topup-btn"
                        onClick={() => { void handleTopUp(); }}
                        disabled={processing || !topUpAmount || parseFloat(topUpAmount) <= 0}
                      >
                        Top Up
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="hh-pro__cancel-btn"
                    onClick={() => { void handleCancel(); }}
                    disabled={processing}
                  >
                    ✕ Cancel Subscription
                  </button>
                </div>
              )}

              <div className={`hh-pro__plans${locked ? ' hh-pro__plans--disabled' : ''}`}>
                <p className="hh-pro__plans-label">Choose your plan:</p>
                <div className="hh-pro__plan-cards">
                  {onetimeOffer && onetimeOffer.state === 'active' && (
                    <div
                      className={`hh-pro__plan hh-pro__plan--onetime${selectedPlan === 'onetime' ? ' hh-pro__plan--selected' : ''}`}
                      onClick={locked ? undefined : () => setSelectedPlan('onetime')}
                    >
                      <span className="hh-pro__plan-name">One Time</span>
                      <span className="hh-pro__plan-price">{fmtAmount(onetimePrice)} {onetimeAsset.toUpperCase()}</span>
                      {onetimeOffer.description && <span className="hh-pro__plan-desc">{onetimeOffer.description}</span>}
                    </div>
                  )}

                  {Object.entries(intervals).map(([interval, price]) => (
                    <div
                      key={interval}
                      className={`hh-pro__plan${selectedPlan === interval ? ' hh-pro__plan--selected' : ''}`}
                      onClick={locked ? undefined : () => setSelectedPlan(interval)}
                    >
                      {interval === 'yearly' && <span className="hh-pro__plan-badge">Save 2 months</span>}
                      <span className="hh-pro__plan-name">{INTERVAL_LABELS[interval] || interval}</span>
                      <span className="hh-pro__plan-price">{fmtAmount(price)} {subAssetUpper}</span>
                      <span className="hh-pro__plan-desc">{INTERVAL_DURATIONS[interval] || ''}</span>
                      {subOffer?.description && <span className="hh-pro__plan-desc">{subOffer.description}</span>}
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  className="hh-pro__subscribe-btn"
                  onClick={() => { void handlePurchase(); }}
                  disabled={processing || !selectedPlan || locked || !hasAnyOffer}
                  title={offerError
                    ? 'Current pricing could not be loaded'
                    : !hasAnyOffer ? 'On-chain offer not yet configured' : undefined}
                >
                  {processing ? 'Processing…'
                    : offerError ? 'Pricing unavailable — retry above'
                    : !hasAnyOffer ? 'Not available yet'
                    : selectedPlan === 'onetime' ? `⚡ Buy ${title}`
                    : `👑 Subscribe to ${title}`}
                </button>
              </div>

              {txStatus && (
                <div className={`hh-pro__tx hh-pro__tx--${txStatus.state}`}>
                  <span>{txStatus.msg}</span>
                  {(txStatus.state === 'done' || txStatus.state === 'error') && (
                    <button type="button" className="hh-pro__tx-dismiss" onClick={() => setTxStatus(null)} aria-label="Dismiss">×</button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Default export so the checkout can be code-split with React.lazy — that is
// what keeps the VSC/GraphQL code out of the boot chunk for users who never
// open the plans.
export default ProPlans;
