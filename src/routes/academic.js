import { requirePermission, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';
import { memberHasOpenLoan } from './loans.js';

const PREVIEW_TTL_MS = 5 * 60 * 1000; // 5 minutes, matches the old Apps Script preview-token pattern

export async function handleGradeSummary(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_MANAGE_ACADEMIC_YEAR');
  if (error) return error;

  const { results } = await env.DB.prepare(
    "SELECT grade, COUNT(*) as member_count FROM members WHERE status = 'ACTIVE' AND grade IS NOT NULL AND grade != '' GROUP BY grade ORDER BY grade"
  ).all();

  return jsonOk({ grades: results.map((r) => ({ grade: r.grade, memberCount: r.member_count })) });
}

export async function handlePromoteGrade(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_MANAGE_ACADEMIC_YEAR');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const fromGrade = String(body.fromGrade || '').trim();
  const toGrade = String(body.toGrade || '').trim();

  if (!fromGrade || !toGrade) return jsonError('กรุณาระบุชั้นเดิมและชั้นใหม่');
  if (fromGrade === toGrade) return jsonError('ชั้นเดิมและชั้นใหม่ต้องไม่เหมือนกัน');

  const result = await env.DB
    .prepare("UPDATE members SET grade = ? WHERE grade = ? AND status = 'ACTIVE'")
    .bind(toGrade, fromGrade)
    .run();

  const count = result.meta ? result.meta.changes : 0;
  await writeAuditLog(env, user.id, 'PROMOTE_GRADE', 'MEMBERS', null, { fromGrade, toGrade, count });

  return jsonOk({ promotedCount: count });
}

/**
 * Preview a graduation-purge for a grade: shows every ACTIVE member in that
 * grade plus why each one is or isn't eligible to be purged right now
 * (mirrors the old Apps Script blockers: non-zero savings balance, or an
 * open loan). Returns a short-lived token that execute() must be called
 * with, bound to this admin, so the confirm step always acts on exactly the
 * set that was just previewed.
 */
export async function handleGraduationPreview(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_MANAGE_ACADEMIC_YEAR');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const grade = String(body.grade || '').trim();
  if (!grade) return jsonError('กรุณาระบุชั้นที่จะดำเนินการจบการศึกษา');

  const { results: members } = await env.DB
    .prepare("SELECT * FROM members WHERE grade = ? AND status = 'ACTIVE'").bind(grade).all();

  if (!members.length) return jsonError('ไม่พบนักเรียนที่ยังใช้งานอยู่ในชั้นนี้');

  const rows = [];
  const eligibleIds = [];

  for (const m of members) {
    const { results: accounts } = await env.DB
      .prepare("SELECT id, account_no, balance FROM accounts WHERE member_id = ? AND status = 'ACTIVE'").bind(m.id).all();
    const nonZeroAccounts = accounts.filter((a) => a.balance !== 0);
    const hasOpenLoan = await memberHasOpenLoan(env, m.id);

    const blockers = [];
    if (nonZeroAccounts.length) blockers.push('มียอดเงินคงเหลือในบัญชี ต้องถอน/ปิดบัญชีให้ครบก่อน');
    if (hasOpenLoan) blockers.push('มีเงินกู้ค้างชำระ ต้องปิดยอดเงินกู้ก่อน');

    if (!blockers.length) eligibleIds.push(m.id);

    rows.push({
      memberId: m.id,
      fullName: `${m.prefix || ''}${m.first_name} ${m.last_name}`.trim(),
      schoolStudentId: m.school_student_id,
      accounts: accounts.map((a) => ({ accountId: a.id, accountNo: a.account_no, balanceSatang: a.balance })),
      hasOpenLoan,
      eligible: !blockers.length,
      blockers
    });
  }

  const token = newId('GRADPREVIEW');
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO graduation_preview_tokens (token, admin_id, grade, member_ids_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(token, user.id, grade, JSON.stringify(eligibleIds), now, now + PREVIEW_TTL_MS).run();

  return jsonOk({
    token,
    grade,
    expiresAt: now + PREVIEW_TTL_MS,
    totalCount: members.length,
    eligibleCount: eligibleIds.length,
    blockedCount: members.length - eligibleIds.length,
    members: rows,
    requiredConfirmText: `ยืนยันจบการศึกษาชั้น ${grade}`
  });
}

/**
 * Executes a previously-previewed graduation purge. Requires the exact
 * typed confirmation phrase (same "type the sentence" safety gate the old
 * Apps Script version used for destructive actions) plus the preview token,
 * which must still be unexpired and belong to this same admin -- this
 * closes the eligible members' accounts, marks them GRADUATED, and writes a
 * full pre-purge snapshot to graduation_batches so the batch can be audited
 * or manually reversed later if needed.
 */
export async function handleGraduationExecute(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_MANAGE_ACADEMIC_YEAR');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '').trim();
  const confirmText = String(body.confirmText || '').trim();

  if (!token) return jsonError('ไม่พบ token การตรวจสอบ กรุณากด "ตรวจสอบก่อนดำเนินการ" ใหม่อีกครั้ง');

  const preview = await env.DB.prepare('SELECT * FROM graduation_preview_tokens WHERE token = ?').bind(token).first();
  if (!preview) return jsonError('Token หมดอายุหรือไม่ถูกต้อง กรุณาตรวจสอบใหม่อีกครั้ง');
  if (preview.admin_id !== user.id) return jsonError('Token นี้ผูกกับผู้ดูแลระบบคนอื่น กรุณาตรวจสอบใหม่ด้วยบัญชีของคุณเอง');
  if (preview.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM graduation_preview_tokens WHERE token = ?').bind(token).run();
    return jsonError('Token หมดอายุแล้ว (มีอายุ 5 นาที) กรุณาตรวจสอบใหม่อีกครั้ง');
  }

  const requiredText = `ยืนยันจบการศึกษาชั้น ${preview.grade}`;
  if (confirmText !== requiredText) {
    return jsonError(`กรุณาพิมพ์ข้อความยืนยันให้ตรงทุกตัวอักษร: "${requiredText}"`);
  }

  const eligibleIds = JSON.parse(preview.member_ids_json || '[]');
  if (!eligibleIds.length) return jsonError('ไม่มีนักเรียนที่มีสิทธิ์จบการศึกษาในชุดที่ตรวจสอบไว้');

  // Re-verify eligibility right before purging (defends against a deposit,
  // withdrawal, or new loan happening in the gap between preview and
  // execute) and build the pre-purge snapshot in the same pass.
  const snapshot = [];
  const stillEligibleIds = [];
  for (const memberId of eligibleIds) {
    const member = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(memberId).first();
    if (!member || member.status !== 'ACTIVE') continue;

    const { results: accounts } = await env.DB
      .prepare("SELECT * FROM accounts WHERE member_id = ? AND status = 'ACTIVE'").bind(memberId).all();
    const nonZero = accounts.filter((a) => a.balance !== 0);
    const hasOpenLoan = await memberHasOpenLoan(env, memberId);
    if (nonZero.length || hasOpenLoan) continue; // no longer eligible -- skip, don't fail the whole batch

    stillEligibleIds.push(memberId);
    snapshot.push({ member, accounts });
  }

  if (!stillEligibleIds.length) {
    return jsonError('มีการเปลี่ยนแปลงข้อมูล (ฝาก/ถอน/กู้ยืม) หลังตรวจสอบ ทำให้ไม่มีนักเรียนที่มีสิทธิ์จบการศึกษาแล้ว กรุณาตรวจสอบใหม่');
  }

  const now = Date.now();
  const statements = [];
  for (const memberId of stillEligibleIds) {
    statements.push(env.DB.prepare("UPDATE members SET status = 'GRADUATED' WHERE id = ?").bind(memberId));
    statements.push(
      env.DB.prepare("UPDATE accounts SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE member_id = ? AND status = 'ACTIVE'")
        .bind(now, now, memberId)
    );
  }

  const batchId = newId('GRADBATCH');
  statements.push(
    env.DB.prepare(
      'INSERT INTO graduation_batches (id, grade, executed_by, executed_at, member_count, snapshot_json, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(batchId, preview.grade, user.id, now, stillEligibleIds.length, JSON.stringify(snapshot), null)
  );
  statements.push(env.DB.prepare('DELETE FROM graduation_preview_tokens WHERE token = ?').bind(token));

  await env.DB.batch(statements);
  await writeAuditLog(env, user.id, 'EXECUTE_GRADUATION', 'GRADUATION_BATCH', batchId, { grade: preview.grade, count: stillEligibleIds.length });

  return jsonOk({
    batchId,
    grade: preview.grade,
    graduatedCount: stillEligibleIds.length,
    skippedCount: eligibleIds.length - stillEligibleIds.length
  });
}

export async function handleListGraduationBatches(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_MANAGE_ACADEMIC_YEAR');
  if (error) return error;

  const { results } = await env.DB
    .prepare('SELECT id, grade, executed_by, executed_at, member_count, note FROM graduation_batches ORDER BY executed_at DESC LIMIT 50')
    .all();

  return jsonOk({
    batches: results.map((b) => ({
      batchId: b.id,
      grade: b.grade,
      executedBy: b.executed_by,
      executedAt: b.executed_at,
      memberCount: b.member_count,
      note: b.note
    }))
  });
}
