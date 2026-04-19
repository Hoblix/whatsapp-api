import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { META_GRAPH_API_VERSION } from "../env";

const app = new Hono<HonoEnv>();

const META_API = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

// GET /ads/campaigns — list only ACTIVE campaigns with WhatsApp CTA
app.get("/ads/campaigns", async (c) => {
  const token = c.env.META_ADS_ACCESS_TOKEN;
  const accountId = c.env.META_AD_ACCOUNT_ID;

  if (!token || !accountId) {
    return c.json({ error: "Meta Ads API not configured" }, 503);
  }

  try {
    // Fetch campaigns and filter active ones client-side
    const campRes = await fetch(
      `${META_API}/${accountId}/campaigns?fields=id,name,status,objective&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const campData = (await campRes.json()) as any;
    if (!campRes.ok) return c.json({ error: campData?.error?.message ?? "Meta API error" }, campRes.status);

    const campaigns = (campData.data ?? []).filter((c: any) => c.status === "ACTIVE");

    // For each campaign, check if any adset has destination_type = WHATSAPP
    const whatsappCampaigns = await Promise.all(
      campaigns.map(async (campaign: any) => {
        try {
          const adsetRes = await fetch(
            `${META_API}/${campaign.id}/adsets?fields=destination_type&limit=5`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const adsetData = (await adsetRes.json()) as any;
          const adsets = adsetData.data ?? [];
          const hasWhatsApp = adsets.some((as: any) => as.destination_type === "WHATSAPP");
          return hasWhatsApp ? { ...campaign, destination: "WHATSAPP" } : null;
        } catch {
          return null;
        }
      })
    );

    return c.json({ data: whatsappCampaigns.filter(Boolean) });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /ads/campaigns/:campaignId/adsets
app.get("/ads/campaigns/:campaignId/adsets", async (c) => {
  const token = c.env.META_ADS_ACCESS_TOKEN;
  const campaignId = c.req.param("campaignId");

  try {
    const res = await fetch(
      `${META_API}/${campaignId}/adsets?fields=id,name,status,destination_type&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = (await res.json()) as any;
    if (!res.ok) return c.json({ error: data?.error?.message ?? "Meta API error" }, res.status);
    return c.json({ data: data.data ?? [] });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /ads/campaigns/:campaignId/ads
app.get("/ads/campaigns/:campaignId/ads", async (c) => {
  const token = c.env.META_ADS_ACCESS_TOKEN;
  const campaignId = c.req.param("campaignId");

  try {
    const res = await fetch(
      `${META_API}/${campaignId}/ads?fields=id,name,status&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = (await res.json()) as any;
    if (!res.ok) return c.json({ error: data?.error?.message ?? "Meta API error" }, res.status);
    return c.json({ data: data.data ?? [] });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
