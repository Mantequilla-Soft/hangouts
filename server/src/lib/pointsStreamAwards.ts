import { config } from '../config.js';
import { liveStreamOf, type SampleRoom } from './points.js';
import { awardPoints, utcDay, type AwardInput } from './pointsAwards.js';
import { ledgerStore } from './pointsLedger.js';
import { noteLiveWatch } from './pointsQuests.js';

/**
 * Awards that need a whole stream, from the points sampler's minute (lib/points.ts
 * sampleMinute), which already lists every live stream with its people:
 *
 *   collab   both hosts of a collab, once it ran COLLAB_MINUTES
 *   party    the host, once PARTY_VIEWERS signed-in viewers each stayed
 *            PARTY_MINUTES in the stream
 *   peak10   the host's first stream with PEAK_VIEWERS signed-in viewers at once
 *   first    the host's first stream (`first:<user>:stream`), for accounts
 *            whose first stream is on or after POINTS_FIRSTS_SINCE
 *
 * and the minutes of live watching the weekly quest counts. Viewers here are
 * signed-in Hive accounts other than the hosts: anonymous tabs are too easy
 * to open for an award.
 *
 * The counts live in memory: a restart starts a stream's minutes again, which
 * only ever delays an award. Every award goes through awardPoints, so an id
 * pays once whatever the sampler sends.
 */

export const COLLAB_MINUTES = 10;
export const PARTY_VIEWERS = 5;
export const PARTY_MINUTES = 30;
export const PEAK_VIEWERS = 10;

interface RoomState {
  guest: string | null;
  collabMinutes: number;
  collabPaid: boolean;
  viewerMinutes: Map<string, number>;
  partyPaid: boolean;
}

const rooms = new Map<string, RoomState>();
/** Hosts already sent for peak10 / a first stream since the start. */
const peakSent = new Set<string>();
const firstChecked = new Set<string>();

/** A first stream counts only when the account has no stream earnings from
 *  before POINTS_FIRSTS_SINCE (the ledger keeps about a year of them). */
async function firstStreamAward(host: string): Promise<AwardInput | null> {
  const since = Date.parse(config.POINTS_FIRSTS_SINCE);
  const earliest = await ledgerStore().earliest(host, 'stream');
  if (earliest !== null && earliest < since) return null;
  return { id: `first:${host}:stream`, user: host, kind: 'first' };
}

/** One sampler minute: `list` is every room with its people, `rewards` what
 *  that minute paid (its `watch` accounts are the live watchers). */
export async function streamMinute(
  list: SampleRoom[], rewards: Map<string, { kind: 'watch' | 'stream' }>, now = Date.now(),
): Promise<AwardInput[]> {
  const awards: AwardInput[] = [];
  const seen = new Set<string>();
  const day = utcDay(now);
  for (const room of list) {
    const live = room.name ? liveStreamOf(room) : null;
    if (!live || !live.host || !room.name) continue;
    const { host } = live;
    seen.add(room.name);
    let st = rooms.get(room.name);
    if (!st) {
      st = { guest: null, collabMinutes: 0, collabPaid: false, viewerMinutes: new Map(), partyPaid: false };
      rooms.set(room.name, st);
    }

    if (live.onAir && !firstChecked.has(host)) {
      firstChecked.add(host);
      const first = await firstStreamAward(host).catch(() => null);
      if (first) awards.push(first);
    }

    if (live.viewers.length >= PEAK_VIEWERS && !peakSent.has(host)) {
      peakSent.add(host);
      awards.push({ id: `peak10:${host}`, user: host, kind: 'peak10' });
    }

    // A collab: the same guest on air with the host. A new guest starts over.
    if (live.guest && live.guestHere && live.guest !== host) {
      if (st.guest !== live.guest) Object.assign(st, { guest: live.guest, collabMinutes: 0, collabPaid: false });
      st.collabMinutes += 1;
      if (st.collabMinutes >= COLLAB_MINUTES && !st.collabPaid) {
        st.collabPaid = true;
        const [a, b] = [host, live.guest].sort();
        for (const [user, other] of [[a, b], [b, a]]) {
          awards.push({ id: `collab:${day}:${a}+${b}:${user}`, user, kind: 'collab', ref: other });
        }
      }
    }

    // A watch party: minutes per signed-in viewer in this stream.
    for (const v of live.viewers) st.viewerMinutes.set(v, (st.viewerMinutes.get(v) ?? 0) + 1);
    if (!st.partyPaid && [...st.viewerMinutes.values()].filter((n) => n >= PARTY_MINUTES).length >= PARTY_VIEWERS) {
      st.partyPaid = true;
      awards.push({ id: `party:${room.name}:${day}`, user: host, kind: 'party', ref: room.name });
    }
  }
  for (const name of rooms.keys()) if (!seen.has(name)) rooms.delete(name);

  if (awards.length) await awardPoints(awards, now).catch(() => undefined);
  const watching = [...rewards].filter(([, r]) => r.kind === 'watch').map(([u]) => u);
  await noteLiveWatch(watching, now).catch(() => undefined);
  return awards;
}

export function resetStreamAwards(): void {
  rooms.clear();
  peakSent.clear();
  firstChecked.clear();
}
