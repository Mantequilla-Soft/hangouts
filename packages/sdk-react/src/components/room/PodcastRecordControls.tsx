import { useCallback, useEffect, useRef, useState } from 'react';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import {
  podcastApi, waitForEpisode, clock, type PodcastEpisode, type PodcastChapter,
} from '../../lib/hangoutsHttp.js';

/** What a finished podcast recording hands the integrator: the mixed episode as
 *  a file (like any audio recording), plus the chapters and the per-speaker
 *  tracks (absolute URLs, a day) for an editor that takes voice tracks. */
export interface PodcastHandoff {
  blob: Blob;
  filename: string;
  duration: number;
  size: number;
  title?: string | null;
  chapters?: PodcastChapter[];
  tracks?: Array<{ identity: string; offsetSec: number; url: string }>;
}

export interface PodcastRecordControlsProps {
  roomName: string;
  /** Receives the finished episode. Without it the host gets download links. */
  onAudioHandoff?: (file: PodcastHandoff) => void;
}

type Phase = 'idle' | 'recording' | 'mixing' | 'ready' | 'failed';

/**
 * "Record as podcast" for the host of an audio room (H23). One track per
 * speaker is recorded on the server; stage changes and the host's chapter
 * marks become the episode's chapters; on Stop the server mixes the episode and
 * it goes to the integrator's audio publish flow (3Speak: the audio upload,
 * which also opens the audio editor for silence cut and loudness).
 */
export function PodcastRecordControls({ roomName, onAudioHandoff }: PodcastRecordControlsProps) {
  const { apiBaseUrl, apiClient } = useHangoutsContext();
  const token = apiClient.getSessionToken();
  const [phase, setPhase] = useState<Phase>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);
  const [markTitle, setMarkTitle] = useState('');
  const [episode, setEpisode] = useState<PodcastEpisode | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // A reload while recording picks the running recording back up.
  useEffect(() => {
    if (!token) return;
    podcastApi.status(apiBaseUrl, roomName, token)
      .then((s) => { if (alive.current && s.recording) { setPhase('recording'); setStartedAt(Date.parse(s.startedAt || '') || Date.now()); } })
      .catch(() => { /* not recording */ });
  }, [apiBaseUrl, roomName, token]);

  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const abs = useCallback((path: string) => `${apiBaseUrl.replace(/\/+$/, '')}${path}`, [apiBaseUrl]);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const r = await podcastApi.start(apiBaseUrl, roomName, token);
      setStartedAt(Date.parse(r.startedAt) || Date.now());
      setPhase('recording');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the recording');
    } finally { setBusy(false); }
  };

  const addMark = async () => {
    const title = markTitle.trim();
    if (!title) return;
    setBusy(true);
    try { await podcastApi.marker(apiBaseUrl, roomName, token, title); setMarkTitle(''); setMarkOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Chapter not added'); }
    finally { setBusy(false); }
  };

  const handOff = useCallback(async (ep: PodcastEpisode) => {
    if (!onAudioHandoff || !ep.mixUrl) return;
    setBusy(true);
    try {
      const res = await fetch(abs(ep.mixUrl));
      if (!res.ok) throw new Error(`The episode could not be fetched (${res.status})`);
      const blob = await res.blob();
      onAudioHandoff({
        blob, filename: `${roomName}.mp3`, duration: ep.durationSec, size: blob.size, title: ep.title,
        chapters: ep.chapters, tracks: ep.tracks.map((t) => ({ ...t, url: abs(t.url) })),
      });
      setPhase('idle'); setEpisode(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The episode could not be fetched');
    } finally { setBusy(false); }
  }, [onAudioHandoff, abs, roomName]);

  const stop = async () => {
    if (!window.confirm('Stop recording? The episode is mixed and handed to you to publish.')) return;
    setBusy(true); setError(null);
    try {
      const first = await podcastApi.stop(apiBaseUrl, roomName, token);
      setPhase('mixing');
      const ep = first.status === 'mixing' ? await waitForEpisode(apiBaseUrl, token, first.token) : first;
      if (!alive.current) return;
      setEpisode(ep);
      setPhase(ep?.status === 'ready' ? 'ready' : 'failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop the recording');
    } finally { setBusy(false); }
  };

  if (phase === 'recording') {
    return (
      <div className="hh-podcast hh-podcast--recording">
        <span className="hh-recording-indicator" title="Recording as a podcast">
          <span className="hh-recording-indicator__dot" />
          {clock(startedAt ? (now - startedAt) / 1000 : 0)}
        </span>
        {markOpen ? (
          <form className="hh-podcast__mark" onSubmit={(e) => { e.preventDefault(); void addMark(); }}>
            <input
              className="hh-podcast__mark-input"
              value={markTitle}
              maxLength={80}
              placeholder="Chapter title"
              aria-label="Chapter title"
              autoFocus
              onChange={(e) => setMarkTitle(e.target.value)}
            />
            <button type="submit" className="hh-btn hh-btn--small hh-btn--primary" disabled={busy || !markTitle.trim()}>Add</button>
            <button type="button" className="hh-btn hh-btn--small hh-btn--secondary" onClick={() => setMarkOpen(false)}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="hh-btn hh-btn--small hh-btn--secondary" onClick={() => setMarkOpen(true)} title="Start a new chapter here">
            🔖 Chapter
          </button>
        )}
        <button type="button" className="hh-btn hh-btn--small hh-btn--danger" onClick={() => void stop()} disabled={busy}>
          ⏹ Stop podcast
        </button>
        {error && <span className="hh-podcast__error" role="alert">{error}</span>}
      </div>
    );
  }

  if (phase === 'mixing') {
    return <div className="hh-podcast hh-podcast--mixing" role="status">Mixing the episode…</div>;
  }

  if ((phase === 'ready' || phase === 'failed') && episode) {
    return (
      <div className="hh-podcast hh-podcast--done">
        <div className="hh-podcast__info">
          {phase === 'ready'
            ? `Episode ready (${clock(episode.durationSec)}, ${episode.chapters.length} chapters)`
            : 'The episode could not be mixed. The speaker tracks are still here.'}
        </div>
        <div className="hh-podcast__actions">
          {phase === 'ready' && onAudioHandoff && (
            <button type="button" className="hh-btn hh-btn--small hh-btn--primary" onClick={() => void handOff(episode)} disabled={busy}>
              {busy ? 'Fetching…' : '⬆ Publish episode'}
            </button>
          )}
          {episode.mixUrl && <a className="hh-btn hh-btn--small hh-btn--secondary" href={abs(episode.mixUrl)} download>⬇ Episode</a>}
          {episode.tracks.map((t, i) => (
            <a key={`${t.url}-${i}`} className="hh-btn hh-btn--small hh-btn--secondary" href={abs(t.url)} download title={`Starts at ${clock(t.offsetSec)}`}>
              ⬇ @{t.identity}
            </a>
          ))}
          <button type="button" className="hh-btn hh-btn--small hh-btn--secondary" onClick={() => { setPhase('idle'); setEpisode(null); }}>Dismiss</button>
        </div>
        {error && <span className="hh-podcast__error" role="alert">{error}</span>}
      </div>
    );
  }

  return (
    <div className="hh-podcast">
      <button
        type="button"
        className="hh-btn hh-btn--small hh-btn--secondary"
        onClick={() => void start()}
        disabled={busy || !token}
        title="Record this show as a podcast episode: one track per speaker, chapters from who joins the stage"
      >
        🎙 Record as podcast
      </button>
      {error && <span className="hh-podcast__error" role="alert">{error}</span>}
    </div>
  );
}
