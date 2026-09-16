import { requirePermission, jsonError } from '../auth.js';

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvResponse(filename, rows) {
  // UTF-8 BOM so Excel (incl. Thai text) opens it without mangled encoding.
  const body = '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`
    }
  });
}

export async function handleExportTransactionsCsv(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_EXPORT_REPORTS');
  if (error) return error;

  const url = new URL(request.url);
  const from = Number(url.searchParams.get('from') || 0) || 0;
  const to = Number(url.searchParams.get('to') || 0) || Date.now();

  const { results } = await env.DB.prepare(
    `SELECT t.*, a.account_no, m.prefix, m.first_name, m.last_name
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     JOIN members m ON m.id = a.member_id
     WHERE t.created_at BETWEEN ? AND ?
     ORDER BY t.created_at`
  ).bind(from, to).all();

  const header = ['วันที่/เวลา', 'เลขบัญชี', 'ชื่อ-นามสกุล', 'ประเภทรายการ', 'จำนวนเงิน (บาท)', 'ยอดก่อนทำรายการ', 'ยอดหลังทำรายการ', 'หมายเหตุ', 'รหัสรายการ'];
  const rows = results.map((t) => [
    new Date(t.created_at).toLocaleString('th-TH'),
    t.account_no,
    `${t.prefix || ''}${t.first_name} ${t.last_name}`.trim(),
    t.type,
    (t.amount / 100).toFixed(2),
    (t.balance_before / 100).toFixed(2),
    (t.balance_after / 100).toFixed(2),
    t.note || '',
    t.id
  ]);

  return csvResponse(`transactions-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows]);
}

export async function handleExportAccountsCsv(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_EXPORT_REPORTS');
  if (error) return error;

  const { results } = await env.DB.prepare(
    `SELECT a.*, m.school_student_id, m.prefix, m.first_name, m.last_name, m.grade, m.room
     FROM accounts a JOIN members m ON m.id = a.member_id
     ORDER BY a.account_no`
  ).all();

  const header = ['เลขบัญชี', 'รหัสนักเรียน', 'ชื่อ-นามสกุล', 'ชั้น', 'ห้อง', 'ประเภทบัญชี', 'สถานะ', 'ยอดคงเหลือ (บาท)'];
  const rows = results.map((a) => [
    a.account_no,
    a.school_student_id || '',
    `${a.prefix || ''}${a.first_name} ${a.last_name}`.trim(),
    a.grade || '',
    a.room || '',
    a.account_type,
    a.status,
    (a.balance / 100).toFixed(2)
  ]);

  return csvResponse(`accounts-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows]);
}

export async function handleGetTransaction(request, env, txId) {
  const { error } = await requirePermission(request, env, 'CAN_VIEW_TRANSACTIONS');
  if (error) return error;

  const tx = await env.DB.prepare(
    `SELECT t.*, a.account_no, m.prefix, m.first_name, m.last_name, u.display_name as teller_name
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     JOIN members m ON m.id = a.member_id
     JOIN users u ON u.id = t.user_id
     WHERE t.id = ?`
  ).bind(txId).first();

  if (!tx) return jsonError('ไม่พบรายการ', 404);

  return Response.json({
    success: true,
    transaction: {
      txId: tx.id,
      type: tx.type,
      amountSatang: tx.amount,
      balanceBeforeSatang: tx.balance_before,
      balanceAfterSatang: tx.balance_after,
      accountNo: tx.account_no,
      fullName: `${tx.prefix || ''}${tx.first_name} ${tx.last_name}`.trim(),
      tellerName: tx.teller_name,
      note: tx.note,
      createdAt: tx.created_at
    }
  });
}
