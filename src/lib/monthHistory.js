// Month-by-month figures from the transaction log — the source the Dashboard's
// history-driven cards (trend chart, forecast, income basis, every-dollar,
// emergency fund, past months) should run on.
//
// WHY: those cards used to read the "Monthly Summary" sheet, whose income/spent
// cells are only filled when the app processes income through that sheet's
// formulas and per-month report sheets. Those report sheets stopped at May, so
// from June on the tab reads $0 and every history card silently ran on a
// five-month-old picture while the Allocation Transactions log kept growing.
// The log is the ground truth the headline Income/Spent tiles already use; this
// extends the same rule to the whole year.
//
// Pure functions, no React, no dates from the clock: testable with fixed data.

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse a log date cell (serial number or M/D/YYYY) into {y, m} (m 1-based), or null. */
export function monthOf(raw) {
  const ds = String(raw ?? '').trim();
  if (!ds) return null;
  const n = Number(ds);
  if (!isNaN(n) && n > 1000 && !ds.includes('/')) {
    const u = new Date(Math.round((n - 25569) * 86400000));
    return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1 };
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(ds);
  if (m) return { y: Number(m[3]), m: Number(m[1]) };
  // YYYY-MM-DD (the Dashboard's dateStr). Read the parts: `new Date('2026-09-01')`
  // is UTC midnight, which is Aug 31 in US time zones, so every 1st-of-month row
  // used to land in the previous month (Sept read 917.55 instead of 1,795.51).
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(ds);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]) };
  const d = new Date(ds);
  return isNaN(d.getTime()) ? null : { y: d.getFullYear(), m: d.getMonth() + 1 };
}

/**
 * Sum the log by month.
 * @param txs  [{dateStr|date, amount, type}] as the Dashboard parses Allocation Transactions
 * @returns Map "YYYY-MM" -> { y, m, income, spent, rows }
 */
export function monthTotals(txs) {
  const out = new Map();
  for (const t of txs || []) {
    const ym = monthOf(t.dateStr ?? t.date);
    if (!ym) continue;
    const key = `${ym.y}-${String(ym.m).padStart(2, '0')}`;
    const cur = out.get(key) || { y: ym.y, m: ym.m, income: 0, spent: 0, rows: 0 };
    const amt = Number(t.amount) || 0;
    if (amt > 0) cur.income += amt;
    else cur.spent += Math.abs(amt);
    cur.rows += 1;
    out.set(key, cur);
  }
  return out;
}

const pm = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const neg = s.startsWith('-') || s.startsWith('(');
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : neg ? -n : n;
};

/**
 * Monthly Summary rows with income/spent/net reconciled against the log: per
 * field, the more complete of the two records. Sheet-only fields (Allowance
 * Goal, Unprocessed Income, Report Link, ...) are kept as they are.
 * @param sheetMonths  rows as the Dashboard keeps them: {Month, Year, 'Total Processed Income', ...}
 * @param txs          the parsed log
 * @param year         the year the sheet rows describe (default: this year of the rows, else current)
 */
export function mergeMonths(sheetMonths, txs, year) {
  const totals = monthTotals(txs);
  const yr = year ?? Number(sheetMonths?.[0]?.Year) ?? new Date().getFullYear();
  const byName = new Map((sheetMonths || []).map((r) => [String(r.Month), r]));
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const name = MONTHS[m - 1];
    const row = { Month: name, Year: String(yr), ...(byName.get(name) || {}) };
    const key = `${yr}-${String(m).padStart(2, '0')}`;
    const t = totals.get(key);
    // Per field, the more complete record wins. The log started on 2026-02-27, so
    // for the first months the sheet knows income the log never saw; from June the
    // sheet stopped and only the log knows. Both count the same processed income
    // and neither can exceed the truth, so the larger figure is the complete one.
    const sheetIncome = pm(row['Total Processed Income']);
    const sheetSpent = pm(row['Total Spent']);
    const logIncome = t ? t.income : 0;
    const logSpent = t ? t.spent : 0;
    const income = Math.max(sheetIncome, logIncome);
    const spent = Math.max(sheetSpent, logSpent);
    row['Total Processed Income'] = income;
    row['Total Spent'] = spent;
    row['Net Flow'] = income - spent;
    row.fromLog = Boolean(t && t.rows > 0 && logIncome >= sheetIncome);
    row.logRows = t ? t.rows : 0;
    out.push(row);
  }
  return out;
}

/** Months with any figures, oldest first — what the trend/forecast cards chart. */
export function chartMonths(mergedMonths) {
  return (mergedMonths || [])
    .filter((m) => pm(m['Total Processed Income']) > 0 || pm(m['Total Spent']) > 0)
    .map((m) => {
      const income = pm(m['Total Processed Income']);
      const spent = pm(m['Total Spent']);
      return { month: String(m.Month).slice(0, 3), income, spent, net: income - spent, fromLog: Boolean(m.fromLog) };
    });
}
