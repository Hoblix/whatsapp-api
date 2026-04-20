import postgres from "postgres";

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

  const isProduction = process.env.NODE_ENV === "production";
  const sql = postgres(databaseUrl, {
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });

  try {
    console.log("🔄 Running DB migrations...");

    await sql`
      CREATE TABLE IF NOT EXISTS allowed_users (
        id SERIAL PRIMARY KEY,
        phone_number TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'user',
        added_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS otp_codes (
        id SERIAL PRIMARY KEY,
        phone_number TEXT NOT NULL,
        otp_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        phone_number TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        key_prefix TEXT,
        name TEXT NOT NULL DEFAULT 'Default',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ip_allowlist (
        id SERIAL PRIMARY KEY,
        ip TEXT NOT NULL UNIQUE,
        label TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        added_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        phone_number TEXT NOT NULL UNIQUE,
        contact_name TEXT,
        email TEXT,
        notes TEXT,
        tags TEXT,
        last_message TEXT,
        last_message_at TIMESTAMPTZ,
        unread_count INTEGER NOT NULL DEFAULT 0,
        ad_referral JSONB,
        ad_source TEXT,
        source_type TEXT DEFAULT 'organic',
        source_platform TEXT,
        campaign_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id),
        wa_message_id TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        message_type TEXT NOT NULL DEFAULT 'text',
        body TEXT,
        media_url TEXT,
        status TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        raw_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Seed super admin from env if provided
    const superAdminPhone = process.env.SUPER_ADMIN_PHONE;
    if (superAdminPhone) {
      const digits = superAdminPhone.replace(/\D/g, "");
      const normalized = digits.length === 10 ? `91${digits}` : digits;
      await sql`
        INSERT INTO allowed_users (phone_number, role)
        VALUES (${normalized}, 'super_admin')
        ON CONFLICT (phone_number) DO NOTHING
      `;
      console.log(`✅ Super admin seeded: ${normalized}`);
    }

    console.log("✅ DB migrations complete");
  } finally {
    await sql.end();
  }
}
