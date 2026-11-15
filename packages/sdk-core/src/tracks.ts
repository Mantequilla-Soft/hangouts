/**
 * Names of the tracks the browser studio publishes, so integrators, overlays
 * and recorders can tell them apart.
 *
 * - `studio-program`: the composited program (Camera source), landscape on a
 *   desktop studio, 9:16 from the phone studio.
 * - `studio-vertical`: the 9:16 phone version of a landscape program, sent
 *   next to it when the host switches it on (Unknown source, so nothing that
 *   looks for "the camera" picks it up). Recorders, DVR and HLS should skip it.
 * - `studio-mix`: the full program audio; `host-monitor`: the mix-minus a
 *   collab guest hears.
 */
export const STUDIO_PROGRAM_TRACK = 'studio-program';
export const STUDIO_VERTICAL_TRACK = 'studio-vertical';
export const STUDIO_MIX_TRACK = 'studio-mix';
export const HOST_MONITOR_TRACK = 'host-monitor';
