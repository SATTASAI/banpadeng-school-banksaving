import { requirePermission, requireAdmin, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';
import { buildLoanSchedule } from '../loanmath.js';

// ---- Loan products (admin) ----------------------------------------------

export async function handleListLoanProducts(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_MANAGE_LOANS');
  if (error) return error;

  const { results } = await env.DB.prepare('SELECT * FROM loan_products ORDER BY created_at').all();
  return jsonOk({ loanProducts: results.map(loanProductResponse) });
}

export async function handleCreateLoanProduct(request, env) {
  const { user: admin, error } = await requireAdmin(request, env);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const interestMethod = String(body.interestMethod || 'FLAT').trim().toUpperCase();
  const annualRateBps = Math.round(Number(body.annualInterestRatePercent || 0) * 100);
  const lateFeeSatang = Math.round(Number(body.lateFeeSatang || 0));
  const maxPrincipalSatang = body.maxPrincipalSatang ? Math.round(Number(body.maxPrincipalSatang)) : null;

  if (!name) return jsonError('กรุณากรอกชื่อประเภทเงินกู้');
  if (!['FLAT', 'DECLINING'].includes(interestMethod)) return jsonError('วิธีคิดดอกเบี้ยไม่ถูกต้อง');
  if (annualRateBps < 0) return jsonError('อัตราดอกเบี้ยต้องไม่ติดลบ');

  const id = newId('LP');
  await env.DB.prepare(
    `INSERT INTO loan_products (id, name, interest_method, annual_interest_rate_bps, late_fee_satang, max_principal_satang, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(id, name, interestMethod, annualRateBps, lateFeeSatang, maxPrincipalSatang, Date.now()).run();

  await writeAuditLog(env, admin.id, 'CREATE_LOAN_PRODUCT', 'LOAN_PRODUCT', id, { name, interestMethod, annualRateBps });

  return jsonOk({ loanProductId: id });
}

function loanProductResponse(p) {
  return {
    loanProductId: p.id,
    name: p.name,
    interestMethod: p.interest_method,
    annualInterestRatePercent: p.annual_interest_rate_bps / 100,
    lateFeeSatang: p.late_fee_satang,
    maxPrincipalSatang: p.max_principal_satang,
    active: !!p.active
  };
}

// ---- Loan applications / lifecycle ---------------------------------------

export async function handleApplyLoan(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_MANAGE_LOANS');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const memberId = String(body.memberId || '').trim();
  const loanProductId = String(body.loanProductId || '').trim();
  const principalSatang = Math.round(Number(body.principalSatang || 0));
  const termMonths = Math.round(Number(body.termMonths || 0));
  const note = String(body.note || '').trim().slice(0, 300);

  if (!memberId) return jsonError('กรุณาเลือกผู้กู้ (ค้นหาจากบัญชีก่อน)');
  if (!loanProductId) return jsonError('กรุณาเลือกประเภทเงินกู้');
  if (!Number.isFinite(principalSatang) || principalSatang <= 0) return jsonError('กรุณากรอกวงเงินกู้ให้ถูกต้อง');
  if (!Number.isInteger(termMonths) || termMonths <= 0 || termMonths > 60) return jsonError('จำนวนงวดต้องอยู่ระหว่าง 1–60 เดือน');

  const member = await env.DB.prepare('SELECT id FROM members WHERE id = ?').bind(memberId).first();
  if (!member) return jsonError('ไม่พบข้อมูลผู้กู้');

  const product = await env.DB.prepare('SELECT * FROM loan_products WHERE id = ? AND active = 1').bind(loanProductId).first();
  if (!product) return jsonError('ไม่พบประเภทเงินกู้ หรือถูกปิดใช้งานแล้ว');
  if (product.max_principal_satang && principalSatang > product.max_principal_satang) {
    return jsonError(`วงเงินกู้เกินเพดานของประเภทนี้ (สูงสุด ${(product.max_principal_satang / 100).toLocaleString('th-TH')} บาท)`);
  }

  const openLoan = await env.DB.prepare(
    "SELECT id FROM loans WHERE member_id = ? AND status IN ('PENDING','APPROVED','DISBURSED') LIMIT 1"
  ).bind(memberId).first();
  if (openLoan) return jsonError('ผู้กู้รายนี้มีเงินกู้ที่ยังไม่ปิดบัญชีอยู่แล้ว ไม่สามารถขอกู้ซ้ำได้');

  const id = newId('LOAN');
  const loanNo = await generateLoanNo(env);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO loans (id, loan_no, member_id, loan_product_id, principal_satang, term_months, interest_method, annual_interest_rate_bps, status, applied_at, applied_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
  ).bind(id, loanNo, memberId, loanProductId, principalSatang, termMonths, product.interest_method, product.annual_interest_rate_bps, now, user.id, note).run();

  await writeAuditLog(env, user.id, 'APPLY_LOAN', 'LOAN', id, { loanNo, memberId, principalSatang, termMonths });

  return jsonOk({ loanId: id, loanNo });
}

export async function handleListLoans(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_MANAGE_LOANS');
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const q = (url.searchParams.get('q') || '').trim();

  let sql = `SELECT l.*, m.prefix, m.first_name, m.last_name, p.name as product_name
             FROM loans l
             JOIN members m ON m.id = l.member_id
             JOIN loan_products p ON p.id = l.loan_product_id
             WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND l.status = ?'; params.push(status); }
  if (q) {
    sql += ` AND (l.loan_no LIKE ? OR (m.prefix || m.first_name || ' ' || m.last_name) LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY l.applied_at DESC LIMIT 100';

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return jsonOk({ loans: results.map(loanSummaryResponse) });
}

export async function handleLoanDetail(request, env, loanId) {
  const { error } = await requirePermission(request, env, 'CAN_MANAGE_LOANS');
  if (error) return error;

  const loan = await getLoanWithMember(env, loanId);
  if (!loan) return jsonError('ไม่พบเงินกู้', 404);

  await assessLateFees(env, loanId);

  const { results: schedule } = await env.DB
    .prepare('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY installment_no').bind(loanId).all();
  const { results: payments } = await env.DB
    .prepare('SELECT * FROM loan_payments WHERE loan_id = ? ORDER BY created_at DESC').bind(loanId).all();

  return jsonOk({
    loan: loanSummaryResponse(loan),
    schedule: schedule.map(scheduleRowResponse),
    payments: payments.map((p) => ({
      paymentId: p.id,
      amountSatang: p.amount_satang,
      principalAppliedSatang: p.principal_applied_satang,
      interestAppliedSatang: p.interest_applied_satang,
      lateFeeAppliedSatang: p.late_fee_applied_satang,
      note: p.note,
      createdAt: p.created_at
    }))
  });
}

export async function handleApproveLoan(request, env, loanId) {
  const { user, error } = await requirePermission(request, env, 'CAN_APPROVE_LOAN');
  if (error) return error;

  const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(loanId).first();
  if (!loan) return jsonError('ไม่พบเงินกู้', 404);
  if (loan.status !== 'PENDING') return jsonError('เงินกู้นี้ไม่ได้อยู่ในสถานะรออนุมัติ');

  const now = Date.now();
  const rows = buildLoanSchedule(loan.principal_satang, loan.term_months, loan.annual_interest_rate_bps, loan.interest_method, now);

  const statements = [
    env.DB.prepare('UPDATE loans SET status = ?, approved_at = ?, approved_by = ? WHERE id = ?')
      .bind('APPROVED', now, user.id, loanId)
  ];
  for (const r of rows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO loan_schedule (id, loan_id, installment_no, due_date, principal_due_satang, interest_due_satang)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(newId('SCH'), loanId, r.installmentNo, r.dueDate, r.principalDue, r.interestDue)
    );
  }
  await env.DB.batch(statements);

  await writeAuditLog(env, user.id, 'APPROVE_LOAN', 'LOAN', loanId, { installments: rows.length });
  return jsonOk({ loanId });
}

export async function handleRejectLoan(request, env, loanId) {
  const { user, error } = await requirePermission(request, env, 'CAN_APPROVE_LOAN');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const reason = String(body.reason || '').trim().slice(0, 300);

  const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(loanId).first();
  if (!loan) return jsonError('ไม่พบเงินกู้', 404);
  if (loan.status !== 'PENDING') return jsonError('เงินกู้นี้ไม่ได้อยู่ในสถานะรออนุมัติ');

  await env.DB.prepare('UPDATE loans SET status = ?, rejected_reason = ? WHERE id = ?')
    .bind('REJECTED', reason, loanId).run();
  await writeAuditLog(env, user.id, 'REJECT_LOAN', 'LOAN', loanId, { reason });

  return jsonOk({ loanId });
}

export async function handleDisburseLoan(request, env, loanId) {
  const { user, error } = await requirePermission(request, env, 'CAN_DISBURSE_LOAN');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const accountId = String(body.accountId || '').trim();
  if (!accountId) return jsonError('กรุณาเลือกบัญชีที่จะโอนเงินกู้เข้า');

  const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(loanId).first();
  if (!loan) return jsonError('ไม่พบเงินกู้', 404);
  if (loan.status !== 'APPROVED') return jsonError('เงินกู้ต้องได้รับการอนุมัติก่อนจึงจะเบิกจ่ายได้');

  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ? AND member_id = ?").bind(accountId, loan.member_id).first();
  if (!account) return jsonError('ไม่พบบัญชีของผู้กู้รายนี้');
  if (account.status !== 'ACTIVE') return jsonError('บัญชีปลายทางปิดใช้งานแล้ว');

  const bankSession = await env.DB.prepare("SELECT id FROM bank_sessions WHERE status = 'OPEN' LIMIT 1").first();
  if (!bankSession) return jsonError('ต้องเปิด Bank Session ก่อนจึงจะเบิกจ่ายเงินกู้ได้');

  const now = Date.now();
  const txId = newId('TX');

  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
      .bind(loan.principal_satang, now, accountId),
    env.DB.prepare(
      `INSERT INTO transactions (id, bank_session_id, account_id, type, amount, balance_before, balance_after, location_id, user_id, note, created_at)
       VALUES (?, ?, ?, 'LOAN_DISBURSEMENT', ?, ?, ?, NULL, ?, ?, ?)`
    ).bind(txId, bankSession.id, accountId, loan.principal_satang, account.balance, account.balance + loan.principal_satang, user.id, `เบิกจ่ายเงินกู้ ${loan.loan_no}`, now),
    env.DB.prepare('UPDATE loans SET status = ?, disbursed_at = ?, disbursed_by = ?, disburse_account_id = ? WHERE id = ?')
      .bind('DISBURSED', now, user.id, accountId, loanId)
  ]);

  await writeAuditLog(env, user.id, 'DISBURSE_LOAN', 'LOAN', loanId, { accountId, amount: loan.principal_satang, txId });

  return jsonOk({ loanId, txId, amountSatang: loan.principal_satang });
}

export async function handleReceiveLoanPayment(request, env, loanId) {
  const { user, error } = await requirePermission(request, env, 'CAN_RECEIVE_LOAN_PAYMENT');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const amount = Math.round(Number(body.amountSatang || 0));
  const note = String(body.note || '').trim().slice(0, 300);
  const requestId = String(body.requestId || '').trim() || null;

  if (!Number.isFinite(amount) || amount <= 0) return jsonError('กรุณากรอกจำนวนเงินที่ชำระให้ถูกต้อง');

  if (requestId) {
    const existing = await env.DB.prepare('SELECT id FROM loan_payments WHERE request_id = ?').bind(requestId).first();
    if (existing) return jsonOk({ paymentId: existing.id, duplicateRequest: true });
  }

  const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(loanId).first();
  if (!loan) return jsonError('ไม่พบเงินกู้', 404);
  if (loan.status !== 'DISBURSED') return jsonError('เงินกู้นี้ยังไม่ได้เบิกจ่าย หรือปิดบัญชีไปแล้ว');

  await assessLateFees(env, loanId);

  const { results: schedule } = await env.DB
    .prepare("SELECT * FROM loan_schedule WHERE loan_id = ? AND status != 'PAID' ORDER BY installment_no").bind(loanId).all();

  // Waterfall allocation: late fee -> interest -> principal, oldest
  // installment first -- same priority order as the old Apps Script logic.
  let remaining = amount;
  let principalApplied = 0, interestApplied = 0, lateFeeApplied = 0;
  const updates = [];

  for (const row of schedule) {
    if (remaining <= 0) break;
    const lateFeeOwed = row.late_fee_due_satang - row.late_fee_paid_satang;
    const interestOwed = row.interest_due_satang - row.interest_paid_satang;
    const principalOwed = row.principal_due_satang - row.principal_paid_satang;

    const payLateFee = Math.min(remaining, lateFeeOwed);
    remaining -= payLateFee;
    const payInterest = Math.min(remaining, interestOwed);
    remaining -= payInterest;
    const payPrincipal = Math.min(remaining, principalOwed);
    remaining -= payPrincipal;

    if (payLateFee || payInterest || payPrincipal) {
      const newLateFeePaid = row.late_fee_paid_satang + payLateFee;
      const newInterestPaid = row.interest_paid_satang + payInterest;
      const newPrincipalPaid = row.principal_paid_satang + payPrincipal;
      const fullyPaid = newPrincipalPaid >= row.principal_due_satang && newInterestPaid >= row.interest_due_satang && newLateFeePaid >= row.late_fee_due_satang;

      updates.push({ id: row.id, newLateFeePaid, newInterestPaid, newPrincipalPaid, status: fullyPaid ? 'PAID' : 'PARTIAL' });
      lateFeeApplied += payLateFee;
      interestApplied += payInterest;
      principalApplied += payPrincipal;
    }
  }

  // Any leftover beyond what's currently due (e.g. paying ahead) is applied
  // as extra principal against the earliest still-open installment.
  if (remaining > 0 && schedule.length) {
    const row = schedule[0];
    const already = updates.find((u) => u.id === row.id);
    const extra = remaining;
    remaining = 0;
    principalApplied += extra;
    if (already) {
      already.newPrincipalPaid += extra;
    } else {
      updates.push({ id: row.id, newLateFeePaid: row.late_fee_paid_satang, newInterestPaid: row.interest_paid_satang, newPrincipalPaid: row.principal_paid_satang + extra, status: 'PARTIAL' });
    }
  }

  const now = Date.now();
  const paymentId = newId('LPMT');
  const statements = updates.map((u) =>
    env.DB.prepare('UPDATE loan_schedule SET late_fee_paid_satang = ?, interest_paid_satang = ?, principal_paid_satang = ?, status = ? WHERE id = ?')
      .bind(u.newLateFeePaid, u.newInterestPaid, u.newPrincipalPaid, u.status, u.id)
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO loan_payments (id, loan_id, amount_satang, principal_applied_satang, interest_applied_satang, late_fee_applied_satang, user_id, note, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(paymentId, loanId, amount - remaining, principalApplied, interestApplied, lateFeeApplied, user.id, note, requestId, now)
  );

  await env.DB.batch(statements);

  const { count: remainingUnpaid } = await env.DB
    .prepare("SELECT COUNT(*) as count FROM loan_schedule WHERE loan_id = ? AND status != 'PAID'").bind(loanId).first();
  if (remainingUnpaid === 0) {
    await env.DB.prepare("UPDATE loans SET status = 'CLOSED', closed_at = ? WHERE id = ?").bind(now, loanId).run();
  }

  await writeAuditLog(env, user.id, 'RECEIVE_LOAN_PAYMENT', 'LOAN', loanId, { amount, principalApplied, interestApplied, lateFeeApplied });

  return jsonOk({
    paymentId,
    appliedSatang: amount - remaining,
    unappliedSatang: remaining,
    principalAppliedSatang: principalApplied,
    interestAppliedSatang: interestApplied,
    lateFeeAppliedSatang: lateFeeApplied,
    loanClosed: remainingUnpaid === 0
  });
}

/** Checks whether a member has any loan not yet CLOSED/REJECTED -- used to block account closure / graduation purge. */
export async function memberHasOpenLoan(env, memberId) {
  const row = await env.DB
    .prepare("SELECT id FROM loans WHERE member_id = ? AND status IN ('PENDING','APPROVED','DISBURSED') LIMIT 1")
    .bind(memberId)
    .first();
  return !!row;
}

async function assessLateFees(env, loanId) {
  const loan = await env.DB.prepare('SELECT l.*, p.late_fee_satang FROM loans l JOIN loan_products p ON p.id = l.loan_product_id WHERE l.id = ?').bind(loanId).first();
  if (!loan || !loan.late_fee_satang) return;

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE loan_schedule SET late_fee_due_satang = ?
     WHERE loan_id = ? AND status != 'PAID' AND due_date < ? AND late_fee_due_satang = 0`
  ).bind(loan.late_fee_satang, loanId, now).run();
}

async function getLoanWithMember(env, loanId) {
  return env.DB.prepare(
    `SELECT l.*, m.prefix, m.first_name, m.last_name, m.school_student_id, p.name as product_name
     FROM loans l JOIN members m ON m.id = l.member_id JOIN loan_products p ON p.id = l.loan_product_id
     WHERE l.id = ?`
  ).bind(loanId).first();
}

function loanSummaryResponse(l) {
  return {
    loanId: l.id,
    loanNo: l.loan_no,
    memberId: l.member_id,
    memberName: `${l.prefix || ''}${l.first_name} ${l.last_name}`.trim(),
    productName: l.product_name,
    principalSatang: l.principal_satang,
    termMonths: l.term_months,
    interestMethod: l.interest_method,
    annualInterestRatePercent: l.annual_interest_rate_bps / 100,
    status: l.status,
    appliedAt: l.applied_at,
    approvedAt: l.approved_at,
    disbursedAt: l.disbursed_at,
    closedAt: l.closed_at,
    rejectedReason: l.rejected_reason,
    note: l.note
  };
}

function scheduleRowResponse(r) {
  return {
    scheduleId: r.id,
    installmentNo: r.installment_no,
    dueDate: r.due_date,
    principalDueSatang: r.principal_due_satang,
    interestDueSatang: r.interest_due_satang,
    principalPaidSatang: r.principal_paid_satang,
    interestPaidSatang: r.interest_paid_satang,
    lateFeeDueSatang: r.late_fee_due_satang,
    lateFeePaidSatang: r.late_fee_paid_satang,
    status: r.status
  };
}

async function generateLoanNo(env) {
  const year = new Date().getFullYear() + 543;
  const prefix = `LN${year}`;
  const row = await env.DB
    .prepare('SELECT loan_no FROM loans WHERE loan_no LIKE ? ORDER BY loan_no DESC LIMIT 1')
    .bind(`${prefix}%`).first();
  let next = 1;
  if (row && row.loan_no) {
    const tail = parseInt(row.loan_no.slice(prefix.length), 10);
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}
