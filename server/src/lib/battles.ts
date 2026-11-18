import { randomBytes } from 'node:crypto';
import { earnForBattle } from './points.js';
import { AccessToken, type RoomServiceClient } from 'livekit-server-sdk';
import { ParticipantInfo_State } from '@livekit/protocol';
import { config } from '../config.js';
import { roomService } from './livekit.js';
import { mutateRoomMetadata, type RoomMetaRecord } from './roomMeta.js';

/**
 * Live battles (H16): two standalone streams split-screen for a set time, and
 * the boosts each side gets in that window decide the winner. Each side keeps
 * its own boosts; no money moves between the two streams.
 *
 * Where the state lives: the SAME `battle` object is written into the room
 * metadata of BOTH rooms. LiveKit pushes every metadata change to every
 * participant, so both studios and every viewer of both streams get the meter
 * and the countdown live, with no polling and no new collection. It also
 * survives a restart of this server (LiveKit keeps the metadata), which a
 * Map here would not.
 *
 * Phases are derived from timestamps rather than stored, so a battle needs
 * only four writes in its whole life (invite, accept, each boost, the end):
 *   invited                       waiting for the other host (expiresAt)
 *   live, now < startedAt         a short lead-in while both studios link up
 *   live, startedAt..endsAt       counting boosts
 *   live, endsAt..settleAt        the last boosts still arriving from Hive
 *   ended                         winner (or none) and why; clients show the
 *                                 banner for a few seconds, then nothing
 *
 * The split screen itself is drawn in each host's BROWSER studio: each studio
 * joins the other room as a hidden, subscribe-only participant (linkToken
 * below) and puts the other host's picture next to its own. Each side keeps
 * its own viewers and its own recording. Headless (OBS/WHIP) streams have no
 * compositor, so they cannot battle.
 */

export const BATTLE_DURATIONS = [180, 300, 600] as const;
export type BattleDuration = typeof BATTLE_DURATIONS[number];
/** How long an invite waits for an answer. */
export const INVITE_TTL_MS = 60_000;
/** Between Accept and the first counted second: both studios link up. */
export const LEAD_IN_MS = 5_000;
/** After the clock runs out, how long boosts sent in time may still arrive
 *  (a Hive block is 3 s and the listener polls every 3 s). */
export const SETTLE_GRACE_MS = 10_000;
/** How long a host may be gone before the other side may end the battle. */
export const DROP_GRACE_MS = 30_000;
/** Clients show the result for this long after the end. */
export const RESULT_SHOW_MS = 15_000;
/** Identity prefix of the hidden cross-room viewer. `obs-` keeps it out of
 *  every viewer count, the stats sampler and the audio renderer. */
export const LINK_IDENTITY_PREFIX = 'obs-battle-';

export type BattleSideKey = 'a' | 'b';
export type BattleEndReason = 'time' | 'ended' | 'dropped' | 'declined' | 'expired' | 'cancelled';

export interface BattleSide {
  host: string;
  room: string;
  title?: string;
  /** Boosts to this side's stream inside the battle window, in HBD. */
  hbd: number;
  count: number;
}

export interface Battle {
  id: string;
  state: 'invited' | 'live' | 'ended';
  durationSec: BattleDuration;
  /** The host who sent the invite. */
  a: BattleSide;
  /** The host who was invited. */
  b: BattleSide;
  invitedAt: string;
  expiresAt: string;
  startedAt?: string;
  endsAt?: string;
  settleAt?: string;
  endedAt?: string;
  /** null when it ended without a result (early end, a drop, a decline). */
  winner?: BattleSideKey | 'tie' | null;
  endReason?: BattleEndReason;
  endedBy?: string;
}

export class BattleError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function readSide(v: unknown): BattleSide | null {
  const o = asObj(v);
  if (!o || typeof o.host !== 'string' || typeof o.room !== 'string' || !o.host || !o.room) return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  return {
    host: o.host,
    room: o.room,
    ...(typeof o.title === 'string' && o.title ? { title: o.title } : {}),
    hbd: num(o.hbd),
    count: num(o.count),
  };
}

/** The battle in a room's metadata, defensively read. */
export function readBattle(meta: RoomMetaRecord | null | undefined): Battle | null {
  const o = asObj(meta?.battle);
  if (!o || typeof o.id !== 'string') return null;
  if (o.state !== 'invited' && o.state !== 'live' && o.state !== 'ended') return null;
  const a = readSide(o.a);
  const b = readSide(o.b);
  if (!a || !b) return null;
  const durationSec = (BATTLE_DURATIONS as readonly number[]).includes(o.durationSec as number)
    ? o.durationSec as BattleDuration : 300;
  const str = (k: string) => (typeof o[k] === 'string' ? { [k]: o[k] as string } : {});
  return {
    id: o.id,
    state: o.state,
    durationSec,
    a,
    b,
    invitedAt: typeof o.invitedAt === 'string' ? o.invitedAt : new Date(0).toISOString(),
    expiresAt: typeof o.expiresAt === 'string' ? o.expiresAt : new Date(0).toISOString(),
    ...str('startedAt'),
    ...str('endsAt'),
    ...str('settleAt'),
    ...str('endedAt'),
    ...(o.winner === 'a' || o.winner === 'b' || o.winner === 'tie' || o.winner === null ? { winner: o.winner } : {}),
    ...(typeof o.endReason === 'string' ? { endReason: o.endReason as BattleEndReason } : {}),
    ...str('endedBy'),
  };
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** Does this battle still hold both rooms (a live battle or an open invite)? */
export function battleBusy(b: Battle | null, now: number = Date.now()): boolean {
  if (!b) return false;
  if (b.state === 'live') return true;
  return b.state === 'invited' && now < ms(b.expiresAt);
}

export function sideOf(b: Battle, room: string): BattleSideKey | null {
  if (b.a.room === room) return 'a';
  if (b.b.room === room) return 'b';
  return null;
}

export function sideOfHost(b: Battle, host: string): BattleSideKey | null {
  if (b.a.host === host) return 'a';
  if (b.b.host === host) return 'b';
  return null;
}

export const other = (s: BattleSideKey): BattleSideKey => (s === 'a' ? 'b' : 'a');

/** Does a boost sent at `atMs` (the Hive block time) count for this battle? */
export function boostCounts(b: Battle, atMs: number): boolean {
  if (b.state !== 'live') return false;
  const start = ms(b.startedAt);
  const end = ms(b.endsAt);
  return Number.isFinite(atMs) && atMs >= start && atMs <= end;
}

export function addBoost(b: Battle, side: BattleSideKey, hbd: number): Battle {
  const s = b[side];
  return { ...b, [side]: { ...s, hbd: round3(s.hbd + Math.max(0, hbd)), count: s.count + 1 } };
}

export function decideWinner(b: Battle): BattleSideKey | 'tie' {
  if (b.a.hbd > b.b.hbd) return 'a';
  if (b.b.hbd > b.a.hbd) return 'b';
  return 'tie';
}

export function endBattle(b: Battle, reason: BattleEndReason, now: number, by?: string): Battle {
  return {
    ...b,
    state: 'ended',
    endedAt: new Date(now).toISOString(),
    endReason: reason,
    winner: reason === 'time' ? decideWinner(b) : null,
    ...(by ? { endedBy: by } : {}),
  };
}

export function startBattle(b: Battle, now: number): Battle {
  const start = now + LEAD_IN_MS;
  const end = start + b.durationSec * 1000;
  return {
    ...b,
    state: 'live',
    startedAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    settleAt: new Date(end + SETTLE_GRACE_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// I/O: everything below reads and writes LiveKit room metadata.

type Lk = Pick<RoomServiceClient, 'listRooms' | 'updateRoomMetadata' | 'listParticipants'>;

/**
 * Battle operations are rare (a handful per battle), so they run one at a
 * time through a single chain. That makes "check both rooms, then write both"
 * safe against two hosts inviting each other in the same second, without a
 * cross-room lock. The per-room metadata lock still guards each write
 * against the room's other writers (heartbeat, boost tally).
 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.catch(() => undefined).then(fn);
  chain = run;
  return run;
}

function parseMeta(raw: string | undefined): RoomMetaRecord {
  try { return JSON.parse(raw || '{}') as RoomMetaRecord; } catch { return {}; }
}

async function readRoom(name: string, lk: Lk): Promise<RoomMetaRecord | null> {
  const rooms = await lk.listRooms([name]);
  return rooms.length ? parseMeta(rooms[0].metadata) : null;
}

/** Write `battle` into one room, only if that room still carries this battle
 *  (or none, or a finished/expired one when `claim`). False if the room is
 *  gone or now holds a different battle. */
async function writeRoom(room: string, battle: Battle, lk: Lk, claim = false): Promise<boolean> {
  let wrote = false;
  try {
    await mutateRoomMetadata(room, (meta) => {
      const current = readBattle(meta);
      const mine = current?.id === battle.id;
      if (!mine && !(claim && !battleBusy(current))) return null;
      wrote = true;
      return { ...meta, battle };
    }, lk);
  } catch {
    return false;
  }
  return wrote;
}

async function writeBoth(battle: Battle, lk: Lk): Promise<void> {
  await Promise.all([writeRoom(battle.a.room, battle, lk), writeRoom(battle.b.room, battle, lk)]);
}

/** Is `host` connected to `room` as the broadcaster (not a ~watch device)?
 *  A room that no longer exists (the stream ended) means no. */
async function hostConnected(room: string, host: string, lk: Lk): Promise<boolean> {
  try {
    if (!await readRoom(room, lk)) return false;
    const parts = await lk.listParticipants(room);
    return parts.some((p) => p.identity === host && p.state !== ParticipantInfo_State.DISCONNECTED);
  } catch {
    // Can't tell: treat as connected, so nobody is ended by a LiveKit hiccup.
    return true;
  }
}

/** Why this room cannot take part in a battle right now, or null. */
export function eligibility(meta: RoomMetaRecord | null, now: number = Date.now()): string | null {
  if (!meta) return 'That stream has ended';
  if (meta.mode !== 'standalone') return 'Battles are for live streams only';
  if (meta.headless === true) return 'Streams sent from OBS cannot battle: the split screen needs the browser studio';
  if (!meta.broadcasting) return 'The stream is not live';
  if (typeof meta.collabGuest === 'string' && meta.collabGuest) return 'The stream has a guest on air';
  if (battleBusy(readBattle(meta), now)) return 'The stream is already in a battle';
  return null;
}

// Timers: one per open invite or running battle, so bounded by the number of
// live streams. After a restart they are gone, and the studios settle the
// battle instead (POST /battles/:room/settle), which is just as safe: the
// result is computed here from the stored tally, never sent by a client.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function schedule(id: string, atMs: number, fn: () => void): void {
  clearTimer(id);
  const t = setTimeout(() => { timers.delete(id); fn(); }, Math.max(0, atMs - Date.now()));
  t.unref?.();
  timers.set(id, t);
}
function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}
export function pendingBattleTimers(): number {
  return timers.size;
}

function roomTitle(meta: RoomMetaRecord): string | undefined {
  const post = asObj(meta.post);
  const t = (typeof post?.title === 'string' && post.title) || (typeof meta.title === 'string' && meta.title) || '';
  return t ? t.slice(0, 120) : undefined;
}

/**
 * Find the opponent's live room: an exact room name, or the live standalone
 * stream of that Hive account (the newest, if they somehow have two).
 */
async function resolveOpponent(target: string, lk: Lk): Promise<{ room: string; meta: RoomMetaRecord } | null> {
  const t = target.trim().replace(/^@/, '').toLowerCase();
  if (!t) return null;
  const rooms = await lk.listRooms();
  const direct = rooms.find((r) => r.name === t);
  if (direct) return { room: direct.name, meta: parseMeta(direct.metadata) };
  const mine = rooms
    .map((r) => ({ room: r.name, meta: parseMeta(r.metadata) }))
    .filter((r) => r.meta.host === t && r.meta.mode === 'standalone' && r.meta.broadcasting)
    .sort((x, y) => String(y.meta.createdAt ?? '').localeCompare(String(x.meta.createdAt ?? '')));
  return mine[0] ?? null;
}

export async function inviteBattle(args: {
  room: string; by: string; opponent: string; durationSec: number; now?: number;
}, lk: Lk = roomService): Promise<Battle> {
  if (!(BATTLE_DURATIONS as readonly number[]).includes(args.durationSec)) {
    throw new BattleError(400, 'bad_duration', 'Pick 3, 5 or 10 minutes');
  }
  return serial(async () => {
    const now = args.now ?? Date.now();
    const mine = await readRoom(args.room, lk);
    if (!mine) throw new BattleError(404, 'not_found', 'Room not found');
    if (mine.host !== args.by) throw new BattleError(403, 'not_host', 'Only the host can start a battle');
    const why = eligibility(mine, now);
    if (why) throw new BattleError(409, 'not_eligible', why);

    const opp = await resolveOpponent(args.opponent, lk);
    if (!opp) throw new BattleError(404, 'no_stream', 'No live stream found for that name');
    if (opp.room === args.room || opp.meta.host === args.by) {
      throw new BattleError(400, 'self', 'You cannot battle your own stream');
    }
    const theirs = eligibility(opp.meta, now);
    if (theirs) throw new BattleError(409, 'opponent_not_eligible', theirs);
    const oppHost = String(opp.meta.host);
    if (!await hostConnected(opp.room, oppHost, lk)) {
      throw new BattleError(409, 'opponent_away', 'That host is not in their studio right now');
    }

    const battle: Battle = {
      id: randomBytes(6).toString('hex'),
      state: 'invited',
      durationSec: args.durationSec as BattleDuration,
      a: { host: args.by, room: args.room, ...(roomTitle(mine) ? { title: roomTitle(mine) } : {}), hbd: 0, count: 0 },
      b: { host: oppHost, room: opp.room, ...(roomTitle(opp.meta) ? { title: roomTitle(opp.meta) } : {}), hbd: 0, count: 0 },
      invitedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    };
    // Claim the opponent first: if they got busy in the meantime nothing is
    // written to our own room.
    if (!await writeRoom(opp.room, battle, lk, true)) {
      throw new BattleError(409, 'opponent_not_eligible', 'The stream is already in a battle');
    }
    if (!await writeRoom(args.room, battle, lk, true)) {
      await writeRoom(opp.room, endBattle(battle, 'cancelled', now), lk);
      throw new BattleError(409, 'not_eligible', 'The stream is already in a battle');
    }
    schedule(battle.id, now + INVITE_TTL_MS, () => { void expireInvite(battle.id, args.room, lk); });
    return battle;
  });
}

async function expireInvite(id: string, room: string, lk: Lk): Promise<void> {
  await serial(async () => {
    const b = readBattle(await readRoom(room, lk).catch(() => null));
    if (!b || b.id !== id || b.state !== 'invited') return;
    await writeBoth(endBattle(b, 'expired', Date.now()), lk);
  }).catch(() => undefined);
}

/** The battle `room` is in, with the caller checked as one of its hosts. */
async function battleFor(room: string, by: string, lk: Lk): Promise<{ battle: Battle; side: BattleSideKey }> {
  const meta = await readRoom(room, lk);
  if (!meta) throw new BattleError(404, 'not_found', 'Room not found');
  const battle = readBattle(meta);
  if (!battle) throw new BattleError(404, 'no_battle', 'This stream is not in a battle');
  const side = sideOf(battle, room);
  if (!side || battle[side].host !== by) throw new BattleError(403, 'not_host', 'Only the host can do this');
  return { battle, side };
}

export async function respondBattle(args: {
  room: string; by: string; accept: boolean; now?: number;
}, lk: Lk = roomService): Promise<Battle> {
  return serial(async () => {
    const now = args.now ?? Date.now();
    const { battle, side } = await battleFor(args.room, args.by, lk);
    if (side !== 'b') throw new BattleError(403, 'not_invited', 'Only the invited host can answer');
    if (battle.state !== 'invited' || now >= ms(battle.expiresAt)) {
      throw new BattleError(409, 'expired', 'This invite is no longer open');
    }
    if (!args.accept) {
      const ended = endBattle(battle, 'declined', now, args.by);
      clearTimer(battle.id);
      await writeBoth(ended, lk);
      return ended;
    }
    // Both streams still have to be live, browser studios, guest-free, and the
    // challenger still has to carry THIS invite (they may have cancelled).
    const [ma, mb] = await Promise.all([readRoom(battle.a.room, lk), readRoom(battle.b.room, lk)]);
    const stillA = readBattle(ma)?.id === battle.id;
    const strip = (m: RoomMetaRecord | null) => (m ? { ...m, battle: undefined } : null);
    const why = !stillA ? 'The invite was withdrawn' : (eligibility(strip(ma), now) ?? eligibility(strip(mb), now));
    if (why) {
      const ended = endBattle(battle, 'cancelled', now);
      clearTimer(battle.id);
      await writeBoth(ended, lk);
      throw new BattleError(409, 'not_eligible', why);
    }
    const live = startBattle(battle, now);
    await writeBoth(live, lk);
    schedule(battle.id, ms(live.settleAt), () => { void settleBattle({ room: live.a.room }, lk).catch(() => undefined); });
    return live;
  });
}

/**
 * A host ends the battle (or withdraws / declines an invite). Ending a running
 * battle early gives no winner: neither side can lock in a lead by quitting,
 * and nobody loses money either way. Once the clock has run out it is no
 * longer "early": the result stands as counted.
 *
 * `reason: 'dropped'` says the OTHER host has been gone for a while; it is
 * only accepted when LiveKit agrees they are not connected.
 */
export async function endBattleBy(args: {
  room: string; by: string; reason?: 'ended' | 'dropped'; now?: number;
}, lk: Lk = roomService): Promise<Battle> {
  return serial(async () => {
    const now = args.now ?? Date.now();
    const { battle, side } = await battleFor(args.room, args.by, lk);
    if (battle.state === 'ended') return battle;
    let next: Battle;
    if (battle.state === 'invited') {
      next = endBattle(battle, side === 'a' ? 'cancelled' : 'declined', now, args.by);
    } else if (now >= ms(battle.endsAt)) {
      next = endBattle(battle, 'time', now);
    } else if (args.reason === 'dropped') {
      const them = battle[other(side)];
      if (await hostConnected(them.room, them.host, lk)) {
        throw new BattleError(409, 'still_here', 'The other host is still connected');
      }
      next = endBattle(battle, 'dropped', now, them.host);
    } else {
      next = endBattle(battle, 'ended', now, args.by);
    }
    clearTimer(battle.id);
    await writeBoth(next, lk);
    if (next.endReason === 'time') earnForBattle(next.a.host, next.b.host, now);
    return next;
  });
}

/** Close a battle whose clock and grace have run out. Idempotent; `by`, when
 *  given, must be one of its hosts. */
export async function settleBattle(args: { room: string; by?: string; now?: number }, lk: Lk = roomService): Promise<Battle> {
  return serial(async () => {
    const now = args.now ?? Date.now();
    const meta = await readRoom(args.room, lk);
    const battle = readBattle(meta);
    if (!battle) throw new BattleError(404, 'no_battle', 'This stream is not in a battle');
    if (args.by && !sideOfHost(battle, args.by)) throw new BattleError(403, 'not_host', 'Only the hosts can do this');
    if (battle.state !== 'live') return battle;
    if (now < ms(battle.settleAt)) {
      throw new BattleError(409, 'not_yet', 'The battle is still running');
    }
    const ended = endBattle(battle, 'time', now);
    clearTimer(battle.id);
    await writeBoth(ended, lk);
    // Both hosts earn channel points for a battle that ran its full time.
    earnForBattle(ended.a.host, ended.b.host, now);
    return ended;
  });
}

/**
 * A boost arrived for `room`. Called by the boost listener only when the room
 * metadata it already read carries a battle, so streams without one pay
 * nothing for this. `atMs` is the Hive block time of the transfer, so a boost
 * sent in the last second counts even if it is processed after the clock ran
 * out, and one sent after the end never does.
 */
export async function recordBattleBoost(
  room: string,
  boost: { hbd: number; atMs: number },
  lk: Lk = roomService,
): Promise<boolean> {
  return serial(async () => {
    const battle = readBattle(await readRoom(room, lk));
    if (!battle) return false;
    const side = sideOf(battle, room);
    if (!side || !boostCounts(battle, boost.atMs)) return false;
    // Add under each room's own lock from that room's CURRENT battle, so two
    // boosts landing together can't erase each other.
    const bump = async (target: string) => {
      try {
        await mutateRoomMetadata(target, (meta) => {
          const current = readBattle(meta);
          if (!current || current.id !== battle.id || current.state !== 'live') return null;
          return { ...meta, battle: addBoost(current, side, boost.hbd) };
        }, lk);
      } catch { /* that stream is gone: its viewers are too */ }
    };
    await Promise.all([bump(battle.a.room), bump(battle.b.room)]);
    return true;
  });
}

/**
 * A token that lets `by`'s studio watch the OTHER side's stream for the
 * battle: subscribe only, hidden (no one in that room sees an extra
 * participant), no publishing, no data, valid until shortly after the end.
 */
export async function linkToken(args: { room: string; by: string; now?: number }, lk: Lk = roomService): Promise<{
  token: string; room: string; host: string; identity: string;
}> {
  const now = args.now ?? Date.now();
  const { battle, side } = await battleFor(args.room, args.by, lk);
  if (battle.state !== 'live' || now >= ms(battle.settleAt) + RESULT_SHOW_MS) {
    throw new BattleError(409, 'not_live', 'The battle is not running');
  }
  const them = battle[other(side)];
  const identity = `${LINK_IDENTITY_PREFIX}${args.by}`;
  const ttlSec = Math.max(60, Math.ceil((ms(battle.settleAt) - now) / 1000) + 300);
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { identity, ttl: ttlSec });
  at.addGrant({
    roomJoin: true,
    room: them.room,
    canSubscribe: true,
    canPublish: false,
    canPublishData: false,
    hidden: true,
  });
  return { token: await at.toJwt(), room: them.room, host: them.host, identity };
}

export interface BattleCandidate {
  room: string;
  host: string;
  title?: string;
  thumbnail?: string;
}

/**
 * Live browser-studio streams `by` could invite: public or Hive-only, live,
 * no guest, not in a battle. One listRooms (no per-room participant scan;
 * the invite checks the chosen host is really there). Unlisted streams are
 * left out of the list but can still be invited by exact name.
 */
export async function battleCandidates(by: string, lk: Lk = roomService, now: number = Date.now()): Promise<BattleCandidate[]> {
  const rooms = await lk.listRooms();
  const out: BattleCandidate[] = [];
  for (const r of rooms) {
    const meta = parseMeta(r.metadata);
    if (meta.host === by || meta.visibility === 'unlisted') continue;
    if (eligibility(meta, now)) continue;
    const post = asObj(meta.post);
    out.push({
      room: r.name,
      host: String(meta.host ?? ''),
      ...(roomTitle(meta) ? { title: roomTitle(meta) } : {}),
      ...(typeof post?.thumbnail === 'string' && post.thumbnail ? { thumbnail: post.thumbnail } : {}),
    });
    if (out.length >= 30) break;
  }
  return out.filter((c) => c.host);
}

/** The public view of a room's battle (everything in it is public anyway). */
export async function getBattle(room: string, lk: Lk = roomService): Promise<Battle | null> {
  const meta = await readRoom(room, lk);
  if (!meta) throw new BattleError(404, 'not_found', 'Room not found');
  return readBattle(meta);
}
