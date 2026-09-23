// loans.js — the debt engine.
//
// Pure functions only: no I/O, no React. Everything the Loans tab shows is derived
// here so it can be property-tested the same way allocation.js is.
//
// The rules encoded here come from how federal student loans actually behave, and
// the app is wrong in a way that costs real money if it gets them wrong:
//
//  1. A payment is applied fees -> accrued interest -> principal. Never principal
//     first. (CFPB, "How is my student loan payment applied to my account?")
//  2. While a loan is deferred, interest still accrues on PRINCIPAL only. The
//     unpaid interest sits in its own bucket and does NOT itself earn interest.
//  3. When the loan leaves deferment that unpaid bucket CAPITALIZES: it is added
//     to principal, and from then on it does earn interest. This is the single
//     most expensive event in the life of the loan, and the only way to blunt it
//     is to pay the interest down before it happens.
//  4. A subsidized loan accrues nothing while the borrower is in school — the
//     government pays it. Treating it like an unsubsidized loan overstates the
//     bleed and sends money to the wrong loan.
//
// The "freeze line" below is the number that matters most day to day: the monthly
// interest across everything currently accruing. Pay less than that and balances
// grow no matter how diligent the payer feels.

import { cents } from './allocation.js';

export const STATUS = {
  DEFERRED: 'deferred',     // in-school / grace / forbearance — nothing due
  REPAYMENT: 'repayment',   // scheduled payments are due
  PAID: 'paid',
};

/** Monthly interest a loan throws off right now. Subsidized+deferred accrues nothing. */
export function monthlyInterest(loan) {
  if (!loan || loan.status === STATUS.PAID) return 0;
  if (loan.subsidized && loan.status === STATUS.DEFERRED) return 0;
  return cents((Number(loan.principal) || 0) * (Number(loan.rate) || 0) / 12);
}

/** Everything owed on a loan today: principal plus interest not yet paid. */
export function loanBalance(loan) {
  return cents((Number(loan?.principal) || 0) + (Number(loan?.accrued) || 0));
}

/**
 * The freeze line: total monthly interest across a set of loans.
 * Paying exactly this holds every balance still. Paying less means they grow.
 */
export function freezeLine(loans) {
  return cents((loans || []).reduce((s, l) => s + monthlyInterest(l), 0));
}

/** Total owed across a set of loans. */
export function totalOwed(loans) {
  return cents((loans || []).reduce((s, l) => s + loanBalance(l), 0));
}

/**
 * Apply a payment to one loan the way a servicer does: interest first, then principal.
 * Returns the resulting loan plus the split, and never lets either bucket go negative.
 */
export function applyPayment(loan, amount) {
  const pay = cents(Math.max(0, Number(amount) || 0));
  const accrued = cents(Number(loan.accrued) || 0);
  const toInterest = cents(Math.min(pay, accrued));
  const toPrincipal = cents(Math.min(cents(pay - toInterest), cents(Number(loan.principal) || 0)));
  const next = {
    ...loan,
    accrued: cents(accrued - toInterest),
    principal: cents((Number(loan.principal) || 0) - toPrincipal),
  };
  if (next.principal <= 0 && next.accrued <= 0) {
    next.principal = 0; next.accrued = 0; next.status = STATUS.PAID;
  }
  // Money offered beyond the payoff is not consumed — the caller rolls it onward.
  const applied = cents(toInterest + toPrincipal);
  return { loan: next, toInterest, toPrincipal, applied, unused: cents(pay - applied) };
}

/** Accrue one month of interest onto a loan's unpaid-interest bucket. */
export function accrueMonth(loan) {
  const i = monthlyInterest(loan);
  if (!i) return { ...loan };
  return { ...loan, accrued: cents((Number(loan.accrued) || 0) + i) };
}

/**
 * Capitalize: fold unpaid interest into principal. Happens when a loan leaves
 * deferment. After this the interest earns interest, which is why the UI warns
 * about it ahead of time.
 */
export function capitalize(loan) {
  const accrued = cents(Number(loan.accrued) || 0);
  if (!accrued) return { ...loan };
  return { ...loan, principal: cents((Number(loan.principal) || 0) + accrued), accrued: 0 };
}

/**
 * The rate a loan is ACTUALLY charging right now.
 *
 * A subsidized loan in deferment costs nothing — the government is paying its
 * interest — so for the purpose of deciding where the next dollar goes, its rate
 * is zero however high the number on the statement is. Ordering by the printed
 * rate sends money at a loan that is not charging for the delay, while a loan
 * that is charging keeps compounding. The stated rate starts mattering the moment
 * the loan enters repayment.
 */
export function effectiveRate(loan) {
  if (!loan) return 0;
  if (loan.subsidized && loan.status === STATUS.DEFERRED) return 0;
  return Number(loan.rate) || 0;
}

/**
 * Payoff order. 'avalanche' = most expensive first (cheapest overall, the default),
 * measured by what each loan actually costs to carry today, not by the printed rate;
 * 'snowball' = smallest balance first (slower, but the early wins keep some people
 * paying at all, which beats an optimal plan they abandon).
 * Ties break on balance so the order is stable and reproducible.
 */
export function payoffOrder(loans, strategy = 'avalanche') {
  const live = (loans || []).filter(l => l.status !== STATUS.PAID && loanBalance(l) > 0);
  const by = strategy === 'snowball'
    ? (a, b) => loanBalance(a) - loanBalance(b) || (effectiveRate(b) - effectiveRate(a))
    : (a, b) => (effectiveRate(b) - effectiveRate(a)) || (loanBalance(a) - loanBalance(b));
  return [...live].sort(by);
}

/**
 * Project a payoff month by month.
 *
 * budget is the TOTAL going to these loans each month. Required minimums on loans
 * in repayment are paid first; whatever is left attacks the target loan chosen by
 * the strategy. When a loan clears, its share rolls to the next one — the payment
 * stays constant and the payoff accelerates.
 *
 * Returns { months, schedule, totalPaid, totalInterest, clearedAt, neverClears }.
 * neverClears is true when the budget cannot outrun the interest, which the UI
 * must say out loud rather than printing a fake horizon.
 */
export function projectPayoff(loans, budget, { strategy = 'avalanche', maxMonths = 600, capitalizeAt = {} } = {}) {
  let state = (loans || [])
    .filter(l => l.status !== STATUS.PAID && loanBalance(l) > 0)
    .map(l => ({ ...l, principal: cents(Number(l.principal) || 0), accrued: cents(Number(l.accrued) || 0) }));

  const spend = cents(Math.max(0, Number(budget) || 0));
  const startPrincipal = cents(state.reduce((s, l) => s + l.principal, 0));
  const schedule = [];
  let totalPaid = 0, totalInterest = 0, m = 0;

  while (state.some(l => loanBalance(l) > 0) && m < maxMonths) {
    m += 1;

    // A loan scheduled to leave deferment this month capitalizes first.
    state = state.map(l => (capitalizeAt[l.id] === m ? capitalize({ ...l, status: STATUS.REPAYMENT }) : l));

    // Interest accrues before anything is paid.
    state = state.map(accrueMonth);
    const accruedThisMonth = cents(state.reduce((s, l) => s + monthlyInterest(l), 0));

    let remaining = spend;
    const paidThisMonth = {};

    // 1. Required minimums on loans actually in repayment.
    for (let i = 0; i < state.length; i++) {
      const l = state[i];
      if (l.status !== STATUS.REPAYMENT || loanBalance(l) <= 0) continue;
      const due = cents(Math.min(Number(l.minPayment) || 0, loanBalance(l), remaining));
      if (due <= 0) continue;
      const r = applyPayment(l, due);
      state[i] = r.loan;
      remaining = cents(remaining - r.applied);
      totalInterest = cents(totalInterest + r.toInterest);
      paidThisMonth[l.id] = cents((paidThisMonth[l.id] || 0) + r.applied);
    }

    // 2. Everything left attacks the ordered targets, rolling forward on payoff.
    for (const target of payoffOrder(state, strategy)) {
      if (remaining <= 0) break;
      const i = state.findIndex(l => l.id === target.id);
      if (i < 0 || loanBalance(state[i]) <= 0) continue;
      const r = applyPayment(state[i], remaining);
      state[i] = r.loan;
      remaining = r.unused;
      totalInterest = cents(totalInterest + r.toInterest);
      paidThisMonth[target.id] = cents((paidThisMonth[target.id] || 0) + r.applied);
    }

    const spentThisMonth = cents(spend - remaining);
    totalPaid = cents(totalPaid + spentThisMonth);
    schedule.push({
      month: m,
      paid: spentThisMonth,
      interest: accruedThisMonth,
      balance: totalOwed(state),
      byLoan: paidThisMonth,
    });

    // Budget can't cover even the interest — balances are growing. Stop and say so.
    if (spentThisMonth <= 0 && accruedThisMonth > 0) {
      return { months: null, schedule, totalPaid, totalInterest, neverClears: true, endBalance: totalOwed(state) };
    }
  }

  const cleared = !state.some(l => loanBalance(l) > 0);
  return {
    months: cleared ? m : null,
    schedule,
    totalPaid,
    // Once everything is cleared, every dollar beyond the original principal was
    // interest -- including interest that capitalized and was then repaid as
    // "principal". Summing the servicer's interest splits would hide that.
    totalInterest: cleared ? cents(totalPaid - startPrincipal) : totalInterest,
    neverClears: !cleared,
    endBalance: totalOwed(state),
  };
}

/**
 * What deferring costs. Compares paying the interest now against letting it build
 * and capitalize, then repaying over `termMonths`. This is the number that makes
 * the case for acting during school rather than after.
 */
export function costOfWaiting(loans, years, termMonths = 120) {
  const wait = Math.max(0, Number(years) || 0);
  const grown = (loans || []).map(l => {
    const extra = (l.subsidized && l.status === STATUS.DEFERRED)
      ? 0
      : cents((Number(l.principal) || 0) * (Number(l.rate) || 0) * wait);
    return { ...l, accrued: cents((Number(l.accrued) || 0) + extra) };
  });
  const capitalized = grown.map(capitalize);
  const payment = cents(capitalized.reduce((s, l) => s + amortizedPayment(l.principal, l.rate, termMonths), 0));
  return {
    balanceAtRepayment: totalOwed(capitalized),
    monthlyPayment: payment,
    totalRepaid: cents(payment * termMonths),
  };
}

/** Standard amortized payment for a balance at a rate over n months. */
export function amortizedPayment(balance, rate, months) {
  const b = Number(balance) || 0, r = (Number(rate) || 0) / 12, n = Number(months) || 0;
  if (b <= 0 || n <= 0) return 0;
  if (r === 0) return cents(b / n);
  return cents((b * r) / (1 - Math.pow(1 + r, -n)));
}

/**
 * Health read on a plan. Returns a verdict the UI colors, plus the reason, so the
 * app never shows a cheerful progress bar over a balance that is actually growing.
 */
export function assessPlan(loans, budget) {
  const line = freezeLine(loans);
  const owed = totalOwed(loans);
  const spend = cents(Math.max(0, Number(budget) || 0));
  if (owed <= 0) return { verdict: 'clear', line, owed, surplus: 0, reason: 'Nothing outstanding.' };
  const surplus = cents(spend - line);
  if (spend <= 0) {
    return { verdict: 'growing', line, owed, surplus, reason: `Nothing budgeted. Balances grow by ${line.toFixed(2)} a month.` };
  }
  if (surplus < 0) {
    return { verdict: 'growing', line, owed, surplus, reason: `Below the freeze line by ${Math.abs(surplus).toFixed(2)} a month — balances still grow.` };
  }
  if (surplus === 0) {
    return { verdict: 'frozen', line, owed, surplus, reason: 'Exactly at the freeze line. Balances hold but never fall.' };
  }
  const proj = projectPayoff(loans, spend);
  if (proj.neverClears) {
    return { verdict: 'frozen', line, owed, surplus, reason: 'Barely above the freeze line — payoff is beyond the projection horizon.' };
  }
  return {
    verdict: surplus >= line ? 'strong' : 'progressing',
    line, owed, surplus,
    months: proj.months,
    totalInterest: proj.totalInterest,
    reason: `${(surplus).toFixed(2)} a month is going to principal. Clear in ${Math.floor(proj.months / 12)}y ${proj.months % 12}m.`,
  };
}

/**
 * Turn each loan's "Capitalizes On" date into the projection month it lands in,
 * the shape projectPayoff's capitalizeAt option takes. Month 1 is the month after
 * `today`; a date already past (or unparseable) is left out rather than guessed.
 */
export function capitalizeSchedule(loans, today = new Date()) {
  const y0 = today.getFullYear(), m0 = today.getMonth();
  const out = {};
  for (const l of loans || []) {
    const m = /^(\d{4})-(\d{2})/.exec(String(l.capitalizesOn || ''));
    if (!m || l.status !== STATUS.DEFERRED) continue;
    const offset = (Number(m[1]) - y0) * 12 + (Number(m[2]) - 1 - m0);
    if (offset >= 1) out[l.id] = offset;
  }
  return out;
}

// ── The loan envelope ────────────────────────────────────────────────────────
// Loans are funded like every other envelope: a "Student Loans" row in Monthly
// Expenses, filled when income is processed, spent when a payment goes out. What
// makes it different is that its need is COMPUTED from the debt, in three layers:
//
//   due     minimums on loans in repayment. Missing one is delinquency, so this
//           is never optional and overrides a smaller plan.
//   hold    the freeze line. Below it the balance grows however much is sent.
//   attack  the owner's committed monthly plan, beyond the two above.
//
// The envelope's target is max(plan, due). The hold line is reported, not forced:
// forcing it would silently take money from food and gas, and that is the owner's
// call to make on the Loans page, not the engine's.
export const LOAN_ENVELOPE = 'Student Loans';
export const isLoanEnvelope = (type) => String(type || '').trim().toLowerCase() === LOAN_ENVELOPE.toLowerCase();

/** Loans the plan covers: 'all', or one borrower's (Parent PLUS loans are the parent's). */
export function inScope(loans, scope = 'all') {
  const live = (loans || []).filter(l => l.status !== STATUS.PAID && loanBalance(l) > 0);
  if (!scope || scope === 'all') return live;
  return live.filter(l => String(l.borrower || '').toLowerCase() === String(scope).toLowerCase());
}

/** Minimum payments actually due this month. */
export function minimumsDue(loans) {
  return cents((loans || []).reduce((s, l) => (
    l.status === STATUS.REPAYMENT && loanBalance(l) > 0 ? s + Math.min(Number(l.minPayment) || 0, loanBalance(l)) : s
  ), 0));
}

/**
 * What the loan envelope needs this month. `plan` is the envelope's Monthly
 * Allowance. Returns the target plus the layers and a one-line reason the Process
 * screen prints under the envelope.
 */
export function loanNeed(loans, { plan = 0, scope = 'all' } = {}) {
  const set = inScope(loans, scope);
  const due = minimumsDue(set);
  const hold = freezeLine(set);
  const p = cents(Math.max(0, Number(plan) || 0));
  // No plan set: default to the interest line, so the envelope at least stops the
  // debt growing. Anything above that is a choice the owner makes on the Loans page.
  const target = cents(Math.max(p > 0 ? p : hold, due));
  const owed = totalOwed(set);
  let tier, reason;
  if (owed <= 0) { tier = 'clear'; reason = 'No loans outstanding.'; }
  else if (due > Math.max(p, p > 0 ? 0 : hold)) { tier = 'due'; reason = `${due.toFixed(2)} in minimum payments is due - more than the plan.`; }
  else if (p === 0) { tier = 'hold'; reason = `No plan set - covering this month's ${hold.toFixed(2)} of interest so the balance stops growing.`; }
  else if (p < hold) { tier = 'growing'; reason = `Plan is ${cents(hold - p).toFixed(2)} under the ${hold.toFixed(2)} monthly interest - balances still grow.`; }
  else { tier = 'attack'; reason = `${cents(p - hold).toFixed(2)} a month past the interest goes to principal.`; }
  return { target, due, hold, plan: p, owed, tier, reason, count: set.length };
}

/**
 * Where the money sitting in the envelope should go right now: minimums first,
 * then the strategy's target, rolling on as each clears. Each line is a payment
 * the owner makes to a servicer, with the split it will get.
 */
export function sendPlan(loans, cash, strategy = 'avalanche') {
  let left = cents(Math.max(0, Number(cash) || 0));
  const state = (loans || []).map(l => ({ ...l }));
  const lines = {};
  const pay = (i, amt) => {
    const r = applyPayment(state[i], amt);
    if (r.applied <= 0) return 0;
    state[i] = r.loan;
    left = cents(left - r.applied);
    const k = state[i].id;
    const ln = lines[k] || (lines[k] = { id: k, name: state[i].name, servicer: state[i].servicer, amount: 0, toInterest: 0, toPrincipal: 0, required: 0 });
    ln.amount = cents(ln.amount + r.applied);
    ln.toInterest = cents(ln.toInterest + r.toInterest);
    ln.toPrincipal = cents(ln.toPrincipal + r.toPrincipal);
    return r.applied;
  };
  state.forEach((l, i) => {
    if (left <= 0 || l.status !== STATUS.REPAYMENT) return;
    const due = cents(Math.min(Number(l.minPayment) || 0, loanBalance(l), left));
    const got = due > 0 ? pay(i, due) : 0;
    if (got) lines[l.id].required = cents(got);
  });
  for (const t of payoffOrder(state, strategy)) {
    if (left <= 0) break;
    pay(state.findIndex(l => l.id === t.id), left);
  }
  return { lines: Object.values(lines), leftover: left };
}

/**
 * The smallest monthly budget that clears these loans within `months`. Binary
 * search over projectPayoff, rounded up to the cent. null when nothing is owed.
 */
export function requiredMonthly(loans, months, opts = {}) {
  const n = Math.max(1, Math.floor(Number(months) || 0));
  const owed = totalOwed(inScope(loans));
  if (owed <= 0) return null;
  const fits = (b) => { const p = projectPayoff(loans, b, { ...opts, maxMonths: n }); return !p.neverClears && p.months <= n; };
  let lo = freezeLine(loans), hi = cents(owed * 2 + 1);
  if (!fits(hi)) return null;
  for (let i = 0; i < 40 && hi - lo > 0.005; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid; else lo = mid;
  }
  let b = Math.ceil(hi * 100) / 100;
  while (!fits(b)) b = cents(b + 0.01);
  return b;
}

/** Month offset -> 'Mon YYYY' label, counting from `today`. */
export function monthLabel(offset, today = new Date()) {
  if (offset == null) return '-';
  const d = new Date(today.getFullYear(), today.getMonth() + Number(offset), 1);
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * One month of the Loan Payments log, for statements: what was paid, how it split.
 * `payments` are header-keyed objects from the tab.
 */
export function monthPayments(payments, year, month) {
  const rows = (payments || []).filter(p => {
    const m = /^(\d{4})-(\d{2})/.exec(String(p['Date'] || ''));
    return m && Number(m[1]) === year && Number(m[2]) === month;
  });
  const sum = (k) => cents(rows.reduce((s, p) => s + (Number(p[k]) || 0), 0));
  return { count: rows.length, paid: sum('Amount'), toInterest: sum('To Interest'), toPrincipal: sum('To Principal'), rows };
}

// ── Interest through time ────────────────────────────────────────────────────
// Interest accrues DAILY on principal: principal x rate / 365.25 per day, simple,
// the daily-interest factor federal Direct Loan servicers print on statements.
// Each loan carries an `asOf` date: the day its Accrued figure was last true. The
// accrual ledger (Loan Interest tab) records every stretch from asOf forward, split
// at month ends so each calendar month's interest is its own exact line, and
// asOf moves forward. The same rule runs in the app (before a payment is split)
// and in LIZA's nightly job, so whichever runs first writes it and the other finds
// nothing left to do.
export const DAY_BASIS = 365.25;

/** Daily interest a loan charges right now (0 for subsidized while deferred). */
export function dailyInterest(loan) {
  if (!loan || loan.status === STATUS.PAID) return 0;
  if (loan.subsidized && loan.status === STATUS.DEFERRED) return 0;
  return (Number(loan.principal) || 0) * (Number(loan.rate) || 0) / DAY_BASIS;
}

const isoDay = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const toIso = (t) => new Date(t).toISOString().slice(0, 10);
const DAY_MS = 86400000;

/**
 * The accrual stretches from loan.asOf up to (not including) `toDate`, one per
 * calendar month touched. Each: { from, to, days, interest, month:'YYYY-MM' }.
 * `to` is exclusive and becomes the next asOf. No asOf, or toDate not after it,
 * gives [] - never guess a start date.
 */
export function accrualSegments(loan, toDate) {
  const a = isoDay(loan?.asOf), b = isoDay(toDate);
  if (isNaN(a) || isNaN(b) || b <= a) return [];
  const perDay = dailyInterest(loan);
  const out = [];
  let t = a;
  while (t < b) {
    const d = new Date(t);
    const next = Math.min(b, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const days = Math.round((next - t) / DAY_MS);
    out.push({ from: toIso(t), to: toIso(next), days, interest: cents(perDay * days), month: toIso(t).slice(0, 7) });
    t = next;
  }
  return out;
}

/** Bring a loan's accrued interest current to `toDate`. Pure. */
export function accrueTo(loan, toDate) {
  const segments = accrualSegments(loan, toDate);
  if (!segments.length) return { loan: { ...loan }, segments, interest: 0 };
  const interest = cents(segments.reduce((s, g) => s + g.interest, 0));
  return {
    loan: { ...loan, accrued: cents((Number(loan.accrued) || 0) + interest), asOf: segments[segments.length - 1].to },
    segments,
    interest,
  };
}

/**
 * Interest history from the Loan Interest ledger: per month, what accrued, and the
 * running total. rows are header-keyed objects ({Month, Loan ID, Interest}).
 * Returns [{ month, interest, cumulative, byLoan }] in month order.
 */
export function interestHistory(rows, { loanIds = null } = {}) {
  const by = {};
  for (const r of rows || []) {
    const month = String(r['Month'] || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const id = String(r['Loan ID'] || '');
    if (loanIds && !loanIds.has(id)) continue;
    const v = Number(r['Interest']) || 0;
    const m = by[month] || (by[month] = { month, interest: 0, byLoan: {} });
    m.interest = cents(m.interest + v);
    m.byLoan[id] = cents((m.byLoan[id] || 0) + v);
  }
  let run = 0;
  return Object.values(by).sort((x, y) => x.month.localeCompare(y.month)).map(m => {
    run = cents(run + m.interest);
    return { ...m, cumulative: run };
  });
}
