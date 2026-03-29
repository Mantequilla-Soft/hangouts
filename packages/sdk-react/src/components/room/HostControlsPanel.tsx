import type { ParticipantRole } from '@snapie/hangouts-core';
import { useHostControls } from '../../hooks/useHostControls.js';

export interface HostControlsPanelProps {
  identity: string;
  role: ParticipantRole;
  roomName: string;
  onClose: () => void;
}

export function HostControlsPanel({ identity, role, roomName, onClose }: HostControlsPanelProps) {
  const { promote, demote, kick, pending } = useHostControls(roomName);
  const isPending = pending.has(identity);

  const handleAction = async (action: () => Promise<void>) => {
    await action();
    onClose();
  };

  return (
    <div className="hh-host-panel" onClick={(e) => e.stopPropagation()}>
      {role === 'listener' && (
        <button
          className="hh-host-panel__btn"
          disabled={isPending}
          onClick={() => handleAction(() => promote(identity))}
        >
          Invite to speak
        </button>
      )}
      {(role === 'speaker') && (
        <button
          className="hh-host-panel__btn"
          disabled={isPending}
          onClick={() => handleAction(() => demote(identity))}
        >
          Move to audience
        </button>
      )}
      <button
        className="hh-host-panel__btn hh-host-panel__btn--danger"
        disabled={isPending}
        onClick={() => handleAction(() => kick(identity))}
      >
        Remove
      </button>
    </div>
  );
}
