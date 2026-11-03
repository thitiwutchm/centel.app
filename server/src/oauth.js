import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { loadUser, readCookie, sha, rateLimit } from './auth.js';
import { googleClientId } from './google.js';

/* OAuth 2.1 for AI apps (Claude, ChatGPT) that connect to the Centel MCP server (mcp.js).

   1. The app finds us through /.well-known/oauth-protected-resource and
      /.well-known/oauth-authorization-server, and registers itself (POST /api/oauth/register).
   2. It opens /api/oauth/authorize in the person's browser. Signed in to centel.app (the
      session cookie), they see a consent page and tap อนุญาต; signed out, they sign in on
      the same page first.
   3. The app swaps the code for tokens at /api/oauth/token (PKCE S256 required). The
      access token reads that one account, read-only, until the person removes the app in
      Account › เชื่อมกับ AI.

   PUBLIC_URL is the address people and apps use (https://centel.app); web's Caddy sends
   /mcp, /.well-known/oauth-* and /api/* here. */

export const BASE = () => (process.env.PUBLIC_URL || 'https://centel.app').replace(/\/+$/, '');
export const MCP_PATH = '/mcp';
const ACCESS_SEC = 3600;
const REFRESH_DAYS = 60;
const CODE_SEC = 600;
// Read everything the app shows; manage notes and to-dos (with reminders); manage budgets
// and income / expense records (with confirmation for deletes and money changes).
export const SCOPES = ['centel.read', 'centel.notes', 'centel.money'];
const SCOPE = SCOPES.join(' ');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const one = (v) => (Array.isArray(v) ? v[0] : v);
const field = (v, max = 2000) => (typeof one(v) === 'string' ? one(v).slice(0, max) : '');

function cors(_req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'www-authenticate, mcp-session-id');
  next();
}
export { cors };

/* ---------- Discovery ---------- */

export const wellKnown = express.Router();
wellKnown.use(cors);

function resourceMeta() {
  return {
    resource: BASE() + MCP_PATH,
    authorization_servers: [BASE()],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Centel',
    resource_documentation: BASE() + '/',
  };
}
function serverMeta() {
  const b = BASE();
  return {
    issuer: b,
    authorization_endpoint: `${b}/api/oauth/authorize`,
    token_endpoint: `${b}/api/oauth/token`,
    registration_endpoint: `${b}/api/oauth/register`,
    revocation_endpoint: `${b}/api/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: b + '/',
  };
}
// Clients look for these at the root and with the resource / issuer path appended.
wellKnown.get(['/oauth-protected-resource', '/oauth-protected-resource/*rest'], (_req, res) => res.json(resourceMeta()));
wellKnown.get(['/oauth-authorization-server', '/oauth-authorization-server/*rest', '/openid-configuration', '/openid-configuration/*rest'],
  (_req, res) => res.json(serverMeta()));

/* ---------- Errors ---------- */

const oauthErr = (res, status, error, description) => res.status(status).json({ error, ...(description ? { error_description: description } : {}) });

function redirectWith(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  res.redirect(302, u.toString());
}

/* ---------- Registration (RFC 7591) ---------- */

export const oauthRouter = express.Router();
oauthRouter.use(cors);
oauthRouter.use(express.urlencoded({ extended: false, limit: '64kb' }));
oauthRouter.options('/{*any}', (_req, res) => res.sendStatus(204));

// https only, except loopback addresses for desktop apps and the MCP Inspector.
function okRedirect(u) {
  if (typeof u !== 'string' || u.length > 500) return false;
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  } catch (e) { return false; }
}

oauthRouter.post('/register', rateLimit(30, 60 * 60000), wrap(async (req, res) => {
  const b = req.body || {};
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) return oauthErr(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https URLs');
  const method = b.token_endpoint_auth_method || 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return oauthErr(res, 400, 'invalid_client_metadata', 'unsupported token_endpoint_auth_method');
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ['authorization_code', 'refresh_token'];
  if (grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) return oauthErr(res, 400, 'invalid_client_metadata', 'unsupported grant_types');
  const name = String(b.client_name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || hostOf(uris[0]);
  const id = `c_${rand(18)}`;
  const secret = method === 'none' ? null : rand(32);
  await pool.query('insert into oauth_clients (id, secret_hash, name, redirect_uris) values ($1, $2, $3, $4)',
    [id, secret && sha(secret), name, uris]);
  res.status(201).json({
    client_id: id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    scope: SCOPE,
  });
}));

function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return 'AI app'; } }

/* ---------- Consent page ---------- */

async function clientById(id) {
  if (typeof id !== 'string' || !id) return null;
  return (await pool.query('select * from oauth_clients where id = $1', [id])).rows[0] || null;
}

// The request's own parameters, checked. Returns { error } for problems that must not be
// sent back to an unchecked redirect_uri, or { redirectError } for ones that can be.
async function checkAuthorize(q) {
  const client = await clientById(field(q.client_id, 100));
  if (!client) return { error: 'ไม่รู้จักแอปนี้ (client_id) ลองเชื่อมต่อใหม่จากแอป AI อีกครั้ง' };
  let redirectUri = field(q.redirect_uri, 500);
  if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
  if (!client.redirect_uris.includes(redirectUri)) return { error: 'ที่อยู่สำหรับส่งกลับ (redirect_uri) ไม่ตรงกับที่แอปลงทะเบียนไว้' };
  const state = field(q.state, 1000);
  const base = { client, redirectUri, state };
  if (field(q.response_type) !== 'code') return { ...base, redirectError: 'unsupported_response_type' };
  const challenge = field(q.code_challenge, 200);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || field(q.code_challenge_method) !== 'S256') {
    return { ...base, redirectError: 'invalid_request', description: 'PKCE S256 code_challenge required' };
  }
  return { ...base, challenge };
}

// Ties the consent form to this browser's session: a page on another site can neither
// read it nor (SameSite=Lax) send the cookie with its own POST.
const consentToken = (req) => sha(`consent:${readCookie(req) || ''}`).slice(0, 32);

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#14161a;--muted:#6b7280;--line:#e5e7eb;--accent:#ff7a1a}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--card:#171a1f;--ink:#f2f4f7;--muted:#9aa3ae;--line:#2a2f37}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;padding:16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 24px}
.logo{width:56px;height:56px;border-radius:14px;display:block;margin:0 auto 12px}
h1{font-size:20px;margin:0 0 6px;text-align:center}p{margin:6px 0;color:var(--muted);text-align:center}
ul{margin:16px 0;padding-left:20px}li{margin:4px 0}.who{text-align:center;font-weight:600;color:var(--ink)}
.row{display:flex;gap:10px;margin-top:20px}button,.btn{flex:1;border:0;border-radius:12px;padding:13px;font:inherit;font-weight:600;cursor:pointer}
.ok{background:var(--accent);color:#fff}.no{background:var(--line);color:var(--ink)}
input{width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;margin-top:8px}
.gbox{display:flex;justify-content:center;margin:16px 0 4px}.or{margin:14px 0 4px;font-size:13px}.err{color:#d9534f;text-align:center;min-height:1.5em}
small{display:block;text-align:center;color:var(--muted);margin-top:14px}`;

function page(res, title, body, status = 200) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  }).send(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main class="card">
<img class="logo" src="/icons/centel-192.png" alt="">${body}</main></body></html>`);
}

function signInPage(res, clientName) {
  const gid = googleClientId();
  page(res, 'เข้าสู่ระบบ Centel', `
<h1>เข้าสู่ระบบ Centel</h1>
<p><b>${esc(clientName)}</b> ขอเชื่อมกับบัญชี Centel ของคุณ เข้าสู่ระบบก่อนนะครับ</p>
${gid ? '<div class="gbox" id="g"></div><p class="or">หรือใช้อีเมล</p>' : ''}
<form id="f"><input name="email" type="email" autocomplete="email" placeholder="อีเมล" required>
<input name="password" type="password" autocomplete="current-password" placeholder="รหัสผ่าน" required>
<div class="row"><button class="ok" type="submit">เข้าสู่ระบบ</button></div></form>
<p class="err" id="e"></p>
<script>
const post=(p,b)=>fetch('/api'+p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-centel':'1'},body:JSON.stringify(b)});
const done=async(r)=>{if(r.ok)location.reload();else document.getElementById('e').textContent=(await r.json().catch(()=>({}))).error==='bad_credentials'?'อีเมลหรือรหัสผ่านไม่ถูกต้อง':'เข้าสู่ระบบไม่สำเร็จ ลองอีกครั้ง';};
document.getElementById('f').onsubmit=async(ev)=>{ev.preventDefault();const d=new FormData(ev.target);done(await post('/auth/login',{email:d.get('email'),password:d.get('password')}));};
${gid ? `window.onGsi=()=>{google.accounts.id.initialize({client_id:${JSON.stringify(gid)},callback:async(r)=>done(await post('/auth/google',{credential:r.credential})),ux_mode:'popup'});
google.accounts.id.renderButton(document.getElementById('g'),{theme:'outline',size:'large',shape:'pill',text:'signin_with',locale:'th'});};` : ''}
</script>${gid ? '<script src="https://accounts.google.com/gsi/client?hl=th" async onload="onGsi()"></script>' : ''}`);
}

oauthRouter.get('/authorize', loadUser, wrap(async (req, res) => {
  const c = await checkAuthorize(req.query);
  if (c.error) return page(res, 'เชื่อมต่อไม่ได้', `<h1>เชื่อมต่อไม่ได้</h1><p>${esc(c.error)}</p>`, 400);
  if (c.redirectError) return redirectWith(res, c.redirectUri, { error: c.redirectError, error_description: c.description, state: c.state, iss: BASE() });
  if (!req.user) return signInPage(res, c.client.name);
  const hidden = { client_id: c.client.id, redirect_uri: c.redirectUri, state: c.state, code_challenge: c.challenge,
    code_challenge_method: 'S256', response_type: 'code', csrf: consentToken(req) };
  page(res, `อนุญาต ${c.client.name}`, `
<h1>อนุญาตให้ ${esc(c.client.name)} ใช้ Centel?</h1>
<p class="who">${esc(req.user.display_name)} · ${esc(req.user.email)}</p>
<ul>
<li>อ่านรายรับรายจ่าย หมวดหมู่ ป้าย และกระเป๋าเงิน</li>
<li>อ่านงบประมาณ บิลที่ต้องจ่าย และสิ่งที่ต้องทำ</li>
<li>เห็นรายการร่วมกับคู่ของคุณ เหมือนที่คุณเห็นในแอป</li>
<li><b>จดโน้ต เพิ่มและแก้ไขสิ่งที่ต้องทำ</b> พร้อมตั้งเตือนความจำได้</li>
<li><b>สร้างและแก้ไขงบประมาณ บันทึกและแก้ไขรายรับรายจ่าย</b></li>
<li>การลบ และการเปลี่ยนยอดเงิน AI ต้องถามคุณก่อนทุกครั้ง · ดูและย้อนกลับสิ่งที่ AI เปลี่ยนได้ในแอป</li>
<li>โอนเงินจริง แก้กระเป๋าเงิน หรือแก้บิล <b>ไม่ได้</b></li>
</ul>
<form method="post" action="/api/oauth/authorize">
${Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}
<div class="row"><button class="no" name="decision" value="deny">ไม่อนุญาต</button><button class="ok" name="decision" value="allow">อนุญาต</button></div>
</form>
<small>ยกเลิกได้ทุกเมื่อที่ บัญชี › เชื่อมกับ AI ในแอป Centel<br>ส่งกลับไปที่ ${esc(hostOf(c.redirectUri))}</small>`);
}));

oauthRouter.post('/authorize', loadUser, wrap(async (req, res) => {
  const c = await checkAuthorize(req.body || {});
  if (c.error) return page(res, 'เชื่อมต่อไม่ได้', `<h1>เชื่อมต่อไม่ได้</h1><p>${esc(c.error)}</p>`, 400);
  if (c.redirectError) return redirectWith(res, c.redirectUri, { error: c.redirectError, state: c.state, iss: BASE() });
  if (!req.user) return page(res, 'หมดเวลา', '<h1>หมดเวลาเข้าสู่ระบบ</h1><p>กลับไปที่แอป AI แล้วกดเชื่อมต่ออีกครั้ง</p>', 401);
  const a = Buffer.from(field(req.body.csrf, 64));
  const b = Buffer.from(consentToken(req));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return page(res, 'หมดเวลา', '<h1>หน้านี้หมดอายุ</h1><p>กลับไปที่แอป AI แล้วกดเชื่อมต่ออีกครั้ง</p>', 403);
  if (field(req.body.decision) !== 'allow') {
    return redirectWith(res, c.redirectUri, { error: 'access_denied', state: c.state, iss: BASE() });
  }
  // Connecting the same app again keeps one entry in the Account list.
  // Approving again also brings an older grant up to today's consent page (its scope).
  const grant = (await pool.query(
    'update oauth_grants set scope = $3 where user_id = $1 and client_id = $2 and revoked_at is null returning id', [req.user.id, c.client.id, SCOPE])).rows[0]
    || (await pool.query('insert into oauth_grants (user_id, client_id, scope) values ($1, $2, $3) returning id', [req.user.id, c.client.id, SCOPE])).rows[0];
  const code = rand(32);
  await pool.query(
    'insert into oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) values ($1, $2, $3, $4, $5)',
    [sha(code), grant.id, c.redirectUri, c.challenge, new Date(Date.now() + CODE_SEC * 1000)]);
  redirectWith(res, c.redirectUri, { code, state: c.state, iss: BASE() });
}));

/* ---------- Tokens ---------- */

// client_id (+ secret for confidential clients) from the body or HTTP Basic.
async function tokenClient(req) {
  let id = field(req.body?.client_id, 100);
  let secret = field(req.body?.client_secret, 200);
  const h = req.get('authorization') || '';
  if (/^basic /i.test(h)) {
    const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    id = decodeURIComponent(u || ''); secret = decodeURIComponent(p || '');
  }
  const client = await clientById(id);
  if (!client) return null;
  if (client.secret_hash) {
    const a = Buffer.from(sha(secret || '')), b = Buffer.from(client.secret_hash);
    if (!crypto.timingSafeEqual(a, b)) return null;
  }
  return client;
}

async function issue(grantId) {
  const scope = (await pool.query('select scope from oauth_grants where id = $1', [grantId])).rows[0]?.scope || 'centel.read';
  const access = rand(32), refresh = rand(32);
  await pool.query(
    `insert into oauth_tokens (token_hash, grant_id, kind, expires_at) values ($1, $3, 'access', $4), ($2, $3, 'refresh', $5)`,
    [sha(access), sha(refresh), grantId, new Date(Date.now() + ACCESS_SEC * 1000), new Date(Date.now() + REFRESH_DAYS * 86400000)]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SEC, refresh_token: refresh, scope };
}

oauthRouter.post('/token', rateLimit(120, 15 * 60000), wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const client = await tokenClient(req);
  if (!client) return oauthErr(res, 401, 'invalid_client');
  const type = field(req.body?.grant_type);
  pool.query("delete from oauth_tokens where expires_at < now() - interval '1 day'").catch(() => {});
  pool.query('delete from oauth_codes where expires_at < now()').catch(() => {});

  if (type === 'authorization_code') {
    const code = field(req.body.code, 200);
    // Used once: deleted as it is read.
    const row = (await pool.query(
      `delete from oauth_codes c using oauth_grants g where c.code_hash = $1 and g.id = c.grant_id
       returning c.*, g.client_id, g.revoked_at`, [sha(code)])).rows[0];
    if (!row || row.client_id !== client.id || row.revoked_at || new Date(row.expires_at) < new Date()) return oauthErr(res, 400, 'invalid_grant');
    const redirectUri = field(req.body.redirect_uri, 500);
    if (redirectUri && redirectUri !== row.redirect_uri) return oauthErr(res, 400, 'invalid_grant', 'redirect_uri mismatch');
    const verifier = field(req.body.code_verifier, 200);
    const want = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || want !== row.code_challenge) return oauthErr(res, 400, 'invalid_grant', 'PKCE check failed');
    return res.json(await issue(row.grant_id));
  }

  if (type === 'refresh_token') {
    const token = field(req.body.refresh_token, 200);
    // Refresh tokens rotate: the old one stops working once it is used.
    const row = (await pool.query(
      `delete from oauth_tokens t using oauth_grants g where t.token_hash = $1 and t.kind = 'refresh' and g.id = t.grant_id
       returning t.expires_at, g.id as grant_id, g.client_id, g.revoked_at`, [sha(token)])).rows[0];
    if (!row || row.client_id !== client.id || row.revoked_at || new Date(row.expires_at) < new Date()) return oauthErr(res, 400, 'invalid_grant');
    return res.json(await issue(row.grant_id));
  }

  oauthErr(res, 400, 'unsupported_grant_type');
}));

oauthRouter.post('/revoke', wrap(async (req, res) => {
  const token = field(req.body?.token, 200);
  if (token) await pool.query('delete from oauth_tokens where token_hash = $1', [sha(token)]);
  res.sendStatus(200);
}));

/* ---------- Bearer check for /mcp ---------- */

// Sets req.mcpUser = { id, grantId, scopes } or answers 401 with where to find the auth server.
export async function bearer(req, res, next) {
  try {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(req.get('authorization') || '');
    const row = m && (await pool.query(
      `select g.id as grant_id, g.user_id, g.last_used_at, g.scope, c.name as client from oauth_tokens t
       join oauth_grants g on g.id = t.grant_id join oauth_clients c on c.id = g.client_id
       where t.token_hash = $1 and t.kind = 'access' and t.expires_at > now() and g.revoked_at is null`, [sha(m[1])])).rows[0];
    if (!row) {
      res.set('WWW-Authenticate',
        `Bearer realm="centel", resource_metadata="${BASE()}/.well-known/oauth-protected-resource"${m ? ', error="invalid_token"' : ''}`);
      return res.status(401).json({ error: m ? 'invalid_token' : 'unauthenticated' });
    }
    if (!row.last_used_at || Date.now() - new Date(row.last_used_at) > 5 * 60000) {
      pool.query('update oauth_grants set last_used_at = now() where id = $1', [row.grant_id]).catch(() => {});
    }
    req.mcpUser = { id: row.user_id, grantId: row.grant_id, client: row.client, scopes: new Set(String(row.scope || '').split(' ')) };
    next();
  } catch (e) {
    next(e);
  }
}
