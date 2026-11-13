// Users of a business in account.centel.app: positions (roles), per-area access, email invites
// and each person's own profile + signature. Tables in migrations/039_acc_users.sql.
//
// Access is four areas, each 0 none / 1 view / 2 edit:
//   sales      ใบเสนอราคา ใบแจ้งหนี้ ใบเสร็จ (QT IV RE), the sales report and receivables
//   purchase   ค่าใช้จ่าย (EX), bill scanning and payables
//   accounting สมุดรายวัน ผังบัญชี and every report
//   settings   business details, document settings, integrations
// Managing users is for owners only. Contacts and items follow sales or purchase.
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { sha } from '../auth.js';

export const AREAS = ['sales', 'purchase', 'accounting', 'settings'];

// Position → default access. Order is the order in the invite picker.
export const ROLES = {
  owner: { name: 'เจ้าของกิจการ', perms: { sales: 2, purchase: 2, accounting: 2, settings: 2 } },
  firm: { name: 'สำนักงานบัญชี', perms: { sales: 2, purchase: 2, accounting: 2, settings: 1 } },
  accountant: { name: 'นักบัญชี และ ธุรการ', perms: { sales: 2, purchase: 2, accounting: 2, settings: 0 } },
  sales_manager: { name: 'ผู้จัดการฝ่ายขาย', perms: { sales: 2, purchase: 0, accounting: 1, settings: 0 } },
  sales_lead: { name: 'หัวหน้าฝ่ายขาย', perms: { sales: 2, purchase: 0, accounting: 0, settings: 0 } },
  sales: { name: 'พนักงานขาย', perms: { sales: 2, purchase: 0, accounting: 0, settings: 0 } },
  trader: { name: 'เจ้าหน้าที่ฝ่ายซื้อ-ขาย', perms: { sales: 2, purchase: 2, accounting: 0, settings: 0 } },
  hr_manager: { name: 'ผู้จัดการฝ่ายบุคคล', perms: { sales: 0, purchase: 2, accounting: 1, settings: 0 } },
  cashier: { name: 'พนักงานแคชเชียร์', perms: { sales: 2, purchase: 0, accounting: 0, settings: 0 } },
  hr: { name: 'พนักงานฝ่ายบุคคล', perms: { sales: 0, purchase: 1, accounting: 0, settings: 0 } },
  // Older roles from the first version; not offered for new invites.
  editor: { name: 'ผู้แก้ไข', perms: { sales: 2, purchase: 2, accounting: 2, settings: 2 }, legacy: true },
  viewer: { name: 'ผู้ดูอย่างเดียว', perms: { sales: 1, purchase: 1, accounting: 1, settings: 1 }, legacy: true },
};

const lvl = (v) => (v === 2 || v === '2' ? 2 : v === 1 || v === '1' ? 1 : 0);

// The access a member really has: the role's defaults, overridden by what the owner set.
export function permsOf(role, custom) {
  if (role === 'owner') return { ...ROLES.owner.perms };
  const base = ROLES[role]?.perms || ROLES.viewer.perms;
  const out = {};
  for (const a of AREAS) out[a] = custom && custom[a] !== undefined ? lvl(custom[a]) : base[a];
  return out;
}

// Only what differs from the role is stored, so changing a role's defaults later reaches everyone.
function cleanPerms(role, raw) {
  if (!raw || typeof raw !== 'object' || role === 'owner') return null;
  const base = ROLES[role].perms;
  const out = {};
  for (const a of AREAS) if (raw[a] !== undefined && lvl(raw[a]) !== base[a]) out[a] = lvl(raw[a]);
  return Object.keys(out).length ? out : null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const cleanEmail = (v) => { const e = String(v ?? '').trim().toLowerCase(); return EMAIL.test(e) ? e : null; };
const str = (v, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const SIG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const newToken = () => crypto.randomBytes(24).toString('base64url');
const appBase = () => (process.env.ACC_URL || 'https://account.centel.app').replace(/\/$/, '');
const inviteLink = (token) => `${appBase()}/#/invite/${token}`;
const fullName = (p, fallback) => [p?.first_name, p?.last_name].filter(Boolean).join(' ') || fallback || '';

export async function profileOf(userId) {
  return (await pool.query('select first_name, last_name, phone, signature from acc_profiles where user_id = $1', [userId])).rows[0] || null;
}

// Signature of whoever created a document, for the issuer's line (null when they have none).
export async function issuerOf(userId) {
  if (!userId) return null;
  const r = (await pool.query(
    `select u.display_name, p.first_name, p.last_name, p.signature from users u left join acc_profiles p on p.user_id = u.id where u.id = $1`, [userId])).rows[0];
  return r ? { name: fullName(r, r.display_name), signature: r.signature || null } : null;
}

// Wire the routes. `router` is /api/acc after sign-in, `biz` is /api/acc/b/:biz (req.biz loaded).
export function mountUsers(router, biz, { wrap, rateLimit }) {
  const ownerOnly = (req) => { if (req.biz.role !== 'owner') throw bad('forbidden', 403); };

  /* ----- My profile ----- */

  router.get('/me', wrap(async (req, res) => {
    const p = await profileOf(req.user.id);
    res.json({ profile: { email: req.user.email, display_name: req.user.display_name, first_name: p?.first_name || null, last_name: p?.last_name || null, phone: p?.phone || null, signature: p?.signature || null } });
  }));

  router.put('/me', wrap(async (req, res) => {
    const b = req.body || {};
    const sig = b.signature === null || b.signature === '' ? null
      : (typeof b.signature === 'string' && b.signature.length < 400000 && SIG.test(b.signature) ? b.signature : undefined);
    if (b.signature !== undefined && sig === undefined) throw bad('bad_image');
    const cur = await profileOf(req.user.id);
    const row = {
      first_name: b.first_name !== undefined ? str(b.first_name, 100) : cur?.first_name ?? null,
      last_name: b.last_name !== undefined ? str(b.last_name, 100) : cur?.last_name ?? null,
      phone: b.phone !== undefined ? str(b.phone, 40) : cur?.phone ?? null,
      signature: b.signature !== undefined ? sig : cur?.signature ?? null,
    };
    await pool.query(
      `insert into acc_profiles (user_id, first_name, last_name, phone, signature) values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set first_name = $2, last_name = $3, phone = $4, signature = $5, updated_at = now()`,
      [req.user.id, row.first_name, row.last_name, row.phone, row.signature]);
    res.json({ ok: true });
  }));

  /* ----- Invitations sent to me ----- */

  router.get('/invites', wrap(async (req, res) => {
    const email = cleanEmail(req.user.email);
    if (!email) return res.json({ invites: [] });
    const rows = (await pool.query(
      `select i.id, i.role, b.name as business, b.logo, coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), u.display_name) as invited_by
       from acc_invites i join acc_businesses b on b.id = i.business_id
       left join users u on u.id = i.invited_by left join acc_profiles p on p.user_id = i.invited_by
       where i.email = $1 and i.expires_at > now()
         and not exists (select 1 from acc_members m where m.business_id = i.business_id and m.user_id = $2)
       order by i.created_at`, [email, req.user.id])).rows;
    res.json({ invites: rows.map((r) => ({ ...r, role_name: ROLES[r.role]?.name || r.role })) });
  }));

  // Accept by id (an invite to my email) or by the token in the emailed link.
  router.post('/invites/accept', rateLimit(30, 60 * 60000), wrap(async (req, res) => {
    const email = cleanEmail(req.user.email);
    const token = typeof req.body?.token === 'string' ? req.body.token : null;
    const id = isUuid(req.body?.id) ? req.body.id : null;
    if (!token && !id) throw bad('not_found', 404);
    const inv = (await pool.query(
      `select * from acc_invites where ${token ? 'token_hash = $1' : 'id = $1'}`, [token ? sha(token) : id])).rows[0];
    if (!inv || inv.expires_at < new Date()) throw bad('invite_gone', 404);
    // The link only works for the email it was sent to, so a forwarded link cannot be used by someone else.
    if (inv.email !== email) throw bad('invite_other_email', 403);
    const db = await pool.connect();
    try {
      await db.query('begin');
      await db.query(
        `insert into acc_members (business_id, user_id, role, perms, invited_by) values ($1, $2, $3, $4, $5)
         on conflict (business_id, user_id) do update set disabled = false`,
        [inv.business_id, req.user.id, inv.role, inv.perms, inv.invited_by]);
      await db.query('delete from acc_invites where id = $1', [inv.id]);
      await db.query('commit');
    } catch (e) {
      await db.query('rollback').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
    res.json({ business_id: inv.business_id });
  }));

  router.post('/invites/:id/decline', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw bad('not_found', 404);
    await pool.query('delete from acc_invites where id = $1 and email = $2', [req.params.id, cleanEmail(req.user.email)]);
    res.json({ ok: true });
  }));

  /* ----- Users of this business ----- */

  biz.get('/members', wrap(async (req, res) => {
    const B = req.biz.id;
    const members = (await pool.query(
      `select m.user_id, m.role, m.perms, m.disabled, m.created_at, coalesce(u.email, pu.email) as email, u.display_name,
              p.first_name, p.last_name, p.phone, p.signature is not null as has_signature
       from acc_members m join users u on u.id = m.user_id left join users pu on pu.id = u.parent_id
       left join acc_profiles p on p.user_id = m.user_id
       where m.business_id = $1 order by m.created_at`, [B])).rows.map((m) => ({
      user_id: m.user_id, email: m.email, name: fullName(m, m.display_name), phone: m.phone, role: m.role,
      role_name: ROLES[m.role]?.name || m.role, perms: permsOf(m.role, m.perms), custom: !!m.perms, disabled: m.disabled,
      primary: m.user_id === req.biz.created_by, me: m.user_id === req.user.id, has_signature: m.has_signature, joined: m.created_at,
    }));
    const isOwner = req.biz.role === 'owner';
    const invites = isOwner ? (await pool.query(
      'select id, email, role, perms, created_at, expires_at from acc_invites where business_id = $1 order by created_at', [B])).rows
      .map((i) => ({ ...i, role_name: ROLES[i.role]?.name || i.role, perms: permsOf(i.role, i.perms), expired: i.expires_at < new Date() })) : [];
    res.json({
      members, invites, can_manage: isOwner,
      roles: Object.entries(ROLES).filter(([, r]) => !r.legacy).map(([k, r]) => ({ key: k, name: r.name, perms: r.perms })),
    });
  }));

  biz.post('/members/invite', rateLimit(60, 60 * 60000), wrap(async (req, res) => {
    ownerOnly(req);
    const email = cleanEmail(req.body?.email);
    if (!email) throw bad('bad_email');
    const role = ROLES[req.body?.role] && !ROLES[req.body.role].legacy ? req.body.role : null;
    if (!role) throw bad('bad_role');
    const B = req.biz.id;
    const already = (await pool.query(
      `select 1 from acc_members m join users u on u.id = m.user_id left join users pu on pu.id = u.parent_id
       where m.business_id = $1 and lower(coalesce(u.email, pu.email)) = $2`, [B, email])).rowCount;
    if (already) throw bad('already_member', 409);
    const count = (await pool.query('select (select count(*) from acc_members where business_id = $1) + (select count(*) from acc_invites where business_id = $1) as n', [B])).rows[0].n;
    if (Number(count) >= 50) throw bad('too_many_users', 409);
    const token = newToken();
    const row = (await pool.query(
      `insert into acc_invites (business_id, email, role, perms, token_hash, invited_by) values ($1, $2, $3, $4, $5, $6)
       on conflict (business_id, email) do update set role = $3, perms = $4, token_hash = $5, invited_by = $6, created_at = now(), expires_at = now() + interval '14 days'
       returning id`, [B, email, role, cleanPerms(role, req.body?.perms), sha(token), req.user.id])).rows[0];
    res.json({ id: row.id, link: inviteLink(token) });
  }));

  // A fresh link for a pending invite (the old one stops working); only the hash is kept.
  biz.post('/invites/:id/link', wrap(async (req, res) => {
    ownerOnly(req);
    if (!isUuid(req.params.id)) throw bad('not_found', 404);
    const token = newToken();
    const r = await pool.query(
      `update acc_invites set token_hash = $3, expires_at = now() + interval '14 days' where id = $1 and business_id = $2`,
      [req.params.id, req.biz.id, sha(token)]);
    if (!r.rowCount) throw bad('not_found', 404);
    res.json({ link: inviteLink(token) });
  }));

  biz.delete('/invites/:id', wrap(async (req, res) => {
    ownerOnly(req);
    if (!isUuid(req.params.id)) throw bad('not_found', 404);
    await pool.query('delete from acc_invites where id = $1 and business_id = $2', [req.params.id, req.biz.id]);
    res.json({ ok: true });
  }));

  biz.put('/members/:uid', wrap(async (req, res) => {
    ownerOnly(req);
    const uid = req.params.uid;
    if (!isUuid(uid)) throw bad('not_found', 404);
    if (uid === req.biz.created_by) throw bad('primary_owner', 409);
    const cur = (await pool.query('select role from acc_members where business_id = $1 and user_id = $2', [req.biz.id, uid])).rows[0];
    if (!cur) throw bad('not_found', 404);
    const role = req.body?.role !== undefined ? (ROLES[req.body.role] && !ROLES[req.body.role].legacy ? req.body.role : null) : cur.role;
    if (!role) throw bad('bad_role');
    if (uid === req.user.id && role !== 'owner') throw bad('self_demote', 409);
    const sets = ['role = $3', 'perms = $4'];
    const p = [req.biz.id, uid, role, cleanPerms(role, req.body?.perms)];
    if (typeof req.body?.disabled === 'boolean') {
      if (uid === req.user.id) throw bad('self_disable', 409);
      p.push(req.body.disabled); sets.push(`disabled = $${p.length}`);
    }
    await pool.query(`update acc_members set ${sets.join(', ')} where business_id = $1 and user_id = $2`, p);
    res.json({ ok: true });
  }));

  // An owner removes someone, or anyone leaves a business (except its primary owner).
  biz.delete('/members/:uid', wrap(async (req, res) => {
    const uid = req.params.uid;
    if (!isUuid(uid)) throw bad('not_found', 404);
    if (uid !== req.user.id) ownerOnly(req);
    if (uid === req.biz.created_by) throw bad('primary_owner', 409);
    await pool.query('delete from acc_members where business_id = $1 and user_id = $2', [req.biz.id, uid]);
    res.json({ ok: true });
  }));
}

// Public: what an invite link is for, so the sign-in page can say who invited whom.
export async function inviteInfo(token) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const r = (await pool.query(
    `select i.email, i.role, i.expires_at, b.name as business, b.logo
     from acc_invites i join acc_businesses b on b.id = i.business_id where i.token_hash = $1`, [sha(token)])).rows[0];
  if (!r || r.expires_at < new Date()) return null;
  return { email: r.email, role_name: ROLES[r.role]?.name || r.role, business: r.business, logo: r.logo };
}

/* ---------- Access guard ---------- */

const DOC_AREA = { QT: 'sales', IV: 'sales', RE: 'sales', EX: 'purchase' };
// Which document types a member may open: their own areas, or all of them with accounting.
export function docTypesFor(perms) {
  return Object.keys(DOC_AREA).filter((t) => perms.accounting >= 1 || perms[DOC_AREA[t]] >= 1);
}
// The dashboard shows bank balances and the whole business, so it goes with accounting.
const REPORT_AREAS = { sales: ['sales'], ar: ['sales'], ap: ['purchase'] };

// Runs for every /b/:biz request once req.biz (with role and perms) is loaded. Throws 403 when
// the member's position does not reach that page. New endpoints fall under the default rule:
// anyone may read, writing needs edit access to settings.
export async function guard(req) {
  const p = req.biz.perms;
  const write = req.method !== 'GET';
  const need = write ? 2 : 1;
  const any = (...areas) => areas.some((a) => p[a] >= need);
  const deny = () => { throw bad('forbidden', 403); };
  const [top, id, sub] = req.path.split('/').filter(Boolean);
  switch (top) {
    case undefined: if (req.method === 'PUT' && !any('settings')) deny(); return;
    case 'members': case 'invites': return; // the handlers check ownership
    case 'accounts': case 'journal': if (!any('accounting')) deny(); return;
    case 'contacts': case 'items': if (write && !any('sales', 'purchase')) deny(); return;
    case 'stock': return;
    case 'scan': if (!any('purchase')) deny(); return;
    case 'attachment': if (!any('purchase', 'accounting')) deny(); return;
    case 'integrations': if (!any('settings')) deny(); return;
    case 'reports': {
      if (!(REPORT_AREAS[id] || []).concat('accounting').some((a) => p[a] >= 1)) deny();
      return;
    }
    case 'docs': {
      req.docTypes = docTypesFor(p);
      if (!id) {
        if (write) { const a = DOC_AREA[req.body?.type]; if (!a || p[a] < 2) deny(); }
        else if (req.query.type && !req.docTypes.includes(req.query.type)) deny();
        return;
      }
      if (!isUuid(id)) return;
      const t = (await pool.query('select type from acc_docs where id = $1 and business_id = $2', [id, req.biz.id])).rows[0]?.type;
      if (!t) return; // the handler answers not_found
      if (write || sub) { if (p[DOC_AREA[t]] < 2) deny(); } else if (!req.docTypes.includes(t)) deny();
      return;
    }
    default: if (write && !any('settings')) deny();
  }
}
