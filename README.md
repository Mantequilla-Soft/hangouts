<h1 align="center">OpenPods</h1>

<p align="center">
  <strong>Live audio rooms and live video streams for <a href="https://hive.io">Hive</a> apps.</strong><br>
  Sign in with a Hive account, go live from the browser or OBS, as a server plus a React SDK on LiveKit.
</p>

<p align="center">
  <a href="https://github.com/Mantequilla-Soft/hangouts/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Mantequilla-Soft/hangouts/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="@snapie/hangouts-react 0.27.8" src="https://img.shields.io/badge/%40snapie%2Fhangouts--react-0.27.8-CB3837">
  <img alt="@snapie/hangouts-core 0.16.0" src="https://img.shields.io/badge/%40snapie%2Fhangouts--core-0.16.0-CB3837">
  <img alt="TypeScript 5" src="https://img.shields.io/badge/TypeScript-5-3178C6">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933">
  <img alt="Fastify 5" src="https://img.shields.io/badge/Fastify-5-000000">
  <img alt="LiveKit 2" src="https://img.shields.io/badge/LiveKit-2-1F8CF9">
  <img alt="React 18 or 19" src="https://img.shields.io/badge/React-18%20%7C%2019-61DAFB">
  <img alt="MongoDB driver 7" src="https://img.shields.io/badge/MongoDB-driver%207-47A248">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

---

OpenPods (this repo, "hangouts", also called Hive Hangouts in older code) gives a Hive
app two things: **audio rooms** with a stage of host, speakers and listeners, and
**one-person live streams** with a full studio that runs in the browser. Users sign in
with their Hive account (Hive Keychain, any [Aioha](https://aioha.dev) provider, or a
custodial adapter), so there are no passwords and no separate user database. Viewers
can tip the host with **boosts**, plain HIVE or HBD transfers shown on stream and paid
out at once.

It is built for Hive front ends that want live audio and video without writing a media
stack: [LiveKit](https://livekit.io) carries the media, the OpenPods API handles Hive
auth, roles, quotas, recording and payouts, and the React SDK gives you the lobby, the
room, the studio and the watch page as components. [3Speak](https://3speak.tv) runs it
as OpenPods for its live streams and audio rooms.

Developer docs: **[hangout.3speak.tv/docs](https://hangout.3speak.tv/docs/)** (built
from [docs/](docs/) by [docs-site/](docs-site/)).

## Contents

- [What you get](#what-you-get)
- [How it works](#how-it-works): [sign-in](#sign-in) · [a stream](#a-stream) · [boosts](#boosts)
- [Quick start](#quick-start): [embed the SDK](#embed-the-sdk) · [self-host the server](#self-host-the-server)
- [Configuration](#configuration)
- [Reference](#reference): [API routes](#api-routes) · [SDK](#sdk) · [data channel](#data-channel) · [free and Pro](#free-and-pro)
- [Development and tests](#development-and-tests)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Security notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

## What you get

- **Audio rooms** (`conference` mode): host, speakers and listeners on a stage, hand
  raising, promote and demote, moderators, optional camera and screen share, games
  (chess, fast draw, word guess), recording, and "record as podcast" with one track per
  speaker plus chapters.
- **Live streams** (`standalone` mode): a browser studio with scenes, camera, up to four
  screen shares, image, GIF, video and music files, an audio mixer, overlays (lower
  third, ticker, countdown, "be right back"), an OBS source (Pro), a phone or tablet
  screen source (free), a 9:16 vertical output, stream health with automatic quality,
  live captions, one collab guest, polls and predictions, raids, and battles between
  two streams.
- **Going live from OBS alone** (Pro): saved stream templates and a WHIP endpoint, no
  browser needed.
- **Viewers**: WebRTC for small audiences, HLS once a stream passes a viewer threshold
  (viewer 51 by default), chat with a backlog for late joiners, anonymous guests who can
  chat, boosts, 30 second clips, and rewind while a Pro host has DVR on.
- **Boosts**: HIVE or HBD transfers with a message on stream, paid out to the host at
  once, with goals, tiers, sound and text-to-speech alerts.
- **Channel points**: one balance per Hive account, earned by watching, chatting and
  streaming, spent on prediction stakes and points boosts, and logged on Hive as
  `custom_json`.
- **Recording and VOD**: the server records a stream and publishes it as the VOD of the
  stream's post; DVR, highlight clips, 9:16 clips for Shorts and a recap of 2 to 4 clips.
- **Free and Pro**: free hosts get one 30 minute stream a day; Pro lifts the limits and
  unlocks OBS, recording, DVR and restreaming to YouTube, Twitch or any RTMP server.
- **Events and presence**: scheduled events with RSVPs, and "is this account live now".

## How it works

```
 Browser: your app + @snapie/hangouts-react
   |  HTTPS: auth, tokens, room actions            |  WebRTC: media + data channel
   v                                               v
 OpenPods API (server/, Fastify, :3002) ------> LiveKit SFU
   |  server SDK: rooms, metadata, sendData        ^
   +--> LiveKit egress   recording, VOD, DVR, HLS, restream, podcast tracks
   +--> LiveKit ingress  WHIP: OBS, phone screen apps, headless OBS streams
   +--> MongoDB          Pro flags, templates, chat backlog, polls, points, clips, events
   +--> Hive API         signature checks, boost transfers, points log
   +--> 3Speak services  VOD upload, stream announcements, stream stats (optional)
```

The API never touches media. It checks who you are, decides what you may do, hands out
LiveKit tokens with the matching grants, writes the shared live state into the LiveKit
**room metadata** (which every participant receives on each change), and starts and stops
egress and ingress. Live state such as running polls, raids, recordings and HLS sessions
is kept in memory per process; everything that must survive a restart is in MongoDB.

### Sign-in

1. `POST /auth/challenge { username }` returns a single-use nonce, valid 5 minutes.
2. The user signs it with their **posting key** (Keychain `requestSignBuffer`, or Aioha
   `signMessage(msg, 'posting')`). A signature by an account the user granted posting
   authority to, such as a custodial service account, is accepted too.
3. `POST /auth/verify { username, challenge, signature }` returns a 24 hour session JWT.

`loginWithKeychain`, `loginWithAioha` and `loginWithSignFn` in `@snapie/hangouts-core` do
all three steps. Signed-out visitors can still browse and listen as guests
(`POST /rooms/:name/listen`).

### A stream

The studio composites every source into one canvas in the host's browser and publishes it
as two tracks, `studio-program` (video) and `studio-mix` (audio). Viewers, the VOD, the
DVR and HLS all use those tracks, so what the host sees is what everyone gets. Going live
stamps `liveAt` and applies the free daily limit (`PATCH /rooms/:name/live`); the studio
reports on-air state with `PATCH /rooms/:name/broadcast` every 15 seconds. When the host
chose to publish, the server records the program track and uploads the MP4 itself as the
VOD of the stream's Hive post.

From OBS, a Pro user points OBS's WHIP output at `/whip/<owner>/<slug>` with their
streaming secret. The server then creates the room, joins the ingress as the host with
the same track names, starts VOD and DVR as the template says, posts the Hive
announcement and tears it all down when OBS stops. The LiveKit stream key never leaves
the server.

### Boosts

A boost is a HIVE or HBD transfer to the platform account (`BOOST_PLATFORM_ACCOUNT`) with
a JSON memo naming the room. The server watches Hive, checks the memo and the room's
boost settings, pays the host (or the on-air guest the memo names) minus the platform
fee, sends a `boost` message on the data channel and updates the room's tally. Transfers
it cannot place are refunded. Nothing runs unless `BOOSTS_ENABLED=true`.

## Quick start

### Embed the SDK

```bash
npm install @snapie/hangouts-react @snapie/hangouts-core livekit-client @livekit/components-react
```

A complete page: sign in with Keychain, list rooms, open one. Signed-out visitors can
browse and listen as guests.

```tsx
import { useState } from 'react';
import { HangoutsProvider, RoomLobby, HangoutsRoom, useHangoutsAuth } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

const API = 'https://hangout-api.3speak.tv';   // or your own OpenPods API
const LIVEKIT = 'wss://livekit.3speak.tv';     // or your own LiveKit URL

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
    <HangoutsProvider apiBaseUrl={API} livekitServerUrl={LIVEKIT}>
      <Rooms />
    </HangoutsProvider>
  );
}
```

`HangoutsRoom` picks the UI from the room: the audio room, the studio for the host of a
stream, or the stream viewer for everyone else. Pass `aioha={aiohaInstance}` to the
provider to sign in and send boosts through the user's chosen Aioha wallet, or
`sessionToken` and `username` if your app already holds an OpenPods session. A watch page
without the lobby:

```tsx
import { HangoutsProvider, StandaloneWatch, StreamVideo, StreamViewerCount, ChatPanel } from '@snapie/hangouts-react';

<HangoutsProvider apiBaseUrl={API} livekitServerUrl={LIVEKIT} sessionToken={token} username={user}>
  <StandaloneWatch roomName="badadib-k3x9q2a" onRaid={(t) => navigate(`/live/${t.roomName}`)}>
    <StreamVideo format="auto" />
    <StreamViewerCount />
    <ChatPanel readOnly={!user} readOnlyNotice="Sign in to chat" />
  </StandaloneWatch>
</HangoutsProvider>
```

The repo can be ahead of the latest npm release: the demo and CI build the SDK from
`packages/`. More (custodial login, theming, the studio props):
[integrator guide](docs/integrator-guide.md#quick-start-embed-openpods-in-your-hive-app).

### Self-host the server

You need Node.js 20 or newer (CI runs 24), a **LiveKit server with egress and ingress**,
and, for most features, MongoDB.

1. **LiveKit.** Follow [docs/livekit-server-setup.md](docs/livekit-server-setup.md)
   (Docker Compose, TLS, firewall, egress, and the patched ingress build). Note the API key
   pair; egress and ingress use the same one. [examples/](examples/) has a worked
   docker-compose and nginx setup from an earlier deployment.
2. **The API.**

   ```bash
   git clone https://github.com/Mantequilla-Soft/hangouts.git
   cd hangouts/server
   cp .env.example .env    # LiveKit URL and key pair, SESSION_SECRET (32+ chars), MONGODB_URI
   npm install
   npm run dev             # http://localhost:3002, check with GET /health
   ```

   For production: `npm run build && npm start`, behind a reverse proxy on the same host
   (the API trusts `X-Forwarded-For` only from `127.0.0.1`).
3. **The demo app** (optional, and also the egress page for audio room recordings):

   ```bash
   cd demo
   cp .env.example .env    # VITE_API_URL, VITE_LIVEKIT_URL, optional VITE_IMAGE_SERVER_API_KEY
   npm install
   npm run dev
   ```

   The same build serves `/egress-template` (what LiveKit's recorder loads for audio room
   recordings) and `/obs` (the OBS browser-source overlay). Point `EGRESS_TEMPLATE_URL` at
   your own deployment of it.

Some features call 3Speak services and stay off or fail softly without credentials:
publishing a stream VOD needs an `EMBED_API_KEY` for the 3Speak embed upload service, the
Hive announcement of headless OBS streams needs `OPENPODS_ANNOUNCE_SECRET`, and stream
stats to the 3Speak checker need `STREAM_STATS_SECRET`.

## Configuration

The API reads its settings in [`server/src/config.ts`](server/src/config.ts) (validated
with zod; the server exits on an invalid value). The main keys are below; the
[full table](docs/integrator-guide.md#server-configuration) lists every one.

| Variable | Purpose | Default |
|---|---|---|
| `LIVEKIT_HOST` | LiveKit HTTP URL for the server SDK | required |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit key pair (the same pair in egress and ingress) | required |
| `SESSION_SECRET` | Signs session JWTs, rewind tokens and, if `STREAM_KEY_SECRET` is empty, streaming secrets | required, 32+ chars |
| `PORT` | HTTP port | `3002` |
| `HIVE_API_NODE` | Hive RPC node for signatures and boosts | `https://api.hive.blog` |
| `MONGODB_URI` | MongoDB connection. Without it, stores that can fall back keep state in memory; templates, overlays and Pro are unavailable | empty |
| `STUDIO_FRONTEND_URL` | Frontend base for VOD and headless stream links | `https://3speak.tv` |
| `EGRESS_TEMPLATE_URL` | Egress page for audio room recordings (the demo's `/egress-template`) | `https://hangout.3speak.tv/egress-template` |
| `EGRESS_STANDALONE_TEMPLATE_URL` | Egress page for stream recordings when the track path is not used | `https://3speak.tv/egress-stream` |
| `INGRESS_WHIP_URL` | Public WHIP base for the studio's OBS and phone sources | 3Speak's, set your own |
| `PUBLIC_WHIP_BASE` | Public base of this API's WHIP proxy for headless OBS streams | 3Speak's, set your own |
| `INGRESS_WHIP_INTERNAL_URL` | The ingress WHIP handler on loopback | `http://127.0.0.1:8086/w` |
| `STREAM_KEY_SECRET` | Hashes and encrypts per-user streaming secrets; changing it invalidates them | empty (derived from `SESSION_SECRET`) |
| `EMBED_UPLOAD_URL`, `EMBED_API_URL`, `EMBED_API_KEY` | Where stream VODs are uploaded and registered | 3Speak embed service, empty key |
| `ANNOUNCE_API_URL`, `OPENPODS_ANNOUNCE_SECRET` | Service that posts the Hive announcement of a headless stream | local URL, empty secret |
| `CHECKER_URL`, `STREAM_STATS_SECRET` | Live stream stats to the 3Speak checker; empty secret turns it off | `https://checker.3speak.tv`, empty |
| `BOOSTS_ENABLED` | Boost listener and payouts | `false` |
| `BOOST_PLATFORM_ACCOUNT`, `BOOST_PLATFORM_ACTIVE_KEY` | Account that receives boosts, and its active key for payouts and refunds | empty |
| `BOOST_PLATFORM_FEE_PERCENT` | Platform fee on boosts | `5` |
| `BOOST_INGEST_KEY` | Admin key for the manual `POST /boosts/ingest`; empty turns the route off | empty |
| `HLS_VIEWER_THRESHOLD` | WebRTC viewers per stream before the rest get HLS. `0` = all HLS, empty = HLS off | `50` |
| `HLS_PUBLIC_BASE` | CDN base for HLS (origin = this API); empty = this API | empty |
| `HLS_VIDEO_BITRATE` | HLS rendition bitrate in kbps | `2000` |
| `DVR_ENABLED`, `DVR_BUFFER_SEC` | DVR egress kill switch, and the DVR window in seconds | `true`, `150` |
| `REWIND_ENABLED` | Rewind during a live stream | `false` |
| `CLIP_KEEP_HOURS`, `CLIPS_DIR_MAX_MB` | How long clips stay, and their disk budget | `48`, `4096` |
| `PODCAST_RECORDING_ENABLED` | "Record as podcast" in audio rooms | `true` |
| `CAPTIONS_ENABLED`, `CAPTIONS_MAX_STREAMS` | Live caption slots, and how many at once | `false`, `3` |
| `PRO_TESTING_ENABLED`, `PRO_TESTING_HOURS` | The one-time free Pro trial | `true`, `24` |
| `STREAM_LIMIT_EXEMPT` | Comma list of accounts without the free daily stream limit | empty |
| `MAX_GUESTS_PER_ROOM` | WebRTC guest cap per room | `50` |
| `CHAT_BACKLOG_SIZE` | Chat lines kept per room | `300` |
| `POINTS_START`, `POINTS_TTL_DAYS` | Starting channel points, and days until an untouched balance starts over | `1000`, `90` |
| `POINTS_LOG_ACCOUNT`, `POINTS_LOG_POSTING_KEY` | Account and posting key that log points on Hive; without a key the rows wait in Mongo | `threespeak-pro`, empty |
| `POINTS_TOKEN_CONTRACT` | The 3SP contract on Magi: earnings are minted, spends burn on chain first. Empty keeps points in Mongo only | empty |
| `POINTS_MINTER_POSTING_KEY`, `POINTS_SPEND_SIGNER_POSTING_KEY` | Posting keys of the minter (`threespeak-pro`) and of the account that signs users' spends (`threespeak`) | empty |
| `POINTS_AWARD_SECRET` | Lets the checker send its awards (`POST /points/awards`: leaderboards, remixes, watching, listening, posts, tips, followers...); also books video promotions paid with points on the checker | empty |
| `POINTS_DOUBLE_WEEKENDS`, `POINTS_DOUBLE_WINDOWS` | Double points: every earning pays x2 on weekends (Saturday and Sunday, UTC) when `true`, and inside these windows (comma list of `<ISO start>/<ISO end>`) | `false`, empty |
| `POINTS_FIRSTS_SINCE` | A first stream pays its 500 points only for accounts whose first stream is on or after this date | `2026-11-26` |
| `POINTS_QUESTS` | Comma list of quest ids to run every week instead of the rotation (`finish3`, `listen30`, `pollvote2`, `tag5`, `live30`) | empty |
| `PROMOTE_POINTS_PER_24H` | Points it costs to promote a 3Speak video for 24 h (`POST /points/promote`) | `5000` |
| `RAID_COUNTDOWN_SEC`, `RAID_COOLDOWN_MIN` | Raid countdown and per-host cooldown | `10`, `10` |

The demo reads `VITE_API_URL`, `VITE_LIVEKIT_URL` and optionally
`VITE_IMAGE_SERVER_API_KEY` (enables the image picker) at build time.

## Reference

### API routes

Every route, with its auth, rate limit, body and answer, is in
[docs/api-routes.md](docs/api-routes.md); its full table is generated from the code
(`npm run routes` in `server/`). Conventions: a session is
`Authorization: Bearer <JWT>` from `/auth/verify`; "host" means the caller is the room's
`host` in the room metadata; errors are JSON `{ statusCode, error, message }`; rate
limits are per client IP. The main areas:

| Area | Routes |
|---|---|
| Auth | `POST /auth/challenge`, `POST /auth/verify`, `GET /auth/me` |
| Rooms and streams | `GET /rooms`, `GET /streams`, `GET /health`, `GET /rooms/:name`, `POST /rooms`, `POST /rooms/:name/join`, `POST /rooms/:name/listen`, `PATCH /rooms/:name/{layout,boost,post,live,broadcast,vertical}`, `POST` and `DELETE /rooms/:name/ingress`, `POST /rooms/:name/host`, `DELETE /rooms/:name` |
| Moderation | `PATCH /rooms/:name/participants/:identity/permissions`, `DELETE /rooms/:name/participants/:identity`, `POST /rooms/:name/participants/:identity/ban`, `PATCH /rooms/:name/mods/:username` |
| Chat backlog | `GET`, `POST /rooms/:name/chat`, `DELETE /rooms/:name/chat/:id` |
| Polls, predictions, points | `/rooms/:name/polls*`, `GET /points`, `GET /users/:account/points`, `GET /users/:account/points/history`, `POST /rooms/:name/boosts/points` |
| Raids and battles | `/rooms/:name/raid*`, `/raids/settings`, `/battles/*` |
| Recording, VOD, podcast | `/rooms/:name/record/*`, `/rooms/:name/podcast/*`, `GET /podcast/recordings`, `GET /podcast/files/:token/:file` |
| Restream (Pro) | `POST /rooms/:name/stream/start`, `POST /rooms/:name/stream/stop`, `GET /rooms/:name/stream/status` |
| DVR, clips, highlights | `/rooms/:name/dvr/*`, `GET /dvr/clips/:file`, `GET /rooms/:name/highlights`, `GET /clips/mine`, `POST /clips/:id/vertical`, `DELETE /clips/:id`, `POST /rooms/:name/recap` |
| HLS | `GET /rooms/:name/hls/:file` |
| Boosts | `GET /boosts/config`, `GET /boosts/ledger`, `POST /boosts/ingest` (admin key) |
| Templates and OBS | `/templates*`, `GET /stream-secret`, `POST /stream-secret/reset`, `GET /overlay/:key`, `POST /whip/:owner/:slug`, `PATCH` and `DELETE /whip/s/:token` |
| Studio overlays | `GET`, `PUT /studio/overlays` |
| Captions | `GET /captions/status`, `POST /rooms/:name/captions/{start,stop}` |
| Pro | `GET /premium/:username`, `GET /premium`, `POST /premium/start-testing` |
| Events and presence | `/events*`, `GET /presence/:username`, `POST /presence/bulk` |
| Games | `GET /games`, `GET /game-collections`, `/rooms/:name/game*` |

Room names look like `<host>-<7 random chars>`. Visibility is `public` (listed, guests
welcome), `hive-internal` (listed, Hive accounts only) or `unlisted` (not listed, guests
with the link welcome). Rooms close 300 seconds after the last person leaves.

### SDK

| Package | Version | Use |
|---|---|---|
| [`@snapie/hangouts-core`](packages/sdk-core/README.md) | 0.16.0 | No dependencies. `HangoutsApiClient`, `HangoutsApiError`, the login helpers, types and track names. Works without React and on a server. |
| [`@snapie/hangouts-react`](packages/sdk-react/README.md) | 0.27.8 | Provider, lobby, rooms, studio, viewer, chat, boosts, polls, games, Pro. Peer deps: `react` 18 or 19, `livekit-client` 2, `@livekit/components-react` 2. Re-exports most of core. |

The main pieces of `@snapie/hangouts-react`:

| Kind | Exports |
|---|---|
| Setup | `HangoutsProvider` (`apiBaseUrl`, `livekitServerUrl`, `sessionToken`, `username`, `aioha`, `theme`, ...) |
| Whole screens | `RoomLobby`, `HangoutsRoom`, `StandaloneStudio`, `StandaloneViewer`, `StandaloneObsOverlay` |
| Watch page parts | `StandaloneWatch`, `StreamVideo`, `StreamViewerCount`, `StreamQualityControl`, `StreamCaptions`, `StreamPollCard`, `StreamBoostGoal`, `StreamBattleBar`, `RaidBanner`, `CollabRequest`, `ChatPanel` |
| Boosts and Pro | `SendBoostDialog`, `BoostOverlay`, `BoostAlerts`, `BoostHistoryPanel`, `BoostSettingsPanel`, `BoostTopSupporters`, `ProPlans`, `ProUpsellDialog`, `SubscriberTicker` |
| Audio room parts | `SpeakerStage`, `AudienceSection`, `RoomControls`, `ParticipantTile`, `HostControlsPanel`, `RoomHeader`, `GamePanel`, `PodcastRecordControls` |
| Hooks | `useHangoutsAuth`, `useHangoutsRoom`, `useRoomList`, `useChat`, `useHandRaise`, `useHostControls`, `usePolls`, `useRaid`, `useBoosts`, `useRoomBattle`, `useLiveCaptions`, `useWhipIngress`, `useRecording`, `useStreaming`, `usePremiumStatus`, `useProTrial`, `useEventList`, `useUserPresence`, ... |

Styles come from one file, `@snapie/hangouts-react/src/styles/hangouts.css`. Classes use
the `hh-` prefix and colours the `--hh-*` CSS variables; set `data-hh-theme="light"` or
`"dark"` on an ancestor, or pass `theme` to the provider. Every component and hook, with
its props: [integrator guide, SDK packages](docs/integrator-guide.md#sdk-packages).

### Data channel

Chat, hand raises, boosts, polls, raids, games, captions and host view state travel on
LiveKit data topics (`chat`, `hand-raise`, `boost`, `poll`, `raid`, `game`, `captions`,
`view-state`, `volume`, `draw`). Every participant, guests included, can publish data, so
the SDK checks the **sender** of each packet before it believes it: server topics only
count with no participant sender, host topics only from the identity the room metadata
names as host. If you read topics yourself, use the exported checks
(`readBoostPacket`, `readChatPacket`, `readPollPacket`, ..., `DATA_TOPIC_TRUST`). Message
shapes and the trust rules: [data channel topics](docs/integrator-guide.md#data-channel-topics).

### Free and Pro

Pro is `premium: true` on the account's row in the `embed-users` collection (shared with
3Speak, set from a subscription, the one-time trial, or by hand).

| | Free | Pro |
|---|---|---|
| Streams per rolling 24 h | 1 | unlimited |
| Stream length | 30 min | 4 h |
| Stream VOD | up to 30 min, no download | yes, with download |
| Studio quality | up to 854x480 | up to 1280x720 |
| OBS source and OBS templates | no | yes |
| Phone screen source | yes | yes |
| Audio room recording, podcast recording | no | yes |
| Clips and highlights cut from the VOD | first 30 min | yes |
| DVR (instant clips), rewind | no | yes |
| Restream to YouTube, Twitch or a custom server | no | yes |
| Watermark | yes | no |

## Development and tests

Each part is its own npm project; run the commands inside its folder. Server tests mock
LiveKit and Mongo, so they need neither.

```bash
# server/
npm run dev              # tsx watch on src/index.ts
npm run build            # tsc -> dist/
npm start                # node dist/index.js
npm test                 # vitest run (test:watch, test:ui for the interactive modes)
npx tsc --noEmit         # typecheck, as CI does
npm run routes           # print the route table from the code
npm run routes:check     # fail when docs/api-routes.md is out of date
npm run load-collections -- <file.json>   # load word-guess word lists into Mongo
npm run points:replay    # rebuild every points balance from the Hive log alone

# packages/sdk-core/ and packages/sdk-react/
npm run build            # tsc -> dist/
npm run typecheck
npm test                 # vitest run

# demo/ and docs-site/
npm run dev
npm run build
```

`sdk-react` depends on the published `@snapie/hangouts-core`. To build it against your
local core, as CI does, copy `packages/sdk-core/dist/` over
`packages/sdk-react/node_modules/@snapie/hangouts-core/dist/` before `npm run build`.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) typechecks and tests the
server, builds both SDKs, the demo and the docs site, and tests the deploy scripts.

## Repository layout

```
.
├── server/                  # the OpenPods API (Fastify, TypeScript)
│   ├── src/routes/          # one file per area: rooms, chat, polls, raids, battles, dvr, whip, ...
│   ├── src/lib/             # logic and stores: boosts, points, HLS, recording, templates, ...
│   ├── src/games/           # chess, fast draw, word guess
│   ├── src/middleware/      # requireAuth, checkBan
│   ├── scripts/             # route table, word lists, points replay
│   └── test/                # vitest suites
├── packages/
│   ├── sdk-core/            # @snapie/hangouts-core: API client, login helpers, types
│   └── sdk-react/           # @snapie/hangouts-react: components, hooks, styles
├── demo/                    # reference app (Vite + React), also /egress-template and /obs
├── docs/                    # integrator guide, API routes, LiveKit setup, llms.txt
├── docs-site/               # the docs site (Vite), renders docs/*.md
├── examples/                # sample LiveKit docker-compose and nginx configs
├── room-api/                # early minimal room and token API, not used by the SDK
├── deploy/, deploy.sh       # deployment scripts for 3Speak's instance
└── test/                    # manual audio upload check
```

## Documentation

| Doc | For |
|---|---|
| [docs/integrator-guide.md](docs/integrator-guide.md) | Architecture, auth, identities, room metadata, data channel topics, SDK components and hooks, theming, the studio, HLS, recording, DVR, podcast, templates, Pro, boosts, events, every config key, Mongo collections |
| [docs/api-routes.md](docs/api-routes.md) | Every HTTP route with auth, rate limit, body and answer |
| [docs/livekit-server-setup.md](docs/livekit-server-setup.md) | Running LiveKit, egress and ingress on a VPS |
| [docs/llms.txt](docs/llms.txt) | The guides in one file, for AI assistants |
| [hangout.3speak.tv/docs](https://hangout.3speak.tv/docs/) | The same docs as a browsable site |
| [packages/sdk-core/README.md](packages/sdk-core/README.md), [packages/sdk-react/README.md](packages/sdk-react/README.md) | The npm package readmes |

## Security notes

- **Hive keys stay with the user.** Sign-in is a posting-key signature over a single-use
  challenge; the server never sees a user's key. Sessions are HS256 JWTs signed with
  `SESSION_SECRET` and valid 24 hours, so keep that secret long and private.
- **The boost wallet's active key lives on the server.** `BOOST_PLATFORM_ACTIVE_KEY` pays
  hosts and refunds senders. Keep only working balances in that account.
  `POST /boosts/ingest` drives real payouts, so it is off unless `BOOST_INGEST_KEY` is set.
- **Data packets prove only their sender.** Anyone in a room can publish any payload on
  any topic. Trust the LiveKit sender identity, never a payload's `identity` or `name`,
  and act on server topics only when there is no participant sender (see
  [Data channel](#data-channel)). Browser sources and recording templates you build need
  the same checks.
- **Streaming secrets are stored hashed and encrypted** (`STREAM_KEY_SECRET`, or a key
  derived from `SESSION_SECRET`). OBS talks to the API's WHIP proxy, so the LiveKit stream
  key never leaves the server.
- **Run it behind a reverse proxy on the same host.** Rate limits are per client IP and
  `X-Forwarded-For` is trusted only from `127.0.0.1`.
- **Custom restream targets are checked.** A custom RTMP URL must resolve to a public
  address, so the egress cannot be pointed at internal services.
- **Recording and podcast downloads are capability links**: the token in the path is the
  access check, valid 1 hour for recordings and 1 day for podcast files.

## Contributing

Issues and pull requests are welcome. Questions and ideas: [Discord](https://discord.gg/NSFS2VGj83).

## License

[MIT](LICENSE) © Mantequilla Soft.
