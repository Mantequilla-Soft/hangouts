import type { SVGProps } from 'react';
import { PollHostPanel } from './StreamPolls.js';
import { RaidHostPanel } from './RaidHostPanel.js';

/**
 * The studio's "Live" tab: polls and predictions, then raids. Kept in its own
 * module so the studio only mounts it (one tab on desktop, one sheet on phones).
 */
export function StudioLivePanel({ roomName }: { roomName: string }) {
  return (
    <div className="hh-post hh-settings hh-livepanel">
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
