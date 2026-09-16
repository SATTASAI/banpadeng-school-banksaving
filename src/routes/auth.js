import {
  createPasswordRecord,
  verifyPassword,
  newId,
  newSessionToken,
  requireSession,
  getUserPermissions,
  jsonOk,
  jsonError,
  maybeCleanupExpiredSessions,
  SESSION_TTL
} from '../auth.js';
import { DEFAULT_PERMISSIONS_BY_ROLE, PERMISSIONS } from '../permissions.js';

const FAIL_LOCK_THRESHOLD = 8;
const FAIL_LOCK_MS = 15 * 60 * 1000; // 15 minutes, matches the hardened GAS version

/**
 * One-time bootstrap: creates the first ADMIN account. Only works while the
 * users table is empty -- refuses to run again after that, so it is safe to
 * leave this route deployed rather than deleting it after first use.
 */
export async function handleSetup(request, env) {
  const { count } = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
  if (count > 0) {
    return jsonError('ระบบมีผู้ใช้งานอยู่แล้ว ไม่สามารถ setup ซ้ำได้', 409);
  }

  const body = await request.json().catch(() => ({}));
  const username = String(body.username || 'admin').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || 'ผู้ดูแลระบบ School Bank').trim();

  if (!username || password.length < 4) {
    return jsonError('กรุณาระบุ username และ password (อย่างน้อย 4 ตัวอักษร)', 400);
  }

  const userId = newId('USR');
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, username, password_hash, display_name, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).bind(userId, username, await createPasswordRecord(password), displayName, 'ADMIN', now)
  ]);

  return jsonOk({ message: 'สร้างบัญชี Administrator แรกสำเร็จ', userId, username });
}

export async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!username || !password) {
    return jsonError('กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน');
  }

  const lockRow = await env.DB
    .prepare('SELECT fail_count, locked_until FROM login_failures WHERE username = ?')
    .bind(username.toLowerCase())
    .first();

  const now = Date.now();
  if (lockRow && lockRow.locked_until && lockRow.locked_until > now) {
    return jsonError('มีการลองรหัสผ่านผิดหลายครั้ง กรุณาลองใหม่อีกครั้งใน 15 นาที');
  }

  const user = await env.DB
    .prepare('SELECT id, username, password_hash, display_name, role, active FROM users WHERE lower(username) = ?')
    .bind(username.toLowerCase())
    .first();

  const ok = user ? await verifyPassword(password, user.password_hash) : false;

  if (!ok) {
    const failCount = (lockRow ? lockRow.fail_count : 0) + 1;
    const lockedUntil = failCount >= FAIL_LOCK_THRESHOLD ? now + FAIL_LOCK_MS : null;
    await env.DB
      .prepare(
        `INSERT INTO login_failures (username, fail_count, locked_until) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until`
      )
      .bind(username.toLowerCase(), failCount, lockedUntil)
      .run();

    return jsonError('ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง');
  }

  if (!user.active) {
    return jsonError('บัญชีผู้ใช้งานถูกระงับ');
  }

  await env.DB.prepare('DELETE FROM login_failures WHERE username = ?').bind(username.toLowerCase()).run();

  const token = newSessionToken();
  const expiresAt = now + SESSION_TTL;

  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(token, user.id, expiresAt, now),
    env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, user.id)
  ]);

  await maybeCleanupExpiredSessions(env);

  return jsonOk({
    token,
    expiresAt,
    user: {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    }
  });
}

export async function handleLogout(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  return jsonOk({});
}

export async function handleBootstrap(request, env) {
  const user = await requireSession(request, env);
  if (!user) return jsonError('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);

  const permissions = user.role === 'ADMIN'
    ? DEFAULT_PERMISSIONS_BY_ROLE.ADMIN
    : await getUserPermissions(env, user.id);

  const activeSession = await env.DB
    .prepare("SELECT id, opened_at, opened_by FROM bank_sessions WHERE status = 'OPEN' LIMIT 1")
    .first();

  return jsonOk({
    user: {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    },
    permissions,
    allPermissions: PERMISSIONS,
    bankSession: activeSession || null
  });
}

export async function handleChangePassword(request, env) {
  const user = await requireSession(request, env);
  if (!user) return jsonError('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);

  const body = await request.json().catch(() => ({}));
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');

  if (!currentPassword) return jsonError('กรุณากรอกรหัสผ่านปัจจุบัน');
  if (!newPassword || newPassword.length < 4 || newPassword.length > 100) {
    return jsonError('รหัสผ่านใหม่ต้องมีความยาว 4–100 ตัวอักษร');
  }
  if (newPassword === currentPassword) {
    return jsonError('รหัสผ่านใหม่ต้องไม่เหมือนรหัสผ่านเดิม');
  }

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    return jsonError('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  }

  const newHash = await createPasswordRecord(newPassword);

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, user.id),
    // Revoke every other session for this user but keep the current one alive.
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(user.id, user.token)
  ]);

  return jsonOk({ message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
}
