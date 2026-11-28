/**
 * The one-time 3SP airdrop: every balance (the points ledger replayed with the
 * live rules) goes on Magi as an airdrop row (kind `a`, which also counts as
 * the account's welcome grant),
 * minted by the minter under its caps. Afterwards the ledger rows up to the
 * snapshot are marked `pre` (the airdrop covers them) and the token goes live:
 * the mint queue starts and spends burn on chain (lib/pointsToken.ts).
 *
 * Run `npm run points:replay` first and check it matches Mongo, then set
 * POINTS_TOKEN_CONTRACT and run this on that server at least two minutes after
 * its restart. Without --yes it only prints the plan.
 *
 * No points log entry is written for the airdrop: the old log (custom_json
 * `3speak_points`) is exactly the rows the airdrop covers, so replaying it gives
 * the airdropped balances, and from setting the contract on the server logs
 * nothing new until this is done; afterwards new movements go to `3sp_points`
 * (lib/pointsLog.ts). Nothing is counted twice.
 *
 *   npm run points:airdrop            (dry run)
 *   npm run points:airdrop -- --yes   (broadcast, wait for each batch)
 *
 * Safe to run again after a failure: accounts that already have their grant
 * on chain are skipped (the contract refuses a second one anyway).
 */
import { config } from '../src/config.js';
import { getLiveDb } from '../src/lib/mongoDb.js';
import { hiveAddress, magi, tokenContract } from '../src/lib/magi.js';
import { existingAccounts, mintBatchId, tokenStore, type MintRow } from '../src/lib/pointsToken.js';
import { POINTS_START } from '../src/lib/points.js';
import { replayPointsLog, type PointsKind } from '../src/lib/pointsLog.js';

const yes = process.argv.includes('--yes');
const MAX_BYTES = 7000;
const log = (msg: string) => process.stdout.write(`${msg}\n`);

if (!tokenContract()) { log('POINTS_TOKEN_CONTRACT is not set.'); process.exit(1); }
const minter = config.POINTS_MINTER_ACCOUNT.trim().toLowerCase();
const key = config.POINTS_MINTER_POSTING_KEY.trim()
  || (minter === config.POINTS_LOG_ACCOUNT.trim().toLowerCase() ? config.POINTS_LOG_POSTING_KEY.trim() : '');
if (yes && !key) { log('No minter posting key (POINTS_MINTER_POSTING_KEY or POINTS_LOG_POSTING_KEY).'); process.exit(1); }
if (await tokenStore().airdropDone()) { log('The airdrop is already done.'); process.exit(0); }

const db = await getLiveDb();
if (!db) { log('No Mongo (MONGODB_URI).'); process.exit(1); }

// The ledger up to a snapshot two minutes back: an earnings batch writes its
// balances and rows within seconds, so every row up to then is in. The
// airdrop is that ledger replayed with the live rules (the same as
// `npm run points:replay` from the chain), and exactly those rows are then
// marked `pre`; anything later is minted by the queue as usual.
const snapshot = new Date(Date.now() - 2 * 60_000);
const ledgerRows = await db.collection<{ id: string; user: string; delta: number; kind: PointsKind; at: Date }>('points-ledger')
  .find({ at: { $lte: snapshot }, mint: null }, { projection: { _id: 0, id: 1, user: 1, delta: 1, kind: 1, at: 1 } }).toArray();
// The old log must not hold a row the airdrop misses: one logged on Hive after
// the snapshot would replay to more than was airdropped. The server stops
// logging once the contract is set, so this only trips when run too soon.
const loggedLate = await db.collection('points-ledger').countDocuments({ at: { $gt: snapshot }, tx: { $ne: null }, mint: null });
if (loggedLate > 0) {
  log(`${loggedLate} ledger row(s) after the snapshot are already on the old log: is POINTS_TOKEN_CONTRACT set on the server, and was it restarted more than 2 minutes ago? Nothing done.`);
  process.exit(1);
}
const replayed = replayPointsLog(ledgerRows.map((r) => ({ user: r.user, delta: r.delta, kind: r.kind, at: r.at.getTime() })), POINTS_START);
const docs = [...replayed].map(([user, b]) => ({ user, balance: b.balance })).filter((d) => d.balance > 0);

// A check, not the source: Mongo balances that differ from the replay (later
// activity explains small ones).
const mongo = new Map((await db.collection<{ user: string; balance: number }>('points')
  .find({}, { projection: { _id: 0, user: 1, balance: 1 } }).toArray()).map((d) => [d.user, d.balance]));
const differ = docs.filter((d) => mongo.has(d.user) && mongo.get(d.user) !== d.balance);

const users = docs.map((d) => d.user);
const exists = await existingAccounts(users);
const missing = users.filter((u) => !exists.has(u));

const grantReads = await magi().read(users.filter((u) => exists.has(u)).map((u) => ({ action: 'hasGrant', payload: { account: hiveAddress(u) } })));
const candidates = docs.filter((d) => exists.has(d.user));
const already = new Set(candidates.filter((_, i) => (grantReads[i]?.ret as { granted?: boolean } | null)?.granted).map((d) => d.user));
const rows: MintRow[] = candidates.filter((d) => !already.has(d.user)).map((d) => [hiveAddress(d.user), String(Math.floor(d.balance)), 'a']);

const [capsRead] = await magi().read([{ action: 'getMintCaps', payload: {} }]);
const caps = capsRead?.ret as { perBatch: string; perDay: string; mintedToday: string };
const perBatch = Number(caps.perBatch);
const dayRoom = Number(caps.perDay) - Number(caps.mintedToday);

// Batches under the byte limit and the per-batch cap.
const batches: MintRow[][] = [];
let cur: MintRow[] = [];
let curTotal = 0;
for (const r of rows) {
  const amt = Number(r[1]);
  if (amt > perBatch) { log(`${r[0]} holds ${amt}, more than one batch may mint (${perBatch}): ask the owner to raise the cap or mint it as owner.`); process.exit(1); }
  const next = [...cur, r];
  if (cur.length && (curTotal + amt > perBatch || Buffer.byteLength(JSON.stringify({ id: 'a-'.padEnd(26, '0'), to: next })) * 1.3 > MAX_BYTES)) {
    batches.push(cur);
    cur = [];
    curTotal = 0;
  }
  cur.push(r);
  curTotal += amt;
}
if (cur.length) batches.push(cur);

const total = rows.reduce((n, r) => n + Number(r[1]), 0);
log(`Contract ${tokenContract()} on ${config.POINTS_TOKEN_NET_ID}, minter @${minter}`);
log(`Snapshot ${snapshot.toISOString()}: ${ledgerRows.length} ledger rows, ${docs.length} balances, ${rows.length} to airdrop, ${total} points in ${batches.length} batch(es)`);
for (const d of differ) log(`  note: @${d.user} replays to ${d.balance}, Mongo has ${mongo.get(d.user)} (activity after the snapshot is minted later)`);
if (already.size) log(`Already granted on chain (skipped): ${[...already].join(', ')}`);
if (missing.length) log(`Not on Hive (skipped): ${missing.join(', ')}`);
for (const r of rows) log(`  ${r[0]}  ${r[1]}`);
if (total > dayRoom) log(`Today's mint cap has room for ${dayRoom}: the rest needs the next day window (run again then).`);
if (!yes) { log('Dry run. Again with --yes to broadcast.'); process.exit(0); }

let room = dayRoom;
for (const b of batches) {
  const bTotal = b.reduce((n, r) => n + Number(r[1]), 0);
  if (bTotal > room) { log('The day cap is used up: run again in the next day window.'); process.exit(2); }
  const id = mintBatchId(b, []).replace(/^m-/, 'a-');
  const tx = await magi().call(minter, key, 'mintBatch', { id, to: b }, Math.min(100_000, 1000 + 200 * b.length));
  log(`Batch ${id}: ${b.length} rows, ${bTotal} points, tx ${tx}`);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const t = await magi().tx(tx).catch(() => null);
    if (t?.status === 'ok') { log('  confirmed'); break; }
    if (t?.status === 'failed') { log(`  ABORTED: ${t.error}. Nothing changed for this batch; fix and run again.`); process.exit(3); }
    if (Date.now() > deadline) { log(`  no answer after 10 minutes: check ${tx}, then run again (granted accounts are skipped).`); process.exit(4); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  room -= bTotal;
}

// The airdrop covers exactly the replayed rows: never mint those.
const marked = await db.collection('points-ledger').updateMany(
  { id: { $in: ledgerRows.map((r) => r.id) }, mint: null },
  { $set: { mint: 'pre' } },
);
await tokenStore().markAirdropDone({ snapshot: snapshot.toISOString(), accounts: rows.length, total, batches: batches.length });
log(`Done: ${marked.modifiedCount} ledger rows marked pre. The token is live within 30 seconds.`);
process.exit(0);
