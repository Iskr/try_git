const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_PARTICIPANTS = parseInt(process.env.MAX_PARTICIPANTS, 10) || 5;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS, 10) || 500;
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS, 10) || 2000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_MESSAGE_BYTES = 64 * 1024;
// Messages per second a client may send before throttling; hard-close at 3x.
const RATE_LIMIT_PER_SECOND = 50;

const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;
const SIGNALING_TYPES = new Set(['offer', 'answer', 'ice-candidate']);

// Secret for resume tokens. Tokens prove a reconnecting client owns the
// clientId it asks to reuse, so room members cannot impersonate each other.
const RESUME_SECRET = crypto.randomBytes(32);

function resumeTokenFor(clientId) {
  return crypto.createHmac('sha256', RESUME_SECRET).update(clientId).digest('hex');
}

function verifyResumeToken(clientId, token) {
  if (typeof clientId !== 'string' || typeof token !== 'string') {
    return false;
  }
  const expected = Buffer.from(resumeTokenFor(clientId), 'utf8');
  const provided = Buffer.from(token, 'utf8');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      // 'self' covers same-origin ws(s) only in CSP3 browsers; list schemes explicitly
      "connect-src 'self' wss: ws:",
      "media-src 'self' blob: mediastream:",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      // Allow embedding as a Telegram Mini App, block everything else
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size,
  });
});

// ICE servers are handed to clients from here so TURN credentials live in
// environment variables instead of being hardcoded in the frontend.
app.get('/config', (req, res) => {
  const iceServers = [];

  const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  if (process.env.TURN_SERVER_URL) {
    iceServers.push({
      urls: process.env.TURN_SERVER_URL.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || '',
    });
  }

  res.json({ iceServers, maxParticipants: MAX_PARTICIPANTS });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: MAX_MESSAGE_BYTES });

// Map<roomId, Map<clientId, ws>>
const rooms = new Map();

function sendTo(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, code, text) {
  sendTo(ws, { type: 'error', code, text });
}

function broadcast(roomId, message, excludeId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const messageStr = JSON.stringify(message);
  room.forEach((client, id) => {
    if (id !== excludeId && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

function handleJoin(ws, state, rawRoomId) {
  if (typeof rawRoomId !== 'string') {
    sendError(ws, 'invalid-room', 'Некорректный код звонка');
    return;
  }

  const roomId = rawRoomId.trim().toUpperCase();
  if (!ROOM_ID_PATTERN.test(roomId)) {
    sendError(ws, 'invalid-room', 'Код звонка — 6 символов: буквы A-Z и цифры');
    return;
  }

  // Leaving the previous room first prevents stale entries when a client
  // joins a new room over the same connection.
  if (state.roomId && state.roomId !== roomId) {
    handleLeave(state);
  }

  let room = rooms.get(roomId);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) {
      sendError(ws, 'server-busy', 'Сервер перегружен, попробуйте позже');
      return;
    }
    room = new Map();
    rooms.set(roomId, room);
  }

  // A rejoining client replaces its own (possibly dead) entry, so it is
  // exempt from the participant limit.
  if (!room.has(state.clientId) && room.size >= MAX_PARTICIPANTS) {
    sendTo(ws, { type: 'room-full', roomId, maxParticipants: MAX_PARTICIPANTS });
    return;
  }

  room.set(state.clientId, ws);
  state.roomId = roomId;

  const participants = Array.from(room.keys()).filter((id) => id !== state.clientId);

  sendTo(ws, {
    type: 'joined',
    roomId,
    clientId: state.clientId,
    participants,
    resumeToken: resumeTokenFor(state.clientId),
  });

  broadcast(roomId, { type: 'peer-joined', clientId: state.clientId }, state.clientId);

  console.log(`Client ${state.clientId} joined room ${roomId}. Total participants: ${room.size}`);
}

function handleSignaling(state, data) {
  const room = state.roomId ? rooms.get(state.roomId) : null;
  if (!room || room.get(state.clientId) !== state.ws) {
    return;
  }

  if (typeof data.targetId !== 'string' || data.targetId === state.clientId) {
    return;
  }

  const targetClient = room.get(data.targetId);
  if (targetClient && targetClient.readyState === WebSocket.OPEN) {
    // senderId is always set server-side so clients cannot spoof it
    targetClient.send(JSON.stringify({ ...data, senderId: state.clientId }));
  }
}

function handleLeave(state) {
  const { roomId, clientId, ws } = state;
  if (!roomId) {
    return;
  }

  state.roomId = null;
  const room = rooms.get(roomId);
  // Only remove the entry if it still belongs to this connection — after a
  // reconnect the clientId may already be owned by a newer socket.
  if (!room || room.get(clientId) !== ws) {
    return;
  }

  room.delete(clientId);
  broadcast(roomId, { type: 'peer-left', clientId }, clientId);

  if (room.size === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} deleted (empty)`);
  }

  console.log(`Client ${clientId} left room ${roomId}`);
}

wss.on('connection', (ws) => {
  if (wss.clients.size > MAX_CONNECTIONS) {
    ws.close(1013, 'Server overloaded');
    return;
  }

  const state = { ws, clientId: crypto.randomUUID(), roomId: null };
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  let messageBudget = RATE_LIMIT_PER_SECOND;
  const refill = setInterval(() => {
    messageBudget = RATE_LIMIT_PER_SECOND;
  }, 1000);

  console.log(`Client connected: ${state.clientId}`);

  ws.on('message', (message) => {
    messageBudget -= 1;
    if (messageBudget <= -2 * RATE_LIMIT_PER_SECOND) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }
    if (messageBudget < 0) {
      return;
    }

    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      sendError(ws, 'bad-message', 'Некорректное сообщение');
      return;
    }
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      return;
    }

    try {
      if (data.type === 'ping') {
        // Application-level ping for browsers that can't observe ws pongs
        sendTo(ws, { type: 'pong' });
      } else if (data.type === 'join') {
        handleJoin(ws, state, data.roomId);
      } else if (data.type === 'rejoin') {
        // Reuse the old clientId only when the resume token proves ownership;
        // otherwise fall back to a fresh identity.
        if (verifyResumeToken(data.clientId, data.resumeToken)) {
          state.clientId = data.clientId;
        }
        handleJoin(ws, state, data.roomId);
      } else if (SIGNALING_TYPES.has(data.type)) {
        handleSignaling(state, data);
      } else if (data.type === 'leave') {
        handleLeave(state);
      }
      // Unknown message types are dropped silently.
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    clearInterval(refill);
    console.log(`Client disconnected: ${state.clientId}`);
    handleLeave(state);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error (${state.clientId}):`, error.message);
  });
});

// Terminate connections that stop answering pings so dead sockets do not
// linger inside rooms (mobile clients drop without a close frame all the time).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeat);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully`);
  clearInterval(heartbeat);
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
  server.close(() => {
    process.exit(0);
  });
  // Force exit if connections refuse to drain
  setTimeout(() => process.exit(1), 5000).unref();
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Calling service running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

module.exports = { app, server, wss, rooms };
