import { useState } from 'react';

// In-app walkthrough for connecting shipping (EasyPost) to the app. Mirrors
// easypost-proxy/README.md so the steps are available without leaving the page.

function CodeBlock({ children }) {
  const [copied, setCopied] = useState(false);
  const text = String(children);
  return (
    <div className="relative group">
      <pre className="bg-slate-950 border border-slate-700 rounded-lg p-3 pr-10 text-[11px] text-emerald-300 font-mono overflow-x-auto whitespace-pre-wrap break-words">{text}</pre>
      <button
        onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 hover:text-white">
        {copied ? '✓' : 'copy'}
      </button>
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-7 h-7 rounded-full bg-green-600 text-white text-sm font-bold flex items-center justify-center">{n}</div>
      <div className="flex-1 min-w-0 space-y-2 pb-1">
        <h4 className="text-white font-semibold text-sm">{title}</h4>
        <div className="text-slate-400 text-xs leading-relaxed space-y-2">{children}</div>
      </div>
    </div>
  );
}

const A = ({ href, children }) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-cyan-400 underline">{children}</a>
);

export default function SetupTutorial({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50">
      <div className="bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92dvh] flex flex-col">
        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold font-broske">📖 Shipping Setup Tutorial</h3>
            <p className="text-slate-400 text-xs mt-0.5">Connect EasyPost so you can buy discounted labels in-app</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center shrink-0">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <div className="bg-cyan-900/20 border border-cyan-800/40 rounded-2xl p-4 text-cyan-100/90 text-xs leading-relaxed space-y-1.5">
            <p className="font-semibold text-cyan-200">Why these steps?</p>
            <p>EasyPost gives you the cheapest carrier rates (up to ~60% off USPS, ~83% off UPS), but it blocks direct calls from a browser. So labels are bought through a tiny relay you deploy once — free, ~5 minutes.</p>
            <p className="text-cyan-300/80">Order tracking, statuses, templates, and pasting in a tracking number all work right now with no setup. You only need this to buy labels from inside the app.</p>
          </div>

          <Step n={1} title="Create an EasyPost account & copy your key">
            <p>Sign up at <A href="https://www.easypost.com/signup">easypost.com/signup</A> (free). In the dashboard go to <span className="text-slate-200">API Keys</span>.</p>
            <p>Use the <span className="text-slate-200">Test key</span> (<span className="font-mono">EZTK…</span>) while experimenting; switch to the <span className="text-slate-200">Production key</span> (<span className="font-mono">EZAK…</span>) once you add a payment method and want real, mailable labels.</p>
          </Step>

          <Step n={2} title="Deploy the proxy (free Cloudflare Worker)">
            <p>The proxy code is in the repo at <span className="font-mono text-slate-300">easypost-proxy/worker.js</span>.</p>
            <p className="text-slate-300 font-medium">Easiest — Cloudflare dashboard:</p>
            <p>Cloudflare → <span className="text-slate-200">Workers &amp; Pages</span> → <span className="text-slate-200">Create</span> → <span className="text-slate-200">Create Worker</span>. Paste the contents of <span className="font-mono">worker.js</span>, click <span className="text-slate-200">Deploy</span>. You'll get a URL like <span className="font-mono text-emerald-300">https://easypost-proxy.you.workers.dev</span>.</p>
            <p className="text-slate-300 font-medium pt-1">Or — command line:</p>
            <CodeBlock>{`npm install -g wrangler
wrangler login
cd easypost-proxy
wrangler deploy worker.js --name easypost-proxy`}</CodeBlock>
          </Step>

          <Step n={3} title="Give the proxy your key (and lock it down)">
            <p>Store the EasyPost key on the worker so it never lives in the app. In the dashboard: Worker → <span className="text-slate-200">Settings → Variables</span> → add a <span className="text-slate-200">Secret</span>:</p>
            <CodeBlock>{`EASYPOST_API_KEY = EZAK...   (your key)
ALLOWED_ORIGIN   = https://gamboiuwu.github.io`}</CodeBlock>
            <p>Or via CLI:</p>
            <CodeBlock>{`wrangler secret put EASYPOST_API_KEY
wrangler secret put ALLOWED_ORIGIN`}</CodeBlock>
            <p><span className="text-slate-200">ALLOWED_ORIGIN</span> makes sure only this site can use your proxy.</p>
          </Step>

          <Step n={4} title="Connect it to the app">
            <p>Back here: <span className="text-slate-200">Business → ⚙️ Settings → Shipping &amp; EasyPost</span> and fill in:</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><span className="text-slate-200">Proxy URL</span> — your worker URL from step 2.</li>
              <li><span className="text-slate-200">EasyPost API key</span> — leave blank if you set it on the worker in step 3; otherwise paste it (it stays only in this browser).</li>
              <li><span className="text-slate-200">Ship from</span> — your return address (carriers require it).</li>
            </ul>
          </Step>

          <Step n={5} title="Connect carriers (the networks)">
            <p><span className="text-slate-200">USPS works immediately</span> — EasyPost includes it with discounted rates, no extra account.</p>
            <p>To also ship <span className="text-slate-200">UPS, FedEx, or DHL</span>, open the EasyPost dashboard → <span className="text-slate-200">Carriers</span> → <span className="text-slate-200">Add Carrier Account</span>. You can use EasyPost's pre-negotiated UPS rates, or link your own carrier account for your contract rates. Once added, those carriers automatically appear when you compare rates.</p>
            <p className="text-slate-500">Tip: leave a product template's carrier on “Cheapest (any carrier)” to always shop every connected network for the lowest price.</p>
          </Step>

          <Step n={6} title="Make your first order & buy a label">
            <p>Go to the <span className="text-slate-200">Sales</span> tab → tap a sale → <span className="text-slate-200">📦 Make order</span>. Enter the customer's address, then <span className="text-slate-200">🔍 Compare rates</span> → <span className="text-slate-200">Buy cheapest label</span>. The tracking number and a printable label are saved onto the order, and the sale shows a 🚚 Shipped badge. Mark it ✓ Done when it's out the door.</p>
          </Step>

          <div className="bg-slate-800/60 rounded-2xl p-4 text-xs text-slate-400 leading-relaxed">
            <p className="text-slate-200 font-semibold mb-1">Order numbers &amp; defaults</p>
            <p>Set a per-product <span className="text-slate-200">order template</span> under ⚙️ Settings → Order Templates: prefix &amp; numbering (e.g. <span className="font-mono">STI-0001</span>), default package size, and default carrier. New orders use these automatically.</p>
          </div>
        </div>

        <div className="shrink-0 px-5 py-4 border-t border-slate-800 safe-area-bottom">
          <button onClick={onClose} className="w-full py-3 rounded-xl bg-green-600 hover:bg-green-500 text-white font-bold text-sm transition-colors">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
