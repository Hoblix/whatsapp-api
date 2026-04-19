import { Hono } from "hono";
import { eq, desc, sql, and, gte, or, notInArray } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import {
  conversationsTable,
  messagesTable,
  apiKeysTable,
  allowedUsersTable,
} from "../lib/schema";

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// GET /conversations — list all, ordered by lastMessageAt desc
// ---------------------------------------------------------------------------
app.get("/conversations", async (c) => {
  const db = createDb(getDbUrl(c.env));

  const conversations = await db
    .select()
    .from(conversationsTable)
    .orderBy(desc(conversationsTable.lastMessageAt));

  return c.json(conversations);
});

// ---------------------------------------------------------------------------
// GET /conversations/:phoneNumber — get messages for a conversation
// ---------------------------------------------------------------------------
app.get("/conversations/:phoneNumber", async (c) => {
  const phoneNumber = c.req.param("phoneNumber");
  const db = createDb(getDbUrl(c.env));

  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, phoneNumber))
    .limit(1);

  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  // Fetch messages
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversation.id))
    .orderBy(messagesTable.timestamp);

  // Zero unread count
  await db
    .update(conversationsTable)
    .set({ unreadCount: 0 })
    .where(eq(conversationsTable.id, conversation.id));

  // Return flat messages array (matches original Express API contract)
  return c.json(messages);
});

// ---------------------------------------------------------------------------
// PATCH /conversations/:phoneNumber/read — zero unread count
// ---------------------------------------------------------------------------
app.patch("/conversations/:phoneNumber/read", async (c) => {
  const phoneNumber = c.req.param("phoneNumber");
  const db = createDb(getDbUrl(c.env));

  await db
    .update(conversationsTable)
    .set({ unreadCount: 0 })
    .where(eq(conversationsTable.phoneNumber, phoneNumber));

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// PATCH /conversations/:phoneNumber — update contact details
// ---------------------------------------------------------------------------
app.patch("/conversations/:phoneNumber", async (c) => {
  const phoneNumber = c.req.param("phoneNumber");
  const db = createDb(getDbUrl(c.env));
  const body = await c.req.json<{
    contactName?: string;
    email?: string;
    notes?: string;
    tags?: string;
  }>();

  const updates: Record<string, unknown> = {};
  if (body.contactName !== undefined) updates.contactName = body.contactName;
  if (body.email !== undefined) updates.email = body.email;
  if (body.notes !== undefined) updates.notes = body.notes;
  if (body.tags !== undefined) updates.tags = body.tags;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const [updated] = await db
    .update(conversationsTable)
    .set(updates)
    .where(eq(conversationsTable.phoneNumber, phoneNumber))
    .returning();

  if (!updated) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json(updated);
});

// ---------------------------------------------------------------------------
// GET /stats — dashboard statistics
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  const db = createDb(getDbUrl(c.env));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [totalResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messagesTable);

  const [todayResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messagesTable)
    .where(gte(messagesTable.timestamp, todayStart));

  const [inboundResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messagesTable)
    .where(eq(messagesTable.direction, "inbound"));

  const [outboundResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messagesTable)
    .where(eq(messagesTable.direction, "outbound"));

  return c.json({
    totalMessages: totalResult?.count ?? 0,
    todayMessages: todayResult?.count ?? 0,
    inboundMessages: inboundResult?.count ?? 0,
    outboundMessages: outboundResult?.count ?? 0,
  });
});

// ---------------------------------------------------------------------------
// GET /history — filterable message log
// ---------------------------------------------------------------------------
app.get("/history", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const from = c.req.query("from");
  const to = c.req.query("to");
  const phoneNumber = c.req.query("phoneNumber");

  const conditions = [];

  if (from) {
    conditions.push(gte(messagesTable.timestamp, new Date(from)));
  }
  if (to) {
    conditions.push(
      sql`${messagesTable.timestamp} <= ${new Date(to)}`
    );
  }
  if (phoneNumber) {
    // Find conversation by phone, then filter messages
    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.phoneNumber, phoneNumber))
      .limit(1);

    if (!conv) {
      return c.json([]);
    }
    conditions.push(eq(messagesTable.conversationId, conv.id));
  }

  const messages = await db
    .select()
    .from(messagesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(messagesTable.timestamp))
    .limit(500);

  return c.json(messages);
});

// ---------------------------------------------------------------------------
// GET /messages/:waMessageId/status — message delivery status
// ---------------------------------------------------------------------------
app.get("/messages/:waMessageId/status", async (c) => {
  const waMessageId = c.req.param("waMessageId");
  const db = createDb(getDbUrl(c.env));

  const [message] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.waMessageId, waMessageId))
    .limit(1);

  if (!message) {
    return c.json({ error: "Message not found" }, 404);
  }

  return c.json({ waMessageId: message.waMessageId, status: message.status });
});

// ---------------------------------------------------------------------------
// GET /api-key — return key prefix only
// ---------------------------------------------------------------------------
app.get("/api-key", async (c) => {
  const db = createDb(getDbUrl(c.env));

  const [row] = await db
    .select()
    .from(apiKeysTable)
    .limit(1);

  if (!row) {
    return c.json({ error: "No API key found" }, 404);
  }

  return c.json({
    keyPrefix: row.keyPrefix ?? "wad_",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  });
});

export default app;
