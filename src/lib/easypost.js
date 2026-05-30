// EasyPost shipping client — routed through the user's own proxy.
//
// EasyPost does NOT allow CORS, so a browser cannot call api.easypost.com
// directly: the request is blocked before it leaves the page. The proxy (see
// easypost-proxy/) is a tiny Cloudflare Worker that adds the CORS headers and
// the Authorization header server-side. We optionally send the user's key in
// X-EasyPost-Key for proxies that read it from the request; a proxy that holds
// its own EASYPOST_API_KEY secret simply ignores that header.
import { getEasyPost } from './orders';

function cfg() {
  const { proxyUrl, key } = getEasyPost();
  if (!proxyUrl) throw new Error('Shipping isn’t set up yet — add your EasyPost proxy URL in Shipping Setup.');
  return { base: proxyUrl.replace(/\/+$/, ''), key };
}

async function ep(path, method, body) {
  const { base, key } = cfg();
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-EasyPost-Key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Couldn’t reach the shipping proxy (${e.message}). Check the proxy URL in Shipping Setup.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

// Map our flat address form fields → an EasyPost address object.
export function toAddress(a) {
  return {
    name: a.name || undefined, company: a.company || undefined,
    street1: a.street1, street2: a.street2 || undefined,
    city: a.city, state: a.state, zip: a.zip, country: a.country || 'US',
    phone: a.phone || undefined, email: a.email || undefined,
  };
}

// Create a shipment; the response carries the available .rates and an .id.
export async function createShipment({ to, from, parcel }) {
  return ep('/v2/shipments', 'POST', {
    shipment: { to_address: toAddress(to), from_address: toAddress(from), parcel },
  });
}

// Cheapest rate wins — that's where EasyPost's negotiated discounts surface.
// Optional carrier/service narrow the field first; if the filter empties the
// list we fall back to the cheapest across everything.
export function lowestRate(rates, { carrier, service } = {}) {
  let list = rates || [];
  if (carrier) list = list.filter(r => r.carrier === carrier);
  if (service) list = list.filter(r => r.service === service);
  if (!list.length) list = rates || [];
  return list.reduce((best, r) =>
    !best || parseFloat(r.rate) < parseFloat(best.rate) ? r : best, null);
}

export async function buyShipment(shipmentId, rateId) {
  return ep(`/v2/shipments/${shipmentId}/buy`, 'POST', { rate: { id: rateId } });
}
