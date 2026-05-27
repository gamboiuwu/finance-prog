# Finance Tracker — Claude Internal Reference

## Stack
- **Framework**: React 18 + Vite 8 + Tailwind CSS 4
- **Charts**: Recharts
- **Deploy**: `npm run deploy` → gh-pages branch → gamboiuwu.github.io/finance-prog
- **Router**: HashRouter (required for gh-pages static hosting)
- **No backend** — all data lives in the user's private Google Sheet

## Auth & Security
- Google OAuth2 popup → access token stored in `localStorage` (expires ~1 hr)
- PIN hashed via SubtleCrypto in `src/lib/pin.js`; idle timeout re-locks session
- All API calls: browser → Google Sheets API v4 directly (no proxy server)
- **Never commit** the spreadsheet ID to public files — it is in `src/config.js` which is gitignored-safe since no financial data is in the ID itself, but the sheet is private-only-accessible via OAuth

## Google Sheets Layout
| Sheet tab | Purpose |
|---|---|
| Monthly Summary | Income/spent/goal per month (rows = months, cols = metrics) |
| Monthly Expenses | Budget categories: Type, Account, Priority, Monthly Allowance ($), etc. |
| Allocation Transactions | Every deposit: Date, Type, Amount, Desc, Account, Done (bool) |
| Business Products | Product cards: ID, Name, StartPrice, Formula (JSON blocks) |
| Business Transactions | Sales log: Date, Client, Product, Qty, Unit Price, Revenue, Margin%, Allocs(JSON) |
| Business Expenses | Business spending log: Date, Vendor, Amount, Category, Product, Payment, Notes |
| Subscriptions | Subscription items: Name, Cost, Cycle, Start Date, Account |

**Spreadsheet ID**: `1RNhMNI3nM3dZisuP8vo2w6FYnx33Lvnvpe_UnHdGz4o`  
**Google Client ID**: see `src/config.js`

## Key Files
```
src/
  App.jsx               — Auth gate (Google token → PIN → app)
  config.js             — Spreadsheet ID, sheet names, OAuth config
  lib/
    auth.js             — Google OAuth2 token storage/retrieval
    sheets.js           — readRange, appendRow, clearRow, batchUpdateCells, etc.
    pin.js              — PIN hash, verify, failed-attempt lockout
    gasPrice.js         — EIA gas price API fetch
  pages/
    Dashboard.jsx       — Home: income stats, subscriptions, bill calendar, charts (~2000 lines)
    BusinessExpenses.jsx — Product formula builder + Sales tab + COGS tracking (~1600 lines)
    Budget.jsx          — Budget allocation view
    Transactions.jsx    — Transaction log
    Actions.jsx         — Allocation + Business transaction history with delete
    Summary.jsx         — Year summary
    CommissionPrices.jsx — Commission price calculator
    Commissions.jsx     — Commission tracker
    GasPrices.jsx       — Live gas price display
    MonthlyDetail.jsx   — Monthly report detail
    Login.jsx           — Google sign-in screen
  components/
    ProcessIncome.jsx   — Income allocation modal (priority-first or proportional, ~500 lines)
    PinGate.jsx         — PIN creation/verification screen
    Nav.jsx             — Bottom navigation bar
    LoadingSpinner.jsx  — Shared spinner
```

## BusinessExpenses.jsx — Key Concepts
- **Product formula**: array of blocks `{id, category, type ('fixed'|'percent'), value, customName?}`
- `computeFormula(startPrice, blocks)` — waterfall: each block takes from `remaining`
- `computeFormulaProportional(actualRevenue, basePrice, blocks)` — scales fixed amounts by revenue/basePrice ratio
- **Profit = 'Profit' + 'Revenue' allocation categories** — both are summed for the Profit tile and Process button
- `profitMarginPct(steps, startPrice)` — returns combined (Profit+Revenue)/startPrice %
- `BUILT_IN_CATS` — dropdown options for formula blocks (Revenue now included)
- Sales tab reads `Business Transactions!A:H`; col H is `allocs` JSON `{category: amount}`
- **Expenses 📒 tab** — `ExpensesTab` component; reads/writes `Business Expenses!A:G`
  - Reorder thresholds stored in `localStorage` as `biz_reorder_thresholds` (JSON keyed by product ID)
  - `ThresholdModal` — set COGS threshold per product
  - `ReorderQAModal` — guided Q&A + copy-to-clipboard purchase summary

## ProcessIncome.jsx — Key Concepts
- Reads `Allocation Transactions!A:F` to find already-deposited amounts this month
- `calcDeposits(expenses, income, mode, alreadyByType)` — returns per-category deposit amounts
- Two modes: `priority` (fill P1 → P2 → P3) and `proportional` (split by share of remaining need)
- Surplus: income beyond all goals distributed by user-configured weight buckets

## Budget.jsx — Key Concepts (updated 2026-05-25)
- 4 tabs: **Budget Plan** | **By Category** | **All Entries** | **Trends**
- **Budget Plan** — priority-grouped edit view with donut + bar charts
- **By Category** — `CategoryView`: reads Allocation Transactions, sums by Type for current month, groups by Expense category (Essentials/Stability/Discretionary/Subscription). Savings collapsible.
- **All Entries** — `AllEntriesView`: flat sorted list of raw allocation rows for current month
- **Trends** — `TrendsView`: loads 3-month window of allocations; shows summary header (total per month + delta) and per-category cards with `SparkBars` (3-bar CSS visualization), delta arrows, over-budget flags
  - `allAllocTx` state: transactions from windowStart (now.getMonth()-2, day 1) to present
  - `allocTx` state: current-month-only transactions (used by By Category + All Entries)
- `parseSheetDate(val)` duplicated in Budget.jsx + ProcessIncome.jsx — future: extract to `lib/dateUtils.js`
- Allocation Transactions col B ("Type") matches Monthly Expenses "Type" (item name, e.g. "Rent")

## Dashboard.jsx — Key Concepts
- Loads on mount: Monthly Summary, Monthly Expenses, Report Links, Gas Price, Subscriptions
- Subscriptions stored in `Subscriptions!A:E`, cycle types: monthly/annual/weekly/biweekly
- Bill Calendar: shows 30-day window with subscription due-date dots
- Month Close: stores `closed_{month}_{year}` in localStorage (soft close only)
- Statement: `printStatement()` generates a printable HTML page via `window.open()`

## Task Tracking
Maintained in Google Drive doc "Finance Tracker – Updates & Task Plans" (auto-updated by Claude).
Original user task list: Google Doc ID `1Lxeo2bhqoeLjFHPGf5SkvIMeWizC8O1t4wtrUTzptqo`
**Current task doc ID**: `165B3Kot8U8sBwezfwtE54gBzp5UYBd3K07Y7ir9KijU` (updated 2026-05-25)

### Task Status
| # | Task | Status |
|---|---|---|
| 1 | Subscriptions — add/edit/delete | ✅ COMPLETED + VERIFIED |
| 2 | Category view shows all allocated amounts (3-tab Budget) | ✅ COMPLETED + VERIFIED |
| 3 | Revenue counts as Profit in Sales card | ✅ COMPLETED + VERIFIED |
| 4 | Business Expenses full accounting page (Expenses 📒 tab) | ✅ COMPLETED + VERIFIED |
| 5 | Month-over-Month Spending Trends (4th Budget tab) | ✅ COMPLETED (2026-05-25) |
| 6 | Budget Over-Budget Alerts & Nav Badge | ⏳ Plan written, awaiting Execute Y/N |
| 7 | Transaction Log: Search, Filter & Running Balance | ⏳ Plan written, awaiting Execute Y/N |
| 8 | Quick Income Templates (saved amounts) | ⏳ Plan written 2026-05-26, awaiting Execute Y/N |
| 9 | Savings Goals with Milestone Tracking | ⏳ Plan written 2026-05-26, awaiting Execute Y/N |
| 10 | Dashboard Financial Health Score | ⏳ Plan written 2026-05-26, awaiting Execute Y/N |

### Task Plans Summary (for quick reference)
- **Task 5**: 4th "Trends" tab in Budget page — reads Allocation Transactions for last 3 months, shows per-category sparklines and delta arrows. Q: Show all categories or only active ones? 3-month or 6-month window? Over-budget highlight? Income trend line?
- **Task 6**: Nav badge (red dot) on Budget nav item + Dashboard alert banner when over-budget. Q: Banner every open or once/day? All zero-allocated or P1 only? Vibration? Include Savings in alerts?
- **Task 7**: Search + filter chips + totals footer on Transactions page. Q: Default all-time or current month? Delete from here? Amount search? CSV export?
- **Task 8**: Income template chips in ProcessIncome modal — tap to pre-fill amount. Stored in localStorage. Q: How many templates? Auto-advance or manual? Per-template default account? Sort by recency?
- **Task 9**: Savings Goals sheet tab + Dashboard progress cards with milestone markers. Q: All-time or start-date tracking? Dashboard inline or separate page? Require linked category? Auto-archive?
- **Task 10**: Financial Health Score (0–100) arc gauge on Dashboard. Weighted: budget adherence/income processed/savings rate/bills covered/spending trend. Q: Position on Dashboard? Business income included? Target score alerts? Number vs letter grade?

## Git Workflow
1. Source changes → feature branch (e.g. `claude/zealous-euler-p8sWK`) based on `main`
2. PR: feature → `main`
3. Deploy: `npm run deploy` on `main` → builds dist/ → pushes to `gh-pages`

## Security Checklist
- [ ] No API keys or tokens in source code or commit history
- [ ] No financial data (amounts, sheet contents) in GitHub
- [ ] All user data stays in their private Google Sheet
- [ ] Google OAuth scope is `spreadsheets` only (not drive, gmail, etc.)
- [ ] PIN prevents unauthorized access if device is shared
