import { useState, useCallback, useEffect } from 'react';
import { useDataChannel, useRoomContext } from '@livekit/components-react';
import { Track, RoomEvent, type RemoteAudioTrack } from 'livekit-client';

const TOPIC = 'volume';

interface VolumeEvent {
  type: 'volume';
  identity: string;
  volume: number; // 0..1
  timestamp: number;
}

/**
 * Per-participant audio volume sync over LiveKit's reliable data channel.
 *
 * `RemoteAudioTrack.setVolume()` is a *local* knob — it changes only the
 * caller's playback. So if the host slides a speaker quieter, only their
 * own ears benefit; everyone else (and the recording) still gets the
 * track at full volume. We fix that by broadcasting volume changes on a
 * shared topic and having every client (including the headless egress
 * Chromium running the recording template) apply them locally.
 *
 * The hook keeps an authoritative volume map and re-applies it whenever
 * a new audio track is subscribed (so participants who join *after* a
 * volume change still hear the host's mix).
 */
export function useParticipantVolumes(): {
  volumes: Map<string, number>;
  setParticipantVolume: (identity: string, volume: number) => void;
} {
  const room = useRoomContext();
  const [volumes, setVolumes] = useState<Map<string, number>>(new Map());

  // Apply volumes to currently-attached audio tracks.
  const applyVolumes = useCallback((map: Map<string, number>) => {
    map.forEach((vol, identity) => {
      const participant = Array.from(room.remoteParticipants.values()).find(
        (p) => p.identity === identity,
      );
      const track = participant?.getTrackPublication(Track.Source.Microphone)?.track as
        | RemoteAudioTrack
        | undefined;
      track?.setVolume?.(vol);
    });
  }, [room]);

  useEffect(() => {
    applyVolumes(volumes);
  }, [volumes, applyVolumes]);

  // Re-apply when a new audio track shows up (late joiners, mic toggles).
  useEffect(() => {
    const reapply = () => applyVolumes(volumes);
    room.on(RoomEvent.TrackSubscribed, reapply);
    room.on(RoomEvent.ParticipantConnected, reapply);
    return () => {
      room.off(RoomEvent.TrackSubscribed, reapply);
      room.off(RoomEvent.ParticipantConnected, reapply);
    };
  }, [room, applyVolumes, volumes]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const event = JSON.parse(text) as VolumeEvent;
      if (event.type !== 'volume') return;
      setVolumes((prev) => {
        const next = new Map(prev);
        next.set(event.identity, event.volume);
        return next;
      });
    } catch { /* ignore malformed */ }
  }, []);

  const { send } = useDataChannel(TOPIC, onMessage);

  const setParticipantVolume = useCallback((identity: string, volume: number) => {
    const event: VolumeEvent = {
      type: 'volume',
      identity,
      volume,
      timestamp: Date.now(),
    };
    const payload = new TextEncoder().encode(JSON.stringify(event));
    send(payload, { reliable: true });
    setVolumes((prev) => {
      const next = new Map(prev);
      next.set(identity, volume);
      return next;
    });
  }, [send]);

  return { volumes, setParticipantVolume };
}
