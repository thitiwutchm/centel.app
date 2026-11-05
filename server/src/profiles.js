// Profiles: more than one fully separate set of data under one sign-in. A profile is a
// users row with parent_id set to the main account (see migrations/028_profiles.sql), so
// everything the app already does per user is per profile, with nothing shared between them.
import express from 'express';
import { pool } from './db.js';
import { createSession, readCookie, sha } from './auth.js';

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
export const MAX_PROFILES = 5; // extra profiles next to the main one
// Profile picture: a short emoji (photos are set afterwards from the profile sheet).
const emoji = (v) => (typeof v === 'string' && v && v.length <= 16 && !/[<>&"']/.test(v) ? v : null);

// The main account of whoever is signed in (themselves when they are the main profile).
async function rootOf(userId) {
  const r = await pool.query('select coalesce(parent_id, id) as root from users where id = $1', [userId]);
  return r.rows[0]?.root || null;
}

// Every profile of the account, main first, then in the order they were added.
export async function familyOf(userId) {
  const root = await rootOf(userId);
  if (!root) return [];
  const r = await pool.query(
    `select id, display_name, nickname, avatar, parent_id from users
     where id = $1 or parent_id = $1 order by parent_id nulls first, created_at, id`, [root]);
  return r.rows.map((u) => ({
    id: u.id, name: u.display_name, nickname: u.nickname || undefined, avatar: u.avatar || undefined,
    main: !u.parent_id, current: u.id === userId,
  }));
}

router.get('/', wrap(async (req, res) => {
  res.json({ profiles: await familyOf(req.user.id), max: MAX_PROFILES });
}));

// Adds an empty profile. The app switches to it afterwards.
router.post('/', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) throw bad('bad_name');
  const nickname = String(req.body.nickname || '').trim().slice(0, 20) || name.slice(0, 20);
  const root = await rootOf(req.user.id);
  const client = await pool.connect();
  try {
    await client.query('begin');
    // One at a time per account, so two taps cannot both pass the limit.
    await client.query('select id from users where id = $1 for update', [root]);
    const n = (await client.query('select count(*)::int as n from users where parent_id = $1', [root])).rows[0].n;
    if (n >= MAX_PROFILES) throw bad('too_many_profiles', 409);
    const r = await client.query(
      'insert into users (parent_id, display_name, nickname, avatar) values ($1, $2, $3, $4) returning id',
      [root, name, nickname, emoji(req.body.avatar)]);
    await client.query('commit');
    res.json({ id: r.rows[0].id });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// Moves this device to another profile of the same account: the old session ends and
// a new one starts for the chosen profile.
router.post('/switch', wrap(async (req, res) => {
  const id = req.body.id;
  if (!isUuid(id)) throw bad('not_found', 404);
  const target = (await familyOf(req.user.id)).find((p) => p.id === id);
  if (!target) throw bad('not_found', 404);
  if (target.current) return res.json({ ok: true, id });
  // The new cookie replaces the old one; the old session is ended on the server.
  const token = readCookie(req);
  if (token) await pool.query('delete from sessions where token_hash = $1', [sha(token)]);
  await createSession(res, id);
  res.json({ ok: true, id });
}));

// Deletes a profile and everything in it. Not the main profile, and not the one in use.
router.delete('/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const target = isUuid(id) && (await familyOf(req.user.id)).find((p) => p.id === id);
  if (!target) throw bad('not_found', 404);
  if (target.main) throw bad('main_profile', 409);
  if (target.current) throw bad('current_profile', 409);
  try {
    await pool.query('delete from users where id = $1 and parent_id is not null', [id]);
  } catch (e) {
    // Shared expenses with a partner still point at this profile.
    if (e.code === '23503') throw bad('profile_linked', 409);
    throw e;
  }
  res.json({ ok: true });
}));

export default router;
