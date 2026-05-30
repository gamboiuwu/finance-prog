import { useState } from 'react';
import { OrderTemplateModal, ShippingSetupModal, TemplatesPickerModal } from './OrderSettings';
import SetupTutorial from './SetupTutorial';
import { hasEasyPost, getShipFrom, getTemplates } from '../lib/orders';

// Settings hub for the Business tab. Opens the focused config modals (shipping,
// templates) and the in-app setup tutorial, and shows at-a-glance status so the
// user knows what's left to connect.
function StatusChip({ ok, okText, offText }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0 ${
      ok ? 'bg-emerald-600/20 text-emerald-300 border-emerald-600/40' : 'bg-amber-600/20 text-amber-300 border-amber-600/40'}`}>
      {ok ? okText : offText}
    </span>
  );
}

function Card({ icon, title, desc, chip, onClick }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-left transition-colors">
      <span className="text-2xl shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white text-sm font-semibold">{title}</p>
          {chip}
        </div>
        <p className="text-slate-500 text-xs mt-0.5">{desc}</p>
      </div>
      <span className="text-slate-600 shrink-0">→</span>
    </button>
  );
}

export default function BusinessSettings({ products, onClose }) {
  const [sub, setSub] = useState(null);            // 'ship' | 'templates' | 'tutorial'
  const [tplProduct, setTplProduct] = useState(null);

  // Focused sub-modals render in place of the hub.
  if (sub === 'tutorial') return <SetupTutorial onClose={() => setSub(null)} />;
  if (sub === 'ship')     return <ShippingSetupModal onClose={() => setSub(null)} />;
  if (sub === 'templates') {
    if (tplProduct) return <OrderTemplateModal product={tplProduct} onClose={() => setTplProduct(null)} />;
    return <TemplatesPickerModal products={products} onPick={setTplProduct} onClose={() => setSub(null)} />;
  }

  const from = getShipFrom();
  const shipReady = hasEasyPost();
  const fromReady = !!(from.street1 && from.city && from.state && from.zip);
  const tplCount  = Object.keys(getTemplates()).length;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50">
      <div className="bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92dvh] flex flex-col">
        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold font-broske">⚙️ Business Settings</h3>
            <p className="text-slate-400 text-xs mt-0.5">Orders, shipping &amp; customization</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center shrink-0">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {!shipReady && (
            <button onClick={() => setSub('tutorial')}
              className="w-full bg-gradient-to-r from-green-700/40 to-cyan-700/40 border border-green-600/40 rounded-2xl p-4 text-left hover:from-green-700/50 hover:to-cyan-700/50 transition-colors">
              <p className="text-white text-sm font-bold">👋 New here? Start with the tutorial</p>
              <p className="text-slate-300 text-xs mt-1">A 6-step walkthrough to connect EasyPost and start buying discounted labels in-app.</p>
            </button>
          )}

          <p className="text-slate-500 text-[10px] uppercase tracking-wider px-1 pt-1">Shipping</p>
          <Card
            icon="🚚" title="Shipping & EasyPost"
            desc="Proxy URL, API key, and your ship-from address"
            chip={<StatusChip ok={shipReady && fromReady} okText="Connected" offText={shipReady ? 'Address needed' : 'Not set up'} />}
            onClick={() => setSub('ship')}
          />
          <Card
            icon="📖" title="Setup Tutorial"
            desc="How to connect EasyPost & carrier networks, step by step"
            onClick={() => setSub('tutorial')}
          />

          <p className="text-slate-500 text-[10px] uppercase tracking-wider px-1 pt-2">Orders</p>
          <Card
            icon="🏷" title="Order Templates"
            desc="Per-product order numbers, package size & default carrier"
            chip={<StatusChip ok={tplCount > 0} okText={`${tplCount} set`} offText="Defaults" />}
            onClick={() => setSub('templates')}
          />

          <div className="bg-slate-800/40 rounded-2xl p-4 text-xs text-slate-500 leading-relaxed">
            <p className="text-slate-300 font-medium mb-1">How orders work</p>
            Open any sale on the <span className="text-slate-300">Sales</span> tab and tap <span className="text-slate-300">📦 Make order</span> to add an order number, customer address, shipping label and a Done/Unfulfilled status. Untracked sales stay plain sales — nothing changes until you add order details.
          </div>
        </div>

        <div className="shrink-0 px-5 py-4 border-t border-slate-800 safe-area-bottom">
          <button onClick={onClose} className="w-full py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors">Close</button>
        </div>
      </div>
    </div>
  );
}
