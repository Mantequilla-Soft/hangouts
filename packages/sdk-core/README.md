# @snapie/hangouts-core

Framework-agnostic core SDK for [Hive Hangouts](https://hangout.3speak.tv) — Twitter Spaces-style audio rooms for the Hive blockchain.

## Install

```bash
npm install @snapie/hangouts-core
```

## What's included

- **`HangoutsApiClient`** — typed HTTP client for all Hangouts API endpoints
- **Auth helpers** — `loginWithKeychain`, `loginWithAioha`, `loginWithSignFn`
- **`AiohaLike` interface** — plug in any signing/transfer backend (Aioha, custodial, etc.)
- **TypeScript types** — all request/response shapes exported from the package root

## When to use this package

- **React Native** apps (pair with `@livekit/react-native` for audio)
- **Non-React** web apps (Vue, Svelte, vanilla JS)
- **Server-side** scripts that need to interact with the Hangouts API

For React web apps, use [`@snapie/hangouts-react`](https://www.npmjs.com/package/@snapie/hangouts-react) instead — it includes this package plus React hooks and UI components.

---

## Quick start

```ts
import { HangoutsApiClient, loginWithKeychain } from '@snapie/hangouts-core';

const client = new HangoutsApiClient({ baseUrl: 'https://hangout-api.3speak.tv' });

// Authenticate with Hive Keychain (browser only)
const session = await loginWithKeychain(client, 'your-hive-username');
// session = { token: string, username: string }

// List rooms
const rooms = await client.listRooms();

// Create a room
const { room, token } = await client.createRoom('My Hangout', 'A description', undefined, 'public', 'en', {
  enabled: true,
  minBoostUsd: 1,
  creatorPayoutAccount: 'alice',
});

// Join
const join = await client.joinRoom('room-name');
// join.isHost, join.isGuest, join.isPremium

// Guest listen (no Hive account required)
const guest = await client.listenAsGuest('room-name', 'Optional Display Name');
```

---

## Authentication

### Hive Keychain (browser extension)

```ts
import { loginWithKeychain, isKeychainAvailable } from '@snapie/hangouts-core';

if (isKeychainAvailable()) {
  const session = await loginWithKeychain(client, 'alice');
}
```

### Aioha (any registered provider)

```ts
import { loginWithAioha } from '@snapie/hangouts-core';

// aioha must already have a logged-in session (call aioha.login() first)
const session = await loginWithAioha(client, aioha);
// or pass the username explicitly:
const session = await loginWithAioha(client, aioha, 'alice');
```

### Custom sign function

For any other signing flow — HiveSigner redirect, server-held keys, test mocks:

```ts
import { loginWithSignFn } from '@snapie/hangouts-core';

const session = await loginWithSignFn(client, 'alice', async (message) => {
  // sign `message` with alice's posting key, return the hex signature
  return mySigningBackend.sign(message);
});
```

### Custodial adapter (Google login / server-held keys)

If users authenticate via Google (or any non-Hive flow) and a backend holds their Hive keys, implement the `AiohaLike` interface:

```ts
import type { AiohaLike } from '@snapie/hangouts-core';

const custodialAdapter: AiohaLike = {
  getCurrentUser: () => username,
  isLoggedIn: () => true,

  signMessage: async (message) => {
    const res = await fetch('/api/custodial/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, message }),
    });
    const { signature } = await res.json();
    return { success: true, result: signature };
  },

  transfer: async (to, amount, currency, memo) => {
    const res = await fetch('/api/custodial/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: username, to, amount, currency, memo }),
    });
    return res.ok
      ? { success: true }
      : { success: false, error: await res.text() };
  },
};

// In React: <HangoutsProvider aioha={custodialAdapter} ...>
// Standalone: await loginWithAioha(client, custodialAdapter, username);
```

The `transfer` method is only called when a user sends a boost — you can omit it if your app doesn't use boosts.

---

## `AiohaLike` interface

```ts
interface AiohaLike {
  /** Sign a message with the user's posting key. */
  signMessage(
    message: string,
    keyType: string,
  ): Promise<{ success: boolean; result?: string; error?: string }>;

  /** Return the currently logged-in username (optional). */
  getCurrentUser?(): string | undefined | null;

  /** True when the user has an active session (optional). */
  isLoggedIn?(): boolean;

  /** Broadcast a Hive transfer (optional — only needed for boosts). */
  transfer?(
    to: string,
    amount: number,
    currency: string,
    memo: string,
  ): Promise<{ success: boolean; result?: unknown; error?: string }>;
}
```

---

## Error handling

All `HangoutsApiClient` methods throw `HangoutsApiError` on non-2xx responses:

```ts
import { HangoutsApiError } from '@snapie/hangouts-core';

try {
  await client.joinRoom('some-room');
} catch (err) {
  if (err instanceof HangoutsApiError) {
    console.log(err.status);   // HTTP status code (400, 401, 403, 404, 429…)
    console.log(err.message);  // server error message
    console.log(err.body);     // raw response body (unknown shape)
  }
}
```

Common status codes:

| Status | Meaning |
|--------|---------|
| 401 | Missing or expired session token |
| 403 | Action requires host privileges, or guest identity rejected |
| 404 | Room not found |
| 409 | Room name conflict on create |
| 429 | Rate limit hit (guest token endpoint: 10 / 5 min per IP) |

---

## TypeScript types

```ts
// Auth
type AuthSession         = { token: string; username: string }
type ChallengeResponse   = { challenge: string; expires: number }

// Rooms
type RoomVisibility      = 'public' | 'hive-internal' | 'unlisted'

interface Room {
  name: string
  title: string
  host: string
  description?: string
  backgroundImage?: string
  numParticipants?: number
  createdAt: string
  origin?: string          // hostname that created the room (e.g. "3speak.tv")
  visibility?: RoomVisibility
  language?: string        // BCP-47
  boost?: BoostConfig
}

interface BoostConfig {
  enabled: boolean
  minBoostUsd: number
  creatorPayoutAccount?: string
}

// Join responses
interface JoinRoomResponse {
  token: string
  roomName: string
  identity: string
  isHost: boolean
  isPremium?: boolean
  isGuest?: boolean        // true for guest-* identities — listen-only
}

// Participants
type ParticipantRole = 'host' | 'speaker' | 'listener'

// Recording
type RecordingMode   = 'audio' | 'video'
type RecordingLayout = 'speaker' | 'grid' | 'single'

interface RecordingFileResult {
  blob: Blob
  filename: string
  duration: number   // seconds
  size: number       // bytes
}

// Boosts
interface BoostEvent {
  type: 'boost'
  id: string
  room: string
  sender: string
  displayName?: string
  message: string
  amount: string         // e.g. "5.000"
  asset: 'HIVE' | 'HBD'
  usdAmount: number
  feeAmount: string
  payoutAmount: string
  recipient: string
  txId: string
  blockNum: number
  timestamp: number
  belowMinimum?: boolean // server flag: below host's minBoostUsd; overlay suppressed
}

type BoostRejectReason =
  | 'invalid_memo'
  | 'invalid_asset'
  | 'room_not_found'
  | 'below_minimum'
  | 'invalid_destination'
  | 'duplicate_transfer'
  | 'payout_failed'
  | 'internal_error'

// Streaming
type StreamPlatform = 'youtube' | 'twitch'
```

---

## API client methods

```ts
// Auth
client.requestChallenge(username)                            → ChallengeResponse
client.verifySignature(username, challenge, signature)       → AuthSession

// Rooms
client.listRooms()                                           → Room[]
client.getRoom(roomName)                                     → Room | null
client.createRoom(title, description?, bgImage?, visibility?, language?, boost?)  → CreateRoomResponse
client.joinRoom(roomName)                                    → JoinRoomResponse
client.listenAsGuest(roomName, displayName?)                 → JoinRoomResponse
client.joinAsObserver(roomName)                              → JoinRoomResponse  // obs-* identity, invisible
client.deleteRoom(roomName)                                  → void
client.transferHost(roomName, newHostUsername)               → { host: string }
client.setRoomLayout(roomName, layout)                       → { layout: string }

// Participants
client.setPermissions(roomName, identity, canPublish)        → { identity, canPublish }
client.kickParticipant(roomName, identity)                   → void
client.banGuest(roomName, identity)                          → void  // guest-* only, IP-scoped

// Recording
client.startRecording(roomName, { mode?, layout? })          → RecordingStartResponse
client.stopRecording(roomName)                               → RecordingStopResponse
client.getRecordingStatus(roomName)                          → RecordingStatusResponse
client.setRecordingLayout(roomName, layout)                  → RecordingLayoutResponse
client.fetchRecordingFile(roomName, downloadToken)           → RecordingFileResult

// Streaming
client.startStream(roomName, platform, streamKey, bgImageUrl?, videoEnabled?)  → StreamStartResponse
client.stopStream(roomName)                                  → StreamStopResponse
client.getStreamStatus(roomName)                             → StreamStatusResponse

// Boosts
client.getBoostConfig()                                      → { enabled, platformAccount, feePercent }
client.updateBoostConfig(roomName, { enabled?, minBoostUsd?, creatorPayoutAccount? })
```

---

## Boost memo format

Transfers to the platform account must include a JSON memo:

```json
{
  "version": 1,
  "room": "alice-my-openpod-abc123",
  "message": "Great show!",
  "sender": "bob",
  "nonce": "1717000000000-abc123",
  "displayName": "Bob"
}
```

`version`, `room`, `message`, `sender`, `nonce` are required. The server validates the transfer on-chain, deduplicates by `nonce`, splits the payout, and broadcasts a `BoostEvent` to the room's LiveKit data channel on topic `boost`.

---

## Docs

Full documentation: [hangout.3speak.tv/docs](https://hangout.3speak.tv/docs)

## License

MIT
