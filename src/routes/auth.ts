import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq, and, gt, desc } from "drizzle-orm";
import { db } from "../lib/db";
import { sha256 } from "../lib/crypto";
import {
  allowedUsersTable,
  otpCodesTable,
  authSessionsTable,
} from "../lib/schema/auth";

const app = new Hono();

const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v22.0";

// ---------------------------------------------------------------------------
// In-memory rate limit (per-process; resets on restart — acceptable for OTP)
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 3;

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

const ALLOWED_OTP_DOMAINS = ["hoblix.com", "whatsapp.hoblix.com"];

function isOriginAllowed(origin: string | undefined, referer: string | undefined): boolean {
  const checkUrl = (urlStr: string): boolean => {
    try {
      const url = new URL(urlStr);
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1") return true;
      return ALLOWED_OTP_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
    } catch { return false; }
  };
  if (origin && checkUrl(origin)) return true;
  if (referer && checkUrl(referer)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// POST /send-otp
// ---------------------------------------------------------------------------
app.post("/send-otp", async (c) => {
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  if (!isOriginAllowed(origin, referer)) {
    return c.json({ error: "Request origin not allowed" }, 403);
  }

  const body = await c.req.json<{ phoneNumber?: string; phone?: string }>();
  const rawPhone = (body.phoneNumber ?? body.phone ?? "").replace(/\D/g, "");
  if (!rawPhone || rawPhone.length < 7 || rawPhone.length > 15) {
    return c.json({ error: "Invalid phone number" }, 400);
  }

  const phone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;

  const [allowed] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, phone))
    .limit(1);

  if (!allowed) {
    return c.json({ error: "Phone number not authorized" }, 403);
  }

  if (isRateLimited(phone)) {
    return c.json({ error: "Too many OTP requests. Try again later." }, 429);
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = await sha256(otp);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await db.insert(otpCodesTable).values({ phoneNumber: phone, otpHash, expiresAt });

  try {
    const waResponse = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: process.env.OTP_TEMPLATE_NAME || "otp_login",
            language: { code: process.env.OTP_TEMPLATE_LANG || "en" },
            components: [
              { type: "body", parameters: [{ type: "text", text: otp }] },
              { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: otp }] },
            ],
          },
        }),
      }
    );

    if (!waResponse.ok) {
      console.error("WhatsApp API error:", await waResponse.text());
      return c.json({ error: "Failed to send OTP via WhatsApp" }, 502);
    }
  } catch (err) {
    console.error("WhatsApp fetch failed:", err);
    return c.json({ error: "Failed to send OTP" }, 502);
  }

  return c.json({ ok: true, message: "OTP sent" });
});

// ---------------------------------------------------------------------------
// POST /verify-otp
// ---------------------------------------------------------------------------
app.post("/verify-otp", async (c) => {
  const body = await c.req.json<{ phoneNumber?: string; phone?: string; otp?: string }>();
  const rawPhone = (body.phoneNumber ?? body.phone ?? "").replace(/\D/g, "").trim();
  const phone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;
  const otp = body.otp?.trim();

  if (!phone || !otp) {
    return c.json({ error: "Phone and OTP are required" }, 400);
  }

  const otpRows = await db
    .select()
    .from(otpCodesTable)
    .where(and(eq(otpCodesTable.phoneNumber, phone), gt(otpCodesTable.expiresAt, new Date())))
    .orderBy(desc(otpCodesTable.createdAt));

  if (otpRows.length === 0) {
    return c.json({ error: "OTP expired or not found" }, 400);
  }

  const totalAttempts = otpRows.reduce((sum, r) => sum + r.attempts, 0);
  if (totalAttempts >= 10) {
    return c.json({ error: "Too many attempts. Request a new OTP." }, 429);
  }

  await db
    .update(otpCodesTable)
    .set({ attempts: otpRows[0].attempts + 1 })
    .where(eq(otpCodesTable.id, otpRows[0].id));

  const inputHash = await sha256(otp);
  const matchedOtp = otpRows.find(r => r.otpHash === inputHash);
  if (!matchedOtp) {
    return c.json({ error: "Invalid OTP" }, 401);
  }

  const [user] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, phone))
    .limit(1);

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(authSessionsTable).values({ token, phoneNumber: phone, expiresAt: sessionExpires });
  await db.delete(otpCodesTable).where(eq(otpCodesTable.phoneNumber, phone));

  setCookie(c, "auth_token", token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    expires: sessionExpires,
  });

  return c.json({ ok: true, phoneNumber: phone, role: user?.role ?? "user" });
});

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------
app.post("/logout", async (c) => {
  const token = getCookie(c, "auth_token");
  if (token) {
    await db.delete(authSessionsTable).where(eq(authSessionsTable.token, token));
  }
  deleteCookie(c, "auth_token", { path: "/" });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------
app.get("/me", async (c) => {
  const token = getCookie(c, "auth_token");
  if (!token) return c.json({ error: "Not authenticated" }, 401);

  const [session] = await db
    .select()
    .from(authSessionsTable)
    .where(and(eq(authSessionsTable.token, token), gt(authSessionsTable.expiresAt, new Date())))
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

  return c.json({ phoneNumber: session.phoneNumber, role: user?.role ?? "user" });
});

export default app;
