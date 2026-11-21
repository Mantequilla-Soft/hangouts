/**
 * A Pro sale: lower prices for a while, without touching the regular offers.
 *
 * The subscription contract can't change a price once an offer exists, so a
 * sale is a second pair of offers (subscription + day pass) at the lower
 * prices. From `startsAt` until `endsAt` the plans show and sell those; outside
 * that window the plans don't offer them, whatever the offers' own state. Subscriptions bought in the sale
 * stay visible (status, cancel) until their prepaid balance runs out, but take
 * no more top-ups: those would buy months at the sale price after it ended.
 */
export interface ProSale {
  /** Subscription offer with the sale prices (monthly + yearly). */
  subOfferId: number;
  /** Day-pass offer with the sale price. */
  onetimeOfferId: number;
  /** When the sale prices are first offered (ISO time); unset: at once. */
  startsAt?: string;
  /** When the sale prices stop being offered (ISO time). */
  endsAt: string;
  /** What the sale is called on the plans, e.g. "Cyber Week". */
  label: string;
}

/** 3Speak's Cyber Week 2026 sale: 30% off every plan, 22 to 30 November. */
export const DEFAULT_PRO_SALE: ProSale = {
  subOfferId: 7,
  onetimeOfferId: 6,
  startsAt: '2026-11-22T00:00:00Z',
  endsAt: '2026-12-01T00:00:00Z',
  label: 'Cyber Week',
};

/** Is the sale on at `now`? */
export function saleOpen(sale: ProSale | null | undefined, now = Date.now()): sale is ProSale {
  if (!sale) return false;
  const start = sale.startsAt ? Date.parse(sale.startsAt) : -Infinity;
  const end = Date.parse(sale.endsAt);
  return !Number.isNaN(start) && Number.isFinite(end) && now >= start && now < end;
}

/** Milliseconds until the sale next starts or ends, or null when nothing is left to change. */
export function saleNextChange(sale: ProSale | null | undefined, now = Date.now()): number | null {
  if (!sale) return null;
  const times = [sale.startsAt ? Date.parse(sale.startsAt) : NaN, Date.parse(sale.endsAt)];
  const next = times.filter((t) => Number.isFinite(t) && t > now).sort((a, b) => a - b)[0];
  return next === undefined ? null : next - now;
}

/** Whole percent the sale price is below the regular one, or null when it isn't. */
export function percentOff(regular: number | null | undefined, sale: number | null | undefined): number | null {
  if (!regular || !sale || !(regular > 0) || !(sale > 0) || sale >= regular) return null;
  return Math.round((1 - sale / regular) * 100);
}

/** "30% off every plan" when every plan is cut alike, else "up to 30% off". */
export function saleHeadline(percents: (number | null)[]): string | null {
  const known = percents.filter((p): p is number => p != null);
  if (!known.length) return null;
  const max = Math.max(...known);
  return known.every((p) => p === max) && known.length === percents.length
    ? `${max}% off every plan`
    : `up to ${max}% off`;
}

/** The last day of the sale, for "until 30 November" (`endsAt` is the first moment after it). */
export function saleLastDay(sale: ProSale, locale?: string): string {
  return new Date(Date.parse(sale.endsAt) - 1).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Parse `"monthly=5.000,yearly=50.000"` into `{ monthly: 5, yearly: 50 }`. */
export function parseIntervals(intervalsStr?: string): Record<string, number> {
  if (!intervalsStr) return {};
  const result: Record<string, number> = {};
  for (const pair of intervalsStr.split(',')) {
    const [interval, price] = pair.split('=');
    if (interval && price) result[interval.trim()] = parseFloat(price);
  }
  return result;
}

/** What the plans need of an offer row from the indexer. */
export interface SaleOfferRow {
  state?: string;
  intervals?: string;
  one_time?: string | number;
}

/**
 * The sale prices by plan (the intervals, and `onetime` for the day pass), or
 * none: when the sale is over, or for an offer that isn't open (closed early).
 */
export function salePrices(open: boolean, subOffer?: SaleOfferRow | null, onetimeOffer?: SaleOfferRow | null): Record<string, number> {
  if (!open) return {};
  const out: Record<string, number> = subOffer?.state === 'active' ? parseIntervals(subOffer.intervals) : {};
  const day = parseFloat(String(onetimeOffer?.one_time ?? '')) || 0;
  if (onetimeOffer?.state === 'active' && day > 0) out.onetime = day;
  return out;
}

/** Each plan's price now, given the regular prices and the sale's (`salePrices`). */
export function planPricing(regular: Record<string, number | null>, sale: Record<string, number>) {
  const onSale = (plan: string) => (sale[plan] ?? 0) > 0;
  const percentFor = (plan: string) => (onSale(plan) ? percentOff(regular[plan], sale[plan]) : null);
  return {
    onSale,
    /** The sale price while it is on, else the regular one. */
    priceOf: (plan: string): number | null => (onSale(plan) ? sale[plan] : regular[plan] ?? null),
    percentFor,
    /** "30% off every plan" over the plans shown, null when none is on sale. */
    headline: (plans: string[]) => saleHeadline(plans.map(percentFor)),
  };
}
