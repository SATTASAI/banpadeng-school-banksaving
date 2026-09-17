// Phase 5: interest (ดอกเบี้ยเงินฝาก, SAVINGS accounts) / dividend (เงินปันผล,
// SHARE accounts) crediting.
//
// Deliberately simple by design, matching how a school savings-cooperative
// bank actually runs this once or twice a year: amount = current balance *
// rate, no daily-average-balance accrual. Uses the same preview -> confirm
// pattern as graduation-purge (0003_academic_year.sql / routes/academic.js):
// a short-lived token snapshots which accounts are eligible at preview time,
// then the actual run recomputes each account's amount against its CURRENT
// balance and silently skips anything that stopped being eligible in
// between (closed, balance now zero, etc.) rather than acting on stale data.

import { requirePermission, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';

const PREVIEW_TTL_MS = 5 * 60 * 1000; // 5 minutes, same as graduation preview tokens
const INSERT_CHUNK_SIZE = 12; // 3 statements per account (update + tx insert + item insert)

function txTypeFor(accountType) {
  return accountType === 'SHARE' ? 'DIVIDEND' : 'INTEREST';
}

function labelFor(accountType) {
  return accountType === 'SHARE' ? 'เงินปันผล' : 'ดอกเบี้ยเงินฝาก';
}

async function eligibleAccounts(env, accountType) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.account_no, a.balance, m.prefix, m.first_name, m.last_name
     FROM accounts a JOIN members m ON m.id = a.member_id
     WHERE a.status = 'ACTIVE' AND a.account_type = ? AND a.balance > 0
     ORDER BY a.account_no`
  ).bind(accountType).all();
  return results;
}

export async function handlePreviewInterest(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_RUN_INTEREST');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const accountType = String(body.accountType || '').trim().toUpperCase();
  const ratePercent = Number(body.ratePercent);
  const periodLabel = String(body.periodLabel || '').trim().slice(0, 100);

  if (!['SAVINGS', 'SHARE'].includes(accountType)) return jsonError('ประเภทบัญชีไม่ถูกต้อง');
  if (!Number.isFinite(ratePercent) || ratePercent <= 0 || ratePercent > 100) {
    return jsonError('กรุณากรอกอัตรา (%) ที่มากกว่า 0 และไม่เกิน 100');
  }
  if (!periodLabel) return jsonError('กรุณาระบุงวด/รอบที่คำนวณ เช่น "ปีการศึกษา 2568"');

  const rateBps = Math.round(ratePercent * 100);
  const accounts = await eligibleAccounts(env, accountType);

  if (!accounts.length) {
    return jsonError(`ไม่พบบัญชี ${accountType === 'SHARE' ? 'ออมหุ้น' : 'ออมทรัพย์'} ที่มียอดคงเหลือมากกว่า 0 บาท`);
  }

  const items = accounts.map((a) => ({
    accountId: a.id,
    accountNo: a.account_no,
    fullName: `${a.prefix || ''}${a.first_name} ${a.last_name}`.trim(),
    balanceSatang: a.balance,
    amountSatang: Math.round((a.balance * rateBps) / 10000)
  })).filter((it) => it.amountSatang > 0);

  if (!items.length) {
    return jsonError('คำนวณแล้วไม่มีบัญชีใดได้รับเงินมากกว่า 0 บาท (อัตราต่ำเกินไปเมื่อเทียบกับยอดคงเหลือ)');
  }

  const totalAmountSatang = items.reduce((sum, it) => sum + it.amountSatang, 0);

  const token = newId('IPT');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO interest_preview_tokens (token, admin_id, account_type, rate_bps, period_label, account_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(token, user.id, accountType, rateBps, periodLabel, JSON.stringify(items.map((i) => i.accountId)), now, now + PREVIEW_TTL_MS).run();

  return jsonOk({
    token,
    accountType,
    ratePercent,
    periodLabel,
    txType: txTypeFor(accountType),
    accountCount: items.length,
    totalAmountSatang,
    items,
    expiresAt: now + PREVIEW_TTL_MS
  });
}

export async function handleRunInterest(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_RUN_INTEREST');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '').trim();
  if (!token) return jsonError('ไม่พบข้อมูลการตรวจสอบล่วงหน้า กรุณาคำนวณตัวอย่างใหม่');

  const preview = await env.DB.prepare('SELECT * FROM interest_preview_tokens WHERE token = ?').bind(token).first();
  if (!preview) return jsonError('ข้อมูลตรวจสอบล่วงหน้าหมดอายุหรือไม่ถูกต้อง กรุณาคำนวณตัวอย่างใหม่');
  if (preview.admin_id !== user.id) return jsonError('กรุณาดำเนินการด้วยผู้ใช้งานคนเดียวกับที่คำนวณตัวอย่างไว้');
  if (preview.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM interest_preview_tokens WHERE token = ?').bind(token).run();
    return jsonError('ข้อมูลตรวจสอบล่วงหน้าหมดอายุแล้ว (เกิน 5 นาที) กรุณาคำนวณตัวอย่างใหม่');
  }

  const snapshotIds = JSON.parse(preview.account_ids_json || '[]');
  if (!snapshotIds.length) return jsonError('ไม่มีบัญชีในชุดที่ตรวจสอบไว้');

  // Recompute against CURRENT balances -- an account may have been closed or
  // its balance changed by a deposit/withdrawal since the preview was run.
  const placeholders = snapshotIds.map(() => '?').join(', ');
  const { results: currentAccounts } = await env.DB.prepare(
    `SELECT id, balance FROM accounts WHERE id IN (${placeholders}) AND status = 'ACTIVE' AND account_type = ? AND balance > 0`
  ).bind(...snapshotIds, preview.account_type).all();

  const skippedCount = snapshotIds.length - currentAccounts.length;
  const txType = txTypeFor(preview.account_type);
  const runId = newId('IRUN');
  const now = Date.now();

  const runItems = currentAccounts
    .map((a) => ({ accountId: a.id, balanceBefore: a.balance, amount: Math.round((a.balance * preview.rate_bps) / 10000) }))
    .filter((it) => it.amount > 0);

  if (!runItems.length) {
    await env.DB.prepare('DELETE FROM interest_preview_tokens WHERE token = ?').bind(token).run();
    return jsonError('ไม่มีบัญชีที่ยังมีสิทธิ์ได้รับเงินในขณะนี้ (อาจถูกปิดบัญชีหรือถอนเงินไปหลังจากตรวจสอบตัวอย่าง) กรุณาคำนวณตัวอย่างใหม่');
  }

  let totalAmountSatang = 0;
  const statements = [];
  for (const item of runItems) {
    const txId = newId('TX');
    const requestId = `${runId}:${item.accountId}`;
    totalAmountSatang += item.amount;

    statements.push(
      env.DB.prepare("UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
        .bind(item.amount, now, item.accountId)
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO transactions (id, bank_session_id, account_id, type, amount, balance_before, balance_after, location_id, user_id, note, request_id, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
      ).bind(txId, item.accountId, txType, item.amount, item.balanceBefore, item.balanceBefore + item.amount, user.id,
        `${labelFor(preview.account_type)} งวด ${preview.period_label} (${(preview.rate_bps / 100).toFixed(2)}%)`, requestId, now)
    );
    statements.push(
      env.DB.prepare(
        'INSERT INTO interest_run_items (id, run_id, account_id, tx_id, balance_before_satang, amount_satang) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(newId('IRI'), runId, item.accountId, txId, item.balanceBefore, item.amount)
    );
  }

  for (let i = 0; i < statements.length; i += INSERT_CHUNK_SIZE) {
    await env.DB.batch(statements.slice(i, i + INSERT_CHUNK_SIZE));
  }

  await env.DB.prepare(
    `INSERT INTO interest_runs (id, account_type, tx_type, rate_bps, period_label, run_by, run_at, account_count, skipped_count, total_amount_satang, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(runId, preview.account_type, txType, preview.rate_bps, preview.period_label, user.id, now, runItems.length, skippedCount, totalAmountSatang, null).run();

  await env.DB.prepare('DELETE FROM interest_preview_tokens WHERE token = ?').bind(token).run();
  await writeAuditLog(env, user.id, 'RUN_INTEREST', 'INTEREST_RUN', runId, {
    accountType: preview.account_type, rateBps: preview.rate_bps, periodLabel: preview.period_label,
    accountCount: runItems.length, skippedCount, totalAmountSatang
  });

  return jsonOk({ runId, accountCount: runItems.length, skippedCount, totalAmountSatang });
}

export async function handleListInterestRuns(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_RUN_INTEREST');
  if (error) return error;

  const { results } = await env.DB.prepare(
    `SELECT r.*, u.display_name as run_by_name FROM interest_runs r
     JOIN users u ON u.id = r.run_by ORDER BY r.run_at DESC LIMIT 100`
  ).all();

  return jsonOk({
    runs: results.map((r) => ({
      runId: r.id,
      accountType: r.account_type,
      txType: r.tx_type,
      ratePercent: r.rate_bps / 100,
      periodLabel: r.period_label,
      runByName: r.run_by_name,
      runAt: r.run_at,
      accountCount: r.account_count,
      skippedCount: r.skipped_count,
      totalAmountSatang: r.total_amount_satang
    }))
  });
}

export async function handleInterestRunDetail(request, env, runId) {
  const { error } = await requirePermission(request, env, 'CAN_RUN_INTEREST');
  if (error) return error;

  const run = await env.DB.prepare(
    `SELECT r.*, u.display_name as run_by_name FROM interest_runs r JOIN users u ON u.id = r.run_by WHERE r.id = ?`
  ).bind(runId).first();
  if (!run) return jsonError('ไม่พบรายการ', 404);

  const { results: items } = await env.DB.prepare(
    `SELECT i.*, a.account_no, m.prefix, m.first_name, m.last_name
     FROM interest_run_items i
     JOIN accounts a ON a.id = i.account_id
     JOIN members m ON m.id = a.member_id
     WHERE i.run_id = ? ORDER BY a.account_no`
  ).bind(runId).all();

  return jsonOk({
    run: {
      runId: run.id,
      accountType: run.account_type,
      txType: run.tx_type,
      ratePercent: run.rate_bps / 100,
      periodLabel: run.period_label,
      runByName: run.run_by_name,
      runAt: run.run_at,
      accountCount: run.account_count,
      skippedCount: run.skipped_count,
      totalAmountSatang: run.total_amount_satang
    },
    items: items.map((it) => ({
      accountNo: it.account_no,
      fullName: `${it.prefix || ''}${it.first_name} ${it.last_name}`.trim(),
      balanceBeforeSatang: it.balance_before_satang,
      amountSatang: it.amount_satang
    }))
  });
}
