import { useEffect, useState } from 'react';
import { readRange } from '../lib/sheets';
import { SHEETS, MONTHS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

function StatCard({ label, value, sub, color = 'text-white' }) {
  return (
    <div className="bg-slate-800 rounded-2xl p-4 flex flex-col gap-1">
      <span className="text-slate-400 text-xs uppercase tracking-wider">{label}</span>
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-slate-500 text-xs">{sub}</span>}
    </div>
  );
}

function fmt(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return n < 0
    ? `-$${Math.abs(n).toFixed(2)}`
    : `$${n.toFixed(2)}`;
}

export default function Dashboard({ token }) {
  const [summary, setSummary] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const now = new Date();
  const currentMonth = MONTHS[now.getMonth()];
  const currentYear = now.getFullYear();

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A1:P13`)
      .then(rows => {
        if (!rows.length) return;
        const [headers, ...data] = rows;
        // Find current month row
        const row = data.find(r => r[0] === currentMonth && String(r[1]) === String(currentYear));
        if (row) {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
          setSummary(obj);
        }
        // Chart: income vs spent for all months with data
        const chart = data
          .filter(r => r[4] && parseFloat(r[4]) > 0)
          .map(r => ({
            month: r[0]?.slice(0, 3),
            income: parseFloat(r[4]) || 0,
            spent: parseFloat(r[6]) || 0,
          }));
        setChartData(chart);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;

  const income = parseFloat(summary?.['Total Processed Income']) || 0;
  const unprocessed = parseFloat(summary?.['Unprocessed Income']) || 0;
  const spent = parseFloat(summary?.['Total Spent']) || 0;
  const goal = parseFloat(summary?.['Allowance Goal']) || 0;
  const net = income - spent;
  const goalPct = goal > 0 ? Math.min((income / goal) * 100, 100) : 0;
  const spendPct = income > 0 ? Math.min((spent / income) * 100, 100) : 0;

  return (
    <div className="p-4 space-y-5 pb-24">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">{currentMonth} {currentYear}</h1>
        <p className="text-slate-400 text-sm">Monthly Overview</p>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Income"
          value={fmt(income)}
          sub={unprocessed > 0 ? `+${fmt(unprocessed)} unprocessed` : undefined}
          color="text-emerald-400"
        />
        <StatCard
          label="Spent"
          value={fmt(spent)}
          color="text-rose-400"
        />
        <StatCard
          label="Net Flow"
          value={fmt(net)}
          color={net >= 0 ? 'text-emerald-400' : 'text-rose-400'}
        />
        <StatCard
          label="Goal"
          value={fmt(goal)}
          sub={`${goalPct.toFixed(0)}% met`}
          color="text-sky-400"
        />
      </div>

      {/* Budget progress */}
      {goal > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-slate-300 font-medium">Budget Goal Progress</span>
            <span className="text-slate-400">{fmt(income)} / {fmt(goal)}</span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-3 overflow-hidden">
            <div
              className="h-3 rounded-full transition-all duration-500"
              style={{
                width: `${goalPct}%`,
                background: goalPct >= 100 ? '#10b981' : goalPct >= 75 ? '#f59e0b' : '#3b82f6',
              }}
            />
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-300 font-medium">Spend Rate</span>
            <span className="text-slate-400">{fmt(spent)} / {fmt(income)}</span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-3 overflow-hidden">
            <div
              className="h-3 rounded-full transition-all duration-500"
              style={{
                width: `${spendPct}%`,
                background: spendPct > 90 ? '#ef4444' : spendPct > 70 ? '#f59e0b' : '#10b981',
              }}
            />
          </div>
        </div>
      )}

      {/* Highest spent category */}
      {summary?.['Highest Spent Category'] && (
        <div className="bg-amber-900/30 border border-amber-700/40 rounded-2xl p-4">
          <span className="text-amber-300 text-sm font-medium">
            Highest spend category: <strong>{summary['Highest Spent Category']}</strong>
          </span>
        </div>
      )}

      {/* Year chart */}
      {chartData.length > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4">
          <p className="text-slate-300 font-medium text-sm mb-4">2026 Income vs Spent</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} barCategoryGap="30%">
              <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
                formatter={v => [`$${v.toFixed(2)}`]}
              />
              <Bar dataKey="income" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Income" />
              <Bar dataKey="spent" fill="#f43f5e" radius={[4, 4, 0, 0]} name="Spent" />
            </BarChart>
          </ResponsiveContainer>
          <div className="flex gap-4 mt-2 justify-center text-xs text-slate-400">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-500 inline-block" /> Income</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-rose-500 inline-block" /> Spent</span>
          </div>
        </div>
      )}
    </div>
  );
}
