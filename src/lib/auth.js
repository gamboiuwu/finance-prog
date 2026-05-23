import { GOOGLE_CLIENT_ID, SCOPES } from '../config';

const TOKEN_KEY = 'gtoken';
const EXPIRY_KEY = 'gtoken_expiry';

export function getStoredToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = parseInt(localStorage.getItem(EXPIRY_KEY) || '0', 10);
  if (token && Date.now() < expiry) return token;
  return null;
}

export function storeToken(token, expiresIn = 3600) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + expiresIn * 1000 - 60000));
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

export function requestAccessToken(callback) {
  if (!window.google) {
    callback(null, 'Google Identity Services not loaded');
    return;
  }
  const client = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: (response) => {
      if (response.error) {
        callback(null, response.error);
      } else {
        storeToken(response.access_token, response.expires_in);
        callback(response.access_token, null);
      }
    },
  });
  client.requestAccessToken({ prompt: '' });
}
