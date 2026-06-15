import { useState } from 'react';
import './styles.css';

type Section =
  | 'quick-start'
  | 'architecture'
  | 'authentication'
  | 'sdk-core'
  | 'sdk-react'
  | 'guest-listening'
  | 'recording'
  | 'streaming'
  | 'boosts'
  | 'events-presence'
  | 'games'
  | 'hand-raise-chimes'
  | 'theming'
  | 'premium-and-bans'
  | 'api-reference'
  | 'integration-guides'
  | 'deployment'
  | 'ai-agents';

const NAV: { id: Section; label: string; group?: string }[] = [
  { id: 'quick-start', label: 'Quick Start', group: 'Getting Started' },
  { id: 'architecture', label: 'Architecture & Concepts', group: 'Getting Started' },

  { id: 'authentication', label: 'Authentication', group: 'Core' },
  { id: 'sdk-core', label: '@snapie/hangouts-core', group: 'Core' },
  { id: 'sdk-react', label: '@snapie/hangouts-react', group: 'Core' },

  { id: 'guest-listening', label: 'Guest Listening', group: 'Features' },
  { id: 'recording', label: 'Recording & Egress', group: 'Features' },
  { id: 'streaming', label: 'Live Streaming', group: 'Features' },
  { id: 'boosts', label: 'Boost Messages', group: 'Features' },
  { id: 'events-presence', label: 'Events & Presence', group: 'Features' },
  { id: 'games', label: 'Games & Results', group: 'Features' },
  { id: 'hand-raise-chimes', label: 'Hand-Raise Chimes', group: 'Features' },
  { id: 'theming', label: 'Theming', group: 'Customization' },

  { id: 'premium-and-bans', label: 'Premium & Bans', group: 'Server' },
  { id: 'api-reference', label: 'API Reference', group: 'Server' },
  { id: 'deployment', label: 'Deployment', group: 'Server' },

  { id: 'integration-guides', label: 'Integration Guides', group: 'Integrating' },
  { id: 'ai-agents', label: 'AI Agent Guide', group: 'Advanced' },
];

export default function App() {
  const [active, setActive] = useState<Section>('quick-start');
  const groups = Array.from(new Set(NAV.map(n => n.group)));

  return (
    <div className="docs">
      <nav className="docs__nav">
        <div className="docs__logo">Hive Hangouts</div>
        <div className="docs__subtitle">Developer Docs</div>
        {groups.map(group => (
          <div key={group}>
            {group && <div className="docs__nav-group">{group}</div>}
            {NAV.filter(n => n.group === group).map((item) => (
              <button
                key={item.id}
                className={`docs__nav-item ${active === item.id ? 'docs__nav-item--active' : ''}`}
                onClick={() => setActive(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
        <div className="docs__nav-footer">
          <a href="https://github.com/Mantequilla-Soft/hangouts" target="_blank" rel="noopener">GitHub</a>
          <a href="https://www.npmjs.com/package/@snapie/hangouts-react" target="_blank" rel="noopener">npm</a>
        </div>
      </nav>
      <main className="docs__content">
        {active === 'quick-start' && <QuickStart />}
        {active === 'architecture' && <Architecture />}
        {active === 'authentication' && <Authentication />}
        {active === 'sdk-core' && <SdkCore />}
        {active === 'sdk-react' && <SdkReact />}
        {active === 'guest-listening' && <GuestListening />}
        {active === 'recording' && <Recording />}
        {active === 'streaming' && <Streaming />}
        {active === 'boosts' && <Boosts />}
        {active === 'events-presence' && <EventsPresence />}
        {active === 'games' && <Games />}
        {active === 'hand-raise-chimes' && <HandRaiseChimes />}
        {active === 'theming' && <Theming />}
        {active === 'premium-and-bans' && <PremiumAndBans />}
        {active === 'api-reference' && <ApiReference />}
        {active === 'deployment' && <Deployment />}
        {active === 'integration-guides' && <IntegrationGuides />}
        {active === 'ai-agents' && <AiAgents />}
      </main>
    </div>
  );
}

// ─── Utility Components ────────────────────────────────────────────

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

function QuickStart() {
  return (
    <>
      <H1>Quick Start</H1>
      <P>
        Hive Hangouts is a Twitter Spaces-style audio room SDK for the Hive blockchain.
        Get up and running in 5 minutes.
      </P>

      <H2>1. Install</H2>
      <Code>{`npm install @snapie/hangouts-react @livekit/components-react livekit-client`}</Code>

      <H2>2. Render a room</H2>
      <Code>{`
import { HangoutsProvider, HangoutsRoom } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

export default function App() {
  return (
    <HangoutsProvider
      apiBaseUrl="https://hangout-api.3speak.tv"
      livekitServerUrl="wss://livekit.3speak.tv"
    >
      <HangoutsRoom roomName="my-room" embedded />
    </HangoutsProvider>
  );
}
      `}</Code>

      <H2>3. Or add a lobby</H2>
      <Code>{`
import { useState } from 'react';
import { HangoutsProvider, RoomLobby, HangoutsRoom } from '@snapie/hangouts-react';

export default function App() {
  const [room, setRoom] = useState<string | null>(null);

  return (
    <HangoutsProvider apiBaseUrl="https://hangout-api.3speak.tv">
      {room ? (
        <HangoutsRoom roomName={room} onLeave={() => setRoom(null)} embedded />
      ) : (
        <RoomLobby onJoinRoom={setRoom} />
      )}
    </HangoutsProvider>
  );
}
      `}</Code>

      <P>Users sign in with Hive Keychain. That's it.</P>

      <H2>Next steps</H2>
      <ul className="docs__list">
        <li>Read <strong>Architecture & Concepts</strong> to understand how it works</li>
        <li>See <strong>Authentication</strong> if you need custom auth flows</li>
        <li>Check <strong>Integration Guides</strong> for your framework (Next.js, React Native, etc.)</li>
      </ul>
    </>
  );
}

function Architecture() {
  return (
    <>
      <H1>Architecture & Concepts</H1>

      <H2>Three-tier system</H2>
      <Code>{`
Your App (React)
    ↓
Hangouts API (Fastify)
    ↓ (HTTP for auth/tokens)
    ↓ (WebRTC signaling)
    ↓
LiveKit SFU (audio/video server)

Hive Blockchain ← signature verification
      `}</Code>

      <H3>1. Your App (React)</H3>
      <P>
        Uses the Hangouts SDK components. Handles login UI, room display, and user interactions.
        The SDK is React-agnostic — you can also use it in React Native, Vue, or vanilla JS.
      </P>

      <H3>2. Hangouts API (Fastify)</H3>
      <P>
        Thin auth gateway. Responsibilities:
      </P>
      <ul className="docs__list">
        <li>Challenge-response auth via Hive Keychain (verifies signatures against Hive blockchain)</li>
        <li>Issues LiveKit tokens (short-lived, cryptographically signed)</li>
        <li>Enforces permissions (host-only actions, premium video gating, bans)</li>
        <li>Manages recording and streaming via LiveKit Egress</li>
      </ul>

      <H3>3. LiveKit SFU</H3>
      <P>
        Open-source WebRTC server that handles real-time audio/video routing. The SFU intelligently
        forwards only the active speaker's audio to reduce bandwidth. Self-hosted on your VPS.
      </P>

      <H2>Data flow: User creates a room</H2>
      <Code>{`
1. User clicks "Create Room"
2. Browser requests challenge from /auth/challenge
3. Hive Keychain extension prompts user to sign
4. Browser verifies signature via /auth/verify → gets session JWT
5. Browser POSTs to /rooms with JWT → gets LiveKit token
6. Browser connects to LiveKit with token (WebRTC)
7. Other users join the same room via their own tokens
      `}</Code>

      <H2>LiveKit data channels</H2>
      <P>
        Beyond audio, Hangouts uses LiveKit's data channels for real-time messaging:
      </P>
      <Table
        headers={['Topic', 'Direction', 'Purpose']}
        rows={[
          ['chat', 'Bidirectional', 'Text chat messages'],
          ['hand-raise', 'Bidirectional', 'Hand raise events (listeners → host acknowledgement)'],
        ]}
      />
      <P>
        Data channels work automatically—the SDK handles subscriptions. Messages are JSON.
      </P>

      <H2>Participants and roles</H2>
      <Table
        headers={['Role', 'Can speak', 'Can be demoted', 'Example identity']}
        rows={[
          ['Host', 'Yes (always)', 'No', 'alice'],
          ['Speaker', 'Yes', 'Yes (back to listener)', 'bob'],
          ['Listener', 'No (raises hand)', 'No (promoted to speaker)', 'charlie'],
          ['Guest', 'No (read-only)', 'No (cannot be promoted)', 'guest-a1b2c3d4'],
        ]}
      />

      <H2>Recording and Egress</H2>
      <P>
        When a host starts recording, the server tells LiveKit Egress to:
      </P>
      <ol className="docs__list">
        <li>Capture all audio (or video) from the room</li>
        <li>Compose it into a single MP3 (or MP4) file</li>
        <li>Write to server disk</li>
      </ol>
      <P>
        After stopping, the host can download, discard, or upload to IPFS/your service via callback.
      </P>

      <H2>Premium and bans</H2>
      <P>
        The server checks 3speak's <code>embed-users</code> MongoDB collection:
      </P>
      <ul className="docs__list">
        <li>If <code>banned: true</code> → 403 on all authenticated routes</li>
        <li>If <code>premium: true</code> → token allows video/screen share</li>
        <li>If <code>premium: false</code> → token allows audio only</li>
      </ul>
      <P>
        This is server-side enforcement — frontends cannot bypass it.
      </P>
    </>
  );
}

function Authentication() {
  return (
    <>
      <H1>Authentication</H1>

      <H2>How it works</H2>
      <P>
        Hive Hangouts uses Hive Keychain for authentication. Users sign a challenge with their
        Hive posting key. The server verifies the signature against the blockchain. No passwords.
      </P>

      <H2>Challenge-response flow</H2>
      <Code>{`
1. Client: POST /auth/challenge { username: "alice" }
   Server: { challenge: "hivehangouts:alice:1711...:a3f2", expires: 1711... }

2. User clicks Sign In → Keychain popup appears
   window.hive_keychain.requestSignBuffer("alice", challenge, "Posting")
   Returns: signature

3. Client: POST /auth/verify { username, challenge, signature }
   Server: Fetches alice's posting key from Hive blockchain
           Verifies signature matches key
           Returns: { token: "eyJ...", username: "alice" }

4. Client stores token, includes in all requests:
   Authorization: Bearer eyJ...
      `}</Code>

      <H2>Automatic (React SDK)</H2>
      <P>The SDK handles everything. Just use:</P>
      <Code>{`
import { useHangoutsAuth } from '@snapie/hangouts-react';

function MyComponent() {
  const { username, isAuthenticated, login, logout } = useHangoutsAuth();

  if (!isAuthenticated) {
    return <button onClick={() => login('alice')}>Sign in</button>;
  }

  return <p>Signed in as @{username}</p>;
}
      `}</Code>

      <H2>Manual (React Native / custom auth)</H2>
      <P>If you have the posting key stored locally:</P>
      <Code>{`
import { HangoutsApiClient } from '@snapie/hangouts-core';
import { PrivateKey } from '@hiveio/dhive';
import { sha256 } from 'js-sha256';

const client = new HangoutsApiClient({ baseUrl: 'https://hangout-api.3speak.tv' });

// 1. Get challenge
const { challenge } = await client.requestChallenge(username);

// 2. Sign locally (no Keychain popup)
const key = PrivateKey.fromString(postingKeyHex);
const hash = Buffer.from(sha256.arrayBuffer(challenge));
const signature = key.sign(hash).toString();

// 3. Verify
const session = await client.verifySignature(username, challenge, signature);
client.setSessionToken(session.token);
      `}</Code>

      <H2>Pre-authenticated users</H2>
      <P>If your app manages auth outside Hangouts:</P>
      <Code>{`
<HangoutsProvider
  apiBaseUrl="https://hangout-api.3speak.tv"
  sessionToken={myToken}
  username="alice"
>
  {children}
</HangoutsProvider>
      `}</Code>

      <H2>Session token (JWT)</H2>
      <Table
        headers={['Property', 'Value', 'Notes']}
        rows={[
          ['TTL', '24 hours', 'Expires after 24 hours; user re-authenticates'],
          ['Type', 'Bearer token', 'Pass in Authorization header: Bearer <token>'],
          ['Scope', 'User-specific', 'All actions (create room, join, record) tied to authenticated username'],
        ]}
      />
    </>
  );
}

function SdkCore() {
  return (
    <>
      <H1>@snapie/hangouts-core</H1>
      <P>
        Framework-agnostic API client, TypeScript types, and auth helpers.
        Use this for React Native, Vue, Svelte, or custom integrations.
      </P>

      <H2>Installation</H2>
      <Code>{`npm install @snapie/hangouts-core`}</Code>

      <H2>HangoutsApiClient</H2>
      <Code>{`
import { HangoutsApiClient } from '@snapie/hangouts-core';

const client = new HangoutsApiClient({
  baseUrl: 'https://hangout-api.3speak.tv'
});
      `}</Code>

      <H3>Auth methods</H3>
      <Table
        headers={['Method', 'Returns', 'Description']}
        rows={[
          ['setSessionToken(token)', 'void', 'Set Bearer token for subsequent requests'],
          ['getSessionToken()', 'string | null', 'Get current token'],
          ['clearSessionToken()', 'void', 'Clear token'],
          ['requestChallenge(username)', 'Promise<ChallengeResponse>', 'Get nonce to sign'],
          ['verifySignature(username, challenge, sig)', 'Promise<AuthSession>', 'Verify and get JWT'],
        ]}
      />

      <H3>Room methods</H3>
      <Table
        headers={['Method', 'Auth', 'Returns']}
        rows={[
          ['listRooms()', 'No', 'Promise<Room[]>'],
          ['getRoom(name)', 'No', 'Promise<Room | null>'],
          ['createRoom(title, description?, backgroundImage?, visibility?, language?, boost?)', 'Yes', 'Promise<CreateRoomResponse>'],
          ['joinRoom(name)', 'Yes', 'Promise<JoinRoomResponse>'],
          ['listenAsGuest(name)', 'No', 'Promise<JoinRoomResponse> (identity: guest-*)'],
          ['leaveRoom(name)', 'Yes', 'Promise<void>'],
          ['deleteRoom(name)', 'Host', 'Promise<void>'],
        ]}
      />

      <H3>Participant methods</H3>
      <Table
        headers={['Method', 'Auth', 'Returns']}
        rows={[
          ['setPermissions(room, identity, canPublish)', 'Host', 'Promise<void>'],
          ['kickParticipant(room, identity)', 'Host', 'Promise<void>'],
        ]}
      />

      <H3>Recording methods</H3>
      <Table
        headers={['Method', 'Auth', 'Returns']}
        rows={[
          ['startRecording(room)', 'Host', 'Promise<RecordingStartResponse>'],
          ['stopRecording(room)', 'Host', 'Promise<RecordingStopResponse>'],
          ['getRecordingStatus(room)', 'Yes', 'Promise<{ recording: boolean }>'],
          ['uploadRecording(room, filePath, duration?, title?, tags?)', 'Host', 'Promise<UploadResult>'],
        ]}
      />

      <H3>Streaming methods</H3>
      <Table
        headers={['Method', 'Auth', 'Returns']}
        rows={[
          ['startStreaming(room, destinations)', 'Host', 'Promise<StreamingStartResponse>'],
          ['stopStreaming(room)', 'Host', 'Promise<void>'],
          ['getStreamingStatus(room)', 'Yes', 'Promise<StreamingStatus>'],
        ]}
      />

      <H2>Types</H2>
      <Code>{`
interface Room {
  name: string;
  title: string;
  host: string;
  description?: string;
  visibility?: 'public' | 'hive-internal' | 'unlisted';
  language?: string;
  boost?: {
    enabled: boolean;
    minBoostUsd: number;
    creatorPayoutAccount?: string;
  };
  origin?: string;
  numParticipants?: number;
  createdAt: string;
}

interface CreateRoomResponse {
  room: Room;
  token: string;      // LiveKit token
  isPremium?: boolean;
}

interface JoinRoomResponse {
  token: string;      // LiveKit token
  roomName: string;
  identity: string;   // "alice" or "guest-abc123"
  isHost: boolean;
  isGuest: boolean;
  isPremium?: boolean;
}

interface AuthSession {
  token: string;      // JWT session token
  username: string;
}

interface HandRaiseEvent {
  type: 'hand_raise';
  raised: boolean;
  identity: string;
  timestamp: number;
}
      `}</Code>

      <H2>Keychain helpers (web only)</H2>
      <Code>{`
import { loginWithKeychain, isKeychainAvailable } from '@snapie/hangouts-core';

if (isKeychainAvailable()) {
  const session = await loginWithKeychain(client, 'alice');
  // session = { token, username }
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
        Drop-in React components and hooks. Includes all of @snapie/hangouts-core plus
        LiveKit-powered UI components for audio, video, chat, and controls.
      </P>

      <H2>Installation</H2>
      <Code>{`npm install @snapie/hangouts-react @livekit/components-react livekit-client`}</Code>

      <H2>HangoutsProvider</H2>
      <P>Wrap your app with the provider:</P>
      <Code>{`
<HangoutsProvider
  apiBaseUrl="https://hangout-api.3speak.tv"     // required
  livekitServerUrl="wss://livekit.3speak.tv"     // optional, defaults shown
  sessionToken={token}                            // optional
  username="alice"                                // optional (with sessionToken)
  imageServerApiKey={apiKey}                      // optional (for bg image picker)
>
  {children}
</HangoutsProvider>
      `}</Code>

      <H2>HangoutsRoom</H2>
      <P>The main component. Renders the full room UI.</P>
      <Code>{`
<HangoutsRoom
  roomName="my-room"                    // required
  onLeave={() => {}}                    // called on leave
  onError={(err) => {}}                 // called on WebRTC error
  embedded                              // fits in modals (no min-height)
  maxHeight="80vh"                      // optional explicit height
  video                                 // enable camera/screen share (default: false)
  guestFallback                         // unauth users auto-join via /listen
  getShareUrl={(roomName, origin) => {  // build share link
    return 'https://myapp.com/hangout/' + roomName;
  }}
  notificationSounds                    // hand-raise chimes (default: true)
  onAudioHandoff={(file) => {           // recording callback
    console.log(file.blob, file.filename, file.duration, file.size);
  }}
  onVideoHandoff={(file) => {           // same as above for video
    console.log(file.blob, file.filename, file.duration, file.size);
  }}
/>
      `}</Code>

      <H2>RoomLobby</H2>
      <P>Room list, login, and create room dialog:</P>
      <Code>{`
<RoomLobby
  onJoinRoom={(roomName) => setActive(roomName)}
  onRoomCreated={(room) => setActive(room.name)}
  allowGuestBrowse                      // unauth users see room list
/>
      `}</Code>

      <H2>Hooks</H2>
      <Table
        headers={['Hook', 'Returns', 'Description']}
        rows={[
          ['useHangoutsAuth()', '{ username, isAuthenticated, login, logout, isLoading, error }', 'Auth state'],
          ['useRoomList()', '{ rooms, isLoading, error, refresh }', 'Active rooms (polls 10s)'],
          ['useHangoutsRoom()', '{ livekitToken, roomName, isHost, isGuest, join, create, listen, leave, ... }', 'Room state'],
          ['useChat()', '{ messages, sendMessage }', 'Chat messages'],
          ['useHandRaise()', '{ raisedHands, raiseHand, lowerHand, isRaised }', 'Hand raise state'],
          ['useHostControls()', '{ promote, demote, kick }', 'Host moderation'],
          ['useRecording()', '{ isRecording, elapsed, startRecording, stopRecording, uploadRecording }', 'Recording state'],
          ['useHandRaiseChime(enabled?, volume?)', 'void', 'Play chime on other hand-raise (client-only audio)'],
          ['useHiveAvatar(username, size?)', 'string (URL)', 'Hive profile picture'],
          ['getParticipantRole(participant, hostId)', "'host' | 'speaker' | 'listener'", 'Derive role'],
        ]}
      />

      <H2>UI Components</H2>
      <P>Pre-built components (all use <code>.hh-</code> CSS classes):</P>
      <Table
        headers={['Component', 'Props', 'Description']}
        rows={[
          ['<SpeakerStage />', 'hostIdentity, isCurrentUserHost, roomName', 'Grid of speakers'],
          ['<AudienceSection />', 'hostIdentity, isCurrentUserHost, roomName', 'Listeners + hand-raise'],
          ['<RoomControls />', 'isHost, isGuest, roomName, onLeave, ...', 'Bottom bar: mute, hand raise, record'],
          ['<ChatPanel />', 'isGuest', 'Togglable chat sidebar'],
          ['<RoomHeader />', 'title, description, roomName, isGuest, shareUrl', 'Top header with title + share'],
          ['<RecordingControls />', 'roomName, onAudioHandoff, onVideoHandoff', 'Record button + upload'],
          ['<StreamingPanel />', 'roomName', 'YouTube/Twitch streaming UI'],
          ['<ParticipantTile />', 'participant, role, isHandRaised, roomName', 'Avatar + speaking ring'],
          ['<HostControlsPanel />', 'identity, role, roomName, onClose', 'Promote/demote/kick menu'],
          ['<HangoutsErrorBoundary />', 'onError?, children', 'Catches WebRTC crashes'],
        ]}
      />
    </>
  );
}

function GuestListening() {
  return (
    <>
      <H1>Guest Listening</H1>
      <P>
        Allow unauthenticated visitors to listen to public rooms without signing in.
        Guests are read-only: no chat, no hand-raise, no speak.
      </P>

      <H2>What guests can do</H2>
      <ul className="docs__list">
        <li>✅ Listen to audio</li>
        <li>✅ See participant list</li>
        <li>❌ Speak (no microphone access)</li>
        <li>❌ Chat (read-only)</li>
        <li>❌ Raise hand</li>
        <li>❌ Be promoted to speaker</li>
      </ul>

      <H2>How it works</H2>
      <Code>{`
Unauthenticated user lands on room URL
  ↓
App detects no auth session + room is public
  ↓
Calls POST /rooms/:name/listen (no token needed)
  ↓
Server returns guest token with identity "guest-a1b2c3d4"
  ↓
Browser connects to LiveKit with listen-only token
  ↓
All participants see guest identity in the room
      `}</Code>

      <H2>Room visibility tiers</H2>
      <Table
        headers={['Visibility', 'Listed in lobby', 'Guests allowed', 'Searchable']}
        rows={[
          ['public (default)', 'Yes', 'Yes', 'Yes'],
          ['hive-internal', 'Yes', 'No (403)', 'Yes, to authenticated users'],
          ['unlisted', 'No', 'Yes (direct link)', 'No'],
        ]}
      />

      <H2>Client-side: auto-join guests</H2>
      <Code>{`
<HangoutsRoom
  roomName="my-room"
  guestFallback          // auto-join as guest if not authenticated
  embedded
/>
      `}</Code>

      <H2>Server-side: rate limiting</H2>
      <P>
        The server rate-limits <code>POST /rooms/:name/listen</code>:
      </P>
      <ul className="docs__list">
        <li><strong>Per IP:</strong> 10 requests per 5 minutes</li>
        <li><strong>Per room:</strong> 100 concurrent guests (configurable)</li>
      </ul>
      <P>
        Hitting the limit returns HTTP 429. Recommended retry strategy: exponential backoff.
      </P>

      <H2>Using the core client</H2>
      <Code>{`
import { HangoutsApiClient } from '@snapie/hangouts-core';

const client = new HangoutsApiClient({ baseUrl: 'https://hangout-api.3speak.tv' });
const result = await client.listenAsGuest('room-name');

// result = {
//   token: "eyJ...",
//   roomName: "room-name",
//   identity: "guest-a1b2c3d4",
//   isGuest: true,
//   isHost: false,
//   isPremium: false
// }
      `}</Code>

      <H2>Detecting guest status</H2>
      <Code>{`
import { useHangoutsRoom } from '@snapie/hangouts-react';

function MyComponent() {
  const { isGuest } = useHangoutsRoom();

  if (isGuest) {
    return <p>You're listening as a guest. Sign in to speak.</p>;
  }

  return <p>You're signed in.</p>;
}
      `}</Code>
    </>
  );
}

function Recording() {
  return (
    <>
      <H1>Recording & Egress</H1>
      <P>
        Hosts can record rooms as MP3 (audio) or MP4 (video) files. The server uses
        LiveKit Egress (a headless browser) to capture and compose. Files are stored
        locally and can be downloaded, streamed, or uploaded via callback.
      </P>

      <H2>How it works</H2>
      <Code>{`
Host clicks "Record"
  ↓
Server calls LiveKit Egress API: "start recording this room"
  ↓
Egress launches headless browser, joins room, records all audio (or video)
  ↓
MP3 (or MP4) file writes to /tmp/livekit-recordings on server disk

Host clicks "Stop Recording"
  ↓
Server calls Egress API: "stop recording"
  ↓
File is finalized (flush to disk)
  ↓
SDK renders "Recording ready" dialog

Host can:
  - Download: fetch the file from the server
  - Discard: delete from server
  - Upload: callback hands blob to your app (upload to S3, IPFS, etc.)
      `}</Code>

      <H2>Recording feature matrix</H2>
      <Table
        headers={['Feature', 'Audio', 'Video', 'Notes']}
        rows={[
          ['Record button', '✅', '✅', 'Visible to hosts only'],
          ['REC indicator', '✅', '✅', 'Visible to all, shows timer'],
          ['Download', '✅', '✅', 'Host can download file'],
          ['Upload callback', '✅', '✅', 'Blob handed to onAudioHandoff / onVideoHandoff'],
          ['Guests in recording', '❌', '❌', 'Guests are listen-only, don\'t publish'],
          ['Max duration', '∞ (disk-limited)', '∞ (disk-limited)', 'Set limit in .env'],
        ]}
      />

      <H2>Using HangoutsRoom callbacks</H2>
      <Code>{`
<HangoutsRoom
  roomName="my-room"
  onAudioHandoff={(file) => {
    // file = { blob: Blob, filename: string, duration: number, size: number }
    console.log('Audio ready:', file.filename, file.duration + 's');
    // upload to S3, IPFS, or create a Hive post
  }}
  onVideoHandoff={(file) => {
    // same shape as audio
    console.log('Video ready:', file.filename, file.duration + 's');
  }}
  embedded
/>
      `}</Code>

      <H2>Using the hook directly</H2>
      <Code>{`
import { useRecording } from '@snapie/hangouts-react';

function MyRecordingUI({ roomName }: { roomName: string }) {
  const {
    isRecording,              // boolean
    elapsed,                  // seconds since start (updates every second)
    filePath,                 // set after stopping
    duration,                 // actual duration in seconds
    uploadResult,             // after upload (if using legacy upload endpoint)
    isLoading,
    startRecording,           // () => Promise<void>
    stopRecording,            // () => Promise<void>
    uploadRecording,          // (title?, tags?) => Promise<UploadResult> [legacy]
  } = useRecording(roomName);

  return (
    <div>
      {isRecording ? (
        <button onClick={stopRecording}>Stop ({elapsed}s)</button>
      ) : (
        <button onClick={startRecording}>Start Recording</button>
      )}
    </div>
  );
}
      `}</Code>

      <H2>Server API</H2>
      <Table
        headers={['Endpoint', 'Auth', 'Body', 'Returns']}
        rows={[
          ['POST /rooms/:name/record/start', 'Host', '{}', '{ egressId, status, filepath? }'],
          ['POST /rooms/:name/record/stop', 'Host', '{}', '{ egressId, status, filePath, duration }'],
          ['GET /rooms/:name/record/status', 'Yes', 'N/A', '{ recording: boolean, egressId?, elapsed? }'],
          ['GET /rooms/:name/record/file/:token', 'Host', 'N/A', 'File stream (Content-Type: audio/mpeg or video/mp4)'],
          ['POST /rooms/:name/record/upload', 'Host', '{ title?, tags? }', '{ permlink, cid, playUrl } [legacy]'],
        ]}
      />

      <H2>File size & duration estimates</H2>
      <Table
        headers={['Type', 'Codec', 'Bitrate', 'Approx. size per hour']}
        rows={[
          ['Audio (MP3)', 'MP3', '128 kbps', '~57 MB'],
          ['Video (MP4)', 'H.264', '1–2 Mbps', '~450–900 MB'],
        ]}
      />
    </>
  );
}

function Streaming() {
  return (
    <>
      <H1>Live Streaming</H1>
      <P>
        Hosts can stream hangouts live to YouTube, Twitch, or any RTMP destination.
        The server uses LiveKit Egress to compose the room and push an RTMP stream.
      </P>

      <H2>Supported platforms</H2>
      <Table
        headers={['Platform', 'Stream key format', 'Notes']}
        rows={[
          ['YouTube Live', 'rtmps://a.rtmp.youtube.com/live2/:streamKey', 'Get from YouTube Studio'],
          ['Twitch', 'rtmps://live-[region].twitch.tv/app/:streamKey', 'Get from Creator Dashboard'],
          ['Facebook Live', 'rtmp://live-api-s.facebook.com:80/rtmp/:streamKey', 'Self-hosted account required'],
          ['Custom RTMP', 'rtmp[s]://host:port/app/stream', 'Any RTMP server'],
        ]}
      />

      <H2>How it works</H2>
      <Code>{`
Host enters stream key in UI (e.g., "sk_live_abc123...")
  ↓
Clicks "Go Live"
  ↓
POST /rooms/:name/stream/start { rtmpUrl: "rtmps://..." }
  ↓
Server calls LiveKit Egress: start RTMP streaming
  ↓
Egress joins room, composes speakers into one RTMP stream
  ↓
Stream pushes to YouTube/Twitch in real-time
  ↓
Host clicks "Stop Streaming"
  ↓
Server calls Egress: stop RTMP
  ↓
Stream ends on YouTube/Twitch
      `}</Code>

      <H2>Built-in UI</H2>
      <P>
        The SDK includes streaming controls. Hosts see a "Go Live" button that prompts
        for the stream key and destination URL.
      </P>
      <Code>{`
<HangoutsRoom roomName="my-room" embedded />
// Hosts automatically get the streaming panel in RoomControls
      `}</Code>

      <H2>Server API</H2>
      <Table
        headers={['Endpoint', 'Auth', 'Body', 'Returns']}
        rows={[
          ['POST /rooms/:name/stream/start', 'Host', '{ rtmpUrl }', '{ streamingId, status }'],
          ['POST /rooms/:name/stream/stop', 'Host', '{}', '{ status }'],
          ['GET /rooms/:name/stream/status', 'Yes', 'N/A', '{ streaming: boolean, streamingId?, url?, elapsed? }'],
        ]}
      />

      <H2>Security: stream key storage</H2>
      <P>
        <strong>Important:</strong> Stream keys are sensitive. Never expose them in client logs or error messages.
        The server accepts RTMP URLs client-side, but a production implementation should:
      </P>
      <ul className="docs__list">
        <li>Validate the URL is a known platform (YouTube, Twitch, etc.)</li>
        <li>Reject custom RTMP URLs or require explicit allow-listing</li>
        <li>Store stream keys server-side (encrypted), not in client code</li>
        <li>Use service account credentials for production setups</li>
      </ul>

      <H2>Egress layout during streaming</H2>
      <P>
        The stream shows the same layout as recording (host-controlled via <code>PATCH /rooms/:name/layout</code>):
      </P>
      <Table
        headers={['Layout', 'Appearance', 'Use case']}
        rows={[
          ['speaker (default)', 'Active speaker large, audience below', 'Podcast-style'],
          ['grid', 'All speakers equal size, grid layout', 'Panel discussion'],
          ['single', 'One speaker fills frame', 'Interview / focused view'],
        ]}
      />
    </>
  );
}

function Boosts() {
  return (
    <>
      <H1>Boost Messages (Superchat)</H1>
      <P>
        Boost messages are paid highlighted messages. A single platform wallet receives transfers,
        validates strict memo JSON, enforces room minimum USD thresholds, broadcasts accepted boosts
        to LiveKit topic <code>boost</code>, and pays out creator share immediately.
      </P>

      <H2>Strict memo JSON</H2>
      <Code>{`
{
  "version": 1,
  "room": "alice-room-abc123",
  "message": "Great session!",
  "sender": "bob",
  "nonce": "abc123_nonce",
  "displayName": "Bob"
}
      `}</Code>

      <H2>Room configuration</H2>
      <Table
        headers={['Field', 'Type', 'Description']}
        rows={[
          ['language', 'string', 'BCP-47 language tag shown in lobby (e.g. en, es-MX)'],
          ['boost.enabled', 'boolean', 'Enable/disable boosts for room'],
          ['boost.minBoostUsd', 'number', 'Minimum USD-equivalent amount required'],
          ['boost.creatorPayoutAccount', 'string', 'Hive account receiving creator payout (defaults to host)'],
        ]}
      />

      <H2>Payout split</H2>
      <P>
        v1 default split is immediate <strong>95% creator / 5% platform</strong>.
      </P>

      <H2>USD conversion logic</H2>
      <ul className="docs__list">
        <li><strong>HBD:</strong> always treated as $1.00</li>
        <li><strong>HIVE:</strong> fetched from CoinGecko and cached server-side</li>
        <li><strong>Fallback:</strong> uses <code>BOOST_HIVE_USD_FALLBACK</code> if API is unavailable</li>
      </ul>

      <H2>Realtime surfaces</H2>
      <ul className="docs__list">
        <li><code>useBoosts()</code> subscribes to topic <code>boost</code></li>
        <li><code>BoostOverlay</code> renders in <code>HangoutsRoom</code></li>
        <li>OBS overlay supports <code>show=boost</code> and host toggle in OBS panel</li>
      </ul>

      <H2>Ops notes</H2>
      <ul className="docs__list">
        <li>Store active key only in server secret manager (never in SDK/client)</li>
        <li>Enable with <code>BOOSTS_ENABLED=true</code></li>
        <li>Use structured logs + ledger endpoint for reconciliation</li>
      </ul>
    </>
  );
}

function HandRaiseChimes() {
  return (
    <>
      <H1>Hand-Raise Chimes (Notifications)</H1>
      <P>
        When another participant raises their hand, the host hears a subtle two-note chime
        (C6 → E6). This is local-only client-side audio—no recording leakage, no server overhead.
      </P>

      <H2>How it works</H2>
      <Code>{`
Participant A raises hand
  ↓
LiveKit data channel broadcasts hand_raise event
  ↓
Participant B (host) receives event
  ↓
Client-side Web Audio synth plays: C6 (1046.5 Hz) + E6 (1318.5 Hz)
  ↓
Only Participant B hears it (local browser speaker)
  ↓
Recording never hears it (recordings run in separate browser, don't mount this hook)
      `}</Code>

      <H2>Features</H2>
      <ul className="docs__list">
        <li>✅ Web Audio API synth (no audio asset files)</li>
        <li>✅ 2-second throttle (prevents chime spam on hand-raise bursts)</li>
        <li>✅ Identity filtering (ignores local user's own raises)</li>
        <li>✅ Graceful fallback on autoplay block (no JS errors)</li>
        <li>✅ Configurable volume (default: 0.3)</li>
      </ul>

      <H2>Default behavior</H2>
      <Code>{`
<HangoutsRoom
  roomName="my-room"
  notificationSounds={true}    // default; set to false to disable
  embedded
/>
      `}</Code>

      <H2>Using the hook directly</H2>
      <Code>{`
import { useHandRaiseChime } from '@snapie/hangouts-react';

function MyComponent() {
  // Play chime at 50% volume when enabled
  useHandRaiseChime(true, 0.5);

  return <div>Chime enabled at 50% volume</div>;
}
      `}</Code>

      <H2>When chimes DON'T play</H2>
      <ul className="docs__list">
        <li>❌ Autoplay policy blocks audio context (browser security)</li>
        <li>❌ Audio context suspended (user hasn't interacted with page yet)</li>
        <li>❌ Hand-raise lowering event (only raised: true triggers chime)</li>
        <li>❌ Local user's own hand-raise (identity filtering)</li>
        <li>❌ Within 2 seconds of previous chime (throttling)</li>
      </ul>
      <P>
        In all these cases, the chime is silently skipped—no JS errors, no console warnings.
      </P>

      <H2>Browser compatibility</H2>
      <Table
        headers={['Browser', 'Support', 'Notes']}
        rows={[
          ['Chrome', '✅', 'Full Web Audio API support'],
          ['Safari', '✅', 'Full Web Audio API support (iOS 14.5+)'],
          ['Firefox', '✅', 'Full Web Audio API support'],
          ['Edge', '✅', 'Full Web Audio API support'],
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
        Automatic light/dark detection, or override explicitly.
      </P>

      <H2>Auto-detect (default)</H2>
      <Code>{`
// System preference decides
// Dark system → dark hangout UI
// Light system → light hangout UI
<HangoutsRoom roomName="my-room" embedded />
      `}</Code>

      <H2>Explicit theme</H2>
      <Code>{`
<div data-hh-theme="dark">
  <HangoutsRoom roomName="my-room" embedded />
</div>
      `}</Code>

      <H2>CSS variables reference</H2>
      <Table
        headers={['Variable', 'Light', 'Dark', 'Purpose']}
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
          ['--hh-danger', '#ff4444', '#ff4444', 'Danger/error'],
          ['--hh-success', '#22c55e', '#22c55e', 'Success'],
        ]}
      />

      <H2>Override example</H2>
      <Code>{`
:root {
  --hh-primary: #0066ff;        // blue instead of red
  --hh-bg: #f9f9f9;             // slightly warm white
  --hh-text: #222222;           // softer black
}
      `}</Code>

      <H2>Per-component overrides</H2>
      <Code>{`
.my-hangout {
  --hh-primary: #0066ff;
  --hh-bg-secondary: #fafafa;
}

<div className="my-hangout">
  <HangoutsRoom roomName="my-room" embedded />
</div>
      `}</Code>
    </>
  );
}

function PremiumAndBans() {
  return (
    <>
      <H1>Premium & Bans</H1>
      <P>
        The server enforces video access and bans by checking 3speak's <code>embed-users</code>
        MongoDB collection. This is server-side—frontends cannot bypass it.
      </P>

      <H2>How premium works</H2>
      <Code>{`
User creates or joins a room
  ↓
Server checks embed-users collection for username
  ↓
If premium: true → LiveKit token allows video + screen share
If premium: false → LiveKit token allows audio only (canPublishSources: [MICROPHONE])
  ↓
Response includes isPremium: boolean
  ↓
Frontend can optionally hide video buttons (but server enforces the real rule)
      `}</Code>

      <H2>How bans work</H2>
      <Code>{`
User authenticates
  ↓
Server checks embed-users collection for banned: true
  ↓
If banned → 403 on ALL authenticated routes
  ↓
SDK throws HangoutsApiError with status 403
      `}</Code>

      <H2>Checking premium status</H2>
      <Code>{`
import { useHangoutsRoom } from '@snapie/hangouts-react';

function MyComponent() {
  const room = useHangoutsRoom();

  // After joining a room:
  console.log(room.isPremium); // boolean
}
      `}</Code>

      <H2>Without MongoDB</H2>
      <P>
        If <code>MONGODB_URI</code> is not configured, all users are treated as:
      </P>
      <ul className="docs__list">
        <li>Not banned</li>
        <li>Not premium (audio-only)</li>
      </ul>
      <P>
        This allows self-hosters to run Hangouts without a 3speak database.
      </P>

      <H2>Caching</H2>
      <P>
        User status (premium, banned) is cached in-memory for 60 seconds.
        Changes take up to 1 minute to take effect across the system.
      </P>
    </>
  );
}

function ApiReference() {
  return (
    <>
      <H1>API Reference</H1>
      <P>
        The Hangouts API runs at <code>https://hangout-api.3speak.tv</code> (customizable).
        All mutation endpoints require a Bearer token from the auth flow.
      </P>

      <H2>Response format</H2>
      <Code>{`
// Success
{ "data": {...} }

// Error
{ "statusCode": 401, "error": "Unauthorized", "message": "Invalid token" }
      `}</Code>

      <H2>Auth</H2>
      <Table
        headers={['POST', 'Endpoint', 'Auth', 'Body']}
        rows={[
          ['—', '/auth/challenge', 'No', '{ username: string }'],
          ['→', 'challenge: string, expires: number', '—', '—'],
          ['', '', '', ''],
          ['—', '/auth/verify', 'No', '{ username, challenge, signature }'],
          ['→', 'token: string, username: string', '—', '—'],
        ]}
      />

      <H2>Rooms</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Body / Returns']}
        rows={[
          ['GET', '/rooms', 'No', 'Returns: Room[]'],
          ['GET', '/rooms/:name', 'No', 'Returns: Room | null (404)'],
          ['POST', '/rooms', 'Yes', 'Body: { title, description?, backgroundImage?, visibility?, language?, boost? } Returns: { room, token, isPremium }'],
          ['POST', '/rooms/:name/join', 'Yes', 'Returns: { token, roomName, identity, isHost, isPremium }'],
          ['POST', '/rooms/:name/listen', 'No', 'Returns: { token, roomName, identity, isGuest, isPremium }'],
          ['DELETE', '/rooms/:name', 'Host', 'Closes room'],
        ]}
      />

      <H2>Participants</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Body']}
        rows={[
          ['PATCH', '/rooms/:name/participants/:identity/permissions', 'Host', '{ canPublish: boolean }'],
          ['DELETE', '/rooms/:name/participants/:identity', 'Host', '(no body)'],
        ]}
      />

      <H2>Recording</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Returns']}
        rows={[
          ['POST', '/rooms/:name/record/start', 'Host', '{ egressId, status }'],
          ['POST', '/rooms/:name/record/stop', 'Host', '{ egressId, filePath, duration }'],
          ['GET', '/rooms/:name/record/status', 'Yes', '{ recording, egressId? }'],
          ['GET', '/rooms/:name/record/file/:token', 'Host', 'File stream (audio/mpeg or video/mp4)'],
        ]}
      />

      <H2>Streaming</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Body / Returns']}
        rows={[
          ['POST', '/rooms/:name/stream/start', 'Host', 'Body: { rtmpUrl } Returns: { streamingId, status }'],
          ['POST', '/rooms/:name/stream/stop', 'Host', 'Returns: { status }'],
          ['GET', '/rooms/:name/stream/status', 'Yes', 'Returns: { streaming, streamingId?, url? }'],
        ]}
      />

      <H2>Boosts</H2>
      <Table
        headers={['Method', 'Endpoint', 'Auth', 'Body / Returns']}
        rows={[
          ['POST', '/boosts/ingest', 'No (feature-flagged)', 'Body: { txId, opIndex, blockNum, timestamp, to, amount, memo } Returns: { accepted: true }'],
          ['GET', '/boosts/ledger', 'No', 'Returns: Boost ledger rows; optional query: room'],
        ]}
      />

      <H2>Error codes</H2>
      <Table
        headers={['Code', 'Meaning']}
        rows={[
          ['200', 'OK'],
          ['400', 'Bad request (invalid body, missing params)'],
          ['401', 'Unauthorized (invalid/expired token)'],
          ['403', 'Forbidden (user banned, not host, not premium)'],
          ['404', 'Not found (room ended, participant left)'],
          ['409', 'Conflict (guest limit reached, room already recording)'],
          ['429', 'Too many requests (rate limited on /listen)'],
          ['500', 'Server error'],
        ]}
      />
    </>
  );
}

function Deployment() {
  return (
    <>
      <H1>Deployment</H1>
      <P>
        Deploy Hangouts in three parts: LiveKit SFU (VPS), Hangouts API (Node.js),
        and your React app (static hosting or server).
      </P>

      <H2>1. LiveKit SFU (required)</H2>
      <P>
        See <strong>the GitHub repo</strong> for the complete LiveKit deployment guide
        (<code>docs/livekit-server-setup.md</code>). Summary:
      </P>
      <ul className="docs__list">
        <li>Ubuntu 22.04+ VPS (2+ vCPU, 4+ GB RAM)</li>
        <li>Domain name (e.g., <code>livekit.yourproject.com</code>)</li>
        <li>Run LiveKit in Docker with Caddy reverse proxy (auto TLS)</li>
        <li>Open ports: 80, 443 (TCP/UDP), 3478/UDP, 50000–60000/UDP</li>
      </ul>
      <Code>{`
# Generate config
docker run --rm -it -v$PWD:/output livekit/generate

# Deploy to VPS
scp -r livekit.yourproject.com/ user@YOUR_IP:/tmp/
ssh user@YOUR_IP "cd /tmp/livekit.yourproject.com && sudo bash init_script.sh"

# Verify
curl https://livekit.yourproject.com/
      `}</Code>

      <H2>2. Hangouts API (Node.js)</H2>
      <P>
        The server is a Fastify app. Deploy to your infrastructure:
      </P>
      <Code>{`
# Clone repo
git clone https://github.com/Mantequilla-Soft/hangouts.git
cd hangouts/server

# Install + build
npm install
npm run build

# Configure
cp .env.example .env
# Edit .env:
#   LIVEKIT_HOST=https://livekit.yourproject.com
#   LIVEKIT_API_KEY=... (from step 1)
#   LIVEKIT_API_SECRET=...
#   SESSION_SECRET=... (generate 64-char random string)
#   MONGODB_URI=... (optional, for premium/bans)
#   BOOSTS_ENABLED=true
#   BOOST_PLATFORM_ACCOUNT=yourboostwallet
#   BOOST_PLATFORM_ACTIVE_KEY=5K... (active key; keep in secret manager)
#   BOOST_PLATFORM_FEE_PERCENT=5
#   BOOST_HIVE_USD_FALLBACK=0.25
#   BOOST_HIVE_USD_CACHE_MS=120000
#   PORT=3002

# Run (Docker or systemd)
npm start
      `}</Code>

      <H2>3. Your React App</H2>
      <Code>{`
# Install SDK
npm install @snapie/hangouts-react @livekit/components-react livekit-client

# Use provider
<HangoutsProvider
  apiBaseUrl="https://hangout-api.3speak.tv"  // your API domain
  livekitServerUrl="wss://livekit.yourproject.com"
>
  {children}
</HangoutsProvider>

# Deploy to Vercel, Netlify, etc.
npm run build
      `}</Code>

      <H2>Nginx reverse proxy (API)</H2>
      <P>
        If your API is not on a public port, use Nginx:
      </P>
      <Code>{`
upstream hangouts_api {
  server localhost:3002;
}

server {
  listen 443 ssl http2;
  server_name hangout-api.yourproject.com;

  ssl_certificate /etc/letsencrypt/live/...;
  ssl_certificate_key /etc/letsencrypt/live/...;

  location / {
    proxy_pass http://hangouts_api;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
  }
}
      `}</Code>

      <H2>Production checklist</H2>
      <ul className="docs__list">
        <li>☐ LiveKit deployed with TLS (443 TCP/UDP)</li>
        <li>☐ Hangouts API deployed with valid SSL certificate</li>
        <li>☐ SESSION_SECRET is a random 64-char string (use <code>openssl rand -hex 32</code>)</li>
        <li>☐ MONGODB_URI configured (if using premium/bans)</li>
        <li>☐ Boost env configured: <code>BOOSTS_ENABLED</code>, <code>BOOST_PLATFORM_ACCOUNT</code>, <code>BOOST_PLATFORM_ACTIVE_KEY</code>, fee + FX rates</li>
        <li>☐ Rate limiting enabled on <code>/auth/challenge</code> and <code>/rooms/:name/listen</code></li>
        <li>☐ CORS headers configured (allow your frontend domain)</li>
        <li>☐ Egress service deployed (if recording/streaming needed)</li>
        <li>☐ Monitoring alerts set up (API uptime, WebRTC errors)</li>
        <li>☐ Backup strategy for MongoDB (if used)</li>
      </ul>
    </>
  );
}

function IntegrationGuides() {
  return (
    <>
      <H1>Integration Guides</H1>

      <H2>Next.js / React (modal pattern)</H2>
      <P>Recommended for web apps:</P>
      <Code>{`
// 1. Create context for modal state
const HangoutContext = createContext<{ activeRoom: string | null } | null>(null);

// 2. At app root
{activeRoom && (
  <HangoutsProvider apiBaseUrl="...">
    <Modal onClose={() => setActiveRoom(null)}>
      <HangoutsRoom
        roomName={activeRoom}
        onLeave={() => setActiveRoom(null)}
        embedded
      />
    </Modal>
  </HangoutsProvider>
)}

// 3. Open from anywhere
<button onClick={() => setActiveRoom('room-name')}>
  Join Hangout
</button>
      `}</Code>

      <H2>React Native</H2>
      <Code>{`
npm install @snapie/hangouts-core @livekit/react-native

// Use HangoutsApiClient + LiveKit RN hooks
// Build your own UI with the API client
import { HangoutsApiClient } from '@snapie/hangouts-core';
const client = new HangoutsApiClient({ baseUrl: '...' });
      `}</Code>

      <H2>Recording with upload callback</H2>
      <Code>{`
async function uploadAudio(file: Blob, filename: string) {
  const formData = new FormData();
  formData.append('audio', file, filename);

  const res = await fetch('https://your-api.com/upload-audio', {
    method: 'POST',
    body: formData,
  });

  return res.json(); // { playUrl, ... }
}

<HangoutsRoom
  roomName="my-room"
  onAudioHandoff={(file) => {
    uploadAudio(file.blob, file.filename).then(result => {
      // Redirect to post composer or show success
      window.location.href = '/compose?audio=' + result.playUrl;
    });
  }}
  embedded
/>
      `}</Code>

      <H2>Self-hosting</H2>
      <P>
        Full self-hosting requires: LiveKit (Docker), Fastify API (Node.js), MongoDB (optional),
        Redis (for LiveKit state). See <strong>Deployment</strong> section.
      </P>
    </>
  );
}

function AiAgents() {
  return (
    <>
      <H1>AI Agent Guide</H1>
      <P>
        This section provides exact specifications, type contracts, error matrices, and behavior
        guarantees for code generation and integration by AI agents.
      </P>

      <H2>JSON Schemas</H2>

      <H3>Room</H3>
      <Code>{`
{
  "name": "string",               // unique, immutable, alphanumeric + dash
  "title": "string",              // user-facing, mutable
  "host": "string",               // Hive username
  "description": "string",         // optional
  "visibility": "public|hive-internal|unlisted",  // optional, default: public
  "origin": "string",             // hostname that created the room
  "numParticipants": "number",    // current count
  "createdAt": "ISO8601 string",  // e.g. "2026-05-12T14:30:00Z"
  "livekitToken": "string",       // JWT for WebRTC connection (not returned in list)
  "isPremium": "boolean"          // only in response to /join, /create (indicates user status)
}
      `}</Code>

      <H3>AuthSession</H3>
      <Code>{`
{
  "token": "string",              // Bearer JWT, 24h TTL, signed with SESSION_SECRET
  "username": "string"            // Hive username
}
      `}</Code>

      <H3>JoinRoomResponse</H3>
      <Code>{`
{
  "token": "string",              // LiveKit token (45 min TTL)
  "roomName": "string",
  "identity": "string",           // "alice" or "guest-a1b2c3d4"
  "isHost": "boolean",
  "isGuest": "boolean",           // true if identity starts with "guest-"
  "isPremium": "boolean"          // false for guests, checked from embed-users
}
      `}</Code>

      <H3>HandRaiseEvent (data channel message)</H3>
      <Code>{`
{
  "type": "hand_raise",
  "raised": "boolean",            // true = raise, false = lower
  "identity": "string",           // who raised/lowered
  "timestamp": "number"           // unix ms
}
      `}</Code>

      <H3>ChatMessage (data channel)</H3>
      <Code>{`
{
  "type": "chat_message",
  "identity": "string",
  "text": "string",
  "timestamp": "number",
  "username": "string"            // resolved Hive username (if available)
}
      `}</Code>

      <H3>RecordingStopResponse</H3>
      <Code>{`
{
  "egressId": "string",           // LiveKit egress ID
  "status": "finished|failed",
  "filePath": "string",           // /tmp/livekit-recordings/roomname-timestamp.mp3
  "duration": "number"            // seconds (actual recorded duration)
}
      `}</Code>

      <H3>StreamingStartResponse</H3>
      <Code>{`
{
  "streamingId": "string",        // LiveKit streaming ID
  "status": "started|failed",
  "rtmpUrl": "string"             // echo of input (for UI confirmation)
}
      `}</Code>

      <H2>Error Matrix</H2>

      <H3>Authentication</H3>
      <Table
        headers={['Endpoint', 'Code', 'Condition']}
        rows={[
          ['POST /auth/challenge', '400', 'Missing username'],
          ['POST /auth/challenge', '400', 'Username contains invalid chars'],
          ['POST /auth/verify', '400', 'Missing username, challenge, or signature'],
          ['POST /auth/verify', '401', 'Signature does not match on-chain posting key'],
          ['POST /auth/verify', '401', 'Challenge expired (> 15 min old)'],
          ['POST /auth/verify', '403', 'Username is banned (banned: true in embed-users)'],
        ]}
      />

      <H3>Room Operations</H3>
      <Table
        headers={['Endpoint', 'Code', 'Condition']}
        rows={[
          ['POST /rooms', '400', 'Title missing or empty'],
          ['POST /rooms', '401', 'No valid session token'],
          ['POST /rooms', '403', 'User is banned'],
          ['GET /rooms/:name', '404', 'Room does not exist or has ended'],
          ['POST /rooms/:name/join', '401', 'No valid token'],
          ['POST /rooms/:name/join', '403', 'User is banned or premium check failed'],
          ['POST /rooms/:name/join', '404', 'Room does not exist or has ended'],
          ['DELETE /rooms/:name', '403', 'Caller is not the host'],
          ['DELETE /rooms/:name', '404', 'Room does not exist'],
        ]}
      />

      <H3>Guest Listening</H3>
      <Table
        headers={['Endpoint', 'Code', 'Condition']}
        rows={[
          ['POST /rooms/:name/listen', '404', 'Room does not exist'],
          ['POST /rooms/:name/listen', '403', 'Room visibility is hive-internal (guests rejected)'],
          ['POST /rooms/:name/listen', '409', 'Per-room guest cap reached (default 100)'],
          ['POST /rooms/:name/listen', '429', 'Rate limit: >10 requests per 5 min from this IP'],
        ]}
      />

      <H3>Moderation</H3>
      <Table
        headers={['Endpoint', 'Code', 'Condition']}
        rows={[
          ['PATCH /permissions', '403', 'Caller is not the host'],
          ['PATCH /permissions', '400', 'Target identity starts with "guest-" (guests cannot be promoted)'],
          ['DELETE /participants/:id', '403', 'Caller is not the host'],
          ['DELETE /participants/:id', '404', 'Participant is not in room'],
        ]}
      />

      <H3>Recording/Streaming</H3>
      <Table
        headers={['Endpoint', 'Code', 'Condition']}
        rows={[
          ['POST /record/start', '403', 'Caller is not the host'],
          ['POST /record/start', '409', 'Recording already in progress'],
          ['POST /record/stop', '403', 'Caller is not the host'],
          ['POST /record/stop', '409', 'No recording in progress'],
          ['POST /stream/start', '403', 'Caller is not the host'],
          ['POST /stream/start', '400', 'Invalid RTMP URL'],
          ['POST /stream/start', '409', 'Stream already in progress'],
        ]}
      />

      <H2>State machine contracts</H2>

      <H3>Room states</H3>
      <Code>{`
CREATED → (any participant joins) → ACTIVE → (all leave or host ends) → ENDED

Properties:
- CREATED: numParticipants = 0
- ACTIVE: numParticipants ≥ 1, LiveKit room exists
- ENDED: All participants disconnected, room deleted from API (404 on next GET)
      `}</Code>

      <H3>Recording states</H3>
      <Code>{`
NOT_RECORDING → (POST /record/start) → RECORDING → (POST /record/stop) → FINALIZED

Guarantees:
- Only host can start/stop
- Only one recording per room at a time
- filePath is set and valid after FINALIZED
- File persists for 24h (or configurable TTL) before deletion
- Only one active Egress process per room
      `}</Code>

      <H3>Streaming states</H3>
      <Code>{`
NOT_STREAMING → (POST /stream/start) → STREAMING → (POST /stream/stop) → ENDED

Guarantees:
- Only host can start/stop
- Only one stream per room at a time
- RTMP connection must be valid before state changes to STREAMING
- If RTMP connection drops, state remains STREAMING (manual stop required)
      `}</Code>

      <H2>Participant identity contract</H2>
      <Code>{`
Authenticated user: <username>
  Example: "alice"
  - Chosen by user at auth time
  - Immutable for session
  - Can be promoted to host or speaker

Guest: "guest-<12 random chars>"
  Example: "guest-a1b2c3d4e5f6"
  - Server-assigned, client-never-picks
  - Cannot be promoted, kicked, or demoted
  - Cannot publish audio, chat, or data
  - Listen-only
  - TTL: 2 hours (after expiry, must re-join via /listen)
      `}</Code>

      <H2>Data channel protocols</H2>

      <H3>chat topic</H3>
      <Code>{`
Outbound (send):
{ "type": "chat_message", "text": "..." }

Inbound (receive):
{ "type": "chat_message", "identity": "...", "text": "...", "timestamp": ... }

Constraints:
- Max 500 chars per message
- Identity is set by sender (not trusted; use LiveKit participant ID for auth)
- Guests cannot send (canPublishData: false in JWT)
- Rate limit: 5 msgs/sec per identity
      `}</Code>

      <H3>hand-raise topic</H3>
      <Code>{`
Outbound (send):
{ "type": "hand_raise", "raised": true|false }

Inbound (receive):
{ "type": "hand_raise", "raised": true|false, "identity": "...", "timestamp": ... }

Constraints:
- Guests can raise hands (listeners can request to speak)
- Server enforces "cannot promote guest" in PATCH /permissions
- Throttled: only one state change per 1 second per identity
- No response from server; message is pure p2p broadcast
      `}</Code>

      <H2>Rate limits</H2>
      <Table
        headers={['Endpoint', 'Limit', 'Scope', 'Returns']}
        rows={[
          ['POST /auth/challenge', '10/min', 'Per username', '429'],
          ['POST /auth/verify', '5/min', 'Per IP', '429'],
          ['POST /rooms/:name/listen', '10 / 5min', 'Per IP', '429'],
          ['data channel (chat)', '5/sec', 'Per identity', 'message dropped'],
          ['data channel (hand-raise)', '1/sec', 'Per identity', 'message dropped'],
        ]}
      />

      <H2>LiveKit token structure</H2>
      <Code>{`
All tokens signed by LIVEKIT_API_SECRET, valid for 45 minutes.

Host token grants:
  roomJoin: true
  canPublish: true
  canPublishData: true
  canSubscribe: true
  canPublishSources: [CAMERA, MICROPHONE, SCREEN_SHARE]

Speaker token grants:
  roomJoin: true
  canPublish: true
  canPublishData: true
  canSubscribe: true
  canPublishSources: [MICROPHONE]           (or + CAMERA/SCREEN if premium)

Listener token grants:
  roomJoin: true
  canPublish: false
  canPublishData: false
  canSubscribe: true

Guest token grants (same as listener):
  roomJoin: true
  canPublish: false
  canPublishData: false
  canSubscribe: true
      `}</Code>

      <H2>Concurrency guarantees</H2>
      <Code>{`
Concurrent operations that are safe (no race conditions):
- Multiple users joining the same room
- Multiple users sending chat messages
- Multiple users raising hands
- Host recording while users join/leave

Concurrent operations that are NOT safe (race conditions possible):
- Multiple hosts trying to promote the same listener
  → Last write wins (PATCH /permissions)
- Multiple hosts trying to delete the room
  → First succeeds, second gets 404
- Host ending room while host transfer in progress
  → Room ends immediately, transfer fails with 404

Best practice: use optimistic locking or request deduplication on client.
      `}</Code>

      <H2>Offline / error recovery</H2>
      <Code>{`
Network goes down during hangout:
- LiveKit WebRTC connection drops (participant disappears)
- Reconnection: automatic via LiveKit SDK (exponential backoff, 30s max)
- After 30s+ offline: user must manually rejoin room

Network goes down during /rooms POST (create):
- Request never reaches server → timeout
- Safe to retry: if room was created, POST is idempotent (returns existing room)
- If timeout, check GET /rooms/:name before retrying

Network goes down during /record/start:
- Request never reaches server → timeout
- Safe to retry: idempotent (if already recording, returns current status)
- Do NOT re-call /record/stop until sure /record/start succeeded
      `}</Code>

      <H2>Callback contract for UI components</H2>
      <Code>{`
onLeave: () => void
  Called when: user clicks Leave, or disconnected from LiveKit
  Guarantee: called exactly once per component mount
  Action: hide the room, return to lobby

onError: (error: Error) => void
  Called when: WebRTC error, auth error, network error
  Guarantee: error.message is human-readable
  Action: show error toast, allow retry or return to lobby

onAudioHandoff: (file: { blob, filename, duration, size }) => void
  Called when: host stops recording audio
  Guarantee: blob is valid MP3, duration in seconds, size in bytes
  Action: upload blob to your service, get back a URL

onVideoHandoff: (file: { blob, filename, duration, size }) => void
  Called when: host stops recording video
  Guarantee: blob is valid MP4, duration in seconds, size in bytes
  Action: upload blob to your service, get back a URL

onRecordingUploaded: (result: { permlink, cid, playUrl }) => void [legacy]
  Called when: legacy upload endpoint succeeds
  Guarantee: playUrl is immediately playable
  Action: redirect to post composer or show success
      `}</Code>
    </>
  );
}

// ─── Events & Presence ────────────────────────────────────────────────────────

function EventsPresence() {
  return (
    <>
      <H1>Events & Presence</H1>
      <p>
        Scheduled events let hosts announce upcoming OpenPods / Hangouts ahead of time. Listeners
        can RSVP, and when the host is ready to go live, a single API call creates the LiveKit
        room and transitions the event to <code>live</code>. Presence endpoints let any frontend
        show "X is live right now" badges without requiring a Hive login.
      </p>

      <H2>Event lifecycle</H2>
      <Code lang="text">{`
scheduled ──▶ live ──▶ ended
     │
     └──────▶ cancelled
      `}</Code>
      <p>
        A host creates an event (<code>scheduled</code>), clicks Start when ready (<code>live</code>
        ), and the room ends automatically or the host stops it (<code>ended</code>). Cancelling
        before going live sets <code>cancelled</code> instead.
      </p>

      <H2>TypeScript types</H2>
      <Code lang="typescript">{`
import type {
  HangoutsEvent,
  CreateEventInput,
  UpdateEventInput,
  UserPresence,
  StartEventResponse,
  EventStatus,
  EventVisibility,
} from '@snapie/hangouts-core';

interface HangoutsEvent {
  id: string;
  title: string;
  description?: string;
  hostUsername: string;
  scheduledAt: string;        // ISO-8601
  coverImage?: string;
  tags?: string[];
  attendees: string[];        // Hive usernames
  attendeeCount: number;
  status: EventStatus;        // 'scheduled' | 'live' | 'ended' | 'cancelled'
  roomName?: string;          // null until host calls startEvent()
  visibility: EventVisibility; // 'public' | 'unlisted'
  createdAt: string;
  updatedAt: string;
}

interface UserPresence {
  online: boolean;
  roomName?: string;
  roomTitle?: string;
  role?: 'host' | 'speaker' | 'listener';
}

interface StartEventResponse {
  event: HangoutsEvent;
  room: Room;         // LiveKit room object
  token: string;     // host access token — pass to <HangoutsRoom />
  isPremium: boolean;
}
      `}</Code>

      <H2>React hooks</H2>

      <H3>useEventList — upcoming events widget</H3>
      <Code lang="typescript">{`
import { useEventList } from '@snapie/hangouts-react';

function UpcomingEvents() {
  const { events, isLoading, error, refetch } = useEventList({
    status: 'scheduled',   // filter by status (optional)
    limit: 10,             // default 20
    pollInterval: 30_000,  // auto-refresh every 30 s (optional)
  });

  if (isLoading) return <p>Loading...</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <ul>
      {events.map(ev => (
        <li key={ev.id}>
          <strong>{ev.title}</strong> by @{ev.hostUsername}
          <br />
          {new Date(ev.scheduledAt).toLocaleString()} · {ev.attendeeCount} attending
        </li>
      ))}
    </ul>
  );
}
      `}</Code>

      <H3>useUserPresence — "live now" badge</H3>
      <Code lang="typescript">{`
import { useUserPresence } from '@snapie/hangouts-react';

function LiveBadge({ username }: { username: string }) {
  const { presence, isLoading } = useUserPresence(username, {
    pollInterval: 15_000, // check every 15 s
  });

  if (isLoading || !presence?.online) return null;

  return (
    <span className="live-badge">
      🔴 Live in "{presence.roomTitle}"
    </span>
  );
}
      `}</Code>

      <H2>API client methods</H2>
      <Code lang="typescript">{`
import { HangoutsApiClient } from '@snapie/hangouts-core';

const client = new HangoutsApiClient({
  baseUrl: 'https://your-hangouts-server.com',
  sessionToken: userSession, // optional — omit for public reads
});

// ── Public (no session required) ──────────────────────────────────

// List events (also available as plain fetch — see below)
const events = await client.listEvents({ status: 'scheduled', limit: 20 });

// Single event
const event = await client.getEvent('64f1a2b3c4d5e6f7a8b9c0d1');

// User presence
const presence = await client.getUserPresence('ausbitbank');
// → { online: true, roomName: 'ausbitbank-ama-x7k2', roomTitle: 'AMA', role: 'host' }

// Bulk presence (max 50 usernames)
const map = await client.getBulkPresence(['ausbitbank', 'tibfox', 'meno']);
// → { ausbitbank: { online: true, ... }, tibfox: { online: false }, meno: { online: false } }

// ── Protected (session required) ──────────────────────────────────

// Create event
const newEvent = await client.createEvent({
  title: 'Weekly AMA',
  description: 'Ask me anything about Hive.',
  scheduledAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  visibility: 'public',
  tags: ['ama', 'hive'],
});

// Update while still scheduled
await client.updateEvent(newEvent.id, { title: 'Weekly AMA — Round 2' });

// RSVP
await client.attendEvent(newEvent.id);
await client.unattendEvent(newEvent.id); // idempotent

// Host goes live — creates the LiveKit room and returns a token
const { event, token } = await client.startEvent(newEvent.id);
// Pass token to <HangoutsRoom token={token} room={event.roomName} />

// Cancel (sets status → 'cancelled')
await client.cancelEvent(newEvent.id);
      `}</Code>

      <H2>Plain fetch — no SDK required</H2>
      <p>
        <code>GET /events</code> is public and CORS-open. Any frontend can call it with a bare
        <code>fetch()</code> — no Hive login, no SDK install.
      </p>
      <Code lang="javascript">{`
// Embed upcoming Hangouts anywhere — no SDK needed
const res = await fetch('https://your-hangouts-server.com/events?status=scheduled&limit=5');
const events = await res.json();

// events[0] shape:
// {
//   id, title, hostUsername, scheduledAt, attendeeCount,
//   coverImage, description, tags, status, visibility
// }
      `}</Code>
      <Code lang="javascript">{`
// Bulk presence check — also public
const res = await fetch('https://your-hangouts-server.com/presence/bulk', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ usernames: ['ausbitbank', 'tibfox'] }),
});
const presenceMap = await res.json();
// { ausbitbank: { online: true, roomName: '...', role: 'host' }, tibfox: { online: false } }
      `}</Code>

      <H2>Server API reference</H2>
      <table className="docs__table">
        <thead>
          <tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td>/events</td><td>Public</td><td>List events. Query: <code>?status=&host=&limit=</code></td></tr>
          <tr><td>GET</td><td>/events/:id</td><td>Public</td><td>Single event by MongoDB id</td></tr>
          <tr><td>POST</td><td>/events</td><td>Required</td><td>Create event (host = session user)</td></tr>
          <tr><td>PATCH</td><td>/events/:id</td><td>Required</td><td>Update while <code>scheduled</code> (host only)</td></tr>
          <tr><td>DELETE</td><td>/events/:id</td><td>Required</td><td>Cancel/end event (host only)</td></tr>
          <tr><td>POST</td><td>/events/:id/attend</td><td>Required</td><td>Mark attending (idempotent)</td></tr>
          <tr><td>DELETE</td><td>/events/:id/attend</td><td>Required</td><td>Remove attendance (idempotent)</td></tr>
          <tr><td>POST</td><td>/events/:id/start</td><td>Required</td><td>Go live: creates room, returns token</td></tr>
          <tr><td>GET</td><td>/presence/:username</td><td>Public</td><td>Single-user presence</td></tr>
          <tr><td>POST</td><td>/presence/bulk</td><td>Public</td><td>Up to 50 usernames per call</td></tr>
        </tbody>
      </table>

      <H2>Gotchas</H2>
      <ul>
        <li>
          <strong><code>event.roomName</code> is <code>null</code> until the host calls
          <code>startEvent()</code>.</strong> Always check <code>event.status === 'live'</code>
          before linking to a room.
        </li>
        <li>
          <strong>Do not call <code>POST /rooms</code> separately for events.</strong>{' '}
          <code>POST /events/:id/start</code> creates the LiveKit room internally and links it to
          the event. Creating a room manually will leave it unlinked.
        </li>
        <li>
          <strong>Presence is real-time LiveKit state, not scheduled intent.</strong> A user can
          be scheduled to host an event but show <code>online: false</code> until they click
          Start. Use <code>event.status</code> for scheduling state and <code>/presence</code>{' '}
          for actual connection state.
        </li>
        <li>
          <strong><code>/presence/bulk</code> is rate-limited to 20 req/min per IP</strong> and
          accepts a maximum of 50 usernames per call. Batch large lists client-side.
        </li>
        <li>
          <strong>MongoDB must be configured</strong> via <code>MONGODB_URI</code> in the
          server's <code>.env</code> for events to persist. Without it the server starts normally
          but all event writes return 503.
        </li>
      </ul>
    </>
  );
}

function Games() {
  return (
    <>
      <H1>Games &amp; Results</H1>
      <p>
        Hangouts ships three built-in game plugins that run inside any live room.
        Games are started by the host; all active speakers play automatically while
        audience members spectate. When a game is active, the room layout shifts
        automatically — the board occupies the center stage and speakers shrink to
        a compact avatar strip above it. No extra props are needed to trigger this.
      </p>

      <H2>Available games</H2>
      <table className="docs__table">
        <thead>
          <tr><th>gameId</th><th>Name</th><th>Players</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>chess</code></td><td>Chess</td><td>2</td><td>Standard chess. Move until checkmate, stalemate, or a player resigns.</td></tr>
          <tr><td><code>fast-draw</code></td><td>Fast Draw</td><td>2–8</td><td>Pictionary-style. One player draws, others guess. First to a score threshold wins.</td></tr>
          <tr><td><code>word-guess</code></td><td>Word Guess</td><td>2–8</td><td>Hangman-style cooperative word guessing with themed word packs.</td></tr>
        </tbody>
      </table>

      <H2>Receiving results — onGameEnd</H2>
      <p>
        Add <code>onGameEnd</code> to <code>&lt;HangoutsRoom&gt;</code> to receive a structured
        snapshot when any game session ends (win, resign, or host abort). Use it to post results
        to the Hive blockchain, create a snap, update a leaderboard, etc.
      </p>
      <Code lang="tsx">{`
import type { GameResultPayload, ChessGameResult, FastDrawGameResult } from '@snapie/hangouts-react';

<HangoutsRoom
  roomName={roomName}
  onGameEnd={(result) => {
    console.log(result.gameId);   // 'chess' | 'fast-draw' | 'word-guess'
    console.log(result.players);  // ['alice', 'bob']  ← Hive usernames; not spectators
    console.log(result.startedAt); // Unix ms
    console.log(result.endedAt);   // Unix ms
    console.log(result.duration);  // seconds
    console.log(result.result);    // game-specific state — cast based on gameId
  }}
/>
      `}</Code>

      <H2>GameResultPayload shape</H2>
      <Code lang="typescript">{`
interface GameResultPayload {
  gameId: string;       // 'chess' | 'fast-draw' | 'word-guess'
  players: string[];    // Hive usernames of players (not spectators)
  startedAt: number;    // Unix ms
  endedAt: number;      // Unix ms
  duration: number;     // seconds
  result: unknown;      // game-specific — cast based on gameId
}
      `}</Code>

      <H3>Chess result (gameId === 'chess')</H3>
      <Code lang="typescript">{`
import type { ChessGameResult } from '@snapie/hangouts-react';

// Inside onGameEnd:
if (result.gameId === 'chess') {
  const chess = result.result as ChessGameResult;
  // chess.fen          → final board position (FEN string)
  // chess.players      → { w: 'alice', b: 'bob' }
  // chess.status       → 'checkmate' | 'resigned' | 'draw' | 'stalemate'
  // chess.winner       → 'alice' or null for draw
  // chess.moveHistory  → ['e4', 'e5', 'Nf3', 'Nc6', ...] (SAN notation)
}
      `}</Code>

      <H3>Fast Draw result (gameId === 'fast-draw')</H3>
      <Code lang="typescript">{`
import type { FastDrawGameResult } from '@snapie/hangouts-react';

if (result.gameId === 'fast-draw') {
  const fd = result.result as FastDrawGameResult;
  // fd.winners  → ['alice']  (Hive usernames)
  // fd.scores   → { alice: 3, bob: 1 }
  // fd.phase    → 'game_over'
  // fd.roundNumber → how many rounds were played
}
      `}</Code>

      <H2>Post results to Hive blockchain</H2>
      <p>
        Pass the result to Aioha, Hive Keychain, or any signing library to broadcast
        a <code>custom_json</code> operation. The example below uses Aioha.
      </p>
      <Code lang="tsx">{`
<HangoutsRoom
  onGameEnd={async (result) => {
    if (result.gameId === 'chess') {
      const chess = result.result as ChessGameResult;

      await aioha.broadcastCustomJson(
        'active',               // or 'posting'
        'hangouts_chess_result',
        {
          app: 'snapie/1.0',
          room: roomName,
          players: result.players,
          winner: chess.winner,
          status: chess.status,
          pgn: chess.moveHistory.join(' '),
          duration: result.duration,
        }
      );
    }

    if (result.gameId === 'fast-draw') {
      const fd = result.result as FastDrawGameResult;

      await aioha.broadcastCustomJson(
        'active',
        'hangouts_fastdraw_result',
        {
          app: 'snapie/1.0',
          room: roomName,
          players: result.players,
          winners: fd.winners,
          scores: fd.scores,
          duration: result.duration,
        }
      );
    }
  }}
/>
      `}</Code>

      <H2>Create a snap from game results</H2>
      <Code lang="tsx">{`
<HangoutsRoom
  onGameEnd={(result) => {
    if (result.gameId === 'chess') {
      const chess = result.result as ChessGameResult;
      const body = chess.winner
        ? \`@\${chess.winner} wins by \${chess.status}! PGN: \${chess.moveHistory.slice(0, 6).join(' ')}...\`
        : \`Chess ended in a \${chess.status}.\`;
      postSnap(body); // your snap creation function
    }
  }}
/>
      `}</Code>

      <H2>Direct hook access</H2>
      <p>
        For custom in-room game UI, mount the game hooks inside a component that lives
        within <code>&lt;HangoutsRoom&gt;</code> (they require a LiveKit room context):
      </p>
      <Code lang="typescript">{`
import { useChess, useFastDraw, useWordGuess } from '@snapie/hangouts-react';

function MyChessPanel({ roomName }: { roomName: string }) {
  const {
    active, fen, myColor, players, status, winner,
    moveHistory, isMyTurn, makeMove, resign, isSpectator,
  } = useChess({ roomName });

  if (!active) return null;
  // render your custom chess board...
}

function MyFastDrawPanel({ roomName }: { roomName: string }) {
  const {
    active, phase, isDrawer, word, wordLength, scores,
    winners, submitGuess, syncCanvas,
  } = useFastDraw({ roomName });

  // render your custom drawing canvas...
}
      `}</Code>
      <p>
        Hooks hydrate from the server on mount, so late joiners and spectators
        automatically receive the current game state without needing to catch
        up on missed events.
      </p>

      <H2>Server API</H2>
      <table className="docs__table">
        <thead>
          <tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td>/games</td><td>Public</td><td>List available game plugins</td></tr>
          <tr><td>GET</td><td>/game-collections</td><td>Public</td><td>List word collections for Word Guess</td></tr>
          <tr><td>GET</td><td>/rooms/:name/game</td><td>Required</td><td>Active game state (per-participant view)</td></tr>
          <tr><td>POST</td><td>/rooms/:name/game/start</td><td>Required (host)</td><td>Start a game. Body: <code>&#123; gameId, config? &#125;</code></td></tr>
          <tr><td>POST</td><td>/rooms/:name/game/action</td><td>Required</td><td>Submit a game action. Body: <code>&#123; action &#125;</code></td></tr>
          <tr><td>DELETE</td><td>/rooms/:name/game</td><td>Required (host)</td><td>End the active game</td></tr>
        </tbody>
      </table>

      <H2>Gotchas</H2>
      <ul>
        <li>
          <strong><code>onGameEnd</code> is not called if the server has no session data</strong>{' '}
          (e.g., the game:ended message arrived without a payload — possible with older server
          versions). Always guard against missing fields.
        </li>
        <li>
          <strong>Host abort sends the mid-game state as <code>result</code></strong>, not a
          terminal game-over state. Check <code>status</code> (chess) or <code>phase</code>{' '}
          (fast-draw) to distinguish a natural end from an abort.
        </li>
        <li>
          <strong>The game board stays visible for ~6 seconds after <code>onGameEnd</code> fires</strong>{' '}
          — the layout exit is intentionally delayed so players can read the final result.
          If you start async blockchain work in <code>onGameEnd</code>, it runs during this
          window — no need to rush.
        </li>
        <li>
          <strong>Chess <code>moveHistory</code> is in SAN notation</strong> — e.g.{' '}
          <code>['e4', 'e5', 'Nf3']</code>. Use it as a PGN move list for replays or analysis.
        </li>
      </ul>
    </>
  );
}
