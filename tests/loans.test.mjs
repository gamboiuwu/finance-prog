// The debt engine must never lose or invent a cent, and must never tell the user a
// balance is shrinking when it is growing. Property-based over thousands of random
// loan sets, plus fixed cases taken from the owner's real MOHELA/Nelnet statements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, monthlyInterest, loanBalance, freezeLine, totalOwed, applyPayment,
  accrueMonth, capitalize, payoffOrder, projectPayoff, costOfWaiting,
  amortizedPayment, assessPlan, effectiveRate,
} from '../src/lib/loans.js';
import { cents } from '../src/lib/allocation.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomLoans(r, n = 1 + Math.floor(r() * 6)) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const deferred = r() < 0.5;
    out.push({
      id: `l${i}`,
      name: `Loan ${i}`,
      principal: Math.round(r() * 40000 * 100) / 100,
      accrued: Math.round(r() * 4000 * 100) / 100,
      rate: Math.round(r() * 0.09 * 10000) / 10000,
      status: deferred ? STATUS.DEFERRED : STATUS.REPAYMENT,
      subsidized: r() < 0.3,
      minPayment: Math.round(r() * 120 * 100) / 100,
    });
  }
  return out;
}

test('a payment is never lost: interest + principal + unused == amount offered', () => {
  const r = rng(11);
  for (let i = 0; i < 5000; i++) {
    const [loan] = randomLoans(r, 1);
    const amount = Math.round(r() * 5000 * 100) / 100;
    const res = applyPayment(loan, amount);
    assert.equal(
      cents(res.toInterest + res.toPrincipal + res.unused),
      cents(amount),
      `split lost money on ${JSON.stringify(loan)} paying ${amount}`,
    );
  }
});

test('a payment reduces what is owed by exactly what it applied', () => {
  const r = rng(12);
  for (let i = 0; i < 5000; i++) {
    const [loan] = randomLoans(r, 1);
    const before = loanBalance(loan);
    const res = applyPayment(loan, Math.round(r() * 5000 * 100) / 100);
    assert.equal(cents(before - loanBalance(res.loan)), res.applied);
  }
});

test('interest is always paid before principal', () => {
  const r = rng(13);
  for (let i = 0; i < 3000; i++) {
    const [loan] = randomLoans(r, 1);
    const amount = Math.round(r() * 5000 * 100) / 100;
    const res = applyPayment(loan, amount);
    // Principal only gets touched once accrued interest is fully cleared.
    if (res.toPrincipal > 0) assert.equal(res.loan.accrued, 0);
    assert.ok(res.toInterest <= cents(Number(loan.accrued) || 0) + 1e-9);
  }
});

test('no balance ever goes negative, however large the payment', () => {
  const r = rng(14);
  for (let i = 0; i < 3000; i++) {
    const [loan] = randomLoans(r, 1);
    const res = applyPayment(loan, 1e6);
    assert.ok(res.loan.principal >= 0 && res.loan.accrued >= 0);
    assert.equal(loanBalance(res.loan), 0);
    assert.equal(res.loan.status, STATUS.PAID);
  }
});

test('subsidized loans accrue nothing while deferred, and do while in repayment', () => {
  const base = { id: 'x', principal: 10000, accrued: 0, rate: 0.05, subsidized: true };
  assert.equal(monthlyInterest({ ...base, status: STATUS.DEFERRED }), 0);
  assert.ok(monthlyInterest({ ...base, status: STATUS.REPAYMENT }) > 0);
  assert.ok(monthlyInterest({ ...base, subsidized: false, status: STATUS.DEFERRED }) > 0);
});

test('capitalization moves interest into principal without changing the total owed', () => {
  const r = rng(15);
  for (let i = 0; i < 3000; i++) {
    const [loan] = randomLoans(r, 1);
    const after = capitalize(loan);
    assert.equal(loanBalance(after), loanBalance(loan));
    assert.equal(after.accrued, 0);
  }
});

test('capitalizing raises the ongoing interest cost — the reason the UI warns', () => {
  const loan = { id: 'a', principal: 26187, accrued: 5587.91, rate: 0.0754, status: STATUS.REPAYMENT };
  assert.ok(monthlyInterest(capitalize(loan)) > monthlyInterest(loan));
});

test('paying exactly the freeze line holds the balance still', () => {
  const r = rng(16);
  for (let i = 0; i < 400; i++) {
    const loans = randomLoans(r).map(l => ({ ...l, status: STATUS.REPAYMENT, minPayment: 0 }));
    const start = totalOwed(loans);
    const res = projectPayoff(loans, freezeLine(loans), { maxMonths: 12 });
    const end = res.schedule.length ? res.schedule[res.schedule.length - 1].balance : start;
    // Interest accrues then is paid off; the balance should not run away.
    assert.ok(end <= start + 1, `balance grew from ${start} to ${end} at the freeze line`);
  }
});

test('paying under the freeze line is reported as growing, never as progress', () => {
  const loans = [{ id: 'a', principal: 40000, accrued: 6000, rate: 0.08, status: STATUS.REPAYMENT, minPayment: 0 }];
  const line = freezeLine(loans);
  const a = assessPlan(loans, cents(line - 50));
  assert.equal(a.verdict, 'growing');
  assert.ok(a.surplus < 0);
});

test('avalanche targets the highest rate; snowball the smallest balance', () => {
  const loans = [
    { id: 'big',   principal: 30000, accrued: 0, rate: 0.05, status: STATUS.REPAYMENT },
    { id: 'small', principal: 1000,  accrued: 0, rate: 0.09, status: STATUS.REPAYMENT },
  ];
  assert.equal(payoffOrder(loans, 'avalanche')[0].id, 'small'); // highest rate
  assert.equal(payoffOrder(loans, 'snowball')[0].id, 'small');  // also smallest here
  const loans2 = [
    { id: 'big',   principal: 30000, accrued: 0, rate: 0.09, status: STATUS.REPAYMENT },
    { id: 'small', principal: 1000,  accrued: 0, rate: 0.05, status: STATUS.REPAYMENT },
  ];
  assert.equal(payoffOrder(loans2, 'avalanche')[0].id, 'big');
  assert.equal(payoffOrder(loans2, 'snowball')[0].id, 'small');
});

test('a subsidized deferred loan is never targeted ahead of one that is actually charging', () => {
  // The government pays interest on a subsidized loan in school. Sending money at it
  // instead of at a loan that IS accruing is a straight loss, however high its
  // printed rate. The high-rate subsidized loan must sort LAST.
  const loans = [
    { id: 'sub',   principal: 5000, accrued: 0, rate: 0.09, status: STATUS.DEFERRED,  subsidized: true },
    { id: 'unsub', principal: 5000, accrued: 0, rate: 0.04, status: STATUS.DEFERRED,  subsidized: false },
  ];
  assert.equal(effectiveRate(loans[0]), 0);
  assert.equal(effectiveRate(loans[1]), 0.04);
  assert.equal(payoffOrder(loans, 'avalanche')[0].id, 'unsub');
  // Once it enters repayment the printed rate starts counting and the order flips.
  const inRepayment = loans.map(l => ({ ...l, status: STATUS.REPAYMENT }));
  assert.equal(payoffOrder(inRepayment, 'avalanche')[0].id, 'sub');
});

test('real statements: the three subsidized loans sort behind everything that accrues', () => {
  const order = payoffOrder([...MOM, ...MINE], 'avalanche');
  const subsidizedRanks = order
    .map((l, i) => ({ id: l.id, i, sub: l.subsidized && l.status === STATUS.DEFERRED }))
    .filter(x => x.sub).map(x => x.i);
  const accruingRanks = order
    .map((l, i) => ({ i, acc: monthlyInterest(l) > 0 }))
    .filter(x => x.acc).map(x => x.i);
  assert.ok(Math.min(...subsidizedRanks) > Math.max(...accruingRanks),
    'a free-to-carry loan was ranked ahead of one that is charging interest');
});

test('avalanche never costs more interest than snowball', () => {
  const r = rng(17);
  for (let i = 0; i < 300; i++) {
    const loans = randomLoans(r, 2 + Math.floor(r() * 3))
      .map(l => ({ ...l, status: STATUS.REPAYMENT, minPayment: 0, accrued: 0 }));
    const budget = cents(freezeLine(loans) * 2 + 200);
    const av = projectPayoff(loans, budget, { strategy: 'avalanche' });
    const sn = projectPayoff(loans, budget, { strategy: 'snowball' });
    if (av.neverClears || sn.neverClears) continue;
    assert.ok(av.totalInterest <= sn.totalInterest + 0.02,
      `avalanche ${av.totalInterest} > snowball ${sn.totalInterest}`);
  }
});

test('a budget that cannot cover interest is flagged, not given a fake horizon', () => {
  const loans = [{ id: 'a', principal: 40000, accrued: 0, rate: 0.08, status: STATUS.REPAYMENT, minPayment: 0 }];
  const res = projectPayoff(loans, 10, { maxMonths: 120 });
  assert.equal(res.months, null);
  assert.equal(res.neverClears, true);
});

test('more money never makes payoff slower or more expensive', () => {
  const r = rng(18);
  for (let i = 0; i < 200; i++) {
    const loans = randomLoans(r, 1 + Math.floor(r() * 3))
      .map(l => ({ ...l, status: STATUS.REPAYMENT, minPayment: 0 }));
    const lo = cents(freezeLine(loans) * 2 + 100);
    const hi = cents(lo * 2);
    const a = projectPayoff(loans, lo);
    const b = projectPayoff(loans, hi);
    if (a.neverClears || b.neverClears) continue;
    assert.ok(b.months <= a.months);
    assert.ok(b.totalInterest <= a.totalInterest + 0.02);
  }
});

test('waiting always costs more than acting now', () => {
  const r = rng(19);
  for (let i = 0; i < 500; i++) {
    const loans = randomLoans(r).map(l => ({ ...l, status: STATUS.DEFERRED, subsidized: false }));
    const now = costOfWaiting(loans, 0);
    const later = costOfWaiting(loans, 2);
    assert.ok(later.totalRepaid >= now.totalRepaid - 0.02);
    assert.ok(later.balanceAtRepayment >= now.balanceAtRepayment - 0.02);
  }
});

test('amortized payment actually retires the balance over the term', () => {
  const r = rng(20);
  for (let i = 0; i < 500; i++) {
    const bal = Math.round(r() * 50000 * 100) / 100 + 100;
    const rate = Math.round(r() * 0.09 * 10000) / 10000;
    const n = 60 + Math.floor(r() * 240);
    const pmt = amortizedPayment(bal, rate, n);
    let b = bal;
    for (let m = 0; m < n; m++) b = b + (b * rate / 12) - pmt;
    // The payment is rounded to whole cents (you cannot pay a fraction of one), and
    // that half-cent compounds over the term. The property that matters: the schedule
    // retires the debt to within a single final payment.
    assert.ok(Math.abs(b) < pmt, `left ${b.toFixed(2)} after ${n} payments of ${pmt}`);
  }
});

// ── The owner's real numbers, from the statements in Desktop\statement ─────────
const MOM = [
  { id: 'plus1', name: 'MOHELA DLPLUS 10/13/22', principal: 26187.00, accrued: 5587.91, rate: 0.0754, status: STATUS.DEFERRED, subsidized: false, minPayment: 0 },
  { id: 'plus2', name: 'MOHELA DLPLUS 09/06/23', principal: 7982.00,  accrued: 1141.68, rate: 0.0805, status: STATUS.DEFERRED, subsidized: false, minPayment: 0 },
];
const MINE = [
  { id: 'n1', name: 'Nelnet 001', principal: 3500.00, accrued: 0,      rate: 0.0499, status: STATUS.DEFERRED, subsidized: true,  minPayment: 28.97 },
  { id: 'n2', name: 'Nelnet 002', principal: 1092.00, accrued: 166.78, rate: 0.0499, status: STATUS.DEFERRED, subsidized: false, minPayment: 21.03 },
  { id: 'n3', name: 'Nelnet 003', principal: 4500.00, accrued: 0,      rate: 0.0550, status: STATUS.DEFERRED, subsidized: true,  minPayment: 24.42 },
  { id: 'n4', name: 'Nelnet 004', principal: 799.13,  accrued: 58.12,  rate: 0.0550, status: STATUS.DEFERRED, subsidized: false, minPayment: 13.55 },
  { id: 'n5', name: 'Nelnet 005', principal: 1847.85, accrued: 0,      rate: 0.0653, status: STATUS.DEFERRED, subsidized: true,  minPayment: 13.79 },
];

test('real statements: totals and the freeze line match the paperwork', () => {
  assert.equal(totalOwed(MOM), 40898.59);
  assert.equal(totalOwed(MINE), 11963.88);
  assert.equal(totalOwed([...MOM, ...MINE]), 52862.47);
  // Mom's two loans carry essentially all of the monthly interest.
  assert.equal(freezeLine(MOM), 218.09);
  assert.ok(freezeLine(MINE) < 10, 'three of five are subsidized, so the bleed is tiny');
});

test('real statements: waiting two years costs thousands more', () => {
  const now = costOfWaiting(MOM, 0);
  const two = costOfWaiting(MOM, 2);
  assert.ok(two.totalRepaid - now.totalRepaid > 7000);
  assert.ok(two.monthlyPayment > now.monthlyPayment);
});

test('real statements: below the freeze line nothing clears; above it, barely, does', () => {
  const below = projectPayoff(MOM, 200, { maxMonths: 600 });
  assert.equal(below.neverClears, true, '$200 is under the $218.09 freeze line');
  const strong = projectPayoff(MOM, 500, { maxMonths: 600 });
  assert.equal(strong.neverClears, false);
  assert.ok(strong.months < 130);
});

test('real statements: paying DURING deferment beats paying after capitalization', () => {
  // This is the whole argument for acting while the loans are still in school status.
  // Deferred, interest accrues on principal only; capitalized, it accrues on the
  // interest too, so the same budget takes materially longer.
  const capitalized = MOM.map(capitalize).map(l => ({ ...l, status: STATUS.REPAYMENT }));
  assert.ok(freezeLine(capitalized) > freezeLine(MOM));
  for (const budget of [300, 400, 500]) {
    const during = projectPayoff(MOM, budget, { maxMonths: 600 });
    const after  = projectPayoff(capitalized, budget, { maxMonths: 600 });
    assert.ok(during.months < after.months,
      `$${budget}: ${during.months}mo deferred vs ${after.months}mo capitalized`);
    // Compare total dollars out the door, NOT totalInterest: capitalization moves the
    // existing unpaid interest into principal, so paying it then counts as principal
    // and the two interest figures are not measuring the same thing.
    assert.ok(during.totalPaid < after.totalPaid,
      `$${budget}: paid ${during.totalPaid} deferred vs ${after.totalPaid} capitalized`);
  }
});

test('capitalizeSchedule maps dates to projection months and skips the past', async () => {
  const { capitalizeSchedule } = await import('../src/lib/loans.js');
  const today = new Date(2026, 8, 23); // Sept 2026
  const s = capitalizeSchedule([
    { id: 'a', status: 'deferred', capitalizesOn: '2027-05-15' },
    { id: 'b', status: 'deferred', capitalizesOn: '2026-01-01' },
    { id: 'c', status: 'repayment', capitalizesOn: '2027-05-15' },
    { id: 'd', status: 'deferred', capitalizesOn: '' },
  ], today);
  assert.deepEqual(s, { a: 8 });
});

test('a scheduled capitalization makes the projection cost more', async () => {
  const { projectPayoff } = await import('../src/lib/loans.js');
  const loan = { id: 'x', principal: 10000, accrued: 2000, rate: 0.07, status: 'deferred', minPayment: 0 };
  const base = projectPayoff([loan], 150);
  const cap = projectPayoff([loan], 150, { capitalizeAt: { x: 1 } });
  assert.ok(cap.totalPaid > base.totalPaid);
  assert.ok(cap.totalInterest > base.totalInterest, 'capitalized interest still counts as interest');
});
