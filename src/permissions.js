// Phase 1 (core banking) permission set. Loan / academic-year / export
// permissions from the old Apps Script system will be added back here as
// those modules get ported -- keep this list, USER_PERMISSIONS.PERMISSIONS
// in the DB, and any admin-UI permission checkboxes in sync.

export const PERMISSIONS = [
  'CAN_DEPOSIT',
  'CAN_WITHDRAW',
  'CAN_WITHDRAW_OVER_LIMIT',
  'CAN_OPEN_ACCOUNT',
  'CAN_CLOSE_ACCOUNT',
  'CAN_VIEW_ALL_STUDENTS',
  'CAN_VIEW_TRANSACTIONS',
  'CAN_VIEW_REPORTS',
  'CAN_OPEN_BANK_SESSION',
  'CAN_CLOSE_BANK_SESSION',
  'CAN_MANAGE_USERS',
  'CAN_MANAGE_PERMISSIONS',
  'CAN_MANAGE_SETTINGS',
  // Phase 2
  'CAN_MANAGE_LOANS',
  'CAN_APPROVE_LOAN',
  'CAN_DISBURSE_LOAN',
  'CAN_RECEIVE_LOAN_PAYMENT',
  'CAN_CORRECT_TRANSACTION',
  'CAN_HANDOVER_CASH',
  // Phase 3
  'CAN_MANAGE_ACADEMIC_YEAR',
  // Phase 4 (backup/restore is ADMIN-role-only by design -- see README --
  // so it has no separate permission entry here)
  'CAN_EXPORT_REPORTS',
  // Phase 5
  'CAN_RUN_INTEREST'
];

export const DEFAULT_PERMISSIONS_BY_ROLE = {
  ADMIN: PERMISSIONS.reduce((acc, p) => ({ ...acc, [p]: true }), {}),
  TELLER: {
    CAN_DEPOSIT: true,
    CAN_WITHDRAW: true,
    CAN_VIEW_TRANSACTIONS: true
  }
};
