import { randomBytes, createHash } from 'node:crypto';
import {
  IngressClient, IngressInput, IngressVideoOptions, IngressAudioOptions,
  IngressVideoEncodingOptions, VideoCodec, TrackSource, type IngressInfo,
} from 'livekit-server-sdk';
import { IngressState_Status, TrackType, type ParticipantInfo, type TrackInfo } from '@livekit/protocol';
import { config } from '../config.js';
import { roomService } from './livekit.js';
import { mutateRoomMetadata } from './roomMeta.js';
import { createStreamRoom, closeStreamRoom, type RoomMetadata } from './streamRoom.js';
import { getUserStatus } from './users.js';
import { recordGoLive, FREE_STREAM_CAP_MS as FREE_CAP_MS } from './streamQuota.js';
import { getTemplateById, setTemplateLastLiveAt, type TemplateDoc } from './streamTemplates.js';
import { startStandaloneVod, stopStandaloneVod } from '../routes/recording.js';
import { startDvrSession, stopDvrSession } from '../routes/dvr.js';

/**
 * Headless OBS streams: go live from OBS alone, no browser studio.
 *
 * OBS speaks WHIP to /whip/<owner>/<slug> (routes/whip.ts). For each connect we
 * create the room from the owner's template, create a LiveKit WHIP ingress that
 * joins AS THE HOST (identity = owner, video "studio-program"/CAMERA, audio
 * "studio-mix"/MICROPHONE — exactly what a studio publishes, so the watch page,
 * /streams, the recorder and DVR need no headless special-casing), forward the
 * SDP to the ingress, and from then on this module plays the studio's part:
 * stamps go-live, starts VOD/DVR, posts the announcement, enforces the time cap
 * and tears everything down when OBS stops or vanishes.
 *
 * Only SIGNALLING passes through this server; media flows OBS ↔ ingress over
 * UDP. The LiveKit stream key never leaves the box: OBS gets our own session
 * URL (/whip/s/<token>) instead.
 *
 * State lives in this module (like every other live-session map in the
 * server). RESTART WEAKNESS: a restart loses the maps. reconcileHeadlessRooms()
 * (boot + every 10 min) re-adopts any headless room whose ingress is still
 * publishing — same session URL, since the room metadata carries the token's
 * hash — and tears down the rest. What it CANNOT re-adopt is a running VOD /
 * DVR egress (those maps live in recording.ts / dvr.ts, same as for studio
 * streams): such a stream ends without its VOD being published.
 */

const ingressClient = new IngressClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

/** Poll cadence. No LiveKit webhook is wired, so ingress state is polled. */
const POLL_MS = 2500;
/** OBS connected (or tried) but nothing was ever published. */
const NEVER_PUBLISHED_MS = 60_000;
/** Live, then the ingress stopped publishing (OBS crash, network): give up after this. */
const LOST_GRACE_MS = 20_000;
/** BUFFERING is the ingress waiting on media — usually transient, so longer. */
const BUFFERING_GRACE_MS = 60_000;
/** How often a live session re-asserts `broadcasting` (the studio's 15s heartbeat). */
const META_CHECK_MS = 15_000;
/**
 * After a stream hits its time cap, refuse new connects for this owner for a
 * while. OBS reconnects automatically when its output drops, which would
 * otherwise turn the cap into a silent restart (and a fresh announcement post)
 * every hour.
 */
const CAP_COOLDOWN_MS = 15 * 60 * 1000;

/** Same caps the studio enforces (packages/sdk-react/src/lib/streamLimits.ts). */
export const FREE_STREAM_CAP_MS = FREE_CAP_MS;
export const PRO_STREAM_CAP_MS = 4 * 60 * 60 * 1000;
export function streamCapMs(premium: boolean): number {
  return premium ? PRO_STREAM_CAP_MS : FREE_STREAM_CAP_MS;
}

export type HeadlessState = 'connecting' | 'live' | 'ending';

export interface IngressSummary {
  status: string;
  width: number;
  height: number;
  bitrate: number;
  fps: number;
}

interface Session {
  /** sha256 of the session token — the token itself only exists in OBS. */
  key: string;
  templateId: string;
  template: TemplateDoc;
  owner: string;
  roomName: string;
  ingressId: string;
  /** Absolute internal URL of the ingress WHIP resource (contains the LK key). */
  resourceUrl: string | null;
  premium: boolean;
  capMs: number;
  createdAt: number;
  liveAt: number | null;
  state: HeadlessState;
  publishingSince: number | null;
  notPublishingSince: number | null;
  lastMetaCheck: number;
  ingress: IngressSummary | null;
  /** Published video size (top simulcast layer), sampled from the room. */
  video: { width: number; height: number } | null;
  announced: { ok: boolean; reason?: string } | null;
  ending?: Promise<void>;
}

const sessions = new Map<string, Session>();
/** templateId → session key, or RESERVED while a connect is being set up. */
const byTemplate = new Map<string, string>();
const RESERVED = '__reserved__';
const capCooldown = new Map<string, number>();
/**
 * templateId → why its last session ended. A session we gave up on can leave
 * OBS still "streaming" (the ingress keeps its side of the connection), so the
 * UI uses this to tell the streamer to stop and restart OBS.
 */
const lastEnds = new Map<string, { reason: string; at: number }>();
/** How long the status endpoint keeps reporting the last end. */
const LAST_END_TTL_MS = 15 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

const log = {
  info: (msg: string, detail?: Record<string, unknown>) => console.log(`[Headless] ${msg}`, detail ? JSON.stringify(detail) : ''),
  warn: (obj: unknown, msg?: string) => console.warn(`[Headless] ${msg ?? ''}`, obj),
};

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Identity for the HOST watching their own headless stream. The ingress holds
 * `host` in the room; a second connection with that identity would make
 * LiveKit kick the ingress (DUPLICATE_IDENTITY) and end the stream.
 */
export function headlessViewerIdentity(host: string): string {
  return `${host}~watch`;
}

function statusName(s: IngressState_Status | undefined): string {
  switch (s) {
    case IngressState_Status.ENDPOINT_INACTIVE: return 'inactive';
    case IngressState_Status.ENDPOINT_BUFFERING: return 'buffering';
    case IngressState_Status.ENDPOINT_PUBLISHING: return 'publishing';
    case IngressState_Status.ENDPOINT_ERROR: return 'error';
    case IngressState_Status.ENDPOINT_COMPLETE: return 'complete';
    default: return 'unknown';
  }
}

/**
 * The ingress's own input stats. Its WHIP handler leaves `state.video` at 0
 * (observed on ingress v1.5 — only RTMP fills it), so width/height fall back
 * to the published track's top layer, which the session samples.
 */
function summarize(info: IngressInfo, track?: { width: number; height: number } | null): IngressSummary {
  const v = info.state?.video;
  return {
    status: statusName(info.state?.status),
    width: v?.width || track?.width || 0,
    height: v?.height || track?.height || 0,
    bitrate: v?.averageBitrate ?? 0,
    fps: v?.framerate ?? 0,
  };
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, POLL_MS);
  timer.unref?.();
}

/** Largest simulcast layer of a video track (TrackInfo.width can be a lower one). */
function topLayer(t: TrackInfo): { width: number; height: number } {
  let width = t.width;
  let height = t.height;
  for (const l of t.layers ?? []) {
    if (l.width * l.height > width * height) { width = l.width; height = l.height; }
  }
  return { width, height };
}

// ── public queries ───────────────────────────────────────────────────────────

/** True while a template has any session (connecting, live or ending). */
export function isTemplateBusy(templateId: string): boolean {
  return byTemplate.has(templateId);
}

export function getHeadlessStatus(templateId: string): {
  state: HeadlessState; room: string | null; startedAt: number | null;
  ingress: IngressSummary | null; announced: { ok: boolean; reason?: string } | null;
} | null {
  const key = byTemplate.get(templateId);
  if (!key) return null;
  const s = sessions.get(key);
  // Reserved: OBS is mid-connect, the room isn't there yet.
  if (!s) return { state: 'connecting', room: null, startedAt: null, ingress: null, announced: null };
  return {
    state: s.state,
    room: s.roomName,
    startedAt: s.liveAt ?? s.createdAt,
    ingress: s.ingress,
    announced: s.announced,
  };
}

/** Record why a connect for this template was REFUSED, so its card can say so
 *  (OBS itself only shows a generic connection error). */
export function noteHeadlessRefusal(templateId: string, reason: string): void {
  lastEnds.set(templateId, { reason, at: Date.now() });
}

/** Why the template's last session ended, if that was recent. */
export function getLastHeadlessEnd(templateId: string): { reason: string; at: number } | null {
  const end = lastEnds.get(templateId);
  if (!end) return null;
  if (Date.now() - end.at > LAST_END_TTL_MS) { lastEnds.delete(templateId); return null; }
  return end;
}

/** ms left on the owner's post-cap cooldown (0 = may connect). */
export function capCooldownRemaining(owner: string): number {
  const until = capCooldown.get(owner);
  if (!until) return 0;
  const left = until - Date.now();
  if (left <= 0) { capCooldown.delete(owner); return 0; }
  return left;
}

// ── connect ──────────────────────────────────────────────────────────────────

export type StartResult =
  | { ok: true; status: number; answer: string; headers: Record<string, string>; sessionToken: string }
  | { ok: false; status: number; error: string; message: string };

/** Headers from the ingress's WHIP answer that the client needs as-is. */
const PASS_HEADERS = ['content-type', 'etag', 'link', 'accept-patch'];

/**
 * Bring up a headless stream for an (already authenticated) template and
 * answer OBS's SDP offer. On any failure, everything created so far is torn
 * down again — a failed connect must not leave a room or ingress behind.
 */
export async function startHeadlessStream(template: TemplateDoc, offerSdp: string): Promise<StartResult> {
  const templateId = template._id.toHexString();
  const owner = template.owner;

  // Check-and-reserve with no await in between: two simultaneous connects for
  // one template (OBS retrying fast) must not both get a room.
  if (byTemplate.has(templateId)) {
    return { ok: false, status: 409, error: 'already_live', message: 'This template is already streaming' };
  }
  byTemplate.set(templateId, RESERVED);
  lastEnds.delete(templateId);

  let roomName: string | null = null;
  let ingressId: string | null = null;
  const release = async () => {
    if (ingressId) await ingressClient.deleteIngress(ingressId).catch(() => { /* already gone */ });
    if (roomName) await closeStreamRoom(roomName).catch(() => { /* already gone */ });
    if (byTemplate.get(templateId) === RESERVED) byTemplate.delete(templateId);
  };

  try {
    const { premium } = await getUserStatus(owner);
    const token = randomBytes(24).toString('base64url');
    const key = hashSessionToken(token);

    let origin: string | undefined;
    try { origin = new URL(config.STUDIO_FRONTEND_URL).hostname; } catch { /* none */ }

    const room = await createStreamRoom({
      host: owner,
      title: template.title,
      description: template.description || undefined,
      backgroundImage: template.thumbnail || undefined,
      visibility: template.visibility,
      language: template.language || undefined,
      mode: 'standalone',
      tags: template.tags,
      boost: template.boost,
      origin,
      extra: {
        headless: true,
        templateId,
        watermark: !premium,
        whipSession: key,
      },
    });
    roomName = room.name;

    const info = await ingressClient.createIngress(IngressInput.WHIP_INPUT, {
      name: `headless-${roomName}`,
      roomName,
      // AS the host — see the module comment.
      participantIdentity: owner,
      participantName: owner,
      // Transcode to VP8: H.264 passthrough leaves viewers without H.264
      // decode (many Firefox builds) on a black screen.
      enableTranscoding: true,
      video: new IngressVideoOptions({
        name: 'studio-program',
        source: TrackSource.CAMERA,
        encodingOptions: {
          case: 'options',
          value: new IngressVideoEncodingOptions({
            videoCodec: VideoCodec.VP8,
            frameRate: 30,
            // No explicit layers: pinning them made the pipeline fail to
            // start ("source encoder not ready") — see POST /rooms/:name/ingress.
          }),
        },
      }),
      // The watch page plays ONLY microphone tracks named studio-mix.
      audio: new IngressAudioOptions({ name: 'studio-mix', source: TrackSource.MICROPHONE }),
    });
    ingressId = info.ingressId;

    const base = config.INGRESS_WHIP_INTERNAL_URL.replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/${encodeURIComponent(info.streamKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offerSdp,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      log.warn(err, 'ingress WHIP POST failed');
      await release();
      return { ok: false, status: 502, error: 'ingress_unreachable', message: 'The ingest server did not answer' };
    }
    const answer = await res.text();
    if (!res.ok) {
      log.warn({ status: res.status, room: roomName }, 'ingress rejected the offer');
      await release();
      // A 4xx is the client's offer (bad SDP etc.) — say so; 5xx is ours.
      return res.status >= 400 && res.status < 500
        ? { ok: false, status: res.status, error: 'offer_rejected', message: answer.slice(0, 300) || 'Offer rejected' }
        : { ok: false, status: 502, error: 'ingress_error', message: 'The ingest server failed' };
    }

    const loc = res.headers.get('location');
    let resourceUrl: string | null = null;
    if (loc) { try { resourceUrl = new URL(loc, `${base}/`).toString(); } catch { /* keep null */ } }

    const headers: Record<string, string> = {};
    for (const h of PASS_HEADERS) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }

    const capMs = streamCapMs(premium);
    const session: Session = {
      key, templateId, template, owner, roomName, ingressId, resourceUrl, premium, capMs,
      createdAt: Date.now(), liveAt: null, state: 'connecting',
      publishingSince: null, notPublishingSince: null, lastMetaCheck: 0,
      ingress: summarize(info), video: null, announced: null,
    };
    sessions.set(key, session);
    byTemplate.set(templateId, key);
    ensureTimer();
    log.info('session started', { room: roomName, owner, template: templateId, premium });
    return { ok: true, status: res.status === 200 ? 201 : res.status, answer, headers, sessionToken: token };
  } catch (err) {
    log.warn(err, 'headless start failed');
    await release();
    return { ok: false, status: 503, error: 'start_failed', message: 'Could not start the stream' };
  }
}

// ── WHIP session operations ──────────────────────────────────────────────────

export function getSessionByToken(token: string): Session | null {
  return sessions.get(hashSessionToken(token)) ?? null;
}

/** Forward a WHIP PATCH (trickle ICE / ICE restart) to the ingress resource. */
export async function forwardWhipPatch(
  token: string, body: string, contentType: string, ifMatch: string | undefined,
): Promise<{ status: number; body: string; headers: Record<string, string> } | null> {
  const s = getSessionByToken(token);
  if (!s || s.state === 'ending' || !s.resourceUrl) return null;
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (ifMatch) headers['If-Match'] = ifMatch;
  const res = await fetch(s.resourceUrl, {
    method: 'PATCH', headers, body, signal: AbortSignal.timeout(10_000),
  });
  const out: Record<string, string> = {};
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h);
    if (v) out[h] = v;
  }
  return { status: res.status, body: await res.text(), headers: out };
}

/** WHIP DELETE: OBS pressed Stop. Ends the stream completely. */
export async function endWhipSession(token: string): Promise<boolean> {
  const s = getSessionByToken(token);
  if (!s) return false;
  // Tell the ingress first so it closes the peer connection cleanly.
  if (s.resourceUrl) {
    await fetch(s.resourceUrl, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => { /* deleting the ingress ends it anyway */ });
  }
  await teardown(s, 'whip_delete');
  return true;
}

/** DELETE /rooms/:name on a headless room, or any other external stop. */
export async function endHeadlessStreamForRoom(roomName: string, reason: string): Promise<void> {
  for (const s of sessions.values()) {
    if (s.roomName === roomName) { await teardown(s, reason); return; }
  }
  // Not ours (e.g. after a restart, before reconcile): clean up by name.
  await cleanupOrphan(roomName);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const s of [...sessions.values()]) {
      try { await checkSession(s); } catch (err) { log.warn(err, `check failed for ${s.roomName}`); }
    }
  } finally {
    ticking = false;
    if (sessions.size === 0 && timer) { clearInterval(timer); timer = null; }
  }
}

async function checkSession(s: Session): Promise<void> {
  if (s.state === 'ending') return;
  const now = Date.now();

  let info: IngressInfo | undefined;
  try {
    info = (await ingressClient.listIngress({ ingressId: s.ingressId }))[0];
  } catch {
    return; // LiveKit unreachable this tick — don't count it against the stream
  }
  const status = info?.state?.status;
  s.ingress = info ? summarize(info, s.video) : null;

  if (s.state === 'connecting') {
    if (status === IngressState_Status.ENDPOINT_PUBLISHING) {
      s.publishingSince ??= now;
      // Go live once the host participant actually has a VIDEO track (what
      // viewers and the recorder need) — or any track after a few seconds,
      // so an audio-only OBS scene still goes live.
      const parts = await roomService.listParticipants(s.roomName).catch(() => [] as ParticipantInfo[]);
      const me = parts.find((p) => p.identity === s.owner);
      const video = me?.tracks.find((t) => t.type === TrackType.VIDEO);
      if (video || (me && me.tracks.length > 0 && now - s.publishingSince > 5000)) {
        await goLive(s, video, info!);
        return;
      }
    }
    if (status === IngressState_Status.ENDPOINT_ERROR || status === IngressState_Status.ENDPOINT_COMPLETE || !info) {
      await teardown(s, info ? 'ingress_failed' : 'ingress_gone');
      return;
    }
    if (now - s.createdAt > NEVER_PUBLISHED_MS) {
      // OBS connected but no track reached the room. With the LiveKit ingress
      // relay deadlock, OBS stays connected to the dead session until the
      // streamer restarts it (and the ingress leaks the session).
      log.warn({ room: s.roomName, ingressStatus: statusName(status) }, 'no track published within 60s');
      await teardown(s, 'never_published');
    }
    return;
  }

  // live
  if (s.liveAt && now - s.liveAt >= s.capMs) {
    capCooldown.set(s.owner, now + CAP_COOLDOWN_MS);
    await teardown(s, 'cap_reached');
    return;
  }
  if (status === IngressState_Status.ENDPOINT_PUBLISHING) {
    s.notPublishingSince = null;
  } else {
    s.notPublishingSince ??= now;
    const grace = status === IngressState_Status.ENDPOINT_BUFFERING ? BUFFERING_GRACE_MS : LOST_GRACE_MS;
    if (now - s.notPublishingSince > grace) {
      await teardown(s, info ? `ingress_${statusName(status)}` : 'ingress_gone');
      return;
    }
  }

  // The studio's 15s heartbeat equivalent: re-assert `broadcasting` in case a
  // non-locked metadata writer clobbered it, and notice a room that was
  // deleted out from under us.
  if (now - s.lastMetaCheck >= META_CHECK_MS) {
    s.lastMetaCheck = now;
    const parts = await roomService.listParticipants(s.roomName).catch(() => null);
    const v = parts?.find((p) => p.identity === s.owner)?.tracks.find((t) => t.type === TrackType.VIDEO);
    if (v) s.video = topLayer(v);
    try {
      await mutateRoomMetadata(s.roomName, (m) => (m.broadcasting === true ? null : { ...m, broadcasting: true }));
    } catch (err) {
      if ((err as Error)?.message === 'Room not found') await teardown(s, 'room_gone');
    }
  }
}

/**
 * First real media: do what the studio does when the host hits Start — the
 * /live stamp, the broadcasting flag, the VOD + DVR egresses and the Hive
 * announcement. Extras are best-effort: none of them may stop the stream.
 */
async function goLive(s: Session, video: TrackInfo | undefined, info: IngressInfo): Promise<void> {
  s.state = 'live';
  s.liveAt = Date.now();
  s.lastMetaCheck = s.liveAt;
  if (video) s.video = topLayer(video);
  const w = s.video?.width || info.state?.video?.width || 0;
  const h = s.video?.height || info.state?.video?.height || 0;
  s.ingress = summarize(info, s.video);
  const portrait = h > w;
  const tpl = s.template;

  // Free hosts publish their recording too (owner, 2026-10-21): it can be no
  // longer than the stream, which this session already caps at 30 minutes, and
  // startStandaloneVod stops it there as well. Downloads and clips stay Pro.
  const vodAllowed = tpl.recording.publishVod;

  let meta: RoomMetadata;
  try {
    meta = await mutateRoomMetadata(s.roomName, (m) => ({
      ...m,
      // First go-live wins, same rule as PATCH /rooms/:name/live.
      liveAt: (typeof m.liveAt === 'string' && m.liveAt) || new Date(s.liveAt!).toISOString(),
      willPublishVod: vodAllowed,
      portrait,
      broadcasting: true,
    })) as unknown as RoomMetadata;
  } catch (err) {
    log.warn(err, `go-live stamp failed for ${s.roomName}`);
    if ((err as Error)?.message === 'Room not found') await teardown(s, 'room_gone');
    return;
  }
  const stamped = Date.parse(meta.liveAt ?? '');
  if (Number.isFinite(stamped)) s.liveAt = stamped;
  // Counts toward a free host's one stream a day (lib/streamQuota.ts).
  await recordGoLive(s.owner, s.roomName);
  log.info('live', { room: s.roomName, portrait, width: w, height: h, vod: vodAllowed });

  if (vodAllowed) {
    startStandaloneVod(s.roomName, meta as Parameters<typeof startStandaloneVod>[1], {
      publish: true, download: false, owner: s.owner,
      ...(s.premium ? {} : { maxMs: FREE_STREAM_CAP_MS }),
    }, log).catch((err) => log.warn(err, `VOD start failed for ${s.roomName}`));
  }
  if (tpl.recording.allowClips && s.premium && config.DVR_ENABLED) {
    startDvrSession(s.roomName, meta, log).catch((err) => log.warn(err, `DVR start failed for ${s.roomName}`));
  }
  if (tpl.announce.enabled) void announce(s, portrait);
}

async function announce(s: Session, portrait: boolean): Promise<void> {
  const tpl = s.template;
  // Same rule as the studio: an unlisted stream is link-only, never announced.
  if (tpl.visibility === 'unlisted') { s.announced = { ok: false, reason: 'unlisted' }; return; }
  if (!config.OPENPODS_ANNOUNCE_SECRET) { s.announced = { ok: false, reason: 'not_configured' }; return; }
  try {
    const res = await fetch(`${config.ANNOUNCE_API_URL.replace(/\/$/, '')}/api/openpods/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Announce-Secret': config.OPENPODS_ANNOUNCE_SECRET },
      body: JSON.stringify({
        host: s.owner,
        room: s.roomName,
        title: tpl.title,
        description: tpl.description,
        thumbnail: tpl.thumbnail,
        tags: tpl.tags,
        language: tpl.language,
        community: tpl.announce.community,
        communityTitle: tpl.announce.communityTitle,
        declineRewards: tpl.announce.declineRewards,
        rewardPowerup: tpl.announce.rewardPowerup,
        beneficiaries: tpl.announce.beneficiaries,
        portrait,
        premium: s.premium,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    let body: { ok?: boolean; reason?: string; permlink?: string } = {};
    try { body = await res.json() as typeof body; } catch { /* non-JSON */ }
    s.announced = body.ok === true
      ? { ok: true }
      : { ok: false, reason: typeof body.reason === 'string' ? body.reason.slice(0, 100) : `http_${res.status}` };
  } catch (err) {
    log.warn(err, `announce failed for ${s.roomName}`);
    s.announced = { ok: false, reason: 'unreachable' };
  }
  log.info('announce', { room: s.roomName, ok: s.announced.ok, reason: s.announced.reason });
}

/**
 * End a headless stream completely: VOD egress stopped (and published in the
 * background, same as /record/stop), DVR stopped, ingress deleted, room
 * deleted, session cleared, template's lastLiveAt stamped. Idempotent —
 * concurrent callers share one teardown.
 */
function teardown(s: Session, reason: string): Promise<void> {
  if (s.ending) return s.ending;
  s.state = 'ending';
  s.ending = (async () => {
    log.info('ending', { room: s.roomName, reason });
    // VOD first: stop egress while the tracks still exist so the file ends
    // cleanly, before the ingress/room go away.
    await stopStandaloneVod(s.roomName).catch((err) => log.warn(err, 'VOD stop failed'));
    await stopDvrSession(s.roomName).catch((err) => log.warn(err, 'DVR stop failed'));
    await ingressClient.deleteIngress(s.ingressId).catch(() => { /* already gone */ });
    await closeStreamRoom(s.roomName).catch(() => { /* already gone */ });
    sessions.delete(s.key);
    if (byTemplate.get(s.templateId) === s.key) {
      byTemplate.delete(s.templateId);
      lastEnds.set(s.templateId, { reason, at: Date.now() });
    }
    if (s.liveAt) await setTemplateLastLiveAt(s.templateId, new Date());
  })();
  return s.ending;
}

// ── restart reconcile ────────────────────────────────────────────────────────

async function cleanupOrphan(roomName: string): Promise<void> {
  try {
    const list = await ingressClient.listIngress({ roomName });
    await Promise.all(list.filter((i) => i.name.startsWith('headless-'))
      .map((i) => ingressClient.deleteIngress(i.ingressId).catch(() => undefined)));
  } catch { /* LiveKit down — the next reconcile retries */ }
  await stopStandaloneVod(roomName).catch(() => undefined);
  await stopDvrSession(roomName).catch(() => undefined);
  await closeStreamRoom(roomName).catch(() => undefined);
}

/**
 * Boot (and every 10 min): bring LiveKit and this module's maps back in line.
 *  - headless room whose ingress is still publishing/buffering → re-adopt it
 *    (cap, teardown and the WHIP session URL keep working);
 *  - headless room with no live ingress → tear it down;
 *  - `headless-*` ingress whose room is gone → delete it.
 */
export async function reconcileHeadlessRooms(): Promise<void> {
  let rooms;
  let ingresses: IngressInfo[];
  try {
    rooms = await roomService.listRooms();
    ingresses = await ingressClient.listIngress({});
  } catch (err) {
    log.warn(err, 'reconcile: LiveKit unavailable');
    return;
  }
  const roomNames = new Set(rooms.map((r) => r.name));
  const ours = new Set([...sessions.values()].map((s) => s.roomName));

  for (const r of rooms) {
    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(r.metadata || '{}'); } catch { continue; }
    if (!meta.headless || ours.has(r.name)) continue;
    // A connect in progress creates the room before its session exists.
    if (meta.templateId && byTemplate.get(meta.templateId) === RESERVED) continue;

    const ing = ingresses.find((i) => i.roomName === r.name && i.participantIdentity === meta.host);
    const st = ing?.state?.status;
    const alive = st === IngressState_Status.ENDPOINT_PUBLISHING || st === IngressState_Status.ENDPOINT_BUFFERING;
    let template: TemplateDoc | null = null;
    if (alive && meta.templateId) {
      try {
        template = await getTemplateById(meta.templateId);
      } catch (err) {
        // Mongo hiccup ≠ "template deleted": never kill a running stream over
        // it. Leave the room alone; the next reconcile tries again.
        log.warn(err, `reconcile: template lookup failed for ${r.name}, retrying later`);
        continue;
      }
    }

    if (!ing || !alive || !meta.whipSession || !meta.host || !template || byTemplate.has(template._id.toHexString())) {
      log.info('reconcile: tearing down orphaned headless room', { room: r.name });
      await cleanupOrphan(r.name);
      continue;
    }

    const { premium } = await getUserStatus(meta.host);
    const liveAt = meta.liveAt ? Date.parse(meta.liveAt) : NaN;
    const base = config.INGRESS_WHIP_INTERNAL_URL.replace(/\/$/, '');
    const session: Session = {
      key: meta.whipSession,
      templateId: template._id.toHexString(),
      template,
      owner: meta.host,
      roomName: r.name,
      ingressId: ing.ingressId,
      // The ingress's resource URL is /w/<streamKey>/<resourceId>.
      resourceUrl: ing.state?.resourceId ? `${base}/${encodeURIComponent(ing.streamKey)}/${ing.state.resourceId}` : null,
      premium,
      capMs: streamCapMs(premium),
      createdAt: Date.now(),
      liveAt: Number.isFinite(liveAt) ? liveAt : null,
      state: Number.isFinite(liveAt) ? 'live' : 'connecting',
      publishingSince: null,
      notPublishingSince: null,
      lastMetaCheck: 0,
      ingress: summarize(ing),
      video: null,
      announced: null,
    };
    sessions.set(session.key, session);
    byTemplate.set(session.templateId, session.key);
    ensureTimer();
    log.info('reconcile: re-adopted headless stream', { room: r.name, owner: meta.host });
  }

  for (const i of ingresses) {
    if (i.name.startsWith('headless-') && !roomNames.has(i.roomName) && !ours.has(i.roomName)) {
      await ingressClient.deleteIngress(i.ingressId).catch(() => undefined);
    }
  }
}

/** Test hook: drop all in-memory state. */
export function _resetHeadlessForTests(): void {
  sessions.clear();
  byTemplate.clear();
  capCooldown.clear();
  lastEnds.clear();
  if (timer) { clearInterval(timer); timer = null; }
}
