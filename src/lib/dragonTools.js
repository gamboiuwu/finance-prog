// Tool definitions + executors for the Dragon Bot.
//
// These are CLIENT-SIDE custom tools: Claude emits a tool_use block, our loop
// (dragonBot.js) runs the matching function here against the user's private
// Google Sheet, and feeds the result back. Nothing executes on Anthropic's side.
import { readRange } from './sheets';
import { SHEETS } from '../config';
import {
  recalcMonthlySummary, updateSubscription, updateBudgetAllowance,
  setAllocationAmount, deleteAllocation,
  readPlans, savePlan, updatePlanProgress, deletePlan, applyPlanToBudget,
} from './sheetWrite';
import { analyzeAffordability, monthsUntil } from './dragonPlan';

const SUBSCRIPTIONS_SHEET = 'Subscriptions';
const BUSINESS_TRANSACTIONS_SHEET = 'Business Transactions';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const toNum  = (v) => parseFloat(String(v ?? '').replace(/[$,]/g, '')) || 0;

// Find a column index whose header contains any needle (lowercased). -1 if none.
function colIdx(headers, ...needles) {
  const lower = (headers || []).map(h => String(h ?? '').toLowerCase());
  for (const n of needles) {
    const i = lower.findIndex(h => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

// Derive personal cash flow: average recent income, total committed allowances,
// and the discretionary buckets that can be trimmed to fund a goal.
async function derivePersonalCashflow(token) {
  let monthlyIncome = 0;
  const sum = await readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A:Z`, 'UNFORMATTED_VALUE').catch(() => []);
  if (sum.length > 1) {
    const ic = colIdx(sum[0], 'income');
    const vals = sum.slice(1).map(r => toNum(r[ic >= 0 ? ic : 1])).filter(v => v > 0).slice(-6);
    if (vals.length) monthlyIncome = vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  let monthlyOutflow = 0;
  const discretionary = [];
  const bud = await readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A:Z`, 'UNFORMATTED_VALUE').catch(() => []);
  if (bud.length > 1) {
    const tc = colIdx(bud[0], 'type');
    const ac = colIdx(bud[0], 'allowance', 'monthly');
    const gc = colIdx(bud[0], 'expense', 'group', 'category');
    for (const r of bud.slice(1)) {
      const allow = toNum(r[ac >= 0 ? ac : 0]);
      if (!allow) continue;
      monthlyOutflow += allow;
      if (String(r[gc] ?? '').toLowerCase().includes('discretion')) {
        discretionary.push({ category: String(r[tc >= 0 ? tc : 0] || '').trim(), allowance: allow });
      }
    }
  }
  return { monthlyIncome: round2(monthlyIncome), monthlyOutflow: round2(monthlyOutflow), discretionary };
}

// Derive business cash flow: average monthly revenue (Business Transactions) vs
// average monthly spend (Business Expenses).
async function deriveBusinessCashflow(token) {
  const byMonth = (rows, dateCol, amtCol) => {
    const m = {};
    for (const r of rows.slice(1)) {
      const k = monthKey(r[dateCol]);
      if (!k) continue;
      m[k] = (m[k] || 0) + toNum(r[amtCol]);
    }
    const v = Object.values(m);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };

  const tx = await readRange(token, `${BUSINESS_TRANSACTIONS_SHEET}!A:H`, 'UNFORMATTED_VALUE').catch(() => []);
  const ex = await readRange(token, `${SHEETS.BUSINESS_EXPENSES}!A:G`, 'UNFORMATTED_VALUE').catch(() => []);
  const monthlyIncome  = tx.length > 1 ? byMonth(tx, 0, 5) : 0; // Revenue = col F
  const monthlyOutflow = ex.length > 1 ? byMonth(ex, 0, 2) : 0; // Amount = col C
  return { monthlyIncome: round2(monthlyIncome), monthlyOutflow: round2(monthlyOutflow), discretionary: [] };
}

// Normalise a sheet date cell (serial number / YYYY-MM-DD / M/D/YYYY) to YYYY-MM.
// Mirrors the monthKey helper used elsewhere in the app so month filters line up.
function monthKey(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  const n = Number(v);
  if (!isNaN(n) && n > 1000 && !s.includes('-') && !s.includes('/')) {
    const d = new Date(Math.round((Math.floor(n) - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (s.includes('-')) return s.slice(0, 7);                 // YYYY-MM-DD
  if (s.includes('/')) { const p = s.split('/'); return `${p[2]}-${String(p[0]).padStart(2, '0')}`; } // M/D/YYYY
  return '';
}

// Compact {columns, rows} payload — far fewer tokens than an array of objects.
function pack(rows, limit) {
  if (!rows || !rows.length) return JSON.stringify({ columns: [], rows: [], note: 'No data found in this sheet.' });
  const [columns, ...data] = rows;
  const out = limit && data.length > limit ? data.slice(-limit) : data;
  const payload = { columns, rows: out };
  if (limit && data.length > limit) payload.note = `Showing the most recent ${limit} of ${data.length} rows.`;
  return JSON.stringify(payload);
}

// Tool schemas handed to Claude. Descriptions are written FOR the model — they
// are how it decides which hoard to inspect.
export const TOOLS = [
  {
    name: 'get_monthly_summary',
    description: "The user's month-by-month overview: income earned, total spent, and savings goal for each month. Use this for questions about income, overall spending, savings rate, or whether a month hit its goal.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_budget_categories',
    description: "The user's budget plan: each spending category (e.g. Rent, Groceries) with its monthly allowance, priority, account, and expense group (Essentials/Stability/Discretionary/Subscription). Use this to answer what their budget is, or to compare planned vs actual spending.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_allocations',
    description: "Individual money allocations / deposits the user logged: Date, Type (the category, e.g. Rent), Amount, Description, Account, and Done flag. Use this for 'how much did I spend/allocate on X', spending by category, or recent activity. Optionally filter to a single month.",
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: "Optional month filter in YYYY-MM form (e.g. '2026-05'). Omit to get all recent allocations." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_subscriptions',
    description: "The user's recurring subscriptions: Name, Cost, billing Cycle (monthly/annual/weekly/biweekly), Start Date, and Account. Use this for questions about recurring costs, subscription spend, or what they could cancel.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },

  // ── Write tools — see the "Making changes" rules in the system prompt ──
  {
    name: 'update_monthly_summary',
    description: "Set the income, spent, and/or savings figures for one month in Monthly Summary. Provide the month by name (e.g. 'May'). Only pass the fields you want to change. Confirm the exact numbers with the user before calling.",
    input_schema: {
      type: 'object',
      properties: {
        month:   { type: 'string', description: "Month name, e.g. 'May'." },
        income:  { type: 'number' },
        spent:   { type: 'number' },
        savings: { type: 'number' },
      },
      required: ['month'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_subscription',
    description: "Update a subscription's cost and/or billing cycle, matched by name (partial match ok, e.g. 'Claude'). Confirm the new values with the user first.",
    input_schema: {
      type: 'object',
      properties: {
        name:   { type: 'string', description: 'Subscription name to match.' },
        amount: { type: 'number', description: 'New cost.' },
        cycle:  { type: 'string', description: "Billing cycle: monthly / annual / weekly / biweekly." },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_budget_allowance',
    description: "Set a budget category's monthly allowance, matched by its Type name (e.g. 'Coffee Budget'). Confirm the new allowance with the user first.",
    input_schema: {
      type: 'object',
      properties: {
        type:              { type: 'string', description: 'Budget category Type/name.' },
        monthly_allowance: { type: 'number', description: 'New monthly allowance.' },
      },
      required: ['type', 'monthly_allowance'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_allocation_amount',
    description: "Fill in the Amount on a logged allocation row, located by month (YYYY-MM), category (Type), and account. Use this to repair rows that have a category and date but no amount.",
    input_schema: {
      type: 'object',
      properties: {
        month:    { type: 'string', description: 'YYYY-MM, e.g. 2026-05.' },
        category: { type: 'string', description: 'Allocation Type (e.g. Gas).' },
        account:  { type: 'string', description: 'Account (e.g. Cash).' },
        amount:   { type: 'number', description: 'Correct amount to set.' },
      },
      required: ['month', 'category', 'account', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_allocation',
    description: "DESTRUCTIVE: remove an allocation row, located by month (YYYY-MM), category, and account. Only call this when the user explicitly asks to delete that row.",
    input_schema: {
      type: 'object',
      properties: {
        month:    { type: 'string', description: 'YYYY-MM.' },
        category: { type: 'string' },
        account:  { type: 'string' },
      },
      required: ['month', 'category', 'account'],
      additionalProperties: false,
    },
  },

  // ── Planning tools — affording a goal (see "Planning" in the system prompt) ──
  {
    name: 'analyze_affordability',
    description: "Build a complete savings plan to afford a goal. Does ALL the math in one call: it reads the user's real income and committed costs and returns the monthly set-aside, per-paycheck amount, completion date, feasibility verdict, milestones, and — if money is tight — exactly which discretionary budget buckets to trim and by how much. ALWAYS use this for affordability/savings-goal questions; never compute the schedule yourself. Pass either `months` (a deadline) or `monthly_contribution` (a fixed amount they'll save); omit both to get a recommended pace.",
    input_schema: {
      type: 'object',
      properties: {
        goal_amount:         { type: 'number', description: 'Total cost of the thing to afford.' },
        already_saved:       { type: 'number', description: 'Amount already set aside toward it (default 0).' },
        months:              { type: 'number', description: 'Whole months until the deadline. Use this OR monthly_contribution.' },
        target_date:         { type: 'string', description: 'Deadline as YYYY-MM-DD (converted to months). Alternative to `months`.' },
        monthly_contribution:{ type: 'number', description: 'A fixed amount the user wants to save each month (computes the finish date instead).' },
        scope:               { type: 'string', description: "'personal' (default) or 'business' — business reads business revenue/expenses." },
        monthly_income:      { type: 'number', description: 'Override average monthly income instead of deriving it from the sheet.' },
        monthly_outflow:     { type: 'number', description: 'Override average monthly committed costs instead of deriving them.' },
      },
      required: ['goal_amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_plans',
    description: "List the user's saved savings/affordability plans: name, target, amount saved, monthly set-aside, target date, and status. Use this to check progress on a goal ('how's my laptop plan?').",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'save_plan',
    description: "Record a savings plan so it can be tracked later. Call after the user agrees to a plan from analyze_affordability. Pass `id` (an existing plan's id) to update it instead of creating a new one.",
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Short goal name, e.g. "New Laptop".' },
        target:      { type: 'number', description: 'Goal amount.' },
        saved:       { type: 'number', description: 'Amount already saved (default 0).' },
        per_month:   { type: 'number', description: 'Planned monthly set-aside.' },
        target_date: { type: 'string', description: 'Target finish, e.g. "December 2026" or YYYY-MM-DD.' },
        scope:       { type: 'string', description: "'personal' or 'business'." },
        funding:     {
          type: 'array',
          description: 'Optional list of budget trims that fund this plan.',
          items: {
            type: 'object',
            properties: { category: { type: 'string' }, amount: { type: 'number' } },
            additionalProperties: false,
          },
        },
        notes:       { type: 'string' },
        id:          { type: 'string', description: 'Existing plan id to update; omit to create new.' },
      },
      required: ['name', 'target'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_plan_progress',
    description: "Update a saved plan: log a contribution (add_amount), set the saved total directly (set_saved), and/or change status. Match the plan by id or by a word from its name.",
    input_schema: {
      type: 'object',
      properties: {
        id:         { type: 'string', description: 'Plan id, or a word from its name (e.g. "laptop").' },
        add_amount: { type: 'number', description: 'Amount just set aside — added to the running total.' },
        set_saved:  { type: 'number', description: 'Set the saved total to this exact figure.' },
        status:     { type: 'string', description: "active / paused / done." },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_plan',
    description: "Remove a saved plan, matched by id or a word from its name. Only call when the user asks to delete/cancel a plan.",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Plan id or a word from its name.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_plan_to_budget',
    description: "Reprogram the budget to fund a plan by setting several category allowances at once. Each change is a before→after on a real budget category. Confirm every change with the user first (state each before→after), exactly like any other write.",
    input_schema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          description: 'Budget allowance changes to apply.',
          items: {
            type: 'object',
            properties: {
              type:              { type: 'string', description: 'Budget category Type/name.' },
              monthly_allowance: { type: 'number', description: 'New monthly allowance.' },
            },
            required: ['type', 'monthly_allowance'],
            additionalProperties: false,
          },
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
  },
];

// Execute one tool call. Always resolves to a string; on failure returns an
// "ERROR:" string so Claude can tell the user plainly instead of inventing data.
export async function runTool(name, input, token) {
  try {
    switch (name) {
      case 'get_monthly_summary': {
        const rows = await readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A:Z`);
        return pack(rows);
      }
      case 'get_budget_categories': {
        const rows = await readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A:Z`);
        return pack(rows);
      }
      case 'get_allocations': {
        const rows = await readRange(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A:F`);
        if (!rows.length) return pack(rows);
        const [columns, ...data] = rows;
        const month = input?.month;
        const filtered = month ? data.filter(r => monthKey(r[0]) === month) : data;
        return pack([columns, ...filtered], 500);
      }
      case 'get_subscriptions': {
        const rows = await readRange(token, `${SUBSCRIPTIONS_SHEET}!A:E`);
        return pack(rows);
      }

      // ── Write tools ──
      case 'update_monthly_summary': {
        const n = await recalcMonthlySummary(token, {
          monthName: input.month, income: input.income, spent: input.spent, savings: input.savings,
        });
        return `OK: updated ${n} field(s) on the ${input.month} summary row.`;
      }
      case 'update_subscription': {
        const matched = await updateSubscription(token, { name: input.name, amount: input.amount, cycle: input.cycle });
        return `OK: updated subscription "${matched}".`;
      }
      case 'update_budget_allowance': {
        const matched = await updateBudgetAllowance(token, { type: input.type, monthlyAllowance: input.monthly_allowance });
        return `OK: set "${matched}" monthly allowance to ${input.monthly_allowance}.`;
      }
      case 'set_allocation_amount': {
        const row = await setAllocationAmount(token, { month: input.month, category: input.category, account: input.account, amount: input.amount });
        return `OK: set amount ${input.amount} on the ${input.category}/${input.account} allocation (row ${row}).`;
      }
      case 'delete_allocation': {
        const row = await deleteAllocation(token, { month: input.month, category: input.category, account: input.account });
        return `OK: deleted the ${input.category}/${input.account} allocation (row ${row}).`;
      }

      // ── Planning tools ──
      case 'analyze_affordability': {
        const scope = input.scope === 'business' ? 'business' : 'personal';
        // Derive real cash flow unless the caller passed both overrides.
        let ctx;
        if (input.monthly_income != null && input.monthly_outflow != null) {
          ctx = { monthlyIncome: input.monthly_income, monthlyOutflow: input.monthly_outflow, discretionary: [] };
        } else {
          ctx = scope === 'business' ? await deriveBusinessCashflow(token) : await derivePersonalCashflow(token);
          if (input.monthly_income  != null) ctx.monthlyIncome  = input.monthly_income;
          if (input.monthly_outflow != null) ctx.monthlyOutflow = input.monthly_outflow;
        }
        let months = input.months ?? null;
        if (months == null && input.target_date) {
          const m = monthsUntil(input.target_date);
          if (m != null) months = m;
        }
        const plan = analyzeAffordability({
          goalAmount:          input.goal_amount,
          alreadySaved:        input.already_saved ?? 0,
          months,
          monthlyContribution: input.monthly_contribution ?? null,
          monthlyIncome:       ctx.monthlyIncome,
          monthlyOutflow:      ctx.monthlyOutflow,
          discretionary:       ctx.discretionary,
          scope,
        });
        return JSON.stringify(plan);
      }
      case 'get_plans': {
        const rows = await readPlans(token);
        return pack(rows);
      }
      case 'save_plan': {
        const id = await savePlan(token, {
          id:         input.id,
          name:       input.name,
          scope:      input.scope,
          target:     input.target,
          saved:      input.saved,
          perMonth:   input.per_month,
          targetDate: input.target_date,
          funding:    input.funding,
          notes:      input.notes,
        });
        return `OK: saved plan "${input.name}" (id ${id}).`;
      }
      case 'update_plan_progress': {
        const res = await updatePlanProgress(token, {
          id: input.id, addAmount: input.add_amount, setSaved: input.set_saved, status: input.status,
        });
        return `OK: "${res.name}" now has ${res.saved} saved${input.status ? ` · status ${input.status}` : ''}.`;
      }
      case 'delete_plan': {
        const nm = await deletePlan(token, { id: input.id });
        return `OK: deleted plan "${nm}".`;
      }
      case 'apply_plan_to_budget': {
        const applied = await applyPlanToBudget(token, input.changes || []);
        return `OK: reprogrammed ${applied.length} budget categor${applied.length === 1 ? 'y' : 'ies'} — ${applied.join('; ')}.`;
      }

      default:
        return `ERROR: unknown tool "${name}".`;
    }
  } catch (e) {
    return `ERROR: could not read the sheet (${e.message}). The data may be unavailable or the session may need to be re-authorised.`;
  }
}
