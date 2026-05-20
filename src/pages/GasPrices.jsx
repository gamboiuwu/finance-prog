import { useEffect, useState } from 'react';
import { fetchGasPrices, clearGasCache, REGIONS, PRODUCTS } from '../lib/gasPrice';
import LoadingSpinner from '../components/LoadingSpinner';

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
  if (error) return <div className="p-4 text-red-400">Failed to load gas prices: {error}</div>;

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
    <div className="p-4 pb-24 space-y-4">
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

      {/* Range indicator */}
      <div className="bg-slate-800 rounded-2xl p-4">
        <p className="text-slate-300 text-sm font-medium mb-3 font-broske">Regular Grade — Regional Range</p>
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
        <div className="flex justify-between text-xs text-slate-500 mt-1">
          <span>Lowest region</span>
          <span>Highest region</span>
        </div>
      </div>

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
