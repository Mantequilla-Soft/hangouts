import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  LIVEKIT_HOST: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  HIVE_API_NODE: z.string().url().default('https://api.hive.blog'),
  AUDIO_API_URL: z.string().url().default('https://audio.3speak.tv'),
  AUDIO_API_KEY: z.string().default(''),
  EMBED_UPLOAD_URL: z.string().url().default('https://embed.3speak.tv/uploads'),
  EMBED_API_URL: z.string().url().default('https://embed.3speak.tv/api'),
  EMBED_API_KEY: z.string().default(''),
  // Long-form video upload service (general /studio uploads — NOT shorts).
  VIDEO_UPLOAD_URL: z.string().url().default('https://video.3speak.tv'),
  VIDEO_UPLOAD_TOKEN: z.string().default(''),
  // 3Speak checker — receives live-stream leaderboard stats (peak/total viewers,
  // duration, boosts) via its secret-gated /stream-stats/* endpoints. Fail-safe:
  // empty STREAM_STATS_SECRET ⇒ reporting is disabled (never blocks a stream).
  CHECKER_URL: z.string().url().default('https://checker.3speak.tv'),
  STREAM_STATS_SECRET: z.string().default(''),
  STUDIO_FRONTEND_URL: z.string().url().default('https://3speak.tv'),
  MONGODB_URI: z.string().default(''),
  /** Egress template for CONFERENCE recordings (the existing grid/speaker
   *  layouts). Unchanged — standalone streams use their own, below. */
  EGRESS_TEMPLATE_URL: z.string().default('https://hangout.3speak.tv/egress-template'),
  /** Egress template for STANDALONE streams: a chrome-free full-bleed render of
   *  the broadcaster's program track, served by the 3Speak frontend. Separate
   *  because the conference template lives on a deployment we don't control. */
  EGRESS_STANDALONE_TEMPLATE_URL: z.string().default('https://3speak.tv/egress-stream'),
  BOOSTS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // DVR: a segmented-HLS egress that records a rolling buffer so a Pro host can
  // clip the last ~30s. Runs a second egress per stream, so it's a kill-switch.
  DVR_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Admin secret for the manual /boosts/ingest reconciliation endpoint. That
  // endpoint drives REAL payouts from a caller-supplied amount and has no
  // on-chain re-verification, so it must never be reachable unauthenticated.
  // Fail-closed: empty ⇒ the endpoint is disabled entirely (the on-chain poller
  // is the production path; nothing else legitimately calls ingest).
  BOOST_INGEST_KEY: z.string().default(''),
  BOOST_PLATFORM_ACCOUNT: z.string().default(''),
  BOOST_PLATFORM_ACTIVE_KEY: z.string().default(''),
  // Channel points log on Hive (custom_json 3speak_points, lib/pointsLedger.ts).
  // Signed with this account's posting key; without one, the boost wallet's
  // active key when it is the same account; without either, nothing is logged
  // (the rows wait in Mongo until a key is set).
  POINTS_LOG_ACCOUNT: z.string().default('threespeak-pro'),
  POINTS_LOG_POSTING_KEY: z.string().default(''),
  BOOST_PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(5),
  BOOST_HIVE_USD_FALLBACK: z.coerce.number().positive().default(0.25),
  BOOST_HIVE_USD_CACHE_MS: z.coerce.number().int().positive().default(120000),
  // Public WHIP endpoint for OBS ingest (nginx → livekit/ingress). The stream
  // key is appended as a path segment: `${INGRESS_WHIP_URL}/<streamKey>`.
  INGRESS_WHIP_URL: z.string().url().default('https://livekit.okinoko.io/w'),
  // --- Headless OBS streams (stream templates) -------------------------------
  // Public WHIP base OBS is pointed at: `${PUBLIC_WHIP_BASE}/<owner>/<slug>`.
  // This server proxies the WHIP signalling (so the LiveKit stream key never
  // leaves the box); media flows OBS ↔ ingress directly over UDP.
  PUBLIC_WHIP_BASE: z.string().url().default('https://hangouts.okinoko.io/whip'),
  // Where the ingress's own WHIP handler listens (loopback, no TLS).
  INGRESS_WHIP_INTERNAL_URL: z.string().url().default('http://127.0.0.1:8086/w'),
  // 3Speak API that posts the Hive announcement for a headless stream
  // (POST /api/openpods/announce, gated by OPENPODS_ANNOUNCE_SECRET).
  ANNOUNCE_API_URL: z.string().url().default('http://127.0.0.1:4021'),
  OPENPODS_ANNOUNCE_SECRET: z.string().default(''),
  // Keys the per-user streaming secret's lookup hash + at-rest encryption.
  // Empty ⇒ derived from SESSION_SECRET. Changing whichever one is in use
  // invalidates every stored streaming secret (users must reset theirs).
  STREAM_KEY_SECRET: z.string().default(''),
  // Free one-per-lifetime Pro trial (POST /premium/start-testing). This is what
  // makes the locked perks actionable — without it a non-premium user sees
  // padlocks and no way through — so it defaults ON. Clients discover the
  // setting from GET /premium/:username (`testing_available`) rather than
  // carrying their own flag, so switching it off here also hides the button.
  PRO_TESTING_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  PRO_TESTING_HOURS: z.coerce.number().positive().default(24),
  // Hive accounts (comma-separated, no @) that skip the free one-stream-a-day
  // limit WITHOUT being Pro: the 30-minute free cap and the Pro-only features
  // still apply. Empty = nobody is exempt.
  STREAM_LIMIT_EXEMPT: z.string().default('')
    .transform((v) => new Set(v.split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))),
  // --- Highlights, clips, rewind, podcast recording (H13, H14, H23) ----------
  // How far back the DVR keeps segments: the range a highlight clip can come
  // from and, with REWIND_ENABLED, the rewind window viewers can seek in. About
  // 56 MB per stream at the DVR's 3 Mbps for the default 150 s (600 s, the
  // rewind window we built for, is about 225 MB), pruned every 30 s.
  DVR_BUFFER_SEC: z.coerce.number().int().min(60).max(3600).default(150),
  // Rewind during a live stream (H14): off until the owner turns it on (then
  // set DVR_BUFFER_SEC=600 too for a 10 minute window).
  REWIND_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // DVR clips (viewer, host and automatic highlight clips) are kept this long so
  // they can still be posted as Shorts after the stream, then swept.
  CLIP_KEEP_HOURS: z.coerce.number().positive().max(24 * 14).default(48),
  // Upper bound for all kept clips on disk; the oldest go first past it.
  CLIPS_DIR_MAX_MB: z.coerce.number().int().positive().default(4096),
  // Tell the 3Speak checker when a stream's clips are ready (bell + push that
  // open 3speak.tv/clips). Off until the frontend with the /clips page is live.
  CLIPS_NOTIFY_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Chat and boost spike detection (per-room counters in 20 s buckets).
  HIGHLIGHTS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // "Record as podcast" in audio rooms: one audio track egress per speaker.
  PODCAST_RECORDING_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // --- HLS for large audiences (backlog idea H1) ------------------------------
  // How many viewers of ONE stream watch over WebRTC before the rest get the
  // stream over HLS. Default 50, from the 2026-11-05 stress test (clean at 50
  // viewers, broken at 100): viewer 51 on gets HLS. 0 = every viewer on HLS.
  // Set it EMPTY (HLS_VIEWER_THRESHOLD=) to switch HLS off: every viewer on
  // WebRTC and the guest cap (MAX_GUESTS_PER_ROOM) refuses extra anonymous
  // viewers, as before. HLS viewers stay connected to the room for chat, boosts and the
  // viewer count, but receive no media from LiveKit (canSubscribe=false), so
  // they cost the SFU almost nothing. The HLS egress for a stream starts when
  // its first HLS viewer arrives and stops when the stream ends or nobody has
  // watched over HLS for a few minutes.
  HLS_VIEWER_THRESHOLD: z.string().default('50')
    .transform((v) => (v.trim() === '' ? null : Number(v.trim())))
    .pipe(z.number().int().min(0).nullable()),
  // Where players fetch the playlist and segments. Empty = this API's own
  // /rooms/:name/hls/* routes (relative URL, the client prefixes its API base).
  // Set it to a CDN pull zone whose origin is this API, e.g.
  // https://live-hls.b-cdn.net, so segments are served by the CDN.
  HLS_PUBLIC_BASE: z.string().default('').refine((v) => v === '' || /^https?:\/\//.test(v), 'must be an http(s) URL or empty'),
  // A WebRTC viewer whose connection stays poor may ask for HLS even below the
  // threshold. Only matters while HLS_VIEWER_THRESHOLD is set.
  HLS_WEAK_FALLBACK: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // OBS streams that go live straight from a template are forwarded as OBS
  // encodes them (H.264), not re-encoded to VP8: about 0.1 of a CPU core per
  // stream instead of one. A viewer whose browser can't show H.264 is moved to
  // HLS (SDK lib/undecodableVideo.ts), so this only takes effect while
  // HLS_VIEWER_THRESHOLD is set and HLS_WEAK_FALLBACK is on. 'false' = always
  // re-encode, as before.
  OBS_PASSTHROUGH: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Video bitrate of the HLS rendition in kbps (one rendition, 720p or the
  // stream's own size).
  HLS_VIDEO_BITRATE: z.coerce.number().int().min(300).max(8000).default(2000),
  // Live captions (H11): the host's browser streams its own mic to the speech
  // server and sends the text over the data channel; this server only hands out
  // caption slots, at most CAPTIONS_MAX_STREAMS at once, so the speech box never
  // carries more continuous recognitions from streams than that. A slot lapses
  // CAPTIONS_SLOT_TTL_SEC after the studio's last renewal (it renews every 30 s).
  // Off by default: the speech box (speech.okinoko.io) is the same machine as
  // live.3speak.tv and the Mongo primary; the owner turns it on with CAPTIONS_ENABLED=true.
  CAPTIONS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  CAPTIONS_MAX_STREAMS: z.coerce.number().int().min(0).max(100).default(3),
  CAPTIONS_SLOT_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(90),
  PORT: z.coerce.number().default(3002),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
