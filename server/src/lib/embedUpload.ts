import * as tus from 'tus-js-client';
import { config } from '../config.js';

export interface EmbedUploadResult {
  /** Playable embed URL captured from the X-Embed-URL response header */
  embedUrl: string;
  /** Permlink derived from the ?v=author/permlink query param of embedUrl */
  permlink: string;
  /** Owner — same as the value passed in */
  owner: string;
  /** URL the host should land on to fill in metadata + publish to Hive */
  studioUrl: string;
}

interface EmbedUploadOpts {
  buffer: Buffer;
  filename: string;
  filetype: string;        // e.g. 'video/mp4'
  owner: string;           // Hive username
  duration: number;        // seconds
  /** When true, marks the upload as a short. Hangouts video recordings should be false. */
  short?: boolean;
  /** Frontend-app tag stamped on the upload — appears in admin tooling. */
  frontendApp?: string;
  onProgress?: (pct: number) => void;
}

/**
 * Push a recorded MP4 buffer to the 3speak embed-video upload service via TUS.
 * Mirrors the shorts editor flow in tv-mode-3speak.tv: same endpoint, same
 * X-Embed-URL header, same metadata schema. The host then lands on the
 * embed-studio prefilled with the resulting permlink to enter title/description
 * and publish the Hive post.
 */
export async function uploadToEmbedService(opts: EmbedUploadOpts): Promise<EmbedUploadResult> {
  const { buffer, filename, filetype, owner, duration, short = false, frontendApp = '3speak-hangouts', onProgress } = opts;

  let capturedEmbedUrl: string | null = null;

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(buffer, {
      endpoint: config.EMBED_UPLOAD_URL,
      chunkSize: 5 * 1024 * 1024,
      retryDelays: [0, 2_000, 5_000, 10_000],
      storeFingerprintForResuming: false,
      removeFingerprintOnSuccess: true,
      headers: {
        ...(config.EMBED_API_KEY ? { 'X-API-Key': config.EMBED_API_KEY } : {}),
      },
      metadata: {
        filename,
        filetype,
        frontend_app: frontendApp,
        owner,
        short: short ? 'true' : 'false',
        duration: String(Math.round(duration)),
      },
      onError: (err) => reject(err),
      onProgress: (uploaded, total) => {
        if (onProgress && total) onProgress(Math.round((uploaded / total) * 100));
      },
      onSuccess: () => resolve(),
      onAfterResponse: (_req, res) => {
        const header = res.getHeader('X-Embed-URL') || res.getHeader('x-embed-url');
        if (header) capturedEmbedUrl = header;
      },
    });
    upload.start();
  });

  if (!capturedEmbedUrl) {
    throw new Error('Embed service did not return an X-Embed-URL header');
  }

  // Permlink lives in the ?v=author/permlink query param.
  const v = new URL(capturedEmbedUrl).searchParams.get('v');
  const permlink = v ? v.split('/').pop() ?? '' : '';
  if (!permlink) {
    throw new Error('Could not parse permlink from embed URL');
  }

  const studioUrl = buildStudioUrl({ permlink, owner, embedUrl: capturedEmbedUrl });

  return { embedUrl: capturedEmbedUrl, permlink, owner, studioUrl };
}

function buildStudioUrl(params: { permlink: string; owner: string; embedUrl: string }): string {
  const url = new URL('/embed-studio', config.STUDIO_FRONTEND_URL);
  url.searchParams.set('prefilled', 'true');
  url.searchParams.set('permlink', params.permlink);
  url.searchParams.set('owner', params.owner);
  url.searchParams.set('embedUrl', params.embedUrl);
  return url.toString();
}
