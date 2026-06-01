import { describe, expect, it } from 'vitest';
import { parseBoostMemo, parseTransferAmount, splitBoostAmounts } from '../../src/lib/boostTypes.js';

describe('boostTypes', () => {
  it('parses valid strict JSON boost memo', () => {
    const memo = parseBoostMemo(JSON.stringify({
      version: 1,
      room: 'alice-room-abc123',
      message: 'Great talk!',
      sender: 'bob',
      nonce: 'abc_123-xyz',
      displayName: 'Bob',
    }));

    expect(memo).toEqual({
      version: 1,
      room: 'alice-room-abc123',
      message: 'Great talk!',
      sender: 'bob',
      nonce: 'abc_123-xyz',
      displayName: 'Bob',
    });
  });

  it('rejects non-json or malformed memo payloads', () => {
    expect(parseBoostMemo('not-json')).toBeNull();
    expect(parseBoostMemo(JSON.stringify({
      version: 1,
      room: 'bad room',
      message: 'hello',
      sender: 'bob',
      nonce: 'abc12345',
    }))).toBeNull();
  });

  it('parses transfer amounts and splits 5 percent fee', () => {
    const amt = parseTransferAmount('10.000 HBD');
    expect(amt).not.toBeNull();
    if (!amt) return;

    const split = splitBoostAmounts(amt, 5);
    expect(split).toEqual({
      feeAmount: '0.500',
      payoutAmount: '9.500',
    });
  });

  it('parses HIVE as well as HBD', () => {
    const amt = parseTransferAmount('5.000 HIVE');
    expect(amt).not.toBeNull();
    expect(amt?.asset).toBe('HIVE');
    expect(amt?.value).toBe(5);
  });

  it('rejects malformed transfer amounts', () => {
    expect(parseTransferAmount('10 HBD')).toBeNull();       // missing decimal
    expect(parseTransferAmount('10.00 HBD')).toBeNull();    // wrong precision
    expect(parseTransferAmount('10.000 USD')).toBeNull();   // unknown asset
    expect(parseTransferAmount('0.000 HBD')).toBeNull();    // zero value
    expect(parseTransferAmount('-1.000 HBD')).toBeNull();   // negative
    expect(parseTransferAmount('')).toBeNull();             // empty
  });

  it('splitBoostAmounts with 0% fee sends the full amount to payout', () => {
    const amt = parseTransferAmount('10.000 HBD');
    expect(amt).not.toBeNull();
    expect(splitBoostAmounts(amt!, 0)).toEqual({ feeAmount: '0.000', payoutAmount: '10.000' });
  });

  it('splitBoostAmounts with 10% fee', () => {
    const amt = parseTransferAmount('10.000 HBD');
    expect(amt).not.toBeNull();
    expect(splitBoostAmounts(amt!, 10)).toEqual({ feeAmount: '1.000', payoutAmount: '9.000' });
  });

  it('rejects a message that exceeds 280 characters', () => {
    expect(parseBoostMemo(JSON.stringify({
      version: 1, room: 'alice-room-abc123', message: 'a'.repeat(281), sender: 'bob', nonce: 'abc_123-xyz',
    }))).toBeNull();
  });

  it('accepts a message that is exactly 280 characters', () => {
    const result = parseBoostMemo(JSON.stringify({
      version: 1, room: 'alice-room-abc123', message: 'a'.repeat(280), sender: 'bob', nonce: 'abc_123-xyz',
    }));
    expect(result).not.toBeNull();
    expect(result?.message.length).toBe(280);
  });

  it('truncates displayName to 64 characters', () => {
    const result = parseBoostMemo(JSON.stringify({
      version: 1, room: 'alice-room-abc123', message: 'Hi', sender: 'bob', nonce: 'abc_123-xyz',
      displayName: 'a'.repeat(100),
    }));
    expect(result?.displayName?.length).toBe(64);
  });
});
