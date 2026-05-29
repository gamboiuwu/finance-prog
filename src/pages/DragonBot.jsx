import { useState, useRef, useEffect, useCallback } from 'react';
import { streamDragon, dragonError } from '../lib/dragonBot';
import { getDragonKey, setDragonKey, clearDragonKey, hasDragonKey } from '../lib/dragonKey';
import DragonAvatar from '../components/DragonAvatar';

const TOOL_LABELS = {
  get_monthly_summary:  'peering at your monthly hoard…',
  get_budget_categories:'unrolling your budget scroll…',
  get_allocations:      'counting your gold coins…',
  get_subscriptions:    'sniffing out recurring tithes…',
};

const SUGGESTIONS = [
  'How much did I spend last month? 🪙',
  'Am I on track for my savings goal?',
  'What are my subscriptions costing me?',
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

// ── API-key setup / settings screen ─────────────────────────────────────────
function KeySetup({ onSaved, onCancel, hasExisting }) {
  const [val, setVal] = useState('');
  return (
    <div className="px-4 py-6 max-w-md mx-auto space-y-5">
      <div className="text-center space-y-2">
        <div className="flex justify-center"><DragonAvatar mood="sleep" size={80} /></div>
        <h2 className="text-white font-bold text-xl font-broske">Wake the Dragon</h2>
        <p className="text-slate-400 text-sm leading-relaxed">
          Ledger runs on your own Anthropic API key. Paste it below — it's saved only on
          this device (in your browser) and sent straight to Anthropic. It's never uploaded
          or committed anywhere.
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
          onClick={() => { if (val.trim()) { setDragonKey(val); onSaved(); } }}
          disabled={!val.trim()}
          className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm transition-colors"
        >
          🔥 Light the Fire
        </button>
        {hasExisting && (
          <button
            onClick={() => { clearDragonKey(); onSaved(); }}
            className="w-full py-2.5 rounded-xl bg-slate-700 hover:bg-rose-900/40 text-rose-300 font-medium text-xs transition-colors"
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

      <div className="bg-amber-900/20 border border-amber-800/40 rounded-xl p-3 text-amber-300/90 text-xs leading-relaxed">
        <p className="font-semibold mb-1">🔑 Where do I get a key?</p>
        <p>Create one at <span className="text-amber-200">console.anthropic.com</span> → API Keys.
        Tip: set a low monthly spend limit on the key, since it lives in your browser.</p>
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

  const apiHistory = useRef([]);                          // full Anthropic message history
  const scrollRef = useRef(null);

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

  async function send(text) {
    const trimmed = (text ?? input).trim();
    if (!trimmed || busy) return;
    setInput('');
    setHasError(false);
    setMessages(m => [...m, { role: 'user', text: trimmed }]);
    setBusy(true);
    setStreaming('');
    setToolLabel(null);

    let acc = '';
    try {
      const updated = await streamDragon({
        token,
        history: apiHistory.current,
        userText: trimmed,
        onText: (delta) => { acc += delta; setStreaming(acc); setToolLabel(null); },
        onToolUse: (name) => setToolLabel(TOOL_LABELS[name] || 'consulting the ancient ledgers…'),
      });
      apiHistory.current = updated;
      setMessages(m => [...m, { role: 'dragon', text: acc || '…' }]);
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

  function resetChat() {
    apiHistory.current = [];
    setMessages([]);
    setStreaming('');
  }

  if (!keyReady || showSettings) {
    return (
      <KeySetup
        hasExisting={hasDragonKey()}
        onCancel={showSettings ? () => setShowSettings(false) : null}
        onSaved={() => { setKeyReady(hasDragonKey()); setShowSettings(false); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-120px)] max-w-lg mx-auto">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <DragonAvatar mood={avatarMood} size={36} />
          <div>
            <p className="text-white font-bold font-broske leading-tight">Ledger</p>
            <p className="text-slate-500 text-[11px]">your treasure-hoarding budget dragon</p>
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

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'bg-emerald-600 text-white rounded-br-md'
                : m.error
                  ? 'bg-rose-900/40 border border-rose-800/50 text-rose-200 rounded-bl-md'
                  : 'bg-slate-800 text-slate-100 rounded-bl-md'
            }`}>
              {m.role === 'dragon' ? <div className="space-y-0.5">{renderRich(m.text)}</div> : m.text}
            </div>
          </div>
        ))}

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
