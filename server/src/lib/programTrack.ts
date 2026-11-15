import { TrackType, TrackSource } from '@livekit/protocol';

/**
 * The studio's published tracks, by name.
 *
 * The browser studio publishes ONE composited landscape (or phone portrait)
 * program track as `studio-program` (Camera source). With the phone version
 * switched on (H19 "Landscape and vertical at the same time") it also publishes
 * a second, 9:16 crop of the same program as `studio-vertical`, under the
 * Unknown source so that nothing that looks for "the camera" picks it up by
 * accident. The same names live in sdk-core (`STUDIO_PROGRAM_TRACK`,
 * `STUDIO_VERTICAL_TRACK`) and sdk-react.
 */
export const STUDIO_PROGRAM_TRACK = 'studio-program';
export const STUDIO_VERTICAL_TRACK = 'studio-vertical';

/** The subset of LiveKit's TrackInfo the pickers read. */
export interface TrackInfoLike {
  sid?: string;
  name?: string;
  type?: TrackType;
  source?: TrackSource;
  width?: number;
  height?: number;
}

/**
 * The host's MAIN program video, the one DVR clips, the VOD recording and
 * HLS carry: never the vertical phone crop. DVR, recording and HLS all pick
 * through this one function, so they always agree.
 *
 * Order: the track named `studio-program`; else a Camera video whose shape
 * matches the stream (`portrait`, when known); else the first Camera video
 * (OBS ingress and headless streams name theirs differently or not at all);
 * else, as a last resort, any video that is not a screen share. A track named
 * `studio-vertical` is never returned, even if a future studio publishes it
 * under the Camera source: no program track means the caller falls back to its
 * template composite.
 */
export function pickProgramVideoTrack<T extends TrackInfoLike>(
  tracks: readonly T[] | undefined | null,
  opts: { portrait?: boolean } = {},
): T | undefined {
  if (!tracks?.length) return undefined;
  const videos = tracks.filter((t) => t.type === TrackType.VIDEO && t.name !== STUDIO_VERTICAL_TRACK);
  const cameras = videos.filter((t) => t.source === TrackSource.CAMERA);
  const shaped = (t: T) => !t.width || !t.height || (opts.portrait ? t.height > t.width : t.width >= t.height);
  return videos.find((t) => t.name === STUDIO_PROGRAM_TRACK)
    ?? (opts.portrait === undefined ? undefined : cameras.find(shaped))
    ?? cameras[0]
    ?? videos.find((t) => t.source !== TrackSource.SCREEN_SHARE);
}

/** The host's vertical phone track, if they publish one. */
export function pickVerticalVideoTrack<T extends TrackInfoLike>(tracks: readonly T[] | undefined | null): T | undefined {
  return tracks?.find((t) => t.type === TrackType.VIDEO && t.name === STUDIO_VERTICAL_TRACK);
}
