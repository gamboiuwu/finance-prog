import { useState } from 'react';
import { batchUpdateCells } from '../lib/sheets';
import { SHEETS } from '../config';
import { getTemplate, peekOrderNo, nextOrderNo, getShipFrom, hasEasyPost } from '../lib/orders';
import { createShipment, buyShipment } from '../lib/easypost';

const field = "w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 placeholder-slate-600";
const lbl   = "text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5";

const todayStr = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const addrReady = a => a.street1 && a.city && a.state && a.zip;

export default function OrderModal({ tx, product, token, onClose, onSaved }) {
  const existing = tx.order || {};
  const tpl = product ? getTemplate(product) : null;

  const [orderNo, setOrderNo] = useState(existing.orderNo || '');
  const [status,  setStatus]  = useState(existing.status || 'unfulfilled');
  const [notes,   setNotes]   = useState(existing.notes || '');
  const [to, setTo] = useState(() => ({
    name: '', email: '', phone: '', street1: '', street2: '', city: '', state: '', zip: '', country: 'US',
    ...(existing.to || { name: tx.client || '' }),
  }));
  const [parcel, setParcel] = useState(() => existing.parcel || tpl?.parcel || { weight: 3, length: 6, width: 4, height: 1 });
  const [shipping, setShipping] = useState(() => existing.shipping || {});

  const [rates, setRates]             = useState([]);
  const [shipmentId, setShipmentId]   = useState('');
  const [selectedRate, setSelectedRate] = useState('');
  const [rateLoading, setRateLoading] = useState(false);
  const [buying, setBuying]           = useState(false);
  const [shipErr, setShipErr]         = useState(null);
  const [saving, setSaving]           = useState(false);
  const [saveErr, setSaveErr]         = useState(null);

  const setT = (k, v) => setTo(p => ({ ...p, [k]: v }));
  const setP = (k, v) => setParcel(p => ({ ...p, [k]: v }));
  const setS = (k, v) => setShipping(p => ({ ...p, [k]: v }));
  const numParcel = {
    weight: Number(parcel.weight) || 0, length: Number(parcel.length) || 0,
    width:  Number(parcel.width)  || 0, height: Number(parcel.height) || 0,
  };

  async function getRates() {
    setShipErr(null);
    const from = getShipFrom();
    if (!addrReady(from)) { setShipErr('Add your ship-from address in Shipping Setup first.'); return; }
    if (!addrReady(to))   { setShipErr('Enter the customer’s street, city, state and ZIP.'); return; }
    if (!numParcel.weight) { setShipErr('Set a package weight (oz).'); return; }
    setRateLoading(true);
    try {
      const sh = await createShipment({ to, from, parcel: numParcel });
      setShipmentId(sh.id);
      const carrier = tpl?.carrier, service = tpl?.service;
      let list = [...(sh.rates || [])];
      if (carrier) { const f = list.filter(r => r.carrier === carrier); if (f.length) list = f; }
      if (service) { const f = list.filter(r => r.service === service); if (f.length) list = f; }
      list.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
      setRates(list);
      setSelectedRate(list[0]?.id || '');
      if (!list.length) setShipErr('No rates came back for that address/package.');
    } catch (e) { setShipErr(e.message); }
    finally { setRateLoading(false); }
  }

  async function buy() {
    if (!shipmentId || !selectedRate) return;
    setBuying(true); setShipErr(null);
    try {
      const bought = await buyShipment(shipmentId, selectedRate);
      const r = rates.find(x => x.id === selectedRate);
      setShipping(s => ({
        ...s,
        carrier: bought.selected_rate?.carrier || r?.carrier || '',
        service: bought.selected_rate?.service || r?.service || '',
        rate:    bought.selected_rate?.rate    || r?.rate    || '',
        tracking:    bought.tracking_code || '',
        trackingUrl: bought.tracker?.public_url || '',
        labelUrl:    bought.postage_label?.label_url || '',
        shipmentId:  bought.id,
      }));
      setRates([]);
    } catch (e) { setShipErr(e.message); }
    finally { setBuying(false); }
  }

  async function save() {
    setSaving(true); setSaveErr(null);
    try {
      const order = {
        orderNo: orderNo.trim() || nextOrderNo(product),
        status,
        fulfilledAt: status === 'fulfilled' ? (existing.fulfilledAt || todayStr()) : '',
        to,
        parcel: numParcel,
        shipping,
        notes: notes.trim(),
        updatedAt: todayStr(),
      };
      await batchUpdateCells(token, [
        { range: `${SHEETS.BUSINESS_TRANSACTIONS}!I${tx.rowNum}`, value: JSON.stringify(order) },
      ]);
      onSaved?.();
      onClose();
    } catch (e) { setSaveErr(e.message); setSaving(false); }
  }

  const placeholder = product ? peekOrderNo(product) : 'ORD-0001';
  const cheapest = rates[0];

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50">
      <div className="bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92dvh] flex flex-col">
        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-white font-bold font-broske truncate">📦 Order — {tx.product}</h3>
            <p className="text-slate-400 text-xs mt-0.5">${tx.revenue.toFixed(2)} · {tx.date || 'no date'}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center shrink-0">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Order number + fulfillment status */}
          <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
            <div>
              <label className={lbl}>Order number</label>
              <input className={`${field} font-mono`} value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder={`auto: ${placeholder}`} />
            </div>
            <div>
              <label className={lbl}>Status</label>
              <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
                {[['unfulfilled', '◷ Unfulfilled'], ['fulfilled', '✓ Done']].map(([v, t]) => (
                  <button key={v} onClick={() => setStatus(v)}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
                      status === v ? (v === 'fulfilled' ? 'bg-emerald-600 text-white' : 'bg-amber-600 text-white') : 'text-slate-400 hover:text-slate-300'
                    }`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Customer + shipping address */}
          <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
            <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Ship to</p>
            <div className="grid grid-cols-2 gap-2">
              <div><label className={lbl}>Name</label><input className={field} value={to.name} onChange={e => setT('name', e.target.value)} /></div>
              <div><label className={lbl}>Phone</label><input className={field} value={to.phone} onChange={e => setT('phone', e.target.value)} /></div>
            </div>
            <div><label className={lbl}>Email <span className="text-slate-600 normal-case">(for tracking updates)</span></label>
              <input className={field} value={to.email} onChange={e => setT('email', e.target.value)} /></div>
            <div><label className={lbl}>Street</label><input className={field} value={to.street1} onChange={e => setT('street1', e.target.value)} /></div>
            <div><label className={lbl}>Apt / Unit <span className="text-slate-600 normal-case">(optional)</span></label>
              <input className={field} value={to.street2} onChange={e => setT('street2', e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className={lbl}>City</label><input className={field} value={to.city} onChange={e => setT('city', e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className={lbl}>State</label><input className={field} value={to.state} onChange={e => setT('state', e.target.value)} maxLength={2} /></div>
                <div><label className={lbl}>ZIP</label><input className={field} value={to.zip} onChange={e => setT('zip', e.target.value)} /></div>
              </div>
            </div>
          </div>

          {/* Package */}
          <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
            <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Package</p>
            <div className="grid grid-cols-4 gap-2">
              <div><label className={lbl}>Wt (oz)</label><input className={field} type="number" min="0" step="0.1" value={parcel.weight} onChange={e => setP('weight', e.target.value)} /></div>
              <div><label className={lbl}>L (in)</label><input className={field} type="number" min="0" step="0.1" value={parcel.length} onChange={e => setP('length', e.target.value)} /></div>
              <div><label className={lbl}>W (in)</label><input className={field} type="number" min="0" step="0.1" value={parcel.width} onChange={e => setP('width', e.target.value)} /></div>
              <div><label className={lbl}>H (in)</label><input className={field} type="number" min="0" step="0.1" value={parcel.height} onChange={e => setP('height', e.target.value)} /></div>
            </div>
          </div>

          {/* Shipping label */}
          <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Buy a label (EasyPost)</p>
              {hasEasyPost() && !shipping.tracking && (
                <button onClick={getRates} disabled={rateLoading}
                  className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold transition-colors">
                  {rateLoading ? 'Shopping rates…' : '🔍 Compare rates'}
                </button>
              )}
            </div>

            {!hasEasyPost() && (
              <p className="text-xs text-slate-500 leading-relaxed">
                Connect EasyPost in <span className="text-slate-300">Shipping Setup</span> to buy discounted labels here.
                Or paste a tracking number from any carrier below.
              </p>
            )}

            {shipErr && <p className="text-rose-400 text-xs">{shipErr}</p>}

            {rates.length > 0 && (
              <div className="space-y-1.5">
                {rates.map(r => {
                  const sel = r.id === selectedRate;
                  const best = cheapest && r.id === cheapest.id;
                  return (
                    <button key={r.id} onClick={() => setSelectedRate(r.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                        sel ? 'border-cyan-500 bg-cyan-900/20' : 'border-slate-700 bg-slate-800 hover:border-slate-600'}`}>
                      <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${sel ? 'border-cyan-400 bg-cyan-400' : 'border-slate-500'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium truncate">{r.carrier} {r.service}</p>
                        {r.delivery_days && <p className="text-slate-500 text-[11px]">~{r.delivery_days} day{r.delivery_days > 1 ? 's' : ''}</p>}
                      </div>
                      {best && <span className="text-[9px] font-bold uppercase bg-emerald-600 text-white px-1.5 py-0.5 rounded shrink-0">Best deal</span>}
                      <span className="text-white font-mono font-bold tabular-nums shrink-0">${parseFloat(r.rate).toFixed(2)}</span>
                    </button>
                  );
                })}
                <button onClick={buy} disabled={buying || !selectedRate}
                  className="w-full mt-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm transition-colors">
                  {buying ? 'Buying label…' : `Buy cheapest label · $${parseFloat(rates.find(r => r.id === selectedRate)?.rate || 0).toFixed(2)}`}
                </button>
              </div>
            )}

            {shipping.tracking && (
              <div className="bg-slate-900 rounded-xl p-3 space-y-1.5">
                <p className="text-emerald-400 text-xs font-bold">🚚 {shipping.carrier} {shipping.service}{shipping.rate ? ` · $${parseFloat(shipping.rate).toFixed(2)}` : ''}</p>
                <p className="text-slate-300 text-xs font-mono break-all">{shipping.tracking}</p>
                <div className="flex gap-2 pt-1">
                  {shipping.labelUrl && <a href={shipping.labelUrl} target="_blank" rel="noreferrer" className="text-cyan-400 text-xs underline">Print label</a>}
                  {shipping.trackingUrl && <a href={shipping.trackingUrl} target="_blank" rel="noreferrer" className="text-cyan-400 text-xs underline">Track</a>}
                </div>
              </div>
            )}

            {/* Manual tracking — always available */}
            <details className="text-xs">
              <summary className="text-slate-500 cursor-pointer">Enter a tracking number manually</summary>
              <div className="grid grid-cols-3 gap-2 mt-2">
                <div><label className={lbl}>Carrier</label><input className={field} value={shipping.carrier || ''} onChange={e => setS('carrier', e.target.value)} placeholder="USPS" /></div>
                <div className="col-span-2"><label className={lbl}>Tracking #</label><input className={field} value={shipping.tracking || ''} onChange={e => setS('tracking', e.target.value)} /></div>
              </div>
            </details>
          </div>

          {/* Notes */}
          <div>
            <label className={lbl}>Notes</label>
            <textarea className={`${field} resize-none`} rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Gift wrap, special instructions…" />
          </div>

          {saveErr && <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-xs">{saveErr}</div>}
        </div>

        <div className="shrink-0 px-5 py-4 border-t border-slate-800 safe-area-bottom flex gap-2">
          <button onClick={onClose} disabled={saving} className="flex-1 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={saving} className="flex-1 py-3 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-bold text-sm transition-colors">
            {saving ? 'Saving…' : 'Save order'}
          </button>
        </div>
      </div>
    </div>
  );
}
