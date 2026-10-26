import crypto from 'node:crypto';
import express from 'express';
import { pool, asUser } from './db.js';
import { hashPassword, verifyPassword, createSession, destroySession, requireUser, rateLimit } from './auth.js';
import { analyzeReceipt, aiEnabled, RECEIPT_MODEL } from './receipts.js';
import { putReceipt, receiptUrl, storageEnabled } from './storage.js';
import { verifyGoogleIdToken, googleClientId } from './google.js';

const router = express.Router();
// Compared against when an email is unknown, so login takes the same time either way.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const str = (v, max = 200) => (v == null || v === '' ? null : String(v).slice(0, max));
const money = (v) => Math.round(Number(v) * 100) / 100;

/* ---------- Auth ---------- */

router.post('/auth/register', rateLimit(10, 15 * 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('bad_email');
  if (password.length < 8) throw bad('weak_password');
  if (!name) throw bad('bad_name');
  const hash = await hashPassword(password);
  const r = await pool.query(
    'insert into users (email, password_hash, display_name) values ($1, $2, $3) on conflict (email) do nothing returning id',
    [email, hash, name]);
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

/* ---------- Everything below needs a session ---------- */

router.use(requireUser);

const uid = (req) => req.user.id;

function expenseOut(e, shares, events) {
  return {
    id: e.id, ownerId: e.owner_id, coupleId: e.couple_id, scope: e.scope, type: e.type, date: e.date,
    merchant: e.merchant, amount: e.amount, category: e.category, note: e.note, walletId: e.wallet_id,
    toWalletId: e.to_wallet_id, payerId: e.payer_id, payerWalletId: e.payer_wallet_id, status: e.status,
    reviewNeeded: e.review_needed, receiptKey: e.receipt_key, slipRef: e.slip_ref, billId: e.bill_id, billYm: e.bill_ym,
    revision: e.revision, approvedBy: e.approved_by, approvedAt: e.approved_at, rejectedBy: e.rejected_by,
    rejectedAt: e.rejected_at, rejectReason: e.reject_reason, createdAt: e.created_at,
    shares: shares ? Object.fromEntries(shares.map((s) => [s.user_id, s.amount])) : undefined,
    events: events || undefined,
  };
}

router.get('/bootstrap', wrap(async (req, res) => {
  const out = await asUser(uid(req), async (db) => {
    const me = (await db.query('select id, email, display_name from users where id = app_uid()')).rows[0];
    const partner = (await db.query('select id, email, display_name from users where id = my_partner()')).rows[0] || null;
    const couple = (await db.query('select my_couple() as id')).rows[0].id;
    const wallets = (await db.query('select * from wallets order by sort, name')).rows;
    const expenses = (await db.query('select * from expenses order by date, created_at')).rows;
    const shares = (await db.query('select * from expense_shares')).rows;
    const events = (await db.query('select expense_id, actor_id, action, revision, note, created_at from approval_events order by id')).rows;
    const settlements = (await db.query('select * from settlements order by created_at')).rows;
    const budgets = (await db.query('select * from budgets order by created_at')).rows;
    const prefs = (await db.query('select data from prefs where user_id = app_uid()')).rows[0];
    let invite = null;
    if (couple && !partner) {
      // The pending invite code is read with the owner role: invites are not exposed to app_user.
      invite = (await pool.query(
        'select code, expires_at from couple_invites where couple_id = $1 and used_by is null and expires_at > now() order by expires_at desc limit 1',
        [couple])).rows[0] || null;
    }
    const byExp = (rows) => rows.reduce((m, r) => ((m[r.expense_id] = m[r.expense_id] || []).push(r), m), {});
    const sh = byExp(shares), ev = byExp(events);
    return {
      user: { id: me.id, email: me.email, name: me.display_name },
      partner: partner && { id: partner.id, email: partner.email, name: partner.display_name },
      coupleId: couple,
      invite: invite && { code: invite.code, expiresAt: invite.expires_at },
      wallets: wallets.map((w) => ({ id: w.id, name: w.name, type: w.type, initial: w.initial, excluded: w.excluded, sort: w.sort })),
      expenses: expenses.map((e) => expenseOut(e, sh[e.id] || [], (ev[e.id] || []).map((x) => ({
        actorId: x.actor_id, action: x.action, revision: x.revision, note: x.note, at: x.created_at,
      })))),
      settlements: settlements.map((s) => ({
        id: s.id, expenseId: s.expense_id, debtorId: s.debtor_id, creditorId: s.creditor_id, amount: s.amount,
        status: s.status, paidAt: s.paid_at, markedBy: s.marked_by, debtorWalletId: s.debtor_wallet_id,
        creditorWalletId: s.creditor_wallet_id,
      })),
      budgets: budgets.map((b) => ({
        id: b.id, ownerId: b.owner_id, scope: b.scope, category: b.category, amount: b.amount, walletId: b.wallet_id,
      })),
      prefs: prefs ? prefs.data : {},
      features: { ai: aiEnabled && storageEnabled, storage: storageEnabled, model: aiEnabled ? RECEIPT_MODEL : null },
    };
  });
  res.json(out);
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
    `insert into wallets (owner_id, id, name, type, initial, excluded, sort) values (app_uid(), $1, $2, $3, $4, $5, $6)
     on conflict (owner_id, id) do update set name = excluded.name, type = excluded.type, initial = excluded.initial,
       excluded = excluded.excluded, sort = excluded.sort`,
    [id, str(w.name, 60), str(w.type, 20) || 'cash', money(w.initial || 0), !!w.excluded, Number(w.sort) || 0]));
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
         to_wallet_id, payer_id, status, review_needed, receipt_key, slip_ref, bill_id, bill_ym)
       values ($1, app_uid(), case when $2 = 'shared' then my_couple() end, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [id, x.scope, x.type, x.date, x.merchant, x.amount, x.category, x.note,
        shared && x.payerId !== me ? null : x.walletId, x.toWalletId, shared ? x.payerId : null,
        shared ? 'draft' : 'approved', x.reviewNeeded, x.receiptKey, x.slipRef, x.billId, x.billYm]);
    if (shared) {
      await writeShares(db, id, x, me);
      if (req.body.submit) await db.query('select submit_expense($1)', [id]);
    }
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
    if (cur.scope !== x.scope && cur.status !== 'draft' && cur.scope === 'shared') throw bad('locked', 409);
    if (!req.body.force) {
      const dup = await findDuplicate(db, x, id);
      if (dup) return { duplicate: dup };
    }
    const shared = x.scope === 'shared';
    const r = await db.query(
      `update expenses set scope = $2, couple_id = case when $2 = 'shared' then my_couple() end, type = $3, date = $4,
         merchant = $5, amount = $6, category = $7, note = $8, wallet_id = $9, to_wallet_id = $10, payer_id = $11,
         status = case when $2 = 'personal' then 'approved' when status = 'approved' then 'draft' else status end,
         review_needed = $12, receipt_key = $13, slip_ref = $14, bill_id = $15, bill_ym = $16, updated_at = now()
       where id = $1`,
      [id, x.scope, x.type, x.date, x.merchant, x.amount, x.category, x.note,
        shared && x.payerId !== me ? null : x.walletId, x.toWalletId, shared ? x.payerId : null,
        x.reviewNeeded, x.receiptKey, x.slipRef, x.billId, x.billYm]);
    if (!r.rowCount) throw bad('locked', 409);
    if (shared) {
      await writeShares(db, id, x, me);
      if (req.body.submit) await db.query('select submit_expense($1)', [id]);
    } else {
      await db.query('delete from expense_shares where expense_id = $1', [id]);
    }
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

router.post('/expenses/:id/submit', wrap(async (req, res) => {
  await asUser(uid(req), (db) => db.query('select submit_expense($1)', [req.params.id]));
  res.json({ ok: true });
}));

router.post('/expenses/:id/respond', wrap(async (req, res) => {
  await asUser(uid(req), (db) => db.query('select respond_expense($1, $2, $3, $4)',
    [req.params.id, !!req.body.approve, str(req.body.reason, 300), str(req.body.walletId, 60)]));
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

/* ---------- Prefs ---------- */

router.put('/prefs', wrap(async (req, res) => {
  const data = req.body && typeof req.body.data === 'object' ? req.body.data : {};
  await asUser(uid(req), (db) => db.query(
    'insert into prefs (user_id, data) values (app_uid(), $1) on conflict (user_id) do update set data = excluded.data',
    [JSON.stringify(data).length < 10000 ? data : {}]));
  res.json({ ok: true });
}));

/* ---------- Import local data on first sign-in ---------- */

router.post('/import', wrap(async (req, res) => {
  const { wallets = [], txns = [], budgets = [] } = req.body || {};
  if (wallets.length > 200 || txns.length > 20000 || budgets.length > 200) throw bad('too_large', 413);
  const n = await asUser(uid(req), async (db) => {
    for (const [i, w] of wallets.entries()) {
      if (!str(w.id, 60) || !str(w.name)) continue;
      await db.query(
        `insert into wallets (owner_id, id, name, type, initial, excluded, sort) values (app_uid(), $1, $2, $3, $4, $5, $6)
         on conflict (owner_id, id) do nothing`,
        [str(w.id, 60), str(w.name, 60), str(w.type, 20) || 'cash', money(w.initial || 0), !!w.excluded, i]);
    }
    let count = 0;
    for (const t of txns) {
      let x;
      try { x = readExpense({ ...t, scope: 'personal' }); } catch { continue; }
      await db.query(
        `insert into expenses (owner_id, scope, type, date, merchant, amount, category, note, wallet_id, to_wallet_id, status, bill_id, bill_ym)
         values (app_uid(), 'personal', $1, $2, $3, $4, $5, $6, $7, $8, 'approved', $9, $10)`,
        [x.type, x.date, x.merchant, x.amount, x.category, x.note, x.walletId, x.toWalletId, x.billId, x.billYm]);
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
  let analysis;
  try {
    analysis = await analyzeReceipt(data, mediaType);
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
