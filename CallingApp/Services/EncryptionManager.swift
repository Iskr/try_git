//
//  EncryptionManager.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import Foundation
import CryptoKit

class EncryptionManager {
    private var encryptionKey: SymmetricKey?
    private(set) var isEnabled = false

    // MARK: - Key Management
    func generateKey() -> String {
        let key = SymmetricKey(size: .bits128)
        self.encryptionKey = key

        // Convert to base64 for transmission
        let keyData = key.withUnsafeBytes { Data($0) }
        return keyData.base64EncodedString()
    }

    func setKey(from base64String: String) {
        guard let keyData = Data(base64Encoded: base64String) else {
            return
        }

        encryptionKey = SymmetricKey(data: keyData)
    }

    func enableEncryption() {
        guard encryptionKey != nil else {
            print("Cannot enable encryption: no key set")
            return
        }
        isEnabled = true
    }

    func disableEncryption() {
        isEnabled = false
    }

    // MARK: - Encryption/Decryption
    func encrypt(data: Data) -> Data? {
        guard isEnabled, let key = encryptionKey else {
            return data
        }

        do {
            let sealedBox = try AES.GCM.seal(data, using: key)
            return sealedBox.combined
        } catch {
            print("Encryption error: \(error)")
            return nil
        }
    }

    func decrypt(data: Data) -> Data? {
        guard isEnabled, let key = encryptionKey else {
            return data
        }

        do {
            let sealedBox = try AES.GCM.SealedBox(combined: data)
            let decryptedData = try AES.GCM.open(sealedBox, using: key)
            return decryptedData
        } catch {
            print("Decryption error: \(error)")
            return nil
        }
    }

    // MARK: - Frame Encryption (for WebRTC)
    // Note: This is a simplified version. For production use, you would need to
    // implement insertable streams API or use WebRTC's built-in encryption
    func encryptFrame(_ frameData: Data, frameCount: UInt64) -> Data? {
        guard isEnabled, let key = encryptionKey else {
            return frameData
        }

        do {
            // Create nonce from frame count
            var nonceData = Data(count: 12)
            withUnsafeBytes(of: frameCount.bigEndian) { bytes in
                nonceData.replaceSubrange(4..<12, with: bytes)
            }

            let nonce = try AES.GCM.Nonce(data: nonceData)
            let sealedBox = try AES.GCM.seal(frameData, using: key, nonce: nonce)

            return sealedBox.combined
        } catch {
            print("Frame encryption error: \(error)")
            return nil
        }
    }

    func decryptFrame(_ encryptedData: Data) -> Data? {
        guard isEnabled, let key = encryptionKey else {
            return encryptedData
        }

        do {
            let sealedBox = try AES.GCM.SealedBox(combined: encryptedData)
            let decryptedData = try AES.GCM.open(sealedBox, using: key)
            return decryptedData
        } catch {
            print("Frame decryption error: \(error)")
            return nil
        }
    }

    // MARK: - Cleanup
    func reset() {
        encryptionKey = nil
        isEnabled = false
    }
}
