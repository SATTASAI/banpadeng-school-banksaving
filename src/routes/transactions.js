import { requirePermission, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';

const MAX_TX_SATANG = 1000000 * 100; // ฿1,000,000 per transaction, same ceiling as the old system

async function getActiveBankSession(env) {
  return env.DB.prepare("SELECT id FROM bank_sessions WHERE status = 'OPEN' LIMIT 1").first();
}

export async function handleDeposit(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_DEPOSIT');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const accountId = String(body.accountId || '').trim();
  const locationId = String(body.locationId || '').trim() || null;
  const amount = Math.round(Number(body.amountSatang || 0));
  const note = String(body.note || '').trim().slice(0, 300);
  const requestId = String(body.requestId || '').trim() || null;

  if (!accountId) return jsonError('ไม่พบบัญชีที่ต้องการฝาก');
  if (!Number.isFinite(amount) || amount <= 0) return jsonError('จำนวนเงินฝากต้องมากกว่า 0 บาท');
  if (amount > MAX_TX_SATANG) return jsonError('ยอดฝากต่อรายการสูงผิดปกติ กรุณาตรวจสอบจำนวนเงิน');

  // Idempotency: if this requestId was already processed, return that result
  // instead of depositing twice (protects against double-submit / retry).
  if (requestId) {
    const existing = await env.DB.prepare('SELECT * FROM transactions WHERE request_id = ?').bind(requestId).first();
    if (existing) return jsonOk(txResponse(existing, true));
  }

  const bankSession = await getActiveBankSession(env);
  if (!bankSession) return jsonError('ขณะนี้ Bank Session ปิดอยู่ ไม่สามารถรับฝากได้');

  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
  if (!account) return jsonError('ไม่พบบัญชี');
  if (account.status !== 'ACTIVE') return jsonError('บัญชีนี้ปิดใช้งานแล้ว ไม่สามารถฝากเงินได้');

  const now = Date.now();
  const txId = newId('TX');

  // A single conditional UPDATE (status must still be ACTIVE) plus the
  // transaction insert, run together as one atomic D1 batch. There is no
  // per-row lock like Apps Script's LockService.getScriptLock() here, but
  // none is needed for a deposit: it's a pure addition, so two concurrent
  // deposits on the same account just serialize at the SQLite row level.
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
      .bind(amount, now, accountId),
    env.DB.prepare(
      `INSERT INTO transactions (id, bank_session_id, account_id, type, amount, balance_before, balance_after, location_id, user_id, note, request_id, created_at)
       VALUES (?, ?, ?, 'DEPOSIT', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(txId, bankSession.id, accountId, amount, account.balance, account.balance + amount, locationId, user.id, note, requestId, now)
  ]);

  await writeAuditLog(env, user.id, 'DEPOSIT', 'ACCOUNT', accountId, { txId, amount, before: account.balance, after: account.balance + amount });

  const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(txId).first();
  return jsonOk(txResponse(tx, false));
}

export async function handleWithdraw(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_WITHDRAW');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const accountId = String(body.accountId || '').trim();
  const locationId = String(body.locationId || '').trim() || null;
  const amount = Math.round(Number(body.amountSatang || 0));
  const note = String(body.note || '').trim().slice(0, 300);
  const requestId = String(body.requestId || '').trim() || null;

  if (!accountId) return jsonError('กรุณาเลือกบัญชีที่ต้องการถอน');
  if (!Number.isFinite(amount) || amount <= 0) return jsonError('จำนวนเงินถอนต้องมากกว่า 0 บาท');
  if (amount > MAX_TX_SATANG) return jsonError('ยอดถอนต่อรายการสูงผิดปกติ กรุณาตรวจสอบจำนวนเงิน');

  if (requestId) {
    const existing = await env.DB.prepare('SELECT * FROM transactions WHERE request_id = ?').bind(requestId).first();
    if (existing) return jsonOk(txResponse(existing, true));
  }

  const withdrawLimit = await getWithdrawLimitSatang(env);
  if (withdrawLimit != null && amount > withdrawLimit) {
    const canOverride = await requirePermissionSilently(env, user, 'CAN_WITHDRAW_OVER_LIMIT');
    if (!canOverride) {
      return jsonError(`ยอดถอนเกินวงเงิน ${(withdrawLimit / 100).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท`);
    }
  }

  const bankSession = await getActiveBankSession(env);
  if (!bankSession) return jsonError('Bank Session ปิดอยู่ ไม่สามารถถอนเงินได้');

  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
  if (!account) return jsonError('ไม่พบบัญชี');
  if (account.status !== 'ACTIVE') return jsonError('บัญชีนี้ปิดใช้งานแล้ว ไม่สามารถถอนเงินได้');
  if (account.account_type === 'SHARE') return jsonError('บัญชีออมหุ้นไม่สามารถถอนผ่านเมนูถอนเงินปกติ');

  const now = Date.now();
  const txId = newId('TX');

  // The WHERE clause (status='ACTIVE' AND balance >= amount) makes this a
  // single atomic "check-and-decrement": D1/SQLite guarantees the read and
  // write of `balance` happen as one indivisible statement, so two
  // concurrent withdrawals on the same account can never both succeed and
  // push the balance negative -- no global lock required.
  const updateResult = await env.DB
    .prepare("UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE' AND balance >= ?")
    .bind(amount, now, accountId, amount)
    .run();

  if (!updateResult.meta || updateResult.meta.changes === 0) {
    return jsonError(`ยอดเงินคงเหลือไม่เพียงพอ ยอดคงเหลือ ${(account.balance / 100).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท`);
  }

  await env.DB.prepare(
    `INSERT INTO transactions (id, bank_session_id, account_id, type, amount, balance_before, balance_after, location_id, user_id, note, request_id, created_at)
     VALUES (?, ?, ?, 'WITHDRAW', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(txId, bankSession.id, accountId, amount, account.balance, account.balance - amount, locationId, user.id, note, requestId, now).run();

  await writeAuditLog(env, user.id, 'WITHDRAW', 'ACCOUNT', accountId, { txId, amount, before: account.balance, after: account.balance - amount });

  const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(txId).first();
  return jsonOk(txResponse(tx, false));
}

export async function handleListTransactions(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_VIEW_TRANSACTIONS');
  if (error) return error;

  const url = new URL(request.url);
  const accountId = url.searchParams.get('accountId');
  const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));

  const query = accountId
    ? env.DB.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').bind(accountId, limit)
    : env.DB.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?').bind(limit);

  const { results } = await query.all();
  return jsonOk({ transactions: results.map((t) => txResponse(t, false)) });
}

function txResponse(tx, duplicateRequest) {
  return {
    duplicateRequest,
    txId: tx.id,
    accountId: tx.account_id,
    type: tx.type,
    amountSatang: tx.amount,
    balanceBeforeSatang: tx.balance_before,
    balanceAfterSatang: tx.balance_after,
    note: tx.note,
    createdAt: tx.created_at
  };
}

async function getWithdrawLimitSatang(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'WITHDRAW_LIMIT_SATANG'").first();
  if (!row || row.value === null || row.value === '') return null;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function requirePermissionSilently(env, user, permission) {
  if (user.role === 'ADMIN') return true;
  const row = await env.DB.prepare('SELECT granted FROM user_permissions WHERE user_id = ? AND permission = ?')
    .bind(user.id, permission)
    .first();
  return !!(row && row.granted);
}
