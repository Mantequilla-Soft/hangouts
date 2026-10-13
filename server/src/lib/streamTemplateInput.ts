import { LANGUAGE_RE, ROOM_VISIBILITIES, type RoomVisibility } from './streamRoom.js';

/**
 * Stream templates: validation + slug rules (pure — no I/O, unit-tested).
 *
 * A template is everything the browser studio's create dialog + post composer
 * would collect, saved ahead of time so going live from OBS needs no browser:
 * OBS connects to `/whip/<owner>/<slug>` and the server creates the room from
 * the template. Limits mirror POST /rooms and PATCH /rooms/:name/post so a
 * template can never produce a room the studio couldn't have.
 */

export interface Beneficiary { account: string; weight: number }

export interface TemplateFields {
  name: string;
  title: string;
  description: string;
  thumbnail: string;
  tags: string[];
  language: string;
  visibility: RoomVisibility;
  boost: { enabled: boolean; minBoostUsd: number; creatorPayoutAccount: string };
  recording: { publishVod: boolean; allowClips: boolean };
  announce: {
    enabled: boolean;
    community: string;
    communityTitle: string;
    declineRewards: boolean;
    rewardPowerup: boolean;
    beneficiaries: Beneficiary[];
  };
}

export const MAX_TEMPLATES_PER_USER = 20;
export const MAX_SLUG_LEN = 40;

export const HIVE_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const COMMUNITY_RE = /^hive-\d{1,7}$/;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Template name → URL slug: lowercase ASCII [a-z0-9-], accents folded, runs of
 * anything else collapsed to one dash, trimmed, max 40. Returns '' when nothing
 * usable is left (a name made only of emoji) — the caller rejects that rather
 * than inventing a slug the user never chose.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, '');
}

export function defaultTemplateFields(owner: string): Omit<TemplateFields, 'name' | 'title'> {
  return {
    description: '',
    thumbnail: '',
    tags: [],
    language: '',
    visibility: 'public',
    boost: { enabled: true, minBoostUsd: 0, creatorPayoutAccount: owner },
    recording: { publishVod: false, allowClips: false },
    announce: {
      enabled: false,
      community: '',
      communityTitle: '',
      declineRewards: false,
      rewardPowerup: false,
      beneficiaries: [],
    },
  };
}

export type ValidationResult =
  | { ok: true; value: TemplateFields; slug: string }
  | { ok: false; error: 'invalid_input'; message: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a create body (`base` = defaults) or a PATCH body (`base` = the
 * stored template). Nested objects (boost/recording/announce) merge field by
 * field, so a PATCH can send just `{ announce: { enabled: true } }`. The WHOLE
 * merged result is validated — a partial update can't sneak in a combination
 * (e.g. beneficiaries over 100%) that a full create would reject.
 */
export function validateTemplateInput(
  raw: unknown,
  base: Partial<TemplateFields> & Omit<TemplateFields, 'name' | 'title'>,
  owner: string,
): ValidationResult {
  const fail = (message: string): ValidationResult => ({ ok: false, error: 'invalid_input', message });
  if (!isObj(raw)) return fail('Body must be a JSON object');

  const str = (key: string, max: number, min = 0): string | undefined | ValidationResult => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') return fail(`${key} must be a string`);
    const t = v.trim();
    if (t.length < min || t.length > max) return fail(`${key} must be ${min}-${max} characters`);
    return t;
  };

  // Copy ONLY the template fields: `base` may be a stored doc (_id, owner,
  // slug, timestamps), and those must never flow back into a $set.
  const out = {
    name: base.name ?? '',
    title: base.title ?? '',
    description: base.description,
    thumbnail: base.thumbnail,
    tags: [...base.tags],
    language: base.language,
    visibility: base.visibility,
    boost: { ...base.boost },
    recording: { ...base.recording },
    announce: { ...base.announce, beneficiaries: [...base.announce.beneficiaries] },
  } as TemplateFields;

  for (const [key, max, min] of [['name', 60, 1], ['title', 120, 1], ['description', 5000, 0]] as const) {
    const r = str(key, max, min);
    if (typeof r === 'object') return r;
    if (r !== undefined) out[key] = r;
  }
  if (!out.name) return fail('name is required');
  if (!out.title) return fail('title is required');

  const thumb = str('thumbnail', 512);
  if (typeof thumb === 'object') return thumb;
  if (thumb !== undefined) {
    // A thumbnail ends up in <img src> and in the Hive post — http(s) only.
    if (thumb && !/^https?:\/\/\S+$/i.test(thumb)) return fail('thumbnail must be an http(s) URL');
    out.thumbnail = thumb;
  }

  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.length > 10) return fail('tags must be an array of at most 10');
    const tags: string[] = [];
    for (const t of raw.tags) {
      if (typeof t !== 'string' || t.trim().length > 40) return fail('each tag must be a string of at most 40 characters');
      if (t.trim()) tags.push(t.trim());
    }
    out.tags = tags;
  }

  if (raw.language !== undefined) {
    if (typeof raw.language !== 'string') return fail('language must be a string');
    const l = raw.language.trim();
    if (l && !LANGUAGE_RE.test(l)) return fail('language must be a language tag like "en" or "pt-BR"');
    out.language = l;
  }

  if (raw.visibility !== undefined) {
    if (!(ROOM_VISIBILITIES as readonly unknown[]).includes(raw.visibility)) {
      return fail(`visibility must be one of ${ROOM_VISIBILITIES.join(', ')}`);
    }
    out.visibility = raw.visibility as RoomVisibility;
  }

  if (raw.boost !== undefined) {
    if (!isObj(raw.boost)) return fail('boost must be an object');
    const b = raw.boost;
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') return fail('boost.enabled must be a boolean');
      out.boost.enabled = b.enabled;
    }
    if (b.minBoostUsd !== undefined) {
      if (typeof b.minBoostUsd !== 'number' || !Number.isFinite(b.minBoostUsd) || b.minBoostUsd < 0 || b.minBoostUsd > 100000) {
        return fail('boost.minBoostUsd must be a number >= 0');
      }
      out.boost.minBoostUsd = b.minBoostUsd;
    }
    if (b.creatorPayoutAccount !== undefined) {
      if (typeof b.creatorPayoutAccount !== 'string') return fail('boost.creatorPayoutAccount must be a string');
      const acct = b.creatorPayoutAccount.trim().toLowerCase();
      if (acct && !HIVE_ACCOUNT_RE.test(acct)) return fail('boost.creatorPayoutAccount must be a Hive account name');
      // Empty means "me", same as POST /rooms.
      out.boost.creatorPayoutAccount = acct || owner;
    }
  }

  if (raw.recording !== undefined) {
    if (!isObj(raw.recording)) return fail('recording must be an object');
    for (const k of ['publishVod', 'allowClips'] as const) {
      const v = raw.recording[k];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') return fail(`recording.${k} must be a boolean`);
      out.recording[k] = v;
    }
  }

  if (raw.announce !== undefined) {
    if (!isObj(raw.announce)) return fail('announce must be an object');
    const a = raw.announce;
    for (const k of ['enabled', 'declineRewards', 'rewardPowerup'] as const) {
      if (a[k] === undefined) continue;
      if (typeof a[k] !== 'boolean') return fail(`announce.${k} must be a boolean`);
      out.announce[k] = a[k] as boolean;
    }
    if (a.community !== undefined) {
      if (typeof a.community !== 'string') return fail('announce.community must be a string');
      const c = a.community.trim();
      if (c && !COMMUNITY_RE.test(c)) return fail('announce.community must be a Hive community id like "hive-181335"');
      out.announce.community = c;
    }
    if (a.communityTitle !== undefined) {
      if (typeof a.communityTitle !== 'string' || a.communityTitle.trim().length > 100) {
        return fail('announce.communityTitle must be a string of at most 100 characters');
      }
      out.announce.communityTitle = a.communityTitle.trim();
    }
    if (a.beneficiaries !== undefined) {
      if (!Array.isArray(a.beneficiaries) || a.beneficiaries.length > 8) {
        return fail('announce.beneficiaries must be an array of at most 8');
      }
      const seen = new Set<string>();
      const list: Beneficiary[] = [];
      for (const b of a.beneficiaries) {
        if (!isObj(b) || typeof b.account !== 'string' || typeof b.weight !== 'number') {
          return fail('each beneficiary needs an account and a weight');
        }
        const account = b.account.trim().toLowerCase();
        if (!HIVE_ACCOUNT_RE.test(account)) return fail(`beneficiary "${account}" is not a Hive account name`);
        if (!Number.isInteger(b.weight) || b.weight < 1 || b.weight > 10000) {
          return fail('beneficiary weight must be a whole number of basis points, 1-10000');
        }
        // Hive rejects a comment_options op with a duplicate beneficiary.
        if (seen.has(account)) return fail(`beneficiary "${account}" is listed twice`);
        seen.add(account);
        list.push({ account, weight: b.weight });
      }
      out.announce.beneficiaries = list;
    }
    const total = out.announce.beneficiaries.reduce((s, b) => s + b.weight, 0);
    if (total > 10000) return fail('beneficiary weights add up to more than 100%');
  }

  const slug = slugify(out.name);
  if (!slug) return fail('name must contain at least one letter or digit (it becomes the stream address)');
  return { ok: true, value: out, slug };
}
