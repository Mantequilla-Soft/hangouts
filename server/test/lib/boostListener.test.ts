import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processBoostTransfer } from '../../src/lib/boostListener.js';
import { listBoostLedger } from '../../src/lib/boostLedger.js';

vi.mock('../../src/config.js', () => ({
  config: {
    BOOST_PLATFORM_ACCOUNT: 'boostwallet',
    BOOST_PLATFORM_FEE_PERCENT: 5,
    BOOST_HIVE_USD_FALLBACK: 0.25,
    BOOST_HIVE_USD_CACHE_MS: 120000,
    BOOSTS_ENABLED: true,
    BOOST_PLATFORM_ACTIVE_KEY: '',
    CHECKER_URL: 'https://checker.test',
    STREAM_STATS_SECRET: '',
  },
}));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: vi.fn(), sendData: vi.fn() },
}));

vi.mock('../../src/lib/boostPricing.js', () => ({
  getHiveUsdRate: vi.fn().mockResolvedValue(0.25),
  hbdUsdRate: vi.fn().mockReturnValue(1),
}));

vi.mock('../../src/lib/boostPayout.js', () => ({
  sendBoostPayout: vi.fn().mockResolvedValue(undefined),
  sendBoostRefund: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/streamStats.js', () => ({
  recordBoost: vi.fn(),
}));

const noop = () => {};

function makeRoomMeta(overrides: Record<string, unknown> = {}) {
  return {
    name: 'alice-room-abc123',
    metadata: JSON.stringify({
      host: 'alice',
      boost: { enabled: true, minBoostUsd: 1, creatorPayoutAccount: 'alice' },
      ...overrides,
    }),
    numParticipants: 0,
    maxParticipants: 500,
  };
}

function makeMockLk(roomMeta = makeRoomMeta()) {
  return {
    listRooms: vi.fn().mockResolvedValue([roomMeta]),
    sendData: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function baseInput(txId: string, overrides: Partial<{
  from: string; to: string; amount: string; memo: string;
}> = {}) {
  return {
    txId,
    opIndex: 0,
    blockNum: 100,
    timestamp: Date.now(),
    to: 'boostwallet',
    amount: '2.000 HBD',
    memo: JSON.stringify({
      version: 1,
      room: 'alice-room-abc123',
      message: 'Hello host!',
      sender: 'bob',
      nonce: 'nonce-abc123',
    }),
    ...overrides,
  };
}

describe('processBoostTransfer', () => {
  let payout: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('../../src/lib/boostPayout.js');
    payout = vi.mocked(mod.sendBoostPayout);
  });

  it('silently ignores a transfer destined for a different account', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-ignore-001', { to: 'other-account' }), noop, lk);
    expect(lk.listRooms).not.toHaveBeenCalled();
    expect(payout).not.toHaveBeenCalled();
  });

  it('rejects with invalid_memo when the memo is not valid JSON', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-badmemo-001', { memo: 'not-json' }), noop, lk);
    const entry = listBoostLedger().find((e) => e.txId === 'tx-badmemo-001');
    expect(entry?.status).toBe('rejected');
    expect(entry?.rejectReason).toBe('invalid_memo');
    expect(payout).not.toHaveBeenCalled();
  });

  it('rejects with invalid_asset when the amount format is wrong', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-badamt-001', { amount: '10 HBD' }), noop, lk);
    const entry = listBoostLedger().find((e) => e.txId === 'tx-badamt-001');
    expect(entry?.status).toBe('rejected');
    expect(entry?.rejectReason).toBe('invalid_asset');
    expect(payout).not.toHaveBeenCalled();
  });

  it('rejects with room_not_found when the room does not exist', async () => {
    const lk = { listRooms: vi.fn().mockResolvedValue([]), sendData: vi.fn() } as any;
    await processBoostTransfer(baseInput('tx-noroom-001'), noop, lk);
    const entry = listBoostLedger().find((e) => e.txId === 'tx-noroom-001');
    expect(entry?.status).toBe('rejected');
    expect(entry?.rejectReason).toBe('room_not_found');
    expect(payout).not.toHaveBeenCalled();
  });

  it('below_minimum: broadcasts with belowMinimum flag, pays host, ledger shows payout_sent', async () => {
    const lk = makeMockLk(makeRoomMeta({
      boost: { enabled: true, minBoostUsd: 100, creatorPayoutAccount: 'alice' },
    }));
    await processBoostTransfer(baseInput('tx-belowmin-001', { amount: '0.100 HBD' }), noop, lk);
    const entry = listBoostLedger().find((e) => e.txId === 'tx-belowmin-001');
    expect(entry?.status).toBe('payout_sent');
    // Event is always broadcast now — client filters belowMinimum from the overlay
    expect(lk.sendData).toHaveBeenCalledOnce();
    // Verify the broadcast payload contains belowMinimum: true
    const payload = JSON.parse(new TextDecoder().decode(lk.sendData.mock.calls[0][1]));
    expect(payload.belowMinimum).toBe(true);
    expect(payout).toHaveBeenCalledOnce();
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice' }));
  });

  it('rejects the second of two identical transfers — payout called only once', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-dup-001'), noop, lk);
    await processBoostTransfer(baseInput('tx-dup-001'), noop, lk);
    expect(payout).toHaveBeenCalledTimes(1);
  });

  it('happy path: broadcasts event, pays out, ledger shows payout_sent', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-happy-001'), noop, lk);

    expect(lk.sendData).toHaveBeenCalledOnce();
    expect(payout).toHaveBeenCalledOnce();
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({
      to: 'alice',
      asset: 'HBD',
    }));

    const entry = listBoostLedger().find((e) => e.txId === 'tx-happy-001');
    expect(entry?.status).toBe('payout_sent');
    expect(entry?.payoutRecipient).toBe('alice');
    expect(entry?.feeAmount).toBe('0.100');
    expect(entry?.payoutAmount).toBe('1.900');
  });
});

describe('processBoostTransfer: recipients, conversion and failures', () => {
  let payout: ReturnType<typeof vi.fn>;
  let recordBoost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    payout = vi.mocked((await import('../../src/lib/boostPayout.js')).sendBoostPayout);
    payout.mockResolvedValue(undefined);
    recordBoost = vi.mocked((await import('../../src/lib/streamStats.js')).recordBoost);
  });

  const entryFor = (txId: string) => listBoostLedger().find((e) => e.txId === txId);
  const memoWith = (extra: Record<string, unknown>) => JSON.stringify({
    version: 1, room: 'alice-room-abc123', message: 'Hi', sender: 'bob', nonce: 'nonce-abc123', ...extra,
  });
  const sentEvent = (lk: { sendData: ReturnType<typeof vi.fn> }) =>
    JSON.parse(new TextDecoder().decode(lk.sendData.mock.calls[0][1]));

  it('matches the platform account case-insensitively and ignoring spaces', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-case-001', { to: '  BoostWallet ' }), noop, lk);
    expect(entryFor('tx-case-001')?.status).toBe('payout_sent');
  });

  it('broadcasts the full boost event on the reliable boost topic and logs it to the leaderboard', async () => {
    const lk = makeMockLk();
    const input = { ...baseInput('tx-event-001', { memo: memoWith({ displayName: 'Bobby' }) }), opIndex: 4, blockNum: 777, timestamp: 1700000000000 };
    await processBoostTransfer(input, noop, lk);

    const [room, , kind, opts] = lk.sendData.mock.calls[0];
    expect(room).toBe('alice-room-abc123');
    expect(kind).toBe(0); // DataPacket_Kind.RELIABLE
    expect(opts).toEqual({ topic: 'boost' });
    expect(sentEvent(lk)).toEqual({
      type: 'boost',
      id: 'tx-event-001:4',
      room: 'alice-room-abc123',
      sender: 'bob',
      displayName: 'Bobby',
      message: 'Hi',
      amount: '2.000',
      asset: 'HBD',
      usdAmount: 2,
      feeAmount: '0.100',
      payoutAmount: '1.900',
      recipient: 'alice',
      txId: 'tx-event-001',
      blockNum: 777,
      timestamp: 1700000000000,
    });
    expect(recordBoost).toHaveBeenCalledWith('alice-room-abc123', 'alice', 'bob', 2, 'Hi');
    expect(payout).toHaveBeenCalledWith({
      to: 'alice', amount: '1.900', asset: 'HBD', memo: 'boost payout:alice-room-abc123:tx-event-001',
    });
  });

  it('values HIVE boosts at the HIVE/USD rate', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-hive-001', { amount: '10.000 HIVE' }), noop, lk);
    const entry = entryFor('tx-hive-001');
    expect(entry?.usdAmount).toBe(2.5);
    expect(entry?.asset).toBe('HIVE');
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({ asset: 'HIVE', amount: '9.500' }));
  });

  it('does not flag a boost at or above the minimum as below minimum', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-atmin-001', { amount: '1.000 HBD' }), noop, lk);
    expect(sentEvent(lk)).not.toHaveProperty('belowMinimum');
  });

  it('pays the collab guest when the memo names the guest on air', async () => {
    const lk = makeMockLk(makeRoomMeta({ collabGuest: ' Carol ' }));
    await processBoostTransfer(baseInput('tx-guest-001', { memo: memoWith({ recipient: 'carol' }) }), noop, lk);
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({ to: 'carol' }));
    expect(entryFor('tx-guest-001')?.payoutRecipient).toBe('carol');
  });

  it('pays the host when the memo names someone who is not on air', async () => {
    const lk = makeMockLk(makeRoomMeta({ collabGuest: 'carol' }));
    await processBoostTransfer(baseInput('tx-guest-002', { memo: memoWith({ recipient: 'mallory' }) }), noop, lk);
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice' }));
  });

  it('pays the host when the memo names a guest but the room has none', async () => {
    const lk = makeMockLk(makeRoomMeta({ collabGuest: undefined }));
    await processBoostTransfer(baseInput('tx-guest-003', { memo: memoWith({ recipient: 'carol' }) }), noop, lk);
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice' }));
  });

  it('prefers the configured creator payout account over the host, lowercased', async () => {
    const lk = makeMockLk(makeRoomMeta({ boost: { enabled: true, creatorPayoutAccount: ' AliceFund ' } }));
    await processBoostTransfer(baseInput('tx-payacct-001'), noop, lk);
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({ to: 'alicefund' }));
  });

  it('falls back to the host when there is no boost config at all, with no minimum', async () => {
    const lk = makeMockLk(makeRoomMeta({ boost: undefined }));
    await processBoostTransfer(baseInput('tx-noboostcfg-001', { amount: '0.001 HBD' }), noop, lk);
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice' }));
    expect(sentEvent(lk)).not.toHaveProperty('belowMinimum');
  });

  it('treats a non-object boost config or a bad minimum as enabled with no minimum', async () => {
    const lk = makeMockLk(makeRoomMeta({ boost: ['x'] }));
    await processBoostTransfer(baseInput('tx-arrcfg-001'), noop, lk);
    expect(entryFor('tx-arrcfg-001')?.status).toBe('payout_sent');

    const lk2 = makeMockLk(makeRoomMeta({ boost: { minBoostUsd: 'lots' } }));
    await processBoostTransfer(baseInput('tx-badmin-001', { amount: '0.001 HBD' }), noop, lk2);
    expect(sentEvent(lk2)).not.toHaveProperty('belowMinimum');
  });

  it('refunds the full amount to the sender when the host switched boosts off mid-stream, without paying or showing it', async () => {
    const { sendBoostRefund } = await import('../../src/lib/boostPayout.js');
    const refund = vi.mocked(sendBoostRefund);
    refund.mockClear();
    const log = vi.fn();
    const lk = makeMockLk(makeRoomMeta({ boost: { enabled: false } }));
    await processBoostTransfer(baseInput('tx-off-001', { from: 'Bob' }), log, lk);
    expect(entryFor('tx-off-001')).toMatchObject({ status: 'refunded', rejectReason: 'boosts_disabled' });
    expect(refund).toHaveBeenCalledWith({
      to: 'bob', amount: '2.000', asset: 'HBD',
      memo: 'boost refund:alice-room-abc123:tx-off-001: Boosts are switched off for this stream',
    });
    expect(lk.sendData).not.toHaveBeenCalled();
    expect(payout).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[Boost] refunded tx-off-001:0 to @bob: boosts_disabled', undefined);
  });

  it('only rejects a boost for a room with boosts off when the sender is unknown (nobody to refund)', async () => {
    const { sendBoostRefund } = await import('../../src/lib/boostPayout.js');
    vi.mocked(sendBoostRefund).mockClear();
    const lk = makeMockLk(makeRoomMeta({ boost: { enabled: false } }));
    await processBoostTransfer(baseInput('tx-off-002'), noop, lk);
    expect(entryFor('tx-off-002')).toMatchObject({ status: 'rejected', rejectReason: 'boosts_disabled' });
    expect(sendBoostRefund).not.toHaveBeenCalled();
  });

  it('never refunds to the platform account itself', async () => {
    const { sendBoostRefund } = await import('../../src/lib/boostPayout.js');
    vi.mocked(sendBoostRefund).mockClear();
    const lk = makeMockLk(makeRoomMeta({ boost: { enabled: false } }));
    await processBoostTransfer(baseInput('tx-off-003', { from: 'boostwallet' }), noop, lk);
    expect(entryFor('tx-off-003')).toMatchObject({ status: 'rejected', rejectReason: 'boosts_disabled' });
    expect(sendBoostRefund).not.toHaveBeenCalled();
  });

  it('marks refund_failed and logs for a hand payout when the refund transfer fails', async () => {
    const { sendBoostRefund } = await import('../../src/lib/boostPayout.js');
    vi.mocked(sendBoostRefund).mockClear().mockRejectedValueOnce(new Error('rpc down'));
    const log = vi.fn();
    const lk = makeMockLk(makeRoomMeta({ boost: { enabled: false } }));
    await processBoostTransfer(baseInput('tx-off-004', { from: 'bob' }), log, lk);
    expect(entryFor('tx-off-004')).toMatchObject({ status: 'rejected', rejectReason: 'refund_failed' });
    expect(log.mock.calls[0][0]).toContain('REFUND FAILED tx-off-004:0 (2.000 HBD to @bob, boosts_disabled)');
  });

  it('refunds a boost for a stream that has already ended', async () => {
    const { sendBoostRefund } = await import('../../src/lib/boostPayout.js');
    vi.mocked(sendBoostRefund).mockClear();
    const lk = makeMockLk();
    lk.listRooms.mockResolvedValue([]);
    await processBoostTransfer(baseInput('tx-gone-001', { from: 'bob' }), noop, lk);
    expect(entryFor('tx-gone-001')).toMatchObject({ status: 'refunded', rejectReason: 'room_not_found' });
    expect(vi.mocked(sendBoostRefund).mock.calls[0][0].memo).toBe('boost refund:alice-room-abc123:tx-gone-001: the stream could not receive it');
  });

  it('refunds when the room has nobody to pay', async () => {
    const { sendBoostRefund } = await import('../../src/lib/boostPayout.js');
    vi.mocked(sendBoostRefund).mockClear();
    const lk = makeMockLk(makeRoomMeta({ host: '  ', boost: { enabled: true } }));
    await processBoostTransfer(baseInput('tx-nopay-002', { from: 'bob' }), noop, lk);
    expect(entryFor('tx-nopay-002')).toMatchObject({ status: 'refunded', rejectReason: 'internal_error' });
  });

  it('still pays a boost under the minimum (flagged, not refunded)', async () => {
    const { sendBoostRefund } = await import('../../src/lib/boostPayout.js');
    vi.mocked(sendBoostRefund).mockClear();
    payout.mockClear();
    const lk = makeMockLk(makeRoomMeta({ boost: { enabled: true, minBoostUsd: 5, creatorPayoutAccount: 'alice' } }));
    await processBoostTransfer(baseInput('tx-min-009', { from: 'bob' }), noop, lk);
    expect(sendBoostRefund).not.toHaveBeenCalled();
    expect(payout).toHaveBeenCalledTimes(1);
  });

  it('rejects as internal_error when nobody can be paid', async () => {
    const lk = makeMockLk(makeRoomMeta({ host: '  ', boost: { enabled: true } }));
    await processBoostTransfer(baseInput('tx-nopay-001'), noop, lk);
    expect(entryFor('tx-nopay-001')).toMatchObject({ status: 'rejected', rejectReason: 'internal_error' });
    expect(payout).not.toHaveBeenCalled();
  });

  it('reads unparseable room metadata as empty, which leaves nobody to pay', async () => {
    const lk = makeMockLk({ ...makeRoomMeta(), metadata: '{not json' });
    await processBoostTransfer(baseInput('tx-badmeta-001'), noop, lk);
    expect(entryFor('tx-badmeta-001')?.rejectReason).toBe('internal_error');
  });

  it('rejects as room_not_found when LiveKit cannot list the room', async () => {
    const lk = { listRooms: vi.fn().mockRejectedValue(new Error('twirp: unavailable')), sendData: vi.fn() } as any;
    await processBoostTransfer(baseInput('tx-lkdown-001'), noop, lk);
    expect(entryFor('tx-lkdown-001')?.rejectReason).toBe('room_not_found');
  });

  it('rejects as internal_error and does not pay when the broadcast fails', async () => {
    const lk = makeMockLk();
    lk.sendData.mockRejectedValue(new Error('room not found'));
    const log = vi.fn();
    await processBoostTransfer(baseInput('tx-bcast-001'), log, lk);
    // a "room not found" error from LiveKit is reported as such
    expect(entryFor('tx-bcast-001')?.rejectReason).toBe('room_not_found');
    expect(payout).not.toHaveBeenCalled();
    expect(recordBoost).not.toHaveBeenCalled();

    const lk2 = makeMockLk();
    lk2.sendData.mockRejectedValue(new Error('network'));
    await processBoostTransfer(baseInput('tx-bcast-002'), log, lk2);
    expect(entryFor('tx-bcast-002')?.rejectReason).toBe('internal_error');
  });

  it('records payout_failed when the payout transfer fails after the broadcast', async () => {
    payout.mockRejectedValueOnce(new Error('insufficient funds'));
    const lk = makeMockLk();
    const log = vi.fn();
    await processBoostTransfer(baseInput('tx-payfail-001'), log, lk);
    expect(lk.sendData).toHaveBeenCalledOnce();
    expect(entryFor('tx-payfail-001')).toMatchObject({ status: 'rejected', rejectReason: 'payout_failed' });
    expect(log).toHaveBeenCalledWith('[Boost] rejected tx-payfail-001:0: payout_failed', expect.any(Error));
  });

  it('records a memo that parses but has an invalid amount under its real room and sender', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-badamt-002', { amount: '1.000 STEEM' }), noop, lk);
    expect(entryFor('tx-badamt-002')).toMatchObject({
      room: 'alice-room-abc123', sender: 'bob', amount: '0.000', asset: 'HBD', rejectReason: 'invalid_asset',
    });
  });

  it('records an unreadable memo under a placeholder room and sender', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-badmemo-002', { memo: memoWith({ version: 2 }) }), noop, lk);
    expect(entryFor('tx-badmemo-002')).toMatchObject({
      room: 'unknown-room', sender: 'unknown', amount: '2.000', asset: 'HBD', rejectReason: 'invalid_memo',
    });
    expect(lk.listRooms).not.toHaveBeenCalled();
  });

  // Was a latent ledger bug, fixed: when the same transfer (txId + opIndex) is processed a
  // second time, the duplicate branch calls markBoostRejected on the ORIGINAL
  // entry, so a boost that was broadcast and paid flips to rejected /
  // duplicate_transfer and the host history shows a paid boost as rejected.
  // The poll loop's watermark normally prevents a replay, so this only bites
  // if processBoostTransfer is ever fed the same op twice.
  it('keeps a paid boost as payout_sent when the same transfer is seen again', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-replay-001'), noop, lk);
    await processBoostTransfer(baseInput('tx-replay-001'), noop, lk);
    expect(entryFor('tx-replay-001')?.status).toBe('payout_sent');
  });
});
