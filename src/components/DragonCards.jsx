// DragonCards.jsx — the visual "windows" Ledger generates inside the chat.
//
// The dragon's tools (show_financial_overview, analyze_affordability) return a
// structured `card` payload; the chat renders it here as a rich panel instead of
// a wall of numbers. Every figure is computed upstream in pure JS, so these
// components only format and lay out — they never do finance math themselves.

// Currency: whole dollars with separators at scale, cents for small amounts.
function fmt(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return abs >= 100
    ? `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `${sign}$${abs.toFixed(2)}`;
}

const pct = (n) => `${Math.round(Number(n) || 0)}%`;
const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

function monthShort(ym) {
  const [y, m] = String(ym).split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-US', { month: 'short' });
}

// ── Small building blocks ────────────────────────────────────────────────────
function Tile({ label, value, tone = 'text-white', sub }) {
  return (
    <div className="bg-slate-900/60 rounded-xl px-3 py-2.5 flex-1 min-w-0">
      <p className="text-slate-500 text-[10px] uppercase tracking-wider truncate">{label}</p>
      <p className={`font-bold text-sm leading-tight mt-0.5 ${tone}`}>{value}</p>
      {sub && <p className="text-slate-500 text-[10px] mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

// A labelled horizontal bar (value relative to max).
function Bar({ label, amount, max, color = 'bg-teal-500', right }) {
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between items-baseline gap-2 text-xs">
        <span className="text-slate-300 truncate">{label}</span>
        <span className="text-slate-400 font-mono shrink-0">{right ?? fmt(amount)}</span>
      </div>
      <div className="h-1.5 bg-slate-700/60 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${clamp(max > 0 ? (amount / max) * 100 : 0)}%` }} />
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <p className="text-slate-400 text-[11px] uppercase tracking-wider font-semibold">{children}</p>;
}

// ── Financial overview window ─────────────────────────────────────────────────
const GROUP_COLORS = {
  Essentials: 'bg-rose-500',
  Stability: 'bg-amber-500',
  Discretionary: 'bg-teal-500',
  Subscription: 'bg-violet-500',
  Other: 'bg-slate-500',
};

function PersonalOverview({ p }) {
  if (!p) return null;
  const groupMax = Math.max(1, ...p.groups.map(g => g.amount));
  const catMax = Math.max(1, ...p.topCategories.map(c => c.amount));
  const rateTone = p.savingsRate >= 20 ? 'text-emerald-400' : p.savingsRate >= 10 ? 'text-amber-400' : 'text-rose-400';
  const rateColor = p.savingsRate >= 20 ? 'bg-emerald-500' : p.savingsRate >= 10 ? 'bg-amber-500' : 'bg-rose-500';

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Tile label="Income / mo" value={fmt(p.avgIncome)} tone="text-emerald-400" sub="recent avg" />
        <Tile label="Spending / mo" value={fmt(p.avgSpent)} tone="text-rose-400" sub="recent avg" />
        <Tile label="Net / mo" value={fmt(p.net)} tone={p.net >= 0 ? 'text-teal-300' : 'text-rose-400'} />
      </div>

      <div className="space-y-1">
        <div className="flex justify-between items-baseline text-xs">
          <span className="text-slate-400">Savings rate</span>
          <span className={`font-bold ${rateTone}`}>{pct(p.savingsRate)}</span>
        </div>
        <div className="h-2 bg-slate-700/60 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${rateColor}`} style={{ width: `${clamp(p.savingsRate)}%` }} />
        </div>
      </div>

      <div className="flex gap-2">
        <Tile label="Free cash flow" value={`${fmt(p.freeCashFlow)}/mo`}
          tone={p.freeCashFlow >= 0 ? 'text-teal-300' : 'text-rose-400'} sub="income − budget" />
        <Tile label="Subscriptions" value={`${fmt(p.subscriptionsMonthly)}/mo`}
          tone="text-violet-300" sub={`${p.subscriptionCount} active`} />
      </div>

      {p.groups.length > 0 && (
        <div className="space-y-2">
          <SectionTitle>Budget by priority</SectionTitle>
          {p.groups.map(g => (
            <Bar key={g.name} label={g.name} amount={g.amount} max={groupMax}
              color={GROUP_COLORS[g.name] || GROUP_COLORS.Other} />
          ))}
        </div>
      )}

      {p.topCategories.length > 0 && (
        <div className="space-y-2">
          <SectionTitle>Top categories</SectionTitle>
          {p.topCategories.map(c => (
            <Bar key={c.category} label={c.category} amount={c.amount} max={catMax} color="bg-slate-400" />
          ))}
        </div>
      )}
    </div>
  );
}

function MiniTrend({ series }) {
  if (!series || series.length === 0) return null;
  const max = Math.max(1, ...series.map(s => Math.max(s.revenue, s.expense)));
  return (
    <div className="space-y-1.5">
      <div className="flex items-end justify-between gap-1 h-20">
        {series.map(s => (
          <div key={s.month} className="flex-1 flex flex-col items-center justify-end gap-0.5 h-full">
            <div className="w-full flex items-end justify-center gap-0.5 h-full">
              <div className="w-1/2 bg-teal-500 rounded-t" style={{ height: `${clamp((s.revenue / max) * 100)}%` }} title={`Revenue ${fmt(s.revenue)}`} />
              <div className="w-1/2 bg-rose-500 rounded-t" style={{ height: `${clamp((s.expense / max) * 100)}%` }} title={`Expense ${fmt(s.expense)}`} />
            </div>
            <span className="text-slate-500 text-[9px]">{monthShort(s.month)}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-3 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-teal-500" /> Revenue</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-rose-500" /> Expense</span>
      </div>
    </div>
  );
}

function BusinessOverview({ b }) {
  if (!b) return null;
  if (!b.hasData) {
    return (
      <div className="space-y-2">
        <SectionTitle>💼 Business</SectionTitle>
        <p className="text-slate-500 text-xs">No sales or expenses logged yet — once you log some, the business snapshot lights up here.</p>
      </div>
    );
  }
  const vendMax = Math.max(1, ...b.topVendors.map(v => v.amount));
  return (
    <div className="space-y-3">
      <SectionTitle>💼 Business</SectionTitle>
      <div className="flex gap-2">
        <Tile label="Revenue" value={fmt(b.totalRevenue)} tone="text-emerald-400" sub={`${fmt(b.avgMonthlyRevenue)}/mo`} />
        <Tile label="Expenses" value={fmt(b.totalExpense)} tone="text-rose-400" sub={`${fmt(b.avgMonthlyExpense)}/mo`} />
      </div>
      <div className="flex gap-2">
        <Tile label="Net" value={fmt(b.net)} tone={b.net >= 0 ? 'text-teal-300' : 'text-rose-400'} sub="rev − expenses" />
        <Tile label="Margin" value={pct(b.margin)} tone={b.margin >= 0 ? 'text-teal-300' : 'text-rose-400'} />
      </div>
      {b.series.length > 0 && <MiniTrend series={b.series} />}
      {b.topVendors.length > 0 && (
        <div className="space-y-2">
          <SectionTitle>Top vendors</SectionTitle>
          {b.topVendors.map(v => (
            <Bar key={v.name} label={v.name} amount={v.amount} max={vendMax} color="bg-amber-500" />
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewCard({ data }) {
  const focusLabel = data.focus === 'personal' ? 'Personal' : data.focus === 'business' ? 'Business' : 'Full picture';
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-white font-bold font-broske flex items-center gap-1.5">📊 Financial Overview</p>
        <span className="text-slate-500 text-[10px] uppercase tracking-wider">{focusLabel}</span>
      </div>
      {data.personal && <PersonalOverview p={data.personal} />}
      {data.personal && data.business && <div className="border-t border-slate-700/60" />}
      {data.business && <BusinessOverview b={data.business} />}
    </div>
  );
}

// ── Affordability plan window ─────────────────────────────────────────────────
const FEAS = {
  comfortable: { label: 'Comfortable', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  tight:       { label: 'Tight but doable', cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
  needs_trims: { label: 'Needs trims', cls: 'bg-orange-900/40 text-orange-300 border-orange-700/50' },
  infeasible:  { label: 'Out of reach', cls: 'bg-rose-900/40 text-rose-300 border-rose-700/50' },
};

function PlanCard({ data }) {
  const d = data;
  const feas = FEAS[d.feasibility] || FEAS.tight;
  const savedPct = d.goal > 0 ? clamp((d.saved / d.goal) * 100) : 0;

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-white font-bold font-broske flex items-center gap-1.5 truncate">
          🎯 {d.goalName || 'Affordability Plan'}
        </p>
        <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${feas.cls}`}>{feas.label}</span>
      </div>

      {/* Progress toward goal */}
      <div className="space-y-1">
        <div className="flex justify-between items-baseline text-xs">
          <span className="text-slate-300">{fmt(d.saved)} of {fmt(d.goal)}</span>
          <span className="text-slate-400">{fmt(d.remaining)} to go</span>
        </div>
        <div className="h-2.5 bg-slate-700/60 rounded-full overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400" style={{ width: `${savedPct}%` }} />
        </div>
      </div>

      {/* Schedule */}
      <div className="flex gap-2">
        <Tile label="Set aside / mo" value={fmt(d.perMonth)} tone="text-emerald-400" />
        {d.perPaycheck != null && <Tile label="Per paycheck" value={fmt(d.perPaycheck)} tone="text-teal-300" sub={d.payLabel || 'biweekly'} />}
        <Tile label="Done by" value={d.projectedDate || '—'} tone="text-white" sub={d.monthsNeeded ? `~${d.monthsNeeded} mo` : undefined} />
      </div>

      {/* Free cash flow context */}
      <div className="flex gap-2">
        <Tile label="Free cash flow" value={`${fmt(d.freeCashFlow)}/mo`}
          tone={d.freeCashFlow >= 0 ? 'text-teal-300' : 'text-rose-400'} />
        {d.monthlyShortfall > 0 && <Tile label="Monthly gap" value={fmt(d.monthlyShortfall)} tone="text-orange-400" />}
      </div>

      {/* Trim plan */}
      {d.trimPlan && d.trimPlan.length > 0 && (
        <div className="space-y-2">
          <SectionTitle>Free up the gold</SectionTitle>
          {d.trimPlan.map(t => (
            <div key={t.category} className="flex items-center justify-between text-xs gap-2">
              <span className="text-slate-300 truncate">{t.category}</span>
              <span className="font-mono shrink-0">
                <span className="text-slate-500 line-through">{fmt(t.from)}</span>
                <span className="text-slate-400"> → </span>
                <span className="text-amber-300">{fmt(t.to)}</span>
              </span>
            </div>
          ))}
          {d.stillShort > 0 && (
            <p className="text-rose-300/80 text-[11px]">Still {fmt(d.stillShort)}/mo short — extend the deadline or raise income.</p>
          )}
        </div>
      )}

      {/* Milestones */}
      {d.milestones && d.milestones.length > 0 && (
        <div className="space-y-2">
          <SectionTitle>Milestones</SectionTitle>
          <div className="flex items-center justify-between">
            {d.milestones.map((m, i) => (
              <div key={i} className="flex flex-col items-center gap-1 flex-1">
                <div className="w-2.5 h-2.5 rounded-full bg-teal-400" />
                <span className="text-slate-300 text-[10px] font-semibold">{m.pct}%</span>
                <span className="text-slate-500 text-[9px] text-center leading-tight">{m.by}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {d.summary && <p className="text-slate-400 text-[11px] border-t border-slate-700/60 pt-2">{d.summary}</p>}
    </div>
  );
}

// ── Saved goals panel (persistent view of the Plans sheet) ───────────────────
const VERDICT = {
  reached:  { label: 'Reached',  cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  on_track: { label: 'On track', cls: 'bg-teal-900/40 text-teal-300 border-teal-700/50' },
  at_risk:  { label: 'At risk',  cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
  behind:   { label: 'Behind',   cls: 'bg-orange-900/40 text-orange-300 border-orange-700/50' },
  stalled:  { label: 'Stalled',  cls: 'bg-slate-700/50 text-slate-300 border-slate-600/50' },
};

function GoalInsight({ a }) {
  const v = VERDICT[a.verdict] || VERDICT.on_track;
  return (
    <div className="border-t border-slate-700/60 pt-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${v.cls}`}>{v.label}</span>
        {a.projectedDate && <span className="text-slate-500 text-[10px]">est. finish {a.projectedDate}</span>}
      </div>
      {a.headline && <p className="text-slate-300 text-[11px] leading-snug">{a.headline}</p>}
      {a.suggestions?.length > 0 && (
        <ul className="space-y-1">
          {a.suggestions.map((s, i) => (
            <li key={i} className="text-slate-400 text-[11px] leading-snug flex gap-1.5">
              <span className="text-teal-400 shrink-0">→</span><span>{s}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GoalRow({ g }) {
  const done = g.status === 'done' || g.progress >= 100;
  const paused = g.status === 'paused';
  const barColor = done ? 'bg-emerald-500' : paused ? 'bg-slate-500' : 'bg-gradient-to-r from-emerald-500 to-teal-400';
  return (
    <div className="bg-slate-900/60 rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-white text-sm font-semibold truncate flex items-center gap-1.5">
          {done ? '✅' : g.scope === 'business' ? '💼' : '🎯'} {g.name}
        </p>
        {g.targetDate && <span className="text-slate-500 text-[10px] shrink-0">by {g.targetDate}</span>}
      </div>
      <div className="h-2 bg-slate-700/60 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${clamp(g.progress)}%` }} />
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-300">{fmt(g.saved)} <span className="text-slate-500">of {fmt(g.target)}</span></span>
        <span className="text-slate-400">
          {done ? <span className="text-emerald-400 font-semibold">Funded!</span>
            : paused ? <span className="text-slate-400">Paused</span>
            : <>{pct(g.progress)} · {fmt(g.remaining)} to go</>}
        </span>
      </div>
      {!done && g.perMonth > 0 && (
        <p className="text-slate-500 text-[10px]">{fmt(g.perMonth)}/mo planned</p>
      )}
      {g.assessment && <GoalInsight a={g.assessment} />}
    </div>
  );
}

function GoalGroup({ title, icon, goals }) {
  if (!goals.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-slate-400 text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1.5">
        {icon} {title} <span className="text-slate-600">({goals.length})</span>
      </p>
      {goals.map((g, i) => <GoalRow key={g.id || i} g={g} />)}
    </div>
  );
}

// `plans` is the parsed output of parsePlans(); renders personal + business goals.
export function GoalsList({ plans, loading, error, onRefresh }) {
  if (loading) return <p className="text-slate-500 text-sm text-center py-8">Unfurling your quest log…</p>;
  if (error)   return <p className="text-rose-300 text-sm text-center py-8">Couldn't load goals: {error}</p>;

  const active   = plans.filter(p => p.status !== 'done' && p.progress < 100);
  const done     = plans.filter(p => p.status === 'done' || p.progress >= 100);
  const personal = active.filter(p => p.scope !== 'business');
  const business = active.filter(p => p.scope === 'business');

  if (plans.length === 0) {
    return (
      <div className="text-center py-10 px-6 space-y-2">
        <p className="text-4xl">🗺️</p>
        <p className="text-white font-semibold font-broske">No quests yet</p>
        <p className="text-slate-400 text-sm">Ask Ledger to help you afford something — personal or business — and your goals appear here with live progress.</p>
        {onRefresh && <button onClick={onRefresh} className="text-teal-400 text-xs mt-2 hover:text-teal-300">↻ Refresh</button>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-white font-bold font-broske flex items-center gap-1.5">🎯 Your Goals</p>
        {onRefresh && <button onClick={onRefresh} className="text-slate-400 hover:text-teal-300 text-xs">↻ Refresh</button>}
      </div>
      <GoalGroup title="Personal" icon="🏷️" goals={personal} />
      <GoalGroup title="Business" icon="💼" goals={business} />
      {done.length > 0 && <GoalGroup title="Funded" icon="✅" goals={done} />}
    </div>
  );
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
export default function DragonCard({ card }) {
  if (!card || !card.data) return null;
  if (card.type === 'overview') return <OverviewCard data={card.data} />;
  if (card.type === 'plan')     return <PlanCard data={card.data} />;
  return null;
}
