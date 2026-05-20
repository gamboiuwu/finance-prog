import { useState, useMemo } from 'react';
import { appendRow } from '../lib/sheets';

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

// Priority-first allocation: fill P1 items completely before P2, then P3
function calcDeposits(expenses, income) {
  if (!income) return [];
  const eligible = expenses
    .filter(e => pm(e['Monthly Allowance ($)']) > 0)
    .map(e => ({
      type:      e['Type']     || '',
      account:   e['Account']  || 'Other',
      expense:   e['Expense']  || '',
      priority:  parseInt(e['Priority']) || 2,
      allowance: pm(e['Monthly Allowance ($)']),
    }))
    .sort((a, b) => a.priority - b.priority || b.allowance - a.allowance);

  let remaining = income;
  return eligible.map(e => {
    const deposit  = Math.min(e.allowance, Math.max(0, remaining));
    remaining      = Math.max(0, remaining - deposit);
    const coverage = e.allowance > 0 ? deposit / e.allowance : 0;
    const pct      = income > 0 ? deposit / income : 0;
    return { ...e, deposit, pct, coverage };
  });
}

function CoverageChip({ coverage }) {
  if (coverage >= 1)      return <span className="text-[10px] font-medium text-emerald-400 bg-emerald-900/40 px-1.5 py-0.5 rounded-full">✓ Full</span>;
  if (coverage > 0)       return <span className="text-[10px] font-medium text-amber-400  bg-amber-900/40  px-1.5 py-0.5 rounded-full">~ Partial</span>;
  return                         <span className="text-[10px] font-medium text-rose-400   bg-rose-900/40   px-1.5 py-0.5 rounded-full">✗ Unfunded</span>;
}

export default function ProcessIncome({ expenses, token, alreadyProcessed = 0, onClose }) {
  const [income, setIncome]     = useState('');
  const [source, setSource]     = useState('');
  const [logging, setLogging]   = useState(false);
  const [done, setDone]         = useState(false);
  const [logError, setLogError] = useState(null);
  const [copied, setCopied]     = useState(false);

  const amount         = parseFloat(income) || 0;
  const deposits       = useMemo(() => calcDeposits(expenses, amount), [expenses, amount]);
  const totalAllowance = expenses.reduce((s, e) => s + pm(e['Monthly Allowance ($)']), 0);
  const totalCovered   = alreadyProcessed + amount;
  const stillNeeded    = Math.max(0, totalAllowance - totalCovered);
  const coveragePct    = totalAllowance > 0 ? (totalCovered / totalAllowance) * 100 : 0;

  // Priority tier summaries for the header display
  const tierTotals = useMemo(() => {
    const t = { 1: { budget: 0, deposit: 0 }, 2: { budget: 0, deposit: 0 }, 3: { budget: 0, deposit: 0 } };
    deposits.forEach(d => {
      const p = d.priority <= 3 ? d.priority : 3;
      t[p].budget  += d.allowance;
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
          date,
          d.type,
          parseFloat(d.deposit.toFixed(2)),
          desc,
          d.account,
          true,
        ]);
      }
      setDone(true);
    } catch (e) {
      setLogError(e.message);
    } finally {
      setLogging(false);
    }
  }

  function copyText() {
    const lines = [`Income: ${fmt(amount)}${source ? ` (${source})` : ''}`, ''];
    ACCOUNT_ORDER.forEach(acct => {
      const g = byAccount[acct];
      if (!g) return;
      lines.push(`${ACCOUNT_ICONS[acct]?.icon || ''} ${acct}: ${fmt(g.total)}`);
      g.items.forEach(d => lines.push(`  • ${d.type}: ${fmt(d.deposit)} (${(d.coverage * 100).toFixed(0)}% funded)`));
      lines.push('');
    });
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Success state ─────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-6">
        <div className="bg-slate-900 rounded-2xl p-8 max-w-sm w-full text-center space-y-4">
          <div className="text-5xl">✅</div>
          <h2 className="text-white text-xl font-bold">Income Processed!</h2>
          <p className="text-slate-400 text-sm">
            {deposits.filter(d => d.deposit > 0).length} deposits totalling{' '}
            <span className="text-emerald-400 font-semibold">{fmt(amount)}</span> logged to Allocation Transactions.
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
      <div className="bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl flex flex-col max-h-[94vh]">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-white font-bold text-lg">Process Income</h2>
            <p className="text-slate-400 text-xs mt-0.5">Priority-first: P1 → P2 → P3</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-700 text-slate-300 hover:bg-slate-600 flex items-center justify-center">✕</button>
        </div>

        {/* Inputs */}
        <div className="p-5 border-b border-slate-700 shrink-0 space-y-3">
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

          {/* Priority tier summary */}
          {amount > 0 && (
            <div className="grid grid-cols-3 gap-2 pt-1">
              {[
                { p: 1, label: 'Essential', color: '#f43f5e', textClass: 'text-rose-400' },
                { p: 2, label: 'Stability', color: '#f59e0b', textClass: 'text-amber-400' },
                { p: 3, label: 'Optional',  color: '#8b5cf6', textClass: 'text-violet-400' },
              ].map(({ p, label, color, textClass }) => {
                const tier = tierTotals[p];
                const tierPct = tier.budget > 0 ? (tier.deposit / tier.budget) * 100 : 0;
                return (
                  <div key={p} className="bg-slate-800 rounded-xl p-2.5 space-y-1.5">
                    <p className={`text-[10px] font-bold ${textClass}`}>P{p} {label}</p>
                    <p className="text-white text-xs font-mono font-bold tabular-nums">{fmt(tier.deposit)}</p>
                    <div className="w-full bg-slate-700 rounded-full h-1 overflow-hidden">
                      <div className="h-1 rounded-full" style={{ width: `${Math.min(tierPct, 100)}%`, background: color }} />
                    </div>
                    <p className="text-slate-500 text-[10px]">{tierPct.toFixed(0)}%</p>
                  </div>
                );
              })}
            </div>
          )}

          {amount > 0 && (
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-500">Monthly goal: <span className="text-slate-300">{fmt(totalAllowance)}</span></span>
              <span className={`font-semibold ${coveragePct >= 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {coveragePct.toFixed(0)}% covered{alreadyProcessed > 0 ? ' (incl. prior)' : ''}
              </span>
            </div>
          )}
        </div>

        {/* Breakdown */}
        <div className="overflow-y-auto flex-1 p-4 space-y-3">
          {amount <= 0 && (
            <p className="text-slate-600 text-center py-12 text-sm">Enter an amount above to see where it goes</p>
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
                    <p className="text-slate-500 text-xs">{((group.total / amount) * 100).toFixed(1)}% of deposit</p>
                  </div>
                </div>
                <div className="bg-slate-800/80 divide-y divide-slate-700/40">
                  {group.items.map((d, i) => (
                    <div key={i} className="px-4 py-2.5 flex justify-between items-center gap-3">
                      <div className="min-w-0">
                        <p className="text-white text-sm truncate">{d.type}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`text-[10px] ${d.priority === 1 ? 'text-rose-400' : d.priority === 2 ? 'text-amber-400' : 'text-violet-400'}`}>
                            P{d.priority} {PRIORITY_LABEL[d.priority]}
                          </span>
                          <span className="text-slate-600 text-[10px]">·</span>
                          <span className="text-slate-500 text-[10px]">goal {fmt(d.allowance)}</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0 flex flex-col items-end gap-1">
                        <p className="text-white text-sm font-semibold">{fmt(d.deposit)}</p>
                        <CoverageChip coverage={d.coverage} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {amount > 0 && (
            <div className="bg-slate-800 rounded-2xl p-4 border border-slate-600 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">This deposit</span>
                <span className="text-white font-bold">{fmt(amount)}</span>
              </div>
              {alreadyProcessed > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Previously processed</span>
                    <span className="text-slate-300">{fmt(alreadyProcessed)}</span>
                  </div>
                  <div className="flex justify-between text-sm border-t border-slate-700 pt-2">
                    <span className="text-slate-400">Total covered</span>
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
              <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
                <div className="h-2 rounded-full transition-all" style={{
                  width: `${Math.min(coveragePct, 100)}%`,
                  background: coveragePct >= 100 ? '#10b981' : '#3b82f6',
                }} />
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
              disabled={logging}
              className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-bold transition-colors"
            >
              {logging ? 'Logging…' : `✓ Process & Log ${deposits.filter(d => d.deposit > 0).length} Deposits`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
