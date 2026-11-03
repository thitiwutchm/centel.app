import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { sha, rateLimit } from './auth.js';
import { pushTo } from './push.js';

/* Billing for the app owner's own business (the companies the owner builds apps for):
   clients, repeating plans (billing day, due days, start/end), invoices with an invoice
   number, payments received, and a read-only link for the client to see their bills.

   Who can use it: the accounts whose email is in BILLING_ADMINS (comma separated). When
   that is not set, only the oldest account on the server (the owner's own) can.
   Other systems call the same routes with an API key: Authorization: Bearer cbk_...
   (made in /billing/ › ตั้งค่า). Dates are Bangkok dates, 'YYYY-MM-DD'. */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const str = (v, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const token = () => crypto.randomBytes(18).toString('base64url');
const intIn = (v, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const rateIn = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? round2(n) : null;
};
const currencyOf = (v) => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : 'THB');

/* ---------- Dates (Bangkok) ---------- */

export const bkkToday = (now = new Date()) => new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const parts = (d) => d.split('-').map(Number);
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
// The bill_day of the month `months` after d's month, clamped to that month's last day.
function dayIn(d, months, billDay) {
  const [y, m] = parts(d);
  const k = (y * 12 + (m - 1)) + months;
  const yy = Math.floor(k / 12), mm = (k % 12) + 1;
  return iso(yy, mm, Math.min(billDay, lastDay(yy, mm)));
}
const step = (every) => (every === 'year' ? 12 : 1);

// First billing date on or after the plan starts.
export function firstRun(plan) {
  if (plan.every === 'once') return plan.start_date;
  const d = dayIn(plan.start_date, 0, plan.bill_day);
  return d >= plan.start_date ? d : dayIn(plan.start_date, step(plan.every), plan.bill_day);
}
// The run after `d`, or null when the plan is finished.
export function nextRun(plan, d) {
  if (plan.every === 'once') return null;
  const n = dayIn(d, step(plan.every), plan.bill_day);
  return plan.end_date && n > plan.end_date ? null : n;
}

/* ---------- Money ---------- */

function cleanItems(v) {
  if (!Array.isArray(v) || !v.length || v.length > 50) throw bad('bad_items');
  return v.map((x) => {
    const description = str(x && x.description, 300);
    const qty = Number(x && (x.qty ?? 1));
    const unitPrice = Number(x && x.unitPrice);
    if (!description || !Number.isFinite(qty) || qty <= 0 || qty > 1e6 || !Number.isFinite(unitPrice) || Math.abs(unitPrice) > 1e10) throw bad('bad_items');
    return { description, qty: round2(qty), unitPrice: round2(unitPrice) };
  });
}

// Subtotal, VAT on top, withholding tax (หัก ณ ที่จ่าย) taken off what the client transfers.
export function totals(items, vatRate, whtRate) {
  const subtotal = round2(items.reduce((s, x) => s + x.qty * x.unitPrice, 0));
  const vat = round2((subtotal * vatRate) / 100);
  const wht = round2((subtotal * whtRate) / 100);
  return { subtotal, vat, wht, total: round2(subtotal + vat - wht) };
}

/* ---------- Who may use it ---------- */

let ownerId = null;
const adminEmails = () => String(process.env.BILLING_ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

async function oldestUser() {
  if (!ownerId) ownerId = (await pool.query('select id from users order by created_at, id limit 1')).rows[0]?.id || null;
  return ownerId;
}

export async function isBillingAdmin(user) {
  if (!user) return false;
  const list = adminEmails();
  if (list.length) return list.includes(String(user.email).toLowerCase());
  return user.id === await oldestUser();
}

async function adminIds() {
  const list = adminEmails();
  if (list.length) return (await pool.query('select id from users where lower(email) = any($1)', [list])).rows.map((r) => r.id);
  const o = await oldestUser();
  return o ? [o] : [];
}

// API key (no cookie, so no CSRF) or the owner's signed-in session.
async function guard(req, res, next) {
  try {
    const h = req.get('authorization') || '';
    if (/^Bearer\s+/i.test(h)) {
      const key = h.replace(/^Bearer\s+/i, '').trim();
      const r = await pool.query(
        'update billing_api_keys set last_used_at = now() where key_hash = $1 and revoked_at is null returning id, name', [sha(key)]);
      if (!r.rows[0]) return res.status(401).json({ error: 'bad_api_key' });
      req.billingKey = r.rows[0];
      return next();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-centel') !== '1') return res.status(403).json({ error: 'csrf' });
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!await isBillingAdmin(req.user)) return res.status(403).json({ error: 'forbidden' });
    next();
  } catch (e) {
    next(e);
  }
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/* ---------- Shapes ---------- */

const settingsOut = (s) => ({
  sellerName: s.seller_name, sellerTaxId: s.seller_tax_id, sellerAddress: s.seller_address, sellerPhone: s.seller_phone,
  sellerEmail: s.seller_email, bankInfo: s.bank_info, invoicePrefix: s.invoice_prefix, defaultDueDays: s.default_due_days,
  vatRate: s.vat_rate, remindDays: s.remind_days, footerNote: s.footer_note,
});

const clientOut = (c) => ({
  id: c.id, code: c.code, name: c.name, contactName: c.contact_name, email: c.email, phone: c.phone, taxId: c.tax_id,
  address: c.address, notes: c.notes, dueDays: c.due_days, portalToken: c.portal_token, archived: c.archived, createdAt: c.created_at,
});

const planOut = (p) => ({
  id: p.id, clientId: p.client_id, name: p.name, amount: p.amount, currency: p.currency, every: p.every, billDay: p.bill_day,
  dueDays: p.due_days, vat: p.vat, whtRate: p.wht_rate, startDate: p.start_date, endDate: p.end_date,
  nextBillDate: p.next_bill_date, autoIssue: p.auto_issue, active: p.active, notes: p.notes, createdAt: p.created_at,
});

function invoiceOut(i, payments, today = bkkToday()) {
  const balance = round2(i.total - i.paid_amount);
  const overdue = i.status === 'issued' && !!i.due_date && i.due_date < today && balance > 0;
  const out = {
    id: i.id, number: i.number, clientId: i.client_id, planId: i.plan_id, status: i.status,
    state: overdue ? 'overdue' : i.status === 'issued' && i.paid_amount > 0 ? 'partial' : i.status,
    issueDate: i.issue_date, dueDate: i.due_date, periodStart: i.period_start, periodEnd: i.period_end, currency: i.currency,
    items: i.items, subtotal: i.subtotal, vatRate: i.vat_rate, vat: i.vat, whtRate: i.wht_rate, wht: i.wht, total: i.total,
    paidAmount: i.paid_amount, balance, overdue, notes: i.notes, publicToken: i.public_token,
    issuedAt: i.issued_at, paidAt: i.paid_at, createdAt: i.created_at, updatedAt: i.updated_at,
  };
  if (i.client_name !== undefined) out.clientName = i.client_name;
  if (payments) out.payments = payments.map(paymentOut);
  return out;
}

const paymentOut = (p) => ({ id: p.id, amount: p.amount, paidOn: p.paid_on, method: p.method, reference: p.reference, note: p.note, createdAt: p.created_at });

/* ---------- Lookups ---------- */

const settings = async (db = pool) => (await db.query('select * from billing_settings where id = 1')).rows[0];

// A client by id or by its short code (e.g. "A"), so other systems can ask by their own name for it.
async function findClient(db, ref, lock = false) {
  const col = isUuid(ref) ? 'id' : 'code';
  if (col === 'code' && !str(ref, 40)) throw bad('not_found', 404);
  const r = await db.query(`select * from billing_clients where ${col} = $1${lock ? ' for update' : ''}`, [ref]);
  if (!r.rows[0]) throw bad('not_found', 404);
  return r.rows[0];
}

async function findInvoice(db, id, lock = false) {
  if (!isUuid(id)) throw bad('not_found', 404);
  const r = await db.query(`select * from billing_invoices where id = $1${lock ? ' for update' : ''}`, [id]);
  if (!r.rows[0]) throw bad('not_found', 404);
  return r.rows[0];
}

async function invoiceFull(db, id) {
  const i = (await db.query('select i.*, c.name as client_name from billing_invoices i join billing_clients c on c.id = i.client_id where i.id = $1', [id])).rows[0];
  if (!i) throw bad('not_found', 404);
  const pays = (await db.query('select * from billing_payments where invoice_id = $1 order by paid_on, created_at', [id])).rows;
  return invoiceOut(i, pays);
}

async function nextNumber(db, issueDate) {
  const s = await settings(db);
  const year = parts(issueDate)[0];
  const n = (await db.query(
    'insert into billing_counters (year, n) values ($1, 1) on conflict (year) do update set n = billing_counters.n + 1 returning n', [year])).rows[0].n;
  return `${s.invoice_prefix}-${year}-${String(n).padStart(4, '0')}`;
}

async function dueDaysFor(db, client, plan) {
  if (plan && plan.due_days != null) return plan.due_days;
  if (client.due_days != null) return client.due_days;
  return (await settings(db)).default_due_days;
}

// A client's standing: what is still owed, what is late, the last payment, the next bill.
async function clientStatus(db, clientId, today = bkkToday()) {
  const r = (await db.query(
    `select
       coalesce(sum(total - paid_amount) filter (where status = 'issued'), 0) as outstanding,
       coalesce(sum(total - paid_amount) filter (where status = 'issued' and due_date < $2), 0) as overdue_amount,
       count(*) filter (where status = 'issued' and due_date < $2 and total > paid_amount) as overdue_count,
       count(*) filter (where status = 'issued') as open_count,
       min(due_date) filter (where status = 'issued') as next_due
     from billing_invoices where client_id = $1`, [clientId, today])).rows[0];
  const last = (await db.query(
    `select p.paid_on, p.amount from billing_payments p join billing_invoices i on i.id = p.invoice_id
     where i.client_id = $1 order by p.paid_on desc, p.created_at desc limit 1`, [clientId])).rows[0];
  const next = (await db.query(
    'select min(next_bill_date) as d from billing_plans where client_id = $1 and active and next_bill_date is not null', [clientId])).rows[0].d;
  return {
    outstanding: round2(r.outstanding), overdueAmount: round2(r.overdue_amount), overdueCount: Number(r.overdue_count),
    openCount: Number(r.open_count), nextDue: r.next_due, lastPayment: last ? { paidOn: last.paid_on, amount: last.amount } : null,
    nextBillDate: next, paidUp: Number(r.open_count) === 0,
  };
}

/* ---------- Issuing ---------- */

const TH_DATE = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const thDate = (d) => TH_DATE.format(new Date(d + 'T00:00:00Z'));

// Issues the plan's next run as an invoice and moves the plan on. `issueDate` defaults to
// today (a tap) or the run's own date (the daily job). Safe against a double tap: one
// invoice per plan per period (unique index), so a second attempt is 'already_issued'.
export async function issueFromPlan(planId, { issueDate, auto = false } = {}) {
  return tx(async (db) => {
    if (!isUuid(planId)) throw bad('not_found', 404);
    const plan = (await db.query('select * from billing_plans where id = $1 for update', [planId])).rows[0];
    if (!plan) throw bad('not_found', 404);
    const run = plan.next_bill_date;
    if (!plan.active || !run || (plan.end_date && run > plan.end_date)) throw bad('plan_finished', 409);
    const client = await findClient(db, plan.client_id);
    const s = await settings(db);
    const issued = issueDate || (auto ? run : bkkToday());
    const due = addDays(issued, await dueDaysFor(db, client, plan));
    const after = nextRun(plan, run);
    const periodEnd = plan.every === 'once' ? null : addDays(dayIn(run, step(plan.every), plan.bill_day), -1);
    const label = periodEnd ? `${plan.name} · รอบ ${thDate(run)} – ${thDate(periodEnd)}` : plan.name;
    const items = [{ description: label, qty: 1, unitPrice: plan.amount }];
    const vatRate = plan.vat ? s.vat_rate : 0;
    const t = totals(items, vatRate, plan.wht_rate);
    const number = await nextNumber(db, issued);
    let id;
    try {
      await db.query('savepoint ins');
      id = (await db.query(
        `insert into billing_invoices (number, client_id, plan_id, status, issue_date, due_date, period_start, period_end, currency,
           items, subtotal, vat_rate, vat, wht_rate, wht, total, public_token, issued_at)
         values ($1, $2, $3, 'issued', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now()) returning id`,
        [number, client.id, plan.id, issued, due, run, periodEnd, plan.currency, JSON.stringify(items), t.subtotal, vatRate, t.vat,
          plan.wht_rate, t.wht, t.total, token()])).rows[0].id;
    } catch (e) {
      if (e.code === '23505') throw bad('already_issued', 409);
      throw e;
    }
    await db.query('update billing_plans set next_bill_date = $2, active = $3 where id = $1', [plan.id, after, after != null]);
    return invoiceFull(db, id);
  });
}

async function recalcPaid(db, invoiceId) {
  await db.query(
    `update billing_invoices i set
       paid_amount = p.sum,
       status = case when i.status in ('issued', 'paid') then (case when p.sum >= i.total then 'paid' else 'issued' end) else i.status end,
       paid_at = case when p.sum >= i.total and i.status in ('issued', 'paid') then coalesce(i.paid_at, now()) else null end,
       updated_at = now()
     from (select coalesce(sum(amount), 0) as sum from billing_payments where invoice_id = $1) p
     where i.id = $1`, [invoiceId]);
}

/* ---------- Owner / API routes ---------- */

const router = express.Router();
router.use(guard);

router.get('/me', wrap(async (req, res) => {
  res.json({ admin: true, via: req.billingKey ? 'api_key' : 'session', key: req.billingKey ? req.billingKey.name : undefined, today: bkkToday() });
}));

router.get('/summary', wrap(async (_req, res) => {
  const today = bkkToday();
  const month = today.slice(0, 7);
  const open = (await pool.query(
    `select currency,
       coalesce(sum(total - paid_amount), 0) as outstanding,
       coalesce(sum(total - paid_amount) filter (where due_date < $1), 0) as overdue,
       count(*) filter (where due_date < $1 and total > paid_amount) as overdue_count,
       count(*) as open_count
     from billing_invoices where status = 'issued' group by currency`, [today])).rows;
  const paid = (await pool.query(
    `select i.currency, coalesce(sum(p.amount), 0) as amount from billing_payments p join billing_invoices i on i.id = p.invoice_id
     where to_char(p.paid_on, 'YYYY-MM') = $1 group by i.currency`, [month])).rows;
  const clients = (await pool.query('select * from billing_clients where not archived order by name')).rows;
  const rows = [];
  for (const c of clients) rows.push({ ...clientOut(c), status: await clientStatus(pool, c.id, today) });
  const upcoming = (await pool.query(
    `select p.*, c.name as client_name from billing_plans p join billing_clients c on c.id = p.client_id
     where p.active and p.next_bill_date is not null and p.next_bill_date <= $1 order by p.next_bill_date, c.name`, [addDays(today, 31)])).rows;
  res.json({
    today,
    open: open.map((r) => ({ currency: r.currency, outstanding: round2(r.outstanding), overdue: round2(r.overdue), overdueCount: Number(r.overdue_count), openCount: Number(r.open_count) })),
    paidThisMonth: paid.map((r) => ({ currency: r.currency, amount: round2(r.amount) })),
    clients: rows,
    upcoming: upcoming.map((p) => ({ ...planOut(p), clientName: p.client_name })),
  });
}));

/* Settings */

router.get('/settings', wrap(async (_req, res) => res.json(settingsOut(await settings()))));

router.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const s = await settings();
  const prefix = has(b, 'invoicePrefix') ? str(b.invoicePrefix, 12) : s.invoice_prefix;
  if (!prefix || !/^[A-Za-z0-9-]+$/.test(prefix)) throw bad('bad_prefix');
  const due = has(b, 'defaultDueDays') ? intIn(b.defaultDueDays, 0, 365) : s.default_due_days;
  const vat = has(b, 'vatRate') ? rateIn(b.vatRate) : s.vat_rate;
  const remind = has(b, 'remindDays') ? intIn(b.remindDays, 0, 60) : s.remind_days;
  if (due == null || vat == null || remind == null) throw bad('bad_request');
  const pick = (k, col, max) => (has(b, k) ? str(b[k], max) : s[col]);
  const r = await pool.query(
    `update billing_settings set seller_name = $1, seller_tax_id = $2, seller_address = $3, seller_phone = $4, seller_email = $5,
       bank_info = $6, invoice_prefix = $7, default_due_days = $8, vat_rate = $9, remind_days = $10, footer_note = $11, updated_at = now()
     where id = 1 returning *`,
    [pick('sellerName', 'seller_name', 200) || '', pick('sellerTaxId', 'seller_tax_id', 40), pick('sellerAddress', 'seller_address', 600),
      pick('sellerPhone', 'seller_phone', 60), pick('sellerEmail', 'seller_email', 200), pick('bankInfo', 'bank_info', 600),
      prefix.toUpperCase(), due, vat, remind, pick('footerNote', 'footer_note', 600)]);
  res.json(settingsOut(r.rows[0]));
}));

/* Clients */

function clientFields(b, old = {}) {
  const v = (k, col, max) => (has(b, k) ? str(b[k], max) : old[col] ?? null);
  const name = v('name', 'name', 200);
  if (!name) throw bad('bad_name');
  const code = v('code', 'code', 40);
  if (code && (isUuid(code) || !/^[\p{L}\p{N}_.-]+$/u.test(code))) throw bad('bad_code');
  let due = old.due_days ?? null;
  if (has(b, 'dueDays')) {
    due = b.dueDays == null || b.dueDays === '' ? null : intIn(b.dueDays, 0, 365);
    if (b.dueDays != null && b.dueDays !== '' && due == null) throw bad('bad_request');
  }
  return [code, name, v('contactName', 'contact_name', 120), v('email', 'email', 200), v('phone', 'phone', 60), v('taxId', 'tax_id', 40),
    v('address', 'address', 600), v('notes', 'notes', 2000), due, has(b, 'archived') ? !!b.archived : !!old.archived];
}

router.get('/clients', wrap(async (req, res) => {
  const all = req.query.archived === '1';
  const rows = (await pool.query(`select * from billing_clients ${all ? '' : 'where not archived'} order by name`)).rows;
  const today = bkkToday();
  const out = [];
  for (const c of rows) out.push({ ...clientOut(c), status: await clientStatus(pool, c.id, today) });
  res.json({ clients: out });
}));

router.post('/clients', wrap(async (req, res) => {
  const f = clientFields(req.body || {});
  const r = await pool.query(
    `insert into billing_clients (code, name, contact_name, email, phone, tax_id, address, notes, due_days, archived, portal_token)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`, [...f, token()]);
  res.status(201).json({ ...clientOut(r.rows[0]), status: await clientStatus(pool, r.rows[0].id) });
}));

// Everything about one client: details, whether they are paid up, their plans and invoices.
router.get('/clients/:ref', wrap(async (req, res) => {
  const c = await findClient(pool, req.params.ref);
  const plans = (await pool.query('select * from billing_plans where client_id = $1 order by active desc, created_at', [c.id])).rows;
  const invs = (await pool.query(
    'select i.*, c.name as client_name from billing_invoices i join billing_clients c on c.id = i.client_id where i.client_id = $1 order by coalesce(i.issue_date, i.created_at::date) desc, i.created_at desc',
    [c.id])).rows;
  res.json({ ...clientOut(c), status: await clientStatus(pool, c.id), plans: plans.map(planOut), invoices: invs.map((i) => invoiceOut(i)) });
}));

// The short answer to "has company A paid?".
router.get('/clients/:ref/status', wrap(async (req, res) => {
  const c = await findClient(pool, req.params.ref);
  const today = bkkToday();
  const unpaid = (await pool.query(
    `select * from billing_invoices where client_id = $1 and status = 'issued' order by due_date`, [c.id])).rows;
  res.json({ client: { id: c.id, code: c.code, name: c.name }, today, ...(await clientStatus(pool, c.id, today)), unpaid: unpaid.map((i) => invoiceOut(i, null, today)) });
}));

router.put('/clients/:ref', wrap(async (req, res) => {
  const old = await findClient(pool, req.params.ref);
  const f = clientFields(req.body || {}, old);
  const r = await pool.query(
    `update billing_clients set code = $1, name = $2, contact_name = $3, email = $4, phone = $5, tax_id = $6, address = $7, notes = $8,
       due_days = $9, archived = $10 where id = $11 returning *`, [...f, old.id]);
  res.json({ ...clientOut(r.rows[0]), status: await clientStatus(pool, old.id) });
}));

// A new client link (the old one stops working).
router.post('/clients/:ref/link', wrap(async (req, res) => {
  const old = await findClient(pool, req.params.ref);
  const r = await pool.query('update billing_clients set portal_token = $2 where id = $1 returning *', [old.id, token()]);
  res.json(clientOut(r.rows[0]));
}));

// Only a client with nothing issued yet can be deleted; otherwise archive it.
router.delete('/clients/:ref', wrap(async (req, res) => {
  const c = await findClient(pool, req.params.ref);
  const n = (await pool.query("select count(*)::int as n from billing_invoices where client_id = $1 and status <> 'draft'", [c.id])).rows[0].n;
  if (n) throw bad('client_has_invoices', 409);
  await tx(async (db) => {
    await db.query('delete from billing_invoices where client_id = $1', [c.id]);
    await db.query('delete from billing_clients where id = $1', [c.id]);
  });
  res.json({ ok: true });
}));

/* Plans */

function planFields(b, old = {}) {
  const pick = (k, col) => (has(b, k) ? b[k] : old[col]);
  const name = str(pick('name', 'name'), 200);
  const amount = Number(pick('amount', 'amount'));
  const every = pick('every', 'every') || 'month';
  const billDay = intIn(pick('billDay', 'bill_day') ?? 1, 1, 31);
  const dueRaw = pick('dueDays', 'due_days');
  const dueDays = dueRaw == null || dueRaw === '' ? null : intIn(dueRaw, 0, 365);
  const whtRate = rateIn(pick('whtRate', 'wht_rate') ?? 0);
  const startDate = pick('startDate', 'start_date') || bkkToday();
  const endRaw = pick('endDate', 'end_date');
  const endDate = endRaw || null;
  if (!name) throw bad('bad_name');
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e10) throw bad('bad_amount');
  if (!['month', 'year', 'once'].includes(every) || billDay == null || whtRate == null) throw bad('bad_request');
  if (dueRaw != null && dueRaw !== '' && dueDays == null) throw bad('bad_request');
  if (!isDate(startDate) || (endDate && (!isDate(endDate) || endDate < startDate))) throw bad('bad_date');
  return {
    name, amount: round2(amount), every, billDay, dueDays, whtRate, startDate, endDate,
    currency: currencyOf(pick('currency', 'currency')),
    vat: !!pick('vat', 'vat'), autoIssue: !!pick('autoIssue', 'auto_issue'),
    active: has(b, 'active') ? !!b.active : old.active ?? true,
    notes: str(pick('notes', 'notes'), 2000),
  };
}

router.get('/plans', wrap(async (req, res) => {
  const args = [];
  let where = '';
  if (req.query.clientId) {
    const c = await findClient(pool, String(req.query.clientId));
    args.push(c.id);
    where = 'where p.client_id = $1';
  }
  const rows = (await pool.query(
    `select p.*, c.name as client_name from billing_plans p join billing_clients c on c.id = p.client_id ${where} order by p.active desc, p.next_bill_date nulls last`, args)).rows;
  res.json({ plans: rows.map((p) => ({ ...planOut(p), clientName: p.client_name })) });
}));

router.post('/plans', wrap(async (req, res) => {
  const b = req.body || {};
  const c = await findClient(pool, String(b.clientId || ''));
  const f = planFields(b);
  const shaped = { every: f.every, bill_day: f.billDay, start_date: f.startDate, end_date: f.endDate };
  let next = has(b, 'nextBillDate') && isDate(b.nextBillDate) ? b.nextBillDate : firstRun(shaped);
  if (f.endDate && next > f.endDate) next = null;
  const r = await pool.query(
    `insert into billing_plans (client_id, name, amount, currency, every, bill_day, due_days, vat, wht_rate, start_date, end_date,
       next_bill_date, auto_issue, active, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning *`,
    [c.id, f.name, f.amount, f.currency, f.every, f.billDay, f.dueDays, f.vat, f.whtRate, f.startDate, f.endDate, next, f.autoIssue,
      f.active && next != null, f.notes]);
  res.status(201).json(planOut(r.rows[0]));
}));

router.put('/plans/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const b = req.body || {};
  const out = await tx(async (db) => {
    const old = (await db.query('select * from billing_plans where id = $1 for update', [req.params.id])).rows[0];
    if (!old) throw bad('not_found', 404);
    const f = planFields(b, old);
    let next = old.next_bill_date;
    const scheduleChanged = f.every !== old.every || f.billDay !== old.bill_day || f.startDate !== old.start_date;
    if (has(b, 'nextBillDate')) {
      if (b.nextBillDate != null && !isDate(b.nextBillDate)) throw bad('bad_date');
      next = b.nextBillDate || null;
    } else if (scheduleChanged) {
      // Recompute the next run from today (or the start date, if that is later).
      const today = bkkToday();
      const from = f.startDate > today ? f.startDate : today;
      next = firstRun({ every: f.every, bill_day: f.billDay, start_date: f.every === 'once' ? f.startDate : from });
    } else if (f.active && !next && !old.active) {
      next = firstRun({ every: f.every, bill_day: f.billDay, start_date: f.startDate > bkkToday() ? f.startDate : bkkToday() });
    }
    if (next && f.endDate && next > f.endDate) next = null;
    const r = await db.query(
      `update billing_plans set name = $2, amount = $3, currency = $4, every = $5, bill_day = $6, due_days = $7, vat = $8, wht_rate = $9,
         start_date = $10, end_date = $11, next_bill_date = $12, auto_issue = $13, active = $14, notes = $15 where id = $1 returning *`,
      [old.id, f.name, f.amount, f.currency, f.every, f.billDay, f.dueDays, f.vat, f.whtRate, f.startDate, f.endDate, next, f.autoIssue,
        f.active && next != null, f.notes]);
    return r.rows[0];
  });
  res.json(planOut(out));
}));

router.delete('/plans/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const r = await pool.query('delete from billing_plans where id = $1', [req.params.id]);
  if (!r.rowCount) throw bad('not_found', 404);
  res.json({ ok: true });
}));

// One tap: issue this plan's next bill now.
router.post('/plans/:id/issue', wrap(async (req, res) => {
  const d = req.body && req.body.issueDate;
  if (d != null && !isDate(d)) throw bad('bad_date');
  res.status(201).json(await issueFromPlan(req.params.id, { issueDate: d || undefined }));
}));

/* Invoices */

router.get('/invoices', wrap(async (req, res) => {
  const where = [];
  const args = [];
  const q = req.query;
  const today = bkkToday();
  if (q.clientId) { args.push((await findClient(pool, String(q.clientId))).id); where.push(`i.client_id = $${args.length}`); }
  if (q.status === 'overdue') { args.push(today); where.push(`i.status = 'issued' and i.due_date < $${args.length} and i.total > i.paid_amount`); }
  else if (q.status === 'unpaid') where.push("i.status = 'issued'");
  else if (['draft', 'issued', 'paid', 'void'].includes(q.status)) { args.push(q.status); where.push(`i.status = $${args.length}`); }
  if (isDate(q.from)) { args.push(q.from); where.push(`coalesce(i.issue_date, i.created_at::date) >= $${args.length}`); }
  if (isDate(q.to)) { args.push(q.to); where.push(`coalesce(i.issue_date, i.created_at::date) <= $${args.length}`); }
  const limit = intIn(q.limit, 1, 500) || 200;
  const rows = (await pool.query(
    `select i.*, c.name as client_name from billing_invoices i join billing_clients c on c.id = i.client_id
     ${where.length ? 'where ' + where.join(' and ') : ''}
     order by coalesce(i.issue_date, i.created_at::date) desc, i.created_at desc limit ${limit}`, args)).rows;
  res.json({ invoices: rows.map((i) => invoiceOut(i, null, today)) });
}));

function invoiceFields(b, old, s) {
  const items = has(b, 'items') ? cleanItems(b.items) : old ? old.items : cleanItems(b.items);
  const vatRate = has(b, 'vatRate') ? rateIn(b.vatRate) : has(b, 'vat') ? (b.vat ? s.vat_rate : 0) : old ? old.vat_rate : 0;
  const whtRate = has(b, 'whtRate') ? rateIn(b.whtRate) : old ? old.wht_rate : 0;
  if (vatRate == null || whtRate == null) throw bad('bad_request');
  const date = (k, col) => {
    const v = has(b, k) ? b[k] : old ? old[col] : null;
    if (v != null && v !== '' && !isDate(v)) throw bad('bad_date');
    return v || null;
  };
  return {
    items, vatRate, whtRate, ...totals(items, vatRate, whtRate),
    issueDate: date('issueDate', 'issue_date'), dueDate: date('dueDate', 'due_date'),
    periodStart: date('periodStart', 'period_start'), periodEnd: date('periodEnd', 'period_end'),
    currency: has(b, 'currency') ? currencyOf(b.currency) : old ? old.currency : 'THB',
    notes: has(b, 'notes') ? str(b.notes, 2000) : old ? old.notes : null,
  };
}

// Sets the number and dates of a draft and marks it issued.
async function issueDraft(db, inv, issueDate) {
  const client = await findClient(db, inv.client_id);
  const issued = issueDate || inv.issue_date || bkkToday();
  const due = inv.due_date && inv.due_date >= issued ? inv.due_date : addDays(issued, await dueDaysFor(db, client, null));
  const number = await nextNumber(db, issued);
  await db.query(
    `update billing_invoices set status = 'issued', number = $2, issue_date = $3, due_date = $4, issued_at = now(), updated_at = now() where id = $1`,
    [inv.id, number, issued, due]);
}

// A one-off invoice. `issue: true` gives it a number straight away; otherwise it stays a draft.
router.post('/invoices', wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async (db) => {
    const c = await findClient(db, String(b.clientId || ''));
    const f = invoiceFields(b, null, await settings(db));
    const id = (await db.query(
      `insert into billing_invoices (client_id, status, issue_date, due_date, period_start, period_end, currency, items, subtotal,
         vat_rate, vat, wht_rate, wht, total, notes, public_token)
       values ($1, 'draft', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
      [c.id, f.issueDate, f.dueDate, f.periodStart, f.periodEnd, f.currency, JSON.stringify(f.items), f.subtotal, f.vatRate, f.vat,
        f.whtRate, f.wht, f.total, f.notes, token()])).rows[0].id;
    if (b.issue) await issueDraft(db, await findInvoice(db, id, true), f.issueDate);
    return invoiceFull(db, id);
  });
  res.status(201).json(out);
}));

router.get('/invoices/:id', wrap(async (req, res) => {
  await findInvoice(pool, req.params.id);
  res.json(await invoiceFull(pool, req.params.id));
}));

router.put('/invoices/:id', wrap(async (req, res) => {
  const out = await tx(async (db) => {
    const old = await findInvoice(db, req.params.id, true);
    if (old.status === 'void') throw bad('invoice_void', 409);
    const f = invoiceFields(req.body || {}, old, await settings(db));
    if (old.status !== 'draft' && (!f.issueDate || !f.dueDate)) throw bad('bad_date');
    await db.query(
      `update billing_invoices set items = $2, subtotal = $3, vat_rate = $4, vat = $5, wht_rate = $6, wht = $7, total = $8,
         issue_date = $9, due_date = $10, period_start = $11, period_end = $12, currency = $13, notes = $14, updated_at = now() where id = $1`,
      [old.id, JSON.stringify(f.items), f.subtotal, f.vatRate, f.vat, f.whtRate, f.wht, f.total, f.issueDate, f.dueDate,
        f.periodStart, f.periodEnd, f.currency, f.notes]);
    await recalcPaid(db, old.id);
    return invoiceFull(db, old.id);
  });
  res.json(out);
}));

router.post('/invoices/:id/issue', wrap(async (req, res) => {
  const d = req.body && req.body.issueDate;
  if (d != null && !isDate(d)) throw bad('bad_date');
  const out = await tx(async (db) => {
    const inv = await findInvoice(db, req.params.id, true);
    if (inv.status !== 'draft') throw bad('not_draft', 409);
    await issueDraft(db, inv, d);
    return invoiceFull(db, inv.id);
  });
  res.json(out);
}));

router.post('/invoices/:id/void', wrap(async (req, res) => {
  const out = await tx(async (db) => {
    const inv = await findInvoice(db, req.params.id, true);
    if (inv.status === 'draft') throw bad('not_issued', 409);
    await db.query("update billing_invoices set status = 'void', updated_at = now() where id = $1", [inv.id]);
    return invoiceFull(db, inv.id);
  });
  res.json(out);
}));

router.delete('/invoices/:id', wrap(async (req, res) => {
  const inv = await findInvoice(pool, req.params.id);
  if (inv.status !== 'draft') throw bad('not_draft', 409);
  await pool.query('delete from billing_invoices where id = $1', [inv.id]);
  res.json({ ok: true });
}));

// Money received. Without an amount, the whole balance is marked paid.
router.post('/invoices/:id/payments', wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async (db) => {
    const inv = await findInvoice(db, req.params.id, true);
    if (inv.status !== 'issued') throw bad(inv.status === 'paid' ? 'already_paid' : 'not_issued', 409);
    const amount = b.amount == null || b.amount === '' ? round2(inv.total - inv.paid_amount) : round2(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw bad('bad_amount');
    const paidOn = b.paidOn || bkkToday();
    if (!isDate(paidOn)) throw bad('bad_date');
    await db.query(
      'insert into billing_payments (invoice_id, amount, paid_on, method, reference, note) values ($1, $2, $3, $4, $5, $6)',
      [inv.id, amount, paidOn, str(b.method, 60), str(b.reference, 120), str(b.note, 600)]);
    await recalcPaid(db, inv.id);
    return invoiceFull(db, inv.id);
  });
  res.status(201).json(out);
}));

router.delete('/invoices/:id/payments/:pid', wrap(async (req, res) => {
  if (!isUuid(req.params.pid)) throw bad('not_found', 404);
  const out = await tx(async (db) => {
    const inv = await findInvoice(db, req.params.id, true);
    const r = await db.query('delete from billing_payments where id = $1 and invoice_id = $2', [req.params.pid, inv.id]);
    if (!r.rowCount) throw bad('not_found', 404);
    await recalcPaid(db, inv.id);
    return invoiceFull(db, inv.id);
  });
  res.json(out);
}));

/* API keys: made and revoked only by the signed-in owner, never with another key. */

const ownerOnly = (req, _res, next) => next(req.billingKey ? bad('session_required', 403) : undefined);

router.get('/keys', ownerOnly, wrap(async (_req, res) => {
  const rows = (await pool.query('select id, name, prefix, created_at, last_used_at from billing_api_keys where revoked_at is null order by created_at')).rows;
  res.json({ keys: rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at })) });
}));

router.post('/keys', ownerOnly, rateLimit(20, 60 * 60000), wrap(async (req, res) => {
  const name = str(req.body && req.body.name, 80) || 'API key';
  const key = `cbk_${crypto.randomBytes(24).toString('base64url')}`;
  const r = await pool.query('insert into billing_api_keys (name, prefix, key_hash) values ($1, $2, $3) returning id, created_at',
    [name, key.slice(0, 8), sha(key)]);
  res.status(201).json({ id: r.rows[0].id, name, key, prefix: key.slice(0, 8), createdAt: r.rows[0].created_at });
}));

router.delete('/keys/:id', ownerOnly, wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const r = await pool.query('update billing_api_keys set revoked_at = now() where id = $1 and revoked_at is null', [req.params.id]);
  if (!r.rowCount) throw bad('not_found', 404);
  res.json({ ok: true });
}));

export const billingRouter = router;

/* ---------- Public links (no sign-in) ---------- */

export const billingPublic = express.Router();
billingPublic.use(rateLimit(120, 15 * 60000));

const sellerOut = (s) => ({
  name: s.seller_name, taxId: s.seller_tax_id, address: s.seller_address, phone: s.seller_phone, email: s.seller_email,
  bankInfo: s.bank_info, footerNote: s.footer_note,
});
const buyerOut = (c) => ({ name: c.name, contactName: c.contact_name, taxId: c.tax_id, address: c.address, email: c.email, phone: c.phone });
const publicInvoice = (i, pays) => {
  const o = invoiceOut(i, pays);
  delete o.planId; delete o.clientId; delete o.notes; delete o.createdAt; delete o.updatedAt; delete o.issuedAt; delete o.clientName;
  o.note = i.notes;
  return o;
};

billingPublic.get('/invoice/:token', wrap(async (req, res) => {
  const t = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) throw bad('not_found', 404);
  const i = (await pool.query("select * from billing_invoices where public_token = $1 and status <> 'draft'", [t])).rows[0];
  if (!i) throw bad('not_found', 404);
  const c = await findClient(pool, i.client_id);
  const pays = (await pool.query('select * from billing_payments where invoice_id = $1 order by paid_on', [i.id])).rows;
  res.set('Cache-Control', 'no-store');
  res.json({ seller: sellerOut(await settings()), buyer: buyerOut(c), invoice: publicInvoice(i, pays) });
}));

billingPublic.get('/client/:token', wrap(async (req, res) => {
  const t = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) throw bad('not_found', 404);
  const c = (await pool.query('select * from billing_clients where portal_token = $1', [t])).rows[0];
  if (!c) throw bad('not_found', 404);
  const rows = (await pool.query(
    "select * from billing_invoices where client_id = $1 and status in ('issued', 'paid') order by issue_date desc, created_at desc limit 100", [c.id])).rows;
  const st = await clientStatus(pool, c.id);
  res.set('Cache-Control', 'no-store');
  res.json({
    seller: sellerOut(await settings()), buyer: buyerOut(c),
    status: { outstanding: st.outstanding, overdueAmount: st.overdueAmount, overdueCount: st.overdueCount, openCount: st.openCount, nextDue: st.nextDue, paidUp: st.paidUp },
    invoices: rows.map((i) => publicInvoice(i)),
  });
}));

/* ---------- Daily job: auto-issue and owner reminders ---------- */

const fmtMoney = (n, cur) => `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur === 'THB' ? ' บาท' : ' ' + cur}`;

export async function billingTick(now = new Date()) {
  const today = bkkToday(now);
  const owners = await adminIds();
  const due = (await pool.query(
    'select id from billing_plans where active and auto_issue and next_bill_date is not null and next_bill_date <= $1 order by next_bill_date', [today])).rows;
  const issued = [];
  for (const p of due) {
    // A plan that fell behind catches up one run per tick; each run is its own invoice.
    try {
      issued.push(await issueFromPlan(p.id, { auto: true }));
    } catch (e) {
      if (!e.expose) console.error('billing auto-issue', e);
    }
  }
  for (const inv of issued) {
    await pushTo(owners, {
      title: `ออกบิลแล้ว ${inv.number}`, body: `${inv.clientName} · ${fmtMoney(inv.total, inv.currency)} · ครบกำหนด ${thDate(inv.dueDate)}`,
      url: `/billing/#invoice/${inv.id}`, tag: `bill-${inv.id}`,
    }).catch(() => {});
  }
  const s = await settings();
  const soon = (await pool.query(
    `update billing_invoices i set reminded_at = now() from billing_clients c
     where c.id = i.client_id and i.status = 'issued' and i.reminded_at is null and i.due_date >= $1 and i.due_date <= $2 and i.total > i.paid_amount
     returning i.id, i.number, i.due_date, i.total - i.paid_amount as balance, i.currency, c.name`, [today, addDays(today, s.remind_days)])).rows;
  const late = (await pool.query(
    `update billing_invoices i set overdue_at = now() from billing_clients c
     where c.id = i.client_id and i.status = 'issued' and i.overdue_at is null and i.due_date < $1 and i.total > i.paid_amount
     returning i.id, i.number, i.due_date, i.total - i.paid_amount as balance, i.currency, c.name`, [today])).rows;
  for (const r of soon) {
    await pushTo(owners, { title: `ใกล้ครบกำหนด ${r.number}`, body: `${r.name} ยังไม่จ่าย ${fmtMoney(r.balance, r.currency)} · ครบ ${thDate(r.due_date)}`, url: `/billing/#invoice/${r.id}`, tag: `bill-${r.id}` }).catch(() => {});
  }
  for (const r of late) {
    await pushTo(owners, { title: `เลยกำหนดชำระ ${r.number}`, body: `${r.name} ค้าง ${fmtMoney(r.balance, r.currency)} · ครบ ${thDate(r.due_date)}`, url: `/billing/#invoice/${r.id}`, tag: `bill-${r.id}` }).catch(() => {});
  }
  return { issued: issued.length, reminded: soon.length, overdue: late.length };
}

export function startBillingJobs() {
  const run = () => billingTick().catch((e) => console.error('billing tick', e));
  setTimeout(run, 20000).unref();
  setInterval(run, 10 * 60000).unref();
}
