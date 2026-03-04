// Encryption Worker for RTCRtpScriptTransform (Safari/Firefox)
// Uses AES-GCM 128-bit encryption

let encryptionKey = null;
let encryptionEnabled = false;
const frameCounters = new Map();

function getIV(trackId, counter) {
    const iv = new Uint8Array(12);
    const hash = trackId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const view = new DataView(iv.buffer);
    view.setUint32(0, hash);
    view.setUint32(4, hash >> 8);
    view.setUint32(8, counter);
    return iv;
}

async function encryptFrame(encodedFrame, controller, trackId) {
    if (!encryptionEnabled || !encryptionKey) {
        controller.enqueue(encodedFrame);
        return;
    }
    try {
        const data = new Uint8Array(encodedFrame.data);
        if (!frameCounters.has(trackId)) {
            frameCounters.set(trackId, 0);
        }
        const counter = frameCounters.get(trackId);
        frameCounters.set(trackId, counter + 1);
        const iv = getIV(trackId, counter);
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            encryptionKey,
            data
        );
        const newData = new Uint8Array(12 + encrypted.byteLength);
        newData.set(iv, 0);
        newData.set(new Uint8Array(encrypted), 12);
        encodedFrame.data = newData.buffer;
        controller.enqueue(encodedFrame);
    } catch (e) {
        controller.enqueue(encodedFrame);
    }
}

async function decryptFrame(encodedFrame, controller) {
    if (!encryptionEnabled || !encryptionKey) {
        controller.enqueue(encodedFrame);
        return;
    }
    try {
        const data = new Uint8Array(encodedFrame.data);
        const iv = data.slice(0, 12);
        const encryptedData = data.slice(12);
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            encryptionKey,
            encryptedData
        );
        encodedFrame.data = decrypted;
        controller.enqueue(encodedFrame);
    } catch (e) {
        // Skip frame on decryption failure
    }
}

// Receive key/enable/disable commands via worker.postMessage()
self.onmessage = async (event) => {
    const msg = event.data;
    if (msg.type === 'setKey') {
        encryptionKey = await crypto.subtle.importKey(
            'raw',
            new Uint8Array(msg.keyData),
            { name: 'AES-GCM', length: 128 },
            false,
            ['encrypt', 'decrypt']
        );
    } else if (msg.type === 'enable') {
        encryptionEnabled = true;
    } else if (msg.type === 'disable') {
        encryptionEnabled = false;
    }
};

// Handle RTCRtpScriptTransform — pipe frames through encrypt/decrypt
self.onrtctransform = (event) => {
    const { name, trackId } = event.transformer.options;

    const transform = new TransformStream({
        async transform(encodedFrame, controller) {
            if (name === 'sender') {
                await encryptFrame(encodedFrame, controller, trackId || 'unknown');
            } else {
                await decryptFrame(encodedFrame, controller);
            }
        }
    });

    event.transformer.readable
        .pipeThrough(transform)
        .pipeTo(event.transformer.writable);
};
