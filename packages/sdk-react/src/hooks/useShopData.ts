import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { HangoutsContext } from '../context/HangoutsContext.js';
import { parseRoomMeta } from '../lib/boostGoals.js';
import {
  activePinnedChat, isHiveAccount, shopApi,
  type CosmeticsView, type PinnedChat, type ShopCatalog,
} from '../lib/pointsShop.js';

/**
 * Shared, cached lookups for the points shop: the catalog, each chat author's
 * cosmetics and a host's supporter badges. Public GETs the server caches for a
 * minute or more, so the SDK keeps them a few minutes too, and asks once per
 * key however many chat lines or components want the same one.
 */

interface Entry<T> { value: T | null; at: number; loading?: Promise<void> }

function createCache<T>(ttlMs: number) {
  const map = new Map<string, Entry<T>>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of listeners) l(); };
  const fresh = (key: string) => {
    const e = map.get(key);
    return !!e && (!!e.loading || Date.now() - e.at < ttlMs);
  };
  return {
    get: (key: string): T | null => map.get(key)?.value ?? null,
    load(key: string, fetcher: () => Promise<T>): Promise<void> {
      if (fresh(key)) return map.get(key)!.loading ?? Promise.resolve();
      const prev = map.get(key);
      // A failure is remembered for the TTL too: an older server without the
      // route is not asked again for every chat line.
      const loading = fetcher()
        .then((value) => { map.set(key, { value, at: Date.now() }); })
        .catch(() => { map.set(key, { value: prev?.value ?? null, at: Date.now() }); })
        .finally(emit);
      map.set(key, { value: prev?.value ?? null, at: prev?.at ?? 0, loading });
      return loading;
    },
    set(key: string, value: T): void { map.set(key, { value, at: Date.now() }); emit(); },
    drop(key: string): void { map.delete(key); emit(); },
    clear(): void { map.clear(); emit(); },
    subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}

const CATALOG_TTL_MS = 5 * 60_000;
const ACCOUNT_TTL_MS = 3 * 60_000;
const catalogs = createCache<ShopCatalog>(CATALOG_TTL_MS);
const cosmetics = createCache<CosmeticsView>(ACCOUNT_TTL_MS);
const supporters = createCache<string[]>(ACCOUNT_TTL_MS);

const accountKey = (base: string, account: string) => `${base}|${account.toLowerCase()}`;

function useCached<T>(cache: ReturnType<typeof createCache<T>>, key: string | null, fetcher: () => Promise<T>): T | null {
  const value = useSyncExternalStore(
    cache.subscribe,
    () => (key ? cache.get(key) : null),
    () => (key ? cache.get(key) : null),
  );
  useEffect(() => {
    if (key) void cache.load(key, fetcher);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return value;
}

/** GET /points/shop: prices, what is on, the sticker set. Null while it loads
 *  (or on a server without the shop). */
export function useShopCatalog(): ShopCatalog | null {
  const base = useContext(HangoutsContext)?.apiBaseUrl ?? '';
  return useCached(catalogs, base || null, () => shopApi.catalog(base));
}

/** What `account` wears (GET /users/:account/cosmetics). Null for a guest, or until it loads. */
export function useCosmetics(account: string | null | undefined): CosmeticsView | null {
  const base = useContext(HangoutsContext)?.apiBaseUrl ?? '';
  const acc = isHiveAccount(account?.toLowerCase()) ? account!.toLowerCase() : null;
  return useCached(cosmetics, base && acc ? accountKey(base, acc) : null, () => shopApi.cosmetics(base, acc!));
}

/** The accounts with `host`'s supporter badge (GET /channels/:host/supporters `badges`), lower case. */
export function useChannelSupporters(host: string | null | undefined): string[] {
  const base = useContext(HangoutsContext)?.apiBaseUrl ?? '';
  const h = isHiveAccount(host?.toLowerCase()) ? host!.toLowerCase() : null;
  const list = useCached(supporters, base && h ? accountKey(base, h) : null,
    () => shopApi.supporters(base, h!).then((l) => l.map((u) => u.toLowerCase())));
  return list ?? EMPTY;
}
const EMPTY: string[] = [];

/** Put a known answer in the cache (after a purchase, or in tests). */
export function primeCosmetics(apiBaseUrl: string, account: string, view: CosmeticsView): void {
  cosmetics.set(accountKey(apiBaseUrl, account), view);
}
export function primeSupporters(apiBaseUrl: string, host: string, badges: string[]): void {
  supporters.set(accountKey(apiBaseUrl, host), badges.map((u) => u.toLowerCase()));
}
export function primeShopCatalog(apiBaseUrl: string, catalog: ShopCatalog): void {
  catalogs.set(apiBaseUrl, catalog);
}
/** Ask again next time (the viewer just unlocked a sticker set). */
export function invalidateCosmetics(apiBaseUrl: string, account: string): void {
  cosmetics.drop(accountKey(apiBaseUrl, account));
}
/** Test helper: empty every shop cache. */
export function __resetShopCaches(): void {
  catalogs.clear();
  cosmetics.clear();
  supporters.clear();
}

// ── per viewer ────────────────────────────────────────────────────────────

/** The signed-in viewer's points balance (GET /points), once `enabled`. */
export function usePointsBalance(enabled = true) {
  const ctx = useContext(HangoutsContext);
  const [balance, setBalance] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    if (!ctx?.apiBaseUrl || !ctx.isAuthenticated) return;
    try {
      const b = await shopApi.balance(ctx.apiBaseUrl, ctx.apiClient.getSessionToken());
      if (b !== null) setBalance(b);
    } catch { /* the buy answer says so */ }
  }, [ctx?.apiBaseUrl, ctx?.isAuthenticated, ctx?.apiClient]);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  return { balance, setBalance, refresh };
}

/**
 * Stream time bought with points for today's streams (GET /points/stream-extra),
 * for a free host: the studio adds it to the cap (resolveStreamCap). 0 for Pro
 * (`enabled` false), signed out, or a server without the shop.
 */
export function useStreamExtra(enabled: boolean) {
  const ctx = useContext(HangoutsContext);
  const [extraMs, setExtraMs] = useState(0);
  const refresh = useCallback(async () => {
    if (!enabled || !ctx?.apiBaseUrl || !ctx.isAuthenticated) return;
    try { setExtraMs(await shopApi.streamExtra(ctx.apiBaseUrl, ctx.apiClient.getSessionToken())); } catch { /* keep what we had */ }
  }, [enabled, ctx?.apiBaseUrl, ctx?.isAuthenticated, ctx?.apiClient]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { extraMs: enabled ? extraMs : 0, refresh };
}

/**
 * The highlighted message pinned on top of the chat (room metadata
 * `pinnedChat`), gone once its `until` passes: a timer hides it, nothing is
 * fetched again.
 */
export function usePinnedChat(metadata: string | undefined): PinnedChat | null {
  const [now, setNow] = useState(() => Date.now());
  const pin = activePinnedChat(parseRoomMeta(metadata), now);
  const until = pin?.until ?? 0;
  useEffect(() => {
    if (!until) return undefined;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [until]);
  return pin;
}
