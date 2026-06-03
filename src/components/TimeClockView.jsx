import { useState, useEffect, useRef, useCallback } from 'react';
import { appendRow, ensureSheetTab, readRange, batchUpdateCells } from '../lib/sheets';

// ── localStorage keys ─────────────────────────────────────────────────────────
const KEY_SESSIONS  = 'biz_timeclock_sessions';
const KEY_ACTIVE    = 'biz_timeclock_active';
const KEY_DAILY_GOAL= 'biz_timeclock_daily_goal';

// ── XP / Level config ─────────────────────────────────────────────────────────
const LEVELS = [
  { level: 1, xp: 0,     title: 'Rookie',       color: '#94a3b8' },
  { level: 2, xp: 100,   title: 'Apprentice',   color: '#60a5fa' },
  { level: 3, xp: 300,   title: 'Craftsman',    color: '#a78bfa' },
  { level: 4, xp: 600,   title: 'Artisan',      color: '#34d399' },
  { level: 5, xp: 1100,  title: 'Journeyman',   color: '#fbbf24' },
  { level: 6, xp: 2000,  title: 'Expert',       color: '#f97316' },
  { level: 7, xp: 3500,  title: 'Master',       color: '#ec4899' },
  { level: 8, xp: 6000,  title: 'Grandmaster',  color: '#e11d48' },
  { level: 9, xp: 10000, title: 'Legend',       color: '#ffd700' },
];

const ACHIEVEMENTS = [
  { id: 'first',      icon: '🎯', title: 'First Clock-In',   desc: 'Complete your first session',         check: (sessions) => sessions.length >= 1 },
  { id: 'hour',       icon: '⏰', title: 'Hour Power',        desc: 'Work a 1-hour session',               check: (sessions) => sessions.some(s => s.duration >= 3600) },
  { id: 'cnote',      icon: '💵', title: 'C-Note',            desc: 'Earn $100+ profit in one session',    check: (sessions) => sessions.some(s => s.totalProfit >= 100) },
  { id: 'streak3',    icon: '🔥', title: 'On Fire',           desc: 'Work 3 days in a row',                check: (sessions, streak) => streak >= 3 },
  { id: 'streak7',    icon: '🏆', title: 'Power Week',        desc: 'Work 7 days in a row',                check: (sessions, streak) => streak >= 7 },
  { id: 'fivesess',   icon: '⚡', title: 'Getting Serious',   desc: 'Complete 5 sessions',                 check: (sessions) => sessions.length >= 5 },
  { id: 'tensess',    icon: '🌟', title: 'Dedicated',         desc: 'Complete 10 sessions',                check: (sessions) => sessions.length >= 10 },
  { id: 'highroller', icon: '💎', title: 'High Roller',       desc: 'Earn $500+ profit in one session',   check: (sessions) => sessions.some(s => s.totalProfit >= 500) },
  { id: 'speedster',  icon: '🚀', title: 'Speed Demon',       desc: 'Earn $50+/hr in a session',          check: (sessions) => sessions.some(s => s.duration >= 60 && (s.totalProfit / (s.duration / 3600)) >= 50) },
  { id: 'tenk',       icon: '👑', title: 'Ten-K Club',        desc: 'Earn $10,000+ total profit',         check: (sessions) => sessions.reduce((a, s) => a + s.totalProfit, 0) >= 10000 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function fmtDurationLong(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

function dayKey(iso) { return iso ? iso.slice(0, 10) : ''; }

function computeStreak(sessions) {
  if (!sessions.length) return 0;
  const days = [...new Set(sessions.map(s => dayKey(s.startTime)))].sort().reverse();
  const today = new Date().toISOString().slice(0, 10);
  if (days[0] !== today && days[0] !== new Date(Date.now() - 86400000).toISOString().slice(0, 10)) return 0;
  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]);
    const curr = new Date(days[i]);
    const diff = Math.round((prev - curr) / 86400000);
    if (diff === 1) streak++;
    else break;
  }
  return streak;
}

function computeXP(sessions) {
  return sessions.reduce((xp, s) => {
    xp += Math.floor(s.duration / 60);             // 1 XP per minute
    xp += (s.items || []).reduce((x, it) => x + it.qty * 5, 0); // 5 XP per unit
    if (s.totalProfit >= 100) xp += 20;            // bonus for $100+ session
    if (s.totalProfit >= 500) xp += 50;
    return xp;
  }, 0);
}

function getLevelInfo(xp) {
  let current = LEVELS[0], next = LEVELS[1];
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i].xp) { current = LEVELS[i]; next = LEVELS[i + 1] || null; break; }
  }
  const progress = next ? ((xp - current.xp) / (next.xp - current.xp)) * 100 : 100;
  return { current, next, xp, progress: Math.min(progress, 100) };
}

function computeProfit(product, qty) {
  if (!product || qty <= 0) return 0;
  const blocks = product.formula || [];
  let start = parseFloat(product.startPrice);
  if (!isFinite(start) || start < 0) start = 0;
  // If the start price is missing or errored (e.g. a #ERROR! cell upstream) but the
  // formula still carries explicit fixed dollar amounts, fall back to the sum of those
  // fixed blocks as the implied price — otherwise profit/unit silently reads $0 even
  // though the formula clearly defines a profit.
  if (start === 0) {
    const fixedTotal = blocks.reduce((s, b) => s + (b.type === 'fixed' ? (parseFloat(b.value) || 0) : 0), 0);
    if (fixedTotal > 0) start = fixedTotal;
  }
  let remaining = start;
  let profitAmt = 0;
  blocks.forEach(block => {
    const val = parseFloat(block.value) || 0;
    const allocated = block.type === 'fixed' ? Math.min(val, remaining) : (remaining * val / 100);
    remaining = Math.max(0, remaining - allocated);
    if (block.category === 'Profit' || block.category === 'Revenue') profitAmt += allocated;
  });
  // Any unallocated balance after cost blocks is also the owner's profit.
  // This handles products where profit is implicit (no explicit Profit block),
  // and is harmless when a Profit block exists since remaining will be ~0.
  profitAmt += remaining;
  return profitAmt * qty;
}

function profitPerUnit(product) {
  return computeProfit(product, 1);
}

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(KEY_SESSIONS) || '[]'); } catch { return []; }
}
function saveSessions(s) { localStorage.setItem(KEY_SESSIONS, JSON.stringify(s)); }
function loadActive() {
  try { return JSON.parse(localStorage.getItem(KEY_ACTIVE) || 'null'); } catch { return null; }
}
function saveActive(a) {
  if (a) localStorage.setItem(KEY_ACTIVE, JSON.stringify(a));
  else localStorage.removeItem(KEY_ACTIVE);
}

// ── Session Complete Modal ────────────────────────────────────────────────────
function SessionCompleteModal({ duration, products, onSave, onDiscard }) {
  const [items, setItems]   = useState(products.map(p => ({ ...p, qty: 0 })));
  const [notes, setNotes]   = useState('');
  const [tab,   setTab]     = useState('summary');

  const totalProfit = items.reduce((s, it) => s + computeProfit(it, it.qty), 0);
  const totalUnits  = items.reduce((s, it) => s + it.qty, 0);
  const hourlyRate  = duration > 0 ? totalProfit / (duration / 3600) : 0;

  function setQty(id, val) {
    const n = Math.max(0, parseInt(val) || 0);
    setItems(prev => prev.map(it => it.id === id ? { ...it, qty: n } : it));
  }

  function handleSave() {
    const sessionItems = items
      .filter(it => it.qty > 0)
      .map(it => ({
        productId:    it.id,
        productName:  it.name,
        qty:          it.qty,
        profitPerUnit: profitPerUnit(it),
        totalProfit:  computeProfit(it, it.qty),
      }));
    onSave({ items: sessionItems, totalProfit, notes });
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-end justify-center" onClick={e => e.target === e.currentTarget && onDiscard()}>
      <div className="bg-slate-900 rounded-t-3xl w-full max-w-lg max-h-[90dvh] flex flex-col">
        {/* Header */}
        <div className="shrink-0 px-5 pt-6 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-3xl">🏁</span>
            <div>
              <h2 className="text-white font-bold text-lg">Session Complete!</h2>
              <p className="text-slate-400 text-sm">Time worked: <span className="text-white font-mono font-bold">{fmtDurationLong(duration)}</span></p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="shrink-0 flex gap-1 px-5 pt-4 pb-2">
          {[['summary','Summary'],['products','What I Made']].map(([v,l]) => (
            <button key={v} onClick={() => setTab(v)}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === v ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
              {l}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
        {tab === 'summary' && (
          <div className="px-5 space-y-4 pt-2">
            {/* Profit preview */}
            <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-2xl p-4 text-center">
              <p className="text-slate-400 text-xs uppercase tracking-wider mb-1">Total Profit</p>
              <p className="text-emerald-400 font-bold text-4xl font-mono tabular-nums">${totalProfit.toFixed(2)}</p>
              {hourlyRate > 0 && (
                <p className="text-emerald-600 text-sm mt-1 font-mono">${hourlyRate.toFixed(2)}/hr</p>
              )}
            </div>

            {/* Quick stats */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-slate-800 rounded-xl p-3 text-center">
                <p className="text-slate-500 text-[10px] uppercase">Duration</p>
                <p className="text-white font-bold text-base font-mono mt-0.5">{fmtDurationLong(duration)}</p>
              </div>
              <div className="bg-slate-800 rounded-xl p-3 text-center">
                <p className="text-slate-500 text-[10px] uppercase">Units</p>
                <p className="text-white font-bold text-base font-mono mt-0.5">{totalUnits}</p>
              </div>
              <div className="bg-slate-800 rounded-xl p-3 text-center">
                <p className="text-slate-500 text-[10px] uppercase">$/hr</p>
                <p className={`font-bold text-base font-mono mt-0.5 ${hourlyRate >= 20 ? 'text-emerald-400' : hourlyRate > 0 ? 'text-amber-400' : 'text-slate-400'}`}>
                  {hourlyRate > 0 ? `$${hourlyRate.toFixed(0)}` : '—'}
                </p>
              </div>
            </div>

            {/* Per-product breakdown */}
            {items.filter(it => it.qty > 0).length > 0 && (
              <div className="bg-slate-800 rounded-xl overflow-hidden">
                {items.filter(it => it.qty > 0).map((it, i) => (
                  <div key={it.id} className={`flex items-center justify-between px-4 py-3 ${i > 0 ? 'border-t border-slate-700' : ''}`}>
                    <div>
                      <p className="text-white text-sm font-medium">{it.name}</p>
                      <p className="text-slate-500 text-xs">{it.qty} × ${profitPerUnit(it).toFixed(2)}</p>
                    </div>
                    <p className="text-emerald-400 font-mono font-bold text-sm tabular-nums">${computeProfit(it, it.qty).toFixed(2)}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Notes */}
            <div>
              <label className="text-slate-400 text-xs block mb-1">Session notes (optional)</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="What did you work on?"
                rows={2}
                className="w-full bg-slate-800 text-white text-sm rounded-xl px-3 py-2 border border-slate-700 focus:outline-none focus:border-slate-500 placeholder-slate-600 resize-none"
              />
            </div>
          </div>
        )}

        {tab === 'products' && (
          <div className="px-5 space-y-3 pt-2">
            <p className="text-slate-400 text-xs">Enter how many of each product you completed this session.</p>
            {products.map(p => {
              const ppu = profitPerUnit(p);
              const it  = items.find(x => x.id === p.id);
              return (
                <div key={p.id} className="bg-slate-800 rounded-xl px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{p.name}</p>
                    <p className="text-slate-500 text-xs font-mono">${ppu.toFixed(2)} profit/unit</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => setQty(p.id, (it?.qty || 0) - 1)}
                      className="w-8 h-8 rounded-lg bg-slate-700 text-white font-bold flex items-center justify-center hover:bg-slate-600 transition-colors text-lg leading-none">−</button>
                    <input
                      type="number" min="0"
                      value={it?.qty || 0}
                      onChange={e => setQty(p.id, e.target.value)}
                      className="w-14 bg-slate-900 text-white text-center text-sm font-mono font-bold rounded-lg px-2 py-1.5 border border-slate-700 focus:outline-none focus:border-slate-500"
                    />
                    <button onClick={() => setQty(p.id, (it?.qty || 0) + 1)}
                      className="w-8 h-8 rounded-lg bg-slate-700 text-white font-bold flex items-center justify-center hover:bg-slate-600 transition-colors text-lg leading-none">+</button>
                  </div>
                  {(it?.qty || 0) > 0 && (
                    <p className="text-emerald-400 font-mono text-xs w-14 text-right tabular-nums shrink-0">
                      +${computeProfit(p, it.qty).toFixed(2)}
                    </p>
                  )}
                </div>
              );
            })}
            {/* Running total */}
            {totalProfit > 0 && (
              <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-xl px-4 py-3 flex items-center justify-between">
                <span className="text-emerald-300 text-sm font-medium">Session Profit</span>
                <span className="text-emerald-400 font-bold font-mono text-lg tabular-nums">${totalProfit.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}

        </div>{/* end scrollable area */}

        {/* Actions */}
        <div className="shrink-0 px-5 py-4 border-t border-slate-800 safe-area-bottom flex gap-3">
          <button onClick={onDiscard}
            className="flex-1 py-3 rounded-xl text-sm font-medium text-slate-400 bg-slate-800 hover:bg-slate-700 transition-colors">
            Discard
          </button>
          <button onClick={handleSave}
            className="flex-2 flex-grow py-3 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-500 transition-colors">
            Save Session {totalProfit > 0 ? `(+$${totalProfit.toFixed(2)})` : ''}
          </button>
        </div>
        <p className="text-center text-slate-600 text-xs pb-2 px-5">Session saved locally and to your Work Sessions sheet. Process income anytime from the Sales tab.</p>
      </div>
    </div>
  );
}

// ── Stats / History Panel ─────────────────────────────────────────────────────
function HistoryPanel({ sessions, onDelete }) {
  const [show, setShow] = useState(10);
  const sorted = [...sessions].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  if (!sessions.length) return (
    <div className="text-center py-8 text-slate-500 text-sm">No sessions yet. Start your first clock-in!</div>
  );

  return (
    <div className="space-y-2">
      {sorted.slice(0, show).map(s => {
        const hr = s.duration > 0 ? s.totalProfit / (s.duration / 3600) : 0;
        const d  = new Date(s.startTime);
        const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const time  = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return (
          <div key={s.id} className="bg-slate-800 rounded-xl px-4 py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-white text-sm font-medium">{label} · {time}</p>
                {s.notes && <p className="text-slate-500 text-xs truncate max-w-[180px]">{s.notes}</p>}
              </div>
              <div className="flex gap-3 mt-0.5">
                <span className="text-slate-400 text-xs font-mono">{fmtDurationLong(s.duration)}</span>
                {hr > 0 && <span className="text-slate-500 text-xs font-mono">${hr.toFixed(0)}/hr</span>}
                {(s.items || []).length > 0 && (
                  <span className="text-slate-500 text-xs">{(s.items).reduce((a,i) => a+i.qty,0)} units</span>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className={`font-bold font-mono text-sm tabular-nums ${s.totalProfit > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                {s.totalProfit > 0 ? `$${s.totalProfit.toFixed(2)}` : '—'}
              </p>
              <button onClick={() => onDelete(s.id)} className="text-slate-600 hover:text-rose-500 text-xs mt-1 transition-colors">del</button>
            </div>
          </div>
        );
      })}
      {sorted.length > show && (
        <button onClick={() => setShow(n => n + 10)} className="w-full text-center text-slate-500 hover:text-slate-300 text-xs py-2 transition-colors">
          Load more ({sorted.length - show} remaining)
        </button>
      )}
    </div>
  );
}

// ── Main TimeClockView ────────────────────────────────────────────────────────
const WORK_SESSIONS_SHEET = 'Work Sessions';
const WORK_SESSIONS_HEADERS = ['Date', 'Start Time', 'Duration (sec)', 'Duration', 'Products', 'Total Units', 'Total Profit', '$/hr', 'Notes'];

export default function TimeClockView({ products, token }) {
  const [sessions,    setSessions]    = useState(loadSessions);
  const [active,      setActive]      = useState(loadActive);
  const [elapsed,     setElapsed]     = useState(0);      // seconds
  const [showComplete, setShowComplete] = useState(false);
  const [completeDur,  setCompleteDur]  = useState(0);
  const [tab,          setTab]          = useState('clock');
  const [dailyGoal,    setDailyGoal]    = useState(() => parseFloat(localStorage.getItem(KEY_DAILY_GOAL) || '0') || 0);
  const [editGoal,     setEditGoal]     = useState(false);
  const [goalInput,    setGoalInput]    = useState('');
  const [newBadge,     setNewBadge]     = useState(null);
  const tickRef = useRef(null);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const streak    = computeStreak(sessions);
  const totalXP   = computeXP(sessions);
  const levelInfo = getLevelInfo(totalXP);
  const totalProfit  = sessions.reduce((s, x) => s + x.totalProfit, 0);
  const totalSeconds = sessions.reduce((s, x) => s + x.duration, 0);
  const avgHourlyRate = totalSeconds > 60
    ? sessions.filter(s => s.totalProfit > 0 && s.duration > 60)
        .reduce((s, x, _, arr) => s + (x.totalProfit / (x.duration / 3600)) / arr.length, 0)
    : 0;
  const bestSession = sessions.reduce((best, s) => s.totalProfit > (best?.totalProfit || 0) ? s : best, null);
  const todayProfit = sessions.filter(s => dayKey(s.startTime) === dayKey(new Date().toISOString()))
    .reduce((s, x) => s + x.totalProfit, 0);

  const projectedProfit = elapsed > 0 && avgHourlyRate > 0
    ? avgHourlyRate * (elapsed / 3600)
    : 0;

  const unlockedIds = new Set(sessions.length > 0
    ? ACHIEVEMENTS.filter(a => a.check(sessions, streak)).map(a => a.id)
    : []);

  // ── Timer tick ───────────────────────────────────────────────────────────
  const computeElapsed = useCallback((act) => {
    if (!act) return 0;
    const now = Date.now();
    const start = new Date(act.startTime).getTime();
    const paused = act.pausedAt ? (now - new Date(act.pausedAt).getTime()) : 0;
    return Math.floor((now - start - (act.totalPausedMs || 0) - paused) / 1000);
  }, []);

  useEffect(() => {
    if (active && !active.pausedAt) {
      setElapsed(computeElapsed(active));
      tickRef.current = setInterval(() => setElapsed(computeElapsed(active)), 1000);
    } else {
      clearInterval(tickRef.current);
      if (active) setElapsed(computeElapsed(active));
    }
    return () => clearInterval(tickRef.current);
  }, [active, computeElapsed]);

  // ── Controls ──────────────────────────────────────────────────────────────
  function handleStart() {
    const act = { startTime: new Date().toISOString(), pausedAt: null, totalPausedMs: 0 };
    setActive(act);
    saveActive(act);
    setElapsed(0);
  }

  function handlePause() {
    if (!active || active.pausedAt) return;
    const act = { ...active, pausedAt: new Date().toISOString() };
    setActive(act);
    saveActive(act);
  }

  function handleResume() {
    if (!active || !active.pausedAt) return;
    const extra = Date.now() - new Date(active.pausedAt).getTime();
    const act = { ...active, pausedAt: null, totalPausedMs: (active.totalPausedMs || 0) + extra };
    setActive(act);
    saveActive(act);
  }

  function handleStop() {
    if (!active) return;
    const dur = computeElapsed(active);
    setCompleteDur(dur);
    setShowComplete(true);
    clearInterval(tickRef.current);
  }

  async function handleSaveSession({ items, totalProfit, notes }) {
    const dur = completeDur;
    const prev = loadSessions();
    const startISO = active.startTime;
    const newSession = {
      id: Math.random().toString(36).slice(2, 10),
      startTime: startISO,
      endTime:   new Date().toISOString(),
      duration:  dur,
      items,
      totalProfit,
      notes,
    };
    const updated = [...prev, newSession];

    // Check for newly unlocked achievements
    const wasUnlocked = new Set(prev.length > 0 ? ACHIEVEMENTS.filter(a => a.check(prev, computeStreak(prev))).map(a => a.id) : []);
    const nowUnlocked = ACHIEVEMENTS.filter(a => a.check(updated, computeStreak(updated))).map(a => a.id);
    const freshBadge  = nowUnlocked.find(id => !wasUnlocked.has(id));

    saveSessions(updated);
    saveActive(null);
    setSessions(updated);

    // Persist to Google Sheets in the background (non-blocking)
    if (token) {
      const d = new Date(startISO);
      const dateStr = d.toISOString().slice(0, 10);
      const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const totalUnits = items.reduce((s, it) => s + it.qty, 0);
      const hourlyRate = dur > 0 ? (totalProfit / (dur / 3600)).toFixed(2) : '0.00';
      const productsStr = items.length
        ? items.map(it => `${it.qty}x ${it.productName}`).join(', ')
        : '—';
      try {
        await ensureSheetTab(token, WORK_SESSIONS_SHEET);
        // Write header row if sheet is fresh
        const existing = await readRange(token, `${WORK_SESSIONS_SHEET}!A1:A1`);
        if (!existing.length || !existing[0]?.length) {
          await batchUpdateCells(token, WORK_SESSIONS_HEADERS.map((h, i) => ({
            range: `${WORK_SESSIONS_SHEET}!${String.fromCharCode(65 + i)}1`,
            value: h,
          })));
        }
        await appendRow(token, `${WORK_SESSIONS_SHEET}!A:I`, [
          dateStr,
          timeStr,
          dur,
          fmtDurationLong(dur),
          productsStr,
          totalUnits,
          totalProfit.toFixed(2),
          hourlyRate,
          notes || '',
        ]);
      } catch (e) {
        console.error('TimeClockView: failed to write to Sheets', e);
      }
    }
    setActive(null);
    setElapsed(0);
    setShowComplete(false);
    setCompleteDur(0);

    if (freshBadge) {
      const ach = ACHIEVEMENTS.find(a => a.id === freshBadge);
      setNewBadge(ach);
      setTimeout(() => setNewBadge(null), 4000);
    }
  }

  function handleDiscard() {
    saveActive(null);
    setActive(null);
    setElapsed(0);
    setShowComplete(false);
    setCompleteDur(0);
  }

  function deleteSession(id) {
    const updated = sessions.filter(s => s.id !== id);
    saveSessions(updated);
    setSessions(updated);
  }

  function saveGoal(val) {
    const n = parseFloat(val) || 0;
    setDailyGoal(n);
    localStorage.setItem(KEY_DAILY_GOAL, String(n));
    setEditGoal(false);
  }

  const isPaused  = active && !!active.pausedAt;
  const isRunning = active && !isPaused;

  // ── Production capacity cards (products vs. session time) ─────────────────
  const productsWithProfit = products.map(p => {
    const ppu = profitPerUnit(p);
    return { ...p, ppu };
  }).filter(p => p.ppu > 0);

  // For each product: if you worked at avgHourlyRate worth of this product, how many per hour?
  // We just show: at this pace, you could make X units this session (if you were making this product).
  // We estimate time-per-unit as: (startPrice / avgHourlyRate) hours — but that's revenue-based.
  // Instead, we'll show units = floor(elapsed / estimatedSecsPerUnit) where we ask user or use a default.
  // Since we don't have time-per-unit data, we'll just show how many units = totalProfit / ppu
  // at the projected rate, or simply show the profit breakdown potential.

  const sessionHours = elapsed / 3600;

  return (
    <div className="px-4 pb-6 space-y-4">
      {/* Achievement toast */}
      {newBadge && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-amber-500 text-black px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-2 font-bold text-sm animate-bounce">
          <span className="text-xl">{newBadge.icon}</span>
          Achievement Unlocked: {newBadge.title}!
        </div>
      )}

      {/* Level bar */}
      <div className="bg-slate-800 rounded-2xl px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">{levelInfo.current.level >= 9 ? '👑' : '⚡'}</span>
            <div>
              <p className="text-white font-bold text-sm">Lvl {levelInfo.current.level} · {levelInfo.current.title}</p>
              <p className="text-slate-500 text-xs">{totalXP} XP total</p>
            </div>
          </div>
          {levelInfo.next && (
            <p className="text-slate-500 text-xs">{levelInfo.next.xp - totalXP} XP to Lvl {levelInfo.next.level}</p>
          )}
        </div>
        <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
          <div className="h-2 rounded-full transition-all duration-500"
            style={{ width: `${levelInfo.progress}%`, background: levelInfo.current.color }} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
        {[['clock','⏱ Clock'],['stats','📊 Stats'],['history','📋 History'],['badges','🏅 Badges']].map(([v,l]) => (
          <button key={v} onClick={() => setTab(v)}
            className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${tab === v ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-300'}`}>
            {l}
          </button>
        ))}
      </div>

      {/* ── CLOCK TAB ── */}
      {tab === 'clock' && (
        <div className="space-y-4">
          {/* Timer display */}
          <div className="bg-slate-900 rounded-3xl p-8 text-center relative overflow-hidden">
            {/* Animated ring when running */}
            {isRunning && (
              <div className="absolute inset-0 rounded-3xl border-2 border-emerald-500/30 animate-pulse" />
            )}
            <p className="text-slate-600 text-xs uppercase tracking-widest mb-2">
              {!active ? 'Ready' : isPaused ? 'Paused' : 'Working'}
            </p>
            <p className={`font-mono font-black tracking-tight transition-colors ${
              isRunning ? 'text-emerald-400' : isPaused ? 'text-amber-400' : 'text-white'
            }`} style={{ fontSize: '3.5rem', lineHeight: 1.1 }}>
              {fmtDuration(elapsed)}
            </p>
            {/* Live projected earnings */}
            {isRunning && projectedProfit > 0 && (
              <div className="mt-3 inline-flex items-center gap-1.5 bg-emerald-900/40 border border-emerald-700/40 rounded-full px-4 py-1.5">
                <span className="text-emerald-500 text-xs">≈</span>
                <span className="text-emerald-400 font-mono font-bold text-lg tabular-nums">${projectedProfit.toFixed(2)}</span>
                <span className="text-emerald-600 text-xs">projected</span>
              </div>
            )}
            {isRunning && projectedProfit === 0 && sessions.length === 0 && (
              <p className="text-slate-600 text-xs mt-3">Complete your first session to see earnings projections</p>
            )}
          </div>

          {/* Controls */}
          <div className="flex gap-3">
            {!active && (
              <button onClick={handleStart}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-4 rounded-2xl font-bold text-base transition-all active:scale-95 shadow-lg shadow-emerald-900/40">
                ▶ Start Session
              </button>
            )}
            {isRunning && (
              <>
                <button onClick={handlePause}
                  className="flex-1 bg-amber-600/80 hover:bg-amber-500 text-white py-4 rounded-2xl font-bold text-base transition-all active:scale-95">
                  ⏸ Pause
                </button>
                <button onClick={handleStop}
                  className="flex-1 bg-rose-700/80 hover:bg-rose-600 text-white py-4 rounded-2xl font-bold text-base transition-all active:scale-95">
                  ⏹ Stop
                </button>
              </>
            )}
            {isPaused && (
              <>
                <button onClick={handleResume}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-4 rounded-2xl font-bold text-base transition-all active:scale-95">
                  ▶ Resume
                </button>
                <button onClick={handleStop}
                  className="flex-1 bg-rose-700/80 hover:bg-rose-600 text-white py-4 rounded-2xl font-bold text-base transition-all active:scale-95">
                  ⏹ Stop
                </button>
              </>
            )}
          </div>

          {/* Daily goal */}
          <div className="bg-slate-800 rounded-2xl px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-slate-400 text-xs uppercase tracking-wider">Today's Profit Goal</p>
              <button onClick={() => { setGoalInput(dailyGoal > 0 ? String(dailyGoal) : ''); setEditGoal(true); }}
                className="text-slate-500 hover:text-slate-300 text-xs transition-colors">
                {dailyGoal > 0 ? 'Edit' : 'Set Goal'}
              </button>
            </div>
            {editGoal ? (
              <div className="flex gap-2">
                <input type="number" min="0" placeholder="e.g. 50"
                  value={goalInput} onChange={e => setGoalInput(e.target.value)}
                  className="flex-1 bg-slate-900 text-white text-sm font-mono rounded-lg px-3 py-2 border border-slate-700 focus:outline-none focus:border-slate-500"
                  autoFocus onKeyDown={e => { if (e.key === 'Enter') saveGoal(goalInput); if (e.key === 'Escape') setEditGoal(false); }}
                />
                <button onClick={() => saveGoal(goalInput)} className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 rounded-lg transition-colors">Save</button>
                <button onClick={() => setEditGoal(false)} className="bg-slate-700 text-slate-300 text-xs px-3 rounded-lg transition-colors">✕</button>
              </div>
            ) : dailyGoal > 0 ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white font-mono tabular-nums font-bold">${todayProfit.toFixed(2)}</span>
                  <span className="text-slate-500 font-mono">/ ${dailyGoal.toFixed(2)}</span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
                  <div className="h-2 rounded-full transition-all duration-700"
                    style={{
                      width: `${Math.min((todayProfit / dailyGoal) * 100, 100)}%`,
                      background: todayProfit >= dailyGoal ? '#10b981' : '#3b82f6'
                    }} />
                </div>
                {todayProfit >= dailyGoal ? (
                  <p className="text-emerald-400 text-xs font-bold">🎉 Goal reached! +${(todayProfit - dailyGoal).toFixed(2)} over</p>
                ) : (
                  <p className="text-slate-500 text-xs">${(dailyGoal - todayProfit).toFixed(2)} to go</p>
                )}
              </div>
            ) : (
              <p className="text-slate-600 text-sm">No goal set — tap "Set Goal" to add a daily profit target</p>
            )}
          </div>

          {/* Production capacity */}
          {productsWithProfit.length > 0 && (
            <div className="space-y-2">
              <p className="text-slate-400 text-xs uppercase tracking-wider">Production Potential This Session</p>
              <p className="text-slate-600 text-[11px] -mt-1">Based on your avg hourly rate · enter actual units when you stop</p>
              {productsWithProfit.map(p => {
                const estUnits = avgHourlyRate > 0 && p.ppu > 0
                  ? Math.floor((avgHourlyRate * sessionHours) / p.ppu)
                  : null;
                const estProfit = estUnits !== null ? estUnits * p.ppu : null;
                return (
                  <div key={p.id} className="bg-slate-800 rounded-xl px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{p.name}</p>
                      <p className="text-slate-500 text-xs font-mono">${p.ppu.toFixed(2)} profit/unit</p>
                    </div>
                    <div className="text-right shrink-0">
                      {estUnits !== null && elapsed > 30 ? (
                        <>
                          <p className="text-white font-bold text-lg font-mono">{estUnits}</p>
                          <p className="text-emerald-500 text-xs font-mono tabular-nums">≈${estProfit.toFixed(2)}</p>
                        </>
                      ) : (
                        <p className="text-slate-600 text-xs">start timer</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── STATS TAB ── */}
      {tab === 'stats' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Total Sessions', value: sessions.length,                             color: 'text-white' },
              { label: 'Total Hours',    value: fmtDurationLong(totalSeconds),                color: 'text-blue-400' },
              { label: 'Total Profit',   value: `$${totalProfit.toFixed(2)}`,                 color: 'text-emerald-400' },
              { label: 'Avg $/hr',       value: avgHourlyRate > 0 ? `$${avgHourlyRate.toFixed(2)}` : '—', color: 'text-amber-400' },
              { label: 'Current Streak', value: streak > 0 ? `${streak} day${streak > 1 ? 's' : ''}` : '—', color: 'text-orange-400' },
              { label: 'Today\'s Profit',value: `$${todayProfit.toFixed(2)}`,                color: 'text-purple-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-slate-800 rounded-2xl p-4">
                <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">{label}</p>
                <p className={`font-bold text-xl font-mono tabular-nums ${color}`}>{value}</p>
              </div>
            ))}
          </div>

          {bestSession && (
            <div className="bg-slate-800 rounded-2xl px-4 py-4">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-2">Best Session</p>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white font-bold text-lg font-mono tabular-nums">${bestSession.totalProfit.toFixed(2)}</p>
                  <p className="text-slate-400 text-xs mt-0.5">
                    {new Date(bestSession.startTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    {' · '}{fmtDurationLong(bestSession.duration)}
                  </p>
                </div>
                <span className="text-3xl">🏆</span>
              </div>
              {(bestSession.items || []).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {bestSession.items.map(it => (
                    <span key={it.productId} className="text-[10px] bg-slate-700 text-slate-300 rounded-full px-2 py-0.5">
                      {it.qty}× {it.productName}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Product performance */}
          {sessions.length > 0 && (() => {
            const byProduct = {};
            sessions.forEach(s => (s.items || []).forEach(it => {
              if (!byProduct[it.productName]) byProduct[it.productName] = { units: 0, profit: 0 };
              byProduct[it.productName].units  += it.qty;
              byProduct[it.productName].profit += it.totalProfit;
            }));
            const entries = Object.entries(byProduct).sort((a, b) => b[1].profit - a[1].profit);
            if (!entries.length) return null;
            return (
              <div className="bg-slate-800 rounded-2xl px-4 py-4">
                <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-3">Top Products (all time)</p>
                <div className="space-y-3">
                  {entries.slice(0, 5).map(([name, d]) => (
                    <div key={name} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <p className="text-white text-xs truncate">{name}</p>
                          <p className="text-emerald-400 font-mono text-xs tabular-nums shrink-0 ml-2">${d.profit.toFixed(2)}</p>
                        </div>
                        <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                          <div className="h-1.5 rounded-full bg-emerald-600"
                            style={{ width: `${(d.profit / entries[0][1].profit) * 100}%` }} />
                        </div>
                      </div>
                      <p className="text-slate-500 text-xs shrink-0 w-14 text-right">{d.units} units</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {tab === 'history' && (
        <HistoryPanel sessions={sessions} onDelete={deleteSession} />
      )}

      {/* ── BADGES TAB ── */}
      {tab === 'badges' && (
        <div className="space-y-3">
          <p className="text-slate-500 text-xs">{unlockedIds.size} / {ACHIEVEMENTS.length} unlocked</p>
          <div className="grid grid-cols-2 gap-3">
            {ACHIEVEMENTS.map(a => {
              const unlocked = unlockedIds.has(a.id);
              return (
                <div key={a.id} className={`rounded-2xl p-4 border transition-all ${unlocked ? 'bg-slate-800 border-slate-600' : 'bg-slate-900/50 border-slate-800 opacity-60'}`}>
                  <p className="text-3xl mb-2">{unlocked ? a.icon : '🔒'}</p>
                  <p className={`font-bold text-sm ${unlocked ? 'text-white' : 'text-slate-500'}`}>{a.title}</p>
                  <p className="text-slate-500 text-xs mt-0.5 leading-tight">{a.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Session complete modal */}
      {showComplete && (
        <SessionCompleteModal
          duration={completeDur}
          products={products}
          onSave={handleSaveSession}
          onDiscard={handleDiscard}
        />
      )}
    </div>
  );
}
