const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { server, rooms } = require('../server');

let baseUrl;
let wsUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  // ws keeps the process alive via open handles; force-exit timers
  setImmediate(() => process.exit(0)).unref?.();
});

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
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

test('responses carry security headers', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
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
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(b.messages.filter((m) => m.type === 'offer').length, 0);

  a.ws.close();
  b.ws.close();
});

test('room is limited to MAX_PARTICIPANTS', async () => {
  const clients = [];
  for (let i = 0; i < 5; i++) {
    const client = await connect();
    await join(client, 'FULL01');
    clients.push(client);
  }

  const extra = await connect();
  send(extra, { type: 'join', roomId: 'FULL01' });
  const full = await nextMessage(extra, 'room-full');
  assert.strictEqual(full.roomId, 'FULL01');

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
  await new Promise((r) => setTimeout(r, 200));
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
  await new Promise((r) => setTimeout(r, 100));

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

test('message flood closes the connection', async () => {
  const client = await connect();
  const closed = new Promise((resolve) => client.ws.on('close', resolve));
  for (let i = 0; i < 400; i++) {
    send(client, { type: 'ping' });
  }
  await closed;
});
