export { HangoutsApiClient, type HangoutsApiClientOptions } from './api-client.js';
export { loginWithKeychain, isKeychainAvailable } from './keychain-auth.js';
export { HangoutsApiError } from './errors.js';
export type {
  Room,
  CreateRoomResponse,
  JoinRoomResponse,
  AuthSession,
  ChallengeResponse,
  ParticipantRole,
  HandRaiseEvent,
  DataMessage,
  RecordingStartResponse,
  RecordingStopResponse,
  RecordingStatusResponse,
  RecordingUploadResponse,
  StreamPlatform,
  StreamStartResponse,
  StreamStopResponse,
  StreamStatusResponse,
} from './types.js';
