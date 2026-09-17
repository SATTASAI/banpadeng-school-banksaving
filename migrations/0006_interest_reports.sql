-- Phase 5: Interest/dividend crediting + reporting support.
-- All money columns are INTEGER satang, consistent with earlier migrations.

-- Short-lived preview token, same safety pattern as graduation_preview_tokens
-- in 0003_academic_year.sql: bound to the admin who previewed it, snapshot of
-- affected accounts taken at preview time, amounts recomputed against
-- CURRENT balances at execute time (skipping anything that changed or is no
-- longer eligible in between), 5-minute expiry.
CREATE TABLE IF NOT EXISTS interest_preview_tokens (
  token            TEXT PRIMARY KEY,
  admin_id         TEXT NOT NULL REFERENCES users(id),
  account_type     TEXT NOT NULL, -- SAVINGS | SHARE
  rate_bps         INTEGER NOT NULL,
  period_label     TEXT NOT NULL,
  account_ids_json TEXT NOT NULL, -- eligible account ids snapshot at preview time
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interest_preview_tokens_expires_at ON interest_preview_tokens(expires_at);

CREATE TABLE IF NOT EXISTS interest_runs (
  id                TEXT PRIMARY KEY,
  account_type      TEXT NOT NULL, -- SAVINGS | SHARE
  tx_type           TEXT NOT NULL, -- INTEREST | DIVIDEND (matches transactions.type)
  rate_bps          INTEGER NOT NULL,
  period_label      TEXT NOT NULL,
  run_by            TEXT NOT NULL REFERENCES users(id),
  run_at            INTEGER NOT NULL,
  account_count     INTEGER NOT NULL,
  skipped_count     INTEGER NOT NULL DEFAULT 0,
  total_amount_satang INTEGER NOT NULL,
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_interest_runs_run_at ON interest_runs(run_at);

CREATE TABLE IF NOT EXISTS interest_run_items (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES interest_runs(id),
  account_id        TEXT NOT NULL REFERENCES accounts(id),
  tx_id             TEXT NOT NULL REFERENCES transactions(id),
  balance_before_satang INTEGER NOT NULL,
  amount_satang     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interest_run_items_run_id ON interest_run_items(run_id);
