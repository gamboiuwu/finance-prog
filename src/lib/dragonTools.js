// Tool definitions + executors for the Dragon Bot.
//
// These are CLIENT-SIDE custom tools: Claude emits a tool_use block, our loop
// (dragonBot.js) runs the matching function here against the user's private
// Google Sheet, and feeds the result back. Nothing executes on Anthropic's side.
import { readRange } from './sheets';
import { SHEETS } from '../config';

const SUBSCRIPTIONS_SHEET = 'Subscriptions';

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
      default:
        return `ERROR: unknown tool "${name}".`;
    }
  } catch (e) {
    return `ERROR: could not read the sheet (${e.message}). The data may be unavailable or the session may need to be re-authorised.`;
  }
}
