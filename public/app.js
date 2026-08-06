// Fallback WebRTC configuration. The real ICE server list (including TURN
// credentials) is fetched from /config so secrets stay in server env vars.
const DEFAULT_RTC_CONFIG = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

const MAX_PARTICIPANTS = 5;
const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;
const MAX_FLYING_REACTIONS = 40;
// Candidates buffered for a peer whose connection does not exist yet
const MAX_PENDING_CANDIDATES = 60;
// If the peer designated as offerer never offers, offer anyway after this.
const NEGOTIATION_WATCHDOG_MS = 8000;
// A rejoin refused by the per-IP throttle is retried on this backoff; the
// throttle window is a minute, so a handful of attempts covers it.
const REJOIN_RETRY_DELAY_MS = 15000;
const MAX_REJOIN_RETRIES = 5;
const CONFIG_FETCH_TIMEOUT_MS = 5000;

const AUDIO_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
};

const MEDIA_CONSTRAINTS = {
    video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
    },
    audio: AUDIO_CONSTRAINTS
};

// WebKit renders a MediaStreamAudioSourceNode built from a *remote* WebRTC
// stream as silence, and createMediaStreamSource does not throw when it
// happens — so the failure cannot be caught, only avoided. On these browsers
// remote audio has to come out of the media element itself.
const IS_IOS = (() => {
    const ua = navigator.userAgent || '';
    return /iP(hone|ad|od)/.test(ua) ||
        (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
})();

const WEBKIT_AUDIO_LIMITED = (() => {
    const ua = navigator.userAgent || '';
    const isSafari = /^((?!chrome|chromium|android|crios|fxios|edgios|edg).)*safari/i.test(ua);
    return IS_IOS || isSafari;
})();

// Telegram's in-app browser. Calls generally do work in it, so this is used
// only to give better advice when the camera is refused: there is no browser
// permission screen to send the user to, only "open in Safari".
const IN_TELEGRAM_WEBVIEW = typeof window.TelegramWebviewProxy !== 'undefined' ||
    !!(window.Telegram && window.Telegram.WebApp) ||
    /Telegram/i.test(navigator.userAgent || '');
const TELEGRAM_IOS_HINT = 'Камера недоступна в Telegram. Откройте ссылку в Safari: ' +
    '«···» внизу справа → «Открыть в Safari».';

// Faces the reactions button can wear. Deliberately wider than the reaction
// set itself — this is decoration, not a menu of what you can send.
const BUTTON_FACES = ['🥳', '😄', '😎', '🤩', '😜', '🤗', '🙃', '😺', '🦄', '✨', '🎈', '🍿'];

// Encrypted frame layout: [0xE2 0xEE 0x01][IV (12 bytes)][AES-GCM ciphertext]
const E2EE_MAGIC = new Uint8Array([0xe2, 0xee, 0x01]);
const E2EE_IV_LENGTH = 12;
const E2EE_HEADER_LENGTH = E2EE_MAGIC.length + E2EE_IV_LENGTH;
const E2EE_KEY_BYTES = 32;

// Frame encryption (AES-256-GCM, random IV per frame, fail-closed).
// Prefers the standard RTCRtpScriptTransform (worker-based); falls back to
// the legacy Chrome createEncodedStreams API. Transforms are installed on
// every sender/receiver at connection setup and pass frames through
// untouched until encryption is enabled, so toggling works at any moment
// without renegotiation.
class FrameCryptor {
    constructor() {
        this.encryptionKey = null;
        this.rawKeyData = null;
        this.encryptionEnabled = false;
        this.worker = null; // single shared worker for all script transforms
        this.installedSenders = new WeakSet();
        this.installedReceivers = new WeakSet();

        this.useScriptTransform = typeof RTCRtpScriptTransform !== 'undefined';
        this.useLegacyStreams = !this.useScriptTransform &&
            typeof RTCRtpSender !== 'undefined' &&
            typeof RTCRtpSender.prototype.createEncodedStreams === 'function';
    }

    get supported() {
        return this.useScriptTransform || this.useLegacyStreams;
    }

    _getWorker() {
        if (!this.worker) {
            this.worker = new Worker('encryption-worker.js');
            if (this.rawKeyData) {
                this.worker.postMessage({ type: 'setKey', keyData: Array.from(this.rawKeyData) });
            }
            this.worker.postMessage({ type: this.encryptionEnabled ? 'enable' : 'disable' });
        }
        return this.worker;
    }

    async setKey(keyData) {
        const raw = new Uint8Array(keyData);
        if (raw.length !== E2EE_KEY_BYTES) {
            throw new Error('Invalid key length');
        }
        this.rawKeyData = raw;
        this.encryptionKey = await crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
        if (this.worker) {
            this.worker.postMessage({ type: 'setKey', keyData: Array.from(raw) });
        }
    }

    hasSameKey(keyData) {
        if (!this.rawKeyData || this.rawKeyData.length !== keyData.length) return false;
        // Not constant-time, but both values belong to the same trust domain.
        return this.rawKeyData.every((b, i) => b === keyData[i]);
    }

    enable() {
        this.encryptionEnabled = true;
        if (this.worker) this.worker.postMessage({ type: 'enable' });
    }

    disable() {
        this.encryptionEnabled = false;
        if (this.worker) this.worker.postMessage({ type: 'disable' });
    }

    reset() {
        this.disable();
        this.encryptionKey = null;
        this.rawKeyData = null;
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.installedSenders = new WeakSet();
        this.installedReceivers = new WeakSet();
    }

    // --- Legacy Chrome path (main thread) ---

    _isEncryptedFrame(data) {
        return data.length > E2EE_HEADER_LENGTH
            && data[0] === E2EE_MAGIC[0]
            && data[1] === E2EE_MAGIC[1]
            && data[2] === E2EE_MAGIC[2];
    }

    async encryptFrame(encodedFrame, controller) {
        if (!this.encryptionEnabled) {
            controller.enqueue(encodedFrame);
            return;
        }
        if (!this.encryptionKey) {
            // Enabled but the key is not ready — fail closed.
            return;
        }
        try {
            const data = new Uint8Array(encodedFrame.data);
            const iv = crypto.getRandomValues(new Uint8Array(E2EE_IV_LENGTH));
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.encryptionKey, data);
            const out = new Uint8Array(E2EE_HEADER_LENGTH + encrypted.byteLength);
            out.set(E2EE_MAGIC, 0);
            out.set(iv, E2EE_MAGIC.length);
            out.set(new Uint8Array(encrypted), E2EE_HEADER_LENGTH);
            encodedFrame.data = out.buffer;
            controller.enqueue(encodedFrame);
        } catch (error) {
            // Fail closed: never let a plaintext frame leave while encryption
            // is on — drop it instead.
        }
    }

    async decryptFrame(encodedFrame, controller) {
        const data = new Uint8Array(encodedFrame.data);
        if (!this._isEncryptedFrame(data)) {
            // Plaintext frame. Render it only while encryption is off — once
            // the user sees the lock indicator, unencrypted media must not
            // slip through (fail closed on receive as well as send).
            if (this.encryptionEnabled) return;
            controller.enqueue(encodedFrame);
            return;
        }
        if (!this.encryptionKey) {
            return; // encrypted, but no key yet — drop until the key arrives
        }
        try {
            const iv = data.slice(E2EE_MAGIC.length, E2EE_HEADER_LENGTH);
            const payload = data.slice(E2EE_HEADER_LENGTH);
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.encryptionKey, payload);
            encodedFrame.data = decrypted;
            controller.enqueue(encodedFrame);
        } catch (error) {
            // Drop frames that fail authentication.
        }
    }

    // --- Public API ---

    setupSenderTransform(sender) {
        if (!this.supported || this.installedSenders.has(sender)) return;
        this.installedSenders.add(sender);

        if (this.useScriptTransform) {
            sender.transform = new RTCRtpScriptTransform(this._getWorker(), { side: 'sender' });
        } else {
            const streams = sender.createEncodedStreams();
            const transform = new TransformStream({
                transform: (frame, controller) => this.encryptFrame(frame, controller)
            });
            streams.readable.pipeThrough(transform).pipeTo(streams.writable);
        }
    }

    setupReceiverTransform(receiver) {
        if (!this.supported || this.installedReceivers.has(receiver)) return;
        this.installedReceivers.add(receiver);

        if (this.useScriptTransform) {
            receiver.transform = new RTCRtpScriptTransform(this._getWorker(), { side: 'receiver' });
        } else {
            const streams = receiver.createEncodedStreams();
            const transform = new TransformStream({
                transform: (frame, controller) => this.decryptFrame(frame, controller)
            });
            streams.readable.pipeThrough(transform).pipeTo(streams.writable);
        }
    }
}

// --- Ping-pong -------------------------------------------------------------
// A fixed logical field in every orientation and on every device: both peers
// simulate identical geometry, so screen size can never cause a desync. The
// host owns the simulation; the guest sends its paddle and renders what it is
// told, predicting only its own paddle so its input feels instant.
const PONG = {
    W: 300,
    H: 400,
    PADDLE_W: 62,
    PADDLE_H: 10,
    PADDLE_INSET: 22,
    BALL_R: 6,
    SPEED_START: 165,
    SPEED_MAX: 300,
    SPEED_GAIN: 1.045,
    KEY_SPEED: 320,
    STEP: 1 / 60,
    SEND_HZ: 20,
    SERVE_FREEZE_MS: 1100,
    WIN_SCORE: 5,
};

function pongClamp(value, min, max) {
    // Number.isFinite first: `typeof Infinity === 'number'`, and one NaN
    // reaching the integrator freezes the board for the rest of the game.
    if (!Number.isFinite(value)) return null;
    return Math.min(max, Math.max(min, value));
}

class PongGame {
    constructor(options) {
        this.canvas = options.canvas;
        this.isHost = options.isHost;
        this.send = options.send;
        this.onScore = options.onScore || (() => {});
        this.onOver = options.onOver || (() => {});
        this.onMessage = options.onMessage || (() => {});

        this.myScore = 0;
        this.theirScore = 0;
        this.over = false;

        // Canonical state: host paddle at the bottom, guest at the top.
        this.hostX = PONG.W / 2;
        this.guestX = PONG.W / 2;
        this.ball = { x: PONG.W / 2, y: PONG.H / 2, vx: 0, vy: 0 };
        this.freezeMs = PONG.SERVE_FREEZE_MS;

        // Guest-side view of the authoritative state
        this.remote = null;
        this.remoteAt = 0;

        this._keys = new Set();
        this._raf = null;
        this._lastFrame = 0;
        this._accumulator = 0;
        this._sendAccumulator = 0;
        this._lastSentX = null;
        this._paused = false;
        // A phone renders at 30fps: this loop runs next to video decode and,
        // with E2EE on, per-frame AES-GCM.
        this._frameBudget = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ? 1 / 30 : 0;
        this._sinceDraw = 0;
    }

    get myPaddleX() {
        return this.isHost ? this.hostX : this.guestX;
    }

    set myPaddleX(x) {
        const clamped = Math.min(PONG.W - PONG.PADDLE_W / 2, Math.max(PONG.PADDLE_W / 2, x));
        if (this.isHost) this.hostX = clamped;
        else this.guestX = clamped;
    }

    start() {
        if (this._raf !== null) return;
        this._lastFrame = 0;
        if (this.isHost) this._serve(Math.random() < 0.5 ? 1 : -1);
        this.onMessage('Приготовьтесь…');
        this._loop = this._loop.bind(this);
        this._raf = requestAnimationFrame(this._loop);
    }

    stop() {
        if (this._raf !== null) {
            cancelAnimationFrame(this._raf);
            this._raf = null;
        }
        this._keys.clear();
    }

    setPaused(paused) {
        this._paused = paused;
        // Restart the clock: a frame delta spanning the pause would integrate
        // the ball straight through a paddle.
        this._lastFrame = 0;
    }

    // The board is drawn from the local player's point of view — your paddle is
    // always the near one — which for the guest is the canonical field rotated
    // by 180 degrees, exactly like sitting at the other end of a table.
    _project(x, y) {
        return this.isHost ? { x, y } : { x: PONG.W - x, y: PONG.H - y };
    }

    // Canonical Y of each paddle. The host defends the bottom of the canonical
    // field and the guest the top; _project then turns whichever is ours into
    // the near edge of our own screen.
    _paddleEnds() {
        const bottom = PONG.H - PONG.PADDLE_INSET;
        const top = PONG.PADDLE_INSET;
        return this.isHost ? { mine: bottom, theirs: top } : { mine: top, theirs: bottom };
    }

    pointerToPaddleX(clientX) {
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width) return null;
        const local = ((clientX - rect.left) / rect.width) * PONG.W;
        return this.isHost ? local : PONG.W - local;
    }

    onKeyDown(code) {
        this._keys.add(code);
    }

    onKeyUp(code) {
        this._keys.delete(code);
    }

    // --- Simulation (host only) ---

    _serve(direction) {
        this.ball.x = PONG.W / 2;
        this.ball.y = PONG.H / 2;
        const angle = (Math.random() - 0.5) * 0.7;
        this.ball.vx = Math.sin(angle) * PONG.SPEED_START;
        this.ball.vy = Math.cos(angle) * PONG.SPEED_START * direction;
        this.freezeMs = PONG.SERVE_FREEZE_MS;
    }

    _step(dt) {
        if (this.freezeMs > 0) {
            this.freezeMs -= dt * 1000;
            if (this.freezeMs > 0) return;
            this.onMessage(null);
        }

        const ball = this.ball;
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;

        if (ball.x < PONG.BALL_R) {
            ball.x = PONG.BALL_R;
            ball.vx = Math.abs(ball.vx);
        } else if (ball.x > PONG.W - PONG.BALL_R) {
            ball.x = PONG.W - PONG.BALL_R;
            ball.vx = -Math.abs(ball.vx);
        }

        const guestPlane = PONG.PADDLE_INSET + PONG.PADDLE_H / 2 + PONG.BALL_R;
        const hostPlane = PONG.H - PONG.PADDLE_INSET - PONG.PADDLE_H / 2 - PONG.BALL_R;

        if (ball.vy < 0 && ball.y <= guestPlane) {
            if (Math.abs(ball.x - this.guestX) <= PONG.PADDLE_W / 2 + PONG.BALL_R) {
                this._bounce(guestPlane, this.guestX, 1);
            } else if (ball.y < -PONG.BALL_R * 2) {
                this._goal(true);
            }
        } else if (ball.vy > 0 && ball.y >= hostPlane) {
            if (Math.abs(ball.x - this.hostX) <= PONG.PADDLE_W / 2 + PONG.BALL_R) {
                this._bounce(hostPlane, this.hostX, -1);
            } else if (ball.y > PONG.H + PONG.BALL_R * 2) {
                this._goal(false);
            }
        }
    }

    _bounce(plane, paddleX, direction) {
        const ball = this.ball;
        ball.y = plane;
        const offset = (ball.x - paddleX) / (PONG.PADDLE_W / 2);
        const speed = Math.min(PONG.SPEED_MAX, Math.hypot(ball.vx, ball.vy) * PONG.SPEED_GAIN);
        // Steer with the paddle: hitting off-centre angles the return.
        const angle = offset * 0.9;
        ball.vx = Math.sin(angle) * speed;
        ball.vy = Math.cos(angle) * speed * direction;
    }

    // Only ever runs on the host: goals are detected in _step, which the guest
    // never executes. So "host scored" and "I scored" are the same thing here,
    // and the scores on the wire are always (host, guest).
    _goal(hostScored) {
        if (hostScored) this.myScore += 1;
        else this.theirScore += 1;
        this.over = this.myScore >= PONG.WIN_SCORE || this.theirScore >= PONG.WIN_SCORE;
        this.onScore(this.myScore, this.theirScore);
        this.send({ op: 'score', h: this.myScore, g: this.theirScore });
        if (this.over) {
            this.onMessage(hostScored ? 'Вы выиграли!' : 'Вы проиграли');
            this.onOver(hostScored);
            return;
        }
        this._serve(hostScored ? -1 : 1);
    }

    // --- Messages from the opponent (already validated by the caller) ---

    receive(msg) {
        if (msg.op === 'input') {
            const x = pongClamp(msg.x, 0, PONG.W);
            if (x === null) return;
            if (this.isHost) this.guestX = x;
            return;
        }
        if (msg.op === 'state') {
            if (this.isHost) return; // the host is the authority; ignore
            const bx = pongClamp(msg.bx, -PONG.W, PONG.W * 2);
            const by = pongClamp(msg.by, -PONG.H, PONG.H * 2);
            const vx = pongClamp(msg.vx, -PONG.SPEED_MAX * 2, PONG.SPEED_MAX * 2);
            const vy = pongClamp(msg.vy, -PONG.SPEED_MAX * 2, PONG.SPEED_MAX * 2);
            const hx = pongClamp(msg.hx, 0, PONG.W);
            const gx = pongClamp(msg.gx, 0, PONG.W);
            if ([bx, by, vx, vy, hx, gx].some((v) => v === null)) return;
            // The guest never runs _step, so this is the only place it can
            // learn the serve countdown is over.
            if (vx !== 0 || vy !== 0) this.onMessage(null);
            this.remote = { bx, by, vx, vy, hx, gx };
            this.remoteAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.hostX = hx;
            // Snap only when the host's view of us has drifted badly — normally
            // our own prediction is what we render.
            if (Math.abs(gx - this.guestX) > 30) this.guestX = gx;
            return;
        }
        if (msg.op === 'score') {
            const h = pongClamp(msg.h, 0, 99);
            const g = pongClamp(msg.g, 0, 99);
            if (h === null || g === null) return;
            this.myScore = this.isHost ? h : g;
            this.theirScore = this.isHost ? g : h;
            this.over = this.myScore >= PONG.WIN_SCORE || this.theirScore >= PONG.WIN_SCORE;
            this.onScore(this.myScore, this.theirScore);
            if (this.over) {
                const iWon = this.myScore > this.theirScore;
                this.onMessage(iWon ? 'Вы выиграли!' : 'Вы проиграли');
                this.onOver(iWon);
            }
        }
    }

    // --- Loop ---

    _loop(now) {
        this._raf = requestAnimationFrame(this._loop);
        if (this._paused) {
            this._lastFrame = now;
            return;
        }
        if (!this._lastFrame) this._lastFrame = now;
        // Clamped: requestAnimationFrame stops in a background tab, and a
        // multi-second delta would teleport the ball through a paddle.
        let dt = Math.min((now - this._lastFrame) / 1000, 0.25);
        this._lastFrame = now;
        if (dt < 0) dt = 0;

        this._applyKeys(dt);

        if (this.isHost && !this.over) {
            this._accumulator += dt;
            let steps = 0;
            while (this._accumulator >= PONG.STEP && steps < 20) {
                this._step(PONG.STEP);
                this._accumulator -= PONG.STEP;
                steps += 1;
            }
        }

        this._sendAccumulator += dt;
        if (this._sendAccumulator >= 1 / PONG.SEND_HZ) {
            this._sendAccumulator = 0;
            this._sendTick();
        }

        this._sinceDraw += dt;
        if (this._sinceDraw >= this._frameBudget) {
            this._sinceDraw = 0;
            this.draw();
        }

        // Nothing moves after the final point: draw the result once and let the
        // loop go, rather than spinning until the user presses exit.
        if (this.over) {
            this.draw();
            this.stop();
        }
    }

    _applyKeys(dt) {
        let dir = 0;
        if (this._keys.has('ArrowLeft') || this._keys.has('KeyA')) dir -= 1;
        if (this._keys.has('ArrowRight') || this._keys.has('KeyD')) dir += 1;
        if (dir !== 0) this.myPaddleX = this.myPaddleX + dir * PONG.KEY_SPEED * dt;
    }

    _sendTick() {
        if (this.over) return;
        if (this.isHost) {
            const round = (v) => Math.round(v * 10) / 10;
            this.send({
                op: 'state',
                bx: round(this.ball.x),
                by: round(this.ball.y),
                vx: round(this.ball.vx),
                vy: round(this.ball.vy),
                hx: round(this.hostX),
                gx: round(this.guestX),
            });
        } else {
            const x = Math.round(this.guestX * 10) / 10;
            // Absolute position, and only when it moved: a dropped message is
            // fully corrected by the next one, and a still paddle sends nothing.
            if (this._lastSentX !== null && Math.abs(x - this._lastSentX) < 0.3) return;
            this._lastSentX = x;
            this.send({ op: 'input', x });
        }
    }

    // --- Rendering ---

    _ballNow() {
        if (this.isHost || !this.remote) return this.ball;
        // Extrapolate from arrival time: there is no clock sync in this app, so
        // a remote timestamp would apply an unknown constant offset.
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const t = Math.min((now - this.remoteAt) / 1000, 0.5);
        return {
            x: this.remote.bx + this.remote.vx * t,
            y: this.remote.by + this.remote.vy * t,
        };
    }

    draw() {
        const ctx = this.canvas.getContext ? this.canvas.getContext('2d') : null;
        if (!ctx) return; // jsdom, and any browser that refuses the context

        const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
        const w = PONG.W * dpr;
        const h = PONG.H * dpr;
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = '#10131a';
        ctx.fillRect(0, 0, PONG.W, PONG.H);

        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(0, PONG.H / 2 - 1, PONG.W, 2);

        // These are canonical coordinates, so which end each paddle sits at
        // depends on the role — passing the host's end for everyone made
        // _project rotate it a second time for the guest, putting the guest's
        // own paddle at the top of its screen while the ball it had to block
        // arrived at the bottom.
        const ends = this._paddleEnds();
        const mine = this._project(this.myPaddleX, ends.mine);
        const theirCanonicalX = this.isHost ? this.guestX : this.hostX;
        const theirs = this._project(theirCanonicalX, ends.theirs);

        ctx.fillStyle = '#667eea';
        ctx.fillRect(mine.x - PONG.PADDLE_W / 2, mine.y - PONG.PADDLE_H / 2, PONG.PADDLE_W, PONG.PADDLE_H);
        ctx.fillStyle = '#f56565';
        ctx.fillRect(theirs.x - PONG.PADDLE_W / 2, theirs.y - PONG.PADDLE_H / 2, PONG.PADDLE_W, PONG.PADDLE_H);

        const ball = this._ballNow();
        const b = this._project(ball.x, ball.y);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(b.x, b.y, PONG.BALL_R, 0, Math.PI * 2);
        ctx.fill();
    }
}

class CallingApp {
    constructor() {
        this.ws = null;
        this.peerConnections = new Map(); // Map<clientId, RTCPeerConnection>
        this.controlChannels = new Map(); // Map<clientId, RTCDataChannel>
        this.localStream = null;
        this.roomId = null;
        this.clientId = null;
        this.resumeToken = null;
        this.participants = new Map(); // Map<clientId, participantInfo>
        this.isAudioEnabled = true;
        this.isVideoEnabled = true;
        this.pendingIceCandidates = new Map(); // Map<clientId, ICECandidate[]>
        this.pendingJoinRoomId = null;
        this._lastRequestedRoom = null;
        this._joining = false;
        // Set while a rejoin is in flight so a room-full/error reply can be
        // told apart from an unrelated mid-call error.
        this._rejoining = false;
        // Single-flight guard for getUserMedia: two concurrent captures would
        // orphan one stream whose tracks keep the camera on and ignore mute.
        this._mediaPromise = null;
        // Bumped whenever a call ends, so a capture still in flight knows its
        // result is no longer wanted.
        this._mediaGeneration = 0;
        // Peers whose offer we are waiting for, so a lost offer cannot stall
        // the pair forever. Map<clientId, timeoutId>
        this._negotiationTimers = new Map();
        this._sessionCounter = 0;
        // The room converges on the key with the highest (epoch, lowest owner
        // id). keyOwner is who announced it; keyEpoch counts rotations.
        this.keyOwner = null;
        this.keyEpoch = 0;

        this.rtcConfig = DEFAULT_RTC_CONFIG;
        this.maxParticipants = MAX_PARTICIPANTS;

        this.videosContainer = null;
        this.layoutMode = localStorage.getItem('layoutMode') || 'auto'; // grid, spotlight, sidebar, compact, auto

        this.frameCryptor = new FrameCryptor();

        // Connection resilience
        this._wsReconnectAttempt = 0;
        this._wsReconnectTimer = null;
        this._wsMaxReconnectAttempts = 10;
        this._heartbeatTimer = null;
        this._heartbeatTimeout = null;
        this._iceRestartAttempts = new Map(); // Map<clientId, attemptCount>
        this._iceRestartTimers = new Map();
        this._maxIceRestarts = 4;
        // Full rebuild cycles per peer. Without a ceiling here the recovery
        // loop never ends: a full reconnect resets the ICE-restart counter, so
        // an unreachable peer would be retried forever.
        this._peerReconnectAttempts = new Map();
        this._maxPeerReconnects = 3;

        // Ping-pong. `game` is the only long-lived object here, and it owns
        // exactly one timer (its rAF handle), so there is one thing to stop.
        this.game = null;
        this.gameOpponentId = null;
        this.invitedPeer = null;
        this.pendingInviteFrom = null;

        // Reactions system
        this.reactions = ['❤️', '👍', '😂', '😮', '😢', '🔥', '🎉', '👏', '💯', '🚀'];
        this.reactionCounts = this.loadReactionCounts();
        this.audioContext = null;

        // Volume control system. Settings are per-call only: client ids are
        // ephemeral, so persisting them would just accumulate garbage.
        this.audioContexts = new Map(); // Map<clientId, {context, gainNode, source}>
        this.volumeSettings = {};
        this.currentVolumeTarget = null;
        // On WebKit the Web Audio output graph is silent for remote streams,
        // so audio plays from the media element and per-participant gain is
        // reduced to mute/unmute.
        this.useWebAudioOutput = !WEBKIT_AUDIO_LIMITED;
        try { localStorage.removeItem('volumeSettings'); } catch (e) { /* ignore */ }

        this.initUI();
        // Peer connections must not be built before the ICE config arrives, or
        // the first call of the session silently runs without TURN.
        this._configPromise = this.loadIceConfig();
        this.connectWebSocket();
    }

    async loadIceConfig() {
        // Negotiation waits on this, so it must not be able to hang: a stalled
        // request would stall every offer instead of falling back to STUN.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), CONFIG_FETCH_TIMEOUT_MS);
        try {
            const res = await fetch('/config', { signal: abort.signal });
            if (!res.ok) return;
            const cfg = await res.json();
            if (Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0) {
                this.rtcConfig = { ...this.rtcConfig, iceServers: cfg.iceServers };
            }
            if (Number.isInteger(cfg.maxParticipants) && cfg.maxParticipants > 1) {
                // The grid CSS supports at most 6 tiles
                this.maxParticipants = Math.min(cfg.maxParticipants, 6);
            }
        } catch (error) {
            console.warn('Failed to load ICE config, using defaults:', error);
        } finally {
            clearTimeout(timer);
        }
    }

    initUI() {
        // Screen elements
        this.homeScreen = document.getElementById('home-screen');
        this.callScreen = document.getElementById('call-screen');

        // Home screen buttons
        document.getElementById('create-call-btn').addEventListener('click', () => this.createCall());
        document.getElementById('join-call-btn').addEventListener('click', () => this.toggleJoinInput());
        document.getElementById('join-submit-btn').addEventListener('click', () => this.joinCall());
        document.getElementById('room-id-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.joinCall();
        });

        // Call screen controls
        document.getElementById('toggle-audio-btn').addEventListener('click', () => this.toggleAudio());
        document.getElementById('toggle-video-btn').addEventListener('click', () => this.toggleVideo());
        document.getElementById('toggle-encryption-btn').addEventListener('click', () => this.toggleEncryption());
        document.getElementById('reactions-btn').addEventListener('click', () => this.toggleReactionsDropdown());
        document.getElementById('end-call-btn').addEventListener('click', () => this.endCall());
        document.getElementById('copy-link-btn').addEventListener('click', () => this.copyLink());
        document.getElementById('share-telegram-btn').addEventListener('click', () => this.shareTelegram());

        if (!this.frameCryptor.supported) {
            const encryptionBtn = document.getElementById('toggle-encryption-btn');
            encryptionBtn.title = 'Шифрование не поддерживается в этом браузере';
            encryptionBtn.setAttribute('aria-disabled', 'true');
        }

        // Layout controls
        document.getElementById('layout-btn').addEventListener('click', () => this.toggleLayoutSelector());

        // Layout options
        document.querySelectorAll('.layout-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const layout = e.currentTarget.dataset.layout;
                this.setLayout(layout);
            });
        });

        // Close layout selector when clicking outside
        document.addEventListener('click', (e) => {
            const layoutSelector = document.getElementById('layout-selector');
            const layoutBtn = document.getElementById('layout-btn');
            if (!layoutSelector.contains(e.target) && !layoutBtn.contains(e.target)) {
                layoutSelector.classList.add('hidden');
            }

            // Close reactions dropdown when clicking outside
            const reactionsDropdown = document.getElementById('reactions-dropdown');
            const reactionsBtn = document.getElementById('reactions-btn');
            if (!reactionsDropdown.contains(e.target) && !reactionsBtn.contains(e.target)) {
                reactionsDropdown.classList.add('hidden');
            }

            // Close the opponent picker when clicking outside
            const gameMenu = document.getElementById('game-menu');
            const gameBtn = document.getElementById('game-btn');
            if (!gameMenu.contains(e.target) && !gameBtn.contains(e.target)) {
                gameMenu.classList.add('hidden');
            }

            // Close volume control when clicking outside
            const volumeControl = document.getElementById('volume-control');
            const volumeBtns = document.querySelectorAll('.volume-btn');
            let clickedVolumeBtn = false;
            volumeBtns.forEach(btn => {
                if (btn.contains(e.target)) clickedVolumeBtn = true;
            });
            if (!volumeControl.contains(e.target) && !clickedVolumeBtn) {
                volumeControl.classList.add('hidden');
            }

            // Hide video controls when clicking outside video wrappers
            const videoWrappers = document.querySelectorAll('.video-wrapper');
            let clickedVideoWrapper = false;
            videoWrappers.forEach(wrapper => {
                if (wrapper.contains(e.target)) clickedVideoWrapper = true;
            });
            if (!clickedVideoWrapper) {
                document.querySelectorAll('.video-wrapper.show-controls').forEach(w => {
                    w.classList.remove('show-controls');
                });
            }
        });

        // Volume slider event listeners
        const volumeSlider = document.getElementById('volume-slider');
        const volumeValue = document.getElementById('volume-value');

        volumeSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            volumeValue.textContent = value + '%';

            if (this.currentVolumeTarget) {
                this.setParticipantVolume(this.currentVolumeTarget, value / 100);
            }
        });

        // Video container
        this.videosContainer = document.getElementById('videos-container');

        this.initGameUI();

        // Best-effort leave so peers are notified even on tab close. A page
        // going into the back/forward cache is coming back, so it must keep
        // its seat.
        window.addEventListener('pagehide', (e) => {
            if (e.persisted) return;
            if (this.roomId && this.ws && this.ws.readyState === WebSocket.OPEN) {
                try { this.ws.send(JSON.stringify({ type: 'leave' })); } catch (err) { /* ignore */ }
            }
        });

        window.addEventListener('pageshow', (e) => {
            if (e.persisted && this.roomId) {
                this._resumeAfterInterruption();
            }
        });

        // Coming back from a background tab, a phone call or a dead network:
        // reconnect immediately instead of waiting out the backoff, and wake
        // the AudioContext that iOS suspends during audio interruptions.
        window.addEventListener('online', () => this._resumeAfterInterruption());
        document.addEventListener('visibilitychange', () => {
            // requestAnimationFrame stops in a hidden tab; pausing explicitly
            // keeps the simulation from trying to catch up on return.
            if (this.game) this.game.setPaused(document.hidden);
            if (!document.hidden) this._resumeAfterInterruption();
        });

        this.shuffleReactionsButton();

        // Check URL for room ID
        const urlParams = new URLSearchParams(window.location.search);
        const roomIdFromUrl = urlParams.get('room');
        if (roomIdFromUrl) {
            document.getElementById('room-id-input').value = roomIdFromUrl;
            this.toggleJoinInput();
        }
    }

    connectWebSocket() {
        // Detach the previous socket first: its onclose would otherwise
        // schedule another reconnect and leave two live connections racing.
        // Its heartbeat goes too — a pending pong timeout fires against
        // this.ws, which by then is the new socket.
        this._stopHeartbeat();
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { /* already gone */ }
            }
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this._wsReconnectAttempt = 0;

            if (this.pendingJoinRoomId) {
                const roomId = this.pendingJoinRoomId;
                this.pendingJoinRoomId = null;
                this._sendWs({ type: 'join', roomId });
            } else if (this.roomId && this.clientId && this.resumeToken) {
                // We were in a call — rejoin the room with our old identity
                console.log('Rejoining room after reconnect...');
                this._rejoining = true;
                this._sendWs({
                    type: 'rejoin',
                    roomId: this.roomId,
                    clientId: this.clientId,
                    resumeToken: this.resumeToken
                });
                this.showToast('Соединение восстановлено');
            }

            this._startHeartbeat();
        };

        this.ws.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (error) {
                console.error('Malformed message from server');
                return;
            }
            if (!message || typeof message.type !== 'string') return;
            if (message.type === 'pong') {
                clearTimeout(this._heartbeatTimeout);
                return;
            }
            this.handleSignalingMessage(message);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this._stopHeartbeat();

            // If the socket died between our 'join' and the server's 'joined',
            // queue the join again so the reconnect retries it.
            if (this._joining && !this.roomId && !this.pendingJoinRoomId && this._lastRequestedRoom) {
                this.pendingJoinRoomId = this._lastRequestedRoom;
            }

            if (this.roomId || this.pendingJoinRoomId) {
                this.updateConnectionStatus('Переподключение...', false);
                this._scheduleReconnect();
            }
        };
    }

    // A rejoin refused for a transient reason (throttle, overloaded server).
    // The seat is still ours, so wait it out instead of ending the call.
    _retryRejoin() {
        clearTimeout(this._rejoinRetryTimer);
        this._rejoinRetryAttempt = (this._rejoinRetryAttempt || 0) + 1;
        if (this._rejoinRetryAttempt > MAX_REJOIN_RETRIES) {
            this._rejoining = false;
            this.showToast('Не удалось вернуться в звонок');
            this.endCall();
            return;
        }
        this.updateConnectionStatus('Переподключение...', false);
        this._rejoinRetryTimer = setTimeout(() => {
            if (!this.roomId || !this.clientId || !this.resumeToken) return;
            this._rejoining = true;
            this._sendWs({
                type: 'rejoin',
                roomId: this.roomId,
                clientId: this.clientId,
                resumeToken: this.resumeToken
            });
        }, REJOIN_RETRY_DELAY_MS * this._rejoinRetryAttempt);
    }

    // Called whenever the page or the network comes back to life.
    _resumeAfterInterruption() {
        if (this.audioContext && this.audioContext.state !== 'running') {
            this.audioContext.resume().catch(() => { /* needs a gesture */ });
        }
        if (!this.roomId && !this.pendingJoinRoomId) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        // Give up the backoff — the outage we were backing off from is over.
        this._cancelReconnect();
        this.connectWebSocket();
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this._heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));

                // If no pong received within 5 seconds, connection is dead
                this._heartbeatTimeout = setTimeout(() => {
                    console.warn('Heartbeat timeout — closing WebSocket');
                    if (this.ws) this.ws.close();
                }, 5000);
            }
        }, 15000);
    }

    _stopHeartbeat() {
        clearInterval(this._heartbeatTimer);
        clearTimeout(this._heartbeatTimeout);
        this._heartbeatTimer = null;
        this._heartbeatTimeout = null;
    }

    _scheduleReconnect() {
        if (this._wsReconnectAttempt >= this._wsMaxReconnectAttempts) {
            this._joining = false;
            this.pendingJoinRoomId = null;
            if (this.roomId) {
                // Staying on a call screen that can no longer signal is worse
                // than ending the call: nothing would ever recover it, and the
                // stale roomId blocks the user from starting a new one. The
                // 'online' listener still catches a network that comes back
                // before this point.
                this.showToast('Соединение потеряно — звонок завершён');
                this.endCall();
                return;
            }
            this.showToast('Не удалось восстановить соединение');
            this.updateConnectionStatus('Отключено', false);
            return;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
        const delay = Math.min(1000 * Math.pow(2, this._wsReconnectAttempt), 30000);
        this._wsReconnectAttempt++;

        console.log(`WebSocket reconnect attempt ${this._wsReconnectAttempt} in ${delay}ms`);
        this._wsReconnectTimer = setTimeout(() => {
            this.connectWebSocket();
        }, delay);
    }

    _cancelReconnect() {
        clearTimeout(this._wsReconnectTimer);
        this._wsReconnectTimer = null;
        this._wsReconnectAttempt = 0;
    }

    _sendWs(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
            return true;
        }
        console.warn('WebSocket not connected, message dropped:', data.type);
        return false;
    }

    async handleSignalingMessage(message) {
        console.log('Received message:', message.type);

        switch (message.type) {
            case 'joined':
                await this.handleJoined(message);
                break;

            case 'peer-joined':
                if (typeof message.clientId !== 'string') break;
                if (this.participants.has(message.clientId)) {
                    // The same identity was re-announced: the peer reconnected.
                    // Its old session (and the data channel inside it) is dead
                    // — drop it so negotiation restarts on a fresh connection.
                    this._dropPeerSession(message.clientId);
                } else {
                    if (this.participants.size >= this.maxParticipants) {
                        console.warn('Max participants reached');
                        break;
                    }
                    this.participants.set(message.clientId, {
                        id: message.clientId,
                        name: `Участник ${message.clientId.slice(0, 4)}`
                    });
                }
                this.updateConnectionStatus(this.participantsLabel());
                await this._beginNegotiation(message.clientId);
                break;

            case 'offer':
                await this.handleOffer(message);
                break;

            case 'answer':
                await this.handleAnswer(message);
                break;

            case 'ice-candidate':
                await this.handleIceCandidate(message);
                break;

            case 'peer-left':
                this.handlePeerLeft(message.clientId);
                break;

            case 'room-full':
                this._joining = false;
                if (this._rejoining) {
                    // Our seat was given away while we were offline. Nothing
                    // the client does from here reaches the room, so end the
                    // call instead of leaving a frozen call screen behind.
                    this._rejoining = false;
                    this.showToast('Место в звонке занято — звонок завершён');
                    this.endCall();
                    break;
                }
                this.showToast(`Звонок заполнен (максимум ${message.maxParticipants || this.maxParticipants} участников)`);
                if (!this.localStream) {
                    this.roomId = null;
                }
                break;

            case 'error':
                this._joining = false;
                this.showToast(message.text || 'Ошибка сервера');
                // Only a failed rejoin is fatal, and only when it failed for
                // good: an unrelated mid-call error must not tear down a
                // working call, and a throttle or an overloaded server is
                // worth waiting out — the seat is still ours.
                if (this._rejoining) {
                    if (message.code === 'too-many-joins' || message.code === 'server-busy') {
                        this._retryRejoin();
                    } else {
                        this._rejoining = false;
                        this.endCall();
                    }
                }
                break;
        }
    }

    async handleJoined(message) {
        this._joining = false;
        this._rejoining = false;
        this._rejoinRetryAttempt = 0;
        clearTimeout(this._rejoinRetryTimer);
        this.roomId = message.roomId;
        this.clientId = message.clientId;
        if (typeof message.resumeToken === 'string') {
            this.resumeToken = message.resumeToken;
        }

        // Stale peer connections (e.g. from before a reconnect) cannot be
        // reused — tear everything down and renegotiate from scratch.
        this.teardownPeers();

        this.participants.clear();
        this.participants.set(this.clientId, { id: this.clientId, name: 'Вы' });

        const ok = await this.startCall();
        if (!ok) return;

        const others = Array.isArray(message.participants) ? message.participants : [];
        for (const participantId of others) {
            if (typeof participantId !== 'string' || participantId === this.clientId) continue;
            this.participants.set(participantId, {
                id: participantId,
                name: `Участник ${participantId.slice(0, 4)}`
            });
            await this._beginNegotiation(participantId);
        }
        this.updateConnectionStatus(this.participantsLabel());
    }

    // Exactly one side of a pair offers, chosen by comparing client ids, so
    // two peers reconnecting at the same moment cannot both offer and end up
    // answering each other's dead sessions.
    _shouldOffer(remoteClientId) {
        return this.clientId < remoteClientId;
    }

    async _beginNegotiation(remoteClientId) {
        this._clearNegotiationWatchdog(remoteClientId);
        if (this._shouldOffer(remoteClientId)) {
            await this.createOffer(remoteClientId);
            return;
        }
        // We are the answerer. If the offer never arrives (a dropped message,
        // a peer that crashed mid-negotiation), offer ourselves rather than
        // waiting forever; the glare rules below settle any collision.
        this._negotiationTimers.set(remoteClientId, setTimeout(() => {
            this._negotiationTimers.delete(remoteClientId);
            const pc = this.peerConnections.get(remoteClientId);
            if (!this.participants.has(remoteClientId)) return;
            if (pc && (pc.remoteDescription || pc.connectionState === 'connected')) return;
            console.warn(`No offer from ${remoteClientId}, offering instead`);
            this.createOffer(remoteClientId);
        }, NEGOTIATION_WATCHDOG_MS));
    }

    _clearNegotiationWatchdog(remoteClientId) {
        const timer = this._negotiationTimers.get(remoteClientId);
        if (timer) {
            clearTimeout(timer);
            this._negotiationTimers.delete(remoteClientId);
        }
    }

    participantsLabel() {
        return this.participants.size > 1
            ? `${this.participants.size} участников`
            : 'Ожидание участников...';
    }

    // Closes every peer connection and clears all per-peer state and video
    // tiles. Local media is kept alive.
    teardownPeers() {
        this._iceRestartTimers.forEach(timer => clearTimeout(timer));
        this._iceRestartTimers.clear();
        this._iceRestartAttempts.clear();
        this._peerReconnectAttempts.clear();
        this._negotiationTimers.forEach(timer => clearTimeout(timer));
        this._negotiationTimers.clear();

        this.peerConnections.forEach(pc => pc.close());
        this.peerConnections.clear();
        this.controlChannels.clear();
        this.pendingIceCandidates.clear();

        this.audioContexts.forEach((audioSetup) => this._disconnectAudio(audioSetup));
        this.audioContexts.clear();

        this.videosContainer.innerHTML = '';
        this.updateGridLayout();
    }

    createCall() {
        this.joinRoom(this.generateRoomId());
    }

    toggleJoinInput() {
        const container = document.getElementById('join-input-container');
        container.classList.toggle('hidden');
        if (!container.classList.contains('hidden')) {
            document.getElementById('room-id-input').focus();
        }
    }

    joinCall() {
        const input = document.getElementById('room-id-input');
        const roomId = input.value.trim().toUpperCase();

        if (!ROOM_ID_PATTERN.test(roomId)) {
            this.showToast('Код звонка — 6 символов: буквы A-Z и цифры');
            return;
        }

        this.joinRoom(roomId);
    }

    joinRoom(roomId) {
        if (this._joining || this.roomId) {
            return;
        }
        this._joining = true;
        this._lastRequestedRoom = roomId;

        // Warm up the AudioContext while we are still in a user gesture —
        // otherwise browsers keep it suspended and remote audio stays silent.
        this.ensureAudioContext();

        if (!this._sendWs({ type: 'join', roomId })) {
            this.pendingJoinRoomId = roomId;
            this.showToast('Подключение к серверу...');
            if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
                this._cancelReconnect();
                this.connectWebSocket();
            }
        }
    }

    // Single-flight capture. Two concurrent getUserMedia calls (startCall
    // racing an incoming offer) would leave one stream orphaned: its tracks
    // stay live after endCall and ignore the mute button, because toggles only
    // touch the stream that happened to win.
    acquireLocalMedia() {
        if (this.localStream && this.localStream.getTracks().some(t => t.readyState === 'live')) {
            return Promise.resolve(this.localStream);
        }
        if (this._mediaPromise) {
            return this._mediaPromise;
        }

        const generation = this._mediaGeneration;
        this._mediaPromise = (async () => {
            try {
                return await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
            } catch (error) {
                // A missing, blocked or busy camera must not keep someone out
                // of a call they can still take with audio only.
                if (error && error.name === 'NotAllowedError') {
                    throw error;
                }
                console.warn('Camera unavailable, falling back to audio only:', error && error.name);
                const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
                this.showToast('Камера недоступна — звонок только с микрофоном');
                return stream;
            }
        })();

        this._mediaPromise
            .then((stream) => {
                if (generation !== this._mediaGeneration) {
                    // The call ended while the prompt was open. Adopting this
                    // stream now would leave the camera running with nothing
                    // on screen to explain why.
                    stream.getTracks().forEach(t => t.stop());
                    return;
                }
                if (this.localStream && this.localStream !== stream) {
                    this.localStream.getTracks().forEach(t => t.stop());
                }
                this.localStream = stream;
            })
            .catch(() => { /* reported by the caller */ })
            // A denied prompt must not poison every later attempt
            .finally(() => { this._mediaPromise = null; });

        return this._mediaPromise;
    }

    mediaErrorMessage(error) {
        const name = error && error.name;
        // Inside Telegram's webview there is no permission screen to send the
        // user to, so the usual advice is a dead end there.
        if (IN_TELEGRAM_WEBVIEW && IS_IOS &&
            (name === 'NotAllowedError' || name === 'NotFoundError' || name === 'NotReadableError')) {
            return TELEGRAM_IOS_HINT;
        }
        switch (name) {
            case 'NotAllowedError':
                return 'Доступ к камере и микрофону запрещён — разрешите его в настройках браузера';
            case 'NotFoundError':
            case 'OverconstrainedError':
                return 'Микрофон не найден';
            case 'NotReadableError':
                return 'Камера или микрофон заняты другим приложением';
            default:
                return 'Не удалось получить доступ к камере/микрофону';
        }
    }

    async startCall() {
        try {
            await this.acquireLocalMedia();
        } catch (error) {
            console.error('Error accessing media devices:', error);
            this.showToast(this.mediaErrorMessage(error));
            this.endCall();
            return false;
        }

        // Hanging up while the permission prompt was open discards the capture,
        // so there may be no stream and no call left to show it in.
        if (!this.localStream || !this.roomId) {
            return false;
        }

        // Honor current mute toggles (relevant after a rejoin)
        this.localStream.getAudioTracks().forEach(t => { t.enabled = this.isAudioEnabled; });
        this.localStream.getVideoTracks().forEach(t => { t.enabled = this.isVideoEnabled; });

        // Add local video to grid
        this.addVideoStream(this.clientId, this.localStream, true);

        // Show call screen
        this.homeScreen.classList.remove('active');
        this.callScreen.classList.add('active');

        // Update UI
        document.getElementById('current-room-id').textContent = this.roomId;
        this.updateConnectionStatus('Ожидание участников...');
        this.updateEncryptionUI(this.frameCryptor.encryptionEnabled);

        // Initialize layout selector
        document.querySelectorAll('.layout-option').forEach(option => {
            option.classList.toggle('selected', option.dataset.layout === this.layoutMode);
        });

        // Update URL (replaceState — joining a call should not pollute history)
        window.history.replaceState({}, '', `${window.location.origin}?room=${encodeURIComponent(this.roomId)}`);

        return true;
    }

    addVideoStream(clientId, stream, isLocal = false) {
        // ontrack fires once per track (audio + video) with the same stream —
        // don't rebuild the tile if it is already showing this stream.
        const existingVideo = document.getElementById(`video-${clientId}`);
        if (existingVideo && existingVideo.srcObject === stream) {
            return;
        }

        // Remove existing video if present
        this.removeVideoStream(clientId);

        const wrapper = document.createElement('div');
        wrapper.className = `video-wrapper${isLocal ? ' local-video' : ''}`;
        wrapper.id = `video-wrapper-${clientId}`;

        const video = document.createElement('video');
        video.id = `video-${clientId}`;
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        // Always start muted. iOS refuses to autoplay an unmuted element, and
        // a remote tile that never starts shows nothing at all — so sound is
        // switched on after playback is running (see _enableTileAudio), not
        // before it.
        video.muted = true;

        const label = document.createElement('div');
        label.className = 'video-label';
        const participant = this.participants.get(clientId);
        label.textContent = participant ? participant.name : (isLocal ? 'Вы' : 'Участник');
        // Restore the mute indicator across tile rebuilds (e.g. after rejoin)
        const labelMuted = isLocal ? !this.isAudioEnabled : !!(participant && participant.audioMuted);
        label.classList.toggle('muted', labelMuted);

        wrapper.appendChild(video);
        wrapper.appendChild(label);

        // Tap/click toggles the per-tile controls overlay, and doubles as the
        // gesture that recovers a tile whose autoplay was blocked.
        wrapper.addEventListener('click', () => {
            if (video.paused) {
                video.play().catch(() => { /* still blocked */ });
                this.ensureAudioContext();
            }
            const wasShowing = wrapper.classList.contains('show-controls');
            document.querySelectorAll('.video-wrapper.show-controls').forEach(w => {
                w.classList.remove('show-controls');
            });
            if (!wasShowing) {
                wrapper.classList.add('show-controls');
            }
        });

        if (isLocal) {
            // Mirror local video by default and add toggle
            const isMirrored = localStorage.getItem('localVideoMirrored') !== 'false';
            if (isMirrored) {
                wrapper.classList.add('mirrored');
            }

            const mirrorBtn = document.createElement('button');
            mirrorBtn.className = 'mirror-btn' + (isMirrored ? ' active' : '');
            mirrorBtn.title = 'Зеркалировать видео';
            mirrorBtn.setAttribute('aria-label', 'Зеркалировать видео');
            mirrorBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/></svg>';
            mirrorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                wrapper.classList.toggle('mirrored');
                const nowMirrored = wrapper.classList.contains('mirrored');
                mirrorBtn.classList.toggle('active', nowMirrored);
                localStorage.setItem('localVideoMirrored', nowMirrored);
            });
            wrapper.appendChild(mirrorBtn);
        } else {
            const volumeBtn = document.createElement('button');
            volumeBtn.className = 'volume-btn';
            volumeBtn.textContent = '🔊';
            volumeBtn.title = this.useWebAudioOutput ? 'Регулировка громкости' : 'Звук участника';
            volumeBtn.setAttribute('aria-label', volumeBtn.title);
            volumeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.useWebAudioOutput) {
                    this.showVolumeControl(clientId, volumeBtn);
                } else {
                    // WebKit ignores element volume, so the only per-participant
                    // control that actually works there is mute/unmute.
                    this.toggleParticipantMute(clientId, volumeBtn);
                }
            });
            wrapper.appendChild(volumeBtn);

            // Add volume badge (shown when volume != 100%)
            const volumeBadge = document.createElement('div');
            volumeBadge.className = 'volume-badge';
            volumeBadge.id = `volume-badge-${clientId}`;
            const savedVolume = this.volumeSettings[clientId] || 1.0;
            if (savedVolume !== 1.0) {
                volumeBadge.textContent = Math.round(savedVolume * 100) + '%';
                volumeBadge.classList.add('visible');
            }
            wrapper.appendChild(volumeBadge);

            this.setupVolumeControl(clientId, video, stream);
        }

        // Spotlight and sidebar layouts feature the first tile, so remote
        // participants go in front of the local one — nobody wants their own
        // camera in the big slot with everyone else as thumbnails.
        const localWrapper = this.videosContainer.querySelector('.video-wrapper.local-video');
        if (!isLocal && localWrapper) {
            this.videosContainer.insertBefore(wrapper, localWrapper);
        } else {
            this.videosContainer.appendChild(wrapper);
        }

        // Update grid layout
        this.updateGridLayout();

        // Autoplay can be refused (iOS Low Power Mode blocks even muted
        // video); the wrapper's click handler retries inside a user gesture.
        video.play()
            .then(() => {
                if (!isLocal && this._tileCarriesAudio(video)) {
                    this._enableTileAudio(video);
                }
            })
            .catch((e) => {
                console.log('Autoplay prevented, tap the tile to start:', e);
                this._armGestureRecovery();
            });
    }

    // True when this tile's own element is the audio sink: on WebKit always,
    // and anywhere the Web Audio graph could not be built.
    _tileCarriesAudio(video) {
        return !this.useWebAudioOutput || video.dataset.elementAudio === '1';
    }

    // Unmuting is what the browser may refuse, so it is done separately from
    // starting playback: if it costs us the video we put the mute back and
    // wait for a tap.
    _enableTileAudio(video) {
        video.muted = false;
        const resumed = video.play();
        if (resumed && typeof resumed.catch === 'function') {
            resumed.catch(() => {
                video.muted = true;
                video.play().catch(() => { /* handled by the gesture recovery */ });
                this._armGestureRecovery();
            });
        }
    }

    // One shot: the next tap anywhere starts whatever the autoplay policy
    // refused — paused tiles, muted remote audio, a suspended AudioContext.
    _armGestureRecovery() {
        if (this._gestureRecoveryArmed) return;
        this._gestureRecoveryArmed = true;
        this.showToast('Коснитесь экрана, чтобы включить звук и видео');

        const recover = () => {
            this._gestureRecoveryArmed = false;
            document.removeEventListener('pointerdown', recover);
            document.removeEventListener('touchend', recover);
            this.ensureAudioContext();
            this.participants.forEach((_, id) => {
                if (id === this.clientId) return;
                const video = document.getElementById(`video-${id}`);
                if (!video) return;
                if (this._tileCarriesAudio(video)) video.muted = false;
                video.play().catch(() => { /* nothing more we can do */ });
            });
        };
        document.addEventListener('pointerdown', recover, { once: true });
        document.addEventListener('touchend', recover, { once: true });
    }

    _disconnectAudio(audioSetup) {
        ['source', 'gainNode', 'limiter'].forEach((node) => {
            try {
                if (audioSetup[node]) audioSetup[node].disconnect();
            } catch (e) { /* already disconnected */ }
        });
    }

    removeVideoStream(clientId) {
        // Clean up audio context
        const audioSetup = this.audioContexts.get(clientId);
        if (audioSetup) {
            this._disconnectAudio(audioSetup);
            this.audioContexts.delete(clientId);
        }

        const wrapper = document.getElementById(`video-wrapper-${clientId}`);
        if (wrapper) {
            wrapper.remove();
        }
        this.updateGridLayout();
    }

    updateGridLayout() {
        const count = this.videosContainer.children.length;
        this.videosContainer.setAttribute('data-participants', count);

        // Update layout based on mode
        const effectiveLayout = this.getEffectiveLayout(count);
        this.videosContainer.setAttribute('data-layout', effectiveLayout);
    }

    getEffectiveLayout(participantCount) {
        // While a game is on, the video strip is ~90px tall: spotlight would
        // put a 140px thumbnail row inside it and sidebar's 1fr 180px columns
        // are nonsense at that height. Only the effective mode is overridden,
        // so the user's stored choice comes back on exit.
        if (this.game) return 'grid';
        // Alone in the room, every layout that reserves space for remote
        // tiles just shows an empty container.
        if (participantCount <= 1) return 'grid';
        if (this.layoutMode === 'auto') {
            return participantCount <= 2 ? 'grid' : 'spotlight';
        }
        return this.layoutMode;
    }

    toggleLayoutSelector() {
        const selector = document.getElementById('layout-selector');
        selector.classList.toggle('hidden');
    }

    setLayout(layout) {
        this.layoutMode = layout;
        localStorage.setItem('layoutMode', layout);

        // Update selected option in UI
        document.querySelectorAll('.layout-option').forEach(option => {
            option.classList.toggle('selected', option.dataset.layout === layout);
        });

        // Apply layout
        this.updateGridLayout();

        // Hide selector
        document.getElementById('layout-selector').classList.add('hidden');

        // Show toast
        const layoutNames = {
            'grid': 'Сетка',
            'spotlight': 'Фокус',
            'sidebar': 'Сайдбар',
            'compact': 'Компакт',
            'auto': 'Авто'
        };
        this.showToast(`Режим: ${layoutNames[layout]}`);
    }

    createPeerConnection(remoteClientId) {
        // Close a stale connection first so it can never leak
        const existing = this.peerConnections.get(remoteClientId);
        if (existing) {
            existing.close();
        }

        const pcConfig = { ...this.rtcConfig };
        if (this.frameCryptor.useLegacyStreams) {
            // Legacy insertable streams must be requested at construction.
            // Pass-through transforms are installed immediately below, so
            // media flows whether or not encryption is currently on.
            pcConfig.encodedInsertableStreams = true;
        }
        const pc = new RTCPeerConnection(pcConfig);
        // Offers and answers carry this id so a reply produced for a session
        // we have since torn down can be recognised and ignored instead of
        // being applied to — or silently dropped by — the replacement.
        pc._sessionId = `${this.clientId}:${++this._sessionCounter}`;
        this.peerConnections.set(remoteClientId, pc);

        this.setupControlChannel(pc, remoteClientId);

        // Add local tracks; encryption transforms are installed up front and
        // stay in pass-through mode until encryption is enabled.
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                const sender = pc.addTrack(track, this.localStream);
                this.frameCryptor.setupSenderTransform(sender);
            });
        }

        // Whole-frame encryption is safe only for codecs whose RTP packetizer
        // treats the payload as opaque. H.264 packetization parses NAL units,
        // so put VP8 first while keeping the rest as fallback.
        if (this.frameCryptor.supported &&
            typeof RTCRtpTransceiver !== 'undefined' &&
            RTCRtpTransceiver.prototype.setCodecPreferences &&
            typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities) {
            try {
                const caps = RTCRtpReceiver.getCapabilities('video');
                const vp8 = caps.codecs.filter(c => /vp8/i.test(c.mimeType));
                const rest = caps.codecs.filter(c => !/vp8/i.test(c.mimeType));
                if (vp8.length > 0) {
                    pc.getTransceivers().forEach(transceiver => {
                        const track = transceiver.sender && transceiver.sender.track;
                        if (track && track.kind === 'video') {
                            transceiver.setCodecPreferences([...vp8, ...rest]);
                        }
                    });
                }
            } catch (error) {
                console.warn('Could not set codec preferences:', error);
            }
        }

        // Handle remote stream
        pc.ontrack = (event) => {
            console.log('Received remote track from:', remoteClientId);
            if (event.receiver) {
                this.frameCryptor.setupReceiverTransform(event.receiver);
            }
            const stream = event.streams && event.streams[0];
            if (!stream) return;
            this.addVideoStream(remoteClientId, stream, false);
            this.updateConnectionStatus(this.participantsLabel());
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this._sendWs({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    targetId: remoteClientId
                });
            }
        };

        // Handle ICE connection state
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE connection state (${remoteClientId}):`, pc.iceConnectionState);

            switch (pc.iceConnectionState) {
                case 'connected':
                case 'completed':
                    // Reset both recovery counters on success
                    this._iceRestartAttempts.delete(remoteClientId);
                    this._peerReconnectAttempts.delete(remoteClientId);
                    this._clearIceRestartTimer(remoteClientId);
                    this._markPeerReachable(remoteClientId);
                    this.updateConnectionStatus(this.participantsLabel(), true);
                    break;
                case 'failed':
                    console.error('ICE connection failed for:', remoteClientId);
                    this._attemptIceRestart(remoteClientId);
                    break;
                case 'disconnected':
                    this.updateConnectionStatus('Переподключение...', false);
                    // Start a timer — if not recovered in 5s, try ICE restart
                    this._clearIceRestartTimer(remoteClientId);
                    this._iceRestartTimers.set(remoteClientId, setTimeout(() => {
                        const currentPc = this.peerConnections.get(remoteClientId);
                        if (currentPc === pc && pc.iceConnectionState === 'disconnected') {
                            console.log(`Peer ${remoteClientId} still disconnected, attempting ICE restart`);
                            this._attemptIceRestart(remoteClientId);
                        }
                    }, 5000));
                    break;
            }
        };

        // Handle connection state
        pc.onconnectionstatechange = () => {
            console.log(`Connection state (${remoteClientId}):`, pc.connectionState);
            if (pc.connectionState === 'failed' && this.peerConnections.get(remoteClientId) === pc) {
                // Full reconnect — close old connection and create new one
                this._reconnectPeer(remoteClientId);
            }
        };

        return pc;
    }

    // The control channel is a DTLS-encrypted, peer-to-peer side channel used
    // for E2EE key exchange, reactions and mute-state sync. The signaling
    // server never sees any of it.
    setupControlChannel(pc, remoteClientId) {
        const channel = pc.createDataChannel('control', { negotiated: true, id: 0 });

        channel.onopen = () => {
            this.controlChannels.set(remoteClientId, channel);
            this.sendControl(remoteClientId, {
                kind: 'mute-state',
                audio: this.isAudioEnabled,
                video: this.isVideoEnabled
            });
            if (this.frameCryptor.encryptionEnabled && this.frameCryptor.rawKeyData) {
                this.sendControl(remoteClientId, {
                    kind: 'e2ee-key',
                    key: Array.from(this.frameCryptor.rawKeyData),
                    owner: this.keyOwner,
                    epoch: this.keyEpoch
                });
            }
        };

        channel.onclose = () => {
            if (this.controlChannels.get(remoteClientId) === channel) {
                this.controlChannels.delete(remoteClientId);
            }
            if (this.gameOpponentId === remoteClientId) {
                this.endGame('Игра прервана: связь с участником потеряна');
            }
        };

        channel.onmessage = (event) => {
            this.handleControlMessage(remoteClientId, event.data);
        };
    }

    sendControl(remoteClientId, payload) {
        const channel = this.controlChannels.get(remoteClientId);
        if (channel && channel.readyState === 'open') {
            try {
                channel.send(JSON.stringify(payload));
                return true;
            } catch (error) {
                console.warn('Control channel send failed:', error);
            }
        }
        return false;
    }

    broadcastControl(payload) {
        this.controlChannels.forEach((_, clientId) => this.sendControl(clientId, payload));
    }

    async handleControlMessage(senderId, raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch (error) {
            return;
        }
        if (!message || typeof message !== 'object') return;

        switch (message.kind) {
            case 'e2ee-key':
                await this.handleRemoteEncryptionKey(senderId, message.key, message.owner, message.epoch);
                break;
            case 'e2ee-off':
                this.handleRemoteEncryptionDisabled(senderId);
                break;
            case 'e2ee-unsupported': {
                // Remember it: such a peer can never rotate the key, so it
                // must not win the rekey election when somebody leaves.
                const participant = this.participants.get(senderId);
                if (participant) participant.e2eeUnsupported = true;
                this.showToast('⚠️ Браузер участника не поддерживает шифрование — его медиа скрыто');
                break;
            }
            case 'reaction':
                this.handleRemoteReaction(senderId, message.emoji);
                break;
            case 'mute-state':
                this.handleRemoteMuteState(senderId, message);
                break;
            case 'game':
                this.handleGameMessage(senderId, message);
                break;
        }
    }

    // Every game message lands here, so this is the one place untrusted game
    // input has to be checked — the same shape as the emoji allowlist in
    // handleRemoteReaction and the byte-range check in handleRemoteEncryptionKey.
    handleGameMessage(senderId, message) {
        if (typeof message.op !== 'string') return;

        if (message.op === 'invite') {
            if (this.game || this.pendingInviteFrom || this.invitedPeer) return;
            if (!this.participants.has(senderId)) return;
            if (message.v !== 1) {
                this.sendControl(senderId, { kind: 'game', op: 'decline', reason: 'version' });
                return;
            }
            this._showGameInvite(senderId);
            return;
        }

        if (message.op === 'accept') {
            if (this.invitedPeer !== senderId) return;
            this.invitedPeer = null;
            this._startGame(senderId);
            return;
        }

        if (message.op === 'decline') {
            if (this.invitedPeer !== senderId) return;
            this.invitedPeer = null;
            document.getElementById('game-btn').classList.remove('pending');
            this.showToast(message.reason === 'version'
                ? 'У участника другая версия приложения'
                : 'Участник отказался от игры');
            return;
        }

        if (message.op === 'end') {
            if (this.gameOpponentId !== senderId) return;
            this.endGame('Игра завершена');
            return;
        }

        // Everything below is gameplay: only the opponent may drive it. In a
        // five-person room a third party must not be able to move the ball.
        if (!this.game || this.gameOpponentId !== senderId) return;
        this.game.receive(message);
    }

    // --- Ping-pong ---

    initGameUI() {
        document.getElementById('game-btn').addEventListener('click', () => this.onGameButton());
        document.getElementById('game-exit-btn').addEventListener('click', () => this.leaveGame());
        document.getElementById('game-invite-accept').addEventListener('click', () => this.acceptGameInvite());
        document.getElementById('game-invite-decline').addEventListener('click', () => this.declineGameInvite());

        this._onGameKeyDown = (e) => {
            if (!this.game) return;
            // Never swallow keys aimed at a control — #volume-slider is a range
            // input whose arrow keys are its accessible interface.
            if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
            if (e.code === 'Escape') {
                this.leaveGame();
                return;
            }
            if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(e.code)) {
                // event.code, not event.key: on a ЙЦУКЕН layout the A/D keys
                // report 'ф' and 'в'.
                e.preventDefault();
                this.game.onKeyDown(e.code);
            }
        };
        this._onGameKeyUp = (e) => {
            if (this.game) this.game.onKeyUp(e.code);
        };

        const board = document.getElementById('game-board');
        const track = (e) => {
            if (!this.game) return;
            const x = this.game.pointerToPaddleX(e.clientX);
            if (x !== null) this.game.myPaddleX = x;
        };
        // No preventDefault or stopPropagation here: the document-level handlers
        // that dismiss popups and recover blocked autoplay must keep seeing the
        // event. touch-action: none in the CSS is what stops scrolling.
        board.addEventListener('pointerdown', (e) => {
            if (!this.game) return;
            if (board.setPointerCapture) {
                try { board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            }
            track(e);
        });
        board.addEventListener('pointermove', (e) => {
            if (e.buttons === 0 && e.pointerType !== 'mouse') return;
            track(e);
        });
    }

    onGameButton() {
        if (this.game) {
            this.leaveGame();
            return;
        }
        const others = Array.from(this.participants.keys())
            .filter((id) => id !== this.clientId && !this.participants.get(id).unreachable);
        if (others.length === 0) {
            this.showToast('Нужен второй участник');
            return;
        }
        if (others.length === 1) {
            this.inviteToGame(others[0]);
            return;
        }
        this._showGameMenu(others);
    }

    _showGameMenu(others) {
        const menu = document.getElementById('game-menu');
        menu.innerHTML = '';
        others.forEach((id) => {
            const row = document.createElement('div');
            row.className = 'game-option';
            row.setAttribute('role', 'menuitem');
            row.textContent = this.participants.get(id).name;
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.classList.add('hidden');
                this.inviteToGame(id);
            });
            menu.appendChild(row);
        });
        menu.classList.remove('hidden');
    }

    inviteToGame(peerId) {
        if (!this.sendControl(peerId, { kind: 'game', op: 'invite', v: 1 })) {
            this.showToast('Нет прямого соединения с участником');
            return;
        }
        this.invitedPeer = peerId;
        document.getElementById('game-btn').classList.add('pending');
        this.showToast('Приглашение отправлено');
        clearTimeout(this._inviteTimer);
        this._inviteTimer = setTimeout(() => {
            if (this.invitedPeer !== peerId) return;
            this.invitedPeer = null;
            document.getElementById('game-btn').classList.remove('pending');
            this.showToast('Приглашение истекло');
        }, 30000);
    }

    _showGameInvite(senderId) {
        this.pendingInviteFrom = senderId;
        const participant = this.participants.get(senderId);
        document.getElementById('game-invite-from').textContent =
            `${participant ? participant.name : 'Участник'} приглашает сыграть`;
        document.getElementById('game-invite').classList.remove('hidden');
        clearTimeout(this._inviteExpiry);
        this._inviteExpiry = setTimeout(() => this._hideGameInvite(), 30000);
    }

    _hideGameInvite() {
        clearTimeout(this._inviteExpiry);
        this.pendingInviteFrom = null;
        document.getElementById('game-invite').classList.add('hidden');
    }

    acceptGameInvite() {
        const peerId = this.pendingInviteFrom;
        this._hideGameInvite();
        if (!peerId || !this.participants.has(peerId)) return;
        this.sendControl(peerId, { kind: 'game', op: 'accept' });
        this._startGame(peerId);
    }

    declineGameInvite() {
        const peerId = this.pendingInviteFrom;
        this._hideGameInvite();
        if (peerId) this.sendControl(peerId, { kind: 'game', op: 'decline', reason: 'declined' });
    }

    _startGame(opponentId) {
        if (this.game) return;
        this.gameOpponentId = opponentId;
        document.getElementById('game-btn').classList.remove('pending');

        const opponent = this.participants.get(opponentId);
        document.getElementById('game-opponent-name').textContent = opponent ? opponent.name : 'Соперник';
        this._setGameScore(0, 0);
        document.getElementById('game-panel').classList.remove('hidden');
        this.callScreen.setAttribute('data-game', 'on');
        // Spotlight and sidebar are meaningless in an 84px strip. The stored
        // layoutMode is untouched, so the user's choice returns on exit.
        this.updateGridLayout();

        this.game = new PongGame({
            canvas: document.getElementById('game-canvas'),
            // Same election as SDP offering: both sides compute it identically
            // from data they already have, and it survives a reconnect because
            // clientId does.
            isHost: this._shouldOffer(opponentId),
            send: (payload) => this._sendGame(payload),
            onScore: (mine, theirs) => this._setGameScore(mine, theirs),
            onMessage: (text) => this._setGameMessage(text),
        });

        window.addEventListener('keydown', this._onGameKeyDown);
        window.addEventListener('keyup', this._onGameKeyUp);
        this.game.start();
    }

    _sendGame(payload) {
        const channel = this.controlChannels.get(this.gameOpponentId);
        if (!channel || channel.readyState !== 'open') return false;
        // Backpressure guard lives here and NOT in sendControl: dropping a
        // game tick is free, dropping an E2EE key breaks the call.
        if ((channel.bufferedAmount || 0) > 64 * 1024) return false;
        return this.sendControl(this.gameOpponentId, { kind: 'game', ...payload });
    }

    _setGameScore(mine, theirs) {
        document.getElementById('game-score-you').textContent = String(mine);
        document.getElementById('game-score-them').textContent = String(theirs);
    }

    _setGameMessage(text) {
        const el = document.getElementById('game-message');
        el.textContent = text || '';
        el.classList.toggle('hidden', !text);
    }

    // The user pressed exit: tell the opponent, then tear down.
    leaveGame() {
        if (this.gameOpponentId) {
            this.sendControl(this.gameOpponentId, { kind: 'game', op: 'end' });
        }
        this.endGame();
    }

    // Idempotent, and called from every path that can end a call or a peer —
    // endCall, handlePeerLeft, _giveUpOnPeer, _dropPeerSession and the control
    // channel's onclose. A game whose opponent is gone would otherwise sit
    // there frozen with the render loop still burning battery.
    endGame(reason) {
        clearTimeout(this._inviteTimer);
        this.invitedPeer = null;
        this._hideGameInvite();
        const btn = document.getElementById('game-btn');
        if (btn) btn.classList.remove('pending');

        if (this.game) {
            this.game.stop();
            this.game = null;
        }
        this.gameOpponentId = null;
        window.removeEventListener('keydown', this._onGameKeyDown);
        window.removeEventListener('keyup', this._onGameKeyUp);

        const panel = document.getElementById('game-panel');
        if (panel) panel.classList.add('hidden');
        if (this.callScreen) this.callScreen.removeAttribute('data-game');
        const menu = document.getElementById('game-menu');
        if (menu) menu.classList.add('hidden');
        this._setGameMessage(null);
        this.updateGridLayout();
        if (reason) this.showToast(reason);
    }

    // Keys are ordered by (epoch, owner): a higher epoch always wins, and an
    // equal epoch is broken by the lexicographically smaller owner id. That
    // ordering is a total order every peer computes identically, so the room
    // converges no matter what order the announcements arrive in — and, unlike
    // comparing owners alone, it lets the current owner replace its own key
    // (rotation) and lets ownership move to somebody else.
    _keyBeats(remoteEpoch, remoteOwner) {
        if (this.keyEpoch !== remoteEpoch) {
            return this.keyEpoch > remoteEpoch;
        }
        return Boolean(this.keyOwner) && this.keyOwner < remoteOwner;
    }

    async handleRemoteEncryptionKey(senderId, key, owner, epoch) {
        if (!Array.isArray(key) || key.length !== E2EE_KEY_BYTES ||
            !key.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
            console.warn('Ignoring invalid encryption key from', senderId);
            return;
        }
        if (!this.frameCryptor.supported) {
            this.showToast('Участник включил шифрование, но ваш браузер его не поддерживает');
            // Let the room know this participant cannot encrypt, so others
            // understand why our media disappears under their lock indicator.
            this.sendControl(senderId, { kind: 'e2ee-unsupported' });
            return;
        }
        const keyOwner = typeof owner === 'string' && owner ? owner : senderId;
        const keyEpoch = Number.isInteger(epoch) && epoch > 0 ? epoch : 1;

        try {
            const keyData = new Uint8Array(key);

            // Ours is newer: re-assert it instead of adopting a stale key.
            if (this.frameCryptor.encryptionEnabled && this.frameCryptor.rawKeyData &&
                !this.frameCryptor.hasSameKey(keyData) &&
                this._keyBeats(keyEpoch, keyOwner)) {
                this.sendControl(senderId, {
                    kind: 'e2ee-key',
                    key: Array.from(this.frameCryptor.rawKeyData),
                    owner: this.keyOwner,
                    epoch: this.keyEpoch
                });
                return;
            }

            const alreadyActive = this.frameCryptor.encryptionEnabled && this.frameCryptor.hasSameKey(keyData);
            if (!this.frameCryptor.hasSameKey(keyData)) {
                await this.frameCryptor.setKey(keyData);
            }
            this.keyOwner = keyOwner;
            this.keyEpoch = keyEpoch;
            this.frameCryptor.enable();
            this.updateEncryptionUI(true);
            if (!alreadyActive) {
                console.log('Encryption key received from:', senderId);
                this.showToast('🔒 Шифрование включено');
            }
        } catch (error) {
            console.error('Error handling encryption key:', error);
            this.showToast('Ошибка получения ключа шифрования');
        }
    }

    handleRemoteEncryptionDisabled(senderId) {
        if (!this.frameCryptor.encryptionEnabled) return;
        this.frameCryptor.disable();
        this.keyOwner = null;
        this.updateEncryptionUI(false);
        console.log('Encryption disabled by:', senderId);
        this.showToast('🔓 Шифрование выключено');
    }

    handleRemoteMuteState(senderId, message) {
        // Remember the state so a rebuilt video tile restores the indicator
        const participant = this.participants.get(senderId);
        if (participant) {
            participant.audioMuted = message.audio === false;
        }
        const label = document.querySelector(`#video-wrapper-${CSS.escape(senderId)} .video-label`);
        if (label) {
            label.classList.toggle('muted', message.audio === false);
        }
    }

    async createOffer(remoteClientId, options) {
        await this._configPromise;
        // A peer can be announced while our own capture is still waiting on
        // the permission prompt, and a connection built without local tracks
        // would carry no media.
        if (!this.localStream) {
            try {
                await this.acquireLocalMedia();
            } catch (error) {
                console.error('Cannot offer without local media:', error);
                return;
            }
            // The call can end while the prompt is open, in which case the
            // capture is discarded and there is nobody left to offer to.
            if (!this.localStream || !this.roomId) return;
        }

        // ICE restarts renegotiate the existing connection; everything else
        // starts a fresh one.
        const pc = this.peerConnections.get(remoteClientId) && options && options.iceRestart
            ? this.peerConnections.get(remoteClientId)
            : this.createPeerConnection(remoteClientId);

        try {
            const offer = await pc.createOffer(options);
            await pc.setLocalDescription(offer);

            return this._sendWs({
                type: 'offer',
                offer: pc.localDescription,
                sessionId: pc._sessionId,
                targetId: remoteClientId
            });
        } catch (error) {
            console.error('Error creating offer:', error);
            // An ICE restart is driven by a one-shot timer, and the state is
            // already 'failed', so no further event will arrive to retry this.
            // Swallowing the error here would strand the peer for the rest of
            // the call; re-entering the ladder keeps the attempt cap.
            if (options && options.iceRestart) {
                this._attemptIceRestart(remoteClientId);
            }
            return false;
        }
    }

    async handleOffer(message) {
        if (typeof message.senderId !== 'string' || !message.offer) return;
        await this._configPromise;
        this._clearNegotiationWatchdog(message.senderId);

        // Ensure we have local stream before creating peer connection
        if (!this.localStream) {
            try {
                await this.acquireLocalMedia();
            } catch (error) {
                console.error('Error accessing media devices:', error);
                this.showToast(this.mediaErrorMessage(error));
                return;
            }
            if (!this.localStream || !this.roomId) return;
            this.addVideoStream(this.clientId, this.localStream, true);
        }

        // An offer can arrive before the peer-joined notification
        if (!this.participants.has(message.senderId)) {
            this.participants.set(message.senderId, {
                id: message.senderId,
                name: `Участник ${message.senderId.slice(0, 4)}`
            });
        }

        // Reuse the existing connection (ICE restarts arrive as plain offers);
        // only build a fresh one if we have none.
        let pc = this.peerConnections.get(message.senderId);
        if (!pc || pc.connectionState === 'closed') {
            pc = this.createPeerConnection(message.senderId);
        }

        try {
            if (pc.signalingState === 'have-local-offer') {
                // Glare: both sides sent an offer. The peer with the smaller
                // id wins as offerer; the other rolls back and answers.
                const polite = this.clientId > message.senderId;
                if (!polite) {
                    // Re-assert our offer rather than just dropping theirs. If
                    // our original offer was the one that went missing — which
                    // is exactly why the other side offered — staying silent
                    // here would deadlock the pair permanently.
                    console.log('Offer collision — re-asserting our offer (impolite peer)');
                    if (pc.localDescription) {
                        this._sendWs({
                            type: 'offer',
                            offer: pc.localDescription,
                            sessionId: pc._sessionId,
                            targetId: message.senderId
                        });
                    }
                    return;
                }
                await pc.setLocalDescription({ type: 'rollback' });
            }

            await pc.setRemoteDescription(new RTCSessionDescription(message.offer));

            // Process any pending ICE candidates
            await this.processPendingIceCandidates(message.senderId);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this._sendWs({
                type: 'answer',
                answer: pc.localDescription,
                // Echo the offer's session id so the offerer can tell whether
                // this answer belongs to the connection it still has open.
                sessionId: message.sessionId,
                targetId: message.senderId
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(message) {
        if (typeof message.senderId !== 'string' || !message.answer) return;
        try {
            const pc = this.peerConnections.get(message.senderId);
            if (!pc || pc.signalingState !== 'have-local-offer') return;
            if (message.sessionId && pc._sessionId !== message.sessionId) {
                // An answer to an offer from a connection we have replaced.
                // Applying it would pair us with the wrong ICE/DTLS session.
                console.warn('Ignoring answer for a stale session from', message.senderId);
                return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
            await this.processPendingIceCandidates(message.senderId);
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(message) {
        if (typeof message.senderId !== 'string' || !message.candidate) return;
        try {
            const candidate = new RTCIceCandidate(message.candidate);
            const pc = this.peerConnections.get(message.senderId);

            if (pc && pc.remoteDescription) {
                await pc.addIceCandidate(candidate);
                return;
            }

            // No connection yet, or no remote description yet. Both are normal
            // while we are still waiting on the camera permission prompt, and
            // dropping these costs us the relay candidate on TURN-only paths.
            let pending = this.pendingIceCandidates.get(message.senderId);
            if (!pending) {
                pending = [];
                this.pendingIceCandidates.set(message.senderId, pending);
            }
            if (pending.length < MAX_PENDING_CANDIDATES) {
                pending.push(candidate);
            }
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }

    async processPendingIceCandidates(clientId) {
        const candidates = this.pendingIceCandidates.get(clientId);
        if (candidates && candidates.length > 0) {
            console.log(`Processing ${candidates.length} pending ICE candidates for ${clientId}`);

            const pc = this.peerConnections.get(clientId);
            if (pc) {
                for (const candidate of candidates) {
                    try {
                        await pc.addIceCandidate(candidate);
                    } catch (error) {
                        console.error('Error adding pending ICE candidate:', error);
                    }
                }
            }

            this.pendingIceCandidates.delete(clientId);
        }
    }

    // Drops a peer's transport session (connection, data channel, buffered
    // candidates) but keeps the participant and its video tile — used when
    // the peer is reconnecting and a fresh offer is on its way.
    _markPeerReachable(clientId) {
        const participant = this.participants.get(clientId);
        if (participant) delete participant.unreachable;
        const wrapper = document.getElementById(`video-wrapper-${clientId}`);
        if (wrapper) wrapper.classList.remove('unreachable');
    }

    _dropPeerSession(clientId) {
        // The subtle one: the peer is reconnecting, so its data channel is
        // already dead. A game left running here would simply freeze, with no
        // error anywhere to explain it.
        if (this.gameOpponentId === clientId) this.endGame('Игра прервана: участник переподключается');
        this._clearIceRestartTimer(clientId);
        this._clearNegotiationWatchdog(clientId);
        this._iceRestartAttempts.delete(clientId);
        // The peer came back on a new connection — it has earned a fresh
        // recovery budget, and is no longer known-unreachable.
        this._peerReconnectAttempts.delete(clientId);
        this._markPeerReachable(clientId);
        const pc = this.peerConnections.get(clientId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(clientId);
        }
        this.controlChannels.delete(clientId);
        this.pendingIceCandidates.delete(clientId);
    }

    _clearIceRestartTimer(clientId) {
        const timer = this._iceRestartTimers.get(clientId);
        if (timer) {
            clearTimeout(timer);
            this._iceRestartTimers.delete(clientId);
        }
    }

    _attemptIceRestart(clientId) {
        const attempt = (this._iceRestartAttempts.get(clientId) || 0) + 1;
        this._iceRestartAttempts.set(clientId, attempt);

        if (attempt > this._maxIceRestarts) {
            console.log(`Max ICE restarts reached for ${clientId}, doing full reconnect`);
            this._reconnectPeer(clientId);
            return;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`ICE restart attempt ${attempt}/${this._maxIceRestarts} for ${clientId} in ${delay}ms`);

        this._clearIceRestartTimer(clientId);
        this._iceRestartTimers.set(clientId, setTimeout(() => {
            if (this.peerConnections.has(clientId)) {
                this.createOffer(clientId, { iceRestart: true });
            }
        }, delay));
    }

    // Recovery is exhausted for this peer. Stop rebuilding the connection and
    // say so, instead of cycling forever: a peer we genuinely cannot route to
    // (no TURN, symmetric NAT on both ends) will not become reachable by
    // trying harder, and the churn costs mobile clients their battery.
    _giveUpOnPeer(clientId) {
        console.warn(`Giving up on peer ${clientId} — recovery exhausted`);
        if (this.gameOpponentId === clientId) this.endGame();
        this._clearIceRestartTimer(clientId);
        this._clearNegotiationWatchdog(clientId);
        this._iceRestartAttempts.delete(clientId);

        const pc = this.peerConnections.get(clientId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(clientId);
        }
        this.controlChannels.delete(clientId);
        this.pendingIceCandidates.delete(clientId);

        const participant = this.participants.get(clientId);
        if (participant) participant.unreachable = true;
        const wrapper = document.getElementById(`video-wrapper-${clientId}`);
        if (wrapper) wrapper.classList.add('unreachable');

        this.showToast('Не удалось соединиться с участником — возможно, нужен TURN-сервер');
        this.updateConnectionStatus(this.participantsLabel(), false);
    }

    async _reconnectPeer(clientId) {
        const cycle = (this._peerReconnectAttempts.get(clientId) || 0) + 1;
        this._peerReconnectAttempts.set(clientId, cycle);
        if (cycle > this._maxPeerReconnects) {
            this._giveUpOnPeer(clientId);
            return;
        }

        console.log(`Full reconnect for peer ${clientId} (${cycle}/${this._maxPeerReconnects})`);
        this.showToast(`Переподключение к участнику (${cycle}/${this._maxPeerReconnects})...`);

        // Clean up old connection
        this._clearIceRestartTimer(clientId);
        this._iceRestartAttempts.delete(clientId);

        const oldPc = this.peerConnections.get(clientId);
        if (oldPc) {
            oldPc.close();
            this.peerConnections.delete(clientId);
        }
        this.controlChannels.delete(clientId);
        this.pendingIceCandidates.delete(clientId);

        // Create new connection and offer
        try {
            await this.createOffer(clientId);
        } catch (error) {
            console.error('Error reconnecting peer:', error);
            this.showToast('Не удалось переподключиться');
        }
    }

    handlePeerLeft(clientId) {
        if (typeof clientId !== 'string' || !this.participants.has(clientId)) return;
        console.log('Peer left:', clientId);

        if (this.gameOpponentId === clientId) this.endGame('Соперник покинул игру');
        if (this.invitedPeer === clientId || this.pendingInviteFrom === clientId) this.endGame();

        // Clean up reconnection state
        this._clearIceRestartTimer(clientId);
        this._clearNegotiationWatchdog(clientId);
        this._iceRestartAttempts.delete(clientId);
        this._peerReconnectAttempts.delete(clientId);

        // Close peer connection
        const pc = this.peerConnections.get(clientId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(clientId);
        }
        this.controlChannels.delete(clientId);

        // Remove video
        this.removeVideoStream(clientId);

        // Remove from participants
        this.participants.delete(clientId);
        delete this.volumeSettings[clientId];

        // Clean up pending candidates
        this.pendingIceCandidates.delete(clientId);

        this.showToast('Участник покинул звонок');
        this.updateConnectionStatus(this.participantsLabel());
        this.rotateEncryptionKey();
    }

    // The key is rotated when somebody leaves, so a departed participant
    // cannot decrypt anything sent after they were gone. The remaining peer
    // with the lowest id does it — picking the current key owner would do
    // nothing in the case that matters most, which is the owner leaving.
    async rotateEncryptionKey() {
        if (!this.frameCryptor.encryptionEnabled) return;
        if (this.controlChannels.size === 0) return;
        // A peer that cannot encrypt would never carry out the rotation, so
        // electing it would silently leave the departed participant's key
        // valid.
        const eligible = Array.from(this.participants.values())
            .filter(p => !p.e2eeUnsupported)
            .map(p => p.id)
            .sort();
        if (eligible[0] !== this.clientId) return;

        try {
            await this.frameCryptor.setKey(crypto.getRandomValues(new Uint8Array(E2EE_KEY_BYTES)));
            this.keyOwner = this.clientId;
            this.keyEpoch += 1;
            this.broadcastControl({
                kind: 'e2ee-key',
                key: Array.from(this.frameCryptor.rawKeyData),
                owner: this.keyOwner,
                epoch: this.keyEpoch
            });
            console.log('Encryption key rotated after a participant left');
        } catch (error) {
            console.error('Key rotation failed:', error);
        }
    }

    toggleAudio() {
        if (this.localStream) {
            this.isAudioEnabled = !this.isAudioEnabled;
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = this.isAudioEnabled;
            });

            const btn = document.getElementById('toggle-audio-btn');
            const audioOn = btn.querySelector('.audio-on');
            const audioOff = btn.querySelector('.audio-off');

            btn.classList.toggle('active', this.isAudioEnabled);
            audioOn.classList.toggle('hidden', !this.isAudioEnabled);
            audioOff.classList.toggle('hidden', this.isAudioEnabled);

            // Update label
            const label = document.querySelector(`#video-wrapper-${CSS.escape(this.clientId)} .video-label`);
            if (label) {
                label.classList.toggle('muted', !this.isAudioEnabled);
            }

            this.broadcastControl({
                kind: 'mute-state',
                audio: this.isAudioEnabled,
                video: this.isVideoEnabled
            });
        }
    }

    toggleVideo() {
        if (this.localStream) {
            this.isVideoEnabled = !this.isVideoEnabled;
            this.localStream.getVideoTracks().forEach(track => {
                track.enabled = this.isVideoEnabled;
            });

            const btn = document.getElementById('toggle-video-btn');
            const videoOn = btn.querySelector('.video-on');
            const videoOff = btn.querySelector('.video-off');

            btn.classList.toggle('active', this.isVideoEnabled);
            videoOn.classList.toggle('hidden', !this.isVideoEnabled);
            videoOff.classList.toggle('hidden', this.isVideoEnabled);

            this.broadcastControl({
                kind: 'mute-state',
                audio: this.isAudioEnabled,
                video: this.isVideoEnabled
            });
        }
    }

    updateEncryptionUI(enabled) {
        const btn = document.getElementById('toggle-encryption-btn');
        const encryptionOn = btn.querySelector('.encryption-on');
        const encryptionOff = btn.querySelector('.encryption-off');
        const indicator = document.getElementById('encryption-indicator');

        btn.classList.toggle('active', enabled);
        encryptionOn.classList.toggle('hidden', !enabled);
        encryptionOff.classList.toggle('hidden', enabled);
        indicator.classList.toggle('hidden', !enabled);
    }

    async toggleEncryption() {
        if (!this.frameCryptor.supported) {
            this.showToast('Шифрование не поддерживается в этом браузере');
            return;
        }

        const enabling = !this.frameCryptor.encryptionEnabled;

        if (enabling) {
            // A fresh key on every enable doubles as key rotation: toggling
            // off and on after someone leaves locks the old key out.
            await this.frameCryptor.setKey(crypto.getRandomValues(new Uint8Array(E2EE_KEY_BYTES)));
            this.keyOwner = this.clientId;
            this.keyEpoch += 1;
            this.frameCryptor.enable();
            // The key travels only over DTLS-encrypted peer-to-peer data
            // channels — the signaling server never sees it.
            this.broadcastControl({
                kind: 'e2ee-key',
                key: Array.from(this.frameCryptor.rawKeyData),
                owner: this.keyOwner,
                epoch: this.keyEpoch
            });
            this.showToast('🔒 Шифрование включено');
        } else {
            this.frameCryptor.disable();
            this.keyOwner = null;
            this.broadcastControl({ kind: 'e2ee-off' });
            this.showToast('🔓 Шифрование выключено');
        }

        this.updateEncryptionUI(enabling);
    }

    // Reactions System
    loadReactionCounts() {
        const saved = localStorage.getItem('reactionCounts');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                console.error('Error loading reaction counts:', e);
            }
        }
        // Initialize with zero counts
        return this.reactions.reduce((acc, emoji) => {
            acc[emoji] = 0;
            return acc;
        }, {});
    }

    saveReactionCounts() {
        try {
            localStorage.setItem('reactionCounts', JSON.stringify(this.reactionCounts));
        } catch (e) { /* storage full or unavailable */ }
    }

    getSortedReactions() {
        // Sort reactions by count (descending), then by original order
        return [...this.reactions].sort((a, b) => {
            const countDiff = (this.reactionCounts[b] || 0) - (this.reactionCounts[a] || 0);
            if (countDiff !== 0) return countDiff;
            // Keep original order if counts are equal
            return this.reactions.indexOf(a) - this.reactions.indexOf(b);
        });
    }

    renderReactions() {
        const grid = document.getElementById('reactions-grid');
        grid.innerHTML = '';

        const sortedReactions = this.getSortedReactions();

        sortedReactions.forEach(emoji => {
            const item = document.createElement('div');
            item.className = 'reaction-item';
            item.textContent = emoji;

            // Add count badge if count > 0
            const count = this.reactionCounts[emoji] || 0;
            if (count > 0) {
                const badge = document.createElement('div');
                badge.className = 'reaction-count';
                badge.textContent = count;
                item.appendChild(badge);
            }

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.sendReaction(emoji);
            });

            grid.appendChild(item);
        });
    }

    // The button wears a different face every time, so the control looks alive
    // rather than like a fixed icon.
    shuffleReactionsButton() {
        const face = document.getElementById('reactions-btn-emoji');
        if (!face) return;
        const choices = BUTTON_FACES.filter(e => e !== face.textContent);
        face.textContent = choices[Math.floor(Math.random() * choices.length)];
    }

    toggleReactionsDropdown() {
        const dropdown = document.getElementById('reactions-dropdown');
        const isHidden = dropdown.classList.contains('hidden');

        if (isHidden) {
            // Show dropdown
            this.renderReactions();
            this.shuffleReactionsButton();
            dropdown.classList.remove('hidden');
        } else {
            // Hide dropdown
            dropdown.classList.add('hidden');
        }
    }

    sendReaction(emoji) {
        if (!this.roomId || !this.reactions.includes(emoji)) return;

        // Increment local count
        this.reactionCounts[emoji] = (this.reactionCounts[emoji] || 0) + 1;
        this.saveReactionCounts();

        // Show flying emoji locally
        this.showFlyingReaction(emoji);

        // Play sound
        this.playReactionSound();

        // Send to all participants over peer-to-peer data channels
        this.broadcastControl({ kind: 'reaction', emoji });
    }

    handleRemoteReaction(senderId, emoji) {
        // Only render reactions from the known set — never arbitrary strings
        if (!this.reactions.includes(emoji)) return;
        console.log('Received reaction:', emoji, 'from:', senderId);

        this.showFlyingReaction(emoji);
        this.playReactionSound();
    }

    showFlyingReaction(emoji) {
        const overlay = document.getElementById('reactions-overlay');
        if (overlay.childElementCount >= MAX_FLYING_REACTIONS) return;

        const reaction = document.createElement('div');
        reaction.className = 'flying-reaction';
        reaction.textContent = emoji;

        // Random horizontal position
        const randomX = Math.random() * (overlay.offsetWidth - 50);
        reaction.style.left = randomX + 'px';

        // Random drift and rotation for variety
        const driftX = (Math.random() - 0.5) * 100;
        const rotate = (Math.random() - 0.5) * 60;
        reaction.style.setProperty('--drift-x', `${driftX}px`);
        reaction.style.setProperty('--rotate', `${rotate}deg`);

        overlay.appendChild(reaction);

        // Remove after animation completes
        setTimeout(() => {
            reaction.remove();
        }, 3000);
    }

    ensureAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            // iOS moves the context to 'interrupted' on a phone call or Siri
            // and never resumes it on its own — remote audio would stay silent
            // for the rest of the call.
            this.audioContext.addEventListener('statechange', () => {
                if (this.audioContext.state !== 'running' && !document.hidden) {
                    this.audioContext.resume().catch(() => { /* needs a gesture */ });
                }
            });
        }
        if (this.audioContext.state !== 'running') {
            this.audioContext.resume().catch(() => { /* needs a gesture */ });
        }
        return this.audioContext;
    }

    playReactionSound() {
        try {
            const ctx = this.ensureAudioContext();
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);

            // Create a pleasant "pop" sound
            oscillator.frequency.setValueAtTime(800, ctx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.1);

            // Soft volume
            gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

            oscillator.start(ctx.currentTime);
            oscillator.stop(ctx.currentTime + 0.1);
        } catch (e) { /* sound is best-effort */ }
    }

    setupVolumeControl(clientId, videoElement, stream) {
        if (!this.useWebAudioOutput) {
            // WebKit: the element is the audio sink. Web Audio would be silent
            // here and would not throw, so there is nothing to fall back from.
            // Unmuting happens once playback is running — doing it here would
            // make the browser refuse to autoplay the tile at all.
            this.ensureAudioContext();
            return;
        }

        try {
            const audioContext = this.ensureAudioContext();

            // Mute the video element (we'll route audio through Web Audio API)
            videoElement.muted = true;

            const source = audioContext.createMediaStreamSource(stream);
            const gainNode = audioContext.createGain();
            // Boosting above 100% would otherwise hard-clip at the destination
            const limiter = audioContext.createDynamicsCompressor();
            limiter.threshold.value = -3;
            limiter.knee.value = 0;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.1;

            const savedVolume = this.volumeSettings[clientId] || 1.0;
            gainNode.gain.value = savedVolume;

            source.connect(gainNode);
            gainNode.connect(limiter);
            limiter.connect(audioContext.destination);

            this.audioContexts.set(clientId, {
                context: audioContext,
                source: source,
                gainNode: gainNode,
                limiter: limiter
            });
        } catch (error) {
            console.error('Error setting up volume control:', error);
            // Fall back to the element as the audio sink — but flag it rather
            // than unmuting now, so autoplay is not refused before it starts.
            videoElement.dataset.elementAudio = '1';
        }
    }

    // WebKit ignores media-element volume, so per-participant control there is
    // limited to muting.
    toggleParticipantMute(clientId, buttonElement) {
        const video = document.getElementById(`video-${clientId}`);
        if (!video) return;
        video.muted = !video.muted;
        buttonElement.textContent = video.muted ? '🔇' : '🔊';
        this.volumeSettings[clientId] = video.muted ? 0 : 1;

        const badge = document.getElementById(`volume-badge-${clientId}`);
        if (badge) {
            badge.textContent = video.muted ? 'Без звука' : '';
            badge.classList.toggle('visible', video.muted);
        }
        if (!video.muted) {
            this.ensureAudioContext();
            video.play().catch(() => { /* needs a gesture */ });
        }
    }

    showVolumeControl(clientId, buttonElement) {
        const volumeControl = document.getElementById('volume-control');
        const volumeSlider = document.getElementById('volume-slider');
        const volumeValue = document.getElementById('volume-value');

        // Get current volume
        const currentVolume = this.volumeSettings[clientId] || 1.0;
        const volumePercent = Math.round(currentVolume * 100);

        // Update slider
        volumeSlider.value = volumePercent;
        volumeValue.textContent = volumePercent + '%';

        // Position popup near the button, ensuring it stays within screen bounds
        const rect = buttonElement.getBoundingClientRect();
        // Popup dimensions accounting for rotated slider with margins
        const popupWidth = 50; // very narrow popup matching slider width
        const popupHeight = 310; // 180px slider + margins + icon + value + padding

        let left = rect.left - 5;
        let top = rect.bottom + 10;

        // Check if popup goes off the right edge
        if (left + popupWidth > window.innerWidth) {
            left = window.innerWidth - popupWidth - 10;
        }

        // Check if popup goes off the left edge
        if (left < 10) {
            left = 10;
        }

        // Check if popup goes off the bottom edge
        if (top + popupHeight > window.innerHeight) {
            // Position above the button instead
            top = rect.top - popupHeight - 10;
        }

        // Check if popup goes off the top edge
        if (top < 10) {
            top = 10;
        }

        volumeControl.style.left = left + 'px';
        volumeControl.style.top = top + 'px';

        // Show popup
        volumeControl.classList.remove('hidden');

        // Store current target
        this.currentVolumeTarget = clientId;
    }

    setParticipantVolume(clientId, volume) {
        const audioSetup = this.audioContexts.get(clientId);
        if (audioSetup && audioSetup.gainNode) {
            // Ramp instead of assigning: a step change on every slider event
            // is audible as zipper noise.
            const ctx = audioSetup.context;
            audioSetup.gainNode.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
        }

        // Remember for this call session
        this.volumeSettings[clientId] = volume;

        // Update badge
        const badge = document.getElementById(`volume-badge-${clientId}`);
        if (badge) {
            const percent = Math.round(volume * 100);
            badge.textContent = percent + '%';
            badge.classList.toggle('visible', percent !== 100);
        }
    }

    endCall() {
        // Before teardownPeers, so the game still has a channel to say goodbye
        // on, and so its render loop cannot outlive the call screen.
        this.leaveGame();

        // Any capture still waiting on the permission prompt is now unwanted
        this._mediaGeneration += 1;

        // Notify server first (teardown below closes nothing server-side)
        if (this.roomId) {
            this._sendWs({ type: 'leave' });
        }

        // Stop local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        // Close all peer connections, channels, timers, audio nodes, tiles
        this.teardownPeers();

        // Cancel any pending WebSocket reconnection
        this._cancelReconnect();

        // Reset encryption completely — the next call gets a fresh key
        this.frameCryptor.reset();
        this.updateEncryptionUI(false);

        // Reset state
        this.roomId = null;
        this.clientId = null;
        this.resumeToken = null;
        this.keyOwner = null;
        this.keyEpoch = 0;
        this.pendingJoinRoomId = null;
        this._lastRequestedRoom = null;
        this._joining = false;
        this._rejoining = false;
        this._rejoinRetryAttempt = 0;
        clearTimeout(this._rejoinRetryTimer);
        this._mediaPromise = null;
        this.participants.clear();
        this.isAudioEnabled = true;
        this.isVideoEnabled = true;
        this.volumeSettings = {};
        this.currentVolumeTarget = null;

        // Update UI
        this.callScreen.classList.remove('active');
        this.homeScreen.classList.add('active');
        document.getElementById('volume-control').classList.add('hidden');
        document.getElementById('reactions-dropdown').classList.add('hidden');
        document.getElementById('layout-selector').classList.add('hidden');

        // Reset URL
        window.history.replaceState({}, '', window.location.origin);

        // Reset buttons
        const audioBtn = document.getElementById('toggle-audio-btn');
        const videoBtn = document.getElementById('toggle-video-btn');
        audioBtn.classList.add('active');
        videoBtn.classList.add('active');
        audioBtn.querySelector('.audio-on').classList.remove('hidden');
        audioBtn.querySelector('.audio-off').classList.add('hidden');
        videoBtn.querySelector('.video-on').classList.remove('hidden');
        videoBtn.querySelector('.video-off').classList.add('hidden');
    }

    async copyLink() {
        const link = `${window.location.origin}?room=${encodeURIComponent(this.roomId)}`;

        try {
            await navigator.clipboard.writeText(link);
            this.showToast('Ссылка скопирована');
        } catch (error) {
            // Fallback for older browsers or Telegram WebView
            const textArea = document.createElement('textarea');
            textArea.value = link;
            textArea.style.position = 'fixed';
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.select();

            try {
                document.execCommand('copy');
                this.showToast('Ссылка скопирована');
            } catch (err) {
                this.showToast('Не удалось скопировать ссылку');
            }

            document.body.removeChild(textArea);
        }
    }

    shareTelegram() {
        const link = `${window.location.origin}?room=${encodeURIComponent(this.roomId)}`;
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Присоединяйтесь к звонку')}`;

        // Available only when the page loads the Telegram Mini App SDK, which
        // this build deliberately does not (see README: it would mean allowing
        // a third-party script on a page that holds the E2EE key).
        if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.openTelegramLink(shareUrl);
            return;
        }

        // In-app webviews frequently refuse window.open; navigating away would
        // end the call, so fall back to putting the link on the clipboard.
        const opened = window.open(shareUrl, '_blank', 'noopener');
        if (!opened) {
            this.copyLink();
        }
    }

    updateConnectionStatus(text, isConnected) {
        const statusElement = document.getElementById('connection-status');
        statusElement.textContent = text;
        // Routine text refreshes (participant counts) leave the green
        // "connected" state alone; only explicit true/false changes it.
        if (typeof isConnected === 'boolean') {
            statusElement.classList.toggle('connected', isConnected);
        }
    }

    showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');

        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    generateRoomId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        // Rejection sampling over a CSPRNG: uniform and unpredictable
        const limit = 256 - (256 % chars.length); // 252
        let result = '';
        while (result.length < 6) {
            const [byte] = crypto.getRandomValues(new Uint8Array(1));
            if (byte < limit) {
                result += chars[byte % chars.length];
            }
        }
        return result;
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new CallingApp());
} else {
    new CallingApp();
}
