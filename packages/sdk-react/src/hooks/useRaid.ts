import { useCallback, useContext, useEffect, useState } from 'react';
import { useDataChannel } from '@livekit/components-react';
import { HangoutsContext } from '../context/HangoutsContext.js';
import { readRaidPacket, type DataSender } from '../lib/dataTrust.js';

/** Where a raid goes. */
export interface RaidTargetInfo {
  roomName: string;
  host: string;
  title: string;
}

/** A raid counting down in this room, as a viewer sees it. */
export interface ViewerRaid {
  id: string;
  from: string;
  target: RaidTargetInfo;
  viewers: number;
  /** Local clock time the countdown reaches zero. */
  endsAtLocal: number;
  /** The server said go (the countdown ran out there). */
  go: boolean;
}

/** A raid from the server (data message or GET), checked for shape. */
export function parseRaid(raw: unknown, now = Date.now()): Omit<ViewerRaid, 'go'> | null {
  const r = raw as { id?: unknown; from?: unknown; target?: Partial<RaidTargetInfo>; viewers?: unknown; endsInMs?: unknown; endsAt?: unknown };
  if (!r || typeof r.id !== 'string' || typeof r.from !== 'string') return null;
  const t = r.target;
  if (!t || typeof t.roomName !== 'string' || typeof t.host !== 'string') return null;
  const inMs = typeof r.endsInMs === 'number' ? r.endsInMs
    : typeof r.endsAt === 'number' ? r.endsAt - now : 0;
  return {
    id: r.id,
    from: r.from,
    target: { roomName: t.roomName, host: t.host, title: typeof t.title === 'string' && t.title ? t.title : t.roomName },
    viewers: Number(r.viewers) || 0,
    endsAtLocal: now + Math.max(0, inMs),
  };
}

/**
 * The raid counting down in `roomName`, if any: from the `raid` data topic
 * (start, go, cancel) and, for a viewer who arrives mid-countdown, one GET.
 */
export function useRaid(roomName: string) {
  const ctx = useContext(HangoutsContext);
  const apiBaseUrl = ctx?.apiBaseUrl;
  const [raid, setRaid] = useState<ViewerRaid | null>(null);

  useEffect(() => {
    if (!roomName || !apiBaseUrl) return undefined;
    let alive = true;
    fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/raid`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const r = parseRaid(body?.raid);
        if (alive && r) setRaid((cur) => cur ?? { ...r, go: false });
      })
      .catch(() => { /* an older server: the data message still arrives */ });
    return () => { alive = false; };
  }, [roomName, apiBaseUrl]);

  // Server only: raid-go sends every viewer to the target room, so a packet a
  // participant published (a fake raid to a page of their choosing) is dropped.
  const onMessage = useCallback((msg: { payload: Uint8Array; from?: DataSender }) => {
    const packet = readRaidPacket(msg.payload, msg.from);
    const r = packet ? parseRaid(packet.raid) : null;
    if (!packet || !r) return;
    if (packet.type === 'raid-start') setRaid({ ...r, go: false });
    else if (packet.type === 'raid-go') setRaid((cur) => ({ ...(cur && cur.id === r.id ? cur : r), go: true }));
    else setRaid((cur) => (cur && cur.id === r.id ? null : cur));
  }, []);
  useDataChannel('raid', onMessage);

  const clear = useCallback(() => setRaid(null), []);
  return { raid, clear };
}
