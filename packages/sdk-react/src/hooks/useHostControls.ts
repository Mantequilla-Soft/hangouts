import { useState, useCallback } from 'react';
import { useHangoutsContext } from '../context/HangoutsContext.js';

export function useHostControls(roomName: string | null) {
  const { apiClient } = useHangoutsContext();
  const [pending, setPending] = useState<Set<string>>(new Set());

  const withPending = useCallback(async (identity: string, action: () => Promise<void>) => {
    setPending((prev) => new Set(prev).add(identity));
    try {
      await action();
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(identity);
        return next;
      });
    }
  }, []);

  const promote = useCallback(async (identity: string) => {
    if (!roomName) return;
    await withPending(identity, () => apiClient.setPermissions(roomName, identity, true).then(() => {}));
  }, [apiClient, roomName, withPending]);

  const demote = useCallback(async (identity: string) => {
    if (!roomName) return;
    await withPending(identity, () => apiClient.setPermissions(roomName, identity, false).then(() => {}));
  }, [apiClient, roomName, withPending]);

  const kick = useCallback(async (identity: string) => {
    if (!roomName) return;
    await withPending(identity, () => apiClient.kickParticipant(roomName, identity));
  }, [apiClient, roomName, withPending]);

  const endRoom = useCallback(async () => {
    if (!roomName) return;
    await apiClient.deleteRoom(roomName);
  }, [apiClient, roomName]);

  return { promote, demote, kick, endRoom, pending };
}
