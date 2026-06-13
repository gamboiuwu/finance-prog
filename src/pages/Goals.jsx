// Goals.jsx — the dedicated Goals tab.
//
// Reads the saved plans from the Plans sheet and, for each one, runs the
// affordability engine against the user's CURRENT cash flow so every goal shows
// an honest "can I reach this, and what should I change?" assessment. Personal
// goals are measured against personal cash flow, business goals against business
// revenue vs expenses.
import { useState, useEffect, useCallback } from 'react';
import { readPlans, savePlan, deletePlan, updatePlanProgress } from '../lib/sheetWrite';
import { appendRow } from '../lib/sheets';
import { parsePlans, derivePersonalCashflow, deriveBusinessCashflow } from '../lib/dragonOverview';
import { assessGoal } from '../lib/dragonPlan';

// ── Milestone tracking (Task 9) ───────────────────────────────────────────────
// A contribution that pushes a goal past 25 / 50 / 75 / 100% fires a one-time
// browser push. Which milestones a goal has already announced are remembered in
// localStorage `_fin_goal_milestones = { "Goal name": [25,50] }` (percent ints
// only — no financial data) so each milestone notifies at most once per goal.
const MILESTONES = [25, 50, 75, 100];
const MS_KEY = '_fin_goal_milestones';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function getMilestoneMap() {
  try { return JSON.parse(localStorage.getItem(MS_KEY)) || {}; } catch { return {}; }
}
function setMilestoneMap(m) {
  try { localStorage.setItem(MS_KEY, JSON.stringify(m)); } catch { /* quota / private mode */ }
}

function notifyMilestone(goalName, milestone) {
  if (typeof Notification === 'undefined') return;
  const body = milestone >= 100
    ? `🎉 "${goalName}" is fully funded — goal reached!`
    : `🎯 "${goalName}" just hit ${milestone}% funded. Keep it going!`;
  const fire = () => { try { new Notification('Savings goal milestone', { body }); } catch { /* ignore */ } };
  if (Notification.permission === 'granted') fire();
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { if (p === 'granted') fire(); });
  }
}

// Fire a push for every milestone strictly crossed by this contribution
// (oldPct < m <= newPct) that hasn't already been announced; persist the dedup.
function fireMilestones(goalName, oldPct, newPct) {
  const map = getMilestoneMap();
  const hit = new Set((map[goalName] || []).map(Number));
  let top = 0;
  for (const m of MILESTONES) {
    if (newPct >= m && oldPct < m && !hit.has(m)) { hit.add(m); top = m; }
  }
  if (!top) return;
  map[goalName] = [...hit].sort((a, b) => a - b);
  setMilestoneMap(map);
  notifyMilestone(goalName, top);
}

// Convert a raw sheet date value (serial number or string) to YYYY-MM-DD.
// parsePlans() handles integer-string serials; this also covers fractional serials
// (e.g. 46327.5) that arrive as JS Numbers and slip through as raw text, causing
// the raw number to appear verbatim in assessment headlines.
function normTargetDate(raw) {
  if (!raw && raw !== 0) return '';
  const s = String(raw).trim();
  // Integer or decimal number — treat as a Google Sheets date serial.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Math.floor(parseFloat(s));
    if (n > 10000) {
      return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
    }
  }
  return s; // already a string date (YYYY-MM-DD, M/D/YYYY, etc.)
}

// Format a YYYY-MM-DD date as "Mon YYYY" for display on goal cards.
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso + 'T12:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

const fmt = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return abs >= 100
    ? `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `${sign}$${abs.toFixed(2)}`;
};
const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const pct   = (n) => `${Math.round(Number(n) || 0)}%`;

const VERDICT = {
  reached:  { label: 'Reached',         cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  on_track: { label: 'On track',        cls: 'bg-teal-900/40 text-teal-300 border-teal-700/50' },
  at_risk:  { label: 'At risk',         cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
  behind:   { label: 'Behind',          cls: 'bg-orange-900/40 text-orange-300 border-orange-700/50' },
  stalled:  { label: 'Stalled',         cls: 'bg-slate-700/50 text-slate-300 border-slate-600/50' },
};

// ── Inline goal card with edit / delete buttons ───────────────────────────────
function GoalCard({ g, onEdit, onDelete, onContribute, isDeleting }) {
  const done   = g.status === 'done' || g.progress >= 100;
  const paused = g.status === 'paused';
  const barColor = done ? 'bg-emerald-500' : paused ? 'bg-slate-500' : 'bg-gradient-to-r from-emerald-500 to-teal-400';
  const a = g.assessment;
  const v = a ? (VERDICT[a.verdict] || VERDICT.on_track) : null;

  return (
    <div className="bg-slate-900/60 rounded-xl p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center gap-2">
        <p className="text-white text-sm font-semibold truncate flex-1 flex items-center gap-1.5">
          {done ? '✅' : g.scope === 'business' ? '💼' : '🎯'} {g.name}
        </p>
        {g.targetDate && (
          <span className="text-slate-500 text-[10px] shrink-0">by {fmtDate(g.targetDate)}</span>
        )}
        <button
          onClick={() => onEdit(g)}
          className="shrink-0 text-slate-500 hover:text-teal-300 text-xs px-1.5 py-0.5 rounded transition-colors"
          title="Edit goal"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(g)}
          disabled={isDeleting}
          className="shrink-0 text-slate-600 hover:text-rose-400 text-xs px-1.5 py-0.5 rounded transition-colors disabled:opacity-40"
          title="Delete goal"
        >
          {isDeleting ? '...' : 'Del'}
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-slate-700/60 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${clamp(g.progress)}%` }} />
      </div>

      {/* Progress numbers */}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-300">
          {fmt(g.saved)} <span className="text-slate-500">of {fmt(g.target)}</span>
        </span>
        <span className="text-slate-400">
          {done
            ? <span className="text-emerald-400 font-semibold">Funded!</span>
            : paused
            ? <span className="text-slate-400">Paused</span>
            : <>{pct(g.progress)} · {fmt(g.remaining)} to go</>}
        </span>
      </div>

      {!done && g.perMonth > 0 && (
        <p className="text-slate-500 text-[10px]">{fmt(g.perMonth)}/mo planned</p>
      )}

      {/* Contribute — logs a real deposit to Allocation Transactions + bumps Saved */}
      {!done && (
        <button
          onClick={() => onContribute(g)}
          className="w-full mt-0.5 bg-teal-600/90 hover:bg-teal-500 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors"
        >
          + Contribute
        </button>
      )}

      {/* Assessment */}
      {a && (
        <div className="border-t border-slate-700/60 pt-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${v.cls}`}>{v.label}</span>
            {a.projectedDate && (
              <span className="text-slate-500 text-[10px]">est. finish {a.projectedDate}</span>
            )}
          </div>
          {a.headline && (
            <p className="text-slate-300 text-[11px] leading-snug">{a.headline}</p>
          )}
          {a.suggestions?.length > 0 && (
            <ul className="space-y-1">
              {a.suggestions.map((s, i) => (
                <li key={i} className="text-slate-400 text-[11px] leading-snug flex gap-1.5">
                  <span className="text-teal-400 shrink-0">-&gt;</span><span>{s}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function GoalGroup({ title, goals, onEdit, onDelete, onContribute, deleting }) {
  if (!goals.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-slate-400 text-[11px] uppercase tracking-wider font-semibold">
        {title} <span className="text-slate-600">({goals.length})</span>
      </p>
      {goals.map((g, i) => (
        <GoalCard
          key={g.id || i}
          g={g}
          onEdit={onEdit}
          onDelete={onDelete}
          onContribute={onContribute}
          isDeleting={deleting === g.id}
        />
      ))}
    </div>
  );
}

// ── Contribute drawer ─────────────────────────────────────────────────────────
function ContributeDrawer({ goal, onSubmit, onClose, saving }) {
  const remaining = Math.max(0, (Number(goal.target) || 0) - (Number(goal.saved) || 0));
  const [amount, setAmount]   = useState('');
  const [account, setAccount] = useState('Savings');

  function handleSubmit(e) {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    onSubmit({ goal, amount: amt, account: account.trim() || 'Savings' });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <form
        className="bg-slate-900 rounded-t-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between mb-1">
          <p className="text-white font-semibold font-broske">Contribute to {goal.name}</p>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        <p className="text-slate-400 text-xs">
          {fmt(goal.saved)} of {fmt(goal.target)} saved · <span className="text-teal-300">{fmt(remaining)} to go</span>
        </p>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Amount ($)</label>
          <input
            autoFocus type="number" min="0" step="0.01" inputMode="decimal"
            className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
            placeholder="50"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            required
          />
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setAmount(String(round2(remaining)))}
              className="text-teal-400 hover:text-teal-300 text-[11px] mt-1"
            >
              Fill remaining ({fmt(remaining)})
            </button>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Account</label>
          <input
            className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
            placeholder="Savings"
            value={account}
            onChange={e => setAccount(e.target.value)}
          />
        </div>

        <p className="text-slate-500 text-[10px] leading-snug">
          Logs a deposit to your Allocation Transactions and adds to this goal&apos;s saved total.
        </p>

        <button
          type="submit" disabled={saving || !(parseFloat(amount) > 0)}
          className="w-full bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl transition-colors"
        >
          {saving ? 'Logging...' : 'Log contribution'}
        </button>
      </form>
    </div>
  );
}

// ── CRUD drawer ───────────────────────────────────────────────────────────────
const EMPTY_FORM = {
  id: '', name: '', scope: 'personal',
  target: '', saved: '', perMonth: '', targetDate: '', notes: '',
};

function GoalDrawer({ initial, onSave, onClose, saving }) {
  const editing = Boolean(initial?.id);
  const [form, setForm] = useState(() => initial ? {
    id:         initial.id || '',
    name:       initial.name || '',
    scope:      initial.scope || 'personal',
    target:     initial.target != null ? String(initial.target) : '',
    saved:      initial.saved  != null ? String(initial.saved)  : '',
    perMonth:   initial.perMonth != null ? String(initial.perMonth) : '',
    targetDate: initial.targetDate || '',
    notes:      initial.notes || '',
  } : { ...EMPTY_FORM });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSave({
      id:         form.id || undefined,
      name:       form.name.trim(),
      scope:      form.scope,
      target:     parseFloat(form.target)   || 0,
      saved:      parseFloat(form.saved)    || 0,
      perMonth:   parseFloat(form.perMonth) || 0,
      targetDate: form.targetDate.trim(),
      notes:      form.notes.trim(),
      status:     initial?.status || 'active',
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <form
        className="bg-slate-900 rounded-t-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between mb-1">
          <p className="text-white font-semibold font-broske">{editing ? 'Edit Goal' : 'Add Goal'}</p>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Goal name</label>
          <input
            autoFocus
            className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
            placeholder="e.g. Emergency fund"
            value={form.name}
            onChange={e => set('name', e.target.value)}
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Target ($)</label>
            <input
              type="number" min="0" step="1"
              className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="5000"
              value={form.target}
              onChange={e => set('target', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Already saved ($)</label>
            <input
              type="number" min="0" step="0.01"
              className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="0"
              value={form.saved}
              onChange={e => set('saved', e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-slate-400 text-xs">$/month planned</label>
            <input
              type="number" min="0" step="0.01"
              className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="200"
              value={form.perMonth}
              onChange={e => set('perMonth', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Target date</label>
            <input
              type="date"
              className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
              value={form.targetDate}
              onChange={e => set('targetDate', e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Scope</label>
          <div className="flex gap-2">
            {['personal', 'business'].map(s => (
              <button
                key={s} type="button"
                onClick={() => set('scope', s)}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
                  form.scope === s
                    ? 'bg-teal-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                {s === 'personal' ? 'Personal' : 'Business'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-slate-400 text-xs">Notes (optional)</label>
          <input
            className="w-full bg-slate-800 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teal-500"
            placeholder="Any extra context..."
            value={form.notes}
            onChange={e => set('notes', e.target.value)}
          />
        </div>

        <button
          type="submit" disabled={saving || !form.name.trim()}
          className="w-full bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl transition-colors"
        >
          {saving ? 'Saving...' : editing ? 'Save Changes' : 'Add Goal'}
        </button>
      </form>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Goals({ token }) {
  const [plans, setPlans]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [drawer, setDrawer]     = useState(null); // null | 'add' | goal-object (edit)
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState(null); // id of goal currently being deleted
  const [contributeFor, setContributeFor] = useState(null); // goal-object being funded
  const [contributing, setContributing]   = useState(false);

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
      const assessed = parsePlans(rows).map(g => {
        // Normalise targetDate: parsePlans handles integer-string serials but
        // fractional serials (e.g. 46327.5) can slip through as raw text and
        // cause fmtTargetDate() inside assessGoal to emit the raw number verbatim
        // in the assessment headline.
        const normalized = { ...g, targetDate: normTargetDate(g.targetDate) };
        return {
          ...normalized,
          assessment: assessGoal(
            normalized,
            normalized.scope === 'business' ? businessCash : personalCash,
          ),
        };
      });
      setPlans(assessed);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function handleSave(formData) {
    setSaving(true);
    try {
      await savePlan(token, formData);
      setDrawer(null);
      await load();
    } catch (e) {
      alert(`Could not save goal: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleContribute({ goal, amount, account }) {
    setContributing(true);
    try {
      const amt = round2(amount);
      const today = new Date().toISOString().slice(0, 10);
      // 1) Log a real deposit so the money is reflected in the budget, not just here.
      await appendRow(token, 'Allocation Transactions!A:F', [
        today, goal.name, amt, `Goal contribution: ${goal.name}`, account, true,
      ]);
      // 2) Bump the plan's Saved total on the sheet.
      await updatePlanProgress(token, { id: goal.id, addAmount: amt });
      // 3) Milestone push — computed locally so it fires before the reload.
      const target = Number(goal.target) || 0;
      if (target > 0) {
        const oldPct = (Number(goal.saved) || 0) / target * 100;
        const newPct = ((Number(goal.saved) || 0) + amt) / target * 100;
        fireMilestones(goal.name, oldPct, newPct);
      }
      setContributeFor(null);
      await load();
    } catch (e) {
      alert(`Could not log contribution: ${e.message || e}`);
    } finally {
      setContributing(false);
    }
  }

  async function handleDelete(g) {
    if (!window.confirm(`Delete goal "${g.name}"? This cannot be undone.`)) return;
    setDeleting(g.id);
    try {
      await deletePlan(token, { id: g.id });
      await load();
    } catch (e) {
      alert(`Could not delete goal: ${e.message || e}`);
    } finally {
      setDeleting(null);
    }
  }

  const active   = plans.filter(p => p.status !== 'done' && p.progress < 100);
  const done     = plans.filter(p => p.status === 'done' || p.progress >= 100);
  const personal = active.filter(p => p.scope !== 'business');
  const business = active.filter(p => p.scope === 'business');

  function renderBody() {
    if (loading) return <p className="text-slate-500 text-sm text-center py-8">Loading goals...</p>;
    if (error)   return <p className="text-rose-300 text-sm text-center py-8">Could not load goals: {error}</p>;
    if (plans.length === 0) {
      return (
        <div className="text-center py-10 px-6 space-y-2">
          <p className="text-4xl">🗺️</p>
          <p className="text-white font-semibold font-broske">No goals yet</p>
          <p className="text-slate-400 text-sm">
            Tap <strong className="text-teal-400">+ Add</strong> above to create your first goal, or ask Ledger on the Dragon tab to set one up.
          </p>
          <button onClick={load} className="text-teal-400 text-xs mt-2 hover:text-teal-300">Refresh</button>
        </div>
      );
    }
    const sharedProps = { onEdit: g => setDrawer(g), onDelete: handleDelete, onContribute: g => setContributeFor(g), deleting };
    return (
      <div className="space-y-5">
        <GoalGroup title="Personal" goals={personal} {...sharedProps} />
        <GoalGroup title="Business" goals={business} {...sharedProps} />
        {done.length > 0 && <GoalGroup title="Funded" goals={done} {...sharedProps} />}
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-5 pb-28">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-white font-bold text-xl font-broske flex items-center gap-2">Goals</h1>
          <p className="text-slate-500 text-xs mt-1">
            Live progress and an honest read on whether each goal is on track.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!loading && (
            <button onClick={load} className="text-slate-500 hover:text-teal-300 text-xs">Refresh</button>
          )}
          <button
            onClick={() => setDrawer('add')}
            className="bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
          >
            + Add
          </button>
        </div>
      </div>

      {renderBody()}

      {drawer && (
        <GoalDrawer
          initial={drawer === 'add' ? null : drawer}
          onSave={handleSave}
          onClose={() => setDrawer(null)}
          saving={saving}
        />
      )}

      {contributeFor && (
        <ContributeDrawer
          goal={contributeFor}
          onSubmit={handleContribute}
          onClose={() => setContributeFor(null)}
          saving={contributing}
        />
      )}
    </div>
  );
}
