import crypto from 'node:crypto';
import express from 'express';
import { pool, asUser } from './db.js';
import { hashPassword, verifyPassword, createSession, destroySession, requireUser, rateLimit } from './auth.js';
import { analyzeReceipt, aiEnabled, RECEIPT_MODEL } from './receipts.js';
import { putReceipt, receiptUrl, storageEnabled } from './storage.js';
import { verifyGoogleIdToken, googleClientId } from './google.js';
import { lineEnabled, linePush } from './line.js';

const router = express.Router();
// Compared against when an email is unknown, so login takes the same time either way.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const str = (v, max = 200) => (v == null || v === '' ? null : String(v).slice(0, max));
const money = (v) => Math.round(Number(v) * 100) / 100;
// A wallet picture is a short emoji or a small base64 image (about 160px, resized in the browser).
const IMG_ICON = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const walletIcon = (v) => {
  if (typeof v !== 'string' || !v) return null;
  if (v.startsWith('data:')) return v.length <= 120000 && IMG_ICON.test(v) ? v : null;
  return v.length <= 16 && !/[<>&"']/.test(v) ? v : null;
};
// Label ids on a transaction: at most 30 distinct short strings; null when not sent.
const labelIds = (v) => (Array.isArray(v)
  ? [...new Set(v.map((x) => str(x, 60)).filter(Boolean))].slice(0, 30)
  : null);
// Google profile photos are served from googleusercontent.com.
const googlePhoto = (v) => (typeof v === 'string' && v.length <= 1000 && /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\/[^\s"'<>]+$/.test(v) ? v : null);

/* ---------- Auth ---------- */

router.post('/auth/register', rateLimit(10, 15 * 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 60);
  const nickname = String(req.body.nickname || '').trim().slice(0, 20) || null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('bad_email');
  if (password.length < 8) throw bad('weak_password');
  if (!name) throw bad('bad_name');
  const hash = await hashPassword(password);
  const r = await pool.query(
    'insert into users (email, password_hash, display_name, nickname) values ($1, $2, $3, $4) on conflict (email) do nothing returning id',
    [email, hash, name, nickname]);
  if (!r.rows[0]) throw bad('email_taken', 409);
  await createSession(res, r.rows[0].id);
  res.json({ ok: true });
}));

router.post('/auth/login', rateLimit(20, 15 * 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const r = await pool.query('select id, password_hash from users where email = $1', [email]);
  const u = r.rows[0];
  // Hash even when the user is missing so timing does not reveal which emails exist.
  // Google-only accounts have no password and also get the dummy comparison.
  const ok = await verifyPassword(String(req.body.password || ''), u?.password_hash || await DUMMY_HASH);
  if (!u?.password_hash || !ok) throw bad('bad_credentials', 401);
  await createSession(res, u.id);
  res.json({ ok: true });
}));

// Sign in with Google: the browser gets an ID token from Google Identity Services
// and we verify it here. A first sign-in creates the account, or links it to an
// existing email/password account with the same (Google-verified) email.
router.post('/auth/google', rateLimit(20, 15 * 60000), wrap(async (req, res) => {
  if (!googleClientId()) throw bad('google_disabled', 503);
  const g = await verifyGoogleIdToken(req.body.credential);
  if (!g) throw bad('bad_google_token', 401);
  let r = await pool.query('select id from users where google_sub = $1', [g.sub]);
  if (!r.rows[0]) {
    const email = String(g.email || '').trim().toLowerCase();
    if (!email || !(g.email_verified === true || g.email_verified === 'true')) throw bad('google_unverified', 403);
    const name = String(g.name || g.given_name || email.split('@')[0]).trim().slice(0, 60);
    r = await pool.query(
      `insert into users (email, display_name, google_sub) values ($1, $2, $3)
       on conflict (email) do update set google_sub = coalesce(users.google_sub, excluded.google_sub)
       returning id, google_sub`, [email, name, g.sub]);
    // The email already belongs to an account linked to a different Google account.
    if (r.rows[0].google_sub !== g.sub) throw bad('google_mismatch', 409);
  }
  await pool.query('update users set google_picture = $2 where id = $1', [r.rows[0].id, googlePhoto(g.picture)]);
  await createSession(res, r.rows[0].id);
  res.json({ ok: true });
}));

router.post('/auth/logout', wrap(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

// Public runtime config for the app. The Google client id is not a secret.
router.get('/config', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ googleClientId: googleClientId() });
});

/* ---------- Calendar subscription feed (public, by secret token) ---------- */

// iPhone Calendar fetches this URL on its own schedule without the session cookie,
// so the long random token in the path is the only key. Regenerating it cuts off
// every calendar that subscribed with the old one.
const CAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMPTY_ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//centel.app//Bill Planner//TH',
  'X-WR-CALNAME:วางแผนจ่ายบิล', 'END:VCALENDAR', ''].join('\r\n');

router.get('/calendar/:file', wrap(async (req, res) => {
  const token = String(req.params.file).replace(/\.ics$/, '');
  if (!CAL_TOKEN.test(token)) throw bad('not_found', 404);
  const r = await pool.query('select ics, updated_at from calendar_feeds where token = $1', [token]);
  if (!r.rows[0]) throw bad('not_found', 404);
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="centel-bills.ics"',
    'Cache-Control': 'no-cache',
    'Last-Modified': new Date(r.rows[0].updated_at).toUTCString(),
    'X-Robots-Tag': 'noindex',
  });
  res.send(r.rows[0].ics || EMPTY_ICS);
}));

/* ---------- Everything below needs a session ---------- */

router.use(requireUser);

const uid = (req) => req.user.id;

function expenseOut(e, shares, events, labels) {
  return {
    id: e.id, ownerId: e.owner_id, coupleId: e.couple_id, scope: e.scope, type: e.type, date: e.date,
    merchant: e.merchant, amount: e.amount, category: e.category, note: e.note, walletId: e.wallet_id,
    toWalletId: e.to_wallet_id, payerId: e.payer_id, payerWalletId: e.payer_wallet_id, status: e.status,
    reviewNeeded: e.review_needed, receiptKey: e.receipt_key, slipRef: e.slip_ref, billId: e.bill_id, billYm: e.bill_ym,
    currency: e.currency || 'THB',
    revision: e.revision, approvedBy: e.approved_by, approvedAt: e.approved_at, rejectedBy: e.rejected_by,
    rejectedAt: e.rejected_at, rejectReason: e.reject_reason, createdAt: e.created_at,
    shares: shares ? Object.fromEntries(shares.map((s) => [s.user_id, s.amount])) : undefined,
    events: events || undefined,
    labels: labels || [],
  };
}

// Replaces my labels on one expense. Unknown label ids are dropped.
async function writeLabels(db, id, ids) {
  await db.query('delete from expense_labels where expense_id = $1', [id]);
  if (ids.length) {
    await db.query(
      'insert into expense_labels (expense_id, label_id) select $1, l.id from labels l where l.id = any($2::text[])',
      [id, ids]);
  }
}

router.get('/bootstrap', wrap(async (req, res) => {
  // Only the owner sees their own Google photo offer; app_user cannot read the column.
  const googlePic = (await pool.query('select google_picture from users where id = $1', [uid(req)])).rows[0]?.google_picture;
  const out = await asUser(uid(req), async (db) => {
    const me = (await db.query('select id, email, display_name, nickname, avatar from users where id = app_uid()')).rows[0];
    const partner = (await db.query('select id, email, display_name, nickname, avatar from users where id = my_partner()')).rows[0] || null;
    const couple = (await db.query('select my_couple() as id')).rows[0].id;
    const wallets = (await db.query('select * from wallets order by sort, name')).rows;
    const expenses = (await db.query('select * from expenses order by date, created_at')).rows;
    const shares = (await db.query('select * from expense_shares')).rows;
    const events = (await db.query('select expense_id, actor_id, action, revision, note, created_at from approval_events order by id')).rows;
    // Only repayments already made: shared expenses no longer create debts.
    const settlements = (await db.query("select * from settlements where status = 'paid' order by created_at")).rows;
    const budgets = (await db.query('select * from budgets order by created_at')).rows;
    const prefs = (await db.query('select data from prefs where user_id = app_uid()')).rows[0];
    const labels = (await db.query('select id, name, sort from labels order by sort, name')).rows;
    const links = (await db.query('select expense_id, label_id from expense_labels')).rows;
    const notes = (await db.query('select * from notes order by date nulls last, time nulls first, created_at')).rows;
    const line = (await db.query('select group_id, active from line_targets where user_id = app_uid()')).rows[0];
    const linePeople = (await db.query('select line_user_id, name, who from line_people order by sort, name')).rows;
    let invite = null;
    if (couple && !partner) {
      // The pending invite code is read with the owner role: invites are not exposed to app_user.
      invite = (await pool.query(
        'select code, expires_at from couple_invites where couple_id = $1 and used_by is null and expires_at > now() order by expires_at desc limit 1',
        [couple])).rows[0] || null;
    }
    const byExp = (rows) => rows.reduce((m, r) => ((m[r.expense_id] = m[r.expense_id] || []).push(r), m), {});
    const sh = byExp(shares), ev = byExp(events), lb = byExp(links);
    return {
      user: { id: me.id, email: me.email, name: me.display_name, nickname: me.nickname || undefined, avatar: me.avatar || undefined, googlePicture: googlePic || undefined },
      partner: partner && { id: partner.id, email: partner.email, name: partner.display_name, nickname: partner.nickname || undefined, avatar: partner.avatar || undefined },
      coupleId: couple,
      invite: invite && { code: invite.code, expiresAt: invite.expires_at },
      wallets: wallets.map((w) => ({ id: w.id, name: w.name, type: w.type, initial: w.initial, excluded: w.excluded, sort: w.sort, icon: w.icon || undefined })),
      expenses: expenses.map((e) => expenseOut(e, sh[e.id] || [], (ev[e.id] || []).map((x) => ({
        actorId: x.actor_id, action: x.action, revision: x.revision, note: x.note, at: x.created_at,
      })), (lb[e.id] || []).map((x) => x.label_id))),
      labels: labels.map((l) => ({ id: l.id, name: l.name, sort: l.sort })),
      settlements: settlements.map((s) => ({
        id: s.id, expenseId: s.expense_id, debtorId: s.debtor_id, creditorId: s.creditor_id, amount: s.amount,
        status: s.status, paidAt: s.paid_at, markedBy: s.marked_by, debtorWalletId: s.debtor_wallet_id,
        creditorWalletId: s.creditor_wallet_id,
      })),
      budgets: budgets.map((b) => ({
        id: b.id, ownerId: b.owner_id, scope: b.scope, category: b.category, amount: b.amount, walletId: b.wallet_id,
      })),
      prefs: prefs ? prefs.data : {},
      notes: notes.map(noteOut),
      line: line ? { groupId: line.group_id, active: line.active } : null,
      linePeople: linePeople.map((x) => ({ userId: x.line_user_id, name: x.name, who: x.who })),
      features: { line: lineEnabled, ai: aiEnabled && storageEnabled, storage: storageEnabled, model: aiEnabled ? RECEIPT_MODEL : null },
    };
  });
  res.json(out);
}));

/* ---------- Profile ---------- */

// Display name and picture, shown on every device and to the linked partner.
router.put('/profile', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) throw bad('bad_name');
  // Sent → required; left out → kept as it is.
  const nickname = req.body.nickname === undefined ? null : String(req.body.nickname || '').trim().slice(0, 20);
  if (nickname === '') throw bad('bad_nickname');
  const pic = req.body.avatar;
  const avatar = googlePhoto(pic) ? null : walletIcon(pic);
  // A photo URL is only accepted when it is this account's own Google photo.
  const r = await pool.query(
    `update users set display_name = $2, nickname = coalesce($5, nickname),
       avatar = case when $3::text is not null and $3 = google_picture then $3 else $4 end
     where id = $1 returning avatar, nickname`, [uid(req), name, googlePhoto(pic), avatar, nickname]);
  res.json({ ok: true, avatar: r.rows[0]?.avatar || null, nickname: r.rows[0]?.nickname || null });
}));

// Fetches the Google photo for an account that signed in before photos were kept,
// or signs in with email: the Google account must be this account's own.
router.post('/profile/google', rateLimit(20, 15 * 60000), wrap(async (req, res) => {
  if (!googleClientId()) throw bad('google_disabled', 503);
  const g = await verifyGoogleIdToken(req.body.credential);
  if (!g) throw bad('bad_google_token', 401);
  const u = (await pool.query('select email, google_sub from users where id = $1', [uid(req)])).rows[0];
  const sameEmail = (g.email_verified === true || g.email_verified === 'true') && String(g.email || '').toLowerCase() === u.email;
  if (u.google_sub ? u.google_sub !== g.sub : !sameEmail) throw bad('google_other_account', 409);
  const pic = googlePhoto(g.picture);
  if (!pic) throw bad('no_google_photo', 404);
  await pool.query('update users set google_picture = $2 where id = $1', [uid(req), pic]);
  res.json({ googlePicture: pic });
}));

/* ---------- Couple ---------- */

router.post('/couple/invite', wrap(async (req, res) => {
  const code = await asUser(uid(req), async (db) => (await db.query('select create_invite() as code')).rows[0].code);
  res.json({ code });
}));

router.post('/couple/join', rateLimit(20, 15 * 60000), wrap(async (req, res) => {
  await asUser(uid(req), (db) => db.query('select join_couple($1)', [String(req.body.code || '')]));
  res.json({ ok: true });
}));

/* ---------- Wallets ---------- */

router.put('/wallets/:id', wrap(async (req, res) => {
  const w = req.body;
  const id = str(req.params.id, 60);
  if (!id || !str(w.name)) throw bad('bad_wallet');
  await asUser(uid(req), (db) => db.query(
    `insert into wallets (owner_id, id, name, type, initial, excluded, sort, icon) values (app_uid(), $1, $2, $3, $4, $5, $6, $7)
     on conflict (owner_id, id) do update set name = excluded.name, type = excluded.type, initial = excluded.initial,
       excluded = excluded.excluded, sort = excluded.sort, icon = excluded.icon`,
    [id, str(w.name, 60), str(w.type, 20) || 'cash', money(w.initial || 0), !!w.excluded, Number(w.sort) || 0, walletIcon(w.icon)]));
  res.json({ ok: true });
}));

router.delete('/wallets/:id', wrap(async (req, res) => {
  await asUser(uid(req), async (db) => {
    await db.query('delete from expenses where owner_id = app_uid() and scope = $2 and (wallet_id = $1 or to_wallet_id = $1)', [req.params.id, 'personal']);
    await db.query('delete from wallets where id = $1', [req.params.id]);
  });
  res.json({ ok: true });
}));

/* ---------- Expenses ---------- */

function readExpense(body) {
  const type = ['expense', 'income', 'transfer'].includes(body.type) ? body.type : 'expense';
  const scope = body.scope === 'shared' && type === 'expense' ? 'shared' : 'personal';
  const amount = money(body.amount);
  if (!(amount > 0) || amount > 1e11) throw bad('bad_amount');
  if (!isDate(body.date)) throw bad('bad_date');
  return {
    type, scope, amount, date: body.date,
    merchant: str(body.merchant, 120), category: type === 'transfer' ? null : str(body.category, 40),
    note: str(body.note, 500), walletId: str(body.walletId, 60), toWalletId: type === 'transfer' ? str(body.toWalletId, 60) : null,
    reviewNeeded: !!body.reviewNeeded, receiptKey: str(body.receiptKey, 200), slipRef: str(body.slipRef, 80),
    billId: str(body.billId, 60), billYm: str(body.billYm, 7), payerId: body.payerId, shares: body.shares || {},
    labels: labelIds(body.labels), currency: /^[A-Z]{3}$/.test(body.currency || '') ? body.currency : 'THB',
  };
}

async function findDuplicate(db, x, selfId) {
  if (!x.slipRef && !x.receiptKey) return null;
  const r = await db.query(
    `select id from expenses where id is distinct from $1 and (
       ($2::text is not null and slip_ref = $2)
       or ($3::text is not null and amount = $4 and date = $5 and lower(coalesce(merchant, '')) = lower($3)))
     limit 1`, [selfId, x.slipRef, x.merchant, x.amount, x.date]);
  return r.rows[0] ? r.rows[0].id : null;
}

// Shared rows are records, not debts: the shares only say whose cost it is
// (the payer's alone, or half each) for each person's own totals.
async function writeShares(db, id, x, me) {
  const partner = (await db.query('select my_partner() as p')).rows[0].p;
  if (!partner) throw bad('no_partner', 409);
  if (![me, partner].includes(x.payerId)) throw bad('bad_payer');
  const mine = money(x.shares[me] ?? x.amount / 2);
  const theirs = money(x.amount - mine);
  if (mine < 0 || theirs < 0) throw bad('bad_shares');
  await db.query('delete from expense_shares where expense_id = $1', [id]);
  await db.query('insert into expense_shares (expense_id, user_id, amount) values ($1, $2, $3), ($1, $4, $5)',
    [id, me, mine, partner, theirs]);
}

router.post('/expenses', wrap(async (req, res) => {
  const x = readExpense(req.body);
  const id = isUuid(req.body.id) ? req.body.id : crypto.randomUUID();
  const me = uid(req);
  const out = await asUser(me, async (db) => {
    if (!req.body.force) {
      const dup = await findDuplicate(db, x, id);
      if (dup) return { duplicate: dup };
    }
    const shared = x.scope === 'shared';
    await db.query(
      `insert into expenses (id, owner_id, couple_id, scope, type, date, merchant, amount, category, note, wallet_id,
         to_wallet_id, payer_id, status, review_needed, receipt_key, slip_ref, bill_id, bill_ym, currency)
       values ($1, app_uid(), case when $2 = 'shared' then my_couple() end, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [id, x.scope, x.type, x.date, x.merchant, x.amount, x.category, x.note,
        shared && x.payerId !== me ? null : x.walletId, x.toWalletId, shared ? x.payerId : null,
        shared ? 'draft' : 'approved', x.reviewNeeded, x.receiptKey, x.slipRef, x.billId, x.billYm, x.currency]);
    if (shared) {
      await writeShares(db, id, x, me);
      await db.query('select submit_expense($1)', [id]);
    }
    if (x.labels) await writeLabels(db, id, x.labels);
    return { id };
  });
  if (out.duplicate) return res.status(409).json({ error: 'duplicate', id: out.duplicate });
  res.json(out);
}));

router.put('/expenses/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) throw bad('bad_id');
  const x = readExpense(req.body);
  const me = uid(req);
  const out = await asUser(me, async (db) => {
    const cur = (await db.query('select scope, status from expenses where id = $1 and owner_id = app_uid()', [id])).rows[0];
    if (!cur) throw bad('not_found', 404);
    if (!req.body.force) {
      const dup = await findDuplicate(db, x, id);
      if (dup) return { duplicate: dup };
    }
    const shared = x.scope === 'shared';
    const r = await db.query(
      `update expenses set scope = $2, couple_id = case when $2 = 'shared' then my_couple() end, type = $3, date = $4,
         merchant = $5, amount = $6, category = $7, note = $8, wallet_id = $9, to_wallet_id = $10, payer_id = $11,
         status = case when $2 = 'personal' then 'approved' when status = 'approved' then 'draft' else status end,
         review_needed = $12, receipt_key = $13, slip_ref = $14, bill_id = $15, bill_ym = $16, currency = $17, updated_at = now()
       where id = $1`,
      [id, x.scope, x.type, x.date, x.merchant, x.amount, x.category, x.note,
        shared && x.payerId !== me ? null : x.walletId, x.toWalletId, shared ? x.payerId : null,
        x.reviewNeeded, x.receiptKey, x.slipRef, x.billId, x.billYm, x.currency]);
    if (!r.rowCount) throw bad('locked', 409);
    if (shared) {
      await writeShares(db, id, x, me);
      await db.query('select submit_expense($1)', [id]);
    } else {
      await db.query('delete from expense_shares where expense_id = $1', [id]);
    }
    if (x.labels) await writeLabels(db, id, x.labels);
    return { id };
  });
  if (out.duplicate) return res.status(409).json({ error: 'duplicate', id: out.duplicate });
  res.json(out);
}));

router.delete('/expenses/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('bad_id');
  const r = await asUser(uid(req), (db) => db.query('delete from expenses where id = $1', [req.params.id]));
  if (!r.rowCount) throw bad('locked', 409);
  res.json({ ok: true });
}));

// Labels only: works on any expense I can see (a partner's shared row, an approved
// row) because the links are mine and the expense itself is not changed.
router.put('/expenses/:id/labels', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('bad_id');
  const ids = labelIds(req.body.labels) || [];
  await asUser(uid(req), async (db) => {
    if (!(await db.query('select 1 from expenses where id = $1', [req.params.id])).rowCount) throw bad('not_found', 404);
    await writeLabels(db, req.params.id, ids);
  });
  res.json({ ok: true });
}));

router.post('/expenses/:id/submit', wrap(async (req, res) => {
  await asUser(uid(req), (db) => db.query('select submit_expense($1)', [req.params.id]));
  res.json({ ok: true });
}));

router.post('/expenses/:id/respond', wrap(async (req, res) => {
  await asUser(uid(req), (db) => db.query('select respond_expense($1, $2, $3, $4)',
    [req.params.id, !!req.body.approve, str(req.body.reason, 300), str(req.body.walletId, 60)]));
  res.json({ ok: true });
}));

/* ---------- Labels ---------- */

router.put('/labels/:id', wrap(async (req, res) => {
  const id = str(req.params.id, 60);
  const name = str(String(req.body.name || '').trim(), 60);
  if (!id || !name) throw bad('bad_label');
  await asUser(uid(req), (db) => db.query(
    `insert into labels (owner_id, id, name, sort) values (app_uid(), $1, $2, $3)
     on conflict (owner_id, id) do update set name = excluded.name, sort = excluded.sort`,
    [id, name, Number(req.body.sort) || 0]));
  res.json({ ok: true });
}));

// Removing a label takes it off every transaction (expense_labels cascades).
router.delete('/labels/:id', wrap(async (req, res) => {
  await asUser(uid(req), (db) => db.query('delete from labels where id = $1', [req.params.id]));
  res.json({ ok: true });
}));

/* ---------- To-do notes ---------- */

// Minutes before the note's time (or 09:00 on a note without a time) to remind.
// 60, 180 and 4320 were the choices before 2026-10-29 and stay valid for older notes.
const REMINDS = new Set([0, 120, 360, 1440, 2880, 60, 180, 4320]);
const noteOut = (n) => ({
  id: n.id, ownerId: n.owner_id, shared: !!n.couple_id, text: n.text, date: n.date || '',
  time: n.time ? n.time.slice(0, 5) : '', remind: n.remind, remindAt: n.remind_at, notifiedAt: n.notified_at || undefined,
  done: n.done, doneAt: n.done_at || undefined, doneBy: n.done_by || undefined, createdAt: n.created_at,
});

// Creates or changes one note. Only the creator can share or unshare it; the partner
// can edit a shared note's text, date and reminder and tick it off. A new reminder
// time clears notified_at so it is sent again.
router.put('/notes/:id', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isUuid(req.params.id)) throw bad('bad_id');
  const text = str(String(b.text || '').trim(), 500);
  if (!text) throw bad('bad_text');
  const date = isDate(b.date) ? b.date : null;
  const time = date && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '') ? b.time : null;
  const remind = date && REMINDS.has(b.remind) ? b.remind : null;
  const at = remind != null && b.remindAt && !Number.isNaN(Date.parse(b.remindAt)) ? new Date(b.remindAt) : null;
  const note = await asUser(uid(req), (db) => db.query(
    `insert into notes (id, couple_id, text, date, time, remind, remind_at, done, done_at, done_by)
       values ($1, case when $2 then my_couple() end, $3, $4, $5, $6, $7, $8, case when $8 then now() end, case when $8 then app_uid() end)
     on conflict (id) do update set
       couple_id = case when notes.owner_id = app_uid() then excluded.couple_id else notes.couple_id end,
       text = excluded.text, date = excluded.date, time = excluded.time, remind = excluded.remind, remind_at = excluded.remind_at,
       notified_at = case when notes.remind_at is not distinct from excluded.remind_at then notes.notified_at end,
       done = excluded.done,
       done_at = case when excluded.done and not notes.done then now() when excluded.done then notes.done_at end,
       done_by = case when excluded.done and not notes.done then app_uid() when excluded.done then notes.done_by end,
       updated_at = now()
     returning *`,
    [req.params.id, !!b.shared, text, date, time, remind, at, !!b.done]));
  res.json({ note: noteOut(note.rows[0]) });
}));

router.delete('/notes/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('bad_id');
  await asUser(uid(req), (db) => db.query('delete from notes where id = $1', [req.params.id]));
  res.json({ ok: true });
}));

/* ---------- LINE group for reminders ---------- */

// LINE ids: C… for a group chat, R… for a multi-person room.
const LINE_TARGET = /^[CR][0-9a-f]{32}$/;

router.put('/line', wrap(async (req, res) => {
  const groupId = String((req.body || {}).groupId || '').trim();
  if (!groupId) {
    await asUser(uid(req), (db) => db.query('delete from line_targets where user_id = app_uid()'));
    return res.json({ line: null });
  }
  if (!LINE_TARGET.test(groupId)) throw bad('bad_group_id');
  const active = req.body.active !== false;
  await asUser(uid(req), (db) => db.query(
    `insert into line_targets (group_id, active) values ($1, $2)
     on conflict (user_id) do update set group_id = excluded.group_id, active = excluded.active, updated_at = now()`,
    [groupId, active]));
  res.json({ line: { groupId, active } });
}));

// Replaces the person's list of who is who in the LINE group.
router.put('/line/people', wrap(async (req, res) => {
  const list = Array.isArray(req.body?.people) ? req.body.people : null;
  if (!list || list.length > 30) throw bad('bad_people');
  const seen = new Set();
  const people = list.map((x, i) => {
    const userId = String(x?.userId || '').trim();
    const name = str(String(x?.name || '').trim(), 40);
    if (!/^U[0-9a-f]{32}$/.test(userId) || !name || seen.has(userId)) throw bad('bad_people');
    seen.add(userId);
    return { userId, name, who: ['me', 'partner'].includes(x.who) ? x.who : '', sort: i };
  });
  if (people.filter((x) => x.who === 'me').length > 1 || people.filter((x) => x.who === 'partner').length > 1) throw bad('bad_people');
  await asUser(uid(req), async (db) => {
    await db.query('delete from line_people');
    for (const x of people) {
      await db.query('insert into line_people (line_user_id, name, who, sort) values ($1, $2, $3, $4)', [x.userId, x.name, x.who, x.sort]);
    }
  });
  res.json({ people: people.map(({ userId, name, who }) => ({ userId, name, who })) });
}));

// Sends a test message to the saved group, so the person can see the OA is in it.
router.post('/line/test', rateLimit(10, 15 * 60000), wrap(async (req, res) => {
  if (!lineEnabled) throw bad('line_off', 503);
  const t = await asUser(uid(req), (db) => db.query('select group_id from line_targets where user_id = app_uid()'));
  if (!t.rows[0]) throw bad('no_group', 404);
  try {
    await linePush(t.rows[0].group_id, '✅ Centel เชื่อมกับกลุ่มนี้แล้ว การเตือนจากโน้ตสิ่งที่ต้องทำจะส่งมาที่นี่');
  } catch (e) {
    console.error('line test', e.message, e.detail || '');
    throw bad('line_failed', 502);
  }
  res.json({ ok: true });
}));

/* ---------- Settlements ---------- */

router.post('/settlements/:id', wrap(async (req, res) => {
  await asUser(uid(req), (db) => (req.body.walletOnly
    ? db.query('select set_settlement_wallet($1, $2)', [req.params.id, str(req.body.walletId, 60)])
    : db.query('select mark_settlement($1, $2, $3)', [req.params.id, !!req.body.paid, str(req.body.walletId, 60)])));
  res.json({ ok: true });
}));

/* ---------- Budgets ---------- */

router.put('/budgets/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('bad_id');
  const b = req.body;
  const scope = b.scope === 'shared' ? 'shared' : 'personal';
  const amount = money(b.amount);
  if (!(amount > 0)) throw bad('bad_amount');
  await asUser(uid(req), async (db) => {
    const r = await db.query(
      `update budgets set scope = $2, couple_id = case when $2 = 'shared' then my_couple() end, category = $3, amount = $4, wallet_id = $5
       where id = $1`, [req.params.id, scope, str(b.category, 40) || 'all', amount, str(b.walletId, 60) || 'total']);
    if (!r.rowCount) {
      await db.query(
        `insert into budgets (id, owner_id, scope, couple_id, category, amount, wallet_id)
         values ($1, app_uid(), $2, case when $2 = 'shared' then my_couple() end, $3, $4, $5)`,
        [req.params.id, scope, str(b.category, 40) || 'all', amount, str(b.walletId, 60) || 'total']);
    }
  });
  res.json({ ok: true });
}));

router.delete('/budgets/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('bad_id');
  await asUser(uid(req), (db) => db.query('delete from budgets where id = $1', [req.params.id]));
  res.json({ ok: true });
}));

/* ---------- Calendar subscription (owner side) ---------- */

const CAL_MAX = 1024 * 1024;
const calOut = (row) => (row ? { token: row.token, updatedAt: row.updated_at } : { token: null });

router.get('/calendar', wrap(async (req, res) => {
  const row = await asUser(uid(req), async (db) =>
    (await db.query('select token, updated_at from calendar_feeds where user_id = app_uid()')).rows[0]);
  res.json(calOut(row));
}));

// Turn the feed on, or give it a new URL (the old one stops working at once).
router.post('/calendar/token', rateLimit(30, 60 * 60000), wrap(async (req, res) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const row = await asUser(uid(req), async (db) => (await db.query(
    `insert into calendar_feeds (user_id, token) values (app_uid(), $1)
     on conflict (user_id) do update set token = excluded.token, updated_at = now()
     returning token, updated_at`, [token])).rows[0]);
  res.json(calOut(row));
}));

// The app sends the whole calendar (built from this device's bills) whenever they change.
router.put('/calendar', wrap(async (req, res) => {
  const ics = req.body && req.body.ics;
  if (typeof ics !== 'string' || !ics.startsWith('BEGIN:VCALENDAR') || !/END:VCALENDAR\s*$/.test(ics)) throw bad('bad_calendar');
  if (Buffer.byteLength(ics) > CAL_MAX) throw bad('too_large', 413);
  const row = await asUser(uid(req), async (db) => (await db.query(
    `update calendar_feeds set ics = $1, updated_at = now() where user_id = app_uid() returning token, updated_at`,
    [ics])).rows[0]);
  if (!row) throw bad('not_found', 404);
  res.json(calOut(row));
}));

router.delete('/calendar', wrap(async (req, res) => {
  await asUser(uid(req), (db) => db.query('delete from calendar_feeds where user_id = app_uid()'));
  res.json({ ok: true });
}));

/* ---------- Prefs ---------- */

router.put('/prefs', wrap(async (req, res) => {
  const data = req.body && typeof req.body.data === 'object' ? req.body.data : {};
  await asUser(uid(req), (db) => db.query(
    'insert into prefs (user_id, data) values (app_uid(), $1) on conflict (user_id) do update set data = excluded.data',
    [JSON.stringify(data).length < 100000 ? data : {}]));
  res.json({ ok: true });
}));

/* ---------- Import local data on first sign-in ---------- */

router.post('/import', wrap(async (req, res) => {
  const { wallets = [], txns = [], budgets = [], labels = [] } = req.body || {};
  if (wallets.length > 200 || txns.length > 20000 || budgets.length > 200 || labels.length > 500) throw bad('too_large', 413);
  const n = await asUser(uid(req), async (db) => {
    for (const [i, w] of wallets.entries()) {
      if (!str(w.id, 60) || !str(w.name)) continue;
      await db.query(
        `insert into wallets (owner_id, id, name, type, initial, excluded, sort, icon) values (app_uid(), $1, $2, $3, $4, $5, $6, $7)
         on conflict (owner_id, id) do nothing`,
        [str(w.id, 60), str(w.name, 60), str(w.type, 20) || 'cash', money(w.initial || 0), !!w.excluded, i, walletIcon(w.icon)]);
    }
    for (const [i, l] of labels.entries()) {
      if (!str(l.id, 60) || !str(l.name, 60)) continue;
      await db.query(
        'insert into labels (owner_id, id, name, sort) values (app_uid(), $1, $2, $3) on conflict (owner_id, id) do nothing',
        [str(l.id, 60), str(String(l.name).trim(), 60), i]);
    }
    let count = 0;
    for (const t of txns) {
      let x;
      try { x = readExpense({ ...t, scope: 'personal' }); } catch { continue; }
      const r = await db.query(
        `insert into expenses (owner_id, scope, type, date, merchant, amount, category, note, wallet_id, to_wallet_id, status, bill_id, bill_ym)
         values (app_uid(), 'personal', $1, $2, $3, $4, $5, $6, $7, $8, 'approved', $9, $10) returning id`,
        [x.type, x.date, x.merchant, x.amount, x.category, x.note, x.walletId, x.toWalletId, x.billId, x.billYm]);
      if (x.labels && x.labels.length) await writeLabels(db, r.rows[0].id, x.labels);
      count++;
    }
    for (const b of budgets) {
      const amount = money(b.amount);
      if (!(amount > 0)) continue;
      await db.query(
        `insert into budgets (owner_id, scope, category, amount, wallet_id) values (app_uid(), 'personal', $1, $2, $3)`,
        [str(b.category, 40) || 'all', amount, str(b.walletId, 60) || 'total']);
    }
    return count;
  });
  res.json({ imported: n });
}));

/* ---------- Receipts ---------- */

router.post('/receipts', rateLimit(60, 60 * 60000), wrap(async (req, res) => {
  const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(req.body.mediaType) ? req.body.mediaType : null;
  const data = typeof req.body.image === 'string' ? req.body.image : '';
  if (!mediaType || !data) throw bad('bad_image');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 6 * 1024 * 1024) throw bad('too_large', 413);
  const key = `${uid(req)}/${crypto.randomUUID()}.${mediaType.split('/')[1]}`;
  await putReceipt(key, buf, mediaType);
  // The person's label names, so the AI can suggest ones that fit this slip.
  const labelNames = Array.isArray(req.body.labels)
    ? [...new Set(req.body.labels.map((x) => str(String(x).trim(), 60)).filter(Boolean))].slice(0, 50) : [];
  // The person's own expense categories ({ id, name, parent }), so the AI picks from their list.
  const categories = Array.isArray(req.body.categories)
    ? req.body.categories.slice(0, 300).map((c) => c && {
      id: str(c.id, 40), name: str(String(c.name || '').trim(), 40), parent: str(String(c.parent || '').trim(), 40) || undefined,
    }).filter((c, i, all) => c && /^[A-Za-z0-9_-]+$/.test(c.id || '') && c.name && all.findIndex((x) => x && x.id === c.id) === i) : [];
  let analysis;
  try {
    analysis = await analyzeReceipt(data, mediaType, labelNames, categories);
  } catch (e) {
    console.error('receipt analysis failed', e.status || '', e.message);
    analysis = { status: 'failed', result: null };
  }
  await asUser(uid(req), (db) => db.query(
    'insert into receipt_analysis (user_id, receipt_key, model, result, status) values (app_uid(), $1, $2, $3, $4)',
    [key, analysis.model || null, analysis.result ? JSON.stringify(analysis.result) : null, analysis.status]));
  res.json({ key, status: analysis.status, result: analysis.result });
}));

router.get('/receipts/url', wrap(async (req, res) => {
  const key = String(req.query.key || '');
  const ok = key.startsWith(`${uid(req)}/`) || await asUser(uid(req), async (db) =>
    (await db.query('select 1 from expenses where receipt_key = $1 limit 1', [key])).rowCount > 0);
  if (!ok) throw bad('not_found', 404);
  res.json({ url: await receiptUrl(key) });
}));

export default router;
