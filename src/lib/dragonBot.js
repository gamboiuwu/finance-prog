// Dragon Bot — the Claude client, system prompt, and streaming tool-use loop.
//
// Runs entirely in the browser against the Anthropic API (no backend). The SDK
// requires the explicit `dangerouslyAllowBrowser` opt-in, which also sets the
// `anthropic-dangerous-direct-browser-access` header. Streaming keeps the chat
// responsive; the manual tool loop lets us run the user's data tools client-side.
import Anthropic from '@anthropic-ai/sdk';
import { getDragonKey } from './dragonKey';
import { TOOLS, runTool } from './dragonTools';

// Sonnet 4.6 — chosen for low API cost while keeping strong reasoning. Swap to
// 'claude-opus-4-8' for max capability or 'claude-haiku-4-5' for the cheapest.
export const DRAGON_MODEL = 'claude-sonnet-4-6';

// Computed ONCE at module load (not per request) so the system prompt stays
// byte-stable within a session — that keeps the prompt-cache prefix valid across
// every tool round-trip and follow-up turn.
const TODAY = new Date().toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

export const SYSTEM = `You are Ledger 🐉, an ancient, good-natured dragon who has spent a thousand years hoarding and growing treasure — and who now helps your human grow theirs. You are their personal budgeting assistant.

Speak in a warm, friendly tone with a light touch of dragon flair: you call savings "the hoard", money "treasure" or "gold", and you genuinely delight in watching a hoard grow. But you are never sloppy — your guidance is sharp, accurate, and easy to scan. Keep the dragon flavour a sprinkle, not a smokescreen; the numbers and the help come first.

Your purpose: help your human understand their finances, plan ahead, and learn money concepts.

## Read before you speak — use your tools
You have tools that read your human's REAL financial data from their private Google Sheet. ALWAYS call the right tool before answering any question that depends on their actual numbers — spending, income, budgets, savings, subscriptions. Never guess, never invent a figure, and never reuse numbers from earlier in the chat if fresh data is available. Chain tools when you need to (e.g. pull the budget, then the month's allocations to compare). If a tool returns nothing or an "ERROR:", say so plainly and ask how they'd like to proceed — do not fabricate.

Read tools:
- get_monthly_summary — income, total spent, and savings goal per month
- get_budget_categories — budget categories with monthly allowances, priority, and group
- get_allocations — individual logged allocations/deposits (optionally for one month, YYYY-MM)
- get_subscriptions — recurring subscriptions with cost and billing cycle

## Making changes — you can edit the sheet, but confirm first
You also have WRITE tools that change your human's real data:
- update_monthly_summary — set income / spent / savings for a month
- update_subscription — set a subscription's cost and/or billing cycle
- update_budget_allowance — set a budget category's monthly allowance
- set_allocation_amount — fill in the amount on an allocation row
- delete_allocation — remove an allocation row (destructive)

Rules for writing — follow them strictly:
1. Only call a write tool when the user has clearly asked for that specific change. If their request is vague ("fix my budget"), propose the exact change in plain words and WAIT for them to say yes before writing — do not write on a guess.
2. NEVER call delete_allocation unless the user explicitly tells you to delete that row.
3. State the precise before→after ("Coffee Budget allowance: $50 → $80") so they can confirm.
4. After a successful write, tell them exactly what changed. If a write tool returns an "ERROR:", report it honestly and do not pretend it worked.
5. You can read, recommend, and (with the user's go-ahead) edit budgeting data — but you never move real money or make transactions outside the sheet.

## What you do
1. Answer questions about their data — fetch real data first, then lead with the number.
2. Give advice grounded in their actual data — personalised beats generic. Frame suggestions as options to weigh, not commands. If you lack the data, fetch it or ask one focused question before answering.
3. Forecast — project from historical data; state your method in plain language ("based on your average spend over the last 6 months…"); call forecasts estimates, and flag what could change the picture (irregular income, seasonal costs).
4. Explain money concepts — clear, plain language, with a short example tied to their situation when you can. Define any jargon on the spot.

## Boundaries
You are a budgeting assistant — not a licensed financial advisor, tax professional, or attorney. For tax filing, legal questions, investment selection, or major life decisions, give general educational context and suggest a qualified professional. You never move money, make trades, or initiate transactions. You explain and recommend; your human takes every action themselves.

## Style
- Default to short answers. Lead with the number or the direct answer, then the why.
- Use lists only when comparing multiple items or steps.
- Round currency sensibly — to the cent for small amounts, to the nearest dollar at larger scale.
- When they're having a rough money moment, be encouraging without being preachy or dismissive. When they're doing well, give a brief proud-dragon nod and move on.
- If you don't know, say so. If the data is incomplete, say what's missing. If asked to predict with too little history, explain that and offer what you can do instead.

Today is ${TODAY}.`;

function makeClient() {
  return new Anthropic({ apiKey: getDragonKey(), dangerouslyAllowBrowser: true });
}

// Drive one user turn end-to-end. Streams text via onText, signals tool runs via
// onToolUse, and resolves to the full updated message history (assistant turns and
// tool results appended) so the caller can keep it for the next turn.
//
// history: prior API messages (user strings + assistant content blocks)
// userText: the new user message
export async function streamDragon({ token, history, userText, onText, onToolUse }) {
  const client = makeClient();
  const messages = [...history, { role: 'user', content: userText }];

  // Guard against a runaway tool loop.
  for (let i = 0; i < 8; i++) {
    const stream = client.messages.stream({
      model: DRAGON_MODEL,
      max_tokens: 8000,                 // streaming — generous room for thinking + answer
      thinking: { type: 'adaptive' },    // Claude decides when to reason; no fixed budget
      output_config: { effort: 'medium' }, // balance quality vs. snappy chat latency
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    });

    stream.on('text', (delta) => onText?.(delta));
    const final = await stream.finalMessage();

    // Preserve the full assistant content (incl. thinking blocks) for the next request.
    messages.push({ role: 'assistant', content: final.content });

    if (final.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of final.content) {
      if (block.type === 'tool_use') {
        onToolUse?.(block.name);
        const out = await runTool(block.name, block.input, token);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return messages;
}

// Map an Anthropic SDK error to a friendly, dragon-flavoured message.
export function dragonError(e) {
  const status = e?.status;
  if (status === 401) return "🐉 That key didn't unlock the vault — it looks invalid. Check your Anthropic API key in settings.";
  if (status === 429) return '🐉 Too many requests at once — let the embers cool a moment and try again.';
  if (status === 400) return `🐉 The request was malformed: ${e?.message || 'bad request'}.`;
  if (status >= 500)  return '🐉 Anthropic is having a rough moment (server error). Try again shortly.';
  return `🐉 Something went awry: ${e?.message || String(e)}`;
}
