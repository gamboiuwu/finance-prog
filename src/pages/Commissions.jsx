import { useEffect, useState } from 'react';
import { readRange, appendRow, batchUpdateCells } from '../lib/sheets';
import { SHEETS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import CommissionPrices from './CommissionPrices';

// ── Task 12 helpers ─────────────────────────────────────────────────────────
// An inquiry is "outstanding" once a price is agreed but it isn't fully paid and
// isn't marked complete. This is the basis for both the ✦ Art nav badge and the
// aged A/R list.
function isOutstanding(inq) {
  const agreed = parseFloat(inq['Price Agreed']) || 0;
  const paid = parseFloat(inq['Paid Amount, Method']) || 0;
  const completed = (inq['Status'] || '').toLowerCase().includes('complet');
  return agreed > 0 && paid < agreed - 0.005 && !completed;
}

// Parse a sheet date (serial number, YYYY-MM-DD, or M/D/YYYY) to a Date, else null.
function parseCommDate(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') {
    // Google Sheets serial date: days since 1899-12-30
    return new Date(Date.UTC(1899, 11, 30) + val * 86400000);
  }
  const s = String(val).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return new Date(y, +m[1] - 1, +m[2]);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Art-income tag matcher: descriptions prefixed "[Commission]" or "[Art]" (Task 27 source tags).
const ART_TAG_RE = /^\[(commission|art)\]/i;

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
  const [artIncome, setArtIncome] = useState(null); // { month, all } or null while loading
  const [marking, setMarking] = useState(null);     // sheet row currently being marked paid

  function load() {
    setLoading(true);
    readRange(token, `${SHEETS.INQUIRIES}!A1:L50`)
      .then(rows => {
        if (!rows.length) return;
        const [headers, ...data] = rows;
        const parsed = data
          // Preserve the real sheet-row number (header is row 1) so writes target the right row.
          .map((row, idx) => ({ row, sheetRow: idx + 2 }))
          .filter(({ row }) => row[1])
          .map(({ row, sheetRow }) => {
            const obj = { _row: sheetRow };
            headers.slice(0, 12).forEach((h, i) => { obj[h] = row[i] ?? null; });
            return obj;
          });
        setInquiries(parsed);
        // Cache the outstanding count for the ✦ Art nav badge (no $ amounts stored).
        const count = parsed.filter(isOutstanding).length;
        try {
          localStorage.setItem('_fin_art_outstanding', JSON.stringify({ count }));
          window.dispatchEvent(new Event('_fin_art_outstanding_update'));
        } catch {}
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  // This-month + all-time art income = Allocation Transactions tagged [Commission]/[Art].
  function loadArtIncome() {
    readRange(token, `${SHEETS.ALLOCATION_TRANSACTIONS}!A:F`, 'UNFORMATTED_VALUE')
      .then(rows => {
        const now = new Date();
        let month = 0, all = 0;
        (rows || []).slice(1).forEach(r => {
          const desc = String(r[3] ?? '');
          if (!ART_TAG_RE.test(desc.trim())) return;
          const amt = parseFloat(r[2]) || 0;
          if (amt <= 0) return; // income deposits only
          all += amt;
          const d = parseCommDate(r[0]);
          if (d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) month += amt;
        });
        setArtIncome({ month, all });
      })
      .catch(() => setArtIncome({ month: 0, all: 0 }));
  }

  useEffect(() => { if (token) { load(); loadArtIncome(); } }, [token]);

  // Mark a commission as fully paid: Status → Completed, Paid Amount → Price Agreed.
  // Writes back to the inquiry's own sheet row (no deposit is created here — logging the
  // deposit via Process Income is a deliberate follow-up pending the owner's choice).
  async function markPaid(inq) {
    const agreed = parseFloat(inq['Price Agreed']) || 0;
    if (!agreed) return;
    if (!window.confirm(`Mark "${inq['Card Name']}" as paid in full ($${agreed.toFixed(2)})?`)) return;
    setMarking(inq._row);
    try {
      await batchUpdateCells(token, [
        { range: `${SHEETS.INQUIRIES}!E${inq._row}`, value: 'Completed' },       // Status
        { range: `${SHEETS.INQUIRIES}!G${inq._row}`, value: agreed },             // Paid Amount, Method
      ]);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setMarking(null);
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
          {artIncome && artIncome.all > 0
            ? <p className="text-slate-400 text-sm">
                <span className="text-emerald-400 font-semibold">${artIncome.month.toFixed(2)}</span> art income this month
                <span className="text-slate-600"> · </span>
                <span className="text-slate-500">${artIncome.all.toFixed(2)} all-time</span>
              </p>
            : <p className="text-slate-400 text-sm">Client inquiries</p>}
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

      {/* Aged accounts-receivable — outstanding commissions, oldest first */}
      {(() => {
        const outstanding = inquiries
          .filter(isOutstanding)
          .map(inq => {
            const agreed = parseFloat(inq['Price Agreed']) || 0;
            const paid = parseFloat(inq['Paid Amount, Method']) || 0;
            const d = parseCommDate(inq['Comm Date']);
            const ageDays = d ? Math.floor((Date.now() - d.getTime()) / 86400000) : null;
            return { inq, remaining: agreed - paid, ageDays };
          })
          .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
        if (outstanding.length === 0) return null;
        const totalDue = outstanding.reduce((s, o) => s + o.remaining, 0);
        return (
          <div className="bg-amber-900/10 border border-amber-800/40 rounded-2xl p-4 space-y-2.5">
            <div className="flex justify-between items-center">
              <p className="text-amber-300 text-xs font-semibold uppercase tracking-wider">Awaiting payment</p>
              <p className="text-amber-300 text-sm font-bold tabular-nums">${totalDue.toFixed(2)} · {outstanding.length}</p>
            </div>
            <div className="space-y-1.5">
              {outstanding.map((o, i) => (
                <div key={i} className="flex justify-between items-center text-xs">
                  <span className="text-slate-300 truncate min-w-0">{o.inq['Card Name']}</span>
                  <span className="flex items-center gap-2 shrink-0 ml-2">
                    {o.ageDays != null && (
                      <span className={o.ageDays >= 30 ? 'text-rose-400' : 'text-slate-500'}>{o.ageDays}d</span>
                    )}
                    <span className="text-white font-medium tabular-nums">${o.remaining.toFixed(2)}</span>
                  </span>
                </div>
              ))}
            </div>
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
                  {inq['Completion Date'] && <p className="text-slate-500 text-xs">Completed: {inq['Completion Date']}</p>}
                  {inq['Notes'] && <p className="text-slate-400 text-xs italic">{inq['Notes']}</p>}
                  {isOutstanding(inq) && (
                    <button
                      onClick={() => markPaid(inq)}
                      disabled={marking === inq._row}
                      className="w-full py-2 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
                    >
                      {marking === inq._row ? 'Saving…' : `✓ Mark Paid ($${(agreed - paid).toFixed(2)} due)`}
                    </button>
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
