// account.centel.app ⇄ Centel (centel.app): reminders delivered by the Centel app.
//
// Linking: on the business's การแจ้งเตือน page the accounting app asks for a short code
// (POST /api/acc/b/:biz/centel/code). The person opens centel.app/#link-account=CODE (or types the
// code in Centel › การแจ้งเตือน › Centel Account) and approves it while signed in to Centel
// (POST /api/acc-link/approve). That Centel profile is then linked to the business until either
// side removes it. The two apps share this api, so "talking over the API" is these endpoints.
//
// Reminders: each acc_reminders row is a deadline: a tax form (ภ.พ.30 on the 23rd, ภ.ง.ด.1/3/53 on
// the 15th), paying a supplier, collecting from a customer, or anything else; monthly, yearly or
// once. Unpaid expenses / invoices reaching their due date can be switched on too
// (acc_reminder_prefs). A week before each due day, syncReminders() adds a to-do to every linked
// Centel profile with remind_at set, so Centel's own reminder job (line.js sendDueReminders)
// sends the notification, the LINE group message and the chat line.
import crypto from 'node:crypto';
import express from 'express';
import { pool } from '../db.js';
import { requireUser, rateLimit, sha } from '../auth.js';
import { remindAt } from '../noteparse.js';
import { pushTo } from '../push.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const wrapFn = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const str = (v, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const DAY = 86400e3;
const TZ = 7 * 3600e3;
const CODE_MIN = 15;
const AHEAD_DAYS = 7; // the to-do shows in Centel this many days before the due day
const ACC_URL = process.env.ACC_PUBLIC_URL || 'https://account.centel.app';
const CENTEL_URL = process.env.CENTEL_PUBLIC_URL || 'https://centel.app';

// Tax presets: the Revenue Department's usual online deadlines (in the month after the tax month).
export const PRESETS = {
  pp30: { title: 'ยื่น ภ.พ.30 ภาษีมูลค่าเพิ่ม', day: 23, path: '#/vat/returns' },
  pnd1: { title: 'ยื่น ภ.ง.ด.1 หัก ณ ที่จ่าย เงินเดือน', day: 15, path: '#/reports' },
  pnd3: { title: 'ยื่น ภ.ง.ด.3 หัก ณ ที่จ่าย บุคคลธรรมดา', day: 15, path: '#/reports' },
  pnd53: { title: 'ยื่น ภ.ง.ด.53 หัก ณ ที่จ่าย นิติบุคคล', day: 15, path: '#/reports' },
};
export const CATEGORIES = { tax: 'ภาษี', pay: 'จ่ายคู่ค้า', collect: 'รับเงินลูกค้า', other: 'อื่นๆ' };
const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DAY = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const baht = (n) => `฿${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ---------- Dates ---------- */

export const bangkokToday = (now = new Date()) => new Date(now.getTime() + TZ).toISOString().slice(0, 10);
const ds = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekday = (s) => new Date(`${s}T00:00:00Z`).getUTCDay();
const addDays = (s, k) => new Date(Date.parse(`${s}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
export const thDate = (s) => { const [y, m, d] = s.split('-').map(Number); return `${d} ${TH_MONTH[m - 1]} ${y + 543}`; };

// The day the reminder is for: the due day, or the Friday before when it falls on a weekend
// and `early` is on.
function effective(due, early) {
  const w = weekday(due);
  if (!early || (w !== 0 && w !== 6)) return due;
  return addDays(due, w === 6 ? -1 : -2);
}

// The next deadline of a reminder whose day (after the weekend move) is today or later.
export function nextDue(r, today = bangkokToday()) {
  if (r.every === 'once') {
    const date = effective(r.date, r.early);
    return date >= today ? { due: r.date, date, moved: date !== r.date } : null;
  }
  const [ty, tm] = today.split('-').map(Number);
  for (let k = 0; k < 26; k++) {
    let y, m;
    if (r.every === 'yearly') { if (k > 2) break; y = ty + k; m = r.month; } else { const t = ty * 12 + (tm - 1) + k; y = Math.floor(t / 12); m = (t % 12) + 1; }
    const due = ds(y, m, Math.min(r.day, dim(y, m)));
    const date = effective(due, r.early);
    if (date >= today) return { due, date, moved: date !== due };
  }
  return null;
}

// The tax month a preset deadline is for: the month before the due month.
function taxMonth(due) {
  const [y, m] = due.split('-').map(Number);
  const t = y * 12 + (m - 1) - 1;
  return `${TH_MONTH[t % 12]} ${Math.floor(t / 12) + 543}`;
}

// The to-do text and description put into Centel for one deadline.
export function todoFor(r, bizName, next) {
  const p = PRESETS[r.kind];
  const head = [p ? `${r.title} (${taxMonth(next.due)})` : r.title];
  if (r.contact_name) head.push(r.contact_name);
  if (r.amount) head.push(baht(r.amount));
  head.push(bizName);
  const lines = [`${r.category === 'pay' ? 'กำหนดจ่าย' : r.category === 'collect' ? 'กำหนดรับเงิน' : p ? 'กำหนดยื่นออนไลน์' : 'กำหนด'}ภายในวันที่ ${thDate(next.due)} (${TH_DAY[weekday(next.due)]})`];
  if (next.moved) lines.push(`ตรงวันหยุดเสาร์-อาทิตย์ จึงเตือนให้ทำก่อนวันศุกร์ที่ ${thDate(next.date)}`);
  if (r.note) lines.push(r.note);
  if (r.category === 'tax') lines.push('ถ้าตรงวันหยุดราชการ ตรวจประกาศกรมสรรพากรของเดือนนั้นอีกครั้ง');
  lines.push(`เปิดใน Centel Account: ${ACC_URL}/${p ? p.path : '#/reminders'}`);
  return { text: head.join(' · ').slice(0, 500), body: lines.join('\n').slice(0, 5000) };
}

// When Centel reminds: 09:00 Bangkok, remind_days before the (moved) day.
const remindTime = (days, date) => remindAt(date, null, days * 1440);

/* ---------- Putting deadlines into Centel ---------- */

// Adds one to-do (once: the claim insert stops repeats) to a Centel profile.
async function addTodo(claimSql, claimArgs, setSql, userId, todo, date, days, now) {
  let at = remindTime(days, date);
  // Made late (the reminder time has gone but the day has not): remind now instead.
  if (at < now) at = new Date(now.getTime() + 60000);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claim = await client.query(claimSql, claimArgs);
    let added = 0;
    if (claim.rowCount) {
      const id = crypto.randomUUID();
      await client.query(
        `insert into notes (id, owner_id, kind, text, body, tags, priority, date, remind, remind_at)
         values ($1, $2, 'todo', $3, $4, $5, 'high', $6, $7, $8)`,
        [id, userId, todo.text, todo.body, todo.tags, date, days * 1440, at]);
      await client.query(setSql, [...claimArgs, id]);
      added = 1;
    }
    await client.query('commit');
    return added;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Adds the coming deadline of every active reminder (and, where switched on, unpaid documents
// coming due) to each linked Centel profile, once per due date. Safe to run any time.
export async function syncReminders({ businessId = null, now = new Date() } = {}) {
  const today = bangkokToday(now);
  const horizon = addDays(today, AHEAD_DAYS);
  let added = 0;
  const rows = (await pool.query(
    `select r.*, b.name as biz_name, c.name as contact_name, array_agg(l.user_id) as users
     from acc_reminders r join acc_businesses b on b.id = r.business_id
     join acc_centel_links l on l.business_id = r.business_id
     left join acc_contacts c on c.id = r.contact_id
     where r.active and ($1::uuid is null or r.business_id = $1)
     group by r.id, b.name, c.name`, [businessId])).rows;
  for (const r of rows) {
    const next = nextDue(r, today);
    if (!next || next.date > horizon) continue;
    const todo = { ...todoFor(r, r.biz_name, next), tags: ['บัญชี', CATEGORIES[r.category] || 'อื่นๆ'] };
    for (const userId of r.users) {
      added += await addTodo(
        'insert into acc_reminder_sent (reminder_id, due_date, user_id) values ($1, $2, $3) on conflict do nothing returning 1',
        [r.id, next.due, userId],
        'update acc_reminder_sent set note_id = $4 where reminder_id = $1 and due_date = $2 and user_id = $3',
        userId, todo, next.date, r.remind_days, now).catch((e) => { console.error('reminder', r.id, e.message); return 0; });
    }
  }

  // Documents: a paid or voided one takes back its to-do if it has not reminded yet.
  await pool.query(
    `with gone as (
       delete from acc_doc_reminder_sent s using acc_docs d
       where d.id = s.doc_id and (d.status <> 'open' or d.due_date is distinct from s.due_date)
         and ($1::uuid is null or d.business_id = $1)
         and (s.note_id is null or exists (select 1 from notes n where n.id = s.note_id and n.notified_at is null and not n.done))
       returning s.note_id)
     delete from notes where id in (select note_id from gone)`, [businessId]);
  const docs = (await pool.query(
    `select d.id, d.type, d.number, d.due_date::text as due_date, d.total, d.contact->>'name' as contact_name, b.name as biz_name,
       p.remind_days, array(select l.user_id from acc_centel_links l where l.business_id = d.business_id) as users
     from acc_docs d join acc_reminder_prefs p on p.business_id = d.business_id join acc_businesses b on b.id = d.business_id
     where d.status = 'open' and d.due_date between $2 and $3
       and ((d.type = 'EX' and p.ex_due) or (d.type = 'IV' and p.iv_due))
       and ($1::uuid is null or d.business_id = $1)
       and exists (select 1 from acc_centel_links l where l.business_id = d.business_id)`, [businessId, today, horizon])).rows;
  for (const d of docs) {
    const pay = d.type === 'EX';
    const todo = {
      text: [`${pay ? 'จ่าย' : 'ตามเก็บเงิน'} ${d.number}`, d.contact_name, baht(d.total), d.biz_name].filter(Boolean).join(' · ').slice(0, 500),
      body: [`${pay ? 'ค่าใช้จ่ายรอจ่าย' : 'ใบแจ้งหนี้รอรับชำระ'} ครบกำหนดวันที่ ${thDate(d.due_date)} (${TH_DAY[weekday(d.due_date)]})`,
        `เปิดเอกสาร: ${ACC_URL}/#/doc/${d.id}`].join('\n'),
      tags: ['บัญชี', pay ? CATEGORIES.pay : CATEGORIES.collect],
    };
    for (const userId of d.users) {
      added += await addTodo(
        'insert into acc_doc_reminder_sent (doc_id, due_date, user_id) values ($1, $2, $3) on conflict do nothing returning 1',
        [d.id, d.due_date, userId],
        'update acc_doc_reminder_sent set note_id = $4 where doc_id = $1 and due_date = $2 and user_id = $3',
        userId, todo, d.due_date, d.remind_days, now).catch((e) => { console.error('doc reminder', d.id, e.message); return 0; });
    }
  }
  return added;
}

// Takes back to-dos that have not reminded anyone yet (and are not ticked), so an edited,
// paused or deleted reminder is put in again with its new details, or not at all.
async function withdraw({ reminderId = null, businessId = null, userId = null, docs = false, deadlines = true }) {
  if (deadlines) await pool.query(
    `with gone as (
       delete from acc_reminder_sent s using acc_reminders r
       where r.id = s.reminder_id and ($1::uuid is null or s.reminder_id = $1) and ($2::uuid is null or r.business_id = $2)
         and ($3::uuid is null or s.user_id = $3)
         and (s.note_id is null or exists (select 1 from notes n where n.id = s.note_id and n.notified_at is null and not n.done))
       returning s.note_id)
     delete from notes where id in (select note_id from gone)`, [reminderId, businessId, userId]);
  if (!docs) return;
  await pool.query(
    `with gone as (
       delete from acc_doc_reminder_sent s using acc_docs d
       where d.id = s.doc_id and d.business_id = $1 and ($2::uuid is null or s.user_id = $2)
         and (s.note_id is null or exists (select 1 from notes n where n.id = s.note_id and n.notified_at is null and not n.done))
       returning s.note_id)
     delete from notes where id in (select note_id from gone)`, [businessId, userId]);
}

/* ---------- Accounting app side: /api/acc/b/:biz/… ---------- */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const cleanCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function linksOf(bizId) {
  return (await pool.query(
    `select l.id, l.created_at, coalesce(u.nickname, u.display_name) as name, u.avatar, coalesce(u.email, p.email) as email
     from acc_centel_links l join users u on u.id = l.user_id left join users p on p.id = u.parent_id
     where l.business_id = $1 order by l.created_at`, [bizId])).rows
    .map((x) => ({ ...x, avatar: typeof x.avatar === 'string' && x.avatar.length < 20 ? x.avatar : null }));
}

async function prefsOf(bizId) {
  const p = (await pool.query('select ex_due, iv_due, remind_days from acc_reminder_prefs where business_id = $1', [bizId])).rows[0];
  return p || { ex_due: false, iv_due: false, remind_days: 1 };
}

async function reminderIn(body, cur, bizId) {
  const has = (k) => body[k] !== undefined;
  const kind = has('kind') ? (PRESETS[body.kind] ? body.kind : 'custom') : cur.kind || 'custom';
  const p = PRESETS[kind];
  const category = p ? 'tax' : has('category') ? (CATEGORIES[body.category] ? body.category : 'other') : cur.category || 'other';
  const title = has('title') ? str(body.title, 200) : cur.title || p?.title;
  if (!title) throw bad('bad_title');
  const every = p ? 'monthly' : has('every') ? (['yearly', 'once'].includes(body.every) ? body.every : 'monthly') : cur.every || 'monthly';
  let day = null; let month = null; let date = null;
  if (every === 'once') {
    date = has('date') ? body.date : cur.date;
    if (!isDate(date)) throw bad('bad_date');
  } else {
    day = Number(has('day') ? body.day : cur.day ?? p?.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw bad('bad_day');
    if (every === 'yearly') {
      month = Number(has('month') ? body.month : cur.month);
      if (!(Number.isInteger(month) && month >= 1 && month <= 12)) throw bad('bad_month');
    }
  }
  const remindDays = Number(has('remind_days') ? body.remind_days : cur.remind_days ?? 2);
  if (![0, 1, 2, 3].includes(remindDays)) throw bad('bad_remind');
  let contactId = has('contact_id') ? body.contact_id || null : cur.contact_id ?? null;
  if (contactId && !(isUuid(contactId) && (await pool.query('select 1 from acc_contacts where id = $1 and business_id = $2', [contactId, bizId])).rowCount)) throw bad('bad_contact');
  const amount = has('amount') ? (body.amount === '' || body.amount == null ? null : Math.round(Number(body.amount) * 100) / 100) : cur.amount ?? null;
  if (amount != null && !(Number.isFinite(amount) && amount >= 0 && amount < 1e12)) throw bad('bad_amount');
  return {
    kind, category, title, every, day, month, date, contact_id: contactId, amount: amount || null, remind_days: remindDays,
    early: has('early') ? !!body.early : cur.early ?? true,
    note: has('note') ? str(body.note, 500) : cur.note ?? null,
    active: has('active') ? !!body.active : cur.active ?? true,
  };
}

function reminderOut(r, today = bangkokToday()) {
  const next = r.active ? nextDue(r, today) : null;
  return {
    id: r.id, kind: r.kind, category: r.category, title: r.title, every: r.every, day: r.day, month: r.month, date: r.date,
    contact_id: r.contact_id, amount: r.amount, remind_days: r.remind_days, early: r.early, note: r.note, active: r.active,
    created_at: r.created_at,
    next: next ? { ...next, remind_at: remindTime(r.remind_days, next.date).toISOString() } : null,
  };
}

const COLS = ['kind', 'category', 'title', 'every', 'day', 'month', 'date', 'contact_id', 'amount', 'remind_days', 'early', 'note', 'active'];

export function mountCentel(biz, { wrap = wrapFn } = {}) {
  biz.get('/centel', wrap(async (req, res) => {
    res.json({ links: await linksOf(req.biz.id) });
  }));

  // A new code for this business (earlier unused ones of the same person stop working).
  biz.post('/centel/code', rateLimit(30, 60 * 60000), wrap(async (req, res) => {
    const code = newCode();
    await pool.query(
      "delete from acc_centel_codes where (business_id = $1 and created_by = $2 and approved_by is null) or expires_at < now() - interval '1 day'",
      [req.biz.id, req.user.id]);
    const expires = new Date(Date.now() + CODE_MIN * 60000);
    await pool.query('insert into acc_centel_codes (code_hash, business_id, created_by, expires_at) values ($1, $2, $3, $4)',
      [sha(code), req.biz.id, req.user.id, expires]);
    res.json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, url: `${CENTEL_URL}/#link-account=${code}`, expires_at: expires.toISOString() });
  }));

  biz.delete('/centel/:id', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('not_found', 404);
    const row = (await pool.query('select user_id from acc_centel_links where id = $1 and business_id = $2', [req.params.id, req.biz.id])).rows[0];
    if (!row) throw bad('not_found', 404);
    await withdraw({ businessId: req.biz.id, userId: row.user_id, docs: true });
    await pool.query('delete from acc_centel_links where id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  biz.get('/reminders', wrap(async (req, res) => {
    const rows = (await pool.query('select * from acc_reminders where business_id = $1 order by active desc, created_at', [req.biz.id])).rows;
    res.json({ reminders: rows.map((r) => reminderOut(r)), links: await linksOf(req.biz.id), prefs: await prefsOf(req.biz.id), presets: PRESETS });
  }));

  // Reminders from documents (unpaid expenses / invoices coming due).
  biz.put('/reminders/prefs', wrap(async (req, res) => {
    const cur = await prefsOf(req.biz.id);
    const b = req.body || {};
    const days = b.remind_days !== undefined ? Number(b.remind_days) : cur.remind_days;
    if (![0, 1, 2, 3].includes(days)) throw bad('bad_remind');
    const next = { ex_due: b.ex_due !== undefined ? !!b.ex_due : cur.ex_due, iv_due: b.iv_due !== undefined ? !!b.iv_due : cur.iv_due, remind_days: days };
    await withdraw({ businessId: req.biz.id, docs: true, deadlines: false });
    await pool.query(
      `insert into acc_reminder_prefs (business_id, ex_due, iv_due, remind_days) values ($1, $2, $3, $4)
       on conflict (business_id) do update set ex_due = $2, iv_due = $3, remind_days = $4, updated_at = now()`,
      [req.biz.id, next.ex_due, next.iv_due, next.remind_days]);
    await syncReminders({ businessId: req.biz.id }).catch((e) => console.error('reminders', e.message));
    res.json({ prefs: next });
  }));

  biz.post('/reminders', rateLimit(120, 60 * 60000), wrap(async (req, res) => {
    const n = (await pool.query('select count(*)::int as n from acc_reminders where business_id = $1', [req.biz.id])).rows[0].n;
    if (n >= 100) throw bad('too_many');
    const x = await reminderIn(req.body || {}, {}, req.biz.id);
    const row = (await pool.query(
      `insert into acc_reminders (business_id, created_by, ${COLS.join(', ')})
       values ($1, $2, ${COLS.map((_, i) => `$${i + 3}`).join(', ')}) returning *`,
      [req.biz.id, req.user.id, ...COLS.map((k) => x[k])])).rows[0];
    await syncReminders({ businessId: req.biz.id }).catch((e) => console.error('reminders', e.message));
    res.json({ reminder: reminderOut(row) });
  }));

  const own = async (req) => {
    if (!isUuid(req.params.id)) throw bad('not_found', 404);
    const r = (await pool.query('select * from acc_reminders where id = $1 and business_id = $2', [req.params.id, req.biz.id])).rows[0];
    if (!r) throw bad('not_found', 404);
    return r;
  };

  biz.put('/reminders/:id', wrap(async (req, res) => {
    const cur = await own(req);
    const x = await reminderIn(req.body || {}, cur, req.biz.id);
    await withdraw({ reminderId: cur.id });
    const row = (await pool.query(
      `update acc_reminders set ${COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
      [cur.id, ...COLS.map((k) => x[k])])).rows[0];
    await syncReminders({ businessId: req.biz.id }).catch((e) => console.error('reminders', e.message));
    res.json({ reminder: reminderOut(row) });
  }));

  biz.delete('/reminders/:id', wrap(async (req, res) => {
    const cur = await own(req);
    await withdraw({ reminderId: cur.id });
    await pool.query('delete from acc_reminders where id = $1', [cur.id]);
    res.json({ ok: true });
  }));

  // A notification right now to every linked Centel device, to check the link works.
  biz.post('/reminders/:id/test', rateLimit(20, 60 * 60000), wrap(async (req, res) => {
    const r = await own(req);
    const users = (await pool.query('select user_id from acc_centel_links where business_id = $1', [req.biz.id])).rows.map((x) => x.user_id);
    if (!users.length) throw bad('not_linked', 409);
    const contact = r.contact_id ? (await pool.query('select name from acc_contacts where id = $1', [r.contact_id])).rows[0]?.name : null;
    const next = nextDue({ ...r, active: true }) || { due: r.date || bangkokToday(), date: r.date || bangkokToday() };
    const { text } = todoFor({ ...r, contact_name: contact }, req.biz.name, next);
    const devices = await pushTo(users, { title: '🔔 ทดสอบการแจ้งเตือน', body: `${text}\n📅 กำหนด ${thDate(next.due)}`, url: '/', tag: `acc-test-${r.id}` });
    res.json({ devices, people: users.length });
  }));
}

/* ---------- Centel side: /api/acc-link ---------- */

export const centelLinkRouter = express.Router();
centelLinkRouter.use(requireUser);
const smallLogo = (v) => (typeof v === 'string' && v.length < 200000 ? v : null);

async function codeRow(raw) {
  const code = cleanCode(raw);
  if (code.length !== 8) return null;
  const r = (await pool.query(
    `select c.*, b.name as business, b.logo, coalesce(u.nickname, u.display_name) as by_name, coalesce(u.email, p.email) as by_email
     from acc_centel_codes c join acc_businesses b on b.id = c.business_id join users u on u.id = c.created_by
     left join users p on p.id = u.parent_id where c.code_hash = $1`, [sha(code)])).rows[0];
  return r && r.expires_at > new Date() && !r.approved_by ? r : null;
}

// Businesses whose reminders come to me.
centelLinkRouter.get('/', wrapFn(async (req, res) => {
  const rows = (await pool.query(
    `select l.id, l.created_at, b.name as business, b.logo,
       (select count(*)::int from acc_reminders r where r.business_id = l.business_id and r.active) as reminders
     from acc_centel_links l join acc_businesses b on b.id = l.business_id where l.user_id = $1 order by l.created_at`, [req.user.id])).rows;
  res.json({ links: rows.map((x) => ({ ...x, logo: smallLogo(x.logo) })) });
}));

// What a code is for, shown before the person approves it.
centelLinkRouter.get('/code/:code', rateLimit(60, 15 * 60000), wrapFn(async (req, res) => {
  const r = await codeRow(req.params.code);
  if (!r) throw bad('code_gone', 404);
  res.json({ business: r.business, logo: smallLogo(r.logo), by: r.by_name, email: r.by_email });
}));

centelLinkRouter.post('/approve', rateLimit(30, 15 * 60000), wrapFn(async (req, res) => {
  const r = await codeRow(req.body?.code);
  if (!r) throw bad('code_gone', 404);
  const used = await pool.query('update acc_centel_codes set approved_by = $2 where code_hash = $1 and approved_by is null returning 1', [r.code_hash, req.user.id]);
  if (!used.rowCount) throw bad('code_gone', 404);
  await pool.query(
    'insert into acc_centel_links (business_id, user_id, linked_by) values ($1, $2, $3) on conflict (business_id, user_id) do nothing',
    [r.business_id, req.user.id, r.created_by]);
  const added = await syncReminders({ businessId: r.business_id }).catch(() => 0);
  res.json({ business: r.business, added });
}));

centelLinkRouter.delete('/:id', wrapFn(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const row = (await pool.query('select business_id from acc_centel_links where id = $1 and user_id = $2', [req.params.id, req.user.id])).rows[0];
  if (!row) throw bad('not_found', 404);
  await withdraw({ businessId: row.business_id, userId: req.user.id, docs: true });
  await pool.query('delete from acc_centel_links where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

export function startReminderJob() {
  const tick = () => syncReminders().catch((e) => console.error('acc reminders', e.message));
  setTimeout(tick, 20000);
  setInterval(tick, 15 * 60000);
}
