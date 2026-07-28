import { useCallback, useState } from 'react';
import { useHangoutsContext } from '../context/HangoutsContext.js';

/**
 * Declared HERE rather than imported from @snapie/hangouts-core on purpose.
 * sdk-react is routinely built and installed against an older core than the
 * one in this repo (the linked copy is 0.11.1 while source is 0.13.0), so
 * importing a freshly-added type would break the build for everyone on an
 * older core. Same reason the calls below are feature-detected.
 */
export interface WhipIngressInfo {
  ingressId: string;
  /** Paste this WHOLE url into OBS's WHIP output. */
  whipUrl: string;
  streamKey: string;
  participantIdentity: string;
}

export interface StartWhipIngressOptions {
  /** Re-encode to VP8 instead of forwarding OBS's H.264. Defaults true. */
  transcode?: boolean;
}

/** The core methods we use if present — see the fallback note below. */
type WhipCapableClient = {
  startWhipIngress?: (room: string, o: StartWhipIngressOptions) => Promise<WhipIngressInfo>;
  stopWhipIngress?: (room: string) => Promise<void>;
  getSessionToken?: () => string | null;
};

/**
 * WHIP ingress for a room — the "broadcast from OBS / ffmpeg / a hardware
 * encoder" path, as opposed to the in-browser camera.
 *
 * Mirrors useStreaming's shape (busy/error/start/stop), just inbound instead of
 * outbound.
 *
 * Calls `apiClient.startWhipIngress` when the host app's bundled
 * `@snapie/hangouts-core` is new enough to have it, and falls back to a raw
 * authed fetch when it isn't. That fallback is not paranoia: sdk-react is
 * routinely installed against an older core, and calling a method that doesn't
 * exist yet fails with an inscrutable "is not a function" at the worst moment.
 * Both paths hit the same endpoint, so behaviour is identical either way.
 */
export interface UseWhipIngress {
  info: WhipIngressInfo | null;
  busy: boolean;
  error: string;
  start: (options?: StartWhipIngressOptions) => Promise<WhipIngressInfo | null>;
  stop: () => Promise<void>;
  reset: () => void;
}

export function useWhipIngress(roomName: string | null): UseWhipIngress {
  const { apiClient, apiBaseUrl } = useHangoutsContext();
  const [info, setInfo] = useState<WhipIngressInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const rawRequest = useCallback(async (method: string, body?: unknown) => {
    const token = (apiClient as unknown as WhipCapableClient).getSessionToken?.();
    const res = await fetch(
      `${apiBaseUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomName ?? '')}/ingress`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        // Always send a body on POST: declaring application/json with an EMPTY
        // body makes Fastify's parser fail with "Body cannot be empty".
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      },
    );
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(e.message || `HTTP ${res.status}`);
    }
    return res.json();
  }, [apiBaseUrl, apiClient, roomName]);

  const start = useCallback(async (options?: StartWhipIngressOptions) => {
    if (!roomName) return null;
    setBusy(true);
    setError('');
    try {
      // Transcoding defaults ON — see StartWhipIngressOptions for why an
      // H.264 passthrough ingress is invisible to a large slice of Firefox.
      const transcode = options?.transcode !== false;
      const client = apiClient as unknown as WhipCapableClient;
      const next = typeof client.startWhipIngress === 'function'
        ? await client.startWhipIngress(roomName, { transcode })
        : await rawRequest('POST', { transcode }) as WhipIngressInfo;
      setInfo(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set up OBS ingest');
      return null;
    } finally {
      setBusy(false);
    }
  }, [apiClient, rawRequest, roomName]);

  const stop = useCallback(async () => {
    if (!roomName) return;
    setBusy(true);
    try {
      const client = apiClient as unknown as WhipCapableClient;
      if (typeof client.stopWhipIngress === 'function') await client.stopWhipIngress(roomName);
      else await rawRequest('DELETE');
      setInfo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove OBS ingest');
    } finally {
      setBusy(false);
    }
  }, [apiClient, rawRequest, roomName]);

  const reset = useCallback(() => { setInfo(null); setError(''); }, []);

  return { info, busy, error, start, stop, reset };
}
