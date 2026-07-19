import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Room, RoomVisibility, RoomMode } from '@snapie/hangouts-core';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { readPostDraft, writePostDraft } from '../../lib/postDraft.js';
import { AUTO_VOD_KEY, AUTO_DL_KEY, readPref, writePref } from '../../utils/streamRecordingPrefs.js';

/** How the host wants to announce the session on Hive. */
export type AnnounceType = 'snap' | 'post';

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
  /** Replaces the built-in description field with an integrator-supplied
   *  markdown editor (e.g. 3Speak's MarkdownComposer). When omitted, the
   *  dialog falls back to its own textarea + formatting toolbar. */
  renderDescriptionEditor?: (value: string, onChange: (v: string) => void) => ReactNode;
  /** 3Speak Pro host. Gates the recording options — non-Pro hosts see them
   *  locked with an explanation rather than not at all, so the feature is
   *  discoverable. */
  isPremium?: boolean;
}

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
  { id: 'unlisted', icon: '🔗', title: 'Unlisted', desc: 'Link only — hidden from lobby' },
];

export function CreateRoomDialog({ onCreated, onCancel, allowStandalone = false, renderAnnounceOptions, renderDescriptionEditor, isPremium = false }: CreateRoomDialogProps) {
  // Pre-fill from the host's last session (shared with the studio's post
  // composer) so title/thumbnail/description/tags/language come back.
  const draft = useMemo(() => readPostDraft(), []);
  // Restore the last mode/access choice. Standalone is only restorable when the
  // integrator still allows it — otherwise a remembered 'standalone' would
  // stick with the mode tiles hidden and no way to change it.
  const [mode, setMode] = useState<RoomMode>(
    allowStandalone && draft.mode ? (draft.mode as RoomMode) : 'conference',
  );
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
  const [minBoostUsd, setMinBoostUsd] = useState(draft.minBoostUsd ?? '1');
  const [creatorPayoutAccount, setCreatorPayoutAccount] = useState(draft.creatorPayoutAccount ?? '');
  const [notifyOnHive, setNotifyOnHive] = useState(draft.notifyOnHive ?? true);
  const [announceType, setAnnounceType] = useState<AnnounceType>((draft.announceType as AnnounceType) ?? 'snap');
  // Shared with the studio's post tab — see streamRecordingPrefs. Set here so
  // the host decides before opening the studio, and changed there if they
  // change their mind before hitting Start.
  const [autoVod, setAutoVod] = useState(() => readPref(AUTO_VOD_KEY));
  const [autoDownload, setAutoDownload] = useState(() => readPref(AUTO_DL_KEY));
  useEffect(() => { writePref(AUTO_VOD_KEY, autoVod); }, [autoVod]);
  useEffect(() => { writePref(AUTO_DL_KEY, autoDownload); }, [autoDownload]);

  // A standalone stream is always announced as a full post — a snap can't carry
  // the video, the payout or the comments the rest of the flow depends on.
  // DERIVED rather than forced into `announceType` state, so a host who picks
  // snap for a conference, switches to standalone and back still finds their
  // original choice intact.
  const isStandalone = mode === 'standalone';
  const effectiveAnnounceType: AnnounceType = isStandalone ? 'post' : announceType;
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

  useEffect(() => {
    if (!imageServerApiKey || !username) { setBackgroundImageUrl(''); return; }
    setBackgroundImageUrl(localStorage.getItem(getBgStorageKey(username)) ?? '');
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

  // Remember what the host typed so the next create dialog (and the studio's
  // post composer) opens pre-filled with it.
  useEffect(() => {
    writePostDraft({
      title, description, thumbnail: backgroundImageUrl, tags, language, mode, visibility,
      boostEnabled, minBoostUsd, creatorPayoutAccount, notifyOnHive, announceType,
    });
  }, [
    title, description, backgroundImageUrl, tags, language, mode, visibility,
    boostEnabled, minBoostUsd, creatorPayoutAccount, notifyOnHive, announceType,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const bg = imageServerApiKey ? (backgroundImageUrl || undefined) : undefined;
    const minUsd = Number(minBoostUsd);
    const room = await create(
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
    const shouldNotify = visibility === 'unlisted' ? false : notifyOnHive;
    if (room) onCreated(room, { notifyOnHive: shouldNotify, announceType: effectiveAnnounceType });
  };

  return (
    <form
      className="hh-cd"
      onSubmit={handleSubmit}
      onKeyDown={(e) => {
        // Enter in a single-line field must NOT create the room. Submitting
        // here creates a real room server-side and drops the host straight
        // into the studio, so an accidental Enter is expensive. Textareas keep
        // their newlines; the submit button still works by click/Enter.
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
      }}
    >
      {/* 1 · Mode */}
      {allowStandalone && (
        <div className="hh-cd__section">
          <span className="hh-cd__label">What are you starting?</span>
          <div className="hh-cd__tiles">
            <button type="button" className={`hh-cd__tile${mode === 'conference' ? ' is-active' : ''}`} onClick={() => setMode('conference')}>
              <span className="hh-cd__tile-icon">👥</span>
              <span className="hh-cd__tile-title">Room</span>
              <span className="hh-cd__tile-desc">Everyone can join &amp; talk</span>
            </button>
            <button type="button" className={`hh-cd__tile${mode === 'standalone' ? ' is-active' : ''}`} onClick={() => setMode('standalone')}>
              <span className="hh-cd__tile-icon">📡</span>
              <span className="hh-cd__tile-title">Standalone</span>
              <span className="hh-cd__tile-desc">Solo livestream studio</span>
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
        <input className="hh-cd__input" type="text" placeholder="Give it a catchy title…" value={title}
          onChange={(e) => setTitle(e.target.value)} maxLength={64} autoFocus />
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

      {/* 8 · Boost toggle */}
      <div className="hh-cd__section">
        <label className="hh-cd__switch">
          <input type="checkbox" checked={boostEnabled} onChange={(e) => setBoostEnabled(e.target.checked)} />
          <span className="hh-cd__switch-track"><span className="hh-cd__switch-thumb" /></span>
          <span className="hh-cd__switch-label">💸 Enable Boost messages</span>
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
              {!isStandalone && (
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
              <p className="hh-cd__announce-hint">
                {isStandalone
                  ? 'Posts to Hive and publishes the stream on 3Speak — pick a community, payout and beneficiaries below.'
                  : announceType === 'snap'
                    ? 'A short snap linking to your live session.'
                    : 'A full top-level Hive post — pick a community, payout and beneficiaries below.'}
              </p>
              {renderAnnounceOptions?.(effectiveAnnounceType)}
            </div>
          )}
        </div>
      )}

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
            <label className={`hh-cd__reccheck${isPremium ? '' : ' hh-cd__reccheck--locked'}`}>
              <input
                type="checkbox"
                checked={autoVod && isPremium}
                disabled={!isPremium}
                onChange={(e) => setAutoVod(e.target.checked)}
              />
              <span>
                🎬 Replace the stream with a video when it ends
                {!isPremium && ' 🔒'}
                <em>
                  {isPremium
                    ? 'Records the whole broadcast and adds it as the VOD on your announcement post, so the same link plays the replay afterwards.'
                    : 'Only available with 3Speak Pro \u2014 records the broadcast and adds it as VOD to the announcement post.'}
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
        </div>
      )}

      {/* 11 · Actions */}
      <div className="hh-cd__actions">
        <button className="hh-btn hh-btn--primary hh-cd__submit" type="submit" disabled={!title.trim() || isLoading || uploading}>
          {isLoading ? 'Creating…' : mode === 'standalone' ? '📡 Open Stream Studio' : '🚀 Start Session'}
        </button>
        {onCancel && (
          <button className="hh-btn hh-btn--secondary" type="button" onClick={onCancel}>Cancel</button>
        )}
      </div>
    </form>
  );
}
