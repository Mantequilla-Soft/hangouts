import { createRoot } from 'react-dom/client';
import App from './App.js';
import './App.css';

// Note: NO StrictMode wrapping. The same render tree is used to host the
// /egress-template page that LiveKit's headless Chromium loads, and
// StrictMode's intentional double-mount in dev mode tears down the
// LiveKitRoom briefly — which fires `Disconnected`, which (via
// EgressHelper.setRoom) auto-calls endRecording, which aborts the egress
// before any video frames are written.
createRoot(document.getElementById('root')!).render(<App />);
