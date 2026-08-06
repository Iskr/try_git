// A jsdom page with just enough of the WebRTC / media / audio platform
// stubbed out to drive public/app.js headlessly. The stubs record what the
// app asked for so tests can assert on behaviour rather than on internals.
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Every app instance arms a heartbeat interval and reconnect timers on the
// jsdom window. Left running they keep the test process alive long after the
// assertions finish, so each window is closed when the suite ends.
const openWindows = [];

function closeAll() {
  while (openWindows.length > 0) {
    const window = openWindows.pop();
    try {
      window.close();
    } catch (error) { /* already torn down */ }
  }
}

function fakeTrack(kind) {
  return {
    kind,
    enabled: true,
    readyState: 'live',
    stop() {
      this.readyState = 'ended';
    },
  };
}

function fakeStream(kinds) {
  const tracks = kinds.map(fakeTrack);
  return {
    id: `stream-${Math.random().toString(36).slice(2)}`,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  };
}

function createBrowser(options = {}) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  // app.js decides at load time whether this browser can play remote audio
  // through Web Audio, so the user agent has to be in place before it runs.
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    userAgent: options.webkit ? IPHONE_UA : CHROME_UA,
  });
  const { window } = dom;
  openWindows.push(window);
  Object.defineProperty(window.navigator, 'userAgent', {
    value: options.webkit ? IPHONE_UA : CHROME_UA,
    configurable: true,
  });

  const sent = [];
  const sockets = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
      sent.push(JSON.parse(data));
    }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      if (this.onclose) this.onclose({});
    }

    // Test-side helpers
    open() {
      this.readyState = FakeWebSocket.OPEN;
      if (this.onopen) this.onopen({});
    }

    // A real socket sits in CLOSING between close() and the peer's close
    // frame. Splitting the two lets tests cover what the app does in between.
    beginClose() {
      this.readyState = FakeWebSocket.CLOSING;
    }

    finishClose() {
      this.readyState = FakeWebSocket.CLOSED;
      if (this.onclose) this.onclose({});
    }

    deliver(message) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(message) });
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  const peerConnections = [];

  class FakeRTCPeerConnection {
    constructor(config) {
      this.config = config;
      this.signalingState = 'stable';
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.senders = [];
      this.addedCandidates = [];
      this.remoteDescriptionsApplied = [];
      this.closed = false;
      peerConnections.push(this);
    }

    createDataChannel() {
      return { readyState: 'connecting', send() {}, close() {} };
    }

    addTrack(track) {
      const sender = { track };
      this.senders.push(sender);
      return sender;
    }

    getTransceivers() {
      return [];
    }

    async createOffer() {
      return { type: 'offer', sdp: `offer-${this.senders.length}` };
    }

    async createAnswer() {
      return { type: 'answer', sdp: 'answer' };
    }

    async setLocalDescription(description) {
      if (description && description.type === 'rollback') {
        this.signalingState = 'stable';
        return;
      }
      this.localDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    }

    async setRemoteDescription(description) {
      this.remoteDescriptionsApplied.push(description);
      this.remoteDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    }

    async addIceCandidate(candidate) {
      this.addedCandidates.push(candidate);
    }

    close() {
      this.closed = true;
      this.connectionState = 'closed';
    }
  }

  const audioNode = () => ({
    connect() {},
    disconnect() {},
    gain: { value: 1, setTargetAtTime() {} },
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 },
    frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    start() {},
    stop() {},
  });

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = audioNode();
    }
    addEventListener() {}
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    createGain() {
      return audioNode();
    }
    createDynamicsCompressor() {
      return audioNode();
    }
    createMediaStreamSource() {
      return audioNode();
    }
    createOscillator() {
      return audioNode();
    }
  }

  const media = {
    calls: [],
    // Default: a normal camera+mic device
    handler: options.getUserMedia || (async (constraints) => fakeStream(constraints.video ? ['audio', 'video'] : ['audio'])),
  };

  window.WebSocket = FakeWebSocket;
  window.RTCPeerConnection = FakeRTCPeerConnection;
  window.RTCSessionDescription = function (description) {
    return description;
  };
  window.RTCIceCandidate = function (candidate) {
    return candidate;
  };
  window.AudioContext = FakeAudioContext;
  // jsdom exposes crypto as a read-only accessor and ships no subtle
  Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
  if (options.telegram) {
    // What Telegram injects into its in-app webview
    window.TelegramWebviewProxy = { postEvent() {} };
  }
  if (options.frameEncryption) {
    // Presence of this constructor is what FrameCryptor feature-detects. The
    // transforms are only installed on real senders/receivers, so the key
    // handling under test runs without needing a Worker.
    window.RTCRtpScriptTransform = function RTCRtpScriptTransform() {};
  }
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  // jsdom has no canvas backend, so getContext throws unless stubbed. Returning
  // null is also what a browser can do, and the game must survive it.
  window.HTMLCanvasElement.prototype.getContext = () => null;
  let rafId = 0;
  const rafHandles = new Map();
  window.requestAnimationFrame = (cb) => {
    rafId += 1;
    rafHandles.set(rafId, setTimeout(() => cb(Date.now()), 16));
    return rafId;
  };
  window.cancelAnimationFrame = (id) => {
    clearTimeout(rafHandles.get(id));
    rafHandles.delete(id);
  };
  window.fetch = async () => ({
    ok: true,
    json: async () => ({
      iceServers: [{ urls: ['stun:stun.example:3478'] }],
      maxParticipants: 5,
    }),
  });
  window.navigator.mediaDevices = {
    getUserMedia: (constraints) => {
      media.calls.push(constraints);
      return media.handler(constraints);
    },
  };

  // Drop app.js's own bootstrap: jsdom fires DOMContentLoaded a tick after
  // construction, which would spawn an app instance the tests never asked for.
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const bootstrap = /\/\/ Initialize app when DOM is ready[\s\S]*$/;
  if (!bootstrap.test(source)) {
    throw new Error('app.js bootstrap block not found — update test/helpers/browser-env.js');
  }

  // Class declarations inside an indirect eval stay in that eval's scope, so
  // the constructor has to be handed out explicitly.
  window.eval(`${source.replace(bootstrap, '')}\n;window.__CallingApp = CallingApp; window.__PONG = PONG;`);
  const CallingApp = window.__CallingApp;
  const PONG = window.__PONG;

  return {
    dom,
    window,
    document: window.document,
    CallingApp,
    PONG,
    media,
    sockets,
    peerConnections,
    fakeStream,
    lastSocket: () => sockets[sockets.length - 1],
  };
}

// Drives an app instance from construction to "in a call", the state most
// behaviour under test depends on.
async function joinedApp(env, { clientId = 'client-b', participants = [] } = {}) {
  const app = new env.CallingApp();
  const socket = env.lastSocket();
  socket.open();
  app.joinRoom('ROOM01');
  socket.deliver({
    type: 'joined',
    roomId: 'ROOM01',
    clientId,
    participants,
    resumeToken: 'a'.repeat(64),
  });
  // Let handleJoined's awaits (config fetch, getUserMedia) settle
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { app, socket };
}

module.exports = { createBrowser, joinedApp, fakeStream, closeAll };
