import type { SVGProps } from 'react';
import { PollHostPanel } from './StreamPolls.js';
import { RaidHostPanel } from './RaidHostPanel.js';

/**
 * The studio's "Live" tab: polls and predictions, then raids. Kept in its own
 * module so the studio only mounts it (one tab on desktop, one sheet on phones).
 */
export interface StudioLiveBattle {
  onAir: boolean;
  /** The other streamer while a battle runs. */
  opponent?: string | null;
  /** Open the battle panel (BattlePanel, a dialog of its own). */
  onOpen: () => void;
}

export function StudioLivePanel({ roomName, battle }: { roomName: string; battle?: StudioLiveBattle }) {
  return (
    <div className="hh-post hh-settings hh-livepanel">
      {battle && (
        <div className="hh-settings__group">
          <div className="hh-settings__title"><span aria-hidden="true">⚔️</span> Live battle</div>
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
      <div className="hh-settings__group">
        <div className="hh-settings__title"><span aria-hidden="true">📊</span> Polls and predictions</div>
        <PollHostPanel roomName={roomName} />
      </div>
      <div className="hh-settings__group">
        <div className="hh-settings__title"><span aria-hidden="true">🚀</span> Raid</div>
        <RaidHostPanel roomName={roomName} />
      </div>
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
