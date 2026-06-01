# @snapie/hangouts-core

Framework-agnostic core SDK for [Hive Hangouts](https://hangout.3speak.tv) — Twitter Spaces-style audio rooms for the Hive blockchain.

## Install

```bash
npm install @snapie/hangouts-core
```

## What's included

- **HangoutsApiClient** — typed HTTP client for the Hangouts API (auth, rooms, participants, recording, host transfer, layout/view-state, guest listen)
- **loginWithKeychain()** / **loginWithAioha()** — browser auth helpers
- **TypeScript types** — `Room`, `RoomVisibility`, `BoostConfig`, `BoostEvent`, `AuthSession`, `JoinRoomResponse` (`isHost`, `isGuest`, `isPremium`), `HandRaiseEvent`, recording / streaming response shapes, etc.

## Quick start

```ts
import { HangoutsApiClient } from '@snapie/hangouts-core';

const client = new HangoutsApiClient({ baseUrl: 'https://hangout-api.3speak.tv' });

// List active rooms (server filters out `unlisted` rooms)
const rooms = await client.listRooms();
// rooms[i].visibility — 'public' | 'hive-internal' | 'unlisted' | undefined
// rooms[i].origin     — hostname of the site that created the room

// Auth with Hive Keychain (web)
import { loginWithKeychain } from '@snapie/hangouts-core';
const session = await loginWithKeychain(client, 'your-hive-username');

// Create a room (visibility optional, defaults to 'public')
const { room, token } = await client.createRoom(
  'My Hangout',
  'Optional description',
  undefined,             // background image URL
  'hive-internal',       // RoomVisibility — restrict to Hive accounts
  'en',                  // language (optional BCP-47)
  {
    enabled: true,
    minBoostUsd: 1,
    creatorPayoutAccount: 'alice',
  },                     // boost config (optional)
);

// Join a room (auth required)
const join = await client.joinRoom('room-name');
// join.isHost, join.isGuest, join.isPremium

// Listen as an unauthenticated guest (no Hive account)
// Server stamps a `guest-{random}` identity, listen-only token.
// Rejected for `hive-internal` rooms.
const guest = await client.listenAsGuest('room-name');
// guest.isGuest === true; the LiveKit token has canPublish=false

// Transfer host to another speaker (host only)
await client.transferHost('room-name', 'newhost-username');
```

## When to use this package

- **React Native** apps (pair with `@livekit/react-native` for audio)
- **Non-React** web apps (Vue, Svelte, vanilla JS)
- **Server-side** scripts that need to interact with the Hangouts API

For React web apps, use [`@snapie/hangouts-react`](https://www.npmjs.com/package/@snapie/hangouts-react) instead — it includes this package plus React hooks and UI components.

## Docs

Full documentation: [hangout.3speak.tv/docs](https://hangout.3speak.tv/docs)

## License

MIT
