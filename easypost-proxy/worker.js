/**
 * EasyPost CORS proxy — Cloudflare Worker.
 *
 * EasyPost does not allow CORS, so the Finance Tracker (a static browser app)
 * cannot call api.easypost.com directly. This tiny worker sits in between: it
 * adds the CORS headers the browser needs and attaches the EasyPost
 * Authorization header server-side, then forwards the request unchanged.
 *
 * It forwards by PATH: a request to  https://<worker>/v2/shipments  becomes
 * https://api.easypost.com/v2/shipments  with the same method, body and query.
 *
 * ── Auth (pick ONE) ──────────────────────────────────────────────────────────
 *   A) Worker holds the key (recommended):
 *        wrangler secret put EASYPOST_API_KEY
 *      Leave the app's "EasyPost API key" field blank.
 *   B) App sends the key per-request:
 *        the app puts it in the  X-EasyPost-Key  header (kept only in the
 *        browser's localStorage). Used only if EASYPOST_API_KEY is unset.
 *
 * ── Lock it down ─────────────────────────────────────────────────────────────
 *   Set ALLOWED_ORIGIN to your site so it isn't an open proxy, e.g.
 *        ALLOWED_ORIGIN = https://gamboiuwu.github.io
 *   (Defaults to "*" if unset — fine for testing, tighten for real use.)
 */

const EASYPOST_BASE = 'https://api.easypost.com';

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-EasyPost-Key',
      'Access-Control-Max-Age': '86400',
    };

    // Preflight
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('EasyPost proxy is running. Call it at /v2/...', { status: 200, headers: cors });
    }

    // Resolve the EasyPost key: worker secret wins, else the per-request header.
    const key = env.EASYPOST_API_KEY || request.headers.get('X-EasyPost-Key');
    if (!key) {
      return json({ error: { message: 'No EasyPost API key. Set EASYPOST_API_KEY on the worker or send X-EasyPost-Key.' } }, 401, cors);
    }

    const target = `${EASYPOST_BASE}${url.pathname}${url.search}`;
    const auth = 'Basic ' + btoa(`${key}:`);

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers: {
          'Authorization': auth,
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'User-Agent': 'finance-prog-easypost-proxy',
        },
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
      });
    } catch (e) {
      return json({ error: { message: `Proxy could not reach EasyPost: ${e.message}` } }, 502, cors);
    }

    // Pass EasyPost's response straight through, plus CORS.
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    });
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
