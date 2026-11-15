import { describe, it, expect } from 'vitest';
import { rewindToken, checkRewindToken, buildRewindPlaylist } from '../../src/lib/dvrRewind.js';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 10, 15, 12, 30);

describe('rewind token', () => {
  it('is the same for everyone in a room and hour, valid this hour and the next, not for another room', () => {
    const tok = rewindToken('badadib-r1', T);
    expect(tok).toHaveLength(22);
    expect(rewindToken('badadib-r1', T + 60_000)).toBe(tok);
    expect(checkRewindToken('badadib-r1', tok, T)).toBe(true);
    expect(checkRewindToken('badadib-r1', tok, T + HOUR)).toBe(true);
    expect(checkRewindToken('badadib-r1', tok, T + 2 * HOUR)).toBe(false);
    expect(checkRewindToken('badadib-r2', tok, T)).toBe(false);
    expect(checkRewindToken('badadib-r1', 'short', T)).toBe(false);
    expect(checkRewindToken('badadib-r1', undefined as unknown as string, T)).toBe(false);
  });
});

const index = (n: number, seqStart = 0) => [
  '#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:3', `#EXT-X-MEDIA-SEQUENCE:${seqStart}`, '#EXT-X-PLAYLIST-TYPE:EVENT',
  ...Array.from({ length: n }, (_, i) => [`#EXT-X-PROGRAM-DATE-TIME:2026-11-15T12:00:${String(i * 2).padStart(2, '0')}Z`, '#EXTINF:2.000,', `/tmp/livekit-recordings/dvr/r/seg_${String(i + seqStart).padStart(5, '0')}.ts`]).flat(),
].join('\n');

describe('buildRewindPlaylist', () => {
  it('keeps only segments still on disk minus the two oldest, as a live playlist with the right media sequence', () => {
    const onDisk = ['seg_00003.ts', 'seg_00004.ts', 'seg_00005.ts', 'seg_00006.ts', 'seg_00007.ts', 'index.m3u8', 'live.m3u8'];
    const out = buildRewindPlaylist(index(8), onDisk)!;
    const lines = out.trim().split('\n');
    expect(lines.slice(0, 4)).toEqual(['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:3', '#EXT-X-MEDIA-SEQUENCE:5']);
    expect(lines.filter((l) => l.endsWith('.ts'))).toEqual(['seg_00005.ts', 'seg_00006.ts', 'seg_00007.ts']);
    expect(lines.filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME'))).toHaveLength(3);
    expect(out).not.toContain('ENDLIST');
    expect(out).not.toContain('PLAYLIST-TYPE');
  });

  it('honours a non-zero source media sequence and drops a discontinuity before the first kept segment', () => {
    const text = index(4, 10).replace('#EXTINF:2.000,\n/tmp/livekit-recordings/dvr/r/seg_00012.ts', '#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\n/tmp/livekit-recordings/dvr/r/seg_00012.ts');
    const out = buildRewindPlaylist(text, ['seg_00010.ts', 'seg_00011.ts', 'seg_00012.ts', 'seg_00013.ts'])!;
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:12');
    expect(out).not.toContain('DISCONTINUITY');
  });

  it('without an index: the listing in name order, minus the newest file, numbered from the names', () => {
    const out = buildRewindPlaylist(null, ['seg_00009.ts', 'seg_00006.ts', 'seg_00007.ts', 'seg_00008.ts', 'seg_00010.ts', 'x.mp4'], { segmentSec: 2, margin: 1 })!;
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:7');
    expect(out.trim().split('\n').filter((l) => l.endsWith('.ts'))).toEqual(['seg_00007.ts', 'seg_00008.ts', 'seg_00009.ts']);
    expect(out).toContain('#EXTINF:2.000,');
    expect(buildRewindPlaylist('', ['a.ts', 'b.ts'], { margin: 0 })).toContain('#EXT-X-MEDIA-SEQUENCE:0');
  });

  it('is null when nothing is playable yet, and ignores unsafe names', () => {
    expect(buildRewindPlaylist(index(2), ['seg_00000.ts', 'seg_00001.ts'])).toBeNull();
    expect(buildRewindPlaylist(null, [])).toBeNull();
    expect(buildRewindPlaylist('#EXTM3U\n#EXTINF:2,\n../etc.ts\n#EXTINF:2,\nok.ts\n', ['../etc.ts', 'ok.ts'], { margin: 0 })).toBe(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nok.ts\n',
    );
  });
});
