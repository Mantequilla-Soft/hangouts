import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalParticipant, useLocalParticipantPermissions } from '@livekit/components-react';

export interface UsePushToTalkOptions {
  /** Keyboard key that triggers PTT. Default: ' ' (spacebar). */
  key?: string;
  /** Must be true to activate. Default: false. */
  enabled?: boolean;
}

export interface UsePushToTalkResult {
  /** True while the mic is being held open by PTT. */
  isActive: boolean;
  /** Spread onto the PTT button element. */
  bind: {
    onMouseDown: () => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
  };
}

export function usePushToTalk({
  key = ' ',
  enabled = false,
}: UsePushToTalkOptions = {}): UsePushToTalkResult {
  const { localParticipant } = useLocalParticipant();
  const permissions = useLocalParticipantPermissions();
  const canPublish = permissions?.canPublish ?? false;

  const [isActive, setIsActive] = useState(false);
  const isActiveRef = useRef(false);
  const wasEnabledRef = useRef(false);

  const activate = useCallback(async () => {
    if (!enabled || !canPublish || isActiveRef.current || !localParticipant) return;
    isActiveRef.current = true;
    wasEnabledRef.current = localParticipant.isMicrophoneEnabled;
    setIsActive(true);
    await localParticipant.setMicrophoneEnabled(true);
  }, [enabled, canPublish, localParticipant]);

  const deactivate = useCallback(async () => {
    if (!isActiveRef.current || !localParticipant) return;
    isActiveRef.current = false;
    setIsActive(false);
    await localParticipant.setMicrophoneEnabled(wasEnabledRef.current);
  }, [localParticipant]);

  // Keep stable refs so the keyboard effect doesn't re-register on every render.
  const activateRef = useRef(activate);
  const deactivateRef = useRef(deactivate);
  useEffect(() => { activateRef.current = activate; }, [activate]);
  useEffect(() => { deactivateRef.current = deactivate; }, [deactivate]);

  // Keyboard shortcut — skips when focus is inside an input/textarea.
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== key || e.repeat || e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      void activateRef.current();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === key) void deactivateRef.current();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      // Release mic if PTT was held when the effect unmounts or enabled flips off.
      if (isActiveRef.current) void deactivateRef.current();
    };
  }, [enabled, key]);

  // Release if host revokes publish permission while PTT is held.
  useEffect(() => {
    if (!canPublish && isActiveRef.current) void deactivateRef.current();
  }, [canPublish, deactivateRef]);

  return {
    isActive,
    bind: {
      onMouseDown: () => void activate(),
      onMouseUp: () => void deactivate(),
      onMouseLeave: () => void deactivate(),
      onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); void activate(); },
      onTouchEnd: (e: React.TouchEvent) => { e.preventDefault(); void deactivate(); },
    },
  };
}
