// Safe write helpers for the finance spreadsheet.
//
// Every write LOCATES its target by matching column HEADER names and row keys at
// runtime, rather than trusting fixed positions — so a reordered or renamed sheet
// fails loudly (throws) instead of silently writing into the wrong column. Shared
// by the one-time Data Repair tool and by Ledger's write tools.
import { readRange, batchUpdateCells, clearRow, appendRow, appendRows, ensureSheetTab } from './sheets';
import { SHEETS } from '../config';

const SUBSCRIPTIONS_SHEET = 'Subscriptions';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// 0-based column index → A1 letter(s) (supports >26 columns).
export function colLetter(i) {
  let s = '', n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Normalise a date cell (serial / YYYY-MM-DD / M/D/YYYY) to YYYY-MM.
export function monthKey(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  const n = Number(v);
  if (!isNaN(n) && n > 1000 && !s.includes('-') && !s.includes('/')) {
    const d = new Date(Math.round((Math.floor(n) - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (s.includes('-')) return s.slice(0, 7);
  if (s.includes('/')) { const p = s.split('/'); return `${p[2]}-${String(p[0]).padStart(2, '0')}`; }
  return '';
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

// Find a column index whose header contains any of the needles. -1 if none.
function findCol(headers, ...needles) {
  const lower = headers.map(norm);
  for (const n of needles) {
    const i = lower.findIndex(h => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

async function load(token, range) {
  const rows = await readRange(token, range, 'UNFORMATTED_VALUE');
  if (!rows.length) throw new Error(`"${range}" is empty.`);
  return { headers: rows[0], rows };
}

// ── Monthly Summary ─────────────────────────────────────────────────────────
// Update income / spent / savings for a month (matched by name, e.g. "May").
export async function recalcMonthlySummary(token, { monthName, income, spent, savings }) {
  const { headers, rows } = await load(token, `${SHEETS.MONTHLY_SUMMARY}!A:Z`);
  const incomeCol  = findCol(headers, 'income');
  const spentCol   = findCol(headers, 'spent', 'spend');
  const savingsCol = findCol(headers, 'saving', 'saved', 'goal');

  let rowIdx = -1;
  for (let r = 1; r < rows.length; r++) {
    if (norm(rows[r][0]).includes(norm(monthName))) { rowIdx = r; break; }
  }
  if (rowIdx < 0) throw new Error(`No "${monthName}" row found in Monthly Summary.`);
  const sheetRow = rowIdx + 1;

  const updates = [];
  const sheet = SHEETS.MONTHLY_SUMMARY;
  if (income  != null && incomeCol  >= 0) updates.push({ range: `${sheet}!${colLetter(incomeCol)}${sheetRow}`,  value: income });
  if (spent   != null && spentCol   >= 0) updates.push({ range: `${sheet}!${colLetter(spentCol)}${sheetRow}`,   value: spent });
  if (savings != null && savingsCol >= 0) updates.push({ range: `${sheet}!${colLetter(savingsCol)}${sheetRow}`, value: savings });
  if (!updates.length) throw new Error('Could not locate Income/Spent/Savings columns in Monthly Summary.');
  await batchUpdateCells(token, updates);
  return updates.length;
}

// Sum of allocation amounts for a month (YYYY-MM) — used to suggest "spent".
export async function sumAllocations(token, month) {
  const { headers, rows } = await load(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A:F`);
  const dateCol = findCol(headers, 'date') >= 0 ? findCol(headers, 'date') : 0;
  const amtCol  = findCol(headers, 'amount') >= 0 ? findCol(headers, 'amount') : 2;
  let total = 0;
  for (let r = 1; r < rows.length; r++) {
    if (monthKey(rows[r][dateCol]) === month) total += parseFloat(rows[r][amtCol]) || 0;
  }
  return total;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
export async function updateSubscription(token, { name, amount, cycle }) {
  const { headers, rows } = await load(token, `${SUBSCRIPTIONS_SHEET}!A:E`);
  const nameCol  = findCol(headers, 'name') >= 0 ? findCol(headers, 'name') : 0;
  const costCol  = findCol(headers, 'cost', 'amount', 'price') >= 0 ? findCol(headers, 'cost', 'amount', 'price') : 1;
  const cycleCol = findCol(headers, 'cycle', 'frequency') >= 0 ? findCol(headers, 'cycle', 'frequency') : 2;

  let rowIdx = -1;
  for (let r = 1; r < rows.length; r++) {
    if (norm(rows[r][nameCol]).includes(norm(name))) { rowIdx = r; break; }
  }
  if (rowIdx < 0) throw new Error(`No subscription matching "${name}" found.`);
  const sheetRow = rowIdx + 1;

  const updates = [];
  if (amount != null) updates.push({ range: `${SUBSCRIPTIONS_SHEET}!${colLetter(costCol)}${sheetRow}`,  value: amount });
  if (cycle)          updates.push({ range: `${SUBSCRIPTIONS_SHEET}!${colLetter(cycleCol)}${sheetRow}`, value: cycle });
  if (!updates.length) throw new Error('Nothing to update on the subscription.');
  await batchUpdateCells(token, updates);
  return rows[rowIdx][nameCol];
}

// ── Budget categories (Monthly Expenses) ───────────────────────────────────────
export async function updateBudgetAllowance(token, { type, monthlyAllowance }) {
  const { headers, rows } = await load(token, `${SHEETS.MONTHLY_EXPENSES}!A:Z`);
  const typeCol = findCol(headers, 'type') >= 0 ? findCol(headers, 'type') : 0;
  const allowCol = findCol(headers, 'allowance', 'monthly');
  if (allowCol < 0) throw new Error('Could not find a "Monthly Allowance" column in Monthly Expenses.');

  let rowIdx = -1;
  for (let r = 1; r < rows.length; r++) {
    if (norm(rows[r][typeCol]) === norm(type)) { rowIdx = r; break; }
  }
  if (rowIdx < 0) throw new Error(`No budget category named "${type}" found.`);
  const sheetRow = rowIdx + 1;
  await batchUpdateCells(token, [{ range: `${SHEETS.MONTHLY_EXPENSES}!${colLetter(allowCol)}${sheetRow}`, value: monthlyAllowance }]);
  return rows[rowIdx][typeCol];
}

export async function updateBudgetPriority(token, { type, priority }) {
  const { headers, rows } = await load(token, `${SHEETS.MONTHLY_EXPENSES}!A:Z`);
  const typeCol = findCol(headers, 'type') >= 0 ? findCol(headers, 'type') : 0;
  const priCol = findCol(headers, 'priority');
  if (priCol < 0) throw new Error('Could not find a "Priority" column in Monthly Expenses.');

  let rowIdx = -1;
  for (let r = 1; r < rows.length; r++) {
    if (norm(rows[r][typeCol]) === norm(type)) { rowIdx = r; break; }
  }
  if (rowIdx < 0) throw new Error(`No budget category named "${type}" found.`);
  const sheetRow = rowIdx + 1;
  await batchUpdateCells(token, [{ range: `${SHEETS.MONTHLY_EXPENSES}!${colLetter(priCol)}${sheetRow}`, value: priority }]);
  return rows[rowIdx][typeCol];
}

// ── Allocation rows ─────────────────────────────────────────────────────────
// Locate one allocation row by month + category + account. requireBlank limits
// the match to rows whose Amount is empty (the broken rows we're repairing).
async function findAllocationRow(token, { month, category, account, requireBlank }) {
  const { headers, rows } = await load(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A:F`);
  const dateCol = findCol(headers, 'date') >= 0 ? findCol(headers, 'date') : 0;
  const typeCol = findCol(headers, 'type') >= 0 ? findCol(headers, 'type') : 1;
  const amtCol  = findCol(headers, 'amount') >= 0 ? findCol(headers, 'amount') : 2;
  const acctCol = findCol(headers, 'account') >= 0 ? findCol(headers, 'account') : 4;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (month && monthKey(row[dateCol]) !== month) continue;
    if (category && norm(row[typeCol]) !== norm(category)) continue;
    if (account && norm(row[acctCol]) !== norm(account)) continue;
    const blank = row[amtCol] === '' || row[amtCol] == null;
    if (requireBlank && !blank) continue;
    return { sheetRow: r + 1, amtCol };
  }
  throw new Error(`No matching allocation found (${category || 'any'} / ${account || 'any'} / ${month || 'any month'}).`);
}

export async function setAllocationAmount(token, { month, category, account, amount, requireBlank = false }) {
  const { sheetRow, amtCol } = await findAllocationRow(token, { month, category, account, requireBlank });
  await batchUpdateCells(token, [{ range: `${SHEETS.ALLOCATION_TRANSACTIONS}!${colLetter(amtCol)}${sheetRow}`, value: amount }]);
  return sheetRow;
}

export async function deleteAllocation(token, { month, category, account, requireBlank = false }) {
  const { sheetRow } = await findAllocationRow(token, { month, category, account, requireBlank });
  await clearRow(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A${sheetRow}:F${sheetRow}`);
  return sheetRow;
}

// ── Savings / affordability plans ───────────────────────────────────────────
// Plans live in their own "Plans" tab so Ledger can save a goal once and check
// progress later with a single cheap read — no need to re-derive it every turn.
const PLANS_SHEET = 'Plans';
const PLAN_HEADER = ['ID', 'Name', 'Scope', 'Target', 'Saved', 'Per Month', 'Target Date', 'Funding', 'Status', 'Created', 'Notes'];

// Create the Plans tab + header row on first use; idempotent thereafter.
export async function ensurePlansSheet(token) {
  await ensureSheetTab(token, PLANS_SHEET);
  const head = await readRange(token, `${PLANS_SHEET}!A1:K1`, 'UNFORMATTED_VALUE').catch(() => []);
  const hasHeader = head.length && norm(head[0]?.[0]) === 'id';
  if (!hasHeader) await appendRow(token, `${PLANS_SHEET}!A1`, PLAN_HEADER);
  return PLANS_SHEET;
}

export async function readPlans(token) {
  await ensurePlansSheet(token);
  return readRange(token, `${PLANS_SHEET}!A:K`, 'UNFORMATTED_VALUE');
}

// Locate a plan row by exact ID or by a name substring (so the user can say
// "my laptop plan" without quoting the generated ID).
function findPlanRow(rows, idOrName) {
  const key = norm(idOrName);
  for (let r = 1; r < rows.length; r++) {
    if (norm(rows[r][0]) === key || (key && norm(rows[r][1]).includes(key))) return r;
  }
  return -1;
}

// Create a new plan or update an existing one (matched by id). Returns the id.
export async function savePlan(token, p) {
  const rows = await readPlans(token);
  const id = p.id || `plan_${Date.now()}`;
  const record = [
    id,
    p.name || 'Goal',
    p.scope || 'personal',
    p.target ?? '',
    p.saved ?? 0,
    p.perMonth ?? '',
    p.targetDate || '',
    p.funding ? JSON.stringify(p.funding) : '',
    p.status || 'active',
    p.created || new Date().toISOString().slice(0, 10),
    p.notes || '',
  ];

  const rowIdx = p.id ? findPlanRow(rows, id) : -1;
  if (rowIdx >= 0) {
    const sheetRow = rowIdx + 1;
    await batchUpdateCells(token, record.map((value, i) => ({
      range: `${PLANS_SHEET}!${colLetter(i)}${sheetRow}`, value,
    })));
  } else {
    await appendRow(token, `${PLANS_SHEET}!A:K`, record);
  }
  return id;
}

// Log a contribution (addAmount), set an absolute saved figure, and/or change
// status (active / paused / done). Returns the plan's new saved total.
export async function updatePlanProgress(token, { id, addAmount, setSaved, status }) {
  const rows = await readPlans(token);
  const rowIdx = findPlanRow(rows, id);
  if (rowIdx < 0) throw new Error(`No plan matching "${id}".`);
  const sheetRow = rowIdx + 1;
  const current = parseFloat(rows[rowIdx][4]) || 0;

  const newSaved = setSaved != null ? round2(setSaved)
    : addAmount != null ? round2(current + addAmount)
    : null;

  const updates = [];
  if (newSaved != null) updates.push({ range: `${PLANS_SHEET}!E${sheetRow}`, value: newSaved });
  if (status)           updates.push({ range: `${PLANS_SHEET}!I${sheetRow}`, value: status });
  if (!updates.length) throw new Error('Nothing to update on the plan (pass addAmount, setSaved, or status).');
  await batchUpdateCells(token, updates);
  return { name: rows[rowIdx][1], saved: newSaved != null ? newSaved : current };
}

export async function deletePlan(token, { id }) {
  const rows = await readPlans(token);
  const rowIdx = findPlanRow(rows, id);
  if (rowIdx < 0) throw new Error(`No plan matching "${id}".`);
  await clearRow(token, `${PLANS_SHEET}!A${rowIdx + 1}:K${rowIdx + 1}`);
  return rows[rowIdx][1];
}

// Reprogram the budget by setting several category allowances at once. Each
// change reuses updateBudgetAllowance, so a renamed/missing category fails loudly.
export async function applyPlanToBudget(token, changes) {
  const applied = [];
  for (const c of changes) {
    const matched = await updateBudgetAllowance(token, { type: c.type, monthlyAllowance: c.monthly_allowance });
    applied.push(`${matched} → ${c.monthly_allowance}`);
  }
  return applied;
}

// ── Loans ─────────────────────────────────────────────────────────────────────
// Four tabs:
//   Loans           one row per debt. Principal/Accrued are true AS OF the row's
//                   As Of date; the servicer's statement is the source of truth and
//                   "From statement" re-anchors both.
//   Loan Payments   append-only: every payment with its interest/principal split.
//   Loan Interest   append-only accrual ledger: every stretch of daily interest,
//                   one row per loan per calendar month touched. The history of
//                   what the debt has cost, month by month.
//   Loan Plan       key/value settings shared by every device (scope, strategy,
//                   debt-free-by goal). The monthly amount is NOT here: it is the
//                   Student Loans envelope's Monthly Allowance, so Process Income
//                   and the Loans page read one number.
import {
  accrueTo, applyPayment, LOAN_ENVELOPE, loanBalance,
} from './loans.js';

const LOANS_SHEET = 'Loans';
const LOAN_HEADER = [
  'ID', 'Borrower', 'Servicer', 'Name', 'Principal', 'Accrued Interest', 'Rate',
  'Status', 'Subsidized', 'Min Payment', 'Capitalizes On', 'Opened', 'Notes', 'As Of',
];
const LOAN_PAYMENTS_SHEET = 'Loan Payments';
const LOAN_PAYMENT_HEADER = [
  'Date', 'Loan ID', 'Loan Name', 'Amount', 'To Interest', 'To Principal',
  'Balance After', 'Paid By', 'Note',
];
const LOAN_INTEREST_SHEET = 'Loan Interest';
const LOAN_INTEREST_HEADER = [
  'Month', 'Loan ID', 'Loan Name', 'From', 'To', 'Days', 'Principal', 'Rate',
  'Interest', 'Accrued After', 'Source',
];
const LOAN_PLAN_SHEET = 'Loan Plan';
const LOAN_PLAN_DEFAULTS = { scope: 'Me', strategy: 'avalanche', debtFreeBy: '' };

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mdy = (iso) => { const [y, m, d] = String(iso).split('-'); return `${Number(m)}/${Number(d)}/${y}`; };

async function ensureHeader(token, sheet, header) {
  await ensureSheetTab(token, sheet);
  const last = colLetter(header.length - 1);
  const head = await readRange(token, `${sheet}!A1:${last}1`, 'UNFORMATTED_VALUE').catch(() => []);
  if (!head.length || !head[0]?.[0]) {
    await batchUpdateCells(token, header.map((h, i) => ({ range: `${sheet}!${colLetter(i)}1`, value: h })));
    return;
  }
  // A column added later (Loans: As Of) is written onto an existing header row.
  const have = head[0].map(norm);
  const missing = header.map((h, i) => ({ h, i })).filter(({ h, i }) => norm(have[i]) !== norm(h) && !have.includes(norm(h)));
  if (missing.length) await batchUpdateCells(token, missing.map(({ h, i }) => ({ range: `${sheet}!${colLetter(i)}1`, value: h })));
}

export const ensureLoansSheet = (token) => ensureHeader(token, LOANS_SHEET, LOAN_HEADER);
export const ensureLoanPaymentsSheet = (token) => ensureHeader(token, LOAN_PAYMENTS_SHEET, LOAN_PAYMENT_HEADER);
export const ensureLoanInterestSheet = (token) => ensureHeader(token, LOAN_INTEREST_SHEET, LOAN_INTEREST_HEADER);

export async function readLoans(token) {
  await ensureLoansSheet(token);
  return readRange(token, `${LOANS_SHEET}!A:N`, 'UNFORMATTED_VALUE');
}

export async function readLoanPayments(token) {
  await ensureLoanPaymentsSheet(token);
  return readRange(token, `${LOAN_PAYMENTS_SHEET}!A:I`, 'UNFORMATTED_VALUE');
}

export async function readLoanInterest(token) {
  await ensureLoanInterestSheet(token);
  return readRange(token, `${LOAN_INTEREST_SHEET}!A:K`, 'UNFORMATTED_VALUE');
}

/** Header row + rows -> objects keyed by header. */
export function loanRowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const head = rows[0].map(h => String(h || '').trim());
  return rows.slice(1).filter(r => r && r.some(c => c !== '' && c != null))
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// Sheets hands a date back as a serial with UNFORMATTED_VALUE; the engine wants ISO.
function isoDate(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!isNaN(n) && n > 1000 && !String(v).includes('-') && !String(v).includes('/')) {
    return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const p = s.split('/');
  if (p.length === 3) return `${p[2]}-${String(p[0]).padStart(2, '0')}-${String(p[1]).padStart(2, '0')}`;
  return '';
}

/** Sheet rows -> loan objects the engine in lib/loans.js understands. */
export function parseLoans(rows) {
  if (!rows || rows.length < 2) return [];
  return rows.slice(1)
    .map((r, i) => ({ r, row: i + 2 }))
    .filter(({ r }) => r && r[0])
    .map(({ r, row }) => ({
      row,
      id: String(r[0]),
      borrower: r[1] || '',
      servicer: r[2] || '',
      name: r[3] || 'Loan',
      principal: Number(r[4]) || 0,
      accrued: Number(r[5]) || 0,
      // Accepts a fraction (0.0754) or a percent (7.54) — statements print percents.
      rate: (() => { const v = Number(r[6]) || 0; return v > 1 ? v / 100 : v; })(),
      status: String(r[7] || 'deferred').toLowerCase(),
      subsidized: String(r[8]).toLowerCase() === 'true' || String(r[8]).toLowerCase() === 'yes',
      minPayment: Number(r[9]) || 0,
      capitalizesOn: isoDate(r[10]),
      opened: isoDate(r[11]) || r[11] || '',
      notes: r[12] || '',
      asOf: isoDate(r[13]),
    }));
}

function findLoanRow(rows, idOrName) {
  const key = norm(idOrName);
  for (let r = 1; r < rows.length; r++) {
    if (norm(rows[r][0]) === key || (key && norm(rows[r][3]).includes(key))) return r;
  }
  return -1;
}

export async function saveLoan(token, l) {
  const rows = await readLoans(token);
  const id = l.id || `loan_${Date.now()}`;
  const record = [
    id,
    l.borrower || 'Me',
    l.servicer || '',
    l.name || 'Loan',
    round2(l.principal ?? 0),
    round2(l.accrued ?? 0),
    l.rate ?? 0,
    l.status || 'deferred',
    l.subsidized ? 'yes' : 'no',
    round2(l.minPayment ?? 0),
    l.capitalizesOn || '',
    l.opened || todayIso(),
    l.notes || '',
    l.asOf || todayIso(),
  ];
  const rowIdx = l.id ? findLoanRow(rows, id) : -1;
  if (rowIdx >= 0) {
    await batchUpdateCells(token, record.map((value, i) => ({
      range: `${LOANS_SHEET}!${colLetter(i)}${rowIdx + 1}`, value,
    })));
  } else {
    await appendRow(token, `${LOANS_SHEET}!A:N`, record);
  }
  return id;
}

export async function deleteLoan(token, { id }) {
  const rows = await readLoans(token);
  const rowIdx = findLoanRow(rows, id);
  if (rowIdx < 0) throw new Error(`No loan matching "${id}".`);
  await clearRow(token, `${LOANS_SHEET}!A${rowIdx + 1}:N${rowIdx + 1}`);
  return rows[rowIdx][3];
}

/**
 * Bring every loan's interest current to `toDate` (default today): append the
 * Loan Interest rows, then move each loan's Accrued and As Of forward in one
 * write. Idempotent - a second call the same day finds nothing to accrue. Loans
 * with no As Of are skipped (no start date is ever guessed).
 * Returns the loans as they now stand.
 */
export async function accrueLoans(token, loans, { toDate = todayIso(), source = 'app' } = {}) {
  const out = [];
  const ledger = [];
  const cells = [];
  for (const l of loans) {
    const res = accrueTo(l, toDate);
    out.push(res.loan);
    if (!res.segments.length) continue;
    let acc = Number(l.accrued) || 0;
    for (const g of res.segments) {
      acc = round2(acc + g.interest);
      if (g.interest > 0) ledger.push([g.month, l.id, l.name, g.from, g.to, g.days, round2(l.principal), l.rate, g.interest, acc, source]);
    }
    cells.push({ range: `${LOANS_SHEET}!F${l.row}`, value: res.loan.accrued });
    cells.push({ range: `${LOANS_SHEET}!N${l.row}`, value: res.loan.asOf });
  }
  if (!cells.length) return out;
  await ensureLoanInterestSheet(token);
  // Subsidized loans in school accrue nothing: their As Of still moves, no ledger row.
  // Ledger first: if the second write fails, a re-run sees the old As Of and would
  // double-count, so the ledger rows carry From/To and the nightly check (audit C17)
  // flags any overlap.
  if (ledger.length) await appendRows(token, `${LOAN_INTEREST_SHEET}!A:K`, ledger);
  await batchUpdateCells(token, cells);
  return out;
}

/**
 * Record a payment. The loan's interest is first brought current to the payment
 * date (so the split is what the servicer will do), then the payment is split
 * interest-first, then three writes: the Loan Payments row, the loan's balances,
 * and - when the money came out of the Student Loans envelope - a spend row in
 * Allocation Transactions, exactly like any other envelope spend.
 */
export async function logLoanPayment(token, { loan, amount, paidBy, note, date, fromEnvelope = true, account = 'Outside Payment' }) {
  const day = date || todayIso();
  const [current] = await accrueLoans(token, [loan], { toDate: day, source: 'payment' });
  const split = applyPayment(current, amount);
  if (split.applied <= 0) throw new Error('Nothing to apply - this loan is already paid.');
  const after = split.loan;
  const balanceAfter = loanBalance(after);

  await ensureLoanPaymentsSheet(token);
  await appendRow(token, `${LOAN_PAYMENTS_SHEET}!A:I`, [
    day, loan.id, loan.name || '', round2(split.applied), split.toInterest, split.toPrincipal,
    balanceAfter, paidBy || '', note || '',
  ]);
  await batchUpdateCells(token, [
    { range: `${LOANS_SHEET}!E${loan.row}`, value: after.principal },
    { range: `${LOANS_SHEET}!F${loan.row}`, value: after.accrued },
    ...(balanceAfter <= 0 ? [{ range: `${LOANS_SHEET}!H${loan.row}`, value: 'paid' }] : []),
  ]);
  if (fromEnvelope) {
    await appendRow(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A:F`, [
      mdy(day), LOAN_ENVELOPE, -round2(split.applied),
      `Loan payment: ${loan.servicer ? loan.servicer + ' ' : ''}${loan.name} (interest ${split.toInterest.toFixed(2)}, principal ${split.toPrincipal.toFixed(2)})`,
      account, true,
    ]);
  }
  return { ...split, balanceAfter, unused: split.unused };
}

/**
 * Re-anchor a loan to a servicer statement: principal and unpaid interest as
 * printed, true as of the statement date. Accrual resumes from that date.
 */
export async function reconcileLoan(token, { id, principal, accrued, asOf }) {
  const rows = await readLoans(token);
  const rowIdx = findLoanRow(rows, id);
  if (rowIdx < 0) throw new Error(`No loan matching "${id}".`);
  const sheetRow = rowIdx + 1;
  await batchUpdateCells(token, [
    { range: `${LOANS_SHEET}!E${sheetRow}`, value: round2(principal) },
    { range: `${LOANS_SHEET}!F${sheetRow}`, value: round2(accrued) },
    { range: `${LOANS_SHEET}!N${sheetRow}`, value: asOf || todayIso() },
  ]);
  return { principal: round2(principal), accrued: round2(accrued) };
}

// ── Loan Plan settings ──────────────────────────────────────────────────────
export async function readLoanPlan(token) {
  await ensureHeader(token, LOAN_PLAN_SHEET, ['Key', 'Value']);
  const rows = await readRange(token, `${LOAN_PLAN_SHEET}!A:B`, 'UNFORMATTED_VALUE').catch(() => []);
  const out = { ...LOAN_PLAN_DEFAULTS };
  rows.slice(1).forEach(r => { if (r && r[0]) out[String(r[0]).trim()] = r[1] ?? ''; });
  if (out.debtFreeBy) out.debtFreeBy = isoDate(out.debtFreeBy);
  return out;
}

export async function saveLoanPlan(token, patch) {
  await ensureHeader(token, LOAN_PLAN_SHEET, ['Key', 'Value']);
  const rows = await readRange(token, `${LOAN_PLAN_SHEET}!A:B`, 'UNFORMATTED_VALUE').catch(() => []);
  const cells = [];
  const append = [];
  for (const [k, v] of Object.entries(patch)) {
    const i = rows.findIndex((r, j) => j > 0 && norm(r?.[0]) === norm(k));
    if (i > 0) cells.push({ range: `${LOAN_PLAN_SHEET}!B${i + 1}`, value: v ?? '' });
    else append.push([k, v ?? '']);
  }
  if (cells.length) await batchUpdateCells(token, cells);
  if (append.length) await appendRows(token, `${LOAN_PLAN_SHEET}!A:B`, append);
}

// ── The Student Loans envelope ──────────────────────────────────────────────
/**
 * Make sure Monthly Expenses has the Student Loans envelope, built with the same
 * formulas as its neighbours so the sheet's own columns (share of income, balance
 * to deposit, remaining) keep working. Returns { row, allowance, created }.
 */
export async function ensureLoanEnvelope(token, { allowance = 0 } = {}) {
  const sheet = SHEETS.MONTHLY_EXPENSES;
  const rows = await readRange(token, `${sheet}!A:J`, 'UNFORMATTED_VALUE');
  const i = rows.findIndex((r, j) => j > 0 && norm(r?.[0]) === norm(LOAN_ENVELOPE));
  if (i > 0) return { row: i + 1, allowance: Number(String(rows[i][9] ?? '').replace(/[$,]/g, '')) || 0, created: false };
  const n = rows.length + 1;
  await appendRow(token, `${sheet}!A:S`, [
    LOAN_ENVELOPE, 'Outside Payment', 'Monthly', 'Stability', '2',
    `=Q${n}*UnclaimedIncome`, `=H${n}*7`, `=F${n}/DaysApplicableforCI`, `=Q${n}*ProcessedIncome`,
    round2(allowance), '', '', '', '', '0', `=J${n}-O${n}`, `=J${n}/ALLOWANCE_SUM()`, '', `=(R${n}/J${n})`,
  ]);
  return { row: n, allowance: round2(allowance), created: true };
}

/** The monthly plan IS the envelope's allowance. */
export async function setLoanPlanAmount(token, amount) {
  await ensureLoanEnvelope(token);
  return updateBudgetAllowance(token, { type: LOAN_ENVELOPE, monthlyAllowance: round2(amount) });
}
