import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { readRange, appendRow, batchUpdateCells } from '../lib/sheets';
import { SHEETS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import CommissionPrices from './CommissionPrices';

const STATUS_COLORS = {
  'Completed': 'bg-emerald-900/50 text-emerald-300',
  'completed': 'bg-emerald-900/50 text-emerald-300',
  'Accepted, placed slot': 'bg-blue-900/50 text-blue-300',
  'Undecided': 'bg-slate-700 text-slate-400',
  default: 'bg-amber-900/40 text-amber-300',
};

function statusColor(s) {
  if (!s) return STATUS_COLORS.default;
  if (s.toLowerCase().includes('complete')) return STATUS_COLORS['Completed'];
  if (s.toLowerCase().includes('accept')) return STATUS_COLORS['Accepted, placed slot'];
  if (s.toLowerCase().includes('undecided')) return STATUS_COLORS['Undecided'];
  return STATUS_COLORS.default;
}

// FORMATTED_VALUE dates arrive as "M/D/YYYY" or "YYYY-MM-DD" strings.
function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (str.includes('-')) { const d = new Date(str + 'T12:00:00'); return isNaN(d) ? null : d; }
  const p = str.split('/');
  if (p.length === 3) { const d = new Date(+p[2], +p[0] - 1, +p[1]); return isNaN(d) ? null : d; }
  return null;
}

// A commission counts as outstanding A/R when a price is agreed but not yet
// fully collected, and it isn't cancelled/declined.
function isOutstanding(inq) {
  const agreed = parseFloat(inq['Price Agreed']) || 0;
  const paid = parseFloat(inq['Paid Amount, Method']) || 0;
  const st = (inq['Status'] || '').toLowerCase();
  if (st.includes('cancel') || st.includes('declin')) return false;
  return agreed > 0 && paid < agreed - 0.005;
}

function AddModal({ onSave, onClose }) {
  const [form, setForm] = useState({
    cardName: '', contact: 'Discord', description: '', status: 'Inquired',
    price: '', paid: '', notes: '',
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function handleSubmit(e) {
    e.preventDefault();
    onSave([
      '', // ID will be auto-incremented in sheet or left blank
      form.cardName,
      form.contact,
      form.description,
      form.status,
      form.price ? parseFloat(form.price) : '',
      form.paid ? parseFloat(form.paid) : 0,
      0, // time
      null, null, null,
      form.notes,
    ]);
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[90dvh] overflow-y-auto">
        <div className="flex justify-between items-center">
          <h2 className="text-white font-semibold text-lg">New Inquiry</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Client Name" value={form.cardName} onChange={v => set('cardName', v)} required />
          <div>
            <label className="text-slate-400 text-xs block mb-1">Contact Platform</label>
            <select value={form.contact} onChange={e => set('contact', e.target.value)}
              className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
              <option>Discord</option><option>Telegram</option><option>Email</option><option>Other</option>
            </select>
          </div>
          <Field label="Description" value={form.description} onChange={v => set('description', v)} multiline />
          <Field label="Status" value={form.status} onChange={v => set('status', v)} />
          <Field label="Agreed Price ($)" value={form.price} onChange={v => set('price', v)} type="number" step="0.01" />
          <Field label="Amount Paid ($)" value={form.paid} onChange={v => set('paid', v)} type="number" step="0.01" />
          <Field label="Notes" value={form.notes} onChange={v => set('notes', v)} multiline />
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-slate-700 text-slate-300 text-sm font-medium">Cancel</button>
            <button type="submit" className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium">Add</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, required, type = 'text', step, multiline }) {
  const cls = "w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500";
  return (
    <div>
      <label className="text-slate-400 text-xs block mb-1">{label}</label>
      {multiline
        ? <textarea value={value} onChange={e => onChange(e.target.value)} className={cls + " resize-none h-20"} />
        : <input type={type} step={step} value={value} onChange={e => onChange(e.target.value)} required={required} className={cls} />
      }
    </div>
  );
}

export default function Commissions({ token }) {
  const [tab, setTab] = useState('inquiries'); // 'inquiries' | 'pricing'
  const [inquiries, setInquiries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [verifyTarget, setVerifyTarget] = useState(null); // index awaiting confirm
  const [showAR, setShowAR] = useState(false);
  const navigate = useNavigate();

  function load() {
    setLoading(true);
    readRange(token, `${SHEETS.INQUIRIES}!A1:L50`)
      .then(rows => {
        if (!rows.length) return;
        const [hdr, ...data] = rows;
        setHeaders(hdr);
        const parsed = data
          .map((row, di) => ({ row, di }))      // di is 0-based within data → sheet row = di + 2
          .filter(({ row }) => row[1])
          .map(({ row, di }) => {
            const obj = { _row: di + 2 };
            hdr.slice(0, 12).forEach((h, i) => { obj[h] = row[i] ?? null; });
            return obj;
          });
        setInquiries(parsed);

        // Cache the outstanding-A/R count so the Art nav tab can paint its badge
        // without its own API call (mirrors the Budget over-budget badge pattern).
        try {
          const count = parsed.filter(isOutstanding).length;
          localStorage.setItem('_fin_art_outstanding', JSON.stringify({ count }));
          window.dispatchEvent(new Event('_fin_art_outstanding_update'));
        } catch {}
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { if (token) load(); }, [token]);

  // Column letter (A1) for a header name, or null if absent. Only A–Z needed (≤12 cols).
  function colLetter(name) {
    const i = headers.indexOf(name);
    return i >= 0 && i < 26 ? String.fromCharCode(65 + i) : null;
  }

  // Mark a commission verified-paid: Status→Paid, Paid Amount→agreed, and stamp the
  // verification time into the Completion Date column. Optionally hand off to the
  // Process Income flow (deep-link), pre-filled with the paid amount + Commission source.
  async function verifyPaid(inq, alsoProcess) {
    const agreed = parseFloat(inq['Price Agreed']) || 0;
    const now = new Date();
    const ts = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ` +
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const statusCol = colLetter('Status');
    const paidCol = colLetter('Paid Amount, Method');
    const compCol = colLetter('Completion Date');
    const updates = [];
    if (statusCol) updates.push({ range: `${SHEETS.INQUIRIES}!${statusCol}${inq._row}`, value: 'Paid' });
    if (paidCol && agreed > 0) updates.push({ range: `${SHEETS.INQUIRIES}!${paidCol}${inq._row}`, value: agreed });
    if (compCol) updates.push({ range: `${SHEETS.INQUIRIES}!${compCol}${inq._row}`, value: ts });
    if (!updates.length) { setError('Could not locate the Status column to verify.'); return; }

    setSaving(true);
    setVerifyTarget(null);
    try {
      await batchUpdateCells(token, updates);
      if (alsoProcess && agreed > 0) {
        // One-shot handoff consumed by the Dashboard on mount → opens Process Income.
        localStorage.setItem('_fin_pending_income', JSON.stringify({
          amount: agreed, source: 'Commission', desc: inq['Card Name'] || '', ts: Date.now(),
        }));
        navigate('/');
        return;
      }
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(values) {
    setSaving(true);
    try {
      await appendRow(token, `${SHEETS.INQUIRIES}!A:L`, values);
      setShowModal(false);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Pricing tab renders immediately without waiting for inquiries
  if (tab === 'pricing') {
    return (
      <div className="pb-24">
        <div className="px-4 pt-4 pb-0">
          <div className="flex bg-slate-800 rounded-xl p-1 gap-1 mb-4">
            <button onClick={() => setTab('inquiries')} className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors text-slate-400 hover:text-slate-300">
              Inquiries
            </button>
            <button className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors bg-slate-600 text-white">
              Pricing
            </button>
          </div>
        </div>
        <CommissionPrices token={token} />
      </div>
    );
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;

  const totalPotential = inquiries.reduce((s, i) => s + (parseFloat(i['Price Agreed']) || 0), 0);
  const totalPaid = inquiries.reduce((s, i) => s + (parseFloat(i['Paid Amount, Method']) || 0), 0);

  return (
    <div className="stagger p-4 pb-24 space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-white">Commissions</h1>
          <p className="text-slate-400 text-sm">Client inquiries</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
            <button className="py-1.5 px-3 rounded-lg text-xs font-medium bg-slate-600 text-white">Inquiries</button>
            <button onClick={() => setTab('pricing')} className="py-1.5 px-3 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-300">Pricing</button>
          </div>
          <button onClick={() => setShowModal(true)} className="bg-blue-600 hover:bg-blue-500 text-white rounded-xl px-4 py-2 text-sm font-medium">
            + Add
          </button>
        </div>
      </div>

      {/* Summary */}
      {(() => {
        const outstanding = Math.max(0, totalPotential - totalPaid);
        const collectPct  = totalPotential > 0 ? Math.min((totalPaid / totalPotential) * 100, 100) : 0;
        const collectColor = collectPct >= 80 ? '#10b981' : collectPct >= 50 ? '#f59e0b' : '#f43f5e';
        const completedCount = inquiries.filter(i => (i['Status'] || '').toLowerCase().includes('complet')).length;
        const completePct = inquiries.length > 0 ? (completedCount / inquiries.length) * 100 : 0;
        return (
          <div className="bg-gradient-to-br from-slate-800 via-slate-800 to-slate-900 rounded-2xl border border-slate-700/50 overflow-hidden shadow-lg">
            {/* Top row — two stat blocks */}
            <div className="grid grid-cols-2 divide-x divide-slate-700/50">
              <div className="p-4 space-y-1">
                <p className="text-slate-400 text-[10px] uppercase tracking-widest font-medium">Potential</p>
                <p className="text-white text-2xl font-black tabular-nums">${totalPotential.toFixed(2)}</p>
                <p className="text-slate-500 text-[10px]">{inquiries.length} inquiry{inquiries.length !== 1 ? 's' : ''}</p>
              </div>
              <div className="p-4 space-y-1 bg-emerald-900/10">
                <p className="text-slate-400 text-[10px] uppercase tracking-widest font-medium">Collected</p>
                <p className="text-emerald-400 text-2xl font-black tabular-nums">${totalPaid.toFixed(2)}</p>
                <p className="text-slate-500 text-[10px]">${outstanding.toFixed(2)} outstanding</p>
              </div>
            </div>

            {/* Collection progress bar */}
            <div className="px-4 pb-3 pt-1 space-y-1.5">
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-slate-500 uppercase tracking-wider">Collection Rate</span>
                <span className="font-bold tabular-nums" style={{ color: collectColor }}>{collectPct.toFixed(0)}%</span>
              </div>
              <div className="w-full bg-slate-700/60 rounded-full h-2.5 overflow-hidden">
                <div
                  className="h-2.5 rounded-full transition-all duration-500"
                  style={{ width: `${collectPct}%`, background: `linear-gradient(90deg, ${collectColor}99, ${collectColor})` }}
                />
              </div>
            </div>

            {/* Completion progress bar */}
            {inquiries.length > 0 && (
              <div className="px-4 pb-4 space-y-1.5">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-slate-500 uppercase tracking-wider">Completion</span>
                  <span className="font-bold tabular-nums text-sky-400">{completedCount}/{inquiries.length} done</span>
                </div>
                <div className="w-full bg-slate-700/60 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="h-2.5 rounded-full transition-all duration-500"
                    style={{ width: `${completePct}%`, background: 'linear-gradient(90deg, #0ea5e999, #38bdf8)' }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Outstanding A/R — aged list of agreed-but-unpaid commissions, oldest first */}
      {(() => {
        const ar = inquiries
          .filter(isOutstanding)
          .map(inq => {
            const agreed = parseFloat(inq['Price Agreed']) || 0;
            const paid = parseFloat(inq['Paid Amount, Method']) || 0;
            const started = parseDate(inq['Comm Date']);
            const days = started ? Math.floor((Date.now() - started.getTime()) / 86400000) : null;
            return { inq, remaining: agreed - paid, days };
          })
          .sort((a, b) => (b.days ?? -1) - (a.days ?? -1)); // oldest (most days) first
        if (ar.length === 0) return null;
        const arTotal = ar.reduce((s, x) => s + x.remaining, 0);
        return (
          <div className="bg-amber-900/15 border border-amber-800/30 rounded-2xl overflow-hidden">
            <button onClick={() => setShowAR(v => !v)} className="w-full flex items-center justify-between px-4 py-3 text-left">
              <div>
                <p className="text-amber-300 text-xs uppercase tracking-widest font-semibold">Awaiting Payment</p>
                <p className="text-white text-lg font-bold tabular-nums">${arTotal.toFixed(2)}<span className="text-slate-400 text-xs font-normal"> · {ar.length} commission{ar.length !== 1 ? 's' : ''}</span></p>
              </div>
              <span className="text-amber-400 text-xs">{showAR ? '▲' : '▼'}</span>
            </button>
            {showAR && (
              <div className="px-4 pb-3 space-y-2 border-t border-amber-800/20 pt-2">
                {ar.map((x, k) => (
                  <div key={k} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-slate-200 truncate">{x.inq['Card Name'] || '—'}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {x.days != null && (
                        <span className={`text-[10px] tabular-nums ${x.days >= 30 ? 'text-rose-400' : 'text-slate-500'}`}>{x.days}d</span>
                      )}
                      <span className="text-amber-300 font-semibold tabular-nums">${x.remaining.toFixed(2)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* List */}
      <div className="space-y-3">
        {inquiries.map((inq, i) => {
          const isOpen = expanded === i;
          const paid = parseFloat(inq['Paid Amount, Method']) || 0;
          const agreed = parseFloat(inq['Price Agreed']) || 0;
          const paidPct = agreed > 0 ? Math.min((paid / agreed) * 100, 100) : 0;

          return (
            <div key={i} className="bg-slate-800 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpanded(isOpen ? null : i)}
                className="w-full p-4 text-left"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-white font-medium text-sm">{inq['Card Name']}</p>
                      <span className="text-slate-500 text-xs">{inq['Contact Information']}</span>
                    </div>
                    {inq['Status'] && (
                      <span className={`mt-1 inline-block text-xs px-2 py-0.5 rounded-full font-medium ${statusColor(inq['Status'])}`}>
                        {inq['Status']?.slice(0, 40)}{inq['Status']?.length > 40 ? '…' : ''}
                      </span>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {agreed > 0 && <p className="text-white text-sm font-semibold">${agreed.toFixed(2)}</p>}
                    <p className="text-xs text-slate-500">{isOpen ? '▲' : '▼'}</p>
                  </div>
                </div>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 space-y-3 border-t border-slate-700 pt-3">
                  {inq['desc'] && <p className="text-slate-300 text-sm">{inq['desc']}</p>}
                  {agreed > 0 && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-slate-400">
                        <span>Paid: ${paid.toFixed(2)}</span>
                        <span>{paidPct.toFixed(0)}%</span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-2">
                        <div className="h-2 rounded-full bg-emerald-500" style={{ width: `${paidPct}%` }} />
                      </div>
                    </div>
                  )}
                  {inq['Comm Date'] && <p className="text-slate-500 text-xs">Started: {inq['Comm Date']}</p>}
                  {inq['Completion Date'] && <p className="text-emerald-400/80 text-xs">✓ Verified: {inq['Completion Date']}</p>}
                  {inq['Notes'] && <p className="text-slate-400 text-xs italic">{inq['Notes']}</p>}

                  {/* Verify-paid actions — only when there's an agreed price still outstanding */}
                  {isOutstanding(inq) && (
                    verifyTarget === i ? (
                      <div className="space-y-2 pt-1">
                        <p className="text-slate-300 text-xs">Mark <span className="font-semibold">${agreed.toFixed(2)}</span> as paid &amp; verified now?</p>
                        <div className="flex gap-2">
                          <button onClick={() => verifyPaid(inq, false)}
                            className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium">
                            ✓ Verify Paid
                          </button>
                          <button onClick={() => verifyPaid(inq, true)}
                            className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium">
                            ✓ Verify &amp; Process
                          </button>
                          <button onClick={() => setVerifyTarget(null)}
                            className="px-3 py-2 rounded-lg bg-slate-700 text-slate-300 text-xs font-medium">
                            Cancel
                          </button>
                        </div>
                        <p className="text-slate-500 text-[10px] leading-snug">“Process” logs this as income in the budget (pre-filled, tagged Commission).</p>
                      </div>
                    ) : (
                      <button onClick={() => setVerifyTarget(i)}
                        className="w-full py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-emerald-300 text-xs font-medium">
                        Mark Paid…
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          );
        })}
        {inquiries.length === 0 && <p className="text-slate-500 text-center py-8">No inquiries yet</p>}
      </div>

      {showModal && <AddModal onSave={handleSave} onClose={() => setShowModal(false)} />}
      {saving && <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"><LoadingSpinner /></div>}
    </div>
  );
}
