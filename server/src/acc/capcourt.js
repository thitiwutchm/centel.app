// CapCourt Admin → Centel Account. CapCourt (admin.capcourt.com) bills each venue monthly;
// this module turns those bills into Centel invoices and works out what to report back.
// The database work lives in routes.js (it reuses the normal document code); this file is
// the pure part plus the HTTP client, so tests can run without a database.

export const CC_KINDS = [
  ['package', 'แพ็กเกจเว็บรายเดือน'],
  ['slips', 'ค่าตรวจสลิป'],
  ['gp', 'GP จากยอดขายคลิป'],
];
export const DEFAULT_BASE = 'https://admin.capcourt.com';
const PUBLIC_BASE = process.env.ACC_PUBLIC_URL || 'https://account.centel.app';

export const docLink = (token) => (token ? `${PUBLIC_BASE}/doc.html?t=${token}` : '');

export function cleanBase(v) {
  const s = String(v || '').trim().replace(/\/+$/, '') || DEFAULT_BASE;
  // https only, except a local CapCourt during development.
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(s)) return null;
  return s;
}
export const cleanKey = (v) => (typeof v === 'string' && /^ccb_[A-Za-z0-9_-]{8,120}$/.test(v.trim()) ? v.trim() : null);

// Calls the CapCourt billing API. Throws an Error with .status on failure.
export async function ccFetch(base, key, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${base}/api/v1/billing/${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'capcourt_key' : `capcourt_${res.status}`), { status: res.status });
  return json;
}

// The first month to ask for: three months back from today (Bangkok), as YYYY-MM.
export function sinceMonth(today) {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - 2, 1));
  return d.toISOString().slice(0, 7);
}

// Centel invoice body (what POST /docs takes) for one CapCourt bill.
// Amounts stay CapCourt's: GP is one line of its amount so rounding cannot drift.
// The invoice is never a tax invoice: the receipt issued when payment is approved is.
export function toDocBody(inv, cfg, { vatRegistered, contactId, items = new Map() }) {
  const priceMode = inv.prices_include_vat ? 'incl' : 'excl';
  const lines = (inv.lines || []).map((l) => {
    const map = cfg.itemMap?.[l.kind] || null;
    const item = map ? items.get(map) : null;
    const gp = l.kind === 'gp';
    return {
      itemId: item ? item.id : null,
      name: item?.name || l.description,
      desc: item ? l.description : '',
      qty: gp ? 1 : Number(l.quantity),
      unit: l.kind === 'slips' ? 'ใบ' : '',
      price: gp ? Number(l.amount) : Number(l.unit_price),
      vat: true,
      account: item?.account || null,
    };
  }).filter((l) => l.qty !== 0 || l.price !== 0);
  return {
    type: 'IV',
    date: inv.issued_on,
    due_date: inv.due_on,
    contact_id: contactId,
    tax_invoice: false,
    price_mode: priceMode,
    vat_rate: vatRegistered && Number(inv.vat_rate) > 0 ? 7 : 0,
    lines: lines.length ? lines : [{ name: `ค่าบริการ CapCourt ${inv.number}`, qty: 1, price: 0 }],
    notes: `บิล CapCourt ${inv.number} รอบ ${inv.period?.start || ''} ถึง ${inv.period?.end || ''}`,
  };
}

// Contact fields for a venue Centel has not seen yet.
export function venueContact(v) {
  const address = [v.address, v.province].filter(Boolean).join(' ').trim();
  return {
    kind: 'customer', is_company: true, name: v.name || v.code, address: address || null,
    email: v.contact_email || null, phone: v.contact_phone || null, contact_name: v.contact_name || null,
    note: `สนาม CapCourt: ${v.code}`,
  };
}

// What CapCourt should hear about a Centel invoice, or null if it already knows.
// receipt: the live receipt for the invoice ({ number, pay }) or null.
export function reportFor(doc, receipt) {
  if (doc.status === 'void') return null;
  const state = receipt ? `paid:${receipt.number}` : 'issued';
  if (doc.ext_reported === state) return null;
  const body = { number: doc.number, url: docLink(doc.public_token), status: receipt ? 'paid' : 'issued' };
  if (receipt) {
    body.receipt = receipt.number;
    const day = receipt.pay?.date || receipt.date;
    if (day) body.paid_at = `${day}T12:00:00+07:00`;
  }
  return { state, body };
}
