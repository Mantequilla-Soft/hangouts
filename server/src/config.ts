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
  PORT: z.coerce.number().default(3002),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
