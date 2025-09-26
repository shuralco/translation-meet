const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { URL } = require('url');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const allowedDeepgramModels = new Set(['nova-2']);
const envModel = (process.env.DEEPGRAM_MODEL || '').toLowerCase();
const DEFAULT_DEEPGRAM_MODEL = allowedDeepgramModels.has(envModel) ? envModel : 'nova-2';

const app = express();
app.use(express.static('public'));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const signalingServer = new WebSocketServer({ server, path: '/ws' });
const transcriptionServer = new WebSocketServer({ server, path: '/stt' });

/** roomId -> Map<socketId, socket> */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const socket of room.values()) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}

function sendToPeer(roomId, peerId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  const peer = room.get(peerId);
  if (peer && peer.readyState === peer.OPEN) {
    peer.send(JSON.stringify(payload));
  }
}

signalingServer.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.roomId = null;
  ws.displayName = 'Guest';

  ws.on('message', (raw) => {
    if (typeof raw === 'string' || raw instanceof String) {
      handleSignalingMessage(ws, raw);
    }
  });

  ws.on('close', () => {
    const { roomId } = ws;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.delete(ws.id);
    broadcastToRoom(roomId, { type: 'peer-left', id: ws.id });
    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });
});

function handleSignalingMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    return;
  }

  if (msg.type === 'join') {
    const roomId = (msg.roomId || '').trim();
    if (!roomId) {
      ws.send(JSON.stringify({ type: 'error', reason: 'room-required' }));
      return;
    }
    const displayName = (msg.displayName || 'Guest').trim() || 'Guest';
    const room = getRoom(roomId);
    if (room.size >= 4) {
      ws.send(JSON.stringify({ type: 'room-full', max: 4 }));
      return;
    }
    ws.displayName = displayName;
    ws.roomId = roomId;
    room.set(ws.id, ws);

    const peers = Array.from(room.values())
      .filter((peer) => peer.id !== ws.id)
      .map((peer) => ({ id: peer.id, name: peer.displayName }));

    ws.send(JSON.stringify({
      type: 'joined',
      roomId,
      id: ws.id,
      peers,
    }));

    for (const peer of room.values()) {
      if (peer.id !== ws.id && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({
          type: 'peer-joined',
          id: ws.id,
          name: ws.displayName,
        }));
      }
    }
    return;
  }

  if (!ws.roomId) return;

  if (msg.type === 'signal' && msg.target) {
    sendToPeer(ws.roomId, msg.target, {
      type: 'signal',
      from: ws.id,
      payload: msg.payload,
    });
    return;
  }

  if (msg.type === 'transcript') {
    broadcastToRoom(ws.roomId, {
      type: 'transcript',
      participantId: ws.id,
      name: ws.displayName,
      text: msg.text,
      final: Boolean(msg.final),
      ts: msg.ts || Date.now(),
    });
  }
}

transcriptionServer.on('connection', (client, req) => {
  if (!DEEPGRAM_API_KEY) {
    client.close(1011, 'Deepgram API key is not configured');
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const roomId = reqUrl.searchParams.get('roomId');
  const participantId = reqUrl.searchParams.get('participantId');
  const displayName = reqUrl.searchParams.get('name') || 'Participant';

  if (!roomId || !participantId) {
    client.close(1008, 'roomId and participantId are required');
    return;
  }

  const requestedModel = (reqUrl.searchParams.get('model') || '').toLowerCase();
  const resolvedModel = allowedDeepgramModels.has(requestedModel)
    ? requestedModel
    : DEFAULT_DEEPGRAM_MODEL;

  const dgUrl = new URL('wss://api.deepgram.com/v1/listen');
  dgUrl.searchParams.set('model', resolvedModel);
  dgUrl.searchParams.set('language', 'uk');
  dgUrl.searchParams.set('punctuate', 'true');
  dgUrl.searchParams.set('smart_format', 'true');
  dgUrl.searchParams.set('diarize', 'true');
  dgUrl.searchParams.set('encoding', 'opus');
  dgUrl.searchParams.set('sample_rate', '48000');

  const dgSocket = new WebSocket(dgUrl, {
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
    },
  });

  let deepgramOpen = false;

  dgSocket.on('open', () => {
    deepgramOpen = true;
  });

  dgSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type !== 'Results') return;
      const channel = message.channel || {};
      const alternatives = channel.alternatives || [];
      if (!alternatives.length) return;
      const transcript = alternatives[0].transcript || '';
      if (!transcript.trim()) return;
      const isFinal = Boolean(message.is_final);
      broadcastToRoom(roomId, {
        type: 'transcript',
        participantId,
        name: displayName,
        text: transcript.trim(),
        final: isFinal,
        ts: Date.now(),
      });
    } catch (err) {
      console.error('Deepgram parse error', err);
    }
  });

  dgSocket.on('close', () => {
    client.close();
  });

  dgSocket.on('error', (err) => {
    console.error('Deepgram socket error', err.message || err);
    client.close(1011, 'Deepgram connection error');
  });

  client.on('message', (chunk) => {
    if (!deepgramOpen) return;
    if (dgSocket.readyState === dgSocket.OPEN) {
      dgSocket.send(chunk);
    }
  });

  client.on('close', () => {
    if (dgSocket.readyState === dgSocket.OPEN) {
      dgSocket.close();
    }
  });

  client.on('error', () => {
    if (dgSocket.readyState === dgSocket.OPEN) {
      dgSocket.close();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
