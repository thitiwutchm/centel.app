// Partner location (แชร์ตำแหน่งกับคู่): each person can share where they are with their
// partner, and both see the temperature there. Only the latest place is kept
// (migrations/035_partner_location.sql). Places arrive two ways:
//   - the page, when the app is opened (POST /api/location, cookie)
//   - the iOS app in the background, on iOS significant location changes (about every
//     500 m), with its own token (POST /api/location/ping, Authorization: Bearer)
// The place name comes from the phone (Apple's geocoder or the page's lookup), so the
// server never sends coordinates anywhere except Open-Meteo for the weather.
import crypto from 'node:crypto';
import express from 'express';
import { pool, asUser } from './db.js';
import { requireUser, rateLimit } from './auth.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const WX_TTL = 30 * 60000; // weather is fetched again after 30 minutes
const WX_MOVE_KM = 3; // …or once the person is this far from where it was fetched
const TIMEOUT = 6000;
const WX_ORIGIN = process.env.OPEN_METEO_URL || 'https://api.open-meteo.com'; // a stand-in in tests

/* ---------- Input ---------- */

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

// { lat, lon, acc, place } from the page or the app, or null when it isn't a real place.
export function readPlace(b) {
  if (!b || typeof b !== 'object') return null;
  const lat = num(b.lat), lon = num(b.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  const a = num(b.acc);
  const place = typeof b.place === 'string' ? b.place.replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return {
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    acc: Number.isFinite(a) && a >= 0 ? Math.min(Math.round(a), 100000) : null,
    place: place || null,
  };
}

export function km(aLat, aLon, bLat, bLon) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ---------- Weather (Open-Meteo, free, no key) ---------- */

// Open-Meteo's `current` block → { temp, feels, code, day }, or null.
export function parseWeather(j) {
  const c = j && j.current;
  if (!c || typeof c.temperature_2m !== 'number' || !Number.isFinite(c.temperature_2m)) return null;
  return {
    temp: Math.round(c.temperature_2m * 10) / 10,
    feels: typeof c.apparent_temperature === 'number' ? Math.round(c.apparent_temperature * 10) / 10 : null,
    code: Number.isInteger(c.weather_code) ? c.weather_code : null,
    day: c.is_day === undefined ? null : !!c.is_day,
  };
}

export async function fetchWeather(lat, lon, fetchImpl = fetch) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,apparent_temperature,weather_code,is_day&timezone=auto`;
    const r = await fetchImpl(`${WX_ORIGIN}/v1/forecast?${q}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    return r.ok ? parseWeather(await r.json()) : null;
  } catch (e) {
    return null;
  } finally { clearTimeout(t); }
}

// Whether a row's weather is missing, older than WX_TTL, or for a place far from where they are now.
export function wxStale(row, now = Date.now()) {
  if (!row || row.lat == null) return false;
  if (!row.wx_at || now - new Date(row.wx_at).getTime() > WX_TTL) return true;
  return row.wx_lat == null || km(row.lat, row.lon, row.wx_lat, row.wx_lon) > WX_MOVE_KM;
}

const inflight = new Map();
let fetchWx = fetchWeather;
export function setWeatherFetch(f) { fetchWx = f || fetchWeather; } // tests

// Refreshes one row's weather when it's stale; returns the row as it is afterwards.
async function withWeather(row) {
  if (!row || !row.sharing || !wxStale(row)) return row;
  const { lat, lon } = row;
  let p = inflight.get(row.user_id);
  if (!p) {
    p = fetchWx(lat, lon).finally(() => inflight.delete(row.user_id));
    inflight.set(row.user_id, p);
  }
  const wx = await p;
  if (!wx) return row;
  const r = await pool.query(
    `update user_locations set temp = $2, feels = $3, wcode = $4, is_day = $5, wx_lat = $6, wx_lon = $7, wx_at = now()
     where user_id = $1 and sharing returning *`, [row.user_id, wx.temp, wx.feels, wx.code, wx.day, lat, lon]);
  return r.rows[0] || row;
}

/* ---------- Rows ---------- */

const getRow = async (id) => (await pool.query('select * from user_locations where user_id = $1', [id])).rows[0] || null;

// What the app sees of one person's row. `self` adds whether this device's app has a token.
function view(row, self = false) {
  const out = { sharing: !!(row && row.sharing) };
  if (self) out.app = !!(row && row.token_hash);
  if (!out.sharing || row.lat == null) return out;
  Object.assign(out, {
    lat: row.lat, lon: row.lon, acc: row.acc ?? undefined, place: row.place || undefined,
    src: row.src || undefined, at: row.at,
  });
  if (row.temp != null) out.wx = { temp: row.temp, feels: row.feels ?? undefined, code: row.wcode ?? undefined, day: row.is_day ?? undefined, at: row.wx_at };
  return out;
}

async function savePlace(userId, p, src) {
  const r = await pool.query(
    `update user_locations set lat = $2, lon = $3, acc = $4, place = coalesce($5, case when lat is not null and abs(lat - $2) < 0.005 and abs(lon - $3) < 0.005 then place end),
       src = $6, at = now(), updated_at = now()
     where user_id = $1 and sharing returning *`, [userId, p.lat, p.lon, p.acc, p.place, src]);
  return r.rows[0] || null;
}

const partnerOf = (userId) => asUser(userId, async (db) => (await db.query('select my_partner() as p')).rows[0].p);

/* ---------- Routes for the page (cookie) ---------- */

const router = express.Router();
router.use(requireUser);

// { me, partner } — partner is null with no partner, { sharing: false } when they don't share.
router.get('/', wrap(async (req, res) => {
  const pid = await partnerOf(req.user.id);
  const [me, them] = await Promise.all([getRow(req.user.id), pid ? getRow(pid) : null]);
  const [me2, them2] = await Promise.all([withWeather(me), withWeather(them)]);
  res.json({ me: view(me2, true), partner: pid ? view(them2) : null });
}));

// Turns my sharing on or off. Off forgets the place, the weather and the app's token.
router.put('/sharing', wrap(async (req, res) => {
  const on = req.body.on === true;
  const r = on
    ? await pool.query(
      `insert into user_locations (user_id, sharing) values ($1, true)
       on conflict (user_id) do update set sharing = true, updated_at = now() returning *`, [req.user.id])
    : await pool.query(
      `update user_locations set sharing = false, token_hash = null, lat = null, lon = null, acc = null, place = null,
         src = null, at = null, temp = null, feels = null, wcode = null, is_day = null, wx_lat = null, wx_lon = null, wx_at = null,
         updated_at = now()
       where user_id = $1 returning *`, [req.user.id]);
  res.json({ me: view(r.rows[0] || null, true) });
}));

// The page's own update, when the app is opened.
router.post('/', rateLimit(120, 60 * 60000), wrap(async (req, res) => {
  const p = readPlace(req.body);
  if (!p) throw bad('bad_place');
  const row = await savePlace(req.user.id, p, 'app');
  if (!row) throw bad('not_sharing', 409);
  res.json({ me: view(await withWeather(row), true) });
}));

// A new key for the iOS app's background updates (the old one stops working).
router.post('/token', rateLimit(30, 60 * 60000), wrap(async (req, res) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const r = await pool.query('update user_locations set token_hash = $2 where user_id = $1 and sharing returning user_id', [req.user.id, sha(token)]);
  if (!r.rows[0]) throw bad('not_sharing', 409);
  res.json({ token });
}));

export default router;

/* ---------- The iOS app in the background (Bearer token, no cookie) ---------- */

export const pingRouter = express.Router();
pingRouter.post('/', rateLimit(600, 60 * 60000), wrap(async (req, res) => {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.get('authorization') || '');
  const row = m ? (await pool.query('select * from user_locations where token_hash = $1', [sha(m[1])])).rows[0] : null;
  // Gone: sharing was turned off (here or on another device). The app stops on this answer.
  if (!row || !row.sharing) return res.status(410).json({ error: 'stopped' });
  const p = readPlace(req.body);
  if (!p) throw bad('bad_place');
  await savePlace(row.user_id, p, 'bg');
  res.json({ ok: true });
}));
