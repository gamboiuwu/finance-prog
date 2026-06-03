import { useEffect, useState, useMemo, useRef } from 'react';
import { readRange } from '../lib/sheets';
import { fetchGasPrices } from '../lib/gasPrice';
import { computeGasBudget, saveGasBudget } from '../lib/gasBudget';
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

function computeAll(expenses, sv, allocRows, livePrice = null, livePeriod = '') {
  const now = new Date();
  const today = now.getDate();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = dim - today;
  const weeksInMo = Math.round((dim / 7) * 100) / 100;

  const totalAllowance = expenses.reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0);
  const pi = pm(sv['Processed Income for Month (PI)']) || 0;
  const ci = pm(sv['Claimable Income (CI)']) || 0;
  const ciDays = pm(sv['CI Days Applicable']) || 14;
  const hourlyWage = pm(sv['Hourly Wage']) || 17;
  const rawWagePct = pm(sv['% of Wage Earned']);
  const wagePct = rawWagePct !== null ? (rawWagePct > 1 ? rawWagePct / 100 : rawWagePct) : 0.9047;

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
  const shiftsForGoal = Math.ceil(hoursLeft / 7);
  const moneyPerShift = 7 * adjHourly;

  const checkingAllowance = expenses.filter(e => e['Account'] === 'Checking').reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0);
  const checkingDeposit = totalAllowance > 0 ? (checkingAllowance / totalAllowance) * ci : 0;
  const spendingDaily = ciDays > 0 ? checkingDeposit / ciDays : 0;

  // Source priority: live EIA NYC price → sheet override → fallback
  const gasPerGal = (livePrice && livePrice > 0)
    ? livePrice
    : (pm(sv['Current Average $/gal']) || 4.09);
  const gasPriceSource = (livePrice && livePrice > 0) ? 'live' : (pm(sv['Current Average $/gal']) ? 'sheet' : 'fallback');
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
    deposits[acct] = expenses.filter(e => e['Account'] === acct).reduce((s, e) => {
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
    now, today, dim, daysLeft, weeksInMo,
    totalAllowance, pi, ci, ciDays, adjHourly, hourlyWage, wagePct,
    ciPlusPi, ar, weeklyReq, goalToCycle, avgPctDay, projectedEnd,
    spendingDaily, reqDay30, reqDayLeft,
    hoursLeft, hrsPerWeek, shiftsNeeded, shiftsForGoal, moneyPerShift,
    gasPerGal, gasPriceSource, gasPricePeriod: livePeriod, mpg, claimableGas, gallonsLeft, estMiles,
    milesPerDay, qcPerDay, totalQC, budgetFor2QC,
    deposits, priorities, cats,
  };
}

// ─── Insights ────────────────────────────────────────────────────────────────

function buildInsights(c) {
  if (!c.totalAllowance) return { good: [], watch: [] };
  const good = [], watch = [];
  const covPct = c.pi / c.totalAllowance * 100;
  if (covPct >= 90) good.push(`${covPct.toFixed(0)}% of monthly goal met`);
  else if (covPct >= 60) watch.push(`${covPct.toFixed(0)}% of goal — ${fmt(c.ar)} remaining`);
  else watch.push(`Behind goal — only ${covPct.toFixed(0)}% covered, need ${fmt(c.ar)} more`);
  if (c.projectedEnd >= 1.0) good.push('On track to hit goal by month end');
  else watch.push(`Projected ${(c.projectedEnd * 100).toFixed(0)}% by end of month`);
  if (c.claimableGas >= 30) good.push(`${fmt(c.claimableGas)} in gas budget available`);
  else if (c.claimableGas < 15) watch.push('Gas budget running low');
  if (c.daysLeft <= 5 && c.ar > 0) {
    if (c.daysLeft === 0) {
      const endOfDay = new Date(c.now); endOfDay.setHours(23, 59, 59, 999);
      const hoursLeft = Math.max(1, Math.ceil((endOfDay - c.now) / 3600000));
      watch.push(`${hoursLeft}h left today — still need ${fmt(c.ar)}`);
    } else {
      watch.push(`Only ${c.daysLeft} days left — still need ${fmt(c.ar)}`);
    }
  }
  if (c.shiftsNeeded <= 3 && c.shiftsNeeded > 0) good.push(`${c.shiftsNeeded} shift${c.shiftsNeeded > 1 ? 's' : ''} needed to meet goal`);
  else if (c.shiftsNeeded >= 6) watch.push(`${c.shiftsNeeded} shifts still needed this month`);
  return { good, watch };
}

// ─── Default tile order per tab ───────────────────────────────────────────────

const DEFAULT_ORDER = {
  overview: ['goalProgress','monthlyGoal','pi','ci','ciPlusPi','ar','coveragePct','projectedEnd'],
  work:     ['weeklyReq','reqDay30','reqDayLeft','hourlyWage','adjHourly','hoursLeft','hrsPerWeek','shiftsNeeded','moneyPerShift','spendingDaily'],
  gas:      ['gasPrice','mpg','claimableGas','gallonsLeft','estMiles','milesPerDay','qcPerDay','totalQC','budgetFor2QC'],
  accounts: ['acctChecking','acctOutsidePayment','acctSavings','acctCash','acctBusinessTax','acctSubscription','ciDays'],
  budget:   ['p1','p2','p3','catBreakdown'],
};

// Wide tiles (col-span-2 / full-width)
const WIDE_TILES = new Set([
  'goalProgress','weeklyReq','claimableGas','budgetFor2QC','ciDays','p1','p2','p3','catBreakdown',
]);

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function EditModal({ label, currentVal, onSave, onClear, onClose }) {
  const [val, setVal] = useState(currentVal || '');
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-800 rounded-2xl p-5 w-72 space-y-3" onClick={e => e.stopPropagation()}>
        <div>
          <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-0.5">{label}</p>
          <p className="text-white text-sm">Override display value</p>
          <p className="text-slate-600 text-xs mt-0.5">Display-only — doesn't affect calculations</p>
        </div>
        <input
          type="text"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSave(val); if (e.key === 'Escape') onClose(); }}
          className="w-full bg-slate-700 text-white px-3 py-2.5 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
          autoFocus
          placeholder="e.g. $42.00 or 3.5 hrs"
        />
        <div className="flex gap-2">
          {currentVal && (
            <button onClick={onClear} className="py-2 px-3 rounded-xl bg-slate-700 text-rose-400 text-sm font-medium">Clear</button>
          )}
          <button onClick={onClose} className="flex-1 py-2 rounded-xl bg-slate-700 text-slate-300 text-sm font-medium">Cancel</button>
          <button onClick={() => onSave(val)} className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium">Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── MetricTile ───────────────────────────────────────────────────────────────

function MetricTile({ label, value, sub, detail, color = 'text-white', verify, wide, onEdit, overrideVal }) {
  const [open, setOpen] = useState(false);
  const isOverridden = overrideVal !== undefined && overrideVal !== null;
  const displayVal = isOverridden ? overrideVal : value;
  return (
    <div className={`bg-slate-900 rounded-xl p-3 flex flex-col gap-0.5 h-full`}>
      <div className="flex items-start justify-between gap-1">
        <p className="text-slate-500 text-[10px] uppercase tracking-widest leading-tight">{label}</p>
        <div className="flex items-center gap-0.5 shrink-0">
          {detail && (
            <button onClick={() => setOpen(v => !v)}
              className="text-slate-600 hover:text-blue-400 text-[10px] w-4 h-4 flex items-center justify-center transition-colors">ℹ</button>
          )}
          <button onClick={onEdit}
            className={`text-[10px] w-4 h-4 flex items-center justify-center transition-colors ${isOverridden ? 'text-amber-400' : 'text-slate-600 hover:text-amber-400'}`}>
            ✏
          </button>
        </div>
      </div>
      <div className="flex items-baseline gap-1.5">
        <p className={`text-xl font-bold font-mono tabular-nums tracking-tight ${isOverridden ? 'text-amber-300' : color}`}>{displayVal}</p>
        {!isOverridden && verify !== undefined && (
          <span className={verify ? 'text-emerald-500 text-[10px]' : 'text-amber-400 text-[10px]'}>{verify ? '✓' : '⚠'}</span>
        )}
        {isOverridden && <span className="text-amber-600 text-[10px]">edited</span>}
      </div>
      {sub && <p className="text-slate-600 text-[11px] leading-tight">{sub}</p>}
      {open && detail && (
        <p className="text-slate-400 text-[11px] leading-relaxed mt-1.5 pt-1.5 border-t border-slate-800">{detail}</p>
      )}
    </div>
  );
}

function BarTile({ label, items, total }) {
  const COLORS = {
    Essentials: '#3b82f6', Discretionary: '#a855f7',
    Savings: '#10b981', Stability: '#f59e0b', Subscription: '#f43f5e',
  };
  return (
    <div className="bg-slate-900 rounded-xl p-3 space-y-2 h-full">
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
    <div className="bg-slate-900 rounded-xl p-3 space-y-2 h-full">
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

// ─── Tile renderer ───────────────────────────────────────────────────────────

function renderTile(id, c, sv, ov, onEdit) {
  const e = (label) => () => onEdit(id, label, ov[id]);
  const o = ov[id] ?? undefined;

  switch (id) {
    case 'goalProgress':
      return <ProgressTile label="Monthly Goal Progress" current={c.pi} goal={c.totalAllowance} />;
    case 'monthlyGoal':
      return <MetricTile label="Monthly Goal" value={fmt(c.totalAllowance)} detail="Sum of all Monthly Expenses allowances" verify={close(c.totalAllowance, sv['Monthly Goal'])} onEdit={e('Monthly Goal')} overrideVal={o} />;
    case 'pi':
      return <MetricTile label="Processed Income" value={fmt(c.pi)} sub="Income logged this month · resets each month" detail="Paychecks + commissions received and processed" onEdit={e('Processed Income')} overrideVal={o} />;
    case 'ci':
      return <MetricTile label="Claimable Income" value={fmt(c.ci)} sub="CI" detail="Income available to allocate across accounts" onEdit={e('Claimable Income')} overrideVal={o} />;
    case 'ciPlusPi':
      return <MetricTile label="CI + PI" value={fmt(c.ciPlusPi)} detail="Claimable Income + Processed Income combined" onEdit={e('CI + PI')} overrideVal={o} />;
    case 'ar':
      return <MetricTile label="Remaining to Goal" value={fmt(c.ar)} sub={c.ar > 0 ? 'More income needed this month' : 'Monthly goal fully covered!'} color={c.ar > 0 ? 'text-amber-400' : 'text-emerald-400'} detail="Monthly Goal − Processed Income = how much more you need to earn/process" onEdit={e('Still Required')} overrideVal={o} />;
    case 'coveragePct':
      return <MetricTile label="Coverage %" value={fmtPct(c.goalToCycle)} color={c.goalToCycle >= 1 ? 'text-emerald-400' : c.goalToCycle >= 0.75 ? 'text-amber-400' : 'text-rose-400'} detail="PI ÷ Monthly Goal" verify={close(c.goalToCycle, pm(sv['Goal to Cycle']) < 2 ? pm(sv['Goal to Cycle']) : null)} onEdit={e('Coverage %')} overrideVal={o} />;
    case 'projectedEnd':
      return <MetricTile label="Projected End %" value={fmtPct(c.projectedEnd)} color={c.projectedEnd >= 1 ? 'text-emerald-400' : 'text-amber-400'} detail="Current % + (avg daily % × days remaining)" onEdit={e('Projected End %')} overrideVal={o} />;

    case 'weeklyReq':
      return <MetricTile label="Weekly Requirement" value={fmt(c.weeklyReq)} detail="Monthly Goal ÷ weeks in month" verify={close(c.weeklyReq, sv['Minimum Weekly Requirement'])} wide onEdit={e('Weekly Requirement')} overrideVal={o} />;
    case 'reqDay30':
      return <MetricTile label="Required / Day (÷30)" value={fmt(c.reqDay30)} detail="Monthly Goal ÷ 30" verify={close(c.reqDay30, sv['Required Earnings/day (30 days)'])} onEdit={e('Req/Day ÷30')} overrideVal={o} />;
    case 'reqDayLeft':
      return <MetricTile label="Required / Day (left)" value={fmt(c.reqDayLeft)} color={c.reqDayLeft > c.adjHourly * 8 ? 'text-rose-400' : 'text-white'} detail="AR ÷ days remaining" verify={close(c.reqDayLeft, sv['Required Earnings/day (remaining from AR)'])} onEdit={e('Req/Day Left')} overrideVal={o} />;
    case 'hourlyWage':
      return <MetricTile label="Hourly Wage" value={fmt(c.hourlyWage)} sub={`${(c.wagePct * 100).toFixed(2)}% after deductions`} onEdit={e('Hourly Wage')} overrideVal={o} />;
    case 'adjHourly':
      return <MetricTile label="Adjusted / hr" value={fmt(c.adjHourly)} detail="Hourly Wage × % of Wage Earned" verify={close(c.adjHourly, sv['Adjusted Earning/hr'])} onEdit={e('Adjusted/hr')} overrideVal={o} />;
    case 'hoursLeft':
      return <MetricTile label="Hours Left for Goal" value={`${fmtN(c.hoursLeft)} hrs`} sub={`≈ ${c.shiftsForGoal} shift${c.shiftsForGoal !== 1 ? 's' : ''} of 7 hrs`} color={c.hoursLeft > 40 ? 'text-rose-400' : 'text-white'} detail="AR ÷ Adjusted Earning/hr" onEdit={e('Hours Left')} overrideVal={o} />;
    case 'hrsPerWeek':
      return <MetricTile label="Hours / Week Needed" value={`${fmtN(c.hrsPerWeek)} hrs`} detail="Weekly Requirement ÷ Adjusted Earning/hr" onEdit={e('Hrs/Week')} overrideVal={o} />;
    case 'shiftsNeeded':
      return <MetricTile label="7-hr Shifts Needed" value={`${c.shiftsNeeded} shifts`} color={c.shiftsNeeded >= 5 ? 'text-rose-400' : c.shiftsNeeded >= 3 ? 'text-amber-400' : 'text-emerald-400'} detail="⌈Hours/Week ÷ 7⌉ — shifts to hit weekly target" onEdit={e('Shifts Needed')} overrideVal={o} />;
    case 'moneyPerShift':
      return <MetricTile label="Earnings / Shift" value={fmt(c.moneyPerShift)} detail="7 × Adjusted Earning/hr" verify={close(c.moneyPerShift, sv['Amount of Money Each Shift Should Give'])} onEdit={e('Earnings/Shift')} overrideVal={o} />;
    case 'spendingDaily':
      return <MetricTile label="Spending / Day (Checking)" value={fmt(c.spendingDaily)} detail="Checking deposit ÷ CI Days" sub={`over ${c.ciDays} CI days`} onEdit={e('Spending/Day')} overrideVal={o} />;

    case 'gasPrice':
      return <MetricTile
        label="Price / Gallon"
        value={fmt(c.gasPerGal, 3)}
        sub={o && c.gasPriceSource === 'live'
          ? `live avg: $${c.gasPerGal.toFixed(3)} · tap ✏ to clear`
          : c.gasPriceSource === 'live' ? `NYC live · ${c.gasPricePeriod || 'EIA'}` : c.gasPriceSource === 'sheet' ? 'From sheet' : 'Default'}
        detail="Live weekly EIA price for NYC region — feeds gallons remaining, miles, and monthly reserve estimates."
        onEdit={e('Gas Price')}
        overrideVal={o}
      />;
    case 'mpg':
      return <MetricTile label="Average MPG" value={`${c.mpg} mpg`} onEdit={e('Avg MPG')} overrideVal={o} />;
    case 'claimableGas':
      return <MetricTile label="Claimable Gas Budget" value={fmt(c.claimableGas)} color={c.claimableGas < 20 ? 'text-rose-400' : 'text-white'} detail="From Allocation Summary — Gas row balance" wide onEdit={e('Claimable Gas')} overrideVal={o} />;
    case 'gallonsLeft':
      return <MetricTile label="Gallons Remaining" value={`${fmtN(c.gallonsLeft)} gal`} detail="Claimable Gas ÷ Price/Gallon" verify={close(c.gallonsLeft, sv['Gallons (Remaining)'])} onEdit={e('Gallons Left')} overrideVal={o} />;
    case 'estMiles':
      return <MetricTile label="Est. Miles Remaining" value={`${fmtN(c.estMiles, 0)} mi`} detail="Gallons × MPG" verify={close(c.estMiles, sv['Est. Miles (remaining)'])} onEdit={e('Est Miles')} overrideVal={o} />;
    case 'milesPerDay':
      return <MetricTile label="Miles / Day (remaining)" value={`${fmtN(c.milesPerDay)} mi`} detail="Est. miles ÷ days remaining" onEdit={e('Miles/Day')} overrideVal={o} />;
    case 'qcPerDay':
      return <MetricTile label="QC Trips / Day" value={fmtN(c.qcPerDay)} color={c.qcPerDay >= 2 ? 'text-emerald-400' : 'text-amber-400'} detail="Miles/day ÷ 28.3 mi per round-trip to QC" onEdit={e('QC Trips/Day')} overrideVal={o} />;
    case 'totalQC':
      return <MetricTile label="Total QC Trips Left" value={fmtN(c.totalQC, 1)} detail="Total est. miles ÷ 28.3 mi" onEdit={e('Total QC Trips')} overrideVal={o} />;
    case 'budgetFor2QC':
      return <MetricTile label="Budget for 2 QC/day (full month)" value={fmt(c.budgetFor2QC)} color={c.budgetFor2QC > 0 ? 'text-amber-400' : 'text-emerald-400'} detail="(56.6 mi/day × days × $/gal ÷ mpg) − claimable gas. Positive = shortfall." wide onEdit={e('Budget 2QC/day')} overrideVal={o} />;

    case 'acctChecking': { const _acctAlloc = expenses.filter(e => e['Account'] === 'Checking').reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0); const _acctPct = c.totalAllowance > 0 ? (_acctAlloc / c.totalAllowance * 100).toFixed(1) : null; const _noCI = c.ci === 0 && sv['dep_Checking'] == null; return <MetricTile label="🏧 Checking" value={_noCI ? '—' : sv['dep_Checking'] != null ? fmt(pm(sv['dep_Checking'])) : fmt(c.deposits['Checking'])} sub={_noCI ? `${_acctPct ?? '—'}% of budget · awaiting claimable income` : undefined} color="text-white" detail="(Checking allowances ÷ Total) × CI" verify={_noCI ? undefined : close(c.deposits['Checking'], sv['dep_Checking'])} onEdit={e('Checking')} overrideVal={o} />; }
    case 'acctOutsidePayment': { const _acctAlloc = expenses.filter(e => e['Account'] === 'Outside Payment').reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0); const _acctPct = c.totalAllowance > 0 ? (_acctAlloc / c.totalAllowance * 100).toFixed(1) : null; const _noCI = c.ci === 0 && sv['dep_Outside Payment'] == null; return <MetricTile label="💸 Outside Payment" value={_noCI ? '—' : sv['dep_Outside Payment'] != null ? fmt(pm(sv['dep_Outside Payment'])) : fmt(c.deposits['Outside Payment'])} sub={_noCI ? `${_acctPct ?? '—'}% of budget · awaiting claimable income` : undefined} color="text-white" detail="(Outside Payment allowances ÷ Total) × CI" verify={_noCI ? undefined : close(c.deposits['Outside Payment'], sv['dep_Outside Payment'])} onEdit={e('Outside Payment')} overrideVal={o} />; }
    case 'acctSavings': { const _acctAlloc = expenses.filter(e => e['Account'] === 'Savings').reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0); const _acctPct = c.totalAllowance > 0 ? (_acctAlloc / c.totalAllowance * 100).toFixed(1) : null; const _noCI = c.ci === 0 && sv['dep_Savings'] == null; return <MetricTile label="🐷 Savings" value={_noCI ? '—' : sv['dep_Savings'] != null ? fmt(pm(sv['dep_Savings'])) : fmt(c.deposits['Savings'])} sub={_noCI ? `${_acctPct ?? '—'}% of budget · awaiting claimable income` : undefined} color="text-white" detail="(Savings allowances ÷ Total) × CI" verify={_noCI ? undefined : close(c.deposits['Savings'], sv['dep_Savings'])} onEdit={e('Savings')} overrideVal={o} />; }
    case 'acctCash': { const _acctAlloc = expenses.filter(e => e['Account'] === 'Cash').reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0); const _acctPct = c.totalAllowance > 0 ? (_acctAlloc / c.totalAllowance * 100).toFixed(1) : null; const _noCI = c.ci === 0 && sv['dep_Cash'] == null; return <MetricTile label="💵 Cash" value={_noCI ? '—' : sv['dep_Cash'] != null ? fmt(pm(sv['dep_Cash'])) : fmt(c.deposits['Cash'])} sub={_noCI ? `${_acctPct ?? '—'}% of budget · awaiting claimable income` : undefined} color="text-white" detail="(Cash allowances ÷ Total) × CI" verify={_noCI ? undefined : close(c.deposits['Cash'], sv['dep_Cash'])} onEdit={e('Cash')} overrideVal={o} />; }
    case 'acctBusinessTax': { const _acctAlloc = expenses.filter(e => e['Account'] === 'Business Tax').reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0); const _acctPct = c.totalAllowance > 0 ? (_acctAlloc / c.totalAllowance * 100).toFixed(1) : null; const _noCI = c.ci === 0 && sv['dep_Business Tax'] == null; return <MetricTile label="🧾 Business Tax" value={_noCI ? '—' : sv['dep_Business Tax'] != null ? fmt(pm(sv['dep_Business Tax'])) : fmt(c.deposits['Business Tax'])} sub={_noCI ? `${_acctPct ?? '—'}% of budget · awaiting claimable income` : undefined} color="text-white" detail="(Business Tax allowances ÷ Total) × CI" verify={_noCI ? undefined : close(c.deposits['Business Tax'], sv['dep_Business Tax'])} onEdit={e('Business Tax')} overrideVal={o} />; }
    case 'acctSubscription': { const _acctAlloc = expenses.filter(e => e['Account'] === 'Subscription').reduce((s, e) => s + (pm(e['Monthly Allowance ($)']) || 0), 0); const _acctPct = c.totalAllowance > 0 ? (_acctAlloc / c.totalAllowance * 100).toFixed(1) : null; const _noCI = c.ci === 0 && sv['dep_Subscription'] == null; return <MetricTile label="📱 Subscription" value={_noCI ? '—' : sv['dep_Subscription'] != null ? fmt(pm(sv['dep_Subscription'])) : fmt(c.deposits['Subscription'])} sub={_noCI ? `${_acctPct ?? '—'}% of budget · awaiting claimable income` : undefined} color="text-white" detail="(Subscription allowances ÷ Total) × CI" verify={_noCI ? undefined : close(c.deposits['Subscription'], sv['dep_Subscription'])} onEdit={e('Subscription')} overrideVal={o} />; }
    case 'ciDays':             return <MetricTile label="CI Days Applicable" value={`${c.ciDays} days`} detail="Number of days CI is spread across" wide onEdit={e('CI Days')} overrideVal={o} />;

    case 'p1':
      return <MetricTile label="Priority 1 — Essential" value={fmt(c.priorities[1])} sub="Non-negotiable bills & savings" color="text-emerald-400" detail="Sum of all Priority 1 expense allowances" verify={close(c.priorities[1], sv['Priority 1'])} wide onEdit={e('Priority 1')} overrideVal={o} />;
    case 'p2':
      return <MetricTile label="Priority 2 — Stability" value={fmt(c.priorities[2])} sub="Important recurring needs" color="text-amber-400" detail="Sum of all Priority 2 expense allowances" verify={close(c.priorities[2], sv['Priority 2'])} wide onEdit={e('Priority 2')} overrideVal={o} />;
    case 'p3':
      return <MetricTile label="Priority 3 — Optional" value={fmt(c.priorities[3])} sub="Nice-to-have items" color="text-slate-400" detail="Sum of all Priority 3 expense allowances" verify={close(c.priorities[3], sv['Priority 3'])} wide onEdit={e('Priority 3')} overrideVal={o} />;
    case 'catBreakdown':
      return <BarTile label="Budget by Category" items={Object.entries(c.cats).sort(([,a],[,b]) => b - a)} total={c.totalAllowance} />;

    default: return null;
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'work',     label: 'Work'     },
  { id: 'gas',      label: 'Gas'      },
  { id: 'accounts', label: 'Accounts' },
  { id: 'budget',   label: 'Budget'   },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Summary({ token }) {
  const [svRows, setSvRows]       = useState([]);
  const [expRows, setExpRows]     = useState([]);
  const [allocRows, setAllocRows] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [tab, setTab]             = useState('overview');
  const [livePrice, setLivePrice]   = useState(null);
  const [livePeriod, setLivePeriod] = useState('');

  // Tile order per tab (from localStorage)
  const [tileOrder, setTileOrder] = useState(() => {
    const saved = {};
    Object.keys(DEFAULT_ORDER).forEach(t => {
      try {
        const stored = JSON.parse(localStorage.getItem(`summary_order_${t}`));
        saved[t] = Array.isArray(stored) && stored.length === DEFAULT_ORDER[t].length ? stored : DEFAULT_ORDER[t];
      } catch { saved[t] = DEFAULT_ORDER[t]; }
    });
    return saved;
  });

  // Display overrides (from localStorage)
  const [overrides, setOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem('summary_overrides')) || {}; }
    catch { return {}; }
  });

  // Edit modal state
  const [editModal, setEditModal] = useState(null); // { id, label, currentVal }

  // Drag state
  const dragIdx  = useRef(null);
  const dragOver = useRef(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    Promise.allSettled([
      readRange(token, 'Expense Summary!A1:S60'),
      readRange(token, 'Monthly Expenses!A1:T40'),
      readRange(token, 'Allocation Summary!A1:B10'),
    ])
      .then(([svResult, expResult, allocResult]) => {
        setSvRows(svResult.status === 'fulfilled' ? svResult.value : []);
        if (expResult.status === 'fulfilled') {
          setExpRows(expResult.value);
        } else {
          setError(expResult.reason?.message || 'Failed to load budget data');
        }
        setAllocRows(allocResult.status === 'fulfilled' ? allocResult.value : []);
      })
      .finally(() => setLoading(false));
  }, [token]);

  // Live NYC/Long Island gas price — refresh hourly (EIA publishes weekly,
  // fetchGasPrices caches for 1 hour so the polling is essentially free).
  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchGasPrices()
        .then(data => {
          if (cancelled) return;
          const nyc = data?.byRegion?.['Y35NY']?.products?.['EPMR'];
          if (nyc?.value) {
            setLivePrice(nyc.value);
            setLivePeriod(nyc.period || data?.period || '');
          }
        })
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 60 * 60 * 1000); // hourly
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // When a fresh live price arrives, clear any stale manual override so the live value shows.
  useEffect(() => {
    if (!livePrice) return;
    setOverrides(prev => {
      if (!prev['gasPrice']) return prev;
      const updated = { ...prev };
      delete updated['gasPrice'];
      localStorage.setItem('summary_overrides', JSON.stringify(updated));
      return updated;
    });
  }, [livePrice]);

  const sv = useMemo(() => extractSV(svRows), [svRows]);
  const expenses = useMemo(() => {
    if (!expRows.length) return [];
    const [headers, ...data] = expRows;
    return data.filter(r => r[0]).map(row => headers.reduce((obj, h, i) => { obj[h] = row[i] ?? null; return obj; }, {}));
  }, [expRows]);
  const c = useMemo(() => computeAll(expenses, sv, allocRows, livePrice, livePeriod), [expenses, sv, allocRows, livePrice, livePeriod]);
  const insights = useMemo(() => buildInsights(c), [c]);

  // Cache the dynamic gas budget (with the user's real mpg from the sheet) so the
  // Dashboard / Budget / ProcessIncome all reflect the same ~$185 reserve.
  useEffect(() => {
    if (c.gasPerGal > 0) {
      const budget = computeGasBudget({ gasPerGal: c.gasPerGal, mpg: c.mpg });
      if (budget) saveGasBudget(budget, { gasPerGal: c.gasPerGal, mpg: c.mpg });
    }
  }, [c.gasPerGal, c.mpg]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <div className="p-4 text-red-400">Error: {error}</div>;

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // ── Handlers ────────────────────────────────────────────────────────────────

  function openEdit(id, label, currentVal) {
    setEditModal({ id, label, currentVal });
  }

  function saveOverride(val) {
    if (!editModal) return;
    const updated = { ...overrides, [editModal.id]: val };
    setOverrides(updated);
    localStorage.setItem('summary_overrides', JSON.stringify(updated));
    setEditModal(null);
  }

  function clearOverride() {
    if (!editModal) return;
    const updated = { ...overrides };
    delete updated[editModal.id];
    setOverrides(updated);
    localStorage.setItem('summary_overrides', JSON.stringify(updated));
    setEditModal(null);
  }

  function onDragStart(tabId, idx) {
    dragIdx.current = idx;
    setDragging(true);
  }

  function onDragEnter(idx) {
    dragOver.current = idx;
  }

  function onDragEnd(tabId) {
    const from = dragIdx.current;
    const to   = dragOver.current;
    if (from !== null && to !== null && from !== to) {
      const order = [...tileOrder[tabId]];
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      const updated = { ...tileOrder, [tabId]: order };
      setTileOrder(updated);
      localStorage.setItem(`summary_order_${tabId}`, JSON.stringify(order));
    }
    dragIdx.current  = null;
    dragOver.current = null;
    setDragging(false);
  }

  const activeOrder = tileOrder[tab] || DEFAULT_ORDER[tab];

  return (
    <div className="pb-24">

      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-white tracking-tight">Finance Summary</h1>
        <p className="text-slate-500 text-xs mt-0.5 font-mono">
          {MONTHS[c.now.getMonth()]} {c.now.getFullYear()} · Day {c.today}/{c.dim} · {c.daysLeft === 0 ? `${Math.max(1, Math.ceil((new Date(c.now.getFullYear(), c.now.getMonth(), c.now.getDate(), 23, 59, 59, 999) - c.now) / 3600000))}h remaining` : `${c.daysLeft}d remaining`}
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
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
              tab === t.id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tile grid — draggable */}
      <div className="px-4">
        <div className="stagger flex flex-wrap gap-2">
          {activeOrder.map((id, idx) => {
            const wide = WIDE_TILES.has(id);
            const content = renderTile(id, c, sv, overrides, openEdit);
            if (!content) return null;
            return (
              <div
                key={id}
                draggable
                onDragStart={() => onDragStart(tab, idx)}
                onDragEnter={() => onDragEnter(idx)}
                onDragEnd={() => onDragEnd(tab)}
                onDragOver={e => e.preventDefault()}
                className={`${wide ? 'w-full' : 'w-[calc(50%-4px)]'} transition-opacity ${dragging && dragOver.current === idx ? 'opacity-50' : 'opacity-100'} cursor-grab active:cursor-grabbing`}
              >
                {content}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mx-4 mt-4 bg-slate-900 rounded-xl px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600">
        <span><span className="text-emerald-500">✓</span> matches sheet</span>
        <span><span className="text-amber-400">⚠</span> &gt;2% diff</span>
        <span><span className="text-blue-400">ℹ</span> tap for formula</span>
        <span><span className="text-amber-400">✏</span> tap to override display</span>
        <span className="text-slate-700">drag tiles to reorder · saved per tab</span>
      </div>

      {/* Edit modal */}
      {editModal && (
        <EditModal
          label={editModal.label}
          currentVal={editModal.currentVal}
          onSave={saveOverride}
          onClear={clearOverride}
          onClose={() => setEditModal(null)}
        />
      )}
    </div>
  );
}
