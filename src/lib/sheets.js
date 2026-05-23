import { SPREADSHEET_ID } from '../config';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function request(token, spreadsheetId, path, options = {}) {
  const res = await fetch(`${BASE}/${spreadsheetId}${path}`, {
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

// Read from the main finance spreadsheet
export async function readRange(token, range) {
  const data = await request(token, SPREADSHEET_ID, `/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`);
  return data.values || [];
}

// Read from any spreadsheet by ID (for monthly reports)
export async function readRangeFrom(token, sheetId, range) {
  const data = await request(token, sheetId, `/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`);
  return data.values || [];
}

// Read Monthly Summary Report Link column as formulas to extract hyperlink URLs
export async function readReportLinks(token) {
  const data = await request(
    token,
    SPREADSHEET_ID,
    `/values/${encodeURIComponent('Monthly Summary!A2:C13')}?valueRenderOption=FORMULA`
  );
  const rows = data.values || [];
  const links = {};

  rows.forEach(row => {
    const month = row[0];
    const cell = row[2]; // Report Link column
    if (!month || !cell) return;

    let url = null;
    if (typeof cell === 'string') {
      // Try to parse =HYPERLINK("url", "label")
      const m = cell.match(/HYPERLINK\s*\(\s*"([^"]+)"/i);
      if (m) {
        url = m[1];
      } else if (cell.startsWith('http')) {
        url = cell;
      }
    }

    if (url) {
      const idMatch = url.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if (idMatch) links[month] = idMatch[1];
    }
  });

  return links;
}

export async function appendRow(token, range, values) {
  return request(token, SPREADSHEET_ID, `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: [values] }),
  });
}

export async function updateCell(token, range, value) {
  return request(token, SPREADSHEET_ID, `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[value]] }),
  });
}

export async function batchUpdateCells(token, data) {
  // data: array of { range, value }
  return request(token, SPREADSHEET_ID, `/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: data.map(({ range, value }) => ({ range, values: [[value]] })),
    }),
  });
}

export function rowsToObjects(rows) {
  if (!rows.length) return [];
  const [headers, ...data] = rows;
  return data.map(row =>
    headers.reduce((obj, key, i) => { obj[key] = row[i] ?? null; return obj; }, {})
  );
}
