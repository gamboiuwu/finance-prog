import { useState, useRef, useEffect, useCallback } from 'react';
import { streamDragon, dragonError } from '../lib/dragonBot';
import {
  getDragonKey, setDragonKeyWithSync, clearDragonKeyWithSync,
  hasDragonKey, syncKeyFromSheet,
} from '../lib/dragonKey';
import DragonAvatar from '../components/DragonAvatar';
import DragonCard from '../components/DragonCards';
import { getPrefs, setPrefs, MODELS, PAY_SCHEDULES, PACES, TONES } from '../lib/dragonPrefs';

// ── Monthly usage tracking ───────────────────────────────────────────────────
// Anthropic pricing (per million tokens, as of 2025). claude-sonnet-4-6 rates
// used as a conservative fallback; all figures are estimates.
const TOKEN_PRICING = {
  'claude-haiku-4-5-20251001': { in: 0.80,  out: 4.00  },
  'claude-sonnet-4-6':         { in: 3.00,  out: 15.00 },
  'claude-opus-4-8':           { in: 15.00, out: 75.00 },
};
const USAGE_KEY = '_fin_dragon_usage';

function getUsageStore() {
  try { return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); } catch { return {}; }
}
function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function recordUsage(model, inputTokens, outputTokens) {
  const store = getUsageStore();
  const mk = monthKey();
  const prior = store[mk] || { inputTokens: 0, outputTokens: 0, cost: 0 };
  const pricing = TOKEN_PRICING[model] || TOKEN_PRICING['claude-sonnet-4-6'];
  const addedCost = (inputTokens / 1_000_000) * pricing.in + (outputTokens / 1_000_000) * pricing.out;
  store[mk] = {
    inputTokens:  prior.inputTokens  + inputTokens,
    outputTokens: prior.outputTokens + outputTokens,
    cost:         prior.cost         + addedCost,
  };
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(store)); } catch { /* quota */ }
}
function getThisMonthUsage() {
  return getUsageStore()[monthKey()] || null;
}

const TOOL_LABELS = {
  get_monthly_summary:  'peering at your monthly hoard…',
  get_budget_categories:'unrolling your budget scroll…',
  get_allocations:      'counting your gold coins…',
  get_subscriptions:    'sniffing out recurring tithes…',
  get_plans:            'reviewing your treasure plans…',
  analyze_affordability:'charting a path to your treasure…',
  save_plan:            'etching your plan into stone…',
  update_plan_progress: 'updating your quest log…',
  delete_plan:          'retiring an old plan…',
  apply_plan_to_budget: 'reforging your budget…',
  show_financial_overview: 'painting your treasure map…',
  web_search:           'scouring the web for current prices…',
};

const SUGGESTIONS = [
  'Show me my full financial overview 📊',
  'Help me plan to afford something 🐉',
  'How is my business doing? 💼',
  'Where can I trim my spending?',
];

// Tiny markdown-ish renderer: **bold**, and -/• bullet lines. Keeps replies
// readable without pulling in a markdown dependency.
function renderRich(text) {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    const bullet = /^\s*[-•]\s+/.test(line);
    const content = bullet ? line.replace(/^\s*[-•]\s+/, '') : line;
    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**')
        ? <strong key={j} className="font-semibold text-white">{p.slice(2, -2)}</strong>
        : <span key={j}>{p}</span>
    );
    if (bullet) return <li key={i} className="ml-4 list-disc">{parts}</li>;
    if (line.trim() === '') return <div key={i} className="h-2" />;
    return <p key={i}>{parts}</p>;
  });
}

// ── Preferences controls ─────────────────────────────────────────────────────
function Field({ label, desc, children }) {
  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-slate-200 text-sm font-medium">{label}</p>
        {desc && <p className="text-slate-500 text-[11px] leading-snug">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function Segmented({ value, onChange, options, cols = 3 }) {
  return (
    <div className={`grid gap-1.5`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`rounded-lg px-2 py-2 text-center transition-colors ${
            value === o.key ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-700'
          }`}
        >
          <span className="block text-xs font-semibold leading-tight">{o.label}</span>
          {o.hint && <span className="block text-[9px] opacity-70 mt-0.5 leading-tight">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-12 h-7 rounded-full p-0.5 transition-colors shrink-0 ${on ? 'bg-emerald-600' : 'bg-slate-700'}`}
      role="switch"
      aria-checked={on}
    >
      <span className={`block w-6 h-6 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

const opts = (map) => Object.entries(map).map(([key, v]) => ({ key, label: v.label, hint: v.hint }));

function PrefsPanel() {
  const [p, setP] = useState(getPrefs);
  const update = (patch) => setP(setPrefs(patch));
  return (
    <div className="bg-slate-800 rounded-2xl p-4 space-y-5">
      <p className="text-white font-bold text-sm font-broske">⚙ Ledger Preferences</p>

      <Field label="🧠 Brain" desc="Smarter models cost more per message.">
        <Segmented cols={3} value={p.model} onChange={m => update({ model: m })} options={opts(MODELS)} />
      </Field>

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-slate-200 text-sm font-medium">🌐 Web research</p>
          <p className="text-slate-500 text-[11px] leading-snug">Let Ledger search the internet for live prices &amp; rates when planning. Uses extra credits.</p>
        </div>
        <Toggle on={p.webResearch} onClick={() => update({ webResearch: !p.webResearch })} />
      </div>

      <Field label="🎭 Tone" desc="How much dragon flair in replies.">
        <Segmented cols={3} value={p.tone} onChange={t => update({ tone: t })} options={opts(TONES)} />
      </Field>

      <Field label="📅 Pay schedule" desc="Used for the per-paycheck planning figure.">
        <Segmented cols={4} value={p.paySchedule} onChange={s => update({ paySchedule: s })} options={opts(PAY_SCHEDULES)} />
      </Field>

      <Field label="🔥 Savings pace" desc="How hard to save when a goal has no deadline.">
        <Segmented cols={3} value={p.pace} onChange={s => update({ pace: s })} options={opts(PACES)} />
      </Field>
    </div>
  );
}

// ── API-key setup / settings screen ─────────────────────────────────────────
// Issue 4 fix: wrapper is scrollable and height-constrained so the bottom button
// is always reachable on any screen size. Inner content max-width is capped and
// centred.
function KeySetup({ token, onSaved, onCancel, hasExisting, showPrefs }) {
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const trimmed = val.trim();
    if (!trimmed) return;
    setSaving(true);
    await setDragonKeyWithSync(trimmed, token);  // Issue 0: write to sheet
    setSaving(false);
    onSaved();
  }

  async function handleClear() {
    setSaving(true);
    await clearDragonKeyWithSync(token);          // Issue 0: wipe sheet cell
    setSaving(false);
    onSaved();
  }

  const usage = getThisMonthUsage();

  return (
    // Issue 4: full-height scrollable container so nothing goes off-screen
    <div className="h-[calc(100dvh-120px)] overflow-y-auto">
      <div className="px-4 py-6 max-w-md mx-auto space-y-5">
        <div className="text-center space-y-2">
          <div className="flex justify-center"><DragonAvatar mood="sleep" size={80} /></div>
          <h2 className="text-white font-bold text-xl font-broske">Wake the Dragon</h2>
          <p className="text-slate-400 text-sm leading-relaxed">
            Ledger runs on your own Anthropic API key. Paste it below — it's saved to
            your private Google Sheet so it syncs across devices. It's sent straight to
            Anthropic and never committed anywhere.
          </p>
        </div>

        <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
          <label className="text-slate-400 text-xs uppercase tracking-wider block">Anthropic API Key</label>
          <input
            type="password"
            value={val}
            onChange={e => setVal(e.target.value)}
            placeholder="sk-ant-..."
            autoComplete="off"
            className="w-full bg-slate-900 text-white rounded-xl px-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600"
          />
          <button
            onClick={handleSave}
            disabled={!val.trim() || saving}
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm transition-colors"
          >
            {saving ? 'Saving…' : '🔥 Light the Fire'}
          </button>
          {hasExisting && (
            <button
              onClick={handleClear}
              disabled={saving}
              className="w-full py-2.5 rounded-xl bg-slate-700 hover:bg-rose-900/40 text-rose-300 font-medium text-xs transition-colors disabled:opacity-50"
            >
              Remove saved key
            </button>
          )}
          {onCancel && (
            <button onClick={onCancel} className="w-full py-2 text-slate-500 hover:text-slate-300 text-xs transition-colors">
              Cancel
            </button>
          )}
        </div>

        {/* Issue 3: monthly usage summary shown on the settings page */}
        {usage && (
          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-3 space-y-1.5">
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider">This month's usage (estimate)</p>
            <div className="flex gap-3 flex-wrap">
              <span className="text-slate-300 text-xs">
                <span className="text-white font-bold">${usage.cost.toFixed(4)}</span> spent
              </span>
              <span className="text-slate-500 text-xs">
                {(usage.inputTokens / 1000).toFixed(1)}k in · {(usage.outputTokens / 1000).toFixed(1)}k out
              </span>
            </div>
            <p className="text-slate-600 text-[10px] leading-snug">
              Estimate based on published Anthropic list prices. Actual charges may differ (caching, promotions, etc.).
            </p>
          </div>
        )}

        {showPrefs && <PrefsPanel />}

        <div className="bg-amber-900/20 border border-amber-800/40 rounded-xl p-3 text-amber-300/90 text-xs leading-relaxed">
          <p className="font-semibold mb-1">🔑 Where do I get a key?</p>
          <p>Create one at <span className="text-amber-200">console.anthropic.com</span> → API Keys.
          Tip: set a low monthly spend limit on the key.</p>
        </div>
      </div>
    </div>
  );
}

// ── Main chat ────────────────────────────────────────────────────────────────
export default function DragonBot({ token }) {
  const [keyReady, setKeyReady] = useState(hasDragonKey);
  const [showSettings, setShowSettings] = useState(false);
  const [messages, setMessages] = useState([]);          // display: {role:'user'|'dragon', text}
  const [streaming, setStreaming] = useState('');        // current partial dragon reply
  const [toolLabel, setToolLabel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');

  // Issue 2: per-message web-research prompt state
  // null = not shown, 'pending' = waiting for user choice, 'yes'|'no' = resolved
  const [webResearchPrompt, setWebResearchPrompt] = useState(null);
  const pendingTextRef = useRef(null);   // the message waiting on the web-research decision

  const apiHistory = useRef([]);                          // full Anthropic message history
  const scrollRef = useRef(null);

  // Issue 0: on mount, sync key from the sheet (non-blocking, best-effort)
  useEffect(() => {
    if (token && !hasDragonKey()) {
      syncKeyFromSheet(token).then(found => {
        if (found) setKeyReady(true);
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  useEffect(scrollToEnd, [messages, streaming, toolLabel, scrollToEnd]);

  // Derive avatar mood from current state
  const [hasError, setHasError] = useState(false);
  const avatarMood = hasError ? 'error'
    : streaming ? 'talking'
    : busy      ? 'thinking'
    : messages.length === 0 ? 'idle'
    : 'happy';

  // Issue 2: decide whether to prompt the user about web research for this message.
  // We ask when: the global pref is OFF (not already on), and the message text looks
  // like it could benefit from live prices/rates (simple heuristic).
  function mightBenefitFromWebResearch(text) {
    const lower = text.toLowerCase();
    return /price|cost|rate|afford|current|today|average|how much|market|interest|inflation|worth/.test(lower);
  }

  async function send(text, webOverride) {
    const trimmed = (text ?? input).trim();
    if (!trimmed || busy) return;

    const prefs = getPrefs();

    // Issue 2: if web research is OFF globally and this message might benefit from it,
    // pause and ask — but only once per conversation per message.
    if (webOverride === undefined && !prefs.webResearch && mightBenefitFromWebResearch(trimmed)) {
      pendingTextRef.current = trimmed;
      setInput('');
      setWebResearchPrompt('pending');
      return;
    }

    setInput('');
    setWebResearchPrompt(null);
    pendingTextRef.current = null;
    setHasError(false);
    setMessages(m => [...m, { role: 'user', text: trimmed }]);
    setBusy(true);
    setStreaming('');
    setToolLabel(null);

    let acc = '';
    const cards = [];
    try {
      const updated = await streamDragon({
        token,
        history: apiHistory.current,
        userText: trimmed,
        // Issue 2: pass a one-shot override so the pref is respected for this message
        webResearchOverride: webOverride,
        onText: (delta) => { acc += delta; setStreaming(acc); setToolLabel(null); },
        onToolUse: (name) => setToolLabel(TOOL_LABELS[name] || 'consulting the ancient ledgers…'),
        onToolResult: (card) => cards.push(card),
        // Issue 3: capture usage tokens returned by the API
        onUsage: (model, inputTokens, outputTokens) => recordUsage(model, inputTokens, outputTokens),
      });
      apiHistory.current = updated;
      setMessages(m => [...m, { role: 'dragon', text: acc || '…', cards }]);
    } catch (e) {
      setHasError(true);
      setMessages(m => [...m, { role: 'dragon', text: dragonError(e), error: true }]);
      setTimeout(() => setHasError(false), 2000);
    } finally {
      setStreaming('');
      setToolLabel(null);
      setBusy(false);
    }
  }

  // Issue 2: resolve the web-research prompt and proceed
  function resolveWebResearch(useWeb) {
    const text = pendingTextRef.current;
    setWebResearchPrompt(null);
    pendingTextRef.current = null;
    if (text) send(text, useWeb);
  }

  function resetChat() {
    apiHistory.current = [];
    setMessages([]);
    setStreaming('');
    setWebResearchPrompt(null);
    pendingTextRef.current = null;
  }

  if (!keyReady || showSettings) {
    return (
      <KeySetup
        token={token}
        hasExisting={hasDragonKey()}
        showPrefs={keyReady}
        onCancel={showSettings ? () => setShowSettings(false) : null}
        onSaved={() => { setKeyReady(hasDragonKey()); setShowSettings(false); }}
      />
    );
  }

  const prefs = getPrefs();

  return (
    <div className="flex flex-col h-[calc(100dvh-120px)] max-w-lg mx-auto">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <DragonAvatar mood={avatarMood} size={36} />
          <div>
            <p className="text-white font-bold font-broske leading-tight">Ledger</p>
            <p className="text-slate-500 text-[11px]">
              {MODELS[prefs.model]?.label || 'Sonnet'}{prefs.webResearch && ' · 🌐 research'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {messages.length > 0 && (
            <button onClick={resetChat} title="New chat"
              className="text-slate-400 hover:text-white text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors">
              ✦ New
            </button>
          )}
          <button onClick={() => setShowSettings(true)} title="API key settings"
            className="text-slate-400 hover:text-white text-sm px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors">
            ⚙
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !streaming && (
          <div className="text-center pt-8 space-y-4">
            <div className="flex justify-center"><DragonAvatar mood="wave" size={96} /></div>
            <div className="space-y-1">
              <p className="text-white font-semibold font-broske">Greetings, treasure-keeper.</p>
              <p className="text-slate-400 text-sm px-4">Ask me anything about your gold — I'll check your real numbers before I answer.</p>
            </div>
            <div className="flex flex-col gap-2 pt-2 max-w-xs mx-auto">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => send(s)}
                  className="text-left text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl px-4 py-2.5 transition-colors border border-slate-700/60">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          // Check if this dragon turn has a plan card with a shortfall — if so, offer "Run anyway".
          const shortfallCard = m.role === 'dragon' && m.cards?.find(
            c => c.type === 'plan' && c.data?.stillShort > 0
          );
          return (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-emerald-600 text-white rounded-br-md'
                  : m.error
                    ? 'bg-rose-900/40 border border-rose-800/50 text-rose-200 rounded-bl-md'
                    : 'bg-slate-800 text-slate-100 rounded-bl-md'
              }`}>
                {m.role === 'dragon' ? <div className="space-y-0.5">{renderRich(m.text)}</div> : m.text}
              </div>
              {/* Visual windows the dragon generated for this turn */}
              {m.role === 'dragon' && m.cards?.length > 0 && (
                <div className="mt-2 w-full space-y-2">
                  {m.cards.map((c, ci) => <DragonCard key={ci} card={c} />)}
                </div>
              )}
              {/* "Run anyway" — shown when a plan has a shortfall the user wants to override */}
              {shortfallCard && !busy && (
                <button
                  onClick={() => send(`Run anyway — save this plan as-is despite the shortfall of $${shortfallCard.data.stillShort.toFixed(2)}/mo. I understand it's tight and I want to proceed.`)}
                  className="mt-2 self-start text-xs font-semibold px-3 py-1.5 rounded-xl bg-amber-900/40 border border-amber-700/50 text-amber-300 hover:bg-amber-800/50 transition-colors"
                >
                  Run anyway — save this plan despite the shortfall
                </button>
              )}
            </div>
          );
        })}

        {/* Live streaming reply */}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-relaxed bg-slate-800 text-slate-100">
              <div className="space-y-0.5">{renderRich(streaming)}</div>
            </div>
          </div>
        )}

        {/* Thinking / tool indicator */}
        {busy && !streaming && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md px-4 py-2.5 bg-slate-800 text-slate-400 text-sm flex items-center gap-2">
              <span className="inline-flex gap-1">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
              <span className="italic">{toolLabel || 'pondering…'}</span>
            </div>
          </div>
        )}
      </div>

      {/* Desktop mascot — fixed bottom-left, hidden on mobile */}
      <div className="fixed bottom-20 left-6 z-30 hidden md:flex flex-col items-center pointer-events-none select-none">
        <DragonAvatar mood={avatarMood} size={260} />
      </div>

      {/* Issue 2: web-research prompt — appears above the input bar when triggered */}
      {webResearchPrompt === 'pending' && (
        <div className="shrink-0 px-3 pt-2 pb-1 border-t border-slate-800 bg-slate-950">
          <div className="bg-slate-800 rounded-xl px-3 py-2.5 flex items-center justify-between gap-2">
            <p className="text-slate-300 text-xs leading-snug flex-1">
              🌐 This question might benefit from live data. Use web research?
            </p>
            <div className="flex gap-1.5 shrink-0">
              <button
                onClick={() => resolveWebResearch(true)}
                className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold transition-colors"
              >
                Yes
              </button>
              <button
                onClick={() => resolveWebResearch(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold transition-colors"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="shrink-0 px-3 py-3 border-t border-slate-800 bg-slate-950 safe-area-bottom">
        <form
          onSubmit={(e) => { e.preventDefault(); send(); }}
          className="flex items-end gap-2"
        >
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={1}
            placeholder="Ask Ledger about your treasure…"
            className="flex-1 resize-none bg-slate-800 text-white rounded-2xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-500 max-h-32"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="shrink-0 w-11 h-11 rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white flex items-center justify-center text-lg transition-colors"
            title="Send"
          >
            🔥
          </button>
        </form>
      </div>
    </div>
  );
}
