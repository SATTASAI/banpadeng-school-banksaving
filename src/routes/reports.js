// Phase 5: reports/summary + detailed transaction history.
// Read-only aggregation endpoints -- no schema changes needed here beyond
// what 0001-0004 already provide, since everything below is computed
// on-the-fly from accounts/transactions/members/loans.

import { requirePermission, jsonOk, jsonError } from '../auth.js';

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function handleReportsSummary(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_VIEW_REPORTS');
  if (error) return error;

  const url = new URL(request.url);
  const from = Number(url.searchParams.get('from') || 0) || startOfTodayMs();
  const to = Number(url.searchParams.get('to') || 0) || Date.now();

  const accountTotals = await env.DB.prepare(
    `SELECT account_type,
            COUNT(*) as account_count,
            COALESCE(SUM(balance), 0) as total_balance
     FROM accounts WHERE status = 'ACTIVE' GROUP BY account_type`
  ).all();

  const memberCounts = await env.DB.prepare(
    `SELECT COUNT(*) as active_members FROM members WHERE status = 'ACTIVE'`
  ).first();

  const txByType = await env.DB.prepare(
    `SELECT type, COUNT(*) as tx_count, COALESCE(SUM(amount), 0) as total_amount
     FROM transactions WHERE created_at BETWEEN ? AND ? GROUP BY type`
  ).bind(from, to).all();

  const loanOutstanding = await env.DB.prepare(
    `SELECT COUNT(*) as loan_count,
            COALESCE(SUM(principal_satang), 0) as total_principal
     FROM loans WHERE status = 'DISBURSED'`
  ).first();

  const bankSession = await env.DB.prepare(
    "SELECT id, opened_at FROM bank_sessions WHERE status = 'OPEN' LIMIT 1"
  ).first();

  return jsonOk({
    from, to,
    activeMembers: memberCounts.active_members,
    accountsByType: accountTotals.results.map((r) => ({
      accountType: r.account_type,
      accountCount: r.account_count,
      totalBalanceSatang: r.total_balance
    })),
    transactionsByType: txByType.results.map((r) => ({
      type: r.type,
      txCount: r.tx_count,
      totalAmountSatang: r.total_amount
    })),
    loans: {
      outstandingCount: loanOutstanding.loan_count,
      outstandingPrincipalSatang: loanOutstanding.total_principal
    },
    bankSessionOpen: !!bankSession,
    bankSessionOpenedAt: bankSession ? bankSession.opened_at : null
  });
}

export async function handleReportsByClass(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_VIEW_REPORTS');
  if (error) return error;

  const { results } = await env.DB.prepare(
    `SELECT m.grade, m.room,
            COUNT(DISTINCT m.id) as member_count,
            COUNT(a.id) as account_count,
            COALESCE(SUM(a.balance), 0) as total_balance
     FROM members m
     JOIN accounts a ON a.member_id = m.id AND a.status = 'ACTIVE'
     WHERE m.status = 'ACTIVE'
     GROUP BY m.grade, m.room
     ORDER BY m.grade, m.room`
  ).all();

  return jsonOk({
    classes: results.map((r) => ({
      grade: r.grade || '(ไม่ระบุชั้น)',
      room: r.room || '(ไม่ระบุห้อง)',
      memberCount: r.member_count,
      accountCount: r.account_count,
      totalBalanceSatang: r.total_balance
    }))
  });
}

const TX_TYPES = ['DEPOSIT', 'WITHDRAW', 'OPENING_DEPOSIT', 'INTEREST', 'DIVIDEND'];

export async function handleTransactionsDetailed(request, env) {
  const { error } = await requirePermission(request, env, 'CAN_VIEW_TRANSACTIONS');
  if (error) return error;

  const url = new URL(request.url);
  const from = Number(url.searchParams.get('from') || 0) || 0;
  const to = Number(url.searchParams.get('to') || 0) || Date.now();
  const type = String(url.searchParams.get('type') || '').trim().toUpperCase();
  const userId = String(url.searchParams.get('userId') || '').trim();
  const locationId = String(url.searchParams.get('locationId') || '').trim();
  const q = String(url.searchParams.get('q') || '').trim();
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

  const where = ['t.created_at BETWEEN ? AND ?'];
  const params = [from, to];

  if (type && TX_TYPES.includes(type)) { where.push('t.type = ?'); params.push(type); }
  if (userId) { where.push('t.user_id = ?'); params.push(userId); }
  if (locationId) { where.push('t.location_id = ?'); params.push(locationId); }
  if (q) {
    where.push('(a.account_no LIKE ? OR (m.prefix || m.first_name || \' \' || m.last_name) LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const whereSql = where.join(' AND ');

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     JOIN members m ON m.id = a.member_id
     WHERE ${whereSql}`
  ).bind(...params).first();

  const { results } = await env.DB.prepare(
    `SELECT t.*, a.account_no, m.prefix, m.first_name, m.last_name, u.display_name as teller_name, l.name as location_name
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     JOIN members m ON m.id = a.member_id
     JOIN users u ON u.id = t.user_id
     LEFT JOIN locations l ON l.id = t.location_id
     WHERE ${whereSql}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return jsonOk({
    total: countRow.total,
    limit, offset,
    transactions: results.map((t) => ({
      txId: t.id,
      type: t.type,
      amountSatang: t.amount,
      balanceBeforeSatang: t.balance_before,
      balanceAfterSatang: t.balance_after,
      accountNo: t.account_no,
      fullName: `${t.prefix || ''}${t.first_name} ${t.last_name}`.trim(),
      tellerName: t.teller_name,
      locationName: t.location_name || '',
      note: t.note,
      voidReason: t.void_reason,
      reversedByTxId: t.reversed_by_tx_id,
      reversalOfTxId: t.reversal_of_tx_id,
      createdAt: t.created_at
    }))
  });
}
