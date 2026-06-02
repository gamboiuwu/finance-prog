import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { readRange, readReportLinks, appendRow, ensureSheetTab, batchUpdateCells, clearRow } from '../lib/sheets';
import { fetchGasPrices } from '../lib/gasPrice';
import { SHEETS, MONTHS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import ProcessIncome from '../components/ProcessIncome';
import { ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

function pm(val) {
  if (!val && val !== 0) return 0;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
function fmt(val) {
  const n = parseFloat(String(val ?? '').replace(/[$,\s]/g, ''));
  if (isNaN(n)) return '—';
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

const SUB_CYCLES = ['monthly', 'annual', 'weekly', 'biweekly'];

// Convert a subscription's raw billing amount to its monthly equivalent
function toMonthly(amount, cycle) {
  const amt = parseFloat(amount) || 0;
  switch ((cycle || 'monthly').toLowerCase()) {
    case 'annual':   return amt / 12;
    case 'weekly':   return (amt * 52) / 12;
    case 'biweekly': return (amt * 26) / 12;
    default:         return amt;
  }
}
// Label for how the raw amount is billed (used beside the input)
function cycleAmountLabel(cycle) {
  switch ((cycle || 'monthly').toLowerCase()) {
    case 'annual':   return '/yr';
    case 'weekly':   return '/wk';
    case 'biweekly': return '/2wk';
    default:         return '/mo';
  }
}

function nextRenewal(startDateStr, cycle) {
  if (!startDateStr) return null;
  const start = new Date(startDateStr + 'T12:00:00');
  if (isNaN(start)) return null;
  const today = new Date(); today.setHours(12, 0, 0, 0);
  if (cycle === 'annual') {
    const d = new Date(start); d.setFullYear(today.getFullYear());
    if (d < today) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  if (cycle === 'monthly') {
    const d = new Date(start); d.setFullYear(today.getFullYear()); d.setMonth(today.getMonth());
    if (d < today) d.setMonth(d.getMonth() + 1);
    return d;
  }
  if (cycle === 'weekly' || cycle === 'biweekly') {
    const period = cycle === 'weekly' ? 7 : 14;
    const elapsed = Math.floor((today - start) / 86400000);
    const rem = period - (elapsed % period);
    const d = new Date(today); d.setDate(d.getDate() + (rem === period ? 0 : rem));
    return d;
  }
  return null;
}

function daysUntil(date) {
  if (!date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
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

// Arc gauge SVG: 240° arc from 8-o'clock (150°) clockwise to 4-o'clock (30°), gap at bottom
const GAUGE_CX = 60, GAUGE_CY = 60, GAUGE_R = 46;
const GAUGE_START = 150, GAUGE_SWEEP = 240;
function gaugePoint(deg) {
  const r = deg * Math.PI / 180;
  return { x: +(GAUGE_CX + GAUGE_R * Math.cos(r)).toFixed(2), y: +(GAUGE_CY + GAUGE_R * Math.sin(r)).toFixed(2) };
}
const GAUGE_BG_S = gaugePoint(GAUGE_START);
const GAUGE_BG_E = gaugePoint(GAUGE_START + GAUGE_SWEEP); // 390° = 30°

function HealthScoreCard({ score, signals, history, expanded, onToggle }) {
  const tier = score >= 80 ? { label: 'Excellent',       color: '#10b981', cls: 'border-emerald-700/50 bg-emerald-900/20' }
             : score >= 60 ? { label: 'Good',             color: '#14b8a6', cls: 'border-teal-700/50 bg-teal-900/20'    }
             : score >= 40 ? { label: 'Fair',             color: '#f59e0b', cls: 'border-amber-700/50 bg-amber-900/20'  }
             :               { label: 'Needs Attention',  color: '#ef4444', cls: 'border-rose-700/50 bg-rose-900/20'    };

  const sweep  = (score / 100) * GAUGE_SWEEP;
  const fgPt   = gaugePoint(GAUGE_START + sweep);
  const fgPath = sweep > 1 ? `M ${GAUGE_BG_S.x} ${GAUGE_BG_S.y} A ${GAUGE_R} ${GAUGE_R} 0 ${sweep > 180 ? 1 : 0} 1 ${fgPt.x} ${fgPt.y}` : null;
  const bgPath = `M ${GAUGE_BG_S.x} ${GAUGE_BG_S.y} A ${GAUGE_R} ${GAUGE_R} 0 1 1 ${GAUGE_BG_E.x} ${GAUGE_BG_E.y}`;
  const tgt    = gaugePoint(GAUGE_START + 0.8 * GAUGE_SWEEP); // target at 80

  return (
    <div className={`border rounded-2xl p-4 transition-colors ${tier.cls}`}>
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center gap-3">
          <svg width="112" height="88" viewBox="0 0 120 90" className="shrink-0">
            <path d={bgPath} fill="none" stroke="#1e293b" strokeWidth="9" strokeLinecap="round" />
            {fgPath && <path d={fgPath} fill="none" stroke={tier.color} strokeWidth="9" strokeLinecap="round" />}
            {/* target marker at 80 */}
            <circle cx={tgt.x} cy={tgt.y} r="4.5" fill="#f59e0b" />
            <circle cx={tgt.x} cy={tgt.y} r="2"   fill="rgba(255,255,255,0.5)" />
            <text x={GAUGE_CX} y={GAUGE_CY + 6}  textAnchor="middle" fill="white"   fontSize="20" fontWeight="bold" fontFamily="system-ui">{score}</text>
            <text x={GAUGE_CX} y={GAUGE_CY + 19} textAnchor="middle" fill="#64748b" fontSize="9"  fontFamily="system-ui">/100</text>
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-sm">Financial Health</p>
            <p className="text-xs font-semibold mt-0.5" style={{ color: tier.color }}>{tier.label}</p>
            <p className="text-slate-500 text-xs mt-0.5">
              Target: <span className="text-amber-400 font-medium">80</span>
              {score < 80 ? ` · ${80 - score} pts to go` : ' · Goal reached!'}
            </p>
            {history.length > 1 && (
              <div className="flex items-end gap-0.5 mt-2 h-4">
                {history.slice(-6).map((h, i, arr) => {
                  const ht = Math.max(3, Math.round((h.score / 100) * 16));
                  const c  = h.score >= 80 ? '#10b981' : h.score >= 60 ? '#14b8a6' : h.score >= 40 ? '#f59e0b' : '#ef4444';
                  return <div key={i} className="rounded-sm w-2.5" style={{ height: `${ht}px`, background: i === arr.length - 1 ? c : '#334155' }} />;
                })}
              </div>
            )}
          </div>
          <span className="text-slate-500 text-lg shrink-0 leading-none">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-700/50 space-y-3">
          {signals.map((s, i) => (
            <div key={i}>
              <div className="flex justify-between items-center text-xs mb-1">
                <span className="text-slate-300">{s.label}</span>
                <span className={`font-mono font-medium ${s.penalty && s.score < 0 ? 'text-rose-400' : 'text-slate-200'}`}>
                  {s.penalty ? (s.score < 0 ? `${s.score}` : '0') : `+${s.score}`} / {s.penalty ? '0' : s.max} pts
                </span>
              </div>
              {!s.penalty && (
                <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                  <div className="h-1.5 rounded-full transition-all" style={{ width: `${Math.min(s.pct * 100, 100)}%`, background: tier.color }} />
                </div>
              )}
            </div>
          ))}
          <p className="text-slate-600 text-[10px] text-right">🟡 = target 80 · sparkline = last 6 months</p>
        </div>
      )}
    </div>
  );
}

// Collapsible 6-month grouped bar chart: income (teal) vs expenses (rose)
function TrendChartCard({ data, expanded, onToggle }) {
  const last6    = data.slice(-6);
  if (last6.length < 2) return null;
  const last     = last6[last6.length - 1];
  const prev     = last6[last6.length - 2];
  const incDelta = last.income - prev.income;
  const sptDelta = last.spent  - prev.spent;
  const avgNet   = last6.reduce((s, m) => s + m.net, 0) / last6.length;
  return (
    <div className="bg-slate-800 border border-slate-700/60 rounded-2xl p-4">
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-white font-bold text-sm">📈 6-Month Trend</p>
            <p className="text-slate-400 text-xs mt-0.5">Income vs. Expenses</p>
          </div>
          <span className="text-slate-500 text-lg leading-none">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>
      {expanded && (
        <>
          <div className="mt-3 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={last6} barCategoryGap="25%" barGap={2}>
                <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip
                  formatter={(v, name) => [`$${Number(v).toFixed(0)}`, name === 'income' ? 'Income' : 'Expenses']}
                  contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8, color: '#f1f5f9', fontSize: 12 }}
                />
                <Bar dataKey="income" fill="#14b8a6" radius={[3, 3, 0, 0]} name="income" />
                <Bar dataKey="spent"  fill="#f43f5e" radius={[3, 3, 0, 0]} name="spent"  />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 mt-1 justify-center text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-teal-500 inline-block" />Income</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-rose-500 inline-block" />Expenses</span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-700 space-y-1 text-xs text-slate-400">
            <div className="flex justify-between">
              <span>Last mo vs prev</span>
              <span className="flex gap-3">
                <span>Income <span className={incDelta >= 0 ? 'text-teal-400' : 'text-rose-400'}>{incDelta >= 0 ? '▲' : '▼'}${Math.abs(incDelta).toFixed(0)}</span></span>
                <span>Expenses <span className={sptDelta <= 0 ? 'text-teal-400' : 'text-rose-400'}>{sptDelta >= 0 ? '▲' : '▼'}${Math.abs(sptDelta).toFixed(0)}</span></span>
              </span>
            </div>
            <div className="flex justify-between">
              <span>6-mo avg net</span>
              <span className={avgNet >= 0 ? 'text-teal-400 font-medium' : 'text-rose-400 font-medium'}>{avgNet >= 0 ? '+' : ''}${avgNet.toFixed(0)}/mo</span>
            </div>
            <p className={`italic pt-1 ${incDelta > 0 && sptDelta <= 0 ? 'text-emerald-300' : incDelta > 0 ? 'text-teal-300' : sptDelta <= 0 ? 'text-amber-300' : 'text-slate-500'}`}>
              {incDelta > 0 && sptDelta <= 0
                ? 'Income up, expenses down — great discipline! 🐉'
                : incDelta > 0
                  ? 'Income is trending up — keep the momentum going!'
                  : sptDelta <= 0
                    ? 'Expenses are down — you\'re making smart calls.'
                    : 'Income dipped — one strong month flips this chart.'}
            </p>
          </div>
        </>
      )}
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
  const [gasBalance, setGasBalance]     = useState(null);
  const [showExpLog, setShowExpLog]     = useState(false);
  const [expAmount, setExpAmount]       = useState('');
  const [expCategory, setExpCategory]   = useState('');
  const [expNote, setExpNote]           = useState('');
  const [expLogging, setExpLogging]     = useState(false);
  const [expLogDone, setExpLogDone]     = useState(false);
  const [showBills, setShowBills]       = useState(false);
  const [showCommCalc, setShowCommCalc]     = useState(false);
  const [showBudget, setShowBudget]         = useState(false);
  const [showMonthClose, setShowMonthClose] = useState(false);
  const [showStatement, setShowStatement]   = useState(false);
  const [subscriptions, setSubscriptions]   = useState([]);
  const [showSubs, setShowSubs]             = useState(false);
  const [subNotifLead, setSubNotifLead]     = useState(() => {
    const v = parseInt(localStorage.getItem('_fin_sub_notif_lead') || '3', 10);
    return [1, 3, 7].includes(v) ? v : 3;
  });
  const [calMonth, setCalMonth]             = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selectedCalDay, setSelectedCalDay] = useState(null);
  const [stmtLoading, setStmtLoading]   = useState(false);
  const [stmtTxns, setStmtTxns]         = useState([]);
  const [stmtError, setStmtError]       = useState(null);
  const [stmtFromClose, setStmtFromClose] = useState(false);
  const [budgetAlerts, setBudgetAlerts] = useState({ overCount: 0, needsCount: 0, dueAlerts: [] });
  const [allocTotals, setAllocTotals]   = useState({ income: 0, spent: 0 });
  const [hasCurrentMonthAllocRows, setHasCurrentMonthAllocRows] = useState(null);
  const [healthScore, setHealthScore]   = useState({ total: 0, signals: [], history: [], loaded: false });
  const [healthExpanded, setHealthExpanded] = useState(false);
  const [trendExpanded, setTrendExpanded]   = useState(false);
  const [monthNote, setMonthNote] = useState(() => {
    try {
      const d = new Date();
      const k = `${d.getFullYear()}-${d.getMonth()+1}`;
      return JSON.parse(localStorage.getItem('_fin_month_notes') || '{}')[k] || '';
    } catch { return ''; }
  });
  const [showNoteDrawer, setShowNoteDrawer] = useState(false);
  const [noteInput, setNoteInput]           = useState('');
  const [showArchive, setShowArchive]         = useState(false);
  const [archiveEntry, setArchiveEntry]       = useState(null);

  const now = new Date();
  const currentMonth = MONTHS[now.getMonth()];
  const currentYear  = now.getFullYear();
  // The month available to close is always the previous calendar month
  const closeDate  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const closeMonth = MONTHS[closeDate.getMonth()];
  const closeYear  = closeDate.getFullYear();

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    // Core sheet data only — the external gas-price API is fetched separately
    // (below) so a slow/rate-limited EIA response can never block first paint.
    Promise.all([
      readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A1:P13`),
      readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A1:T40`),
      readReportLinks(token),
      readRange(token, 'Subscriptions!A:E').catch(() => []),
      readRange(token, 'Allocation Transactions!A:F', 'UNFORMATTED_VALUE').catch(() => []),
    ])
      .then(([summaryRows, expRows, links, subRows, allocRows]) => {
        setReportLinks(links);

        if (summaryRows.length) {
          const [headers, ...data] = summaryRows;
          setAllMonths(data.filter(r => r[0]).map(r =>
            headers.reduce((o, h, i) => { o[h] = r[i] ?? null; return o; }, {})
          ));
        }

        let expItems = [];
        if (expRows.length) {
          const [headers, ...data] = expRows;
          expItems = data.filter(r => r[0]).map(r =>
            headers.reduce((o, h, i) => { o[h] = r[i] ?? null; return o; }, {})
          );
          setExpenses(expItems);
        }

        // Single pass over Allocation Transactions: current-month budget totals
        // + all-time gas balance (replaces the separate A:C read for gas).
        if (allocRows.length > 1) {
          const d0 = new Date();
          const mo0 = d0.getMonth() + 1;
          const yr0 = d0.getFullYear();
          const abt = {};
          let monthIncome = 0, monthSpent = 0, gasBal = 0, hasCurrentRows = false;
          // Collect the previous (close) month's rows so we can auto-archive its statement
          const closeMo = closeDate.getMonth() + 1, closeYr = closeDate.getFullYear();
          const closeTxns = [];
          const [, ...allocData] = allocRows;
          allocData.forEach(r => {
            if (!r[0] || !r[1]) return;
            const amt = pm(r[2]);
            if (String(r[1]).trim().toLowerCase() === 'gas') gasBal += amt;
            const ds = String(r[0]);
            const n = Number(ds);
            let d;
            if (!isNaN(n) && n > 1000 && !ds.includes('/')) {
              d = new Date(Math.round((n - 25569) * 86400000));
            } else {
              d = new Date(ds);
            }
            if (!d || isNaN(d.getTime())) return;
            // Capture the close-month rows for the auto-archived statement
            if (d.getMonth() + 1 === closeMo && d.getFullYear() === closeYr) {
              closeTxns.push({
                date: `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
                type: String(r[1]), amount: amt,
                desc: r[3] != null ? String(r[3]) : '', account: r[4] != null ? String(r[4]) : '',
              });
            }
            if (d.getMonth() + 1 !== mo0 || d.getFullYear() !== yr0) return;
            hasCurrentRows = true;
            if (amt > 0) {
              abt[String(r[1])] = (abt[String(r[1])] || 0) + amt;
              monthIncome += amt;
            } else {
              monthSpent += Math.abs(amt);
            }
          });
          setAllocTotals({ income: monthIncome, spent: monthSpent });
          setHasCurrentMonthAllocRows(hasCurrentRows);
          setGasBalance(gasBal);

          // Auto-backfill the previous month's statement into the archive if it
          // isn't there yet (so closed months appear without a manual close).
          try {
            const arch = JSON.parse(localStorage.getItem('_fin_statements') || '{}');
            const closeKey = `${closeMonth} ${closeYear}`;
            if (!arch[closeKey]) {
              const closeRows = (summaryRows.length ? summaryRows.slice(1) : [])
                .map(r => summaryRows[0].reduce((o, h, i) => { o[h] = r[i] ?? null; return o; }, {}));
              const closeRow = closeRows.find(m => m['Month'] === closeMonth && String(m['Year']) === String(closeYear))
                || closeRows.find(m => m['Month'] === closeMonth);
              const cInc = closeTxns.reduce((s, t) => t.amount > 0 ? s + t.amount : s, 0) || pm(closeRow?.['Total Processed Income']);
              const cSpt = closeTxns.reduce((s, t) => t.amount < 0 ? s + Math.abs(t.amount) : s, 0) || pm(closeRow?.['Total Spent']);
              const cGoal = (expItems.length ? expItems : []).reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0) || pm(closeRow?.['Allowance Goal']);
              if (cInc > 0 || cSpt > 0 || closeTxns.length) {
                saveStatementArchive(closeMonth, closeYear, cInc, cSpt, cGoal, closeTxns);
              }
            }
          } catch {}
          if (expItems.length) {
            const mainExp = expItems.filter(i => i['Expense'] !== 'Savings');
            const overCount = mainExp.filter(i => {
              const b = pm(i['Monthly Allowance ($)']);
              return b > 0 && (abt[i['Type'] || ''] || 0) > b;
            }).length;
            const needsCount = mainExp.filter(i =>
              String(i['Priority'] ?? '3') === '1' &&
              pm(i['Monthly Allowance ($)']) > 0 &&
              !(abt[i['Type'] || ''] > 0)
            ).length;
            let dueDateMap = {};
            try { dueDateMap = JSON.parse(localStorage.getItem('_fin_due_dates') || '{}'); } catch {}
            const todayDay = new Date().getDate();
            const dueAlerts = mainExp
              .filter(i => {
                const dd = dueDateMap[i['Type'] || ''];
                if (dd == null) return false;
                const alloc = abt[i['Type'] || ''] || 0;
                const goal  = pm(i['Monthly Allowance ($)']);
                if (goal <= 0 || alloc >= goal) return false;
                const diff = dd - todayDay;
                return diff >= 0 && diff <= 3;
              })
              .map(i => ({ type: i['Type'], daysUntil: dueDateMap[i['Type']] - todayDay }));
            setBudgetAlerts({ overCount, needsCount, dueAlerts });
            localStorage.setItem('_fin_budget_alert', JSON.stringify({ count: overCount, month: `${yr0}-${mo0}` }));
            window.dispatchEvent(new Event('_fin_budget_alert_update'));

            // Financial Health Score — 4 weighted signals, no extra API calls
            const p1Items = mainExp.filter(i => String(i['Priority']??'3')==='1' && pm(i['Monthly Allowance ($)'])>0);
            const p1Done  = p1Items.filter(i => (abt[i['Type']||'']||0) >= pm(i['Monthly Allowance ($)']));
            const s1Pct   = p1Items.length > 0 ? p1Done.length / p1Items.length : 1;
            const s1      = s1Pct * 40;

            const savExp   = expItems.filter(i => i['Expense'] === 'Savings');
            const savAlloc = savExp.reduce((sum, e) => sum + (abt[e['Type']||'']||0), 0);
            const s2Pct    = monthIncome > 0 ? Math.min(savAlloc / monthIncome, 1) : 0;
            const s2       = s2Pct * 25;

            const allBudg  = expItems.filter(i => pm(i['Monthly Allowance ($)'])>0);
            const s3Pct    = allBudg.length > 0 ? allBudg.filter(i => (abt[i['Type']||'']||0) > 0).length / allBudg.length : 0;
            const s3       = s3Pct * 20;

            const s4    = -Math.min(overCount * 3, 15);
            const total = Math.max(0, Math.min(100, Math.round(s1 + s2 + s3 + s4)));

            let hist = [];
            try { hist = JSON.parse(localStorage.getItem('_fin_health_history') || '[]'); } catch {}
            const nowKey = `${yr0}-${mo0}`;
            const hi = hist.findIndex(h => h.month === nowKey);
            if (hi >= 0) hist[hi].score = total; else hist.push({ month: nowKey, score: total });
            if (hist.length > 6) hist.splice(0, hist.length - 6);
            try { localStorage.setItem('_fin_health_history', JSON.stringify(hist)); } catch {}

            setHealthScore({
              total, loaded: true, history: hist,
              signals: [
                { label: 'Essential Coverage',      score: +(s1.toFixed(1)), max: 40, pct: s1Pct },
                { label: 'Savings Rate',            score: +(s2.toFixed(1)), max: 25, pct: s2Pct },
                { label: 'Allocation Completeness', score: +(s3.toFixed(1)), max: 20, pct: s3Pct },
                { label: 'Over-Budget Penalty',     score: s4,              max: 0,  pct: 0, penalty: true },
              ],
            });

            // Browser push when score < 40 (once per day)
            if (total < 40 && typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
              const today = new Date().toISOString().slice(0, 10);
              if (localStorage.getItem('_fin_health_notified') !== today) {
                const doNotify = () => {
                  try {
                    new Notification('Finance Health Alert ⚠', { body: `Health score ${total}/100 — review your budget`, tag: 'fin-health' });
                    localStorage.setItem('_fin_health_notified', today);
                  } catch {}
                };
                if (Notification.permission === 'granted') doNotify();
                else Notification.requestPermission().then(p => { if (p === 'granted') doNotify(); });
              }
            }
          }
        }

        if (subRows.length > 1) {
          const [hdr, ...data] = subRows;
          const parsedSubs = data
            .map((r, idx) => ({ row: r, rowNum: idx + 2 }))
            .filter(({ row }) => row[0])
            .map(({ row, rowNum }) => ({
              ...hdr.reduce((o, h, i) => { o[h] = row[i] ?? ''; return o; }, {}),
              _rowNum: rowNum,
            }));
          setSubscriptions(parsedSubs);

          // Subscription renewal push notifications (Task 22)
          const lead = parseInt(localStorage.getItem('_fin_sub_notif_lead') || '3', 10);
          const todayStr = new Date().toISOString().slice(0, 10);
          let sent = {};
          try { sent = JSON.parse(localStorage.getItem('_fin_sub_notif_sent') || '{}'); } catch {}
          const alreadySent = sent[todayStr] || [];
          const upcoming = parsedSubs.filter(s => {
            if (alreadySent.includes(s.Name)) return false;
            const d = nextRenewal(s['Start Date'], (s.Cycle || 'monthly').toLowerCase());
            const diff = daysUntil(d);
            return diff !== null && diff >= 0 && diff <= lead;
          });
          if (upcoming.length > 0 && typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
            const doSubNotify = () => {
              try {
                if (upcoming.length === 1) {
                  const s = upcoming[0];
                  const d = nextRenewal(s['Start Date'], (s.Cycle || 'monthly').toLowerCase());
                  const diff = daysUntil(d);
                  new Notification(`🔁 ${s.Name} renews ${diff === 0 ? 'today' : `in ${diff} day${diff !== 1 ? 's' : ''}`}`, {
                    body: `$${parseFloat(s.Amount || 0).toFixed(2)}${cycleAmountLabel(s.Cycle)}`,
                    tag: 'fin-sub-renewal',
                  });
                } else {
                  const lines = upcoming.map(s => {
                    const d = nextRenewal(s['Start Date'], (s.Cycle || 'monthly').toLowerCase());
                    const diff = daysUntil(d);
                    return `${s.Name} (${diff === 0 ? 'today' : `in ${diff}d`}) — $${parseFloat(s.Amount || 0).toFixed(2)}`;
                  }).join('\n');
                  new Notification(`🔁 ${upcoming.length} subscriptions renewing soon`, { body: lines, tag: 'fin-sub-renewal' });
                }
                sent[todayStr] = [...alreadySent, ...upcoming.map(s => s.Name)];
                localStorage.setItem('_fin_sub_notif_sent', JSON.stringify(sent));
              } catch {}
            };
            if (Notification.permission === 'granted') doSubNotify();
            else Notification.requestPermission().then(p => { if (p === 'granted') doSubNotify(); });
          }
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  // Fetch the external gas-price API after first paint (non-blocking) so a
  // slow or rate-limited EIA response never delays the dashboard rendering.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetchGasPrices()
      .then(gas => {
        if (cancelled || !gas) return;
        const nyc = gas.byRegion['Y35NY']?.products['EPMR']?.value;
        setGasPrice({ value: nyc, period: gas.period });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <div className="p-4 text-red-400">Error: {error}</div>;

  const current = allMonths.find(
    m => m['Month'] === currentMonth && String(m['Year']) === String(currentYear)
  );

  // Once allocation data is loaded, use it as ground truth for current-month income.
  // This prevents stale sheet formula values (e.g., copied from prior month) from
  // showing as income at the start of a new month before any income is processed.
  const income      = hasCurrentMonthAllocRows !== null
    ? allocTotals.income
    : (allocTotals.income || pm(current?.['Total Processed Income']));
  const unprocessed = pm(current?.['Unprocessed Income']);
  const spent       = allocTotals.spent   || pm(current?.['Total Spent']);
  const goal        = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0) || pm(current?.['Allowance Goal']);
  const net         = income - spent;
  const goalPct     = goal > 0 ? (income / goal) * 100 : 0;
  const spendPct    = income > 0 ? (spent / income) * 100 : 0;

  const chartData = allMonths
    .filter(m => pm(m['Total Processed Income']) > 0)
    .map(m => {
      const inc = pm(m['Total Processed Income']);
      const spt = pm(m['Total Spent']);
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
      setGasBalance(b => (b ?? 0) - Math.abs(amt));
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
      const rows = await readRange(token, 'Allocation Transactions!A:F', 'UNFORMATTED_VALUE');
      const [, ...data] = rows;
      const parseAmt = v => {
        if (v == null || v === '') return 0;
        const s = String(v).trim();
        const neg = s.startsWith('(') || s.startsWith('-');
        const n = parseFloat(s.replace(/[$,\s()]/g, '').replace(/^-/, ''));
        return isNaN(n) ? 0 : neg ? -n : n;
      };
      const txns = data
        .filter(r => r[0])
        .filter(r => {
          const parts = String(r[0] || '').split('/');
          return parseInt(parts[0]) === mo && parseInt(parts[2]) === yr;
        })
        .map(r => ({
          date: r[0], type: r[1] || '',
          amount: parseAmt(r[2]),
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

  function saveMonthNote(text) {
    const k = `${now.getFullYear()}-${now.getMonth()+1}`;
    try {
      const all = JSON.parse(localStorage.getItem('_fin_month_notes') || '{}');
      if (text.trim()) all[k] = text.trim(); else delete all[k];
      localStorage.setItem('_fin_month_notes', JSON.stringify(all));
      setMonthNote(text.trim());
    } catch {}
  }

  function saveStatementArchive(month, year, incomeVal, spentVal, goalVal, txns) {
    try {
      const archive = JSON.parse(localStorage.getItem('_fin_statements') || '{}');
      const key = `${month} ${year}`;
      archive[key] = {
        month, year: String(year),
        income: incomeVal, spent: spentVal, net: incomeVal - spentVal, goal: goalVal,
        closedAt: new Date().toISOString(),
        note: (() => { try { return JSON.parse(localStorage.getItem('_fin_month_notes') || '{}')[`${year}-${MONTHS.indexOf(month) + 1}`] || ''; } catch { return ''; } })(),
        ...(txns?.length ? { txns: txns.map(t => ({ date: t.date, type: t.type, amount: t.amount, desc: t.desc, account: t.account })) } : {}),
      };
      const keys = Object.keys(archive).sort((a, b) => {
        const [am, ay] = [MONTHS.indexOf(a.split(' ')[0]), parseInt(a.split(' ')[1])];
        const [bm, by] = [MONTHS.indexOf(b.split(' ')[0]), parseInt(b.split(' ')[1])];
        return ay !== by ? ay - by : am - bm;
      });
      while (keys.length > 24) delete archive[keys.shift()];
      localStorage.setItem('_fin_statements', JSON.stringify(archive));
    } catch {}
  }

  function printStatement(current, stmtTxns, expenses, currentMonth, currentYear) {
    const fmtAmt = n => {
      if (n == null || isNaN(n)) return '—';
      return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
    };
    // Sheet-sourced strings (categories, descriptions, accounts) are untrusted
    // when injected into the printable statement HTML — escape to prevent
    // HTML/script injection via document.write.
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    const income = stmtTxns.reduce((s, t) => t.amount > 0 ? s + t.amount : s, 0) || pm(current?.['Total Processed Income']);
    const spent  = stmtTxns.reduce((s, t) => t.amount < 0 ? s + Math.abs(t.amount) : s, 0) || pm(current?.['Total Spent']);
    const goal   = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0) || pm(current?.['Allowance Goal']);
    const net    = income - spent;

    // Group expenses by priority
    const priGroups = ['1','2','3'].map(p => ({
      p, label: { '1':'Essential','2':'Stability','3':'Optional' }[p],
      items: expenses.filter(e => String(e['Priority'] ?? '3') === p && pm(e['Monthly Allowance ($)']) > 0),
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
        const allw = pm(e['Monthly Allowance ($)']);
        const sp   = pm(e['Actual Spend']);
        const rem  = allw - sp;
        return `<tr>
          <td>${esc(e['Type'] || '—')}</td>
          <td style="color:#666">${esc(e['Account'] || '—')}</td>
          <td class="amt">${fmtAmt(allw)}</td>
          <td class="amt ${sp > allw ? 'neg' : ''}">${fmtAmt(sp)}</td>
          <td class="amt ${rem < 0 ? 'neg' : ''}">${fmtAmt(rem)}</td>
        </tr>`;
      }).join('')}
      <tr style="font-weight:bold;background:#fafafa">
        <td colspan="2">Subtotal</td>
        <td class="amt">${fmtAmt(g.items.reduce((s,e)=>s+pm(e['Monthly Allowance ($)']),0))}</td>
        <td class="amt">${fmtAmt(g.items.reduce((s,e)=>s+pm(e['Actual Spend']),0))}</td>
        <td class="amt">${fmtAmt(g.items.reduce((s,e)=>s+(pm(e['Monthly Allowance ($)'])-pm(e['Actual Spend'])),0))}</td>
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
        <td style="white-space:nowrap;color:#555">${esc(t.date)}</td>
        <td>${esc(t.type)}</td>
        <td style="color:#555;font-size:9.5pt">${esc(t.desc)}</td>
        <td style="color:#666;font-size:9.5pt">${esc(t.account)}</td>
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
    <div className="stagger p-4 space-y-5 pb-24 md:max-w-4xl md:mx-auto">

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
        <button
          onClick={() => setShowArchive(true)}
          className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white rounded-2xl px-4 flex flex-col items-center justify-center gap-1 shrink-0 transition-colors"
        >
          <span className="text-xl">📚</span>
          <span className="text-[10px] text-slate-300 font-medium">Archive</span>
        </button>
      </div>

      {/* ── End-of-month close banner (only after the month has ended) ── */}
      {(() => {
        const alreadyClosed = localStorage.getItem(`closed_${closeMonth}_${closeYear}`) === 'true';
        // Show only in the first 7 days of a new month so the previous month can be closed
        if (now.getDate() > 7 || alreadyClosed) return null;
        return (
          <div className="bg-gradient-to-r from-indigo-900/50 to-violet-900/50 border border-indigo-700/50 rounded-2xl p-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-indigo-200 font-bold text-sm font-broske">📅 {closeMonth} has ended</p>
              <p className="text-indigo-400 text-xs mt-0.5">Close out {closeMonth} and start {currentMonth} fresh</p>
            </div>
            <button
              onClick={() => setShowMonthClose(true)}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3 py-2 rounded-xl transition-colors shrink-0"
            >
              Close Month
            </button>
          </div>
        );
      })()}

      {/* ── Budget Alert Banner ─────────────────────────────── */}
      {(budgetAlerts.overCount > 0 || budgetAlerts.needsCount > 0 || budgetAlerts.dueAlerts?.length > 0) && (
        <button
          onClick={() => navigate('/budget')}
          className="w-full bg-amber-900/40 border border-amber-700/60 rounded-2xl p-3 flex items-center justify-between gap-3 active:opacity-80 text-left"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-amber-400 text-lg shrink-0">⚠</span>
            <div>
              {budgetAlerts.overCount > 0 && (
                <p className="text-amber-200 font-semibold text-sm">
                  {budgetAlerts.overCount} {budgetAlerts.overCount === 1 ? 'category' : 'categories'} over budget
                </p>
              )}
              {budgetAlerts.needsCount > 0 && (
                <p className="text-amber-400/80 text-xs mt-0.5">
                  {budgetAlerts.needsCount} essential{budgetAlerts.needsCount !== 1 ? 's' : ''} not yet funded
                </p>
              )}
              {budgetAlerts.dueAlerts?.map(a => (
                <p key={a.type} className="text-amber-300/80 text-xs mt-0.5">
                  ⏰ {a.type} due {a.daysUntil === 0 ? 'today' : `in ${a.daysUntil} day${a.daysUntil === 1 ? '' : 's'}`} — not yet funded
                </p>
              ))}
            </div>
          </div>
          <span className="text-amber-500 text-xs shrink-0 font-medium">View Budget →</span>
        </button>
      )}

      {/* ── Financial Health Score ─────────────────────────── */}
      {healthScore.loaded && (
        <HealthScoreCard
          score={healthScore.total}
          signals={healthScore.signals}
          history={healthScore.history}
          expanded={healthExpanded}
          onToggle={() => setHealthExpanded(v => !v)}
        />
      )}

      {/* ── 6-Month Income vs Expense Trend ─────────────────── */}
      {chartData.length >= 2 && (
        <TrendChartCard
          data={chartData}
          expanded={trendExpanded}
          onToggle={() => setTrendExpanded(v => !v)}
        />
      )}

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-bold text-white">{currentMonth} {currentYear}</h1>
            <button
              onClick={() => { setNoteInput(monthNote); setShowNoteDrawer(true); }}
              className="text-slate-500 hover:text-slate-300 text-sm transition-colors pb-0.5"
              title="Add month note"
            >✎</button>
          </div>
          {monthNote ? (
            <p className="text-slate-400 text-xs italic mt-0.5 cursor-pointer hover:text-slate-300 truncate max-w-[200px]"
              onClick={() => { setNoteInput(monthNote); setShowNoteDrawer(true); }}>
              "{monthNote}"
            </p>
          ) : (
            <p className="text-slate-400 text-sm">Monthly Overview</p>
          )}
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
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-slate-500 text-xs">NYC · {formatGasDate(gasPrice.period)}</p>
                  {gasBalance !== null && (
                    <span className={`text-xs font-mono font-medium ${gasBalance >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      · {gasBalance >= 0 ? '+' : ''}{gasBalance < 0 ? `-$${Math.abs(gasBalance).toFixed(2)}` : `$${gasBalance.toFixed(2)}`} saved
                    </span>
                  )}
                </div>
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
          <div className="modal-sheet bg-slate-900 w-full rounded-t-3xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-bold">⛽ Log Gas Spend</h3>
                <p className="text-slate-500 text-xs mt-0.5">Deducts from your claimable gas balance</p>
              </div>
              <button onClick={() => setShowGasLog(false)} className="w-8 h-8 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center">✕</button>
            </div>
            {gasBalance !== null && (
              <div className={`rounded-xl px-4 py-2.5 flex items-center justify-between ${gasBalance >= 0 ? 'bg-emerald-900/30 border border-emerald-800/40' : 'bg-rose-900/30 border border-rose-800/40'}`}>
                <span className={`text-xs ${gasBalance >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>Gas balance (all time)</span>
                <span className={`font-mono font-bold text-sm ${gasBalance >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {gasBalance >= 0 ? '+' : ''}{gasBalance < 0 ? `-$${Math.abs(gasBalance).toFixed(2)}` : `$${gasBalance.toFixed(2)}`}
                </span>
              </div>
            )}
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
                  {gasLogging ? 'Logging…' : parseFloat(gasAmount) > 0 ? `⛽ Log $${parseFloat(gasAmount).toFixed(2)} Gas Spend` : '⛽ Enter an amount'}
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
        <button
          onClick={() => setShowCommCalc(true)}
          className="bg-indigo-900/40 hover:bg-indigo-900/60 border border-indigo-700/40 rounded-2xl p-4 flex flex-col gap-1 text-left transition-colors"
        >
          <span className="text-xl">🎨</span>
          <p className="text-indigo-200 font-semibold text-sm">Commission Calc</p>
          <p className="text-indigo-400 text-xs">Price your art fairly</p>
        </button>
        <button
          onClick={() => setShowBudget(true)}
          className="bg-sky-900/40 hover:bg-sky-900/60 border border-sky-700/40 rounded-2xl p-4 flex flex-col gap-1 text-left transition-colors"
        >
          <span className="text-xl">📊</span>
          <p className="text-sky-200 font-semibold text-sm">Budget Analyzer</p>
          <p className="text-sky-400 text-xs">50/30/20 breakdown</p>
        </button>
      </div>

      {/* ── Subscriptions button ────────────────────────────── */}
      <button
        onClick={() => setShowSubs(true)}
        className="w-full bg-teal-900/30 hover:bg-teal-900/50 border border-teal-700/40 rounded-2xl px-4 py-3 flex items-center justify-between transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">🔁</span>
          <div className="text-left">
            <p className="text-teal-200 font-semibold text-sm">Subscriptions</p>
            <p className="text-teal-500 text-xs">
              {subscriptions.length > 0
                ? `${subscriptions.length} active · next due: ${(() => {
                    const upcoming = subscriptions
                      .map(s => ({ ...s, next: nextRenewal(s['Start Date'], (s['Cycle'] || 'monthly').toLowerCase()) }))
                      .filter(s => s.next)
                      .sort((a, b) => a.next - b.next)[0];
                    if (!upcoming) return '—';
                    const d = daysUntil(upcoming.next);
                    return d === 0 ? `${upcoming.Name} today` : d === 1 ? `${upcoming.Name} tomorrow` : `${upcoming.Name} in ${d}d`;
                  })()}`
                : 'Track recurring bills'}
            </p>
          </div>
        </div>
        <span className="text-teal-500 text-xs">→</span>
      </button>

      {/* ── Bill Calendar ────────────────────────────────────── */}
      {(() => {
        const { y, m } = calMonth;
        const firstDay = new Date(y, m, 1).getDay();
        const daysInMo = new Date(y, m + 1, 0).getDate();
        const todayD   = now.getFullYear() === y && now.getMonth() === m ? now.getDate() : -1;
        const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        // Map day-of-month → list of due subscriptions
        const dueDays = {};
        subscriptions.forEach(s => {
          const next = nextRenewal(s['Start Date'], (s['Cycle'] || 'monthly').toLowerCase());
          if (!next || next.getFullYear() !== y || next.getMonth() !== m) return;
          const d = next.getDate();
          if (!dueDays[d]) dueDays[d] = [];
          dueDays[d].push(s['Name'] || '?');
        });

        // Upcoming in next 14 days
        const upcoming = subscriptions
          .map(s => ({ ...s, next: nextRenewal(s['Start Date'], (s['Cycle'] || 'monthly').toLowerCase()) }))
          .filter(s => s.next)
          .map(s => ({ ...s, days: daysUntil(s.next) }))
          .filter(s => s.days !== null && s.days >= 0 && s.days <= 14)
          .sort((a, b) => a.days - b.days);

        const cells = [];
        for (let i = 0; i < firstDay; i++) cells.push(null);
        for (let d = 1; d <= daysInMo; d++) cells.push(d);

        return (
          <div className="bg-slate-800 rounded-2xl p-2.5 space-y-2">
            {/* Calendar header */}
            <div className="flex items-center justify-between">
              <button onClick={() => setCalMonth(prev => {
                let nm = prev.m - 1, ny = prev.y;
                if (nm < 0) { nm = 11; ny--; }
                return { y: ny, m: nm };
              })} className="w-7 h-7 rounded-lg bg-slate-700 text-slate-300 flex items-center justify-center text-xs hover:bg-slate-600 transition-colors">‹</button>
              <p className="text-white text-sm font-semibold">{MONTH_NAMES[m]} {y}</p>
              <button onClick={() => setCalMonth(prev => {
                let nm = prev.m + 1, ny = prev.y;
                if (nm > 11) { nm = 0; ny++; }
                return { y: ny, m: nm };
              })} className="w-7 h-7 rounded-lg bg-slate-700 text-slate-300 flex items-center justify-center text-xs hover:bg-slate-600 transition-colors">›</button>
            </div>

            {/* Day labels */}
            <div className="grid grid-cols-7 gap-0">
              {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
                <div key={d} className="text-center text-[9px] text-slate-500 uppercase tracking-wider py-0">{d}</div>
              ))}
              {cells.map((d, i) => {
                if (!d) return <div key={`e-${i}`} />;
                const isToday    = d === todayD;
                const events     = dueDays[d] || [];
                const isSelected = selectedCalDay === d;
                return (
                  <div
                    key={d}
                    onClick={() => events.length ? setSelectedCalDay(isSelected ? null : d) : null}
                    className={`rounded-lg p-0.5 flex flex-col items-center gap-0.5 ${events.length ? 'cursor-pointer' : ''} ${isSelected ? 'bg-teal-700/60 ring-1 ring-teal-400' : isToday ? 'bg-slate-600' : events.length ? 'bg-teal-900/30' : ''}`}
                  >
                    <span className={`text-[11px] font-medium leading-none pt-0.5 ${isToday && !isSelected ? 'text-white font-bold' : isSelected ? 'text-teal-200 font-bold' : 'text-slate-400'}`}>{d}</span>
                    {events.length > 0 && (
                      <div className="flex gap-0.5 flex-wrap justify-center">
                        {events.slice(0, 3).map((_, ei) => (
                          <span key={ei} className="w-1 h-1 rounded-full bg-teal-400 inline-block" />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Selected day subscriptions */}
            {selectedCalDay && (dueDays[selectedCalDay] || []).length > 0 && (
              <div className="border-t border-teal-800/60 pt-2 space-y-1">
                <p className="text-teal-400 text-[10px] uppercase tracking-wider">
                  Due on {MONTH_NAMES[m]} {selectedCalDay}
                </p>
                {(dueDays[selectedCalDay] || []).map((name, i) => {
                  const sub = subscriptions.find(s => s['Name'] === name);
                  return (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />
                        <span className="text-slate-200 truncate">{name}</span>
                      </div>
                      {sub?.['Amount'] && (
                        <span className="text-slate-400 font-mono shrink-0">
                          ${parseFloat(sub['Amount'] || 0).toFixed(2)}{cycleAmountLabel(sub['Cycle'])}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Upcoming list */}
            {!selectedCalDay && upcoming.length > 0 ? (
              <div className="space-y-1 border-t border-slate-700 pt-2">
                <p className="text-slate-500 text-[10px] uppercase tracking-wider">Due next 14 days</p>
                {upcoming.map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />
                      <span className="text-slate-200 truncate">{s['Name']}</span>
                      {s['Amount'] && (
                        <span className="text-slate-500 font-mono shrink-0">
                          ${parseFloat(s['Amount'] || 0).toFixed(2)}{cycleAmountLabel(s['Cycle'])}
                        </span>
                      )}
                    </div>
                    <span className={`shrink-0 font-medium ${s.days === 0 ? 'text-rose-400' : s.days <= 3 ? 'text-amber-400' : 'text-teal-400'}`}>
                      {s.days === 0 ? 'Today' : s.days === 1 ? 'Tomorrow' : `in ${s.days}d`}
                    </span>
                  </div>
                ))}
              </div>
            ) : !selectedCalDay && subscriptions.length === 0 ? (
              <p className="text-slate-600 text-xs text-center border-t border-slate-700 pt-2">Add subscriptions to see due dates</p>
            ) : null}
          </div>
        );
      })()}

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
              const mIncome = pm(m['Total Processed Income']);
              const mSpent  = pm(m['Total Spent']);
              const mGoal   = pm(m['Allowance Goal']);
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
          {allMonths.filter(m => pm(m['Total Processed Income']) > 0 || pm(m['Allowance Goal']) > 0).map((m, i, arr) => {
            const mIncome = pm(m['Total Processed Income']);
            const mSpent  = pm(m['Total Spent']);
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
          <div className="modal-sheet bg-slate-900 w-full rounded-t-3xl p-5 space-y-4">
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
                  {expLogging
                    ? 'Logging…'
                    : !(parseFloat(expAmount) > 0)
                      ? 'Enter an amount'
                      : !expCategory
                        ? 'Select a category'
                        : `Log $${parseFloat(expAmount).toFixed(2)} — ${expCategory}`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Bill Tracker modal (full-screen) ─────────────────── */}
      {showBills && (() => {
        const billExpenses = expenses.filter(e => pm(e['Monthly Allowance ($)']) > 0);
        const totalBudget  = billExpenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);

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
          return { name: e['Type'] || e['Expense'] || '—', value: pm(e['Monthly Allowance ($)']), color: palette[idx % palette.length], priority: p };
        });

        const priorityTotals = {};
        billExpenses.forEach(e => {
          const p = String(e['Priority'] ?? '3');
          priorityTotals[p] = (priorityTotals[p] || 0) + pm(e['Monthly Allowance ($)']);
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
                        const amt = pm(e['Monthly Allowance ($)']);
                        const pct = totalBudget > 0 ? (amt / totalBudget) * 100 : 0;
                        return (
                          <div key={i} className="bg-slate-900 rounded-xl px-4 py-3 space-y-1.5">
                            <div className="flex justify-between items-center gap-2">
                              <div className="min-w-0">
                                <span className="text-white text-sm">{e['Type'] || e['Expense'] || '—'}</span>
                                {e['Account'] === 'Subscription' && (() => {
                                  const sub = subscriptions.find(s => s['Name']?.toLowerCase() === (e['Type'] || e['Expense'] || '').toLowerCase());
                                  const next = sub ? nextRenewal(sub['Start Date'], (sub['Cycle'] || 'monthly').toLowerCase()) : null;
                                  const days = daysUntil(next);
                                  return (
                                    <>
                                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-violet-900/60 text-violet-300">sub</span>
                                      {days !== null && (
                                        <span className={`ml-1 text-xs px-1.5 py-0.5 rounded font-medium ${days === 0 ? 'bg-rose-900/60 text-rose-300' : days <= 3 ? 'bg-amber-900/60 text-amber-300' : 'bg-teal-900/40 text-teal-300'}`}>
                                          {days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `${days}d`}
                                        </span>
                                      )}
                                    </>
                                  );
                                })()}
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

      {/* ── Subscriptions modal ─────────────────────────────── */}
      {showSubs && (() => {
        function SubsModal() {
          const [subs, setSubs]       = useState(subscriptions);
          const [view, setView]       = useState('list');   // 'list' | 'import' | 'add' | 'edit'
          const [saving, setSaving]   = useState(false);
          const [err, setErr]         = useState(null);
          const [form, setForm]       = useState({ Name: '', 'Start Date': '', Cycle: 'monthly', Amount: '', Notes: '' });
          const [editingSub, setEditingSub]         = useState(null);
          const [editForm, setEditForm]             = useState({ Name: '', 'Start Date': '', Cycle: 'monthly', Amount: '', Notes: '' });
          const [showNotifPicker, setShowNotifPicker] = useState(false);
          const [leadVal, setLeadVal]               = useState(subNotifLead);

          async function reloadSubs() {
            const subRows = await readRange(token, 'Subscriptions!A:E').catch(() => []);
            if (subRows.length > 1) {
              const [hdr, ...data] = subRows;
              const updated = data
                .map((r, idx) => ({ row: r, rowNum: idx + 2 }))
                .filter(({ row }) => row[0])
                .map(({ row, rowNum }) => ({
                  ...hdr.reduce((o, h, i) => { o[h] = row[i] ?? ''; return o; }, {}),
                  _rowNum: rowNum,
                }));
              setSubs(updated);
              setSubscriptions(updated);
            } else {
              setSubs([]);
              setSubscriptions([]);
            }
          }

          function openEdit(sub) {
            setEditingSub(sub);
            setEditForm({
              Name: sub.Name || '',
              'Start Date': sub['Start Date'] || '',
              Cycle: (sub.Cycle || 'monthly').toLowerCase(),
              Amount: String(sub.Amount || ''),
              Notes: sub.Notes || '',
            });
            setErr(null);
            setView('edit');
          }

          async function saveEdit() {
            if (!editingSub || !editForm.Name.trim()) return;
            setSaving(true); setErr(null);
            try {
              const rn = editingSub._rowNum;
              await batchUpdateCells(token, [
                { range: `Subscriptions!A${rn}`, value: editForm.Name.trim() },
                { range: `Subscriptions!B${rn}`, value: editForm['Start Date'] },
                { range: `Subscriptions!C${rn}`, value: editForm.Cycle },
                { range: `Subscriptions!D${rn}`, value: editForm.Amount },
                { range: `Subscriptions!E${rn}`, value: editForm.Notes },
              ]);
              await reloadSubs();
              setEditingSub(null);
              setView('list');
            } catch (e) { setErr(e.message); }
            finally { setSaving(false); }
          }

          async function deleteSub(sub) {
            if (!sub?._rowNum) return;
            if (!window.confirm(`Delete subscription "${sub.Name}"?`)) return;
            setSaving(true); setErr(null);
            try {
              await clearRow(token, `Subscriptions!A${sub._rowNum}:E${sub._rowNum}`);
              await reloadSubs();
              if (editingSub?._rowNum === sub._rowNum) {
                setEditingSub(null);
                setView('list');
              }
            } catch (e) { setErr(e.message); }
            finally { setSaving(false); }
          }

          // Candidates from Monthly Expenses tagged as Subscription, not yet imported
          const existingNames = new Set(subs.map(s => (s['Name'] || '').toLowerCase()));
          const candidates = expenses
            .filter(e => e['Account'] === 'Subscription' && (e['Type'] || e['Expense']))
            .map(e => {
              const name = e['Type'] || e['Expense'] || '';
              return { name, amount: String(pm(e['Monthly Allowance ($)']) || ''), already: existingNames.has(name.toLowerCase()) };
            });

          // Per-candidate state: start date + cycle, keyed by name
          const today = new Date().toISOString().slice(0, 10);
          const [importFields, setImportFields] = useState(() =>
            Object.fromEntries(candidates.map(c => [c.name, { startDate: today, cycle: 'monthly', selected: !c.already }]))
          );

          async function ensureHeader() {
            await ensureSheetTab(token, 'Subscriptions');
            const hdr = await readRange(token, 'Subscriptions!A1:E1');
            if (!hdr.length || !hdr[0]?.length) {
              await appendRow(token, 'Subscriptions!A:E', ['Name','Start Date','Cycle','Amount','Notes']);
            }
          }

          async function importSelected() {
            const toImport = candidates.filter(c => !c.already && importFields[c.name]?.selected);
            if (!toImport.length) return;
            setSaving(true); setErr(null);
            try {
              await ensureHeader();
              for (const c of toImport) {
                const f = importFields[c.name];
                await appendRow(token, 'Subscriptions!A:E', [c.name, f.startDate, f.cycle, c.amount, '']);
              }
              const newEntries = toImport.map(c => ({
                Name: c.name, 'Start Date': importFields[c.name].startDate,
                Cycle: importFields[c.name].cycle, Amount: c.amount, Notes: '',
              }));
              const updated = [...subs, ...newEntries];
              setSubs(updated);
              setSubscriptions(updated);
              setView('list');
            } catch (e) { setErr(e.message); }
            finally { setSaving(false); }
          }

          async function saveNew() {
            if (!form.Name.trim()) return;
            setSaving(true); setErr(null);
            try {
              await ensureHeader();
              await appendRow(token, 'Subscriptions!A:E', [form.Name.trim(), form['Start Date'], form.Cycle, form.Amount, form.Notes]);
              const updated = [...subs, { ...form, Name: form.Name.trim() }];
              setSubs(updated);
              setSubscriptions(updated);
              setForm({ Name: '', 'Start Date': '', Cycle: 'monthly', Amount: '', Notes: '' });
              setView('list');
            } catch (e) { setErr(e.message); }
            finally { setSaving(false); }
          }

          const unimportedCount = candidates.filter(c => !c.already).length;

          return (
            <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h2 className="text-white font-bold text-lg">🔁 Subscriptions</h2>
                  <p className="text-slate-400 text-xs mt-0.5">
                    {view === 'import' ? 'Import from Monthly Expenses' : view === 'add' ? 'New subscription' : 'Recurring bills & renewal tracking'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {view === 'list' && (
                    <div className="relative">
                      <button onClick={() => setShowNotifPicker(p => !p)}
                        title="Renewal notification settings"
                        className="w-9 h-9 rounded-full bg-slate-800 text-slate-400 hover:text-teal-300 flex items-center justify-center text-base transition-colors">
                        ⚙
                      </button>
                      {showNotifPicker && (
                        <div className="absolute right-0 top-11 bg-slate-800 border border-slate-700 rounded-2xl p-3 z-10 w-52 shadow-xl">
                          <p className="text-white text-xs font-semibold mb-2">🔔 Notify me before renewal:</p>
                          <div className="flex gap-2">
                            {[1, 3, 7].map(d => (
                              <button key={d} onClick={() => {
                                setLeadVal(d);
                                setSubNotifLead(d);
                                localStorage.setItem('_fin_sub_notif_lead', String(d));
                                setShowNotifPicker(false);
                              }} className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                                leadVal === d ? 'bg-teal-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                              }`}>
                                {d}d
                              </button>
                            ))}
                          </div>
                          <p className="text-slate-500 text-xs mt-2">Currently: {leadVal} day{leadVal !== 1 ? 's' : ''} ahead</p>
                        </div>
                      )}
                    </div>
                  )}
                  <button onClick={() => { setShowNotifPicker(false); view === 'list' ? setShowSubs(false) : setView('list'); }}
                    className="w-9 h-9 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-lg">
                    {view === 'list' ? '✕' : '‹'}
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 pb-28">

                {/* ── LIST VIEW ── */}
                {view === 'list' && (
                  <>
                    {/* Import banner */}
                    {unimportedCount > 0 && (
                      <button onClick={() => setView('import')}
                        className="w-full bg-teal-900/30 border border-teal-700/50 rounded-2xl px-4 py-3 flex items-center justify-between transition-colors hover:bg-teal-900/50">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl">📥</span>
                          <div className="text-left">
                            <p className="text-teal-200 font-semibold text-sm">Import from Budget</p>
                            <p className="text-teal-500 text-xs">{unimportedCount} subscription{unimportedCount !== 1 ? 's' : ''} found in Monthly Expenses</p>
                          </div>
                        </div>
                        <span className="text-teal-400 text-sm">→</span>
                      </button>
                    )}

                    {subs.length === 0 && (
                      <div className="text-center py-8 space-y-2">
                        <p className="text-4xl">🔁</p>
                        <p className="text-white font-semibold">No subscriptions yet</p>
                        <p className="text-slate-500 text-sm">
                          {unimportedCount > 0 ? 'Import from your budget above, or add manually.' : 'Add a subscription to track renewals.'}
                        </p>
                      </div>
                    )}

                    {/* Total monthly cost across all subs */}
                    {subs.length > 0 && (() => {
                      const totalMo = subs.reduce((s, sub) => s + toMonthly(sub['Amount'], sub['Cycle']), 0);
                      return (
                        <div className="flex justify-between items-center px-1 text-xs">
                          <span className="text-slate-500">Total / month</span>
                          <span className="text-teal-300 font-bold font-mono tabular-nums">${totalMo.toFixed(2)}</span>
                        </div>
                      );
                    })()}

                    {subs.map((s, i) => {
                      const cycle    = (s['Cycle'] || 'monthly').toLowerCase();
                      const next     = nextRenewal(s['Start Date'], cycle);
                      const days     = daysUntil(next);
                      const amt      = parseFloat(s['Amount'] || 0);
                      const moAmt    = toMonthly(amt, cycle);
                      const isNonMo  = cycle !== 'monthly';
                      const startFmt = s['Start Date']
                        ? new Date(s['Start Date'] + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : '—';
                      const nextFmt  = next
                        ? next.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : '—';
                      return (
                        <button key={i} onClick={() => openEdit(s)}
                          className="w-full text-left bg-slate-800 hover:bg-slate-700/80 rounded-2xl p-4 space-y-2 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-white font-semibold truncate">{s['Name']}</p>
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                <span className="text-xs px-2 py-0.5 rounded-full bg-teal-900/50 text-teal-300 capitalize">{cycle}</span>
                                {amt > 0 && (
                                  <>
                                    <span className="text-white font-mono text-xs tabular-nums">${moAmt.toFixed(2)}/mo</span>
                                    {isNonMo && <span className="text-slate-500 font-mono text-[10px] tabular-nums">(${amt.toFixed(2)}{cycleAmountLabel(cycle)})</span>}
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {days !== null && (
                                <span className={`text-xs font-bold px-2 py-1 rounded-xl ${days === 0 ? 'bg-rose-900/60 text-rose-300' : days <= 3 ? 'bg-amber-900/60 text-amber-300' : 'bg-teal-900/40 text-teal-300'}`}>
                                  {days === 0 ? 'Due today' : days === 1 ? 'Tomorrow' : `${days}d left`}
                                </span>
                              )}
                              <span className="text-slate-500 text-sm">›</span>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <p className="text-slate-600 text-[10px] uppercase tracking-wider">Started</p>
                              <p className="text-slate-300">{startFmt}</p>
                            </div>
                            <div>
                              <p className="text-slate-600 text-[10px] uppercase tracking-wider">Next renewal</p>
                              <p className="text-slate-300">{nextFmt}</p>
                            </div>
                          </div>
                          {s['Notes'] && <p className="text-slate-500 text-xs">{s['Notes']}</p>}
                        </button>
                      );
                    })}
                  </>
                )}

                {/* ── IMPORT VIEW ── */}
                {view === 'import' && (
                  <>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      These are expenses tagged as <span className="text-teal-300 font-medium">Subscription</span> in your Monthly Expenses sheet.
                      Set the start date for each and tap Import.
                    </p>
                    {candidates.map(c => {
                      const f = importFields[c.name] || { startDate: today, cycle: 'monthly', selected: false };
                      return (
                        <div key={c.name} className={`rounded-2xl p-4 space-y-3 border transition-colors ${c.already ? 'bg-slate-900 border-slate-800 opacity-60' : f.selected ? 'bg-slate-800 border-teal-700/50' : 'bg-slate-800 border-slate-700'}`}>
                          <div className="flex items-center gap-3">
                            {!c.already && (
                              <button onClick={() => setImportFields(prev => ({ ...prev, [c.name]: { ...f, selected: !f.selected } }))}
                                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${f.selected ? 'bg-teal-600 border-teal-600' : 'border-slate-600'}`}>
                                {f.selected && <span className="text-white text-[10px] font-bold leading-none">✓</span>}
                              </button>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-white font-semibold text-sm truncate">{c.name}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                {c.amount && <span className="text-slate-400 font-mono text-xs">${parseFloat(c.amount).toFixed(2)}/mo</span>}
                                {c.already && <span className="text-emerald-400 text-xs">✓ already imported</span>}
                              </div>
                            </div>
                          </div>

                          {!c.already && f.selected && (
                            <div className="space-y-2.5 pl-8">
                              <div>
                                <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1">Start Date</label>
                                <input type="date" value={f.startDate}
                                  onChange={e => setImportFields(prev => ({ ...prev, [c.name]: { ...f, startDate: e.target.value } }))}
                                  className="w-full bg-slate-700 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-teal-500"/>
                              </div>
                              <div>
                                <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1">Cycle</label>
                                <div className="grid grid-cols-4 gap-1 bg-slate-700 rounded-xl p-0.5">
                                  {SUB_CYCLES.map(cy => (
                                    <button key={cy} onClick={() => setImportFields(prev => ({ ...prev, [c.name]: { ...f, cycle: cy } }))}
                                      className={`py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${f.cycle === cy ? 'bg-teal-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                                      {cy}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {err && <p className="text-red-400 text-xs">{err}</p>}
                  </>
                )}

                {/* ── EDIT VIEW ── */}
                {view === 'edit' && editingSub && (
                  <div className="space-y-3">
                    {/* Monthly preview */}
                    {parseFloat(editForm.Amount) > 0 && editForm.Cycle !== 'monthly' && (
                      <div className="bg-teal-900/20 border border-teal-800/40 rounded-xl px-3 py-2 text-xs flex justify-between">
                        <span className="text-teal-400">Monthly equivalent</span>
                        <span className="text-white font-mono font-bold tabular-nums">
                          ${toMonthly(editForm.Amount, editForm.Cycle).toFixed(2)}/mo
                        </span>
                      </div>
                    )}
                    {[['Name','text','Name'],['Start Date','date',''],['Notes','text','Notes (optional)']].map(([field, type, ph]) => (
                      <div key={field}>
                        <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1">{field}</label>
                        <input type={type} placeholder={ph}
                          value={editForm[field]} onChange={e => setEditForm(f => ({ ...f, [field]: e.target.value }))}
                          className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-teal-500 placeholder-slate-600"/>
                      </div>
                    ))}
                    <div>
                      <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1">Cycle</label>
                      <div className="grid grid-cols-4 gap-1 bg-slate-800 rounded-xl p-1">
                        {SUB_CYCLES.map(c => (
                          <button key={c} onClick={() => setEditForm(f => ({ ...f, Cycle: c }))}
                            className={`py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${editForm.Cycle === c ? 'bg-teal-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                            {c}
                          </button>
                        ))}
                      </div>
                    </div>
                    {err && <p className="text-red-400 text-xs">{err}</p>}
                    <button onClick={() => deleteSub(editingSub)} disabled={saving}
                      className="w-full py-2.5 rounded-xl bg-rose-900/40 hover:bg-rose-900/60 border border-rose-800/50 text-rose-300 text-sm font-medium transition-colors disabled:opacity-40">
                      🗑 Delete subscription
                    </button>
                  </div>
                )}

                {/* ── ADD VIEW ── */}
                {view === 'add' && (
                  <div className="space-y-3">
                    {[['Name','text','Name (e.g. Netflix)'],['Start Date','date',''],['Notes','text','Notes (optional)']].map(([field, type, ph]) => (
                      <div key={field}>
                        <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1">{field}</label>
                        <input type={type} placeholder={ph}
                          value={form[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                          className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-teal-500 placeholder-slate-600"/>
                      </div>
                    ))}
                    <div>
                      <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1">Cycle</label>
                      <div className="grid grid-cols-4 gap-1 bg-slate-800 rounded-xl p-1">
                        {SUB_CYCLES.map(c => (
                          <button key={c} onClick={() => setForm(f => ({ ...f, Cycle: c }))}
                            className={`py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${form.Cycle === c ? 'bg-teal-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                            {c}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1">
                        Amount <span className="text-slate-600 normal-case tracking-normal">({cycleAmountLabel(form.Cycle)} — enter actual billing amount)</span>
                      </label>
                      {parseFloat(form.Amount) > 0 && form.Cycle !== 'monthly' && (
                        <div className="mb-1.5 flex justify-between text-xs text-teal-400">
                          <span>Monthly equivalent</span>
                          <span className="font-mono font-bold">${toMonthly(form.Amount, form.Cycle).toFixed(2)}/mo</span>
                        </div>
                      )}
                      <input type="number" placeholder="0.00" step="0.01" min="0"
                        value={form.Amount} onChange={e => setForm(f => ({ ...f, Amount: e.target.value }))}
                        className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-teal-500 placeholder-slate-600"/>
                    </div>
                    {err && <p className="text-red-400 text-xs">{err}</p>}
                  </div>
                )}
              </div>

              {/* Footer buttons */}
              <div className="shrink-0 px-5 py-4 border-t border-slate-800 space-y-2">
                {view === 'list' && (
                  <button onClick={() => setView('add')} className="w-full py-3 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-bold text-sm transition-colors">
                    + Add Subscription
                  </button>
                )}
                {view === 'import' && (
                  <button onClick={importSelected}
                    disabled={saving || !candidates.some(c => !c.already && importFields[c.name]?.selected)}
                    className="w-full py-3 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white font-bold text-sm transition-colors">
                    {saving ? 'Importing…' : `Import ${candidates.filter(c => !c.already && importFields[c.name]?.selected).length} Selected`}
                  </button>
                )}
                {view === 'add' && (
                  <button onClick={saveNew} disabled={!form.Name.trim() || saving}
                    className="w-full py-3 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white font-bold text-sm transition-colors">
                    {saving ? 'Saving…' : 'Add Subscription'}
                  </button>
                )}
                {view === 'edit' && (
                  <button onClick={saveEdit} disabled={!editForm.Name.trim() || saving}
                    className="w-full py-3 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white font-bold text-sm transition-colors">
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                )}
              </div>
            </div>
          );
        }
        return <SubsModal key="subs-modal" />;
      })()}

      {/* ── Commission Price Calculator ──────────────────────── */}
      {showCommCalc && (() => {
        function CommCalc() {
          const [hours,       setHours]       = useState('');
          const [rate,        setRate]        = useState(() => localStorage.getItem('commCalcRate') || '');
          const [materials,   setMaterials]   = useState('');
          const [platformFee, setPlatformFee] = useState('0');
          const [margin,      setMargin]      = useState('20');
          const [copied,      setCopied]      = useState(false);

          const h   = parseFloat(hours)       || 0;
          const r   = parseFloat(rate)        || 0;
          const mat = parseFloat(materials)   || 0;
          const fee = parseFloat(platformFee) || 0;
          const mrg = parseFloat(margin)      || 0;

          const base      = h * r + mat;
          const withFee   = fee < 100 ? base / (1 - fee / 100) : base;
          const suggested = mrg < 100 ? withFee / (1 - mrg / 100) : withFee;
          const profit    = suggested - withFee;
          const feeAmt    = withFee - base;
          const labor     = h * r;

          function copy() {
            navigator.clipboard.writeText(suggested.toFixed(2));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }

          return (
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end z-50">
              <div className="modal-sheet bg-slate-900 w-full rounded-t-3xl max-h-[88dvh] overflow-y-auto">
                <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                  <div>
                    <h3 className="text-white font-bold font-broske">Commission Price Calculator</h3>
                    <p className="text-slate-400 text-xs mt-0.5">Time · materials · fees · margin</p>
                  </div>
                  <button onClick={() => setShowCommCalc(false)} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center">✕</button>
                </div>
                <div className="px-5 py-5 space-y-4 pb-8">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Hours</label>
                      <input type="number" min="0" step="0.5" value={hours} onChange={e => setHours(e.target.value)} placeholder="0"
                        className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                    </div>
                    <div>
                      <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Hourly Rate ($)</label>
                      <input type="number" min="0" step="0.5" value={rate}
                        onChange={e => setRate(e.target.value)}
                        onBlur={e => localStorage.setItem('commCalcRate', e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                    </div>
                    <div>
                      <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Materials ($)</label>
                      <input type="number" min="0" step="0.01" value={materials} onChange={e => setMaterials(e.target.value)} placeholder="0.00"
                        className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                    </div>
                    <div>
                      <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Platform Fee (%)</label>
                      <input type="number" min="0" max="99" step="0.5" value={platformFee} onChange={e => setPlatformFee(e.target.value)} placeholder="0"
                        className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                    </div>
                  </div>
                  <div>
                    <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Desired Profit Margin (%)</label>
                    <input type="number" min="0" max="99" step="1" value={margin} onChange={e => setMargin(e.target.value)} placeholder="20"
                      className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                  </div>

                  {base > 0 && (
                    <div className="bg-indigo-900/30 border border-indigo-700/40 rounded-2xl p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-indigo-300 text-xs uppercase tracking-wider font-broske">Suggested Price</p>
                          <p className="text-white text-4xl font-bold font-mono tabular-nums mt-1">${suggested.toFixed(2)}</p>
                        </div>
                        <button onClick={copy}
                          className={`px-4 py-2 rounded-xl text-sm font-bold transition-colors ${copied ? 'bg-emerald-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}>
                          {copied ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs">
                        {labor > 0   && <span className="bg-slate-700/60 text-slate-300 px-2.5 py-1 rounded-full font-mono">Labor ${labor.toFixed(2)}</span>}
                        {mat > 0     && <span className="bg-slate-700/60 text-slate-300 px-2.5 py-1 rounded-full font-mono">Materials ${mat.toFixed(2)}</span>}
                        {feeAmt > 0  && <span className="bg-rose-900/40 text-rose-300 px-2.5 py-1 rounded-full font-mono">Fees ${feeAmt.toFixed(2)}</span>}
                        {profit > 0  && <span className="bg-emerald-900/40 text-emerald-300 px-2.5 py-1 rounded-full font-mono">Profit ${profit.toFixed(2)}</span>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        }
        return <CommCalc key="comm-calc" />;
      })()}

      {/* ── 50/30/20 Budget Analyzer ──────────────────────────── */}
      {showBudget && (() => {
        const needsAmt  = expenses.filter(e => String(e['Priority'] ?? '3') === '1').reduce((s, e) => s + pm(e['Actual Spend']), 0);
        const wantsAmt  = expenses.filter(e => ['2','3'].includes(String(e['Priority'] ?? '3'))).reduce((s, e) => s + pm(e['Actual Spend']), 0);
        const savingsAmt = Math.max(0, income - needsAmt - wantsAmt);

        const needsPct   = income > 0 ? (needsAmt  / income) * 100 : 0;
        const wantsPct   = income > 0 ? (wantsAmt  / income) * 100 : 0;
        const savingsPct = income > 0 ? (savingsAmt / income) * 100 : 0;

        const buckets = [
          { label: 'Needs', target: 50, actual: needsPct,   amt: needsAmt,   targetAmt: income * 0.5, color: '#3b82f6', items: expenses.filter(e => String(e['Priority'] ?? '3') === '1') },
          { label: 'Wants', target: 30, actual: wantsPct,   amt: wantsAmt,   targetAmt: income * 0.3, color: '#a855f7', items: expenses.filter(e => ['2','3'].includes(String(e['Priority'] ?? '3'))) },
          { label: 'Savings', target: 20, actual: savingsPct, amt: savingsAmt, targetAmt: income * 0.2, color: '#10b981', items: [] },
        ];

        const furthest = [...buckets].sort((a, b) => Math.abs(b.actual - b.target) - Math.abs(a.actual - a.target))[0];
        let recommendation = '';
        if (income === 0) {
          recommendation = 'No income recorded this month yet.';
        } else if (furthest.actual > furthest.target + 10) {
          recommendation = `${furthest.label} are ${furthest.actual.toFixed(0)}% of income — $${(furthest.amt - furthest.targetAmt).toFixed(0)} over the ${furthest.target}% target.`;
        } else if (furthest.actual < furthest.target - 10) {
          recommendation = `${furthest.label} are ${furthest.actual.toFixed(0)}% of income — $${(furthest.targetAmt - furthest.amt).toFixed(0)} below the ${furthest.target}% target.`;
        } else {
          recommendation = `All three buckets are within 10% of their targets — great balance!`;
        }

        return (
          <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">
            <div className="shrink-0 border-b border-slate-800 px-5 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg font-broske">50/30/20 Analyzer</h2>
                <p className="text-slate-400 text-xs mt-0.5">{currentMonth} {currentYear} · Income: ${income.toFixed(2)}</p>
              </div>
              <button onClick={() => setShowBudget(false)} className="w-9 h-9 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-lg">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5 pb-24">
              {income === 0 && (
                <div className="bg-slate-800 rounded-2xl p-6 text-center">
                  <p className="text-slate-400 text-sm">No income data for this month yet.</p>
                </div>
              )}

              {buckets.map(b => {
                const over = b.actual > b.target + 10;
                const under = b.actual < b.target - 10;
                const barColor = over ? '#ef4444' : under ? '#f59e0b' : b.color;
                const pct = Math.min(100, b.actual);
                return (
                  <div key={b.label} className="bg-slate-800 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-semibold font-broske">{b.label}</p>
                        <p className="text-slate-400 text-xs">Target: {b.target}% · ${b.targetAmt.toFixed(0)}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono font-bold text-white tabular-nums">${b.amt.toFixed(2)}</p>
                        <p className={`text-xs font-mono ${over ? 'text-rose-400' : under ? 'text-amber-400' : 'text-emerald-400'}`}>{b.actual.toFixed(1)}%</p>
                      </div>
                    </div>
                    <div className="relative h-3 bg-slate-700 rounded-full overflow-hidden">
                      <div className="absolute inset-y-0 left-0 rounded-full transition-all" style={{ width: `${pct}%`, background: barColor }} />
                      <div className="absolute inset-y-0 border-r-2 border-white/40" style={{ left: `${b.target}%` }} />
                    </div>
                    <p className="text-slate-500 text-[10px]">White line = {b.target}% target</p>

                    {b.items.length > 0 && (
                      <div className="space-y-1 pt-1 border-t border-slate-700">
                        {b.items.map((e, i) => {
                          const allw = pm(e['Monthly Allowance ($)']);
                          const sp   = pm(e['Actual Spend']);
                          return (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <span className="text-slate-300 flex-1 truncate">{e['Type'] || '—'}</span>
                              <span className="text-slate-400 font-mono tabular-nums ml-2">${sp.toFixed(2)}</span>
                              <span className="text-slate-600 font-mono w-14 text-right tabular-nums">/ ${allw.toFixed(2)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="bg-sky-900/30 border border-sky-700/40 rounded-2xl p-4">
                <p className="text-sky-300 text-xs font-broske uppercase tracking-wider mb-1">Recommendation</p>
                <p className="text-white text-sm leading-relaxed">{recommendation}</p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Month Close modal ───────────────────────────────── */}
      {showMonthClose && (() => {
        const totalAllowance  = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);
        const closeMonthRow   = allMonths.find(m => m['Month'] === closeMonth);
        const closeIncome     = pm(closeMonthRow?.['Total Processed Income']);
        const closeSpent      = pm(closeMonthRow?.['Total Spent']);
        const closeNet        = closeIncome - closeSpent;
        const coveragePct     = totalAllowance > 0 ? (closeIncome / totalAllowance) * 100 : 0;
        const priGroups = ['1','2','3'].map(p => {
          const items = expenses.filter(e => String(e['Priority'] ?? '3') === p && pm(e['Monthly Allowance ($)']) > 0);
          return {
            p, label: { '1':'Essential','2':'Stability','3':'Optional' }[p],
            budget: items.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0),
            spent:  items.reduce((s, e) => s + pm(e['Actual Spend']), 0),
          };
        }).filter(g => g.budget > 0);

        return (
          <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">
            <div className="shrink-0 border-b border-slate-800 px-5 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg font-broske">Close {closeMonth} {closeYear}</h2>
                <p className="text-slate-400 text-xs mt-0.5">Review your month before starting fresh</p>
              </div>
              <button onClick={() => setShowMonthClose(false)} className="w-9 h-9 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-lg">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5 pb-8">
              {/* Month summary */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Income',    value: fmt(closeIncome), color: 'text-emerald-400' },
                  { label: 'Spent',     value: fmt(closeSpent),  color: 'text-rose-400'    },
                  { label: 'Net Flow',  value: fmt(closeNet),    color: closeNet >= 0 ? 'text-emerald-400' : 'text-rose-400' },
                  { label: 'Coverage',  value: `${coveragePct.toFixed(0)}%`, color: coveragePct >= 100 ? 'text-emerald-400' : 'text-amber-400' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-slate-800 rounded-2xl p-4">
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider">{label}</p>
                    <p className={`text-xl font-bold font-mono mt-1 tabular-nums ${color}`}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Priority breakdown */}
              <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
                <p className="text-slate-400 text-xs uppercase tracking-wider font-broske">Budget vs Actual</p>
                {priGroups.map(g => {
                  const pct    = g.budget > 0 ? (g.spent / g.budget) * 100 : 0;
                  const over   = g.spent > g.budget;
                  const colors = { '1': '#f43f5e', '2': '#f59e0b', '3': '#8b5cf6' };
                  return (
                    <div key={g.p} className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-300">P{g.p} {g.label}</span>
                        <span className={over ? 'text-rose-400 font-bold' : 'text-slate-300'}>
                          {fmt(g.spent)} / {fmt(g.budget)}
                        </span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
                        <div className="h-2 rounded-full" style={{ width: `${Math.min(pct, 100)}%`, background: colors[g.p] }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* What "closing" means */}
              <div className="bg-blue-900/20 border border-blue-800/40 rounded-2xl p-4 space-y-2">
                <p className="text-blue-300 font-broske text-xs uppercase tracking-wider">What happens when you close</p>
                <ul className="text-slate-300 text-sm space-y-1.5">
                  <li className="flex gap-2"><span className="text-blue-400 shrink-0">→</span>Your {closeMonth} data is preserved as history</li>
                  <li className="flex gap-2"><span className="text-blue-400 shrink-0">→</span>Income processed resets to $0.00 for {currentMonth}</li>
                  <li className="flex gap-2"><span className="text-blue-400 shrink-0">→</span>All category gaps reset — full monthly goals to fill again</li>
                </ul>
              </div>

              <button
                onClick={() => { openStatement(); setStmtFromClose(true); }}
                className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors border border-slate-700"
              >
                📄 View Full {closeMonth} Statement First
              </button>
            </div>

            {/* Finalize button */}
            <div className="shrink-0 px-5 py-4 border-t border-slate-800 bg-slate-950">
              <button
                onClick={() => {
                  const closeMonthRow = allMonths.find(m => m['Month'] === closeMonth && String(m['Year']) === String(closeYear));
                  const ci = pm(closeMonthRow?.['Total Processed Income']);
                  const cs = pm(closeMonthRow?.['Total Spent']);
                  const cg = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);
                  saveStatementArchive(closeMonth, closeYear, ci, cs, cg, null);
                  setShowMonthClose(false);
                  localStorage.setItem(`closed_${closeMonth}_${closeYear}`, 'true');
                }}
                className="w-full py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm transition-colors"
              >
                ✓ Close {closeMonth} — Start {currentMonth} Fresh
              </button>
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
          gasBalance={gasBalance}
          onClose={() => setShowIncome(false)}
          onProcessed={() => setGasBalRefresh(k => k + 1)}
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
                {stmtFromClose && (
                  <button
                    onClick={() => {
                      const ci = stmtTxns.reduce((s, t) => t.amount > 0 ? s + t.amount : s, 0) || pm(current?.['Total Processed Income']);
                      const cs = stmtTxns.reduce((s, t) => t.amount < 0 ? s + Math.abs(t.amount) : s, 0) || pm(current?.['Total Spent']);
                      const cg = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);
                      saveStatementArchive(closeMonth, closeYear, ci, cs, cg, stmtTxns);
                      setShowStatement(false);
                      setStmtFromClose(false);
                      setShowMonthClose(false);
                      localStorage.setItem(`closed_${closeMonth}_${closeYear}`, 'true');
                    }}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors"
                  >
                    ✓ Close {closeMonth}
                  </button>
                )}
                <button
                  onClick={() => { setShowStatement(false); setStmtFromClose(false); }}
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
                const totalIncome = stmtTxns.reduce((s, t) => t.amount > 0 ? s + t.amount : s, 0) || pm(current?.['Total Processed Income']);
                const totalSpent  = stmtTxns.reduce((s, t) => t.amount < 0 ? s + Math.abs(t.amount) : s, 0) || pm(current?.['Total Spent']);
                const goalAmt     = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0) || pm(current?.['Allowance Goal']);
                const netSaved    = totalIncome - totalSpent;

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
                  items: expenses.filter(e => String(e['Priority'] ?? '3') === p && pm(e['Monthly Allowance ($)']) > 0),
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
                        budget: g.items.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0),
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
                          const gAllw = g.items.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);
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
                                  const allw = pm(e['Monthly Allowance ($)']);
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

      {/* ── Statement Archive modal ──────────────────────────── */}
      {showArchive && (() => {
        let archive = {};
        try { archive = JSON.parse(localStorage.getItem('_fin_statements') || '{}'); } catch {}
        const entries = Object.entries(archive).sort((a, b) => {
          const [am, ay] = [MONTHS.indexOf(a[0].split(' ')[0]), parseInt(a[0].split(' ')[1])];
          const [bm, by] = [MONTHS.indexOf(b[0].split(' ')[0]), parseInt(b[0].split(' ')[1])];
          return ay !== by ? by - ay : bm - am;
        });

        const fmtA = n => n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;

        if (archiveEntry) {
          const e = archiveEntry;
          const txns = e.txns || [];
          const catSpend = {};
          txns.forEach(t => { if (t.amount < 0) catSpend[t.type] = (catSpend[t.type] || 0) + Math.abs(t.amount); });
          const catRanked = Object.entries(catSpend).sort((a, b) => b[1] - a[1]);
          const totalCatSpend = catRanked.reduce((s, [, v]) => s + v, 0);
          const rankColors = ['#f43f5e','#f97316','#f59e0b','#84cc16','#10b981','#06b6d4','#3b82f6','#8b5cf6','#ec4899'];
          return (
            <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">
              <div className="shrink-0 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
                <div className="max-w-3xl mx-auto px-5 py-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-white font-bold text-lg leading-tight">📄 {e.month} {e.year}</h2>
                    <p className="text-slate-400 text-xs mt-0.5">Closed {new Date(e.closedAt).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setArchiveEntry(null)}
                      className="bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors"
                    >← All Statements</button>
                    <button
                      onClick={() => { setShowArchive(false); setArchiveEntry(null); }}
                      className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center text-base transition-colors"
                    >✕</button>
                  </div>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-5 py-6 space-y-6 pb-16">
                  {/* Summary */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Income',    val: e.income, color: 'text-emerald-400' },
                      { label: 'Spent',     val: e.spent,  color: e.spent > e.income ? 'text-rose-400' : 'text-white' },
                      { label: 'Net Saved', val: e.net,    color: e.net >= 0 ? 'text-emerald-400' : 'text-rose-400' },
                      { label: 'Goal',      val: e.goal,   color: 'text-sky-400' },
                    ].map(({ label, val, color }) => (
                      <div key={label} className="bg-slate-900 rounded-2xl p-4 space-y-1">
                        <p className="text-slate-500 text-[10px] uppercase tracking-wider">{label}</p>
                        <p className={`text-xl font-bold font-broske tabular-nums ${color}`}>{fmtA(val || 0)}</p>
                      </div>
                    ))}
                  </div>
                  {e.note && (
                    <div className="bg-slate-800/60 border border-slate-700/40 rounded-2xl px-4 py-3">
                      <p className="text-slate-400 text-xs uppercase tracking-wider mb-1">Month Note</p>
                      <p className="text-white/80 text-sm italic">{e.note}</p>
                    </div>
                  )}
                  {catRanked.length > 0 && (
                    <div>
                      <p className="text-slate-400 text-xs uppercase tracking-wider mb-3">Spending by Category</p>
                      <div className="bg-slate-900 rounded-2xl overflow-hidden divide-y divide-slate-800/60">
                        {catRanked.map(([cat, amt], idx) => (
                          <div key={cat} className="px-5 py-3">
                            <div className="flex items-center justify-between mb-1.5 gap-3">
                              <span className="text-white text-sm">{cat}</span>
                              <div className="text-right">
                                <span className="text-white text-sm font-mono tabular-nums">${amt.toFixed(2)}</span>
                                <span className="text-slate-500 text-[10px] ml-2">{totalCatSpend > 0 ? ((amt / totalCatSpend) * 100).toFixed(1) : 0}%</span>
                              </div>
                            </div>
                            <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                              <div className="h-1.5 rounded-full" style={{ width: `${(amt / (catRanked[0]?.[1] || 1)) * 100}%`, background: rankColors[Math.min(idx, rankColors.length - 1)] }} />
                            </div>
                          </div>
                        ))}
                        <div className="px-5 py-3 flex justify-between items-center bg-slate-800/40">
                          <span className="text-slate-400 text-xs">{catRanked.length} categories</span>
                          <span className="text-white text-sm font-mono font-bold tabular-nums">${totalCatSpend.toFixed(2)} total</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {txns.length > 0 && (
                    <div>
                      <p className="text-slate-400 text-xs uppercase tracking-wider mb-3">All Transactions · {txns.length}</p>
                      <div className="bg-slate-900 rounded-2xl overflow-hidden divide-y divide-slate-800/60">
                        {txns.map((t, i) => (
                          <div key={i} className="px-5 py-3 flex items-center justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <p className="text-white text-sm truncate">{t.type || t.desc}</p>
                              <p className="text-slate-500 text-[10px] mt-0.5">
                                {t.date}
                                {t.account && <> · <span className="text-slate-600">{t.account}</span></>}
                                {t.desc && t.desc !== t.type && <> · <span className="text-slate-600 truncate">{t.desc}</span></>}
                              </p>
                            </div>
                            <span className={`font-mono text-sm font-semibold tabular-nums shrink-0 ${t.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {fmtA(t.amount)}
                            </span>
                          </div>
                        ))}
                        <div className="px-5 py-3 flex justify-between bg-slate-800/60">
                          <span className="text-slate-300 text-sm font-semibold">Net Total</span>
                          <span className={`font-mono text-sm font-bold tabular-nums ${txns.reduce((s, t) => s + t.amount, 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {fmtA(txns.reduce((s, t) => s + t.amount, 0))}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                  {txns.length === 0 && (
                    <div className="bg-slate-900 rounded-2xl p-6 text-center">
                      <p className="text-slate-500 text-sm">No transaction details saved for this statement.</p>
                      <p className="text-slate-600 text-xs mt-1">Close a month via "View Full Statement First" to include transactions.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">
            <div className="shrink-0 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
              <div className="max-w-3xl mx-auto px-5 py-4 flex items-center justify-between">
                <div>
                  <h2 className="text-white font-bold text-lg leading-tight">📚 Statement Archive</h2>
                  <p className="text-slate-400 text-xs mt-0.5">{entries.length} closed month{entries.length !== 1 ? 's' : ''}</p>
                </div>
                <button
                  onClick={() => setShowArchive(false)}
                  className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center text-base transition-colors"
                >✕</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto px-5 py-6 pb-16">
                {entries.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
                    <span className="text-5xl">📭</span>
                    <p className="text-white font-semibold">No archived statements yet</p>
                    <p className="text-slate-400 text-sm max-w-xs">Close a month using the End-of-Month banner or the "View Full Statement First" button to create your first archived statement.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {entries.map(([key, e]) => {
                      const netColor = e.net >= 0 ? 'text-emerald-400' : 'text-rose-400';
                      const goalPct = e.goal > 0 ? Math.min((e.income / e.goal) * 100, 100) : 0;
                      const hasTxns = Array.isArray(e.txns) && e.txns.length > 0;
                      return (
                        <button
                          key={key}
                          onClick={() => setArchiveEntry(e)}
                          className="w-full bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 text-left transition-colors group"
                        >
                          <div className="flex items-start justify-between gap-3 mb-3">
                            <div>
                              <p className="text-white font-bold text-base">{e.month} {e.year}</p>
                              <p className="text-slate-500 text-xs mt-0.5">Closed {new Date(e.closedAt).toLocaleDateString()}{hasTxns ? ` · ${e.txns.length} txns` : ''}</p>
                            </div>
                            <span className="text-slate-600 group-hover:text-slate-400 text-sm transition-colors">→</span>
                          </div>
                          <div className="grid grid-cols-3 gap-3 mb-3">
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Income</p>
                              <p className="text-emerald-400 font-mono font-semibold text-sm tabular-nums">{fmtA(e.income || 0)}</p>
                            </div>
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Spent</p>
                              <p className="text-white font-mono font-semibold text-sm tabular-nums">{fmtA(e.spent || 0)}</p>
                            </div>
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Net</p>
                              <p className={`font-mono font-semibold text-sm tabular-nums ${netColor}`}>{fmtA(e.net || 0)}</p>
                            </div>
                          </div>
                          {e.goal > 0 && (
                            <div className="space-y-1">
                              <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                <div className="h-1.5 rounded-full" style={{ width: `${goalPct}%`, background: goalPct >= 100 ? '#10b981' : goalPct >= 75 ? '#3b82f6' : '#f59e0b' }} />
                              </div>
                              <p className="text-slate-600 text-[10px]">{goalPct.toFixed(0)}% of {fmtA(e.goal)} goal</p>
                            </div>
                          )}
                          {e.note && <p className="text-slate-500 text-xs italic mt-2 truncate">"{e.note}"</p>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Month Note Drawer ────────────────────────────────── */}
      {showNoteDrawer && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end z-50" onClick={() => setShowNoteDrawer(false)}>
          <div className="bg-slate-900 w-full rounded-t-3xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-white font-semibold">{currentMonth} {currentYear} — Note</h2>
              <button onClick={() => setShowNoteDrawer(false)} className="text-slate-400 hover:text-white text-xl">✕</button>
            </div>
            <textarea
              autoFocus
              value={noteInput}
              onChange={e => setNoteInput(e.target.value.slice(0, 200))}
              placeholder="Add a note about this month…"
              className="w-full bg-slate-800 text-white rounded-xl px-4 py-3 text-sm resize-none h-28 outline-none placeholder:text-slate-500 focus:ring-1 focus:ring-blue-500"
            />
            <div className="flex justify-between items-center">
              <span className="text-slate-500 text-xs">{noteInput.length}/200 chars</span>
              <div className="flex gap-2">
                {monthNote && (
                  <button onClick={() => { saveMonthNote(''); setShowNoteDrawer(false); }}
                    className="text-rose-400 hover:text-rose-300 text-sm px-3 py-1.5">Clear</button>
                )}
                <button onClick={() => { saveMonthNote(noteInput); setShowNoteDrawer(false); }}
                  className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-1.5 rounded-lg font-medium">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
