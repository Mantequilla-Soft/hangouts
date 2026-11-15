/**
 * Stream health for hosts (H20): turn the publisher's WebRTC stats into
 * numbers a streamer can act on, decide when the uplink is too weak, and step
 * the composed track's quality down (and back up) without a republish.
 *
 * Everything comes from the HOST's own browser: `getStats()` on the published
 * video sender, plus the encodings LiveKit's dynacast switches on and off for
 * what viewers subscribe to. That last part is "the quality viewers actually
 * get": a layer is only sent while at least one viewer is watching it. No
 * server polling, no per-viewer reports.
 *
 * Pure functions here; hooks/useStreamHealth.ts runs them every couple of
 * seconds and applies the result.
 */

/** One layer (simulcast rid, or the single encoding) as getStats reports it. */
export interface LayerSample {
  rid: string;
  bytesSent: number;
  packetsSent: number;
  /** Packets the server reported lost (remote-inbound-rtp). */
  packetsLost: number;
  framesSent: number;
  framesPerSecond: number;
  frameWidth: number;
  frameHeight: number;
  roundTripTime?: number;
  targetBitrate?: number;
  qualityLimitationReason?: string;
  /** Seconds spent limited, per reason, since the sender started. */
  qualityLimitationDurations?: Record<string, number>;
}

export interface HealthSample {
  /** ms timestamp of the sample. */
  at: number;
  layers: LayerSample[];
  /** Encodings currently switched on (dynacast: someone watches them). */
  activeRids: string[];
  /** Frames the studio's compositor drew since the last sample. */
  composedFrames: number;
}

export type EncoderLimit = 'none' | 'bandwidth' | 'cpu' | 'other';

export interface StreamHealth {
  /** Upload video bitrate (all layers), kbit/s. */
  bitrateKbps: number;
  /** What the encoder aims for, kbit/s (0 = unknown). */
  targetKbps: number;
  /** Frames per second the studio composed. */
  composedFps: number;
  /** Frames per second the top active layer actually sent. */
  sentFps: number;
  /** Size of the biggest layer being sent. */
  sentWidth: number;
  sentHeight: number;
  /** Composed frames that never made it out, % (0..100). */
  droppedPct: number;
  /** Packets lost on the way to the server, % (0..100). */
  lossPct: number;
  rttMs: number;
  /** What holds the encoder back, mostly, over the last interval. */
  limit: EncoderLimit;
  /** Heights of the layers being sent, best first: what viewers can get. */
  viewerHeights: number[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The interval between two samples, as health numbers. */
export function computeHealth(prev: HealthSample, cur: HealthSample): StreamHealth {
  const dt = Math.max(0.001, (cur.at - prev.at) / 1000);
  const byRid = new Map(prev.layers.map((l) => [l.rid, l]));
  const deltas = cur.layers.map((l) => {
    const p = byRid.get(l.rid);
    return {
      layer: l,
      bytes: Math.max(0, l.bytesSent - (p?.bytesSent ?? l.bytesSent)),
      packets: Math.max(0, l.packetsSent - (p?.packetsSent ?? l.packetsSent)),
      lost: Math.max(0, l.packetsLost - (p?.packetsLost ?? l.packetsLost)),
      frames: Math.max(0, l.framesSent - (p?.framesSent ?? l.framesSent)),
      limited: limitedSeconds(l.qualityLimitationDurations, p?.qualityLimitationDurations),
    };
  });
  const sending = deltas.filter((d) => d.bytes > 0 && d.layer.frameHeight > 0);
  const top = [...sending].sort((a, b) => b.layer.frameHeight - a.layer.frameHeight)[0];
  const packets = sum(deltas.map((d) => d.packets));
  const lost = sum(deltas.map((d) => d.lost));
  const rtts = cur.layers.map((l) => l.roundTripTime).filter((v): v is number => typeof v === 'number' && v > 0);
  const composedFps = cur.composedFrames / dt;
  const sentFps = top ? top.frames / dt : 0;

  // The limitation of the top layer, by where its time went this interval;
  // the instantaneous reason as a fallback (older browsers have no durations).
  let limit: EncoderLimit = 'none';
  const lim = top?.limited;
  if (lim && lim.total > 0) {
    const [reason, secs] = Object.entries(lim.by).sort((a, b) => b[1] - a[1])[0] ?? ['none', 0];
    if (reason !== 'none' && secs / dt > 0.3) limit = asLimit(reason);
  } else if (top?.layer.qualityLimitationReason) {
    limit = asLimit(top.layer.qualityLimitationReason);
  }

  return {
    bitrateKbps: Math.round((sum(deltas.map((d) => d.bytes)) * 8) / dt / 1000),
    targetKbps: Math.round(sum(cur.layers.map((l) => l.targetBitrate ?? 0)) / 1000),
    composedFps: Math.round(composedFps * 10) / 10,
    sentFps: Math.round(sentFps * 10) / 10,
    sentWidth: top?.layer.frameWidth ?? 0,
    sentHeight: top?.layer.frameHeight ?? 0,
    droppedPct: composedFps > 0 && top ? Math.round(Math.max(0, 1 - sentFps / composedFps) * 1000) / 10 : 0,
    lossPct: packets + lost > 0 ? Math.round((lost / (packets + lost)) * 1000) / 10 : 0,
    rttMs: rtts.length ? Math.round((sum(rtts) / rtts.length) * 1000) : 0,
    limit,
    viewerHeights: [...new Set(sending
      .filter((d) => cur.activeRids.length === 0 || cur.activeRids.includes(d.layer.rid))
      .map((d) => d.layer.frameHeight))].sort((a, b) => b - a),
  };
}

function asLimit(reason: string): EncoderLimit {
  return reason === 'bandwidth' || reason === 'cpu' || reason === 'none' ? reason : 'other';
}

function limitedSeconds(cur?: Record<string, number>, prev?: Record<string, number>): { total: number; by: Record<string, number> } | null {
  if (!cur) return null;
  const by: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of Object.entries(cur)) {
    const d = Math.max(0, v - (prev?.[k] ?? v));
    by[k] = d;
    total += d;
  }
  return { total, by };
}

export type Verdict = 'good' | 'weak' | 'bad';

export interface Assessment {
  verdict: Verdict;
  /** Plain reasons, worst first, for the panel and the warning. */
  reasons: string[];
  /** The device, not the network, is what struggles. */
  cpu: boolean;
}

/**
 * Is the uplink healthy? Thresholds are deliberately early: the point is to
 * warn (and give ground) before viewers start buffering.
 */
export function assessHealth(h: StreamHealth, connection: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown' = 'unknown'): Assessment {
  const reasons: string[] = [];
  let score = 0;
  if (connection === 'lost') { score += 3; reasons.push('Connection to the server lost'); }
  else if (connection === 'poor') { score += 1; reasons.push('The server rates your connection as weak'); }
  if (h.lossPct >= 8) { score += 2; reasons.push(`${h.lossPct}% of packets lost`); }
  else if (h.lossPct >= 3) { score += 1; reasons.push(`${h.lossPct}% of packets lost`); }
  if (h.rttMs >= 700) { score += 2; reasons.push(`Slow round trip (${h.rttMs} ms)`); }
  else if (h.rttMs >= 350) { score += 1; reasons.push(`Round trip ${h.rttMs} ms`); }
  if (h.limit === 'bandwidth') { score += 1; reasons.push('The encoder is held back by your upload'); }
  if (h.targetKbps > 0 && h.bitrateKbps > 0 && h.bitrateKbps < h.targetKbps * 0.5) {
    score += 1; reasons.push('Sending far below the planned bitrate');
  }
  const cpu = h.limit === 'cpu' || (h.droppedPct >= 25 && h.composedFps > 0);
  if (h.limit === 'cpu') { score += 1; reasons.push('Your device is too busy to encode at full quality'); }
  if (h.droppedPct >= 25) { score += 1; reasons.push(`${h.droppedPct}% of frames dropped`); }
  if (h.composedFps > 0 && h.composedFps < 20) { score += 1; reasons.push(`The studio only draws ${h.composedFps} fps`); }
  const verdict: Verdict = score >= 3 ? 'bad' : score >= 1 ? 'weak' : 'good';
  return { verdict, reasons, cpu };
}

/** Quality steps, mildest first. Multipliers apply to each encoding's own
 *  bitrate and resolution, so simulcast layers keep their proportions. */
export const QUALITY_STEPS = [
  { bitrate: 1, scale: 1, fps: 30, label: 'Full quality' },
  { bitrate: 0.7, scale: 1, fps: 30, label: 'Lower bitrate' },
  { bitrate: 0.5, scale: 1, fps: 24, label: 'Lower bitrate, 24 fps' },
  { bitrate: 0.38, scale: 1.5, fps: 24, label: 'Smaller picture, 24 fps' },
  { bitrate: 0.28, scale: 2, fps: 15, label: 'Smallest picture, 15 fps' },
] as const;
export const MAX_STEP = QUALITY_STEPS.length - 1;

export interface ControllerState {
  level: number;
  /** Consecutive samples per verdict. */
  weakRun: number;
  goodRun: number;
  /** ms of the last level change (no new change within the hold time). */
  changedAt: number;
}

export const INITIAL_CONTROLLER: ControllerState = { level: 0, weakRun: 0, goodRun: 0, changedAt: 0 };

/** Two weak samples (about 4 s) to step down; 10 good ones (about 20 s) to
 *  step back up; and at least HOLD_MS between changes so it never flaps. */
export const DOWN_AFTER = 2;
export const UP_AFTER = 10;
export const HOLD_MS = 6000;

export function stepController(s: ControllerState, verdict: Verdict, now: number): ControllerState {
  const weakRun = verdict === 'good' ? 0 : s.weakRun + 1;
  const goodRun = verdict === 'good' ? s.goodRun + 1 : 0;
  const held = now - s.changedAt < HOLD_MS;
  if (!held && s.level < MAX_STEP && (verdict === 'bad' ? weakRun >= 1 : weakRun >= DOWN_AFTER)) {
    // A really bad sample goes two steps at once.
    const level = Math.min(MAX_STEP, s.level + (verdict === 'bad' && weakRun >= 2 ? 2 : 1));
    return { level, weakRun: 0, goodRun: 0, changedAt: now };
  }
  if (!held && s.level > 0 && goodRun >= UP_AFTER) {
    return { level: s.level - 1, weakRun: 0, goodRun: 0, changedAt: now };
  }
  return { ...s, weakRun, goodRun };
}

/** An encoding's adjustable fields, as first published. */
export interface BaseEncoding {
  rid?: string;
  maxBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
}

/**
 * The encodings for a step, from the ones the track was published with. Only
 * bitrate, frame rate and scale change; `active` (dynacast) is left alone.
 */
export function encodingsForStep<E extends BaseEncoding>(current: E[], base: BaseEncoding[], level: number): E[] {
  const step = QUALITY_STEPS[Math.max(0, Math.min(MAX_STEP, level))];
  return current.map((e, i) => {
    const b = base.find((x) => (x.rid ?? '') === (e.rid ?? '')) ?? base[i] ?? {};
    const next = { ...e };
    if (b.maxBitrate) next.maxBitrate = Math.max(80_000, Math.round(b.maxBitrate * step.bitrate));
    next.maxFramerate = Math.min(b.maxFramerate ?? 30, step.fps);
    next.scaleResolutionDownBy = Math.round((b.scaleResolutionDownBy ?? 1) * step.scale * 100) / 100;
    return next;
  });
}

/** "720p", "720p and 360p", "nobody watching yet". */
export function describeViewerQuality(heights: number[]): string {
  if (!heights.length) return 'No video being sent';
  const ps = heights.map((h) => `${h}p`);
  return ps.length === 1 ? `Up to ${ps[0]}` : `${ps.slice(0, -1).join(', ')} and ${ps[ps.length - 1]}`;
}
