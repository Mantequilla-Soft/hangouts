import { useState, type ReactNode, type SVGProps } from 'react';
import { PollHostPanel } from './StreamPolls.js';
import { RaidHostPanel } from './RaidHostPanel.js';
import { StudioSubtabs, type StudioSubtab } from './StudioSubtabs.js';

/**
 * The studio's "Live" tab, in sub-tabs: polls and predictions (first), the
 * live battle, raids. Kept in its own module so the studio only mounts it (one
 * tab on desktop, one sheet on phones).
 */
export interface StudioLiveBattle {
  onAir: boolean;
  /** The other streamer while a battle runs. */
  opponent?: string | null;
  /** Open the battle panel (BattlePanel, a dialog of its own). */
  onOpen: () => void;
}

export type LiveSubtab = 'polls' | 'overlays' | 'battle' | 'raid';

export function StudioLivePanel({ roomName, battle, overlays, initialTab = 'polls' }: {
  roomName: string;
  battle?: StudioLiveBattle;
  /** The overlays panel, as a tab of its own (the phone studio groups the
   *  overlays and the polls behind one button). */
  overlays?: ReactNode;
  /** The sub-tab it opens on (polls by default). */
  initialTab?: LiveSubtab;
}) {
  const [tab, setTab] = useState<LiveSubtab>(initialTab);
  const tabs: StudioSubtab<LiveSubtab>[] = [
    { id: 'polls', label: 'Polls' },
    ...(overlays ? [{ id: 'overlays' as const, label: 'Overlays' }] : []),
    ...(battle ? [{ id: 'battle' as const, label: 'Battle', dot: battle.onAir }] : []),
    { id: 'raid', label: 'Raid' },
  ];
  return (
    <div className="hh-post hh-settings hh-livepanel">
      <StudioSubtabs tabs={tabs} active={tab} onChange={setTab} label="Live" />
      {tab === 'polls' && (
        <div className="hh-settings__group">
          <p className="hh-settings__intro">Ask your viewers something. The poll shows at the top of the chat.</p>
          <PollHostPanel roomName={roomName} />
        </div>
      )}
      {tab === 'overlays' && overlays}
      {tab === 'battle' && battle && (
        <div className="hh-settings__group">
          <p className="hh-settings__intro">
            {battle.onAir
              ? `On air with @${battle.opponent ?? ''}.`
              : 'Challenge another live streamer: split screen for a set time, boosts decide the winner.'}
          </p>
          <button type="button" className={`hh-btn hh-btn--small ${battle.onAir ? 'hh-btn--primary' : 'hh-btn--secondary'}`} onClick={battle.onOpen}>
            {battle.onAir ? 'Open the battle' : 'Start a battle'}
          </button>
        </div>
      )}
      {tab === 'raid' && (
        <div className="hh-settings__group">
          <RaidHostPanel roomName={roomName} />
        </div>
      )}
    </div>
  );
}

/** The rail icon for the Live sheet: a small bar chart, drawn like StudioIcons. */
export const IconLive = (p: SVGProps<SVGSVGElement>) => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <path d="M5 20V11M12 20V5M19 20v-6" />
  </svg>
);
