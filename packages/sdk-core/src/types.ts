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
  boardState?: unknown;
  isSpectator?: boolean;
  /** Server wall-clock at response time, for client clock-skew correction. */
  serverTime?: number;
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
  | { type: 'game:feedback'; message: string }
  | { type: 'game:ended'; gameId?: string; players?: string[]; startedAt?: number; endedAt?: number; duration?: number; result?: unknown };

/** Final snapshot delivered to the onGameEnd prop on <HangoutsRoom>. */
export interface GameResultPayload {
  /** Plugin identifier: 'chess' | 'fast-draw' | 'word-guess'. */
  gameId: string;
  /** Hive usernames of everyone who played (not spectators). */
  players: string[];
  /** Unix ms timestamp when the game started. */
  startedAt: number;
  /** Unix ms timestamp when the game ended. */
  endedAt: number;
  /** Duration in seconds. */
  duration: number;
  /** Game-specific final state. Cast to ChessGameResult or FastDrawGameResult based on gameId. */
  result: unknown;
}

/** Chess result shape inside GameResultPayload.result when gameId === 'chess'. */
export interface ChessGameResult {
  fen: string;
  players: { w: string; b: string };
  turn: 'w' | 'b' | null;
  status: 'playing' | 'checkmate' | 'resigned' | 'draw' | 'stalemate';
  winner: string | null;
  moveHistory: string[];
}

/** Fast Draw result shape inside GameResultPayload.result when gameId === 'fast-draw'. */
export interface FastDrawGameResult {
  phase: 'drawing' | 'reveal' | 'game_over';
  theme: string;
  winners: string[];
  scores: Record<string, number>;
  roundNumber: number;
  drawer: string;
  revealedWord: string | null;
}

/** One finisher's row in a Word Guess leaderboard, in finish order. */
export interface WordGuessLeaderboardEntry {
  identity: string;
  /** 1-indexed finish order. */
  place: number;
  word: string;
  solveTimeMs: number;
  wrongAttempts: number;
}

/** Word Guess result shape inside GameResultPayload.result when gameId === 'word-guess'. */
export interface WordGuessGameResult {
  theme: string;
  playerCount: number;
  /** Every participant's word, full reveal — including anyone who never finished if the host ended the round early. */
  words: Record<string, string>;
  /** Only participants who finished, in finish order — may be shorter than `words` if the round ended early. */
  leaderboard: WordGuessLeaderboardEntry[];
}

export interface WordCollection {
  id: string;
  name: string;
  wordCount: number;
}
