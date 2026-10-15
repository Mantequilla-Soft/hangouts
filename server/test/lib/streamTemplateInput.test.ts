import { describe, it, expect } from 'vitest';
import {
  slugify, validateTemplateInput, defaultTemplateFields, SLUG_RE,
} from '../../src/lib/streamTemplateInput.js';

const defaults = defaultTemplateFields('alice');
const valid = (body: Record<string, unknown>) => validateTemplateInput({ name: 'Morning Show', title: 'Live', ...body }, defaults, 'alice');

describe('slugify', () => {
  it.each([
    ['Morning Show', 'morning-show'],
    ['  Café  Crème!! ', 'cafe-creme'],
    ['a---b___c', 'a-b-c'],
    ['UPPER lower 123', 'upper-lower-123'],
    ['🔥🔥', ''],
    ['x'.repeat(50), 'x'.repeat(40)],
    [`${'a'.repeat(39)} b`, 'a'.repeat(39)],
  ])('%j → %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
    if (slug) expect(SLUG_RE.test(slug)).toBe(true);
  });
});

describe('validateTemplateInput', () => {
  it('accepts a minimal template and fills defaults', () => {
    const r = valid({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slug).toBe('morning-show');
    expect(r.value.visibility).toBe('public');
    expect(r.value.boost.creatorPayoutAccount).toBe('alice');
    expect(r.value.recording).toEqual({ publishVod: false, allowClips: false });
    expect(r.value.announce.enabled).toBe(false);
  });

  it.each([
    [{ name: '' }, 'name'],
    [{ name: 'x'.repeat(61) }, 'name'],
    [{ title: '' }, 'title'],
    [{ title: 'x'.repeat(121) }, 'title'],
    [{ description: 'x'.repeat(5001) }, 'description'],
    [{ tags: Array(11).fill('t') }, 'tags'],
    [{ tags: ['x'.repeat(41)] }, 'tag'],
    [{ visibility: 'secret' }, 'visibility'],
    [{ language: 'english!' }, 'language'],
    [{ thumbnail: 'javascript:alert(1)' }, 'thumbnail'],
    [{ boost: { minBoostUsd: -1 } }, 'minBoostUsd'],
    [{ boost: { creatorPayoutAccount: 'Not A Name' } }, 'creatorPayoutAccount'],
    [{ recording: { publishVod: 'yes' } }, 'publishVod'],
    [{ announce: { community: 'my-community' } }, 'community'],
    [{ name: '🔥' }, 'letter or digit'],
  ])('rejects %j', (body, needle) => {
    const r = valid(body);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('invalid_input');
      expect(r.message).toContain(needle);
    }
  });

  it('validates beneficiaries: count, weights, total, duplicates', () => {
    const ben = (list: unknown[]) => valid({ announce: { enabled: true, beneficiaries: list } });
    expect(ben([{ account: 'bob', weight: 500 }, { account: 'carol', weight: 9500 }]).ok).toBe(true);
    expect(ben(Array.from({ length: 9 }, (_, i) => ({ account: `user${i}x`, weight: 1 }))).ok).toBe(false);
    expect(ben([{ account: 'bob', weight: 0 }]).ok).toBe(false);
    expect(ben([{ account: 'bob', weight: 10001 }]).ok).toBe(false);
    expect(ben([{ account: 'bob', weight: 1.5 }]).ok).toBe(false);
    expect(ben([{ account: 'bob', weight: 6000 }, { account: 'carol', weight: 4001 }]).ok).toBe(false);
    expect(ben([{ account: 'bob', weight: 1 }, { account: 'BOB', weight: 1 }]).ok).toBe(false);
    expect(ben([{ account: 'x', weight: 1 }]).ok).toBe(false);
  });

  it('merges a PATCH into the stored doc without leaking stored-only fields', () => {
    const created = valid({ announce: { enabled: true, community: 'hive-181335' } });
    if (!created.ok) throw new Error('setup');
    const stored = { ...created.value, _id: 'x', owner: 'alice', slug: created.slug, createdAt: new Date() };
    const r = validateTemplateInput({ announce: { declineRewards: true }, name: 'Evening Show' }, stored, 'alice');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.announce).toMatchObject({ enabled: true, community: 'hive-181335', declineRewards: true });
    expect(r.slug).toBe('evening-show');
    expect(r.value).not.toHaveProperty('_id');
    expect(r.value).not.toHaveProperty('owner');
    expect(r.value).not.toHaveProperty('slug');
    expect(r.value).not.toHaveProperty('createdAt');
  });

  it('treats an empty payout account as the owner', () => {
    const r = valid({ boost: { creatorPayoutAccount: '' } });
    expect(r.ok && r.value.boost.creatorPayoutAccount).toBe('alice');
  });
});
