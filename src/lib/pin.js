const PIN_HASH_KEY    = 'fpin_hash';
const UNLOCK_KEY      = 'fpin_unlock';
const ATTEMPTS_KEY    = 'fpin_attempts';
const SALT            = 'finance-tracker-pin-v1';
const LOCK_AFTER_MS   = 10 * 60 * 1000; // 10 min idle
export const MAX_ATTEMPTS = 5;

export function isPinSet() {
  return !!localStorage.getItem(PIN_HASH_KEY);
}

export async function hashPin(pin) {
  const data = new TextEncoder().encode(pin + SALT);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function storePin(pin) {
  localStorage.setItem(PIN_HASH_KEY, await hashPin(pin));
  markUnlocked();
}

export async function verifyPin(pin) {
  const stored = localStorage.getItem(PIN_HASH_KEY);
  if (!stored) return false;
  return (await hashPin(pin)) === stored;
}

export function clearPin() {
  localStorage.removeItem(PIN_HASH_KEY);
  localStorage.removeItem(UNLOCK_KEY);
  localStorage.removeItem(ATTEMPTS_KEY);
}

export function markUnlocked() {
  localStorage.setItem(UNLOCK_KEY, String(Date.now()));
  localStorage.removeItem(ATTEMPTS_KEY);
}

export function isSessionLocked() {
  if (!isPinSet()) return false;
  const last = parseInt(localStorage.getItem(UNLOCK_KEY) || '0', 10);
  return Date.now() - last > LOCK_AFTER_MS;
}

export function getFailedAttempts() {
  return parseInt(localStorage.getItem(ATTEMPTS_KEY) || '0', 10);
}

export function recordFailedAttempt() {
  const n = getFailedAttempts() + 1;
  localStorage.setItem(ATTEMPTS_KEY, String(n));
  return n;
}
