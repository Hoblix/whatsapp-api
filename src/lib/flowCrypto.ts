/**
 * WhatsApp Flows Crypto Engine — Cloudflare Workers (Web Crypto API)
 *
 * Handles:
 * 1. RSA-2048 key pair generation via crypto.subtle.generateKey
 * 2. AES-256-GCM envelope encryption/decryption of private keys at rest
 * 3. Meta's WhatsApp Flows request decryption (RSA-OAEP + AES-128-GCM)
 * 4. Meta's WhatsApp Flows response encryption (flip all IV bytes, AES-128-GCM)
 * 5. Secret encryption/decryption for access tokens
 *
 * All operations are async because SubtleCrypto is promise-based.
 * The `encryptionKey` parameter replaces process.env["BACKUP_ENCRYPTION_KEY"].
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface RsaKeyPair {
  publicKeyPem: string;   // Safe to share with Meta
  privateKeyEnc: string;  // AES-256-GCM encrypted PEM — store in DB
}

export interface MetaFlowRequest {
  encrypted_aes_key: string;   // base64 — RSA-OAEP wrapped AES-128 key
  encrypted_flow_data: string; // base64 — AES-128-GCM ciphertext + 16-byte auth tag
  initial_vector: string;      // base64 — 16-byte IV for AES-128-GCM
}

export interface DecryptedFlowPayload {
  aesKeyRaw: Uint8Array;          // keep for encrypting the response
  iv: Uint8Array;                 // original IV (we flip all bytes for the response)
  data: Record<string, unknown>;  // decrypted JSON body
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert an ArrayBuffer to a base64 string. */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert a base64 string to an ArrayBuffer. */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Convert an ArrayBuffer to a lowercase hex string. */
export function arrayBufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** Strip PEM header/footer and decode the base64 body to an ArrayBuffer. */
export function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToArrayBuffer(b64);
}

/** Wrap a DER ArrayBuffer in PEM format. */
export function arrayBufferToPem(
  buf: ArrayBuffer,
  type: "PUBLIC" | "PRIVATE"
): string {
  const b64 = arrayBufferToBase64(buf);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  const label = type === "PUBLIC" ? "PUBLIC KEY" : "PRIVATE KEY";
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

// ── Master key derivation (CACHED per isolate) ──────────────────────────────
// PBKDF2 with 100k iterations is expensive (~50ms). Cache the derived key
// so subsequent requests in the same Worker isolate skip the derivation.

const _masterKeyCache = new Map<string, CryptoKey>();

async function getMasterKey(encryptionKey: string): Promise<CryptoKey> {
  if (!encryptionKey) {
    throw new Error(
      "encryptionKey is required for WhatsApp Flows private key encryption. " +
        "Set BACKUP_ENCRYPTION_KEY in your Worker secrets."
    );
  }

  const cached = _masterKeyCache.get(encryptionKey);
  if (cached) return cached;

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(encryptionKey),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("wa_flows_rsa_salt"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  _masterKeyCache.set(encryptionKey, key);
  return key;
}

// ── Decrypted private key cache ─────────────────────────────────────────────
// Avoids re-decrypting the RSA private key on every flow request.
// Keyed by the encrypted PEM (which changes on key rotation).

const _privateKeyCache = new Map<string, string>();
const PRIVATE_KEY_CACHE_MAX = 10;

export function getCachedPrivateKey(encryptedPem: string): string | null {
  return _privateKeyCache.get(encryptedPem) ?? null;
}

export function setCachedPrivateKey(encryptedPem: string, pem: string): void {
  if (_privateKeyCache.size >= PRIVATE_KEY_CACHE_MAX) {
    const first = _privateKeyCache.keys().next().value;
    if (first) _privateKeyCache.delete(first);
  }
  _privateKeyCache.set(encryptedPem, pem);
}

// ── RSA key pair generation ──────────────────────────────────────────────────

/**
 * Generate a fresh RSA-2048 key pair.
 * Returns the public key in PEM format and the private key AES-encrypted.
 */
export async function generateRsaKeyPair(
  encryptionKey: string
): Promise<RsaKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true, // extractable — we need to export both keys
    ["encrypt", "decrypt"]
  );

  const [spkiBuf, pkcs8Buf] = await Promise.all([
    crypto.subtle.exportKey("spki", keyPair.publicKey),
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  ]);

  const publicKeyPem = arrayBufferToPem(spkiBuf, "PUBLIC");
  const privateKeyPem = arrayBufferToPem(pkcs8Buf, "PRIVATE");
  const privateKeyEnc = await encryptPrivateKey(privateKeyPem, encryptionKey);

  return { publicKeyPem, privateKeyEnc };
}

// ── Private key envelope encryption ──────────────────────────────────────────

/** AES-256-GCM encrypt a PEM string for storage. Returns base64(iv + tag + ciphertext). */
export async function encryptPrivateKey(
  pem: string,
  encryptionKey: string
): Promise<string> {
  const key = await getMasterKey(encryptionKey);
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv);

  const enc = new TextEncoder();
  // SubtleCrypto AES-GCM returns ciphertext + tag concatenated
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    enc.encode(pem)
  );

  // encrypted = ciphertext || tag (tag is last 16 bytes)
  const encBytes = new Uint8Array(encrypted);
  const ciphertext = encBytes.slice(0, encBytes.length - 16);
  const tag = encBytes.slice(encBytes.length - 16);

  // Match Node.js format: iv (16) + tag (16) + ciphertext
  const combined = new Uint8Array(16 + 16 + ciphertext.length);
  combined.set(iv, 0);
  combined.set(tag, 16);
  combined.set(ciphertext, 32);

  return arrayBufferToBase64(combined.buffer);
}

/** AES-256-GCM decrypt an encrypted PEM string from storage. Returns PEM. */
export async function decryptPrivateKey(
  enc: string,
  encryptionKey: string
): Promise<string> {
  const key = await getMasterKey(encryptionKey);
  const data = new Uint8Array(base64ToArrayBuffer(enc));

  const iv = data.slice(0, 16);
  const tag = data.slice(16, 32);
  const ciphertext = data.slice(32);

  // SubtleCrypto expects ciphertext + tag concatenated
  const ciphertextWithTag = new Uint8Array(ciphertext.length + 16);
  ciphertextWithTag.set(ciphertext, 0);
  ciphertextWithTag.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    ciphertextWithTag
  );

  return new TextDecoder().decode(decrypted);
}

/** Same envelope encryption for access tokens. */
export async function encryptSecret(
  plaintext: string,
  encryptionKey: string
): Promise<string> {
  return encryptPrivateKey(plaintext, encryptionKey);
}

/** Decrypt an access token or other secret. */
export async function decryptSecret(
  enc: string,
  encryptionKey: string
): Promise<string> {
  return decryptPrivateKey(enc, encryptionKey);
}

// ── Meta Flows request decryption ────────────────────────────────────────────

/**
 * Decrypt a Meta WhatsApp Flows request using the tenant's RSA private key.
 *
 * Algorithm (from Meta docs):
 * 1. RSA-OAEP (SHA-256) decrypt encrypted_aes_key → 16-byte AES-128 key
 * 2. AES-128-GCM decrypt encrypted_flow_data (last 16 bytes = auth tag) → JSON
 */
export async function decryptFlowRequest(
  payload: MetaFlowRequest,
  privateKeyPem: string
): Promise<DecryptedFlowPayload> {
  // 1. Import the RSA private key
  const pkBuf = pemToArrayBuffer(privateKeyPem);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkBuf,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"]
  );

  // 2. RSA-OAEP decrypt the AES key
  const encryptedAesKey = base64ToArrayBuffer(payload.encrypted_aes_key);
  const aesKeyBuf = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    encryptedAesKey
  );
  const aesKeyRaw = new Uint8Array(aesKeyBuf);

  // 3. Split ciphertext from GCM auth tag
  const iv = new Uint8Array(base64ToArrayBuffer(payload.initial_vector));
  const encryptedWithTag = new Uint8Array(
    base64ToArrayBuffer(payload.encrypted_flow_data)
  );
  const tagStart = encryptedWithTag.length - 16;
  const ciphertext = encryptedWithTag.slice(0, tagStart);
  const authTag = encryptedWithTag.slice(tagStart);

  // 4. Import the AES-128 key
  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesKeyRaw,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  // 5. AES-128-GCM decrypt — SubtleCrypto expects ciphertext + tag concatenated
  const ciphertextWithTag = new Uint8Array(ciphertext.length + 16);
  ciphertextWithTag.set(ciphertext, 0);
  ciphertextWithTag.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    ciphertextWithTag
  );

  const data = JSON.parse(new TextDecoder().decode(decrypted)) as Record<
    string,
    unknown
  >;

  return { aesKeyRaw, iv, data };
}

// ── Meta Flows response encryption ───────────────────────────────────────────

/**
 * Encrypt a JSON object as a Meta WhatsApp Flows response.
 *
 * Algorithm (from Meta's official sample code):
 * 1. Bitwise-NOT every byte of the original IV (~byte for each byte)
 * 2. AES-128-GCM encrypt the response JSON using the same aesKey + flipped IV
 * 3. The SubtleCrypto result already includes the 16-byte auth tag appended
 * 4. Return base64-encoded result
 */
export async function encryptFlowResponse(
  responseData: Record<string, unknown>,
  aesKeyRaw: Uint8Array,
  originalIv: Uint8Array
): Promise<string> {
  // Flip every byte of the IV with bitwise NOT
  const flippedIv = new Uint8Array(originalIv.length);
  for (let i = 0; i < originalIv.length; i++) {
    flippedIv[i] = ~originalIv[i] & 0xff;
  }

  // Import the AES-128 key
  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesKeyRaw,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const enc = new TextEncoder();
  // SubtleCrypto AES-GCM encrypt returns ciphertext + tag concatenated
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: flippedIv, tagLength: 128 },
    aesKey,
    enc.encode(JSON.stringify(responseData))
  );

  return arrayBufferToBase64(encrypted);
}
