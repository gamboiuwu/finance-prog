// Anthropic API key storage for the Dragon Bot.
//
// This is a static, backend-less app (gh-pages), so there is nowhere safe to
// keep a shared secret — any key shipped in the bundle would be public. Instead
// the user pastes THEIR OWN Anthropic key, which we keep only in localStorage on
// their device and send straight to api.anthropic.com from the browser. It is
// never committed and never leaves their machine except to Anthropic.
const KEY = 'dragon_anthropic_key';

export function getDragonKey()  { return localStorage.getItem(KEY) || ''; }
export function setDragonKey(k) { localStorage.setItem(KEY, (k || '').trim()); }
export function clearDragonKey() { localStorage.removeItem(KEY); }
export function hasDragonKey()  { return !!getDragonKey(); }
