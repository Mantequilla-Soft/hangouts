import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

/**
 * "Phone or tablet screen" source for the studio.
 *
 * Browsers on iPhone and iPad cannot capture the screen, and Android browsers
 * mostly can't either, but a screen-broadcast app can: the OS lets it record
 * the whole screen and send it over WHIP. The studio's WHIP ingress (the same
 * one the OBS source uses) receives it, and the feed shows up as a normal
 * source, usable in any scene. WHIP only, by design: no RTMP anywhere.
 *
 * The recommended app is Larix Screencaster (free, iOS and Android), which
 * sends WebRTC over WHIP. Any app that can send WHIP works the same way.
 *
 * The stream key is shown twice: at the end of the URL (OBS-style, needs no
 * token) and as the token on its own. Larix's WebRTC connection wants
 * Authentication set to WHIP with a token, and errors without one; the ingress
 * accepts the key in the path and the same key as the bearer token together.
 *
 * All text comes from `labels` so the integrator can translate it.
 */
/**
 * A Larix Grove link (softvelum.com/larix/grove): scanned or tapped, Larix adds
 * the WHIP connection with the URL and token filled in. `overwrite` replaces
 * the one added last time (same name), so scanning again makes no duplicate.
 * Brackets stay literal, only the values are encoded.
 */
export function larixGroveUrl(whipUrl: string, token: string, name: string): string {
  const params: [string, string][] = [
    ['conn[][url]', whipUrl],
    ['conn[][name]', name],
    ['conn[][token]', token],
    ['conn[][overwrite]', 'on'],
    ['conn[][mode]', 'va'],
  ];
  return `larix://set/v1?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

export interface PhoneScreenSourceLabels {
  /** The Add source menu item, its tooltip, and the source's name in the list. */
  menuItem: string;
  menuHint: string;
  sourceName: string;
  title: string;
  lead: string;
  step1: string;
  step2: string;
  step3: string;
  step4: string;
  /** The connection's name in Larix, set by the QR code. */
  connectionName: string;
  openInLarix: string;
  urlLabel: string;
  tokenLabel: string;
  qrHint: string;
  copy: string;
  copied: string;
  keepPrivate: string;
  sharedSlot: string;
  soundNote: string;
  androidNote: string;
  delayNote: string;
  waiting: string;
  connected: string;
  close: string;
}

export const DEFAULT_PHONE_SCREEN_LABELS: PhoneScreenSourceLabels = {
  menuItem: 'Phone or tablet screen',
  menuHint: 'Show the screen of an iPhone, iPad or Android device, sent from a free app',
  sourceName: 'Phone screen',
  title: 'Phone or tablet screen',
  lead: 'Show the screen of an iPhone, iPad or Android device in your stream, over the internet. It takes a free screen-broadcast app on that device.',
  step1: 'On the phone or tablet, install Larix Screencaster (free, App Store or Google Play).',
  step2: 'Scan the QR code with the phone or tablet and let Larix add the connection. Or add it by hand in Larix (Settings, Connections): paste the URL below, set Authentication to WHIP and paste the token into Token.',
  step3: 'Start the broadcast from Larix. On an iPhone or iPad, confirm "Start Broadcast" in the screen-recording dialog.',
  step4: 'The screen appears here as a source within a few seconds. Use it in any scene.',
  connectionName: '3Speak Live',
  openInLarix: 'Open in Larix',
  urlLabel: 'URL',
  tokenLabel: 'Token',
  qrHint: 'Scan with the camera to add the connection to Larix. On Android, scan it from Larix itself (Settings, Connections, Import) if the camera does not open Larix.',
  copy: 'Copy',
  copied: 'Copied',
  keepPrivate: 'Keep this address private: anyone who has it can send a picture into your stream.',
  sharedSlot: 'One outside feed at a time: this uses the same slot as OBS.',
  soundNote: 'Sound: iPhone and iPad send the microphone, or the sound of apps that allow it.',
  androidNote: 'On Android, Larix may ask for its paid Premium before it streams over WebRTC.',
  delayNote: 'The feed arrives a little later than your studio camera and mic.',
  waiting: 'Waiting for the device to connect…',
  connected: 'The device is connected.',
  close: 'Close',
};

export interface PhoneScreenSourceDialogProps {
  /** The WHIP address the app publishes to (stream key in the path). Empty
   *  while it is being set up. */
  whipUrl: string;
  /** The device's feed has arrived. */
  connected: boolean;
  /** Setup failed: shown instead of the steps. */
  error?: string;
  onClose: () => void;
  labels?: Partial<PhoneScreenSourceLabels>;
}

export function PhoneScreenSourceDialog({ whipUrl, connected, error, onClose, labels }: PhoneScreenSourceDialogProps) {
  const l = { ...DEFAULT_PHONE_SCREEN_LABELS, ...labels };
  // The stream key is the URL's last path segment.
  const token = whipUrl ? whipUrl.replace(/\/+$/, '').split('/').pop() ?? '' : '';
  const grove = whipUrl && token ? larixGroveUrl(whipUrl, token, l.connectionName) : '';
  const [copied, setCopied] = useState<'' | 'url' | 'token'>('');
  const copy = (what: 'url' | 'token') => {
    void navigator.clipboard?.writeText(what === 'url' ? whipUrl : token).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(''), 2000);
    }).catch(() => { /* the field stays selectable */ });
  };

  return (
    <div className="hh-studio__modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hh-studio__obs-modal hh-studio__phone-modal" role="dialog" aria-label={l.title}>
        <div className="hh-studio__modal-head">
          <span>📱 {l.title}</span>
          <button className="hh-studio__collapse" onClick={onClose} title={l.close} aria-label={l.close}>×</button>
        </div>

        {error ? (
          <p className="hh-studio__obs-error">{error}</p>
        ) : (
          <>
            <p className="hh-studio__obs-lead">{l.lead}</p>
            <ol className="hh-studio__phone-steps">
              <li>{l.step1}</li>
              <li>{l.step2}</li>
              <li>{l.step3}</li>
              <li>{l.step4}</li>
            </ol>
            {grove && (
              <div className="hh-studio__phone-qr">
                <QRCodeSVG value={grove} size={168} marginSize={2} bgColor="#ffffff" fgColor="#000000" />
                <span>
                  {l.qrHint}
                  {/* Opened on the device itself, a tap does the same as the scan. */}
                  <a className="hh-studio__phone-open" href={grove}>{l.openInLarix}</a>
                </span>
              </div>
            )}
            <span className="hh-studio__phone-field">{l.urlLabel}</span>
            <div className="hh-studio__obs-url">
              <input readOnly value={whipUrl} onFocus={(e) => e.currentTarget.select()} aria-label={l.urlLabel} />
              <button className="hh-btn hh-btn--primary hh-btn--small" onClick={() => copy('url')} disabled={!whipUrl}>
                {copied === 'url' ? l.copied : l.copy}
              </button>
            </div>
            <span className="hh-studio__phone-field">{l.tokenLabel}</span>
            <div className="hh-studio__obs-url">
              <input readOnly value={token} onFocus={(e) => e.currentTarget.select()} aria-label={l.tokenLabel} />
              <button className="hh-btn hh-btn--primary hh-btn--small" onClick={() => copy('token')} disabled={!token}>
                {copied === 'token' ? l.copied : l.copy}
              </button>
            </div>
            <ul className="hh-studio__obs-hints">
              <li>{l.keepPrivate}</li>
              <li>{l.sharedSlot}</li>
              <li>{l.soundNote}</li>
              <li>{l.androidNote}</li>
              <li>{l.delayNote}</li>
            </ul>
            <p className="hh-studio__obs-status">{connected ? `✅ ${l.connected}` : `⏳ ${l.waiting}`}</p>
          </>
        )}
      </div>
    </div>
  );
}
