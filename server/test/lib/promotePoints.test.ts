import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { sendData: vi.fn().mockResolvedValue(undefined), listRooms: vi.fn().mockResolvedValue([]) },
}));

import { config } from '../../src/config.js';
import {
  PromoteCreditError, PromoteError, creditPromotion, promoteEligibility, promoteQuote, promoteRef, setPromoteFetch, setPromoteRetryDelays,
} from '../../src/lib/promotePoints.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const credit = { spendId: 'sp-1', user: 'fan', author: 'alice', permlink: 'v1', days: 1, points: 5000 };

beforeEach(() => {
  (config as { CHECKER_URL: string }).CHECKER_URL = 'https://checker.test';
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = 'secret';
  setPromoteRetryDelays([0, 0, 0]);
});
afterAll(() => {
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
  setPromoteFetch(null);
  setPromoteRetryDelays([1000, 3000, 6000]);
});

describe('quote and ref', () => {
  it('per24h from config, 7 days, on with the secret', () => {
    expect(promoteQuote()).toEqual({ per24h: 5000, maxDays: 7, enabled: true });
    (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
    expect(promoteQuote().enabled).toBe(false);
    expect(promoteRef('alice', 'v1')).toBe('promote:alice/v1');
  });
});

describe('promoteEligibility', () => {
  it('reads the checker answer, permlink encoded', async () => {
    const f = vi.fn(async () => json(200, { success: true, eligible: false, reason: 'hidden', promotedUntil: null, maxDays: 7 }));
    setPromoteFetch(f as unknown as typeof fetch);
    expect(await promoteEligibility('alice', 'a/b')).toEqual({ eligible: false, reason: 'hidden', promotedUntil: null, maxDays: 7 });
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://checker.test/promote/eligible/alice/a%2Fb');
  });

  it('no answer, an error status or a strange body: 503', async () => {
    for (const f of [
      async () => { throw new TypeError('fetch failed'); },
      async () => json(500, {}),
      async () => json(200, { success: true }),
      async () => new Response('not json', { status: 200 }),
    ]) {
      setPromoteFetch(f as unknown as typeof fetch);
      await expect(promoteEligibility('alice', 'v1')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    }
    await expect(promoteEligibility('alice', 'v1')).rejects.toBeInstanceOf(PromoteError);
  });
});

describe('creditPromotion', () => {
  it('network errors, 429 and 5xx are tried again with the same body', async () => {
    const answers: Array<() => Response> = [
      () => { throw new TypeError('fetch failed'); }, () => json(429, {}), () => json(502, {}),
      () => json(200, { success: true, promotedUntil: 123, addedDays: 1 }),
    ];
    const f = vi.fn(async () => answers.shift()!());
    setPromoteFetch(f as unknown as typeof fetch);
    expect(await creditPromotion(credit)).toEqual({ promotedUntil: 123 });
    expect(f).toHaveBeenCalledTimes(4);
    const bodies = f.mock.calls.map((c) => (c as unknown[])[1] as RequestInit).map((i) => i.body);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(String(bodies[0]))).toEqual({ author: 'alice', permlink: 'v1', days: 1, spendId: 'sp-1', user: 'fan', points: 5000 });
  });

  it('a 4xx is final, not retried', async () => {
    for (const [status, body, message] of [
      [404, { code: 'not_found' }, 'That video cannot be found.'],
      [409, { code: 'too_long', maxDays: 0 }, 'That runs longer than a promotion can.'],
      [401, { message: 'Unauthorized' }, 'The promotion was turned down.'],
    ] as const) {
      const f = vi.fn(async () => json(status, body));
      setPromoteFetch(f as unknown as typeof fetch);
      const err = await creditPromotion(credit).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PromoteCreditError);
      expect(err).toMatchObject({ transient: false, message });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after the retries, as transient', async () => {
    const f = vi.fn(async () => json(503, {}));
    setPromoteFetch(f as unknown as typeof fetch);
    await expect(creditPromotion(credit)).rejects.toMatchObject({ transient: true });
    expect(f).toHaveBeenCalledTimes(4);
  });
});
