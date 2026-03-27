# Hive Hangouts

Twitter Spaces-style audio rooms for the [Hive](https://hive.io) blockchain.

## What is this?

Live audio rooms where anyone with a Hive account can host or join conversations. Authentication is done via Hive Keychain — no new accounts, no passwords. Your Hive identity is your hangout identity.

## Architecture

```
React SPA  ──────────────── LiveKit SFU (self-hosted)
   │       WebRTC audio          │
   │       + signaling           │
   │                             │
   └──── Fastify API ───────────┘
         (auth + tokens)    server SDK calls

Hive Blockchain ← signature verification
```

Three components:

- **LiveKit SFU** — open-source WebRTC server handling real-time audio routing, room state, and participant management. Self-hosted on a VPS.
- **Fastify API** (`server/`) — thin auth gateway. Verifies Hive signatures, issues LiveKit tokens, enforces host-only permissions. ~250 lines.
- **React SPA** (`client/`) — the UI. Connects directly to LiveKit for audio. Custom Spaces-like layout with speaker stage and audience grid. *(coming soon)*

## Features (MVP)

- **Hive Keychain login** — challenge-response auth using your posting key
- **Create rooms** — host starts a room, others join via lobby or link
- **Audio** — real-time voice via LiveKit (WebRTC)
- **Hand raising** — listeners request to speak via data channel
- **Speaker management** — host promotes/demotes participants
- **Moderation** — host can mute, kick, or end the room
- **Hive avatars** — profile pictures pulled from on-chain metadata

## Project Structure

```
hangouts/
  server/           Fastify API (Hive auth + LiveKit tokens)
  client/           React SPA (coming soon)
  docs/             LiveKit deployment guide
  room-api/         Legacy prototype (to be removed)
```

## Server API

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /auth/challenge` | No | Get a nonce to sign with Hive Keychain |
| `POST /auth/verify` | No | Verify signature → session JWT |
| `GET /rooms` | No | List active rooms |
| `POST /rooms` | Yes | Create a room (caller becomes host) |
| `POST /rooms/:name/join` | Yes | Join a room as listener |
| `PATCH /rooms/:name/participants/:id/permissions` | Host | Promote/demote speaker |
| `DELETE /rooms/:name/participants/:id` | Host | Kick participant |

## Setup

### Prerequisites

- Node.js 20+
- A running LiveKit server (see `docs/livekit-server-setup.md`)

### Server

```bash
cd server
cp .env.example .env
# Edit .env with your LiveKit credentials and a session secret
npm install
npm run dev
```

### LiveKit

Follow the deployment guide in `docs/livekit-server-setup.md` — it uses Docker Compose + Caddy for automatic TLS.

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Server**: Fastify 5
- **Auth**: @hiveio/dhive (signature verification) + jose (session JWTs)
- **Real-time audio**: LiveKit (self-hosted SFU)
- **Client**: React + @livekit/components-react *(coming soon)*

## License

MIT
