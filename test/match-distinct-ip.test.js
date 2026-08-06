// The distinct-IP rule is read once at require time, so proving it works needs
// a process where it is left on — every other matchmaking test turns it off,
// because all of its clients come from 127.0.0.1.
process.env.MATCH_REQUIRE_DISTINCT_IPS = '1';
process.env.MAX_WAITING_PER_IP = '20';

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
    ws.on('message', (raw) => messages.push(JSON.parse(raw)));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

test('two clients sharing an address are not matched to each other', async () => {
  // Otherwise "call a stranger" would pair someone with their own second tab.
  const a = await connect();
  const b = await connect();
  a.ws.send(JSON.stringify({ type: 'wait', size: 2 }));
  b.ws.send(JSON.stringify({ type: 'wait', size: 2 }));

  await new Promise((r) => setTimeout(r, 500));

  assert.strictEqual(a.messages.filter((m) => m.type === 'joined').length, 0);
  assert.strictEqual(b.messages.filter((m) => m.type === 'joined').length, 0);
  assert.ok(a.messages.some((m) => m.type === 'waiting'), 'both are still queued');

  a.ws.close();
  b.ws.close();
});
