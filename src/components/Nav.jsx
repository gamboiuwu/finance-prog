import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/',             label: 'Dashboard',    icon: '◈' },
  { to: '/budget',       label: 'Budget',       icon: '◉' },
  { to: '/transactions', label: 'Transactions', icon: '⇅' },
  { to: '/commissions',  label: 'Commissions',  icon: '✦' },
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
              `flex-1 flex flex-col items-center py-3 gap-0.5 text-xs transition-colors ${
                isActive ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'
              }`
            }
          >
            <span className="text-lg leading-none">{icon}</span>
            <span>{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
