import { useState, useEffect, useCallback } from 'react';
import { HashRouter, Routes, Route, useLocation } from 'react-router-dom';
import { getStoredToken, clearToken } from './lib/auth';
import { isPinSet, isSessionLocked, markUnlocked, clearPin } from './lib/pin';
import Login from './pages/Login';
import PinGate from './components/PinGate';
import Dashboard from './pages/Dashboard';
import Budget from './pages/Budget';
import Transactions from './pages/Transactions';
import Commissions from './pages/Commissions';
import MonthlyDetail from './pages/MonthlyDetail';
import Summary from './pages/Summary';
import GasPrices from './pages/GasPrices';
import BusinessExpenses from './pages/BusinessExpenses';
import Actions from './pages/Actions';
import DragonBot from './pages/DragonBot';
import DataRepair from './components/DataRepair';
import Nav from './components/Nav';

function AnimatedRoutes({ token }) {
  const location = useLocation();
  return (
    <main key={location.pathname} className="page-enter max-w-lg mx-auto md:max-w-none md:px-8 lg:px-16">
      <Routes>
        <Route path="/"                      element={<Dashboard        token={token} />} />
        <Route path="/budget"                element={<Budget           token={token} />} />
        <Route path="/summary"               element={<Summary          token={token} />} />
        <Route path="/transactions"          element={<Transactions     token={token} />} />
        <Route path="/commissions"           element={<Commissions      token={token} />} />
        <Route path="/gas"                   element={<GasPrices />} />
        <Route path="/business"              element={<BusinessExpenses token={token} />} />
        <Route path="/actions"              element={<Actions           token={token} />} />
        <Route path="/dragon"                element={<DragonBot         token={token} />} />
        <Route path="/month/:sheetId/:month" element={<MonthlyDetail    token={token} />} />
      </Routes>
    </main>
  );
}

export default function App() {
  const [token, setToken]           = useState(() => getStoredToken());
  const [pinUnlocked, setPinUnlocked] = useState(() => isPinSet() && !isSessionLocked());
  const [showChangePinMenu, setShowChangePinMenu] = useState(false);

  // Re-check lock whenever the tab becomes visible again
  useEffect(() => {
    function onVisible() {
      if (!document.hidden && isPinSet() && isSessionLocked()) {
        setPinUnlocked(false);
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Refresh unlock timestamp on user activity so the idle timer resets
  const refreshActivity = useCallback(() => {
    if (pinUnlocked && isPinSet()) markUnlocked();
  }, [pinUnlocked]);

  function handleSignOut() {
    clearToken();
    clearPin();
    setToken(null);
    setPinUnlocked(false);
  }

  function handlePinUnlocked() {
    markUnlocked();
    setPinUnlocked(true);
  }

  function handleRemovePin() {
    clearPin();
    setShowChangePinMenu(false);
    setPinUnlocked(true);
  }

  // 1. No Google token → show login
  if (!token) return <Login onLogin={setToken} />;

  // 2. PIN not set yet, or session is locked → show PIN gate
  const needsPin = !isPinSet() || !pinUnlocked;
  if (needsPin) {
    return (
      <PinGate
        mode={!isPinSet() ? 'create' : 'verify'}
        onUnlock={handlePinUnlocked}
        onSignOut={handleSignOut}
      />
    );
  }

  // 3. Fully authenticated → show app
  return (
    <HashRouter>
      <div
        className="min-h-screen bg-slate-950 text-white"
        onPointerDown={refreshActivity}
        onKeyDown={refreshActivity}
      >
        <header className="sticky top-0 z-30 bg-slate-950/90 backdrop-blur border-b border-slate-800 px-4 py-3 flex justify-between items-center">
          <span className="font-bold text-white text-sm font-broske tracking-wide">💰 Finance</span>
          <div className="flex items-center gap-2 relative">
            {/* PIN / lock menu */}
            <button
              onClick={() => setShowChangePinMenu(v => !v)}
              title="PIN settings"
              className="text-slate-400 hover:text-white text-sm px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
            >
              🔒
            </button>
            {showChangePinMenu && (
              <div className="menu-enter absolute right-0 top-full mt-2 bg-slate-800 border border-slate-700 rounded-xl shadow-xl z-50 w-44 py-1 text-sm">
                <button
                  onClick={() => { setPinUnlocked(false); setShowChangePinMenu(false); clearPin(); }}
                  className="w-full text-left px-4 py-2.5 text-slate-200 hover:bg-slate-700 transition-colors"
                >
                  Change PIN
                </button>
                <button
                  onClick={handleRemovePin}
                  className="w-full text-left px-4 py-2.5 text-rose-400 hover:bg-slate-700 transition-colors"
                >
                  Remove PIN
                </button>
                <button
                  onClick={() => { setPinUnlocked(false); setShowChangePinMenu(false); }}
                  className="w-full text-left px-4 py-2.5 text-slate-400 hover:bg-slate-700 transition-colors border-t border-slate-700"
                >
                  Lock now
                </button>
              </div>
            )}

            <button
              onClick={handleSignOut}
              className="text-slate-400 hover:text-white text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
            >
              Sign out
            </button>
          </div>
        </header>

        <AnimatedRoutes token={token} />

        <DataRepair token={token} />

        <Nav />
      </div>
    </HashRouter>
  );
}
