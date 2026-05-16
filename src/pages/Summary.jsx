import { useEffect, useState, useMemo } from 'react';
import { readRange } from '../lib/sheets';
import LoadingSpinner from '../components/LoadingSpinner';

// ─── helpers ────────────────────────────────────────────────────────────────

function pm(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/[$,\s%]/g, ''));
  return isNaN(n) ? null : n;
}
function fmt(n, dec = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `$${Number(n).toFixed(dec)}`;
}
function fmtN(n, dec = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toFixed(dec);
}
function fmtPct(n, mult = true) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${(mult ? Number(n) * 100 : Number(n)).toFixed(1)}%`;
}
function close(a, b, tol = 0.02) {
  if (a === null || b === null) return null;
  const bv = pm(b);
  if (bv === null) return null;
  if (bv === 0 && a === 0) return true;
  if (bv === 0) return null;
  return Math.abs((a - bv) / bv) <= tol;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

function extractSV(rows) {
  const v = {};
  const DEPOSIT_ACCOUNTS = ['Checking','Outside Payment','Cash','Savings','Business Tax','Subscription'];
  const CATEGORIES = ['Essentials','Discretionary','Savings','Stability','Subscription'];

  rows.forEach(row => {
    const cell = (i) => (row[i] !== undefined && row[i] !== null && row[i] !== '') ? row[i] : null;
    if (cell(0) && cell(1) !== null) v[String(row[0]).trim()] = row[1];
    if (cell(11) && cell(12) !== null) v[String(row[11]).trim()] = row[12];
    if (cell(14) && cell(15) !== null) v[String(row[14]).trim()] = row[15];
    const acct = cell(8) ? String(row[8]).trim() : '';
    if (DEPOSIT_ACCOUNTS.includes(acct) && cell(9) !== null) v[`dep_${acct}`] = row[9];
    if (CATEGORIES.includes(acct) && cell(9) !== null) {
      v[`cat_${acct}_amt`] = row[9];
      if (cell(10) !== null) v[`cat_${acct}_pct`] = row[10];
    }
  });
  return v;
}

// ─── Computation ─────────────────────────────────────────────────────────────

function computeAll(expenses, sv, allocRows) {
  const now = new Date();
  const today = now.getDate();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = dim - today;
  const daysInYear = Math.floor((new Date(now.getFullYear(), 11, 31) - now) / 86400000);
  const weeksInMo = Math.round((dim / 7) * 100) / 100;

  const totalAllowance = expenses.reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0);
  const pi = pm(sv['Processed Income for Month (PI)']) || 0;
  const ci = pm(sv['Claimable Income (CI)']) || 0;
  const ciDays = pm(sv['CI Days Applicable']) || 14;
  const hourlyWage = pm(sv['Hourly Wage']) || 17;
  const wagePct = pm(sv['% of Wage Earned']) || 0.9047;

  const adjHourly = hourlyWage * wagePct;
  const ciPlusPi = ci + pi;
  const ar = totalAllowance - pi;
  const weeklyReq = weeksInMo > 0 ? totalAllowance / weeksInMo : 0;
  const goalToCycle = totalAllowance > 0 ? pi / totalAllowance : 0;
  const avgPctDay = dim > 0 ? goalToCycle / dim : 0;
  const projectedEnd = goalToCycle + avgPctDay * daysLeft;

  const reqDay30 = totalAllowance / 30;
  const reqDayLeft = daysLeft > 0 ? ar / daysLeft : 0;
  const hoursLeft = adjHourly > 0 ? ar / adjHourly : 0;
  const hrsPerWeek = adjHourly > 0 ? weeklyReq / adjHourly : 0;
  const shiftsNeeded = Math.ceil(hrsPerWeek / 7);
  const moneyPerShift = 7 * adjHourly;

  const checkingAllowance = expenses
    .filter(e => e['Account'] === 'Checking')
    .reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0);
  const checkingDeposit = totalAllowance > 0 ? (checkingAllowance / totalAllowance) * ci : 0;
  const spendingDaily = ciDays > 0 ? checkingDeposit / ciDays : 0;

  const gasPerGal = pm(sv['Current Average $/gal']) || 4.09;
  const mpg = pm(sv['Average mpg']) || 23.5;
  const claimableGas = (() => {
    const gasRow = allocRows.find(r => r[0] === 'Gas');
    return gasRow ? (pm(gasRow[1]) || 0) : (pm(sv['Claimable Gas']) || 0);
  })();
  const gallonsLeft = gasPerGal > 0 ? claimableGas / gasPerGal : 0;
  const estMiles = gallonsLeft * mpg;
  const milesPerDay = daysLeft > 0 ? estMiles / daysLeft : 0;
  const qcPerDay = milesPerDay / 28.3;
  const totalQC = estMiles / 28.3;
  const budgetFor2QC = ((56.6 / mpg) * gasPerGal) * dim - claimableGas;

  const deposits = {};
  ['Checking','Outside Payment','Cash','Savings','Business Tax','Subscription'].forEach(acct => {
    deposits[acct] = expenses
      .filter(e => e['Account'] === acct)
      .reduce((s, e) => {
        const pct = totalAllowance > 0 ? (pm(e['Monthly Allowance ($)']) || 0) / totalAllowance : 0;
        return s + pct * ci;
      }, 0);
  });

  const priorities = { 1: 0, 2: 0, 3: 0 };
  expenses.forEach(e => {
    const p = parseInt(e['Priority']);
    if (p >= 1 && p <= 3) priorities[p] += pm(e['Monthly Allowance ($)']) || 0;
  });

  const cats = {};
  expenses.forEach(e => {
    const cat = e['Expense'] || 'Other';
    cats[cat] = (cats[cat] || 0) + (pm(e['Monthly Allowance ($)']) || 0);
  });

  return {
    now, today, dim, daysLeft, daysInYear, weeksInMo,
    totalAllowance, pi, ci, ciDays, adjHourly, hourlyWage, wagePct,
    ciPlusPi, ar, weeklyReq, goalToCycle, avgPctDay, projectedEnd,
    spendingDaily, reqDay30, reqDayLeft,
    hoursLeft, hrsPerWeek, shiftsNeeded, moneyPerShift,
    gasPerGal, mpg, claimableGas, gallonsLeft, estMiles,
    milesPerDay, qcPerDay, totalQC, budgetFor2QC,
    deposits, priorities, cats,
  };
}

// ─── UI atoms ────────────────────────────────────────────────────────────────

function MetricTile({ label, value, sub, detail, color = 'text-white', verify, wide }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`bg-slate-900 rounded-xl p-3 flex flex-col gap-0.5 ${wide ? 'col-span-2' : ''}`}>
      <div className="flex items-start justify-between gap-1">
        <p className="text-slate-500 text-[10px] uppercase tracking-widest leading-tight">{label}</p>
        {detail && (
          <button
            onClick={() => setOpen(v => !v)}
            className="text-slate-600 hover:text-blue-400 text-[10px] w-4 h-4 flex items-center justify-center shrink-0 transition-colors"
          >ℹ</button>
        )}
      </div>
      <div className="flex items-baseline gap-1.5">
        <p className={`text-xl font-bold font-mono tabular-nums tracking-tight ${color}`}>{value}</p>
        {verify !== undefined && (
          <span className={verify ? 'text-emerald-500 text-[10px]' : 'text-amber-400 text-[10px]'}>
            {verify ? '✓' : '⚠'}
          </span>
        )}
      </div>
      {sub && <p className="text-slate-600 text-[11px] leading-tight">{sub}</p>}
      {open && detail && (
        <p className="text-slate-400 text-[11px] leading-relaxed mt-1.5 pt-1.5 border-t border-slate-800">{detail}</p>
      )}
    </div>
  );
}

function SectionGrid({ children }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

function BarTile({ label, items, total }) {
  const COLORS = {
    Essentials: '#3b82f6', Discretionary: '#a855f7',
    Savings: '#10b981', Stability: '#f59e0b', Subscription: '#f43f5e',
  };
  return (
    <div className="bg-slate-900 rounded-xl p-3 col-span-2 space-y-2">
      <p className="text-slate-500 text-[10px] uppercase tracking-widest">{label}</p>
      {items.map(([cat, amt]) => {
        const pct = total > 0 ? (amt / total) * 100 : 0;
        return (
          <div key={cat} className="space-y-0.5">
            <div className="flex justify-between text-[11px]">
              <span className="text-slate-300">{cat}</span>
              <span className="font-mono text-white tabular-nums">{fmt(amt)} <span className="text-slate-600">({pct.toFixed(0)}%)</span></span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: COLORS[cat] || '#64748b' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProgressTile({ label, current, goal }) {
  const pct = goal > 0 ? Math.min((current / goal) * 100, 100) : 0;
  const color = pct >= 100 ? '#10b981' : pct >= 75 ? '#f59e0b' : '#3b82f6';
  return (
    <div className="bg-slate-900 rounded-xl p-3 col-span-2 space-y-2">
      <div className="flex justify-between items-baseline">
        <p className="text-slate-500 text-[10px] uppercase tracking-widest">{label}</p>
        <p className="text-slate-400 text-[11px] font-mono">{fmt(current)} <span className="text-slate-600">/ {fmt(goal)}</span></p>
      </div>
      <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
        <div className="h-2.5 rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
      <p className="text-right text-[11px] font-mono" style={{ color }}>{pct.toFixed(0)}%</p>
    </div>
  );
}

// ─── Insights ────────────────────────────────────────────────────────────────

function buildInsights(c) {
  if (!c.totalAllowance) return { good: [], watch: [] };
  const good = [];
  const watch = [];
  const covPct = c.pi / c.totalAllowance * 100;

  if (covPct >= 90) good.push(`${covPct.toFixed(0)}% of monthly goal met`);
  else if (covPct >= 60) watch.push(`${covPct.toFixed(0)}% of goal — ${fmt(c.ar)} remaining`);
  else watch.push(`Behind goal — only ${covPct.toFixed(0)}% covered, need ${fmt(c.ar)} more`);

  if (c.projectedEnd >= 1.0) good.push('On track to hit goal by month end');
  else watch.push(`Projected ${(c.projectedEnd * 100).toFixed(0)}% by end of month`);

  if (c.claimableGas >= 30) good.push(`${fmt(c.claimableGas)} in gas budget available`);
  else if (c.claimableGas < 15) watch.push('Gas budget running low');

  if (c.daysLeft <= 5 && c.ar > 0) watch.push(`Only ${c.daysLeft} days left — still need ${fmt(c.ar)}`);

  if (c.shiftsNeeded <= 3 && c.shiftsNeeded > 0) good.push(`${c.shiftsNeeded} shift${c.shiftsNeeded > 1 ? 's' : ''} needed to meet goal`);
  else if (c.shiftsNeeded >= 6) watch.push(`${c.shiftsNeeded} shifts still needed this month`);

  return { good, watch };
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview',  label: 'Overview'  },
  { id: 'work',      label: 'Work'      },
  { id: 'gas',       label: 'Gas'       },
  { id: 'accounts',  label: 'Accounts'  },
  { id: 'budget',    label: 'Budget'    },
];

// ─── Main ────────────────────────────────────────────────────────────────────

export default function Summary({ token }) {
  const [svRows, setSvRows]     = useState([]);
  const [expRows, setExpRows]   = useState([]);
  const [allocRows, setAllocRows] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [tab, setTab]           = useState('overview');

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([
      readRange(token, 'Expense Summary!A1:S60'),
      readRange(token, 'Monthly Expenses!A1:T40'),
      readRange(token, 'Allocation Summary!A1:B10'),
    ])
      .then(([sv, exp, alloc]) => { setSvRows(sv); setExpRows(exp); setAllocRows(alloc); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const sv = useMemo(() => extractSV(svRows), [svRows]);
  const expenses = useMemo(() => {
    if (!expRows.length) return [];
    const [headers, ...data] = expRows;
    return data.filter(r => r[0]).map(row =>
      headers.reduce((obj, h, i) => { obj[h] = row[i] ?? null; return obj; }, {})
    );
  }, [expRows]);
  const c = useMemo(() => computeAll(expenses, sv, allocRows), [expenses, sv, allocRows]);
  const insights = useMemo(() => buildInsights(c), [c]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <div className="p-4 text-red-400">Error: {error}</div>;

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  return (
    <div className="pb-24">

      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-white tracking-tight">Finance Summary</h1>
        <p className="text-slate-500 text-xs mt-0.5 font-mono">
          {MONTHS[c.now.getMonth()]} {c.now.getFullYear()} · Day {c.today}/{c.dim} · {c.daysLeft}d remaining
        </p>
      </div>

      {/* Insights */}
      {(insights.good.length > 0 || insights.watch.length > 0) && (
        <div className="px-4 pb-3 space-y-1.5">
          {insights.good.map((msg, i) => (
            <div key={i} className="flex items-center gap-2 bg-emerald-950/60 border border-emerald-800/40 rounded-lg px-3 py-2">
              <span className="text-emerald-400 text-xs">✓</span>
              <span className="text-emerald-300 text-xs">{msg}</span>
            </div>
          ))}
          {insights.watch.map((msg, i) => (
            <div key={i} className="flex items-center gap-2 bg-amber-950/50 border border-amber-800/40 rounded-lg px-3 py-2">
              <span className="text-amber-400 text-xs">⚠</span>
              <span className="text-amber-300 text-xs">{msg}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 px-4 pb-3 overflow-x-auto scrollbar-hide">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
              tab === t.id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="px-4 space-y-2">

        {/* ── Overview ── */}
        {tab === 'overview' && (
          <SectionGrid>
            <ProgressTile label="Monthly Goal Progress" current={c.pi} goal={c.totalAllowance} />
            <MetricTile
              label="Monthly Goal"
              value={fmt(c.totalAllowance)}
              detail="Sum of all Monthly Expenses allowances"
              verify={close(c.totalAllowance, sv['Monthly Goal'])}
            />
            <MetricTile
              label="Processed Income"
              value={fmt(c.pi)}
              sub="PI"
              detail="Paychecks + commissions received and processed"
            />
            <MetricTile
              label="Claimable Income"
              value={fmt(c.ci)}
              sub="CI"
              detail="Income available to allocate across accounts"
            />
            <MetricTile
              label="CI + PI"
              value={fmt(c.ciPlusPi)}
              detail="Claimable Income + Processed Income combined"
            />
            <MetricTile
              label="Still Required (AR)"
              value={fmt(c.ar)}
              color={c.ar > 0 ? 'text-amber-400' : 'text-emerald-400'}
              detail="Monthly Goal − Processed Income. How much more you need this month."
            />
            <MetricTile
              label="Coverage %"
              value={fmtPct(c.goalToCycle)}
              color={c.goalToCycle >= 1 ? 'text-emerald-400' : c.goalToCycle >= 0.75 ? 'text-amber-400' : 'text-rose-400'}
              detail="PI ÷ Monthly Goal"
              verify={close(c.goalToCycle, pm(sv['Goal to Cycle']) < 2 ? pm(sv['Goal to Cycle']) : null)}
            />
            <MetricTile
              label="Projected End %"
              value={fmtPct(c.projectedEnd)}
              color={c.projectedEnd >= 1 ? 'text-emerald-400' : 'text-amber-400'}
              detail="Current % + (avg daily % × days remaining)"
            />
          </SectionGrid>
        )}

        {/* ── Work ── */}
        {tab === 'work' && (
          <SectionGrid>
            <MetricTile
              label="Weekly Requirement"
              value={fmt(c.weeklyReq)}
              detail="Monthly Goal ÷ weeks in month"
              verify={close(c.weeklyReq, sv['Minimum Weekly Requirement'])}
              wide
            />
            <MetricTile
              label="Required / Day (÷30)"
              value={fmt(c.reqDay30)}
              detail="Monthly Goal ÷ 30"
              verify={close(c.reqDay30, sv['Required Earnings/day (30 days)'])}
            />
            <MetricTile
              label="Required / Day (left)"
              value={fmt(c.reqDayLeft)}
              color={c.reqDayLeft > c.adjHourly * 8 ? 'text-rose-400' : 'text-white'}
              detail="Amount Required (AR) ÷ days remaining in month"
              verify={close(c.reqDayLeft, sv['Required Earnings/day (remaining from AR)'])}
            />
            <MetricTile
              label="Hourly Wage"
              value={fmt(c.hourlyWage)}
              sub={`${(c.wagePct * 100).toFixed(2)}% after deductions`}
            />
            <MetricTile
              label="Adjusted / hr"
              value={fmt(c.adjHourly)}
              detail="Hourly Wage × % of Wage Earned"
              verify={close(c.adjHourly, sv['Adjusted Earning/hr'])}
            />
            <MetricTile
              label="Hours Left for Goal"
              value={`${fmtN(c.hoursLeft)} hrs`}
              color={c.hoursLeft > 40 ? 'text-rose-400' : 'text-white'}
              detail="AR ÷ Adjusted Earning/hr"
            />
            <MetricTile
              label="Hours / Week Needed"
              value={`${fmtN(c.hrsPerWeek)} hrs`}
              detail="Weekly Requirement ÷ Adjusted Earning/hr"
            />
            <MetricTile
              label="7-hr Shifts Needed"
              value={`${c.shiftsNeeded} shifts`}
              color={c.shiftsNeeded >= 5 ? 'text-rose-400' : c.shiftsNeeded >= 3 ? 'text-amber-400' : 'text-emerald-400'}
              detail="⌈Hours/Week ÷ 7⌉ — minimum 7-hour shifts to hit weekly target"
            />
            <MetricTile
              label="Earnings / Shift"
              value={fmt(c.moneyPerShift)}
              detail="7 × Adjusted Earning/hr"
              verify={close(c.moneyPerShift, sv['Amount of Money Each Shift Should Give'])}
            />
            <MetricTile
              label="Spending / Day (Checking)"
              value={fmt(c.spendingDaily)}
              detail="Checking deposit allocation ÷ CI Days Applicable"
              sub={`over ${c.ciDays} CI days`}
            />
          </SectionGrid>
        )}

        {/* ── Gas ── */}
        {tab === 'gas' && (
          <SectionGrid>
            <MetricTile label="Price / Gallon" value={fmt(c.gasPerGal, 3)} sub="Current average" />
            <MetricTile label="Average MPG" value={`${c.mpg} mpg`} />
            <MetricTile
              label="Claimable Gas Budget"
              value={fmt(c.claimableGas)}
              color={c.claimableGas < 20 ? 'text-rose-400' : 'text-white'}
              detail="From Allocation Summary — Gas row balance"
              wide
            />
            <MetricTile
              label="Gallons Remaining"
              value={`${fmtN(c.gallonsLeft)} gal`}
              detail="Claimable Gas ÷ Price per Gallon"
              verify={close(c.gallonsLeft, sv['Gallons (Remaining)'])}
            />
            <MetricTile
              label="Est. Miles Remaining"
              value={`${fmtN(c.estMiles, 0)} mi`}
              detail="Gallons × MPG"
              verify={close(c.estMiles, sv['Est. Miles (remaining)'])}
            />
            <MetricTile
              label="Miles / Day (remaining)"
              value={`${fmtN(c.milesPerDay)} mi`}
              detail="Estimated miles ÷ days remaining in month"
            />
            <MetricTile
              label="QC Trips / Day"
              value={fmtN(c.qcPerDay)}
              color={c.qcPerDay >= 2 ? 'text-emerald-400' : 'text-amber-400'}
              detail="Miles/day ÷ 28.3 mi per round-trip to QC"
            />
            <MetricTile
              label="Total QC Trips Left"
              value={fmtN(c.totalQC, 1)}
              detail="Total estimated miles ÷ 28.3 mi"
            />
            <MetricTile
              label="Budget for 2 QC/day (full month)"
              value={fmt(c.budgetFor2QC)}
              color={c.budgetFor2QC > 0 ? 'text-amber-400' : 'text-emerald-400'}
              detail="(56.6 mi/day × days × $/gal ÷ mpg) − claimable gas. Positive = shortfall."
              wide
            />
          </SectionGrid>
        )}

        {/* ── Accounts ── */}
        {tab === 'accounts' && (
          <SectionGrid>
            {[
              ['Checking',        '🏧'],
              ['Outside Payment', '💸'],
              ['Savings',         '🐷'],
              ['Cash',            '💵'],
              ['Business Tax',    '🧾'],
              ['Subscription',    '📱'],
            ].map(([acct, icon]) => (
              <MetricTile
                key={acct}
                label={`${icon} ${acct}`}
                value={fmt(c.deposits[acct])}
                detail={`(${acct} allowances ÷ Total allowance) × CI. Proportional share of claimable income.`}
                verify={close(c.deposits[acct], sv[`dep_${acct}`])}
              />
            ))}
            <MetricTile label="CI Days Applicable" value={`${c.ciDays} days`} detail="Number of days CI is spread across for daily spending calculation" wide />
          </SectionGrid>
        )}

        {/* ── Budget ── */}
        {tab === 'budget' && (
          <SectionGrid>
            {[
              [1, 'text-emerald-400', 'Essential — non-negotiable bills & savings'],
              [2, 'text-amber-400',   'Stability — important recurring needs'],
              [3, 'text-slate-400',   'Optional — nice-to-have items'],
            ].map(([p, color, desc]) => (
              <MetricTile
                key={p}
                label={`Priority ${p}`}
                value={fmt(c.priorities[p])}
                sub={desc}
                color={color}
                detail={`Sum of all Priority ${p} expense allowances from Monthly Expenses sheet`}
                verify={close(c.priorities[p], sv[`Priority ${p}`])}
                wide
              />
            ))}
            <BarTile
              label="Budget by Category"
              items={Object.entries(c.cats).sort(([,a],[,b]) => b - a)}
              total={c.totalAllowance}
            />
          </SectionGrid>
        )}

      </div>

      {/* Legend */}
      <div className="mx-4 mt-4 bg-slate-900 rounded-xl px-3 py-2 flex gap-4 text-[10px] text-slate-600">
        <span><span className="text-emerald-500">✓</span> matches sheet</span>
        <span><span className="text-amber-400">⚠</span> &gt;2% diff</span>
        <span><span className="text-blue-400">ℹ</span> tap for formula</span>
      </div>
    </div>
  );
}
