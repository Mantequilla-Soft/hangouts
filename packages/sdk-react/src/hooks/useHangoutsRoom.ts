import { useState, useCallback } from 'react';
import { HangoutsApiError, type Room, type RoomVisibility, type RoomMode } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';
import { type Delivery, type DeliveryAnswer, type JoinOptions, EMPTY_DELIVERY, deliveryBody, deliveryState } from '../lib/hlsDelivery.js';

interface RoomState {
  livekitToken: string | null;
  roomName: string | null;
  roomMeta: Room | null;
  isHost: boolean;
  isPremium: boolean;
  /** True when the local user joined as an unauthenticated guest
   *  listener — listen-only, no chat, no hand-raise. */
  isGuest: boolean;
  /** How this viewer gets the picture. 'hls' = a big stream (or a poor
   *  connection): the room connection carries chat and presence only, and the
   *  picture plays from `hlsUrl`. */
  delivery: Delivery;
  /** Absolute playlist URL while `delivery` is 'hls'. */
  hlsUrl: string | null;
  /** The server lets this WebRTC viewer ask for HLS on a poor connection. */
  hlsFallback: boolean;
}

export type { Delivery, JoinOptions } from '../lib/hlsDelivery.js';

interface BoostConfigInput {
  enabled: boolean;
  minBoostUsd: number;
  creatorPayoutAccount?: string;
}

export function useHangoutsRoom() {
  const { apiClient, apiBaseUrl, livekitServerUrl, username } = useHangoutsContext();
  const [state, setState] = useState<RoomState>({
    livekitToken: null,
    roomName: null,
    roomMeta: null,
    isHost: false,
    isPremium: false,
    isGuest: false,
    ...EMPTY_DELIVERY,
  });
  const [isLoading, setIsLoading] = useState(false);

  /** POST /join or /listen with a JSON body. Plain fetch, not apiClient, so an
   *  app bundling an older @snapie/hangouts-core still sends `delivery`. */
  const post = useCallback(async (path: string, body: Record<string, unknown>, withAuth: boolean) => {
    const token = withAuth ? apiClient.getSessionToken() : null;
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Same error class apiClient throws, so callers handle both paths alike.
      const err = await res.json().catch(() => undefined) as { message?: string } | undefined;
      throw new HangoutsApiError(res.status, err?.message || res.statusText, err);
    }
    return res.json() as Promise<{ token: string; roomName: string; identity: string; isHost: boolean; isPremium?: boolean } & DeliveryAnswer>;
  }, [apiClient, apiBaseUrl]);

  const create = useCallback(async (
    title: string,
    description?: string,
    backgroundImage?: string,
    visibility?: RoomVisibility,
    language?: string,
    boost?: BoostConfigInput,
    mode?: RoomMode,
    tags?: string[],
  ) => {
    setIsLoading(true);
    try {
      // Use fetch() directly so the full request body (including boost and
      // language) reaches the server regardless of which version of
      // HangoutsApiClient the consuming app has bundled. Routing through the
      // class method risks silently dropping params added after the bundle
      // was compiled — the same issue that caused boost config to disappear.
      const token = apiClient.getSessionToken();
      const res = await fetch(`${apiBaseUrl}/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ title, description, backgroundImage, visibility, language, boost, mode, tags }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string; error?: string; retryAt?: string };
        // `code` + `retryAt` ride along so a caller can say WHY in its own words
        // (a free host's daily stream limit, POST /rooms 429 daily_stream_limit).
        throw Object.assign(new Error(err.message || `Create room failed (${res.status})`), {
          status: res.status, code: err.error, retryAt: err.retryAt,
        });
      }
      const response = await res.json() as { token: string; room: Room; isPremium?: boolean };
      setState({
        livekitToken: response.token,
        roomName: response.room.name,
        roomMeta: response.room,
        isHost: true,
        isPremium: response.isPremium ?? false,
        isGuest: false,
        ...EMPTY_DELIVERY,
      });
      return response.room;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, apiBaseUrl]);

  const join = useCallback(async (roomName: string, opts?: JoinOptions) => {
    setIsLoading(true);
    try {
      // getRoom (not listRooms + find) so unlisted rooms keep their
      // metadata too — mode, background, boost config all ride on it.
      const [result, meta] = await Promise.all([
        (deliveryBody(opts)
          ? post(`/rooms/${encodeURIComponent(roomName)}/join`, deliveryBody(opts)!, true)
          : apiClient.joinRoom(roomName)) as Promise<Awaited<ReturnType<typeof apiClient.joinRoom>> & DeliveryAnswer>,
        apiClient.getRoom(roomName).catch(() => null),
      ]);
      setState({
        livekitToken: result.token,
        roomName: result.roomName,
        roomMeta: meta,
        isHost: result.isHost,
        isPremium: result.isPremium ?? false,
        isGuest: false,
        ...deliveryState(apiBaseUrl, result),
      });
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, apiBaseUrl, post]);

  /**
   * Guest entry: anyone with the room URL can join to listen, raise hand,
   * and chat. Guests can be promoted to speaker by the host.
   *
   * @param displayName - Name shown to other participants. 2–32 chars.
   */
  const listen = useCallback(async (roomName: string, displayName?: string, opts?: JoinOptions) => {
    setIsLoading(true);
    try {
      const [result, meta] = await Promise.all([
        (deliveryBody(opts)
          ? post(`/rooms/${encodeURIComponent(roomName)}/listen`,
            { ...(displayName ? { displayName } : {}), ...deliveryBody(opts)! }, true)
          : apiClient.listenAsGuest(roomName, displayName)) as Promise<Awaited<ReturnType<typeof apiClient.listenAsGuest>> & DeliveryAnswer>,
        apiClient.getRoom(roomName).catch(() => null),
      ]);
      setState({
        livekitToken: result.token,
        roomName: result.roomName,
        roomMeta: meta,
        isHost: false,
        isPremium: false,
        // NOT unconditionally true. /listen honours an optional session and
        // hands a signed-in viewer their OWN Hive identity — and viewers of a
        // standalone stream always arrive through listen(), because they are
        // not room participants. Hardcoding `true` marked those real users as
        // anonymous, which hides everything gated on being a known account
        // (asking to join the stream, chatting as yourself).
        isGuest: !username || result.identity !== username,
        ...deliveryState(apiBaseUrl, result),
      });
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, apiBaseUrl, post, username]);

  const leave = useCallback(() => {
    setState({
      livekitToken: null,
      roomName: null,
      roomMeta: null,
      isHost: false,
      isPremium: false,
      isGuest: false,
      ...EMPTY_DELIVERY,
    });
  }, []);

  const endRoom = useCallback(async () => {
    if (state.roomName) {
      await apiClient.deleteRoom(state.roomName);
      leave();
    }
  }, [apiClient, state.roomName, leave]);

  const transferHost = useCallback(async (newHost: string) => {
    if (!state.roomName) return;
    await apiClient.transferHost(state.roomName, newHost);
  }, [apiClient, state.roomName]);

  const setLayout = useCallback(async (layout: 'speaker' | 'grid' | 'single') => {
    if (!state.roomName) return;
    await apiClient.setRoomLayout(state.roomName, layout);
  }, [apiClient, state.roomName]);

  const setViewState = useCallback(async (view: { focusedIdentity?: string | null; suppressScreenAutoFocus?: boolean; chatOpen?: boolean; activeGameId?: string | null }) => {
    if (!state.roomName) return;
    await apiClient.setRoomViewState(state.roomName, view);
  }, [apiClient, state.roomName]);

  return {
    ...state,
    livekitServerUrl,
    isLoading,
    create,
    join,
    listen,
    leave,
    endRoom,
    transferHost,
    setLayout,
    setViewState,
  };
}
