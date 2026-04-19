import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { META_GRAPH_API_VERSION } from "../env";

const app = new Hono<HonoEnv>();

// ── GET /media/:mediaId — WhatsApp media proxy ──────────────────────────────

app.get("/media/:mediaId", async (c) => {
  const mediaId = c.req.param("mediaId");
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;

  try {
    // Step 1: Fetch the media URL from Meta
    const metaRes = await fetch(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const metaData = (await metaRes.json()) as any;

    if (!metaRes.ok) {
      throw new Error(metaData?.error?.message ?? `Meta API error ${metaRes.status}`);
    }

    const mediaUrl = metaData.url;
    if (!mediaUrl) {
      return c.json({ error: "No media URL returned from Meta" }, 404);
    }

    // Step 2: Download the actual media file
    const mediaRes = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!mediaRes.ok) {
      return c.json({ error: `Failed to download media: ${mediaRes.status}` }, 502);
    }

    const contentType = mediaRes.headers.get("content-type") ?? "application/octet-stream";
    const mediaBody = await mediaRes.arrayBuffer();

    // Step 3: Return with proper MIME type
    return new Response(mediaBody, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
