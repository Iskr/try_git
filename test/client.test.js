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

test('hanging up during the permission prompt does not throw or half-open a call', async () => {
  // Discarding the stale capture leaves localStream null, so everything that
  // resumes after the await has to notice the call is gone rather than
  // dereference it.
  let releaseCapture;
  const env = createBrowser({
    getUserMedia: () => new Promise((resolve) => { releaseCapture = () => resolve(fakeStream(['audio', 'video'])); }),
  });
  const errors = [];
  env.window.addEventListener('error', (e) => errors.push(e.message));

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

  app.endCall();
  releaseCapture();
  await tick(50);

  assert.deepStrictEqual(errors, [], 'no uncaught error escapes handleJoined');
  assert.strictEqual(app.roomId, null);
  assert.strictEqual(app.localStream, null);
  assert.strictEqual(
    env.document.getElementById('call-screen').classList.contains('active'),
    false,
    'the call screen must not come back after hang-up'
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

test('the guest sees its own paddle at its own end of the board', async () => {
  // The paddle Ys are canonical, so passing the host's end for both players
  // made _project rotate it a second time for the guest: its own paddle drew
  // at the top of its screen while the ball it had to block arrived at the
  // bottom, which reads as broken physics rather than a mirrored board.
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  const PONG = env.PONG;

  // 'zzzz' > 'aaaa', so we are not the offerer and therefore the guest
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  app._startGame('aaaa');
  const game = app.game;
  assert.strictEqual(game.isHost, false, 'the higher client id plays as guest');

  const ends = game._paddleEnds();
  const mine = game._project(0, ends.mine);
  const theirs = game._project(0, ends.theirs);

  assert.ok(mine.y > PONG.H / 2, `own paddle must be on the near half, got y=${mine.y}`);
  assert.ok(theirs.y < PONG.H / 2, `opponent must be on the far half, got y=${theirs.y}`);

  // ...and the ball crossing the guest's canonical plane arrives at the paddle
  const ballAtMyPlane = game._project(0, PONG.PADDLE_INSET);
  assert.ok(
    Math.abs(ballAtMyPlane.y - mine.y) < 1,
    'the ball reaches the same edge the paddle defends'
  );

  app.endGame();
});

test('the host sees its own paddle at its own end of the board', async () => {
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  const PONG = env.PONG;

  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  app._startGame('zzzz');
  const game = app.game;
  assert.strictEqual(game.isHost, true);

  const ends = game._paddleEnds();
  assert.ok(game._project(0, ends.mine).y > PONG.H / 2);
  assert.ok(game._project(0, ends.theirs).y < PONG.H / 2);

  app.endGame();
});

test('waiting for a random call takes the camera before queueing', async () => {
  // The match can land minutes later, outside any user gesture, and iOS will
  // not reliably grant a first-time camera prompt then.
  const env = createBrowser();
  const app = new env.CallingApp();
  env.lastSocket().open();

  await app.startWaiting(2);

  assert.strictEqual(env.media.calls.length, 1, 'the camera was taken first');
  assert.ok(app.localStream);
  const wait = env.lastSocket().sent.filter((m) => m.type === 'wait').pop();
  assert.strictEqual(wait.size, 2);
  assert.strictEqual(
    env.document.getElementById('waiting-panel').classList.contains('hidden'),
    false
  );
});

test('a denied camera never costs a stranger their slot', async () => {
  const env = createBrowser({
    getUserMedia: async () => {
      const error = new Error('denied');
      error.name = 'NotAllowedError';
      throw error;
    },
  });
  const app = new env.CallingApp();
  env.lastSocket().open();

  await app.startWaiting(2);

  assert.strictEqual(
    env.lastSocket().sent.filter((m) => m.type === 'wait').length,
    0,
    'we never queued'
  );
  assert.strictEqual(app._waitingSize, null);
});

test('cancelling the wait releases the camera', async () => {
  // The light staying on after cancelling reads as the app still watching.
  const env = createBrowser();
  const app = new env.CallingApp();
  env.lastSocket().open();
  await app.startWaiting(2);
  const stream = app.localStream;

  app.cancelWaiting();

  assert.ok(env.lastSocket().sent.some((m) => m.type === 'unwait'));
  assert.strictEqual(app._waitingSize, null);
  assert.strictEqual(app.localStream, null);
  assert.ok(stream.getTracks().every((t) => t.readyState === 'ended'));
  assert.strictEqual(
    env.document.getElementById('waiting-panel').classList.contains('hidden'),
    true
  );
});

test('a match replaces the waiting screen with the call', async () => {
  const env = createBrowser();
  const app = new env.CallingApp();
  const socket = env.lastSocket();
  socket.open();
  await app.startWaiting(2);

  socket.deliver({
    type: 'joined',
    roomId: 'MATCH1',
    clientId: 'aaaa',
    participants: ['zzzz'],
    resumeToken: 'a'.repeat(64),
    matched: true,
  });
  await tick(40);

  assert.strictEqual(app._waitingSize, null, 'no longer waiting');
  assert.strictEqual(app.roomId, 'MATCH1');
  assert.strictEqual(
    env.document.getElementById('waiting-panel').classList.contains('hidden'),
    true
  );
  assert.strictEqual(
    env.document.getElementById('call-screen').classList.contains('active'),
    true
  );
});

test('a socket dropping while queued reconnects on its own', async () => {
  // The old version of this test dispatched 'online' by hand, which forces a
  // reconnect — so it passed while the app, left to itself, sat on a spinner
  // for a match that could never arrive, camera running the whole time.
  const env = createBrowser();
  const app = new env.CallingApp();
  env.lastSocket().open();
  await app.startWaiting(3);
  const before = env.sockets.length;

  env.lastSocket().close();
  await tick(1300); // past the first backoff step

  assert.ok(env.sockets.length > before, 'a reconnect was scheduled without any nudge');
  const reconnected = env.lastSocket();
  reconnected.open();

  const wait = reconnected.sent.filter((m) => m.type === 'wait').pop();
  assert.ok(wait, 'and the queue request is re-sent');
  assert.strictEqual(wait.size, 3, 'with the same size, which the server treats as idempotent');
});

test('a refused wait does not leave a searching screen and a live camera', async () => {
  const env = createBrowser();
  const app = new env.CallingApp();
  const socket = env.lastSocket();
  socket.open();
  await app.startWaiting(2);
  const stream = app.localStream;

  socket.deliver({ type: 'error', code: 'too-many-waiting', text: 'Слишком много ожиданий' });
  await tick();

  assert.strictEqual(app._waitingSize, null);
  assert.strictEqual(app.localStream, null);
  assert.ok(stream.getTracks().every((t) => t.readyState === 'ended'));
  assert.strictEqual(
    env.document.getElementById('waiting-panel').classList.contains('hidden'),
    true
  );
});

test('a match that lands just after cancelling is refused', async () => {
  // The server can seat us in the same instant we back out. Accepting would
  // put the user in a stranger's call they had already left, camera and all.
  const env = createBrowser();
  const app = new env.CallingApp();
  const socket = env.lastSocket();
  socket.open();
  await app.startWaiting(2);
  app.cancelWaiting();

  socket.deliver({
    type: 'joined',
    roomId: 'LATE01',
    clientId: 'aaaa',
    participants: ['zzzz'],
    resumeToken: 'a'.repeat(64),
    matched: true,
  });
  await tick(40);

  assert.strictEqual(app.roomId, null, 'we do not end up in the call');
  assert.strictEqual(app.localStream, null, 'and the camera stays off');
  assert.ok(socket.sent.some((m) => m.type === 'leave'), 'the seat is given back');
});

test('the queue timing out tells the user and frees the camera', async () => {
  const env = createBrowser();
  const app = new env.CallingApp();
  const socket = env.lastSocket();
  socket.open();
  await app.startWaiting(2);
  const stream = app.localStream;

  socket.deliver({ type: 'waiting-expired' });
  await tick();

  assert.strictEqual(app._waitingSize, null);
  assert.strictEqual(app.localStream, null);
  assert.ok(stream.getTracks().every((t) => t.readyState === 'ended'));
  assert.match(env.document.getElementById('toast').textContent, /попробуйте/i);
});

test('a refused camera inside Telegram points at Safari, not at browser settings', async () => {
  // Calls do work in Telegram's webview, so nothing is said up front — but if
  // the camera is refused there, there is no permission screen to send the
  // user to, only "open in Safari".
  const env = createBrowser({ webkit: true, telegram: true });
  const app = new env.CallingApp();

  const denied = new Error('denied');
  denied.name = 'NotAllowedError';
  assert.match(app.mediaErrorMessage(denied), /Safari/);
});

test('an ordinary browser gets the usual advice', async () => {
  const env = createBrowser();
  const app = new env.CallingApp();

  const denied = new Error('denied');
  denied.name = 'NotAllowedError';
  assert.match(app.mediaErrorMessage(denied), /настройках браузера/);
});

test('the reactions button shows a different face each time it is opened', async () => {
  const env = createBrowser();
  const app = new env.CallingApp();
  const face = env.document.getElementById('reactions-btn-emoji');

  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const before = face.textContent;
    app.toggleReactionsDropdown();
    app.toggleReactionsDropdown();
    assert.notStrictEqual(face.textContent, before, 'never repeats the face it just had');
    seen.add(face.textContent);
  }
  assert.ok(seen.size > 3, `expected variety, saw ${seen.size} distinct faces`);
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

test('remote tiles start muted so iOS will autoplay them at all', async () => {
  // iOS refuses to autoplay an unmuted element. Unmuting before play() —
  // which is what routing WebKit audio through the element naively does —
  // costs the video entirely: the tile just stays black.
  const env = createBrowser({ webkit: true });
  const played = [];
  env.window.HTMLMediaElement.prototype.play = function play() {
    played.push({ id: this.id, mutedAtPlay: this.muted });
    return Promise.resolve();
  };

  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Участник zzzz' });
  app.addVideoStream('zzzz', fakeStream(['audio', 'video']), false);
  await tick();

  const remotePlay = played.find((p) => p.id === 'video-zzzz');
  assert.ok(remotePlay, 'the remote tile must be started');
  assert.strictEqual(remotePlay.mutedAtPlay, true, 'muted when play() is called');

  // ...and its audio is switched on once playback is running
  assert.strictEqual(env.document.getElementById('video-zzzz').muted, false);
});

test('remote tiles keep Web Audio routing on browsers where it works', async () => {
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Участник zzzz' });
  app.addVideoStream('zzzz', fakeStream(['audio', 'video']), false);
  await tick();

  assert.strictEqual(
    env.document.getElementById('video-zzzz').muted,
    true,
    'the element stays muted — audio comes out of the gain node'
  );
  assert.ok(app.audioContexts.has('zzzz'));
});

test('an unreachable peer is eventually given up on instead of retried forever', async () => {
  // A full reconnect resets the ICE-restart counter, so without a ceiling on
  // rebuild cycles the pair loops for the whole call: constant teardown,
  // repeated toasts, and a phone that just gets hot.
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });

  for (let i = 0; i < app._maxPeerReconnects; i++) {
    await app._reconnectPeer('zzzz');
    assert.ok(app.peerConnections.has('zzzz'), `cycle ${i + 1} still rebuilds`);
  }

  await app._reconnectPeer('zzzz');
  assert.strictEqual(app.peerConnections.has('zzzz'), false, 'we stop rebuilding');
  assert.strictEqual(app.participants.get('zzzz').unreachable, true);
  assert.match(env.document.getElementById('toast').textContent, /TURN/);
});

test('a peer that comes back gets a fresh recovery budget', async () => {
  const env = createBrowser();
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });

  for (let i = 0; i <= app._maxPeerReconnects; i++) {
    await app._reconnectPeer('zzzz');
  }
  assert.strictEqual(app.participants.get('zzzz').unreachable, true);

  socket.deliver({ type: 'peer-joined', clientId: 'zzzz' });
  await tick();

  assert.strictEqual(app._peerReconnectAttempts.has('zzzz'), false);
  assert.strictEqual(app.participants.get('zzzz').unreachable, undefined);
});

test('an ICE restart whose offer cannot be produced is retried, not dropped', async () => {
  // The restart runs off a one-shot timer while the state is already 'failed',
  // so nothing else would ever fire for this peer again.
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  await app.createOffer('zzzz');

  const pc = app.peerConnections.get('zzzz');
  pc.createOffer = () => Promise.reject(new Error('boom'));

  const before = app._iceRestartAttempts.get('zzzz') || 0;
  await app.createOffer('zzzz', { iceRestart: true });

  assert.strictEqual(
    app._iceRestartAttempts.get('zzzz'),
    before + 1,
    'the failure re-enters the retry ladder'
  );
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

// --- Ping-pong --------------------------------------------------------------

function gameMsg(app, senderId, payload) {
  return app.handleControlMessage(senderId, JSON.stringify({ kind: 'game', ...payload }));
}

async function twoPlayerCall(env, { me = 'aaaa', them = 'zzzz' } = {}) {
  const { app, socket } = await joinedApp(env, { clientId: me });
  app.participants.set(them, { id: them, name: 'Участник zzzz' });
  const outbox = attachControlChannel(app, them);
  return { app, socket, outbox, them };
}

test('the call screen starts with no game', async () => {
  const env = createBrowser();
  await joinedApp(env, { clientId: 'aaaa' });
  assert.ok(env.document.getElementById('game-panel').classList.contains('hidden'));
  assert.strictEqual(env.document.getElementById('call-screen').hasAttribute('data-game'), false);
});

test('an invitation is shown and can be accepted', async () => {
  const env = createBrowser();
  const { app, outbox, them } = await twoPlayerCall(env);

  await gameMsg(app, them, { op: 'invite', v: 1 });
  const invite = env.document.getElementById('game-invite');
  assert.ok(!invite.classList.contains('hidden'), 'the invitation is visible');
  assert.match(env.document.getElementById('game-invite-from').textContent, /приглашает/);

  app.acceptGameInvite();
  assert.ok(invite.classList.contains('hidden'));
  assert.ok(app.game, 'the game is running');
  assert.strictEqual(app.gameOpponentId, them);
  assert.strictEqual(env.document.getElementById('call-screen').getAttribute('data-game'), 'on');
  assert.ok(outbox.some((m) => m.kind === 'game' && m.op === 'accept'));
  app.endGame();
});

test('opening a game does not disturb the video grid', async () => {
  // The board is a sibling of #videos-container on purpose: updateGridLayout()
  // counts that container's children, so a board inside it would shift every
  // [data-participants] rule.
  const env = createBrowser();
  const { app, them } = await twoPlayerCall(env);
  app.addVideoStream(them, fakeStream(['audio', 'video']), false);
  const container = env.document.getElementById('videos-container');
  const before = container.getAttribute('data-participants');

  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();

  assert.strictEqual(container.getAttribute('data-participants'), before);
  assert.strictEqual(container.getAttribute('data-layout'), 'grid', 'spotlight is meaningless in a strip');
  app.endGame();
});

test('the stored layout choice comes back when the game ends', async () => {
  const env = createBrowser();
  const { app, them } = await twoPlayerCall(env);
  app.layoutMode = 'sidebar';
  app.addVideoStream(them, fakeStream(['audio', 'video']), false);

  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();
  assert.strictEqual(app.getEffectiveLayout(2), 'grid');

  app.endGame();
  assert.strictEqual(app.layoutMode, 'sidebar', 'the stored mode was never touched');
  assert.strictEqual(app.getEffectiveLayout(2), 'sidebar');
});

test('only the opponent can drive the game', async () => {
  // In a five-person room a third party must not be able to move the ball.
  const env = createBrowser();
  const { app, them } = await twoPlayerCall(env);
  app.participants.set('mmmm', { id: 'mmmm', name: 'M' });
  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();

  const before = app.game.hostX;
  await gameMsg(app, 'mmmm', { op: 'state', bx: 10, by: 10, vx: 0, vy: 0, hx: 5, gx: 5 });
  assert.strictEqual(app.game.hostX, before, 'a stranger cannot move anything');
  app.endGame();
});

test('a hostile state message cannot poison the board', async () => {
  const env = createBrowser();
  const { app, them } = await twoPlayerCall(env);
  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();
  app.game.isHost = false; // only the guest applies state

  for (const bad of [
    { bx: NaN, by: 1, vx: 1, vy: 1, hx: 1, gx: 1 },
    { bx: 1e400, by: 1, vx: 1, vy: 1, hx: 1, gx: 1 },
    { bx: 1, by: 1, vx: 'x', vy: 1, hx: 1, gx: 1 },
    { bx: 1, by: 1, vx: 1, vy: 1, hx: null, gx: 1 },
  ]) {
    await gameMsg(app, them, { op: 'state', ...bad });
  }
  assert.strictEqual(app.game.remote, null, 'nothing invalid was accepted');
  assert.ok(Number.isFinite(app.game.hostX));

  await gameMsg(app, them, { op: 'state', bx: 50, by: 60, vx: 10, vy: 20, hx: 100, gx: 120 });
  assert.ok(app.game.remote, 'a valid snapshot still applies');
  assert.strictEqual(app.game.hostX, 100);
  app.endGame();
});

test('a peer leaving ends the game and restores the screen', async () => {
  const env = createBrowser();
  const { app, them } = await twoPlayerCall(env);
  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();
  assert.ok(app.game);

  app.handlePeerLeft(them);

  assert.strictEqual(app.game, null, 'the render loop is stopped');
  assert.strictEqual(app.gameOpponentId, null);
  assert.ok(env.document.getElementById('game-panel').classList.contains('hidden'));
  assert.strictEqual(env.document.getElementById('call-screen').hasAttribute('data-game'), false);
});

test('a peer reconnecting ends the game rather than freezing it', async () => {
  // _dropPeerSession kills the data channel; a game left running would just
  // stop with nothing on screen to explain why.
  const env = createBrowser();
  const { app, socket, them } = await twoPlayerCall(env);
  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();

  socket.deliver({ type: 'peer-joined', clientId: them });
  await tick();

  assert.strictEqual(app.game, null);
  assert.strictEqual(env.document.getElementById('call-screen').hasAttribute('data-game'), false);
});

test('ending the call stops the game', async () => {
  const env = createBrowser();
  const { app, them } = await twoPlayerCall(env);
  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();

  app.endCall();

  assert.strictEqual(app.game, null, 'no render loop outlives the call');
  assert.ok(env.document.getElementById('game-panel').classList.contains('hidden'));
});

test('game traffic goes only to the opponent', async () => {
  const env = createBrowser();
  const { app, outbox, them } = await twoPlayerCall(env);
  const bystander = attachControlChannel(app, 'mmmm');
  app.participants.set('mmmm', { id: 'mmmm', name: 'M' });

  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();
  outbox.length = 0;
  app._sendGame({ op: 'state', bx: 1, by: 1, vx: 0, vy: 0, hx: 1, gx: 1 });

  assert.strictEqual(outbox.filter((m) => m.kind === 'game').length, 1);
  assert.strictEqual(bystander.length, 0, 'bystanders never see game traffic');
  app.endGame();
});

test('a backed-up channel drops game ticks instead of queueing them', async () => {
  // Dropping a tick is free — the next snapshot supersedes it. Letting them
  // queue would delay an E2EE key behind them on the same ordered channel.
  const env = createBrowser();
  const { app, outbox, them } = await twoPlayerCall(env);
  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();
  outbox.length = 0;

  app.controlChannels.get(them).bufferedAmount = 200 * 1024;
  const sent = app._sendGame({ op: 'state', bx: 1, by: 1, vx: 0, vy: 0, hx: 1, gx: 1 });

  assert.strictEqual(sent, false);
  assert.strictEqual(outbox.length, 0);
  app.endGame();
});

test('the invite is refused when it cannot reach the peer', async () => {
  const env = createBrowser();
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });

  app.inviteToGame('zzzz'); // no control channel attached
  assert.strictEqual(app.invitedPeer, null);
  assert.match(env.document.getElementById('toast').textContent, /соединени/i);
});

test('the guest stops showing the countdown once the ball is live', async () => {
  // The guest never runs the simulation, so a state message is the only thing
  // that can clear the "get ready" overlay for it.
  const env = createBrowser();
  const { app, them } = await twoPlayerCall(env, { me: 'zzzz', them: 'aaaa' });
  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();
  assert.strictEqual(app.game.isHost, false, 'aaaa < zzzz, so they simulate');

  const message = env.document.getElementById('game-message');
  assert.ok(!message.classList.contains('hidden'), 'the countdown is up');

  await gameMsg(app, them, { op: 'state', bx: 150, by: 200, vx: 0, vy: 0, hx: 150, gx: 150 });
  assert.ok(!message.classList.contains('hidden'), 'a frozen ball is still the countdown');

  await gameMsg(app, them, { op: 'state', bx: 150, by: 200, vx: 40, vy: 120, hx: 150, gx: 150 });
  assert.ok(message.classList.contains('hidden'), 'the ball moved, so the overlay clears');
  app.endGame();
});

test('the host awards the point and tells the guest', async () => {
  const env = createBrowser();
  const { app, outbox, them } = await twoPlayerCall(env, { me: 'aaaa', them: 'zzzz' });
  await gameMsg(app, them, { op: 'invite', v: 1 });
  app.acceptGameInvite();
  assert.strictEqual(app.game.isHost, true, 'aaaa < zzzz, so we simulate');

  outbox.length = 0;
  app.game.freezeMs = 0;
  app.game.ball = { x: 150, y: 395, vx: 0, vy: 200 };
  app.game.hostX = 10; // nowhere near the ball
  app.game._step(0.2);

  assert.strictEqual(app.game.theirScore, 1, 'the ball went past us');
  const score = outbox.find((m) => m.op === 'score');
  assert.ok(score);
  assert.strictEqual(score.h, 0);
  assert.strictEqual(score.g, 1);
  app.endGame();
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

test('encryption is on before anyone touches the button', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
  assert.strictEqual(
    env.document.getElementById('encryption-indicator').classList.contains('hidden'),
    false,
    'and the lock is shown'
  );
});

test('one member cannot switch the room to plaintext on its own', async () => {
  // Without the vote check this is all it took: send e2ee-off and everyone
  // drops to plaintext while still looking at a lock indicator a moment ago.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  attachControlChannel(app, 'zzzz');

  await app.handleControlMessage('zzzz', JSON.stringify({ kind: 'e2ee-off' }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'still encrypted');

  // Nor does inventing a vote id we never agreed to
  await app.handleControlMessage('zzzz', JSON.stringify({ kind: 'e2ee-off', voteId: 'made-up' }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
});

test('a refusal keeps encryption on', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = outbox.find((m) => m.kind === 'e2ee-off-request');
  assert.ok(request, 'the room is asked');

  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-vote', voteId: request.voteId, agree: false,
  }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
  assert.strictEqual(outbox.filter((m) => m.kind === 'e2ee-off').length, 0, 'nothing announced');
  assert.match(env.document.getElementById('toast').textContent, /против/i);
});

test('unanimous agreement switches it off once everyone confirms receipt', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  ['mmmm', 'zzzz'].forEach((id) => app.participants.set(id, { id, name: id }));
  const first = attachControlChannel(app, 'mmmm');
  const second = attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = first.find((m) => m.kind === 'e2ee-off-request');

  await app.handleControlMessage('mmmm', JSON.stringify({
    kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
  }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'one voice is not enough');

  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
  }));

  assert.ok(first.some((m) => m.kind === 'e2ee-off' && m.voteId === request.voteId));
  assert.ok(second.some((m) => m.kind === 'e2ee-off' && m.voteId === request.voteId));
  // The announcement can be lost; whoever misses it stays encrypted alone and
  // sees nothing but frozen tiles. So the proposer holds its own switch-off
  // until every voter confirms the result actually reached them.
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'delivery is not confirmed yet');

  await app.handleControlMessage('mmmm', JSON.stringify({
    kind: 'e2ee-off-ack', voteId: request.voteId,
  }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'one confirmation is not everyone');

  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-ack', voteId: request.voteId,
  }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);
});

test('a result nobody confirms rolls the room back to encrypted', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = outbox.find((m) => m.kind === 'e2ee-off-request');
  const epochBefore = app.keyEpoch;
  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
  }));
  assert.ok(outbox.some((m) => m.kind === 'e2ee-off'), 'the result went out');
  assert.ok(app._pendingDisable, 'and delivery is being confirmed');
  assert.ok(app._pendingDisable.timer, 'with a rollback armed for silence');

  // The confirmation never arrives — the ack window closes
  app._abortPendingDisable();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
  assert.strictEqual(app._pendingDisable, null);
  // zzzz may have applied the result before its ack was lost, so silence
  // would leave it on plaintext: the room is actively re-keyed instead.
  const rekey = outbox.filter((m) => m.kind === 'e2ee-key').pop();
  assert.ok(rekey, 'the room is pulled back to encrypted');
  assert.strictEqual(rekey.reenable, true, 'as a deliberate re-enable, so a voted-off peer follows it');
  assert.ok(rekey.epoch > epochBefore, 'under a fresh epoch that outranks the old key');
  assert.match(env.document.getElementById('toast').textContent, /не дошёл/i);
});

test('a result that cannot even be sent fails the switch-off at once', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  ['mmmm', 'zzzz'].forEach((id) => app.participants.set(id, { id, name: id }));
  const open = attachControlChannel(app, 'mmmm');
  attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = open.find((m) => m.kind === 'e2ee-off-request');
  await app.handleControlMessage('mmmm', JSON.stringify({
    kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
  }));
  // zzzz's channel dies between its vote and the announcement
  app.controlChannels.get('zzzz').readyState = 'closed';
  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'nobody is switched off over a dead channel');
  assert.strictEqual(app._pendingDisable, null, 'no point waiting out the ack window');
  const rekey = open.filter((m) => m.kind === 'e2ee-key').pop();
  assert.ok(rekey && rekey.reenable === true, 'mmmm, who may have applied the result, is pulled back');
});

test('an auto-agreement mints no consent token that survives encryption coming back', async () => {
  // The auto-agree branch answers without asking the user, so a stored "yes"
  // would be consent nobody gave: a peer could keep re-sending requests while
  // we are off — refreshing the entry each time — and spend it the moment
  // encryption returns, putting us on plaintext with no prompt ever shown.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  const outbox = attachControlChannel(app, 'aaaa');

  app.frameCryptor.disable();
  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off-request', voteId: 'v7' }));
  const reply = outbox.find((m) => m.kind === 'e2ee-off-vote');
  assert.ok(reply && reply.agree === true, 'still agreed — there is nothing to turn off');
  assert.strictEqual(app._agreedVotes.has('v7'), false, 'but nothing spendable is kept');

  // Encryption comes back (the user's own choice, or a rollback's re-enable)
  await app.enableEncryption({ silent: true });
  await app.handleControlMessage('aaaa', JSON.stringify({
    kind: 'e2ee-off', voteId: 'v7', peers: ['aaaa', 'zzzz'], agreed: ['aaaa', 'zzzz'],
  }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true,
    'the old vote cannot be cashed in against the new state');
  assert.strictEqual(outbox.filter((m) => m.kind === 'e2ee-off-ack').length, 0,
    'and withholding the ack rolls the proposer back, so the room stays encrypted');
});

test('the ack window closing is what fires the rollback', async () => {
  // Asserting the timer field is truthy proves nothing: a no-op callback or a
  // 20s constant would pass while the proposer hung in _pendingDisable
  // forever, blocking every later vote and every key rotation.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'zzzz');

  const armed = [];
  const realSetTimeout = env.window.setTimeout;
  env.window.setTimeout = function (fn, ms, ...args) {
    const id = realSetTimeout.call(env.window, fn, ms, ...args);
    armed.push({ fn, ms, id });
    return id;
  };

  app.proposeDisableEncryption();
  const request = outbox.find((m) => m.kind === 'e2ee-off-request');
  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
  }));

  const rollback = armed.find((t) => t.id === app._pendingDisable.timer);
  assert.ok(rollback, 'the handover armed its rollback through the platform timer');
  assert.strictEqual(rollback.ms, 5000, 'over the documented ack window');

  const epochBefore = app.keyEpoch;
  rollback.fn(); // the window elapses with nobody confirming
  await tick(10);

  assert.strictEqual(app._pendingDisable, null);
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
  const rekey = outbox.filter((m) => m.kind === 'e2ee-key').pop();
  assert.ok(rekey && rekey.reenable === true, 'and that callback is the one that re-keys the room');
  assert.ok(rekey.epoch > epochBefore);
});

test('a stale or forged confirmation cannot spend the handover', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  ['mmmm', 'zzzz'].forEach((id) => app.participants.set(id, { id, name: id }));
  const first = attachControlChannel(app, 'mmmm');
  attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = first.find((m) => m.kind === 'e2ee-off-request');
  for (const id of ['mmmm', 'zzzz']) {
    await app.handleControlMessage(id, JSON.stringify({
      kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
    }));
  }

  // A confirmation carrying some other vote's id must not be counted as this
  // one. Checking only that the handover has not completed would miss it: the
  // damage is that it silently spends mmmm's slot, so the next voter alone
  // finishes a handover mmmm never confirmed.
  await app.handleControlMessage('mmmm', JSON.stringify({ kind: 'e2ee-off-ack', voteId: 'other' }));
  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-ack', voteId: request.voteId,
  }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true,
    'mmmm has not confirmed anything about this vote');
  assert.ok(app._pendingDisable, 'so the handover is still waiting on it');

  // mmmm confirming for real is what finishes it
  await app.handleControlMessage('mmmm', JSON.stringify({
    kind: 'e2ee-off-ack', voteId: request.voteId,
  }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);
});

test('a confirmation arriving after the rollback cannot revive the handover', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  ['mmmm', 'zzzz'].forEach((id) => app.participants.set(id, { id, name: id }));
  const first = attachControlChannel(app, 'mmmm');
  attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = first.find((m) => m.kind === 'e2ee-off-request');
  for (const id of ['mmmm', 'zzzz']) {
    await app.handleControlMessage(id, JSON.stringify({
      kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
    }));
  }

  // The window closes with nobody confirming; the room is re-keyed
  app._abortPendingDisable();
  await tick(10);
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);

  // Both confirmations were merely slow. Honouring them now would put us on
  // plaintext in a room we just told everyone stays encrypted.
  for (const id of ['mmmm', 'zzzz']) {
    await app.handleControlMessage(id, JSON.stringify({
      kind: 'e2ee-off-ack', voteId: request.voteId,
    }));
  }
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'a spent handover stays spent');
});

test('a peer left behind by a re-enable is handed the key instead of being stranded', async () => {
  // It bounces e2ee-room-off at an epoch below ours, which proves it never saw
  // the re-enable. Ignoring that leaves it on plaintext we refuse to render
  // and us on a key it does not have, with nothing to ever repair it.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'zzzz');

  await app.handleRemoteEncryptionKey('zzzz', keyOf(5), 'zzzz', 5);
  assert.strictEqual(app.keyEpoch, 5);

  outbox.length = 0;
  await app.handleControlMessage('zzzz', JSON.stringify({ kind: 'e2ee-room-off', epoch: 4 }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'we do not follow stale news');
  const rescue = outbox.find((m) => m.kind === 'e2ee-key');
  assert.ok(rescue, 'the peer behind us is given the current key');
  assert.strictEqual(rescue.reenable, true, 'marked so its voted-off state does not bounce it again');
  assert.strictEqual(rescue.epoch, 5);
});

test('rejoining does not let a stale epoch outrank the room', async () => {
  // A rejoin clears _e2eeVotedOff and silently re-enables. Keeping the old
  // epoch would push us past the room's, so the room's own "we voted off"
  // bounce would look stale to us and the split would never heal.
  const env = createBrowser({ frameEncryption: true });
  const { app, socket } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  attachControlChannel(app, 'zzzz');

  await app.handleRemoteEncryptionKey('zzzz', keyOf(6), 'zzzz', 9);
  assert.strictEqual(app.keyEpoch, 9);

  socket.deliver({
    type: 'joined',
    roomId: 'ROOM01',
    clientId: 'aaaa',
    participants: [],
    resumeToken: 'a'.repeat(64),
  });
  await tick(20);
  assert.strictEqual(app._pendingDisable, null, 'no handover survives the rejoin');
  assert.strictEqual(app._agreedVotes.size, 0);

  // The room tells us what it decided while we were away. Keeping epoch 9
  // would make that look like stale news from behind us, and we would answer
  // by pushing our key back at the room — overriding a decision we never
  // took part in, and splitting off for the rest of the call.
  const outbox = attachControlChannel(app, 'zzzz');
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  await app.handleControlMessage('zzzz', JSON.stringify({ kind: 'e2ee-room-off', epoch: 1 }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, false, 'the rejoiner follows the room');
  assert.strictEqual(
    outbox.filter((m) => m.kind === 'e2ee-key').length, 0,
    'and does not try to re-enable the room on its way in'
  );
});

test('a rollback that lands after the call ended does not re-arm the cryptor', async () => {
  // _reassertEncryption awaits importKey; endCall can run in that gap. Coming
  // back to enable() would leave the next call encrypting with a key it never
  // announced, because it would see encryption as already on.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  attachControlChannel(app, 'zzzz');

  const reassert = app._reassertEncryption();
  app.endCall();
  await reassert;
  await tick(10);

  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);
  assert.strictEqual(app.frameCryptor.rawKeyData, null, 'the reset stands');
});

test('ending the call clears a vote that never reached a result', async () => {
  // The other half of endCall's cleanup: without it the 20s vote timer fires
  // on the home screen and toasts about a call that is over.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  ['mmmm', 'zzzz'].forEach((id) => app.participants.set(id, { id, name: id }));
  attachControlChannel(app, 'mmmm');
  attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  assert.ok(app._pendingVote, 'nobody has voted yet');

  app.endCall();

  assert.strictEqual(app._pendingVote, null);
  assert.strictEqual(app._agreedVotes.size, 0);
});

test('the deferred rotation resumes once the handover has failed', async () => {
  // The deferral must be a pause, not a latch: after a rollback a later
  // departure has to rotate the key as usual.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  ['mmmm', 'zzzz'].forEach((id) => app.participants.set(id, { id, name: id }));
  const first = attachControlChannel(app, 'mmmm');
  attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = first.find((m) => m.kind === 'e2ee-off-request');
  for (const id of ['mmmm', 'zzzz']) {
    await app.handleControlMessage(id, JSON.stringify({
      kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
    }));
  }
  app._abortPendingDisable();
  await tick(10);
  const afterRollback = app.keyEpoch;

  first.length = 0;
  app.handlePeerLeft('zzzz');
  await tick(20);

  const rotated = first.filter((m) => m.kind === 'e2ee-key').pop();
  assert.ok(rotated, 'a departure still rotates the key');
  assert.ok(rotated.epoch > afterRollback, 'under a fresh epoch');
});

test('a recipient confirms the result it applied', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  const outbox = attachControlChannel(app, 'aaaa');

  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off-request', voteId: 'v9' }));
  app.answerDisableRequest(true);
  await app.handleControlMessage('aaaa', JSON.stringify({
    kind: 'e2ee-off', voteId: 'v9', peers: ['aaaa', 'zzzz'], agreed: ['aaaa', 'zzzz'],
  }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);
  assert.ok(outbox.some((m) => m.kind === 'e2ee-off-ack' && m.voteId === 'v9'));
});

test('an already-off recipient still confirms receipt of the result', async () => {
  // Without this the proposer would wait for an ack that can never come and
  // roll the whole room back to encrypted for no reason — including the peer
  // the vote was held for, who would vanish again.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  const outbox = attachControlChannel(app, 'aaaa');

  app.frameCryptor.disable();
  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off', voteId: 'v8' }));

  assert.ok(outbox.some((m) => m.kind === 'e2ee-off-ack' && m.voteId === 'v8'));
});

test('a voter leaving before confirming does not hold the switch-off hostage', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  ['mmmm', 'zzzz'].forEach((id) => app.participants.set(id, { id, name: id }));
  const first = attachControlChannel(app, 'mmmm');
  attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = first.find((m) => m.kind === 'e2ee-off-request');
  for (const id of ['mmmm', 'zzzz']) {
    await app.handleControlMessage(id, JSON.stringify({
      kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
    }));
  }
  await app.handleControlMessage('mmmm', JSON.stringify({
    kind: 'e2ee-off-ack', voteId: request.voteId,
  }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'zzzz has not confirmed');

  // zzzz leaves without confirming; everyone still here has
  app.handlePeerLeft('zzzz');

  assert.strictEqual(app.frameCryptor.encryptionEnabled, false, 'the room honours what it agreed');
});

test('key rotation waits while a switch-off result is in flight', async () => {
  // A rotation broadcast mid-handover would hand a fresh key to peers that
  // just switched off; they bounce it and the room drifts apart again.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  ['mmmm', 'zzzz'].forEach((id) => app.participants.set(id, { id, name: id }));
  const first = attachControlChannel(app, 'mmmm');
  const second = attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = first.find((m) => m.kind === 'e2ee-off-request');
  for (const id of ['mmmm', 'zzzz']) {
    await app.handleControlMessage(id, JSON.stringify({
      kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
    }));
  }
  await app.handleControlMessage('mmmm', JSON.stringify({
    kind: 'e2ee-off-ack', voteId: request.voteId,
  }));

  // mmmm (already confirmed) leaves; zzzz is still being waited on, and we
  // are the lowest remaining id — the usual trigger for a rekey
  app.handlePeerLeft('mmmm');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(second.filter((m) => m.kind === 'e2ee-key').length, 0, 'no rekey mid-handover');
  assert.ok(app._pendingDisable, 'the handover itself is unaffected');

  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-ack', voteId: request.voteId,
  }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);
});

test('a deliberate re-enable pulls a voted-off peer back on', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  const outbox = attachControlChannel(app, 'aaaa');

  app._applyDisableEncryption();

  // A plain key is still bounced — a newcomer must not override the room…
  await app.handleRemoteEncryptionKey('aaaa', keyOf(3), 'aaaa', 3);
  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);
  const bounce = outbox.find((m) => m.kind === 'e2ee-room-off');
  assert.ok(bounce, 'the sender is told what the room decided');
  assert.strictEqual(bounce.epoch, app.keyEpoch, 'dated, so a later re-enable can tell it is stale');

  // …but a deliberate re-enable is the room coming back on
  await app.handleRemoteEncryptionKey('aaaa', keyOf(4), 'aaaa', 4, true);
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
  assert.strictEqual(app._e2eeVotedOff, false);
});

test('a stale room-off bounce cannot drag a re-keyed room back to plaintext', async () => {
  // A peer that went dark holding "the room voted off at epoch N" must not
  // undo a re-enable it never saw when it comes back.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  attachControlChannel(app, 'zzzz');

  await app.handleRemoteEncryptionKey('zzzz', keyOf(5), 'zzzz', 5);
  assert.strictEqual(app.keyEpoch, 5);

  await app.handleControlMessage('zzzz', JSON.stringify({ kind: 'e2ee-room-off', epoch: 4 }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'its news is older than our key');

  // The same claim about the current epoch is followed as before
  await app.handleControlMessage('zzzz', JSON.stringify({ kind: 'e2ee-room-off', epoch: 5 }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);
});

test('ending the call disarms a pending vote and result handover', async () => {
  // The rollback timer must not outlive the call: firing on the home screen
  // it would re-arm the cryptor with the old room's key, and the next call —
  // seeing encryption already on — would inherit a key strangers know.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'zzzz');

  app.proposeDisableEncryption();
  const request = outbox.find((m) => m.kind === 'e2ee-off-request');
  await app.handleControlMessage('zzzz', JSON.stringify({
    kind: 'e2ee-off-vote', voteId: request.voteId, agree: true,
  }));
  assert.ok(app._pendingDisable, 'the handover is in flight');

  app.endCall();

  assert.strictEqual(app._pendingDisable, null);
  assert.strictEqual(app._agreedVotes.size, 0);
  // Even if the armed callback still fired, it must find nothing to do
  app._abortPendingDisable();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, false,
    'the cryptor stays reset for the next call');
});

test('toggling encryption back on ends the voted-off state for the room', async () => {
  // Without clearing _e2eeVotedOff the toggler comes back alone: every other
  // peer bounces its key and the room splits between one encrypted member
  // and everyone else on plaintext.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  const outbox = attachControlChannel(app, 'zzzz');

  app._applyDisableEncryption();
  await app.toggleEncryption();

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
  assert.strictEqual(app._e2eeVotedOff, false);
  const rekey = outbox.filter((m) => m.kind === 'e2ee-key').pop();
  assert.ok(rekey && rekey.reenable === true, 'sent as a re-enable so voted-off peers follow it');
});

test('we only switch off for a vote we agreed to ourselves', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  const outbox = attachControlChannel(app, 'aaaa');

  await app.handleControlMessage('aaaa', JSON.stringify({
    kind: 'e2ee-off-request', voteId: 'v1',
  }));
  assert.strictEqual(
    env.document.getElementById('e2ee-vote').classList.contains('hidden'),
    false,
    'we are asked'
  );

  app.answerDisableRequest(false);
  const reply = outbox.find((m) => m.kind === 'e2ee-off-vote');
  assert.strictEqual(reply.agree, false);

  // The proposer announcing the result anyway must not move us
  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off', voteId: 'v1' }));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
});

test('agreeing then receiving the result switches us off', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  attachControlChannel(app, 'aaaa');

  const result = {
    kind: 'e2ee-off',
    voteId: 'v2',
    peers: ['aaaa', 'zzzz'],
    agreed: ['aaaa', 'zzzz'],
  };

  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off-request', voteId: 'v2' }));
  app.answerDisableRequest(true);
  await app.handleControlMessage('aaaa', JSON.stringify(result));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);

  // ...and the same announcement replayed later does nothing
  await app.enableEncryption({ silent: true });
  await app.handleControlMessage('aaaa', JSON.stringify(result));
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'a replayed result is spent');
});

test('a vote held over part of the room does not switch anyone off', async () => {
  // Otherwise a member sends the request to one person instead of the room,
  // that person believes everyone was polled, agrees, and drops to plaintext
  // alone — visible to whoever runs the relay, and dropped by everyone else.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  ['aaaa', 'mmmm'].forEach((id) => app.participants.set(id, { id, name: id }));
  attachControlChannel(app, 'aaaa');
  attachControlChannel(app, 'mmmm');

  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off-request', voteId: 'v3' }));
  app.answerDisableRequest(true);

  // 'mmmm' is in the room but not in the announced vote
  await app.handleControlMessage('aaaa', JSON.stringify({
    kind: 'e2ee-off', voteId: 'v3', peers: ['aaaa', 'zzzz'], agreed: ['aaaa', 'zzzz'],
  }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'a partial vote decides nothing');
});

test('an agreement can only be spent by the peer it was given to', async () => {
  // Proposals are broadcast, so every member learns every vote id. Without
  // this check any of them could keep an old "yes" and cash it in later.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  ['aaaa', 'mmmm'].forEach((id) => app.participants.set(id, { id, name: id }));
  attachControlChannel(app, 'aaaa');
  attachControlChannel(app, 'mmmm');

  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off-request', voteId: 'v4' }));
  app.answerDisableRequest(true);

  // 'mmmm' merely overheard the id and announces the result itself
  await app.handleControlMessage('mmmm', JSON.stringify({
    kind: 'e2ee-off', voteId: 'v4',
    peers: ['aaaa', 'mmmm', 'zzzz'], agreed: ['aaaa', 'mmmm', 'zzzz'],
  }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
});

test('an agreement lapses with the vote it belonged to', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  attachControlChannel(app, 'aaaa');

  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off-request', voteId: 'v5' }));
  app.answerDisableRequest(true);
  // The vote is over; the proposer went quiet and only comes back much later
  app._agreedVotes.get('v5').expiresAt = Date.now() - 1;

  await app.handleControlMessage('aaaa', JSON.stringify({
    kind: 'e2ee-off', voteId: 'v5', peers: ['aaaa', 'zzzz'], agreed: ['aaaa', 'zzzz'],
  }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);
  assert.strictEqual(app._agreedVotes.has('v5'), false, 'and the stale token is dropped');
});

test('a departing proposer takes its prompt and its promise with it', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'zzzz' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  attachControlChannel(app, 'aaaa');

  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-off-request', voteId: 'v6' }));
  assert.strictEqual(
    env.document.getElementById('e2ee-vote').classList.contains('hidden'),
    false
  );

  app.handlePeerLeft('aaaa');

  assert.strictEqual(
    env.document.getElementById('e2ee-vote').classList.contains('hidden'),
    true,
    'the prompt from someone who left is taken down'
  );
  assert.strictEqual(app._incomingVote, null);
});

test('joining a room that voted encryption off does not turn it back on', async () => {
  // This is the case the vote exists for: a participant who cannot encrypt.
  // Re-enabling on the next join would make them vanish all over again.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Z' });
  attachControlChannel(app, 'zzzz');

  app._applyDisableEncryption();
  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);

  // A newcomer arrives with a key of its own
  const outbox = attachControlChannel(app, 'nnnn');
  app.participants.set('nnnn', { id: 'nnnn', name: 'N' });
  await app.handleRemoteEncryptionKey('nnnn', keyOf(7), 'nnnn', 1);

  assert.strictEqual(app.frameCryptor.encryptionEnabled, false, 'the room keeps its decision');
  assert.ok(
    outbox.some((m) => m.kind === 'e2ee-room-off'),
    'and the newcomer is told why rather than left guessing'
  );
});

test('a newcomer told the room is off follows it', async () => {
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'nnnn' });
  app.participants.set('aaaa', { id: 'aaaa', name: 'A' });
  attachControlChannel(app, 'aaaa');
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true);

  await app.handleControlMessage('aaaa', JSON.stringify({ kind: 'e2ee-room-off' }));

  assert.strictEqual(app.frameCryptor.encryptionEnabled, false);
  assert.match(env.document.getElementById('toast').textContent, /общему решению/);
});

test('a peer that cannot encrypt puts it to the room rather than vanishing', async () => {
  // With encryption on by default such a peer is simply invisible to everyone
  // and has no idea why, so the room is asked whether to switch off for them.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'aaaa' });
  app.participants.set('zzzz', { id: 'zzzz', name: 'Гость' });
  const outbox = attachControlChannel(app, 'zzzz');

  await app.handleControlMessage('zzzz', JSON.stringify({ kind: 'e2ee-unsupported' }));

  const request = outbox.find((m) => m.kind === 'e2ee-off-request');
  assert.ok(request, 'a vote is opened');
  assert.match(request.reason, /Гость/);
  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'nothing changes until they agree');
});

test('everyone enabling at once converges on one key', async () => {
  // Encryption is on from the moment of joining, so every peer arrives with a
  // key of its own at epoch 1. Same epoch, different owners: the lower owner
  // id wins, and every side computes that identically.
  const env = createBrowser({ frameEncryption: true });
  const { app } = await joinedApp(env, { clientId: 'mmmm' });
  const outbox = attachControlChannel(app, 'zzzz');

  assert.strictEqual(app.frameCryptor.encryptionEnabled, true, 'on by default');
  assert.strictEqual(app.keyOwner, 'mmmm');
  assert.strictEqual(app.keyEpoch, 1);

  // A higher owner id at the same epoch loses: we keep ours and re-assert it
  outbox.length = 0;
  await app.handleRemoteEncryptionKey('zzzz', keyOf(9), 'zzzz', 1);
  assert.ok(!app.frameCryptor.hasSameKey(new Uint8Array(keyOf(9))));
  assert.strictEqual(app.keyOwner, 'mmmm');
  assert.strictEqual(outbox[0].owner, 'mmmm');

  // A lower owner id at the same epoch outranks us
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
