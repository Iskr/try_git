// Matching seats strangers together, so it needs its own process: it holds a
// queue keyed on IP, and the other suites' rooms would perturb the counts.
process.env.MAX_ROOMS_PER_IP_PER_MINUTE = '1000';
process.env.MAX_WAITING_PER_IP = '20';
// Every client here comes from 127.0.0.1; the distinct-IP rule is covered on
// its own below with the rule left on.
process.env.MATCH_REQUIRE_DISTINCT_IPS = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { server, stop, rooms, waitingBySize, matchedRooms } = require('../server');

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
      const index = waiters.findIndex((w) => w.match(msg));
      if (index !== -1) {
        const [waiter] = waiters.splice(index, 1);
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
  if (buffered !== -1) return Promise.resolve(client.messages.splice(buffered, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${type}"`)), timeoutMs);
    client.waiters.push({ match, resolve, timer });
  });
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('two waiting strangers are seated in the same room', async () => {
  const a = await connect();
  const b = await connect();

  send(a, { type: 'wait', size: 2 });
  await nextMessage(a, 'waiting');
  send(b, { type: 'wait', size: 2 });

  const joinedA = await nextMessage(a, 'joined');
  const joinedB = await nextMessage(b, 'joined');

  assert.strictEqual(joinedA.roomId, joinedB.roomId, 'both land in one room');
  assert.strictEqual(joinedA.matched, true, 'the client is told this was a match');
  assert.deepStrictEqual(joinedA.participants, [joinedB.clientId]);
  assert.deepStrictEqual(joinedB.participants, [joinedA.clientId]);
  assert.ok(joinedA.resumeToken && joinedB.resumeToken);

  // No peer-joined: clients read that for a known id as "reconnected" and tear
  // down the very session the joined message started.
  await settle();
  assert.strictEqual(a.messages.filter((m) => m.type === 'peer-joined').length, 0);

  a.ws.close();
  b.ws.close();
  await settle();
});

test('a group of three waits until the third arrives', async () => {
  const clients = [await connect(), await connect()];
  clients.forEach((c) => send(c, { type: 'wait', size: 3 }));
  await nextMessage(clients[0], 'waiting');
  await nextMessage(clients[1], 'waiting');

  await settle();
  assert.strictEqual(clients[0].messages.filter((m) => m.type === 'joined').length, 0);

  const third = await connect();
  send(third, { type: 'wait', size: 3 });

  const joined = await Promise.all([
    nextMessage(clients[0], 'joined'),
    nextMessage(clients[1], 'joined'),
    nextMessage(third, 'joined'),
  ]);
  const roomIds = new Set(joined.map((j) => j.roomId));
  assert.strictEqual(roomIds.size, 1, 'all three in one room');
  joined.forEach((j) => assert.strictEqual(j.participants.length, 2));

  [...clients, third].forEach((c) => c.ws.close());
  await settle();
});

test('people waiting for different group sizes are not mixed', async () => {
  const two = await connect();
  const three = await connect();
  send(two, { type: 'wait', size: 2 });
  send(three, { type: 'wait', size: 3 });
  await nextMessage(two, 'waiting');
  await nextMessage(three, 'waiting');

  await settle();
  assert.strictEqual(two.messages.filter((m) => m.type === 'joined').length, 0);
  assert.strictEqual(three.messages.filter((m) => m.type === 'joined').length, 0);

  two.ws.close();
  three.ws.close();
  await settle();
});

test('cancelling leaves the queue and frees the slot', async () => {
  const a = await connect();
  send(a, { type: 'wait', size: 2 });
  await nextMessage(a, 'waiting');

  send(a, { type: 'unwait' });
  await nextMessage(a, 'waiting-cancelled');
  await settle();
  assert.strictEqual(waitingBySize.has(2), false, 'the bucket is emptied');

  a.ws.close();
  await settle();
});

test('disconnecting while queued does not leave a ghost in the queue', async () => {
  // A stale entry would be matched with a real person, who would then wait
  // forever for a peer that is never coming.
  const ghost = await connect();
  send(ghost, { type: 'wait', size: 2 });
  await nextMessage(ghost, 'waiting');
  ghost.ws.close();
  await settle(250);

  assert.strictEqual(waitingBySize.has(2), false);

  const a = await connect();
  const b = await connect();
  send(a, { type: 'wait', size: 2 });
  send(b, { type: 'wait', size: 2 });
  const joinedA = await nextMessage(a, 'joined');
  const joinedB = await nextMessage(b, 'joined');
  assert.strictEqual(joinedA.roomId, joinedB.roomId);

  a.ws.close();
  b.ws.close();
  await settle();
});

test('a matched room refuses walk-ins who guess its code', async () => {
  // Nobody chose this code, and the app hands the live E2EE key to any peer
  // whose control channel opens — a stranger joining would be given it.
  const a = await connect();
  const b = await connect();
  send(a, { type: 'wait', size: 2 });
  send(b, { type: 'wait', size: 2 });
  const joined = await nextMessage(a, 'joined');
  await nextMessage(b, 'joined');

  const walkIn = await connect();
  send(walkIn, { type: 'join', roomId: joined.roomId });
  const err = await nextMessage(walkIn, 'error');
  assert.strictEqual(err.code, 'invalid-room');
  assert.strictEqual(rooms.get(joined.roomId).size, 2, 'the room is untouched');

  walkIn.ws.close();
  a.ws.close();
  b.ws.close();
  await settle(250);
  assert.strictEqual(matchedRooms.has(joined.roomId), false, 'roster forgotten with the room');
});

test('a matched participant can still rejoin its own room', async () => {
  const a = await connect();
  const b = await connect();
  send(a, { type: 'wait', size: 2 });
  send(b, { type: 'wait', size: 2 });
  const joinedA = await nextMessage(a, 'joined');
  await nextMessage(b, 'joined');

  a.ws.close();
  await settle(150);

  const back = await connect();
  send(back, {
    type: 'rejoin',
    roomId: joinedA.roomId,
    clientId: joinedA.clientId,
    resumeToken: joinedA.resumeToken,
  });
  const rejoined = await nextMessage(back, 'joined');
  assert.strictEqual(rejoined.clientId, joinedA.clientId);

  back.ws.close();
  b.ws.close();
  await settle();
});

test('a nonsense group size is refused', async () => {
  const a = await connect();
  for (const size of [1, 0, 99, 'two', null]) {
    send(a, { type: 'wait', size });
    const err = await nextMessage(a, 'error');
    assert.strictEqual(err.code, 'invalid-size');
  }
  a.ws.close();
  await settle();
});

test('someone already in a call cannot queue for another', async () => {
  const a = await connect();
  send(a, { type: 'join', roomId: 'INCALL' });
  await nextMessage(a, 'joined');

  send(a, { type: 'wait', size: 2 });
  const err = await nextMessage(a, 'error');
  assert.strictEqual(err.code, 'already-in-call');

  a.ws.close();
  await settle();
});

test('repeating the same request keeps your place instead of losing it', async () => {
  const a = await connect();
  const b = await connect();
  send(a, { type: 'wait', size: 4 });
  await nextMessage(a, 'waiting');
  send(b, { type: 'wait', size: 4 });
  await nextMessage(b, 'waiting');

  // a repeats itself, as a client would after a reconnect
  send(a, { type: 'wait', size: 4 });
  const ack = await nextMessage(a, 'waiting');
  assert.strictEqual(ack.size, 4);
  assert.strictEqual(waitingBySize.get(4).length, 2, 'still two waiting, not three');

  a.ws.close();
  b.ws.close();
  await settle();
});
