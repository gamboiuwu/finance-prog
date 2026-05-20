import { useEffect, useState, useMemo, useCallback } from 'react';
import { readRange, batchUpdateCells, appendRow } from '../lib/sheets';
import { SHEETS, MONTHS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis,
} from 'recharts';

const EXPENSE_TYPES = ['Essentials', 'Discretionary', 'Savings', 'Stability', 'Subscription'];
const ACCOUNTS      = ['Checking', 'Outside Payment', 'Cash', 'Savings', 'Business Tax', 'Subscription'];

const CAT_COLORS = {
  Essentials:    '#3b82f6',
  Discretionary: '#a855f7',
  Savings:       '#10b981',
  Stability:     '#f59e0b',
  Subscription:  '#f43f5e',
};

// Full literal class strings so Tailwind JIT/v4 can scan them
const PRI = {
  '1': {
    label:  'Essential',
    color:  '#f43f5e',
    text:   'text-rose-400',
    bg:     'bg-rose-950/50',
    border: 'border-rose-800/50',
    badge:  'bg-rose-900/60 text-rose-200',
    bar:    '#f43f5e',
  },
  '2': {
    label:  'Stability',
    color:  '#f59e0b',
    text:   'text-amber-400',
    bg:     'bg-amber-950/50',
    border: 'border-amber-800/50',
    badge:  'bg-amber-900/60 text-amber-200',
    bar:    '#f59e0b',
  },
  '3': {
    label:  'Optional',
    color:  '#8b5cf6',
    text:   'text-violet-400',
    bg:     'bg-violet-950/50',
    border: 'border-violet-800/50',
    badge:  'bg-violet-900/60 text-violet-200',
    bar:    '#8b5cf6',
  },
};

function pm(val) {
  if (!val && val !== 0) return 0;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
function fmt(val) { return `$${pm(val).toFixed(2)}`; }

// ── Allocation donut ──────────────────────────────────────────────────────────

function AllocationDonut({ items, total }) {
  const data = useMemo(() => {
    const map = {};
    items.forEach(item => {
      const cat = item['Expense'] || 'Other';
      map[cat] = (map[cat] || 0) + pm(item['Monthly Allowance ($)']);
    });
    return Object.entries(map)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));
  }, [items]);

  if (!data.length) return null;

  return (
    <div className="bg-slate-900 rounded-2xl p-5">
      <p className="text-slate-400 text-xs uppercase tracking-wider mb-4">Allocation by Category</p>
      <div className="flex items-center gap-5">
        <div className="relative shrink-0" style={{ width: 130, height: 130 }}>
          <PieChart width={130} height={130}>
            <Pie data={data} cx={65} cy={65} innerRadius={38} outerRadius={58}
              dataKey="value" stroke="none" paddingAngle={2}>
              {data.map((entry, i) => (
                <Cell key={i} fill={CAT_COLORS[entry.name] || '#64748b'} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontSize: 11 }}
              formatter={v => [`$${v.toFixed(2)}`]}
            />
          </PieChart>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-white font-bold text-sm">{fmt(total)}</span>
            <span className="text-slate-500 text-[10px]">/ month</span>
          </div>
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          {data.map(({ name, value }) => (
            <div key={name} className="space-y-0.5">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CAT_COLORS[name] || '#64748b' }} />
                  <span className="text-slate-300 truncate">{name}</span>
                </div>
                <span className="text-white font-mono tabular-nums shrink-0 ml-2">{fmt(value)}</span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-1 overflow-hidden">
                <div className="h-1 rounded-full transition-all"
                  style={{ width: `${total > 0 ? (value / total) * 100 : 0}%`, background: CAT_COLORS[name] || '#64748b' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Priority budget vs actual chart ──────────────────────────────────────────

function PriorityChart({ items }) {
  const data = useMemo(() => (
    ['1', '2', '3']
      .map(p => {
        const group = items.filter(i => String(i['Priority'] ?? '3') === p);
        return {
          name:    PRI[p]?.label || `P${p}`,
          budget:  group.reduce((s, i) => s + pm(i['Monthly Allowance ($)']), 0),
          spent:   group.reduce((s, i) => s + pm(i['Actual Spend']), 0),
          _color:  PRI[p]?.color || '#64748b',
        };
      })
      .filter(d => d.budget > 0)
  ), [items]);

  if (!data.length) return null;

  return (
    <div className="bg-slate-900 rounded-2xl p-5">
      <p className="text-slate-400 text-xs uppercase tracking-wider mb-4">Budget vs Actual — by Priority</p>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={data} barCategoryGap="35%">
          <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={50} />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
            formatter={v => [`$${v.toFixed(2)}`]}
          />
          <Bar dataKey="budget" fill="#1e293b" radius={[4, 4, 0, 0]} name="Budget" />
          <Bar dataKey="spent" radius={[4, 4, 0, 0]} name="Spent">
            {data.map((entry, i) => <Cell key={i} fill={entry._color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-4 justify-center text-xs text-slate-500 mt-1">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-slate-800 border border-slate-700" />Budget</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-blue-500" />Actual</span>
      </div>
    </div>
  );
}

// ── Edit / Add drawer ─────────────────────────────────────────────────────────

function EditDrawer({ item, headers, onSave, onClose, saving, isNew }) {
  const [fields, setFields] = useState({
    Type:                 item['Type']                 || '',
    Expense:              item['Expense']              || '',
    Account:              item['Account']              || 'Checking',
    Priority:             String(item['Priority']      || '2'),
    'Monthly Allowance ($)': String(item['Monthly Allowance ($)'] || '0'),
  });

  function set(k, v) { setFields(f => ({ ...f, [k]: v })); }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end z-50">
      <div className="bg-slate-900 w-full rounded-t-3xl p-5 space-y-4 max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-bold">{isNew ? '+ New Budget Item' : 'Edit Budget Item'}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center">✕</button>
        </div>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Name</label>
            <input
              value={fields['Type']}
              onChange={e => set('Type', e.target.value)}
              placeholder="e.g. Rent, Netflix, Groceries"
              autoFocus={isNew}
              className="w-full bg-slate-800 text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-600"
            />
          </div>

          {/* Amount */}
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Monthly Amount</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-lg">$</span>
              <input
                type="number" step="0.01" min="0"
                value={fields['Monthly Allowance ($)']}
                onChange={e => set('Monthly Allowance ($)', e.target.value)}
                className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 font-mono tabular-nums"
              />
            </div>
          </div>

          {/* Priority */}
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Priority</label>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3'].map(p => {
                const active = fields['Priority'] === p;
                return (
                  <button
                    key={p}
                    onClick={() => set('Priority', p)}
                    className={`py-3 rounded-xl text-sm font-bold transition-all border ${
                      active
                        ? `${PRI[p].bg} ${PRI[p].border} ${PRI[p].text}`
                        : 'bg-slate-800 border-slate-700 text-slate-400'
                    }`}
                  >
                    <div>P{p}</div>
                    <div className="text-[10px] font-normal mt-0.5 opacity-80">{PRI[p].label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Category</label>
            <div className="grid grid-cols-2 gap-2">
              {EXPENSE_TYPES.map(t => (
                <button
                  key={t}
                  onClick={() => set('Expense', t)}
                  className={`py-2 rounded-xl text-xs font-medium transition-colors border ${
                    fields['Expense'] === t
                      ? 'bg-blue-900/50 border-blue-700/50 text-blue-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Account */}
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Account</label>
            <div className="grid grid-cols-2 gap-2">
              {ACCOUNTS.map(a => (
                <button
                  key={a}
                  onClick={() => set('Account', a)}
                  className={`py-2 px-3 rounded-xl text-xs font-medium transition-colors text-left border ${
                    fields['Account'] === a
                      ? 'bg-emerald-900/50 border-emerald-700/50 text-emerald-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={() => onSave(fields)}
          disabled={saving || !fields['Type']}
          className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-bold transition-colors"
        >
          {saving ? 'Saving…' : isNew ? '+ Add to Budget' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

// ── Individual item card ──────────────────────────────────────────────────────

function BudgetCard({ item, onEdit }) {
  const p   = String(item['Priority'] ?? '3');
  const pri = PRI[p] || PRI['3'];
  const allowance  = pm(item['Monthly Allowance ($)']);
  const spent      = pm(item['Actual Spend']);
  const remaining  = allowance - spent;
  const pct        = allowance > 0 ? Math.min((spent / allowance) * 100, 100) : 0;
  const overBudget = spent > allowance && allowance > 0;

  return (
    <button
      className="w-full text-left bg-slate-900 rounded-xl p-4 border border-slate-800/60 transition-all active:scale-[0.98] active:bg-slate-800"
      onClick={onEdit}
      style={{ borderLeft: `3px solid ${pri.color}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium text-sm truncate">{item['Type'] || '—'}</p>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {item['Expense'] && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ background: `${CAT_COLORS[item['Expense']] || '#64748b'}25`, color: CAT_COLORS[item['Expense']] || '#94a3b8' }}>
                {item['Expense']}
              </span>
            )}
            {item['Account'] && item['Account'] !== 'Subscription' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-500">{item['Account']}</span>
            )}
            {item['Account'] === 'Subscription' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-900/40 text-rose-400">sub</span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-white font-bold text-sm font-mono tabular-nums">{fmt(allowance)}</p>
          <p className={`text-[11px] font-mono tabular-nums mt-0.5 ${overBudget ? 'text-rose-400' : 'text-slate-500'}`}>
            {overBudget ? `+${fmt(spent - allowance)} over` : spent > 0 ? `${fmt(remaining)} left` : 'no spend yet'}
          </p>
        </div>
      </div>

      {allowance > 0 && (
        <div className="mt-3 space-y-1">
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, background: overBudget ? '#ef4444' : pri.color }} />
          </div>
          <div className="flex justify-between text-[10px] text-slate-600 font-mono tabular-nums">
            <span>{fmt(spent)} spent</span>
            <span>{pct.toFixed(0)}%</span>
          </div>
        </div>
      )}
    </button>
  );
}

// ── Priority section ──────────────────────────────────────────────────────────

function PrioritySection({ priority, items, onEdit, onAdd }) {
  const [collapsed, setCollapsed] = useState(false);
  const p   = String(priority);
  const pri = PRI[p] || PRI['3'];

  const sectionAllowance = items.reduce((s, i) => s + pm(i['Monthly Allowance ($)']), 0);
  const sectionSpent     = items.reduce((s, i) => s + pm(i['Actual Spend']), 0);
  const pct              = sectionAllowance > 0 ? Math.min((sectionSpent / sectionAllowance) * 100, 100) : 0;
  const overBudget       = sectionSpent > sectionAllowance;

  return (
    <div className={`rounded-2xl border ${pri.border} overflow-hidden`}>
      {/* Section header */}
      <button
        className={`w-full flex items-center justify-between px-4 py-3.5 ${pri.bg} transition-opacity active:opacity-80`}
        onClick={() => setCollapsed(c => !c)}
      >
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${pri.badge}`}>P{p}</span>
          <span className={`font-semibold text-sm ${pri.text}`}>{pri.label}</span>
          <span className="text-slate-600 text-xs">· {items.length}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-white font-bold text-sm font-mono tabular-nums">{fmt(sectionAllowance)}</span>
          <span className="text-slate-500 text-xs">{collapsed ? '▼' : '▲'}</span>
        </div>
      </button>

      {/* Progress bar */}
      {!collapsed && sectionAllowance > 0 && (
        <div className="px-4 py-2" style={{ background: 'rgba(2,6,23,0.5)' }}>
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-1.5 rounded-full transition-all"
              style={{ width: `${pct}%`, background: overBudget ? '#ef4444' : pri.color }} />
          </div>
          <div className="flex justify-between text-[10px] text-slate-600 font-mono mt-1">
            <span>{pct.toFixed(0)}% spent · {fmt(sectionSpent)}</span>
            <span>{fmt(sectionAllowance - sectionSpent)} remaining</span>
          </div>
        </div>
      )}

      {/* Items */}
      {!collapsed && (
        <div className="p-3 space-y-2" style={{ background: 'rgba(2,6,23,0.35)' }}>
          {items.map(item => (
            <BudgetCard
              key={item._rowNum}
              item={item}
              onEdit={() => onEdit(item)}
            />
          ))}
          <button
            onClick={onAdd}
            className={`w-full py-2.5 rounded-xl text-xs font-medium border border-dashed ${pri.border} ${pri.text} opacity-60 hover:opacity-100 transition-opacity`}
          >
            + Add {pri.label} Item
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Budget({ token }) {
  const [items, setItems]         = useState([]);
  const [headers, setHeaders]     = useState([]);
  const [pi, setPi]               = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [editItem, setEditItem]   = useState(null);
  const [isAddNew, setIsAddNew]   = useState(false);
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const now          = new Date();
    const currentMonth = MONTHS[now.getMonth()];
    const currentYear  = String(now.getFullYear());

    try {
      const [expRows, summaryRows] = await Promise.all([
        readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A1:T50`),
        readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A1:P13`),
      ]);

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
        const cur = data.find(
          r => r[hdr.indexOf('Month')] === currentMonth && String(r[hdr.indexOf('Year')]) === currentYear
        );
        if (cur) setPi(parseFloat(cur[hdr.indexOf('Total Processed Income')]) || 0);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  async function handleSave(fields) {
    setSaving(true);
    setSaveError(null);
    try {
      if (isAddNew) {
        const row = headers.map(h => fields[h] ?? '');
        await appendRow(token, `${SHEETS.MONTHLY_EXPENSES}!A:T`, row);
        await load();
      } else {
        const sheetRow = editItem._rowNum;
        const updates  = [];
        Object.entries(fields).forEach(([fieldName, value]) => {
          const colIndex = headers.indexOf(fieldName);
          if (colIndex < 0) return;
          const colLetter = colIndex < 26
            ? String.fromCharCode(65 + colIndex)
            : String.fromCharCode(64 + Math.floor(colIndex / 26)) + String.fromCharCode(65 + (colIndex % 26));
          updates.push({ range: `${SHEETS.MONTHLY_EXPENSES}!${colLetter}${sheetRow}`, value });
        });
        await batchUpdateCells(token, updates);
        setItems(prev => prev.map(item => item._rowNum === sheetRow ? { ...item, ...fields } : item));
      }
      setEditItem(null);
      setIsAddNew(false);
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function openEdit(item) {
    setIsAddNew(false);
    setEditItem(item);
  }

  function openAdd(priority = '2') {
    setIsAddNew(true);
    setEditItem({ Type: '', Expense: '', Account: 'Checking', Priority: priority, 'Monthly Allowance ($)': '0' });
  }

  if (loading) return <LoadingSpinner />;
  if (error)   return <div className="p-4 text-red-400">Error: {error}</div>;

  const totalAllowance = items.reduce((s, i) => s + pm(i['Monthly Allowance ($)']), 0);
  const totalSpent     = items.reduce((s, i) => s + pm(i['Actual Spend']), 0);
  const baseline       = pi > 0 ? pi : totalAllowance;
  const overallPct     = baseline > 0 ? (totalSpent / baseline) * 100 : 0;
  const remaining      = totalAllowance - totalSpent;

  const priorityGroups = ['1', '2', '3']
    .map(p => ({ priority: p, items: items.filter(i => String(i['Priority'] ?? '3') === p) }))
    .filter(g => g.items.length > 0);

  return (
    <div className="pb-24">

      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Budget</h1>
          <p className="text-slate-500 text-xs mt-0.5">Tap any item to edit · syncs to Sheets</p>
        </div>
        <button
          onClick={() => openAdd('2')}
          className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-colors"
        >
          + Add
        </button>
      </div>

      <div className="px-4 space-y-4">

        {/* Stats bar */}
        <div className="bg-slate-900 rounded-2xl p-4">
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">{pi > 0 ? 'Income' : 'Budget'}</p>
              <p className="text-emerald-400 text-lg font-bold font-mono tabular-nums mt-0.5">{fmt(baseline)}</p>
              {pi > 0 && <p className="text-slate-600 text-[10px] font-mono mt-0.5">goal {fmt(totalAllowance)}</p>}
            </div>
            <div>
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Spent</p>
              <p className={`text-lg font-bold font-mono tabular-nums mt-0.5 ${overallPct > 90 ? 'text-rose-400' : overallPct > 70 ? 'text-amber-400' : 'text-white'}`}>
                {fmt(totalSpent)}
              </p>
            </div>
            <div>
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Remaining</p>
              <p className={`text-lg font-bold font-mono tabular-nums mt-0.5 ${remaining < 0 ? 'text-rose-400' : 'text-sky-400'}`}>
                {fmt(Math.abs(remaining))}{remaining < 0 ? ' over' : ''}
              </p>
            </div>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
            <div className="h-2.5 rounded-full transition-all"
              style={{ width: `${Math.min(overallPct, 100)}%`, background: overallPct > 90 ? '#ef4444' : overallPct > 70 ? '#f59e0b' : '#10b981' }} />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-600 mt-1">
            <span>{overallPct.toFixed(0)}% of budget used</span>
            <span>{items.length} items</span>
          </div>
        </div>

        {/* Charts */}
        <AllocationDonut items={items} total={totalAllowance} />
        <PriorityChart items={items} />

        {saveError && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-sm">{saveError}</div>
        )}

        {/* Priority-grouped sections */}
        <div className="space-y-3">
          {priorityGroups.map(({ priority, items: gItems }) => (
            <PrioritySection
              key={priority}
              priority={priority}
              items={gItems}
              onEdit={openEdit}
              onAdd={() => openAdd(priority)}
            />
          ))}
        </div>

      </div>

      {/* Edit / Add drawer */}
      {editItem && (
        <EditDrawer
          item={editItem}
          headers={headers}
          onSave={handleSave}
          onClose={() => { setEditItem(null); setIsAddNew(false); setSaveError(null); }}
          saving={saving}
          isNew={isAddNew}
        />
      )}
    </div>
  );
}
