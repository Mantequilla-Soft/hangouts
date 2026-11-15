/**
 * The boost alert sound, synthesised with WebAudio: no audio file to ship or
 * load. A soft sine chime, a little higher and longer for bigger tiers, and a
 * short rising run for a reached goal.
 *
 * It plays on the host's own speakers (a separate AudioContext), NOT into the
 * stream mix: it is a cue for the host, like a notification sound.
 */

export interface ChimeNote {
  /** Hz */
  freq: number;
  /** Seconds after the start. */
  at: number;
  /** Seconds. */
  dur: number;
}

/** The notes for a boost of tier `level` (0..3), or for a reached goal. */
export function chimeNotes(kind: 'boost' | 'goal', level = 0): ChimeNote[] {
  if (kind === 'goal') {
    // C6 E6 G6 C7, quick and bright.
    return [1046.5, 1318.5, 1568, 2093].map((freq, i) => ({ freq, at: i * 0.11, dur: 0.5 }));
  }
  const l = Math.max(0, Math.min(3, Math.round(level)));
  // A fifth up (E6 then B6 / A6 then E7 for the top tiers), each tier a touch longer.
  const base = l >= 2 ? 1760 : 1318.5;
  const dur = 0.35 + l * 0.08;
  const notes: ChimeNote[] = [
    { freq: base, at: 0, dur },
    { freq: base * 1.5, at: 0.12, dur: dur + 0.1 },
  ];
  if (l === 3) notes.push({ freq: base * 2, at: 0.24, dur: dur + 0.2 });
  return notes;
}

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx || ctx.state === 'closed') {
    try { ctx = new Ctor(); } catch { return null; }
  }
  return ctx;
}

/** Play the chime. Never throws: an alert sound must not break the studio. */
export function playBoostChime(kind: 'boost' | 'goal', level = 0, volume = 0.18): void {
  const ac = audioContext();
  if (!ac) return;
  try {
    if (ac.state === 'suspended') void ac.resume();
    const t0 = ac.currentTime + 0.02;
    const master = ac.createGain();
    master.gain.value = Math.max(0, Math.min(1, volume));
    master.connect(ac.destination);
    for (const n of chimeNotes(kind, level)) {
      const osc = ac.createOscillator();
      const env = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      // Quick attack, exponential tail: a bell rather than a beep.
      env.gain.setValueAtTime(0.0001, t0 + n.at);
      env.gain.exponentialRampToValueAtTime(1, t0 + n.at + 0.015);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
      osc.connect(env);
      env.connect(master);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.dur + 0.05);
    }
  } catch {
    /* no audio: skip the cue */
  }
}

/**
 * Read a boost aloud with the browser's speech synthesis. Queued after
 * anything already being read, so two boosts in a row are both heard.
 */
export function speakBoost(text: string, lang?: string): void {
  if (typeof window === 'undefined' || !text) return;
  const synth = window.speechSynthesis;
  const Utterance = (window as unknown as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
  if (!synth || !Utterance) return;
  try {
    const u = new Utterance(text);
    if (lang) u.lang = lang;
    u.rate = 1;
    u.volume = 1;
    synth.speak(u);
  } catch {
    /* speech unavailable */
  }
}
