import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    env: {
      LIVEKIT_HOST: 'https://livekit.test',
      LIVEKIT_API_KEY: 'test-key',
      LIVEKIT_API_SECRET: 'test-secret',
      SESSION_SECRET: 'test-session-secret-at-least-32chars!!',
    },
  },
});
