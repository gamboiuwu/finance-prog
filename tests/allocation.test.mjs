// Every cent of a paycheck is written to the log. Property-based: thousands of random
// envelope sets, balances, deficits, policies, modes, bucket configurations and manual
// edits; the block of rows must always equal the amount received, to the cent, and the
// engine must never leave money on the table that an envelope still needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcDeposits, splitSurplus, planRows, cents, UNASSIGNED } from '../src/lib/allocation.js';

// Deterministic PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const money = (r, max) => Math.round(r() * max * 100) / 100;

function scenario(r) {
  const n = 1 + Math.floor(r() * 22);
  const expenses = []; const envStats = {}; const alreadyByType = {}; const policies = {};
  const accounts = ['Checking', 'Outside Payment', 'Savings', 'Cash', 'Business Tax', 'Subscription'];
  for (let i = 0; i < n; i++) {
    const type = i === 0 && r() < 0.7 ? 'Gas' : `Env${i}`;
    const allowance = r() < 0.1 ? 0 : money(r, 600);
    expenses.push({ Type: type, Account: accounts[i % accounts.length], Priority: String(1 + Math.floor(r() * 3)), 'Monthly Allowance ($)': allowance });
    const balance = money(r, 2000) * (r() < 0.25 ? -1 : 1);
    envStats[type] = { balance, fundedMonth: money(r, allowance || 100), spentMonth: money(r, 300) };
    alreadyByType[type] = r() < 0.3 ? 0 : money(r, allowance || 50);
    policies[type] = type === 'Gas' ? { policy: 'running' } : r() < 0.15 ? { policy: 'running' } : { policy: 'monthly' };
  }
  const income = r() < 0.05 ? 0.01 : money(r, 3000) || 0.01;
  const mode = r() < 0.5 ? 'priority' : 'proportional';
  const gasBudget = r() < 0.5 ? money(r, 400) || null : null;
  const buckets = [];
  const nb = Math.floor(r() * 4);
  for (let i = 0; i < nb; i++) buckets.push({ id: String(i), name: r() < 0.2 ? '' : `Bucket${i}`, account: 'Savings', weight: r() < 0.2 ? '0' : String(1 + Math.floor(r() * 5)) });
  return { expenses, envStats, alreadyByType, policies, income, mode, gasBudget, buckets };
}

test('every cent: auto mode, 5000 random scenarios', () => {
  const r = rng(20260916);
  for (let k = 0; k < 5000; k++) {
    const sc = scenario(r);
    const deposits = calcDeposits(sc.expenses, sc.income, sc.mode, sc.alreadyByType, null, sc.gasBudget, sc.envStats, sc.policies);
    const totalDeposited = deposits.reduce((s, d) => s + d.deposit, 0);
    assert.ok(totalDeposited <= sc.income + 1e-6, `k=${k}: deposits ${totalDeposited} exceed income ${sc.income}`);
    for (const d of deposits) assert.ok(d.deposit >= -1e-9, `k=${k}: negative deposit ${d.type}`);
    // Deficit-first: no envelope gets budget money while a deficit elsewhere is unpaid.
    const unpaid = deposits.filter(d => d.deficit > 0 && d.deficitPaid < d.deficit - 1e-9);
    if (unpaid.length) {
      const budgetMoney = deposits.reduce((s, d) => s + (d.deposit - d.deficitPaid), 0);
      assert.ok(budgetMoney < 1e-6, `k=${k}: budget money allocated while a deficit is unpaid`);
    }
    // Full potential: money is only left over when every need is met.
    const surplus = Math.max(0, sc.income - totalDeposited);
    if (surplus > 0.005) {
      // stillNeeds is the need going into allocation; what remains after is need - budget share.
      const stillNeeded = deposits.reduce((s, d) => s + Math.max(0, d.stillNeeds - (d.deposit - d.deficitPaid)), 0);
      assert.ok(stillNeeded < 0.005, `k=${k}: surplus ${surplus} left while envelopes still need ${stillNeeded}`);
    }
    const { deposits: sd, unassigned } = splitSurplus(surplus, sc.buckets);
    const { rows, total } = planRows({ deposits, surplusDeposits: sd, unassigned, amount: sc.income, date: '9/16/2026', desc: 'Income processed' });
    assert.equal(total, cents(sc.income), `k=${k}: rows ${total} != income ${sc.income}`);
    for (const row of rows) assert.ok(row[2] > 0, `k=${k}: non-positive row ${row[1]} ${row[2]}`);
    assert.equal(cents(rows.reduce((s, x) => s + x[2], 0)), cents(sc.income));
  }
});

test('every cent: manual mode edits (under-assigned parks the rest; over-assigned refuses)', () => {
  const r = rng(7);
  let refused = 0, parked = 0;
  for (let k = 0; k < 3000; k++) {
    const sc = scenario(r);
    const base = calcDeposits(sc.expenses, sc.income, sc.mode, sc.alreadyByType, null, sc.gasBudget, sc.envStats, sc.policies);
    // hand-edit a few rows the way the UI does (string -> parseFloat -> max 0)
    const deposits = base.map(d => (r() < 0.4 ? { ...d, deposit: Math.max(0, parseFloat(money(r, sc.income).toFixed(2)) || 0) } : d));
    const totalDeposited = deposits.reduce((s, d) => s + d.deposit, 0);
    const left = sc.income - totalDeposited;
    const surplus = Math.max(0, left);
    const { deposits: sd, unassigned } = splitSurplus(surplus, sc.buckets);
    if (left < -0.05) {   // beyond rounding: refused. (The UI blocks Process at any over-assignment.)
      assert.throws(() => planRows({ deposits, surplusDeposits: sd, unassigned, amount: sc.income, date: 'd', desc: 'x' }), /exceeds/, `k=${k}: over-assignment must be refused`);
      refused++;
      continue;
    }
    const { rows, total } = planRows({ deposits, surplusDeposits: sd, unassigned, amount: sc.income, date: 'd', desc: 'x' });
    assert.equal(total, cents(sc.income), `k=${k}: manual rows ${total} != ${sc.income}`);
    if (rows.some(x => x[1] === UNASSIGNED)) parked++;
  }
  assert.ok(refused > 0 && parked > 0, 'both branches exercised');
});

test('rounding residue is folded, never dropped (13 rows, 417.34)', () => {
  const deposits = [81.28, 31.49, 26.55, 21.24, 118.14, 15.75, 21.80, 16.40, 26.55, 15.75, 7.87, 21.26, 13.27].map((v, i) => ({ type: `E${i}`, account: 'Checking', deposit: v + 0.004 }));
  const { rows, total } = planRows({ deposits, surplusDeposits: [], unassigned: 0, amount: 417.34, date: 'd', desc: 'x' });
  assert.equal(total, 417.34);
  assert.equal(rows.length, 13);
});

test('a sub-5-cent remainder is folded into the largest row; 5 cents or more is parked', () => {
  const dep = [{ type: 'A', account: 'Checking', deposit: 10 }, { type: 'B', account: 'Checking', deposit: 5 }];
  let out = planRows({ deposits: dep, surplusDeposits: [], unassigned: 0.02, amount: 15.02, date: 'd', desc: 'x' });
  assert.equal(out.rows.length, 2); assert.equal(out.rows[0][2], 10.02); assert.equal(out.total, 15.02);
  out = planRows({ deposits: dep, surplusDeposits: [], unassigned: 0.05, amount: 15.05, date: 'd', desc: 'x' });
  assert.equal(out.rows.length, 3); assert.equal(out.rows[2][1], UNASSIGNED); assert.equal(out.total, 15.05);
});

test('buckets: blank names and zero weights claim nothing; the rest is parked', () => {
  const { deposits, unassigned } = splitSurplus(100, [{ name: 'A', weight: '1' }, { name: '', weight: '3' }, { name: 'C', weight: '0' }, { name: 'D', weight: '3' }]);
  assert.equal(cents(deposits[0].deposit), 25); assert.equal(deposits[1].deposit, 0); assert.equal(deposits[2].deposit, 0); assert.equal(cents(deposits[3].deposit), 75);
  assert.equal(cents(unassigned), 0);
  assert.equal(splitSurplus(42.42, []).unassigned, 42.42);
});

test('a plan that does not add up is refused, not written', () => {
  assert.throws(() => planRows({ deposits: [{ type: 'A', account: 'Checking', deposit: 10 }], surplusDeposits: [], unassigned: 0, amount: 12, date: 'd', desc: 'x' }), /short/);
  assert.throws(() => planRows({ deposits: [], surplusDeposits: [], unassigned: 0, amount: 0, date: 'd', desc: 'x' }), /nothing/);
});
