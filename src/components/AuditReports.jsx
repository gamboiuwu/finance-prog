import { useEffect, useState, useCallback } from 'react';

// Audit & statements: generate the year's audit PDFs from the phone and open them.
// Talks to the local tracker's /reports/api (audit-runner.mjs): status, generate, log.
// Local backend only - there is nothing to generate against Google.
const STATUS_CLS = { PASS: 'text-emerald-400', WARN: 'text-amber-300', INFO: 'text-sky-300', FAIL: 'text-rose-400' };

export default function AuditReports() {
  const [open, setOpen]     = useState(() => { try { return localStorage.getItem('_fin_audit_open') === '1'; } catch { return false; } });
  const [st, setSt]         = useState(null);
  const [year, setYear]     = useState(new Date().getFullYear());
  const [err, setErr]       = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog]       = useState('');
  const [showControls, setShowControls] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/reports/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setSt(await r.json()); setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { try { localStorage.setItem('_fin_audit_open', open ? '1' : '0'); } catch {} }, [open]);

  // Poll while a run is in progress (a run takes ~10-20 s: export, statements, 10 PDFs).
  const running = st?.job?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { refresh(); if (showLog) fetchLog(); }, 1500);
    return () => clearInterval(t);
  }, [running, refresh, showLog]);

  async function fetchLog() {
    try { setLog(await (await fetch('/reports/api/log', { cache: 'no-store' })).text()); } catch {}
  }
  async function generate() {
    setErr(null);
    try {
      const r = await fetch(`/reports/api/generate?year=${year}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setShowLog(true); fetchLog(); refresh();
    } catch (e) { setErr(e.message); }
  }

  const cur = st?.years?.find(y => y.year === year);
  const years = Array.from(new Set([...(st?.years?.map(y => y.year) || []), st?.currentYear || new Date().getFullYear()])).sort((a, b) => b - a);
  const job = st?.job;
  const docLabel = (d) => d.startsWith('Audit') ? 'Audit — controls, exceptions, reconciliation'
    : d.startsWith('Register') ? 'Register — every transaction, running balance'
    : d.replace(/^Statement-(\d{4})-(\d{2})\.pdf$/, (_, y, m) => `Statement — ${new Date(+y, +m - 1, 1).toLocaleString('en-US', { month: 'long' })} ${y}`);

  return (
    <div className="bg-slate-800 rounded-2xl border border-slate-700/40 overflow-hidden">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full text-left px-4 py-3 flex items-center gap-3">
        <span className="text-lg" aria-hidden="true">📄</span>
        <div className="flex-1 min-w-0">
          <p className="text-slate-200 text-sm font-medium font-broske">Audit &amp; statements</p>
          <p className="text-[11px] text-slate-500 truncate">
            {running ? <span className="text-amber-300">Generating {job.year} · {job.step}…</span>
              : cur ? <>Last {cur.generated} · <span className={STATUS_CLS[cur.overall]}>{cur.overall}</span> · {cur.documents.length} PDFs</>
              : st ? 'No audit yet for this year — generate one' : err ? `unavailable (${err})` : 'loading…'}
          </p>
        </div>
        <span className="text-slate-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-700/40 pt-3">
          <div className="flex items-center gap-2">
            <select value={year} onChange={e => setYear(Number(e.target.value))} aria-label="Audit year"
              className="bg-slate-900 text-white rounded-lg px-2 py-2 text-sm outline-none border border-slate-700">
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={generate} disabled={running}
              className="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
              {running ? `Generating… (${job.step})` : `Generate ${year} audit`}
            </button>
            <button onClick={() => { setShowLog(v => !v); if (!showLog) fetchLog(); }}
              className="px-3 py-2 rounded-xl bg-slate-700 text-slate-300 text-xs">{showLog ? 'Hide log' : 'Log'}</button>
          </div>
          <p className="text-[11px] text-slate-500">
            Re-exports the books, reconciles, and prints the year: one Audit, one Register, one Statement per month. Every row of the year, with its sheet row number. Runs nightly at 04:50 too.
          </p>
          {err && <p className="text-rose-400 text-xs">{err}</p>}
          {showLog && (
            <pre className="bg-slate-950 rounded-lg p-2 text-[10px] text-slate-400 max-h-40 overflow-auto whitespace-pre-wrap">{log || (job?.tail || []).join('\n') || '—'}</pre>
          )}

          {cur && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-slate-400 text-xs">
                  {cur.year} · generated {cur.generated} · data {cur.data?.hash} · {cur.data?.rows} rows
                </p>
                <span className={`text-xs font-bold ${STATUS_CLS[cur.overall]}`}>{cur.overall}</span>
              </div>
              <button onClick={() => setShowControls(v => !v)} className="text-left w-full">
                <div className="flex flex-wrap gap-1">
                  {cur.controls.map(c => (
                    <span key={c.id} title={`${c.name}: ${c.summary}`}
                      className={`text-[10px] px-1.5 py-0.5 rounded-full bg-slate-900 border border-slate-700 ${STATUS_CLS[c.status]}`}>{c.id} {c.status}</span>
                  ))}
                </div>
              </button>
              {showControls && (
                <ul className="text-[11px] space-y-1">
                  {cur.controls.map(c => (
                    <li key={c.id} className="flex gap-2"><span className={`w-16 shrink-0 font-mono ${STATUS_CLS[c.status]}`}>{c.id} {c.status}</span><span className="text-slate-300">{c.name} — <span className="text-slate-500">{c.summary}</span></span></li>
                  ))}
                </ul>
              )}
              <ul className="divide-y divide-slate-700/40">
                {cur.documents.map(d => (
                  <li key={d} className="flex items-center gap-2 py-1.5">
                    <a href={`/reports/${cur.year}/${d}`} target="_blank" rel="noopener" className="flex-1 min-w-0 text-sky-300 text-sm truncate">{docLabel(d)}</a>
                    <a href={`/reports/${cur.year}/${d.replace(/\.pdf$/, '.html')}`} target="_blank" rel="noopener" className="text-[10px] text-slate-500">html</a>
                    <a href={`/reports/${cur.year}/${d}`} download className="text-[10px] px-2 py-1 rounded-lg bg-slate-700 text-slate-300">PDF</a>
                  </li>
                ))}
              </ul>
              <a href={`/reports/${cur.year}/`} target="_blank" rel="noopener" className="text-[11px] text-slate-500 hover:text-slate-300">Open the report index →</a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
