import { useEffect, useState } from 'react';
import { AudioTrack, useLocalParticipant, useTracks } from '@livekit/components-react';
import { ParticipantEvent, Track } from 'livekit-client';

/** The studio's full program audio — what every ordinary viewer hears. */
const STUDIO_MIX_TRACK = 'studio-mix';
/** The mix-minus track the studio publishes only while a collab guest is on
 *  air: the full program MINUS the guest. Kept in sync with StandaloneStudio. */
const HOST_MONITOR_TRACK = 'host-monitor';

/**
 * Room audio, minus the ingest participants — and mix-minus-aware for guests.
 *
 * A WHIP/OBS ingress joins as a real participant (`obs-ingress-…`), so the
 * default <RoomAudioRenderer/> would play its audio straight to everyone. For
 * a standalone stream that's wrong twice over: the studio already mixes that
 * audio into its published program (so you'd hear it twice), and the raw track
 * ignores the studio's live/standby gate — meaning OBS audio would leak over
 * the "Starting soon" slate.
 *
 * On top of that: when THIS viewer is an on-air collab guest, playing the full
 * studio-mix means hearing their own voice bounced back through the mix, one
 * round-trip late. The studio publishes a second `host-monitor` track (the mix
 * minus the guest) for exactly this case, so an on-air guest plays THAT and
 * skips the studio-mix; everyone else does the opposite. If the monitor hasn't
 * arrived yet (or failed to publish), the guest falls back to the full mix —
 * a moment of echo beats silence.
 */
export interface RoomAudioProps {
  /**
   * STANDALONE streams only. When set, play ONLY the host's composited program
   * tracks (`studio-mix` / `host-monitor`) and nothing else — because in a
   * standalone stream every source (mic, media, shares, OBS, the collab guest)
   * is already mixed into those by the studio. Without this, a viewer also plays
   * the collab guest's RAW mic track directly, so the guest is heard TWICE (raw
   * + composited) and ungated over the standby slate.
   *
   * Leave OFF for a conference room, where raw participant mics ARE the audio.
   */
  programOnly?: boolean;
}

export function RoomAudio({ programOnly = false }: RoomAudioProps) {
  // onlySubscribed:false so we can SEE (and then unsubscribe) tracks we won't
  // play — otherwise autoSubscribe silently pulls the host-monitor and the raw
  // guest mic to every viewer during a collab, a wasted Opus stream each.
  const tracks = useTracks(
    [Track.Source.Microphone, Track.Source.ScreenShareAudio],
    { onlySubscribed: false },
  );
  const { localParticipant } = useLocalParticipant();

  // Am I an on-air collab guest? canPublish flips true the moment the host
  // brings me on. Read it from an explicit permission-change subscription — the
  // same reason CollabRequest does: the field mutates in place and a plain
  // render read can miss it.
  const [onAir, setOnAir] = useState(false);
  useEffect(() => {
    if (!localParticipant) return undefined;
    const sync = () => setOnAir(!!localParticipant.permissions?.canPublish);
    sync();
    localParticipant.on(ParticipantEvent.ParticipantPermissionsChanged, sync);
    return () => { localParticipant.off(ParticipantEvent.ParticipantPermissionsChanged, sync); };
  }, [localParticipant]);

  const monitorPresent = tracks.some(
    (t) => !t.participant.isLocal && t.publication?.trackName === HOST_MONITOR_TRACK,
  );

  // Which tracks this viewer should actually hear.
  const shouldPlay = (t: (typeof tracks)[number]): boolean => {
    if (t.participant.isLocal || t.participant.identity.startsWith('obs-')) return false;
    const name = t.publication?.trackName;
    // The on-air guest hears the monitor; everyone else hears the full mix.
    // Fall back to the full mix if the monitor isn't up yet.
    if (name === HOST_MONITOR_TRACK) return onAir;
    if (name === STUDIO_MIX_TRACK) return !onAir || !monitorPresent;
    // Standalone: never play a raw participant mic (the collab guest is already
    // inside studio-mix). Conference: raw mics ARE the audio.
    return !programOnly;
  };

  // Subscribe only what we'll play; unsubscribe the rest so viewers don't
  // download the host-monitor / raw guest mic they never render. In a
  // conference (programOnly off) everything is wanted, so this is a no-op there.
  useEffect(() => {
    for (const t of tracks) {
      if (t.participant.isLocal) continue;
      const pub = t.publication as { isSubscribed?: boolean; setSubscribed?(v: boolean): void } | undefined;
      if (!pub || typeof pub.setSubscribed !== 'function') continue;
      const want = shouldPlay(t);
      if (pub.isSubscribed !== want) pub.setSubscribed(want);
    }
    // shouldPlay is derived from onAir/monitorPresent/programOnly + tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, onAir, monitorPresent, programOnly]);

  return (
    <>
      {tracks
        .filter((t) => shouldPlay(t) && t.publication?.isSubscribed)
        .map((t) => (
          <AudioTrack key={`${t.participant.identity}-${t.publication?.trackSid}`} trackRef={t} />
        ))}
    </>
  );
}
