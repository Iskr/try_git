const { test } = require('node:test');
const assert = require('node:assert');

const { createBrowser, joinedApp, fakeStream } = require('./helpers/browser-env');

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

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

test('reconnecting does not leave two live sockets racing', async () => {
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  const before = env.sockets.length;

  // Network comes back while a reconnect is already pending
  env.lastSocket().close();
  await tick();
  env.window.dispatchEvent(new env.window.Event('online'));
  await tick();

  const live = env.sockets.filter((s) => s.readyState !== 3);
  assert.ok(live.length <= 1, `expected at most one live socket, got ${live.length}`);
  assert.ok(env.sockets.length > before);
});
