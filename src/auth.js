// Password hashing, session management, and permission checks.
// Replaces Apps Script's Utilities.computeDigest / PropertiesService /
// LockService with Web Crypto + D1.

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, same as the old system
const PBKDF2_ITERATIONS = 100000;

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

async function pbkdf2Hash(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  return bytesToHex(new Uint8Array(bits));
}

/** Create a new "<salt_hex>:<hash_hex>" record for storage. */
export async function createPasswordRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hash(password, salt);
  return `${bytesToHex(salt)}:${hash}`;
}

/** Verify a plaintext password against a stored "<salt_hex>:<hash_hex>" record. */
export async function verifyPassword(password, storedRecord) {
  if (!storedRecord || typeof storedRecord !== 'string' || storedRecord.indexOf(':') === -1) {
    return false;
  }
  const [saltHex, expectedHash] = storedRecord.split(':');
  if (!saltHex || !expectedHash) return false;

  const hash = await pbkdf2Hash(password, hexToBytes(saltHex));
  return timingSafeEqual(hash, expectedHash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newId(prefix) {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

export function newSessionToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

/** Look up + validate a bearer token. Returns the user row, or null. */
export async function requireSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;

  const session = await env.DB
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
    .bind(token)
    .first();

  if (!session) return null;
  if (session.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }

  const user = await env.DB
    .prepare('SELECT id, username, display_name, role, active FROM users WHERE id = ?')
    .bind(session.user_id)
    .first();

  if (!user || !user.active) return null;
  return { ...user, token };
}

export async function getUserPermissions(env, userId) {
  const { results } = await env.DB
    .prepare('SELECT permission, granted FROM user_permissions WHERE user_id = ?')
    .bind(userId)
    .all();

  const map = {};
  for (const row of results) map[row.permission] = !!row.granted;
  return map;
}

export async function hasPermission(env, user, permission) {
  if (user.role === 'ADMIN') return true;
  const permissions = await getUserPermissions(env, user.id);
  return permissions[permission] === true;
}

export async function requirePermission(request, env, permission) {
  const user = await requireSession(request, env);
  if (!user) {
    return { error: jsonError('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 401) };
  }
  if (!(await hasPermission(env, user, permission))) {
    return { error: jsonError('คุณไม่มีสิทธิ์ทำรายการนี้', 403) };
  }
  return { user };
}

export async function requireAdmin(request, env) {
  const user = await requireSession(request, env);
  if (!user) return { error: jsonError('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 401) };
  if (user.role !== 'ADMIN') return { error: jsonError('ไม่มีสิทธิ์ Administrator', 403) };
  return { user };
}

export function jsonOk(data, init) {
  return new Response(JSON.stringify({ success: true, ...data }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init
  });
}

export function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

/**
 * Opportunistic cleanup, called with low probability on hot paths (mirrors
 * the ~5% chance used in the Apps Script version). D1 has no TTL, so
 * expired rows are swept out here rather than accumulating forever.
 */
export async function maybeCleanupExpiredSessions(env) {
  if (Math.random() >= 0.05) return;
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  } catch (e) {
    console.error('Session cleanup failed:', e);
  }
}

export const SESSION_TTL = SESSION_TTL_MS;

export async function writeAuditLog(env, userId, action, entityType, entityId, detail) {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(newId('LOG'), userId, action, entityType, entityId, JSON.stringify(detail || {}), Date.now()).run();
  } catch (e) {
    console.error('writeAuditLog failed:', e);
  }
}
