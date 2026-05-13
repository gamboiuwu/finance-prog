import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { readRange, readReportLinks } from '../lib/sheets';
import { SHEETS, MONTHS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

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
  const n = parseFloat(String(val).replace(/[$,\s]/g, ''));
  if (isNaN(n)) return '—';
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

function ProgressBar({ pct, color }) {
  return (
    <div className="w-full bg-slate-700 rounded-full h-2.5 overflow-hidden">
      <div
        className="h-2.5 rounded-full transition-all duration-500"
        style={{ width: `${Math.min(pct, 100)}%`, background: color }}
      />
    </div>
  );
}

export default function Dashboard({ token }) {
  const navigate = useNavigate();
  const [allMonths, setAllMonths] = useState([]);
  const [reportLinks, setReportLinks] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const now = new Date();
  const currentMonth = MONTHS[now.getMonth()];
  const currentYear = now.getFullYear();

  useEffect(() => {
    if (!token) return;
    setLoading(true);

    Promise.all([
      readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A1:P13`),
      readReportLinks(token),
    ])
      .then(([rows, links]) => {
        setReportLinks(links);
        if (!rows.length) return;
        const [headers, ...data] = rows;
        const parsed = data
          .filter(r => r[0])
          .map(r => {
            const obj = {};
            headers.forEach((h, i) => { obj[h] = r[i] ?? null; });
            return obj;
          });
        setAllMonths(parsed);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;

  const current = allMonths.find(
    m => m['Month'] === currentMonth && String(m['Year']) === String(currentYear)
  );

  const income = parseFloat(current?.['Total Processed Income']) || 0;
  const unprocessed = parseFloat(current?.['Unprocessed Income']) || 0;
  const spent = parseFloat(current?.['Total Spent']) || 0;
  const goal = parseFloat(current?.['Allowance Goal']) || 0;
  const net = income - spent;
  const goalPct = goal > 0 ? (income / goal) * 100 : 0;
  const spendPct = income > 0 ? (spent / income) * 100 : 0;

  // Chart data — months with income data
  const chartData = allMonths
    .filter(m => parseFloat(m['Total Processed Income']) > 0)
    .map(m => ({
      month: m['Month']?.slice(0, 3),
      income: parseFloat(m['Total Processed Income']) || 0,
      spent: parseFloat(m['Total Spent']) || 0,
      goal: parseFloat(m['Allowance Goal']) || 0,
    }));

  // Past months with report links (excludes current)
  const pastMonths = allMonths.filter(
    m => reportLinks[m['Month']] && m['Month'] !== currentMonth
  );

  return (
    <div className="p-4 space-y-5 pb-24">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-white">{currentMonth} {currentYear}</h1>
          <p className="text-slate-400 text-sm">Monthly Overview</p>
        </div>
        {reportLinks[currentMonth] && (
          <button
            onClick={() => navigate(`/month/${reportLinks[currentMonth]}/${currentMonth}`)}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg font-medium"
          >
            View Details →
          </button>
        )}
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Income"
          value={fmt(income)}
          sub={unprocessed > 0 ? `+${fmt(unprocessed)} unprocessed` : undefined}
          color="text-emerald-400"
        />
        <StatCard label="Spent" value={fmt(spent)} color="text-rose-400" />
        <StatCard
          label="Net Flow"
          value={fmt(net)}
          color={net >= 0 ? 'text-emerald-400' : 'text-rose-400'}
        />
        <StatCard
          label="Goal"
          value={fmt(goal)}
          sub={goal > 0 ? `${goalPct.toFixed(0)}% met` : undefined}
          color="text-sky-400"
        />
      </div>

      {/* Progress bars */}
      {goal > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4 space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-300 font-medium">Income vs Goal</span>
              <span className="text-slate-400">{fmt(income)} / {fmt(goal)}</span>
            </div>
            <ProgressBar
              pct={goalPct}
              color={goalPct >= 100 ? '#10b981' : goalPct >= 75 ? '#f59e0b' : '#3b82f6'}
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-300 font-medium">Spend Rate</span>
              <span className="text-slate-400">{fmt(spent)} / {fmt(income)}</span>
            </div>
            <ProgressBar
              pct={spendPct}
              color={spendPct > 90 ? '#ef4444' : spendPct > 70 ? '#f59e0b' : '#10b981'}
            />
          </div>
        </div>
      )}

      {/* Highest spend */}
      {current?.['Highest Spent Category'] && (
        <div className="bg-amber-900/30 border border-amber-700/40 rounded-2xl p-4">
          <span className="text-amber-300 text-sm">
            Highest spend category this month: <strong>{current['Highest Spent Category']}</strong>
          </span>
        </div>
      )}

      {/* Year chart */}
      {chartData.length > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4">
          <p className="text-slate-300 font-medium text-sm mb-4">2026 — Income vs Spent</p>
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

      {/* Past months with report links */}
      {pastMonths.length > 0 && (
        <div>
          <p className="text-slate-300 font-medium text-sm mb-3">Past Monthly Reports</p>
          <div className="space-y-2">
            {pastMonths.map((m, i) => {
              const mIncome = parseFloat(m['Total Processed Income']) || 0;
              const mSpent = parseFloat(m['Total Spent']) || 0;
              const mGoal = parseFloat(m['Allowance Goal']) || 0;
              const mNet = mIncome - mSpent;
              const mPct = mGoal > 0 ? Math.min((mIncome / mGoal) * 100, 100) : 0;
              const budgetMet = m['Budget Met'] === 'TRUE' || mNet >= 0;

              return (
                <button
                  key={i}
                  onClick={() => navigate(`/month/${reportLinks[m['Month']]}/${m['Month']}`)}
                  className="w-full bg-slate-800 hover:bg-slate-700 rounded-xl p-4 text-left transition-colors"
                >
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="text-white font-medium">{m['Month']}</p>
                      <p className="text-slate-400 text-xs mt-0.5">
                        {mIncome > 0 ? fmt(mIncome) : '—'} earned
                        {mSpent > 0 ? ` · ${fmt(mSpent)} spent` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className={`text-sm font-bold ${mNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {mNet >= 0 ? '+' : ''}{fmt(mNet)}
                      </span>
                      {budgetMet !== null && (
                        <p className="text-xs mt-0.5">
                          {budgetMet
                            ? <span className="text-emerald-500">✓ Goal met</span>
                            : <span className="text-amber-500">Goal missed</span>
                          }
                        </p>
                      )}
                    </div>
                  </div>
                  {mGoal > 0 && (
                    <ProgressBar
                      pct={mPct}
                      color={mPct >= 100 ? '#10b981' : mPct >= 75 ? '#f59e0b' : '#3b82f6'}
                    />
                  )}
                  <p className="text-slate-500 text-xs mt-2">Tap to view transactions →</p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* All months overview table */}
      <div>
        <p className="text-slate-300 font-medium text-sm mb-3">Full Year Overview</p>
        <div className="bg-slate-800 rounded-2xl overflow-hidden">
          {allMonths.filter(m => parseFloat(m['Total Processed Income']) > 0 || parseFloat(m['Allowance Goal']) > 0).map((m, i, arr) => {
            const mIncome = parseFloat(m['Total Processed Income']) || 0;
            const mSpent = parseFloat(m['Total Spent']) || 0;
            const isCurrent = m['Month'] === currentMonth;
            return (
              <div
                key={i}
                className={`flex justify-between items-center px-4 py-3 ${i < arr.length - 1 ? 'border-b border-slate-700' : ''} ${isCurrent ? 'bg-blue-900/20' : ''}`}
              >
                <div className="flex items-center gap-2">
                  {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />}
                  <span className={`text-sm ${isCurrent ? 'text-blue-300 font-medium' : 'text-slate-300'}`}>
                    {m['Month']}
                  </span>
                </div>
                <div className="flex gap-4 text-xs">
                  <span className="text-emerald-400">{mIncome > 0 ? fmt(mIncome) : '—'}</span>
                  <span className="text-rose-400">{mSpent > 0 ? fmt(mSpent) : '—'}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
