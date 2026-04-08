import type { Room, CreateRoomResponse, JoinRoomResponse, AuthSession, ChallengeResponse, RecordingStartResponse, RecordingStopResponse, RecordingStatusResponse, RecordingUploadResponse, StreamPlatform, StreamStartResponse, StreamStopResponse, StreamStatusResponse } from './types.js';
import { HangoutsApiError } from './errors.js';

export interface HangoutsApiClientOptions {
  baseUrl: string;
}

export class HangoutsApiClient {
  private baseUrl: string;
  private sessionToken: string | null = null;

  constructor(options: HangoutsApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  setSessionToken(token: string): void {
    this.sessionToken = token;
  }

  clearSessionToken(): void {
    this.sessionToken = null;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { /* ignore */ }
      throw new HangoutsApiError(
        response.status,
        (errorBody as { message?: string })?.message || response.statusText,
        errorBody,
      );
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // Auth

  async requestChallenge(username: string): Promise<ChallengeResponse> {
    return this.request('POST', '/auth/challenge', { username });
  }

  async verifySignature(username: string, challenge: string, signature: string): Promise<AuthSession> {
    return this.request('POST', '/auth/verify', { username, challenge, signature });
  }

  // Rooms

  async listRooms(): Promise<Room[]> {
    return this.request('GET', '/rooms');
  }

  async getRoom(roomName: string): Promise<Room | null> {
    try {
      return await this.request('GET', `/rooms/${encodeURIComponent(roomName)}`);
    } catch (err) {
      if (err instanceof HangoutsApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createRoom(title: string, description?: string): Promise<CreateRoomResponse> {
    return this.request('POST', '/rooms', { title, description });
  }

  async joinRoom(roomName: string): Promise<JoinRoomResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/join`);
  }

  async deleteRoom(roomName: string): Promise<void> {
    return this.request('DELETE', `/rooms/${encodeURIComponent(roomName)}`);
  }

  // Participants

  async setPermissions(roomName: string, identity: string, canPublish: boolean): Promise<{ identity: string; canPublish: boolean }> {
    return this.request(
      'PATCH',
      `/rooms/${encodeURIComponent(roomName)}/participants/${encodeURIComponent(identity)}/permissions`,
      { canPublish },
    );
  }

  async kickParticipant(roomName: string, identity: string): Promise<void> {
    return this.request(
      'DELETE',
      `/rooms/${encodeURIComponent(roomName)}/participants/${encodeURIComponent(identity)}`,
    );
  }

  // Recording

  async startRecording(roomName: string): Promise<RecordingStartResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/record/start`);
  }

  async stopRecording(roomName: string): Promise<RecordingStopResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/record/stop`);
  }

  async getRecordingStatus(roomName: string): Promise<RecordingStatusResponse> {
    return this.request('GET', `/rooms/${encodeURIComponent(roomName)}/record/status`);
  }

  async uploadRecording(roomName: string, filePath: string, duration?: number, title?: string, tags?: string[]): Promise<RecordingUploadResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/record/upload`, {
      filePath,
      duration,
      title,
      tags,
    });
  }

  // Streaming

  async startStream(roomName: string, platform: StreamPlatform, streamKey: string, backgroundImageUrl?: string, videoEnabled?: boolean): Promise<StreamStartResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/stream/start`, {
      platform,
      streamKey,
      backgroundImageUrl,
      videoEnabled,
    });
  }

  async stopStream(roomName: string): Promise<StreamStopResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/stream/stop`);
  }

  async getStreamStatus(roomName: string): Promise<StreamStatusResponse> {
    return this.request('GET', `/rooms/${encodeURIComponent(roomName)}/stream/status`);
  }
}
