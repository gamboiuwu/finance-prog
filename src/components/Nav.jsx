import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/',             label: 'Home',    icon: '⌂'  },
  { to: '/budget',       label: 'Budget',  icon: '◉'  },
  { to: '/summary',      label: 'Summary', icon: '📈' },
  { to: '/transactions', label: 'Log',     icon: '⇅'  },
  { to: '/commissions',  label: 'Art',     icon: '✦'  },
  { to: '/business',     label: 'Biz',     icon: '💼' },
  { to: '/actions',     label: 'History', icon: '↺'  },
];

export default function Nav() {
  return (
    <nav className="fixed bottom-0 inset-x-0 bg-slate-900/95 backdrop-blur border-t border-slate-800 z-40 safe-area-pb">
      <div className="flex">
        {tabs.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center py-2.5 gap-0.5 text-xs transition-colors ${
                isActive ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'
              }`
            }
          >
            <span className="text-base leading-none">{icon}</span>
            <span className="text-[10px]">{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
