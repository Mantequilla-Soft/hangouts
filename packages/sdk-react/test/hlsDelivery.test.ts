import { describe, it, expect } from 'vitest';
import { deliveryBody, deliveryState, resolveHlsUrl } from '../src/lib/hlsDelivery.js';

describe('HLS delivery helpers', () => {
  it('sends a body only when there is something to say', () => {
    expect(deliveryBody()).toBeNull();
    expect(deliveryBody({})).toBeNull();
    expect(deliveryBody({ hlsCapable: true })).toEqual({ hlsCapable: true });
    expect(deliveryBody({ hlsCapable: true, delivery: 'hls' })).toEqual({ hlsCapable: true, delivery: 'hls' });
  });

  it('resolves a relative playlist against the API base and keeps a CDN URL as it is', () => {
    expect(resolveHlsUrl('https://live.3speak.tv/', '/rooms/a%20b/hls/live.m3u8')).toBe('https://live.3speak.tv/rooms/a%20b/hls/live.m3u8');
    expect(resolveHlsUrl('https://live.3speak.tv', 'rooms/x/hls/live.m3u8')).toBe('https://live.3speak.tv/rooms/x/hls/live.m3u8');
    expect(resolveHlsUrl('https://live.3speak.tv', 'https://cdn.example/rooms/x/hls/live.m3u8')).toBe('https://cdn.example/rooms/x/hls/live.m3u8');
    expect(resolveHlsUrl('https://live.3speak.tv')).toBeNull();
  });

  it('reads an answer: old servers mean WebRTC, HLS needs a URL', () => {
    expect(deliveryState('https://api', {})).toEqual({ delivery: 'webrtc', hlsUrl: null, hlsFallback: false });
    expect(deliveryState('https://api', { delivery: 'webrtc', hlsFallback: true })).toEqual({ delivery: 'webrtc', hlsUrl: null, hlsFallback: true });
    expect(deliveryState('https://api', { delivery: 'hls', hlsUrl: '/rooms/r/hls/live.m3u8' }))
      .toEqual({ delivery: 'hls', hlsUrl: 'https://api/rooms/r/hls/live.m3u8', hlsFallback: false });
    expect(deliveryState('https://api', { delivery: 'hls' }).delivery).toBe('webrtc');
  });
});
