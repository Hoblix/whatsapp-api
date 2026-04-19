/**
 * Reschedule-callback flow handler (flowSlug = "reschedule_call").
 * Pure function — receives the decrypted Meta request, returns the screen payload.
 *
 * Screens: WHAT_TO_CHANGE → PICK_DATE → PICK_TIME_SLOT → CONFIRMATION
 * Dynamic logic:
 *   - Routes based on change_type ("date" | "time" | "both")
 *   - Filters time slots for today to hide past hours
 *   - Upserts callback_bookings on CONFIRMATION (reschedule_count++)
 */

import { eq, and } from "drizzle-orm";
import type { Database } from "../../lib/db";
import { callbackBookingsTable, flowDefinitionsTable } from "../../lib/schema";
import { upsertNotionPageByPhone } from "../flowIntegrations";

// ── Slot catalogue ──
const SLOTS: Array<{ id: string; title: string; hour: number }> = [
  { id: "10-11", title: "10:00 AM – 11:00 AM", hour: 10 },
  { id: "11-12", title: "11:00 AM – 12:00 PM", hour: 11 },
  { id: "12-13", title: "12:00 PM – 1:00 PM", hour: 12 },
  { id: "14-15", title: "2:00 PM – 3:00 PM", hour: 14 },
  { id: "15-16", title: "3:00 PM – 4:00 PM", hour: 15 },
  { id: "16-17", title: "4:00 PM – 5:00 PM", hour: 16 },
  { id: "17-18", title: "5:00 PM – 6:00 PM", hour: 17 },
];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function nowInIST(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function istDate(d: Date): string {
  // Returns "YYYY-MM-DD" in IST
  return d.toISOString().slice(0, 10);
}

function formatDateLong(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function buildDateOptions(): Array<{ id: string; title: string }> {
  const today = nowInIST();
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const iso = istDate(d);
    const weekday = d.toLocaleDateString("en-IN", { weekday: "short" });
    const dayMonth = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    const label = i === 0 ? `${weekday}, ${dayMonth} (Today)` : `${weekday}, ${dayMonth}`;
    out.push({ id: iso, title: label });
  }
  return out;
}

function buildSlotOptions(selectedDate: string): { slot_options: Array<{ id: string; title: string }>; slot_notice: string } {
  const nowIst = nowInIST();
  const todayIso = istDate(nowIst);
  const isToday = selectedDate === todayIso;

  if (!isToday) {
    return {
      slot_options: SLOTS.map(({ id, title }) => ({ id, title })),
      slot_notice: "All available time slots are listed below.",
    };
  }

  const currentHour = nowIst.getUTCHours(); // already in IST from nowInIST
  const filtered = SLOTS.filter((s) => s.hour > currentHour);

  if (filtered.length === 0) {
    return {
      slot_options: [],
      slot_notice: "⚠ No more slots available today. Please pick a different date.",
    };
  }

  return {
    slot_options: filtered.map(({ id, title }) => ({ id, title })),
    slot_notice: "⚡ Showing only upcoming slots for today.",
  };
}

function slotLabel(slotId: string): string {
  return SLOTS.find((s) => s.id === slotId)?.title ?? slotId;
}

// ── Handler ──
export interface RescheduleHandlerOpts {
  db: Database;
  action: string;
  screen: string;
  flowToken: string | null;
  waPhone: string | null;
  data: Record<string, unknown>;
  version: string;
  tenantId: number;
  /** waitUntil from executionCtx — used to run Notion sync in background */
  waitUntil?: (promise: Promise<any>) => void;
  /** Cloudflare env — needed to reach Durable Object binding for reminders */
  env?: any;
}

// Notion property names in the Hoblix leads database
// (must match what the lead-capture flow's Notion mappings use)
const NOTION_PROP_CALL_DAY = "Call Schedule Date";
const NOTION_PROP_CALL_TIME = "Time Slot";
const NOTION_PROP_STATUS = "Call Status";

export async function handleRescheduleFlow(opts: RescheduleHandlerOpts): Promise<Record<string, unknown>> {
  const { db, action, screen, flowToken, waPhone, data, version, tenantId, waitUntil, env } = opts;

  // Helper — run side effects in background if waitUntil is available, otherwise await (fallback)
  const runBackground = (promise: Promise<any>) => {
    if (waitUntil) waitUntil(promise.catch((e) => console.error("[reschedule] bg task:", e)));
    else return promise.catch(() => {});
  };

  // Helper — schedule a reminder Durable Object alarm for a booking
  const scheduleReminder = async (phone: string, name: string, date: string, slot: string, slotLabel: string) => {
    if (!env?.BOOKING_REMINDER) return;
    try {
      const id = env.BOOKING_REMINDER.idFromName(phone);
      const stub = env.BOOKING_REMINDER.get(id);
      await stub.fetch("https://internal/schedule", {
        method: "POST",
        body: JSON.stringify({
          phone, name, bookedDate: date, bookedSlot: slot, bookedSlotLabel: slotLabel,
          accessToken: env.WHATSAPP_ACCESS_TOKEN,
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        }),
      });
    } catch (e) {
      console.error("[reschedule] scheduleReminder failed:", e);
    }
  };

  // Resolve the existing booking (by phone or flow_token which should contain booking id)
  let existing: any = null;
  if (waPhone) {
    const [row] = await db
      .select()
      .from(callbackBookingsTable)
      .where(eq(callbackBookingsTable.phoneNumber, waPhone))
      .limit(1);
    existing = row ?? null;
  }

  // ── INIT: open on WHAT_TO_CHANGE with current booking context ──
  if (action === "INIT" || action === "init") {
    return {
      version,
      screen: "WHAT_TO_CHANGE",
      data: {
        current_date: existing ? formatDateLong(existing.bookedDate) : "—",
        current_slot: existing?.bookedSlotLabel ?? existing?.bookedSlot ?? "—",
      },
    };
  }

  // ── data_exchange: route based on screen ──
  if (action === "data_exchange") {
    switch (screen) {
      case "WHAT_TO_CHANGE": {
        const changeType = String(data.change_type ?? "");
        if (changeType === "time") {
          // Skip PICK_DATE — time change assumes existing date
          const targetDate = existing?.bookedDate ?? istDate(nowInIST());
          const slots = buildSlotOptions(targetDate);
          return {
            version,
            screen: "PICK_TIME_SLOT",
            data: { ...slots, _selected_date: targetDate },
          };
        }
        // "date" or "both" → PICK_DATE
        return {
          version,
          screen: "PICK_DATE",
          data: { date_options: buildDateOptions() },
        };
      }

      case "PICK_DATE": {
        const newDate = String(data.new_date ?? istDate(nowInIST()));

        // Persist the date immediately — PICK_TIME_SLOT only receives new_slot,
        // not _selected_date, so we need to remember it server-side.
        if (waPhone) {
          const now = new Date();
          const [row] = await db
            .select()
            .from(callbackBookingsTable)
            .where(eq(callbackBookingsTable.phoneNumber, waPhone))
            .limit(1);
          if (row) {
            await db
              .update(callbackBookingsTable)
              .set({ bookedDate: newDate, updatedAt: now })
              .where(eq(callbackBookingsTable.phoneNumber, waPhone));
          } else {
            await db.insert(callbackBookingsTable).values({
              phoneNumber: waPhone,
              bookedDate: newDate,
              bookedSlot: "",
              bookedSlotLabel: "",
              status: "pending_slot",
              source: "reschedule",
              lastRescheduledAt: now,
            });
          }
        }

        const slots = buildSlotOptions(newDate);
        return {
          version,
          screen: "PICK_TIME_SLOT",
          data: { ...slots, _selected_date: newDate },
        };
      }

      case "PICK_TIME_SLOT": {
        const newSlot = String(data.new_slot ?? "");
        const selectedDate = String(data._selected_date ?? existing?.bookedDate ?? istDate(nowInIST()));
        const label = slotLabel(newSlot);

        // Upsert booking
        if (waPhone) {
          const now = new Date();
          const [row] = await db
            .select()
            .from(callbackBookingsTable)
            .where(eq(callbackBookingsTable.phoneNumber, waPhone))
            .limit(1);

          if (row) {
            await db
              .update(callbackBookingsTable)
              .set({
                bookedDate: selectedDate,
                bookedSlot: newSlot,
                bookedSlotLabel: label,
                status: "rescheduled",
                source: "reschedule",
                lastRescheduledAt: now,
                updatedAt: now,
              })
              .where(eq(callbackBookingsTable.phoneNumber, waPhone));
          } else {
            await db.insert(callbackBookingsTable).values({
              phoneNumber: waPhone,
              bookedDate: selectedDate,
              bookedSlot: newSlot,
              bookedSlotLabel: label,
              status: "rescheduled",
              source: "reschedule",
              lastRescheduledAt: now,
            });
          }

          // Sync to Notion in background — don't block the CONFIRMATION response
          runBackground((async () => {
            const [leadFlow] = await db
              .select()
              .from(flowDefinitionsTable)
              .where(
                and(
                  eq(flowDefinitionsTable.tenantId, tenantId),
                  eq(flowDefinitionsTable.slug, "hoblix-lead-capture"),
                ),
              )
              .limit(1);
            if (leadFlow) {
              await upsertNotionPageByPhone(db, leadFlow.id, tenantId, waPhone, {
                [NOTION_PROP_CALL_DAY]: { date: { start: selectedDate } },
                [NOTION_PROP_CALL_TIME]: { select: { name: label } },
                [NOTION_PROP_STATUS]: { status: { name: "Rescheduled" } },
              });
            }
          })());

          // Schedule/reschedule the 30-min-before reminder (overwrites any existing alarm for this phone)
          runBackground(scheduleReminder(waPhone, row?.name ?? "", selectedDate, newSlot, label));
        }

        const confirmedDate = formatDateLong(selectedDate);
        return {
          version,
          screen: "CONFIRMATION",
          data: {
            confirmed_date: confirmedDate,
            confirmed_slot: label,
            summary_text: `Your callback has been rescheduled. Our representative will call you on ${confirmedDate} between ${label}. If you'd like to talk sooner, just call us at 92892 52625.`,
          },
        };
      }
    }
  }

  // ── Handle single-screen flows that submit everything at once ──
  // Some Flow JSONs put WHAT/DATE/TIME on one screen and send a single payload.
  // Try to save whatever is present in `data`.
  if (action === "complete" || action === "data_exchange") {
    const candidateDate = String(data.new_date ?? data._selected_date ?? data.date ?? "");
    const candidateSlot = String(data.new_slot ?? data.slot ?? data.time_slot ?? "");

    if (candidateDate && candidateSlot && waPhone) {
      console.log(`[reschedule] Generic save: phone=${waPhone} date=${candidateDate} slot=${candidateSlot}`);
      const label = slotLabel(candidateSlot);
      const now = new Date();
      const [row] = await db
        .select()
        .from(callbackBookingsTable)
        .where(eq(callbackBookingsTable.phoneNumber, waPhone))
        .limit(1);

      if (row) {
        await db
          .update(callbackBookingsTable)
          .set({
            bookedDate: candidateDate,
            bookedSlot: candidateSlot,
            bookedSlotLabel: label,
            status: "rescheduled",
            source: "reschedule",
            lastRescheduledAt: now,
            updatedAt: now,
          })
          .where(eq(callbackBookingsTable.phoneNumber, waPhone));
      } else {
        await db.insert(callbackBookingsTable).values({
          phoneNumber: waPhone,
          bookedDate: candidateDate,
          bookedSlot: candidateSlot,
          bookedSlotLabel: label,
          status: "rescheduled",
          source: "reschedule",
          lastRescheduledAt: now,
        });
      }

      // Notion upsert in background
      runBackground((async () => {
        const [leadFlow] = await db
          .select()
          .from(flowDefinitionsTable)
          .where(and(eq(flowDefinitionsTable.tenantId, tenantId), eq(flowDefinitionsTable.slug, "hoblix-lead-capture")))
          .limit(1);
        if (leadFlow) {
          await upsertNotionPageByPhone(db, leadFlow.id, tenantId, waPhone, {
            [NOTION_PROP_CALL_DAY]: { date: { start: candidateDate } },
            [NOTION_PROP_CALL_TIME]: { select: { name: label } },
            [NOTION_PROP_STATUS]: { status: { name: "Rescheduled" } },
          });
        }
      })());

      // Schedule the 30-min-before reminder (overwrites existing alarm)
      runBackground(scheduleReminder(waPhone, existing?.name ?? "", candidateDate, candidateSlot, label));

      return {
        version,
        screen: "CONFIRMATION",
        data: {
          confirmed_date: formatDateLong(candidateDate),
          confirmed_slot: label,
          summary_text: `Your callback has been rescheduled. Our representative will call you on ${formatDateLong(candidateDate)} between ${label}.`,
        },
      };
    }
  }

  // Fallback
  return {
    version,
    screen: "WHAT_TO_CHANGE",
    data: {
      current_date: existing ? formatDateLong(existing.bookedDate) : "—",
      current_slot: existing?.bookedSlotLabel ?? "—",
    },
  };
}
