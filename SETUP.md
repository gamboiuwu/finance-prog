# Finance Tracker — Setup Guide

## 1. Create Google OAuth2 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**, search for **Google Sheets API**, enable it
4. Go to **APIs & Services → Credentials**
5. Click **Create Credentials → OAuth 2.0 Client ID**
6. Application type: **Web application**
7. Add these **Authorized JavaScript origins**:
   - `http://localhost:5173` (for local dev)
   - `https://gamboiuwu.github.io` (for GitHub Pages)
8. Click **Create** and copy the **Client ID**

## 2. Create your .env file

In the project root, create a `.env` file:

```
VITE_GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
```

## 3. Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173/finance-prog/](http://localhost:5173/finance-prog/)

## 4. Deploy to GitHub Pages

```bash
npm run deploy
```

Your app will be live at: **https://gamboiuwu.github.io/finance-prog/**

## 5. Sign in

- Open the app, click **Sign in with Google**
- A popup will ask you to authorize Google Sheets access
- You're in! The app reads/writes your spreadsheet directly.

## Notes

- The access token is stored in your browser's localStorage and expires after ~1 hour — you'll be asked to sign in again.
- The spreadsheet ID is hardcoded in `src/config.js` — no need to change it.
- Works on phone via the GitHub Pages URL (bookmark or add to home screen).
