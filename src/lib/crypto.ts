/**
 * API Key Cryptography — Cloudflare Workers (Web Crypto API)
 *
 * All hashing is async because SubtleCrypto.digest returns a Promise.
 */

/** Convert an ArrayBuffer to a lowercase hex string. */
function arrayBufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** SHA-256 hash of a string, returned as hex. */
export async function sha256(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return arrayBufferToHex(digest);
}

/** Generate a fresh API key: raw plaintext + its hash + display prefix. */
export async function generateApiKey(): Promise<{
  raw: string;
  hash: string;
  prefix: string;
}> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const raw = "wad_" + arrayBufferToHex(bytes.buffer);
  return { raw, hash: await sha256(raw), prefix: raw.slice(0, 12) };
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Uses a manual byte-by-byte comparison since `timingSafeEqual` is not
 * available in the Cloudflare Workers runtime.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoderA = new TextEncoder().encode(a);
  const encoderB = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < encoderA.length; i++) {
    diff |= encoderA[i] ^ encoderB[i];
  }
  return diff === 0;
}
