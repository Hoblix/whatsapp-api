/**
 * Shared WhatsApp API utility for sending messages via the Meta Graph API.
 * Takes env params directly instead of reading process.env.
 */

import { META_GRAPH_API_VERSION } from "../env";

export async function callWhatsAppAPI(
  payload: object,
  accessToken: string,
  phoneNumberId: string,
): Promise<any> {
  const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`;
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
    console.error(`[whatsapp-api] FAILED ${res.status}:`, JSON.stringify(data));
    throw new Error(data?.error?.message ?? `WhatsApp API error ${res.status}`);
  }
  console.log(`[whatsapp-api] OK — message_id: ${data?.messages?.[0]?.id ?? "unknown"}`);
  return data;
}
