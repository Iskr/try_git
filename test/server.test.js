// The whole suite shares one source IP, so the per-IP room-probe throttle
// would fire on the sheer number of distinct rooms used here. It is exercised
// on purpose in test/limits.test.js, which runs in its own process.
process.env.MAX_ROOMS_PER_IP_PER_MINUTE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { server, rooms, stop } = require('../server');

let baseUrl;
let wsUrl;
let maxParticipants;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
  const config = await (await fetch(`${baseUrl}/config`)).json();
  maxParticipants = config.maxParticipants;
});

after(async () => {
  await stop();
});

function connect(options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, options);
    const messages = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const waiterIndex = waiters.findIndex((w) => w.match(msg));
      if (waiterIndex !== -1) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        messages.push(msg);
      }
    });
    ws.on('open', () => resolve({ ws, messages, waiters }));
    ws.on('error', reject);
  });
}

function send(client, obj) {
  client.ws.send(JSON.stringify(obj));
}

function nextMessage(client, type, timeoutMs = 3000) {
  const match = (msg) => msg.type === type;
  const buffered = client.messages.findIndex(match);
  if (buffered !== -1) {
    return Promise.resolve(client.messages.splice(buffered, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${type}"`)),
      timeoutMs
    );
    client.waiters.push({ match, resolve, timer });
  });
}

function join(client, roomId) {
  send(client, { type: 'join', roomId });
  return nextMessage(client, 'joined');
}

// Waiting on a close with no deadline turns "the guard regressed" into a hung
// suite rather than a failure.
function closed(client, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the connection to close')), timeoutMs);
    client.ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('GET /health reports ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
});

test('GET /config returns ICE servers and participant limit', async () => {
  const res = await fetch(`${baseUrl}/config`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.iceServers));
  assert.ok(body.iceServers.length >= 1);
  assert.ok(Number.isInteger(body.maxParticipants));
});

test('GET /config is never cached — it may carry TURN credentials', async () => {
  const res = await fetch(`${baseUrl}/config`);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
});

test('/config issues ephemeral TURN credentials when a static auth secret is set', async () => {
  process.env.TURN_SERVER_URL = 'turn:turn.example:3478';
  process.env.TURN_STATIC_AUTH_SECRET = 'test-secret';
  try {
    const body = await (await fetch(`${baseUrl}/config`)).json();
    const turn = body.iceServers.find((s) => String(s.urls).includes('turn:'));
    assert.ok(turn, 'TURN server should be advertised');
    const [expiry] = turn.username.split(':');
    assert.ok(Number(expiry) > Math.floor(Date.now() / 1000), 'username encodes a future expiry');
    assert.ok(turn.credential.length > 0);
    assert.notStrictEqual(turn.credential, 'test-secret');
  } finally {
    delete process.env.TURN_SERVER_URL;
    delete process.env.TURN_STATIC_AUTH_SECRET;
  }
});

test('responses carry security headers', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'self'"));
  // Bare ws:/wss: scheme sources would allow exfiltration to any host
  assert.ok(!/connect-src[^;]*\swss:(\s|;|$)/.test(csp), `connect-src too broad: ${csp}`);
  assert.ok(csp.includes(`wss://127.0.0.1`));
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('static assets are revalidated so a deploy cannot leave a stale client', async () => {
  const res = await fetch(`${baseUrl}/app.js`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('cache-control'), 'no-cache');
  assert.ok(res.headers.get('etag'), 'ETag is what makes no-cache cheap');
});

test('join with a valid room id succeeds and returns a resume token', async () => {
  const client = await connect();
  const joined = await join(client, 'ABC123');
  assert.strictEqual(joined.roomId, 'ABC123');
  assert.ok(typeof joined.clientId === 'string' && joined.clientId.length > 0);
  assert.deepStrictEqual(joined.participants, []);
  assert.ok(typeof joined.resumeToken === 'string' && joined.resumeToken.length === 64);
  client.ws.close();
});

test('room ids are normalized to upper case', async () => {
  const client = await connect();
  const joined = await join(client, 'abc999');
  assert.strictEqual(joined.roomId, 'ABC999');
  client.ws.close();
});

test('invalid room ids are rejected', async () => {
  const client = await connect();
  for (const bad of ['ABC12', 'TOOLONG1', 'ABC!12', '', 42, null]) {
    send(client, { type: 'join', roomId: bad });
    const err = await nextMessage(client, 'error');
    assert.strictEqual(err.code, 'invalid-room');
  }
  client.ws.close();
});

test('malformed JSON gets an error instead of crashing the server', async () => {
  const client = await connect();
  client.ws.send('this is not json');
  const err = await nextMessage(client, 'error');
  assert.strictEqual(err.code, 'bad-message');
  // Server still works afterwards
  const joined = await join(client, 'STILL1');
  assert.strictEqual(joined.roomId, 'STILL1');
  client.ws.close();
});

test('second participant is announced and listed', async () => {
  const a = await connect();
  const b = await connect();
  const joinedA = await join(a, 'ROOM01');
  const joinedB = await join(b, 'ROOM01');

  assert.deepStrictEqual(joinedB.participants, [joinedA.clientId]);
  const peerJoined = await nextMessage(a, 'peer-joined');
  assert.strictEqual(peerJoined.clientId, joinedB.clientId);

  a.ws.close();
  b.ws.close();
});

test('re-joining the room you already occupy does not re-announce you to peers', async () => {
  // Peers treat peer-joined for a known id as "reconnected" and tear their
  // session down, so a member could otherwise force endless renegotiation.
  const a = await connect();
  const b = await connect();
  await join(a, 'IDEM01');
  const joinedB = await join(b, 'IDEM01');
  await nextMessage(a, 'peer-joined');

  const second = await join(b, 'IDEM01');
  assert.strictEqual(second.clientId, joinedB.clientId);
  assert.deepStrictEqual(second.participants.length, 1);

  await settle();
  assert.strictEqual(a.messages.filter((m) => m.type === 'peer-joined').length, 0);

  a.ws.close();
  b.ws.close();
});

test('signaling is relayed only to the target with a server-set senderId', async () => {
  const a = await connect();
  const b = await connect();
  const c = await connect();
  const joinedA = await join(a, 'ROOM02');
  const joinedB = await join(b, 'ROOM02');
  await join(c, 'ROOM02');

  // A tries to spoof senderId — the server must overwrite it
  send(a, { type: 'offer', offer: { sdp: 'x' }, targetId: joinedB.clientId, senderId: 'spoofed' });
  const offer = await nextMessage(b, 'offer');
  assert.strictEqual(offer.senderId, joinedA.clientId);
  assert.deepStrictEqual(offer.offer, { sdp: 'x' });

  // C must not have received the offer
  assert.strictEqual(c.messages.filter((m) => m.type === 'offer').length, 0);

  a.ws.close();
  b.ws.close();
  c.ws.close();
});

test('signaling to clients in other rooms is not possible', async () => {
  const a = await connect();
  const b = await connect();
  await join(a, 'ROOM03');
  const joinedB = await join(b, 'ROOM04');

  send(a, { type: 'offer', offer: {}, targetId: joinedB.clientId });
  await settle();
  assert.strictEqual(b.messages.filter((m) => m.type === 'offer').length, 0);

  a.ws.close();
  b.ws.close();
});

test('signaling before joining any room is dropped', async () => {
  const a = await connect();
  const b = await connect();
  const joinedB = await join(b, 'NOJOIN');

  send(a, { type: 'offer', offer: {}, targetId: joinedB.clientId });
  await settle();
  assert.strictEqual(b.messages.filter((m) => m.type === 'offer').length, 0);

  // ...and the connection is still usable
  const joined = await join(a, 'NOJOIN');
  assert.strictEqual(joined.roomId, 'NOJOIN');

  a.ws.close();
  b.ws.close();
});

test('a client cannot relay signaling to itself', async () => {
  const a = await connect();
  const joinedA = await join(a, 'SELF01');
  send(a, { type: 'offer', offer: {}, targetId: joinedA.clientId });
  await settle();
  assert.strictEqual(a.messages.filter((m) => m.type === 'offer').length, 0);
  a.ws.close();
});

test('room is limited to MAX_PARTICIPANTS and a leave frees the slot', async () => {
  const clients = [];
  for (let i = 0; i < maxParticipants; i++) {
    const client = await connect();
    await join(client, 'FULL01');
    clients.push(client);
  }

  const extra = await connect();
  send(extra, { type: 'join', roomId: 'FULL01' });
  const full = await nextMessage(extra, 'room-full');
  assert.strictEqual(full.roomId, 'FULL01');
  assert.strictEqual(full.maxParticipants, maxParticipants);

  // Freeing a seat lets the waiting client in
  clients.pop().ws.close();
  await settle();
  const joined = await join(extra, 'FULL01');
  assert.strictEqual(joined.roomId, 'FULL01');

  clients.forEach((c) => c.ws.close());
  extra.ws.close();
});

test('leave notifies peers and empties the room', async () => {
  const a = await connect();
  const b = await connect();
  const joinedA = await join(a, 'ROOM05');
  await join(b, 'ROOM05');
  await nextMessage(a, 'peer-joined');

  send(a, { type: 'leave' });
  const left = await nextMessage(b, 'peer-left');
  assert.strictEqual(left.clientId, joinedA.clientId);

  b.ws.close();
  a.ws.close();
  // Room cleanup happens after the close frame is processed
  await settle();
  assert.strictEqual(rooms.has('ROOM05'), false);
});

test('disconnect notifies peers', async () => {
  const a = await connect();
  const b = await connect();
  const joinedA = await join(a, 'ROOM06');
  await join(b, 'ROOM06');

  a.ws.close();
  const left = await nextMessage(b, 'peer-left');
  assert.strictEqual(left.clientId, joinedA.clientId);
  b.ws.close();
});

test('rejoin with a valid resume token keeps the clientId', async () => {
  const a = await connect();
  const joinedA = await join(a, 'ROOM07');
  a.ws.close();
  await settle(100);

  const b = await connect();
  send(b, {
    type: 'rejoin',
    roomId: 'ROOM07',
    clientId: joinedA.clientId,
    resumeToken: joinedA.resumeToken,
  });
  const rejoined = await nextMessage(b, 'joined');
  assert.strictEqual(rejoined.clientId, joinedA.clientId);
  b.ws.close();
});

test('rejoin with a forged resume token gets a fresh identity', async () => {
  const a = await connect();
  const joinedA = await join(a, 'ROOM08');

  const b = await connect();
  send(b, {
    type: 'rejoin',
    roomId: 'ROOM08',
    clientId: joinedA.clientId,
    resumeToken: 'f'.repeat(64),
  });
  const joinedB = await nextMessage(b, 'joined');
  assert.notStrictEqual(joinedB.clientId, joinedA.clientId);

  a.ws.close();
  b.ws.close();
});

test('switching identity via rejoin while in a room does not orphan the old entry', async () => {
  // Resume tokens are unexpiring HMACs handed to every client, so a member can
  // obtain a token for a second identity and rejoin under it. If the seat held
  // by the first identity is not vacated, the room keeps a dead entry forever:
  // the slot is burned and the room is never garbage-collected.
  const donor = await connect();
  const donated = await join(donor, 'DONOR1');
  donor.ws.close();
  await settle(100);

  const client = await connect();
  await join(client, 'SWAP01');
  send(client, {
    type: 'rejoin',
    roomId: 'SWAP01',
    clientId: donated.clientId,
    resumeToken: donated.resumeToken,
  });
  const rejoined = await nextMessage(client, 'joined');
  assert.strictEqual(rejoined.clientId, donated.clientId);
  assert.strictEqual(rooms.get('SWAP01').size, 1, 'the abandoned identity must be gone');

  client.ws.close();
  await settle();
  assert.strictEqual(rooms.has('SWAP01'), false, 'room must be collected once empty');
});

test('a rejoin that cannot be granted leaves the caller in the room it was in', async () => {
  // Vacating the seat before validating the target room would eject a client
  // from a working call on a typo — peers get peer-left, and everything the
  // client signals afterwards is silently discarded by the server.
  const donor = await connect();
  const donated = await join(donor, 'DONOR3');
  donor.ws.close();
  await settle(100);

  const a = await connect();
  const b = await connect();
  const joinedA = await join(a, 'EVICT1');
  const joinedB = await join(b, 'EVICT1');
  await nextMessage(a, 'peer-joined');

  send(a, {
    type: 'rejoin',
    roomId: 'not-a-room',
    clientId: donated.clientId,
    resumeToken: donated.resumeToken,
  });
  const err = await nextMessage(a, 'error');
  assert.strictEqual(err.code, 'invalid-room');

  await settle();
  assert.ok(rooms.get('EVICT1').has(joinedA.clientId), 'the caller keeps its seat');
  assert.strictEqual(b.messages.filter((m) => m.type === 'peer-left').length, 0);

  // ...and its signaling still reaches the room
  send(a, { type: 'offer', offer: { sdp: 'x' }, targetId: joinedB.clientId });
  const offer = await nextMessage(b, 'offer');
  assert.strictEqual(offer.senderId, joinedA.clientId);

  a.ws.close();
  b.ws.close();
});

test('a rejoin into a full room does not cost the caller its current seat', async () => {
  const donor = await connect();
  const donated = await join(donor, 'DONOR4');
  donor.ws.close();
  await settle(100);

  const occupants = [];
  for (let i = 0; i < maxParticipants; i++) {
    const client = await connect();
    await join(client, 'FULL02');
    occupants.push(client);
  }

  const a = await connect();
  const joinedA = await join(a, 'KEEP01');
  send(a, {
    type: 'rejoin',
    roomId: 'FULL02',
    clientId: donated.clientId,
    resumeToken: donated.resumeToken,
  });
  const full = await nextMessage(a, 'room-full');
  assert.strictEqual(full.roomId, 'FULL02');

  await settle();
  assert.ok(rooms.get('KEEP01').has(joinedA.clientId), 'the caller keeps its seat');

  occupants.forEach((c) => c.ws.close());
  a.ws.close();
});

test('peers are told when a member abandons its identity mid-call', async () => {
  const donor = await connect();
  const donated = await join(donor, 'DONOR2');
  donor.ws.close();
  await settle(100);

  const a = await connect();
  const b = await connect();
  const joinedA = await join(a, 'SWAP02');
  await join(b, 'SWAP02');
  await nextMessage(a, 'peer-joined');

  send(a, {
    type: 'rejoin',
    roomId: 'SWAP02',
    clientId: donated.clientId,
    resumeToken: donated.resumeToken,
  });

  const left = await nextMessage(b, 'peer-left');
  assert.strictEqual(left.clientId, joinedA.clientId);
  const rejoinedAnnounce = await nextMessage(b, 'peer-joined');
  assert.strictEqual(rejoinedAnnounce.clientId, donated.clientId);

  a.ws.close();
  b.ws.close();
});

test('application-level ping gets a pong', async () => {
  const client = await connect();
  send(client, { type: 'ping' });
  await nextMessage(client, 'pong');
  client.ws.close();
});

test('unknown message types are ignored without breaking the connection', async () => {
  const client = await connect();
  send(client, { type: 'encryption-key', keyData: [1, 2, 3], targetId: 'x' });
  send(client, { type: 'whatever' });
  const joined = await join(client, 'ROOM09');
  assert.strictEqual(joined.roomId, 'ROOM09');
  client.ws.close();
});

test('message flood closes the connection with a policy-violation code', async () => {
  const client = await connect();
  const code = closed(client);
  for (let i = 0; i < 400; i++) {
    send(client, { type: 'ping' });
  }
  assert.strictEqual(await code, 1008);
});

test('oversize frames are rejected by the server', async () => {
  const client = await connect();
  const code = closed(client);
  client.ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(128 * 1024) }));
  assert.strictEqual(await code, 1009);
});

test('WebSocket upgrades from a foreign origin are refused', async () => {
  // The server writes 403 and destroys the socket, so the client may surface
  // either the status line or a reset depending on timing.
  await assert.rejects(
    () => connect({ origin: 'https://evil.example' }),
    /403|Unexpected server response|ECONNRESET|socket hang up/
  );
});

test('WebSocket upgrades from the page origin are accepted', async () => {
  const { port } = server.address();
  const client = await connect({ origin: `http://127.0.0.1:${port}` });
  const joined = await join(client, 'ORIG01');
  assert.strictEqual(joined.roomId, 'ORIG01');
  client.ws.close();
});
