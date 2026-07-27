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
  EGRESS_STANDALONE_TEMPLATE_URL: z.string().default('https://preview.3speak.tv/egress-stream'),
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
  BOOST_PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(5),
  BOOST_HIVE_USD_FALLBACK: z.coerce.number().positive().default(0.25),
  BOOST_HIVE_USD_CACHE_MS: z.coerce.number().int().positive().default(120000),
  // Public WHIP endpoint for OBS ingest (nginx → livekit/ingress). The stream
  // key is appended as a path segment: `${INGRESS_WHIP_URL}/<streamKey>`.
  INGRESS_WHIP_URL: z.string().url().default('https://livekit.okinoko.io/w'),
  PORT: z.coerce.number().default(3002),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
