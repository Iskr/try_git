//
//  CallViewModel.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import Foundation
import SwiftUI
import WebRTC
import Combine

class CallViewModel: ObservableObject {
    // MARK: - Published Properties
    @Published var participants: [Participant] = []
    @Published var reactions: [Reaction] = []
    @Published var isMicrophoneEnabled = true
    @Published var isVideoEnabled = true
    @Published var isEncryptionEnabled = false
    @Published var layoutMode: LayoutMode = .auto
    @Published var connectionStatus: String = "Подключение..."

    // MARK: - Private Properties
    private let roomCode: String
    private let localPeerId: String

    private var webRTCManager: WebRTCManager
    private var signalingManager: SignalingManager
    private var encryptionManager: EncryptionManager

    private var cancellables = Set<AnyCancellable>()

    // MARK: - Initialization
    init(roomCode: String) {
        self.roomCode = roomCode
        self.localPeerId = UUID().uuidString

        self.webRTCManager = WebRTCManager()
        self.signalingManager = SignalingManager(peerId: localPeerId)
        self.encryptionManager = EncryptionManager()

        setupDelegates()
        setupReactionCleanup()
    }

    private func setupDelegates() {
        webRTCManager.delegate = self
        signalingManager.delegate = self
    }

    private func setupReactionCleanup() {
        // Remove reactions after 3 seconds
        Timer.publish(every: 0.5, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                self?.cleanupOldReactions()
            }
            .store(in: &cancellables)
    }

    // MARK: - Public Methods
    func joinCall() {
        // Request camera and microphone permissions
        requestPermissions()

        // Start local media
        webRTCManager.startLocalMedia()

        // Create local participant
        let localParticipant = Participant(
            id: localPeerId,
            isLocal: true,
            isMuted: !isMicrophoneEnabled,
            isVideoEnabled: isVideoEnabled,
            nickname: "Вы"
        )
        participants.append(localParticipant)

        // Connect to signaling server
        signalingManager.connect(to: roomCode)

        connectionStatus = "Подключено"
    }

    func leaveCall() {
        webRTCManager.cleanup()
        signalingManager.disconnect()
        participants.removeAll()
        reactions.removeAll()

        connectionStatus = "Отключено"
    }

    func toggleMicrophone() {
        isMicrophoneEnabled.toggle()
        webRTCManager.toggleAudio(enabled: isMicrophoneEnabled)

        if let index = participants.firstIndex(where: { $0.id == localPeerId }) {
            participants[index].isMuted = !isMicrophoneEnabled
        }
    }

    func toggleVideo() {
        isVideoEnabled.toggle()
        webRTCManager.toggleVideo(enabled: isVideoEnabled)

        if let index = participants.firstIndex(where: { $0.id == localPeerId }) {
            participants[index].isVideoEnabled = isVideoEnabled
        }
    }

    func toggleEncryption() {
        if isEncryptionEnabled {
            // Disable encryption
            encryptionManager.disableEncryption()
            isEncryptionEnabled = false
        } else {
            // Enable and generate key
            let key = encryptionManager.generateKey()
            encryptionManager.enableEncryption()
            isEncryptionEnabled = true

            // Share key with all participants
            signalingManager.sendEncryptionKey(key)
        }
    }

    func sendReaction(_ emoji: String) {
        let reaction = Reaction(
            emoji: emoji,
            participantId: localPeerId,
            timestamp: Date()
        )

        reactions.append(reaction)
        signalingManager.sendReaction(emoji)
    }

    func setVolume(for participantId: String, volume: Float) {
        guard let index = participants.firstIndex(where: { $0.id == participantId }) else {
            return
        }

        participants[index].volume = volume

        // In a real implementation, you would apply this volume to the audio track
        // This requires additional WebRTC audio processing
    }

    // MARK: - Private Methods
    private func requestPermissions() {
        // Request camera permission
        AVCaptureDevice.requestAccess(for: .video) { granted in
            if granted {
                print("Camera permission granted")
            } else {
                print("Camera permission denied")
            }
        }

        // Request microphone permission
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            if granted {
                print("Microphone permission granted")
            } else {
                print("Microphone permission denied")
            }
        }
    }

    private func addRemoteParticipant(id: String) {
        guard !participants.contains(where: { $0.id == id }) else {
            return
        }

        let participant = Participant(
            id: id,
            isLocal: false,
            isMuted: false,
            isVideoEnabled: true,
            nickname: "Участник \(participants.count)"
        )

        participants.append(participant)

        // Create peer connection
        _ = webRTCManager.createPeerConnection(for: id)
    }

    private func removeParticipant(id: String) {
        participants.removeAll { $0.id == id }
        webRTCManager.removePeerConnection(for: id)
    }

    private func cleanupOldReactions() {
        let now = Date()
        reactions.removeAll { reaction in
            now.timeIntervalSince(reaction.timestamp) > 3.0
        }
    }

    private func updateParticipantVideoTrack(id: String, track: RTCVideoTrack) {
        guard let index = participants.firstIndex(where: { $0.id == id }) else {
            return
        }

        participants[index].videoTrack = track
    }
}

// MARK: - WebRTCManagerDelegate
extension CallViewModel: WebRTCManagerDelegate {
    func webRTCManager(_ manager: WebRTCManager, didReceiveLocalVideoTrack track: RTCVideoTrack) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let index = self.participants.firstIndex(where: { $0.id == self.localPeerId }) else {
                return
            }

            self.participants[index].videoTrack = track
        }
    }

    func webRTCManager(_ manager: WebRTCManager, didReceiveRemoteVideoTrack track: RTCVideoTrack, from peerId: String) {
        DispatchQueue.main.async { [weak self] in
            self?.updateParticipantVideoTrack(id: peerId, track: track)
        }
    }

    func webRTCManager(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState, for peerId: String) {
        DispatchQueue.main.async { [weak self] in
            switch state {
            case .connected:
                print("Peer \(peerId) connected")
                self?.connectionStatus = "Подключено"

            case .disconnected, .failed, .closed:
                print("Peer \(peerId) disconnected")
                self?.removeParticipant(id: peerId)

            default:
                break
            }
        }
    }
}

// MARK: - SignalingManagerDelegate
extension CallViewModel: SignalingManagerDelegate {
    func signalingManager(_ manager: SignalingManager, didReceiveOffer sdp: String, from peerId: String) {
        // Add remote participant
        addRemoteParticipant(id: peerId)

        // Handle offer
        let sessionDescription = RTCSessionDescription(type: .offer, sdp: sdp)
        webRTCManager.handleRemoteOffer(sessionDescription, from: peerId) { [weak self] answer in
            guard let answer = answer else { return }

            // Send answer back
            self?.signalingManager.sendAnswer(sdp: answer.sdp, to: peerId)
        }
    }

    func signalingManager(_ manager: SignalingManager, didReceiveAnswer sdp: String, from peerId: String) {
        let sessionDescription = RTCSessionDescription(type: .answer, sdp: sdp)
        webRTCManager.handleRemoteAnswer(sessionDescription, from: peerId)
    }

    func signalingManager(_ manager: SignalingManager, didReceiveCandidate candidate: [String: Any], from peerId: String) {
        guard let sdp = candidate["candidate"] as? String,
              let sdpMLineIndex = candidate["sdpMLineIndex"] as? Int32,
              let sdpMid = candidate["sdpMid"] as? String else {
            return
        }

        let iceCandidate = RTCIceCandidate(
            sdp: sdp,
            sdpMLineIndex: sdpMLineIndex,
            sdpMid: sdpMid
        )

        webRTCManager.handleRemoteCandidate(iceCandidate, from: peerId)
    }

    func signalingManager(_ manager: SignalingManager, didReceiveParticipants participants: [[String: Any]]) {
        // Update participants list
        for participantData in participants {
            guard let peerId = participantData["peerId"] as? String,
                  peerId != localPeerId else {
                continue
            }

            addRemoteParticipant(id: peerId)

            // Create and send offer to this participant
            webRTCManager.createOffer(for: peerId) { [weak self] offer in
                guard let offer = offer else { return }
                self?.signalingManager.sendOffer(sdp: offer.sdp, to: peerId)
            }
        }
    }

    func signalingManager(_ manager: SignalingManager, didReceiveReaction emoji: String, from peerId: String) {
        DispatchQueue.main.async { [weak self] in
            let reaction = Reaction(
                emoji: emoji,
                participantId: peerId,
                timestamp: Date()
            )

            self?.reactions.append(reaction)
        }
    }

    func signalingManager(_ manager: SignalingManager, didReceiveEncryptionKey key: String) {
        encryptionManager.setKey(from: key)
        encryptionManager.enableEncryption()

        DispatchQueue.main.async { [weak self] in
            self?.isEncryptionEnabled = true
        }
    }
}
