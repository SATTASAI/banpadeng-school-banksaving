// Money is stored as INTEGER satang (1 บาท = 100 สตางค์) in D1 to avoid
// the floating-point rounding issues the old Apps Script roundMoney_()
// helper had to work around. Convert at the API boundary only.

export function bahtToSatang(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

export function satangToBaht(value) {
  return Math.round(Number(value || 0)) / 100;
}

export function formatBaht(satang) {
  return satangToBaht(satang).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}
