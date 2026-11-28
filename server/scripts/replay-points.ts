/**
 * Rebuild every channel points balance from the Hive log alone: the
 * custom_json `3speak_points` ops of the points account, replayed with the
 * live rules (start amount, floor 0, `expire` back to the start). Prints JSON
 * `{ account, ops, movements, balances: { user: balance } }` to stdout; it
 * reads the chain only and changes nothing.
 *
 * It replays `3speak_points`, the log from before the 3SP token: after the
 * airdrop that is exactly the airdropped balances. Later movements are in
 * `3sp_points`, and the balances are on Magi then (lib/pointsLog.ts).
 *
 *   npm run points:replay -- [account] [node]
 *   (defaults: threespeak-pro, https://api.hive.blog)
 */
import { Client } from '@hiveio/dhive';
import { POINTS_LOG_ID, decodePointsLog, replayPointsLog, type LoggedMovement } from '../src/lib/pointsLog.js';

const account = (process.argv[2] ?? 'threespeak-pro').toLowerCase();
const client = new Client(process.argv[3] ?? 'https://api.hive.blog');
const START = Math.max(1, Number(process.env.POINTS_START ?? 1000) || 1000);
// get_account_history operation filter: custom_json is operation 18.
const CUSTOM_JSON = (BigInt(1) << BigInt(18)).toString();
const PAGE = 1000;

type HistoryItem = [number, { timestamp: string; op: [string, { id: string; json: string; required_auths: string[]; required_posting_auths: string[] }] }];

const movements: LoggedMovement[] = [];
let ops = 0;
let start = -1;
for (;;) {
  // From the newest back; `start` is an index, so a page can't reach below 0.
  const limit = start < 0 ? PAGE : Math.min(PAGE, start + 1);
  const page = await client.call('condenser_api', 'get_account_history', [account, start, limit, CUSTOM_JSON]) as HistoryItem[];
  for (const [, item] of page) {
    const [name, op] = item.op;
    if (name !== 'custom_json' || op.id !== POINTS_LOG_ID) continue;
    // Only what the points account signed itself.
    if (![...op.required_auths, ...op.required_posting_auths].includes(account)) continue;
    const decoded = decodePointsLog(op.json);
    if (!decoded) continue;
    ops += 1;
    movements.push(...decoded);
  }
  const first = page[0]?.[0];
  // Filtered pages skip other ops, so only an empty page or index 0 is the end.
  if (first === undefined || first === 0) break;
  start = first - 1;
}

const balances = Object.fromEntries([...replayPointsLog(movements, START)].map(([u, b]) => [u, b.balance]));
process.stdout.write(`${JSON.stringify({ account, ops, movements: movements.length, balances }, null, 2)}\n`);
