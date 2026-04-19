import type { Context, Next } from "hono";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import { authSessionsTable, apiKeysTable, ipAllowlistTable } from "../lib/schema";
import { eq, and, gt } from "drizzle-orm";
import { sha256 } from "../lib/crypto";
import { getCookie } from "hono/cookie";

function getClientIp(c: Context<HonoEnv>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

function matchesCidr(cidr: string, ip: string): boolean {
  if (!cidr.includes("/")) return cidr === ip;
  const [network, bits] = cidr.split("/");
  const mask = parseInt(bits, 10);
  const toInt = (s: string) =>
    s.split(".").reduce((acc, p) => (acc << 8) | parseInt(p, 10), 0);
  try {
    const netInt = toInt(network);
    const ipInt = toInt(ip);
    const maskInt = mask === 0 ? 0 : ~0 << (32 - mask);
    return (netInt & maskInt) === (ipInt & maskInt);
  } catch {
    return false;
  }
}

export async function requireAuth(c: Context<HonoEnv>, next: Next) {
  const db = createDb(getDbUrl(c.env));

  // 1. Check session cookie
  const cookieToken = getCookie(c, "auth_token");
  if (cookieToken) {
    const session = await db.query.authSessionsTable.findFirst({
      where: and(
        eq(authSessionsTable.token, cookieToken),
        gt(authSessionsTable.expiresAt, new Date())
      ),
    });
    if (session) {
      c.set("authPhone", session.phoneNumber);
      await next();
      return;
    }
    return c.json({ error: "Session expired" }, 401);
  }

  // 2. Check API key via Authorization: Bearer <key>
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const apiKey = authHeader.slice(7).trim();
    const keyHash = await sha256(apiKey);
    const keyRecord = await db.query.apiKeysTable.findFirst({
      where: eq(apiKeysTable.key, keyHash),
    });

    if (keyRecord) {
      // IP Allowlist check
      const allowedEntries = await db
        .select()
        .from(ipAllowlistTable)
        .where(eq(ipAllowlistTable.enabled, true));

      if (allowedEntries.length > 0) {
        const clientIp = getClientIp(c);
        const isAllowed = allowedEntries.some(
          (entry) => entry.ip === clientIp || matchesCidr(entry.ip, clientIp)
        );
        if (!isAllowed) {
          return c.json(
            {
              error: `IP address ${clientIp} is not on the allowlist. Add it in Settings → API Access → IP Allowlist.`,
            },
            403
          );
        }
      }

      // Update lastUsedAt (fire-and-forget)
      db.update(apiKeysTable)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeysTable.id, keyRecord.id))
        .catch(() => {});

      c.set("authPhone", "api_key");
      c.set("clientIp", getClientIp(c));
      await next();
      return;
    }

    return c.json({ error: "Invalid API key" }, 401);
  }

  return c.json({ error: "Not authenticated" }, 401);
}
