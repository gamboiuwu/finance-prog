import { useState } from 'react';
import { GOOGLE_CLIENT_ID } from '../config';
import { requestAccessToken } from '../lib/auth';

export default function Login({ onLogin }) {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const missingClientId = !GOOGLE_CLIENT_ID;

  function handleSignIn() {
    setError(null);
    setLoading(true);
    requestAccessToken((token, err) => {
      setLoading(false);
      if (err) {
        setError(`Sign-in failed: ${err}`);
      } else {
        onLogin(token);
      }
    });
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 gap-6">
      <div className="text-center space-y-2">
        <div className="text-5xl mb-4">💰</div>
        <h1 className="text-3xl font-bold text-white">Finance Tracker</h1>
        <p className="text-slate-400 text-sm">Connected to your Google Sheet</p>
      </div>

      {missingClientId ? (
        <div className="bg-amber-900/30 border border-amber-700/50 rounded-2xl p-5 max-w-sm w-full space-y-3">
          <p className="text-amber-300 font-medium text-sm">Setup Required</p>
          <p className="text-slate-300 text-sm">
            Add your Google OAuth2 Client ID as <code className="bg-slate-800 px-1.5 py-0.5 rounded text-blue-300">VITE_GOOGLE_CLIENT_ID</code> in a <code className="bg-slate-800 px-1.5 py-0.5 rounded text-blue-300">.env</code> file.
          </p>
          <p className="text-slate-400 text-xs">See <strong>SETUP.md</strong> for instructions.</p>
        </div>
      ) : (
        <div className="space-y-4 w-full max-w-xs">
          <button
            onClick={handleSignIn}
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold py-3.5 rounded-2xl flex items-center justify-center gap-3 transition-colors"
          >
            {loading ? (
              <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Sign in with Google
              </>
            )}
          </button>

          {error && (
            <p className="text-rose-400 text-sm text-center">{error}</p>
          )}
        </div>
      )}

      <p className="text-slate-600 text-xs text-center max-w-xs">
        Requests access to your Google Sheets to read and update your finance spreadsheet.
      </p>
    </div>
  );
}
