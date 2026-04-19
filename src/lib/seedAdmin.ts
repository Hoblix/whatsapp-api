/**
 * Seed super admin user and API key on first request.
 *
 * Ported from api-server for Cloudflare Workers:
 * - async sha256/generateApiKey (Web Crypto API)
 * - console.log instead of pino logger
 * - db and phone passed as parameters instead of reading process.env
 */

import { eq } from "drizzle-orm";
import type { Database } from "./db";
import { allowedUsersTable, apiKeysTable } from "./db";
import { sha256, generateApiKey } from "./crypto";

export async function seedSuperAdmin(
  db: Database,
  superAdminPhone: string
): Promise<void> {
  const phone = superAdminPhone.replace(/\D/g, "");

  try {
    const existing = await db.query.allowedUsersTable.findFirst({
      where: eq(allowedUsersTable.phoneNumber, phone),
    });

    if (!existing) {
      await db.insert(allowedUsersTable).values({
        phoneNumber: phone,
        role: "super_admin",
        addedBy: "system",
      });
      console.log(`Super admin seeded: ${phone}`);
    } else if (existing.role !== "super_admin") {
      await db
        .update(allowedUsersTable)
        .set({ role: "super_admin" })
        .where(eq(allowedUsersTable.phoneNumber, phone));
      console.log(`Super admin role enforced: ${phone}`);
    }
  } catch (err) {
    console.error("Failed to seed super admin:", err);
  }
}

export async function seedApiKey(db: Database): Promise<void> {
  try {
    const existing = await db.query.apiKeysTable.findFirst();

    if (!existing) {
      // Fresh install — generate and store hashed key
      const { raw, hash, prefix } = await generateApiKey();
      await db
        .insert(apiKeysTable)
        .values({ key: hash, keyPrefix: prefix, name: "Default" });
      console.log(
        `API key created (prefix: ${prefix}) — retrieve from Settings > API Access`
      );
      // Log the raw key once so admin can copy it from logs on first boot
      console.log(`INITIAL API KEY (copy this now, it won't be shown again): ${raw}`);
      return;
    }

    // Migration: if key column still holds a plaintext key (starts with "wad_"), hash it
    if (existing.key.startsWith("wad_")) {
      const hash = await sha256(existing.key);
      const prefix = existing.key.slice(0, 12);
      await db
        .update(apiKeysTable)
        .set({ key: hash, keyPrefix: prefix })
        .where(eq(apiKeysTable.id, existing.id));
      console.log(
        `API key migrated to hashed storage (prefix: ${prefix}) — existing key still works`
      );
      return;
    }

    // Already hashed — nothing to do
    console.log(`API key OK (prefix: ${existing.keyPrefix ?? "unknown"})`);
  } catch (err) {
    console.error("Failed to seed API key:", err);
  }
}
