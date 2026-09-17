// The Process Income engine, pure: no React, no sheet access, no clock except where a
// date is passed in. ProcessIncome.jsx renders it; tests/allocation.test.mjs proves it.
//
// THE INVARIANT (owner, 2026-09-16): every cent of a paycheck is written to the log.
// Deficits first, then the chosen mode over each envelope's remaining need, then named
// surplus buckets by weight, then whatever is left goes to the Unassigned envelope. The
// rows handed to the sheet always sum to the amount received, to the cent, or planRows
// refuses and says why. Silently dropping surplus is what cost $945.33 in May and
// September before this existed.

export const UNASSIGNED = 'Unassigned';
export const UNASSIGNED_ACCOUNT = 'Checking';

function pm(val) { const n = parseFloat(String(val || '').replace(/[$,\s]/g, '')); return isNaN(n) ? 0 : n; }

// Case/whitespace-insensitive Gas match — the sheet may store "gas" or " Gas ".
// Must agree with Budget.jsx so the gas-balance override never silently misses.
export const isGas = (type) => String(type || '').trim().toLowerCase() === 'gas';

// Deposits fill each category's *remaining gap* (goal minus already contributed).
// Priority mode: fill P1 gaps before P2, then P3.
// Proportional mode: distribute proportionally across remaining gaps.
// gasBalance: all-time running net for Gas (from Dashboard); if provided, Gas uses this
// instead of the monthly-only allocated amount so we never over-deposit into Gas.
// ── Funding policies (owner, 2026-09-16) ─────────────────────────────────────
// What has ALREADY accrued to an envelope, and what it is aiming at, depends on the
// envelope's policy. The policy comes from the sheet so every device agrees:
//   monthly      accrued = deposits this calendar month (1st -> last day, at all times);
//                target  = the monthly allowance.                        [default]
//   running      accrued = the envelope's all-time balance; target = the total budget
//                (Gas: the live dynamic gas budget). A reserve, not a monthly amount.
//   target-date  accrued = the all-time balance toward a target; this month's need is
//                (target - balance) / months left until the date. Comes from a Plans
//                row whose Name matches the envelope (Target, Target Date), or an
//                explicit policy. Prepared now, activates when such a row exists.
// Resolution order: a `Policy` column in Monthly Expenses (monthly|running|target),
// else Gas -> running, else a matching Plan with a target date -> target-date, else
// the legacy per-device 'running' flag from the Budget page, else monthly.
export function policyFor(e, plansByName = {}, balTypes = {}) {
  const type = String(e['Type'] || '').trim();
  const col  = String(e['Policy'] || '').trim().toLowerCase();
  if (col === 'running' || col === 'monthly') return { policy: col };
  if (col === 'target' || col === 'target-date') return { policy: 'target-date', plan: plansByName[type.toLowerCase()] || null };
  if (isGas(type)) return { policy: 'running' };
  const plan = plansByName[type.toLowerCase()];
  if (plan && plan.target > 0 && plan.targetDate) return { policy: 'target-date', plan };
  if ((balTypes[type] || 'monthly') === 'running') return { policy: 'running' };
  return { policy: 'monthly' };
}

// Whole months from `now` to `date` (a Date), never less than 1.
export function monthsLeft(date, now = new Date()) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return 1;
  const m = (date.getFullYear() - now.getFullYear()) * 12 + (date.getMonth() - now.getMonth()) + (date.getDate() >= now.getDate() ? 1 : 0);
  return Math.max(1, m);
}

export function calcDeposits(expenses, income, mode, alreadyByType = {}, gasBalance = null, gasBudget = null, envStats = {}, policies = {}) {
  if (!income) return [];
  const isGasDynamic = typeof gasBudget === 'number' && !isNaN(gasBudget) && gasBudget > 0;
  const eligible = expenses
    // Gas is always eligible when we have a live dynamic budget, even if the sheet
    // allowance is 0/stale — the real target comes from the gas price.
    .filter(e => pm(e['Monthly Allowance ($)']) > 0 || (isGas(e['Type']) && isGasDynamic)
      // A target-date envelope is defined by its plan, not by a monthly allowance.
      || (policies[e['Type'] || '']?.policy === 'target-date' && policies[e['Type'] || '']?.plan))
    .map(e => {
      // Gas uses the live dynamic budget (scales with gas price) instead of the
      // static sheet allowance, so the target is the ~$185 reserve, not $120.
      const allowance  = (isGas(e['Type']) && isGasDynamic)
        ? gasBudget
        : pm(e['Monthly Allowance ($)']);
      const stats      = envStats[e['Type'] || ''] || { balance: 0, fundedMonth: 0, spentMonth: 0 };
      const funded     = alreadyByType[e['Type'] || ''] || 0;          // this calendar month
      const balance    = (isGas(e['Type']) && typeof gasBalance === 'number' && !isNaN(gasBalance) && !envStats[e['Type'] || ''])
        ? gasBalance : stats.balance;                                     // all-time
      const pol        = policies[e['Type'] || ''] || { policy: 'monthly' };
      let target = allowance;     // what this envelope is aiming at
      let already = funded;       // what counts as accrued toward it
      let pace = null;            // target-date: {monthsLeft, perMonth, remaining}
      if (pol.policy === 'running') {
        // The balance itself, deficit included: at -$5.59 against a $185 budget the
        // envelope needs $190.59, and the $5.59 is repaid before anything else (below).
        already = balance;
      } else if (pol.policy === 'target-date' && pol.plan) {
        const remaining = Math.max(0, pol.plan.target - Math.max(0, balance));
        const ml        = monthsLeft(pol.plan.targetDate);
        const perMonth  = remaining / ml;
        pace   = { monthsLeft: ml, perMonth, remaining, target: pol.plan.target, targetDate: pol.plan.targetDate };
        target = Math.min(remaining, Math.max(perMonth, 0));   // this month's share of the target
        already = funded;                                      // what went in this month toward it
      }
      const stillNeeds = Math.max(0, target - already);
      const deficit    = pol.policy === 'running' && balance < 0 ? -balance : 0;
      return {
        deficit,
        type:      e['Type']    || '',
        account:   e['Account'] || 'Other',
        expense:   e['Expense'] || '',
        priority:  parseInt(e['Priority']) || 2,
        allowance: target,
        monthlyAllowance: pm(e['Monthly Allowance ($)']),
        already,
        stillNeeds,
        policy:      pol.policy,
        pace,
        balance,
        fundedMonth: funded,
        spentMonth:  stats.spentMonth,
      };
    })
    .sort((a, b) => a.priority - b.priority || b.allowance - a.allowance);

  // ── Stage 1: deficits first (owner rule). A running envelope below zero (Gas after a
  // fill-up bigger than its balance) is repaid off the top of the income, in priority
  // order, before either allocation mode sees a dollar. Then the envelope competes for
  // the rest of its budget like everyone else - in proportional mode too.
  let remaining = income;
  const repaid = {};
  for (const e of eligible) {
    if (e.deficit <= 0 || remaining <= 0) continue;
    const pay = Math.min(e.deficit, remaining);
    repaid[e.type] = pay;
    remaining -= pay;
  }
  const staged = eligible.map(e => {
    const pay = repaid[e.type] || 0;
    // After repayment the deficit part of stillNeeds is settled; what remains is the budget.
    return { ...e, deficitPaid: pay, stillNeeds: Math.max(0, e.stillNeeds - pay) };
  });
  const finish = (e, deposit) => {
    const total    = e.deficitPaid + deposit;
    const coverage = e.allowance > 0 ? Math.max(0, e.already + total) / e.allowance : 0;
    return { ...e, deposit: total, budgetDeposit: deposit, pct: income > 0 ? total / income : 0, coverage };
  };

  if (mode === 'proportional') {
    const totalNeeds = staged.reduce((s, e) => s + e.stillNeeds, 0);
    return staged.map(e => finish(e, totalNeeds > 0 ? Math.min(e.stillNeeds, (e.stillNeeds / totalNeeds) * remaining) : 0));
  }

  // Priority-first: fill each category's remaining gap before moving to lower priorities
  return staged.map(e => {
    const deposit = Math.min(e.stillNeeds, Math.max(0, remaining));
    remaining     = Math.max(0, remaining - deposit);
    return finish(e, deposit);
  });
}


/** Round to cents as a number, half away from zero, without float noise. */
export const cents = (n) => Math.round((Number(n) || 0) * 100 + (n < 0 ? -1e-9 : 1e-9)) / 100;

/**
 * Split `surplus` across the named buckets by weight; what no named bucket claims is
 * `unassigned`. Blank names, zero/negative weights and NaN weights claim nothing.
 */
export function splitSurplus(surplus, items = []) {
  const s = Math.max(0, Number(surplus) || 0);
  const named = items.filter(it => it && String(it.name || '').trim() && (parseFloat(it.weight) || 0) > 0);
  const total = named.reduce((t, it) => t + (parseFloat(it.weight) || 0), 0);
  const deposits = items.map(it => {
    const ok = it && String(it.name || '').trim() && (parseFloat(it.weight) || 0) > 0;
    return { ...it, deposit: ok && total > 0 ? ((parseFloat(it.weight) || 0) / total) * s : 0 };
  });
  const claimed = deposits.reduce((t, it) => t + it.deposit, 0);
  return { deposits, unassigned: Math.max(0, s - claimed) };
}

/**
 * Turn a plan into the rows that go to Allocation Transactions.
 *   deposits         [{type, account, deposit}]   envelope deposits (auto or manual)
 *   surplusDeposits  [{name, account, deposit}]   from splitSurplus
 *   unassigned       number                        from splitSurplus
 *   amount           the paycheck
 * Returns { rows, total, residue } where rows sum to `amount` exactly, or throws when the
 * plan cannot be made whole (manual over-assignment, or a plan that does not add up).
 *
 * Cent handling: each row is rounded to cents; the rounding residue (a cent or two over
 * 13+ rows) is folded into the largest row. A sub-5-cent remainder that would otherwise
 * become a lone "Unassigned 0.02" row is folded the same way - exact either way, but a
 * two-cent envelope helps nobody.
 */
export function planRows({ deposits = [], surplusDeposits = [], unassigned = 0, amount, date, desc }) {
  const amt = cents(amount);
  if (!(amt > 0)) throw new Error('nothing to process');
  const rows = [];
  for (const d of deposits) {
    const v = cents(d.deposit);
    if (v < 0) throw new Error(`negative deposit for ${d.type}`);
    if (v > 0) rows.push([date, d.type, v, desc, d.account, true]);
  }
  for (const it of surplusDeposits) {
    const v = cents(it.deposit);
    if (v > 0 && String(it.name || '').trim()) rows.push([date, String(it.name).trim(), v, desc + ' [surplus]', it.account || 'Savings', true]);
  }
  let un = cents(unassigned);
  if (un >= 0.05 || (un > 0 && rows.length === 0)) rows.push([date, UNASSIGNED, un, desc + ' [unassigned]', UNASSIGNED_ACCOUNT, true]);
  const logged = cents(rows.reduce((t, r) => t + r[2], 0));
  const residue = cents(amt - logged);
  if (Math.abs(residue) > 0.05) {
    // Not rounding: the plan itself is short or over (manual mode). Refuse - never write
    // a block that does not equal the paycheck.
    throw new Error(residue > 0 ? `plan is ${residue.toFixed(2)} short of the paycheck` : `plan exceeds the paycheck by ${(-residue).toFixed(2)}`);
  }
  if (residue !== 0 && rows.length === 0) {
    // Every deposit rounded to nothing (a one-cent paycheck): the whole amount is parked.
    rows.push([date, UNASSIGNED, residue, desc + ' [unassigned]', UNASSIGNED_ACCOUNT, true]);
  } else if (residue !== 0) {
    // Largest row first; a negative residue never takes a row below zero, it moves on.
    let left = residue;
    for (const r of [...rows].sort((a, b) => b[2] - a[2])) {
      if (left === 0) break;
      const take = left > 0 ? left : -Math.min(-left, r[2]);
      r[2] = cents(r[2] + take);
      left = cents(left - take);
    }
    if (left !== 0) throw new Error(`cannot fold a ${residue.toFixed(2)} residue into the rows`);
  }
  // A negative fold can zero a one-cent row; a zero row is not a deposit.
  const kept = rows.filter(r => r[2] > 0);
  const total = cents(kept.reduce((t, r) => t + r[2], 0));
  if (total !== amt) throw new Error(`rows sum to ${total.toFixed(2)}, paycheck is ${amt.toFixed(2)}`);
  return { rows: kept, total, residue };
}
