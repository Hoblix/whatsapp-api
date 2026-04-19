CREATE TABLE IF NOT EXISTS template_media (
  template_name text PRIMARY KEY,
  media_url text NOT NULL,
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
