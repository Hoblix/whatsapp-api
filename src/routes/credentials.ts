/**
 * Credential Management routes — super-admin only
 *
 * GET    /credentials          — list all credentials (values masked)
 * PUT    /credentials/:key     — update/create a credential
 * DELETE /credentials/:key     — delete a credential
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import { appCredentialsTable } from "../lib/schema";
import {
  encryptValue,
  decryptValue,
  maskValue,
  invalidateCache,
  CREDENTIAL_DEFINITIONS,
  CATEGORY_LABELS,
} from "../lib/credentialStore";

const app = new Hono<HonoEnv>();

function getEncryptionKey(env: any): string {
  return env.CREDENTIAL_ENCRYPTION_KEY ?? env.BACKUP_ENCRYPTION_KEY ?? "";
}

// ── GET /credentials — list all (values masked) ──

app.get("/credentials", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const encKey = getEncryptionKey(c.env);

  const rows = await db.select().from(appCredentialsTable);
  const storedMap = new Map(rows.map((r) => [r.key, r]));

  // Build response: every defined credential + any extra stored ones
  const items: any[] = [];

  for (const def of CREDENTIAL_DEFINITIONS) {
    const row = storedMap.get(def.key);
    let maskedValue = "";
    let isSet = false;

    if (row) {
      try {
        const plain = await decryptValue(row.encryptedValue, encKey);
        maskedValue = maskValue(plain);
        isSet = true;
      } catch {
        maskedValue = "[decryption error]";
        isSet = true;
      }
    }

    items.push({
      key: def.key,
      label: def.label,
      category: def.category,
      description: def.description,
      maskedValue,
      isSet,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    });
  }

  // Group by category
  const categories = Object.entries(CATEGORY_LABELS).map(([id, label]) => ({
    id,
    label,
    items: items.filter((i) => i.category === id),
  })).filter((c) => c.items.length > 0);

  return c.json({ categories });
});

// ── PUT /credentials/:key — update or create ──

app.put("/credentials/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{ value: string }>();

  if (!body.value && body.value !== "") {
    return c.json({ error: "value is required" }, 400);
  }

  const db = createDb(getDbUrl(c.env));
  const encKey = getEncryptionKey(c.env);
  if (!encKey) {
    return c.json({ error: "CREDENTIAL_ENCRYPTION_KEY not configured" }, 500);
  }

  const encrypted = await encryptValue(body.value, encKey);
  const def = CREDENTIAL_DEFINITIONS.find((d) => d.key === key);

  const now = new Date();
  const adminPhone = (c as any).get?.("authPhone") ?? "system";

  // Upsert
  const [existing] = await db
    .select()
    .from(appCredentialsTable)
    .where(eq(appCredentialsTable.key, key))
    .limit(1);

  if (existing) {
    await db
      .update(appCredentialsTable)
      .set({
        encryptedValue: encrypted,
        label: def?.label ?? existing.label,
        category: def?.category ?? existing.category,
        description: def?.description ?? existing.description,
        updatedBy: adminPhone,
        updatedAt: now,
      })
      .where(eq(appCredentialsTable.key, key));
  } else {
    await db.insert(appCredentialsTable).values({
      key,
      encryptedValue: encrypted,
      label: def?.label ?? key,
      category: def?.category ?? "general",
      description: def?.description ?? "",
      updatedBy: adminPhone,
    });
  }

  invalidateCache();

  return c.json({
    ok: true,
    key,
    maskedValue: maskValue(body.value),
  });
});

// ── DELETE /credentials/:key ──

app.delete("/credentials/:key", async (c) => {
  const key = c.req.param("key");
  const db = createDb(getDbUrl(c.env));

  await db.delete(appCredentialsTable).where(eq(appCredentialsTable.key, key));
  invalidateCache();

  return c.json({ ok: true, key });
});

export default app;
