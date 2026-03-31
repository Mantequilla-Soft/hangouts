# @snapie/hangouts-core

Framework-agnostic core SDK for [Hive Hangouts](https://hangout.3speak.tv) — Twitter Spaces-style audio rooms for the Hive blockchain.

## Install

```bash
npm install @snapie/hangouts-core
```

## What's included

- **HangoutsApiClient** — typed HTTP client for the Hangouts API (auth, rooms, participants, recording)
- **loginWithKeychain()** — Hive Keychain browser auth helper
- **TypeScript types** — Room, AuthSession, JoinRoomResponse, HandRaiseEvent, etc.

## Quick start

```ts
import { HangoutsApiClient } from '@snapie/hangouts-core';

const client = new HangoutsApiClient({ baseUrl: 'https://hangout-api.3speak.tv' });

// List active rooms
const rooms = await client.listRooms();

// Auth with Hive Keychain (web)
import { loginWithKeychain } from '@snapie/hangouts-core';
const session = await loginWithKeychain(client, 'your-hive-username');

// Create a room
const { room, token } = await client.createRoom('My Hangout');

// Join a room
const { token, isHost } = await client.joinRoom('room-name');
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
