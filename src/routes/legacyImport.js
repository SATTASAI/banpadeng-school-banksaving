// Phase 6/7: import a legacy Apps Script "BPD School Bank" backup (.xlsx).
//
// Handles BOTH shapes of backup this school's old Apps Script system can
// export:
//   - the minimal 3-sheet export (BANK_MEMBERS / ACCOUNTS / TRANSACTIONS)
//   - the full-system export (adds USERS / LOCATIONS / SETTINGS /
//     BANK_SESSIONS / CASH_HANDOVERS / USER_PERMISSIONS / LOAN_PRODUCTS)
// Any sheet not present in a given file is simply treated as empty, so the
// admin can upload whichever backup they have and get everything that
// sheet contains imported in one step.
//
// Design choices:
//  - Rows keep their ORIGINAL legacy id as the new row's id wherever the
//    legacy sheet has a natural id column (MEMBER_ID, ACCOUNT_ID, TX_ID,
//    USER_ID, SESSION_ID, HANDOVER_ID, LOCATION_ID, LOAN_PRODUCT_ID). This
//    makes every insert naturally idempotent via `INSERT OR IGNORE` (same
//    file imported twice is a safe no-op) and lets one sheet's rows
//    reference another (e.g. a transaction's ACCOUNT_ID) directly, with no
//    id-remapping step needed.
//  - Tables with a meaningful secondary unique key (users.username,
//    accounts.account_no) are re-resolved by that key AFTER the insert, so
//    a legacy id that collided with a pre-existing different-id row still
//    gets wired up correctly for every other sheet that references it.
//  - Preview computes a SHA-256 digest of the exact payload reviewed and
//    stores only that (not the payload) behind a short-lived token; commit
//    re-sends the same payload and is rejected if the digest changed.
//  - Money fields are baht in the legacy sheets; converted to satang with
//    bahtToSatang() right when each row is normalized.

import { requireAdmin, newId, writeAuditLog, jsonOk, jsonError, createPasswordRecord } from '../auth.js';
import { bahtToSatang } from '../money.js';
import { PERMISSIONS } from '../permissions.js';

const PREVIEW_TTL_MS = 15 * 60 * 1000; // longer than other preview tokens -- this dataset can be large to review
const INSERT_CHUNK_SIZE = 40;

const CREDIT_TYPES = new Set(['DEPOSIT', 'OPENING_DEPOSIT', 'INTEREST', 'DIVIDEND']);
const DEBIT_TYPES = new Set(['WITHDRAW', 'CLOSE_WITHDRAW']);

// Legacy USER_PERMISSIONS column name -> our permissions.js name(s) it maps
// to. Anything not listed here or not an exact-name match is not carried
// over (no equivalent permission exists yet in this system).
const PERMISSION_SYNONYMS = {
  CAN_CREATE_LOAN_APPLICATION: ['CAN_MANAGE_LOANS'],
  CAN_VIEW_LOANS: ['CAN_MANAGE_LOANS'],
  CAN_MANAGE_LOAN_PRODUCTS: ['CAN_MANAGE_LOANS'],
  CAN_REJECT_LOAN: ['CAN_APPROVE_LOAN'],
  CAN_EXPORT_DATA: ['CAN_EXPORT_REPORTS']
};

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
    transactions: sortRows(raw.transactions),
    users: sortRows(raw.users),
    locations: sortRows(raw.locations),
    settings: sortRows(raw.settings),
    bankSessions: sortRows(raw.bankSessions),
    cashHandovers: sortRows(raw.cashHandovers),
    userPermissions: sortRows(raw.userPermissions),
    loanProducts: sortRows(raw.loanProducts)
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
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.getTime();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'TRUE' || v === 'true';
}

async function chunkedBatchInsert(env, sql, valueArrays, chunkSize = INSERT_CHUNK_SIZE) {
  let changes = 0;
  for (let i = 0; i < valueArrays.length; i += chunkSize) {
    const chunk = valueArrays.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const statements = chunk.map((values) => env.DB.prepare(sql).bind(...values));
    const results = await env.DB.batch(statements);
    for (const r of results) changes += (r && r.meta && r.meta.changes) || 0;
  }
  return changes;
}

async function selectExistingMap(env, sql, keys, chunkSize = 200) {
  // Runs `sql` (must select exactly two columns: a lookup key and its id)
  // for `keys` in chunks and returns a Map(lookupKeyValue -> idValue).
  const map = new Map();
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(sql.replace('__IN__', placeholders)).bind(...chunk).all();
    for (const row of results) {
      const vals = Object.values(row);
      map.set(vals[0], vals[1]);
    }
  }
  return map;
}

/**
 * Normalizes the raw sheet-row arrays into what commit needs to insert,
 * plus a summary for the preview screen. Pure function of its input --
 * preview and commit both call this so they always agree, given the same
 * (hash-verified) payload. Does not touch the database.
 */
function normalizeFullPayload(raw) {
  const membersById = new Map();
  const memberFirstMissing = [];
  const memberRows = [];

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
    const record = {
      id: memberId,
      schoolStudentId: m.SCHOOL_ID != null ? String(m.SCHOOL_ID) : null,
      prefix: (m.PREFIX || '').toString().trim(),
      firstName,
      lastName,
      grade: m.MEMBER_TYPE === 'STUDENT' ? grade : null,
      room: m.MEMBER_TYPE === 'STUDENT' ? room : null,
      status: m.STATUS === 'GRADUATED' ? 'GRADUATED' : 'ACTIVE',
      createdAtMs: parseDateMs(m.UPDATED_AT)
    };
    membersById.set(memberId, record);
    memberRows.push(record);
  }

  const accountRows = [];
  const skippedAccounts = [];
  for (const a of raw.accounts || []) {
    const accountId = a.ACCOUNT_ID;
    const accountNo = a.ACCOUNT_NO != null ? String(a.ACCOUNT_NO).trim() : '';
    const ownerId = a.OWNER_ID;
    const isBlankPaddingRow = !accountId && !accountNo && !ownerId; // exported sheets often carry blank template rows past the real data
    if (isBlankPaddingRow) continue;
    if (!accountId || !accountNo) { skippedAccounts.push({ accountId, accountNo, reason: 'ไม่มีเลขบัญชี' }); continue; }
    if (!ownerId || !membersById.has(ownerId)) { skippedAccounts.push({ accountId, accountNo, reason: 'ไม่พบเจ้าของบัญชี (OWNER_ID)' }); continue; }
    accountRows.push({
      id: accountId,
      accountNo,
      ownerId,
      accountType: a.ACCOUNT_TYPE === 'SHARE' ? 'SHARE' : 'SAVINGS',
      status: a.STATUS === 'CLOSED' ? 'CLOSED' : 'ACTIVE',
      balanceSatang: bahtToSatang(a.BALANCE || 0),
      openedAtMs: parseDateMs(a.OPEN_DATE),
      closedAtMs: parseDateMs(a.CLOSED_AT)
    });
  }
  const accountsByLegacyId = new Map(accountRows.map((a) => [a.id, a]));

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
      newType = rawType;
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
      legacyTxId: t.TX_ID || null,
      timestampMs: parseDateMs(t.TIMESTAMP),
      type: newType,
      amountSatang,
      note: note.slice(0, 300),
      legacyUserId: t.USER_ID || null,
      username: username || null,
      legacyLocationId: t.LOCATION_ID || null,
      legacyBankSessionId: t.BANK_SESSION_ID || null
    });
    txByAccount.set(accountId, list);
  }

  // Chronological replay per account, plus a reconciling adjustment entry
  // if the replayed ending balance doesn't match the account's stated
  // current balance (keeps the ledger internally consistent either way).
  let adjustmentCount = 0;
  let totalAdjustmentSatang = 0;
  const preparedTxByAccount = new Map();

  for (const account of accountRows) {
    const rows = (txByAccount.get(account.id) || [])
      .slice()
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));

    let running = 0;
    const prepared = [];
    let seq = 0;
    for (const row of rows) {
      const delta = CREDIT_TYPES.has(row.type) ? row.amountSatang : -row.amountSatang;
      const before = running;
      running += delta;
      prepared.push({
        id: row.legacyTxId || `${account.id}-TX-${seq++}`,
        timestampMs: row.timestampMs,
        type: row.type,
        amountSatang: row.amountSatang,
        note: row.note,
        balanceBeforeSatang: before,
        balanceAfterSatang: running,
        legacyUserId: row.legacyUserId,
        username: row.username,
        legacyLocationId: row.legacyLocationId,
        legacyBankSessionId: row.legacyBankSessionId
      });
    }

    const diff = account.balanceSatang - running;
    if (diff !== 0) {
      adjustmentCount++;
      totalAdjustmentSatang += Math.abs(diff);
      prepared.push({
        id: `${account.id}-ADJ`,
        timestampMs: null, // inserted "now" at commit time
        type: diff > 0 ? 'DEPOSIT' : 'WITHDRAW',
        amountSatang: Math.abs(diff),
        note: 'ปรับยอดจากการนำเข้าข้อมูลระบบเดิม (ผลต่างระหว่างยอดที่คำนวณจากประวัติกับยอดที่บันทึกไว้)',
        balanceBeforeSatang: running,
        balanceAfterSatang: account.balanceSatang,
        legacyUserId: null,
        username: null,
        legacyLocationId: null,
        legacyBankSessionId: null
      });
      running = account.balanceSatang;
    }

    preparedTxByAccount.set(account.id, prepared);
  }

  const usedOwnerIds = new Set(accountRows.map((a) => a.ownerId));
  const membersToImport = memberRows.filter((m) => usedOwnerIds.has(m.id));

  // --- users / permissions ---
  const userRows = [];
  const skippedUsers = [];
  for (const u of raw.users || []) {
    const userId = u.USER_ID;
    const username = (u.USERNAME || '').toString().trim();
    const password = u.PASSWORD;
    if (!userId || !username || password === null || password === undefined || password === '') {
      skippedUsers.push({ userId, username, reason: 'ข้อมูลไม่ครบ (USER_ID/USERNAME/PASSWORD)' });
      continue;
    }
    userRows.push({
      id: userId,
      username,
      password: String(password),
      displayName: (u.DISPLAY_NAME || username).toString().trim(),
      role: (u.ROLE || 'TELLER').toString().trim().toUpperCase(),
      active: truthy(u.ACTIVE),
      createdAtMs: parseDateMs(u.CREATED_AT),
      lastLoginAtMs: parseDateMs(u.LAST_LOGIN)
    });
  }

  const userPermRowsByUserId = new Map();
  for (const p of raw.userPermissions || []) {
    const userId = p.USER_ID;
    if (!userId) continue;
    const granted = new Set();
    for (const key of Object.keys(p)) {
      if (key === 'USER_ID' || key === 'UPDATED_AT' || key === 'UPDATED_BY') continue;
      if (!truthy(p[key])) continue;
      if (PERMISSIONS.includes(key)) granted.add(key);
      if (PERMISSION_SYNONYMS[key]) for (const target of PERMISSION_SYNONYMS[key]) granted.add(target);
    }
    userPermRowsByUserId.set(userId, granted);
  }

  // --- locations ---
  const locationRows = [];
  for (const l of raw.locations || []) {
    if (!l.LOCATION_ID || !l.LOCATION_NAME) continue;
    locationRows.push({
      id: l.LOCATION_ID,
      name: String(l.LOCATION_NAME).trim(),
      type: l.TYPE || null,
      active: truthy(l.ACTIVE) ? 1 : 0,
      sortOrder: Number.isFinite(Number(l.SORT_ORDER)) ? Math.trunc(Number(l.SORT_ORDER)) : 0
    });
  }

  // --- settings ---
  const settingRows = [];
  for (const s of raw.settings || []) {
    if (!s.SETTING_KEY) continue;
    settingRows.push({
      key: String(s.SETTING_KEY).trim(),
      value: s.SETTING_VALUE != null ? String(s.SETTING_VALUE) : null,
      description: s.DESCRIPTION != null ? String(s.DESCRIPTION) : null,
      updatedBy: s.UPDATED_BY != null ? String(s.UPDATED_BY) : null,
      updatedAtMs: parseDateMs(s.UPDATED_AT)
    });
  }

  // --- loan products ---
  const loanProductRows = [];
  for (const lp of raw.loanProducts || []) {
    const id = lp.LOAN_PRODUCT_ID;
    if (!id || !lp.PRODUCT_NAME) continue;
    loanProductRows.push({
      id,
      name: String(lp.PRODUCT_NAME).trim(),
      interestMethod: lp.INTEREST_METHOD === 'FLAT' ? 'FLAT' : 'DECLINING',
      annualInterestRateBps: Math.round(Number(lp.ANNUAL_INTEREST_RATE || 0) * 100),
      lateFeeSatang: bahtToSatang(lp.LATE_CHARGE_VALUE || 0),
      maxPrincipalSatang: lp.MAX_AMOUNT != null ? bahtToSatang(lp.MAX_AMOUNT) : null,
      active: truthy(lp.ACTIVE) ? 1 : 0,
      createdAtMs: parseDateMs(lp.CREATED_AT)
    });
  }

  // --- bank sessions ---
  const bankSessionRows = [];
  for (const bs of raw.bankSessions || []) {
    if (!bs.SESSION_ID) continue;
    bankSessionRows.push({
      id: bs.SESSION_ID,
      status: bs.STATUS === 'OPEN' ? 'OPEN' : 'CLOSED',
      openedAtMs: parseDateMs(bs.OPENED_AT),
      legacyOpenedByUserId: bs.OPENED_BY_USER_ID || null,
      closedAtMs: parseDateMs(bs.CLOSED_AT),
      legacyClosedByUserId: bs.CLOSED_BY_USER_ID || null,
      note: bs.NOTE || null
    });
  }

  // --- cash handovers ---
  const cashHandoverRows = [];
  for (const h of raw.cashHandovers || []) {
    if (!h.HANDOVER_ID) continue;
    let status = 'PENDING';
    if (h.CANCELLED_AT) status = 'CANCELLED';
    else if (h.STATUS === 'RECEIVED' || h.RECEIVED_AT) status = 'CONFIRMED';
    cashHandoverRows.push({
      id: h.HANDOVER_ID,
      legacyFromUserId: h.FROM_USER_ID || null,
      legacyToUserId: h.TO_USER_ID || null,
      amountSatang: bahtToSatang(h.AMOUNT || 0),
      note: h.NOTE || null,
      status,
      createdAtMs: parseDateMs(h.CREATED_AT),
      confirmedAtMs: parseDateMs(h.RECEIVED_AT),
      legacyBankSessionId: h.BANK_SESSION_ID || null
    });
  }

  const summary = {
    memberCount: membersToImport.length,
    membersWithPlaceholderName: memberFirstMissing,
    accountCount: accountRows.length,
    skippedAccounts,
    transactionCount: [...preparedTxByAccount.values()].reduce((n, list) => n + list.length, 0),
    orphanTxCount,
    skippedTxUnknownType,
    adjustmentCount,
    totalAdjustmentSatang,
    userCount: userRows.length,
    skippedUsers,
    locationCount: locationRows.length,
    settingCount: settingRows.length,
    loanProductCount: loanProductRows.length,
    bankSessionCount: bankSessionRows.length,
    cashHandoverCount: cashHandoverRows.length
  };

  return {
    membersToImport,
    accountRows,
    preparedTxByAccount,
    userRows,
    userPermRowsByUserId,
    locationRows,
    settingRows,
    loanProductRows,
    bankSessionRows,
    cashHandoverRows,
    summary
  };
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
  const { summary } = normalizeFullPayload(raw);

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

  const raw = {
    members: body.members, accounts: body.accounts, transactions: body.transactions,
    users: body.users, locations: body.locations, settings: body.settings,
    bankSessions: body.bankSessions, cashHandovers: body.cashHandovers,
    userPermissions: body.userPermissions, loanProducts: body.loanProducts
  };
  if (!Array.isArray(raw.members) || !Array.isArray(raw.accounts) || !Array.isArray(raw.transactions)) {
    return jsonError('รูปแบบข้อมูลไม่ถูกต้อง');
  }

  const canonical = canonicalPayloadString(raw);
  const payloadHash = await sha256Hex(canonical);
  if (payloadHash !== preview.payload_hash) {
    return jsonError('ข้อมูลที่ส่งมาไม่ตรงกับตอนตรวจสอบตัวอย่าง (ไฟล์อาจถูกเปลี่ยน) กรุณาคำนวณตัวอย่างใหม่');
  }

  const {
    membersToImport, accountRows, preparedTxByAccount,
    userRows, userPermRowsByUserId, locationRows, settingRows,
    loanProductRows, bankSessionRows, cashHandoverRows, summary
  } = normalizeFullPayload(raw);
  const now = Date.now();
  const counts = {};

  // 1) locations (no FK dependencies)
  counts.locations = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO locations (id, name, type, active, sort_order) VALUES (?, ?, ?, ?, ?)',
    locationRows.map((l) => [l.id, l.name, l.type, l.active, l.sortOrder])
  );
  const locationIdSet = new Set(locationRows.map((l) => l.id));

  // 2) settings (skip keys the admin already configured on this deployment)
  counts.settings = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO settings (key, value, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
    settingRows.map((s) => [s.key, s.value, s.description, s.updatedBy, s.updatedAtMs || now])
  );

  // 3) users -- username is UNIQUE, so a collision with a pre-existing
  // different-id account is silently ignored here and resolved by username
  // just below (every later sheet references the CURRENT owner of that
  // username, never a dangling legacy id).
  const passwordHashes = await Promise.all(userRows.map((u) => createPasswordRecord(u.password)));
  counts.users = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, active, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    userRows.map((u, i) => [u.id, u.username, passwordHashes[i], u.displayName, u.role, u.active ? 1 : 0, u.createdAtMs || now, u.lastLoginAtMs])
  );

  const usernameToActualId = await selectExistingMap(
    env,
    'SELECT username, id FROM users WHERE username IN (__IN__)',
    userRows.map((u) => u.username)
  );
  const legacyUserIdToActualId = new Map();
  for (const u of userRows) {
    const actualId = usernameToActualId.get(u.username);
    if (actualId) legacyUserIdToActualId.set(u.id, actualId);
  }
  const resolveUserId = (legacyUserId, usernameFallback) => {
    if (legacyUserId && legacyUserIdToActualId.has(legacyUserId)) return legacyUserIdToActualId.get(legacyUserId);
    if (usernameFallback && usernameToActualId.has(usernameFallback)) return usernameToActualId.get(usernameFallback);
    return user.id; // fall back to the importing admin so NOT NULL user_id columns never dangle
  };

  // 4) user_permissions -- skip ADMIN-role users (they get full access
  // automatically; see src/permissions.js) and only carry over the columns
  // that map to a permission this system actually has.
  const permValueArrays = [];
  for (const u of userRows) {
    if (u.role === 'ADMIN') continue;
    const actualId = legacyUserIdToActualId.get(u.id);
    if (!actualId) continue;
    const granted = userPermRowsByUserId.get(u.id);
    if (!granted) continue;
    for (const permission of granted) {
      permValueArrays.push([actualId, permission, 1]);
    }
  }
  counts.userPermissions = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO user_permissions (user_id, permission, granted) VALUES (?, ?, ?)',
    permValueArrays
  );

  // 5) members
  counts.members = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO members (id, school_student_id, prefix, first_name, last_name, grade, room, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    membersToImport.map((m) => [m.id, m.schoolStudentId, m.prefix, m.firstName, m.lastName, m.grade, m.room, m.status, m.createdAtMs || now])
  );

  // 6) loan products
  counts.loanProducts = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO loan_products (id, name, interest_method, annual_interest_rate_bps, late_fee_satang, max_principal_satang, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    loanProductRows.map((lp) => [lp.id, lp.name, lp.interestMethod, lp.annualInterestRateBps, lp.lateFeeSatang, lp.maxPrincipalSatang, lp.active, lp.createdAtMs || now])
  );

  // 7) accounts -- account_no is UNIQUE, resolved by account_no afterward
  // for the same reason usernames are resolved above.
  counts.accounts = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO accounts (id, account_no, member_id, account_type, status, balance, opened_at, closed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    accountRows.map((a) => [a.id, a.accountNo, a.ownerId, a.accountType, a.status, a.balanceSatang, a.openedAtMs || now, a.status === 'CLOSED' ? (a.closedAtMs || now) : null, now])
  );
  const accountNoToActualId = await selectExistingMap(
    env,
    'SELECT account_no, id FROM accounts WHERE account_no IN (__IN__)',
    accountRows.map((a) => a.accountNo)
  );

  // 8) bank sessions
  counts.bankSessions = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO bank_sessions (id, status, opened_at, opened_by, closed_at, closed_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    bankSessionRows.map((bs) => [
      bs.id, bs.status, bs.openedAtMs || now,
      resolveUserId(bs.legacyOpenedByUserId, null),
      bs.closedAtMs,
      bs.legacyClosedByUserId ? resolveUserId(bs.legacyClosedByUserId, null) : null,
      bs.note
    ])
  );
  const bankSessionIdSet = new Set(bankSessionRows.map((bs) => bs.id));

  // 9) transactions
  let transactionCount = 0;
  const txValueArrays = [];
  for (const a of accountRows) {
    const actualAccountId = accountNoToActualId.get(a.accountNo);
    if (!actualAccountId) continue; // account_no collided with a pre-existing different row we can't safely attribute to
    const rows = preparedTxByAccount.get(a.id) || [];
    for (const row of rows) {
      const createdAt = row.timestampMs || now;
      const bankSessionId = row.legacyBankSessionId && bankSessionIdSet.has(row.legacyBankSessionId) ? row.legacyBankSessionId : null;
      const locationId = row.legacyLocationId && locationIdSet.has(row.legacyLocationId) ? row.legacyLocationId : null;
      const userId = resolveUserId(row.legacyUserId, row.username);
      txValueArrays.push([
        row.id, bankSessionId, actualAccountId, row.type, row.amountSatang,
        row.balanceBeforeSatang, row.balanceAfterSatang, locationId, userId,
        `[นำเข้าจากระบบเดิม] ${row.note}`.slice(0, 300), createdAt
      ]);
    }
  }
  counts.transactions = await chunkedBatchInsert(
    env,
    `INSERT OR IGNORE INTO transactions (id, bank_session_id, account_id, type, amount, balance_before, balance_after, location_id, user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    txValueArrays
  );
  transactionCount = txValueArrays.length;

  // 10) cash handovers
  counts.cashHandovers = await chunkedBatchInsert(
    env,
    'INSERT OR IGNORE INTO cash_handovers (id, from_user_id, to_user_id, amount_satang, note, status, created_at, confirmed_at, bank_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    cashHandoverRows.map((h) => [
      h.id,
      resolveUserId(h.legacyFromUserId, null),
      resolveUserId(h.legacyToUserId, null),
      h.amountSatang, h.note, h.status, h.createdAtMs || now, h.confirmedAtMs,
      h.legacyBankSessionId && bankSessionIdSet.has(h.legacyBankSessionId) ? h.legacyBankSessionId : null
    ])
  );

  const resultSummary = { ...summary, transactionCount, importedCounts: counts };

  await env.DB.prepare('DELETE FROM legacy_import_tokens WHERE token = ?').bind(body.token).run();
  await env.DB.prepare(
    `INSERT INTO legacy_import_log (id, admin_id, imported_at, member_count, account_count, transaction_count, skipped_account_count, adjustment_count, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(newId('LIL'), user.id, now, counts.members, counts.accounts, transactionCount, summary.skippedAccounts.length, summary.adjustmentCount, JSON.stringify(resultSummary)).run();

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
