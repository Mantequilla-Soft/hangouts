import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { hiveClient } from './hive.js';

/**
 * The 3Speak Points token (3SP) on Magi: reads, contract calls and their
 * outcome. Points are whole numbers (decimals 0), amounts travel as decimal
 * strings and addresses as `hive:<name>`.
 *
 * A Hive txid only means Hive took the call. Whether the contract ran is a
 * separate answer from Magi (txOutcome): CONFIRMED is applied, FAILED aborted
 * (with the contract's message), anything else is "not yet".
 */

export interface MagiRead { ok: boolean; ret: unknown; err?: string }

export interface MagiTx {
  status: 'pending' | 'ok' | 'failed';
  /** The contract's abort message, without Magi's `file:` trailer. */
  error?: string;
  /** required_posting_auths[0] or required_auths[0], `hive:` prefixed. */
  caller?: string;
  contract?: string;
  action?: string;
  /** The call's payload, a JSON string. */
  payload?: string;
}

export interface MagiApi {
  /** Read-only simulation at the head (balanceOf, hasGrant, getMintCaps...). */
  read(calls: Array<{ action: string; payload: Record<string, unknown> }>): Promise<MagiRead[]>;
  /** The outcome of a call by its Hive txid; null when Magi has not seen it. */
  tx(txid: string): Promise<MagiTx | null>;
  /** Broadcast a contract call as `user` (posting authority), signed with
   *  `signerKey` (the user's own or an account in their posting auths). */
  call(user: string, signerKey: string, action: string, payload: Record<string, unknown>, rcLimit: number): Promise<string>;
}

export const MISSING_AUTHORITY_RE = /missing required posting authority/i;

export function tokenContract(): string {
  return (config.POINTS_TOKEN_CONTRACT ?? '').trim();
}

export function hiveAddress(user: string): string {
  return `hive:${user}`;
}

/** The custom_json a contract call is (the client signs this one itself when
 *  the server may not sign for the user). */
export function contractCallOp(user: string, action: string, payload: Record<string, unknown>, rcLimit: number) {
  return {
    id: 'vsc.call',
    required_auths: [] as string[],
    required_posting_auths: [user],
    json: JSON.stringify({
      net_id: config.POINTS_TOKEN_NET_ID,
      caller: hiveAddress(user),
      contract_id: tokenContract(),
      action,
      // A JSON string, not an object: the contract parses it itself.
      payload: JSON.stringify(payload),
      rc_limit: rcLimit,
      intents: [],
    }),
  };
}

function graphqlUrls(): string[] {
  return (config.POINTS_TOKEN_GRAPHQL_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let last: unknown = new Error('No Magi GraphQL endpoint configured');
  // The first endpoint that answers; the next ones are fallbacks.
  for (const url of graphqlUrls()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Magi GraphQL ${res.status}`);
      const body = await res.json() as { data?: T; errors?: Array<{ message: string }> };
      if (body.errors?.length) throw new Error(body.errors[0].message);
      if (!body.data) throw new Error('Magi GraphQL: no data');
      return body.data;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** "msg: Insufficient balance\nfile: :65460:65460" -> "Insufficient balance". */
export function contractError(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  const m = /msg:\s*([^\n]*)/.exec(s);
  return (m ? m[1] : s).trim();
}

const SIMULATE = `query($input: SimulateContractCallsInput!) {
  simulateContractCalls(input: $input) { success err_msg ret }
}`;

const FIND_TX = `query($ids: [String!]) {
  findTransaction(filterOptions: { byIds: $ids }) {
    id status error required_auths required_posting_auths ops { type data }
  }
}`;

export const magiGraphql: MagiApi = {
  async read(calls) {
    const out: MagiRead[] = [];
    // At most 10 calls per request.
    for (let i = 0; i < calls.length; i += 10) {
      const chunk = calls.slice(i, i + 10);
      const data = await graphql<{ simulateContractCalls: Array<{ success: boolean; err_msg: string | null; ret: string | null }> }>(SIMULATE, {
        input: {
          tx_id: 'read',
          required_auths: [hiveAddress((config.POINTS_MINTER_ACCOUNT ?? '').trim().toLowerCase() || 'threespeak-pro')],
          calls: chunk.map((c) => ({ contract_id: tokenContract(), action: c.action, payload: JSON.stringify(c.payload), rc_limit: 50_000 })),
        },
      });
      for (const r of data.simulateContractCalls ?? []) {
        let ret: unknown = r.ret;
        try { ret = r.ret ? JSON.parse(r.ret) : null; } catch { /* plain text */ }
        out.push({ ok: !!r.success, ret, ...(r.err_msg ? { err: contractError(r.err_msg) } : {}) });
      }
    }
    return out;
  },

  async tx(txid) {
    const data = await graphql<{ findTransaction: Array<{
      id: string; status: string; error: string | null;
      required_auths: string[] | null; required_posting_auths: string[] | null;
      ops: Array<{ type: string; data: Record<string, unknown> }> | null;
    }> | null }>(FIND_TX, { ids: [txid] });
    const t = (data.findTransaction ?? []).find((r) => r.id === txid);
    if (!t) return null;
    const call = (t.ops ?? []).find((o) => o.type === 'call')?.data ?? {};
    const status = t.status === 'CONFIRMED' ? 'ok' : t.status === 'FAILED' ? 'failed' : 'pending';
    return {
      status,
      ...(status === 'failed' ? { error: contractError(t.error) } : {}),
      caller: (t.required_posting_auths ?? [])[0] ?? (t.required_auths ?? [])[0],
      contract: typeof call.contract_id === 'string' ? call.contract_id : undefined,
      action: typeof call.action === 'string' ? call.action : undefined,
      payload: typeof call.payload === 'string' ? call.payload : undefined,
    };
  },

  async call(user, signerKey, action, payload, rcLimit) {
    const op = contractCallOp(user, action, payload, rcLimit);
    const res = await hiveClient.broadcast.json(op, PrivateKey.fromString(signerKey));
    return res.id;
  },
};

let api: MagiApi = magiGraphql;
/** Tests swap the client. */
export function setMagiApi(next: MagiApi): void { api = next; }
export function magi(): MagiApi { return api; }
