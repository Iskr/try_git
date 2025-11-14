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

// Frame Encryption using Web Crypto API and Insertable Streams
class FrameCryptor {
    constructor() {
        this.encryptionKey = null;
        this.encryptionEnabled = false;
        this.senderTransforms = new Map(); // Map<trackId, TransformStream>
        this.receiverTransforms = new Map(); // Map<trackId, TransformStream>
        this.frameCounters = new Map(); // Map<trackId, counter> for IV generation
    }

    async generateKey() {
        // Generate AES-GCM 128-bit key
        this.encryptionKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 128 },
            true,
            ['encrypt', 'decrypt']
        );
        console.log('Encryption key generated');
        return this.encryptionKey;
    }

    async setKey(keyData) {
        // Import key from raw data
        this.encryptionKey = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'AES-GCM', length: 128 },
            true,
            ['encrypt', 'decrypt']
        );
        console.log('Encryption key imported');
    }

    async exportKey() {
        if (!this.encryptionKey) {
            await this.generateKey();
        }
        const exported = await crypto.subtle.exportKey('raw', this.encryptionKey);
        return new Uint8Array(exported);
    }

    enable() {
        this.encryptionEnabled = true;
        console.log('Encryption enabled');
    }

    disable() {
        this.encryptionEnabled = false;
        console.log('Encryption disabled');
    }

    getIV(trackId, counter) {
        // Generate 12-byte IV (nonce) for AES-GCM
        // Format: [trackId hash (8 bytes)] + [counter (4 bytes)]
        const iv = new Uint8Array(12);

        // Simple hash of trackId
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
            // Get frame data
            const data = new Uint8Array(encodedFrame.data);

            // Get or initialize counter
            if (!this.frameCounters.has(trackId)) {
                this.frameCounters.set(trackId, 0);
            }
            const counter = this.frameCounters.get(trackId);
            this.frameCounters.set(trackId, counter + 1);

            // Generate IV
            const iv = this.getIV(trackId, counter);

            // Encrypt
            const encrypted = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                this.encryptionKey,
                data
            );

            // Create new frame with encrypted data + IV prepended
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

            // Extract IV (first 12 bytes)
            const iv = data.slice(0, 12);
            const encryptedData = data.slice(12);

            // Decrypt
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                this.encryptionKey,
                encryptedData
            );

            encodedFrame.data = decrypted;
            controller.enqueue(encodedFrame);
        } catch (error) {
            console.error('Decryption error:', error);
            // Skip frame if decryption fails
        }
    }

    setupSenderTransform(sender, trackId) {
        if (!sender.createEncodedStreams) {
            console.warn('Insertable Streams not supported');
            return;
        }

        const streams = sender.createEncodedStreams();
        const transformStream = new TransformStream({
            transform: async (encodedFrame, controller) => {
                await this.encryptFrame(encodedFrame, controller, trackId);
            }
        });

        streams.readable
            .pipeThrough(transformStream)
            .pipeTo(streams.writable);

        this.senderTransforms.set(trackId, transformStream);
        console.log('Sender transform setup for:', trackId);
    }

    setupReceiverTransform(receiver) {
        if (!receiver.createEncodedStreams) {
            console.warn('Insertable Streams not supported');
            return;
        }

        const streams = receiver.createEncodedStreams();
        const transformStream = new TransformStream({
            transform: async (encodedFrame, controller) => {
                await this.decryptFrame(encodedFrame, controller);
            }
        });

        streams.readable
            .pipeThrough(transformStream)
            .pipeTo(streams.writable);

        const trackId = receiver.track?.id || 'unknown';
        this.receiverTransforms.set(trackId, transformStream);
        console.log('Receiver transform setup for:', trackId);
    }

    clearTransforms() {
        this.senderTransforms.clear();
        this.receiverTransforms.clear();
        this.frameCounters.clear();
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
        this.isEncryptionEnabled = false;

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
        });

        // Volume slider event listeners
        const volumeSlider = document.getElementById('volume-slider');
        const volumeValue = document.getElementById('volume-value');

        volumeSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            volumeValue.textContent = value + '%';
            this.updateVolumeSliderGradient(value);

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
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleSignalingMessage(message);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.showToast('Ошибка подключения к серверу');
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            if (this.roomId) {
                this.showToast('Соединение потеряно');
            }
        };
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
                    if (this.isEncryptionEnabled) {
                        const keyData = await this.frameCryptor.exportKey();
                        const keyArray = Array.from(keyData);
                        this.ws.send(JSON.stringify({
                            type: 'encryption-key',
                            keyData: keyArray,
                            targetId: message.clientId
                        }));
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
        this.ws.send(JSON.stringify({
            type: 'join',
            roomId: roomId
        }));
    }

    async startCall() {
        try {
            // Get user media
            this.localStream = await navigator.mediaDevices.getUserMedia({
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
            });

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
        if (isLocal) {
            video.muted = true;
        }

        const label = document.createElement('div');
        label.className = 'video-label';
        const participant = this.participants.get(clientId);
        label.textContent = participant ? participant.name : (isLocal ? 'Вы' : 'Участник');

        wrapper.appendChild(video);
        wrapper.appendChild(label);

        // Add volume control button for remote participants
        if (!isLocal) {
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
            'auto': 'Авто'
        };
        this.showToast(`Режим: ${layoutNames[layout]}`);
    }

    createPeerConnection(remoteClientId) {
        const pc = new RTCPeerConnection(config);
        this.peerConnections.set(remoteClientId, pc);

        // Add local tracks and setup encryption
        this.localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, this.localStream);

            // Setup encryption transform for sender
            if (this.isEncryptionEnabled) {
                this.frameCryptor.setupSenderTransform(sender, track.id);
            }
        });

        // Handle remote stream
        pc.ontrack = (event) => {
            console.log('Received remote track from:', remoteClientId);
            this.addVideoStream(remoteClientId, event.streams[0], false);
            this.updateConnectionStatus(`${this.participants.size} участников`);

            // Setup encryption transform for receiver
            if (this.isEncryptionEnabled && event.receiver) {
                this.frameCryptor.setupReceiverTransform(event.receiver);
            }
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate to:', remoteClientId, event.candidate.type);
                this.ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    targetId: remoteClientId
                }));
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
                    this.updateConnectionStatus(`${this.participants.size} участников`, true);
                    break;
                case 'failed':
                    console.error('ICE connection failed for:', remoteClientId);
                    this.restartIce(remoteClientId);
                    break;
                case 'disconnected':
                    this.updateConnectionStatus('Переподключение...');
                    break;
            }
        };

        // Handle connection state
        pc.onconnectionstatechange = () => {
            console.log(`Connection state (${remoteClientId}):`, pc.connectionState);
            if (pc.connectionState === 'failed') {
                this.showToast('Не удалось подключиться к участнику');
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

            this.ws.send(JSON.stringify({
                type: 'offer',
                offer: offer,
                targetId: remoteClientId
            }));
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    async handleOffer(message) {
        // Ensure we have local stream before creating peer connection
        if (!this.localStream) {
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia({
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
                });
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

            this.ws.send(JSON.stringify({
                type: 'answer',
                answer: answer,
                targetId: message.senderId
            }));
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

    async restartIce(clientId) {
        const pc = this.peerConnections.get(clientId);
        if (!pc) return;

        console.log(`Attempting ICE restart for ${clientId}...`);

        try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);

            this.ws.send(JSON.stringify({
                type: 'offer',
                offer: offer,
                targetId: clientId
            }));
        } catch (error) {
            console.error('Error during ICE restart:', error);
        }
    }

    handlePeerLeft(clientId) {
        console.log('Peer left:', clientId);

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

    async toggleEncryption() {
        this.isEncryptionEnabled = !this.isEncryptionEnabled;

        const btn = document.getElementById('toggle-encryption-btn');
        const encryptionOn = btn.querySelector('.encryption-on');
        const encryptionOff = btn.querySelector('.encryption-off');
        const indicator = document.getElementById('encryption-indicator');

        btn.classList.toggle('active', this.isEncryptionEnabled);
        encryptionOn.classList.toggle('hidden', !this.isEncryptionEnabled);
        encryptionOff.classList.toggle('hidden', this.isEncryptionEnabled);
        indicator.classList.toggle('hidden', !this.isEncryptionEnabled);

        if (this.isEncryptionEnabled) {
            // Enable encryption
            this.frameCryptor.enable();

            // Generate and share encryption key
            const keyData = await this.frameCryptor.exportKey();
            await this.broadcastEncryptionKey(keyData);

            // Setup transforms for all existing connections
            this.peerConnections.forEach((pc, clientId) => {
                const senders = pc.getSenders();
                senders.forEach(sender => {
                    if (sender.track) {
                        this.frameCryptor.setupSenderTransform(sender, sender.track.id);
                    }
                });

                const receivers = pc.getReceivers();
                receivers.forEach(receiver => {
                    this.frameCryptor.setupReceiverTransform(receiver);
                });
            });

            this.showToast('🔒 Шифрование включено');
        } else {
            // Disable encryption
            this.frameCryptor.disable();
            this.frameCryptor.clearTransforms();

            // Notify all participants to disable encryption
            this.broadcastEncryptionDisabled();

            this.showToast('🔓 Шифрование выключено');
        }
    }

    async broadcastEncryptionKey(keyData) {
        // Send encryption key to all participants
        const keyArray = Array.from(keyData);

        this.participants.forEach((participant, clientId) => {
            if (clientId !== this.clientId) {
                this.ws.send(JSON.stringify({
                    type: 'encryption-key',
                    keyData: keyArray,
                    targetId: clientId
                }));
            }
        });
    }

    broadcastEncryptionDisabled() {
        // Notify all participants that encryption is disabled
        this.participants.forEach((participant, clientId) => {
            if (clientId !== this.clientId) {
                this.ws.send(JSON.stringify({
                    type: 'encryption-disabled',
                    targetId: clientId
                }));
            }
        });
        console.log('Broadcast encryption disabled to all participants');
    }

    async handleEncryptionKey(message) {
        try {
            const keyData = new Uint8Array(message.keyData);
            await this.frameCryptor.setKey(keyData);

            // Enable encryption
            this.frameCryptor.enable();
            this.isEncryptionEnabled = true;

            // Update UI
            const btn = document.getElementById('toggle-encryption-btn');
            const encryptionOn = btn.querySelector('.encryption-on');
            const encryptionOff = btn.querySelector('.encryption-off');
            const indicator = document.getElementById('encryption-indicator');

            btn.classList.add('active');
            encryptionOn.classList.remove('hidden');
            encryptionOff.classList.add('hidden');
            indicator.classList.remove('hidden');

            // Setup transforms for all existing connections
            this.peerConnections.forEach((pc, clientId) => {
                const senders = pc.getSenders();
                senders.forEach(sender => {
                    if (sender.track) {
                        this.frameCryptor.setupSenderTransform(sender, sender.track.id);
                    }
                });

                const receivers = pc.getReceivers();
                receivers.forEach(receiver => {
                    this.frameCryptor.setupReceiverTransform(receiver);
                });
            });

            console.log('Encryption key received from:', message.senderId);
            this.showToast('🔒 Шифрование включено');
        } catch (error) {
            console.error('Error handling encryption key:', error);
            this.showToast('Ошибка получения ключа шифрования');
        }
    }

    handleEncryptionDisabled(message) {
        try {
            // Disable encryption
            this.frameCryptor.disable();
            this.frameCryptor.clearTransforms();
            this.isEncryptionEnabled = false;

            // Update UI
            const btn = document.getElementById('toggle-encryption-btn');
            const encryptionOn = btn.querySelector('.encryption-on');
            const encryptionOff = btn.querySelector('.encryption-off');
            const indicator = document.getElementById('encryption-indicator');

            btn.classList.remove('active');
            encryptionOn.classList.add('hidden');
            encryptionOff.classList.remove('hidden');
            indicator.classList.add('hidden');

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
        this.participants.forEach((participant, clientId) => {
            if (clientId !== this.clientId) {
                this.ws.send(JSON.stringify({
                    type: 'reaction',
                    emoji: emoji,
                    targetId: clientId
                }));
            }
        });

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

    playReactionSound() {
        // Initialize audio context if needed
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = this.audioContext;
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
        localStorage.setItem('volumeSettings', JSON.stringify(this.volumeSettings));
    }

    setupVolumeControl(clientId, videoElement, stream) {
        try {
            // Create audio context if needed
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            const audioContext = this.audioContext;

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
        this.updateVolumeSliderGradient(volumePercent);

        // Position popup near the button
        const rect = buttonElement.getBoundingClientRect();
        volumeControl.style.left = (rect.left - 30) + 'px';
        volumeControl.style.top = (rect.bottom + 10) + 'px';

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

    updateVolumeSliderGradient(value) {
        const slider = document.getElementById('volume-slider');
        const percentage = value / 2; // Since max is 200
        slider.style.background = `linear-gradient(to bottom, var(--primary-color) 0%, var(--primary-color) ${percentage}%, var(--border-color) ${percentage}%, var(--border-color) 100%)`;
    }

    endCall() {
        // Stop local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

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
        if (this.ws && this.roomId) {
            this.ws.send(JSON.stringify({
                type: 'leave',
                roomId: this.roomId
            }));
        }

        // Reset encryption
        this.isEncryptionEnabled = false;
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

        setTimeout(() => {
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
