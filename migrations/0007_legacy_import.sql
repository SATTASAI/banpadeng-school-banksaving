-- Phase 6: one-time import of a legacy Apps Script "BPD School Bank" backup
-- (the .xlsx export produced by that system's own backup feature -- sheets
-- BANK_MEMBERS / ACCOUNTS / TRANSACTIONS). Same preview-then-confirm safety
-- pattern as graduation-purge and interest runs, except the token here does
-- NOT store the (potentially several-MB) parsed payload in D1 -- it stores
-- only a SHA-256 digest of the exact data the admin previewed. The browser
-- re-sends that same data on commit; the server re-normalizes it from
-- scratch and rejects the commit if the digest no longer matches, rather
-- than trusting a stale/edited payload.

CREATE TABLE IF NOT EXISTS legacy_import_tokens (
  token         TEXT PRIMARY KEY,
  admin_id      TEXT NOT NULL REFERENCES users(id),
  payload_hash  TEXT NOT NULL, -- sha256 hex of the canonicalized {members,accounts,transactions} JSON
  summary_json  TEXT NOT NULL, -- the preview summary shown to the admin, for the audit trail
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_legacy_import_tokens_expires_at ON legacy_import_tokens(expires_at);

CREATE TABLE IF NOT EXISTS legacy_import_log (
  id                    TEXT PRIMARY KEY,
  admin_id              TEXT NOT NULL REFERENCES users(id),
  imported_at           INTEGER NOT NULL,
  member_count          INTEGER NOT NULL,
  account_count         INTEGER NOT NULL,
  transaction_count     INTEGER NOT NULL,
  skipped_account_count INTEGER NOT NULL DEFAULT 0,
  adjustment_count      INTEGER NOT NULL DEFAULT 0,
  summary_json          TEXT
);
CREATE INDEX IF NOT EXISTS idx_legacy_import_log_imported_at ON legacy_import_log(imported_at);
