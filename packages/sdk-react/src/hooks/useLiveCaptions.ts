import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataChannel, useRoomInfo } from '@livekit/components-react';
import { readCaptionPacket, type DataSender } from '../lib/dataTrust.js';
import {
  CAPTIONS_TOPIC,
  applyCaption,
  pruneCaptions,
  type CaptionLine,
} from '../lib/liveCaptions.js';

export interface LiveCaptionsState {
  /** The host has captions running (room metadata), or lines are arriving. */
  available: boolean;
  /** The captions' language (speech model code, e.g. `en-us`). */
  lang: string;
  /** What is on screen now: the current line and the one before. */
  lines: CaptionLine[];
}

/**
 * Viewer side of live captions: the lines the host's studio sends on the data
 * channel, from the HOST only (anyone else in the room could publish on the
 * topic). Must be inside the stream's LiveKit room (<StandaloneWatch>).
 */
export function useLiveCaptions(): LiveCaptionsState {
  const info = useRoomInfo();
  const meta = useMemo((): { host?: string; captions?: { lang?: string } } => {
    try { return info.metadata ? JSON.parse(info.metadata) : {}; } catch { return {}; }
  }, [info.metadata]);
  const hostRef = useRef<string | undefined>(meta.host);
  hostRef.current = meta.host;

  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [lastLang, setLastLang] = useState('');

  const onMessage = useCallback((msg: { payload: Uint8Array; from?: DataSender }) => {
    const cap = readCaptionPacket(msg.payload, msg.from, hostRef.current);
    if (!cap) return;
    setLastLang(cap.lang);
    setLines((l) => applyCaption(l, cap, Date.now()));
  }, []);
  useDataChannel(CAPTIONS_TOPIC, onMessage);

  // Lines fade out once the speaker goes quiet. A timer only while there are lines.
  const hasLines = lines.length > 0;
  useEffect(() => {
    if (!hasLines) return undefined;
    const t = setInterval(() => setLines((l) => pruneCaptions(l, Date.now())), 1000);
    return () => clearInterval(t);
  }, [hasLines]);

  // The host switched captions off: clear what is left.
  const flagged = !!meta.captions;
  useEffect(() => { if (!flagged) setLines([]); }, [flagged]);

  return {
    available: flagged || hasLines,
    lang: meta.captions?.lang || lastLang || 'en',
    lines,
  };
}
