import { useState, useEffect, useCallback } from 'react';
import { readRange, appendRow, batchUpdateCells, ensureSheetTab, clearRow } from '../lib/sheets';
import { SHEETS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';

const SHEET = SHEETS.BUSINESS_PRODUCTS;
const HEADERS = ['ID', 'Name', 'StartPrice', 'Formula'];

const BUILT_IN_CATS = ['COGS', 'Merchandise', 'Profit', 'Materials', 'Labor', 'Overhead', 'Shipping', 'Platform Fees', 'Taxes', 'Other'];

const CAT_COLORS = {
  COGS:           '#3b82f6',
  Merchandise:    '#a855f7',
  Profit:         '#10b981',
  Materials:      '#f59e0b',
  Labor:          '#f43f5e',
  Overhead:       '#64748b',
  Shipping:       '#06b6d4',
  'Platform Fees':'#ec4899',
  Taxes:          '#dc2626',
  Other:          '#94a3b8',
};

function uid() { return Math.random().toString(36).slice(2, 10); }

function blockLabel(block) {
  return (block.category === 'Other' && block.customName?.trim()) ? block.customName.trim() : block.category;
}
function blockColor(block) {
  return CAT_COLORS[block.category] || CAT_COLORS.Other;
}

function computeFormula(startPrice, blocks) {
  let remaining = startPrice;
  const steps = blocks.map(block => {
    const val = parseFloat(block.value) || 0;
    const allocated = block.type === 'fixed'
      ? Math.min(val, remaining)
      : (remaining * val / 100);
    remaining = Math.max(0, remaining - allocated);
    return { ...block, allocated, remainingAfter: remaining };
  });
  return { steps, remaining };
}

// Like computeFormula but scales all fixed amounts by actualRevenue/basePrice
// so a $0.28 COGS on a $10 unit becomes $0.56 when processing a $20 order.
// Percent steps are unchanged — they already scale with remaining.
function computeFormulaProportional(actualRevenue, basePrice, blocks) {
  if (basePrice <= 0) return computeFormula(actualRevenue, blocks);
  const ratio = actualRevenue / basePrice;
  let remaining = actualRevenue;
  const steps = blocks.map(block => {
    const val = parseFloat(block.value) || 0;
    const allocated = block.type === 'fixed'
      ? Math.min(val * ratio, remaining)
      : (remaining * val / 100);
    remaining = Math.max(0, remaining - allocated);
    return { ...block, allocated, remainingAfter: remaining };
  });
  return { steps, remaining };
}

function profitMarginPct(steps, startPrice) {
  const profitStep = steps.find(st => st.category === 'Profit');
  if (!profitStep || startPrice <= 0) return null;
  return (profitStep.allocated / startPrice) * 100;
}

// ── Redistribute Remainder panel ───────────────────────────────────────────────

function RedistPanel({ blocks, steps, remaining, onApply, onCancel }) {
  const n = blocks.length;
  const [sliders, setSliders] = useState(() =>
    blocks.map(b => ({ id: b.id, pct: n > 0 ? 100 / n : 0 }))
  );

  function updatePct(id, rawVal) {
    const newPct = Math.min(100, Math.max(0, parseFloat(rawVal)));
    setSliders(prev => {
      const old = prev.find(r => r.id === id).pct;
      const diff = newPct - old;
      const others = prev.filter(r => r.id !== id);
      const othersTotal = others.reduce((s, r) => s + r.pct, 0);
      return prev.map(r => {
        if (r.id === id) return { ...r, pct: newPct };
        if (othersTotal === 0) return r;
        return { ...r, pct: Math.max(0, r.pct - diff * (r.pct / othersTotal)) };
      });
    });
  }

  function apply() {
    const totalPct = sliders.reduce((s, r) => s + r.pct, 0);
    if (totalPct <= 0) return;
    // Convert each step to fixed, merging its share of remaining
    const newBlocks = blocks.map(block => {
      const sl = sliders.find(r => r.id === block.id);
      if (!sl) return block;
      const shareOfRemainder = remaining * (sl.pct / totalPct);
      const currentAllocated = steps.find(st => st.id === block.id)?.allocated || 0;
      const newAbsolute = currentAllocated + shareOfRemainder;
      return { ...block, type: 'fixed', value: String(newAbsolute.toFixed(4)) };
    });
    onApply(newBlocks);
  }

  return (
    <div className="bg-amber-900/20 border border-amber-800/40 rounded-2xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-amber-300 text-xs font-broske uppercase tracking-wider">Redistribute Remainder</p>
          <p className="text-white font-mono font-bold tabular-nums">${remaining.toFixed(2)} to split</p>
        </div>
        <button onClick={onCancel} className="text-slate-500 text-xs hover:text-slate-300 transition-colors">✕ Cancel</button>
      </div>

      <div className="space-y-3">
        {sliders.map(sl => {
          const block = blocks.find(b => b.id === sl.id);
          if (!block) return null;
          const label = blockLabel(block);
          const color = blockColor(block);
          const assignedAmt = remaining * (sl.pct / 100);
          return (
            <div key={sl.id} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-slate-200">{label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 font-mono tabular-nums">{sl.pct.toFixed(1)}%</span>
                  <span className="text-white font-mono font-bold tabular-nums w-16 text-right">+${assignedAmt.toFixed(2)}</span>
                </div>
              </div>
              <input
                type="range"
                min="0" max="100" step="0.5"
                value={sl.pct}
                onChange={e => updatePct(sl.id, e.target.value)}
                className="w-full h-2 rounded-full appearance-none cursor-pointer"
                style={{ accentColor: color }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between pt-1">
        <p className="text-slate-500 text-xs">Applies as fixed amounts · converts % steps</p>
        <button
          onClick={apply}
          className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors"
        >
          Apply Split
        </button>
      </div>
    </div>
  );
}

// ── Formula Editor ─────────────────────────────────────────────────────────────

function FormulaEditor({ product, onSave, onClose, saving }) {
  const [name,        setName]        = useState(product.name || '');
  const [startPrice,  setStartPrice]  = useState(product.startPrice > 0 ? String(product.startPrice) : '');
  const [blocks,      setBlocks]      = useState(product.formula?.length ? product.formula : []);
  const [showRedist,  setShowRedist]  = useState(false);

  const price = parseFloat(startPrice) || 0;
  const { steps, remaining } = computeFormula(price, blocks);
  const balanced = Math.abs(remaining) < 0.001;
  const canSave  = name.trim() && price > 0 && balanced;
  const margin   = profitMarginPct(steps, price);

  function addBlock() {
    setBlocks(b => [...b, { id: uid(), category: 'COGS', type: 'fixed', value: '', customName: '' }]);
    setShowRedist(false);
  }
  function removeBlock(id) { setBlocks(b => b.filter(bl => bl.id !== id)); setShowRedist(false); }
  function moveBlock(id, dir) {
    setBlocks(b => {
      const idx = b.findIndex(bl => bl.id === id);
      const next = idx + dir;
      if (next < 0 || next >= b.length) return b;
      const arr = [...b];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr;
    });
  }
  function updateBlock(id, key, val) {
    setBlocks(b => b.map(bl => {
      if (bl.id !== id) return bl;
      const updated = { ...bl, [key]: val };
      if (key === 'category' && val !== 'Other') updated.customName = '';
      return updated;
    }));
  }

  return (
    <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">
      <div className="shrink-0 border-b border-slate-800 px-5 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-white font-bold text-lg font-broske">{product.id ? 'Edit Formula' : 'New Product'}</h2>
          <p className="text-slate-400 text-xs mt-0.5">
            Waterfall — each % is of the remaining pool
            {margin !== null && <span className="ml-2 text-emerald-400 font-medium">{margin.toFixed(1)}% margin</span>}
          </p>
        </div>
        <button onClick={onClose} className="w-9 h-9 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-lg">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5 pb-36">

        {/* Name + Price */}
        <div className="space-y-3">
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Product Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Stickers, Prints, Commissions…"
              autoFocus
              className="w-full bg-slate-800 text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-600"
            />
          </div>
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Sale Price (Formula Start)</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl font-bold">$</span>
              <input
                type="number" step="0.01" min="0"
                value={startPrice}
                onChange={e => setStartPrice(e.target.value)}
                placeholder="0.00"
                className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 font-mono tabular-nums placeholder-slate-600"
              />
            </div>
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-2">
          <p className="text-slate-400 text-xs uppercase tracking-wider font-broske">Allocation Steps</p>

          {price > 0 && (
            <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-900/20 border border-blue-800/40 rounded-xl">
              <span className="text-blue-400 text-xs font-broske uppercase tracking-wider w-12 shrink-0">Start</span>
              <span className="text-white font-bold font-mono tabular-nums">${price.toFixed(2)}</span>
              <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                <div className="h-1.5 rounded-full bg-blue-500 w-full" />
              </div>
            </div>
          )}

          {steps.map((step, idx) => {
            const color = blockColor(step);
            const label = blockLabel(step);
            const pct   = price > 0 ? (step.allocated / price) * 100 : 0;
            return (
              <div key={step.id} className="space-y-1.5">
                <div className="bg-slate-900 rounded-xl p-3 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col shrink-0">
                      <button onClick={() => moveBlock(step.id, -1)} disabled={idx === 0}
                        className="w-5 h-4 flex items-center justify-center text-slate-600 hover:text-slate-300 disabled:opacity-20 transition-colors text-[10px] leading-none">▲</button>
                      <button onClick={() => moveBlock(step.id, 1)} disabled={idx === blocks.length - 1}
                        className="w-5 h-4 flex items-center justify-center text-slate-600 hover:text-slate-300 disabled:opacity-20 transition-colors text-[10px] leading-none">▼</button>
                    </div>
                    <span className="text-slate-600 text-xs font-mono w-4 text-center shrink-0">{idx + 1}</span>
                    <select
                      value={step.category}
                      onChange={e => updateBlock(step.id, 'category', e.target.value)}
                      className="flex-1 bg-slate-800 text-white rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {BUILT_IN_CATS.map(c => <option key={c}>{c}</option>)}
                    </select>
                    <div className="flex bg-slate-800 rounded-lg p-0.5 shrink-0">
                      {[['fixed','$'],['percent','%']].map(([t, lbl]) => (
                        <button key={t} onClick={() => updateBlock(step.id, 'type', t)}
                          className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${step.type === t ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number" step="0.01" min="0"
                      value={step.value}
                      onChange={e => updateBlock(step.id, 'value', e.target.value)}
                      placeholder="0"
                      className="w-20 bg-slate-800 text-white rounded-lg px-2 py-1.5 text-sm text-right outline-none focus:ring-1 focus:ring-blue-500 font-mono tabular-nums shrink-0"
                    />
                    <button onClick={() => removeBlock(step.id)}
                      className="w-7 h-7 rounded-lg bg-slate-800 text-slate-500 hover:text-rose-400 flex items-center justify-center text-sm transition-colors shrink-0">
                      ✕
                    </button>
                  </div>

                  {/* Custom name when "Other" */}
                  {step.category === 'Other' && (
                    <div className="flex items-center gap-2 ml-5">
                      <span className="text-slate-500 text-xs shrink-0">Custom name:</span>
                      <input
                        value={step.customName || ''}
                        onChange={e => updateBlock(step.id, 'customName', e.target.value)}
                        placeholder="e.g. Platform cut, Packaging…"
                        className="flex-1 bg-slate-800 text-white rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-blue-500 placeholder-slate-600"
                      />
                    </div>
                  )}

                  {/* Result row */}
                  <div className="flex items-center gap-2 ml-5">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    <span className="text-xs font-medium shrink-0" style={{ color }}>{label}</span>
                    <span className="text-white text-xs font-mono font-bold tabular-nums">→ ${step.allocated.toFixed(2)}</span>
                    <div className="flex-1 bg-slate-800 rounded-full h-1 overflow-hidden">
                      <div className="h-1 rounded-full" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <span className="text-slate-500 text-[10px] font-mono shrink-0">{pct.toFixed(1)}%</span>
                  </div>
                </div>

                {/* Remaining after step */}
                <div className={`flex items-center gap-3 px-4 py-2 rounded-lg border ${Math.abs(step.remainingAfter) < 0.001 ? 'bg-emerald-900/20 border-emerald-800/40' : 'bg-slate-900/60 border-slate-800/60'}`}>
                  <span className="text-slate-500 text-[10px] uppercase tracking-wider shrink-0">Remaining</span>
                  <span className={`font-mono text-sm font-bold tabular-nums ${Math.abs(step.remainingAfter) < 0.001 ? 'text-emerald-400' : 'text-slate-300'}`}>
                    ${step.remainingAfter.toFixed(2)}
                  </span>
                  {price > 0 && (
                    <div className="flex-1 bg-slate-800 rounded-full h-1 overflow-hidden">
                      <div className="h-1 rounded-full bg-slate-600" style={{ width: `${(step.remainingAfter / price) * 100}%` }} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {blocks.length === 0 && price > 0 && (
            <div className="px-4 py-5 border border-dashed border-slate-700 rounded-xl text-center">
              <p className="text-slate-500 text-sm">No steps yet — add your first allocation below</p>
            </div>
          )}

          <button onClick={addBlock}
            className="w-full py-2.5 rounded-xl text-xs font-medium border border-dashed border-slate-700 text-slate-400 hover:text-white hover:border-blue-600/50 transition-colors">
            + Add Allocation Step
          </button>
        </div>

        {/* Redistribute remainder panel */}
        {remaining > 0.001 && blocks.length > 0 && (
          showRedist ? (
            <RedistPanel
              blocks={blocks}
              steps={steps}
              remaining={remaining}
              onApply={newBlocks => { setBlocks(newBlocks); setShowRedist(false); }}
              onCancel={() => setShowRedist(false)}
            />
          ) : (
            <button
              onClick={() => setShowRedist(true)}
              className="w-full py-2.5 rounded-xl text-xs font-medium border border-dashed border-amber-700/50 text-amber-400 hover:bg-amber-900/20 transition-colors"
            >
              ⇄ Redistribute ${remaining.toFixed(2)} remainder across steps
            </button>
          )
        )}

        {/* Summary stacked bar */}
        {price > 0 && steps.length > 0 && (
          <div className="bg-slate-900 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-slate-400 text-xs uppercase tracking-wider font-broske">Allocation Summary</p>
              {margin !== null && (
                <span className="text-emerald-400 text-xs font-bold">{margin.toFixed(1)}% profit margin</span>
              )}
            </div>
            <div className="flex h-5 rounded-full overflow-hidden bg-slate-800">
              {steps.map(step => (
                <div key={step.id}
                  style={{ width: `${price > 0 ? (step.allocated / price) * 100 : 0}%`, background: blockColor(step) }}
                  title={`${blockLabel(step)}: $${step.allocated.toFixed(2)}`}
                />
              ))}
              {remaining > 0 && (
                <div style={{ width: `${(remaining / price) * 100}%` }} className="bg-rose-900/70" />
              )}
            </div>
            <div className="space-y-1.5">
              {steps.map(step => {
                const pct   = price > 0 ? (step.allocated / price) * 100 : 0;
                const color = blockColor(step);
                return (
                  <div key={step.id} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    <span className="text-slate-300 flex-1">{blockLabel(step)}</span>
                    <span className="text-white font-mono tabular-nums">${step.allocated.toFixed(2)}</span>
                    <span className="text-slate-500 font-mono w-10 text-right tabular-nums">{pct.toFixed(1)}%</span>
                  </div>
                );
              })}
              {remaining > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full shrink-0 bg-rose-500" />
                  <span className="text-rose-400 flex-1">Unallocated</span>
                  <span className="text-rose-400 font-mono tabular-nums">${remaining.toFixed(2)}</span>
                  <span className="text-rose-500 font-mono w-10 text-right">{((remaining / price) * 100).toFixed(1)}%</span>
                </div>
              )}
            </div>
            <div className={`px-3 py-2.5 rounded-xl text-xs font-medium text-center ${canSave ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800/40' : 'bg-rose-900/30 text-rose-400 border border-rose-800/40'}`}>
              {!name.trim()
                ? '⚠ Enter a product name to save'
                : !price
                  ? '⚠ Enter a sale price to save'
                  : balanced
                    ? '✓ Fully allocated — ready to save'
                    : `⚠ $${remaining.toFixed(2)} unallocated — must reach $0.00 to save`
              }
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 px-5 py-4 border-t border-slate-800 flex gap-3 bg-slate-950">
        <button onClick={onClose} disabled={saving}
          className="flex-1 py-3 rounded-xl bg-slate-800 text-slate-300 font-medium hover:bg-slate-700 transition-colors disabled:opacity-50">
          Cancel
        </button>
        <button onClick={() => onSave({ ...product, name: name.trim(), startPrice: price, formula: blocks })}
          disabled={!canSave || saving}
          className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold transition-colors">
          {saving ? 'Saving…' : product.id ? 'Save Changes' : 'Create Product'}
        </button>
      </div>
    </div>
  );
}

// ── Process modal ──────────────────────────────────────────────────────────────

const TRANS_SHEET = 'Business Transactions';

function ProcessModal({ product, token, onClose }) {
  const [inputMode, setInputMode] = useState('amount'); // 'amount' | 'quantity'
  const [inputVal,  setInputVal]  = useState(String(product.startPrice));
  const [submitting, setSubmitting] = useState(false);
  const [done,       setDone]       = useState(false);

  const qty     = parseFloat(inputVal) || 0;
  const revenue = inputMode === 'quantity' ? qty * product.startPrice : qty;

  const { steps, remaining } = computeFormulaProportional(revenue, product.startPrice, product.formula);
  const balanced = Math.abs(remaining) < 0.001;
  const margin   = profitMarginPct(steps, revenue);

  async function handleProcess() {
    if (!balanced || revenue <= 0) return;
    setSubmitting(true);
    try {
      await ensureSheetTab(token, TRANS_SHEET);
      const today = new Date().toISOString().slice(0, 10);
      const allocJSON = JSON.stringify(
        steps.reduce((obj, st) => { obj[blockLabel(st)] = st.allocated.toFixed(4); return obj; }, {})
      );
      await appendRow(token, `${TRANS_SHEET}!A:G`, [
        today,
        product.name,
        inputMode === 'quantity' ? qty : '',
        product.startPrice.toFixed(2),
        revenue.toFixed(2),
        margin !== null ? (margin.toFixed(2) + '%') : '',
        allocJSON,
      ]);
      setDone(true);
      setTimeout(onClose, 1400);
    } catch (e) {
      alert(`Error processing: ${e.message}`);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end z-50">
      <div className="bg-slate-900 w-full rounded-t-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold font-broske">{product.name}</h3>
            <p className="text-slate-400 text-xs mt-0.5">Unit price: <span className="font-mono text-slate-300">${product.startPrice.toFixed(2)}</span></p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-3">
          {/* Input mode toggle + value */}
          <div className="bg-blue-900/20 border border-blue-800/40 rounded-2xl p-4 space-y-3">
            <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
              {[['amount','$ Amount received'],['quantity','# Quantity sold']].map(([m, lbl]) => (
                <button key={m} onClick={() => { setInputMode(m); setInputVal(''); }}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${inputMode === m ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-300'}`}>
                  {lbl}
                </button>
              ))}
            </div>

            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg font-bold">
                {inputMode === 'amount' ? '$' : '#'}
              </span>
              <input
                type="number" step={inputMode === 'amount' ? '0.01' : '1'} min="0"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                placeholder={inputMode === 'amount' ? '0.00' : '0'}
                autoFocus
                className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 font-mono tabular-nums placeholder-slate-600"
              />
            </div>

            {inputMode === 'quantity' && qty > 0 && (
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{qty} × ${product.startPrice.toFixed(2)}</span>
                <span className="text-white font-bold font-mono tabular-nums">= ${revenue.toFixed(2)} total</span>
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-blue-300 font-broske text-xs uppercase tracking-wider">Formula Start</span>
              <span className="text-white font-bold text-2xl font-mono tabular-nums">${revenue.toFixed(2)}</span>
            </div>
          </div>

          {/* Waterfall steps */}
          {revenue > 0 && steps.map((step, idx) => {
            const color = blockColor(step);
            const label = blockLabel(step);
            return (
              <div key={step.id} className="space-y-1">
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-800 bg-slate-800/60">
                  <span className="text-slate-600 font-mono text-xs w-4 shrink-0">{idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                      <span className="text-sm font-medium" style={{ color }}>{label}</span>
                      <span className="text-slate-600 text-xs">
                        {step.type === 'fixed'
                          ? `$${(parseFloat(step.value || 0) * (product.startPrice > 0 ? revenue / product.startPrice : 1)).toFixed(2)} scaled`
                          : `${step.value}% of remaining`}
                      </span>
                    </div>
                  </div>
                  <span className="font-mono font-bold text-white tabular-nums shrink-0">→ ${step.allocated.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-2 px-4">
                  <div className="flex-1 bg-slate-800 rounded-full h-1 overflow-hidden">
                    <div className="h-1 rounded-full bg-slate-700"
                      style={{ width: `${revenue > 0 ? (step.remainingAfter / revenue) * 100 : 0}%` }} />
                  </div>
                  <span className="text-slate-600 text-[10px] font-mono shrink-0">${step.remainingAfter.toFixed(2)} left</span>
                </div>
              </div>
            );
          })}

          {/* Net remaining */}
          {revenue > 0 && (
            <div className={`flex items-center justify-between px-4 py-3 rounded-xl border font-bold ${balanced ? 'bg-emerald-900/20 border-emerald-800/40' : 'bg-rose-900/20 border-rose-800/40'}`}>
              <div>
                <span className={`font-broske text-xs uppercase tracking-wider block ${balanced ? 'text-emerald-400' : 'text-rose-400'}`}>Net Remaining</span>
                {margin !== null && balanced && (
                  <span className="text-emerald-300 text-xs">{margin.toFixed(1)}% profit margin</span>
                )}
              </div>
              <span className={`font-mono text-2xl tabular-nums ${balanced ? 'text-emerald-400' : 'text-rose-400'}`}>${remaining.toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* Process button */}
        <div className="shrink-0 px-5 py-4 border-t border-slate-800 bg-slate-900">
          {done ? (
            <div className="w-full py-3.5 rounded-2xl bg-emerald-700/30 border border-emerald-700/50 text-emerald-300 font-bold text-center text-sm">
              ✓ Recorded to Business Transactions
            </div>
          ) : (
            <button
              onClick={handleProcess}
              disabled={!balanced || revenue <= 0 || submitting}
              className="w-full py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm transition-colors"
            >
              {submitting ? 'Saving…' : !revenue ? 'Enter an amount to process' : !balanced ? `Can't process — $${remaining.toFixed(2)} unallocated` : 'Process & Record'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Comparison table ───────────────────────────────────────────────────────────

function CompareTable({ products }) {
  if (products.length === 0) return (
    <div className="bg-slate-900 rounded-2xl p-8 text-center">
      <p className="text-slate-500 text-sm">No products to compare yet</p>
    </div>
  );

  const rows = products.map(p => {
    const { steps } = computeFormula(p.startPrice, p.formula);
    const cogs    = steps.find(st => st.category === 'COGS')?.allocated    || 0;
    const profit  = steps.find(st => st.category === 'Profit')?.allocated  || 0;
    const margin  = p.startPrice > 0 ? (profit / p.startPrice) * 100 : 0;
    const balanced = Math.abs(computeFormula(p.startPrice, p.formula).remaining) < 0.001;
    return { p, steps, cogs, profit, margin, balanced };
  });

  // Best margin for bar scaling
  const maxMargin = Math.max(...rows.map(r => r.margin), 1);

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="grid grid-cols-5 gap-2 px-3 py-2 text-[10px] text-slate-500 uppercase tracking-wider">
        <div className="col-span-2">Product</div>
        <div className="text-right">COGS</div>
        <div className="text-right">Profit</div>
        <div className="text-right">Margin</div>
      </div>

      {rows.map(({ p, cogs, profit, margin, balanced }) => (
        <div key={p.id} className="bg-slate-800 rounded-xl p-3 space-y-2">
          <div className="grid grid-cols-5 gap-2 items-center">
            <div className="col-span-2 min-w-0">
              <p className="text-white text-sm font-medium truncate">{p.name}</p>
              <p className="text-slate-500 text-[10px] font-mono">${p.startPrice.toFixed(2)}</p>
            </div>
            <div className="text-right">
              <p className="text-blue-300 text-sm font-mono tabular-nums">${cogs.toFixed(2)}</p>
            </div>
            <div className="text-right">
              <p className="text-emerald-400 text-sm font-mono tabular-nums">${profit.toFixed(2)}</p>
            </div>
            <div className="text-right">
              <p className={`text-sm font-bold font-mono tabular-nums ${margin >= 20 ? 'text-emerald-400' : margin >= 10 ? 'text-amber-400' : 'text-rose-400'}`}>
                {margin.toFixed(1)}%
              </p>
            </div>
          </div>
          {/* Margin bar */}
          <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
            <div className="h-1.5 rounded-full transition-all"
              style={{ width: `${(margin / maxMargin) * 100}%`, background: margin >= 20 ? '#10b981' : margin >= 10 ? '#f59e0b' : '#f43f5e' }} />
          </div>
        </div>
      ))}

      {/* Totals row */}
      {rows.length > 1 && (
        <div className="bg-slate-900 rounded-xl p-3">
          <div className="grid grid-cols-5 gap-2 items-center">
            <div className="col-span-2">
              <p className="text-slate-400 text-xs font-broske uppercase tracking-wider">Average</p>
            </div>
            <div className="text-right">
              <p className="text-blue-300 text-xs font-mono tabular-nums">${(rows.reduce((s, r) => s + r.cogs, 0) / rows.length).toFixed(2)}</p>
            </div>
            <div className="text-right">
              <p className="text-emerald-400 text-xs font-mono tabular-nums">${(rows.reduce((s, r) => s + r.profit, 0) / rows.length).toFixed(2)}</p>
            </div>
            <div className="text-right">
              <p className="text-slate-300 text-xs font-bold font-mono tabular-nums">
                {(rows.reduce((s, r) => s + r.margin, 0) / rows.length).toFixed(1)}%
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BusinessExpenses({ token }) {
  const [products,   setProducts]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [processing, setProcessing] = useState(null);
  const [viewMode,   setViewMode]   = useState('cards'); // 'cards' | 'compare'

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureSheetTab(token, SHEET);
      const rows = await readRange(token, `${SHEET}!A:D`);

      if (!rows.length || !rows[0]?.length) {
        await batchUpdateCells(token, HEADERS.map((h, i) => ({
          range: `${SHEET}!${String.fromCharCode(65 + i)}1`,
          value: h,
        })));
        setProducts([]);
        return;
      }

      const [, ...dataRows] = rows;
      const parsed = dataRows
        .map((row, idx) => {
          const id = row[0];
          if (!id || id === 'ID') return null;
          let formula = [];
          try { formula = JSON.parse(row[3] || '[]'); } catch { formula = []; }
          return { id, name: row[1] || '', startPrice: parseFloat(row[2]) || 0, formula, _rowNum: idx + 2 };
        })
        .filter(Boolean);
      setProducts(parsed);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  async function handleSave(product) {
    setSaving(true);
    try {
      if (product.id && product._rowNum) {
        await batchUpdateCells(token, [
          { range: `${SHEET}!B${product._rowNum}`, value: product.name },
          { range: `${SHEET}!C${product._rowNum}`, value: product.startPrice },
          { range: `${SHEET}!D${product._rowNum}`, value: JSON.stringify(product.formula) },
        ]);
      } else {
        await appendRow(token, `${SHEET}!A:D`, [uid(), product.name, product.startPrice, JSON.stringify(product.formula)]);
      }
      setEditing(null);
      await load();
    } catch (e) {
      alert(`Error saving: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(product) {
    if (!window.confirm(`Delete "${product.name}"?`)) return;
    setSaving(true);
    try {
      await clearRow(token, `${SHEET}!A${product._rowNum}:D${product._rowNum}`);
      await load();
    } catch (e) {
      alert(`Error deleting: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;

  const avgMargin = products.length > 0
    ? products.reduce((s, p) => {
        const { steps } = computeFormula(p.startPrice, p.formula);
        return s + (profitMarginPct(steps, p.startPrice) || 0);
      }, 0) / products.length
    : 0;

  return (
    <div className="pb-24">
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Business Expenses</h1>
          <p className="text-slate-500 text-xs mt-0.5">Product revenue allocation · synced to Sheets</p>
        </div>
        <button
          onClick={() => setEditing({ name: '', startPrice: 0, formula: [] })}
          className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-colors"
        >
          + Add
        </button>
      </div>

      <div className="px-4 space-y-4">
        {error && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-4 text-red-400 text-sm space-y-2">
            <p className="font-medium">Could not load Business Products sheet</p>
            <p className="text-xs text-red-500">{error}</p>
            <button onClick={load} className="text-blue-400 underline text-xs">Retry</button>
          </div>
        )}

        {/* Summary strip */}
        {products.length > 0 && (
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-800 rounded-xl p-3">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Products</p>
              <p className="text-white font-bold text-xl mt-0.5 font-mono">{products.length}</p>
            </div>
            <div className="bg-slate-800 rounded-xl p-3">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Avg Profit</p>
              <p className="text-emerald-400 font-bold text-xl mt-0.5 font-mono tabular-nums">
                ${(products.reduce((s, p) => {
                  const { steps } = computeFormula(p.startPrice, p.formula);
                  return s + (steps.find(st => st.category === 'Profit')?.allocated || 0);
                }, 0) / products.length).toFixed(2)}
              </p>
            </div>
            <div className="bg-slate-800 rounded-xl p-3">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Avg Margin</p>
              <p className={`font-bold text-xl mt-0.5 font-mono tabular-nums ${avgMargin >= 20 ? 'text-emerald-400' : avgMargin >= 10 ? 'text-amber-400' : 'text-rose-400'}`}>
                {avgMargin.toFixed(1)}%
              </p>
            </div>
          </div>
        )}

        {/* View toggle */}
        {products.length > 0 && (
          <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
            {[['cards','Cards'],['compare','Compare']].map(([v, lbl]) => (
              <button key={v} onClick={() => setViewMode(v)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${viewMode === v ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-300'}`}>
                {lbl}
              </button>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!error && products.length === 0 && (
          <div className="bg-slate-900 rounded-2xl p-8 text-center space-y-3">
            <p className="text-4xl">💼</p>
            <p className="text-white font-semibold font-broske">No products yet</p>
            <p className="text-slate-500 text-sm leading-relaxed">Add a product and define how its revenue is allocated across COGS, profit, fees, and more.</p>
            <button
              onClick={() => setEditing({ name: '', startPrice: 0, formula: [] })}
              className="mt-1 bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-colors"
            >
              + Add First Product
            </button>
          </div>
        )}

        {/* Compare view */}
        {viewMode === 'compare' && <CompareTable products={products} />}

        {/* Cards view */}
        {viewMode === 'cards' && (
          <div className="space-y-3">
            {products.map(product => {
              const { steps, remaining } = computeFormula(product.startPrice, product.formula);
              const balanced  = Math.abs(remaining) < 0.001;
              const profitAmt = steps.find(st => st.category === 'Profit')?.allocated || 0;
              const cogsAmt   = steps.find(st => st.category === 'COGS')?.allocated   || 0;
              const margin    = profitMarginPct(steps, product.startPrice);

              return (
                <div key={product.id} className="bg-slate-800 rounded-2xl overflow-hidden">
                  <div className="px-4 pt-4 pb-3">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-white font-semibold truncate">{product.name}</p>
                          {margin !== null && (
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${margin >= 20 ? 'bg-emerald-900/50 text-emerald-300' : margin >= 10 ? 'bg-amber-900/50 text-amber-300' : 'bg-rose-900/50 text-rose-300'}`}>
                              {margin.toFixed(1)}% margin
                            </span>
                          )}
                        </div>
                        <p className="text-slate-400 text-xs mt-0.5">
                          Start: <span className="font-mono text-white tabular-nums">${product.startPrice.toFixed(2)}</span>
                          {' · '}{product.formula.length} step{product.formula.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${balanced ? 'bg-emerald-900/50 text-emerald-300' : 'bg-rose-900/50 text-rose-300'}`}>
                        {balanced ? '✓' : `$${remaining.toFixed(2)} left`}
                      </span>
                    </div>

                    {/* Stacked bar */}
                    {product.startPrice > 0 && steps.length > 0 && (
                      <div className="flex h-3 rounded-full overflow-hidden mb-3">
                        {steps.map(step => (
                          <div key={step.id}
                            style={{ width: `${(step.allocated / product.startPrice) * 100}%`, background: blockColor(step) }}
                            title={`${blockLabel(step)}: $${step.allocated.toFixed(2)}`}
                          />
                        ))}
                        {remaining > 0 && <div style={{ width: `${(remaining / product.startPrice) * 100}%` }} className="bg-rose-900/60" />}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {cogsAmt > 0 && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300 font-mono tabular-nums">COGS ${cogsAmt.toFixed(2)}</span>
                      )}
                      {profitAmt > 0 && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 font-mono tabular-nums">Profit ${profitAmt.toFixed(2)}</span>
                      )}
                      {steps.filter(st => st.category !== 'COGS' && st.category !== 'Profit').map(st => (
                        <span key={st.id} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-400 font-mono tabular-nums">
                          {blockLabel(st)} ${st.allocated.toFixed(2)}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex border-t border-slate-700/80">
                    <button onClick={() => setProcessing(product)}
                      className="flex-1 py-2.5 text-xs font-semibold text-blue-400 hover:bg-slate-700 transition-colors">
                      Process
                    </button>
                    <div className="w-px bg-slate-700" />
                    <button onClick={() => setEditing(product)}
                      className="flex-1 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors">
                      Edit
                    </button>
                    <div className="w-px bg-slate-700" />
                    <button onClick={() => handleDelete(product)} disabled={saving}
                      className="px-4 py-2.5 text-xs font-medium text-rose-500 hover:bg-slate-700 transition-colors disabled:opacity-50">
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing    && <FormulaEditor product={editing}    onSave={handleSave} onClose={() => setEditing(null)}    saving={saving} />}
      {processing && <ProcessModal  product={processing} token={token}        onClose={() => setProcessing(null)} />}
      {saving && !editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 pointer-events-none">
          <LoadingSpinner />
        </div>
      )}
    </div>
  );
}
