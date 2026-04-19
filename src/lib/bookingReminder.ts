/**
 * BookingReminder — one Durable Object instance per booking (keyed by phone).
 * Stores the booking details and sets an alarm 30 minutes before the slot starts.
 * When the alarm fires, it sends the `callback_reminder` WhatsApp template.
 * Rescheduling calls schedule() again, which overwrites the alarm (no polling).
 */

import { META_GRAPH_API_VERSION } from "../env";

const IST_OFFSET_MIN = 330; // UTC+5:30
const REMINDER_OFFSET_MS = 30 * 60 * 1000;

interface BookingState {
  phone: string;
  name: string;
  bookedDate: string;       // "YYYY-MM-DD"
  bookedSlot: string;        // "14-15"
  bookedSlotLabel: string;   // "2:00 PM – 3:00 PM"
  accessToken: string;
  phoneNumberId: string;
  reminderAt: number;        // epoch ms
}

function formatDateLong(iso: string): string {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
      day: "numeric", month: "long", year: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Convert a booked_date + slot (IST) to an epoch-ms timestamp.
 * slot format: "14-15" → slot start hour 14 IST.
 */
function computeReminderEpoch(bookedDate: string, bookedSlot: string): number {
  const slotHour = parseInt(bookedSlot.split("-")[0], 10);
  // Construct IST datetime then adjust to UTC epoch
  const [y, m, d] = bookedDate.split("-").map(Number);
  // IST = UTC + 5:30, so UTC hour = slotHour - 5, minute = -30
  const utcMs = Date.UTC(y, m - 1, d, slotHour, 0, 0) - IST_OFFSET_MIN * 60 * 1000;
  return utcMs - REMINDER_OFFSET_MS;
}

export class BookingReminder {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, "");

    if (action === "schedule") {
      const body = await request.json() as Partial<BookingState>;
      const {
        phone, name, bookedDate, bookedSlot, bookedSlotLabel,
        accessToken, phoneNumberId,
      } = body;

      if (!phone || !bookedDate || !bookedSlot || !accessToken || !phoneNumberId) {
        return new Response(JSON.stringify({ error: "missing fields" }), { status: 400 });
      }

      const reminderAt = computeReminderEpoch(bookedDate, bookedSlot);

      // Don't schedule if the reminder time is already past
      if (reminderAt <= Date.now()) {
        await this.state.storage.deleteAll();
        await this.state.storage.deleteAlarm();
        return new Response(JSON.stringify({
          scheduled: false,
          reason: "reminder time already passed",
          reminderAt: new Date(reminderAt).toISOString(),
        }));
      }

      const fullState: BookingState = {
        phone,
        name: name ?? "",
        bookedDate,
        bookedSlot,
        bookedSlotLabel: bookedSlotLabel ?? bookedSlot,
        accessToken,
        phoneNumberId,
        reminderAt,
      };

      await this.state.storage.put("state", fullState);
      await this.state.storage.setAlarm(reminderAt);

      return new Response(JSON.stringify({
        scheduled: true,
        reminderAt: new Date(reminderAt).toISOString(),
        inMinutes: Math.round((reminderAt - Date.now()) / 60000),
      }));
    }

    if (action === "cancel") {
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return new Response(JSON.stringify({ cancelled: true }));
    }

    if (action === "status") {
      const state = await this.state.storage.get<BookingState>("state");
      const alarm = await this.state.storage.getAlarm();
      return new Response(JSON.stringify({
        hasState: !!state,
        state,
        alarmAt: alarm ? new Date(alarm).toISOString() : null,
      }));
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const state = await this.state.storage.get<BookingState>("state");
    if (!state) {
      console.warn("[BookingReminder] alarm fired but no state");
      return;
    }

    // Send the callback_reminder template
    try {
      const body = {
        messaging_product: "whatsapp",
        to: state.phone,
        type: "template",
        template: {
          name: "callback_reminder",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: state.name || "there" },
                { type: "text", text: formatDateLong(state.bookedDate) },
                { type: "text", text: state.bookedSlotLabel },
                { type: "text", text: `+${state.phone}` },
              ],
            },
            {
              type: "button",
              sub_type: "flow",
              index: "0",
              parameters: [{
                type: "action",
                action: { flow_token: JSON.stringify({ wa_id: state.phone, ref: "reminder" }) },
              }],
            },
          ],
        },
      };

      const res = await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${state.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${state.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json() as any;
      if (!res.ok) {
        console.error(`[BookingReminder] Send failed for ${state.phone}:`, JSON.stringify(data));
      } else {
        console.log(`[BookingReminder] Reminder sent to ${state.phone} (msgId=${data?.messages?.[0]?.id})`);
      }
    } catch (e: any) {
      console.error(`[BookingReminder] Error for ${state.phone}:`, e.message);
    }

    // Clear state after firing
    await this.state.storage.deleteAll();
  }
}
