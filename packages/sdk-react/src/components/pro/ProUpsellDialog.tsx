import { Suspense, lazy, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProTrial } from '../../hooks/useProTrial.js';
import { STREAM_PERKS, type ProPerk } from '../../lib/proBenefits.js';

// Lazy so the VSC contract + GraphQL code only loads when someone actually
// opens the plans. The dialog itself is light and stays in the main chunk —
// it has to render instantly next to a locked checkbox.
const ProPlans = lazy(() => import('./ProPlans.js'));

/** Re-exported so integrators can extend or reorder the default offer. */
export const DEFAULT_STREAM_PERKS = STREAM_PERKS;
export type { ProPerk };

export interface ProUpsellDialogProps {
  open: boolean;
  /** Dismiss and carry on with whatever the user was doing. */
  onContinue: () => void;
  /** Close button AND backdrop click. Defaults to `onContinue`. Pass this when
   *  `onContinue` has a side effect (creating a room, navigating): dismissing
   *  by accident should never trigger it. */
  onClose?: () => void;
  /** Fired after the free trial is successfully claimed. Premium is already
   *  refreshed by this point, so the caller can close and show the now-unlocked
   *  options rather than continuing past them. */
  onTrialClaimed?: () => void;
  heading?: string;
  subheading?: string;
  perks?: ProPerk[];
  /** Label on the dismiss link at the bottom. */
  continueLabel?: string;
  /**
   * Where "See plans" goes. Omit to open the full checkout inline (lazy-loaded)
   * — pass this when your app has its own plans route instead.
   */
  onSeePlans?: () => void;
}

/**
 * The upsell a non-premium user sees next to a locked perk.
 *
 * Deliberately not a hard paywall — the dismiss action always continues, so
 * closing it costs the user nothing.
 */
export function ProUpsellDialog({
  open,
  onContinue,
  onClose,
  heading = 'Get more from your stream',
  subheading = 'With Pro you also get:',
  perks = DEFAULT_STREAM_PERKS,
  continueLabel = 'Continue without Pro',
  onSeePlans,
  onTrialClaimed,
}: ProUpsellDialogProps) {
  const trial = useProTrial();
  const [showPlans, setShowPlans] = useState(false);

  if (!open) return null;

  const seePlans = () => {
    if (onSeePlans) onSeePlans();
    else setShowPlans(true);
  };

  return createPortal(
    <div className="hh-upsell__overlay" onClick={onClose ?? onContinue}>
      <div
        className={`hh-upsell${showPlans ? ' hh-upsell--wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
      >
        <button className="hh-upsell__close" onClick={onClose ?? onContinue} aria-label="Close">×</button>

        {showPlans ? (
          <Suspense fallback={<div className="hh-upsell__loading">Loading plans…</div>}>
            {/* Open on streaming: this dialog is shown next to the locked
                stream options, so landing on another tab would drop the thread. */}
            <ProPlans initialGroupId="streaming" />
          </Suspense>
        ) : (
          <>
            <h3 className="hh-upsell__title">{heading}</h3>
            <p className="hh-upsell__sub">{subheading}</p>

            <ul className="hh-upsell__perks">
              {perks.map((p) => (
                <li key={p.title} className="hh-upsell__perk">
                  <span className="hh-upsell__perk-icon" aria-hidden="true">{p.icon}</span>
                  <span>
                    <strong>{p.title}</strong>
                    <span className="hh-upsell__perk-body">{p.body}</span>
                  </span>
                </li>
              ))}
            </ul>

            {trial.error && <p className="hh-upsell__error">{trial.error}</p>}

            <div className="hh-upsell__actions">
              {trial.canTrial && (
                <button
                  type="button"
                  className="hh-upsell__btn hh-upsell__btn--trial"
                  onClick={() => { void trial.start().then((ok) => { if (ok) onTrialClaimed?.(); }); }}
                  disabled={trial.pending}
                >
                  {trial.pending ? 'Starting…' : `Try Pro free for ${trial.trialHours}h`}
                </button>
              )}
              <button type="button" className="hh-upsell__btn hh-upsell__btn--plans" onClick={seePlans}>
                See plans
              </button>
            </div>
          </>
        )}

        <button type="button" className="hh-upsell__skip" onClick={onContinue}>
          {continueLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default ProUpsellDialog;
