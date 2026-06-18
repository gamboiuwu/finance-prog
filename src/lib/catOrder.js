// ── Budget Category Reorder & Pinning (Task 25) ──────────────────────────────
// Shared ordering used by the Budget tabs AND the ProcessIncome breakdown so a
// custom order/pin is honoured everywhere a category list is shown.
//
// Storage (localStorage — no financial data, just display preferences):
//   _fin_cat_order = { "TypeName": sortIndex }   custom position within a group
//   _fin_cat_pins  = ["TypeName", ...]           pinned items float to the top
//
// Ordering rule (see orderTypes): pinned first, then ascending sortIndex, then
// the list's original order as a stable fallback. Indices are written per group
// (a group = a pre-filtered subset such as one Expense category), so values may
// repeat across groups — that's fine because comparison only ever happens inside
// a single already-grouped list. Cross-screen surfaces (ProcessIncome) key off
// the PIN flag only, which is globally meaningful.

const ORDER_KEY = '_fin_cat_order';
const PINS_KEY  = '_fin_cat_pins';

export function getCatOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
export function getCatPins() {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function setCatOrder(map)  { localStorage.setItem(ORDER_KEY, JSON.stringify(map)); }
function setCatPins(arr)   { localStorage.setItem(PINS_KEY, JSON.stringify(arr)); }

export function isPinned(type) { return getCatPins().includes(type); }

// Toggle a pin; returns the new pins array.
export function togglePin(type) {
  if (!type) return getCatPins();
  const pins = getCatPins();
  const i = pins.indexOf(type);
  if (i >= 0) pins.splice(i, 1); else pins.push(type);
  setCatPins(pins);
  return pins;
}

// Persist the new visual order of a group as sequential indices. Because the
// passed order already has pinned items on top, the written indices stay
// self-consistent with the pinned-first sort.
export function setGroupOrder(orderedTypes) {
  const order = getCatOrder();
  orderedTypes.forEach((t, i) => { if (t) order[t] = i; });
  setCatOrder(order);
}

// Clear all custom ordering AND pins (the "Reset Order" action).
export function resetCatOrder() {
  localStorage.removeItem(ORDER_KEY);
  localStorage.removeItem(PINS_KEY);
}

// Returns a NEW array sorted: pinned first, then custom sortIndex, then original
// order (stable). `getType` extracts the category key from each element.
export function orderTypes(arr, getType) {
  const order  = getCatOrder();
  const pinSet = new Set(getCatPins());
  const ordRank = (t) => (Object.prototype.hasOwnProperty.call(order, t) ? order[t] : Infinity);
  return arr
    .map((item, i) => ({ item, i, t: getType(item) || '' }))
    .sort((a, b) => {
      const pa = pinSet.has(a.t) ? 0 : 1;
      const pb = pinSet.has(b.t) ? 0 : 1;
      if (pa !== pb) return pa - pb;            // pinned cluster first
      const oa = ordRank(a.t), ob = ordRank(b.t);
      if (oa !== ob) return oa - ob;            // custom order
      return a.i - b.i;                          // stable fallback
    })
    .map(x => x.item);
}

// Move a type one slot up (dir=-1) or down (dir=+1) within its group's displayed
// order, persist, and return the new ordered type list (or null if no move).
export function moveTypeWithin(orderedTypes, type, dir) {
  const idx = orderedTypes.indexOf(type);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= orderedTypes.length) return null;
  const next = orderedTypes.slice();
  [next[idx], next[j]] = [next[j], next[idx]];
  setGroupOrder(next);
  return next;
}

// Drag-and-drop: move `fromType` to occupy `toType`'s position, persist.
export function dropTypeOnto(orderedTypes, fromType, toType) {
  const from = orderedTypes.indexOf(fromType);
  const to   = orderedTypes.indexOf(toType);
  if (from < 0 || to < 0 || from === to) return null;
  const next = orderedTypes.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  setGroupOrder(next);
  return next;
}
