/**
 * Credential Store — encrypts/decrypts credentials in the DB.
 * Uses AES-256-GCM with the CREDENTIAL_ENCRYPTION_KEY (or BACKUP_ENCRYPTION_KEY) env var.
 * In-memory cache with 5-minute TTL to avoid DB hits on every request.
 */

import { eq } from "drizzle-orm";
import type { Database } from "./db";
import { appCredentialsTable } from "./schema";

// ── Encryption helpers (Web Crypto API — works in Workers + Node 20+) ──

async function deriveKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret.padEnd(32, "0").slice(0, 32)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return keyMaterial;
}

export async function encryptValue(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  // Store as base64: iv:ciphertext
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}:${ctB64}`;
}

export async function decryptValue(encrypted: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const [ivB64, ctB64] = encrypted.split(":");
  if (!ivB64 || !ctB64) throw new Error("Invalid encrypted format");
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuffer);
}

// ── Mask for display ──

export function maskValue(value: string): string {
  if (value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "...••••";
}

// ── In-memory cache ──

interface CacheEntry {
  credentials: Map<string, string>; // key → decrypted value
  ts: number;
}

let _cache: CacheEntry | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get a single credential value by key. Returns env var fallback if not in DB.
 */
export async function getCredential(
  db: Database,
  key: string,
  encryptionKey: string,
  envFallback?: string,
): Promise<string> {
  // Check cache first
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) {
    const cached = _cache.credentials.get(key);
    if (cached !== undefined) return cached;
  }

  // Query DB
  const [row] = await db
    .select()
    .from(appCredentialsTable)
    .where(eq(appCredentialsTable.key, key))
    .limit(1);

  if (row) {
    try {
      const value = await decryptValue(row.encryptedValue, encryptionKey);
      // Update cache
      if (!_cache || Date.now() - _cache.ts >= CACHE_TTL) {
        _cache = { credentials: new Map(), ts: Date.now() };
      }
      _cache.credentials.set(key, value);
      return value;
    } catch (e) {
      console.error(`[credentialStore] Failed to decrypt ${key}:`, e);
    }
  }

  return envFallback ?? "";
}

/**
 * Load ALL credentials into cache at once (bulk load on startup or cache miss).
 */
export async function loadAllCredentials(
  db: Database,
  encryptionKey: string,
): Promise<Map<string, string>> {
  const rows = await db.select().from(appCredentialsTable);
  const map = new Map<string, string>();

  for (const row of rows) {
    try {
      const value = await decryptValue(row.encryptedValue, encryptionKey);
      map.set(row.key, value);
    } catch {
      console.error(`[credentialStore] Failed to decrypt ${row.key}`);
    }
  }

  _cache = { credentials: map, ts: Date.now() };
  return map;
}

/**
 * Invalidate the cache (call after updating a credential).
 */
export function invalidateCache(): void {
  _cache = null;
}

// ── Credential definitions (for the UI) ──

export interface CredentialDefinition {
  key: string;
  label: string;
  category: string;
  description: string;
}

export const CREDENTIAL_DEFINITIONS: CredentialDefinition[] = [
  // WhatsApp API
  { key: "WHATSAPP_ACCESS_TOKEN", label: "Access Token", category: "whatsapp", description: "Meta System User token with whatsapp_business_messaging permission" },
  { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone Number ID", category: "whatsapp", description: "From WhatsApp Manager → API Setup" },
  { key: "WHATSAPP_WABA_ID", label: "WABA ID", category: "whatsapp", description: "WhatsApp Business Account ID" },
  { key: "WHATSAPP_APP_SECRET", label: "App Secret", category: "whatsapp", description: "Meta App → Settings → Basic → App Secret" },
  { key: "WHATSAPP_VERIFY_TOKEN", label: "Verify Token", category: "whatsapp", description: "Webhook verification token" },

  // Meta Ads
  { key: "META_ADS_ACCESS_TOKEN", label: "Ads Access Token", category: "meta_ads", description: "System User token with ads_management permission" },
  { key: "META_AD_ACCOUNT_ID", label: "Ad Account ID", category: "meta_ads", description: "Format: act_XXXXX" },

  // Push Notifications
  { key: "VAPID_PUBLIC_KEY", label: "VAPID Public Key", category: "push", description: "Web Push VAPID public key" },
  { key: "VAPID_PRIVATE_KEY", label: "VAPID Private Key", category: "push", description: "Web Push VAPID private key" },
  { key: "VAPID_SUBJECT", label: "VAPID Subject", category: "push", description: "mailto: or https: URL" },

  // Auth
  { key: "SUPER_ADMIN_PHONE", label: "Super Admin Phone", category: "auth", description: "Phone number with country code (e.g. 919654677563)" },
  { key: "OTP_TEMPLATE_NAME", label: "OTP Template Name", category: "auth", description: "WhatsApp template name for OTP" },
  { key: "OTP_TEMPLATE_LANG", label: "OTP Template Language", category: "auth", description: "Language code (e.g. en)" },

  // Integrations
  { key: "MAKE_WEBHOOK_SECRET", label: "Make Webhook Secret", category: "integrations", description: "Shared secret for Make.com webhook authentication" },

  // Encryption
  { key: "BACKUP_ENCRYPTION_KEY", label: "Backup Encryption Key", category: "encryption", description: "AES key for backup encryption" },
];

export const CATEGORY_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp API",
  meta_ads: "Meta Ads",
  push: "Push Notifications",
  auth: "Authentication",
  integrations: "Integrations",
  encryption: "Encryption",
  general: "General",
};
