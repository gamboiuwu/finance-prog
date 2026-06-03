import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { readRange, clearRow } from '../lib/sheets';
import { verifyPin, recordFailedAttempt, getFailedAttempts, MAX_ATTEMPTS } from '../lib/pin';
import LoadingSpinner from '../components/LoadingSpinner';

const ALLOC_SHEET = 'Allocation Transactions';
const BIZ_SHEET   = 'Business Transactions';
const KEYS = [['1','2','3'],['4','5','6'],['7','8','9'],['','0','⌫']];

function parseAmt(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  const neg = s.startsWith('(') || s.startsWith('-');
  const n = parseFloat(s.replace(/[$,\s()]/g, '').replace(/^-/, ''));
  return isNaN(n) ? 0 : neg ? -n : n;
}

function parseDate(s) {
  if (!s) return new Date(0);
  const n = Number(s);
  if (!isNaN(n) && n > 1000 && !String(s).includes('/') && !String(s).includes('-') && !String(s).includes(' ')) {
    // Sheets serial — integer = date, fractional = time-of-day
    const daySerial = Math.floor(n);
    return new Date(Math.round((daySerial - 25569) * 86400000));
  }
  const str = String(s);
  if (str.includes('-') || str.includes('T') || str.includes(' ')) return new Date(str.slice(0, 10) + 'T12:00:00');
  const [m, d, y] = str.split('/');
  if (!y) return new Date(0);
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

function parseDatetime(s) {
  // Returns { date: Date, timeStr: 'HH:MM' | '' }
  if (!s) return { date: new Date(0), timeStr: '' };
  const n = Number(s);
  if (!isNaN(n) && n > 1000 && !String(s).includes('-') && !String(s).includes(' ')) {
    const daySerial = Math.floor(n);
    const timeFrac  = n - daySerial;
    const date = new Date(Math.round((daySerial - 25569) * 86400000));
    if (timeFrac > 0.0005) {
      const totalMins = Math.round(timeFrac * 1440);
      const h = Math.floor(totalMins / 60), m = totalMins % 60;
      const h12 = h % 12 || 12, suf = h >= 12 ? 'PM' : 'AM';
      return { date, timeStr: `${h12}:${String(m).padStart(2,'0')} ${suf}` };
    }
    return { date, timeStr: '' };
  }
  const str = String(s);
  const date = new Date(str.slice(0, 10) + 'T12:00:00');
  const sep  = str[10];
  if (sep === 'T' || sep === ' ') {
    const [hh, mm] = str.slice(11, 16).split(':').map(Number);
    const h12 = hh % 12 || 12, suf = hh >= 12 ? 'PM' : 'AM';
    return { date, timeStr: `${h12}:${String(mm).padStart(2,'0')} ${suf}` };
  }
  return { date, timeStr: '' };
}

function formatDate(s) {
  const { date, timeStr } = parseDatetime(s);
  if (!date || isNaN(date)) return String(s || '—');
  const datePart = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return timeStr ? `${datePart} · ${timeStr}` : datePart;
}

// ── PIN bottom-sheet ──────────────────────────────────────────────────────────

function PinConfirm({ onConfirm, onCancel }) {
  const [digits, setDigits] = useState('');
  const [error,  setError]  = useState('');
  const [busy,   setBusy]   = useState(false);
  const pressRef = useRef(null);

  function press(key) {
    if (busy) return;
    setError('');
    if (key === '⌫') { setDigits(d => d.slice(0, -1)); return; }
    if (digits.length >= 4) return;
    const next = digits + key;
    setDigits(next);
    if (next.length === 4) {
      setBusy(true);
      verifyPin(next).then(ok => {
        if (ok) {
          onConfirm();
        } else {
          const attempts = recordFailedAttempt();
          setDigits('');
          setError(
            getFailedAttempts() >= MAX_ATTEMPTS
              ? 'Too many failed attempts. Try again later.'
              : `Incorrect PIN (${MAX_ATTEMPTS - attempts} left)`
          );
          setBusy(false);
        }
      });
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end z-50">
      <div className="bg-slate-900 w-full rounded-t-3xl p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-bold font-broske">Confirm Delete</h3>
          <button onClick={onCancel} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center">✕</button>
        </div>
        <div className="flex justify-center gap-3" ref={pressRef}>
          {[0,1,2,3].map(i => (
            <div key={i} className={`w-4 h-4 rounded-full border-2 transition-colors ${i < digits.length ? 'bg-white border-white' : 'border-slate-600'}`} />
          ))}
        </div>
        {error && <p className="text-rose-400 text-sm text-center -mt-1">{error}</p>}
        <div className="grid grid-rows-4 gap-2 select-none">
          {KEYS.map((row, ri) => (
            <div key={ri} className="grid grid-cols-3 gap-2">
              {row.map((key, ki) => key === '' ? <div key={ki} /> : (
                <button key={ki} onClick={() => press(key)} disabled={busy}
                  className={`h-14 rounded-2xl text-xl font-semibold transition-all active:scale-95 disabled:opacity-50 ${
                    key === '⌫' ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-800 hover:bg-slate-700 text-white'
                  }`}>
                  {key}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Category detail overlay ───────────────────────────────────────────────────

const CAT_COLORS = {
  'Savings': '#10b981', 'Business': '#22c55e', 'Rent': '#f43f5e',
  'Food': '#f59e0b', 'Transport': '#06b6d4', 'Utilities': '#64748b',
  'Entertainment': '#8b5cf6', 'Personal': '#ec4899', 'Health': '#3b82f6',
  'Income': '#10b981',
};

function catColor(name) {
  return CAT_COLORS[name] || '#94a3b8';
}

function CategoryDetail({ category, items, onClose }) {
  const txns = items.filter(it => it.type === category || (it.source === 'biz' && category === 'Business'));
  const total = txns.reduce((s, t) => s + t.amount, 0);

  // Projection based on historical rate
  const sorted = [...txns].sort((a, b) => a._sortDate - b._sortDate);
  const oldest  = sorted[0]?._sortDate;
  const newest  = sorted[sorted.length - 1]?._sortDate;
  const spanMs  = newest && oldest ? (newest - oldest) : 0;
  const spanDays = Math.max(1, spanMs / 86400000);
  const avgPerDay = total / spanDays;

  const proj = [
    { label: '30 days',  days: 30  },
    { label: '90 days',  days: 90  },
    { label: '6 months', days: 180 },
  ].map(p => ({ ...p, value: avgPerDay * p.days }));

  const isPositive = total >= 0;
  const color = catColor(category);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end">
      <div className="bg-slate-900 w-full rounded-t-3xl max-h-[92dvh] flex flex-col">

        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
            <div>
              <h3 className="text-white font-bold font-broske">{category}</h3>
              <p className="text-slate-400 text-xs mt-0.5">{txns.length} transaction{txns.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center">✕</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4 pb-8">

          {/* Transaction history — shown first so it's immediately visible */}
          <div>
            <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-2 font-broske">Transaction History</p>
            {sorted.length === 0 ? (
              <p className="text-slate-600 text-xs text-center py-4">No transactions found.</p>
            ) : (
              <div className="space-y-1.5">
                {sorted.slice().reverse().map((it, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 bg-slate-800 rounded-xl px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-slate-300 text-xs font-medium truncate">
                        {it.source === 'biz' ? it.product || it.type : it.desc || it.type}
                      </p>
                      <p className="text-slate-600 text-[10px] mt-0.5">{formatDate(it.rawDate || it.date)}</p>
                    </div>
                    <span className={`text-xs font-mono font-bold tabular-nums shrink-0 ${it.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {it.amount >= 0 ? '+' : ''}${Math.abs(it.amount).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Current balance */}
          <div className="bg-slate-800 rounded-2xl p-4 space-y-1">
            <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Current Total</p>
            <p className={`text-3xl font-bold font-mono tabular-nums ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isPositive ? '+' : ''}${Math.abs(total).toFixed(2)}
            </p>
            {spanDays > 1 && (
              <p className="text-slate-500 text-xs">
                Avg ${Math.abs(avgPerDay).toFixed(2)}/day over {Math.round(spanDays)} days
              </p>
            )}
          </div>

          {/* Projections */}
          <div>
            <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-2 font-broske">Projected (based on current rate)</p>
            <div className="grid grid-cols-3 gap-2">
              {proj.map(p => (
                <div key={p.label} className="bg-slate-800 rounded-xl p-3 text-center">
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">{p.label}</p>
                  <p className={`text-sm font-bold font-mono tabular-nums mt-1 ${p.value >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {p.value >= 0 ? '+' : ''}${Math.abs(p.value).toFixed(2)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const FILTERS = ['All', 'Income', 'Expenses', 'Business', 'Categories'];

export default function Actions({ token }) {
  const [items,       setItems]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [filter,      setFilter]      = useState('All');
  const [pendingDel,  setPendingDel]  = useState(null);
  const [deleting,    setDeleting]    = useState(null);
  const [showPin,     setShowPin]     = useState(false);
  const [detailCat,   setDetailCat]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allocRows, bizRows] = await Promise.all([
        readRange(token, `${ALLOC_SHEET}!A:F`, 'UNFORMATTED_VALUE').catch(() => []),
        readRange(token, `${BIZ_SHEET}!A:H`,   'UNFORMATTED_VALUE').catch(() => []),
      ]);

      const alloc = (allocRows.length > 1 ? allocRows.slice(1) : [])
        .map((r, idx) => {
          if (!r[0] && !r[1]) return null;
          const { date, timeStr } = parseDatetime(r[0]);
          return {
            id:      `alloc_${idx + 2}`,
            source:  'alloc',
            _sheet:  ALLOC_SHEET,
            _rowNum: idx + 2,
            rawDate: r[0],
            date:    date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + (timeStr ? ` · ${timeStr}` : ''),
            type:    r[1] || '—',
            amount:  parseAmt(r[2]),
            desc:    r[3] || '',
            account: r[4] || '',
            done:    r[5] === true || r[5] === 'TRUE' || r[5] === 1,
            _sortDate: date,
          };
        })
        .filter(Boolean);

      // Detect v1 (no Client col) vs v2 (Client in col B) for Business Transactions
      const bizHasHeader = String(bizRows[0]?.[0] || '').toLowerCase() === 'date';
      const bizIsV2      = bizHasHeader && String(bizRows[0]?.[1] || '').toLowerCase() === 'client';
      const bizData      = bizHasHeader ? bizRows.slice(1) : bizRows;

      const biz = bizData
        .map((r, idx) => {
          if (!r[0] && !r[1] && !r[2]) return null;
          let allocs = {};
          const allocIdx = bizIsV2 ? 7 : 6;
          try { allocs = JSON.parse(r[allocIdx] || '{}'); } catch { allocs = {}; }
          const { date, timeStr } = parseDatetime(r[0]);
          return {
            id:        `biz_${idx + (bizHasHeader ? 2 : 1)}`,
            source:    'biz',
            _sheet:    BIZ_SHEET,
            _rowNum:   idx + (bizHasHeader ? 2 : 1),
            rawDate:   r[0],
            date:      date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + (timeStr ? ` · ${timeStr}` : ''),
            client:    bizIsV2 ? (r[1] || '') : '',
            product:   bizIsV2 ? (r[2] || '') : (r[1] || ''),
            type:      'Business',
            qty:       bizIsV2 ? (r[3] || '') : (r[2] || ''),
            unitPrice: parseAmt(bizIsV2 ? r[4] : r[3]),
            amount:    parseAmt(bizIsV2 ? r[5] : r[4]),
            margin:    (bizIsV2 ? r[6] : r[5]) || '',
            allocs,
            _sortDate: date,
          };
        })
        .filter(Boolean);

      setItems([...alloc, ...biz].sort((a, b) => b._sortDate - a._sortDate));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  function requestDelete(item) { setPendingDel(item); setShowPin(true); }
  async function confirmDelete() {
    setShowPin(false);
    if (!pendingDel) return;
    const item = pendingDel;
    setPendingDel(null);
    setDeleting(item.id);
    try {
      const cols = item.source === 'biz' ? 'H' : 'F';
      await clearRow(token, `${item._sheet}!A${item._rowNum}:${cols}${item._rowNum}`);
      setItems(prev => prev.filter(i => i.id !== item.id));
    } catch (e) {
      alert(`Error deleting: ${e.message}`);
    } finally {
      setDeleting(null);
    }
  }

  const filtered = useMemo(() => {
    if (filter === 'Income')     return items.filter(i => i.source === 'alloc' && i.amount > 0);
    if (filter === 'Expenses')   return items.filter(i => i.source === 'alloc' && i.amount < 0);
    if (filter === 'Business')   return items.filter(i => i.source === 'biz');
    if (filter === 'Categories') return items; // handled separately
    return items;
  }, [items, filter]);

  // Derive categories dynamically from actual data
  const categories = useMemo(() => {
    const catMap = {};
    items.forEach(it => {
      const key = it.type || '—';
      if (!catMap[key]) catMap[key] = { type: key, items: [], total: 0 };
      catMap[key].items.push(it);
      catMap[key].total += it.amount;
    });
    return Object.values(catMap).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }, [items]);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="pb-24">
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-white font-broske">Action History</h1>
        <p className="text-slate-500 text-xs mt-0.5">All logged actions · PIN required to delete</p>
      </div>

      {/* Filter tabs */}
      <div className="px-4 mb-3">
        <div className="flex bg-slate-800 rounded-xl p-1 gap-0.5 overflow-x-auto">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap px-2 ${
                filter === f ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-300'
              }`}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-4 bg-red-900/30 border border-red-700/50 rounded-xl p-4 text-red-400 text-sm space-y-2 mb-3">
          <p className="font-medium">Error loading history</p>
          <p className="text-xs text-red-500">{error}</p>
          <button onClick={load} className="text-blue-400 underline text-xs">Retry</button>
        </div>
      )}

      {/* Categories view */}
      {filter === 'Categories' && (
        <div className="stagger px-4 space-y-2">
          {categories.length === 0 && (
            <div className="bg-slate-900 rounded-2xl p-8 text-center">
              <p className="text-slate-500 text-sm">No transactions yet</p>
            </div>
          )}
          {categories.map(cat => {
            const color   = catColor(cat.type);
            const isPos   = cat.total >= 0;
            const sorted  = [...cat.items].sort((a, b) => a._sortDate - b._sortDate);
            const spanMs  = sorted.length > 1 ? (sorted[sorted.length-1]._sortDate - sorted[0]._sortDate) : 0;
            const spanDays = Math.max(1, spanMs / 86400000);
            const avgPerDay = cat.total / spanDays;
            return (
              <button key={cat.type} onClick={() => setDetailCat(cat.type)}
                className="w-full bg-slate-800 rounded-2xl p-4 text-left space-y-3 hover:bg-slate-700 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                    <div className="min-w-0">
                      <p className="text-white font-semibold text-sm truncate">{cat.type}</p>
                      <p className="text-slate-500 text-xs">{cat.items.length} transaction{cat.items.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-base font-bold font-mono tabular-nums ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isPos ? '+' : ''}${Math.abs(cat.total).toFixed(2)}
                    </p>
                    <p className="text-slate-600 text-[10px] font-mono">{isPos ? '+' : ''}${Math.abs(avgPerDay).toFixed(2)}/day</p>
                  </div>
                </div>
                {/* Projections mini-row */}
                <div className="grid grid-cols-3 gap-2">
                  {[['30d', 30], ['90d', 90], ['6mo', 180]].map(([lbl, days]) => {
                    const val = avgPerDay * days;
                    return (
                      <div key={lbl} className="bg-slate-700/60 rounded-lg px-2 py-1.5 text-center">
                        <p className="text-slate-500 text-[9px] uppercase tracking-wider">{lbl}</p>
                        <p className={`text-xs font-bold font-mono tabular-nums ${val >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {val >= 0 ? '+' : ''}${Math.abs(val).toFixed(0)}
                        </p>
                      </div>
                    );
                  })}
                </div>
                <p className="text-slate-600 text-[10px]">Tap for full breakdown →</p>
              </button>
            );
          })}
        </div>
      )}

      {/* List view (all tabs except Categories) */}
      {filter !== 'Categories' && (
        <>
          {filtered.length === 0 && !error && (
            <div className="mx-4 bg-slate-900 rounded-2xl p-8 text-center">
              <p className="text-slate-500 text-sm">No actions found</p>
            </div>
          )}
          <div className="stagger px-4 space-y-2">
            {filtered.map(item => (
              <ActionCard
                key={item.id}
                item={item}
                deleting={deleting === item.id}
                onDelete={() => requestDelete(item)}
                onCategoryTap={cat => { setFilter('Categories'); setDetailCat(cat); }}
              />
            ))}
          </div>
        </>
      )}

      {showPin && (
        <PinConfirm onConfirm={confirmDelete} onCancel={() => { setShowPin(false); setPendingDel(null); }} />
      )}

      {detailCat && (
        <CategoryDetail
          category={detailCat}
          items={items}
          onClose={() => setDetailCat(null)}
        />
      )}
    </div>
  );
}

function ActionCard({ item, deleting, onDelete, onCategoryTap }) {
  const [expanded, setExpanded] = useState(false);

  if (item.source === 'alloc') {
    const isCredit = item.amount > 0;
    const amtColor = isCredit ? 'text-emerald-400' : 'text-rose-400';
    const typeBg   = item.done ? 'bg-emerald-900/40 text-emerald-300' : 'bg-slate-700/60 text-slate-400';
    const color    = catColor(item.type);

    return (
      <div className={`bg-slate-800 rounded-2xl overflow-hidden transition-opacity ${deleting ? 'opacity-40 pointer-events-none' : ''}`}>
        <button className="w-full px-4 py-3 flex items-center gap-3 text-left" onClick={() => setExpanded(e => !e)}>
          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-white text-sm font-medium truncate">{item.type}</p>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${typeBg}`}>
                {item.done ? 'Processed' : 'Pending'}
              </span>
            </div>
            <p className="text-slate-500 text-xs mt-0.5">
              {item.date}{item.account ? ` · ${item.account}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`font-mono font-bold text-sm tabular-nums ${amtColor}`}>
              {isCredit ? '+' : ''}${Math.abs(item.amount).toFixed(2)}
            </span>
            <button onClick={e => { e.stopPropagation(); onDelete(); }} disabled={deleting}
              className="w-7 h-7 rounded-lg bg-slate-700 hover:bg-rose-900/60 text-slate-500 hover:text-rose-400 flex items-center justify-center transition-colors text-xs">
              {deleting ? '…' : '✕'}
            </button>
          </div>
        </button>
        {expanded && (
          <div className="border-t border-slate-700/60 px-4 pb-3 pt-2 space-y-2">
            {item.desc && <p className="text-slate-400 text-xs leading-relaxed">{item.desc}</p>}
            <button onClick={() => onCategoryTap?.(item.type)}
              className="text-teal-400 text-xs hover:underline">
              View all "{item.type}" transactions →
            </button>
          </div>
        )}
      </div>
    );
  }

  // Business transaction
  return (
    <div className={`bg-slate-800 rounded-2xl overflow-hidden transition-opacity ${deleting ? 'opacity-40 pointer-events-none' : ''}`}>
      <button className="w-full px-4 py-3 flex items-center gap-3 text-left" onClick={() => setExpanded(e => !e)}>
        <div className="w-2 h-2 rounded-full shrink-0 bg-green-400" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-white text-sm font-medium truncate">{item.product || item.type}</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-300">Business</span>
            {item.qty && <span className="text-[10px] text-slate-500">×{item.qty}</span>}
          </div>
          <p className="text-slate-500 text-xs mt-0.5">
            {item.date}
            {item.client ? ` · ${item.client}` : ''}
            {item.margin ? ` · ${item.margin} margin` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="font-mono font-bold text-sm tabular-nums text-green-400">
            +${item.amount.toFixed(2)}
          </span>
          <button onClick={e => { e.stopPropagation(); onDelete(); }} disabled={deleting}
            className="w-7 h-7 rounded-lg bg-slate-700 hover:bg-rose-900/60 text-slate-500 hover:text-rose-400 flex items-center justify-center transition-colors text-xs">
            {deleting ? '…' : '✕'}
          </button>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-slate-700/60 px-4 pb-3 pt-2 space-y-2">
          {Object.keys(item.allocs).length > 0 && (
            <>
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Allocations</p>
              <div className="space-y-1">
                {Object.entries(item.allocs).map(([cat, amt]) => (
                  <div key={cat} className="flex justify-between text-xs">
                    <span className="text-slate-300">{cat}</span>
                    <span className="text-slate-400 font-mono">${parseFloat(amt).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <button onClick={() => onCategoryTap?.('Business')}
            className="text-teal-400 text-xs hover:underline">
            View all Business transactions →
          </button>
        </div>
      )}
    </div>
  );
}
