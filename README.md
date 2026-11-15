# OpenPods (Hive Hangouts)

Live audio rooms and live video streams for [Hive](https://hive.io) apps. Users sign
in with their Hive account (Hive Keychain or any [Aioha](https://aioha.dev)
provider, or a custodial adapter). 3Speak runs it as OpenPods on 3speak.tv.

## What you get

- **Audio rooms** (`conference`): host, speakers and listeners on a stage, hand
  raising, promote and demote, moderators, optional camera and screen share, games
  (chess, fast draw, word guess), recording, and "record as podcast" with one track
  per speaker and chapters.
- **Live streams** (`standalone`): a browser studio with scenes, camera, screens,
  media files, an audio mixer, overlays (lower third, ticker, countdown, "be right
  back"), an OBS source (Pro) and a phone or tablet screen source (free), a 9:16
  vertical output, stream health with automatic quality, live captions, one collab
  guest, polls and predictions, raids, and battles between two streams.
- **Going live from OBS alone**: stream templates and a WHIP endpoint, no browser needed (Pro).
- **Viewers**: WebRTC for small audiences, HLS for big ones (from viewer 51 by
  default), chat with a backlog for late joiners, anonymous guests who can chat,
  boosts, rewind and 30 s clips while a Pro host has DVR on.
- **Boosts**: HIVE/HBD transfers with a message shown on stream, paid out at once,
  with goals, tiers, sound and TTS alerts.
- **Recording and VOD**: the server records the stream and publishes it as the VOD
  itself; DVR, highlight clips and Shorts-ready vertical clips.
- **Pro and quotas**: free hosts get one 30-minute stream a day; Pro lifts the
  limits and unlocks OBS, recording, DVR and restreaming to YouTube or Twitch.
- **Events and presence**: scheduled events with RSVPs, and "is this user live now".

## Architecture

```
Browser (your app + @snapie/hangouts-react)
   |  HTTPS                          |  WebRTC media + data channel
   v                                 v
OpenPods API (server/, Fastify) --> LiveKit SFU
   |--> LiveKit egress   (recording, VOD, DVR, HLS, restream, podcast tracks)
   |--> LiveKit ingress  (WHIP: OBS, phone screen apps, headless streams)
   |--> MongoDB          (Pro flags, templates, chat backlog, polls, clips, events)
   `--> Hive API         (signatures, boost transfers)
```

The API verifies Hive signatures, hands out LiveKit tokens, enforces host, Pro and
quota rules, keeps the live state in the LiveKit room metadata and drives egress and
ingress. Details: [docs/integrator-guide.md](docs/integrator-guide.md).

## Quick start

```bash
npm install @snapie/hangouts-react @snapie/hangouts-core livekit-client @livekit/components-react
```

```tsx
import { useState } from 'react';
import { HangoutsProvider, RoomLobby, HangoutsRoom, useHangoutsAuth } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

function Rooms() {
  const { isAuthenticated, login } = useHangoutsAuth();
  const [room, setRoom] = useState<string | null>(null);
  if (room) return <HangoutsRoom roomName={room} onLeave={() => setRoom(null)} guestFallback video />;
  return (
    <>
      {!isAuthenticated && <button onClick={() => login(prompt('Hive username') ?? '')}>Sign in</button>}
      <RoomLobby onJoinRoom={setRoom} allowGuestBrowse allowStandalone />
    </>
  );
}

export default function App() {
  return (
    <HangoutsProvider apiBaseUrl="https://hangout-api.3speak.tv" livekitServerUrl="wss://livekit.3speak.tv">
      <Rooms />
    </HangoutsProvider>
  );
}
```

More (Aioha, custodial login, a stream-only watch page, the studio props):
[docs/integrator-guide.md](docs/integrator-guide.md#quick-start-embed-openpods-in-your-hive-app).

## Documentation

| Doc | For |
|---|---|
| [docs/integrator-guide.md](docs/integrator-guide.md) | Architecture, auth, identities, room metadata, data channel topics, SDK components and hooks, the studio, HLS, recording, DVR, podcast, templates, Pro and quotas, boosts, events, every config key, Mongo collections. |
| [docs/api-routes.md](docs/api-routes.md) | Every HTTP route with auth, rate limit, body and answer. The full table is generated from the code. |
| [docs/livekit-server-setup.md](docs/livekit-server-setup.md) | Running LiveKit, egress and ingress on a VPS. |
| [docs/llms.txt](docs/llms.txt) | The two guides above in one file, for AI assistants. |
| [docs-site/](docs-site/) | The browsable docs site (`npm run dev` / `npm run build`). |
| [packages/sdk-core/README.md](packages/sdk-core/README.md), [packages/sdk-react/README.md](packages/sdk-react/README.md) | npm package readmes. |

## Project structure

```
server/           Fastify API (TypeScript). Tests: npx vitest run
  src/routes/     one file per area (rooms, chat, polls, raids, battles, dvr, ...)
  src/lib/        logic and stores
  scripts/        list-routes.ts (route table), load-collections.ts (word lists)
packages/
  sdk-core/       @snapie/hangouts-core: API client, login helpers, types
  sdk-react/      @snapie/hangouts-react: provider, rooms, studio, viewer, chat, boosts
demo/             reference integration (Vite + React)
docs/             guides; docs-site/ is the docs site
examples/         nginx and LiveKit docker-compose examples
```

## Run it

You need Node.js 20+, a LiveKit server with egress and ingress
([setup](docs/livekit-server-setup.md)) and, for most features, MongoDB.

```bash
cd server
cp .env.example .env      # fill in LiveKit keys, SESSION_SECRET (32+ chars), MONGODB_URI
npm install
npm run dev               # http://localhost:3002
```

All server settings: [Server configuration](docs/integrator-guide.md#server-configuration).
Demo app: `cd demo && cp .env.example .env && npm install && npm run dev`
(`VITE_API_URL`, `VITE_LIVEKIT_URL`, optional `VITE_IMAGE_SERVER_API_KEY`).

## Tech stack

Node.js and TypeScript, Fastify 5, LiveKit (SFU, egress, ingress), MongoDB,
`@hiveio/dhive` and `jose` for auth, React with `@livekit/components-react`.

## License

MIT
