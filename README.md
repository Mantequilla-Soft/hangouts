# Hive Hangouts

Twitter Spaces-style live audio rooms for the [Hive](https://hive.io) blockchain.

## What is this?

Live audio rooms where anyone with a Hive account can host or join conversations. Authentication is done via Hive Keychain — no new accounts, no passwords. Your Hive identity is your hangout identity.

## Architecture

```
React frontend  ──────────────── LiveKit SFU (self-hosted)
    │           WebRTC audio          │
    │           + signaling           │
    │                                 │
    └──── Fastify API ───────────────┘
          (auth + tokens)        server SDK calls

Hive Blockchain ← signature verification
images.3speak.tv ← background image uploads (direct from browser)
```

Three components:

- **LiveKit SFU** — open-source WebRTC server handling real-time audio routing, room state, and participant management. Self-hosted on a VPS.
- **Fastify API** (`server/`) — thin auth gateway. Verifies Hive signatures, issues LiveKit tokens, enforces host-only permissions.
- **React SDK** (`packages/`) — embeddable component library published to npm. Frontends drop in `<HangoutsProvider>` and get a full rooms UI.

## Features

- **Hive Keychain / HiveAuth login** — challenge-response auth using your posting key
- **Create & join rooms** — host starts a room, others join via lobby or direct link
- **Background image** — host sets a room background image at creation time; persists across sessions via localStorage
- **Audio** — real-time voice via LiveKit (WebRTC)
- **Video** — optional camera + screen share for premium users
- **Hand raising** — listeners request to speak via data channel
- **Speaker management** — host promotes/demotes participants
- **Moderation** — host can mute, kick, or end the room
- **Recording** — host records the room audio; upload to 3speak as a podcast
- **Live streaming** — stream to YouTube or Twitch directly from the room
- **Hive avatars** — profile pictures pulled from on-chain metadata

## Project Structure

```
hangouts/
  server/           Fastify API (Hive auth + LiveKit tokens)
  packages/
    sdk-core/       @snapie/hangouts-core — API client + TypeScript types
    sdk-react/      @snapie/hangouts-react — React components + hooks
  demo/             Reference integration (Vite + React)
  docs/             LiveKit deployment guide
```

## SDK Usage

```bash
npm install @snapie/hangouts-core @snapie/hangouts-react
```

```tsx
import { HangoutsProvider, RoomLobby, HangoutsRoom } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

<HangoutsProvider
  apiBaseUrl="https://your-api.example.com"
  livekitServerUrl="wss://your-livekit.example.com"
  imageServerApiKey={process.env.VITE_IMAGE_SERVER_API_KEY}  // optional — enables background image picker
  sessionToken={token}   // from Hive Keychain auth flow
  username={username}
>
  <RoomLobby onJoinRoom={(name) => setRoom(name)} />
</HangoutsProvider>
```

### `HangoutsProvider` props

| Prop | Required | Description |
|------|----------|-------------|
| `apiBaseUrl` | Yes | URL of your Fastify server |
| `livekitServerUrl` | No | LiveKit websocket URL (default: `wss://livekit.3speak.tv`) |
| `sessionToken` | No | JWT from the auth flow |
| `username` | No | Authenticated Hive username |
| `imageServerApiKey` | No | Bearer token for `images.3speak.tv` — enables the background image picker in Create Room |

## Server API

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /auth/challenge` | No | Get a nonce to sign with Hive Keychain |
| `POST /auth/verify` | No | Verify signature → session JWT |
| `GET /rooms` | No | List active rooms |
| `GET /rooms/:name` | No | Get a single room |
| `POST /rooms` | Yes | Create a room (caller becomes host) |
| `POST /rooms/:name/join` | Yes | Join a room as listener |
| `DELETE /rooms/:name` | Host | End the room |
| `PATCH /rooms/:name/participants/:id/permissions` | Host | Promote/demote speaker |
| `DELETE /rooms/:name/participants/:id` | Host | Kick participant |
| `POST /rooms/:name/record/start` | Host | Start recording |
| `POST /rooms/:name/record/stop` | Host | Stop recording |
| `GET /rooms/:name/record/status` | Host | Recording status |
| `POST /rooms/:name/record/upload` | Host | Upload recording to 3speak |
| `POST /rooms/:name/stream/start` | Host | Start streaming to YouTube/Twitch |
| `POST /rooms/:name/stream/stop` | Host | Stop streaming |
| `GET /rooms/:name/stream/status` | Host | Stream status |

## Setup

### Prerequisites

- Node.js 20+
- A running LiveKit server (see `docs/livekit-server-setup.md`)

### Server

```bash
cd server
cp .env.example .env
# Edit .env with your LiveKit credentials and session secret
npm install
npm run dev
```

### Demo app

```bash
cd demo
cp .env.example .env
# Set VITE_API_URL, VITE_LIVEKIT_URL, and VITE_IMAGE_SERVER_API_KEY
npm install
npm run dev
```

### Environment variables (demo)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Your Fastify server URL |
| `VITE_LIVEKIT_URL` | LiveKit websocket URL |
| `VITE_IMAGE_SERVER_API_KEY` | Bearer token for `images.3speak.tv` background uploads |

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Server**: Fastify 5
- **Auth**: @hiveio/dhive (signature verification) + jose (session JWTs)
- **Real-time audio**: LiveKit (self-hosted SFU)
- **Client**: React + @livekit/components-react
- **Image hosting**: images.3speak.tv

## License

MIT
