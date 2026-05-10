# @snapie/hangouts-react

React SDK for [Hive Hangouts](https://hangout.3speak.tv) — Twitter Spaces-style audio rooms for the Hive blockchain. Drop-in components for audio rooms with chat, hand raising, speaker management, recording, and Hive Keychain authentication.

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

## Features

- **Hive Keychain login** — challenge-response auth with posting key
- **Guest listener mode** — `<HangoutsRoom guestFallback>` lets unauthenticated viewers drop in as listen-only `guest-*` participants. Chat, mic, camera, hand-raise are all hidden for them.
- **Room visibility** — Create-room dialog dropdown for `public` / `hive-internal` / `unlisted`. Server filters `unlisted` from the lobby and rejects guests for `hive-internal`.
- **Audio rooms** — real-time voice via LiveKit WebRTC
- **Chat** — text messaging via data channels (read-only with sign-in prompt for guests)
- **Hand raising** — listeners request to speak
- **Speaker management** — host promotes/demotes participants. Promoted speakers start with mic and camera **off**.
- **Live host transfer** — `useLiveHost` derives host status reactively from room metadata, so transferring host flips every consumer's UI without reconnecting.
- **Recording** — audio or video; on stop, integrator-driven 3-button dialog (Upload · Download · Dismiss). Upload hands the raw blob to a callback you supply — the SDK doesn't ship a default publish destination.
- **Share button** — built-in copy/Web-Share button in the room header, gated on a `getShareUrl(roomName, origin)` callback so links land back on the surface that created the room.
- **Theming** — light/dark via CSS custom properties (`--hh-*`)
- **Embedded mode** — fits in modals and panels
- **Error boundary** — catches WebRTC crashes gracefully

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
| `useLiveHost(fallback?)` | Reactively derives the current host identity from room metadata + whether the local participant is the host. Use inside any LiveKit-context child to keep host UI in sync after a transfer. |
| `useChat()` | Send/receive chat messages |
| `useHandRaise()` | Hand raise state and actions |
| `useHostControls()` | Promote, demote, kick |
| `useRecording()` | Record, stop, fetch blob, download |
| `useHiveAvatar()` | Hive profile picture URL |

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

## License

MIT
