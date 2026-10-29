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
const lineReply = (replyToken, text) => lineCall('reply', { replyToken, messages: [{ type: 'text', text }] });

function groupIdText(id) {
  return `👋 Centel พร้อมส่งเตือนในกลุ่มนี้แล้ว\n\nGroup ID ของกลุ่มนี้:\n${id}\n\nคัดลอกไปใส่ในแอป Centel หน้า บัญชี › แจ้งเตือนในกลุ่ม LINE`;
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
      if (id && (ev.type === 'join' || /^(group ?id|groupid|id|ไอดี|ไอดีกลุ่ม)$/.test(text))) await lineReply(ev.replyToken, groupIdText(id));
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
export async function sendDueReminders() {
  const { rows } = await pool.query(
    `with due as (
       update notes set notified_at = now()
       where notified_at is null and not done and remind_at <= now() and remind_at > now() - interval '1 day'
       returning *
     )
     select due.*, coalesce(u.nickname, u.display_name) as owner_name,
       array(select distinct t.group_id from line_targets t
             where t.active and (t.user_id = due.owner_id
               or (due.couple_id is not null and t.user_id in (select user_id from couple_members where couple_id = due.couple_id)))) as groups
     from due join users u on u.id = due.owner_id`);
  for (const n of rows) {
    for (const g of n.groups) {
      try { await linePush(g, reminderText(n)); } catch (e) { console.error('line push', n.id, e.message, e.detail || ''); }
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
