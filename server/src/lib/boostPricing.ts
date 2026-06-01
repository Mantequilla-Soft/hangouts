import { config } from '../config.js';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd';

let cachedHiveUsd: number | null = null;
let cachedAt = 0;
let inflight: Promise<number> | null = null;

function cacheFresh(now: number): boolean {
  return cachedHiveUsd !== null && now - cachedAt < config.BOOST_HIVE_USD_CACHE_MS;
}

async function fetchHiveUsd(): Promise<number> {
  const response = await fetch(COINGECKO_URL, {
    signal: AbortSignal.timeout(4_000),
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`CoinGecko HTTP ${response.status}`);
  }
  const json = await response.json() as { hive?: { usd?: number } };
  const value = Number(json?.hive?.usd);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('CoinGecko payload missing hive.usd');
  }
  return value;
}

export async function getHiveUsdRate(): Promise<number> {
  const now = Date.now();
  if (cacheFresh(now)) return cachedHiveUsd as number;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const rate = await fetchHiveUsd();
      cachedHiveUsd = rate;
      cachedAt = Date.now();
      return rate;
    } catch {
      // Production-safe fallback if API is unavailable.
      return cachedHiveUsd ?? config.BOOST_HIVE_USD_FALLBACK;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function hbdUsdRate(): number {
  return 1;
}
