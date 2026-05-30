# EasyPost shipping proxy

The Finance Tracker can buy **discounted shipping labels** through
[EasyPost](https://www.easypost.com/) — up to ~60% off USPS and ~83% off UPS,
no volume minimums. EasyPost's `lowest_rate` is used to always pick the cheapest
rate across carriers.

**Why a proxy is needed:** EasyPost does **not** allow CORS, so a browser app
can't call `api.easypost.com` directly — the request is blocked before it leaves
the page. This worker is a tiny relay that adds the CORS headers and the EasyPost
`Authorization` header server-side. It holds no data and stores nothing.

> Order tracking, the done/not-done status, order numbers, templates, and
> pasting in a tracking number all work **without** this proxy. You only need it
> to buy labels from inside the app.

---

## 1. Get your EasyPost API key

1. Sign up at <https://www.easypost.com/signup> (free).
2. Dashboard → **API Keys**. Use the **Test** key while trying things out, then
   the **Production** key once you've added a payment method and want real labels.
   Keys look like `EZAK...` (production) or `EZTK...` (test).

## 2. Deploy the worker (free Cloudflare account)

**Option A — Wrangler CLI**

```bash
npm install -g wrangler
wrangler login
cd easypost-proxy
wrangler deploy worker.js --name easypost-proxy

# Store the key on the worker (recommended — then leave the app's key field blank)
wrangler secret put EASYPOST_API_KEY        # paste your EZAK.../EZTK... key

# Lock the proxy to your site so it isn't an open relay
wrangler secret put ALLOWED_ORIGIN          # e.g. https://gamboiuwu.github.io
```

**Option B — Cloudflare dashboard**

1. Cloudflare → **Workers & Pages** → **Create** → **Create Worker**.
2. Paste the contents of `worker.js`, click **Deploy**.
3. Worker → **Settings → Variables**:
   - Add a **Secret** `EASYPOST_API_KEY` = your EasyPost key.
   - Add a **Variable** `ALLOWED_ORIGIN` = `https://gamboiuwu.github.io`.

Either way you'll get a URL like `https://easypost-proxy.<you>.workers.dev`.

## 3. Point the app at it

In the app: **Business → Sales tab → 🚚 Setup**

- **Proxy URL** → your worker URL (e.g. `https://easypost-proxy.you.workers.dev`)
- **EasyPost API key** → leave blank if you set `EASYPOST_API_KEY` on the worker
  (Option A/B above); otherwise paste it here (it stays only in your browser).
- **Ship from** → your return address (required by carriers).

Now open any sale → **📦 Make order** → fill the customer address →
**🔍 Compare rates** → **Buy cheapest label**. The tracking number and a
printable label are saved onto the order.

---

## Security notes

- The worker holds the EasyPost key as a Cloudflare **secret** (Option A/B) — it
  is never in this repo or the app bundle.
- If you instead paste the key into the app, it lives **only** in your browser's
  `localStorage` and is sent to your own worker — never committed, never shared.
- Set `ALLOWED_ORIGIN` so only your site can use the proxy.
- Use the **Test** key (`EZTK...`) until you're confident; test labels aren't
  charged and aren't mailable.
