//
//  CallView.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import SwiftUI
import WebRTC

struct CallView: View {
    let roomCode: String
    @Binding var isPresented: Bool

    @StateObject private var viewModel: CallViewModel

    @State private var showLayoutPicker = false
    @State private var showReactions = false
    @State private var selectedParticipantForVolume: String?

    init(roomCode: String, isPresented: Binding<Bool>) {
        self.roomCode = roomCode
        self._isPresented = isPresented
        self._viewModel = StateObject(wrappedValue: CallViewModel(roomCode: roomCode))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                headerView
                    .padding(.top, 50)
                    .padding(.horizontal)

                // Video Grid
                participantsGridView
                    .padding(.horizontal, 8)

                Spacer()

                // Controls
                controlsView
                    .padding(.bottom, 40)
            }

            // Reactions overlay
            if !viewModel.reactions.isEmpty {
                reactionsOverlayView
            }
        }
        .onAppear {
            viewModel.joinCall()
        }
        .onDisappear {
            viewModel.leaveCall()
        }
        .sheet(isPresented: $showReactions) {
            ReactionsPickerView(onReactionSelected: { emoji in
                viewModel.sendReaction(emoji)
                showReactions = false
            })
        }
        .actionSheet(isPresented: $showLayoutPicker) {
            ActionSheet(
                title: Text("Режим отображения"),
                buttons: LayoutMode.allCases.map { mode in
                        .default(Text(mode.rawValue)) {
                            viewModel.layoutMode = mode
                        }
                } + [.cancel()]
            )
        }
    }

    // MARK: - Header
    private var headerView: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Комната: \(roomCode)")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.white)

                HStack(spacing: 8) {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: 12))
                    Text("\(viewModel.participants.count) участников")
                        .font(.system(size: 14))

                    if viewModel.isEncryptionEnabled {
                        Image(systemName: "lock.shield.fill")
                            .font(.system(size: 12))
                        Text("Защищено E2EE")
                            .font(.system(size: 14))
                    }
                }
                .foregroundColor(.white.opacity(0.8))
            }

            Spacer()

            // Copy room code button
            Button(action: {
                UIPasteboard.general.string = roomCode
            }) {
                Image(systemName: "doc.on.doc.fill")
                    .font(.system(size: 20))
                    .foregroundColor(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.white.opacity(0.2))
                    .clipShape(Circle())
            }
        }
    }

    // MARK: - Participants Grid
    private var participantsGridView: some View {
        let columns = gridColumns(for: viewModel.participants.count)

        return ScrollView {
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(viewModel.participants) { participant in
                    ParticipantVideoView(
                        participant: participant,
                        onVolumeControl: {
                            selectedParticipantForVolume = participant.id
                        }
                    )
                    .aspectRatio(3/4, contentMode: .fill)
                }
            }
        }
    }

    // MARK: - Controls
    private var controlsView: some View {
        HStack(spacing: 24) {
            // Microphone
            ControlButton(
                icon: viewModel.isMicrophoneEnabled ? "mic.fill" : "mic.slash.fill",
                isActive: viewModel.isMicrophoneEnabled,
                activeColor: .white,
                inactiveColor: .red
            ) {
                viewModel.toggleMicrophone()
            }

            // Video
            ControlButton(
                icon: viewModel.isVideoEnabled ? "video.fill" : "video.slash.fill",
                isActive: viewModel.isVideoEnabled,
                activeColor: .white,
                inactiveColor: .red
            ) {
                viewModel.toggleVideo()
            }

            // Encryption
            ControlButton(
                icon: "lock.shield.fill",
                isActive: viewModel.isEncryptionEnabled,
                activeColor: .green,
                inactiveColor: .white
            ) {
                viewModel.toggleEncryption()
            }

            // Reactions
            ControlButton(
                icon: "face.smiling.fill",
                isActive: false,
                activeColor: .white,
                inactiveColor: .white
            ) {
                showReactions = true
            }

            // Layout
            ControlButton(
                icon: viewModel.layoutMode.icon,
                isActive: false,
                activeColor: .white,
                inactiveColor: .white
            ) {
                showLayoutPicker = true
            }

            // Hang up
            ControlButton(
                icon: "phone.down.fill",
                isActive: false,
                activeColor: .white,
                inactiveColor: .red,
                backgroundColor: .red
            ) {
                viewModel.leaveCall()
                isPresented = false
            }
        }
        .padding(.horizontal)
    }

    // MARK: - Reactions Overlay
    private var reactionsOverlayView: some View {
        ZStack {
            ForEach(viewModel.reactions) { reaction in
                Text(reaction.emoji)
                    .font(.system(size: 60))
                    .offset(y: -200)
                    .animation(.easeOut(duration: 2), value: reaction.id)
            }
        }
    }

    // MARK: - Helpers
    private func gridColumns(for participantCount: Int) -> [GridItem] {
        let columnCount: Int
        switch viewModel.layoutMode {
        case .grid:
            columnCount = participantCount <= 2 ? 1 : 2
        case .spotlight:
            columnCount = 1
        case .sidebar:
            columnCount = 2
        case .auto:
            columnCount = participantCount <= 2 ? 1 : 2
        }

        return Array(repeating: GridItem(.flexible(), spacing: 8), count: columnCount)
    }
}

// MARK: - Control Button
struct ControlButton: View {
    let icon: String
    let isActive: Bool
    let activeColor: Color
    let inactiveColor: Color
    var backgroundColor: Color?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 24))
                .foregroundColor(isActive ? activeColor : .white)
                .frame(width: 56, height: 56)
                .background(
                    backgroundColor ?? (isActive ? Color.white.opacity(0.3) : inactiveColor.opacity(0.8))
                )
                .clipShape(Circle())
        }
    }
}

// MARK: - Reactions Picker
struct ReactionsPickerView: View {
    let onReactionSelected: (String) -> Void

    let reactions = ["❤️", "👍", "😂", "😮", "😢", "🔥", "🎉", "👏", "💯", "🚀"]

    var body: some View {
        NavigationView {
            ScrollView {
                LazyVGrid(columns: [
                    GridItem(.flexible()),
                    GridItem(.flexible()),
                    GridItem(.flexible()),
                    GridItem(.flexible())
                ], spacing: 16) {
                    ForEach(reactions, id: \.self) { emoji in
                        Button(action: {
                            onReactionSelected(emoji)
                        }) {
                            Text(emoji)
                                .font(.system(size: 50))
                                .frame(width: 80, height: 80)
                                .background(Color.gray.opacity(0.1))
                                .cornerRadius(16)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Выберите реакцию")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
    }
}

struct CallView_Previews: PreviewProvider {
    static var previews: some View {
        CallView(roomCode: "ABC123", isPresented: .constant(true))
    }
}
