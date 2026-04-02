import { useState } from 'react';
import './styles.css';

type Section = 'getting-started' | 'authentication' | 'sdk-core' | 'sdk-react' | 'theming' | 'recording' | 'premium-and-bans' | 'api-reference' | 'integration-guides';

const NAV: { id: Section; label: string }[] = [
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'sdk-core', label: '@snapie/hangouts-core' },
  { id: 'sdk-react', label: '@snapie/hangouts-react' },
  { id: 'theming', label: 'Theming' },
  { id: 'recording', label: 'Recording' },
  { id: 'premium-and-bans', label: 'Premium & Bans' },
  { id: 'api-reference', label: 'API Reference' },
  { id: 'integration-guides', label: 'Integration Guides' },
];

export default function App() {
  const [active, setActive] = useState<Section>('getting-started');

  return (
    <div className="docs">
      <nav className="docs__nav">
        <div className="docs__logo">Hive Hangouts</div>
        <div className="docs__subtitle">Developer Docs</div>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`docs__nav-item ${active === item.id ? 'docs__nav-item--active' : ''}`}
            onClick={() => setActive(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="docs__nav-footer">
          <a href="https://github.com/Mantequilla-Soft/hangouts" target="_blank" rel="noopener">GitHub</a>
          <a href="https://www.npmjs.com/package/@snapie/hangouts-react" target="_blank" rel="noopener">npm</a>
        </div>
      </nav>
      <main className="docs__content">
        {active === 'getting-started' && <GettingStarted />}
        {active === 'authentication' && <Authentication />}
        {active === 'sdk-core' && <SdkCore />}
        {active === 'sdk-react' && <SdkReact />}
        {active === 'theming' && <Theming />}
        {active === 'recording' && <Recording />}
        {active === 'premium-and-bans' && <PremiumAndBans />}
        {active === 'api-reference' && <ApiReference />}
        {active === 'integration-guides' && <IntegrationGuides />}
      </main>
    </div>
  );
}

function Code({ children, lang }: { children: string; lang?: string }) {
  return <pre className="docs__code"><code>{children.trim()}</code></pre>;
}

function H1({ children }: { children: React.ReactNode }) {
  return <h1 className="docs__h1">{children}</h1>;
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="docs__h2">{children}</h2>;
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="docs__h3">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="docs__p">{children}</p>;
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <table className="docs__table">
      <thead>
        <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Sections ────────────────────────────────────────────

function GettingStarted() {
  return (
    <>
      <H1>Getting Started</H1>
      <P>
        Hive Hangouts is a Twitter Spaces-style audio room SDK for the Hive blockchain.
        It provides real-time audio rooms with chat, hand raising, speaker management,
        recording, and Hive Keychain authentication — all in a drop-in React component.
      </P>

      <H2>Architecture</H2>
      <Code>{`
React App  ──────────────── LiveKit SFU (audio server)
   │        WebRTC audio          │
   │        + signaling           │
   │                              │
   └──── Hangouts API ───────────┘
         (auth + tokens)    server SDK calls

Hive Blockchain ← signature verification
      `}</Code>
      <P>Three components work together:</P>
      <ul className="docs__list">
        <li><strong>LiveKit SFU</strong> — open-source WebRTC server handling real-time audio routing</li>
        <li><strong>Hangouts API</strong> — Fastify server for Hive auth, LiveKit token issuance, and moderation</li>
        <li><strong>Your App</strong> — uses the SDK to render rooms with audio, chat, and controls</li>
      </ul>

      <H2>Quick Start (5 minutes)</H2>
      <H3>1. Install</H3>
      <Code>{`npm install @snapie/hangouts-react @livekit/components-react livekit-client`}</Code>
      <P>Or with pnpm/yarn:</P>
      <Code>{`pnpm add @snapie/hangouts-react @livekit/components-react livekit-client`}</Code>

      <H3>2. Render a room</H3>
      <Code>{`
import { HangoutsProvider, HangoutsRoom } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

function App() {
  return (
    <HangoutsProvider
      apiBaseUrl="https://hangout-api.3speak.tv"
      livekitServerUrl="wss://livekit.3speak.tv"
    >
      <HangoutsRoom roomName="my-room-name" embedded />
    </HangoutsProvider>
  );
}
      `}</Code>

      <H3>3. Or render a lobby + room</H3>
      <Code>{`
import { useState } from 'react';
import { HangoutsProvider, RoomLobby, HangoutsRoom } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

function App() {
  const [room, setRoom] = useState<string | null>(null);

  return (
    <HangoutsProvider
      apiBaseUrl="https://hangout-api.3speak.tv"
      livekitServerUrl="wss://livekit.3speak.tv"
    >
      {room ? (
        <HangoutsRoom roomName={room} onLeave={() => setRoom(null)} embedded />
      ) : (
        <RoomLobby onJoinRoom={setRoom} />
      )}
    </HangoutsProvider>
  );
}
      `}</Code>
      <P>That's it. Users sign in with Hive Keychain, create or join rooms, and talk.</P>

      <H2>Packages</H2>
      <Table
        headers={['Package', 'Purpose', 'Use when']}
        rows={[
          ['@snapie/hangouts-core', 'API client, types, Keychain auth', 'React Native, non-React apps, or custom UI'],
          ['@snapie/hangouts-react', 'React hooks + UI components', 'React web apps (includes core)'],
        ]}
      />
    </>
  );
}

function Authentication() {
  return (
    <>
      <H1>Authentication</H1>
      <P>
        Hive Hangouts uses Hive Keychain for authentication. Users sign a challenge
        with their Hive posting key, and the server verifies the signature against
        the blockchain. No passwords, no accounts to create.
      </P>

      <H2>How it works</H2>
      <Code>{`
1. Client requests a challenge:
   POST /auth/challenge { username: "alice" }
   → { challenge: "hivehangouts:alice:1711...:a3f2", expires: ... }

2. User signs the challenge with Hive Keychain (browser popup):
   window.hive_keychain.requestSignBuffer("alice", challenge, "Posting")
   → signature

3. Client sends signature to server:
   POST /auth/verify { username: "alice", challenge, signature }
   → Server fetches posting key from Hive chain
   → Verifies signature matches on-chain key
   → Returns session JWT (24h TTL)

4. All subsequent API calls include:
   Authorization: Bearer <session-jwt>
      `}</Code>

      <H2>Using the SDK (web — automatic)</H2>
      <P>
        The SDK handles the entire flow. When a user interacts with a hangout
        component, the <code>RoomLobby</code> shows a login prompt with a
        username field and "Sign in" button. Clicking it triggers the Keychain popup.
      </P>
      <Code>{`
import { useHangoutsAuth } from '@snapie/hangouts-react';

function MyComponent() {
  const { username, isAuthenticated, login, logout, isLoading, error } = useHangoutsAuth();

  if (!isAuthenticated) {
    return <button onClick={() => login('alice')}>Sign in</button>;
  }

  return <p>Signed in as @{username} <button onClick={logout}>Logout</button></p>;
}
      `}</Code>

      <H2>Pre-existing session (React Native / custom auth)</H2>
      <P>
        If your app already has Hive auth (e.g., a React Native app with the posting
        key in SecureStore), you can authenticate with the Hangouts server silently
        using <code>@snapie/hangouts-core</code>:
      </P>
      <Code>{`
import { HangoutsApiClient } from '@snapie/hangouts-core';
import { PrivateKey } from '@hiveio/dhive';
import { sha256 } from 'js-sha256';

const client = new HangoutsApiClient({ baseUrl: 'https://hangout-api.3speak.tv' });

// 1. Get challenge
const { challenge } = await client.requestChallenge(username);

// 2. Sign with posting key (no Keychain needed)
const key = PrivateKey.fromString(postingKey);
const hash = Buffer.from(sha256.arrayBuffer(challenge));
const signature = key.sign(hash).toString();

// 3. Verify and get session
const session = await client.verifySignature(username, challenge, signature);
client.setSessionToken(session.token);

// Now use client.createRoom(), client.joinRoom(), etc.
      `}</Code>

      <H2>Passing a session token to the provider</H2>
      <P>
        If your app manages auth externally, pass the session token as a prop:
      </P>
      <Code>{`
<HangoutsProvider
  apiBaseUrl="https://hangout-api.3speak.tv"
  sessionToken={myExistingToken}
  username="alice"
>
  {children}
</HangoutsProvider>
      `}</Code>
    </>
  );
}

function SdkCore() {
  return (
    <>
      <H1>@snapie/hangouts-core</H1>
      <P>
        Framework-agnostic package. Zero runtime dependencies. Provides the API
        client, TypeScript types, and Hive Keychain auth helper. Use this when
        building React Native apps or custom non-React integrations.
      </P>

      <H2>HangoutsApiClient</H2>
      <Code>{`
import { HangoutsApiClient } from '@snapie/hangouts-core';

const client = new HangoutsApiClient({ baseUrl: 'https://hangout-api.3speak.tv' });
      `}</Code>

      <H3>Auth methods</H3>
      <Table
        headers={['Method', 'Returns', 'Description']}
        rows={[
          ['setSessionToken(token)', 'void', 'Set the Bearer token for all requests'],
          ['clearSessionToken()', 'void', 'Clear the stored token'],
          ['getSessionToken()', 'string | null', 'Get the current token'],
          ['requestChallenge(username)', 'Promise<{ challenge, expires }>', 'Get a nonce to sign'],
          ['verifySignature(username, challenge, signature)', 'Promise<{ token, username }>', 'Verify and get session JWT'],
        ]}
      />

      <H3>Room methods</H3>
      <Table
        headers={['Method', 'Returns', 'Description']}
        rows={[
          ['listRooms()', 'Promise<Room[]>', 'List all active rooms'],
          ['getRoom(roomName)', 'Promise<Room | null>', 'Get a single room (null if not found)'],
          ['createRoom(title, description?)', 'Promise<{ room, token }>', 'Create room, get host LiveKit token'],
          ['joinRoom(roomName)', 'Promise<{ token, roomName, identity, isHost }>', 'Join room, get listener LiveKit token'],
          ['deleteRoom(roomName)', 'Promise<void>', 'Close a room (host only)'],
        ]}
      />

      <H3>Participant methods</H3>
      <Table
        headers={['Method', 'Returns', 'Description']}
        rows={[
          ['setPermissions(room, identity, canPublish)', 'Promise<{ identity, canPublish }>', 'Promote/demote speaker (host only)'],
          ['kickParticipant(room, identity)', 'Promise<void>', 'Remove participant (host only)'],
        ]}
      />

      <H3>Recording methods</H3>
      <Table
        headers={['Method', 'Returns', 'Description']}
        rows={[
          ['startRecording(roomName)', 'Promise<{ egressId, status, filepath }>', 'Start recording (host only)'],
          ['stopRecording(roomName)', 'Promise<{ egressId, status, filePath, duration }>', 'Stop recording (host only)'],
          ['getRecordingStatus(roomName)', 'Promise<{ recording, egressId? }>', 'Check if room is being recorded'],
          ['uploadRecording(room, filePath, duration?, title?, tags?)', 'Promise<{ permlink, cid, playUrl }>', 'Upload to IPFS via audio.3speak.tv'],
        ]}
      />

      <H2>Types</H2>
      <Code>{`
interface Room {
  name: string;
  title: string;
  host: string;
  description?: string;
  numParticipants?: number;
  maxParticipants?: number;
  createdAt: string;
}

interface AuthSession {
  token: string;    // JWT session token
  username: string;
}

interface CreateRoomResponse {
  room: Room;
  token: string;    // LiveKit token
  isPremium?: boolean;  // true if user has premium video access
}

interface JoinRoomResponse {
  token: string;    // LiveKit token
  roomName: string;
  identity: string;
  isHost: boolean;
  isPremium?: boolean;  // true if user has premium video access
}

interface HandRaiseEvent {
  type: 'hand_raise';
  raised: boolean;
  identity: string;
  timestamp: number;
}

type ParticipantRole = 'host' | 'speaker' | 'listener';
      `}</Code>

      <H2>Keychain helpers (web only)</H2>
      <Code>{`
import { isKeychainAvailable, loginWithKeychain } from '@snapie/hangouts-core';

if (isKeychainAvailable()) {
  const session = await loginWithKeychain(client, 'alice');
  // session = { token, username }
  // client.setSessionToken() is called automatically
}
      `}</Code>
    </>
  );
}

function SdkReact() {
  return (
    <>
      <H1>@snapie/hangouts-react</H1>
      <P>
        React hooks and pre-built UI components. Wraps LiveKit's React SDK with
        a custom Spaces-like layout. Includes everything from <code>@snapie/hangouts-core</code>.
      </P>

      <H2>HangoutsProvider</H2>
      <P>Wrap your app (or hangout section) with this provider.</P>
      <Code>{`
<HangoutsProvider
  apiBaseUrl="https://hangout-api.3speak.tv"   // required
  livekitServerUrl="wss://livekit.3speak.tv"   // optional, this is the default
  sessionToken={token}                          // optional, for pre-authenticated users
  username="alice"                              // optional, used with sessionToken
>
  {children}
</HangoutsProvider>
      `}</Code>

      <H2>HangoutsRoom</H2>
      <P>The main component. Renders the full room experience.</P>
      <Code>{`
<HangoutsRoom
  roomName="my-room-name"      // required
  onLeave={() => {}}            // called when user leaves
  onError={(err) => {}}         // called on WebRTC errors
  embedded                      // removes min-height, fits in modals
  maxHeight="80vh"              // optional explicit height
  onRecordingUploaded={(result) => {
    // result = { permlink, cid, playUrl }
    // Redirect to your post composer
  }}
/>
      `}</Code>

      <H2>RoomLobby</H2>
      <P>Room list with login prompt, active rooms, and create room dialog.</P>
      <Code>{`
<RoomLobby
  onJoinRoom={(roomName) => setActiveRoom(roomName)}
  onRoomCreated={(room) => setActiveRoom(room.name)}
/>
      `}</Code>

      <H2>Hooks</H2>
      <Table
        headers={['Hook', 'Returns', 'Description']}
        rows={[
          ['useHangoutsAuth()', '{ username, isAuthenticated, login, logout, isLoading, error }', 'Auth state and actions'],
          ['useRoomList()', '{ rooms, isLoading, error, refresh }', 'Active rooms (polls every 10s)'],
          ['useHangoutsRoom()', '{ livekitToken, roomName, roomMeta, isHost, join, create, leave, endRoom }', 'Room join/create/leave'],
          ['useChat()', '{ messages, sendMessage }', 'In-room text chat via data channel'],
          ['useHandRaise()', '{ raisedHands, raiseHand, lowerHand, isRaised }', 'Hand raise via data channel'],
          ['useHostControls(roomName)', '{ promote, demote, kick, endRoom, pending }', 'Host moderation actions'],
          ['useRecording(roomName)', '{ isRecording, elapsed, startRecording, stopRecording, uploadRecording, ... }', 'Recording with timer'],
          ['useHiveAvatar(username, size?)', 'string (URL)', 'Hive profile picture URL'],
          ['getParticipantRole(participant, hostIdentity)', "'host' | 'speaker' | 'listener'", 'Derive role from permissions'],
        ]}
      />

      <H2>UI Components</H2>
      <P>All components use <code>.hh-</code> prefixed CSS classes. Import the stylesheet:</P>
      <Code>{`import '@snapie/hangouts-react/src/styles/hangouts.css';`}</Code>

      <H3>Room components</H3>
      <Table
        headers={['Component', 'Props', 'Description']}
        rows={[
          ['<SpeakerStage />', 'hostIdentity, isCurrentUserHost, roomName', 'Grid of speakers with speaking indicators'],
          ['<AudienceSection />', 'hostIdentity, isCurrentUserHost, roomName', 'Grid of listeners with hand-raise icons'],
          ['<RoomControls />', 'isHost, roomName, onLeave, onEndRoom?, onRecordingUploaded?', 'Bottom bar: mute, hand raise, record, leave'],
          ['<ParticipantTile />', 'participant, role, isHandRaised?, isCurrentUserHost?, roomName?', 'Avatar circle with speaking ring'],
          ['<RoomHeader />', 'title, host, roomName?', 'Title, host avatar, participant count, REC indicator'],
          ['<ChatPanel />', '(none)', 'Toggle-able chat with unread badge'],
          ['<RecordingControls />', 'roomName, onUploaded?', 'Record/stop/upload button (host only)'],
          ['<RecordingIndicator />', 'isRecording, elapsed?', 'Pulsing red REC badge with timer'],
          ['<HostControlsPanel />', 'identity, role, roomName, onClose, position?', 'Promote/demote/kick dropdown'],
          ['<HangoutsErrorBoundary />', 'onError?, children', 'Catches WebRTC crashes'],
        ]}
      />

      <H3>Lobby components</H3>
      <Table
        headers={['Component', 'Props', 'Description']}
        rows={[
          ['<RoomLobby />', 'onJoinRoom, onRoomCreated?', 'Full lobby: login, room list, create'],
          ['<RoomCard />', 'room, onJoin', 'Single room card with host avatar'],
          ['<CreateRoomDialog />', 'onCreated, onCancel?', 'Title + description form'],
        ]}
      />
    </>
  );
}

function Theming() {
  return (
    <>
      <H1>Theming</H1>
      <P>
        The SDK uses CSS custom properties (<code>--hh-*</code>) for all colors.
        It supports light and dark themes out of the box.
      </P>

      <H2>Auto-detect (default)</H2>
      <P>
        If you don't set anything, the SDK reads <code>prefers-color-scheme</code>
        from the system. Dark system = dark hangout UI.
      </P>

      <H2>Explicit theme</H2>
      <P>Set <code>data-hh-theme</code> on a parent element:</P>
      <Code>{`
<div data-hh-theme="dark">
  <HangoutsRoom roomName="..." embedded />
</div>
      `}</Code>

      <H2>Override individual colors</H2>
      <P>Map SDK variables to your app's design tokens:</P>
      <Code>{`
:root {
  --hh-bg: #1e1e2f;
  --hh-bg-secondary: #16213e;
  --hh-bg-hover: #1f2b47;
  --hh-text: #e0e0e0;
  --hh-text-secondary: #a0a0a0;
  --hh-text-muted: #888888;
  --hh-border: #2a2a4a;
  --hh-border-light: #2a2a4a;
  --hh-input-border: #3a3a5a;
  --hh-primary: #e31337;
  --hh-primary-hover: #ff2a4a;
  --hh-danger: #ff4444;
  --hh-success: #22c55e;
  --hh-btn-secondary-bg: #2a2a4a;
  --hh-btn-secondary-text: #e0e0e0;
  --hh-btn-secondary-hover: #3a3a5a;
  --hh-shadow: rgba(0, 0, 0, 0.4);
}
      `}</Code>

      <H2>All CSS variables</H2>
      <Table
        headers={['Variable', 'Light default', 'Dark default', 'Purpose']}
        rows={[
          ['--hh-bg', '#ffffff', '#1a1a2e', 'Main background'],
          ['--hh-bg-secondary', '#f5f5f5', '#16213e', 'Secondary background'],
          ['--hh-bg-hover', '#f0f0f0', '#1f2b47', 'Hover state'],
          ['--hh-text', '#1a1a1a', '#e0e0e0', 'Primary text'],
          ['--hh-text-secondary', '#666666', '#a0a0a0', 'Secondary text'],
          ['--hh-text-muted', '#888888', '#888888', 'Muted text'],
          ['--hh-border', '#e0e0e0', '#2a2a4a', 'Borders'],
          ['--hh-input-border', '#cccccc', '#3a3a5a', 'Input borders'],
          ['--hh-primary', '#e31337', '#e31337', 'Primary/brand color'],
          ['--hh-danger', '#ff4444', '#ff4444', 'Danger/error color'],
          ['--hh-success', '#22c55e', '#22c55e', 'Success color'],
        ]}
      />
    </>
  );
}

function Recording() {
  return (
    <>
      <H1>Recording</H1>
      <P>
        Hosts can record hangouts as MP3 files and upload them to IPFS via
        audio.3speak.tv. The recording is done server-side by LiveKit Egress —
        no client-side recording needed.
      </P>

      <H2>How it works</H2>
      <Code>{`
Host clicks Record
  → Server tells LiveKit Egress to capture all room audio
  → MP3 file writes to server disk

Host clicks Stop
  → Server stops Egress, file is finalized
  → Upload dialog appears with title input

Host clicks "Upload to IPFS"
  → Server uploads MP3 to audio.3speak.tv
  → File pinned to IPFS (local + 3Speak supernode)
  → Returns { permlink, cid, playUrl }
  → App can use playUrl to create a Hive post
      `}</Code>

      <H2>Built-in UI</H2>
      <P>
        The SDK includes recording controls automatically. When the host is in a room,
        they see a "Record" button. All participants see a pulsing red "REC" indicator
        with a timer when recording is active.
      </P>

      <H2>Using the callback</H2>
      <P>
        Use <code>onRecordingUploaded</code> to handle the result in your app:
      </P>
      <Code>{`
<HangoutsRoom
  roomName={roomName}
  embedded
  onRecordingUploaded={(result) => {
    console.log('Audio URL:', result.playUrl);
    console.log('IPFS CID:', result.cid);
    // Redirect to your post composer
  }}
/>
      `}</Code>

      <H2>Using the hook directly</H2>
      <Code>{`
import { useRecording } from '@snapie/hangouts-react';

function MyRecordingUI({ roomName }: { roomName: string }) {
  const {
    isRecording,
    elapsed,        // seconds since recording started
    filePath,       // set after stopping
    duration,       // actual duration in seconds
    uploadResult,   // { permlink, cid, playUrl } after upload
    isLoading,
    startRecording,
    stopRecording,
    uploadRecording,
  } = useRecording(roomName);

  // elapsed ticks every second while recording
  // uploadRecording(title?, tags?) uploads to audio.3speak.tv
}
      `}</Code>

      <H2>For React Native</H2>
      <P>
        The React Native app uses <code>@snapie/hangouts-core</code> directly.
        Call the API client methods:
      </P>
      <Code>{`
await client.startRecording(roomName);
const result = await client.stopRecording(roomName);
const upload = await client.uploadRecording(
  roomName,
  result.filePath,
  result.duration,
  'My Podcast Title',
  ['hangout', 'podcast']
);
// upload.playUrl = the audio URL
      `}</Code>
    </>
  );
}

function ApiReference() {
  return (
    <>
      <H1>API Reference</H1>
      <P>
        The Hangouts API runs at <code>https://hangout-api.3speak.tv</code>.
        All mutation endpoints require a Bearer token from the auth flow.
      </P>

      <H2>Auth</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Description']}
        rows={[
          ['POST', '/auth/challenge', 'No', 'Get a nonce to sign. Body: { username }'],
          ['POST', '/auth/verify', 'No', 'Verify signature, get JWT. Body: { username, challenge, signature }'],
        ]}
      />

      <H2>Rooms</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Description']}
        rows={[
          ['GET', '/rooms', 'No', 'List all active rooms'],
          ['GET', '/rooms/:name', 'No', 'Get a single room (404 if not found)'],
          ['POST', '/rooms', 'Yes', 'Create a room. Body: { title, description? }. Returns: { room, token, isPremium }'],
          ['POST', '/rooms/:name/join', 'Yes', 'Join a room. Returns: { token, roomName, identity, isHost, isPremium }'],
          ['DELETE', '/rooms/:name', 'Host', 'Close/delete a room'],
        ]}
      />

      <H2>Participants</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Description']}
        rows={[
          ['PATCH', '/rooms/:name/participants/:identity/permissions', 'Host', 'Promote/demote. Body: { canPublish: boolean }'],
          ['DELETE', '/rooms/:name/participants/:identity', 'Host', 'Kick a participant'],
        ]}
      />

      <H2>Recording</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Description']}
        rows={[
          ['POST', '/rooms/:name/record/start', 'Host', 'Start recording (LiveKit Egress, MP3)'],
          ['POST', '/rooms/:name/record/stop', 'Host', 'Stop recording. Returns: { filePath, duration }'],
          ['GET', '/rooms/:name/record/status', 'Yes', 'Check if recording. Returns: { recording: boolean }'],
          ['POST', '/rooms/:name/record/upload', 'Host', 'Upload to audio.3speak.tv. Body: { filePath, title?, tags? }. Returns: { permlink, cid, playUrl }'],
        ]}
      />

      <H2>Response format</H2>
      <P>All responses are JSON. Errors include <code>message</code> and <code>statusCode</code>:</P>
      <Code>{`
// Success
{ "token": "eyJ...", "username": "alice" }

// Error
{ "statusCode": 401, "error": "Unauthorized", "message": "Invalid or expired session token" }
      `}</Code>
    </>
  );
}

function PremiumAndBans() {
  return (
    <>
      <H1>Premium & Bans</H1>
      <P>
        The server enforces premium video access and user bans by checking the
        3speak <code>embed-users</code> MongoDB collection. This is server-side —
        frontends cannot bypass it.
      </P>

      <H2>How it works</H2>
      <Code>{`
When a user creates or joins a room, the server:

1. Checks embed-users collection for their username
2. If banned: true → 403 "Your account has been suspended"
3. If premium: true → token allows audio + video + screen share
4. If premium: false → token allows audio only (canPublishSources: [MICROPHONE])
5. Returns isPremium: boolean in the response
      `}</Code>

      <H2>Banned users</H2>
      <P>
        Users with <code>banned: true</code> in the <code>embed-users</code> collection
        get 403 on ALL authenticated routes — they cannot join rooms, create rooms,
        record, or perform any action. The ban check runs as middleware before every
        authenticated endpoint.
      </P>
      <P>
        No frontend changes are needed for ban enforcement. The API client
        throws <code>HangoutsApiError</code> with status 403.
      </P>

      <H2>Premium video</H2>
      <P>
        Non-premium users can use audio, chat, hand raise, and all non-video features.
        When promoted to speaker, they can speak — but cannot turn on their camera
        or share their screen. This is enforced at the LiveKit token level.
      </P>
      <P>
        The <code>create</code> and <code>join</code> responses include <code>isPremium</code>:
      </P>
      <Code>{`
// Create room response
{ room: { name, title, ... }, token: "...", isPremium: true }

// Join room response
{ token: "...", roomName: "...", identity: "alice", isHost: false, isPremium: true }
      `}</Code>

      <H2>Frontend usage</H2>
      <P>
        Use <code>isPremium</code> to conditionally enable the video UI.
        Even if you skip this check, the server blocks video for non-premium users.
      </P>
      <Code>{`
// The server response tells you if the user is premium
const result = await client.joinRoom(roomName);

// Pass to the component
<HangoutsRoom
  roomName={roomName}
  video={result.isPremium}  // only show video controls for premium
  embedded
/>
      `}</Code>

      <H2>Graceful degradation</H2>
      <P>
        If <code>MONGODB_URI</code> is not configured on the server, all users are
        treated as non-banned and non-premium. The system works without MongoDB —
        it just doesn't enforce premium or bans. This means self-hosters can run
        without the 3speak database.
      </P>

      <H2>Caching</H2>
      <P>
        User status is cached in memory for 60 seconds to avoid hitting MongoDB
        on every request. A user's ban or premium status change takes up to 1 minute
        to take effect.
      </P>
    </>
  );
}

function IntegrationGuides() {
  return (
    <>
      <H1>Integration Guides</H1>

      <H2>Next.js / React (modal pattern)</H2>
      <P>The recommended pattern for web apps: render hangouts in a modal.</P>
      <Code>{`
// 1. Create a context for modal state
const HangoutContext = createContext({ activeRoom: null, openRoom, closeRoom });

// 2. Render the modal once at the app root
{activeRoom && (
  <HangoutsProvider apiBaseUrl="..." livekitServerUrl="...">
    <Modal onClose={closeRoom}>
      <HangoutsRoom
        roomName={activeRoom}
        onLeave={closeRoom}
        onRecordingUploaded={(r) => router.push('/compose?audio=' + r.playUrl)}
        embedded
      />
    </Modal>
  </HangoutsProvider>
)}

// 3. Open from anywhere
const { openRoom } = useHangout();
<button onClick={() => openRoom('room-name')}>Join Hangout</button>
      `}</Code>

      <P><strong>Key points:</strong></P>
      <ul className="docs__list">
        <li>Use <code>embedded</code> prop — removes full-page min-height</li>
        <li>Dynamically import the modal to avoid loading LiveKit (~150KB) on every page</li>
        <li>Place <code>HangoutsProvider</code> inside the modal, not wrapping the whole app</li>
      </ul>

      <H2>React Native</H2>
      <P>
        Mobile apps use <code>@snapie/hangouts-core</code> (not the React package)
        with <code>@livekit/react-native</code> for audio.
      </P>
      <Code>{`
npm install @snapie/hangouts-core
npx expo install @livekit/react-native @livekit/react-native-webrtc
      `}</Code>
      <P>Build your own native UI with the API client and LiveKit RN hooks. The SDK provides:</P>
      <ul className="docs__list">
        <li><code>HangoutsApiClient</code> — all API methods (auth, rooms, recording)</li>
        <li>TypeScript types for all responses</li>
        <li>Silent auth using stored posting key (no Keychain extension needed)</li>
      </ul>
      <P>
        LiveKit data channels work the same on mobile — chat messages use topic <code>"chat"</code>,
        hand raises use topic <code>"hand-raise"</code>. Same JSON protocol, so web and
        mobile participants interact seamlessly.
      </P>

      <H2>Detecting hangout links in content</H2>
      <P>To render rich preview cards when a user shares a hangout URL:</P>
      <Code>{`
// Extract room names from post content
const pattern = /https?:\\/\\/hangout\\.3speak\\.tv\\/room\\/([\\w-]+)/g;
const roomNames = [...content.matchAll(pattern)].map(m => m[1]);

// Fetch room info
import { HangoutsApiClient } from '@snapie/hangouts-core';
const client = new HangoutsApiClient({ baseUrl: 'https://hangout-api.3speak.tv' });
const room = await client.getRoom(roomName);
// room = { name, title, host, numParticipants, ... } or null if ended

// Render a preview card with room.title, room.host, room.numParticipants
      `}</Code>

      <H2>Self-hosting</H2>
      <P>
        Hive Hangouts can be fully self-hosted. You need:
      </P>
      <ul className="docs__list">
        <li><strong>LiveKit SFU</strong> — Docker container on any VPS with UDP ports open</li>
        <li><strong>Hangouts API</strong> — Node.js/Fastify server (~300 lines)</li>
        <li><strong>Redis</strong> — for LiveKit room state</li>
        <li>Point the SDK at your own API and LiveKit URLs via provider props</li>
      </ul>
      <P>
        See the <a href="https://github.com/Mantequilla-Soft/hangouts" target="_blank" rel="noopener">GitHub repo</a> for
        the server code and deployment guide.
      </P>
    </>
  );
}
