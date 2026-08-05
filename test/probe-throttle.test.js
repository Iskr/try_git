// The per-IP room-probe throttle counts distinct rooms in a rolling minute,
// so it needs a process (and therefore a file) to itself.
process.env.MAX_ROOMS_PER_IP_PER_MINUTE = '3';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { server, stop } = require('../server');

let wsUrl;

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

test('probing more distinct rooms than allowed is throttled per IP', async () => {
  // Room ids are six characters, so enumeration is only expensive if the
  // number of distinct rooms one source may touch is capped.
  const client = await connect();
  for (const code of ['PRB001', 'PRB002', 'PRB003']) {
    send(client, { type: 'join', roomId: code });
    const joined = await nextMessage(client, 'joined');
    assert.strictEqual(joined.roomId, code);
  }

  send(client, { type: 'join', roomId: 'PRB004' });
  const err = await nextMessage(client, 'error');
  assert.strictEqual(err.code, 'too-many-joins');

  client.ws.close();
});

// The two tests below deliberately run after the one above and depend on the
// budget it consumed: the window is per IP and lasts a minute, and node:test
// runs a file's tests in order.
test('the throttle counts distinct rooms per IP, not per connection', async () => {
  // A second socket from the same source must not reset the budget.
  const client = await connect();
  send(client, { type: 'join', roomId: 'PRB005' });
  const err = await nextMessage(client, 'error');
  assert.strictEqual(err.code, 'too-many-joins');
  client.ws.close();
});

test('rooms already counted in the window stay reachable', async () => {
  const client = await connect();
  send(client, { type: 'join', roomId: 'PRB001' });
  const joined = await nextMessage(client, 'joined');
  assert.strictEqual(joined.roomId, 'PRB001');
  client.ws.close();
});
