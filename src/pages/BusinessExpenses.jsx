import { useState, useEffect, useCallback, useMemo } from 'react';
import { readRange, appendRow, batchUpdateCells, ensureSheetTab, clearRow } from '../lib/sheets';
import { SHEETS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';
import ProcessIncome from '../components/ProcessIncome';

const SHEET = SHEETS.BUSINESS_PRODUCTS;
const HEADERS = ['ID', 'Name', 'StartPrice', 'Formula'];

const BUILT_IN_CATS = ['COGS', 'Merchandise', 'Profit', 'Revenue', 'Materials', 'Labor', 'Overhead', 'Shipping', 'Platform Fees', 'Taxes', 'Other'];

// Revenue is treated as profit — same color, counts toward the Profit tile and Process button
const CAT_COLORS = {
  COGS:           '#3b82f6',
  Merchandise:    '#a855f7',
  Profit:         '#10b981',
  Revenue:        '#10b981',
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
  // Absorb floating-point dust (<$0.01) into the last step so the formula always balances.
  // Without this, 0.28 × 1.5 = 0.42000000000000004, and after several steps remaining ≈ 0.00099,
  // which passes Math.abs(remaining) < 0.001 = FALSE and disables the Process button permanently.
  if (steps.length > 0 && remaining > 0 && remaining < 0.01) {
    const last = steps[steps.length - 1];
    last.allocated += remaining;
    last.remainingAfter = 0;
    remaining = 0;
  }
  return { steps, remaining };
}

function profitMarginPct(steps, startPrice) {
  const profitAmt = (steps.find(st => st.category === 'Profit')?.allocated || 0)
                  + (steps.find(st => st.category === 'Revenue')?.allocated || 0);
  if (profitAmt === 0 || startPrice <= 0) return null;
  return (profitAmt / startPrice) * 100;
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
              className="w-full bg-slate-800 text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-green-500 placeholder-slate-600"
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
                className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-green-500 font-mono tabular-nums placeholder-slate-600"
              />
            </div>
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-2">
          <p className="text-slate-400 text-xs uppercase tracking-wider font-broske">Allocation Steps</p>

          {price > 0 && (
            <div className="flex items-center gap-3 px-4 py-2.5 bg-green-900/20 border border-green-800/40 rounded-xl">
              <span className="text-green-400 text-xs font-broske uppercase tracking-wider w-12 shrink-0">Start</span>
              <span className="text-white font-bold font-mono tabular-nums">${price.toFixed(2)}</span>
              <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                <div className="h-1.5 rounded-full bg-green-500 w-full" />
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
                      className="flex-1 bg-slate-800 text-white rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-green-500"
                    >
                      {BUILT_IN_CATS.map(c => <option key={c}>{c}</option>)}
                    </select>
                    <div className="flex bg-slate-800 rounded-lg p-0.5 shrink-0">
                      {[['fixed','$'],['percent','%']].map(([t, lbl]) => (
                        <button key={t} onClick={() => updateBlock(step.id, 'type', t)}
                          className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${step.type === t ? 'bg-green-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number" step="0.01" min="0"
                      value={step.value}
                      onChange={e => updateBlock(step.id, 'value', e.target.value)}
                      placeholder="0"
                      className="w-20 bg-slate-800 text-white rounded-lg px-2 py-1.5 text-sm text-right outline-none focus:ring-1 focus:ring-green-500 font-mono tabular-nums shrink-0"
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
                        className="flex-1 bg-slate-800 text-white rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-green-500 placeholder-slate-600"
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
            className="w-full py-2.5 rounded-xl text-xs font-medium border border-dashed border-slate-700 text-slate-400 hover:text-white hover:border-green-600/50 transition-colors">
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
          className="flex-1 py-3 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white font-bold transition-colors">
          {saving ? 'Saving…' : product.id ? 'Save Changes' : 'Create Product'}
        </button>
      </div>
    </div>
  );
}

// ── Process modal ──────────────────────────────────────────────────────────────

const TRANS_SHEET = 'Business Transactions';
const SPEND_SHEET = SHEETS.BUSINESS_ACCOUNT_SPENDING;

function ProcessModal({ product, token, onClose, onSuccess }) {
  const [inputMode, setInputMode] = useState('amount'); // 'amount' | 'quantity'
  const [inputVal,  setInputVal]  = useState(String(product.startPrice));
  const [clientName,    setClientName]    = useState('');
  const [submitting,    setSubmitting]    = useState(false);
  const [done,          setDone]          = useState(false);
  const [processError,  setProcessError]  = useState(null);

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
      // Write header row if sheet is empty so SalesView can detect it
      const existing = await readRange(token, `${TRANS_SHEET}!A1:H1`);
      if (!existing.length || !existing[0]?.length) {
        await appendRow(token, `${TRANS_SHEET}!A:H`, ['Date', 'Client', 'Product', 'Quantity', 'Unit Price', 'Revenue', 'Margin %', 'Allocation']);
      }
      const now = localDateTimeStr();
      const allocJSON = JSON.stringify(
        steps.reduce((obj, st) => { obj[blockLabel(st)] = st.allocated.toFixed(4); return obj; }, {})
      );
      await appendRow(token, `${TRANS_SHEET}!A:H`, [
        now,
        clientName.trim(),
        product.name,
        inputMode === 'quantity' ? qty : '',
        product.startPrice.toFixed(2),
        revenue.toFixed(2),
        margin !== null ? (margin.toFixed(2) + '%') : '',
        allocJSON,
      ]);
      setDone(true);
      onSuccess?.();           // notify parent so SalesView refreshes
      setTimeout(onClose, 1400);
    } catch (e) {
      setProcessError(e.message);
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
          {/* Client name */}
          <div>
            <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5 font-broske">Client Name <span className="text-slate-600 normal-case tracking-normal">(optional)</span></label>
            <input
              value={clientName}
              onChange={e => setClientName(e.target.value)}
              placeholder="e.g. Jane Doe, @username, Etsy order #1234"
              className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 placeholder-slate-600"
            />
          </div>

          {/* Input mode toggle + value */}
          <div className="bg-green-900/20 border border-green-800/40 rounded-2xl p-4 space-y-3">
            <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
              {[['amount','$ Amount received'],['quantity','# Quantity sold']].map(([m, lbl]) => (
                <button key={m} onClick={() => { setInputMode(m); setInputVal(''); }}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${inputMode === m ? 'bg-green-600 text-white' : 'text-slate-400 hover:text-slate-300'}`}>
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
                className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-green-500 font-mono tabular-nums placeholder-slate-600"
              />
            </div>

            {inputMode === 'quantity' && qty > 0 && (
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{qty} × ${product.startPrice.toFixed(2)}</span>
                <span className="text-white font-bold font-mono tabular-nums">= ${revenue.toFixed(2)} total</span>
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-green-300 font-broske text-xs uppercase tracking-wider">Formula Start</span>
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
        <div className="shrink-0 px-5 py-4 border-t border-slate-800 bg-slate-900 space-y-2">
          {processError && (
            <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-xs">
              {processError}
            </div>
          )}
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
    const profit  = (steps.find(st => st.category === 'Profit')?.allocated  || 0)
                  + (steps.find(st => st.category === 'Revenue')?.allocated || 0);
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
              <p className="text-green-300 text-sm font-mono tabular-nums">${cogs.toFixed(2)}</p>
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
              <p className="text-green-300 text-xs font-mono tabular-nums">${(rows.reduce((s, r) => s + r.cogs, 0) / rows.length).toFixed(2)}</p>
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

// ── Edit Transaction Modal ────────────────────────────────────────────────────

function EditTransactionModal({ tx, products, token, onSave, onDelete, onClose }) {
  const [date,      setDate]      = useState(tx.date || '');
  const [time,      setTime]      = useState(tx.time || '');
  const [client,    setClient]    = useState(tx.client || '');
  const [qty,       setQty]       = useState(String(tx.qty || ''));
  const [unitPrice, setUnitPrice] = useState(String(tx.unitPrice || ''));
  const [revenue,   setRevenue]   = useState(String(tx.revenue || ''));
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const product = products.find(p => p.name === tx.product);
  const revNum  = parseFloat(revenue) || 0;

  // Recompute allocations live from product formula when revenue changes
  let newAllocs = tx.allocs;
  let newMargin = tx.margin;
  if (product && revNum > 0) {
    const { steps } = computeFormulaProportional(revNum, product.startPrice, product.formula);
    newAllocs = steps.reduce((o, st) => { o[blockLabel(st)] = st.allocated.toFixed(4); return o; }, {});
    const m = profitMarginPct(steps, revNum);
    newMargin = m !== null ? m.toFixed(2) + '%' : '';
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...tx,
        date,
        time,
        client,
        qty: qty || '',
        unitPrice: parseFloat(unitPrice) || tx.unitPrice,
        revenue: revNum,
        allocs: newAllocs,
        margin: newMargin,
      });
      onClose();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  async function del() {
    setSaving(true);
    try {
      await onDelete(tx);
      onClose();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end z-50">
      <div className="bg-slate-900 w-full rounded-t-3xl max-h-[92vh] flex flex-col">

        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold font-broske">Edit Transaction</h3>
            <p className="text-slate-400 text-xs mt-0.5">{tx.product}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">

          {/* Date + Time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5">Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"/>
            </div>
            <div>
              <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5">Time</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)}
                className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"/>
            </div>
          </div>

          {/* Client */}
          <div>
            <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5">Client</label>
            <input value={client} onChange={e => setClient(e.target.value)} placeholder="(optional)"
              className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 placeholder-slate-600"/>
          </div>

          {/* Qty + Unit Price */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5">Quantity</label>
              <input type="number" min="0" step="1" value={qty} onChange={e => setQty(e.target.value)}
                placeholder="—"
                className="w-full bg-slate-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 font-mono tabular-nums placeholder-slate-600"/>
            </div>
            <div>
              <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5">Unit Price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                <input type="number" min="0" step="0.01" value={unitPrice} onChange={e => setUnitPrice(e.target.value)}
                  className="w-full bg-slate-800 text-white rounded-xl pl-7 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 font-mono tabular-nums"/>
              </div>
            </div>
          </div>

          {/* Revenue */}
          <div>
            <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5">Revenue (total received)</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl font-bold">$</span>
              <input type="number" min="0" step="0.01" value={revenue} onChange={e => setRevenue(e.target.value)}
                className="w-full bg-slate-800 text-white text-xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-green-500 font-mono tabular-nums"/>
            </div>
          </div>

          {/* Recomputed allocation preview */}
          {revNum > 0 && (
            <div className="bg-slate-800 rounded-xl p-3 space-y-1.5">
              <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">
                {product ? 'Recomputed Allocations' : 'Stored Allocations'}
                {!product && <span className="text-amber-400 ml-2 normal-case tracking-normal">(product not found — unchanged)</span>}
              </p>
              {Object.entries(newAllocs).map(([name, amt]) => {
                const color = CAT_COLORS[name] || CAT_COLORS.Other;
                const amtNum = parseFloat(amt) || 0;
                const pct = revNum > 0 ? (amtNum / revNum) * 100 : 0;
                return (
                  <div key={name} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }}/>
                    <span className="text-slate-300 flex-1">{name}</span>
                    <span className="text-slate-500 font-mono tabular-nums">{pct.toFixed(1)}%</span>
                    <span className="text-white font-mono font-bold tabular-nums w-16 text-right">${amtNum.toFixed(2)}</span>
                  </div>
                );
              })}
              {newMargin && (
                <p className="text-emerald-400 text-[10px] pt-1 border-t border-slate-700">{newMargin} profit margin</p>
              )}
            </div>
          )}

          {error && (
            <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-xs">{error}</div>
          )}
        </div>

        <div className="shrink-0 px-5 py-4 border-t border-slate-800 space-y-2">
          {confirmDel ? (
            <div className="flex gap-2">
              <button onClick={() => setConfirmDel(false)} disabled={saving}
                className="flex-1 py-3 rounded-xl bg-slate-800 text-slate-300 font-medium text-sm transition-colors">
                Keep it
              </button>
              <button onClick={del} disabled={saving}
                className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm transition-colors disabled:opacity-50">
                {saving ? 'Deleting…' : 'Yes, Delete'}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => setConfirmDel(true)} disabled={saving}
                className="px-4 py-3 rounded-xl bg-rose-900/40 hover:bg-rose-900/60 text-rose-400 text-sm font-bold transition-colors disabled:opacity-50">
                Delete
              </button>
              <button onClick={onClose} disabled={saving}
                className="flex-1 py-3 rounded-xl bg-slate-800 text-slate-300 font-medium text-sm hover:bg-slate-700 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button onClick={save} disabled={saving || !revNum}
                className="flex-1 py-3 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white font-bold text-sm transition-colors">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sales / Transactions view ─────────────────────────────────────────────────

const PERIOD_OPTIONS = [
  { key: 'month', label: 'This Month' },
  { key: 'year',  label: 'This Year'  },
  { key: 'all',   label: 'All Time'   },
];

// Returns { date: 'YYYY-MM-DD', time: 'HH:MM' } from a Sheets serial or string.
// Sheets stores datetimes as a decimal: integer = days since 1899-12-30, fractional = time-of-day fraction.
// The fractional part represents LOCAL time (spreadsheet timezone), so we read it directly.
function serialToDateTime(val) {
  if (val === '' || val === null || val === undefined) return { date: '', time: '' };
  const n = Number(val);
  const str = String(val);
  if (!isNaN(n) && n > 1000 && !str.includes('-') && !str.includes('T') && !str.includes(' ')) {
    const daySerial = Math.floor(n);
    const timeFrac  = n - daySerial;
    const date = new Date(Math.round((daySerial - 25569) * 86400000)).toISOString().slice(0, 10);
    if (timeFrac > 0.0005) {
      const totalMins = Math.round(timeFrac * 1440);
      const time = `${String(Math.floor(totalMins / 60)).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}`;
      return { date, time };
    }
    return { date, time: '' };
  }
  const date = str.slice(0, 10);
  const sep  = str[10];
  const time = (sep === 'T' || sep === ' ') ? str.slice(11, 16) : '';
  return { date, time };
}

function localDateTimeStr() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(date, time) {
  if (!date) return '—';
  const d = new Date(date + 'T12:00:00');
  const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!time) return datePart;
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${datePart} · ${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function SalesView({ token, products }) {
  const [transactions,   setTransactions]   = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);
  // Default to 'all' so freshly-recorded transactions always show up on first
  // load, even if there's any date-conversion oddity that excludes them from a
  // narrower window.
  const [period,         setPeriod]         = useState('all');
  const [showProcess,    setShowProcess]    = useState(false);
  const [budgetExpenses, setBudgetExpenses] = useState([]);
  const [expLoading,     setExpLoading]     = useState(false);
  const [expandedTx,     setExpandedTx]     = useState(null);
  const [editingTx,      setEditingTx]      = useState(null);
  const [reportCopied,   setReportCopied]   = useState(false);
  const [refreshCount,   setRefreshCount]   = useState(0);
  const [rawRowCount,    setRawRowCount]    = useState(0);
  const [profitSpent,    setProfitSpent]    = useState(0); // total already withdrawn from Profit+Revenue

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        let rows = await readRange(token, `${TRANS_SHEET}!A:H`, 'UNFORMATTED_VALUE');
        if (cancelled) return;

        // One-time migration from v1 (no Client col) → v2 (with Client col B).
        const hasHeader = String(rows[0]?.[0] || '').toLowerCase() === 'date';
        const isV1 = hasHeader && String(rows[0]?.[1] || '').toLowerCase() === 'product';
        if (isV1) {
          const updates = [];
          rows.forEach((row, i) => {
            const sheetRow = i + 1;
            if (i === 0) {
              ['Date','Client','Product','Quantity','Unit Price','Revenue','Margin %','Allocation']
                .forEach((val, j) => updates.push({
                  range: `${TRANS_SHEET}!${String.fromCharCode(65 + j)}${sheetRow}`, value: val,
                }));
            } else {
              // Shift B..G → C..H, insert empty Client in B.
              updates.push({ range: `${TRANS_SHEET}!B${sheetRow}`, value: '' });
              for (let j = 1; j <= 6; j++) {
                const val = row[j] != null ? row[j] : '';
                updates.push({ range: `${TRANS_SHEET}!${String.fromCharCode(66 + j)}${sheetRow}`, value: val });
              }
            }
          });
          if (updates.length) await batchUpdateCells(token, updates);
          rows = await readRange(token, `${TRANS_SHEET}!A:H`, 'UNFORMATTED_VALUE');
          if (cancelled) return;
        }

        setRawRowCount(rows.length);
        if (!rows.length) { setTransactions([]); return; }
        const headerNow = String(rows[0]?.[0] || '').toLowerCase() === 'date';
        const data = headerNow ? rows.slice(1) : rows;
        const headerOffset = headerNow ? 2 : 1;
        const parsed = data
          .map((r, idx) => {
            const hasAny = r.some(c => c !== '' && c !== null && c !== undefined);
            if (!hasAny) return null;
            let allocs = {};
            try { allocs = JSON.parse(r[7] || '{}'); } catch { allocs = {}; }
            const { date, time } = serialToDateTime(r[0]);
            return {
              id:        idx,
              rowNum:    idx + headerOffset,
              date,
              time,
              client:    r[1] || '',
              product:   r[2] || '',
              qty:       r[3] || '',
              unitPrice: parseFloat(r[4]) || 0,
              revenue:   parseFloat(r[5]) || 0,
              margin:    r[6] || '',
              allocs,
            };
          })
          .filter(Boolean);
        setTransactions(parsed);

        // Read spend records to know how much profit has already been withdrawn
        const spendRows = await readRange(token, `${SPEND_SHEET}!A:E`, 'UNFORMATTED_VALUE').catch(() => []);
        if (!cancelled) {
          const spent = (spendRows || [])
            .slice(String(spendRows?.[0]?.[0] || '').toLowerCase() === 'date' ? 1 : 0)
            .filter(r => r[1] === 'Profit' || r[1] === 'Revenue')
            .filter(r => String(r[4] || '').toLowerCase() === 'processed as personal income')
            .reduce((s, r) => s + (parseFloat(r[2]) || 0), 0);
          setProfitSpent(spent);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, refreshCount]);

  // Keep the sales list live while this tab is open — re-fetch every 30s.
  useEffect(() => {
    const id = setInterval(() => setRefreshCount(c => c + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const now = new Date();
  const filtered = useMemo(() => {
    if (period === 'all') return transactions;
    const prefix = period === 'month'
      ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      : `${now.getFullYear()}`;
    return transactions.filter(t => (t.date || '').startsWith(prefix));
  }, [transactions, period]);

  const { totalRevenue, categories, totalProfit, profitByCategory } = useMemo(() => {
    const totalRevenue = filtered.reduce((s, t) => s + t.revenue, 0);
    const catMap = {};
    filtered.forEach(t => {
      Object.entries(t.allocs).forEach(([name, amtStr]) => {
        const amt = parseFloat(amtStr) || 0;
        catMap[name] = (catMap[name] || 0) + amt;
      });
    });
    const categories = Object.entries(catMap)
      .map(([name, total]) => ({ name, total, color: CAT_COLORS[name] || CAT_COLORS.Other }))
      .sort((a, b) => b.total - a.total);
    const totalProfit = (catMap['Profit'] || 0) + (catMap['Revenue'] || 0);
    return { totalRevenue, categories, totalProfit, profitByCategory: { Profit: catMap['Profit'] || 0, Revenue: catMap['Revenue'] || 0 } };
  }, [filtered]);

  const netProfit = Math.max(0, totalProfit - profitSpent);

  async function handleProfitProcessed(amountProcessed) {
    if (amountProcessed <= 0) return;
    const date = new Date();
    const pad  = n => String(n).padStart(2, '0');
    const dateStr = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
    const desc = `Processed as personal income`;
    try {
      await ensureSheetTab(token, SPEND_SHEET);
      const existing = await readRange(token, `${SPEND_SHEET}!A1:E1`);
      if (!existing.length || !existing[0]?.length) {
        await appendRow(token, `${SPEND_SHEET}!A:E`, ['Date', 'Account', 'Amount', 'Vendor', 'Description']);
      }
      // Split the processed amount across Profit and Revenue proportionally
      const profitAmt  = profitByCategory.Profit;
      const revenueAmt = profitByCategory.Revenue;
      const total      = profitAmt + revenueAmt;
      if (total <= 0) return;
      const profitShare  = total > 0 ? (profitAmt  / total) * amountProcessed : 0;
      const revenueShare = total > 0 ? (revenueAmt / total) * amountProcessed : 0;
      if (profitShare  > 0.001) await appendRow(token, `${SPEND_SHEET}!A:E`, [dateStr, 'Profit',  parseFloat(profitShare.toFixed(2)),  '', desc]);
      if (revenueShare > 0.001) await appendRow(token, `${SPEND_SHEET}!A:E`, [dateStr, 'Revenue', parseFloat(revenueShare.toFixed(2)), '', desc]);
    } catch { /* non-critical — income was already logged */ }
  }

  function handleProcessAsIncome() {
    if (budgetExpenses.length > 0) { setShowProcess(true); return; }
    setExpLoading(true);
    readRange(token, 'Monthly Expenses!A1:T40')
      .then(rows => {
        if (rows.length) {
          const [headers, ...data] = rows;
          setBudgetExpenses(data.filter(r => r[0]).map(r =>
            headers.reduce((o, h, i) => { o[h] = r[i] ?? null; return o; }, {})
          ));
        }
        setShowProcess(true);
      })
      .catch(() => setShowProcess(true))
      .finally(() => setExpLoading(false));
  }

  async function handleEditSave(updated) {
    const rn = updated.rowNum;
    const allocJSON = JSON.stringify(updated.allocs);
    const datetimeVal = updated.time ? `${updated.date} ${updated.time}` : updated.date;
    await batchUpdateCells(token, [
      { range: `${TRANS_SHEET}!A${rn}`, value: datetimeVal },
      { range: `${TRANS_SHEET}!B${rn}`, value: updated.client },
      { range: `${TRANS_SHEET}!C${rn}`, value: updated.product },
      { range: `${TRANS_SHEET}!D${rn}`, value: updated.qty },
      { range: `${TRANS_SHEET}!E${rn}`, value: updated.unitPrice },
      { range: `${TRANS_SHEET}!F${rn}`, value: updated.revenue },
      { range: `${TRANS_SHEET}!G${rn}`, value: updated.margin },
      { range: `${TRANS_SHEET}!H${rn}`, value: allocJSON },
    ]);
    setRefreshCount(c => c + 1);
  }

  async function handleDeleteTx(tx) {
    await clearRow(token, `${TRANS_SHEET}!A${tx.rowNum}:H${tx.rowNum}`);
    setRefreshCount(c => c + 1);
  }

  function copyReport() {
    const periodLabel = PERIOD_OPTIONS.find(o => o.key === period)?.label || period;
    const lines = [
      `Business Sales Report — ${periodLabel}`,
      `Generated: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
      `${filtered.length} transaction${filtered.length !== 1 ? 's' : ''} · Total Revenue: $${totalRevenue.toFixed(2)}`,
      '',
    ];
    filtered
      .slice()
      .sort((a, b) => (b.date > a.date ? 1 : -1))
      .forEach(t => {
        const dateStr = fmtDateTime(t.date, t.time);
        let header = `[${dateStr}] ${t.product}`;
        if (t.qty) header += ` ×${t.qty} @ $${t.unitPrice.toFixed(2)}`;
        header += ` = $${t.revenue.toFixed(2)}`;
        if (t.margin) header += ` (${t.margin} margin)`;
        lines.push(header);
        Object.entries(t.allocs).forEach(([name, amt]) => {
          const pct = t.revenue > 0 ? ((parseFloat(amt) / t.revenue) * 100).toFixed(1) : '0.0';
          lines.push(`  → ${name}: $${parseFloat(amt).toFixed(2)} (${pct}%)`);
        });
        lines.push('');
      });
    lines.push('─'.repeat(40));
    lines.push(`TOTAL REVENUE:  $${totalRevenue.toFixed(2)}`);
    categories.forEach(cat => {
      const pct = totalRevenue > 0 ? ((cat.total / totalRevenue) * 100).toFixed(1) : '0.0';
      lines.push(`  ${cat.name.padEnd(16)} $${cat.total.toFixed(2).padStart(8)}  (${pct}%)`);
    });
    navigator.clipboard.writeText(lines.join('\n'));
    setReportCopied(true);
    setTimeout(() => setReportCopied(false), 2000);
  }

  if (loading) return <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  if (error)   return <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-4 text-red-400 text-sm">{error}</div>;

  return (
    <div className="space-y-3">
      {/* Period filter + Copy Report */}
      <div className="flex gap-2">
        <div className="flex flex-1 bg-slate-800 rounded-xl p-1 gap-1">
          {PERIOD_OPTIONS.map(opt => (
            <button key={opt.key} onClick={() => setPeriod(opt.key)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${period === opt.key ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-300'}`}>
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setRefreshCount(c => c + 1)}
          title="Reload transactions from sheet"
          className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white text-xs font-medium transition-colors shrink-0"
        >
          ↻
        </button>
        <button
          onClick={copyReport}
          disabled={filtered.length === 0}
          title="Copy a formatted sales report to clipboard"
          className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium transition-colors shrink-0"
        >
          {reportCopied ? '✓' : '📋'}
        </button>
      </div>

      {/* Diagnostic status line — always visible so user can see what loaded */}
      <p className="text-slate-600 text-[10px] px-1">
        Loaded {rawRowCount} row{rawRowCount !== 1 ? 's' : ''} from sheet ·{' '}
        {transactions.length} transaction{transactions.length !== 1 ? 's' : ''} parsed ·{' '}
        {filtered.length} match{filtered.length === 1 ? 'es' : ''} current filter
      </p>

      {filtered.length === 0 ? (
        <div className="bg-slate-900 rounded-2xl p-8 text-center space-y-3">
          <p className="text-4xl">📊</p>
          {transactions.length === 0 ? (
            <>
              <p className="text-white font-semibold font-broske">No transactions yet</p>
              <p className="text-slate-500 text-sm">
                Process a product sale to see the revenue flow here.
                {rawRowCount > 0 && ` (Sheet has ${rawRowCount} row${rawRowCount !== 1 ? 's' : ''} but none parsed as valid transactions.)`}
              </p>
              <button
                onClick={() => setRefreshCount(c => c + 1)}
                className="mt-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium px-4 py-2 rounded-xl transition-colors"
              >
                ↻ Reload from sheet
              </button>
            </>
          ) : (
            <>
              <p className="text-white font-semibold font-broske">No transactions in this period</p>
              <p className="text-slate-500 text-sm">
                {transactions.length} transaction{transactions.length !== 1 ? 's' : ''} exist{transactions.length === 1 ? 's' : ''} in your sheet but none match the current filter.
              </p>
              <button
                onClick={() => setPeriod('all')}
                className="mt-2 bg-green-600 hover:bg-green-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors"
              >
                Show All Time
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          {/* ── Compact summary grid ── */}
          <div className="grid grid-cols-2 gap-2">
            {/* Revenue tile */}
            <div className="bg-green-900/20 border border-green-700/40 rounded-2xl p-3">
              <p className="text-green-300 text-[10px] uppercase tracking-wider font-broske mb-1">Revenue</p>
              <p className="text-white text-2xl font-bold font-mono tabular-nums">${totalRevenue.toFixed(2)}</p>
              <p className="text-slate-500 text-[10px] mt-1">
                {filtered.length} sale{filtered.length !== 1 ? 's' : ''} · {new Set(filtered.map(t => t.product)).size} product{new Set(filtered.map(t => t.product)).size !== 1 ? 's' : ''}
              </p>
            </div>

            {/* Profit tile — includes Revenue allocations */}
            <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-2xl p-3">
              <p className="text-emerald-300 text-[10px] uppercase tracking-wider font-broske mb-1">Profit</p>
              <p className="text-white text-2xl font-bold font-mono tabular-nums">${netProfit.toFixed(2)}</p>
              {totalRevenue > 0 && (
                <p className="text-emerald-600 text-[10px] mt-1">{((totalProfit / totalRevenue) * 100).toFixed(1)}% margin</p>
              )}
              {profitSpent > 0 && (
                <p className="text-amber-500 text-[10px] mt-0.5">${profitSpent.toFixed(2)} already processed</p>
              )}
            </div>
          </div>

          {/* Allocation bar + breakdown */}
          <div className="bg-slate-800 rounded-2xl p-3 space-y-2">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider font-broske">Allocation</p>
            {totalRevenue > 0 && (
              <div className="flex h-3 rounded-full overflow-hidden">
                {categories.map(cat => (
                  <div key={cat.name}
                    style={{ width: `${(cat.total / totalRevenue) * 100}%`, background: cat.color }}
                    title={`${cat.name}: $${cat.total.toFixed(2)}`}
                  />
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {categories.map(cat => (
                <div key={cat.name} className="flex items-center gap-1.5 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cat.color }} />
                  <span className={`text-[11px] truncate flex-1 ${(cat.name === 'Profit' || cat.name === 'Revenue') ? 'text-emerald-300 font-semibold' : 'text-slate-300'}`}>{cat.name}</span>
                  <span className={`text-[11px] font-mono tabular-nums shrink-0 ${(cat.name === 'Profit' || cat.name === 'Revenue') ? 'text-emerald-400 font-bold' : 'text-white'}`}>${cat.total.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Process profit button */}
          <button
            onClick={handleProcessAsIncome}
            disabled={expLoading || netProfit <= 0}
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm transition-colors"
          >
            {expLoading ? 'Loading budget…' : netProfit <= 0 ? (totalProfit > 0 ? 'Already processed' : 'No profit to process') : `Process $${netProfit.toFixed(2)} as Income →`}
          </button>

          {/* ── Transaction list ── */}
          <div className="space-y-2">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider px-1">Transaction History — tap to expand</p>
            {filtered
              .slice()
              .sort((a, b) => (b.date > a.date ? 1 : -1))
              .map((t, i) => {
                const isOpen = expandedTx === i;
                return (
                  <div key={i} className="bg-slate-800 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedTx(isOpen ? null : i)}
                      className="w-full px-4 py-3 text-left space-y-1.5"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <p className="text-white text-sm font-medium truncate">{t.product}</p>
                          <p className="text-slate-500 text-xs mt-0.5">
                            {t.client ? <span className="text-slate-400">{t.client} · </span> : null}
                            {fmtDateTime(t.date, t.time)}
                            {t.qty ? ` · ×${t.qty}` : ''}
                            {t.margin ? ` · ${t.margin}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-green-400 font-bold font-mono tabular-nums text-sm">+${t.revenue.toFixed(2)}</span>
                          <span className="text-slate-600 text-[10px]">{isOpen ? '▲' : '▼'}</span>
                        </div>
                      </div>
                      {Object.keys(t.allocs).length > 0 && (
                        <div className="flex h-1.5 rounded-full overflow-hidden">
                          {Object.entries(t.allocs).map(([name, amt]) => {
                            const color = CAT_COLORS[name] || CAT_COLORS.Other;
                            const pct = t.revenue > 0 ? (parseFloat(amt) / t.revenue) * 100 : 0;
                            return <div key={name} style={{ width: `${pct}%`, background: color }} title={`${name}: $${parseFloat(amt).toFixed(2)}`} />;
                          })}
                        </div>
                      )}
                    </button>

                    {isOpen && (
                      <div className="border-t border-slate-700 px-4 pb-3 pt-3 space-y-2">
                        {/* Client if present */}
                        {t.client && (
                          <p className="text-slate-400 text-xs">Client: <span className="text-white font-medium">{t.client}</span></p>
                        )}
                        <div className="space-y-1.5">
                          {Object.entries(t.allocs).map(([name, amt]) => {
                            const color = CAT_COLORS[name] || CAT_COLORS.Other;
                            const amtNum = parseFloat(amt) || 0;
                            const pct = t.revenue > 0 ? (amtNum / t.revenue) * 100 : 0;
                            return (
                              <div key={name} className="flex items-center gap-3">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                                <span className="text-slate-300 text-xs flex-1">{name}</span>
                                <div className="w-16 bg-slate-700 rounded-full h-1 overflow-hidden">
                                  <div className="h-1 rounded-full" style={{ width: `${pct}%`, background: color }} />
                                </div>
                                <span className="text-slate-500 text-[10px] font-mono w-8 text-right tabular-nums">{pct.toFixed(1)}%</span>
                                <span className="text-white text-xs font-mono font-bold tabular-nums w-14 text-right">${amtNum.toFixed(2)}</span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="border-t border-slate-700 pt-2 flex items-center justify-between gap-2">
                          <span className="text-slate-500 text-xs">Total: <span className="text-green-400 font-bold font-mono">${t.revenue.toFixed(2)}</span></span>
                          <button
                            onClick={e => { e.stopPropagation(); setEditingTx(t); setExpandedTx(null); }}
                            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-medium transition-colors"
                          >
                            Edit / Revise
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            }
          </div>
        </>
      )}

      {showProcess && (
        <ProcessIncome
          expenses={budgetExpenses}
          token={token}
          onClose={() => setShowProcess(false)}
          defaultIncome={netProfit}
          onProcessed={handleProfitProcessed}
        />
      )}

      {editingTx && (
        <EditTransactionModal
          tx={editingTx}
          products={products}
          token={token}
          onSave={handleEditSave}
          onDelete={handleDeleteTx}
          onClose={() => setEditingTx(null)}
        />
      )}
    </div>
  );
}

// ── Accounts view (per-allocation-category balance + drawdown) ──────────────

function AccountsView({ token, products, refreshKey }) {
  const [txns,     setTxns]     = useState([]);
  const [spending, setSpending] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [err,      setErr]      = useState(null);
  const [openAcct, setOpenAcct] = useState(null);
  const [internal, setInternal] = useState(0); // bump after spend → reload

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const [salesRows, spendRows] = await Promise.all([
          readRange(token, `${TRANS_SHEET}!A:H`, 'UNFORMATTED_VALUE'),
          ensureSheetTab(token, SPEND_SHEET)
            .then(() => readRange(token, `${SPEND_SHEET}!A:E`, 'UNFORMATTED_VALUE'))
            .catch(() => []),
        ]);
        if (cancelled) return;

        // Parse business transactions → list of {date, product, client, allocs}
        const parsedSales = salesRows
          .slice(String(salesRows[0]?.[0] || '').toLowerCase() === 'date' ? 1 : 0)
          .map(r => {
            if (!r || r.every(c => c === '' || c == null)) return null;
            let allocs = {};
            try { allocs = JSON.parse(r[7] || '{}'); } catch {}
            return {
              date: r[0], client: r[1] || '', product: r[2] || '',
              revenue: parseFloat(r[5]) || 0, allocs,
            };
          })
          .filter(Boolean);
        setTxns(parsedSales);

        // Parse spending (drawdowns)
        const parsedSpend = (spendRows || [])
          .slice(String(spendRows?.[0]?.[0] || '').toLowerCase() === 'date' ? 1 : 0)
          .map((r, idx) => ({
            rowNum: idx + 2, date: r[0],
            account: r[1] || '', amount: parseFloat(r[2]) || 0,
            vendor: r[3] || '', description: r[4] || '',
          }))
          .filter(r => r.account);
        setSpending(parsedSpend);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, refreshKey, internal]);

  // Discover accounts: union of allocation category names across products + any
  // category that has historical sales/spending. Use blockLabel so custom
  // "Other" names show up too.
  const accountNames = useMemo(() => {
    const set = new Set();
    products.forEach(p => (p.formula || []).forEach(b => set.add(blockLabel(b))));
    txns.forEach(t => Object.keys(t.allocs || {}).forEach(k => set.add(k)));
    spending.forEach(s => set.add(s.account));
    return Array.from(set);
  }, [products, txns, spending]);

  const accounts = useMemo(() => accountNames.map(name => {
    const contributed = txns.reduce((s, t) => s + (parseFloat(t.allocs?.[name]) || 0), 0);
    const spent       = spending.filter(s => s.account === name).reduce((s, r) => s + r.amount, 0);
    const balance     = contributed - spent;
    // Pull a representative color from any product block whose label matches
    const block = products.flatMap(p => p.formula || []).find(b => blockLabel(b) === name);
    const color = block ? blockColor(block) : (CAT_COLORS[name] || CAT_COLORS.Other);
    return { name, contributed, spent, balance, color };
  }).sort((a, b) => b.balance - a.balance), [accountNames, txns, spending, products]);

  if (loading) return <div className="px-4 py-10"><LoadingSpinner /></div>;

  return (
    <div className="px-4 space-y-4">
      {err && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-sm">{err}</div>
      )}
      <p className="text-slate-500 text-xs">
        Each formula category is a "bucket" — tap one to spend out of it (writes a row to the
        <span className="text-slate-300"> Business Account Spending</span> sheet).
      </p>

      {/* Diagnostics: shows what AccountsView actually read from the sheet */}
      <details className="bg-slate-900 border border-slate-800 rounded-xl text-xs">
        <summary className="px-3 py-2 text-slate-400 cursor-pointer select-none">
          🔍 Diagnostics — {txns.length} sale row{txns.length === 1 ? '' : 's'}, {spending.length} spending row{spending.length === 1 ? '' : 's'}
        </summary>
        <div className="px-3 pb-3 space-y-2 font-mono text-[11px] text-slate-400">
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Account names detected</div>
            <div className="text-slate-300 break-all">{accountNames.length ? accountNames.join(' · ') : '(none)'}</div>
          </div>
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Last 3 sales — allocs JSON</div>
            {txns.length === 0 ? (
              <div className="text-rose-400">No rows in Business Transactions sheet (col H allocs).</div>
            ) : (
              <ul className="space-y-1">
                {txns.slice(-3).map((t, i) => {
                  const allocKeys = Object.keys(t.allocs || {});
                  const allocSum = allocKeys.reduce((s, k) => s + (parseFloat(t.allocs[k]) || 0), 0);
                  return (
                    <li key={i} className="border border-slate-800 rounded p-2">
                      <div className="text-slate-300">{t.product || '(no product)'} · rev ${t.revenue.toFixed(2)}</div>
                      <div className={allocKeys.length === 0 ? 'text-rose-400' : 'text-emerald-400'}>
                        {allocKeys.length === 0
                          ? '⚠ allocs empty — row was written with no formula data'
                          : `${allocKeys.length} keys, total $${allocSum.toFixed(2)}`}
                      </div>
                      <div className="text-slate-500 break-all">{JSON.stringify(t.allocs)}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </details>

      {accounts.length === 0 && (
        <div className="bg-slate-900 rounded-2xl p-8 text-center space-y-2 text-slate-500 text-sm">
          No accounts yet. Add allocation categories (COGS, Overhead, …) to a product to create them.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {accounts.map(a => (
          <button
            key={a.name}
            onClick={() => setOpenAcct(a)}
            className="text-left rounded-2xl bg-slate-800 hover:bg-slate-700/80 p-4 transition-colors border-t-4"
            style={{ borderTopColor: a.color }}
          >
            <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">{a.name}</p>
            <p className={`mt-2 text-xl font-bold font-mono tabular-nums ${a.balance < 0 ? 'text-rose-400' : 'text-white'}`}>
              ${a.balance.toFixed(2)}
            </p>
            <div className="mt-2 flex flex-col gap-0.5 text-[10px] text-slate-500 font-mono tabular-nums">
              <span>+ ${a.contributed.toFixed(2)} earned</span>
              <span>− ${a.spent.toFixed(2)} spent</span>
            </div>
          </button>
        ))}
      </div>

      {openAcct && (
        <AccountSpendModal
          token={token}
          account={openAcct}
          history={spending.filter(s => s.account === openAcct.name)}
          contributions={txns
            .filter(t => parseFloat(t.allocs?.[openAcct.name]) > 0)
            .map(t => ({ date: t.date, label: `${t.product}${t.client ? ' — ' + t.client : ''}`, amount: parseFloat(t.allocs[openAcct.name]) }))}
          onClose={() => setOpenAcct(null)}
          onChange={() => { setInternal(i => i + 1); setOpenAcct(null); }}
        />
      )}
    </div>
  );
}

function AccountSpendModal({ token, account, history, contributions, onClose, onChange }) {
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [desc,   setDesc]   = useState('');
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState(null);
  const [tab,    setTab]    = useState('spend'); // 'spend' | 'history'

  const amt = parseFloat(amount) || 0;
  const wouldOverdraw = amt > account.balance;

  async function handleSpend() {
    if (!amt) return;
    setBusy(true); setErr(null);
    try {
      await ensureSheetTab(token, SPEND_SHEET);
      const existing = await readRange(token, `${SPEND_SHEET}!A1:E1`);
      if (!existing.length || !existing[0]?.length) {
        await appendRow(token, `${SPEND_SHEET}!A:E`, ['Date', 'Account', 'Amount', 'Vendor', 'Description']);
      }
      await appendRow(token, `${SPEND_SHEET}!A:E`, [
        new Date().toISOString().slice(0, 10),
        account.name,
        amt.toFixed(2),
        vendor.trim(),
        desc.trim(),
      ]);
      onChange();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50">
      <div className="bg-slate-900 w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl max-h-[92vh] flex flex-col">
        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-slate-400 text-[10px] uppercase tracking-wider font-broske">Account</p>
            <h3 className="text-white font-bold font-broske text-lg" style={{ color: account.color }}>{account.name}</h3>
            <p className={`mt-1 font-mono font-bold text-2xl tabular-nums ${account.balance < 0 ? 'text-rose-400' : 'text-white'}`}>
              ${account.balance.toFixed(2)}
            </p>
            <p className="text-[11px] text-slate-500 font-mono tabular-nums">+${account.contributed.toFixed(2)} earned · −${account.spent.toFixed(2)} spent</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 grid place-items-center">✕</button>
        </div>

        <div className="shrink-0 flex bg-slate-800 mx-5 mt-4 rounded-xl p-1 gap-1">
          {[['spend', 'Spend'], ['history', `History (${history.length + contributions.length})`]].map(([t, lbl]) => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === t ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-300'}`}>
              {lbl}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {tab === 'spend' && (
            <>
              <div>
                <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5 font-broske">Amount</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg font-bold">$</span>
                  <input
                    type="number" step="0.01" min="0" autoFocus
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-emerald-500 font-mono tabular-nums placeholder-slate-600"
                  />
                </div>
                {wouldOverdraw && amt > 0 && (
                  <p className="text-amber-400 text-xs mt-1.5">Over balance by ${(amt - account.balance).toFixed(2)}. Recording anyway will let the balance go negative.</p>
                )}
              </div>
              <div>
                <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5 font-broske">Payee / Vendor</label>
                <input value={vendor} onChange={e => setVendor(e.target.value)} placeholder="e.g. Sticker Mule" className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600" />
              </div>
              <div>
                <label className="text-slate-400 text-[10px] uppercase tracking-wider block mb-1.5 font-broske">Description</label>
                <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Inventory restock — sticker paper" className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600" />
              </div>
              {err && <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-400 text-xs">{err}</div>}
            </>
          )}

          {tab === 'history' && (
            <div className="space-y-3">
              {contributions.length === 0 && history.length === 0 && (
                <p className="text-slate-500 text-sm text-center py-6">No activity yet.</p>
              )}
              {contributions.length > 0 && (
                <div>
                  <p className="text-emerald-400 text-[10px] uppercase tracking-wider font-broske mb-1.5">Earned ({contributions.length})</p>
                  <ul className="divide-y divide-slate-800 rounded-xl bg-slate-800/40 overflow-hidden">
                    {contributions.slice().reverse().slice(0, 30).map((c, i) => (
                      <li key={i} className="flex justify-between px-3 py-2 text-sm">
                        <span className="text-slate-300 truncate pr-2">{c.label}</span>
                        <span className="text-emerald-400 font-mono tabular-nums shrink-0">+${c.amount.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {history.length > 0 && (
                <div>
                  <p className="text-rose-400 text-[10px] uppercase tracking-wider font-broske mb-1.5">Spent ({history.length})</p>
                  <ul className="divide-y divide-slate-800 rounded-xl bg-slate-800/40 overflow-hidden">
                    {history.slice().reverse().slice(0, 30).map((h, i) => (
                      <li key={i} className="flex justify-between px-3 py-2 text-sm">
                        <span className="text-slate-300 truncate pr-2">{[h.vendor, h.description].filter(Boolean).join(' — ') || '—'}</span>
                        <span className="text-rose-400 font-mono tabular-nums shrink-0">−${h.amount.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {tab === 'spend' && (
          <div className="shrink-0 px-5 py-4 border-t border-slate-800 flex gap-3">
            <button onClick={onClose} className="px-4 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium">Cancel</button>
            <button
              onClick={handleSpend}
              disabled={!amt || busy}
              className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm transition-colors"
            >
              {busy ? 'Recording…' : `Spend $${amt.toFixed(2)} from ${account.name}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BusinessExpenses({ token }) {
  const [products,   setProducts]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [editing,          setEditing]          = useState(null);
  const [processing,       setProcessing]       = useState(null);
  const [viewMode,         setViewMode]         = useState('cards'); // 'cards' | 'compare'
  const [salesRefreshKey,  setSalesRefreshKey]  = useState(0);

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
          className="bg-green-600 hover:bg-green-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-colors"
        >
          + Add
        </button>
      </div>

      <div className="px-4 space-y-4">
        {error && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-4 text-red-400 text-sm space-y-2">
            <p className="font-medium">Could not load Business Products sheet</p>
            <p className="text-xs text-red-500">{error}</p>
            <button onClick={load} className="text-green-400 underline text-xs">Retry</button>
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
                  return s + (steps.find(st => st.category === 'Profit')?.allocated || 0)
                           + (steps.find(st => st.category === 'Revenue')?.allocated || 0);
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
        <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
          {[
            ...(products.length > 0 ? [['cards','Cards'],['compare','Compare']] : []),
            ['sales','Sales 📊'],
            ['accounts','Accounts 🏦'],
          ].map(([v, lbl]) => (
            <button key={v} onClick={() => setViewMode(v)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${viewMode === v ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-300'}`}>
              {lbl}
            </button>
          ))}
        </div>

        {/* Empty state */}
        {!error && products.length === 0 && viewMode !== 'sales' && (
          <div className="bg-slate-900 rounded-2xl p-8 text-center space-y-3">
            <p className="text-4xl">💼</p>
            <p className="text-white font-semibold font-broske">No products yet</p>
            <p className="text-slate-500 text-sm leading-relaxed">Add a product and define how its revenue is allocated across COGS, profit, fees, and more.</p>
            <button
              onClick={() => setEditing({ name: '', startPrice: 0, formula: [] })}
              className="mt-1 bg-green-600 hover:bg-green-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-colors"
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
              const profitAmt = (steps.find(st => st.category === 'Profit')?.allocated || 0)
                              + (steps.find(st => st.category === 'Revenue')?.allocated || 0);
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
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/40 text-green-300 font-mono tabular-nums">COGS ${cogsAmt.toFixed(2)}</span>
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
                      className="flex-1 py-2.5 text-xs font-semibold text-green-400 hover:bg-slate-700 transition-colors">
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

      {viewMode === 'sales' && (
        <SalesView key={salesRefreshKey} token={token} products={products} />
      )}

      {viewMode === 'accounts' && (
        <AccountsView token={token} products={products} refreshKey={salesRefreshKey} />
      )}

      {editing    && <FormulaEditor product={editing}    onSave={handleSave} onClose={() => setEditing(null)}    saving={saving} />}
      {processing && (
        <ProcessModal
          product={processing}
          token={token}
          onClose={() => setProcessing(null)}
          onSuccess={() => {
            setSalesRefreshKey(k => k + 1);
            setViewMode('sales');   // auto-switch to Sales tab so the user sees the new transaction immediately
          }}
        />
      )}
      {saving && !editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 pointer-events-none">
          <LoadingSpinner />
        </div>
      )}
    </div>
  );
}
