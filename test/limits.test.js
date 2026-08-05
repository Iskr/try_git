// Resource limits are read into module-level constants at require time, so
// they can only be exercised in a process with its own environment. node:test
// runs every file in a separate process, which is what makes this work.
process.env.MAX_ROOMS = '2';
process.env.MAX_CONNECTIONS_PER_IP = '4';
// The per-IP probe throttle shares one window across a whole file; it has its
// own file (test/probe-throttle.test.js) so it cannot starve these tests.
process.env.MAX_ROOMS_PER_IP_PER_MINUTE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const { server, stop, config } = require('../server');

let wsUrl;

// Waiting on an event with no deadline turns "the guard regressed" into a
// hung suite instead of a failure.
function withTimeout(promise, what, ms = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms)),
  ]);
}

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  wsUrl = `ws://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await stop();
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

test('config reflects the environment', () => {
  assert.strictEqual(config.MAX_ROOMS, 2);
  assert.strictEqual(config.MAX_CONNECTIONS_PER_IP, 4);
});

test('creating more rooms than MAX_ROOMS reports server-busy', async () => {
  const a = await connect();
  const b = await connect();
  const c = await connect();

  send(a, { type: 'join', roomId: 'CAP001' });
  await nextMessage(a, 'joined');
  send(b, { type: 'join', roomId: 'CAP002' });
  await nextMessage(b, 'joined');

  send(c, { type: 'join', roomId: 'CAP003' });
  const err = await nextMessage(c, 'error');
  assert.strictEqual(err.code, 'server-busy');

  // An existing room still accepts members while the cap is hit
  send(c, { type: 'join', roomId: 'CAP001' });
  const joined = await nextMessage(c, 'joined');
  assert.strictEqual(joined.roomId, 'CAP001');

  [a, b, c].forEach((client) => client.ws.close());
});

test('a single IP cannot hold more than MAX_CONNECTIONS_PER_IP sockets', async () => {
  const clients = [];
  for (let i = 0; i < config.MAX_CONNECTIONS_PER_IP; i++) {
    clients.push(await connect());
  }
  // The ones inside the cap must survive — a server that rejected everything
  // would otherwise satisfy the assertion below.
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(
    clients.every((c) => c.ws.readyState === WebSocket.OPEN),
    'connections within the cap must stay open'
  );

  const extra = await connect();
  const closed = new Promise((resolve) => extra.ws.on('close', resolve));
  await withTimeout(closed, 'the socket over the cap is dropped');

  clients.forEach((client) => client.ws.close());
});

test('a rejected connection cannot take the server down with a bad frame', async () => {
  // The rejection path returns early from the 'connection' handler; if the
  // 'error' listener is not installed before that, a protocol-illegal frame
  // from the rejected socket becomes an uncaught exception and the process
  // dies — a whole-service DoS from one host.
  const clients = [];
  for (let i = 0; i < config.MAX_CONNECTIONS_PER_IP; i++) {
    clients.push(await connect());
  }

  const { port } = server.address();
  const raw = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => raw.on('connect', resolve));
  const key = crypto.randomBytes(16).toString('base64');
  raw.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
  raw.on('error', () => { /* the server may reset us */ });
  await new Promise((resolve) => {
    raw.once('data', resolve);
    raw.once('close', resolve);
    setTimeout(resolve, 500);
  });
  // Unmasked client frame — illegal, and what makes ws emit 'error'
  raw.write(Buffer.from([0x81, 0x01, 0x41]));
  await new Promise((r) => setTimeout(r, 300));
  raw.destroy();

  // Still serving?
  const survivor = await connect();
  send(survivor, { type: 'ping' });
  await nextMessage(survivor, 'pong');
  survivor.ws.close();

  clients.forEach((client) => client.ws.close());
});
