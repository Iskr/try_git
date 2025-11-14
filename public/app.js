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
        document.getElementById('end-call-btn').addEventListener('click', () => this.endCall());
        document.getElementById('copy-link-btn').addEventListener('click', () => this.copyLink());
        document.getElementById('share-telegram-btn').addEventListener('click', () => this.shareTelegram());

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
        this.videosContainer.appendChild(wrapper);

        // Update grid layout
        this.updateGridLayout();

        // Try to play video
        video.play().catch(e => console.log('Autoplay prevented:', e));
    }

    removeVideoStream(clientId) {
        const wrapper = document.getElementById(`video-wrapper-${clientId}`);
        if (wrapper) {
            wrapper.remove();
        }
        this.updateGridLayout();
    }

    updateGridLayout() {
        const count = this.videosContainer.children.length;
        this.videosContainer.setAttribute('data-participants', count);
    }

    createPeerConnection(remoteClientId) {
        const pc = new RTCPeerConnection(config);
        this.peerConnections.set(remoteClientId, pc);

        // Add local tracks
        this.localStream.getTracks().forEach(track => {
            pc.addTrack(track, this.localStream);
        });

        // Handle remote stream
        pc.ontrack = (event) => {
            console.log('Received remote track from:', remoteClientId);
            this.addVideoStream(remoteClientId, event.streams[0], false);
            this.updateConnectionStatus(`${this.participants.size} участников`);
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

        // Notify server
        if (this.ws && this.roomId) {
            this.ws.send(JSON.stringify({
                type: 'leave',
                roomId: this.roomId
            }));
        }

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
