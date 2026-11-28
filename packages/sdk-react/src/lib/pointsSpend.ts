import type { AiohaLike } from '@snapie/hangouts-core';
import type { HiveOperation, ResolvedProConfig, SignResult } from './vscContract.js';

/**
 * A request that spends channel points (a points boost, a prediction stake).
 *
 * With 3Speak Points on Magi the server burns the points first and only then
 * does the thing, so besides "done" or an error it can answer:
 *
 *   428 { code: 'sign', op }   the server may not sign for this account: the
 *                              user's wallet signs `op` (a posting-key
 *                              custom_json) and the same request goes again
 *                              with `burnTx`.
 *   202 { pending, spendId }   the burn is not confirmed yet: poll
 *                              GET /points/spends/:id until it is.
 *
 * Servers without the token answer as before (200/201 or an error).
 */

export type PointsSpendOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string; code?: string };

interface SpendOptions {
  apiBaseUrl: string;
  url: string;
  body: Record<string, unknown>;
  headers: () => Record<string, string>;
  /** Sign and broadcast with the user's wallet; resolves the txid. */
  sign?: (ops: HiveOperation[]) => Promise<string>;
  /** The burn is waiting for Magi (show "confirming"). */
  onPending?: () => void;
  /** How long to follow a pending spend (default 10 minutes). */
  timeoutMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A wallet signer from what the provider has: `pro.broadcastOps` first, then Aioha. */
export function walletSigner(pro: ResolvedProConfig | undefined, aioha: AiohaLike | undefined): ((ops: HiveOperation[]) => Promise<string>) | undefined {
  const broadcast = pro?.broadcastOps
    ?? ((aioha as { signAndBroadcastTx?: (ops: HiveOperation[], keyType: string) => Promise<SignResult> } | undefined)?.signAndBroadcastTx
      ? (ops: HiveOperation[]) => (aioha as unknown as { signAndBroadcastTx: (o: HiveOperation[], k: string) => Promise<SignResult> }).signAndBroadcastTx(ops, 'posting')
      : undefined);
  if (!broadcast) return undefined;
  return async (ops) => {
    const res = await broadcast(ops, 'posting');
    if (!res?.success || !res.result) throw new Error(res?.error || 'The wallet did not sign.');
    return res.result;
  };
}

export async function spendPoints(opts: SpendOptions): Promise<PointsSpendOutcome> {
  const post = (body: Record<string, unknown>) => fetch(opts.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers() },
    body: JSON.stringify(body),
  });
  let res = await post(opts.body);
  let json = await res.json().catch(() => ({})) as Record<string, unknown>;

  if (res.status === 428 && json.code === 'sign' && Array.isArray(json.op)) {
    if (!opts.sign) return { ok: false, code: 'sign', message: typeof json.message === 'string' ? json.message : 'Sign in with a wallet to spend points.' };
    let burnTx: string;
    try {
      burnTx = await opts.sign([json.op as HiveOperation]);
    } catch (err) {
      return { ok: false, code: 'sign', message: err instanceof Error ? err.message : 'The wallet did not sign.' };
    }
    res = await post({ ...opts.body, burnTx });
    json = await res.json().catch(() => ({})) as Record<string, unknown>;
  }

  if (res.status === 202 && json.pending && typeof json.spendId === 'string') {
    opts.onPending?.();
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      await sleep(opts.pollMs ?? 3000);
      const s = await fetch(`${opts.apiBaseUrl}/points/spends/${encodeURIComponent(json.spendId)}`, { headers: opts.headers() })
        .then((r) => (r.ok ? r.json() as Promise<Record<string, unknown>> : null))
        .catch(() => null);
      if (!s || s.status === 'sent') continue;
      if (s.status === 'ok') return { ok: true, body: s };
      return { ok: false, code: String(s.status), message: typeof s.message === 'string' ? s.message : 'The spend did not go through.' };
    }
    return { ok: false, code: 'timeout', message: 'Still not confirmed. Check your points in a few minutes.' };
  }

  if (!res.ok) return { ok: false, code: typeof json.code === 'string' ? json.code : undefined, message: typeof json.message === 'string' ? json.message : `Failed (${res.status})` };
  return { ok: true, body: json };
}
