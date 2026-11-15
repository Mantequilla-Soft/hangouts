/**
 * Live captions: who is allowed to caption right now.
 *
 * Captioning runs in the HOST's browser: it streams the host's own microphone
 * to the self-hosted speech-to-text server (the same one the teleprompter
 * uses) and sends the text to viewers over the LiveKit data channel. Nothing
 * of the audio passes through this server. The only thing this server does is
 * hand out a small number of caption SLOTS, so the speech box never has more
 * than CAPTIONS_MAX_STREAMS continuous recognitions from live streams at once
 * (one recognition costs about a tenth of a CPU core there, all day long).
 *
 * A slot belongs to one room and its host, and lives for `ttlMs` unless the
 * host renews it (the studio does every 30 s). A studio that vanishes (tab
 * closed, phone died) simply stops renewing and the slot frees itself.
 *
 * In memory on purpose: one process, at most `max` entries, and a restart only
 * means each captioning studio takes its slot again on its next renewal.
 */

export interface CaptionSlot {
  room: string;
  host: string;
  lang: string;
  since: number;
  expiresAt: number;
}

export type AcquireResult =
  | { ok: true; slot: CaptionSlot; fresh: boolean }
  | { ok: false; reason: 'full' | 'taken' };

/** Speech model codes as the STT server names them: `en-us`, `de`, `pt-br`. */
export const CAPTION_LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

export class CaptionSlots {
  private slots = new Map<string, CaptionSlot>();
  /** Rooms whose slot lapsed since the last sweep(), so their CC flag can be cleared. */
  private lapsed = new Set<string>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Take (or renew) the slot for `room`. Renewing the room's own slot always
   * works, even when every slot is in use; a NEW slot needs a free one. A slot
   * held by another account for the same room (a host handover) is `taken`
   * until it expires.
   */
  acquire(room: string, host: string, lang: string): AcquireResult {
    this.prune();
    const t = this.now();
    const held = this.slots.get(room);
    if (held) {
      if (held.host !== host) return { ok: false, reason: 'taken' };
      held.expiresAt = t + this.ttlMs;
      const langChanged = held.lang !== lang;
      held.lang = lang;
      return { ok: true, slot: { ...held }, fresh: langChanged };
    }
    if (this.slots.size >= this.max) return { ok: false, reason: 'full' };
    const slot: CaptionSlot = { room, host, lang, since: t, expiresAt: t + this.ttlMs };
    this.slots.set(room, slot);
    this.lapsed.delete(room);
    return { ok: true, slot: { ...slot }, fresh: true };
  }

  /** Give the room's slot back. Only its own host can; true when one was freed. */
  release(room: string, host: string): boolean {
    const held = this.slots.get(room);
    if (!held || held.host !== host) return false;
    this.slots.delete(room);
    return true;
  }

  private prune(): void {
    const t = this.now();
    for (const [room, s] of this.slots) {
      if (s.expiresAt <= t) { this.slots.delete(room); this.lapsed.add(room); }
    }
  }

  /** Remove expired slots; returns every room whose slot lapsed since the last sweep. */
  sweep(): string[] {
    this.prune();
    const gone = [...this.lapsed];
    this.lapsed.clear();
    return gone;
  }

  get(room: string): CaptionSlot | null {
    this.prune();
    const s = this.slots.get(room);
    return s ? { ...s } : null;
  }

  get active(): number {
    this.prune();
    return this.slots.size;
  }

  get capacity(): number {
    return this.max;
  }
}
