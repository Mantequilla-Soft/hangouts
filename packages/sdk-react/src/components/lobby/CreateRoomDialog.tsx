import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Room, RoomVisibility, RoomMode } from '@snapie/hangouts-core';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { usePremiumStatus } from '../../hooks/usePremiumStatus.js';
import { ProUpsellDialog } from '../pro/ProUpsellDialog.js';
import { readPostDraft, writePostDraft } from '../../lib/postDraft.js';
import { AUTO_VOD_KEY, AUTO_DL_KEY, ALLOW_CLIPS_KEY, readPref, writePref } from '../../utils/streamRecordingPrefs.js';
import { isInAppBrowser, canBroadcast } from '../../lib/browser.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { FREE_STREAM_CAP_LABEL, PRO_STREAM_CAP_LABEL } from '../../lib/streamLimits.js';

/** How the host wants to announce the session on Hive. */
export type AnnounceType = 'snap' | 'post';

/** A snapshot of the create form's current values, handed to
 *  `renderStandaloneExtras` on every render. Recording flags are the EFFECTIVE
 *  values (false for a non-Pro host, whatever is ticked). */
export interface CreateRoomDraft {
  mode: RoomMode;
  title: string;
  description: string;
  /** Thumbnail / background image URL, '' when none. */
  thumbnail: string;
  tags: string[];
  language: string;
  visibility: RoomVisibility;
  boost: { enabled: boolean; minBoostUsd: number; creatorPayoutAccount: string };
  /** Announce on Hive (always false for an unlisted room). */
  notifyOnHive: boolean;
  announceType: AnnounceType;
  recording: { autoVod: boolean; autoDownload: boolean; allowClips: boolean };
  isPremium: boolean;
}

export interface CreateRoomDialogProps {
  /** Fired after the room is created. The second argument carries the host's
   *  announcement preference — the integrator does the actual Hive post
   *  (a short snap, or a full top-level post) and reads any extra options
   *  (payout/beneficiaries/community) from its own `renderAnnounceOptions`
   *  state. */
  onCreated: (room: Room, options: { notifyOnHive: boolean; announceType: AnnounceType }) => void;
  onCancel?: () => void;
  /** Show the "Standalone livestream studio" mode option. Off by default —
   *  when false the mode tiles are hidden and every room is a conference. */
  allowStandalone?: boolean;
  /** Renders integrator-owned announcement controls (payout, beneficiaries,
   *  and — for a full post — a community picker) below the snap/post choice.
   *  Only shown when "Announce on Hive" is on. The integrator manages this
   *  state itself and reads it in `onCreated`. */
  renderAnnounceOptions?: (announceType: AnnounceType) => ReactNode;
  /** Offer the "Quick snap" announcement type. ON by default. When false, the
   *  announcement is always a full post: the snap/post toggle disappears (a
   *  single option shouldn't be a button) and `announceType` is forced to
   *  'post'. Standalone streams are already post-only regardless. */
  allowSnapAnnounce?: boolean;
  /** Replaces the built-in description field with an integrator-supplied
   *  markdown editor (e.g. 3Speak's MarkdownComposer). When omitted, the
   *  dialog falls back to its own textarea + formatting toolbar. */
  renderDescriptionEditor?: (value: string, onChange: (v: string) => void) => ReactNode;
  /** Premium OVERRIDE. Gates the recording options — non-Pro hosts see them
   *  locked with an explanation rather than not at all, so the feature is
   *  discoverable, plus an "Unlock with Pro" button that opens the upsell.
   *
   *  Leave unset (the default): the SDK resolves premium itself from the
   *  hangouts API, so an integrator does not have to wire anything. Pass a
   *  boolean only to force the answer. */
  isPremium?: boolean;
  /** Replaces the built-in Pro upsell with your own handler (e.g. routing to
   *  your app's own plans page) when the host taps "Unlock with Pro". */
  onUpsell?: () => void;
  /** Open on this mode instead of whatever was used last. Set by the entry
   *  point the host came through — "Group chat" and "Start stream" are
   *  different intents, and each should land on its own kind of room. The
   *  tiles stay switchable. */
  defaultMode?: RoomMode;
  /** Extra integrator content rendered at the end of a STANDALONE form, just
   *  above the submit button, with the form's current values. For actions that
   *  reuse the host's setup without creating a room (e.g. saving it for later).
   *  Anything interactive in it must be `type="button"`: it sits inside the
   *  form. Not rendered for conference rooms. */
  renderStandaloneExtras?: (draft: CreateRoomDraft) => ReactNode;
  /** Split the form into steps (Basics, Details, Boosts & sharing, and for a
   *  stream Go live) with a stepper on top and Back/Next buttons above and
   *  below each step. Off by default: the form stays one page. */
  stepped?: boolean;
  /** Text for the stepped form, for integrators that translate it. Anything
   *  left out falls back to English. */
  stepLabels?: Partial<StepLabels>;
}

/** The stepped form's own text (see `stepped`). */
export interface StepLabels {
  basics: string;
  details: string;
  sharing: string;
  goLive: string;
  back: string;
  next: string;
  cancel: string;
  titleRequired: string;
}

const DEFAULT_STEP_LABELS: StepLabels = {
  basics: 'Basics',
  details: 'Details',
  sharing: 'Boosts & sharing',
  goLive: 'Go live',
  back: 'Back',
  next: 'Next',
  cancel: 'Cancel',
  titleRequired: 'Add a title to continue.',
};

type StepId = 'setup' | 'details' | 'audience' | 'finish';

async function uploadTo3Speak(file: File, apiKey: string): Promise<string> {
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

function getBgStorageKey(username: string) { return `hh_bg_image_${username}`; }

const MAX_TAGS = 10;

/** Common broadcast languages — the NAME is shown, the short code is stored
 *  (kept BCP-47 so existing consumers/filters don't break). */
const LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'sw', name: 'Swahili' },
];

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

const VISIBILITIES: Array<{ id: RoomVisibility; icon: string; title: string; desc: string }> = [
  { id: 'public', icon: '🌐', title: 'Public', desc: 'Anyone can watch as a guest' },
  { id: 'hive-internal', icon: '🔑', title: 'Hive-only', desc: 'Requires a Hive sign-in' },
  { id: 'unlisted', icon: '🔗', title: 'Unlisted', desc: 'Link only access' },
];

export function CreateRoomDialog({ onCreated, onCancel, allowStandalone = false, renderAnnounceOptions, renderDescriptionEditor, isPremium: isPremiumOverride, defaultMode, allowSnapAnnounce = true, onUpsell, renderStandaloneExtras, stepped = false, stepLabels }: CreateRoomDialogProps) {
  // Premium resolves itself so the integrator passes nothing; an explicit prop
  // still wins. `isPremium` is false until the lookup settles, so the locked
  // state renders first and unlocks — never the reverse, which would flash Pro
  // options at a free host.
  const { isPremium: resolvedPremium } = usePremiumStatus(undefined, { enabled: isPremiumOverride === undefined });
  const isPremium = isPremiumOverride ?? resolvedPremium;
  // null = closed. 'info' = opened from the "Unlock with Pro" button, so
  // dismissing just returns to the form. 'gate' = opened by the submit button,
  // where dismissing means "start streaming anyway" and creates the room.
  const [upsellMode, setUpsellMode] = useState<null | 'info' | 'gate'>(null);
  // The gate fires ONCE per dialog. A host who declined it and edited a field
  // must not be re-offered on every subsequent attempt to start.
  const proGateShownRef = useRef(false);
  // Pre-fill from the host's last session (shared with the studio's post
  // composer) so title/thumbnail/description/tags/language come back.
  // Which mode this dialog opens on, decided BEFORE the draft is read — each
  // mode keeps its own draft, so we have to know which one to load.
  const initialMode: RoomMode = useMemo(() => {
    if (defaultMode) return defaultMode;
    const last = readPostDraft().mode;
    return allowStandalone && last ? (last as RoomMode) : 'conference';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const draft = useMemo(() => readPostDraft(initialMode), [initialMode]);
  // Restore the last mode/access choice. Standalone is only restorable when the
  // integrator still allows it — otherwise a remembered 'standalone' would
  // stick with the mode tiles hidden and no way to change it.
  const [mode, setMode] = useState<RoomMode>(initialMode);
  // A remembered 'standalone' would otherwise strand the host in a mode whose
  // tile is disabled, with no way back.
  useEffect(() => {
    if (isInAppBrowser() || !canBroadcast()) setMode('conference');
  }, []);
  const [visibility, setVisibility] = useState<RoomVisibility>(
    (draft.visibility as RoomVisibility) ?? 'public',
  );
  const [title, setTitle] = useState(draft.title ?? '');
  const [backgroundImageUrl, setBackgroundImageUrl] = useState(draft.thumbnail ?? '');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [description, setDescription] = useState(draft.description ?? '');
  const [descPreview, setDescPreview] = useState(false);
  const [tags, setTags] = useState<string[]>(draft.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [language, setLanguage] = useState(draft.language ?? 'en');
  const [boostEnabled, setBoostEnabled] = useState(draft.boostEnabled ?? true);
  // $1 priced out most of the audience for a quick 'nice stream' boost.
  const [minBoostUsd, setMinBoostUsd] = useState(draft.minBoostUsd ?? '0.1');
  const [creatorPayoutAccount, setCreatorPayoutAccount] = useState(draft.creatorPayoutAccount ?? '');
  const [notifyOnHive, setNotifyOnHive] = useState(draft.notifyOnHive ?? true);
  const [announceType, setAnnounceType] = useState<AnnounceType>((draft.announceType as AnnounceType) ?? 'snap');
  // Shared with the studio's post tab — see streamRecordingPrefs. Set here so
  // the host decides before opening the studio, and changed there if they
  // change their mind before hitting Start.
  const [autoVod, setAutoVod] = useState(() => readPref(AUTO_VOD_KEY));
  const [autoDownload, setAutoDownload] = useState(() => readPref(AUTO_DL_KEY));
  const [allowClips, setAllowClips] = useState(() => readPref(ALLOW_CLIPS_KEY, true));
  useEffect(() => { writePref(AUTO_VOD_KEY, autoVod); }, [autoVod]);
  useEffect(() => { writePref(AUTO_DL_KEY, autoDownload); }, [autoDownload]);
  useEffect(() => { writePref(ALLOW_CLIPS_KEY, allowClips); }, [allowClips]);

  // A standalone stream is always announced as a full post — a snap can't carry
  // the video, the payout or the comments the rest of the flow depends on.
  // DERIVED rather than forced into `announceType` state, so a host who picks
  // snap for a conference, switches to standalone and back still finds their
  // original choice intact.
  // Broadcasting from an in-app browser (Hive Keychain's, or any social app's
  // link opener) does not work reliably: camera prompts misbehave, the host app
  // can suspend the WebView mid-stream, and there is no address bar to escape
  // to a real browser. Block it at the door rather than letting someone get
  // halfway into a broadcast and lose it.
  const cannotBroadcast = useMemo(() => isInAppBrowser() || !canBroadcast(), []);

  // Heading + one-line explainer above the form, so the host knows what kind of
  // room they're about to make — and, for a stream, why the studio differs
  // between desktop and phone.
  const onPhone = useIsMobile();
  const modeIntro = mode === 'standalone'
    ? (onPhone
        ? {
            title: 'Go Live',
            desc: 'Stream vertically straight from your phone — tap and you\u2019re broadcasting. For a richer studio with scenes and screen sharing, open 3Speak on a desktop.',
          }
        : {
            title: 'Stream Studio',
            desc: 'The full studio: add scenes, screen shares, extra cameras and overlays before you go live. Vertical phone-style streaming is only available on mobile.',
          })
    : {
        title: 'Group Chat',
        desc: 'Have a fun talk with others, invite guests on stage, and record podcasts on 3Speak.',
      };

  const isStandalone = mode === 'standalone';
  // Post-only when the stream is standalone OR the integrator disabled snaps.
  // With one option left there's no choice to make, so the toggle is hidden.
  const postOnly = isStandalone || !allowSnapAnnounce;
  const effectiveAnnounceType: AnnounceType = postOnly ? 'post' : announceType;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const { create, isLoading } = useHangoutsRoom();
  const { username, imageServerApiKey } = useHangoutsContext();

  // Markdown toolbar — wrap/insert around the current selection.
  const applyMd = (kind: 'bold' | 'italic' | 'h' | 'link' | 'list' | 'quote' | 'code') => {
    const ta = descRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd, val = ta.value;
    const sel = val.slice(s, e);
    let before = '', after = '', ph = '';
    if (kind === 'bold') { before = '**'; after = '**'; ph = 'bold text'; }
    else if (kind === 'italic') { before = '*'; after = '*'; ph = 'italic'; }
    else if (kind === 'h') { before = '### '; ph = 'Heading'; }
    else if (kind === 'link') { before = '['; after = '](https://)'; ph = 'link text'; }
    else if (kind === 'list') { before = '- '; ph = 'list item'; }
    else if (kind === 'quote') { before = '> '; ph = 'quote'; }
    else if (kind === 'code') { before = '`'; after = '`'; ph = 'code'; }
    const text = sel || ph;
    const next = val.slice(0, s) + before + text + after + val.slice(e);
    setDescription(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = s + before.length;
      ta.setSelectionRange(pos, pos + text.length);
    });
  };

  // The host's last uploaded background, but only when the saved draft has no
  // thumbnail. This used to set the field from that key alone, and to clear it
  // while the username was still unknown on the first render; the draft writer
  // below then saved the empty value, so the last setup's thumbnail was lost on
  // every reload (and one chosen in the studio never came back at all).
  useEffect(() => {
    if (!imageServerApiKey || !username) return;
    const saved = localStorage.getItem(getBgStorageKey(username)) ?? '';
    if (saved) setBackgroundImageUrl((cur) => cur || saved);
  }, [username, imageServerApiKey]);

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !imageServerApiKey) return;
    setUploadError('');
    setUploading(true);
    try {
      const url = await uploadTo3Speak(file, imageServerApiKey);
      setBackgroundImageUrl(url);
      if (username) localStorage.setItem(getBgStorageKey(username), url);
    } catch {
      setUploadError('Upload failed — please try again');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearBackground = () => {
    setBackgroundImageUrl('');
    if (username) localStorage.removeItem(getBgStorageKey(username));
  };

  const addTag = (raw?: string) => {
    const t = (raw ?? tagInput).trim().toLowerCase().replace(/^#+/, '').replace(/[^a-z0-9-]/g, '');
    if (t && tags.length < MAX_TAGS && !tags.includes(t)) setTags((p) => [...p, t]);
    setTagInput('');
  };

  // Switching the mode tile loads THAT mode's saved setup.
  //
  // Without this, flipping from Group chat to Standalone kept the chat's
  // settings — typically unlisted with no announcement — and a host would start
  // a stream nobody could find. Skipped on the first render, where the initial
  // state already came from the right draft.
  const loadedModeRef = useRef(initialMode);
  useEffect(() => {
    if (loadedModeRef.current === mode) return;
    loadedModeRef.current = mode;
    const d = readPostDraft(mode);
    setTitle(d.title ?? '');
    setDescription(d.description ?? '');
    setBackgroundImageUrl(d.thumbnail ?? '');
    setTags(d.tags ?? []);
    setLanguage(d.language ?? 'en');
    setVisibility((d.visibility as RoomVisibility) ?? 'public');
    setBoostEnabled(d.boostEnabled ?? true);
    setMinBoostUsd(d.minBoostUsd ?? '0.1');
    setCreatorPayoutAccount(d.creatorPayoutAccount ?? '');
    setNotifyOnHive(d.notifyOnHive ?? true);
    setAnnounceType((d.announceType as AnnounceType) ?? 'snap');
  }, [mode, initialMode]);

  // Remember what the host typed so the next create dialog (and the studio's
  // post composer) opens pre-filled with it.
  useEffect(() => {
    writePostDraft({
      title, description, thumbnail: backgroundImageUrl, tags, language, mode, visibility,
      boostEnabled, minBoostUsd, creatorPayoutAccount, notifyOnHive, announceType,
    }, mode);
  }, [
    title, description, backgroundImageUrl, tags, language, mode, visibility,
    boostEnabled, minBoostUsd, creatorPayoutAccount, notifyOnHive, announceType,
  ]);

  // Why the last create failed, shown above the actions. A free host's daily
  // stream limit gets its own wording, with the local time they can go again.
  const [createError, setCreateError] = useState<{ message: string; dailyLimit: boolean } | null>(null);

  const submitRoom = async () => {
    const bg = imageServerApiKey ? (backgroundImageUrl || undefined) : undefined;
    const minUsd = Number(minBoostUsd);
    setCreateError(null);
    let room: Room | null | undefined;
    try {
      room = await create(
      title.trim(),
      description.trim() || undefined,
      bg,
      visibility,
      language.trim() || undefined,
      {
        enabled: boostEnabled,
        minBoostUsd: Number.isFinite(minUsd) ? Math.max(0, minUsd) : 0,
        creatorPayoutAccount: creatorPayoutAccount.trim() || undefined,
      },
      mode,
      tags,
      );
    } catch (err) {
      const e = err as Error & { code?: string; retryAt?: string };
      if (e.code === 'daily_stream_limit') {
        const at = e.retryAt ? new Date(e.retryAt) : null;
        const valid = !!at && Number.isFinite(at.getTime());
        const sameDay = valid && at!.toDateString() === new Date().toDateString();
        const when = valid
          ? `${sameDay ? 'today' : 'tomorrow'} at ${at!.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : 'tomorrow';
        setCreateError({
          dailyLimit: true,
          message: `Free accounts can start one stream per day, and you have already streamed today. You can go live again ${when}.`,
        });
      } else {
        setCreateError({ dailyLimit: false, message: e.message || "Couldn't create the stream. Please try again." });
      }
      return;
    }
    const shouldNotify = visibility === 'unlisted' ? false : notifyOnHive;
    if (room) onCreated(room, { notifyOnHive: shouldNotify, announceType: effectiveAnnounceType });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    // Stepped: only the last step's button creates the room.
    if (stepped && curStep < lastStep) return;
    // Offer Pro at the moment the perks are about to be missed — the host has
    // just seen the locked recording options and is one click from a capped,
    // unrecorded stream. Deliberately BEFORE creation, so taking the trial
    // leaves nothing to undo. Streams only: a conference has none of these perks.
    if (isStandalone && !isPremium && !proGateShownRef.current) {
      proGateShownRef.current = true;
      setUpsellMode('gate');
      return;
    }
    await submitRoom();
  };

  // --- Stepped form (opt-in, see `stepped`) ---------------------------------
  // Every field keeps its state while its step is hidden; only what is shown
  // changes. A stream gets a fourth "Go live" step for the recording options
  // and the integrator extras; a conference has neither, so it ends on the
  // sharing step, which then carries the submit button.
  const stepText: StepLabels = { ...DEFAULT_STEP_LABELS, ...stepLabels };
  const stepIds: StepId[] = isStandalone ? ['setup', 'details', 'audience', 'finish'] : ['setup', 'details', 'audience'];
  const stepName: Record<StepId, string> = {
    setup: stepText.basics, details: stepText.details, audience: stepText.sharing, finish: stepText.goLive,
  };
  const [stepIdx, setStepIdx] = useState(0);
  const [titleMissing, setTitleMissing] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const lastStep = stepIds.length - 1;
  const curStep = Math.min(stepIdx, lastStep);
  const show = (id: StepId) => !stepped || stepIds[curStep] === id;

  const goToStep = (i: number) => {
    if (i === curStep || i < 0 || i > lastStep) return;
    // Everything after the first step needs a title (the room cannot be
    // created without one), so say so on the spot instead of at the end.
    if (i > 0 && !title.trim()) {
      setTitleMissing(true);
      if (curStep !== 0) setStepIdx(0);
      requestAnimationFrame(() => titleRef.current?.focus());
      return;
    }
    // A tag still being typed is added on blur, which not every browser fires
    // when the field just disappears.
    if (tagInput.trim()) addTag();
    setStepIdx(i);
  };

  // A new step starts at its top: bring the form's head back into view when it
  // was scrolled past (long steps, phones).
  const shownStepRef = useRef(curStep);
  useEffect(() => {
    if (shownStepRef.current === curStep) return;
    shownStepRef.current = curStep;
    const top = formRef.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) formRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [curStep]);

  const submitButton = (
    <button key="submit" className="hh-btn hh-btn--primary hh-cd__submit" type="submit" disabled={!title.trim() || isLoading || uploading}>
      {isLoading ? 'Creating…' : mode === 'standalone' ? '📡 Open Stream Studio' : '🚀 Start Session'}
    </button>
  );

  // Rendered above and below the step. The Next and submit buttons carry
  // different keys on purpose: reusing one DOM node would turn the clicked Next
  // into a submit button before the click finishes and create the room.
  const stepNav = (where: 'top' | 'bottom') => (
    <div className={`hh-cd__actions hh-cd__actions--steps hh-cd__actions--${where}`}>
      {curStep === 0
        ? (onCancel
            ? <button key="cancel" className="hh-btn hh-btn--secondary" type="button" onClick={onCancel}>{stepText.cancel}</button>
            : <span />)
        : <button key="back" className="hh-btn hh-btn--secondary" type="button" onClick={() => goToStep(curStep - 1)}>← {stepText.back}</button>}
      {curStep < lastStep
        ? <button key="next" className="hh-btn hh-btn--primary hh-cd__next" type="button" disabled={uploading} onClick={() => goToStep(curStep + 1)}>{stepText.next} →</button>
        : submitButton}
    </div>
  );

  const stepper = stepped && (
    <nav className="hh-cd-steps" aria-label={stepName[stepIds[curStep]]}>
      <ol className="hh-cd-steps__row">
        {stepIds.map((id, i) => {
          const state = i < curStep ? 'done' : i === curStep ? 'active' : 'todo';
          return (
            <li key={id} className="hh-cd-steps__item">
              <button
                type="button"
                className={`hh-cd-steps__step is-${state}`}
                aria-current={state === 'active' ? 'step' : undefined}
                onClick={() => goToStep(i)}
              >
                <span className="hh-cd-steps__ring">
                  {state === 'done' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : i + 1}
                </span>
                <span className="hh-cd-steps__label">{stepName[id]}</span>
              </button>
              {i < lastStep && <span className={`hh-cd-steps__line${i < curStep ? ' is-done' : ''}`} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      {/* Phones: no room for labels in the row, so the current one sits below. */}
      <div className="hh-cd-steps__caption">{stepName[stepIds[curStep]]}</div>
    </nav>
  );

  return (
    <form
      ref={formRef}
      className={`hh-cd${stepped ? ' hh-cd--stepped' : ''}`}
      onSubmit={handleSubmit}
      onKeyDown={(e) => {
        // Enter in a single-line field must NOT create the room. Submitting
        // here creates a real room server-side and drops the host straight
        // into the studio, so an accidental Enter is expensive. Textareas keep
        // their newlines; the submit button still works by click/Enter.
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
      }}
    >
      <div className="hh-cd__intro">
        {/* Beta pill on the mode itself — live streaming is still being tested.
            Shown on the direct-link entry, where this heading is the only label
            (the lobby header is hidden). */}
        <h2 className="hh-cd__intro-title">
          {modeIntro.title}
          {!!defaultMode && <span className="hh-cd__beta">beta</span>}
        </h2>
        <p className="hh-cd__intro-desc">{modeIntro.desc}</p>
      </div>

      {stepper}
      {stepped && stepNav('top')}

      {show('setup') && (<>
        {/* 1 · Mode — hidden when the host arrived via a link that already said
            which kind of room they want ("Group chat" / "Start stream"). Asking
            again would be asking a question they just answered. */}
        {allowStandalone && !defaultMode && (
          <div className="hh-cd__section">
            <span className="hh-cd__label">What are you starting?</span>
            <div className="hh-cd__tiles">
              <button type="button" className={`hh-cd__tile${mode === 'conference' ? ' is-active' : ''}`} onClick={() => setMode('conference')}>
                <span className="hh-cd__tile-icon">👥</span>
                <span className="hh-cd__tile-title">Room</span>
                <span className="hh-cd__tile-desc">Everyone can join &amp; talk</span>
              </button>
              <button
                type="button"
                className={`hh-cd__tile${mode === 'standalone' ? ' is-active' : ''}${cannotBroadcast ? ' is-disabled' : ''}`}
                disabled={cannotBroadcast}
                title={cannotBroadcast ? 'Open 3Speak in your browser to go live' : undefined}
                onClick={() => setMode('standalone')}
              >
                <span className="hh-cd__tile-icon">📡</span>
                <span className="hh-cd__tile-title">Standalone</span>
                <span className="hh-cd__tile-desc">
                  {cannotBroadcast ? 'Not available in this app’s browser' : 'Solo livestream studio'}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* 2 · Visibility */}
        <div className="hh-cd__section">
          <span className="hh-cd__label">Who can find it?</span>
          <div className="hh-cd__tiles hh-cd__tiles--3">
            {VISIBILITIES.map((v) => (
              <button key={v.id} type="button" className={`hh-cd__tile${visibility === v.id ? ' is-active' : ''}`} onClick={() => setVisibility(v.id)}>
                <span className="hh-cd__tile-icon">{v.icon}</span>
                <span className="hh-cd__tile-title">{v.title}</span>
                <span className="hh-cd__tile-desc">{v.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 3 · Title */}
        <div className="hh-cd__section">
          <span className="hh-cd__label">Title</span>
          {/* No autoFocus: focusing the title on open scrolls the dialog past its
              own heading/mode tiles straight to this field, so the host never
              sees the intro or which mode they're on. Let the form open at the
              top and let them tab/click into it. */}
          <input ref={titleRef} className="hh-cd__input" type="text" placeholder="Give it a catchy title…" value={title}
            aria-invalid={titleMissing || undefined}
            onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) setTitleMissing(false); }} maxLength={64} />
          {titleMissing && <p className="hh-cd__field-error" role="alert">{stepText.titleRequired}</p>}
        </div>

        {/* 4 · Thumbnail / background */}
        {imageServerApiKey && (
          <div className="hh-cd__section">
            <span className="hh-cd__label">Thumbnail / background</span>
            <div className="hh-bg-picker">
              {backgroundImageUrl ? (
                <div className="hh-bg-picker__preview-wrap">
                  <div className="hh-bg-picker__preview" style={{ backgroundImage: `url(${backgroundImageUrl})` }}>
                    <span className="hh-bg-picker__preview-label">16:9 preview</span>
                  </div>
                  <div className="hh-bg-picker__actions">
                    <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" onClick={() => fileInputRef.current?.click()} disabled={uploading}>Change</button>
                    <button type="button" className="hh-btn hh-btn--ghost hh-btn--small" onClick={clearBackground}>Remove</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="hh-bg-picker__upload-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  {uploading ? 'Uploading…' : '🖼️ Add a thumbnail (16:9)'}
                </button>
              )}
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageChange} />
              {uploadError && <p className="hh-bg-picker__error">{uploadError}</p>}
            </div>
          </div>
        )}
      </>)}

      {show('details') && (<>
        {/* 5 · Description (markdown) */}
        <div className="hh-cd__section">
          <div className="hh-cd__label-row">
            <span className="hh-cd__label">Description</span>
            {!renderDescriptionEditor && (
              <div className="hh-cd__md-tabs">
                <button type="button" className={!descPreview ? 'is-active' : ''} onClick={() => setDescPreview(false)}>Write</button>
                <button type="button" className={descPreview ? 'is-active' : ''} onClick={() => setDescPreview(true)}>Preview</button>
                <span className="hh-cd__md-hint">Markdown</span>
              </div>
            )}
          </div>
          {renderDescriptionEditor
            ? renderDescriptionEditor(description, setDescription)
            : <>
                {!descPreview && (
                  <div className="hh-cd__md-toolbar" role="toolbar" aria-label="Formatting">
                    <button type="button" title="Bold" onClick={() => applyMd('bold')}><b>B</b></button>
                    <button type="button" title="Italic" onClick={() => applyMd('italic')}><i>I</i></button>
                    <button type="button" title="Heading" onClick={() => applyMd('h')}>H</button>
                    <button type="button" title="Link" onClick={() => applyMd('link')}>🔗</button>
                    <button type="button" title="Bulleted list" onClick={() => applyMd('list')}>• List</button>
                    <button type="button" title="Quote" onClick={() => applyMd('quote')}>❝</button>
                    <button type="button" title="Inline code" onClick={() => applyMd('code')}>{'</>'}</button>
                  </div>
                )}
                {descPreview
                  ? <div className="hh-cd__md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(description || '_Nothing yet._') }} />
                  : <textarea ref={descRef} className="hh-cd__textarea" placeholder="What's it about? (markdown supported)" value={description}
                      rows={4} maxLength={5000} onChange={(e) => setDescription(e.target.value)} />}
              </>}
        </div>

        {/* 6 · Tags */}
        <div className="hh-cd__section">
          <span className="hh-cd__label">Tags <em className="hh-cd__label-note">({tags.length}/{MAX_TAGS})</em></span>
          <div className="hh-cd__tags">
            {tags.map((t) => (
              <span key={t} className="hh-cd__tag">{t}<button type="button" onClick={() => setTags((p) => p.filter((x) => x !== t))} aria-label={`Remove ${t}`}>×</button></span>
            ))}
            {tags.length < MAX_TAGS && (
              <input className="hh-cd__tag-input" type="text" placeholder={tags.length ? 'add another…' : 'add tags — space to add'} value={tagInput}
                onChange={(e) => { const v = e.target.value; if (/[\s,]/.test(v)) addTag(v); else setTagInput(v); }}
                onKeyDown={(e) => { if (e.key === ',') { e.preventDefault(); addTag(); } }}
                onBlur={() => addTag()} />
            )}
          </div>
        </div>

        {/* 7 · Language */}
        <div className="hh-cd__section">
          <span className="hh-cd__label">Language</span>
          <select className="hh-cd__select" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (<option key={l.code} value={l.code}>{l.name}</option>))}
          </select>
        </div>
      </>)}

      {show('audience') && (<>
        {/* 8 · Boost toggle */}
        <div className="hh-cd__section">
          <label className="hh-cd__switch">
            <input type="checkbox" checked={boostEnabled} onChange={(e) => setBoostEnabled(e.target.checked)} />
            <span className="hh-cd__switch-track"><span className="hh-cd__switch-thumb" /></span>
            <span className="hh-cd__switch-label">🚀 Enable Boost messages</span>
          </label>
        </div>

        {/* 9 · Minimum boost + payout account */}
        {boostEnabled && (
          <div className="hh-cd__section hh-cd__row2">
            <label className="hh-cd__field">
              <span className="hh-cd__label">Minimum boost (USD)</span>
              <input className="hh-cd__input" type="number" min="0" step="0.01" value={minBoostUsd} onChange={(e) => setMinBoostUsd(e.target.value)} />
            </label>
            <label className="hh-cd__field">
              <span className="hh-cd__label">Payout account</span>
              <input className="hh-cd__input" type="text" value={creatorPayoutAccount} maxLength={16}
                placeholder="defaults to you" onChange={(e) => setCreatorPayoutAccount(e.target.value)} />
            </label>
          </div>
        )}

        {/* 10 · Announce */}
        {visibility !== 'unlisted' && (
          <div className="hh-cd__section">
            <label className="hh-cd__check">
              <input type="checkbox" checked={notifyOnHive} onChange={(e) => setNotifyOnHive(e.target.checked)} />
              <span>
                {isStandalone
                  ? '📣 Share this stream on Hive and 3Speak'
                  : '📣 Announce this session on Hive'}
              </span>
            </label>
            {notifyOnHive && (
              <div className="hh-cd__announce">
                {/* A standalone stream is always a full post — never a snap. The
                    whole downstream workflow hangs off a real post: it's what the
                    3Speak watch page renders (votes, payout, comments), what the
                    VOD is attached to when the stream ends, and what live-chat
                    messages are commented onto. A snap is a comment and can hold
                    none of that, so the choice isn't offered. */}
                {!postOnly && (
                  <div className="hh-cd__seg" role="tablist" aria-label="Announcement type">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={announceType === 'snap'}
                      className={announceType === 'snap' ? 'is-active' : ''}
                      onClick={() => setAnnounceType('snap')}
                    >
                      💬 Quick snap
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={announceType === 'post'}
                      className={announceType === 'post' ? 'is-active' : ''}
                      onClick={() => setAnnounceType('post')}
                    >
                      📝 Full post
                    </button>
                  </div>
                )}
                <p className={`hh-cd__announce-hint${postOnly ? ' hh-cd__announce-hint--solo' : ''}`}>
                  {isStandalone ? (
                    <><strong>Posts to Hive and publishes the stream on 3Speak</strong> — pick a community, payout and beneficiaries below.</>
                  ) : effectiveAnnounceType === 'snap' ? (
                    <><strong>A short snap</strong> linking to your live session.</>
                  ) : (
                    <><strong>A full top-level Hive post</strong> — pick a community, payout and beneficiaries below.</>
                  )}
                </p>
                {renderAnnounceOptions?.(effectiveAnnounceType)}
              </div>
            )}
          </div>
        )}
      </>)}

      {show('finish') && (<>
        {/* What happens to the broadcast once it ends. Standalone streams only —
            a conference has no program feed to record. Both are also in the
            studio's post tab (same stored prefs), but a host who never opens that
            tab would otherwise lose the recording without ever being offered it.
            Shown to non-Pro hosts too, locked with the reason — that's how the
            feature gets discovered at all. */}
        {mode === 'standalone' && (
          <div className="hh-cd__recording">
            <span className="hh-cd__label">When the stream ends</span>

            {/* Bound to the announcement: the VOD replaces the announcement post's
                video, so with nothing announced there is no post to add it to and
                the option is meaningless rather than merely unavailable. Hidden,
                not locked — a lock implies "upgrade and you get this", which
                would be wrong here. */}
            {notifyOnHive && visibility !== 'unlisted' && (
              <label className="hh-cd__reccheck">
                <input
                  type="checkbox"
                  checked={autoVod}
                  onChange={(e) => setAutoVod(e.target.checked)}
                />
                <span>
                  🎬 Replace the stream with a video when it ends
                  <em>
                    {isPremium
                      ? 'Records the whole broadcast and adds it as the VOD on your announcement post, so the same link plays the replay afterwards.'
                      : `Records the broadcast (up to ${FREE_STREAM_CAP_LABEL}) and adds it as the VOD on your announcement post, so the same link plays the replay afterwards.`}
                  </em>
                </span>
              </label>
            )}

            <label className={`hh-cd__reccheck${isPremium ? '' : ' hh-cd__reccheck--locked'}`}>
              <input
                type="checkbox"
                checked={autoDownload && isPremium}
                disabled={!isPremium}
                onChange={(e) => setAutoDownload(e.target.checked)}
              />
              <span>
                💾 Record the session and download it when it ends
                {!isPremium && ' 🔒'}
                <em>
                  {isPremium
                    ? 'Saves a copy to your computer when you end the stream.'
                    : 'Only available with 3Speak Pro — records the broadcast to a file on your computer.'}
                </em>
              </span>
            </label>

            <label className={`hh-cd__reccheck${isPremium ? '' : ' hh-cd__reccheck--locked'}`}>
              <input
                type="checkbox"
                checked={allowClips && isPremium}
                disabled={!isPremium}
                onChange={(e) => setAllowClips(e.target.checked)}
              />
              <span>
                ✂ Let viewers clip the last 30 seconds
                {!isPremium && ' 🔒'}
                <em>
                  {isPremium
                    ? 'Viewers get a “30 sec” button to save and share a clip of your live stream.'
                    : 'Only available with 3Speak Pro — viewers can save and share a 30-second clip.'}
                </em>
              </span>
            </label>

            {/* The way out of the padlocks. Sits with the locked options rather
                than after room creation, so the offer lands while the host is
                still looking at what they're missing. */}
            {!isPremium && (
              <button
                type="button"
                className="hh-cd__unlock"
                onClick={() => (onUpsell ? onUpsell() : setUpsellMode('info'))}
              >
                👑 Unlock with Pro
              </button>
            )}
          </div>
        )}

        {/* Streams are time-capped; say so before the host commits. Free gets a
            short cap, Pro a long one (a safety ceiling). Stream modes only. */}
        {isStandalone && (
          <p className="hh-cd__limit-hint">
            {isPremium ? (
              <>⏳ Streams can run up to {PRO_STREAM_CAP_LABEL}.</>
            ) : (
              <>⏳ Free streams are limited to {FREE_STREAM_CAP_LABEL} and one stream per day. Upgrade to{' '}
                <strong>3Speak Pro</strong> for longer streams (up to {PRO_STREAM_CAP_LABEL}) with no daily limit.</>
            )}
          </p>
        )}

        {/* Integrator extras for a stream (see renderStandaloneExtras). */}
        {isStandalone && renderStandaloneExtras?.({
          mode,
          title: title.trim(),
          description: description.trim(),
          thumbnail: imageServerApiKey ? backgroundImageUrl : '',
          tags,
          language: language.trim(),
          visibility,
          boost: {
            enabled: boostEnabled,
            minBoostUsd: Number.isFinite(Number(minBoostUsd)) ? Math.max(0, Number(minBoostUsd)) : 0,
            creatorPayoutAccount: creatorPayoutAccount.trim(),
          },
          notifyOnHive: visibility === 'unlisted' ? false : notifyOnHive,
          announceType: effectiveAnnounceType,
          recording: {
            // Everyone may publish the replay (a free one is as long as a free stream).
            autoVod,
            autoDownload: isPremium && autoDownload,
            allowClips: isPremium && allowClips,
          },
          isPremium,
        })}
      </>)}

      {createError && (
        <div className={`hh-cd__create-error${createError.dailyLimit ? ' hh-cd__create-error--limit' : ''}`} role="alert">
          <p>{createError.dailyLimit ? '⏳ ' : ''}{createError.message}</p>
          {createError.dailyLimit && (
            <button type="button" className="hh-btn hh-btn--primary hh-cd__create-error-upsell"
              onClick={() => (onUpsell ? onUpsell() : setUpsellMode('info'))}>
              Stream without a daily limit with 3Speak Pro
            </button>
          )}
        </div>
      )}

      {/* 11 · Actions */}
      {stepped ? stepNav('bottom') : (
        <div className="hh-cd__actions">
          {submitButton}
          {onCancel && (
            <button className="hh-btn hh-btn--secondary" type="button" onClick={onCancel}>Cancel</button>
          )}
        </div>
      )}

      {/* From the unlock button this is purely informational; from the submit
          button it stands between the host and the studio, and dismissing it
          proceeds. Claiming the trial returns to the form instead of creating,
          so the host can tick the options they just unlocked — usePremiumStatus
          refreshes as part of the claim, so they are already live. */}
      <ProUpsellDialog
        open={upsellMode !== null}
        onContinue={() => {
          const wasGate = upsellMode === 'gate';
          setUpsellMode(null);
          if (wasGate) void submitRoom();
        }}
        onClose={() => setUpsellMode(null)}
        onTrialClaimed={() => setUpsellMode(null)}
        heading={upsellMode === 'gate' ? 'Before you go live' : 'Get more from your stream'}
        continueLabel={upsellMode === 'gate' ? 'Start streaming anyway' : 'Back to the room settings'}
      />
    </form>
  );
}
