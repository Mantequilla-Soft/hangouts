import { useState, useCallback } from 'react';
import type { Room, RoomVisibility } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

interface RoomState {
  livekitToken: string | null;
  roomName: string | null;
  roomMeta: Room | null;
  isHost: boolean;
  isPremium: boolean;
  /** True when the local user joined as an unauthenticated guest
   *  listener — listen-only, no chat, no hand-raise. */
  isGuest: boolean;
}

interface BoostConfigInput {
  enabled: boolean;
  minBoostUsd: number;
  creatorPayoutAccount?: string;
}

export function useHangoutsRoom() {
  const { apiClient, apiBaseUrl, livekitServerUrl } = useHangoutsContext();
  const [state, setState] = useState<RoomState>({
    livekitToken: null,
    roomName: null,
    roomMeta: null,
    isHost: false,
    isPremium: false,
    isGuest: false,
  });
  const [isLoading, setIsLoading] = useState(false);

  const create = useCallback(async (
    title: string,
    description?: string,
    backgroundImage?: string,
    visibility?: RoomVisibility,
    language?: string,
    boost?: BoostConfigInput,
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
        body: JSON.stringify({ title, description, backgroundImage, visibility, language, boost }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message || `Create room failed (${res.status})`);
      }
      const response = await res.json() as { token: string; room: Room; isPremium?: boolean };
      setState({
        livekitToken: response.token,
        roomName: response.room.name,
        roomMeta: response.room,
        isHost: true,
        isPremium: response.isPremium ?? false,
        isGuest: false,
      });
      return response.room;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, apiBaseUrl]);

  const join = useCallback(async (roomName: string) => {
    setIsLoading(true);
    try {
      const [result, rooms] = await Promise.all([
        apiClient.joinRoom(roomName),
        apiClient.listRooms(),
      ]);
      const meta = rooms.find((r) => r.name === roomName) ?? null;
      setState({
        livekitToken: result.token,
        roomName: result.roomName,
        roomMeta: meta,
        isHost: result.isHost,
        isPremium: result.isPremium ?? false,
        isGuest: false,
      });
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);

  /**
   * Guest entry: anyone with the room URL can join to listen, raise hand,
   * and chat. Guests can be promoted to speaker by the host.
   *
   * @param displayName - Name shown to other participants. 2–32 chars.
   */
  const listen = useCallback(async (roomName: string, displayName?: string) => {
    setIsLoading(true);
    try {
      const [result, rooms] = await Promise.all([
        apiClient.listenAsGuest(roomName, displayName),
        apiClient.listRooms(),
      ]);
      const meta = rooms.find((r) => r.name === roomName) ?? null;
      setState({
        livekitToken: result.token,
        roomName: result.roomName,
        roomMeta: meta,
        isHost: false,
        isPremium: false,
        isGuest: true,
      });
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);

  const leave = useCallback(() => {
    setState({
      livekitToken: null,
      roomName: null,
      roomMeta: null,
      isHost: false,
      isPremium: false,
      isGuest: false,
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
