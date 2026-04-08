import type { FastifyPluginAsync } from 'fastify';
import { EgressClient, StreamOutput, StreamProtocol, EncodingOptionsPreset } from 'livekit-server-sdk';
import { roomService } from '../lib/livekit.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';

const egressClient = new EgressClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

const DEFAULT_BG = 'https://hotipfs-3speak-1.b-cdn.net/ipfs/QmdU1V8Eefmv5E77Ct6hNG8A3f9b75dZmVS6ZVvw5ynnrn';
const EGRESS_TEMPLATE_URL = 'https://hangout.3speak.tv/egress-template';

// Track active streams: roomName → egressId
const activeStreams = new Map<string, string>();

async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const, meta: null };
  let meta: { host?: string; title?: string; [key: string]: unknown } = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
  if (meta.host !== username) return { error: 'forbidden' as const, meta: null };
  return { error: null, meta };
}

function buildRtmpUrl(platform: string, streamKey: string): string {
  if (platform === 'twitch') return `rtmp://live.twitch.tv/app/${streamKey}`;
  return `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;
}

export const streamingRoutes: FastifyPluginAsync = async (fastify) => {
  // Start streaming to YouTube/Twitch (host only)
  fastify.post('/rooms/:name/stream/start', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['platform', 'streamKey'],
        properties: {
          platform:          { type: 'string', enum: ['youtube', 'twitch'] },
          streamKey:         { type: 'string', minLength: 1 },
          backgroundImageUrl: { type: 'string' },
          videoEnabled:      { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { platform, streamKey, backgroundImageUrl, videoEnabled = false } =
      request.body as {
        platform: string;
        streamKey: string;
        backgroundImageUrl?: string;
        videoEnabled?: boolean;
      };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can start streaming');

    if (activeStreams.has(name)) {
      return reply.conflict('Room is already streaming');
    }

    const rtmpUrl = buildRtmpUrl(platform, streamKey);
    const streamOutput = new StreamOutput({
      protocol: StreamProtocol.RTMP,
      urls: [rtmpUrl],
    });

    let info;

    if (videoEnabled) {
      // Video room: use standard composite with speaker layout
      info = await egressClient.startRoomCompositeEgress(name, { stream: streamOutput }, {
        layout: 'speaker',
        encodingOptions: EncodingOptionsPreset.H264_720P_30,
      });
    } else {
      // Audio-only room: update room metadata with background image, use custom template
      const bgUrl = backgroundImageUrl || DEFAULT_BG;
      const currentMeta = check.meta || {};
      const updatedMeta = { ...currentMeta, streamBg: bgUrl };
      await roomService.updateRoomMetadata(name, JSON.stringify(updatedMeta));

      info = await egressClient.startRoomCompositeEgress(name, { stream: streamOutput }, {
        customBaseUrl: EGRESS_TEMPLATE_URL,
        encodingOptions: EncodingOptionsPreset.H264_720P_30,
      });
    }

    activeStreams.set(name, info.egressId);

    return reply.send({
      egressId: info.egressId,
      status: 'streaming',
      platform,
    });
  });

  // Stop streaming (host only)
  fastify.post('/rooms/:name/stream/stop', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can stop streaming');

    const egressId = activeStreams.get(name);
    if (!egressId) {
      return reply.badRequest('Room is not streaming');
    }

    const info = await egressClient.stopEgress(egressId);
    activeStreams.delete(name);

    return reply.send({
      egressId: info.egressId,
      status: 'stopped',
    });
  });

  // Get streaming status
  fastify.get('/rooms/:name/stream/status', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const egressId = activeStreams.get(name);
    return reply.send({ streaming: !!egressId, egressId: egressId ?? null });
  });
};
