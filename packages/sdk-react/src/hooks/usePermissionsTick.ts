import { useEffect, useState } from 'react';
import { RoomEvent } from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';

/**
 * Subscribes the calling component to room-level permission changes.
 *
 * LiveKit's `useParticipants` / `useLocalParticipant` only react to track and
 * connect events — when a host promotes a listener via the server API, the
 * `permissions.canPublish` field on the participant updates in place but no
 * subscribed observable fires, so React doesn't re-render. SpeakerStage /
 * AudienceSection therefore keep filtering against stale permissions and the
 * promoted user never moves to the speaker section.
 *
 * Calling this hook adds a subscription to `ParticipantPermissionsChanged`
 * that bumps a state tick on every event, forcing a re-render so consumers
 * read the fresh `permissions.canPublish` next pass.
 */
export function usePermissionsTick(): void {
  const room = useRoomContext();
  const [, setTick] = useState(0);
  useEffect(() => {
    const tick = () => setTick((t) => t + 1);
    room.on(RoomEvent.ParticipantPermissionsChanged, tick);
    return () => {
      room.off(RoomEvent.ParticipantPermissionsChanged, tick);
    };
  }, [room]);
}
