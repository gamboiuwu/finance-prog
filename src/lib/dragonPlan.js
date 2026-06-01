// dragonPlan.js — Ledger's affordability / goal-planning engine.
//
// PURE JavaScript: zero network and zero LLM tokens. ALL the "can I afford X by
// when, and how do I free up the gold?" math lives here. The dragon's
// analyze_affordability tool feeds it numbers and narrates the structured
// result, so Claude never spends credits doing the arithmetic by hand — one
// tool call replaces several data reads plus a chain of manual calculation.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ceil2  = (n) => Math.ceil((Number(n) || 0) * 100) / 100;

// Whole months from today until a YYYY-MM-DD target (min 0, null if unparseable).
export function monthsUntil(dateStr) {
  const target = new Date(dateStr);
  if (isNaN(target.getTime())) return null;
  const now = new Date();
  let m = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
  if (target.getDate() < now.getDate()) m -= 1; // not a full final month yet
  return Math.max(0, m);
}

// Add n whole months to today → "Month YYYY".
export function addMonthsLabel(n) {
  const d = new Date();
  d.setDate(1); // avoid month-end overflow (e.g. Jan 31 + 1mo)
  d.setMonth(d.getMonth() + Math.max(0, Math.ceil(n || 0)));
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Format a YYYY-MM-DD target date as "Month YYYY" for human-readable display.
function fmtTargetDate(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

const fmtMoney = (n) => {
  const v = Math.abs(round2(n));
  return (n < 0 ? '-' : '') + '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
};

// Assess a SAVED goal against the user's current cash flow — the "is this
// reachable, and what should I change?" analysis the Goals page shows per goal.
//
// goal: { target, saved, perMonth, targetDate, scope, status }
// cash: { monthlyIncome, monthlyOutflow, freeCashFlow }
// Returns { verdict, headline, projectedDate, requiredPerMonth, suggestions[] }.
export function assessGoal(goal, cash) {
  const target    = Math.max(0, round2(goal.target));
  const saved     = Math.max(0, round2(goal.saved));
  const remaining = Math.max(0, round2(target - saved));
  const perMonth  = round2(goal.perMonth || 0);
  const freeCash  = round2(cash?.freeCashFlow ?? ((cash?.monthlyIncome || 0) - (cash?.monthlyOutflow || 0)));
  const suggestions = [];

  if (goal.status === 'done' || (target > 0 && saved >= target)) {
    return { verdict: 'reached', headline: 'Funded — this goal is reached. Enjoy the spoils. 🐉', projectedDate: null, requiredPerMonth: 0, suggestions: [] };
  }
  if (goal.status === 'paused') {
    return { verdict: 'stalled', headline: 'Paused — no progress until you resume contributions.', projectedDate: null, requiredPerMonth: perMonth, suggestions: ['Set it back to active and resume the monthly set-aside when you’re ready.'] };
  }

  const targetMonths        = goal.targetDate ? monthsUntil(goal.targetDate) : null;
  const monthsByContribution = perMonth > 0 ? Math.ceil(remaining / perMonth) : null;
  const projectedDate       = monthsByContribution != null ? addMonthsLabel(monthsByContribution) : null;
  const requiredPerMonth    = (targetMonths && targetMonths > 0) ? ceil2(remaining / targetMonths) : null;

  let verdict = 'on_track';
  let headline = '';

  if (perMonth <= 0) {
    verdict = 'stalled';
    headline = 'No monthly contribution set, so this goal isn’t moving yet.';
    if (freeCash > 0) suggestions.push(`You have about ${fmtMoney(freeCash)}/mo free — even ${fmtMoney(round2(freeCash * 0.3))}/mo would start the climb.`);
    else suggestions.push('Free up some monthly cash flow first (trim a discretionary bucket), then set a contribution.');
  } else {
    const overFree = perMonth > freeCash;
    if (targetMonths != null) {
      if (monthsByContribution <= targetMonths) {
        verdict = overFree ? 'at_risk' : 'on_track';
        headline = overFree
          ? `On pace for ${fmtTargetDate(goal.targetDate)}, but ${fmtMoney(perMonth)}/mo is above your ${fmtMoney(freeCash)}/mo of free cash flow — sustaining it will be the hard part.`
          : `On track — at ${fmtMoney(perMonth)}/mo you’ll reach it by ${projectedDate}, comfortably inside your ${fmtTargetDate(goal.targetDate)} target.`;
        if (overFree) {
          suggestions.push(`Trim about ${fmtMoney(round2(perMonth - freeCash))}/mo from discretionary spending so the pace is sustainable.`);
        } else if (freeCash - perMonth > perMonth * 0.5) {
          const faster = round2(Math.min(freeCash, perMonth * 1.5));
          suggestions.push(`You’ve got headroom — ${fmtMoney(faster)}/mo would finish it around ${addMonthsLabel(Math.ceil(remaining / faster))}.`);
        }
      } else {
        verdict = 'behind';
        headline = `Behind schedule — ${fmtMoney(perMonth)}/mo lands it around ${projectedDate}, past your ${fmtTargetDate(goal.targetDate)} target.`;
        if (requiredPerMonth != null) {
          if (requiredPerMonth > freeCash) {
            suggestions.push(`Hitting ${fmtTargetDate(goal.targetDate)} needs ${fmtMoney(requiredPerMonth)}/mo — more than your ${fmtMoney(freeCash)}/mo free cash flow, so either trim spending to free it up or move the date to ${projectedDate}.`);
          } else {
            suggestions.push(`Raise the contribution to ${fmtMoney(requiredPerMonth)}/mo to hit ${fmtTargetDate(goal.targetDate)}, or keep ${fmtMoney(perMonth)}/mo and move the target to ${projectedDate}.`);
          }
        }
      }
    } else {
      verdict = overFree ? 'at_risk' : 'on_track';
      headline = overFree
        ? `${fmtMoney(perMonth)}/mo is above your ${fmtMoney(freeCash)}/mo of free cash flow — reachable by ${projectedDate} only if you can keep that pace up.`
        : `On track — ${fmtMoney(perMonth)}/mo reaches the goal around ${projectedDate}.`;
      if (overFree) {
        const sustainable = Math.max(1, freeCash);
        suggestions.push(`Drop to about ${fmtMoney(freeCash)}/mo (finishing ${addMonthsLabel(Math.ceil(remaining / sustainable))}) or trim discretionary spending to support the faster pace.`);
      } else {
        suggestions.push('Add a target date to lock in a finish line — you have room to push faster if you want it sooner.');
      }
    }
  }

  return { verdict, headline, projectedDate, requiredPerMonth, suggestions };
}

// Build a savings/affordability plan.
//
// Inputs (all optional except goalAmount):
//   goalAmount          — total cost of the thing
//   alreadySaved        — already set aside toward it
//   months              — horizon in whole months (from a deadline)
//   monthlyContribution — a fixed amount they want to put in each month
//   monthlyIncome       — average monthly money in
//   monthlyOutflow      — average monthly committed money out
//   discretionary       — [{ category, allowance }] buckets that can be trimmed
//   scope               — 'personal' | 'business' (labelling only)
//
// Exactly one of `months` or `monthlyContribution` drives the schedule; if
// neither is given we recommend half of free cash flow (a conservative pace).
export function analyzeAffordability({
  goalAmount,
  alreadySaved = 0,
  months = null,
  monthlyContribution = null,
  monthlyIncome = 0,
  monthlyOutflow = 0,
  discretionary = [],
  scope = 'personal',
  paychecksPerMonth = 2,      // pay-schedule preference (per-paycheck figure)
  payLabel = 'biweekly',
  paceFraction = 0.5,         // default pace when no deadline/contribution given
} = {}) {
  const goal      = Math.max(0, round2(goalAmount));
  const saved     = Math.max(0, round2(alreadySaved));
  const remaining = Math.max(0, round2(goal - saved));
  const income    = round2(monthlyIncome);
  const outflow   = round2(monthlyOutflow);
  const freeCash  = round2(income - outflow);

  const result = {
    scope, goal, saved, remaining,
    monthlyIncome: income, monthlyOutflow: outflow, freeCashFlow: freeCash,
  };

  if (remaining === 0) {
    return { ...result, feasibility: 'comfortable', perMonth: 0, monthsNeeded: 0,
      summary: 'Already fully funded — the hoard covers this goal.' };
  }

  // ── Schedule ────────────────────────────────────────────────────────────
  let perMonth, horizon, projectedLabel;
  if (months != null && months > 0) {
    horizon        = Math.ceil(months);
    perMonth       = ceil2(remaining / horizon);
    projectedLabel = addMonthsLabel(horizon);
  } else if (monthlyContribution != null && monthlyContribution > 0) {
    perMonth       = round2(monthlyContribution);
    horizon        = Math.ceil(remaining / perMonth);
    projectedLabel = addMonthsLabel(horizon);
  } else {
    // No deadline, no target contribution → pace at the user's preferred fraction
    // of free cash flow (conservative/balanced/aggressive).
    const rec      = freeCash > 0 ? round2(freeCash * paceFraction) : 0;
    perMonth       = rec;
    horizon        = rec > 0 ? Math.ceil(remaining / rec) : null;
    projectedLabel = rec > 0 ? addMonthsLabel(horizon) : null;
    result.recommendedPace = true;
  }

  result.perMonth      = perMonth;
  result.perPaycheck   = perMonth ? round2(perMonth / (paychecksPerMonth || 2)) : null;
  result.payLabel      = payLabel;
  result.monthsNeeded  = horizon;
  result.projectedDate = projectedLabel;

  // ── Feasibility vs. free cash flow ──────────────────────────────────────
  const shortfall = perMonth != null ? round2(Math.max(0, perMonth - freeCash)) : 0;
  result.monthlyShortfall = shortfall;

  // Close any shortfall from discretionary buckets, biggest first, never more
  // than 40% of a single bucket (so no category gets gutted).
  if (shortfall > 0 && discretionary.length) {
    const ranked = discretionary
      .map(d => ({ category: d.category, allowance: round2(d.allowance) }))
      .filter(d => d.allowance > 0)
      .sort((a, b) => b.allowance - a.allowance);
    let need = shortfall;
    const trims = [];
    for (const d of ranked) {
      if (need <= 0) break;
      const maxTrim = round2(d.allowance * 0.4);
      const take    = round2(Math.min(maxTrim, need));
      if (take <= 0) continue;
      trims.push({ category: d.category, from: d.allowance, trim: take, to: round2(d.allowance - take) });
      need = round2(need - take);
    }
    result.trimPlan   = trims;
    result.trimCovers = round2(shortfall - Math.max(0, need));
    result.stillShort = round2(Math.max(0, need));
  } else {
    result.stillShort = shortfall; // no buckets to trim → whole shortfall remains
  }

  // ── Milestones (25 / 50 / 75 / 100%) ────────────────────────────────────
  if (perMonth > 0 && horizon) {
    result.milestones = [0.25, 0.5, 0.75, 1].map(p => ({
      pct: p * 100,
      amount: round2(goal * p),
      by: addMonthsLabel(Math.ceil(horizon * p)),
    }));
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  if (!perMonth) {
    result.feasibility = 'infeasible';
    result.summary = 'No free cash flow yet — committed costs use up the income. Trim fixed costs or raise income first.';
  } else if (shortfall === 0) {
    result.feasibility = perMonth <= freeCash * 0.5 ? 'comfortable' : 'tight';
    result.summary = `Set aside ${perMonth}/mo${horizon ? ` for ~${horizon} month(s)` : ''} — fits within your free cash flow.`;
  } else if (result.stillShort > 0) {
    result.feasibility = 'infeasible';
    result.summary = `Needs ${perMonth}/mo but only ${freeCash}/mo is free; trims close ${result.trimCovers || 0} of the ${shortfall} gap, still ${result.stillShort} short. Extend the deadline or raise income.`;
  } else {
    result.feasibility = 'needs_trims';
    result.summary = `Doable at ${perMonth}/mo if you trim ~${shortfall}/mo from discretionary buckets (see trimPlan).`;
  }

  return result;
}
