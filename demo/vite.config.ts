import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Served behind nginx at https://hangouts.okinoko.io/egress-template/ —
  // Vite must emit asset URLs prefixed with this so the egress browser can
  // load them. Without this, /assets/* 404s and the template never renders,
  // which surfaces as "Start signal not received" in the egress logs.
  base: '/egress-template/',
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
