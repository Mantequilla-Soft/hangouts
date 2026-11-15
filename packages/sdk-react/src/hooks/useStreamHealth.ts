import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ConnectionQuality, type LocalParticipant, type LocalVideoTrack } from 'livekit-client';
import {
  assessHealth, computeHealth, encodingsForStep, stepController, INITIAL_CONTROLLER, QUALITY_STEPS,
  type Assessment, type BaseEncoding, type ControllerState, type HealthSample, type StreamHealth,
} from '../lib/streamHealth.js';

/** How often the publisher's stats are read. getStats on one sender is cheap. */
export const HEALTH_POLL_MS = 2000;

export interface StreamHealthState {
  health: StreamHealth | null;
  assessment: Assessment | null;
  /** 0 = full quality; higher = stepped down (QUALITY_STEPS). */
  level: number;
  stepLabel: string;
  auto: boolean;
  setAuto: (on: boolean) => void;
  /** Can this browser change the encoder live (not Firefox, see below)? */
  canAuto: boolean;
  /** The last automatic change, for a short notice: 'down' | 'up' and when. */
  lastChange: { dir: 'down' | 'up'; at: number } | null;
}

function connLabel(q: ConnectionQuality): 'excellent' | 'good' | 'poor' | 'lost' | 'unknown' {
  switch (q) {
    case ConnectionQuality.Excellent: return 'excellent';
    case ConnectionQuality.Good: return 'good';
    case ConnectionQuality.Poor: return 'poor';
    case ConnectionQuality.Lost: return 'lost';
    default: return 'unknown';
  }
}

/** Firefox ignores `encoding.active`, and LiveKit works around that by
 *  rewriting bitrate and scale on the same encodings, which this would fight. */
function liveEncoderChangesWork(): boolean {
  if (typeof navigator === 'undefined') return false;
  return !/Firefox\/|FxiOS/i.test(navigator.userAgent || '');
}

const AUTO_KEY = 'hh-studio-auto-quality';

/**
 * Reads the studio's published video senders every HEALTH_POLL_MS, works out
 * the stream's health, and (when Auto is on) steps the encoder down while the
 * uplink is weak and back up once it has been fine for a while. Changes go
 * through RTCRtpSender.setParameters on the live sender: no republish, so
 * viewers, the recording and the DVR keep the same track.
 *
 * `trackNames`: the program first, then any other video the studio publishes
 * (the vertical phone version), which follows the same step.
 */
export function useStreamHealth(opts: {
  localParticipant: LocalParticipant | undefined;
  /** False until the program is published. */
  published: boolean;
  trackNames: string[];
  /** Incremented by the compositor on every frame it draws. */
  framesRef: MutableRefObject<number>;
  connectionQuality: ConnectionQuality;
}): StreamHealthState {
  const { localParticipant, published, trackNames, framesRef, connectionQuality } = opts;
  const [health, setHealth] = useState<StreamHealth | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [level, setLevel] = useState(0);
  const [lastChange, setLastChange] = useState<StreamHealthState['lastChange']>(null);
  const canAuto = liveEncoderChangesWork();
  const [auto, setAutoState] = useState(() => {
    try { return window.localStorage.getItem(AUTO_KEY) !== '0'; } catch { return true; }
  });
  const setAuto = useCallback((on: boolean) => {
    setAutoState(on);
    try { window.localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  }, []);

  const connRef = useRef(connectionQuality);
  connRef.current = connectionQuality;
  const autoRef = useRef(auto && canAuto);
  autoRef.current = auto && canAuto;
  const namesKey = trackNames.join('|');

  useEffect(() => {
    if (!published || !localParticipant) return undefined;
    let prev: HealthSample | null = null;
    let prevSid = '';
    let ctl: ControllerState = INITIAL_CONTROLLER;
    // The encodings each track was published with, by track sid.
    const bases = new Map<string, BaseEncoding[]>();
    let applied = 0;
    // Tracks that carry the current step (a vertical published later joins in).
    const appliedTo = new Set<string>();
    let alive = true;

    const tracks = (): LocalVideoTrack[] => namesKey.split('|')
      .map((n) => localParticipant.getTrackPublicationByName(n)?.track as LocalVideoTrack | undefined)
      .filter((t): t is LocalVideoTrack => !!t && t.kind === 'video');

    const apply = async (lvl: number) => {
      for (const t of tracks()) {
        const sender = t.sender;
        if (!sender?.getParameters) continue;
        try {
          const params = sender.getParameters();
          if (!params.encodings?.length) continue;
          const sid = t.sid ?? '';
          if (!bases.has(sid)) {
            bases.set(sid, params.encodings.map((e) => ({
              rid: e.rid, maxBitrate: e.maxBitrate, maxFramerate: e.maxFramerate, scaleResolutionDownBy: e.scaleResolutionDownBy,
            })));
          }
          params.encodings = encodingsForStep(params.encodings, bases.get(sid)!, lvl);
          await sender.setParameters(params);
          appliedTo.add(sid);
        } catch { /* sender renegotiating: next sample tries again */ }
      }
      applied = lvl;
    };

    const sample = async () => {
      const [program] = tracks();
      if (!program) return;
      // A republish (quality tier change) is a new track: start over from its
      // own encodings, at full quality.
      if (program.sid !== prevSid) {
        prevSid = program.sid ?? '';
        prev = null;
        ctl = INITIAL_CONTROLLER;
        bases.clear();
        appliedTo.clear();
        applied = 0;
        if (alive) setLevel(0);
      }
      // Remember the published encodings before any step changes them.
      for (const t of tracks()) {
        const sid = t.sid ?? '';
        if (bases.has(sid) || !t.sender?.getParameters) continue;
        const enc = t.sender.getParameters().encodings ?? [];
        if (enc.length) bases.set(sid, enc.map((e) => ({ rid: e.rid, maxBitrate: e.maxBitrate, maxFramerate: e.maxFramerate, scaleResolutionDownBy: e.scaleResolutionDownBy })));
      }
      let stats;
      try { stats = await program.getSenderStats(); } catch { return; }
      const enc = program.sender?.getParameters?.().encodings ?? [];
      const frames = framesRef.current;
      framesRef.current = 0;
      const cur: HealthSample = {
        at: Date.now(),
        composedFrames: frames,
        activeRids: enc.filter((e) => e.active !== false).map((e) => e.rid ?? ''),
        layers: stats.map((s) => ({
          rid: s.rid ?? '',
          bytesSent: s.bytesSent ?? 0,
          packetsSent: s.packetsSent ?? 0,
          packetsLost: s.packetsLost ?? 0,
          framesSent: s.framesSent ?? 0,
          framesPerSecond: s.framesPerSecond ?? 0,
          frameWidth: s.frameWidth ?? 0,
          frameHeight: s.frameHeight ?? 0,
          roundTripTime: s.roundTripTime,
          targetBitrate: s.targetBitrate,
          qualityLimitationReason: s.qualityLimitationReason,
          qualityLimitationDurations: s.qualityLimitationDurations,
        })),
      };
      // A single-layer sender reports rid '' or its stats id: map the active
      // list to whatever it reported so the viewer layer list still works.
      if (cur.layers.length === 1 && enc.length <= 1) cur.activeRids = [];
      const p = prev;
      prev = cur;
      if (!p || !alive) return;
      const h = computeHealth(p, cur);
      const a = assessHealth(h, connLabel(connRef.current));
      setHealth(h);
      setAssessment(a);
      if (autoRef.current) {
        const next = stepController(ctl, a.verdict, Date.now());
        if (next.level !== ctl.level) {
          setLastChange({ dir: next.level > ctl.level ? 'down' : 'up', at: Date.now() });
        }
        ctl = next;
      } else {
        ctl = { ...INITIAL_CONTROLLER };
      }
      const missing = applied !== 0 && tracks().some((t) => !appliedTo.has(t.sid ?? ''));
      if (ctl.level !== applied || missing) {
        if (ctl.level !== applied) appliedTo.clear();
        await apply(ctl.level);
        if (alive) setLevel(ctl.level);
      }
    };

    const timer = window.setInterval(() => { void sample(); }, HEALTH_POLL_MS);
    void sample();
    return () => {
      alive = false;
      window.clearInterval(timer);
      // Leaving the studio, or the program going away: hand the encoder back
      // its own settings.
      if (applied !== 0) void apply(0);
    };
  }, [published, localParticipant, namesKey, framesRef]);

  return {
    health,
    assessment,
    level,
    stepLabel: QUALITY_STEPS[level]?.label ?? '',
    auto: auto && canAuto,
    setAuto,
    canAuto,
    lastChange,
  };
}
