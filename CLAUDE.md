# Finance Tracker — Claude Internal Reference

> **📐 Full system reconciliation lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md)** — every
> money formula, sheet tab, localStorage key, the gas model, and the cross-screen
> "reconciliation hazards" (where the same word means different numbers). Read it before
> touching any financial calculation. Last full audit: 2026-06-02.

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
*(Full column-level detail + which screen reads/writes each tab is in ARCHITECTURE.md §2.)*
| Sheet tab | Purpose |
|---|---|
| Monthly Summary | Income/spent/goal per month (rows = months, cols = metrics) |
| Monthly Expenses | Budget categories: Type, Account, Priority, Expense, Monthly Allowance ($), Actual Spend |
| Allocation Transactions | Every deposit/spend: Date, Type, Amount, Desc, Account, Done (bool) |
| Allocation Summary | label/balance pairs incl. **Gas** row (gas balance on hand) — read by Summary |
| Expense Summary | wide key/value layout (PI, CI, wage, mpg, $/gal, deposits) — read by Summary |
| Subscriptions | Subscription items: Name, Start Date, Cycle, Amount, Notes |
| Inquiries | Commission inquiries: Card Name, Contact, desc, Status, Price Agreed, Paid Amount… |
| Commission Prices | Pricing tiers: ID,Category,Variant,BasePrice,ExtraChar,Bg*,RushPct,CommercialPct,… |
| Business Products | Product cards: ID, Name, StartPrice, Formula (JSON blocks) |
| Business Transactions | Sales log: Date, Client, Product, Qty, Unit Price, Revenue, Margin%, Allocs(JSON), Order(JSON) |
| Business Account Spending | Owner draws + direct bucket spends: Date, Account, Amount, Vendor, Description |
| Business Expenses | Business spending log: Date, Vendor, Amount, Category, Product, Payment, Notes |
| Work Sessions | Time-clock log: Date, Start, Duration, Products, Total Units, Total Profit, $/hr, Notes |
| Plans | Savings/affordability goals (Dragon/Goals): ID,Name,Scope,Target,Saved,Per Month,… |

**Subsystems beyond the budget core** (see ARCHITECTURE.md §3 for formulas):
Business (`BusinessExpenses.jsx`, 6 tabs incl. time clock) · Commissions (`CommissionPrices` +
`Commissions`) · Time Clock (`TimeClockView`, `Work Sessions` sheet) · Dragon AI assistant
(`DragonBot` + `lib/dragon*`, user's own Anthropic key) · Goals (`Goals.jsx` + `Plans` sheet) ·
Orders/shipping (`lib/orders`, `lib/easypost`, EasyPost via CORS proxy).

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
    Budget.jsx          — 4-tab: Budget / Categories / Entries / Trends (Goals pending)
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
- **Unified category model (the source of truth — see the big comment block at top of the file):**
  - `BUILT_IN_CATS` — all formula-block categories (incl. Profit/Revenue/Other)
  - `CAT_COLORS` + `catColor(name)` — ONE colour lookup for every tab (replaced the old `EXP_CAT_COLORS`)
  - `EXP_CATEGORIES = BUILT_IN_CATS minus Profit/Revenue` (profit isn't a spendable cost)
- **Per-category ledger** (shared by Accounts + Insights): `balance(C) = earned(C) − spent(C)` where
  `earned(C)` = Σ sales allocs[C], `spent(C)` = Σ `Business Account Spending`[Account=C] + Σ `Business Expenses`[Category=C].
  Profit/Revenue rows tagged "processed as personal income" are owner draws → excluded from P&L costs (`IS_OWNER_DRAW`).
- **Tabs** (`viewMode`): `products` (Cards/Compare sub-toggle via `productView`) · `sales` · `accounts` · `expenses` · `insights`
- Sales tab reads `Business Transactions!A:H`; col H is `allocs` JSON `{category: amount}`
- **Accounts 🏦 tab** — `AccountsView`; now reads all 3 sheets so an Expenses-tab spend reduces the matching bucket balance (the Accounts↔Expenses sync). Modal history merges direct spends + expense rows (📒 tag).
- **Expenses 📒 tab** — `ExpensesTab`; reads/writes `Business Expenses!A:G`
  - Reorder thresholds stored in `localStorage` as `biz_reorder_thresholds` (JSON keyed by product ID)
  - `ThresholdModal` — set COGS threshold per product · `ReorderQAModal` — guided Q&A + copy-to-clipboard
- **Insights 📈 tab** — `InsightsView`; 3 tools, all reconcile with the ledger above:
  1. **P&L statement** (period: month/year/all) — Revenue − COGS = Gross; − OpEx = Net; net margin %
  2. **Spending Trend** — last-6-month bar chart of actual cash-out + MoM delta
  3. **Top Vendors** — ranked vendor spend with share % (from both spending sheets)
  - `monthKey(v)` normalises serial/`YYYY-MM-DD`/`M/D/YYYY` dates to `YYYY-MM` so all sheets bucket together

## ProcessIncome.jsx — Key Concepts
- Reads `Allocation Transactions!A:F` to find already-deposited amounts this month
- `calcDeposits(expenses, income, mode, alreadyByType)` — returns per-category deposit amounts
- Two modes: `priority` (fill P1 → P2 → P3) and `proportional` (split by share of remaining need)
- Surplus: income beyond all goals distributed by user-configured weight buckets

## Dashboard.jsx — Key Concepts
- Loads on mount: Monthly Summary, Monthly Expenses, Report Links, Gas Price, Subscriptions
- Subscriptions stored in `Subscriptions!A:E`, cycle types: monthly/annual/weekly/biweekly
- Bill Calendar: shows 30-day window with subscription due-date dots
- Month Close: stores `closed_{month}_{year}` in localStorage (soft close only)
- Statement: `printStatement()` generates a printable HTML page via `window.open()`

## Budget.jsx — Key Concepts (updated 2026-06-02)
- 3 tabs rendered: **Budget** (priority-grouped edit view) | **Categories** | **Entries & Trends**
- **Categories** reads `Allocation Transactions!A:F` (UNFORMATTED_VALUE) for current month → sums by `Type` (col B) → maps against `Monthly Expenses` allowances → groups by `Expense` category (Essentials/Stability/Discretionary/Subscription). Savings items shown separately/collapsible.
- **Entries** = flat sorted list of raw allocation rows for current month
- **Trends** = 3-month comparison (current, last, 2 months ago). `allAllocTx` state holds ALL allocation rows (not just current month); `allocTx` is filtered to current month. Load fetches all rows once; both states populated from the same API call. `Sparkline` renders inline SVG bars (48×24px, 3 bars). `TrendsView` groups by expense category, shows delta arrows + sparklines per item.
- `parseSheetDate(val)` duplicated in ProcessIncome.jsx — consider extracting to `src/lib/dateUtils.js`
- Allocation Transactions column B ("Type") matches Monthly Expenses column "Type" (item name like "Rent", not the expense category)

## Task Tracking
Maintained in Google Drive doc "Finance Tracker – Updates & Task Plans" (auto-updated by Claude).
Original user task list: Google Doc ID `1Lxeo2bhqoeLjFHPGf5SkvIMeWizC8O1t4wtrUTzptqo`
**Current task doc ID**: `1bM6Jk3qyml6v3BMzfTuJzfDJWanssk9RO7nJubMme8s` (updated 2026-06-02)

### Task Status
| # | Task | Status |
|---|---|---|
| 1 | Subscriptions — add/edit/delete | ✅ COMPLETED + VERIFIED |
| 2 | Category view shows all allocated amounts (3-tab Budget) | ✅ COMPLETED + VERIFIED (2026-05-24) |
| 3 | Revenue counts as Profit in Sales card | ✅ COMPLETED + VERIFIED (2026-05-22, code-confirmed 2026-05-24) |
| 4 | Business Expenses full accounting page (Expenses 📒 tab) | ✅ COMPLETED + VERIFIED (2026-05-27) |
| 5 | Month-over-Month Spending Trends (4th Budget tab) | ✅ COMPLETED + VERIFIED (2026-05-28) |
| 6 | Budget Over-Budget Alerts & Nav Badge | ✅ COMPLETED + VERIFIED + DOUBLE-CHECKED (2026-06-02) |
| 7 | Transaction Log: Search, Filter & Running Balance | ✅ COMPLETED + VERIFIED (2026-05-29) |
| 8 | Quick Income Templates (saved amounts) | ✅ COMPLETED + VERIFIED + DOUBLE-CHECKED (2026-05-30) |
| 9 | Savings Goals with Milestone Tracking | ⏳ Plan expanded 2026-05-31, awaiting Execute Y/N |
| 10 | Dashboard Financial Health Score | ✅ COMPLETED + VERIFIED (2026-05-29) |
| 11 | Year-to-Date Budget Summary | ⏳ Plan written 2026-05-28, awaiting Execute Y/N |
| 12 | Commission & Art Income Tracker Improvements | ⏳ Plan written 2026-05-28, awaiting Execute Y/N |
| 13 | Subscription Cost Optimization Insights | ⏳ Plan written 2026-05-28, awaiting Execute Y/N |
| 14 | Net Worth Snapshot | ⏳ Plan expanded 2026-05-31, awaiting Execute Y/N |
| 15 | Tax Prep Summary | ⏳ Plan written 2026-05-28, awaiting Execute Y/N |
| 16 | Recurring Income Forecast | ⏳ Plan written 2026-05-28, awaiting Execute Y/N |
| 17 | 6-Month Income vs Expense Trend Chart | ✅ COMPLETED + VERIFIED (2026-05-29) |
| 18 | Monthly Journal / Memo per Month | ✅ COMPLETED + VERIFIED (2026-05-31) |
| 19 | Split Transaction Entry | ⏳ Plan expanded 2026-05-31, awaiting Execute Y/N |
| 20 | Payday Tracker & Days-Until-Paycheck | ⏳ Plan expanded 2026-05-31, awaiting Execute Y/N |
| 21 | Budget Category Notes & Annotations | ✅ COMPLETED + VERIFIED + DOUBLE-CHECKED (2026-06-02) |
| 22 | Subscription Renewal Push Notifications | ✅ COMPLETED + VERIFIED (2026-05-31) |
| 23 | Bill Due-Date Alerts (Funding Reminders) | ✅ COMPLETED + VERIFIED + DOUBLE-CHECKED (2026-05-31) |
| 24 | Spending Calendar Heatmap | ⏳ Plan written 2026-05-30, awaiting Execute Y/N |
| 25 | Budget Category Reorder & Pinning | ⏳ Plan written 2026-05-30, awaiting Execute Y/N |
| 26 | Debt Payoff Tracker | ⏳ Plan expanded 2026-05-31, awaiting Execute Y/N |
| 27 | Income Source Tagging | ⏳ Plan written 2026-05-30, awaiting Execute Y/N |
| 28 | Monthly Budget Rollover | ⏳ Plan written 2026-05-30, awaiting Execute Y/N |
| 29 | Dashboard Quick-Actions Row | ✅ COMPLETED + VERIFIED (2026-06-02) |
| 30 | Weekly Spending Digest Notification | ⏳ Plan written 2026-06-02, awaiting Execute Y/N |
| 31 | PDF / Print-Ready Monthly Statement | ⏳ Plan written 2026-06-02, awaiting Execute Y/N |

### Task Plans Summary (for quick reference)
- **Task 6**: ✅ VERIFIED + DOUBLE-CHECKED (2026-06-02). Nav badge on Budget nav item (Nav.jsx:66-70, readBudgetBadge from `_fin_budget_alert`). Dashboard amber banner (Dashboard.jsx:810+, `budgetAlerts` state). CategoryView "Not yet funded" chip row (Budget.jsx:691-702). All 3 parts confirmed in code.
- **Task 7**: ✅ VERIFIED + DOUBLE-CHECKED (2026-05-31). Search bar (realtime, matches category/description/amount/account), filter chips (This Month default/Last Month/All Time + Done/Pending status), sort toggle (newest/oldest), CSV copy to clipboard, running balance footer (Net/Count/Avg). Charts only shown in All Time mode. Row limit raised to 1000. `parseSheetDate()` + `monthKey()` helpers added locally. All features code-verified in Transactions.jsx lines 191-617.
- **Task 8**: ✅ VERIFIED + DOUBLE-CHECKED (2026-05-30). Quick-fill template chips in ProcessIncome modal. localStorage key `income_templates` (max 8). State: `templates`, `showManageTpl`, `newTplName`. Chips row above amount input — tap to pre-fill income field (`setIncome(String(t.amount.toFixed(2)))`). Manage mode: ✕ delete per chip + name input + "Save $X.XX" button. "+ Add quick-fill templates" placeholder when empty. All code confirmed at ProcessIncome.jsx lines 103-501.
- **Task 9**: Savings Goals — New "Savings Goals" sheet tab (Name|Target|Current|Deadline|Color|Notes). 5th tab in Budget page ("Goals"). Cards show progress bar, $ remaining, days to deadline, % complete, projected completion date (based on avg monthly contribution from Allocation Transactions). "Contribute" logs to Allocation Transactions as type + updates sheet. Milestones at 25/50/75/100% via push notification, stored in `_fin_goal_milestones = {"GoalName": ["25","50"]}`. CRUD via bottom-drawer. Q: contributions logged to Allocation Transactions or just sheet balance? Dashboard mini-widget for top goal? Color presets for goal cards?
- **Task 10**: ✅ VERIFIED (2026-05-29). Arc gauge on Dashboard (prominent, above month header). 4 signals: Essential Coverage 40pts, Savings Rate 25pts, Allocation Completeness 20pts, Over-Budget Penalty -15pts max. Target 80 marked in amber. Expandable breakdown. 6-month history sparkline (localStorage). Browser push notification when score < 40 (once/day). Code verified: signals compute correctly at Dashboard.jsx:297-330; gauge renders correctly (240° arc, GAUGE_START=150, gap at bottom); health card at line 725.
- **Task 11**: YTD Budget Summary — new tab in Summary page. Shows total income vs goal, per-category YTD actuals vs budget, best/worst month cards.
- **Task 12**: Commission income bridge — "Mark Complete + Process" button links commissions to Process Income modal; outstanding badge on Art nav item.
- **Task 13**: Subscription cost insights — annual cost view, cost ranking, 90-day renewal calendar, month-over-month subscription trend.
- **Task 14**: Net Worth Snapshot — "Net Worth" sheet tab (Date|Account|Type(Asset/Liability)|Balance|Notes). Asset types: Checking/Savings/Investment/Property/Vehicle/Cash/Other. Liability types: Credit Card/Student Loan/Car Loan/Medical/Personal/Other. Dashboard card: Total Assets, Total Liabilities, Net Worth (green/red), MoM delta. Trend line chart (monthly snapshots over time). "Update Balance" → per-account modal prefills last known balance. Auto-snapshot on month close OR manual anytime. Q: which accounts to track? standalone page or Dashboard card? liabilities as positive (app negates) or negative? target net worth marker?
- **Task 15**: Tax Prep Summary — year-end income/expense summary organized by tax category (W2, 1099, COGS, deductions).
- **Task 16**: Recurring Income Forecast — next-3-month cash flow prediction based on historical averages + fixed subscriptions.
- **Task 17**: ✅ VERIFIED (2026-05-29) + DOUBLE-CHECKED (2026-05-30). TrendChartCard component in Dashboard.jsx (before `export default`). Collapsed by default; tap ▼ to expand. Grouped bar chart (teal=income, rose=expenses), last 6 months from `chartData.slice(-6)`. Delta summary: last-mo vs prev income/expense delta + 6-mo avg net. Zero new API calls — uses `chartData` (Monthly Summary already loaded). State: `trendExpanded` in Dashboard. Chart uses existing Recharts BarChart import. Code re-verified 2026-05-30: `incDelta`, `sptDelta`, `avgNet` computations confirmed correct; guard `if (last6.length < 2) return null` confirmed present.
- **Task 18**: ✅ COMPLETED + VERIFIED (2026-05-31). ✎ pencil button next to month/year header on Dashboard opens a bottom-drawer text input (max 200 chars). Saved note shows as italic grey chip below month name (tap to edit). MonthlyDetail page shows note as subtle callout at top. Storage: localStorage `_fin_month_notes = { "YYYY-M": text }`. saveMonthNote() in Dashboard.jsx; getMonthNote() helper in MonthlyDetail.jsx (tries current year then previous year). State: `monthNote`, `showNoteDrawer`, `noteInput`.
- **Task 19 (EXPANDED)**: Split Transaction Entry — In AddModal, "+ Add Split" button adds Category+Amount pairs (up to 5). Shared fields: Date/Description/Account/Status. Running tally vs total. Batch-appends to Allocation Transactions (no schema change). Grouped display in transaction list with ⛓ icon. Q1: max splits 3 or 5? Q2: visual grouping in both Chronological and By Category views, or just Chronological? Q3: fixed total first, then split it — OR per-row amounts that auto-sum? Q4: should split rows appear as individual entries in Budget Categories view? Q5: save common split configurations as templates?
- **Task 20 (EXPANDED)**: Payday Tracker — localStorage `_fin_payday_config = { schedule, startDate }`. Schedule types: Bi-weekly / Semi-monthly (1st & 15th) / Monthly. Dashboard chip: "💰 Paycheck in X days" (green >7d, amber 3-7d, red <3d). Spending-pace warning: "You've spent Y% of income with Z% of pay cycle elapsed." Optional push notification the evening before payday. Q1: what is your pay schedule? Q2: chip on Dashboard only or Budget page too? Q3: would you like an evening-before push notification? Q4: how many past pay periods to look back to confirm history? Q5: custom spending-pace warning threshold (e.g. warn when >80% spent with >50% cycle remaining)?
- **Task 21**: ✅ COMPLETED + VERIFIED + DOUBLE-CHECKED (2026-06-02). localStorage `_fin_cat_notes = { "TypeName": "text" }`. `getCatNotes()` helper in Budget.jsx:67-69. `CategoryItemCard` (Budget.jsx:498-675): `note`/`showNoteDrawer`/`noteInput` state, `openNoteDrawer()` pre-fills input, `saveNote(text)` writes/deletes from map. ✎ button ml-auto at line 558. Note as italic clickable button at line 569. Bottom-drawer (lines 632-672): 160-char textarea, char counter, Clear+Save, autoFocus. `BudgetCard` (line 378): reads `getCatNotes()[type]`, shows read-only italic gray at line 389.
- **Task 22**: ✅ COMPLETED + VERIFIED (2026-05-31). On Dashboard load, scans subscriptions for renewals within lead time (default 3 days). Fires grouped push notification. localStorage `_fin_sub_notif_sent = { "YYYY-MM-DD": ["Name1",...] }` for dedup. Lead time (1/3/7 days) via ⚙ gear in Subscriptions modal header → mini-picker. Uses existing `nextRenewal()` + `daysUntil()` helpers + Notification API from Task 10. `subNotifLead` state at Dashboard level. `showNotifPicker`/`leadVal` states in SubsModal.
- **Task 23**: ✅ COMPLETED + VERIFIED + DOUBLE-CHECKED (2026-05-31). localStorage `_fin_due_dates = { "TypeName": dayNum }`. Budget→Categories `CategoryItemCard`: per-item "📅 Due Xth" chip (tap to open select 1-31 + "No date"); shows "⚠ Past due" (rose) or "⏰ Due in Nd" (amber) badges when unfunded. Dashboard banner: `dueAlerts[]` computed as unfunded items with `0 <= diff <= 3` days. ProcessIncome: badges in allocation rows. All 3 files verified: Budget.jsx:46-546, Dashboard.jsx:362-375+818-821, ProcessIncome.jsx:100-655.
- **Task 26**: Debt Payoff Tracker — "Debts" sheet tab (Name|Type|Balance|InterestRate|MinPayment|Account|TargetDate|Notes). Dashboard card: total debt, # accounts, total min payment (rose if debt > income). Per-debt detail: months to payoff at min vs +$X extra (slider), interest saved. Toggle Avalanche (highest APR) vs Snowball (smallest balance) order — shows total interest difference between strategies. Milestones at 25/50/75/100% → push notification, stored `_fin_debt_milestones`. "Log Payment" → updates Balance in sheet + logs to Allocation Transactions. Q: what debt types do you have? standalone page or Dashboard card? show avalanche/snowball interest difference? payments reduce budget allocation?
- **Task 24**: Spending Calendar Heatmap — monthly heatmap grid (7-col week layout) colored by daily transaction intensity (pale→deep rose). Tap day = micro-tooltip with category breakdown. Reuses existing Allocation Transactions data. Collapsible Dashboard card or Budget→Entries sub-view. Q: Dashboard vs Budget Entries? Show income days differently? Month navigation?
- **Task 25**: Budget Category Reorder & Pinning — 📌 pin per category card floats it to top of its priority group. Drag-or-arrows reorder within tiers. localStorage `_fin_cat_order = { "TypeName": sortIndex }`. Reset to default button. Q: drag-and-drop vs up/down arrows? Visual pin indicator? Order persists across months?
- **Task 27 (EXPANDED 2026-06-02)**: Income Source Tagging
  - Source chips in ProcessIncome modal above Description field: Paycheck | Art Commission | Business | Side Work | Other (tapping one auto-sets Description prefix `[Paycheck]`, etc.)
  - No schema change — prefix stored inside existing Allocation Transactions col D (Description)
  - Dashboard income breakdown (collapsible, below income stat): sum this-month positive alloc rows by `[Source]` prefix → horizontal pill bar showing % per source; untagged rows grouped as "Untagged"
  - Transactions page: new "Source" filter chip group below existing filters (parses prefix from Description)
  - Files to modify: ProcessIncome.jsx (source chip row), Dashboard.jsx (mini breakdown section), Transactions.jsx (source filter)
  - localStorage: none needed — data lives in the sheet
  - Q1: Which income sources do you have? (Paycheck / Art Commission / Business / Tips / Other?)
  - Q2: Should the source breakdown show on Dashboard only, or also in Budget → Trends?
  - Q3: Should `[Source]` prefix be hidden in most views (only shown in breakdown), or always visible?
  - Execute? Y/N:
- **Task 28 (EXPANDED 2026-06-02)**: Monthly Budget Rollover
  - Rollover toggle (↩) on each CategoryItemCard in Budget → Categories; stored in `_fin_rollover_cats = ["TypeName", ...]`
  - On category view load: compute previous month's surplus per enabled item (budgeted − allocated from prior month's Allocation Transactions rows); store in `_fin_rollover_credit = { "YYYY-M": { "TypeName": amt } }` (keyed by the CURRENT month)
  - Credit display: "+$X.XX rollover from [Month]" line in soft teal below the progress bar; reduces effective funding gap (credit + allocated vs. budgeted)
  - Dashboard chip (optional): "↩ $X.XX in rollover credits active" near month header when any credits exist
  - Credits expire automatically after 13 months
  - Budget Plan tab: rollover-enabled items show a small ↩ icon next to their name
  - Files to modify: Budget.jsx (CategoryItemCard toggle + credit display + rollover computation), Dashboard.jsx (optional chip)
  - Q1: Which categories should roll over? (vacation fund, car maintenance, irregular bills, savings buffer?)
  - Q2: Should rolled-over credits count TOWARD the monthly goal (reduce income needed) or stack as bonus ABOVE the goal?
  - Q3: If you turn off rollover for a category mid-year, should the existing credit stay until spent, or clear immediately?
  - Execute? Y/N:
- **Task 29**: ✅ COMPLETED + VERIFIED (2026-06-02). Horizontal scrollable chip strip below month header in Dashboard.jsx. Four actions: 💰 Process Income (opens ProcessIncome modal, shows teal dot badge when allocTotals.income === 0), 📝 Log Transaction (navigates to /transactions), 📊 This Month (navigates to MonthlyDetail or /summary), 📅 Bill Calendar (smooth-scrolls via `billCalendarRef`). `useRef` added to import; `billCalendarRef` attached to bill calendar IIFE div. No localStorage, no new API calls.
- **Task 30 (EXPANDED 2026-06-02)**: Weekly Spending Digest Push Notification
  - Trigger logic: on Dashboard load, read `_fin_digest_config = { enabled, dayOfWeek, lastFired }`. If enabled AND today's day-of-week matches AND lastFired is > 7 days ago → fire notification
  - Notification text: "Week ending [Date]: $X allocated, Y% of monthly budget used. Top category: [Z]." + "⚠ N essential items still unfunded." (if any P1 unfunded)
  - Data source: reuses `allocTx` / `abt` map already computed in the `Promise.all` handler — zero extra API calls
  - Config UI: "📬 Weekly Digest" toggle chip added below the Health Score card on Dashboard; tap opens a small bottom-drawer with enabled toggle + day-of-week selector (7 chips Mon–Sun) + preview message
  - localStorage: `_fin_digest_config = { enabled: false, dayOfWeek: 0, lastFired: "YYYY-MM-DD" }`
  - Files to modify: Dashboard.jsx only (digest check in existing alloc processing block + config drawer)
  - Q1: What day of the week would you prefer the digest? (Sunday default)
  - Q2: Should the digest also show as an in-app summary card visible for that week, or push notification only?
  - Q3: Should it name the #1 unfunded essential item, or just the count?
  - Execute? Y/N:
- **Task 31**: PDF/Print Monthly Statement — enhance existing `printStatement()` with full layout: income summary, category breakdown (budgeted vs actual), top 5 expenses, health score, month note. `@media print` CSS for clean A4/letter output. "Copy as Plain Text" button. No new API calls — all data already loaded by Dashboard.

## Quick Actions Row (Task 29) — VERIFIED 2026-06-02
- Horizontal scrollable chip strip (overflow-x-auto) placed between month header and gas price section in Dashboard.jsx
- Four chips rendered from an inline array: each has `id`, `icon`, `label`, `badge` (bool), `color` (Tailwind classes), `onClick`
- `billCalendarRef = useRef(null)` declared after state block; attached via `ref={billCalendarRef}` to the bill calendar IIFE's root div
- Badge: teal dot (`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-teal-400 ring-2 ring-slate-900`) shown on Process Income chip when `allocTotals.income === 0`
- "This Month" navigates to MonthlyDetail if `reportLinks[currentMonth]` exists, otherwise falls back to `/summary`
- "Bill Calendar" uses `billCalendarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })`
- No localStorage, no new API calls

## Category Notes System (Task 21) — VERIFIED + DOUBLE-CHECKED 2026-06-02
- localStorage key: `_fin_cat_notes = { "TypeName": "note text" }` — persists across months
- `getCatNotes()` helper in Budget.jsx (after `getDueDates()` line ~54)
- `CategoryItemCard`: `note` state (lazy init), `showNoteDrawer`, `noteInput` state
- `openNoteDrawer()` pre-fills `noteInput`; `saveNote(text)` writes/deletes from localStorage map
- ✎ button with `ml-auto` in type name flex-wrap row; note displays as italic clickable button below Account
- Bottom-drawer modal: 160-char textarea, char counter, Clear + Save buttons, `autoFocus`
- `BudgetCard` (Budget Plan tab): reads `getCatNotes()[type]` at render — shows read-only italic gray text below item name

## Subscription Renewal Notification System (Task 22) — COMPLETED 2026-05-31
- localStorage key: `_fin_sub_notif_lead` = "1"|"3"|"7" (days ahead; default 3)
- localStorage key: `_fin_sub_notif_sent = { "YYYY-MM-DD": ["SubName1", "SubName2"] }` (dedup per day)
- Notification fires on Dashboard mount, after subscriptions loaded, inside `Promise.all` `.then` handler
- Uses existing `nextRenewal(startDateStr, cycle)` + `daysUntil(date)` helpers (defined at top of Dashboard.jsx)
- Single notification for 1 qualifying sub; grouped notification listing all when multiple
- UI: `subNotifLead` state at Dashboard component level; `showNotifPicker`/`leadVal` states inside SubsModal
- ⚙ gear button in Subscriptions modal header → mini-popover with 1d/3d/7d buttons; closes on selection

## Month Note System (Task 18) — VERIFIED 2026-05-31
- localStorage key: `_fin_month_notes = { "YYYY-M": "text" }` e.g. `"2026-5": "Big tax month"`
- Dashboard state: `monthNote` (lazy init), `showNoteDrawer` (bool), `noteInput` (string)
- `saveMonthNote(text)` writes/deletes the key for `${now.getFullYear()}-${now.getMonth()+1}`
- ✎ button inline with month/year h1; italic chip below heading when note exists (tap to edit)
- Bottom-drawer modal: `autoFocus` textarea, 200-char limit + char counter, Clear + Save buttons
- MonthlyDetail: `getMonthNote(monthName)` helper — scans MONTH_NAMES array, tries current year key then prior year

## Git Workflow
1. Source changes → main branch directly (no PRs per user preference)
2. Deploy: `npm run deploy` on `main` → builds dist/ → pushes to `gh-pages`

## Security Checklist
- [ ] No API keys or tokens in source code or commit history
- [ ] No financial data (amounts, sheet contents) in GitHub
- [ ] All user data stays in their private Google Sheet
- [ ] Google OAuth scope is `spreadsheets` only (not drive, gmail, etc.)
- [ ] PIN prevents unauthorized access if device is shared
