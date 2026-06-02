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
    localStorage.setItem(KEY, JSON.stringify({ value, ...meta, ts: Date.now() }));
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
