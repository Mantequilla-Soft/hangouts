import { describe, it, expect } from 'vitest';
import { TrackType, TrackSource } from '@livekit/protocol';
import { pickProgramVideoTrack, pickVerticalVideoTrack, STUDIO_PROGRAM_TRACK, STUDIO_VERTICAL_TRACK } from '../../src/lib/programTrack.js';

const v = (sid: string, extra: Record<string, unknown> = {}) => ({ sid, type: TrackType.VIDEO, source: TrackSource.CAMERA, ...extra });
const audio = { sid: 'A', type: TrackType.AUDIO, source: TrackSource.MICROPHONE, name: 'studio-mix' };
const vertical = v('VERT', { name: STUDIO_VERTICAL_TRACK, source: TrackSource.UNKNOWN });

describe('pickProgramVideoTrack', () => {
  it('prefers the track named studio-program', () => {
    expect(pickProgramVideoTrack([v('OTHER'), audio, v('PROG', { name: STUDIO_PROGRAM_TRACK })])?.sid).toBe('PROG');
  });
  it('never returns the vertical track, even as a Camera source or listed first', () => {
    expect(pickProgramVideoTrack([{ ...vertical, source: TrackSource.CAMERA }, v('CAM')])?.sid).toBe('CAM');
    expect(pickProgramVideoTrack([vertical, audio])).toBeUndefined();
  });
  it('falls back to the first camera, then to any non screen share video', () => {
    expect(pickProgramVideoTrack([v('SCR', { source: TrackSource.SCREEN_SHARE }), v('CAM1'), v('CAM2')])?.sid).toBe('CAM1');
    expect(pickProgramVideoTrack([v('SCR', { source: TrackSource.SCREEN_SHARE }), v('ING', { source: TrackSource.UNKNOWN })])?.sid).toBe('ING');
    expect(pickProgramVideoTrack([v('SCR', { source: TrackSource.SCREEN_SHARE })])).toBeUndefined();
  });
  it('with a known stream shape, prefers the camera of that shape (unnamed tracks)', () => {
    const tall = v('TALL', { width: 720, height: 1280 });
    const wide = v('WIDE', { width: 1280, height: 720 });
    expect(pickProgramVideoTrack([tall, wide], { portrait: false })?.sid).toBe('WIDE');
    expect(pickProgramVideoTrack([wide, tall], { portrait: true })?.sid).toBe('TALL');
    expect(pickProgramVideoTrack([tall, wide])?.sid).toBe('TALL');
    // The name still wins over the shape.
    expect(pickProgramVideoTrack([wide, { ...tall, name: STUDIO_PROGRAM_TRACK }], { portrait: false })?.sid).toBe('TALL');
    // No size reported yet counts as a match.
    expect(pickProgramVideoTrack([v('NOSIZE'), wide], { portrait: true })?.sid).toBe('NOSIZE');
  });
  it('handles no tracks', () => {
    expect(pickProgramVideoTrack(undefined)).toBeUndefined();
    expect(pickProgramVideoTrack([])).toBeUndefined();
  });
});

describe('pickVerticalVideoTrack', () => {
  it('finds the vertical track by name', () => {
    expect(pickVerticalVideoTrack([v('CAM'), vertical])?.sid).toBe('VERT');
    expect(pickVerticalVideoTrack([v('CAM')])).toBeUndefined();
    expect(pickVerticalVideoTrack(null)).toBeUndefined();
  });
});
