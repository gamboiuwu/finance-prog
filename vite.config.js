import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Local-backend builds (VITE_LOCAL_BACKEND=1) must not load Google's identity
// script at all: no sign-in, no third-party request from the page.
const stripGoogleIdentity = () => ({
  name: 'strip-google-identity',
  transformIndexHtml(html) {
    if (process.env.VITE_LOCAL_BACKEND !== '1') return html;
    return html.replace(/\s*<script src="https:\/\/accounts\.google\.com\/gsi\/client"[^>]*><\/script>/, '');
  },
});

export default defineConfig({
  base: '/finance-prog/',
  plugins: [
    react(),
    tailwindcss(),
    stripGoogleIdentity(),
  ],
  build: {
    modulePreload: { polyfill: false },
  },
})
