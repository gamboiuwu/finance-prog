import { SPREADSHEET_ID } from '../config';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function request(token, path, options = {}) {
  const res = await fetch(`${BASE}/${SPREADSHEET_ID}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function readRange(token, range) {
  const data = await request(token, `/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`);
  return data.values || [];
}

export async function appendRow(token, range, values) {
  return request(token, `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: [values] }),
  });
}

export async function updateCell(token, range, value) {
  return request(token, `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[value]] }),
  });
}

// Parse a row array into an object, padding short rows with null
export function parseRow(row, headers) {
  return headers.reduce((obj, key, i) => {
    obj[key] = row[i] ?? null;
    return obj;
  }, {});
}

export function rowsToObjects(rows) {
  if (!rows.length) return [];
  const [headers, ...data] = rows;
  return data.map(row => parseRow(row, headers));
}
