/**
 * Scans Notion leads DB for rows where Call Status is one of the "missed" statuses
 * and sends the `callback_missed` WhatsApp template to each (deduped).
 *
 * Triggered by cron (see wrangler.toml) — idempotent via `missed_call_notifications`
 * table which prevents duplicate sends for the same (page, status) combo.
 */

import { eq, and } from "drizzle-orm";
import type { Env } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import {
  flowIntegrationsTable,
  flowIntegrationMappingsTable,
  flowDefinitionsTable,
  missedCallNotificationsTable,
} from "../lib/schema";
import { META_GRAPH_API_VERSION } from "../env";

// Statuses that should trigger a "we missed you" template send.
// Extend as needed.
const TRIGGER_STATUSES = [
  "Not Reachable 1",
  "Not Reachable 2",
  "Not Reachable 3",
  "Not Answered 1",
  "Not Answered 2",
  "Not Answered 3",
  "Disconnected",
];

async function notionFetch(token: string, path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// Extract a value from a Notion property object (select, status, title, rich_text, date, phone_number, etc.)
function extractPropertyValue(prop: any): string {
  if (!prop) return "";
  if (prop.select?.name) return prop.select.name;
  if (prop.status?.name) return prop.status.name;
  if (Array.isArray(prop.title)) return prop.title.map((t: any) => t.plain_text ?? "").join("");
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((t: any) => t.plain_text ?? "").join("");
  if (prop.date?.start) return prop.date.start;
  if (prop.phone_number) return prop.phone_number;
  if (typeof prop.formula?.string === "string") return prop.formula.string;
  return "";
}

function formatDateLong(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", {
      day: "numeric", month: "long", year: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Process a SINGLE Notion page — used by the webhook endpoint.
 * Called when Notion tells us "this page's status changed".
 */
export async function notifyForSinglePage(
  env: Env,
  pageId: string,
): Promise<{ ok: boolean; sent: boolean; reason?: string; waMessageId?: string }> {
  const db = createDb(getDbUrl(env));
  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;

  const [leadFlow] = await db
    .select().from(flowDefinitionsTable)
    .where(eq(flowDefinitionsTable.slug, "hoblix-lead-capture")).limit(1);
  if (!leadFlow) return { ok: false, sent: false, reason: "lead-capture flow missing" };

  const [integration] = await db
    .select().from(flowIntegrationsTable)
    .where(and(eq(flowIntegrationsTable.flowId, leadFlow.id), eq(flowIntegrationsTable.type, "notion"), eq(flowIntegrationsTable.isActive, true)))
    .limit(1);
  if (!integration) return { ok: false, sent: false, reason: "no notion integration" };

  const cfg = integration.config as { notionToken?: string; databaseId?: string };
  if (!cfg.notionToken) return { ok: false, sent: false, reason: "no notion token" };

  // Fetch the page
  const pageRes = await notionFetch(cfg.notionToken, `/pages/${pageId}`);
  if (!pageRes.ok) return { ok: false, sent: false, reason: `notion fetch failed: ${pageRes.status}` };

  const props = pageRes.data.properties ?? {};
  const status = extractPropertyValue(props["Call Status"]);
  if (!TRIGGER_STATUSES.includes(status)) {
    return { ok: true, sent: false, reason: `status "${status}" not a trigger` };
  }

  // Dedupe
  const [existing] = await db
    .select().from(missedCallNotificationsTable)
    .where(and(eq(missedCallNotificationsTable.notionPageId, pageId), eq(missedCallNotificationsTable.triggerStatus, status)))
    .limit(1);
  if (existing) return { ok: true, sent: false, reason: "already sent for this status" };

  const phoneRaw = extractPropertyValue(props["Mobile"]) || extractPropertyValue(props["Phone"]);
  const name = extractPropertyValue(props["Customer Name"]) || "there";
  const scheduleDate = extractPropertyValue(props["Call Schedule Date"]);
  const timeSlot = extractPropertyValue(props["Time Slot"]);
  const spaceType = extractPropertyValue(props["Space Type"]);

  if (!phoneRaw) return { ok: false, sent: false, reason: "no phone on page" };

  const cleanPhone = phoneRaw.replace(/\D/g, "");
  const e164Phone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

  const res = await fetch(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: e164Phone,
        type: "template",
        template: {
          name: "callback_missed",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: name || "there" },
                { type: "text", text: formatDateLong(scheduleDate) || "your scheduled time" },
                { type: "text", text: timeSlot || "your scheduled slot" },
                { type: "text", text: spaceType || "your enquiry" },
              ],
            },
            {
              type: "button",
              sub_type: "flow",
              index: "1",
              parameters: [{ type: "action", action: { flow_token: JSON.stringify({ wa_id: e164Phone, ref: `missed-${status}` }) } }],
            },
          ],
        },
      }),
    },
  );
  const sendData = await res.json() as any;

  if (!res.ok) {
    return { ok: false, sent: false, reason: `Meta API error: ${JSON.stringify(sendData?.error ?? sendData)}` };
  }

  const waMessageId = sendData?.messages?.[0]?.id ?? null;
  await db.insert(missedCallNotificationsTable).values({
    notionPageId: pageId,
    triggerStatus: status,
    phoneNumber: e164Phone,
    waMessageId,
  });

  return { ok: true, sent: true, waMessageId };
}

export async function runMissedCallNotifier(env: Env): Promise<{ checked: number; sent: number; skipped: number; errors: number }> {
  const db = createDb(getDbUrl(env));
  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;

  // Find the lead-capture flow's Notion integration (same one we upsert to on reschedule)
  const [leadFlow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(eq(flowDefinitionsTable.slug, "hoblix-lead-capture"))
    .limit(1);

  if (!leadFlow) {
    console.warn("[missedCallNotifier] No lead-capture flow found");
    return { checked: 0, sent: 0, skipped: 0, errors: 0 };
  }

  const [integration] = await db
    .select()
    .from(flowIntegrationsTable)
    .where(and(eq(flowIntegrationsTable.flowId, leadFlow.id), eq(flowIntegrationsTable.type, "notion"), eq(flowIntegrationsTable.isActive, true)))
    .limit(1);

  if (!integration) {
    console.warn("[missedCallNotifier] No active Notion integration for lead-capture");
    return { checked: 0, sent: 0, skipped: 0, errors: 0 };
  }

  const cfg = integration.config as { notionToken?: string; databaseId?: string };
  if (!cfg.notionToken || !cfg.databaseId) {
    console.warn("[missedCallNotifier] Notion integration missing token/databaseId");
    return { checked: 0, sent: 0, skipped: 0, errors: 0 };
  }

  // Query Notion for rows matching any trigger status
  const queryRes = await notionFetch(cfg.notionToken, `/databases/${cfg.databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        or: TRIGGER_STATUSES.map((s) => ({
          property: "Call Status",
          status: { equals: s },
        })),
      },
      page_size: 100,
    }),
  });

  if (!queryRes.ok) {
    console.error("[missedCallNotifier] Notion query failed:", queryRes.data);
    return { checked: 0, sent: 0, skipped: 0, errors: 1 };
  }

  const pages: any[] = queryRes.data.results ?? [];
  let sent = 0, skipped = 0, errors = 0;

  for (const page of pages) {
    const pageId = page.id;
    const props = page.properties ?? {};
    const status = extractPropertyValue(props["Call Status"]);
    if (!TRIGGER_STATUSES.includes(status)) continue;

    // Check dedupe — have we already sent this (page, status) combo?
    const [existing] = await db
      .select()
      .from(missedCallNotificationsTable)
      .where(
        and(
          eq(missedCallNotificationsTable.notionPageId, pageId),
          eq(missedCallNotificationsTable.triggerStatus, status),
        ),
      )
      .limit(1);

    if (existing) {
      skipped++;
      continue;
    }

    const phoneRaw = extractPropertyValue(props["Mobile"]) || extractPropertyValue(props["Phone"]);
    const name = extractPropertyValue(props["Customer Name"]) || "there";
    const scheduleDate = extractPropertyValue(props["Call Schedule Date"]);
    const timeSlot = extractPropertyValue(props["Time Slot"]);
    const spaceType = extractPropertyValue(props["Space Type"]);

    if (!phoneRaw) {
      console.warn(`[missedCallNotifier] Page ${pageId} (${status}) has no phone — skipping`);
      skipped++;
      continue;
    }

    const cleanPhone = phoneRaw.replace(/\D/g, "");
    const e164Phone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

    // Send the callback_missed template
    try {
      const templatePayload = {
        messaging_product: "whatsapp",
        to: e164Phone,
        type: "template",
        template: {
          name: "callback_missed",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: name || "there" },
                { type: "text", text: formatDateLong(scheduleDate) || "your scheduled time" },
                { type: "text", text: timeSlot || "your scheduled slot" },
                { type: "text", text: spaceType || "your enquiry" },
              ],
            },
            // Flow button — encode phone in flow_token for reschedule handler
            {
              type: "button",
              sub_type: "flow",
              index: "1",
              parameters: [
                {
                  type: "action",
                  action: { flow_token: JSON.stringify({ wa_id: e164Phone, ref: `missed-${status}` }) },
                },
              ],
            },
          ],
        },
      };

      const res = await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(templatePayload),
        },
      );
      const sendData = await res.json() as any;

      if (!res.ok) {
        console.error(`[missedCallNotifier] Send failed for ${e164Phone} (${status}): ${JSON.stringify(sendData)}`);
        errors++;
        continue;
      }

      const waMessageId = sendData?.messages?.[0]?.id ?? null;

      // Log to dedupe table
      await db.insert(missedCallNotificationsTable).values({
        notionPageId: pageId,
        triggerStatus: status,
        phoneNumber: e164Phone,
        waMessageId,
      });

      console.log(`[missedCallNotifier] Sent callback_missed to ${e164Phone} (status=${status}, msgId=${waMessageId})`);
      sent++;
    } catch (e: any) {
      console.error(`[missedCallNotifier] Error for ${e164Phone} (${status}):`, e.message);
      errors++;
    }
  }

  return { checked: pages.length, sent, skipped, errors };
}
