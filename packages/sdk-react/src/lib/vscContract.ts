/**
 * VSC / Magi subscription-contract access for the Pro flow.
 *
 * Ported from 3Speak's `src/utils/vscContract.js` with three deliberate
 * changes, because an SDK cannot make the assumptions an app can:
 *
 *  1. No `@aioha/aioha` import. Key types are the plain strings the enum
 *     resolves to (`'posting'` / `'active'`), so `AiohaLike` stays structural
 *     and the SDK gains no dependency.
 *  2. No `import.meta.env`. Every endpoint / id comes from `ProConfig`, which
 *     `HangoutsProvider` fills with 3Speak mainnet defaults.
 *  3. `fetch` instead of axios. Note axios throws on non-2xx and fetch does
 *     not, so every call here checks `response.ok` explicitly.
 */

import type { AiohaLike } from '@snapie/hangouts-core';

/** Key type accepted by Aioha. These are exactly the values of its `KeyTypes` enum. */
export type HiveKeyType = 'posting' | 'active';

/**
 * Result of a signing call. Structurally what Aioha returns, kept loose so a
 * consumer's own broadcast wrapper can satisfy it.
 */
export interface SignResult {
  success: boolean;
  result?: string;
  error?: string;
}

/** A Hive operation tuple: `['custom_json', {...}]`. */
export type HiveOperation = [string, Record<string, unknown>];

export interface ProConfig {
  /** 'mainnet' (default) or 'testnet'. Selects the VSC net id and L1 asset symbols. */
  network?: string;
  /** VSC node GraphQL endpoint. Defaults to the network-appropriate okinoko node. */
  graphqlUrl?: string;
  /** Hasura indexer endpoint, used for the instant offer/subscription reads. */
  hasuraUrl?: string;
  /** Okinoko Subs contract address. */
  subsContractId?: string;
  /** Recurring-subscription offer id (monthly + yearly bill against this one offer). */
  subOfferId?: number;
  /** One-time 1-day-pass offer id. */
  onetimeOfferId?: number;
  /**
   * Force the free-trial button on or off. Leave unset (the default) to follow
   * the server's `testing_available`, which is the setting that actually
   * decides whether the claim would succeed.
   */
  trialEnabled?: boolean;
  /**
   * Optional override for broadcasting signed operations. Defaults to
   * `aioha.signAndBroadcastTx`. Provide this when your app routes some
   * signatures elsewhere (a delegated posting-auth proxy, an OAuth broker,
   * a custom active-key modal) — the SDK will use it for every contract call.
   */
  broadcastOps?: (operations: HiveOperation[], keyType: HiveKeyType) => Promise<SignResult>;
  /**
   * Optional override for resolving the signing account. Defaults to
   * `aioha.getCurrentUser()`. Needed when your auth flow can be signed in
   * without Aioha itself holding a user.
   */
  getUsername?: () => string | null | undefined;
}

/** ProConfig with every optional endpoint/id resolved to a concrete value. */
export interface ResolvedProConfig {
  network: string;
  isTestnet: boolean;
  netId: string;
  graphqlUrl: string;
  hasuraUrl: string;
  subsContractId: string;
  subOfferId: number;
  onetimeOfferId: number;
  trialEnabled?: boolean;
  broadcastOps?: ProConfig['broadcastOps'];
  getUsername?: ProConfig['getUsername'];
}

/**
 * 3Speak mainnet defaults — this is what makes the Pro flow zero-config.
 * Mainnet currently publishes two offers: id 5 is the recurring subscription
 * (monthly and yearly are two billing intervals on that single offer), id 4 is
 * the one-time 1-day pass.
 */
export const DEFAULT_SUBS_CONTRACT_ID = 'vsc1BpkPNtC1pBLhxtNn4uE3QkLhudoyzAiXUi';
export const DEFAULT_SUB_OFFER_ID = 5;
export const DEFAULT_ONETIME_OFFER_ID = 4;

/** RC limit for contract calls. */
const DEFAULT_RC_LIMIT = 10000;

export function resolveProConfig(config: ProConfig = {}): ResolvedProConfig {
  const network = config.network || 'mainnet';
  const isTestnet = network === 'testnet';
  return {
    network,
    isTestnet,
    netId: isTestnet ? 'vsc-testnet' : 'vsc-mainnet',
    graphqlUrl: config.graphqlUrl || (isTestnet
      ? 'https://api-testnet.okinoko.io/api/v1/graphql'
      : 'https://api.okinoko.io/api/v1/graphql'),
    hasuraUrl: config.hasuraUrl || (isTestnet
      ? 'https://api-testnet.okinoko.io/hasura/v1/graphql'
      : 'https://api.okinoko.io/hasura/v1/graphql'),
    subsContractId: config.subsContractId || DEFAULT_SUBS_CONTRACT_ID,
    subOfferId: config.subOfferId ?? DEFAULT_SUB_OFFER_ID,
    onetimeOfferId: config.onetimeOfferId ?? DEFAULT_ONETIME_OFFER_ID,
    trialEnabled: config.trialEnabled,
    broadcastOps: config.broadcastOps,
    getUsername: config.getUsername,
  };
}

/** Aioha methods this module uses beyond the core `AiohaLike` surface. */
interface VscCapableAioha extends AiohaLike {
  signAndBroadcastTx?(operations: HiveOperation[], keyType: string): Promise<SignResult>;
  vscSetNetId?(netId: string): void;
  vscCallContract?(
    contractId: string,
    action: string,
    payload: string,
    rcLimit: number,
    intents: unknown[],
    keyType: string,
  ): Promise<SignResult>;
}

export interface TransferIntent {
  type: string;
  args: { limit: string; token: string };
}

export interface PollProgress {
  attempt: number;
  elapsed: number;
}

export type PollStatus = 'success' | 'error' | 'timeout';

export interface PollResult {
  status: PollStatus;
  result: string | null;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // fetch resolves on 4xx/5xx where axios would have thrown, so the status
  // has to be checked by hand or a GraphQL error page parses as "no data".
  if (!response.ok) {
    throw new Error(`Request to ${url} failed (${response.status})`);
  }
  return response.json();
}

/**
 * Build a `transfer.allow` intent for paying an offer.
 * Amounts go on the wire with 3 decimals — don't hand this a display-formatted
 * string.
 */
export function buildTransferIntent(amount: string | number, token = 'hive'): TransferIntent {
  return {
    type: 'transfer.allow',
    args: {
      limit: typeof amount === 'number' ? amount.toFixed(3) : amount,
      token: token.toLowerCase(),
    },
  };
}

/**
 * Parse a pipe-delimited key:value response from contract getters.
 * e.g. `"id:1|provider:hive:creator"` → `{ id: '1', provider: 'hive:creator' }`
 */
export function parseContractResponse(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'string') return {};
  const result: Record<string, string> = {};
  for (const part of raw.split('|')) {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) continue;
    result[part.slice(0, colonIdx)] = part.slice(colonIdx + 1);
  }
  return result;
}

/**
 * Everything the Pro checkout needs to talk to the subs contract, bound to one
 * Aioha instance and one resolved config. Created by `useVscSubs()`.
 */
export class VscSubsClient {
  readonly config: ResolvedProConfig;
  private aioha: VscCapableAioha | undefined;

  constructor(config: ResolvedProConfig, aioha?: AiohaLike) {
    this.config = config;
    this.aioha = aioha as VscCapableAioha | undefined;
  }

  /** The account that will sign — the config override wins over Aioha's own user. */
  getUser(): string | null {
    const fromConfig = this.config.getUsername?.();
    if (fromConfig) return fromConfig;
    return this.aioha?.getCurrentUser?.() ?? null;
  }

  private async broadcast(operations: HiveOperation[], keyType: HiveKeyType): Promise<SignResult> {
    if (this.config.broadcastOps) return this.config.broadcastOps(operations, keyType);
    if (!this.aioha?.signAndBroadcastTx) {
      throw new Error('No signer available — pass an `aioha` instance to HangoutsProvider, or a `pro.broadcastOps` override.');
    }
    return this.aioha.signAndBroadcastTx(operations, keyType);
  }

  /** The `vsc.call` custom_json op for a contract action. */
  private buildCallOp(user: string, action: string, payload: string, intents: unknown[], keyType: HiveKeyType): HiveOperation {
    return ['custom_json', {
      required_auths: keyType === 'active' ? [user] : [],
      required_posting_auths: keyType === 'posting' ? [user] : [],
      id: 'vsc.call',
      json: JSON.stringify({
        net_id: this.config.netId,
        contract_id: this.config.subsContractId,
        action,
        payload,
        rc_limit: DEFAULT_RC_LIMIT,
        intents,
      }),
    }];
  }

  /**
   * Call a contract method as a standard Hive L1 transaction. The user signs
   * via their connected wallet.
   */
  async callSubsContract(
    action: string,
    payload: string,
    intents: unknown[] = [],
    keyType: HiveKeyType = 'active',
  ): Promise<SignResult> {
    const user = this.getUser();
    if (!user) throw new Error('Not logged in');

    const result = await this.broadcast([this.buildCallOp(user, action, payload, intents, keyType)], keyType);
    if (!result?.success) throw new Error(result?.error || 'Contract call failed');
    return result;
  }

  /**
   * Poll the VSC node for a contract execution result.
   * Returns `timeout` rather than throwing so the caller can keep the UI in a
   * "still pending" state instead of showing a failure the chain may not agree with.
   */
  async pollTxStatus(
    txId: string,
    timeoutMs = 120_000,
    onProgress?: (p: PollProgress) => void,
  ): Promise<PollResult> {
    const query = `query FindContractOutput($filterOptions: ContractOutputFilter) {
    findContractOutput(filterOptions: $filterOptions) {
      id
      results { ok ret }
    }
  }`;

    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt++;
      onProgress?.({ attempt, elapsed: Math.round((Date.now() - start) / 1000) });

      try {
        const json = await postJson(this.config.graphqlUrl, {
          query,
          variables: { filterOptions: { byInput: txId } },
        }) as { data?: { findContractOutput?: Array<{ results?: Array<{ ok?: unknown; ret?: string }> }> } };

        const result = json.data?.findContractOutput?.[0]?.results?.[0];
        if (result) {
          const ok = result.ok === true || result.ok === 'true' || result.ok === 1;
          return { status: ok ? 'success' : 'error', result: result.ret ?? null };
        }
      } catch {
        // Ignore poll errors and keep trying — the node may simply not have
        // indexed the tx yet, which is indistinguishable from a blip here.
      }

      await new Promise((r) => setTimeout(r, 5000));
    }

    return { status: 'timeout', result: null };
  }

  /** Read-only contract getter. Getters still cost a tx, so this polls for the result. */
  async querySubsContract(action: string, payload: string): Promise<string | null> {
    if (!this.aioha?.vscCallContract) {
      throw new Error('The provided Aioha instance does not support VSC contract calls');
    }
    this.aioha.vscSetNetId?.(this.config.netId);

    const result = await this.aioha.vscCallContract(
      this.config.subsContractId,
      action,
      payload,
      DEFAULT_RC_LIMIT,
      [],
      'posting',
    );
    if (!result?.success || !result.result) throw new Error(result?.error || 'Query failed');

    const poll = await this.pollTxStatus(result.result);
    if (poll.status === 'success') return poll.result;
    throw new Error(poll.result || `Query ${poll.status}`);
  }

  /** Query the Hasura indexer. Instant — no transaction involved. */
  async queryHasura<T = Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const json = await postJson(this.config.hasuraUrl, { query, variables }) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) throw new Error(json.errors[0]?.message || 'Hasura query failed');
    return json.data as T;
  }

  /**
   * A user's VSC L2 balances. The node returns milliunits; these are divided
   * down to human-readable units.
   */
  async getVscBalance(hiveUsername: string): Promise<{ hive: number; hbd: number }> {
    const json = await postJson(this.config.graphqlUrl, {
      query: `{ getAccountBalance(account: "hive:${hiveUsername}") { hive hbd } }`,
    }) as { data?: { getAccountBalance?: { hive?: number; hbd?: number } } };
    const bal = json.data?.getAccountBalance;
    return {
      hive: (bal?.hive || 0) / 1000,
      hbd: (bal?.hbd || 0) / 1000,
    };
  }

  /**
   * L1 → L2 deposit op. The memo must be `to=<hive_username>` so the VSC
   * bridge credits the right account.
   */
  buildDepositOp(amount: string, asset: string, username: string): HiveOperation {
    // Testnet renames the assets: HIVE → TESTS, HBD → TBD.
    const l1Asset = this.config.isTestnet
      ? (asset.toLowerCase() === 'hbd' ? 'TBD' : 'TESTS')
      : asset.toUpperCase();

    return ['transfer', {
      from: username,
      to: 'vsc.gateway',
      amount: `${amount} ${l1Asset}`,
      memo: `to=${username}`,
    }];
  }

  /**
   * Deposit from L1 and call the contract in a single Hive transaction, so the
   * user signs once instead of twice.
   */
  async depositAndCallContract(
    depositAmount: string,
    depositAsset: string,
    username: string,
    action: string,
    payload: string,
    intents: unknown[] = [],
  ): Promise<SignResult> {
    const ops: HiveOperation[] = [
      this.buildDepositOp(depositAmount, depositAsset, username),
      this.buildCallOp(username, action, payload, intents, 'active'),
    ];
    const result = await this.broadcast(ops, 'active');
    if (!result?.success) throw new Error(result?.error || 'Broadcast failed');
    return result;
  }
}
