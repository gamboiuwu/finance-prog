// Budget category ordering & pinning preferences (Task 25).
// Stored device-locally only — opaque category (Type) names + integer sort
// positions, never any financial figures — so nothing sensitive leaves the
// private Google Sheet. Shared by Budget.jsx (Categories tab) and
// ProcessIncome.jsx (allocation breakdown) so both honor the same order.

const ORDER_KEY = '_fin_cat_order'; // { "TypeName": sortIndex }
const PINS_KEY  = '_fin_cat_pins';  // ["TypeName", ...]

export function getCatOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
export function saveCatOrder(map) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(map)); } catch { /* quota / private mode */ }
}
export function getCatPins() {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
export function saveCatPins(arr) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(Array.from(new Set(arr)))); } catch { /* quota */ }
}

export function isPinned(type) { return getCatPins().includes(type); }

// Toggle a pin and return the new pins array.
export function toggleCatPin(type) {
  const pins = getCatPins();
  const next = pins.includes(type) ? pins.filter(t => t !== type) : [...pins, type];
  saveCatPins(next);
  return next;
}

export function hasCatPrefs() {
  return Object.keys(getCatOrder()).length > 0 || getCatPins().length > 0;
}
export function resetCatPrefs() {
  saveCatOrder({});
  saveCatPins([]);
}

// Stable comparator: pinned first, then stored custom order index, then the
// list's original order (so untouched items keep their incoming sequence).
export function sortByCatPrefs(list, getType = i => (i && i['Type']) || '') {
  const order = getCatOrder();
  const pins  = new Set(getCatPins());
  return list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ta = getType(a.item), tb = getType(b.item);
      const pa = pins.has(ta) ? 0 : 1, pb = pins.has(tb) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const oa = ta in order ? order[ta] : Infinity;
      const ob = tb in order ? order[tb] : Infinity;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map(x => x.item);
}

// Persist a new within-group order: assign sequential indices to the given
// Type names. Other groups' stored indices are left untouched (each group
// sorts independently, so reused indices across groups never collide visibly).
export function commitCatOrder(typeNames) {
  const map = getCatOrder();
  typeNames.forEach((t, i) => { if (t) map[t] = i; });
  saveCatOrder(map);
  return map;
}
