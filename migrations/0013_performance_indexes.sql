-- Performance indexes for common list/filter queries (tenant-scoped)
-- Safe to re-run: IF NOT EXISTS

CREATE INDEX IF NOT EXISTS idx_invoices_org_created
  ON invoices (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_org_status
  ON invoices (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_bills_org_created
  ON bills (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bills_org_status
  ON bills (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_date
  ON bank_transactions (organization_id, txn_date DESC);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_status
  ON bank_transactions (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_contacts_org_name
  ON contacts (organization_id, name);

CREATE INDEX IF NOT EXISTS idx_documents_org_created
  ON documents (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date
  ON journal_entries (organization_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_memberships_user
  ON memberships (user_id);
