-- Bug fix, discovered while building Phase 5: accounts.js handleOpenAccount
-- already inserts bank_session_id = NULL for the OPENING_DEPOSIT transaction
-- created when an account is opened with a starting balance (opening an
-- account happens outside any teller's Bank Session). But the original
-- 0001_init.sql schema declared bank_session_id NOT NULL, so that insert
-- would be rejected by D1/SQLite in production -- opening any account with
-- an opening balance > 0 would fail.
--
-- Phase 5's interest/dividend crediting (0006_interest_reports.sql) has the
-- exact same need (a bank-wide interest run is not tied to any one teller's
-- open Bank Session either), so this fixes the constraint before that code
-- relies on it. SQLite has no ALTER COLUMN, so this rebuilds the table --
-- standard SQLite pattern, safe to run even if the table already has rows.

PRAGMA foreign_keys=OFF;

CREATE TABLE transactions_new (
  id                TEXT PRIMARY KEY,
  bank_session_id   TEXT REFERENCES bank_sessions(id), -- was NOT NULL
  account_id        TEXT NOT NULL REFERENCES accounts(id),
  type              TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  balance_before    INTEGER NOT NULL,
  balance_after     INTEGER NOT NULL,
  location_id       TEXT REFERENCES locations(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  note              TEXT,
  request_id        TEXT UNIQUE,
  created_at        INTEGER NOT NULL,
  reversed_by_tx_id TEXT,
  reversal_of_tx_id TEXT,
  void_reason       TEXT
);

INSERT INTO transactions_new
  (id, bank_session_id, account_id, type, amount, balance_before, balance_after,
   location_id, user_id, note, request_id, created_at,
   reversed_by_tx_id, reversal_of_tx_id, void_reason)
SELECT id, bank_session_id, account_id, type, amount, balance_before, balance_after,
       location_id, user_id, note, request_id, created_at,
       reversed_by_tx_id, reversal_of_tx_id, void_reason
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_bank_session_id ON transactions(bank_session_id);

PRAGMA foreign_keys=ON;
