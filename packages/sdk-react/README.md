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
- **Audio rooms** — real-time voice via LiveKit WebRTC
- **Chat** — text messaging via data channels
- **Hand raising** — listeners request to speak
- **Speaker management** — host promotes/demotes participants
- **Recording** — capture to MP3, upload to IPFS, with timer and indicators
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
| `useHangoutsRoom()` | Join/create/leave rooms |
| `useChat()` | Send/receive chat messages |
| `useHandRaise()` | Hand raise state and actions |
| `useHostControls()` | Promote, demote, kick |
| `useRecording()` | Record, stop, upload with timer |
| `useHiveAvatar()` | Hive profile picture URL |

## HangoutsRoom props

```tsx
<HangoutsRoom
  roomName="room-name"              // required
  onLeave={() => {}}                 // user left
  onError={(err) => {}}              // WebRTC error
  embedded                           // fit in modal (no min-height)
  maxHeight="80vh"                   // explicit height
  onRecordingUploaded={(result) => {
    // result = { permlink, cid, playUrl }
  }}
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
