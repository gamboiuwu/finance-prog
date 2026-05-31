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
import {
  monthKey, derivePersonalCashflow, deriveBusinessCashflow,
  computeOverview, overviewSummary,
} from './dragonOverview';
import { PAY_SCHEDULES, PACES } from './dragonPrefs';

const SUBSCRIPTIONS_SHEET = 'Subscriptions';

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

  // ── Visual tools — render rich "windows" in the chat (see "Showing things") ──
  {
    name: 'show_financial_overview',
    description: "Render a rich visual financial overview WINDOW in the chat — income vs spending, savings rate, free cash flow, budget by priority group, top categories, subscriptions, and a business snapshot (revenue, expenses, net, margin, 6-month trend, top vendors). It computes every number exactly from the sheets. Use this whenever the user wants to SEE their finances, a dashboard, a full picture, 'how am I doing', or how their business is doing. After it renders, add a short spoken takeaway — do not re-list every number, the window already shows them.",
    input_schema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: "'all' (default), 'personal', or 'business'." },
      },
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
        goal_name:           { type: 'string', description: 'Short name of the goal (e.g. "New Laptop") — shown as the plan window title.' },
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
export async function runTool(name, input, token, prefs = {}) {
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

      // ── Visual tools ──
      case 'show_financial_overview': {
        const focus = ['personal', 'business'].includes(input.focus) ? input.focus : 'all';
        const ov = await computeOverview(token, focus);
        return { content: overviewSummary(ov), card: { type: 'overview', data: ov } };
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
        const sched = PAY_SCHEDULES[prefs.paySchedule] || PAY_SCHEDULES.biweekly;
        const pace  = PACES[prefs.pace] || PACES.balanced;
        const plan = analyzeAffordability({
          goalAmount:          input.goal_amount,
          alreadySaved:        input.already_saved ?? 0,
          months,
          monthlyContribution: input.monthly_contribution ?? null,
          monthlyIncome:       ctx.monthlyIncome,
          monthlyOutflow:      ctx.monthlyOutflow,
          discretionary:       ctx.discretionary,
          scope,
          paychecksPerMonth:   sched.perMonth,
          payLabel:            sched.label.toLowerCase(),
          paceFraction:        pace.fraction,
        });
        plan.goalName = input.goal_name || null;
        return { content: JSON.stringify(plan), card: { type: 'plan', data: plan } };
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
