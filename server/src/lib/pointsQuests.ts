import { config } from '../config.js';
import { awardPoints, awardStore, isoWeek, isoWeekStart } from './pointsAwards.js';

/**
 * Weekly quests: a few small goals per ISO week (Monday to Sunday, UTC), each
 * worth QUEST_POINTS once (award `quest:<questId>:<YYYY-Www>:<user>`).
 *
 * Progress is counted from the account's award rows of that week (videos
 * watched to the end, listening minutes, poll votes, tags), and for live
 * watching from the minutes the points sampler counts in memory (a ledger row
 * is per batch, so it cannot say minutes). A quest pays when the award or minute
 * that completes it arrives, and again on GET /points/quests if that failed.
 *
 * Three of the built-in quests run each week, rotating by week number;
 * POINTS_QUESTS (a comma list of quest ids) runs a fixed set instead.
 */

export const QUEST_POINTS = 300;
export const QUESTS_PER_WEEK = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type QuestKind = 'finish' | 'listen' | 'pollvote' | 'tag' | 'watch';
export interface QuestDef {
  id: string;
  /** What it counts: an award kind, or `watch` (minutes of live streams). */
  kind: QuestKind;
  target: number;
  /** Sum the awards' units (minutes) instead of counting them. */
  units?: boolean;
}

/** The frontend owns the text: `wallet.points.quests.<id>`. */
export const QUESTS: QuestDef[] = [
  { id: 'finish3', kind: 'finish', target: 3 },
  { id: 'listen30', kind: 'listen', target: 30, units: true },
  { id: 'pollvote2', kind: 'pollvote', target: 2 },
  { id: 'tag5', kind: 'tag', target: 5 },
  { id: 'live30', kind: 'watch', target: 30 },
];

const weekNumber = (week: string) => Number(week.slice(6));

/** The quests of the ISO week of `now`. */
export function activeQuests(now = Date.now()): QuestDef[] {
  const fixed = config.POINTS_QUESTS.split(',').map((s) => s.trim()).filter(Boolean);
  if (fixed.length) return QUESTS.filter((q) => fixed.includes(q.id));
  const first = weekNumber(isoWeek(now)) % QUESTS.length;
  return Array.from({ length: QUESTS_PER_WEEK }, (_, i) => QUESTS[(first + i) % QUESTS.length]);
}

// ── live watching minutes ─────────────────────────────────────────────────

export interface WatchMinuteStore {
  /** One more minute for each of `users` in `week`. */
  add(week: string, users: string[]): Promise<void>;
  get(user: string, week: string): Promise<number>;
  /** Which of `users` have at least `min` minutes in `week`. */
  reached(week: string, users: string[], min: number): Promise<string[]>;
}

export function memoryWatchMinuteStore(): WatchMinuteStore & { minutes: Map<string, number> } {
  const minutes = new Map<string, number>();
  const k = (user: string, week: string) => `${week}|${user}`;
  return {
    minutes,
    async add(week, users) { for (const u of users) minutes.set(k(u, week), (minutes.get(k(u, week)) ?? 0) + 1); },
    async get(user, week) { return minutes.get(k(user, week)) ?? 0; },
    async reached(week, users, min) { return users.filter((u) => (minutes.get(k(u, week)) ?? 0) >= min); },
  };
}

// 🚨 In memory only, never in Mongo: keeping a name with how long someone watched
// needs their consent (viewer rewards opt-in), and the quest is not worth asking
// for it. A restart starts the week's live minutes again for everyone.
let watchStore: WatchMinuteStore = memoryWatchMinuteStore();
export function setWatchMinuteStore(next: WatchMinuteStore): void { watchStore = next; }

/** Accounts already paid the live-watching quest this week (so the sampler
 *  does not try every minute after). A restart only costs one more try. */
const watchPaid = new Set<string>();

/** One minute of live watching for these signed-in viewers (the points
 *  sampler, lib/pointsStreamAwards.ts). */
export async function noteLiveWatch(users: string[], now = Date.now()): Promise<void> {
  if (users.length === 0) return;
  const week = isoWeek(now);
  await watchStore.add(week, users);
  const quest = activeQuests(now).find((q) => q.kind === 'watch');
  if (!quest) return;
  for (const [k] of watchPaid) if (!k.startsWith(`${week}|`)) watchPaid.delete(k);
  const done = await watchStore.reached(week, users.filter((u) => !watchPaid.has(`${week}|${u}`)), quest.target);
  for (const user of done) {
    watchPaid.add(`${week}|${user}`);
    await checkQuests(user, now);
  }
}

// ── progress ──────────────────────────────────────────────────────────────

export interface QuestView {
  id: string;
  kind: QuestKind;
  target: number;
  progress: number;
  done: boolean;
  points: number;
  title_key: string;
}

async function progressOf(q: QuestDef, user: string, now: number): Promise<number> {
  const week = isoWeek(now);
  if (q.kind === 'watch') return watchStore.get(user, week);
  const since = isoWeekStart(now);
  const query = { user, kind: q.kind, since, until: since + WEEK_MS };
  return q.units ? awardStore().sumUnits(query) : awardStore().count(query);
}

/** This week's quests of `user` with their progress (capped at the target). */
export async function questProgress(user: string, now = Date.now()): Promise<{ week: string; quests: QuestView[] }> {
  const quests = await Promise.all(activeQuests(now).map(async (q) => {
    const n = await progressOf(q, user, now);
    return {
      id: q.id, kind: q.kind, target: q.target, progress: Math.min(n, q.target), done: n >= q.target,
      points: QUEST_POINTS, title_key: `wallet.points.quests.${q.id}`,
    };
  }));
  return { week: isoWeek(now), quests };
}

/** Pay this week's done quests of `user` (each once). What it paid. */
export async function checkQuests(user: string, now = Date.now()): Promise<number> {
  const { week, quests } = await questProgress(user, now);
  const done = quests.filter((q) => q.done);
  if (done.length === 0) return 0;
  const out = await awardPoints(done.map((q) => ({ id: `quest:${q.id}:${week}:${user}`, user, kind: 'quest', ref: q.id })), now);
  return out.reduce((n, o) => n + (o.awarded ? o.points : 0), 0);
}

export function resetQuestMemory(): void { watchPaid.clear(); }
