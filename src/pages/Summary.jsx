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

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function close(a, b, tol = 0.02) {
  if (a === null || b === null) return null;
  const bv = pm(b);
  if (bv === null) return null;
  if (bv === 0 && a === 0) return true;
  if (bv === 0) return null;
  return Math.abs((a - bv) / bv) <= tol;
}

// ─── Expense Summary parser ──────────────────────────────────────────────────
// Sheet layout (column indices, 0-based):
//   A=0, B=1  → left labels + values
//   I=8, J=9  → deposit accounts + amounts; expense categories + amounts
//   K=10      → expense category percentages
//   L=11, M=12 → right labels + values (time/work calculations)
//   O=14, P=15 → priority labels + sums

function extractSV(rows) {
  const v = {};
  const DEPOSIT_ACCOUNTS = ['Checking','Outside Payment','Cash','Savings','Business Tax','Subscription'];
  const CATEGORIES = ['Essentials','Discretionary','Savings','Stability','Subscription'];
  const SKIP = ['Account Deposit Summary','[Expense Summary]','Credit','Spending Amount Daily (checking)'];

  rows.forEach(row => {
    const cell = (i) => (row[i] !== undefined && row[i] !== null && row[i] !== '') ? row[i] : null;

    // Left side
    if (cell(0) && cell(1) !== null) v[String(row[0]).trim()] = row[1];

    // Right side
    if (cell(11) && cell(12) !== null) v[String(row[11]).trim()] = row[12];

    // Priority rows (O=14, P=15)
    if (cell(14) && cell(15) !== null) v[String(row[14]).trim()] = row[15];

    // Deposit accounts (I=8, J=9)
    const acct = cell(8) ? String(row[8]).trim() : '';
    if (DEPOSIT_ACCOUNTS.includes(acct) && cell(9) !== null && !SKIP.includes(acct)) {
      v[`dep_${acct}`] = row[9];
    }

    // Expense categories (I=8, J=9, K=10)
    if (CATEGORIES.includes(acct) && cell(9) !== null) {
      v[`cat_${acct}_amt`] = row[9];
      if (cell(10) !== null) v[`cat_${acct}_pct`] = row[10];
    }
  });
  return v;
}

// ─── Independent computation ─────────────────────────────────────────────────

function computeAll(expenses, sv, allocSummary) {
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

  // Spending daily (checking) = sum of checking balances / ciDays
  const checkingDeposit = expenses
    .filter(e => e['Account'] === 'Checking')
    .reduce((s, e) => s + (pm(e['Balance to Deposit']) || (totalAllowance > 0 ? (pm(e['Monthly Allowance ($)']) || 0) / totalAllowance * ci : 0)), 0);
  const spendingDaily = ciDays > 0 ? checkingDeposit / ciDays : 0;

  // Gas
  const gasPerGal = pm(sv['Current Average $/gal']) || 4.09;
  const mpg = pm(sv['Average mpg']) || 23.5;

  // Claimable Gas from allocation summary (Gas row, balance)
  const claimableGas = (() => {
    const gasRow = allocSummary.find(r => r[0] === 'Gas');
    return gasRow ? (pm(gasRow[1]) || 0) : (pm(sv['Claimable Gas']) || 0);
  })();

  const gallonsLeft = gasPerGal > 0 ? claimableGas / gasPerGal : 0;
  const estMiles = gallonsLeft * mpg;
  const milesPerDay = daysLeft > 0 ? estMiles / daysLeft : 0;
  const qcPerDay = milesPerDay / 28.3;
  const totalQC = estMiles / 28.3;

  // Budget for 2 QC trips/day for full month
  const budgetFor2QC = ((56.6 / mpg) * gasPerGal) * dim - claimableGas;

  // Deposits by account (formula: pct * CI for each expense in that account)
  const deposits = {};
  ['Checking','Outside Payment','Cash','Savings','Business Tax','Subscription'].forEach(acct => {
    deposits[acct] = expenses
      .filter(e => e['Account'] === acct)
      .reduce((s, e) => {
        const pct = totalAllowance > 0 ? (pm(e['Monthly Allowance ($)']) || 0) / totalAllowance : 0;
        return s + pct * ci;
      }, 0);
  });

  // Priorities
  const priorities = { 1: 0, 2: 0, 3: 0 };
  expenses.forEach(e => {
    const p = parseInt(e['Priority']);
    if (p >= 1 && p <= 3) priorities[p] += pm(e['Monthly Allowance ($)']) || 0;
  });

  // Categories
  const cats = {};
  expenses.forEach(e => {
    const cat = e['Expense'] || 'Other';
    cats[cat] = (cats[cat] || 0) + (pm(e['Monthly Allowance ($)']) || 0);
  });

  // Emergency fund targets (based on Essentials monthly spend)
  const essentials3mo = (cats['Essentials'] || 0) * 3;
  const essentials6mo = (cats['Essentials'] || 0) * 6;

  return {
    now, today, dim, daysLeft, daysInYear, weeksInMo,
    totalAllowance, pi, ci, ciDays, adjHourly, hourlyWage, wagePct,
    ciPlusPi, ar, weeklyReq, goalToCycle, avgPctDay, projectedEnd,
    spendingDaily, reqDay30, reqDayLeft,
    hoursLeft, hrsPerWeek, shiftsNeeded, moneyPerShift,
    gasPerGal, mpg, claimableGas, gallonsLeft, estMiles,
    milesPerDay, qcPerDay, totalQC, budgetFor2QC,
    deposits, priorities, cats, essentials3mo, essentials6mo,
  };
}

// ─── UI components ────────────────────────────────────────────────────────────

function Section({ title, accent = 'border-slate-700', children }) {
  return (
    <div className="bg-slate-800 rounded-2xl overflow-hidden">
      <div className={`px-4 py-3 border-b ${accent}`}>
        <h2 className="text-white font-semibold text-sm tracking-wide">{title}</h2>
      </div>
      <div className="divide-y divide-slate-700/50">{children}</div>
    </div>
  );
}

function DataRow({ label, sheetVal, computed, unit = '', note, highlight }) {
  const match = close(computed, sheetVal);
  return (
    <div className={`flex items-start justify-between gap-3 px-4 py-2.5 ${highlight ? 'bg-slate-700/30' : ''}`}>
      <div className="flex-1 min-w-0">
        <p className="text-slate-300 text-sm leading-snug">{label}</p>
        {note && <p className="text-slate-500 text-xs mt-0.5">{note}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="text-right">
          <p className="text-white text-sm font-medium">
            {sheetVal !== undefined ? sheetVal : (computed !== null && computed !== undefined ? (typeof computed === 'number' ? (unit === '%' ? fmtPct(computed) : fmt(computed)) : computed) : '—')}
            {unit && unit !== '%' ? unit : ''}
          </p>
          {computed !== undefined && computed !== null && sheetVal !== undefined && (
            <p className="text-slate-500 text-xs">calc: {unit === '%' ? fmtPct(computed) : fmt(computed)}</p>
          )}
        </div>
        {match !== null && (
          match
            ? <span className="text-emerald-400 text-xs w-4">✓</span>
            : <span className="text-amber-400 text-xs w-4" title="Mismatch — check sheet">⚠</span>
        )}
      </div>
    </div>
  );
}

function RawRow({ label, value, sub, color = 'text-white' }) {
  return (
    <div className="flex justify-between items-start gap-3 px-4 py-2.5">
      <p className="text-slate-300 text-sm flex-1 min-w-0">{label}</p>
      <div className="text-right shrink-0">
        <p className={`text-sm font-medium ${color}`}>{value}</p>
        {sub && <p className="text-slate-500 text-xs">{sub}</p>}
      </div>
    </div>
  );
}

function ProgressRow({ label, current, goal, color }) {
  const pct = goal > 0 ? Math.min((current / goal) * 100, 100) : 0;
  return (
    <div className="px-4 py-3 space-y-1.5">
      <div className="flex justify-between text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">{fmt(current)} / {fmt(goal)}</span>
      </div>
      <div className="w-full bg-slate-700 rounded-full h-2.5 overflow-hidden">
        <div className="h-2.5 rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
      <p className="text-slate-500 text-xs text-right">{pct.toFixed(0)}%</p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Summary({ token }) {
  const [svRows, setSvRows] = useState([]);
  const [expRows, setExpRows] = useState([]);
  const [allocRows, setAllocRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([
      readRange(token, 'Expense Summary!A1:S60'),
      readRange(token, 'Monthly Expenses!A1:T40'),
      readRange(token, 'Allocation Summary!A1:B10'),
    ])
      .then(([sv, exp, alloc]) => {
        setSvRows(sv);
        setExpRows(exp);
        setAllocRows(alloc);
      })
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

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;

  const now = c.now;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  return (
    <div className="p-4 pb-24 space-y-4">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Finance Summary</h1>
        <p className="text-slate-400 text-sm">
          {MONTHS[now.getMonth()]} {now.getFullYear()} · Day {c.today} of {c.dim}
        </p>
      </div>

      {/* ── Income & Goal ─────────────────────────────────────── */}
      <Section title="💰 Income & Monthly Goal" accent="border-blue-800/50">
        <ProgressRow
          label="Goal to Cycle"
          current={c.pi}
          goal={c.totalAllowance}
          color={c.goalToCycle >= 1 ? '#10b981' : c.goalToCycle >= 0.75 ? '#f59e0b' : '#3b82f6'}
        />
        <DataRow label="Monthly Goal (Σ allowances)"
          sheetVal={fmt(pm(sv['Monthly Goal']))}
          computed={c.totalAllowance}
          note="Sum of all Monthly Expenses allowances"
          highlight
        />
        <DataRow label="Processed Income (PI)"
          sheetVal={fmt(pm(sv['Processed Income for Month (PI)']))}
          computed={c.pi}
          note="Paychecks + commissions received & processed"
        />
        <DataRow label="Claimable Income (CI)"
          sheetVal={fmt(pm(sv['Claimable Income (CI)']))}
          computed={c.ci}
          note="Income available to allocate"
        />
        <DataRow label="CI + PI"
          sheetVal={fmt(pm(sv['CI + PI']))}
          computed={c.ciPlusPi}
        />
        <DataRow label="Amount Required for Goal (AR)"
          sheetVal={fmt(pm(sv['Amount Required for Goal (AR)']))}
          computed={c.ar}
          note="Monthly Goal − PI — still needed this month"
          highlight
        />
        <DataRow label="Goal to Cycle"
          sheetVal={sv['Goal to Cycle'] !== undefined ? (parseFloat(sv['Goal to Cycle']) < 2 ? fmtPct(pm(sv['Goal to Cycle'])) : sv['Goal to Cycle']) : undefined}
          computed={c.goalToCycle}
          unit="%"
        />
      </Section>

      {/* ── Time & Projection ─────────────────────────────────── */}
      <Section title="📅 Time & Projection" accent="border-purple-800/50">
        <RawRow label="Today" value={`${MONTHS[now.getMonth()]} ${c.today}, ${now.getFullYear()}`} />
        <RawRow label="Days Remaining in Month" value={`${c.daysLeft} of ${c.dim}`} />
        <RawRow label="Days Remaining in Year" value={`${c.daysInYear} days`} />
        <RawRow label="Approx Weeks in Month" value={`${c.weeksInMo} weeks`} />
        <DataRow label="Average % Progress / day"
          sheetVal={sv['Average %/day'] !== undefined ? fmtPct(pm(sv['Average %/day'])) : undefined}
          computed={c.avgPctDay}
          unit="%"
          note="Goal to Cycle ÷ days in month"
        />
        <DataRow label="Projected End-of-Month Cycle %"
          sheetVal={sv['Projected End Cycle Amount'] !== undefined ? fmtPct(pm(sv['Projected End Cycle Amount'])) : undefined}
          computed={c.projectedEnd}
          unit="%"
          note="Current % + (avg/day × days remaining)"
          highlight
        />
      </Section>

      {/* ── Work Requirements ─────────────────────────────────── */}
      <Section title="⚡ Work Requirements" accent="border-amber-800/50">
        <DataRow label="Minimum Weekly Requirement"
          sheetVal={fmt(pm(sv['Minimum Weekly Requirement']))}
          computed={c.weeklyReq}
          note="Monthly Goal ÷ weeks in month"
          highlight
        />
        <DataRow label="Required Earnings / day (÷30)"
          sheetVal={fmt(pm(sv['Required Earnings/day (30 days)']))}
          computed={c.reqDay30}
          note="Monthly Goal ÷ 30"
        />
        <DataRow label="Required Earnings / day (remaining)"
          sheetVal={fmt(pm(sv['Required Earnings/day (remaining from AR)']))}
          computed={c.reqDayLeft}
          note="AR ÷ days remaining"
          highlight
        />
        <DataRow label="Spending (Checking) / day"
          sheetVal={fmt(pm(sv['Spending Amount Daily (checking)']))}
          computed={c.spendingDaily}
          note="Checking deposit ÷ CI days applicable"
        />
        <RawRow label="Hourly Wage" value={fmt(c.hourlyWage)} />
        <RawRow label="% of Wage Earned" value={`${(c.wagePct * 100).toFixed(2)}%`} sub="After deductions" />
        <DataRow label="Adjusted Earning / hr"
          sheetVal={fmt(pm(sv['Adjusted Earning/hr']))}
          computed={c.adjHourly}
          note="Hourly Wage × % of Wage Earned"
          highlight
        />
        <DataRow label="Hours Left to Hit Goal"
          sheetVal={sv['Amount of Hours Left to Achieve Monthly Requirement'] !== undefined ? `${fmtN(pm(sv['Amount of Hours Left to Achieve Monthly Requirement']))} hrs` : undefined}
          computed={c.hoursLeft}
          note="AR ÷ Adjusted Earning/hr"
        />
        <DataRow label="Hours / Week Needed"
          sheetVal={sv['Amount of Hours Per Week to Achieve Weekly Requirement'] !== undefined ? `${fmtN(pm(sv['Amount of Hours Per Week to Achieve Weekly Requirement']))} hrs` : undefined}
          computed={c.hrsPerWeek}
          note="Weekly Req ÷ Adjusted Earning/hr"
        />
        <DataRow label="7-hr Shifts Needed"
          sheetVal={sv['Amount of 7-Hr Shifts to Achieve Weekly Requirement'] !== undefined ? `${sv['Amount of 7-Hr Shifts to Achieve Weekly Requirement']} shifts` : undefined}
          computed={c.shiftsNeeded}
          note="⌈Hours/Week ÷ 7⌉"
          highlight
        />
        <DataRow label="Earnings per 7-hr Shift"
          sheetVal={fmt(pm(sv['Amount of Money Each Shift Should Give']))}
          computed={c.moneyPerShift}
          note="7 × Adjusted Earning/hr"
        />
      </Section>

      {/* ── Account Deposits ──────────────────────────────────── */}
      <Section title="🏦 Account Deposits (from CI)" accent="border-emerald-800/50">
        {[
          ['Checking',        '🏧'],
          ['Outside Payment', '💸'],
          ['Cash',            '💵'],
          ['Savings',         '🐷'],
          ['Business Tax',    '🧾'],
          ['Subscription',    '📱'],
        ].map(([acct, icon]) => (
          <DataRow
            key={acct}
            label={`${icon} ${acct}`}
            sheetVal={pm(sv[`dep_${acct}`]) !== null ? fmt(pm(sv[`dep_${acct}`])) : undefined}
            computed={c.deposits[acct]}
            note={`(Allowance ÷ Total) × CI`}
          />
        ))}
        <div className="px-4 py-3 bg-emerald-900/20 border-t border-emerald-800/30">
          <div className="flex justify-between text-sm">
            <span className="text-emerald-300 font-medium">CI Days Applicable</span>
            <span className="text-white font-bold">{c.ciDays} days</span>
          </div>
        </div>
      </Section>

      {/* ── Gas Calculator ────────────────────────────────────── */}
      <Section title="⛽ Gas Calculator" accent="border-orange-800/50">
        <RawRow label="Price per gallon" value={fmt(c.gasPerGal)} />
        <RawRow label="Average MPG" value={`${c.mpg} mpg`} />
        <DataRow label="Claimable Gas balance"
          sheetVal={fmt(pm(sv['Claimable Gas']))}
          computed={c.claimableGas}
          note="From Allocation Summary"
        />
        <DataRow label="Gallons remaining"
          sheetVal={fmtN(pm(sv['Gallons (Remaining)']))}
          computed={c.gallonsLeft}
          note="Claimable Gas ÷ $/gal"
          highlight
        />
        <DataRow label="Estimated miles remaining"
          sheetVal={fmtN(pm(sv['Est. Miles (remaining)']))}
          computed={c.estMiles}
          note="Gallons × MPG"
        />
        <DataRow label="Miles / day (remaining)"
          sheetVal={fmtN(pm(sv['Miles/Day (remaining)']))}
          computed={c.milesPerDay}
          note="Miles ÷ days remaining"
        />
        <DataRow label="QC trips / day (28.3 mi)"
          sheetVal={fmtN(pm(sv['QC Trips/day (remaining)']))}
          computed={c.qcPerDay}
          note="Miles/day ÷ 28.3"
          highlight
        />
        <DataRow label="Total QC trips remaining"
          sheetVal={fmtN(pm(sv['Total QC trips (remaining)']))}
          computed={c.totalQC}
          note="Total miles ÷ 28.3"
        />
      </Section>

      {/* ── Budget by Priority ────────────────────────────────── */}
      <Section title="🎯 Budget by Priority" accent="border-pink-800/50">
        {[
          ['Priority 1', 'Essentials & critical savings', 'text-emerald-400'],
          ['Priority 2', 'Important stability & discretionary', 'text-amber-400'],
          ['Priority 3', 'Nice-to-have / optional', 'text-slate-400'],
        ].map(([label, desc, color], i) => {
          const p = i + 1;
          const sheetKey = label;
          const sheetVal = pm(sv[sheetKey]);
          const computed = c.priorities[p];
          return (
            <div key={p} className={`px-4 py-3 flex items-start justify-between gap-3 ${i < 2 ? 'border-b border-slate-700/50' : ''}`}>
              <div>
                <p className={`text-sm font-medium ${color}`}>{label}</p>
                <p className="text-slate-500 text-xs">{desc}</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-right">
                  <p className={`text-sm font-bold ${color}`}>{sheetVal !== null ? fmt(sheetVal) : fmt(computed)}</p>
                  {sheetVal !== null && <p className="text-slate-500 text-xs">calc: {fmt(computed)}</p>}
                </div>
                {sheetVal !== null && (
                  close(computed, sheetVal)
                    ? <span className="text-emerald-400 text-xs w-4">✓</span>
                    : <span className="text-amber-400 text-xs w-4">⚠</span>
                )}
              </div>
            </div>
          );
        })}
      </Section>

      {/* ── Budget by Expense Type ────────────────────────────── */}
      <Section title="📊 Budget by Expense Type" accent="border-sky-800/50">
        {Object.entries(c.cats).sort(([,a],[,b]) => b - a).map(([cat, amt], i, arr) => {
          const pct = c.totalAllowance > 0 ? amt / c.totalAllowance : 0;
          const COLORS = {
            Essentials: 'bg-blue-500',
            Discretionary: 'bg-purple-500',
            Savings: 'bg-emerald-500',
            Stability: 'bg-amber-500',
            Subscription: 'bg-rose-500',
          };
          return (
            <div key={cat} className={`px-4 py-3 space-y-1.5 ${i < arr.length - 1 ? 'border-b border-slate-700/50' : ''}`}>
              <div className="flex justify-between text-sm">
                <span className="text-slate-300">{cat}</span>
                <span className="text-white font-medium">{fmt(amt)} <span className="text-slate-500 font-normal text-xs">({(pct * 100).toFixed(1)}%)</span></span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                <div className={`h-1.5 rounded-full ${COLORS[cat] || 'bg-slate-500'}`} style={{ width: `${pct * 100}%` }} />
              </div>
            </div>
          );
        })}
      </Section>

      {/* ── Emergency Fund Targets ────────────────────────────── */}
      <Section title="🛡 Emergency Fund Targets" accent="border-red-800/50">
        <DataRow label="Required Minimum (3 months essentials)"
          sheetVal={pm(sv['Required Emergency Minimum (3mo)']) !== null ? fmt(pm(sv['Required Emergency Minimum (3mo)'])) : undefined}
          computed={c.essentials3mo}
          note="Essentials monthly × 3"
        />
        <DataRow label="Required Maximum (6 months essentials)"
          sheetVal={pm(sv['Required Emergency Maximum (6mo)']) !== null ? fmt(pm(sv['Required Emergency Maximum (6mo)'])) : undefined}
          computed={c.essentials6mo}
          note="Essentials monthly × 6"
          highlight
        />
      </Section>

      {/* ── Verification legend ───────────────────────────────── */}
      <div className="bg-slate-800/50 rounded-xl p-3 flex gap-4 text-xs text-slate-400">
        <span><span className="text-emerald-400">✓</span> Sheet value matches JS calculation</span>
        <span><span className="text-amber-400">⚠</span> &gt;2% difference — check sheet</span>
      </div>

    </div>
  );
}
