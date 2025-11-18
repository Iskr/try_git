//
//  JoinCallView.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import SwiftUI

struct JoinCallView: View {
    @Binding var isPresented: Bool
    @Binding var roomCode: String
    var onJoin: () -> Void

    @State private var enteredCode = ""

    var body: some View {
        NavigationView {
            ZStack {
                Color(UIColor.systemGroupedBackground)
                    .ignoresSafeArea()

                VStack(spacing: 24) {
                    Spacer()

                    // Icon
                    Image(systemName: "phone.and.waveform.fill")
                        .resizable()
                        .frame(width: 80, height: 80)
                        .foregroundColor(Color(red: 0.4, green: 0.49, blue: 0.92))

                    // Title
                    Text("Присоединиться к звонку")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(.primary)

                    Text("Введите 6-значный код комнаты")
                        .font(.system(size: 16))
                        .foregroundColor(.secondary)

                    // Code Input
                    TextField("Код комнаты", text: $enteredCode)
                        .font(.system(size: 24, weight: .semibold))
                        .multilineTextAlignment(.center)
                        .textCase(.uppercase)
                        .autocapitalization(.allCharacters)
                        .frame(height: 60)
                        .background(Color(UIColor.secondarySystemGroupedBackground))
                        .cornerRadius(12)
                        .padding(.horizontal, 40)
                        .onChange(of: enteredCode) { newValue in
                            if newValue.count > 6 {
                                enteredCode = String(newValue.prefix(6))
                            }
                        }

                    // Join Button
                    Button(action: {
                        if enteredCode.count == 6 {
                            roomCode = enteredCode.uppercased()
                            onJoin()
                        }
                    }) {
                        Text("Присоединиться")
                            .font(.system(size: 20, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 56)
                            .background(
                                enteredCode.count == 6 ?
                                Color(red: 0.4, green: 0.49, blue: 0.92) :
                                Color.gray.opacity(0.3)
                            )
                            .foregroundColor(.white)
                            .cornerRadius(12)
                    }
                    .padding(.horizontal, 40)
                    .disabled(enteredCode.count != 6)

                    Spacer()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Закрыть") {
                        isPresented = false
                    }
                }
            }
        }
    }
}

struct JoinCallView_Previews: PreviewProvider {
    static var previews: some View {
        JoinCallView(
            isPresented: .constant(true),
            roomCode: .constant(""),
            onJoin: {}
        )
    }
}
