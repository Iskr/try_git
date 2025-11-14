// WebRTC Configuration
const config = {
    iceServers: [
        // STUN servers
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },

        // Public TURN servers (for NAT traversal)
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};

class CallingApp {
    constructor() {
        this.ws = null;
        this.peerConnection = null;
        this.localStream = null;
        this.roomId = null;
        this.clientId = null;
        this.remoteClientId = null;
        this.isAudioEnabled = true;
        this.isVideoEnabled = true;
        this.pendingIceCandidates = []; // Buffer for ICE candidates

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

        // Video elements
        this.localVideo = document.getElementById('local-video');
        this.remoteVideo = document.getElementById('remote-video');

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
                await this.startCall();
                break;

            case 'peer-joined':
                this.remoteClientId = message.clientId;
                await this.createOffer(message.clientId);
                this.updateConnectionStatus('Подключение к собеседнику...');
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
                this.handlePeerLeft();
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

            this.localVideo.srcObject = this.localStream;

            // Show call screen
            this.homeScreen.classList.remove('active');
            this.callScreen.classList.add('active');

            // Update UI
            document.getElementById('current-room-id').textContent = this.roomId;
            this.updateConnectionStatus('Ожидание собеседника...');

            // Update URL
            const newUrl = `${window.location.origin}?room=${this.roomId}`;
            window.history.pushState({}, '', newUrl);

        } catch (error) {
            console.error('Error accessing media devices:', error);
            this.showToast('Не удалось получить доступ к камере/микрофону');
            this.endCall();
        }
    }

    createPeerConnection(remoteClientId) {
        this.peerConnection = new RTCPeerConnection(config);
        this.remoteClientId = remoteClientId;

        // Add local tracks
        this.localStream.getTracks().forEach(track => {
            this.peerConnection.addTrack(track, this.localStream);
        });

        // Handle remote stream
        this.peerConnection.ontrack = (event) => {
            console.log('Received remote track');
            this.remoteVideo.srcObject = event.streams[0];
            this.updateConnectionStatus('Подключено', true);
        };

        // Handle ICE candidates
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate:', event.candidate.type, event.candidate.candidate);
                this.ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    targetId: remoteClientId
                }));
            } else {
                console.log('All ICE candidates sent');
            }
        };

        // Handle ICE connection state
        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.peerConnection.iceConnectionState);

            switch (this.peerConnection.iceConnectionState) {
                case 'connected':
                case 'completed':
                    this.updateConnectionStatus('Подключено', true);
                    break;
                case 'failed':
                    console.error('ICE connection failed. Trying ICE restart...');
                    this.updateConnectionStatus('Переподключение...');
                    // Try ICE restart
                    this.restartIce();
                    break;
                case 'disconnected':
                    this.updateConnectionStatus('Соединение потеряно...');
                    break;
                case 'checking':
                    this.updateConnectionStatus('Подключение...');
                    break;
            }
        };

        // Handle connection state
        this.peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', this.peerConnection.connectionState);
            if (this.peerConnection.connectionState === 'failed') {
                this.showToast('Не удалось установить соединение. Попробуйте пересоздать звонок.');
            }
        };

        // Handle ICE gathering state
        this.peerConnection.onicegatheringstatechange = () => {
            console.log('ICE gathering state:', this.peerConnection.iceGatheringState);
        };

        return this.peerConnection;
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
                this.localVideo.srcObject = this.localStream;
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
            await this.processPendingIceCandidates();

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
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));

            // Process any pending ICE candidates
            await this.processPendingIceCandidates();
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(message) {
        try {
            if (this.peerConnection) {
                const candidate = new RTCIceCandidate(message.candidate);

                // Check if remote description is set
                if (this.peerConnection.remoteDescription) {
                    await this.peerConnection.addIceCandidate(candidate);
                } else {
                    // Buffer the candidate until remote description is set
                    this.pendingIceCandidates.push(candidate);
                    console.log('Buffered ICE candidate, total pending:', this.pendingIceCandidates.length);
                }
            }
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }

    async processPendingIceCandidates() {
        if (this.pendingIceCandidates.length > 0 && this.peerConnection) {
            console.log('Processing', this.pendingIceCandidates.length, 'pending ICE candidates');

            for (const candidate of this.pendingIceCandidates) {
                try {
                    await this.peerConnection.addIceCandidate(candidate);
                } catch (error) {
                    console.error('Error adding pending ICE candidate:', error);
                }
            }

            this.pendingIceCandidates = [];
        }
    }

    async restartIce() {
        if (!this.peerConnection || !this.remoteClientId) {
            return;
        }

        console.log('Attempting ICE restart...');

        try {
            const offer = await this.peerConnection.createOffer({ iceRestart: true });
            await this.peerConnection.setLocalDescription(offer);

            this.ws.send(JSON.stringify({
                type: 'offer',
                offer: offer,
                targetId: this.remoteClientId
            }));
        } catch (error) {
            console.error('Error during ICE restart:', error);
        }
    }

    handlePeerLeft() {
        this.showToast('Собеседник завершил звонок');
        this.updateConnectionStatus('Собеседник отключился');

        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.remoteVideo.srcObject = null;
        this.remoteClientId = null;
        this.pendingIceCandidates = [];
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

        // Close peer connection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

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
        this.remoteClientId = null;
        this.isAudioEnabled = true;
        this.isVideoEnabled = true;
        this.pendingIceCandidates = [];

        // Update UI
        this.localVideo.srcObject = null;
        this.remoteVideo.srcObject = null;
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
