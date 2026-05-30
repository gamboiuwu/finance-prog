const EIA_BASE = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';
const CACHE_KEY = 'eia_gas_v1';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour — EIA publishes weekly (Mondays)

// All available regions near NYC/Long Island
export const REGIONS = [
  { code: 'Y35NY', label: 'New York City',         note: 'Closest to LI' },
  { code: 'SNY',   label: 'New York State',         note: 'Includes Long Island' },
  { code: 'R1Y',   label: 'PADD 1B (Metro Corr.)', note: 'NY/NJ/PA metro' },
  { code: 'R1Z',   label: 'PADD 1C (Cent. Atl.)',  note: 'NY/NJ/PA/MD/DC/VA' },
  { code: 'NUS',   label: 'U.S. Average',           note: 'National' },
];

export const PRODUCTS = [
  { code: 'EPMR', label: 'Regular' },
  { code: 'EPMM', label: 'Midgrade' },
  { code: 'EPMP', label: 'Premium' },
];

export async function fetchGasPrices(apiKey = 'DEMO_KEY') {
  let staleCache = null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts < CACHE_TTL) return cached.data;
      staleCache = cached;
    }
  } catch {}

  const areas = REGIONS.map(r => `facets[duoarea][]=${r.code}`).join('&');
  const prods = PRODUCTS.map(p => `facets[product][]=${p.code}`).join('&');
  const url = `${EIA_BASE}?api_key=${apiKey}&frequency=weekly&data[0]=value&${areas}&${prods}&sort[0][column]=period&sort[0][direction]=desc&length=30`;

  let res;
  try {
    // Abort the request if the EIA API is slow/unreachable so callers never hang
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    if (staleCache) return { ...staleCache.data, stale: true };
    throw new Error('Network error — EIA API unreachable');
  }
  if (!res.ok) {
    if (staleCache) return { ...staleCache.data, stale: true };
    if (res.status === 429) throw new Error('Rate limited — EIA API throttled the DEMO_KEY. Try again in a few minutes.');
    throw new Error(`EIA API ${res.status}`);
  }
  const json = await res.json();
  const rows = json.response?.data || [];

  // Build: regionCode → { products: {code → {label,value,period}}, history: [{period,value}] }
  // history = up to 8 most-recent weekly Regular (EPMR) readings, oldest→newest for charting.
  const byRegion = {};
  REGIONS.forEach(r => { byRegion[r.code] = { ...r, products: {}, history: [] }; });

  rows.forEach(row => {
    const r = byRegion[row.duoarea];
    if (!r) return;
    if (!r.products[row.product]) {
      r.products[row.product] = {
        label: PRODUCTS.find(p => p.code === row.product)?.label || row.product,
        value: parseFloat(row.value),
        period: row.period,
      };
    }
    if (row.product === 'EPMR' && r.history.length < 8) {
      r.history.push({ period: row.period, value: parseFloat(row.value) });
    }
  });

  // Reverse each history array so it reads oldest→newest for charting
  REGIONS.forEach(r => { byRegion[r.code].history.reverse(); });

  const period = rows[0]?.period || '';
  const result = { byRegion, period };

  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data: result, ts: Date.now() })); } catch {}
  return result;
}

// Purge cache (call to force a refresh)
export function clearGasCache() {
  localStorage.removeItem(CACHE_KEY);
}
