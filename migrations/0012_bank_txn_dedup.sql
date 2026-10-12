-- Deduplication support for bank statement imports.
-- Fingerprint = org + bank account + date (day) + amount + normalized description.
-- Prevents duplicate rows on repeated imports while remaining idempotent.

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS import_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS import_source TEXT,
  ADD COLUMN IF NOT EXISTS external_reference TEXT;

-- Unique per org+account+fingerprint when fingerprint is present.
-- Existing rows keep NULL fingerprint and are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_transactions_fingerprint
  ON bank_transactions (organization_id, bank_account_id, import_fingerprint)
  WHERE import_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_transactions_account_date
  ON bank_transactions (organization_id, bank_account_id, txn_date DESC);
