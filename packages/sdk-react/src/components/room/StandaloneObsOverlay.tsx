import { LiveKitRoom, useTracks, VideoTrack, AudioTrack } from '@livekit/components-react';
import { Track } from 'livekit-client';

// The studio publishes its program feed under these fixed track names
// (StandaloneStudio.tsx): the composited video as 'studio-program' and the FULL
// program audio as 'studio-mix'. 'host-monitor' is the mix-minus for on-air
// guests and must NEVER be played here — it would echo.
const PROGRAM_VIDEO = 'studio-program';
const PROGRAM_AUDIO = 'studio-mix';

function ObsProgram({ hostIdentity }: { hostIdentity: string | null }) {
  const camTracks = useTracks([Track.Source.Camera]);
  const micTracks = useTracks([Track.Source.Microphone]);

  // Guests on stage publish their OWN raw camera, so several Source.Camera
  // tracks can exist. Pick the host's composited program feed by name first,
  // then by host identity, and only then fall back to any remote camera so a
  // mismatch degrades to "shows something" instead of black.
  const remoteCams = camTracks.filter((t) => !t.participant.isLocal);
  const video =
    remoteCams.find((t) => t.publication?.trackName === PROGRAM_VIDEO) ??
    remoteCams.find((t) => t.participant.identity === hostIdentity) ??
    remoteCams[0] ??
    null;

  const audio =
    micTracks
      .filter((t) => !t.participant.isLocal)
      .find((t) => t.publication?.trackName === PROGRAM_AUDIO) ?? null;

  return (
    <>
      {video && (
        <VideoTrack
          trackRef={video}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: 'transparent',
          }}
        />
      )}
      {audio && <AudioTrack trackRef={audio} />}
    </>
  );
}

export interface StandaloneObsOverlayProps {
  /** LiveKit ws URL of the endpoint this stream is on (e.g. wss://livekit.okinoko.io). */
  serverUrl: string;
  /** Read-only `obs-` observer token minted by THAT endpoint's backend. */
  token: string;
  /** The host's participant identity — whose composited program feed to show. */
  hostIdentity?: string | null;
}

/**
 * Chrome-free OBS Browser Source overlay for a standalone stream. Connects as a
 * silent observer and renders ONLY the host's program video + audio on a
 * transparent background — nothing else, so it drops cleanly into OBS.
 *
 * Self-contained (owns its LiveKitRoom, no HangoutsProvider needed) so it can be
 * served from a bare route on ANY origin running the current SDK. This matters
 * because the /obs renderer must match the stream's SDK version AND OpenPods
 * runs multiple endpoints (each with its own LiveKit) — a single shared static
 * renderer can't be assumed. The integrator serves this from their own origin
 * and passes the stream's `serverUrl` + a `silent` observer token.
 */
export function StandaloneObsOverlay({ serverUrl, token, hostIdentity = null }: StandaloneObsOverlayProps) {
  if (!serverUrl || !token) {
    return <div style={{ position: 'fixed', inset: 0, background: 'transparent' }} />;
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'transparent', overflow: 'hidden' }}>
      <LiveKitRoom
        serverUrl={serverUrl}
        token={token}
        connect
        audio={false}
        video={false}
        options={{ adaptiveStream: true, dynacast: true }}
      >
        <ObsProgram hostIdentity={hostIdentity} />
      </LiveKitRoom>
    </div>
  );
}
