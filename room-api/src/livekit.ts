import { RoomServiceClient } from 'livekit-server-sdk';
import { config } from './config.js';

export const roomService = new RoomServiceClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);
