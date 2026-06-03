// IssueReporter — right-click anywhere to file an issue for the daily AI routine.
//
// Captures: the route, the exact element under the cursor (CSS path + text), the
// cursor coordinates, viewport size, timestamp, and an optional screenshot of the
// tab with a marker drawn where you right-clicked. You add a comment and severity.
//
// Issues are saved to localStorage (the working store, survives reloads) and, when
// a Google token is present, the text fields are also appended to an "Issues" sheet
// tab for durability. Use Export to download every issue (with screenshots) as JSON
// for the daily routine to read — a static site cannot push to the repo itself, so
// the JSON file is the hand-off.
import { useEffect, useState, useCallback, useRef } from 'react';
import { ISSUES_SPREADSHEET_ID } from '../config';

const STORE_KEY = 'fin_issues';
const MAX_ISSUES = 30;

// ── One-time "What's New" window ──────────────────────────────────────────────
// A plain, manually-curated changelog shown ONCE per release, gated by its `id`
// in localStorage. This is deliberately NOT an automatic/recurring popup system —
// to surface it again you bump `CHANGELOG.id` by hand. On first view it also
// prunes locally-stored issues reported at/before `resolvedThrough`, so issues
// that have since been fixed stop resurfacing in the working list.
const CHANGELOG = {
  id: 'fixes-2026-06-03',
  date: 'June 3, 2026',
  resolvedThrough: '2026-06-02T13:46:49.629Z',
  items: [
    'Summary — the last day of the month now shows hours left instead of “0 days”. Account tiles show your target share while income is still unclaimed, not a blank $0.00.',
    'Budget — the monthly figure fits inside the allocation ring; subscriptions show a per-item breakdown with monthly + yearly totals; the Edit Budget Item window opens centered on desktop and closes when you click outside.',
    'Dashboard — tap a calendar day to see which subscriptions are due; the bill calendar is more compact; the health gauge is cleaner; the statement explains when no income is in yet and lets you close out the month.',
    'Process Income — a new “move money to accounts” panel shows exactly where each dollar lands.',
    'Navigation — tidier, more legible bottom tabs with a subtle active animation.',
    'Goals — add, edit, and delete goals; fixed a target date that showed as a raw number (e.g. “46327”).',
    'Gas — the regional price range now has a week-by-week history chart.',
    'Dragon — a “Run anyway” option when a plan falls short of a goal.',
    'Issue Reporter — left-click the screenshot to mark the exact spot; resolved issues now clear from your local list automatically.',
  ],
};
const CHANGELOG_SEEN_KEY = '_fin_changelog_seen';

function loadIssues() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}
// Save with quota safety: if we overflow, drop the oldest screenshots, then oldest rows.
function saveIssues(list) {
  let arr = list.slice(-MAX_ISSUES);
  for (let attempt = 0; attempt < 40; attempt++) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); return arr; }
    catch {
      const withShot = arr.find(i => i.screenshot);
      if (withShot) withShot.screenshot = null;        // shed the heaviest payloads first
      else arr = arr.slice(1);                          // then drop oldest entries
      if (!arr.length) return arr;
    }
  }
  return arr;
}

// Build a short, readable CSS path to the clicked element.
function cssPath(el) {
  if (!el || el.nodeType !== 1) return '';
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && node !== document.body && depth < 6; depth++) {
    let part = node.tagName.toLowerCase();
    if (node.id) { parts.unshift(`${part}#${node.id}`); break; }
    const cls = typeof node.className === 'string'
      ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    if (cls) part += `.${cls}`;
    const parent = node.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function describe(el) {
  if (!el || el.nodeType !== 1) return {};
  const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 140);
  return {
    selector: cssPath(el),
    tag: el.tagName.toLowerCase(),
    label: el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '',
    text,
  };
}

// Grab a raw frame of the current tab (no crosshair drawn yet). Returns a JPEG data URL, or null.
async function captureRaw() {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true,
    });
  } catch { return null; }
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise(r => setTimeout(r, 180));
    const vw = video.videoWidth || window.innerWidth;
    const vh = video.videoHeight || window.innerHeight;
    const scale = Math.min(1, 1280 / vw);
    const cv = document.createElement('canvas');
    cv.width = Math.round(vw * scale);
    cv.height = Math.round(vh * scale);
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
  finally { stream.getTracks().forEach(t => t.stop()); }
}

// Composite a red crosshair onto rawDataUrl at the given fractional position.
function buildCompositeShot(rawDataUrl, pos) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const mx = pos.xFrac * img.width;
      const my = pos.yFrac * img.height;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = Math.max(2, img.width / 400);
      ctx.beginPath(); ctx.arc(mx, my, 16, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx - 26, my); ctx.lineTo(mx + 26, my);
      ctx.moveTo(mx, my - 26); ctx.lineTo(mx, my + 26); ctx.stroke();
      resolve(cv.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(rawDataUrl);
    img.src = rawDataUrl;
  });
}

export default function IssueReporter({ token }) {
  const [menu, setMenu]   = useState(null);   // { x, y, ctx }
  const [draft, setDraft] = useState(null);   // open report modal context
  const [comment, setComment] = useState('');
  const [severity, setSeverity] = useState('normal');
  const [rawShot, setRawShot] = useState(null);
  const [markerPos, setMarkerPos] = useState(null); // {xFrac, yFrac} normalized 0..1
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [count, setCount] = useState(() => loadIssues().length);
  const [whatsNew, setWhatsNew] = useState(false);
  const cursor = useRef({ x: 0, y: 0 });

  // Intercept right-click everywhere (except inside text fields, so native
  // copy/paste still works there, and except inside our own UI).
  useEffect(() => {
    function onContext(e) {
      const t = e.target;
      if (t.closest?.('[data-issue-ui]')) return;
      const tag = t.tagName;
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
      if (editable && !e.shiftKey) return;
      e.preventDefault();
      cursor.current = { x: e.clientX, y: e.clientY };
      setMenu({ x: e.clientX, y: e.clientY, ctx: describe(t) });
    }
    function onClick() { setMenu(null); }
    function onEsc(e) { if (e.key === 'Escape') { setMenu(null); } }
    document.addEventListener('contextmenu', onContext);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('contextmenu', onContext);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, []);

  // One-shot per release: prune issues that have since been resolved and surface
  // the "What's New" window. Gated by the changelog id so it never shows twice.
  useEffect(() => {
    if (localStorage.getItem(CHANGELOG_SEEN_KEY) === CHANGELOG.id) return;
    const remaining = loadIssues().filter(i => !(i.time && i.time <= CHANGELOG.resolvedThrough));
    saveIssues(remaining);
    setCount(remaining.length);
    setWhatsNew(true);
  }, []);

  function dismissWhatsNew() {
    localStorage.setItem(CHANGELOG_SEEN_KEY, CHANGELOG.id);
    setWhatsNew(false);
  }

  const flash = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(''), 2600); }, []);

  function openReport() {
    const c = cursor.current;
    setDraft({
      ...menu.ctx,
      route: window.location.hash || '#/',
      cursor: c,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      time: new Date().toISOString(),
      ua: navigator.userAgent,
    });
    setComment(''); setSeverity('normal'); setRawShot(null); setMarkerPos(null);
    setMenu(null);
  }

  async function attachShot() {
    setCapturing(true);
    await new Promise(r => setTimeout(r, 120));
    const dataUrl = await captureRaw();
    setCapturing(false);
    if (dataUrl) {
      setRawShot(dataUrl);
      // Don't auto-place the marker: the right-click point is where the menu was
      // opened, not necessarily the spot the user cares about. Require a deliberate
      // left-click on the image to set it.
      setMarkerPos(null);
      flash('Screenshot attached — left-click the image to mark the spot');
    } else flash('Screenshot skipped or not supported');
  }

  function handleShotClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    setMarkerPos({
      xFrac: (e.clientX - rect.left) / rect.width,
      yFrac: (e.clientY - rect.top) / rect.height,
    });
  }

  async function saveIssue() {
    setSaving(true);
    let finalShot = null;
    if (rawShot) finalShot = markerPos ? await buildCompositeShot(rawShot, markerPos) : rawShot;
    const issue = { ...draft, comment: comment.trim(), severity, screenshot: finalShot };
    const next = saveIssues([...loadIssues(), issue]);
    setCount(next.length);
    if (token) {
      try {
        const range = encodeURIComponent('Sheet1!A:I');
        await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${ISSUES_SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [[
              issue.time, issue.route, issue.severity, issue.selector || issue.tag || '',
              (issue.text || '').slice(0, 200), issue.comment,
              rawShot ? 'captured (in local export)' : 'none', issue.ua, '',
            ]] }),
          }
        );
      } catch { /* offline / no access — local copy still saved */ }
    }
    setSaving(false);
    setDraft(null);
    flash('Issue saved for the daily routine');
  }

  function exportAll() {
    const data = JSON.stringify(loadIssues(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `finance-issues-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function clearAll() {
    if (!confirm('Delete all saved issues on this device?')) return;
    localStorage.removeItem(STORE_KEY); setCount(0); flash('All issues cleared');
  }

  return (
    <div data-issue-ui>
      {/* Right-click menu */}
      {menu && (
        <div
          className="fixed z-[120] bg-slate-800 border border-slate-700 rounded-xl shadow-2xl py-1 text-sm w-48 menu-enter"
          style={{ top: Math.min(menu.y, window.innerHeight - 110), left: Math.min(menu.x, window.innerWidth - 200) }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={openReport}
            className="w-full text-left px-4 py-2.5 text-slate-100 hover:bg-slate-700 flex items-center gap-2">
            🚩 Report Issue
          </button>
          {count > 0 && (
            <button onClick={() => { exportAll(); setMenu(null); }}
              className="w-full text-left px-4 py-2.5 text-slate-300 hover:bg-slate-700 flex items-center gap-2 border-t border-slate-700/60">
              ⬇ Export issues ({count})
            </button>
          )}
          <button onClick={() => setMenu(null)}
            className="w-full text-left px-4 py-2 text-slate-500 hover:bg-slate-700 text-xs border-t border-slate-700/60">
            Dismiss
          </button>
        </div>
      )}

      {/* Report modal */}
      {draft && (
        <div
          className={`fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-[110] p-4 transition-opacity ${capturing ? 'opacity-0 pointer-events-none' : ''}`}
          onClick={() => !saving && setDraft(null)}
        >
          <div className="bg-slate-800 rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-white font-semibold text-lg">🚩 Report an issue</h2>
              <button onClick={() => setDraft(null)} className="text-slate-400 hover:text-white text-xl leading-none">✕</button>
            </div>

            {/* Captured context */}
            <div className="bg-slate-900/70 rounded-xl p-3 text-xs text-slate-400 space-y-1 leading-relaxed">
              <div><span className="text-slate-500">Page</span> <span className="text-slate-200 font-mono">{draft.route}</span></div>
              <div className="truncate"><span className="text-slate-500">Element</span> <span className="text-slate-200 font-mono">{draft.selector || draft.tag}</span></div>
              {draft.text && <div className="line-clamp-2"><span className="text-slate-500">Content</span> <span className="text-slate-300">{draft.text}</span></div>}
              <div><span className="text-slate-500">Cursor</span> <span className="text-slate-300">{Math.round(draft.cursor.x)}, {Math.round(draft.cursor.y)}</span></div>
            </div>

            {/* Screenshot */}
            {rawShot ? (
              <div>
                <div className="relative cursor-crosshair rounded-lg overflow-hidden border border-slate-700"
                     onClick={handleShotClick}>
                  <img src={rawShot} alt="Issue screenshot" className="w-full block" />
                  {markerPos && (
                    <div className="absolute pointer-events-none"
                         style={{ left: `${markerPos.xFrac * 100}%`, top: `${markerPos.yFrac * 100}%`, transform: 'translate(-50%,-50%)' }}>
                      <div className="relative w-8 h-8">
                        <div className="absolute inset-0 rounded-full border-2 border-red-500" />
                        <div className="absolute top-1/2 left-0 w-full h-px bg-red-500 -translate-y-px" />
                        <div className="absolute left-1/2 top-0 w-px h-full bg-red-500 -translate-x-px" />
                      </div>
                    </div>
                  )}
                  <button onClick={e => { e.stopPropagation(); setRawShot(null); setMarkerPos(null); }}
                    className="absolute top-2 right-2 bg-slate-900/80 text-slate-200 text-xs px-2 py-1 rounded-lg">Remove</button>
                </div>
                <p className={`text-[10px] mt-1 text-center ${markerPos ? 'text-slate-500' : 'text-amber-400'}`}>
                  {markerPos ? 'Click image to reposition the marker' : '👆 Left-click the image to mark where the problem is'}
                </p>
              </div>
            ) : (
              <button onClick={attachShot}
                className="w-full py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors">
                📸 Attach screenshot (marks your cursor)
              </button>
            )}

            {/* Comment */}
            <div>
              <label className="text-slate-400 text-xs block mb-1">Comments</label>
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={4} autoFocus
                placeholder="What looks wrong, or what did you expect to happen?"
                className="w-full resize-none bg-slate-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-500" />
            </div>

            {/* Severity */}
            <div>
              <label className="text-slate-400 text-xs block mb-1">Severity</label>
              <div className="flex gap-2">
                {[['minor', 'Minor'], ['normal', 'Normal'], ['blocking', 'Blocking']].map(([v, l]) => (
                  <button key={v} onClick={() => setSeverity(v)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                      severity === v ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => setDraft(null)} disabled={saving}
                className="flex-1 py-2.5 rounded-xl bg-slate-700 text-slate-300 text-sm font-medium disabled:opacity-50">Cancel</button>
              <button onClick={saveIssue} disabled={saving || !comment.trim()}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50">
                {saving ? 'Saving…' : 'Save issue'}
              </button>
            </div>
            {count > 0 && (
              <div className="flex justify-between text-xs pt-1">
                <button onClick={exportAll} className="text-blue-400 hover:text-blue-300">⬇ Export all ({count})</button>
                <button onClick={clearAll} className="text-slate-500 hover:text-rose-400">Clear all</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* What's New — shown once per release (CHANGELOG.id) */}
      {whatsNew && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-[125] p-4"
          onClick={dismissWhatsNew}>
          <div className="bg-slate-800 rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[88dvh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-white font-semibold text-lg">✨ What's new</h2>
                <p className="text-slate-500 text-xs mt-0.5">Updated {CHANGELOG.date} · built from your reported issues</p>
              </div>
              <button onClick={dismissWhatsNew} className="text-slate-400 hover:text-white text-xl leading-none">✕</button>
            </div>
            <ul className="space-y-2">
              {CHANGELOG.items.map((it, i) => (
                <li key={i} className="flex gap-2 text-sm text-slate-200 leading-relaxed">
                  <span className="text-emerald-400 shrink-0 mt-px">✓</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
            <button onClick={dismissWhatsNew}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[130] bg-slate-900 border border-slate-700 text-slate-100 text-sm px-4 py-2.5 rounded-xl shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
