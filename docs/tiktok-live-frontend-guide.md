# Building TikTok-Style Live on Hangouts — Frontend Guide

Audience: the 3speak.tv frontend/product team building a "Go Live" feature (one broadcaster, many viewers, vertical/mobile-first, gifting) on top of this Hangouts/LiveKit service.

## The short version

Most of the TikTok-LIVE shape is already built. The core loop — one host publishing camera, many viewers watching read-only, a full-bleed single-speaker layout, and a gifting system — exists today via the `@snapie/hangouts-react` SDK and the Fastify API in `server/`. This doc maps that shape onto the existing building blocks, and separately calls out what's genuinely missing so product/frontend can scope it deliberately instead of discovering gaps mid-build.

**WHIP ingress (`server/src/routes/ingress.ts`, added 2026-07-20) is not part of this — it's a secondary path for power users broadcasting from OBS/hardware encoders, not the mechanism a regular user's phone camera uses to go live.** See the last section for where it fits.

## Architecture recap

```
Broadcaster's phone/browser ──camera──▶ LiveKit SFU ──▶ N viewers (subscribe-only)
                                            │
                                       Fastify API (auth, room/token issuance, boosts)
```

One room = one live stream. The host is the only participant with `canPublish`. Everyone else — logged-in viewers and anonymous guests alike — joins subscribe-only. This is already exactly the TikTok LIVE participant model; no new room topology is needed.

## What's already built

### Going live (host)

- `POST /rooms` (`server/src/routes/rooms.ts`) creates the room and returns a host LiveKit token with `canPublish: true`. The response also includes `isPremium` — see [Known gap: video gating](#known-gap-video-is-currently-gated-by-premium-not-available-to-everyone) below, it matters here.
- Camera publish/toggle is handled directly through `@livekit/components-react`'s `useLocalParticipant()` / `localParticipant.isCameraEnabled` — see `packages/sdk-react/src/components/room/RoomControls.tsx:85-100` for the existing pattern. No custom Hangouts hook wraps this; it's raw LiveKit.
- `HangoutsRoom` (`packages/sdk-react/src/components/room/HangoutsRoom.tsx`) is the full room shell — drop it in and it wires up publish, layout, chat, boosts, moderation together. `RoomControls` is the toolbar inside it if you want to build a custom shell instead.

### Watching (viewer)

- Logged-in Hive users: `POST /rooms/:name/join` → `apiClient.joinRoom()` (`packages/sdk-core/src/api-client.ts:95`).
- Anonymous viewers (the TikTok-app-open-and-watch case, no account needed): `POST /rooms/:name/listen` → `apiClient.listenAsGuest(roomName, displayName?)` (`api-client.ts:107`). Rate-limited per IP (10/5min), rejected for `hive-internal` rooms. This is the one you want for a low-friction "tap a stream, start watching" flow.
- Live room discovery: `GET /rooms` → `useRoomList()` (`packages/sdk-react/src/hooks/useRoomList.ts`) — polls every 10s, filters out `unlisted` rooms. This is a flat list today, not a ranked/algorithmic feed — see gaps below.

### Vertical / single-speaker layout

Already built. `PATCH /rooms/:name/layout` → `apiClient.setRoomLayout(roomName, 'single')` switches every viewer's `SpeakerStage` (`packages/sdk-react/src/components/room/SpeakerStage.tsx`) into full-bleed single-speaker mode — exactly the TikTok LIVE visual. `layoutMode` is read from room metadata (`recordLayout`) so it's live-synced to all viewers, not just the recording.

### Gifting (boosts / superchat)

Already built and directly maps to TikTok gifts: `useBoosts` / `useBoostStore` (`packages/sdk-react/src/hooks/useBoosts.ts`), `BoostOverlay`, `SendBoostDialog`, `BoostHistoryPanel`, `BoostSettingsPanel` components. Backed by real HIVE/HBD transfers with an immediate payout split to the host (`server/src/routes/boosts.ts`, `server/src/lib/boostPayout.ts`). `Room.boost` config (`enabled`, `minBoostUsd`, `creatorPayoutAccount`) is set at room creation.

### Moderation

`useHostControls(roomName)` (`packages/sdk-react/src/hooks/useHostControls.ts`) — `promote`/`demote`/`kick`/`ban`/`endRoom`. Same primitives a TikTok-style host needs (kick a troll, end the stream).

## Known gaps — decide these before building

These aren't built, or are built in a way that doesn't quite fit a TikTok-style product yet. Flagging so they're deliberate product decisions, not surprises during implementation.

### Video is currently gated by premium, not "available to everyone"

`POST /rooms` issues host tokens as `canPublish: true` unconditionally — the LiveKit grant itself doesn't distinguish audio from video (`server/src/lib/livekit.ts:20-40`, the `premium` param is accepted but never actually applied to the grant). The audio-vs-video split is enforced **client-side**: `RoomControls` only shows the camera toggle when the `videoEnabled` prop is true, which the app sets based on `isPremium` from the room-creation response. If 3speak wants video-first live streaming available to all users (which a TikTok-style product almost certainly does — a premium gate here would kill the core feature), that's a **client-side flag change** in whatever calls `RoomControls`/`HangoutsRoom`, not a server change. Worth confirming this is the intended behavior before shipping, since as-built it reads as "video is a Pro perk."

### Discovery is a flat polling list, not a feed

`useRoomList()` returns whatever's currently live, unranked, no pagination, no "swipe to next stream" model. Building an actual TikTok-style discovery feed (ranking, autoplay-next, categories) is new frontend/product work on top of this endpoint, not something to expect from the SDK as-is.

### No built-in mobile camera controls

Front/back camera switch, orientation lock, and low-light/beauty-filter type features aren't part of `@livekit/components-react`'s `localParticipant` API surface as used here — those would be built directly against `MediaDeviceInfo`/`getUserMedia` in whatever mobile web/app shell 3speak builds.

### No stream thumbnails/preview images for the discovery list

`Room` metadata has `backgroundImage` (host-set static image), but nothing generates a live video thumbnail. If the discovery feed needs live preview frames, that's new work (likely an egress-based periodic snapshot, or a client-side canvas capture).

## Where WHIP ingress fits (optional, power-user path)

WHIP (`POST/DELETE/GET /rooms/:name/ingress/whip`, `server/src/routes/ingress.ts`) lets a host publish from OBS Studio, ffmpeg, or a hardware encoder instead of the in-browser camera. It's live in production (`livekit.3speak.tv/whip`) but:

- **Not wrapped in `@snapie/hangouts-core`/`hangouts-react` yet** — no `apiClient.startWhipIngress()`, no hook, no UI component. Would need to be added if this path is wanted (mirrors `useStreaming.ts` / `StreamingPanel.tsx`'s shape for the existing YouTube/Twitch stream-out feature, just inbound instead of outbound).
- Best fit for a "broadcast from your streaming software" power-user option, not the default mobile "go live" button.
- No auth/permission gate beyond host-only today (no premium tier check, unlike video recording) — worth deciding if it should have one before exposing it in UI.

Recommend treating this as a v2/power-user addition once the core native-camera flow is validated, not a blocker for the initial TikTok-style launch.

## Suggested starting point

1. Confirm the video-gating decision above — it's the one item that actually blocks the core feature if left as-is.
2. Prototype with `HangoutsRoom` + `videoEnabled=true` + `RoomLobby`'s create-room flow (`CreateRoomDialog`), using `single` layout by default for the broadcaster's own view and all viewers.
3. Wire anonymous viewer entry through `listenAsGuest` for the lowest-friction watch path.
4. Scope discovery/feed UX and thumbnails as their own workstream — they're genuinely new, not a thin wrapper over existing endpoints.
