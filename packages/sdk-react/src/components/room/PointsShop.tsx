import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HangoutsContext } from '../../context/HangoutsContext.js';
import { walletSigner } from '../../lib/pointsSpend.js';
import { fillLabel } from '../../lib/liveLabels.js';
import {
  BOUNTY_TEXT_MAX, SHOP_TEXT_MAX, buyShopItem, ownsStickers, shopQuote, stickerText,
  type ShopCatalog, type ShopOrder,
} from '../../lib/pointsShop.js';
import { pointsText, shopLabels, type ShopLabels } from '../../lib/shopLabels.js';
import { invalidateCosmetics, useCosmetics, usePointsBalance, useShopCatalog } from '../../hooks/useShopData.js';
import { useBounties, useChannelRewards } from '../../hooks/useShopHost.js';
import { useStreamContext } from './StandaloneWatch.js';

/**
 * The viewers' side of the points shop in a live room: a "Use points" button
 * (next to the boost button) that opens a menu of what points buy here, and
 * each purchase as a dialog of its own, exported so a page can open one
 * directly. Prices and what is on come from GET /points/shop; buying is
 * POST /points/shop/buy through buyShopItem (the wallet signs when 3SP asks).
 */

export type ShopAction = 'highlight' | 'readaloud' | 'suggestpoll' | 'reward' | 'bounty' | 'stickers';

/** The menu's order. */
export const SHOP_ACTIONS: readonly ShopAction[] = ['highlight', 'readaloud', 'suggestpoll', 'reward', 'bounty', 'stickers'];

const ICONS: Record<ShopAction, string> = {
  highlight: '✨', readaloud: '🔊', suggestpoll: '📊', reward: '🎁', bounty: '🎯', stickers: '🏷️',
};

const ITEM_OF: Record<ShopAction, string> = {
  highlight: 'highlight', readaloud: 'readaloud', suggestpoll: 'suggestpoll', reward: 'reward', bounty: 'bounty', stickers: 'stickers',
};

function actionTitle(L: ShopLabels, a: ShopAction): string {
  switch (a) {
    case 'highlight': return L.itemHighlight;
    case 'readaloud': return L.itemReadAloud;
    case 'suggestpoll': return L.itemSuggestPoll;
    case 'reward': return L.itemReward;
    case 'bounty': return L.itemBounty;
    default: return L.itemStickers;
  }
}

function actionHint(L: ShopLabels, a: ShopAction): string {
  switch (a) {
    case 'highlight': return L.itemHighlightHint;
    case 'readaloud': return L.itemReadAloudHint;
    case 'suggestpoll': return L.itemSuggestPollHint;
    case 'reward': return L.itemRewardHint;
    case 'bounty': return L.itemBountyHint;
    default: return L.itemStickersHint;
  }
}

function successText(L: ShopLabels, a: ShopAction): string {
  switch (a) {
    case 'highlight': return L.successHighlight;
    case 'readaloud': return L.successReadAloud;
    case 'suggestpoll': return L.successSuggestPoll;
    case 'reward': return L.successReward;
    case 'bounty': return L.successBounty;
    default: return L.successStickers;
  }
}

/** The items a catalog has on (all of them while it loads; the server decides anyway). */
export function availableShopActions(catalog: ShopCatalog | null, readAloudOff = false): ShopAction[] {
  return SHOP_ACTIONS.filter((a) => shopQuote(catalog, ITEM_OF[a]).enabled && !(a === 'readaloud' && readAloudOff));
}

interface CommonProps {
  /** The live room the purchase is for. */
  roomName: string;
  /** The stream's host (the channel). Default: the stream context's host. */
  host?: string | null;
  labels?: Partial<ShopLabels>;
  /** Wrap the wallet signing, e.g. to show "approve in your HiveAuth app"
   *  (the same as SendBoostDialog's signWrapper). */
  signWrapper?: <T>(op: () => Promise<T>, message?: string) => Promise<T>;
  /** After a purchase went through. */
  onBought?: (action: ShopAction, order: ShopOrder | null) => void;
}

export interface PointsShopDialogProps extends CommonProps {
  action: ShopAction;
  onClose: () => void;
  /** Back to the menu (PointsShopActions passes it). */
  onBack?: () => void;
}

/** The modal frame, in the boost dialog's look (and an integrator's skin of it). */
function ShopModal({ title, icon, onClose, closeLabel, children }: {
  title: string; icon: string; onClose: () => void; closeLabel: string; children: ReactNode;
}) {
  const body = (
    <div className="hh-boost-dialog__overlay hh-shop__overlay" onClick={onClose}>
      <div className="hh-boost-dialog hh-shop" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="hh-boost-dialog__header">
          <span><span className="hh-boost-dialog__icon" aria-hidden="true">{icon}</span> {title}</span>
          <button type="button" className="hh-boost-dialog__close" onClick={onClose} aria-label={closeLabel}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? body : createPortal(body, document.body);
}

/**
 * One purchase: highlight a message, a read-aloud message, a suggested poll,
 * a channel reward, a bounty, or the channel's sticker set.
 */
export function PointsShopDialog({ roomName, host: hostProp, action, onClose, onBack, labels, signWrapper, onBought }: PointsShopDialogProps) {
  const ctx = useContext(HangoutsContext);
  const L = useMemo(() => shopLabels(labels), [labels]);
  const stream = useStreamContext();
  const host = (hostProp ?? stream.hostIdentity ?? '').toLowerCase();
  const catalog = useShopCatalog();
  const quote = shopQuote(catalog, ITEM_OF[action]);
  const signedIn = !!ctx?.isAuthenticated && !!ctx?.username;
  const { balance, setBalance } = usePointsBalance(signedIn);
  const myCosmetics = useCosmetics(ctx?.username);

  const [text, setText] = useState('');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [rewardId, setRewardId] = useState<string | null>(null);
  const [rewardInput, setRewardInput] = useState('');
  const [bountyId, setBountyId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rewards = useChannelRewards(action === 'reward' ? host : null);
  const offered = rewards.rewards.filter((r) => r.enabled && r.id);
  const reward = offered.find((r) => r.id === rewardId) ?? null;
  const bounties = useBounties(action === 'bounty' ? roomName : '');
  const bountyMin = quote.min ?? quote.price ?? 100;
  const owned = action === 'stickers' && ownsStickers(myCosmetics, host);

  // What this purchase costs (a reward its own price, a bounty what you pledge).
  const price = action === 'reward' ? (reward?.cost ?? 0)
    : action === 'bounty' ? Math.floor(Number(amount) || 0)
      : quote.price;

  const buy = useCallback(async () => {
    if (!ctx || !signedIn) { setError(L.errSignIn); return; }
    let fields: Record<string, unknown>;
    switch (action) {
      case 'highlight':
      case 'readaloud':
        if (!text.trim()) { setError(L.errText); return; }
        fields = { room: roomName, text: text.trim().slice(0, SHOP_TEXT_MAX) };
        break;
      case 'suggestpoll': {
        const opts = options.map((o) => o.trim()).filter(Boolean);
        if (!question.trim() || opts.length < 2 || new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) { setError(L.errQuestion); return; }
        fields = { room: roomName, question: question.trim(), options: opts };
        break;
      }
      case 'reward':
        if (!reward) { setError(L.noRewards); return; }
        if (reward.prompt && !rewardInput.trim()) { setError(L.errText); return; }
        fields = { room: roomName, rewardId: reward.id, ...(reward.prompt ? { input: rewardInput.trim().slice(0, SHOP_TEXT_MAX) } : {}) };
        break;
      case 'bounty':
        if (!(price >= bountyMin)) { setError(fillLabel(L.errAmount, { min: pointsText(bountyMin) })); return; }
        if (!bountyId && !text.trim()) { setError(L.errText); return; }
        fields = { room: roomName, amount: price, ...(bountyId ? { bountyId } : { text: text.trim().slice(0, BOUNTY_TEXT_MAX) }) };
        break;
      default:
        fields = { channel: host };
    }
    if (balance !== null && price > balance) { setError(fillLabel(L.errBalance, { points: pointsText(balance) })); return; }
    setStatus('sending');
    setError(null);
    const signer = walletSigner(ctx.pro, ctx.aioha);
    const out = await buyShopItem({
      apiBaseUrl: ctx.apiBaseUrl,
      token: () => ctx.apiClient.getSessionToken(),
      item: ITEM_OF[action],
      fields,
      sign: signer && signWrapper ? (ops) => signWrapper(() => signer(ops)) : signer,
      onPending: () => setConfirming(true),
    }).catch((err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : L.errFailed }));
    setConfirming(false);
    if (!out.ok) { setError(out.message || L.errFailed); setStatus('idle'); return; }
    if (out.balance !== null) setBalance(out.balance);
    if (action === 'stickers' && ctx.username) invalidateCosmetics(ctx.apiBaseUrl, ctx.username);
    setStatus('done');
    onBought?.(action, out.order);
  }, [ctx, signedIn, action, text, roomName, options, question, reward, rewardInput, price, bountyMin, bountyId, host, balance, L, signWrapper, onBought, setBalance]);

  const sending = status === 'sending';
  const title = actionTitle(L, action);

  if (status === 'done') {
    return (
      <ShopModal title={title} icon={ICONS[action]} onClose={onClose} closeLabel={L.close}>
        <div className="hh-boost-dialog__body hh-boost-dialog__body--success" role="status">
          <div className="hh-boost-dialog__success-icon" aria-hidden="true">✅</div>
          <p>{successText(L, action)}</p>
          {balance !== null && <p className="hh-boost-dialog__hint">{fillLabel(L.balance, { points: pointsText(balance) })}</p>}
          <button type="button" className="hh-btn hh-btn--primary" onClick={onClose}>{L.done}</button>
        </div>
      </ShopModal>
    );
  }

  return (
    <ShopModal title={title} icon={ICONS[action]} onClose={onClose} closeLabel={L.close}>
      <div className="hh-boost-dialog__body hh-shop__body">
        <p className="hh-boost-dialog__hint">{actionHint(L, action)}</p>

        {(action === 'highlight' || action === 'readaloud') && (
          <>
            <textarea
              className="hh-boost-dialog__message"
              placeholder={fillLabel(L.messagePlaceholder, { max: SHOP_TEXT_MAX })}
              aria-label={title}
              maxLength={SHOP_TEXT_MAX}
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={sending}
            />
            <div className="hh-boost-dialog__char-count">{text.length} / {SHOP_TEXT_MAX}</div>
          </>
        )}

        {action === 'suggestpoll' && (
          <div className="hh-shop__fields">
            <input className="hh-boost-dialog__amount hh-shop__input" value={question} maxLength={140} placeholder={L.questionPlaceholder}
              aria-label={L.questionPlaceholder} onChange={(e) => setQuestion(e.target.value)} disabled={sending} />
            {options.map((o, i) => (
              <div className="hh-shop__opt" key={i}>
                <input className="hh-boost-dialog__amount hh-shop__input" value={o} maxLength={60}
                  placeholder={fillLabel(L.optionPlaceholder, { n: i + 1 })} aria-label={fillLabel(L.optionPlaceholder, { n: i + 1 })}
                  onChange={(e) => setOptions((all) => all.map((x, j) => (j === i ? e.target.value : x)))} disabled={sending} />
                {options.length > 2 && (
                  <button type="button" className="hh-shop__remove" aria-label={fillLabel(L.removeOption, { n: i + 1 })}
                    onClick={() => setOptions((all) => all.filter((_, j) => j !== i))} disabled={sending}>✕</button>
                )}
              </div>
            ))}
            {options.length < 4 && (
              <button type="button" className="hh-btn hh-btn--secondary hh-btn--small hh-shop__add" onClick={() => setOptions((all) => [...all, ''])} disabled={sending}>
                {L.addOption}
              </button>
            )}
          </div>
        )}

        {action === 'reward' && (
          rewards.loading ? <p className="hh-boost-dialog__hint">{L.loading}</p>
            : offered.length === 0 ? <p className="hh-shop__empty">{L.noRewards}</p>
              : (
                <div className="hh-shop__choices" role="radiogroup" aria-label={L.itemReward}>
                  {offered.map((r) => (
                    <button key={r.id} type="button" role="radio" aria-checked={rewardId === r.id}
                      className={`hh-shop__choice${rewardId === r.id ? ' is-active' : ''}`} onClick={() => { setRewardId(r.id!); setError(null); }} disabled={sending}>
                      <span className="hh-shop__choice-title">{r.title}</span>
                      <span className="hh-shop__choice-meta">
                        {fillLabel(L.rewardCostTag, { points: pointsText(r.cost) })}{r.prompt ? ` · ${L.rewardAsksText}` : ''}
                      </span>
                    </button>
                  ))}
                  {reward?.prompt && (
                    <textarea className="hh-boost-dialog__message" rows={2} maxLength={SHOP_TEXT_MAX} placeholder={L.rewardInputPlaceholder}
                      aria-label={L.rewardInputPlaceholder} value={rewardInput} onChange={(e) => setRewardInput(e.target.value)} disabled={sending} />
                  )}
                </div>
              )
        )}

        {action === 'bounty' && (
          <div className="hh-shop__choices" role="radiogroup" aria-label={L.itemBounty}>
            {bounties.bounties.length > 0 && <span className="hh-shop__label">{L.bountyOpen}</span>}
            {bounties.bounties.map((b) => (
              <button key={b.id} type="button" role="radio" aria-checked={bountyId === b.id}
                className={`hh-shop__choice${bountyId === b.id ? ' is-active' : ''}`} onClick={() => setBountyId(b.id)} disabled={sending}>
                <span className="hh-shop__choice-title">{b.text}</span>
                <span className="hh-shop__choice-meta">{fillLabel(L.bountyBackers, { points: pointsText(b.total), count: b.backers })}</span>
              </button>
            ))}
            <button type="button" role="radio" aria-checked={bountyId === null}
              className={`hh-shop__choice${bountyId === null ? ' is-active' : ''}`} onClick={() => setBountyId(null)} disabled={sending}>
              <span className="hh-shop__choice-title">{L.bountyNew}</span>
            </button>
            {bountyId === null && (
              <input className="hh-boost-dialog__amount hh-shop__input" value={text} maxLength={BOUNTY_TEXT_MAX} placeholder={L.bountyTextPlaceholder}
                aria-label={L.bountyTextPlaceholder} onChange={(e) => setText(e.target.value)} disabled={sending} />
            )}
            <label className="hh-shop__amount">
              <span className="hh-shop__label">{L.bountyAmount}</span>
              <input className="hh-boost-dialog__amount" type="number" min={bountyMin} step={1} inputMode="numeric"
                placeholder={String(bountyMin)} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={sending} />
            </label>
            <span className="hh-boost-dialog__hint">{fillLabel(L.bountyMin, { min: pointsText(bountyMin) })}</span>
          </div>
        )}

        {action === 'stickers' && (
          <>
            <div className="hh-shop__stickers" aria-hidden="true">
              {Object.entries(catalog?.stickers ?? {}).map(([id, e]) => <span key={id} className="hh-shop__sticker" title={stickerText(id)}>{e}</span>)}
            </div>
            {owned && <p className="hh-boost-dialog__hint">{L.stickersOwned}</p>}
          </>
        )}

        {!quote.enabled && <p className="hh-boost-dialog__error">{L.unavailable}</p>}
        {!signedIn && <p className="hh-boost-dialog__error">{L.errSignIn}</p>}
        {signedIn && balance !== null && (
          <p className="hh-boost-dialog__rate-hint"><strong>{fillLabel(L.balance, { points: pointsText(balance) })}</strong></p>
        )}
        {error && <p className="hh-boost-dialog__error" role="alert">{error}</p>}
      </div>
      <div className="hh-boost-dialog__footer">
        <button type="button" className="hh-btn hh-btn--secondary" onClick={onBack ?? onClose} disabled={sending}>
          {onBack ? L.back : L.close}
        </button>
        <button
          type="button"
          className="hh-btn hh-btn--primary"
          onClick={() => void buy()}
          disabled={sending || !signedIn || !quote.enabled || owned || (action === 'reward' && !reward)}
        >
          {sending ? (confirming ? L.confirming : L.buying) : fillLabel(L.buy, { points: pointsText(price) })}
        </button>
      </div>
    </ShopModal>
  );
}

type DialogShortcutProps = Omit<PointsShopDialogProps, 'action'>;
export const HighlightMessageDialog = (p: DialogShortcutProps) => <PointsShopDialog {...p} action="highlight" />;
export const ReadAloudDialog = (p: DialogShortcutProps) => <PointsShopDialog {...p} action="readaloud" />;
export const SuggestPollDialog = (p: DialogShortcutProps) => <PointsShopDialog {...p} action="suggestpoll" />;
export const RedeemRewardDialog = (p: DialogShortcutProps) => <PointsShopDialog {...p} action="reward" />;
export const BountyDialog = (p: DialogShortcutProps) => <PointsShopDialog {...p} action="bounty" />;
export const UnlockStickersDialog = (p: DialogShortcutProps) => <PointsShopDialog {...p} action="stickers" />;

export interface PointsShopMenuProps {
  actions: ShopAction[];
  catalog: ShopCatalog | null;
  balance: number | null;
  labels?: Partial<ShopLabels>;
  onPick: (action: ShopAction) => void;
}

/** The list of what points buy here (no state; PointsShopActions shows it). */
export function PointsShopMenu({ actions, catalog, balance, labels, onPick }: PointsShopMenuProps) {
  const L = shopLabels(labels);
  return (
    <div className="hh-boost-dialog__body hh-shop__body">
      {balance !== null && <p className="hh-boost-dialog__rate-hint"><strong>{fillLabel(L.balance, { points: pointsText(balance) })}</strong></p>}
      <ul className="hh-shop__menu">
        {actions.map((a) => {
          const q = shopQuote(catalog, ITEM_OF[a]);
          // A reward costs what the host set and a bounty what you pledge: no price on the row.
          const price = a === 'reward' ? null : a === 'bounty' ? (q.min ?? q.price) : q.price;
          return (
            <li key={a}>
              <button type="button" className="hh-shop__item" onClick={() => onPick(a)}>
                <span className="hh-shop__item-icon" aria-hidden="true">{ICONS[a]}</span>
                <span className="hh-shop__item-text">
                  <span className="hh-shop__item-title">{actionTitle(L, a)}</span>
                  <span className="hh-shop__item-hint">{actionHint(L, a)}</span>
                </span>
                {price !== null && price > 0 && (
                  <span className="hh-shop__item-price">{fillLabel(L.pointsPrice, { points: pointsText(price) })}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface PointsShopActionsProps extends CommonProps {
  /** Which items to offer (default: every one the catalog has on). */
  actions?: ShopAction[];
  /** The host switched read-aloud messages off (room metadata
   *  boost.alerts.readAloud false): hides that item. The server refuses it anyway. */
  readAloudOff?: boolean;
  /** Signed out: called instead of opening the menu (e.g. the page's sign in). */
  onSignIn?: () => void;
  /** Classes for the button (default a small secondary button). */
  buttonClassName?: string;
  /** Open on mount (e.g. a page that has its own button). */
  defaultOpen?: boolean;
  /** Called when the menu or a dialog closes. */
  onClose?: () => void;
}

/** The "Use points" button and its menu; each item opens its dialog in place. */
export function PointsShopActions({
  roomName, host, labels, signWrapper, onBought, actions, readAloudOff = false, onSignIn,
  buttonClassName = 'hh-btn hh-btn--secondary hh-btn--small', defaultOpen = false, onClose,
}: PointsShopActionsProps) {
  const ctx = useContext(HangoutsContext);
  const L = useMemo(() => shopLabels(labels), [labels]);
  const catalog = useShopCatalog();
  const [open, setOpen] = useState(defaultOpen);
  const [picked, setPicked] = useState<ShopAction | null>(null);
  const { balance, refresh } = usePointsBalance(open && !!ctx?.isAuthenticated);
  const list = (actions ?? availableShopActions(catalog, readAloudOff))
    .filter((a) => shopQuote(catalog, ITEM_OF[a]).enabled && !(a === 'readaloud' && readAloudOff));
  const close = () => { setOpen(false); setPicked(null); onClose?.(); };

  return (
    <>
      <button
        type="button"
        className={`${buttonClassName} hh-shop__button`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!ctx?.isAuthenticated && onSignIn) { onSignIn(); return; }
          setOpen(true);
          void refresh();
        }}
      >
        <span aria-hidden="true">✨</span> {L.usePoints}
      </button>
      {open && !picked && (
        <ShopModal title={L.menuTitle} icon="✨" onClose={close} closeLabel={L.close}>
          <PointsShopMenu actions={list} catalog={catalog} balance={balance} labels={labels} onPick={setPicked} />
        </ShopModal>
      )}
      {open && picked && (
        <PointsShopDialog
          roomName={roomName}
          host={host}
          action={picked}
          labels={labels}
          signWrapper={signWrapper}
          onBought={(a, o) => { void refresh(); onBought?.(a, o); }}
          onBack={() => setPicked(null)}
          onClose={close}
        />
      )}
    </>
  );
}
