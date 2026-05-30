// Safe write helpers for the finance spreadsheet.
//
// Every write LOCATES its target by matching column HEADER names and row keys at
// runtime, rather than trusting fixed positions — so a reordered or renamed sheet
// fails loudly (throws) instead of silently writing into the wrong column. Shared
// by the one-time Data Repair tool and by Ledger's write tools.
import { readRange, batchUpdateCells, clearRow, appendRow, ensureSheetTab } from './sheets';
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
