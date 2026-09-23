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
