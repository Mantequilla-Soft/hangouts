import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/docs/',
  // The pages are the repo's own Markdown in ../docs (imported with ?raw).
  server: { fs: { allow: ['..'] } },
});
