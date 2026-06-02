import { useState, useEffect } from 'react';
import {
  recalcMonthlySummary, updateSubscription, updateBudgetAllowance,
  setAllocationAmount, deleteAllocation, sumAllocations,
} from '../lib/sheetWrite';

// One-time data repair for the 2026-05-29 review. Surfaces on app open until the
// user applies the fixes or chooses "Don't show again" (tracked in localStorage).
// Edits go to the user's sheet via their logged-in token; values are editable and
// nothing is written without an explicit "Apply".
const DONE_KEY = 'repair_2026_05_29_done';

const MAY_INCOME = 2408.93; // 1452.39 + 435.04 + 297.50 + 224.00
const OVER_BUDGET = [
  { type: 'Personal Expenses', actual: 200 },
  { type: 'Coffee Budget',     actual: 80 },
  { type: 'Gas',               actual: 120 },
  { type: 'Anything',          actual: 100 },
];

function Status({ s }) {
  if (!s || s.status === 'idle') return null;
  const map = { running: ['text-slate-400', '…'], ok: ['text-emerald-400', '✓'], err: ['text-rose-400', '✕'] };
  const [cls, icon] = map[s.status] || map.idle;
  return <p className={`text-[11px] mt-1 ${cls}`}>{icon} {s.msg}</p>;
}

export default function DataRepair({ token }) {
  // RETIRED: this was a one-time May-2026 data fix and has already been applied.
  // It is force-hidden so it can never re-surface on a fresh browser/device and
  // overwrite correct Monthly Summary / budget data with the old hard-coded
  // constants. Flip RETIRED to false only to intentionally re-run a repair.
  const RETIRED = true;
  const [hidden, setHidden] = useState(() => RETIRED || localStorage.getItem(DONE_KEY) === '1');
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState({});

  // Fix 1 — May summary
  const [inc1, setInc1] = useState(String(MAY_INCOME));
  const [spent1, setSpent1] = useState('');
  const [savings1, setSavings1] = useState('');
  const [do1, setDo1] = useState(true);
  // Fix 2 — Claude subscription + budget
  const [claudeCost, setClaudeCost] = useState('100');
  const [do2, setDo2] = useState(true);
  const [do2budget, setDo2budget] = useState(true);
  // Fix 3 — blank allocations
  const [gasAmt, setGasAmt] = useState('');
  const [do3gas, setDo3gas] = useState(true);
  const [do3del, setDo3del] = useState(true);
  // Fix 4 — over-budget allowances
  const [cats, setCats] = useState(OVER_BUDGET.map(c => ({ ...c, allowance: String(c.actual), include: true })));

  useEffect(() => {
    if (hidden) return;
    (async () => {
      try {
        const spent = await sumAllocations(token, '2026-05');
        if (spent > 0) { setSpent1(spent.toFixed(2)); setSavings1((MAY_INCOME - spent).toFixed(2)); }
      } catch { /* leave spent/savings blank for manual entry */ }
      finally { setLoading(false); }
    })();
  }, [hidden, token]);

  if (hidden) return null;

  function setResult(id, status, msg) { setResults(r => ({ ...r, [id]: { status, msg } })); }
  const num = (v) => (v === '' || v == null ? null : Number(v));

  async function apply() {
    setApplying(true);
    // Fix 1
    if (do1) {
      setResult('f1', 'running', 'Updating May summary…');
      try {
        const n = await recalcMonthlySummary(token, { monthName: 'May', income: num(inc1), spent: num(spent1), savings: num(savings1) });
        setResult('f1', 'ok', `Updated ${n} field(s) on the May row.`);
      } catch (e) { setResult('f1', 'err', e.message); }
    }
    // Fix 2
    if (do2) {
      setResult('f2', 'running', 'Reconciling Claude AI…');
      try {
        await updateSubscription(token, { name: 'Claude', amount: num(claudeCost), cycle: 'monthly' });
        let note = '';
        if (do2budget) {
          try { await updateBudgetAllowance(token, { type: 'Claude AI', monthlyAllowance: num(claudeCost) }); note = ' and budget'; }
          catch (e) { note = ` (budget category not updated: ${e.message})`; }
        }
        setResult('f2', 'ok', `Set Claude AI to $${claudeCost}/mo in tracker${note}.`);
      } catch (e) { setResult('f2', 'err', e.message); }
    }
    // Fix 3
    if (do3gas || do3del) {
      setResult('f3', 'running', 'Repairing allocation rows…');
      const msgs = [];
      if (do3gas) {
        if (num(gasAmt) == null) { msgs.push('Gas: skipped (no amount entered)'); }
        else {
          try { await setAllocationAmount(token, { month: '2026-05', category: 'Gas', account: 'Cash', amount: num(gasAmt), requireBlank: true }); msgs.push(`Gas set to $${gasAmt}`); }
          catch (e) { msgs.push(`Gas: ${e.message}`); }
        }
      }
      if (do3del) {
        try { await deleteAllocation(token, { month: '2026-05', category: 'Relaxation', account: 'Savings', requireBlank: true }); msgs.push('Relaxation correction row deleted'); }
        catch (e) { msgs.push(`Relaxation: ${e.message}`); }
      }
      setResult('f3', msgs.some(m => m.includes('rror') || m.includes('No matching')) ? 'err' : 'ok', msgs.join(' · '));
    }
    // Fix 4
    const picked = cats.filter(c => c.include);
    if (picked.length) {
      setResult('f4', 'running', 'Adjusting allowances…');
      const msgs = [];
      for (const c of picked) {
        try { await updateBudgetAllowance(token, { type: c.type, monthlyAllowance: Number(c.allowance) }); msgs.push(`${c.type}→$${c.allowance}`); }
        catch (e) { msgs.push(`${c.type}: ${e.message}`); }
      }
      setResult('f4', msgs.some(m => m.includes('rror') || m.includes('No ')) ? 'err' : 'ok', msgs.join(' · '));
    }
    setApplying(false);
  }

  function dismissForever() { localStorage.setItem(DONE_KEY, '1'); setHidden(true); }

  const field = "w-full bg-slate-900 text-white rounded-lg px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-emerald-500";
  const section = "bg-slate-800 rounded-2xl p-4 space-y-3";
  const head = "flex items-start gap-2.5";

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-end sm:items-center justify-center">
      <div className="bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl max-h-[92dvh] flex flex-col">
        <div className="shrink-0 px-5 pt-5 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl">🛠️</span>
            <div>
              <h2 className="text-white font-bold font-broske leading-tight">Data Repair</h2>
              <p className="text-slate-500 text-xs">4 issues from the May 29 review · edit values, then apply</p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {loading && <p className="text-slate-500 text-sm text-center py-6">Reading your May data…</p>}

          {/* Fix 1 */}
          <div className={section}>
            <div className={head}>
              <input type="checkbox" checked={do1} onChange={e => setDo1(e.target.checked)} className="mt-1 accent-emerald-500" />
              <div className="flex-1">
                <p className="text-white text-sm font-semibold">① Recalculate May 2026 summary</p>
                <p className="text-slate-500 text-xs">Income summed from your 4 logged corrections. Spent/savings prefilled from May allocations — edit if needed.</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Income
                <input className={field} value={inc1} onChange={e => setInc1(e.target.value)} type="number" /></label>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Spent
                <input className={field} value={spent1} onChange={e => setSpent1(e.target.value)} placeholder="—" type="number" /></label>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Savings
                <input className={field} value={savings1} onChange={e => setSavings1(e.target.value)} placeholder="—" type="number" /></label>
            </div>
            <Status s={results.f1} />
          </div>

          {/* Fix 2 */}
          <div className={section}>
            <div className={head}>
              <input type="checkbox" checked={do2} onChange={e => setDo2(e.target.checked)} className="mt-1 accent-emerald-500" />
              <div className="flex-1">
                <p className="text-white text-sm font-semibold">② Reconcile Claude AI cost</p>
                <p className="text-slate-500 text-xs">Tracker said $20/mo, budget said ~$100/mo. Set one monthly figure for both (Claude Max is $100, or $200 for the higher tier).</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider flex-1">Monthly cost
                <input className={field} value={claudeCost} onChange={e => setClaudeCost(e.target.value)} type="number" /></label>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 mt-4">
                <input type="checkbox" checked={do2budget} onChange={e => setDo2budget(e.target.checked)} className="accent-emerald-500" />
                also update budget category
              </label>
            </div>
            <Status s={results.f2} />
          </div>

          {/* Fix 3 */}
          <div className={section}>
            <div className={head}>
              <div className="flex-1">
                <p className="text-white text-sm font-semibold">③ Fix blank allocation amounts</p>
                <p className="text-slate-500 text-xs">Two May rows have a category but no amount.</p>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={do3gas} onChange={e => setDo3gas(e.target.checked)} className="accent-emerald-500" />
              <span className="flex-1">Gas · Cash · May 15 →</span>
              <input className={`${field} w-28`} value={gasAmt} onChange={e => setGasAmt(e.target.value)} placeholder="amount" type="number" />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={do3del} onChange={e => setDo3del(e.target.checked)} className="accent-rose-500" />
              <span className="flex-1">Delete the Relaxation correction row (May 20)</span>
              <span className="text-rose-400 text-xs">delete</span>
            </label>
            <Status s={results.f3} />
          </div>

          {/* Fix 4 */}
          <div className={section}>
            <div className={head}>
              <div className="flex-1">
                <p className="text-white text-sm font-semibold">④ Raise over-budget allowances</p>
                <p className="text-slate-500 text-xs">Prefilled to match actual spend. Untick any you'd rather cut spending on instead.</p>
              </div>
            </div>
            {cats.map((c, i) => (
              <label key={c.type} className="flex items-center gap-2 text-sm text-slate-200">
                <input type="checkbox" checked={c.include}
                  onChange={e => setCats(cs => cs.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))}
                  className="accent-emerald-500" />
                <span className="flex-1">{c.type}</span>
                <input className={`${field} w-24`} type="number" value={c.allowance}
                  onChange={e => setCats(cs => cs.map((x, j) => j === i ? { ...x, allowance: e.target.value } : x))} />
              </label>
            ))}
            <Status s={results.f4} />
          </div>
        </div>

        <div className="shrink-0 px-5 py-4 border-t border-slate-800 safe-area-bottom space-y-2">
          <button onClick={apply} disabled={applying}
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm transition-colors">
            {applying ? 'Applying…' : '🔧 Apply selected fixes'}
          </button>
          <div className="flex gap-3">
            <button onClick={() => setHidden(true)}
              className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors">
              Later (show next open)
            </button>
            <button onClick={dismissForever}
              className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs transition-colors">
              Don't show again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
