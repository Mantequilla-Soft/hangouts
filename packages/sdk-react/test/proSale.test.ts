import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRO_SALE, parseIntervals, percentOff, planPricing, saleHeadline, saleLastDay, saleNextChange, saleOpen, salePrices,
  type ProSale,
} from '../src/lib/proSale.js';
import { resolveProConfig } from '../src/lib/vscContract.js';

const sale: ProSale = { subOfferId: 7, onetimeOfferId: 6, endsAt: '2026-12-01T00:00:00Z', label: 'Cyber Week' };
const at = (iso: string) => Date.parse(iso);

describe('saleOpen', () => {
  it('is on until the end time, and off from it on', () => {
    expect(saleOpen(sale, at('2026-11-21T10:00:00Z'))).toBe(true);
    expect(saleOpen(sale, at('2026-11-30T23:59:59Z'))).toBe(true);
    expect(saleOpen(sale, at('2026-12-01T00:00:00Z'))).toBe(false);
    expect(saleOpen(sale, at('2026-12-05T00:00:00Z'))).toBe(false);
  });
  it('waits for its start when it has one', () => {
    const later = { ...sale, startsAt: '2026-11-22T00:00:00Z' };
    expect(saleOpen(later, at('2026-11-21T23:59:59Z'))).toBe(false);
    expect(saleOpen(later, at('2026-11-22T00:00:00Z'))).toBe(true);
    expect(saleOpen({ ...later, startsAt: 'tomorrow' }, at('2026-11-25T00:00:00Z'))).toBe(false);
  });
  it('knows how long until it next starts or ends', () => {
    const later = { ...sale, startsAt: '2026-11-22T00:00:00Z' };
    expect(saleNextChange(later, at('2026-11-21T23:00:00Z'))).toBe(3600_000);
    expect(saleNextChange(later, at('2026-11-30T23:00:00Z'))).toBe(3600_000);
    expect(saleNextChange(later, at('2026-12-01T00:00:00Z'))).toBeNull();
    expect(saleNextChange(null)).toBeNull();
  });
  it('is off without a sale or with an unreadable end', () => {
    expect(saleOpen(null)).toBe(false);
    expect(saleOpen({ ...sale, endsAt: 'soon' })).toBe(false);
  });
});

describe('prices', () => {
  it('works out the cut in whole percent, only for a real cut', () => {
    expect(percentOff(10, 7)).toBe(30);
    expect(percentOff(100, 70)).toBe(30);
    expect(percentOff(1, 0.7)).toBe(30);
    expect(percentOff(10, 10)).toBeNull();
    expect(percentOff(10, 12)).toBeNull();
    expect(percentOff(null, 7)).toBeNull();
  });
  it('says "every plan" only when every plan shown is cut alike', () => {
    expect(saleHeadline([30, 30, 30])).toBe('30% off every plan');
    expect(saleHeadline([30, 20])).toBe('up to 30% off');
    expect(saleHeadline([30, null])).toBe('up to 30% off');
    expect(saleHeadline([null, null])).toBeNull();
  });
  it('names the last day of the sale, not the day it is gone', () => {
    expect(saleLastDay(sale, 'en-GB')).toBe('30 November');
  });
});

describe('salePrices / planPricing', () => {
  const subOffer = { state: 'active', intervals: 'monthly=7.000,yearly=70.000' };
  const dayOffer = { state: 'active', one_time: 0.7 };
  const regular = { monthly: 10, yearly: 100, onetime: 1 };

  it('gives the sale offers’ prices while the sale is on', () => {
    expect(salePrices(true, subOffer, dayOffer)).toEqual({ monthly: 7, yearly: 70, onetime: 0.7 });
    const p = planPricing(regular, salePrices(true, subOffer, dayOffer));
    expect(p.priceOf('monthly')).toBe(7);
    expect(p.priceOf('onetime')).toBe(0.7);
    expect(p.percentFor('yearly')).toBe(30);
    expect(p.headline(['onetime', 'monthly', 'yearly'])).toBe('30% off every plan');
  });
  it('falls back to the regular prices once the sale is over', () => {
    const p = planPricing(regular, salePrices(false, subOffer, dayOffer));
    expect(p.onSale('monthly')).toBe(false);
    expect(p.priceOf('monthly')).toBe(10);
    expect(p.priceOf('onetime')).toBe(1);
    expect(p.headline(['onetime', 'monthly', 'yearly'])).toBeNull();
  });
  it('leaves out a sale offer that was closed early, or not created yet', () => {
    expect(salePrices(true, { ...subOffer, state: 'closed' }, dayOffer)).toEqual({ onetime: 0.7 });
    expect(salePrices(true, null, null)).toEqual({});
    const p = planPricing(regular, salePrices(true, null, dayOffer));
    expect(p.priceOf('monthly')).toBe(10);
    expect(p.headline(['onetime', 'monthly'])).toBe('up to 30% off');
  });
  it('reads the indexer’s day-pass price as a number or a string', () => {
    expect(salePrices(true, null, { state: 'active', one_time: '0.700' })).toEqual({ onetime: 0.7 });
    expect(parseIntervals('monthly=7.000, yearly=70.000')).toEqual({ monthly: 7, yearly: 70 });
  });
});

describe('resolveProConfig sale', () => {
  it('runs 3Speak’s sale on mainnet by default, none on testnet, and can be turned off', () => {
    expect(resolveProConfig().sale).toEqual(DEFAULT_PRO_SALE);
    expect(resolveProConfig({ network: 'testnet' }).sale).toBeNull();
    expect(resolveProConfig({ sale: null }).sale).toBeNull();
    expect(resolveProConfig({ sale }).sale).toBe(sale);
  });
  it('3Speak’s Cyber Week sale starts on 22 November and is gone on 1 December', () => {
    expect(saleOpen(DEFAULT_PRO_SALE, at('2026-11-21T23:59:59Z'))).toBe(false);
    expect(saleOpen(DEFAULT_PRO_SALE, at('2026-11-22T00:00:00Z'))).toBe(true);
    expect(saleOpen(DEFAULT_PRO_SALE, at('2026-11-30T23:00:00Z'))).toBe(true);
    expect(saleOpen(DEFAULT_PRO_SALE, at('2026-12-01T00:00:00Z'))).toBe(false);
  });
});
