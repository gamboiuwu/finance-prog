import { useEffect, useState } from 'react';
import { readRange } from '../lib/sheets';
import { SHEETS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';

const EXPENSE_COLORS = {
  Essentials: 'bg-blue-500',
  Discretionary: 'bg-purple-500',
  Savings: 'bg-emerald-500',
  Stability: 'bg-amber-500',
  Subscription: 'bg-rose-500',
};

const EXPENSE_BADGES = {
  Essentials: 'bg-blue-900/50 text-blue-300',
  Discretionary: 'bg-purple-900/50 text-purple-300',
  Savings: 'bg-emerald-900/50 text-emerald-300',
  Stability: 'bg-amber-900/50 text-amber-300',
  Subscription: 'bg-rose-900/50 text-rose-300',
};

function fmt(val) {
  const n = parseFloat(val);
  return isNaN(n) ? '—' : `$${n.toFixed(2)}`;
}

function BudgetRow({ item }) {
  const allowance = parseFloat(item['Monthly Allowance ($)']) || 0;
  const spent = parseFloat(item['Actual Spend']) || 0;
  const remaining = allowance - spent;
  const pct = allowance > 0 ? Math.min((spent / allowance) * 100, 100) : 0;
  const barColor = EXPENSE_COLORS[item['Expense']] || 'bg-slate-500';
  const overBudget = spent > allowance && allowance > 0;

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-white font-medium text-sm">{item['Type']}</p>
          <div className="flex gap-2 mt-1 flex-wrap">
            {item['Expense'] && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${EXPENSE_BADGES[item['Expense']] || 'bg-slate-700 text-slate-300'}`}>
                {item['Expense']}
              </span>
            )}
            {item['Account'] && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">
                {item['Account']}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-white text-sm font-semibold">{fmt(allowance)}</p>
          <p className={`text-xs ${overBudget ? 'text-rose-400' : 'text-slate-400'}`}>
            {overBudget ? `over by ${fmt(spent - allowance)}` : `${fmt(remaining)} left`}
          </p>
        </div>
      </div>

      {allowance > 0 && (
        <>
          <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${overBudget ? 'bg-rose-500' : barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span>Spent: {fmt(spent)}</span>
            <span>{pct.toFixed(0)}%</span>
          </div>
        </>
      )}

      {item['Subscription Renewing'] && item['Subscription Renewing'] !== '-' && (
        <p className="text-xs text-slate-500">Renews: {item['Subscription Renewing']}</p>
      )}
    </div>
  );
}

const FILTER_OPTIONS = ['All', 'Essentials', 'Discretionary', 'Savings', 'Stability', 'Subscription'];

export default function Budget({ token }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('All');

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A1:T50`)
      .then(rows => {
        if (!rows.length) return;
        const [headers, ...data] = rows;
        const parsed = data
          .filter(r => r[0])
          .map(row => {
            const obj = {};
            headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
            return obj;
          });
        setItems(parsed);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;

  const filtered = filter === 'All' ? items : items.filter(i => i['Expense'] === filter);

  const totalAllowance = items.reduce((s, i) => s + (parseFloat(i['Monthly Allowance ($)']) || 0), 0);
  const totalSpent = items.reduce((s, i) => s + (parseFloat(i['Actual Spend']) || 0), 0);

  return (
    <div className="p-4 space-y-4 pb-24">
      <div>
        <h1 className="text-2xl font-bold text-white">Budget</h1>
        <p className="text-slate-400 text-sm">Monthly expense categories</p>
      </div>

      {/* Summary */}
      <div className="bg-slate-800 rounded-2xl p-4 grid grid-cols-2 gap-4">
        <div>
          <p className="text-slate-400 text-xs uppercase tracking-wider">Total Budget</p>
          <p className="text-white text-xl font-bold mt-1">${totalAllowance.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs uppercase tracking-wider">Total Spent</p>
          <p className="text-rose-400 text-xl font-bold mt-1">${totalSpent.toFixed(2)}</p>
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt}
            onClick={() => setFilter(opt)}
            className={`shrink-0 text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
              filter === opt
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="space-y-3">
        {filtered.map((item, i) => <BudgetRow key={i} item={item} />)}
        {filtered.length === 0 && (
          <p className="text-slate-500 text-center py-8">No items in this category</p>
        )}
      </div>
    </div>
  );
}
