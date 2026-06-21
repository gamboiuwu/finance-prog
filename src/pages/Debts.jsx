// Debts.jsx — Debt Payoff Tracker (Task 26).
//
// Tracks outstanding debts (credit cards, loans, personal IOUs) alongside the
// budget and answers the two questions that actually matter: "how long until
// this is gone?" and "which order should I pay them in?". Everything financial
// lives in a new `Debts` sheet tab (Name | Type | Balance | Interest Rate (%) |
// Min Payment | Account | Target Date | Notes) — nothing sensitive on GitHub.
//
// Per the user's plan answers (Drive doc, Task 26):
//   Q1 debt types: Chase / personal IOUs / etc. → a small type list, free Name.
//   Q2 standalone page (reachable from nav) — built here as /debts.
//   Q3 show the avalanche-vs-snowball total-interest difference — yes.
//   Q4 logged payments flow into the budget — a payment writes a negative
//      Allocation Transaction (a spend) so it shows in budget history.
import { useState, useEffect, useCallback } from 'react';
import { readRange, appendRow, batchUpdateCells, clearRow, ensureSheetTab } from '../lib/sheets';

// ── number helpers (mirror the rest of the app) ───────────────────────────────
function pm(val) {
  if (!val && val !== 0) return 0;
  const n = parseFloat(String(val).replace(/[$,\s%]/g, ''));
  return isNaN(n) ? 0 : n;
}
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
const todayISO = () => new Date().toISOString().slice(0, 10);

const DEBT_TYPES = ['Credit Card', 'Student Loan', 'Car Loan', 'Medical Bill', 'Personal Loan', 'Other'];

// "14 months" → "1 yr 2 mo" for readability.
function monthsLabel(m) {
  if (!isFinite(m)) return 'never';
  if (m <= 0) return '0 mo';
  const y = Math.floor(m / 12), mo = m % 12;
  if (y === 0) return `${mo} mo`;
  if (mo === 0) return `${y} yr`;
  return `${y} yr ${mo} mo`;
}

// ── payoff math ───────────────────────────────────────────────────────────────
// Single-debt simulation: walk month by month accruing interest, applying a
// fixed payment, until the balance clears (or we conclude it never will because
// the payment doesn't even cover the monthly interest).
function simulatePayoff(balance, aprPct, payment) {
  let bal = Number(balance) || 0;
  const r = (Number(aprPct) || 0) / 100 / 12;
  const pay = Number(payment) || 0;
  if (bal <= 0) return { months: 0, interest: 0, payoff: true };
  if (pay <= 0) return { months: Infinity, interest: Infinity, payoff: false };
  let months = 0, interest = 0;
  while (bal > 0.005 && months < 1200) {
    const i = bal * r;
    interest += i;
    bal = bal + i - pay;
    months++;
  }
  if (bal > 0.005) return { months: Infinity, interest: Infinity, payoff: false };
  return { months, interest, payoff: true };
}

// Whole-portfolio simulation for a payoff STRATEGY. Every debt always gets its
// minimum; any extra (plus the freed-up minimums of debts already paid off) is
// thrown at the single target debt chosen by `mode`:
//   avalanche → highest interest rate first (least total interest)
//   snowball  → smallest balance first (fastest first win)
// Returns total interest paid and months to debt-free across all debts.
function simulateStrategy(debts, extra, mode) {
  const list = debts.map(d => ({ bal: Number(d.balance) || 0, r: (Number(d.apr) || 0) / 100 / 12, min: Number(d.minPayment) || 0 }));
  const extraPool = Number(extra) || 0;
  let totalInterest = 0, months = 0;
  const active = () => list.filter(d => d.bal > 0.005);
  const orderOf = (arr) => arr.slice().sort((a, b) => (mode === 'avalanche' ? b.r - a.r : a.bal - b.bal));

  while (active().length && months < 1200) {
    // 1. accrue this month's interest on every open balance
    list.forEach(d => { if (d.bal > 0.005) { const i = d.bal * d.r; d.bal += i; totalInterest += i; } });
    // 2. budget = minimums of all open debts + the steady extra
    let budget = active().reduce((s, d) => s + d.min, 0) + extraPool;
    // 3. pay each open debt its minimum
    orderOf(active()).forEach(d => { const pay = Math.min(d.min, d.bal); d.bal -= pay; budget -= pay; });
    // 4. funnel everything left into the priority order
    for (const d of orderOf(active())) {
      if (budget <= 0.005) break;
      const pay = Math.min(budget, d.bal);
      d.bal -= pay; budget -= pay;
    }
    months++;
  }
  return { months, totalInterest, payoff: active().length === 0 };
}

// ── milestone push (25/50/75/100 % paid off) ──────────────────────────────────
// Start balance is tracked per-debt-name in localStorage (the highest balance
// ever seen = the original) so we can show "% paid off" without a sheet column.
// Opaque label→amount only on-device; nothing financial leaves to GitHub.
const DEBT_START_KEY = '_fin_debt_start';
const DEBT_MILE_KEY  = '_fin_debt_milestones';
const MILESTONES = [25, 50, 75, 100];

const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

// Record/raise each debt's peak balance; returns the start map.
function syncDebtStarts(debts) {
  const m = readJSON(DEBT_START_KEY);
  let changed = false;
  debts.forEach(d => {
    const cur = Number(d.balance) || 0;
    if (m[d.name] == null || cur > m[d.name]) { m[d.name] = cur; changed = true; }
  });
  if (changed) writeJSON(DEBT_START_KEY, m);
  return m;
}
function payoffPct(name, balance, startMap) {
  const start = startMap[name];
  if (!start || start <= 0) return 0;
  return Math.max(0, Math.min(100, ((start - balance) / start) * 100));
}
// Fire a push for any milestone a debt just crossed; deduped per debt name.
function fireDebtMilestones(name, pct) {
  const all = readJSON(DEBT_MILE_KEY);
  const fired = all[name] || [];
  const crossed = MILESTONES.filter(m => pct >= m && !fired.includes(String(m)));
  if (!crossed.length) return;
  all[name] = [...fired, ...crossed.map(String)];
  writeJSON(DEBT_MILE_KEY, all);
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  const top = Math.max(...crossed);
  const body = top >= 100
    ? `🎉 "${name}" is paid off! Debt cleared — huge win.`
    : `💪 "${name}" is ${top}% paid down. Keep going!`;
  const show = () => { try { new Notification('Debt milestone', { body }); } catch { /* ignore */ } };
  if (Notification.permission === 'granted') show();
  else Notification.requestPermission().then(p => { if (p === 'granted') show(); });
}

// ── single debt card ──────────────────────────────────────────────────────────
function DebtCard({ d, startMap, onEdit, onDelete, onPay, isDeleting }) {
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState(0);

  const pct = payoffPct(d.name, d.balance, startMap);
  const base = simulatePayoff(d.balance, d.apr, d.minPayment);
  const boosted = simulatePayoff(d.balance, d.apr, d.minPayment + extra);
  const monthsSaved = isFinite(base.months) && isFinite(boosted.months) ? base.months - boosted.months : 0;
  const interestSaved = isFinite(base.interest) && isFinite(boosted.interest) ? base.interest - boosted.interest : 0;
  const minTooLow = !base.payoff; // payment never covers interest

  return (
    <div className="bg-slate-900/60 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-white text-sm font-semibold truncate flex-1 flex items-center gap-1.5">
          {pct >= 100 ? '✅' : '💳'} {d.name}
          <span className="text-slate-500 text-[10px] font-normal">{d.type}</span>
        </p>
        <button onClick={() => onEdit(d)} className="shrink-0 text-slate-500 hover:text-teal-300 text-xs px-1.5 py-0.5 rounded">Edit</button>
        <button onClick={() => onDelete(d)} disabled={isDeleting}
          className="shrink-0 text-slate-600 hover:text-rose-400 text-xs px-1.5 py-0.5 rounded disabled:opacity-40">
          {isDeleting ? '...' : 'Del'}
        </button>
      </div>

      {/* Paid-off progress bar */}
      <div className="h-2 bg-slate-700/60 rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-rose-300 font-mono tabular-nums font-semibold">{fmt(d.balance)} <span className="text-slate-500 font-normal">left</span></span>
        <span className="text-slate-400">{Math.round(pct)}% paid · {d.apr}% APR</span>
      </div>

      <div className="flex gap-2">
        <button onClick={() => onPay(d)}
          className="flex-1 bg-teal-600/90 hover:bg-teal-500 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors">
          ＋ Log Payment
        </button>
        <button onClick={() => setOpen(o => !o)}
          className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-1.5 rounded-lg transition-colors">
          {open ? 'Hide payoff' : '📉 Payoff plan'}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-700/60 pt-2 space-y-2.5">
          {minTooLow ? (
            <p className="text-amber-300 text-[11px] leading-snug">
              ⚠ The minimum payment ({fmt(d.minPayment)}) doesn't cover the monthly interest, so this never gets paid off. Increase the payment below.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-slate-800/60 rounded-lg py-2">
                <p className="text-slate-500 text-[9px] uppercase tracking-wide">At minimum</p>
                <p className="text-white text-sm font-bold">{monthsLabel(base.months)}</p>
                <p className="text-rose-300 text-[10px]">{fmt0(base.interest)} interest</p>
              </div>
              <div className="bg-slate-800/60 rounded-lg py-2">
                <p className="text-slate-500 text-[9px] uppercase tracking-wide">+{fmt0(extra)}/mo</p>
                <p className="text-white text-sm font-bold">{monthsLabel(boosted.months)}</p>
                <p className="text-emerald-300 text-[10px]">{fmt0(boosted.interest)} interest</p>
              </div>
            </div>
          )}

          {/* Extra-payment slider, $25 increments */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>Extra payment</span>
              <span className="text-teal-300 font-semibold">+{fmt0(extra)}/mo</span>
            </div>
            <input type="range" min="0" max={Math.max(500, Math.round((d.minPayment || 50) * 4 / 25) * 25)} step="25"
              value={extra} onChange={e => setExtra(Number(e.target.value))}
              className="w-full accent-teal-500" />
          </div>

          {extra > 0 && !minTooLow && (
            <p className="text-[11px] text-slate-300 leading-snug">
              Paying an extra {fmt0(extra)}/mo clears this <span className="text-emerald-300 font-semibold">{monthsLabel(monthsSaved)} sooner</span> and saves <span className="text-emerald-300 font-semibold">{fmt0(interestSaved)}</span> in interest.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── add / edit drawer ─────────────────────────────────────────────────────────
const EMPTY = { name: '', type: 'Credit Card', balance: '', apr: '', minPayment: '', account: '', targetDate: '', notes: '' };

function DebtDrawer({ initial, onSave, onClose, saving }) {
  const editing = Boolean(initial?._row);
  const [f, setF] = useState(() => initial ? {
    name: initial.name || '', type: initial.type || 'Credit Card',
    balance: initial.balance != null ? String(initial.balance) : '',
    apr: initial.apr != null ? String(initial.apr) : '',
    minPayment: initial.minPayment != null ? String(initial.minPayment) : '',
    account: initial.account || '', targetDate: initial.targetDate || '', notes: initial.notes || '',
  } : { ...EMPTY });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  function submit(e) {
    e.preventDefault();
    if (!f.name.trim()) return;
    onSave({
      _row: initial?._row,
      name: f.name.trim(), type: f.type,
      balance: pm(f.balance), apr: pm(f.apr), minPayment: pm(f.minPayment),
      account: f.account.trim(), targetDate: f.targetDate.trim(), notes: f.notes.trim(),
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <form className="bg-slate-900 rounded-t-2xl p-5 space-y-4 max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <div className="flex items-center justify-between">
          <p className="text-white font-semibold font-broske">{editing ? 'Edit Debt' : 'Add Debt'}</p>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Name</label>
          <input autoFocus className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
            placeholder="e.g. Chase Sapphire" value={f.name} onChange={e => set('name', e.target.value)} required />
        </div>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Type</label>
          <div className="flex flex-wrap gap-1.5">
            {DEBT_TYPES.map(t => (
              <button key={t} type="button" onClick={() => set('type', t)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${f.type === t ? 'bg-teal-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Balance ($)</label>
            <input type="number" min="0" step="0.01" inputMode="decimal"
              className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="2500" value={f.balance} onChange={e => set('balance', e.target.value)} required />
          </div>
          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Interest rate (% APR)</label>
            <input type="number" min="0" step="0.01" inputMode="decimal"
              className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="22.9" value={f.apr} onChange={e => set('apr', e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Min payment ($/mo)</label>
            <input type="number" min="0" step="0.01" inputMode="decimal"
              className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="75" value={f.minPayment} onChange={e => set('minPayment', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Target date</label>
            <input type="date" className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
              value={f.targetDate} onChange={e => set('targetDate', e.target.value)} />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Pay-from account (optional)</label>
          <input className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
            placeholder="e.g. Checking" value={f.account} onChange={e => set('account', e.target.value)} />
        </div>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Notes (optional)</label>
          <input className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
            placeholder="Any extra context..." value={f.notes} onChange={e => set('notes', e.target.value)} />
        </div>

        <button type="submit" disabled={saving || !f.name.trim()}
          className="w-full bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl transition-colors">
          {saving ? 'Saving...' : editing ? 'Save Changes' : 'Add Debt'}
        </button>
      </form>
    </div>
  );
}

// ── log-payment drawer ────────────────────────────────────────────────────────
function PaymentDrawer({ debt, onSave, onClose, saving }) {
  const [amount, setAmount] = useState(debt.minPayment ? String(debt.minPayment) : '');
  function submit(e) {
    e.preventDefault();
    const n = parseFloat(amount);
    if (!(n > 0)) return;
    onSave(debt, Math.round(n * 100) / 100);
  }
  const quick = [debt.minPayment, 50, 100, 200].filter(v => v > 0);
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <form className="bg-slate-900 rounded-t-2xl p-5 space-y-4" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <div className="flex items-center justify-between">
          <p className="text-white font-semibold font-broske">Pay {debt.name}</p>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">&times;</button>
        </div>
        <p className="text-slate-400 text-xs">Balance {fmt(debt.balance)} · this reduces the balance and logs the payment in your budget history.</p>
        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Payment amount ($)</label>
          <input autoFocus type="number" min="0" step="0.01" inputMode="decimal"
            className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl px-3 py-2.5 outline-none focus:ring-1 focus:ring-teal-500 font-mono tabular-nums"
            placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} required />
        </div>
        <div className="flex gap-2">
          {Array.from(new Set(quick)).map(v => (
            <button key={v} type="button" onClick={() => setAmount(String(v))}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium py-2 rounded-xl transition-colors">
              {fmt0(v)}
            </button>
          ))}
        </div>
        <button type="submit" disabled={saving || !(parseFloat(amount) > 0)}
          className="w-full bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl transition-colors">
          {saving ? 'Saving...' : 'Log payment'}
        </button>
      </form>
    </div>
  );
}

// ── strategy comparison (avalanche vs snowball) ───────────────────────────────
function StrategyPanel({ debts }) {
  const [extra, setExtra] = useState(0);
  const open = debts.filter(d => (Number(d.balance) || 0) > 0.005);
  if (open.length < 2) return null; // strategy only matters with multiple debts

  const ava = simulateStrategy(open, extra, 'avalanche');
  const sno = simulateStrategy(open, extra, 'snowball');
  const diff = Math.abs(ava.totalInterest - sno.totalInterest);
  const cheaper = ava.totalInterest <= sno.totalInterest ? 'Avalanche' : 'Snowball';
  const maxExtra = Math.max(500, Math.round(open.reduce((s, d) => s + (Number(d.minPayment) || 0), 0) * 3 / 25) * 25);

  return (
    <div className="bg-slate-900/60 rounded-xl p-3 space-y-3">
      <p className="text-white text-sm font-semibold">⚖️ Payoff strategy</p>
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-slate-400">
          <span>Extra toward debt each month (on top of minimums)</span>
          <span className="text-teal-300 font-semibold">+{fmt0(extra)}/mo</span>
        </div>
        <input type="range" min="0" max={maxExtra} step="25" value={extra} onChange={e => setExtra(Number(e.target.value))} className="w-full accent-teal-500" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-slate-800/60 rounded-lg p-2.5 space-y-0.5">
          <p className="text-white text-xs font-semibold">🏔 Avalanche</p>
          <p className="text-slate-500 text-[9px]">highest APR first</p>
          <p className="text-slate-300 text-[11px] mt-1">Debt-free in {monthsLabel(ava.months)}</p>
          <p className="text-rose-300 text-[11px]">{fmt0(ava.totalInterest)} interest</p>
        </div>
        <div className="bg-slate-800/60 rounded-lg p-2.5 space-y-0.5">
          <p className="text-white text-xs font-semibold">⛄ Snowball</p>
          <p className="text-slate-500 text-[9px]">smallest balance first</p>
          <p className="text-slate-300 text-[11px] mt-1">Debt-free in {monthsLabel(sno.months)}</p>
          <p className="text-rose-300 text-[11px]">{fmt0(sno.totalInterest)} interest</p>
        </div>
      </div>
      {diff > 1 && (
        <p className="text-[11px] text-emerald-300 leading-snug">
          {cheaper} saves you <span className="font-semibold">{fmt0(diff)}</span> in interest. Snowball gives you faster early wins; avalanche costs the least overall.
        </p>
      )}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function Debts({ token, embedded = false }) {
  const [debts, setDebts]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [drawer, setDrawer]   = useState(null);  // null | 'add' | debt (edit)
  const [payDebt, setPayDebt] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [startMap, setStartMap] = useState({});

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const rows = await readRange(token, 'Debts!A:H', 'UNFORMATTED_VALUE').catch(() => []);
      const startsHdr = String(rows[0]?.[0] || '').trim().toLowerCase() === 'name';
      const data = startsHdr ? rows.slice(1) : rows;
      const parsed = data
        .map((r, idx) => ({
          _row: idx + (startsHdr ? 2 : 1), // sheet row (1-based; header is row 1)
          name: String(r[0] || '').trim(),
          type: String(r[1] || 'Other'),
          balance: pm(r[2]),
          apr: pm(r[3]),
          minPayment: pm(r[4]),
          account: String(r[5] || ''),
          targetDate: r[6] != null ? String(r[6]) : '',
          notes: r[7] != null ? String(r[7]) : '',
        }))
        .filter(d => d.name);
      setStartMap(syncDebtStarts(parsed));
      setDebts(parsed);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function handleSave(d) {
    setSaving(true);
    try {
      await ensureSheetTab(token, 'Debts');
      // Guarantee a header row so reads stay aligned.
      const existing = await readRange(token, 'Debts!A1:H1').catch(() => []);
      if (!existing.length) {
        await appendRow(token, 'Debts!A1', ['Name', 'Type', 'Balance', 'Interest Rate (%)', 'Min Payment', 'Account', 'Target Date', 'Notes']);
      }
      const row = [d.name, d.type, d.balance, d.apr, d.minPayment, d.account, d.targetDate, d.notes];
      if (d._row) {
        await batchUpdateCells(token, [
          { range: `Debts!A${d._row}`, value: d.name },
          { range: `Debts!B${d._row}`, value: d.type },
          { range: `Debts!C${d._row}`, value: d.balance },
          { range: `Debts!D${d._row}`, value: d.apr },
          { range: `Debts!E${d._row}`, value: d.minPayment },
          { range: `Debts!F${d._row}`, value: d.account },
          { range: `Debts!G${d._row}`, value: d.targetDate },
          { range: `Debts!H${d._row}`, value: d.notes },
        ]);
      } else {
        await appendRow(token, 'Debts!A:H', row);
      }
      setDrawer(null);
      await load();
    } catch (e) {
      alert(`Could not save debt: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  }

  // Log a payment: reduce the sheet balance, append a negative Allocation
  // Transaction (a spend, so it shows in budget history per the user's Q4),
  // then fire any newly-crossed paid-off milestone.
  async function handlePayment(debt, amount) {
    setSaving(true);
    try {
      const newBalance = Math.max(0, (Number(debt.balance) || 0) - amount);
      await batchUpdateCells(token, [{ range: `Debts!C${debt._row}`, value: newBalance }]);
      await appendRow(token, 'Allocation Transactions!A:F', [
        todayISO(), debt.name, -Math.abs(amount),
        `Debt payment: ${debt.name}`, debt.account || 'Debts', true,
      ]);
      const pct = payoffPct(debt.name, newBalance, startMap);
      fireDebtMilestones(debt.name, pct);
      setPayDebt(null);
      await load();
    } catch (e) {
      alert(`Could not log payment: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(d) {
    if (!window.confirm(`Delete debt "${d.name}"? This cannot be undone.`)) return;
    setDeleting(d._row);
    try {
      await clearRow(token, `Debts!A${d._row}:H${d._row}`);
      await load();
    } catch (e) {
      alert(`Could not delete debt: ${e.message || e}`);
    } finally {
      setDeleting(null);
    }
  }

  const open = debts.filter(d => d.balance > 0.005);
  const cleared = debts.filter(d => d.balance <= 0.005);
  const totalDebt = open.reduce((s, d) => s + d.balance, 0);
  const totalMin = open.reduce((s, d) => s + d.minPayment, 0);

  function renderBody() {
    if (loading) return <p className="text-slate-500 text-sm text-center py-8">Loading debts...</p>;
    if (error)   return <p className="text-rose-300 text-sm text-center py-8">Could not load debts: {error}</p>;
    if (debts.length === 0) {
      return (
        <div className="text-center py-10 px-6 space-y-2">
          <p className="text-4xl">💳</p>
          <p className="text-white font-semibold font-broske">No debts tracked</p>
          <p className="text-slate-400 text-sm">Tap <strong className="text-teal-400">+ Add</strong> to track a credit card, loan, or IOU and see how fast you can pay it off.</p>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {/* Summary header */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-slate-900/60 rounded-xl py-2.5">
            <p className="text-slate-500 text-[9px] uppercase tracking-wide">Total debt</p>
            <p className="text-rose-300 text-base font-bold">{fmt0(totalDebt)}</p>
          </div>
          <div className="bg-slate-900/60 rounded-xl py-2.5">
            <p className="text-slate-500 text-[9px] uppercase tracking-wide">Accounts</p>
            <p className="text-white text-base font-bold">{open.length}</p>
          </div>
          <div className="bg-slate-900/60 rounded-xl py-2.5">
            <p className="text-slate-500 text-[9px] uppercase tracking-wide">Min/mo</p>
            <p className="text-white text-base font-bold">{fmt0(totalMin)}</p>
          </div>
        </div>

        <StrategyPanel debts={open} />

        <div className="space-y-2">
          {open.map(d => (
            <DebtCard key={d._row} d={d} startMap={startMap}
              onEdit={g => setDrawer(g)} onDelete={handleDelete} onPay={g => setPayDebt(g)}
              isDeleting={deleting === d._row} />
          ))}
        </div>

        {cleared.length > 0 && (
          <div className="space-y-2">
            <p className="text-slate-400 text-[11px] uppercase tracking-wider font-semibold">Paid off ({cleared.length})</p>
            {cleared.map(d => (
              <DebtCard key={d._row} d={d} startMap={startMap}
                onEdit={g => setDrawer(g)} onDelete={handleDelete} onPay={g => setPayDebt(g)}
                isDeleting={deleting === d._row} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={embedded ? '' : 'max-w-lg mx-auto px-4 py-5 pb-28'}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          {!embedded && <h1 className="text-white font-bold text-xl font-broske">Debts</h1>}
          <p className="text-slate-500 text-xs mt-1">Track balances, project payoff, and compare strategies.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!loading && <button onClick={load} className="text-slate-500 hover:text-teal-300 text-xs">Refresh</button>}
          <button onClick={() => setDrawer('add')}
            className="bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors">+ Add</button>
        </div>
      </div>

      {renderBody()}

      {drawer && (
        <DebtDrawer initial={drawer === 'add' ? null : drawer} onSave={handleSave} onClose={() => setDrawer(null)} saving={saving} />
      )}
      {payDebt && (
        <PaymentDrawer debt={payDebt} onSave={handlePayment} onClose={() => setPayDebt(null)} saving={saving} />
      )}
    </div>
  );
}
