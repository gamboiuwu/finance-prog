// Goals.jsx — the dedicated Goals tab.
//
// Reads the saved plans from the Plans sheet and, for each one, runs the
// affordability engine against the user's CURRENT cash flow so every goal shows
// an honest "can I reach this, and what should I change?" assessment. Personal
// goals are measured against personal cash flow, business goals against business
// revenue vs expenses.
import { useState, useEffect, useCallback } from 'react';
import { readPlans, savePlan, deletePlan } from '../lib/sheetWrite';
import { parsePlans, derivePersonalCashflow, deriveBusinessCashflow } from '../lib/dragonOverview';
import { assessGoal } from '../lib/dragonPlan';

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

// ── Milestone tracking (Task 9) ───────────────────────────────────────────────
// Celebrate when a goal crosses 25 / 50 / 75 / 100% funded. Crossings are deduped
// in localStorage so each milestone notifies at most once. A goal seen for the
// first time is seeded SILENTLY with whatever it has already passed, so existing
// goals never fire a burst of stale notifications on first load — only genuinely
// new crossings push. Nothing financial is stored: the map holds opaque goal keys
// → integer milestone percentages, no amounts.
const GOAL_MILESTONES = [25, 50, 75, 100];
const GOAL_MS_KEY = '_fin_goal_milestones';

const goalKey = (g) => g.id || g.name || '';

function readGoalMilestones() {
  try { return JSON.parse(localStorage.getItem(GOAL_MS_KEY)) || {}; }
  catch { return {}; }
}
function writeGoalMilestones(map) {
  try { localStorage.setItem(GOAL_MS_KEY, JSON.stringify(map)); } catch {}
}
// Milestone percentages a goal at `progress`% has reached.
function reachedMilestones(progress) {
  const p = clamp(progress);
  return GOAL_MILESTONES.filter(m => p >= m);
}
// Reconcile every goal against stored milestones. Fires one push per newly
// crossed milestone (skipping each goal's silent first-seen baseline), prunes
// entries for deleted goals, and returns the updated { key: [reached...] } map
// for rendering milestone badges. Read-only to the sheet — localStorage + push.
function syncGoalMilestones(goals) {
  const stored = readGoalMilestones();
  const next = {};
  const fresh = []; // { name, milestone, saved, target }
  for (const g of goals) {
    const key = goalKey(g);
    if (!key) continue;
    const reached = reachedMilestones(g.progress);
    const prev = Array.isArray(stored[key]) ? stored[key].map(Number) : null;
    if (prev !== null) {
      // Known goal — anything newly reached beyond what we recorded is a crossing.
      for (const m of reached) {
        if (!prev.includes(m)) fresh.push({ name: g.name, milestone: m, saved: g.saved, target: g.target });
      }
    }
    // prev === null → first sighting: baseline silently (no notification).
    next[key] = reached;
  }
  writeGoalMilestones(next); // deleted goals drop out (rebuilt from live list)

  if (fresh.length && typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
    const doNotify = () => {
      try {
        for (const f of fresh) {
          const title = f.milestone >= 100
            ? `🏆 ${f.name} fully funded! 🎉`
            : `🎉 ${f.name}: ${f.milestone}% funded`;
          new Notification(title, {
            body: `${fmt(f.saved)} of ${fmt(f.target)} saved`,
            tag: `fin-goal-${f.name}-${f.milestone}`,
          });
        }
      } catch {}
    };
    if (Notification.permission === 'granted') doNotify();
    else Notification.requestPermission().then(p => { if (p === 'granted') doNotify(); });
  }
  return next;
}

const VERDICT = {
  reached:  { label: 'Reached',         cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  on_track: { label: 'On track',        cls: 'bg-teal-900/40 text-teal-300 border-teal-700/50' },
  at_risk:  { label: 'At risk',         cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
  behind:   { label: 'Behind',          cls: 'bg-orange-900/40 text-orange-300 border-orange-700/50' },
  stalled:  { label: 'Stalled',         cls: 'bg-slate-700/50 text-slate-300 border-slate-600/50' },
};

// ── Inline goal card with edit / delete buttons ───────────────────────────────
function GoalCard({ g, onEdit, onDelete, isDeleting, milestones }) {
  const done   = g.status === 'done' || g.progress >= 100;
  const paused = g.status === 'paused';
  const barColor = done ? 'bg-emerald-500' : paused ? 'bg-slate-500' : 'bg-gradient-to-r from-emerald-500 to-teal-400';
  const a = g.assessment;
  const v = a ? (VERDICT[a.verdict] || VERDICT.on_track) : null;
  // Reached milestones (falls back to live progress until the sync effect runs).
  const reached = (milestones || reachedMilestones(g.progress)).filter(m => m < 100);

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

      {/* Progress bar with 25 / 50 / 75% milestone ticks */}
      <div className="relative h-2 bg-slate-700/60 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${clamp(g.progress)}%` }} />
        {[25, 50, 75].map(m => (
          <span key={m} className="absolute top-0 bottom-0 w-px bg-slate-900/70" style={{ left: `${m}%` }} />
        ))}
      </div>

      {/* Milestone badges — celebrate the levels this goal has crossed */}
      {!done && reached.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {reached.map(m => (
            <span
              key={m}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-900/40 text-teal-300 border border-teal-700/40"
            >
              🎉 {m}%
            </span>
          ))}
        </div>
      )}

      {/* Progress numbers */}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-300">
          {fmt(g.saved)} <span className="text-slate-500">of {fmt(g.target)}</span>
        </span>
        <span className="text-slate-400">
          {done
            ? <span className="text-emerald-400 font-semibold">🏆 Funded!</span>
            : paused
            ? <span className="text-slate-400">Paused</span>
            : <>{pct(g.progress)} · {fmt(g.remaining)} to go</>}
        </span>
      </div>

      {!done && g.perMonth > 0 && (
        <p className="text-slate-500 text-[10px]">{fmt(g.perMonth)}/mo planned</p>
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

function GoalGroup({ title, goals, onEdit, onDelete, deleting, milestoneMap }) {
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
          isDeleting={deleting === g.id}
          milestones={milestoneMap[goalKey(g)]}
        />
      ))}
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
  const [milestoneMap, setMilestoneMap] = useState({}); // { goalKey: [reached %] }

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

  // Detect milestone crossings whenever goal progress changes, fire celebratory
  // pushes for new ones, and hold the reached-map for rendering badges.
  useEffect(() => {
    if (!plans.length) return;
    setMilestoneMap(syncGoalMilestones(plans));
  }, [plans]);

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
    const sharedProps = { onEdit: g => setDrawer(g), onDelete: handleDelete, deleting, milestoneMap };
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
    </div>
  );
}
