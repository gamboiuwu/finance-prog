import { readRange, appendRow } from './sheets';

// ──────────────────────────────────────────────────────────────────────────
// Sheet schemas this module assumes. Audit + adjust ranges if columns drift.
//
//   Business Products      A:E  → Name | Unit Price | Steps JSON | Active | Notes
//   Business Transactions  A:G  → Date | Product | Client | Gross | Revenue | Net | Notes
//   Allocation Transactions A:F → Date | Type | Amount | Description | Account | Processed
//
// "Account" balance for a non-priority allocation step (COGS, Overhead, …)
// is the running sum of Amount across Allocation Transactions rows whose
// Account equals that step's name. Positive rows = contributions from a
// sale; negative rows = drawdowns (real-world spend out of that bucket).
// ──────────────────────────────────────────────────────────────────────────

const PRIORITY_ACCOUNTS = new Set([
  'Checking', 'Outside Payment', 'Cash', 'Savings', 'Business Tax', 'Subscription',
]);

function pm(v) {
  const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function todayStr() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export async function loadProducts(token) {
  const rows = await readRange(token, 'Business Products!A2:E');
  return rows
    .filter(r => r[0])
    .map(r => {
      let steps = [];
      try { steps = r[2] ? JSON.parse(r[2]) : []; } catch { steps = []; }
      return {
        name: r[0],
        unitPrice: pm(r[1]),
        steps, // [{ name, kind: 'fixed'|'pctRemaining'|'pctTotal', value, color }]
        active: r[3] !== 'FALSE' && r[3] !== false,
        notes: r[4] || '',
      };
    });
}

export async function loadAllAllocations(token) {
  const rows = await readRange(token, 'Allocation Transactions!A2:F');
  return rows
    .filter(r => r[0])
    .map(r => ({
      date: r[0],
      type: r[1] || '',
      amount: pm(r[2]),
      description: r[3] || '',
      account: r[4] || '',
      processed: r[5] === 'TRUE' || r[5] === true,
    }));
}

export async function loadBusinessTransactions(token) {
  const rows = await readRange(token, 'Business Transactions!A2:G');
  return rows.map((r, i) => ({
    rowIndex: i + 2, // sheet row number (1-indexed, +1 for header)
    date: r[0] || '',
    product: r[1] || '',
    client: r[2] || '',
    gross: pm(r[3]),
    revenue: pm(r[4]),
    net: pm(r[5]),
    notes: r[6] || '',
  }));
}

// Compute per-step amounts for a sale, given the product's formula and gross.
// Each step consumes from a running "remaining" pool starting at gross.
export function computeAllocation(product, gross) {
  let remaining = gross;
  const out = [];
  for (const step of product.steps) {
    let amount = 0;
    if (step.kind === 'fixed') amount = step.value;
    else if (step.kind === 'pctRemaining') amount = remaining * (step.value / 100);
    else if (step.kind === 'pctTotal')     amount = gross     * (step.value / 100);
    amount = Math.max(0, Math.min(amount, remaining));
    remaining -= amount;
    out.push({ ...step, amount });
  }
  return { steps: out, netRemaining: remaining };
}

// Discover allocation "accounts": every step name across products that is NOT
// a priority account (those are handled by ProcessIncome). Excludes "Revenue"
// because revenue is the value that gets handed to ProcessIncome.
export function discoverAccounts(products) {
  const seen = new Map();
  for (const p of products) {
    for (const s of p.steps || []) {
      if (PRIORITY_ACCOUNTS.has(s.name)) continue;
      if (s.name === 'Revenue') continue;
      if (!seen.has(s.name)) seen.set(s.name, { name: s.name, color: s.color });
    }
  }
  return Array.from(seen.values());
}

export function balanceForAccount(allocations, accountName) {
  return allocations
    .filter(a => a.account === accountName)
    .reduce((s, a) => s + a.amount, 0);
}

// Write per-step allocations for a recorded sale. Skips Revenue (handled
// separately via ProcessIncome). Skips zero-amount steps.
export async function recordSaleAllocations(token, { product, client, allocation }) {
  const date = todayStr();
  const desc = client ? `${product.name} — ${client}` : product.name;
  for (const step of allocation.steps) {
    if (step.name === 'Revenue') continue;
    if (!step.amount) continue;
    await appendRow(token, 'Allocation Transactions!A:F', [
      date,
      step.name,
      parseFloat(step.amount.toFixed(2)),
      desc,
      step.name,
      true,
    ]);
  }
}

// Write the Business Transactions row that the Sales screen reads.
export async function recordBusinessTransaction(token, { product, client, gross, allocation }) {
  const revenueStep = allocation.steps.find(s => s.name === 'Revenue');
  const revenue = revenueStep ? revenueStep.amount : 0;
  await appendRow(token, 'Business Transactions!A:G', [
    todayStr(),
    product.name,
    client || '',
    parseFloat(gross.toFixed(2)),
    parseFloat(revenue.toFixed(2)),
    parseFloat(allocation.netRemaining.toFixed(2)),
    '',
  ]);
}

// Spend from an allocation account: writes a negative Allocation Transactions
// row (so balance drops) AND a regular expense row that the main ledger picks up.
export async function spendFromAccount(token, { accountName, amount, vendor, description }) {
  const date = todayStr();
  const desc = `${vendor ? vendor + ' — ' : ''}${description || `Spend from ${accountName}`}`;
  await appendRow(token, 'Allocation Transactions!A:F', [
    date,
    accountName,
    -parseFloat(amount.toFixed(2)),
    desc,
    accountName,
    true,
  ]);
  await appendRow(token, 'Business Transactions!A:G', [
    date,
    `${accountName} spend`,
    vendor || '',
    0,
    0,
    -parseFloat(amount.toFixed(2)),
    description || '',
  ]);
}
