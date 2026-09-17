import { useState, useMemo, useEffect } from 'react';
import { appendRow, appendRows, readRange } from '../lib/sheets';
import { calcDeposits, policyFor, monthsLeft, isGas, splitSurplus, planRows, UNASSIGNED, UNASSIGNED_ACCOUNT, pm } from '../lib/allocation';
export { policyFor, monthsLeft };

const ACCOUNT_ICONS = {
  'Checking':        { icon: '🏧', color: 'text-blue-400',    bg: 'bg-blue-900/30 border-blue-800/40'     },
  'Outside Payment': { icon: '💸', color: 'text-purple-400',  bg: 'bg-purple-900/30 border-purple-800/40' },
  'Cash':            { icon: '💵', color: 'text-green-400',   bg: 'bg-green-900/30 border-green-800/40'   },
  'Savings':         { icon: '🐷', color: 'text-emerald-400', bg: 'bg-emerald-900/30 border-emerald-800/40'},
  'Business Tax':    { icon: '🧾', color: 'text-amber-400',   bg: 'bg-amber-900/30 border-amber-800/40'   },
  'Subscription':    { icon: '📱', color: 'text-rose-400',    bg: 'bg-rose-900/30 border-rose-800/40'     },
};

const PRIORITY_LABEL = { 1: 'Essential', 2: 'Stability', 3: 'Optional' };
const ACCOUNT_ORDER  = ['Checking', 'Outside Payment', 'Savings', 'Cash', 'Business Tax', 'Subscription'];

function fmt(n)  { return (n != null && !isNaN(n)) ? `$${Number(n).toFixed(2)}` : '—'; }

function todayStr() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// Google Sheets returns date cells as serial numbers with UNFORMATTED_VALUE
// (days since 1899-12-30). Also handles M/D/YYYY and YYYY-MM-DD strings.
function parseSheetDate(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  if (!isNaN(n) && n > 1000 && !String(val).includes('/')) {
    // Serial → calendar date. Sheets serials are UTC-midnight; rebuild as a LOCAL
    // noon date from the UTC calendar parts so getMonth()/getDate() never slip a
    // day back in negative-UTC (US) timezones — a 1st-of-month deposit must stay
    // in this month, not fall into last month and read as $0.
    const u = new Date(Math.round((n - 25569) * 86400000));
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 12, 0, 0);
  }
  const s = String(val);
  if (s.includes('-')) return new Date(s + 'T12:00:00');
  const parts = s.split('/');
  if (parts.length === 3)
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  return null;
}

function CoverageChip({ coverage }) {
  if (coverage >= 1)  return <span className="text-[10px] font-medium text-emerald-400 bg-emerald-900/40 px-1.5 py-0.5 rounded-full">✓ Full</span>;
  if (coverage > 0)   return <span className="text-[10px] font-medium text-amber-400  bg-amber-900/40  px-1.5 py-0.5 rounded-full">~ Partial</span>;
  return                     <span className="text-[10px] font-medium text-rose-400   bg-rose-900/40   px-1.5 py-0.5 rounded-full">✗ Unfunded</span>;
}

export default function ProcessIncome({ expenses, token, onClose, defaultIncome, onProcessed, gasBalance, gasBudget = null }) {
  const [income,        setIncome]       = useState(defaultIncome > 0 ? String(defaultIncome.toFixed(2)) : '');
  const [source,        setSource]       = useState('');
  const [mode,          setMode]         = useState('priority');
  const [logging,       setLogging]      = useState(false);
  const [done,          setDone]         = useState(false);
  const [logError,      setLogError]     = useState(null);
  const [copied,        setCopied]       = useState(false);
  const [alreadyByType, setAlreadyByType] = useState({});
  const [alreadyRows,   setAlreadyRows]  = useState([]);
  const [envStats,      setEnvStats]     = useState({});
  // Plans tab rows by lower-cased name: { target, saved, perMonth, targetDate } - the source of
  // target-date policies. Loaded alongside the log; absent tab = no target-date envelopes.
  const [plansByName,   setPlansByName]  = useState({});
  const [histLoading,   setHistLoading]  = useState(true);
  const [dueDates] = useState(() => {
    try { return JSON.parse(localStorage.getItem('_fin_due_dates') || '{}'); } catch { return {}; }
  });
  const todayDay = useMemo(() => new Date().getDate(), []);

  // balance type map: type name → 'monthly' | 'running'
  const [balTypes,      setBalTypes]     = useState({});
  const [showMore,      setShowMore]      = useState(false);   // templates / splits / buckets / month rows
  const [templates,     setTemplates]     = useState(() => {
    try { return JSON.parse(localStorage.getItem('income_templates') || '[]'); }
    catch { return []; }
  });
  const [showManageTpl, setShowManageTpl] = useState(false);
  const [newTplName,    setNewTplName]    = useState('');
  const [surplusItems,  setSurplusItems]  = useState(() => {
    try { return JSON.parse(localStorage.getItem('processIncome_surplusItems') || '[]'); }
    catch { return []; }
  });
  // Saved allocation splits (Task 80) — reusable "my usual split" presets, stored as
  // income-relative RATIOS ({ [type]: fraction }) so a split scales to any future
  // paycheck. Fractions only — no dollar amounts, nothing financial leaves the device.
  const [splits,        setSplits]        = useState(() => {
    try { return JSON.parse(localStorage.getItem('_fin_alloc_splits') || '[]'); }
    catch { return []; }
  });
  const [manageSplits,  setManageSplits]  = useState(false);
  const [showSaveSplit, setShowSaveSplit] = useState(false);
  const [newSplitName,  setNewSplitName]  = useState('');

  useEffect(() => {
    localStorage.setItem('income_templates', JSON.stringify(templates));
  }, [templates]);

  useEffect(() => {
    localStorage.setItem('_fin_alloc_splits', JSON.stringify(splits));
  }, [splits]);

  // Persist surplus contribution config
  useEffect(() => {
    localStorage.setItem('processIncome_surplusItems', JSON.stringify(surplusItems));
  }, [surplusItems]);

  // Load already-deposited / running-balance amounts per category.
  // Monthly items: sum positive "income processed" rows for current month only.
  // Running items: net of ALL transactions (all time, pos+neg) for that type.
  useEffect(() => {
    if (!token) { setHistLoading(false); return; }
    const mo = new Date().getMonth() + 1;
    const yr = new Date().getFullYear();

    let types = {};
    try { types = JSON.parse(localStorage.getItem('_fin_budget_balance_type') || '{}'); } catch {}
    setBalTypes(types);

    readRange(token, 'Plans!A:K', 'UNFORMATTED_VALUE')
      .then(rows => {
        const [head, ...data] = rows || [];
        if (!head) return;
        const col = n => head.findIndex(h => String(h).trim().toLowerCase() === n);
        const iName = col('name'), iTarget = col('target'), iSaved = col('saved'), iPer = col('per month'), iDate = col('target date'), iStatus = col('status');
        const byName = {};
        data.forEach(r => {
          const name = String(r[iName] || '').trim();
          if (!name) return;
          if (iStatus >= 0 && r[iStatus] && String(r[iStatus]).toLowerCase() !== 'active') return;
          byName[name.toLowerCase()] = {
            target: pm(r[iTarget]), saved: pm(r[iSaved]), perMonth: pm(r[iPer]),
            targetDate: iDate >= 0 ? parseSheetDate(r[iDate]) : null,
          };
        });
        setPlansByName(byName);
      })
      .catch(() => {});

    readRange(token, 'Allocation Transactions!A:F', 'UNFORMATTED_VALUE')
      .then(rows => {
        const [, ...data] = rows;
        const allValid = data.filter(r => r[0]);
        const map = {};
        const stats = {};

        allValid.forEach(r => {
          const type = String(r[1] || '');
          if (!type) return;
          const d = parseSheetDate(r[0]);
          if (!d) return;
          const amt = pm(r[2]);
          const isCurrentMonth = d.getMonth() + 1 === mo && d.getFullYear() === yr;

          const st = stats[type] || (stats[type] = { balance: 0, fundedMonth: 0, spentMonth: 0 });
          st.balance += amt;                                   // what the envelope holds now
          if (isCurrentMonth && amt > 0) st.fundedMonth += amt; // everything that landed in it this month
          if (isCurrentMonth && amt < 0) st.spentMonth += -amt; // everything that left it this month

          // Accrued this month = every deposit that landed in the envelope between the 1st
          // and the last day of the current month: a paycheck split, a manual "Funded -"
          // row, a reimbursement. (Counting only "Income processed" rows made the engine
          // fund an envelope twice after a manual top-up; an all-time "running" figure
          // made it skip envelopes that legitimately need this month's allowance.)
          if (isCurrentMonth && amt > 0) map[type] = (map[type] || 0) + amt;
        });

        setAlreadyByType(map);
        setEnvStats(stats);

        // Diagnostic row list: current-month income rows only (for header breakdown)
        setAlreadyRows(
          allValid.filter(r => {
            const d = parseSheetDate(r[0]);
            return d && d.getMonth() + 1 === mo && d.getFullYear() === yr
              && pm(r[2]) > 0
              && String(r[3] || '').toLowerCase().startsWith('income processed');
          })
        );
      })
      .catch(() => {})
      .finally(() => setHistLoading(false));
  }, [token]);

  const amount         = parseFloat(income) || 0;
  // Manual override (Task 77): let the user hand-steer where each dollar goes.
  // `overrides` = { [type]: editedAmountString }. Off by default → pure auto-split.
  const [manualMode, setManualMode] = useState(false);
  const [overrides,  setOverrides]  = useState({});
  const policies = useMemo(() => {
    const out = {};
    expenses.forEach(e => { out[e['Type'] || ''] = policyFor(e, plansByName, balTypes); });
    return out;
  }, [expenses, plansByName, balTypes]);
  const baseDeposits   = useMemo(
    () => calcDeposits(expenses, amount, mode, alreadyByType, gasBalance, gasBudget, envStats, policies),
    [expenses, amount, mode, alreadyByType, gasBalance, gasBudget, envStats, policies]
  );
  // In manual mode, each category's deposit can be overridden by hand; rows the user
  // hasn't touched keep their auto-suggested figure. Everything downstream (tier
  // totals, account tiles, surplus, the success count, the sheet write) reads
  // `deposits`, so a single manual edit flows through the whole modal + the log.
  const deposits = useMemo(() => {
    if (!manualMode) return baseDeposits;
    return baseDeposits.map(d => {
      const ov = overrides[d.type];
      if (ov === undefined || ov === '') return d;
      const dep      = Math.max(0, parseFloat(ov) || 0);
      const coverage = d.allowance > 0 ? (d.already + dep) / d.allowance : 0;
      return { ...d, deposit: dep, pct: amount > 0 ? dep / amount : 0, coverage };
    });
  }, [baseDeposits, manualMode, overrides, amount]);
  const gasDynamic     = typeof gasBudget === 'number' && gasBudget > 0;
  // The goal this deposit is measured against: each envelope's policy-aware target.
  const totalAllowance = baseDeposits.reduce((s, d) => s + d.allowance, 0);
  // Accrued toward each envelope's target under its policy (monthly window, running
  // balance, or target pace) - the same figures the engine fills against.
  const totalAlready   = baseDeposits.reduce((s, d) => s + d.already, 0);
  const totalHoldings  = expenses.reduce((s, e) => s + ((envStats[e['Type'] || ''] || {}).balance || 0), 0);
  const totalSpentMo   = expenses.reduce((s, e) => s + ((envStats[e['Type'] || ''] || {}).spentMonth || 0), 0);
  const fullEnvelopes  = deposits.filter(d => d.policy === 'monthly' && d.monthlyAllowance > 0 && d.balance >= d.monthlyAllowance).length;
  const deficitsRepaid = deposits.filter(d => d.deficitPaid > 0);
  const totalCovered   = totalAlready + amount;
  const stillNeeded    = Math.max(0, totalAllowance - totalCovered);
  const coveragePct    = totalAllowance > 0 ? (totalCovered / totalAllowance) * 100 : 0;

  const tierTotals = useMemo(() => {
    const t = { 1: { budget: 0, already: 0, deposit: 0 }, 2: { budget: 0, already: 0, deposit: 0 }, 3: { budget: 0, already: 0, deposit: 0 } };
    deposits.forEach(d => {
      const p = Math.min(Math.max(d.priority, 1), 3);
      t[p].budget  += d.allowance;
      t[p].already += d.already;
      t[p].deposit += d.deposit;
    });
    return t;
  }, [deposits]);

  const byAccount = useMemo(() => {
    const map = {};
    deposits.forEach(d => {
      if (!map[d.account]) map[d.account] = { items: [], total: 0 };
      map[d.account].items.push(d);
      map[d.account].total += d.deposit;
    });
    return map;
  }, [deposits]);

  // Surplus: income remaining after all budget goals are fully funded
  const totalDeposited = deposits.reduce((s, d) => s + d.deposit, 0);
  const surplus = Math.max(0, amount - totalDeposited);
  // Manual-mode running tally (signed): +ve = still to assign, −ve = over-assigned.
  const leftToAssign = amount - totalDeposited;
  const surplusTotalWeight = surplusItems.reduce((s, it) => s + (parseFloat(it.weight) || 0), 0);
  const { deposits: surplusDeposits, unassigned } = splitSurplus(surplus, surplusItems);
  // Manual mode can over-assign; the plan is then not whole and Process is blocked.
  const overAssigned = leftToAssign < -0.005;

  function addTemplate() {
    const amt = parseFloat(income);
    if (!amt || amt <= 0 || templates.length >= 8) return;
    const name = newTplName.trim() || fmt(amt);
    setTemplates(prev => [...prev, { id: Date.now().toString(36), name, amount: amt }]);
    setNewTplName('');
  }
  function deleteTemplate(id) {
    setTemplates(prev => prev.filter(t => t.id !== id));
  }

  // ── Saved allocation splits (Task 80) ──────────────────────────────────────
  // Capture the CURRENT per-category split (auto or hand-edited) as income-relative
  // ratios. `deposits` is the single source of truth, so this works in either mode.
  const MAX_SPLITS = 6;
  function saveSplit() {
    if (amount <= 0 || splits.length >= MAX_SPLITS) return;
    const ratios = {};
    deposits.forEach(d => { if (d.deposit > 0.005) ratios[d.type] = d.deposit / amount; });
    if (Object.keys(ratios).length === 0) return;
    const name = newSplitName.trim() || `Split ${splits.length + 1}`;
    setSplits(prev => [...prev, { id: Date.now().toString(36), name, ratios }]);
    setNewSplitName('');
    setShowSaveSplit(false);
  }
  // Apply a saved split: seed every override = ratio × current income, scaling the
  // saved plan to today's paycheck, and switch on manual mode so the user can tweak
  // before committing. Nothing is written until they process the income as usual.
  function applySplit(split) {
    if (!split?.ratios || amount <= 0) return;
    const next = {};
    Object.entries(split.ratios).forEach(([type, frac]) => {
      next[type] = (Math.max(0, Number(frac) || 0) * amount).toFixed(2);
    });
    setOverrides(next);
    setManualMode(true);
  }
  function deleteSplit(id) {
    setSplits(prev => prev.filter(s => s.id !== id));
  }

  function addSurplusItem() {
    setSurplusItems(prev => [...prev, {
      id: Math.random().toString(36).slice(2),
      name: '',
      account: 'Savings',
      weight: '1',
    }]);
  }
  function updateSurplusItem(id, key, val) {
    setSurplusItems(prev => prev.map(it => it.id === id ? { ...it, [key]: val } : it));
  }
  function removeSurplusItem(id) {
    setSurplusItems(prev => prev.filter(it => it.id !== id));
  }

  async function handleProcess() {
    if (!amount || !token) return;
    setLogging(true);
    setLogError(null);
    const date = todayStr();
    const desc = source
      ? `Income processed: ${fmt(amount)} from ${source}`
      : `Income processed: ${fmt(amount)}`;
    try {
      // One block write for the whole paycheck (see appendRows): all-or-nothing, and
      // planRows guarantees the block equals the paycheck to the cent or throws.
      const { rows } = planRows({ deposits, surplusDeposits, unassigned, amount, date, desc });
      await appendRows(token, 'Allocation Transactions!A:F', rows);
      setDone(true);
      onProcessed?.(amount);
    } catch (e) {
      setLogError(e.message);
    } finally {
      setLogging(false);
    }
  }

  function copyText() {
    const lines = [`Income: ${fmt(amount)}${source ? ` (${source})` : ''}`, `Mode: ${mode === 'priority' ? 'Priority-First' : 'Proportional'}`, ''];
    ACCOUNT_ORDER.forEach(acct => {
      const g = byAccount[acct];
      if (!g) return;
      lines.push(`${ACCOUNT_ICONS[acct]?.icon || ''} ${acct}: ${fmt(g.total)}`);
      g.items.forEach(d => lines.push(`  • ${d.type}: ${fmt(d.deposit)}${d.deficitPaid > 0 ? ` (deficit ${fmt(d.deficitPaid)} repaid first)` : ''} -> holds ${fmt(d.balance + d.deposit)} of ${fmt(d.allowance)} target`));
      lines.push('');
    });
    if (surplus > 0.01 && surplusDeposits.some(it => it.deposit > 0 && it.name?.trim())) {
      lines.push(`💰 Surplus: ${fmt(surplus)}`);
      surplusDeposits.forEach(it => {
        if (!it.name?.trim()) return;
        const wt = parseFloat(it.weight) || 0;
        const share = surplusTotalWeight > 0 ? ((wt / surplusTotalWeight) * 100).toFixed(0) : 0;
        lines.push(`  • ${it.name} (${it.account}): ${fmt(it.deposit)} — weight ${wt} = ${share}% of surplus`);
      });
    }
    if (unassigned >= 0.05) lines.push(`⏸ ${UNASSIGNED} (${UNASSIGNED_ACCOUNT}): ${fmt(unassigned)} — not needed by any envelope, parked`);
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Success ───────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-6">
        <div className="bg-slate-900 rounded-2xl p-8 max-w-sm w-full text-center space-y-4">
          <div className="text-5xl">✅</div>
          <h2 className="text-white text-xl font-bold">Income Processed!</h2>
          <p className="text-slate-400 text-sm">
            {deposits.filter(d => d.deposit > 0).length + surplusDeposits.filter(it => it.deposit > 0 && it.name?.trim()).length + (unassigned >= 0.05 ? 1 : 0)} deposits totalling{' '}
            <span className="text-emerald-400 font-semibold">{fmt(amount)}</span> logged using{' '}
            <span className="text-blue-400">{mode === 'priority' ? 'priority-first' : 'proportional'}</span> allocation
            {surplus > 0.01 && surplusDeposits.some(it => it.deposit > 0) && (
              <>, with <span className="text-emerald-400">{fmt(surplus)}</span> surplus distributed by weight</>
            )}
            {unassigned >= 0.05 && (
              <>, <span className="text-amber-300">{fmt(unassigned)}</span> parked in {UNASSIGNED} ({UNASSIGNED_ACCOUNT}) until you move it</>
            )}.
          </p>
          <button onClick={onClose} className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors">
            Done
          </button>
        </div>
      </div>
    );
  }

  // ── Consolidated view ──────────────────────────────────────────────────────
  // One ledger, one numbers strip, the controls on two rows, everything else behind
  // "More". The engine does the thinking (deficits first, then the mode); the page
  // shows what it decided and why, in columns, not in nine stacked panels.
  const money = (n) => (Math.abs(n) < 0.005 ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const money0 = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const deficitTotal = deposits.reduce((s, d) => s + (d.deficitPaid || 0), 0);
  const toEnvelopes  = totalDeposited - deficitTotal;
  const namedSurplus = surplusDeposits.filter(it => it.name?.trim() && it.deposit > 0.005);
  const policyMark = (d) => d.policy === 'running' ? 'R' : d.policy === 'target-date' ? 'T' : '';
  const accountsInPlan = ACCOUNT_ORDER.filter(a => byAccount[a]).concat(Object.keys(byAccount).filter(a => !ACCOUNT_ORDER.includes(a)));

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="modal-sheet bg-slate-900 w-full sm:max-w-2xl rounded-t-3xl sm:rounded-2xl flex flex-col max-h-[94dvh]">

        {/* Header: title + inputs + mode, compact */}
        <div className="p-4 border-b border-slate-700 shrink-0 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-bold text-lg">Process Income</h2>
            <button onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-white text-xl leading-none px-2">×</button>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-mono">$</span>
              <input
                type="number" inputMode="decimal" min="0" step="0.01"
                value={income} onChange={e => setIncome(e.target.value)} placeholder="0.00" autoFocus
                aria-label="Income amount"
                className="w-full bg-slate-800 text-white font-mono text-lg rounded-xl pl-7 pr-3 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 tabular-nums"
              />
            </div>
            <input
              value={source} onChange={e => setSource(e.target.value)} placeholder="from (employer)"
              aria-label="Income source"
              className="w-[42%] bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600"
            />
          </div>
          <div className="flex items-center gap-2 text-xs">
            <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
              <button onClick={() => setMode('priority')}
                title="Priority first: after deficits, fill every P1 envelope's remaining need, then P2, then P3."
                className={`px-3 py-1.5 rounded-md font-semibold transition-colors ${mode === 'priority' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Priority</button>
              <button onClick={() => setMode('proportional')}
                title="Proportional: after deficits, split the rest across all envelopes in proportion to their remaining need."
                className={`px-3 py-1.5 rounded-md font-semibold transition-colors ${mode === 'proportional' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Proportional</button>
            </div>
            <button onClick={() => { setManualMode(v => !v); if (manualMode) setOverrides({}); }}
              title="Edit any deposit by hand; untouched rows keep the engine's figure."
              className={`px-3 py-1.5 rounded-lg font-semibold transition-colors ${manualMode ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}>
              {manualMode ? '✎ Manual on' : '✎ Manual'}
            </button>
            {templates.length > 0 && !showMore && (
              <div className="flex gap-1 overflow-x-auto ml-auto">
                {templates.slice(0, 3).map(t => (
                  <button key={t.id} onClick={() => setIncome(String(t.amount.toFixed(2)))}
                    className="shrink-0 px-2 py-1 rounded-full bg-slate-800 text-slate-300 text-[11px] hover:bg-slate-700 font-mono">{t.name} {fmt(t.amount)}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0">

          {/* Numbers strip: what the engine decided, in one line of figures */}
          <div className="px-4 pt-3 pb-2 grid grid-cols-4 gap-2 text-center">
            {[
              ['Income', amount, 'text-white'],
              ['Deficits', deficitTotal, deficitTotal > 0 ? 'text-rose-300' : 'text-slate-500'],
              ['Envelopes', toEnvelopes, 'text-emerald-400'],
              ['Surplus', surplus, surplus > 0.005 ? 'text-amber-300' : 'text-slate-500'],
            ].map(([label, val, cls]) => (
              <div key={label} className="bg-slate-800/70 rounded-lg py-2">
                <p className="text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
                <p className={`font-mono tabular-nums text-sm font-bold ${cls}`}>{amount > 0 ? money0(val) : '—'}</p>
              </div>
            ))}
          </div>
          <p className="px-4 pb-2 text-[11px] text-slate-500">
            {histLoading ? 'Loading this month…' : (
              <>
Accrued toward targets <span className="text-slate-300 font-mono">{money0(totalAlready)}</span> of <span className="text-slate-300 font-mono">{money0(totalAllowance)}</span>
                {' '}· envelopes hold <span className="text-slate-300 font-mono">{money0(totalHoldings)}</span>
                {totalSpentMo > 0 && <> · spent <span className="text-slate-300 font-mono">{money0(totalSpentMo)}</span> this month</>}
                {deficitsRepaid.length > 0 && amount > 0 && (
                  <> · <span className="text-rose-300">deficit {deficitsRepaid.map(d => `${d.type} ${money0(d.deficitPaid)}`).join(', ')} taken off the top first</span></>
                )}
                {manualMode && amount > 0 && (
                  <> · <span className={leftToAssign < -0.005 ? 'text-rose-400' : leftToAssign > 0.005 ? 'text-amber-300' : 'text-emerald-400'}>
                    {leftToAssign < -0.005 ? `${money0(-leftToAssign)} over-assigned` : leftToAssign > 0.005 ? `${money0(leftToAssign)} left to assign` : 'fully assigned'}
                  </span></>
                )}
              </>
            )}
          </p>

          {/* THE LEDGER */}
          <div className="mx-4 mb-3 rounded-xl border border-slate-700/60 overflow-hidden">
            <table className="w-full table-fixed text-xs tabular-nums">
              {/* Widths live on the header cells (table-fixed). Need = Target - Accrued is
                  derivable, so it yields its column to the envelope name on phones. */}
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-slate-500 bg-slate-800/80">
                  <th className="text-left px-2 py-1.5 font-medium">Envelope</th>
                  <th className="text-right px-1 py-1.5 font-medium w-[3.9rem] sm:w-[4.4rem]" title="What the envelope is aiming at this month: its allowance, or the total budget for a running envelope, or this month's share of a dated target">Target</th>
                  <th className="text-right px-1 py-1.5 font-medium w-[3.9rem] sm:w-[4.4rem]" title="What already counts toward the target: this calendar month's deposits (running: the balance itself)">Accrued</th>
                  <th className="text-right px-1 py-1.5 font-medium hidden sm:table-cell sm:w-[4.4rem]">Need</th>
                  <th className={`text-right px-1 py-1.5 font-medium text-emerald-400 ${manualMode ? 'w-[4.8rem] sm:w-[5.4rem]' : 'w-[3.9rem] sm:w-[4.6rem]'}`}>Deposit</th>
                  <th className="text-right pl-1 pr-2 py-1.5 font-medium w-[4.4rem] sm:w-[4.8rem]" title="What the envelope will hold after this deposit">After</th>
                </tr>
              </thead>
              {accountsInPlan.map(acct => {
                const group = byAccount[acct];
                const style = ACCOUNT_ICONS[acct] || { icon: '💰', color: 'text-slate-300' };
                return (
                  <tbody key={acct} className="border-t border-slate-700/60">
                    <tr className="bg-slate-900/60">
                      <td colSpan={3} className={`px-2 py-1 text-[10px] font-semibold ${style.color}`}>{style.icon} {acct}</td>
                      <td className="hidden sm:table-cell"></td>
                      <td className="px-1 py-1 text-right text-[10px] font-mono text-emerald-400/90">{amount > 0 ? money(group.total) : ''}</td>
                      <td></td>
                    </tr>
                    {group.items.map(d => {
                      const after = d.balance + d.deposit;
                      const met = d.allowance > 0 && d.already + d.deposit >= d.allowance - 0.005;
                      const due = dueDates[d.type] != null && d.stillNeeds > 0 ? dueDates[d.type] - todayDay : null;
                      return (
                        <tr key={d.type} className="border-t border-slate-700/30">
                          <td className="px-2 py-1.5 min-w-0">
                            <div className="flex items-center gap-1 min-w-0">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.priority === 1 ? 'bg-rose-400' : d.priority === 2 ? 'bg-amber-400' : 'bg-violet-400'}`} title={`P${d.priority} ${PRIORITY_LABEL[d.priority] || ''}`} />
                              <span className="text-slate-200 truncate">{d.type}</span>
                              {policyMark(d) && (
                                <span className={`shrink-0 text-[9px] px-1 rounded ${d.policy === 'running' ? 'bg-sky-900/70 text-sky-300' : 'bg-fuchsia-900/70 text-fuchsia-300'}`}
                                  title={d.policy === 'running' ? 'Running balance: the balance counts toward the total budget' : d.pace ? `${fmt(d.pace.remaining)} to collect for ${fmt(d.pace.target)} in ${d.pace.monthsLeft} month(s)` : 'Target by date'}>
                                  {policyMark(d)}
                                </span>
                              )}
                              {d.deficitPaid > 0 && <span className="shrink-0 text-[9px] px-1 rounded bg-rose-900/70 text-rose-300" title="Deficit repaid first, before allocation">−{money0(d.deficitPaid)} first</span>}
                              {due != null && due <= 3 && <span className="shrink-0 text-[9px] text-amber-400" title={due < 0 ? 'Past due' : due === 0 ? 'Due today' : `Due in ${due} days`}>{due < 0 ? '⚠' : '⏰'}</span>}
                            </div>
                            <div className="text-[9px] text-slate-500 truncate">
                              {d.priority === 1 ? 'P1' : d.priority === 2 ? 'P2' : 'P3'} · holds {money0(d.balance)}{d.policy === 'monthly' && d.monthlyAllowance > 0 && d.balance > 0 ? ` · ${(d.balance / d.monthlyAllowance).toFixed(1)}× mo` : ''}{d.spentMonth > 0 ? ` · spent ${money0(d.spentMonth)}` : ''}
                            </div>
                          </td>
                          <td className="px-1 py-1.5 text-right font-mono text-slate-300 align-top">{money0(d.allowance)}</td>
                          <td className={`px-1 py-1.5 text-right font-mono align-top ${d.already < 0 ? 'text-rose-300' : 'text-slate-400'}`}>{d.already < 0 ? `(${money0(-d.already)})` : money(d.already)}</td>
                          <td className="px-1 py-1.5 text-right font-mono text-slate-400 align-top hidden sm:table-cell">{money(d.stillNeeds + (d.deficitPaid || 0))}</td>
                          <td className="px-1 py-1.5 text-right font-mono align-top">
                            {manualMode ? (
                              <input type="number" inputMode="decimal" min="0" step="0.01"
                                aria-label={`Deposit for ${d.type}`}
                                value={overrides[d.type] ?? d.deposit.toFixed(2)}
                                onChange={e => setOverrides(o => ({ ...o, [d.type]: e.target.value }))}
                                className={`w-full bg-slate-800 rounded px-1 py-0.5 text-right font-mono text-xs outline-none focus:ring-1 focus:ring-amber-500 ${overrides[d.type] !== undefined ? 'text-amber-300' : 'text-emerald-400'}`} />
                            ) : (
                              <span className={d.deposit > 0.005 ? 'text-emerald-400 font-semibold' : 'text-slate-600'}>{money(d.deposit)}</span>
                            )}
                          </td>
                          <td className={`pl-1 pr-2 py-1.5 text-right font-mono align-top ${after < 0 ? 'text-rose-300' : met ? 'text-emerald-300' : 'text-slate-300'}`} title={met ? 'Target met' : ''}>{money0(after)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
              {(namedSurplus.length > 0 || unassigned >= 0.05) && (
                <tbody className="border-t border-slate-700/60">
                  <tr className="bg-slate-900/60"><td colSpan={3} className="px-2 py-1 text-[10px] font-semibold text-amber-300">💰 Surplus{namedSurplus.length > 0 ? ' (by weight)' : ''}</td><td className="hidden sm:table-cell"></td><td className="px-1 py-1 text-right text-[10px] font-mono text-amber-300">{money(surplus)}</td><td></td></tr>
                  {namedSurplus.map(it => (
                    <tr key={it.id} className="border-t border-slate-700/30">
                      <td className="px-2 py-1.5 text-slate-200 truncate">{it.name.trim()} <span className="text-slate-500 text-[9px]">· {it.account || 'Savings'} · ×{it.weight}</span></td>
                      <td colSpan={2}></td>
                      <td className="hidden sm:table-cell"></td>
                      <td className="px-1 py-1.5 text-right font-mono text-amber-300">{money0(it.deposit)}</td>
                      <td></td>
                    </tr>
                  ))}
                  {unassigned >= 0.05 && (
                    <tr className="border-t border-slate-700/30">
                      <td className="px-2 py-1.5 text-slate-200 truncate" title="No envelope needs it and no bucket claims it; logged so the month's income stays whole. Move it from the Budget page.">{UNASSIGNED} <span className="text-slate-500 text-[9px]">· {UNASSIGNED_ACCOUNT} · parked</span></td>
                      <td colSpan={2}></td>
                      <td className="hidden sm:table-cell"></td>
                      <td className="px-1 py-1.5 text-right font-mono text-amber-300">{money0(unassigned)}</td>
                      <td></td>
                    </tr>
                  )}
                </tbody>
              )}
              <tfoot>
                <tr className="border-t-2 border-slate-600 bg-slate-800/90 font-semibold">
                  <td className="px-2 py-2 text-slate-300">Total <span className="text-slate-500 font-normal">({deposits.filter(d => d.deposit > 0.005).length + namedSurplus.length + (unassigned >= 0.05 ? 1 : 0)} deposits)</span></td>
                  <td className="px-1 py-2 text-right font-mono text-slate-300">{money0(totalAllowance)}</td>
                  <td className="px-1 py-2 text-right font-mono text-slate-400">{money0(totalAlready)}</td>
                  <td className="px-1 py-2 text-right font-mono text-slate-400 hidden sm:table-cell">{money0(deposits.reduce((s, d) => s + d.stillNeeds + (d.deficitPaid || 0), 0))}</td>
                  <td className="px-1 py-2 text-right font-mono text-emerald-400">{amount > 0 ? money0(totalDeposited + namedSurplus.reduce((s, it) => s + it.deposit, 0) + unassigned) : '—'}</td>
                  <td className="pl-1 pr-2 py-2 text-right font-mono text-white">{money0(totalHoldings + totalDeposited)}</td>
                </tr>
              </tfoot>
            </table>
            <p className="px-2 py-1.5 text-[9px] text-slate-500 border-t border-slate-700/40 leading-snug">
              Accrued = this calendar month's deposits (R = running: the balance itself; T = dated target, target is this month's share).
              A negative accrued is a deficit, repaid first in any mode. Need = target − accrued. After = holds + deposit.
            </p>
          </div>

          {/* More: templates, splits, surplus buckets, this month's rows */}
          <div className="mx-4 mb-4">
            <button onClick={() => setShowMore(v => !v)} className="w-full text-left text-[11px] text-slate-500 hover:text-slate-300 py-1.5">
              {showMore ? '▾' : '▸'} More — quick-fill, saved splits, surplus buckets, this month's rows
              {unassigned >= 0.05 && <span className="text-amber-300"> · {money0(unassigned)} will be parked in {UNASSIGNED} (add buckets to place it)</span>}
            </button>
            {showMore && (
              <div className="space-y-4 text-xs pt-1">
                {/* Quick-fill templates */}
                <div>
                  <div className="flex items-center mb-1.5">
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider flex-1">Quick fill</p>
                    <button onClick={() => setShowManageTpl(v => !v)} className="text-slate-600 text-[10px] hover:text-slate-400">{showManageTpl ? 'Done' : '⚙ Manage'}</button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {templates.map(t => (
                      <span key={t.id} className="inline-flex items-center gap-1">
                        <button onClick={() => setIncome(String(t.amount.toFixed(2)))} className="px-2 py-1 rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700 font-mono">{t.name} {fmt(t.amount)}</button>
                        {showManageTpl && <button onClick={() => deleteTemplate(t.id)} className="w-4 h-4 rounded-full bg-slate-700 text-slate-500 hover:text-rose-400 text-[10px]">✕</button>}
                      </span>
                    ))}
                    {showManageTpl && templates.length < 8 && (
                      <span className="inline-flex gap-1">
                        <input value={newTplName} onChange={e => setNewTplName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTemplate()} placeholder="name for current amount"
                          className="bg-slate-800 text-white rounded-lg px-2 py-1 outline-none focus:ring-1 focus:ring-emerald-500 placeholder-slate-600 w-40" />
                        <button onClick={addTemplate} disabled={!income || parseFloat(income) <= 0 || templates.length >= 8} className="px-2 py-1 rounded-lg bg-emerald-700 disabled:opacity-40 text-white">Add</button>
                      </span>
                    )}
                    {templates.length === 0 && !showManageTpl && <span className="text-slate-600">none — ⚙ Manage to add the amounts you process often</span>}
                  </div>
                </div>

                {/* Saved splits */}
                <div>
                  <div className="flex items-center mb-1.5">
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider flex-1">Saved splits (manual mode)</p>
                    {splits.length > 0 && <button onClick={() => setManageSplits(v => !v)} className="text-slate-600 text-[10px] hover:text-slate-400">{manageSplits ? 'Done' : '⚙ Manage'}</button>}
                  </div>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {splits.map(sp => (
                      <span key={sp.id} className="inline-flex items-center gap-1">
                        <button onClick={() => applySplit(sp)} className="px-2 py-1 rounded-full bg-indigo-900/50 text-indigo-200 hover:bg-indigo-900">{sp.name}</button>
                        {manageSplits && <button onClick={() => deleteSplit(sp.id)} aria-label={`Delete split ${sp.name}`} className="w-4 h-4 rounded-full bg-slate-700 text-slate-500 hover:text-rose-400 text-[10px]">✕</button>}
                      </span>
                    ))}
                    {showSaveSplit ? (
                      <span className="inline-flex gap-1">
                        <input value={newSplitName} onChange={e => setNewSplitName(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveSplit()} placeholder="split name"
                          className="bg-slate-800 text-white rounded-lg px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-500 placeholder-slate-600 w-32" />
                        <button onClick={saveSplit} disabled={splits.length >= MAX_SPLITS || totalDeposited <= 0.005} className="px-2 py-1 rounded-lg bg-indigo-700 disabled:opacity-40 text-white">Save</button>
                        <button onClick={() => { setShowSaveSplit(false); setNewSplitName(''); }} aria-label="Cancel saving this split" className="px-2 py-1 rounded-lg bg-slate-700 text-slate-400">✕</button>
                      </span>
                    ) : (
                      splits.length < MAX_SPLITS && totalDeposited > 0.005 && (
                        <button onClick={() => setShowSaveSplit(true)} className="text-indigo-400 hover:text-indigo-300">+ save current split</button>
                      )
                    )}
                    {splits.length === 0 && !showSaveSplit && totalDeposited <= 0.005 && <span className="text-slate-600">none saved</span>}
                  </div>
                </div>

                {/* Surplus buckets */}
                <div>
                  <div className="flex items-center mb-1.5">
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider flex-1" title="Income left after every envelope's need is met is split across these buckets by weight (share = weight ÷ total weight).">Surplus buckets</p>
                    <button onClick={addSurplusItem} className="text-slate-600 text-[10px] hover:text-slate-400">+ bucket</button>
                  </div>
                  {surplusItems.length === 0 ? (
                    <p className="text-slate-600">none — surplus stays unassigned</p>
                  ) : (
                    <div className="space-y-1.5">
                      {surplusItems.map(it => {
                        const weight = parseFloat(it.weight) || 0;
                        const share  = surplusTotalWeight > 0 ? weight / surplusTotalWeight : 0;
                        return (
                          <div key={it.id} className="flex gap-1.5 items-center">
                            <input value={it.name} onChange={e => updateSurplusItem(it.id, 'name', e.target.value)} placeholder="bucket name"
                              className="flex-1 min-w-0 bg-slate-800 text-white rounded-lg px-2 py-1 outline-none focus:ring-1 focus:ring-emerald-500 placeholder-slate-600" />
                            <select value={it.account} onChange={e => updateSurplusItem(it.id, 'account', e.target.value)} className="bg-slate-800 text-white rounded-lg px-1.5 py-1 outline-none w-24">
                              {ACCOUNT_ORDER.map(a => <option key={a}>{a}</option>)}
                            </select>
                            <input type="number" min="0" step="1" value={it.weight} onChange={e => updateSurplusItem(it.id, 'weight', e.target.value)} aria-label="weight"
                              className="w-12 bg-slate-800 text-white rounded-lg px-1.5 py-1 text-right font-mono outline-none" />
                            <span className="w-10 text-right text-slate-500 font-mono">{(share * 100).toFixed(0)}%</span>
                            <button onClick={() => removeSurplusItem(it.id)} className="w-6 h-6 rounded-lg bg-slate-800 text-slate-500 hover:text-rose-400">✕</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* This month's deposits so far */}
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1.5">Deposited this month ({alreadyRows.length} rows)</p>
                  {alreadyRows.length === 0 ? <p className="text-slate-600">nothing yet this month</p> : (
                    <div className="max-h-40 overflow-y-auto space-y-0.5 font-mono text-[11px]">
                      {alreadyRows.map((r, i) => (
                        <div key={i} className="flex gap-2">
                          <span className="text-slate-500 w-16 shrink-0">{typeof r[0] === 'number' ? (parseSheetDate(r[0]) ? `${parseSheetDate(r[0]).getMonth() + 1}/${parseSheetDate(r[0]).getDate()}` : '') : String(r[0]).slice(0, 5)}</span>
                          <span className="text-slate-300 truncate flex-1">{r[1]}</span>
                          <span className="text-emerald-400 shrink-0">{money0(pm(r[2]))}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="p-3 border-t border-slate-700 flex gap-2 shrink-0 items-center">
          {logError && <p className="text-rose-400 text-xs flex-1 truncate" title={logError}>{logError}</p>}
          {!logError && <p className="text-slate-500 text-[11px] flex-1 truncate">{amount > 0 ? `${mode === 'priority' ? 'Priority' : 'Proportional'} · ${money0(totalDeposited + namedSurplus.reduce((s, it) => s + it.deposit, 0))} placed${unassigned >= 0.05 ? ` · ${money0(unassigned)} parked` : ''} of ${money0(amount)}` : 'Enter an amount to see the plan'}</p>}
          <button onClick={copyText} disabled={!(amount > 0)} className="py-2.5 px-3 rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-sm">{copied ? '✓' : '📋'}</button>
          <button
            onClick={handleProcess}
            disabled={logging || histLoading || !(amount > 0) || overAssigned}
            title={overAssigned ? `Assigned ${fmt(-leftToAssign)} more than the paycheck - reduce a deposit first` : undefined}
            className="py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-bold transition-colors"
          >
            {logging ? 'Logging…' : `✓ Process ${deposits.filter(d => d.deposit > 0.005).length + namedSurplus.length + (unassigned >= 0.05 ? 1 : 0)} deposits`}
          </button>
        </div>
      </div>
    </div>
  );
}
