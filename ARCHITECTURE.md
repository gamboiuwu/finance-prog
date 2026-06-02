# Finance Tracker — Full System Reconciliation & Reference

> Internal architecture reference. Written from a complete read of all ~18K lines
> across `src/`. This is the source of truth for **how money flows through the app**,
> **where every number comes from**, and **the known reconciliation hazards** (places
> where the same concept is computed differently in different screens).
> Last full reconciliation: 2026-06-02.

---

## 0. The One-Paragraph Mental Model

There is **no backend**. The browser talks straight to one private Google Sheet
(`SPREADSHEET_ID`) over the Sheets v4 REST API using a Google OAuth token in
`localStorage`. Every screen is a different *view/derivation* over a handful of sheet
tabs. The app deliberately keeps **personal budgeting**, **the art-commission business**,
**the time clock**, and **the Dragon AI assistant** as semi-independent subsystems, each
reading the tabs it needs. Because they were built at different times, the same words
("income", "spent", "goal", "free cash flow", "gas budget") are sometimes computed from
different tabs or with different rules. Section 7 lists every such divergence so you
never have to rediscover them.

---

## 1. Data Layer (`src/lib`, `src/config.js`, `src/App.jsx`)

### Auth & gate
- `lib/auth.js` — Google OAuth2 (GIS popup). Token in `localStorage.gtoken` + `gtoken_expiry`
  (already minus a 60 s safety margin, ~1 hr life). **No refresh logic** — when the token
  expires, in-flight Sheets calls 401 until the next App mount re-prompts. (Known gap.)
- `lib/pin.js` — SHA-256(`pin` + static SALT) → `fpin_hash`. 10-min idle lock (`fpin_unlock`),
  attempt counter `fpin_attempts` (cleared on any activity). It's a **presentation lock**, not
  real crypto (4-digit space, resettable counter). `App.jsx` re-locks on `visibilitychange`.
- `App.jsx` — 3-stage gate: no token → `Login`; PIN unset/locked → `PinGate`; else routed app.
  Routes: `/` `/budget` `/summary` `/transactions` `/commissions` `/gas` `/business` `/actions`
  `/dragon` `/goals` `/month/:sheetId/:month`. HashRouter (gh-pages requirement).

### Sheets wrappers
- `lib/sheets.js` — `readRange(token, range, valueRender='FORMATTED_VALUE')`, `readRangeFrom`
  (arbitrary sheet by ID — used only by MonthlyDetail), `appendRow` / `updateCell` /
  `batchUpdateCells` (`USER_ENTERED`), `ensureSheetTab` (**swallows all errors**), `clearRow`
  (`:clear` — blanks cells, leaves the physical row), `readReportLinks` (parses
  `=HYPERLINK("url",…)` in `Monthly Summary!A2:C13`, hardcoded 12-row range).
- `lib/sheetWrite.js` — "safe write" layer used by DataRepair + Dragon tools. Locates the target
  column/row by **header-text matching at runtime** (`findCol` = lowercase `.includes`), so a
  rename throws instead of writing the wrong cell — but a *similarly named* header can still be
  mis-targeted (e.g. "Savings Goal" vs "Income Goal"). Owns the **`Plans`** tab (savings-goal
  storage; header `ID,Name,Scope,Target,Saved,Per Month,Target Date,Funding,Status,Created,Notes`).
  Key helpers: `recalcMonthlySummary`, `sumAllocations`, `setAllocationAmount`, `deleteAllocation`,
  `updateBudgetAllowance/Priority`, `readPlans/savePlan/updatePlanProgress/deletePlan`,
  `applyPlanToBudget`. `monthKey(v)` normalizes serial / `YYYY-MM-DD` / `M/D/YYYY` → `YYYY-MM`.

### External / device-only
- `lib/gasPrice.js` — EIA weekly gas API, 5 NY regions × 3 grades, 1 h cache (`eia_gas_v1`),
  6 s timeout + stale-fallback. NYC Regular = `byRegion['Y35NY'].products['EPMR'].value`.
- `lib/gasBudget.js` — **dynamic gas budget**. `computeGasBudget = (milesPerDay/mpg) × $/gal × daysInMonth`
  with `GAS_MILES_PER_DAY=56.6`, `DEFAULT_MPG=23.5` → ≈$185. Cached in `_fin_gas_budget`
  `{value, gasPerGal, mpg, ts}`. Written by **both Dashboard and Summary**; read by Budget +
  ProcessIncome via `getGasBudget()`/`gasAllowance()`. (No TTL — uses whatever was last cached.)
- `lib/orders.js` / `lib/easypost.js` — Orders & shipping (device-only). Templates
  `biz_order_templates`, `biz_ship_from`, `easypost_proxy_url`, `easypost_api_key`. EasyPost
  routed through the user's CORS proxy (browser CORS blocked). Order # = `PREFIX-000N` from a
  per-product `nextNumber` counter (non-atomic — concurrent saves can duplicate).
- `lib/dragonKey.js` / `lib/dragonPrefs.js` — Anthropic key (`dragon_anthropic_key`) + Dragon
  prefs (`dragon_prefs_v1`: model, tone, paySchedule, pace, webResearch). Pay schedules:
  weekly 52/12, biweekly 26/12, semimonthly 2, monthly 1 paychecks/mo. Paces 0.35/0.5/0.7.

---

## 2. The Google Sheet Tabs (the real database)

| Tab | Key columns | Written by | Read by |
|---|---|---|---|
| **Monthly Summary** | Month, Year, Total Processed Income, Total Spent, Unprocessed Income, Allowance Goal, Highest Spent Category, Report-link (col C HYPERLINK) | sheetWrite (`recalcMonthlySummary`), DataRepair | Dashboard, Budget, Summary, Dragon |
| **Monthly Expenses** | Type, Account, Priority (1/2/3), Expense (Essentials/Stability/Discretionary/Subscription/Savings), Monthly Allowance ($), Actual Spend | Budget edit/add, sheetWrite | Dashboard, Budget, Summary, ProcessIncome, Dragon |
| **Allocation Transactions** | A Date, B Type, C Amount (+deposit/−spend), D Description, E Account, F Done(bool) | ProcessIncome, Dashboard (gas/expense log), Transactions Add | Dashboard, Budget, Transactions, Actions, ProcessIncome, Summary(via sum), Dragon |
| **Allocation Summary** | label / balance pairs (incl. a **Gas** row = gas balance on hand) | (sheet formulas) | Summary |
| **Expense Summary** | wide key/value layout (PI, CI, wage, mpg, $/gal, mpg, deposits, etc.) | (sheet formulas) | Summary |
| **Subscriptions** | Name, Start Date, Cycle, Amount, Notes | Dashboard subs CRUD, sheetWrite | Dashboard, Dragon |
| **Inquiries** | Card Name, Contact, desc, Status, Price Agreed, Paid Amount…, Comm Date, Completion Date | Commissions Add | Commissions |
| **Commission Prices** | ID,Category,Variant,BasePrice,ExtraChar,BgSimple,BgComplex,RushPct,CommercialPct,TimeHours,Notes,Active | CommissionPrices (auto-migrates) | CommissionPrices |
| **Business Products** | ID, Name, StartPrice, Formula(JSON blocks) | BusinessExpenses products | BusinessExpenses, TimeClock |
| **Business Transactions** | A Date, B Client, C Product, D Qty, E Unit Price, F Revenue, G Margin%, H Allocs(JSON `{cat:amt}`), I Order(JSON) | BusinessExpenses sales | BusinessExpenses, Actions, Dragon |
| **Business Account Spending** | A Date, B Account, C Amount, D Vendor, E Description | BusinessExpenses (owner draws + direct spends) | BusinessExpenses |
| **Business Expenses** | A Date, B Vendor, C Amount, D Category, E Product, F Payment, G Notes | BusinessExpenses expenses | BusinessExpenses, Dragon |
| **Work Sessions** | Date, Start, Duration(s), Duration, Products, Total Units, Total Profit, $/hr, Notes | TimeClockView | TimeClockView |
| **Plans** | ID,Name,Scope,Target,Saved,Per Month,Target Date,Funding,Status,Created,Notes | sheetWrite (Dragon/Goals) | Goals, Dragon |

> **Date storage is inconsistent on purpose-of-origin:** rows the app writes are usually
> `M/D/YYYY` or `YYYY-MM-DD` strings, but Sheets may store/return them as serials or locale
> format. Always bucket months through a `monthKey`-style normalizer, never `.startsWith`.

---

## 3. The Money Engines

### 3a. Income processing — `ProcessIncome.jsx` (`calcDeposits`)
Given an income amount, fund each budget category's **remaining gap** (goal − already funded).
- `already` per category: **monthly** types = sum of this-month positive rows whose description
  starts with "income processed"; **running** types (`_fin_budget_balance_type`) = all-time net.
- **Gas is special:** allowance = the dynamic gas budget (`gasBudget` prop, ≈$185, scales with
  price); already = `max(0, gasBalance)` (all-time net). So gas deposit = budget − balance, and
  a topped-off gas tank asks for $0. Gas matching is **case/space-insensitive** (`isGas`).
- **Priority mode:** waterfall P1→P2→P3, each gap filled before the next.
- **Proportional mode:** each gap gets `gap/Σgaps × income`, capped at its own gap (leftover → surplus).
- **Surplus** = income − Σ deposits, split across user weight buckets (`processIncome_surplusItems`).
- Writes one `Allocation Transactions` row per deposit: `[date, Type, amount, "Income processed: …", Account, true]`.
- `income_templates` (max 8) quick-fill chips; `depositPlan` "🧾 Where it goes" receipt + copy.

### 3b. Personal budget — `Budget.jsx`
Three tabs, **three different bases** (this is the #1 source of user confusion — labels now
clarify each):
- **Budget** tab → plan vs **`Actual Spend`** (manually-maintained sheet column).
- **Categories** tab → **funded** this month = Σ positive `Allocation Transactions` deposits by Type
  (`allocByType`). Gas overridden to all-time balance; goals via `itemGoal` (dynamic gas).
- **Entries & Trends** → raw allocation rows + 3-month MoM comparison (`TrendsView`).
- **Funding-status banner** (top, all tabs): essentials not-yet-funded vs partially-funded, from
  deposits (`fundingByType`/`effFunded`); gas uses all-time balance vs dynamic budget.
- Per-item: due dates `_fin_due_dates`, notes `_fin_cat_notes`, balance type `_fin_budget_balance_type`.

### 3c. Dashboard — `Dashboard.jsx`
- **income/spent** = current-month allocation totals (`allocTotals`), ground-truthed once
  `hasCurrentMonthAllocRows` is loaded (so a new month shows $0, not last month's stale sheet value).
  *(Both income and spent now use this guard — previously only income did.)*
- **gasBalance** = all-time signed sum of Gas allocation rows. **gasBudget** = dynamic (cached).
- **Safe to Spend / Day** = flexible money left ÷ days remaining (incl. today). Flexible =
  Discretionary category (or all non-Savings if none); spent side from `Actual Spend`.
- **Health score (0–100):** S1 Essential coverage 40 (gas counts as covered if balance>0),
  S2 Savings rate 25, S3 Allocation completeness 20, S4 over-budget penalty −15 max.
- **Budget alerts:** `overCount` (allocated > allowance — i.e. over-*allocation*), `needsCount`
  (P1 unfunded; gas excepted by balance), `dueAlerts` (unfunded item due ≤3 days).
- **Statement archive** (`_fin_statements`, max 24): month-close (or auto-backfill of the previous
  month on load) snapshots income/spent/net/goal/note/txns; viewer + `printStatement` HTML/PDF.
- Writes: gas spend & quick expense → `Allocation Transactions`; subscriptions CRUD → `Subscriptions`.

### 3d. Gas model (single reconciliation point)
- **Price:** one source everywhere — EIA `Y35NY/EPMR` (GasPrices displays; Summary/Dashboard consume).
- **Budget (target):** `computeGasBudget` ≈$185, cached `_fin_gas_budget` by **Dashboard + Summary**;
  consumed by Budget + ProcessIncome.
- **Balance (on hand):** all-time net of Gas allocation rows (Dashboard) / `Allocation Summary` Gas
  row (Summary). *Deposit needed = budget − balance.*
- Summary also shows `budgetFor2QC` = gross reserve − balance (a **shortfall**, not the budget).

### 3e. Business — `BusinessExpenses.jsx`
- **Product formula** = ordered waterfall of blocks `{category,type:'fixed'|'percent',value,customName}`.
  `computeFormula(startPrice,blocks)`: fixed takes `min(val,remaining)`, percent takes
  `remaining×val/100`. Real sales scale fixed blocks by `revenue/startPrice`
  (`computeFormulaProportional`, sub-cent dust folded into last step). Balanced when remaining ≈ 0.
- **Profit = Profit + Revenue** allocation categories (same emerald, combined everywhere).
  `netProfit = max(0, totalProfit − profitSpent)`; owner draws (`IS_OWNER_DRAW`, substring match —
  now used consistently for `profitSpent` too) are excluded from P&L.
- **Per-category ledger:** `balance(C) = earned(C) − spent(C)` where earned = Σ sales `allocs[C]`,
  spent = Σ Business Account Spending[Account=C] + Σ Business Expenses[Category=C]. **All-time** (no
  period filter) — Accounts tab truth.
- **6 tabs:** products (cards/compare) · sales (period+order filters) · accounts (ledger) · expenses
  (`Business Expenses`, month buckets via `monthKey` — fixed) · insights (P&L = Revenue−COGS=Gross;
  −OpEx=Net, period-filtered; spending trend; top vendors) · timeclock.
- Reorder thresholds `biz_reorder_thresholds` (keyed by product **id**, COGS summed by **name**).

### 3f. Time clock — `TimeClockView.jsx`
Gamified work timer. `computeProfit` re-implements the product waterfall (Profit+Revenue + any
leftover) × qty. `hourlyRate = profit / hours`. XP/levels/streaks. Logs to its own **Work Sessions**
sheet + `biz_timeclock_*` localStorage. **Not reconciled into Business Transactions / income.**

### 3g. Commissions — `CommissionPrices.jsx` + `Commissions.jsx`
- Pricing menu (self-migrating `Commission Prices` sheet). `total = (base + extraChars×rate +
  bg) + rush%×subtotal + commercial%×base`. (Rush is % of subtotal; commercial is % of base only.)
- Inquiry tracker (`Inquiries`, 50-row cap). Collected/outstanding totals are inquiry-local —
  **commission income never flows into Monthly Summary.**

### 3h. Dragon AI assistant — `pages/DragonBot.jsx` + `lib/dragon*`
- `@anthropic-ai/sdk` direct from browser (`dangerouslyAllowBrowser`), user's own key. Default
  `claude-sonnet-4-6`, adaptive thinking, cached system prompt, ≤8-step tool loop, optional web search.
- 16 tools (`dragonTools.js`): read tabs + write via `sheetWrite.js` (confirm-before-write,
  never auto-delete), plus visual cards (`computeOverview`, `analyzeAffordability`).
- `dragonOverview.js` is the Dragon's finance math: personal income = **mean of last-6 positive**
  Monthly-Summary incomes; FCF = avgIncome − Σ allowances; business reads **Business Expenses only**
  (revenue hardcoded col F) — **omits Business Account Spending, owner-draw exclusion, and TimeClock**.
- `dragonPlan.js` affordability: `perMonth`, `perPaycheck`, trim plan (≤40% per discretionary bucket),
  milestones 25/50/75/100, feasibility (comfortable/tight/needs_trims/infeasible).

---

## 4. localStorage Key Inventory

| Key | Shape | Owner |
|---|---|---|
| `gtoken` / `gtoken_expiry` | token / epoch | auth |
| `fpin_hash` / `fpin_unlock` / `fpin_attempts` | hash / epoch / int | pin |
| `eia_gas_v1` | `{data,ts}` 1 h | gasPrice |
| `_fin_gas_budget` | `{value,gasPerGal,mpg,ts}` | gasBudget (Dashboard+Summary write) |
| `_fin_statements` | `{ "Month Year": {income,spent,net,goal,closedAt,note,txns?} }` ≤24 | Dashboard |
| `_fin_month_notes` | `{ "YYYY-M": text }` | Dashboard / MonthlyDetail |
| `_fin_due_dates` | `{ Type: dayNum }` | Budget / Dashboard |
| `_fin_cat_notes` | `{ Type: text }` | Budget |
| `_fin_budget_balance_type` | `{ Type: "monthly"\|"running" }` | Budget / ProcessIncome |
| `_fin_budget_alert` | `{ count, month:"YYYY-M" }` (+`_fin_budget_alert_update` event) | Dashboard → Nav badge |
| `_fin_health_history` | `[{month:"YYYY-M",score}]` ≤6 | Dashboard |
| `_fin_health_notified` / `_fin_sub_notif_sent` / `_fin_sub_notif_lead` | dedup / lead days | Dashboard |
| `closed_<Month>_<Year>` | `'true'` | Dashboard month close |
| `income_templates` / `processIncome_surplusItems` | arrays | ProcessIncome |
| `biz_reorder_thresholds` | `{ productId: number }` | BusinessExpenses |
| `biz_order_templates` / `biz_ship_from` / `easypost_proxy_url` / `easypost_api_key` | orders/shipping | orders |
| `biz_timeclock_sessions` / `_active` / `_daily_goal` | sessions | TimeClock |
| `dragon_anthropic_key` / `dragon_prefs_v1` | key / prefs | dragon |
| `summary_order_<tab>` / `summary_overrides` | tile order / display overrides | Summary |
| `fin_issues` | array ≤30 | IssueReporter |
| `commCalcRate` | string | Dashboard comm calc |
| `repair_2026_05_29_done` | `'1'` (DataRepair now retired) | DataRepair |

> **`ErrorBoundary` "Clear cache & reload" runs `localStorage.clear()`** — wipes ALL of the
> above (token, PIN, every `_fin_*`, configs). It's a nuclear escape hatch; warn before using.

Month-key convention note: app screens use **unpadded `YYYY-M`** (e.g. `2026-6`) for note/alert/
health keys; `monthKey()` (sheets/dragon) uses **padded `YYYY-MM`**. Producers and consumers are
internally matched today, but don't mix the two formats across a boundary.

---

## 5. Date Parsing (fragmentation — handle with care)
Independent implementations exist: `Transactions.parseSheetDate`/`monthKey`,
`Actions.parseDatetime` (+ a dead `parseDate`), `Budget`/`ProcessIncome` `parseSheetDate` (duplicated),
`BusinessExpenses.monthKey`, `dragonOverview.monthKey`, `sheetWrite.monthKey`, plus ad-hoc parsers in
GasPrices/MonthlyDetail. All use the Excel-serial heuristic `n>1000 && no '/'` →
`(n−25569)×86400000`. **TODO (long-standing):** extract one `src/lib/dateUtils.js` and delete the copies.

---

## 6. Corrections Applied During This Reconciliation (2026-06-02)
1. **Dashboard `setGasBalRefresh` was undeclared** → income-processed callback threw `ReferenceError`
   and never refreshed. Added a real `refreshKey` state wired into the load effect + callback.
2. **Dashboard `spent` fallback was asymmetric** with `income` → could show a stale sheet value at
   month start. Now both guard on `hasCurrentMonthAllocRows`.
3. **Health score S1** counted Gas as uncovered unless deposited this month → now uses the gas
   balance like `needsCount`.
4. **Dashboard color typo** `'2':'f59e0b'` → `'#f59e0b'`.
5. **ProcessIncome gas matching** was case-sensitive `=== 'Gas'` (would over-deposit on "gas"/" Gas")
   → shared `isGas()` normalizer, matching Budget.
6. **ProcessIncome header "% covered"** double-counted gas (goal used dynamic budget but "already"
   didn't use the gas balance) → `totalAlready` now substitutes the gas balance.
7. **Budget** dead `'trends'` subtitle branch → real per-tab subtitles clarifying spend vs funded basis.
8. **BusinessExpenses ExpensesTab** month filter used `.startsWith('YYYY-MM')` on formatted dates →
   silently emptied the donut/trend/COGS/reorder on non-ISO date cells. Now uses `monthKey()`.
9. **BusinessExpenses owner-draw** detector inconsistency (`===` vs `.includes`) → both use `IS_OWNER_DRAW`.
10. **Transactions** monthly chart naive `split('/')` dropped serial/ISO rows → uses `parseSheetDate`.
11. **DataRepair** stale May-2026 one-time fix could re-surface on a fresh browser and overwrite
    correct data → **retired** (force-hidden).

---

## 7. KNOWN RECONCILIATION HAZARDS (by design / not yet unified)
These are the places the same word means different numbers. None are bugs per se — they reflect
different sheets/purposes — but they're where "the numbers don't tie out" questions come from.

- **"Income"** — Dashboard = current-month allocations; Summary = `Expense Summary` PI/CI cell;
  Dragon = mean of last-6 Monthly-Summary incomes; MonthlyDetail = a per-month report sheet.
- **"Spent"** — Dashboard stat card = allocation negatives; Safe-to-Spend & 50/30/20 = `Actual Spend`;
  Budget Plan tab = `Actual Spend`; Budget Categories tab = positive deposits (funded, not spent);
  statement = txn negatives. **Same sheet, opposite intent** between Transactions (sign) and Budget (deposits).
- **"Monthly Goal"** — Summary = Σ Monthly-Expenses allowances; Dashboard = that or Monthly-Summary
  `Allowance Goal`; MonthlyDetail = report sheet `Minimum`; Plans = goal target. (≥3 sources.)
- **"Free cash flow"** — Dragon overview = avgIncome − Σ allowances; Dragon planner = income − outflow
  (also allowances). Overview card mixes `net` (actual spend) with FCF (budget).
- **Business net/margin** — BusinessExpenses Insights (two spend sheets, owner-draw-excluded,
  period-filtered) vs Dragon overview (Business Expenses only, col-F revenue) vs TimeClock (own sheet).
  **These do not reconcile.**
- **Gas "budget" vs "balance"** — Summary's "Claimable Gas Budget" tile is actually the *balance*;
  the dynamic *budget* (~$185) lives in `_fin_gas_budget`. (Naming confusion only.)
- **Commission "Collected" and TimeClock profit never reach Monthly Summary income.**
- **Goals systems** — the shipping `Goals.jsx` (Plans sheet + Dragon cashflow) vs the still-pending
  Task-9 "Savings Goals" plan are two different surfaces; don't build the latter without merging.

---

## 8. Top Open Risks (for future work, priority order)
1. **No OAuth token refresh** — mid-session expiry surfaces as raw errors until reload.
2. **Date-parser fragmentation** — extract `src/lib/dateUtils.js`; replace all copies + remaining
   `.startsWith`/`split('/')` month logic.
3. **Cross-engine business numbers don't reconcile** (BusinessExpenses vs Dragon vs TimeClock) —
   pick one `computeBusinessPnL` and have all three consume it.
4. **`findCol` substring matching** (sheetWrite) can target a wrong similarly-named column/row.
5. **CommissionPrices auto-migration is destructive** (`clearRow A1:L500` + loop-append, no backup).
6. **`ensureSheetTab` swallows all errors** — masks auth/network failures as "empty data".
7. **Commissions writes by position but reads by header name** — totals depend on exact live headers.
8. **ErrorBoundary `localStorage.clear()`** is total — consider clearing only volatile caches.
</content>
</invoke>
