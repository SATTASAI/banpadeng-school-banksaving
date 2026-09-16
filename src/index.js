import { handleSetup, handleLogin, handleLogout, handleBootstrap, handleChangePassword } from './routes/auth.js';
import { handleListUsers, handleCreateUser, handleUpdateUser, handleListActiveUsers } from './routes/admin.js';
import { handleSearchAccounts, handleOpenAccount, handleCloseAccount } from './routes/accounts.js';
import { handleDeposit, handleWithdraw, handleListTransactions, handleVoidTransaction } from './routes/transactions.js';
import {
  handleOpenBankSession,
  handleCloseBankSession,
  handleActiveBankSession,
  handleListLocations
} from './routes/banksession.js';
import {
  handleListLoanProducts,
  handleCreateLoanProduct,
  handleApplyLoan,
  handleListLoans,
  handleLoanDetail,
  handleApproveLoan,
  handleRejectLoan,
  handleDisburseLoan,
  handleReceiveLoanPayment
} from './routes/loans.js';
import { handleCreateHandover, handleListHandovers, handleConfirmHandover } from './routes/handover.js';
import { jsonError } from './auth.js';

const ROUTES = [
  ['POST', '/api/setup', handleSetup],
  ['POST', '/api/login', handleLogin],
  ['POST', '/api/logout', handleLogout],
  ['GET', '/api/bootstrap', handleBootstrap],
  ['POST', '/api/change-password', handleChangePassword],

  ['GET', '/api/admin/users', handleListUsers],
  ['POST', '/api/admin/users', handleCreateUser],
  ['GET', '/api/users/active', handleListActiveUsers],
  // /api/admin/users/:id handled separately below (dynamic segment)

  ['GET', '/api/accounts/search', handleSearchAccounts],
  ['POST', '/api/accounts', handleOpenAccount],
  // /api/accounts/:id/close handled separately below

  ['POST', '/api/deposit', handleDeposit],
  ['POST', '/api/withdraw', handleWithdraw],
  ['GET', '/api/transactions', handleListTransactions],
  // /api/transactions/:id/void handled separately below

  ['POST', '/api/bank-session/open', handleOpenBankSession],
  ['POST', '/api/bank-session/close', handleCloseBankSession],
  ['GET', '/api/bank-session/active', handleActiveBankSession],
  ['GET', '/api/locations', handleListLocations],

  ['GET', '/api/loan-products', handleListLoanProducts],
  ['POST', '/api/loan-products', handleCreateLoanProduct],
  ['POST', '/api/loans', handleApplyLoan],
  ['GET', '/api/loans', handleListLoans],
  // /api/loans/:id ... handled separately below

  ['POST', '/api/cash-handover', handleCreateHandover],
  ['GET', '/api/cash-handover', handleListHandovers]
  // /api/cash-handover/:id/confirm handled separately below
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
  const path = url.pathname;

  // /api/admin/users/:id
  const userIdMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userIdMatch && request.method === 'PUT') {
    return handleUpdateUser(request, env, userIdMatch[1]);
  }

  // /api/accounts/:id/close
  const closeAccountMatch = path.match(/^\/api\/accounts\/([^/]+)\/close$/);
  if (closeAccountMatch && request.method === 'POST') {
    return handleCloseAccount(request, env, closeAccountMatch[1]);
  }

  // /api/transactions/:id/void
  const voidTxMatch = path.match(/^\/api\/transactions\/([^/]+)\/void$/);
  if (voidTxMatch && request.method === 'POST') {
    return handleVoidTransaction(request, env, voidTxMatch[1]);
  }

  // /api/loans/:id (+ /approve, /reject, /disburse, /payment)
  const loanActionMatch = path.match(/^\/api\/loans\/([^/]+)\/(approve|reject|disburse|payment)$/);
  if (loanActionMatch && request.method === 'POST') {
    const [, loanId, action] = loanActionMatch;
    if (action === 'approve') return handleApproveLoan(request, env, loanId);
    if (action === 'reject') return handleRejectLoan(request, env, loanId);
    if (action === 'disburse') return handleDisburseLoan(request, env, loanId);
    if (action === 'payment') return handleReceiveLoanPayment(request, env, loanId);
  }
  const loanDetailMatch = path.match(/^\/api\/loans\/([^/]+)$/);
  if (loanDetailMatch && request.method === 'GET') {
    return handleLoanDetail(request, env, loanDetailMatch[1]);
  }

  // /api/cash-handover/:id/confirm
  const confirmHandoverMatch = path.match(/^\/api\/cash-handover\/([^/]+)\/confirm$/);
  if (confirmHandoverMatch && request.method === 'POST') {
    return handleConfirmHandover(request, env, confirmHandoverMatch[1]);
  }

  for (const [method, routePath, handler] of ROUTES) {
    if (request.method === method && path === routePath) {
      return handler(request, env);
    }
  }

  return jsonError('ไม่พบ endpoint นี้', 404);
}
