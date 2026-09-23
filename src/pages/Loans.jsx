// Loans.jsx — the debt tab.
//
// Built around one number the rest of the app does not have: the FREEZE LINE, the
// monthly interest across everything currently accruing. Below it, balances grow
// no matter how disciplined the payer feels, so the page refuses to show a
// progress bar until the budget clears that line.
//
// The loans are an ENVELOPE like any other: "Student Loans" in Monthly Expenses.
// Its Monthly Allowance is the plan amount set here, Process Income fills it (the
// need is computed from the debt - lib/loans.js loanNeed), and a payment recorded
// here is a spend out of it. Interest is tracked through time in the Loan Interest
// ledger: every day accrues, month by month, whether or not the app is open (LIZA
// runs the same accrual nightly).
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
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import {
  STATUS, monthlyInterest, loanBalance, freezeLine, totalOwed, applyPayment,
  payoffOrder, projectPayoff, costOfWaiting, assessPlan, capitalizeSchedule,
  loanNeed, sendPlan, requiredMonthly, inScope, monthLabel, monthPayments,
  accrueTo, dailyInterest, interestHistory, LOAN_ENVELOPE,
} from '../lib/loans';
import {
  readLoans, parseLoans, saveLoan, deleteLoan, logLoanPayment, reconcileLoan,
  accrueLoans, readLoanPayments, readLoanInterest, loanRowsToObjects, monthKey,
  readLoanPlan, saveLoanPlan, ensureLoanEnvelope, setLoanPlanAmount,
} from '../lib/sheetWrite';
import { readRange } from '../lib/sheets';

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
// Local calendar date: toISOString() is UTC, which is tomorrow by 8pm in the US.
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthName = (ym) => {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
};

const VERDICT = {
  clear:       { label: 'Clear',        cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  strong:      { label: 'Strong',       cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  progressing: { label: 'Progressing',  cls: 'bg-teal-900/40 text-teal-300 border-teal-700/50' },
  frozen:      { label: 'Treading water', cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
  growing:     { label: 'Growing',      cls: 'bg-rose-900/40 text-rose-300 border-rose-700/50' },
};

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
          {mi > 0 && <p className="text-slate-600">{fmt(dailyInterest(loan))}/day</p>}
        </div>
      </div>
      {loan.asOf && <p className="text-[9px] text-slate-600">Interest tracked to {loan.asOf}</p>}

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
    asOf: initial?.asOf || todayISO(),
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
        <div>
          <label className={label}>Balances true as of (statement date — interest is tracked from here)</label>
          <input className={input} type="date" value={f.asOf} onChange={set('asOf')} />
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
// The loan's interest is brought current to the payment date first, so the split
// shown is the split the servicer will make.
function PayForm({ loan, suggested, envelopeBalance, onSubmit, onCancel, saving }) {
  const [amount, setAmount] = useState(suggested ? String(suggested.toFixed(2)) : '');
  const [date, setDate] = useState(todayISO());
  const [paidBy, setPaidBy] = useState(loan.borrower === 'Me' ? 'Me' : '');
  const [fromEnvelope, setFromEnvelope] = useState(loan.borrower === 'Me');
  const [note, setNote] = useState('');
  const amt = Number(amount) || 0;
  const current = accrueTo(loan, date).loan;
  const preview = amt > 0 ? applyPayment(current, amt) : null;
  const input = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-sm';

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-slate-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 space-y-3">
        <p className="text-white font-bold">Log a payment</p>
        <p className="text-slate-400 text-xs">
          {loan.servicer} {loan.name} — {fmt(loanBalance(current))} owed on {date}
          {current.accrued > 0 && <> ({fmt(current.accrued)} of it interest)</>}
        </p>

        <div className="grid grid-cols-2 gap-2">
          <input className={input} type="number" step="0.01" autoFocus value={amount}
                 onChange={e => setAmount(e.target.value)} placeholder="Amount" />
          <input className={input} type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>

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
            <div className="flex justify-between">
              <span className="text-slate-400">Interest per day after</span>
              <span className="text-slate-300">{fmt(dailyInterest(preview.loan))}</span>
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
          <input className={input} value={paidBy} onChange={e => setPaidBy(e.target.value)} placeholder="Paid by (Me / Mom)" />
          <input className={input} value={note} onChange={e => setNote(e.target.value)} placeholder="Note / confirmation #" />
        </div>
        <label className="flex items-start gap-2 text-slate-300 text-xs">
          <input type="checkbox" className="mt-0.5" checked={fromEnvelope} onChange={e => setFromEnvelope(e.target.checked)} />
          <span>
            Paid from the {LOAN_ENVELOPE} envelope (holds {fmt(envelopeBalance)}). Logs it as a spend, like any
            other envelope. Untick when someone else paid it directly.
          </span>
        </label>

        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 bg-slate-800 text-slate-300 text-sm py-2 rounded-xl">Cancel</button>
          <button
            onClick={() => onSubmit({ amount: amt, date, paidBy, note, fromEnvelope })}
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

// ── Interest through time ────────────────────────────────────────────────────
function InterestHistory({ history, perDay, line }) {
  if (!history.length) return null;
  const total = history.at(-1).cumulative;
  const data = history.map(h => ({ month: monthName(h.month), interest: h.interest, cumulative: h.cumulative }));
  return (
    <div className="bg-slate-900/60 rounded-xl p-3 mb-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-slate-300 text-xs font-semibold">Interest charged over time</p>
        <p className="text-amber-300 text-xs font-semibold">{fmt(total)} since {monthName(history[0].month)}</p>
      </div>
      <div className="h-40 -ml-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <CartesianGrid stroke="#334155" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis yAxisId="m" tick={{ fill: '#94a3b8', fontSize: 10 }} width={44} />
            <YAxis yAxisId="c" orientation="right" tick={{ fill: '#94a3b8', fontSize: 10 }} width={48} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }}
              formatter={(v, k) => [fmt(v), k === 'interest' ? 'That month' : 'Running total']}
            />
            <Bar yAxisId="m" dataKey="interest" fill="#f59e0b" radius={[3, 3, 0, 0]} />
            <Line yAxisId="c" dataKey="cumulative" stroke="#fb7185" dot={false} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-slate-500 text-[10px]">
        Accruing {fmt(perDay)} a day ({fmt(line)} a month) right now. Every row is in the Loan Interest tab —
        one line per loan per month, from the statement date forward.
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Loans({ token }) {
  const [loans, setLoans] = useState([]);
  const [payments, setPayments] = useState([]);
  const [interestRows, setInterestRows] = useState([]);
  const [plan, setPlan] = useState({ scope: 'Me', strategy: 'avalanche', debtFreeBy: '' });
  const [envelope, setEnvelope] = useState({ allowance: 0, balance: 0, fundedMonth: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drawer, setDrawer] = useState(null);      // null | 'add' | loan (edit)
  const [pay, setPay] = useState(null);            // { loan, amount }
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [budgetDraft, setBudgetDraft] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      // Interest first: bring every loan current to today (writes the ledger rows the
      // nightly job has not yet), then read everything else against those balances.
      const current = await accrueLoans(token, parseLoans(await readLoans(token)), { source: 'app' });
      const [payRows, intRows, planKv, env, alloc] = await Promise.all([
        readLoanPayments(token),
        readLoanInterest(token),
        readLoanPlan(token),
        ensureLoanEnvelope(token),
        readRange(token, 'Allocation Transactions!A:F', 'UNFORMATTED_VALUE').catch(() => []),
      ]);
      const ym = todayISO().slice(0, 7);
      let balance = 0, fundedMonth = 0;
      (alloc || []).slice(1).forEach(r => {
        if (String(r?.[1] || '').trim().toLowerCase() !== LOAN_ENVELOPE.toLowerCase()) return;
        const v = Number(String(r[2]).replace(/[$,]/g, '')) || 0;
        balance += v;
        if (v > 0 && monthKey(r[0]) === ym) fundedMonth += v;
      });
      setLoans(current);
      // Only the month matters to the statements here; monthKey reads serials and strings alike.
      setPayments(loanRowsToObjects(payRows).map(p => ({ ...p, Date: monthKey(p.Date) ? `${monthKey(p.Date)}-01` : '' })));
      setInterestRows(loanRowsToObjects(intRows).map(r => ({ ...r, Month: monthKey(r.Month) || String(r.Month).slice(0, 7) })));
      setPlan(planKv);
      setEnvelope({ allowance: env.allowance, balance: Math.round(balance * 100) / 100, fundedMonth: Math.round(fundedMonth * 100) / 100 });
      setBudgetDraft(env.allowance ? String(env.allowance) : '');
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const scope = plan.scope || 'Me';
  const strategy = plan.strategy || 'avalanche';
  const borrowers = useMemo(() => [...new Set(loans.map(l => l.borrower).filter(Boolean))], [loans]);
  const live = useMemo(() => inScope(loans, scope), [loans, scope]);
  const liveIds = useMemo(() => new Set(live.map(l => l.id)), [live]);
  const line = useMemo(() => freezeLine(live), [live]);
  const perDay = useMemo(() => live.reduce((s, l) => s + dailyInterest(l), 0), [live]);
  const owed = useMemo(() => totalOwed(live), [live]);
  const order = useMemo(() => payoffOrder(live, strategy), [live, strategy]);
  const need = useMemo(() => loanNeed(loans, { plan: envelope.allowance, scope }), [loans, envelope.allowance, scope]);
  const capAt = useMemo(() => capitalizeSchedule(live), [live]);
  const assessment = useMemo(() => assessPlan(live, need.target), [live, need.target]);
  const projection = useMemo(
    () => (need.target > line ? projectPayoff(live, need.target, { strategy, capitalizeAt: capAt }) : null),
    [live, need.target, line, strategy, capAt],
  );
  const goal = useMemo(() => {
    if (!plan.debtFreeBy) return null;
    const [y, m] = plan.debtFreeBy.split('-').map(Number);
    const now = new Date();
    const months = (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth());
    if (months < 1) return { months, perMonth: null };
    return { months, perMonth: requiredMonthly(live, months, { strategy, capitalizeAt: capAt }) };
  }, [plan.debtFreeBy, live, strategy, capAt]);
  const send = useMemo(() => sendPlan(live, Math.max(0, envelope.balance), strategy), [live, envelope.balance, strategy]);
  const history = useMemo(() => interestHistory(interestRows, { loanIds: liveIds }), [interestRows, liveIds]);
  const month = useMemo(() => {
    const [y, m] = todayISO().split('-').map(Number);
    const ym = todayISO().slice(0, 7);
    const paid = monthPayments(payments.filter(p => liveIds.has(String(p['Loan ID']))), y, m);
    const accrued = history.find(h => h.month === ym)?.interest || 0;
    return { ...paid, accrued, net: Math.round((accrued - paid.paid) * 100) / 100 };
  }, [payments, history, liveIds]);
  const deferred = useMemo(() => live.filter(l => l.status === STATUS.DEFERRED && l.accrued > 0), [live]);
  const waiting = useMemo(
    () => (deferred.length ? { now: costOfWaiting(deferred, 0), two: costOfWaiting(deferred, 2) } : null),
    [deferred],
  );

  async function savePlanPatch(patch) {
    setPlan(p => ({ ...p, ...patch }));
    try { await saveLoanPlan(token, patch); } catch (e) { setError(`Could not save the plan: ${e.message || e}`); }
  }

  async function saveBudget(value) {
    const v = Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
    setSaving(true);
    try { await setLoanPlanAmount(token, v); setEnvelope(e => ({ ...e, allowance: v })); setBudgetDraft(v ? String(v) : ''); }
    catch (e) { setError(`Could not set the plan: ${e.message || e}`); }
    finally { setSaving(false); }
  }

  async function handleSave(form) {
    setSaving(true);
    try { await saveLoan(token, form); setDrawer(null); await load(); }
    catch (e) { setError(`Could not save: ${e.message || e}`); }
    finally { setSaving(false); }
  }

  async function handleDelete(loan) {
    if (!window.confirm(`Remove "${loan.name}" from the tracker? This does not affect the actual loan.`)) return;
    setDeleting(loan.id);
    try { await deleteLoan(token, { id: loan.id }); await load(); }
    catch (e) { setError(`Could not delete: ${e.message || e}`); }
    finally { setDeleting(null); }
  }

  async function handlePay({ amount, date, paidBy, note, fromEnvelope }) {
    setSaving(true);
    try {
      await logLoanPayment(token, { loan: pay.loan, amount, date, paidBy, note, fromEnvelope });
      setPay(null);
      await load();
    } catch (e) {
      setError(`Could not record payment: ${e.message || e}`);
    } finally { setSaving(false); }
  }

  async function handleReconcile(loan) {
    const p = window.prompt(`Principal from the latest statement for "${loan.name}":`, String(loan.principal));
    if (p == null) return;
    const a = window.prompt('Unpaid accrued interest on that statement:', String(loan.accrued));
    if (a == null) return;
    const d = window.prompt('Statement date (YYYY-MM-DD) - interest is tracked forward from here:', todayISO());
    if (d == null) return;
    try { await reconcileLoan(token, { id: loan.id, principal: Number(p) || 0, accrued: Number(a) || 0, asOf: d.slice(0, 10) }); await load(); }
    catch (e) { setError(`Could not reconcile: ${e.message || e}`); }
  }

  const v = VERDICT[assessment.verdict] || VERDICT.growing;
  const chip = (active) => `text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
    active ? 'bg-teal-900/50 text-teal-300 border-teal-700/50' : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:text-slate-200'}`;
  const budgetDirty = (Number(budgetDraft) || 0) !== envelope.allowance;

  return (
    <div className="max-w-lg mx-auto px-4 py-5 pb-28">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-white font-bold text-xl font-broske">Loans</h1>
          <p className="text-slate-500 text-xs mt-1">
            What you owe today, what it costs every day, and the fastest way out.
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

      {error && (
        <div className="bg-rose-900/40 border border-rose-700/50 rounded-xl p-3 text-rose-200 text-xs mb-3 flex gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-rose-300">✕</button>
        </div>
      )}
      {loading && <p className="text-slate-500 text-sm">Loading…</p>}

      {borrowers.length > 1 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-slate-500 text-[11px]">Plan covers:</span>
          {[...borrowers, 'all'].map(b => (
            <button key={b} onClick={() => savePlanPatch({ scope: b })} className={chip(scope === b)}>
              {b === 'all' ? 'Everyone' : b}
            </button>
          ))}
        </div>
      )}

      {!loading && !live.length && (
        <div className="bg-slate-900/60 rounded-xl p-4 text-center space-y-2">
          <p className="text-slate-300 text-sm">{loans.length ? 'Nothing outstanding in this plan.' : 'No loans tracked yet.'}</p>
          <p className="text-slate-500 text-xs">
            Add one per loan on your statement. Each servicer lists principal, unpaid interest and the rate
            separately — enter them as shown, with the statement date, and the rest is computed.
          </p>
        </div>
      )}

      {!loading && !!live.length && (
        <>
          {/* Headline */}
          <div className="bg-slate-900/60 rounded-xl p-4 mb-3 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-slate-500 text-[11px]">Owed today</p>
                <p className="text-white font-bold text-2xl">{fmt(owed)}</p>
              </div>
              <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${v.cls}`}>{v.label}</span>
            </div>

            <div className="grid grid-cols-3 gap-3 text-[11px]">
              <div>
                <p className="text-slate-500">Interest / day</p>
                <p className="text-rose-300 font-semibold text-sm">{fmt(perDay)}</p>
              </div>
              <div>
                <p className="text-slate-500">Freeze line</p>
                <p className="text-rose-300 font-semibold text-sm">{fmt(line)}/mo</p>
              </div>
              <div>
                <p className="text-slate-500">To principal</p>
                <p className={`font-semibold text-sm ${assessment.surplus > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {fmt(assessment.surplus)}/mo
                </p>
              </div>
            </div>

            <div>
              <label className="text-slate-400 text-[11px] mb-1 block">
                Monthly plan — the {LOAN_ENVELOPE} envelope's allowance; Process Income funds it
              </label>
              <div className="flex gap-2">
                <input
                  type="number" step="0.01" value={budgetDraft}
                  onChange={e => setBudgetDraft(e.target.value)}
                  placeholder={`blank = cover the interest (${fmt(line)})`}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-sm"
                />
                {budgetDirty && (
                  <button onClick={() => saveBudget(budgetDraft)} disabled={saving}
                    className="bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold px-3 rounded-lg disabled:opacity-40">
                    {saving ? '…' : 'Save'}
                  </button>
                )}
              </div>
            </div>

            <p className={`text-[11px] ${need.tier === 'growing' || need.tier === 'due' ? 'text-rose-300' : 'text-slate-400'}`}>
              Process Income will ask for {fmt(need.target)} a month. {need.reason}
            </p>

            {projection && !projection.neverClears && (
              <div className="grid grid-cols-3 gap-2 text-center bg-slate-800/50 rounded-lg p-2">
                <div>
                  <p className="text-slate-500 text-[10px]">Debt-free</p>
                  <p className="text-white text-sm font-semibold">{monthLabel(projection.months)}</p>
                  <p className="text-slate-500 text-[9px]">{monthsLabel(projection.months)}</p>
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

            {/* Goal: pick a date, get the monthly number */}
            <div className="border-t border-slate-800 pt-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <label className="text-slate-400 text-[11px] shrink-0">Debt-free by</label>
                <input type="month" value={(plan.debtFreeBy || '').slice(0, 7)}
                  onChange={e => savePlanPatch({ debtFreeBy: e.target.value ? `${e.target.value}-01` : '' })}
                  className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-white text-xs" />
              </div>
              {goal && goal.perMonth != null && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-slate-300 flex-1">
                    Needs <span className="text-white font-semibold">{fmt(goal.perMonth)}/mo</span> for {goal.months} months
                    {goal.perMonth > need.target ? <span className="text-amber-300"> — {fmt(goal.perMonth - need.target)} more than now</span> : <span className="text-emerald-300"> — the plan already gets there</span>}
                  </span>
                  {Math.abs(goal.perMonth - envelope.allowance) > 0.005 && (
                    <button onClick={() => saveBudget(goal.perMonth)} disabled={saving}
                      className="text-teal-300 hover:text-teal-200 text-[11px] font-semibold shrink-0">Use this</button>
                  )}
                </div>
              )}
              {goal && goal.perMonth == null && <p className="text-rose-300 text-[11px]">Pick a month in the future.</p>}
            </div>
          </div>

          {/* The envelope: money set aside, and exactly where it should go */}
          <div className="bg-slate-900/60 rounded-xl p-3 mb-3 space-y-2">
            <div className="flex items-baseline justify-between">
              <p className="text-slate-300 text-xs font-semibold">{LOAN_ENVELOPE} envelope</p>
              <p className={`text-sm font-semibold ${envelope.balance > 0 ? 'text-emerald-300' : 'text-slate-400'}`}>{fmt(envelope.balance)}</p>
            </div>
            <p className="text-slate-500 text-[10px]">
              Funded {fmt(envelope.fundedMonth)} of {fmt(need.target)} this month.
              {envelope.fundedMonth + 0.005 < need.target ? ` The next paycheck you process is asked for ${fmt(need.target - envelope.fundedMonth)}.` : ' This month is covered.'}
            </p>
            {send.lines.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-slate-400 text-[10px] uppercase tracking-wider">Send it now ({strategy})</p>
                {send.lines.map(l => {
                  const loan = live.find(x => x.id === l.id);
                  return (
                    <div key={l.id} className="flex items-center gap-2 text-[11px] bg-slate-800/50 rounded-lg px-2 py-1.5">
                      <span className="flex-1 text-slate-200 truncate">
                        {l.servicer} {l.name}
                        <span className="text-slate-500"> · {fmt(l.toInterest)} int / {fmt(l.toPrincipal)} principal{l.required ? ' · minimum' : ''}</span>
                      </span>
                      <span className="text-white font-mono">{fmt(l.amount)}</span>
                      <button onClick={() => setPay({ loan, amount: l.amount })}
                        className="bg-teal-600 hover:bg-teal-500 text-white px-2 py-0.5 rounded-md font-semibold">Paid</button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-slate-500 text-[10px]">Nothing set aside yet — process income to fill it, then pay from here.</p>
            )}
          </div>

          {/* This month */}
          <div className="bg-slate-900/60 rounded-xl p-3 mb-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-slate-500 text-[10px]">Interest this month</p>
              <p className="text-amber-300 text-sm font-semibold">{fmt(month.accrued)}</p>
            </div>
            <div>
              <p className="text-slate-500 text-[10px]">Paid this month</p>
              <p className="text-emerald-300 text-sm font-semibold">{fmt(month.paid)}</p>
              {month.paid > 0 && <p className="text-slate-500 text-[9px]">{fmt(month.toPrincipal)} principal</p>}
            </div>
            <div>
              <p className="text-slate-500 text-[10px]">Balance change</p>
              <p className={`text-sm font-semibold ${month.net > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{month.net > 0 ? '+' : ''}{fmt(month.net)}</p>
            </div>
          </div>

          <InterestHistory history={history} perDay={perDay} line={line} />

          {/* Strategy */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-slate-500 text-[11px]">Order:</span>
            {['avalanche', 'snowball'].map(s => (
              <button key={s} onClick={() => savePlanPatch({ strategy: s })} className={chip(strategy === s)}>
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
                onPay={(loan) => setPay({ loan, amount: 0 })} onEdit={setDrawer} onDelete={handleDelete}
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
              <li>Credit card debt costs more than any of these loans — it should be cleared first.</li>
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
      {pay && (
        <PayForm loan={pay.loan} suggested={pay.amount} envelopeBalance={envelope.balance}
          onSubmit={handlePay} onCancel={() => setPay(null)} saving={saving} />
      )}
    </div>
  );
}
