import type { Room, RoomVisibility, CreateRoomResponse, JoinRoomResponse, AuthSession, ChallengeResponse, RecordingMode, RecordingLayout, RecordingStartResponse, RecordingStopResponse, RecordingStatusResponse, RecordingLayoutResponse, RecordingUploadResponse, RecordingFileResult, StreamPlatform, StreamStartResponse, StreamStopResponse, StreamStatusResponse } from './types.js';
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

  async createRoom(
    title: string,
    description?: string,
    backgroundImage?: string,
    visibility?: RoomVisibility,
  ): Promise<CreateRoomResponse> {
    return this.request('POST', '/rooms', { title, description, backgroundImage, visibility });
  }

  async joinRoom(roomName: string): Promise<JoinRoomResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/join`);
  }

  /**
   * Join as an unauthenticated listener-only guest. Does NOT require a
   * session token — anyone with the room URL can call this. The server
   * issues a `guest-*` identity with publish disabled and rate-limits
   * the endpoint per IP. Use this when the user hasn't (or can't)
   * sign in with Hive but wants to listen in.
   */
  async listenAsGuest(roomName: string): Promise<JoinRoomResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/listen`);
  }

  async deleteRoom(roomName: string): Promise<void> {
    return this.request('DELETE', `/rooms/${encodeURIComponent(roomName)}`);
  }

  /** Transfer host role to another participant. Host-only. */
  async transferHost(roomName: string, newHost: string): Promise<{ host: string }> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/host`, { newHost });
  }

  /**
   * Update the room's display/recording layout. Host-only. Persists to
   * metadata.recordLayout, which both the live SpeakerStage and the
   * egress template read — one setting drives both views WYSIWYG.
   */
  async setRoomLayout(roomName: string, layout: 'speaker' | 'grid' | 'single'): Promise<{ layout: string }> {
    return this.request('PATCH', `/rooms/${encodeURIComponent(roomName)}/layout`, { layout });
  }

  /**
   * Update the host's transient view-state (focused speaker / grid
   * override / chat-open state). Stored in room metadata so the egress
   * template can mirror the host's live view in real time.
   */
  async setRoomViewState(
    roomName: string,
    state: { focusedIdentity?: string | null; suppressScreenAutoFocus?: boolean; chatOpen?: boolean },
  ): Promise<{ focusedIdentity: string | null; suppressScreenAutoFocus: boolean; chatOpen: boolean }> {
    return this.request('PATCH', `/rooms/${encodeURIComponent(roomName)}/layout`, state);
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

  async startRecording(roomName: string, opts?: { mode?: RecordingMode; layout?: RecordingLayout }): Promise<RecordingStartResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/record/start`, opts ?? {});
  }

  async stopRecording(roomName: string): Promise<RecordingStopResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/record/stop`);
  }

  async getRecordingStatus(roomName: string): Promise<RecordingStatusResponse> {
    return this.request('GET', `/rooms/${encodeURIComponent(roomName)}/record/status`);
  }

  /** Switch the active video recording's layout (host only, video mode only). */
  async setRecordingLayout(roomName: string, layout: RecordingLayout): Promise<RecordingLayoutResponse> {
    return this.request('PATCH', `/rooms/${encodeURIComponent(roomName)}/record/layout`, { layout });
  }

  async uploadRecording(roomName: string, filePath: string, duration?: number, title?: string, tags?: string[]): Promise<RecordingUploadResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/record/upload`, {
      filePath,
      duration,
      title,
      tags,
    });
  }

  /**
   * Stream the recorded MP4 from the server back to the host's browser.
   * The host then re-uploads it through the user's normal /studio flow
   * (using their own auth — no shared service token shared with the SDK).
   */
  async fetchRecordingFile(roomName: string, downloadToken: string): Promise<RecordingFileResult> {
    const headers: Record<string, string> = {};
    if (this.sessionToken) headers['Authorization'] = `Bearer ${this.sessionToken}`;
    const response = await fetch(
      `${this.baseUrl}/rooms/${encodeURIComponent(roomName)}/record/file/${encodeURIComponent(downloadToken)}`,
      { method: 'GET', headers },
    );
    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { /* ignore */ }
      throw new HangoutsApiError(
        response.status,
        (errorBody as { message?: string })?.message || response.statusText,
        errorBody,
      );
    }
    const blob = await response.blob();
    const filename = response.headers.get('X-Recording-Filename') ?? `${roomName}.mp4`;
    const duration = Number(response.headers.get('X-Recording-Duration') ?? '0');
    return { blob, filename, duration, size: blob.size };
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
