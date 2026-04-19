import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import { conversationsTable, messagesTable, allowedUsersTable } from "../lib/schema";
import { eq, sql } from "drizzle-orm";
import { sendPushToAll } from "./notifications";
import { fireCTWARules } from "./ctwa";
import { fireAutomationWorkflows, resumeWaitingExecutions } from "./automationEngine";
import { consumePendingSummary } from "./flowEndpoint";

const app = new Hono<HonoEnv>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function arrayBufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function verifySignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = "sha256=" + arrayBufferToHex(sig);
  // Constant-time comparison
  if (expected.length !== signatureHeader.length) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(signatureHeader);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// ── GET /webhook — Meta hub challenge verification ───────────────────────────

app.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === c.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[webhook] Verified successfully");
    return c.text(challenge ?? "", 200);
  }
  return c.text("Forbidden", 403);
});

// ── POST /webhook — receive inbound messages + status updates ────────────────

app.post("/webhook", async (c) => {
  const appSecret = c.env.WHATSAPP_APP_SECRET;

  // Read body as arrayBuffer FIRST for signature verification
  const rawBody = await c.req.arrayBuffer();

  // Verify HMAC signature
  const signatureHeader = c.req.header("x-hub-signature-256") ?? null;
  if (appSecret) {
    const valid = await verifySignature(rawBody, signatureHeader, appSecret);
    if (!valid) {
      console.warn("[webhook] Invalid signature");
      return c.text("Invalid signature", 403);
    }
  }

  // Parse JSON from raw body
  const body = JSON.parse(new TextDecoder().decode(rawBody));

  const db = createDb(getDbUrl(c.env));

  // Helper to broadcast events to all connected dashboard WebSocket clients
  const broadcast = async (event: any) => {
    try {
      const id = c.env.WEBHOOK_HUB.idFromName("default");
      const stub = c.env.WEBHOOK_HUB.get(id);
      await stub.fetch("https://internal/broadcast", {
        method: "POST",
        body: JSON.stringify(event),
      });
    } catch (e) {
      console.error("[webhook] broadcast failed:", e);
    }
  };

  try {
    const entries = body?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        if (change.field !== "messages") continue;
        const value = change.value;

        // ── Status updates ─────────────────────────────────────────────
        const statuses = value?.statuses ?? [];
        for (const status of statuses) {
          if (status.id) {
            if (status.status === "failed" && status.errors) {
              console.error(`[webhook] Meta delivery FAILED for ${status.id}:`, JSON.stringify(status.errors));
            }
            await db
              .update(messagesTable)
              .set({ status: status.status, rawPayload: status })
              .where(eq(messagesTable.waMessageId, status.id));
            // Push event to dashboard
            c.executionCtx.waitUntil(broadcast({
              type: "message_status",
              waMessageId: status.id,
              status: status.status,
              recipientId: status.recipient_id,
            }));
          }
        }

        // ── Inbound messages ───────────────────────────────────────────
        const messages = value?.messages ?? [];
        const contacts = value?.contacts ?? [];

        for (const msg of messages) {
          const phone = msg.from;
          const contactName = contacts?.[0]?.profile?.name ?? null;

          // Upsert conversation
          let conversation = await db.query.conversationsTable.findFirst({
            where: eq(conversationsTable.phoneNumber, phone),
          });

          // Ad referral data from CTWA
          const referral = msg.referral ?? null;

          // Detect source platform from referral URL
          const detectPlatform = (url?: string): string | null => {
            if (!url) return null;
            if (url.includes("instagram.com") || url.includes("ig.me")) return "instagram";
            if (url.includes("facebook.com") || url.includes("fb.me") || url.includes("fb.com")) return "facebook";
            if (url.includes("google.com") || url.includes("goo.gl")) return "google";
            return "other";
          };

          const sourceType = referral ? "ad" : "organic";
          const sourcePlatform = referral ? detectPlatform(referral.source_url as string) : null;
          const campaignName = referral ? ((referral.headline as string) ?? null) : null;

          const isNewConversation = !conversation;
          if (!conversation) {
            const [row] = await db
              .insert(conversationsTable)
              .values({
                phoneNumber: phone,
                contactName,
                lastMessageAt: new Date(),
                unreadCount: 1,
                sourceType,
                sourcePlatform,
                campaignName,
                ...(referral
                  ? {
                      adReferral: referral,
                      adSource: referral.source_url ?? referral.headline ?? "ad",
                    }
                  : {}),
              })
              .returning();
            conversation = row;
          } else {
            const updateData: any = {
              lastMessageAt: new Date(),
              unreadCount: sql`${conversationsTable.unreadCount} + 1`,
            };
            if (contactName && !conversation.contactName) {
              updateData.contactName = contactName;
            }
            if (referral) {
              updateData.adReferral = referral;
              updateData.adSource = referral.source_url ?? referral.headline ?? "ad";
            }
            await db
              .update(conversationsTable)
              .set(updateData)
              .where(eq(conversationsTable.id, conversation.id));
          }

          // Parse message content
          const parsed = await parseMessage(msg, getDbUrl(c.env));

          // Update conversation lastMessage
          await db
            .update(conversationsTable)
            .set({ lastMessage: parsed.body ?? `[${parsed.type}]` })
            .where(eq(conversationsTable.id, conversation.id));

          // Insert message record
          await db.insert(messagesTable).values({
            conversationId: conversation.id,
            waMessageId: msg.id,
            direction: "inbound",
            messageType: parsed.type as any,
            body: parsed.body,
            mediaUrl: parsed.mediaUrl ?? undefined,
            status: "received",
            timestamp: new Date(parseInt(msg.timestamp) * 1000),
            rawPayload: msg,
          });

          // Push inbound event to dashboard
          c.executionCtx.waitUntil(broadcast({
            type: "inbound_message",
            phoneNumber: phone,
            conversationId: conversation.id,
            messageType: parsed.type,
            body: parsed.body,
            isNewConversation,
          }));

          // Fire CTWA rules if referral present
          if (referral) {
            try {
              await fireCTWARules(db, phone, conversation.id, referral, c.env.WHATSAPP_ACCESS_TOKEN, c.env.WHATSAPP_PHONE_NUMBER_ID);
            } catch (err) {
              console.error("[webhook] CTWA rule error:", err);
            }
          }

          // Fire automation workflows (must use waitUntil to survive after response)
          c.executionCtx.waitUntil(
            fireAutomationWorkflows(db, phone, conversation.id, msg, referral ?? null, c.env, c.executionCtx, isNewConversation)
              .catch((err) => console.error("[webhook] Automation error:", err))
          );

          // Resume waiting executions when flow response arrives (interactive/nfm_reply)
          if (msg.type === "interactive" && msg.interactive?.type === "nfm_reply") {
            c.executionCtx.waitUntil(
              resumeWaitingExecutions(db, phone, msg, c.env, c.executionCtx)
                .catch((err) => console.error("[webhook] Resume automation error:", err))
            );
          }

          // Send push notification
          try {
            const pushPayload = {
              title: contactName ?? phone,
              body: parsed.body ?? `[${parsed.type}]`,
              data: { phone, conversationId: conversation.id },
            };
            await sendPushToAll(
              db,
              pushPayload,
              c.env.VAPID_PUBLIC_KEY,
              c.env.VAPID_PRIVATE_KEY,
              c.env.VAPID_SUBJECT,
            );
          } catch (err) {
            console.error("[webhook] Push notification error:", err);
          }
        }
      }
    }
  } catch (err) {
    console.error("[webhook] Processing error:", err);
  }

  // Always return 200 to acknowledge receipt
  return c.text("OK", 200);
});

// ── Message parser ───────────────────────────────────────────────────────────

interface ParsedMessage {
  type: string;
  body: string | null;
  mediaUrl?: string;
}

async function parseMessage(msg: any, dbUrl?: string): Promise<ParsedMessage> {
  const type = msg.type ?? "unsupported";

  switch (type) {
    case "text":
      return { type: "text", body: msg.text?.body ?? null };

    case "image":
      return {
        type: "image",
        body: msg.image?.caption ?? "[image]",
        mediaUrl: msg.image?.id,
      };

    case "audio":
      return { type: "audio", body: "[audio]", mediaUrl: msg.audio?.id };

    case "video":
      return {
        type: "video",
        body: msg.video?.caption ?? "[video]",
        mediaUrl: msg.video?.id,
      };

    case "document":
      return {
        type: "document",
        body: msg.document?.caption ?? msg.document?.filename ?? "[document]",
        mediaUrl: msg.document?.id,
      };

    case "location":
      return {
        type: "location",
        body: `[location: ${msg.location?.latitude},${msg.location?.longitude}]`,
      };

    case "reaction":
      return {
        type: "reaction",
        body: msg.reaction?.emoji ?? "[reaction]",
      };

    case "interactive": {
      const interactive = msg.interactive;
      const interactiveType = interactive?.type;

      if (interactiveType === "nfm_reply") {
        // Flow response — check DB-backed pending summaries first, then in-memory
        const phoneNumber = msg.from as string;
        let summary: string | null = null;

        // 1. Check DB (works across isolates)
        if (phoneNumber && dbUrl) {
          summary = await consumePendingSummary(dbUrl, phoneNumber);
        }

        // 2. Fallback: parse response_json
        if (!summary) {
          const responseJson = interactive?.nfm_reply?.response_json;
          if (responseJson) {
            try {
              const parsed = JSON.parse(responseJson);
              const keys = Object.keys(parsed).filter((k) => k !== "flow_token");
              if (keys.length > 0) {
                summary = keys.map((k: string) => `${k}: ${parsed[k]}`).join(", ");
              }
            } catch {
              // keep null
            }
          }
        }

        return { type: "text", body: summary || "📋 Form submitted" };
      }

      if (interactiveType === "button_reply") {
        return {
          type: "text",
          body: interactive?.button_reply?.title ?? "[button reply]",
        };
      }

      if (interactiveType === "list_reply") {
        return {
          type: "text",
          body: interactive?.list_reply?.title ?? "[list reply]",
        };
      }

      return { type: "text", body: "[interactive]" };
    }

    default:
      return { type: "unsupported", body: `[${type}]` };
  }
}

export default app;
