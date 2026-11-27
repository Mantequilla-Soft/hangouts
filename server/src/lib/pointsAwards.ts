import type { Collection } from 'mongodb';
import { getLiveDb } from './mongoDb.js';
import { applyPointsNow, boostReward, pointsAccount } from './points.js';
import type { PointsKind } from './pointsLedger.js';

/**
 * One-off rewards, the ways to earn 3Speak Points on top of the earnings the
 * server counts itself in lib/points.ts. Each one is paid under an id that
 * pays ONCE (the points-awards collection), so a sender may resend freely.
 *
 * Who sees the action sends it: this server for what happens here (signing
 * in, streams, polls, raids, clips, scheduled events, quests), the checker
 * (POST /points/awards) for what happens on 3Speak (watching, listening,
 * posts, tips, followers...). The amounts and limits are decided HERE, never
 * by the sender: it says who, what kind, which id and, where the amount
 * scales, how many `units`. Every kind is in KINDS below with its id, ref,
 * amount and limits; GET /points/awards/config shows them to the wallet.
 *
 * Nothing for your own content (checked where the id or ref says whose it
 * is), nothing for banned accounts. Each award is a ledger row with the kind
 * and a ref, so the wallet history can say what it was for, and it mints like
 * any other earning (and pays x2 in a double-points window).
 */

export const LOGIN_POINTS = 1;
export const RANK_POINTS = 100;
export const REMIX_POINTS = 100;
export const REMIX_PER_DAY = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const U = '[a-z][a-z0-9.-]{2,15}';
const DAY = '\\d{4}-\\d{2}-\\d{2}';
const WEEK = '\\d{4}-W\\d{2}';
const PERMLINK = '[a-z0-9-]{1,255}';
const ROOM = '[a-z0-9][a-z0-9._-]{0,127}';
const re = (s: string) => new RegExp(`^${s}$`);
const ACCOUNT_RE = re(U);
const POST_RE = re(`${U}/${PERMLINK}`);
const ROOM_RE = re(ROOM);
const author = (post: string) => post.split('/')[0];

interface Ctx {
  user: string;
  /** The id matched against the kind's pattern. */
  m: RegExpExecArray;
  /** The sender's ref, lowercased. */
  ref?: string;
  units?: number;
}
/** The ref to log and what it pays, or why not ('invalid', 'own'). */
type Checked = { ref?: string; amount?: number } | string;

export interface KindSpec {
  /** Who sends it: this server, the checker, or both. */
  from: 'hangouts' | 'checker' | 'both';
  id: RegExp;
  /** What one award pays (before double points). */
  points: number;
  /** Scaled amounts: points per unit (minutes), or per HBD of value. */
  perMinute?: number;
  perHbd?: number;
  /** The most one award pays. */
  max?: number;
  /** Awards of the kind per account per UTC day / ever. */
  perDay?: number;
  ever?: number;
  /** Once per ref per account (a remix: once per source post). */
  oncePerRef?: boolean;
  /** Amounts by milestone (the ref), instead of `points`. */
  tiers?: Record<string, number>;
  check(c: Ctx): Checked;
}

const mine = (c: Ctx, who: string | undefined) => who === c.user;
/** The sender's ref as an account, or null. */
const refAccount = (c: Ctx) => (c.ref && ACCOUNT_RE.test(c.ref) ? c.ref : null);

/** Every kind. The id formats are fixed with the checker and the frontend. */
export const KINDS = {
  // 1 point, the first sign-in of a UTC day (this server sees it).
  login: { from: 'hangouts', id: re(`login:(${U}):(${DAY})`), points: LOGIN_POINTS, check: (c) => (mine(c, c.m[1]) ? {} : 'invalid') },
  // #1 of a main leaderboard board for a calendar month.
  rank: { from: 'checker', id: re('rank:(\\d{4}-(?:0[1-9]|1[0-2]):[a-z_]{2,32})'), points: RANK_POINTS, check: (c) => ({ ref: c.m[1] }) },
  // The maker of a remix or reaction of someone else's post; ref = the source.
  remix: {
    from: 'checker', id: re(`remix:(${U})/${PERMLINK}`), points: REMIX_POINTS, perDay: REMIX_PER_DAY, oncePerRef: true,
    check: (c) => {
      if (!c.ref || !POST_RE.test(c.ref) || !mine(c, c.m[1])) return 'invalid';
      return mine(c, author(c.ref)) ? 'own' : { ref: c.ref };
    },
  },
  // Day 7 and day 30 of a run of consecutive UTC sign-in days. The date is
  // the run's first day, so each milestone pays once per run.
  streak: {
    from: 'hangouts', id: re(`streak:(${U}):(${DAY}):(7|30)`), points: 20, tiers: { 7: 20, 30: 100 },
    check: (c) => (mine(c, c.m[1]) ? { ref: c.m[3] } : 'invalid'),
  },
  // Signed in on 5 of the 7 days of an ISO week.
  week5: { from: 'hangouts', id: re(`week5:(${U}):(${WEEK})`), points: 25, check: (c) => (mine(c, c.m[1]) ? {} : 'invalid') },
  // The Hive account's anniversary, once a year; ref = years.
  anniv: {
    from: 'hangouts', id: re(`anniv:(${U}):(\\d{4})`), points: 100,
    check: (c) => (mine(c, c.m[1]) && c.ref && /^[1-9]\d{0,2}$/.test(c.ref) ? { ref: c.ref } : 'invalid'),
  },
  // 5+ minutes of other people's videos watched that UTC day.
  first5: { from: 'checker', id: re(`first5:(${U}):(${DAY})`), points: 10, check: (c) => (mine(c, c.m[1]) ? {} : 'invalid') },
  // Minutes of other people's videos (not live) on a finished UTC day.
  vodtime: { from: 'checker', id: re(`vodtime:(${U}):(${DAY})`), points: 0, perMinute: 2, max: 120, check: (c) => perMinute(c, 2, 120) },
  // A video watched to 90%+; ref = the post.
  finish: {
    from: 'checker', id: re(`finish:(${U}):(${U}/${PERMLINK})`), points: 5, perDay: 10,
    check: (c) => (!mine(c, c.m[1]) ? 'invalid' : mine(c, author(c.m[2])) ? 'own' : { ref: c.m[2] }),
  },
  // Minutes of other people's audio on a finished UTC day.
  listen: { from: 'checker', id: re(`listen:(${U}):(${DAY})`), points: 0, perMinute: 2, max: 120, check: (c) => perMinute(c, 2, 120) },
  // Watching within the first 10 minutes of a premiere.
  premiere: {
    from: 'checker', id: re(`premiere:(${U}):(${U}/${PERMLINK})`), points: 25,
    check: (c) => (!mine(c, c.m[1]) ? 'invalid' : mine(c, author(c.m[2])) ? 'own' : { ref: c.m[2] }),
  },
  // A playlist finished (the checker knows whose it is and checks not own).
  playlist: {
    from: 'checker', id: re(`playlist:(${U}):([A-Za-z0-9_-]{1,64})`), points: 20, perDay: 3,
    check: (c) => (mine(c, c.m[1]) ? { ref: c.m[2] } : 'invalid'),
  },
  // A first video, short, story, podcast (checker) or stream (this server).
  first: {
    from: 'both', id: re(`first:(${U}):(video|short|story|podcast|stream)`), points: 500,
    check: (c) => (mine(c, c.m[1]) ? { ref: c.m[2] } : 'invalid'),
  },
  // A video with REACH_MIN_VIEWERS unique signed-in watchers in 7 days; to its author.
  reach: { from: 'checker', id: re(`reach:((${U})/${PERMLINK})`), points: 100, check: (c) => (mine(c, c.m[2]) ? { ref: c.m[1] } : 'invalid') },
  // A completed 7-day story run (the date of its 7th day).
  storystreak: { from: 'checker', id: re(`storystreak:(${U}):(${DAY})`), points: 50, check: (c) => (mine(c, c.m[1]) ? {} : 'invalid') },
  // An approved Shorts challenge entry; to its author.
  challenge: {
    from: 'checker', id: re(`challenge:(${WEEK}):((${U})/${PERMLINK})`), points: 200,
    check: (c) => (mine(c, c.m[3]) ? { ref: c.m[2] } : 'invalid'),
  },
  // A collab of 10+ minutes, to each host, once per pair per day:
  // collab:<day>:<a>+<b>:<user> with a < b; ref = the other host.
  collab: {
    from: 'hangouts', id: re(`collab:(${DAY}):(${U})\\+(${U}):(${U})`), points: 100,
    check: (c) => {
      const [, , a, b, who] = c.m;
      if (a >= b || !mine(c, who) || (who !== a && who !== b)) return 'invalid';
      return { ref: who === a ? b : a };
    },
  },
  // A scheduled event (here) or premiere (checker) that started on time.
  premheld: { from: 'both', id: re('premheld:([A-Za-z0-9_-]{6,64})'), points: 50, perDay: 2, check: () => ({}) },
  // Clipping someone else's stream; ref = the streamer.
  clip: {
    from: 'hangouts', id: re('clip:([a-f0-9]{6,64})'), points: 10, perDay: 5,
    check: (c) => { const s = refAccount(c); return !s ? 'invalid' : mine(c, s) ? 'own' : { ref: s }; },
  },
  // A tag given to someone else's video; ref = the post.
  tag: {
    from: 'checker', id: re(`tag:(${U}):((${U})/${PERMLINK}):([a-z0-9-]{1,32})`), points: 1, perDay: 20,
    check: (c) => (!mine(c, c.m[1]) ? 'invalid' : mine(c, c.m[3]) ? 'own' : { ref: c.m[2] }),
  },
  // A vote in a stream poll (not in your own room: the poll code checks the
  // host); ref = the room.
  pollvote: {
    from: 'hangouts', id: re(`pollvote:(${ROOM}):(${U})`), points: 5, perDay: 5,
    check: (c) => (mine(c, c.m[2]) && c.ref && ROOM_RE.test(c.ref) ? { ref: c.ref } : 'invalid'),
  },
  // The creator replied to the user's comment on their video; ref = the creator.
  reply: {
    from: 'checker', id: re(`reply:(${U})/${PERMLINK}`), points: 5, perDay: 10,
    check: (c) => { const s = refAccount(c); return !s || !mine(c, c.m[1]) ? 'invalid' : mine(c, s) ? 'own' : { ref: s }; },
  },
  // Joining a Hive community (at most 5 ever).
  community: {
    from: 'checker', id: re(`community:(${U}):(hive-\\d{1,10})`), points: 10, ever: 5,
    check: (c) => (mine(c, c.m[1]) ? { ref: c.m[2] } : 'invalid'),
  },
  // A tip (Lightning or HBD) to a creator; units = its value in milli-HBD.
  tip: {
    from: 'checker', id: re('tip:([A-Za-z0-9_.-]{6,128})'), points: 100, perHbd: 100, max: 2000,
    check: (c) => {
      const s = refAccount(c);
      if (!s || !c.units || c.units < 1) return 'invalid';
      return mine(c, s) ? 'own' : { ref: s, amount: boostReward(c.units / 1000) };
    },
  },
  // Someone else remixed the user's post: to the ORIGINAL creator, once per
  // derived post; ref = the source post.
  remixed: {
    from: 'checker', id: re(`remixed:((${U})/${PERMLINK})`), points: 50,
    check: (c) => {
      if (!c.ref || !POST_RE.test(c.ref) || !mine(c, author(c.ref))) return 'invalid';
      return mine(c, c.m[2]) ? 'own' : { ref: c.ref };
    },
  },
  // Being raided (when the raid paid the raider); ref = the raider.
  raided: {
    from: 'hangouts', id: re('raided:([a-z0-9]{6,32})'), points: 100,
    check: (c) => { const s = refAccount(c); return !s ? 'invalid' : mine(c, s) ? 'own' : { ref: s }; },
  },
  // Follower milestones crossed from the launch on.
  followers: {
    from: 'checker', id: re(`followers:(${U}):(10|100|1000)`), points: 100, tiers: { 10: 100, 100: 500, 1000: 2000 },
    check: (c) => (mine(c, c.m[1]) ? { ref: c.m[2] } : 'invalid'),
  },
  // The first stream with 10+ signed-in viewers at once (not the host).
  peak10: { from: 'hangouts', id: re(`peak10:(${U})`), points: 200, check: (c) => (mine(c, c.m[1]) ? {} : 'invalid') },
  // An invitee published their first video: referral:<invitee> pays the
  // referrer 1,000 (ref the invitee), invited:<invitee> the invitee 250 (ref
  // the referrer). Both arrive as kind `referral`; the invitee's ledger row
  // is kind `invited`.
  referral: {
    from: 'checker', id: re(`(referral|invited):(${U})`), points: 1000, tiers: { referral: 1000, invited: 250 },
    check: (c) => {
      const [, side, invitee] = c.m;
      if (side === 'referral') return mine(c, invitee) ? 'own' : { ref: invitee, amount: 1000 };
      const referrer = refAccount(c);
      if (!mine(c, invitee) || !referrer) return 'invalid';
      return mine(c, referrer) ? 'own' : { ref: referrer, amount: 250 };
    },
  },
  // Installing the app. CLIENT-CLAIMED (the one exception): the installed app
  // calls POST /points/pwa, which cannot prove it is installed. Once ever, 50.
  pwa: { from: 'hangouts', id: re(`pwa:(${U})`), points: 50, check: (c) => (mine(c, c.m[1]) ? {} : 'invalid') },
  // A watch party: 5+ signed-in viewers each stayed 30+ minutes; to the host.
  party: { from: 'hangouts', id: re(`party:(${ROOM}):(${DAY})`), points: 200, check: (c) => ({ ref: c.m[1] }) },
  // A weekly quest done (lib/pointsQuests.ts); ref = the quest.
  quest: {
    from: 'hangouts', id: re(`quest:([a-z0-9]{2,32}):(${WEEK}):(${U})`), points: 300,
    check: (c) => (mine(c, c.m[3]) ? { ref: c.m[1] } : 'invalid'),
  },
} satisfies Record<string, KindSpec>;

export type AwardKind = keyof typeof KINDS & PointsKind;
const SPECS: Record<string, KindSpec> = KINDS;

/** Kinds the checker may send to POST /points/awards. */
export const EXTERNAL_KINDS = (Object.keys(KINDS) as AwardKind[]).filter((k) => KINDS[k].from !== 'hangouts');

function perMinute(c: Ctx, per: number, max: number): Checked {
  if (!mine(c, c.m[1]) || !c.units || c.units < 1) return 'invalid';
  return { amount: Math.min(max, per * c.units) };
}

/** The checker's threshold for `reach` (its REACH_MIN_VIEWERS default), shown
 *  in the wallet only: the checker decides it. */
export const REACH_MIN_VIEWERS_SHOWN = 20;

export interface KindConfig {
  amount?: number;
  /** Points per unit (minute) and the most a day pays. */
  perUnit?: number;
  maxPerDay?: number;
  /** Awards per day / ever. */
  perDay?: number;
  maxEver?: number;
  perHbd?: number;
  max?: number;
  minViewers?: number;
  /** Amounts by milestone. */
  amounts?: Record<string, number>;
}

/** What each kind is worth, for GET /points/awards/config: a number when it
 *  is just an amount, else its amounts and limits (the shape the wallet reads). */
export function awardsConfig(): Record<string, number | KindConfig> {
  const out: Record<string, number | KindConfig> = {};
  for (const [kind, s] of Object.entries(SPECS)) {
    const c: KindConfig = {};
    if (s.tiers) c.amounts = { ...s.tiers };
    else if (s.perMinute !== undefined) Object.assign(c, { perUnit: s.perMinute, maxPerDay: s.max });
    else c.amount = s.points;
    if (s.perHbd !== undefined) Object.assign(c, { perHbd: s.perHbd, max: s.max });
    if (s.perDay !== undefined) c.perDay = s.perDay;
    if (s.ever !== undefined) c.maxEver = s.ever;
    if (kind === 'reach') c.minViewers = REACH_MIN_VIEWERS_SHOWN;
    const keys = Object.keys(c);
    out[kind] = keys.length === 1 && keys[0] === 'amount' ? c.amount! : c;
  }
  return out;
}

// ── store ─────────────────────────────────────────────────────────────────

export interface AwardDoc { id: string; user: string; kind: AwardKind; ref?: string; units?: number; amount: number; at: number }

export interface AwardQuery { user: string; kind: AwardKind; since?: number; until?: number; ref?: string }

export interface AwardStore {
  /** False when that id was paid already. */
  insert(a: AwardDoc): Promise<boolean>;
  /** Whether that id was paid already. */
  has(id: string): Promise<boolean>;
  count(q: AwardQuery): Promise<number>;
  /** The total of their `units`. */
  sumUnits(q: AwardQuery): Promise<number>;
  /** Newest first, at most `limit`. */
  list(q: AwardQuery, limit: number): Promise<AwardDoc[]>;
  remove(id: string): Promise<void>;
}

const matches = (a: AwardDoc, q: AwardQuery) => a.user === q.user && a.kind === q.kind
  && (q.since === undefined || a.at >= q.since) && (q.until === undefined || a.at < q.until)
  && (q.ref === undefined || a.ref === q.ref);

export function memoryAwardStore(): AwardStore & { awards: Map<string, AwardDoc> } {
  const awards = new Map<string, AwardDoc>();
  return {
    awards,
    async insert(a) { if (awards.has(a.id)) return false; awards.set(a.id, { ...a }); return true; },
    async has(id) { return awards.has(id); },
    async count(q) { return [...awards.values()].filter((a) => matches(a, q)).length; },
    async sumUnits(q) { return [...awards.values()].filter((a) => matches(a, q)).reduce((n, a) => n + (a.units ?? 0), 0); },
    async list(q, limit) { return [...awards.values()].filter((a) => matches(a, q)).sort((a, b) => b.at - a.at).slice(0, limit); },
    async remove(id) { awards.delete(id); },
  };
}

interface AwardRow extends Omit<AwardDoc, 'at'> { at: Date }
let col: Collection<AwardRow> | null = null;
async function collection(): Promise<Collection<AwardRow> | null> {
  if (col) return col;
  const db = await getLiveDb();
  if (!db) return null;
  const c = db.collection<AwardRow>('points-awards');
  await c.createIndex({ id: 1 }, { unique: true }).catch(() => undefined);
  await c.createIndex({ user: 1, kind: 1, at: -1 }).catch(() => undefined);
  col = c;
  return c;
}

const filterOf = (q: AwardQuery) => ({
  user: q.user, kind: q.kind,
  ...(q.since !== undefined || q.until !== undefined ? {
    at: { ...(q.since !== undefined ? { $gte: new Date(q.since) } : {}), ...(q.until !== undefined ? { $lt: new Date(q.until) } : {}) },
  } : {}),
  ...(q.ref !== undefined ? { ref: q.ref } : {}),
});

const mongoAwards: AwardStore = {
  async insert(a) {
    const c = await collection();
    if (!c) return fallback.insert(a);
    try { await c.insertOne({ ...a, at: new Date(a.at) }); return true; }
    catch (err) { if ((err as { code?: number }).code === 11000) return false; throw err; }
  },
  async has(id) {
    const c = await collection();
    if (!c) return fallback.has(id);
    return (await c.countDocuments({ id }, { limit: 1 })) > 0;
  },
  async count(q) {
    const c = await collection();
    if (!c) return fallback.count(q);
    return c.countDocuments(filterOf(q));
  },
  async sumUnits(q) {
    const c = await collection();
    if (!c) return fallback.sumUnits(q);
    const [r] = await c.aggregate<{ n: number }>([{ $match: filterOf(q) }, { $group: { _id: null, n: { $sum: '$units' } } }]).toArray();
    return r?.n ?? 0;
  },
  async list(q, limit) {
    const c = await collection();
    if (!c) return fallback.list(q, limit);
    const docs = await c.find(filterOf(q), { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
    return docs.map((d) => ({ ...d, at: d.at.getTime() }));
  },
  async remove(id) {
    const c = await collection();
    if (!c) return fallback.remove(id);
    await c.deleteOne({ id });
  },
};

const fallback = memoryAwardStore();
let store: AwardStore = mongoAwards;
export function setAwardStore(next: AwardStore): void { store = next; }
export function awardStore(): AwardStore { return store; }

/** Banned accounts earn nothing. Loaded when first needed (lib/users.ts
 *  connects to Mongo); tests swap it. */
let isBanned: (user: string) => Promise<boolean> = async (user) => (await import('./users.js')).isUserBanned(user);
export function setAwardBanCheck(fn: (user: string) => Promise<boolean>): void { isBanned = fn; }

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export const utcMidnight = (now: number) => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());

/** Monday 00:00 UTC of the ISO week of `now`. */
export function isoWeekStart(now: number): number {
  const midnight = utcMidnight(now);
  return midnight - ((new Date(midnight).getUTCDay() + 6) % 7) * DAY_MS;
}

/** The ISO week of `now`, as `YYYY-Www`. */
export function isoWeek(now: number): string {
  // The week's Thursday decides its year.
  const thursday = isoWeekStart(now) + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export interface AwardInput { id: string; user: string; kind: string; ref?: string; units?: number }
export type AwardOutcome = { id: string; awarded: true; points: number } | { id: string; awarded: false; reason: string };

/** Kinds a weekly quest counts (lib/pointsQuests.ts): a paid one may finish a quest. */
const QUEST_KINDS = new Set<string>(['finish', 'listen', 'pollvote', 'tag']);

/**
 * Pay the awards that are new and within their limits. `external`: they came
 * from the checker (POST /points/awards), which may not send this server's
 * own kinds.
 */
export async function awardPoints(items: AwardInput[], now = Date.now(), { external = false } = {}): Promise<AwardOutcome[]> {
  const out: AwardOutcome[] = [];
  for (const item of items) {
    const kind = item.kind as AwardKind;
    const spec = Object.hasOwn(SPECS, kind) ? SPECS[kind] : undefined;
    const user = pointsAccount(item.user);
    const id = String(item.id ?? '');
    const m = spec?.id.exec(id);
    const fromOk = spec && (!external || spec.from !== 'hangouts')
      // A first stream is this server's to see.
      && !(external && kind === 'first' && m?.[2] === 'stream');
    if (!spec || !m || !fromOk) { out.push({ id, awarded: false, reason: 'invalid' }); continue; }
    if (!user) { out.push({ id, awarded: false, reason: 'account' }); continue; }
    const units = Number.isInteger(item.units) && item.units! >= 0 ? item.units : undefined;
    const checked = spec.check({ user, m, ref: typeof item.ref === 'string' ? item.ref.toLowerCase() : undefined, units });
    if (typeof checked === 'string') { out.push({ id, awarded: false, reason: checked }); continue; }
    const { ref } = checked;
    const amount = checked.amount ?? (spec.tiers && ref !== undefined ? spec.tiers[ref] : undefined) ?? spec.points;
    if (!(amount > 0)) { out.push({ id, awarded: false, reason: 'invalid' }); continue; }
    if (await isBanned(user).catch(() => false)) { out.push({ id, awarded: false, reason: 'banned' }); continue; }
    // Paid already: say so before any limit, which counts that award too.
    if (await store.has(id)) { out.push({ id, awarded: false, reason: 'already' }); continue; }
    if (spec.oncePerRef && ref !== undefined && await store.count({ user, kind, ref }) > 0) { out.push({ id, awarded: false, reason: 'already' }); continue; }
    if (spec.perDay !== undefined && await store.count({ user, kind, since: utcMidnight(now) }) >= spec.perDay) { out.push({ id, awarded: false, reason: 'limit' }); continue; }
    if (spec.ever !== undefined && await store.count({ user, kind }) >= spec.ever) { out.push({ id, awarded: false, reason: 'limit' }); continue; }
    if (!(await store.insert({ id, user, kind, ...(ref ? { ref } : {}), ...(units !== undefined ? { units } : {}), amount, at: now }))) {
      out.push({ id, awarded: false, reason: 'already' });
      continue;
    }
    let paid: number;
    try {
      // Refs that would tell the public chain what someone watched stay in
      // the wallet history only (pointsLog PRIVATE_REF_KINDS).
      // The invitee's side of a referral is its own ledger kind, so the wallet
      // can tell "you invited @x" from "@x invited you".
      const ledgerKind = kind === 'referral' && id.startsWith('invited:') ? 'invited' : kind;
      const applied = await applyPointsNow(new Map([[user, amount]]), ledgerKind, ref, now);
      paid = applied.get(user) ?? amount;
    } catch {
      // Not paid: free the id so the next send tries again.
      await store.remove(id).catch(() => undefined);
      out.push({ id, awarded: false, reason: 'error' });
      continue;
    }
    out.push({ id, awarded: true, points: paid });
    if (QUEST_KINDS.has(kind)) {
      // Loaded here, not at the top: lib/pointsQuests.ts pays through this file.
      await import('./pointsQuests.js').then((q) => q.checkQuests(user, now)).catch(() => undefined);
    }
  }
  return out;
}

// ── signing in ────────────────────────────────────────────────────────────

/** When a Hive account was created (ms), or null. Tests swap it. */
let accountCreated: (user: string) => Promise<number | null> = async (user) => {
  // Loaded when first needed: lib/hive.ts opens a Hive client.
  const { hiveClient } = await import('./hive.js');
  // POST /points/daily waits for it: a slow node only skips it until tomorrow.
  const [acct] = await Promise.race([
    hiveClient.database.getAccounts([user]),
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('timeout')), 5000).unref?.(); }),
  ]);
  // Hive's times are UTC without the zone.
  const at = acct ? Date.parse(`${String(acct.created).replace(/Z?$/, 'Z')}`) : NaN;
  return Number.isFinite(at) ? at : null;
};
export function setAccountCreatedLookup(fn: (user: string) => Promise<number | null>): void { accountCreated = fn; }

/** How far back sign-in days are read for a streak (a run longer than this
 *  has had both its milestones). */
const STREAK_LOOKBACK_DAYS = 40;

/** The day's sign-in point for a signed-in account (once per UTC day), and on
 *  the first sign-in of a day the streak, week and anniversary awards. */
export async function awardDailyLogin(username: string, now = Date.now()): Promise<boolean> {
  const user = pointsAccount(username);
  if (!user) return false;
  const [r] = await awardPoints([{ id: `login:${user}:${utcDay(now)}`, user, kind: 'login' }], now);
  if (r.awarded) await loginMilestones(user, now).catch(() => undefined);
  return r.awarded;
}

async function loginMilestones(user: string, now: number): Promise<void> {
  const today = utcMidnight(now);
  const rows = await store.list({ user, kind: 'login', since: today - (STREAK_LOOKBACK_DAYS - 1) * DAY_MS }, STREAK_LOOKBACK_DAYS + 5);
  // The days from the ids (the day signed in, whenever the row was written).
  const days = new Set(rows.map((a) => a.id.slice(a.id.lastIndexOf(':') + 1)));
  const awards: AwardInput[] = [];

  // The run of consecutive days up to today. Only when its first day is in
  // view, or a long run would look like a new one at the edge.
  let run = 0;
  while (run < STREAK_LOOKBACK_DAYS && days.has(utcDay(today - run * DAY_MS))) run += 1;
  if (run < STREAK_LOOKBACK_DAYS) {
    const start = utcDay(today - (run - 1) * DAY_MS);
    for (const n of [7, 30]) if (run >= n) awards.push({ id: `streak:${user}:${start}:${n}`, user, kind: 'streak' });
  }

  // 5 of the 7 days of this ISO week.
  const monday = isoWeekStart(now);
  let inWeek = 0;
  for (let d = 0; d < 7; d += 1) if (days.has(utcDay(monday + d * DAY_MS))) inWeek += 1;
  if (inWeek >= 5) awards.push({ id: `week5:${user}:${isoWeek(now)}`, user, kind: 'week5' });

  if (awards.length) await awardPoints(awards, now);
  await anniversary(user, now);
}

/** On or after the Hive account's anniversary day, once a year (years >= 1). */
async function anniversary(user: string, now: number): Promise<void> {
  const year = new Date(now).getUTCFullYear();
  // Paid this year already: no need to ask Hive.
  if (await store.count({ user, kind: 'anniv', since: Date.UTC(year, 0, 1) }) > 0) return;
  const created = await accountCreated(user);
  if (created === null) return;
  const c = new Date(created);
  const years = year - c.getUTCFullYear();
  if (years < 1 || now < Date.UTC(year, c.getUTCMonth(), c.getUTCDate())) return;
  await awardPoints([{ id: `anniv:${user}:${year}`, user, kind: 'anniv', ref: String(years) }], now);
}

// ── scheduled events ──────────────────────────────────────────────────────

/** A scheduled event pays its host when it starts within this of its time... */
export const PREMHELD_WINDOW_MS = 15 * 60 * 1000;
/** ...and was scheduled at least this far ahead (not "schedule now, start now"). */
export const PREMHELD_LEAD_MS = 60 * 60 * 1000;

/** The host started a scheduled event (POST /events/:id/start). */
export async function awardScheduledStart(
  ev: { id: string; hostUsername: string; scheduledAt: string; createdAt: string }, now = Date.now(),
): Promise<boolean> {
  const at = Date.parse(ev.scheduledAt);
  const created = Date.parse(ev.createdAt);
  if (!Number.isFinite(at) || !Number.isFinite(created)) return false;
  if (Math.abs(now - at) > PREMHELD_WINDOW_MS || at - created < PREMHELD_LEAD_MS) return false;
  const [r] = await awardPoints([{ id: `premheld:${ev.id}`, user: ev.hostUsername, kind: 'premheld' }], now);
  return r.awarded;
}
