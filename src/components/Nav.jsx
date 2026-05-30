import { NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';

const tabs = [
  { to: '/',             label: 'Home',    icon: '⌂'  },
  { to: '/budget',       label: 'Budget',  icon: '◉'  },
  { to: '/summary',      label: 'Summary', icon: '↗'  },
  { to: '/transactions', label: 'Log',     icon: '⇅'  },
  { to: '/commissions',  label: 'Art',     icon: '✦'  },
  { to: '/business',     label: 'Biz',     icon: '▦'  },
  { to: '/dragon',       label: 'Ledger',  icon: '🐉' },
  { to: '/goals',        label: 'Goals',   icon: '◎'  },
  { to: '/actions',      label: 'History', icon: '↺'  },
];

function readBudgetBadge() {
  try {
    const stored = JSON.parse(localStorage.getItem('_fin_budget_alert') || '{}');
    const now = new Date();
    if (stored.month === `${now.getFullYear()}-${now.getMonth() + 1}`) return stored.count || 0;
  } catch {}
  return 0;
}

export default function Nav() {
  const [budgetBadge, setBudgetBadge] = useState(readBudgetBadge);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const refresh = () => setBudgetBadge(readBudgetBadge());
    window.addEventListener('storage', refresh);
    window.addEventListener('_fin_budget_alert_update', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('_fin_budget_alert_update', refresh);
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
      <div className="flex">
        {tabs.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center py-2 gap-0 text-xs transition-all duration-150 ${
                isActive ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'
              }`
            }
          >
            <span className="nav-icon text-base leading-none relative">
              {icon}
              {to === '/budget' && budgetBadge > 0 && (
                <span className="absolute -top-1 -right-2 min-w-[14px] h-3.5 rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 leading-none">
                  {budgetBadge > 9 ? '9+' : budgetBadge}
                </span>
              )}
            </span>
            <span className="text-[10px] transition-colors duration-150">{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
