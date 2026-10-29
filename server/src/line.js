import crypto from 'node:crypto';
import { pool } from './db.js';

/* LINE OA reminders for to-do notes. The person adds the LINE OA to a group chat;
   the webhook answers with that group's id, which they paste into the Account tab
   (line_targets). Every minute, notes whose remind_at has come are sent to the
   owner's group, and to the partner's group too for a shared note.
   Needs LINE_CHANNEL_ACCESS_TOKEN (sending) and LINE_CHANNEL_SECRET (webhook). */

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const SECRET = process.env.LINE_CHANNEL_SECRET || '';
export const lineEnabled = !!TOKEN;
// LINE_API_URL / LINE_TICK_MS let the tests point at a stand-in LINE and tick faster.
const API = process.env.LINE_API_URL || 'https://api.line.me/v2/bot/message';
const TICK = Number(process.env.LINE_TICK_MS) || 60000;

async function lineCall(path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(`line_${res.status}`), { status: res.status, detail: await res.text().catch(() => '') });
}

export const linePush = (to, text) => lineCall('push', { to, messages: [{ type: 'text', text: text.slice(0, 5000) }] });

// Text with @mentions of LINE users ({p0}, {p1} … in text). Falls back to plain text,
// with the names written out, when LINE refuses a mention (someone not in the group).
async function linePushMentions(to, text, people) {
  if (!people.length) return linePush(to, text);
  const body = `${text}\n👥 ${people.map((_, i) => `{p${i}}`).join(' ')}`;
  const substitution = Object.fromEntries(people.map((p, i) => [`p${i}`, { type: 'mention', mentionee: { type: 'user', userId: p.userId } }]));
  try {
    await lineCall('push', { to, messages: [{ type: 'textV2', text: body, substitution }] });
  } catch (e) {
    if (e.status !== 400) throw e;
    await linePush(to, `${text}\n👥 ${people.map((p) => p.name).join(' ')}`);
  }
}
const lineReply = (replyToken, text) => lineCall('reply', { replyToken, messages: [{ type: 'text', text }] });

async function knownName(userId) {
  if (!userId) return '';
  const r = await pool.query('select name from line_people where line_user_id = $1 order by sort limit 1', [userId]);
  return r.rows[0]?.name || '';
}

function groupIdText(id, userId, name) {
  const lines = [`👋 ${name ? `สวัสดี ${name} ` : ''}Centel พร้อมส่งเตือนในกลุ่มนี้แล้ว`, '', 'Group ID ของกลุ่มนี้:', id];
  if (userId) lines.push('', `LINE ID ของ${name ? ` ${name}` : 'คุณ'}:`, userId);
  lines.push('', 'นำไปใส่ในแอป Centel หน้า บัญชี › แจ้งเตือนในกลุ่ม LINE');
  return lines.join('\n');
}

// POST /api/line/webhook with the raw body, so the signature can be checked.
export async function lineWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const sig = req.get('x-line-signature') || '';
  const want = SECRET ? crypto.createHmac('sha256', SECRET).update(raw).digest('base64') : '';
  if (!want || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
    return res.status(401).json({ error: 'bad_signature' });
  }
  let events = [];
  try { events = JSON.parse(raw.toString('utf8')).events || []; } catch { /* empty */ }
  res.json({ ok: true });
  for (const ev of events) {
    const src = ev.source || {};
    const id = src.groupId || src.roomId;
    if (!ev.replyToken || !TOKEN) continue;
    const text = ev.type === 'message' && ev.message?.type === 'text' ? ev.message.text.trim().toLowerCase() : '';
    try {
      if (id && (ev.type === 'join' || /^(group ?id|groupid|id|ไอดี|ไอดีกลุ่ม)$/.test(text))) {
        const who = ev.type === 'join' ? '' : src.userId;
        await lineReply(ev.replyToken, groupIdText(id, who, who ? await knownName(who) : ''));
      }
      else if (!id && ev.type === 'follow') {
        await lineReply(ev.replyToken, 'สวัสดีครับ 👋 เพิ่ม Centel เข้ากลุ่ม LINE ของบ้าน แล้วบอทจะส่ง Group ID ให้ในกลุ่ม เพื่อนำไปใส่ในแอปหน้า บัญชี');
      }
    } catch (e) { console.error('line reply', e.message, e.detail || ''); }
  }
}

/* ---------- Reminder sender ---------- */

const TH_DATE = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const REMIND_TEXT = { 0: 'ถึงเวลาแล้ว', 60: 'อีก 1 ชั่วโมง', 180: 'อีก 3 ชั่วโมง', 1440: 'พรุ่งนี้', 4320: 'อีก 3 วัน' };

export function reminderText(n) {
  const [y, m, d] = n.date.split('-').map(Number);
  const when = `${TH_DATE.format(new Date(Date.UTC(y, m - 1, d)))}${n.time ? ` · ${n.time.slice(0, 5)} น.` : ''}`;
  const lines = [`🔔 ${REMIND_TEXT[n.remind] || 'เตือนความจำ'}`, `📝 ${n.text}`, `📅 ${when}`];
  if (n.couple_id && n.owner_name) lines.push(`👤 จาก ${n.owner_name}`);
  return lines.join('\n');
}

// Claims due notes first (notified_at), then sends, so a reminder goes out at most once
// even if two api instances run. Reminders more than a day late are not sent.
// A note goes to its owner's active group and, when shared, the partner's too. Each
// group's owner can name LINE users (line_people); those who are the note's people
// (the owner, plus the partner on a shared note) are @mentioned.
export async function sendDueReminders() {
  const { rows } = await pool.query(
    `with due as (
       update notes set notified_at = now()
       where notified_at is null and not done and remind_at <= now() and remind_at > now() - interval '1 day'
       returning *
     )
     select due.*, coalesce(u.nickname, u.display_name) as owner_name,
       case when due.couple_id is null then array[due.owner_id]
            else array(select user_id from couple_members where couple_id = due.couple_id) end as people_ids
     from due join users u on u.id = due.owner_id`);
  if (!rows.length) return 0;
  const users = [...new Set(rows.flatMap((n) => n.people_ids))];
  const targets = (await pool.query(
    `select t.user_id, t.group_id,
       (select m2.user_id from couple_members m1 join couple_members m2 on m2.couple_id = m1.couple_id and m2.user_id <> m1.user_id
        where m1.user_id = t.user_id limit 1) as partner_id
     from line_targets t where t.active and t.user_id = any($1)`, [users])).rows;
  const people = (await pool.query(
    "select owner_id, line_user_id, name, who from line_people where who <> '' and owner_id = any($1) order by sort", [users])).rows;
  for (const n of rows) {
    const mine = new Set(n.people_ids);
    const groups = new Map();
    for (const t of targets.filter((x) => mine.has(x.user_id))) {
      const list = groups.get(t.group_id) || [];
      for (const p of people.filter((x) => x.owner_id === t.user_id)) {
        const appUser = p.who === 'me' ? t.user_id : t.partner_id;
        if (mine.has(appUser) && !list.some((x) => x.userId === p.line_user_id)) list.push({ userId: p.line_user_id, name: p.name });
      }
      groups.set(t.group_id, list);
    }
    for (const [g, list] of groups) {
      try { await linePushMentions(g, reminderText(n), list); } catch (e) { console.error('line push', n.id, e.message, e.detail || ''); }
    }
  }
  return rows.length;
}

export function startLineReminders() {
  if (!lineEnabled) return;
  const tick = () => sendDueReminders().catch((e) => console.error('line reminders', e.message));
  setTimeout(tick, Math.min(5000, TICK));
  setInterval(tick, TICK);
  console.log('line reminders on');
}
