import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // The same build serves both the main demo at `/` and the egress headless
  // page at `/egress-template/*` — routing is done client-side in App.tsx,
  // so assets stay at the root and load from either path.
  plugins: [react()],
  resolve: {
    // The SDK (file:../packages/sdk-react) has its own nested node_modules
    // copies from when the SDK was built standalone. Without dedupe, Vite
    // would bundle TWO instances of livekit-client + @livekit/components-react
    // — each with its own React context — and our <LiveKitRoom> (demo copy)
    // would set context A while SpeakerStage's hooks (SDK copy) read context
    // B and throw "No room provided".
    dedupe: ['react', 'react-dom', '@livekit/components-react', 'livekit-client'],
  },
});
