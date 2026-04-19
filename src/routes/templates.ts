/**
 * Template Management routes — Hono / Cloudflare Workers
 *
 * GET    /templates                  — list all templates (any status)
 * GET    /templates/:id              — get single template details
 * POST   /templates                  — create new template (submit to Meta)
 * POST   /templates/:id              — edit existing template
 * DELETE /templates/:name            — delete template
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { META_GRAPH_API_VERSION } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import { templateMediaTable } from "../lib/schema";

const app = new Hono<HonoEnv>();

// ── GET /templates — list all templates ────────────────────────────────────

app.get("/templates", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = c.env.WHATSAPP_WABA_ID;

  try {
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${wabaId}/message_templates?limit=250&fields=id,name,status,language,category,components,quality_score`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(data?.error?.message ?? `Meta API error ${res.status}`);
    return c.json({ data: data.data ?? [] });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── GET /templates/media-proxy — proxy media from any URL with public access ─
// Used because Cloudflare Pages on hoblix.com blocks Meta's fetcher (403).
// This serves via *.workers.dev which has no bot protection.
app.get("/templates/media-proxy", async (c) => {
  const target = c.req.query("url");
  if (!target) return c.json({ error: "url query param required" }, 400);

  // Allowlist: only proxy from our trusted hosts
  const allowedHosts = ["hoblix.com", "whatsapp.hoblix.com", "drive.google.com", "drive.usercontent.google.com"];
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }
  if (!allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
    return c.json({ error: "Host not allowed" }, 403);
  }

  // Handle Range requests (Meta uses these)
  const range = c.req.header("range");
  const upstream = await fetch(target, {
    headers: range ? { Range: range, "User-Agent": "Mozilla/5.0" } : { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });

  // Pass through with proper headers
  const headers = new Headers();
  const passThrough = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];
  for (const h of passThrough) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
});

// ── GET /templates/flows — list WhatsApp Flows from Meta ──────────────────────

app.get("/templates/flows", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = c.env.WHATSAPP_WABA_ID;

  // Step 1: Extract flow IDs from existing templates (always works)
  const flowIds = new Set<string>();
  try {
    const tplUrl = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${wabaId}/message_templates?limit=250&fields=components`;
    const tplRes = await fetch(tplUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const tplData = (await tplRes.json()) as any;
    if (tplRes.ok && tplData.data) {
      for (const tpl of tplData.data) {
        for (const comp of tpl.components ?? []) {
          for (const btn of comp.buttons ?? []) {
            if (btn.type === "FLOW" && btn.flow_id) flowIds.add(btn.flow_id);
          }
          for (const card of comp.cards ?? []) {
            for (const cardComp of card.components ?? []) {
              for (const btn of cardComp.buttons ?? []) {
                if (btn.type === "FLOW" && btn.flow_id) flowIds.add(btn.flow_id);
              }
            }
          }
        }
      }
    }
  } catch (err: any) {
    console.error("[templates/flows] Template scan error:", err.message);
  }

  // Step 2: Fetch details for each flow ID
  const flows: any[] = [];
  for (const flowId of flowIds) {
    try {
      const fRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${flowId}?fields=id,name,status,categories`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const fData = (await fRes.json()) as any;
      if (fRes.ok && fData.id) {
        flows.push(fData);
      } else {
        flows.push({ id: flowId, name: `Flow ${flowId}`, status: "UNKNOWN" });
      }
    } catch {
      flows.push({ id: flowId, name: `Flow ${flowId}`, status: "UNKNOWN" });
    }
  }

  // Step 3: Also try the direct flows listing endpoint (may work with right permissions)
  const seenIds = new Set(flows.map(f => f.id));
  try {
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${wabaId}/flows?fields=id,name,status,categories&limit=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as any;
    if (res.ok && data.data) {
      for (const f of data.data) {
        if (!seenIds.has(f.id)) {
          flows.push(f);
          seenIds.add(f.id);
        }
      }
    }
  } catch {}

  if (flows.length === 0) {
    return c.json({ data: [], message: "No flows found. Create a flow in Meta Business Suite first." });
  }

  return c.json({ data: flows });
});

// ── GET /templates/:id — get single template ───────────────────────────────

app.get("/templates/:id", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const templateId = c.req.param("id");

  try {
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${templateId}?fields=id,name,status,language,category,components,quality_score`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(data?.error?.message ?? `Meta API error ${res.status}`);
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /templates — create new template ──────────────────────────────────

app.post("/templates", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = c.env.WHATSAPP_WABA_ID;

  const body = await c.req.json<{
    name: string;
    category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
    language: string;
    components: any[];
    allow_category_change?: boolean;
    mediaSourceUrl?: string;
    mediaSourceType?: string;
  }>();

  // Validate required fields
  if (!body.name?.trim()) return c.json({ error: "Template name is required" }, 400);
  if (!body.category) return c.json({ error: "Category is required" }, 400);
  if (!body.language) return c.json({ error: "Language is required" }, 400);
  if (!body.components?.length) return c.json({ error: "At least one component is required" }, 400);

  // Validate name format (lowercase, underscores only)
  if (!/^[a-z0-9_]+$/.test(body.name)) {
    return c.json({ error: "Template name must be lowercase with underscores only (a-z, 0-9, _)" }, 400);
  }

  try {
    // Sanitize header_handle: if a handle string contains newlines, take only the first one
    for (const comp of body.components) {
      if (comp.type === "HEADER" && comp.example?.header_handle) {
        comp.example.header_handle = comp.example.header_handle.map((h: string) => {
          const first = h.split("\n")[0].trim();
          return first || h;
        });
      }
      // Also sanitize carousel card headers
      if (comp.type === "CAROUSEL" && comp.cards) {
        for (const card of comp.cards) {
          for (const cardComp of card.components ?? []) {
            if (cardComp.type === "HEADER" && cardComp.example?.header_handle) {
              cardComp.example.header_handle = cardComp.example.header_handle.map((h: string) => {
                const first = h.split("\n")[0].trim();
                return first || h;
              });
            }
          }
        }
      }
    }

    const payload: any = {
      name: body.name,
      category: body.category,
      language: body.language,
      components: body.components,
    };
    if (body.allow_category_change) payload.allow_category_change = true;

    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${wabaId}/message_templates`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as any;

    if (!res.ok) {
      console.error(`[templates] Create failed:`, JSON.stringify(data));
      return c.json({
        error: data?.error?.message ?? `Meta API error ${res.status}`,
        details: data?.error?.error_data ?? null,
      }, res.status >= 400 && res.status < 500 ? 400 : 502);
    }

    // Save the original source URL (e.g., user's Google Drive link) for future sends
    // Meta's header_handle URLs expire — we need the permanent source URL
    if (body.mediaSourceUrl && body.mediaSourceType) {
      try {
        const db = createDb(getDbUrl(c.env));
        await db
          .insert(templateMediaTable)
          .values({
            templateName: body.name,
            mediaUrl: body.mediaSourceUrl,
            mediaType: body.mediaSourceType,
          })
          .onConflictDoUpdate({
            target: templateMediaTable.templateName,
            set: { mediaUrl: body.mediaSourceUrl, mediaType: body.mediaSourceType, updatedAt: new Date() },
          });
      } catch (e) {
        console.error("[templates] Failed to save media source URL:", e);
        // Non-fatal — template was created successfully
      }
    }

    return c.json({
      success: true,
      id: data.id,
      status: data.status ?? "PENDING",
      category: data.category ?? body.category,
    });
  } catch (err: any) {
    console.error(`[templates] Create error:`, err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── GET /templates/:name/media-url — lookup stored source URL ─────────────

app.get("/templates/by-name/:name/media-url", async (c) => {
  const templateName = c.req.param("name");
  try {
    const db = createDb(getDbUrl(c.env));
    const [row] = await db
      .select()
      .from(templateMediaTable)
      .where(eq(templateMediaTable.templateName, templateName))
      .limit(1);
    if (!row) return c.json({ mediaUrl: null });
    return c.json({ mediaUrl: row.mediaUrl, mediaType: row.mediaType });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /templates/fetch-instagram — must be BEFORE /:id route ─────────────
// (moved here so Hono doesn't match "fetch-instagram" as a template :id)

app.post("/templates/fetch-instagram", async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  if (!url?.trim()) return c.json({ error: "URL is required" }, 400);

  try {
    // Support /p/ (posts), /reel/ (reels), and /tv/ (IGTV)
    const shortcodeMatch = url.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
    if (!shortcodeMatch) return c.json({ error: "Invalid Instagram URL — must be a post (/p/...), reel (/reel/...), or IGTV (/tv/...) link" }, 400);

    const shortcode = shortcodeMatch[1];

    // Fetch the page HTML
    const pageRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
    });

    const html = await pageRes.text();
    const media: string[] = [];

    // ── Extract images ──

    // og:image (always available for the first image/thumbnail)
    const ogMatches = [...html.matchAll(/property="og:image"\s+content="([^"]+)"/g)];
    for (const m of ogMatches) {
      if (!media.includes(m[1])) media.push(m[1]);
    }
    const ogMatches2 = [...html.matchAll(/content="([^"]+)"\s+property="og:image"/g)];
    for (const m of ogMatches2) {
      if (!media.includes(m[1])) media.push(m[1]);
    }

    // display_url from embedded JSON (carousel images)
    const displayUrlMatches = [...html.matchAll(/"display_url"\s*:\s*"([^"]+)"/g)];
    for (const m of displayUrlMatches) {
      const decoded = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      if (!media.includes(decoded)) media.push(decoded);
    }

    // image_versions2 URLs
    const imageVersions = [...html.matchAll(/"url"\s*:\s*"(https:\/\/[^"]*(?:instagram|cdninstagram|fbcdn)[^"]*\.jpg[^"]*)"/g)];
    for (const m of imageVersions) {
      const decoded = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      if (!media.includes(decoded) && decoded.includes("scontent")) media.push(decoded);
    }

    // ── Extract videos ──

    // og:video
    const ogVideoMatches = [...html.matchAll(/property="og:video(?::url)?"\s+content="([^"]+)"/g)];
    for (const m of ogVideoMatches) {
      if (!media.includes(m[1])) media.push(m[1]);
    }
    const ogVideoMatches2 = [...html.matchAll(/content="([^"]+)"\s+property="og:video(?::url)?"/g)];
    for (const m of ogVideoMatches2) {
      if (!media.includes(m[1])) media.push(m[1]);
    }

    // video_url from embedded JSON
    const videoUrlMatches = [...html.matchAll(/"video_url"\s*:\s*"([^"]+)"/g)];
    for (const m of videoUrlMatches) {
      const decoded = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      if (!media.includes(decoded)) media.push(decoded);
    }

    // video_versions URLs (.mp4)
    const videoVersions = [...html.matchAll(/"url"\s*:\s*"(https:\/\/[^"]*(?:instagram|cdninstagram|fbcdn)[^"]*\.mp4[^"]*)"/g)];
    for (const m of videoVersions) {
      const decoded = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      if (!media.includes(decoded)) media.push(decoded);
    }

    if (media.length > 0) {
      const unique = [...new Set(media)].slice(0, 10);
      return c.json({ images: unique, source: "page_extract", count: unique.length });
    }

    // Determine if it's a video post from og:type
    const isVideo = html.includes('og:type" content="video') || html.includes('content="video" property="og:type');

    return c.json({
      error: `Could not extract media automatically. Instagram requires login for some posts.${isVideo ? "\n\nThis appears to be a video/reel. To get the video URL:\n1. Open the reel in your browser\n2. Use a tool like saveinsta.app or igdownloader.app to get the .mp4 URL\n3. Paste the URL in the 'Paste Media URLs' section below" : "\n\nTo get media URLs manually:\n1. Open the post in a browser\n2. Right-click each image → 'Open image in new tab'\n3. Copy the URL from the address bar\n4. Paste URLs in the 'Paste Media URLs' section below"}`,
    }, 422);
  } catch (err: any) {
    console.error("[templates] Instagram fetch error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /templates/upload-media — upload image/video URL to get Meta handle ─

app.post("/templates/upload-media", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;

  const { url: rawUrl, type } = await c.req.json<{ url: string; type?: string }>();
  if (!rawUrl?.trim()) return c.json({ error: "URL is required" }, 400);

  try {
    // Convert Google Drive share links to direct download URLs
    let url = rawUrl.trim();
    const gdriveMatch = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
    if (gdriveMatch) {
      // Use confirm=1 to bypass virus scan warning for large files
      url = `https://drive.google.com/uc?export=download&confirm=1&id=${gdriveMatch[1]}`;
    }

    // Step 1: Download the file from the URL
    const fileRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      redirect: "follow",
    });
    if (!fileRes.ok) throw new Error(`Failed to download file: HTTP ${fileRes.status}`);

    const contentType = fileRes.headers.get("content-type") || "image/jpeg";

    // Check if Google Drive returned an HTML page instead of the file
    if (contentType.includes("text/html")) {
      throw new Error("Google Drive returned an HTML page instead of the file. Make sure the file is publicly shared (Anyone with the link → Viewer).");
    }

    const blob = await fileRes.blob();
    const fileSize = blob.size;

    if (fileSize === 0) throw new Error("Downloaded file is empty");

    // Determine file type for upload session
    const mimeType = type === "VIDEO" ? "video/mp4" : contentType.startsWith("image/") ? contentType : "image/jpeg";

    // Step 2: Create resumable upload session
    const sessionRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/app/uploads?file_length=${fileSize}&file_type=${encodeURIComponent(mimeType)}&access_token=${accessToken}`,
      { method: "POST" }
    );
    const sessionData = (await sessionRes.json()) as any;
    if (!sessionRes.ok) throw new Error(sessionData?.error?.message ?? `Upload session failed: ${sessionRes.status}`);

    const uploadSessionId = sessionData.id;
    if (!uploadSessionId) throw new Error("No upload session ID returned");

    // Step 3: Upload the file bytes
    const uploadRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${uploadSessionId}`,
      {
        method: "POST",
        headers: {
          Authorization: `OAuth ${accessToken}`,
          "Content-Type": mimeType,
          file_offset: "0",
        },
        body: blob,
      }
    );
    const uploadData = (await uploadRes.json()) as any;
    if (!uploadRes.ok) throw new Error(uploadData?.error?.message ?? `Upload failed: ${uploadRes.status}`);

    const handle = uploadData.h;
    if (!handle) throw new Error("No handle returned from upload");

    return c.json({ handle });
  } catch (err: any) {
    console.error("[templates] upload-media error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /templates/:id — edit existing template ───────────────────────────

app.post("/templates/:id", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const templateId = c.req.param("id");

  const body = await c.req.json<{ components: any[] }>();
  if (!body.components?.length) return c.json({ error: "Components are required" }, 400);

  try {
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${templateId}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ components: body.components }),
    });
    const data = (await res.json()) as any;

    if (!res.ok) {
      return c.json({
        error: data?.error?.message ?? `Meta API error ${res.status}`,
      }, res.status >= 400 && res.status < 500 ? 400 : 502);
    }

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── DELETE /templates/:name — delete template ──────────────────────────────

app.delete("/templates/:name", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = c.env.WHATSAPP_WABA_ID;
  const templateName = c.req.param("name");

  try {
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as any;

    if (!res.ok) {
      return c.json({
        error: data?.error?.message ?? `Meta API error ${res.status}`,
      }, res.status >= 400 && res.status < 500 ? 400 : 502);
    }

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
