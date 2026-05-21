import { useState, useEffect, useCallback, useRef } from 'react';
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
  // Google Sheets date serial (UNFORMATTED_VALUE returns numbers for date cells)
  if (!isNaN(n) && n > 1000 && !String(s).includes('/')) {
    return new Date(Math.round((n - 25569) * 86400000));
  }
  if (String(s).includes('-')) return new Date(s + 'T12:00:00');
  const [m, d, y] = String(s).split('/');
  if (!y) return new Date(0);
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

function formatDate(s) {
  const d = parseDate(s);
  if (!d || isNaN(d)) return String(s);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Inline PIN confirmation bottom-sheet ─────────────────────────────────────

function PinConfirm({ onConfirm, onCancel }) {
  const [digits,  setDigits]  = useState('');
  const [error,   setError]   = useState('');
  const [busy,    setBusy]    = useState(false);
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
            attempts >= MAX_ATTEMPTS
              ? 'Too many failed attempts'
              : `Wrong PIN — ${MAX_ATTEMPTS - attempts} attempt${MAX_ATTEMPTS - attempts === 1 ? '' : 's'} left`
          );
          setBusy(false);
        }
      });
    }
  }

  pressRef.current = press;
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key))    pressRef.current(e.key);
      else if (e.key === 'Backspace') pressRef.current('⌫');
      else if (e.key === 'Escape')    onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end">
      <div className="bg-slate-900 w-full rounded-t-3xl px-6 pt-5 pb-8 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold font-broske">Confirm with PIN</h3>
            <p className="text-slate-400 text-xs mt-0.5">Required to modify or delete actions</p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-white text-sm px-3 py-1.5 rounded-lg bg-slate-800 transition-colors">Cancel</button>
        </div>

        <div className="flex gap-4 justify-center py-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`w-3.5 h-3.5 rounded-full border-2 transition-all duration-150 ${
              error ? 'border-rose-500 bg-rose-500' :
              i < digits.length ? 'border-blue-400 bg-blue-400' : 'border-slate-600 bg-transparent'
            }`} />
          ))}
        </div>
        {error && <p className="text-rose-400 text-sm text-center -mt-1">{error}</p>}

        <div className="grid grid-rows-4 gap-2 select-none">
          {KEYS.map((row, ri) => (
            <div key={ri} className="grid grid-cols-3 gap-2">
              {row.map((key, ki) => key === '' ? <div key={ki} /> : (
                <button
                  key={ki}
                  onClick={() => press(key)}
                  disabled={busy}
                  className={`h-14 rounded-2xl text-xl font-semibold transition-all active:scale-95 disabled:opacity-50 ${
                    key === '⌫'
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                      : 'bg-slate-800 hover:bg-slate-700 text-white'
                  }`}
                >
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

// ── Main page ─────────────────────────────────────────────────────────────────

const FILTERS = ['All', 'Income', 'Expenses', 'Business'];

export default function Actions({ token }) {
  const [items,       setItems]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [filter,      setFilter]      = useState('All');
  const [pendingDel,  setPendingDel]  = useState(null); // item to delete after PIN
  const [deleting,    setDeleting]    = useState(null); // id being deleted
  const [showPin,     setShowPin]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allocRows, bizRows] = await Promise.all([
        readRange(token, `${ALLOC_SHEET}!A:F`, 'UNFORMATTED_VALUE').catch(() => []),
        readRange(token, `${BIZ_SHEET}!A:G`,   'UNFORMATTED_VALUE').catch(() => []),
      ]);

      const alloc = (allocRows.length > 1 ? allocRows.slice(1) : [])
        .map((r, idx) => {
          if (!r[0] && !r[1]) return null;
          return {
            id:      `alloc_${idx + 2}`,
            source:  'alloc',
            _sheet:  ALLOC_SHEET,
            _rowNum: idx + 2,
            date:    r[0] || '',
            type:    r[1] || '—',
            amount:  parseAmt(r[2]),
            desc:    r[3] || '',
            account: r[4] || '',
            done:    r[5] === true || r[5] === 'TRUE' || r[5] === 1,
            _sortDate: parseDate(r[0]),
          };
        })
        .filter(Boolean);

      const biz = (bizRows.length > 1 ? bizRows.slice(1) : [])
        .map((r, idx) => {
          if (!r[0] && !r[1]) return null;
          let allocs = {};
          try { allocs = JSON.parse(r[6] || '{}'); } catch { allocs = {}; }
          return {
            id:      `biz_${idx + 2}`,
            source:  'biz',
            _sheet:  BIZ_SHEET,
            _rowNum: idx + 2,
            date:    r[0] || '',
            type:    r[1] || '—',
            qty:     r[2] || '',
            unitPrice: parseAmt(r[3]),
            amount:  parseAmt(r[4]),
            margin:  r[5] || '',
            allocs,
            _sortDate: parseDate(r[0]),
          };
        })
        .filter(Boolean);

      const merged = [...alloc, ...biz]
        .sort((a, b) => b._sortDate - a._sortDate);

      setItems(merged);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  function requestDelete(item) {
    setPendingDel(item);
    setShowPin(true);
  }

  async function confirmDelete() {
    setShowPin(false);
    if (!pendingDel) return;
    const item = pendingDel;
    setPendingDel(null);
    setDeleting(item.id);
    try {
      const cols = item.source === 'biz' ? 'G' : 'F';
      await clearRow(token, `${item._sheet}!A${item._rowNum}:${cols}${item._rowNum}`);
      setItems(prev => prev.filter(i => i.id !== item.id));
    } catch (e) {
      alert(`Error deleting: ${e.message}`);
    } finally {
      setDeleting(null);
    }
  }

  const filtered = items.filter(item => {
    if (filter === 'Income')   return item.source === 'alloc' && item.amount > 0;
    if (filter === 'Expenses') return item.source === 'alloc' && item.amount < 0;
    if (filter === 'Business') return item.source === 'biz';
    return true;
  });

  if (loading) return <LoadingSpinner />;

  return (
    <div className="pb-24">
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-white font-broske">Action History</h1>
        <p className="text-slate-500 text-xs mt-0.5">All logged actions · PIN required to delete</p>
      </div>

      {/* Filter tabs */}
      <div className="px-4 mb-3">
        <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === f ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-300'
              }`}
            >
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

      {filtered.length === 0 && !error && (
        <div className="mx-4 bg-slate-900 rounded-2xl p-8 text-center">
          <p className="text-slate-500 text-sm">No actions found</p>
        </div>
      )}

      <div className="px-4 space-y-2">
        {filtered.map(item => (
          <ActionCard
            key={item.id}
            item={item}
            deleting={deleting === item.id}
            onDelete={() => requestDelete(item)}
          />
        ))}
      </div>

      {showPin && (
        <PinConfirm
          onConfirm={confirmDelete}
          onCancel={() => { setShowPin(false); setPendingDel(null); }}
        />
      )}
    </div>
  );
}

function ActionCard({ item, deleting, onDelete }) {
  const [expanded, setExpanded] = useState(false);

  if (item.source === 'alloc') {
    const isCredit = item.amount > 0;
    const amtColor = isCredit ? 'text-emerald-400' : 'text-rose-400';
    const typeBg   = item.done
      ? 'bg-emerald-900/40 text-emerald-300'
      : 'bg-slate-700/60 text-slate-400';

    return (
      <div className={`bg-slate-800 rounded-2xl overflow-hidden transition-opacity ${deleting ? 'opacity-40 pointer-events-none' : ''}`}>
        <button
          className="w-full px-4 py-3 flex items-center gap-3 text-left"
          onClick={() => setExpanded(e => !e)}
        >
          <div className={`w-2 h-2 rounded-full shrink-0 ${isCredit ? 'bg-emerald-400' : 'bg-rose-400'}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-white text-sm font-medium truncate">{item.type}</p>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${typeBg}`}>
                {item.done ? 'Processed' : 'Pending'}
              </span>
            </div>
            <p className="text-slate-500 text-xs mt-0.5">
              {formatDate(item.date)}{item.account ? ` · ${item.account}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`font-mono font-bold text-sm tabular-nums ${amtColor}`}>
              {isCredit ? '+' : ''}${Math.abs(item.amount).toFixed(2)}
            </span>
            <button
              onClick={e => { e.stopPropagation(); onDelete(); }}
              disabled={deleting}
              className="w-7 h-7 rounded-lg bg-slate-700 hover:bg-rose-900/60 text-slate-500 hover:text-rose-400 flex items-center justify-center transition-colors text-xs"
            >
              {deleting ? '…' : '✕'}
            </button>
          </div>
        </button>
        {expanded && item.desc && (
          <div className="px-4 pb-3 pt-0 border-t border-slate-700/60">
            <p className="text-slate-400 text-xs leading-relaxed">{item.desc}</p>
          </div>
        )}
      </div>
    );
  }

  // Business transaction
  return (
    <div className={`bg-slate-800 rounded-2xl overflow-hidden transition-opacity ${deleting ? 'opacity-40 pointer-events-none' : ''}`}>
      <button
        className="w-full px-4 py-3 flex items-center gap-3 text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="w-2 h-2 rounded-full shrink-0 bg-green-400" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-white text-sm font-medium truncate">{item.type}</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-300">Business</span>
            {item.qty && <span className="text-[10px] text-slate-500">×{item.qty}</span>}
          </div>
          <p className="text-slate-500 text-xs mt-0.5">
            {formatDate(item.date)}{item.margin ? ` · ${item.margin} margin` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="font-mono font-bold text-sm tabular-nums text-green-400">
            +${item.amount.toFixed(2)}
          </span>
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            disabled={deleting}
            className="w-7 h-7 rounded-lg bg-slate-700 hover:bg-rose-900/60 text-slate-500 hover:text-rose-400 flex items-center justify-center transition-colors text-xs"
          >
            {deleting ? '…' : '✕'}
          </button>
        </div>
      </button>
      {expanded && Object.keys(item.allocs).length > 0 && (
        <div className="px-4 pb-3 pt-0 border-t border-slate-700/60 space-y-1">
          <p className="text-slate-500 text-[10px] uppercase tracking-wider pt-2 mb-1">Allocations</p>
          {Object.entries(item.allocs).map(([cat, amt]) => (
            <div key={cat} className="flex justify-between text-xs">
              <span className="text-slate-300">{cat}</span>
              <span className="text-slate-400 font-mono">${parseFloat(amt).toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
