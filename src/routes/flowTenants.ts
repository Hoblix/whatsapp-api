/**
 * Tenant management routes (super-admin only) — Hono / Cloudflare Workers
 *
 * GET    /flows/defaults                           env defaults
 * POST   /flows/tenants                            create tenant + auto-generate RSA key pair
 * GET    /flows/tenants                            list all tenants
 * GET    /flows/tenants/:id                        get tenant + active key
 * PATCH  /flows/tenants/:id                        update fields
 * DELETE /flows/tenants/:id                        cascade delete
 * POST   /flows/tenants/:id/rotate-key             generate new RSA key, deactivate old
 * POST   /flows/tenants/:id/register-meta-key      retry Meta key registration
 */

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and, ne, gt, count, desc } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { META_GRAPH_API_VERSION } from "../env";
import { createDb, getDbUrl, type Database } from "../lib/db";
import {
  flowTenantsTable,
  flowRsaKeysTable,
  flowDefinitionsTable,
  authSessionsTable,
  allowedUsersTable,
} from "../lib/schema";
import {
  generateRsaKeyPair,
  encryptSecret,
  decryptSecret,
} from "../lib/flowCrypto";

const app = new Hono<HonoEnv>();

// ── Super-admin middleware ────────────────────────────────────────────────────

app.use("/flows/tenants/*", async (c, next) => {
  const db = createDb(getDbUrl(c.env));
  const token = getCookie(c, "auth_token");
  if (!token) return c.json({ error: "Not authenticated" }, 401);

  const [session] = await db
    .select()
    .from(authSessionsTable)
    .where(and(eq(authSessionsTable.token, token), gt(authSessionsTable.expiresAt, new Date())))
    .limit(1);
  if (!session) return c.json({ error: "Session expired" }, 401);

  const [user] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, session.phoneNumber))
    .limit(1);
  if (!user || user.role !== "super_admin") return c.json({ error: "Super admin access required" }, 403);

  c.set("adminPhone", session.phoneNumber);
  await next();
});

// ── Meta Graph API: register RSA public key ──────────────────────────────────

interface MetaKeyRegistrationResult {
  success: boolean;
  metaKeyId?: string;
  error?: string;
}

async function registerKeyWithMeta(
  phoneNumberId: string,
  accessToken: string,
  publicKeyPem: string,
): Promise<MetaKeyRegistrationResult> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/whatsapp_business_encryption`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ business_public_key: publicKeyPem }),
      },
    );
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const errMsg =
        (data.error as Record<string, string> | undefined)?.message ??
        `Meta API ${response.status}`;
      return { success: false, error: errMsg };
    }
    return {
      success: true,
      metaKeyId:
        (data.id as string | undefined) ??
        (data.success as string | undefined) ??
        "registered",
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const slugRe = /^[a-z0-9_-]{1,60}$/;

function sanitizeSlug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60);
}

async function enrichTenant(
  db: Database,
  tenant: typeof flowTenantsTable.$inferSelect,
) {
  const [activeKey] = await db
    .select({
      id: flowRsaKeysTable.id,
      publicKeyPem: flowRsaKeysTable.publicKeyPem,
      createdAt: flowRsaKeysTable.createdAt,
      metaKeyId: flowRsaKeysTable.metaKeyId,
      metaRegisteredAt: flowRsaKeysTable.metaRegisteredAt,
    })
    .from(flowRsaKeysTable)
    .where(
      and(
        eq(flowRsaKeysTable.tenantId, tenant.id),
        eq(flowRsaKeysTable.isActive, true),
      ),
    )
    .limit(1);

  const [flowCountResult] = await db
    .select({ count: count() })
    .from(flowDefinitionsTable)
    .where(eq(flowDefinitionsTable.tenantId, tenant.id));

  return {
    ...tenant,
    activePublicKey: activeKey ?? null,
    flowCount: Number(flowCountResult?.count ?? 0),
  };
}

// ── GET /flows/defaults ──────────────────────────────────────────────────────

app.get("/flows/defaults", (c) => {
  return c.json({
    wabaId: c.env.WHATSAPP_WABA_ID ?? "",
    phoneNumberId: c.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    hasAccessToken: !!c.env.WHATSAPP_ACCESS_TOKEN,
  });
});

// ── POST /flows/tenants ──────────────────────────────────────────────────────

app.post("/flows/tenants", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const encKey = c.env.BACKUP_ENCRYPTION_KEY;
  const body = await c.req.json<{
    name?: string;
    slug?: string;
    wabaId?: string;
    phoneNumberId?: string;
    accessToken?: string;
  }>();

  const { name, slug, wabaId, phoneNumberId, accessToken } = body;

  if (!name?.trim()) return c.json({ error: "name is required" }, 400);

  const wabaIdFinal = wabaId?.trim() || c.env.WHATSAPP_WABA_ID || "";
  const phoneIdFinal = phoneNumberId?.trim() || c.env.WHATSAPP_PHONE_NUMBER_ID || "";
  const tokenFinal = accessToken?.trim() || c.env.WHATSAPP_ACCESS_TOKEN || "";

  if (!wabaIdFinal) return c.json({ error: "wabaId is required (or set WHATSAPP_WABA_ID)" }, 400);
  if (!phoneIdFinal) return c.json({ error: "phoneNumberId is required (or set WHATSAPP_PHONE_NUMBER_ID)" }, 400);
  if (!tokenFinal) return c.json({ error: "accessToken is required (or set WHATSAPP_ACCESS_TOKEN)" }, 400);

  const derivedSlug = slug?.trim() ? sanitizeSlug(slug.trim()) : sanitizeSlug(name.trim());
  if (!slugRe.test(derivedSlug)) {
    return c.json({ error: "slug must be lowercase alphanumeric, hyphens, underscores (max 60 chars)" }, 400);
  }

  const [existing] = await db
    .select()
    .from(flowTenantsTable)
    .where(eq(flowTenantsTable.slug, derivedSlug))
    .limit(1);
  if (existing) return c.json({ error: "A tenant with this slug already exists" }, 409);

  const accessTokenEnc = await encryptSecret(tokenFinal, encKey);

  const [tenant] = await db
    .insert(flowTenantsTable)
    .values({
      name: name.trim(),
      slug: derivedSlug,
      wabaId: wabaIdFinal,
      phoneNumberId: phoneIdFinal,
      accessTokenEnc,
      createdBy: c.get("adminPhone") ?? null,
    })
    .returning();

  // Auto-generate RSA key pair
  const kp = await generateRsaKeyPair(encKey);
  const [key] = await db
    .insert(flowRsaKeysTable)
    .values({
      tenantId: tenant.id,
      publicKeyPem: kp.publicKeyPem,
      privateKeyEnc: kp.privateKeyEnc,
      isActive: true,
    })
    .returning({
      id: flowRsaKeysTable.id,
      publicKeyPem: flowRsaKeysTable.publicKeyPem,
      createdAt: flowRsaKeysTable.createdAt,
      metaKeyId: flowRsaKeysTable.metaKeyId,
      metaRegisteredAt: flowRsaKeysTable.metaRegisteredAt,
    });

  // Auto-register the public key with Meta
  const metaResult = await registerKeyWithMeta(phoneIdFinal, tokenFinal, kp.publicKeyPem);

  let metaKeyId: string | undefined;
  if (metaResult.success && metaResult.metaKeyId) {
    metaKeyId = metaResult.metaKeyId;
    await db
      .update(flowRsaKeysTable)
      .set({ metaKeyId: metaResult.metaKeyId, metaRegisteredAt: new Date() })
      .where(eq(flowRsaKeysTable.id, key.id));
  }

  return c.json(
    {
      ...tenant,
      activePublicKey: {
        ...key,
        metaKeyId: metaKeyId ?? null,
        metaRegisteredAt: metaResult.success ? new Date() : null,
      },
      flowCount: 0,
      metaKeyRegistration: metaResult,
    },
    201,
  );
});

// ── GET /flows/tenants ───────────────────────────────────────────────────────

app.get("/flows/tenants", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenants = await db
    .select()
    .from(flowTenantsTable)
    .orderBy(desc(flowTenantsTable.createdAt));

  const enriched = await Promise.all(tenants.map((t) => enrichTenant(db, t)));
  return c.json(enriched);
});

// ── GET /flows/tenants/:id ───────────────────────────────────────────────────

app.get("/flows/tenants/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db
    .select()
    .from(flowTenantsTable)
    .where(eq(flowTenantsTable.id, id))
    .limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  return c.json(await enrichTenant(db, tenant));
});

// ── PATCH /flows/tenants/:id ─────────────────────────────────────────────────

app.patch("/flows/tenants/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const encKey = c.env.BACKUP_ENCRYPTION_KEY;
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db
    .select()
    .from(flowTenantsTable)
    .where(eq(flowTenantsTable.id, id))
    .limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    slug?: string;
    wabaId?: string;
    phoneNumberId?: string;
    accessToken?: string;
  }>();

  const updates: Partial<typeof flowTenantsTable.$inferInsert> = {};
  if (body.name?.trim()) updates.name = body.name.trim();
  if (body.wabaId?.trim()) updates.wabaId = body.wabaId.trim();
  if (body.phoneNumberId?.trim()) updates.phoneNumberId = body.phoneNumberId.trim();
  if (body.accessToken?.trim()) updates.accessTokenEnc = await encryptSecret(body.accessToken.trim(), encKey);

  if (body.slug?.trim()) {
    const newSlug = sanitizeSlug(body.slug.trim());
    if (!slugRe.test(newSlug)) return c.json({ error: "Invalid slug format" }, 400);
    const [conflict] = await db
      .select()
      .from(flowTenantsTable)
      .where(eq(flowTenantsTable.slug, newSlug))
      .limit(1);
    if (conflict && conflict.id !== id) return c.json({ error: "Slug already taken" }, 409);
    updates.slug = newSlug;
  }

  if (Object.keys(updates).length === 0) return c.json({ error: "No valid fields to update" }, 400);

  const [updated] = await db
    .update(flowTenantsTable)
    .set(updates)
    .where(eq(flowTenantsTable.id, id))
    .returning();

  return c.json(await enrichTenant(db, updated));
});

// ── DELETE /flows/tenants/:id ────────────────────────────────────────────────

app.delete("/flows/tenants/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db
    .select()
    .from(flowTenantsTable)
    .where(eq(flowTenantsTable.id, id))
    .limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  await db.delete(flowTenantsTable).where(eq(flowTenantsTable.id, id));
  return c.json({ ok: true });
});

// ── POST /flows/tenants/:id/rotate-key ───────────────────────────────────────

app.post("/flows/tenants/:id/rotate-key", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const encKey = c.env.BACKUP_ENCRYPTION_KEY;
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db
    .select()
    .from(flowTenantsTable)
    .where(eq(flowTenantsTable.id, id))
    .limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  // Generate key pair outside the transaction (CPU work)
  const kp = await generateRsaKeyPair(encKey);

  const newKey = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(flowRsaKeysTable)
      .values({
        tenantId: id,
        publicKeyPem: kp.publicKeyPem,
        privateKeyEnc: kp.privateKeyEnc,
        isActive: true,
      })
      .returning({
        id: flowRsaKeysTable.id,
        publicKeyPem: flowRsaKeysTable.publicKeyPem,
        createdAt: flowRsaKeysTable.createdAt,
        metaKeyId: flowRsaKeysTable.metaKeyId,
        metaRegisteredAt: flowRsaKeysTable.metaRegisteredAt,
      });

    await tx
      .update(flowRsaKeysTable)
      .set({ isActive: false })
      .where(and(eq(flowRsaKeysTable.tenantId, id), ne(flowRsaKeysTable.id, inserted.id)));

    return inserted;
  });

  // Try decrypting stored token; fall back to env var if decryption fails
  // (e.g., migrated from a different key derivation scheme)
  let accessToken: string;
  try {
    accessToken = await decryptSecret(tenant.accessTokenEnc, encKey);
  } catch {
    accessToken = c.env.WHATSAPP_ACCESS_TOKEN ?? "";
    // Re-encrypt the token with the current key for future use
    if (accessToken) {
      const newEnc = await encryptSecret(accessToken, encKey);
      await db.update(flowTenantsTable).set({ accessTokenEnc: newEnc }).where(eq(flowTenantsTable.id, id));
    }
  }
  const metaResult = await registerKeyWithMeta(tenant.phoneNumberId, accessToken, kp.publicKeyPem);

  if (metaResult.success && metaResult.metaKeyId) {
    await db
      .update(flowRsaKeysTable)
      .set({ metaKeyId: metaResult.metaKeyId, metaRegisteredAt: new Date() })
      .where(eq(flowRsaKeysTable.id, newKey.id));
  }

  return c.json({
    ok: true,
    newPublicKey: {
      ...newKey,
      metaKeyId: metaResult.success ? (metaResult.metaKeyId ?? null) : null,
      metaRegisteredAt: metaResult.success ? new Date() : null,
    },
    metaKeyRegistration: metaResult,
  });
});

// ── POST /flows/tenants/:id/register-meta-key ────────────────────────────────

app.post("/flows/tenants/:id/register-meta-key", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const encKey = c.env.BACKUP_ENCRYPTION_KEY;
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db
    .select()
    .from(flowTenantsTable)
    .where(eq(flowTenantsTable.id, id))
    .limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const [activeKey] = await db
    .select()
    .from(flowRsaKeysTable)
    .where(and(eq(flowRsaKeysTable.tenantId, id), eq(flowRsaKeysTable.isActive, true)))
    .limit(1);
  if (!activeKey) return c.json({ error: "No active key found for this tenant" }, 404);

  let accessToken: string;
  try {
    accessToken = await decryptSecret(tenant.accessTokenEnc, encKey);
  } catch {
    accessToken = c.env.WHATSAPP_ACCESS_TOKEN ?? "";
    if (accessToken) {
      const newEnc = await encryptSecret(accessToken, encKey);
      await db.update(flowTenantsTable).set({ accessTokenEnc: newEnc }).where(eq(flowTenantsTable.id, id));
    }
  }
  const metaResult = await registerKeyWithMeta(tenant.phoneNumberId, accessToken, activeKey.publicKeyPem);

  if (metaResult.success && metaResult.metaKeyId) {
    await db
      .update(flowRsaKeysTable)
      .set({ metaKeyId: metaResult.metaKeyId, metaRegisteredAt: new Date() })
      .where(eq(flowRsaKeysTable.id, activeKey.id));
  }

  return c.json({ ok: metaResult.success, metaKeyRegistration: metaResult });
});

export default app;
