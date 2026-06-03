import { useEffect, useState, useMemo, useCallback } from 'react';
import { readRange, batchUpdateCells, appendRow } from '../lib/sheets';
import { SHEETS, MONTHS } from '../config';
import { fetchGasPrices } from '../lib/gasPrice';
import { computeGasBudget, saveGasBudget, getGasBudget } from '../lib/gasBudget';
import LoadingSpinner from '../components/LoadingSpinner';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis,
} from 'recharts';

const EXPENSE_TYPES = ['Essentials', 'Discretionary', 'Savings', 'Stability', 'Subscription'];
const ACCOUNTS      = ['Checking', 'Outside Payment', 'Cash', 'Savings', 'Business Tax', 'Subscription'];

const isGasType = name => String(name || '').trim().toLowerCase() === 'gas';
// Goal/allowance for a budget item, applying the live dynamic gas budget for Gas.
function itemGoal(item) {
  if (isGasType(item['Type'])) {
    const v = getGasBudget()?.value;
    if (v > 0) return v;
  }
  return pm(item['Monthly Allowance ($)']);
}

const CAT_COLORS = {
  Essentials:    '#3b82f6',
  Discretionary: '#a855f7',
  Savings:       '#10b981',
  Stability:     '#f59e0b',
  Subscription:  '#f43f5e',
};

const PRI = {
  '1': {
    label: 'Essential', color: '#f43f5e', text: 'text-rose-400',
    bg: 'bg-rose-950/50', border: 'border-rose-800/50',
    badge: 'bg-rose-900/60 text-rose-200', bar: '#f43f5e',
  },
  '2': {
    label: 'Stability', color: '#f59e0b', text: 'text-amber-400',
    bg: 'bg-amber-950/50', border: 'border-amber-800/50',
    badge: 'bg-amber-900/60 text-amber-200', bar: '#f59e0b',
  },
  '3': {
    label: 'Optional', color: '#8b5cf6', text: 'text-violet-400',
    bg: 'bg-violet-950/50', border: 'border-violet-800/50',
    badge: 'bg-violet-900/60 text-violet-200', bar: '#8b5cf6',
  },
};

function pm(val) {
  if (!val && val !== 0) return 0;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
function fmt(val) { return `$${pm(val).toFixed(2)}`; }

function dayLabel(d) {
  if (d === 1 || d === 21 || d === 31) return `${d}st`;
  if (d === 2 || d === 22) return `${d}nd`;
  if (d === 3 || d === 23) return `${d}rd`;
  return `${d}th`;
}
function getDueDates() {
  try { return JSON.parse(localStorage.getItem('_fin_due_dates') || '{}'); } catch { return {}; }
}
function getCatNotes() {
  try { return JSON.parse(localStorage.getItem('_fin_cat_notes') || '{}'); } catch { return {}; }
}

// Parses a Sheets date cell (serial number or M/D/YYYY or YYYY-MM-DD string)
function parseSheetDate(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  if (!isNaN(n) && n > 1000 && !String(val).includes('/'))
    return new Date(Math.round((n - 25569) * 86400000));
  const s = String(val);
  if (s.includes('-')) return new Date(s + 'T12:00:00');
  const parts = s.split('/');
  if (parts.length === 3)
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  return null;
}

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
      <p className="text-slate-400 text-xs uppercase tracking-wider mb-4 font-broske">Allocation by Category</p>
      <div className="flex items-center gap-5 max-w-xl">
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
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none overflow-hidden" style={{ width: 72, left: 29 }}>
            <span className="text-white font-bold text-[8px] font-mono tabular-nums leading-tight text-center w-full truncate px-1">{fmt(total)}</span>
            <span className="text-slate-500 text-[7px] leading-tight">/mo</span>
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
          name:   PRI[p]?.label || `P${p}`,
          budget: group.reduce((s, i) => s + pm(i['Monthly Allowance ($)']), 0),
          spent:  group.reduce((s, i) => s + pm(i['Actual Spend']), 0),
          _color: PRI[p]?.color || '#64748b',
        };
      })
      .filter(d => d.budget > 0)
  ), [items]);

  if (!data.length) return null;

  return (
    <div className="bg-slate-900 rounded-2xl p-5">
      <p className="text-slate-400 text-xs uppercase tracking-wider mb-4 font-broske">Budget vs Actual — by Priority</p>
      <div className="max-w-xl">
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
      </div>
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
    Type:                    item['Type']                    || '',
    Expense:                 item['Expense']                 || '',
    Account:                 item['Account']                 || 'Checking',
    Priority:                String(item['Priority']         || '2'),
    'Monthly Allowance ($)': String(item['Monthly Allowance ($)'] || '0'),
    'Actual Spend':          String(item['Actual Spend']     || '0'),
  });
  const [balanceType, setBalanceType] = useState(() => {
    try {
      const map = JSON.parse(localStorage.getItem('_fin_budget_balance_type') || '{}');
      return map[item['Type'] || ''] || 'monthly';
    } catch { return 'monthly'; }
  });

  function set(k, v) { setFields(f => ({ ...f, [k]: v })); }

  function handleSave() {
    const typeName = fields['Type'];
    if (typeName) {
      try {
        const map = JSON.parse(localStorage.getItem('_fin_budget_balance_type') || '{}');
        map[typeName] = balanceType;
        localStorage.setItem('_fin_budget_balance_type', JSON.stringify(map));
      } catch {}
    }
    onSave(fields);
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center sm:justify-center justify-center z-50"
         onClick={() => !saving && onClose()}>
      <div className="modal-sheet bg-slate-900 w-full sm:max-w-lg sm:rounded-2xl rounded-t-3xl p-5 space-y-4 max-h-[88dvh] overflow-y-auto sm:my-auto min-h-0"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-white font-bold">{isNew ? '+ New Budget Item' : 'Edit Budget Item'}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center">✕</button>
        </div>

        <div className="space-y-4">
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

          {!isNew && (
            <div>
              <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Actual Spend This Month</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-lg">$</span>
                <input
                  type="number" step="0.01" min="0"
                  value={fields['Actual Spend']}
                  onChange={e => set('Actual Spend', e.target.value)}
                  className="w-full bg-slate-800 text-white text-xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 font-mono tabular-nums"
                />
              </div>
            </div>
          )}

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

          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Balance Tracking</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'monthly', icon: '📅', title: 'Monthly Goal',    sub: 'Resets each month — tracks only current-month deposits' },
                { id: 'running', icon: '🔄', title: 'Running Balance', sub: 'Cumulative net — deposits minus spending, all time' },
              ].map(({ id, icon, title, sub }) => {
                const active = balanceType === id;
                return (
                  <button key={id} onClick={() => setBalanceType(id)}
                    className={`py-3 px-2 rounded-xl text-left border transition-all ${active ? 'bg-sky-900/50 border-sky-600/60 text-sky-200' : 'bg-slate-800 border-slate-700 text-slate-400'}`}
                  >
                    <div className="text-sm font-bold">{icon} {title}</div>
                    <div className="text-[10px] mt-0.5 opacity-70 leading-tight">{sub}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <button
          onClick={handleSave}
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
  const allowance  = itemGoal(item);
  const spent      = pm(item['Actual Spend']);
  const remaining  = allowance - spent;
  const pct        = allowance > 0 ? Math.min((spent / allowance) * 100, 100) : 0;
  const overBudget = spent > allowance && allowance > 0;
  const note       = getCatNotes()[item['Type'] || ''];

  return (
    <button
      className="w-full text-left bg-slate-900 rounded-xl p-4 border border-slate-800/60 transition-all active:scale-[0.98] active:bg-slate-800"
      onClick={onEdit}
      style={{ borderLeft: `3px solid ${pri.color}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium text-sm truncate">{item['Type'] || '—'}</p>
          {note && (
            <p className="text-slate-600 text-[10px] italic mt-0.5 truncate">
              {note.length > 60 ? note.slice(0, 60) + '…' : note}
            </p>
          )}
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

// ── Category tab: individual item card ────────────────────────────────────────

function CategoryItemCard({ item, allocated, budgeted }) {
  const type  = item['Type'] || '';
  const [dueDay, setDueDayState] = useState(() => getDueDates()[type] ?? null);
  const [editingDue, setEditingDue] = useState(false);
  const [note, setNote]           = useState(() => getCatNotes()[type] || '');
  const [showNoteDrawer, setShowNoteDrawer] = useState(false);
  const [noteInput, setNoteInput] = useState('');

  function saveDueDay(val) {
    const all = getDueDates();
    if (val == null) delete all[type]; else all[type] = Number(val);
    localStorage.setItem('_fin_due_dates', JSON.stringify(all));
    setDueDayState(val == null ? null : Number(val));
    setEditingDue(false);
  }

  function openNoteDrawer() {
    setNoteInput(note);
    setShowNoteDrawer(true);
  }

  function saveNote(text) {
    const trimmed = text.trim();
    const all = getCatNotes();
    if (trimmed) all[type] = trimmed; else delete all[type];
    localStorage.setItem('_fin_cat_notes', JSON.stringify(all));
    setNote(trimmed);
    setShowNoteDrawer(false);
  }

  const todayDay  = new Date().getDate();
  const daysUntil = dueDay != null ? dueDay - todayDay : null;
  const unfunded  = budgeted > 0 && allocated < budgeted;
  const pastDue   = dueDay != null && daysUntil < 0 && unfunded;
  const dueSoon   = dueDay != null && daysUntil != null && daysUntil >= 0 && daysUntil <= 3 && unfunded;

  const over  = allocated > budgeted && budgeted > 0;
  const pct   = budgeted > 0 ? Math.min((allocated / budgeted) * 100, 100) : (allocated > 0 ? 100 : 0);
  const cat   = item['Expense'] || 'Other';
  const color = CAT_COLORS[cat] || '#64748b';
  const leftBorder = pastDue ? '#ef4444' : dueSoon ? '#f59e0b' : over ? '#ef4444' : color;

  return (
    <>
      <div
        className="bg-slate-900 rounded-xl p-3.5 border border-slate-800/60"
        style={{ borderLeft: `3px solid ${leftBorder}` }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-white text-sm font-medium">{type || '—'}</p>
              {pastDue && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-900/60 text-rose-300 font-medium shrink-0">⚠ Past due</span>
              )}
              {dueSoon && !pastDue && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/60 text-amber-300 font-medium shrink-0">
                  ⏰ {daysUntil === 0 ? 'Due today' : `Due in ${daysUntil}d`}
                </span>
              )}
              <button
                onClick={openNoteDrawer}
                className="text-slate-600 hover:text-slate-300 text-[11px] leading-none transition-colors shrink-0 ml-auto"
                title="Add note"
              >
                ✎
              </button>
            </div>
            {item['Account'] && (
              <p className="text-slate-500 text-[10px] mt-0.5">{item['Account']}</p>
            )}
            {note && (
              <button
                onClick={openNoteDrawer}
                className="text-slate-500 hover:text-slate-400 text-[10px] italic mt-0.5 text-left w-full truncate transition-colors block"
              >
                {note.length > 60 ? note.slice(0, 60) + '…' : note}
              </button>
            )}
            <div className="mt-1">
              {editingDue ? (
                <div className="flex items-center gap-1.5">
                  <select
                    className="text-[10px] bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-white"
                    value={dueDay ?? ''}
                    onChange={e => saveDueDay(e.target.value === '' ? null : e.target.value)}
                    autoFocus
                    onBlur={() => setEditingDue(false)}
                  >
                    <option value="">No date</option>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                      <option key={d} value={d}>the {dayLabel(d)}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <button
                  onClick={() => setEditingDue(true)}
                  className={`text-[10px] px-1.5 py-0.5 rounded-full transition-colors ${
                    dueDay != null
                      ? pastDue ? 'bg-rose-900/40 text-rose-400' : dueSoon ? 'bg-amber-900/40 text-amber-400' : 'bg-slate-800 text-slate-400 hover:text-slate-300'
                      : 'text-slate-600 hover:text-slate-400'
                  }`}
                >
                  {dueDay != null ? `📅 Due ${dayLabel(dueDay)}` : '+ set due date'}
                </button>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className={`text-sm font-bold font-mono ${over ? 'text-rose-400' : 'text-white'}`}>
              {fmt(allocated)}
              <span className="text-slate-500 font-normal text-xs"> / {fmt(budgeted)}</span>
            </p>
            {over ? (
              <p className="text-rose-400 text-[10px] font-mono mt-0.5">+{fmt(allocated - budgeted)} over!</p>
            ) : allocated === 0 ? (
              <p className="text-slate-600 text-[10px] mt-0.5">not started</p>
            ) : (
              <p className="text-slate-500 text-[10px] font-mono mt-0.5">{fmt(budgeted - allocated)} left</p>
            )}
          </div>
        </div>
        {budgeted > 0 && (
          <div className="mt-2.5">
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="h-1.5 rounded-full transition-all"
                style={{ width: `${pct}%`, background: over ? '#ef4444' : color }} />
            </div>
            <p className="text-[10px] text-slate-600 font-mono mt-0.5">{pct.toFixed(0)}% funded</p>
          </div>
        )}
      </div>

      {showNoteDrawer && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setShowNoteDrawer(false)}
        >
          <div
            className="bg-slate-900 rounded-t-2xl p-5 pb-10 w-full max-w-lg mx-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-white font-semibold text-sm">Note — {type}</p>
              <button onClick={() => setShowNoteDrawer(false)} className="text-slate-500 hover:text-slate-300 text-lg leading-none">✕</button>
            </div>
            <textarea
              className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-white text-sm resize-none focus:outline-none focus:border-blue-500"
              rows={3}
              maxLength={160}
              value={noteInput}
              onChange={e => setNoteInput(e.target.value)}
              placeholder="Add a note for this category…"
              autoFocus
            />
            <p className="text-slate-600 text-[10px] text-right mt-1">{noteInput.length}/160</p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => saveNote('')}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
              >
                Clear
              </button>
              <button
                onClick={() => saveNote(noteInput)}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-blue-600 text-white hover:bg-blue-500 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Category tab: expense-type group ─────────────────────────────────────────

function CategoryGroup({ label, items, allocByType }) {
  const [open, setOpen] = useState(true);
  const color  = CAT_COLORS[label] || '#64748b';
  const totalB = items.reduce((s, i) => s + itemGoal(i), 0);
  const totalA = items.reduce((s, i) => s + (allocByType[i['Type'] || ''] || 0), 0);
  const over   = totalA > totalB && totalB > 0;
  const pct    = totalB > 0 ? Math.min((totalA / totalB) * 100, 100) : 0;

  return (
    <div className="rounded-2xl border border-slate-800/50 overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-900/80 active:opacity-80"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
          <span className="text-white font-semibold text-sm">{label}</span>
          <span className="text-slate-600 text-xs">· {items.length}</span>
        </div>
        <div className="flex items-center gap-2">
          {over && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-900/60 text-rose-300 font-medium">over!</span>
          )}
          <span className="text-white font-mono text-sm">
            {fmt(totalA)}<span className="text-slate-500 text-xs font-normal"> / {fmt(totalB)}</span>
          </span>
          <span className="text-slate-500 text-xs">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && totalB > 0 && (
        <div className="px-4 py-2 bg-slate-950/50">
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-1.5 rounded-full"
              style={{ width: `${pct}%`, background: over ? '#ef4444' : color }} />
          </div>
          <div className="flex justify-between text-[10px] text-slate-600 font-mono mt-0.5">
            <span>{pct.toFixed(0)}% funded · {fmt(totalA)}</span>
            <span>{fmt(totalB - totalA)} remaining</span>
          </div>
        </div>
      )}

      {open && label === 'Subscription' && totalB > 0 && (
        <div className="px-4 pt-3 pb-2 bg-slate-950/30 border-t border-slate-800/40">
          <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-2">Monthly cost per subscription</p>
          <div className="space-y-2">
            {[...items]
              .sort((a, b) => pm(b['Monthly Allowance ($)']) - pm(a['Monthly Allowance ($)']))
              .map(item => {
                const cost = pm(item['Monthly Allowance ($)']);
                const share = totalB > 0 ? (cost / totalB) * 100 : 0;
                return (
                  <div key={item._rowNum} className="flex items-center justify-between gap-3 bg-slate-900/60 rounded-xl px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-slate-200 text-xs font-medium truncate">{item['Type'] || '—'}</p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <div className="flex-1 bg-slate-800 rounded-full h-1 overflow-hidden" style={{ maxWidth: 80 }}>
                          <div className="h-1 rounded-full bg-slate-500" style={{ width: `${share}%` }} />
                        </div>
                        <span className="text-slate-500 text-[9px] font-mono">{share.toFixed(0)}%</span>
                      </div>
                    </div>
                    <span className="text-white font-bold font-mono text-sm tabular-nums shrink-0">{fmt(cost)}</span>
                  </div>
                );
              })}
          </div>
          <div className="flex items-center justify-between pt-2.5 mt-2 border-t border-slate-700/60">
            <div>
              <span className="text-slate-400 text-xs font-semibold">Total / month</span>
              <p className="text-slate-600 text-[9px] font-mono mt-0.5">{totalB > 0 ? `≈ ${fmt(totalB * 12)} / year` : ''}</p>
            </div>
            <span className="text-white font-bold font-mono text-base tabular-nums">{fmt(totalB)}</span>
          </div>
        </div>
      )}

      {open && (
        <div className="p-3 space-y-2 bg-slate-950/30">
          {items.map(item => (
            <CategoryItemCard
              key={item._rowNum}
              item={item}
              allocated={allocByType[item['Type'] || ''] || 0}
              budgeted={itemGoal(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const CAT_ORDER = ['Essentials', 'Stability', 'Discretionary', 'Subscription'];

// ── By Category view ──────────────────────────────────────────────────────────

function CategoryView({ items, allocTx, gasBalanceAllTime = 0 }) {
  const [showSavings, setShowSavings] = useState(false);

  const allocByType = useMemo(() => {
    const map = {};
    allocTx.forEach(tx => {
      if (tx.amount > 0) map[tx.type] = (map[tx.type] || 0) + tx.amount;
    });
    // Gas tracks an all-time running balance, not just this month's deposits.
    const gasKey = Object.keys(map).find(k => isGasType(k));
    const gasName = items.find(i => isGasType(i['Type']))?.['Type'];
    if (gasName) map[gasName] = Math.max(0, gasBalanceAllTime);
    else if (gasKey) map[gasKey] = Math.max(0, gasBalanceAllTime);
    return map;
  }, [allocTx, gasBalanceAllTime, items]);

  const mainItems    = items.filter(i => i['Expense'] !== 'Savings');
  const savingsItems = items.filter(i => i['Expense'] === 'Savings');

  const groups = useMemo(() => {
    const map = {};
    mainItems.forEach(item => {
      const cat = item['Expense'] || 'Other';
      if (!map[cat]) map[cat] = [];
      map[cat].push(item);
    });
    return map;
  }, [mainItems]);

  const orderedKeys = [
    ...CAT_ORDER.filter(k => groups[k]),
    ...Object.keys(groups).filter(k => !CAT_ORDER.includes(k)),
  ];

  const totalB  = mainItems.reduce((s, i) => s + itemGoal(i), 0);
  const totalA  = mainItems.reduce((s, i) => s + (allocByType[i['Type'] || ''] || 0), 0);
  const overAll = totalA > totalB && totalB > 0;
  const pctAll  = totalB > 0 ? Math.min((totalA / totalB) * 100, 100) : 0;

  const savingsB = savingsItems.reduce((s, i) => s + pm(i['Monthly Allowance ($)']), 0);
  const savingsA = savingsItems.reduce((s, i) => s + (allocByType[i['Type'] || ''] || 0), 0);

  return (
    <div className="space-y-4">
      {/* (Funding status now lives in the page-level banner above the tabs,
          covering both unfunded and partially-funded essentials.) */}

      {/* Summary bar */}
      <div className="bg-slate-900 rounded-2xl p-4">
        {totalA === 0 && totalB > 0 && (
          <p className="text-slate-500 text-xs mb-3">
            No allocations logged yet this month. Process income from the Dashboard to populate these amounts.
          </p>
        )}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">Budgeted</p>
            <p className="text-white text-lg font-bold font-mono mt-0.5">{fmt(totalB)}</p>
          </div>
          <div>
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">Allocated</p>
            <p className={`text-lg font-bold font-mono mt-0.5 ${overAll ? 'text-rose-400' : 'text-emerald-400'}`}>
              {fmt(totalA)}
            </p>
          </div>
          <div>
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">Remaining</p>
            <p className={`text-lg font-bold font-mono mt-0.5 ${overAll ? 'text-rose-400' : 'text-sky-400'}`}>
              {fmt(Math.abs(totalB - totalA))}{overAll ? ' over' : ''}
            </p>
          </div>
        </div>
        <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
          <div className="h-2 rounded-full transition-all"
            style={{ width: `${pctAll}%`, background: overAll ? '#ef4444' : '#10b981' }} />
        </div>
        <p className="text-slate-500 text-[10px] font-mono mt-1">{pctAll.toFixed(0)}% funded this month</p>
      </div>

      {/* Expense-type groups */}
      {orderedKeys.map(cat => (
        <CategoryGroup key={cat} label={cat} items={groups[cat]} allocByType={allocByType} />
      ))}

      {/* Savings — shown separately, collapsible */}
      {savingsItems.length > 0 && (
        <div className="rounded-2xl border border-emerald-900/40 overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 bg-emerald-950/40 active:opacity-80"
            onClick={() => setShowSavings(s => !s)}
          >
            <div className="flex items-center gap-2">
              <span className="text-base">🐷</span>
              <span className="text-emerald-300 font-semibold text-sm">Savings</span>
              <span className="text-emerald-700 text-xs">· separate</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 font-mono text-sm">
                {fmt(savingsA)}
                <span className="text-emerald-700 text-xs font-normal"> / {fmt(savingsB)}</span>
              </span>
              <span className="text-emerald-600 text-xs">{showSavings ? '▲' : '▼'}</span>
            </div>
          </button>
          {showSavings && (
            <div className="p-3 space-y-2 bg-emerald-950/20">
              {savingsItems.map(item => (
                <CategoryItemCard
                  key={item._rowNum}
                  item={item}
                  allocated={allocByType[item['Type'] || ''] || 0}
                  budgeted={pm(item['Monthly Allowance ($)'])}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── All Entries view ──────────────────────────────────────────────────────────

function AllEntriesView({ allocTx }) {
  const sorted = useMemo(
    () => [...allocTx].sort((a, b) => (b.dateObj?.getTime() || 0) - (a.dateObj?.getTime() || 0)),
    [allocTx]
  );

  if (!sorted.length) {
    return (
      <div className="bg-slate-900 rounded-xl p-6 text-center">
        <p className="text-slate-400 text-sm">No allocation entries this month yet.</p>
        <p className="text-slate-600 text-xs mt-1">Process income to see entries here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-slate-500 text-[10px] uppercase tracking-wider px-1">{sorted.length} entries this month</p>
      {sorted.map((tx, i) => (
        <div key={i} className="bg-slate-900 rounded-xl p-3.5 flex items-center justify-between gap-3 border border-slate-800/40">
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-medium truncate">{tx.type || '—'}</p>
            {tx.desc && <p className="text-slate-500 text-[10px] truncate mt-0.5">{tx.desc}</p>}
            <p className="text-slate-600 text-[10px] mt-0.5">
              {tx.account && <span>{tx.account} · </span>}
              {tx.dateObj ? tx.dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
            </p>
          </div>
          <div className="text-right shrink-0">
            <span className={`font-bold font-mono text-sm ${tx.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {tx.amount >= 0 ? '+' : ''}{fmt(tx.amount)}
            </span>
            {tx.done && <p className="text-[10px] text-slate-600 mt-0.5">✓ done</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Spending Calendar Heatmap (Task 24) ──────────────────────────────────────
// Month grid (7 cols × up to 6 week-rows). Each day cell is graded slate→rose by
// the magnitude of that day's actual spend; days where income/allocation deposits
// dominate are tinted teal instead, so funding days read differently from spend
// days. Reuses allAllocTx (already loaded by Budget) — zero new API calls.
// Tap any day to expand a panel listing that day's transactions.
const HEAT_ROSE = ['#1e293b', '#4c1d2b', '#9f1239', '#f43f5e']; // tier 0..3 spend
const HEAT_TEAL = ['#1e293b', '#134e4a', '#0f766e', '#14b8a6']; // tier 0..3 income
const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function SpendingHeatmap({ allAllocTx }) {
  const now = new Date();
  const [open, setOpen]     = useState(false);
  const [year, setYear]     = useState(now.getFullYear());
  const [month, setMonth]   = useState(now.getMonth()); // 0-indexed
  const [selDay, setSelDay] = useState(null);

  // Bucket the selected month's transactions by day-of-month.
  const { byDay, maxMag } = useMemo(() => {
    const map = {}; // day -> { spend, inflow, txs: [] }
    allAllocTx.forEach(tx => {
      const d = tx.dateObj;
      if (!d || d.getFullYear() !== year || d.getMonth() !== month) return;
      const day = d.getDate();
      if (!map[day]) map[day] = { spend: 0, inflow: 0, txs: [] };
      if (tx.amount < 0) map[day].spend += -tx.amount;
      else map[day].inflow += tx.amount;
      map[day].txs.push(tx);
    });
    let mx = 0;
    Object.values(map).forEach(o => { mx = Math.max(mx, o.spend, o.inflow); });
    return { byDay: map, maxMag: mx };
  }, [allAllocTx, year, month]);

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow    = new Date(year, month, 1).getDay();
  const monthLabel  = new Date(year, month, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();

  // 4 intensity tiers from the day's share of the month's busiest day.
  function tier(mag) {
    if (mag <= 0 || maxMag <= 0) return 0;
    const f = mag / maxMag;
    if (f <= 0.33) return 1;
    if (f <= 0.66) return 2;
    return 3;
  }

  function step(delta) {
    setSelDay(null);
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonth(m); setYear(y);
  }

  // Build grid cells: leading blanks for the first week, then each day number.
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const sel = selDay != null ? byDay[selDay] : null;
  const monthSpend  = Object.values(byDay).reduce((s, o) => s + o.spend, 0);
  const monthInflow = Object.values(byDay).reduce((s, o) => s + o.inflow, 0);

  return (
    <div className="bg-slate-900 rounded-2xl border border-slate-800/60 overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 active:opacity-80"
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-white font-semibold text-sm">📅 Spending Calendar</span>
        <span className="text-slate-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => step(-1)}
              className="w-8 h-8 rounded-lg bg-slate-800 text-slate-300 hover:text-white active:opacity-70 text-sm"
            >‹</button>
            <div className="text-center">
              <p className="text-white text-sm font-medium">{monthLabel}</p>
              <p className="text-slate-500 text-[10px] font-mono mt-0.5">
                <span className="text-rose-400">{fmt(monthSpend)} spent</span>
                {monthInflow > 0 && <span className="text-teal-400"> · {fmt(monthInflow)} in</span>}
              </p>
            </div>
            <button
              onClick={() => step(1)}
              disabled={isCurrentMonth}
              className="w-8 h-8 rounded-lg bg-slate-800 text-slate-300 hover:text-white active:opacity-70 text-sm disabled:opacity-30"
            >›</button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DOW_LABELS.map((d, i) => (
              <div key={i} className="text-center text-[9px] text-slate-600 font-medium">{d}</div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => {
              if (d == null) return <div key={`b${i}`} className="aspect-square" />;
              const info     = byDay[d];
              const spend    = info?.spend || 0;
              const inflow   = info?.inflow || 0;
              const mag      = Math.max(spend, inflow);
              const isIncome = inflow > spend;
              const t        = tier(mag);
              const bg       = t === 0 ? '#1e293b' : (isIncome ? HEAT_TEAL[t] : HEAT_ROSE[t]);
              const hasBoth  = spend > 0 && inflow > 0;
              const dotColor = isIncome ? '#f43f5e' : '#14b8a6';
              const isToday  = isCurrentMonth && d === now.getDate();
              const selected = selDay === d;
              return (
                <button
                  key={d}
                  onClick={() => setSelDay(selected ? null : d)}
                  className="relative aspect-square rounded-lg flex items-center justify-center transition-all active:scale-95"
                  style={{
                    background: bg,
                    outline: selected ? '2px solid #38bdf8' : isToday ? '1px solid #475569' : 'none',
                    outlineOffset: selected ? '-2px' : '-1px',
                  }}
                  title={mag > 0 ? `${d}: ${fmt(spend)} spent${inflow > 0 ? `, ${fmt(inflow)} in` : ''}` : String(d)}
                >
                  <span className={`text-[11px] font-mono ${t >= 2 ? 'text-white' : 'text-slate-400'}`}>{d}</span>
                  {hasBoth && (
                    <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full"
                      style={{ background: dotColor }} />
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-between mt-3 text-[9px] text-slate-500">
            <div className="flex items-center gap-1">
              <span>less</span>
              {HEAT_ROSE.map((c, i) => (
                <span key={i} className="w-3 h-3 rounded" style={{ background: c }} />
              ))}
              <span>more spend</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-3 h-3 rounded" style={{ background: HEAT_TEAL[3] }} />
              <span>income day</span>
            </div>
          </div>

          {/* Selected-day detail panel */}
          {sel && (
            <div className="mt-3 bg-slate-950/60 rounded-xl border border-slate-800/60 p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-white text-xs font-semibold">
                  {new Date(year, month, selDay).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </p>
                <div className="text-right">
                  {sel.spend > 0 && <span className="text-rose-400 text-[11px] font-mono">{fmt(sel.spend)} spent</span>}
                  {sel.inflow > 0 && <span className="text-teal-400 text-[11px] font-mono ml-2">{fmt(sel.inflow)} in</span>}
                </div>
              </div>
              <div className="space-y-1.5">
                {sel.txs.map((tx, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex-1 min-w-0">
                      <span className="text-slate-200">{tx.type || '—'}</span>
                      {tx.desc && <span className="text-slate-600 truncate"> · {tx.desc}</span>}
                    </div>
                    <span className={`font-mono shrink-0 ${tx.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {tx.amount >= 0 ? '+' : ''}{fmt(tx.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {maxMag === 0 && (
            <p className="text-slate-600 text-[11px] text-center mt-3">No transactions this month.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sparkline mini bar chart ─────────────────────────────────────────────────

function Sparkline({ values, color }) {
  const max = Math.max(...values, 1);
  const bars = values.length;
  const W = 48, H = 24, gap = 3;
  const barW = (W - gap * (bars - 1)) / bars;
  return (
    <svg width={W} height={H} className="shrink-0">
      {values.map((v, i) => {
        const h = Math.max((v / max) * (H - 2), v > 0 ? 3 : 0);
        return (
          <rect key={i} x={i * (barW + gap)} y={H - h} width={barW} height={h}
            rx={2} fill={i === bars - 1 ? color : `${color}55`} />
        );
      })}
    </svg>
  );
}

// ── Trends view ───────────────────────────────────────────────────────────────

function TrendsView({ allAllocTx, expenses }) {
  const now = new Date();

  const periods = useMemo(() => (
    [0, 1, 2].map(offset => {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      return { mo: d.getMonth() + 1, yr: d.getFullYear(), label: MONTHS[d.getMonth()] };
    })
  ), []);

  const grouped = useMemo(() => {
    const result = {};
    allAllocTx.forEach(tx => {
      const key = `${tx.dateObj.getFullYear()}-${tx.dateObj.getMonth() + 1}`;
      if (!result[key]) result[key] = {};
      result[key][tx.type] = (result[key][tx.type] || 0) + tx.amount;
    });
    return result;
  }, [allAllocTx]);

  const pKeys   = periods.map(p => `${p.yr}-${p.mo}`);
  const pTotals = pKeys.map(k => Object.values(grouped[k] || {}).reduce((s, v) => s + v, 0));
  const delta   = pTotals[0] - pTotals[1];

  const expenseMap = useMemo(() => {
    const map = {};
    expenses.forEach(item => {
      map[item['Type']] = {
        budgeted: pm(item['Monthly Allowance ($)']),
        category: item['Expense'] || 'Other',
      };
    });
    return map;
  }, [expenses]);

  const activeTypes = useMemo(() => {
    const seen = new Set();
    pKeys.forEach(k => Object.keys(grouped[k] || {}).forEach(t => seen.add(t)));
    expenses.filter(i => i['Expense'] !== 'Savings').forEach(i => seen.add(i['Type']));
    return [...seen].filter(t => expenseMap[t]);
  }, [grouped, pKeys, expenses, expenseMap]);

  const categoryGroups = useMemo(() => {
    const map = {};
    activeTypes.forEach(type => {
      const cat = expenseMap[type]?.category || 'Other';
      if (!map[cat]) map[cat] = [];
      map[cat].push(type);
    });
    return map;
  }, [activeTypes, expenseMap]);

  const orderedCats = [
    ...CAT_ORDER.filter(k => categoryGroups[k]),
    ...Object.keys(categoryGroups).filter(k => !CAT_ORDER.includes(k)),
  ];

  if (!allAllocTx.length) {
    return (
      <div className="bg-slate-900 rounded-xl p-6 text-center">
        <p className="text-slate-400 text-sm">No transaction history yet.</p>
        <p className="text-slate-600 text-xs mt-1">Process income to see trends.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 3-month summary */}
      <div className="bg-slate-900 rounded-2xl p-4">
        <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-3 font-broske">3-Month Overview</p>
        <div className="grid grid-cols-3 gap-3 mb-3">
          {periods.map((p, i) => (
            <div key={i} className={i > 0 ? 'opacity-60' : ''}>
              <p className="text-slate-500 text-[10px]">{p.label}</p>
              <p className={`text-sm font-bold font-mono mt-0.5 ${i === 0 ? 'text-white' : 'text-slate-400'}`}>
                {fmt(pTotals[i])}
              </p>
            </div>
          ))}
        </div>
        <div className={`flex items-center gap-1.5 text-sm font-medium ${
          delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-slate-400' : 'text-slate-600'
        }`}>
          <span>{delta > 0 ? '▲' : delta < 0 ? '▼' : '—'}</span>
          <span>
            {delta !== 0
              ? `${fmt(Math.abs(delta))} ${delta > 0 ? 'more' : 'less'} allocated than last month`
              : 'Same as last month'}
          </span>
        </div>
        <div className="mt-3">
          <Sparkline values={[pTotals[2], pTotals[1], pTotals[0]]} color="#3b82f6" />
        </div>
      </div>

      {/* Per-category breakdown */}
      {orderedCats.map(cat => {
        const color     = CAT_COLORS[cat] || '#64748b';
        const types     = categoryGroups[cat];
        const catTotals = pKeys.map(k => types.reduce((s, t) => s + (grouped[k]?.[t] || 0), 0));
        const catDelta  = catTotals[0] - catTotals[1];

        return (
          <div key={cat} className="rounded-2xl border border-slate-800/50 overflow-hidden">
            <div className="px-4 py-3 bg-slate-900/80 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                <span className="text-white font-semibold text-sm">{cat}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-mono ${
                  catDelta > 0 ? 'text-emerald-400' : catDelta < 0 ? 'text-slate-500' : 'text-slate-700'
                }`}>
                  {catDelta !== 0
                    ? `${catDelta > 0 ? '▲' : '▼'} ${fmt(Math.abs(catDelta))}`
                    : '—'}
                </span>
                <span className="text-white font-mono text-sm font-bold">{fmt(catTotals[0])}</span>
              </div>
            </div>
            <div className="p-3 space-y-2 bg-slate-950/30">
              {types.map(type => {
                const vals    = pKeys.map(k => grouped[k]?.[type] || 0);
                const typeDelta  = vals[0] - vals[1];
                const budgeted   = expenseMap[type]?.budgeted || 0;
                const over       = vals[0] > budgeted && budgeted > 0;

                return (
                  <div key={type} className="bg-slate-900 rounded-xl p-3 flex items-center gap-3 border border-slate-800/40">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{type}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className={`text-sm font-bold font-mono ${over ? 'text-rose-400' : 'text-white'}`}>
                          {fmt(vals[0])}
                        </span>
                        <span className={`text-[11px] font-mono ${
                          typeDelta > 0 ? 'text-emerald-400' : typeDelta < 0 ? 'text-slate-500' : 'text-slate-700'
                        }`}>
                          {typeDelta > 0 ? `▲ ${fmt(typeDelta)}` : typeDelta < 0 ? `▼ ${fmt(Math.abs(typeDelta))}` : '—'}
                        </span>
                        {over && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-900/60 text-rose-300">over!</span>
                        )}
                      </div>
                      {budgeted > 0 && (
                        <p className="text-slate-600 text-[10px] font-mono mt-0.5">
                          budget {fmt(budgeted)} · prev {fmt(vals[1])}
                        </p>
                      )}
                    </div>
                    <Sparkline
                      values={[vals[2], vals[1], vals[0]]}
                      color={over ? '#ef4444' : color}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'budget',     label: 'Budget' },
  { key: 'categories', label: 'Categories' },
  { key: 'entries',    label: 'Entries & Trends' },
];

function TabBar({ active, onChange }) {
  return (
    <div className="flex bg-slate-900 rounded-xl p-1 gap-1">
      {TABS.map(tab => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${
            active === tab.key
              ? 'bg-blue-600 text-white'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Budget({ token }) {
  const [items, setItems]         = useState([]);
  const [headers, setHeaders]     = useState([]);
  const [pi, setPi]               = useState(0);
  const [allocTx, setAllocTx]       = useState([]);
  const [allAllocTx, setAllAllocTx] = useState([]);
  const [gasBudget, setGasBudget]   = useState(() => getGasBudget()?.value ?? null);
  const [activeTab, setActiveTab]   = useState('budget');
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [gasOnHand, setGasOnHand] = useState(null); // authoritative Gas balance from Allocation Summary
  const [editItem, setEditItem]   = useState(null);
  const [isAddNew, setIsAddNew]   = useState(false);
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const now          = new Date();
    const mo           = now.getMonth() + 1;
    const yr           = now.getFullYear();
    const currentMonth = MONTHS[now.getMonth()];
    const currentYear  = String(yr);

    try {
      const [expRows, summaryRows, txRows, allocSumRows] = await Promise.all([
        readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A1:T50`),
        readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A1:P13`),
        readRange(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A:F`, 'UNFORMATTED_VALUE'),
        readRange(token, 'Allocation Summary!A1:B10', 'UNFORMATTED_VALUE'),
      ]);

      // Authoritative gas balance on hand — the same source the Summary screen reads.
      // Budget previously re-derived this by summing every gas transaction ever logged,
      // which overstates the balance when fill-ups aren't logged as negative rows.
      if (allocSumRows?.length) {
        const gasRow = allocSumRows.find(r => String(r[0]).trim().toLowerCase() === 'gas');
        setGasOnHand(gasRow ? (pm(gasRow[1]) || 0) : null);
      }

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

      if (txRows.length > 1) {
        const [, ...data] = txRows;
        const allTx = data
          .filter(r => r[0] && r[1])
          .map(r => {
            const dateObj = parseSheetDate(r[0]);
            return {
              dateObj,
              type:    String(r[1] || ''),
              amount:  pm(r[2]),
              desc:    String(r[3] || ''),
              account: String(r[4] || ''),
              done:    !!r[5],
            };
          })
          .filter(tx => tx.dateObj);
        setAllAllocTx(allTx);
        setAllocTx(allTx.filter(tx => tx.dateObj.getMonth() + 1 === mo && tx.dateObj.getFullYear() === yr));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  // Keep the dynamic gas budget fresh (cached 1 h by fetchGasPrices, so cheap).
  useEffect(() => {
    let cancelled = false;
    fetchGasPrices()
      .then(gas => {
        if (cancelled || !gas) return;
        const nyc = gas.byRegion['Y35NY']?.products['EPMR']?.value;
        if (!nyc || nyc <= 0) return;
        const cachedMpg = getGasBudget()?.mpg;
        const budget = computeGasBudget({ gasPerGal: nyc, mpg: cachedMpg });
        if (budget) {
          setGasBudget(budget);
          saveGasBudget(budget, { gasPerGal: nyc, ...(cachedMpg ? { mpg: cachedMpg } : {}) });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

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

  function openEdit(item) { setIsAddNew(false); setEditItem(item); }
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

  // ── Funding status (this month) — based ONLY on positive allocations/deposits,
  // never on Actual Spend. Lets the user see which essentials are not yet funded
  // vs. starting to be funded (partial), independent of which tab they're on.
  const fundingByType = {};
  allocTx.forEach(tx => { if (tx.amount > 0) fundingByType[tx.type] = (fundingByType[tx.type] || 0) + tx.amount; });

  // Gas is special: it uses a running balance on hand, not monthly deposits, and its
  // goal is the live dynamic budget (~$185), not the sheet $120. Prefer the authoritative
  // Allocation Summary "Gas" row (what the Summary screen shows); only fall back to summing
  // every gas transaction when that row isn't available.
  const gasBalanceAllTime = (gasOnHand != null)
    ? gasOnHand
    : allAllocTx
        .filter(tx => String(tx.type).trim().toLowerCase() === 'gas')
        .reduce((s, tx) => s + tx.amount, 0);
  const isGas = i => String(i['Type'] || '').trim().toLowerCase() === 'gas';
  // Effective goal & funded amount for an item, with gas overrides applied.
  const effGoal = i => (isGas(i) && gasBudget > 0) ? gasBudget : pm(i['Monthly Allowance ($)']);
  const effFunded = i => isGas(i) ? Math.max(0, gasBalanceAllTime) : (fundingByType[i['Type'] || ''] || 0);

  const essentialItems = items.filter(i =>
    String(i['Priority'] ?? '3') === '1' &&
    effGoal(i) > 0 &&
    i['Expense'] !== 'Savings'
  );
  const unfundedEssentials = essentialItems.filter(i => !(effFunded(i) > 0));
  const partialEssentials  = essentialItems.filter(i => {
    const a = effFunded(i);
    const b = effGoal(i);
    return a > 0 && a < b - 0.005;
  });

  return (
    <div className="pb-24">

      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Budget</h1>
          <p className="text-slate-500 text-xs mt-0.5">
            {activeTab === 'budget'     ? 'Plan vs. actual spend · tap any item to edit' :
             activeTab === 'categories' ? 'Funded this month (deposits) vs. goal' :
             activeTab === 'entries'    ? 'Allocation entries + month-over-month trends' :
             'Allocation actuals vs. plan'}
          </p>
        </div>
        {activeTab === 'budget' && (
          <button
            onClick={() => openAdd('2')}
            className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-colors"
          >
            + Add
          </button>
        )}
      </div>

      {/* Funding status banner — which essentials are unfunded / partially funded.
          Visible on every tab; based on deposits, NOT spending. */}
      {(unfundedEssentials.length > 0 || partialEssentials.length > 0) && (
        <div className="px-4 mb-4">
          <div className="rounded-2xl border border-amber-800/50 bg-amber-950/30 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-amber-900/40 flex items-center justify-between gap-2">
              <p className="text-amber-300 text-xs font-bold uppercase tracking-wide">
                ⚡ Essential funding · {essentialItems.length - unfundedEssentials.length}/{essentialItems.length} started
              </p>
              {activeTab !== 'categories' && (
                <button
                  onClick={() => setActiveTab('categories')}
                  className="text-amber-400 hover:text-amber-300 text-[11px] font-semibold underline underline-offset-2 shrink-0"
                >
                  details →
                </button>
              )}
            </div>

            {unfundedEssentials.length > 0 && (
              <div className="px-4 py-2.5">
                <p className="text-rose-300/90 text-[10px] font-semibold uppercase tracking-wider mb-1.5">
                  Not yet funded ({unfundedEssentials.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {unfundedEssentials.map(item => (
                    <span key={item._rowNum} className="text-rose-200 bg-rose-900/50 border border-rose-800/40 text-xs px-2 py-1 rounded-lg">
                      <span className="font-medium">{item['Type']}</span>
                      <span className="text-rose-400/80 ml-1.5 font-mono">$0 / {fmt(effGoal(item))}</span>
                      {item['Account'] && <span className="text-rose-500/60 ml-1.5 text-[10px]">→ {item['Account']}</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {partialEssentials.length > 0 && (
              <div className="px-4 py-2.5 border-t border-amber-900/30">
                <p className="text-amber-300/90 text-[10px] font-semibold uppercase tracking-wider mb-1.5">
                  Starting to be funded ({partialEssentials.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {partialEssentials.map(item => {
                    const a = effFunded(item);
                    const b = effGoal(item);
                    const p = b > 0 ? Math.round((a / b) * 100) : 0;
                    return (
                      <span key={item._rowNum} className="text-amber-200 bg-amber-900/40 border border-amber-800/40 text-xs px-2 py-1 rounded-lg">
                        <span className="font-medium">{item['Type']}</span>
                        <span className="text-amber-400/80 ml-1.5 font-mono">{fmt(a)} / {fmt(b)}</span>
                        <span className="text-amber-500/70 ml-1.5">{p}%</span>
                        {item['Account'] && <span className="text-amber-600/60 ml-1.5 text-[10px]">→ {item['Account']}</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="px-4 mb-4">
        <TabBar active={activeTab} onChange={setActiveTab} />
      </div>

      <div className="px-4 space-y-4">

        {/* ── Budget Plan tab (original view) ── */}
        {activeTab === 'budget' && (
          <>
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
                  <p className="text-slate-600 text-[9px] mt-0.5 leading-tight">tap a card below to log</p>
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

            <AllocationDonut items={items} total={totalAllowance} />
            <PriorityChart items={items} />

            {saveError && (
              <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-sm">{saveError}</div>
            )}

            <div className="stagger space-y-3">
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
          </>
        )}

        {/* ── By Category tab ── */}
        {activeTab === 'categories' && (
          <CategoryView items={items} allocTx={allocTx} gasBalanceAllTime={gasBalanceAllTime} />
        )}

        {/* ── Entries & Trends tab ── */}
        {activeTab === 'entries' && (
          <>
            <TrendsView allAllocTx={allAllocTx} expenses={items} />
            <SpendingHeatmap allAllocTx={allAllocTx} />
            <AllEntriesView allocTx={allocTx} />
          </>
        )}

      </div>

      {/* Edit / Add drawer (Budget Plan tab only) */}
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
