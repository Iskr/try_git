const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

function intFromEnv(name, fallback, min) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed >= (min || 0) ? parsed : fallback;
}

const PORT = intFromEnv('PORT', 3000, 1);
const MAX_PARTICIPANTS = intFromEnv('MAX_PARTICIPANTS', 5, 2);
const MAX_ROOMS = intFromEnv('MAX_ROOMS', 500, 1);
const MAX_CONNECTIONS = intFromEnv('MAX_CONNECTIONS', 2000, 1);
// Abuse limits are keyed on the client IP: a per-connection budget alone is
// useless because an attacker simply opens more connections.
const MAX_CONNECTIONS_PER_IP = intFromEnv('MAX_CONNECTIONS_PER_IP', 30, 1);
// Room ids are only 6 chars, so the practical defence against enumeration is
// capping how many *distinct* rooms one IP may touch per minute. Legitimate
// users need a handful; a scanner needs thousands.
const MAX_ROOMS_PER_IP_PER_MINUTE = intFromEnv('MAX_ROOMS_PER_IP_PER_MINUTE', 30, 1);
const HEARTBEAT_INTERVAL_MS = 30000;
// Sockets that connect but never join are dropped — they are either broken
// clients or a cheap way to sit on the connection cap.
const IDLE_TIMEOUT_MS = intFromEnv('IDLE_TIMEOUT_MS', 120000, 10000);
const MAX_MESSAGE_BYTES = 64 * 1024;
// A client that stops reading must not be able to make us buffer without
// bound. Generous enough that a mobile client renegotiating on a bad link is
// never hit by it.
const MAX_BUFFERED_BYTES = intFromEnv('MAX_BUFFERED_BYTES', 1024 * 1024, 64 * 1024);
// Messages per second a client may send before throttling; hard-close at 3x.
const RATE_LIMIT_PER_SECOND = 50;
const RATE_LIMIT_CLOSE_AFTER = 2 * RATE_LIMIT_PER_SECOND;
// Number of proxy hops in front of us. Only trusted hops may set the client
// IP — trusting X-Forwarded-For blindly would let an attacker forge a fresh
// "IP" per connection and walk straight through the per-IP limits. Defaults to
// 0 everywhere: guessing "1" for production would silently hand that bypass to
// any deployment that is in fact directly exposed.
const TRUST_PROXY = intFromEnv('TRUST_PROXY', 0);
// Empty list means "same origin only".
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
// Native wrappers send no Origin header, so a missing one is allowed unless
// the deployment opts into strictness.
const REQUIRE_ORIGIN = process.env.REQUIRE_ORIGIN === '1';

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LOG_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info;

function logError(...args) {
  if (LOG_LEVEL >= LOG_LEVELS.error) console.error(...args);
}
function logWarn(...args) {
  if (LOG_LEVEL >= LOG_LEVELS.warn) console.warn(...args);
}
function logInfo(...args) {
  if (LOG_LEVEL >= LOG_LEVELS.info) console.log(...args);
}
// Per-client events are attacker-paced, so they stay off by default.
function logDebug(...args) {
  if (LOG_LEVEL >= LOG_LEVELS.debug) console.log(...args);
}

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
app.set('trust proxy', TRUST_PROXY);

app.use((req, res, next) => {
  // Same-origin ws(s) resolves under 'self' only in CSP3 browsers; naming the
  // host keeps older WebKit working without opening the policy to every host.
  const host = typeof req.headers.host === 'string' && /^[A-Za-z0-9.\-:[\]]+$/.test(req.headers.host)
    ? req.headers.host
    : null;
  const connectSrc = host
    ? `connect-src 'self' wss://${host} ws://${host}`
    : "connect-src 'self'";

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      connectSrc,
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
  // req.secure covers x-forwarded-proto through trusted hops; the raw header
  // is honoured too, because failing to send HSTS on a TLS deployment that
  // has not set TRUST_PROXY is worse than a client pinning HSTS on itself.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size,
    connections: wss.clients.size,
  });
});

// TURN credentials. When TURN_STATIC_AUTH_SECRET is set we hand out coturn
// REST-style ephemeral credentials (`use-auth-secret`) so a leaked /config
// response cannot be replayed as a free relay forever. Static
// TURN_USERNAME/TURN_PASSWORD remain supported as a fallback.
const TURN_CREDENTIAL_TTL_SECONDS = intFromEnv('TURN_CREDENTIAL_TTL_SECONDS', 6 * 3600, 300);

function turnCredentials() {
  const secret = process.env.TURN_STATIC_AUTH_SECRET;
  if (!secret) {
    return {
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || '',
    };
  }
  const expiry = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${expiry}:webrtc`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

// Cloudflare's managed TURN, for deployments without a relay of their own.
// Credentials are minted by their API rather than derived locally, so the
// result is cached: /config is public, and without a cache anyone could spend
// the account's API quota by refreshing the page.
const CLOUDFLARE_TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID;
const CLOUDFLARE_TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN;
const CLOUDFLARE_TURN_TTL_SECONDS = intFromEnv('CLOUDFLARE_TURN_TTL_SECONDS', 6 * 3600, 600);
// How long a failure is remembered, so an outage at their end does not turn
// into one request per visitor.
const CLOUDFLARE_TURN_ERROR_BACKOFF_MS = 60000;

const cloudflareTurn = { entries: null, expiresAt: 0, failedUntil: 0, inflight: null };

// The documented response is an array holding Cloudflare's STUN entry and a
// TURN entry with credentials; older shapes returned the TURN entry on its
// own. Accept either, and keep every entry — their STUN on port 53 gets
// through networks that block 3478.
function normalizeCloudflareResponse(body) {
  const raw = body && (body.iceServers || body.ice_servers);
  if (!raw) return null;
  const list = (Array.isArray(raw) ? raw : [raw])
    .filter((s) => s && s.urls)
    .map((s) => {
      const entry = { urls: Array.isArray(s.urls) ? s.urls : [s.urls] };
      if (s.username && s.credential) {
        entry.username = s.username;
        entry.credential = s.credential;
      }
      return entry;
    });
  // Without a credentialed entry there is no relay, only STUN we already have
  if (!list.some((s) => s.username && s.credential)) return null;
  return list;
}

async function cloudflareIceServers() {
  if (!CLOUDFLARE_TURN_KEY_ID || !CLOUDFLARE_TURN_API_TOKEN) {
    return null;
  }
  const now = Date.now();
  if (cloudflareTurn.entries && now < cloudflareTurn.expiresAt) {
    return cloudflareTurn.entries;
  }
  if (now < cloudflareTurn.failedUntil) {
    return cloudflareTurn.entries;
  }
  // Coalesce: a burst of joins must produce one API call, not one each.
  if (cloudflareTurn.inflight) {
    return cloudflareTurn.inflight;
  }

  cloudflareTurn.inflight = (async () => {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CLOUDFLARE_TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CLOUDFLARE_TURN_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: CLOUDFLARE_TURN_TTL_SECONDS }),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) {
        throw new Error(`Cloudflare TURN API returned ${res.status}`);
      }
      const entries = normalizeCloudflareResponse(await res.json());
      if (!entries) {
        throw new Error('Cloudflare TURN API returned an unrecognised body');
      }
      cloudflareTurn.entries = entries;
      // Refresh early so a call never starts on credentials about to expire
      cloudflareTurn.expiresAt = Date.now() + Math.max(60, CLOUDFLARE_TURN_TTL_SECONDS * 0.8) * 1000;
      cloudflareTurn.failedUntil = 0;
      return entries;
    } catch (error) {
      logWarn('Could not fetch Cloudflare TURN credentials:', error.message);
      cloudflareTurn.failedUntil = Date.now() + CLOUDFLARE_TURN_ERROR_BACKOFF_MS;
      // Keep serving the previous credentials if we have any — stale relays
      // beat no relay.
      return cloudflareTurn.entries;
    } finally {
      cloudflareTurn.inflight = null;
    }
  })();

  return cloudflareTurn.inflight;
}

// ICE servers are handed to clients from here so TURN credentials live in
// environment variables instead of being hardcoded in the frontend.
app.get('/config', async (req, res) => {
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
      ...turnCredentials(),
    });
  }

  // Both can be configured at once: more candidate paths, more calls that
  // connect. A failure here must never take /config down with it.
  try {
    const cloudflare = await cloudflareIceServers();
    if (cloudflare) {
      iceServers.push(...cloudflare);
    }
  } catch (error) {
    logWarn('Cloudflare TURN lookup failed:', error.message);
  }

  // Credentials must never sit in a shared cache
  res.setHeader('Cache-Control', 'no-store');
  res.json({ iceServers, maxParticipants: MAX_PARTICIPANTS });
});

// The app ships unversioned assets, so a long max-age would pair a fresh
// index.html with a stale app.js after a deploy — i.e. an old client speaking
// to a new protocol. 'no-cache' still allows 304s via ETag.
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

// Map<roomId, Map<clientId, ws>>
const rooms = new Map();
// Map<ip, connectionCount>
const connectionsByIp = new Map();
// Map<ip, { windowStart, rooms: Set<roomId> }>
const joinsByIp = new Map();

function clientIpFrom(req) {
  const direct = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (TRUST_PROXY <= 0) {
    return direct;
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') {
    return direct;
  }
  const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean);
  // Count back TRUST_PROXY hops from the right: entries further left are
  // attacker-supplied and must not be trusted.
  const index = hops.length - TRUST_PROXY;
  return hops[index] || direct;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return !REQUIRE_ORIGIN;
  }
  if (ALLOWED_ORIGINS.length > 0) {
    return ALLOWED_ORIGINS.includes(origin);
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch (error) {
    return false;
  }
}

// A refill-free token bucket: no per-connection timer, state is advanced
// lazily from the timestamp of the previous message.
function takeToken(bucket, ratePerSecond, burst) {
  const now = Date.now();
  // Clamp at zero: a backwards clock step must not drain a healthy client's
  // budget and close its connection.
  const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * ratePerSecond);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

// Distinct rooms one IP may touch per minute.
function allowRoomProbe(ip, roomId) {
  const now = Date.now();
  let entry = joinsByIp.get(ip);
  if (!entry || now - entry.windowStart >= 60000) {
    entry = { windowStart: now, rooms: new Set() };
    joinsByIp.set(ip, entry);
  }
  if (entry.rooms.has(roomId)) {
    return true;
  }
  if (entry.rooms.size >= MAX_ROOMS_PER_IP_PER_MINUTE) {
    return false;
  }
  entry.rooms.add(roomId);
  return true;
}

function sendTo(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    logWarn('Closing socket with a full send buffer');
    ws.close(1013, 'Send buffer overflow');
    return;
  }
  ws.send(JSON.stringify(message));
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
    if (id === excludeId || client.readyState !== WebSocket.OPEN) {
      return;
    }
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.close(1013, 'Send buffer overflow');
      return;
    }
    client.send(messageStr);
  });
}

// `identity` is the clientId a verified rejoin asked to reuse, or null. Every
// check below runs before the client's current seat is given up, so a join
// that cannot be granted leaves the caller exactly where it was rather than
// ejecting it from a working call.
function handleJoin(ws, state, rawRoomId, identity) {
  if (typeof rawRoomId !== 'string') {
    sendError(ws, 'invalid-room', 'Некорректный код звонка');
    return;
  }

  const roomId = rawRoomId.trim().toUpperCase();
  if (!ROOM_ID_PATTERN.test(roomId)) {
    sendError(ws, 'invalid-room', 'Код звонка — 6 символов: буквы A-Z и цифры');
    return;
  }

  if (!allowRoomProbe(state.ip, roomId)) {
    sendError(ws, 'too-many-joins', 'Слишком много попыток. Подождите минуту.');
    return;
  }

  const clientId = identity || state.clientId;
  const existing = rooms.get(roomId);

  // Re-joining the room this socket already occupies is a no-op: peers treat
  // 'peer-joined' for a known id as "reconnected" and tear their session
  // down, so re-broadcasting it would let a member spam renegotiations.
  if (state.roomId === roomId && existing && existing.get(clientId) === ws) {
    sendTo(ws, {
      type: 'joined',
      roomId,
      clientId,
      participants: Array.from(existing.keys()).filter((id) => id !== clientId),
      resumeToken: resumeTokenFor(clientId),
    });
    return;
  }

  if (!existing && rooms.size >= MAX_ROOMS) {
    sendError(ws, 'server-busy', 'Сервер перегружен, попробуйте позже');
    return;
  }

  // A rejoining client replaces its own (possibly dead) entry, so it is
  // exempt from the participant limit.
  if (existing && !existing.has(clientId) && existing.size >= MAX_PARTICIPANTS) {
    sendTo(ws, { type: 'room-full', roomId, maxParticipants: MAX_PARTICIPANTS });
    return;
  }

  // Admitted. Only now is it safe to release whatever this socket held:
  // leaving the old room, and — for a rejoin — the seat under the old
  // identity, which would otherwise be orphaned in the room map forever.
  if (state.roomId && (state.roomId !== roomId || clientId !== state.clientId)) {
    handleLeave(state);
  }
  state.clientId = clientId;

  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }

  room.set(state.clientId, ws);
  state.roomId = roomId;
  state.idleSince = null;

  const participants = Array.from(room.keys()).filter((id) => id !== state.clientId);

  sendTo(ws, {
    type: 'joined',
    roomId,
    clientId: state.clientId,
    participants,
    resumeToken: resumeTokenFor(state.clientId),
  });

  broadcast(roomId, { type: 'peer-joined', clientId: state.clientId }, state.clientId);

  logDebug(`Client ${state.clientId} joined room ${roomId}. Total participants: ${room.size}`);
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
  if (!targetClient || targetClient.readyState !== WebSocket.OPEN) {
    return;
  }
  if (targetClient.bufferedAmount > MAX_BUFFERED_BYTES) {
    // Drop rather than close: the sender is another room member, and closing
    // here would hand any member a way to disconnect a peer on a slow link.
    // Genuinely stuck sockets are still closed by sendTo/broadcast.
    return;
  }
  // senderId is always set server-side so clients cannot spoof it
  targetClient.send(JSON.stringify({ ...data, senderId: state.clientId }));
}

function handleLeave(state) {
  const { roomId, clientId, ws } = state;
  if (!roomId) {
    return;
  }

  state.roomId = null;
  state.idleSince = Date.now();
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
    logDebug(`Room ${roomId} deleted (empty)`);
  }

  logDebug(`Client ${clientId} left room ${roomId}`);
}

function handleUpgrade(req, socket, head) {
  socket.on('error', () => { /* a half-open socket must not throw */ });
  if (!originAllowed(req)) {
    logWarn(`Rejected WebSocket upgrade from origin: ${req.headers.origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

server.on('upgrade', handleUpgrade);

wss.on('connection', (ws, req) => {
  // Install this before anything that can return early. An 'error' emitted on
  // a socket with no listener is an uncaught exception, and a rejected client
  // can still feed the frame parser — one host could otherwise take the whole
  // server down by sending a malformed frame after being turned away.
  ws.on('error', (error) => {
    const id = ws.state ? ws.state.clientId : 'unidentified';
    logWarn(`WebSocket error (${id}):`, error.message);
  });

  // Rejections terminate rather than close: a graceful close leaves the socket
  // alive for up to 30s, which is long enough to park sockets against the
  // global cap without ever counting against the per-IP one.
  if (wss.clients.size > MAX_CONNECTIONS) {
    ws.terminate();
    return;
  }

  const ip = clientIpFrom(req);
  const perIp = (connectionsByIp.get(ip) || 0) + 1;
  if (perIp > MAX_CONNECTIONS_PER_IP) {
    logWarn(`Connection limit reached for ${ip}`);
    ws.terminate();
    return;
  }
  connectionsByIp.set(ip, perIp);

  const state = {
    ws,
    ip,
    clientId: crypto.randomUUID(),
    roomId: null,
    // Timestamp since which this socket has held no room; null while in one.
    idleSince: Date.now(),
    connectedAt: Date.now(),
  };
  ws.state = state;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const bucket = { tokens: RATE_LIMIT_PER_SECOND, updatedAt: Date.now() };
  let rateViolations = 0;

  logDebug(`Client connected: ${state.clientId}`);

  ws.on('message', (message) => {
    if (!takeToken(bucket, RATE_LIMIT_PER_SECOND, RATE_LIMIT_PER_SECOND)) {
      rateViolations += 1;
      if (rateViolations > RATE_LIMIT_CLOSE_AFTER) {
        ws.close(1008, 'Rate limit exceeded');
      }
      return;
    }
    rateViolations = 0;

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
        // otherwise fall back to a fresh identity. handleJoin performs the
        // switch itself, once it knows the join will be accepted.
        const identity = verifyResumeToken(data.clientId, data.resumeToken)
          ? data.clientId
          : null;
        handleJoin(ws, state, data.roomId, identity);
      } else if (SIGNALING_TYPES.has(data.type)) {
        handleSignaling(state, data);
      } else if (data.type === 'leave') {
        handleLeave(state);
      }
      // Unknown message types are dropped silently.
    } catch (error) {
      logError('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    const remaining = (connectionsByIp.get(ip) || 1) - 1;
    if (remaining > 0) {
      connectionsByIp.set(ip, remaining);
    } else {
      connectionsByIp.delete(ip);
    }
    logDebug(`Client disconnected: ${state.clientId}`);
    handleLeave(state);
  });
});

// Drops room entries whose socket is gone. handleLeave covers the normal
// paths; this is the safety net for anything that slipped through.
function reapDeadEntries() {
  rooms.forEach((room, roomId) => {
    room.forEach((client, clientId) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        return;
      }
      room.delete(clientId);
      broadcast(roomId, { type: 'peer-left', clientId }, clientId);
    });
    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });
}

// Terminate connections that stop answering pings so dead sockets do not
// linger inside rooms (mobile clients drop without a close frame all the time).
const heartbeat = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    const state = ws.state;
    if (state && state.idleSince && now - state.idleSince > IDLE_TIMEOUT_MS) {
      ws.close(1000, 'Idle');
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });

  reapDeadEntries();

  joinsByIp.forEach((entry, ip) => {
    if (now - entry.windowStart >= 120000) {
      joinsByIp.delete(ip);
    }
  });
}, HEARTBEAT_INTERVAL_MS);
// Never let the heartbeat alone hold the event loop open — otherwise merely
// requiring this module keeps a process alive forever.
heartbeat.unref();

wss.on('close', () => {
  clearInterval(heartbeat);
});

function stop() {
  clearInterval(heartbeat);
  server.removeListener('upgrade', handleUpgrade);
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
  // A client that never answers the close frame would otherwise hold the
  // shutdown for ws's full 30s close timeout.
  const forceClose = setTimeout(() => {
    wss.clients.forEach((ws) => ws.terminate());
  }, 1000);
  forceClose.unref();
  return new Promise((resolve) => {
    wss.close(() => {
      clearTimeout(forceClose);
      server.close(() => resolve());
    });
  });
}

function shutdown(signal) {
  logInfo(`${signal} received, shutting down gracefully`);
  stop().then(() => process.exit(0));
  // Force exit if connections refuse to drain
  setTimeout(() => process.exit(1), 5000).unref();
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, '0.0.0.0', () => {
    logInfo(`Calling service running on port ${PORT}`);
    logInfo(`Health check: http://localhost:${PORT}/health`);
  });
}

module.exports = {
  app,
  server,
  wss,
  rooms,
  stop,
  __testing: {
    normalizeCloudflareResponse,
    resetCloudflareCache(keepEntry) {
      if (!keepEntry) cloudflareTurn.entries = null;
      cloudflareTurn.expiresAt = 0;
      cloudflareTurn.failedUntil = 0;
      cloudflareTurn.inflight = null;
    },
  },
  config: {
    MAX_PARTICIPANTS,
    MAX_ROOMS,
    MAX_CONNECTIONS,
    MAX_CONNECTIONS_PER_IP,
    MAX_ROOMS_PER_IP_PER_MINUTE,
    MAX_MESSAGE_BYTES,
    RATE_LIMIT_PER_SECOND,
  },
};
