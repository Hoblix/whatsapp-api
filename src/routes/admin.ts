import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and, gt } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import { generateApiKey } from "../lib/crypto";
import {
  allowedUsersTable,
  authSessionsTable,
  apiKeysTable,
  ipAllowlistTable,
} from "../lib/schema";

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Middleware: require super_admin
// ---------------------------------------------------------------------------
app.use("/admin/*", async (c, next) => {
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
    return c.json({ error: "Session expired" }, 401);
  }

  const [user] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, session.phoneNumber))
    .limit(1);

  if (!user || user.role !== "super_admin") {
    return c.json({ error: "Forbidden: super_admin required" }, 403);
  }

  c.set("adminPhone", session.phoneNumber);
  await next();
});

// ---------------------------------------------------------------------------
// GET /admin/users — list all allowed users
// ---------------------------------------------------------------------------
app.get("/admin/users", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const users = await db.select().from(allowedUsersTable);
  return c.json(users);
});

// ---------------------------------------------------------------------------
// POST /admin/users — add an allowed user
// ---------------------------------------------------------------------------
app.post("/admin/users", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const body = await c.req.json<{
    phone?: string;
    role?: string;
  }>();

  const phone = body.phone?.trim();
  if (!phone || !/^\d{10,15}$/.test(phone)) {
    return c.json({ error: "Invalid phone number" }, 400);
  }

  const role = body.role === "super_admin" ? "super_admin" : "user";
  const adminPhone = c.get("adminPhone");

  try {
    const [created] = await db
      .insert(allowedUsersTable)
      .values({
        phoneNumber: phone,
        role,
        addedBy: adminPhone,
      })
      .returning();

    return c.json(created, 201);
  } catch (err: any) {
    if (err?.message?.includes("unique") || err?.code === "23505") {
      return c.json({ error: "Phone number already exists" }, 409);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/users/:phone — remove a user (cannot remove super_admin)
// ---------------------------------------------------------------------------
app.delete("/admin/users/:phone", async (c) => {
  const phone = c.req.param("phone");
  const db = createDb(getDbUrl(c.env));

  const [target] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, phone))
    .limit(1);

  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  if (target.role === "super_admin") {
    return c.json({ error: "Cannot remove a super_admin" }, 403);
  }

  await db
    .delete(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, phone));

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /admin/api-key/regenerate — generate a new API key
// ---------------------------------------------------------------------------
app.post("/admin/api-key/regenerate", async (c) => {
  const db = createDb(getDbUrl(c.env));

  const { raw, hash, prefix } = await generateApiKey();

  // Delete existing keys
  await db.delete(apiKeysTable);

  // Insert new key
  await db.insert(apiKeysTable).values({
    key: hash,
    keyPrefix: prefix,
    name: "Default",
  });

  // Return the raw key once — it cannot be retrieved again
  return c.json({ newKey: raw, keyPrefix: prefix });
});

// ---------------------------------------------------------------------------
// IP Allowlist CRUD
// ---------------------------------------------------------------------------

// GET /admin/ip-allowlist
app.get("/admin/ip-allowlist", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const list = await db.select().from(ipAllowlistTable);
  return c.json(list);
});

// POST /admin/ip-allowlist
app.post("/admin/ip-allowlist", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const body = await c.req.json<{
    ip?: string;
    label?: string;
    enabled?: boolean;
  }>();

  const ip = body.ip?.trim();
  if (!ip) {
    return c.json({ error: "IP address is required" }, 400);
  }

  const adminPhone = c.get("adminPhone");

  try {
    const [created] = await db
      .insert(ipAllowlistTable)
      .values({
        ip,
        label: body.label ?? null,
        enabled: body.enabled !== false,
        addedBy: adminPhone,
      })
      .returning();

    return c.json(created, 201);
  } catch (err: any) {
    if (err?.message?.includes("unique") || err?.code === "23505") {
      return c.json({ error: "IP already in allowlist" }, 409);
    }
    throw err;
  }
});

// PATCH /admin/ip-allowlist/:id
app.patch("/admin/ip-allowlist/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const db = createDb(getDbUrl(c.env));
  const body = await c.req.json<{
    ip?: string;
    label?: string;
    enabled?: boolean;
  }>();

  const updates: Record<string, unknown> = {};
  if (body.ip !== undefined) updates.ip = body.ip.trim();
  if (body.label !== undefined) updates.label = body.label;
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const [updated] = await db
    .update(ipAllowlistTable)
    .set(updates)
    .where(eq(ipAllowlistTable.id, id))
    .returning();

  if (!updated) {
    return c.json({ error: "Entry not found" }, 404);
  }

  return c.json(updated);
});

// DELETE /admin/ip-allowlist/:id
app.delete("/admin/ip-allowlist/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const db = createDb(getDbUrl(c.env));

  const [deleted] = await db
    .delete(ipAllowlistTable)
    .where(eq(ipAllowlistTable.id, id))
    .returning();

  if (!deleted) {
    return c.json({ error: "Entry not found" }, 404);
  }

  return c.json({ ok: true });
});

export default app;
