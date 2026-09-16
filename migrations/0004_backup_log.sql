-- Phase 4: backup/export audit trail.
CREATE TABLE IF NOT EXISTS backup_log (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL, -- EXPORT | RESTORE
  user_id    TEXT NOT NULL REFERENCES users(id),
  table_counts_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backup_log_created_at ON backup_log(created_at);
