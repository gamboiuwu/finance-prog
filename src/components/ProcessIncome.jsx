import { useState, useMemo, useEffect } from 'react';
import { appendRow, readRange } from '../lib/sheets';

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
function pm(val) { const n = parseFloat(String(val || '').replace(/[$,\s]/g, '')); return isNaN(n) ? 0 : n; }

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
    // Serial → JS Date (UTC epoch offset from Sheets epoch 1899-12-30)
    return new Date(Math.round((n - 25569) * 86400000));
  }
  const s = String(val);
  if (s.includes('-')) return new Date(s + 'T12:00:00');
  const parts = s.split('/');
  if (parts.length === 3)
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  return null;
}

// Case/whitespace-insensitive Gas match — the sheet may store "gas" or " Gas ".
// Must agree with Budget.jsx so the gas-balance override never silently misses.
const isGas = (type) => String(type || '').trim().toLowerCase() === 'gas';

// Deposits fill each category's *remaining gap* (goal minus already contributed).
// Priority mode: fill P1 gaps before P2, then P3.
// Proportional mode: distribute proportionally across remaining gaps.
// gasBalance: all-time running net for Gas (from Dashboard); if provided, Gas uses this
// instead of the monthly-only allocated amount so we never over-deposit into Gas.
function calcDeposits(expenses, income, mode, alreadyByType = {}, gasBalance = null, gasBudget = null) {
  if (!income) return [];
  const isGasDynamic = typeof gasBudget === 'number' && !isNaN(gasBudget) && gasBudget > 0;
  const eligible = expenses
    // Gas is always eligible when we have a live dynamic budget, even if the sheet
    // allowance is 0/stale — the real target comes from the gas price.
    .filter(e => pm(e['Monthly Allowance ($)']) > 0 || (isGas(e['Type']) && isGasDynamic))
    .map(e => {
      // Gas uses the live dynamic budget (scales with gas price) instead of the
      // static sheet allowance, so the target is the ~$185 reserve, not $120.
      const allowance  = (isGas(e['Type']) && isGasDynamic)
        ? gasBudget
        : pm(e['Monthly Allowance ($)']);
      const already    = (isGas(e['Type']) && typeof gasBalance === 'number' && !isNaN(gasBalance))
        ? Math.max(0, gasBalance)  // use all-time net so balance > allowance → stillNeeds = 0
        : (alreadyByType[e['Type'] || ''] || 0);
      const stillNeeds = Math.max(0, allowance - already);
      return {
        type:      e['Type']    || '',
        account:   e['Account'] || 'Other',
        expense:   e['Expense'] || '',
        priority:  parseInt(e['Priority']) || 2,
        allowance,
        already,
        stillNeeds,
      };
    })
    .sort((a, b) => a.priority - b.priority || b.allowance - a.allowance);

  if (mode === 'proportional') {
    const totalNeeds = eligible.reduce((s, e) => s + e.stillNeeds, 0);
    return eligible.map(e => {
      const deposit  = totalNeeds > 0 ? Math.min(e.stillNeeds, (e.stillNeeds / totalNeeds) * income) : 0;
      const coverage = e.allowance > 0 ? (e.already + deposit) / e.allowance : 0;
      return { ...e, deposit, pct: income > 0 ? deposit / income : 0, coverage };
    });
  }

  // Priority-first: fill each category's remaining gap before moving to lower priorities
  let remaining = income;
  return eligible.map(e => {
    const deposit  = Math.min(e.stillNeeds, Math.max(0, remaining));
    remaining      = Math.max(0, remaining - deposit);
    const coverage = e.allowance > 0 ? (e.already + deposit) / e.allowance : 0;
    return { ...e, deposit, pct: income > 0 ? deposit / income : 0, coverage };
  });
}

function CoverageChip({ coverage }) {
  if (coverage >= 1)  return <span className="text-[10px] font-medium text-emerald-400 bg-emerald-900/40 px-1.5 py-0.5 rounded-full">✓ Full</span>;
  if (coverage > 0)   return <span className="text-[10px] font-medium text-amber-400  bg-amber-900/40  px-1.5 py-0.5 rounded-full">~ Partial</span>;
  return                     <span className="text-[10px] font-medium text-rose-400   bg-rose-900/40   px-1.5 py-0.5 rounded-full">✗ Unfunded</span>;
}

export default function ProcessIncome({ expenses, token, alreadyProcessed = 0, onClose, defaultIncome, onProcessed, gasBalance, gasBudget = null }) {
  const [income,        setIncome]       = useState(defaultIncome > 0 ? String(defaultIncome.toFixed(2)) : '');
  const [source,        setSource]       = useState('');
  const [mode,          setMode]         = useState('priority');
  const [logging,       setLogging]      = useState(false);
  const [done,          setDone]         = useState(false);
  const [logError,      setLogError]     = useState(null);
  const [copied,        setCopied]       = useState(false);
  const [alreadyByType, setAlreadyByType] = useState({});
  const [alreadyRows,   setAlreadyRows]  = useState([]);
  const [histLoading,   setHistLoading]  = useState(true);
  const [dueDates] = useState(() => {
    try { return JSON.parse(localStorage.getItem('_fin_due_dates') || '{}'); } catch { return {}; }
  });
  const todayDay = useMemo(() => new Date().getDate(), []);

  // balance type map: type name → 'monthly' | 'running'
  const [balTypes,      setBalTypes]     = useState({});
  const [showBreakdown, setShowBreakdown] = useState(false);
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

  useEffect(() => {
    localStorage.setItem('income_templates', JSON.stringify(templates));
  }, [templates]);

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

    readRange(token, 'Allocation Transactions!A:F', 'UNFORMATTED_VALUE')
      .then(rows => {
        const [, ...data] = rows;
        const allValid = data.filter(r => r[0]);
        const map = {};

        allValid.forEach(r => {
          const type = String(r[1] || '');
          if (!type) return;
          const d = parseSheetDate(r[0]);
          if (!d) return;
          const amt = pm(r[2]);
          const isCurrentMonth = d.getMonth() + 1 === mo && d.getFullYear() === yr;
          const isIncomeRow    = String(r[3] || '').toLowerCase().startsWith('income processed');

          if ((types[type] || 'monthly') === 'running') {
            // All-time net: count every positive deposit AND every negative spend
            map[type] = (map[type] || 0) + amt;
          } else {
            // Monthly: only current-month income-processed deposits
            if (isCurrentMonth && amt > 0 && isIncomeRow) {
              map[type] = (map[type] || 0) + amt;
            }
          }
        });

        setAlreadyByType(map);

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
  const deposits       = useMemo(
    () => calcDeposits(expenses, amount, mode, alreadyByType, gasBalance, gasBudget),
    [expenses, amount, mode, alreadyByType, gasBalance, gasBudget]
  );
  const gasDynamic     = typeof gasBudget === 'number' && gasBudget > 0;
  const totalAllowance = expenses.reduce((s, e) => {
    // Gas contributes its live dynamic budget to the monthly goal, not the static sheet value.
    if (isGas(e['Type']) && gasDynamic) return s + gasBudget;
    return s + pm(e['Monthly Allowance ($)']);
  }, 0);
  // "Already" must use the gas all-time balance for Gas (not the monthly alloc map),
  // mirroring calcDeposits — otherwise the header "% covered" double-counts gas.
  const hasGasItem     = expenses.some(e => isGas(e['Type']));
  const totalAlready   = Object.entries(alreadyByType).reduce((s, [t, v]) => isGas(t) ? s : s + v, 0)
    + (hasGasItem && typeof gasBalance === 'number' && !isNaN(gasBalance) ? Math.max(0, gasBalance) : 0);
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
  const surplusTotalWeight = surplusItems.reduce((s, it) => s + (parseFloat(it.weight) || 0), 0);
  const surplusDeposits = surplusItems.map(it => {
    const weight = parseFloat(it.weight) || 0;
    const deposit = surplusTotalWeight > 0 && surplus > 0 ? (weight / surplusTotalWeight) * surplus : 0;
    return { ...it, deposit };
  });

  // Flat "where the money goes" receipt — every line that actually receives money,
  // budget deposits + named surplus buckets, biggest first. Used for the summary list.
  const depositPlan = useMemo(() => {
    const rows = deposits
      .filter(d => d.deposit > 0.005)
      .map(d => ({ name: d.type, account: d.account, amount: d.deposit, priority: d.priority, kind: 'budget' }));
    surplusDeposits.forEach(it => {
      if (it.name?.trim() && it.deposit > 0.005) {
        rows.push({ name: it.name.trim(), account: it.account || 'Savings', amount: it.deposit, priority: 4, kind: 'surplus' });
      }
    });
    return rows.sort((a, b) => b.amount - a.amount);
  }, [deposits, surplusDeposits]);

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
      for (const d of deposits) {
        if (d.deposit <= 0) continue;
        await appendRow(token, 'Allocation Transactions!A:F', [
          date, d.type, parseFloat(d.deposit.toFixed(2)), desc, d.account, true,
        ]);
      }
      for (const it of surplusDeposits) {
        if (it.deposit <= 0 || !it.name?.trim()) continue;
        await appendRow(token, 'Allocation Transactions!A:F', [
          date, it.name.trim(), parseFloat(it.deposit.toFixed(2)), desc + ' [surplus]', it.account, true,
        ]);
      }
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
      g.items.forEach(d => lines.push(`  • ${d.type}: ${fmt(d.deposit)} (${(d.coverage * 100).toFixed(0)}% funded, ${fmt(d.already)} prior)`));
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
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Per-account totals: already this month + being added now
  const accountTiles = useMemo(() => {
    const map = {};
    deposits.forEach(d => {
      if (!map[d.account]) map[d.account] = { adding: 0, already: 0 };
      map[d.account].adding  += d.deposit;
      map[d.account].already += d.already;
    });
    surplusDeposits.forEach(it => {
      if (!it.name?.trim() || it.deposit <= 0) return;
      const acct = it.account || 'Savings';
      if (!map[acct]) map[acct] = { adding: 0, already: 0 };
      map[acct].adding += it.deposit;
    });
    return ACCOUNT_ORDER
      .filter(a => map[a])
      .map(a => ({ name: a, ...map[a], style: ACCOUNT_ICONS[a] || { icon: '💰', color: 'text-slate-300', bg: 'bg-slate-800 border-slate-700' } }));
  }, [deposits, surplusDeposits]);

  // ── Success ───────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-6">
        <div className="bg-slate-900 rounded-2xl p-8 max-w-sm w-full text-center space-y-4">
          <div className="text-5xl">✅</div>
          <h2 className="text-white text-xl font-bold">Income Processed!</h2>
          <p className="text-slate-400 text-sm">
            {deposits.filter(d => d.deposit > 0).length + surplusDeposits.filter(it => it.deposit > 0 && it.name?.trim()).length} deposits totalling{' '}
            <span className="text-emerald-400 font-semibold">{fmt(amount)}</span> logged using{' '}
            <span className="text-blue-400">{mode === 'priority' ? 'priority-first' : 'proportional'}</span> allocation
            {surplus > 0.01 && surplusDeposits.some(it => it.deposit > 0) && (
              <>, with <span className="text-emerald-400">{fmt(surplus)}</span> surplus distributed by weight</>
            )}.
          </p>
          <button onClick={onClose} className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="flex w-full sm:max-w-4xl sm:gap-5 items-end sm:items-start justify-center">

      {/* ── Right panel: account tiles (desktop only) ── */}
      {amount > 0 && accountTiles.length > 0 && (
        <div className="hidden sm:flex flex-col justify-center gap-3 w-56 shrink-0 self-center">
          <p className="text-slate-500 text-[10px] uppercase tracking-wider text-center">By Account</p>
          <div className="grid grid-cols-2 gap-3">
            {accountTiles.map(a => (
              <div key={a.name} className={`rounded-2xl p-3 border ${a.style.bg} flex flex-col items-center text-center gap-1`}>
                <span className="text-2xl">{a.style.icon}</span>
                <p className={`text-[11px] font-bold ${a.style.color} leading-tight`}>{a.name}</p>
                <p className="text-white font-bold font-mono tabular-nums text-sm">+{fmt(a.adding)}</p>
                {a.already > 0 && (
                  <p className="text-slate-500 font-mono text-[10px] tabular-nums">{fmt(a.already)} prior</p>
                )}
                <p className={`font-mono text-[11px] font-semibold tabular-nums ${a.style.color}`}>{fmt(a.adding + a.already)} total</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="modal-sheet bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl flex flex-col max-h-[94dvh]">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-white font-bold text-lg">Process Income</h2>
            {histLoading ? (
              <p className="text-slate-400 text-xs mt-0.5">Loading month history…</p>
            ) : (
              <button
                onClick={() => setShowBreakdown(v => !v)}
                className="text-left mt-0.5"
              >
                <p className="text-slate-400 text-xs underline decoration-dotted underline-offset-2">
                  {fmt(totalAlready)} covered (deposits + running balances)
                  <span className="text-slate-600 ml-1">({alreadyRows.length} rows this month) {showBreakdown ? '▲' : '▼'}</span>
                </p>
              </button>
            )}
            {showBreakdown && (
              <div className="mt-2 bg-slate-800 rounded-xl p-3 space-y-1 text-xs max-h-48 overflow-y-auto">
                {alreadyRows.length === 0 ? (
                  <p className="text-slate-500">No rows found for this month.</p>
                ) : (
                  alreadyRows.map((r, i) => (
                    <div key={i} className="flex justify-between items-center gap-2 text-[11px]">
                      <span className="text-slate-500 shrink-0 font-mono">{String(r[0]).slice(0,10)}</span>
                      <span className="text-slate-300 truncate flex-1">{r[1] || '—'}</span>
                      <span className="text-white font-mono tabular-nums shrink-0">{fmt(pm(r[2]))}</span>
                      {r[4] && <span className="text-slate-600 shrink-0 text-[10px] truncate max-w-[80px]">{r[4]}</span>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-700 text-slate-300 hover:bg-slate-600 flex items-center justify-center">✕</button>
        </div>

        {/* Allocation mode toggle */}
        <div className="px-5 pt-4 shrink-0">
          <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-2">Allocation Mode</p>
          <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
            <button
              onClick={() => setMode('priority')}
              title="Priority First: Fills P1 (Essential) categories completely before moving to P2, then P3. Ensures rent and critical expenses are always covered first. Any income left after all goals are met becomes surplus and can be distributed by weight (see Surplus Distribution below)."
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                mode === 'priority' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              🎯 Priority First
            </button>
            <button
              onClick={() => setMode('proportional')}
              title="Proportional: Splits income across all categories at once, proportional to their share of total remaining need. E.g. if Rent needs $800 and Food needs $200 (total $1000 needed) and you have $500, Rent gets $400 and Food gets $100. Fair distribution, but may leave essential bills partially unfunded if income is low."
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                mode === 'proportional' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              ⚖️ Proportional
            </button>
          </div>
          <p className="text-slate-500 text-[10px] mt-1.5 cursor-help"
            title={mode === 'priority'
              ? 'Income fills P1 categories first (e.g. rent, utilities), then P2 (stability), then P3 (optional). Any remaining income after all goals are fully funded goes to Surplus Distribution (if configured below).'
              : 'Income is proportionally split based on each category\'s share of total remaining need. If one category needs $800 and another needs $200, the first gets 80% and the second gets 20% of whatever you deposit.'}
          >
            {mode === 'priority'
              ? 'P1 gaps filled first → P2 → P3 → surplus by weight'
              : 'Each category gets its proportional share of remaining need'}
          </p>
        </div>

        {/* Inputs */}
        <div className="p-5 border-b border-slate-700 shrink-0 space-y-3 pt-3">

          {/* ── Quick-fill templates ── */}
          {(templates.length > 0 || showManageTpl) ? (
            <div className="space-y-2">
              <div className="flex items-center">
                <p className="text-slate-500 text-[10px] uppercase tracking-wider flex-1">Quick Fill</p>
                <button onClick={() => setShowManageTpl(v => !v)} className="text-slate-600 text-[10px] hover:text-slate-400 transition-colors">
                  {showManageTpl ? 'Done' : '⚙ Manage'}
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-0.5">
                {templates.map(t => (
                  showManageTpl ? (
                    <div key={t.id} className="shrink-0 flex items-center gap-1 bg-slate-800 border border-slate-700 rounded-full pl-3 pr-1 py-1">
                      <span className="text-slate-300 text-xs whitespace-nowrap">{t.name} · {fmt(t.amount)}</span>
                      <button onClick={() => deleteTemplate(t.id)} className="w-4 h-4 rounded-full bg-slate-700 hover:bg-rose-900/50 text-slate-500 hover:text-rose-400 text-[10px] flex items-center justify-center transition-colors">✕</button>
                    </div>
                  ) : (
                    <button
                      key={t.id}
                      onClick={() => setIncome(String(t.amount.toFixed(2)))}
                      className="shrink-0 px-3 py-1.5 rounded-full bg-blue-900/40 border border-blue-800/50 text-blue-300 text-xs font-medium hover:bg-blue-800/60 active:scale-95 transition-all whitespace-nowrap"
                    >
                      {t.name} · {fmt(t.amount)}
                    </button>
                  )
                ))}
                {!showManageTpl && templates.length < 8 && (
                  <button onClick={() => setShowManageTpl(true)} className="shrink-0 px-2.5 py-1.5 rounded-full bg-slate-700/60 border border-slate-700 text-slate-500 text-xs hover:text-slate-300 transition-colors">+</button>
                )}
              </div>
              {showManageTpl && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTplName}
                    onChange={e => setNewTplName(e.target.value)}
                    placeholder="Name (optional)"
                    className="flex-1 bg-slate-700/60 text-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500 placeholder-slate-600"
                    onKeyDown={e => e.key === 'Enter' && addTemplate()}
                  />
                  <button
                    onClick={addTemplate}
                    disabled={!income || parseFloat(income) <= 0 || templates.length >= 8}
                    className="px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-medium transition-colors whitespace-nowrap"
                  >
                    Save {income && parseFloat(income) > 0 ? fmt(parseFloat(income)) : 'amount'}
                  </button>
                </div>
              )}
              {showManageTpl && templates.length === 0 && (
                <p className="text-slate-600 text-xs text-center py-1">Enter an amount below, then save it as a template</p>
              )}
            </div>
          ) : (
            <button onClick={() => setShowManageTpl(true)} className="text-slate-600 text-xs hover:text-slate-400 transition-colors">
              + Add quick-fill templates
            </button>
          )}

          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-2">Net Amount Received</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl font-bold">$</span>
              <input
                type="number" step="0.01" min="0"
                value={income}
                onChange={e => setIncome(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3.5 outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-600"
              />
            </div>
            {gasBalance !== null && gasBalance !== undefined && (
              <button
                type="button"
                className={`mt-2 w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-colors ${gasBalance > 0 ? 'bg-emerald-900/30 border-emerald-800/40 hover:bg-emerald-900/50' : gasBalance < 0 ? 'bg-rose-900/20 border-rose-800/30' : 'bg-slate-800 border-slate-700'}`}
                onClick={() => {
                  if (gasBalance > 0) setIncome(prev => {
                    const cur = parseFloat(prev) || 0;
                    return String((cur + gasBalance).toFixed(2));
                  });
                }}
                title={gasBalance > 0 ? 'Click to add gas savings to this income deposit' : undefined}
              >
                <span className={`text-xs ${gasBalance > 0 ? 'text-emerald-400' : gasBalance < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                  ⛽ Gas balance (all time)
                </span>
                <span className={`font-mono font-bold text-sm ${gasBalance > 0 ? 'text-emerald-300' : gasBalance < 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                  {gasBalance > 0 ? `+$${gasBalance.toFixed(2)}` : gasBalance < 0 ? `-$${Math.abs(gasBalance).toFixed(2)}` : '$0.00'}
                  {gasBalance > 0 && <span className="text-[10px] text-emerald-600 ml-1 font-normal">tap to add →</span>}
                </span>
              </button>
            )}
          </div>
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Source (optional)</label>
            <input
              type="text"
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder="e.g. Retro Fitness, Commission"
              className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-600"
            />
          </div>

          {/* Priority tier summary — shows already + this deposit */}
          {!histLoading && (
            <div className="grid grid-cols-3 gap-2 pt-1">
              {[
                { p: 1, label: 'Essential', color: '#f43f5e', gradFrom: 'from-rose-950/60',   gradTo: 'to-slate-800', border: 'border-rose-800/30',   textClass: 'text-rose-400'   },
                { p: 2, label: 'Stability', color: '#f59e0b', gradFrom: 'from-amber-950/60',  gradTo: 'to-slate-800', border: 'border-amber-800/30',  textClass: 'text-amber-400'  },
                { p: 3, label: 'Optional',  color: '#8b5cf6', gradFrom: 'from-violet-950/60', gradTo: 'to-slate-800', border: 'border-violet-800/30', textClass: 'text-violet-400' },
              ].map(({ p, label, color, gradFrom, gradTo, border, textClass }) => {
                const tier       = tierTotals[p];
                const total      = tier.already + (amount > 0 ? tier.deposit : 0);
                const tierPct    = tier.budget > 0 ? Math.min((total / tier.budget) * 100, 100) : 0;
                const alreadyPct = tier.budget > 0 ? Math.min((tier.already / tier.budget) * 100, 100) : 0;
                const newPct     = tier.budget > 0 ? Math.min((amount > 0 ? tier.deposit / tier.budget * 100 : 0), 100) : 0;
                const isFull     = tierPct >= 100;
                return (
                  <div key={p} className={`bg-gradient-to-b ${gradFrom} ${gradTo} rounded-xl p-3 border ${border} space-y-2`}>
                    <p className={`text-[9px] font-bold uppercase tracking-wider ${textClass}`}>P{p} {label}</p>
                    <div className="flex items-end justify-between gap-1">
                      <p className="text-white text-sm font-bold font-mono tabular-nums leading-none">{fmt(total)}</p>
                      <p className={`text-xl font-black tabular-nums leading-none ${isFull ? 'text-emerald-400' : textClass}`}>
                        {tierPct.toFixed(0)}<span className="text-[10px] font-bold">%</span>
                      </p>
                    </div>
                    {/* Segmented bar: faded = already, solid = new */}
                    <div className="w-full bg-slate-900/60 rounded-full h-3 overflow-hidden">
                      <div className="h-3 flex overflow-hidden rounded-full">
                        <div style={{ width: `${alreadyPct}%`, background: color, opacity: 0.35 }} className="transition-all duration-300" />
                        <div style={{ width: `${newPct}%`, background: `linear-gradient(90deg, ${color}cc, ${color})` }} className="transition-all duration-300" />
                      </div>
                    </div>
                    <p className="text-slate-600 text-[9px] font-mono">{tier.budget > 0 ? fmt(tier.budget) : '—'} goal</p>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Monthly goal: <span className="text-slate-300">{fmt(totalAllowance)}</span></span>
            <span className={`font-semibold ${coveragePct >= 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {coveragePct.toFixed(0)}% covered
            </span>
          </div>
        </div>

        {/* Breakdown by account */}
        <div className="overflow-y-auto flex-1 min-h-0 p-4 space-y-3">
          {/* ── Where the money goes — flat receipt list ──────── */}
          {amount > 0 && depositPlan.length > 0 && (
            <div className="rounded-2xl border border-emerald-800/40 bg-gradient-to-b from-emerald-950/40 to-slate-900 overflow-hidden">
              <div className="px-4 py-3 flex items-center justify-between border-b border-emerald-900/40">
                <div>
                  <p className="text-emerald-300 text-xs font-bold uppercase tracking-wider">🧾 Where it goes</p>
                  <p className="text-slate-500 text-[10px] mt-0.5">{depositPlan.length} deposit{depositPlan.length !== 1 ? 's' : ''} · process top to bottom</p>
                </div>
                <button
                  onClick={copyText}
                  className="text-emerald-400 hover:text-emerald-300 text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-emerald-900/40 border border-emerald-800/40 transition-colors shrink-0"
                >{copied ? '✓ Copied' : '📋 Copy'}</button>
              </div>
              <div className="divide-y divide-slate-800/60">
                {depositPlan.map((r, i) => {
                  const priClr = r.kind === 'surplus' ? 'text-emerald-400'
                    : r.priority === 1 ? 'text-rose-400' : r.priority === 2 ? 'text-amber-400' : 'text-violet-400';
                  return (
                    <div key={i} className="px-4 py-2.5 flex items-center gap-3">
                      <span className="text-emerald-300 font-mono font-bold text-sm tabular-nums w-20 shrink-0 text-right">
                        +{fmt(r.amount)}
                      </span>
                      <span className={`shrink-0 ${priClr}`}>→</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-white text-sm truncate leading-tight">{r.name}</p>
                        <p className="text-slate-500 text-[10px] leading-tight">
                          {r.account}{r.kind === 'surplus' ? ' · surplus' : ` · P${r.priority}`}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div className="px-4 py-2.5 flex items-center gap-3 bg-slate-800/60">
                  <span className="text-white font-mono font-bold text-sm tabular-nums w-20 shrink-0 text-right">
                    {fmt(depositPlan.reduce((s, r) => s + r.amount, 0))}
                  </span>
                  <span className="text-slate-600 shrink-0">→</span>
                  <span className="text-slate-300 text-xs font-semibold flex-1">Total allocated</span>
                </div>
              </div>
            </div>
          )}

          {amount <= 0 && !histLoading && (
            <div className="space-y-2">
              <p className="text-slate-600 text-center py-4 text-sm">Enter an amount above to see where it goes</p>
              {/* Show current month state even without entering amount */}
              {Object.keys(alreadyByType).length > 0 && (
                <div className="space-y-2">
                  <p className="text-slate-500 text-xs uppercase tracking-wider px-1">Already deposited this month</p>
                  {expenses
                    .filter(e => pm(e['Monthly Allowance ($)']) > 0 && alreadyByType[e['Type'] || ''] > 0)
                    .map((e, i) => {
                      const already   = alreadyByType[e['Type'] || ''] || 0;
                      const allowance = pm(e['Monthly Allowance ($)']);
                      const pct       = allowance > 0 ? (already / allowance) * 100 : 0;
                      return (
                        <div key={i} className="bg-slate-800/60 rounded-xl px-4 py-2.5 flex justify-between items-center gap-3">
                          <div>
                            <p className="text-white text-sm">{e['Type']}</p>
                            <p className="text-slate-500 text-[10px]">goal {fmt(allowance)} · {pct.toFixed(0)}% funded</p>
                          </div>
                          <span className="text-emerald-400 font-mono font-semibold text-sm shrink-0">{fmt(already)}</span>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {amount > 0 && ACCOUNT_ORDER.map(acct => {
            const group = byAccount[acct];
            if (!group) return null;
            const style = ACCOUNT_ICONS[acct] || { icon: '💰', color: 'text-slate-300', bg: 'bg-slate-800 border-slate-700' };
            return (
              <div key={acct} className={`rounded-2xl overflow-hidden border ${style.bg}`}>
                <div className="px-4 py-3 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{style.icon}</span>
                    <span className={`font-bold text-sm ${style.color}`}>{acct}</span>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-bold ${style.color}`}>{fmt(group.total)}</p>
                    <p className="text-slate-500 text-xs">{amount > 0 ? ((group.total / amount) * 100).toFixed(1) : 0}% of deposit</p>
                  </div>
                </div>
                <div className="bg-slate-800/80 divide-y divide-slate-700/40">
                  {group.items.map((d, i) => (
                    <div key={i} className="px-4 py-3 flex justify-between items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-white text-sm truncate">{d.type}</p>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className={`text-[10px] ${d.priority === 1 ? 'text-rose-400' : d.priority === 2 ? 'text-amber-400' : 'text-violet-400'}`}>
                            P{d.priority} {PRIORITY_LABEL[d.priority]}
                          </span>
                          <span className="text-slate-600 text-[10px]">·</span>
                          <span className="text-slate-500 text-[10px]">goal {fmt(d.allowance)}</span>
                          {dueDates[d.type] != null && d.stillNeeds > 0 && (() => {
                            const diff = dueDates[d.type] - todayDay;
                            if (diff < 0) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-900/60 text-rose-300 font-medium">⚠ Past due</span>;
                            if (diff <= 3) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/60 text-amber-300 font-medium">⏰ {diff === 0 ? 'Due today' : `Due in ${diff}d`}</span>;
                            return null;
                          })()}
                        </div>
                        {/* Already-contributed bar */}
                        {(() => {
                          const isRunning = (balTypes[d.type] || 'monthly') === 'running';
                          const alreadyPct = d.allowance > 0 ? Math.min(Math.max((d.already / d.allowance) * 100, 0), 100) : 0;
                          const depositPct = d.allowance > 0 ? Math.min((d.deposit / d.allowance) * 100, 100) : 0;
                          return (
                            <div className="mt-1.5 space-y-0.5">
                              <div className="flex h-2 bg-slate-700 rounded-full overflow-hidden">
                                <div style={{ width: `${alreadyPct}%`, background: d.already < 0 ? '#f43f5e' : '#10b981', opacity: 0.5 }}
                                  title={isRunning ? `Net balance: ${fmt(d.already)}` : `Prior deposits: ${fmt(d.already)}`} />
                                <div style={{ width: `${depositPct}%`, background: '#3b82f6' }}
                                  title={`Adding: ${fmt(d.deposit)}`} />
                              </div>
                              <div className="flex justify-between text-[10px] text-slate-600">
                                {d.already !== 0 && (
                                  <span className={d.already < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                                    {isRunning
                                      ? `${d.already >= 0 ? '+' : ''}${fmt(d.already)} net balance`
                                      : `${fmt(d.already)} prior`}
                                  </span>
                                )}
                                {d.stillNeeds > 0 && d.stillNeeds !== d.allowance && (
                                  <span className="ml-auto">{fmt(d.stillNeeds)} still needed</span>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="text-right shrink-0 flex flex-col items-end gap-1">
                        <p className="text-white text-sm font-semibold">+{fmt(d.deposit)}</p>
                        <CoverageChip coverage={d.coverage} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Surplus Distribution */}
          {amount > 0 && (
            <div className="space-y-3">
              <div
                className="flex items-center justify-between"
                title="Surplus is income that remains after every budget category's monthly goal is fully funded. Configure weighted buckets here to decide where that extra money goes — e.g. savings, investments, fun money."
              >
                <div>
                  <p className={`text-xs font-bold uppercase tracking-wider ${surplus > 0.01 ? 'text-emerald-400' : 'text-slate-500'}`}>
                    💰 Surplus Distribution
                  </p>
                  <p className="text-slate-500 text-[10px] mt-0.5">
                    {surplus > 0.01
                      ? `${fmt(surplus)} left after all goals are funded`
                      : 'No surplus yet — income covers goals only'}
                  </p>
                </div>
                <button
                  onClick={addSurplusItem}
                  className="text-emerald-400 hover:text-emerald-300 text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-800/40 transition-colors"
                >
                  + Add
                </button>
              </div>

              {surplusItems.length > 0 && (
                <div className="bg-slate-800/40 rounded-xl p-3 text-xs text-slate-400 leading-relaxed"
                  title="How weights work: Each bucket's share = its weight ÷ sum of all weights. Weight 2 out of a total of 5 = 2/5 = 40% of the surplus. Higher weight = bigger slice. The weights don't have to add up to any specific number — only the ratios matter."
                >
                  <span className="text-white font-semibold">How weights work: </span>
                  Each bucket's share = <span className="text-emerald-400 font-mono">its weight ÷ total weight</span>.{' '}
                  {surplusItems.length >= 2 && surplusTotalWeight > 0 && (() => {
                    const example = surplusItems.slice(0, 2);
                    const w0 = parseFloat(example[0]?.weight) || 0;
                    const w1 = parseFloat(example[1]?.weight) || 0;
                    const n0 = example[0]?.name?.trim() || 'First';
                    const n1 = example[1]?.name?.trim() || 'Second';
                    return (
                      <span>
                        E.g. {n0} (weight {w0}) + {n1} (weight {w1}) = {surplusTotalWeight} total →{' '}
                        {n0} gets {surplusTotalWeight > 0 ? ((w0 / surplusTotalWeight) * 100).toFixed(0) : 0}%,{' '}
                        {n1} gets {surplusTotalWeight > 0 ? ((w1 / surplusTotalWeight) * 100).toFixed(0) : 0}%.
                      </span>
                    );
                  })()}
                </div>
              )}

              {surplusItems.map(it => {
                const weight = parseFloat(it.weight) || 0;
                const share  = surplusTotalWeight > 0 ? weight / surplusTotalWeight : 0;
                const deposit = share * surplus;
                return (
                  <div key={it.id} className={`rounded-xl p-3 space-y-2 border ${surplus > 0.01 ? 'bg-slate-800 border-emerald-800/30' : 'bg-slate-800/60 border-slate-700/50'}`}>
                    <div className="flex items-center gap-2">
                      <input
                        value={it.name}
                        onChange={e => updateSurplusItem(it.id, 'name', e.target.value)}
                        placeholder="Category name (e.g. Savings, Fun Money)"
                        className="flex-1 bg-slate-700 text-white rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-emerald-500 placeholder-slate-600"
                      />
                      <button
                        onClick={() => removeSurplusItem(it.id)}
                        className="w-7 h-7 rounded-lg bg-slate-700 text-slate-500 hover:text-rose-400 flex items-center justify-center text-sm transition-colors shrink-0"
                      >✕</button>
                    </div>
                    <div className="flex gap-2">
                      <select
                        value={it.account}
                        onChange={e => updateSurplusItem(it.id, 'account', e.target.value)}
                        className="flex-1 bg-slate-700 text-white rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-emerald-500"
                      >
                        {ACCOUNT_ORDER.map(a => <option key={a}>{a}</option>)}
                      </select>
                      <div
                        className="relative"
                        title={`Weight ${weight} out of total ${surplusTotalWeight} = ${surplusTotalWeight > 0 ? ((weight / surplusTotalWeight) * 100).toFixed(0) : 0}% of surplus. Higher weight = larger share. The numbers don't have to add up to anything specific — only the ratios matter.`}
                      >
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs font-bold">×</span>
                        <input
                          type="number" min="0" step="0.5"
                          value={it.weight}
                          onChange={e => updateSurplusItem(it.id, 'weight', e.target.value)}
                          placeholder="1"
                          className="w-20 bg-slate-700 text-white rounded-lg pl-7 pr-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-emerald-500 font-mono tabular-nums"
                        />
                      </div>
                    </div>
                    {surplusTotalWeight > 0 && surplus > 0 && (
                      <div className="flex items-center gap-3">
                        <div className="flex-1 bg-slate-700 rounded-full h-1.5 overflow-hidden">
                          <div className="h-1.5 rounded-full bg-emerald-500 transition-all" style={{ width: `${share * 100}%` }} />
                        </div>
                        <span className="text-slate-500 font-mono text-[10px] w-8 text-right tabular-nums">{(share * 100).toFixed(0)}%</span>
                        <span className="text-emerald-400 font-bold font-mono text-sm tabular-nums w-16 text-right">{fmt(deposit)}</span>
                      </div>
                    )}
                    {surplus <= 0.01 && (
                      <p className="text-slate-600 text-[10px]">Will activate when income exceeds all budget goals</p>
                    )}
                  </div>
                );
              })}

              {surplusItems.length === 0 && (
                <div className="text-center py-3 text-slate-600 text-xs border border-dashed border-slate-700/60 rounded-xl cursor-pointer hover:border-slate-600 transition-colors" onClick={addSurplusItem}>
                  Tap "+ Add" to configure where surplus income goes
                </div>
              )}

              {surplusItems.length > 0 && surplus > 0.01 && (
                <div className="flex justify-between items-center px-1 text-xs">
                  <span className="text-slate-500">Total surplus distributed</span>
                  <span className="text-emerald-400 font-bold font-mono tabular-nums">{fmt(surplus)}</span>
                </div>
              )}
            </div>
          )}

          {/* Summary totals */}
          {amount > 0 && (
            <div className="bg-slate-800 rounded-2xl p-4 border border-slate-600 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">This deposit</span>
                <span className="text-white font-bold">{fmt(amount)}</span>
              </div>
              {totalAlready > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Already deposited this month</span>
                    <span className="text-emerald-400">{fmt(totalAlready)}</span>
                  </div>
                  <div className="flex justify-between text-sm border-t border-slate-700 pt-2">
                    <span className="text-slate-400">Total month coverage</span>
                    <span className="text-white font-bold">{fmt(totalCovered)}</span>
                  </div>
                </>
              )}
              {stillNeeded > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-400">Still needed for goal</span>
                  <span className="text-amber-400 font-bold">{fmt(stillNeeded)}</span>
                </div>
              )}
              <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden flex">
                <div style={{ width: `${totalAllowance > 0 ? Math.min((totalAlready / totalAllowance) * 100, 100) : 0}%`, background: '#10b981', opacity: 0.5 }} />
                <div style={{ width: `${totalAllowance > 0 ? Math.min((amount / totalAllowance) * 100, 100) : 0}%`, background: '#3b82f6' }} />
              </div>
              <p className="text-slate-500 text-xs text-right">{coveragePct.toFixed(0)}% of {fmt(totalAllowance)} monthly goal</p>
            </div>
          )}

          {logError && (
            <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-sm">{logError}</div>
          )}
        </div>

        {/* Actions */}
        {amount > 0 && (
          <div className="p-4 border-t border-slate-700 flex gap-3 shrink-0">
            <button onClick={copyText} className="py-3 px-4 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors">
              {copied ? '✓' : '📋'}
            </button>
            <button
              onClick={handleProcess}
              disabled={logging || histLoading}
              className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-bold transition-colors"
            >
              {logging ? 'Logging…' : `✓ Process & Log ${deposits.filter(d => d.deposit > 0).length} Deposits`}
            </button>
          </div>
        )}
      </div>

      </div>
    </div>
  );
}
