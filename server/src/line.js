import crypto from 'node:crypto';
import { pool } from './db.js';
import { parseNote, remindAt } from './noteparse.js';
import { aiReadNote } from './noteai.js';

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
// Other systems that also need this channel's webhook (LINE allows one URL per channel):
// each signed event body is passed on to them as it came, with LINE's signature, so they
// check it as usual. Space or comma separated https URLs.
const FORWARD = (process.env.LINE_WEBHOOK_FORWARD || '').split(/[\s,]+/).filter((u) => /^https?:\/\//.test(u));

async function lineCall(path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(`line_${res.status}`), { status: res.status, detail: await res.text().catch(() => '') });
  return res.json().catch(() => ({}));
}

export const linePush = (to, text) => lineCall('push', { to, messages: [{ type: 'text', text: text.slice(0, 5000) }] });

// Text with @mentions of LINE users ({p0}, {p1} … in text). Falls back to plain text,
// with the names written out, when LINE refuses a mention (someone not in the group).
async function linePushMentions(to, text, people) {
  if (!people.length) return linePush(to, text);
  const body = `${text}\n👥 ${people.map((_, i) => `{p${i}}`).join(' ')}`;
  const substitution = Object.fromEntries(people.map((p, i) => [`p${i}`, { type: 'mention', mentionee: { type: 'user', userId: p.userId } }]));
  try {
    return await lineCall('push', { to, messages: [{ type: 'textV2', text: body, substitution }] });
  } catch (e) {
    if (e.status !== 400) throw e;
    return linePush(to, `${text}\n👥 ${people.map((p) => p.name).join(' ')}`);
  }
}
const lineReply = (replyToken, text) => lineCall('reply', { replyToken, messages: [{ type: 'text', text }] });

async function linkMessages(noteId, lineUserId, ids) {
  for (const id of ids.filter(Boolean)) {
    await pool.query('insert into line_note_msgs (message_id, note_id, line_user_id) values ($1, $2, $3) on conflict do nothing', [String(id), noteId, lineUserId || null]);
  }
}

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
  for (const url of FORWARD) {
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': sig }, body: raw, signal: AbortSignal.timeout(10000) })
      .then((r) => { if (!r.ok) console.error('line forward', url, r.status); })
      .catch((e) => console.error('line forward', url, e.message));
  }
  let events = [];
  try { events = JSON.parse(raw.toString('utf8')).events || []; } catch { /* empty */ }
  res.json({ ok: true });
  for (const ev of events) {
    const src = ev.source || {};
    const id = src.groupId || src.roomId;
    if (!ev.replyToken || !TOKEN) continue;
    const raw = ev.type === 'message' && ev.message?.type === 'text' ? ev.message.text : '';
    const text = raw.trim().toLowerCase();
    try {
      const edit = raw && src.userId && await noteEditTarget(ev.message, src.userId);
      const cmd = !edit && raw && noteCommand(ev.message);
      const out = edit ? await noteEditFromLine(edit, src.userId)
        : cmd && src.userId ? await noteFromLine(cmd, src.userId) : null;
      if (out) {
        // The typed line and the bot's answer both point at the note, so a reply to either edits it.
        const sent = await lineReply(ev.replyToken, out.text);
        if (out.noteId) await linkMessages(out.noteId, src.userId, [ev.message.id, sent?.sentMessages?.[0]?.id]);
      }
      else if (id && (ev.type === 'join' || /^(group ?id|groupid|id|ไอดี|ไอดีกลุ่ม)$/.test(text))) {
        const who = ev.type === 'join' ? '' : src.userId;
        await lineReply(ev.replyToken, groupIdText(id, who, who ? await knownName(who) : ''));
      }
      else if (!id && ev.type === 'follow') {
        await lineReply(ev.replyToken, 'สวัสดีครับ 👋 เพิ่ม Centel เข้ากลุ่ม LINE ของบ้าน แล้วบอทจะส่ง Group ID ให้ในกลุ่ม เพื่อนำไปใส่ในแอปหน้า บัญชี');
      }
    } catch (e) { console.error('line reply', e.message, e.detail || ''); }
  }
}

/* ---------- Notes typed into the group ---------- */

// "ทำนัด 18:00 น 31 ตค ไปแข่งกีฬา", "เตือน พรุ่งนี้ 9 โมง จ่ายค่าเน็ต", "นัด หมอฟัน ศุกร์ 10:00",
// or any line that @mentions the bot. Returns { verb, text } (the command word and the
// note part), or null for other chat.
// The command word must stand alone, so everyday chat ("นัดกันกี่โมง") is left alone.
const COMMAND = /^\s*(ทำนัด|นัดหมาย|ลงนัด|นัด|เตือน(?:ความจำ)?|จดไว้|จด|โน้ต|note|remind(?:\s+me)?)(?:\s+|\s*:\s*|$)/i;
// What the bot says it did: "รับทราบครับ ทำนัดให้ แม่เฟิร์น เรียบร้อยแล้ว". A note (จด) may have
// no date; an appointment or reminder it cannot find a date in gets no answer.
const verbOf = (w = '') => (/^(จด|โน้ต|note)/i.test(w) ? 'จด' : /^(เตือน|remind)/i.test(w) ? 'ตั้งเตือน' : 'ทำนัด');
export function noteCommand(message) {
  let s = message.text || '';
  const self = (message.mention?.mentionees || []).filter((x) => x.isSelf);
  for (const x of [...self].sort((a, b) => b.index - a.index)) s = s.slice(0, x.index) + s.slice(x.index + x.length);
  const m = s.match(COMMAND);
  if (!m && !self.length) return null;
  return { verb: verbOf(m?.[1]), text: (m ? s.slice(m[0].length) : s).trim() };
}

const LEADS = [0, 120, 360, 1440, 2880];
const LEAD_TEXT = { 0: 'ตรงเวลา', 120: 'ล่วงหน้า 2 ชั่วโมง', 360: 'ล่วงหน้า 6 ชั่วโมง', 1440: 'ล่วงหน้า 1 วัน', 2880: 'ล่วงหน้า 2 วัน' };
const TH_SHORT = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const thDay = (date) => { const [y, m, d] = date.split('-').map(Number); return TH_SHORT.format(new Date(Date.UTC(y, m - 1, d))); };

// The app account behind a LINE user: someone a person named in Account › คนในกลุ่ม LINE
// as themselves (me) or as their partner.
async function appUserOf(lineUserId) {
  const { rows } = await pool.query(
    `select case when p.who = 'me' then p.owner_id
            else (select m2.user_id from couple_members m1 join couple_members m2 on m2.couple_id = m1.couple_id and m2.user_id <> m1.user_id
                  where m1.user_id = p.owner_id limit 1) end as user_id, p.name
     from line_people p where p.line_user_id = $1 and p.who <> '' order by p.who = 'me' desc, p.sort`, [lineUserId]);
  return rows.find((r) => r.user_id) || null;
}

// Saves the note for the person who typed it (shared with the partner when they have
// one, so it shows in both apps) and returns the reply for the group, or null to stay
// silent when the line is not understood. The free reader goes first; the AI only reads
// lines it finds no date in.
export async function noteFromLine({ verb, text: text0 }, lineUserId, now = new Date()) {
  const who = await appUserOf(lineUserId);
  if (!who) {
    return { text: unknownText(lineUserId) };
  }
  let cmd = text0;
  if (!cmd) return null;
  // "เตือนก่อน 2 ชม." / "ล่วงหน้า 1 วัน" picks the reminder; on time otherwise.
  const l = takeLead(cmd);
  const lead = l.lead ?? 0;
  cmd = l.rest;
  let p = parseNote(cmd, now);
  let ai = false;
  if (!p.date) { const r = await aiReadNote(cmd, now); if (r?.date) { p = r; ai = true; } }
  if (!p.date && verb !== 'จด') return null;
  const text = p.text.slice(0, 500);
  const remind = p.date ? lead : null;
  const { rows } = await pool.query(
    `insert into notes (id, owner_id, couple_id, text, date, time, remind, remind_at)
     values ($1, $2, (select couple_id from couple_members where user_id = $2), $3, $4, $5, $6, $7) returning *`,
    [crypto.randomUUID(), who.user_id, text, p.date || null, p.time || null, remind, remindAt(p.date, p.time, remind)]);
  console.log('line note', ai ? 'ai' : 'rules', p.date ? 'dated' : 'undated');
  return { text: noteSummary(`รับทราบครับ ${verb}ให้ ${who.name} เรียบร้อยแล้ว ✅`, rows[0]), noteId: rows[0].id };
}

const unknownText = (lineUserId) => ['ยังไม่รู้ว่า LINE นี้เป็นใครในแอป Centel 🙏', '', 'ใส่ LINE ID นี้ในแอป หน้า บัญชี › คนในกลุ่ม LINE แล้วเลือกว่าเป็นตัวเองหรือคู่', lineUserId].join('\n');

const noteDate = (n) => (n.date instanceof Date ? n.date.toISOString().slice(0, 10) : n.date || '');
function noteSummary(head, n) {
  const date = noteDate(n);
  const time = n.time ? n.time.slice(0, 5) : '';
  const lines = [head, `📝 ${n.text}`];
  if (date) {
    lines.push(`📅 ${thDay(date)}${time ? ` ${time} น.` : ''}`);
    lines.push(n.remind == null ? '🔕 ไม่เตือน' : `🔔 เตือน${LEAD_TEXT[n.remind] || `ล่วงหน้า ${n.remind} นาที`}${time ? '' : ' (นับจาก 9 โมงเช้าวันนั้น)'}`);
  }
  lines.push(n.couple_id ? '🤝 แชร์กับคู่' : '🔒 ไม่แชร์');
  return lines.join('\n');
}

// "เตือนก่อน 2 ชม." / "ล่วงหน้า 1 วัน" / "เตือนตรงเวลา" / "ไม่ต้องเตือน": lead is minutes, null for
// no reminder, undefined when the line says nothing about it; rest is the line without it.
function takeLead(line) {
  let m = line.match(/(?:เตือน)?\s*(?:ก่อน|ล่วงหน้า)\s*(\d{1,2})\s*(ชม\.?|ชั่วโมง|วัน)/);
  if (m) {
    const mins = +m[1] * (m[2] === 'วัน' ? 1440 : 60);
    if (LEADS.includes(mins)) return { lead: mins, rest: line.replace(m[0], ' ') };
  }
  if ((m = line.match(/เตือนตรงเวลา|ตรงเวลา/))) return { lead: 0, rest: line.replace(m[0], ' ') };
  if ((m = line.match(/ไม่(?:ต้อง)?เตือน/))) return { lead: null, rest: line.replace(m[0], ' ') };
  return { lead: undefined, rest: line };
}

/* ---------- Editing a note from the group ---------- */

// A reply (quote) to the bot's answer, the typed line or a reminder edits that note; a line
// starting with แก้ไข / แก้ / เลื่อน / ยกเลิก / ลบ (and no quote) edits the sender's latest note from LINE.
const EDIT = /^\s*(แก้ไข|แก้|เลื่อน(?:นัด)?|ยกเลิก(?:นัด)?|ลบ(?:นัด)?)\s*(?:เป็น|ไป)?\s*:?\s*/;
export async function noteEditTarget(message, lineUserId) {
  const text = message.text || '';
  if (message.quotedMessageId) {
    const r = await pool.query('select note_id from line_note_msgs where message_id = $1', [String(message.quotedMessageId)]);
    if (r.rows[0]) return { noteId: r.rows[0].note_id, body: text.replace(EDIT, '') , cancel: /^\s*(ยกเลิก|ลบ)/.test(text) };
  }
  const m = text.match(EDIT);
  if (!m) return null;
  const r = await pool.query(
    `select l.note_id from line_note_msgs l join notes n on n.id = l.note_id
     where l.line_user_id = $1 and not n.done order by l.created_at desc limit 1`, [lineUserId]);
  if (!r.rows[0]) return null;
  return { noteId: r.rows[0].note_id, body: text.slice(m[0].length), cancel: /^(ยกเลิก|ลบ)/.test(m[1]) };
}

// Applies what the line asks for: reminder lead, sharing, a new date and/or time, or cancelling.
// Returns null (no answer) when nothing in it is understood or the sender may not edit the note.
export async function noteEditFromLine({ noteId, body, cancel }, lineUserId, now = new Date()) {
  const who = await appUserOf(lineUserId);
  if (!who) return { text: unknownText(lineUserId) };
  const n = (await pool.query(
    `select n.*, (n.owner_id = $2) as mine from notes n
     where n.id = $1 and (n.owner_id = $2 or (n.couple_id is not null and n.couple_id = (select couple_id from couple_members where user_id = $2)))`,
    [noteId, who.user_id])).rows[0];
  if (!n) return null;
  if (cancel) {
    if (!n.mine) return null;
    await pool.query('delete from notes where id = $1', [n.id]);
    return { text: `รับทราบครับ ยกเลิกนัดให้ ${who.name} เรียบร้อยแล้ว 🗑️\n📝 ${n.text}` };
  }
  let rest = body;
  const l = takeLead(rest);
  rest = l.rest;
  let share;
  const sm = rest.match(/(ไม่(?:ต้อง)?)?แชร์(?:กับ(?:คู่|\S*))?/);
  if (sm) { share = !sm[1]; rest = rest.replace(sm[0], ' '); }
  const p = parseNote(rest, now);
  const date = p.date && !p.timeOnly ? p.date : noteDate(n);
  const time = p.time || (n.time ? n.time.slice(0, 5) : '');
  const changed = l.lead !== undefined || (share !== undefined && n.mine) || (p.date && !p.timeOnly) || p.time;
  if (!changed || !date) return null;
  const remind = l.lead !== undefined ? l.lead : n.remind;
  const coupleSql = share === undefined || !n.mine ? 'couple_id' : share ? '(select couple_id from couple_members where user_id = owner_id)' : 'null';
  const at = remindAt(date, time, remind);
  const { rows } = await pool.query(
    `update notes set date = $2, time = $3, remind = $4, remind_at = $5, couple_id = ${coupleSql},
       notified_at = case when remind_at is not distinct from $5 then notified_at end, updated_at = now()
     where id = $1 returning *`,
    [n.id, date, time || null, remind, at]);
  return { text: noteSummary(`รับทราบครับ แก้ไขนัดให้ ${who.name} เรียบร้อยแล้ว ✅`, rows[0]), noteId: n.id };
}

/* ---------- Reminder sender ---------- */

const TH_DATE = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const REMIND_TEXT = { 0: 'ถึงเวลาแล้ว', 60: 'อีก 1 ชั่วโมง', 120: 'อีก 2 ชั่วโมง', 180: 'อีก 3 ชั่วโมง', 360: 'อีก 6 ชั่วโมง', 1440: 'พรุ่งนี้', 2880: 'อีก 2 วัน', 4320: 'อีก 3 วัน' };

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
      try {
        const sent = await linePushMentions(g, reminderText(n), list);
        await linkMessages(n.id, null, [sent?.sentMessages?.[0]?.id]);
      } catch (e) { console.error('line push', n.id, e.message, e.detail || ''); }
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
