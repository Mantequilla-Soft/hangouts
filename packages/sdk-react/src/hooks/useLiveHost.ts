import { useMemo } from 'react';
import { useRoomInfo, useLocalParticipant } from '@livekit/components-react';

/**
 * Reads the *live* host identity from LiveKit room metadata, falling back
 * to a join-time value (e.g. `roomMeta.host`) when metadata is not yet
 * loaded. Returns the host's identity and whether the local participant
 * is currently that host.
 *
 * Derives reactively from `useRoomInfo` so that a host transfer
 * propagates to every consumer the moment the metadata change lands —
 * promoted users gain host UI mid-session without reconnecting, and the
 * old host's host-only affordances disappear.
 */
export function useLiveHost(fallbackHost?: string | null): {
  hostIdentity: string;
  isCurrentUserHost: boolean;
} {
  const roomInfo = useRoomInfo();
  const { localParticipant } = useLocalParticipant();

  const hostIdentity = useMemo(() => {
    if (!roomInfo.metadata) return fallbackHost ?? '';
    try {
      const meta = JSON.parse(roomInfo.metadata) as { host?: string };
      return meta.host ?? fallbackHost ?? '';
    } catch {
      return fallbackHost ?? '';
    }
  }, [roomInfo.metadata, fallbackHost]);

  const isCurrentUserHost =
    !!hostIdentity && localParticipant?.identity === hostIdentity;

  return { hostIdentity, isCurrentUserHost };
}
