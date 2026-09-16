import { requirePermission, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';

export async function handleSearchAccounts(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_VIEW_TRANSACTIONS');
  if (error) return error;

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jsonOk({ accounts: [] });

  const like = `%${q}%`;
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.account_no, a.account_type, a.status, a.balance,
            m.school_student_id, m.prefix, m.first_name, m.last_name, m.grade, m.room
     FROM accounts a JOIN members m ON m.id = a.member_id
     WHERE a.status = 'ACTIVE' AND (
       a.account_no LIKE ? OR
       m.school_student_id LIKE ? OR
       (m.prefix || m.first_name || ' ' || m.last_name) LIKE ?
     )
     LIMIT 20`
  ).bind(like, like, like).all();

  return jsonOk({
    accounts: results.map((r) => ({
      accountId: r.id,
      accountNo: r.account_no,
      accountType: r.account_type,
      status: r.status,
      balance: r.balance,
      fullName: `${r.prefix || ''}${r.first_name} ${r.last_name}`.trim(),
      schoolStudentId: r.school_student_id,
      grade: r.grade,
      room: r.room
    }))
  });
}

export async function handleOpenAccount(request, env) {
  const { user, error } = await requirePermission(request, env, 'CAN_OPEN_ACCOUNT');
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const schoolStudentId = String(body.schoolStudentId || '').trim();
  const prefix = String(body.prefix || '').trim();
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const grade = String(body.grade || '').trim();
  const room = String(body.room || '').trim();
  const accountType = String(body.accountType || 'SAVINGS').trim().toUpperCase();
  const openingBalanceSatang = Math.round(Number(body.openingBalanceSatang || 0));

  if (!firstName || !lastName) return jsonError('กรุณากรอกชื่อ-นามสกุล');
  if (!['SAVINGS', 'SHARE'].includes(accountType)) return jsonError('ประเภทบัญชีไม่ถูกต้อง');
  if (openingBalanceSatang < 0) return jsonError('ยอดเปิดบัญชีต้องไม่ติดลบ');

  const now = Date.now();

  // Reuse an existing member with the same school_student_id, otherwise
  // create a new one. Keeps re-opening an account for the same student from
  // creating duplicate member rows.
  let member = schoolStudentId
    ? await env.DB.prepare('SELECT id FROM members WHERE school_student_id = ?').bind(schoolStudentId).first()
    : null;

  const memberId = member ? member.id : newId('MBR');
  const accountId = newId('ACC');
  const accountNo = await generateAccountNo(env);

  const statements = [];
  if (!member) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO members (id, school_student_id, prefix, first_name, last_name, grade, room, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(memberId, schoolStudentId || null, prefix, firstName, lastName, grade, room, 'ACTIVE', now)
    );
  }

  statements.push(
    env.DB.prepare(
      'INSERT INTO accounts (id, account_no, member_id, account_type, status, balance, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(accountId, accountNo, memberId, accountType, 'ACTIVE', openingBalanceSatang, now, now)
  );

  if (openingBalanceSatang > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO transactions (id, bank_session_id, account_id, type, amount, balance_before, balance_after, location_id, user_id, note, created_at)
         VALUES (?, NULL, ?, 'OPENING_DEPOSIT', ?, 0, ?, NULL, ?, 'ยอดเปิดบัญชี', ?)`
      ).bind(newId('TX'), accountId, openingBalanceSatang, openingBalanceSatang, user.id, now)
    );
  }

  await env.DB.batch(statements);
  await writeAuditLog(env, user.id, 'OPEN_ACCOUNT', 'ACCOUNT', accountId, {
    accountNo, memberId, accountType, openingBalanceSatang
  });

  return jsonOk({ accountId, accountNo, memberId });
}

async function generateAccountNo(env) {
  // Simple sequential account number: year + running 4-digit counter.
  // Adjust to match whatever numbering scheme the school actually wants.
  const year = new Date().getFullYear() + 543; // Buddhist year, matches Thai convention
  const prefix = `${year}`;
  const row = await env.DB
    .prepare("SELECT account_no FROM accounts WHERE account_no LIKE ? ORDER BY account_no DESC LIMIT 1")
    .bind(`${prefix}%`)
    .first();

  let next = 1;
  if (row && row.account_no) {
    const tail = parseInt(row.account_no.slice(prefix.length), 10);
    if (Number.isFinite(tail)) next = tail + 1;
  }

  return `${prefix}${String(next).padStart(4, '0')}`;
}
