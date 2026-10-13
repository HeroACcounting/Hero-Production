-- Company / organization logo
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS logo_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
