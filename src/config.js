export const SPREADSHEET_ID = '1RNhMNI3nM3dZisuP8vo2w6FYnx33Lvnvpe_UnHdGz4o';

// Separate, link-view-only sheet that holds Report Issue submissions. Safe to keep
// here: it has no financial data, only issue notes, and the daily AI routine reads it
// with a plain API key. The app writes to it with the signed-in user's token.
export const ISSUES_SPREADSHEET_ID = '1cyvsfhpI-G7akGkErRysi0Hoh6drVMwtfwgzJeebMwY';

export const GOOGLE_CLIENT_ID = '805285942411-qc6m89f2lm4tc3sn8l0jnkn786i611qj.apps.googleusercontent.com';

// ── Local backend ─────────────────────────────────────────────────────────────
// Build with VITE_LOCAL_BACKEND=1 to run against a self-hosted, Sheets-compatible
// store on the same origin instead of Google Sheets (LIZA serves one at
// /sheets/v4/spreadsheets). In that mode there is no Google sign-in at all: the
// origin (a private tailnet) is the perimeter and the PIN is the lock. The
// spreadsheet ids above are reused as the local workbook ids, so nothing else
// changes. VITE_SHEETS_BASE overrides the endpoint for either mode.
export const LOCAL_BACKEND = import.meta.env.VITE_LOCAL_BACKEND === '1';
export const SHEETS_BASE =
  import.meta.env.VITE_SHEETS_BASE ||
  (LOCAL_BACKEND ? '/sheets/v4/spreadsheets' : 'https://sheets.googleapis.com/v4/spreadsheets');

export const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

export const SHEETS = {
  MONTHLY_SUMMARY: 'Monthly Summary',
  MONTHLY_EXPENSES: 'Monthly Expenses',
  ALLOCATION_TRANSACTIONS: 'Allocation Transactions',
  ALLOCATION_SUMMARY: 'Allocation Summary',
  INQUIRIES: 'Inquiries',
  BUSINESS_PRODUCTS: 'Business Products',
  BUSINESS_TRANSACTIONS: 'Business Transactions',
  BUSINESS_ACCOUNT_SPENDING: 'Business Account Spending',
  BUSINESS_EXPENSES: 'Business Expenses',
  COMMISSION_PRICES: 'Commission Prices',
};

export const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
