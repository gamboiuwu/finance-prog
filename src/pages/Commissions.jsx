import { useEffect, useState } from 'react';
import { readRange, appendRow } from '../lib/sheets';
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
      <div className="bg-slate-800 rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[90vh] overflow-y-auto">
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

  function load() {
    setLoading(true);
    readRange(token, `${SHEETS.INQUIRIES}!A1:L50`)
      .then(rows => {
        if (!rows.length) return;
        const [headers, ...data] = rows;
        const parsed = data
          .filter(r => r[1])
          .map(row => {
            const obj = {};
            headers.slice(0, 12).forEach((h, i) => { obj[h] = row[i] ?? null; });
            return obj;
          });
        setInquiries(parsed);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { if (token) load(); }, [token]);

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
    <div className="p-4 pb-24 space-y-4">
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
      <div className="bg-slate-800 rounded-2xl p-4 grid grid-cols-2 gap-4">
        <div>
          <p className="text-slate-400 text-xs uppercase tracking-wider">Potential</p>
          <p className="text-white text-xl font-bold mt-1">${totalPotential.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs uppercase tracking-wider">Paid</p>
          <p className="text-emerald-400 text-xl font-bold mt-1">${totalPaid.toFixed(2)}</p>
        </div>
      </div>

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
