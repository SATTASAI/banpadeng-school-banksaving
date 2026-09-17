import { requireAdmin, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';

// Table list in parent-before-child order (for restore inserts). Deliberately
// excludes ephemeral/security tables: sessions, login_failures and
// graduation_preview_tokens are not meaningful to restore and restoring them
// would just resurrect stale locks/tokens.
const BACKUP_TABLES = [
  { name: 'users', columns: ['id', 'username', 'password_hash', 'display_name', 'role', 'active', 'created_at', 'last_login_at'] },
  { name: 'locations', columns: ['id', 'name', 'type', 'active', 'sort_order'] },
  { name: 'members', columns: ['id', 'school_student_id', 'prefix', 'first_name', 'last_name', 'grade', 'room', 'status', 'created_at'] },
  { name: 'loan_products', columns: ['id', 'name', 'interest_method', 'annual_interest_rate_bps', 'late_fee_satang', 'max_principal_satang', 'active', 'created_at'] },
  { name: 'accounts', columns: ['id', 'account_no', 'member_id', 'account_type', 'status', 'balance', 'opened_at', 'closed_at', 'updated_at'] },
  { name: 'bank_sessions', columns: ['id', 'status', 'opened_at', 'opened_by', 'closed_at', 'closed_by', 'note'] },
  { name: 'transactions', columns: ['id', 'bank_session_id', 'account_id', 'type', 'amount', 'balance_before', 'balance_after', 'location_id', 'user_id', 'note', 'request_id', 'created_at', 'reversed_by_tx_id', 'reversal_of_tx_id', 'void_reason'] },
  { name: 'user_permissions', columns: ['user_id', 'permission', 'granted'] },
  { name: 'loans', columns: ['id', 'loan_no', 'member_id', 'loan_product_id', 'principal_satang', 'term_months', 'interest_method', 'annual_interest_rate_bps', 'status', 'applied_at', 'applied_by', 'approved_at', 'approved_by', 'rejected_reason', 'disbursed_at', 'disbursed_by', 'disburse_account_id', 'closed_at', 'note'] },
  { name: 'loan_schedule', columns: ['id', 'loan_id', 'installment_no', 'due_date', 'principal_due_satang', 'interest_due_satang', 'principal_paid_satang', 'interest_paid_satang', 'late_fee_due_satang', 'late_fee_paid_satang', 'status'] },
  { name: 'loan_payments', columns: ['id', 'loan_id', 'amount_satang', 'principal_applied_satang', 'interest_applied_satang', 'late_fee_applied_satang', 'user_id', 'note', 'request_id', 'created_at'] },
  { name: 'cash_handovers', columns: ['id', 'from_user_id', 'to_user_id', 'amount_satang', 'note', 'status', 'created_at', 'confirmed_at', 'bank_session_id'] },
  { name: 'graduation_batches', columns: ['id', 'grade', 'executed_by', 'executed_at', 'member_count', 'snapshot_json', 'note'] },
  { name: 'interest_runs', columns: ['id', 'account_type', 'tx_type', 'rate_bps', 'period_label', 'run_by', 'run_at', 'account_count', 'skipped_count', 'total_amount_satang', 'note'] },
  { name: 'interest_run_items', columns: ['id', 'run_id', 'account_id', 'tx_id', 'balance_before_satang', 'amount_satang'] },
  { name: 'legacy_import_log', columns: ['id', 'admin_id', 'imported_at', 'member_count', 'account_count', 'transaction_count', 'skipped_account_count', 'adjustment_count', 'summary_json'] },
  { name: 'settings', columns: ['key', 'value', 'description', 'updated_by', 'updated_at'] }
];

const BACKUP_VERSION = 1;
const RESTORE_CONFIRM_TEXT = 'ยืนยันกู้คืนฐานข้อมูล';
const INSERT_CHUNK_SIZE = 40; // keep each D1 batch() call well under any statement-count limit

export async function handleExportBackup(request, env) {
  const { user, error } = await requireAdmin(request, env);
  if (error) return error;

  const tables = {};
  const counts = {};
  for (const t of BACKUP_TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t.name}`).all();
    tables[t.name] = results;
    counts[t.name] = results.length;
  }

  await env.DB.prepare(
    'INSERT INTO backup_log (id, action, user_id, table_counts_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(newId('BAK'), 'EXPORT', user.id, JSON.stringify(counts), Date.now()).run();
  await writeAuditLog(env, user.id, 'EXPORT_BACKUP', 'BACKUP', null, counts);

  const snapshot = {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    exportedBy: user.username,
    tables
  };

  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="bpd-school-bank-backup-${new Date().toISOString().slice(0, 10)}.json"`
    }
  });
}

export async function handleRestoreBackup(request, env) {
  const { user, error } = await requireAdmin(request, env);
  if (error) return error;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError('ไฟล์สำรองข้อมูลไม่ถูกต้อง (ไม่ใช่ JSON)');

  const confirmText = String(body.confirmText || '').trim();
  if (confirmText !== RESTORE_CONFIRM_TEXT) {
    return jsonError(`กรุณาพิมพ์ข้อความยืนยันให้ตรงทุกตัวอักษร: "${RESTORE_CONFIRM_TEXT}"`);
  }

  const snapshot = body.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.tables || snapshot.version !== BACKUP_VERSION) {
    return jsonError('รูปแบบไฟล์สำรองข้อมูลไม่ถูกต้อง หรือคนละเวอร์ชันกับระบบปัจจุบัน');
  }

  const counts = {};

  // Delete in reverse (child-before-parent) order, then insert in
  // parent-before-child order -- run per table rather than one giant batch
  // so a large transaction history never risks hitting a D1 batch limit.
  for (const t of [...BACKUP_TABLES].reverse()) {
    await env.DB.prepare(`DELETE FROM ${t.name}`).run();
  }

  for (const t of BACKUP_TABLES) {
    const rows = Array.isArray(snapshot.tables[t.name]) ? snapshot.tables[t.name] : [];
    counts[t.name] = rows.length;
    const placeholders = `(${t.columns.map(() => '?').join(', ')})`;
    const sql = `INSERT INTO ${t.name} (${t.columns.join(', ')}) VALUES ${placeholders}`;

    for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
      const statements = chunk.map((row) =>
        env.DB.prepare(sql).bind(...t.columns.map((c) => (row[c] === undefined ? null : row[c])))
      );
      if (statements.length) await env.DB.batch(statements);
    }
  }

  await env.DB.prepare(
    'INSERT INTO backup_log (id, action, user_id, table_counts_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(newId('BAK'), 'RESTORE', user.id, JSON.stringify(counts), Date.now()).run();
  await writeAuditLog(env, user.id, 'RESTORE_BACKUP', 'BACKUP', null, counts);

  return jsonOk({ restoredCounts: counts });
}

export async function handleListBackupLog(request, env) {
  const { error } = await requireAdmin(request, env);
  if (error) return error;

  const { results } = await env.DB
    .prepare('SELECT id, action, user_id, table_counts_json, created_at FROM backup_log ORDER BY created_at DESC LIMIT 50')
    .all();

  return jsonOk({
    logs: results.map((r) => ({
      id: r.id,
      action: r.action,
      userId: r.user_id,
      counts: JSON.parse(r.table_counts_json || '{}'),
      createdAt: r.created_at
    }))
  });
}
