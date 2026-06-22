import { useEffect, useState } from 'react';
import { fetchGasPrices, clearGasCache, REGIONS, PRODUCTS } from '../lib/gasPrice';
import { getGasBudget, daysInCurrentMonth, GAS_MILES_PER_DAY, DEFAULT_MPG } from '../lib/gasBudget';
import LoadingSpinner from '../components/LoadingSpinner';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const PRODUCT_COLORS = {
  EPMR: { label: 'Regular',   color: 'text-emerald-400', bg: 'bg-emerald-900/30', bar: '#10b981' },
  EPMM: { label: 'Midgrade',  color: 'text-amber-400',   bg: 'bg-amber-900/30',   bar: '#f59e0b' },
  EPMP: { label: 'Premium',   color: 'text-rose-400',    bg: 'bg-rose-900/30',    bar: '#f43f5e' },
};

function fmt(n) { return n ? `$${Number(n).toFixed(3)}` : '—'; }

function PriceBar({ value, max }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden mt-1">
      <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Gas Budget Adequacy Check (Task 72) ──────────────────────────────────────
// Answers the user's direct request: "is my gas budget enough for how much I
// drive, and how many gallons does it get me?" Self-contained on the Gas screen —
// it reads the live $/gal here plus the mpg/budget the Summary/Dashboard already
// cached via gasBudget.js (getGasBudget). The user can override both the monthly
// budget $ and the miles they drive; both stay on-device (localStorage), never the
// sheet or GitHub. Same formula as computeGasBudget so the figures reconcile.
//
//   gallons the budget buys = budget ÷ $/gal
//   miles it covers         = gallons × mpg
//   gallons needed          = milesDriven ÷ mpg
//   cost needed (true cost)  = gallonsNeeded × $/gal
//   shortfall               = costNeeded − budget   (+ = add this to the gas line)
const GAS_MILES_KEY = '_fin_gas_miles';      // user's monthly miles (no $)
const GAS_BUDGET_KEY = '_fin_gas_budget_amt'; // user's monthly gas budget $

function readGasNum(key) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

function GasCoverageCard({ livePrice }) {
  const cached = getGasBudget();
  const price = (livePrice && livePrice > 0) ? livePrice : (cached?.gasPerGal || 4.09);
  const mpg = (cached?.mpg && cached.mpg > 0) ? cached.mpg : DEFAULT_MPG;
  const dim = daysInCurrentMonth();
  const defaultMiles = Math.round(GAS_MILES_PER_DAY * dim);
  const defaultBudget = (cached?.value && cached.value > 0)
    ? Math.round(cached.value)
    : Math.round((defaultMiles / mpg) * price);

  const [editing, setEditing] = useState(false);
  const [miles, setMiles] = useState(() => readGasNum(GAS_MILES_KEY) ?? defaultMiles);
  const [budget, setBudget] = useState(() => readGasNum(GAS_BUDGET_KEY) ?? defaultBudget);

  const gallonsBudgetBuys = price > 0 ? budget / price : 0;
  const milesCovered = gallonsBudgetBuys * mpg;
  const gallonsNeeded = mpg > 0 ? miles / mpg : 0;
  const costNeeded = gallonsNeeded * price;
  const shortfall = costNeeded - budget;          // positive ⇒ budget too small
  const tolerance = Math.max(2, budget * 0.02);   // small grace so $1–2 rounding ≠ "short"
  const enough = shortfall <= tolerance;

  function save() {
    try {
      if (miles > 0) localStorage.setItem(GAS_MILES_KEY, String(miles));
      else localStorage.removeItem(GAS_MILES_KEY);
      if (budget > 0) localStorage.setItem(GAS_BUDGET_KEY, String(budget));
      else localStorage.removeItem(GAS_BUDGET_KEY);
    } catch {}
    setEditing(false);
  }

  const accent = enough
    ? { ring: 'border-emerald-700/40', chipBg: 'bg-emerald-900/40', chipTx: 'text-emerald-300' }
    : { ring: 'border-amber-700/40',   chipBg: 'bg-amber-900/40',   chipTx: 'text-amber-300' };

  return (
    <div className={`bg-slate-800 rounded-2xl p-4 space-y-3 border ${accent.ring}`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-slate-300 text-sm font-medium">⛽ Gas Budget Coverage</p>
          <p className="text-slate-500 text-xs mt-0.5">
            at {fmt(price)}/gal · {mpg} mpg{cached?.mpg ? '' : ' (default)'}
          </p>
        </div>
        <button
          onClick={() => setEditing(v => !v)}
          className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 px-2.5 py-1 rounded-lg transition-colors"
        >
          {editing ? '✕ Close' : '✏ Edit'}
        </button>
      </div>

      {/* Verdict chip */}
      <div className={`rounded-xl px-3 py-2.5 ${accent.chipBg}`}>
        <p className={`text-sm font-semibold ${accent.chipTx}`}>
          {enough
            ? `✅ Enough — covers ~${Math.round(milesCovered)} mi/mo`
            : `⚠ Short ~$${shortfall.toFixed(0)}/mo`}
        </p>
        <p className="text-slate-400 text-xs mt-1">
          {enough
            ? `Your $${budget.toFixed(0)} buys ~${gallonsBudgetBuys.toFixed(1)} gal (~${Math.round(milesCovered)} mi), and you drive ~${miles} mi/mo.`
            : `Your $${budget.toFixed(0)} buys ~${gallonsBudgetBuys.toFixed(1)} gal — only ~${Math.round(milesCovered)} mi of the ~${miles} mi/mo you drive. Add ~$${shortfall.toFixed(0)} to your monthly gas expenses to cover it.`}
        </p>
      </div>

      {/* Key figures */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-slate-900/60 rounded-lg p-2">
          <p className="text-slate-500 text-[10px] uppercase tracking-wider">Gallons</p>
          <p className="text-white text-sm font-bold">{gallonsBudgetBuys.toFixed(1)}</p>
        </div>
        <div className="bg-slate-900/60 rounded-lg p-2">
          <p className="text-slate-500 text-[10px] uppercase tracking-wider">Covers</p>
          <p className="text-white text-sm font-bold">{Math.round(milesCovered)} mi</p>
        </div>
        <div className="bg-slate-900/60 rounded-lg p-2">
          <p className="text-slate-500 text-[10px] uppercase tracking-wider">True cost</p>
          <p className={`text-sm font-bold ${enough ? 'text-emerald-400' : 'text-amber-400'}`}>${costNeeded.toFixed(0)}</p>
        </div>
      </div>

      {/* Editor */}
      {editing && (
        <div className="space-y-3 pt-1">
          <div>
            <label className="text-slate-400 text-xs">Monthly gas budget ($)</label>
            <input
              type="number" inputMode="decimal" min="0"
              value={budget}
              onChange={e => setBudget(parseFloat(e.target.value) || 0)}
              className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-slate-400 text-xs">Miles you drive per month</label>
            <input
              type="number" inputMode="decimal" min="0"
              value={miles}
              onChange={e => setMiles(parseFloat(e.target.value) || 0)}
              className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            />
            <p className="text-slate-600 text-[11px] mt-1">Default ≈ {defaultMiles} mi ({GAS_MILES_PER_DAY} mi/day × {dim} days)</p>
          </div>
          <button
            onClick={save}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 rounded-lg transition-colors"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

export default function GasPrices() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load(forceRefresh = false) {
    try {
      if (forceRefresh) { clearGasCache(); setRefreshing(true); }
      else setLoading(true);
      const result = await fetchGasPrices();
      setData(result);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return (
    <div className="p-4 space-y-3">
      <div className="bg-red-900/30 border border-red-700/40 rounded-xl p-4 text-sm text-red-300">
        <p className="font-semibold mb-1">Could not load gas prices</p>
        <p className="text-red-400/80">{error}</p>
      </div>
      <button
        onClick={() => load()}
        className="w-full bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm py-2.5 rounded-xl transition-colors"
      >
        ↻ Retry
      </button>
    </div>
  );

  // Find global max for bar scaling
  let globalMax = 0;
  Object.values(data.byRegion).forEach(r =>
    Object.values(r.products).forEach(p => { if (p.value > globalMax) globalMax = p.value; })
  );

  // Best Regular price across all regions
  const regularPrices = Object.values(data.byRegion)
    .map(r => r.products['EPMR']?.value)
    .filter(Boolean);
  const lowestRegular = Math.min(...regularPrices);
  const highestRegular = Math.max(...regularPrices);

  const formatDate = (d) => {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="stagger p-4 pb-24 space-y-4">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-white">Gas Prices</h1>
          <p className="text-slate-400 text-sm">NYC & Long Island region</p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {refreshing ? '⟳' : '↻ Refresh'}
        </button>
      </div>

      {/* Stale data warning */}
      {data.stale && (
        <div className="bg-amber-900/30 border border-amber-700/40 rounded-xl px-4 py-2.5 text-xs text-amber-300">
          EIA API unavailable — showing cached data. Tap Refresh to retry.
        </div>
      )}

      {/* Data freshness */}
      <div className="bg-slate-800/60 rounded-xl px-4 py-2.5 flex justify-between items-center text-xs">
        <span className="text-slate-400">EIA weekly data — published every Monday</span>
        <span className="text-slate-300 font-medium">{formatDate(data.period)}</span>
      </div>

      {/* Quick summary — NYC + NY State Regular */}
      <div className="grid grid-cols-2 gap-3">
        {['Y35NY', 'SNY'].map(code => {
          const region = data.byRegion[code];
          const reg = region?.products['EPMR'];
          return (
            <div key={code} className="bg-slate-800 rounded-2xl p-4">
              <p className="text-slate-400 text-xs uppercase tracking-wider">{region?.label}</p>
              <p className="text-2xl font-bold text-white mt-1">{fmt(reg?.value)}</p>
              <p className="text-slate-500 text-xs mt-0.5">Regular · /gal</p>
              <p className="text-slate-600 text-xs mt-1">{region?.note}</p>
            </div>
          );
        })}
      </div>

      {/* Gas Budget Adequacy Check (Task 72) */}
      <GasCoverageCard livePrice={data.byRegion['Y35NY']?.products['EPMR']?.value || lowestRegular} />

      {/* Range indicator + history chart */}
      {(() => {
        // Build a per-week min/max across all regions that have history data.
        const byWeek = {};
        REGIONS.forEach(rd => {
          (data.byRegion[rd.code]?.history || []).forEach(h => {
            if (!byWeek[h.period]) byWeek[h.period] = [];
            byWeek[h.period].push(h.value);
          });
        });
        const rangeHistory = Object.keys(byWeek).sort().map(period => ({
          week:  period.slice(5).replace('-', '/'),
          low:   Math.min(...byWeek[period]),
          high:  Math.max(...byWeek[period]),
        }));
        const hasHistory = rangeHistory.length >= 2;

        return (
          <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
            <p className="text-slate-300 text-sm font-medium font-broske">Regular Grade — Regional Range</p>
            {/* Static current-week range bar */}
            <div className="flex items-center gap-3">
              <span className="text-emerald-400 text-sm font-bold">{fmt(lowestRegular)}</span>
              <div className="flex-1 bg-slate-700 rounded-full h-3 overflow-hidden relative">
                <div className="h-3 rounded-full" style={{
                  marginLeft: `${((lowestRegular - lowestRegular * 0.98) / (highestRegular * 1.02 - lowestRegular * 0.98)) * 100}%`,
                  width: `${((highestRegular - lowestRegular) / (highestRegular * 1.02 - lowestRegular * 0.98)) * 100}%`,
                  background: 'linear-gradient(to right, #10b981, #f43f5e)',
                }} />
              </div>
              <span className="text-rose-400 text-sm font-bold">{fmt(highestRegular)}</span>
            </div>
            <div className="flex justify-between text-xs text-slate-500">
              <span>Lowest region</span>
              <span>Highest region</span>
            </div>
            {/* Weekly history chart */}
            {hasHistory && (
              <>
                <p className="text-slate-500 text-[10px] uppercase tracking-wider pt-1">Regional range — past weeks</p>
                <ResponsiveContainer width="100%" height={110}>
                  <BarChart data={rangeHistory} barCategoryGap="18%">
                    <XAxis dataKey="week" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={v => `$${v.toFixed(2)}`} width={38} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontSize: 11 }}
                      formatter={(v, name) => [`$${Number(v).toFixed(3)}`, name === 'low' ? 'Lowest region' : 'Highest region']}
                    />
                    <Bar dataKey="low"  fill="#10b981" radius={[3, 3, 0, 0]} name="low" />
                    <Bar dataKey="high" fill="#f43f5e" radius={[3, 3, 0, 0]} name="high" />
                  </BarChart>
                </ResponsiveContainer>
                <div className="flex gap-4 text-[10px] text-slate-500">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" /> Lowest region</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-rose-500 inline-block" /> Highest region</span>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Full regional breakdown */}
      {REGIONS.map(regionDef => {
        const region = data.byRegion[regionDef.code];
        if (!region) return null;
        const hasData = Object.keys(region.products).length > 0;
        if (!hasData) return null;

        return (
          <div key={regionDef.code} className="bg-slate-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 flex justify-between items-center">
              <div>
                <p className="text-white font-semibold text-sm">{region.label}</p>
                <p className="text-slate-500 text-xs">{region.note}</p>
              </div>
              <span className="text-xs bg-slate-700 text-slate-400 px-2 py-0.5 rounded">{regionDef.code}</span>
            </div>

            <div className="divide-y divide-slate-700/50">
              {PRODUCTS.map(prod => {
                const price = region.products[prod.code];
                if (!price) return null;
                const style = PRODUCT_COLORS[prod.code];
                return (
                  <div key={prod.code} className="px-4 py-3">
                    <div className="flex justify-between items-center">
                      <span className={`text-sm font-medium ${style.color}`}>{prod.label}</span>
                      <span className="text-white font-bold">{fmt(price.value)}</span>
                    </div>
                    <PriceBar value={price.value} max={globalMax} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Regular price history — NYC (best proxy for LI) */}
      {(() => {
        const hist = data.byRegion['Y35NY']?.history || [];
        if (hist.length < 2) return null;
        const chartData = hist.map(h => ({
          week: h.period.slice(5).replace('-', '/'),
          price: h.value,
        }));
        return (
          <div className="bg-slate-800 rounded-2xl p-4">
            <p className="text-slate-300 text-sm font-medium mb-3 font-broske">NYC Regular — Price History</p>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={chartData} barCategoryGap="20%">
                <XAxis dataKey="week" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={v => `$${v.toFixed(2)}`} width={38} />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontSize: 11 }}
                  formatter={v => [`$${Number(v).toFixed(3)}`, 'Regular']}
                />
                <Bar dataKey="price" fill="#10b981" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      })()}

      {/* Long Island note */}
      <div className="bg-amber-900/20 border border-amber-800/40 rounded-xl p-4 text-xs text-amber-300 space-y-1">
        <p className="font-semibold">📍 About Long Island prices</p>
        <p className="text-amber-400/80">
          The EIA does not publish a separate Long Island price series.
          <strong> New York City</strong> and <strong>New York State</strong> averages are the best available proxies.
          Long Island pump prices typically track within $0.05–$0.15 of the NYC figure.
        </p>
      </div>

      {/* Source */}
      <p className="text-slate-600 text-xs text-center pb-2">
        Source: U.S. Energy Information Administration (EIA) · Updated weekly every Monday
      </p>
    </div>
  );
}
