import { useEffect, useMemo, useState } from 'react';
import {
  loadProducts,
  loadAllAllocations,
  loadBusinessTransactions,
  computeAllocation,
  discoverAccounts,
  balanceForAccount,
  recordSaleAllocations,
  recordBusinessTransaction,
  spendFromAccount,
} from '../lib/businessAccounts';
import ProcessIncome from '../components/ProcessIncome';
import LoadingSpinner from '../components/LoadingSpinner';
import { readRange } from '../lib/sheets';

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Page shell: account tiles + recent sales + Stickers-style sale modal entry.
// ──────────────────────────────────────────────────────────────────────────
export default function Business({ token }) {
  const [products, setProducts] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [txns, setTxns] = useState([]);
  const [budgetRows, setBudgetRows] = useState([]); // for ProcessIncome handoff
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const [saleProduct, setSaleProduct] = useState(null);
  const [openAccount, setOpenAccount] = useState(null);

  async function refresh() {
    setLoading(true); setErr(null);
    try {
      const [p, a, t, b] = await Promise.all([
        loadProducts(token),
        loadAllAllocations(token),
        loadBusinessTransactions(token),
        // Budget rows feed ProcessIncome. Range mirrors what Dashboard reads.
        readRange(token, 'Budget!A1:Z').then(rows => {
          if (!rows.length) return [];
          const [headers, ...data] = rows;
          return data.map(r => headers.reduce((o, k, i) => (o[k] = r[i] ?? null, o), {}));
        }).catch(() => []),
      ]);
      setProducts(p); setAllocations(a); setTxns(t); setBudgetRows(b);
    } catch (e) { setErr(e.message); }
    finally   { setLoading(false); }
  }
  useEffect(() => { refresh(); }, [token]);

  const accounts = useMemo(() => discoverAccounts(products), [products]);
  const accountsWithBal = useMemo(
    () => accounts.map(a => ({ ...a, balance: balanceForAccount(allocations, a.name) })),
    [accounts, allocations],
  );

  if (loading) return <div className="p-8"><LoadingSpinner /></div>;

  return (
    <div className="p-4 md:p-6 lg:p-8 space-y-6 pb-24">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-white text-2xl font-bold">Business</h1>
          <p className="text-slate-400 text-sm">Sales, allocation accounts, and per-account spending.</p>
        </div>
        <button
          onClick={refresh}
          className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
        >Refresh</button>
      </header>

      {err && <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-300 text-sm">{err}</div>}

      <AccountGrid accounts={accountsWithBal} onOpen={setOpenAccount} />

      <ProductGrid products={products} onSelect={setSaleProduct} />

      <TransactionsPanel
        token={token}
        rows={txns}
        onChanged={refresh}
      />

      {saleProduct && (
        <SaleModal
          token={token}
          product={saleProduct}
          budgetRows={budgetRows}
          onClose={() => setSaleProduct(null)}
          onComplete={() => { setSaleProduct(null); refresh(); }}
        />
      )}

      {openAccount && (
        <AccountModal
          token={token}
          accountName={openAccount.name}
          balance={openAccount.balance}
          history={allocations.filter(a => a.account === openAccount.name)}
          onClose={() => setOpenAccount(null)}
          onSpent={() => { setOpenAccount(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
function AccountGrid({ accounts, onOpen }) {
  if (!accounts.length) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-slate-500 text-sm">
        No allocation accounts yet. Add allocation steps (COGS, Overhead, …) to a product to create them.
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-slate-300 text-sm uppercase tracking-wider">Accounts</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        {accounts.map(a => (
          <button
            key={a.name}
            onClick={() => onOpen(a)}
            className="text-left rounded-2xl border border-slate-800 bg-slate-900 hover:bg-slate-800/70 hover:border-slate-700 p-4 transition-colors"
            style={{ borderTopColor: a.color || undefined, borderTopWidth: a.color ? 3 : 1 }}
          >
            <p className="text-slate-400 text-xs uppercase tracking-wider">{a.name}</p>
            <p className={`mt-2 text-xl font-bold ${a.balance < 0 ? 'text-red-400' : 'text-white'}`}>
              {fmt(a.balance)}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">Tap to spend</p>
          </button>
        ))}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
function ProductGrid({ products, onSelect }) {
  if (!products.length) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-slate-500 text-sm">
        No products yet. Add rows to <code className="text-slate-400">Business Products</code> to get started.
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-slate-300 text-sm uppercase tracking-wider">Products</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {products.filter(p => p.active).map(p => (
          <button
            key={p.name}
            onClick={() => onSelect(p)}
            className="text-left rounded-2xl border border-slate-800 bg-slate-900 hover:bg-slate-800/70 hover:border-emerald-700 p-4 transition-colors"
          >
            <p className="text-white font-semibold">{p.name}</p>
            <p className="mt-1 text-slate-400 text-xs">Unit price: {fmt(p.unitPrice)}</p>
            <p className="mt-2 text-emerald-400 text-xs">Log a sale →</p>
          </button>
        ))}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sale modal: stage 1 = enter amount + see per-step breakdown.
// stage 2 = hand revenue to ProcessIncome for priority allocation.
function SaleModal({ token, product, budgetRows, onClose, onComplete }) {
  const [client, setClient] = useState('');
  const [amount, setAmount] = useState(product.unitPrice || 0);
  const [stage, setStage] = useState('entry'); // 'entry' | 'allocate'
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState(null);
  const [revenueForStage2, setRevenueForStage2] = useState(0);

  const alloc = useMemo(() => computeAllocation(product, +amount || 0), [product, amount]);
  const revenueStep = alloc.steps.find(s => s.name === 'Revenue');

  async function handleContinue() {
    if (!amount || !token) return;
    setRecording(true); setErr(null);
    try {
      await recordBusinessTransaction(token, { product, client, gross: +amount, allocation: alloc });
      await recordSaleAllocations(token, { product, client, allocation: alloc });
      setRevenueForStage2(revenueStep?.amount || 0);
      setStage('allocate');
    } catch (e) { setErr(e.message); }
    finally   { setRecording(false); }
  }

  if (stage === 'allocate') {
    return (
      <ProcessIncome
        expenses={budgetRows}
        token={token}
        alreadyProcessed={0}
        onClose={onComplete}
        initialIncome={revenueForStage2}
        initialSource={`${product.name}${client ? ' — ' + client : ''}`}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-slate-900 w-full lg:max-w-4xl sm:max-w-lg rounded-t-3xl sm:rounded-2xl flex flex-col max-h-[94vh]">
        <header className="flex items-center justify-between p-5 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-white font-bold text-lg">{product.name}</h2>
            <p className="text-slate-400 text-xs mt-0.5">Unit price: {fmt(product.unitPrice)}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-200 grid place-items-center">✕</button>
        </header>

        <div className="grid lg:grid-cols-[2fr_1fr] gap-0 overflow-y-auto">
          {/* Left: entry + breakdown */}
          <div className="p-5 space-y-5">
            <div>
              <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Client (optional)</label>
              <input
                value={client}
                onChange={e => setClient(e.target.value)}
                placeholder="e.g. Jane Doe, @username, Etsy order #1234"
                className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600"
              />
            </div>
            <div>
              <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Amount received</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl font-bold">$</span>
                <input
                  type="number" step="0.01" min="0"
                  value={amount}
                  autoFocus
                  onChange={e => setAmount(e.target.value)}
                  className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3.5 outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            <div className="rounded-2xl border border-slate-700 overflow-hidden">
              <div className="flex justify-between items-center bg-slate-800/60 px-4 py-2.5">
                <span className="text-slate-400 text-xs uppercase tracking-wider">Formula Start</span>
                <span className="text-white text-lg font-bold">{fmt(+amount || 0)}</span>
              </div>
              {/* Segmented bar across the top of the breakdown */}
              <div className="flex h-2 bg-slate-800">
                {alloc.steps.map((s, i) => (
                  <div key={i} title={`${s.name}: ${fmt(s.amount)}`}
                    style={{ width: `${((+amount || 0) ? (s.amount / +amount) : 0) * 100}%`, background: s.color || '#475569' }} />
                ))}
              </div>
              <ul className="divide-y divide-slate-800">
                {alloc.steps.map((s, i) => {
                  const pct = (+amount || 0) ? (s.amount / +amount) * 100 : 0;
                  return (
                    <li key={i} className="grid grid-cols-[1.25rem_1fr_8rem_5rem] items-center px-4 py-2.5 gap-3">
                      <span className="text-slate-500 text-xs tabular-nums text-right">{i + 1}</span>
                      <div>
                        <span className="font-medium" style={{ color: s.color || '#cbd5e1' }}>{s.name}</span>
                        <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                          <div style={{ width: `${pct}%`, background: s.color || '#64748b' }} className="h-1" />
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-white font-semibold tabular-nums">→ {fmt(s.amount)}</p>
                        <p className="text-[10px] text-slate-500 tabular-nums">{pct.toFixed(1)}% of start</p>
                      </div>
                      <p className="text-right text-[11px] text-slate-500 tabular-nums">{fmt(Math.max(0, (+amount || 0) - alloc.steps.slice(0, i + 1).reduce((a, b) => a + b.amount, 0)))} left</p>
                    </li>
                  );
                })}
              </ul>
              <div className="flex justify-between items-center bg-slate-800/60 px-4 py-2.5 border-t border-slate-700">
                <span className="text-emerald-400 text-xs uppercase tracking-wider">Net Remaining</span>
                <span className={`text-lg font-bold ${alloc.netRemaining > 0.005 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {fmt(alloc.netRemaining)}
                </span>
              </div>
            </div>

            {err && <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-300 text-sm">{err}</div>}
          </div>

          {/* Right (desktop only): step balance hints */}
          <aside className="hidden lg:block border-l border-slate-800 p-5 bg-slate-950/40">
            <h3 className="text-slate-300 text-xs uppercase tracking-wider mb-3">Where it lands</h3>
            <ul className="space-y-2 text-sm">
              {alloc.steps.map((s, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="text-slate-400 truncate">{s.name}</span>
                  <span className="text-white tabular-nums">{fmt(s.amount)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[11px] text-slate-500 leading-relaxed">
              Non-Revenue steps post immediately to their account.
              The <strong className="text-emerald-400">Revenue</strong> portion ({fmt(revenueStep?.amount || 0)}) flows
              into the Process Income screen next, where you pick Priority-First / Proportional / Even.
            </p>
          </aside>
        </div>

        <footer className="flex gap-3 p-4 border-t border-slate-700 shrink-0">
          <button onClick={onClose} className="px-4 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium">Cancel</button>
          <button
            disabled={!amount || recording || alloc.netRemaining > 0.005}
            onClick={handleContinue}
            className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm"
          >
            {recording ? 'Recording…' : `Continue to Allocation (${fmt(revenueStep?.amount || 0)}) →`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
function AccountModal({ token, accountName, balance, history, onClose, onSpent }) {
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [desc, setDesc] = useState('');
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState(null);

  const amt = parseFloat(amount) || 0;
  const wouldOverdraw = amt > balance;

  async function handleSpend() {
    if (!amt) return;
    setWorking(true); setErr(null);
    try {
      await spendFromAccount(token, { accountName, amount: amt, vendor, description: desc });
      onSpent();
    } catch (e) { setErr(e.message); }
    finally   { setWorking(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-slate-900 w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl">
        <header className="flex justify-between items-center p-5 border-b border-slate-700">
          <div>
            <h2 className="text-white font-bold text-lg">{accountName}</h2>
            <p className={`text-2xl font-bold mt-1 ${balance < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmt(balance)}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-200 grid place-items-center">✕</button>
        </header>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Spend amount</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl font-bold">$</span>
              <input
                type="number" step="0.01" min="0"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-slate-800 text-white text-2xl font-bold rounded-xl pl-9 pr-4 py-3 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            {wouldOverdraw && <p className="text-amber-400 text-xs mt-1">Over balance by {fmt(amt - balance)}</p>}
          </div>
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Payee / Vendor</label>
            <input value={vendor} onChange={e => setVendor(e.target.value)} placeholder="e.g. Amazon, Sticker Mule" className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600" />
          </div>
          <div>
            <label className="text-slate-400 text-xs uppercase tracking-wider block mb-1.5">Description</label>
            <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Inventory restock — sticker paper" className="w-full bg-slate-800 text-white rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600" />
          </div>

          <details>
            <summary className="text-slate-400 text-xs cursor-pointer hover:text-slate-200">Recent activity ({history.length})</summary>
            <ul className="mt-2 max-h-44 overflow-y-auto divide-y divide-slate-800 text-sm">
              {history.slice().reverse().slice(0, 30).map((h, i) => (
                <li key={i} className="flex justify-between py-1.5">
                  <span className="text-slate-400 truncate pr-2">{h.date} · {h.description || '—'}</span>
                  <span className={`tabular-nums ${h.amount < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmt(h.amount)}</span>
                </li>
              ))}
            </ul>
          </details>

          {err && <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-300 text-sm">{err}</div>}
        </div>
        <footer className="flex gap-3 p-4 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium">Cancel</button>
          <button onClick={handleSpend} disabled={!amt || working} className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm">
            {working ? 'Recording…' : `Spend ${fmt(amt)} from ${accountName}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Transaction history with multi-select bulk delete (for cleaning up the
// corrupt rows currently in the sheet). Deletion strategy: write a tombstone
// column rather than actually deleting rows, since the Sheets API requires
// batchUpdate for true deletes — TODO when this is wired to live data.
function TransactionsPanel({ rows, onChanged }) {
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('all'); // all | corrupt

  function isCorrupt(r) {
    if (!r.product && !r.client && !r.notes) return true;
    if (!r.gross && !r.revenue && !r.net) return true;
    if (r.product && /^[\d.]+$/.test(r.product)) return true; // numeric leak into product col
    return false;
  }

  const shown = filter === 'corrupt' ? rows.filter(isCorrupt) : rows;
  const allSelected = shown.length > 0 && shown.every(r => selected.has(r.rowIndex));

  function toggle(rowIndex) {
    const next = new Set(selected);
    next.has(rowIndex) ? next.delete(rowIndex) : next.add(rowIndex);
    setSelected(next);
  }

  function selectAllShown() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(shown.map(r => r.rowIndex)));
  }

  function bulkDelete() {
    // TODO: wire to spreadsheets.batchUpdate "deleteDimension" requests.
    // Left as a UI affordance for now; the data layer needs a deleteRows
    // helper added to lib/sheets.js (batchUpdate with deleteDimension).
    alert(`Bulk delete of ${selected.size} rows is not yet wired to the Sheets API.\nAdd lib/sheets.js deleteRows() then call it here.`);
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-slate-300 text-sm uppercase tracking-wider">Transaction history</h2>
          <p className="text-slate-500 text-xs mt-1">{rows.length} total · {rows.filter(isCorrupt).length} look corrupt</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setFilter('all')}     className={`text-xs px-3 py-1.5 rounded-lg ${filter==='all'    ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400'}`}>All</button>
          <button onClick={() => setFilter('corrupt')} className={`text-xs px-3 py-1.5 rounded-lg ${filter==='corrupt'? 'bg-amber-700 text-white' : 'bg-slate-800 text-slate-400'}`}>Corrupt only</button>
          <button onClick={selectAllShown} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300">{allSelected ? 'Unselect all' : 'Select all'}</button>
          <button onClick={bulkDelete} disabled={!selected.size} className="text-xs px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white">Delete ({selected.size})</button>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-slate-400 text-[11px] uppercase tracking-wider">
            <tr>
              <th className="w-8 px-3 py-2"></th>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">Product</th>
              <th className="text-left px-3 py-2">Client</th>
              <th className="text-right px-3 py-2">Gross</th>
              <th className="text-right px-3 py-2">Revenue</th>
              <th className="text-right px-3 py-2">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {shown.length === 0 && (
              <tr><td colSpan="7" className="text-center text-slate-500 py-6 text-xs">No rows.</td></tr>
            )}
            {shown.map(r => {
              const corrupt = isCorrupt(r);
              return (
                <tr key={r.rowIndex} className={`${corrupt ? 'bg-amber-950/20' : ''}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(r.rowIndex)} onChange={() => toggle(r.rowIndex)} />
                  </td>
                  <td className="px-3 py-2 text-slate-300 tabular-nums">{r.date || <span className="text-slate-600">—</span>}</td>
                  <td className="px-3 py-2 text-white">{r.product || <span className="text-slate-600">—</span>}</td>
                  <td className="px-3 py-2 text-slate-300">{r.client || <span className="text-slate-600">—</span>}</td>
                  <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{fmt(r.gross)}</td>
                  <td className="px-3 py-2 text-right text-emerald-400 tabular-nums">{fmt(r.revenue)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.net < 0 ? 'text-red-400' : 'text-slate-300'}`}>{fmt(r.net)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
