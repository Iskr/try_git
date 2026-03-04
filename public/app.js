// WebRTC Configuration
const config = {
    iceServers: [
        // STUN servers (only 1-2 needed)
        { urls: 'stun:stun.l.google.com:19302' },

        // Multiple TURN server options for better reliability
        // Twilio STUN/TURN (fallback)
        {
            urls: 'stun:global.stun.twilio.com:3478'
        },

        // Free TURN server alternative 1
        {
            urls: [
                'turn:numb.viagenie.ca',
                'turn:numb.viagenie.ca:3478'
            ],
            username: 'webrtc@live.com',
            credential: 'muazkh'
        },

        // Free TURN server alternative 2
        {
            urls: [
                'turn:turn.anyfirewall.com:443?transport=tcp',
            ],
            username: 'webrtc',
            credential: 'webrtc'
        },

        // OpenRelay (may be unstable)
        {
            urls: [
                'turn:openrelay.metered.ca:80',
                'turn:openrelay.metered.ca:443',
                'turn:openrelay.metered.ca:443?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all', // Try all connection types
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

const MAX_PARTICIPANTS = 5;

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

// Frame Encryption using Web Crypto API
// Supports both Chrome (createEncodedStreams) and Safari/Firefox (RTCRtpScriptTransform)
class FrameCryptor {
    constructor() {
        this.encryptionKey = null;
        this.encryptionEnabled = false;
        this.rawKeyData = null; // Raw key bytes for sharing with workers
        this.senderTransforms = new Map();
        this.receiverTransforms = new Map();
        this.frameCounters = new Map();
        this.workerPorts = []; // MessagePorts to workers (for RTCRtpScriptTransform)

        // Detect which API is available
        this.useScriptTransform = typeof RTCRtpScriptTransform !== 'undefined';
        this.useLegacyStreams = !this.useScriptTransform &&
            typeof RTCRtpSender !== 'undefined' &&
            typeof RTCRtpSender.prototype.createEncodedStreams === 'function';
    }

    get supported() {
        return this.useScriptTransform || this.useLegacyStreams;
    }

    async generateKey() {
        this.encryptionKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 128 },
            true,
            ['encrypt', 'decrypt']
        );
        this.rawKeyData = new Uint8Array(await crypto.subtle.exportKey('raw', this.encryptionKey));
        return this.encryptionKey;
    }

    async setKey(keyData) {
        this.rawKeyData = new Uint8Array(keyData);
        this.encryptionKey = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'AES-GCM', length: 128 },
            true,
            ['encrypt', 'decrypt']
        );
        this._syncKeyToWorkers();
    }

    async exportKey() {
        if (!this.encryptionKey) {
            await this.generateKey();
        }
        return new Uint8Array(this.rawKeyData);
    }

    enable() {
        this.encryptionEnabled = true;
        // Notify all workers
        this.workerPorts.forEach(port => port.postMessage({ type: 'enable' }));
    }

    disable() {
        this.encryptionEnabled = false;
        this.workerPorts.forEach(port => port.postMessage({ type: 'disable' }));
    }

    // Send current key to all workers
    _syncKeyToWorkers() {
        if (!this.rawKeyData) return;
        const keyArray = Array.from(this.rawKeyData);
        this.workerPorts.forEach(port => port.postMessage({ type: 'setKey', keyData: keyArray }));
    }

    // --- Legacy API (Chrome): createEncodedStreams ---

    getIV(trackId, counter) {
        const iv = new Uint8Array(12);
        const hash = trackId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const view = new DataView(iv.buffer);
        view.setUint32(0, hash);
        view.setUint32(4, hash >> 8);
        view.setUint32(8, counter);
        return iv;
    }

    async encryptFrame(encodedFrame, controller, trackId) {
        if (!this.encryptionEnabled || !this.encryptionKey) {
            controller.enqueue(encodedFrame);
            return;
        }
        try {
            const data = new Uint8Array(encodedFrame.data);
            if (!this.frameCounters.has(trackId)) {
                this.frameCounters.set(trackId, 0);
            }
            const counter = this.frameCounters.get(trackId);
            this.frameCounters.set(trackId, counter + 1);
            const iv = this.getIV(trackId, counter);
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.encryptionKey, data);
            const newData = new Uint8Array(12 + encrypted.byteLength);
            newData.set(iv, 0);
            newData.set(new Uint8Array(encrypted), 12);
            encodedFrame.data = newData.buffer;
            controller.enqueue(encodedFrame);
        } catch (error) {
            console.error('Encryption error:', error);
            controller.enqueue(encodedFrame);
        }
    }

    async decryptFrame(encodedFrame, controller) {
        if (!this.encryptionEnabled || !this.encryptionKey) {
            controller.enqueue(encodedFrame);
            return;
        }
        try {
            const data = new Uint8Array(encodedFrame.data);
            const iv = data.slice(0, 12);
            const encryptedData = data.slice(12);
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.encryptionKey, encryptedData);
            encodedFrame.data = decrypted;
            controller.enqueue(encodedFrame);
        } catch (error) {
            // Skip frame if decryption fails
        }
    }

    _setupSenderLegacy(sender, trackId) {
        const streams = sender.createEncodedStreams();
        const transformStream = new TransformStream({
            transform: async (encodedFrame, controller) => {
                await this.encryptFrame(encodedFrame, controller, trackId);
            }
        });
        streams.readable.pipeThrough(transformStream).pipeTo(streams.writable);
        this.senderTransforms.set(trackId, transformStream);
    }

    _setupReceiverLegacy(receiver) {
        const streams = receiver.createEncodedStreams();
        const transformStream = new TransformStream({
            transform: async (encodedFrame, controller) => {
                await this.decryptFrame(encodedFrame, controller);
            }
        });
        streams.readable.pipeThrough(transformStream).pipeTo(streams.writable);
        const trackId = receiver.track?.id || 'unknown';
        this.receiverTransforms.set(trackId, transformStream);
    }

    // --- Standard API (Safari/Firefox): RTCRtpScriptTransform ---

    _setupSenderScriptTransform(sender, trackId) {
        const worker = new Worker('encryption-worker.js');
        const channel = new MessageChannel();

        sender.transform = new RTCRtpScriptTransform(
            worker,
            { name: 'sender', trackId, port: channel.port2 },
            [channel.port2]
        );

        channel.port1.start();
        this.workerPorts.push(channel.port1);

        // Send current state to new worker
        if (this.rawKeyData) {
            channel.port1.postMessage({ type: 'setKey', keyData: Array.from(this.rawKeyData) });
        }
        if (this.encryptionEnabled) {
            channel.port1.postMessage({ type: 'enable' });
        }

        this.senderTransforms.set(trackId, { worker, port: channel.port1 });
    }

    _setupReceiverScriptTransform(receiver) {
        const trackId = receiver.track?.id || 'unknown';
        const worker = new Worker('encryption-worker.js');
        const channel = new MessageChannel();

        receiver.transform = new RTCRtpScriptTransform(
            worker,
            { name: 'receiver', trackId, port: channel.port2 },
            [channel.port2]
        );

        channel.port1.start();
        this.workerPorts.push(channel.port1);

        // Send current state to new worker
        if (this.rawKeyData) {
            channel.port1.postMessage({ type: 'setKey', keyData: Array.from(this.rawKeyData) });
        }
        if (this.encryptionEnabled) {
            channel.port1.postMessage({ type: 'enable' });
        }

        this.receiverTransforms.set(trackId, { worker, port: channel.port1 });
    }

    // --- Public API ---

    setupSenderTransform(sender, trackId) {
        if (this.useScriptTransform) {
            this._setupSenderScriptTransform(sender, trackId);
        } else if (this.useLegacyStreams) {
            this._setupSenderLegacy(sender, trackId);
        }
    }

    setupReceiverTransform(receiver) {
        if (this.useScriptTransform) {
            this._setupReceiverScriptTransform(receiver);
        } else if (this.useLegacyStreams) {
            this._setupReceiverLegacy(receiver);
        }
    }

    clearTransforms() {
        // Terminate workers
        this.senderTransforms.forEach(entry => {
            if (entry.worker) entry.worker.terminate();
        });
        this.receiverTransforms.forEach(entry => {
            if (entry.worker) entry.worker.terminate();
        });
        this.senderTransforms.clear();
        this.receiverTransforms.clear();
        this.frameCounters.clear();
        this.workerPorts = [];
    }
}

class CallingApp {
    constructor() {
        this.ws = null;
        this.peerConnections = new Map(); // Map<clientId, RTCPeerConnection>
        this.localStream = null;
        this.roomId = null;
        this.clientId = null;
        this.participants = new Map(); // Map<clientId, participantInfo>
        this.isAudioEnabled = true;
        this.isVideoEnabled = true;
        this.pendingIceCandidates = new Map(); // Map<clientId, ICECandidate[]>

        this.videosContainer = null;
        this.layoutMode = localStorage.getItem('layoutMode') || 'auto'; // grid, spotlight, sidebar, auto

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

        // Volume control system
        this.audioContexts = new Map(); // Map<clientId, {context, gainNode, source}>
        this.volumeSettings = this.loadVolumeSettings();
        this.currentVolumeTarget = null;

        this.initUI();
        this.connectWebSocket();
    }

    initUI() {
        // Screen elements
        this.homeScreen = document.getElementById('home-screen');
        this.callScreen = document.getElementById('call-screen');

        // Home screen buttons
        document.getElementById('create-call-btn').addEventListener('click', () => this.createCall());
        document.getElementById('join-call-btn').addEventListener('click', () => this.toggleJoinInput());
        document.getElementById('join-submit-btn').addEventListener('click', () => this.joinCall());

        // Call screen controls
        document.getElementById('toggle-audio-btn').addEventListener('click', () => this.toggleAudio());
        document.getElementById('toggle-video-btn').addEventListener('click', () => this.toggleVideo());
        document.getElementById('toggle-encryption-btn').addEventListener('click', () => this.toggleEncryption());
        document.getElementById('reactions-btn').addEventListener('click', () => this.toggleReactionsDropdown());
        document.getElementById('end-call-btn').addEventListener('click', () => this.endCall());
        document.getElementById('copy-link-btn').addEventListener('click', () => this.copyLink());
        document.getElementById('share-telegram-btn').addEventListener('click', () => this.shareTelegram());

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

            // If we were in a call, rejoin the room
            if (this.roomId && this.clientId) {
                console.log('Rejoining room after reconnect...');
                this.ws.send(JSON.stringify({
                    type: 'rejoin',
                    roomId: this.roomId,
                    clientId: this.clientId
                }));
                this.showToast('Соединение восстановлено');
            }

            this._startHeartbeat();
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'pong') {
                // Heartbeat response received
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

            if (this.roomId) {
                this.updateConnectionStatus('Переподключение...');
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
            this.updateConnectionStatus('Отключено');
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
                this.clientId = message.clientId;
                this.roomId = message.roomId;
                this.participants.set(this.clientId, { id: this.clientId, name: 'Вы' });
                await this.startCall();
                // Connect to existing participants
                if (message.participants && message.participants.length > 0) {
                    for (const participantId of message.participants) {
                        this.participants.set(participantId, { id: participantId, name: `Участник ${participantId.substr(0, 4)}` });
                        await this.createOffer(participantId);
                    }
                }
                break;

            case 'peer-joined':
                if (this.participants.size < MAX_PARTICIPANTS) {
                    this.participants.set(message.clientId, { id: message.clientId, name: `Участник ${message.clientId.substr(0, 4)}` });
                    this.updateConnectionStatus(`${this.participants.size} участников`);

                    // If encryption is enabled, share key with new participant
                    if (this.frameCryptor.encryptionEnabled) {
                        const keyData = await this.frameCryptor.exportKey();
                        const keyArray = Array.from(keyData);
                        this._sendWs({
                            type: 'encryption-key',
                            keyData: keyArray,
                            targetId: message.clientId
                        });
                        console.log('Sent encryption key to new participant:', message.clientId);
                    }

                    // New peer will create offer to us, we'll respond with answer
                } else {
                    console.warn('Max participants reached');
                }
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

            case 'encryption-key':
                await this.handleEncryptionKey(message);
                break;

            case 'encryption-disabled':
                this.handleEncryptionDisabled(message);
                break;

            case 'reaction':
                this.handleReaction(message);
                break;

            case 'peer-left':
                this.handlePeerLeft(message.clientId);
                break;
        }
    }

    async createCall() {
        this.roomId = this.generateRoomId();
        this.joinRoom(this.roomId);
    }

    toggleJoinInput() {
        const container = document.getElementById('join-input-container');
        container.classList.toggle('hidden');
    }

    async joinCall() {
        const input = document.getElementById('room-id-input');
        const roomId = input.value.trim().toUpperCase();

        if (!roomId) {
            this.showToast('Введите код звонка');
            return;
        }

        this.joinRoom(roomId);
    }

    joinRoom(roomId) {
        this._sendWs({
            type: 'join',
            roomId: roomId
        });
    }

    async startCall() {
        try {
            // Get user media
            this.localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);

            // Add local video to grid
            this.addVideoStream(this.clientId, this.localStream, true);

            // Show call screen
            this.homeScreen.classList.remove('active');
            this.callScreen.classList.add('active');

            // Update UI
            document.getElementById('current-room-id').textContent = this.roomId;
            this.updateConnectionStatus('Ожидание участников...');

            // Initialize layout selector
            document.querySelectorAll('.layout-option').forEach(option => {
                option.classList.toggle('selected', option.dataset.layout === this.layoutMode);
            });

            // Update URL
            const newUrl = `${window.location.origin}?room=${this.roomId}`;
            window.history.pushState({}, '', newUrl);

        } catch (error) {
            console.error('Error accessing media devices:', error);
            this.showToast('Не удалось получить доступ к камере/микрофону');
            this.endCall();
        }
    }

    addVideoStream(clientId, stream, isLocal = false) {
        // Remove existing video if present
        this.removeVideoStream(clientId);

        const wrapper = document.createElement('div');
        wrapper.className = `video-wrapper${isLocal ? ' local-video' : ''}`;
        wrapper.id = `video-wrapper-${clientId}`;

        const video = document.createElement('video');
        video.id = `video-${clientId}`;
        video.srcObject = stream;
        video.autoplay = true;
        video.playsinline = true;
        // Mute all videos initially — local stays muted, remote audio is
        // routed through Web Audio API in setupVolumeControl().
        // This also ensures autoplay works on iOS Safari.
        video.muted = true;

        const label = document.createElement('div');
        label.className = 'video-label';
        const participant = this.participants.get(clientId);
        label.textContent = participant ? participant.name : (isLocal ? 'Вы' : 'Участник');

        wrapper.appendChild(video);
        wrapper.appendChild(label);

        if (isLocal) {
            // Mirror local video by default and add toggle
            const isMirrored = localStorage.getItem('localVideoMirrored') !== 'false';
            if (isMirrored) {
                wrapper.classList.add('mirrored');
            }

            // Add click handler to show controls on local video too
            wrapper.addEventListener('click', () => {
                const wasShowing = wrapper.classList.contains('show-controls');
                document.querySelectorAll('.video-wrapper.show-controls').forEach(w => {
                    w.classList.remove('show-controls');
                });
                if (!wasShowing) {
                    wrapper.classList.add('show-controls');
                }
            });

            const mirrorBtn = document.createElement('button');
            mirrorBtn.className = 'mirror-btn' + (isMirrored ? ' active' : '');
            mirrorBtn.title = 'Зеркалировать видео';
            mirrorBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/></svg>';
            mirrorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                wrapper.classList.toggle('mirrored');
                const nowMirrored = wrapper.classList.contains('mirrored');
                mirrorBtn.classList.toggle('active', nowMirrored);
                localStorage.setItem('localVideoMirrored', nowMirrored);
            });
            wrapper.appendChild(mirrorBtn);
        }

        // Add volume control button for remote participants
        if (!isLocal) {
            // Add click handler to show controls
            wrapper.addEventListener('click', (e) => {
                // Toggle controls visibility
                const wasShowing = wrapper.classList.contains('show-controls');

                // Hide controls on all other videos
                document.querySelectorAll('.video-wrapper.show-controls').forEach(w => {
                    w.classList.remove('show-controls');
                });

                // Show controls on this video if it wasn't showing before
                if (!wasShowing) {
                    wrapper.classList.add('show-controls');
                }
            });

            const volumeBtn = document.createElement('div');
            volumeBtn.className = 'volume-btn';
            volumeBtn.innerHTML = '🔊';
            volumeBtn.title = 'Регулировка громкости';
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
            if (participantCount === 1) return 'grid';
            if (participantCount === 2) return 'grid';
            if (participantCount >= 3) return 'spotlight';
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
        const pcConfig = { ...config };
        // Chrome requires encodedInsertableStreams for createEncodedStreams API
        // Always enable it so transforms can be set up ahead of time
        if (this.frameCryptor.useLegacyStreams) {
            pcConfig.encodedInsertableStreams = true;
        }
        const pc = new RTCPeerConnection(pcConfig);
        this.peerConnections.set(remoteClientId, pc);

        // Add local tracks — always set up encryption transforms
        // (they pass through frames unmodified when encryption is disabled)
        this.localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, this.localStream);
            if (this.frameCryptor.supported) {
                this.frameCryptor.setupSenderTransform(sender, track.id);
            }
        });

        // Handle remote stream
        pc.ontrack = (event) => {
            console.log('Received remote track from:', remoteClientId);
            this.addVideoStream(remoteClientId, event.streams[0], false);
            this.updateConnectionStatus(`${this.participants.size} участников`);

            // Always set up receiver transforms (pass-through when disabled)
            if (this.frameCryptor.supported && event.receiver) {
                this.frameCryptor.setupReceiverTransform(event.receiver);
            }
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate to:', remoteClientId, event.candidate.type);
                this._sendWs({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    targetId: remoteClientId
                });
            } else {
                console.log('All ICE candidates sent to:', remoteClientId);
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
                    this.updateConnectionStatus(`${this.participants.size} участников`, true);
                    break;
                case 'failed':
                    console.error('ICE connection failed for:', remoteClientId);
                    this._attemptIceRestart(remoteClientId);
                    break;
                case 'disconnected':
                    this.updateConnectionStatus('Переподключение...');
                    // Start a timer — if not recovered in 5s, try ICE restart
                    this._clearIceRestartTimer(remoteClientId);
                    this._iceRestartTimers.set(remoteClientId, setTimeout(() => {
                        const currentPc = this.peerConnections.get(remoteClientId);
                        if (currentPc && currentPc.iceConnectionState === 'disconnected') {
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
            if (pc.connectionState === 'failed') {
                // Full reconnect — close old connection and create new one
                this._reconnectPeer(remoteClientId);
            }
        };

        // Handle ICE gathering state
        pc.onicegatheringstatechange = () => {
            console.log(`ICE gathering state (${remoteClientId}):`, pc.iceGatheringState);
        };

        return pc;
    }

    async createOffer(remoteClientId) {
        const pc = this.createPeerConnection(remoteClientId);

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            this._sendWs({
                type: 'offer',
                offer: offer,
                targetId: remoteClientId
            });
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    async handleOffer(message) {
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

        const pc = this.createPeerConnection(message.senderId);

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(message.offer));

            // Process any pending ICE candidates
            await this.processPendingIceCandidates(message.senderId);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this._sendWs({
                type: 'answer',
                answer: answer,
                targetId: message.senderId
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(message) {
        try {
            const pc = this.peerConnections.get(message.senderId);
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
                await this.processPendingIceCandidates(message.senderId);
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(message) {
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
                    console.log(`Buffered ICE candidate for ${message.senderId}`);
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
        this._iceRestartTimers.set(clientId, setTimeout(async () => {
            const pc = this.peerConnections.get(clientId);
            if (!pc) return;

            try {
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                this._sendWs({
                    type: 'offer',
                    offer: offer,
                    targetId: clientId
                });
            } catch (error) {
                console.error('Error during ICE restart:', error);
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

        // Remove video
        this.removeVideoStream(clientId);

        // Remove from participants
        this.participants.delete(clientId);

        // Clean up pending candidates
        this.pendingIceCandidates.delete(clientId);

        this.showToast('Участник покинул звонок');
        this.updateConnectionStatus(`${this.participants.size} участников`);
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
            const label = document.querySelector(`#video-wrapper-${this.clientId} .video-label`);
            if (label) {
                label.classList.toggle('muted', !this.isAudioEnabled);
            }
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
        const enabling = !this.frameCryptor.encryptionEnabled;

        if (enabling) {
            if (!this.frameCryptor.supported) {
                this.showToast('Шифрование не поддерживается в этом браузере');
                return;
            }

            // Generate and share encryption key, then enable
            const keyData = await this.frameCryptor.exportKey();
            await this.broadcastEncryptionKey(keyData);
            this.frameCryptor.enable();

            this.showToast('🔒 Шифрование включено');
        } else {
            // Disable encryption (transforms stay as pass-through)
            this.frameCryptor.disable();

            // Notify all participants to disable encryption
            this.broadcastEncryptionDisabled();

            this.showToast('🔓 Шифрование выключено');
        }

        this.updateEncryptionUI(enabling);
    }

    broadcastToParticipants(message) {
        this.participants.forEach((_, clientId) => {
            if (clientId !== this.clientId) {
                this._sendWs({ ...message, targetId: clientId });
            }
        });
    }

    async broadcastEncryptionKey(keyData) {
        this.broadcastToParticipants({ type: 'encryption-key', keyData: Array.from(keyData) });
    }

    broadcastEncryptionDisabled() {
        this.broadcastToParticipants({ type: 'encryption-disabled' });
    }

    async handleEncryptionKey(message) {
        try {
            const keyData = new Uint8Array(message.keyData);
            await this.frameCryptor.setKey(keyData);

            // Enable encryption (transforms already in place as pass-through)
            this.frameCryptor.enable();

            this.updateEncryptionUI(true);
            console.log('Encryption key received from:', message.senderId);
            this.showToast('🔒 Шифрование включено');
        } catch (error) {
            console.error('Error handling encryption key:', error);
            this.showToast('Ошибка получения ключа шифрования');
        }
    }

    handleEncryptionDisabled(message) {
        try {
            this.frameCryptor.disable();
            this.updateEncryptionUI(false);
            console.log('Encryption disabled by:', message.senderId);
            this.showToast('🔓 Шифрование выключено');
        } catch (error) {
            console.error('Error handling encryption disabled:', error);
        }
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
        localStorage.setItem('reactionCounts', JSON.stringify(this.reactionCounts));
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
        if (!this.roomId) return;

        // Increment local count
        this.reactionCounts[emoji] = (this.reactionCounts[emoji] || 0) + 1;
        this.saveReactionCounts();

        // Show flying emoji locally
        this.showFlyingReaction(emoji);

        // Play sound
        this.playReactionSound();

        // Send to all participants
        this.broadcastToParticipants({ type: 'reaction', emoji });

        console.log('Sent reaction:', emoji);
    }

    handleReaction(message) {
        const emoji = message.emoji;
        console.log('Received reaction:', emoji, 'from:', message.senderId);

        // Show flying emoji
        this.showFlyingReaction(emoji);

        // Play sound
        this.playReactionSound();
    }

    showFlyingReaction(emoji) {
        const overlay = document.getElementById('reactions-overlay');
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
    }

    // Volume Control System
    loadVolumeSettings() {
        const saved = localStorage.getItem('volumeSettings');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                console.error('Error loading volume settings:', e);
            }
        }
        return {};
    }

    saveVolumeSettings() {
        clearTimeout(this._saveVolumeTimer);
        this._saveVolumeTimer = setTimeout(() => {
            localStorage.setItem('volumeSettings', JSON.stringify(this.volumeSettings));
        }, 300);
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

            console.log(`Volume control setup for ${clientId}, initial volume: ${savedVolume}`);
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

        // Save to settings
        this.volumeSettings[clientId] = volume;
        this.saveVolumeSettings();

        // Update badge
        const badge = document.getElementById(`volume-badge-${clientId}`);
        if (badge) {
            const percent = Math.round(volume * 100);
            badge.textContent = percent + '%';
            if (percent !== 100) {
                badge.classList.add('visible');
            } else {
                badge.classList.remove('visible');
            }
        }

        console.log(`Set volume for ${clientId}: ${Math.round(volume * 100)}%`);
    }

    endCall() {
        // Stop local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        // Clean up ICE restart timers
        this._iceRestartTimers.forEach(timer => clearTimeout(timer));
        this._iceRestartTimers.clear();
        this._iceRestartAttempts.clear();

        // Close all peer connections
        this.peerConnections.forEach((pc, clientId) => {
            pc.close();
        });
        this.peerConnections.clear();

        // Clean up all audio contexts
        this.audioContexts.forEach((audioSetup, clientId) => {
            try {
                audioSetup.source.disconnect();
                audioSetup.gainNode.disconnect();
            } catch (e) {
                console.log('Error disconnecting audio nodes:', e);
            }
        });
        this.audioContexts.clear();

        // Notify server
        this._sendWs({ type: 'leave', roomId: this.roomId });

        // Cancel any pending reconnection
        this._cancelReconnect();
        this._stopHeartbeat();

        // Reset encryption
        this.frameCryptor.disable();
        this.frameCryptor.clearTransforms();

        // Reset state
        this.roomId = null;
        this.clientId = null;
        this.participants.clear();
        this.isAudioEnabled = true;
        this.isVideoEnabled = true;
        this.pendingIceCandidates.clear();

        // Clear videos
        this.videosContainer.innerHTML = '';
        this.updateGridLayout();

        // Update UI
        this.callScreen.classList.remove('active');
        this.homeScreen.classList.add('active');

        // Reset URL
        window.history.pushState({}, '', window.location.origin);

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
        const link = `${window.location.origin}?room=${this.roomId}`;

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
        const link = `${window.location.origin}?room=${this.roomId}`;
        const text = `Присоединяйтесь к звонку: ${link}`;

        // Try Telegram WebApp API first
        if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Присоединяйтесь к звонку')}`);
        } else {
            // Fallback to standard share URL
            window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Присоединяйтесь к звонку')}`, '_blank');
        }
    }

    updateConnectionStatus(text, isConnected = false) {
        const statusElement = document.getElementById('connection-status');
        statusElement.textContent = text;
        statusElement.classList.toggle('connected', isConnected);
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
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
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
