//
//  HomeView.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import SwiftUI

struct HomeView: View {
    @Binding var isInCall: Bool
    @Binding var showJoinView: Bool
    @State private var roomCode = ""
    @State private var showCallView = false
    @State private var isCreatingCall = false

    var body: some View {
        ZStack {
            // Gradient background
            LinearGradient(
                gradient: Gradient(colors: [
                    Color(red: 0.4, green: 0.49, blue: 0.92),
                    Color(red: 0.46, green: 0.29, blue: 0.64)
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 30) {
                Spacer()

                // App Icon
                Image(systemName: "video.circle.fill")
                    .resizable()
                    .frame(width: 120, height: 120)
                    .foregroundColor(.white)
                    .shadow(radius: 10)

                // Title
                Text("CallingApp")
                    .font(.system(size: 42, weight: .bold))
                    .foregroundColor(.white)

                Text("Видеозвонки с E2E шифрованием")
                    .font(.system(size: 18))
                    .foregroundColor(.white.opacity(0.9))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                Spacer()

                // Buttons
                VStack(spacing: 16) {
                    // Create Call Button
                    Button(action: {
                        createCall()
                    }) {
                        HStack {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 24))
                            Text("Создать звонок")
                                .font(.system(size: 20, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 60)
                        .background(Color.white)
                        .foregroundColor(Color(red: 0.4, green: 0.49, blue: 0.92))
                        .cornerRadius(16)
                        .shadow(color: .black.opacity(0.2), radius: 10, x: 0, y: 5)
                    }
                    .disabled(isCreatingCall)

                    // Join Call Button
                    Button(action: {
                        showJoinView = true
                    }) {
                        HStack {
                            Image(systemName: "phone.arrow.down.left.fill")
                                .font(.system(size: 24))
                            Text("Присоединиться")
                                .font(.system(size: 20, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 60)
                        .background(Color.white.opacity(0.2))
                        .foregroundColor(.white)
                        .cornerRadius(16)
                        .overlay(
                            RoundedRectangle(cornerRadius: 16)
                                .stroke(Color.white.opacity(0.5), lineWidth: 2)
                        )
                    }
                }
                .padding(.horizontal, 32)

                Spacer()

                // Features
                VStack(alignment: .leading, spacing: 12) {
                    FeatureRow(icon: "lock.shield.fill", text: "E2E шифрование")
                    FeatureRow(icon: "person.3.fill", text: "До 5 участников")
                    FeatureRow(icon: "face.smiling.fill", text: "Реакции и эмодзи")
                    FeatureRow(icon: "speaker.wave.2.fill", text: "Индивидуальная громкость")
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 40)
            }
        }
        .sheet(isPresented: $showJoinView) {
            JoinCallView(isPresented: $showJoinView, roomCode: $roomCode, onJoin: {
                joinCall(roomCode: roomCode)
            })
        }
        .fullScreenCover(isPresented: $showCallView) {
            CallView(roomCode: roomCode, isPresented: $showCallView)
        }
    }

    private func createCall() {
        isCreatingCall = true
        // Generate random room code (6 characters: A-Z, 0-9)
        roomCode = generateRoomCode()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            isCreatingCall = false
            showCallView = true
        }
    }

    private func joinCall(roomCode: String) {
        self.roomCode = roomCode
        showJoinView = false
        showCallView = true
    }

    private func generateRoomCode() -> String {
        let characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return String((0..<6).map { _ in characters.randomElement()! })
    }
}

struct FeatureRow: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundColor(.white)
                .frame(width: 24)
            Text(text)
                .font(.system(size: 16))
                .foregroundColor(.white.opacity(0.9))
        }
    }
}

struct HomeView_Previews: PreviewProvider {
    static var previews: some View {
        HomeView(isInCall: .constant(false), showJoinView: .constant(false))
    }
}
