-- BPD School Bank -- Cloudflare D1 schema (Core Banking, Phase 1)
-- Money is stored as INTEGER satang (บาท * 100) everywhere to avoid
-- floating-point rounding errors. Convert to/from baht only at the API edge.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,      -- format: "<salt_hex>:<pbkdf2_hash_hex>"
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'TELLER', -- ADMIN | TELLER (extend as needed)
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id    TEXT NOT NULL REFERENCES users(id),
  permission TEXT NOT NULL,
  granted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Failed-login counters, replaces Apps Script's CacheService lockout.
CREATE TABLE IF NOT EXISTS login_failures (
  username    TEXT PRIMARY KEY,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS locations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Account holder. Kept intentionally lightweight for Phase 1 -- this is a
-- standalone Bank project (its own login, per the decision to keep bank
-- users separate from banpadeng-school-db), so it carries just enough
-- identity to open/search an account rather than a full student registry.
CREATE TABLE IF NOT EXISTS members (
  id               TEXT PRIMARY KEY,
  school_student_id TEXT,
  prefix           TEXT,
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  grade            TEXT,
  room             TEXT,
  status           TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | GRADUATED
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_school_student_id ON members(school_student_id);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(first_name, last_name);

CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  account_no   TEXT NOT NULL UNIQUE,
  member_id    TEXT NOT NULL REFERENCES members(id),
  account_type TEXT NOT NULL DEFAULT 'SAVINGS', -- SAVINGS | SHARE
  status       TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | CLOSED
  balance      INTEGER NOT NULL DEFAULT 0,      -- satang
  opened_at    INTEGER NOT NULL,
  closed_at    INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_member_id ON accounts(member_id);
CREATE INDEX IF NOT EXISTS idx_accounts_account_no ON accounts(account_no);

CREATE TABLE IF NOT EXISTS bank_sessions (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | CLOSED
  opened_at  INTEGER NOT NULL,
  opened_by  TEXT NOT NULL REFERENCES users(id),
  closed_at  INTEGER,
  closed_by  TEXT REFERENCES users(id),
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_sessions_status ON bank_sessions(status);

CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  bank_session_id  TEXT NOT NULL REFERENCES bank_sessions(id),
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  type             TEXT NOT NULL,   -- DEPOSIT | WITHDRAW
  amount           INTEGER NOT NULL, -- satang, always positive
  balance_before   INTEGER NOT NULL,
  balance_after    INTEGER NOT NULL,
  location_id      TEXT REFERENCES locations(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  note             TEXT,
  request_id       TEXT UNIQUE, -- idempotency key from the client
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_bank_session_id ON transactions(bank_session_id);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  description TEXT,
  updated_by  TEXT,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- No seed admin row here on purpose: a PBKDF2 hash can't be hand-written
-- into a .sql file. The first admin account is created by calling
-- POST /api/setup once after deploying (see README) -- it only works while
-- the users table is empty, then refuses to run again.
