import { ObjectId } from 'mongodb';
import type { TemplateDoc } from '../../src/lib/streamTemplates.js';
import type { TemplateFields } from '../../src/lib/streamTemplateInput.js';
import {
  generateStreamSecret, hashStreamSecret, verifyStreamSecret,
} from '../../src/lib/streamSecrets.js';

/**
 * In-memory stand-in for lib/streamTemplates.ts (the Mongo layer), with the
 * same {owner, slug} uniqueness and hash-only secret storage, so route tests
 * exercise real behaviour without a database.
 */
export function createFakeStore() {
  const templates = new Map<string, TemplateDoc>();
  const secrets = new Map<string, { hash: string; plain: string }>();
  class StoreUnavailableError extends Error {}

  const clash = (owner: string, slug: string, exceptId?: string) =>
    [...templates.values()].some((t) => t.owner === owner && t.slug === slug && t._id.toHexString() !== exceptId);

  return {
    _templates: templates,
    _secrets: secrets,
    StoreUnavailableError,
    listTemplates: async (owner: string) => [...templates.values()].filter((t) => t.owner === owner),
    countTemplates: async (owner: string) => [...templates.values()].filter((t) => t.owner === owner).length,
    getTemplate: async (owner: string, id: string) => {
      const t = templates.get(id);
      return t && t.owner === owner ? t : null;
    },
    getTemplateById: async (id: string) => templates.get(id) ?? null,
    findTemplateBySlug: async (owner: string, slug: string) =>
      [...templates.values()].find((t) => t.owner === owner && t.slug === slug) ?? null,
    insertTemplate: async (owner: string, fields: TemplateFields, slug: string) => {
      if (clash(owner, slug)) return 'name_taken' as const;
      const now = new Date();
      const doc: TemplateDoc = { ...fields, _id: new ObjectId(), owner, slug, createdAt: now, updatedAt: now, lastLiveAt: null };
      templates.set(doc._id.toHexString(), doc);
      return doc;
    },
    updateTemplate: async (owner: string, id: string, fields: TemplateFields, slug: string) => {
      const t = templates.get(id);
      if (!t || t.owner !== owner) return null;
      if (clash(owner, slug, id)) return 'name_taken' as const;
      const doc = { ...t, ...fields, slug, updatedAt: new Date() };
      templates.set(id, doc);
      return doc;
    },
    deleteTemplate: async (owner: string, id: string) => {
      const t = templates.get(id);
      if (!t || t.owner !== owner) return false;
      templates.delete(id);
      return true;
    },
    setTemplateLastLiveAt: async (id: string, at: Date) => {
      const t = templates.get(id);
      if (t) t.lastLiveAt = at;
    },
    getOrCreateStreamSecret: async (owner: string) => {
      let s = secrets.get(owner);
      if (!s) {
        const plain = generateStreamSecret();
        s = { hash: hashStreamSecret(plain), plain };
        secrets.set(owner, s);
      }
      return s.plain;
    },
    resetStreamSecret: async (owner: string) => {
      const plain = generateStreamSecret();
      secrets.set(owner, { hash: hashStreamSecret(plain), plain });
      return plain;
    },
    checkStreamSecret: async (owner: string, presented: string) => {
      const s = secrets.get(owner);
      return !!s && verifyStreamSecret(presented, s.hash);
    },
  };
}
