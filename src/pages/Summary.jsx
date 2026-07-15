import { useEffect, useState, useMemo, useRef } from 'react';
import { readRange } from '../lib/sheets';
import { fetchGasPrices } from '../lib/gasPrice';
import { computeGasBudget, saveGasBudget, GAS_MILES_PER_DAY } from '../lib/gasBudget';
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
  gas:      ['gasPrice','mpg','claimableGas','gasCoverage','gallonsLeft','estMiles','milesPerDay','qcPerDay','totalQC','budgetFor2QC'],
  accounts: ['acctChecking','acctOutsidePayment','acctSavings','acctCash','acctBusinessTax','acctSubscription','ciDays'],
  budget:   ['p1','p2','p3','catBreakdown'],
};

// Wide tiles (col-span-2 / full-width)
const WIDE_TILES = new Set([
  'goalProgress','weeklyReq','claimableGas','gasCoverage','budgetFor2QC','ciDays','p1','p2','p3','catBreakdown',
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
          <span
            title={verify
              ? 'Matches the value calculated in your sheet'
              : "Differs from your sheet by more than 2% — tap ℹ for the formula, then check the inputs (a new month may not have reset its sheet value yet)"}
            className={`cursor-help ${verify ? 'text-emerald-500 text-[10px]' : 'text-amber-400 text-[10px]'}`}
          >{verify ? '✓' : '⚠'}</span>
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

// ─── Gas Coverage verdict (Task 72) ────────────────────────────────────────────
// "Is my gas budget enough?" — compares the claimable Gas balance against the
// full-month fuel cost for the user's typical monthly mileage:
//   gallonsNeeded = monthlyMiles ÷ mpg ;  needed = gallonsNeeded × $/gal
//   coverage = claimableGas − needed     (≥0 = enough · <0 = short by |coverage|)
// Monthly miles defaults to the app's 56.6 mi/day assumption (× days in month) so
// it reconciles with the "Budget for 2 QC/day" tile, but is user-editable and stored
// in localStorage `_fin_gas_miles` (a mileage count only — no financial data).
const GAS_MILES_KEY = '_fin_gas_miles';
function getGasMiles() {
  try {
    const v = parseFloat(localStorage.getItem(GAS_MILES_KEY));
    return v > 0 ? v : null;
  } catch { return null; }
}

function GasCoverageTile({ c }) {
  const [miles, setMiles] = useState(() => getGasMiles());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const dim = c.dim || 30;
  const defaultMiles = Math.round(GAS_MILES_PER_DAY * dim);
  const usingDefault = !(miles && miles > 0);
  const monthlyMiles = usingDefault ? defaultMiles : miles;

  const mpg = c.mpg > 0 ? c.mpg : 23.5;
  const perGal = c.gasPerGal > 0 ? c.gasPerGal : 0;
  const claimable = c.claimableGas || 0;

  if (perGal <= 0) return null; // can't judge coverage without a price

  // Full-month fuel cost for the typical mileage vs. what the budget on hand buys.
  const gallonsNeeded = monthlyMiles / mpg;
  const needed = gallonsNeeded * perGal;
  const gallonsBuys = claimable / perGal;
  const milesCovers = gallonsBuys * mpg;
  const coverage = claimable - needed;      // ≥0 covered · <0 short
  const enough = coverage >= 0;

  function saveMiles() {
    const v = parseFloat(draft);
    if (v > 0) { localStorage.setItem(GAS_MILES_KEY, String(v)); setMiles(v); }
    setEditing(false);
  }
  function resetMiles() {
    localStorage.removeItem(GAS_MILES_KEY); setMiles(null); setEditing(false);
  }

  return (
    <div className={`rounded-xl p-3 h-full border ${enough ? 'bg-emerald-950/40 border-emerald-800/40' : 'bg-amber-950/40 border-amber-800/40'}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-slate-400 text-[10px] uppercase tracking-widest leading-tight">⛽ Gas Coverage</p>
        <button onClick={() => { setDraft(String(monthlyMiles)); setEditing(v => !v); }}
          className="text-[10px] text-slate-500 hover:text-amber-400 shrink-0">✏ miles</button>
      </div>

      <p className={`text-base font-bold mt-1 ${enough ? 'text-emerald-300' : 'text-amber-300'}`}>
        {enough
          ? `✅ Enough — covers ~${fmtN(milesCovers, 0)} mi`
          : `⚠ Short ~${fmt(Math.abs(coverage))}/mo`}
      </p>
      <p className="text-slate-400 text-[11px] leading-snug mt-0.5">
        {enough
          ? `Your ${fmt(claimable)} gas budget buys ~${fmtN(gallonsBuys, 1)} gal at ${fmt(perGal, 3)}/gal — enough for your ~${fmtN(monthlyMiles, 0)} mi/mo.`
          : `Your ~${fmtN(monthlyMiles, 0)} mi/mo needs ~${fmtN(gallonsNeeded, 1)} gal ≈ ${fmt(needed)}; you have ${fmt(claimable)}. Add ${fmt(Math.abs(coverage))} to this month's gas budget.`}
      </p>

      {editing ? (
        <div className="mt-2 pt-2 border-t border-slate-700/50 space-y-1.5">
          <p className="text-slate-500 text-[10px]">Typical miles you drive per month{usingDefault ? ` · default ${defaultMiles} (${GAS_MILES_PER_DAY} mi/day)` : ''}</p>
          <div className="flex gap-1.5">
            <input type="number" inputMode="decimal" value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveMiles(); if (e.key === 'Escape') setEditing(false); }}
              className="flex-1 bg-slate-800 text-white px-2 py-1.5 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500" autoFocus placeholder={`${defaultMiles}`} />
            <button onClick={saveMiles} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium">Save</button>
            {!usingDefault && <button onClick={resetMiles} className="px-2 py-1.5 rounded-lg bg-slate-700 text-slate-300 text-xs">Reset</button>}
          </div>
        </div>
      ) : (
        <p className="text-slate-600 text-[10px] mt-1.5">
          {usingDefault ? `Assuming ${GAS_MILES_PER_DAY} mi/day · tap ✏ to set your real monthly miles` : `Based on your ${fmtN(monthlyMiles, 0)} mi/mo`}
        </p>
      )}
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
    case 'gasCoverage':
      return <GasCoverageTile c={c} />;
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

// ─── Year (YTD) View ──────────────────────────────────────────────────────────
// Task 11 — Year-to-Date Budget Summary. Reads Monthly Summary (income/spent per
// month) + Allocation Transactions (per-category allocations) for the current
// year. Uses COMPLETED months only (months strictly before the current calendar
// month) so a stale current-month sheet formula can never skew the totals. Also
// shows an avg-based year-end projection and best/worst month cards.

const MONTHS_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const CAT_COLORS = {
  Essentials: '#3b82f6', Discretionary: '#a855f7',
  Savings: '#10b981', Stability: '#f59e0b', Subscription: '#f43f5e', Other: '#64748b',
};

// Parse an Allocation Transactions date cell (Google Sheets serial OR string).
function parseAllocDate(ds) {
  if (ds === null || ds === undefined || ds === '') return null;
  const n = Number(ds);
  if (!isNaN(n) && n > 1000 && !String(ds).includes('/')) {
    // Sheets serials are UTC-midnight; rebuild as a LOCAL noon date from the UTC
    // calendar parts so getMonth() doesn't slip a day back in negative-UTC (US)
    // timezones — a 1st-of-month row must stay in this month, not last.
    const u = new Date(Math.round((n - 25569) * 86400000));
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 12, 0, 0);
  }
  const d = new Date(String(ds));
  return isNaN(d.getTime()) ? null : d;
}

function Sparkline12({ values, color = '#3b82f6' }) {
  const max = Math.max(...values.map(v => Math.abs(v)), 1);
  const W = 132, H = 26, n = values.length, bw = W / n;
  return (
    <svg width={W} height={H} className="block" aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(1, (Math.abs(v) / max) * (H - 2));
        return <rect key={i} x={i * bw + 1} y={H - h} width={Math.max(1, bw - 2)} height={h} rx={1}
          fill={v < 0 ? '#f43f5e' : color} opacity={v === 0 ? 0.18 : 0.9} />;
      })}
    </svg>
  );
}

function YearView({ monthlyRows, allocRows, expenses, year, loading }) {
  const data = useMemo(() => {
    const nowMonth = new Date().getMonth(); // completed = month indices < nowMonth

    // Monthly Summary rows for this year, restricted to completed months.
    const yrMonths = monthlyRows
      .map(m => ({ ...m, _idx: MONTHS_ABBR.findIndex(a => String(m['Month'] || '').startsWith(a)) }))
      .filter(m => String(m['Year']) === String(year) && m._idx >= 0 && m._idx < nowMonth);
    const completedCount = yrMonths.length;

    let ytdIncome = 0, ytdSpent = 0, best = null, worst = null;
    yrMonths.forEach(m => {
      const inc = pm(m['Total Processed Income']) || 0;
      const spt = pm(m['Total Spent']) || 0;
      ytdIncome += inc; ytdSpent += spt;
      if (!best || inc > best.val) best = { month: m['Month'], val: inc };
      if (!worst || spt > worst.val) worst = { month: m['Month'], val: spt };
    });

    // Build category budget + Type→category map from Monthly Expenses.
    const catBudget = {}, typeToCat = {};
    expenses.forEach(e => {
      const cat = e['Expense'] || 'Other';
      catBudget[cat] = (catBudget[cat] || 0) + (pm(e['Monthly Allowance ($)']) || 0);
      if (e['Type']) typeToCat[String(e['Type']).trim()] = cat;
    });
    const monthlyGoal = Object.values(catBudget).reduce((s, v) => s + v, 0);

    // Sum Allocation Transactions into per-category, per-month buckets (this year).
    const catMonth = {};
    (allocRows || []).slice(1).forEach(r => {
      if (!r || !r[0] || !r[1]) return;
      const d = parseAllocDate(r[0]);
      if (!d || d.getFullYear() !== Number(year)) return;
      const cat = typeToCat[String(r[1]).trim()] || 'Other';
      if (!catMonth[cat]) catMonth[cat] = Array(12).fill(0);
      catMonth[cat][d.getMonth()] += pm(r[2]) || 0;
    });

    const allCats = Array.from(new Set([...Object.keys(catBudget), ...Object.keys(catMonth)]));
    const cats = allCats.map(cat => {
      const months = catMonth[cat] || Array(12).fill(0);
      const allocatedYTD = months.reduce((s, v, i) => (i < nowMonth ? s + v : s), 0);
      const budgetedYTD = (catBudget[cat] || 0) * completedCount;
      return { cat, months, allocatedYTD, budgetedYTD, variance: allocatedYTD - budgetedYTD };
    }).sort((a, b) => b.budgetedYTD - a.budgetedYTD || b.allocatedYTD - a.allocatedYTD);

    const avgIncome = completedCount > 0 ? ytdIncome / completedCount : 0;
    const avgSpent = completedCount > 0 ? ytdSpent / completedCount : 0;

    return {
      completedCount, ytdIncome, ytdSpent, ytdNet: ytdIncome - ytdSpent,
      ytdGoal: monthlyGoal * completedCount, best, worst, cats,
      projIncome: avgIncome * 12, projSpent: avgSpent * 12, projNet: (avgIncome - avgSpent) * 12,
    };
  }, [monthlyRows, allocRows, expenses, year]);

  if (loading)
    return <div className="px-4 py-10 text-center text-slate-500 text-sm">Loading year-to-date…</div>;
  if (data.completedCount === 0)
    return <div className="px-4 py-10 text-center text-slate-500 text-sm">No completed months yet in {year}. Check back once a month has closed.</div>;

  const goalPct = data.ytdGoal > 0 ? Math.min((data.ytdIncome / data.ytdGoal) * 100, 100) : 0;
  const rawGoalPct = data.ytdGoal > 0 ? (data.ytdIncome / data.ytdGoal) * 100 : 0;

  return (
    <div className="px-4 space-y-4">
      <p className="text-slate-500 text-[11px] -mt-1">
        {year} year-to-date · {data.completedCount} completed month{data.completedCount !== 1 ? 's' : ''} (Jan–{MONTHS_ABBR[Math.max(0, new Date().getMonth() - 1)]})
      </p>

      {/* YTD income vs goal */}
      <div className="bg-slate-900 rounded-xl p-4 space-y-2">
        <div className="flex justify-between items-baseline">
          <p className="text-slate-500 text-[10px] uppercase tracking-widest">YTD Income vs Goal</p>
          <p className="text-slate-400 text-[11px] font-mono">{fmt(data.ytdIncome)} <span className="text-slate-600">/ {fmt(data.ytdGoal)}</span></p>
        </div>
        <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
          <div className="h-2.5 rounded-full transition-all duration-500"
            style={{ width: `${goalPct}%`, background: rawGoalPct >= 100 ? '#10b981' : rawGoalPct >= 75 ? '#f59e0b' : '#3b82f6' }} />
        </div>
        <p className="text-right text-[11px] font-mono"
          style={{ color: rawGoalPct >= 100 ? '#10b981' : rawGoalPct >= 75 ? '#f59e0b' : '#3b82f6' }}>
          {rawGoalPct.toFixed(0)}% of YTD goal
        </p>
      </div>

      {/* YTD net + projection */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-slate-900 rounded-xl p-3">
          <p className="text-slate-500 text-[10px] uppercase tracking-widest leading-tight">YTD Spent</p>
          <p className="text-xl font-bold font-mono tabular-nums text-rose-400 mt-1">{fmt(data.ytdSpent)}</p>
        </div>
        <div className="bg-slate-900 rounded-xl p-3">
          <p className="text-slate-500 text-[10px] uppercase tracking-widest leading-tight">YTD Net</p>
          <p className={`text-xl font-bold font-mono tabular-nums mt-1 ${data.ytdNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmt(data.ytdNet)}</p>
        </div>
        <div className="bg-slate-900 rounded-xl p-3">
          <p className="text-slate-500 text-[10px] uppercase tracking-widest leading-tight">Proj. Net</p>
          <p className={`text-xl font-bold font-mono tabular-nums mt-1 ${data.projNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmt(data.projNet)}</p>
        </div>
      </div>
      <p className="text-slate-600 text-[11px] -mt-2">
        Year-end projection assumes your {data.completedCount}-month average holds: ≈{fmt(data.projIncome)} income, {fmt(data.projSpent)} spent.
      </p>

      {/* Best / worst month */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-emerald-950/40 border border-emerald-800/40 rounded-xl p-3">
          <p className="text-emerald-500/80 text-[10px] uppercase tracking-widest">Best Income Month</p>
          <p className="text-white font-bold text-sm mt-1">{data.best?.month || '—'}</p>
          <p className="text-emerald-400 font-mono text-sm">{data.best ? fmt(data.best.val) : '—'}</p>
        </div>
        <div className="bg-rose-950/40 border border-rose-800/40 rounded-xl p-3">
          <p className="text-rose-500/80 text-[10px] uppercase tracking-widest">Highest Spend Month</p>
          <p className="text-white font-bold text-sm mt-1">{data.worst?.month || '—'}</p>
          <p className="text-rose-400 font-mono text-sm">{data.worst ? fmt(data.worst.val) : '—'}</p>
        </div>
      </div>

      {/* Per-category YTD */}
      <div>
        <p className="text-slate-500 text-[10px] uppercase tracking-widest mb-2 px-1">YTD by Category</p>
        <div className="space-y-2">
          {data.cats.map(({ cat, months, allocatedYTD, budgetedYTD, variance }) => {
            const over = budgetedYTD > 0 && allocatedYTD > budgetedYTD;
            const color = CAT_COLORS[cat] || CAT_COLORS.Other;
            return (
              <div key={cat} className="bg-slate-900 rounded-xl p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                      <span className="text-white text-sm font-medium truncate">{cat}</span>
                    </div>
                    <p className="text-slate-500 text-[11px] font-mono mt-0.5">
                      {fmt(allocatedYTD)} <span className="text-slate-700">alloc</span>
                      {budgetedYTD > 0 && <> · {fmt(budgetedYTD)} <span className="text-slate-700">budget</span></>}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Sparkline12 values={months} color={color} />
                    {budgetedYTD > 0 && (
                      <p className={`text-[11px] font-mono mt-0.5 ${over ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {variance >= 0 ? '▲' : '▼'} {fmt(Math.abs(variance))}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Tax Prep View ─────────────────────────────────────────────────────────────
// Task 15 — Tax Prep Summary. A once-a-year, READ-ONLY report that buckets the
// year's money into tax-relevant categories so filing a Schedule C (or handing
// it to a preparer) is copy/paste, not archaeology. Reuses the already-loaded
// Allocation Transactions (personal income, split by [Source] tag) and
// lazy-loads the Business sheets + Subscriptions. Nothing here ever writes.
//
// Numbers it computes (mirrors the Business Insights P&L so they reconcile):
//   Schedule C: revenue (Business Transactions col F) − COGS − OpEx
//               − deductible subscriptions = estimated net self-employment income.
//   COGS / OpEx come from Business Expenses + non-owner-draw Business Account
//   Spending, categorised exactly like InsightsView (cat === 'COGS' → COGS, else OpEx).
//   Personal income is informational only (personal spending is NOT deductible).

const IS_OWNER_DRAW_TX = d => String(d || '').toLowerCase().includes('processed as personal income');
const IS_BIZ_DEDUCT_SUB = n => /business|deduct/i.test(String(n || ''));

// Pull a "[Source]" prefix tag (Task 27 income tagging) off a description, else null.
function extractSource(desc) {
  const m = String(desc || '').match(/^\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}
// Normalise a billed subscription amount to a monthly run-rate (matches Dashboard).
function txMonthly(amount, cycle) {
  const amt = parseFloat(amount) || 0;
  switch (String(cycle || 'monthly').toLowerCase()) {
    case 'annual':   return amt / 12;
    case 'weekly':   return (amt * 52) / 12;
    case 'biweekly': return (amt * 26) / 12;
    default:         return amt;
  }
}
// 4-digit calendar year of a date cell (serial or string), or null.
function yearOf(raw) {
  const d = parseAllocDate(raw);
  return d ? d.getFullYear() : null;
}

function TaxView({ bizTx, bizExp, bizSpend, subs, allocRows, year, onYear, availableYears, loading }) {
  const [copied, setCopied] = useState(false);
  const [showOpex, setShowOpex] = useState(false);
  const [showSubs, setShowSubs] = useState(false);
  const [showPersonal, setShowPersonal] = useState(false);

  const t = useMemo(() => {
    const Y = Number(year);

    // ── Schedule C gross receipts: Business Transactions revenue (col F / index 5) ──
    const revenue = (bizTx || [])
      .slice(String(bizTx?.[0]?.[0] || '').toLowerCase() === 'date' ? 1 : 0)
      .filter(r => r && yearOf(r[0]) === Y)
      .reduce((s, r) => s + (parseFloat(r[5]) || 0), 0);

    // ── Business cost rows: Business Expenses + non-draw Business Account Spending ──
    const expCosts = (bizExp || [])
      .slice(String(bizExp?.[0]?.[0] || '').toLowerCase() === 'date' ? 1 : 0)
      .filter(r => r && r[3] && parseFloat(r[2]) && yearOf(r[0]) === Y)
      .map(r => ({ cat: String(r[3]).trim(), amount: parseFloat(r[2]) || 0 }));
    const spendCosts = (bizSpend || [])
      .slice(String(bizSpend?.[0]?.[0] || '').toLowerCase() === 'date' ? 1 : 0)
      .filter(r => r && r[1] && parseFloat(r[2]) && !IS_OWNER_DRAW_TX(r[4]) && yearOf(r[0]) === Y)
      .map(r => ({ cat: String(r[1]).trim(), amount: parseFloat(r[2]) || 0 }));
    const costRows = [...expCosts, ...spendCosts];

    const cogs = costRows.filter(r => r.cat === 'COGS').reduce((s, r) => s + r.amount, 0);
    const opexMap = {};
    costRows.filter(r => r.cat !== 'COGS').forEach(r => { opexMap[r.cat] = (opexMap[r.cat] || 0) + r.amount; });
    const opexByCat = Object.entries(opexMap).sort((a, b) => b[1] - a[1]);
    const opex = opexByCat.reduce((s, [, v]) => s + v, 0);

    // ── Business-deductible subscriptions (Notes tagged business/deductible) ──
    // Annualised run-rate from current subscription state (no per-year history).
    const dedSubs = (subs || [])
      .slice(1) // header
      .filter(r => r && r[0] && IS_BIZ_DEDUCT_SUB(r[4]))
      .map(r => ({ name: String(r[0]), annual: txMonthly(r[3], r[2]) * 12 }))
      .filter(s => s.annual > 0)
      .sort((a, b) => b.annual - a.annual);
    const subDeduction = dedSubs.reduce((s, x) => s + x.annual, 0);

    const grossProfit = revenue - cogs;
    const totalDeductions = cogs + opex + subDeduction;
    const netSE = revenue - totalDeductions;
    const setAsideLow = Math.max(0, netSE) * 0.25;
    const setAsideHigh = Math.max(0, netSE) * 0.30;

    // ── Personal income by [Source] tag (informational; positive rows only) ──
    const persMap = {};
    (allocRows || []).slice(1).forEach(r => {
      if (!r || !r[1]) return;
      const amt = pm(r[2]) || 0;
      if (amt <= 0) return;            // income/deposits only — never spends
      if (yearOf(r[0]) !== Y) return;
      const src = extractSource(r[3]) || 'Untagged';
      persMap[src] = (persMap[src] || 0) + amt;
    });
    const personalBySource = Object.entries(persMap).sort((a, b) => b[1] - a[1]);
    const totalPersonal = personalBySource.reduce((s, [, v]) => s + v, 0);

    return {
      revenue, cogs, opex, opexByCat, grossProfit, dedSubs, subDeduction,
      totalDeductions, netSE, setAsideLow, setAsideHigh,
      personalBySource, totalPersonal,
    };
  }, [bizTx, bizExp, bizSpend, subs, allocRows, year]);

  function buildText() {
    const L = [];
    L.push(`TAX PREP SUMMARY — ${year}`);
    L.push('(Estimate only — not tax advice. Verify with a professional before filing.)');
    L.push('');
    L.push('SCHEDULE C — BUSINESS');
    L.push(`  Gross receipts (revenue):   ${fmt(t.revenue)}`);
    L.push(`  - COGS:                     ${fmt(t.cogs)}`);
    L.push(`  = Gross profit:             ${fmt(t.grossProfit)}`);
    L.push(`  - Operating expenses:       ${fmt(t.opex)}`);
    t.opexByCat.forEach(([cat, v]) => L.push(`        ${cat}: ${fmt(v)}`));
    L.push(`  - Deductible subscriptions: ${fmt(t.subDeduction)}`);
    t.dedSubs.forEach(s => L.push(`        ${s.name}: ${fmt(s.annual)}/yr (est.)`));
    L.push(`  = Est. net self-employment income: ${fmt(t.netSE)}`);
    L.push(`  Suggested tax set-aside (25-30%):  ${fmt(t.setAsideLow)} - ${fmt(t.setAsideHigh)}`);
    L.push('');
    L.push('PERSONAL INCOME (for your records — not deductible)');
    t.personalBySource.forEach(([src, v]) => L.push(`  ${src}: ${fmt(v)}`));
    L.push(`  Total personal income processed: ${fmt(t.totalPersonal)}`);
    L.push('');
    L.push('Mileage: not auto-included — track business miles separately and apply');
    L.push('the IRS standard mileage rate for the tax year.');
    return L.join('\n');
  }

  async function copyText() {
    const txt = buildText();
    try {
      await navigator.clipboard.writeText(txt);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading)
    return <div className="px-4 py-10 text-center text-slate-500 text-sm">Loading tax summary…</div>;

  const empty = t.revenue === 0 && t.totalDeductions === 0 && t.totalPersonal === 0;

  return (
    <div className="px-4 space-y-4">
      {/* Year selector + copy */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          {availableYears.map(y => (
            <button key={y} onClick={() => onYear(y)}
              className={`text-xs px-2.5 py-1 rounded-lg font-mono font-medium transition-colors ${
                String(y) === String(year) ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}>{y}</button>
          ))}
        </div>
        <button onClick={copyText}
          className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 font-medium hover:bg-slate-700 transition-colors">
          {copied ? '✓ Copied' : '📋 Copy summary'}
        </button>
      </div>

      {/* Caveat banner */}
      <div className="flex items-start gap-2 bg-amber-950/50 border border-amber-800/40 rounded-lg px-3 py-2">
        <span className="text-amber-400 text-xs mt-0.5">⚠</span>
        <span className="text-amber-300 text-[11px] leading-relaxed">
          Estimate only — not tax advice. You file a Schedule C; confirm every figure with a
          professional (or in FreeTaxUSA) before filing.
        </span>
      </div>

      {empty && (
        <div className="px-1 py-6 text-center text-slate-500 text-sm">
          No business or personal income logged for {year} yet.
        </div>
      )}

      {/* ── Schedule C ── */}
      <div className="bg-slate-900 rounded-xl p-4 space-y-2.5">
        <p className="text-slate-500 text-[10px] uppercase tracking-widest">Schedule C — Self-Employment</p>

        <div className="flex justify-between text-sm">
          <span className="text-slate-300">Gross receipts (revenue)</span>
          <span className="font-mono text-white tabular-nums">{fmt(t.revenue)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-slate-400">− Cost of goods sold</span>
          <span className="font-mono text-rose-300 tabular-nums">{fmt(t.cogs)}</span>
        </div>
        <div className="flex justify-between text-sm border-t border-slate-800 pt-2">
          <span className="text-slate-300">= Gross profit</span>
          <span className="font-mono text-white tabular-nums">{fmt(t.grossProfit)}</span>
        </div>

        {/* OpEx (expandable) */}
        <div>
          <button onClick={() => setShowOpex(v => !v)} className="w-full flex justify-between text-sm">
            <span className="text-slate-400">− Operating expenses {t.opexByCat.length > 0 && <span className="text-slate-600">{showOpex ? '▾' : '▸'}</span>}</span>
            <span className="font-mono text-rose-300 tabular-nums">{fmt(t.opex)}</span>
          </button>
          {showOpex && t.opexByCat.length > 0 && (
            <div className="mt-1.5 space-y-1 pl-3 border-l border-slate-800">
              {t.opexByCat.map(([cat, v]) => (
                <div key={cat} className="flex justify-between text-[11px]">
                  <span className="text-slate-500">{cat}</span>
                  <span className="font-mono text-slate-400 tabular-nums">{fmt(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Deductible subscriptions (expandable) */}
        <div>
          <button onClick={() => setShowSubs(v => !v)} className="w-full flex justify-between text-sm">
            <span className="text-slate-400">− Deductible subscriptions {t.dedSubs.length > 0 && <span className="text-slate-600">{showSubs ? '▾' : '▸'}</span>}</span>
            <span className="font-mono text-rose-300 tabular-nums">{fmt(t.subDeduction)}</span>
          </button>
          {showSubs && (
            <div className="mt-1.5 space-y-1 pl-3 border-l border-slate-800">
              {t.dedSubs.length === 0 ? (
                <p className="text-slate-600 text-[11px]">None tagged. Add "business" to a subscription's Notes to deduct it.</p>
              ) : t.dedSubs.map(s => (
                <div key={s.name} className="flex justify-between text-[11px]">
                  <span className="text-slate-500">{s.name}</span>
                  <span className="font-mono text-slate-400 tabular-nums">{fmt(s.annual)}/yr</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Net SE income */}
        <div className="flex justify-between items-baseline border-t border-slate-700 pt-2.5">
          <span className="text-slate-300 text-sm font-medium">= Est. net SE income</span>
          <span className={`font-mono text-lg font-bold tabular-nums ${t.netSE >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmt(t.netSE)}</span>
        </div>
      </div>

      {/* Tax set-aside suggestion */}
      <div className="bg-indigo-950/40 border border-indigo-800/40 rounded-xl p-3">
        <p className="text-indigo-300/80 text-[10px] uppercase tracking-widest">Suggested Tax Set-Aside</p>
        <p className="text-white font-mono text-lg font-bold mt-1">{fmt(t.setAsideLow)} – {fmt(t.setAsideHigh)}</p>
        <p className="text-slate-500 text-[11px] mt-0.5">Rough 25–30% of net SE income — covers self-employment + income tax. Confirm your bracket.</p>
      </div>

      {/* ── Personal income (informational) ── */}
      <div className="bg-slate-900 rounded-xl p-4">
        <button onClick={() => setShowPersonal(v => !v)} className="w-full flex justify-between items-baseline">
          <span className="text-slate-500 text-[10px] uppercase tracking-widest">Personal Income {year} {t.personalBySource.length > 0 && <span className="text-slate-600">{showPersonal ? '▾' : '▸'}</span>}</span>
          <span className="font-mono text-white tabular-nums text-sm">{fmt(t.totalPersonal)}</span>
        </button>
        {showPersonal && (
          <div className="mt-2 space-y-1.5">
            {t.personalBySource.length === 0 ? (
              <p className="text-slate-600 text-[11px]">No personal income deposits logged for {year}.</p>
            ) : t.personalBySource.map(([src, v]) => (
              <div key={src} className="flex justify-between text-[12px]">
                <span className="text-slate-400">{src === 'Untagged' ? 'Untagged income' : src}</span>
                <span className="font-mono text-slate-300 tabular-nums">{fmt(v)}</span>
              </div>
            ))}
            <p className="text-slate-600 text-[10px] pt-1.5 border-t border-slate-800 mt-1">
              Personal spending isn't tax-deductible — this is for your records only. Tag income in
              Process Income (e.g. [Paycheck], [Commission]) to split it out.
            </p>
          </div>
        )}
      </div>

      {/* Mileage note */}
      <p className="text-slate-600 text-[11px] leading-relaxed px-1">
        🚗 <span className="text-slate-500">Mileage</span> isn't auto-included — log your business miles
        separately and apply the IRS standard mileage rate for the tax year.
      </p>
    </div>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'work',     label: 'Work'     },
  { id: 'gas',      label: 'Gas'      },
  { id: 'accounts', label: 'Accounts' },
  { id: 'budget',   label: 'Budget'   },
  { id: 'year',     label: 'Year'     },
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

  // Year (YTD) tab — lazy-loaded the first time the tab is opened (Task 11)
  const [yearMonthlyRows, setYearMonthlyRows] = useState([]);
  const [yearAllocRows, setYearAllocRows]     = useState([]);
  const [yearLoaded, setYearLoaded]           = useState(false);
  const [yearLoading, setYearLoading]         = useState(false);

  // Year-tab sub-view: 'ytd' (Task 11) or 'tax' (Task 15)
  const [yearSub, setYearSub] = useState('ytd');
  const [taxYear, setTaxYear] = useState(new Date().getFullYear());

  // Tax sub-view — lazy-loaded the first time it is opened (Task 15)
  const [taxBizTx, setTaxBizTx]       = useState([]);
  const [taxBizExp, setTaxBizExp]     = useState([]);
  const [taxBizSpend, setTaxBizSpend] = useState([]);
  const [taxSubs, setTaxSubs]         = useState([]);
  const [taxLoaded, setTaxLoaded]     = useState(false);
  const [taxLoading, setTaxLoading]   = useState(false);

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

  // Lazy-load Monthly Summary + all Allocation Transactions when the Year tab is
  // first opened, so the heavier reads never delay the default Overview paint.
  useEffect(() => {
    if (tab !== 'year' || yearLoaded || yearLoading || !token) return;
    setYearLoading(true);
    Promise.allSettled([
      readRange(token, 'Monthly Summary!A1:P13'),
      readRange(token, 'Allocation Transactions!A:F', 'UNFORMATTED_VALUE'),
    ]).then(([sumRes, allocRes]) => {
      if (sumRes.status === 'fulfilled' && sumRes.value.length) {
        const [headers, ...rows] = sumRes.value;
        setYearMonthlyRows(rows.filter(r => r[0]).map(r =>
          headers.reduce((o, h, i) => { o[h] = r[i] ?? null; return o; }, {})
        ));
      }
      setYearAllocRows(allocRes.status === 'fulfilled' ? allocRes.value : []);
      setYearLoaded(true);
    }).finally(() => setYearLoading(false));
  }, [tab, yearLoaded, yearLoading, token]);

  // Lazy-load the Business sheets + Subscriptions the first time the Tax sub-view
  // is opened (Task 15). The personal-income side reuses yearAllocRows above.
  useEffect(() => {
    if (tab !== 'year' || yearSub !== 'tax' || taxLoaded || taxLoading || !token) return;
    setTaxLoading(true);
    Promise.allSettled([
      readRange(token, 'Business Transactions!A:H', 'UNFORMATTED_VALUE'),
      readRange(token, 'Business Expenses!A:G', 'UNFORMATTED_VALUE'),
      readRange(token, 'Business Account Spending!A:E', 'UNFORMATTED_VALUE'),
      readRange(token, 'Subscriptions!A:E'),
    ]).then(([txRes, expRes, spRes, subRes]) => {
      setTaxBizTx(txRes.status === 'fulfilled' ? txRes.value : []);
      setTaxBizExp(expRes.status === 'fulfilled' ? expRes.value : []);
      setTaxBizSpend(spRes.status === 'fulfilled' ? spRes.value : []);
      setTaxSubs(subRes.status === 'fulfilled' ? subRes.value : []);
      setTaxLoaded(true);
    }).finally(() => setTaxLoading(false));
  }, [tab, yearSub, taxLoaded, taxLoading, token]);

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

  // Use the user's saved per-tab order, but append any newly-added default tiles
  // they don't have yet (so new tiles like Gas Coverage always appear).
  const savedOrder = tileOrder[tab];
  const defaultOrder = DEFAULT_ORDER[tab] || [];
  const activeOrder = savedOrder
    ? [...savedOrder, ...defaultOrder.filter(id => !savedOrder.includes(id))]
    : defaultOrder;

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

      {/* Year tab renders its own view (YTD or Tax) instead of the tile grid */}
      {tab === 'year' && (
        <>
          {/* Sub-view toggle: Year-to-Date (Task 11) vs Tax Prep (Task 15) */}
          <div className="px-4 pb-3 flex gap-1.5">
            {[['ytd', '📊 Year-to-Date'], ['tax', '🧾 Tax Prep']].map(([id, label]) => (
              <button key={id} onClick={() => setYearSub(id)}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                  yearSub === id ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {yearSub === 'ytd' ? (
            <YearView
              monthlyRows={yearMonthlyRows}
              allocRows={yearAllocRows}
              expenses={expenses}
              year={c.now.getFullYear()}
              loading={yearLoading || !yearLoaded}
            />
          ) : (
            <TaxView
              bizTx={taxBizTx}
              bizExp={taxBizExp}
              bizSpend={taxBizSpend}
              subs={taxSubs}
              allocRows={yearAllocRows}
              year={taxYear}
              onYear={setTaxYear}
              availableYears={[c.now.getFullYear(), c.now.getFullYear() - 1, c.now.getFullYear() - 2]}
              loading={taxLoading || !taxLoaded || yearLoading || !yearLoaded}
            />
          )}
        </>
      )}

      {/* Tile grid — draggable */}
      {tab !== 'year' && (
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
      )}

      {/* Legend (tile tabs only) */}
      {tab !== 'year' && (
      <div className="mx-4 mt-4 bg-slate-900 rounded-xl px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600">
        <span><span className="text-emerald-500">✓</span> matches sheet</span>
        <span><span className="text-amber-400">⚠</span> &gt;2% diff</span>
        <span><span className="text-blue-400">ℹ</span> tap for formula</span>
        <span><span className="text-amber-400">✏</span> tap to override display</span>
        <span className="text-slate-700">drag tiles to reorder · saved per tab</span>
      </div>
      )}

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
