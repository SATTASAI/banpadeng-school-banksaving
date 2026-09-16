import { createPasswordRecord, requireAdmin, newId, jsonOk, jsonError, writeAuditLog } from '../auth.js';
import { PERMISSIONS, DEFAULT_PERMISSIONS_BY_ROLE } from '../permissions.js';

export async function handleListUsers(request, env) {
  const { user, error } = await requireAdmin(request, env);
  if (error) return error;

  const { results: users } = await env.DB
    .prepare('SELECT id, username, display_name, role, active, last_login_at FROM users ORDER BY created_at')
    .all();

  const { results: permRows } = await env.DB.prepare('SELECT user_id, permission, granted FROM user_permissions').all();
  const permsByUser = {};
  for (const row of permRows) {
    permsByUser[row.user_id] = permsByUser[row.user_id] || {};
    permsByUser[row.user_id][row.permission] = !!row.granted;
  }

  // Password is intentionally never included here, hashed or not -- there
  // is no legitimate reason for the browser to see it. Resetting a user's
  // password happens via handleUpdateUser() by setting a brand-new one.
  return jsonOk({
    users: users.map((u) => ({
      userId: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      active: !!u.active,
      lastLogin: u.last_login_at ? new Date(u.last_login_at).toISOString() : '',
      permissions: permsByUser[u.id] || {}
    }))
  });
}

export async function handleCreateUser(request, env) {
  const { user: admin, error } = await requireAdmin(request, env);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim();
  const role = String(body.role || 'TELLER').trim().toUpperCase();
  const active = body.active !== false;
  const requestedPermissions = body.permissions || {};

  if (!username || username.length < 3 || username.length > 50 || /\s/.test(username)) {
    return jsonError('ชื่อผู้ใช้งานต้องมีความยาว 3–50 ตัวอักษรและห้ามมีช่องว่าง');
  }
  if (!password || password.length < 4 || password.length > 100) {
    return jsonError('รหัสผ่านต้องมีความยาว 4–100 ตัวอักษร');
  }
  if (!displayName) return jsonError('กรุณากรอกชื่อที่ใช้แสดงในระบบ');
  if (!['ADMIN', 'TELLER'].includes(role)) return jsonError('Role ไม่ถูกต้อง');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE lower(username) = ?').bind(username.toLowerCase()).first();
  if (existing) return jsonError('ชื่อผู้ใช้งานนี้มีอยู่ในระบบแล้ว');

  const userId = newId('USR');
  const now = Date.now();
  const defaults = DEFAULT_PERMISSIONS_BY_ROLE[role] || {};

  const statements = [
    env.DB.prepare(
      'INSERT INTO users (id, username, password_hash, display_name, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, username, await createPasswordRecord(password), displayName, role, active ? 1 : 0, now)
  ];

  for (const permission of PERMISSIONS) {
    const granted = role === 'ADMIN'
      ? true
      : Object.prototype.hasOwnProperty.call(requestedPermissions, permission)
        ? requestedPermissions[permission] === true
        : defaults[permission] === true;

    statements.push(
      env.DB.prepare('INSERT INTO user_permissions (user_id, permission, granted) VALUES (?, ?, ?)')
        .bind(userId, permission, granted ? 1 : 0)
    );
  }

  await env.DB.batch(statements);
  await writeAuditLog(env, admin.id, 'CREATE_USER', 'USER', userId, { username, role, active });

  return jsonOk({ userId });
}

export async function handleUpdateUser(request, env, userId) {
  const { user: admin, error } = await requireAdmin(request, env);
  if (error) return error;

  if (admin.id === userId) {
    return jsonError('เพื่อป้องกันการล็อกตัวเองออกจากระบบ ไม่สามารถแก้ไขบัญชี Administrator ที่กำลังใช้งานอยู่จากหน้านี้', 400);
  }

  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!target) return jsonError('ไม่พบผู้ใช้งาน', 404);

  const body = await request.json().catch(() => ({}));
  const displayName = String(body.displayName || '').trim();
  const role = String(body.role || target.role).trim().toUpperCase();
  const active = body.active !== false;
  const newPassword = String(body.password || '');
  const requestedPermissions = body.permissions || {};

  if (!displayName) return jsonError('กรุณากรอกชื่อที่ใช้แสดงในระบบ');
  if (!['ADMIN', 'TELLER'].includes(role)) return jsonError('Role ไม่ถูกต้อง');
  if (newPassword && (newPassword.length < 4 || newPassword.length > 100)) {
    return jsonError('รหัสผ่านใหม่ต้องมีความยาว 4–100 ตัวอักษร');
  }

  if (target.role === 'ADMIN' && (!active || role !== 'ADMIN')) {
    const { count } = await env.DB
      .prepare("SELECT COUNT(*) as count FROM users WHERE id != ? AND role = 'ADMIN' AND active = 1")
      .bind(userId)
      .first();
    if (count < 1) return jsonError('ไม่สามารถระงับหรือลด Role ของ Administrator คนสุดท้ายได้');
  }

  const statements = [
    env.DB.prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?')
      .bind(displayName, role, active ? 1 : 0, userId)
  ];

  if (newPassword) {
    statements.push(
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .bind(await createPasswordRecord(newPassword), userId)
    );
  }

  const defaults = DEFAULT_PERMISSIONS_BY_ROLE[role] || {};
  for (const permission of PERMISSIONS) {
    const granted = role === 'ADMIN'
      ? true
      : Object.prototype.hasOwnProperty.call(requestedPermissions, permission)
        ? requestedPermissions[permission] === true
        : defaults[permission] === true;

    statements.push(
      env.DB.prepare(
        `INSERT INTO user_permissions (user_id, permission, granted) VALUES (?, ?, ?)
         ON CONFLICT(user_id, permission) DO UPDATE SET granted = excluded.granted`
      ).bind(userId, permission, granted ? 1 : 0)
    );
  }

  // Password/role/status changed -- revoke all of this user's sessions so
  // the change takes effect immediately everywhere they're logged in.
  statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId));

  await env.DB.batch(statements);
  await writeAuditLog(env, admin.id, 'UPDATE_USER', 'USER', userId, {
    displayName, role, active, passwordChanged: !!newPassword
  });

  return jsonOk({ userId });
}
