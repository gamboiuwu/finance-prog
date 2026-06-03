import { readRange, updateCell, ensureSheetTab } from './sheets';

const PIN_HASH_KEY    = 'fpin_hash';
const UNLOCK_KEY      = 'fpin_unlock';
const ATTEMPTS_KEY    = 'fpin_attempts';
const SALT            = 'finance-tracker-pin-v1';
const LOCK_AFTER_MS   = 10 * 60 * 1000; // 10 min idle
export const MAX_ATTEMPTS = 5;

// The shared PIN hash lives in the user's private (OAuth-gated) Google Sheet so the
// same PIN works on every device and survives a cache clear. localStorage is just a
// fast local cache that is seeded from — and written back to — this sheet.
const SETTINGS_TAB   = 'App Settings';
const PIN_LABEL_CELL = 'App Settings!A1';
const PIN_HASH_CELL  = 'App Settings!B1';

export function isPinSet() {
  return !!localStorage.getItem(PIN_HASH_KEY);
}

export async function hashPin(pin) {
  const data = new TextEncoder().encode(pin + SALT);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function storePin(pin, token) {
  const hash = await hashPin(pin);
  localStorage.setItem(PIN_HASH_KEY, hash);
  markUnlocked();
  // Persist to the shared sheet so the same PIN applies on every device. Keep the
  // local copy even if the write fails (offline / no access) — it syncs up later.
  if (token) { try { await writeRemotePinHash(token, hash); } catch { /* best effort */ } }
}

// Read the shared PIN hash from the sheet. Returns null if none is set yet (or the
// tab/cell is missing/unreadable), which the caller treats as "no shared PIN".
export async function fetchRemotePinHash(token) {
  if (!token) return null;
  try {
    const rows = await readRange(token, PIN_HASH_CELL, 'UNFORMATTED_VALUE');
    const v = rows?.[0]?.[0];
    return v != null && String(v).trim() !== '' ? String(v).trim() : null;
  } catch {
    return null;
  }
}

async function writeRemotePinHash(token, hash) {
  await ensureSheetTab(token, SETTINGS_TAB);
  await updateCell(token, PIN_LABEL_CELL, 'PIN hash (SHA-256) — do not edit');
  await updateCell(token, PIN_HASH_CELL, hash);
}

export async function clearRemotePin(token) {
  if (!token) return;
  try { await updateCell(token, PIN_HASH_CELL, ''); } catch { /* best effort */ }
}

// Seed the local cache from the shared sheet so a fresh / cache-cleared device uses
// the same PIN. If this device already has a local PIN but the sheet has none yet
// (first run after this shipped), push the local hash up so it becomes the shared one.
// Returns true when a shared PIN exists after syncing.
export async function syncPinFromSheet(token) {
  const remote = await fetchRemotePinHash(token);
  if (remote) {
    localStorage.setItem(PIN_HASH_KEY, remote);
    return true;
  }
  const local = localStorage.getItem(PIN_HASH_KEY);
  if (local && token) {
    try { await writeRemotePinHash(token, local); } catch { /* best effort */ }
    return true;
  }
  return false;
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
