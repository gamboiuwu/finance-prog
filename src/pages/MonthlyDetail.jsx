import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { readRangeFrom } from '../lib/sheets';
import LoadingSpinner from '../components/LoadingSpinner';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const CATEGORY_COLORS = {
  Payroll:    '#3b82f6',
  Stickers:   '#a855f7',
  DevEx:      '#f59e0b',
  Transfer:   '#64748b',
  Commission: '#10b981',
  Other:      '#6366f1',
};

function colorFor(cat) {
  if (!cat) return CATEGORY_COLORS.Other;
  for (const [key, val] of Object.entries(CATEGORY_COLORS)) {
    if (cat.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return CATEGORY_COLORS.Other;
}

function parseMoney(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(/[$,\s]/g, '')) || 0;
}

function fmt(n) {
  if (isNaN(n) || n === null) return '—';
  return `$${Math.abs(n).toFixed(2)}`;
}

function StatCard({ label, value, color = 'text-white', sub }) {
  return (
    <div className="bg-slate-800 rounded-2xl p-4 flex flex-col gap-1">
      <span className="text-slate-400 text-xs uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-slate-500 text-xs">{sub}</span>}
    </div>
  );
}

export default function MonthlyDetail({ token }) {
  const { sheetId, month } = useParams();
  const navigate = useNavigate();
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token || !sheetId) return;
    setLoading(true);

    // Read wide range to capture both transaction table and summary panel
    readRangeFrom(token, sheetId, 'A1:Z50')
      .then(rows => {
        if (!rows.length) return;

        const [headers, ...data] = rows;

        // Transaction rows: have a date in column A
        const txns = data
          .filter(r => r[0] && /^\d/.test(r[0]))
          .map(r => ({
            date:       r[0]  || '',
            source:     r[3]  || '',
            category:   r[4]  || '',
            gross:      parseMoney(r[5]),
            hours:      parseFloat(r[6]) || null,
            deductions: parseMoney(r[7]),
            net:        parseMoney(r[8]),
            expProcessed: r[11] === 'TRUE',
            commDone:   r[12] === 'TRUE',
            status:     r[13] || '',
            notes:      r[14] || '',
          }));

        setTransactions(txns);

        // Summary panel: scan all rows for label-value pairs in columns P-Q (indexes 15-17)
        const s = {};
        data.forEach(r => {
          const label = r[16] || r[15];
          const value = r[17] || r[16];
          if (label && value && typeof label === 'string' && label.trim()) {
            const clean = label.trim().replace(/\s+/g, ' ');
            s[clean] = value;
          }
        });
        setSummary(s);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token, sheetId]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;

  // Category breakdown for chart
  const byCategory = transactions.reduce((acc, t) => {
    const cat = t.category || 'Other';
    acc[cat] = (acc[cat] || 0) + t.net;
    return acc;
  }, {});
  const chartData = Object.entries(byCategory)
    .filter(([, v]) => v > 0)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);

  const netTotal      = parseMoney(summary['Net Total']       || summary['Net Total ']);
  const processedTotal= parseMoney(summary['Processed Total'] || summary['Processed Total ']);
  const earningPerHr  = parseMoney(summary['Adjusted Earning/hr']);
  const minimum       = parseMoney(summary['Minimum']         || summary['Minimum ']);

  const totalEarned   = transactions.reduce((s, t) => s + t.net, 0);
  const goalMet       = minimum > 0 && (netTotal || totalEarned) >= minimum;

  return (
    <div className="p-4 pb-24 space-y-5">
      {/* Back button + title */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 hover:bg-slate-700"
        >
          ←
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">{month || 'Monthly Report'}</h1>
          <p className="text-slate-400 text-sm">Income breakdown</p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Net Total"
          value={fmt(netTotal || totalEarned)}
          color="text-emerald-400"
        />
        <StatCard
          label="Processed"
          value={fmt(processedTotal || totalEarned)}
          color="text-blue-400"
        />
        {earningPerHr > 0 && (
          <StatCard
            label="Avg $/hr"
            value={fmt(earningPerHr)}
            color="text-purple-400"
          />
        )}
        {minimum > 0 && (
          <StatCard
            label="Monthly Goal"
            value={fmt(minimum)}
            color={goalMet ? 'text-emerald-400' : 'text-amber-400'}
            sub={goalMet ? '✓ Met' : 'Not yet met'}
          />
        )}
      </div>

      {/* Goal progress bar */}
      {minimum > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-slate-300 font-medium">Goal Progress</span>
            <span className="text-slate-400">{fmt(netTotal || totalEarned)} / {fmt(minimum)}</span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-3 overflow-hidden">
            <div
              className="h-3 rounded-full transition-all duration-700"
              style={{
                width: `${Math.min(((netTotal || totalEarned) / minimum) * 100, 100)}%`,
                background: goalMet ? '#10b981' : '#f59e0b',
              }}
            />
          </div>
        </div>
      )}

      {/* Category breakdown chart */}
      {chartData.length > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4">
          <p className="text-slate-300 font-medium text-sm mb-4">Income by Source</p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} layout="vertical" barCategoryGap="25%">
              <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
              <YAxis type="category" dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
                formatter={v => [`$${v.toFixed(2)}`]}
              />
              <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={colorFor(entry.name)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Transaction list */}
      <div>
        <p className="text-slate-300 font-medium text-sm mb-3">Transactions ({transactions.length})</p>
        <div className="space-y-2">
          {transactions.map((t, i) => (
            <div key={i} className="bg-slate-800 rounded-xl p-3 flex items-start gap-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                style={{ background: colorFor(t.category) + '33', color: colorFor(t.category) }}
              >
                {(t.category || '?')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-start gap-2">
                  <div>
                    <p className="text-white text-sm font-medium">{t.source}</p>
                    <div className="flex gap-2 mt-0.5 flex-wrap items-center">
                      <span className="text-slate-500 text-xs">{t.date}</span>
                      {t.category && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium"
                          style={{ background: colorFor(t.category) + '22', color: colorFor(t.category) }}
                        >
                          {t.category}
                        </span>
                      )}
                      {t.hours > 0 && <span className="text-slate-500 text-xs">{t.hours}h</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-emerald-400 text-sm font-bold">{fmt(t.net)}</p>
                    {t.gross > 0 && t.gross !== t.net && (
                      <p className="text-slate-500 text-xs">gross {fmt(t.gross)}</p>
                    )}
                  </div>
                </div>
                {t.deductions > 0 && (
                  <p className="text-slate-500 text-xs mt-1">Tax/deductions: -{fmt(t.deductions)}</p>
                )}
                {(t.status || t.notes) && (
                  <p className="text-slate-400 text-xs mt-1 italic">{t.status || t.notes}</p>
                )}
                <div className="flex gap-3 mt-1.5">
                  {t.expProcessed && <span className="text-xs text-blue-400">✓ Processed</span>}
                  {t.commDone && <span className="text-xs text-purple-400">✓ Commission done</span>}
                </div>
              </div>
            </div>
          ))}
          {transactions.length === 0 && (
            <p className="text-slate-500 text-center py-8">No transactions found</p>
          )}
        </div>
      </div>
    </div>
  );
}
