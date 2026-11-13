import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The cached rate and the in-flight request are module state, so every test
// re-imports the module. CoinGecko is a fetch fake; fake timers age the cache.
const h = vi.hoisted(() => ({
  config: { BOOST_HIVE_USD_CACHE_MS: 120_000, BOOST_HIVE_USD_FALLBACK: 0.25 },
}));
vi.mock('../../src/config.js', () => ({ config: h.config }));

type PricingModule = typeof import('../../src/lib/boostPricing.js');
let pricing: PricingModule;
let fetchMock: ReturnType<typeof vi.fn>;

const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd';
const priced = (usd: unknown, status = 200) =>
  new Response(JSON.stringify({ hive: { usd } }), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  vi.useFakeTimers();
  h.config.BOOST_HIVE_USD_CACHE_MS = 120_000;
  h.config.BOOST_HIVE_USD_FALLBACK = 0.25;
  fetchMock = vi.fn().mockImplementation(async () => priced(0.31));
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  pricing = await import('../../src/lib/boostPricing.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('getHiveUsdRate', () => {
  it('fetches the HIVE/USD price from CoinGecko with a timeout', async () => {
    expect(await pricing.getHiveUsdRate()).toBe(0.31);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(COINGECKO);
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('serves the cached price while it is fresh', async () => {
    await pricing.getHiveUsdRate();
    fetchMock.mockImplementation(async () => priced(0.5));
    vi.advanceTimersByTime(119_000);

    expect(await pricing.getHiveUsdRate()).toBe(0.31);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cache has expired', async () => {
    await pricing.getHiveUsdRate();
    fetchMock.mockImplementation(async () => priced(0.5));
    vi.advanceTimersByTime(120_000);

    expect(await pricing.getHiveUsdRate()).toBe(0.5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one CoinGecko request between concurrent callers', async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise((r) => { answer = r; }));

    const a = pricing.getHiveUsdRate();
    const b = pricing.getHiveUsdRate();
    answer(priced(0.42));

    expect(await Promise.all([a, b])).toEqual([0.42, 0.42]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the configured rate when CoinGecko answers non-2xx', async () => {
    fetchMock.mockImplementation(async () => new Response('rate limited', { status: 429 }));
    expect(await pricing.getHiveUsdRate()).toBe(0.25);
  });

  it('falls back to the configured rate when CoinGecko cannot be reached or times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await pricing.getHiveUsdRate()).toBe(0.25);
  });

  it.each([
    ['a missing price', undefined],
    ['a zero price', 0],
    ['a negative price', -1],
    ['a non-numeric price', 'abc'],
  ])('falls back to the configured rate on %s', async (_label, usd) => {
    fetchMock.mockImplementation(async () => priced(usd));
    expect(await pricing.getHiveUsdRate()).toBe(0.25);
  });

  it('falls back when the payload is not JSON', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>', { status: 200 }));
    expect(await pricing.getHiveUsdRate()).toBe(0.25);
  });

  it('keeps using the last good price when a later refresh fails', async () => {
    await pricing.getHiveUsdRate();
    vi.advanceTimersByTime(200_000);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    expect(await pricing.getHiveUsdRate()).toBe(0.31);
  });

  it('does not cache a fallback: the next call asks CoinGecko again', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await pricing.getHiveUsdRate()).toBe(0.25);

    expect(await pricing.getHiveUsdRate()).toBe(0.31);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('hbdUsdRate', () => {
  it('pegs HBD at one dollar', () => {
    expect(pricing.hbdUsdRate()).toBe(1);
  });
});
