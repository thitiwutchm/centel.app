// Accounting API for account.centel.app, mounted at /api/acc. Every request about a
// business runs as app_user (asUser), so the row level security in
// migrations/032_accounting.sql keeps each person inside their own businesses.
import crypto from 'node:crypto';
import express from 'express';
import { pool, asUser } from '../db.js';
import { requireUser, rateLimit } from '../auth.js';
import { putReceipt, receiptUrl, storageEnabled } from '../storage.js';
import {
  DEFAULT_ACCOUNTS, DEFAULT_PREFIX, DOC_TYPES, computeTotals, postingsFor, balanced, counterKey, docNumber,
} from './ledger.js';
import { report, REPORTS } from './reports.js';
import { readPurchaseDoc } from './ai.js';

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const str = (v, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
const LOGO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
// PromptPay: a 10-digit mobile number, 13-digit tax / citizen ID or 15-digit e-wallet ID.
const promptPayId = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return (d.length === 10 && d[0] === '0') || d.length === 13 || d.length === 15 ? d : null;
};
const bangkokToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

/* ---------- Public document link (no sign-in) ---------- */

router.get('/public/:token', rateLimit(300, 60 * 60000), wrap(async (req, res) => {
  const token = String(req.params.token);
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw bad('not_found', 404);
  const d = (await pool.query('select * from acc_docs where public_token = $1', [token])).rows[0];
  if (!d) throw bad('not_found', 404);
  const b = (await pool.query('select * from acc_businesses where id = $1', [d.business_id])).rows[0];
  const ref = d.ref_id ? (await pool.query('select type, number, date from acc_docs where id = $1', [d.ref_id])).rows[0] : null;
  res.set('Cache-Control', 'no-store').json({ doc: publicDoc(d, ref), business: publicBusiness(b) });
}));

router.use(requireUser);
const tx = (req, fn) => asUser(req.user.id, fn);

/* ---------- Businesses ---------- */

router.get('/businesses', wrap(async (req, res) => {
  const rows = await tx(req, async (db) => (await db.query(
    `select b.id, b.name, b.logo, b.tax_id, b.vat_registered, m.role
     from acc_businesses b join acc_members m on m.business_id = b.id and m.user_id = app_uid()
     order by b.created_at`)).rows);
  res.json({ businesses: rows, user: { email: req.user.email, name: req.user.display_name } });
}));

router.post('/businesses', rateLimit(30, 60 * 60000), wrap(async (req, res) => {
  const name = str(req.body.name, 200);
  if (!name) throw bad('bad_name');
  const id = await tx(req, async (db) => {
    const b = (await db.query('select acc_new_business($1) as id', [name])).rows[0].id;
    for (const a of DEFAULT_ACCOUNTS) {
      await db.query('insert into acc_accounts (business_id, code, name, name_en, type, sys) values ($1, $2, $3, $4, $5, $6)',
        [b, a.code, a.name, a.name_en, a.type, a.sys]);
    }
    await db.query(`update acc_businesses set settings = $2 where id = $1`, [b, { prefixes: DEFAULT_PREFIX, fyStart: 1 }]);
    await updateBusiness(db, b, req.body);
    return b;
  });
  res.json({ id });
}));

const biz = express.Router({ mergeParams: true });
router.use('/b/:biz', wrap(async (req, _res, next) => {
  if (!isUuid(req.params.biz)) throw bad('not_found', 404);
  const row = await tx(req, async (db) => (await db.query(
    `select b.*, m.role from acc_businesses b join acc_members m on m.business_id = b.id and m.user_id = app_uid()
     where b.id = $1`, [req.params.biz])).rows[0]);
  if (!row) throw bad('not_found', 404);
  req.biz = row;
  if (req.method !== 'GET' && row.role === 'viewer') throw bad('forbidden', 403);
  next();
}), biz);

const B = (req) => req.biz.id;

async function updateBusiness(db, id, body) {
  const fields = {
    name: body.name !== undefined ? str(body.name, 200) : undefined,
    name_en: body.name_en !== undefined ? str(body.name_en, 200) : undefined,
    tax_id: body.tax_id !== undefined ? str(String(body.tax_id ?? '').replace(/\D/g, ''), 13) : undefined,
    branch: body.branch !== undefined ? (str(body.branch, 40) || '00000') : undefined,
    address: body.address !== undefined ? str(body.address, 600) : undefined,
    phone: body.phone !== undefined ? str(body.phone, 60) : undefined,
    email: body.email !== undefined ? str(body.email, 200) : undefined,
    website: body.website !== undefined ? str(body.website, 200) : undefined,
    logo: body.logo !== undefined ? (typeof body.logo === 'string' && body.logo.length < 400000 && LOGO.test(body.logo) ? body.logo : null) : undefined,
    vat_registered: body.vat_registered !== undefined ? !!body.vat_registered : undefined,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || (k === 'name' && !v)) continue;
    await db.query(`update acc_businesses set ${k} = $2 where id = $1`, [id, v]);
  }
  if (body.settings && typeof body.settings === 'object') {
    const s = body.settings;
    const prefixes = {};
    for (const k of Object.keys(DEFAULT_PREFIX)) {
      const p = String(s.prefixes?.[k] ?? DEFAULT_PREFIX[k]).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);
      prefixes[k] = p || DEFAULT_PREFIX[k];
    }
    const notes = {};
    for (const k of DOC_TYPES) notes[k] = str(s.notes?.[k], 1000);
    const clean = {
      prefixes,
      notes,
      payment: str(s.payment, 600),
      // Bank accounts printed on quotations and invoices, and the PromptPay ID their QR pays into.
      banks: (Array.isArray(s.banks) ? s.banks : []).slice(0, 4).map((b) => ({
        bank: str(b?.bank, 100), number: str(b?.number, 40), name: str(b?.name, 200), branch: str(b?.branch, 100),
      })).filter((b) => b.bank && b.number),
      promptpay: promptPayId(s.promptpay?.id) ? { id: promptPayId(s.promptpay.id), name: str(s.promptpay.name, 200), qr: s.promptpay.qr !== false } : null,
      signer: str(s.signer, 100),
      fyStart: Math.min(12, Math.max(1, Math.floor(Number(s.fyStart) || 1))),
      creditDays: Math.min(365, Math.max(0, Math.floor(Number(s.creditDays) || 30))),
      priceMode: s.priceMode === 'incl' ? 'incl' : 'excl',
      color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : null,
    };
    await db.query('update acc_businesses set settings = $2 where id = $1', [id, clean]);
  }
}

biz.get('/', wrap(async (req, res) => {
  const out = await tx(req, async (db) => ({
    accounts: (await db.query('select code, name, name_en, type, sys, bank, active from acc_accounts where business_id = $1 order by code', [B(req)])).rows,
    contacts: (await db.query('select * from acc_contacts where business_id = $1 order by name', [B(req)])).rows,
    items: (await db.query('select * from acc_items where business_id = $1 order by name', [B(req)])).rows,
  }));
  const { role, ...business } = req.biz;
  res.json({ business, role, ...out, ai: !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN, storage: storageEnabled });
}));

biz.put('/', wrap(async (req, res) => {
  await tx(req, (db) => updateBusiness(db, B(req), req.body || {}));
  res.json({ ok: true });
}));

biz.delete('/', wrap(async (req, res) => {
  if (req.biz.role !== 'owner') throw bad('forbidden', 403);
  if (String(req.body?.confirm || '') !== req.biz.name) throw bad('confirm_name');
  await pool.query('delete from acc_businesses where id = $1', [B(req)]);
  res.json({ ok: true });
}));

/* ---------- Chart of accounts ---------- */

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

biz.put('/accounts/:code', wrap(async (req, res) => {
  const code = String(req.params.code);
  if (!/^[0-9A-Za-z.-]{1,20}$/.test(code)) throw bad('bad_code');
  const name = str(req.body.name, 200);
  if (!name) throw bad('bad_name');
  const type = TYPES.includes(req.body.type) ? req.body.type : null;
  if (!type) throw bad('bad_type');
  const bank = req.body.bank && typeof req.body.bank === 'object'
    ? { bank: str(req.body.bank.bank, 100), number: str(req.body.bank.number, 40), holder: str(req.body.bank.holder, 200) } : null;
  await tx(req, async (db) => {
    const cur = (await db.query('select type, sys from acc_accounts where business_id = $1 and code = $2', [B(req), code])).rows[0];
    if (cur && cur.type !== type) {
      const used = (await db.query('select 1 from acc_lines where business_id = $1 and account = $2 limit 1', [B(req), code])).rowCount;
      if (used || cur.sys) throw bad('account_in_use', 409);
    }
    await db.query(
      `insert into acc_accounts (business_id, code, name, name_en, type, bank, active) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (business_id, code) do update set name = $3, name_en = $4, type = $5, bank = $6, active = $7`,
      [B(req), code, name, str(req.body.name_en, 200), type, bank && type === 'asset' ? bank : null, req.body.active !== false]);
  });
  res.json({ ok: true });
}));

biz.delete('/accounts/:code', wrap(async (req, res) => {
  await tx(req, async (db) => {
    const cur = (await db.query('select sys from acc_accounts where business_id = $1 and code = $2', [B(req), req.params.code])).rows[0];
    if (!cur) throw bad('not_found', 404);
    const used = (await db.query('select 1 from acc_lines where business_id = $1 and account = $2 limit 1', [B(req), req.params.code])).rowCount;
    if (cur.sys || used) throw bad('account_in_use', 409);
    await db.query('delete from acc_accounts where business_id = $1 and code = $2', [B(req), req.params.code]);
  });
  res.json({ ok: true });
}));

/* ---------- Contacts and items ---------- */

function contactFields(c) {
  return {
    kind: ['customer', 'vendor', 'both'].includes(c.kind) ? c.kind : 'customer',
    is_company: c.is_company !== false,
    name: str(c.name, 300),
    tax_id: str(String(c.tax_id ?? '').replace(/\D/g, ''), 13),
    branch: str(c.branch, 40),
    address: str(c.address, 600),
    phone: str(c.phone, 60),
    email: str(c.email, 200),
    contact_name: str(c.contact_name, 200),
    credit_days: Number.isFinite(Number(c.credit_days)) && c.credit_days !== '' && c.credit_days != null ? Math.min(365, Math.max(0, Math.floor(Number(c.credit_days)))) : null,
    note: str(c.note, 1000),
    archived: !!c.archived,
  };
}

async function upsertRow(db, table, id, bizId, fields) {
  const keys = Object.keys(fields);
  if (id) {
    const r = await db.query(`update ${table} set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} where id = $1 and business_id = $2 returning *`,
      [id, bizId, ...keys.map((k) => fields[k])]);
    if (!r.rows[0]) throw bad('not_found', 404);
    return r.rows[0];
  }
  const r = await db.query(`insert into ${table} (business_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning *`,
    [bizId, ...keys.map((k) => fields[k])]);
  return r.rows[0];
}

biz.post('/contacts', wrap(async (req, res) => {
  const f = contactFields(req.body || {});
  if (!f.name) throw bad('bad_name');
  res.json({ contact: await tx(req, (db) => upsertRow(db, 'acc_contacts', null, B(req), f)) });
}));
biz.put('/contacts/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const f = contactFields(req.body || {});
  if (!f.name) throw bad('bad_name');
  res.json({ contact: await tx(req, (db) => upsertRow(db, 'acc_contacts', req.params.id, B(req), f)) });
}));

function itemFields(i) {
  return {
    kind: i.kind === 'product' ? 'product' : 'service',
    sku: str(i.sku, 60),
    name: str(i.name, 300),
    unit: str(i.unit, 30),
    price: num(i.price),
    account: typeof i.account === 'string' && /^[0-9A-Za-z.-]{1,20}$/.test(i.account) ? i.account : null,
    description: str(i.description, 2000),
    archived: !!i.archived,
  };
}
biz.post('/items', wrap(async (req, res) => {
  const f = itemFields(req.body || {});
  if (!f.name) throw bad('bad_name');
  res.json({ item: await tx(req, (db) => upsertRow(db, 'acc_items', null, B(req), f)) });
}));
biz.put('/items/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const f = itemFields(req.body || {});
  if (!f.name) throw bad('bad_name');
  res.json({ item: await tx(req, (db) => upsertRow(db, 'acc_items', req.params.id, B(req), f)) });
}));

/* ---------- Documents ---------- */

async function nextNumber(db, bizId, prefix, date) {
  const key = counterKey(prefix, date);
  const r = await db.query(
    `insert into acc_counters (business_id, key, last) values ($1, $2, 1)
     on conflict (business_id, key) do update set last = acc_counters.last + 1 returning last`, [bizId, key]);
  return docNumber(prefix, date, r.rows[0].last);
}

async function accountsOf(db, bizId) {
  const rows = (await db.query('select code, type, sys, bank, active from acc_accounts where business_id = $1', [bizId])).rows;
  const sys = {};
  for (const a of rows) if (a.sys) sys[a.sys] = a.code;
  return { rows, byCode: new Map(rows.map((a) => [a.code, a])), sys };
}

const isMoneyAccount = (a) => a && a.type === 'asset' && (a.sys === 'cash' || a.sys === 'bank' || !!a.bank);

// Rebuilds the journal lines a document posts.
async function repost(db, bizId, doc) {
  await db.query('delete from acc_entries where doc_id = $1', [doc.id]);
  const acc = await accountsOf(db, bizId);
  const ref = doc.ref_id ? (await db.query('select * from acc_docs where id = $1', [doc.ref_id])).rows[0] : null;
  const lines = postingsFor(doc, acc.sys, ref);
  for (const stage of ['doc', 'pay']) {
    const part = lines.filter((l) => l.stage === stage);
    if (!part.length) continue;
    if (!balanced(part)) throw new Error(`unbalanced posting for ${doc.number}`);
    const date = stage === 'pay' ? (doc.pay?.date || doc.date) : (doc.type === 'RE' ? (doc.pay?.date || doc.date) : doc.date);
    const e = (await db.query(
      'insert into acc_entries (business_id, date, number, memo, doc_id) values ($1, $2, $3, $4, $5) returning id',
      [bizId, date, doc.number, doc.contact?.name || null, doc.id])).rows[0];
    for (const l of part) {
      if (!acc.byCode.has(l.account)) throw bad('unknown_account', 409);
      const party = [acc.sys.ar, acc.sys.ap].includes(l.account) ? doc.contact_id : null;
      await db.query('insert into acc_lines (entry_id, business_id, account, debit, credit, memo, contact_id) values ($1, $2, $3, $4, $5, $6, $7)',
        [e.id, bizId, l.account, l.debit, l.credit, l.memo, party]);
    }
  }
}

async function contactSnapshot(db, bizId, body) {
  if (isUuid(body.contact_id)) {
    const c = (await db.query('select * from acc_contacts where id = $1 and business_id = $2', [body.contact_id, bizId])).rows[0];
    if (!c) throw bad('bad_contact');
    return { id: c.id, snap: { name: c.name, tax_id: c.tax_id, branch: c.branch, address: c.address, phone: c.phone, email: c.email, is_company: c.is_company } };
  }
  const c = body.contact || {};
  return { id: null, snap: { name: str(c.name, 300) || '', tax_id: str(c.tax_id, 13), branch: str(c.branch, 40), address: str(c.address, 600), phone: str(c.phone, 60), email: str(c.email, 200), is_company: c.is_company !== false } };
}

function cleanPay(p, acc, date) {
  if (!p || typeof p !== 'object') return null;
  const a = acc.byCode.get(String(p.account || ''));
  if (!isMoneyAccount(a)) throw bad('bad_pay_account');
  return {
    date: isDate(p.date) ? p.date : date,
    account: a.code,
    fee: Math.max(0, num(p.fee)),
    method: ['cash', 'transfer', 'cheque', 'card', 'other'].includes(p.method) ? p.method : 'transfer',
    note: str(p.note, 300),
  };
}

const WHT_INCOME = ['ค่าบริการ', 'ค่าจ้างทำของ', 'ค่าเช่า', 'ค่าโฆษณา', 'ค่าขนส่ง', 'ค่าวิชาชีพอิสระ', 'ค่านายหน้า', 'ดอกเบี้ย', 'เงินปันผล', 'ค่ารางวัล', 'อื่น ๆ'];

// Builds a document row from what the browser sent. `cur` is the stored document when editing.
async function buildDoc(db, req, body, cur) {
  const bizId = B(req);
  const type = cur ? cur.type : body.type;
  if (!DOC_TYPES.includes(type)) throw bad('bad_type');
  const acc = await accountsOf(db, bizId);
  const date = isDate(body.date) ? body.date : (cur?.date || bangkokToday());
  const vatReg = req.biz.vat_registered;
  let ref = null;
  const refId = cur ? cur.ref_id : (isUuid(body.ref_id) ? body.ref_id : null);
  if (refId) {
    ref = (await db.query('select * from acc_docs where id = $1 and business_id = $2', [refId, bizId])).rows[0];
    if (!ref) throw bad('bad_ref');
    if (!cur && ref.status === 'void') throw bad('ref_void', 409);
  }
  // A receipt for an invoice carries the invoice's lines and customer; only WHT rates may change.
  const fromInvoice = type === 'RE' && ref?.type === 'IV';
  if (fromInvoice && !cur) {
    const open = (await db.query("select 1 from acc_docs where ref_id = $1 and type = 'RE' and status <> 'void'", [ref.id])).rowCount;
    if (open) throw bad('already_received', 409);
  }
  const src = fromInvoice ? ref : body;
  let lines = Array.isArray(src.lines) ? src.lines.slice(0, 200) : [];
  if (fromInvoice && Array.isArray(body.lines)) lines = lines.map((l, i) => ({ ...l, wht: body.lines[i]?.wht ?? l.wht }));
  if (!lines.length) throw bad('no_lines');
  const contact = fromInvoice ? { id: ref.contact_id, snap: ref.contact } : await contactSnapshot(db, bizId, body);
  if (!contact.snap.name) throw bad('bad_contact');

  let taxInvoice = type === 'EX' ? !!body.tax_invoice : (type === 'IV' ? !!body.tax_invoice && vatReg : false);
  let vatRate = 0;
  if (fromInvoice) vatRate = Number(ref.vat_rate);
  else if (type === 'EX') vatRate = taxInvoice ? (Number(body.vat_rate) === 0 ? 0 : 7) : 0;
  else vatRate = vatReg && Number(body.vat_rate) !== 0 ? 7 : 0;
  const priceMode = (fromInvoice ? ref.price_mode : body.price_mode) === 'incl' ? 'incl' : 'excl';
  const discount = fromInvoice ? ref.discount : num(body.discount);

  // Line accounts: income accounts on sales documents, expense (or asset) accounts on expenses.
  const allowed = type === 'EX' ? ['expense', 'asset'] : ['income'];
  lines = lines.map((l) => {
    const a = acc.byCode.get(String(l?.account || ''));
    return { ...l, account: a && allowed.includes(a.type) && !isMoneyAccount(a) ? a.code : null };
  });
  const t = computeTotals(lines, { discount, priceMode, vatRate });
  if (t.total < 0) throw bad('negative_total');
  // VAT on a sale needs a tax invoice: the receipt is it unless the invoice already was.
  if (type === 'RE') taxInvoice = t.vat > 0 && (fromInvoice ? !ref.tax_invoice : true);

  let status = cur?.status;
  let pay = cur?.pay || null;
  if (type === 'QT') status = ['open', 'accepted', 'rejected'].includes(body.status) ? body.status : (cur?.status || 'open');
  if (type === 'IV') status = cur?.status || 'open';
  if (type === 'RE') { status = 'done'; pay = cleanPay(body.pay || { account: acc.sys.cash }, acc, date); }
  if (type === 'EX') {
    if (body.pay !== undefined) pay = body.pay ? cleanPay(body.pay, acc, date) : null;
    status = pay ? 'paid' : 'open';
  }
  let whtCert = cur?.wht_cert || null;
  if (type === 'EX' && t.wht > 0) {
    whtCert = {
      ...(whtCert || {}),
      form: body.wht_form === 'pnd3' || body.wht_form === 'pnd53' ? body.wht_form : (contact.snap.is_company ? 'pnd53' : 'pnd3'),
      income: WHT_INCOME.includes(body.wht_income) ? body.wht_income : (whtCert?.income || 'ค่าบริการ'),
    };
  }
  const dueDate = type !== 'RE' && isDate(body.due_date) ? body.due_date : null;
  return {
    type, date, due_date: dueDate, status, contact_id: contact.id, contact: contact.snap,
    tax_invoice: taxInvoice, price_mode: priceMode, vat_rate: vatRate, lines: t.lines, discount: t.discount,
    subtotal: t.subtotal, vat_base: t.vat_base, vat: t.vat, total: t.total, wht: t.wht,
    ref_id: refId, ref_no: str(body.ref_no, 60), ref_date: isDate(body.ref_date) ? body.ref_date : null,
    pay, wht_cert: whtCert, notes: str(body.notes, 2000),
    attachment: typeof body.attachment === 'string' && body.attachment.startsWith(`acc/${bizId}/`) ? body.attachment.slice(0, 200) : (cur?.attachment || null),
  };
}

const COLS = ['type', 'date', 'due_date', 'status', 'contact_id', 'contact', 'tax_invoice', 'price_mode', 'vat_rate', 'lines', 'discount',
  'subtotal', 'vat_base', 'vat', 'total', 'wht', 'ref_id', 'ref_no', 'ref_date', 'pay', 'wht_cert', 'notes', 'attachment'];
const jsonCols = new Set(['contact', 'lines', 'pay', 'wht_cert']);
const val = (k, v) => (jsonCols.has(k) && v != null ? JSON.stringify(v) : v);

// After a document changes: number the WHT certificate, update the source document's status, post.
async function afterSave(db, req, doc) {
  const bizId = B(req);
  if (doc.type === 'EX' && doc.status === 'paid' && doc.wht > 0 && !doc.wht_cert?.number) {
    const prefix = req.biz.settings?.prefixes?.WHT || DEFAULT_PREFIX.WHT;
    doc.wht_cert = { ...doc.wht_cert, number: await nextNumber(db, bizId, prefix, doc.pay.date) };
    await db.query('update acc_docs set wht_cert = $2 where id = $1', [doc.id, JSON.stringify(doc.wht_cert)]);
  }
  if (doc.ref_id) await refreshStatus(db, doc.ref_id);
  await repost(db, bizId, doc);
}

// An invoice is paid while it has a live receipt; a quotation is accepted once converted.
async function refreshStatus(db, id) {
  const d = (await db.query('select id, type, status from acc_docs where id = $1', [id])).rows[0];
  if (!d || d.status === 'void') return;
  if (d.type === 'IV') {
    const paid = (await db.query("select 1 from acc_docs where ref_id = $1 and type = 'RE' and status <> 'void'", [id])).rowCount > 0;
    await db.query('update acc_docs set status = $2 where id = $1', [id, paid ? 'paid' : 'open']);
  } else if (d.type === 'QT') {
    const used = (await db.query("select 1 from acc_docs where ref_id = $1 and status <> 'void'", [id])).rowCount > 0;
    if (used && d.status === 'open') await db.query("update acc_docs set status = 'accepted' where id = $1", [id]);
  }
}

biz.get('/docs', wrap(async (req, res) => {
  const q = req.query;
  const where = ['business_id = $1'];
  const p = [B(req)];
  if (DOC_TYPES.includes(q.type)) { p.push(q.type); where.push(`type = $${p.length}`); }
  if (isDate(q.from)) { p.push(q.from); where.push(`date >= $${p.length}`); }
  if (isDate(q.to)) { p.push(q.to); where.push(`date <= $${p.length}`); }
  if (typeof q.status === 'string' && /^[a-z]{2,10}$/.test(q.status)) { p.push(q.status); where.push(`status = $${p.length}`); }
  if (isUuid(q.contact)) { p.push(q.contact); where.push(`contact_id = $${p.length}`); }
  const rows = await tx(req, async (db) => (await db.query(
    `select id, type, number, status, date, due_date, contact_id, contact->>'name' as contact_name, tax_invoice,
            subtotal, vat, total, wht, ref_id, (pay->>'date') as paid_date, created_at
     from acc_docs where ${where.join(' and ')} order by date desc, number desc limit 2000`, p)).rows);
  res.json({ docs: rows });
}));

biz.get('/docs/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const out = await tx(req, async (db) => {
    const doc = (await db.query('select * from acc_docs where id = $1 and business_id = $2', [req.params.id, B(req)])).rows[0];
    if (!doc) throw bad('not_found', 404);
    const ref = doc.ref_id ? (await db.query('select id, type, number, date, status from acc_docs where id = $1', [doc.ref_id])).rows[0] : null;
    const children = (await db.query('select id, type, number, date, status, total from acc_docs where ref_id = $1 order by created_at', [doc.id])).rows;
    const journal = (await db.query(
      `select e.date, e.number, l.account, l.debit, l.credit, a.name from acc_entries e join acc_lines l on l.entry_id = e.id
       left join acc_accounts a on a.business_id = l.business_id and a.code = l.account
       where e.doc_id = $1 order by e.date, l.debit desc, l.account`, [doc.id])).rows;
    return { doc, ref, children, journal };
  });
  res.json(out);
}));

biz.post('/docs', wrap(async (req, res) => {
  const doc = await tx(req, async (db) => {
    const d = await buildDoc(db, req, req.body || {}, null);
    const prefix = req.biz.settings?.prefixes?.[d.type] || DEFAULT_PREFIX[d.type];
    const number = await nextNumber(db, B(req), prefix, d.date);
    const row = (await db.query(
      `insert into acc_docs (business_id, number, created_by, ${COLS.join(', ')})
       values ($1, $2, app_uid(), ${COLS.map((_, i) => `$${i + 3}`).join(', ')}) returning *`,
      [B(req), number, ...COLS.map((k) => val(k, d[k]))])).rows[0];
    await afterSave(db, req, row);
    return row;
  });
  res.json({ doc });
}));

biz.put('/docs/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const doc = await tx(req, async (db) => {
    const cur = (await db.query('select * from acc_docs where id = $1 and business_id = $2 for update', [req.params.id, B(req)])).rows[0];
    if (!cur) throw bad('not_found', 404);
    if (cur.status === 'void') throw bad('doc_void', 409);
    if (cur.type === 'IV' && cur.status === 'paid') throw bad('doc_paid', 409);
    const d = await buildDoc(db, req, req.body || {}, cur);
    const row = (await db.query(
      `update acc_docs set ${COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
      [cur.id, ...COLS.map((k) => val(k, d[k]))])).rows[0];
    await afterSave(db, req, row);
    return row;
  });
  res.json({ doc });
}));

// Pay an expense, or take the payment back off it.
biz.post('/docs/:id/pay', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const doc = await tx(req, async (db) => {
    const cur = (await db.query("select * from acc_docs where id = $1 and business_id = $2 and type = 'EX' for update", [req.params.id, B(req)])).rows[0];
    if (!cur) throw bad('not_found', 404);
    if (cur.status === 'void') throw bad('doc_void', 409);
    const acc = await accountsOf(db, B(req));
    const pay = req.body?.pay ? cleanPay(req.body.pay, acc, bangkokToday()) : null;
    const row = (await db.query('update acc_docs set pay = $2, status = $3, updated_at = now() where id = $1 returning *',
      [cur.id, pay ? JSON.stringify(pay) : null, pay ? 'paid' : 'open'])).rows[0];
    await afterSave(db, req, row);
    return row;
  });
  res.json({ doc });
}));

biz.post('/docs/:id/status', wrap(async (req, res) => {
  const status = ['open', 'accepted', 'rejected'].includes(req.body?.status) ? req.body.status : null;
  if (!status || !isUuid(req.params.id)) throw bad('bad_status');
  await tx(req, async (db) => {
    const r = await db.query("update acc_docs set status = $3, updated_at = now() where id = $1 and business_id = $2 and type = 'QT' and status <> 'void'", [req.params.id, B(req), status]);
    if (!r.rowCount) throw bad('not_found', 404);
  });
  res.json({ ok: true });
}));

biz.post('/docs/:id/void', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  await tx(req, async (db) => {
    const cur = (await db.query('select * from acc_docs where id = $1 and business_id = $2 for update', [req.params.id, B(req)])).rows[0];
    if (!cur) throw bad('not_found', 404);
    if (cur.status === 'void') return;
    const live = (await db.query("select number from acc_docs where ref_id = $1 and type = 'RE' and status <> 'void'", [cur.id])).rows[0];
    if (cur.type === 'IV' && live) throw bad('has_receipt', 409);
    const row = (await db.query("update acc_docs set status = 'void', updated_at = now(), notes = coalesce(notes, '') || $2 where id = $1 returning *",
      [cur.id, str(req.body?.reason, 300) ? `\nยกเลิก: ${str(req.body.reason, 300)}` : ''])).rows[0];
    if (row.ref_id) await refreshStatus(db, row.ref_id);
    await repost(db, B(req), row);
  });
  res.json({ ok: true });
}));

biz.post('/docs/:id/share', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const token = await tx(req, async (db) => {
    const off = req.body?.off === true;
    const r = await db.query(
      `update acc_docs set public_token = case when $3 then null else coalesce(public_token, $4) end where id = $1 and business_id = $2 returning public_token`,
      [req.params.id, B(req), off, crypto.randomBytes(24).toString('base64url')]);
    if (!r.rows[0]) throw bad('not_found', 404);
    return r.rows[0].public_token;
  });
  res.json({ token });
}));

/* ---------- Scanned purchase bills ---------- */

biz.post('/scan', rateLimit(60, 60 * 60000), wrap(async (req, res) => {
  const mediaType = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(req.body.mediaType) ? req.body.mediaType : null;
  const data = typeof req.body.data === 'string' ? req.body.data : '';
  if (!mediaType || !data) throw bad('bad_file');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 8 * 1024 * 1024) throw bad('too_large', 413);
  let key = null;
  if (storageEnabled) {
    key = `acc/${B(req)}/${crypto.randomUUID()}.${mediaType === 'application/pdf' ? 'pdf' : mediaType.split('/')[1]}`;
    await putReceipt(key, buf, mediaType);
  }
  const accounts = await tx(req, async (db) => (await db.query(
    "select code, name from acc_accounts where business_id = $1 and type = 'expense' and active order by code", [B(req)])).rows);
  let result = null;
  try {
    result = await readPurchaseDoc(data, mediaType, accounts, req.biz);
  } catch (e) {
    console.error('acc scan failed', e.status || '', e.message);
  }
  res.json({ attachment: key, result });
}));

biz.get('/attachment', wrap(async (req, res) => {
  const key = String(req.query.key || '');
  if (!key.startsWith(`acc/${B(req)}/`)) throw bad('not_found', 404);
  res.json({ url: await receiptUrl(key) });
}));

/* ---------- Journal vouchers ---------- */

async function saveJournal(db, req, id, body) {
  const bizId = B(req);
  const acc = await accountsOf(db, bizId);
  const date = isDate(body.date) ? body.date : bangkokToday();
  const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 200).map((l) => ({
    account: String(l?.account || ''), debit: Math.max(0, num(l?.debit)), credit: Math.max(0, num(l?.credit)),
    memo: str(l?.memo, 300), contact_id: isUuid(l?.contact_id) ? l.contact_id : null,
  })).filter((l) => l.debit || l.credit);
  if (lines.some((l) => !acc.byCode.has(l.account))) throw bad('unknown_account');
  if (lines.some((l) => l.debit && l.credit)) throw bad('debit_and_credit');
  if (!balanced(lines)) throw bad('unbalanced');
  let entryId = id;
  if (id) {
    const r = await db.query('update acc_entries set date = $3, memo = $4 where id = $1 and business_id = $2 and doc_id is null returning id', [id, bizId, date, str(body.memo, 500)]);
    if (!r.rowCount) throw bad('not_found', 404);
    await db.query('delete from acc_lines where entry_id = $1', [id]);
  } else {
    const prefix = req.biz.settings?.prefixes?.JV || DEFAULT_PREFIX.JV;
    const number = await nextNumber(db, bizId, prefix, date);
    entryId = (await db.query('insert into acc_entries (business_id, date, number, memo) values ($1, $2, $3, $4) returning id',
      [bizId, date, number, str(body.memo, 500)])).rows[0].id;
  }
  for (const l of lines) {
    await db.query('insert into acc_lines (entry_id, business_id, account, debit, credit, memo, contact_id) values ($1, $2, $3, $4, $5, $6, $7)',
      [entryId, bizId, l.account, l.debit, l.credit, l.memo, l.contact_id]);
  }
  return entryId;
}

biz.get('/journal', wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : '1900-01-01';
  const to = isDate(req.query.to) ? req.query.to : '2999-12-31';
  const manual = req.query.manual === '1';
  const rows = await tx(req, async (db) => (await db.query(
    `select e.id, e.date, e.number, e.memo, e.doc_id, d.type as doc_type,
            json_agg(json_build_object('account', l.account, 'debit', l.debit, 'credit', l.credit, 'memo', l.memo, 'contact_id', l.contact_id)
                     order by l.debit desc, l.account) as lines
     from acc_entries e join acc_lines l on l.entry_id = e.id left join acc_docs d on d.id = e.doc_id
     where e.business_id = $1 and e.date between $2 and $3 ${manual ? 'and e.doc_id is null' : ''}
     group by e.id, d.type order by e.date desc, e.created_at desc limit 3000`, [B(req), from, to])).rows);
  res.json({ entries: rows });
}));
biz.post('/journal', wrap(async (req, res) => {
  res.json({ id: await tx(req, (db) => saveJournal(db, req, null, req.body || {})) });
}));
biz.put('/journal/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  res.json({ id: await tx(req, (db) => saveJournal(db, req, req.params.id, req.body || {})) });
}));
biz.delete('/journal/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  await tx(req, async (db) => {
    const r = await db.query('delete from acc_entries where id = $1 and business_id = $2 and doc_id is null', [req.params.id, B(req)]);
    if (!r.rowCount) throw bad('not_found', 404);
  });
  res.json({ ok: true });
}));

/* ---------- Reports ---------- */

biz.get('/reports/:name', wrap(async (req, res) => {
  if (!REPORTS.includes(req.params.name)) throw bad('not_found', 404);
  const out = await tx(req, (db) => report(db, req.biz, req.params.name, req.query));
  res.json(out);
}));

/* ---------- Public shapes ---------- */

function publicDoc(d, ref) {
  return {
    type: d.type, number: d.number, status: d.status, date: d.date, due_date: d.due_date, contact: d.contact,
    tax_invoice: d.tax_invoice, price_mode: d.price_mode, vat_rate: d.vat_rate,
    lines: (d.lines || []).map(({ account, itemId, ...l }) => l),
    discount: d.discount, subtotal: d.subtotal, vat_base: d.vat_base, vat: d.vat, total: d.total, wht: d.wht,
    pay: d.pay ? { date: d.pay.date, method: d.pay.method } : null, notes: d.notes,
    ref: ref ? { type: ref.type, number: ref.number, date: ref.date } : null,
  };
}

function publicBusiness(b) {
  return {
    name: b.name, name_en: b.name_en, tax_id: b.tax_id, branch: b.branch, address: b.address, phone: b.phone,
    email: b.email, website: b.website, logo: b.logo, vat_registered: b.vat_registered,
    settings: {
      payment: b.settings?.payment || null, banks: b.settings?.banks || [], promptpay: b.settings?.promptpay || null, notes: b.settings?.notes || {}, signer: b.settings?.signer || null, color: b.settings?.color || null },
  };
}

export default router;
