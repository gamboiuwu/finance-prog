import { useEffect, useState } from 'react';
import { readRange, appendRow } from '../lib/sheets';
import { SHEETS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const ACCOUNTS = ['Cash', 'Checking', 'Savings', 'Outside Payment', 'Business Tax', 'Subscription', 'Liabilities'];

function parseAmount(val) {
  if (val == null || val === '') return 0;
  const s = String(val).trim();
  // Accounting notation: (45.67) means negative
  const isNeg = (s.startsWith('(') && s.endsWith(')')) || s.startsWith('-');
  const clean = s.replace(/[$,\s()]/g, '').replace(/^-/, '');
  const n = parseFloat(clean);
  if (isNaN(n)) return 0;
  return isNeg ? -n : n;
}

function fmtDate(val) {
  if (!val) return '';
  // already a formatted string like "2/27/2026"
  return val;
}

function AddModal({ categories, onSave, onClose }) {
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const [form, setForm] = useState({
    date: today,
    category: categories[0] || '',
    adjustment: '',
    description: '',
    account: 'Checking',
    status: 'FALSE',
  });

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.adjustment || isNaN(parseFloat(form.adjustment))) return;
    onSave([
      form.date,
      form.category,
      parseFloat(form.adjustment),
      form.description,
      form.account,
      form.status === 'TRUE',
    ]);
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-md p-5 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-white font-semibold text-lg">New Transaction</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-slate-400 text-xs block mb-1">Date</label>
            <input
              type="text"
              value={form.date}
              onChange={e => set('date', e.target.value)}
              placeholder="MM/DD/YYYY"
              className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <div>
            <label className="text-slate-400 text-xs block mb-1">Category</label>
            <input
              list="categories-list"
              value={form.category}
              onChange={e => set('category', e.target.value)}
              className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <datalist id="categories-list">
              {categories.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>

          <div>
            <label className="text-slate-400 text-xs block mb-1">Amount (negative = expense)</label>
            <input
              type="number"
              step="0.01"
              value={form.adjustment}
              onChange={e => set('adjustment', e.target.value)}
              placeholder="-45.00"
              className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <div>
            <label className="text-slate-400 text-xs block mb-1">Description</label>
            <input
              type="text"
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="What was this for?"
              className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-slate-400 text-xs block mb-1">Account</label>
            <select
              value={form.account}
              onChange={e => set('account', e.target.value)}
              className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            >
              {ACCOUNTS.map(a => <option key={a}>{a}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-slate-400 text-xs">Completed</label>
            <button
              type="button"
              onClick={() => set('status', form.status === 'TRUE' ? 'FALSE' : 'TRUE')}
              className={`w-12 h-6 rounded-full transition-colors ${form.status === 'TRUE' ? 'bg-emerald-500' : 'bg-slate-600'} relative`}
            >
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${form.status === 'TRUE' ? 'translate-x-7' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-slate-700 text-slate-300 text-sm font-medium">
              Cancel
            </button>
            <button type="submit" className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium">
              Add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Transactions({ token }) {
  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([
      readRange(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A1:F200`),
      readRange(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!C1:C200`, 'UNFORMATTED_VALUE'),
    ])
      .then(([data, rawAmts]) => {
        if (!data.length) return;
        const [, ...txRows] = data;
        const [, ...rawAmtRows] = rawAmts;
        // Patch column C with raw signed numeric value so currency formatting can't strip the minus sign
        const patched = txRows.map((row, i) => {
          const r = [...row];
          r[2] = rawAmtRows[i]?.[0] ?? row[2];
          return r;
        });
        setRows(patched.filter(r => r[0]).reverse());
        setCategories([...new Set(txRows.map(r => r[1]).filter(Boolean))]);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { if (token) load(); }, [token]);

  async function handleSave(values) {
    setSaving(true);
    try {
      await appendRow(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A:F`, values);
      setShowModal(false);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;

  const totalSpent    = rows.filter(r => parseAmount(r[2]) < 0).reduce((s, r) => s + Math.abs(parseAmount(r[2])), 0);
  const totalReceived = rows.filter(r => parseAmount(r[2]) > 0).reduce((s, r) => s + parseAmount(r[2]), 0);
  const net           = totalReceived - totalSpent;

  return (
    <div className="p-4 pb-24 space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-white">Transactions</h1>
          <p className="text-slate-400 text-sm">Allocation log</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="bg-blue-600 hover:bg-blue-500 text-white rounded-xl px-4 py-2 text-sm font-medium"
        >
          + Add
        </button>
      </div>

      {/* Summary strip */}
      {rows.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-slate-800 rounded-xl p-3 text-center">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">Received</p>
            <p className="text-emerald-400 font-bold text-sm mt-0.5">${totalReceived.toFixed(2)}</p>
          </div>
          <div className="bg-slate-800 rounded-xl p-3 text-center">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">Spent</p>
            <p className="text-rose-400 font-bold text-sm mt-0.5">${totalSpent.toFixed(2)}</p>
          </div>
          <div className="bg-slate-800 rounded-xl p-3 text-center">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">Net</p>
            <p className={`font-bold text-sm mt-0.5 ${net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{net >= 0 ? '+' : '-'}${Math.abs(net).toFixed(2)}</p>
          </div>
        </div>
      )}

      {/* ── Charts ─────────────────────────────────────────── */}
      {rows.length > 0 && (() => {
        // Category breakdown (expenses only)
        const catMap = {};
        rows.forEach(r => {
          const amt = parseAmount(r[2]);
          if (amt >= 0) return;
          const cat = r[1] || 'Other';
          catMap[cat] = (catMap[cat] || 0) + Math.abs(amt);
        });
        const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
        const top5 = sorted.slice(0, 5);
        const otherSum = sorted.slice(5).reduce((s, [, v]) => s + v, 0);
        const catData = [...top5.map(([name, value]) => ({ name, value })), ...(otherSum > 0 ? [{ name: 'Other', value: otherSum }] : [])];
        const CAT_COLORS = ['#3b82f6','#f43f5e','#f59e0b','#10b981','#8b5cf6','#64748b'];

        // Monthly spending (expenses only)
        const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const monthMap = {};
        rows.forEach(r => {
          const amt = parseAmount(r[2]);
          if (amt >= 0 || !r[0]) return;
          const parts = String(r[0]).split('/');
          if (parts.length < 2) return;
          const label = MONTH_NAMES[(parseInt(parts[0], 10) - 1)] ?? parts[0];
          monthMap[label] = (monthMap[label] || 0) + Math.abs(amt);
        });
        const monthData = Object.entries(monthMap).map(([month, spent]) => ({ month, spent }));

        return (
          <>
            {catData.length > 0 && (
              <div className="bg-slate-800 rounded-2xl p-4">
                <p className="text-slate-300 font-medium text-sm mb-3">Spending by Category</p>
                <div className="flex gap-4 items-center">
                  <PieChart width={130} height={130}>
                    <Pie data={catData} cx={65} cy={65} innerRadius={38} outerRadius={60} dataKey="value" stroke="none">
                      {catData.map((_, i) => <Cell key={i} fill={CAT_COLORS[i % CAT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontSize: 12 }} formatter={v => [`$${v.toFixed(2)}`]} />
                  </PieChart>
                  <div className="flex-1 space-y-1.5">
                    {catData.map((d, i) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CAT_COLORS[i % CAT_COLORS.length] }} />
                          <span className="text-slate-300 text-xs truncate">{d.name}</span>
                        </div>
                        <span className="text-slate-400 text-xs font-mono shrink-0">${d.value.toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {monthData.length > 1 && (
              <div className="bg-slate-800 rounded-2xl p-4">
                <p className="text-slate-300 font-medium text-sm mb-3">Monthly Spending</p>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={monthData} barCategoryGap="35%">
                    <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} formatter={v => [`$${v.toFixed(2)}`, 'Spent']} />
                    <Bar dataKey="spent" fill="#f43f5e" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        );
      })()}

      <div className="space-y-2">
        {rows.map((row, i) => {
          const amount = parseAmount(row[2]);
          const isCredit = amount > 0;
          const status = row[5];
          return (
            <div key={i} className="bg-slate-800 rounded-xl p-3 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm font-bold ${isCredit ? 'bg-emerald-900/50 text-emerald-400' : 'bg-rose-900/50 text-rose-400'}`}>
                {isCredit ? '↑' : '↓'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline gap-2">
                  <p className="text-white text-sm font-medium truncate">{row[1]}</p>
                  <span className={`text-base font-bold font-mono tabular-nums shrink-0 ${isCredit ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {isCredit ? '+' : '-'}${Math.abs(amount).toFixed(2)}
                  </span>
                </div>
                <div className="flex gap-2 mt-0.5 flex-wrap items-center">
                  <span className="text-slate-500 text-xs">{fmtDate(row[0])}</span>
                  {row[4] && <span className="text-xs px-1.5 py-0.5 bg-slate-700 text-slate-400 rounded">{row[4]}</span>}
                  {status === 'TRUE' || status === true
                    ? <span className="text-xs text-emerald-500">✓ done</span>
                    : <span className="text-xs text-slate-600">pending</span>
                  }
                </div>
                {row[3] && <p className="text-slate-400 text-xs mt-0.5 truncate">{row[3]}</p>}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <p className="text-slate-500 text-center py-8">No transactions yet</p>}
      </div>

      {showModal && (
        <AddModal
          categories={categories}
          onSave={handleSave}
          onClose={() => setShowModal(false)}
        />
      )}
      {saving && <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"><LoadingSpinner /></div>}
    </div>
  );
}
