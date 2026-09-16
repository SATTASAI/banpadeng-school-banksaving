import { handleSetup, handleLogin, handleLogout, handleBootstrap, handleChangePassword } from './routes/auth.js';
import { handleListUsers, handleCreateUser, handleUpdateUser } from './routes/admin.js';
import { handleSearchAccounts, handleOpenAccount } from './routes/accounts.js';
import { handleDeposit, handleWithdraw, handleListTransactions } from './routes/transactions.js';
import {
  handleOpenBankSession,
  handleCloseBankSession,
  handleActiveBankSession,
  handleListLocations
} from './routes/banksession.js';
import { jsonError } from './auth.js';

const ROUTES = [
  ['POST', '/api/setup', handleSetup],
  ['POST', '/api/login', handleLogin],
  ['POST', '/api/logout', handleLogout],
  ['GET', '/api/bootstrap', handleBootstrap],
  ['POST', '/api/change-password', handleChangePassword],

  ['GET', '/api/admin/users', handleListUsers],
  ['POST', '/api/admin/users', handleCreateUser],
  // /api/admin/users/:id handled separately below (dynamic segment)

  ['GET', '/api/accounts/search', handleSearchAccounts],
  ['POST', '/api/accounts', handleOpenAccount],

  ['POST', '/api/deposit', handleDeposit],
  ['POST', '/api/withdraw', handleWithdraw],
  ['GET', '/api/transactions', handleListTransactions],

  ['POST', '/api/bank-session/open', handleOpenBankSession],
  ['POST', '/api/bank-session/close', handleCloseBankSession],
  ['GET', '/api/bank-session/active', handleActiveBankSession],
  ['GET', '/api/locations', handleListLocations]
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await routeApi(request, env, url);
      } catch (err) {
        console.error('Unhandled API error:', err);
        return jsonError('เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง', 500);
      }
    }

    // Everything else falls through to the static assets binding
    // (public/ -- see wrangler.jsonc "assets" config).
    return env.ASSETS.fetch(request);
  }
};

async function routeApi(request, env, url) {
  // /api/admin/users/:id
  const userIdMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userIdMatch && request.method === 'PUT') {
    return handleUpdateUser(request, env, userIdMatch[1]);
  }

  for (const [method, path, handler] of ROUTES) {
    if (request.method === method && url.pathname === path) {
      return handler(request, env);
    }
  }

  return jsonError('ไม่พบ endpoint นี้', 404);
}
