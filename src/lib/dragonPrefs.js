// dragonPrefs.js — customizable Ledger settings, stored on-device (localStorage).
//
// Like the API key, these never leave the browser. They tune the model used, the
// dragon's tone, the planning math (pay schedule + savings pace), and whether
// Ledger may research live prices/rates on the web.

const KEY = 'dragon_prefs_v1';

// Model choices — full IDs the Messages API expects.
export const MODELS = {
  'claude-haiku-4-5-20251001': { label: 'Haiku',  hint: 'Fast · cheap' },
  'claude-sonnet-4-6':         { label: 'Sonnet', hint: 'Balanced' },
  'claude-opus-4-8':           { label: 'Opus',   hint: 'Most capable' },
};

// Pay cadence → paychecks per month (used for the per-paycheck planning figure).
export const PAY_SCHEDULES = {
  weekly:      { label: 'Weekly',     perMonth: 52 / 12 },
  biweekly:    { label: 'Biweekly',   perMonth: 26 / 12 },
  semimonthly: { label: 'Semi-mo.',   perMonth: 2 },
  monthly:     { label: 'Monthly',    perMonth: 1 },
};

// How hard to save by default (fraction of free cash flow) when no deadline given.
export const PACES = {
  conservative: { label: 'Easy',     fraction: 0.35, hint: 'Gentle' },
  balanced:     { label: 'Balanced', fraction: 0.5,  hint: 'Half spare' },
  aggressive:   { label: 'Hard',     fraction: 0.7,  hint: 'Push' },
};

export const TONES = {
  playful:      { label: 'Playful',  hint: 'Full flair' },
  balanced:     { label: 'Balanced', hint: 'A sprinkle' },
  professional: { label: 'Pro',      hint: 'Just numbers' },
};

const DEFAULTS = {
  model: 'claude-sonnet-4-6',
  webResearch: false,
  tone: 'balanced',
  paySchedule: 'biweekly',
  pace: 'balanced',
};

export function getPrefs() {
  try {
    const p = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    if (!MODELS[p.model])              p.model = DEFAULTS.model;
    if (!PAY_SCHEDULES[p.paySchedule]) p.paySchedule = DEFAULTS.paySchedule;
    if (!PACES[p.pace])                p.pace = DEFAULTS.pace;
    if (!TONES[p.tone])                p.tone = DEFAULTS.tone;
    p.webResearch = !!p.webResearch;
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
