import { roomService } from './livekit.js';

/**
 * Serialised read-modify-write of a room's metadata.
 *
 * LiveKit stores room metadata as ONE opaque JSON blob, so every writer has to
 * read the whole thing, change its field, and write the whole thing back. With
 * concurrent writers that is a textbook lost update, and it was losing real
 * data: hitting Start fires three writes in the same tick — the stream post,
 * the go-live stamp, and the broadcasting flag — and whichever wrote last
 * silently erased the other two. `liveAt` vanishing meant chat timecodes had
 * nothing to anchor to and the recorder never learned the stream's orientation.
 *
 * Per-room promise chain: each mutation waits for the previous one to finish
 * before it reads, so its read always sees the prior write. Single-process only
 * — if this server is ever run as multiple instances, this needs to become a
 * Redis lock or a compare-and-set on the metadata itself.
 */
const chains = new Map<string, Promise<unknown>>();

export type RoomMetaRecord = Record<string, unknown>;

export async function mutateRoomMetadata(
  roomName: string,
  mutate: (meta: RoomMetaRecord) => RoomMetaRecord | null | Promise<RoomMetaRecord | null>,
): Promise<RoomMetaRecord> {
  const prev = chains.get(roomName) ?? Promise.resolve();

  const run = prev
    // A failed mutation must not poison every later one on the same room.
    .catch(() => undefined)
    .then(async () => {
      const rooms = await roomService.listRooms([roomName]);
      if (rooms.length === 0) throw new Error('Room not found');

      let meta: RoomMetaRecord = {};
      try { meta = JSON.parse(rooms[0].metadata || '{}') as RoomMetaRecord; } catch { /* treat as empty */ }

      const next = await mutate(meta);
      // `null` means "nothing to change" — used by callers that only needed to
      // inspect the current metadata under the lock.
      if (next === null) return meta;

      await roomService.updateRoomMetadata(roomName, JSON.stringify(next));
      return next;
    });

  chains.set(roomName, run);
  try {
    return await run;
  } finally {
    // Drop the chain once it's the tail, so the map doesn't grow forever.
    if (chains.get(roomName) === run) chains.delete(roomName);
  }
}
