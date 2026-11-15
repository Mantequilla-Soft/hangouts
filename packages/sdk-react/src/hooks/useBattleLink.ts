import { useEffect, useRef, useState } from 'react';
import {
  DisconnectReason, Room, RoomEvent, Track, VideoQuality,
  type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication,
} from 'livekit-client';
import { MONITOR_AUDIO_TRACK, PROGRAM_VIDEO_TRACK } from '../lib/battle.js';

export interface BattleLinkGrant {
  token: string;
  /** The other side's room. */
  room: string;
  /** The other side's host identity. */
  host: string;
}

export interface BattleLinkState {
  /** Plays the other host's program (muted, never in the DOM); null until
   *  it has frames. The studio draws from it. */
  video: HTMLVideoElement | null;
  /** The other host's mix-minus (their program audio without us). */
  audio: MediaStreamTrack | null;
  /** Is the other host connected to their room right now? */
  opponentHere: boolean;
  /** Their room was deleted: the stream ended. */
  roomGone: boolean;
  connected: boolean;
  error: string | null;
}

const INITIAL: BattleLinkState = {
  video: null, audio: null, opponentHere: false, roomGone: false, connected: false, error: null,
};

/**
 * The studio's window into the OTHER stream during a battle: a second LiveKit
 * connection, to their room, as a hidden subscribe-only participant (the
 * server's /battles/:room/link token). It subscribes to exactly two tracks of
 * the other host, their program video and their mix-minus monitor audio, and
 * nothing else (autoSubscribe off), so it costs one viewer's worth of SFU
 * forwarding and no transcoding.
 *
 * The audio also plays through a hidden <audio> element: the host hears the
 * other side, the browser's echo canceller gets it as a reference, and
 * Chrome only feeds a remote WebRTC track into WebAudio while an element
 * plays it.
 */
export function useBattleLink(
  enabled: boolean,
  serverUrl: string | undefined,
  fetchGrant: () => Promise<BattleLinkGrant>,
  options: { hear?: boolean } = {},
): BattleLinkState {
  const [state, setState] = useState<BattleLinkState>(INITIAL);
  const fetchRef = useRef(fetchGrant);
  fetchRef.current = fetchGrant;
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const hear = options.hear !== false;

  useEffect(() => {
    if (audioElRef.current) audioElRef.current.muted = !hear;
  }, [hear]);

  useEffect(() => {
    if (!enabled || !serverUrl) { setState(INITIAL); return undefined; }
    let cancelled = false;
    let room: Room | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let host = '';
    const videoEl = typeof document !== 'undefined' ? document.createElement('video') : null;
    if (videoEl) { videoEl.muted = true; videoEl.playsInline = true; videoEl.autoplay = true; }
    const audioEl = typeof document !== 'undefined' ? document.createElement('audio') : null;
    if (audioEl) { audioEl.autoplay = true; audioEl.muted = !hear; }
    audioElRef.current = audioEl;

    const patch = (p: Partial<BattleLinkState>) => { if (!cancelled) setState((s) => ({ ...s, ...p })); };

    const want = (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (participant.identity !== host) return;
      if (pub.kind === Track.Kind.Video && pub.trackName === PROGRAM_VIDEO_TRACK) {
        if (!pub.isSubscribed) pub.setSubscribed(true);
        pub.setVideoQuality(VideoQuality.HIGH);
      } else if (pub.kind === Track.Kind.Audio && pub.trackName === MONITOR_AUDIO_TRACK) {
        if (!pub.isSubscribed) pub.setSubscribed(true);
      }
    };
    const scan = () => {
      if (!room) return;
      const p = [...room.remoteParticipants.values()].find((x) => x.identity === host);
      patch({ opponentHere: !!p });
      if (p) for (const pub of p.trackPublications.values()) want(pub as RemoteTrackPublication, p);
    };

    const onSubscribed = (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (participant.identity !== host) return;
      if (track.kind === Track.Kind.Video && pub.trackName === PROGRAM_VIDEO_TRACK && videoEl) {
        videoEl.srcObject = new MediaStream([track.mediaStreamTrack]);
        void videoEl.play().catch(() => { /* muted autoplay */ });
        patch({ video: videoEl });
      } else if (track.kind === Track.Kind.Audio && pub.trackName === MONITOR_AUDIO_TRACK) {
        if (audioEl) {
          audioEl.srcObject = new MediaStream([track.mediaStreamTrack]);
          void audioEl.play().catch(() => { /* needs a gesture; the studio had one */ });
        }
        patch({ audio: track.mediaStreamTrack });
      }
    };
    const onUnsubscribed = (track: RemoteTrack, pub: RemoteTrackPublication) => {
      if (track.kind === Track.Kind.Video && pub.trackName === PROGRAM_VIDEO_TRACK) patch({ video: null });
      if (track.kind === Track.Kind.Audio && pub.trackName === MONITOR_AUDIO_TRACK) patch({ audio: null });
    };

    const connect = async () => {
      try {
        const grant = await fetchRef.current();
        if (cancelled) return;
        host = grant.host;
        const r = new Room({ adaptiveStream: false, dynacast: false });
        room = r;
        r.on(RoomEvent.TrackPublished, want)
          .on(RoomEvent.TrackSubscribed, onSubscribed)
          .on(RoomEvent.TrackUnsubscribed, onUnsubscribed)
          .on(RoomEvent.ParticipantConnected, scan)
          .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
            if (p.identity === host) patch({ opponentHere: false, video: null, audio: null });
          })
          .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
            if (cancelled || room !== r) return;
            room = null;
            const gone = reason === DisconnectReason.ROOM_DELETED;
            patch({ connected: false, opponentHere: false, video: null, audio: null, roomGone: gone });
            // Anything but the room ending: try again in a moment.
            if (!gone) retry = setTimeout(() => { void connect(); }, 3000);
          });
        await r.connect(serverUrl, grant.token, { autoSubscribe: false });
        if (cancelled) { void r.disconnect(); return; }
        patch({ connected: true, error: null });
        scan();
      } catch (err) {
        patch({ connected: false, error: err instanceof Error ? err.message : 'Could not reach the other stream' });
        if (!cancelled) retry = setTimeout(() => { void connect(); }, 5000);
      }
    };
    void connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      const r = room;
      room = null;
      if (r) void r.disconnect();
      if (videoEl) videoEl.srcObject = null;
      if (audioEl) { audioEl.pause(); audioEl.srcObject = null; }
      audioElRef.current = null;
      setState(INITIAL);
    };
    // `hear` is applied by its own effect; reconnecting for it would drop the feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, serverUrl]);

  return state;
}
