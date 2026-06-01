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
  STUDIO_FRONTEND_URL: z.string().url().default('https://3speak.tv'),
  MONGODB_URI: z.string().default(''),
  BOOSTS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  BOOST_PLATFORM_ACCOUNT: z.string().default(''),
  BOOST_PLATFORM_ACTIVE_KEY: z.string().default(''),
  BOOST_PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(5),
  BOOST_HIVE_USD_FALLBACK: z.coerce.number().positive().default(0.25),
  BOOST_HIVE_USD_CACHE_MS: z.coerce.number().int().positive().default(120000),
  PORT: z.coerce.number().default(3002),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
