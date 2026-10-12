-- Hero Accounting product hardening: one active company, notification indexes and settings.
-- Keep the oldest active company for users who previously had multiple active memberships.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC, id ASC) AS rn
  FROM memberships
  WHERE is_active = TRUE
)
UPDATE memberships m
SET is_active = FALSE
FROM ranked r
WHERE m.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_one_active_company_per_user
  ON memberships(user_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_notifications_user_org_created
  ON notifications(user_id, organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(user_id, organization_id, read_at)
  WHERE read_at IS NULL;

-- Keep currency country-driven. Existing organizations retain their country;
-- application providers resolve the default currency from country_code.

CREATE INDEX IF NOT EXISTS idx_invoices_org_created ON invoices(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bills_org_created ON bills(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_org ON bank_accounts(organization_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_date ON bank_transactions(organization_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date ON journal_entries(organization_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_memberships_user_org_active ON memberships(user_id, organization_id) WHERE is_active = TRUE;
