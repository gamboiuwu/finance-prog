// ── Dynamic Gas Budget ────────────────────────────────────────────────────────
// The "claimable gas budget" is NOT a fixed dollar amount — it scales with the
// live gas price. It represents a full-month fuel reserve for the user's typical
// driving (2 quarter-circuits/day ≈ 56.6 mi/day):
//
//     budget = (milesPerDay ÷ mpg) gal/day  ×  $/gal  ×  daysInMonth
//
// With mpg 23.5, ~$2.57/gal, 30-day month → ≈ $185, which is what the user sees.
// The amount you still need to deposit into Gas = budget − current gas balance.
//
// Computed wherever the gas price is available (Dashboard, Summary) and cached so
// pages that don't fetch the price (Budget, ProcessIncome) can read the same value.

import { readRange, updateCell, ensureSheetTab } from './sheets';

export const GAS_MILES_PER_DAY = 56.6; // 2 QC/day driving pattern
export const DEFAULT_MPG = 23.5;
const KEY = '_fin_gas_budget';

export function daysInCurrentMonth() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
}

// Full-month gas reserve in dollars. Returns null if inputs are unusable.
export function computeGasBudget({ gasPerGal, mpg = DEFAULT_MPG, daysInMonth, milesPerDay = GAS_MILES_PER_DAY }) {
  const days = daysInMonth || daysInCurrentMonth();
  const m = mpg > 0 ? mpg : DEFAULT_MPG;
  if (!gasPerGal || gasPerGal <= 0 || !days) return null;
  return (milesPerDay / m) * gasPerGal * days;
}

// Persist the latest computed budget (+ the inputs that produced it) for other pages.
export function saveGasBudget(value, meta = {}) {
  if (typeof value !== 'number' || !(value > 0)) return;
  try {
    // Keep a caller-supplied ts (adopting the shared copy) so the two sides agree
    // on which record is newer instead of re-pushing on every load.
    localStorage.setItem(KEY, JSON.stringify({ value, ...meta, ts: meta.ts || Date.now() }));
  } catch {}
}

// Read the cached budget. Returns the full record { value, gasPerGal, mpg, ts } or null.
export function getGasBudget() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return typeof o.value === 'number' && o.value > 0 ? o : null;
  } catch {
    return null;
  }
}

// The gas allowance to use for a Gas budget item: the live dynamic budget if we
// have one cached, otherwise the static sheet allowance as a fallback.
export function gasAllowance(sheetAllowance = 0) {
  const cached = getGasBudget();
  return cached ? cached.value : sheetAllowance;
}

// ── Shared copy in the sheet ──────────────────────────────────────────────────
// The cache above is per device (localStorage), so a phone that fetched the gas
// price today and a laptop that never did would hand ProcessIncome two different
// Gas targets (~$185 vs the static $120). App Settings row 3 holds the latest
// computed budget as JSON so every device reconciles to the same figure. Newest
// `ts` wins in both directions; all failures are silent (the local cache stands).
const SETTINGS_TAB = 'App Settings';
const GAS_LABEL_CELL = 'App Settings!A3';
const GAS_VAL_CELL   = 'App Settings!B3';

export async function fetchRemoteGasBudget(token) {
  if (!token) return null;
  try {
    const rows = await readRange(token, GAS_VAL_CELL, 'UNFORMATTED_VALUE');
    const raw = rows?.[0]?.[0];
    if (raw == null || String(raw).trim() === '') return null;
    const o = JSON.parse(String(raw));
    return typeof o.value === 'number' && o.value > 0 ? o : null;
  } catch {
    return null;
  }
}

export async function saveRemoteGasBudget(token, record) {
  if (!token || !record || typeof record.value !== 'number' || !(record.value > 0)) return;
  const write = async () => {
    await updateCell(token, GAS_LABEL_CELL, 'Gas budget (dynamic, JSON) - do not edit');
    await updateCell(token, GAS_VAL_CELL, JSON.stringify(record));
  };
  try {
    await write();
  } catch {
    // Only a missing tab warrants the addSheet call (it 400s when the tab exists).
    try { await ensureSheetTab(token, SETTINGS_TAB); await write(); } catch { /* best effort */ }
  }
}

// Reconcile the local cache with the shared copy: adopt the newer one, push ours
// if it is newer. Returns the record that should be in effect (or null).
export async function syncGasBudget(token) {
  const local  = getGasBudget();
  const remote = await fetchRemoteGasBudget(token);
  if (remote && (!local || (remote.ts || 0) > (local.ts || 0))) {
    saveGasBudget(remote.value, remote);
    return remote;
  }
  if (local && (!remote || (local.ts || 0) > (remote.ts || 0))) saveRemoteGasBudget(token, local);
  return local;
}
