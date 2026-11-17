import crypto from 'node:crypto';
import express from 'express';
import { pool, asUser } from '../db.js';
import { bearer, cors, ACC_BASE } from '../oauth.js';
import { ToolError, fail } from '../mcpcore.js';
import { argsHash } from '../mcpwrite.js';
import { REPORTS } from './reports.js';
import { ROLES } from './users.js';
import accRoutes from './routes.js';

/* account.centel.app as a remote MCP server (Streamable HTTP, stateless, JSON only), so
   Claude and ChatGPT can read a business's documents, contacts, products and reports, and
   (scope acc.write) issue quotations, invoices, receipts and expenses, add contacts and
   products, and void documents.

   Every tool goes through the accounting API itself (/api/acc in routes.js), called in
   process as the signed-in person: the same validation, numbering, double-entry posting,
   row level security and per-business positions (users.js guard) as the web app. A
   salesperson's AI sees and does what that salesperson can, nothing more.

   Issuing, paying and voiding a document first answer with a preview and a confirm_token
   (mcp_confirms, 10 minutes, once); the same call with the token does it. Create calls take
   an idempotency_key (mcp_idem) so a retry cannot issue a document twice. Documents an AI
   made carry created_via (the app's name) and are listed in เชื่อมต่อระบบ › Claude / ChatGPT. */

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isYm = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const lc = (s) => String(s ?? '').trim().toLowerCase();
const bangkokToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const monthRange = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};
const CONFIRM_SEC = 600;
const KEY_RX = /^[\w.:\-]{8,200}$/;

const TYPE_NAME = { QT: 'ใบเสนอราคา (quotation)', IV: 'ใบแจ้งหนี้ (invoice)', RE: 'ใบเสร็จรับเงิน (receipt)', EX: 'ค่าใช้จ่าย (expense / purchase bill)' };
const docLink = (id) => `${ACC_BASE()}/#/doc/${id}`;

/* ---------- Calling the accounting API in process ---------- */

// Plain words for the API's error codes, for the AI to pass on.
const ERRORS = {
  forbidden: 'Your position in this business does not allow this. The owner can change it in ผู้ใช้งานในระบบ.',
  not_found: 'Not found in this business.',
  bad_contact: 'The customer / vendor is missing or not in this business.',
  no_lines: 'A document needs at least one line.',
  bad_type: 'Unknown document type (QT, IV, RE or EX).',
  bad_ref: 'The source document was not found in this business.',
  ref_void: 'The source document has been voided.',
  already_received: 'This invoice already has a receipt. Void that receipt first to issue a new one.',
  doc_void: 'This document has been voided.',
  doc_paid: 'This invoice is paid; void its receipt first.',
  has_receipt: 'This invoice has a receipt. Void the receipt first, then the invoice.',
  bad_pay_account: 'The payment account must be a cash or bank account (see list_accounts).',
  negative_total: 'The total cannot be below zero.',
  unknown_account: 'One of the account codes is not in the chart of accounts (see list_accounts).',
  bad_name: 'A name is required.',
  bad_status: 'Unknown status.',
  too_many_requests: 'Too many requests; try again in a while.',
};
const apiError = (status, code) => new ToolError(ERRORS[code] || `The accounting app refused this (${code || status}).`);

function clean(q) {
  const out = {};
  for (const [k, v] of Object.entries(q || {})) if (v != null && v !== '') out[k] = String(v);
  return out;
}

// Runs one /api/acc request through routes.js with a request object of our own.
export function accCall(user, method, path, { body, query, preview, client } = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(clean(query)).toString();
    const url = `/${String(path).replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
    const headers = { 'content-type': 'application/json' };
    const req = {
      method, url, originalUrl: url, headers, body: body || {}, query: clean(query), params: {},
      user, ip: `mcp:${user.id}`, mcpPreview: !!preview, mcpClient: client || null,
      get(name) { return headers[String(name).toLowerCase()]; },
      header(name) { return headers[String(name).toLowerCase()]; },
      get path() { return this.url.split('?')[0]; },
    };
    let settled = false;
    const done = (status, payload) => {
      if (settled) return;
      settled = true;
      if (status >= 400) reject(apiError(status, payload?.error));
      else resolve(payload ?? {});
    };
    const res = {
      statusCode: 200,
      locals: {},
      headersSent: false,
      status(c) { this.statusCode = c; return this; },
      set() { return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      header() { return this; },
      type() { return this; },
      json(b) { done(this.statusCode, b); return this; },
      send(b) { done(this.statusCode, typeof b === 'string' ? { text: b } : b); return this; },
      sendStatus(c) { done(c, {}); return this; },
      end() { done(this.statusCode, {}); return this; },
      redirect() { done(302, {}); return this; },
    };
    accRoutes(req, res, (err) => {
      if (settled) return;
      settled = true;
      if (!err) return reject(new ToolError('Not available.'));
      if (err.expose) return reject(apiError(err.status || 400, err.message));
      if (err.code === 'P0001') return reject(new ToolError(String(err.message)));
      if (err.code === '42501') return reject(apiError(403, 'forbidden'));
      if (err.code === '23505') return reject(new ToolError('That already exists.'));
      if (err.code === '22P02' || err.code === '23514') return reject(new ToolError('Some details are not valid.'));
      reject(err);
    });
  });
}

/* ---------- Context: the person's businesses, loaded once per tool call ---------- */

function makeCtx(user) {
  const boots = new Map();
  let list;
  const ctx = {
    user,
    call: (method, path, opts) => accCall(user, method, path, { ...opts, client: user.client }),
    async businesses() {
      if (!list) list = (await ctx.call('GET', '/businesses')).businesses || [];
      return list;
    },
    // A business by id or name; the only one when the person has one.
    async biz(arg) {
      const all = await ctx.businesses();
      if (!all.length) fail('This account has no business yet. Create one at account.centel.app first.');
      const names = all.map((b) => `"${b.name}"`).join(', ');
      if (arg == null || arg === '') {
        if (all.length === 1) return all[0];
        fail(`This person has ${all.length} businesses: ${names}. Pass business (name or id).`);
      }
      const a = lc(arg);
      const hit = all.find((b) => b.id === arg) || all.find((b) => lc(b.name) === a);
      if (hit) return hit;
      const some = all.filter((b) => lc(b.name).includes(a));
      if (some.length === 1) return some[0];
      fail(`No single business matches "${arg}". Businesses: ${names}.`);
    },
    // GET /b/:id: the business with its chart of accounts, contacts and items.
    async boot(b) {
      if (!boots.has(b.id)) boots.set(b.id, await ctx.call('GET', `/b/${b.id}`));
      return boots.get(b.id);
    },
  };
  return ctx;
}

const P = (b, path = '') => `/b/${b.id}${path}`;

/* ---------- Shaping what comes back ---------- */

const bizView = (b) => ({ id: b.id, name: b.name, taxId: b.tax_id || undefined, vatRegistered: !!b.vat_registered, myRole: ROLES[b.role]?.name || b.role });

const docRow = (d) => ({
  id: d.id, type: d.type, number: d.number, status: d.status, date: String(d.date).slice(0, 10),
  dueDate: d.due_date ? String(d.due_date).slice(0, 10) : undefined,
  contact: d.contact_name ?? d.contact?.name, subtotal: Number(d.subtotal), vat: Number(d.vat), total: Number(d.total),
  wht: Number(d.wht) || undefined, paidDate: d.paid_date || d.pay?.date || undefined,
  madeBy: d.created_via ? `AI: ${d.created_via}` : undefined,
});

const lineView = (l) => ({
  name: l.name, description: l.desc || undefined, qty: l.qty, unit: l.unit || undefined, price: l.price,
  discount: l.disc || undefined, vat: l.vat === false ? false : undefined, whtRate: l.wht || undefined,
  account: l.account || undefined, amount: l.amount, product: l.itemId || undefined,
});

function docFull(d) {
  return {
    ...docRow(d),
    typeName: TYPE_NAME[d.type],
    contact: d.contact,
    taxInvoice: !!d.tax_invoice,
    vatRate: Number(d.vat_rate),
    pricesIncludeVat: d.price_mode === 'incl',
    lines: (d.lines || []).map(lineView),
    discount: Number(d.discount) || undefined,
    vatBase: Number(d.vat_base),
    netPayable: r2(Number(d.total) - Number(d.wht || 0)),
    payment: d.pay || undefined,
    whtCertificate: d.wht_cert || undefined,
    vendorBillNo: d.ref_no || undefined,
    notes: d.notes || undefined,
    publicLink: d.public_token ? `${ACC_BASE()}/doc.html?t=${d.public_token}` : undefined,
    appLink: docLink(d.id),
  };
}

const contactView = (c) => ({
  id: c.id, name: c.name, kind: c.kind, isCompany: c.is_company, taxId: c.tax_id || undefined, branch: c.branch || undefined,
  address: c.address || undefined, phone: c.phone || undefined, email: c.email || undefined,
  contactPerson: c.contact_name || undefined, creditDays: c.credit_days ?? undefined, note: c.note || undefined, archived: c.archived || undefined,
});

const itemView = (i, stock) => {
  const s = stock?.[i.id];
  return {
    id: i.id, name: i.name, kind: i.kind, sku: i.sku || undefined, unit: i.unit || undefined, price: Number(i.price),
    cost: Number(i.cost) || undefined, account: i.account || undefined, category: i.category || undefined,
    description: i.description || undefined, archived: i.archived || undefined,
    onHand: i.kind === 'stock' ? r2(Number(i.stock_open || 0) + (s?.bought || 0) - (s?.sold || 0)) : undefined,
  };
};

/* ---------- Finding things by what a person would say ---------- */

async function findDoc(ctx, b, ref) {
  if (isUuid(ref)) return (await ctx.call('GET', P(b, `/docs/${ref}`))).doc;
  const want = lc(ref).replace(/\s+/g, '');
  if (!want) fail('Pass document: its number (e.g. IV2026110001) or id.');
  const { docs } = await ctx.call('GET', P(b, '/docs'));
  const hit = docs.find((d) => lc(d.number) === want);
  if (!hit) fail(`No document numbered "${ref}" in ${b.name}. Use list_documents.`);
  return (await ctx.call('GET', P(b, `/docs/${hit.id}`))).doc;
}

function findIn(list, arg, label, keys) {
  const a = lc(arg);
  const exact = list.find((x) => x.id === arg) || list.find((x) => keys.some((k) => x[k] && lc(x[k]) === a));
  if (exact) return exact;
  const some = list.filter((x) => keys.some((k) => x[k] && lc(x[k]).includes(a)));
  if (some.length === 1) return some[0];
  if (some.length > 1) fail(`"${arg}" matches several ${label}: ${some.slice(0, 8).map((x) => `"${x.name}"`).join(', ')}. Be more specific or pass the id.`);
  return null;
}

const isMoney = (a) => a.type === 'asset' && (a.sys === 'cash' || a.sys === 'bank' || !!a.bank);

function payAccount(boot, arg, method) {
  const money = boot.accounts.filter((a) => isMoney(a) && a.active !== false);
  if (arg) {
    const a = money.find((x) => x.code === String(arg)) || findIn(money, String(arg), 'payment accounts', ['name', 'bank']);
    if (!a) fail(`"${arg}" is not a cash or bank account. Payment accounts: ${money.map((x) => `${x.code} ${x.name}`).join(', ')}.`);
    return a.code;
  }
  const sys = method === 'cash' ? 'cash' : 'bank';
  return (money.find((x) => x.sys === sys) || money[0])?.code;
}

function lineAccount(boot, arg, type) {
  if (!arg) return null;
  const allowed = type === 'EX' ? ['expense', 'asset'] : ['income'];
  const list = boot.accounts.filter((a) => allowed.includes(a.type) && !isMoney(a));
  const a = list.find((x) => x.code === String(arg)) || findIn(list, String(arg), 'accounts', ['name', 'name_en']);
  if (!a) fail(`"${arg}" is not ${type === 'EX' ? 'an expense or asset' : 'an income'} account. See list_accounts.`);
  return a.code;
}

/* ---------- The document a create_document call describes ---------- */

const METHODS = ['cash', 'transfer', 'cheque', 'card', 'other'];

// Turns the tool's arguments into the body POST /docs takes. Nothing is written here.
async function docBody(ctx, a) {
  const b = await ctx.biz(a.business);
  const boot = await ctx.boot(b);
  const type = a.type;
  if (!TYPE_NAME[type]) fail('type must be QT, IV, RE or EX.');
  const body = { type, date: isDate(a.date) ? a.date : bangkokToday() };
  if (a.date && !isDate(a.date)) fail('date must be YYYY-MM-DD.');
  if (a.due_date) { if (!isDate(a.due_date)) fail('due_date must be YYYY-MM-DD.'); body.due_date = a.due_date; }

  let src = null;
  if (a.from_document) {
    src = await findDoc(ctx, b, a.from_document);
    const ok = { IV: ['QT'], RE: ['QT', 'IV'], EX: [], QT: [] }[type];
    if (!ok.includes(src.type)) fail(`A ${type} cannot be made from a ${src.type}. Invoice from a quotation (QT→IV), receipt from an invoice or quotation (IV→RE, QT→RE).`);
    body.ref_id = src.id;
  }
  const fromInvoice = type === 'RE' && src?.type === 'IV';

  // Customer / vendor: one in the contact list, or a new one (added when the document is issued).
  let newContact = null;
  if (!fromInvoice) {
    if (src && !a.contact && !a.new_contact) {
      if (src.contact_id) body.contact_id = src.contact_id; else body.contact = src.contact;
    } else if (a.new_contact) {
      const n = a.new_contact;
      if (!n.name) fail('new_contact needs a name.');
      const dup = findIn(boot.contacts, n.name, 'contacts', ['name']);
      if (dup && lc(dup.name) === lc(n.name)) body.contact_id = dup.id;
      else {
        newContact = { kind: type === 'EX' ? 'vendor' : 'customer', is_company: n.is_company !== false, name: n.name, tax_id: n.tax_id, branch: n.branch, address: n.address, phone: n.phone, email: n.email };
        body.contact = newContact;
      }
    } else if (a.contact) {
      const c = findIn(boot.contacts.filter((x) => !x.archived || x.id === a.contact), String(a.contact), 'contacts', ['name', 'tax_id']);
      if (!c) fail(`No contact matches "${a.contact}" in ${b.name}. Use list_contacts, or pass new_contact with the details to add one.`);
      body.contact_id = c.id;
    } else fail(`Pass contact (an existing ${type === 'EX' ? 'vendor' : 'customer'}) or new_contact.`);
  }

  // Lines, from the arguments or copied from the source document.
  if (fromInvoice) {
    if (Array.isArray(a.lines) && a.lines.length) {
      body.lines = src.lines.map((l, i) => ({ wht: a.lines[i]?.wht_rate ?? l.wht }));
    }
  } else if (Array.isArray(a.lines) && a.lines.length) {
    body.lines = a.lines.slice(0, 200).map((l) => {
      let item = null;
      if (l.product) {
        item = findIn(boot.items, String(l.product), 'products', ['name', 'sku']);
        if (!item) fail(`No product / service matches "${l.product}". Use list_products, or leave product out.`);
      }
      const name = l.name || item?.name;
      if (!name) fail('Each line needs a name (or a product).');
      return {
        itemId: item?.id || null, name, desc: l.description ?? item?.description ?? '',
        qty: l.qty ?? 1, unit: l.unit ?? item?.unit ?? '', price: l.price ?? (item ? Number(type === 'EX' ? item.cost || item.price : item.price) : 0),
        disc: l.discount ?? 0, vat: l.vat !== false, wht: l.wht_rate ?? 0,
        account: lineAccount(boot, l.account, type) || (type !== 'EX' ? item?.account : null) || null,
      };
    });
  } else if (src) {
    body.lines = src.lines;
  } else fail('Pass lines: [{ name, qty, price, ... }].');

  if (!fromInvoice) {
    body.price_mode = a.prices_include_vat === true ? 'incl' : a.prices_include_vat === false ? 'excl' : (src?.price_mode || 'excl');
    body.discount = a.discount ?? (src ? Number(src.discount) : 0);
    if (type === 'EX') {
      body.tax_invoice = !!a.vat;
      body.vat_rate = a.vat ? 7 : 0;
    } else {
      const vat = a.vat ?? (src ? Number(src.vat_rate) > 0 : !!b.vat_registered);
      body.vat_rate = vat ? 7 : 0;
      if (type === 'IV') body.tax_invoice = !!a.tax_invoice;
    }
  }
  if (type === 'EX') {
    if (a.vendor_bill_no) body.ref_no = String(a.vendor_bill_no).slice(0, 60);
    if (a.vendor_bill_date) { if (!isDate(a.vendor_bill_date)) fail('vendor_bill_date must be YYYY-MM-DD.'); body.ref_date = a.vendor_bill_date; }
    if (a.wht_income) body.wht_income = a.wht_income;
  }
  if (type === 'RE' || (type === 'EX' && a.paid)) {
    const p = a.paid || {};
    const method = METHODS.includes(p.method) ? p.method : 'transfer';
    if (p.date && !isDate(p.date)) fail('paid.date must be YYYY-MM-DD.');
    body.pay = { account: payAccount(boot, p.account, method), date: p.date || body.date, method, fee: p.fee || 0, note: p.note || null };
  }
  if (type === 'QT' && ['open', 'accepted', 'rejected'].includes(a.status)) body.status = a.status;
  if (a.notes) body.notes = String(a.notes).slice(0, 2000);
  return { b, boot, body, src, newContact };
}

function previewOf(b, built, x) {
  const d = built;
  return {
    business: b.name,
    document: TYPE_NAME[d.type],
    number: 'given when issued',
    date: d.date,
    dueDate: d.due_date || undefined,
    from: x.src ? `${x.src.number}` : undefined,
    contact: { ...d.contact, newContact: x.newContact ? 'will be added to the contact list' : undefined },
    lines: (d.lines || []).map(lineView),
    pricesIncludeVat: d.price_mode === 'incl',
    subtotal: d.subtotal, discount: d.discount || undefined, vatRate: d.vat_rate, vat: d.vat, total: d.total,
    withholdingTax: d.wht || undefined, netPayable: r2(d.total - (d.wht || 0)),
    taxInvoice: d.tax_invoice || undefined,
    payment: d.pay || undefined,
    notes: d.notes || undefined,
  };
}

/* ---------- Tools ---------- */

const bizArg = { type: 'string', description: 'Business name or id (list_businesses). Can be left out when the person has only one business.' };
const docArg = { type: 'string', description: 'Document number (e.g. IV2026110001) or id.' };
const idemArg = { type: 'string', description: 'A fresh UUID per user request, so a retry cannot do it twice.' };
const confirmArg = { type: 'string', description: 'Only after the user confirmed the preview: the confirm_token from the previous answer.' };
const monthArg = { type: 'string', description: 'Month YYYY-MM.' };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: 'list_businesses',
    title: 'List businesses',
    description: 'The businesses (กิจการ) this person belongs to in Centel Account, with their position in each. Positions limit what can be seen and done.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (ctx) => ({ today: bangkokToday(), businesses: (await ctx.businesses()).map(bizView) }),
  },
  {
    name: 'get_overview',
    title: 'Business overview',
    description: 'A month at a glance for one business: income, expenses, profit, cash and bank balances, money customers owe (AR) and owed to vendors (AP, with overdue), VAT for the month, six-month trend and recent documents.',
    inputSchema: { type: 'object', properties: { business: bizArg, month: monthArg }, additionalProperties: false },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const r = await ctx.call('GET', P(b, '/reports/dashboard'), { query: { month: isYm(a.month) ? a.month : undefined } });
      return { business: bizView(b), today: bangkokToday(), ...r, recent: (r.recent || []).map(docRow) };
    },
  },
  {
    name: 'list_documents',
    title: 'List documents',
    description: 'Quotations (QT), invoices (IV), receipts (RE) and expenses (EX), newest first. Filter by type, month or date range, status (QT: open/accepted/rejected; IV: open/paid; EX: open/paid; any: void), customer / vendor, or text in the number or contact name.',
    inputSchema: {
      type: 'object',
      properties: {
        business: bizArg,
        type: { type: 'string', enum: ['QT', 'IV', 'RE', 'EX'] },
        month: monthArg,
        from: { type: 'string', description: 'Start date YYYY-MM-DD.' },
        to: { type: 'string', description: 'End date YYYY-MM-DD.' },
        status: { type: 'string', enum: ['open', 'accepted', 'rejected', 'paid', 'done', 'void'] },
        contact: { type: 'string', description: 'Customer / vendor name or id.' },
        text: { type: 'string', description: 'Words in the document number or contact name.' },
        made_by_ai: { type: 'boolean', description: 'Only documents an AI app issued.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 50.' },
      },
      additionalProperties: false,
    },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const q = { type: a.type, status: a.status, via: a.made_by_ai ? 'ai' : undefined };
      if (isYm(a.month)) Object.assign(q, monthRange(a.month));
      if (isDate(a.from)) q.from = a.from;
      if (isDate(a.to)) q.to = a.to;
      if (a.contact) {
        const c = findIn((await ctx.boot(b)).contacts, String(a.contact), 'contacts', ['name', 'tax_id']);
        if (!c) fail(`No contact matches "${a.contact}". Use list_contacts.`);
        q.contact = c.id;
      }
      let docs = (await ctx.call('GET', P(b, '/docs'), { query: q })).docs;
      if (a.text) {
        const s = lc(a.text);
        docs = docs.filter((d) => lc(`${d.number} ${d.contact_name || ''}`).includes(s));
      }
      const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500);
      const live = docs.filter((d) => d.status !== 'void');
      return {
        business: b.name, matched: docs.length,
        totals: { total: r2(live.reduce((s, d) => s + Number(d.total), 0)), vat: r2(live.reduce((s, d) => s + Number(d.vat), 0)) },
        documents: docs.slice(0, limit).map(docRow), truncated: docs.length > limit || undefined,
      };
    },
  },
  {
    name: 'get_document',
    title: 'Get a document',
    description: 'One document in full: customer / vendor, lines, VAT, withholding tax, payment, the documents it came from and led to, and the journal lines it posted.',
    inputSchema: { type: 'object', properties: { business: bizArg, document: docArg }, required: ['document'], additionalProperties: false },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const d = await findDoc(ctx, b, a.document);
      const full = await ctx.call('GET', P(b, `/docs/${d.id}`));
      return {
        business: b.name, ...docFull(full.doc), madeBy: full.doc.created_via ? `AI: ${full.doc.created_via}` : full.issuer?.name,
        from: full.ref ? { type: full.ref.type, number: full.ref.number } : undefined,
        followUps: full.children.map((c) => ({ type: c.type, number: c.number, status: c.status, total: Number(c.total) })),
        journal: full.journal.map((j) => ({ date: String(j.date).slice(0, 10), account: `${j.account} ${j.name || ''}`.trim(), debit: Number(j.debit) || undefined, credit: Number(j.credit) || undefined })),
      };
    },
  },
  {
    name: 'list_contacts',
    title: 'List customers and vendors',
    description: 'Customers and vendors (ผู้ติดต่อ) with tax ID, branch, address and credit days.',
    inputSchema: {
      type: 'object',
      properties: { business: bizArg, kind: { type: 'string', enum: ['customer', 'vendor'] }, text: { type: 'string', description: 'Words in the name, tax ID, email or phone.' }, include_archived: { type: 'boolean' } },
      additionalProperties: false,
    },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      let list = (await ctx.boot(b)).contacts;
      if (!a.include_archived) list = list.filter((c) => !c.archived);
      if (a.kind) list = list.filter((c) => c.kind === a.kind || c.kind === 'both');
      if (a.text) { const s = lc(a.text); list = list.filter((c) => lc(`${c.name} ${c.tax_id || ''} ${c.email || ''} ${c.phone || ''}`).includes(s)); }
      return { business: b.name, count: list.length, contacts: list.slice(0, 300).map(contactView) };
    },
  },
  {
    name: 'list_products',
    title: 'List products and services',
    description: 'Products and services (สินค้า / บริการ) with price, unit, SKU, income account and stock on hand for stock items.',
    inputSchema: { type: 'object', properties: { business: bizArg, text: { type: 'string' }, include_archived: { type: 'boolean' } }, additionalProperties: false },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      let list = (await ctx.boot(b)).items;
      if (!a.include_archived) list = list.filter((i) => !i.archived);
      if (a.text) { const s = lc(a.text); list = list.filter((i) => lc(`${i.name} ${i.sku || ''} ${i.category || ''}`).includes(s)); }
      const stock = list.some((i) => i.kind === 'stock') ? (await ctx.call('GET', P(b, '/stock'))).stock : {};
      return { business: b.name, count: list.length, products: list.slice(0, 300).map((i) => itemView(i, stock)) };
    },
  },
  {
    name: 'list_accounts',
    title: 'Chart of accounts',
    description: 'The chart of accounts (ผังบัญชี): codes and names. Income accounts go on sales lines, expense or asset accounts on expense lines, and cash / bank accounts (payment: true) receive or pay money.',
    inputSchema: { type: 'object', properties: { business: bizArg }, additionalProperties: false },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      return { business: b.name, accounts: (await ctx.boot(b)).accounts.filter((x) => x.active !== false).map((x) => ({ code: x.code, name: x.name, nameEn: x.name_en || undefined, type: x.type, payment: isMoney(x) || undefined, bank: x.bank || undefined })) };
    },
  },
  {
    name: 'get_report',
    title: 'Accounting report',
    description: 'A report for a month or date range: pnl (profit and loss), balance (balance sheet, as of `to`), trial (trial balance), ledger (one account, pass account), sales (sales summary), ar / ap (open invoices / unpaid expenses), vat_sales / vat_purchase (VAT reports), vat_summary, vat_pp36, wht_pay (WHT we withheld: ภ.ง.ด.3/53), wht_recv (WHT customers withheld).',
    inputSchema: {
      type: 'object',
      properties: {
        business: bizArg,
        report: { type: 'string', enum: REPORTS.filter((r) => r !== 'dashboard') },
        month: monthArg,
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        account: { type: 'string', description: 'Account code, for ledger.' },
      },
      required: ['report'],
      additionalProperties: false,
    },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      if (!REPORTS.includes(a.report) || a.report === 'dashboard') fail('Unknown report.');
      const q = { month: isYm(a.month) ? a.month : undefined, from: isDate(a.from) ? a.from : undefined, to: isDate(a.to) ? a.to : undefined, account: a.account };
      return { business: b.name, report: a.report, ...(await ctx.call('GET', P(b, `/reports/${a.report}`), { query: q })) };
    },
  },
  {
    name: 'search',
    title: 'Search',
    description: 'Search documents (by number or customer / vendor) and contacts across the person\'s businesses. Returns ids for fetch.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run: async (ctx, a) => {
      const words = lc(a.query).split(/\s+/).filter(Boolean);
      const hit = (s) => words.every((w) => lc(s).includes(w));
      const results = [];
      for (const b of await ctx.businesses()) {
        const boot = await ctx.boot(b).catch(() => null);
        if (!boot) continue;
        const docs = await ctx.call('GET', P(b, '/docs')).then((r) => r.docs).catch(() => []);
        for (const d of docs) {
          if (results.length >= 40) break;
          if (words.length && hit(`${d.number} ${d.contact_name || ''} ${d.type}`)) {
            results.push({ id: `doc:${b.id}:${d.id}`, title: `${d.number} · ${d.contact_name || ''} · ${Number(d.total).toLocaleString('en-US')} บาท`, url: docLink(d.id) });
          }
        }
        for (const c of boot.contacts) {
          if (results.length >= 50) break;
          if (words.length && hit(`${c.name} ${c.tax_id || ''}`)) results.push({ id: `contact:${b.id}:${c.id}`, title: `${c.name} (${b.name})`, url: `${ACC_BASE()}/#/contacts` });
        }
      }
      return { results };
    },
  },
  {
    name: 'fetch',
    title: 'Fetch',
    description: 'Full details of one search result: doc:<business>:<id> or contact:<business>:<id>.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: async (ctx, a) => {
      const [kind, bizId, id] = String(a.id || '').split(':');
      const b = await ctx.biz(bizId);
      if (kind === 'doc' && isUuid(id)) {
        const full = await ctx.call('GET', P(b, `/docs/${id}`));
        const doc = docFull(full.doc);
        return { id: a.id, title: `${doc.number} ${doc.contact?.name || ''}`, text: JSON.stringify(doc), url: doc.appLink, metadata: { business: b.name, type: doc.type } };
      }
      if (kind === 'contact' && isUuid(id)) {
        const c = (await ctx.boot(b)).contacts.find((x) => x.id === id);
        if (c) return { id: a.id, title: c.name, text: JSON.stringify(contactView(c)), url: `${ACC_BASE()}/#/contacts`, metadata: { business: b.name } };
      }
      fail(`Not found: ${a.id}`);
    },
  },

  /* ----- Changes (scope acc.write) ----- */

  {
    name: 'create_document',
    title: 'Issue a document',
    scope: 'acc.write',
    description: 'Issue a quotation (QT), invoice (IV), receipt (RE) or record an expense / purchase bill (EX). Always answers first with status "needs_confirmation": the document as it will be saved (totals, VAT, withholding tax) and a confirm_token. Show it, and only after the user says yes call again with the same arguments plus confirm_token. Issued documents get the next running number and post to the books; mistakes are fixed by void_document. '
      + 'Make an invoice from a quotation with from_document (lines and customer are copied unless given), and a receipt for an invoice with type RE + from_document = the invoice (its lines are used). A receipt (and a paid expense) records money in a cash or bank account: paid.account, default the bank account for transfers or cash for cash. VAT: sales documents follow the business\'s VAT registration unless vat is given; expenses have VAT only with a tax invoice (vat: true).',
    inputSchema: {
      type: 'object',
      properties: {
        business: bizArg,
        type: { type: 'string', enum: ['QT', 'IV', 'RE', 'EX'] },
        contact: { type: 'string', description: 'Existing customer (QT/IV/RE) or vendor (EX): name, tax ID or id.' },
        new_contact: {
          type: 'object',
          description: 'A customer / vendor not in the list yet; it is added when the document is issued.',
          properties: { name: { type: 'string' }, is_company: { type: 'boolean' }, tax_id: { type: 'string' }, branch: { type: 'string', description: '00000 for head office.' }, address: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } },
          required: ['name'], additionalProperties: false,
        },
        from_document: { type: 'string', description: 'Quotation or invoice this one follows (number or id).' },
        date: { type: 'string', description: 'YYYY-MM-DD. Default today in Thailand.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD (QT valid until, IV due, EX due).' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product: { type: 'string', description: 'Product / service name, SKU or id from list_products (fills name, price, unit, account).' },
              name: { type: 'string' }, description: { type: 'string' },
              qty: { type: 'number' }, unit: { type: 'string' }, price: { type: 'number', description: 'Unit price in baht.' },
              discount: { type: 'number', description: 'Discount on this line, baht.' },
              vat: { type: 'boolean', description: 'false for a VAT-exempt line.' },
              wht_rate: { type: 'number', enum: [0, 1, 1.5, 2, 3, 5, 10, 15], description: 'Withholding tax % on this line (e.g. 3 for services).' },
              account: { type: 'string', description: 'Account code or name (list_accounts): income for sales, expense / asset for EX.' },
            },
            additionalProperties: false,
          },
        },
        vat: { type: 'boolean', description: 'Charge / claim 7% VAT.' },
        prices_include_vat: { type: 'boolean', description: 'Prices already include VAT. Default false.' },
        tax_invoice: { type: 'boolean', description: 'IV only: the invoice is also the tax invoice (ใบแจ้งหนี้/ใบกำกับภาษี). Default false: the receipt is.' },
        discount: { type: 'number', description: 'Discount on the whole document, baht.' },
        paid: {
          type: 'object',
          description: 'RE: where the money came in. EX: give it when the bill is already paid.',
          properties: { account: { type: 'string', description: 'Cash / bank account code or name.' }, date: { type: 'string' }, method: { type: 'string', enum: METHODS }, fee: { type: 'number', description: 'Bank fee, baht.' }, note: { type: 'string' } },
          additionalProperties: false,
        },
        vendor_bill_no: { type: 'string', description: 'EX: the vendor\'s bill / tax invoice number.' },
        vendor_bill_date: { type: 'string', description: 'EX: date on the vendor\'s bill.' },
        wht_income: { type: 'string', description: 'EX with withholding tax: type of income on the 50 ทวิ, e.g. ค่าบริการ, ค่าเช่า, ค่าจ้างทำของ, ค่าโฆษณา, ค่าขนส่ง.' },
        status: { type: 'string', enum: ['open', 'accepted', 'rejected'], description: 'QT only.' },
        notes: { type: 'string', description: 'Remarks printed on the document.' },
        idempotency_key: idemArg,
        confirm_token: confirmArg,
      },
      required: ['type'],
      additionalProperties: false,
    },
    confirm: async (ctx, a) => {
      const x = await docBody(ctx, a);
      const { preview } = await ctx.call('POST', P(x.b, '/docs'), { body: x.body, preview: true });
      return previewOf(x.b, preview, x);
    },
    run: async (ctx, a) => {
      const x = await docBody(ctx, a);
      if (x.newContact) {
        const { contact } = await ctx.call('POST', P(x.b, '/contacts'), { body: x.newContact });
        delete x.body.contact;
        x.body.contact_id = contact.id;
      }
      const { doc } = await ctx.call('POST', P(x.b, '/docs'), { body: x.body });
      return { status: 'created', business: x.b.name, document: docFull(doc) };
    },
  },
  {
    name: 'pay_expense',
    title: 'Record an expense as paid',
    scope: 'acc.write',
    description: 'Mark an expense (EX) as paid from a cash or bank account, or take the payment off (unpaid: true). Answers first with a preview and confirm_token; call again with confirm_token after the user says yes. Receipts for invoices are issued with create_document type RE instead.',
    inputSchema: {
      type: 'object',
      properties: {
        business: bizArg, document: docArg,
        account: { type: 'string', description: 'Cash / bank account code or name. Default the bank account (cash when method is cash).' },
        date: { type: 'string', description: 'YYYY-MM-DD. Default today.' },
        method: { type: 'string', enum: METHODS },
        fee: { type: 'number' },
        unpaid: { type: 'boolean', description: 'Take the payment off instead.' },
        confirm_token: confirmArg,
      },
      required: ['document'],
      additionalProperties: false,
    },
    confirm: async (ctx, a) => {
      const { b, d, body } = await payBody(ctx, a);
      return { business: b.name, document: d.number, contact: d.contact?.name, total: Number(d.total), wht: Number(d.wht) || undefined, netPaid: r2(Number(d.total) - Number(d.wht || 0)), action: body.pay ? 'mark paid' : 'mark unpaid', payment: body.pay || undefined };
    },
    run: async (ctx, a) => {
      const { b, d, body } = await payBody(ctx, a);
      const { doc } = await ctx.call('POST', P(b, `/docs/${d.id}/pay`), { body });
      return { status: 'updated', business: b.name, document: docFull(doc) };
    },
  },
  {
    name: 'void_document',
    title: 'Void a document',
    scope: 'acc.write',
    destructive: true,
    description: 'Void (ยกเลิก) a document: it keeps its number, is marked void and its journal lines are taken off the books. An invoice with a receipt needs the receipt voided first. Answers first with a preview and confirm_token; call again with confirm_token only after the user says yes.',
    inputSchema: { type: 'object', properties: { business: bizArg, document: docArg, reason: { type: 'string' }, confirm_token: confirmArg }, required: ['document'], additionalProperties: false },
    confirm: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const d = await findDoc(ctx, b, a.document);
      if (d.status === 'void') fail(`${d.number} is already void.`);
      return { business: b.name, action: 'void', document: d.number, type: TYPE_NAME[d.type], date: String(d.date).slice(0, 10), contact: d.contact?.name, total: Number(d.total), reason: a.reason || undefined };
    },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const d = await findDoc(ctx, b, a.document);
      await ctx.call('POST', P(b, `/docs/${d.id}/void`), { body: { reason: a.reason } });
      return { status: 'voided', business: b.name, document: d.number, appLink: docLink(d.id) };
    },
  },
  {
    name: 'set_quotation_status',
    title: 'Set quotation status',
    scope: 'acc.write',
    description: 'Mark a quotation open, accepted (อนุมัติ) or rejected (ไม่อนุมัติ).',
    inputSchema: { type: 'object', properties: { business: bizArg, document: docArg, status: { type: 'string', enum: ['open', 'accepted', 'rejected'] } }, required: ['document', 'status'], additionalProperties: false },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const d = await findDoc(ctx, b, a.document);
      if (d.type !== 'QT') fail(`${d.number} is not a quotation.`);
      await ctx.call('POST', P(b, `/docs/${d.id}/status`), { body: { status: a.status } });
      return { status: 'updated', document: d.number, quotationStatus: a.status };
    },
  },
  {
    name: 'share_document',
    title: 'Get a share link',
    scope: 'acc.write',
    description: 'A public link to view and download one document as PDF, for sending to the customer. stop: true turns the link off.',
    inputSchema: { type: 'object', properties: { business: bizArg, document: docArg, stop: { type: 'boolean' } }, required: ['document'], additionalProperties: false },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const d = await findDoc(ctx, b, a.document);
      const { token } = await ctx.call('POST', P(b, `/docs/${d.id}/share`), { body: { off: a.stop === true } });
      return token ? { status: 'shared', document: d.number, link: `${ACC_BASE()}/doc.html?t=${token}` } : { status: 'unshared', document: d.number };
    },
  },
  {
    name: 'create_contact',
    title: 'Add a customer or vendor',
    scope: 'acc.write',
    description: 'Add a customer or vendor to the contact list. Answers "already_exists" (nothing added) when one with the same name or tax ID + branch is there.',
    inputSchema: {
      type: 'object',
      properties: {
        business: bizArg, name: { type: 'string' }, kind: { type: 'string', enum: ['customer', 'vendor', 'both'] }, is_company: { type: 'boolean' },
        tax_id: { type: 'string' }, branch: { type: 'string', description: '00000 for head office.' }, address: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
        contact_person: { type: 'string' }, credit_days: { type: 'integer', minimum: 0, maximum: 365 }, note: { type: 'string' }, idempotency_key: idemArg,
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const tax = String(a.tax_id || '').replace(/\D/g, '');
      const dup = (await ctx.boot(b)).contacts.find((c) => lc(c.name) === lc(a.name) || (tax && c.tax_id === tax && (c.branch || '') === (a.branch || c.branch || '')));
      if (dup) return { status: 'already_exists', contact: contactView(dup) };
      const { contact } = await ctx.call('POST', P(b, '/contacts'), {
        body: { name: a.name, kind: a.kind, is_company: a.is_company, tax_id: a.tax_id, branch: a.branch, address: a.address, phone: a.phone, email: a.email, contact_name: a.contact_person, credit_days: a.credit_days, note: a.note },
      });
      return { status: 'created', business: b.name, contact: contactView(contact) };
    },
  },
  {
    name: 'create_product',
    title: 'Add a product or service',
    scope: 'acc.write',
    description: 'Add a product or service to the list. Answers "already_exists" (nothing added) when one with the same name or SKU is there.',
    inputSchema: {
      type: 'object',
      properties: {
        business: bizArg, name: { type: 'string' }, kind: { type: 'string', enum: ['service', 'product', 'stock'], description: 'stock = count stock on hand.' },
        price: { type: 'number', description: 'Selling price, baht.' }, cost: { type: 'number' }, unit: { type: 'string' }, sku: { type: 'string' },
        category: { type: 'string' }, description: { type: 'string' }, account: { type: 'string', description: 'Income account code or name.' }, idempotency_key: idemArg,
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (ctx, a) => {
      const b = await ctx.biz(a.business);
      const boot = await ctx.boot(b);
      const dup = boot.items.find((i) => lc(i.name) === lc(a.name) || (a.sku && lc(i.sku) === lc(a.sku)));
      if (dup) return { status: 'already_exists', product: itemView(dup) };
      const { item } = await ctx.call('POST', P(b, '/items'), {
        body: { name: a.name, kind: a.kind, price: a.price, cost: a.cost, unit: a.unit, sku: a.sku, category: a.category, description: a.description, account: lineAccount(boot, a.account, 'IV') },
      });
      return { status: 'created', business: b.name, product: itemView(item) };
    },
  },
];

async function payBody(ctx, a) {
  const b = await ctx.biz(a.business);
  const d = await findDoc(ctx, b, a.document);
  if (d.type !== 'EX') fail(`${d.number} is not an expense. Receipts for invoices are issued with create_document type RE.`);
  if (d.status === 'void') fail(`${d.number} is void.`);
  if (a.unpaid) return { b, d, body: { pay: null } };
  if (a.date && !isDate(a.date)) fail('date must be YYYY-MM-DD.');
  const method = METHODS.includes(a.method) ? a.method : 'transfer';
  return { b, d, body: { pay: { account: payAccount(await ctx.boot(b), a.account, method), date: a.date || bangkokToday(), method, fee: a.fee || 0 } } };
}

const INSTRUCTIONS = [
  'Centel Account (account.centel.app) is a Thai SME accounting app: quotations (QT), invoices (IV), receipts / tax invoices (RE) and expenses (EX), customers and vendors, products, a double-entry ledger, VAT (ภ.พ.30) and withholding tax (50 ทวิ, ภ.ง.ด.3/53) reports.',
  'A person can belong to several businesses; pass business when they have more than one (list_businesses). What they can see and do follows their position in each business.',
  'Money is Thai baht. Dates are YYYY-MM-DD in Thailand time; list_businesses returns today.',
  'Issuing, paying or voiding a document answers first with status "needs_confirmation", a preview and a confirm_token. Show the preview (lines, VAT, withholding tax, total), wait for the user to clearly say yes, then call again with exactly the same arguments plus confirm_token. Never confirm on the user\'s behalf. If they want changes, call again without the token for a new preview.',
  'Never say a document was issued, paid or voided unless the answer\'s status says so (created / updated / voided). Send a fresh idempotency_key (UUID) per request on create calls. Issued documents cannot be deleted, only voided.',
  'Usual flow: quotation → invoice (from_document = the QT) → receipt (type RE, from_document = the IV). Answer in the user\'s language (usually Thai).',
].join(' ');

/* ---------- Confirmation and idempotency (same tables as Centel's MCP, see mcpwrite.js) ---------- */

const NEEDS_CONFIRM = 'Nothing has been done yet. Show the preview to the user in their language and ask them to confirm. Only after they clearly say yes, call this tool again with exactly the same arguments plus confirm_token.';

async function runTool(tool, a, user) {
  const ctx = makeCtx(user);
  if (!tool.scope) return tool.run(ctx, a);
  const name = `acc.${tool.name}`;
  const hash = argsHash(name, a);
  const db = (fn) => asUser(user.id, fn);
  const key = a.idempotency_key;
  if (key != null) {
    if (typeof key !== 'string' || !KEY_RX.test(key)) fail('idempotency_key must be 8–200 letters, digits, dots, dashes, colons or underscores');
    const prev = await db(async (c) => (await c.query('select tool, args_hash, result from mcp_idem where key = $1', [key])).rows[0]);
    if (prev) {
      if (prev.tool !== name || prev.args_hash !== hash) fail('This idempotency_key was already used for a different request. Use a new key.');
      return { ...prev.result, replayed: true, note: 'Already done earlier with this idempotency_key; nothing was done again.' };
    }
  }
  let out;
  if (tool.confirm && a.confirm_token == null) {
    const preview = await tool.confirm(ctx, a);
    const id = crypto.randomUUID();
    await db(async (c) => {
      await c.query("delete from mcp_confirms where expires_at < now() - interval '1 day'");
      await c.query('insert into mcp_confirms (id, tool, args_hash, preview, expires_at) values ($1, $2, $3, $4, $5)',
        [id, name, hash, JSON.stringify(preview), new Date(Date.now() + CONFIRM_SEC * 1000)]);
    });
    return { status: 'needs_confirmation', confirm_token: id, expires_in_seconds: CONFIRM_SEC, preview, message: NEEDS_CONFIRM };
  }
  if (tool.confirm) {
    const token = a.confirm_token;
    if (typeof token !== 'string' || !isUuid(token)) fail('confirm_token is not valid. Call again without it to get a new preview.');
    // Claim the token first so two calls with it cannot both issue the document.
    const c = await db(async (q) => {
      const row = (await q.query('select * from mcp_confirms where id = $1 for update', [token])).rows[0];
      if (!row) fail('Unknown confirm_token. Call again without it to get a new preview.');
      if (row.tool !== name || row.args_hash !== hash) fail('This confirm_token was given for different details. Nothing was done. Get a new preview (call without confirm_token) and confirm again.');
      if (row.used_at) return row;
      if (new Date(row.expires_at) < new Date()) fail('This confirm_token has expired (10 minutes). Call again without it for a new preview.');
      await q.query('update mcp_confirms set used_at = now() where id = $1', [token]);
      return { ...row, claimed: true };
    });
    if (!c.claimed) {
      if (c.result) return { ...c.result, replayed: true, note: 'This confirmation was already used; nothing was done again.' };
      fail('This confirm_token is already being used.');
    }
    try {
      out = await tool.run(ctx, a);
    } catch (e) {
      await db((q) => q.query('update mcp_confirms set used_at = null where id = $1', [token])).catch(() => {});
      throw e;
    }
    await db((q) => q.query('update mcp_confirms set result = $2 where id = $1', [token, JSON.stringify(out)]));
  } else {
    out = await tool.run(ctx, a);
  }
  if (key != null) {
    await db(async (q) => {
      await q.query("delete from mcp_idem where created_at < now() - interval '30 days'");
      await q.query('insert into mcp_idem (key, tool, args_hash, result) values ($1, $2, $3, $4) on conflict do nothing', [key, name, hash, JSON.stringify(out)]);
    });
  }
  return out;
}

/* ---------- JSON-RPC ---------- */

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg, user) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcErr(msg?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  if (id === undefined) return null;
  switch (method) {
    case 'initialize': {
      const want = params.protocolVersion;
      return rpcOk(id, {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'centel-account', title: 'Centel Account', version: '1.0.0', websiteUrl: ACC_BASE() },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return rpcOk(id, {});
    case 'tools/list':
      return rpcOk(id, { tools: TOOLS.map(({ name, title, description, inputSchema, scope, destructive }) => ({
        name, title, description, inputSchema,
        annotations: { title, ...(scope ? { ...WRITE, destructiveHint: !!destructive } : RO) },
      })) });
    case 'resources/list': return rpcOk(id, { resources: [] });
    case 'resources/templates/list': return rpcOk(id, { resourceTemplates: [] });
    case 'prompts/list': return rpcOk(id, { prompts: [] });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcErr(id, -32602, `Unknown tool: ${params.name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      if (tool.scope && !user.scopes?.has(tool.scope)) {
        return rpcOk(id, { content: [{ type: 'text', text: 'This connection is read-only. Nothing was changed. To let the AI issue documents, reconnect Centel Account in the AI app and tick "ให้สร้างเอกสารได้".' }], isError: true });
      }
      try {
        const out = await runTool(tool, args, user);
        return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('acc mcp tool', tool.name, e);
        const text = e instanceof ToolError ? e.message : tool.scope ? 'Centel Account could not do that right now. Nothing was changed.' : 'Centel Account could not read that right now.';
        return rpcOk(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default: return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

export const accMcpRouter = express.Router();
accMcpRouter.use(cors);
accMcpRouter.options('/', (_req, res) => res.sendStatus(204));
accMcpRouter.get('/', bearer, (_req, res) => res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }));
accMcpRouter.delete('/', (_req, res) => res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }));
accMcpRouter.post('/', bearer, wrap(async (req, res) => {
  const body = req.body;
  // The accounting API wants the person as loadUser would give it.
  const u = req.mcpUser;
  const person = (await pool.query(
    `select u.id, coalesce(u.email, p.email) as email, u.display_name, u.parent_id from users u left join users p on p.id = u.parent_id where u.id = $1`, [u.id])).rows[0];
  if (!person) return res.status(401).json({ error: 'invalid_token' });
  const user = { ...person, grantId: u.grantId, client: u.client, scopes: u.scopes };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, user)))).filter(Boolean);
    return out.length ? res.json(out) : res.sendStatus(202);
  }
  const out = await handle(body, user);
  if (!out) return res.sendStatus(202);
  res.json(out);
}));

