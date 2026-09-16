import { requirePermission, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';

export async function handleOpenBankSession(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_OPEN_BANK_SESSION');
  if (error) return error;

  const existing = await env.DB.prepare("SELECT id FROM bank_sessions WHERE status = 'OPEN' LIMIT 1").first();
  if (existing) return jsonError('มี Bank Session เปิดอยู่แล้ว');

  const body = await request.json().catch(() => ({}));
  const note = String(body.note || '').trim().slice(0, 300);

  const id = newId('BS');
  const now = Date.now();

  await env.DB.prepare('INSERT INTO bank_sessions (id, status, opened_at, opened_by, note) VALUES (?, ?, ?, ?, ?)')
    .bind(id, 'OPEN', now, user.id, note)
    .run();

  await writeAuditLog(env, user.id, 'OPEN_BANK_SESSION', 'BANK_SESSION', id, { note });

  return jsonOk({ bankSessionId: id, openedAt: now });
}

export async function handleCloseBankSession(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_CLOSE_BANK_SESSION');
  if (error) return error;

  const session = await env.DB.prepare("SELECT id FROM bank_sessions WHERE status = 'OPEN' LIMIT 1").first();
  if (!session) return jsonError('ไม่พบ Bank Session ที่เปิดอยู่');

  const body = await request.json().catch(() => ({}));
  const note = String(body.note || '').trim().slice(0, 300);
  const now = Date.now();

  const totals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END), 0) as total_deposit,
       COALESCE(SUM(CASE WHEN type = 'WITHDRAW' THEN amount ELSE 0 END), 0) as total_withdraw,
       COUNT(*) as tx_count
     FROM transactions WHERE bank_session_id = ?`
  ).bind(session.id).first();

  await env.DB.prepare('UPDATE bank_sessions SET status = ?, closed_at = ?, closed_by = ?, note = ? WHERE id = ?')
    .bind('CLOSED', now, user.id, note, session.id)
    .run();

  await writeAuditLog(env, user.id, 'CLOSE_BANK_SESSION', 'BANK_SESSION', session.id, { ...totals });

  return jsonOk({
    bankSessionId: session.id,
    closedAt: now,
    totalDepositSatang: totals.total_deposit,
    totalWithdrawSatang: totals.total_withdraw,
    transactionCount: totals.tx_count
  });
}

export async function handleActiveBankSession(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_VIEW_TRANSACTIONS');
  if (error) return error;

  const session = await env.DB.prepare("SELECT * FROM bank_sessions WHERE status = 'OPEN' LIMIT 1").first();
  return jsonOk({ bankSession: session || null });
}

export async function handleListLocations(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_VIEW_TRANSACTIONS');
  if (error) return error;

  const { results } = await env.DB
    .prepare('SELECT id, name, type, sort_order FROM locations WHERE active = 1 ORDER BY sort_order')
    .all();

  return jsonOk({ locations: results.map((r) => ({ locationId: r.id, name: r.name, type: r.type })) });
}
