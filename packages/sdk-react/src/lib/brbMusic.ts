/**
 * Built-in "be right back" music (H17), generated in the browser with the Web
 * Audio API: soft pads, a bass note and a few plucked notes over a looping
 * chord progression. Nothing is downloaded and there is no licence to track:
 * the notes are written here, and the sound is synthesised on the host's
 * machine, then mixed into the program audio like any other source.
 *
 * Notes are scheduled a few seconds ahead from a timer, so a throttled
 * background tab (timers at 1/s) still plays without gaps.
 */

export type BuiltinTrackId = 'calm' | 'lofi' | 'bright';

export interface BuiltinTrack {
  id: BuiltinTrackId;
  label: string;
  bpm: number;
  /** One chord per bar (4 beats), as MIDI note numbers, lowest = bass. */
  chords: number[][];
  /** Pluck pattern: beats within a bar (0..4) where a chord tone is plucked. */
  plucks: number[];
  /** Arpeggio (bright): 8th notes up and down the chord instead of plucks. */
  arp?: boolean;
  /** Low-pass cutoff in Hz: how warm the mix is. */
  cutoff: number;
}

export const BUILTIN_TRACKS: Record<BuiltinTrackId, BuiltinTrack> = {
  calm: {
    id: 'calm', label: 'Calm pads', bpm: 60, cutoff: 1800,
    // Cmaj7, Am7, Fmaj7, G6
    chords: [[48, 60, 64, 67, 71], [45, 60, 64, 67, 69], [41, 60, 64, 65, 69], [43, 59, 62, 64, 67]],
    plucks: [1.5, 3],
  },
  lofi: {
    id: 'lofi', label: 'Lo-fi', bpm: 78, cutoff: 1400,
    // Dm9, G13, Cmaj9, A7
    chords: [[38, 60, 64, 65, 69], [43, 59, 64, 65, 69], [36, 59, 62, 64, 67], [45, 61, 64, 67, 69]],
    plucks: [0.5, 1.75, 2.5, 3.5],
  },
  bright: {
    id: 'bright', label: 'Bright', bpm: 100, cutoff: 3200,
    // D, A, Bm, G
    chords: [[38, 62, 66, 69, 74], [45, 61, 64, 69, 73], [47, 62, 66, 71, 74], [43, 62, 67, 71, 74]],
    plucks: [],
    arp: true,
  },
};

export interface NoteEvent {
  /** Beat from the start of the track. */
  beat: number;
  midi: number;
  /** Length in beats. */
  beats: number;
  /** 0..1 loudness. */
  vel: number;
  voice: 'pad' | 'bass' | 'pluck';
}

/** Deterministic 0..1 noise per beat, so a loop always sounds the same. */
function noise(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Every note that STARTS in [fromBeat, toBeat). Pure, for scheduling and tests. */
export function trackEvents(track: BuiltinTrack, fromBeat: number, toBeat: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  const firstBar = Math.floor(fromBeat / 4);
  const lastBar = Math.floor((toBeat - 1e-9) / 4);
  for (let bar = firstBar; bar <= lastBar; bar++) {
    // Seeded by the bar's place in the progression, so every loop is the same.
    const slot = ((bar % track.chords.length) + track.chords.length) % track.chords.length;
    const chord = track.chords[slot];
    const at = bar * 4;
    const push = (e: NoteEvent) => { if (e.beat >= fromBeat && e.beat < toBeat) out.push(e); };
    // Pad: the upper chord tones held for the whole bar (slight overlap so
    // the release crosses into the next chord).
    for (const midi of chord.slice(1)) push({ beat: at, midi, beats: 4.2, vel: 0.16, voice: 'pad' });
    push({ beat: at, midi: chord[0], beats: 2, vel: 0.5, voice: 'bass' });
    push({ beat: at + 2.5, midi: chord[0], beats: 1.2, vel: 0.32, voice: 'bass' });
    if (track.arp) {
      const tones = chord.slice(1);
      const order = [...tones, ...tones.slice(1, -1).reverse()];
      for (let i = 0; i < 8; i++) {
        push({ beat: at + i / 2, midi: order[i % order.length] + 12, beats: 0.45, vel: 0.22 + noise(slot * 8 + i) * 0.08, voice: 'pluck' });
      }
    } else {
      track.plucks.forEach((b, i) => {
        const tones = chord.slice(2);
        const midi = tones[Math.floor(noise(slot * 16 + i) * tones.length)] + 12;
        push({ beat: at + b, midi, beats: 1, vel: 0.2 + noise(slot * 16 + i + 7) * 0.1, voice: 'pluck' });
      });
    }
  }
  return out.sort((a, b) => a.beat - b.beat);
}

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

export interface MusicHandle {
  /** Fade out and release everything. */
  stop(): void;
  /** 0..1 */
  setVolume(v: number): void;
}

/** How far ahead notes are scheduled, and how often. */
const LOOKAHEAD_S = 3;
const TICK_MS = 400;

/**
 * Start a built-in track into `out`. Returns a handle; stopping fades out over
 * a second and disconnects the nodes.
 */
export function startBuiltinMusic(ctx: BaseAudioContext, out: AudioNode, id: BuiltinTrackId, volume = 0.5): MusicHandle {
  const track = BUILTIN_TRACKS[id] ?? BUILTIN_TRACKS.calm;
  const secPerBeat = 60 / track.bpm;
  const master = ctx.createGain();
  master.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = track.cutoff;
  filter.Q.value = 0.4;
  master.connect(filter);
  filter.connect(out);

  const t0 = ctx.currentTime + 0.1;
  const level = (v: number) => Math.max(0, Math.min(1, v)) * 0.9;
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(level(volume), t0 + 2);

  let scheduledTo = 0;   // beats
  let stopped = false;

  const play = (e: NoteEvent) => {
    const start = t0 + e.beat * secPerBeat;
    const dur = e.beats * secPerBeat;
    const g = ctx.createGain();
    g.connect(master);
    const freq = midiToHz(e.midi);
    const oscs: OscillatorNode[] = [];
    const osc = (type: OscillatorType, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(g);
      oscs.push(o);
    };
    if (e.voice === 'pad') {
      osc('triangle', -6); osc('sine', 5);
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(e.vel, start + Math.min(1.2, dur * 0.4));
      g.gain.setValueAtTime(e.vel, start + dur * 0.75);
      g.gain.linearRampToValueAtTime(0, start + dur);
    } else if (e.voice === 'bass') {
      osc('sine');
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(e.vel, start + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    } else {
      osc('triangle');
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(e.vel, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, start + Math.max(0.3, dur));
    }
    const end = start + dur + 0.1;
    for (const o of oscs) { o.start(start); o.stop(end); }
    oscs[0].onended = () => { try { g.disconnect(); } catch { /* gone */ } };
  };

  const schedule = () => {
    if (stopped) return;
    const until = (ctx.currentTime + LOOKAHEAD_S - t0) / secPerBeat;
    if (until <= scheduledTo) return;
    for (const e of trackEvents(track, scheduledTo, until)) play(e);
    scheduledTo = until;
  };
  schedule();
  const timer = setInterval(schedule, TICK_MS);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const now = ctx.currentTime;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0, now + 1);
      } catch { /* closed context */ }
      setTimeout(() => { try { filter.disconnect(); master.disconnect(); } catch { /* gone */ } }, 1200);
    },
    setVolume(v: number) {
      if (stopped) return;
      const now = ctx.currentTime;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(level(v), now, 0.2);
      } catch { /* closed context */ }
    },
  };
}
