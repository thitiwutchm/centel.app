// Balance sharing (แชร์เงินคงเหลือให้คู่): each person can let their partner see how much
// money they have left, and optionally each wallet's balance. The page works out its own
// totals and sends a snapshot whenever they change (POST /api/balance); only the latest one
// is kept (migrations/036_balance_share.sql). Turning sharing off deletes the snapshot.
import express from 'express';
import { pool, asUser } from './db.js';
import { requireUser, rateLimit } from './auth.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });

const MAX = 1e12;
const money = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) < MAX ? Math.round(n * 100) / 100 : null;
};
const clean = (s, n) => (typeof s === 'string' ? s.replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n) : '');

// { total, wallets: [{ name, emoji, balance }] } from the page, or null when the total isn't a number.
export function readSnapshot(b) {
  if (!b || typeof b !== 'object') return null;
  const total = money(b.total);
  if (total === null) return null;
  const wallets = (Array.isArray(b.wallets) ? b.wallets : []).slice(0, 30).map((w) => ({
    name: clean(w && w.name, 40), emoji: clean(w && w.emoji, 8) || undefined, balance: money(w && w.balance),
  })).filter((w) => w.name && w.balance !== null);
  return { total, wallets };
}

const getRow = async (id) => (await pool.query('select * from user_balance_share where user_id = $1', [id])).rows[0] || null;
const partnerOf = (userId) => asUser(userId, async (db) => (await db.query('select my_partner() as p')).rows[0].p);

// What the app sees of one person's row.
function view(row) {
  const out = { sharing: !!(row && row.sharing), perWallet: !!(row && row.per_wallet) };
  if (!out.sharing || row.total == null) return out;
  out.total = Number(row.total);
  out.at = row.at;
  if (out.perWallet && Array.isArray(row.wallets)) out.wallets = row.wallets;
  return out;
}

const router = express.Router();
router.use(requireUser);

// { me, partner } — partner is null with no partner, { sharing: false } when they don't share.
router.get('/', wrap(async (req, res) => {
  const pid = await partnerOf(req.user.id);
  const [me, them] = await Promise.all([getRow(req.user.id), pid ? getRow(pid) : null]);
  res.json({ me: view(me), partner: pid ? view(them) : null });
}));

// My switches: { on, perWallet }. Off forgets the snapshot.
router.put('/sharing', wrap(async (req, res) => {
  const on = req.body.on === true;
  const per = req.body.perWallet === true;
  const r = on
    ? await pool.query(
      `insert into user_balance_share (user_id, sharing, per_wallet) values ($1, true, $2)
       on conflict (user_id) do update set sharing = true, per_wallet = $2,
         wallets = case when $2 then user_balance_share.wallets end, updated_at = now() returning *`, [req.user.id, per])
    : await pool.query(
      `update user_balance_share set sharing = false, per_wallet = false, total = null, wallets = null, at = null, updated_at = now()
       where user_id = $1 returning *`, [req.user.id]);
  res.json({ me: view(r.rows[0] || null) });
}));

// The page's latest totals. Wallets are kept only when I show each wallet.
router.post('/', rateLimit(240, 60 * 60000), wrap(async (req, res) => {
  const s = readSnapshot(req.body);
  if (!s) throw bad('bad_balance');
  const r = await pool.query(
    `update user_balance_share set total = $2, wallets = case when per_wallet then $3::jsonb end, at = now(), updated_at = now()
     where user_id = $1 and sharing returning *`, [req.user.id, s.total, JSON.stringify(s.wallets)]);
  if (!r.rows[0]) throw bad('not_sharing', 409);
  res.json({ me: view(r.rows[0]) });
}));

export default router;
