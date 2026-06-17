// Budget category pin + custom-order persistence (Task 25 — Reorder & Pinning).
// Pure localStorage; no financial data, no network. Keyed by budget-item "Type"
// (the same name used in Monthly Expenses / Allocation Transactions), so the order
// is shared everywhere a category list is rendered (Budget → Categories and the
// ProcessIncome allocation breakdown).

const PINS_KEY  = '_fin_cat_pins';   // ["Rent", "Groceries", ...]
const ORDER_KEY = '_fin_cat_order';  // { "Rent": 0, "Groceries": 1, ... }

export function getCatPins() {
  try { const v = JSON.parse(localStorage.getItem(PINS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

export function getCatOrder() {
  try { const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; }
  catch { return {}; }
}

export function isPinned(type) {
  return getCatPins().includes(type);
}

// Toggle a category's pinned state. Pinned items float to the top of their group.
export function togglePin(type) {
  if (!type) return;
  const pins = getCatPins();
  const i = pins.indexOf(type);
  if (i >= 0) pins.splice(i, 1);
  else pins.push(type);
  localStorage.setItem(PINS_KEY, JSON.stringify(pins));
}

// Persist an explicit display order for a list of Types (index = position).
// Order indices are scoped per-render-group; sorting is always applied within a
// single group, so identical indices across groups never collide.
export function persistOrder(orderedTypes) {
  const order = getCatOrder();
  orderedTypes.forEach((t, idx) => { if (t) order[t] = idx; });
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
}

export function hasCustomLayout() {
  return getCatPins().length > 0 || Object.keys(getCatOrder()).length > 0;
}

export function resetCatLayout() {
  localStorage.removeItem(PINS_KEY);
  localStorage.removeItem(ORDER_KEY);
}

// Stable comparator: pinned first, then saved order index, then the list's
// original order (kept as the final tiebreak so unconfigured items don't jump).
export function sortByCatLayout(list, typeOf = (x) => x['Type'] || '') {
  const pinSet = new Set(getCatPins());
  const order  = getCatOrder();
  const BIG    = 1e9;
  return list
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => {
      const ta = typeOf(a.it), tb = typeOf(b.it);
      const pa = pinSet.has(ta) ? 0 : 1, pb = pinSet.has(tb) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const oa = ta in order ? order[ta] : BIG;
      const ob = tb in order ? order[tb] : BIG;
      if (oa !== ob) return oa - ob;
      return a.idx - b.idx;
    })
    .map((x) => x.it);
}
