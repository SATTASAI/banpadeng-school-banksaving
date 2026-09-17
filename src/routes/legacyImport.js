// Phase 6: one-time import from the legacy Apps Script "BPD School Bank"
// backup (.xlsx export from that system's own backup feature). The browser
// parses the workbook client-side (SheetJS, see public/app.html) and posts
// the three relevant sheets -- BANK_MEMBERS, ACCOUNTS, TRANSACTIONS -- as
// row-object arrays using the exact column headers that system exports
// (verified against a real backup file: MEMBER_ID/MEMBER_TYPE/PREFIX/
// FIRST_NAME/LAST_NAME/LEVEL_NAME/STATUS, ACCOUNT_ID/ACCOUNT_NO/OWNER_ID/
// ACCOUNT_TYPE/STATUS/BALANCE/OPEN_DATE, TX_ID/ACCOUNT_ID/TIMESTAMP/TYPE/
// AMOUNT/BALANCE_BEFORE/BALANCE_AFTER/USERNAME/NOTE).
//
// Safety pattern: preview computes a SHA-256 digest of the raw payload the
// admin is looking at and stores only that digest (not the payload) behind
// a short-lived token. Commit re-sends the same payload; if its digest
// doesn't match, the commit is rejected rather than trusting stale data --
// this avoids ever holding a multi-MB blob in a D1 row.

import { requireAdmin, newId, writeAuditLog, jsonOk, jsonError } from '../auth.js';
import { bahtToSatang } from '../money.js';

const PREVIEW_TTL_MS = 15 * 60 * 1000; // longer than other preview tokens -- this dataset can be large to review
const INSERT_CHUNK_SIZE = 40;

const CREDIT_TYPES = new Set(['DEPOSIT', 'OPENING_DEPOSIT', 'INTEREST', 'DIVIDEND']);
const DEBIT_TYPES = new Set(['WITHDRAW', 'CLOSE_WITHDRAW']);

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canonicalPayloadString(raw) {
  // Stable stringify: sort each row's keys so the same data always hashes
  // the same way regardless of how the browser's JSON.stringify ordered them.
  const sortRows = (rows) => (Array.isArray(rows) ? rows : []).map((row) => {
    const out = {};
    for (const k of Object.keys(row || {}).sort()) out[k] = row[k];
    return out;
  });
  return JSON.stringify({
    members: sortRows(raw.members),
    accounts: sortRows(raw.accounts),
    transactions: sortRows(raw.transactions)
  });
}

function parseLevelName(levelName, memberType) {
  if (memberType !== 'STUDENT' || !levelName || levelName === 'ไม่ระบุ') return { grade: null, room: null };
  const parts = String(levelName).split('/');
  return {
    grade: parts[0] && parts[0].trim() ? parts[0].trim() : null,
    room: parts[1] && parts[1].trim() ? parts[1].trim() : null
  };
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Normalizes the raw {members, accounts, transactions} sheet-row arrays into
 * what commit needs to insert, plus a summary for the preview screen. Pure
 * function of its input -- preview and commit both call this so they always
 * agree, given the same (hash-verified) payload.
 */
function normalizeLegacyPayload(raw) {
  const warnings = [];
  const membersById = new Map();
  const memberFirstMissing = [];

  for (const m of raw.members || []) {
    const memberId = m.MEMBER_ID;
    if (!memberId) continue;
    let firstName = (m.FIRST_NAME || '').toString().trim();
    let lastName = (m.LAST_NAME || '').toString().trim();
    if (!firstName && !lastName) {
      firstName = '(ไม่ทราบชื่อ จากการนำเข้า)';
      lastName = '';
      memberFirstMissing.push(memberId);
    }
    const { grade, room } = parseLevelName(m.LEVEL_NAME, m.MEMBER_TYPE);
    membersById.set(memberId, {
      legacyMemberId: memberId,
      prefix: (m.PREFIX || '').toString().trim(),
      firstName,
      lastName,
      grade: m.MEMBER_TYPE === 'STUDENT' ? grade : null,
      room: m.MEMBER_TYPE === 'STUDENT' ? room : null
    });
  }

  const accounts = [];
  const skippedAccounts = [];
  for (const a of raw.accounts || []) {
    const accountId = a.ACCOUNT_ID;
    const accountNo = a.ACCOUNT_NO != null ? String(a.ACCOUNT_NO).trim() : '';
    const ownerId = a.OWNER_ID;
    if (!accountId || !accountNo) { skippedAccounts.push({ accountId, reason: 'ไม่มีเลขบัญชี' }); continue; }
    if (!ownerId || !membersById.has(ownerId)) { skippedAccounts.push({ accountId, accountNo, reason: 'ไม่พบเจ้าของบัญชี (OWNER_ID)' }); continue; }
    const accountType = a.ACCOUNT_TYPE === 'SHARE' ? 'SHARE' : 'SAVINGS';
    accounts.push({
      legacyAccountId: accountId,
      accountNo,
      ownerId,
      accountType,
      status: a.STATUS === 'CLOSED' ? 'CLOSED' : 'ACTIVE',
      statedBalanceSatang: bahtToSatang(a.BALANCE || 0),
      openedAtMs: parseDateMs(a.OPEN_DATE),
      closedAtMs: parseDateMs(a.CLOSED_AT)
    });
  }
  const accountsByLegacyId = new Map(accounts.map((a) => [a.legacyAccountId, a]));

  const txByAccount = new Map();
  const skippedTxUnknownType = {};
  let orphanTxCount = 0;

  for (const t of raw.transactions || []) {
    const accountId = t.ACCOUNT_ID;
    const account = accountsByLegacyId.get(accountId);
    if (!account) { orphanTxCount++; continue; }

    const rawType = t.TYPE;
    let newType;
    if (rawType === 'REVERSAL') {
      const before = Number(t.BALANCE_BEFORE || 0);
      const after = Number(t.BALANCE_AFTER || 0);
      newType = after >= before ? 'DEPOSIT' : 'WITHDRAW';
    } else if (CREDIT_TYPES.has(rawType)) {
      newType = rawType; // DEPOSIT / OPENING_DEPOSIT / INTEREST / DIVIDEND pass through unchanged
    } else if (DEBIT_TYPES.has(rawType)) {
      newType = 'WITHDRAW';
    } else {
      skippedTxUnknownType[rawType] = (skippedTxUnknownType[rawType] || 0) + 1;
      continue;
    }

    const amountSatang = bahtToSatang(t.AMOUNT || 0);
    const list = txByAccount.get(accountId) || [];
    let note = (t.NOTE || '').toString().trim();
    if (rawType === 'CLOSE_WITHDRAW') note = (note ? note + ' ' : '') + '(ถอนปิดบัญชีจากระบบเดิม)';
    if (rawType === 'REVERSAL') note = (note ? note + ' ' : '') + '(รายการยกเลิก/กลับรายการจากระบบเดิม)';
    if (t.STATUS === 'REVERSED') note = (note ? note + ' ' : '') + '(รายการนี้ถูกยกเลิกในระบบเดิม)';
    const username = (t.USERNAME || '').toString().trim();
    if (username) note = `${note ? note + ' — ' : ''}ผู้ทำรายการเดิม: ${username}`;

    list.push({
      timestampMs: parseDateMs(t.TIMESTAMP),
      type: newType,
      amountSatang,
      note: note.slice(0, 300)
    });
    txByAccount.set(accountId, list);
  }

  // Chronological replay per account, plus a reconciling adjustment entry
  // if the replayed ending balance doesn't match the account's stated
  // current balance (keeps the ledger internally consistent either way).
  let adjustmentCount = 0;
  let totalAdjustmentSatang = 0;
  const preparedTxByAccount = new Map();

  for (const account of accounts) {
    const rows = (txByAccount.get(account.legacyAccountId) || [])
      .slice()
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));

    let running = 0;
    const prepared = [];
    for (const row of rows) {
      const delta = CREDIT_TYPES.has(row.type) ? row.amountSatang : -row.amountSatang;
      const before = running;
      running += delta;
      prepared.push({ timestampMs: row.timestampMs, type: row.type, amountSatang: row.amountSatang, note: row.note, balanceBeforeSatang: before, balanceAfterSatang: running });
    }

    const diff = account.statedBalanceSatang - running;
    if (diff !== 0) {
      adjustmentCount++;
      totalAdjustmentSatang += Math.abs(diff);
      prepared.push({
        timestampMs: null, // inserted "now" at commit time
        type: diff > 0 ? 'DEPOSIT' : 'WITHDRAW',
        amountSatang: Math.abs(diff),
        note: 'ปรับยอดจากการนำเข้าข้อมูลระบบเดิม (ผลต่างระหว่างยอดที่คำนวณจากประวัติกับยอดที่บันทึกไว้)',
        balanceBeforeSatang: running,
        balanceAfterSatang: account.statedBalanceSatang
      });
      running = account.statedBalanceSatang;
    }

    preparedTxByAccount.set(account.legacyAccountId, prepared);
  }

  const usedOwnerIds = new Set(accounts.map((a) => a.ownerId));
  const membersToImport = accounts.length ? [...usedOwnerIds].map((id) => ({ legacyMemberId: id, ...membersById.get(id) })) : [];

  const summary = {
    memberCount: membersToImport.length,
    membersWithPlaceholderName: memberFirstMissing,
    accountCount: accounts.length,
    skippedAccounts,
    transactionCount: [...preparedTxByAccount.values()].reduce((n, list) => n + list.length, 0),
    orphanTxCount,
    skippedTxUnknownType,
    adjustmentCount,
    totalAdjustmentSatang
  };

  return { membersToImport, accounts, preparedTxByAccount, summary };
}

export async function handlePreviewLegacyImport(request, env) {
  const { user, error } = await requireAdmin(request, env);
  if (error) return error;

  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== 'object') return jsonError('รูปแบบข้อมูลไม่ถูกต้อง');
  if (!Array.isArray(raw.members) || !Array.isArray(raw.accounts) || !Array.isArray(raw.transactions)) {
    return jsonError('ไฟล์นี้ไม่มีชีต BANK_MEMBERS / ACCOUNTS / TRANSACTIONS ที่ระบบต้องการ');
  }
  if (!raw.members.length || !raw.accounts.length) {
    return jsonError('ไม่พบข้อมูลสมาชิกหรือบัญชีในไฟล์ที่อัปโหลด');
  }

  const canonical = canonicalPayloadString(raw);
  const payloadHash = await sha256Hex(canonical);
  const { summary } = normalizeLegacyPayload(raw);

  const token = newId('LIT');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO legacy_import_tokens (token, admin_id, payload_hash, summary_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(token, user.id, payloadHash, JSON.stringify(summary), now, now + PREVIEW_TTL_MS).run();

  return jsonOk({ token, summary, expiresAt: now + PREVIEW_TTL_MS });
}

export async function handleCommitLegacyImport(request, env) {
  const { user, error } = await requireAdmin(request, env);
  if (error) return error;

  const body = await request.json().catch(() => null);
  if (!body || !body.token) return jsonError('ไม่พบข้อมูลการตรวจสอบล่วงหน้า กรุณาคำนวณตัวอย่างใหม่');

  const preview = await env.DB.prepare('SELECT * FROM legacy_import_tokens WHERE token = ?').bind(body.token).first();
  if (!preview) return jsonError('ข้อมูลตรวจสอบล่วงหน้าหมดอายุหรือไม่ถูกต้อง กรุณาคำนวณตัวอย่างใหม่');
  if (preview.admin_id !== user.id) return jsonError('กรุณาดำเนินการด้วยผู้ใช้งานคนเดียวกับที่ตรวจสอบตัวอย่างไว้');
  if (preview.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM legacy_import_tokens WHERE token = ?').bind(body.token).run();
    return jsonError('ข้อมูลตรวจสอบล่วงหน้าหมดอายุแล้ว กรุณาคำนวณตัวอย่างใหม่');
  }

  const raw = { members: body.members, accounts: body.accounts, transactions: body.transactions };
  if (!Array.isArray(raw.members) || !Array.isArray(raw.accounts) || !Array.isArray(raw.transactions)) {
    return jsonError('รูปแบบข้อมูลไม่ถูกต้อง');
  }

  const canonical = canonicalPayloadString(raw);
  const payloadHash = await sha256Hex(canonical);
  if (payloadHash !== preview.payload_hash) {
    return jsonError('ข้อมูลที่ส่งมาไม่ตรงกับตอนตรวจสอบตัวอย่าง (ไฟล์อาจถูกเปลี่ยน) กรุณาคำนวณตัวอย่างใหม่');
  }

  const { membersToImport, accounts, preparedTxByAccount, summary } = normalizeLegacyPayload(raw);
  const now = Date.now();

  // Skip any account whose account_no already exists -- makes a repeat
  // commit (double-click, retried upload) a safe no-op rather than a
  // duplicate import, and mirrors the idempotency approach used elsewhere
  // in this codebase (deposit/withdraw requestId, interest run tokens).
  const accountNos = accounts.map((a) => a.accountNo);
  const existing = new Set();
  for (let i = 0; i < accountNos.length; i += 200) {
    const chunk = accountNos.slice(i, i + 200);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(`SELECT account_no FROM accounts WHERE account_no IN (${placeholders})`).bind(...chunk).all();
    for (const r of results) existing.add(r.account_no);
  }

  const accountsToCreate = accounts.filter((a) => !existing.has(a.accountNo));
  const skippedDuplicateCount = accounts.length - accountsToCreate.length;
  const neededOwnerIds = new Set(accountsToCreate.map((a) => a.ownerId));
  const membersToCreate = membersToImport.filter((m) => neededOwnerIds.has(m.legacyMemberId));

  const memberIdByLegacy = new Map();
  const memberStatements = [];
  for (const m of membersToCreate) {
    const memberId = newId('MBR');
    memberIdByLegacy.set(m.legacyMemberId, memberId);
    memberStatements.push(
      env.DB.prepare(
        'INSERT INTO members (id, school_student_id, prefix, first_name, last_name, grade, room, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(memberId, m.prefix, m.firstName, m.lastName, m.grade, m.room, 'ACTIVE', now)
    );
  }

  let transactionCount = 0;
  const accountStatements = [];
  const txStatements = [];
  for (const a of accountsToCreate) {
    const memberId = memberIdByLegacy.get(a.ownerId);
    const accountId = newId('ACC');
    const openedAt = a.openedAtMs || now;
    accountStatements.push(
      env.DB.prepare(
        'INSERT INTO accounts (id, account_no, member_id, account_type, status, balance, opened_at, closed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(accountId, a.accountNo, memberId, a.accountType, a.status, a.statedBalanceSatang, openedAt, a.status === 'CLOSED' ? (a.closedAtMs || now) : null, now)
    );

    const rows = preparedTxByAccount.get(a.legacyAccountId) || [];
    for (const row of rows) {
      transactionCount++;
      const createdAt = row.timestampMs || now;
      txStatements.push(
        env.DB.prepare(
          `INSERT INTO transactions (id, bank_session_id, account_id, type, amount, balance_before, balance_after, location_id, user_id, note, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
        ).bind(newId('TX'), accountId, row.type, row.amountSatang, row.balanceBeforeSatang, row.balanceAfterSatang, user.id, `[นำเข้าจากระบบเดิม] ${row.note}`.slice(0, 300), createdAt)
      );
    }
  }

  const allStatements = [...memberStatements, ...accountStatements, ...txStatements];
  for (let i = 0; i < allStatements.length; i += INSERT_CHUNK_SIZE) {
    await env.DB.batch(allStatements.slice(i, i + INSERT_CHUNK_SIZE));
  }

  await env.DB.prepare('DELETE FROM legacy_import_tokens WHERE token = ?').bind(body.token).run();

  const resultSummary = {
    ...summary,
    memberCount: membersToCreate.length,
    accountCount: accountsToCreate.length,
    transactionCount,
    skippedDuplicateAccountCount: skippedDuplicateCount
  };

  await env.DB.prepare(
    `INSERT INTO legacy_import_log (id, admin_id, imported_at, member_count, account_count, transaction_count, skipped_account_count, adjustment_count, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(newId('LIL'), user.id, now, membersToCreate.length, accountsToCreate.length, transactionCount, skippedDuplicateCount, summary.adjustmentCount, JSON.stringify(resultSummary)).run();

  await writeAuditLog(env, user.id, 'IMPORT_LEGACY_BACKUP', 'LEGACY_IMPORT', null, resultSummary);

  return jsonOk(resultSummary);
}

export async function handleListLegacyImportLog(request, env) {
  const { error } = await requireAdmin(request, env);
  if (error) return error;

  const { results } = await env.DB.prepare(
    `SELECT l.*, u.display_name as admin_name FROM legacy_import_log l JOIN users u ON u.id = l.admin_id ORDER BY l.imported_at DESC LIMIT 50`
  ).all();

  return jsonOk({
    logs: results.map((r) => ({
      id: r.id,
      adminName: r.admin_name,
      importedAt: r.imported_at,
      memberCount: r.member_count,
      accountCount: r.account_count,
      transactionCount: r.transaction_count,
      skippedAccountCount: r.skipped_account_count,
      adjustmentCount: r.adjustment_count
    }))
  });
}
