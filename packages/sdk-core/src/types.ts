/** Visibility / access tier the host picked when creating the room. */
export type RoomVisibility = 'public' | 'hive-internal' | 'unlisted';

export interface BoostConfig {
  enabled: boolean;
  minBoostUsd: number;
  creatorPayoutAccount?: string;
}

export type BoostRejectReason =
  | 'invalid_memo'
  | 'invalid_asset'
  | 'room_not_found'
  | 'below_minimum'
  | 'invalid_destination'
  | 'duplicate_transfer'
  | 'payout_failed'
  | 'internal_error';

export interface BoostEvent {
  type: 'boost';
  id: string;
  room: string;
  sender: string;
  displayName?: string;
  message: string;
  amount: string;
  asset: 'HIVE' | 'HBD';
  usdAmount: number;
  feeAmount: string;
  payoutAmount: string;
  recipient: string;
  txId: string;
  blockNum: number;
  timestamp: number;
  /** Set by the server when the amount was below the host's minBoostUsd floor.
   *  Clients suppress the overlay card but show a badged entry in history. */
  belowMinimum?: boolean;
}

export interface Room {
  name: string;
  title: string;
  host: string;
  description?: string;
  backgroundImage?: string;
  numParticipants?: number;
  maxParticipants?: number;
  createdAt: string;
  /** Hostname of the site that created this room (e.g. "3speak.tv").
   *  Set by the server from the create request's Origin header.
   *  Use to pick share URLs that drop recipients back into the same surface. */
  origin?: string;
  /** `public` (default) — listed and open to guests; `hive-internal` —
   *  listed but Hive-only (no guest listeners); `unlisted` — hidden
   *  from the lobby, link-only, guests still allowed. Optional; pre-
   *  existing rooms behave as `public`. */
  visibility?: RoomVisibility;
  /** BCP-47 language tag shown in the room list. */
  language?: string;
  /** Boost/superchat configuration for this room. */
  boost?: BoostConfig;
}

export interface CreateRoomResponse {
  room: Room;
  token: string;
  isPremium?: boolean;
}

export interface JoinRoomResponse {
  token: string;
  roomName: string;
  identity: string;
  isHost: boolean;
  isPremium?: boolean;
  /**
   * True when the participant is an unauthenticated listener-only
   * guest. The server stamps `guest-{random}` identities; clients
   * must treat them as listen-only (no chat, no hand-raise, can't be
   * promoted to speaker).
   */
  isGuest?: boolean;
}

export interface AuthSession {
  token: string;
  username: string;
}

export interface ChallengeResponse {
  challenge: string;
  expires: number;
}

export type ParticipantRole = 'host' | 'speaker' | 'listener';

export interface HandRaiseEvent {
  type: 'hand_raise';
  raised: boolean;
  identity: string;
  timestamp: number;
}

export interface DataMessage {
  type: string;
  [key: string]: unknown;
}

export type RecordingMode = 'audio' | 'video';
export type RecordingLayout = 'speaker' | 'grid' | 'single';

export interface RecordingStartResponse {
  egressId: string;
  status: string;
  filepath: string;
  mode: RecordingMode;
  layout: RecordingLayout;
}

export interface RecordingStopResponse {
  egressId: string;
  status: string;
  filePath: string;
  duration: number;
  mode: RecordingMode;
  layout: RecordingLayout;
  /** Set for video recordings — token used by GET /record/file/:token. */
  downloadToken?: string;
}

export interface RecordingStatusResponse {
  recording: boolean;
  egressId?: string;
  mode?: RecordingMode;
  layout?: RecordingLayout;
}

export interface RecordingLayoutResponse {
  egressId: string;
  layout: RecordingLayout;
}

/** Audio recording upload response (audio.3speak.tv → IPFS). */
export interface RecordingUploadResponse {
  success: boolean;
  permlink: string;
  cid: string;
  playUrl: string;
}

/** Result of fetching the recorded MP4 from the server. */
export interface RecordingFileResult {
  blob: Blob;
  filename: string;
  duration: number;
  size: number;
}

export type StreamPlatform = 'youtube' | 'twitch';

export interface StreamStartResponse {
  egressId: string;
  status: string;
  platform: StreamPlatform;
}

export interface StreamStopResponse {
  egressId: string;
  status: string;
}

export interface StreamStatusResponse {
  streaming: boolean;
  egressId: string | null;
}

// Event scheduling

export type EventStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export type EventVisibility = 'public' | 'unlisted';

export interface HangoutsEvent {
  id: string;
  title: string;
  description?: string;
  hostUsername: string;
  scheduledAt: string;
  coverImage?: string;
  tags?: string[];
  attendees: string[];
  attendeeCount: number;
  status: EventStatus;
  roomName?: string;
  visibility: EventVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEventInput {
  title: string;
  description?: string;
  scheduledAt: string;
  coverImage?: string;
  tags?: string[];
  visibility?: EventVisibility;
}

export interface UpdateEventInput {
  title?: string;
  description?: string;
  scheduledAt?: string;
  coverImage?: string;
  tags?: string[];
  visibility?: EventVisibility;
}

export interface UserPresence {
  online: boolean;
  roomName?: string;
  roomTitle?: string;
  role?: 'host' | 'speaker' | 'listener';
}

export interface StartEventResponse {
  event: HangoutsEvent;
  room: Room;
  token: string;
  isPremium?: boolean;
}

// Games

export interface GameInfo {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
}

export interface ActiveGame {
  gameId: string;
  participants: string[];
  startedAt: number;
  state: unknown;
}

export interface GameStartResponse {
  gameId: string;
  participants: string[];
  startedAt: number;
}

export interface GameActionResponse {
  ended: boolean;
}

/** Data channel messages received on the "game" topic. */
export type GameMessage =
  | { type: 'game:started'; gameId: string; participants: string[]; broadcast: unknown }
  | { type: 'game:state'; payload: unknown }
  | { type: 'game:broadcast'; payload: unknown }
  | { type: 'game:ended' };
