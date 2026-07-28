import { useMemo } from 'react';
import { useRoomInfo, useLocalParticipant } from '@livekit/components-react';

/**
 * Reads the room's moderator list from LiveKit metadata (reactive, like
 * useLiveHost). Moderators are Hive usernames — and an authenticated user's
 * LiveKit identity IS their username — so membership is a plain identity check.
 *
 * `isCurrentUserMod` is false for the host: the host moderates via their own
 * host powers and is never listed. Combine with useLiveHost's isCurrentUserHost
 * for a full "can this person moderate?" answer.
 */
export function useModerators(): {
  moderators: string[];
  isCurrentUserMod: boolean;
} {
  const roomInfo = useRoomInfo();
  const { localParticipant } = useLocalParticipant();

  const moderators = useMemo(() => {
    if (!roomInfo.metadata) return [];
    try {
      const meta = JSON.parse(roomInfo.metadata) as { mods?: unknown };
      if (!Array.isArray(meta.mods)) return [];
      return meta.mods.map((m) => String(m).toLowerCase());
    } catch {
      return [];
    }
  }, [roomInfo.metadata]);

  const isCurrentUserMod = !!localParticipant
    && moderators.includes(localParticipant.identity.toLowerCase());

  return { moderators, isCurrentUserMod };
}
