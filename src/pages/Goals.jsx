// Goals.jsx — the dedicated Goals tab.
//
// Reads the saved plans from the Plans sheet and, for each one, runs the
// affordability engine against the user's CURRENT cash flow so every goal shows
// an honest "can I reach this, and what should I change?" assessment. Personal
// goals are measured against personal cash flow, business goals against business
// revenue vs expenses.
import { useState, useEffect, useCallback } from 'react';
import { readPlans } from '../lib/sheetWrite';
import { parsePlans, derivePersonalCashflow, deriveBusinessCashflow } from '../lib/dragonOverview';
import { assessGoal } from '../lib/dragonPlan';
import { GoalsList } from '../components/DragonCards';

export default function Goals({ token }) {
  const [plans, setPlans]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      // Pull plans plus both cash-flow pictures in parallel; assess each goal
      // against the matching scope so the verdict reflects reality.
      const [rows, personalCash, businessCash] = await Promise.all([
        readPlans(token),
        derivePersonalCashflow(token),
        deriveBusinessCashflow(token),
      ]);
      const assessed = parsePlans(rows).map(g => ({
        ...g,
        assessment: assessGoal(g, g.scope === 'business' ? businessCash : personalCash),
      }));
      setPlans(assessed);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-lg mx-auto px-4 py-5 pb-28">
      <div className="mb-4">
        <h1 className="text-white font-bold text-xl font-broske flex items-center gap-2">🎯 Goals</h1>
        <p className="text-slate-500 text-xs mt-1">
          Every goal you set with Ledger, with live progress and an honest read on whether it’s on track —
          ask Ledger on the 🐉 tab to add or adjust one.
        </p>
      </div>
      <GoalsList plans={plans} loading={loading} error={error} onRefresh={load} />
    </div>
  );
}
