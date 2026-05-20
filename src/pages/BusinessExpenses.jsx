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

// Display name for a block — uses customName when category is Other
function blockLabel(block) {
  return (block.category === 'Other' && block.customName?.trim()) ? block.customName.trim() : block.category;
}
function blockColor(block) {
  return CAT_COLORS[block.category] || CAT_COLORS.Other;
}

// Waterfall computation: each % is taken from remaining pool
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

// ── Formula Editor ─────────────────────────────────────────────────────────────

function FormulaEditor({ product, onSave, onClose, saving }) {
  const [name,       setName]       = useState(product.name || '');
  const [startPrice, setStartPrice] = useState(product.startPrice > 0 ? String(product.startPrice) : '');
  const [blocks,     setBlocks]     = useState(product.formula?.length ? product.formula : []);

  const price = parseFloat(startPrice) || 0;
  const { steps, remaining } = computeFormula(price, blocks);
  const balanced = Math.abs(remaining) < 0.001;
  const canSave  = name.trim() && price > 0 && balanced;

  function addBlock() {
    setBlocks(b => [...b, { id: uid(), category: 'COGS', type: 'fixed', value: '', customName: '' }]);
  }
  function removeBlock(id) { setBlocks(b => b.filter(bl => bl.id !== id)); }
  function updateBlock(id, key, val) {
    setBlocks(b => b.map(bl => {
      if (bl.id !== id) return bl;
      const updated = { ...bl, [key]: val };
      // Clear customName when switching away from Other
      if (key === 'category' && val !== 'Other') updated.customName = '';
      return updated;
    }));
  }

  return (
    <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-800 px-5 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-white font-bold text-lg font-broske">{product.id ? 'Edit Formula' : 'New Product'}</h2>
          <p className="text-slate-400 text-xs mt-0.5">Waterfall — each % is of the remaining pool</p>
        </div>
        <button onClick={onClose} className="w-9 h-9 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-lg">✕</button>
      </div>

      {/* Scrollable body */}
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

          {/* Starting pool indicator */}
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
                {/* Block editor */}
                <div className="bg-slate-900 rounded-xl p-3 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-600 text-xs font-mono w-4 text-center shrink-0">{idx + 1}</span>
                    {/* Category dropdown */}
                    <select
                      value={step.category}
                      onChange={e => updateBlock(step.id, 'category', e.target.value)}
                      className="flex-1 bg-slate-800 text-white rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {BUILT_IN_CATS.map(c => <option key={c}>{c}</option>)}
                    </select>
                    {/* $ / % toggle */}
                    <div className="flex bg-slate-800 rounded-lg p-0.5 shrink-0">
                      {[['fixed','$'],['percent','%']].map(([t, lbl]) => (
                        <button key={t} onClick={() => updateBlock(step.id, 'type', t)}
                          className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${step.type === t ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                    {/* Value */}
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

                  {/* Custom name input — only shown when category is Other */}
                  {step.category === 'Other' && (
                    <div className="flex items-center gap-2 ml-5">
                      <span className="text-slate-500 text-xs shrink-0">Custom name:</span>
                      <input
                        value={step.customName || ''}
                        onChange={e => updateBlock(step.id, 'customName', e.target.value)}
                        placeholder="e.g. Platform cut, Packaging…"
                        className="flex-1 bg-slate-800 text-white rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-blue-500 placeholder-slate-600"
                        autoFocus
                      />
                    </div>
                  )}

                  {/* Allocation result row */}
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

                {/* Remaining after this step */}
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

        {/* Summary stacked bar */}
        {price > 0 && steps.length > 0 && (
          <div className="bg-slate-900 rounded-2xl p-4 space-y-3">
            <p className="text-slate-400 text-xs uppercase tracking-wider font-broske">Allocation Summary</p>
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

      {/* Footer */}
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

function ProcessModal({ product, onClose }) {
  const { steps, remaining } = computeFormula(product.startPrice, product.formula);
  const balanced = Math.abs(remaining) < 0.001;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end z-50">
      <div className="bg-slate-900 w-full rounded-t-3xl max-h-[88vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold font-broske">{product.name}</h3>
            <p className="text-slate-400 text-xs mt-0.5">Revenue allocation breakdown · Start: <span className="font-mono text-white">${product.startPrice.toFixed(2)}</span></p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center">✕</button>
        </div>
        <div className="px-5 py-5 space-y-2 pb-8">
          <div className="flex items-center justify-between px-4 py-3 bg-blue-900/20 border border-blue-800/40 rounded-xl">
            <span className="text-blue-300 font-broske text-xs uppercase tracking-wider">Formula Start</span>
            <span className="text-white font-bold text-2xl font-mono tabular-nums">${product.startPrice.toFixed(2)}</span>
          </div>

          {steps.map((step, idx) => {
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
                          ? `$${parseFloat(step.value || 0).toFixed(2)} fixed`
                          : `${step.value}% of remaining`}
                      </span>
                    </div>
                  </div>
                  <span className="font-mono font-bold text-white tabular-nums shrink-0">→ ${step.allocated.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-2 px-4">
                  <div className="flex-1 bg-slate-800 rounded-full h-1 overflow-hidden">
                    <div className="h-1 rounded-full bg-slate-700"
                      style={{ width: `${product.startPrice > 0 ? (step.remainingAfter / product.startPrice) * 100 : 0}%` }} />
                  </div>
                  <span className="text-slate-600 text-[10px] font-mono shrink-0">${step.remainingAfter.toFixed(2)} left</span>
                </div>
              </div>
            );
          })}

          <div className={`flex items-center justify-between px-4 py-3 rounded-xl border font-bold mt-2 ${balanced ? 'bg-emerald-900/20 border-emerald-800/40' : 'bg-rose-900/20 border-rose-800/40'}`}>
            <span className={`font-broske text-xs uppercase tracking-wider ${balanced ? 'text-emerald-400' : 'text-rose-400'}`}>Net Remaining</span>
            <span className={`font-mono text-2xl tabular-nums ${balanced ? 'text-emerald-400' : 'text-rose-400'}`}>${remaining.toFixed(2)}</span>
          </div>
        </div>
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
  const [editing,    setEditing]    = useState(null);
  const [processing, setProcessing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Ensure the tab exists and has headers
      await ensureSheetTab(token, SHEET);
      const rows = await readRange(token, `${SHEET}!A:D`);

      if (!rows.length || !rows[0]?.length) {
        // Sheet is empty — write headers
        await batchUpdateCells(token, HEADERS.map((h, i) => ({
          range: `${SHEET}!${String.fromCharCode(65 + i)}1`,
          value: h,
        })));
        setProducts([]);
        return;
      }

      // Skip header row; filter empty rows
      const [, ...dataRows] = rows;
      const parsed = dataRows
        .map((row, idx) => {
          const id = row[0];
          if (!id || id === 'ID') return null;
          let formula = [];
          try { formula = JSON.parse(row[3] || '[]'); } catch { formula = []; }
          return {
            id,
            name: row[1] || '',
            startPrice: parseFloat(row[2]) || 0,
            formula,
            _rowNum: idx + 2, // 1-indexed, row 1 is header
          };
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
        // Edit existing row
        await batchUpdateCells(token, [
          { range: `${SHEET}!B${product._rowNum}`, value: product.name },
          { range: `${SHEET}!C${product._rowNum}`, value: product.startPrice },
          { range: `${SHEET}!D${product._rowNum}`, value: JSON.stringify(product.formula) },
        ]);
      } else {
        // New product
        const newId = uid();
        await appendRow(token, `${SHEET}!A:D`, [
          newId,
          product.name,
          product.startPrice,
          JSON.stringify(product.formula),
        ]);
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

  const avgProfit = products.length > 0
    ? products.reduce((s, p) => {
        const { steps } = computeFormula(p.startPrice, p.formula);
        return s + (steps.find(st => st.category === 'Profit')?.allocated || 0);
      }, 0) / products.length
    : 0;

  return (
    <div className="pb-24">
      {/* Header */}
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
            <p className="text-xs text-slate-500">Make sure you have access to the spreadsheet, then <button onClick={load} className="text-blue-400 underline">retry</button>.</p>
          </div>
        )}

        {/* Summary */}
        {products.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-800 rounded-xl p-3">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Products</p>
              <p className="text-white font-bold text-xl mt-0.5 font-mono">{products.length}</p>
            </div>
            <div className="bg-slate-800 rounded-xl p-3">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider">Avg Profit / Item</p>
              <p className="text-emerald-400 font-bold text-xl mt-0.5 font-mono tabular-nums">${avgProfit.toFixed(2)}</p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!error && products.length === 0 && (
          <div className="bg-slate-900 rounded-2xl p-8 text-center space-y-3">
            <p className="text-4xl">💼</p>
            <p className="text-white font-semibold font-broske">No products yet</p>
            <p className="text-slate-500 text-sm leading-relaxed">
              Add a product and define how its revenue is allocated across COGS, profit, fees, and more. Data syncs to your Google Sheet.
            </p>
            <button
              onClick={() => setEditing({ name: '', startPrice: 0, formula: [] })}
              className="mt-1 bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-colors"
            >
              + Add First Product
            </button>
          </div>
        )}

        {/* Product cards */}
        <div className="space-y-3">
          {products.map(product => {
            const { steps, remaining } = computeFormula(product.startPrice, product.formula);
            const balanced  = Math.abs(remaining) < 0.001;
            const profitAmt = steps.find(st => st.category === 'Profit')?.allocated || 0;
            const cogsAmt   = steps.find(st => st.category === 'COGS')?.allocated   || 0;

            return (
              <div key={product.id} className="bg-slate-800 rounded-2xl overflow-hidden">
                <div className="px-4 pt-4 pb-3">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="min-w-0">
                      <p className="text-white font-semibold truncate">{product.name}</p>
                      <p className="text-slate-400 text-xs mt-0.5">
                        Start: <span className="font-mono text-white tabular-nums">${product.startPrice.toFixed(2)}</span>
                        {' · '}{product.formula.length} step{product.formula.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${balanced ? 'bg-emerald-900/50 text-emerald-300' : 'bg-rose-900/50 text-rose-300'}`}>
                      {balanced ? '✓ Balanced' : `$${remaining.toFixed(2)} left`}
                    </span>
                  </div>

                  {/* Stacked allocation bar */}
                  {product.startPrice > 0 && steps.length > 0 && (
                    <div className="flex h-3 rounded-full overflow-hidden mb-3">
                      {steps.map(step => (
                        <div key={step.id}
                          style={{ width: `${(step.allocated / product.startPrice) * 100}%`, background: blockColor(step) }}
                          title={`${blockLabel(step)}: $${step.allocated.toFixed(2)}`}
                        />
                      ))}
                      {remaining > 0 && (
                        <div style={{ width: `${(remaining / product.startPrice) * 100}%` }} className="bg-rose-900/60" />
                      )}
                    </div>
                  )}

                  {/* Key stat chips */}
                  <div className="flex flex-wrap gap-2">
                    {cogsAmt > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300 font-mono tabular-nums">
                        COGS ${cogsAmt.toFixed(2)}
                      </span>
                    )}
                    {profitAmt > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 font-mono tabular-nums">
                        Profit ${profitAmt.toFixed(2)}
                      </span>
                    )}
                    {steps
                      .filter(st => st.category !== 'COGS' && st.category !== 'Profit')
                      .map(st => (
                        <span key={st.id} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-400 font-mono tabular-nums">
                          {blockLabel(st)} ${st.allocated.toFixed(2)}
                        </span>
                      ))}
                  </div>
                </div>

                {/* Action row */}
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
                  <button onClick={() => handleDelete(product)}
                    disabled={saving}
                    className="px-4 py-2.5 text-xs font-medium text-rose-500 hover:bg-slate-700 transition-colors disabled:opacity-50">
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {editing    && <FormulaEditor product={editing}    onSave={handleSave} onClose={() => setEditing(null)}    saving={saving} />}
      {processing && <ProcessModal  product={processing}                     onClose={() => setProcessing(null)} />}
      {saving && !editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 pointer-events-none">
          <LoadingSpinner />
        </div>
      )}
    </div>
  );
}
