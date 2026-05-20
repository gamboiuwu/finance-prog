import { useState, useEffect, useRef } from 'react';
import { storePin, verifyPin, recordFailedAttempt, getFailedAttempts, MAX_ATTEMPTS } from '../lib/pin';

const KEYS = [['1','2','3'],['4','5','6'],['7','8','9'],['','0','⌫']];

function PinDots({ len, total = 4, error }) {
  return (
    <div className="flex gap-4 justify-center my-6">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`w-4 h-4 rounded-full border-2 transition-all duration-150 ${
            error
              ? 'border-rose-500 bg-rose-500'
              : i < len
                ? 'border-blue-400 bg-blue-400'
                : 'border-slate-600 bg-transparent'
          }`}
        />
      ))}
    </div>
  );
}

export default function PinGate({ mode, onUnlock, onSignOut }) {
  const [pin, setPin]         = useState('');
  const [confirm, setConfirm] = useState('');
  const [step, setStep]       = useState('enter'); // 'enter' | 'confirm'
  const [error, setError]     = useState('');
  const [busy, setBusy]       = useState(false);

  const isCreate  = mode === 'create';
  const active    = step === 'confirm' ? confirm : pin;
  const remaining = MAX_ATTEMPTS - getFailedAttempts();

  function press(key) {
    if (busy) return;
    setError('');
    if (key === '⌫') {
      if (step === 'confirm') setConfirm(c => c.slice(0, -1));
      else setPin(p => p.slice(0, -1));
      return;
    }
    if (active.length >= 4) return;
    const next = active + key;
    if (step === 'confirm') {
      setConfirm(next);
      if (next.length === 4) submit(pin, next);
    } else {
      setPin(next);
      if (next.length === 4) {
        if (isCreate) { setStep('confirm'); }
        else          { submit(next, null); }
      }
    }
  }

  async function submit(entered, confirmVal) {
    setBusy(true);
    try {
      if (isCreate) {
        if (entered !== confirmVal) {
          setError('PINs don\'t match — try again');
          setPin('');
          setConfirm('');
          setStep('enter');
          return;
        }
        await storePin(entered);
        onUnlock();
      } else {
        const ok = await verifyPin(entered);
        if (ok) {
          onUnlock();
        } else {
          const attempts = recordFailedAttempt();
          setPin('');
          if (attempts >= MAX_ATTEMPTS) {
            onSignOut();
          } else {
            setError(`Wrong PIN — ${MAX_ATTEMPTS - attempts} attempt${MAX_ATTEMPTS - attempts === 1 ? '' : 's'} left`);
          }
        }
      }
    } finally {
      setBusy(false);
    }
  }

  // Keep a ref to press so the stable keydown listener always calls the latest version
  const pressRef = useRef(press);
  useEffect(() => { pressRef.current = press; });
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) pressRef.current(e.key);
      else if (e.key === 'Backspace') pressRef.current('⌫');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const dots = step === 'confirm' ? confirm.length : pin.length;

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-8 select-none">
      <div className="text-5xl mb-2">🔒</div>
      <h1 className="text-white font-bold text-xl mt-2">
        {isCreate
          ? step === 'confirm' ? 'Confirm PIN' : 'Create PIN'
          : 'Enter PIN'}
      </h1>
      <p className="text-slate-400 text-sm mt-1 text-center">
        {isCreate
          ? step === 'confirm'
            ? 'Re-enter your 4-digit PIN to confirm'
            : 'Choose a 4-digit PIN to protect your data'
          : 'Enter your PIN to access Finance'}
      </p>

      <PinDots len={dots} error={!!error} />

      {error && (
        <p className="text-rose-400 text-sm text-center mb-4 -mt-2">{error}</p>
      )}

      {/* Keypad */}
      <div className="grid grid-rows-4 gap-3 w-full max-w-xs mt-2">
        {KEYS.map((row, ri) => (
          <div key={ri} className="grid grid-cols-3 gap-3">
            {row.map((key, ki) => (
              key === '' ? (
                <div key={ki} />
              ) : (
                <button
                  key={ki}
                  onClick={() => press(key)}
                  disabled={busy}
                  className={`h-16 rounded-2xl text-xl font-semibold transition-all active:scale-95 disabled:opacity-50 ${
                    key === '⌫'
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 text-2xl'
                      : 'bg-slate-800 hover:bg-slate-700 text-white'
                  }`}
                >
                  {key}
                </button>
              )
            ))}
          </div>
        ))}
      </div>

      {!isCreate && remaining < MAX_ATTEMPTS && (
        <p className="text-slate-500 text-xs mt-6">
          {remaining} attempt{remaining === 1 ? '' : 's'} remaining before sign-out
        </p>
      )}

      <button
        onClick={onSignOut}
        className="text-slate-600 hover:text-slate-400 text-xs mt-8 transition-colors"
      >
        Sign out / Switch account
      </button>
    </div>
  );
}
