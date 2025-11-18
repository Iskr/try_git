//
//  Participant.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import Foundation
import WebRTC

struct Participant: Identifiable, Hashable {
    let id: String
    var isLocal: Bool = false
    var isMuted: Bool = false
    var isVideoEnabled: Bool = true
    var volume: Float = 1.0
    var nickname: String?

    // WebRTC
    var peerConnection: RTCPeerConnection?
    var videoTrack: RTCVideoTrack?
    var audioTrack: RTCAudioTrack?

    // For SwiftUI
    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: Participant, rhs: Participant) -> Bool {
        lhs.id == rhs.id
    }
}

struct Reaction: Identifiable {
    let id = UUID()
    let emoji: String
    let participantId: String
    let timestamp: Date
}

enum LayoutMode: String, CaseIterable {
    case auto = "Авто"
    case grid = "Сетка"
    case spotlight = "Фокус"
    case sidebar = "Сайдбар"

    var icon: String {
        switch self {
        case .auto: return "rectangle.3.group"
        case .grid: return "square.grid.2x2"
        case .spotlight: return "person.crop.rectangle"
        case .sidebar: return "sidebar.left"
        }
    }
}
