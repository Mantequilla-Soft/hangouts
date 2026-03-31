import type { FastifyPluginAsync } from 'fastify';
import { EgressClient, EncodedFileOutput, EncodedFileType } from 'livekit-server-sdk';
import { roomService } from '../lib/livekit.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { readFile, unlink } from 'node:fs/promises';

const egressClient = new EgressClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

// Track active recordings: roomName → egressId
const activeRecordings = new Map<string, string>();

async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };
  let meta: { host?: string } = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
  if (meta.host !== username) return { error: 'forbidden' as const };
  return { error: null };
}

export const recordingRoutes: FastifyPluginAsync = async (fastify) => {
  // Start recording (host only)
  fastify.post('/rooms/:name/record/start', {
    preHandler: requireAuth,
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
    if (check.error === 'forbidden') return reply.forbidden('Only the host can start recording');

    if (activeRecordings.has(name)) {
      return reply.conflict('Room is already being recorded');
    }

    const filepath = `/tmp/livekit-recordings/${name}-${Date.now()}.mp3`;

    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP3,
      filepath,
    });

    const info = await egressClient.startRoomCompositeEgress(name, { file: output }, {
      audioOnly: true,
    });

    activeRecordings.set(name, info.egressId);

    return reply.send({
      egressId: info.egressId,
      status: 'recording',
      filepath,
    });
  });

  // Stop recording (host only)
  fastify.post('/rooms/:name/record/stop', {
    preHandler: requireAuth,
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
    if (check.error === 'forbidden') return reply.forbidden('Only the host can stop recording');

    const egressId = activeRecordings.get(name);
    if (!egressId) {
      return reply.badRequest('Room is not being recorded');
    }

    const info = await egressClient.stopEgress(egressId);
    activeRecordings.delete(name);

    // Get the file path from the egress info
    const filePath = info.fileResults?.[0]?.filename || '';

    return reply.send({
      egressId: info.egressId,
      status: 'stopped',
      filePath,
      duration: Number(info.fileResults?.[0]?.duration || 0) / 1e9, // nanoseconds to seconds
    });
  });

  // Get recording status (host only)
  fastify.get('/rooms/:name/record/status', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const egressId = activeRecordings.get(name);
    if (!egressId) {
      return reply.send({ recording: false });
    }

    return reply.send({ recording: true, egressId });
  });

  // Upload recording to audio.3speak.tv (host only)
  fastify.post('/rooms/:name/record/upload', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath: { type: 'string' },
          title: { type: 'string', maxLength: 128 },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { filePath, title, tags } = request.body as {
      filePath: string;
      title?: string;
      tags?: string[];
    };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can upload recordings');

    if (!config.AUDIO_API_KEY) {
      return reply.serviceUnavailable('Audio upload not configured (AUDIO_API_KEY missing)');
    }

    // Validate the file path is within the recordings directory
    if (!filePath.startsWith('/tmp/livekit-recordings/')) {
      return reply.badRequest('Invalid file path');
    }

    // Read the file and upload to audio.3speak.tv
    let fileBuffer: Buffer;
    try {
      fileBuffer = await readFile(filePath);
    } catch {
      return reply.notFound('Recording file not found — it may have been cleaned up');
    }

    // Get room metadata for default title
    const rooms = await roomService.listRooms([name]);
    let roomTitle = name;
    try {
      const meta = JSON.parse(rooms[0]?.metadata || '{}');
      roomTitle = meta.title || name;
    } catch { /* ignore */ }

    const formData = new FormData();
    formData.append('audio', new Blob([new Uint8Array(fileBuffer)], { type: 'audio/mpeg' }), `${name}.mp3`);
    formData.append('format', 'mp3');
    formData.append('title', title || roomTitle);
    formData.append('category', 'podcast');
    formData.append('tags', JSON.stringify(tags || ['hangout', 'podcast', 'hive']));

    const audioResponse = await fetch(`${config.AUDIO_API_URL}/api/audio/upload`, {
      method: 'POST',
      headers: {
        'X-API-Key': config.AUDIO_API_KEY,
        'X-User': request.username,
      },
      body: formData,
    });

    if (!audioResponse.ok) {
      const err = await audioResponse.text();
      return reply.internalServerError(`Audio upload failed: ${err}`);
    }

    const audioResult = await audioResponse.json() as {
      success: boolean;
      permlink: string;
      cid: string;
      playUrl: string;
    };

    // Clean up the local file
    try { await unlink(filePath); } catch { /* ignore */ }

    return reply.send({
      success: true,
      permlink: audioResult.permlink,
      cid: audioResult.cid,
      playUrl: audioResult.playUrl,
    });
  });
};
