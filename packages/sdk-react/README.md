# @snapie/hangouts-react

React SDK for [Hive Hangouts](https://hangout.3speak.tv), Twitter Spaces-style audio rooms for the Hive blockchain. Drop-in components for audio rooms with chat, hand raising, speaker management, recording, and Hive Keychain authentication.

## Install

```bash
npm install @snapie/hangouts-react @livekit/components-react livekit-client
```

## Quick start

```tsx
import { HangoutsProvider, RoomLobby, HangoutsRoom } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

function App() {
  const [room, setRoom] = useState(null);

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
```

### With Aioha (recommended for production apps)

Pass your Aioha instance to `<HangoutsProvider>` and login/boost transfers are routed through it automatically, no Keychain extension required:

```tsx
import { useAioha } from '@aioha/react-ui';

function App() {
  const aioha = useAioha();
  return (
    <HangoutsProvider apiBaseUrl="https://hangout-api.3speak.tv" aioha={aioha}>
      ...
    </HangoutsProvider>
  );
}
```

When `aioha` is present, `useHangoutsAuth().login()` calls `aioha.signMessage()` and boosts call `aioha.transfer()`, covering Keychain, HiveAuth, PeakVault, Ledger, and any other registered provider.

### With a custodial adapter (Google login / managed keys)

For accounts controlled by a backend (e.g. Google OAuth → server-held keys), implement the `AiohaLike` interface from `@snapie/hangouts-core`:

```tsx
import type { AiohaLike } from '@snapie/hangouts-core';

const custodialAdapter: AiohaLike = {
  getCurrentUser: () => username,                  // from your session
  isLoggedIn: () => true,
  signMessage: async (message) => {
    const res = await fetch('/api/custodial/sign', {
      method: 'POST',
      body: JSON.stringify({ username, message }),
    });
    const { signature } = await res.json();
    return { success: true, result: signature };
  },
  transfer: async (to, amount, currency, memo) => {
    const res = await fetch('/api/custodial/transfer', {
      method: 'POST',
      body: JSON.stringify({ from: username, to, amount, currency, memo }),
    });
    return res.ok ? { success: true } : { success: false, error: await res.text() };
  },
};

<HangoutsProvider apiBaseUrl="..." aioha={custodialAdapter}>
```

The custodial backend signs the challenge with the account's active/posting key and broadcasts transfers, the SDK only needs the interface above.

## Features

- **Hive Keychain login**: challenge-response auth with posting key
- **Guest listener mode**: `<HangoutsRoom guestFallback>` lets signed-out viewers join as `guest-*` participants. Guests can chat and raise a hand; the host can promote, kick or ban them. Pass `readOnly` to `ChatPanel` if your app wants sign-in to chat.
- **Room visibility**: Create-room dialog dropdown for `public` / `hive-internal` / `unlisted`. Server filters `unlisted` from the lobby and rejects guests for `hive-internal`.
- **Audio rooms**: real-time voice via LiveKit WebRTC
- **Chat**: text messaging over the data channel, with a server backlog for late joiners (guests can chat too)
- **Boost messages**: paid highlighted messages delivered via the `boost` LiveKit data topic and rendered in-room + OBS overlays.
- **Hand raising**: listeners request to speak
- **Speaker management**: host promotes/demotes participants. Promoted speakers start with mic and camera **off**.
- **Live host transfer**: the host is read from room metadata, so a transfer flips every client's UI without reconnecting.
- **Recording**: audio or video; on stop, integrator-driven 3-button dialog (Upload · Download · Dismiss). Upload hands the raw blob to a callback you supply, the SDK doesn't ship a default publish destination.
- **Share button**: built-in copy/Web-Share button in the room header, gated on a `getShareUrl(roomName, origin)` callback so links land back on the surface that created the room.
- **Theming**: light/dark via CSS custom properties (`--hh-*`)
- **Embedded mode**: fits in modals and panels
- **Error boundary**: catches WebRTC crashes gracefully

## Components

| Component | Description |
|-----------|-------------|
| `<HangoutsProvider>` | Top-level context (API client + auth) |
| `<HangoutsRoom>` | Full room experience (audio, chat, controls) |
| `<RoomLobby>` | Room list + create room + login |
| `<SpeakerStage>` | Speaker grid with speaking indicators |
| `<AudienceSection>` | Listener grid with hand-raise icons |
| `<RoomControls>` | Mute, hand raise, record, leave |
| `<ChatPanel>` | Toggle-able chat with unread badge |
| `<ParticipantTile>` | Avatar with speaking ring |

## Hooks

| Hook | Description |
|------|-------------|
| `useHangoutsAuth()` | Login/logout, auth state |
| `useRoomList()` | Active rooms (polls every 10s) |
| `useHangoutsRoom()` | Join (`join`), create (`create` accepts visibility), guest-listen (`listen`), leave; exposes `isGuest`, `roomMeta`, `transferHost`, `setLayout`, `setViewState` |
| `useChat()` | Send/receive chat messages |
| `useBoosts()` | Receive boost/superchat events from topic `boost` |
| `useHandRaise()` | Hand raise state and actions |
| `useHostControls(roomName)` | Promote, demote, kick, ban a guest, set a moderator, end the room |
| `useRecording()` | Record, stop, fetch blob, download |
| `useHiveAvatar()` | Hive profile picture URL |

## HangoutsProvider props

| Prop | Required | Description |
|------|----------|-------------|
| `apiBaseUrl` | Yes | Base URL of your Fastify server |
| `livekitServerUrl` | No | LiveKit WebSocket URL (default: `wss://livekit.3speak.tv`) |
| `sessionToken` | No | Pre-existing session JWT, skips the login flow if you already have one |
| `username` | No | Authenticated Hive username (paired with `sessionToken`) |
| `imageServerApiKey` | No | Bearer token for `images.3speak.tv`, enables the background image picker |
| `aioha` | No | Aioha instance **or** any `AiohaLike` adapter. Routes login and boost transfers through it. Supports Keychain, HiveAuth, PeakVault, Ledger, custodial adapters, etc. Falls back to direct Keychain when omitted. |

`useHangoutsAuth()` returns `{ canSignIn, isAiohaAvailable, isKeychainAvailable, login, logout, isAuthenticated, username, isLoading, error }`.

## HangoutsRoom props

```tsx
<HangoutsRoom
  roomName="room-name"               // required
  onLeave={() => {}}                  // user left
  onError={(err) => {}}               // WebRTC error
  embedded                            // fit in modal (no min-height)
  maxHeight="80vh"                    // explicit height
  video                               // enable camera + screen share
  guestFallback                       // unauth viewers auto-join via /listen
  pushToTalk                          // default PTT-vs-mute-toggle for first-time visitors;
                                       // each user can flip it themselves after that (persisted per-device)
  onGameEnd={(result) => {
    // Fires once when a game ends. Cast result based on result.gameId
    // ('chess' | 'fast-draw' | 'word-guess'), see the game-result types
    // exported from @snapie/hangouts-core.
  }}
  onActiveGameChange={(gameId) => {
    // gameId is set when a game starts (or is already running when you
    // join), null once it ends. Use this to gate your own "confirm before
    // leaving" prompt on a close/leave button rendered outside this
    // component, accidentally leaving mid-game is worse than one extra tap.
  }}
  getShareUrl={(roomName, origin) => {
    // Build a URL that drops the recipient back into your surface.
    // origin is the hostname captured server-side at room creation.
    return origin === '3speak.tv'
      ? `https://3speak.tv/openpods/${roomName}`
      : `https://hangout.3speak.tv/room/${roomName}`;
  }}
  onAudioHandoff={(file) => {
    // file = { blob, filename, duration, size }
    // Route into your podcast / audio publish flow.
    // Omit to hide the audio Upload button.
  }}
  onVideoHandoff={(file) => {
    // file = { blob, filename, duration, size }
    // Route into your studio / video publish flow.
    // Omit to hide the video Upload button.
  }}
/>
```

### RoomLobby props

```tsx
<RoomLobby
  onJoinRoom={(roomName) => setRoom(roomName)}
  onRoomCreated={(room, opts) => {/* opts.notifyOnHive */}}
  allowGuestBrowse                  // unauth visitors see the room list
                                    // and can join as guests; Create / host
                                    // actions stay hidden until they sign in
/>
```

## Theming

Auto-detects system dark/light preference. Override with:

```html
<div data-hh-theme="dark">
  <HangoutsRoom ... />
</div>
```

Or set CSS variables: `--hh-bg`, `--hh-text`, `--hh-primary`, etc.

## Docs

Full documentation: [hangout.3speak.tv/docs](https://hangout.3speak.tv/docs)

## Boost message contract (memo JSON)

Incoming Hive/HBD transfers for Boost must use strict JSON memo payload:

```json
{
  "version": 1,
  "room": "alice-my-openpod-abc123",
  "message": "Great show!",
  "sender": "bob",
  "nonce": "abc123_nonce",
  "displayName": "Bob"
}
```

Notes:
- `version`, `room`, `message`, `sender`, `nonce` are required.
- Amount must be `HIVE` or `HBD` and meet room minimum (`boost.minBoostUsd`).
- Server rejects malformed memos or below-minimum transfers (no broadcast).

## Boost goals, tiers, alerts, presets, top supporters

The host sets these in Boost settings (studio rocket button); they are stored in the room metadata's `boost` block through `PATCH /rooms/:name/boost`:

| Field | Meaning |
|---|---|
| `goal: { title, targetHbd, position? }` | Goal bar ("50 HBD for a new mic"). `position`: a small card at `top-right` (default), `bottom-right`, `bottom-left`, or a band at `top` / `bottom`. `null` removes it. |
| `tiers: boolean` | Amount tiers on (default) or off. Under 1 / 1 to 5 / 5 to 20 / 20+ HBD: colour from the theme tokens and 15 s / 30 s / 1 min / 2 min on screen. Off: 30 s for all. |
| `alerts: { sound, tts, ttsMinHbd, readAloud }` | Studio alerts: a synthesised chime (default on) and reading boosts aloud with `speechSynthesis` (default off, from 5 HBD). `readAloud` (default on): points shop read-aloud messages are read too, whatever the minimum. |
| `presets: number[]` | Quick amounts in the viewer dialog (default 1, 5, 10, 25; at most 6). `[]` = defaults. |

The server keeps this stream's tally in `boostStats` (count, totals, top supporters, when the goal was reached), counting boosts once they are on screen and paid. Amounts are in HBD; HIVE boosts count at the HBD value they were priced at when they arrived. Boosts to a collab guest count in the totals, not towards the host's goal. `GET /rooms/:name/boost/summary` (and `boostSummary` on `GET /rooms/:name`) returns the goal with progress, the totals and the top 5.

Components: `<StreamBoostGoal>` (the bar; `<StreamVideo>` shows it by default), `<BoostTopSupporters>`, `<BoostAlerts>` (alerts for an OBS Browser Source / dock), `useRoomBoost()`. Viewer text is translatable through `labels` (`BoostLabels`, see `DEFAULT_BOOST_LABELS`) on `SendBoostDialog`, `StreamBoostGoal`, `BoostTopSupporters` and `StreamVideo` (`boostLabels`).

## Points shop in the live room

Viewers spend 3Speak Points on the stream (server routes: `docs/api-routes.md`, "Points shop"). Every purchase is `POST /points/shop/buy` through `buyShopItem`, which uses the same spend helper as points boosts (`spendPoints`: a 428 asks the wallet to sign the burn, a 202 is followed until it is confirmed). Prices and what is on come from `GET /points/shop` (`useShopCatalog`).

| Piece | What it does |
|---|---|
| `<PointsShopActions roomName host? labels? readAloudOff? onSignIn? signWrapper? onBought? />` | The "Use points" button and menu next to the boost button: highlight a message (500), read-aloud message (1,000), suggest a poll (2,000), redeem a channel reward, back or start a bounty (100 and up), unlock the channel's stickers (1,000). `StandaloneViewer` shows it for signed-in viewers. |
| `PointsShopDialog` (`action`), `HighlightMessageDialog`, `ReadAloudDialog`, `SuggestPollDialog`, `RedeemRewardDialog`, `BountyDialog`, `UnlockStickersDialog` | Each purchase on its own, for a page with its own buttons. |
| `ChatPanel` | Draws the server's shop lines (`system.kind` `highlight`, `reward`, `bounty`, `bountydone`), the highlight pinned on top while `pinnedChat.until` is ahead, each author's cosmetics (name colour, badge, avatar frame) and the host's supporter mark, and `:st-<id>:` lines as big stickers for owners of the host's set (with a sticker row in the emoji tray). |
| `PollSuggestionsPanel`, `ChannelRewardsPanel`, `BountiesPanel` | The host's tools, in the studio's Live tab (`StudioLivePanel`: Polls, Rewards, Bounties) and for an OBS dock. Each has a stateless `*View`. Inside a LiveKit room they follow the `poll`, `rewards` and `bounty` topics; outside one they read again every 20 s. |
| `useReadAloud`, `<ReadAloudAlerts>` | Read-aloud messages on the `boost` topic (server only) are spoken with the boost voice when the host reads boosts aloud and `alerts.readAloud !== false`, whatever `ttsMinHbd`. `BoostAlerts` speaks them too. The Boost settings Alerts tab has the toggle. |
| `<BuyStreamTimeButton onBought>`, `useStreamExtra`, `resolveStreamCap(isPremium, extraMs)` | A free host buys 30 more minutes (10,000 points); the studio adds `GET /points/stream-extra` to the cap and offers the button in the header and the time limit popup. |
| `COSMETIC_LOOKS`, `NAME_COLORS`, `BADGE_EMOJIS`, `FRAME_CLASSES`, `THEME_CLASSES` | Cosmetic id to look, for the 3Speak site's own pages (frames and profile themes are classes in `styles/points-shop.css`). |

Text is translatable: the chat lines through `liveLabels` (`LiveLabels`), everything else through `labels` / `shopLabels` (`ShopLabels`, see `DEFAULT_SHOP_LABELS`) on the components above, `StandaloneStudio`, `StudioLivePanel`, `BoostSettingsPanel` and `StandaloneViewer`.

## License

MIT


## Full reference

Every component, hook, data channel topic and server route, written from the code: [docs/integrator-guide.md](https://github.com/Mantequilla-Soft/hangouts/blob/main/docs/integrator-guide.md) and [docs/api-routes.md](https://github.com/Mantequilla-Soft/hangouts/blob/main/docs/api-routes.md). This README covers the basics only.
