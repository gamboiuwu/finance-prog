// Loans.jsx — the debt tab.
//
// Built around one number the rest of the app does not have: the FREEZE LINE, the
// monthly interest across everything currently accruing. Below it, balances grow
// no matter how disciplined the payer feels, so the page refuses to show a
// progress bar until the budget clears that line.
//
// The guidance baked into the copy here comes from how federal loans actually
// work and what the research says about repayment order:
//   - avalanche (highest rate first) is the cheapest; snowball is offered because
//     a plan someone sticks to beats an optimal one they abandon
//   - a payment always goes to interest before principal, so "extra to principal"
//     needs an explicit instruction to the servicer
//   - unpaid interest capitalizes when a loan leaves deferment; paying it down
//     before that date is the highest-value move available
//   - a starter emergency fund comes before extra debt payments, so the page
//     warns when there is no buffer behind the plan
import { useState, useEffect, useCallback, useMemo } from 'react';
import { cents } from '../lib/allocation';
import {
  STATUS, monthlyInterest, loanBalance, freezeLine, totalOwed, applyPayment,
  payoffOrder, projectPayoff, costOfWaiting, assessPlan, capitalizeSchedule,
} from '../lib/loans';
import {
  readLoans, parseLoans, saveLoan, deleteLoan, logLoanPayment, reconcileLoan,
} from '../lib/sheetWrite';

const BUDGET_KEY = '_fin_loan_budget';
const STRATEGY_KEY = '_fin_loan_strategy';
const BORROWER_KEY = '_fin_loan_borrower';

const fmt = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const fmt0 = (n) => {
  const v = Number(n) || 0;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};
const pctLabel = (r) => `${((Number(r) || 0) * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
const monthsLabel = (m) => (m == null ? '—' : `${Math.floor(m / 12)}y ${m % 12}m`);
const todayISO = () => new Date().toISOString().slice(0, 10);

const VERDICT = {
  clear:       { label: 'Clear',        cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  strong:      { label: 'Strong',       cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  progressing: { label: 'Progressing',  cls: 'bg-teal-900/40 text-teal-300 border-teal-700/50' },
  frozen:      { label: 'Treading water', cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
  growing:     { label: 'Growing',      cls: 'bg-rose-900/40 text-rose-300 border-rose-700/50' },
};

function readStored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

// ── One loan ──────────────────────────────────────────────────────────────────
function LoanCard({ loan, rank, isTarget, onPay, onEdit, onDelete, onReconcile, deleting }) {
  const bal = loanBalance(loan);
  const mi = monthlyInterest(loan);
  const paid = loan.status === STATUS.PAID || bal <= 0;
  const dormant = loan.subsidized && loan.status === STATUS.DEFERRED;

  return (
    <div className={`bg-slate-900/60 rounded-xl p-3 space-y-2 ${isTarget ? 'ring-1 ring-teal-500/50' : ''}`}>
      <div className="flex items-center gap-2">
        <p className="text-white text-sm font-semibold truncate flex-1 flex items-center gap-1.5">
          {paid ? '✅' : isTarget ? '🎯' : '•'} {loan.name}
        </p>
        {isTarget && !paid && (
          <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-teal-900/50 text-teal-300 border border-teal-700/50">
            TARGET
          </span>
        )}
        <span className="shrink-0 text-slate-500 text-[10px]">#{rank}</span>
      </div>

      <div className="flex items-baseline gap-2 flex-wrap text-[11px]">
        <span className="text-white font-bold text-base">{fmt(bal)}</span>
        <span className="text-slate-500">{pctLabel(loan.rate)}</span>
        {loan.borrower && <span className="text-slate-500">· {loan.borrower}</span>}
        {loan.servicer && <span className="text-slate-600">· {loan.servicer}</span>}
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div>
          <p className="text-slate-500">Principal</p>
          <p className="text-slate-300">{fmt(loan.principal)}</p>
        </div>
        <div>
          <p className="text-slate-500">Unpaid interest</p>
          <p className={loan.accrued > 0 ? 'text-amber-300' : 'text-slate-300'}>{fmt(loan.accrued)}</p>
        </div>
        <div>
          <p className="text-slate-500">Costs / month</p>
          <p className={mi > 0 ? 'text-rose-300' : 'text-emerald-300'}>{mi > 0 ? fmt(mi) : '$0.00'}</p>
        </div>
      </div>

      {dormant && (
        <p className="text-[10px] text-emerald-400/80">
          Subsidized and in school — the government pays this interest. Costs you nothing right now.
        </p>
      )}
      {loan.accrued > 0 && loan.status === STATUS.DEFERRED && (
        <p className="text-[10px] text-amber-400/80">
          {fmt(loan.accrued)} of interest is waiting to capitalize
          {loan.capitalizesOn ? ` on ${loan.capitalizesOn}` : ' when repayment starts'} — after that it
          earns interest too. Paying it before then is the cheapest money you will ever spend.
        </p>
      )}

      {!paid && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => onPay(loan)}
            className="bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors"
          >
            Log payment
          </button>
          <button onClick={() => onReconcile(loan)} className="text-slate-500 hover:text-sky-300 text-xs">
            From statement
          </button>
          <button onClick={() => onEdit(loan)} className="text-slate-500 hover:text-teal-300 text-xs ml-auto">
            Edit
          </button>
          <button
            onClick={() => onDelete(loan)}
            disabled={deleting}
            className="text-slate-600 hover:text-rose-400 text-xs disabled:opacity-40"
          >
            {deleting ? '...' : 'Del'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Add / edit drawer ─────────────────────────────────────────────────────────
function LoanForm({ initial, onSave, onCancel, saving }) {
  const [f, setF] = useState(() => ({
    id: initial?.id || '',
    name: initial?.name || '',
    borrower: initial?.borrower || 'Me',
    servicer: initial?.servicer || '',
    principal: initial?.principal ?? '',
    accrued: initial?.accrued ?? '',
    rate: initial ? (initial.rate * 100) : '',
    status: initial?.status || STATUS.DEFERRED,
    subsidized: initial?.subsidized || false,
    minPayment: initial?.minPayment ?? '',
    capitalizesOn: initial?.capitalizesOn || '',
    notes: initial?.notes || '',
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const input = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-sm';
  const label = 'text-slate-400 text-[11px] mb-0.5 block';

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-slate-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 space-y-3 max-h-[90vh] overflow-y-auto">
        <p className="text-white font-bold">{initial ? 'Edit loan' : 'Add a loan'}</p>

        <div>
          <label className={label}>Name (as it appears on the statement)</label>
          <input className={input} value={f.name} onChange={set('name')} placeholder="MOHELA DLPLUS 10/13/22" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Borrower</label>
            <input className={input} value={f.borrower} onChange={set('borrower')} placeholder="Me / Mom" />
          </div>
          <div>
            <label className={label}>Servicer</label>
            <input className={input} value={f.servicer} onChange={set('servicer')} placeholder="MOHELA" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Principal</label>
            <input className={input} type="number" step="0.01" value={f.principal} onChange={set('principal')} />
          </div>
          <div>
            <label className={label}>Unpaid interest</label>
            <input className={input} type="number" step="0.01" value={f.accrued} onChange={set('accrued')} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Rate (%)</label>
            <input className={input} type="number" step="0.001" value={f.rate} onChange={set('rate')} placeholder="7.540" />
          </div>
          <div>
            <label className={label}>Minimum payment</label>
            <input className={input} type="number" step="0.01" value={f.minPayment} onChange={set('minPayment')} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Status</label>
            <select className={input} value={f.status} onChange={set('status')}>
              <option value={STATUS.DEFERRED}>Deferred / in school</option>
              <option value={STATUS.REPAYMENT}>In repayment</option>
              <option value={STATUS.PAID}>Paid off</option>
            </select>
          </div>
          <div>
            <label className={label}>Capitalizes on</label>
            <input className={input} type="date" value={f.capitalizesOn} onChange={set('capitalizesOn')} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-slate-300 text-xs">
          <input type="checkbox" checked={f.subsidized} onChange={set('subsidized')} />
          Subsidized (no interest accrues while in school)
        </label>
        <div>
          <label className={label}>Notes</label>
          <input className={input} value={f.notes} onChange={set('notes')} />
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="flex-1 bg-slate-800 text-slate-300 text-sm py-2 rounded-xl">Cancel</button>
          <button
            onClick={() => onSave({
              ...f,
              principal: Number(f.principal) || 0,
              accrued: Number(f.accrued) || 0,
              rate: (Number(f.rate) || 0) / 100,
              minPayment: Number(f.minPayment) || 0,
            })}
            disabled={saving || !f.name}
            className="flex-1 bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold py-2 rounded-xl disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Payment drawer ────────────────────────────────────────────────────────────
function PayForm({ loan, onSubmit, onCancel, saving }) {
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [note, setNote] = useState('');
  const amt = Number(amount) || 0;
  const preview = amt > 0 ? applyPayment(loan, amt) : null;
  const input = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-sm';

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-slate-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 space-y-3">
        <p className="text-white font-bold">Log a payment</p>
        <p className="text-slate-400 text-xs">{loan.name} — {fmt(loanBalance(loan))} outstanding</p>

        <input className={input} type="number" step="0.01" autoFocus value={amount}
               onChange={e => setAmount(e.target.value)} placeholder="Amount" />

        {preview && (
          <div className="bg-slate-800/60 rounded-lg p-2.5 text-[11px] space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">To interest</span>
              <span className="text-amber-300">{fmt(preview.toInterest)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">To principal</span>
              <span className="text-emerald-300">{fmt(preview.toPrincipal)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-700 pt-1">
              <span className="text-slate-400">Balance after</span>
              <span className="text-white font-semibold">{fmt(loanBalance(preview.loan))}</span>
            </div>
            {preview.unused > 0 && (
              <p className="text-emerald-400/80">{fmt(preview.unused)} more than this loan needs — put it on the next one.</p>
            )}
            {preview.toPrincipal > 0 && (
              <p className="text-slate-500 pt-1">
                Tell the servicer to apply the extra to PRINCIPAL on this loan. Otherwise they may just
                advance your due date, and the balance barely moves.
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <input className={input} value={paidBy} onChange={e => setPaidBy(e.target.value)} placeholder="Paid by (me / Mom)" />
          <input className={input} value={note} onChange={e => setNote(e.target.value)} placeholder="Note" />
        </div>

        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 bg-slate-800 text-slate-300 text-sm py-2 rounded-xl">Cancel</button>
          <button
            onClick={() => onSubmit({ amount: amt, ...preview, paidBy, note })}
            disabled={saving || amt <= 0}
            className="flex-1 bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold py-2 rounded-xl disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Record'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Loans({ token }) {
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drawer, setDrawer] = useState(null);      // null | 'add' | loan (edit)
  const [payLoan, setPayLoan] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [budget, setBudget] = useState(() => readStored(BUDGET_KEY, 0));
  const [strategy, setStrategy] = useState(() => readStored(STRATEGY_KEY, 'avalanche'));
  // Whose debt the plan covers. Parent PLUS loans are the parent's legal obligation, so
  // a plan for "my" loans should be able to leave them out.
  const [borrower, setBorrower] = useState(() => readStored(BORROWER_KEY, 'all'));

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      setLoans(parseLoans(await readLoans(token)));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { writeStored(BUDGET_KEY, budget); }, [budget]);
  useEffect(() => { writeStored(STRATEGY_KEY, strategy); }, [strategy]);
  useEffect(() => { writeStored(BORROWER_KEY, borrower); }, [borrower]);

  const borrowers = useMemo(() => [...new Set(loans.map(l => l.borrower).filter(Boolean))], [loans]);
  const live = useMemo(() => loans.filter(l =>
    l.status !== STATUS.PAID && loanBalance(l) > 0 && (borrower === 'all' || l.borrower === borrower),
  ), [loans, borrower]);
  const capAt = useMemo(() => capitalizeSchedule(live), [live]);
  const line = useMemo(() => freezeLine(live), [live]);
  const owed = useMemo(() => totalOwed(live), [live]);
  const order = useMemo(() => payoffOrder(live, strategy), [live, strategy]);
  const assessment = useMemo(() => assessPlan(live, budget), [live, budget]);
  const projection = useMemo(
    () => (budget > line ? projectPayoff(live, budget, { strategy, capitalizeAt: capAt }) : null),
    [live, budget, line, strategy, capAt],
  );
  const deferred = useMemo(() => live.filter(l => l.status === STATUS.DEFERRED && l.accrued > 0), [live]);
  const waiting = useMemo(
    () => (deferred.length ? { now: costOfWaiting(deferred, 0), two: costOfWaiting(deferred, 2) } : null),
    [deferred],
  );

  async function handleSave(form) {
    setSaving(true);
    try { await saveLoan(token, form); setDrawer(null); await load(); }
    catch (e) { alert(`Could not save: ${e.message || e}`); }
    finally { setSaving(false); }
  }

  async function handleDelete(loan) {
    if (!confirm(`Remove "${loan.name}" from the tracker? This does not affect the actual loan.`)) return;
    setDeleting(loan.id);
    try { await deleteLoan(token, { id: loan.id }); await load(); }
    catch (e) { alert(`Could not delete: ${e.message || e}`); }
    finally { setDeleting(null); }
  }

  async function handlePay({ amount, toInterest, toPrincipal, paidBy, note }) {
    setSaving(true);
    try {
      await logLoanPayment(token, { loan: payLoan, amount, toInterest, toPrincipal, paidBy, note, date: todayISO() });
      setPayLoan(null);
      await load();
    } catch (e) {
      alert(`Could not record payment: ${e.message || e}`);
    } finally { setSaving(false); }
  }

  async function handleReconcile(loan) {
    const p = prompt(`Principal from the latest statement for "${loan.name}":`, String(loan.principal));
    if (p == null) return;
    const a = prompt('Unpaid accrued interest from that statement:', String(loan.accrued));
    if (a == null) return;
    try { await reconcileLoan(token, { id: loan.id, principal: Number(p) || 0, accrued: Number(a) || 0 }); await load(); }
    catch (e) { alert(`Could not reconcile: ${e.message || e}`); }
  }

  const v = VERDICT[assessment.verdict] || VERDICT.growing;

  return (
    <div className="max-w-lg mx-auto px-4 py-5 pb-28">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-white font-bold text-xl font-broske">Loans</h1>
          <p className="text-slate-500 text-xs mt-1">
            What you owe, what it costs you every month, and whether the plan actually works.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!loading && <button onClick={load} className="text-slate-500 hover:text-teal-300 text-xs">Refresh</button>}
          <button onClick={() => setDrawer('add')}
                  className="bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold px-3 py-1.5 rounded-xl">
            + Add
          </button>
        </div>
      </div>

      {error && <div className="bg-rose-900/40 border border-rose-700/50 rounded-xl p-3 text-rose-200 text-xs mb-3">{error}</div>}
      {loading && <p className="text-slate-500 text-sm">Loading…</p>}

      {borrowers.length > 1 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-slate-500 text-[11px]">Whose:</span>
          {['all', ...borrowers].map(b => (
            <button key={b} onClick={() => setBorrower(b)}
              className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
                borrower === b
                  ? 'bg-teal-900/50 text-teal-300 border-teal-700/50'
                  : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:text-slate-200'
              }`}>
              {b === 'all' ? 'Everyone' : b}
            </button>
          ))}
        </div>
      )}

      {!loading && !live.length && (
        <div className="bg-slate-900/60 rounded-xl p-4 text-center space-y-2">
          <p className="text-slate-300 text-sm">No loans tracked yet.</p>
          <p className="text-slate-500 text-xs">
            Add one per loan on your statement. Each servicer lists principal, unpaid interest and the rate
            separately — enter them as shown and the rest is computed.
          </p>
        </div>
      )}

      {!loading && !!live.length && (
        <>
          {/* Headline */}
          <div className="bg-slate-900/60 rounded-xl p-4 mb-3 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-slate-500 text-[11px]">Total owed</p>
                <p className="text-white font-bold text-2xl">{fmt(owed)}</p>
              </div>
              <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${v.cls}`}>{v.label}</span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-[11px]">
              <div>
                <p className="text-slate-500">Freeze line</p>
                <p className="text-rose-300 font-semibold text-sm">{fmt(line)}/mo</p>
                <p className="text-slate-600 text-[10px]">pay less and balances grow</p>
              </div>
              <div>
                <p className="text-slate-500">Going to principal</p>
                <p className={`font-semibold text-sm ${assessment.surplus > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {fmt(assessment.surplus)}/mo
                </p>
                <p className="text-slate-600 text-[10px]">your budget minus the interest</p>
              </div>
            </div>

            <div>
              <label className="text-slate-400 text-[11px] mb-1 block">What you can put toward loans each month</label>
              <input
                type="number" step="0.01" value={budget || ''}
                onChange={e => setBudget(Number(e.target.value) || 0)}
                placeholder={`at least ${fmt(line)}`}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-sm"
              />
            </div>

            <p className={`text-[11px] ${assessment.surplus > 0 ? 'text-slate-400' : 'text-rose-300'}`}>
              {assessment.reason}
            </p>

            {projection && !projection.neverClears && (
              <div className="grid grid-cols-3 gap-2 text-center bg-slate-800/50 rounded-lg p-2">
                <div>
                  <p className="text-slate-500 text-[10px]">Debt-free in</p>
                  <p className="text-white text-sm font-semibold">{monthsLabel(projection.months)}</p>
                </div>
                <div>
                  <p className="text-slate-500 text-[10px]">Total paid</p>
                  <p className="text-white text-sm font-semibold">{fmt0(projection.totalPaid)}</p>
                </div>
                <div>
                  <p className="text-slate-500 text-[10px]">Interest</p>
                  <p className="text-amber-300 text-sm font-semibold">{fmt0(projection.totalInterest)}</p>
                </div>
              </div>
            )}
          </div>

          {/* Strategy */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-slate-500 text-[11px]">Order:</span>
            {['avalanche', 'snowball'].map(s => (
              <button key={s} onClick={() => setStrategy(s)}
                className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
                  strategy === s
                    ? 'bg-teal-900/50 text-teal-300 border-teal-700/50'
                    : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:text-slate-200'
                }`}>
                {s === 'avalanche' ? 'Avalanche (cheapest)' : 'Snowball (quick wins)'}
              </button>
            ))}
          </div>


          {/* Capitalization warning */}
          {waiting && (
            <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-3 mb-3 space-y-1">
              <p className="text-amber-200 text-xs font-semibold">Interest is waiting to capitalize</p>
              <p className="text-amber-100/70 text-[11px]">
                {fmt(deferred.reduce((s, l) => s + l.accrued, 0))} of unpaid interest sits on{' '}
                {deferred.length === 1 ? 'a deferred loan' : `${deferred.length} deferred loans`}. Left alone for
                two more years it becomes {fmt0(waiting.two.balanceAtRepayment)} owed instead of{' '}
                {fmt0(waiting.now.balanceAtRepayment)} — and the standard payment rises from{' '}
                {fmt(waiting.now.monthlyPayment)} to {fmt(waiting.two.monthlyPayment)} a month.
              </p>
            </div>
          )}

          {/* Loans */}
          <div className="space-y-2">
            {order.map((l, i) => (
              <LoanCard
                key={l.id} loan={l} rank={i + 1} isTarget={i === 0}
                onPay={setPayLoan} onEdit={setDrawer} onDelete={handleDelete}
                onReconcile={handleReconcile} deleting={deleting === l.id}
              />
            ))}
          </div>

          {/* Guardrails */}
          <div className="mt-4 bg-slate-900/40 rounded-xl p-3 space-y-2">
            <p className="text-slate-400 text-[11px] font-semibold">Before you send extra money</p>
            <ul className="text-slate-500 text-[10px] space-y-1 list-disc pl-4">
              <li>Keep a starter emergency fund first. Without one, the next surprise goes on a credit card at
                  20%+, which undoes more than the loan payment gained.</li>
              <li>Extra payments must be marked "apply to principal" on a named loan. By default a servicer
                  clears interest and pushes your due date forward instead.</li>
              <li>Only the person legally obligated on a loan can deduct its interest. Paying someone else's
                  loan does not give you the deduction — they claim it.</li>
              <li>Federal loans are discharged if the borrower dies; a Parent PLUS loan is also discharged if
                  the student dies. Refinancing privately to chase a lower rate destroys that protection, and
                  it cannot be undone.</li>
              <li>Auto-pay usually earns a 0.25% rate cut once a loan is in repayment. Free money.</li>
            </ul>
          </div>
        </>
      )}

      {drawer && (
        <LoanForm
          initial={drawer === 'add' ? null : drawer}
          onSave={handleSave}
          onCancel={() => setDrawer(null)}
          saving={saving}
        />
      )}
      {payLoan && (
        <PayForm loan={payLoan} onSubmit={handlePay} onCancel={() => setPayLoan(null)} saving={saving} />
      )}
    </div>
  );
}
