import { afterEach, describe, expect, it, vi } from 'vitest';
import { spendPoints, walletSigner } from '../src/lib/pointsSpend.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(...answers: Response[]) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next;
  }));
  return calls;
}

const base = { apiBaseUrl: 'https://live.test', url: 'https://live.test/rooms/r/boosts/points', body: { amount: 2500, message: 'hi' }, headers: () => ({ authorization: 'Bearer t' }), pollMs: 1 };

afterEach(() => { vi.unstubAllGlobals(); });

describe('spendPoints', () => {
  it('a server without the token: the answer as it comes', async () => {
    mockFetch(json(201, { boost: { id: 'b1' }, balance: 10 }));
    expect(await spendPoints(base)).toEqual({ ok: true, body: { boost: { id: 'b1' }, balance: 10 } });
    mockFetch(json(400, { message: 'You do not have that many points.', code: 'insufficient' }));
    expect(await spendPoints(base)).toEqual({ ok: false, code: 'insufficient', message: 'You do not have that many points.' });
  });

  it('428: the wallet signs the op, the same request goes again with burnTx', async () => {
    const op = ['custom_json', { id: 'vsc.call', required_posting_auths: ['fan'], json: '{}' }];
    const calls = mockFetch(json(428, { code: 'sign', op, message: 'Confirm this spend in your wallet.' }), json(201, { balance: 5 }));
    const sign = vi.fn(async () => 'ab'.repeat(20));
    const out = await spendPoints({ ...base, sign });
    expect(sign).toHaveBeenCalledWith([op]);
    expect(calls[1].body).toEqual({ amount: 2500, message: 'hi', burnTx: 'ab'.repeat(20) });
    expect(out).toEqual({ ok: true, body: { balance: 5 } });
  });

  it('428 without a wallet, or a refused signature: the reason', async () => {
    mockFetch(json(428, { code: 'sign', op: ['custom_json', {}], message: 'Confirm this spend in your wallet.' }));
    expect(await spendPoints(base)).toMatchObject({ ok: false, code: 'sign' });
    mockFetch(json(428, { code: 'sign', op: ['custom_json', {}] }));
    expect(await spendPoints({ ...base, sign: async () => { throw new Error('User rejected'); } })).toEqual({ ok: false, code: 'sign', message: 'User rejected' });
  });

  it('202: follows the spend until it is done, or says why not', async () => {
    const onPending = vi.fn();
    const calls = mockFetch(json(202, { pending: true, spendId: 'sp-1' }), json(200, { status: 'sent' }), json(200, { status: 'ok', balance: 7, boost: { id: 'b' } }));
    expect(await spendPoints({ ...base, onPending })).toEqual({ ok: true, body: { status: 'ok', balance: 7, boost: { id: 'b' } } });
    expect(onPending).toHaveBeenCalledOnce();
    expect(calls[1].url).toBe('https://live.test/points/spends/sp-1');
    mockFetch(json(202, { pending: true, spendId: 'sp-2' }), json(200, { status: 'refunded', message: 'The stream ended.' }));
    expect(await spendPoints(base)).toEqual({ ok: false, code: 'refunded', message: 'The stream ended.' });
  });
});

describe('walletSigner', () => {
  it('prefers pro.broadcastOps with the posting key, then Aioha; the txid or an error', async () => {
    const broadcastOps = vi.fn(async () => ({ success: true, result: 'tx1' }));
    const sign = walletSigner({ broadcastOps } as never, undefined)!;
    expect(await sign([['custom_json', {}]])).toBe('tx1');
    expect(broadcastOps).toHaveBeenCalledWith([['custom_json', {}]], 'posting');
    const aioha = { signAndBroadcastTx: vi.fn(async () => ({ success: false, error: 'rejected' })) };
    await expect(walletSigner({} as never, aioha as never)!([['custom_json', {}]])).rejects.toThrow('rejected');
    expect(walletSigner({} as never, undefined)).toBeUndefined();
  });
});
