// Loan amortization math. Ported from the interest logic in the old Apps
// Script system (FLAT vs DECLINING-balance methods), operating on integer
// satang throughout and fixing up rounding on the final installment so the
// schedule always sums exactly back to principal + total interest.

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000; // simple 30-day month, matches old system's schedule spacing

/**
 * FLAT interest: total interest = principal * annualRate * (termMonths/12),
 * spread evenly. Principal is also spread evenly across installments.
 */
function buildFlatSchedule(principalSatang, termMonths, annualRateBps) {
  const totalInterest = Math.round(principalSatang * (annualRateBps / 10000) * (termMonths / 12));
  const baseInterest = Math.floor(totalInterest / termMonths);
  const basePrincipal = Math.floor(principalSatang / termMonths);

  const rows = [];
  let principalRemaining = principalSatang;
  let interestRemaining = totalInterest;

  for (let i = 1; i <= termMonths; i++) {
    const isLast = i === termMonths;
    const principalDue = isLast ? principalRemaining : basePrincipal;
    const interestDue = isLast ? interestRemaining : baseInterest;
    principalRemaining -= principalDue;
    interestRemaining -= interestDue;
    rows.push({ installmentNo: i, principalDue, interestDue });
  }
  return rows;
}

/**
 * DECLINING balance: standard amortized-payment formula on the outstanding
 * principal each month, so interest shrinks and the principal share grows
 * as the loan is paid down.
 */
function buildDecliningSchedule(principalSatang, termMonths, annualRateBps) {
  const monthlyRate = (annualRateBps / 10000) / 12;
  const rows = [];
  let balance = principalSatang;

  if (monthlyRate === 0) {
    return buildFlatSchedule(principalSatang, termMonths, 0);
  }

  const payment = principalSatang * monthlyRate / (1 - Math.pow(1 + monthlyRate, -termMonths));

  for (let i = 1; i <= termMonths; i++) {
    const isLast = i === termMonths;
    const interestDue = Math.round(balance * monthlyRate);
    let principalDue = isLast ? balance : Math.round(payment - interestDue);
    if (principalDue > balance) principalDue = balance;
    if (principalDue < 0) principalDue = 0;
    balance -= principalDue;
    rows.push({ installmentNo: i, principalDue, interestDue });
  }
  return rows;
}

/** Returns [{ installmentNo, dueDate, principalDue, interestDue }] in satang. */
export function buildLoanSchedule(principalSatang, termMonths, annualRateBps, interestMethod, startAt) {
  const rows = interestMethod === 'DECLINING'
    ? buildDecliningSchedule(principalSatang, termMonths, annualRateBps)
    : buildFlatSchedule(principalSatang, termMonths, annualRateBps);

  return rows.map((r) => ({
    ...r,
    dueDate: startAt + r.installmentNo * MS_PER_MONTH
  }));
}
