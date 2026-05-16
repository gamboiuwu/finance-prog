import { useState } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { getStoredToken, clearToken } from './lib/auth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Budget from './pages/Budget';
import Transactions from './pages/Transactions';
import Commissions from './pages/Commissions';
import MonthlyDetail from './pages/MonthlyDetail';
import Summary from './pages/Summary';
import GasPrices from './pages/GasPrices';
import Nav from './components/Nav';

export default function App() {
  const [token, setToken] = useState(() => getStoredToken());

  if (!token) return <Login onLogin={setToken} />;

  return (
    <HashRouter>
      <div className="min-h-screen bg-slate-950 text-white">
        <header className="sticky top-0 z-30 bg-slate-950/90 backdrop-blur border-b border-slate-800 px-4 py-3 flex justify-between items-center">
          <span className="font-bold text-white text-sm">💰 Finance</span>
          <button
            onClick={() => { clearToken(); setToken(null); }}
            className="text-slate-400 hover:text-white text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
          >
            Sign out
          </button>
        </header>

        <main className="max-w-lg mx-auto md:max-w-none md:px-8 lg:px-16">
          <Routes>
            <Route path="/"                      element={<Dashboard     token={token} />} />
            <Route path="/budget"                element={<Budget        token={token} />} />
            <Route path="/summary"               element={<Summary       token={token} />} />
            <Route path="/transactions"          element={<Transactions  token={token} />} />
            <Route path="/commissions"           element={<Commissions   token={token} />} />
            <Route path="/gas"                   element={<GasPrices />} />
            <Route path="/month/:sheetId/:month" element={<MonthlyDetail token={token} />} />
          </Routes>
        </main>

        <Nav />
      </div>
    </HashRouter>
  );
}
