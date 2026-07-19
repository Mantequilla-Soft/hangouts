import { AudioTrack, useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';

/**
 * Room audio, minus the ingest participants.
 *
 * A WHIP/OBS ingress joins as a real participant (`obs-ingress-…`), so the
 * default <RoomAudioRenderer/> would play its audio straight to everyone. For
 * a standalone stream that's wrong twice over: the studio already mixes that
 * audio into its published program (so you'd hear it twice), and the raw track
 * ignores the studio's live/standby gate — meaning OBS audio would leak over
 * the "Starting soon" slate.
 *
 * Drop-in replacement for <RoomAudioRenderer/>: same behaviour for every real
 * participant, silent for `obs-` tooling identities.
 */
export function RoomAudio() {
  const tracks = useTracks(
    [Track.Source.Microphone, Track.Source.ScreenShareAudio],
    { onlySubscribed: true },
  );

  return (
    <>
      {tracks
        .filter((t) => !t.participant.isLocal && !t.participant.identity.startsWith('obs-'))
        .map((t) => (
          <AudioTrack key={`${t.participant.identity}-${t.publication?.trackSid}`} trackRef={t} />
        ))}
    </>
  );
}
