import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { readRange, readReportLinks, appendRow } from '../lib/sheets';
import { fetchGasPrices } from '../lib/gasPrice';
import { SHEETS, MONTHS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import ProcessIncome from '../components/ProcessIncome';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

function fmt(val) {
  const n = parseFloat(String(val ?? '').replace(/[$,\s]/g, ''));
  if (isNaN(n)) return '—';
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

function StatCard({ label, value, sub, color = 'text-white' }) {
  return (
    <div className="bg-slate-800 rounded-2xl p-4 flex flex-col gap-1">
      <span className="text-slate-400 text-xs uppercase tracking-wider">{label}</span>
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-slate-500 text-xs">{sub}</span>}
    </div>
  );
}

function ProgressBar({ pct, color }) {
  return (
    <div className="w-full bg-slate-700 rounded-full h-2.5 overflow-hidden">
      <div className="h-2.5 rounded-full transition-all duration-500" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
    </div>
  );
}

export default function Dashboard({ token }) {
  const navigate = useNavigate();
  const [allMonths, setAllMonths]       = useState([]);
  const [expenses, setExpenses]         = useState([]);
  const [reportLinks, setReportLinks]   = useState({});
  const [gasPrice, setGasPrice]         = useState(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [showIncome, setShowIncome]     = useState(false);
  const [showGasLog, setShowGasLog]     = useState(false);
  const [gasAmount, setGasAmount]       = useState('');
  const [gasDesc, setGasDesc]           = useState('');
  const [gasLogging, setGasLogging]     = useState(false);
  const [gasLogDone, setGasLogDone]     = useState(false);
  const [showExpLog, setShowExpLog]     = useState(false);
  const [expAmount, setExpAmount]       = useState('');
  const [expCategory, setExpCategory]   = useState('');
  const [expNote, setExpNote]           = useState('');
  const [expLogging, setExpLogging]     = useState(false);
  const [expLogDone, setExpLogDone]     = useState(false);
  const [showBills, setShowBills]       = useState(false);

  const now = new Date();
  const currentMonth = MONTHS[now.getMonth()];
  const currentYear  = now.getFullYear();

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([
      readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A1:P13`),
      readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A1:T40`),
      readReportLinks(token),
      fetchGasPrices().catch(() => null),
    ])
      .then(([summaryRows, expRows, links, gas]) => {
        setReportLinks(links);

        if (summaryRows.length) {
          const [headers, ...data] = summaryRows;
          setAllMonths(data.filter(r => r[0]).map(r =>
            headers.reduce((o, h, i) => { o[h] = r[i] ?? null; return o; }, {})
          ));
        }

        if (expRows.length) {
          const [headers, ...data] = expRows;
          setExpenses(data.filter(r => r[0]).map(r =>
            headers.reduce((o, h, i) => { o[h] = r[i] ?? null; return o; }, {})
          ));
        }

        if (gas) {
          const nyc = gas.byRegion['Y35NY']?.products['EPMR']?.value;
          setGasPrice({ value: nyc, period: gas.period });
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <div className="p-4 text-red-400">Error: {error}</div>;

  const current = allMonths.find(
    m => m['Month'] === currentMonth && String(m['Year']) === String(currentYear)
  );

  const income      = parseFloat(current?.['Total Processed Income']) || 0;
  const unprocessed = parseFloat(current?.['Unprocessed Income'])     || 0;
  const spent       = parseFloat(current?.['Total Spent'])            || 0;
  const goal        = parseFloat(current?.['Allowance Goal'])         || 0;
  const net         = income - spent;
  const goalPct     = goal > 0 ? (income / goal) * 100 : 0;
  const spendPct    = income > 0 ? (spent / income) * 100 : 0;

  const chartData = allMonths
    .filter(m => parseFloat(m['Total Processed Income']) > 0)
    .map(m => ({
      month:  m['Month']?.slice(0, 3),
      income: parseFloat(m['Total Processed Income']) || 0,
      spent:  parseFloat(m['Total Spent'])            || 0,
    }));

  const pastMonths = allMonths.filter(
    m => reportLinks[m['Month']] && m['Month'] !== currentMonth
  );

  const formatGasDate = (d) => {
    if (!d) return '';
    const [y, mo, day] = d.split('-');
    return new Date(y, mo - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  async function logGasSpend() {
    const amt = parseFloat(gasAmount);
    if (!amt || !token) return;
    setGasLogging(true);
    const d = new Date();
    const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    const desc = gasDesc ? `Gas fill-up: ${gasDesc}` : 'Gas fill-up';
    try {
      await appendRow(token, 'Allocation Transactions!A:F', [
        date, 'Gas', -parseFloat(amt.toFixed(2)), desc, 'Cash', false,
      ]);
      setGasLogDone(true);
      setGasAmount('');
      setGasDesc('');
      setTimeout(() => { setGasLogDone(false); setShowGasLog(false); }, 1800);
    } catch (e) {
      alert(`Error logging gas: ${e.message}`);
    } finally {
      setGasLogging(false);
    }
  }

  async function logExpense() {
    const amt = parseFloat(expAmount);
    if (!amt || !expCategory || !token) return;
    setExpLogging(true);
    const d = new Date();
    const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    const desc = expNote ? `${expCategory}: ${expNote}` : expCategory;
    const matched = expenses.find(e => e['Expense'] === expCategory);
    const account = matched?.['Account'] || 'Checking';
    try {
      await appendRow(token, 'Allocation Transactions!A:F', [
        date, expCategory, -parseFloat(amt.toFixed(2)), desc, account, false,
      ]);
      setExpLogDone(true);
      setExpAmount('');
      setExpNote('');
      setTimeout(() => { setExpLogDone(false); setShowExpLog(false); }, 1800);
    } catch (e) {
      alert(`Error logging expense: ${e.message}`);
    } finally {
      setExpLogging(false);
    }
  }

  return (
    <div className="p-4 space-y-5 pb-24">

      {/* ── Process Income CTA ──────────────────────────────── */}
      <button
        onClick={() => setShowIncome(true)}
        className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-2xl p-4 flex items-center justify-between transition-colors shadow-lg shadow-emerald-900/30"
      >
        <div className="text-left">
          <p className="font-bold text-base">💰 Process Income</p>
          <p className="text-emerald-200 text-xs mt-0.5">Calculate deposits → auto-log to transactions</p>
        </div>
        <span className="text-2xl">→</span>
      </button>

      {/* ── Header ──────────────────────────────────────────── */}
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
            Details →
          </button>
        )}
      </div>

      {/* ── Gas price chip + Log Gas spend ─────────────────── */}
      {gasPrice?.value && (
        <div className="flex gap-2">
          <button
            onClick={() => navigate('/gas')}
            className="flex-1 bg-slate-800 hover:bg-slate-700 rounded-xl px-4 py-3 flex justify-between items-center transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">⛽</span>
              <div className="text-left">
                <p className="text-white text-sm font-semibold">${gasPrice.value.toFixed(3)} / gal</p>
                <p className="text-slate-500 text-xs">NYC · {formatGasDate(gasPrice.period)}</p>
              </div>
            </div>
            <span className="text-slate-500 text-xs">→</span>
          </button>
          <button
            onClick={() => setShowGasLog(true)}
            className="bg-orange-900/40 hover:bg-orange-900/60 border border-orange-800/40 rounded-xl px-4 py-3 flex flex-col items-center justify-center gap-0.5 transition-colors shrink-0"
          >
            <span className="text-lg">⛽</span>
            <span className="text-orange-300 text-[10px] font-medium">Log Spend</span>
          </button>
        </div>
      )}

      {/* ── Gas spend modal ──────────────────────────────────── */}
      {showGasLog && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end z-50">
          <div className="bg-slate-900 w-full rounded-t-3xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-bold">⛽ Log Gas Spend</h3>
                <p className="text-slate-500 text-xs mt-0.5">Deducts from your claimable gas balance</p>
              </div>
              <button onClick={() => setShowGasLog(false)} className="w-8 h-8 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center">✕</button>
            </div>
            {gasLogDone ? (
              <div className="text-center py-6 space-y-2">
                <p className="text-4xl">✅</p>
                <p className="text-white font-medium">Gas spend logged!</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-slate-400 text-xs uppercase tracking-wider block mb-2">Amount Spent</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl font-bold">$</span>
                    <input
                      type="number" step="0.01" min="0"
                      value={gasAmount}
                      onChange={e => setGasAmount(e.target.value)}
                      placeholder="0.00"
                      autoFocus
                      className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3.5 outline-none focus:ring-2 focus:ring-orange-500 placeholder-slate-600 font-mono tabular-nums"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Note (optional)</label>
                  <input
                    type="text"
                    value={gasDesc}
                    onChange={e => setGasDesc(e.target.value)}
                    placeholder="e.g. Shell on Sunrise Hwy"
                    className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-orange-500 placeholder-slate-600"
                  />
                </div>
                <button
                  onClick={logGasSpend}
                  disabled={!gasAmount || gasLogging}
                  className="w-full py-3.5 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-bold transition-colors"
                >
                  {gasLogging ? 'Logging…' : `⛽ Log $${parseFloat(gasAmount || 0).toFixed(2)} Gas Spend`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Quick action buttons ─────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setShowExpLog(true)}
          className="bg-slate-800 hover:bg-slate-700 active:bg-slate-600 rounded-2xl p-4 flex flex-col gap-1 text-left transition-colors"
        >
          <span className="text-xl">🧾</span>
          <p className="text-white font-semibold text-sm">Log Expense</p>
          <p className="text-slate-400 text-xs">Record any spending</p>
        </button>
        <button
          onClick={() => setShowBills(true)}
          className="bg-violet-900/40 hover:bg-violet-900/60 active:bg-violet-900/80 border border-violet-700/40 rounded-2xl p-4 flex flex-col gap-1 text-left transition-colors"
        >
          <span className="text-xl">📋</span>
          <p className="text-violet-200 font-semibold text-sm">Bill Tracker</p>
          <p className="text-violet-400 text-xs">Monthly expense breakdown</p>
        </button>
      </div>

      {/* ── Stat cards ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Income"   value={fmt(income)}  sub={unprocessed > 0 ? `+${fmt(unprocessed)} unprocessed` : undefined} color="text-emerald-400" />
        <StatCard label="Spent"    value={fmt(spent)}   color="text-rose-400" />
        <StatCard label="Net Flow" value={fmt(net)}     color={net >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
        <StatCard label="Goal"     value={fmt(goal)}    sub={goal > 0 ? `${goalPct.toFixed(0)}% met` : undefined} color="text-sky-400" />
      </div>

      {/* ── Progress bars ───────────────────────────────────── */}
      {goal > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4 space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-300 font-medium">Income vs Goal</span>
              <span className="text-slate-400">{fmt(income)} / {fmt(goal)}</span>
            </div>
            <ProgressBar pct={goalPct} color={goalPct >= 100 ? '#10b981' : goalPct >= 75 ? '#f59e0b' : '#3b82f6'} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-300 font-medium">Spend Rate</span>
              <span className="text-slate-400">{fmt(spent)} / {fmt(income)}</span>
            </div>
            <ProgressBar pct={spendPct} color={spendPct > 90 ? '#ef4444' : spendPct > 70 ? '#f59e0b' : '#10b981'} />
          </div>
        </div>
      )}

      {current?.['Highest Spent Category'] && (
        <div className="bg-amber-900/30 border border-amber-700/40 rounded-2xl p-4">
          <span className="text-amber-300 text-sm">Highest spend: <strong>{current['Highest Spent Category']}</strong></span>
        </div>
      )}

      {/* ── Year chart ──────────────────────────────────────── */}
      {chartData.length > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4">
          <p className="text-slate-300 font-medium text-sm mb-4">2026 — Income vs Spent</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} barCategoryGap="30%">
              <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} formatter={v => [`$${v.toFixed(2)}`]} />
              <Bar dataKey="income" fill="#3b82f6" radius={[4,4,0,0]} name="Income" />
              <Bar dataKey="spent"  fill="#f43f5e" radius={[4,4,0,0]} name="Spent" />
            </BarChart>
          </ResponsiveContainer>
          <div className="flex gap-4 mt-2 justify-center text-xs text-slate-400">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-500 inline-block" /> Income</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-rose-500 inline-block" /> Spent</span>
          </div>
        </div>
      )}

      {/* ── Past month report cards ──────────────────────────── */}
      {pastMonths.length > 0 && (
        <div>
          <p className="text-slate-300 font-medium text-sm mb-3">Past Monthly Reports</p>
          <div className="space-y-2">
            {pastMonths.map((m, i) => {
              const mIncome = parseFloat(m['Total Processed Income']) || 0;
              const mSpent  = parseFloat(m['Total Spent'])            || 0;
              const mGoal   = parseFloat(m['Allowance Goal'])         || 0;
              const mNet    = mIncome - mSpent;
              const mPct    = mGoal > 0 ? Math.min((mIncome / mGoal) * 100, 100) : 0;
              return (
                <button key={i} onClick={() => navigate(`/month/${reportLinks[m['Month']]}/${m['Month']}`)}
                  className="w-full bg-slate-800 hover:bg-slate-700 rounded-xl p-4 text-left transition-colors"
                >
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="text-white font-medium">{m['Month']}</p>
                      <p className="text-slate-400 text-xs">{mIncome > 0 ? fmt(mIncome) : '—'} earned{mSpent > 0 ? ` · ${fmt(mSpent)} spent` : ''}</p>
                    </div>
                    <span className={`text-sm font-bold ${mNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {mNet >= 0 ? '+' : ''}{fmt(mNet)}
                    </span>
                  </div>
                  {mGoal > 0 && <ProgressBar pct={mPct} color={mPct >= 100 ? '#10b981' : mPct >= 75 ? '#f59e0b' : '#3b82f6'} />}
                  <p className="text-slate-600 text-xs mt-2">Tap to view transactions →</p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Year overview table ──────────────────────────────── */}
      <div>
        <p className="text-slate-300 font-medium text-sm mb-3">Full Year</p>
        <div className="bg-slate-800 rounded-2xl overflow-hidden">
          {allMonths.filter(m => parseFloat(m['Total Processed Income']) > 0 || parseFloat(m['Allowance Goal']) > 0).map((m, i, arr) => {
            const mIncome = parseFloat(m['Total Processed Income']) || 0;
            const mSpent  = parseFloat(m['Total Spent'])            || 0;
            const isCur   = m['Month'] === currentMonth;
            return (
              <div key={i} className={`flex justify-between items-center px-4 py-3 ${i < arr.length - 1 ? 'border-b border-slate-700' : ''} ${isCur ? 'bg-blue-900/20' : ''}`}>
                <div className="flex items-center gap-2">
                  {isCur && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />}
                  <span className={`text-sm ${isCur ? 'text-blue-300 font-medium' : 'text-slate-300'}`}>{m['Month']}</span>
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

      {/* ── Quick Expense Log modal ──────────────────────────── */}
      {showExpLog && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end z-50">
          <div className="bg-slate-900 w-full rounded-t-3xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-bold">🧾 Log Expense</h3>
                <p className="text-slate-500 text-xs mt-0.5">Records a spending transaction to your sheet</p>
              </div>
              <button onClick={() => setShowExpLog(false)} className="w-8 h-8 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center">✕</button>
            </div>
            {expLogDone ? (
              <div className="text-center py-6 space-y-2">
                <p className="text-4xl">✅</p>
                <p className="text-white font-medium">Expense logged!</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-slate-400 text-xs uppercase tracking-wider block mb-2">Amount</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl font-bold">$</span>
                    <input
                      type="number" step="0.01" min="0"
                      value={expAmount}
                      onChange={e => setExpAmount(e.target.value)}
                      placeholder="0.00"
                      autoFocus
                      className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3.5 outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-600 font-mono tabular-nums"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Category</label>
                  <select
                    value={expCategory}
                    onChange={e => setExpCategory(e.target.value)}
                    className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"
                  >
                    <option value="">— pick a category —</option>
                    {expenses.filter(e => e['Expense']).map((e, i) => (
                      <option key={i} value={e['Expense']}>{e['Expense']}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Note (optional)</label>
                  <input
                    type="text"
                    value={expNote}
                    onChange={e => setExpNote(e.target.value)}
                    placeholder="e.g. Costco run"
                    className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-600"
                  />
                </div>
                <button
                  onClick={logExpense}
                  disabled={!expAmount || !expCategory || expLogging}
                  className="w-full py-3.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-bold transition-colors"
                >
                  {expLogging ? 'Logging…' : `Log $${parseFloat(expAmount || 0).toFixed(2)} — ${expCategory || 'select category'}`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Bill Tracker modal (full-screen) ─────────────────── */}
      {showBills && (() => {
        const billExpenses = expenses.filter(e => e['Expense'] && parseFloat(e['Monthly Allowance ($)']) > 0);
        const totalBudget  = billExpenses.reduce((s, e) => s + (parseFloat(e['Monthly Allowance ($)']) || 0), 0);

        const priorityMeta = {
          '1': { label: 'Essential',  color: '#f43f5e', bg: 'bg-rose-500',   text: 'text-rose-400',   badge: 'bg-rose-900/50 text-rose-300'   },
          '2': { label: 'Stability',  color: '#f59e0b', bg: 'bg-amber-500',  text: 'text-amber-400',  badge: 'bg-amber-900/50 text-amber-300'  },
          '3': { label: 'Optional',   color: '#8b5cf6', bg: 'bg-violet-500', text: 'text-violet-400', badge: 'bg-violet-900/50 text-violet-300' },
        };

        const PIE_PALETTE = {
          '1': ['#f43f5e','#fb7185','#fda4af','#fecdd3','#ffe4e6','#e11d48','#be123c'],
          '2': ['#f59e0b','#fbbf24','#fcd34d','#fde68a','#fef3c7','#d97706','#b45309'],
          '3': ['#8b5cf6','#a78bfa','#c4b5fd','#ddd6fe','#7c3aed','#6d28d9','#5b21b6'],
        };
        const priorityCounts = { '1': 0, '2': 0, '3': 0 };
        const pieData = billExpenses.map(e => {
          const p = String(e['Priority'] ?? '3');
          const idx = priorityCounts[p] ?? 0;
          priorityCounts[p] = idx + 1;
          const palette = PIE_PALETTE[p] || PIE_PALETTE['3'];
          return {
            name:  e['Expense'],
            value: parseFloat(e['Monthly Allowance ($)']),
            color: palette[idx % palette.length],
            priority: p,
          };
        });

        const priorityTotals = {};
        billExpenses.forEach(e => {
          const p = String(e['Priority'] ?? '3');
          priorityTotals[p] = (priorityTotals[p] || 0) + (parseFloat(e['Monthly Allowance ($)']) || 0);
        });

        const grouped = ['1','2','3'].map(p => ({
          priority: p,
          meta: priorityMeta[p] || priorityMeta['3'],
          total: priorityTotals[p] || 0,
          items: billExpenses.filter(e => String(e['Priority'] ?? '3') === p),
        })).filter(g => g.items.length > 0);

        return (
          <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
              <div>
                <h2 className="text-white font-bold text-lg">📋 Bill Tracker</h2>
                <p className="text-slate-400 text-xs mt-0.5">Monthly budget: <span className="text-white font-semibold">${totalBudget.toFixed(2)}</span></p>
              </div>
              <button onClick={() => setShowBills(false)} className="w-9 h-9 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-lg">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {/* Donut chart */}
              <div className="flex flex-col items-center py-6 bg-slate-900/50">
                <div className="relative">
                  <PieChart width={220} height={220}>
                    <Pie data={pieData} cx={110} cy={110} innerRadius={68} outerRadius={100} dataKey="value" stroke="none" startAngle={90} endAngle={-270}>
                      {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontSize: 12 }} formatter={(v, n) => [`$${v.toFixed(2)}`, n]} />
                  </PieChart>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-white font-bold text-lg">${totalBudget.toFixed(0)}</span>
                    <span className="text-slate-400 text-xs">/ month</span>
                  </div>
                </div>

                {/* Legend */}
                <div className="flex gap-4 mt-1 text-xs text-slate-400">
                  {Object.entries(priorityMeta).filter(([p]) => priorityTotals[p]).map(([p, m]) => (
                    <span key={p} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: m.color }} />
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>

              {/* Priority summary bars */}
              <div className="px-5 py-4 space-y-3 border-b border-slate-800">
                <p className="text-slate-400 text-xs uppercase tracking-wider">By Priority</p>
                {grouped.map(({ priority, meta, total }) => (
                  <div key={priority} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className={`font-medium ${meta.text}`}>P{priority} — {meta.label}</span>
                      <span className="text-white font-semibold">${total.toFixed(2)}</span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                      <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${totalBudget > 0 ? (total / totalBudget) * 100 : 0}%`, background: meta.color }} />
                    </div>
                    <p className="text-slate-500 text-xs">{totalBudget > 0 ? ((total / totalBudget) * 100).toFixed(1) : 0}% of total</p>
                  </div>
                ))}
              </div>

              {/* Grouped expense list */}
              <div className="px-5 py-4 space-y-6 pb-24">
                {grouped.map(({ priority, meta, items }) => (
                  <div key={priority}>
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${meta.badge}`}>P{priority}</span>
                      <span className="text-slate-300 text-sm font-medium">{meta.label}</span>
                    </div>
                    <div className="space-y-2">
                      {items.map((e, i) => {
                        const amt = parseFloat(e['Monthly Allowance ($)']) || 0;
                        const pct = totalBudget > 0 ? (amt / totalBudget) * 100 : 0;
                        return (
                          <div key={i} className="bg-slate-900 rounded-xl px-4 py-3 space-y-1.5">
                            <div className="flex justify-between items-center">
                              <span className="text-white text-sm">{e['Expense']}</span>
                              <span className="text-white font-semibold text-sm">${amt.toFixed(2)}</span>
                            </div>
                            <div className="w-full bg-slate-800 rounded-full h-1 overflow-hidden">
                              <div className="h-1 rounded-full" style={{ width: `${pct}%`, background: meta.color }} />
                            </div>
                            <p className="text-slate-500 text-xs">{pct.toFixed(1)}% of budget{e['Account'] ? ` · ${e['Account']}` : ''}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Process Income modal ─────────────────────────────── */}
      {showIncome && (
        <ProcessIncome
          expenses={expenses}
          token={token}
          alreadyProcessed={income}
          onClose={() => setShowIncome(false)}
        />
      )}
    </div>
  );
}
