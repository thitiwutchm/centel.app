import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 90;
export const COOKIE = 'sid';

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await pool.query('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)', [sha(token), userId, expires]);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api',
    expires,
  });
}

export async function destroySession(req, res) {
  const token = readCookie(req);
  if (token) await pool.query('delete from sessions where token_hash = $1', [sha(token)]);
  res.clearCookie(COOKIE, { path: '/api' });
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function loadUser(req, _res, next) {
  try {
    const token = readCookie(req);
    if (token) {
      const r = await pool.query(
        `select u.id, u.email, u.display_name from sessions s join users u on u.id = s.user_id
         where s.token_hash = $1 and s.expires_at > now()`, [sha(token)]);
      req.user = r.rows[0] || null;
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

// Mutating requests must carry a header a cross-site form or image cannot set.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-centel') !== '1') return res.status(403).json({ error: 'csrf' });
  next();
}

// Small in-memory limiter for login/register attempts per IP.
const hits = new Map();
export function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const h = hits.get(key) || { n: 0, t: now };
    if (now - h.t > windowMs) { h.n = 0; h.t = now; }
    h.n += 1;
    hits.set(key, h);
    if (h.n > max) return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}
