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

const MEDIA_CONSTRAINTS = {
    video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
    },
    audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
    }
};

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
        // clientId of the participant whose E2EE key the room converged on
        this.keyOwner = null;

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

        // Reactions system
        this.reactions = ['❤️', '👍', '😂', '😮', '😢', '🔥', '🎉', '👏', '💯', '🚀'];
        this.reactionCounts = this.loadReactionCounts();
        this.audioContext = null;

        // Volume control system. Settings are per-call only: client ids are
        // ephemeral, so persisting them would just accumulate garbage.
        this.audioContexts = new Map(); // Map<clientId, {context, gainNode, source}>
        this.volumeSettings = {};
        this.currentVolumeTarget = null;
        try { localStorage.removeItem('volumeSettings'); } catch (e) { /* ignore */ }

        this.initUI();
        this.loadIceConfig();
        this.connectWebSocket();
    }

    async loadIceConfig() {
        try {
            const res = await fetch('/config');
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

        // Best-effort leave so peers are notified even on tab close
        window.addEventListener('pagehide', () => {
            if (this.roomId && this.ws && this.ws.readyState === WebSocket.OPEN) {
                try { this.ws.send(JSON.stringify({ type: 'leave' })); } catch (e) { /* ignore */ }
            }
        });

        // Check URL for room ID
        const urlParams = new URLSearchParams(window.location.search);
        const roomIdFromUrl = urlParams.get('room');
        if (roomIdFromUrl) {
            document.getElementById('room-id-input').value = roomIdFromUrl;
            this.toggleJoinInput();
        }
    }

    connectWebSocket() {
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
            this.showToast('Не удалось восстановить соединение');
            this.updateConnectionStatus('Отключено', false);
            // Unblock the join buttons so the user can retry manually
            this._joining = false;
            this.pendingJoinRoomId = null;
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
                    // The same identity was re-announced: the peer reconnected
                    // and is about to send a fresh offer. Its old session (and
                    // the data channel inside it) is dead — drop it so the
                    // offer lands on a brand-new connection.
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
                // The new peer creates offers to us; if encryption is on, the
                // key is sent over the encrypted data channel once it opens.
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
                this.showToast(`Звонок заполнен (максимум ${message.maxParticipants || this.maxParticipants} участников)`);
                if (!this.localStream) {
                    this.roomId = null;
                }
                break;

            case 'error':
                this._joining = false;
                this.showToast(message.text || 'Ошибка сервера');
                break;
        }
    }

    async handleJoined(message) {
        this._joining = false;
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
            await this.createOffer(participantId);
        }
        this.updateConnectionStatus(this.participantsLabel());
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

        this.peerConnections.forEach(pc => pc.close());
        this.peerConnections.clear();
        this.controlChannels.clear();
        this.pendingIceCandidates.clear();

        this.audioContexts.forEach((audioSetup) => {
            try {
                audioSetup.source.disconnect();
                audioSetup.gainNode.disconnect();
            } catch (e) { /* already disconnected */ }
        });
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

    async startCall() {
        try {
            if (!this.localStream || this.localStream.getTracks().every(t => t.readyState === 'ended')) {
                this.localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
            }
        } catch (error) {
            console.error('Error accessing media devices:', error);
            this.showToast('Не удалось получить доступ к камере/микрофону');
            this.endCall();
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
        // Mute all videos initially — local stays muted, remote audio is
        // routed through Web Audio API in setupVolumeControl().
        // This also ensures autoplay works on iOS Safari.
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

        // Tap/click toggles the per-tile controls overlay
        wrapper.addEventListener('click', () => {
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
            volumeBtn.title = 'Регулировка громкости';
            volumeBtn.setAttribute('aria-label', 'Регулировка громкости участника');
            volumeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showVolumeControl(clientId, volumeBtn);
            });
            wrapper.appendChild(volumeBtn);

            // Add volume badge (shown on hover if volume != 100%)
            const volumeBadge = document.createElement('div');
            volumeBadge.className = 'volume-badge';
            volumeBadge.id = `volume-badge-${clientId}`;
            const savedVolume = this.volumeSettings[clientId] || 1.0;
            if (savedVolume !== 1.0) {
                volumeBadge.textContent = Math.round(savedVolume * 100) + '%';
                volumeBadge.classList.add('visible');
            }
            wrapper.appendChild(volumeBadge);

            // Setup audio routing through Web Audio API
            this.setupVolumeControl(clientId, video, stream);
        }

        this.videosContainer.appendChild(wrapper);

        // Update grid layout
        this.updateGridLayout();

        // Try to play video
        video.play().catch(e => console.log('Autoplay prevented:', e));
    }

    removeVideoStream(clientId) {
        // Clean up audio context
        const audioSetup = this.audioContexts.get(clientId);
        if (audioSetup) {
            try {
                audioSetup.source.disconnect();
                audioSetup.gainNode.disconnect();
            } catch (e) {
                console.log('Error disconnecting audio nodes:', e);
            }
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
        if (this.layoutMode === 'auto') {
            // Auto mode: smart selection based on participant count
            if (participantCount <= 2) return 'grid';
            return 'spotlight';
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
        this.peerConnections.set(remoteClientId, pc);

        this.setupControlChannel(pc, remoteClientId);

        // Add local tracks; encryption transforms are installed up front and
        // stay in pass-through mode until encryption is enabled.
        this.localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, this.localStream);
            this.frameCryptor.setupSenderTransform(sender);
        });

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
                    // Reset ICE restart counter on success
                    this._iceRestartAttempts.delete(remoteClientId);
                    this._clearIceRestartTimer(remoteClientId);
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
                    owner: this.keyOwner
                });
            }
        };

        channel.onclose = () => {
            if (this.controlChannels.get(remoteClientId) === channel) {
                this.controlChannels.delete(remoteClientId);
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
                await this.handleRemoteEncryptionKey(senderId, message.key, message.owner);
                break;
            case 'e2ee-off':
                this.handleRemoteEncryptionDisabled(senderId);
                break;
            case 'e2ee-unsupported':
                this.showToast('⚠️ Браузер участника не поддерживает шифрование — его медиа скрыто');
                break;
            case 'reaction':
                this.handleRemoteReaction(senderId, message.emoji);
                break;
            case 'mute-state':
                this.handleRemoteMuteState(senderId, message);
                break;
        }
    }

    async handleRemoteEncryptionKey(senderId, key, owner) {
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

        try {
            const keyData = new Uint8Array(key);

            // Two peers can enable encryption simultaneously with different
            // keys. Converge deterministically on the key whose originator
            // id is lexicographically smallest; the loser re-asserts nothing,
            // the winner re-sends its key to the sender.
            if (this.frameCryptor.encryptionEnabled && this.frameCryptor.rawKeyData &&
                !this.frameCryptor.hasSameKey(keyData) &&
                this.keyOwner && this.keyOwner <= keyOwner) {
                this.sendControl(senderId, {
                    kind: 'e2ee-key',
                    key: Array.from(this.frameCryptor.rawKeyData),
                    owner: this.keyOwner
                });
                return;
            }

            const alreadyActive = this.frameCryptor.encryptionEnabled && this.frameCryptor.hasSameKey(keyData);
            if (!this.frameCryptor.hasSameKey(keyData)) {
                await this.frameCryptor.setKey(keyData);
            }
            this.keyOwner = keyOwner;
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
        const pc = this.peerConnections.get(remoteClientId) && options && options.iceRestart
            ? this.peerConnections.get(remoteClientId)
            : this.createPeerConnection(remoteClientId);

        try {
            const offer = await pc.createOffer(options);
            await pc.setLocalDescription(offer);

            this._sendWs({
                type: 'offer',
                offer: pc.localDescription,
                targetId: remoteClientId
            });
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    async handleOffer(message) {
        if (typeof message.senderId !== 'string' || !message.offer) return;

        // Ensure we have local stream before creating peer connection
        if (!this.localStream) {
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
                this.addVideoStream(this.clientId, this.localStream, true);
            } catch (error) {
                console.error('Error accessing media devices:', error);
                this.showToast('Не удалось получить доступ к камере/микрофону');
                return;
            }
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
                    console.log('Offer collision — ignoring remote offer (impolite peer)');
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
            // Only apply an answer if we are actually waiting for one
            if (pc && pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
                await this.processPendingIceCandidates(message.senderId);
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(message) {
        if (typeof message.senderId !== 'string' || !message.candidate) return;
        try {
            const pc = this.peerConnections.get(message.senderId);
            if (pc) {
                const candidate = new RTCIceCandidate(message.candidate);

                // Check if remote description is set
                if (pc.remoteDescription) {
                    await pc.addIceCandidate(candidate);
                } else {
                    // Buffer the candidate until remote description is set
                    if (!this.pendingIceCandidates.has(message.senderId)) {
                        this.pendingIceCandidates.set(message.senderId, []);
                    }
                    this.pendingIceCandidates.get(message.senderId).push(candidate);
                }
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
    _dropPeerSession(clientId) {
        this._clearIceRestartTimer(clientId);
        this._iceRestartAttempts.delete(clientId);
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

    async _reconnectPeer(clientId) {
        console.log(`Full reconnect for peer ${clientId}`);
        this.showToast('Переподключение к участнику...');

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

        // Clean up reconnection state
        this._clearIceRestartTimer(clientId);
        this._iceRestartAttempts.delete(clientId);

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
            this.frameCryptor.enable();
            // The key travels only over DTLS-encrypted peer-to-peer data
            // channels — the signaling server never sees it.
            this.broadcastControl({
                kind: 'e2ee-key',
                key: Array.from(this.frameCryptor.rawKeyData),
                owner: this.keyOwner
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

    toggleReactionsDropdown() {
        const dropdown = document.getElementById('reactions-dropdown');
        const isHidden = dropdown.classList.contains('hidden');

        if (isHidden) {
            // Show dropdown
            this.renderReactions();
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
        }
        // iOS Safari suspends AudioContext until resumed from a user gesture
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
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
        try {
            const audioContext = this.ensureAudioContext();

            // Mute the video element (we'll route audio through Web Audio API)
            videoElement.muted = true;

            // Create audio nodes
            const source = audioContext.createMediaStreamSource(stream);
            const gainNode = audioContext.createGain();

            // Set initial volume from saved settings
            const savedVolume = this.volumeSettings[clientId] || 1.0;
            gainNode.gain.value = savedVolume;

            // Connect audio pipeline
            source.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // Store references
            this.audioContexts.set(clientId, {
                context: audioContext,
                source: source,
                gainNode: gainNode
            });
        } catch (error) {
            console.error('Error setting up volume control:', error);
            // Fallback: unmute video element
            videoElement.muted = false;
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
        // Update volume in audio context
        const audioSetup = this.audioContexts.get(clientId);
        if (audioSetup && audioSetup.gainNode) {
            audioSetup.gainNode.gain.value = volume;
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
        this.pendingJoinRoomId = null;
        this._lastRequestedRoom = null;
        this._joining = false;
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

        // Try Telegram WebApp API first
        if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.openTelegramLink(shareUrl);
        } else {
            // Fallback to standard share URL
            window.open(shareUrl, '_blank', 'noopener');
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
