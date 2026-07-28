import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { ParticipantEvent } from 'livekit-client';
import { useHandRaise } from '../../hooks/useHandRaise.js';
import { useStreamContext } from './StandaloneWatch.js';

export interface CollabRequestProps {
  /** Hide entirely for signed-out viewers — see the note on guests below. */
  canRequest?: boolean;
  /** `rail` = shorts-style action rail; `button` = a normal action button. */
  variant?: 'rail' | 'button';
}

/**
 * "Ask to join the stream" for a viewer, and the camera hand-off once the host
 * says yes.
 *
 * The request itself is just a raised hand on the existing data channel — the
 * host's studio lists them and taps Bring on, which grants publish rights
 * server-side. LiveKit pushes that permission to this already-connected
 * participant, so there is no reconnect and no new token: the moment
 * `canPublish` flips we can turn the camera on.
 *
 * GUESTS ARE EXCLUDED by the caller passing canRequest=false. This puts a real
 * face on someone else's broadcast, and a ban means nothing against an
 * anonymous identity that changes on every reload.
 */
export function CollabRequest({ canRequest = false, variant = 'button' }: CollabRequestProps) {
  const { isGuest, portrait } = useStreamContext();
  const { localParticipant } = useLocalParticipant();
  const { isRaised, raiseHand, lowerHand } = useHandRaise();
  const [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const publishedRef = useRef(false);

  // Read the permission from an EXPLICIT event subscription rather than off
  // `localParticipant.permissions` during render.
  //
  // The host promoting a viewer changes that field in place. Whether the
  // surrounding hook happens to re-render on it is an implementation detail of
  // the components library, and relying on it is the same trap that made
  // useChat lose the first message (a field that updates without a render).
  // Here it is load-bearing: miss the change and the guest is never asked for
  // their camera, which is exactly the symptom. Subscribing to
  // ParticipantPermissionsChanged makes it ours to get right.
  const [canPublish, setCanPublish] = useState(false);
  useEffect(() => {
    if (!localParticipant) return undefined;
    const sync = () => setCanPublish(!!localParticipant.permissions?.canPublish);
    sync();
    localParticipant.on(ParticipantEvent.ParticipantPermissionsChanged, sync);
    return () => { localParticipant.off(ParticipantEvent.ParticipantPermissionsChanged, sync); };
  }, [localParticipant]);

  // Whether we are ACTUALLY publishing — not merely allowed to.
  //
  // The button label keys off this rather than `canPublish`. Leaving stops the
  // camera but the host's grant stays, so a label derived from the permission
  // was stuck on "Leave" forever with no way back on air.
  const [onAir, setOnAir] = useState(false);

  const goOnAir = useCallback(async () => {
    if (!localParticipant) return;
    setPublishing(true);
    try {
      await localParticipant.setCameraEnabled(true);
      await localParticipant.setMicrophoneEnabled(true);
      publishedRef.current = true;
      setOnAir(true);
      setError('');
    } catch (err) {
      publishedRef.current = false;
      setOnAir(false);
      setError(err instanceof Error ? err.message : 'Could not turn on your camera');
    } finally {
      setPublishing(false);
    }
  }, [localParticipant]);

  const leave = useCallback(() => {
    if (!localParticipant) return;
    publishedRef.current = false;
    setOnAir(false);
    void localParticipant.setCameraEnabled(false).catch(() => { /* already gone */ });
    void localParticipant.setMicrophoneEnabled(false).catch(() => { /* already gone */ });
  }, [localParticipant]);

  // Promoted → go on air. Camera and mic are requested HERE rather than at
  // request time on purpose: asking a viewer for their camera before the host
  // has agreed is a permission prompt for something that may never happen.
  useEffect(() => {
    if (!canPublish || publishedRef.current) return;
    void goOnAir();
  }, [canPublish, goOnAir]);

  // Demoted (host removed them, or the stream ended) → stop publishing and
  // release the devices, so the camera light goes out rather than lingering.
  useEffect(() => {
    if (canPublish || !publishedRef.current) return;
    leave();
  }, [canPublish, leave]);

  // Only a MOBILE-hosted stream can accept a guest: the Guests panel that lists
  // raised hands lives in the studio's mobile rail, and the desktop studio has
  // no equivalent. Offering "Join" on a desktop stream would send a request
  // nobody can see and leave the viewer waiting on an answer that can't come.
  if (!canRequest || isGuest || !portrait) return null;

  // Gate on the ACTUAL LiveKit identity, not just the app's `isGuest`.
  //
  // A cold-loaded viewer connects as a guest first, then the session lands and
  // the app upgrades to authed — but `isGuest` (app state) flips to false a beat
  // BEFORE the LiveKit connection actually swaps identity. In that window the
  // localParticipant is still `guest-xxxx`, so a hand raised here would carry
  // the guest identity: the host promotes `guest-xxxx`, and that anonymous name
  // is what shows on the collab feed instead of their Hive name. Hold the button
  // back until the connection is truly on a non-guest identity.
  if (!localParticipant || localParticipant.identity.startsWith('guest-')) return null;

  // Still holding the host's grant but off air — going back on needs no second
  // request, so the button rejoins directly instead of raising a hand again.
  const canRejoin = canPublish && !onAir;
  const label = onAir ? 'Leave' : canRejoin ? 'Go on' : isRaised ? 'Waiting…' : 'Join';
  const title = onAir
    ? 'Stop sharing your camera'
    : canRejoin
      ? 'Turn your camera back on — the host still has you approved'
      : isRaised
        ? 'Waiting for the host to bring you on — tap to cancel'
        : 'Ask the host to bring you on camera';
  const onClick = () => {
    setError('');
    if (onAir) leave();
    else if (canRejoin) void goOnAir();
    else if (isRaised) lowerHand();
    else raiseHand();
  };

  if (variant === 'rail') {
    return (
      <div className="actionItem" onClick={onClick} title={title}>
        <div className={`actionButton${isRaised || onAir ? ' liked' : ''}`}>
          <span className="hh-collab__glyph" aria-hidden="true">{onAir || canRejoin ? '📹' : '✋'}</span>
        </div>
        <span className="actionLabel">{publishing ? '…' : label}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`pv-btn hh-collab__btn${isRaised || onAir ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={publishing}
      title={error || title}
    >
      <span aria-hidden="true">{onAir || canRejoin ? '📹' : '✋'}</span>
      <span>{publishing ? 'Starting…' : label}</span>
    </button>
  );
}
