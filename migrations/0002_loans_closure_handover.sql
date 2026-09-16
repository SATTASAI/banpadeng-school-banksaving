-- Phase 2: Loan module, account closure/transaction correction, cash handover.
-- All money columns are INTEGER satang, consistent with 0001_init.sql.

CREATE TABLE IF NOT EXISTS loan_products (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  interest_method           TEXT NOT NULL DEFAULT 'FLAT', -- FLAT | DECLINING
  annual_interest_rate_bps  INTEGER NOT NULL DEFAULT 0,   -- basis points, 500 = 5.00% ต่อปี
  late_fee_satang           INTEGER NOT NULL DEFAULT 0,   -- ค่าปรับต่องวดที่เกินกำหนด (ประเมินครั้งเดียวต่องวด)
  max_principal_satang      INTEGER,
  active                    INTEGER NOT NULL DEFAULT 1,
  created_at                INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id                        TEXT PRIMARY KEY,
  loan_no                   TEXT NOT NULL UNIQUE,
  member_id                 TEXT NOT NULL REFERENCES members(id),
  loan_product_id           TEXT NOT NULL REFERENCES loan_products(id),
  principal_satang          INTEGER NOT NULL,
  term_months               INTEGER NOT NULL,
  interest_method           TEXT NOT NULL,
  annual_interest_rate_bps  INTEGER NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|REJECTED|DISBURSED|CLOSED
  applied_at                INTEGER NOT NULL,
  applied_by                TEXT NOT NULL REFERENCES users(id),
  approved_at               INTEGER,
  approved_by               TEXT REFERENCES users(id),
  rejected_reason           TEXT,
  disbursed_at              INTEGER,
  disbursed_by              TEXT REFERENCES users(id),
  disburse_account_id       TEXT REFERENCES accounts(id),
  closed_at                 INTEGER,
  note                      TEXT
);
CREATE INDEX IF NOT EXISTS idx_loans_member_id ON loans(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);

CREATE TABLE IF NOT EXISTS loan_schedule (
  id                    TEXT PRIMARY KEY,
  loan_id               TEXT NOT NULL REFERENCES loans(id),
  installment_no        INTEGER NOT NULL,
  due_date              INTEGER NOT NULL,
  principal_due_satang  INTEGER NOT NULL,
  interest_due_satang   INTEGER NOT NULL,
  principal_paid_satang INTEGER NOT NULL DEFAULT 0,
  interest_paid_satang  INTEGER NOT NULL DEFAULT 0,
  late_fee_due_satang   INTEGER NOT NULL DEFAULT 0,
  late_fee_paid_satang  INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'PENDING' -- PENDING|PARTIAL|PAID
);
CREATE INDEX IF NOT EXISTS idx_loan_schedule_loan_id ON loan_schedule(loan_id);

CREATE TABLE IF NOT EXISTS loan_payments (
  id                        TEXT PRIMARY KEY,
  loan_id                   TEXT NOT NULL REFERENCES loans(id),
  amount_satang             INTEGER NOT NULL,
  principal_applied_satang  INTEGER NOT NULL DEFAULT 0,
  interest_applied_satang   INTEGER NOT NULL DEFAULT 0,
  late_fee_applied_satang   INTEGER NOT NULL DEFAULT 0,
  user_id                   TEXT NOT NULL REFERENCES users(id),
  note                      TEXT,
  request_id                TEXT UNIQUE,
  created_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loan_payments_loan_id ON loan_payments(loan_id);

CREATE TABLE IF NOT EXISTS cash_handovers (
  id             TEXT PRIMARY KEY,
  from_user_id   TEXT NOT NULL REFERENCES users(id),
  to_user_id     TEXT NOT NULL REFERENCES users(id),
  amount_satang  INTEGER NOT NULL,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | CONFIRMED | CANCELLED
  created_at     INTEGER NOT NULL,
  confirmed_at   INTEGER,
  bank_session_id TEXT REFERENCES bank_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_cash_handovers_to_user ON cash_handovers(to_user_id, status);

-- Transaction correction/void support.
ALTER TABLE transactions ADD COLUMN reversed_by_tx_id TEXT;
ALTER TABLE transactions ADD COLUMN reversal_of_tx_id TEXT;
ALTER TABLE transactions ADD COLUMN void_reason TEXT;
