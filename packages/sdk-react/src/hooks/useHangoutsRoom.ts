import { useState, useCallback } from 'react';
import type { Room } from '@hive-hangouts/core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

interface RoomState {
  livekitToken: string | null;
  roomName: string | null;
  roomMeta: Room | null;
  isHost: boolean;
}

export function useHangoutsRoom() {
  const { apiClient, livekitServerUrl } = useHangoutsContext();
  const [state, setState] = useState<RoomState>({
    livekitToken: null,
    roomName: null,
    roomMeta: null,
    isHost: false,
  });
  const [isLoading, setIsLoading] = useState(false);

  const create = useCallback(async (title: string, description?: string) => {
    setIsLoading(true);
    try {
      const { room, token } = await apiClient.createRoom(title, description);
      setState({ livekitToken: token, roomName: room.name, roomMeta: room, isHost: true });
      return room;
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
      });
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);

  const leave = useCallback(() => {
    setState({ livekitToken: null, roomName: null, roomMeta: null, isHost: false });
  }, []);

  const endRoom = useCallback(async () => {
    if (state.roomName) {
      await apiClient.deleteRoom(state.roomName);
      leave();
    }
  }, [apiClient, state.roomName, leave]);

  return {
    ...state,
    livekitServerUrl,
    isLoading,
    create,
    join,
    leave,
    endRoom,
  };
}
