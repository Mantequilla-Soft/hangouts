import type { ParticipantRole } from '@snapie/hangouts-core';

interface ParticipantLike {
  identity: string;
  permissions?: {
    canPublish?: boolean;
  };
}

export function getParticipantRole(
  participant: ParticipantLike,
  hostIdentity: string | null,
): ParticipantRole {
  if (participant.identity === hostIdentity) return 'host';
  if (participant.permissions?.canPublish) return 'speaker';
  return 'listener';
}
