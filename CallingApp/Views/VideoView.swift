//
//  VideoView.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import SwiftUI
import WebRTC

// MARK: - RTCVideoView Wrapper
struct RTCVideoViewWrapper: UIViewRepresentable {
    let videoTrack: RTCVideoTrack?

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView(frame: .zero)
        view.contentMode = .scaleAspectFill
        view.videoContentMode = .scaleAspectFill
        return view
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {
        if let track = videoTrack {
            track.add(uiView)
        }
    }
}

// MARK: - Participant Video View
struct ParticipantVideoView: View {
    let participant: Participant
    let onVolumeControl: () -> Void

    @State private var showVolumeControl = false

    var body: some View {
        ZStack {
            // Video or placeholder
            if participant.isVideoEnabled, let videoTrack = participant.videoTrack {
                RTCVideoViewWrapper(videoTrack: videoTrack)
            } else {
                // Placeholder when video is disabled
                ZStack {
                    LinearGradient(
                        gradient: Gradient(colors: [
                            Color(red: 0.2, green: 0.2, blue: 0.3),
                            Color(red: 0.3, green: 0.3, blue: 0.4)
                        ]),
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )

                    VStack(spacing: 12) {
                        Image(systemName: "person.circle.fill")
                            .resizable()
                            .frame(width: 60, height: 60)
                            .foregroundColor(.white.opacity(0.6))

                        Text(participant.nickname ?? "Участник")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(.white)
                    }
                }
            }

            // Overlay info
            VStack {
                HStack {
                    // Muted indicator
                    if participant.isMuted {
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: 12))
                            .foregroundColor(.white)
                            .padding(8)
                            .background(Color.red.opacity(0.8))
                            .clipShape(Circle())
                    }

                    Spacer()

                    // Volume indicator
                    if !participant.isLocal && participant.volume != 1.0 {
                        Text("\(Int(participant.volume * 100))%")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.black.opacity(0.6))
                            .cornerRadius(8)
                    }
                }
                .padding(8)

                Spacer()

                // Name badge
                HStack {
                    Text(participant.isLocal ? "Вы" : (participant.nickname ?? "Участник"))
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color.black.opacity(0.6))
                        .cornerRadius(8)

                    Spacer()

                    // Volume control button (for remote participants only)
                    if !participant.isLocal {
                        Button(action: {
                            onVolumeControl()
                        }) {
                            Image(systemName: "speaker.wave.2.fill")
                                .font(.system(size: 16))
                                .foregroundColor(.white)
                                .padding(8)
                                .background(Color.black.opacity(0.6))
                                .clipShape(Circle())
                        }
                    }
                }
                .padding(8)
            }
        }
        .cornerRadius(12)
        .clipped()
    }
}
