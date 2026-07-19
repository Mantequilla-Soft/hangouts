import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionState, useLocalParticipant, useParticipants, useTracks } from '@livekit/components-react';
import { ConnectionState, Track } from 'livekit-client';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { ChatPanel } from './ChatPanel.js';
import { AUTO_VOD_KEY, AUTO_DL_KEY, readPref, writePref } from '../../utils/streamRecordingPrefs.js';
import { readPostDraft, writePostDraft } from '../../lib/postDraft.js';
import { isChromium } from '../../lib/browser.js';
import { MOBILE_QUERY, useIsMobile } from '../../hooks/useIsMobile.js';
// The SDK's OWN chat hook — NOT LiveKit's. ChatPanel speaks this protocol; the
// two are different transports and don't see each other's messages.
import { useChat } from '../../hooks/useChat.js';
import { MobileSheet } from './MobileSheet.js';
import {
  IconAspect, IconAudio, IconBoost, IconChat, IconCheck, IconFlipCamera,
  IconLens, IconPause, IconPlay, IconPost, IconShare, IconStop, IconZoomIn, IconZoomOut,
} from './StudioIcons.js';
import { BoostOverlay } from './BoostOverlay.js';
import { BoostHistoryPanel } from './BoostHistoryPanel.js';

/** Program canvas resolution — every scene composites into this fixed
 *  16:9 frame, and this exact frame is what gets published. */
const CANVAS_W = 1280;
const CANVAS_H = 720;
const PIP_MARGIN = 20;
const SPLIT_BAR = 6;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_GIF_FRAMES = 300;
const MAX_SHARES = 4;
const MAX_TAGS = 10;

/** Remembered device choices — a host who picked the back camera or a USB-C
 *  mic last time should not have to pick again every stream. */
const CAM_FACING_KEY = 'hh-studio-cam-facing';
const MIC_DEVICE_KEY = 'hh-studio-mic-device';
const ORIENTATION_KEY = 'hh-studio-orientation';
const CAM_DEVICE_KEY = 'hh-studio-cam-device';
/** Quarter-turns needed to bring each sensor upright, per facing.
 *  Sensor mounting varies by device AND between the front/back sensors of the
 *  same phone, and nothing in the Web API reports it — so this is remembered
 *  per camera and correctable by the host. */
const CAM_ROTATION_KEY = 'hh-studio-cam-rotation';

/** Android exposes audio ROUTES as separate inputs. "Speakerphone" is an
 *  output route, useless as a capture source, so it's hidden; "Headset
 *  earpiece" is whatever is plugged in or paired, which reads better as a
 *  plain "External device". */
const HIDDEN_AUDIO_INPUT = /speakerphone/i;
function micLabel(label: string, index: number): string {
  if (/headset\s*earpiece/i.test(label)) return 'External device';
  return label || `Microphone ${index + 1}`;
}

/**
 * How wide is this lens? Lower rank = wider field of view.
 *
 * The Web API exposes NO field-of-view or focal length — `getCapabilities()`
 * gives resolution and zoom range, neither of which identifies an ultra-wide.
 * The device label is the only signal available, and it's only descriptive on
 * some platforms (iOS Safari names them "Back Ultra Wide Camera"; Android
 * Chrome often just says "camera2 0, facing back"). So this is best-effort by
 * design: it returns `null` when the label says nothing, and callers must not
 * pin a lens on a guess.
 */
function lensWidthRank(label: string): number | null {
  const l = label.toLowerCase();
  if (/ultra[\s-]?wide|super[\s-]?wide|0\.5\s?x/.test(l)) return 0;
  if (/tele(photo)?|[2-9]\s?x\b/.test(l)) return 2;
  if (/wide/.test(l)) return 1;
  return null;
}

/** Does this label belong to the given side, as far as we can tell? */
function lensMatchesFacing(label: string, facing: 'user' | 'environment'): boolean {
  const l = label.toLowerCase();
  const isBack = /back|rear|environment/.test(l);
  const isFront = /front|face|user|selfie/.test(l);
  if (!isBack && !isFront) return true; // unlabelled — don't exclude it
  return facing === 'environment' ? isBack : isFront;
}

/** Streamer source-quality tiers — cap both RESOLUTION (the published program
 *  canvas is sized to width×height) and bitrate/framerate. Non-premium is
 *  capped at `medium` (480p); premium unlocks `high` (720p). */
const STREAM_QUALITY = {
  low: { label: '360p · ~0.6 Mbps', width: 640, height: 360, maxBitrate: 600_000, maxFramerate: 30 },
  medium: { label: '480p · ~1.2 Mbps', width: 854, height: 480, maxBitrate: 1_200_000, maxFramerate: 30 },
  high: { label: '720p · ~2.5 Mbps', width: 1280, height: 720, maxBitrate: 2_500_000, maxFramerate: 30 },
} as const;
type StreamQuality = keyof typeof STREAM_QUALITY;

/** Layout scene — independent of which SOURCE is selected. */
export type StudioSceneId = 'cam' | 'fullscreen' | 'overlay' | 'split';
/** Camera placement: <vertical><horizontal>, v = t|c|b, h = l|c|r.
 *  'cc' centres it outright. Legacy values (tl/tr/bl/br) still parse. */
export type PipCorner =
  | 'tl' | 'tc' | 'tr'
  | 'cl' | 'cc' | 'cr'
  | 'bl' | 'bc' | 'br';
type SourceKey = `share:${string}` | `media:${string}`;
type StreamState = 'standby' | 'live' | 'paused';

const SCENES: Array<{ id: StudioSceneId; label: string; hint: string }> = [
  { id: 'cam', label: 'Camera', hint: 'Fullscreen camera' },
  { id: 'fullscreen', label: 'Fullscreen', hint: 'The selected source, fullscreen — switch sources in the list below' },
  { id: 'overlay', label: 'Cam overlay', hint: 'The selected source with your camera on top — drag it to a corner, resize with the handle' },
  { id: 'split', label: 'Split', hint: 'Selected source and camera side by side — drag the spacer' },
];

/** How the camera PiP is masked. A square at 50% corner radius IS a circle,
 *  so there's no separate circle shape. */
type CamShape = 'rect' | 'square';

interface SceneParams {
  scene: StudioSceneId;
  source: SourceKey | null;
  pipCorner: PipCorner;
  pipSize: number;
  splitRatio: number;
  camShape: CamShape;
  /** 0-50 — percentage of the short edge used as the corner radius. */
  camRadius: number;
  /** 1-3 — how far the camera image is zoomed INSIDE the mask. */
  camZoom: number;
  /** -1..1 — pan the image inside the mask (0 = centred). */
  camPanX: number;
  camPanY: number;
}

interface MediaEntry {
  id: string;
  name: string;
  kind: 'image' | 'gif' | 'video';
  url: string;
  img?: HTMLImageElement;
  video?: HTMLVideoElement;
  gif?: { frames: Array<{ bmp: ImageBitmap; end: number }>; total: number; startedAt: number };
  audioNode?: MediaElementAudioSourceNode;
}
interface MediaListItem { id: string; name: string; kind: MediaEntry['kind']; url: string; }

interface ShareEntry {
  id: string;
  label: string;
  stream: MediaStream;
  video: HTMLVideoElement;
  audioSrc?: MediaStreamAudioSourceNode;
  gainNode?: GainNode;
  analyser?: AnalyserNode;
  hasAudio: boolean;
  /** Kept for OBS so a lost attach can be re-made without waiting for a
   *  track event — see the self-heal in drawSourceInto. */
  reattach?: (el: HTMLVideoElement) => void;
}
interface ShareListItem { id: string; label: string; hasAudio: boolean; gain: number; muted: boolean; }

/** Remembers the camera mask look (shape / corner radius / zoom). */
const CAM_MASK_KEY = 'hh-studio-cam-mask';


/** Set once the host has acknowledged the non-Chromium compatibility notice. */
const BROWSER_WARN_KEY = 'hh-studio-browser-warned';

/** A looping audio clip added via Add source → Sound → Audio file. */
interface SoundEntry {
  id: string;
  label: string;
  el: HTMLAudioElement;
  gainNode: GainNode;
  analyser: AnalyserNode;
}
interface SoundListItem { id: string; label: string; gain: number; muted: boolean; playing: boolean; loop: boolean; }

type Drawable = HTMLVideoElement | HTMLImageElement | ImageBitmap;

function dimsOf(s: Drawable): { w: number; h: number } {
  if (s instanceof HTMLVideoElement) return { w: s.videoWidth, h: s.videoHeight };
  if (typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap) return { w: s.width, h: s.height };
  const img = s as HTMLImageElement;
  return { w: img.naturalWidth, h: img.naturalHeight };
}
function drawCover(ctx: CanvasRenderingContext2D, s: Drawable, x: number, y: number, w: number, h: number) {
  const { w: vw, h: vh } = dimsOf(s);
  if (!vw || !vh) return;
  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(s, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
}
/** drawCover, but zoomed: a larger zoom samples a SMALLER centred region of
 *  the source, so the subject fills more of the mask. */
function drawCoverZoom(
  ctx: CanvasRenderingContext2D, s: Drawable,
  x: number, y: number, w: number, h: number,
  zoom: number, panX = 0, panY = 0,
) {
  const { w: vw, h: vh } = dimsOf(s);
  if (!vw || !vh) return;
  const scale = Math.max(w / vw, h / vh) * Math.max(1, zoom);
  const sw = w / scale, sh = h / scale;
  // Slack is whatever the crop leaves over on each axis; pan spends it.
  // Note a 16:9 camera in a SQUARE mask has horizontal slack even at zoom 1,
  // so panning is useful without zooming.
  const slackX = Math.max(0, (vw - sw) / 2);
  const slackY = Math.max(0, (vh - sh) / 2);
  const sx = Math.min(vw - sw, Math.max(0, slackX + panX * slackX));
  const sy = Math.min(vh - sh, Math.max(0, slackY + panY * slackY));
  ctx.drawImage(s, sx, sy, sw, sh, x, y, w, h);
}

/**
 * Fit a source whose aspect doesn't match the target, filling the leftover with
 * a blurred blow-up of the same frame — the treatment Reels/TikTok use.
 *
 * Phones routinely refuse a portrait capture and hand back a landscape frame
 * (1280×720 even when 720×1280 was requested). Covering a 9:16 canvas from that
 * samples barely 31% of the sensor width, so the shot looks permanently zoomed
 * in. Fitting instead keeps the WHOLE camera image visible at zoom 1, and the
 * blurred backdrop means no dead black bars.
 *
 * `zoom` scales the fitted image: 1 shows everything, higher crops in.
 */
function drawFitWithBackdrop(
  ctx: CanvasRenderingContext2D, s: Drawable,
  x: number, y: number, w: number, h: number, zoom = 1,
) {
  const { w: vw, h: vh } = dimsOf(s);
  if (!vw || !vh) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Backdrop: cover + blur, slightly overscanned so the blur's soft edge never
  // reveals the canvas behind it.
  ctx.filter = 'blur(28px)';
  const pad = Math.max(w, h) * 0.06;
  drawCover(ctx, s, x - pad, y - pad, w + pad * 2, h + pad * 2);
  ctx.filter = 'none';

  // Foreground: the real image, whole at zoom 1.
  const scale = Math.min(w / vw, h / vh) * Math.max(1, zoom);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(s, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/**
 * Draw a sideways sensor frame upright, filling the target.
 *
 * Android camera sensors are mounted landscape, so the raw frame is rotated
 * relative to an upright phone. Firefox rotates it for you (it reports a
 * 1920×824 track but hands the element 824×1920); Chrome does not, which is
 * why Chrome looked landscape while Firefox looked correct ON THE SAME DEVICE.
 *
 * Rotating here recovers the full frame: a 1920×1080 sensor frame becomes
 * 1080×1920, which is exactly 9:16 — it fills a portrait canvas with NO crop
 * and no letterboxing. Back sensors are typically mounted at 90°, front ones
 * at 270°, hence the direction depending on `facing`.
 */
function drawRotatedCover(
  ctx: CanvasRenderingContext2D, s: Drawable,
  w: number, h: number, quarterTurns: number, zoom = 1,
) {
  const { w: vw, h: vh } = dimsOf(s);
  if (!vw || !vh) return;
  const swaps = Math.abs(quarterTurns) % 2 === 1;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((quarterTurns * Math.PI) / 2);
  // An odd quarter turn swaps the source's axes, so cover against the swapped
  // dimensions; an even one (180°) keeps them.
  const scale = swaps
    ? Math.max(w / vh, h / vw) * Math.max(1, zoom)
    : Math.max(w / vw, h / vh) * Math.max(1, zoom);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(s, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function drawContain(ctx: CanvasRenderingContext2D, s: Drawable, x: number, y: number, w: number, h: number) {
  const { w: vw, h: vh } = dimsOf(s);
  if (!vw || !vh) return;
  const scale = Math.min(w / vw, h / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(s, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
function drawPlaceholder(ctx: CanvasRenderingContext2D, text: string, sub: string, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = '#101018';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#555';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(16, Math.round(w / 28))}px system-ui, sans-serif`;
  ctx.fillText(text, x + w / 2, y + h / 2 - 14);
  if (sub) {
    ctx.fillStyle = '#3d3d4d';
    ctx.font = `${Math.max(12, Math.round(w / 46))}px system-ui, sans-serif`;
    ctx.fillText(sub, x + w / 2, y + h / 2 + 16);
  }
}
function drawSlate(ctx: CanvasRenderingContext2D, w: number, h: number, title: string, now: number, kind: 'soon' | 'brb') {
  // Scale font sizes off the height so the slate reads the same at any
  // published resolution.
  const k = h / 720;
  /** Shrink a font until the text fits `maxW`. Sizing purely off height blew
   *  the headline far past the edges in portrait (h=1280 → a 114px headline on
   *  a 720px-wide canvas), which is why "STARTING SOON" was clipped. */
  const fitFont = (weight: number, basePx: number, text: string, maxW: number) => {
    let size = Math.round(basePx * k);
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    const width = ctx.measureText(text).width;
    if (width > maxW && width > 0) {
      size = Math.max(10, Math.floor((size * maxW) / width));
      ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    }
    return size;
  };
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#12121e');
  grad.addColorStop(1, '#08080f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const headline = kind === 'soon' ? 'STARTING SOON' : "WE'LL BE RIGHT BACK";
  const dotColor = kind === 'soon' ? '227, 19, 55' : '241, 196, 15';
  const pulse = 0.55 + 0.45 * Math.sin(now / 500);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Leave room for the pulsing dot and a margin on both sides.
  const headSize = fitFont(800, kind === 'soon' ? 64 : 56, headline, w * 0.74);
  // Offsets follow the FITTED size, so the dot stays glued to the text.
  const dotGap = headSize * 0.53;
  const dotR = headSize * 0.19;
  ctx.fillStyle = '#e8e8f0';
  ctx.fillText(headline, w / 2 + dotGap / 2, h / 2 - 20 * k);
  ctx.fillStyle = `rgba(${dotColor}, ${pulse.toFixed(3)})`;
  ctx.beginPath();
  const textW = ctx.measureText(headline).width;
  ctx.arc(w / 2 + dotGap / 2 - textW / 2 - dotGap, h / 2 - 20 * k, dotR, 0, Math.PI * 2);
  ctx.fill();
  if (title) {
    fitFont(500, 30, title, w * 0.86);
    ctx.fillStyle = '#8a8a9a';
    ctx.fillText(title, w / 2, h / 2 + 44 * k);
  }
}
async function decodeAnimatedImage(file: File): Promise<{ frames: Array<{ bmp: ImageBitmap; end: number }>; total: number } | null> {
  interface ImageDecoderLike {
    tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
    decode(opts: { frameIndex: number }): Promise<{ image: VideoFrame }>;
    close(): void;
  }
  const Ctor = (globalThis as unknown as {
    ImageDecoder?: { new (init: { data: ArrayBuffer; type: string }): ImageDecoderLike; isTypeSupported?(type: string): Promise<boolean>; };
  }).ImageDecoder;
  if (!Ctor) return null;
  try {
    if (Ctor.isTypeSupported && !(await Ctor.isTypeSupported(file.type))) return null;
    const decoder = new Ctor({ data: await file.arrayBuffer(), type: file.type });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount <= 1) { decoder.close(); return null; }
    const count = Math.min(track.frameCount, MAX_GIF_FRAMES);
    const frames: Array<{ bmp: ImageBitmap; end: number }> = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      total += (image.duration ? image.duration / 1000 : 100) || 100;
      const bmp = await createImageBitmap(image);
      image.close();
      frames.push({ bmp, end: total });
    }
    decoder.close();
    return { frames, total };
  } catch { return null; }
}
function pipRect(p: SceneParams) {
  const w0 = p.pipSize * CANVAS_W;
  const h = (w0 * 9) / 16;
  // A square mask makes the BOX square (side = the 16:9 height) rather than
  // leaving dead space inside a wider box — so it still sits PIP_MARGIN from
  // the edge instead of appearing inset.
  const w = p.camShape === 'square' ? h : w0;
  const v = (p.pipCorner || 'br')[0];
  const hz = (p.pipCorner || 'br')[1];
  const x = hz === 'l' ? PIP_MARGIN
    : hz === 'c' ? (CANVAS_W - w) / 2
    : CANVAS_W - w - PIP_MARGIN;
  const y = v === 't' ? PIP_MARGIN
    : v === 'c' ? (CANVAS_H - h) / 2
    : CANVAS_H - h - PIP_MARGIN;
  return { x, y, w, h };
}
/**
 * Map an RMS level onto 0..1 for the meters.
 *
 * Full scale is 0 dBFS — i.e. the top of the meter means ACTUAL clipping. The
 * old mapping topped out at −6 dBFS, so ordinary speech peaking at −12..−6 sat
 * in the red and looked like it was clipping when it wasn't.
 *
 * With a −60 dB floor: −20 → 0.67 (green), −15 → 0.75, −6 → 0.90 (amber/red
 * edge), 0 → 1.0 (red).
 */
function rmsToLevel(rms: number): number {
  const db = 20 * Math.log10(rms || 1e-8);
  const lvl = (db + 60) / 60;
  if (lvl < 0.06) return 0;
  return Math.max(0, Math.min(1, lvl));
}
/** Free-tier watermark, baked into the composite (top-left). Drawn last so
 *  it sits above everything, and burned into the published pixels so viewers
 *  can't strip it. Scales off the canvas height. */
function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, logo?: HTMLImageElement | null) {
  void w;
  const k = h / 720;
  const margin = Math.round(16 * k);
  // Real logo image (integrator-provided). A tainting/broken image has
  // naturalWidth 0 → skip it and fall through to the text mark.
  if (logo && logo.complete && logo.naturalWidth > 0) {
    const lh = Math.round(h * 0.06);
    const lw = Math.round(lh * (logo.naturalWidth / logo.naturalHeight));
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(logo, margin, margin, lw, lh);
    ctx.restore();
    return;
  }
  const font = Math.round(26 * k);
  const padX = Math.round(14 * k);
  const padY = Math.round(9 * k);
  ctx.save();
  ctx.font = `800 ${font}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'middle';
  const label = '3Speak';
  const tri = font * 0.7;
  const gap = font * 0.35;
  const textW = ctx.measureText(label).width;
  const boxW = padX * 2 + tri + gap + textW;
  const boxH = font + padY * 2;
  const x = margin, y = margin;
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#000';
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, boxW, boxH, boxH / 2); ctx.fill(); }
  else ctx.fillRect(x, y, boxW, boxH);
  ctx.globalAlpha = 0.95;
  const cy = y + boxH / 2;
  const tx = x + padX;
  ctx.fillStyle = '#e31337';
  ctx.beginPath();
  ctx.moveTo(tx, cy - tri * 0.55);
  ctx.lineTo(tx + tri, cy);
  ctx.lineTo(tx, cy + tri * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(label, tx + tri + gap, cy + k);
  ctx.restore();
}
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function looksLikeId(s: string): boolean {
  if (!s) return true;
  if (s.includes('://')) return true;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  if (/^[0-9a-f-]{32,}$/i.test(s)) return true;
  return false;
}
async function uploadImage(file: File, apiKey: string): Promise<string> {
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch('https://images.3speak.tv/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  const data = await res.json() as { success: boolean; url: string };
  if (!data.success || !data.url) throw new Error('Image upload failed');
  return data.url;
}
/** Tiny markdown → HTML for the description preview (escaped first). */
function renderMarkdown(md: string): string {
  let h = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  h = h
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  h = h.split(/\n{2,}/).map((block) =>
    /^<(h\d|ul|li)/.test(block.trim()) ? block : `<p>${block.replace(/\n/g, '<br/>')}</p>`,
  ).join('');
  return h;
}

export interface StandaloneStudioProps {
  roomName: string;
  title: string;
  onEndRoom: () => void;
  shareUrl?: string | null;
  /** 3Speak Pro flag from the server (create/join response). Video
   *  recording is Pro-only — same gate the conference egress enforces. */
  isPremium?: boolean;
  /** Hands the finished recording to the integrator (park in /studio, etc.).
   *  When omitted, the studio offers a local download instead. */
  onVideoHandoff?: (file: { blob: Blob; filename: string; duration: number; size: number }) => void;
  /** Logo image URL burned into non-premium streams (top-left watermark).
   *  Integrator-provided so each site brands its own free tier. MUST be
   *  same-origin or CORS-enabled — a tainting image is ignored (falls back
   *  to a text mark) so it can never break the canvas capture. When unset,
   *  the free-tier mark is text. */
  watermarkLogoUrl?: string;
  /** Pre-fill the post composer (title/description/thumbnail/tags) — e.g.
   *  from the create-room inputs, or a previously-saved stream post. */
  initialPost?: { title?: string; description?: string; thumbnail?: string; tags?: string[] };
  /** Fired ONCE, the first time the host hits "Start Stream" (standby → live).
   *  Carries the host's LATEST post-composer details so the integrator's
   *  announcement reflects edits made in the studio (not the create-time
   *  values). Use it to defer side effects — e.g. posting the Hive
   *  announcement — until the stream is actually broadcasting, not at room
   *  creation. Not re-fired on pause/resume. */
  onStreamStart?: (post?: { title?: string; description?: string; thumbnail?: string; tags?: string[] }) => void;
  /** Extra controls rendered at the bottom of the post-composer tab — e.g. a
   *  3Speak community / payout / beneficiaries picker for the Hive
   *  announcement. Editable right up until the host hits Start. */
  renderPostExtras?: React.ReactNode;
  /** Unlisted streams are never announced, so the post editor is pointless. */
  isUnlisted?: boolean;
  /** Close the studio (leave, WITHOUT ending the room). Renders an ✕ in the
   *  header; the studio confirms before calling it. */
  onClose?: () => void;
  /** Pro only: when the host ticks "Replace stream with a VOD", the studio
   *  records the whole broadcast automatically and hands the finished file
   *  here the moment they end the stream (before the room is torn down), so
   *  the integrator can publish it as the session's video-on-demand.
   *  Distinct from `onVideoHandoff`, which is the manual ⏺ Record button. */
  onStreamVod?: (file: { blob: Blob; filename: string; duration: number; size: number; roomName: string }) => void;
  /** False when the integrator has nothing for the VOD to replace (e.g. the
   *  host turned the Hive announcement off). Hides the "replace the stream
   *  with a video" option and stops it taking effect. Default true. */
  canPublishVod?: boolean;
}

export function StandaloneStudio({ roomName, title, onEndRoom, shareUrl, isPremium = false, onVideoHandoff, watermarkLogoUrl, initialPost, onStreamStart, renderPostExtras, onClose, onStreamVod, canPublishVod = true, isUnlisted = false }: StandaloneStudioProps) {
  const { localParticipant } = useLocalParticipant();
  const connectionState = useConnectionState();
  const participants = useParticipants();
  const { imageServerApiKey, apiClient, apiBaseUrl } = useHangoutsContext();
  const watermarkLogoRef = useRef<HTMLImageElement | null>(null);

  // Raw authed PATCH — used for the stream's post + broadcast endpoints so
  // they DON'T depend on the bundled apiClient having those (newer) methods.
  // Only needs apiBaseUrl + getSessionToken, present in every core version;
  // this sidesteps the recurring "method is not a function" stale-bundle trap.
  const authedPost = useCallback(async (path: string, body: unknown = {}) => {
    const token = apiClient.getSessionToken?.();
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      // Always send a body: declaring application/json with an EMPTY body makes
      // Fastify's JSON parser fail with "Body cannot be empty".
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(e.message || `HTTP ${res.status}`);
    }
    return res.json();
  }, [apiBaseUrl, apiClient]);

  const authedPatch = useCallback(async (path: string, body: unknown) => {
    const token = apiClient.getSessionToken?.();
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(e.message || `HTTP ${res.status}`);
    }
    return res.json();
  }, [apiBaseUrl, apiClient]);

  // ---- scene + source ----------------------------------------------------
  const [scene, setScene] = useState<StudioSceneId>('cam');
  const [source, setSource] = useState<SourceKey | null>(null);
  // The camera's whole look — mask shape, corner radius, zoom, and where the
  // host last dragged/resized the PiP — persisted together so framing survives
  // a reload.
  const camLookInit = (() => {
    const clamp = (n: unknown, lo: number, hi: number, dflt: number) =>
      typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    try {
      const raw = window.localStorage.getItem(CAM_MASK_KEY);
      const v = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      const corner = v?.corner;
      const valid: PipCorner[] = ['tl', 'tc', 'tr', 'cl', 'cc', 'cr', 'bl', 'bc', 'br'];
      // Old saves may hold shape:'circle' — that's now square @ 50% corners.
      const wasCircle = v?.shape === 'circle';
      return {
        shape: (wasCircle || v?.shape === 'square') ? 'square' as CamShape : 'rect' as CamShape,
        radius: wasCircle ? 50 : clamp(v?.radius, 0, 50, 8),
        zoom: clamp(v?.zoom, 1, 3, 1),
        panX: clamp(v?.panX, -1, 1, 0),
        panY: clamp(v?.panY, -1, 1, 0),
        corner: valid.includes(corner as PipCorner) ? corner as PipCorner : 'br' as PipCorner,
        size: clamp(v?.size, 0.08, 1, 0.24),
      };
    } catch {
      return { shape: 'rect' as CamShape, radius: 8, zoom: 1, panX: 0, panY: 0, corner: 'br' as PipCorner, size: 0.24 };
    }
  })();
  const [pipCorner, setPipCorner] = useState<PipCorner>(camLookInit.corner);
  const [pipSize, setPipSize] = useState(camLookInit.size);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [camShape, setCamShape] = useState<CamShape>(camLookInit.shape);
  const [camRadius, setCamRadius] = useState(camLookInit.radius);
  const [camZoom, setCamZoom] = useState(camLookInit.zoom);
  const [camPanX, setCamPanX] = useState(camLookInit.panX);
  const [camPanY, setCamPanY] = useState(camLookInit.panY);
  // Collapsed by default — it's fine-tuning, not something you touch every stream.
  const [camLookOpen, setCamLookOpen] = useState(false);
  const paramsRef = useRef<SceneParams>({
    scene, source, pipCorner, pipSize, splitRatio, camShape, camRadius, camZoom, camPanX, camPanY,
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(CAM_MASK_KEY, JSON.stringify({
        shape: camShape, radius: camRadius, zoom: camZoom,
        panX: camPanX, panY: camPanY,
        corner: pipCorner, size: pipSize,
      }));
    } catch { /* non-critical */ }
  }, [camShape, camRadius, camZoom, camPanX, camPanY, pipCorner, pipSize]);

  paramsRef.current = { scene, source, pipCorner, pipSize, splitRatio, camShape, camRadius, camZoom, camPanX, camPanY };

  // ---- stream lifecycle --------------------------------------------------
  const [streamState, setStreamState] = useState<StreamState>('standby');
  const streamStateRef = useRef<StreamState>('standby');
  const titleRef = useRef(title);
  titleRef.current = title;
  // Non-premium streams carry a baked-in watermark. Ref so the rAF draw
  // loop always reads the current value without re-binding.
  const showWatermarkRef = useRef(!isPremium);
  showWatermarkRef.current = !isPremium;

  // Load the integrator's watermark logo (non-premium only). crossOrigin
  // 'anonymous' means a cross-origin logo without CORS simply fails to load
  // (naturalWidth 0) → drawWatermark falls back to text, never tainting the
  // canvas (which would break captureStream).
  useEffect(() => {
    if (isPremium || !watermarkLogoUrl) { watermarkLogoRef.current = null; return undefined; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { watermarkLogoRef.current = img; };
    img.onerror = () => { watermarkLogoRef.current = null; };
    img.src = watermarkLogoUrl;
    return () => { watermarkLogoRef.current = null; };
  }, [isPremium, watermarkLogoUrl]);

  // ---- sources -----------------------------------------------------------
  const [camOn, setCamOn] = useState(false);
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [mediaItems, setMediaItems] = useState<MediaListItem[]>([]);
  const [sounds, setSounds] = useState<SoundListItem[]>([]);
  const [micOn, setMicOn] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [micGain, setMicGain] = useState(1);
  const [mediaGain, setMediaGain] = useState(1);
  const [mediaMuted, setMediaMuted] = useState(false);
  const [auxDevices, setAuxDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [auxDeviceId, setAuxDeviceId] = useState('');
  const [auxGain, setAuxGain] = useState(1);
  const [auxMuted, setAuxMuted] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [boostHistoryOpen, setBoostHistoryOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // OBS / external encoder ingest (WHIP).
  const [obsInfo, setObsInfo] = useState<{ whipUrl: string } | null>(null);
  const [obsOpen, setObsOpen] = useState(false);
  const [obsBusy, setObsBusy] = useState(false);
  const [obsError, setObsError] = useState('');
  const [obsLive, setObsLive] = useState(false);
  const [streamQuality, setStreamQuality] = useState<StreamQuality>('medium');
  const streamQualityRef = useRef<StreamQuality>('medium');
  streamQualityRef.current = streamQuality;
  const [recording, setRecording] = useState(false);
  // Pro: record the whole broadcast and publish it as the session's VOD when
  // the host ends the stream. Persisted so the preference sticks per host.
  const [autoVod, setAutoVod] = useState(() => {
    return readPref(AUTO_VOD_KEY);
  });
  const [savingVod, setSavingVod] = useState(false);
  // Chromium-only capture features (tab picking + tab/system audio) shape both
  // the copy and a one-time heads-up for Firefox/Safari hosts.
  const chromium = useMemo(() => isChromium(), []);
  const [showBrowserWarn, setShowBrowserWarn] = useState(false);
  useEffect(() => {
    if (chromium) return;
    try { if (window.localStorage.getItem(BROWSER_WARN_KEY) === '1') return; } catch { /* ignore */ }
    setShowBrowserWarn(true);
  }, [chromium]);
  // Pro: keep a local copy of the broadcast, downloaded when the stream ends.
  const [autoDownload, setAutoDownload] = useState(() => {
    return readPref(AUTO_DL_KEY);
  });
  const autoDownloadRef = useRef(false);
  autoDownloadRef.current = autoDownload && isPremium;
  const autoVodRef = useRef(false);
  autoVodRef.current = autoVod && isPremium && canPublishVod;
  // Resolved by the recorder's onstop so we can finish writing the file before
  // tearing the room down.
  const recStopResolveRef = useRef<(() => void) | null>(null);
  // startRecording is declared much further down; the go-live effect reaches it
  // through this ref so its dep array never touches a TDZ binding.
  const startRecordingRef = useRef<() => void>(() => {});
  const [recElapsed, setRecElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recElapsedRef = useRef(0);

  // ---- post composer (pre-filled from create-room inputs / saved post) ----
  // Falls back to the host's last-used draft in localStorage, so title,
  // thumbnail, description and tags come back pre-filled next time. Values
  // that came with the room (create-dialog / saved post) always win.
  const postDraft = useMemo(() => readPostDraft(), []);
  const [postTitle, setPostTitle] = useState(() => initialPost?.title || postDraft?.title || '');
  const [postThumb, setPostThumb] = useState(() => initialPost?.thumbnail || postDraft?.thumbnail || '');
  const [postThumbUploading, setPostThumbUploading] = useState(false);
  const [postDesc, setPostDesc] = useState(() => initialPost?.description || postDraft?.description || '');
  const [descPreview, setDescPreview] = useState(false);
  const [postTags, setPostTags] = useState<string[]>(() => (initialPost?.tags?.length ? initialPost.tags : postDraft?.tags) ?? []);
  const [tagInput, setTagInput] = useState('');
  const [postModalOpen, setPostModalOpen] = useState(false);
  // Post tab first — hosts set up the stream's post details before going live.
  const [rightTab, setRightTab] = useState<'chat' | 'post'>('post');
  const postLocked = streamState !== 'standby';

  // ---- panel sizing ------------------------------------------------------
  const [leftW, setLeftW] = useState(184);
  const [chatW, setChatW] = useState(430);
  const [faderH, setFaderH] = useState(120);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [mixerCollapsed, setMixerCollapsed] = useState(false);

  // ---- mobile ------------------------------------------------------------
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  type MobileSheetId = 'chat' | 'post' | 'mic' | 'lens' | 'share';
  const [mobileSheet, setMobileSheet] = useState<MobileSheetId | null>(null);
  // Phones shoot both ways. The whole compositor (preview canvas, program
  // canvas, published track) swaps to 9:16 rather than letterboxing a portrait
  // camera into a landscape frame.
  // Mobile is portrait-only for now — deliberately not user-switchable, so
  // there's one shape to get right. The landscape path still exists for
  // desktop and can be re-exposed by restoring the rail button.
  const [portrait, setPortrait] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY).matches) return true;
    try { return localStorage.getItem(ORIENTATION_KEY) === 'portrait'; } catch { return false; }
  });
  const portraitRef = useRef(portrait);
  portraitRef.current = portrait;
  // The placeholder must not tell a phone user to press a button that only
  // exists in the desktop rail.
  const camHintRef = useRef('Add it via ＋ Add source');
  /** Last good camera frame, painted while a new camera opens so the swap
   *  doesn't flash a "Camera is off" placeholder for 1-2 seconds. */
  const camFreezeRef = useRef<HTMLCanvasElement | null>(null);
  const canvasW = portrait ? CANVAS_H : CANVAS_W;
  const canvasH = portrait ? CANVAS_W : CANVAS_H;
  // Per-sheet heights so resizing chat doesn't shrink the post editor.
  const [sheetH, setSheetH] = useState<Record<MobileSheetId, number>>(() => {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    // Post is a full editor (title, thumbnail, tags, community, beneficiaries)
    // so it opens near full-screen; chat deliberately doesn't, so the camera
    // stays visible behind it.
    return {
      chat: Math.round(vh * 0.62), post: Math.round(vh * 0.92),
      mic: Math.round(vh * 0.5), lens: Math.round(vh * 0.5), share: Math.round(vh * 0.42),
    };
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const obsVideoElRef = useRef<HTMLVideoElement>(null);
  const obsHealAtRef = useRef(0);
  const programCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const programStreamRef = useRef<MediaStream | null>(null);
  const publishedVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const sharesMapRef = useRef<Map<string, ShareEntry>>(new Map());
  const mediaMapRef = useRef<Map<string, MediaEntry>>(new Map());
  const soundsMapRef = useRef<Map<string, SoundEntry>>(new Map());
  const shareCounterRef = useRef(0);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const soundInputRef = useRef<HTMLInputElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const mediaGainNodeRef = useRef<GainNode | null>(null);
  const auxGainNodeRef = useRef<GainNode | null>(null);
  const preMasterRef = useRef<GainNode | null>(null);   // all sources → here
  const masterGainNodeRef = useRef<GainNode | null>(null); // live gate → published dest
  const recordDestRef = useRef<MediaStreamAudioDestinationNode | null>(null); // pre-gate tap for recording
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const auxStreamRef = useRef<MediaStream | null>(null);
  const auxSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const publishedRef = useRef(false);
  const analysersRef = useRef<Record<string, AnalyserNode>>({});
  const meterFillRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const ensureProgramCanvas = useCallback(() => {
    if (!programCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = portraitRef.current ? CANVAS_H : CANVAS_W;
      c.height = portraitRef.current ? CANVAS_W : CANVAS_H;
      programCanvasRef.current = c;
    }
    return programCanvasRef.current;
  }, []);

  const ensureProgramStream = useCallback(() => {
    if (!programStreamRef.current) programStreamRef.current = ensureProgramCanvas().captureStream(30);
    return programStreamRef.current;
  }, [ensureProgramCanvas]);

  const ensureAudioGraph = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctor = (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
      const ctx = new Ctor();
      audioCtxRef.current = ctx;
      destRef.current = ctx.createMediaStreamDestination();
      // preMaster carries the full mix; master applies the live gate before
      // the published dest, while recordDest taps preMaster so a recording
      // always has audio even during standby/pause.
      preMasterRef.current = ctx.createGain();
      masterGainNodeRef.current = ctx.createGain();
      masterGainNodeRef.current.gain.value = streamStateRef.current === 'live' ? 1 : 0;
      preMasterRef.current.connect(masterGainNodeRef.current);
      masterGainNodeRef.current.connect(destRef.current);
      recordDestRef.current = ctx.createMediaStreamDestination();
      preMasterRef.current.connect(recordDestRef.current);
      micGainNodeRef.current = ctx.createGain();
      mediaGainNodeRef.current = ctx.createGain();
      auxGainNodeRef.current = ctx.createGain();
      micGainNodeRef.current.connect(preMasterRef.current);
      mediaGainNodeRef.current.connect(preMasterRef.current);
      auxGainNodeRef.current.connect(preMasterRef.current);
      mediaGainNodeRef.current.connect(ctx.destination);
      const gains: Record<string, GainNode> = {
        mic: micGainNodeRef.current, aux: auxGainNodeRef.current, media: mediaGainNodeRef.current,
      };
      for (const key of Object.keys(gains)) {
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        gains[key].connect(an);
        analysersRef.current[key] = an;
      }
    }
    void audioCtxRef.current.resume().catch(() => { /* needs a gesture */ });
    return audioCtxRef.current;
  }, []);

  useEffect(() => { if (micGainNodeRef.current) micGainNodeRef.current.gain.value = micMuted ? 0 : micGain; }, [micGain, micMuted]);
  useEffect(() => { if (mediaGainNodeRef.current) mediaGainNodeRef.current.gain.value = mediaMuted ? 0 : mediaGain; }, [mediaGain, mediaMuted]);
  useEffect(() => { if (auxGainNodeRef.current) auxGainNodeRef.current.gain.value = auxMuted ? 0 : auxGain; }, [auxGain, auxMuted]);

  const setShareGain = useCallback((id: string, gain: number) => {
    setShares((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      const node = sharesMapRef.current.get(id)?.gainNode;
      if (node) node.gain.value = s.muted ? 0 : gain;
      return { ...s, gain };
    }));
  }, []);
  const toggleShareMute = useCallback((id: string) => {
    setShares((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      const muted = !s.muted;
      const node = sharesMapRef.current.get(id)?.gainNode;
      if (node) node.gain.value = muted ? 0 : s.gain;
      return { ...s, muted };
    }));
  }, []);
  const renameShare = useCallback((id: string) => {
    const cur = sharesMapRef.current.get(id);
    const picked = window.prompt('Rename this share:', cur?.label ?? '');
    if (!picked || !picked.trim()) return;
    const label = picked.trim();
    if (cur) cur.label = label;
    setShares((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)));
  }, []);

  const setSoundGain = useCallback((id: string, gain: number) => {
    setSounds((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      const node = soundsMapRef.current.get(id)?.gainNode;
      if (node) node.gain.value = s.muted ? 0 : gain;
      return { ...s, gain };
    }));
  }, []);
  const toggleSoundMute = useCallback((id: string) => {
    setSounds((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      const muted = !s.muted;
      const node = soundsMapRef.current.get(id)?.gainNode;
      if (node) node.gain.value = muted ? 0 : s.gain;
      return { ...s, muted };
    }));
  }, []);
  const removeSound = useCallback((id: string) => {
    const e = soundsMapRef.current.get(id);
    if (e) {
      e.el.pause();
      e.gainNode.disconnect();
      e.analyser.disconnect();
      URL.revokeObjectURL(e.el.src);
      soundsMapRef.current.delete(id);
    }
    delete analysersRef.current[id];
    delete meterFillRefs.current[id];
    setSounds((prev) => prev.filter((s) => s.id !== id));
  }, []);

  useEffect(() => {
    streamStateRef.current = streamState;
    if (masterGainNodeRef.current) masterGainNodeRef.current.gain.value = streamState === 'live' ? 1 : 0;
  }, [streamState]);

  // Fire onStreamStart exactly once — the first time the host goes live —
  // carrying the LATEST post-composer details so the integrator's announcement
  // reflects studio edits, not the create-time values. Not re-fired on
  // pause → resume. A ref mirrors the post state to avoid a stale closure.
  const postRef = useRef({ title: '', description: '', thumbnail: '', tags: [] as string[] });
  postRef.current = { title: postTitle, description: postDesc, thumbnail: postThumb, tags: postTags };

  // Remember the post composer between sessions so the next stream opens
  // pre-filled with what the host used last.
  useEffect(() => {
    writePostDraft(postRef.current);
  }, [postTitle, postDesc, postThumb, postTags]);

  // Auto-save the stream post to the server — there's no Save button. Debounced
  // so typing doesn't PATCH on every keystroke, skipped on the first render (we
  // don't want to write the pre-filled draft over a room's own saved post), and
  // skipped once the post is locked (stream running).
  const postAutoSaveReadyRef = useRef(false);
  useEffect(() => {
    if (!postAutoSaveReadyRef.current) { postAutoSaveReadyRef.current = true; return undefined; }
    if (postLocked) return undefined;
    const t = setTimeout(() => { void savePost(); }, 900);
    return () => clearTimeout(t);
  }, [postTitle, postDesc, postThumb, postTags]);
  const streamStartFiredRef = useRef(false);
  useEffect(() => {
    if (streamState === 'live' && !streamStartFiredRef.current) {
      streamStartFiredRef.current = true;
      onStreamStart?.({ ...postRef.current });
      // Tell the server we're live so it can stamp the moment (viewers anchor
      // chat timecodes to it) and record whether a VOD is coming. Fire-and-
      // forget: a failure here must never block going live.
      void authedPatch(`/rooms/${encodeURIComponent(roomName)}/live`, {
        willPublishVod: autoVodRef.current && !!onStreamVod,
      }).catch(() => { /* timecodes fall back to the post's timestamp */ });
      // Auto-VOD: start capturing the moment we go live, so the published
      // video covers the whole broadcast without the host doing anything.
      if ((autoVodRef.current || autoDownloadRef.current) && !recorderRef.current) startRecordingRef.current();
    }
  }, [streamState, onStreamStart, authedPatch, roomName, onStreamVod]);

  // Remember the Pro auto-VOD preference between sessions.
  useEffect(() => {
    writePref(AUTO_VOD_KEY, autoVod);
  }, [autoVod]);
  useEffect(() => {
    writePref(AUTO_DL_KEY, autoDownload);
  }, [autoDownload]);

  // Reflect the live state server-side so the stream appears in the live
  // feeds only while actually broadcasting (live), not standby/paused.
  // A heartbeat re-asserts `true` while live so the flag self-heals even if
  // an out-of-order request (dev StrictMode double-mount, network reorder)
  // left a stale `false` behind.
  useEffect(() => {
    const live = streamState === 'live';
    const send = () => authedPatch(`/rooms/${encodeURIComponent(roomName)}/broadcast`, { broadcasting: live })
      .catch(() => { /* best-effort */ });
    send();
    if (!live) return undefined;
    const t = setInterval(send, 15000);
    return () => clearInterval(t);
  }, [streamState, roomName, authedPatch]);

  // ---- level meters ------------------------------------------------------
  useEffect(() => {
    let raf = 0;
    const buf = new Float32Array(512);
    const levels: Record<string, number> = {};
    const tick = () => {
      for (const key of Object.keys(meterFillRefs.current)) {
        const el = meterFillRefs.current[key];
        if (!el) continue;
        const an = analysersRef.current[key];
        if (!an) { el.style.setProperty('--lvl', '0'); continue; }
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const lvl = rmsToLevel(Math.sqrt(sum / buf.length));
        levels[key] = Math.max(lvl, (levels[key] ?? 0) * 0.88);
        el.style.setProperty('--lvl', levels[key].toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- device selection --------------------------------------------------
  // Phones have two cameras and often an external mic; both choices are
  // remembered. Refs shadow the state so the acquisition callbacks can read
  // the current value without being rebuilt (and re-running their effects).
  const [camFacing, setCamFacing] = useState<'user' | 'environment'>(() => {
    try { return localStorage.getItem(CAM_FACING_KEY) === 'environment' ? 'environment' : 'user'; } catch { return 'user'; }
  });
  const camFacingRef = useRef(camFacing);
  camFacingRef.current = camFacing;

  const [micDeviceId, setMicDeviceId] = useState<string>(() => {
    try { return localStorage.getItem(MIC_DEVICE_KEY) || ''; } catch { return ''; }
  });
  const micDeviceIdRef = useRef(micDeviceId);
  micDeviceIdRef.current = micDeviceId;

  // Camera zoom. Prefers the REAL lens (Android exposes a `zoom` capability
  // and switching past ~2× picks the tele lens where one exists); falls back to
  // cropping the canvas when the browser has no zoom capability, so the control
  // works everywhere.
  const [camZoomLevel, setCamZoomLevel] = useState(1);
  const camZoomRef = useRef(1);
  camZoomRef.current = camZoomLevel;
  const softZoomRef = useRef(1);

  // Phones expose each LENS as its own videoinput (main, ultra-wide, tele), and
  // `facingMode` only ever reaches the default one. Enumerate them so the host
  // can pick the actual lens — zoom alone can't cross to a different camera.
  const [camDeviceId, setCamDeviceId] = useState<string>(() => {
    try { return localStorage.getItem(CAM_DEVICE_KEY) || ''; } catch { return ''; }
  });
  const camDeviceIdRef = useRef(camDeviceId);
  camDeviceIdRef.current = camDeviceId;
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  // Back sensors on Android are usually mounted at 90°; front sensors vary and
  // frequently arrive already upright. Defaults reflect that, and the Lens
  // sheet lets the host fix whichever one their phone disagrees about.
  // Keyed by LENS, not just by side: on the same phone the default front
  // camera can need a different turn than a manually-picked front lens, which
  // is exactly what "selecting a lens manually fixes it" means.
  const [camRot, setCamRot] = useState<Record<string, number>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(CAM_ROTATION_KEY) || 'null');
      if (raw && typeof raw === 'object') return raw as Record<string, number>;
    } catch { /* fall through to defaults */ }
    return {};
  });
  const camRotRef = useRef(camRot);
  camRotRef.current = camRot;
  // Back sensors on Android are usually mounted at 90°; front ones frequently
  // arrive upright already. Used until the host corrects a given lens.
  const rotKeyRef = useRef('environment');
  /** What the compositor worked out on its own for the current frame. */
  const camAutoTurnsRef = useRef(0);
  /** Landscape modes we had to reject while hunting for a portrait one. */
  const camTriedModesRef = useRef<string[]>([]);
  const [effTurns, setEffTurns] = useState(0);
  const effTurnsRef = useRef(0);
  const resetCameraRotation = useCallback(() => {
    setCamRot((prev) => {
      const next = { ...prev };
      delete next[rotKeyRef.current];
      try { localStorage.setItem(CAM_ROTATION_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const rotateCamera = useCallback(() => {
    setCamRot((prev) => {
      const key = rotKeyRef.current;
      const cur = prev[key] ?? camAutoTurnsRef.current;
      const next = { ...prev, [key]: (cur + 1) % 4 };   // 0 → 90 → 180 → 270
      try { localStorage.setItem(CAM_ROTATION_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);
  const [lensError, setLensError] = useState('');
  // What the sensor is ACTUALLY delivering. Shown in the lens sheet because a
  // portrait canvas fed by a landscape frame is indistinguishable from "the
  // zoom is broken" — the numbers tell you which it is.
  const [camDiag, setCamDiag] = useState('');
  // Unread chat while the sheet is closed. Counted from the message list so we
  // don't need a second subscription — the sheet reads the same source.
  const [chatUnread, setChatUnread] = useState(0);
  const { messages: chatMessages } = useChat();
  const seenChatRef = useRef(0);
  useEffect(() => {
    const total = chatMessages.length;
    if (mobileSheet === 'chat') {
      // Sheet is open — everything is read.
      seenChatRef.current = total;
      setChatUnread(0);
      return;
    }
    setChatUnread(Math.max(0, total - seenChatRef.current));
  }, [chatMessages, mobileSheet]);

  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const refreshAudioInputs = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(list.filter((d) => d.kind === 'audioinput' && d.deviceId));
      const cams = list.filter((d) => d.kind === 'videoinput' && d.deviceId);
      setVideoInputs(cams);

      // Prefer the widest lens — but ONLY when a label actually identifies one,
      // and only if the host hasn't already chosen. Guessing from an
      // uninformative label ("camera2 1, facing back") could pin a telephoto.
      if (!camDeviceIdRef.current && !autoWidestTriedRef.current && isMobileRef.current) {
        autoWidestTriedRef.current = true;
        const ranked = cams
          .filter((d) => d.label && lensMatchesFacing(d.label, camFacingRef.current))
          .map((d) => ({ d, rank: lensWidthRank(d.label) }))
          .filter((x): x is { d: MediaDeviceInfo; rank: number } => x.rank !== null)
          .sort((a, b) => a.rank - b.rank);
        if (ranked.length && ranked[0].rank === 0) {
          void selectCameraRef.current?.(ranked[0].d.deviceId);
        }
      }
    } catch { /* enumeration needs permission; retried after startMic */ }
  }, []);
  const autoWidestTriedRef = useRef(false);
  const selectCameraRef = useRef<((id: string) => Promise<void>) | null>(null);
  // startMic refreshes the list once permission lands, but is declared above
  // this point — route through a ref instead of reordering the file.
  const refreshAudioInputsRef = useRef<(() => Promise<void>) | null>(null);
  refreshAudioInputsRef.current = refreshAudioInputs;

  // ---- input sources -----------------------------------------------------
  const startMic = useCallback(async (deviceId?: string) => {
    if (micStreamRef.current) return;
    const wanted = deviceId ?? micDeviceIdRef.current;
    const open = (id: string) => navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(id ? { deviceId: { exact: id } } : {}),
      },
    });
    let stream: MediaStream;
    try {
      stream = await open(wanted);
    } catch {
      if (!wanted) { setMediaError('Microphone access denied.'); return; }
      // A remembered device can simply be gone — an unplugged USB-C mic is the
      // common case on a phone. Fall back to the system default rather than
      // leaving the host silent.
      try {
        stream = await open('');
        setMicDeviceId('');
        micDeviceIdRef.current = '';
      } catch { setMediaError('Microphone access denied.'); return; }
    }
    const ctx = ensureAudioGraph();
    micStreamRef.current = stream;
    micSourceRef.current = ctx.createMediaStreamSource(stream);
    micSourceRef.current.connect(micGainNodeRef.current!);
    setMicOn(true);
    // Device labels stay blank until mic permission is granted, so this is the
    // first moment a picker can show real names.
    void refreshAudioInputsRef.current?.();
  }, [ensureAudioGraph]);
  const stopMic = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    setMicOn(false);
  }, []);

  const startCam = useCallback(async (facing?: 'user' | 'environment', deviceId?: string) => {
    if (camStreamRef.current) return;
    const want = facing ?? camFacingRef.current;
    const id = deviceId ?? camDeviceIdRef.current;
    // Deliberately NO size or aspect constraints.
    //
    // Asking for 1280×720 was actively counter-productive: the browser picks
    // the nearest supported mode, and on Android that pinned the capture to
    // LANDSCAPE even on a portrait page. Left alone, the browser hands back its
    // natural orientation — which follows the device. Whatever shape arrives,
    // the compositor fits it (see drawFitWithBackdrop), so there's nothing to
    // gain by fighting the camera for a specific resolution.
    // Resolution has to be set HERE, at open time. applyConstraints on a live
    // track can only crop DOWN from the mode the camera was opened with — it
    // cannot promote 640×480 to 1080p, which is why every post-open upgrade
    // silently did nothing and the frame stayed at the 640×480 default.
    //
    // Portrait shape first (some devices honour it), then a high-res landscape
    // mode, then bare. Each result is measured below and the best kept.
    const base: MediaTrackConstraints = id
      ? { deviceId: { exact: id } }
      : { facingMode: { ideal: want } };
    // Open ONCE with no size constraints — this always works and is what the
    // browser considers natural for the device. Only if the RENDERED frame
    // comes back landscape do we probe a couple of portrait modes, and we keep
    // a working stream the whole time.
    const openWith = async (extra: MediaTrackConstraints) => {
      try { return await navigator.mediaDevices.getUserMedia({ video: { ...base, ...extra } }); }
      catch (err) { lastErr = err; return null; }
    };

    // Orientation MUST be judged from the video element, not getSettings():
    // Firefox rotates for you and reports a landscape track (1920×824) while
    // the element renders portrait (824×1920). Trusting the track settings
    // made us "fix" a stream that was already correct, which is what broke
    // Firefox after Chrome started working.
    const attach = (ms: MediaStream) => new Promise<HTMLVideoElement>((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = ms;
      void v.play().catch(() => { /* drawn once frames arrive */ });
      if (v.readyState >= 1 && v.videoWidth) { resolve(v); return; }
      const done = () => resolve(v);
      v.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 1200);   // never hang on a camera that won't report
    });

    let stream: MediaStream | null = null;
    let lastErr: unknown = null;
    const triedModes: string[] = [];

    stream = await openWith({});
    let el = stream ? await attach(stream) : null;

    if (stream && el && portraitRef.current && el.videoWidth >= el.videoHeight && el.videoWidth) {
      triedModes.push(`${el.videoWidth}x${el.videoHeight}`);
      // At most TWO probes, each with the camera fully released first.
      for (const mode of [
        { width: { ideal: 1080 }, height: { ideal: 1920 } },
        { width: { ideal: 720 }, height: { ideal: 1280 } },
      ]) {
        stream.getTracks().forEach((t) => t.stop());
        await new Promise((r) => setTimeout(r, 200));
        const candidate = await openWith(mode);
        if (!candidate) {
          // Camera refused — reopen the plain one so we're never left empty.
          stream = await openWith({});
          el = stream ? await attach(stream) : null;
          break;
        }
        stream = candidate;
        el = await attach(candidate);
        if (el.videoHeight > el.videoWidth) break;         // portrait — done
        triedModes.push(`${el.videoWidth}x${el.videoHeight}`);
      }
    }

    // Resolution top-up — RESOLUTION ONLY, never shape.
    //
    // Hard-won: when the browser already hands back a pre-rotated portrait
    // frame (Firefox does), any attempt to renegotiate its SHAPE makes things
    // worse. Asking for a bigger long edge alone got an ultra-wide 1920×824
    // (correct orientation, some crop); asking for whole 16:9 modes made
    // Firefox stop pre-rotating altogether, so the frame came back landscape
    // and the compositor's auto-rotation spun the picture.
    //
    // So: one axis, and only when the frame is genuinely small. Anything that
    // disturbs the rendered orientation is reverted immediately.
    if (stream && el) {
      const track = stream.getVideoTracks()[0];
      const st0 = track?.getSettings?.() ?? {};
      const sw0 = st0.width ?? 0, sh0 = st0.height ?? 0;
      const elem = el;
      const longEdge = Math.max(elem.videoWidth, elem.videoHeight);
      const wasTall = elem.videoHeight > elem.videoWidth;

      const settle = () => new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; elem.removeEventListener('resize', finish); resolve(); };
        elem.addEventListener('resize', finish);
        setTimeout(finish, 700);
      });

      if (track && sw0 && sh0 && longEdge > 0 && longEdge < 1280) {
        try {
          await track.applyConstraints(
            sh0 >= sw0 ? { height: { ideal: 1920 } } : { width: { ideal: 1920 } },
          );
          await settle();
          // The ONLY thing that disqualifies the upgrade: the rendered frame
          // changed orientation. That flips the compositor's rotation decision
          // and shows the picture sideways.
          if (wasTall !== (elem.videoHeight > elem.videoWidth)) {
            await track.applyConstraints({ width: { ideal: sw0 }, height: { ideal: sh0 } });
            await settle();
          }
        } catch { /* keep whatever we already have */ }
      }
    }

    if (!stream) {
      if (id) {
        // The chosen lens genuinely won't open. Revert to automatic so the host
        // still has a picture, and record why so the picker can explain itself
        // instead of appearing to silently snap back.
        setCamDeviceId('');
        camDeviceIdRef.current = '';
        try { localStorage.removeItem(CAM_DEVICE_KEY); } catch { /* private mode */ }
        const name = (lastErr as { name?: string } | null)?.name ?? '';
        setLensError(
          name === 'NotReadableError'
            ? 'That lens is busy or unavailable — another app may be using it.'
            : "Your browser wouldn't open that lens directly.",
        );
        return startCamRef.current?.(want, '');
      }
      setMediaError('Camera access denied.');
      return;
    }

    camTriedModesRef.current = triedModes;
    // Which rotation entry applies to the lens we just opened.
    const openedId = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
    rotKeyRef.current = openedId || want;

    camStreamRef.current = stream;
    const v = el ?? await attach(stream);
    camVideoRef.current = v;
    setCamOn(true);
    // Drop the frozen frame as soon as the new camera produces one.
    const clearFreeze = () => { camFreezeRef.current = null; };
    if (v.readyState >= 2 && v.videoWidth) clearFreeze();
    else v.addEventListener('loadeddata', clearFreeze, { once: true });
    // A new track starts at 1× — restore whatever the host had picked.
    if (camZoomRef.current > 1) setTimeout(() => applyZoomRef.current?.(camZoomRef.current), 0);
    // Adding a camera almost always means you want to be heard too — bring the
    // mic along unless it's already running.
    if (!micStreamRef.current) void startMic();
  }, [startMic]);
  const startCamRef = useRef<((f?: 'user' | 'environment', d?: string) => Promise<void>) | null>(null);
  const stopCam = useCallback((freeze = false) => {
    // Grab the current frame BEFORE tearing the track down, so the compositor
    // has something to show while the next camera spins up.
    const v = camVideoRef.current;
    if (freeze && v && v.videoWidth > 0) {
      const c = camFreezeRef.current ?? document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      try {
        c.getContext('2d')?.drawImage(v, 0, 0);
        camFreezeRef.current = c;
      } catch { camFreezeRef.current = null; }
    } else if (!freeze) {
      camFreezeRef.current = null;
    }
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    camVideoRef.current = null;
    setCamOn(false);
  }, []);

  startCamRef.current = startCam;

  /** Flip between the front and back camera. Safe while live: the compositor
   *  reads whatever `camVideoRef` currently points at, and the PUBLISHED track
   *  is the program canvas — not the camera — so viewers see no renegotiation,
   *  just the picture changing. */
  const switchCamera = useCallback(async () => {
    const next = camFacingRef.current === 'user' ? 'environment' : 'user';
    camFacingRef.current = next;
    setCamFacing(next);
    // Clear any pinned lens: it belongs to the side we're leaving, and an
    // explicit deviceId outranks facingMode, so flipping would do nothing.
    setCamDeviceId('');
    camDeviceIdRef.current = '';
    try {
      localStorage.setItem(CAM_FACING_KEY, next);
      localStorage.removeItem(CAM_DEVICE_KEY);
    } catch { /* private mode */ }
    stopCam(true);
    await startCam(next, '');
  }, [startCam, stopCam]);

  useEffect(() => {
    if (mobileSheet !== 'lens') return;
    const tick = () => {
      const v = camVideoRef.current;
      const track = camStreamRef.current?.getVideoTracks()[0];
      const st = (track?.getSettings?.() ?? {}) as { width?: number; height?: number };
      const caps = track?.getCapabilities?.() as {
        zoom?: { min: number; max: number };
        width?: { min?: number; max?: number };
        height?: { min?: number; max?: number };
        aspectRatio?: { min?: number; max?: number };
      } | undefined;
      const c = canvasRef.current;
      const frame = v ? `${v.videoWidth}×${v.videoHeight}` : 'none';
      const shape = v && v.videoHeight > v.videoWidth ? 'portrait' : 'landscape';
      const eff = (((camRotRef.current[rotKeyRef.current] ?? camAutoTurnsRef.current) % 4) + 4) % 4;
      effTurnsRef.current = eff;
      setEffTurns(eff);
      setCamDiag(
        `sensor ${st.width ?? '?'}×${st.height ?? '?'} · frame ${frame} (${shape})`
        + ` · canvas ${c?.width ?? 0}×${c?.height ?? 0}`
        + ` · rot auto ${camAutoTurnsRef.current * 90}° applied ${effTurnsRef.current * 90}°`
        + `${camRotRef.current[rotKeyRef.current] === undefined ? '' : ' (override)'}`
        + ` · rejected [${camTriedModesRef.current.join(' ') || 'none'}]`
        + ` · screen ${(screen.orientation?.type ?? '?')}@${screen.orientation?.angle ?? '?'}°`
        + ` · zoom ${caps?.zoom ? `hardware ${caps.zoom.min}–${caps.zoom.max}` : 'software'}`
        + ` @${camZoomLevel.toFixed(1)}×`
        + ` · supports w ${caps?.width?.min ?? '?'}–${caps?.width?.max ?? '?'}`
        + ` h ${caps?.height?.min ?? '?'}–${caps?.height?.max ?? '?'}`
        + ` ar ${caps?.aspectRatio?.min?.toFixed(2) ?? '?'}–${caps?.aspectRatio?.max?.toFixed(2) ?? '?'}`,
      );
    };
    tick();
    const id = window.setInterval(tick, 800);
    return () => window.clearInterval(id);
  }, [mobileSheet, camZoomLevel]);

  /** Pick a specific lens (main / ultra-wide / tele). */
  const selectCamera = useCallback(async (deviceId: string) => {
    setLensError('');
    setCamDeviceId(deviceId);
    camDeviceIdRef.current = deviceId;
    try {
      if (deviceId) localStorage.setItem(CAM_DEVICE_KEY, deviceId);
      else localStorage.removeItem(CAM_DEVICE_KEY);
    } catch { /* private mode */ }
    stopCam(true);
    // Phones need a moment to actually release the previous lens; reopening
    // immediately gets a NotReadableError on some Android builds.
    await new Promise((r) => setTimeout(r, 150));
    await startCam(undefined, deviceId);
  }, [startCam, stopCam]);
  selectCameraRef.current = selectCamera;

  const applyZoomRef = useRef<((n: number) => void) | null>(null);
  const applyZoom = useCallback((level: number) => {
    const next = Math.max(1, Math.min(4, Math.round(level * 10) / 10));
    setCamZoomLevel(next);
    camZoomRef.current = next;
    const track = camStreamRef.current?.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as { zoom?: { min: number; max: number } } | undefined;
    if (track && caps?.zoom) {
      // Hardware zoom: map 1..4 onto the device's own range so the phone can
      // pick a different physical lens rather than upscaling a crop.
      const { min, max } = caps.zoom;
      const mapped = Math.min(max, Math.max(min, min + ((next - 1) / 3) * (max - min)));
      softZoomRef.current = 1;
      // `zoom` is a standard capability but isn't in lib.dom's constraint type.
      void track.applyConstraints({ advanced: [{ zoom: mapped }] } as unknown as MediaTrackConstraints)
        .catch(() => { softZoomRef.current = next; });
    } else {
      softZoomRef.current = next;
    }
  }, []);

  applyZoomRef.current = applyZoom;

  /** Switch the main microphone (internal ↔ USB-C/Bluetooth). */
  const selectMic = useCallback(async (deviceId: string) => {
    setMicDeviceId(deviceId);
    micDeviceIdRef.current = deviceId;
    try { localStorage.setItem(MIC_DEVICE_KEY, deviceId); } catch { /* private mode */ }
    stopMic();
    await startMic(deviceId);
  }, [startMic, stopMic]);

  // --- OBS / external encoder (WHIP ingress) -------------------------------
  // The ingress joins the room as its own participant (identity
  // `obs-ingress-<room>`, already excluded from viewer counts by the `obs-`
  // rule). We attach its video track to a hidden <video> and register it as a
  // normal source, so every scene — fullscreen, PiP overlay, split — works
  // with it exactly like a screen share.
  const OBS_SOURCE_ID = 'obs';
  const remoteTracks = useTracks([Track.Source.Camera, Track.Source.Microphone], { onlySubscribed: false });

  const openObsSetup = useCallback(async () => {
    setObsBusy(true);
    setObsError('');
    try {
      // Always VP8, deliberately not H.264 passthrough.
      //
      // OBS publishes H.264, which plenty of Firefox builds cannot receive at
      // all — the SFU then refuses to bind the track ("codec is not supported
      // by remote") and the source is black forever. Two attempts at
      // detecting that browser-side both failed: getCapabilities() and a
      // recvonly-offer SDP probe BOTH report H.264 support in a Firefox whose
      // real subscriber answer offers only VP8/VP9/AV1. Since there is no
      // trustworthy signal, take the codec every browser can decode.
      //
      // The cost is ingress CPU (whip_cpu_cost 1 vs 0.1 for passthrough) on
      // what is an uncommon path. It buys nothing in quality either way: the
      // studio composites this into its canvas and re-encodes before viewers
      // ever see it.
      const info = await authedPost(
        `/rooms/${encodeURIComponent(roomName)}/ingress`,
        { transcode: true },
      ) as { whipUrl: string };
      setObsInfo(info);
      setObsOpen(true);
    } catch (err) {
      setObsError(err instanceof Error ? err.message : 'Could not set up OBS ingest');
      setObsOpen(true);
    } finally {
      setObsBusy(false);
    }
  }, [authedPost, roomName]);

  useEffect(() => {
    // Match on the PUBLICATION only — deliberately NOT on `publication.track`,
    // which is undefined until we subscribe. Requiring it here meant the
    // publication was never found, so the setSubscribed() call below was
    // unreachable and the feed never arrived.
    const obsVideo = remoteTracks.find(
      (t) => t.participant.identity.startsWith('obs-ingress-')
        && t.publication?.kind === 'video',
    );

    // Gone (OBS disconnected) → drop the source so scenes fall back.
    if (!obsVideo) {
      if (sharesMapRef.current.has(OBS_SOURCE_ID)) {
        const gone = sharesMapRef.current.get(OBS_SOURCE_ID);
        gone?.audioSrc?.disconnect();
        gone?.gainNode?.disconnect();
        gone?.analyser?.disconnect();
        delete analysersRef.current[OBS_SOURCE_ID];
        try { obsVideoElRef.current?.pause(); } catch { /* ignore */ }
        sharesMapRef.current.delete(OBS_SOURCE_ID);
        setShares((prev) => prev.filter((x) => x.id !== OBS_SOURCE_ID));
        setSource((prev) => (prev === `share:${OBS_SOURCE_ID}` ? null : prev));
        setObsLive(false);
      }
      return;
    }

    // Make sure we're actually subscribed — without this the publication can
    // sit there unsubscribed and no frames ever arrive.
    const pub = obsVideo.publication!;
    if (!pub.isSubscribed && 'setSubscribed' in pub) {
      (pub as { setSubscribed(v: boolean): void }).setSubscribed(true);
      return; // re-runs once the track lands
    }
    if (!pub.track) return;
    // Belt and braces: make sure the server is actually sending this track at
    // full quality even if some adaptive logic decided otherwise.
    try {
      (pub as { setEnabled?(v: boolean): void }).setEnabled?.(true);
      (pub as { setVideoQuality?(q: number): void }).setVideoQuality?.(2 /* HIGH */);
    } catch { /* older SDKs */ }

    const track = obsVideo.publication!.track!;
    const el = obsVideoElRef.current;
    if (!el) return; // element not mounted yet — effect re-runs
    const attachTo = (video: HTMLVideoElement) => {
      video.muted = true;         // audio is mixed separately, never from here
      try { track.attach(video); } catch { /* already attached */ }
      void video.play().catch(() => { /* drawn once frames arrive */ });
    };

    // Already wired? Re-attach rather than bail. A remount (React StrictMode
    // under the dev server, or any parent re-key) throws away the <video> and
    // LiveKit detaches the track with it — but sharesMapRef is a ref, so it
    // survives and still points at the dead element. Bailing here left that
    // stale element in the compositor forever: no srcObject, no frames, and
    // LiveKit dropping the layers because nothing was attached anymore.
    const existing = sharesMapRef.current.get(OBS_SOURCE_ID);
    if (existing) {
      if (existing.video !== el || !el.srcObject) {
        existing.video = el;
        attachTo(el);
      }
      return;
    }

    attachTo(el);

    // Route OBS audio through the studio mixer rather than letting viewers hear
    // the raw ingress track: that gives it a fader AND puts it behind the
    // live/standby gate (preMaster → master), so it can't leak over the
    // "Starting soon" slate. RoomAudio drops `obs-` identities so nobody hears
    // it twice.
    const entry: ShareEntry = {
      id: OBS_SOURCE_ID,
      label: 'OBS',
      stream: new MediaStream(),
      video: el,
      hasAudio: false,
      reattach: attachTo,
    };

    const obsAudioPub = remoteTracks.find(
      (t) => t.participant.identity.startsWith('obs-ingress-')
        && t.publication?.kind === 'audio',
    )?.publication;
    if (obsAudioPub && !obsAudioPub.isSubscribed && 'setSubscribed' in obsAudioPub) {
      (obsAudioPub as { setSubscribed(v: boolean): void }).setSubscribed(true);
    }
    const obsAudioTrack = obsAudioPub?.track?.mediaStreamTrack;
    if (obsAudioTrack) {
      const ctx = ensureAudioGraph();
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1;
      gainNode.connect(preMasterRef.current!);
      entry.audioSrc = ctx.createMediaStreamSource(new MediaStream([obsAudioTrack]));
      entry.audioSrc.connect(gainNode);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gainNode.connect(analyser);
      entry.gainNode = gainNode;
      entry.analyser = analyser;
      analysersRef.current[OBS_SOURCE_ID] = analyser;
      entry.hasAudio = true;
    }

    sharesMapRef.current.set(OBS_SOURCE_ID, entry);
    setShares((prev) => [...prev, { id: OBS_SOURCE_ID, label: 'OBS', hasAudio: entry.hasAudio, gain: 1, muted: false }]);
    setSource(`share:${OBS_SOURCE_ID}`);
    setScene((prev) => (prev === 'cam' ? 'fullscreen' : prev));
    setObsLive(true);
    setObsOpen(false); // setup done — close the instructions
  }, [remoteTracks]);

  const removeShare = useCallback((id: string) => {
    const entry = sharesMapRef.current.get(id);
    if (entry) {
      entry.stream.getTracks().forEach((t) => t.stop());
      entry.audioSrc?.disconnect();
      entry.gainNode?.disconnect();
      entry.analyser?.disconnect();
      sharesMapRef.current.delete(id);
    }
    delete analysersRef.current[id];
    delete meterFillRefs.current[id];
    setShares((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const addShare = useCallback(async () => {
    if (sharesMapRef.current.size >= MAX_SHARES) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include', suppressLocalAudioPlayback: false,
      } as DisplayMediaStreamOptions);
      const id = Math.random().toString(36).slice(2, 10);
      const videoTrack = stream.getVideoTracks()[0];
      const surface = (videoTrack?.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface;
      const base = surface === 'browser' ? 'Tab' : surface === 'monitor' ? 'Screen' : surface === 'window' ? 'Window' : 'Share';
      shareCounterRef.current += 1;
      const raw = (videoTrack?.label || '').trim();
      let label: string;
      if (raw && !looksLikeId(raw)) label = raw;
      else {
        const suggested = `${base} ${shareCounterRef.current}`;
        const picked = window.prompt('Name this share (the browser can\'t read the tab title here):', suggested);
        label = (picked && picked.trim()) || suggested;
      }
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      void v.play().catch(() => { /* drawn once frames arrive */ });
      const entry: ShareEntry = { id, label, stream, video: v, hasAudio: false };
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const ctx = ensureAudioGraph();
        const gainNode = ctx.createGain();
        gainNode.gain.value = 1;
        gainNode.connect(preMasterRef.current!);
        entry.audioSrc = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        entry.audioSrc.connect(gainNode);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        gainNode.connect(analyser);
        entry.gainNode = gainNode; entry.analyser = analyser;
        analysersRef.current[id] = analyser;
        entry.hasAudio = true;
      }
      videoTrack?.addEventListener('ended', () => removeShare(id));
      sharesMapRef.current.set(id, entry);
      setShares((prev) => [...prev, { id, label, hasAudio: entry.hasAudio, gain: 1, muted: false }]);
      setSource(`share:${id}`);
      setScene((prev) => (prev === 'cam' ? 'fullscreen' : prev));
    } catch { /* cancelled */ }
  }, [ensureAudioGraph, removeShare]);

  const stopAux = useCallback(() => {
    auxStreamRef.current?.getTracks().forEach((t) => t.stop());
    auxStreamRef.current = null;
    auxSourceRef.current?.disconnect();
    auxSourceRef.current = null;
  }, []);
  const selectAuxDevice = useCallback(async (deviceId: string) => {
    stopAux();
    setAuxDeviceId(deviceId);
    if (!deviceId) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = ensureAudioGraph();
      auxStreamRef.current = stream;
      auxSourceRef.current = ctx.createMediaStreamSource(stream);
      auxSourceRef.current.connect(auxGainNodeRef.current!);
    } catch { setAuxDeviceId(''); setMediaError('Could not open that audio input.'); }
  }, [ensureAudioGraph, stopAux]);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (disposed) return;
        setAuxDevices(devices
          .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Audio input ${i + 1}` })));
      } catch { /* unavailable */ }
    };
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => { disposed = true; navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); };
  }, [micOn]);

  const addMediaFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_MEDIA_BYTES) { setMediaError(`${file.name}: too large`); continue; }
      const isVideo = file.type.startsWith('video/');
      const isImage = file.type.startsWith('image/');
      if (!isVideo && !isImage) { setMediaError(`${file.name}: unsupported type`); continue; }
      const id = Math.random().toString(36).slice(2, 10);
      const url = URL.createObjectURL(file);
      const entry: MediaEntry = { id, name: file.name, kind: 'image', url };
      if (isVideo) {
        entry.kind = 'video';
        const v = document.createElement('video');
        v.src = url; v.loop = true; v.playsInline = true; v.preload = 'auto';
        entry.video = v;
      } else {
        const img = new Image();
        img.src = url; entry.img = img;
        const animated = await decodeAnimatedImage(file);
        if (animated) { entry.kind = 'gif'; entry.gif = { ...animated, startedAt: 0 }; }
      }
      mediaMapRef.current.set(id, entry);
      setMediaItems((prev) => [...prev, { id, name: file.name, kind: entry.kind, url }]);
    }
  }, []);
  const removeMedia = useCallback((id: string) => {
    const entry = mediaMapRef.current.get(id);
    if (entry) {
      entry.video?.pause();
      entry.audioNode?.disconnect();
      entry.gif?.frames.forEach((f) => f.bmp.close());
      URL.revokeObjectURL(entry.url);
      mediaMapRef.current.delete(id);
    }
    setMediaItems((prev) => prev.filter((m) => m.id !== id));
    setSource((s) => (s === `media:${id}` ? null : s));
  }, []);

  const addSoundFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('audio/')) { setMediaError(`${file.name}: not an audio file`); continue; }
      const id = Math.random().toString(36).slice(2, 10);
      const url = URL.createObjectURL(file);
      const el = document.createElement('audio');
      el.src = url; el.loop = true; el.crossOrigin = 'anonymous';
      const ctx = ensureAudioGraph();
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1;
      gainNode.connect(preMasterRef.current!);
      gainNode.connect(ctx.destination); // local monitor
      const node = ctx.createMediaElementSource(el);
      node.connect(gainNode);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gainNode.connect(analyser);
      analysersRef.current[id] = analyser;
      // When a non-looping clip finishes, reflect stopped state in the UI.
      el.addEventListener('ended', () => {
        if (!el.loop) setSounds((prev) => prev.map((s) => (s.id === id ? { ...s, playing: false } : s)));
      });
      void el.play().catch(() => { /* gesture */ });
      soundsMapRef.current.set(id, { id, label: file.name, el, gainNode, analyser });
      setSounds((prev) => [...prev, { id, label: file.name, gain: 1, muted: false, playing: true, loop: true }]);
    }
  }, [ensureAudioGraph]);

  const toggleSoundPlay = useCallback((id: string) => {
    const e = soundsMapRef.current.get(id);
    if (!e) return;
    if (e.el.paused) { void e.el.play().catch(() => { /* gesture */ }); setSounds((prev) => prev.map((s) => (s.id === id ? { ...s, playing: true } : s))); }
    else { e.el.pause(); e.el.currentTime = 0; setSounds((prev) => prev.map((s) => (s.id === id ? { ...s, playing: false } : s))); }
  }, []);
  const toggleSoundLoop = useCallback((id: string) => {
    const e = soundsMapRef.current.get(id);
    if (!e) return;
    e.el.loop = !e.el.loop;
    setSounds((prev) => prev.map((s) => (s.id === id ? { ...s, loop: e.el.loop } : s)));
  }, []);

  // ---- recording (client-side, Pro-gated) --------------------------------
  // Records the actual composited content (the display canvas) plus the full
  // pre-gate audio mix — so it captures your show even during standby/pause,
  // WYSIWYG. Video recording is 3Speak Pro only, matching the conference
  // egress gate (enforced server-side there; here we gate on the server's
  // isPremium flag).
  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    recorderRef.current = null;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setRecording(false);
  }, []);

  /** Stop and RESOLVE once the file has been built + handed off, so the host's
   *  End-stream can finish saving the VOD before the room is torn down. */
  const stopRecordingAndWait = useCallback(() => new Promise<void>((resolve) => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') { resolve(); return; }
    recStopResolveRef.current = resolve;
    // Never hang the End-stream flow if onstop somehow never fires.
    setTimeout(() => { recStopResolveRef.current?.(); recStopResolveRef.current = null; }, 15000);
    stopRecording();
  }), [stopRecording]);

  const startRecording = useCallback(() => {
    if (!isPremium || recorderRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      setMediaError('Recording is not supported in this browser.');
      return;
    }
    ensureAudioGraph();
    const vStream = canvas.captureStream(30);
    const vTrack = vStream.getVideoTracks()[0];
    if (!vTrack) return;
    const aTrack = recordDestRef.current?.stream.getAudioTracks()[0];
    const stream = new MediaStream(aTrack ? [vTrack, aTrack] : [vTrack]);
    recStreamRef.current = stream;
    const mime = ['video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
    } catch {
      setMediaError('Recording could not start.');
      return;
    }
    recChunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size) recChunksRef.current.push(e.data); };
    rec.onstop = () => {
      const type = rec.mimeType || 'video/webm';
      const blob = new Blob(recChunksRef.current, { type });
      recChunksRef.current = [];
      recStreamRef.current?.getTracks().forEach((t) => { if (t.kind === 'video') t.stop(); });
      recStreamRef.current = null;
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const filename = `stream-${roomName}-${Math.round(recElapsedRef.current)}s.${ext}`;
      const file = { blob, filename, duration: recElapsedRef.current, size: blob.size };
      const saveLocally = () => {
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: filename });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      };

      try {
        // The two end-of-stream options are independent — a host can publish
        // the VOD, keep a local copy, or both.
        const wantsVod = autoVodRef.current && !!onStreamVod;
        const wantsDownload = autoDownloadRef.current;
        if (wantsDownload) saveLocally();
        if (wantsVod) onStreamVod!({ ...file, roomName });
        if (!wantsVod && !wantsDownload) {
          // Manual ⏺ Record: hand off to the integrator, else just download.
          if (onVideoHandoff) onVideoHandoff(file);
          else saveLocally();
        }
      } finally {
        recStopResolveRef.current?.();
        recStopResolveRef.current = null;
      }
    };
    rec.start(1000);
    recorderRef.current = rec;
    recElapsedRef.current = 0;
    setRecElapsed(0);
    setRecording(true);
    recTimerRef.current = setInterval(() => {
      recElapsedRef.current += 1;
      setRecElapsed((e) => e + 1);
    }, 1000);
  }, [isPremium, ensureAudioGraph, onVideoHandoff, onStreamVod, roomName]);
  startRecordingRef.current = startRecording;

  // Media video playback follows the active source.
  useEffect(() => {
    const activeMediaId = source?.startsWith('media:') && scene !== 'cam' ? source.slice(6) : null;
    for (const [id, m] of mediaMapRef.current) {
      if (m.video) {
        if (id === activeMediaId) {
          const ctx = ensureAudioGraph();
          if (!m.audioNode) {
            try { m.audioNode = ctx.createMediaElementSource(m.video); m.audioNode.connect(mediaGainNodeRef.current!); }
            catch { /* routed */ }
          }
          m.video.currentTime = 0;
          void m.video.play().catch(() => { /* gesture */ });
        } else if (!m.video.paused) m.video.pause();
      }
      if (m.gif && id === activeMediaId) m.gif.startedAt = performance.now();
    }
  }, [source, scene, ensureAudioGraph]);

  // Keep source + scene valid.
  useEffect(() => {
    const sourceValid = source
      ? (source.startsWith('share:') ? sharesMapRef.current.has(source.slice(6)) : mediaMapRef.current.has(source.slice(6)))
      : false;
    if (!sourceValid) {
      const nextShare = shares[shares.length - 1];
      const next: SourceKey | null = nextShare ? `share:${nextShare.id}` : mediaItems.length ? `media:${mediaItems[0].id}` : null;
      setSource(next);
      if (!next && scene !== 'cam') setScene('cam');
    }
    if ((scene === 'split' || scene === 'overlay') && !camOn) setScene(source ? 'fullscreen' : 'cam');
  }, [shares, mediaItems, source, scene, camOn]);

  useEffect(() => {
    const onDown = () => { void audioCtxRef.current?.resume().catch(() => { /* not yet */ }); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  // ---- 16:9 frame fitting ------------------------------------------------
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      const ar = portraitRef.current ? 9 / 16 : 16 / 9;
      let w = r.width, h = w / ar;
      if (h > r.height) { h = r.height; w = h * ar; }
      setFrameSize({ w, h });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [portrait]);

  // ---- draw loop ---------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const program = ensureProgramCanvas();
    const pctx = program.getContext('2d');
    if (!pctx) return;
    let raf = 0;
    const ready = (v: HTMLVideoElement | null | undefined): v is HTMLVideoElement =>
      !!v && v.readyState >= 2 && v.videoWidth > 0;
    const drawMediaInto = (id: string, x: number, y: number, w: number, h: number, now: number) => {
      const m = mediaMapRef.current.get(id);
      if (!m) { drawPlaceholder(ctx, 'Media removed', '', x, y, w, h); return; }
      if (m.kind === 'video' && ready(m.video)) drawContain(ctx, m.video, x, y, w, h);
      else if (m.kind === 'gif' && m.gif && m.gif.frames.length > 0) {
        const t = (now - m.gif.startedAt) % m.gif.total;
        const frame = m.gif.frames.find((f) => t < f.end) ?? m.gif.frames[m.gif.frames.length - 1];
        drawContain(ctx, frame.bmp, x, y, w, h);
      } else if (m.img && m.img.complete && m.img.naturalWidth > 0) drawContain(ctx, m.img, x, y, w, h);
      else drawPlaceholder(ctx, 'Loading media…', m.name, x, y, w, h);
    };
    const drawSourceInto = (src: SourceKey | null, x: number, y: number, w: number, h: number, now: number) => {
      if (!src) { drawPlaceholder(ctx, 'No source selected', 'Pick a share or media on the left', x, y, w, h); return; }
      if (src.startsWith('share:')) {
        const id = src.slice(6);
        const e = sharesMapRef.current.get(id);
        if (e && ready(e.video)) drawContain(ctx, e.video, x, y, w, h);
        else if (id === OBS_SOURCE_ID) {
          // Self-heal: an empty srcObject means the attach was lost. Re-make
          // it against the element that's live right now, at most once a
          // second, so the feed recovers without a reconnect.
          const liveEl = obsVideoElRef.current;
          if (e?.reattach && liveEl && !liveEl.srcObject) {
            const now = performance.now();
            if (now - obsHealAtRef.current > 1000) {
              obsHealAtRef.current = now;
              e.video = liveEl;
              e.reattach(liveEl);
            }
          }
          drawPlaceholder(ctx, 'OBS: waiting for video…', '', x, y, w, h);

        }
        else drawPlaceholder(ctx, 'Share ended', '', x, y, w, h);
      } else drawMediaInto(src.slice(6), x, y, w, h, now);
    };
    const drawCamPip = (p: SceneParams, cam: HTMLVideoElement) => {
      // pipRect already returns a square box for the square mask, so the
      // camera keeps its normal margin to the frame edge.
      const m = pipRect(p);
      const radius = Math.min(m.w, m.h) * (Math.min(50, Math.max(0, p.camRadius)) / 100);

      const path = () => {
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(m.x, m.y, m.w, m.h, radius);
        else ctx.rect(m.x, m.y, m.w, m.h);
      };

      ctx.save();
      path();
      ctx.clip();
      drawCoverZoom(ctx, cam, m.x, m.y, m.w, m.h, p.camZoom, p.camPanX, p.camPanY);
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      path();
      ctx.stroke();
    };
    const draw = () => {
      const now = performance.now();
      const p = paramsRef.current;
      const cam = camVideoRef.current;
      // Off the element, not the module constants — the canvas flips to
      // portrait (720×1280) on mobile and every rect below must follow.
      const CW = ctx.canvas.width;
      const CH = ctx.canvas.height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CW, CH);
      switch (p.scene) {
        case 'cam':
          if (!ready(cam) && camFreezeRef.current) {
            // Mid-swap: hold the last frame instead of flashing "Camera is off".
            drawCover(ctx, camFreezeRef.current as unknown as Drawable, 0, 0, CW, CH);
            break;
          }
          if (ready(cam)) {
            const z = softZoomRef.current;
            const { w: cw, h: ch } = dimsOf(cam);
            // Cover (fill the frame) whenever the source shares the canvas's
            // ORIENTATION — a 3:4 portrait camera in a 9:16 canvas only loses
            // 25% of its width, which is a normal crop. The blurred backdrop is
            // reserved for a genuinely opposite orientation, where covering
            // would throw away ~70% of the frame.
            const srcTall = ch > cw;
            const dstTall = CH > CW;
            // Sideways sensor frame (Chrome doesn't rotate it) → turn it
            // upright rather than cropping a portrait slice out of it. This
            // keeps the ENTIRE frame: no crop, no letterbox, no backdrop.
            // AUTO first: a frame whose orientation is opposite the canvas is
            // sideways and needs a quarter turn; one that already matches needs
            // none. 1.5.0 applied a stored turn unconditionally, so a back
            // camera that now arrives portrait got rotated anyway — sideways.
            // The stored value is only an OVERRIDE for when auto guesses wrong.
            const opposed = cw > 0 && ch > 0 && srcTall !== dstTall;
            const auto = opposed ? 1 : 0;
            camAutoTurnsRef.current = auto;
            const stored = camRotRef.current[rotKeyRef.current];
            const turns = (((stored ?? auto) % 4) + 4) % 4;
            if (turns) {
              drawRotatedCover(ctx, cam, CW, CH, turns, z);
            } else if (opposed) {
              // Upright content in a landscape frame: nothing to rotate, so
              // keep the whole frame rather than cropping into it.
              drawFitWithBackdrop(ctx, cam, 0, 0, CW, CH, z);
            }
            else if (z > 1) drawCoverZoom(ctx, cam, 0, 0, CW, CH, z, 0, 0);
            else drawCover(ctx, cam, 0, 0, CW, CH);
          }
          else drawPlaceholder(ctx, 'Camera is off', camHintRef.current, 0, 0, CW, CH);
          break;
        case 'fullscreen':
        case 'overlay':
          drawSourceInto(p.source, 0, 0, CW, CH, now);
          if (p.scene === 'overlay' && ready(cam)) drawCamPip(p, cam);
          break;
        case 'split': {
          const x = p.splitRatio * CW;
          const leftW2 = Math.max(0, x - SPLIT_BAR / 2);
          const rightX = x + SPLIT_BAR / 2;
          const rightW = Math.max(0, CW - rightX);
          drawSourceInto(p.source, 0, 0, leftW2, CH, now);
          if (ready(cam)) drawCover(ctx, cam, rightX, 0, rightW, CH);
          else drawPlaceholder(ctx, 'Camera is off', '', rightX, 0, rightW, CH);
          ctx.fillStyle = '#2c2c3a';
          ctx.fillRect(x - SPLIT_BAR / 2, 0, SPLIT_BAR, CH);
          break;
        }
      }
      // Free-tier watermark on the DISPLAY canvas — shows in the preview and
      // (during live) rides into the program via the mirror below.
      if (showWatermarkRef.current) drawWatermark(ctx, CW, CH, watermarkLogoRef.current);

      // Program output — scaled into the (resolution-capped) program canvas.
      const state = streamStateRef.current;
      const pw = program.width, ph = program.height;
      if (state === 'live') {
        pctx.drawImage(canvas, 0, 0, pw, ph);
      } else {
        drawSlate(pctx, pw, ph, titleRef.current, now, state === 'standby' ? 'soon' : 'brb');
        // Slates don't mirror the display canvas — stamp the watermark here too.
        if (showWatermarkRef.current) drawWatermark(pctx, pw, ph, watermarkLogoRef.current);
      }
    };
    // Cap compositing at ~30fps (the capture rate). rAF fires at the display
    // refresh (often 60/120Hz); drawing every tick doubles/triples the
    // main-thread cost for no gain and can starve the video encoder — which
    // shows up as laggy video while the (separate-thread) audio stays smooth.
    let lastT = 0;
    const TARGET_MS = 1000 / 30;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - lastT < TARGET_MS - 2) return;
      lastT = t;
      draw();
    };
    raf = requestAnimationFrame(loop);
    // rAF stops dead when the tab hides or the phone locks, which freezes the
    // program canvas and kills the broadcast. Keep compositing off a timer in
    // that case — timers are throttled too, but far less aggressively, so the
    // stream degrades instead of stopping.
    const safety = window.setInterval(() => {
      if (document.visibilityState === 'hidden') draw();
    }, TARGET_MS);
    return () => { cancelAnimationFrame(raf); window.clearInterval(safety); };
  }, [ensureProgramCanvas]);

  // ---- publish -----------------------------------------------------------
  // (Re)publish the program video at the selected quality: cap RESOLUTION by
  // sizing the program canvas, plus bitrate/framerate. Simulcast is on so
  // viewers get layers to pick from; dynacast (room-level) pauses layers
  // nobody watches. Resizing the canvas changes the captured track's
  // dimensions, so we recreate the capture stream and swap the published
  // track when the resolution tier changes.
  const publishVideo = useCallback(async () => {
    const lp = localParticipant;
    if (!lp) return;
    const q = STREAM_QUALITY[streamQualityRef.current];
    const prog = ensureProgramCanvas();
    // Portrait swaps the tier's dimensions, so 480p means 480×854 rather than
    // 854×480 — same pixel budget, upright.
    const qw = portraitRef.current ? q.height : q.width;
    const qh = portraitRef.current ? q.width : q.height;
    if (prog.width !== qw || prog.height !== qh) {
      prog.width = qw;
      prog.height = qh;
      // A resized canvas needs a fresh capture stream so LiveKit re-derives
      // its simulcast layers at the new resolution.
      programStreamRef.current?.getVideoTracks().forEach((t) => t.stop());
      programStreamRef.current = null;
    }
    const track = ensureProgramStream().getVideoTracks()[0];
    if (!track) return;
    const old = publishedVideoTrackRef.current;
    try {
      if (old && old !== track) await lp.unpublishTrack(old, true);
      else if (old === track) await lp.unpublishTrack(track, false);
    } catch { /* wasn't published */ }
    await lp.publishTrack(track, {
      source: Track.Source.Camera,
      name: 'studio-program',
      // Simulcast means encoding the program canvas 3× in parallel. A phone
      // SoC is already running the compositor's captureStream at 30fps, so
      // the extra layers are what tips it into dropping frames — publish a
      // single layer there and let viewers take it as-is.
      simulcast: !isMobileRef.current,
      videoEncoding: { maxBitrate: q.maxBitrate, maxFramerate: q.maxFramerate },
    });
    publishedVideoTrackRef.current = track;
  }, [localParticipant, ensureProgramCanvas, ensureProgramStream]);

  useEffect(() => {
    if (publishedRef.current) return;
    if (connectionState !== ConnectionState.Connected || !localParticipant) return;
    publishedRef.current = true;
    let cancelled = false;
    const published: MediaStreamTrack[] = [];
    (async () => {
      try {
        // publishVideo owns the program video track (it may swap it on a
        // resolution change), so it's cleaned up via publishedVideoTrackRef.
        await publishVideo();
        ensureAudioGraph();
        const audioTrack = destRef.current?.stream.getAudioTracks()[0];
        if (audioTrack) { await localParticipant.publishTrack(audioTrack, { source: Track.Source.Microphone, name: 'studio-mix' }); published.push(audioTrack); }
        if (cancelled) for (const t of published) void localParticipant.unpublishTrack(t);
      } catch (err) {
        publishedRef.current = false;
        // eslint-disable-next-line no-console
        console.error('[Hangouts] Studio publish failed:', err);
        setMediaError('Could not publish the stream — please leave and rejoin.');
      }
    })();
    return () => {
      cancelled = true;
      publishedRef.current = false;
      for (const t of published) void localParticipant.unpublishTrack(t);
      const vt = publishedVideoTrackRef.current;
      if (vt) { try { void localParticipant.unpublishTrack(vt, true); } catch { /* gone */ } publishedVideoTrackRef.current = null; }
    };
  }, [connectionState, localParticipant, ensureAudioGraph, ensureProgramStream, publishVideo]);

  // Republish when the streamer changes quality (only after initial publish).
  useEffect(() => {
    if (!publishedRef.current) return;
    void publishVideo();
  }, [streamQuality, portrait, publishVideo]);

  // Non-premium streamers are capped at Medium.
  useEffect(() => {
    if (!isPremium && streamQuality === 'high') setStreamQuality('medium');
  }, [isPremium, streamQuality]);

  // ---- teardown ----------------------------------------------------------
  useEffect(() => {
    const mediaMap = mediaMapRef.current;
    const sharesMap = sharesMapRef.current;
    const soundsMap = soundsMapRef.current;
    return () => {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      programStreamRef.current?.getTracks().forEach((t) => t.stop());
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      auxStreamRef.current?.getTracks().forEach((t) => t.stop());
      for (const s of sharesMap.values()) s.stream.getTracks().forEach((t) => t.stop());
      sharesMap.clear();
      for (const s of soundsMap.values()) { s.el.pause(); URL.revokeObjectURL(s.el.src); }
      soundsMap.clear();
      for (const m of mediaMap.values()) { m.video?.pause(); m.gif?.frames.forEach((f) => f.bmp.close()); URL.revokeObjectURL(m.url); }
      mediaMap.clear();
      void audioCtxRef.current?.close().catch(() => { /* closed */ });
      audioCtxRef.current = null;
    };
  }, []);

  // ---- preview drag (pip / split) + panel resize -------------------------
  const dragKindRef = useRef<null | 'pip-move' | 'pip-resize' | 'split'>(null);
  const panelDragRef = useRef<null | { kind: 'left' | 'chat' | 'mixer'; start: number; startVal: number }>(null);
  const relPos = useCallback((e: PointerEvent | React.PointerEvent) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { rx: 0.5, ry: 0.5 };
    return {
      rx: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      ry: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }, []);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const pd = panelDragRef.current;
      if (pd) {
        if (pd.kind === 'left') setLeftW(Math.min(340, Math.max(150, pd.startVal + (e.clientX - pd.start))));
        else if (pd.kind === 'chat') setChatW(Math.min(480, Math.max(230, pd.startVal - (e.clientX - pd.start))));
        else if (pd.kind === 'mixer') setFaderH(Math.min(240, Math.max(70, pd.startVal - (e.clientY - pd.start))));
        return;
      }
      const kind = dragKindRef.current;
      if (!kind) return;
      const { rx, ry } = relPos(e);
      if (kind === 'split') setSplitRatio(Math.min(0.85, Math.max(0.15, rx)));
      else if (kind === 'pip-move') {
        // Snap to the nearest of nine zones (thirds on each axis) so the
        // camera can sit centred on an edge, or dead centre.
        const band = (n: number) => (n < 1 / 3 ? 0 : n < 2 / 3 ? 1 : 2);
        const vPos = (['t', 'c', 'b'] as const)[band(ry)];
        const hPos = (['l', 'c', 'r'] as const)[band(rx)];
        setPipCorner(`${vPos}${hPos}` as PipCorner);
      }
      else if (kind === 'pip-resize') {
        const p = paramsRef.current;
        const hPos = (p.pipCorner || 'br')[1]; // 'l' | 'c' | 'r'
        const marginFrac = PIP_MARGIN / CANVAS_W;

        // Width implied by the pointer, measured from whichever edge the
        // camera is actually pinned to. Deriving the anchor from the placement
        // letter matters: 'cl' is LEFT-anchored, and testing only tl/bl made
        // it resize from the right instead — which felt inverted.
        let widthFrac: number;
        if (hPos === 'c') {
          widthFrac = 2 * Math.abs(rx - 0.5); // centred: grows both ways
        } else {
          const anchorX = hPos === 'l' ? marginFrac : 1 - marginFrac;
          widthFrac = Math.abs(rx - anchorX);
        }

        // pipSize describes the 16:9 box; a SQUARE mask uses that box's HEIGHT
        // as its side, so the on-screen width is 9/16 of it. Convert back or
        // the handle jumps by 16/9 the instant you grab it.
        const size = p.camShape === 'square' ? widthFrac * (16 / 9) : widthFrac;
        // Up to the full frame — the host decides how big the camera gets.
        setPipSize(Math.min(1, Math.max(0.08, size)));
      }
    };
    const onUp = () => { dragKindRef.current = null; panelDragRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, [relPos]);

  const pipStyle = useMemo(() => {
    const r = pipRect({ scene, source, pipCorner, pipSize, splitRatio, camShape, camRadius, camZoom, camPanX, camPanY });
    return { left: `${(r.x / CANVAS_W) * 100}%`, top: `${(r.y / CANVAS_H) * 100}%`, width: `${(r.w / CANVAS_W) * 100}%`, height: `${(r.h / CANVAS_H) * 100}%` };
  }, [scene, source, pipCorner, pipSize, splitRatio, camShape, camRadius, camZoom, camPanX, camPanY]);
  const resizeHandleClass = useMemo(() => {
    // Put the resize grip on the corner furthest from where the camera is
    // anchored, so dragging it grows the box away from the edge it's pinned to.
    // Centred placements get a bottom-right grip by convention.
    const opposite: Record<PipCorner, string> = {
      tl: 'br', tc: 'br', tr: 'bl',
      cl: 'br', cc: 'br', cr: 'bl',
      bl: 'tr', bc: 'tr', br: 'tl',
    };
    return `hh-studio__pip-resize hh-studio__pip-resize--${opposite[pipCorner]}`;
  }, [pipCorner]);

  const viewerCount = participants.filter((p) => !p.isLocal && !p.identity.startsWith('obs-')).length;
  const copyShareUrl = async () => {
    if (!shareUrl) return;
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* unavailable */ }
  };

  const mediaFaderActive = source?.startsWith('media:')
    ? mediaItems.find((m) => `media:${m.id}` === source)?.kind === 'video' : false;
  const hasVideoMedia = mediaItems.some((m) => m.kind === 'video');
  const shareOn = shares.length > 0;
  const shareHasAudio = shares.some((s) => s.hasAudio);
  const shareSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;

  const sceneDisabled = (id: StudioSceneId): { disabled: boolean; reason?: string } => {
    if (id === 'cam') return camOn ? { disabled: false } : { disabled: true, reason: 'Turn the camera on first' };
    if (id === 'fullscreen') return source ? { disabled: false } : { disabled: true, reason: 'Add a share or media source first' };
    if (id === 'overlay') {
      if (!source) return { disabled: true, reason: 'Add a share or media source first' };
      if (!camOn) return { disabled: true, reason: 'Turn the camera on first' };
      return { disabled: false };
    }
    if (!camOn && !source) return { disabled: true, reason: 'Needs the camera and a source' };
    if (!source) return { disabled: true, reason: 'Add a share or media source first' };
    if (!camOn) return { disabled: true, reason: 'Turn the camera on first' };
    return { disabled: false };
  };

  const showPipOverlay = scene === 'overlay' && camOn;
  const stateBadge = streamState === 'live'
    ? { cls: '', label: '● LIVE', tip: 'Live to viewers' }
    : streamState === 'paused'
      ? { cls: ' hh-studio__live--paused', label: '❚❚ PAUSED', tip: 'Viewers see "We\'ll be right back"' }
      : { cls: ' hh-studio__live--standby', label: '◌ STANDBY', tip: 'Viewers see the "Starting soon" slate' };
  const previewTag = streamState === 'standby' ? 'Preview — viewers see “Starting soon”'
    : streamState === 'paused' ? 'Paused — viewers see “We\'ll be right back”' : null;

  const addTag = (raw?: string) => {
    // Strip a leading # and anything non-slug so tags never start with '#'.
    const t = (raw ?? tagInput).trim().toLowerCase().replace(/^#+/, '').replace(/[^a-z0-9-]/g, '');
    if (t && postTags.length < MAX_TAGS && !postTags.includes(t)) setPostTags((p) => [...p, t]);
    setTagInput('');
  };
  const onThumbChange = async (file?: File) => {
    if (!file || !imageServerApiKey) return;
    setPostThumbUploading(true);
    try { setPostThumb(await uploadImage(file, imageServerApiKey)); }
    catch { setMediaError('Thumbnail upload failed'); }
    finally { setPostThumbUploading(false); }
  };

  // Open a file picker created on the spot. renderPostEditor() renders in TWO
  // places (the sidebar tab AND the ⤢ expand modal), so a single shared
  // <input ref> broke: when the modal's copy unmounted React nulled the shared
  // ref and the still-mounted sidebar button silently stopped working.
  const pickThumbnail = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => { void onThumbChange(input.files?.[0] ?? undefined); };
    input.click();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageServerApiKey]);

  const [postSaved, setPostSaved] = useState(false);
  // Persist the composed post into the room metadata so the watch page (and
  // later the discover feed) can show title/thumbnail/description/tags.
  const savePost = useCallback(async () => {
    try {
      await authedPatch(`/rooms/${encodeURIComponent(roomName)}/post`, {
        title: postTitle.trim(),
        thumbnail: postThumb,
        description: postDesc,
        tags: postTags,
      });
      setPostSaved(true);
      setTimeout(() => setPostSaved(false), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMediaError(`Could not save the stream details: ${msg}`);
    }
  }, [authedPatch, roomName, postTitle, postThumb, postDesc, postTags]);

  const renderMeter = (key: string, active: boolean) => {
    if (!active) return <div className="hh-meter hh-meter--idle" aria-hidden="true" />;
    return <div className="hh-meter" aria-hidden="true"><div className="hh-meter__fill" ref={(el) => { meterFillRefs.current[key] = el; }} /></div>;
  };
  const renderFader = (
    key: string, icon: string, label: string, active: boolean, muted: boolean, gain: number,
    onMute: () => void, onGain: (g: number) => void, valueText: string, muteTitle: string,
    labelTitle?: string, onRemove?: () => void, extra?: React.ReactNode,
  ) => (
    <div className="hh-studio__fader" key={key} style={{ '--fader-h': `${faderH}px` } as React.CSSProperties}>
      <span className="hh-studio__fader-value">{valueText}</span>
      <div className="hh-studio__fader-body">
        <input type="range" min={0} max={150} value={Math.round(gain * 100)} disabled={!active}
          onChange={(e) => onGain(Number(e.target.value) / 100)} className="hh-studio__fader-slider" aria-label={`${label} volume`} />
        {renderMeter(key, active && !muted)}
      </div>
      {extra && <div className="hh-studio__fader-extra">{extra}</div>}
      <button className={`hh-studio__fader-mute${muted || !active ? ' hh-studio__fader-mute--off' : ''}`} onClick={onMute} title={muteTitle}>{icon}</button>
      <span className="hh-studio__fader-label" title={labelTitle ?? label}>{label}</span>
      {onRemove && <button className="hh-studio__fader-remove" onClick={onRemove} title={`Remove ${label}`}>×</button>}
    </div>
  );

  const hasAnyChannel = micOn || shareHasAudio || sounds.length > 0 || hasVideoMedia || !!auxDeviceId;

  const renderPostEditor = (inModal: boolean) => (
    <div className={`hh-post${inModal ? ' hh-post--modal' : ''}`}>
      <div className="hh-post__head">
        <span className="hh-post__title-label">Stream post {postLocked && <em>(locked — live)</em>}</span>
        {/* Saves itself — no Save button. This just reports what's happening. */}
        {!postLocked && (
          <span className={`hh-post__saved${postSaved ? ' hh-post__saved--on' : ''}`}>
            {postSaved ? '✓ Saved' : 'Saves automatically'}
          </span>
        )}
        {!inModal && (
          <button className="hh-post__expand" onClick={() => setPostModalOpen(true)} title="Open in a larger editor">⤢</button>
        )}
      </div>
      <input className="hh-post__input" type="text" placeholder="Post title" value={postTitle}
        maxLength={120} disabled={postLocked} onChange={(e) => setPostTitle(e.target.value)} />

      <div className="hh-post__thumb">
        {postThumb ? (
          <div className="hh-post__thumb-preview" style={{ backgroundImage: `url(${postThumb})` }}>
            {!postLocked && <button className="hh-post__thumb-remove" onClick={() => setPostThumb('')} title="Remove thumbnail">×</button>}
          </div>
        ) : (
          <button className="hh-post__thumb-add" disabled={postLocked || postThumbUploading || !imageServerApiKey}
            onClick={pickThumbnail}
            title={imageServerApiKey ? 'Upload a thumbnail' : 'Image uploads not configured'}>
            {postThumbUploading ? 'Uploading…' : '+ Thumbnail'}
          </button>
        )}
      </div>

      <div className="hh-post__desc">
        <div className="hh-post__desc-tabs">
          <button className={!descPreview ? 'is-active' : ''} onClick={() => setDescPreview(false)} disabled={postLocked}>Write</button>
          <button className={descPreview ? 'is-active' : ''} onClick={() => setDescPreview(true)}>Preview</button>
          <span className="hh-post__desc-hint">Markdown</span>
        </div>
        {descPreview
          ? <div className="hh-post__desc-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(postDesc || '_Nothing yet._') }} />
          : <textarea className="hh-post__desc-input" placeholder="Description (markdown supported)" value={postDesc}
              disabled={postLocked} rows={inModal ? 12 : 4} onChange={(e) => setPostDesc(e.target.value)} />}
      </div>

      <div className="hh-post__tags">
        <div className="hh-post__tag-chips">
          {postTags.map((t) => (
            <span key={t} className="hh-post__tag">{t}{!postLocked && <button onClick={() => setPostTags((p) => p.filter((x) => x !== t))}>×</button>}</span>
          ))}
        </div>
        {!postLocked && postTags.length < MAX_TAGS && (
          <input className="hh-post__tag-input" type="text" placeholder={`Add tag — space to add (${postTags.length}/${MAX_TAGS})`} value={tagInput}
            onChange={(e) => {
              // Space (or comma) commits the tag; the separator itself is
              // consumed, not carried into the next tag.
              const v = e.target.value;
              if (/[\s,]/.test(v)) addTag(v);
              else setTagInput(v);
            }}
            onKeyDown={(e) => { if (e.key === ',') { e.preventDefault(); addTag(); } }}
            onBlur={() => addTag()} />
        )}
      </div>

      {/* Integrator-owned extras (e.g. 3Speak community / payout /
          beneficiaries for the Hive announcement) — still editable here in
          the studio, right up until the host hits Start. */}
      {renderPostExtras && <div className="hh-post__extras">{renderPostExtras}</div>}

      {/* Pro: publish the recording as this session's video when the stream
          ends, so the same link plays the VOD afterwards instead of a dead
          stream. Locked (and explained) for non-Pro hosts. */}
      {onStreamVod && canPublishVod && (
        <label className={`hh-post__vod${isPremium ? '' : ' hh-post__vod--locked'}`}>
          <input
            type="checkbox"
            checked={autoVod && isPremium}
            disabled={!isPremium || streamState !== 'standby'}
            onChange={(e) => setAutoVod(e.target.checked)}
          />
          <span>
            🎬 Replace the stream with a video when it ends
            {!isPremium && ' 🔒'}
            <em className="hh-post__vod-hint">
              {!isPremium
                ? 'Only available with 3Speak Pro — records the broadcast and adds it as VOD to the announcement post.'
                : streamState !== 'standby'
                  ? 'Locked while the stream is running.'
                  : 'Records the whole broadcast and adds it as the VOD on your announcement post.'}
            </em>
          </span>
        </label>
      )}

      {/* Keep a local copy too — independent of publishing the VOD. */}
      <label className={`hh-post__vod${isPremium ? '' : ' hh-post__vod--locked'}`}>
        <input
          type="checkbox"
          checked={autoDownload && isPremium}
          disabled={!isPremium || streamState !== 'standby'}
          onChange={(e) => setAutoDownload(e.target.checked)}
        />
        <span>
          💾 Record the session and download it when it ends
          {!isPremium && ' 🔒'}
          <em className="hh-post__vod-hint">
            {!isPremium
              ? 'Only available with 3Speak Pro — records the broadcast to a file on your computer.'
              : streamState !== 'standby'
                ? 'Locked while the stream is running.'
                : 'Saves a copy to your computer when you end the stream.'}
          </em>
        </span>
      </label>

    </div>
  );

  // Mobile is a camera-only studio: no scene compositor, no screen share, no
  // OBS ingest. Pin the scene so a layout picked on desktop can't leave a
  // phone rendering a source it has no way to select.
  useEffect(() => {
    camHintRef.current = isMobile ? 'Tap to start the camera' : 'Add it via ＋ Add source';
    if (!isMobile) return;
    setScene('cam');
    setSource(null);
    setPortrait(true);
    portraitRef.current = true;
  }, [isMobile]);

  // Camera and mic are MANDATORY on mobile — there are no toggles for them, so
  // the studio acquires both on open. One automatic attempt: if permission is
  // refused we show a prompt rather than re-firing getUserMedia on every
  // render, which would spam the browser dialog.
  const autoCamTriedRef = useRef(false);
  const requestingRef = useRef(false);
  const requestDevices = useCallback(async () => {
    // Re-entrancy guard: a failed acquisition sets mediaError, which renders
    // the prompt, whose button calls back in here. Without this a camera that
    // can't open (e.g. busy) puts the prompt in a self-retriggering loop.
    if (requestingRef.current) return;
    requestingRef.current = true;
    setMediaError('');
    try {
      await startCam();
      if (!micStreamRef.current) await startMic();
    } finally {
      requestingRef.current = false;
    }
  }, [startCam, startMic]);
  useEffect(() => {
    if (!isMobile || autoCamTriedRef.current) return;
    autoCamTriedRef.current = true;
    void requestDevices();
  }, [isMobile, requestDevices]);

  // Flipping the aspect changes the SHAPE we want from the sensor, so the
  // track has to be reopened — otherwise a landscape frame keeps getting
  // cropped into the portrait canvas and looks zoomed in.
  const lastPortraitRef = useRef(portrait);
  useEffect(() => {
    if (lastPortraitRef.current === portrait) return;
    lastPortraitRef.current = portrait;
    if (!isMobile || !camStreamRef.current) return;
    stopCam();
    void startCam();
  }, [portrait, isMobile, startCam, stopCam]);

  // Browsers only grant fullscreen from a user gesture, so this is wired to the
  // rail/transport taps rather than fired on mount. It's what actually gets rid
  // of the mobile address bar — there's no API to hide it directly, and a tall
  // page just becomes scrollable instead.
  // Screen Wake Lock: the real fix for "locking the phone stops the stream".
  // Re-requested on visibility change because the lock is dropped whenever the
  // page is hidden, and would otherwise not come back.
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  useEffect(() => {
    if (!isMobile) return;
    let cancelled = false;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    const acquire = async () => {
      if (cancelled || !nav.wakeLock || document.visibilityState !== 'visible') return;
      try { wakeLockRef.current = await nav.wakeLock.request('screen'); }
      catch { /* denied or unsupported — the timer fallback still applies */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void wakeLockRef.current?.release().catch(() => { /* already gone */ });
      wakeLockRef.current = null;
    };
  }, [isMobile]);

  const orientationLockedRef = useRef(false);
  const goFullscreen = useCallback(async () => {
    if (!isMobileRef.current) return;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    if (!document.fullscreenElement) {
      try {
        await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
      } catch { /* iOS Safari refuses; the dvh layout still works */ }
    }
    // Once only. This used to run on every Flip, and its stop/re-acquire raced
    // with switchCamera's own stop/start — leaving the camera on the side you
    // just left, so a second Flip appeared to do nothing.
    if (orientationLockedRef.current) return;
    orientationLockedRef.current = true;
    try {
      const o = screen.orientation as ScreenOrientation & { lock?: (t: string) => Promise<void> };
      await o?.lock?.('portrait');
      // The already-open track keeps the OLD orientation, so re-acquire it.
      if (camStreamRef.current) {
        stopCam();
        await new Promise((r) => setTimeout(r, 150));
        await startCamRef.current?.();
      }
    } catch { /* lock unsupported or refused — nothing lost */ }
  }, [stopCam]);

  const endStream = useCallback(async () => {
    const willSave = (autoVodRef.current || autoDownloadRef.current) && !!recorderRef.current;
    const msg = willSave
      ? 'End the stream? All viewers will be disconnected, and the recording will be published as this session\'s video.'
      : 'End the stream? All viewers will be disconnected.';
    if (!window.confirm(msg)) return;
    if (willSave) {
      // Finish writing + hand off the file BEFORE the room is torn down,
      // otherwise the recording is lost.
      setSavingVod(true);
      try { await stopRecordingAndWait(); } finally { setSavingVod(false); }
    }
    onEndRoom();
  }, [stopRecordingAndWait, onEndRoom]);

  // Shared by both layouts — the desktop rail/mixer shell and the mobile
  // cam-only shell render the identical preview surface.
  const previewFrameEl = (
  <div className="hh-studio__preview" ref={previewRef}>
    <div className="hh-studio__frame" ref={frameRef} style={frameSize ? { width: `${frameSize.w}px`, height: `${frameSize.h}px` } : undefined}>
      {/* With no camera the canvas draws a "Camera is off — add it via
          ＋ Add source" placeholder; make that whole surface a shortcut
          straight to the Add-source picker. */}
      <canvas
        ref={canvasRef}
        width={canvasW}
        height={canvasH}
        className={`hh-studio__canvas${isMobile ? (portrait ? ' hh-studio__canvas--cover' : ' hh-studio__canvas--contain') : ''}`}
        onClick={!camOn ? () => (isMobile ? void startCam() : setAddMenuOpen(true)) : undefined}
        style={!camOn ? { cursor: 'pointer' } : undefined}
        title={!camOn ? (isMobile ? 'Start camera' : 'Add a source') : undefined}
      />
      {/* The OBS ingest feed. Rendered by React (never createElement +
          appendChild) because Firefox only decodes a <video> that is
          actually in the document — audio worked without it, video
          didn't. Invisible via opacity; the canvas is what's shown. */}
      <video
        ref={obsVideoElRef}
        className="hh-studio__obs-host"
        muted
        playsInline
        autoPlay
        aria-hidden="true"
      />
      {previewTag && <span className="hh-studio__preview-tag">{previewTag}</span>}
      {showPipOverlay && (
        <div className="hh-studio__pip-overlay" style={pipStyle}
          onPointerDown={(e) => { e.preventDefault(); dragKindRef.current = 'pip-move'; }} title="Drag to a corner">
          <span className={resizeHandleClass}
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); dragKindRef.current = 'pip-resize'; }} title="Drag to resize" />
        </div>
      )}
      {scene === 'split' && (
        <div className="hh-studio__split-handle" style={{ left: `${splitRatio * 100}%` }}
          onPointerDown={(e) => { e.preventDefault(); dragKindRef.current = 'split'; }} title="Drag to resize the split"><span /></div>
      )}
      <BoostOverlay />
    </div>
  </div>
  );

  return (
    <div className="hh-studio">
      <header className="hh-studio__header">
        <span className={`hh-studio__live${stateBadge.cls}`} title={stateBadge.tip}>{stateBadge.label}</span>
        <h2 className="hh-studio__title">{title}</h2>
        {/* Always visible, never dismissible: browsers throttle timers and
            rAF in hidden/minimised tabs, which stalls the canvas compositor
            (~2fps) and starves the encoder. The host has to know. */}
        <span className="hh-studio__warn" role="alert">
          <span className="hh-studio__warn-icon" aria-hidden="true">⚠️</span>
          <span className="hh-studio__warn-text">
            {isMobile
              ? 'Keep this screen on and stay in the app — locking the phone or switching apps stops your stream.'
              : 'Keep this window visible at all times — a hidden or minimised tab gets throttled by the browser, which lowers quality and skips frames.'}
          </span>
        </span>
        <div className="hh-studio__header-actions">
          <span className="hh-studio__viewers" title="Viewers watching">👁 {viewerCount}</span>
          <label className="hh-studio__quality" title={isPremium ? 'Broadcast quality' : 'Broadcast quality — High needs 3Speak Pro'}>
            <span aria-hidden="true">📶</span>
            <select value={streamQuality} onChange={(e) => setStreamQuality(e.target.value as StreamQuality)} aria-label="Broadcast quality">
              <option value="low">Low · 360p</option>
              <option value="medium">Medium · 480p</option>
              <option value="high" disabled={!isPremium}>High · 720p{isPremium ? '' : ' 🔒'}</option>
            </select>
          </label>
          {!isMobile && shareUrl && <button className="hh-btn hh-btn--secondary hh-btn--small" onClick={copyShareUrl}>{copied ? '✓ Copied' : '🔗 Share'}</button>}
          {!isMobile && <button className={`hh-btn hh-btn--small ${boostHistoryOpen ? 'hh-btn--primary' : 'hh-btn--secondary'}`} onClick={() => setBoostHistoryOpen((v) => !v)} title="Boost history">💰</button>}
          {onClose && (
            <button
              className="hh-studio__close"
              aria-label="Close the stream studio"
              title="Close the stream studio"
              onClick={() => {
                const msg = streamState === 'standby'
                  ? 'Close the stream studio? Your setup will be lost — the session stays open and you can come back to it.'
                  : 'Close the stream studio? You are LIVE — closing stops your broadcast for viewers.';
                if (window.confirm(msg)) onClose();
              }}
            >
              ✕
            </button>
          )}
        </div>
      </header>

      {isMobile ? (
        <div className={`hh-studio__body hh-studio__body--mobile${mobileSheet ? ' hh-studio__body--sheet' : ''}`}>
          {previewFrameEl}

          {mediaError && (
            <div className="hh-studio__permask" role="dialog" aria-label="Permissions needed">
              <div className="hh-studio__permask-card">
                <h3>Camera &amp; microphone needed</h3>
                <p>
                  Streaming from a phone needs both. {mediaError}
                </p>
                <p className="hh-studio__permask-hint">
                  If you dismissed the prompt, allow access for this site in your
                  browser&rsquo;s address-bar permissions, then try again.
                </p>
                <button className="hh-btn hh-btn--primary" onClick={() => { void goFullscreen(); void requestDevices(); }}>
                  Allow access
                </button>
              </div>
            </div>
          )}

          {/* Camera controls on the LEFT, session controls on the RIGHT, so
              the thumb framing the shot isn't the one that can end the
              broadcast. */}
          <div className="hh-studio__rail hh-studio__rail--left">
            <button
              className="hh-studio__rbtn"
              onClick={() => applyZoom(camZoomRef.current + 0.5)}
              disabled={!camOn || camZoomLevel >= 4}
              title="Zoom in"
            >
              <IconZoomIn />
              <span className="hh-studio__rbtn-label">{camZoomLevel.toFixed(1)}×</span>
            </button>
            <button
              className="hh-studio__rbtn"
              onClick={() => applyZoom(camZoomRef.current - 0.5)}
              disabled={!camOn || camZoomLevel <= 1}
              title="Zoom out"
            >
              <IconZoomOut />
              <span className="hh-studio__rbtn-label">Out</span>
            </button>
            <button
              className="hh-studio__rbtn"
              onClick={() => { void goFullscreen(); void switchCamera(); }}
              disabled={!camOn}
              title={camFacing === 'user' ? 'Switch to the back camera' : 'Switch to the front camera'}
            >
              <IconFlipCamera />
              <span className="hh-studio__rbtn-label">Flip</span>
            </button>
            <button
              className={`hh-studio__rbtn${mobileSheet === 'lens' ? ' hh-studio__rbtn--on' : ''}`}
              onClick={() => {
                void refreshAudioInputs();
                setMobileSheet((v) => (v === 'lens' ? null : 'lens'));
              }}
              title="Choose which camera lens to use"
            >
              <IconLens />
              <span className="hh-studio__rbtn-label">Lens</span>
            </button>
          </div>

          <div className="hh-studio__rail hh-studio__rail--right">
            <button
              className={`hh-studio__rbtn${mobileSheet === 'mic' ? ' hh-studio__rbtn--on' : ''}`}
              onClick={() => {
                void refreshAudioInputs();
                setMobileSheet((v) => (v === 'mic' ? null : 'mic'));
              }}
              title="Choose which microphone to use"
            >
              <IconAudio />
              <span className="hh-studio__rbtn-label">Audio</span>
            </button>
            <button
              className={`hh-studio__rbtn${mobileSheet === 'chat' ? ' hh-studio__rbtn--on' : ''}`}
              onClick={() => setMobileSheet((v) => (v === 'chat' ? null : 'chat'))}
              title="Chat"
            >
              <IconChat />
              {chatUnread > 0 && (
                <span className="hh-studio__rbtn-badge" aria-label={`${chatUnread} unread messages`}>
                  {chatUnread > 9 ? '9+' : chatUnread}
                </span>
              )}
              <span className="hh-studio__rbtn-label">Chat</span>
            </button>
            {/* Unlisted streams are never announced — no post to write. */}
            {!isUnlisted && (
              <button
                className={`hh-studio__rbtn${mobileSheet === 'post' ? ' hh-studio__rbtn--on' : ''}`}
                onClick={() => setMobileSheet((v) => (v === 'post' ? null : 'post'))}
                title={postLocked ? 'Stream post (locked once live)' : 'Stream post'}
              >
                <IconPost />
                {streamState === 'standby' && <span className="hh-studio__rbtn-dot" aria-hidden="true" />}
                <span className="hh-studio__rbtn-label">Post</span>
              </button>
            )}
            {shareUrl && (
              <button
                className={`hh-studio__rbtn${mobileSheet === 'share' ? ' hh-studio__rbtn--on' : ''}`}
                onClick={() => setMobileSheet((v) => (v === 'share' ? null : 'share'))}
                title="Share this stream"
              >
                <IconShare />
                <span className="hh-studio__rbtn-label">Share</span>
              </button>
            )}
            {streamState === 'standby' && (
              <button
                className="hh-studio__rbtn hh-studio__rbtn--go"
                onClick={() => { void goFullscreen(); void savePost(); setStreamState('live'); }}
                title="Cut the program and audio over to your viewers"
              >
                <IconPlay className="hh-studio__rbtn-go-icon" />
                <span className="hh-studio__rbtn-label">Start</span>
              </button>
            )}
            {streamState === 'live' && (
              <button className="hh-studio__rbtn hh-studio__rbtn--live" onClick={() => setStreamState('paused')} title="Pause the stream">
                <IconPause className="hh-studio__rbtn-live-icon" />
                <span className="hh-studio__rbtn-label">Pause</span>
              </button>
            )}
            {streamState === 'paused' && (
              <button className="hh-studio__rbtn hh-studio__rbtn--go" onClick={() => setStreamState('live')} title="Back to the program">
                <IconPlay className="hh-studio__rbtn-go-icon" />
                <span className="hh-studio__rbtn-label">Resume</span>
              </button>
            )}
            {streamState !== 'standby' && (
              <button className="hh-studio__rbtn hh-studio__rbtn--end" disabled={savingVod} onClick={() => void endStream()} title="End the stream">
                <IconStop className="hh-studio__rbtn-stop-icon" />
                <span className="hh-studio__rbtn-label">{savingVod ? 'Saving' : 'End'}</span>
              </button>
            )}
          </div>


          {mobileSheet && (
            <MobileSheet
              title={mobileSheet === 'chat' ? 'Chat'
                : mobileSheet === 'post' ? 'Stream post'
                : mobileSheet === 'lens' ? 'Camera'
                : mobileSheet === 'share' ? 'Share this stream' : 'Microphone'}
              onClose={() => setMobileSheet(null)}
              height={sheetH[mobileSheet]}
              onHeightChange={(h) => setSheetH((prev) => ({ ...prev, [mobileSheet]: h }))}
              /* Chat stays translucent so the host can watch the preview through it. */
              transparent={mobileSheet === 'chat'}
            >
              {mobileSheet === 'chat' && <ChatPanel readOnly readOnlyNotice="" />}
              {mobileSheet === 'post' && renderPostEditor(false)}
              {mobileSheet === 'share' && (
                <div className="hh-studio__share-sheet">
                  <p className="hh-studio__share-hint">Anyone with this link can watch:</p>
                  {/* Shown as text, not a copy-code field: the host is mid-stream
                      and shouldn't be nudged into leaving the tab to paste it. */}
                  <p className="hh-studio__share-url">
                    {(() => {
                      const url = shareUrl ?? '';
                      const cut = url.lastIndexOf('/');
                      if (cut < 0) return url;
                      return (
                        <>
                          {url.slice(0, cut + 1)}
                          <strong>{url.slice(cut + 1)}</strong>
                        </>
                      );
                    })()}
                  </p>
                  <p className="hh-studio__share-warn">
                    ⚠️ Share it <strong>after</strong> your stream, or from another device.
                    Switching apps puts this tab in the background, which can stall or end
                    your broadcast.
                  </p>
                </div>
              )}
              {mobileSheet === 'lens' && (
                <div className="hh-studio__devices">
                  <button
                    className={`hh-studio__device${!camDeviceId ? ' hh-studio__device--on' : ''}`}
                    onClick={() => void selectCamera('')}
                  >
                    Automatic ({camFacing === 'user' ? 'front' : 'back'})
                  </button>
                  {videoInputs
                    .filter((d) => !d.label || lensMatchesFacing(d.label, camFacing))
                    .map((d, i) => (
                    <button
                      key={d.deviceId}
                      className={`hh-studio__device${camDeviceId === d.deviceId ? ' hh-studio__device--on' : ''}`}
                      onClick={() => void selectCamera(d.deviceId)}
                    >
                      {d.label || `Camera ${i + 1}`}
                      {lensWidthRank(d.label || '') === 0 && (
                        <span className="hh-studio__device-tag">widest</span>
                      )}
                    </button>
                  ))}
                  {videoInputs.filter((d) => !d.label || lensMatchesFacing(d.label, camFacing)).length === 0 && (
                    <p className="hh-studio__device-hint">
                      No cameras listed yet — grant camera access so the browser will name them.
                    </p>
                  )}
                  <button className="hh-studio__device" onClick={rotateCamera}>
                    Rotate this camera
                    <span className="hh-studio__device-tag">{effTurns * 90}°</span>
                  </button>
                  {camRot[rotKeyRef.current] !== undefined && (
                    <button className="hh-studio__device" onClick={resetCameraRotation}>
                      Reset rotation to automatic
                    </button>
                  )}
                  {lensError && <p className="hh-studio__device-error">{lensError}</p>}
                  <p className="hh-studio__device-hint">{camDiag}</p>
                  <p className="hh-studio__device-hint">
                    Wide and telephoto lenses are separate cameras on most phones. Zoom stays
                    within one lens, so pick the lens here.
                  </p>
                </div>
              )}
              {mobileSheet === 'mic' && (
                <div className="hh-studio__mic-sheet">
                  <div className="hh-studio__devices hh-studio__devices--compact">
                    <button
                      className={`hh-studio__device${!micDeviceId ? ' hh-studio__device--on' : ''}`}
                      onClick={() => void selectMic('')}
                    >
                      System default
                    </button>
                    {audioInputs
                      .filter((d) => !HIDDEN_AUDIO_INPUT.test(d.label))
                      .map((d, i) => (
                        <button
                          key={d.deviceId}
                          className={`hh-studio__device${micDeviceId === d.deviceId ? ' hh-studio__device--on' : ''}`}
                          onClick={() => void selectMic(d.deviceId)}
                        >
                          {micLabel(d.label, i)}
                        </button>
                      ))}
                    {audioInputs.filter((d) => !HIDDEN_AUDIO_INPUT.test(d.label)).length === 0 && (
                      <p className="hh-studio__device-hint">
                        No microphones listed yet — turn the mic on once so the browser will name them.
                      </p>
                    )}
                  </div>
                  {/* The desktop mixer's own fader: level meter, gain slider and
                      mute, so mobile shows the same thing rather than a
                      lookalike that could drift from it. */}
                  <div className="hh-studio__mic-fader">
                    {renderFader('mic', '🎤', 'Mic', micOn, micMuted, micGain,
                      () => setMicMuted((v) => !v), (g) => setMicGain(g),
                      micMuted ? 'mute' : `${Math.round(micGain * 100)}`,
                      micMuted ? 'Unmute mic' : 'Mute mic')}
                  </div>
                </div>
              )}
            </MobileSheet>
          )}
        </div>
      ) : (
      <div className="hh-studio__body">
        {/* Left rail */}
        {leftCollapsed ? (
          <button className="hh-studio__reopen" onClick={() => setLeftCollapsed(false)} title="Show scenes & sources">🎬 ▸</button>
        ) : (
          <aside className="hh-studio__scenes" style={{ width: leftW }}>
            <div className="hh-studio__panel-head">
              <span>Scenes</span>
              <button className="hh-studio__collapse" onClick={() => setLeftCollapsed(true)} title="Collapse">‹</button>
            </div>
            {SCENES.map((s) => {
              const gate = sceneDisabled(s.id);
              return (
                <button key={s.id} className={`hh-studio__scene${scene === s.id ? ' hh-studio__scene--active' : ''}`}
                  onClick={() => setScene(s.id)} disabled={gate.disabled} title={gate.reason ?? s.hint}>
                  <span className={`hh-studio__scene-icon hh-studio__scene-icon--${s.id}`} aria-hidden="true"><i /><i /></span>
                  {s.label}
                </button>
              );
            })}

            <div className="hh-studio__rail-label hh-studio__rail-label--media">Sources</div>
            {shares.map((s) => (
              <button key={s.id} className={`hh-studio__scene hh-studio__scene--media${source === `share:${s.id}` ? ' hh-studio__scene--active' : ''}`}
                onClick={() => { setSource(`share:${s.id}`); setScene((p) => (p === 'cam' ? 'fullscreen' : p)); }} title={`${s.label} — click to make it the active source`}>
                <span className="hh-studio__scene-icon hh-studio__scene-icon--screen" aria-hidden="true"><i /><i /></span>
                <span className="hh-studio__media-name">{s.label}{s.hasAudio ? ' 🔊' : ''}</span>
                <span className="hh-studio__media-icon" role="button" aria-label={`Rename ${s.label}`} title="Rename" onClick={(e) => { e.stopPropagation(); renameShare(s.id); }}>✎</span>
                <span className="hh-studio__media-remove" role="button" aria-label={`Stop ${s.label}`} title="Stop this share" onClick={(e) => { e.stopPropagation(); removeShare(s.id); }}>×</span>
              </button>
            ))}
            {mediaItems.map((m) => (
              <button key={m.id} className={`hh-studio__scene hh-studio__scene--media${source === `media:${m.id}` ? ' hh-studio__scene--active' : ''}`}
                onClick={() => { setSource(`media:${m.id}`); setScene((p) => (p === 'cam' ? 'fullscreen' : p)); }} title={m.name}>
                {m.kind === 'video' ? <video className="hh-studio__media-thumb" src={m.url} muted preload="metadata" /> : <img className="hh-studio__media-thumb" src={m.url} alt="" />}
                <span className="hh-studio__media-name">{m.name}</span>
                <span className="hh-studio__media-remove" role="button" aria-label={`Remove ${m.name}`} title="Remove" onClick={(e) => { e.stopPropagation(); removeMedia(m.id); }}>×</span>
              </button>
            ))}

            {/* Camera look — only useful once there's a camera, and only the
                PiP scenes actually show the mask. Everything here persists. */}
            {camOn && (
              <div className="hh-studio__cam-look">
                <button
                  type="button"
                  className="hh-studio__cam-toggle"
                  onClick={() => setCamLookOpen((v) => !v)}
                  aria-expanded={camLookOpen}
                  title={camLookOpen ? 'Hide camera settings' : 'Show camera settings'}
                >
                  <span>Camera mask</span>
                  <span className="hh-studio__cam-caret" aria-hidden="true">{camLookOpen ? '▾' : '▸'}</span>
                </button>
                {camLookOpen && (<>
                <div className="hh-studio__cam-shapes">
                  {([
                    ['rect', '▭', 'Rectangle'],
                    ['square', '◻', 'Square — set corners to 50% for a circle'],
                  ] as const).map(([id, icon, label]) => (
                    <button
                      key={id}
                      className={`hh-studio__cam-shape${camShape === id ? ' is-active' : ''}`}
                      onClick={() => setCamShape(id)}
                      title={label}
                    >
                      <span aria-hidden="true">{icon}</span>
                    </button>
                  ))}
                </div>
                <label className="hh-studio__cam-slider">
                  <span>Corners {Math.round(camRadius)}%{camShape === 'square' && camRadius >= 50 ? ' (circle)' : ''}</span>
                  <input type="range" min={0} max={50} step={1} value={camRadius}
                    onChange={(e) => setCamRadius(Number(e.target.value))} />
                </label>
                <label className="hh-studio__cam-slider">
                  <span>Size {Math.round(pipSize * 100)}%</span>
                  <input type="range" min={0.08} max={1} step={0.01} value={pipSize}
                    onChange={(e) => setPipSize(Number(e.target.value))} />
                </label>
                <label className="hh-studio__cam-slider">
                  <span>Zoom {camZoom.toFixed(1)}×</span>
                  <input type="range" min={1} max={3} step={0.1} value={camZoom}
                    onChange={(e) => setCamZoom(Number(e.target.value))} />
                </label>
                <label className="hh-studio__cam-slider">
                  <span>Move ↔ {Math.round(camPanX * 100)}</span>
                  <input type="range" min={-1} max={1} step={0.02} value={camPanX}
                    onChange={(e) => setCamPanX(Number(e.target.value))} />
                </label>
                <label className="hh-studio__cam-slider">
                  <span>Move ↕ {Math.round(camPanY * 100)}</span>
                  <input type="range" min={-1} max={1} step={0.02} value={camPanY}
                    onChange={(e) => setCamPanY(Number(e.target.value))} />
                </label>
                <p className="hh-studio__cam-hint">Drag the camera in the preview to reposition it (nine spots, incl. centred) or drag its corner to resize. Move ↔/↕ shifts the image <em>inside</em> the mask.</p>
                </>)}
              </div>
            )}

            <button className="hh-studio__scene hh-studio__scene--add" onClick={() => setAddMenuOpen(true)} title="Add a camera, share, media, or audio source">
              ＋ Add source
            </button>
            <input ref={mediaInputRef} type="file" accept="image/*,video/*" multiple style={{ display: 'none' }}
              onChange={(e) => { void addMediaFiles(e.target.files); e.target.value = ''; }} />
            <input ref={soundInputRef} type="file" accept="audio/*" multiple style={{ display: 'none' }}
              onChange={(e) => { addSoundFiles(e.target.files); e.target.value = ''; }} />
            {mediaError && <span className="hh-studio__error">{mediaError}</span>}
          </aside>
        )}

        {!leftCollapsed && (
          <div className="hh-studio__resizer" onPointerDown={(e) => { e.preventDefault(); panelDragRef.current = { kind: 'left', start: e.clientX, startVal: leftW }; }} title="Drag to resize" />
        )}

        {/* Center */}
        <div className="hh-studio__center">
          {previewFrameEl}

          {/* Mixer */}
          <div className={`hh-studio__mixer${mixerCollapsed ? ' hh-studio__mixer--collapsed' : ''}`}>
            {!mixerCollapsed && (
              <div className="hh-studio__mixer-resizer"
                onPointerDown={(e) => { e.preventDefault(); panelDragRef.current = { kind: 'mixer', start: e.clientY, startVal: faderH }; }} title="Drag to resize" />
            )}
            <div className="hh-studio__panel-head">
              <span>Audio mixer</span>
              <button className="hh-studio__collapse" onClick={() => setMixerCollapsed((v) => !v)} title={mixerCollapsed ? 'Expand' : 'Collapse'}>{mixerCollapsed ? '▴' : '▾'}</button>
            </div>
            {!mixerCollapsed && (
              <>
                <div className="hh-studio__mixer-strip">
                  {micOn && renderFader('mic', '🎤', 'Mic', true, micMuted, micGain,
                    () => setMicMuted((v) => !v), (g) => setMicGain(g), micMuted ? 'mute' : `${Math.round(micGain * 100)}`,
                    micMuted ? 'Unmute mic' : 'Mute mic')}
                  {shares.filter((s) => s.hasAudio).map((s) => renderFader(s.id, '🔊', s.label, true, s.muted, s.gain,
                    () => toggleShareMute(s.id), (g) => setShareGain(s.id, g), s.muted ? 'mute' : `${Math.round(s.gain * 100)}`,
                    s.muted ? 'Unmute this share' : 'Mute this share', s.label))}
                  {sounds.map((s) => renderFader(s.id, '🎵', s.label, true, s.muted, s.gain,
                    () => toggleSoundMute(s.id), (g) => setSoundGain(s.id, g), s.muted ? 'mute' : `${Math.round(s.gain * 100)}`,
                    s.muted ? 'Unmute' : 'Mute', s.label, () => removeSound(s.id),
                    <>
                      <button className={`hh-studio__clip-btn${s.playing ? ' hh-studio__clip-btn--on' : ''}`}
                        onClick={() => toggleSoundPlay(s.id)} title={s.playing ? 'Stop' : 'Play'}>{s.playing ? '⏹' : '▶'}</button>
                      <button className={`hh-studio__clip-btn${s.loop ? ' hh-studio__clip-btn--on' : ''}`}
                        onClick={() => toggleSoundLoop(s.id)} title={s.loop ? 'Loop on' : 'Loop off'}>🔁</button>
                    </>))}
                  {hasVideoMedia && renderFader('media', '🎬', 'Media', mediaFaderActive, mediaMuted || !mediaFaderActive, mediaGain,
                    () => setMediaMuted((v) => !v), (g) => setMediaGain(g),
                    !mediaFaderActive ? '—' : mediaMuted ? 'mute' : `${Math.round(mediaGain * 100)}`,
                    mediaFaderActive ? (mediaMuted ? 'Unmute media' : 'Mute media') : 'Active when the video source plays')}
                  {auxDeviceId && renderFader('aux', '🎚️', 'Aux', true, auxMuted, auxGain,
                    () => setAuxMuted((v) => !v), (g) => setAuxGain(g), auxMuted ? 'mute' : `${Math.round(auxGain * 100)}`,
                    auxMuted ? 'Unmute aux' : 'Mute aux', 'Aux / desktop audio', () => void selectAuxDevice(''))}
                  {!hasAnyChannel && <div className="hh-studio__mixer-empty">No audio yet — add a mic, share, or sound via ＋ Add source.</div>}
                </div>
                {shareOn && !shareHasAudio && (
                  <p className="hh-studio__mixer-hint">Shares only carry audio from a <strong>browser tab</strong> shared with <strong>“share tab audio”</strong> ticked.</p>
                )}
              </>
            )}
          </div>
        </div>

        {!chatCollapsed && (
          <div className="hh-studio__resizer" onPointerDown={(e) => { e.preventDefault(); panelDragRef.current = { kind: 'chat', start: e.clientX, startVal: chatW }; }} title="Drag to resize" />
        )}

        {/* Right rail */}
        {chatCollapsed ? (
          <button className="hh-studio__reopen" onClick={() => setChatCollapsed(false)} title="Show chat & post">◂ 💬</button>
        ) : (
          <aside className="hh-studio__chat" style={{ width: chatW }}>
            <div className="hh-studio__tabs">
              <button className={`hh-studio__tab${rightTab === 'chat' ? ' hh-studio__tab--active' : ''}`} onClick={() => setRightTab('chat')}>💬 Chat</button>
              <button className={`hh-studio__tab${rightTab === 'post' ? ' hh-studio__tab--active' : ''}`} onClick={() => setRightTab('post')}>
                📝 Post{postLocked ? ' 🔒' : ''}
                {/* Unsent: the announcement goes out when the host hits Start,
                    so flag the tab until then — it's the last chance to check
                    the title, community and payout. Mirrors the mobile rail. */}
                {streamState === 'standby' && <span className="hh-studio__rbtn-dot" aria-hidden="true" />}
              </button>
              <button className="hh-studio__collapse hh-studio__tabs-collapse" onClick={() => setChatCollapsed(true)} title="Collapse">›</button>
            </div>
            <div className="hh-studio__tab-body">
              {rightTab === 'chat' ? <ChatPanel /> : renderPostEditor(false)}
            </div>
            <div className="hh-studio__transport">
              {streamState === 'standby' && <button className="hh-studio__go-btn" onClick={() => { void savePost(); setStreamState('live'); }} title="Cut the program and audio over to your viewers">🔴 START STREAM</button>}
              {streamState === 'live' && <button className="hh-studio__pause-btn" onClick={() => setStreamState('paused')} title="Viewers get a “We'll be right back” screen and silence">❚❚ PAUSE STREAM</button>}
              {streamState === 'paused' && <button className="hh-studio__go-btn" onClick={() => setStreamState('live')} title="Back to the program">▶ RESUME STREAM</button>}
              <button
                className={`hh-btn hh-btn--small ${recording ? 'hh-studio__rec-btn hh-studio__rec-btn--on' : 'hh-btn--secondary'}`}
                onClick={() => (recording ? stopRecording() : startRecording())}
                disabled={!isPremium && !recording}
                title={!isPremium
                  ? 'Recording requires a 3Speak Pro subscription'
                  : recording ? `Stop recording (${formatTime(recElapsed)})` : 'Record this stream to a video file'}
              >
                {recording ? `⏺ ${formatTime(recElapsed)}` : !isPremium ? '⏺ Record 🔒' : '⏺ Record'}
              </button>
              {streamState !== 'standby' && (
                <button
                  className="hh-studio__end-btn"
                  disabled={savingVod}
                  onClick={() => void endStream()}
                >
                  {savingVod ? '💾 Saving video…' : '■ END STREAM'}
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
      )}

      {/* Overlays are direct children of .hh-studio (position: relative) so
          they cover the whole studio, escape the rail's overflow clipping,
          and still inherit the studio's theme vars. */}
      {/* Non-Chromium heads-up. Tab picking and tab/system audio capture are
          Chromium-only, so a Firefox/Safari host would otherwise discover
          mid-stream that their share is silent. Shown once, then remembered. */}
      {showBrowserWarn && (
        <div className="hh-studio__modal-overlay">
          <div className="hh-studio__browser-warn">
            <div className="hh-studio__modal-head"><span>⚠️ Browser compatibility</span></div>
            {isMobile ? (
              /* The desktop copy is about tab sharing and system audio, none of
                 which exists on a phone. What actually bites mobile Firefox is
                 the camera. */
              <>
                <p>
                  For streaming from a phone we recommend <strong>Chrome</strong> or another
                  {' '}<strong>Chromium-based browser</strong>.
                </p>
                <p className="hh-studio__browser-warn-detail">
                  Your camera still works here, but in this browser:
                </p>
                <ul className="hh-studio__browser-warn-list">
                  <li>
                    only the <strong>default camera per side</strong> is usually offered — extra
                    lenses (ultra-wide, telephoto) often don't appear in the Lens list;
                  </li>
                  <li>
                    <strong>zoom is done in software</strong> rather than by the lens, so it's
                    softer than the real thing;
                  </li>
                  <li>
                    the camera may hand back a <strong>wider frame</strong> than the stream shape,
                    so a little is trimmed off the top and bottom.
                  </li>
                </ul>
                <p className="hh-studio__browser-warn-detail">
                  Microphone, chat and going live all work normally.
                </p>
              </>
            ) : (
              <>
                <p>
                  For streaming we recommend a <strong>Chromium-based browser</strong>
                  {' '}(Chrome, Edge, Brave or Opera).
                </p>
                <p className="hh-studio__browser-warn-detail">
                  In your current browser you can still share a <strong>window or screen</strong>, but:
                </p>
                <ul className="hh-studio__browser-warn-list">
                  <li>you <strong>cannot pick a single browser tab</strong> — that's Chromium-only;</li>
                  <li>screen shares carry <strong>no audio</strong> — tab and system audio capture is Chromium-only.</li>
                </ul>
                <p className="hh-studio__browser-warn-detail">
                  Your microphone, camera, media files and sound clips all work normally. To get
                  desktop audio here, route it in as a virtual input device and pick it as your mic.
                </p>
              </>
            )}
            <div className="hh-studio__browser-warn-actions">
              <button
                className="hh-btn hh-btn--primary hh-btn--small"
                onClick={() => {
                  try { window.localStorage.setItem(BROWSER_WARN_KEY, '1'); } catch { /* ignore */ }
                  setShowBrowserWarn(false);
                }}
              >
                Got it — don't show again
              </button>
              <button className="hh-btn hh-btn--secondary hh-btn--small" onClick={() => setShowBrowserWarn(false)}>
                Remind me next time
              </button>
            </div>
          </div>
        </div>
      )}

      {obsOpen && (
        <div className="hh-studio__modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setObsOpen(false); }}>
          <div className="hh-studio__obs-modal">
            <div className="hh-studio__modal-head">
              <span>🎥 Publish from OBS</span>
              <button className="hh-studio__collapse" onClick={() => setObsOpen(false)} title="Close">×</button>
            </div>

            {obsError ? (
              <p className="hh-studio__obs-error">{obsError}</p>
            ) : (
              <>
                <p className="hh-studio__obs-lead">
                  In OBS: <strong>Settings → Stream</strong>, set <strong>Service</strong> to{' '}
                  <strong>WHIP</strong>, paste this as the <strong>Server</strong>, leave the
                  Bearer Token empty, then hit <strong>Start Streaming</strong>.
                </p>
                <div className="hh-studio__obs-url">
                  <input readOnly value={obsInfo?.whipUrl || ''} onFocus={(e) => e.currentTarget.select()} />
                  <button
                    className="hh-btn hh-btn--primary hh-btn--small"
                    onClick={() => { void navigator.clipboard?.writeText(obsInfo?.whipUrl || ''); }}
                  >
                    Copy
                  </button>
                </div>
                <ul className="hh-studio__obs-hints">
                  <li>Needs <strong>OBS 30 or newer</strong> — that's when the WHIP output landed.</li>
                  <li>Keep this key private: anyone with the URL can publish into your stream.</li>
                  <li>Once OBS connects it appears here as an <strong>OBS</strong> source, usable in any scene.</li>
                </ul>
                <p className="hh-studio__obs-status">
                  {obsLive ? '✅ OBS is connected.' : '⏳ Waiting for OBS to connect…'}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {addMenuOpen && (
        <div className="hh-studio__modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setAddMenuOpen(false); }}>
          <div className="hh-studio__add-popup">
            <div className="hh-studio__modal-head">
              <span>Add source</span>
              <button className="hh-studio__collapse" onClick={() => setAddMenuOpen(false)} title="Close">×</button>
            </div>
            <button className="hh-studio__add-item" onClick={() => { setAddMenuOpen(false); if (camOn) stopCam(); else void startCam(); }}>
              📷 Camera <span className="hh-studio__add-state">{camOn ? 'on ✓' : ''}</span>
            </button>
            <button className="hh-studio__add-item" disabled={!shareSupported || shares.length >= MAX_SHARES}
              onClick={() => { setAddMenuOpen(false); void addShare(); }}
              title={!shareSupported ? 'Not available on this device' : shares.length >= MAX_SHARES ? `Max ${MAX_SHARES} shares` : undefined}>
              🖥️ {chromium ? 'Share a tab / screen' : 'Share a window / screen'}
            </button>
            <button className="hh-studio__add-item" disabled={obsBusy}
              onClick={() => { setAddMenuOpen(false); void openObsSetup(); }}
              title="Publish from OBS (or any WHIP encoder) into this stream">
              🎥 OBS / external encoder
              <span className="hh-studio__add-state">{obsLive ? 'connected ✓' : obsBusy ? 'setting up…' : ''}</span>
            </button>
            <button className="hh-studio__add-item" onClick={() => { setAddMenuOpen(false); mediaInputRef.current?.click(); }}>
              🖼️ Media file (image / GIF / video)
            </button>
            <div className="hh-studio__add-sep">Sound</div>
            <button className="hh-studio__add-item" onClick={() => { setAddMenuOpen(false); if (micOn) stopMic(); else void startMic(); }}>
              🎤 Microphone <span className="hh-studio__add-state">{micOn ? 'on ✓' : ''}</span>
            </button>
            <button className="hh-studio__add-item" onClick={() => { setAddMenuOpen(false); soundInputRef.current?.click(); }}>
              🎵 Audio file (music / jingle)
            </button>
            <div className="hh-studio__add-sub">🎚️ Desktop / aux audio</div>
            {auxDevices.length === 0 && <div className="hh-studio__add-empty">No input devices found — grant mic access first</div>}
            {auxDevices.map((d) => (
              <button key={d.deviceId} className="hh-studio__add-item hh-studio__add-item--sub"
                onClick={() => { setAddMenuOpen(false); void selectAuxDevice(d.deviceId); }}>
                {auxDeviceId === d.deviceId ? '● ' : '○ '}{d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {postModalOpen && (
        <div className="hh-studio__modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setPostModalOpen(false); }}>
          <div className="hh-studio__modal">
            <div className="hh-studio__modal-head">
              <span>Stream post</span>
              <button className="hh-studio__collapse" onClick={() => setPostModalOpen(false)} title="Close">×</button>
            </div>
            {renderPostEditor(true)}
          </div>
        </div>
      )}

      {boostHistoryOpen && <BoostHistoryPanel onClose={() => setBoostHistoryOpen(false)} />}
    </div>
  );
}
