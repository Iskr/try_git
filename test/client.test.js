const { test, after } = require('node:test');
const assert = require('node:assert');

const { createBrowser, joinedApp, fakeStream, closeAll } = require('./helpers/browser-env');

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// Each app arms a heartbeat and reconnect timers; without this the process
// idles for ~20s after the last assertion waiting for them to drain.
after(() => closeAll());

test('a missing camera falls back to an audio-only call instead of refusing to join', async () => {
  const env = createBrowser({
    getUserMedia: async (constraints) => {
      if (constraints.video) {
        const error = new Error('no camera');
        error.name = 'NotFoundError';
        throw error;
      }
      return fakeStream(['audio']);
    },
  });

  const { app } = await joinedApp(env);

  assert.ok(app.localStream, 'the call must still start');
  assert.strictEqual(app.localStream.getVideoTracks().length, 0);
  assert.strictEqual(app.localStream.getAudioTracks().length, 1);
  assert.strictEqual(app.roomId, 'ROOM01');
});

test('a denied permission ends the call and says what to do about it', async () => {
  const env = createBrowser({
    getUserMedia: async () => {
      const error = new Error('denied');
      error.name = 'NotAllowedError';
      throw error;
    },
  });

  const { app } = await joinedApp(env);

  assert.strictEqual(app.localStream, null);
  assert.strictEqual(app.roomId, null, 'a call we cannot join must not stay open');
  assert.match(env.document.getElementById('toast').textContent, /разрешите/i);
  // The audio-only retry must not run for a refusal — it would prompt again
  assert.strictEqual(env.media.calls.length, 1);
});

test('concurrent media requests capture the device once', async () => {
  // Two captures would orphan one stream: its tracks stay live after the call
  // ends and ignore the mute button.
  let resolveCapture;
  const env = createBrowser({
    getUserMedia: () => new Promise((resolve) => { resolveCapture = () => resolve(fakeStream(['audio', 'video'])); }),
  });

  const app = new env.CallingApp();
  const first = app.acquireLocalMedia();
  const second = app.acquireLocalMedia();
  resolveCapture();
  const [a, b] = await Promise.all([first, second]);

  assert.strictEqual(env.media.calls.length, 1);
  assert.strictEqual(a, b);
  assert.strictEqual(app.localStream, a);
});

test('a denied prompt does not poison later attempts', async () => {
  let attempt = 0;
  const env = createBrowser({
    getUserMedia: async () => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('denied');
        error.name = 'NotAllowedError';
        throw error;
      }
      return fakeStream(['audio', 'video']);
    },
  });

  const app = new env.CallingApp();
  await assert.rejects(() => app.acquireLocalMedia());
  const stream = await app.acquireLocalMedia();
  assert.ok(stream.getVideoTracks().length === 1);
});

test('a capture that lands after hang-up does not leave the camera running', async () => {
  // The permission prompt can outlive the call. Adopting the stream then
  // would put a live camera behind the home screen with nothing explaining it.
  let releaseCapture;
  const env = createBrowser({
    getUserMedia: () => new Promise((resolve) => { releaseCapture = () => resolve(fakeStream(['audio', 'video'])); }),
  });

  const app = new env.CallingApp();
  const pending = app.acquireLocalMedia();
  app.endCall();
  releaseCapture();
  await pending.catch(() => {});
  await tick();

  assert.strictEqual(app.localStream, null, 'the abandoned stream must not become current');
  const captured = await pending;
  assert.ok(
    captured.getTracks().every((t) => t.readyState === 'ended'),
    'and its tracks must be stopped'
  );
});

test('a throttled rejoin is retried instead of ending the call', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });

  socket.close();
  await tick();
  env.window.dispatchEvent(new env.window.Event('online'));
  await tick();
  const reconnected = env.lastSocket();
  reconnected.open();

  reconnected.deliver({ type: 'error', code: 'too-many-joins', text: 'Слишком много попыток.' });
  await tick();

  assert.strictEqual(app.roomId, 'ROOM01', 'a transient throttle must not end the call');
  assert.strictEqual(
    env.document.getElementById('call-screen').classList.contains('active'),
    true
  );
});

test('an impolite peer re-asserts its offer on collision so the pair cannot deadlock', async () => {
  // The impolite peer is also the designated offerer. If its offer was the one
  // that went missing, staying silent when the other side offers would strand
  // both of them.
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });

  await app.createOffer('zzzz');
  const mine = socket.sent.filter((m) => m.type === 'offer').pop();

  socket.deliver({
    type: 'offer',
    senderId: 'zzzz',
    offer: { type: 'offer', sdp: 'theirs' },
    sessionId: 'zzzz:1',
  });
  await tick();

  const offers = socket.sent.filter((m) => m.type === 'offer');
  assert.strictEqual(offers.length, 2, 'our offer is sent again');
  assert.strictEqual(offers[1].sessionId, mine.sessionId);
  assert.strictEqual(
    socket.sent.filter((m) => m.type === 'answer').length,
    0,
    'and we do not answer — we are the offerer'
  );
});

test('a peer that cannot encrypt does not win the rekey election', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'mmmm' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'aaaa');

  await app.handleRemoteEncryptionKey('aaaa', keyOf(4), 'aaaa', 1);
  // 'aaaa' has the lowest id but reports it cannot encrypt
  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-unsupported' }));
  outbox.length = 0;

  app.handlePeerLeft('zzzz');
  await tick();

  const rekey = outbox.filter((m) => m.kind === 'e2ee-key').pop();
  assert.ok(rekey, 'we take over the rotation instead');
  assert.strictEqual(rekey.owner, 'mmmm');
});

test('exactly one side of a pair offers', async () => {
  const env = createBrowser();
  const app = new env.CallingApp();

  app.clientId = 'aaaa';
  assert.strictEqual(app._shouldOffer('bbbb'), true);
  app.clientId = 'bbbb';
  assert.strictEqual(app._shouldOffer('aaaa'), false);
});

test('the designated offerer offers on peer-joined and the other side waits', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });

  socket.deliver({ type: 'peer-joined', clientId: 'zzzz' });
  await tick();
  assert.strictEqual(socket.sent.filter((m) => m.type === 'offer').length, 1);

  const other = createBrowser();
  const second = await joinedApp(other, { clientId: 'zzzz' });
  second.socket.deliver({ type: 'peer-joined', clientId: 'aaaa' });
  await tick();
  assert.strictEqual(second.socket.sent.filter((m) => m.type === 'offer').length, 0);
});

test('a peer announced during the permission prompt still gets an offer with media', async () => {
  // peer-joined can land while our own capture is still pending; offering
  // then must wait for the stream rather than build a track-less connection.
  let releaseCapture;
  const env = createBrowser({
    getUserMedia: () => new Promise((resolve) => { releaseCapture = () => resolve(fakeStream(['audio', 'video'])); }),
  });

  const app = new env.CallingApp();
  const socket = env.lastSocket();
  socket.open();
  app.joinRoom('ROOM01');
  socket.deliver({
    type: 'joined',
    roomId: 'ROOM01',
    clientId: 'aaaa',
    participants: [],
    resumeToken: 'a'.repeat(64),
  });
  await tick();

  socket.deliver({ type: 'peer-joined', clientId: 'zzzz' });
  await tick();
  assert.strictEqual(socket.sent.filter((m) => m.type === 'offer').length, 0, 'no offer before media');

  releaseCapture();
  await tick(50);

  assert.strictEqual(socket.sent.filter((m) => m.type === 'offer').length, 1);
  assert.ok(app.peerConnections.get('zzzz').senders.length > 0, 'the offer must carry local tracks');
});

test('an answer produced for a session we have replaced is ignored', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });

  await app.createOffer('zzzz');
  const stale = socket.sent.filter((m) => m.type === 'offer').pop();
  assert.ok(stale.sessionId, 'offers must carry a session id');

  // The peer reconnects: the old connection is torn down and replaced
  socket.deliver({ type: 'peer-joined', clientId: 'zzzz' });
  await tick();
  const current = app.peerConnections.get('zzzz');

  socket.deliver({
    type: 'answer',
    senderId: 'zzzz',
    answer: { type: 'answer', sdp: 'stale' },
    sessionId: stale.sessionId,
  });
  await tick();

  assert.strictEqual(
    current.remoteDescriptionsApplied.length,
    0,
    'the replacement connection must not accept the dead session\'s answer'
  );
});

test('an answer for the live session is applied', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });

  await app.createOffer('zzzz');
  const offer = socket.sent.filter((m) => m.type === 'offer').pop();
  socket.deliver({
    type: 'answer',
    senderId: 'zzzz',
    answer: { type: 'answer', sdp: 'fresh' },
    sessionId: offer.sessionId,
  });
  await tick();

  assert.strictEqual(app.peerConnections.get('zzzz').remoteDescriptionsApplied.length, 1);
});

test('ICE candidates that arrive before the connection exists are kept', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });

  socket.deliver({
    type: 'ice-candidate',
    senderId: 'unknown-peer',
    candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host' },
  });
  await tick();

  assert.strictEqual(app.pendingIceCandidates.get('unknown-peer').length, 1);
});

test('the candidate buffer for a peer that never offers is bounded', async () => {
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });

  for (let i = 0; i < 500; i++) {
    await app.handleIceCandidate({
      senderId: 'flooder',
      candidate: { candidate: `candidate:${i}` },
    });
  }

  assert.ok(app.pendingIceCandidates.get('flooder').length <= 60);
});

test('buffered candidates are applied once the offer arrives', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'zzzz' });

  socket.deliver({
    type: 'ice-candidate',
    senderId: 'aaaa',
    candidate: { candidate: 'candidate:early' },
  });
  await tick();
  socket.deliver({
    type: 'offer',
    senderId: 'aaaa',
    offer: { type: 'offer', sdp: 'x' },
    sessionId: 'aaaa:1',
  });
  await tick();

  const pc = app.peerConnections.get('aaaa');
  assert.strictEqual(pc.addedCandidates.length, 1);
  assert.strictEqual(app.pendingIceCandidates.has('aaaa'), false);
});

test('losing our seat during a rejoin ends the call instead of freezing it', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });
  assert.strictEqual(app.roomId, 'ROOM01');

  // The socket drops and the network comes back; the server has meanwhile
  // given our seat away.
  socket.close();
  await tick();
  env.window.dispatchEvent(new env.window.Event('online'));
  await tick();
  const reconnected = env.lastSocket();
  reconnected.open();
  assert.ok(reconnected.sent.some((m) => m.type === 'rejoin'));

  reconnected.deliver({ type: 'room-full', roomId: 'ROOM01', maxParticipants: 5 });
  await tick();

  assert.strictEqual(app.roomId, null);
  assert.strictEqual(env.document.getElementById('call-screen').classList.contains('active'), false);
});

test('an unrelated mid-call error does not end the call', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });

  socket.deliver({ type: 'error', code: 'bad-message', text: 'nope' });
  await tick();

  assert.strictEqual(app.roomId, 'ROOM01', 'only a failed rejoin is fatal');
});

test('remote tiles are placed ahead of the local one so spotlight features a peer', async () => {
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });

  app.participants.set('zzzz', { id: 'zzzz', name: 'Участник zzzz' });
  app.addVideoStream('zzzz', fakeStream(['audio', 'video']), false);

  const tiles = Array.from(env.document.getElementById('videos-container').children);
  assert.strictEqual(tiles[0].id, 'video-wrapper-zzzz');
  assert.ok(tiles[1].classList.contains('local-video'));
});

test('layouts that reserve space for peers are not used while alone', async () => {
  const env = createBrowser();
  const app = new env.CallingApp();

  app.layoutMode = 'compact';
  assert.strictEqual(app.getEffectiveLayout(1), 'grid');
  assert.strictEqual(app.getEffectiveLayout(3), 'compact');
});

test('a page entering the back/forward cache keeps its seat', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });

  const persisted = new env.window.PageTransitionEvent('pagehide', { persisted: true });
  env.window.dispatchEvent(persisted);
  assert.strictEqual(socket.sent.filter((m) => m.type === 'leave').length, 0);

  const unloading = new env.window.PageTransitionEvent('pagehide', { persisted: false });
  env.window.dispatchEvent(unloading);
  assert.strictEqual(socket.sent.filter((m) => m.type === 'leave').length, 1);
});

// --- E2EE key agreement -----------------------------------------------------

function keyOf(byte) {
  return Array.from({ length: 32 }, () => byte);
}

// A control channel the app believes is open, so broadcastControl actually
// records what would have gone to the peer.
function attachControlChannel(app, peerId) {
  const outbox = [];
  app.controlChannels.set(peerId, {
    readyState: 'open',
    send: (raw) => outbox.push(JSON.parse(raw)),
  });
  return outbox;
}

test('the owner can replace its own key — rotation is not mistaken for a rival key', async () => {
  // Comparing owner ids alone would make a peer reject the owner's new key and
  // re-assert the old one, leaving the room split across two keys with the
  // owner's media undecodable.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'bbbb' });
  const outbox = attachControlChannel(app, 'aaaa');

  await app.handleRemoteEncryptionKey('aaaa', keyOf(1), 'aaaa', 1);
  assert.ok(app.frameCryptor.hasSameKey(new Uint8Array(keyOf(1))));

  await app.handleRemoteEncryptionKey('aaaa', keyOf(2), 'aaaa', 2);
  assert.ok(app.frameCryptor.hasSameKey(new Uint8Array(keyOf(2))), 'the rotated key must be adopted');
  assert.strictEqual(app.keyEpoch, 2);
  assert.strictEqual(outbox.length, 0, 'nothing to re-assert — the peer is ahead of us');
});

test('a stale key is refused and the newer one re-asserted', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'bbbb' });
  const outbox = attachControlChannel(app, 'aaaa');

  await app.handleRemoteEncryptionKey('aaaa', keyOf(2), 'aaaa', 2);
  await app.handleRemoteEncryptionKey('aaaa', keyOf(1), 'aaaa', 1);

  assert.ok(app.frameCryptor.hasSameKey(new Uint8Array(keyOf(2))));
  assert.strictEqual(outbox.length, 1);
  assert.strictEqual(outbox[0].kind, 'e2ee-key');
  assert.strictEqual(outbox[0].epoch, 2);
});

test('two peers enabling at once converge on the same key', async () => {
  // Same epoch, different owners: the lower owner id wins, and both sides
  // compute that identically.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'mmmm' });
  const outbox = attachControlChannel(app, 'zzzz');

  await app.handleRemoteEncryptionKey('zzzz', keyOf(9), 'zzzz', 1);
  assert.ok(app.frameCryptor.hasSameKey(new Uint8Array(keyOf(9))));

  // A key from a lower-id owner at the same epoch outranks it
  await app.handleRemoteEncryptionKey('aaaa', keyOf(3), 'aaaa', 1);
  assert.ok(app.frameCryptor.hasSameKey(new Uint8Array(keyOf(3))));
  assert.strictEqual(app.keyOwner, 'aaaa');

  // ...and the loser's key does not come back
  outbox.length = 0;
  await app.handleRemoteEncryptionKey('zzzz', keyOf(9), 'zzzz', 1);
  assert.ok(app.frameCryptor.hasSameKey(new Uint8Array(keyOf(3))));
  assert.strictEqual(outbox[0].epoch, 1);
  assert.strictEqual(outbox[0].owner, 'aaaa');
});

test('a departing participant triggers a rekey by the lowest remaining peer', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('mmmm', { id: 'mmmm', name: 'M' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'mmmm');

  // The key owner is the one who leaves — the rekey must still happen
  await app.handleRemoteEncryptionKey('zzzz', keyOf(4), 'zzzz', 1);
  const before = Array.from(app.frameCryptor.rawKeyData);

  app.handlePeerLeft('zzzz');
  await tick();

  const rekey = outbox.filter((m) => m.kind === 'e2ee-key').pop();
  assert.ok(rekey, 'the remaining peers must be given a new key');
  assert.strictEqual(rekey.owner, 'aaaa');
  assert.strictEqual(rekey.epoch, 2);
  assert.notDeepStrictEqual(Array.from(app.frameCryptor.rawKeyData), before);
});

test('only one peer rekeys after a departure', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'mmmm' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'aaaa');

  await app.handleRemoteEncryptionKey('aaaa', keyOf(4), 'aaaa', 1);
  outbox.length = 0;

  app.handlePeerLeft('zzzz');
  await tick();

  assert.strictEqual(
    outbox.filter((m) => m.kind === 'e2ee-key').length,
    0,
    'aaaa is lower than mmmm, so aaaa rekeys and we stay quiet'
  );
});

test('a socket still closing when we reconnect cannot trigger a second reconnect', async () => {
  // A socket sits in CLOSING until the peer's close frame arrives. Reconnect
  // during that window and the old socket's onclose would otherwise fire on a
  // live app and schedule another connection — two sockets racing, each with
  // its own heartbeat, and the loser's onclose tearing down the winner.
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });

  const stale = env.lastSocket();
  stale.beginClose();
  env.window.dispatchEvent(new env.window.Event('online'));
  await tick();

  const replacement = env.lastSocket();
  assert.notStrictEqual(replacement, stale, 'a replacement socket is opened');
  replacement.open();
  const socketsAfterReconnect = env.sockets.length;
  const status = env.document.getElementById('connection-status');

  // The old socket finally finishes closing
  stale.finishClose();
  await tick(60);

  // Its handler running would immediately advertise a reconnect and stop the
  // heartbeat belonging to the socket that is actually live.
  assert.notStrictEqual(status.textContent, 'Переподключение...', 'the stale handler must be inert');
  assert.strictEqual(app.ws, replacement, 'the live socket is still the replacement');
  assert.strictEqual(replacement.readyState, 1, 'and it was not closed by the stale handler');

  // ...and no second connection appears once the reconnect backoff elapses
  await tick(1300);
  assert.strictEqual(env.sockets.length, socketsAfterReconnect, 'no extra socket was opened');
});
