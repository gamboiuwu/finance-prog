// dragonOverview.js — shared finance math for Ledger's read/plan/visual tools.
//
// PURE JavaScript, zero LLM tokens. Centralising the derivation here means the
// chat answers, the affordability planner, and the visual overview windows all
// compute from the SAME logic — so the numbers always agree and stay correct.
import { readRange } from './sheets';
import { SHEETS } from '../config';

const BUSINESS_TRANSACTIONS_SHEET = 'Business Transactions';
const SUBSCRIPTIONS_SHEET = 'Subscriptions';

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const toNum  = (v) => parseFloat(String(v ?? '').replace(/[$,]/g, '')) || 0;

// Find a column index whose header contains any needle (lowercased). -1 if none.
export function colIdx(headers, ...needles) {
  const lower = (headers || []).map(h => String(h ?? '').toLowerCase());
  for (const n of needles) {
    const i = lower.findIndex(h => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

// Normalise a sheet date cell (serial / YYYY-MM-DD / M/D/YYYY) to YYYY-MM.
export function monthKey(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  const n = Number(v);
  if (!isNaN(n) && n > 1000 && !s.includes('-') && !s.includes('/')) {
    const d = new Date(Math.round((Math.floor(n) - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (s.includes('-')) return s.slice(0, 7);
  if (s.includes('/')) { const p = s.split('/'); return `${p[2]}-${String(p[0]).padStart(2, '0')}`; }
  return '';
}

// Monthly-equivalent cost of a subscription given its billing cycle.
function monthlyFromCycle(cost, cycle) {
  const c = String(cycle || 'monthly').toLowerCase();
  if (c.includes('year') || c.includes('annual')) return cost / 12;
  if (c.includes('bi') && c.includes('week'))      return (cost * 26) / 12; // every 2 weeks
  if (c.includes('week'))                          return (cost * 52) / 12;
  return cost; // monthly
}

// ── Cash-flow derivation (reused by the affordability planner) ───────────────
// Personal: average recent income, total committed allowances, trimmable buckets.
export async function derivePersonalCashflow(token) {
  let monthlyIncome = 0;
  const sum = await readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A:Z`, 'UNFORMATTED_VALUE').catch(() => []);
  if (sum.length > 1) {
    const ic = colIdx(sum[0], 'income');
    const vals = sum.slice(1).map(r => toNum(r[ic >= 0 ? ic : 1])).filter(v => v > 0).slice(-6);
    if (vals.length) monthlyIncome = vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  let monthlyOutflow = 0;
  const discretionary = [];
  const bud = await readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A:Z`, 'UNFORMATTED_VALUE').catch(() => []);
  if (bud.length > 1) {
    const tc = colIdx(bud[0], 'type');
    const ac = colIdx(bud[0], 'allowance', 'monthly');
    const gc = colIdx(bud[0], 'expense', 'group', 'category');
    for (const r of bud.slice(1)) {
      const allow = toNum(r[ac >= 0 ? ac : 0]);
      if (!allow) continue;
      monthlyOutflow += allow;
      if (String(r[gc] ?? '').toLowerCase().includes('discretion')) {
        discretionary.push({ category: String(r[tc >= 0 ? tc : 0] || '').trim(), allowance: allow });
      }
    }
  }
  return { monthlyIncome: round2(monthlyIncome), monthlyOutflow: round2(monthlyOutflow), discretionary };
}

// Business: average monthly revenue (Business Transactions) vs spend (Business Expenses).
export async function deriveBusinessCashflow(token) {
  const avgByMonth = (rows, dateCol, amtCol) => {
    const m = {};
    for (const r of rows.slice(1)) {
      const k = monthKey(r[dateCol]);
      if (!k) continue;
      m[k] = (m[k] || 0) + toNum(r[amtCol]);
    }
    const v = Object.values(m);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const tx = await readRange(token, `${BUSINESS_TRANSACTIONS_SHEET}!A:H`, 'UNFORMATTED_VALUE').catch(() => []);
  const ex = await readRange(token, `${SHEETS.BUSINESS_EXPENSES}!A:G`, 'UNFORMATTED_VALUE').catch(() => []);
  const monthlyIncome  = tx.length > 1 ? avgByMonth(tx, 0, 5) : 0; // Revenue = col F
  const monthlyOutflow = ex.length > 1 ? avgByMonth(ex, 0, 2) : 0; // Amount = col C
  return { monthlyIncome: round2(monthlyIncome), monthlyOutflow: round2(monthlyOutflow), discretionary: [] };
}

// ── Full visual overview ─────────────────────────────────────────────────────
// Returns a structured object the chat renders as an overview "window". focus:
// 'all' (default) | 'personal' | 'business'.
export async function computeOverview(token, focus = 'all') {
  const wantPersonal = focus !== 'business';
  const wantBusiness = focus !== 'personal';
  const ov = { focus };

  if (wantPersonal) {
    const sum = await readRange(token, `${SHEETS.MONTHLY_SUMMARY}!A:Z`, 'UNFORMATTED_VALUE').catch(() => []);
    let avgIncome = 0, avgSpent = 0, curIncome = 0, curSpent = 0, monthLabel = '';
    if (sum.length > 1) {
      const ic = colIdx(sum[0], 'income');
      const sc = colIdx(sum[0], 'spent', 'spend');
      const rows = sum.slice(1).filter(r => toNum(r[ic >= 0 ? ic : 1]) > 0 || toNum(r[sc >= 0 ? sc : 2]) > 0);
      const recent = rows.slice(-6);
      if (recent.length) {
        avgIncome = round2(recent.reduce((a, r) => a + toNum(r[ic >= 0 ? ic : 1]), 0) / recent.length);
        avgSpent  = round2(recent.reduce((a, r) => a + toNum(r[sc >= 0 ? sc : 2]), 0) / recent.length);
        const last = recent[recent.length - 1];
        curIncome = round2(toNum(last[ic >= 0 ? ic : 1]));
        curSpent  = round2(toNum(last[sc >= 0 ? sc : 2]));
        monthLabel = String(last[0] || '');
      }
    }

    const bud = await readRange(token, `${SHEETS.MONTHLY_EXPENSES}!A:Z`, 'UNFORMATTED_VALUE').catch(() => []);
    let allowanceTotal = 0;
    const groups = {};
    const cats = [];
    if (bud.length > 1) {
      const tc = colIdx(bud[0], 'type');
      const ac = colIdx(bud[0], 'allowance', 'monthly');
      const gc = colIdx(bud[0], 'expense', 'group', 'category');
      for (const r of bud.slice(1)) {
        const allow = toNum(r[ac >= 0 ? ac : 0]);
        if (!allow) continue;
        allowanceTotal += allow;
        const g = (String(r[gc] ?? '').trim() || 'Other');
        groups[g] = (groups[g] || 0) + allow;
        cats.push({ category: String(r[tc >= 0 ? tc : 0] || '').trim(), amount: allow });
      }
    }
    cats.sort((a, b) => b.amount - a.amount);

    const subs = await readRange(token, `${SUBSCRIPTIONS_SHEET}!A:E`, 'UNFORMATTED_VALUE').catch(() => []);
    let subMonthly = 0, subCount = 0;
    if (subs.length > 1) {
      const cc = colIdx(subs[0], 'cost', 'amount', 'price');
      const yc = colIdx(subs[0], 'cycle', 'frequency');
      for (const r of subs.slice(1)) {
        const cost = toNum(r[cc >= 0 ? cc : 1]);
        if (!cost) continue;
        subCount++;
        subMonthly += monthlyFromCycle(cost, r[yc >= 0 ? yc : 2]);
      }
    }

    ov.personal = {
      monthLabel,
      currentIncome: curIncome,
      currentSpent: curSpent,
      avgIncome,
      avgSpent,
      net: round2(avgIncome - avgSpent),
      savingsRate: avgIncome > 0 ? round2(((avgIncome - avgSpent) / avgIncome) * 100) : 0,
      allowanceTotal: round2(allowanceTotal),
      freeCashFlow: round2(avgIncome - allowanceTotal),
      groups: Object.entries(groups).map(([name, amount]) => ({ name, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount),
      topCategories: cats.slice(0, 6).map(c => ({ category: c.category, amount: round2(c.amount) })),
      subscriptionsMonthly: round2(subMonthly),
      subscriptionCount: subCount,
    };
  }

  if (wantBusiness) {
    const tx = await readRange(token, `${BUSINESS_TRANSACTIONS_SHEET}!A:H`, 'UNFORMATTED_VALUE').catch(() => []);
    const ex = await readRange(token, `${SHEETS.BUSINESS_EXPENSES}!A:G`, 'UNFORMATTED_VALUE').catch(() => []);

    const revByMonth = {}, expByMonth = {}, vendorTotals = {};
    let totalRev = 0, txCount = 0;
    if (tx.length > 1) {
      for (const r of tx.slice(1)) {
        const rev = toNum(r[5]);
        if (rev) { txCount++; totalRev += rev; }
        const m = monthKey(r[0]);
        if (m) revByMonth[m] = (revByMonth[m] || 0) + rev;
      }
    }
    let totalExp = 0;
    if (ex.length > 1) {
      const vc = colIdx(ex[0], 'vendor');
      const amc = colIdx(ex[0], 'amount');
      for (const r of ex.slice(1)) {
        const amt = toNum(r[amc >= 0 ? amc : 2]);
        if (!amt) continue;
        totalExp += amt;
        const m = monthKey(r[0]);
        if (m) expByMonth[m] = (expByMonth[m] || 0) + amt;
        const v = (String(r[vc >= 0 ? vc : 1] ?? '').trim() || 'Other');
        vendorTotals[v] = (vendorTotals[v] || 0) + amt;
      }
    }

    const revMonths = Object.keys(revByMonth).length || 1;
    const expMonths = Object.keys(expByMonth).length || 1;
    const allMonths = [...new Set([...Object.keys(revByMonth), ...Object.keys(expByMonth)])].sort();
    const series = allMonths.slice(-6).map(m => ({
      month: m,
      revenue: round2(revByMonth[m] || 0),
      expense: round2(expByMonth[m] || 0),
      net: round2((revByMonth[m] || 0) - (expByMonth[m] || 0)),
    }));

    ov.business = {
      totalRevenue: round2(totalRev),
      totalExpense: round2(totalExp),
      net: round2(totalRev - totalExp),
      margin: totalRev > 0 ? round2(((totalRev - totalExp) / totalRev) * 100) : 0,
      avgMonthlyRevenue: round2(totalRev / revMonths),
      avgMonthlyExpense: round2(totalExp / expMonths),
      transactionCount: txCount,
      hasData: txCount > 0 || totalExp > 0,
      series,
      topVendors: Object.entries(vendorTotals).map(([name, amount]) => ({ name, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount).slice(0, 5),
    };
  }

  return ov;
}

// Parse raw Plans-sheet rows into goal objects for the visual Goals panel.
// Tolerates cleared (deleted) rows by dropping any with no name/id.
export function parsePlans(rows) {
  if (!rows || rows.length < 2) return [];
  const [headers, ...data] = rows;
  const iId     = colIdx(headers, 'id');
  const iName   = colIdx(headers, 'name');
  const iScope  = colIdx(headers, 'scope');
  const iTarget = colIdx(headers, 'target');
  const iSaved  = colIdx(headers, 'saved');
  const iPer    = colIdx(headers, 'per month', 'per');
  const iDate   = colIdx(headers, 'target date', 'date');
  const iStatus = colIdx(headers, 'status');
  const iNotes  = colIdx(headers, 'notes');

  return data
    .filter(r => r && (String(r[iName] ?? '').trim() || String(r[iId] ?? '').trim()))
    .map(r => {
      const target = toNum(r[iTarget >= 0 ? iTarget : 3]);
      const saved  = toNum(r[iSaved  >= 0 ? iSaved  : 4]);
      return {
        id:         String(r[iId] ?? ''),
        name:       String(r[iName] ?? 'Goal').trim() || 'Goal',
        scope:      String(r[iScope] ?? 'personal').toLowerCase().includes('bus') ? 'business' : 'personal',
        target, saved,
        remaining:  round2(Math.max(0, target - saved)),
        perMonth:   toNum(r[iPer >= 0 ? iPer : 5]),
        targetDate: (() => {
          const raw = String(r[iDate] ?? '').trim();
          if (/^\d+$/.test(raw)) {
            const n = parseInt(raw, 10);
            if (n > 10000) {
              return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
            }
          }
          return raw;
        })(),
        status:     String(r[iStatus] ?? 'active').toLowerCase().trim() || 'active',
        notes:      String(r[iNotes] ?? '').trim(),
        progress:   target > 0 ? round2((saved / target) * 100) : 0,
      };
    });
}

// One-line summaries for the model (cards carry the full detail to the UI, so the
// model gets a compact recap and stays token-cheap).
export function overviewSummary(ov) {
  const parts = [];
  if (ov.personal) {
    const p = ov.personal;
    parts.push(`Personal — avg income $${p.avgIncome}/mo, avg spend $${p.avgSpent}/mo, net $${p.net}, savings rate ${p.savingsRate}%, free cash flow $${p.freeCashFlow}/mo, subscriptions $${p.subscriptionsMonthly}/mo across ${p.subscriptionCount}.`);
  }
  if (ov.business) {
    const b = ov.business;
    parts.push(b.hasData
      ? `Business — avg revenue $${b.avgMonthlyRevenue}/mo, avg expense $${b.avgMonthlyExpense}/mo, lifetime net $${b.net} on ${b.margin}% margin.`
      : 'Business — no sales or expenses logged yet.');
  }
  return `Overview rendered as a visual window. ${parts.join(' ')}`;
}
