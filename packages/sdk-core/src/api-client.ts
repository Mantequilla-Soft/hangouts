import type { Room, RoomVisibility, BoostConfig, CreateRoomResponse, JoinRoomResponse, AuthSession, ChallengeResponse, RecordingMode, RecordingLayout, RecordingStartResponse, RecordingStopResponse, RecordingStatusResponse, RecordingLayoutResponse, RecordingUploadResponse, RecordingFileResult, StreamPlatform, StreamStartResponse, StreamStopResponse, StreamStatusResponse, HangoutsEvent, CreateEventInput, UpdateEventInput, EventStatus, UserPresence, StartEventResponse, GameInfo, ActiveGame, GameStartResponse, GameActionResponse, WordCollection } from './types.js';
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
    language?: string,
    boost?: BoostConfig,
  ): Promise<CreateRoomResponse> {
    return this.request('POST', '/rooms', { title, description, backgroundImage, visibility, language, boost });
  }

  async joinRoom(roomName: string): Promise<JoinRoomResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/join`);
  }

  /**
   * Join as an unauthenticated guest. Does NOT require a session token.
   * The server issues a `guest-*` identity that can listen, raise hand,
   * and chat. Guests can be promoted to speaker by the host, or banned
   * (IP-scoped to this room) if disruptive.
   *
   * @param displayName - Optional name shown to other participants. 2–32 chars.
   */
  async listenAsGuest(roomName: string, displayName?: string): Promise<JoinRoomResponse> {
    // Always send a JSON body so Fastify's type:'object' schema doesn't
    // reject the request when displayName is omitted (null body fails AJV).
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/listen`,
      displayName ? { displayName } : {});
  }

  /**
   * Ban a guest from the room. Host-only. Records the guest's IP so they
   * cannot rejoin, then kicks them immediately. Only works for `guest-*`
   * identities — use the platform's user management for Hive accounts.
   */
  async banGuest(roomName: string, identity: string): Promise<void> {
    return this.request(
      'POST',
      `/rooms/${encodeURIComponent(roomName)}/participants/${encodeURIComponent(identity)}/ban`,
    );
  }

  /**
   * Join as a silent OBS overlay observer. Issues an `obs-*` identity
   * that is invisible in participant lists, cannot chat or raise hand,
   * and is excluded from the guest cap and ban system. Use this for
   * Browser Source overlays — the overlay is read-only and produces
   * no audio output.
   */
  async joinAsObserver(roomName: string): Promise<JoinRoomResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/listen`, { silent: true });
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
    state: { focusedIdentity?: string | null; suppressScreenAutoFocus?: boolean; chatOpen?: boolean; activeGameId?: string | null },
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

  async getBoostConfig(): Promise<{ enabled: boolean; platformAccount: string; feePercent: number }> {
    return this.request('GET', '/boosts/config');
  }

  async updateBoostConfig(
    roomName: string,
    config: { enabled?: boolean; minBoostUsd?: number; creatorPayoutAccount?: string },
  ): Promise<{ boost: { enabled: boolean; minBoostUsd: number; creatorPayoutAccount?: string } }> {
    return this.request('PATCH', `/rooms/${encodeURIComponent(roomName)}/boost`, config);
  }

  // Events

  async listEvents(opts?: { status?: EventStatus; host?: string; limit?: number }): Promise<HangoutsEvent[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.host) params.set('host', opts.host);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.request('GET', `/events${qs ? `?${qs}` : ''}`);
  }

  async getEvent(id: string): Promise<HangoutsEvent | null> {
    try {
      return await this.request('GET', `/events/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof HangoutsApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createEvent(input: CreateEventInput): Promise<HangoutsEvent> {
    return this.request('POST', '/events', input);
  }

  async updateEvent(id: string, input: UpdateEventInput): Promise<HangoutsEvent> {
    return this.request('PATCH', `/events/${encodeURIComponent(id)}`, input);
  }

  async cancelEvent(id: string): Promise<void> {
    return this.request('DELETE', `/events/${encodeURIComponent(id)}`);
  }

  async attendEvent(id: string): Promise<{ attendees: string[]; attendeeCount: number }> {
    return this.request('POST', `/events/${encodeURIComponent(id)}/attend`);
  }

  async unattendEvent(id: string): Promise<{ attendees: string[]; attendeeCount: number }> {
    return this.request('DELETE', `/events/${encodeURIComponent(id)}/attend`);
  }

  async startEvent(id: string): Promise<StartEventResponse> {
    return this.request('POST', `/events/${encodeURIComponent(id)}/start`);
  }

  // Presence

  async getUserPresence(username: string): Promise<UserPresence> {
    return this.request('GET', `/presence/${encodeURIComponent(username)}`);
  }

  async getBulkPresence(usernames: string[]): Promise<Record<string, UserPresence>> {
    return this.request('POST', '/presence/bulk', { usernames });
  }

  // Games

  async listGames(): Promise<GameInfo[]> {
    return this.request('GET', '/games');
  }

  async getActiveGame(roomName: string): Promise<ActiveGame | null> {
    try {
      return await this.request('GET', `/rooms/${encodeURIComponent(roomName)}/game`);
    } catch (err) {
      if (err instanceof HangoutsApiError && err.status === 404) return null;
      throw err;
    }
  }

  async startGame(roomName: string, gameId: string, config?: unknown): Promise<GameStartResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/game/start`, { gameId, config });
  }

  async sendGameAction(roomName: string, action: unknown): Promise<GameActionResponse> {
    return this.request('POST', `/rooms/${encodeURIComponent(roomName)}/game/action`, { action });
  }

  async endGame(roomName: string): Promise<void> {
    return this.request('DELETE', `/rooms/${encodeURIComponent(roomName)}/game`);
  }

  async listWordCollections(): Promise<WordCollection[]> {
    return this.request('GET', '/game-collections');
  }
}
