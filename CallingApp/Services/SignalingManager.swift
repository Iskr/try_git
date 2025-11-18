//
//  SignalingManager.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import Foundation
import Starscream

protocol SignalingManagerDelegate: AnyObject {
    func signalingManager(_ manager: SignalingManager, didReceiveOffer sdp: String, from peerId: String)
    func signalingManager(_ manager: SignalingManager, didReceiveAnswer sdp: String, from peerId: String)
    func signalingManager(_ manager: SignalingManager, didReceiveCandidate candidate: [String: Any], from peerId: String)
    func signalingManager(_ manager: SignalingManager, didReceiveParticipants participants: [[String: Any]])
    func signalingManager(_ manager: SignalingManager, didReceiveReaction emoji: String, from peerId: String)
    func signalingManager(_ manager: SignalingManager, didReceiveEncryptionKey key: String)
}

class SignalingManager: NSObject {
    weak var delegate: SignalingManagerDelegate?

    private var socket: WebSocket?
    private var roomCode: String?
    private var peerId: String

    // Server URL - replace with your server
    private let serverURL = "wss://your-server.com" // TODO: Replace with actual server URL

    init(peerId: String = UUID().uuidString) {
        self.peerId = peerId
        super.init()
    }

    // MARK: - Connection
    func connect(to roomCode: String) {
        self.roomCode = roomCode

        var request = URLRequest(url: URL(string: serverURL)!)
        request.timeoutInterval = 5

        socket = WebSocket(request: request)
        socket?.delegate = self
        socket?.connect()
    }

    func disconnect() {
        socket?.disconnect()
        socket = nil
    }

    // MARK: - Messaging
    func joinRoom(_ roomCode: String) {
        send(message: [
            "type": "join",
            "roomId": roomCode,
            "peerId": peerId
        ])
    }

    func sendOffer(sdp: String, to peerId: String) {
        send(message: [
            "type": "offer",
            "targetId": peerId,
            "senderId": self.peerId,
            "sdp": sdp
        ])
    }

    func sendAnswer(sdp: String, to peerId: String) {
        send(message: [
            "type": "answer",
            "targetId": peerId,
            "senderId": self.peerId,
            "sdp": sdp
        ])
    }

    func sendCandidate(_ candidate: [String: Any], to peerId: String) {
        var message = candidate
        message["type"] = "ice-candidate"
        message["targetId"] = peerId
        message["senderId"] = self.peerId
        send(message: message)
    }

    func sendReaction(_ emoji: String) {
        send(message: [
            "type": "reaction",
            "roomId": roomCode ?? "",
            "senderId": peerId,
            "emoji": emoji
        ])
    }

    func sendEncryptionKey(_ key: String) {
        send(message: [
            "type": "encryption-key",
            "roomId": roomCode ?? "",
            "senderId": peerId,
            "key": key
        ])
    }

    private func send(message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let string = String(data: data, encoding: .utf8) else {
            return
        }

        socket?.write(string: string)
    }

    // MARK: - Message Handling
    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "offer":
            guard let sdp = json["sdp"] as? String,
                  let senderId = json["senderId"] as? String else {
                return
            }
            delegate?.signalingManager(self, didReceiveOffer: sdp, from: senderId)

        case "answer":
            guard let sdp = json["sdp"] as? String,
                  let senderId = json["senderId"] as? String else {
                return
            }
            delegate?.signalingManager(self, didReceiveAnswer: sdp, from: senderId)

        case "ice-candidate":
            guard let senderId = json["senderId"] as? String else {
                return
            }
            delegate?.signalingManager(self, didReceiveCandidate: json, from: senderId)

        case "participants":
            guard let participants = json["participants"] as? [[String: Any]] else {
                return
            }
            delegate?.signalingManager(self, didReceiveParticipants: participants)

        case "reaction":
            guard let emoji = json["emoji"] as? String,
                  let senderId = json["senderId"] as? String else {
                return
            }
            delegate?.signalingManager(self, didReceiveReaction: emoji, from: senderId)

        case "encryption-key":
            guard let key = json["key"] as? String else {
                return
            }
            delegate?.signalingManager(self, didReceiveEncryptionKey: key)

        default:
            print("Unknown message type: \(type)")
        }
    }
}

// MARK: - WebSocketDelegate
extension SignalingManager: WebSocketDelegate {
    func didReceive(event: WebSocketEvent, client: WebSocketClient) {
        switch event {
        case .connected(let headers):
            print("WebSocket connected: \(headers)")
            if let roomCode = roomCode {
                joinRoom(roomCode)
            }

        case .disconnected(let reason, let code):
            print("WebSocket disconnected: \(reason) with code: \(code)")

        case .text(let text):
            print("Received text: \(text)")
            handleMessage(text)

        case .binary(let data):
            print("Received data: \(data.count) bytes")

        case .ping(_):
            break

        case .pong(_):
            break

        case .viabilityChanged(_):
            break

        case .reconnectSuggested(_):
            break

        case .cancelled:
            print("WebSocket cancelled")

        case .error(let error):
            print("WebSocket error: \(error?.localizedDescription ?? "unknown")")

        case .peerClosed:
            print("WebSocket peer closed")
        }
    }
}
