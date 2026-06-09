# Hive Hangouts

Twitter Spaces-style live audio rooms for the [Hive](https://hive.io) blockchain.

## What is this?

Live audio rooms where anyone with a Hive account can host or join conversations. Authentication uses Hive Keychain or any [Aioha](https://aioha.dev)-compatible provider (HiveAuth, PeakVault, Ledger, MetaMask Snap) — no new accounts, no passwords. A custodial path (e.g. Google-login-backed accounts) is also supported via a thin `AiohaLike` adapter. Your Hive identity is your hangout identity.

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
- **Guest listener mode** — anonymous viewers can drop into a public room as listen-only `guest-*` participants (no Hive account required) via `POST /rooms/:name/listen`. Guests can't chat, raise hands, or be promoted. Per-IP rate-limited; per-room cap.
- **Room visibility tiers** — `public` (listed, guests OK), `hive-internal` (listed, Hive-only — guest tokens rejected), or `unlisted` (link-only, hidden from `/rooms`). Stored on the room metadata; the host picks at creation time.
- **Create & join rooms** — host starts a room, others join via lobby or direct link
- **Share button** — built-in copy/Web-Share button in the room header. The integrator supplies a `getShareUrl(roomName, origin)` builder so shared links land back on the surface that created the room (`Room.origin` is captured server-side from the create request's `Origin` header).
- **Background image** — host sets a room background image at creation time; persists across sessions via localStorage
- **Audio** — real-time voice via LiveKit (WebRTC)
- **Video** — optional camera + screen share for premium users
- **Hand raising** — listeners request to speak via data channel
- **Speaker management** — host promotes/demotes participants. Newly-promoted speakers start with mic and camera **off** so they can compose themselves before the room hears them.
- **Live host transfer** — host can hand the role to any speaker; UI updates everywhere via room metadata (`useLiveHost` hook), no reconnection required.
- **Moderation** — host can mute, kick, or end the room
- **Recording** — start audio or video; on stop the host gets a 3-button dialog (Upload · Download · Dismiss). Upload is callback-driven: the SDK hands the integrator the raw blob and the integrator chooses where to publish (3Speak Studio, podcast uploader, IPFS, etc.). The Upload button is hidden when no callback is wired for that mode.
- **Live streaming** — stream to YouTube or Twitch directly from the room
- **Boost messages (superchat)** — validated HIVE/HBD transfer memos trigger highlighted room + OBS overlay messages with immediate payout split.
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
| `aioha` | No | Aioha instance (or any `AiohaLike` adapter). When provided, login and boost transfers are routed through it instead of direct Keychain calls. Supports all Aioha providers (Keychain, HiveAuth, PeakVault, Ledger) and custodial adapters. |

## Server API

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /auth/challenge` | No | Get a nonce to sign with Hive Keychain |
| `POST /auth/verify` | No | Verify signature → session JWT |
| `GET /rooms` | No | List active rooms (filters out `unlisted`) |
| `GET /rooms/:name` | No | Get a single room |
| `POST /rooms` | Yes | Create a room (caller becomes host). Body accepts `visibility`, optional `language`, and optional `boost` config (`enabled`, `minBoostUsd`, `creatorPayoutAccount`). |
| `POST /rooms/:name/join` | Yes | Join a room as listener |
| `POST /rooms/:name/listen` | No | Issue a listen-only `guest-*` token. Rate-limited per IP (10 / 5 min). Rejected for `hive-internal` rooms. |
| `POST /rooms/:name/host` | Host | Transfer host to another speaker (updates room metadata; everyone's UI flips live) |
| `PATCH /rooms/:name/layout` | Host | Set the live + recording layout (speaker / grid / single) |
| `PATCH /rooms/:name/view-state` | Host | Push the host's transient view (focused identity, chat-open, etc.) into metadata for WYSIWYG recording |
| `DELETE /rooms/:name` | Host | End the room |
| `PATCH /rooms/:name/participants/:id/permissions` | Host | Promote/demote speaker (rejects `guest-*` identities) |
| `DELETE /rooms/:name/participants/:id` | Host | Kick participant |
| `POST /rooms/:name/record/start` | Host | Start recording (audio or video) |
| `POST /rooms/:name/record/stop` | Host | Stop recording. Returns a `downloadToken` for both audio and video. |
| `GET /rooms/:name/record/file/:token` | Host | Stream the recorded file back to the host's browser. Content-Type is inferred from the file extension. |
| `GET /rooms/:name/record/status` | Host | Recording status |
| `POST /rooms/:name/record/upload` | Host | Legacy: upload audio recording to 3speak/IPFS. New integrations should use the `onAudioHandoff` callback instead. |
| `POST /rooms/:name/stream/start` | Host | Start streaming to YouTube/Twitch |
| `POST /rooms/:name/stream/stop` | Host | Stop streaming |
| `GET /rooms/:name/stream/status` | Host | Stream status |
| `POST /boosts/ingest` | No (dev spike) | Manual boost ingest endpoint for validated transfer payloads (feature-flagged). |
| `GET /boosts/ledger` | No | List current boost ledger entries (optional `?room=` filter). |

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

### Environment variables (server - Boost)

| Variable | Description |
|----------|-------------|
| `BOOSTS_ENABLED` | Enable boost listener + endpoints (`true` / `false`) |
| `BOOST_PLATFORM_ACCOUNT` | Receiving wallet account for inbound boost transfers |
| `BOOST_PLATFORM_ACTIVE_KEY` | Active key for payout transfers (server-only secret) |
| `BOOST_PLATFORM_FEE_PERCENT` | Platform fee percent (default `5`) |
| `BOOST_HIVE_USD_FALLBACK` | Fallback HIVE/USD rate if CoinGecko is unavailable |
| `BOOST_HIVE_USD_CACHE_MS` | Cache TTL (ms) for CoinGecko HIVE/USD fetches |

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Server**: Fastify 5
- **Auth**: @hiveio/dhive (signature verification) + jose (session JWTs)
- **Real-time audio**: LiveKit (self-hosted SFU)
- **Client**: React + @livekit/components-react
- **Image hosting**: images.3speak.tv

## License

MIT
