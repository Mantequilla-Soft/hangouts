import { useRoomBattle } from '../../hooks/useBattle.js';
import {
  battleLabels, battleRemainingMs, battleResultText, battleShare, fillBattle, formatBattleClock,
  formatBattleHbd, otherSide, type BattleLabels,
} from '../../lib/battle.js';

export interface StreamBattleBarProps {
  /** `overlay`: over the top of the video. `inline`: a block in a panel. */
  variant?: 'overlay' | 'inline';
  labels?: Partial<BattleLabels>;
  className?: string;
  /** Studios: also show how an invite ended (declined, no answer). */
  all?: boolean;
  /** Which side to put on the left when the room name can't tell (a studio
   *  knows its host). Defaults to this room's side. */
  host?: string;
}

/**
 * The battle meter: this stream's host on the left, the other on the right,
 * the share of the boosts each got in the battle window, the countdown, and
 * the result for a few seconds after the end. Live from the room metadata
 * (both rooms carry the same battle), so viewers of BOTH streams see the
 * same numbers. Renders nothing outside a battle. Use inside <StandaloneWatch>,
 * the studio or any <LiveKitRoom>.
 */
export function StreamBattleBar({ variant = 'overlay', labels, className, all = false, host }: StreamBattleBarProps) {
  const { battle, phase, side, now } = useRoomBattle({ all, host });
  if (!battle || !phase || phase === 'invited' || !side) return null;
  const L = battleLabels(labels);
  const me = battle[side];
  const them = battle[otherSide(side)];
  const ended = phase === 'result';
  const meterShown = battle.state !== 'ended' || battle.endReason === 'time' || battle.endReason === 'ended' || battle.endReason === 'dropped';
  const share = battleShare(battle, side);
  const pct = Math.round(share * 1000) / 10;

  let status = '';
  if (phase === 'starting') status = fillBattle(L.startsIn, { seconds: Math.ceil(battleRemainingMs(battle, now) / 1000) });
  else if (phase === 'live') status = fillBattle(L.timeLeft, { time: formatBattleClock(battleRemainingMs(battle, now)) });
  else if (phase === 'settling') status = L.counting;

  const won = ended && battle.endReason === 'time' && battle.winner === side;
  const cls = [
    'hh-battle-bar',
    `hh-battle-bar--${variant}`,
    `hh-battle-bar--${phase}`,
    won ? 'hh-battle-bar--won' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} role="group" aria-label={L.title}>
      {meterShown && (
        <>
          <div className="hh-battle-bar__row">
            <span className="hh-battle-bar__name hh-battle-bar__name--me">@{me.host}</span>
            <span className="hh-battle-bar__status">
              <span className="hh-battle-bar__tag">{L.title}</span>
              {status && <span className="hh-battle-bar__clock" aria-live="polite">{status}</span>}
            </span>
            <span className="hh-battle-bar__name hh-battle-bar__name--them">@{them.host}</span>
          </div>
          <div
            className="hh-battle-bar__meter"
            role="progressbar"
            aria-label={`@${me.host} / @${them.host}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <span className="hh-battle-bar__fill" style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
          <div className="hh-battle-bar__row hh-battle-bar__row--amounts">
            <span className="hh-battle-bar__amount">{fillBattle(L.amount, { amount: formatBattleHbd(me.hbd) })}</span>
            {variant === 'overlay' && phase === 'live' && (
              <span className="hh-battle-bar__hint">{fillBattle(L.boostHint, { name: me.host })}</span>
            )}
            <span className="hh-battle-bar__amount">{fillBattle(L.amount, { amount: formatBattleHbd(them.hbd) })}</span>
          </div>
        </>
      )}
      {ended && (
        <div className="hh-battle-bar__banner" role="status">{battleResultText(battle, L)}</div>
      )}
    </div>
  );
}
