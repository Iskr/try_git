// E2EE worker for RTCRtpScriptTransform (Chrome 128+, Firefox, Safari).
// Each frame is encrypted with AES-256-GCM under a fresh random 12-byte IV.
// Encrypted frames carry a 3-byte marker so the receiver can tell them apart
// from plaintext frames during enable/disable transitions:
//   [0xE2 0xEE 0x01][IV (12 bytes)][AES-GCM ciphertext]
const MAGIC = new Uint8Array([0xe2, 0xee, 0x01]);
const IV_LENGTH = 12;
const HEADER_LENGTH = MAGIC.length + IV_LENGTH;

let encryptionKey = null;
let encryptionEnabled = false;

async function handleControl(msg) {
    if (msg.type === 'setKey' && Array.isArray(msg.keyData) && msg.keyData.length === 32) {
        encryptionKey = await crypto.subtle.importKey(
            'raw',
            new Uint8Array(msg.keyData),
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    } else if (msg.type === 'enable') {
        encryptionEnabled = true;
    } else if (msg.type === 'disable') {
        encryptionEnabled = false;
    } else if (msg.type === 'clearKey') {
        encryptionKey = null;
        encryptionEnabled = false;
    }
}

// Commands are serialized so 'enable' can never overtake a pending async
// 'setKey' import and flip the flag before the key is ready.
let controlQueue = Promise.resolve();
self.onmessage = (event) => {
    const msg = event.data || {};
    controlQueue = controlQueue.then(() => handleControl(msg)).catch(() => {});
};

function isEncryptedFrame(data) {
    return data.length > HEADER_LENGTH
        && data[0] === MAGIC[0]
        && data[1] === MAGIC[1]
        && data[2] === MAGIC[2];
}

async function encryptFrame(frame, controller) {
    if (!encryptionEnabled) {
        controller.enqueue(frame);
        return;
    }
    if (!encryptionKey) {
        // Enabled but the key is not ready — fail closed.
        return;
    }
    try {
        const data = new Uint8Array(frame.data);
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, data);
        const out = new Uint8Array(HEADER_LENGTH + encrypted.byteLength);
        out.set(MAGIC, 0);
        out.set(iv, MAGIC.length);
        out.set(new Uint8Array(encrypted), HEADER_LENGTH);
        frame.data = out.buffer;
        controller.enqueue(frame);
    } catch (e) {
        // Fail closed: a frame that could not be encrypted must never leave
        // in plaintext, so it is dropped.
    }
}

async function decryptFrame(frame, controller) {
    const data = new Uint8Array(frame.data);
    if (!isEncryptedFrame(data)) {
        // Plaintext frame. Render it only while encryption is off — once the
        // user sees the lock indicator, unencrypted media must not slip
        // through (fail closed on receive as well as send).
        if (encryptionEnabled) return;
        controller.enqueue(frame);
        return;
    }
    if (!encryptionKey) {
        // Encrypted frame but no key yet — drop until the key arrives.
        return;
    }
    try {
        const iv = data.slice(MAGIC.length, HEADER_LENGTH);
        const payload = data.slice(HEADER_LENGTH);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encryptionKey, payload);
        frame.data = decrypted;
        controller.enqueue(frame);
    } catch (e) {
        // Drop frames that fail authentication.
    }
}

self.onrtctransform = (event) => {
    const side = event.transformer.options && event.transformer.options.side;
    const transform = new TransformStream({
        transform: (frame, controller) =>
            side === 'sender' ? encryptFrame(frame, controller) : decryptFrame(frame, controller),
    });
    event.transformer.readable.pipeThrough(transform).pipeTo(event.transformer.writable);
};
