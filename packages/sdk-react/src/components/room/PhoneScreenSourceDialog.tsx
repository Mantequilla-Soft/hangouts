import { useState } from 'react';

/**
 * "Phone or tablet screen" source for the studio: a step-by-step guide, no app
 * on the phone and no stream address.
 *
 * Browsers on phones and tablets cannot capture the screen, and neither can a
 * browser extension; only an installed app can. So the phone's screen goes to
 * THIS computer with what the systems already have (AirPlay to a Mac, an AirPlay
 * receiver on Windows or Linux, scrcpy over Wi-Fi or cable, or Wireless Display
 * for Android), and the studio shares that window like any other.
 *
 * Three sections: get the picture onto this computer, share the window, get
 * the sound in (a shared window carries none: Windows shares system audio with
 * the entire screen; Linux routes the mirroring app into a virtual "Phone"
 * output and picks its monitor as an audio input; a Mac needs a virtual audio
 * device). Two pickers choose the pair: this computer (detected) and the
 * phone (remembered). Steps are cards: a short title, one line, and commands in
 * code boxes with a copy button. Commands are not translated.
 *
 * All text comes from `labels` so the integrator can translate it.
 */
export type ComputerOs = 'mac' | 'windows' | 'linux';
export type PhoneOs = 'ios' | 'android';

export const PHONE_SCREEN_LABEL_KEYS = [
  'menuItem', 'menuHint', 'sourceName', 'title', 'lead', 'computerLabel', 'phoneLabel',
  'osMac', 'osWindows', 'osLinux', 'phoneIos', 'phoneAndroid',
  'pictureHeading', 'shareHeading', 'shareText', 'shareButton', 'soundHeading', 'orLabel', 'copy', 'copied',
  'airplayT', 'airplayMacD', 'airplayReceiverD', 'quicktimeT', 'quicktimeD',
  'receiverT', 'receiverWinD', 'receiverLinuxD',
  'scrcpyT', 'scrcpyMacD', 'scrcpyWinD', 'scrcpyLinuxD', 'scrcpyLink',
  'devT', 'devD', 'pairT', 'pairD', 'connectT', 'connectD', 'startT', 'startD',
  'cableT', 'cableD', 'castT', 'castD',
  'soundWinT', 'soundWinD', 'soundMacT', 'soundMacD',
  'sinkT', 'sinkD', 'sinkStartT', 'sinkStartD', 'sinkPickT', 'sinkPickD',
  'close',
] as const;
export type PhoneScreenSourceLabels = Record<typeof PHONE_SCREEN_LABEL_KEYS[number], string>;
type LabelKey = keyof PhoneScreenSourceLabels;

export const DEFAULT_PHONE_SCREEN_LABELS: PhoneScreenSourceLabels = {
  menuItem: 'Phone or tablet screen',
  menuHint: 'Show the screen of an iPhone, iPad or Android device: mirror it to this computer, then share that window',
  sourceName: 'Phone screen',
  title: 'Phone or tablet screen',
  lead: 'Mirror the phone to this computer, then share that window. Nothing goes through other services.',
  computerLabel: 'This computer',
  phoneLabel: 'Phone or tablet',
  osMac: 'Mac',
  osWindows: 'Windows',
  osLinux: 'Linux',
  phoneIos: 'iPhone / iPad',
  phoneAndroid: 'Android',
  pictureHeading: 'Get the phone onto this computer',
  shareHeading: 'Share it in the studio',
  shareText: 'Pick the window that shows the phone.',
  shareButton: 'Share the window',
  soundHeading: 'The phone\'s sound',
  orLabel: 'or',
  copy: 'Copy',
  copied: 'Copied',
  airplayT: 'Mirror with AirPlay',
  airplayMacD: 'Same Wi-Fi for both. On the iPhone or iPad: Control Centre → Screen Mirroring → this Mac (macOS 12 or newer).',
  airplayReceiverD: 'Same Wi-Fi for both. On the iPhone or iPad: Control Centre → Screen Mirroring → pick the receiver.',
  quicktimeT: 'With a cable',
  quicktimeD: 'QuickTime Player → File → New Movie Recording → pick the iPhone or iPad as the camera.',
  receiverT: 'Install an AirPlay receiver',
  receiverWinD: 'Windows can\'t receive AirPlay by itself. Get a free receiver app from the Microsoft Store (search “AirPlay receiver”) and open it.',
  receiverLinuxD: 'UxPlay is a free AirPlay receiver (package “uxplay”). Start it:',
  scrcpyT: 'Install scrcpy',
  scrcpyMacD: 'Free. With Homebrew:',
  scrcpyWinD: 'Free. Download the Windows zip and unpack it.',
  scrcpyLinuxD: 'Free. Take the newest version: the package in your distribution can be too old for new phones.',
  scrcpyLink: 'scrcpy downloads',
  devT: 'Turn on wireless debugging',
  devD: 'On the phone (Android 11 or newer): Settings → About phone → tap Build number 7 times. Then Developer options → Wireless debugging → Pair device with pairing code.',
  pairT: 'Pair (only once)',
  pairD: 'With the address and code from the pairing popup:',
  connectT: 'Connect',
  connectD: 'With the address under “IP address & port” on the Wireless debugging screen (not the pairing port):',
  startT: 'Start',
  startD: 'The phone\'s screen opens in a window.',
  cableT: 'With a cable',
  cableD: 'Turn on USB debugging in the developer options, plug the phone in and run scrcpy.',
  castT: 'Cast to Windows',
  castD: 'Many phones can: Settings → System → Optional features → add Wireless Display, open it, then Cast or Smart View from the phone.',
  soundWinT: 'Share a second time, for the sound',
  soundWinD: 'Click Share the window again, choose Entire screen and switch on “Share system audio”. Keep the phone window as the picture: the second share only brings the sound.',
  soundMacT: 'A virtual audio device',
  soundMacD: 'A Mac browser can\'t take another app\'s sound. Install a free virtual audio device (BlackHole, for example), make it the Mac\'s sound output, then in the studio: Add source → Desktop / aux audio → BlackHole.',
  sinkT: 'Make a “Phone” output',
  sinkD: 'Once per login:',
  sinkStartT: 'Start the mirroring with it',
  sinkStartD: 'Put PULSE_SINK=phone in front:',
  sinkPickT: 'Pick it in the studio',
  sinkPickD: 'Add source → Desktop / aux audio → “Monitor of Phone”. Reload the studio if it isn\'t listed yet.',
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

const SCRCPY_RELEASES = 'https://github.com/Genymobile/scrcpy/releases/latest';

/** One step card. `alt` marks an alternative to the step before ("or"). */
export interface GuideStep {
  title: LabelKey;
  text: LabelKey;
  code?: string;
  link?: { href: string; label: LabelKey };
  alt?: boolean;
}

const SINK_CMD = 'pactl load-module module-null-sink sink_name=phone sink_properties=device.description=Phone';

/** Steps to get the picture onto this computer, per pair. */
export function pictureSteps(computer: ComputerOs, phone: PhoneOs): GuideStep[] {
  if (phone === 'ios') {
    if (computer === 'mac') {
      return [
        { title: 'airplayT', text: 'airplayMacD' },
        { title: 'quicktimeT', text: 'quicktimeD', alt: true },
      ];
    }
    return computer === 'windows'
      ? [{ title: 'receiverT', text: 'receiverWinD' }, { title: 'airplayT', text: 'airplayReceiverD' }]
      : [{ title: 'receiverT', text: 'receiverLinuxD', code: 'uxplay' }, { title: 'airplayT', text: 'airplayReceiverD' }];
  }
  const install: GuideStep = computer === 'mac'
    ? { title: 'scrcpyT', text: 'scrcpyMacD', code: 'brew install scrcpy' }
    : { title: 'scrcpyT', text: computer === 'windows' ? 'scrcpyWinD' : 'scrcpyLinuxD', link: { href: SCRCPY_RELEASES, label: 'scrcpyLink' } };
  const steps: GuideStep[] = [
    install,
    { title: 'devT', text: 'devD' },
    { title: 'pairT', text: 'pairD', code: 'adb pair 192.168.1.23:37115 123456' },
    { title: 'connectT', text: 'connectD', code: 'adb connect 192.168.1.23:41234' },
    { title: 'startT', text: 'startD', code: 'scrcpy' },
    { title: 'cableT', text: 'cableD', alt: true },
  ];
  if (computer === 'windows') steps.push({ title: 'castT', text: 'castD', alt: true });
  return steps;
}

/** Steps to get the phone's sound into the studio, per pair. */
export function soundSteps(computer: ComputerOs, phone: PhoneOs): GuideStep[] {
  if (computer === 'windows') return [{ title: 'soundWinT', text: 'soundWinD' }];
  if (computer === 'mac') return [{ title: 'soundMacT', text: 'soundMacD' }];
  return [
    { title: 'sinkT', text: 'sinkD', code: SINK_CMD },
    { title: 'sinkStartT', text: 'sinkStartD', code: phone === 'ios' ? 'PULSE_SINK=phone uxplay' : 'PULSE_SINK=phone scrcpy' },
    { title: 'sinkPickT', text: 'sinkPickD' },
  ];
}

const PHONE_KEY = 'hh-phone-source-os';
const readPhone = (): PhoneOs => {
  try { return window.localStorage.getItem(PHONE_KEY) === 'android' ? 'android' : 'ios'; } catch { return 'ios'; }
};

function Code({ code, l }: { code: string; l: PhoneScreenSourceLabels }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="hh-phone-guide__code">
      <code>{code}</code>
      <button
        type="button"
        className="hh-btn hh-btn--secondary hh-btn--small"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }).catch(() => { /* the text stays selectable */ });
        }}
      >{copied ? l.copied : l.copy}</button>
    </div>
  );
}

function Steps({ steps, l }: { steps: GuideStep[]; l: PhoneScreenSourceLabels }) {
  let n = 0;
  return (
    <ol className="hh-phone-guide__steps">
      {steps.map((s) => {
        if (!s.alt) n += 1;
        return (
          <li key={s.title + s.text} className={`hh-phone-guide__step${s.alt ? ' hh-phone-guide__step--alt' : ''}`}>
            <span className="hh-phone-guide__num" aria-hidden="true">{s.alt ? l.orLabel : n}</span>
            <div className="hh-phone-guide__body">
              <strong>{l[s.title]}</strong>
              <span>{l[s.text]}</span>
              {s.code && <Code code={s.code} l={l} />}
              {s.link && <a href={s.link.href} target="_blank" rel="noopener noreferrer">{l[s.link.label]} ↗</a>}
            </div>
          </li>
        );
      })}
    </ol>
  );
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
    <div className="hh-phone-guide__seg" role="radiogroup" aria-label={group}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={`hh-phone-guide__opt${value === v ? ' hh-phone-guide__opt--on' : ''}`}
          onClick={() => set(v)}
        >{text}</button>
      ))}
    </div>
  );

  return (
    <div className="hh-studio__modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hh-studio__obs-modal hh-studio__phone-modal hh-phone-guide" role="dialog" aria-label={l.title}>
        <div className="hh-studio__modal-head">
          <span>📱 {l.title}</span>
          <button className="hh-studio__collapse" onClick={onClose} title={l.close} aria-label={l.close}>×</button>
        </div>
        <p className="hh-phone-guide__lead">{l.lead}</p>
        <div className="hh-phone-guide__pick">
          <div><span>{l.computerLabel}</span>
            {seg(l.computerLabel, computer, [['mac', l.osMac], ['windows', l.osWindows], ['linux', l.osLinux]], setComputer)}
          </div>
          <div><span>{l.phoneLabel}</span>
            {seg(l.phoneLabel, phone, [['ios', l.phoneIos], ['android', l.phoneAndroid]], setPhone)}
          </div>
        </div>

        <section className="hh-phone-guide__section">
          <h4><span aria-hidden="true">🖥️</span> {l.pictureHeading}</h4>
          <Steps steps={pictureSteps(computer, phone)} l={l} />
        </section>

        <section className="hh-phone-guide__section">
          <h4><span aria-hidden="true">🪟</span> {l.shareHeading}</h4>
          <div className="hh-phone-guide__share">
            <span>{l.shareText}</span>
            <button type="button" className="hh-btn hh-btn--primary" onClick={() => { onShareWindow(); onClose(); }}>
              {l.shareButton}
            </button>
          </div>
        </section>

        <section className="hh-phone-guide__section">
          <h4><span aria-hidden="true">🔊</span> {l.soundHeading}</h4>
          <Steps steps={soundSteps(computer, phone)} l={l} />
        </section>
      </div>
    </div>
  );
}
