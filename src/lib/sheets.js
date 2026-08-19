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
export async function readRange(token, range, valueRenderOption = 'FORMATTED_VALUE') {
  const data = await request(token, SPREADSHEET_ID, `/values/${encodeURIComponent(range)}?valueRenderOption=${valueRenderOption}`);
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

// A1 column letters ⇄ 1-based index ('A' → 1, 'Z' → 26, 'AA' → 27).
function colToNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function numToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Append one row to a sheet.
//
// NOTE: this deliberately does NOT use `spreadsheets.values.append`. That API asks
// Sheets to *guess* the bounds of the "table" it should append to, and on a sheet
// with a blank row in the middle (or otherwise ragged data) the guess can anchor to
// the wrong START COLUMN — silently writing the record several columns to the right.
// A sale written that way reads back with a blank date and $0 revenue, so it vanishes
// from the sales log and never reaches the revenue/cost totals (the "$44.30 sticker
// order never showed up" bug). Instead we find the next free row ourselves and write
// to an explicit range, so a record always lands in the columns it was meant for.
export async function appendRow(token, range, values) {
  const m = /^(.+)!([A-Z]+):([A-Z]+)$/.exec(range);
  if (!m) {
    // Non column-range targets (e.g. `Sheet!A1`) keep the original behaviour.
    return request(token, SPREADSHEET_ID, `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: [values] }),
    });
  }
  const [, sheet, firstCol, lastCol] = m;
  // The API omits trailing empty rows, so rows.length is the last used row of the
  // managed range — interior blank rows can't shift the anchor.
  const rows = await readRange(token, `${sheet}!${firstCol}:${lastCol}`, 'UNFORMATTED_VALUE');
  const rowNum = rows.length + 1;
  // Size the written range to the data exactly so it can never be over/under-run.
  const endCol = numToCol(colToNum(firstCol) + Math.max(values.length, 1) - 1);
  const target = `${sheet}!${firstCol}${rowNum}:${endCol}${rowNum}`;
  return request(token, SPREADSHEET_ID, `/values/${encodeURIComponent(target)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
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

// Create a sheet tab if it doesn't already exist
export async function ensureSheetTab(token, title) {
  try {
    await request(token, SPREADSHEET_ID, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    });
  } catch { /* sheet already exists — that's fine */ }
}

// Clear all cells in a row range (soft-delete a row)
export async function clearRow(token, range) {
  return request(token, SPREADSHEET_ID, `/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function rowsToObjects(rows) {
  if (!rows.length) return [];
  const [headers, ...data] = rows;
  return data.map(row =>
    headers.reduce((obj, key, i) => { obj[key] = row[i] ?? null; return obj; }, {})
  );
}
