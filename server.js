const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.static('public'));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** roomId -> Set of sockets */
const rooms = new Map();

/** Broadcast a message to the rest of the room */
function roomBroadcast(roomId, except, payload) {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const socket of set) {
    if (socket !== except && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}

wss.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg = {};
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const { roomId, displayName } = msg;
      ws.displayName = displayName || 'Guest';
      let set = rooms.get(roomId);
      if (!set) {
        set = new Set();
        rooms.set(roomId, set);
      }
      if (set.size >= 2) {
        ws.send(JSON.stringify({ type: 'room-full' }));
        return;
      }
      set.add(ws);
      ws.roomId = roomId;
      const polite = set.size === 2; // first participant = impolite, second = polite
      ws.send(JSON.stringify({ type: 'joined', roomId, isPolite: polite }));
      roomBroadcast(roomId, ws, { type: 'peer-joined', id: ws.id, name: ws.displayName });
      return;
    }

    if (msg.type === 'signal' && ws.roomId) {
      roomBroadcast(ws.roomId, ws, { type: 'signal', from: ws.id, payload: msg.payload });
      return;
    }

    if (msg.type === 'transcript' && ws.roomId) {
      roomBroadcast(ws.roomId, ws, { type: 'transcript', from: ws.displayName, ...msg.data });
    }
  });

  ws.on('close', () => {
    const { roomId } = ws;
    if (!roomId) return;
    const set = rooms.get(roomId);
    if (!set) return;
    set.delete(ws);
    roomBroadcast(roomId, ws, { type: 'peer-left', id: ws.id });
    if (set.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
