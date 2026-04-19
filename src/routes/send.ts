import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { META_GRAPH_API_VERSION } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import { conversationsTable, messagesTable, templateMediaTable, callbackBookingsTable } from "../lib/schema";
import { eq } from "drizzle-orm";
import { callWhatsAppAPI } from "./sendHelpers";

const app = new Hono<HonoEnv>();

// ── Validation helpers ───────────────────────────────────────────────────────

function validatePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

/** Extract phone from body — accepts either `phoneNumber` or `phone` field */
function extractPhone(body: any): string {
  return body?.phoneNumber ?? body?.phone ?? "";
}

function validateLength(value: string, max: number): boolean {
  return value.length <= max;
}

// ── Helper: log outbound message ─────────────────────────────────────────────

async function logOutbound(
  db: ReturnType<typeof createDb>,
  phone: string,
  type: string,
  body: string | null,
  waMessageId: string | null,
) {
  // Upsert conversation
  const existing = await db.query.conversationsTable.findFirst({
    where: eq(conversationsTable.phoneNumber, phone),
  });

  let conversationId: number;
  if (existing) {
    conversationId = existing.id;
    await db
      .update(conversationsTable)
      .set({ lastMessage: body ?? `[${type}]`, lastMessageAt: new Date() })
      .where(eq(conversationsTable.id, existing.id));
  } else {
    const [row] = await db
      .insert(conversationsTable)
      .values({
        phoneNumber: phone,
        lastMessage: body ?? `[${type}]`,
        lastMessageAt: new Date(),
      })
      .returning({ id: conversationsTable.id });
    conversationId = row.id;
  }

  await db.insert(messagesTable).values({
    conversationId,
    waMessageId: waMessageId ?? undefined,
    direction: "outbound",
    messageType: type as any,
    body: body ?? `[${type}]`,
    status: "sent",
    timestamp: new Date(),
  });
}

// ── POST /send/text ──────────────────────────────────────────────────────────

app.post("/send/text", async (c) => {
  const body = await c.req.json();
  const cleanPhone = validatePhone(extractPhone(body));
  const text = body.text;
  if (!cleanPhone) return c.json({ error: "Invalid phone number (7-15 digits required)" }, 400);
  if (!text || !validateLength(text, 4096)) {
    return c.json({ error: "Text is required and must be at most 4096 characters" }, 400);
  }

  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;

  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: "text",
    text: { body: text },
  };

  try {
    const result = await callWhatsAppAPI(payload, accessToken, phoneNumberId);
    const waMessageId = result?.messages?.[0]?.id ?? null;
    const db = createDb(getDbUrl(c.env));
    await logOutbound(db, cleanPhone, "text", text, waMessageId);
    return c.json({ success: true, messageId: waMessageId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /send/media ─────────────────────────────────────────────────────────

app.post("/send/media", async (c) => {
  const body = await c.req.json();
  const cleanPhone = validatePhone(extractPhone(body));
  const { mediaType, mediaUrl, caption } = body;
  if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);
  if (!mediaType || !mediaUrl) return c.json({ error: "mediaType and mediaUrl are required" }, 400);

  const validTypes = ["image", "video", "audio", "document", "sticker"];
  if (!validTypes.includes(mediaType)) {
    return c.json({ error: `mediaType must be one of: ${validTypes.join(", ")}` }, 400);
  }

  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;

  const mediaPayload: any = { link: mediaUrl };
  if (caption && ["image", "video", "document"].includes(mediaType)) {
    mediaPayload.caption = caption;
  }

  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: mediaType,
    [mediaType]: mediaPayload,
  };

  try {
    const result = await callWhatsAppAPI(payload, accessToken, phoneNumberId);
    const waMessageId = result?.messages?.[0]?.id ?? null;
    const db = createDb(getDbUrl(c.env));
    await logOutbound(db, cleanPhone, mediaType, caption ?? null, waMessageId);
    return c.json({ success: true, messageId: waMessageId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /send/template ──────────────────────────────────────────────────────

app.post("/send/template", async (c) => {
  const body = await c.req.json();
  const cleanPhone = validatePhone(extractPhone(body));
  const { templateName, languageCode, components } = body;
  if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);
  if (!templateName) return c.json({ error: "templateName is required" }, 400);

  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;
  const db = createDb(getDbUrl(c.env));

  // For media headers, use the stored source URL directly as `link`.
  // Meta will fetch and deliver it. Requires proper content-type and size limits.
  let resolvedComponents = components;

  // Auto-inject the recipient's phone into any FLOW button's flow_token as JSON.
  // Without this, our flow endpoint can't identify the user (Meta doesn't send wa_phone
  // in flow requests). The handler reads wa_id from the JSON-encoded flow_token.
  if (Array.isArray(resolvedComponents)) {
    resolvedComponents = resolvedComponents.map((comp: any) => {
      if (comp?.type !== "button" || comp?.sub_type !== "flow") return comp;
      const params = comp.parameters;
      if (!Array.isArray(params) || params.length === 0) return comp;
      return {
        ...comp,
        parameters: params.map((p: any) => {
          if (p?.type !== "action" || !p?.action) return p;
          const originalToken = p.action.flow_token ?? "";
          // Wrap in JSON with wa_id so our flow endpoint can identify the user
          const wrapped = JSON.stringify({ wa_id: cleanPhone, ref: String(originalToken) });
          return { ...p, action: { ...p.action, flow_token: wrapped } };
        }),
      };
    });
  }

  // DEBUG: log the components being sent
  if (Array.isArray(components)) {
    for (const comp of components) {
      if (comp?.type === "header" && comp.parameters?.[0]) {
        const p = comp.parameters[0];
        const link = p[p.type]?.link;
        console.log(`[send/template] ${templateName} → ${cleanPhone} | header link: ${link}`);
      }
    }
  }

  const template: any = {
    name: templateName,
    language: { code: languageCode ?? "en" },
  };
  if (resolvedComponents) template.components = resolvedComponents;

  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: "template",
    template,
  };

  try {
    const result = await callWhatsAppAPI(payload, accessToken, phoneNumberId);
    const waMessageId = result?.messages?.[0]?.id ?? null;
    await logOutbound(db, cleanPhone, "text", `[template: ${templateName}]`, waMessageId);
    return c.json({ success: true, messageId: waMessageId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── GET /send/booking-context/:phone ─────────────────────────────────────────
// Returns name / phone / booked date / slot label for pre-filling template params.

app.get("/send/booking-context/:phone", async (c) => {
  const phone = c.req.param("phone").replace(/\D/g, "");
  if (!phone) return c.json({ error: "phone required" }, 400);

  const db = createDb(getDbUrl(c.env));

  // Try canonical 12-digit first, then fallback to last 10 digits
  const variants = [phone, phone.length === 10 ? `91${phone}` : phone, phone.slice(-10)];

  let conv: any = null;
  let booking: any = null;
  for (const v of variants) {
    if (!conv) {
      const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.phoneNumber, v)).limit(1);
      if (row) conv = row;
    }
    if (!booking) {
      const [row] = await db.select().from(callbackBookingsTable).where(eq(callbackBookingsTable.phoneNumber, v)).limit(1);
      if (row) booking = row;
    }
    if (conv && booking) break;
  }

  return c.json({
    name: conv?.contactName ?? booking?.name ?? null,
    phoneNumber: conv?.phoneNumber ?? phone,
    bookedDate: booking?.bookedDate ?? null,
    bookedSlot: booking?.bookedSlot ?? null,
    bookedSlotLabel: booking?.bookedSlotLabel ?? null,
    bookedDateFormatted: booking?.bookedDate
      ? new Date(booking.bookedDate + "T00:00:00Z").toLocaleDateString("en-IN", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : null,
  });
});

// ── POST /send/template-auto ─────────────────────────────────────────────────
// Auto-builds body params and media header from booking/conversation data.
// Intended for cron/reminder jobs — caller only needs phoneNumber + templateName.

app.post("/send/template-auto", async (c) => {
  const body = await c.req.json<{ phoneNumber: string; templateName: string; languageCode?: string }>();
  const cleanPhone = validatePhone(body.phoneNumber);
  if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);
  if (!body.templateName) return c.json({ error: "templateName required" }, 400);

  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;
  const db = createDb(getDbUrl(c.env));

  // Look up context (booking + conversation)
  const variants = [cleanPhone, cleanPhone.slice(-10)];
  let conv: any = null;
  let booking: any = null;
  for (const v of variants) {
    if (!conv) {
      const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.phoneNumber, v)).limit(1);
      if (row) conv = row;
    }
    if (!booking) {
      const [row] = await db.select().from(callbackBookingsTable).where(eq(callbackBookingsTable.phoneNumber, v)).limit(1);
      if (row) booking = row;
    }
  }

  const name = conv?.contactName ?? booking?.name ?? "there";
  const dateFormatted = booking?.bookedDate
    ? new Date(booking.bookedDate + "T00:00:00Z").toLocaleDateString("en-IN", {
        day: "numeric", month: "long", year: "numeric",
      })
    : "";
  const slotLabel = booking?.bookedSlotLabel ?? "";

  // Build body parameters in the order templates expect: {{1}} name, {{2}} date, {{3}} slot, {{4}} phone
  const bodyParams = [
    { type: "text", text: String(name) },
    { type: "text", text: String(dateFormatted) },
    { type: "text", text: String(slotLabel) },
    { type: "text", text: `+${cleanPhone}` },
  ];

  const components: any[] = [{ type: "body", parameters: bodyParams }];

  // If template has a stored media URL, add header
  const [media] = await db.select().from(templateMediaTable).where(eq(templateMediaTable.templateName, body.templateName)).limit(1);
  if (media?.mediaUrl) {
    const mediaType = media.mediaType.toLowerCase();
    components.unshift({
      type: "header",
      parameters: [{ type: mediaType, [mediaType]: { link: media.mediaUrl } }],
    });
  }

  const template: any = {
    name: body.templateName,
    language: { code: body.languageCode ?? "en" },
    components,
  };

  try {
    const result = await callWhatsAppAPI({
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "template",
      template,
    }, accessToken, phoneNumberId);
    const waMessageId = result?.messages?.[0]?.id ?? null;
    await logOutbound(db, cleanPhone, "text", `[template: ${body.templateName}]`, waMessageId);
    return c.json({
      success: true,
      messageId: waMessageId,
      resolvedParams: { name, date: dateFormatted, slot: slotLabel, phone: cleanPhone },
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Upload source URL to Meta's phone-scoped /media API and return media_id.
// Caches media_id in template_media table for ~25 days (Meta's 30-day TTL minus safety buffer).
async function getOrUploadMetaMedia(opts: {
  db: ReturnType<typeof createDb>;
  templateName: string;
  link: string;
  mediaType: string; // "IMAGE" | "VIDEO" | "DOCUMENT"
  accessToken: string;
  phoneNumberId: string;
}): Promise<string | null> {
  const { db, templateName, link, mediaType, accessToken, phoneNumberId } = opts;

  // Check cache first
  const [existing] = await db
    .select()
    .from(templateMediaTable)
    .where(eq(templateMediaTable.templateName, templateName))
    .limit(1);
  if (existing?.metaMediaId && existing.metaMediaIdExpiresAt && existing.metaMediaIdExpiresAt > new Date()) {
    return existing.metaMediaId;
  }

  // Fetch the source
  const fileRes = await fetch(link, {
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  if (!fileRes.ok) throw new Error(`Failed to fetch media: HTTP ${fileRes.status}`);

  let contentType = fileRes.headers.get("content-type") || "";
  // Normalize content-type if the source sent generic binary
  if (contentType === "application/octet-stream" || contentType === "application/binary" || !contentType) {
    contentType = mediaType === "VIDEO" ? "video/mp4"
      : mediaType === "IMAGE" ? "image/jpeg"
      : "application/pdf";
  }

  const bytes = await fileRes.arrayBuffer();
  const fileName = mediaType === "VIDEO" ? "video.mp4"
    : mediaType === "IMAGE" ? "image.jpg"
    : "document.pdf";

  console.log(`[getOrUploadMetaMedia] Fetched ${bytes.byteLength} bytes, content-type=${contentType}, template=${templateName}`);

  if (bytes.byteLength === 0) {
    throw new Error("Source file is empty");
  }

  // Upload to Meta's phone-scoped /media using Blob (not File — Workers handle this better)
  const fileBlob = new Blob([bytes], { type: contentType });
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", contentType);
  form.append("file", fileBlob, fileName);

  const uploadRes = await fetch(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    }
  );
  const uploadData = (await uploadRes.json()) as any;
  if (!uploadRes.ok) {
    console.error(`[getOrUploadMetaMedia] Meta /media failed (${uploadRes.status}):`, JSON.stringify(uploadData));
    throw new Error(uploadData?.error?.message ?? `Meta /media upload failed: ${uploadRes.status}`);
  }
  const mediaId = uploadData.id as string | undefined;
  if (!mediaId) throw new Error("No media_id returned from Meta");

  console.log(`[getOrUploadMetaMedia] Uploaded ${bytes.byteLength} bytes as ${contentType} → media_id=${mediaId} (template=${templateName})`);

  // Cache it — Meta media IDs expire in 30 days; cache for 25 days
  const expiresAt = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
  if (existing) {
    await db
      .update(templateMediaTable)
      .set({ metaMediaId: mediaId, metaMediaIdExpiresAt: expiresAt, updatedAt: new Date() })
      .where(eq(templateMediaTable.templateName, templateName));
  }

  return mediaId;
}

// ── POST /send/interactive ───────────────────────────────────────────────────

app.post("/send/interactive", async (c) => {
  const body = await c.req.json();
  const cleanPhone = validatePhone(extractPhone(body));
  const { interactive } = body;
  if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);
  if (!interactive || !interactive.type) {
    return c.json({ error: "interactive object with type is required" }, 400);
  }

  const validTypes = ["button", "list", "cta_url"];
  if (!validTypes.includes(interactive.type)) {
    return c.json({ error: `interactive.type must be one of: ${validTypes.join(", ")}` }, 400);
  }

  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;

  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: "interactive",
    interactive,
  };

  try {
    const result = await callWhatsAppAPI(payload, accessToken, phoneNumberId);
    const waMessageId = result?.messages?.[0]?.id ?? null;
    const db = createDb(getDbUrl(c.env));
    await logOutbound(db, cleanPhone, "text", `[interactive: ${interactive.type}]`, waMessageId);
    return c.json({ success: true, messageId: waMessageId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /send/reaction ──────────────────────────────────────────────────────

app.post("/send/reaction", async (c) => {
  const body = await c.req.json();
  const cleanPhone = validatePhone(extractPhone(body));
  const { messageId, emoji } = body;
  if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);
  if (!messageId || !emoji) return c.json({ error: "messageId and emoji are required" }, 400);

  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;

  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: "reaction",
    reaction: { message_id: messageId, emoji },
  };

  try {
    const result = await callWhatsAppAPI(payload, accessToken, phoneNumberId);
    return c.json({ success: true, messageId: result?.messages?.[0]?.id ?? null });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /send/location ──────────────────────────────────────────────────────

app.post("/send/location", async (c) => {
  const body = await c.req.json();
  const cleanPhone = validatePhone(extractPhone(body));
  const { latitude, longitude, name, address } = body;
  if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);
  if (latitude == null || longitude == null) {
    return c.json({ error: "latitude and longitude are required" }, 400);
  }

  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;

  const location: any = { latitude, longitude };
  if (name) location.name = name;
  if (address) location.address = address;

  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: "location",
    location,
  };

  try {
    const result = await callWhatsAppAPI(payload, accessToken, phoneNumberId);
    const waMessageId = result?.messages?.[0]?.id ?? null;
    const db = createDb(getDbUrl(c.env));
    await logOutbound(db, cleanPhone, "location", `[location: ${latitude},${longitude}]`, waMessageId);
    return c.json({ success: true, messageId: waMessageId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /templates moved to routes/templates.ts

// ── POST /send/media/upload ──────────────────────────────────────────────────

app.post("/send/media/upload", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;

  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const phone = (formData.get("phoneNumber") ?? formData.get("phone") ?? "") as string;
    const caption = formData.get("caption") as string | null;

    if (!file) return c.json({ error: "file is required" }, 400);
    const cleanPhone = validatePhone(phone);
    if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);

    // Upload file to Meta
    const uploadForm = new FormData();
    uploadForm.append("messaging_product", "whatsapp");
    uploadForm.append("file", file, file.name);
    uploadForm.append("type", file.type);

    const uploadRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: uploadForm,
      },
    );
    const uploadData = (await uploadRes.json()) as any;
    if (!uploadRes.ok) {
      throw new Error(uploadData?.error?.message ?? `Upload error ${uploadRes.status}`);
    }

    const mediaId = uploadData.id;

    // Determine media type from MIME
    const mime = file.type;
    let mediaType = "document";
    if (mime.startsWith("image/")) mediaType = "image";
    else if (mime.startsWith("video/")) mediaType = "video";
    else if (mime.startsWith("audio/")) mediaType = "audio";

    const mediaPayload: any = { id: mediaId };
    if (caption && ["image", "video", "document"].includes(mediaType)) {
      mediaPayload.caption = caption;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: mediaType,
      [mediaType]: mediaPayload,
    };

    const result = await callWhatsAppAPI(payload, accessToken, phoneNumberId);
    const waMessageId = result?.messages?.[0]?.id ?? null;
    const db = createDb(getDbUrl(c.env));
    await logOutbound(db, cleanPhone, mediaType, caption ?? null, waMessageId);
    return c.json({ success: true, messageId: waMessageId, mediaId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── GET /conversations/:phoneNumber/profile ──────────────────────────────────

app.get("/conversations/:phoneNumber/profile", async (c) => {
  const phone = c.req.param("phoneNumber");
  const cleanPhone = validatePhone(phone);
  if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);

  const db = createDb(getDbUrl(c.env));
  const conversation = await db.query.conversationsTable.findFirst({
    where: eq(conversationsTable.phoneNumber, cleanPhone),
  });

  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ conversation });
});

// ── PATCH /conversations/:phoneNumber/profile ────────────────────────────────

app.patch("/conversations/:phoneNumber/profile", async (c) => {
  const phone = c.req.param("phoneNumber");
  const cleanPhone = validatePhone(phone);
  if (!cleanPhone) return c.json({ error: "Invalid phone number" }, 400);

  const body = await c.req.json();
  const allowedFields = ["contactName", "email", "notes", "tags"] as const;
  const updates: Record<string, any> = {};

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  const db = createDb(getDbUrl(c.env));
  const existing = await db.query.conversationsTable.findFirst({
    where: eq(conversationsTable.phoneNumber, cleanPhone),
  });

  if (!existing) return c.json({ error: "Conversation not found" }, 404);

  await db
    .update(conversationsTable)
    .set(updates)
    .where(eq(conversationsTable.id, existing.id));

  const updated = await db.query.conversationsTable.findFirst({
    where: eq(conversationsTable.id, existing.id),
  });

  return c.json({ conversation: updated });
});

export default app;
