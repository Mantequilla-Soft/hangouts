import { useCallback, useEffect, useState } from 'react';
import { useDataChannel } from '@livekit/components-react';

/**
 * Live "what the host is looking at" — broadcast over a reliable data
 * channel so the recording (and anyone else who cares) renders the same
 * focused speaker / grid-mode state as the host's screen, without each
 * client having to make its own choice.
 *
 * `layoutMode` is intentionally NOT here — it lives on the room metadata
 * so it survives host transfers and late joiners. This sync only covers
 * the per-host transient bits (which speaker is focused right now,
 * whether the user has clicked Grid to suppress screen-share auto-focus).
 */
const TOPIC = 'view-state';

export interface ViewState {
  type: 'view-state';
  focusedIdentity: string | null;
  suppressScreenAutoFocus: boolean;
  timestamp: number;
}

/**
 * Broadcast the local view state. Call from the host's component only —
 * non-host clients should NOT publish, otherwise the recording would
 * track whichever speaker last clicked something on their own machine.
 */
export function useViewStateBroadcast(state: Omit<ViewState, 'type' | 'timestamp'> | null): void {
  // Stable noop callback so useDataChannel's internal useMemo doesn't
  // re-run setupDataMessageHandler on every render — without this, the
  // hook leaks listeners and the `send` reference churns.
  const noop = useCallback(() => { /* broadcast-only */ }, []);
  const { send } = useDataChannel(TOPIC, noop);

  useEffect(() => {
    if (!state) return;
    const event: ViewState = {
      type: 'view-state',
      focusedIdentity: state.focusedIdentity,
      suppressScreenAutoFocus: state.suppressScreenAutoFocus,
      timestamp: Date.now(),
    };
    const payload = new TextEncoder().encode(JSON.stringify(event));
    send(payload, { reliable: true });
    // Re-broadcast whenever the host's focus state changes.
  }, [state?.focusedIdentity, state?.suppressScreenAutoFocus, send]);
}

/**
 * Subscribe to the host's view-state broadcasts. Returns the most recent
 * state, or null if nothing has arrived yet (caller falls back to its
 * own local logic in that case).
 */
export function useViewStateSubscribe(): ViewState | null {
  const [state, setState] = useState<ViewState | null>(null);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const event = JSON.parse(text) as ViewState;
      if (event.type !== 'view-state') return;
      setState((prev) => {
        if (prev && prev.timestamp > event.timestamp) return prev;
        return event;
      });
    } catch { /* ignore malformed */ }
  }, []);

  useDataChannel(TOPIC, onMessage);

  return state;
}
