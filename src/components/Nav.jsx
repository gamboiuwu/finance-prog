import { NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';

// SVG icon set — no emoji, consistent stroke weight, scales cleanly at any DPI.
const icons = {
  home: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M3 9.5L10 3l7 6.5" /><path d="M5 8.5V17h4v-4h2v4h4V8.5" />
    </svg>
  ),
  budget: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <rect x="2" y="4" width="16" height="13" rx="2" /><path d="M2 8h16" /><path d="M6 12h2M10 12h4" />
    </svg>
  ),
  summary: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M4 14l4-4 3 3 5-6" /><circle cx="16" cy="7" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  log: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <rect x="4" y="3" width="12" height="14" rx="2" /><path d="M7 7h6M7 10h6M7 13h4" />
    </svg>
  ),
  art: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M3 14c0-4 2-7 7-7s7 3 7 7" /><path d="M7 14c0-1.7.8-3 3-3s3 1.3 3 3" /><circle cx="10" cy="14.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  biz: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <rect x="2" y="8" width="16" height="9" rx="1.5" /><path d="M7 8V6a3 3 0 016 0v2" /><path d="M10 12v2" />
    </svg>
  ),
  ledger: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M10 3c-1.5 0-4 1-4 4 0 1.5.5 2.5 1 3l-1 3 1.5-.5c.5.3 1.5.5 2.5.5s2-.2 2.5-.5l1.5.5-1-3c.5-.5 1-1.5 1-3 0-3-2.5-4-4-4z" />
      <path d="M8 9.5c0 .5.8 1 2 1s2-.5 2-1" />
    </svg>
  ),
  goals: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.5" /><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M3.5 10A6.5 6.5 0 1010 3.5H7" /><path d="M7 3.5L5 5.5l2 2" /><path d="M10 6.5V10l2.5 2.5" />
    </svg>
  ),
};

const tabs = [
  { to: '/',             label: 'Home',    iconKey: 'home'    },
  { to: '/budget',       label: 'Budget',  iconKey: 'budget'  },
  { to: '/summary',      label: 'Summary', iconKey: 'summary' },
  { to: '/transactions', label: 'Log',     iconKey: 'log'     },
  { to: '/commissions',  label: 'Art',     iconKey: 'art'     },
  { to: '/business',     label: 'Biz',     iconKey: 'biz'     },
  { to: '/dragon',       label: 'Ledger',  iconKey: 'ledger'  },
  { to: '/goals',        label: 'Goals',   iconKey: 'goals'   },
  { to: '/actions',      label: 'History', iconKey: 'history' },
];

function readBudgetBadge() {
  try {
    const stored = JSON.parse(localStorage.getItem('_fin_budget_alert') || '{}');
    const now = new Date();
    if (stored.month === `${now.getFullYear()}-${now.getMonth() + 1}`) return stored.count || 0;
  } catch {}
  return 0;
}

// Outstanding-commission count for the ✦ Art nav badge (Task 12). Not month-scoped —
// just a cached integer written by Commissions.jsx on load (no financial data on device).
function readArtBadge() {
  try {
    const stored = JSON.parse(localStorage.getItem('_fin_art_outstanding') || '{}');
    return stored.count || 0;
  } catch {}
  return 0;
}

export default function Nav() {
  const [budgetBadge, setBudgetBadge] = useState(readBudgetBadge);
  const [artBadge, setArtBadge] = useState(readArtBadge);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setBudgetBadge(readBudgetBadge());
      setArtBadge(readArtBadge());
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('_fin_budget_alert_update', refresh);
    window.addEventListener('_fin_art_outstanding_update', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('_fin_budget_alert_update', refresh);
      window.removeEventListener('_fin_art_outstanding_update', refresh);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const handler = () => {
      // If visual viewport height is significantly less than window height, keyboard is open
      setKeyboardOpen(vv.height < window.innerHeight * 0.75);
    };
    vv.addEventListener('resize', handler);
    return () => vv.removeEventListener('resize', handler);
  }, []);

  return (
    <nav className={`fixed bottom-0 inset-x-0 bg-slate-900/95 backdrop-blur border-t border-slate-800 z-40 safe-area-pb ${keyboardOpen ? 'translate-y-full' : ''} transition-transform duration-200`}>
      {/* Scrollable on very small screens; centered pill layout on desktop */}
      <div className="flex overflow-x-auto scrollbar-none sm:justify-center max-w-screen-xl mx-auto sm:px-2">
        {tabs.map(({ to, label, iconKey }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `relative shrink-0 flex flex-col items-center px-3 sm:px-4 pt-2 pb-2 gap-0.5 transition-all duration-200 group min-w-[52px] sm:min-w-[62px] ${
                isActive ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {/* Animated top-bar indicator */}
                <span
                  className={`absolute top-0 left-1/2 -translate-x-1/2 h-[2px] rounded-b-full bg-blue-400 transition-all duration-300 ease-out ${
                    isActive ? 'w-8 opacity-100' : 'w-0 opacity-0'
                  }`}
                />
                {/* Icon with badge */}
                <span className="relative flex items-center justify-center">
                  <span
                    className={`transition-all duration-200 ease-out ${
                      isActive
                        ? 'scale-115 drop-shadow-[0_0_6px_rgba(96,165,250,0.5)]'
                        : 'group-hover:scale-110'
                    }`}
                  >
                    {icons[iconKey]}
                  </span>
                  {to === '/budget' && budgetBadge > 0 && (
                    <span className="absolute -top-1 -right-2 min-w-[14px] h-3.5 rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 leading-none">
                      {budgetBadge > 9 ? '9+' : budgetBadge}
                    </span>
                  )}
                  {to === '/commissions' && artBadge > 0 && (
                    <span className="absolute -top-1 -right-2 min-w-[14px] h-3.5 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 leading-none">
                      {artBadge > 9 ? '9+' : artBadge}
                    </span>
                  )}
                </span>
                {/* Label */}
                <span
                  className={`text-[9px] sm:text-[10px] font-semibold leading-none tracking-wide transition-all duration-200 ${
                    isActive ? 'text-blue-400 opacity-100' : 'opacity-70'
                  }`}
                >
                  {label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
