import { useState, useEffect, useCallback, useMemo } from 'react';
import { readRange, appendRow, batchUpdateCells, ensureSheetTab, clearRow } from '../lib/sheets';
import { SHEETS } from '../config';
import LoadingSpinner from '../components/LoadingSpinner';

// ── Constants ──────────────────────────────────────────────────────────────────

const SHEET = SHEETS.COMMISSION_PRICES;

const CATEGORIES = [
  'Sketch', 'Lineart', 'Flat Color', 'Shaded', 'Chibi',
  'Reference Sheet', 'Animation', 'Other',
];

const CATEGORY_COLORS = {
  'Sketch':           'text-slate-400  bg-slate-400/15  border-slate-400/30',
  'Lineart':          'text-blue-400   bg-blue-400/15   border-blue-400/30',
  'Flat Color':       'text-violet-400 bg-violet-400/15 border-violet-400/30',
  'Shaded':           'text-rose-400   bg-rose-400/15   border-rose-400/30',
  'Chibi':            'text-pink-400   bg-pink-400/15   border-pink-400/30',
  'Reference Sheet':  'text-amber-400  bg-amber-400/15  border-amber-400/30',
  'Animation':        'text-cyan-400   bg-cyan-400/15   border-cyan-400/30',
  'Other':            'text-slate-500  bg-slate-500/15  border-slate-500/30',
};

const CATEGORY_DOT = {
  'Sketch':           'bg-slate-400',
  'Lineart':          'bg-blue-400',
  'Flat Color':       'bg-violet-400',
  'Shaded':           'bg-rose-400',
  'Chibi':            'bg-pink-400',
  'Reference Sheet':  'bg-amber-400',
  'Animation':        'bg-cyan-400',
  'Other':            'bg-slate-500',
};

const HEADERS = ['ID', 'Category', 'Variant', 'BasePrice', 'ExtraChar', 'BgSimple', 'BgComplex', 'RushPct', 'CommercialPct', 'TimeHours', 'Notes', 'Active'];

const VARIANTS_SUGGEST = ['Icon/Headshot', 'Bust', 'Half-Body', 'Full Body', 'Simple', 'Complex', 'Multi-character', 'Chibi', 'Expression Sheet', 'Turnaround', 'Walk Cycle', 'Short Loop'];

function uid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function fmt(n) {
  return Number(n || 0).toFixed(2);
}

// ── Price calculator logic ────────────────────────────────────────────────────

function calcPrice(tier, { extraChars = 0, bg = 'none', rush = false, commercial = false }) {
  const base     = parseFloat(tier.BasePrice)     || 0;
  const ecCost   = extraChars * (parseFloat(tier.ExtraChar) || 0);
  const bgCost   = bg === 'simple'
    ? (parseFloat(tier.BgSimple) || 0)
    : bg === 'complex'
      ? (parseFloat(tier.BgComplex) || 0)
      : 0;

  const subtotal      = base + ecCost + bgCost;
  const rushAmt       = rush       ? subtotal * (parseFloat(tier.RushPct)       || 0) / 100 : 0;
  const commercialAmt = commercial ? base     * (parseFloat(tier.CommercialPct) || 0) / 100 : 0;
  const total         = subtotal + rushAmt + commercialAmt;

  return { base, ecCost, bgCost, subtotal, rushAmt, commercialAmt, total };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function catColorClass(cat) {
  return CATEGORY_COLORS[cat] || CATEGORY_COLORS['Other'];
}
function catDotClass(cat) {
  return CATEGORY_DOT[cat] || CATEGORY_DOT['Other'];
}

// ── Field component ───────────────────────────────────────────────────────────

function Field({ label, value, onChange, type = 'text', step, placeholder, required, hint }) {
  const cls = "w-full bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 placeholder-slate-500";
  return (
    <div className="space-y-1">
      <label className="text-slate-400 text-xs block">
        {label}
        {hint && <span className="ml-1.5 text-slate-600">{hint}</span>}
      </label>
      <input
        type={type}
        step={step}
        min={type === 'number' ? '0' : undefined}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className={cls}
      />
    </div>
  );
}

// ── Add / Edit Modal ──────────────────────────────────────────────────────────

function TierModal({ tier, onSave, onDelete, onClose, saving }) {
  const isNew = !tier._rowNum;

  const [form, setForm] = useState({
    Category:      tier.Category      || CATEGORIES[0],
    Variant:       tier.Variant       || '',
    BasePrice:     tier.BasePrice     != null ? String(tier.BasePrice)     : '',
    ExtraChar:     tier.ExtraChar     != null ? String(tier.ExtraChar)     : '',
    BgSimple:      tier.BgSimple      != null ? String(tier.BgSimple)      : '',
    BgComplex:     tier.BgComplex     != null ? String(tier.BgComplex)     : '',
    RushPct:       tier.RushPct       != null ? String(tier.RushPct)       : '',
    CommercialPct: tier.CommercialPct != null ? String(tier.CommercialPct) : '',
    TimeHours:     tier.TimeHours     != null ? String(tier.TimeHours)     : '',
    Notes:         tier.Notes         || '',
    Active:        tier.Active !== 'FALSE' && tier.Active !== false,
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function handleSubmit(e) {
    e.preventDefault();
    onSave({
      ...tier,
      ...form,
      BasePrice:     parseFloat(form.BasePrice)     || 0,
      ExtraChar:     parseFloat(form.ExtraChar)     || 0,
      BgSimple:      parseFloat(form.BgSimple)      || 0,
      BgComplex:     parseFloat(form.BgComplex)     || 0,
      RushPct:       parseFloat(form.RushPct)       || 0,
      CommercialPct: parseFloat(form.CommercialPct) || 0,
      TimeHours:     parseFloat(form.TimeHours)     || 0,
      Active:        form.Active,
    });
  }

  function handleDelete() {
    if (window.confirm(`Delete "${form.Category} · ${form.Variant}"? This cannot be undone.`)) {
      onDelete(tier);
    }
  }

  const inputCls = "w-full bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 placeholder-slate-500";

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h2 className="text-white font-bold font-broske text-lg">
            {isNew ? 'Add Tier' : 'Edit Tier'}
          </h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition-colors">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Category + Variant */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-slate-400 text-xs block">Category</label>
              <select
                value={form.Category}
                onChange={e => set('Category', e.target.value)}
                className={inputCls}
              >
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-slate-400 text-xs block">Variant</label>
              <input
                list="variant-suggestions"
                value={form.Variant}
                onChange={e => set('Variant', e.target.value)}
                placeholder="e.g. Half-Body"
                required
                className={inputCls}
              />
              <datalist id="variant-suggestions">
                {VARIANTS_SUGGEST.map(v => <option key={v} value={v} />)}
              </datalist>
            </div>
          </div>

          {/* Pricing */}
          <div>
            <p className="text-slate-500 text-[10px] uppercase tracking-wider font-broske mb-2">Pricing</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Base Price ($)" value={form.BasePrice} onChange={v => set('BasePrice', v)} type="number" step="0.01" placeholder="0.00" required />
              <Field label="Extra Character ($)" value={form.ExtraChar} onChange={v => set('ExtraChar', v)} type="number" step="0.01" placeholder="0.00" hint="per char" />
              <Field label="Simple Background ($)" value={form.BgSimple} onChange={v => set('BgSimple', v)} type="number" step="0.01" placeholder="0.00" />
              <Field label="Complex Background ($)" value={form.BgComplex} onChange={v => set('BgComplex', v)} type="number" step="0.01" placeholder="0.00" />
            </div>
          </div>

          {/* Surcharges */}
          <div>
            <p className="text-slate-500 text-[10px] uppercase tracking-wider font-broske mb-2">Surcharges</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Rush (%)" value={form.RushPct} onChange={v => set('RushPct', v)} type="number" step="1" placeholder="30" hint="of subtotal" />
              <Field label="Commercial (%)" value={form.CommercialPct} onChange={v => set('CommercialPct', v)} type="number" step="1" placeholder="100" hint="of base" />
            </div>
          </div>

          {/* Meta */}
          <div>
            <p className="text-slate-500 text-[10px] uppercase tracking-wider font-broske mb-2">Details</p>
            <div className="space-y-3">
              <Field label="Estimated Hours" value={form.TimeHours} onChange={v => set('TimeHours', v)} type="number" step="0.5" placeholder="4" />
              <div className="space-y-1">
                <label className="text-slate-400 text-xs block">Notes</label>
                <textarea
                  value={form.Notes}
                  onChange={e => set('Notes', e.target.value)}
                  placeholder="Any notes about this tier…"
                  rows={2}
                  className={inputCls + " resize-none"}
                />
              </div>
              <div className="flex items-center justify-between bg-slate-700/50 rounded-xl px-3 py-2.5">
                <span className="text-slate-300 text-sm">Active (visible in menu)</span>
                <button
                  type="button"
                  onClick={() => set('Active', !form.Active)}
                  className={`w-11 h-6 rounded-full transition-colors relative ${form.Active ? 'bg-green-600' : 'bg-slate-600'}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${form.Active ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="shrink-0 px-5 py-4 border-t border-slate-700 flex gap-3">
          {!isNew && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving}
              className="px-4 py-2.5 rounded-xl bg-slate-700 text-rose-400 hover:bg-rose-900/30 text-sm font-medium transition-colors disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl bg-slate-700 text-slate-300 text-sm font-medium hover:bg-slate-600 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={e => { e.preventDefault(); document.querySelector('#tier-form-submit')?.click(); }}
            form="tier-form"
            disabled={saving || !form.Variant.trim()}
            className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-bold transition-colors"
          >
            {saving ? 'Saving…' : isNew ? 'Add Tier' : 'Save Changes'}
          </button>
        </div>
        {/* Hidden submit trigger */}
        <form id="tier-form" onSubmit={e => { e.preventDefault(); document.getElementById('tier-form-btn')?.click(); }} className="hidden">
          <button id="tier-form-btn" type="submit" />
        </form>
      </div>
    </div>
  );
}

// ── Tier Card ─────────────────────────────────────────────────────────────────

function TierCard({ tier, onEdit }) {
  const base       = parseFloat(tier.BasePrice)     || 0;
  const extraChar  = parseFloat(tier.ExtraChar)     || 0;
  const bgSimple   = parseFloat(tier.BgSimple)      || 0;
  const bgComplex  = parseFloat(tier.BgComplex)     || 0;
  const rushPct    = parseFloat(tier.RushPct)        || 0;
  const commPct    = parseFloat(tier.CommercialPct) || 0;
  const hours      = parseFloat(tier.TimeHours)     || 0;
  const isActive   = tier.Active !== 'FALSE' && tier.Active !== false;

  return (
    <div className={`bg-slate-800 rounded-2xl overflow-hidden border transition-opacity ${isActive ? 'border-slate-700/60' : 'border-slate-700/30 opacity-60'}`}>
      <div className="p-4">
        {/* Title row */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <p className="text-white font-semibold text-base leading-tight truncate">{tier.Variant}</p>
            {hours > 0 && (
              <p className="text-slate-500 text-xs mt-0.5">{hours}h est.</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isActive && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-500 font-medium">inactive</span>
            )}
            <span className="text-white font-bold text-xl font-mono tabular-nums">${fmt(base)}</span>
          </div>
        </div>

        {/* Add-ons */}
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {extraChar > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">
              +${fmt(extraChar)}/char
            </span>
          )}
          {bgSimple > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">
              BG simple +${fmt(bgSimple)}
            </span>
          )}
          {bgComplex > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">
              BG complex +${fmt(bgComplex)}
            </span>
          )}
          {rushPct > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300">
              Rush +{rushPct}%
            </span>
          )}
          {commPct > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300">
              Commercial +{commPct}%
            </span>
          )}
          {extraChar === 0 && bgSimple === 0 && bgComplex === 0 && rushPct === 0 && commPct === 0 && (
            <span className="text-slate-600 text-[11px]">No add-ons</span>
          )}
        </div>

        {tier.Notes && (
          <p className="text-slate-500 text-xs mt-2 italic leading-snug line-clamp-2">{tier.Notes}</p>
        )}
      </div>

      <button
        onClick={() => onEdit(tier)}
        className="w-full py-2.5 border-t border-slate-700/60 text-slate-400 hover:text-white hover:bg-slate-700/50 text-xs font-medium transition-colors"
      >
        Edit
      </button>
    </div>
  );
}

// ── Comparison Grid ───────────────────────────────────────────────────────────

function ComparisonGrid({ tiers, onEdit }) {
  // Collect all unique variants (rows) and categories present in data (cols)
  const activeTiers = tiers.filter(t => t.Active !== 'FALSE' && t.Active !== false);

  const presentCats = useMemo(() => {
    const seen = new Set();
    activeTiers.forEach(t => seen.add(t.Category));
    return CATEGORIES.filter(c => seen.has(c));
  }, [activeTiers]);

  const variants = useMemo(() => {
    const order = ['Icon/Headshot', 'Bust', 'Half-Body', 'Full Body', 'Simple', 'Complex', 'Chibi', 'Expression Sheet', 'Turnaround', 'Walk Cycle', 'Short Loop', 'Multi-character'];
    const seen = new Set();
    const result = [];
    // First: sorted by known order
    order.forEach(v => {
      if (activeTiers.some(t => t.Variant === v)) {
        seen.add(v);
        result.push(v);
      }
    });
    // Then: any remaining
    activeTiers.forEach(t => {
      if (!seen.has(t.Variant)) {
        seen.add(t.Variant);
        result.push(t.Variant);
      }
    });
    return result;
  }, [activeTiers]);

  if (activeTiers.length === 0) {
    return (
      <div className="bg-slate-900 rounded-2xl p-8 text-center">
        <p className="text-slate-500 text-sm">No active tiers to compare</p>
      </div>
    );
  }

  // Build lookup: category → variant → tier
  const lookup = {};
  activeTiers.forEach(t => {
    if (!lookup[t.Category]) lookup[t.Category] = {};
    lookup[t.Category][t.Variant] = t;
  });

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="min-w-full text-xs">
        <thead>
          <tr>
            <th className="text-left text-slate-500 font-medium py-2 pr-3 whitespace-nowrap w-28">Variant</th>
            {presentCats.map(cat => (
              <th key={cat} className="text-center py-2 px-2 whitespace-nowrap min-w-[90px]">
                <div className="flex flex-col items-center gap-1">
                  <span className={`w-2 h-2 rounded-full ${catDotClass(cat)}`} />
                  <span className="text-slate-400 font-medium leading-tight">{cat}</span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {variants.map(variant => (
            <tr key={variant} className="hover:bg-slate-800/40 transition-colors">
              <td className="py-2.5 pr-3 text-slate-300 font-medium whitespace-nowrap">{variant}</td>
              {presentCats.map(cat => {
                const t = lookup[cat]?.[variant];
                return (
                  <td key={cat} className="py-2.5 px-2 text-center">
                    {t ? (
                      <button
                        onClick={() => onEdit(t)}
                        className="text-white font-bold font-mono tabular-nums hover:text-green-400 transition-colors"
                      >
                        ${fmt(t.BasePrice)}
                      </button>
                    ) : (
                      <span className="text-slate-700">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Price Calculator ──────────────────────────────────────────────────────────

function PriceCalculator({ tiers }) {
  const [selCat,     setSelCat]     = useState('');
  const [selVariant, setSelVariant] = useState('');
  const [extraChars, setExtraChars] = useState(0);
  const [bg,         setBg]         = useState('none');   // 'none' | 'simple' | 'complex'
  const [rush,       setRush]       = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [copied,     setCopied]     = useState(false);

  const activeTiers = useMemo(() => tiers.filter(t => t.Active !== 'FALSE' && t.Active !== false), [tiers]);

  // Derive available cats and variants from active tiers
  const availableCats = useMemo(() => {
    const seen = new Set(activeTiers.map(t => t.Category));
    return CATEGORIES.filter(c => seen.has(c));
  }, [activeTiers]);

  const availableVariants = useMemo(() => {
    if (!selCat) return [];
    const seen = new Set();
    return activeTiers.filter(t => t.Category === selCat).map(t => {
      if (seen.has(t.Variant)) return null;
      seen.add(t.Variant);
      return t.Variant;
    }).filter(Boolean);
  }, [activeTiers, selCat]);

  // Auto-select first variant when category changes
  useEffect(() => {
    if (availableVariants.length > 0) {
      setSelVariant(availableVariants[0]);
    } else {
      setSelVariant('');
    }
  }, [selCat, availableVariants]);

  // Auto-select first category on load
  useEffect(() => {
    if (!selCat && availableCats.length > 0) {
      setSelCat(availableCats[0]);
    }
  }, [availableCats, selCat]);

  const selectedTier = useMemo(() => {
    if (!selCat || !selVariant) return null;
    return activeTiers.find(t => t.Category === selCat && t.Variant === selVariant) || null;
  }, [activeTiers, selCat, selVariant]);

  const breakdown = useMemo(() => {
    if (!selectedTier) return null;
    return calcPrice(selectedTier, { extraChars, bg, rush, commercial });
  }, [selectedTier, extraChars, bg, rush, commercial]);

  function copyTotal() {
    if (!breakdown) return;
    navigator.clipboard.writeText(`$${fmt(breakdown.total)}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  const bgOptions = [
    { value: 'none',    label: 'None' },
    { value: 'simple',  label: 'Simple' },
    { value: 'complex', label: 'Complex' },
  ];

  return (
    <div className="bg-slate-900 rounded-2xl overflow-hidden border border-slate-700/60">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-white font-bold font-broske">Price Calculator</h2>
        {breakdown && (
          <button
            onClick={copyTotal}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white transition-colors font-medium"
          >
            {copied ? '✓ Copied!' : 'Copy price'}
          </button>
        )}
      </div>

      <div className="p-4 space-y-4">
        {/* Selectors */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-slate-400 text-xs block">Category</label>
            <select
              value={selCat}
              onChange={e => setSelCat(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
            >
              {availableCats.length === 0 && <option value="">No tiers yet</option>}
              {availableCats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-slate-400 text-xs block">Variant</label>
            <select
              value={selVariant}
              onChange={e => setSelVariant(e.target.value)}
              disabled={availableVariants.length === 0}
              className="w-full bg-slate-700 text-white rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
            >
              {availableVariants.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>

        {/* Options */}
        <div className="grid grid-cols-1 gap-3">
          {/* Extra characters */}
          <div className="flex items-center justify-between bg-slate-800 rounded-xl px-4 py-2.5">
            <div>
              <p className="text-slate-300 text-sm font-medium">Extra Characters</p>
              {selectedTier && parseFloat(selectedTier.ExtraChar) > 0 && (
                <p className="text-slate-500 text-[11px]">${fmt(selectedTier.ExtraChar)} each</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setExtraChars(c => Math.max(0, c - 1))}
                className="w-8 h-8 rounded-lg bg-slate-700 text-white hover:bg-slate-600 flex items-center justify-center text-lg font-bold transition-colors"
              >−</button>
              <span className="text-white font-bold font-mono tabular-nums w-5 text-center">{extraChars}</span>
              <button
                onClick={() => setExtraChars(c => Math.min(5, c + 1))}
                className="w-8 h-8 rounded-lg bg-slate-700 text-white hover:bg-slate-600 flex items-center justify-center text-lg font-bold transition-colors"
              >+</button>
            </div>
          </div>

          {/* Background */}
          <div className="bg-slate-800 rounded-xl px-4 py-2.5 space-y-2">
            <p className="text-slate-300 text-sm font-medium">Background</p>
            <div className="flex gap-2">
              {bgOptions.map(opt => {
                const active = bg === opt.value;
                const price  = opt.value === 'simple'
                  ? parseFloat(selectedTier?.BgSimple)  || 0
                  : opt.value === 'complex'
                    ? parseFloat(selectedTier?.BgComplex) || 0
                    : null;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setBg(opt.value)}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${active ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-white'}`}
                  >
                    <span>{opt.label}</span>
                    {price != null && price > 0 && (
                      <span className={`block text-[10px] mt-0.5 ${active ? 'text-green-200' : 'text-slate-500'}`}>
                        +${fmt(price)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Toggles */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'Rush',          sub: selectedTier ? `+${selectedTier.RushPct || 0}% of subtotal` : '',    checked: rush,       set: setRush },
              { label: 'Commercial Use', sub: selectedTier ? `+${selectedTier.CommercialPct || 0}% of base`  : '', checked: commercial, set: setCommercial },
            ].map(({ label, sub, checked, set: toggle }) => (
              <button
                key={label}
                onClick={() => toggle(v => !v)}
                className={`flex flex-col items-start px-3 py-2.5 rounded-xl border text-left transition-colors ${checked ? 'bg-amber-900/20 border-amber-700/40' : 'bg-slate-800 border-slate-700/60'}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-4 h-4 rounded border-2 flex items-center justify-center text-[10px] font-bold transition-colors shrink-0 ${checked ? 'bg-amber-500 border-amber-500 text-white' : 'border-slate-600'}`}>
                    {checked ? '✓' : ''}
                  </span>
                  <span className={`text-sm font-medium ${checked ? 'text-amber-300' : 'text-slate-300'}`}>{label}</span>
                </div>
                {sub && <span className="text-slate-500 text-[10px] mt-0.5 ml-6">{sub}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Breakdown */}
        {breakdown ? (
          <div className="bg-slate-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 space-y-1.5 text-sm font-mono tabular-nums">
              {/* Base */}
              <div className="flex justify-between text-slate-300">
                <span className="font-ztnature">
                  Base
                  {selectedTier && (
                    <span className="text-slate-500 ml-1 font-mono text-xs">({selectedTier.Category} · {selectedTier.Variant})</span>
                  )}
                </span>
                <span className="text-white font-bold">${fmt(breakdown.base)}</span>
              </div>

              {/* Extra chars */}
              {breakdown.ecCost > 0 && (
                <div className="flex justify-between text-slate-300">
                  <span className="font-ztnature">+ Extra Characters (×{extraChars})</span>
                  <span className="text-white">
                    +${fmt(breakdown.ecCost)}
                    <span className="text-slate-500 text-xs ml-1">({extraChars} × ${fmt(selectedTier.ExtraChar)})</span>
                  </span>
                </div>
              )}

              {/* Background */}
              {breakdown.bgCost > 0 && (
                <div className="flex justify-between text-slate-300">
                  <span className="font-ztnature">+ {bg === 'simple' ? 'Simple' : 'Complex'} Background</span>
                  <span className="text-white">+${fmt(breakdown.bgCost)}</span>
                </div>
              )}

              {/* Subtotal divider */}
              <div className="border-t border-slate-600/60 pt-1.5">
                <div className="flex justify-between text-slate-200 font-bold">
                  <span className="font-ztnature">Subtotal</span>
                  <span>${fmt(breakdown.subtotal)}</span>
                </div>
              </div>

              {/* Rush */}
              {breakdown.rushAmt > 0 && (
                <div className="flex justify-between text-amber-300">
                  <span className="font-ztnature">+ Rush ({selectedTier.RushPct}%)</span>
                  <span>
                    +${fmt(breakdown.rushAmt)}
                    <span className="text-amber-500/70 text-xs ml-1">({selectedTier.RushPct}% of ${fmt(breakdown.subtotal)})</span>
                  </span>
                </div>
              )}

              {/* Commercial */}
              {breakdown.commercialAmt > 0 && (
                <div className="flex justify-between text-blue-300">
                  <span className="font-ztnature">+ Commercial ({selectedTier.CommercialPct}% of base)</span>
                  <span>
                    +${fmt(breakdown.commercialAmt)}
                    <span className="text-blue-500/70 text-xs ml-1">({selectedTier.CommercialPct}% of ${fmt(breakdown.base)})</span>
                  </span>
                </div>
              )}

              {/* Total divider */}
              <div className="border-t-2 border-slate-500/60 pt-2 mt-1">
                <div className="flex justify-between items-center">
                  <span className="text-white font-bold text-base font-ztnature font-broske">TOTAL</span>
                  <span className="text-green-400 font-bold text-2xl">${fmt(breakdown.total)}</span>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-700">
              <button
                onClick={copyTotal}
                className="w-full py-2.5 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
              >
                {copied ? '✓ Copied to clipboard!' : `Copy $${fmt(breakdown.total)}`}
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-slate-800 rounded-2xl p-6 text-center">
            <p className="text-slate-500 text-sm">Select a category and variant to see pricing</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CommissionPrices({ token }) {
  const [tiers,    setTiers]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [editing,  setEditing]  = useState(null);   // tier object or {} for new
  const [selCat,   setSelCat]   = useState('All');
  const [viewMode, setViewMode] = useState('cards'); // 'cards' | 'grid'

  // ── Data loading ──────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureSheetTab(token, SHEET);
      const rows = await readRange(token, `${SHEET}!A:L`, 'UNFORMATTED_VALUE');

      // Write headers if sheet is empty
      if (!rows.length || !rows[0]?.length) {
        await batchUpdateCells(token, HEADERS.map((h, i) => ({
          range: `${SHEET}!${String.fromCharCode(65 + i)}1`,
          value: h,
        })));
        setTiers([]);
        return;
      }

      const [headerRow, ...dataRows] = rows;

      // Ensure the first row is actually our header row (not data)
      const isHeader = headerRow[0] === 'ID' || headerRow[0] === undefined;
      const actualData = isHeader ? dataRows : rows;

      const parsed = actualData
        .map((row, idx) => {
          const id = row[0];
          if (!id || id === 'ID') return null;
          return {
            ID:            row[0]  || '',
            Category:      row[1]  || '',
            Variant:       row[2]  || '',
            BasePrice:     row[3]  != null ? row[3]  : '',
            ExtraChar:     row[4]  != null ? row[4]  : '',
            BgSimple:      row[5]  != null ? row[5]  : '',
            BgComplex:     row[6]  != null ? row[6]  : '',
            RushPct:       row[7]  != null ? row[7]  : '',
            CommercialPct: row[8]  != null ? row[8]  : '',
            TimeHours:     row[9]  != null ? row[9]  : '',
            Notes:         row[10] || '',
            Active:        row[11] !== false && row[11] !== 'FALSE',
            _rowNum:       idx + 2, // 1-indexed, +1 for header
          };
        })
        .filter(Boolean);

      setTiers(parsed);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  // ── Save handler ──────────────────────────────────────────────────────────

  async function handleSave(tier) {
    setSaving(true);
    try {
      if (tier._rowNum) {
        // Edit existing — update B:L (columns 2–12, row N)
        const r = tier._rowNum;
        await batchUpdateCells(token, [
          { range: `${SHEET}!B${r}`, value: tier.Category      },
          { range: `${SHEET}!C${r}`, value: tier.Variant       },
          { range: `${SHEET}!D${r}`, value: tier.BasePrice     },
          { range: `${SHEET}!E${r}`, value: tier.ExtraChar     },
          { range: `${SHEET}!F${r}`, value: tier.BgSimple      },
          { range: `${SHEET}!G${r}`, value: tier.BgComplex     },
          { range: `${SHEET}!H${r}`, value: tier.RushPct       },
          { range: `${SHEET}!I${r}`, value: tier.CommercialPct },
          { range: `${SHEET}!J${r}`, value: tier.TimeHours     },
          { range: `${SHEET}!K${r}`, value: tier.Notes         },
          { range: `${SHEET}!L${r}`, value: tier.Active ? 'TRUE' : 'FALSE' },
        ]);
      } else {
        // New tier
        await appendRow(token, `${SHEET}!A:L`, [
          uid(),
          tier.Category,
          tier.Variant,
          tier.BasePrice,
          tier.ExtraChar,
          tier.BgSimple,
          tier.BgComplex,
          tier.RushPct,
          tier.CommercialPct,
          tier.TimeHours,
          tier.Notes,
          tier.Active ? 'TRUE' : 'FALSE',
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

  // ── Delete handler ────────────────────────────────────────────────────────

  async function handleDelete(tier) {
    if (!tier._rowNum) return;
    setSaving(true);
    try {
      await clearRow(token, `${SHEET}!A${tier._rowNum}:L${tier._rowNum}`);
      setEditing(null);
      await load();
    } catch (e) {
      alert(`Error deleting: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const filteredTiers = useMemo(() => {
    if (selCat === 'All') return tiers;
    return tiers.filter(t => t.Category === selCat);
  }, [tiers, selCat]);

  // Group filtered tiers by Variant for cards view
  const groupedByVariant = useMemo(() => {
    const map = new Map();
    filteredTiers.forEach(t => {
      if (!map.has(t.Variant)) map.set(t.Variant, []);
      map.get(t.Variant).push(t);
    });
    return map;
  }, [filteredTiers]);

  // Count active tiers per category for filter pills
  const catCounts = useMemo(() => {
    const counts = { All: tiers.length };
    CATEGORIES.forEach(c => { counts[c] = tiers.filter(t => t.Category === c).length; });
    return counts;
  }, [tiers]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <LoadingSpinner />;

  return (
    <div className="pb-24">
      {/* ── Page header ── */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-broske">Commission Prices</h1>
          <p className="text-slate-500 text-xs mt-0.5">Pricing menu · {tiers.length} tier{tiers.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setEditing({})}
          className="bg-green-600 hover:bg-green-500 text-white text-sm font-bold px-4 py-2 rounded-xl transition-colors"
        >
          + Add Tier
        </button>
      </div>

      <div className="px-4 space-y-4">
        {/* ── Error banner ── */}
        {error && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-4 text-sm space-y-2">
            <p className="text-red-400 font-medium">Could not load Commission Prices sheet</p>
            <p className="text-red-500 text-xs">{error}</p>
            <button onClick={load} className="text-green-400 underline text-xs">Retry</button>
          </div>
        )}

        {/* ── Empty state ── */}
        {!error && tiers.length === 0 && (
          <div className="bg-slate-900 rounded-2xl p-10 text-center space-y-3">
            <p className="text-5xl select-none">🎨</p>
            <p className="text-white font-semibold font-broske text-lg">No pricing tiers yet</p>
            <p className="text-slate-500 text-sm leading-relaxed max-w-xs mx-auto">
              Add your commission types — sketches, lineart, full paintings — and their pricing to get started.
            </p>
            <button
              onClick={() => setEditing({})}
              className="mt-2 bg-green-600 hover:bg-green-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-colors"
            >
              + Add First Tier
            </button>
          </div>
        )}

        {tiers.length > 0 && (
          <>
            {/* ── Category filter pills ── */}
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide -mx-1 px-1">
              {['All', ...CATEGORIES].map(cat => {
                const count   = catCounts[cat] || 0;
                const active  = selCat === cat;
                const colCls  = cat === 'All' ? '' : catColorClass(cat);
                return count === 0 && cat !== 'All' ? null : (
                  <button
                    key={cat}
                    onClick={() => setSelCat(cat)}
                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border whitespace-nowrap ${
                      active
                        ? cat === 'All'
                          ? 'bg-white text-slate-900 border-white'
                          : `${colCls} border-current`
                        : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white hover:border-slate-500'
                    }`}
                  >
                    {cat}
                    {count > 0 && <span className="ml-1.5 opacity-60">{count}</span>}
                  </button>
                );
              })}
            </div>

            {/* ── View toggle ── */}
            <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
              {[['cards', 'Cards'], ['grid', 'Grid']].map(([v, lbl]) => (
                <button
                  key={v}
                  onClick={() => setViewMode(v)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${viewMode === v ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-300'}`}
                >
                  {lbl}
                </button>
              ))}
            </div>

            {/* ── Cards view ── */}
            {viewMode === 'cards' && (
              <div className="space-y-5">
                {filteredTiers.length === 0 && (
                  <div className="bg-slate-900 rounded-2xl p-8 text-center">
                    <p className="text-slate-500 text-sm">No tiers in this category</p>
                    <button
                      onClick={() => setEditing({ Category: selCat === 'All' ? CATEGORIES[0] : selCat })}
                      className="mt-3 text-green-400 text-sm hover:text-green-300 underline"
                    >
                      + Add one
                    </button>
                  </div>
                )}

                {/* Group by variant when showing All, or by category within a variant when filtering */}
                {selCat === 'All' ? (
                  // Group by category, then show all tiers
                  CATEGORIES.filter(c => tiers.some(t => t.Category === c)).map(cat => (
                    <div key={cat}>
                      <div className={`flex items-center gap-2 mb-3`}>
                        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${catDotClass(cat)}`} />
                        <h3 className={`text-sm font-bold font-broske ${catColorClass(cat).split(' ')[0]}`}>{cat}</h3>
                        <span className="text-slate-600 text-xs">{tiers.filter(t => t.Category === cat).length} tier{tiers.filter(t => t.Category === cat).length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {tiers.filter(t => t.Category === cat).map(tier => (
                          <TierCard key={tier.ID || tier._rowNum} tier={tier} onEdit={setEditing} />
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  // Single category: show cards in a grid
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {filteredTiers.map(tier => (
                      <TierCard key={tier.ID || tier._rowNum} tier={tier} onEdit={setEditing} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Grid view ── */}
            {viewMode === 'grid' && (
              <div className="bg-slate-900 rounded-2xl p-4">
                <p className="text-slate-500 text-[10px] uppercase tracking-wider font-broske mb-3">
                  Active tiers · base prices only · tap a cell to edit
                </p>
                <ComparisonGrid tiers={tiers} onEdit={setEditing} />
              </div>
            )}

            {/* ── Price Calculator ── */}
            <PriceCalculator tiers={tiers} />
          </>
        )}
      </div>

      {/* ── Modal ── */}
      {editing !== null && (
        <TierModal
          tier={editing}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setEditing(null)}
          saving={saving}
        />
      )}

      {/* ── Global saving overlay (when not in modal) ── */}
      {saving && editing === null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 pointer-events-none">
          <LoadingSpinner />
        </div>
      )}
    </div>
  );
}
