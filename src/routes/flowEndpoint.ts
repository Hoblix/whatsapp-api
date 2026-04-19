/**
 * Public WhatsApp Flows endpoint (NO auth) — Hono / Cloudflare Workers
 *
 * GET  /flows/endpoint/:tenantSlug/:flowSlug   — Meta health check
 * POST /flows/endpoint/:tenantSlug/:flowSlug   — Full encrypted flow handler
 *
 * All POST responses return HTTP 200 with AES-128-GCM encrypted JSON.
 * Before decryption: random ephemeral AES key. After: the real key.
 *
 * Uses async Web Crypto functions from "../lib/flowCrypto".
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq, and, asc, sql } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl, createRawClient, type Database } from "../lib/db";
import {
  flowTenantsTable,
  flowDefinitionsTable,
  flowRsaKeysTable,
  flowSubmissionsTable,
  flowAnalyticsEventsTable,
  flowScreensTable,
  flowRoutingRulesTable,
  conversationsTable,
  type FlowScreen,
  type FlowRoutingRule,
} from "../lib/schema";
import { pushSubmissionToIntegrations } from "./flowIntegrations";
import { handleRescheduleFlow } from "./flowHandlers/reschedule";
import {
  decryptFlowRequest,
  encryptFlowResponse,
  decryptPrivateKey,
  getCachedPrivateKey,
  setCachedPrivateKey,
  type MetaFlowRequest,
} from "../lib/flowCrypto";

const app = new Hono<HonoEnv>();

// ── Per-isolate caches for hot-path lookups ─────────────────────────────────
// These avoid repeated DB queries for the same tenant/flow/screens on
// consecutive requests within the same Worker isolate (typically <30s apart
// during active flow sessions).

interface TenantCache {
  tenant: any;
  rsaKey: any;
  ts: number;
}
interface FlowCache {
  flow: any;
  screens: any[];
  rules: Map<number, any[]>;
  ts: number;
}

const _tenantCache = new Map<string, TenantCache>();
const _flowCache = new Map<string, FlowCache>();
const CACHE_TTL = 60_000; // 1 minute

function getCachedTenant(slug: string): TenantCache | null {
  const c = _tenantCache.get(slug);
  if (c && Date.now() - c.ts < CACHE_TTL) return c;
  return null;
}

function getCachedFlow(key: string): FlowCache | null {
  const c = _flowCache.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL) return c;
  return null;
}

// ── Open CORS for this router — Meta's servers POST from their own IPs ──────

app.use(
  "/flows/endpoint/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Hub-Signature-256"],
  }),
);

// ── DB-backed flow session store ─────────────────────────────────────────────
// Workers are stateless across isolates — in-memory maps get lost.
// Sessions are stored in the `flow_sessions` table for persistence.
// We also keep an in-memory cache for fast reads within the same isolate.

const _sessionCache = new Map<string, Record<string, unknown>>();

function normalizeSessionKey(sessionKey: string): string {
  try {
    const parsed = JSON.parse(sessionKey);
    if (parsed?.wa_id) return String(parsed.wa_id);
  } catch { /* use as-is */ }
  return sessionKey;
}

async function mergeSessionDb(
  pg: any, // raw postgres client (shared per request)
  sessionKey: string | null,
  incoming: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!sessionKey) return incoming;
  const key = normalizeSessionKey(sessionKey);

  try {
    // Use postgres driver's native JSON handling — pass object directly via pg.json()
    const incomingJsonParam = pg.json(incoming);

    const rows = await pg`
      INSERT INTO flow_sessions (flow_token, session_data, updated_at)
      VALUES (${key}, ${incomingJsonParam}, NOW())
      ON CONFLICT (flow_token)
      DO UPDATE SET session_data = flow_sessions.session_data || ${incomingJsonParam},
                    updated_at = NOW()
      RETURNING session_data
    `;
    if (rows.length > 0) {
      const result = rows[0].session_data as Record<string, unknown>;
      _sessionCache.set(key, result);
      console.log(`FLOW_SESSION: key=${key} merged=${Object.keys(result).join(",")}`);
      return result;
    }
  } catch (err) {
    console.warn("Flow session DB upsert failed:", err);
  }

  const cached = _sessionCache.get(key) ?? {};
  const fallback = { ...cached, ...incoming };
  _sessionCache.set(key, fallback);
  return fallback;
}


async function getSessionDb(
  db: Database,
  flowToken: string | null,
): Promise<Record<string, unknown>> {
  if (!flowToken) return {};

  // Normalize key — use phone number if flow_token is JSON with wa_id
  let key = flowToken;
  try {
    const parsed = JSON.parse(flowToken);
    if (parsed?.wa_id) key = String(parsed.wa_id);
  } catch { /* use as-is */ }

  // Always read from DB (source of truth), cache is secondary
  try {
    const rows = await db.execute(
      sql`SELECT session_data FROM flow_sessions WHERE flow_token = ${key} LIMIT 1`
    );
    if (rows.length > 0) {
      const raw = (rows[0] as any).session_data;
      const data = typeof raw === "string" ? JSON.parse(raw) : (raw ?? {});
      _sessionCache.set(key, data);
      return { ...data };
    }
  } catch (err) {
    console.warn("Flow session DB read failed:", err);
  }

  // Fallback to in-memory cache
  const cached = _sessionCache.get(key);
  if (cached && Object.keys(cached).length > 0) return { ...cached };

  return {};
}


/** Store flow summary in DB so the webhook (possibly different isolate) can read it */
async function storePendingSummary(pg: any, phone: string, summary: string) {
  try {
    await pg`INSERT INTO flow_pending_summaries (phone, summary, created_at)
             VALUES (${phone}, ${summary}, NOW())
             ON CONFLICT (phone) DO UPDATE SET summary = ${summary}, created_at = NOW()`;
  } catch (err) {
    console.warn("Failed to store pending summary:", err);
  }
}

/** Read and delete a pending flow summary (called by webhook) */
export async function consumePendingSummary(dbUrl: string, phone: string): Promise<string | null> {
  const pg = createRawClient(dbUrl);
  try {
    const rows = await pg`DELETE FROM flow_pending_summaries WHERE phone = ${phone} RETURNING summary`;
    if (rows.length > 0) {
      return rows[0].summary as string;
    }
  } catch {
    // Non-fatal
  }
  return null;
}

// ── Hoblix lookup tables ─────────────────────────────────────────────────────

const INTENT_LABELS: Record<string, string> = {
  talk_to_someone: "Talk to Someone",
  get_pricing: "Get Pricing",
  schedule_visit: "Schedule a Visit",
  book_a_seat: "Book a Seat",
  get_directions: "Get Location & Directions",
};

const SPACE_LABELS: Record<string, string> = {
  private_cabin: "Private Cabin",
  day_pass: "Day Pass",
  open_seat: "Open Seat",
  virtual_office: "Virtual Office",
  meeting_room: "Meeting Room",
  podcast_studio: "Podcast Studio",
};

const SEATS_LABELS: Record<string, string> = {
  just_me: "Just me",
  "2_4_seats": "2-4 seats",
  "5_10_seats": "5-10 seats",
  "10_plus_seats": "10+ seats",
};

const URGENCY_LABELS: Record<string, string> = {
  immediately: "Immediately",
  this_week: "This week",
  within_2_weeks: "Within 2 weeks",
  just_exploring: "Just exploring",
};

const TIME_LABELS: Record<string, string> = {
  "10_12": "10:00 AM - 12:00 PM",
  "12_2": "12:00 PM - 2:00 PM",
  "2_5": "2:00 PM - 5:00 PM",
  "5_8": "5:00 PM - 8:00 PM",
};

const PRICING_ACTION_LABELS: Record<string, string> = {
  get_detailed_quote: "Get Detailed Quote on WhatsApp",
  schedule_call: "Talk to Sales Team",
  schedule_visit: "Visit & Decide",
};

const DIRECTIONS_ACTION_LABELS: Record<string, string> = {
  get_map_link: "Google Maps link sent to this chat",
  schedule_visit: "Visit scheduled",
  call_for_help: "Our team will call you",
};

const PRICE_RANGES: Record<string, string> = {
  private_cabin: "\u20b9399 - \u20b9699/day",
  day_pass: "\u20b9199/day",
  open_seat: "\u20b9133 - \u20b9249/day",
  virtual_office: "\u20b9999 - \u20b92,999/month",
  meeting_room: "\u20b9299 - \u20b9599/hour",
  podcast_studio: "\u20b9499 - \u20b9999/hour",
};

// ── Hoblix helper utilities ──────────────────────────────────────────────────

function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12)
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return raw;
}

function getISTHour(): number {
  const utcMs = Date.now();
  const istMs = utcMs + 5.5 * 60 * 60 * 1000;
  const istDate = new Date(istMs);
  return istDate.getUTCHours() + istDate.getUTCMinutes() / 60;
}

const ALL_TIME_SLOTS = [
  { id: "10_12", title: "10:00 AM - 12:00 PM", endHour: 11.5 },
  { id: "12_2", title: "12:00 PM - 2:00 PM", endHour: 13.5 },
  { id: "2_5", title: "2:00 PM - 5:00 PM", endHour: 16.5 },
  { id: "5_8", title: "5:00 PM - 8:00 PM", endHour: 19.5 },
];

function generateTimeOptions(forToday = false): Array<{ id: string; title: string }> {
  if (!forToday) return ALL_TIME_SLOTS.map(({ id, title }) => ({ id, title }));
  const istHour = getISTHour();
  return ALL_TIME_SLOTS.filter((s) => s.endHour > istHour).map(({ id, title }) => ({ id, title }));
}

function generateDayOptions(): Array<{ id: string; title: string }> {
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const now = new Date();
  const todayHasSlots = generateTimeOptions(true).length > 0;
  const results: Array<{ id: string; title: string }> = [];
  for (let i = 0; i < 7; i++) {
    if (i === 0 && !todayHasSlots) continue;
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const dayName = DAYS[d.getDay()];
    const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    const title =
      i === 0
        ? `Today, ${dayName} ${label}`
        : i === 1
          ? `Tomorrow, ${dayName} ${label}`
          : `${dayName}, ${label}`;
    results.push({ id: `day_${i}`, title });
  }
  return results;
}

function resolveDayLabel(dayId: string): string {
  const match = dayId.match(/^day_(\d)$/);
  if (!match) return dayId;
  const offset = parseInt(match[1], 10);
  const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS_FULL = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const dayName = DAYS_FULL[d.getDay()];
  const label = `${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
  return offset === 0
    ? `Today, ${dayName} ${label}`
    : offset === 1
      ? `Tomorrow, ${dayName} ${label}`
      : `${dayName}, ${label}`;
}

function buildFlowChatSummary(session: Record<string, unknown>): string {
  const s = (k: string) => (session[k] as string | undefined) ?? "";
  // Support aliases: team_size -> seats, timeline -> urgency
  const seats = s("seats") || s("team_size");
  const urgency = s("urgency") || s("timeline");
  const lines: string[] = ["\u{1f4cb} Flow submitted"];
  if (s("name")) lines.push(`\u{1f464} Name: ${s("name")}`);
  if (s("intent")) lines.push(`\u{1f3af} Intent: ${INTENT_LABELS[s("intent")] ?? s("intent")}`);
  if (s("space_type")) lines.push(`\u{1f3e2} Space: ${SPACE_LABELS[s("space_type")] ?? s("space_type")}`);
  if (seats) lines.push(`\u{1fa91} Seats: ${SEATS_LABELS[seats] ?? seats}`);
  if (urgency) lines.push(`\u{23f0} Urgency: ${URGENCY_LABELS[urgency] ?? urgency}`);
  if (s("wa_phone") || s("_waPhone")) lines.push(`\u{1f4f1} Phone: ${formatPhone(s("wa_phone") || s("_waPhone"))}`);
  if (s("callback_day")) lines.push(`\u{1f4c5} Call Day: ${resolveDayLabel(s("callback_day"))}`);
  if (s("callback_time")) lines.push(`\u{1f550} Call Time: ${TIME_LABELS[s("callback_time")] ?? s("callback_time")}`);
  if (s("visit_day")) lines.push(`\u{1f4c5} Visit Day: ${resolveDayLabel(s("visit_day"))}`);
  if (s("visit_time")) lines.push(`\u{1f550} Visit Time: ${TIME_LABELS[s("visit_time")] ?? s("visit_time")}`);
  if (s("pricing_action")) lines.push(`\u{1f4b0} Next Step: ${PRICING_ACTION_LABELS[s("pricing_action")] ?? s("pricing_action")}`);
  if (s("booking_plan")) lines.push(`\u{1f4cb} Plan: ${s("booking_plan")}`);
  if (s("start_date")) lines.push(`\u{1f4c5} Start: ${s("start_date")}`);
  if (s("message")) lines.push(`\u{1f4ac} Message: ${s("message")}`);
  return lines.join("\n");
}

function enrichForIntegrations(session: Record<string, unknown>): Record<string, unknown> {
  const enriched: Record<string, unknown> = { ...session };

  if (session._waPhone) enriched.wa_phone = session._waPhone;

  function dayIdToIso(dayId: string): string | null {
    const match = dayId.match(/^day_(\d)$/);
    if (!match) return null;
    const offset = parseInt(match[1], 10);
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split("T")[0];
  }

  for (const field of ["callback_day", "visit_day"]) {
    const raw = session[field] as string | undefined;
    if (!raw) continue;
    const iso = dayIdToIso(raw);
    if (iso) {
      enriched[field] = iso;
      enriched[`${field}_label`] = resolveDayLabel(raw);
    }
  }

  for (const field of ["callback_time", "visit_time"]) {
    const raw = session[field] as string | undefined;
    if (raw && TIME_LABELS[raw]) {
      enriched[field] = TIME_LABELS[raw];
    }
  }

  const str = (k: string) => session[k] as string | undefined;
  if (str("intent")) {
    const label = INTENT_LABELS[str("intent")!] ?? str("intent")!;
    enriched.intent = label;
    enriched.intent_label = label;
  }
  if (str("space_type")) {
    const label = SPACE_LABELS[str("space_type")!] ?? str("space_type")!;
    enriched.space_type = label;
    enriched.space_label = label;
  }
  if (str("seats")) {
    const label = SEATS_LABELS[str("seats")!] ?? str("seats")!;
    enriched.seats = label;
    enriched.seats_label = label;
  }
  if (str("urgency")) {
    const label = URGENCY_LABELS[str("urgency")!] ?? str("urgency")!;
    enriched.urgency = label;
    enriched.urgency_label = label;
  }
  if (str("pricing_action")) {
    const label = PRICING_ACTION_LABELS[str("pricing_action")!] ?? str("pricing_action")!;
    enriched.pricing_action = label;
    enriched.pricing_action_label = label;
  }

  const BOOKING_PLAN_LABELS: Record<string, string> = {
    single_day: "Single Day",
    "5_days": "5 Days Pack",
    "10_days": "10 Days Pack",
    monthly: "Monthly",
    quarterly: "Quarterly",
    half_yearly: "Half Yearly",
    "6_months": "6 Months",
    yearly: "Annual",
    hourly: "Per Hour",
    half_day: "Half Day (4 hrs)",
    full_day: "Full Day (8 hrs)",
  };
  const START_DATE_LABELS: Record<string, string> = {
    this_week: "This Week",
    next_week: "Next Week",
    this_month: "This Month",
    flexible: "Flexible",
  };
  if (str("booking_plan")) {
    const label = BOOKING_PLAN_LABELS[str("booking_plan")!] ?? str("booking_plan")!;
    enriched.booking_plan = label;
    enriched.booking_plan_label = label;
    enriched.plan = label;
  }
  if (str("start_date")) {
    const label = START_DATE_LABELS[str("start_date")!] ?? str("start_date")!;
    enriched.start_date = label;
    enriched.start_date_label = label;
    enriched.preferred_date = label;
  }

  if (enriched.seats) enriched.team_size = enriched.seats;
  if (enriched.urgency) enriched.timeline = enriched.urgency;

  return enriched;
}

function buildBookingOptions(spaceId: string | undefined): Array<{ id: string; title: string }> {
  switch (spaceId) {
    case "day_pass":
      return [
        { id: "single_day", title: "Single Day" },
        { id: "5_days", title: "5 Days Pack" },
        { id: "10_days", title: "10 Days Pack" },
        { id: "monthly", title: "Monthly Pass" },
      ];
    case "open_seat":
      return [
        { id: "monthly", title: "Monthly" },
        { id: "quarterly", title: "Quarterly" },
        { id: "half_yearly", title: "Half Yearly" },
      ];
    case "private_cabin":
      return [
        { id: "monthly", title: "Monthly" },
        { id: "quarterly", title: "Quarterly" },
        { id: "6_months", title: "6 Months" },
        { id: "yearly", title: "Annual" },
      ];
    case "virtual_office":
      return [
        { id: "monthly", title: "Monthly" },
        { id: "quarterly", title: "Quarterly" },
        { id: "yearly", title: "Annual" },
      ];
    case "meeting_room":
      return [
        { id: "hourly", title: "Per Hour" },
        { id: "half_day", title: "Half Day (4 hrs)" },
        { id: "full_day", title: "Full Day (8 hrs)" },
      ];
    case "podcast_studio":
      return [
        { id: "hourly", title: "Per Hour" },
        { id: "half_day", title: "Half Day (4 hrs)" },
      ];
    default:
      return [
        { id: "monthly", title: "Monthly" },
        { id: "quarterly", title: "Quarterly" },
      ];
  }
}

function buildScreenData(
  nextScreen: string,
  acc: Record<string, unknown>,
  waPhone: string | null,
  contactName: string | null,
): Record<string, unknown> {
  const userName =
    (acc.name as string | undefined) ||
    (acc.prefilled_name as string | undefined) ||
    contactName ||
    "";
  const phone = formatPhone(waPhone);

  const base: Record<string, unknown> = {
    whatsapp_number: phone,
    user_name: userName,
  };

  const str = (key: string) => acc[key] as string | undefined;

  switch (nextScreen) {
    case "YOUR_DETAILS": {
      const intentId = str("intent");
      return {
        ...base,
        intent_label: intentId ? (INTENT_LABELS[intentId] ?? intentId) : "",
        prefilled_name: userName,
        whatsapp_number: phone,
      };
    }

    case "SELECT_SPACE":
    case "SELECT_SEATS":
    case "SELECT_URGENCY":
      return { ...base };

    case "SCHEDULE_CALL":
    case "SCHEDULE_VISIT":
      return { ...base, day_options: generateDayOptions() };

    case "GET_PRICING": {
      const spaceId = str("space_type");
      const seatsId = str("seats");
      const urgencyId = str("urgency");
      const spaceLabel = spaceId ? (SPACE_LABELS[spaceId] ?? spaceId) : "\u2014";
      const seatsLabel = seatsId ? (SEATS_LABELS[seatsId] ?? seatsId) : "\u2014";
      return {
        ...base,
        selection_summary: `Space: ${spaceLabel} \u2022 Seats: ${seatsLabel}`,
        urgency_label: urgencyId ? (URGENCY_LABELS[urgencyId] ?? urgencyId) : "",
        price_range: spaceId ? (PRICE_RANGES[spaceId] ?? "Contact us for pricing") : "Contact us for pricing",
        price_note: "Final pricing depends on duration & plan. Our team will share exact numbers.",
      };
    }

    case "BOOK_SEAT": {
      const spaceId = str("space_type");
      const seatsId = str("seats");
      return {
        ...base,
        booking_summary: `${SPACE_LABELS[spaceId ?? ""] ?? spaceId ?? "\u2014"} \u2022 ${SEATS_LABELS[seatsId ?? ""] ?? seatsId ?? "\u2014"}`,
        booking_options: buildBookingOptions(spaceId),
      };
    }

    case "GET_DIRECTIONS":
      return {
        ...base,
        address_line_1: "Hoblix Coworking, 3rd Floor, Sunshine Tower",
        address_line_2: "Andheri East, Mumbai \u2014 400069",
        landmarks: "Near WEH Metro Station, Opp. HDFC Bank",
        timings: "Mon\u2013Sat: 8 AM \u2013 10 PM \u2022 Sun: 10 AM \u2013 6 PM",
      };

    case "THANK_YOU_CALL": {
      const dayOptions = generateDayOptions();
      const dayOpt = dayOptions.find((d) => d.id === str("callback_day"));
      return {
        ...base,
        callback_day_label: dayOpt?.title ?? str("callback_day") ?? "",
        callback_time_label: TIME_LABELS[str("callback_time") ?? ""] ?? str("callback_time") ?? "",
        space_label: SPACE_LABELS[str("space_type") ?? ""] ?? str("space_type") ?? "",
        seats_label: SEATS_LABELS[str("seats") ?? ""] ?? str("seats") ?? "",
        urgency_label: URGENCY_LABELS[str("urgency") ?? ""] ?? str("urgency") ?? "",
      };
    }

    case "THANK_YOU_VISIT": {
      const dayOptions = generateDayOptions();
      const dayOpt = dayOptions.find((d) => d.id === str("visit_day"));
      return {
        ...base,
        visit_day_label: dayOpt?.title ?? str("visit_day") ?? "",
        visit_time_label: TIME_LABELS[str("visit_time") ?? ""] ?? str("visit_time") ?? "",
        space_label: SPACE_LABELS[str("space_type") ?? ""] ?? str("space_type") ?? "",
        seats_label: SEATS_LABELS[str("seats") ?? ""] ?? str("seats") ?? "",
        address: "Hoblix Coworking, 3rd Floor, Sunshine Tower, Andheri East, Mumbai \u2014 400069",
      };
    }

    case "THANK_YOU_PRICING": {
      const spaceId = str("space_type");
      return {
        ...base,
        space_label: SPACE_LABELS[spaceId ?? ""] ?? spaceId ?? "",
        seats_label: SEATS_LABELS[str("seats") ?? ""] ?? str("seats") ?? "",
        urgency_label: URGENCY_LABELS[str("urgency") ?? ""] ?? str("urgency") ?? "",
        price_range: PRICE_RANGES[spaceId ?? ""] ?? "Contact us",
        pricing_action_label: PRICING_ACTION_LABELS[str("pricing_action") ?? ""] ?? str("pricing_action") ?? "",
      };
    }

    case "THANK_YOU_BOOKING": {
      const spaceId = str("space_type");
      return {
        ...base,
        space_label: SPACE_LABELS[spaceId ?? ""] ?? spaceId ?? "",
        seats_label: SEATS_LABELS[str("seats") ?? ""] ?? str("seats") ?? "",
        plan_label: str("plan") ?? "",
        start_date_label: str("start_date") ?? "",
        amount: PRICE_RANGES[spaceId ?? ""] ?? "Contact us",
        payment_note: "Our team will confirm your booking and share payment details on WhatsApp.",
      };
    }

    case "THANK_YOU_DIRECTIONS":
      return {
        ...base,
        address_line_1: "Hoblix Coworking, 3rd Floor, Sunshine Tower",
        address_line_2: "Andheri East, Mumbai \u2014 400069",
        landmarks: "Near WEH Metro Station, Opp. HDFC Bank",
        timings: "Mon\u2013Sat: 8 AM \u2013 10 PM \u2022 Sun: 10 AM \u2013 6 PM",
        directions_action_label: DIRECTIONS_ACTION_LABELS[str("directions_action") ?? ""] ?? str("directions_action") ?? "",
      };

    default:
      return { ...acc, ...base };
  }
}

function enrichScreenData(
  targetScreenId: string,
  baseData: Record<string, unknown>,
  session: Record<string, unknown>,
): Record<string, unknown> {
  const userName = (session.name as string) || (session.prefilled_name as string) || "there";
  console.log(`FLOW_DEBUG enrichScreenData(${targetScreenId}): session.name=${session.name} session.prefilled_name=${session.prefilled_name} -> userName=${userName}`);
  const waPhone = (session._waPhone as string) || "";
  const phoneDisplay = waPhone ? formatPhone(waPhone) : "";
  const spaceLabel = SPACE_LABELS[session.space_type as string] || (session.space_type as string) || "";
  const seatsLabel = SEATS_LABELS[session.seats as string] || (session.seats as string) || "";
  const urgencyLabel = URGENCY_LABELS[session.urgency as string] || (session.urgency as string) || "";
  const extra: Record<string, unknown> = {};

  switch (targetScreenId) {
    case "YOUR_DETAILS":
      extra.intent_label = INTENT_LABELS[session.intent as string] || (session.intent as string) || "";
      extra.prefilled_name = (session.prefilled_name as string) || userName;
      extra.whatsapp_number = phoneDisplay;
      extra.whatsapp_display = phoneDisplay ? `WhatsApp: ${phoneDisplay}` : "";
      break;
    case "SELECT_SPACE":
      extra.user_name = userName;
      extra.heading_text = `${userName}, what space type do you need?`;
      break;
    case "SELECT_SEATS":
      extra.user_name = userName;
      extra.heading_text = `How many seats, ${userName}?`;
      break;
    case "SELECT_URGENCY":
      extra.user_name = userName;
      extra.heading_text = `How soon do you need this, ${userName}?`;
      break;
    case "SCHEDULE_CALL": {
      extra.user_name = userName;
      extra.heading_text = `${userName}, when should we call you?`;
      const callDayOpts = generateDayOptions();
      extra.day_options = callDayOpts;
      // If first option is today, filter out past time slots
      const callIsToday = callDayOpts.length > 0 && callDayOpts[0].id === "day_0";
      extra.time_options = generateTimeOptions(callIsToday);
      break;
    }
    case "SCHEDULE_VISIT": {
      extra.user_name = userName;
      extra.heading_text = `${userName}, when would you like to visit?`;
      const visitDayOpts = generateDayOptions();
      extra.day_options = visitDayOpts;
      const visitIsToday = visitDayOpts.length > 0 && visitDayOpts[0].id === "day_0";
      extra.time_options = generateTimeOptions(visitIsToday);
      break;
    }
    case "GET_PRICING":
      extra.user_name = userName;
      extra.heading_text = `Here's your estimate, ${userName}`;
      extra.selection_summary = `Space: ${spaceLabel} \u2022 Seats: ${seatsLabel}`;
      extra.urgency_label = urgencyLabel;
      extra.urgency_display = urgencyLabel ? `Timeline: ${urgencyLabel}` : "";
      extra.price_range = PRICE_RANGES[session.space_type as string] || "Contact us";
      extra.price_note = "Final pricing depends on duration and plan. Our team will share exact numbers.";
      break;
    case "BOOK_SEAT":
      extra.user_name = userName;
      extra.heading_text = `Reserve your spot, ${userName}`;
      extra.booking_summary = `${spaceLabel} \u2022 ${seatsLabel}`;
      extra.booking_options = buildBookingOptions(session.space_type as string);
      break;
    case "GET_DIRECTIONS":
      extra.user_name = userName;
      extra.address_line_1 = "Hoblix Coworking Space";
      extra.address_line_2 = "Near Najafgarh Metro Station, Najafgarh, Delhi - 110043";
      extra.landmarks = "Opposite Jain Mandir \u2022 2 min walk from Metro Gate 1";
      extra.timings = "Open Mon-Sat: 8 AM - 10 PM | Sun: 10 AM - 6 PM";
      break;
    case "THANK_YOU_CALL": {
      const callDayId = (session.callback_day as string) || "";
      const callDayLabel = callDayId ? resolveDayLabel(callDayId) : "";
      const callTimeLabel = TIME_LABELS[session.callback_time as string] || (session.callback_time as string) || "";
      extra.user_name = userName;
      extra.heading_text = `Thanks ${userName}! Our workspace expert will call you.`;
      extra.callback_day_label = callDayLabel;
      extra.callback_time_label = callTimeLabel;
      extra.callback_day_display = callDayLabel ? `Day: ${callDayLabel}` : "";
      extra.callback_time_display = callTimeLabel ? `Time: ${callTimeLabel}` : "";
      extra.space_label = spaceLabel;
      extra.seats_label = seatsLabel;
      extra.space_display = spaceLabel ? `Space: ${spaceLabel}` : "";
      extra.seats_display = seatsLabel ? `Seats: ${seatsLabel}` : "";
      extra.urgency_label = urgencyLabel;
      extra.urgency_display = urgencyLabel ? `Timeline: ${urgencyLabel}` : "";
      break;
    }
    case "THANK_YOU_VISIT": {
      const visitDayId = (session.visit_day as string) || "";
      const visitDayLabel = visitDayId ? resolveDayLabel(visitDayId) : "";
      const visitTimeLabel = TIME_LABELS[session.visit_time as string] || (session.visit_time as string) || "";
      extra.user_name = userName;
      extra.heading_text = `See you at Hoblix, ${userName}!`;
      extra.visit_day_label = visitDayLabel;
      extra.visit_time_label = visitTimeLabel;
      extra.visit_day_display = visitDayLabel ? `Day: ${visitDayLabel}` : "";
      extra.visit_time_display = visitTimeLabel ? `Time: ${visitTimeLabel}` : "";
      extra.space_label = spaceLabel;
      extra.seats_label = seatsLabel;
      extra.space_display = spaceLabel ? `Space: ${spaceLabel}` : "";
      extra.seats_display = seatsLabel ? `Seats: ${seatsLabel}` : "";
      extra.address = "Hoblix Coworking, Near Najafgarh Metro Station, Delhi - 110043";
      break;
    }
    case "THANK_YOU_PRICING": {
      extra.user_name = userName;
      extra.heading_text = `Thanks ${userName}! Here's your estimate.`;
      extra.space_label = spaceLabel;
      extra.seats_label = seatsLabel;
      extra.space_display = spaceLabel ? `Space: ${spaceLabel}` : "";
      extra.seats_display = seatsLabel ? `Seats: ${seatsLabel}` : "";
      extra.urgency_label = urgencyLabel;
      extra.urgency_display = urgencyLabel ? `Timeline: ${urgencyLabel}` : "";
      extra.price_range = PRICE_RANGES[session.space_type as string] || "Contact us";
      extra.pricing_action_label =
        PRICING_ACTION_LABELS[session.pricing_action as string] || (session.pricing_action as string) || "";
      break;
    }
    case "THANK_YOU_BOOKING": {
      const planLabel = (session.booking_plan as string) || "";
      const startDate = (session.start_date as string) || "";
      const amount = "\u20b92,999";
      extra.user_name = userName;
      extra.heading_text = `Almost there, ${userName}! Review your booking.`;
      extra.space_label = spaceLabel;
      extra.seats_label = seatsLabel;
      extra.space_display = spaceLabel ? `Space: ${spaceLabel}` : "";
      extra.seats_display = seatsLabel ? `Seats: ${seatsLabel}` : "";
      extra.plan_label = planLabel;
      extra.plan_display = planLabel ? `Plan: ${planLabel}` : "";
      extra.start_date_label = startDate;
      extra.start_date_display = startDate ? `Start Date: ${startDate}` : "";
      extra.amount = amount;
      extra.amount_display = `Amount: ${amount}`;
      extra.payment_note = "A payment link will be sent to this chat.";
      break;
    }
    case "THANK_YOU_DIRECTIONS":
      extra.user_name = userName;
      extra.heading_text = `${userName}, we've sent directions to this chat.`;
      extra.space_label = spaceLabel;
      extra.seats_label = seatsLabel;
      extra.space_display = spaceLabel ? `Space: ${spaceLabel}` : "";
      extra.seats_display = seatsLabel ? `Seats: ${seatsLabel}` : "";
      extra.address_line_1 = "Hoblix Coworking Space";
      extra.address_line_2 = "Near Najafgarh Metro Station, Najafgarh, Delhi - 110043";
      extra.landmarks = "Opposite Jain Mandir \u2022 2 min walk from Metro Gate 1";
      extra.timings = "Open Mon-Sat: 8 AM - 10 PM | Sun: 10 AM - 6 PM";
      extra.directions_action_label =
        DIRECTIONS_ACTION_LABELS[session.directions_action as string] || (session.directions_action as string) || "";
      break;
  }

  return { ...baseData, ...extra };
}

// ── Routing engine helpers ───────────────────────────────────────────────────

function evaluateRule(rule: FlowRoutingRule, data: Record<string, unknown>): boolean {
  const rawValue = data[rule.fieldName];
  switch (rule.operator) {
    case "eq":
      return String(rawValue ?? "") === (rule.fieldValue ?? "");
    case "neq":
      return String(rawValue ?? "") !== (rule.fieldValue ?? "");
    case "contains":
      return String(rawValue ?? "").includes(rule.fieldValue ?? "");
    case "gt":
      return Number(rawValue) > Number(rule.fieldValue ?? 0);
    case "lt":
      return Number(rawValue) < Number(rule.fieldValue ?? 0);
    case "exists":
      return rawValue !== undefined && rawValue !== null && rawValue !== "";
    default:
      return false;
  }
}

async function resolveRouting(
  db: Database,
  flowId: number,
  screenName: string,
  requestData: Record<string, unknown>,
): Promise<{ nextScreen: string; mergedData: Record<string, unknown> } | null> {
  const [screenDef] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.flowId, flowId), eq(flowScreensTable.screenId, screenName)))
    .limit(1);

  if (!screenDef) return null;

  const rules = await db
    .select()
    .from(flowRoutingRulesTable)
    .where(eq(flowRoutingRulesTable.screenDbId, screenDef.id))
    .orderBy(asc(flowRoutingRulesTable.priority));

  for (const rule of rules) {
    if (evaluateRule(rule, requestData)) {
      const injectData = (rule.injectData as Record<string, unknown>) ?? {};
      return { nextScreen: rule.nextScreen, mergedData: { ...requestData, ...injectData } };
    }
  }

  if (screenDef.defaultNextScreen) {
    return { nextScreen: screenDef.defaultNextScreen, mergedData: requestData };
  }

  return null;
}

async function getFirstScreen(
  db: Database,
  flowId: number,
): Promise<{ screen: FlowScreen | null; hasScreens: boolean }> {
  const [anyScreen] = await db
    .select()
    .from(flowScreensTable)
    .where(eq(flowScreensTable.flowId, flowId))
    .limit(1);

  if (!anyScreen) return { screen: null, hasScreens: false };

  const [firstScreen] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.flowId, flowId), eq(flowScreensTable.isFirst, true)))
    .limit(1);

  return { screen: firstScreen ?? null, hasScreens: true };
}

// ── User context resolution ──────────────────────────────────────────────────

function isBusinessName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("hoblix") ||
    lower === "hoblix coworking space" ||
    lower === "hoblix cowerking space" ||
    lower === "hoblix space"
  );
}

async function resolveContactName(
  db: Database,
  waPhone: string | null,
  flowToken: string | null,
): Promise<string | null> {
  if (waPhone) {
    try {
      const [convo] = await db
        .select({ contactName: conversationsTable.contactName })
        .from(conversationsTable)
        .where(eq(conversationsTable.phoneNumber, waPhone))
        .limit(1);
      if (convo?.contactName && !isBusinessName(convo.contactName)) {
        return convo.contactName;
      }
    } catch {
      // Non-fatal
    }
  }

  if (flowToken) {
    try {
      const parsed = JSON.parse(flowToken);
      console.log("FLOW_DEBUG resolveContactName: flowToken parsed:", JSON.stringify(parsed));
      if (parsed && typeof parsed.name === "string" && parsed.name.trim() && !isBusinessName(parsed.name)) {
        console.log("FLOW_DEBUG resolveContactName: returning name from flowToken:", parsed.name.trim());
        return parsed.name.trim();
      }
    } catch {
      console.log("FLOW_DEBUG resolveContactName: flowToken not JSON:", flowToken?.substring(0, 50));
    }
  }

  return null;
}

// ── Analytics helper ─────────────────────────────────────────────────────────

async function writeEvent(
  db: Database,
  flowId: number,
  tenantId: number,
  eventType: string,
  opts: { screenName?: string | null; waPhone?: string | null; metadata?: Record<string, unknown> } = {},
) {
  try {
    await db.insert(flowAnalyticsEventsTable).values({
      flowId,
      tenantId,
      eventType,
      screenName: opts.screenName ?? null,
      waPhone: opts.waPhone ?? null,
      metadata: opts.metadata ?? null,
    });
  } catch (err) {
    console.warn("Flow endpoint: failed to write analytics event", err);
  }
}

// ── Encrypted error helper (pre-decryption) ──────────────────────────────────

async function sendEncryptedError(
  errorCode: string,
  aesKeyRaw: Uint8Array | null,
  originalIv: Uint8Array | null,
): Promise<Response> {
  const key = aesKeyRaw ?? crypto.getRandomValues(new Uint8Array(16));
  const iv = originalIv ?? crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = await encryptFlowResponse({ error: errorCode }, key, iv);
  return new Response(ciphertext, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

// ── GET health check ─────────────────────────────────────────────────────────

app.get("/flows/endpoint/:tenantSlug/:flowSlug", (c) => {
  return c.json({ data: "test" });
});

// ── POST encrypted flow handler ──────────────────────────────────────────────

app.post("/flows/endpoint/:tenantSlug/:flowSlug", async (c) => {
  const db = createDb(getDbUrl(c.env));
  // Single raw postgres connection for all session operations in this request
  const pgRaw = createRawClient(getDbUrl(c.env));
  const encKey = c.env.BACKUP_ENCRYPTION_KEY;
  const tenantSlug = c.req.param("tenantSlug");
  const flowSlug = c.req.param("flowSlug");
  const body = await c.req.json<Partial<MetaFlowRequest>>();

  // ── Phase 1: validate body fields ──────────────────────────────────────────
  console.log(`Flow endpoint POST: ${tenantSlug}/${flowSlug}`, JSON.stringify(Object.keys(body)));
  if (!body.encrypted_aes_key || !body.encrypted_flow_data || !body.initial_vector) {
    console.warn(`Flow endpoint: missing encryption fields (${tenantSlug}/${flowSlug})`, JSON.stringify(body).substring(0, 200));
    return sendEncryptedError("endpoint_not_found", null, null);
  }

  // ── Phase 2+3: resolve tenant + RSA key (CACHED) ───────────────────────────
  let tenant: any;
  let rsaKey: any;

  const cachedTenant = getCachedTenant(tenantSlug ?? "");
  if (cachedTenant) {
    tenant = cachedTenant.tenant;
    rsaKey = cachedTenant.rsaKey;
  } else {
    const [t] = await db
      .select()
      .from(flowTenantsTable)
      .where(eq(flowTenantsTable.slug, tenantSlug ?? ""))
      .limit(1);

    if (!t) {
      console.warn(`Flow endpoint: unknown tenant ${tenantSlug}`);
      return sendEncryptedError("endpoint_not_found", null, null);
    }
    tenant = t;

    const [k] = await db
      .select()
      .from(flowRsaKeysTable)
      .where(and(eq(flowRsaKeysTable.tenantId, tenant.id), eq(flowRsaKeysTable.isActive, true)))
      .limit(1);

    if (!k) {
      console.error(`Flow endpoint: no active RSA key for tenant ${tenant.id}`);
      return sendEncryptedError("endpoint_not_found", null, null);
    }
    rsaKey = k;

    _tenantCache.set(tenantSlug ?? "", { tenant, rsaKey, ts: Date.now() });
  }

  // ── Phase 4: decrypt request (private key CACHED) ─────────────────────────
  let aesKeyRaw: Uint8Array;
  let iv: Uint8Array;
  let data: Record<string, unknown>;

  try {
    let privateKeyPem = getCachedPrivateKey(rsaKey.privateKeyEnc);
    if (!privateKeyPem) {
      privateKeyPem = await decryptPrivateKey(rsaKey.privateKeyEnc, encKey);
      setCachedPrivateKey(rsaKey.privateKeyEnc, privateKeyPem);
    }
    const result = await decryptFlowRequest(body as MetaFlowRequest, privateKeyPem);
    aesKeyRaw = result.aesKeyRaw;
    iv = result.iv;
    data = result.data;
  } catch (err: any) {
    console.error(`Flow endpoint: decryption failed (${tenantSlug}/${flowSlug}):`, err?.message ?? err);
    return sendEncryptedError("endpoint_not_found", null, null);
  }

  // ── Crypto context established ─────────────────────────────────────────────
  const sendEncrypted = async (payload: Record<string, unknown>) => {
    const ciphertext = await encryptFlowResponse(payload, aesKeyRaw, iv);
    return new Response(ciphertext, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  };

  const action = (data.action as string) ?? "";
  const version = (data.version as string) ?? "3.0";
  const screen = (data.screen as string) ?? "";
  const flowToken = (data.flow_token as string) ?? null;

  console.log(`FLOW_DEBUG: action=${action} screen=${screen} flowToken=${flowToken} keys=${Object.keys(data).join(",")}`);
  if (action === "INIT" || action === "data_exchange") {
    console.log(`FLOW_DEBUG data:`, JSON.stringify(data).substring(0, 500));
  }

  let waPhone = (data.wa_phone as string) ?? null;
  if (!waPhone && flowToken) {
    try {
      const parsed = JSON.parse(flowToken);
      if (parsed?.wa_id) waPhone = String(parsed.wa_id);
    } catch {
      /* plain string token */
    }
  }

  const accumulatedData = (data.data as Record<string, unknown>) ?? {};
  console.log(`FLOW_DEBUG: action=${action} screen=${screen} accumulatedData keys=${Object.keys(accumulatedData).join(",")} values=${JSON.stringify(accumulatedData).substring(0, 300)}`);

  // ── Phase 5: handle ping BEFORE flow resolution ────────────────────────────
  if (action === "ping") {
    console.info(`Flow endpoint: health check ping (${tenantSlug}/${flowSlug})`);
    return sendEncrypted({ version, data: { status: "active" } });
  }

  // ── Phase 6: resolve flow ──────────────────────────────────────────────────
  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.tenantId, tenant.id), eq(flowDefinitionsTable.slug, flowSlug ?? "")))
    .limit(1);

  if (!flow) {
    console.warn(`Flow endpoint: unknown flow (${tenantSlug}/${flowSlug})`);
    return sendEncrypted({ error: "endpoint_not_found" });
  }

  if (!flow.isActive) {
    console.warn(`Flow endpoint: inactive flow (${tenantSlug}/${flowSlug})`);
    return sendEncrypted({ error: "flow_inactive" });
  }

  // ── Flow-specific handlers (override generic routing) ──────────────────────
  if (flowSlug === "reschedule-call" || flowSlug === "reschedule_call") {
    const response = await handleRescheduleFlow({
      db,
      action,
      screen,
      flowToken,
      waPhone,
      data: accumulatedData,
      version,
      tenantId: tenant.id,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      env: c.env,
    });
    return sendEncrypted(response);
  }

  // ── Phase 7: emit analytics event (background — don't block response) ──────
  if (action !== "complete") {
    const analyticsType = action === "INIT" || action === "init" ? "init" : "screen_viewed";
    c.executionCtx.waitUntil(writeEvent(db, flow.id, tenant.id, analyticsType, {
      screenName: screen || null,
      waPhone,
      metadata: { action, version, screen },
    }));
  }

  // ── Phase 8: handle remaining actions ──────────────────────────────────────

  if (action === "INIT" || action === "init") {
    const { screen: firstScreen, hasScreens } = await getFirstScreen(db, flow.id);

    if (hasScreens && !firstScreen) {
      console.warn(`Flow endpoint: INIT but no isFirst=true screen (${tenantSlug}/${flowSlug})`);
      await writeEvent(db, flow.id, tenant.id, "error", {
        waPhone,
        metadata: { action, version, errorMessage: "no_first_screen_configured" },
      });
      return sendEncrypted({ error: "flow_misconfigured" });
    }

    if (firstScreen) {
      const contactName = await resolveContactName(db, waPhone, flowToken);

      await mergeSessionDb(pgRaw, flowToken, {
        ...(waPhone ? { _waPhone: waPhone } : {}),
        ...(contactName ? { prefilled_name: contactName } : {}),
      });

      const initData = (firstScreen.initData as Record<string, unknown>) ?? {};
      const responseData: Record<string, unknown> = {
        ...initData,
        ...(waPhone ? { whatsapp_number: waPhone } : {}),
        ...(contactName ? { prefilled_name: contactName } : {}),
      };

      console.info(`Flow endpoint: INIT -> ${firstScreen.screenId} (${tenantSlug}/${flowSlug})`);
      return sendEncrypted({ version, screen: firstScreen.screenId, data: responseData });
    } else {
      const responseData: Record<string, unknown> = waPhone ? { whatsapp_number: waPhone } : {};
      return sendEncrypted({ version, screen: screen || "MAIN", data: responseData });
    }
  }

  if (action === "complete") {
    console.info(`Flow endpoint: COMPLETE action received (${tenantSlug}/${flowSlug}) screen=${screen}`);
    // Read FULL session from DB using raw postgres
    let completeSessionData: Record<string, unknown>;
    try {
      await mergeSessionDb(pgRaw, flowToken, accumulatedData);
      const sessionKey = waPhone || (flowToken ? (() => { try { return JSON.parse(flowToken).wa_id; } catch { return flowToken; } })() : null);
      if (sessionKey) {
        const rows = await pgRaw`SELECT session_data FROM flow_sessions WHERE flow_token = ${sessionKey} LIMIT 1`;
        completeSessionData = rows.length > 0 ? (rows[0].session_data as Record<string, unknown>) : { ...accumulatedData };
      } else {
        completeSessionData = { ...accumulatedData };
      }
    } catch (sessErr) {
      console.error("Flow endpoint: session read failed in complete:", sessErr);
      completeSessionData = { ...accumulatedData };
    }
    const effectiveCompletePhone = waPhone || (completeSessionData._waPhone as string | null) || null;

    try {
      await db.insert(flowSubmissionsTable).values({
        flowId: flow.id,
        tenantId: tenant.id,
        waPhone: effectiveCompletePhone,
        flowToken,
        screenResponses: completeSessionData,
        completedAt: new Date(),
      });

      await writeEvent(db, flow.id, tenant.id, "completed", {
        screenName: screen || null,
        waPhone,
        metadata: { action, version, flowToken },
      });

      try {
        await pushSubmissionToIntegrations(
          db,
          flow.id,
          tenant.id,
          enrichForIntegrations(completeSessionData as Record<string, unknown>),
          effectiveCompletePhone,
        );
      } catch (err) {
        console.error("Flow endpoint: integration push failed", err);
      }
    } catch (storeErr) {
      console.error("Flow endpoint: failed to store submission", storeErr);
      await writeEvent(db, flow.id, tenant.id, "error", {
        screenName: screen || null,
        waPhone,
        metadata: { action, version, errorMessage: String(storeErr) },
      });
      return sendEncrypted({ error: "submission_failed" });
    }

    return sendEncrypted({
      version,
      screen: "SUCCESS",
      data: {
        extension_message_response: {
          params: { flow_token: flowToken },
        },
      },
    });
  }

  // ── navigate / back_to_screen / any other action ───────────────────────────
  try {
  // Workers are stateless — session map may be empty if a different isolate handles this request.
  // Always inject _waPhone and prefilled_name from flow_token into the session to be safe.
  const preSeeded: Record<string, unknown> = {};
  if (waPhone) preSeeded._waPhone = waPhone;
  if (flowToken) {
    try {
      const ftParsed = JSON.parse(flowToken);
      if (ftParsed?.name && typeof ftParsed.name === "string") {
        preSeeded.prefilled_name = ftParsed.name.trim();
      }
    } catch { /* plain string token */ }
  }
  // Single DB call: merge + return full session (RETURNING session_data)
  const fullSession = await mergeSessionDb(pgRaw, flowToken, { ...preSeeded, ...accumulatedData });
  const effectivePhone = (fullSession._waPhone as string) || waPhone || null;
  // Use session data for contact name — skip extra DB query
  const navContactName = (fullSession.prefilled_name as string) || (fullSession.name as string) || null;

  console.info(
    `Flow endpoint: navigate (${tenantSlug}/${flowSlug}) screen=${screen} phone=${effectivePhone} session=${Object.keys(fullSession).join(",")}`,
  );

  if (screen) {
    const routing = await resolveRouting(db, flow.id, screen, fullSession);

    if (routing) {
      const baseEnriched = buildScreenData(routing.nextScreen, fullSession, effectivePhone, navContactName);
      const finalData = enrichScreenData(routing.nextScreen, baseEnriched, fullSession);

      console.info(`Flow endpoint: ${screen} -> ${routing.nextScreen} (${tenantSlug}/${flowSlug})`, JSON.stringify(finalData).substring(0, 500));

      // Log analytics in background
      c.executionCtx.waitUntil(writeEvent(db, flow.id, tenant.id, "screen_viewed", {
        screenName: routing.nextScreen,
        waPhone: effectivePhone,
        metadata: { action, version, screen: routing.nextScreen, fromScreen: screen },
      }));

      // Trigger submission + integration push on terminal THANK_YOU screens
      if (routing.nextScreen.startsWith("THANK_YOU")) {
        console.info(`Flow endpoint: THANK_YOU reached with ${Object.keys(fullSession).length} fields: ${Object.keys(fullSession).join(",")}`);
        const enrichedSession = enrichForIntegrations(fullSession as Record<string, unknown>);
        if (effectivePhone) {
          const summary = buildFlowChatSummary(fullSession as Record<string, unknown>);
          await storePendingSummary(pgRaw, effectivePhone, summary);
        }
        console.info(`Flow endpoint: terminal ${routing.nextScreen} reached (${tenantSlug}/${flowSlug})`);

        // Return response IMMEDIATELY — do DB/Notion work in background
        const response = await sendEncrypted({ version, screen: routing.nextScreen, data: finalData });

        // Background work via waitUntil — runs after response is sent
        const bgFlowId = flow.id;
        const bgTenantId = tenant.id;
        c.executionCtx.waitUntil((async () => {
          try {
            await db.insert(flowSubmissionsTable).values({
              flowId: bgFlowId, tenantId: bgTenantId,
              waPhone: effectivePhone, flowToken,
              screenResponses: fullSession, completedAt: new Date(),
            });
            console.info(`Flow endpoint: submission stored (background)`);
          } catch (err: any) {
            if (!String(err).includes("unique") && !String(err).includes("duplicate")) {
              console.warn("Flow endpoint: submission insert failed:", err);
            }
          }
          try {
            await pushSubmissionToIntegrations(db, bgFlowId, bgTenantId, enrichedSession, effectivePhone);
            console.info(`Flow endpoint: Notion push completed (background)`);
          } catch (err) {
            console.error("Flow endpoint: Notion push failed:", err);
          }
        })());

        return response;
      }

      return sendEncrypted({ version, screen: routing.nextScreen, data: finalData });
    }
  }

  // Fallback: no routing rule
  const fallbackScreen = screen || "MAIN";
  const fallbackBase = buildScreenData(fallbackScreen, fullSession, effectivePhone, navContactName);
  const fallbackData = enrichScreenData(fallbackScreen, fallbackBase, fullSession);

  console.log(
    "FLOW_DEBUG navigate:",
    JSON.stringify({
      screen,
      targetScreen: fallbackScreen,
      sessionKeys: Object.keys(fullSession),
      enrichedKeys: Object.keys(fallbackData),
    }),
  );

  return sendEncrypted({ version, screen: fallbackScreen, data: fallbackData });
  } catch (navErr: any) {
    console.error(`Flow endpoint: NAVIGATE CRASHED (${tenantSlug}/${flowSlug}):`, navErr?.message, navErr?.stack?.substring(0, 500));
    await writeEvent(db, flow.id, tenant.id, "error", {
      screenName: screen || null,
      waPhone,
      metadata: { action, version, errorMessage: String(navErr) },
    }).catch(() => {});
    return sendEncrypted({ error: "endpoint_error" });
  }
});

export default app;
