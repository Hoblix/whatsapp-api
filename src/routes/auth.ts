import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq, and, gt, desc } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { META_GRAPH_API_VERSION } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import { sha256 } from "../lib/crypto";
import {
  allowedUsersTable,
  otpCodesTable,
  authSessionsTable,
  conversationsTable,
  messagesTable,
} from "../lib/schema";

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// In-memory rate limit (per-isolate; resets on cold start — acceptable for OTP)
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute (per-phone)
const RATE_LIMIT_MAX = 3; // max OTP requests per window per phone

function isRateLimited(phone: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(phone);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(phone, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Per-IP rate limit — 3 OTP requests per hour from the same client IP
const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const IP_RATE_LIMIT_MAX = 3;

function isIpRateLimited(ip: string): boolean {
  if (!ip) return false;
  const now = Date.now();
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + IP_RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > IP_RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------------------
// POST /auth/send-otp
// ---------------------------------------------------------------------------
// Domains allowed to trigger OTP sends (prevents abuse from unauthorized sources)
const ALLOWED_OTP_DOMAINS = [
  "hoblix.com",
  "whatsapp.hoblix.com",
];

function isOriginAllowed(origin: string | undefined, referer: string | undefined): boolean {
  const checkUrl = (urlStr: string): boolean => {
    try {
      const url = new URL(urlStr);
      const host = url.hostname.toLowerCase();
      // Allow localhost/127.0.0.1 for local development
      if (host === "localhost" || host === "127.0.0.1") return true;
      return ALLOWED_OTP_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };
  if (origin && checkUrl(origin)) return true;
  if (referer && checkUrl(referer)) return true;
  return false;
}

app.post("/auth/send-otp", async (c) => {
  // Domain whitelist — reject requests not originating from approved domains
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  if (!isOriginAllowed(origin, referer)) {
    return c.json({ error: "Request origin not allowed" }, 403);
  }

  // IP rate limit: max 3 OTP requests per hour per client IP
  const clientIp =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    "";
  if (isIpRateLimited(clientIp)) {
    return c.json({ error: "Too many OTP requests from this device. Try again in an hour." }, 429);
  }

  const db = createDb(getDbUrl(c.env));
  const body = await c.req.json<{ phoneNumber?: string; phone?: string }>();
  const rawPhone = (body.phoneNumber ?? body.phone ?? "").replace(/\D/g, "");

  if (!rawPhone || rawPhone.length < 7 || rawPhone.length > 15) {
    return c.json({ error: "Invalid phone number" }, 400);
  }
  // Auto-prepend 91 (India) for 10-digit numbers
  const phone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;

  // Check allowlist
  const [allowed] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, phone))
    .limit(1);

  if (!allowed) {
    return c.json({ error: "Phone number not authorized" }, 403);
  }

  // Rate limit
  if (isRateLimited(phone)) {
    return c.json({ error: "Too many OTP requests. Try again later." }, 429);
  }

  // Generate OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = await sha256(otp);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  // Store OTP
  await db.insert(otpCodesTable).values({
    phoneNumber: phone,
    otpHash,
    expiresAt,
  });

  // Send OTP via WhatsApp template API
  try {
    const waResponse = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${c.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: c.env.OTP_TEMPLATE_NAME || "otp_login",
            language: { code: c.env.OTP_TEMPLATE_LANG || "en" },
            components: [
              {
                type: "body",
                parameters: [{ type: "text", text: otp }],
              },
              {
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [{ type: "text", text: otp }],
              },
            ],
          },
        }),
      }
    );

    if (!waResponse.ok) {
      console.error("WhatsApp API error:", await waResponse.text());
      return c.json({ error: "Failed to send OTP" }, 502);
    }

    // Log OTP send in conversation history (audit trail)
    try {
      const waData = (await waResponse.json()) as any;
      const waMessageId = waData?.messages?.[0]?.id ?? null;

      // Upsert conversation
      let conv = await db.query.conversationsTable.findFirst({
        where: eq(conversationsTable.phoneNumber, phone),
      });
      if (!conv) {
        const [row] = await db
          .insert(conversationsTable)
          .values({
            phoneNumber: phone,
            lastMessageAt: new Date(),
            lastMessage: `[OTP sent]`,
            unreadCount: 0,
          })
          .returning();
        conv = row;
      } else {
        await db
          .update(conversationsTable)
          .set({ lastMessageAt: new Date(), lastMessage: `[OTP sent]` })
          .where(eq(conversationsTable.id, conv.id));
      }

      await db.insert(messagesTable).values({
        conversationId: conv.id,
        waMessageId,
        direction: "outbound",
        messageType: "text",
        body: `[OTP sent: ${otp}]`,
        status: "sent",
        timestamp: new Date(),
        rawPayload: { type: "otp", template: c.env.OTP_TEMPLATE_NAME || "otp_login" },
      });
    } catch (logErr) {
      console.error("OTP log error:", logErr);
      // Non-fatal — OTP was already sent
    }
  } catch (err) {
    console.error("WhatsApp API request failed:", err);
    return c.json({ error: "Failed to send OTP" }, 502);
  }

  return c.json({ ok: true, message: "OTP sent" });
});

// ---------------------------------------------------------------------------
// POST /auth/verify-otp
// ---------------------------------------------------------------------------
app.post("/auth/verify-otp", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const body = await c.req.json<{ phoneNumber?: string; phone?: string; otp?: string }>();
  const rawPhone = (body.phoneNumber ?? body.phone ?? "").replace(/\D/g, "").trim();
  const phone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;
  const otp = body.otp?.trim();

  if (!phone || !otp) {
    return c.json({ error: "Phone and OTP are required" }, 400);
  }

  // Helper to log verification attempt to conversation history
  async function logVerification(status: "verified" | "failed", reason?: string) {
    try {
      let conv = await db.query.conversationsTable.findFirst({
        where: eq(conversationsTable.phoneNumber, phone),
      });
      if (!conv) {
        const [row] = await db
          .insert(conversationsTable)
          .values({
            phoneNumber: phone,
            lastMessageAt: new Date(),
            lastMessage: status === "verified" ? "[OTP verified]" : `[OTP failed: ${reason}]`,
            unreadCount: 0,
          })
          .returning();
        conv = row;
      } else {
        await db
          .update(conversationsTable)
          .set({ lastMessageAt: new Date(), lastMessage: status === "verified" ? "[OTP verified]" : `[OTP failed: ${reason}]` })
          .where(eq(conversationsTable.id, conv.id));
      }
      await db.insert(messagesTable).values({
        conversationId: conv.id,
        direction: "outbound",
        messageType: "text",
        body: status === "verified" ? `[OTP verified ✓]` : `[OTP verification failed: ${reason}]`,
        status: "sent",
        timestamp: new Date(),
        rawPayload: { type: "otp_verify", status, reason: reason ?? null },
      });
    } catch (e) {
      console.error("OTP verify log error:", e);
    }
  }

  // Get ALL unexpired OTPs for this phone (user may have requested multiple via Resend)
  const otpRows = await db
    .select()
    .from(otpCodesTable)
    .where(
      and(
        eq(otpCodesTable.phoneNumber, phone),
        gt(otpCodesTable.expiresAt, new Date())
      )
    )
    .orderBy(desc(otpCodesTable.createdAt));

  if (otpRows.length === 0) {
    await logVerification("failed", "expired or not found");
    return c.json({ error: "OTP expired or not found" }, 400);
  }

  // Check max attempts across all OTPs
  const totalAttempts = otpRows.reduce((sum, r) => sum + r.attempts, 0);
  if (totalAttempts >= 10) {
    await logVerification("failed", "too many attempts");
    return c.json({ error: "Too many attempts. Request a new OTP." }, 429);
  }

  // Increment attempts on the most recent OTP (for rate limiting)
  await db
    .update(otpCodesTable)
    .set({ attempts: otpRows[0].attempts + 1 })
    .where(eq(otpCodesTable.id, otpRows[0].id));

  // Verify against any unexpired OTP (not just the latest)
  const inputHash = await sha256(otp);
  const matchedOtp = otpRows.find(r => r.otpHash === inputHash);

  if (!matchedOtp) {
    await logVerification("failed", "invalid code");
    return c.json({ error: "Invalid OTP" }, 401);
  }

  // OTP matched — log success
  await logVerification("verified");

  // OTP valid — look up user role
  const [user] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, phone))
    .limit(1);

  // Generate session token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await db.insert(authSessionsTable).values({
    token,
    phoneNumber: phone,
    expiresAt: sessionExpires,
  });

  // Delete used OTP rows for this phone
  await db
    .delete(otpCodesTable)
    .where(eq(otpCodesTable.phoneNumber, phone));

  // Set cookie — production-grade settings
  setCookie(c, "auth_token", token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax", // Lax for cross-origin Pages→Worker proxy
    expires: sessionExpires,
  });

  return c.json({
    ok: true,
    phoneNumber: phone,
    role: user?.role ?? "user",
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
app.post("/auth/logout", async (c) => {
  const token = getCookie(c, "auth_token");

  if (token) {
    const db = createDb(getDbUrl(c.env));
    await db
      .delete(authSessionsTable)
      .where(eq(authSessionsTable.token, token));
  }

  deleteCookie(c, "auth_token", { path: "/" });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------
app.get("/auth/me", async (c) => {
  const token = getCookie(c, "auth_token");
  if (!token) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const db = createDb(getDbUrl(c.env));

  const [session] = await db
    .select()
    .from(authSessionsTable)
    .where(
      and(
        eq(authSessionsTable.token, token),
        gt(authSessionsTable.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) {
    deleteCookie(c, "auth_token", { path: "/" });
    return c.json({ error: "Session expired" }, 401);
  }

  const [user] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, session.phoneNumber))
    .limit(1);

  return c.json({
    phoneNumber: session.phoneNumber,
    role: user?.role ?? "user",
  });
});

export default app;
