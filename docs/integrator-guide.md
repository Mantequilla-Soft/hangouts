# OpenPods integrator guide

OpenPods (this repo, "hangouts") gives a Hive app live audio rooms and one-person
live streams with a browser studio. This guide is written from the code. The HTTP
routes are in [api-routes.md](api-routes.md); the LiveKit side is in
[livekit-server-setup.md](livekit-server-setup.md).

Contents: [Architecture](#architecture) · [Quick start](#quick-start-embed-openpods-in-your-hive-app) ·
[Auth](#auth) · [Rooms, roles and identities](#rooms-roles-and-identities) ·
[Room metadata](#room-metadata) · [Data channel](#data-channel-topics) ·
[SDK](#sdk-packages) · [Theming](#theming) · [Studio](#the-studio) · [Watching a stream](#watching-a-stream) ·
[HLS](#hls-delivery) · [Recording, VOD, DVR](#recording-vod-dvr-clips-and-rewind) ·
[Podcast recording](#record-as-podcast) · [Templates and OBS](#templates-and-headless-obs-streams) ·
[Pro and quotas](#pro-and-quotas) · [Boosts](#boosts) · [Events](#events-and-presence) ·
[Server config](#server-configuration) · [Mongo collections](#mongo-collections)

## Architecture

```
 Browser (your app + @snapie/hangouts-react)
   |  HTTPS: auth, tokens, room actions             |  WebRTC: media + data channel
   v                                                v
 OpenPods API (server/, Fastify, :3002) ------> LiveKit SFU (:7880, UDP 50000-60000)
   |  server SDK: rooms, metadata, sendData           ^            ^
   |                                                  |            |
   +--> LiveKit egress (recording, VOD, DVR, HLS, restream, podcast tracks)
   +--> LiveKit ingress (WHIP: OBS, phone screen apps, headless streams)
   +--> MongoDB (users/Pro, templates, chat backlog, polls, clips, ...)
   +--> Hive API (signature checks, boost transfers)
   +--> 3Speak services (embed upload for VODs, announce, checker stats)
```

| Part | What it does |
|---|---|
| **API server** (`server/`) | Verifies Hive signatures, issues session JWTs and LiveKit tokens, enforces host, mod, Pro and quota rules, writes room metadata, drives egress and ingress, watches Hive for boosts. Runs on one box; live state (polls, raids, recordings, caption slots, HLS sessions) is kept in memory per process. |
| **LiveKit SFU** | Routes audio, video and data between participants. Room metadata is the shared live state every participant receives. |
| **Egress** | Server-side recorders. Writes under `/tmp/livekit-recordings` (the only path mounted into the egress container): VOD MP4s, DVR HLS segments, the HLS delivery playlist, podcast speaker tracks. Also RTMP restream. |
| **Ingress** | WHIP endpoint. The studio's OBS and phone screen sources, and headless OBS streams, publish through it. Media goes encoder to ingress over UDP; only signalling passes the API. |
| **SDK** (`packages/`) | `@snapie/hangouts-core` (HTTP client, types, login helpers) and `@snapie/hangouts-react` (provider, rooms, studio, viewer, chat, boosts and more). |

Two room modes:

- **`conference`**: an audio room with a stage (host, speakers, listeners), hand
  raising, optional video, recording, games, podcast recording.
- **`standalone`**: a live stream. The host's browser studio composites everything
  into one program track; viewers watch it (WebRTC or HLS) and chat. One collab
  guest can join on air.

## Quick start: embed OpenPods in your Hive app

```bash
npm install @snapie/hangouts-react @snapie/hangouts-core livekit-client @livekit/components-react
```

A complete page: sign in with Keychain (or any Aioha provider), list rooms, open
one. Signed-out visitors can browse and listen as guests.

```tsx
import { useState } from 'react';
import {
  HangoutsProvider, RoomLobby, HangoutsRoom, useHangoutsAuth,
} from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

const API = 'https://hangout-api.3speak.tv';     // your OpenPods API
const LIVEKIT = 'wss://livekit.3speak.tv';       // your LiveKit URL

function Rooms() {
  const { isAuthenticated, username, login, logout } = useHangoutsAuth();
  const [room, setRoom] = useState<string | null>(null);

  if (room) {
    return (
      <HangoutsRoom
        roomName={room}
        onLeave={() => setRoom(null)}
        guestFallback                    // signed-out users listen as guests
        video                            // camera and screen share for speakers
        getShareUrl={(name) => `${location.origin}/?room=${name}`}
      />
    );
  }
  return (
    <>
      {isAuthenticated
        ? <button onClick={logout}>Sign out @{username}</button>
        : <button onClick={() => login(prompt('Hive username') ?? '')}>Sign in with Keychain</button>}
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

Notes:

- `HangoutsRoom` picks the UI from the room: a conference room UI, the studio for
  the host of a stream, or the stream viewer for everyone else.
- With [Aioha](https://aioha.dev), pass `aioha={aiohaInstance}` to the provider:
  `login()` and boost transfers then go through the user's chosen wallet. A
  custodial login works the same way with an `AiohaLike` adapter (`signMessage`,
  optional `transfer`).
- If your app already has an OpenPods session, pass `sessionToken` and `username`
  to the provider instead of calling `login()`.
- `RoomLobby` has its own Keychain sign-in form when signed out and
  `allowGuestBrowse` is not set.
- To show only a stream player (no lobby), see [Watching a stream](#watching-a-stream).

## Auth

1. `POST /auth/challenge { username }` returns a nonce (5 minutes, single use).
2. The user signs it with the posting key (`requestSignBuffer` in Keychain,
   `signMessage(msg, 'posting')` in Aioha).
3. `POST /auth/verify { username, challenge, signature }` returns `{ token }`, a
   24 h HS256 JWT. A signature by an account the user granted posting authority to
   (for example a custodial service account) is also accepted.

`loginWithKeychain(client, user)`, `loginWithAioha(client, aioha, user?)` and
`loginWithSignFn(client, user, sign)` in `@snapie/hangouts-core` do all three steps
and set the token on the client. `GET /auth/me` checks a stored token.

A custodial login (keys held by your backend) is an `AiohaLike` adapter passed as
`aioha` to the provider:

```ts
import type { AiohaLike } from '@snapie/hangouts-core';

const custodial: AiohaLike = {
  getCurrentUser: () => username,
  isLoggedIn: () => true,
  // Login: sign the challenge with the posting key on your backend.
  signMessage: async (message) => {
    const res = await fetch('/api/custodial/sign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, message }),
    });
    return { success: true, result: (await res.json()).signature };
  },
  // Boosts (optional): send the transfer for the user.
  transfer: async (to, amount, currency, memo) => {
    const res = await fetch('/api/custodial/transfer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: username, to, amount, currency, memo }),
    });
    return res.ok ? { success: true } : { success: false, error: await res.text() };
  },
};
// <HangoutsProvider aioha={custodial} ...>
```

Suspended accounts (`banned: true` in `embed-users`) get 403 on every route with
the ban check.

## Rooms, roles and identities

- Room name: `<host>-<7 random chars>`. Rooms close 300 s after the last person leaves.
- Visibility: `public` (listed, guests welcome), `hive-internal` (listed, Hive
  accounts only: `/listen` and the chat backlog refuse anonymous callers),
  `unlisted` (not in `/rooms` or `/streams`, guests with the link welcome).
- Role is derived on the client: `host` if identity equals `meta.host`, `speaker`
  if the participant can publish, else `listener`.
- LiveKit tokens last 6 h (12 h for silent OBS observers).

| Identity | Who |
|---|---|
| `<hive account>` | A signed-in user (host, speaker, viewer). |
| `<account>~watch` | The host or the on-air guest on a second device: watch only, so the device that broadcasts is not kicked. The answer has `liveElsewhere: true`. |
| `guest-<12 chars>` | Anonymous viewer from `/listen`. Can chat and raise a hand. Can be promoted, kicked, or IP-banned per room. At most `MAX_GUESTS_PER_ROOM` (50) on WebRTC per room. |
| `obs-<8 chars>` | Silent observer for the OBS browser-source overlay (no data, hidden from counts). |
| `obs-ingress-<room>` | The studio's WHIP source (OBS or phone screen). |
| `obs-battle-<host>` | The hidden link viewer a studio opens into the other room during a battle. |

Every `obs-*` identity is left out of viewer counts.

**Guests can chat.** `/listen` gives guests `canPublishData`, and the chat backlog
accepts a guest's line when it carries the guest's room token. To make chat
read-only for guests in your UI, pass `readOnly` (and `readOnlyNotice`) to `ChatPanel`.
Polls, predictions, boosts and raids settings need a Hive account.

Moderation: the host can promote, demote, kick, ban guests and appoint moderators
(`meta.mods`, Hive accounts only). Moderators can kick, ban guests and delete chat lines.

## Room metadata

LiveKit pushes `room.metadata` (one JSON object) to every participant on each
change. The server writes it under a per-room lock (`mutateRoomMetadata`); clients
never write it directly. Every participant can read all of it.

| Field | Type | Meaning |
|---|---|---|
| `title`, `description`, `host`, `createdAt`, `backgroundImage` | | Set at create. `host` changes on a host transfer. |
| `visibility` | `public \| hive-internal \| unlisted` | Access tier. `allowGuests` mirrors it for older rooms. |
| `mode` | `conference \| standalone` | Room kind. |
| `language`, `origin` | string | BCP-47 tag; hostname of the site that created the room. |
| `post` | `{ title, thumbnail, description, tags }` | Feed card of a stream. |
| `liveAt` | ISO | First go-live, server clock. Anchor for chat, poll and clip timecodes. |
| `broadcasting` | boolean | Actually on air (Start/Resume true, Pause false; studio heartbeat every 15 s). |
| `willPublishVod`, `portrait` | boolean | A VOD is coming; the broadcast is 9:16. |
| `collabGuest` | string | The one on-air guest of a stream. |
| `mods` | string[] | Moderators. |
| `boost` | `{ enabled, minBoostUsd, creatorPayoutAccount, goal, tiers, alerts, presets }` | Host's boost settings. |
| `boostStats` | `{ count, totalHbd, goalHbd, supporters[], goalReachedAt, goalReachedFor }` | Tally, written only by the boost listener. |
| `battle` | Battle object | The running battle, the same object in both rooms. |
| `captions` | `{ lang }` | Captions are on (viewers show the CC button). |
| `vertical` | `{ on, x, w, follow, track }` | The host's 9:16 crop. |
| `recordLayout`, `focusedIdentity`, `suppressScreenAutoFocus`, `chatOpen` | | Conference view state, so the recorder shows what the host sees. |
| `recordBg`, `streamBg` | string | Backgrounds for the egress templates. |
| `headless`, `templateId`, `watermark`, `whipSession` | | OBS-driven stream (see Templates). |
| `podcastLive` | | A podcast recording runs (`/streams` shows `podcast: true`). |
| `eventId` | string | Room started from a scheduled event. |

Participant metadata and attributes are not used. Display names come from the token
`name`.

## Data channel topics

All messages are UTF-8 JSON, sent reliable unless noted. In React use
`useDataChannel(topic, cb)` from `@livekit/components-react`, or the SDK hooks.

| Topic | Sent by | Trust | Message |
|---|---|---|---|
| `chat` | any participant (`useChat`) | participant | `{ type: 'chat', text, timestamp }` (older clients also send `identity`, `name`: ignored). Line id = `${sender identity}-${timestamp}`. |
| `chat` | server | server | `{ type: 'chat-delete', id }` (mod delete), `{ type: 'chat-purge', identity }` (guest ban), `{ type: 'system', id, identity, name, text, timestamp, system: { kind: 'raid', from, viewers } }` (raid arrives). |
| `hand-raise` | any participant | participant | `{ type: 'hand_raise', raised, identity, timestamp }`. `identity` other than the sender only for the host lowering someone's hand. |
| `boost` | server (boost listener) | server | `{ type: 'boost', id, room, sender, displayName?, message, amount, asset: 'HIVE'\|'HBD', usdAmount, feeAmount, payoutAmount, recipient, txId, blockNum, timestamp, belowMinimum? }` |
| `poll` | server, about 1/s per room at most | server | `{ type: 'poll', poll: PollView }` |
| `raid` | server | server | `{ type: 'raid-start'\|'raid-go'\|'raid-cancel', raid: { id, from, target: { roomName, host, title }, viewers, endsAt, endsInMs } }` |
| `game` | server | server | `game:started`, `game:state`, `game:broadcast`, `game:feedback`, `game:ended` (each with `serverTime`). Moves go over HTTP. |
| `captions` | host studio | host | `{ t: 'cap', id, text, final, lang }`. Partials lossy (at most every 400 ms), finals reliable. |
| `view-state` | host (`useViewStateBroadcast`) | host | `{ type: 'view-state', focusedIdentity, suppressScreenAutoFocus, timestamp }` |
| `volume` | host (tile volume slider) | host | `{ type: 'volume', identity, volume (0..1), timestamp }`. Applied by every client and the recording. |
| `draw` | Fast Draw drawer, lossy | current drawer | `{ type: 'draw_stroke', stroke }` or `{ type: 'draw_clear' }` |

Battles, boost goals, captions state and the vertical crop live in room metadata,
not on a topic.

### Who sent it: how the SDK checks

The server does not inspect data packets: LiveKit relays them to anyone with
`canPublishData`, and every viewer has that (anonymous guests too, so they can chat).
So any participant can put any payload on any topic. What a participant cannot fake
is the sender: LiveKit stamps each packet with the publisher's identity, and a packet
the server sent with `RoomService.sendData` arrives with no participant. Every SDK
listener checks that sender before it believes a packet (`lib/dataTrust.ts`):

- **server** topics count only when there is no participant sender
  (`msg.from` undefined in `useDataChannel`, `participant` undefined in
  `RoomEvent.DataReceived`). A participant-made boost card, poll result, raid
  (raid-go would send every viewer to the attacker's room), game message, chat
  delete/purge or system line is dropped.
- **host** topics count only when the sender's identity is `host` in the room
  metadata (only the server writes metadata). Host transfers follow the metadata.
- **participant** topics are anyone's, but who said it is the LiveKit sender:
  a chat line's identity and name come from the participant (its token `name`, set by
  the server: the Hive account for signed-in users, the chosen name for guests), never
  from the payload. Payload `identity`, `name`, `isHost` and similar fields are ignored.
  A hand-raise is always the sender's own hand; only the host may lower someone else's.
- **draw** strokes count only from the current drawer the server's game state names.

The chat backlog (`POST /rooms/:name/chat`) applies the same rule on the server: the
identity is bound to the session or room token, and the stored name comes from the
account or the token, not the request body.

If you read topics yourself, do the same. The SDK exports the checks:

```ts
import { useDataChannel } from '@livekit/components-react';
import { readBoostPacket, readChatPacket, readVolumePacket, hostFromMetadata, isServerSent } from '@snapie/hangouts-react';

useDataChannel('boost', (msg) => {
  const boost = readBoostPacket(msg.payload, msg.from); // null unless the server sent it
  if (boost) showCard(boost);
});
```

Each `read*Packet(payload, from, ...)` returns the checked message or null
(`readChatPacket`, `readBoostPacket`, `readPollPacket`, `readRaidPacket`,
`readGamePacket`, `readCaptionPacket(…, host)`, `readViewStatePacket(…, host)`,
`readVolumePacket(…, host)`, `readHandRaisePacket(…, host)`, `readDrawPacket(…, drawer)`);
`DATA_TOPIC_TRUST` lists the class of each topic. Without React: in
`room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => …)`, treat
`participant === undefined` as the server and `participant.identity` as the only
sender identity. Never show a payload's `identity` or `name` as the author, and never
navigate, credit or remove anything on a client-sent message. A browser source or
recording template you build (OBS overlay, egress) needs the same checks: the demo's
`EgressTemplate.tsx` takes chat authors from `msg.from` and volume only from the host.

## SDK packages

| Package | Version | Use |
|---|---|---|
| `@snapie/hangouts-core` | 0.16.0 | No dependencies. `HangoutsApiClient`, `HangoutsApiError`, login helpers, types, track names. Use it without React or on a server. |
| `@snapie/hangouts-react` | 0.27.3 | Peer deps: `react` 18 or 19, `livekit-client` 2, `@livekit/components-react` 2. Re-exports most of core. |

Styles: `import '@snapie/hangouts-react/src/styles/hangouts.css'` (one file, it
imports the rest). Classes use the `hh-` prefix, colours the `--hh-*` variables.
Theme: `data-hh-theme="light|dark"` on an ancestor, or the provider's `theme` prop.

### Core client

`new HangoutsApiClient({ baseUrl, premiumBaseUrl? })`, then `setSessionToken(token)`.
Errors throw `HangoutsApiError` with `status` and `body`. Methods cover auth, rooms
(`listRooms`, `getRoom`, `createRoom`, `joinRoom`, `listenAsGuest`, `joinAsObserver`,
`deleteRoom`, `transferHost`, `setRoomLayout`, `setRoomViewState`), moderation
(`setPermissions`, `kickParticipant`, `banGuest`, `setModerator`), recording
(`startRecording`, `stopRecording`, `getRecordingStatus`, `setRecordingLayout`,
`fetchRecordingFile`, `uploadRecording`), DVR (`startDvr`, `stopDvr`, `clipDvr`,
`dvrStatus`), restream (`startStream`, `stopStream`, `getStreamStatus`), streams
(`updateStreamPost`, `setBroadcasting`, `startWhipIngress`, `stopWhipIngress`),
boosts (`getBoostConfig`, `updateBoostConfig`), events and presence, games, and Pro
(`getPremiumStatus`, `listPremiumUsers`, `startProTrial`). Newer routes (chat backlog,
polls, raids, battles, captions, overlays, vertical, highlights, rewind, podcast) are
called by the React SDK with `fetch`; use the routes directly from other clients.

Track names (`tracks.ts`): `studio-program` (the composited video), `studio-mix`
(the program audio), `studio-vertical` (optional 9:16 track), `host-monitor`
(mix-minus for a guest or battle opponent).

### Main React components

| Component | Needs | Key props |
|---|---|---|
| `HangoutsProvider` | | `apiBaseUrl`*, `livekitServerUrl` (default `wss://livekit.3speak.tv`), `sessionToken`, `username`, `aioha`, `imageServerApiKey` (enables the image picker), `theme`, `premiumApiBaseUrl`, `pro` (VSC checkout config), `onRequestAuth` (lazy sign-in). |
| `HangoutsRoom` | provider | `roomName`*, `onLeave`, `onEnded`, `onError`, `embedded`, `maxHeight`, `video`, `guestFallback`, `getShareUrl(room, origin)`, `notificationSounds` (true), `pushToTalk`, `obsBaseUrl` (`""` hides OBS), `onVideoHandoff` / `onAudioHandoff` (recording files to your uploader, conference rooms), `onGameEnd`, `onActiveGameChange`. Stream props passed to the studio: `onStreamStart(post)`, `onStreamVod(result)`, `renderPostExtras`, `canPublishVod`, `isUnlisted`, `watermarkLogoUrl`, `captions`, `phoneSourceLabels`, and `standaloneViewerEmbed` for the viewer. |
| `RoomLobby` | provider | `onJoinRoom`*, `onRoomCreated(room, { notifyOnHive, announceType })` (you post the Hive announcement), `allowGuestBrowse`, `allowStandalone`, `createOnly`, `defaultMode`, `defaultCreateOpen`, `stepped`, `fetchRooms`, `renderAnnounceOptions`, `renderDescriptionEditor`, `renderStandaloneExtras`, `labels`, `stepLabels`, `locale`, `isPremium`, `upsellPerks`. |
| `StandaloneStudio` | inside `LiveKitRoom` + `BoostStoreProvider` (HangoutsRoom does this) | `roomName`*, `title`*, `onEndRoom`*, `onClose`, `shareUrl`, `initialPost`, `onStreamStart`, `onStreamVod`, `canPublishVod`, `isUnlisted`, `watermarkLogoUrl`, `obsBaseUrl`, `captions`, `phoneSourceLabels`, `isPremium`. |
| `StandaloneWatch` | provider | `roomName`*, `children`*, `connecting`, `audioMuted`, `onRaid(target)`, `liveLabels`. Joins by itself (signed in or guest) and provides the stream context to its children. |
| `StreamVideo`, `StreamViewerCount`, `StreamQualityControl`, `StreamCaptions`, `StreamPollCard`, `StreamBoostGoal`, `StreamBattleBar`, `RaidBanner`, `CollabRequest`, `ChatPanel` | inside `StandaloneWatch` | Building blocks of a watch page. `StreamVideo`: `format: 'landscape'\|'vertical'\|'auto'`, `showLiveBadge`, `showBoostGoal`, `showBattle`. `ChatPanel`: `readOnly`, `readOnlyNotice`, `onMessageSent(text)`, `showPolls`. |
| `StandaloneViewer` | inside `LiveKitRoom` | The ready-made full viewer HangoutsRoom uses: `roomName`, `title`, `hostIdentity`, `onLeave`, `isGuest`, `boostConfig`, `embed`. |
| `StandaloneObsOverlay` | none | `serverUrl`, `token` (an `obs-` token), `hostIdentity`. A transparent browser source for OBS. |
| `PodcastRecordControls` | inside a conference room | `roomName`, `onAudioHandoff(file)`. Shown by `RoomControls` for the host. |
| Boosts | | `SendBoostDialog`, `BoostOverlay`, `BoostAlerts`, `BoostHistoryPanel`, `BoostSettingsPanel`, `BoostTopSupporters`. |
| Pro | | `ProPlans`, `ProUpsellDialog`, `SubscriberTicker`. |
| Conference parts | inside `LiveKitRoom` | `SpeakerStage`, `AudienceSection`, `RoomControls`, `ParticipantTile`, `HostControlsPanel`, `RoomHeader`, `GamePanel`. |

### Main hooks

| Hook | Returns |
|---|---|
| `useHangoutsAuth()` | `{ username, isAuthenticated, login(user?), logout(), isLoading, error, canSignIn }` |
| `useHangoutsRoom()` | `{ livekitToken, roomName, roomMeta, isHost, isGuest, delivery, hlsUrl, create(...), join(room, { hlsCapable, delivery }), listen(room, name?, opts), leave(), endRoom(), transferHost(), setLayout() }` |
| `useRoomList(fetch?)` | `{ rooms, isLoading, error, refresh }`, polls every 10 s |
| `useChat()` | `{ messages, sendMessage(text) }`, merges the backlog on connect |
| `useHandRaise()`, `useHostControls(room)` | hand raising; `promote`, `demote`, `kick`, `ban`, `setModerator`, `endRoom` |
| `usePolls(room)`, `useRaid(room)` | live poll with `vote`, `stake`, host `create/end/resolve/cancel`; the raid counting down |
| `useBoostStore()`, `useBoosts()`, `useRoomBoost()`, `useBoostAlerts()` | boost events; goal, tally and settings from metadata; chime and TTS |
| `useRoomBattle()`, `useStudioBattle()` | battle state for viewers; invite/respond/end for the studio |
| `useLiveCaptions()`, `useStudioCaptions()` | captions for viewers; the studio's caption session |
| `useWhipIngress(room)` | `start({ transcode, source: 'obs'\|'phone' })`, `stop()`, `info` |
| `useRecording(room)`, `useStreaming(room)` | conference recording; restream to YouTube/Twitch/a custom server |
| `usePremiumStatus(user?)`, `useProTrial()` | Pro status; the one-time trial |
| `useEventList()`, `useUserPresence(user)` | events; is a user in a room now |
| `useStreamContext()`, `useStreamLive()`, `useStreamFormats()` | inside `StandaloneWatch` |
| `useChess`, `useFastDraw`, `useWordGuess` | games |

Every hook that touches LiveKit must run under a `LiveKitRoom` (HangoutsRoom and
StandaloneWatch provide one).

## Theming

The SDK colours come from CSS variables. The theme follows `prefers-color-scheme`
unless an ancestor has `data-hh-theme="light"` or `"dark"`, or the provider gets
`theme`. The resolved theme is mirrored onto `document.body` so dialogs rendered in
portals follow it.

```css
/* your brand, for every OpenPods component inside .my-app */
.my-app {
  --hh-primary: #0066ff;
  --hh-primary-hover: #0052cc;
  --hh-bg: #f9f9f9;
}
```

| Variables | Use |
|---|---|
| `--hh-bg`, `--hh-bg-secondary`, `--hh-bg-hover`, `--hh-surface` | backgrounds |
| `--hh-text`, `--hh-text-secondary`, `--hh-text-muted` | text |
| `--hh-border`, `--hh-border-light`, `--hh-input-border`, `--hh-shadow` | lines and depth |
| `--hh-primary`, `--hh-primary-hover`, `--hh-accent` | brand and highlights |
| `--hh-btn-secondary-bg`, `--hh-btn-secondary-hover`, `--hh-btn-secondary-text` | secondary buttons |
| `--hh-danger`, `--hh-success` | states |
| `--hh-pro-gold`, `--hh-pro-gold-soft`, `--hh-pro-gold-strong` | Pro badges and upsells |

Every class starts with `hh-`, so you can target any part (for example
`.hh-chat`) without clashing with your own CSS.

## The studio

`StandaloneStudio` is the host's broadcast page for a `standalone` room. Everything
is composited in the browser into one canvas and published as `studio-program`
(video) and `studio-mix` (audio). Viewers, the VOD, the DVR and HLS all use that
track, so whatever the host sees is what everyone gets.

| Feature | How it works | Routes |
|---|---|---|
| Scenes | `cam`, `fullscreen` (one source), `overlay` (source plus a movable camera picture), `split` (side by side), `splitv` (stacked, used with a guest). The last setup is restored from browser storage. | |
| Sources | Camera and mic, up to 4 screen shares, image, GIF and video files (100 MB), music files, extra audio inputs, all through a mixer with faders and meters. | |
| OBS source (Pro) | A WHIP ingress joins as `obs-ingress-<room>`; the studio draws it as a source. | `POST /rooms/:name/ingress { source: 'obs' }` |
| Phone or tablet screen (free) | A guide, per computer (Mac, Windows, Linux) and phone (iPhone/iPad, Android), to mirror the phone to this computer (AirPlay, an AirPlay receiver, UxPlay, scrcpy by cable or Wi-Fi, Wireless Display), then a button that opens the window share. No app on the phone, nothing through a server. Labels: `phoneSourceLabels`. | (window share; `POST /rooms/:name/ingress { source: 'phone' }` still serves a host's existing phone address) |
| Quality | Low 640x360, medium 854x480, high 1280x720 (Pro). | |
| Go live | Standby, live, paused. First live: `onStreamStart(post)`, `PATCH /live` (server stamps `liveAt`, applies the daily limit), VOD recording if chosen. `PATCH /broadcast` on every change and every 15 s. A reloaded studio resumes a stream that is still broadcasting. Caps: free 30 min, Pro 4 h. | `/post`, `/live`, `/broadcast` |
| Collab guest | A viewer asks (`CollabRequest`, hand raise); the host approves one guest, who appears in `splitv` and hears `host-monitor`. | `PATCH .../permissions` |
| Overlays | Lower third, ticker, countdown, fades, "be right back" slate with music. Drawn into the canvas. Up to 12 named templates saved per host. | `GET/PUT /studio/overlays` |
| Vertical | `track` mode publishes a 9:16 `studio-vertical` track; `crop` mode only reports the crop so phone viewers crop themselves. Manual or following the camera or source. | `PATCH /rooms/:name/vertical` |
| Stream health | Every 2 s: bitrate, fps, size, dropped frames, loss, RTT. "Auto" steps the quality down and up without republishing. Client only. | |
| Live captions | Off unless the server has `CAPTIONS_ENABLED=true`. You supply the speech-to-text as `captions={{ source, languages }}`, where `source(track, { lang, onText, onStatus })` returns `{ stop() }`. Text goes out on `captions`; cues come back in `onStreamVod` for subtitles. | `/captions/*` |
| Polls and predictions | Host runs them from the Live tab; viewers vote in `StreamPollCard`. | `/rooms/:name/polls*` |
| Raids | Host picks a live stream; viewers get a countdown and `onRaid(target)` moves them. | `/rooms/:name/raid*` |
| Battles | Invite another live studio for 3, 5 or 10 minutes; boosts decide. Each studio links into the other room and draws both halves. Not for OBS streams or with a guest on air. | `/battles/*` |
| Boosts | Cards, goal bar, tiers (0, 1, 5, 20 HBD shown 15, 30, 60, 120 s), sound and TTS alerts, preset amounts, changeable mid-stream. | `PATCH /rooms/:name/boost` |
| Restream, OBS output | Restream to YouTube, Twitch or any RTMP server such as Restream.io or Kick (Pro). "OBS output" makes a browser-source URL for `StandaloneObsOverlay`. | `/stream/*`, `/listen { silent }` |
| DVR, clips, rewind | Pro: started automatically while live when the host allows clips. | `/dvr/*` |
| Free watermark | Non-Pro streams carry a watermark drawn into the canvas (`watermarkLogoUrl`). | |

## Watching a stream

```tsx
import {
  HangoutsProvider, StandaloneWatch, StreamVideo, StreamViewerCount, ChatPanel,
} from '@snapie/hangouts-react';

<HangoutsProvider apiBaseUrl={API} livekitServerUrl={LIVEKIT} sessionToken={token} username={user}>
  <StandaloneWatch roomName="badadib-k3x9q2a" onRaid={(t) => navigate(`/live/${t.roomName}`)}>
    <StreamVideo format="auto" />
    <StreamViewerCount />
    <ChatPanel readOnly={!user} readOnlyNotice="Sign in to chat" />
  </StandaloneWatch>
</HangoutsProvider>
```

`StandaloneWatch` joins (signed in) or listens (guest), always says `hlsCapable`,
moves to HLS when the server says so, and upgrades a guest connection once a session
arrives. For discovery use `GET /streams`; for one stream `GET /rooms/:name`.

## HLS delivery

For big audiences the server moves viewers from WebRTC to HLS.

- `HLS_VIEWER_THRESHOLD` (default `50`): the first 50 WebRTC viewers of a stream stay
  on WebRTC, the next ones get HLS. `0` = everyone on HLS. Empty = HLS off (then
  the guest cap refuses extra anonymous viewers with 409).
- An HLS viewer still joins the LiveKit room (chat, boosts, polls, raids, viewer
  count) but with `canSubscribe: false`, so it costs the SFU almost nothing. The join
  answer has `delivery: 'hls'` and `hlsUrl`.
- `HLS_WEAK_FALLBACK` (default on): a WebRTC viewer whose connection stays poor for
  15 s may rejoin with `delivery: 'hls'` (the answer has `hlsFallback: true`).
  The same goes for a viewer whose browser can't show the video at all: an OBS
  stream is H.264 as OBS sent it (`OBS_PASSTHROUGH`), and a browser without H.264
  (Firefox before its OpenH264 add-on, LibreWolf, Chromium without the licensed
  codecs) decodes no frame. `StandaloneWatch` notices that after 12 s of visible
  time and rejoins with `delivery: 'hls'` (SDK `lib/undecodableVideo.ts`).
- One HLS egress per stream (2 s segments, one rendition at `HLS_VIDEO_BITRATE`),
  started by the first HLS viewer, stopped 5 minutes after the last one.
- `HLS_PUBLIC_BASE` puts a CDN in front (origin = this API's `/rooms/:name/hls/*`).
  Playlists are cached 1 s, segments a day.
- The host and the on-air guest always use WebRTC. Only standalone streams use HLS.

## Recording, VOD, DVR, clips and rewind

**Conference recording** (Pro): audio (64 kbps) or video with the speaker, grid or
single layout, rendered by the egress template at `EGRESS_TEMPLATE_URL`. On stop
the host gets a download token; the SDK hands the file to your `onAudioHandoff` /
`onVideoHandoff` so you choose where to publish it.

**Stream VOD**: the studio starts a recording of `studio-program` + `studio-mix`
when the host chose "publish". On stop the server uploads the MP4 itself to the
3Speak embed service as `{ owner: host, permlink: roomName }`, so the stream's
watch link turns into the VOD once encoding is done. Poll
`GET /rooms/:name/record/publish-status`. A crash watchdog publishes too when the
host vanishes. Free hosts may publish a VOD of up to 30 minutes; the download copy
is Pro.

**DVR** (Pro, `DVR_ENABLED`): a second egress writes 2 s HLS segments and keeps the
last `DVR_BUFFER_SEC` (150 by default) on disk.

- **Clips**: any viewer can clip the last 30 s (`POST /rooms/:name/dvr/clip`).
  Signed-in clippers are credited and their clips kept `CLIP_KEEP_HOURS` (48).
  With DVR the clip is ready at once (`status: 'ready'`, `path`).
- **Clips without DVR** (free streams too): a stream that records its VOD answers
  the same route with `{ pending: true, clip: { status: 'pending', path: null } }`.
  `GET /rooms/:name/dvr/status` says `clips: 'after'` for such a stream. When the
  recording ends, before the VOD upload deletes the file, every pending clip is cut
  from it with an ffmpeg stream copy (niced, one at a time, the whole step capped at
  90 s) and turns `ready`. One that cannot be cut becomes `unavailable` with a
  `reason`: `past_cap` (after a free stream's 30 minutes), `past_end`,
  `no_recording` (no file, or the VOD was off) or `failed`. A clip failure never
  holds up the VOD.
- **Highlights**: chat and boost spikes in 20 s buckets become moments
  (`HIGHLIGHTS_ENABLED`). Chat lines are counted by the chat backlog route. While
  DVR runs each moment cuts an automatic clip; without DVR it is a pending clip
  cut from the recording. The host sees them in `GET /rooms/:name/highlights`.
  `POST /clips/:id/vertical` makes a 9:16 copy of a ready clip with the host's
  crop, ready for a Short. `GET /clips/mine` lists the clips a user made and every
  clip of their own streams.
- **Clips ready**: once a stream's clips exist (end of a DVR stream, or after the
  cut from the recording) the server posts `{ room, host, title, total, clippers }`
  to the checker's `POST /stream-stats/clips-ready` (`STREAM_STATS_SECRET`): the
  host and each clipper get a bell notification and a push.
- **Rewind**: `GET /rooms/:name/dvr/rewind` gives viewers an HLS playlist of the
  DVR window to seek back in while the stream is live.

**Chat after the stream**: the backlog route answers only while the room exists.
Replay against the VOD uses `meta.liveAt` as the time anchor, the lines your app
saved (for example through `ChatPanel onMessageSent`), `GET /rooms/:name/polls`
(each poll has `offset`) and the caption cues.

## Record as podcast

In a conference room the host (Pro) can record the show as a podcast episode
(`PodcastRecordControls`, `PODCAST_RECORDING_ENABLED`). The server runs one audio
track egress per speaker (no browser render), adds chapters when speakers join and
when the host adds a marker, and on stop mixes one MP3. The answer has the mix, a
file per speaker with its start offset (for an audio editor) and the chapters, all
behind one-day links. While it records, `/streams` shows `podcast: true` so a
podcast feed can announce a live item.

## Templates and headless OBS streams

A Pro user can go live from OBS alone, with no browser open:

1. Create a template (`POST /templates`): title, description, thumbnail, tags,
   language, visibility, boost settings, `recording: { publishVod, allowClips }`,
   `announce: { enabled, community, declineRewards, rewardPowerup, beneficiaries }`.
2. Get the streaming secret (`GET /stream-secret`).
3. In OBS (30.2+): Service **WHIP**, Server `${PUBLIC_WHIP_BASE}/<owner>/<slug>`
   (the template's `whipUrl`), Bearer Token = the secret.

When OBS connects, the server creates the room (`headless: true`), connects the
ingress as the host with the same track names the studio uses, stamps go-live,
starts VOD and DVR as the template says, posts the Hive announcement through
`ANNOUNCE_API_URL`, enforces the time cap and tears it all down when OBS stops.
The LiveKit stream key never leaves the server: OBS talks to `/whip/s/<token>`.
`GET /templates/:id/status` shows the state; `GET /overlay/:key` lets an OBS chat
dock find the live room. A restart re-adopts streams whose ingress still publishes.

## Pro and quotas

Pro = `premium: true` on the account's row in `embed-users` (set by the 3Speak
checker from a subscription, by the trial, or by hand). The SDK reads it from
`GET /premium/:username`.

| | Free | Pro |
|---|---|---|
| Streams per rolling 24 h | 1 (counts once it goes live, once per room; `STREAM_LIMIT_EXEMPT` skips it) | unlimited |
| Stream length | 30 min | 4 h |
| Stream VOD | yes, up to 30 min, no download | yes, with download |
| Studio quality | up to 854x480 | up to 1280x720 |
| OBS source and OBS templates | no (403 `pro_required`) | yes |
| Phone screen source | yes | yes |
| Conference recording, podcast recording | no | yes |
| Clips and highlights (from the VOD, after the stream) | yes, first 30 min | yes |
| DVR (instant clips), rewind | no | yes |
| Restream to YouTube, Twitch or a custom server | no (402) | yes |
| Watermark | yes | no |

The one-time trial (`POST /premium/start-testing`) gives Pro for `PRO_TESTING_HOURS`
(24) and is on unless `PRO_TESTING_ENABLED=false`. Over the daily limit, routes
answer 429 `{ error: 'daily_stream_limit', message, retryAt }`.

## Boosts

A boost is a HIVE or HBD transfer to `BOOST_PLATFORM_ACCOUNT` with the memo
`{"version":1,"room":"<room>","message":"<text>","sender":"<account>","nonce":"<6-128 chars>","displayName":"...","recipient":"<on-air guest>"}`.
`SendBoostDialog` builds it and signs through Keychain or `aioha.transfer`.

The server polls Hive, then for each transfer: parses the memo, checks the room
and its boost settings, prices HIVE in USD (CoinGecko, `BOOST_HIVE_USD_*`), pays the
host's `creatorPayoutAccount` (or the on-air guest the memo names) minus
`BOOST_PLATFORM_FEE_PERCENT`, publishes a `boost` message and updates
`meta.boostStats`. Transfers it cannot place (unknown room, boosts off, bad memo)
are refunded to the sender. Boosts under `minBoostUsd` are paid but flagged
`belowMinimum` (no overlay). Nothing runs unless `BOOSTS_ENABLED=true`.

## Events and presence

Scheduled events (`hangouts-events`) have a title, a time in the future, a cover,
tags, visibility (`public` or `unlisted`) and attendees. `POST /events/:id/start`
opens a conference room for the event and returns a host token. Events whose room
has gone away are shown as ended. Presence (`GET /presence/:username`,
`POST /presence/bulk`) says whether an account is in a room right now and in which
role.

## Server configuration

All keys are read in `server/src/config.ts` (zod; the server exits on an invalid
value). Required ones have no default.

| Key | Default | Meaning |
|---|---|---|
| `LIVEKIT_HOST` | required | LiveKit HTTP URL for the server SDK (e.g. `http://127.0.0.1:7880`). |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | required | LiveKit key pair (same pair in egress and ingress). |
| `SESSION_SECRET` | required, 32+ chars | Signs session JWTs, rewind tokens and, if `STREAM_KEY_SECRET` is empty, streaming secrets. |
| `PORT` | `3002` | HTTP port. |
| `HIVE_API_NODE` | `https://api.hive.blog` | Hive RPC for signatures and boosts. |
| `MONGODB_URI` | empty | Mongo. Without it the stores that can fall back keep state in memory; templates, overlays and Pro answer 503 or "not Pro". |
| `AUDIO_API_URL`, `AUDIO_API_KEY` | `https://audio.3speak.tv`, empty | Legacy audio upload route. |
| `EMBED_UPLOAD_URL`, `EMBED_API_URL`, `EMBED_API_KEY` | `https://embed.3speak.tv/uploads`, `/api`, empty | Where stream VODs are uploaded (TUS) and registered. |
| `VIDEO_UPLOAD_URL`, `VIDEO_UPLOAD_TOKEN` | `https://video.3speak.tv`, empty | Declared, not used by any route today. |
| `STUDIO_FRONTEND_URL` | `https://3speak.tv` | Frontend base used in VOD and headless stream links. |
| `CHECKER_URL`, `STREAM_STATS_SECRET` | `https://checker.3speak.tv`, empty | Live stream stats to the 3Speak checker. Empty secret = off. |
| `EGRESS_TEMPLATE_URL` | `https://hangout.3speak.tv/egress-template` | Egress page for conference recordings. |
| `EGRESS_STANDALONE_TEMPLATE_URL` | `https://3speak.tv/egress-stream` | Egress page for stream recordings, DVR and HLS when the track path is not used. |
| `BOOSTS_ENABLED` | `false` | Boost listener and payouts. |
| `BOOST_PLATFORM_ACCOUNT`, `BOOST_PLATFORM_ACTIVE_KEY` | empty | Receiving account and its active key (payouts, refunds). Server-only secret. |
| `BOOST_PLATFORM_FEE_PERCENT` | `5` | Platform fee. |
| `BOOST_HIVE_USD_FALLBACK`, `BOOST_HIVE_USD_CACHE_MS` | `0.25`, `120000` | HIVE price fallback and cache. |
| `BOOST_INGEST_KEY` | empty | Admin key for `POST /boosts/ingest`; empty = route off. |
| `DVR_ENABLED` | `true` | DVR egress kill switch. |
| `DVR_BUFFER_SEC` | `150` (60 to 3600) | DVR window: clip source, and the rewind range when rewind is on (600 for 10 minutes). |
| `REWIND_ENABLED` | `false` | Rewind during a live stream (`GET /rooms/:name/dvr/rewind` answers `available: false, reason: "off"`). |
| `CLIPS_NOTIFY_ENABLED` | `false` | Tell the 3Speak checker when a stream's clips are ready (bell + push to `/clips`). Needs `STREAM_STATS_SECRET` too. |
| `CLIP_KEEP_HOURS`, `CLIPS_DIR_MAX_MB` | `48`, `4096` | How long clips stay, and the disk budget for them. |
| `HIGHLIGHTS_ENABLED` | `true` | Chat and boost spike detection. |
| `PODCAST_RECORDING_ENABLED` | `true` | "Record as podcast" in audio rooms. |
| `INGRESS_WHIP_URL` | `https://livekit.okinoko.io/w` | Public WHIP base handed to the studio's OBS and phone sources (`<url>/<streamKey>`). |
| `PUBLIC_WHIP_BASE` | `https://hangouts.okinoko.io/whip` | Public base of this API's WHIP proxy for headless OBS streams. |
| `INGRESS_WHIP_INTERNAL_URL` | `http://127.0.0.1:8086/w` | The ingress WHIP handler on loopback. |
| `ANNOUNCE_API_URL`, `OPENPODS_ANNOUNCE_SECRET` | `http://127.0.0.1:4021`, empty | Posts the Hive announcement of a headless stream. |
| `STREAM_KEY_SECRET` | empty (derived from `SESSION_SECRET`) | Hashes and encrypts the per-user streaming secrets. Changing it invalidates them. |
| `PRO_TESTING_ENABLED`, `PRO_TESTING_HOURS` | `true`, `24` | The free Pro trial. |
| `STREAM_LIMIT_EXEMPT` | empty | Comma list of accounts without the daily stream limit. |
| `HLS_VIEWER_THRESHOLD` | `50` | WebRTC viewers per stream before HLS. `0` = all HLS, empty = HLS off. |
| `HLS_PUBLIC_BASE` | empty | CDN base for HLS; empty = this API. |
| `HLS_WEAK_FALLBACK` | `true` | Poorly connected WebRTC viewers may ask for HLS. |
| `OBS_PASSTHROUGH` | `true` | OBS streams that go live from a template keep OBS's H.264 (about 0.1 CPU core instead of one for re-encoding to VP8). Only while HLS and `HLS_WEAK_FALLBACK` are on, since viewers who can't show H.264 move to HLS. `false` = always re-encode. |
| `HLS_VIDEO_BITRATE` | `2000` kbps | HLS rendition bitrate. |
| `CAPTIONS_ENABLED` | `false` | Live caption slots. |
| `CAPTIONS_MAX_STREAMS`, `CAPTIONS_SLOT_TTL_SEC` | `3`, `90` | Caption slots at once; slot lifetime without renewal. |

Read straight from the environment elsewhere (not in `config.ts`):

| Key | Default | Where |
|---|---|---|
| `MAX_GUESTS_PER_ROOM` | `50` | WebRTC guest cap per room (`routes/rooms.ts`). |
| `CHAT_BACKLOG_SIZE` | `300` | Lines kept per room (`lib/chatBacklog.ts`). |
| `POINTS_START` | `1000` | Starting channel points (`lib/points.ts`). |
| `POINTS_TTL_DAYS` | `90` | A balance untouched this long starts over at `POINTS_START`, logged as an `expire` movement. |
| `POINTS_BOOST_MIN` | `2500` | The smallest boost paid with points. |
| `POINTS_EARN_ENABLED` | `true` | `false` stops the once-a-minute watching and streaming points. |
| `POINTS_BATCH_MIN` | `5` | Earnings are paid out and logged on Hive in batches this often. |
| `POINTS_LOG_ACCOUNT` | `threespeak-pro` | Signs the custom_json points log. |
| `POINTS_LOG_POSTING_KEY` | | Its posting key. Without it, the boost wallet's active key when it is the same account; without either, rows wait in Mongo. |
| `POINTS_TOKEN_CONTRACT` | | The 3Speak Points (3SP) contract on Magi. Empty: points stay Mongo-only. Set it on ONE server only. Live once `npm run points:airdrop -- --yes` ran (`lib/pointsToken.ts`). |
| `POINTS_TOKEN_NET_ID` | `vsc-mainnet` | `vsc-testnet` for the testnet contract. |
| `POINTS_TOKEN_GRAPHQL_URLS` | techcoderx, atexoras | Magi GraphQL endpoints, comma-separated, first that answers. |
| `POINTS_MINTER_ACCOUNT`, `POINTS_MINTER_POSTING_KEY` | `threespeak-pro`, | The minter (`mintBatch`). Empty key: `POINTS_LOG_POSTING_KEY` when it is the same account. |
| `POINTS_SPEND_SIGNER_ACCOUNT`, `POINTS_SPEND_SIGNER_POSTING_KEY` | `threespeak`, | Signs a user's spend (`burn`) under their posting authority. Empty key: the user's wallet signs every spend. |
| `POINTS_MINT_INTERVAL_MIN` | `60` | Minutes between mint batches (the minter pays Magi RC per row). |
| `POINTS_SPEND_WAIT_MS` | `30000` | How long a spend request waits for Magi before answering 202. |
| `POINTS_AWARD_SECRET` | | Shared secret for `POST /points/awards` (the checker's awards, `lib/pointsAwards.ts`) and for booking points promotions on the checker (`PUT /promote/points`). Empty: both off. |
| `POINTS_DOUBLE_WEEKENDS` | `false` | `true`: every earning pays x2 from Saturday 00:00 to Sunday 24:00 UTC (`lib/pointsEvents.ts`). |
| `POINTS_DOUBLE_WINDOWS` | | More double-points windows, a comma list of `<ISO start>/<ISO end>`. |
| `POINTS_FIRSTS_SINCE` | `2026-11-26` | A first stream pays only for accounts whose first stream is on or after this date. |
| `POINTS_QUESTS` | | Quest ids to run every week instead of the built-in rotation (`lib/pointsQuests.ts`). |
| `PROMOTE_POINTS_PER_24H` | `5000` | Points per 24 h to promote a 3Speak video (`POST /points/promote`). |
| `RAID_COUNTDOWN_SEC`, `RAID_COOLDOWN_MIN` | `10`, `10` | Raid countdown and per-host cooldown (`lib/raids.ts`). |

## Mongo collections

All in the database named by `MONGODB_URI`. The server creates its indexes on first use.

| Collection | Holds | TTL |
|---|---|---|
| `embed-users` | Pro and ban flags (shared with 3Speak, written by the checker and the trial). | none |
| `stream-golive` | One row per stream that went live (daily limit). | 2 days |
| `stream-templates` | OBS stream templates (unique owner + slug). | none |
| `stream-secrets` | Per-user streaming secret, hashed and encrypted. | none |
| `studio-overlays` | A host's overlay templates. | 400 days after the last save |
| `chat-backlog` | Recent chat lines per room (batched writes). | 1 day |
| `stream-polls` | Finished polls and predictions. | 1 year |
| `points` | Channel points, one balance per Hive account. | none: a balance untouched for `POINTS_TTL_DAYS` is reset by a logged `expire` movement |
| `points-ledger` | Every points movement (the wallet history), with the Hive tx that logged it. | 400 days |
| `raid-settings` | "Accept raids" opt-out per host. | none |
| `stream-highlights` | Highlight moments per room. | 30 days |
| `stream-clips` | Kept clips (file on disk). | `CLIP_KEEP_HOURS` |
| `hangouts-events` | Scheduled events. | none |
| `word-collections` | Word lists for the word guess game (seeded at start). | none |

In memory only (lost on restart): active recordings, DVR and HLS sessions, polls in
progress, raid countdowns and cooldowns, caption slots, the boost ledger, guest IP
bans, podcast sessions. A sweep every 10 minutes drops the entries of rooms that
are gone.
