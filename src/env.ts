export const META_GRAPH_API_VERSION = "v22.0";

export interface Env {
  // Cloudflare vars
  NODE_ENV: string;

  // Database
  DATABASE_URL: string;
  HYPERDRIVE: { connectionString: string };

  // Durable Object: WebSocket hub for real-time push to dashboard
  WEBHOOK_HUB: DurableObjectNamespace;

  // Durable Object: Scheduled reminders (alarm per booking)
  BOOKING_REMINDER: DurableObjectNamespace;

  // WhatsApp API
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_WABA_ID: string;
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_APP_SECRET: string;

  // Auth
  SUPER_ADMIN_PHONE: string;

  // Encryption
  BACKUP_ENCRYPTION_KEY: string;

  // Push Notifications
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;

  // OTP Template
  OTP_TEMPLATE_NAME: string;
  OTP_TEMPLATE_LANG: string;

  // Meta Ads API
  META_ADS_ACCESS_TOKEN: string;
  META_AD_ACCOUNT_ID: string;

  // Webhook secret for Make.com / external callers
  MAKE_WEBHOOK_SECRET: string;

  // Config
  ALLOWED_ORIGINS: string;
}

export type HonoEnv = {
  Bindings: Env;
  Variables: {
    authPhone?: string;
    adminPhone?: string;
    clientIp?: string;
  };
};
