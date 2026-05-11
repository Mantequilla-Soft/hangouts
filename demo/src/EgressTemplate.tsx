import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomInfo,
  useParticipants,
  useTracks,
  useRoomContext,
  useEnsureTrackRef,
  useDataChannel,
  GridLayout,
  VideoTrack,
  isTrackReference,
} from '@livekit/components-react';
import { Track, RoomEvent, type Room, type Participant, type RemoteAudioTrack } from 'livekit-client';
import type { TrackReferenceOrPlaceholder } from '@livekit/components-core';
import EgressHelper from '@livekit/egress-sdk';

const DEFAULT_BG = 'https://hotipfs-3speak-1.b-cdn.net/ipfs/QmdU1V8Eefmv5E77Ct6hNG8A3f9b75dZmVS6ZVvw5ynnrn';

interface RoomMeta {
  recordBg?: string;
  streamBg?: string;
  backgroundImage?: string;
  recordLayout?: 'speaker' | 'grid' | 'single';
  host?: string;
  title?: string;
  description?: string;
  /** Identity of the speaker the host has explicitly focused (the host's
   *  click on a tile). Egress mirrors this so the recording follows. */
  focusedIdentity?: string | null;
  /** Whether the host has clicked the Grid pill while a screen share is
   *  active — suppresses the auto-promotion of the share to focus. */
  suppressScreenAutoFocus?: boolean;
  /** Whether the chat sidebar is open in the host's view. When false,
   *  the egress hides its chat panel and the stage expands into the
   *  freed-up horizontal space. Defaults to true (chat shown). */
  chatOpen?: boolean;
}

function useRoomMeta(): RoomMeta {
  const { metadata } = useRoomInfo();
  return useMemo(() => {
    if (!metadata) return {};
    try { return JSON.parse(metadata) as RoomMeta; } catch { return {}; }
  }, [metadata]);
}

/**
 * Bridges the React-managed LiveKit Room to the egress controller.
 *
 * EgressHelper is how a custom RoomComposite template signals to the egress
 * process that recording should begin / end. The egress watches Chrome's
 * console for the magic strings `START_RECORDING` and `END_RECORDING` that
 * EgressHelper.startRecording()/endRecording() print. Without this, the
 * egress just sits forever waiting for a "ready" signal that never comes.
 *
 * We:
 *   1. setRoom() so EgressHelper has the Room instance for layout-change
 *      notifications via room metadata.
 *   2. startRecording() once we're connected — tells the egress "go".
 *   3. endRecording() on disconnect (egress also auto-ends on participant
 *      drop, but we're explicit).
 */
/**
 * Subscribes the egress's headless Chromium to the same volume-change
 * data channel the live room uses. The SDK broadcasts host volume
 * tweaks on a "volume" topic — without this listener, the recording
 * would always capture every speaker at full volume even after the host
 * pulls a slider down.
 */
/**
 * Mirrors the live chat onto the right side of the recording. Subscribes
 * to the same `chat` data-channel topic the SDK's ChatPanel uses, so any
 * message sent in the room shows up in the recorded video.
 *
 * This is a read-only renderer — no input. Always visible in the
 * recording at a fixed width on the right; if you want it conditional
 * on the host having chat expanded, broadcast that state on a separate
 * topic and gate the panel render on it.
 */
interface RecordChatMessage {
  id: string;
  identity: string;
  text: string;
}

function ChatRail() {
  // Mirror the host's chat-open state from room metadata. When the host
  // collapses the chat in the live view, we hide the rail in the
  // recording too so the speakers can use the freed space.
  const meta = useRoomMeta();
  const chatOpen = meta.chatOpen !== false;
  const [messages, setMessages] = useState<RecordChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // useDataChannel re-runs setupDataMessageHandler whenever the callback
  // identity changes — without useCallback, every render leaks a fresh
  // listener and stale ones can drop incoming messages. Memoize.
  const onChat = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const parsed = JSON.parse(text) as { type?: string; identity?: string; text?: string; timestamp?: number };
      if (parsed.type !== 'chat' || !parsed.identity || !parsed.text) return;
      setMessages((prev) => [
        ...prev,
        {
          id: `${parsed.identity}-${parsed.timestamp ?? Date.now()}`,
          identity: parsed.identity!,
          text: parsed.text!,
        },
      ]);
    } catch { /* ignore malformed */ }
  }, []);
  useDataChannel('chat', onChat);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages.length]);

  if (!chatOpen) return null;

  return (
    <div style={{
      position: 'absolute',
      top: 16,
      right: 16,
      bottom: 16,
      width: 280,
      background: 'rgba(20, 20, 30, 0.6)',
      backdropFilter: 'blur(10px) saturate(140%)',
      borderRadius: 12,
      border: '1px solid rgba(255, 255, 255, 0.08)',
      padding: '0.6rem 0.7rem',
      color: '#fff',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.4rem',
      zIndex: 5,
      boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
    }}>
      <div style={{
        fontSize: '0.72rem',
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'rgba(255, 255, 255, 0.78)',
        paddingBottom: '0.3rem',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
      }}>Chat</div>
      <div style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.45rem',
        padding: '0.2rem 0',
      }}>
        {messages.map((m) => (
          <div key={m.id} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.4rem',
          }}>
            <img
              src={`https://images.hive.blog/u/${m.identity}/avatar/small`}
              alt={m.identity}
              style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 2 }}
            />
            <div style={{ minWidth: 0 }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, marginRight: '0.3rem' }}>
                {m.identity}
              </span>
              <span style={{ fontSize: '0.78rem', wordBreak: 'break-word' }}>{m.text}</span>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function VolumeSyncBridge() {
  const room = useRoomContext() as Room;
  const volumesRef = useRef(new Map<string, number>());

  const apply = useCallback((map: Map<string, number>) => {
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

  const onVolume = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const event = JSON.parse(text) as { type: string; identity: string; volume: number };
      if (event.type !== 'volume') return;
      volumesRef.current.set(event.identity, event.volume);
      apply(volumesRef.current);
    } catch { /* ignore */ }
  }, [apply]);
  useDataChannel('volume', onVolume);

  // Re-apply when a late-joining speaker's mic gets subscribed so they
  // start at the host-set level instead of full volume.
  useEffect(() => {
    const reapply = () => apply(volumesRef.current);
    room.on(RoomEvent.TrackSubscribed, reapply);
    room.on(RoomEvent.ParticipantConnected, reapply);
    return () => {
      room.off(RoomEvent.TrackSubscribed, reapply);
      room.off(RoomEvent.ParticipantConnected, reapply);
    };
  }, [room]);

  return null;
}

function EgressBridge() {
  const room = useRoomContext() as Room;
  const startedRef = useRef(false);

  useEffect(() => {
    if (!room) return;
    // We deliberately DON'T call EgressHelper.setRoom(room) — it auto-registers
    // endRecording on the Room's Disconnected event, which triggers an
    // immediate END_RECORDING signal during any transient disconnect (e.g.
    // React StrictMode dev double-mount or component remount on metadata
    // change). The egress controller ends recording cleanly via the
    // /record/stop API or when all real participants leave the room.
    if (room.state === 'connected' && !startedRef.current) {
      startedRef.current = true;
      EgressHelper.startRecording();
    }
    const onConnected = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      EgressHelper.startRecording();
    };
    room.on('connected', onConnected);
    return () => {
      room.off('connected', onConnected);
    };
  }, [room]);

  return null;
}

/**
 * Tile that shows the participant's video when published, otherwise their
 * Hive avatar. Used as a child of GridLayout/CarouselLayout (reads the
 * track ref from context) and as the focused element in speaker mode
 * (accepts an explicit trackRef).
 */
// Tile sits on top of the room thumbnail background — the dark fill is
// translucent so the thumbnail still bleeds through the rounded corners.
const TILE_RADIUS = 16;

function HiveAvatarTile({ trackRef }: { trackRef?: TrackReferenceOrPlaceholder }) {
  const ref = useEnsureTrackRef(trackRef);
  const isReal = isTrackReference(ref);
  const isMuted = isReal ? ref.publication.isMuted : true;
  const showVideo = isReal && !isMuted && ref.source === Track.Source.Camera;
  const showScreenShare = isReal && !isMuted && ref.source === Track.Source.ScreenShare;
  const identity = ref.participant.identity;
  const avatarUrl = `https://images.hive.blog/u/${identity}/avatar/large`;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: 'rgba(20,20,20,0.55)',
        overflow: 'hidden',
        borderRadius: TILE_RADIUS,
        boxShadow: '0 4px 24px rgba(0,0,0,0.45)',
      }}
    >
      {showVideo || showScreenShare ? (
        <VideoTrack
          trackRef={ref}
          style={{ width: '100%', height: '100%', objectFit: showScreenShare ? 'contain' : 'cover' }}
        />
      ) : (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <img
            src={avatarUrl}
            alt={identity}
            style={{
              width: '45%',
              maxWidth: 240,
              aspectRatio: '1 / 1',
              borderRadius: '50%',
              objectFit: 'cover',
              boxShadow: '0 6px 32px rgba(0,0,0,0.6)',
              border: '4px solid rgba(255,255,255,0.85)',
            }}
          />
        </div>
      )}
      <div style={{
        position: 'absolute', bottom: 10, left: 10,
        color: '#fff', fontSize: 14, padding: '4px 10px',
        background: 'rgba(0,0,0,0.55)', borderRadius: 6,
        pointerEvents: 'none',
        backdropFilter: 'blur(4px)',
      }}>
        @{identity}
      </div>
    </div>
  );
}

function BackgroundView({ url }: { url: string }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: `url(${url})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundColor: '#000',
      }}
    />
  );
}

// Wrap a layout so the thumbnail shows behind it and frames it with padding.
const STAGE_PADDING = 32;
// Chat rail width when the chat panel is visible.
const CHAT_RAIL_W = 280;
// Reserved gutter when the chat is on (panel + breathing room).
const CHAT_RAIL_RESERVED = CHAT_RAIL_W + 32; // 16 gap each side.
function Stage({ bgUrl, children, chatOpen }: { bgUrl: string; children: ReactNode; chatOpen: boolean }) {
  // Reserve right-side room for the chat panel only when the host has
  // the chat expanded. Otherwise the focus area (or the speakers rail
  // when chat is collapsed) takes the freed pixels.
  const rightPad = chatOpen ? CHAT_RAIL_RESERVED : STAGE_PADDING;
  return (
    <>
      <BackgroundView url={bgUrl} />
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          paddingTop: STAGE_PADDING,
          paddingLeft: STAGE_PADDING,
          paddingRight: rightPad,
          paddingBottom: STAGE_PADDING,
          boxSizing: 'border-box',
          // Subtle dark veil so brightly-colored thumbnails don't fight tiles.
          background: 'rgba(0,0,0,0.25)',
          // Force a flex column so children with width:100%/height:100%
          // size against the stage's content box reliably (independent
          // of the children's own positioning quirks).
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </>
  );
}

/** Build a synthetic placeholder track-ref so HiveAvatarTile can render
 *  an avatar for a speaker who hasn't published a camera track. */
function placeholderRef(participant: Participant): TrackReferenceOrPlaceholder {
  return { participant, source: Track.Source.Camera };
}

function RecordingHeader({ title, description }: { title?: string; description?: string }) {
  if (!title && !description) return null;
  return (
    <div style={{
      flex: '0 0 auto',
      paddingBottom: 12,
      pointerEvents: 'none',
      width: '100%',
    }}>
      {title && (
        <div style={{
          color: '#fff',
          fontWeight: 800,
          fontSize: 28,
          lineHeight: 1.15,
          textShadow: '0 2px 8px rgba(0,0,0,0.75), 0 1px 2px rgba(0,0,0,0.9)',
        }}>
          {title}
        </div>
      )}
      {description && (
        <div style={{
          color: 'rgba(255,255,255,0.92)',
          fontWeight: 500,
          fontSize: 16,
          marginTop: 4,
          textShadow: '0 1px 4px rgba(0,0,0,0.7)',
          maxWidth: '70%',
          lineHeight: 1.3,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        } as CSSProperties}>
          {description}
        </div>
      )}
    </div>
  );
}

function FocusedTile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  // Fill the entire focus area — removed the 16:9 aspect constraint so
  // the focused video uses every pixel of horizontal space available.
  // The video element inside uses object-fit (cover for camera,
  // contain for screen share) to handle aspect mismatches without
  // leaving large empty bars around the tile.
  return (
    <div style={{
      position: 'relative',
      flex: 1,
      minHeight: 0,
      minWidth: 0,
    }}>
      <HiveAvatarTile trackRef={trackRef} />
    </div>
  );
}

function RailCell({ trackRef, horizontal = true }: { trackRef: TrackReferenceOrPlaceholder; horizontal?: boolean }) {
  return (
    <div style={{
      // Horizontal row → tile sizes by height, width auto from 16:9.
      // Vertical column → tile sizes by width, height auto from 16:9.
      ...(horizontal ? { height: '100%', width: 'auto' } : { width: '100%', height: 'auto' }),
      aspectRatio: '16 / 9',
      position: 'relative',
      borderRadius: 10,
      overflow: 'hidden',
      flex: '0 0 auto',
    }}>
      <HiveAvatarTile trackRef={trackRef} />
    </div>
  );
}

function CompositeView({ roomName }: { roomName: string }) {
  void roomName;
  const meta = useRoomMeta();
  const layout = meta.recordLayout ?? 'grid';
  const bgUrl = meta.recordBg ?? meta.streamBg ?? meta.backgroundImage ?? DEFAULT_BG;

  // Host's transient view-state lives in room metadata so the egress
  // can pick it up reliably via useRoomInfo (data-channel broadcasts
  // didn't surface in the egress's RoomComposite client). meta is
  // recomputed on every metadata change → CompositeView re-renders.
  const hostView = {
    focusedIdentity: meta.focusedIdentity ?? null,
    suppressScreenAutoFocus: !!meta.suppressScreenAutoFocus,
  };
  // Chat open defaults to true unless the host has explicitly hidden it.
  const chatOpen = meta.chatOpen !== false;

  // All speakers in the room (canPublish), regardless of whether they
  // currently have a camera track. Speakers without video render the
  // avatar placeholder instead of being missing from the recording.
  const participants = useParticipants();
  const speakers = participants.filter((p) => p.permissions?.canPublish);

  // Camera + screenshare tracks. We deliberately *don't* set
  // `onlySubscribed: true` here — when the egress is the only viewer in
  // a fresh room, that flag can return an empty list until a second
  // participant joins and triggers the auto-subscribe path (a known
  // quirk that surfaced as "host webcam doesn't appear in the recording
  // until someone else joins"). VideoTrack handles unsubscribed
  // publications gracefully.
  const cameraTracks = useTracks([Track.Source.Camera]);
  const screenShareTracks = useTracks([Track.Source.ScreenShare]);
  const screenShare = screenShareTracks[0] ?? null;

  // For every speaker, prefer their real camera track when present;
  // otherwise fall back to a placeholder so HiveAvatarTile shows the
  // Hive avatar.
  const speakerRefs: TrackReferenceOrPlaceholder[] = speakers.map((p) => {
    const cam = cameraTracks.find((t) => t.participant.identity === p.identity);
    return cam ?? placeholderRef(p);
  });

  // Nothing to render at all → just the room thumbnail full-screen.
  if (speakerRefs.length === 0 && !screenShare) return <BackgroundView url={bgUrl} />;

  // Resolve focus the same way the live SpeakerStage does:
  //   1. If the host has explicitly focused someone, use that.
  //   2. Else, screen share auto-focuses (unless the host clicked Grid).
  //   3. Else, fall back to the host's own tile (so recordings have a
  //      sane default before anyone clicks).
  const explicitFocus = hostView.focusedIdentity
    ? speakerRefs.find((r) => r.participant.identity === hostView.focusedIdentity)
    : null;
  const screenIsPrimary = !!screenShare && !hostView.suppressScreenAutoFocus && !explicitFocus;
  const fallbackHost = !explicitFocus && !screenIsPrimary && meta.host
    ? speakerRefs.find((r) => r.participant.identity === meta.host)
    : null;
  const focused = explicitFocus ?? (screenIsPrimary ? screenShare! : (fallbackHost ?? speakerRefs[0]));

  if (layout === 'single' || (speakerRefs.length <= 1 && !screenShare)) {
    return (
      <Stage bgUrl={bgUrl} chatOpen={chatOpen}>
        <RecordingHeader title={meta.title} description={meta.description} />
        <FocusedTile trackRef={focused} />
      </Stage>
    );
  }

  // Grid mode mirrors the live view: speakers in a tile grid, screen
  // share (if any) NOT a grid cell — it's a small thumbnail at the
  // bottom-right just like the room.
  if (layout === 'grid' && !explicitFocus && !screenIsPrimary) {
    return (
      <Stage bgUrl={bgUrl} chatOpen={chatOpen}>
        <RecordingHeader title={meta.title} description={meta.description} />
        <div style={{ flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box' }}>
          <GridLayout tracks={speakerRefs} style={{ width: '100%', height: '100%' }}>
            <HiveAvatarTile />
          </GridLayout>
        </div>
        {screenShare && (
          <div style={{
            position: 'absolute',
            bottom: 16,
            right: CHAT_RAIL_RESERVED + 16 - STAGE_PADDING,
            width: 240,
            aspectRatio: '16 / 9',
            borderRadius: 10,
            overflow: 'hidden',
            background: '#000',
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.55)',
          }}>
            <HiveAvatarTile trackRef={screenShare} />
          </div>
        )}
      </Stage>
    );
  }

  // 'speaker' (or anything with a focused element) — big focused tile
  // on top, horizontal rail of small tiles below. Mirrors the live
  // SpeakerStage: the rail tiles keep their 16:9 aspect (no narrow
  // full-vertical strips) and stay below the focus area, never
  // alongside it. Screen share, when not primary, joins the rail.
  const others: TrackReferenceOrPlaceholder[] = speakerRefs.filter(
    (r) => r.participant.identity !== focused.participant.identity || r.source !== focused.source,
  );
  const railTracks = screenShare && screenShare !== focused
    ? [screenShare, ...others]
    : others;
  // When chat is collapsed, drop the rail to the right (column) like
  // the live SpeakerStage's --row mode. When chat is expanded, the
  // rail goes below the focus tile (horizontal row).
  const railOnRight = !chatOpen && railTracks.length > 0;
  return (
    <Stage bgUrl={bgUrl} chatOpen={chatOpen}>
      <RecordingHeader title={meta.title} description={meta.description} />
      <div style={{
        width: '100%',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: railOnRight ? 'row' : 'column',
        gap: 12,
        boxSizing: 'border-box',
      }}>
        <FocusedTile trackRef={focused} />
        {railTracks.length > 0 && (
          <div style={{
            display: 'flex',
            flexDirection: railOnRight ? 'column' : 'row',
            gap: 8,
            flex: '0 0 auto',
            justifyContent: railOnRight ? 'flex-start' : 'center',
            alignItems: 'stretch',
            ...(railOnRight ? { width: 200, height: '100%' } : { height: 140, width: '100%' }),
          }}>
            {railTracks.map((track, i) => (
              <RailCell
                key={`${track.participant.identity}:${track.source}:${i}`}
                trackRef={track}
                horizontal={!railOnRight}
              />
            ))}
          </div>
        )}
      </div>
    </Stage>
  );
}

/**
 * LiveKit's grid/focus/carousel components rely on CSS shipped in
 * `@livekit/components-styles` — which we don't bundle. Without it,
 * `<GridLayout>`/`<FocusLayoutContainer>`/`<CarouselLayout>` render plain
 * <div>s with no display:grid|flex, so multiple speakers stack as block
 * elements (one column) instead of side-by-side. Inject just the rules
 * we use so the egress browser lays things out correctly.
 */
const LK_LAYOUT_STYLES = `
  .lk-grid-layout {
    display: grid;
    width: 100%;
    height: 100%;
    gap: 12px;
    grid-template-columns: repeat(var(--lk-col-count, 1), 1fr);
    grid-template-rows: repeat(var(--lk-row-count, 1), 1fr);
  }
  .lk-focus-layout {
    display: grid;
    width: 100%;
    height: 100%;
    gap: 12px;
    grid-template-columns: 1fr 4fr;
  }
  .lk-carousel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;
  }
  .lk-carousel > * {
    flex: 0 0 auto;
    aspect-ratio: 16 / 9;
    min-height: 0;
  }
`;

export function EgressTemplate() {
  // The egress sets ?url=<wss>&token=<jwt>&room=<name> on the page URL.
  // EgressHelper reads these too — getLiveKitURL/getAccessToken — but we
  // pass them directly to LiveKitRoom for clarity.
  const params = new URLSearchParams(window.location.search);
  const serverUrl = params.get('url') ?? '';
  const token = params.get('token') ?? '';
  const roomName = params.get('room') ?? '';

  if (!serverUrl || !token) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: '#000',
        backgroundImage: `url(${DEFAULT_BG})`,
        backgroundSize: 'cover', backgroundPosition: 'center',
      }} />
    );
  }

  return (
    <LiveKitRoom serverUrl={serverUrl} token={token} connect audio={false} video={false}>
      <style>{LK_LAYOUT_STYLES}</style>
      <RoomAudioRenderer />
      <EgressBridge />
      <VolumeSyncBridge />
      <CompositeView roomName={roomName} />
      <ChatRail />
    </LiveKitRoom>
  );
}
