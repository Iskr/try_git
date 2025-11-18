//
//  WebRTCManager.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import Foundation
import WebRTC
import AVFoundation

protocol WebRTCManagerDelegate: AnyObject {
    func webRTCManager(_ manager: WebRTCManager, didReceiveLocalVideoTrack track: RTCVideoTrack)
    func webRTCManager(_ manager: WebRTCManager, didReceiveRemoteVideoTrack track: RTCVideoTrack, from peerId: String)
    func webRTCManager(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState, for peerId: String)
}

class WebRTCManager: NSObject {
    weak var delegate: WebRTCManagerDelegate?

    // WebRTC components
    private var peerConnectionFactory: RTCPeerConnectionFactory!
    private var videoCapturer: RTCCameraVideoCapturer?
    private var localVideoTrack: RTCVideoTrack?
    private var localAudioTrack: RTCAudioTrack?
    private var localVideoSource: RTCVideoSource?

    // Peer connections
    private var peerConnections: [String: RTCPeerConnection] = [:]

    // Configuration
    private let config: RTCConfiguration = {
        let config = RTCConfiguration()
        config.iceServers = [
            RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
            RTCIceServer(urlStrings: ["stun:stun1.l.google.com:19302"]),
            RTCIceServer(urlStrings: ["stun:stun2.l.google.com:19302"]),
            RTCIceServer(
                urlStrings: ["turn:openrelay.metered.ca:80"],
                username: "openrelayproject",
                credential: "openrelayproject"
            )
        ]
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        config.iceCandidatePoolSize = 10
        return config
    }()

    // Media constraints
    private let mediaConstraints = RTCMediaConstraints(
        mandatoryConstraints: nil,
        optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
    )

    override init() {
        super.init()
        setupWebRTC()
    }

    // MARK: - Setup
    private func setupWebRTC() {
        // Initialize SSL
        RTCInitializeSSL()

        // Create factory
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()

        peerConnectionFactory = RTCPeerConnectionFactory(
            encoderFactory: encoderFactory,
            decoderFactory: decoderFactory
        )
    }

    // MARK: - Local Media
    func startLocalMedia() {
        // Create audio track
        let audioSource = peerConnectionFactory.audioSource(with: nil)
        localAudioTrack = peerConnectionFactory.audioTrack(with: audioSource, trackId: "audio0")

        // Create video track
        localVideoSource = peerConnectionFactory.videoSource()
        localVideoTrack = peerConnectionFactory.videoTrack(with: localVideoSource!, trackId: "video0")

        // Setup camera capturer
        #if targetEnvironment(simulator)
        // Use file capturer for simulator
        #else
        videoCapturer = RTCCameraVideoCapturer(delegate: localVideoSource!)
        startCamera()
        #endif

        // Notify delegate
        if let track = localVideoTrack {
            delegate?.webRTCManager(self, didReceiveLocalVideoTrack: track)
        }
    }

    private func startCamera() {
        guard let capturer = videoCapturer else { return }

        // Find front camera
        guard let frontCamera = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == .front }) else {
            return
        }

        // Find suitable format
        let formats = RTCCameraVideoCapturer.supportedFormats(for: frontCamera)
        let targetWidth = 1280
        let targetHeight = 720

        guard let format = formats.first(where: {
            let dimensions = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
            return dimensions.width == targetWidth && dimensions.height == targetHeight
        }) ?? formats.last else {
            return
        }

        // Find suitable FPS
        let fps = format.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30

        // Start capturing
        capturer.startCapture(with: frontCamera, format: format, fps: Int(fps))
    }

    func stopLocalMedia() {
        videoCapturer?.stopCapture()
        localVideoTrack = nil
        localAudioTrack = nil
    }

    // MARK: - Peer Connection Management
    func createPeerConnection(for peerId: String) -> RTCPeerConnection? {
        guard peerConnections[peerId] == nil else {
            return peerConnections[peerId]
        }

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )

        guard let peerConnection = peerConnectionFactory.peerConnection(
            with: config,
            constraints: constraints,
            delegate: nil
        ) else {
            return nil
        }

        // Add local tracks
        if let audioTrack = localAudioTrack {
            peerConnection.add(audioTrack, streamIds: ["stream0"])
        }
        if let videoTrack = localVideoTrack {
            peerConnection.add(videoTrack, streamIds: ["stream0"])
        }

        peerConnections[peerId] = peerConnection
        return peerConnection
    }

    func removePeerConnection(for peerId: String) {
        peerConnections[peerId]?.close()
        peerConnections.removeValue(forKey: peerId)
    }

    func getPeerConnection(for peerId: String) -> RTCPeerConnection? {
        return peerConnections[peerId]
    }

    // MARK: - Offers & Answers
    func createOffer(for peerId: String, completion: @escaping (RTCSessionDescription?) -> Void) {
        guard let peerConnection = peerConnections[peerId] else {
            completion(nil)
            return
        }

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: [
                "OfferToReceiveAudio": "true",
                "OfferToReceiveVideo": "true"
            ],
            optionalConstraints: nil
        )

        peerConnection.offer(for: constraints) { sdp, error in
            guard let sdp = sdp, error == nil else {
                completion(nil)
                return
            }

            peerConnection.setLocalDescription(sdp) { error in
                completion(error == nil ? sdp : nil)
            }
        }
    }

    func handleRemoteOffer(_ sdp: RTCSessionDescription, from peerId: String, completion: @escaping (RTCSessionDescription?) -> Void) {
        guard let peerConnection = peerConnections[peerId] else {
            completion(nil)
            return
        }

        peerConnection.setRemoteDescription(sdp) { error in
            guard error == nil else {
                completion(nil)
                return
            }

            let constraints = RTCMediaConstraints(
                mandatoryConstraints: [
                    "OfferToReceiveAudio": "true",
                    "OfferToReceiveVideo": "true"
                ],
                optionalConstraints: nil
            )

            peerConnection.answer(for: constraints) { answer, error in
                guard let answer = answer, error == nil else {
                    completion(nil)
                    return
                }

                peerConnection.setLocalDescription(answer) { error in
                    completion(error == nil ? answer : nil)
                }
            }
        }
    }

    func handleRemoteAnswer(_ sdp: RTCSessionDescription, from peerId: String) {
        peerConnections[peerId]?.setRemoteDescription(sdp, completionHandler: { _ in })
    }

    func handleRemoteCandidate(_ candidate: RTCIceCandidate, from peerId: String) {
        peerConnections[peerId]?.add(candidate)
    }

    // MARK: - Media Control
    func toggleAudio(enabled: Bool) {
        localAudioTrack?.isEnabled = enabled
    }

    func toggleVideo(enabled: Bool) {
        localVideoTrack?.isEnabled = enabled
    }

    func switchCamera() {
        guard let capturer = videoCapturer else { return }

        // Find the other camera
        let devices = RTCCameraVideoCapturer.captureDevices()
        guard let currentDevice = devices.first(where: { $0.position == .front }),
              let otherDevice = devices.first(where: { $0.position != currentDevice.position }) else {
            return
        }

        // Switch
        let formats = RTCCameraVideoCapturer.supportedFormats(for: otherDevice)
        guard let format = formats.last else { return }

        let fps = format.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30
        capturer.startCapture(with: otherDevice, format: format, fps: Int(fps))
    }

    // MARK: - Cleanup
    func cleanup() {
        stopLocalMedia()
        peerConnections.values.forEach { $0.close() }
        peerConnections.removeAll()
    }

    deinit {
        cleanup()
        RTCCleanupSSL()
    }
}

// MARK: - RTCPeerConnectionDelegate
extension WebRTCManager: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        print("Signaling state changed: \(stateChanged.rawValue)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        print("Did add stream")

        // Find peer ID for this connection
        guard let peerId = peerConnections.first(where: { $0.value == peerConnection })?.key else {
            return
        }

        // Get video track
        if let videoTrack = stream.videoTracks.first {
            delegate?.webRTCManager(self, didReceiveRemoteVideoTrack: videoTrack, from: peerId)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        print("Did remove stream")
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        print("Should negotiate")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        print("ICE connection state changed: \(newState.rawValue)")

        guard let peerId = peerConnections.first(where: { $0.value == peerConnection })?.key else {
            return
        }

        delegate?.webRTCManager(self, didChangeConnectionState: newState, for: peerId)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        print("ICE gathering state changed: \(newState.rawValue)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        print("Did generate ICE candidate")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {
        print("Did remove ICE candidates")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        print("Did open data channel")
    }
}
