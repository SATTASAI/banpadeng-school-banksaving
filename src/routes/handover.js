import { requirePermission, requireSession, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';

export async function handleCreateHandover(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_HANDOVER_CASH');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const toUserId = String(body.toUserId || '').trim();
  const amount = Math.round(Number(body.amountSatang || 0));
  const note = String(body.note || '').trim().slice(0, 300);

  if (!toUserId) return jsonError('กรุณาเลือกผู้รับมอบเงินสด');
  if (toUserId === user.id) return jsonError('ไม่สามารถส่งมอบเงินสดให้ตัวเองได้');
  if (!Number.isFinite(amount) || amount <= 0) return jsonError('กรุณากรอกจำนวนเงินให้ถูกต้อง');

  const toUser = await env.DB.prepare('SELECT id, active FROM users WHERE id = ?').bind(toUserId).first();
  if (!toUser || !toUser.active) return jsonError('ไม่พบผู้ใช้งานปลายทาง หรือถูกระงับการใช้งาน');

  const activeSession = await env.DB.prepare("SELECT id FROM bank_sessions WHERE status = 'OPEN' LIMIT 1").first();

  const id = newId('HO');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO cash_handovers (id, from_user_id, to_user_id, amount_satang, note, status, created_at, bank_session_id)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
  ).bind(id, user.id, toUserId, amount, note, now, activeSession ? activeSession.id : null).run();

  await writeAuditLog(env, user.id, 'CREATE_CASH_HANDOVER', 'CASH_HANDOVER', id, { toUserId, amount });

  return jsonOk({ handoverId: id });
}

export async function handleListHandovers(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_HANDOVER_CASH');
  if (error) return error;

  const { results } = await env.DB.prepare(
    `SELECT h.*, fu.display_name as from_name, tu.display_name as to_name
     FROM cash_handovers h
     JOIN users fu ON fu.id = h.from_user_id
     JOIN users tu ON tu.id = h.to_user_id
     WHERE h.from_user_id = ? OR h.to_user_id = ?
     ORDER BY h.created_at DESC LIMIT 50`
  ).bind(user.id, user.id).all();

  return jsonOk({
    handovers: results.map((h) => ({
      handoverId: h.id,
      fromUserId: h.from_user_id,
      fromName: h.from_name,
      toUserId: h.to_user_id,
      toName: h.to_name,
      amountSatang: h.amount_satang,
      note: h.note,
      status: h.status,
      createdAt: h.created_at,
      confirmedAt: h.confirmed_at,
      canConfirm: h.to_user_id === user.id && h.status === 'PENDING'
    }))
  });
}

export async function handleConfirmHandover(request, env, handoverId) {
  const user = await requireSession(request, env);
  if (!user) return jsonError('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);

  const handover = await env.DB.prepare('SELECT * FROM cash_handovers WHERE id = ?').bind(handoverId).first();
  if (!handover) return jsonError('ไม่พบรายการส่งมอบเงินสด', 404);
  if (handover.to_user_id !== user.id) return jsonError('เฉพาะผู้รับมอบเท่านั้นที่ยืนยันรายการนี้ได้', 403);
  if (handover.status !== 'PENDING') return jsonError('รายการนี้ถูกยืนยันไปแล้ว');

  const now = Date.now();
  await env.DB.prepare("UPDATE cash_handovers SET status = 'CONFIRMED', confirmed_at = ? WHERE id = ?")
    .bind(now, handoverId).run();

  await writeAuditLog(env, user.id, 'CONFIRM_CASH_HANDOVER', 'CASH_HANDOVER', handoverId, { amount: handover.amount_satang });

  return jsonOk({ handoverId });
}
