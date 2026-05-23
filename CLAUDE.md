# CLAUDE.md

Notes for future Claude sessions working in this repo. Update as you learn.

## Repo state (2026-05-23)

This repo was a deploy-only artifact (compiled `assets/index-*.js` committed to
`main`, served via gh-pages) for several months. The React source was deleted
at commit **`7cf0e98`** ("Deploy: budget redesign + priority-first allocation +
dark mode fix") on 2026-05-20. Between then and now, 22 commits patched the
**minified bundle directly** to add features. Do **not** continue that pattern
— rebuild from `src/` and run `vite build` to refresh `assets/`.

The branch `claude/youthful-pascal-oDer4` recovered the source from
`7cf0e98~1` and is the current development branch. The recovered source is
the **pre-Business-page** version of the app. Features added in the 22
post-deletion commits are NOT yet ported back into source — they exist only
inside the live minified bundle and would need to be reconstructed.

### Built artifacts

- `assets/index-DN5mwN7-.js` (843 KB) — production bundle that is currently
  deployed. This is the source of truth for "how the app actually behaves
  today" until source reconstruction is complete.
- `assets/index-DXS_KYY9.css` — paired CSS bundle.
- `index.html` — entry; in dev mode points at `/src/main.jsx`, gets rewritten
  by `vite build` to reference fingerprinted assets.

### Build & deploy

```bash
npm install
npm run dev      # http://localhost:5173 (vite dev server)
npm run build    # writes dist/, which is what gets deployed
npm run deploy   # gh-pages -d dist
```

Vite config: `vite.config.js`. Base path `/finance-prog/` (GitHub Pages).

## Bundle anchors (strings to grep when reading the live JS)

Use these to locate code regions inside `assets/index-DN5mwN7-.js` when you
need to reconstruct a feature from the bundle.

### Sheets / data layer
- `Business Products`         — product catalog sheet
- `Business Transactions`     — recorded sales (the broken transactions live here)
- `Allocation Transactions`   — per-account allocation log (also used by ProcessIncome)
- `Allocation Summary`        — derived rollup
- `Income Processed!`         — running monthly processed total

### Business modal (Stickers-style)
- `Sale Price (Formula Start)`, `Edit Formula`, `Allocation Steps`
- `FORMULA START`, `NET REMAINING` (header / footer of the breakdown)
- `Process & Record` (old button label)
- `Amount received`, `Quantity sold` (input toggle)
- `Client Name`
- `Could not load Business Products sheet` (load error path)
- `Business Sales Report — ${RV.find(e=>e.key===c)?.label||c}` (report copy)

### ProcessIncome (homepage flow)
- ``Process $${j.toFixed(2)} as Income →``  — primary button
- `Allocation Mode`, `By Priority` — Priority-First / Proportional / Even toggle
- `Monthly Goal − Processed Income`

### Other late features (only in bundle, not in source)
- Updates / Tasks page (`Updates` sheet)
- Screenshot feedback with Drive upload (`Tab to submit`)
- Home page "Updates & Feedback" shortcut card
- Subscription edit & delete + compact layout
- PIN lock
- Spending donut, monthly bar chart, savings trendline
- Bill Tracker
- Tap-to-mark-done on transactions

## Key invariants (do not break these)

1. **Net Remaining = $0 by design.** Each product formula is configured so all
   dollars are allocated. `Net Remaining` is an audit value, not profit. Never
   surface it as profit, revenue, or any user-visible metric.
2. **Revenue is the amount allocated to the `Revenue` step**, not the gross
   sale and not Net Remaining. The Sales screen's Revenue tile should sum
   the Revenue column of `Business Transactions`.
3. **Profit (on summary tiles) = Revenue** (i.e. what landed in the Revenue
   step after COGS / Overhead / Platform Fees / Future Material were taken
   out). It is *not* gross sale and not gross − allocations of non-Revenue
   steps minus something else.
4. **Process Income is the single source of truth for income allocation.**
   The Business sale modal does sale entry + per-step allocation, then hands
   the Revenue step's value to `<ProcessIncome>` for Priority-First /
   Proportional / Even allocation. Do not duplicate that allocator inside the
   Business page.

## Sheet schemas

Confirmed by reading the live bundle + ProcessIncome.jsx:

```
Allocation Transactions!A:F   →  Date | Type | Amount | Description | Account | Processed
```

Assumed (audit + adjust as you wire to live data):

```
Business Products!A:E         →  Name | Unit Price | Steps JSON | Active | Notes
Business Transactions!A:G     →  Date | Product | Client | Gross | Revenue | Net | Notes
```

`Steps JSON` is a serialized array like:

```json
[
  { "name": "COGS",            "kind": "pctTotal",     "value": 2.8,  "color": "#3b82f6" },
  { "name": "Overhead",        "kind": "pctRemaining", "value": 5.0,  "color": "#64748b" },
  { "name": "Revenue",         "kind": "pctRemaining", "value": 75.8, "color": "#10b981" },
  { "name": "Platform Fees",   "kind": "pctRemaining", "value": 26.4, "color": "#ec4899" },
  { "name": "Future Material", "kind": "pctRemaining", "value": 100,  "color": "#a855f7" }
]
```

`kind` values: `fixed` (dollar amount), `pctRemaining` (% of running remainder),
`pctTotal` (% of formula start). Allocator implementation:
`src/lib/businessAccounts.js` → `computeAllocation()`.

## Allocation-step accounts ("accounts as budgets")

Non-priority allocation step names (anything that isn't `Checking`,
`Outside Payment`, `Cash`, `Savings`, `Business Tax`, `Subscription`, or
`Revenue`) are surfaced on the Business page as **spendable accounts**.

- **Balance** = `Σ Amount where Account = <step name>` in `Allocation Transactions`.
- **Contribution** = positive row written by recording a sale.
- **Drawdown** = negative row written by `spendFromAccount` (also writes a
  matching expense row to `Business Transactions` so the main ledger sees it).
- **TODO**: `lib/sheets.js` does not yet have a real row-delete (would need
  `batchUpdate` with `deleteDimension`). The bulk-delete affordance on the
  Transactions panel surfaces this but currently `alert()`s. Add `deleteRows`
  to `lib/sheets.js` next.

## Files touched by the recent Business work

- `src/pages/Business.jsx` — page shell, sale modal, account drawdown modal, transactions panel
- `src/lib/businessAccounts.js` — sheet I/O + `computeAllocation` allocator + account discovery
- `src/components/ProcessIncome.jsx` — added `initialIncome` / `initialSource` props so Business stage 2 can hand off
- `src/App.jsx` — `/business` route
- `src/components/Nav.jsx` — Business tab

## What's missing vs the live deployed app

Everything below exists in the deployed minified bundle but not yet in source:

- [ ] Updates / Tasks in-app page
- [ ] Screenshot feedback to Drive
- [ ] Home shortcut card for Updates
- [ ] Subscription edit / delete + compact layout
- [ ] PIN lock
- [ ] Tap-to-mark-done on transactions
- [ ] Spending category donut chart
- [ ] Monthly bar chart
- [ ] Net savings trendline
- [ ] Bill Tracker
- [ ] Side-by-side priorities on Budget page
- [ ] Monthly statement PDF
- [ ] Allocation toggle on Statement
- [ ] Priority-First / Even modes in ProcessIncome (recovered version is Proportional-only)
- [ ] Budget vs Actual by Priority

Reconstructing each is a separate task. Use bundle anchors above to locate
the relevant code regions in `assets/index-DN5mwN7-.js`.
