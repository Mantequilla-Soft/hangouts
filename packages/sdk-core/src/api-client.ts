import type { Room, CreateRoomResponse, JoinRoomResponse, AuthSession, ChallengeResponse } from './types.js';
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
}
