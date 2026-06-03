// Anthropic API key storage for the Dragon Bot.
//
// This is a static, backend-less app (gh-pages), so there is nowhere safe to
// keep a shared secret — any key shipped in the bundle would be public. Instead
// the user pastes THEIR OWN Anthropic key, which we keep in their private (OAuth-
// gated) Google Sheet (App Settings row 2) so it syncs across devices, exactly
// mirroring how the PIN works. localStorage stays as the fast local cache.
// The key is never committed and only ever sent to Anthropic.
import { readRange, updateCell, ensureSheetTab } from './sheets';

const LOCAL_KEY      = 'dragon_anthropic_key';
const SETTINGS_TAB   = 'App Settings';
const KEY_LABEL_CELL = 'App Settings!A2';
const KEY_VAL_CELL   = 'App Settings!B2';

export function getDragonKey()  { return localStorage.getItem(LOCAL_KEY) || ''; }
export function hasDragonKey()  { return !!getDragonKey(); }

// Write to localStorage (fast cache). Call writeRemoteKey() separately when
// a token is available (see setDragonKeyWithSync below).
export function setDragonKey(k) {
  const trimmed = (k || '').trim();
  if (trimmed) localStorage.setItem(LOCAL_KEY, trimmed);
  else         localStorage.removeItem(LOCAL_KEY);
}

export function clearDragonKey() { localStorage.removeItem(LOCAL_KEY); }

// Write the key to the user's private sheet (row 2, below the PIN row).
async function writeRemoteKey(token, key) {
  await ensureSheetTab(token, SETTINGS_TAB);
  await updateCell(token, KEY_LABEL_CELL, 'Anthropic API Key — do not edit');
  await updateCell(token, KEY_VAL_CELL, key);
}

// Save locally AND persist to the sheet (best-effort; offline is fine).
export async function setDragonKeyWithSync(key, token) {
  setDragonKey(key);
  if (token && key) {
    try { await writeRemoteKey(token, key.trim()); } catch { /* best effort */ }
  }
}

// Clear locally AND wipe the sheet cell (best-effort).
export async function clearDragonKeyWithSync(token) {
  clearDragonKey();
  if (token) {
    try { await updateCell(token, KEY_VAL_CELL, ''); } catch { /* best effort */ }
  }
}

// Read the key from the sheet. Returns null if none found.
export async function fetchRemoteKey(token) {
  if (!token) return null;
  try {
    const rows = await readRange(token, KEY_VAL_CELL, 'UNFORMATTED_VALUE');
    const v = rows?.[0]?.[0];
    return v != null && String(v).trim() !== '' ? String(v).trim() : null;
  } catch {
    return null;
  }
}

// Seed localStorage from the sheet on mount. If local has a key but the sheet
// doesn't (first run after this shipped), push the local key up so it becomes
// the shared one. Returns true when a key exists after syncing.
export async function syncKeyFromSheet(token) {
  const remote = await fetchRemoteKey(token);
  if (remote) {
    localStorage.setItem(LOCAL_KEY, remote);
    return true;
  }
  const local = localStorage.getItem(LOCAL_KEY);
  if (local && token) {
    try { await writeRemoteKey(token, local); } catch { /* best effort */ }
    return true;
  }
  return false;
}
