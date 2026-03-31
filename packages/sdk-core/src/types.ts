export interface Room {
  name: string;
  title: string;
  host: string;
  description?: string;
  numParticipants?: number;
  maxParticipants?: number;
  createdAt: string;
}

export interface CreateRoomResponse {
  room: Room;
  token: string;
}

export interface JoinRoomResponse {
  token: string;
  roomName: string;
  identity: string;
  isHost: boolean;
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

export interface RecordingStartResponse {
  egressId: string;
  status: string;
  filepath: string;
}

export interface RecordingStopResponse {
  egressId: string;
  status: string;
  filePath: string;
  duration: number;
}

export interface RecordingStatusResponse {
  recording: boolean;
  egressId?: string;
}

export interface RecordingUploadResponse {
  success: boolean;
  permlink: string;
  cid: string;
  playUrl: string;
}
