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

export function useHangoutsRoom() {
  const { apiClient, livekitServerUrl } = useHangoutsContext();
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
  ) => {
    setIsLoading(true);
    try {
      const response = await apiClient.createRoom(title, description, backgroundImage, visibility);
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
  }, [apiClient]);

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
   * Listener-only entry: anyone with the room URL, signed in or not,
   * can drop in to listen. Server stamps a `guest-*` identity that
   * cannot publish, send chat data, or be promoted to speaker. The
   * UI components (RoomControls, ChatPanel, ...) read `isGuest` and
   * disable the participation surface.
   */
  const listen = useCallback(async (roomName: string) => {
    setIsLoading(true);
    try {
      const [result, rooms] = await Promise.all([
        apiClient.listenAsGuest(roomName),
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

  const setViewState = useCallback(async (view: { focusedIdentity?: string | null; suppressScreenAutoFocus?: boolean; chatOpen?: boolean }) => {
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
