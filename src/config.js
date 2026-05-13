export const SPREADSHEET_ID = '1RNhMNI3nM3dZisuP8vo2w6FYnx33Lvnvpe_UnHdGz4o';

// Set your Google OAuth2 Client ID here (see SETUP.md)
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

export const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

export const SHEETS = {
  MONTHLY_SUMMARY: 'Monthly Summary',
  MONTHLY_EXPENSES: 'Monthly Expenses',
  ALLOCATION_TRANSACTIONS: 'Allocation Transactions',
  ALLOCATION_SUMMARY: 'Allocation Summary',
  INQUIRIES: 'Inquiries',
};

export const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
