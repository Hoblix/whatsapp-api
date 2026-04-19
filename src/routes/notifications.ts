import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl, type Database } from "../lib/db";
import { pushSubscriptionsTable } from "../lib/schema";
import { eq } from "drizzle-orm";

const app = new Hono<HonoEnv>();

// ── GET /notifications/vapid-key — return public VAPID key ───────────────────

app.get("/notifications/vapid-key", (c) => {
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
});

// ── POST /notifications/subscribe — store push subscription in DB ────────────

app.post("/notifications/subscribe", async (c) => {
  const { endpoint, keys } = await c.req.json();

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return c.json({ error: "endpoint, keys.p256dh, and keys.auth are required" }, 400);
  }

  const db = createDb(getDbUrl(c.env));

  // Upsert: if endpoint already exists, update keys
  const existing = await db.query.pushSubscriptionsTable.findFirst({
    where: eq(pushSubscriptionsTable.endpoint, endpoint),
  });

  if (existing) {
    await db
      .update(pushSubscriptionsTable)
      .set({
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: c.req.header("user-agent") ?? null,
      })
      .where(eq(pushSubscriptionsTable.id, existing.id));
  } else {
    await db.insert(pushSubscriptionsTable).values({
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: c.req.header("user-agent") ?? null,
    });
  }

  return c.json({ success: true });
});

// ── DELETE /notifications/unsubscribe — remove subscription ──────────────────

app.delete("/notifications/unsubscribe", async (c) => {
  const { endpoint } = await c.req.json();

  if (!endpoint) {
    return c.json({ error: "endpoint is required" }, 400);
  }

  const db = createDb(getDbUrl(c.env));
  await db
    .delete(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.endpoint, endpoint));

  return c.json({ success: true });
});

// ── Web Push implementation using Web Crypto API ────────────────────────────

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function createVapidJwt(
  audience: string,
  subject: string,
  vapidPrivateKeyBase64: string,
  vapidPublicKeyBase64: string,
): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: now + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;

  // Import private key (VAPID keys are raw base64url-encoded P-256 keys)
  const rawPrivate = base64UrlDecode(vapidPrivateKeyBase64);
  // Build JWK from raw 32-byte private key + 65-byte public key
  const rawPublic = base64UrlDecode(vapidPublicKeyBase64);
  const x = base64UrlEncode(rawPublic.slice(1, 33).buffer as ArrayBuffer);
  const y = base64UrlEncode(rawPublic.slice(33, 65).buffer as ArrayBuffer);
  const d = base64UrlEncode(rawPrivate.buffer as ArrayBuffer);

  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", x, y, d,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function encryptPayload(
  payload: string,
  p256dhBase64: string,
  authBase64: string,
): Promise<{ encrypted: ArrayBuffer; salt: Uint8Array; localPublicKey: ArrayBuffer }> {
  const p256dh = base64UrlDecode(p256dhBase64);
  const auth = base64UrlDecode(authBase64);

  // Generate local ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;

  // Import subscriber's public key
  const subscriberKey = await crypto.subtle.importKey(
    "raw", p256dh.buffer as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );

  // ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: subscriberKey } as any,
    localKeyPair.privateKey,
    256,
  );

  // Export local public key
  const localPublicKey = await crypto.subtle.exportKey("raw", localKeyPair.publicKey) as ArrayBuffer;

  // Salt (16 random bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF for auth
  const authInfo = new TextEncoder().encode("Content-Encoding: auth\0");
  const ikmKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const prk = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: auth.buffer as ArrayBuffer, info: authInfo.buffer as ArrayBuffer },
    ikmKey, 256,
  );

  // Build context
  const keyLabel = new TextEncoder().encode("Content-Encoding: aesgcm\0");
  const nonceLabel = new TextEncoder().encode("Content-Encoding: nonce\0");
  const p256Label = new TextEncoder().encode("P-256\0");
  const recipientLen = new Uint8Array([0, 65]);
  const senderLen = new Uint8Array([0, 65]);
  const context = new Uint8Array([
    ...p256Label,
    ...recipientLen, ...new Uint8Array(p256dh),
    ...senderLen, ...new Uint8Array(localPublicKey),
  ]);

  const cekInfo = new Uint8Array([...keyLabel, ...context]);
  const nonceInfo = new Uint8Array([...nonceLabel, ...context]);

  const prkKey = await crypto.subtle.importKey("raw", prk, "HKDF", false, ["deriveBits"]);
  const cekBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, info: cekInfo.buffer as ArrayBuffer },
    prkKey, 128,
  );
  const nonceBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, info: nonceInfo.buffer as ArrayBuffer },
    prkKey, 96,
  );

  // Encrypt with AES-128-GCM
  const cek = await crypto.subtle.importKey("raw", cekBits, "AES-GCM", false, ["encrypt"]);
  const paddedPayload = new Uint8Array([0, 0, ...new TextEncoder().encode(payload)]);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonceBits, tagLength: 128 },
    cek, paddedPayload.buffer as ArrayBuffer,
  );

  return { encrypted, salt, localPublicKey };
}

// ── sendPushToAll — Web Push via Web Crypto API ─────────────────────────────

export async function sendPushToAll(
  db: Database,
  payload: { title: string; body: string; data?: any },
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string,
): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.log("[push] VAPID keys not configured — skipping");
    return;
  }

  const subscriptions = await db.select().from(pushSubscriptionsTable);
  if (subscriptions.length === 0) return;

  const payloadStr = JSON.stringify(payload);

  for (const sub of subscriptions) {
    try {
      const audience = new URL(sub.endpoint).origin;
      const jwt = await createVapidJwt(audience, vapidSubject || "mailto:hello@hoblix.com", vapidPrivateKey, vapidPublicKey);

      const { encrypted, salt, localPublicKey } = await encryptPayload(payloadStr, sub.p256dh, sub.auth);

      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "aesgcm",
          "TTL": "86400",
          "Authorization": `vapid t=${jwt}, k=${vapidPublicKey}`,
          "Crypto-Key": `dh=${base64UrlEncode(localPublicKey)}; p256ecdsa=${vapidPublicKey}`,
          "Encryption": `salt=${base64UrlEncode(salt)}`,
        },
        body: encrypted,
      });

      if (res.status === 201 || res.status === 200) {
        console.log(`[push] Sent to ${sub.endpoint.substring(0, 50)}...`);
      } else if (res.status === 410 || res.status === 404) {
        // Subscription expired — remove it
        await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.id, sub.id));
        console.log(`[push] Removed expired subscription ${sub.id}`);
      } else {
        const text = await res.text();
        console.warn(`[push] Failed ${res.status} for sub ${sub.id}: ${text.substring(0, 100)}`);
      }
    } catch (err: any) {
      console.warn(`[push] Error sending to sub ${sub.id}: ${err.message}`);
    }
  }
}

export default app;
