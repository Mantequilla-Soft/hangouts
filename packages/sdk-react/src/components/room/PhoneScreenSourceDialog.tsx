import { useState } from 'react';

/**
 * "Phone or tablet screen" source for the studio: a short guide, no app on
 * the phone and no stream address.
 *
 * Browsers on phones and tablets cannot capture the screen, and neither can a
 * browser extension; only an installed app can. So the phone's screen goes to
 * THIS computer with what the systems already have (AirPlay to a Mac, an AirPlay
 * receiver on Windows or Linux, scrcpy by cable or Wi-Fi or wireless display
 * for Android), and
 * the studio shares that window like any other (Add source, Share screen).
 * Nothing goes through a third party or our server.
 *
 * Two pickers: the computer the studio runs on (detected, can be changed) and
 * the phone or tablet; the steps follow the pair.
 *
 * All text comes from `labels` so the integrator can translate it.
 */
export type ComputerOs = 'mac' | 'windows' | 'linux';
export type PhoneOs = 'ios' | 'android';

export interface PhoneScreenSourceLabels {
  /** The Add source menu item, its tooltip, and the source's name in the list. */
  menuItem: string;
  menuHint: string;
  sourceName: string;
  title: string;
  lead: string;
  computerLabel: string;
  phoneLabel: string;
  osMac: string;
  osWindows: string;
  osLinux: string;
  phoneIos: string;
  phoneAndroid: string;
  /** Steps per pair, then the last step every pair shares. */
  macIos1: string;
  macIos2: string;
  macAndroid1: string;
  winIos1: string;
  winIos2: string;
  winAndroid1: string;
  winAndroid2: string;
  linuxIos1: string;
  linuxIos2: string;
  linuxAndroid1: string;
  /** scrcpy over Wi-Fi, after one cable connection (every computer). */
  androidWifi: string;
  shareStep: string;
  shareButton: string;
  soundNote: string;
  close: string;
}

export const DEFAULT_PHONE_SCREEN_LABELS: PhoneScreenSourceLabels = {
  menuItem: 'Phone or tablet screen',
  menuHint: 'Show the screen of an iPhone, iPad or Android device: mirror it to this computer, then share that window',
  sourceName: 'Phone screen',
  title: 'Phone or tablet screen',
  lead: 'Mirror the phone or tablet to this computer, then share that window in the studio. Nothing goes through other services.',
  computerLabel: 'This computer',
  phoneLabel: 'Phone or tablet',
  osMac: 'Mac',
  osWindows: 'Windows',
  osLinux: 'Linux',
  phoneIos: 'iPhone / iPad',
  phoneAndroid: 'Android',
  macIos1: 'Put both on the same Wi-Fi. On the iPhone or iPad, open Control Centre, tap Screen Mirroring and choose this Mac (macOS 12 or newer).',
  macIos2: 'Or with a cable: connect it, open QuickTime Player, choose File, New Movie Recording, and pick the iPhone or iPad as the camera.',
  macAndroid1: 'Install scrcpy (free, scrcpy on GitHub, or "brew install scrcpy"). Turn on USB debugging in the phone\'s developer options, connect it with a cable and run scrcpy.',
  winIos1: 'Windows can\'t receive AirPlay by itself: install a free AirPlay receiver app (search the Microsoft Store for "AirPlay receiver") and open it.',
  winIos2: 'Put both on the same Wi-Fi. On the iPhone or iPad, open Control Centre, tap Screen Mirroring and choose the receiver.',
  winAndroid1: 'Install scrcpy (free, scrcpy on GitHub). Turn on USB debugging in the phone\'s developer options, connect it with a cable and run scrcpy.',
  winAndroid2: 'Or without a cable, on many phones: add "Wireless Display" under Settings, System, Optional features, open it, then cast or Smart View from the phone to this PC.',
  linuxIos1: 'Install UxPlay (a free AirPlay receiver, in most package managers as "uxplay") and run it.',
  linuxIos2: 'Put both on the same Wi-Fi. On the iPhone or iPad, open Control Centre, tap Screen Mirroring and choose UxPlay.',
  linuxAndroid1: 'Install scrcpy (in most package managers). Turn on USB debugging in the phone\'s developer options, connect it with a cable and run scrcpy.',
  androidWifi: 'Over Wi-Fi instead: with the phone plugged in once, run "scrcpy --tcpip", then unplug it. scrcpy keeps showing the screen over Wi-Fi (both on the same network).',
  shareStep: 'When the phone shows on this computer, share that window here:',
  shareButton: 'Share the window',
  soundNote: 'A shared window has no sound in most browsers. For the phone\'s sound, share the whole screen with system audio (Chrome on Windows) or use a microphone.',
  close: 'Close',
};

export interface PhoneScreenSourceDialogProps {
  /** Opens the browser's screen / window picker (the studio's Share screen). */
  onShareWindow: () => void;
  onClose: () => void;
  labels?: Partial<PhoneScreenSourceLabels>;
}

/** The computer the studio runs on, from the browser. Unknown → Windows. */
export function detectComputerOs(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): ComputerOs {
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/i.test(ua) && !/Android/i.test(ua)) return 'linux';
  return 'windows';
}

const PHONE_KEY = 'hh-phone-source-os';
const readPhone = (): PhoneOs => {
  try { return window.localStorage.getItem(PHONE_KEY) === 'android' ? 'android' : 'ios'; } catch { return 'ios'; }
};

/** The steps for a computer / phone pair (label keys, in order). */
export function mirrorSteps(computer: ComputerOs, phone: PhoneOs): (keyof PhoneScreenSourceLabels)[] {
  if (computer === 'mac') return phone === 'ios' ? ['macIos1', 'macIos2'] : ['macAndroid1', 'androidWifi'];
  if (computer === 'windows') return phone === 'ios' ? ['winIos1', 'winIos2'] : ['winAndroid1', 'androidWifi', 'winAndroid2'];
  return phone === 'ios' ? ['linuxIos1', 'linuxIos2'] : ['linuxAndroid1', 'androidWifi'];
}

export function PhoneScreenSourceDialog({ onShareWindow, onClose, labels }: PhoneScreenSourceDialogProps) {
  const l = { ...DEFAULT_PHONE_SCREEN_LABELS, ...labels };
  const [computer, setComputer] = useState<ComputerOs>(() => detectComputerOs());
  // The phone, remembered: a host usually mirrors the same one.
  const [phone, setPhoneState] = useState<PhoneOs>(readPhone);
  const setPhone = (p: PhoneOs) => {
    setPhoneState(p);
    try { window.localStorage.setItem(PHONE_KEY, p); } catch { /* not remembered */ }
  };
  const seg = <T extends string>(group: string, value: T, options: [T, string][], set: (v: T) => void) => (
    <div className="hh-studio__phone-tabs" role="radiogroup" aria-label={group}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={`hh-studio__phone-tab${value === v ? ' hh-studio__phone-tab--active' : ''}`}
          onClick={() => set(v)}
        >{text}</button>
      ))}
    </div>
  );

  return (
    <div className="hh-studio__modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hh-studio__obs-modal hh-studio__phone-modal" role="dialog" aria-label={l.title}>
        <div className="hh-studio__modal-head">
          <span>📱 {l.title}</span>
          <button className="hh-studio__collapse" onClick={onClose} title={l.close} aria-label={l.close}>×</button>
        </div>
        <p className="hh-studio__obs-lead">{l.lead}</p>
        <span className="hh-studio__phone-field">{l.computerLabel}</span>
        {seg(l.computerLabel, computer, [['mac', l.osMac], ['windows', l.osWindows], ['linux', l.osLinux]], setComputer)}
        <span className="hh-studio__phone-field">{l.phoneLabel}</span>
        {seg(l.phoneLabel, phone, [['ios', l.phoneIos], ['android', l.phoneAndroid]], setPhone)}
        <ol className="hh-studio__phone-steps">
          {mirrorSteps(computer, phone).map((k) => <li key={k}>{l[k]}</li>)}
          <li>{l.shareStep}</li>
        </ol>
        <div className="hh-studio__phone-share">
          <button type="button" className="hh-btn hh-btn--primary" onClick={() => { onShareWindow(); onClose(); }}>
            {l.shareButton}
          </button>
        </div>
        <ul className="hh-studio__obs-hints">
          <li>{l.soundNote}</li>
        </ul>
      </div>
    </div>
  );
}
