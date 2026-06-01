import { describe, expect, it } from 'vitest';
import {
  boostLedgerId,
  hasBoostLedgerEntry,
  listBoostLedger,
  markBoostAccepted,
  markBoostBroadcasted,
  markBoostPayoutSent,
  markBoostRejected,
  upsertBoostLedgerReceived,
} from '../../src/lib/boostLedger.js';
import type { BoostMemoV1 } from '../../src/lib/boostTypes.js';

// The ledger is a module-level Map; use unique txIds per test to avoid cross-test state contamination.

const MEMO: BoostMemoV1 = {
  version: 1,
  room: 'test-room-xyz123',
  message: 'Hello host',
  sender: 'alice',
  nonce: 'nonce-abc123',
};

describe('boostLedgerId', () => {
  it('formats as txId:opIndex', () => {
    expect(boostLedgerId('mytx', 7)).toBe('mytx:7');
  });
});

describe('hasBoostLedgerEntry', () => {
  it('returns false for an unknown entry', () => {
    expect(hasBoostLedgerEntry('tx-never-seen', 0)).toBe(false);
  });

  it('returns true after upsert', () => {
    upsertBoostLedgerReceived({ txId: 'tx-has-001', opIndex: 0, memo: MEMO, amount: '1.000', asset: 'HBD' });
    expect(hasBoostLedgerEntry('tx-has-001', 0)).toBe(true);
  });
});

describe('upsertBoostLedgerReceived', () => {
  it('creates a new entry with status received', () => {
    const entry = upsertBoostLedgerReceived({ txId: 'tx-new-001', opIndex: 0, memo: MEMO, amount: '5.000', asset: 'HBD' });
    expect(entry.status).toBe('received');
    expect(entry.id).toBe('tx-new-001:0');
    expect(entry.txId).toBe('tx-new-001');
    expect(entry.room).toBe(MEMO.room);
    expect(entry.sender).toBe(MEMO.sender);
    expect(entry.amount).toBe('5.000');
    expect(entry.asset).toBe('HBD');
  });

  it('is idempotent — returns the original entry on a second call with different data', () => {
    const first = upsertBoostLedgerReceived({ txId: 'tx-idem-001', opIndex: 2, memo: MEMO, amount: '1.000', asset: 'HBD' });
    const second = upsertBoostLedgerReceived({ txId: 'tx-idem-001', opIndex: 2, memo: MEMO, amount: '99.000', asset: 'HIVE' });
    expect(second).toEqual(first);
    expect(second.amount).toBe('1.000');
  });

  it('stores optional displayName when present in the memo', () => {
    const memo = { ...MEMO, displayName: 'Alice' };
    const entry = upsertBoostLedgerReceived({ txId: 'tx-dn-001', opIndex: 0, memo, amount: '2.000', asset: 'HBD' });
    expect(entry.displayName).toBe('Alice');
  });
});

describe('markBoostAccepted', () => {
  it('transitions to accepted and sets all financial fields', () => {
    upsertBoostLedgerReceived({ txId: 'tx-acc-001', opIndex: 0, memo: MEMO, amount: '10.000', asset: 'HBD' });
    const id = boostLedgerId('tx-acc-001', 0);
    const result = markBoostAccepted(id, {
      usdAmount: 10,
      payoutRecipient: 'alice',
      feeAmount: '0.500',
      payoutAmount: '9.500',
    });
    expect(result?.status).toBe('accepted');
    expect(result?.usdAmount).toBe(10);
    expect(result?.payoutRecipient).toBe('alice');
    expect(result?.feeAmount).toBe('0.500');
    expect(result?.payoutAmount).toBe('9.500');
  });

  it('returns null for an unknown id', () => {
    expect(markBoostAccepted('nonexistent:0', {
      usdAmount: 1, payoutRecipient: 'x', feeAmount: '0.050', payoutAmount: '0.950',
    })).toBeNull();
  });
});

describe('markBoostBroadcasted', () => {
  it('transitions to broadcasted', () => {
    upsertBoostLedgerReceived({ txId: 'tx-bc-001', opIndex: 0, memo: MEMO, amount: '5.000', asset: 'HBD' });
    const id = boostLedgerId('tx-bc-001', 0);
    markBoostAccepted(id, { usdAmount: 5, payoutRecipient: 'alice', feeAmount: '0.250', payoutAmount: '4.750' });
    expect(markBoostBroadcasted(id)?.status).toBe('broadcasted');
  });

  it('returns null for an unknown id', () => {
    expect(markBoostBroadcasted('nonexistent:0')).toBeNull();
  });
});

describe('markBoostPayoutSent', () => {
  it('transitions to payout_sent', () => {
    upsertBoostLedgerReceived({ txId: 'tx-ps-001', opIndex: 0, memo: MEMO, amount: '5.000', asset: 'HBD' });
    expect(markBoostPayoutSent(boostLedgerId('tx-ps-001', 0))?.status).toBe('payout_sent');
  });

  it('returns null for an unknown id', () => {
    expect(markBoostPayoutSent('nonexistent:0')).toBeNull();
  });
});

describe('markBoostRejected', () => {
  it('transitions to rejected with the given reason', () => {
    upsertBoostLedgerReceived({ txId: 'tx-rej-001', opIndex: 0, memo: MEMO, amount: '1.000', asset: 'HBD' });
    const id = boostLedgerId('tx-rej-001', 0);
    const result = markBoostRejected(id, 'below_minimum');
    expect(result?.status).toBe('rejected');
    expect(result?.rejectReason).toBe('below_minimum');
  });

  it('returns null for an unknown id', () => {
    expect(markBoostRejected('nonexistent:0', 'invalid_memo')).toBeNull();
  });
});

describe('listBoostLedger', () => {
  it('returns only entries matching the given room', () => {
    const room = 'filter-room-zzz999';
    upsertBoostLedgerReceived({ txId: 'tx-list-001', opIndex: 0, memo: { ...MEMO, room }, amount: '1.000', asset: 'HBD' });
    const rows = listBoostLedger(room);
    expect(rows.every((r) => r.room === room)).toBe(true);
    expect(rows.some((r) => r.txId === 'tx-list-001')).toBe(true);
  });

  it('excludes entries from other rooms when filtered', () => {
    upsertBoostLedgerReceived({ txId: 'tx-list-002', opIndex: 0, memo: { ...MEMO, room: 'other-room-aaa111' }, amount: '1.000', asset: 'HBD' });
    const rows = listBoostLedger('no-match-room-qqq888');
    expect(rows.some((r) => r.txId === 'tx-list-002')).toBe(false);
  });

  it('returns all entries when no room filter is given', () => {
    upsertBoostLedgerReceived({ txId: 'tx-list-003', opIndex: 0, memo: MEMO, amount: '1.000', asset: 'HBD' });
    expect(listBoostLedger().length).toBeGreaterThan(0);
  });
});
