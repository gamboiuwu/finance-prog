import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { readRange, readReportLinks, appendRow } from '../lib/sheets';
import { fetchGasPrices } from '../lib/gasPrice';
import { SHEETS, MONTHS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import ProcessIncome from '../components/ProcessIncome';
import { ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

function fmt(val) {
  const n = parseFloat(String(val ?? '').replace(/[$,\s]/g, ''));
  if (isNaN(n)) return '—';
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

function StatCard({ label, value, sub, color = 'text-white' }) {
  return (
    <div className="bg-slate-800 rounded-2xl p-4 flex flex-col gap-1">
      <span className="text-slate-400 text-xs uppercase tracking-wider font-ztnature">{label}</span>
      <span className={`text-2xl font-bold font-broske ${color}`}>{value}</span>
      {sub && <span className="text-slate-500 text-xs font-ztnature">{sub}</span>}
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
  const [showStatement, setShowStatement] = useState(false);
  const [stmtLoading, setStmtLoading]   = useState(false);
  const [stmtTxns, setStmtTxns]         = useState([]);
  const [stmtError, setStmtError]       = useState(null);

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
    .map(m => {
      const inc = parseFloat(m['Total Processed Income']) || 0;
      const spt = parseFloat(m['Total Spent'])            || 0;
      return { month: m['Month']?.slice(0, 3), income: inc, spent: spt, net: inc - spt };
    });

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
        date, 'Gas', -Math.abs(amt), desc, 'Cash', false,
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
    const matched = expenses.find(e => e['Type'] === expCategory);
    const account = matched?.['Account'] || 'Checking';
    try {
      await appendRow(token, 'Allocation Transactions!A:F', [
        date, expCategory, -Math.abs(amt), desc, account, false,
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

  async function openStatement() {
    setShowStatement(true);
    setStmtLoading(true);
    setStmtError(null);
    const mo = now.getMonth() + 1;
    const yr = now.getFullYear();
    try {
      const rows = await readRange(token, 'Allocation Transactions!A:F');
      const [, ...data] = rows;
      const txns = data
        .filter(r => r[0])
        .filter(r => {
          const parts = (r[0] || '').split('/');
          return parseInt(parts[0]) === mo && parseInt(parts[2]) === yr;
        })
        .map(r => ({
          date: r[0], type: r[1] || '',
          amount: parseFloat(r[2]) || 0,
          desc: r[3] || '', account: r[4] || '',
          done: r[5] === 'TRUE' || r[5] === true,
        }))
        .sort((a, b) => {
          const [am, ad] = a.date.split('/').map(Number);
          const [bm, bd] = b.date.split('/').map(Number);
          return am !== bm ? am - bm : ad - bd;
        });
      setStmtTxns(txns);
    } catch (e) {
      setStmtError(e.message);
    } finally {
      setStmtLoading(false);
    }
  }

  function printStatement(current, stmtTxns, expenses, currentMonth, currentYear) {
    const fmtAmt = n => {
      if (n == null || isNaN(n)) return '—';
      return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
    };
    const income = parseFloat(current?.['Total Processed Income']) || 0;
    const spent  = parseFloat(current?.['Total Spent'])            || 0;
    const goal   = parseFloat(current?.['Allowance Goal'])         || 0;
    const net    = income - spent;

    // Group expenses by priority
    const priGroups = ['1','2','3'].map(p => ({
      p, label: { '1':'Essential','2':'Stability','3':'Optional' }[p],
      items: expenses.filter(e => String(e['Priority'] ?? '3') === p && parseFloat(e['Monthly Allowance ($)']) > 0),
    })).filter(g => g.items.length);

    // Group transactions by type
    const catMap = {};
    stmtTxns.forEach(t => {
      if (!catMap[t.type]) catMap[t.type] = { income: 0, spend: 0 };
      if (t.amount > 0) catMap[t.type].income += t.amount;
      else catMap[t.type].spend += Math.abs(t.amount);
    });

    const genDate = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Finance Statement – ${currentMonth} ${currentYear}</title>
<style>
  @page { size: letter; margin: 0.75in; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; color: #1a1a2e; background: #fff; line-height: 1.5; }
  .page-header { border-bottom: 3px solid #1a1a2e; padding-bottom: 14px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-end; }
  .page-header h1 { font-size: 22pt; letter-spacing: -0.5px; }
  .page-header .meta { text-align: right; font-size: 9pt; color: #555; line-height: 1.8; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .summary-box { border: 1.5px solid #ddd; border-radius: 8px; padding: 12px 14px; }
  .summary-box .lbl { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 4px; }
  .summary-box .val { font-size: 16pt; font-weight: bold; }
  .val.green { color: #15803d; } .val.red { color: #dc2626; } .val.blue { color: #1d4ed8; }
  .section-title { font-size: 10pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; color: #444; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin: 20px 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th { text-align: left; padding: 6px 8px; background: #f5f5f5; border-bottom: 1.5px solid #ccc; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
  td { padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .amt { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pos { color: #15803d; font-weight: bold; } .neg { color: #dc2626; }
  .pri-head { background: #f0f0f0; font-weight: bold; font-size: 9pt; padding: 5px 8px; color: #333; }
  .footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #ccc; font-size: 8pt; color: #888; display: flex; justify-content: space-between; }
  .no-data { color: #888; font-style: italic; font-size: 10pt; padding: 12px 0; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="page-header">
  <div>
    <div style="font-size:9pt;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:4px">Monthly Finance Statement</div>
    <h1>${currentMonth} ${currentYear}</h1>
  </div>
  <div class="meta">
    <div>Generated ${genDate}</div>
    <div>Personal Finance Tracker</div>
  </div>
</div>

<div class="summary-grid">
  <div class="summary-box">
    <div class="lbl">Income</div>
    <div class="val green">${fmtAmt(income)}</div>
  </div>
  <div class="summary-box">
    <div class="lbl">Spent</div>
    <div class="val ${spent > income ? 'red' : ''}">${fmtAmt(spent)}</div>
  </div>
  <div class="summary-box">
    <div class="lbl">Net Saved</div>
    <div class="val ${net >= 0 ? 'green' : 'red'}">${fmtAmt(net)}</div>
  </div>
  <div class="summary-box">
    <div class="lbl">Monthly Goal</div>
    <div class="val blue">${fmtAmt(goal)}</div>
  </div>
</div>

<div class="section-title">Budget Allocation</div>
${priGroups.length ? priGroups.map(g => `
  <div class="pri-head">P${g.p} — ${g.label}</div>
  <table>
    <thead><tr><th>Item</th><th>Account</th><th class="amt">Allowance</th><th class="amt">Spent</th><th class="amt">Remaining</th></tr></thead>
    <tbody>
      ${g.items.map(e => {
        const allw = parseFloat(e['Monthly Allowance ($)']) || 0;
        const sp   = parseFloat(e['Actual Spend'])          || 0;
        const rem  = allw - sp;
        return `<tr>
          <td>${e['Type'] || '—'}</td>
          <td style="color:#666">${e['Account'] || '—'}</td>
          <td class="amt">${fmtAmt(allw)}</td>
          <td class="amt ${sp > allw ? 'neg' : ''}">${fmtAmt(sp)}</td>
          <td class="amt ${rem < 0 ? 'neg' : ''}">${fmtAmt(rem)}</td>
        </tr>`;
      }).join('')}
      <tr style="font-weight:bold;background:#fafafa">
        <td colspan="2">Subtotal</td>
        <td class="amt">${fmtAmt(g.items.reduce((s,e)=>s+parseFloat(e['Monthly Allowance ($)']),0))}</td>
        <td class="amt">${fmtAmt(g.items.reduce((s,e)=>s+parseFloat(e['Actual Spend']||0),0))}</td>
        <td class="amt">${fmtAmt(g.items.reduce((s,e)=>s+(parseFloat(e['Monthly Allowance ($)'])-parseFloat(e['Actual Spend']||0)),0))}</td>
      </tr>
    </tbody>
  </table><br/>
`).join('') : '<p class="no-data">No budget items found.</p>'}

<div class="section-title">Transactions — ${currentMonth} ${currentYear}</div>
${stmtTxns.length ? `
<table>
  <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Account</th><th class="amt">Amount</th></tr></thead>
  <tbody>
    ${stmtTxns.map(t => `
      <tr>
        <td style="white-space:nowrap;color:#555">${t.date}</td>
        <td>${t.type}</td>
        <td style="color:#555;font-size:9.5pt">${t.desc}</td>
        <td style="color:#666;font-size:9.5pt">${t.account}</td>
        <td class="amt ${t.amount < 0 ? 'neg' : 'pos'}">${fmtAmt(t.amount)}</td>
      </tr>
    `).join('')}
    <tr style="font-weight:bold;background:#fafafa;border-top:2px solid #ccc">
      <td colspan="4">Total</td>
      <td class="amt ${stmtTxns.reduce((s,t)=>s+t.amount,0) >= 0 ? 'pos' : 'neg'}">${fmtAmt(stmtTxns.reduce((s,t)=>s+t.amount,0))}</td>
    </tr>
  </tbody>
</table>
` : '<p class="no-data">No transactions found for this month.</p>'}

<div class="footer">
  <span>Finance Statement · ${currentMonth} ${currentYear}</span>
  <span>${stmtTxns.length} transaction${stmtTxns.length !== 1 ? 's' : ''} · Generated ${genDate}</span>
</div>
</body>
</html>`;

    const win = window.open('', '_blank', 'width=900,height=1100');
    if (!win) { alert('Please allow pop-ups to generate the PDF statement.'); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 600);
  }

  return (
    <div className="p-4 space-y-5 pb-24">

      {/* ── Process Income + Statement CTAs ─────────────────── */}
      <div className="flex gap-3">
        <button
          onClick={() => setShowIncome(true)}
          className="flex-1 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-2xl p-4 flex items-center justify-between transition-colors shadow-lg shadow-emerald-900/30"
        >
          <div className="text-left">
            <p className="font-bold text-base">💰 Process Income</p>
            <p className="text-emerald-200 text-xs mt-0.5">Auto-log deposits to transactions</p>
          </div>
          <span className="text-xl">→</span>
        </button>
        <button
          onClick={openStatement}
          className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white rounded-2xl px-4 flex flex-col items-center justify-center gap-1 shrink-0 transition-colors"
        >
          <span className="text-xl">📄</span>
          <span className="text-[10px] text-slate-300 font-medium">Statement</span>
        </button>
      </div>

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
          <p className="text-slate-300 font-medium text-sm mb-4 font-broske tracking-wide">2026 — Income vs Spent</p>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={chartData} barCategoryGap="30%">
              <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: "'ZTNature', system-ui, sans-serif" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: "'ZTNature', system-ui, sans-serif" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontFamily: "'ZTNature', system-ui, sans-serif" }} formatter={v => [`$${v.toFixed(2)}`]} />
              <Bar dataKey="income" fill="#3b82f6" radius={[4,4,0,0]} name="Income" />
              <Bar dataKey="spent"  fill="#f43f5e" radius={[4,4,0,0]} name="Spent" />
              <Line type="monotone" dataKey="net" stroke="#10b981" strokeWidth={2} dot={{ fill: '#10b981', r: 3 }} name="Net Saved" />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex gap-4 mt-2 justify-center text-xs text-slate-400">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-500 inline-block" /> Income</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-rose-500 inline-block" /> Spent</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" /> Net Saved</span>
          </div>
        </div>
      )}

      {/* ── Past month report cards ──────────────────────────── */}
      {pastMonths.length > 0 && (
        <div>
          <p className="text-slate-300 font-medium text-sm mb-3 font-broske tracking-wide">Past Monthly Reports</p>
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
        <p className="text-slate-300 font-medium text-sm mb-3 font-broske tracking-wide">Full Year</p>
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
                    {expenses.filter(e => e['Type']).map((e, i) => (
                      <option key={i} value={e['Type']}>{e['Type']}</option>
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
        const billExpenses = expenses.filter(e => parseFloat(e['Monthly Allowance ($)']) > 0);
        const totalBudget  = billExpenses.reduce((s, e) => s + (parseFloat(e['Monthly Allowance ($)']) || 0), 0);

        const priorityMeta = {
          '1': { label: 'Essential',  color: '#f43f5e', text: 'text-rose-400',   badge: 'bg-rose-900/50 text-rose-300'   },
          '2': { label: 'Stability',  color: '#f59e0b', text: 'text-amber-400',  badge: 'bg-amber-900/50 text-amber-300'  },
          '3': { label: 'Optional',   color: '#8b5cf6', text: 'text-violet-400', badge: 'bg-violet-900/50 text-violet-300' },
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
          return { name: e['Type'] || e['Expense'] || '—', value: parseFloat(e['Monthly Allowance ($)']), color: palette[idx % palette.length], priority: p };
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
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
              <div>
                <h2 className="text-white font-bold text-lg">📋 Bill Tracker</h2>
                <p className="text-slate-400 text-xs mt-0.5">Monthly budget: <span className="text-white font-semibold">${totalBudget.toFixed(2)}</span></p>
              </div>
              <button onClick={() => setShowBills(false)} className="w-9 h-9 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-lg">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-col items-center py-6 bg-slate-900/50">
                <div className="relative">
                  <PieChart width={220} height={220}>
                    <Pie data={pieData} cx={110} cy={110} innerRadius={68} outerRadius={100} dataKey="value" stroke="none" startAngle={90} endAngle={-270}>
                      {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontSize: 12, fontFamily: "'ZTNature', system-ui, sans-serif" }} formatter={(v, n) => [`$${v.toFixed(2)}`, n]} />
                  </PieChart>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-white font-bold text-lg">${totalBudget.toFixed(0)}</span>
                    <span className="text-slate-400 text-xs">/ month</span>
                  </div>
                </div>
                <div className="flex gap-4 mt-1 text-xs text-slate-400">
                  {Object.entries(priorityMeta).filter(([p]) => priorityTotals[p]).map(([p, m]) => (
                    <span key={p} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: m.color }} />
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>
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
                            <div className="flex justify-between items-center gap-2">
                              <div className="min-w-0">
                                <span className="text-white text-sm">{e['Type'] || e['Expense'] || '—'}</span>
                                {e['Account'] === 'Subscription' && (
                                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-violet-900/60 text-violet-300">sub</span>
                                )}
                              </div>
                              <span className="text-white font-semibold text-sm shrink-0">${amt.toFixed(2)}</span>
                            </div>
                            <div className="w-full bg-slate-800 rounded-full h-1 overflow-hidden">
                              <div className="h-1 rounded-full" style={{ width: `${pct}%`, background: meta.color }} />
                            </div>
                            <p className="text-slate-500 text-xs">{pct.toFixed(1)}% of budget{e['Account'] && e['Account'] !== 'Subscription' ? ` · ${e['Account']}` : ''}</p>
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

      {/* ── Monthly Statement modal ──────────────────────────── */}
      {showStatement && (
        <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">

          {/* Sticky header */}
          <div className="shrink-0 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
            <div className="max-w-3xl mx-auto px-5 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg leading-tight">📄 Monthly Statement</h2>
                <p className="text-slate-400 text-xs mt-0.5">{currentMonth} {currentYear}</p>
              </div>
              <div className="flex items-center gap-2">
                {!stmtLoading && !stmtError && (
                  <button
                    onClick={() => printStatement(current, stmtTxns, expenses, currentMonth, currentYear)}
                    className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors"
                  >
                    🖨 Save PDF
                  </button>
                )}
                <button
                  onClick={() => setShowStatement(false)}
                  className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center text-base transition-colors"
                >✕</button>
              </div>
            </div>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-5 py-6 space-y-8 pb-16">

              {stmtLoading && (
                <div className="flex flex-col items-center justify-center py-24 gap-4">
                  <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-slate-400 text-sm">Loading transactions…</p>
                </div>
              )}
              {stmtError && (
                <div className="bg-red-900/30 border border-red-700/50 rounded-2xl p-5 text-red-400 text-sm">{stmtError}</div>
              )}

              {!stmtLoading && !stmtError && (() => {
                const fmtS = n => n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
                const totalIncome = parseFloat(current?.['Total Processed Income']) || 0;
                const totalSpent  = parseFloat(current?.['Total Spent'])            || 0;
                const netSaved    = totalIncome - totalSpent;
                const goalAmt     = parseFloat(current?.['Allowance Goal'])         || 0;

                // Spending by category — negative transactions only, grouped by type
                const catSpend = {};
                stmtTxns.forEach(t => {
                  if (t.amount >= 0) return;
                  catSpend[t.type] = (catSpend[t.type] || 0) + Math.abs(t.amount);
                });
                const catRanked = Object.entries(catSpend)
                  .sort((a, b) => b[1] - a[1]);
                const maxSpend = catRanked[0]?.[1] || 1;
                const totalCatSpend = catRanked.reduce((s, [, v]) => s + v, 0);

                // Bar color based on rank position
                const rankColors = ['#f43f5e','#f97316','#f59e0b','#84cc16','#10b981','#06b6d4','#3b82f6','#8b5cf6','#ec4899'];

                const priGroups = ['1','2','3'].map(p => ({
                  p,
                  label:  { '1':'Essential','2':'Stability','3':'Optional' }[p],
                  color:  { '1':'text-rose-400','2':'text-amber-400','3':'text-violet-400' }[p],
                  barClr: { '1':'#f43f5e','2':'f59e0b','3':'#8b5cf6' }[p],
                  bg:     { '1':'bg-rose-950/40','2':'bg-amber-950/40','3':'bg-violet-950/40' }[p],
                  border: { '1':'border-rose-800/40','2':'border-amber-800/40','3':'border-violet-800/40' }[p],
                  items: expenses.filter(e => String(e['Priority'] ?? '3') === p && parseFloat(e['Monthly Allowance ($)']) > 0),
                })).filter(g => g.items.length);

                const SectionLabel = ({ children }) => (
                  <div className="flex items-center gap-3 mb-4">
                    <span className="text-slate-400 text-xs font-broske uppercase tracking-widest">{children}</span>
                    <div className="flex-1 h-px bg-slate-800" />
                  </div>
                );

                return (
                  <>
                    {/* ── Summary ─────────────────────────────────── */}
                    <div>
                      <SectionLabel>Overview</SectionLabel>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {[
                          { label: 'Income',    val: totalIncome, color: 'text-emerald-400', sub: goal > 0 ? `${((totalIncome/goalAmt)*100).toFixed(0)}% of goal` : null },
                          { label: 'Spent',     val: totalSpent,  color: totalSpent > totalIncome ? 'text-rose-400' : 'text-white', sub: totalIncome > 0 ? `${((totalSpent/totalIncome)*100).toFixed(0)}% of income` : null },
                          { label: 'Net Saved', val: netSaved,    color: netSaved >= 0 ? 'text-emerald-400' : 'text-rose-400', sub: netSaved >= 0 ? 'surplus' : 'deficit' },
                          { label: 'Goal',      val: goalAmt,     color: 'text-sky-400',     sub: goalAmt > 0 ? `${catRanked.length} categories` : null },
                        ].map(({ label, val, color, sub }) => (
                          <div key={label} className="bg-slate-900 rounded-2xl p-4 space-y-1">
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">{label}</p>
                            <p className={`text-xl font-bold font-broske tabular-nums ${color}`}>{fmtS(val)}</p>
                            {sub && <p className="text-slate-600 text-[10px]">{sub}</p>}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ── Daily Spending chart ─────────────────────── */}
                    {stmtTxns.length > 0 && (() => {
                      const dailyMap = {};
                      stmtTxns.forEach(t => {
                        if (t.amount >= 0) return;
                        const parts = t.date.split('/');
                        const label = `${parseInt(parts[0])}/${parseInt(parts[1])}`;
                        dailyMap[label] = (dailyMap[label] || 0) + Math.abs(t.amount);
                      });
                      const dailyData = Object.entries(dailyMap)
                        .sort((a, b) => {
                          const [am, ad] = a[0].split('/').map(Number);
                          const [bm, bd] = b[0].split('/').map(Number);
                          return am !== bm ? am - bm : ad - bd;
                        })
                        .map(([day, amt]) => ({ day, amt }));

                      const incomeByDay = {};
                      stmtTxns.forEach(t => {
                        if (t.amount <= 0) return;
                        const parts = t.date.split('/');
                        const label = `${parseInt(parts[0])}/${parseInt(parts[1])}`;
                        incomeByDay[label] = (incomeByDay[label] || 0) + t.amount;
                      });

                      const allDays = [...new Set([...Object.keys(dailyMap), ...Object.keys(incomeByDay)])].sort((a, b) => {
                        const [am, ad] = a.split('/').map(Number);
                        const [bm, bd] = b.split('/').map(Number);
                        return am !== bm ? am - bm : ad - bd;
                      });
                      const combinedData = allDays.map(day => ({
                        day,
                        spend: dailyMap[day] || 0,
                        income: incomeByDay[day] || 0,
                      }));

                      if (dailyData.length < 2) return null;

                      return (
                        <div>
                          <SectionLabel>Daily Activity</SectionLabel>
                          <div className="bg-slate-900 rounded-2xl p-4 space-y-4">
                            <div>
                              <p className="text-slate-400 text-xs font-broske uppercase tracking-wider mb-3">Spending by Day</p>
                              <ResponsiveContainer width="100%" height={160}>
                                <BarChart data={dailyData} barCategoryGap="25%">
                                  <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: "'ZTNature', system-ui, sans-serif" }} axisLine={false} tickLine={false} />
                                  <YAxis tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: "'ZTNature', system-ui, sans-serif" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={45} />
                                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontFamily: "'ZTNature', system-ui, sans-serif", fontSize: 12 }} formatter={v => [`$${v.toFixed(2)}`, 'Spent']} />
                                  <Bar dataKey="amt" fill="#f43f5e" radius={[3, 3, 0, 0]} name="Spent" />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                            {combinedData.some(d => d.income > 0) && (
                              <div>
                                <p className="text-slate-400 text-xs font-broske uppercase tracking-wider mb-3">Income vs Spending</p>
                                <ResponsiveContainer width="100%" height={160}>
                                  <ComposedChart data={combinedData} barCategoryGap="25%">
                                    <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: "'ZTNature', system-ui, sans-serif" }} axisLine={false} tickLine={false} />
                                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: "'ZTNature', system-ui, sans-serif" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={45} />
                                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontFamily: "'ZTNature', system-ui, sans-serif", fontSize: 12 }} formatter={v => [`$${v.toFixed(2)}`]} />
                                    <Bar dataKey="spend" fill="#f43f5e" radius={[3, 3, 0, 0]} name="Spent" />
                                    <Bar dataKey="income" fill="#3b82f6" radius={[3, 3, 0, 0]} name="Income" />
                                  </ComposedChart>
                                </ResponsiveContainer>
                                <div className="flex gap-4 justify-center text-xs text-slate-500 mt-1">
                                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-rose-500" /> Spent</span>
                                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-blue-500" /> Income</span>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── Spending by Category ─────────────────────── */}
                    {catRanked.length > 0 && (
                      <div>
                        <SectionLabel>Spending by Category</SectionLabel>
                        <div className="bg-slate-900 rounded-2xl overflow-hidden divide-y divide-slate-800/60">
                          {catRanked.map(([cat, amt], idx) => {
                            const barPct  = (amt / maxSpend) * 100;
                            const sharePct = totalCatSpend > 0 ? (amt / totalCatSpend) * 100 : 0;
                            const barColor = rankColors[Math.min(idx, rankColors.length - 1)];
                            const isTop    = idx === 0;
                            const isLow    = idx >= catRanked.length - 2 && catRanked.length > 3;
                            return (
                              <div key={cat} className="px-5 py-3.5">
                                <div className="flex items-center justify-between mb-2 gap-3">
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <span className="text-slate-600 text-[11px] font-mono w-4 shrink-0 tabular-nums">
                                      {idx + 1}
                                    </span>
                                    <span className="text-white text-sm truncate">{cat}</span>
                                    {isTop && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-900/50 text-rose-300 shrink-0">most</span>
                                    )}
                                    {isLow && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-900/40 text-emerald-400 shrink-0">least</span>
                                    )}
                                  </div>
                                  <div className="text-right shrink-0">
                                    <span className="text-white text-sm font-mono font-semibold tabular-nums">${amt.toFixed(2)}</span>
                                    <span className="text-slate-500 text-[10px] ml-2">{sharePct.toFixed(1)}%</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                    <div
                                      className="h-1.5 rounded-full transition-all duration-500"
                                      style={{ width: `${barPct}%`, background: barColor }}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                          <div className="px-5 py-3 flex justify-between items-center bg-slate-800/40">
                            <span className="text-slate-400 text-xs">{catRanked.length} categories</span>
                            <span className="text-white text-sm font-mono font-bold tabular-nums">${totalCatSpend.toFixed(2)} total</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── Budget vs Actual chart ───────────────────── */}
                    {priGroups.length > 0 && (() => {
                      const bvaData = priGroups.map(g => ({
                        name: g.label,
                        budget: g.items.reduce((s, e) => s + (parseFloat(e['Monthly Allowance ($)']) || 0), 0),
                        actual: g.items.reduce((s, e) => s + (parseFloat(e['Actual Spend'] || 0)), 0),
                        color: { '1':'#f43f5e','2':'#f59e0b','3':'#8b5cf6' }[g.p],
                      }));
                      return (
                        <div>
                          <SectionLabel>Budget vs Actual</SectionLabel>
                          <div className="bg-slate-900 rounded-2xl p-4">
                            <ResponsiveContainer width="100%" height={160}>
                              <BarChart data={bvaData} barCategoryGap="30%">
                                <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: "'ZTNature', system-ui, sans-serif" }} axisLine={false} tickLine={false} />
                                <YAxis tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: "'ZTNature', system-ui, sans-serif" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={50} />
                                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9', fontFamily: "'ZTNature', system-ui, sans-serif", fontSize: 12 }} formatter={v => [`$${v.toFixed(2)}`]} />
                                <Bar dataKey="budget" fill="#1e293b" stroke="#334155" strokeWidth={1} radius={[4, 4, 0, 0]} name="Budget" />
                                <Bar dataKey="actual" radius={[4, 4, 0, 0]} name="Actual">
                                  {bvaData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                                </Bar>
                              </BarChart>
                            </ResponsiveContainer>
                            <div className="flex gap-4 justify-center text-xs text-slate-500 mt-2">
                              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-slate-800 border border-slate-700" /> Budget</span>
                              {bvaData.map(d => (
                                <span key={d.name} className="flex items-center gap-1.5">
                                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: d.color }} /> {d.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── Budget Allocation ────────────────────────── */}
                    <div>
                      <SectionLabel>Budget Allocation</SectionLabel>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {priGroups.map(g => {
                          const gAllw = g.items.reduce((s, e) => s + (parseFloat(e['Monthly Allowance ($)']) || 0), 0);
                          const gSpent = g.items.reduce((s, e) => s + (parseFloat(e['Actual Spend'] || 0)), 0);
                          const gPct = gAllw > 0 ? Math.min((gSpent / gAllw) * 100, 100) : 0;
                          const priBarClr = { '1':'#f43f5e','2':'#f59e0b','3':'#8b5cf6' }[g.p];
                          return (
                            <div key={g.p} className={`rounded-2xl border ${g.border} overflow-hidden`}>
                              {/* Section header */}
                              <div className={`px-5 py-3 ${g.bg} flex items-center justify-between`}>
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs font-bold ${g.color}`}>P{g.p} — {g.label}</span>
                                  <span className="text-slate-600 text-[10px]">· {g.items.length} items</span>
                                </div>
                                <div className="text-right">
                                  <span className="text-white text-sm font-mono font-semibold tabular-nums">{fmtS(gAllw)}</span>
                                  {gSpent > 0 && (
                                    <span className={`text-[10px] font-mono ml-2 ${gSpent > gAllw ? 'text-rose-400' : 'text-slate-400'}`}>
                                      {fmtS(gSpent)} spent
                                    </span>
                                  )}
                                </div>
                              </div>
                              {/* Section progress */}
                              {gAllw > 0 && (
                                <div className="px-5 py-1.5 bg-slate-900/50">
                                  <div className="w-full bg-slate-800 rounded-full h-1 overflow-hidden">
                                    <div className="h-1 rounded-full" style={{ width: `${gPct}%`, background: gSpent > gAllw ? '#ef4444' : priBarClr }} />
                                  </div>
                                </div>
                              )}
                              {/* Items */}
                              <div className="divide-y divide-slate-800/60">
                                {g.items.map((e, i) => {
                                  const allw = parseFloat(e['Monthly Allowance ($)']) || 0;
                                  const sp   = parseFloat(e['Actual Spend'] || 0);
                                  const pct  = allw > 0 ? Math.min((sp / allw) * 100, 100) : 0;
                                  const over = sp > allw && allw > 0;
                                  return (
                                    <div key={i} className="px-5 py-3.5 bg-slate-900/40">
                                      <div className="flex justify-between items-start mb-2 gap-3">
                                        <div className="min-w-0">
                                          <p className="text-white text-sm">{e['Type']}</p>
                                          <p className="text-slate-500 text-[10px] mt-0.5">{e['Expense'] || e['Account']}</p>
                                        </div>
                                        <div className="text-right shrink-0">
                                          <p className="text-white text-sm font-mono tabular-nums">{fmtS(allw)}</p>
                                          <p className={`text-[10px] font-mono tabular-nums mt-0.5 ${over ? 'text-rose-400' : sp > 0 ? 'text-slate-400' : 'text-slate-600'}`}>
                                            {sp > 0 ? `${fmtS(sp)} spent` : 'no spend yet'}
                                          </p>
                                        </div>
                                      </div>
                                      {allw > 0 && (
                                        <div className="flex items-center gap-2">
                                          <div className="flex-1 bg-slate-800 rounded-full h-1 overflow-hidden">
                                            <div className="h-1 rounded-full transition-all" style={{ width: `${pct}%`, background: over ? '#ef4444' : priBarClr }} />
                                          </div>
                                          <span className="text-slate-600 text-[10px] font-mono w-8 text-right tabular-nums">{pct.toFixed(0)}%</span>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* ── Transactions ─────────────────────────────── */}
                    <div>
                      <SectionLabel>All Transactions · {stmtTxns.length}</SectionLabel>
                      {stmtTxns.length === 0 ? (
                        <div className="bg-slate-900 rounded-2xl p-8 text-center">
                          <p className="text-slate-500 text-sm">No transactions found for {currentMonth}</p>
                        </div>
                      ) : (
                        <div className="bg-slate-900 rounded-2xl overflow-hidden divide-y divide-slate-800/60">
                          {stmtTxns.map((t, i) => (
                            <div key={i} className="px-5 py-3.5 flex items-center justify-between gap-4">
                              <div className="min-w-0 flex-1">
                                <p className="text-white text-sm truncate">{t.type || t.desc}</p>
                                <p className="text-slate-500 text-[10px] mt-0.5">
                                  {t.date}
                                  {t.account && <> · <span className="text-slate-600">{t.account}</span></>}
                                  {t.desc && t.desc !== t.type && <> · <span className="text-slate-600 truncate">{t.desc}</span></>}
                                </p>
                              </div>
                              <span className={`font-mono text-sm font-semibold tabular-nums shrink-0 ${t.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {fmtS(t.amount)}
                              </span>
                            </div>
                          ))}
                          <div className="px-5 py-3.5 flex items-center justify-between bg-slate-800/60">
                            <span className="text-slate-300 text-sm font-semibold">Net Total</span>
                            <span className={`font-mono text-sm font-bold tabular-nums ${stmtTxns.reduce((s, t) => s + t.amount, 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {fmtS(stmtTxns.reduce((s, t) => s + t.amount, 0))}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
