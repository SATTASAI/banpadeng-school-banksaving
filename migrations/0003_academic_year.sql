-- Phase 3: Academic year promotion / graduation-purge.
-- Mirrors the safety pattern from the old Apps Script version: a short-lived
-- preview token bound to the admin who requested it, and a pre-purge backup
-- (tombstone) row so a graduation batch can always be audited/recovered.

CREATE TABLE IF NOT EXISTS graduation_preview_tokens (
  token           TEXT PRIMARY KEY,
  admin_id        TEXT NOT NULL REFERENCES users(id),
  grade           TEXT NOT NULL,
  member_ids_json TEXT NOT NULL, -- eligible (non-blocked) member ids snapshot
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grad_tokens_expires_at ON graduation_preview_tokens(expires_at);

CREATE TABLE IF NOT EXISTS graduation_batches (
  id              TEXT PRIMARY KEY,
  grade           TEXT NOT NULL,
  executed_by     TEXT NOT NULL REFERENCES users(id),
  executed_at     INTEGER NOT NULL,
  member_count    INTEGER NOT NULL,
  snapshot_json   TEXT NOT NULL, -- full member+account snapshot before purge, for audit/recovery
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_graduation_batches_executed_at ON graduation_batches(executed_at);
