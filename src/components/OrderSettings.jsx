import { useState } from 'react';
import {
  getTemplate, saveTemplate, getShipFrom, saveShipFrom,
  getEasyPost, saveEasyPost,
} from '../lib/orders';

const field = "w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 placeholder-slate-600";
const lbl   = "text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5";

function Sheet({ title, subtitle, onClose, children, footer }) {
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50">
      <div className="bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92dvh] flex flex-col">
        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold font-broske">{title}</h3>
            {subtitle && <p className="text-slate-400 text-xs mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">{children}</div>
        <div className="shrink-0 px-5 py-4 border-t border-slate-800 safe-area-bottom">{footer}</div>
      </div>
    </div>
  );
}

// ── Per-product order template editor (Shopify-style order settings) ───────────
export function OrderTemplateModal({ product, onClose }) {
  const [t, setT] = useState(() => getTemplate(product));
  const set   = (k, v) => setT(prev => ({ ...prev, [k]: v }));
  const setP  = (k, v) => setT(prev => ({ ...prev, parcel: { ...prev.parcel, [k]: v } }));
  const preview = `${t.prefix || 'ORD'}-${String(Number(t.nextNumber) || 1).padStart(Number(t.pad) || 1, '0')}`;

  function save() {
    saveTemplate(product, {
      ...t,
      pad: Number(t.pad) || 1,
      nextNumber: Number(t.nextNumber) || 1,
      parcel: {
        weight: Number(t.parcel.weight) || 0, length: Number(t.parcel.length) || 0,
        width:  Number(t.parcel.width)  || 0, height: Number(t.parcel.height) || 0,
      },
    });
    onClose();
  }

  return (
    <Sheet
      title={`Order Template — ${product.name}`}
      subtitle="Defaults applied when you turn a sale into a trackable order"
      onClose={onClose}
      footer={
        <button onClick={save} className="w-full py-3 rounded-xl bg-green-600 hover:bg-green-500 text-white font-bold text-sm transition-colors">
          Save template
        </button>
      }
    >
      <label className="flex items-center gap-2.5 text-sm text-slate-200">
        <input type="checkbox" checked={t.enabled} onChange={e => set('enabled', e.target.checked)} className="accent-green-500 w-4 h-4" />
        Use a template for {product.name}
      </label>

      <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
        <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Order number</p>
        <div className="grid grid-cols-3 gap-2">
          <div><label className={lbl}>Prefix</label>
            <input className={field} value={t.prefix} onChange={e => set('prefix', e.target.value.toUpperCase())} maxLength={6} /></div>
          <div><label className={lbl}>Digits</label>
            <input className={field} type="number" min="1" max="8" value={t.pad} onChange={e => set('pad', e.target.value)} /></div>
          <div><label className={lbl}>Next #</label>
            <input className={field} type="number" min="1" value={t.nextNumber} onChange={e => set('nextNumber', e.target.value)} /></div>
        </div>
        <p className="text-xs text-slate-500">Next order will be <span className="font-mono text-green-400 font-bold">{preview}</span></p>
      </div>

      <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
        <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Default package</p>
        <div className="grid grid-cols-4 gap-2">
          <div><label className={lbl}>Wt (oz)</label>
            <input className={field} type="number" min="0" step="0.1" value={t.parcel.weight} onChange={e => setP('weight', e.target.value)} /></div>
          <div><label className={lbl}>L (in)</label>
            <input className={field} type="number" min="0" step="0.1" value={t.parcel.length} onChange={e => setP('length', e.target.value)} /></div>
          <div><label className={lbl}>W (in)</label>
            <input className={field} type="number" min="0" step="0.1" value={t.parcel.width} onChange={e => setP('width', e.target.value)} /></div>
          <div><label className={lbl}>H (in)</label>
            <input className={field} type="number" min="0" step="0.1" value={t.parcel.height} onChange={e => setP('height', e.target.value)} /></div>
        </div>
      </div>

      <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
        <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Default shipping</p>
        <div className="grid grid-cols-2 gap-2">
          <div><label className={lbl}>Carrier</label>
            <select className={field} value={t.carrier} onChange={e => set('carrier', e.target.value)}>
              <option value="">Cheapest (any carrier)</option>
              <option value="USPS">USPS</option>
              <option value="UPS">UPS</option>
              <option value="FedEx">FedEx</option>
              <option value="DHLExpress">DHL Express</option>
            </select></div>
          <div><label className={lbl}>Service <span className="text-slate-600 normal-case">(optional)</span></label>
            <input className={field} value={t.service} onChange={e => set('service', e.target.value)} placeholder="e.g. First, Priority" /></div>
        </div>
        <p className="text-[11px] text-slate-500">Leave carrier on “Cheapest” to let EasyPost shop every carrier for the best discounted rate.</p>
      </div>
    </Sheet>
  );
}

// ── Shipping setup: EasyPost proxy + key + ship-from address ───────────────────
export function ShippingSetupModal({ onClose }) {
  const [ep, setEp]     = useState(() => getEasyPost());
  const [from, setFrom] = useState(() => getShipFrom());
  const setF = (k, v) => setFrom(prev => ({ ...prev, [k]: v }));

  function save() {
    saveEasyPost(ep);
    saveShipFrom(from);
    onClose();
  }

  return (
    <Sheet
      title="Shipping Setup"
      subtitle="EasyPost connection + the address you ship from"
      onClose={onClose}
      footer={
        <button onClick={save} className="w-full py-3 rounded-xl bg-green-600 hover:bg-green-500 text-white font-bold text-sm transition-colors">
          Save shipping settings
        </button>
      }
    >
      <div className="bg-amber-900/20 border border-amber-800/40 rounded-2xl p-3.5 text-amber-200/90 text-xs leading-relaxed">
        EasyPost blocks direct browser calls, so labels are bought through a tiny
        proxy you deploy once (free Cloudflare Worker). Setup steps are in
        <span className="font-mono text-amber-300"> easypost-proxy/README.md</span> in the repo.
        Order tracking and manual tracking numbers work without any of this.
      </div>

      <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
        <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">EasyPost connection</p>
        <div>
          <label className={lbl}>Proxy URL</label>
          <input className={field} value={ep.proxyUrl} onChange={e => setEp(p => ({ ...p, proxyUrl: e.target.value }))}
            placeholder="https://easypost-proxy.you.workers.dev" />
        </div>
        <div>
          <label className={lbl}>EasyPost API key <span className="text-slate-600 normal-case">(only if your proxy doesn’t hold it)</span></label>
          <input className={field} type="password" value={ep.key} onChange={e => setEp(p => ({ ...p, key: e.target.value }))}
            placeholder="EZAK… (kept only on this device)" />
        </div>
      </div>

      <div className="bg-slate-800/60 rounded-2xl p-4 space-y-3">
        <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Ship from</p>
        <div><label className={lbl}>Name</label>
          <input className={field} value={from.name} onChange={e => setF('name', e.target.value)} /></div>
        <div><label className={lbl}>Street</label>
          <input className={field} value={from.street1} onChange={e => setF('street1', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className={lbl}>City</label>
            <input className={field} value={from.city} onChange={e => setF('city', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className={lbl}>State</label>
              <input className={field} value={from.state} onChange={e => setF('state', e.target.value)} maxLength={2} /></div>
            <div><label className={lbl}>ZIP</label>
              <input className={field} value={from.zip} onChange={e => setF('zip', e.target.value)} /></div>
          </div>
        </div>
        <div><label className={lbl}>Phone</label>
          <input className={field} value={from.phone} onChange={e => setF('phone', e.target.value)} placeholder="for carrier contact" /></div>
      </div>
    </Sheet>
  );
}

// ── Pick which product's template to edit ─────────────────────────────────────
export function TemplatesPickerModal({ products, onPick, onClose }) {
  return (
    <Sheet title="Order Templates" subtitle="Pick a product to set up its order numbering & shipping" onClose={onClose} footer={
      <button onClick={onClose} className="w-full py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors">Close</button>
    }>
      {products.length === 0 && <p className="text-slate-500 text-sm text-center py-6">No products yet — add one on the Products tab first.</p>}
      {products.map(p => (
        <button key={p.id || p.name} onClick={() => onPick(p)}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-left transition-colors">
          <span className="text-white text-sm font-medium truncate">{p.name}</span>
          <span className="text-slate-500 text-xs shrink-0">edit →</span>
        </button>
      ))}
    </Sheet>
  );
}
