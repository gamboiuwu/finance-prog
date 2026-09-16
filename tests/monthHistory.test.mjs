import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthOf, monthTotals } from '../src/lib/monthHistory.js';

test('monthOf reads YYYY-MM-DD by parts (no UTC slip on the 1st)', () => {
  assert.deepEqual(monthOf('2026-09-01'), { y: 2026, m: 9 });
  assert.deepEqual(monthOf('2026-01-01'), { y: 2026, m: 1 });
});

test('monthOf handles serials and M/D/YYYY', () => {
  assert.deepEqual(monthOf(46266), { y: 2026, m: 9 });   // 2026-09-01
  assert.deepEqual(monthOf('9/1/2026'), { y: 2026, m: 9 });
});

test('monthTotals keeps 1st-of-month rows in their month', () => {
  const t = monthTotals([
    { dateStr: '2026-09-01', amount: 828.26 },
    { dateStr: '2026-09-04', amount: 208.77 },
    { dateStr: '2026-09-04', amount: -40 },
  ]);
  const sep = t.get('2026-09');
  assert.equal(Math.round(sep.income * 100) / 100, 1037.03);
  assert.equal(sep.spent, 40);
  assert.equal(t.get('2026-08'), undefined);
});
