import { useEffect, useState, useMemo } from 'react';
import { readRange, batchUpdateCells } from '../lib/sheets';
import { SHEETS, SPREADSHEET_ID } from '../config';
import { MONTHS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

const EXPENSE_TYPES = ['Essentials', 'Discretionary', 'Savings', 'Stability', 'Subscription'];
const ACCOUNTS = ['Checking', 'Outside Payment', 'Cash', 'Savings', 'Business Tax', 'Subscription'];
const PRIORITIES = [1, 2, 3];

const CAT_COLORS = {
  Essentials:    '#3b82f6',
  Discretionary: '#a855f7',
  Savings:       '#10b981',
  Stability:     '#f59e0b',
  Subscription:  '#f43f5e',
};

const CAT_BADGES = {
  Essentials:    'bg-blue-900/50 text-blue-300',
  Discretionary: 'bg-purple-900/50 text-purple-300',
  Savings:       'bg-emerald-900/50 text-emerald-300',
  Stability:     'bg-amber-900/50 text-amber-300',
  Subscription:  'bg-rose-900/50 text-rose-300',
};

const PRI_COLORS = { 1: 'text-emerald-400', 2: 'text-amber-400', 3: 'text-slate-500' };

function pm(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
function fmt(val) {
  const n = pm(val);
  return `$${n.toFixed(2)}`;
}

// ─── Pie chart with legend ────────────────────────────────────────────────────

function BudgetPie({ items }) {
  const data = useMemo(() => {
    const map = {};
    items.forEach(item => {
      const cat = item['Expense'] || 'Other';
      map[cat] = (map[cat] || 0) + pm(item['Monthly Allowance ($)']);
    });
    return Object.entries(map).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value }));
  }, [items]);

  if (!data.length) return null;

  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <div className="bg-slate-900 rounded-2xl p-4">
      <p className="text-slate-400 text-xs uppercase tracking-wider mb-3">Budget by Category</p>
      <div className="flex items-center gap-4">
        <div style={{ width: 120, height: 120 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" cx="50%" cy="50%" innerRadius={28} outerRadius={52} paddingAngle={2}>
                {data.map((entry, i) => (
                  <Cell key={i} fill={CAT_COLORS[entry.name] || '#64748b'} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontSize: 11 }}
                formatter={v => [`$${v.toFixed(2)}`]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex-1 space-y-1.5">
          {data.sort((a, b) => b.value - a.value).map(({ name, value }) => (
            <div key={name} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CAT_COLORS[name] || '#64748b' }} />
                <span className="text-slate-300 text-xs">{name}</span>
              </div>
              <span className="text-white text-xs font-mono tabular-nums">{fmt(value)}</span>
            </div>
          ))}
          <div className="border-t border-slate-800 pt-1.5 flex justify-between">
            <span className="text-slate-500 text-xs">Total</span>
            <span className="text-white text-xs font-mono font-bold tabular-nums">{fmt(total)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Edit drawer ──────────────────────────────────────────────────────────────

function EditDrawer({ item, headers, onSave, onClose, saving }) {
  const [fields, setFields] = useState({
    Type: item['Type'] || '',
    Expense: item['Expense'] || '',
    Account: item['Account'] || '',
    Priority: String(item['Priority'] || '2'),
    'Monthly Allowance ($)': String(item['Monthly Allowance ($)'] || '0'),
  });

  function set(k, v) { setFields(f => ({ ...f, [k]: v })); }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end z-50">
      <div className="bg-slate-900 w-full rounded-t-3xl p-5 space-y-4 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-bold">Edit Budget Item</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Name / Type</label>
            <input
              value={fields['Type']}
              onChange={e => set('Type', e.target.value)}
              className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Category</label>
            <div className="grid grid-cols-2 gap-2">
              {EXPENSE_TYPES.map(t => (
                <button
                  key={t}
                  onClick={() => set('Expense', t)}
                  className={`py-2 rounded-xl text-sm font-medium transition-colors ${
                    fields['Expense'] === t
                      ? `${CAT_BADGES[t] || 'bg-slate-600 text-white'} ring-2 ring-white/20`
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Account</label>
            <select
              value={fields['Account']}
              onChange={e => set('Account', e.target.value)}
              className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            >
              {ACCOUNTS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Priority</label>
            <div className="flex gap-2">
              {PRIORITIES.map(p => (
                <button
                  key={p}
                  onClick={() => set('Priority', String(p))}
                  className={`flex-1 py-2 rounded-xl text-sm font-bold transition-colors ${
                    fields['Priority'] === String(p)
                      ? p === 1 ? 'bg-emerald-700 text-white' : p === 2 ? 'bg-amber-700 text-white' : 'bg-slate-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                  P{p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Monthly Allowance</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={fields['Monthly Allowance ($)']}
                onChange={e => set('Monthly Allowance ($)', e.target.value)}
                className="w-full bg-slate-800 text-white text-lg font-bold rounded-xl pl-8 pr-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 font-mono tabular-nums"
              />
            </div>
          </div>
        </div>

        <button
          onClick={() => onSave(fields)}
          disabled={saving}
          className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-bold transition-colors"
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

// ─── Budget row card ──────────────────────────────────────────────────────────

function BudgetCard({ item, onEdit }) {
  const allowance = pm(item['Monthly Allowance ($)']);
  const spent = pm(item['Actual Spend']);
  const remaining = allowance - spent;
  const pct = allowance > 0 ? Math.min((spent / allowance) * 100, 100) : 0;
  const overBudget = spent > allowance && allowance > 0;

  return (
    <div
      className="bg-slate-900 rounded-xl p-4 space-y-2 active:bg-slate-800 transition-colors cursor-pointer"
      onClick={onEdit}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-white font-semibold text-sm truncate">{item['Type']}</p>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${PRI_COLORS[item['Priority']]} bg-slate-800`}>
              P{item['Priority']}
            </span>
          </div>
          <div className="flex gap-1.5 mt-1 flex-wrap">
            {item['Expense'] && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${CAT_BADGES[item['Expense']] || 'bg-slate-700 text-slate-300'}`}>
                {item['Expense']}
              </span>
            )}
            {item['Account'] && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-500">
                {item['Account']}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-white text-sm font-bold font-mono tabular-nums">{fmt(allowance)}</p>
          <p className={`text-[11px] font-mono tabular-nums ${overBudget ? 'text-rose-400' : 'text-slate-500'}`}>
            {overBudget ? `+${fmt(spent - allowance)}` : `${fmt(remaining)} left`}
          </p>
        </div>
      </div>

      {allowance > 0 && (
        <>
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, background: overBudget ? '#ef4444' : CAT_COLORS[item['Expense']] || '#64748b' }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-slate-600 font-mono tabular-nums">
            <span>spent {fmt(spent)}</span>
            <span>{pct.toFixed(0)}%</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

const FILTER_OPTIONS = ['All', ...EXPENSE_TYPES];

export default function Budget({ token }) {
  const [items, setItems]         = useState([]);
  const [headers, setHeaders]     = useState([]);
  const [pi, setPi]               = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [filter, setFilter]       = useState('All');
  const [editItem, setEditItem]   = useState(null);
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState(null);

  function load() {
    setLoading(true);
    const now = new Date();
    const currentMonth = MONTHS[now.getMonth()];
    const currentYear  = String(now.getFullYear());

    Promise.all([
      readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A1:T50`),
      readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A1:P13`),
    ])
      .then(([expRows, summaryRows]) => {
        if (expRows.length) {
          const [headerRow, ...dataRows] = expRows;
          setHeaders(headerRow);
          setItems(
            dataRows
              .filter(r => r[0])
              .map((row, idx) => {
                const obj = { _rowNum: idx + 2 };
                headerRow.forEach((h, i) => { obj[h] = row[i] ?? null; });
                return obj;
              })
          );
        }

        if (summaryRows.length) {
          const [hdr, ...data] = summaryRows;
          const cur = data.find(r => r[hdr.indexOf('Month')] === currentMonth && String(r[hdr.indexOf('Year')]) === currentYear);
          if (cur) {
            const piIdx = hdr.indexOf('Total Processed Income');
            setPi(parseFloat(cur[piIdx]) || 0);
          }
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { if (token) load(); }, [token]);

  async function handleSave(fields) {
    if (!editItem) return;
    setSaving(true);
    setSaveError(null);
    const sheetRow = editItem._rowNum;
    const updates = [];

    Object.entries(fields).forEach(([fieldName, value]) => {
      const colIndex = headers.indexOf(fieldName);
      if (colIndex < 0) return;
      const colLetter = colIndex < 26
        ? String.fromCharCode(65 + colIndex)
        : String.fromCharCode(64 + Math.floor(colIndex / 26)) + String.fromCharCode(65 + (colIndex % 26));
      updates.push({ range: `${SHEETS.MONTHLY_EXPENSES}!${colLetter}${sheetRow}`, value });
    });

    try {
      await batchUpdateCells(token, updates);
      // Update local state immediately
      setItems(prev => prev.map(item =>
        item._rowNum === sheetRow ? { ...item, ...fields } : item
      ));
      setEditItem(null);
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (error)   return <div className="p-4 text-red-400">Error: {error}</div>;

  const filtered = filter === 'All'
    ? items
    : items.filter(i => i['Expense'] === filter || i['Account'] === filter);
  const totalAllowance = items.reduce((s, i) => s + pm(i['Monthly Allowance ($)']), 0);
  const totalSpent     = items.reduce((s, i) => s + pm(i['Actual Spend']), 0);
  const baseline       = pi > 0 ? pi : totalAllowance;
  const overallPct     = baseline > 0 ? (totalSpent / baseline) * 100 : 0;

  return (
    <div className="pb-24">

      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-white tracking-tight">Budget</h1>
        <p className="text-slate-500 text-xs mt-0.5">Tap any item to edit — changes sync to Google Sheets</p>
      </div>

      <div className="px-4 space-y-4">

        {/* Summary bar */}
        <div className="bg-slate-900 rounded-2xl p-4 space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                {pi > 0 ? 'Processed Income' : 'Monthly Budget'}
              </p>
              <p className="text-white text-xl font-bold font-mono tabular-nums mt-0.5">
                {fmt(baseline)}
              </p>
              {pi > 0 && (
                <p className="text-slate-600 text-[10px] font-mono mt-0.5">
                  goal {fmt(totalAllowance)}
                </p>
              )}
            </div>
            <div>
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Total Spent</p>
              <p className={`text-xl font-bold font-mono tabular-nums mt-0.5 ${overallPct > 90 ? 'text-rose-400' : overallPct > 70 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {fmt(totalSpent)}
              </p>
            </div>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-2 rounded-full transition-all"
              style={{ width: `${Math.min(overallPct, 100)}%`, background: overallPct > 90 ? '#ef4444' : overallPct > 70 ? '#f59e0b' : '#10b981' }}
            />
          </div>
          <div className="flex justify-between text-[11px] font-mono text-slate-500">
            <span>{fmt(baseline - totalSpent)} remaining</span>
            <span>{overallPct.toFixed(0)}% spent</span>
          </div>
        </div>

        {/* Pie chart */}
        <BudgetPie items={items} />

        {/* Filter pills */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {FILTER_OPTIONS.map(opt => (
            <button
              key={opt}
              onClick={() => setFilter(opt)}
              className={`shrink-0 text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
                filter === opt
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        {saveError && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-sm">{saveError}</div>
        )}

        {/* Item list */}
        <div className="space-y-2">
          {filtered.map((item) => (
            <BudgetCard key={item._rowNum} item={item} onEdit={() => setEditItem(item)} />
          ))}
          {filtered.length === 0 && (
            <p className="text-slate-600 text-center py-8 text-sm">No items in this category</p>
          )}
        </div>

      </div>

      {/* Edit drawer */}
      {editItem && (
        <EditDrawer
          item={editItem}
          headers={headers}
          onSave={handleSave}
          onClose={() => { setEditItem(null); setSaveError(null); }}
          saving={saving}
        />
      )}
    </div>
  );
}
