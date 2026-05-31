// Local-only configuration for the Orders + Shipping feature.
//
// This is a static, backend-less app, so everything here lives in localStorage
// on the user's device — nothing is committed or uploaded. Per-product ORDER
// TEMPLATES (modelled on how Shopify lets you set an order-number format and
// default package) drive order numbering and the default parcel/carrier; the
// ship-from address and EasyPost proxy/key power live label buying.

const TPL_KEY  = 'biz_order_templates'; // { [productId]: template }
const FROM_KEY = 'biz_ship_from';       // ship-from address object
const EP_PROXY = 'easypost_proxy_url';  // user's CORS proxy base URL (see easypost-proxy/)
const EP_KEY   = 'easypost_api_key';    // optional — only if the proxy reads the key from the request

function read(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch { return fallback; }
}
function write(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// A sensible starting template for a product the user hasn't configured yet.
// Prefix defaults to the product's first three alphanumerics (e.g. "Stickers" → STI).
export function defaultTemplate(product) {
  const prefix = (product?.name || 'ORD')
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'ORD';
  return {
    enabled: true,
    prefix,
    pad: 4,                // STI-0001
    nextNumber: 1,
    carrier: '',           // '' = shop every carrier for the cheapest rate
    service: '',           // '' = cheapest service within the carrier filter
    parcel: { weight: 3, length: 6, width: 4, height: 1 }, // ounces · inches
  };
}

function keyFor(product) { return String(product?.id || product?.name || 'unknown'); }

export function getTemplates() { return read(TPL_KEY, {}); }

// Stored template merged over the defaults so older saved templates still get
// any fields added later.
export function getTemplate(product) {
  const all = getTemplates();
  return { ...defaultTemplate(product), ...(all[keyFor(product)] || {}) };
}

export function saveTemplate(product, tpl) {
  const all = getTemplates();
  all[keyFor(product)] = tpl;
  write(TPL_KEY, all);
}

// Format the next order number WITHOUT advancing the counter (for placeholders).
export function peekOrderNo(product) {
  const tpl = getTemplate(product);
  const n = Number(tpl.nextNumber) || 1;
  return `${tpl.prefix}-${String(n).padStart(Number(tpl.pad) || 1, '0')}`;
}

// Format the next order number AND advance the counter. Called once, when a new
// order is first saved, so numbers are only consumed by real orders.
export function nextOrderNo(product) {
  const all = getTemplates();
  const k = keyFor(product);
  const tpl = { ...defaultTemplate(product), ...(all[k] || {}) };
  const n = Number(tpl.nextNumber) || 1;
  const no = `${tpl.prefix}-${String(n).padStart(Number(tpl.pad) || 1, '0')}`;
  tpl.nextNumber = n + 1;
  all[k] = tpl;
  write(TPL_KEY, all);
  return no;
}

const EMPTY_ADDR = { name: '', company: '', street1: '', street2: '', city: '', state: '', zip: '', phone: '', country: 'US' };

export function getShipFrom() { return { ...EMPTY_ADDR, ...read(FROM_KEY, {}) }; }
export function saveShipFrom(addr) { write(FROM_KEY, addr); }

export function getEasyPost() {
  return {
    proxyUrl: (localStorage.getItem(EP_PROXY) || '').trim(),
    key:      (localStorage.getItem(EP_KEY)   || '').trim(),
  };
}
export function saveEasyPost({ proxyUrl, key }) {
  localStorage.setItem(EP_PROXY, (proxyUrl || '').trim());
  localStorage.setItem(EP_KEY,   (key      || '').trim());
}
// A proxy URL is the one hard requirement — EasyPost can't be called without it.
export function hasEasyPost() { return !!getEasyPost().proxyUrl; }
