import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { readRange, readReportLinks, appendRow, ensureSheetTab, batchUpdateCells, clearRow } from '../lib/sheets';
import { fetchGasPrices } from '../lib/gasPrice';
import { computeGasBudget, saveGasBudget, getGasBudget } from '../lib/gasBudget';
import { SHEETS, MONTHS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import ProcessIncome from '../components/ProcessIncome';
import { ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, ReferenceLine } from 'recharts';

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

// Task 13 — Subscription cost trend. Stores a monthly snapshot of the total
// monthly subscription run-rate so we can show whether subscription spend is
// growing. localStorage `_fin_sub_total_history = { "YYYY-MM": totalMonthly }`.
// Pure presentation/local-only — no financial data leaves the device.
const SUB_TOTAL_KEY = '_fin_sub_total_history';
function getSubTotalHistory() {
  try { return JSON.parse(localStorage.getItem(SUB_TOTAL_KEY) || '{}'); }
  catch { return {}; }
}
// Record current month's total once (overwrites the current-month bucket so it
// always reflects the latest figure); keeps the most recent 12 months.
function recordSubTotal(totalMonthly) {
  try {
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const hist = getSubTotalHistory();
    const rounded = Math.round(totalMonthly * 100) / 100;
    if (hist[key] === rounded) return hist;
    hist[key] = rounded;
    const trimmed = Object.fromEntries(
      Object.entries(hist).sort(([a], [b]) => a.localeCompare(b)).slice(-12)
    );
    localStorage.setItem(SUB_TOTAL_KEY, JSON.stringify(trimmed));
    return trimmed;
  } catch { return getSubTotalHistory(); }
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
const GAUGE_CX = 64, GAUGE_CY = 64, GAUGE_R = 50;
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
          <svg width="120" height="100" viewBox="0 0 128 108" className="shrink-0">
            {/* Glow behind active arc */}
            {fgPath && <path d={fgPath} fill="none" stroke={tier.color} strokeWidth="18" strokeLinecap="round" strokeOpacity="0.12" />}
            <path d={bgPath} fill="none" stroke="#1e293b" strokeWidth="10" strokeLinecap="round" />
            {fgPath && <path d={fgPath} fill="none" stroke={tier.color} strokeWidth="10" strokeLinecap="round" />}
            {/* tick marks at 25/50/75 */}
            {[25, 50, 75].map(pct => {
              const deg = GAUGE_START + (pct / 100) * GAUGE_SWEEP;
              const outer = gaugePoint(deg);
              const rad = deg * Math.PI / 180;
              const inner = { x: +(GAUGE_CX + (GAUGE_R - 9) * Math.cos(rad)).toFixed(2), y: +(GAUGE_CY + (GAUGE_R - 9) * Math.sin(rad)).toFixed(2) };
              return <line key={pct} x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} stroke="#334155" strokeWidth="2" strokeLinecap="round" />;
            })}
            {/* target marker at 80 */}
            <circle cx={tgt.x} cy={tgt.y} r="5" fill="#f59e0b" />
            <circle cx={tgt.x} cy={tgt.y} r="2.5" fill="rgba(255,255,255,0.6)" />
            <text x={GAUGE_CX} y={GAUGE_CY + 7}  textAnchor="middle" fill="white"   fontSize="22" fontWeight="bold" fontFamily="system-ui">{score}</text>
            <text x={GAUGE_CX} y={GAUGE_CY + 20} textAnchor="middle" fill="#64748b" fontSize="9"  fontFamily="system-ui">/100</text>
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

// Spending Calendar Heatmap (Task 24) — collapsible monthly grid colored by daily spend
function SpendingCalendarCard({ allAllocTx, expanded, onToggle }) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0-indexed
  const [selectedDay, setSelectedDay] = useState(null);
  const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Group txns by dateStr for the viewed month
  const dayMap = {};
  allAllocTx.forEach(tx => {
    const [y, m] = tx.dateStr.split('-').map(Number);
    if (y !== viewYear || m !== viewMonth + 1) return;
    const key = tx.dateStr;
    if (!dayMap[key]) dayMap[key] = { spend: 0, income: 0, txns: [] };
    if (tx.amount > 0) dayMap[key].income += tx.amount;
    else dayMap[key].spend += Math.abs(tx.amount);
    dayMap[key].txns.push(tx);
  });

  const maxSpend = Math.max(1, ...Object.values(dayMap).map(d => d.spend));

  function spendColor(spend, income) {
    if (spend === 0 && income > 0) return 'bg-teal-800/60';
    if (spend === 0) return 'bg-slate-800';
    const pct = spend / maxSpend;
    if (pct < 0.15) return 'bg-rose-950';
    if (pct < 0.40) return 'bg-rose-900/80';
    if (pct < 0.70) return 'bg-rose-700/70';
    return 'bg-rose-500/80';
  }

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayD = now.getFullYear() === viewYear && now.getMonth() === viewMonth ? now.getDate() : -1;
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1);
    setSelectedDay(null);
  };
  const nextMonth = () => {
    const nm = viewMonth === 11 ? 0 : viewMonth + 1;
    const ny = viewMonth === 11 ? viewYear + 1 : viewYear;
    if (ny > now.getFullYear() || (ny === now.getFullYear() && nm > now.getMonth())) return;
    setViewMonth(nm); if (viewMonth === 11) setViewYear(y => y + 1); setSelectedDay(null);
  };
  const atMaxMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();

  const selKey = selectedDay ? `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(selectedDay).padStart(2,'0')}` : null;
  const selData = selKey ? dayMap[selKey] : null;

  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-base">📅</span>
          <span className="text-white font-semibold text-sm">Spending Calendar</span>
          {!expanded && (() => {
            const mo = MN[now.getMonth()];
            const total = Object.values(dayMap).reduce((s,d) => s + d.spend, 0);
            return total > 0 ? <span className="text-slate-400 text-xs">{mo} · ${total.toFixed(0)} spent</span> : null;
          })()}
        </div>
        <span className="text-slate-400 text-sm">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center justify-between">
            <button onClick={prevMonth} className="text-slate-400 hover:text-white px-2 py-1 rounded-lg text-sm transition-colors">‹</button>
            <span className="text-white font-medium text-sm">{MN[viewMonth]} {viewYear}</span>
            <button onClick={nextMonth} disabled={atMaxMonth} className="text-slate-400 hover:text-white disabled:opacity-30 px-2 py-1 rounded-lg text-sm transition-colors">›</button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {['S','M','T','W','T','F','S'].map((d,i) => (
              <div key={i} className="text-slate-600 text-[10px] font-medium py-0.5">{d}</div>
            ))}
            {cells.map((day, i) => {
              if (!day) return <div key={i} />;
              const key = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
              const data = dayMap[key];
              const isToday = day === todayD;
              const isSelected = day === selectedDay;
              const colorCls = data ? spendColor(data.spend, data.income) : 'bg-slate-800';
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDay(day === selectedDay ? null : day)}
                  className={`relative aspect-square rounded flex items-center justify-center text-[11px] font-medium transition-all
                    ${colorCls}
                    ${isSelected ? 'ring-2 ring-white/70' : ''}
                    ${isToday ? 'ring-1 ring-teal-400/60' : ''}
                    ${data ? 'text-white' : 'text-slate-600'}
                  `}
                >
                  {day}
                  {data?.income > 0 && data?.spend > 0 && (
                    <span className="absolute top-0.5 right-0.5 w-1 h-1 rounded-full bg-teal-400" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 justify-center pt-1">
            <span className="text-slate-600 text-[10px]">$0</span>
            {['bg-slate-800','bg-rose-950','bg-rose-900/80','bg-rose-700/70','bg-rose-500/80'].map((c,i) => (
              <div key={i} className={`w-4 h-2.5 rounded-sm ${c}`} />
            ))}
            <span className="text-slate-600 text-[10px]">High</span>
            <span className="w-4 h-2.5 rounded-sm bg-teal-800/60 ml-2" />
            <span className="text-teal-600 text-[10px]">Income</span>
          </div>
          {selData && (
            <div className="bg-slate-900 rounded-xl p-3 space-y-2 border border-slate-700/50">
              <div className="flex justify-between items-center">
                <p className="text-white text-sm font-semibold">{MN[viewMonth]} {selectedDay}</p>
                <div className="flex gap-3 text-xs">
                  {selData.spend > 0 && <span className="text-rose-400">${selData.spend.toFixed(2)} spent</span>}
                  {selData.income > 0 && <span className="text-teal-400">+${selData.income.toFixed(2)} in</span>}
                </div>
              </div>
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {selData.txns.map((tx, i) => (
                  <div key={i} className="flex justify-between items-center text-xs gap-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-slate-300 font-medium truncate block">{tx.type}</span>
                      {tx.desc && <span className="text-slate-500 truncate block">{tx.desc.slice(0,40)}</span>}
                    </div>
                    <span className={`font-mono shrink-0 ${tx.amount >= 0 ? 'text-teal-400' : 'text-rose-400'}`}>
                      {tx.amount >= 0 ? '+' : ''}${Math.abs(tx.amount).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
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
            <p className={`italic pt-1 text-sm ${incDelta > 0 && sptDelta <= 0 ? 'text-emerald-300' : incDelta > 0 ? 'text-teal-300' : sptDelta <= 0 ? 'text-amber-300' : 'text-rose-300'}`}>
              {incDelta > 0 && sptDelta <= 0
                ? 'Income up, spending down — this is what financial momentum looks like. Keep it up! 🐉'
                : incDelta > 0 && sptDelta > 0
                  ? 'Income is growing — now challenge yourself to hold the line on spending too.'
                  : incDelta < 0 && sptDelta <= 0
                    ? 'Expenses are trending down — that discipline will pay off. Push income back up!'
                    : incDelta < 0 && sptDelta > 0
                      ? "Tough month — but one paycheck can change everything. You've got this."
                      : 'Staying steady — look for one small win this month to break through.'}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ── Recurring Income Forecast (Task 16) ──────────────────────────────────────
// Forward-looking 3-month projection so the budget isn't purely backward-looking.
// Income = mean of the last-6 positive-income months (mirrors the Dragon's last-6
// convention so figures reconcile across screens), shown as a low/expected/high
// band rather than one false-precision number. Committed outflows per month =
// subscriptions due that month (annual bills land only in their anniversary month;
// monthly/weekly/biweekly use their monthly run-rate) + recurring P1/P2 budget
// allowances. Reuses chartData / subscriptions / expenses already loaded by the
// Dashboard — zero new API calls, no new sheet tab, no new localStorage.
const FORECAST_MONTHS = 3;

// Subscription cash actually due within a given calendar month. Annual bills only
// hit their anniversary month; recurring cycles contribute their monthly run-rate.
function subsDueInMonth(subs, monthIndex) {
  return subs.reduce((sum, s) => {
    const amt = parseFloat(s['Amount'] || 0) || 0;
    if (!amt) return sum;
    const cycle = (s['Cycle'] || 'monthly').toLowerCase();
    if (cycle === 'annual') {
      const start = new Date((s['Start Date'] || '') + 'T12:00:00');
      return sum + (!isNaN(start) && start.getMonth() === monthIndex ? amt : 0);
    }
    return sum + toMonthly(amt, cycle);
  }, 0);
}

function ForecastCard({ chartData, subscriptions, expenses, expanded, onToggle }) {
  const last6 = chartData.map(d => d.income).filter(v => v > 0).slice(-6);
  if (last6.length < 2) return null;                       // need history to project
  const expected = last6.reduce((s, v) => s + v, 0) / last6.length;
  const low  = Math.min(...last6);
  const high = Math.max(...last6);

  // Recurring committed allowances: P1 (essential) + P2 (stability) budget lines.
  const recurringAllow = expenses
    .filter(e => ['1', '2'].includes(String(e['Priority'] ?? '3')) && pm(e['Monthly Allowance ($)']) > 0)
    .reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);

  const now = new Date();
  let cumulative = 0;
  const rows = Array.from({ length: FORECAST_MONTHS }, (_, i) => {
    const mi = (now.getMonth() + 1 + i) % 12;              // start with NEXT month
    const outflow = subsDueInMonth(subscriptions, mi) + recurringAllow;
    const net = expected - outflow;
    cumulative += net;
    return {
      month: MONTHS[mi].slice(0, 3),
      income: Math.round(expected),
      outflow: Math.round(outflow),
      net, cumulative,
    };
  });
  const runway = cumulative;                               // 3-month cumulative net

  return (
    <div className="bg-slate-800 border border-slate-700/60 rounded-2xl p-4">
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-white font-bold text-sm">🔮 Income Forecast</p>
            <p className="text-slate-400 text-xs mt-0.5">Next {FORECAST_MONTHS} months · projected</p>
          </div>
          <span className="text-slate-500 text-lg leading-none">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>
      {expanded && (
        <>
          {/* Expected income band */}
          <div className="mt-3 bg-slate-900/60 rounded-xl p-3 flex items-center justify-between">
            <div>
              <p className="text-slate-400 text-xs">Expected monthly income</p>
              <p className="text-teal-300 text-xl font-bold">${expected.toFixed(0)}</p>
            </div>
            <div className="text-right text-xs text-slate-500">
              <p>range based on last {last6.length} mo</p>
              <p className="text-slate-300">${low.toFixed(0)} – ${high.toFixed(0)}</p>
            </div>
          </div>

          {/* Income vs committed outflows */}
          <div className="mt-3 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} barCategoryGap="25%" barGap={2}>
                <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip
                  formatter={(v, name) => [`$${Number(v).toFixed(0)}`, name === 'income' ? 'Est. income' : 'Committed out']}
                  contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8, color: '#f1f5f9', fontSize: 12 }}
                />
                <Bar dataKey="income"  fill="#14b8a6" radius={[3, 3, 0, 0]} name="income" />
                <Bar dataKey="outflow" fill="#f59e0b" radius={[3, 3, 0, 0]} name="outflow" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 mt-1 justify-center text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-teal-500 inline-block" />Est. income</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" />Fixed bills</span>
          </div>

          {/* Per-month projected net + cumulative runway */}
          <div className="mt-3 pt-3 border-t border-slate-700 space-y-1 text-xs">
            {rows.map(r => (
              <div key={r.month} className="flex justify-between text-slate-400">
                <span>{r.month}</span>
                <span className="flex gap-3">
                  <span>net <span className={r.net >= 0 ? 'text-teal-400' : 'text-rose-400'}>{r.net >= 0 ? '+' : '−'}${Math.abs(r.net).toFixed(0)}</span></span>
                  <span className="text-slate-500">running <span className={r.cumulative >= 0 ? 'text-teal-400' : 'text-rose-400'}>{r.cumulative >= 0 ? '+' : '−'}${Math.abs(r.cumulative).toFixed(0)}</span></span>
                </span>
              </div>
            ))}
            <p className={`italic pt-1 text-sm ${runway >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              {runway >= 0
                ? `On your recent average you'll clear about $${(runway / FORECAST_MONTHS).toFixed(0)}/mo after fixed bills — roughly $${runway.toFixed(0)} banked over ${FORECAST_MONTHS} months. 🐉`
                : `Heads up — at your recent average, fixed bills outpace income by about $${Math.abs(runway / FORECAST_MONTHS).toFixed(0)}/mo. Trim a commitment or push income up.`}
            </p>
            <p className="text-[10px] text-slate-600 pt-0.5">Estimate from your last {last6.length} months — not a guarantee. Past months stay as recorded.</p>
          </div>
        </>
      )}
    </div>
  );
}

// ── Emergency Fund / Runway (Task 35) ─────────────────────────────────────────
// Runway = savings on hand ÷ monthly essential burn.
//   • Burn  = Σ P1 (essential) + P2 (stability) Monthly-Expenses allowances — the
//     same set ForecastCard commits to, so the two screens reconcile. Savings
//     items are never counted as burn.
//   • Savings on hand = net all-time allocations into Savings-category buckets
//     (deposits − spends), using the app's signed-amount ledger convention.
// Target cushion (in months) lives in localStorage `_fin_ef_target` (default 3) —
// an integer count only, never any financial amount, so nothing sensitive is stored.
const EF_TARGET_KEY = '_fin_ef_target';
function getEFTarget() {
  const n = parseInt(localStorage.getItem(EF_TARGET_KEY) || '3', 10);
  return [1, 3, 6].includes(n) ? n : 3;
}

function EmergencyFundCard({ expenses, allAllocTx, expanded, onToggle }) {
  const [target, setTarget] = useState(getEFTarget);

  // Monthly essential burn — P1 + P2 allowances, never the Savings category itself.
  const burnItems = expenses.filter(e =>
    ['1', '2'].includes(String(e['Priority'] ?? '3')) &&
    e['Expense'] !== 'Savings' &&
    pm(e['Monthly Allowance ($)']) > 0
  );
  const burn = burnItems.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);

  // Savings on hand — net all-time allocations into Savings-category buckets.
  const savingsTypes = new Set(
    expenses.filter(e => e['Expense'] === 'Savings' && e['Type']).map(e => String(e['Type']))
  );
  const bucketBal = {};
  allAllocTx.forEach(r => {
    if (savingsTypes.has(r.type)) bucketBal[r.type] = (bucketBal[r.type] || 0) + r.amount;
  });
  const savings = Object.values(bucketBal).reduce((s, v) => s + v, 0);

  if (burn <= 0) return null;                        // no essentials defined → can't size a runway

  const runway = savings / burn;                     // months of essentials covered
  const tier   = runway < 1 ? 'red' : runway < 3 ? 'amber' : 'teal';
  const color  = tier === 'red' ? 'text-rose-400' : tier === 'amber' ? 'text-amber-300' : 'text-teal-300';
  const barCol = tier === 'red' ? 'bg-rose-500' : tier === 'amber' ? 'bg-amber-500' : 'bg-teal-500';
  const pct    = Math.max(0, Math.min(1, runway / target));
  const shortfall = Math.max(0, burn * target - savings);
  const buckets = Object.entries(bucketBal).sort((a, b) => b[1] - a[1]);

  function pickTarget(n) { setTarget(n); localStorage.setItem(EF_TARGET_KEY, String(n)); }

  return (
    <div className="bg-slate-800 border border-slate-700/60 rounded-2xl p-4">
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-white font-bold text-sm">🛟 Emergency Runway</p>
            <p className={`text-2xl font-bold mt-0.5 ${color}`}>
              {runway >= 100 ? '100+' : runway.toFixed(1)}<span className="text-sm font-medium text-slate-400"> months covered</span>
            </p>
          </div>
          <span className="text-slate-500 text-lg leading-none">{expanded ? '▲' : '▼'}</span>
        </div>
        {/* Progress toward the target cushion */}
        <div className="mt-2 h-2 w-full bg-slate-900/70 rounded-full overflow-hidden">
          <div className={`h-full ${barCol} rounded-full transition-all`} style={{ width: `${pct * 100}%` }} />
        </div>
        <p className="text-[11px] text-slate-500 mt-1">
          {shortfall > 0
            ? `$${shortfall.toFixed(0)} away from a ${target}-month cushion`
            : `Fully funded — ${target}+ months of essentials banked ✓`}
        </p>
      </button>

      {expanded && (
        <>
          {/* Savings vs burn */}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="bg-slate-900/60 rounded-xl p-3">
              <p className="text-slate-400 text-xs">Savings on hand</p>
              <p className="text-teal-300 text-lg font-bold">${savings.toFixed(0)}</p>
            </div>
            <div className="bg-slate-900/60 rounded-xl p-3">
              <p className="text-slate-400 text-xs">Monthly essentials</p>
              <p className="text-rose-300 text-lg font-bold">${burn.toFixed(0)}<span className="text-xs font-medium text-slate-500">/mo</span></p>
            </div>
          </div>

          {/* Target picker */}
          <div className="mt-3 flex items-center gap-2">
            <span className="text-slate-400 text-xs">Target cushion</span>
            <div className="flex gap-1.5 ml-auto">
              {[1, 3, 6].map(n => (
                <button key={n} onClick={() => pickTarget(n)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    target === n ? 'bg-teal-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  {n} mo
                </button>
              ))}
            </div>
          </div>

          {/* Essentials breakdown */}
          <div className="mt-3 pt-3 border-t border-slate-700">
            <p className="text-slate-500 text-[11px] uppercase tracking-wide mb-1.5">Essential burn (P1 + P2)</p>
            <div className="space-y-1 text-xs">
              {burnItems
                .slice()
                .sort((a, b) => pm(b['Monthly Allowance ($)']) - pm(a['Monthly Allowance ($)']))
                .map((e, i) => (
                  <div key={i} className="flex justify-between text-slate-400">
                    <span className="truncate pr-2">{e['Type']}</span>
                    <span className="text-slate-300 font-mono">${pm(e['Monthly Allowance ($)']).toFixed(0)}</span>
                  </div>
                ))}
            </div>
            {/* What you have on hand to cover these essentials right now */}
            <div className="flex justify-between text-xs mt-2 pt-2 border-t border-slate-700/60">
              <span className="text-slate-300 font-medium">Buffer available now</span>
              <span className={`font-mono font-semibold ${savings >= burn ? 'text-teal-300' : 'text-amber-300'}`}>${savings.toFixed(0)}</span>
            </div>
          </div>

          {/* Savings buckets */}
          {buckets.length > 0 && (
            <div className="mt-3 pt-3 border-t border-slate-700">
              <p className="text-slate-500 text-[11px] uppercase tracking-wide mb-1.5">Savings buckets</p>
              <div className="space-y-1 text-xs">
                {buckets.map(([name, bal]) => (
                  <div key={name} className="flex justify-between text-slate-400">
                    <span className="truncate pr-2">{name}</span>
                    <span className={`font-mono ${bal >= 0 ? 'text-teal-400' : 'text-rose-400'}`}>${bal.toFixed(0)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10px] text-slate-600 pt-2">
            Runway = savings ÷ essential monthly burn. Essentials are your P1 + P2 budget lines; savings are net deposits into Savings-category buckets.
          </p>
        </>
      )}
    </div>
  );
}

// ── Spending Anomaly Detection (Task 40) ───────────────────────────────────
// Read-only watchdog: flags this-month spends that are unusually large for their
// category, or look like accidental double-entries. Never edits/deletes a row.
//   • Size baseline is robust (median + k·MAD, not mean/stdev) so one past spike
//     doesn't desensitise the whole category. A category is only judged once it
//     has ≥ ANOMALY_MIN_HISTORY prior spends, so brand-new categories stay quiet.
//   • Near-duplicate = same Type + same amount within 3 days (possible mis-tap).
// Dismissals live in localStorage `_fin_anomaly_seen` as opaque row hashes
// (Type|date|amount) — no standalone financial figure is stored, just a key.
const ANOMALY_KEY = '_fin_anomaly_seen';
const ANOMALY_K = 3;             // robustness multiplier on scaled MAD
const ANOMALY_MIN_HISTORY = 5;   // prior spends a category needs before it's judged

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function getAnomalySeen() {
  try { const a = JSON.parse(localStorage.getItem(ANOMALY_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

// Pure: returns flagged anomalies for the current calendar month, newest first.
function detectAnomalies(allAllocTx) {
  const now = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Spends only: negative rows, recorded as positive magnitudes.
  const spends = allAllocTx
    .filter(r => r.amount < 0)
    .map(r => ({ type: r.type, amount: Math.abs(r.amount), dateStr: r.dateStr, desc: r.desc }));
  const byType = {};
  spends.forEach(s => { (byType[s.type] ||= []).push(s); });
  const curMonth = spends.filter(s => s.dateStr.slice(0, 7) === curKey);

  const flags = [];
  const flagged = new Set();

  // 1) Size anomalies vs the category's trailing baseline (prior months only).
  curMonth.forEach(s => {
    const hist = (byType[s.type] || []).filter(h => h.dateStr.slice(0, 7) !== curKey);
    if (hist.length < ANOMALY_MIN_HISTORY) return;
    const amts = hist.map(h => h.amount);
    const med = median(amts);
    if (med <= 0) return;
    let scaled = 1.4826 * median(amts.map(a => Math.abs(a - med)));
    if (scaled < med * 0.10) scaled = med * 0.10;   // floor: near-constant history isn't hypersensitive
    const threshold = med + ANOMALY_K * scaled;
    if (s.amount > threshold && s.amount >= med * 1.5) {
      const hash = `${s.type}|${s.dateStr}|${s.amount.toFixed(2)}`;
      flagged.add(hash);
      flags.push({
        hash, type: s.type, amount: s.amount, dateStr: s.dateStr, desc: s.desc, kind: 'size',
        reason: `${(s.amount / med).toFixed(1)}× your typical ${s.type} spend (~$${med.toFixed(0)})`,
      });
    }
  });

  // 2) Near-duplicate charges this month (same Type + amount within 3 days).
  for (let i = 0; i < curMonth.length; i++) {
    for (let j = i + 1; j < curMonth.length; j++) {
      const a = curMonth[i], b = curMonth[j];
      if (a.type !== b.type || Math.abs(a.amount - b.amount) > 0.01) continue;
      const dd = Math.abs((new Date(a.dateStr) - new Date(b.dateStr)) / 86400000);
      if (dd > 3) continue;
      const later = new Date(a.dateStr) >= new Date(b.dateStr) ? a : b;
      const hash = `${later.type}|${later.dateStr}|${later.amount.toFixed(2)}`;
      if (flagged.has(hash)) continue;
      flagged.add(hash);
      flags.push({
        hash, type: later.type, amount: later.amount, dateStr: later.dateStr, desc: later.desc, kind: 'dup',
        reason: `Possible duplicate — same $${later.amount.toFixed(2)} ${later.type} charge within 3 days`,
      });
    }
  }

  flags.sort((a, b) => b.dateStr.localeCompare(a.dateStr));
  return flags;
}

function AnomalyCard({ allAllocTx, expanded, onToggle }) {
  const [seen, setSeen] = useState(getAnomalySeen);
  const flags = detectAnomalies(allAllocTx).filter(f => !seen.includes(f.hash));
  if (flags.length === 0) return null;

  function dismiss(hash) {
    const next = [...seen, hash];
    setSeen(next);
    localStorage.setItem(ANOMALY_KEY, JSON.stringify(next.slice(-200)));   // cap stored keys
  }

  const fmtD = (ds) => { const [, m, d] = ds.split('-'); return `${parseInt(m, 10)}/${parseInt(d, 10)}`; };

  return (
    <div className="bg-slate-800 border border-amber-700/40 rounded-2xl p-4">
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-white font-bold text-sm">🔎 Unusual Charges</p>
            <p className="text-amber-300 text-2xl font-bold mt-0.5">
              {flags.length}<span className="text-sm font-medium text-slate-400"> flagged this month</span>
            </p>
          </div>
          <span className="text-slate-500 text-lg leading-none">{expanded ? '▲' : '▼'}</span>
        </div>
        {!expanded && (
          <p className="text-[11px] text-slate-500 mt-1 truncate">
            {flags[0].type} · ${flags[0].amount.toFixed(2)} — {flags[0].reason}
          </p>
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {flags.map(f => (
            <div key={f.hash} className="bg-slate-900/60 rounded-xl p-3 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-white text-sm font-medium truncate">{f.type}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${
                    f.kind === 'dup' ? 'bg-indigo-900/70 text-indigo-300' : 'bg-amber-900/70 text-amber-300'}`}>
                    {f.kind === 'dup' ? 'duplicate?' : 'large'}
                  </span>
                  <span className="text-rose-300 font-mono text-sm ml-auto shrink-0">${f.amount.toFixed(2)}</span>
                </div>
                <p className="text-slate-400 text-xs mt-0.5">{f.reason}</p>
                {f.desc && <p className="text-slate-600 text-[11px] truncate">{f.desc.slice(0, 50)}</p>}
                <p className="text-slate-600 text-[10px] mt-0.5">{fmtD(f.dateStr)}</p>
              </div>
              <button
                onClick={() => dismiss(f.hash)}
                className="text-slate-500 hover:text-slate-300 text-xs shrink-0 px-1.5 py-0.5 rounded-lg hover:bg-slate-700 transition-colors"
                title="Dismiss — looks fine"
              >✕</button>
            </div>
          ))}
          <p className="text-[10px] text-slate-600 pt-1">
            Read-only — flags large or repeated charges vs each category's history. Dismiss anything expected; it won't reappear.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Savings-Rate Trend & 50/30/20 Budget Check (Task 42) ──────────────────────
// Read-only: buckets each month's allocation DEPOSITS into Needs / Wants / Savings
// using the type→category map from Monthly Expenses, benchmarks the latest mix
// against the classic 50/30/20 rule, and charts the 6-month savings-rate trend.
//   • Needs   = Essentials + Stability   (P1/P2 fallback when Expense is blank)
//   • Wants   = Discretionary + Subscription (P3 fallback) · unmapped types → Wants
//   • Savings = Expense === 'Savings'
//   • Income basis = that month's total deposits, so the three shares always sum
//     to 100% (a clean stacked-to-full bar) and reconcile with processed income.
// Pure presentation — zero new API calls, no new sheet tab, no localStorage.
const MIX_TARGET = { needs: 50, wants: 30, savings: 20 };
const MIX_COLORS = { needs: '#0ea5e9', wants: '#f59e0b', savings: '#10b981' };

function mixMonthLabel(key) {
  const m = parseInt(key.slice(5, 7), 10) - 1;
  return MONTHS[m] ? MONTHS[m].slice(0, 3) : key.slice(5);
}

// type(lowercased) → 'needs' | 'wants' | 'savings'. Savings always wins.
function buildMixMap(expenses) {
  const map = {};
  expenses.forEach(e => {
    const type = String(e['Type'] || '').trim().toLowerCase();
    if (!type) return;
    let cat;
    if (e['Expense'] === 'Savings') cat = 'savings';
    else if (e['Expense'] === 'Essentials' || e['Expense'] === 'Stability') cat = 'needs';
    else if (e['Expense'] === 'Discretionary' || e['Expense'] === 'Subscription') cat = 'wants';
    else cat = ['1', '2'].includes(String(e['Priority'] ?? '3')) ? 'needs' : 'wants';
    map[type] = cat;
  });
  return map;
}

// Pure: group positive deposits by YYYY-MM, bucket by category, return last-6
// months (chronological) with absolute $ and percentage shares.
function computeBudgetMix(allAllocTx, expenses) {
  const mixMap = buildMixMap(expenses);
  const byMonth = {};
  allAllocTx.forEach(r => {
    if (r.amount <= 0) return;                                  // deposits only
    const key = (r.dateStr || '').slice(0, 7);
    if (key.length !== 7) return;
    const cat = mixMap[String(r.type || '').trim().toLowerCase()] || 'wants';
    const m = byMonth[key] || (byMonth[key] = { key, needs: 0, wants: 0, savings: 0 });
    m[cat] += r.amount;
  });
  return Object.values(byMonth)
    .map(m => {
      const total = m.needs + m.wants + m.savings;
      return {
        ...m, total, label: mixMonthLabel(m.key),
        needsPct:   total > 0 ? (m.needs / total) * 100 : 0,
        wantsPct:   total > 0 ? (m.wants / total) * 100 : 0,
        savingsPct: total > 0 ? (m.savings / total) * 100 : 0,
      };
    })
    .filter(m => m.total > 0)
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(-6);
}

// Tiny inline savings-rate sparkline (no extra deps; scales 0..max).
function MixSparkline({ values }) {
  if (values.length < 2) return null;
  const w = 96, h = 26, max = Math.max(...values, MIX_TARGET.savings, 1);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
  const targetY = (h - (MIX_TARGET.savings / max) * h).toFixed(1);
  return (
    <svg width={w} height={h} className="overflow-visible">
      <line x1="0" y1={targetY} x2={w} y2={targetY} stroke="#475569" strokeDasharray="3 3" strokeWidth="1" />
      <polyline points={pts} fill="none" stroke={MIX_COLORS.savings} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function BudgetMixCard({ allAllocTx, expenses, expanded, onToggle }) {
  const months = computeBudgetMix(allAllocTx, expenses);
  if (months.length < 1) return null;
  const latest = months[months.length - 1];

  // Within-target chips (small grace so e.g. 50.2% still reads green).
  const needsOk   = latest.needsPct   <= MIX_TARGET.needs + 1;
  const wantsOk   = latest.wantsPct   <= MIX_TARGET.wants + 1;
  const savingsOk = latest.savingsPct >= MIX_TARGET.savings - 1;

  // Savings-rate trend: earliest vs latest month in the window.
  const savingsSeries = months.map(m => m.savingsPct);
  const trendDelta = savingsSeries.length >= 2
    ? savingsSeries[savingsSeries.length - 1] - savingsSeries[0] : 0;
  const trendUp = trendDelta >= 0;

  const chip = (label, val, ok, target) => (
    <div className={`flex-1 rounded-xl px-2 py-2 text-center ${ok ? 'bg-emerald-900/30' : 'bg-amber-900/30'}`}>
      <p className={`text-base font-bold ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>{val.toFixed(0)}%</p>
      <p className="text-[10px] text-slate-400 leading-tight">{label}</p>
      <p className="text-[9px] text-slate-600">target {target}%</p>
    </div>
  );

  return (
    <div className="bg-slate-800 border border-slate-700/60 rounded-2xl p-4">
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-white font-bold text-sm">⚖️ Budget Balance</p>
            <p className="text-slate-400 text-xs mt-0.5">
              {latest.needsPct.toFixed(0)}% needs · {latest.wantsPct.toFixed(0)}% wants · {latest.savingsPct.toFixed(0)}% savings
            </p>
          </div>
          <span className="text-slate-500 text-lg leading-none">{expanded ? '▲' : '▼'}</span>
        </div>
        {/* Collapsed: this-month split bar so the mix reads at a glance */}
        <div className="mt-2 h-2.5 w-full rounded-full overflow-hidden flex bg-slate-900/70">
          <div style={{ width: `${latest.needsPct}%`,   background: MIX_COLORS.needs }} />
          <div style={{ width: `${latest.wantsPct}%`,   background: MIX_COLORS.wants }} />
          <div style={{ width: `${latest.savingsPct}%`, background: MIX_COLORS.savings }} />
        </div>
      </button>

      {expanded && (
        <>
          {/* Target chips vs the 50/30/20 rule */}
          <div className="mt-3 flex gap-2">
            {chip('Needs',   latest.needsPct,   needsOk,   MIX_TARGET.needs)}
            {chip('Wants',   latest.wantsPct,   wantsOk,   MIX_TARGET.wants)}
            {chip('Savings', latest.savingsPct, savingsOk, MIX_TARGET.savings)}
          </div>

          {/* 6-month stacked-% bars with 50% and 80% guide lines */}
          {months.length >= 2 && (
            <div className="mt-3 h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={months} barCategoryGap="22%" stackOffset="expand">
                  <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis hide domain={[0, 100]} />
                  <Tooltip
                    formatter={(v, name) => [`${Number(v).toFixed(0)}%`, name]}
                    contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8, color: '#f1f5f9', fontSize: 12 }}
                  />
                  <ReferenceLine y={0.50} stroke="#64748b" strokeDasharray="4 3" ifOverflow="extendDomain" />
                  <ReferenceLine y={0.80} stroke="#64748b" strokeDasharray="4 3" ifOverflow="extendDomain" />
                  <Bar dataKey="needsPct"   stackId="m" fill={MIX_COLORS.needs}   name="Needs" />
                  <Bar dataKey="wantsPct"   stackId="m" fill={MIX_COLORS.wants}   name="Wants" />
                  <Bar dataKey="savingsPct" stackId="m" fill={MIX_COLORS.savings} name="Savings" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="flex gap-4 mt-1 justify-center text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: MIX_COLORS.needs }} />Needs</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: MIX_COLORS.wants }} />Wants</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: MIX_COLORS.savings }} />Savings</span>
          </div>

          {/* Savings-rate trend */}
          <div className="mt-3 pt-3 border-t border-slate-700 flex items-center justify-between">
            <div>
              <p className="text-slate-400 text-xs">Savings rate</p>
              <p className="text-emerald-300 text-lg font-bold">{latest.savingsPct.toFixed(0)}%</p>
              {savingsSeries.length >= 2 && (
                <p className="text-[11px] text-slate-500">
                  {trendUp ? '▲' : '▼'} {Math.abs(trendDelta).toFixed(0)} pts over {months.length} mo
                </p>
              )}
            </div>
            <MixSparkline values={savingsSeries} />
          </div>

          <p className={`italic pt-2 text-sm ${savingsOk && needsOk ? 'text-emerald-300' : 'text-amber-300'}`}>
            {savingsOk && needsOk
              ? `Nicely balanced — you're saving ${latest.savingsPct.toFixed(0)}% and keeping needs under half. 🐉`
              : !savingsOk
                ? `You're saving ${latest.savingsPct.toFixed(0)}% — the 50/30/20 rule aims for 20%+. Even a few points more compounds.`
                : `Needs are ${latest.needsPct.toFixed(0)}% of your money (target ≤50%). Trimming a fixed bill frees room to save.`}
          </p>
          <p className="text-[10px] text-slate-600 pt-0.5">
            Mix from this month's deposits, bucketed by each item's budget category. The 50/30/20 rule is a guideline, not a mandate.
          </p>
        </>
      )}
    </div>
  );
}

// ── Safe-to-Spend Today (Task 44) ──────────────────────────────────────────
// One unified daily number: after this month's bills and savings are covered,
// how much is genuinely free to spend — spread across the days left.
//   free = (income in − already spent) − unpaid essentials − unmet savings
//   • Essentials = P1 + P2 non-Savings allowances (the same set EmergencyFund /
//     ForecastCard reserve, so the cards reconcile). We reserve only the UNPAID
//     portion (allowance − already-spent on that line this month), so a bill
//     you've already paid is never double-counted.
//   • Savings    = Expense='Savings' allowances; reserve the UNMET portion
//     (allowance − already-funded into that bucket this month).
//   • Discretionary spends already made live inside `spent`, so they shrink the
//     free pot automatically.
// Pure presentation over already-loaded state — zero new API calls, no storage.
function SafeToSpendCard({ income, spent, expenses, allAllocTx, daysLeftIncl, expanded, onToggle }) {
  const now = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Current-month per-Type sums: spent (abs of negatives) + funded (positives).
  const spentByType = {};
  const fundedByType = {};
  allAllocTx.forEach(r => {
    if (r.dateStr.slice(0, 7) !== curKey) return;
    if (r.amount < 0) spentByType[r.type]  = (spentByType[r.type]  || 0) + Math.abs(r.amount);
    else              fundedByType[r.type] = (fundedByType[r.type] || 0) + r.amount;
  });

  // Unpaid essentials (P1+P2, non-Savings): allowance still owed after what's paid.
  const essRows = expenses
    .filter(e => ['1', '2'].includes(String(e['Priority'] ?? '3')) &&
      e['Expense'] !== 'Savings' && pm(e['Monthly Allowance ($)']) > 0)
    .map(e => {
      const allow = pm(e['Monthly Allowance ($)']);
      const paid  = spentByType[String(e['Type'])] || 0;
      return { type: String(e['Type']), owed: Math.max(0, allow - paid) };
    });
  const owedEssentials = essRows.reduce((s, r) => s + r.owed, 0);

  // Unmet savings targets: allowance still un-funded into that bucket this month.
  const savRows = expenses
    .filter(e => e['Expense'] === 'Savings' && pm(e['Monthly Allowance ($)']) > 0)
    .map(e => {
      const allow = pm(e['Monthly Allowance ($)']);
      const saved = fundedByType[String(e['Type'])] || 0;
      return { type: String(e['Type']), unmet: Math.max(0, allow - saved) };
    });
  const unmetSavings = savRows.reduce((s, r) => s + r.unmet, 0);

  const net    = income - spent;                          // cash this month after spends
  const free   = net - owedEssentials - unmetSavings;     // genuinely uncommitted
  const perDay = daysLeftIncl > 0 ? Math.max(0, free) / daysLeftIncl : 0;

  // Tier: rose when nothing's free, amber when ≤15% of remaining cash is free,
  // teal when comfortable. Dimensionless, so it reads sensibly at any income.
  const tightRatio = net > 0 ? free / net : (free > 0 ? 1 : 0);
  const tier  = free <= 0 ? 'red' : tightRatio < 0.15 ? 'amber' : 'teal';
  const color = tier === 'red' ? 'text-rose-400' : tier === 'amber' ? 'text-amber-300' : 'text-emerald-400';

  return (
    <div className={`rounded-2xl p-4 border ${
      tier === 'red'    ? 'bg-rose-950/40 border-rose-800/50'
      : tier === 'amber' ? 'bg-amber-950/30 border-amber-800/40'
      : 'bg-gradient-to-br from-emerald-950/50 to-slate-800 border-emerald-800/40'}`}>
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className={`text-[11px] font-bold uppercase tracking-wider ${
              tier === 'red' ? 'text-rose-300/90' : tier === 'amber' ? 'text-amber-300/90' : 'text-emerald-300/90'}`}>
              ✅ Safe to spend today
            </p>
            <p className={`text-3xl font-black font-broske mt-1 tabular-nums ${color}`}>
              {fmt(perDay)}<span className="text-slate-500 text-sm font-bold"> /day</span>
            </p>
            <p className="text-slate-400 text-xs mt-1.5">
              {free <= 0
                ? <>Everything left is already spoken for by bills &amp; savings — hold off if you can</>
                : <><span className="text-slate-200 font-semibold">{fmt(free)}</span> free ÷ <span className="text-slate-200 font-semibold">{daysLeftIncl}</span> {daysLeftIncl === 1 ? 'day' : 'days'} left this month</>}
            </p>
          </div>
          <span className="text-slate-500 text-lg leading-none">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-700/60 text-xs space-y-1.5">
          <div className="flex justify-between text-slate-400"><span>Money in this month</span><span className="font-mono text-teal-300">${income.toFixed(0)}</span></div>
          <div className="flex justify-between text-slate-400"><span>− Already spent</span><span className="font-mono text-slate-300">${spent.toFixed(0)}</span></div>
          <div className="flex justify-between text-slate-400"><span>− Bills still owed</span><span className="font-mono text-amber-300">${owedEssentials.toFixed(0)}</span></div>
          <div className="flex justify-between text-slate-400"><span>− Savings still to set aside</span><span className="font-mono text-sky-300">${unmetSavings.toFixed(0)}</span></div>
          <div className="flex justify-between pt-1.5 border-t border-slate-700/60">
            <span className="text-slate-200 font-semibold">= Free for the rest of the month</span>
            <span className={`font-mono font-semibold ${free > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>${free.toFixed(0)}</span>
          </div>

          {essRows.some(r => r.owed > 0) && (
            <div className="mt-3 pt-2 border-t border-slate-700/60">
              <p className="text-slate-500 text-[11px] uppercase tracking-wide mb-1">Bills not yet covered</p>
              {essRows.filter(r => r.owed > 0).sort((a, b) => b.owed - a.owed).map(r => (
                <div key={r.type} className="flex justify-between text-slate-400"><span className="truncate pr-2">{r.type}</span><span className="font-mono text-amber-300">${r.owed.toFixed(0)}</span></div>
              ))}
            </div>
          )}
          {savRows.some(r => r.unmet > 0) && (
            <div className="mt-3 pt-2 border-t border-slate-700/60">
              <p className="text-slate-500 text-[11px] uppercase tracking-wide mb-1">Savings still to fund</p>
              {savRows.filter(r => r.unmet > 0).sort((a, b) => b.unmet - a.unmet).map(r => (
                <div key={r.type} className="flex justify-between text-slate-400"><span className="truncate pr-2">{r.type}</span><span className="font-mono text-sky-300">${r.unmet.toFixed(0)}</span></div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-slate-600 pt-2">
            Free = money in − spent − unpaid essentials (P1+P2) − unmet savings, split across the {daysLeftIncl} day{daysLeftIncl === 1 ? '' : 's'} left. Already-paid bills aren't double-counted.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Cash Envelope / Every-Dollar-Assigned Check (Task 47) ───────────────────
// Zero-based budgeting discipline: income minus all category allowances should
// equal exactly $0 — every dollar given a job.
//   assigned = Σ all Monthly Allowance ($)   ·   gap = income − assigned
//   • gap > 0  → unassigned money drifting (prompt to give it a job → savings)
//   • gap < 0  → the plan promises more than you earn (over-assigned)
//   • gap ≈ 0  → every dollar assigned ✓ (the zero-based ideal)
// Allowances are bucketed needs/wants/savings via the same `buildMixMap` the
// Budget-Balance card uses, so the two never disagree. The income basis is the
// month's processed deposits (alloc ground-truth) — the same figure the
// Health-Score "allocation completeness" signal measures, so they reconcile.
// Pure derived view over already-loaded state — zero new API calls, no storage.
function computeEnvelope(expenses, income, allAllocTx) {
  const mixMap = buildMixMap(expenses);
  const byCat = { needs: 0, wants: 0, savings: 0 };
  expenses.forEach(e => {
    const allow = pm(e['Monthly Allowance ($)']);
    if (allow <= 0) return;
    const cat = mixMap[String(e['Type'] || '').trim().toLowerCase()] || 'wants';
    byCat[cat] += allow;
  });
  const assigned = byCat.needs + byCat.wants + byCat.savings;
  const gap = income - assigned;                              // + left to assign / − over-assigned

  // Suggest where a surplus should go: the savings bucket most under-funded this
  // month (allowance − funded). Falls back to the largest-allowance savings item.
  const now = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const fundedByType = {};
  allAllocTx.forEach(r => {
    if (r.amount > 0 && r.dateStr.slice(0, 7) === curKey) {
      fundedByType[r.type] = (fundedByType[r.type] || 0) + r.amount;
    }
  });
  let suggestBucket = null;
  expenses.filter(e => e['Expense'] === 'Savings' && pm(e['Monthly Allowance ($)']) > 0)
    .forEach(e => {
      const allow = pm(e['Monthly Allowance ($)']);
      const unmet = Math.max(0, allow - (fundedByType[String(e['Type'])] || 0));
      const score = unmet > 0 ? unmet : allow * 0.001;       // prefer under-funded, else fall back
      if (!suggestBucket || score > suggestBucket.score) suggestBucket = { type: String(e['Type']), score };
    });

  return { byCat, assigned, gap, suggestBucket: suggestBucket?.type || null };
}

function EveryDollarCard({ income, expenses, allAllocTx, expanded, onToggle }) {
  const { byCat, assigned, gap, suggestBucket } = computeEnvelope(expenses, income, allAllocTx);
  if (assigned <= 0) return null;

  // Balanced within a dollar (rounding) → the zero-based ideal.
  const state = gap > 1 ? 'surplus' : gap < -1 ? 'over' : 'balanced';
  const color = state === 'surplus' ? 'text-sky-300' : state === 'over' ? 'text-rose-400' : 'text-emerald-400';

  // Bar denominator: when under-assigned the leftover shows as grey "unassigned";
  // when over-assigned the segments fill and there's no grey.
  const denom = Math.max(assigned, income, 1);
  const seg = (v) => `${(v / denom) * 100}%`;
  const unassigned = Math.max(0, income - assigned);

  return (
    <div className={`rounded-2xl p-4 border ${
      state === 'over'     ? 'bg-rose-950/40 border-rose-800/50'
      : state === 'surplus' ? 'bg-sky-950/30 border-sky-800/40'
      : 'bg-gradient-to-br from-emerald-950/50 to-slate-800 border-emerald-800/40'}`}>
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">🧮 Every Dollar Assigned</p>
            <p className={`text-2xl font-black font-broske mt-1 tabular-nums ${color}`}>
              {state === 'balanced'
                ? '✓ Balanced'
                : `${fmt(Math.abs(gap))} ${state === 'surplus' ? 'left to assign' : 'over-assigned'}`}
            </p>
            <p className="text-slate-400 text-xs mt-1.5">
              {state === 'surplus'
                ? <>You've planned <span className="text-slate-200 font-semibold">{fmt(assigned)}</span> of <span className="text-slate-200 font-semibold">{fmt(income)}</span> — give the rest a job</>
                : state === 'over'
                  ? <>Your plan assigns <span className="text-slate-200 font-semibold">{fmt(assigned)}</span> but only <span className="text-slate-200 font-semibold">{fmt(income)}</span> came in</>
                  : <>Every dollar of <span className="text-slate-200 font-semibold">{fmt(income)}</span> has a job — zero-based ✓</>}
            </p>
          </div>
          <span className="text-slate-500 text-lg leading-none">{expanded ? '▲' : '▼'}</span>
        </div>
        {/* Where the assigned dollars go (share of income), with leftover grey */}
        <div className="mt-2 h-2.5 w-full rounded-full overflow-hidden flex bg-slate-900/70">
          <div style={{ width: seg(byCat.needs),   background: MIX_COLORS.needs }} />
          <div style={{ width: seg(byCat.wants),   background: MIX_COLORS.wants }} />
          <div style={{ width: seg(byCat.savings), background: MIX_COLORS.savings }} />
          {unassigned > 0 && <div style={{ width: seg(unassigned), background: '#475569' }} />}
        </div>
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-700/60 text-xs space-y-1.5">
          <div className="flex justify-between text-slate-400"><span>Income this month</span><span className="font-mono text-teal-300">${income.toFixed(0)}</span></div>
          <div className="flex justify-between text-slate-400"><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm inline-block" style={{ background: MIX_COLORS.needs }} />Assigned to needs</span><span className="font-mono text-slate-300">${byCat.needs.toFixed(0)}</span></div>
          <div className="flex justify-between text-slate-400"><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm inline-block" style={{ background: MIX_COLORS.wants }} />Assigned to wants</span><span className="font-mono text-slate-300">${byCat.wants.toFixed(0)}</span></div>
          <div className="flex justify-between text-slate-400"><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm inline-block" style={{ background: MIX_COLORS.savings }} />Assigned to savings</span><span className="font-mono text-slate-300">${byCat.savings.toFixed(0)}</span></div>
          <div className="flex justify-between pt-1.5 border-t border-slate-700/60">
            <span className="text-slate-200 font-semibold">= Total assigned</span>
            <span className="font-mono font-semibold text-slate-200">${assigned.toFixed(0)}</span>
          </div>
          <div className="flex justify-between">
            <span className={`font-semibold ${state === 'surplus' ? 'text-sky-300' : state === 'over' ? 'text-rose-300' : 'text-emerald-300'}`}>
              {state === 'over' ? 'Over-assigned by' : 'Left to assign'}
            </span>
            <span className={`font-mono font-semibold ${state === 'surplus' ? 'text-sky-300' : state === 'over' ? 'text-rose-300' : 'text-emerald-300'}`}>${Math.abs(gap).toFixed(0)}</span>
          </div>

          <p className={`italic pt-2 text-sm ${color}`}>
            {state === 'surplus'
              ? (suggestBucket
                  ? `Give it a job: park the ${fmt(gap)} into "${suggestBucket}" so it's working, not drifting.`
                  : `Assign the ${fmt(gap)} to a savings bucket or goal so it's working, not drifting.`)
              : state === 'over'
                ? `Your plan promises ${fmt(Math.abs(gap))} more than you earned — trim a category or this month runs a deficit.`
                : `Textbook zero-based budget — every dollar has a job. 🐉`}
          </p>
          <p className="text-[10px] text-slate-600 pt-0.5">
            Assigned = sum of every category's monthly allowance, bucketed needs/wants/savings. Zero-based budgeting aims to assign income down to $0.
          </p>
        </div>
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
  const [gasBudget, setGasBudget]       = useState(() => getGasBudget()?.value ?? null);
  // Bumped after income is processed / a gas spend is logged to re-pull sheet data.
  const [refreshKey, setRefreshKey]     = useState(0);
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
  const [stmtCopied, setStmtCopied]     = useState(false);
  const [budgetAlerts, setBudgetAlerts] = useState({ overCount: 0, needsCount: 0, dueAlerts: [] });
  const [allocTotals, setAllocTotals]   = useState({ income: 0, spent: 0 });
  // Close-month (previous month) activity derived from its own allocation rows — the
  // app's ground truth, so the Close-Month modal agrees with the Dashboard tiles.
  const [closeAlloc, setCloseAlloc]     = useState({ income: 0, spent: 0, byType: {}, hasRows: false });
  const [hasCurrentMonthAllocRows, setHasCurrentMonthAllocRows] = useState(null);
  const [healthScore, setHealthScore]   = useState({ total: 0, signals: [], history: [], loaded: false });
  const [healthExpanded, setHealthExpanded] = useState(false);
  const [trendExpanded, setTrendExpanded]   = useState(false);
  const [forecastExpanded, setForecastExpanded] = useState(false);
  const [efExpanded, setEfExpanded]             = useState(false);
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
  const [allAllocTx, setAllAllocTx] = useState([]);
  const [heatmapExpanded, setHeatmapExpanded] = useState(false);
  const [anomalyExpanded, setAnomalyExpanded] = useState(false);
  const [mixExpanded, setMixExpanded]         = useState(false);
  const [safeExpanded, setSafeExpanded]       = useState(false);
  const [envelopeExpanded, setEnvelopeExpanded] = useState(false);
  const [paydayConfig, setPaydayConfig] = useState(() => {
    try { return JSON.parse(localStorage.getItem('_fin_payday_config') || 'null') || null; } catch { return null; }
  });
  const [showPaydayConfig, setShowPaydayConfig] = useState(false);
  const [qaActions, setQaActions] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('_fin_quickactions') || 'null');
      if (Array.isArray(s) && s.length) return s;
    } catch {}
    return ['income', 'log', 'month', 'cal'];
  });
  const [showQAEdit, setShowQAEdit] = useState(false);

  const billCalRef = useRef(null);

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
          setAllAllocTx(allocData.filter(r => r[0] && r[1]).map(r => {
            const ds = String(r[0]);
            const n = Number(ds);
            let dv;
            if (!isNaN(n) && n > 1000 && !ds.includes('/')) {
              dv = new Date(Math.round((n - 25569) * 86400000));
            } else {
              dv = new Date(ds);
            }
            if (!dv || isNaN(dv.getTime())) return null;
            const yyyy = dv.getFullYear();
            const mm = String(dv.getMonth() + 1).padStart(2, '0');
            const dd = String(dv.getDate()).padStart(2, '0');
            return { dateStr: `${yyyy}-${mm}-${dd}`, type: String(r[1]), amount: pm(r[2]), desc: r[3] != null ? String(r[3]) : '' };
          }).filter(Boolean));

          // Close-month totals from its own rows (ground truth for the Close-Month modal).
          const cByType = {};
          closeTxns.forEach(t => { if (t.amount > 0) cByType[t.type] = (cByType[t.type] || 0) + t.amount; });
          setCloseAlloc({
            income:  closeTxns.reduce((s, t) => t.amount > 0 ? s + t.amount : s, 0),
            spent:   closeTxns.reduce((s, t) => t.amount < 0 ? s + Math.abs(t.amount) : s, 0),
            byType:  cByType,
            hasRows: closeTxns.length > 0,
          });

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
            const needsCount = mainExp.filter(i => {
              if (String(i['Priority'] ?? '3') !== '1' || pm(i['Monthly Allowance ($)']) <= 0) return false;
              // Gas funds from its all-time running balance, not monthly deposits.
              if (String(i['Type'] || '').trim().toLowerCase() === 'gas') return gasBal <= 0;
              return !(abt[i['Type'] || ''] > 0);
            }).length;
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
            const p1Done  = p1Items.filter(i => {
              // Gas funds from its all-time running balance, not this month's deposits.
              if (String(i['Type']||'').trim().toLowerCase() === 'gas') return gasBal > 0;
              return (abt[i['Type']||'']||0) >= pm(i['Monthly Allowance ($)']);
            });
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
  }, [token, refreshKey]);

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
        // Recompute the dynamic gas budget from the live price and cache it so
        // ProcessIncome / Budget reflect the same ~$185 reserve (not a static $120).
        if (nyc && nyc > 0) {
          const cachedMpg = getGasBudget()?.mpg;
          const budget = computeGasBudget({ gasPerGal: nyc, mpg: cachedMpg });
          if (budget) {
            setGasBudget(budget);
            saveGasBudget(budget, { gasPerGal: nyc, ...(cachedMpg ? { mpg: cachedMpg } : {}) });
          }
        }
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
  const spent       = hasCurrentMonthAllocRows !== null
    ? allocTotals.spent
    : (allocTotals.spent || pm(current?.['Total Spent']));
  const goal        = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0) || pm(current?.['Allowance Goal']);
  const net         = income - spent;
  const goalPct     = goal > 0 ? (income / goal) * 100 : 0;
  const spendPct    = income > 0 ? (spent / income) * 100 : 0;

  // ── Daily spending allowance ───────────────────────────────────────────────
  // "How much can I spend a day" = flexible money left this month ÷ days left.
  // Flexible = the Discretionary category (day-to-day money); if none is defined,
  // fall back to every non-Savings budget item. Uses per-category Actual Spend.
  const daysInMo      = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth    = now.getDate();
  const daysLeftIncl  = Math.max(1, daysInMo - dayOfMonth + 1); // include today
  const discItems     = expenses.filter(e => (e['Expense'] || '') === 'Discretionary' && pm(e['Monthly Allowance ($)']) > 0);
  const flexItems     = discItems.length
    ? discItems
    : expenses.filter(e => (e['Expense'] || '') !== 'Savings' && pm(e['Monthly Allowance ($)']) > 0);
  const flexBudget    = flexItems.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);
  const flexSpent     = flexItems.reduce((s, e) => s + pm(e['Actual Spend']), 0);
  const flexLeft      = flexBudget - flexSpent;
  const perDay        = daysLeftIncl > 0 ? Math.max(0, flexLeft) / daysLeftIncl : 0;
  const flexLabel     = discItems.length ? 'discretionary' : 'flexible';
  const flexOver      = flexLeft < 0;
  const fullMonthPerDay = daysInMo > 0 ? flexBudget / daysInMo : 0;

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
      // Parse a raw date cell (serial number OR M/D/YYYY string) into a JS Date.
      const parseStmtDate = raw => {
        const ds = String(raw ?? '');
        const n = Number(ds);
        if (!isNaN(n) && n > 1000 && !ds.includes('/')) {
          return new Date(Math.round((n - 25569) * 86400000));
        }
        return new Date(ds);
      };
      // Format a date as M/D/YYYY for display.
      const fmtDate = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
      const txns = data
        .filter(r => r[0])
        .filter(r => {
          const d = parseStmtDate(r[0]);
          if (!d || isNaN(d.getTime())) return false;
          return d.getMonth() + 1 === mo && d.getFullYear() === yr;
        })
        .map(r => {
          const d = parseStmtDate(r[0]);
          return {
            date: fmtDate(d), type: r[1] || '',
            amount: parseAmt(r[2]),
            desc: r[3] || '', account: r[4] || '',
            done: r[5] === 'TRUE' || r[5] === true,
          };
        })
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

  function getNextPayday(config) {
    if (!config?.schedule || !config?.startDate) return null;
    const start = new Date(config.startDate + 'T12:00:00');
    if (isNaN(start.getTime())) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    if (config.schedule === 'monthly') {
      const d = new Date(today.getFullYear(), today.getMonth(), start.getDate());
      if (d <= today) d.setMonth(d.getMonth() + 1);
      return d;
    }
    if (config.schedule === 'semimonthly') {
      const day1 = start.getDate() <= 15 ? start.getDate() : 1;
      const day2 = day1 + 14 <= 28 ? day1 + 14 : 15;
      const opts = [
        new Date(today.getFullYear(), today.getMonth(), day1),
        new Date(today.getFullYear(), today.getMonth(), day2),
        new Date(today.getFullYear(), today.getMonth() + 1, day1),
      ].filter(d => d > today).sort((a,b) => a-b);
      return opts[0] || null;
    }
    // biweekly
    const elapsed = Math.floor((today - start) / 86400000);
    const rem = 14 - (elapsed % 14);
    const d = new Date(today); d.setDate(d.getDate() + (rem === 14 ? 0 : rem));
    return d > today ? d : new Date(today.getTime() + rem * 86400000);
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

    // Month note for the statement's month (works for both current & closed months).
    let stmtNote = '';
    try {
      const noteKey = `${currentYear}-${MONTHS.indexOf(currentMonth) + 1}`;
      stmtNote = JSON.parse(localStorage.getItem('_fin_month_notes') || '{}')[noteKey] || '';
    } catch {}

    // Top 5 spending categories (negative-amount rows only — never income/deposits).
    const topExpenses = Object.entries(catMap)
      .map(([type, v]) => ({ type, spend: v.spend }))
      .filter(e => e.spend > 0)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 5);

    const healthLine = healthScore.loaded ? `${Math.round(healthScore.total)}/100` : '';

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
  .note-callout { background: #f7f5ef; border-left: 3px solid #b8860b; border-radius: 4px; padding: 9px 12px; margin-bottom: 18px; font-size: 10pt; font-style: italic; color: #4a4530; }
  .note-callout .nl { font-style: normal; font-weight: bold; text-transform: uppercase; letter-spacing: 0.06em; font-size: 8pt; color: #8a7a3a; margin-right: 6px; }
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
    ${healthLine ? `<div>Health Score · <strong>${healthLine}</strong></div>` : ''}
  </div>
</div>
${stmtNote ? `<div class="note-callout"><span class="nl">Note</span>${esc(stmtNote)}</div>` : ''}

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

${topExpenses.length ? `
<div class="section-title">Top Expenses</div>
<table>
  <thead><tr><th style="width:40px">#</th><th>Category</th><th class="amt">Spent</th><th class="amt">Share of spend</th></tr></thead>
  <tbody>
    ${topExpenses.map((e, i) => `
      <tr>
        <td style="color:#888">${i + 1}</td>
        <td>${esc(e.type)}</td>
        <td class="amt neg">${fmtAmt(e.spend)}</td>
        <td class="amt" style="color:#666">${spent > 0 ? ((e.spend / spent) * 100).toFixed(0) : '0'}%</td>
      </tr>
    `).join('')}
  </tbody>
</table>
` : ''}

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

  // Plain-text rendering of the same statement for pasting into email/notes/chat.
  // Presentation-only: reads already-loaded data, writes nothing back to the sheet.
  async function copyStatementText(current, stmtTxns, expenses, currentMonth, currentYear) {
    const f = n => (n == null || isNaN(n)) ? '—' : (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
    const income = stmtTxns.reduce((s, t) => t.amount > 0 ? s + t.amount : s, 0) || pm(current?.['Total Processed Income']);
    const spent  = stmtTxns.reduce((s, t) => t.amount < 0 ? s + Math.abs(t.amount) : s, 0) || pm(current?.['Total Spent']);
    const goal   = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0) || pm(current?.['Allowance Goal']);
    const net    = income - spent;

    const catMap = {};
    stmtTxns.forEach(t => {
      if (!catMap[t.type]) catMap[t.type] = { spend: 0 };
      if (t.amount < 0) catMap[t.type].spend += Math.abs(t.amount);
    });
    const topExpenses = Object.entries(catMap)
      .map(([type, v]) => ({ type, spend: v.spend }))
      .filter(e => e.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 5);

    let stmtNote = '';
    try {
      const noteKey = `${currentYear}-${MONTHS.indexOf(currentMonth) + 1}`;
      stmtNote = JSON.parse(localStorage.getItem('_fin_month_notes') || '{}')[noteKey] || '';
    } catch {}

    const L = [];
    L.push(`MONTHLY FINANCE STATEMENT — ${currentMonth} ${currentYear}`);
    L.push(`Generated ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}`);
    if (stmtNote) L.push(`Note: ${stmtNote}`);
    L.push('');
    L.push('SUMMARY');
    L.push(`  Income     ${f(income)}`);
    L.push(`  Spent      ${f(spent)}`);
    L.push(`  Net Saved  ${f(net)}`);
    L.push(`  Goal       ${f(goal)}`);
    if (healthScore.loaded) L.push(`  Health     ${Math.round(healthScore.total)}/100`);
    if (topExpenses.length) {
      L.push('');
      L.push('TOP EXPENSES');
      topExpenses.forEach((e, i) => L.push(`  ${i + 1}. ${e.type} — ${f(e.spend)}` + (spent > 0 ? ` (${((e.spend / spent) * 100).toFixed(0)}%)` : '')));
    }
    if (stmtTxns.length) {
      L.push('');
      L.push(`TRANSACTIONS (${stmtTxns.length})`);
      stmtTxns.forEach(t => L.push(`  ${t.date}  ${t.type}${t.desc ? ' · ' + t.desc : ''}  ${f(t.amount)}`));
      L.push(`  Total: ${f(stmtTxns.reduce((s, t) => s + t.amount, 0))}`);
    }
    const text = L.join('\n');

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers without clipboard API / insecure context.
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    setStmtCopied(true);
    setTimeout(() => setStmtCopied(false), 2000);
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
        // Treat the month as closed if the boolean flag is set OR an archived
        // statement exists for it — every close path writes both, so checking
        // the archive too keeps the banner from lingering after a completed close.
        const archived = (() => {
          try { return !!JSON.parse(localStorage.getItem('_fin_statements') || '{}')[`${closeMonth} ${closeYear}`]; }
          catch { return false; }
        })();
        const alreadyClosed = localStorage.getItem(`closed_${closeMonth}_${closeYear}`) === 'true' || archived;
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

      {/* ── Safe-to-Spend Today (Task 44) ───────────────────── */}
      {expenses.length > 0 && income > 0 && (
        <SafeToSpendCard
          income={income}
          spent={spent}
          expenses={expenses}
          allAllocTx={allAllocTx}
          daysLeftIncl={daysLeftIncl}
          expanded={safeExpanded}
          onToggle={() => setSafeExpanded(v => !v)}
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

      {/* ── Recurring Income Forecast (Task 16) ─────────────── */}
      {chartData.length >= 2 && (
        <ForecastCard
          chartData={chartData}
          subscriptions={subscriptions}
          expenses={expenses}
          expanded={forecastExpanded}
          onToggle={() => setForecastExpanded(v => !v)}
        />
      )}

      {/* ── Emergency Fund / Runway Tracker (Task 35) ───────── */}
      {expenses.length > 0 && allAllocTx.length > 0 && (
        <EmergencyFundCard
          expenses={expenses}
          allAllocTx={allAllocTx}
          expanded={efExpanded}
          onToggle={() => setEfExpanded(v => !v)}
        />
      )}

      {/* ── Spending Anomaly Detection (Task 40) ────────────── */}
      {allAllocTx.length > 0 && (
        <AnomalyCard
          allAllocTx={allAllocTx}
          expanded={anomalyExpanded}
          onToggle={() => setAnomalyExpanded(v => !v)}
        />
      )}

      {/* ── Savings-Rate Trend & 50/30/20 Check (Task 42) ───── */}
      {allAllocTx.length > 0 && expenses.length > 0 && (
        <BudgetMixCard
          allAllocTx={allAllocTx}
          expenses={expenses}
          expanded={mixExpanded}
          onToggle={() => setMixExpanded(v => !v)}
        />
      )}

      {/* ── Every Dollar Assigned / Zero-Based Check (Task 47) ─ */}
      {expenses.length > 0 && income > 0 && (
        <EveryDollarCard
          income={income}
          expenses={expenses}
          allAllocTx={allAllocTx}
          expanded={envelopeExpanded}
          onToggle={() => setEnvelopeExpanded(v => !v)}
        />
      )}

      {/* ── Spending Calendar Heatmap (Task 24) ─────────────── */}
      {allAllocTx.length > 0 && (
        <SpendingCalendarCard
          allAllocTx={allAllocTx}
          expanded={heatmapExpanded}
          onToggle={() => setHeatmapExpanded(v => !v)}
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

      {/* ── Quick-Actions Strip (Task 29) ─────────────────── */}
      {(() => {
        const ALL_QA = [
          { id: 'income', label: 'Process Income', icon: '💰' },
          { id: 'log',    label: 'Log Transaction', icon: '📝' },
          { id: 'month',  label: 'This Month',      icon: '📊' },
          { id: 'cal',    label: 'Bill Calendar',   icon: '📅' },
        ];
        const saveQA = (next) => {
          setQaActions(next);
          localStorage.setItem('_fin_quickactions', JSON.stringify(next));
        };
        const moveUp = (i) => { if (i === 0) return; const a = [...qaActions]; [a[i-1], a[i]] = [a[i], a[i-1]]; saveQA(a); };
        const moveDown = (i) => { if (i === qaActions.length - 1) return; const a = [...qaActions]; [a[i], a[i+1]] = [a[i+1], a[i]]; saveQA(a); };
        const remove = (id) => saveQA(qaActions.filter(x => x !== id));
        const add = (id) => saveQA([...qaActions, id]);
        const hidden = ALL_QA.filter(a => !qaActions.includes(a.id));
        return (
          <>
            <div className="flex items-center gap-2 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
              {qaActions.map((id, i) => {
                const def = ALL_QA.find(a => a.id === id);
                if (!def) return null;
                const handleClick = () => {
                  if (showQAEdit) return;
                  if (id === 'income') setShowIncome(true);
                  else if (id === 'log') navigate('/transactions');
                  else if (id === 'month') reportLinks[currentMonth] && navigate(`/month/${reportLinks[currentMonth]}/${currentMonth}`);
                  else if (id === 'cal') billCalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                };
                return (
                  <div key={id} className="relative flex-none flex items-center gap-1 group">
                    {showQAEdit && (
                      <div className="flex flex-col gap-0.5">
                        <button onClick={() => moveUp(i)} disabled={i === 0}
                          className="text-slate-500 hover:text-slate-300 disabled:opacity-30 leading-none text-[10px]">▲</button>
                        <button onClick={() => moveDown(i)} disabled={i === qaActions.length - 1}
                          className="text-slate-500 hover:text-slate-300 disabled:opacity-30 leading-none text-[10px]">▼</button>
                      </div>
                    )}
                    <button
                      onClick={handleClick}
                      className={`flex items-center gap-1.5 text-white text-sm px-3 py-2 rounded-xl transition-colors whitespace-nowrap font-medium
                        ${showQAEdit ? 'bg-slate-700 cursor-default' : 'bg-slate-800 hover:bg-slate-700 active:bg-slate-600'}`}
                    >
                      <span>{def.icon}</span>
                      <span>{def.label}</span>
                      {id === 'income' && hasCurrentMonthAllocRows === false && !showQAEdit && (
                        <span className="w-2 h-2 rounded-full bg-teal-400 shrink-0" />
                      )}
                    </button>
                    {showQAEdit && (
                      <button onClick={() => remove(id)}
                        className="w-5 h-5 rounded-full bg-rose-700 hover:bg-rose-600 text-white flex items-center justify-center text-[10px] leading-none -ml-1">✕</button>
                    )}
                  </div>
                );
              })}
              {showQAEdit && hidden.map(a => (
                <button key={a.id} onClick={() => add(a.id)}
                  className="flex-none flex items-center gap-1.5 text-slate-400 hover:text-white text-sm px-3 py-2 rounded-xl border border-dashed border-slate-600 hover:border-slate-400 transition-colors whitespace-nowrap">
                  <span>{a.icon}</span>
                  <span>+ {a.label}</span>
                </button>
              ))}
              <button onClick={() => setShowQAEdit(v => !v)}
                title={showQAEdit ? 'Done' : 'Customize actions'}
                className={`flex-none text-sm px-2 py-2 rounded-xl transition-colors ${showQAEdit ? 'bg-blue-600 hover:bg-blue-500 text-white px-3' : 'text-slate-500 hover:text-slate-300'}`}>
                {showQAEdit ? 'Done' : '⚙'}
              </button>
            </div>
          </>
        );
      })()}

      {/* ── Payday Tracker chip (Task 20) ──────────────────── */}
      {paydayConfig && (() => {
        const nextPay = getNextPayday(paydayConfig);
        if (!nextPay) return null;
        const today = new Date(); today.setHours(0,0,0,0);
        const diff = Math.round((nextPay - today) / 86400000);
        const chipColor = diff <= 2 ? 'bg-rose-900/40 border-rose-700/40 text-rose-300'
          : diff <= 6 ? 'bg-amber-900/40 border-amber-700/40 text-amber-300'
          : 'bg-slate-800 border-slate-700/40 text-teal-300';
        const label = diff === 0 ? 'Payday today! 🎉'
          : diff === 1 ? 'Payday tomorrow 💰'
          : `Payday in ${diff} days 💰`;
        const now2 = new Date();
        const daysInMonth = new Date(now2.getFullYear(), now2.getMonth() + 1, 0).getDate();
        const daysPassed = now2.getDate();
        const timePct = Math.round((daysPassed / daysInMonth) * 100);
        const spent = allocTotals.spent || 0;
        const goal = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0) || 1;
        const spendPct = Math.round((spent / goal) * 100);
        const paceWarn = spendPct > timePct + 15;
        return (
          <button onClick={() => setShowPaydayConfig(true)}
            className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-colors ${chipColor}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{label}</span>
              {paceWarn && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-700/40 text-amber-300 shrink-0">
                  ⚠ {spendPct}% spent / {timePct}% elapsed
                </span>
              )}
            </div>
            <span className="text-slate-500 text-xs shrink-0">⚙</span>
          </button>
        );
      })()}

      {!paydayConfig && (
        <button onClick={() => setShowPaydayConfig(true)}
          className="w-full flex items-center gap-2 px-4 py-2 rounded-xl border border-dashed border-slate-700/50 text-slate-600 hover:text-slate-400 text-xs transition-colors">
          <span>💰</span><span>Set up payday tracker</span>
        </button>
      )}

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
      <div ref={billCalRef} />
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
          <div className="bg-slate-800 rounded-2xl p-2 space-y-1.5">
            {/* Calendar header */}
            <div className="flex items-center justify-between">
              <button onClick={() => setCalMonth(prev => {
                let nm = prev.m - 1, ny = prev.y;
                if (nm < 0) { nm = 11; ny--; }
                return { y: ny, m: nm };
              })} className="w-6 h-6 rounded-lg bg-slate-700 text-slate-300 flex items-center justify-center text-xs hover:bg-slate-600 transition-colors">‹</button>
              <p className="text-white text-xs font-semibold">{MONTH_NAMES[m]} {y}</p>
              <button onClick={() => setCalMonth(prev => {
                let nm = prev.m + 1, ny = prev.y;
                if (nm > 11) { nm = 0; ny++; }
                return { y: ny, m: nm };
              })} className="w-6 h-6 rounded-lg bg-slate-700 text-slate-300 flex items-center justify-center text-xs hover:bg-slate-600 transition-colors">›</button>
            </div>

            {/* Day labels */}
            <div className="grid grid-cols-7 gap-0">
              {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
                <div key={d} className="text-center text-[8px] text-slate-600 uppercase tracking-wider">{d}</div>
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
                    className={`rounded p-px flex flex-col items-center ${events.length ? 'cursor-pointer' : ''} ${isSelected ? 'bg-teal-700/60 ring-1 ring-teal-400' : isToday ? 'bg-slate-600' : events.length ? 'bg-teal-900/30' : ''}`}
                  >
                    <span className={`text-[10px] font-medium leading-tight ${isToday && !isSelected ? 'text-white font-bold' : isSelected ? 'text-teal-200 font-bold' : events.length ? 'text-teal-300' : 'text-slate-500'}`}>{d}</span>
                    {events.length > 0 && (
                      <span className="w-1 h-1 rounded-full bg-teal-400 inline-block mt-px" />
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

      {/* ── Safe to Spend / Day ─────────────────────────────── */}
      {flexBudget > 0 && (
        <div className={`rounded-2xl p-4 border ${flexOver
          ? 'bg-rose-950/40 border-rose-800/50'
          : 'bg-gradient-to-br from-emerald-950/50 to-slate-800 border-emerald-800/40'}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-emerald-300/90 text-[11px] font-bold uppercase tracking-wider">💸 Safe to spend / day</p>
              <p className={`text-3xl font-black font-broske mt-1 tabular-nums ${flexOver ? 'text-rose-400' : 'text-emerald-400'}`}>
                {flexOver ? '$0.00' : fmt(perDay)}
                {!flexOver && <span className="text-slate-500 text-sm font-bold"> /day</span>}
              </p>
              <p className="text-slate-400 text-xs mt-1.5">
                {flexOver ? (
                  <>You're <span className="text-rose-400 font-semibold">{fmt(Math.abs(flexLeft))} over</span> your {flexLabel} budget this month</>
                ) : (
                  <><span className="text-slate-200 font-semibold">{fmt(flexLeft)}</span> {flexLabel} left ÷ <span className="text-slate-200 font-semibold">{daysLeftIncl}</span> {daysLeftIncl === 1 ? 'day' : 'days'} left</>
                )}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Day</p>
              <p className="text-white font-bold font-mono text-sm">{dayOfMonth}<span className="text-slate-600">/{daysInMo}</span></p>
              {!flexOver && fullMonthPerDay > 0 && (
                <p className="text-slate-600 text-[10px] mt-1.5 leading-tight">
                  pace<br /><span className="text-slate-400 font-mono">{fmt(fullMonthPerDay)}/day</span>
                </p>
              )}
            </div>
          </div>
          {/* Month progress bar — how far through the budget the days are */}
          <div className="mt-3 w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-1.5 rounded-full transition-all"
              style={{ width: `${(dayOfMonth / daysInMo) * 100}%`, background: flexOver ? '#ef4444' : '#10b981' }} />
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
        const _subsExpenses = expenses; // explicit capture prevents minifier closure issues
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
          const [sortByCost, setSortByCost]         = useState(false);
          const [calWindow, setCalWindow]           = useState(30); // 30 or 90 days
          const [showInsights, setShowInsights]     = useState(false); // Task 13: cost-optimization insights panel
          const [subTotalHist, setSubTotalHist]     = useState(getSubTotalHistory);

          // Task 13(d) — snapshot this month's total monthly subscription cost
          // so the MoM trend can show whether subscription spend is growing.
          useEffect(() => {
            if (!subs.length) return;
            const totalMo = subs.reduce((s, sub) => s + toMonthly(sub['Amount'], sub['Cycle']), 0);
            setSubTotalHist(recordSubTotal(totalMo));
          }, [subs]);

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
          const candidates = _subsExpenses
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

                    {/* Task 13: Upcoming renewals in calWindow + Sort + window toggle */}
                    {subs.length > 0 && (() => {
                      const upcomingWin = subs
                        .map(s => ({ ...s, next: nextRenewal(s['Start Date'], (s['Cycle']||'monthly').toLowerCase()) }))
                        .filter(s => s.next)
                        .map(s => ({ ...s, daysLeft: daysUntil(s.next) }))
                        .filter(s => s.daysLeft !== null && s.daysLeft >= 0 && s.daysLeft <= calWindow)
                        .sort((a,b) => a.daysLeft - b.daysLeft);
                      if (!upcomingWin.length) return null;
                      return (
                        <div className="bg-slate-900 rounded-2xl p-3 space-y-1.5">
                          <p className="text-slate-500 text-xs font-semibold uppercase tracking-wider">Renewing in {calWindow} days</p>
                          {upcomingWin.map((s, i) => {
                            const mo = toMonthly(parseFloat(s['Amount']||0), s['Cycle']||'monthly');
                            return (
                              <div key={i} className="flex justify-between items-center text-xs">
                                <span className={`font-medium ${s.daysLeft <= 3 ? 'text-amber-300' : 'text-slate-300'}`}>{s['Name']}</span>
                                <div className="flex items-center gap-2">
                                  <span className="text-slate-500 font-mono">${mo.toFixed(2)}/mo</span>
                                  <span className={`px-1.5 py-0.5 rounded-full font-bold ${s.daysLeft === 0 ? 'bg-rose-900/60 text-rose-300' : s.daysLeft <= 3 ? 'bg-amber-900/60 text-amber-300' : 'bg-slate-800 text-slate-400'}`}>
                                    {s.daysLeft === 0 ? 'today' : `${s.daysLeft}d`}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

                    {subs.length > 0 && (
                      <div className="flex items-center gap-2 px-1">
                        <button onClick={() => setSortByCost(v => !v)}
                          className={`text-xs px-2.5 py-1 rounded-full transition-colors ${sortByCost ? 'bg-teal-700/50 text-teal-300' : 'bg-slate-800 text-slate-500 hover:text-slate-300'}`}>
                          {sortByCost ? '💲 By cost ✓' : 'Sort by cost'}
                        </button>
                        <button onClick={() => setCalWindow(w => w === 30 ? 90 : 30)}
                          className="text-xs px-2.5 py-1 rounded-full bg-slate-800 text-slate-500 hover:text-slate-300 transition-colors ml-auto">
                          📅 {calWindow}d window
                        </button>
                      </div>
                    )}

                    {/* Total monthly + annual cost across all subs + MoM trend (Task 13d) */}
                    {subs.length > 0 && (() => {
                      const totalMo = subs.reduce((s, sub) => s + toMonthly(sub['Amount'], sub['Cycle']), 0);
                      // Prior month's recorded total (most recent snapshot before the current month)
                      const now = new Date();
                      const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                      const months = Object.keys(subTotalHist).sort();
                      const prevKeys = months.filter(k => k < curKey);
                      const prevTotal = prevKeys.length ? subTotalHist[prevKeys[prevKeys.length - 1]] : null;
                      const delta = prevTotal != null ? totalMo - prevTotal : null;
                      // Tiny sparkline of the last few recorded months (incl. current)
                      const spark = months.map(k => subTotalHist[k]).slice(-6);
                      const sparkMax = Math.max(...spark, totalMo, 0.01);
                      return (
                        <div className="px-1 space-y-1.5">
                          <div className="flex justify-between items-center text-xs">
                            <span className="text-slate-500">Total / month</span>
                            <div className="flex items-center gap-3">
                              <span className="text-slate-600 font-mono tabular-nums">${(totalMo * 12).toFixed(2)}/yr</span>
                              <span className="text-teal-300 font-bold font-mono tabular-nums">${totalMo.toFixed(2)}/mo</span>
                            </div>
                          </div>
                          {delta != null && Math.abs(delta) >= 0.01 && (
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-slate-600">vs last month</span>
                              <span className={`font-mono tabular-nums font-semibold ${delta > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                {delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)}/mo
                              </span>
                            </div>
                          )}
                          {spark.length >= 2 && (
                            <div className="flex items-end gap-0.5 h-6 pt-0.5">
                              {spark.map((v, i) => (
                                <div key={i} className="flex-1 bg-teal-700/60 rounded-sm"
                                  style={{ height: `${Math.max(8, (v / sparkMax) * 100)}%` }}
                                  title={`$${v.toFixed(2)}/mo`} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Task 13 (Q1) — trim tip: smallest active subscription is the easiest cut */}
                    {subs.filter(s => parseFloat(s['Amount'] || 0) > 0).length >= 2 && (() => {
                      const priced = subs
                        .map(s => ({ s, mo: toMonthly(s['Amount'], s['Cycle']) }))
                        .filter(x => x.mo > 0)
                        .sort((a, b) => a.mo - b.mo);
                      const cheapest = priced[0];
                      if (!cheapest) return null;
                      return (
                        <div className="bg-amber-900/20 border border-amber-800/40 rounded-2xl px-3 py-2.5 flex items-start gap-2">
                          <span className="text-base leading-none mt-0.5">💡</span>
                          <p className="text-amber-200/90 text-xs leading-snug">
                            <span className="font-semibold">Quick trim:</span> cancelling your smallest subscription{' '}
                            <span className="font-semibold">{cheapest.s['Name']}</span> (${cheapest.mo.toFixed(2)}/mo) would save{' '}
                            <span className="font-bold font-mono">${(cheapest.mo * 12).toFixed(2)}/yr</span>.
                          </p>
                        </div>
                      );
                    })()}

                    {/* ── Cost Optimization Insights (Task 13) — collapsible, read-only ── */}
                    {subs.length > 0 && (() => {
                      const withCost = subs
                        .map(s => ({ name: s['Name'] || '—', cycle: (s['Cycle'] || 'monthly').toLowerCase(), mo: toMonthly(s['Amount'], s['Cycle']) }))
                        .filter(s => s.mo > 0)
                        .sort((a, b) => b.mo - a.mo);
                      const totalMo = withCost.reduce((t, s) => t + s.mo, 0);
                      if (withCost.length < 1 || totalMo <= 0) return null;
                      const top       = withCost[0];
                      const pctIncome = income > 0 ? (totalMo / income) * 100 : null;
                      const cycleMix  = {};
                      withCost.forEach(s => { cycleMix[s.cycle] = (cycleMix[s.cycle] || 0) + s.mo; });
                      const now = new Date(); now.setHours(0, 0, 0, 0);
                      const recent = subs
                        .map(s => { const sd = s['Start Date'] ? new Date(s['Start Date'] + 'T12:00:00') : null; return { s, sd }; })
                        .filter(({ sd }) => sd && !isNaN(sd) && (now - sd) / 86400000 >= 0 && (now - sd) / 86400000 <= calWindow);
                      const recentMo = recent.reduce((t, { s }) => t + toMonthly(s['Amount'], s['Cycle']), 0);
                      const ranked    = withCost.slice(0, 6);
                      const moreCount = withCost.length - ranked.length;
                      return (
                        <div className="bg-slate-900 rounded-2xl overflow-hidden">
                          <button onClick={() => setShowInsights(v => !v)} className="w-full flex items-center justify-between px-3 py-2.5">
                            <span className="text-slate-300 text-xs font-semibold uppercase tracking-wider">💡 Cost insights</span>
                            <span className="text-slate-500 text-xs">{showInsights ? '▲' : '▼'}</span>
                          </button>
                          {showInsights && (
                            <div className="px-3 pb-3 space-y-3">
                              {/* Annual headline */}
                              <div className="bg-slate-800/60 rounded-xl p-3">
                                <p className="text-2xl font-bold text-white font-mono tabular-nums">
                                  ${(totalMo * 12).toFixed(0)}<span className="text-sm text-slate-500 font-sans font-normal"> /yr</span>
                                </p>
                                <p className="text-slate-400 text-xs mt-0.5">
                                  across {withCost.length} subscription{withCost.length !== 1 ? 's' : ''}
                                  {pctIncome !== null && <> · <span className={pctIncome > 15 ? 'text-amber-300' : 'text-slate-400'}>{pctIncome.toFixed(0)}% of monthly income</span></>}
                                </p>
                              </div>
                              {/* Cost ranking bars — where the money goes */}
                              <div className="space-y-1.5">
                                <p className="text-slate-500 text-[10px] uppercase tracking-wider">Where it goes</p>
                                {ranked.map((s, i) => {
                                  const share = (s.mo / totalMo) * 100;
                                  return (
                                    <div key={i} className="space-y-0.5">
                                      <div className="flex justify-between text-xs">
                                        <span className="text-slate-300 truncate pr-2">{s.name}</span>
                                        <span className="text-slate-400 font-mono tabular-nums shrink-0">${(s.mo * 12).toFixed(0)}/yr · {share.toFixed(0)}%</span>
                                      </div>
                                      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full bg-gradient-to-r from-teal-600 to-teal-400" style={{ width: `${Math.max(3, share)}%` }} />
                                      </div>
                                    </div>
                                  );
                                })}
                                {moreCount > 0 && <p className="text-slate-600 text-[10px]">+{moreCount} smaller</p>}
                              </div>
                              {/* Optimization nudge — biggest lever first */}
                              <div className="bg-amber-950/30 border border-amber-900/40 rounded-xl p-3">
                                <p className="text-amber-200 text-xs leading-relaxed">
                                  💸 Your priciest is <span className="font-semibold">{top.name}</span> at <span className="font-mono">${(top.mo * 12).toFixed(0)}/yr</span> ({((top.mo / totalMo) * 100).toFixed(0)}% of subs). Cancelling it would save <span className="font-mono">${(top.mo * 12).toFixed(0)}/yr</span>.
                                </p>
                              </div>
                              {/* Cycle mix */}
                              <div className="flex flex-wrap gap-1.5">
                                {Object.entries(cycleMix).sort((a, b) => b[1] - a[1]).map(([cy, mo]) => (
                                  <span key={cy} className="text-[10px] px-2 py-1 rounded-full bg-slate-800 text-slate-400 capitalize">
                                    {cy}: <span className="font-mono text-slate-300">${mo.toFixed(0)}/mo</span>
                                  </span>
                                ))}
                              </div>
                              {/* Recently added — lightweight trend signal from Start Dates */}
                              {recent.length > 0 && (
                                <p className="text-teal-400/80 text-[11px]">
                                  🆕 {recent.length} added in the last {calWindow}d (+${recentMo.toFixed(2)}/mo)
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {(sortByCost ? [...subs].sort((a,b) => toMonthly(b['Amount'], b['Cycle']) - toMonthly(a['Amount'], a['Cycle'])) : subs).map((s, i) => {
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
                                    <span className="text-slate-600 font-mono text-[10px] tabular-nums">${(moAmt * 12).toFixed(2)}/yr</span>
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
        // Prefer the close month's real allocation activity (ground truth, matching the
        // Dashboard tiles + auto-archive) and fall back to Monthly Summary only when no
        // rows were logged for that month — so income/actuals don't read $0 by mistake.
        const closeIncome     = closeAlloc.hasRows && closeAlloc.income > 0 ? closeAlloc.income : pm(closeMonthRow?.['Total Processed Income']);
        const closeSpent      = closeAlloc.hasRows && closeAlloc.spent  > 0 ? closeAlloc.spent  : pm(closeMonthRow?.['Total Spent']);
        const closeNet        = closeIncome - closeSpent;
        const coveragePct     = totalAllowance > 0 ? (closeIncome / totalAllowance) * 100 : 0;
        // Use allocation-derived per-category amounts when the Actual Spend column is empty.
        const actualColTotal  = expenses.reduce((s, e) => s + pm(e['Actual Spend']), 0);
        const useAllocActual  = actualColTotal <= 0 && closeAlloc.hasRows;
        const priGroups = ['1','2','3'].map(p => {
          const items = expenses.filter(e => String(e['Priority'] ?? '3') === p && pm(e['Monthly Allowance ($)']) > 0);
          return {
            p, label: { '1':'Essential','2':'Stability','3':'Optional' }[p],
            budget: items.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0),
            spent:  useAllocActual
              ? items.reduce((s, e) => s + (closeAlloc.byType[e['Type']] || 0), 0)
              : items.reduce((s, e) => s + pm(e['Actual Spend']), 0),
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
                  const ci = closeAlloc.hasRows && closeAlloc.income > 0 ? closeAlloc.income : pm(closeMonthRow?.['Total Processed Income']);
                  const cs = closeAlloc.hasRows && closeAlloc.spent  > 0 ? closeAlloc.spent  : pm(closeMonthRow?.['Total Spent']);
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
          gasBudget={gasBudget}
          onClose={() => setShowIncome(false)}
          onProcessed={() => setRefreshKey(k => k + 1)}
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
                    onClick={() => copyStatementText(current, stmtTxns, expenses, currentMonth, currentYear)}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold px-3 py-2 rounded-xl transition-colors"
                  >
                    {stmtCopied ? '✓ Copied' : '📋 Copy text'}
                  </button>
                )}
                {!stmtLoading && !stmtError && (
                  <button
                    onClick={() => printStatement(current, stmtTxns, expenses, currentMonth, currentYear)}
                    className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors"
                  >
                    🖨 Save PDF
                  </button>
                )}
                {(stmtFromClose || (!localStorage.getItem(`closed_${closeMonth}_${closeYear}`) && now.getDate() <= 7)) && !stmtLoading && !stmtError && (
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
                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3 py-2 rounded-xl transition-colors"
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
                  barClr: { '1':'#f43f5e','2':'#f59e0b','3':'#8b5cf6' }[p],
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
                    {/* ── Empty-state hint when no income has been processed yet ── */}
                    {totalIncome === 0 && stmtTxns.length === 0 && (
                      <div className="bg-amber-900/25 border border-amber-700/40 rounded-2xl px-4 py-3 flex items-start gap-3">
                        <span className="text-amber-400 text-lg shrink-0">ℹ</span>
                        <div>
                          <p className="text-amber-200 text-sm font-semibold">No income processed yet for {currentMonth}</p>
                          <p className="text-amber-400/80 text-xs mt-0.5">Use "Process Income" on the dashboard to log your first deposit. Actuals will appear here once income is recorded.</p>
                        </div>
                      </div>
                    )}
                    {/* ── Summary ─────────────────────────────────── */}
                    <div>
                      <SectionLabel>Overview</SectionLabel>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {[
                          { label: 'Income',    val: totalIncome, color: 'text-emerald-400', sub: totalIncome === 0 ? 'no income yet' : goalAmt > 0 ? `${((totalIncome/goalAmt)*100).toFixed(0)}% of goal` : null },
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
                      const noActuals = bvaData.every(d => d.actual === 0);
                      return (
                        <div>
                          <SectionLabel>Budget vs Actual</SectionLabel>
                          {noActuals && (
                            <p className="text-slate-500 text-xs italic mb-3">Actuals reflect the "Actual Spend" column in your Monthly Expenses sheet — they will populate as spending is recorded this month.</p>
                          )}
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

                    {/* ── Close month CTA (shown whenever the previous month can still be closed) ── */}
                    {!stmtFromClose && !localStorage.getItem(`closed_${closeMonth}_${closeYear}`) && now.getDate() <= 7 && (
                      <div className="bg-indigo-900/30 border border-indigo-700/50 rounded-2xl p-5 space-y-3">
                        <div>
                          <p className="text-indigo-200 font-semibold text-sm">Ready to start {currentMonth} fresh?</p>
                          <p className="text-indigo-400 text-xs mt-0.5">Close out {closeMonth} and reset your budget for the new month.</p>
                        </div>
                        <button
                          onClick={() => {
                            const ci = stmtTxns.reduce((s, t) => t.amount > 0 ? s + t.amount : s, 0) || pm(current?.['Total Processed Income']);
                            const cs = stmtTxns.reduce((s, t) => t.amount < 0 ? s + Math.abs(t.amount) : s, 0) || pm(current?.['Total Spent']);
                            const cg = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);
                            saveStatementArchive(closeMonth, closeYear, ci, cs, cg, stmtTxns);
                            setShowStatement(false);
                            localStorage.setItem(`closed_${closeMonth}_${closeYear}`, 'true');
                          }}
                          className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm transition-colors"
                        >
                          ✓ Close {closeMonth} — Start {currentMonth} Fresh
                        </button>
                      </div>
                    )}
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
                      onClick={() => printStatement(
                        { 'Total Processed Income': e.income, 'Total Spent': e.spent, 'Allowance Goal': e.goal },
                        e.txns || [], [], e.month, e.year,
                      )}
                      className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors"
                    >🖨 Download PDF</button>
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

      {/* ── Payday Config modal (Task 20) ──────────────────── */}
      {showPaydayConfig && (() => {
        function PaydayConfigModal() {
          const [localCfg, setLocalCfg] = useState(() => paydayConfig || { schedule: 'biweekly', startDate: new Date().toISOString().slice(0,10) });
          function save() {
            setPaydayConfig(localCfg);
            localStorage.setItem('_fin_payday_config', JSON.stringify(localCfg));
            setShowPaydayConfig(false);
          }
          function clear() {
            setPaydayConfig(null);
            localStorage.removeItem('_fin_payday_config');
            setShowPaydayConfig(false);
          }
          const next = localCfg.startDate ? getNextPayday(localCfg) : null;
          const diff = next ? Math.round((next - new Date().setHours(0,0,0,0)) / 86400000) : null;
          return (
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end z-50" onClick={() => setShowPaydayConfig(false)}>
              <div className="bg-slate-900 w-full rounded-t-3xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                  <h2 className="text-white font-semibold">💰 Payday Settings</h2>
                  <button onClick={() => setShowPaydayConfig(false)} className="text-slate-400 hover:text-white text-xl">✕</button>
                </div>
                <div className="space-y-2">
                  <label className="text-slate-400 text-xs uppercase tracking-wider block">Pay Schedule</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[['biweekly','Bi-weekly'],['semimonthly','Semi-monthly'],['monthly','Monthly']].map(([val, lbl]) => (
                      <button key={val} onClick={() => setLocalCfg(c => ({...c, schedule: val}))}
                        className={`py-2 rounded-xl text-sm font-medium transition-colors ${localCfg.schedule === val ? 'bg-teal-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-slate-400 text-xs uppercase tracking-wider block">Most Recent Payday (anchor date)</label>
                  <input type="date" value={localCfg.startDate}
                    onChange={e => setLocalCfg(c => ({...c, startDate: e.target.value}))}
                    className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-teal-500 text-sm"
                  />
                </div>
                {next && diff !== null && (
                  <p className="text-teal-400 text-sm text-center">Next payday: {next.toLocaleDateString('en-US', {month:'short',day:'numeric'})} ({diff === 0 ? 'today' : `${diff} day${diff===1?'':'s'}`})</p>
                )}
                <div className="flex gap-2">
                  {paydayConfig && <button onClick={clear} className="text-rose-400 hover:text-rose-300 text-sm px-4 py-2">Clear</button>}
                  <button onClick={save} className="flex-1 bg-teal-600 hover:bg-teal-500 text-white py-3 rounded-xl font-bold transition-colors">Save</button>
                </div>
              </div>
            </div>
          );
        }
        return <PaydayConfigModal />;
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
