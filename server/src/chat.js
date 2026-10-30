import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { requireUser, rateLimit } from './auth.js';
import { pushTo } from './push.js';
import { noteCommand, saveNoteCommand } from './line.js';
import { remindAt, thaiToday } from './noteparse.js';
import { noteOut } from './routes.js';

/* In-app chat (chat.js in the PWA). Two rooms per person: 'couple', shared by the two
   linked accounts, and 'ai', a private room with the assistant. New messages, edits,
   read marks and typing reach open apps through one Server-Sent Events stream per
   device (/api/chat/stream); a partner with no app open gets a Web Push.

   The assistant: "ทำนัด / เตือน / จด …" lines are saved as notes straight away by the same
   rules as the LINE group (line.js). Anything else asked of it (every line in the 'ai'
   room, "@ผู้ช่วย" or a reply to it in the couple room) becomes a chat_job. Hermes Agent
   runs on the family's Mac; the bridge there (bridge/centel_bridge.py) holds a long poll on
   /api/bridge/next with its token, sends the prompt built here to Hermes and posts the
   answer to /api/bridge/jobs/:id. While no bridge is polling, the room shows the assistant
   as offline and a question waits up to JOB_TTL_MIN minutes. */

const router = express.Router();
export const bridgeRouter = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const ROOMS = new Set(['couple', 'ai']);
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👌'];
const MAX_TEXT = 4000;
const JOB_TTL_MIN = Number(process.env.CHAT_JOB_TTL_MIN) || 30;
const BRIDGE_ONLINE_MS = 75000;
const AI_NAME = 'ผู้ช่วย';
// "@ผู้ช่วย", "@ai", "@hermes" call the assistant in the couple room.
const MENTION = /@(?:ผู้ช่วย|ai|hermes|bot)/i;
const MENTIONS = new RegExp(MENTION.source, 'gi');

/* ---------- People ---------- */

// The person, their couple and partner, by the api's own connection.
async function whoIs(userId) {
  const { rows } = await pool.query(
    `select u.id, coalesce(u.nickname, u.display_name) as name, m.couple_id,
            p.id as partner_id, coalesce(p.nickname, p.display_name) as partner_name
     from users u left join couple_members m on m.user_id = u.id
     left join couple_members pm on pm.couple_id = m.couple_id and pm.user_id <> u.id
     left join users p on p.id = pm.user_id
     where u.id = $1`, [userId]);
  const r = rows[0];
  if (!r) throw bad('unauthorized', 401);
  return { id: r.id, name: r.name, coupleId: r.couple_id || null, partnerId: r.partner_id || null, partnerName: r.partner_name || null };
}

// Who sees a room: the couple room needs a partner to talk to.
function audience(me, room) { return room === 'couple' ? [me.id, me.partnerId].filter(Boolean) : [me.id]; }
function roomOk(me, room) {
  if (!ROOMS.has(room)) throw bad('bad_room');
  if (room === 'couple' && !me.coupleId) throw bad('no_partner', 409);
}
// SQL for "messages in this room as seen by me": $1 = couple id or user id.
const roomSql = (room) => (room === 'couple' ? "room = 'couple' and couple_id = $1" : "room = 'ai' and owner_id = $1");
const roomKey = (me, room) => (room === 'couple' ? me.coupleId : me.id);

const msgOut = (m) => ({
  id: m.id, room: m.room, senderId: m.from_ai ? null : m.sender_id, ai: m.from_ai,
  text: m.deleted_at ? '' : m.text, replyTo: m.reply_to || undefined, action: m.deleted_at ? undefined : m.action || undefined,
  reactions: m.reactions || {}, at: m.created_at, editedAt: m.edited_at || undefined, deleted: !!m.deleted_at || undefined,
});

/* ---------- Live stream ---------- */

const streams = new Map(); // user id → Set of open SSE responses
const isOpen = (id) => (streams.get(id)?.size || 0) > 0;
function emit(userIds, ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const id of new Set(userIds)) for (const res of streams.get(id) || []) res.write(data);
}

router.use(requireUser);

router.get('/stream', (req, res) => {
  const id = req.user.id;
  res.set({
    'Content-Type': 'text/event-stream',
    // no-transform + identity keep proxies (Caddy's gzip) from holding events back.
    'Cache-Control': 'no-cache, no-transform',
    'Content-Encoding': 'identity',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  if (!streams.has(id)) streams.set(id, new Set());
  streams.get(id).add(res);
  const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    streams.get(id)?.delete(res);
    if (!streams.get(id)?.size) streams.delete(id);
  });
});

/* ---------- Rooms ---------- */

async function bridgeState(me) {
  const ids = [me.id, me.partnerId].filter(Boolean);
  const { rows } = await pool.query('select user_id, created_at, last_seen, info from bridge_tokens where user_id = any($1)', [ids]);
  const seen = rows.map((r) => r.last_seen).filter(Boolean).map((d) => +new Date(d));
  const last = seen.length ? Math.max(...seen) : 0;
  const mine = rows.find((r) => r.user_id === me.id);
  return {
    online: !!last && Date.now() - last < BRIDGE_ONLINE_MS,
    lastSeen: last ? new Date(last).toISOString() : null,
    set: rows.length > 0,
    mine: mine ? { createdAt: mine.created_at, lastSeen: mine.last_seen, info: mine.info || undefined } : null,
  };
}

async function reads(me, room) {
  const ids = audience(me, room);
  const { rows } = await pool.query('select user_id, last_read from chat_reads where room = $1 and user_id = any($2)', [room, ids]);
  const at = (id) => rows.find((r) => r.user_id === id)?.last_read || null;
  return { me: at(me.id), partner: room === 'couple' ? at(me.partnerId) : null };
}

async function pending(me, room) {
  const { rows } = await pool.query(
    `select status from chat_jobs where room = $1 and ${room === 'couple' ? 'couple_id' : 'user_id'} = $2
       and status in ('queued', 'taken') order by created_at desc limit 1`, [room, roomKey(me, room)]);
  return rows[0] ? (rows[0].status === 'taken' ? 'typing' : 'queued') : null;
}

// Home card and room list: last message and unread count per room, and the assistant's state.
router.get('/state', wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  const out = { rooms: {}, bridge: await bridgeState(me), reactions: REACTIONS };
  for (const room of me.coupleId ? ['couple', 'ai'] : ['ai']) {
    const k = roomKey(me, room);
    const last = (await pool.query(`select * from chat_messages where ${roomSql(room)} order by created_at desc limit 1`, [k])).rows[0];
    const r = await reads(me, room);
    const unread = (await pool.query(
      `select count(*)::int as n from chat_messages where ${roomSql(room)} and deleted_at is null
         and (from_ai or sender_id is distinct from $2) and created_at > coalesce($3, '-infinity'::timestamptz)`,
      [k, me.id, r.me])).rows[0].n;
    out.rooms[room] = { last: last ? msgOut(last) : null, unread, reads: r, pending: await pending(me, room) };
  }
  if (me.coupleId) out.rooms.couple.name = (await pool.query('select chat_name from couples where id = $1', [me.coupleId])).rows[0]?.chat_name || null;
  res.json(out);
}));

// Rename the shared room; an empty name goes back to the default.
router.put('/room', wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  roomOk(me, 'couple');
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
  await pool.query('update couples set chat_name = $2 where id = $1', [me.coupleId, name]);
  emit(audience(me, 'couple'), { type: 'room', room: 'couple', name });
  res.json({ name });
}));

// One page of a room, oldest first: the newest 60, or 60 before `before`, or everything after `after`.
router.get('/messages', wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  const room = String(req.query.room || '');
  roomOk(me, room);
  const k = roomKey(me, room);
  const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
  const after = req.query.after && !Number.isNaN(Date.parse(req.query.after)) ? new Date(req.query.after) : null;
  let rows;
  if (after) {
    rows = (await pool.query(`select * from chat_messages where ${roomSql(room)} and (created_at > $2 or edited_at > $2 or deleted_at > $2) order by created_at limit 200`, [k, after])).rows;
  } else {
    rows = (await pool.query(`select * from chat_messages where ${roomSql(room)} ${before ? 'and created_at < $2' : ''} order by created_at desc limit 60`, before ? [k, before] : [k])).rows.reverse();
  }
  res.json({ messages: rows.map(msgOut), reads: await reads(me, room), pending: await pending(me, room), more: !after && rows.length === 60 });
}));

async function addMessage({ id = crypto.randomUUID(), room, me, senderId = null, ai = false, text, replyTo = null, action = null }) {
  const { rows } = await pool.query(
    `insert into chat_messages (id, room, couple_id, owner_id, sender_id, from_ai, text, reply_to, action)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [id, room, room === 'couple' ? me.coupleId : null, me.id, senderId, ai, text, replyTo, action]);
  const m = msgOut(rows[0]);
  emit(audience(me, room), { type: 'msg', room, msg: m });
  return m;
}

// A push to whoever in the room has no app open (the sender never gets one).
function notify(me, room, m, title) {
  const to = audience(me, room).filter((id) => id !== m.senderId && !isOpen(id));
  if (!to.length) return;
  const plain = m.ai ? m.text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '') : m.text;
  const body = plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
  pushTo(to, { title, body, url: `/#chat-${room}`, tag: `chat-${room}` }).catch((e) => console.error('chat push', e.message));
}

const jobWaiters = new Set();
function wakeBridges() { for (const w of jobWaiters) w(); }

router.post('/messages', rateLimit(120, 60000), wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  const b = req.body || {};
  const room = String(b.room || '');
  roomOk(me, room);
  if (!isUuid(b.id)) throw bad('bad_id');
  const text = String(b.text || '').trim().slice(0, MAX_TEXT);
  if (!text) throw bad('bad_text');
  let replyTo = null;
  let replyAi = false;
  if (b.replyTo) {
    if (!isUuid(b.replyTo)) throw bad('bad_reply');
    const r = (await pool.query(`select from_ai from chat_messages where ${roomSql(room)} and id = $2`, [roomKey(me, room), b.replyTo])).rows[0];
    if (r) { replyTo = b.replyTo; replyAi = r.from_ai; }
  }
  const dup = (await pool.query('select * from chat_messages where id = $1', [b.id])).rows[0];
  if (dup) {
    if (dup.sender_id !== me.id) throw bad('conflict', 409);
    return res.json({ message: msgOut(dup) });
  }
  const m = await addMessage({ id: b.id, room, me, senderId: me.id, text, replyTo });
  notify(me, room, m, room === 'couple' ? me.name : AI_NAME);

  // The assistant's part.
  const plain = text.replace(MENTIONS, ' ').replace(/\s+/g, ' ').trim();
  let called = room === 'ai' || replyAi || MENTION.test(text);
  // A bare "@ผู้ช่วย" sent on its own calls the assistant for the sender's next message.
  if (!called) {
    const prev = (await pool.query(
      `select text, sender_id from chat_messages where ${roomSql(room)} and id <> $2 and created_at > now() - interval '5 minutes'
       order by created_at desc limit 1`, [roomKey(me, room), m.id])).rows[0];
    called = !!prev && prev.sender_id === me.id && MENTION.test(prev.text) && !prev.text.replace(MENTIONS, '').trim();
  }
  const cmd = noteCommand({ text: plain });
  let assistant = null;
  if (cmd && cmd.text) {
    const done = await saveNoteCommand(cmd, { user_id: me.id, name: me.name }).catch((e) => { console.error('chat note', e.message); return null; });
    if (done && done.note) {
      // The card shows the details, so the bubble keeps only the first line of the LINE answer.
      assistant = await addMessage({ room, me, ai: true, text: done.text.split('\n')[0], replyTo: room === 'couple' ? m.id : null, action: { type: 'note', note: noteOut(done.note) } });
      emit([me.id, me.partnerId].filter(Boolean), { type: 'note', note: noteOut(done.note) });
    }
  }
  if (!assistant && called && plain) {
    const context = b.context && typeof b.context === 'object' ? JSON.stringify(b.context).slice(0, 20000) : null;
    await pool.query(
      'insert into chat_jobs (id, message_id, user_id, room, couple_id, context) values ($1, $2, $3, $4, $5, $6)',
      [crypto.randomUUID(), m.id, me.id, room, room === 'couple' ? me.coupleId : null, context]);
    const online = (await bridgeState(me)).online;
    emit(audience(me, room), { type: 'ai', room, state: online ? 'queued' : 'offline' });
    wakeBridges();
  }
  res.json({ message: m, assistant });
}));

async function ownMessage(me, id) {
  if (!isUuid(id)) throw bad('bad_id');
  const r = (await pool.query('select * from chat_messages where id = $1', [id])).rows[0];
  const visible = r && (r.room === 'couple' ? r.couple_id === me.coupleId : r.owner_id === me.id);
  if (!visible) throw bad('not_found', 404);
  return r;
}

router.put('/messages/:id', wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  const r = await ownMessage(me, req.params.id);
  if (r.from_ai || r.sender_id !== me.id || r.deleted_at) throw bad('forbidden', 403);
  const text = String(req.body?.text || '').trim().slice(0, MAX_TEXT);
  if (!text) throw bad('bad_text');
  const { rows } = await pool.query('update chat_messages set text = $2, edited_at = now() where id = $1 returning *', [r.id, text]);
  const m = msgOut(rows[0]);
  emit(audience(me, r.room), { type: 'msg', room: r.room, msg: m });
  res.json({ message: m });
}));

router.delete('/messages/:id', wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  const r = await ownMessage(me, req.params.id);
  // Your own messages, and the assistant's in your private room.
  if (!(r.sender_id === me.id && !r.from_ai) && !(r.from_ai && r.room === 'ai')) throw bad('forbidden', 403);
  const { rows } = await pool.query("update chat_messages set deleted_at = now(), text = '', action = null where id = $1 returning *", [r.id]);
  const m = msgOut(rows[0]);
  emit(audience(me, r.room), { type: 'msg', room: r.room, msg: m });
  res.json({ message: m });
}));

// Puts or takes back this person's one reaction on a message.
router.post('/messages/:id/react', wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  const r = await ownMessage(me, req.params.id);
  if (r.deleted_at) throw bad('not_found', 404);
  const emoji = String(req.body?.emoji || '');
  if (emoji && !REACTIONS.includes(emoji)) throw bad('bad_emoji');
  const same = r.reactions?.[me.id] === emoji;
  const { rows } = await pool.query(
    emoji && !same ? 'update chat_messages set reactions = reactions || jsonb_build_object($2::text, $3::text) where id = $1 returning *'
      : 'update chat_messages set reactions = reactions - $2::text where id = $1 returning *',
    emoji && !same ? [r.id, me.id, emoji] : [r.id, me.id]);
  const m = msgOut(rows[0]);
  emit(audience(me, r.room), { type: 'msg', room: r.room, msg: m });
  res.json({ message: m });
}));

router.post('/read', wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  const room = String(req.body?.room || '');
  roomOk(me, room);
  const { rows } = await pool.query(
    `insert into chat_reads (user_id, room, last_read) values ($1, $2, now())
     on conflict (user_id, room) do update set last_read = greatest(chat_reads.last_read, excluded.last_read) returning last_read`,
    [me.id, room]);
  emit(audience(me, room), { type: 'read', room, userId: me.id, at: rows[0].last_read });
  res.json({ at: rows[0].last_read });
}));

router.post('/typing', wrap(async (req, res) => {
  const me = await whoIs(req.user.id);
  if (req.body?.room === 'couple' && me.partnerId) emit([me.partnerId], { type: 'typing', room: 'couple', userId: me.id });
  res.json({ ok: true });
}));

/* ---------- Bridge token (Account › ผู้ช่วย AI) ---------- */

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

router.get('/bridge', wrap(async (req, res) => {
  res.json(await bridgeState(await whoIs(req.user.id)));
}));

// A new token replaces the old one, so a bridge set up with the old token stops working.
router.post('/bridge', rateLimit(20, 60 * 60000), wrap(async (req, res) => {
  const token = `cb_${crypto.randomBytes(24).toString('base64url')}`;
  await pool.query(
    `insert into bridge_tokens (user_id, token_hash) values ($1, $2)
     on conflict (user_id) do update set token_hash = excluded.token_hash, created_at = now(), last_seen = null, info = null`,
    [req.user.id, hashToken(token)]);
  res.json({ token });
}));

router.delete('/bridge', wrap(async (req, res) => {
  await pool.query('delete from bridge_tokens where user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));

/* ---------- Bridge (the Mac) ---------- */

bridgeRouter.use(wrap(async (req, _res, next) => {
  const m = /^Bearer\s+(cb_[A-Za-z0-9_-]{32})$/.exec(req.get('authorization') || '');
  if (!m) throw bad('unauthorized', 401);
  const { rows } = await pool.query(
    'update bridge_tokens set last_seen = now(), info = coalesce($2, info) where token_hash = $1 returning user_id',
    [hashToken(m[1]), String(req.get('x-bridge-info') || '').slice(0, 120) || null]);
  if (!rows[0]) throw bad('unauthorized', 401);
  const me = await whoIs(rows[0].user_id);
  req.bridge = { userId: me.id, users: [me.id, me.partnerId].filter(Boolean) };
  next();
}));

async function takeJob(users) {
  const { rows } = await pool.query(
    `update chat_jobs set status = 'taken', taken_at = now()
     where id = (select id from chat_jobs where status = 'queued' and user_id = any($1) and created_at > now() - make_interval(mins => $2)
                 order by created_at for update skip locked limit 1)
     returning *`, [users, JOB_TTL_MIN]);
  return rows[0] || null;
}

// Long poll: a job as soon as there is one, or 204 after `wait` seconds (at most 25).
bridgeRouter.get('/next', wrap(async (req, res) => {
  const w = Number(req.query.wait ?? 25);
  const wait = Math.min(Math.max(Number.isFinite(w) ? w : 25, 0), 25) * 1000;
  const until = Date.now() + wait;
  let job = await takeJob(req.bridge.users);
  while (!job && Date.now() < until) {
    let closed = false;
    await new Promise((resolve) => {
      const done = () => { clearTimeout(t); jobWaiters.delete(done); resolve(); };
      const t = setTimeout(done, Math.min(until - Date.now(), 5000));
      jobWaiters.add(done);
      req.once('close', () => { closed = true; done(); });
    });
    if (closed || res.writableEnded) return;
    job = await takeJob(req.bridge.users);
  }
  if (!job) return res.status(204).end();
  const asker = await whoIs(job.user_id);
  emit(audience(asker, job.room), { type: 'ai', room: job.room, state: 'typing' });
  res.json({ id: job.id, messages: await buildPrompt(job, asker) });
}));

// The answer for a job: { reply } or { error }. A <centel-note>{…}</centel-note> block in
// the reply is saved as a to-do note for the person who asked.
bridgeRouter.post('/jobs/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('bad_id');
  const job = (await pool.query("select * from chat_jobs where id = $1 and status = 'taken' and user_id = any($2)", [req.params.id, req.bridge.users])).rows[0];
  if (!job) throw bad('not_found', 404);
  const asker = await whoIs(job.user_id);
  const raw = String(req.body?.reply || '').slice(0, 12000);
  if (!raw.trim()) {
    await pool.query("update chat_jobs set status = 'failed' where id = $1", [job.id]);
    console.error('bridge job failed', String(req.body?.error || '').slice(0, 300));
    await addMessage({ room: job.room, me: asker, ai: true, replyTo: job.message_id, text: 'ขอโทษครับ ตอนนี้ผู้ช่วยตอบไม่ได้ ลองถามใหม่อีกครั้งนะครับ' });
    return res.json({ ok: true });
  }
  const { text, note } = await applyActions(raw, job, asker);
  await pool.query("update chat_jobs set status = 'done' where id = $1", [job.id]);
  const m = await addMessage({
    room: job.room, me: asker, ai: true, replyTo: job.room === 'couple' ? job.message_id : null,
    text: text || (note ? `จดให้ ${asker.name} เรียบร้อยแล้วครับ ✅` : '…'),
    action: note ? { type: 'note', note: noteOut(note) } : null,
  });
  if (note) emit([asker.id, asker.partnerId].filter(Boolean), { type: 'note', note: noteOut(note) });
  notify(asker, job.room, m, AI_NAME);
  res.json({ ok: true, message: m });
}));

const NOTE_TAG = /<centel-note>([\s\S]*?)<\/centel-note>/i;
const LEADS = new Set([0, 120, 360, 1440, 2880]);
async function applyActions(raw, job, asker) {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = text.match(NOTE_TAG);
  text = text.replace(NOTE_TAG, '').trim();
  if (!m) return { text, note: null };
  let a;
  try { a = JSON.parse(m[1].trim()); } catch (e) { return { text, note: null }; }
  const noteText = String(a.text || '').trim().slice(0, 500);
  if (!noteText) return { text, note: null };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : null;
  const time = date && /^([01]\d|2[0-3]):[0-5]\d$/.test(a.time || '') ? a.time : null;
  const remind = date ? (LEADS.has(a.remind) ? a.remind : 0) : null;
  const { rows } = await pool.query(
    `insert into notes (id, owner_id, couple_id, text, date, time, remind, remind_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [crypto.randomUUID(), asker.id, asker.coupleId, noteText, date, time, remind, remindAt(date, time, remind)]);
  return { text, note: rows[0] };
}

/* ---------- What the assistant is told ---------- */

const baht = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} บาท`;

async function buildPrompt(job, asker) {
  const t = thaiToday();
  const ym = t.date.slice(0, 7);
  const notes = (await pool.query(
    `select text, date, time, done from notes where not done and (owner_id = $1 or (couple_id is not null and couple_id = $2))
     order by date nulls last, time nulls first limit 25`, [asker.id, asker.coupleId])).rows;
  const spend = (await pool.query(
    `select scope, coalesce(category, 'รอตรวจสอบ') as category, sum(amount) as total, count(*)::int as n from expenses
     where type = 'expense' and to_char(date, 'YYYY-MM') = $3 and status <> 'rejected'
       and ((scope = 'personal' and owner_id = $1) or (scope = 'shared' and couple_id = $2))
     group by scope, category order by total desc`, [asker.id, asker.coupleId, ym])).rows;
  const budgets = (await pool.query(
    `select scope, category, amount from budgets where (scope = 'personal' and owner_id = $1) or (scope = 'shared' and couple_id = $2)`,
    [asker.id, asker.coupleId])).rows;
  const recent = (await pool.query(
    `select date, coalesce(merchant, note, '') as what, amount, category, scope from expenses
     where type = 'expense' and ((scope = 'personal' and owner_id = $1) or (scope = 'shared' and couple_id = $2))
     order by date desc, created_at desc limit 12`, [asker.id, asker.coupleId])).rows;
  const ctx = job.context && typeof job.context === 'object' ? job.context : {};
  const cats = ctx.cats && typeof ctx.cats === 'object' ? ctx.cats : {};
  const catName = (c) => String(cats[c] || c);

  const data = [
    `วันนี้: ${t.weekday} ${t.date} เวลา ${t.time} (ประเทศไทย)`,
    `คนที่ถาม: ${asker.name}${asker.partnerName ? ` · คู่: ${asker.partnerName}` : ''}`,
    job.room === 'couple' ? `ห้อง: แชทของ ${asker.name} กับ ${asker.partnerName} (ทั้งสองคนเห็นคำตอบ)` : `ห้อง: แชทส่วนตัวของ ${asker.name} กับผู้ช่วย`,
    '',
    'สิ่งที่ต้องทำที่ยังไม่เสร็จ:',
    ...(notes.length ? notes.map((n) => `- ${n.date || 'ไม่ระบุวัน'}${n.time ? ` ${n.time.slice(0, 5)}` : ''} ${n.text}`) : ['- (ไม่มี)']),
    '',
    `รายจ่ายเดือน ${ym}:`,
    ...(spend.length ? spend.map((s) => `- ${s.scope === 'shared' ? 'ร่วมกัน' : 'ส่วนตัว'} · ${catName(s.category)}: ${baht(s.total)} (${s.n} รายการ)`) : ['- (ยังไม่มี)']),
    '',
    'งบประมาณรายเดือน:',
    ...(budgets.length ? budgets.map((b) => `- ${b.scope === 'shared' ? 'ร่วมกัน' : 'ส่วนตัว'} · ${b.category === 'all' ? 'ทุกหมวด' : catName(b.category)}: ${baht(b.amount)}`) : ['- (ไม่ได้ตั้ง)']),
    '',
    'รายจ่ายล่าสุด:',
    ...(recent.length ? recent.map((e) => `- ${e.date} ${e.what || catName(e.category)} ${baht(e.amount)}${e.scope === 'shared' ? ' (ร่วม)' : ''}`) : ['- (ไม่มี)']),
  ];
  if (Array.isArray(ctx.bills)) {
    data.push('', 'บิลเดือนนี้ (จากเครื่องของคนที่ถาม):');
    for (const b of ctx.bills.slice(0, 30)) {
      data.push(`- ${String(b.name || '').slice(0, 60)}: ${b.amount ? baht(b.amount) : 'ไม่ระบุยอด'} · ครบกำหนด ${String(b.due || '-').slice(0, 10)} · ${b.paid ? 'จ่ายแล้ว' : 'ยังไม่จ่าย'}`);
    }
  }

  const system = [
    `คุณคือ "${AI_NAME}" ผู้ช่วยในแอป Centel ของครอบครัว (แอปจ่ายบิล รายรับรายจ่าย งบประมาณ และสิ่งที่ต้องทำ)`,
    'ตอบสั้น กระชับ เป็นกันเอง ใช้ภาษาเดียวกับที่ถาม (ปกติภาษาไทย ลงท้ายด้วย ครับ) ไม่ต้องใช้ Markdown ตาราง',
    'ใช้เฉพาะข้อมูลด้านล่าง ถ้าข้อมูลไม่พอให้บอกตรงๆ ห้ามแต่งตัวเลข เงินเป็นบาท',
    'ถ้าถูกขอให้จด นัด หรือเตือนอะไร ให้ใส่บล็อกนี้หนึ่งบล็อกท้ายคำตอบ แล้วแอปจะบันทึกเป็นโน้ตให้:',
    '<centel-note>{"text": "สิ่งที่ต้องทำ", "date": "YYYY-MM-DD หรือ null", "time": "HH:MM หรือ null", "remind": 0}</centel-note>',
    'remind คือเตือนก่อนกี่นาที เลือก 0, 120, 360, 1440 หรือ 2880 · ปี พ.ศ. ลบ 543 เป็น ค.ศ.',
    'ห้ามรันคำสั่งหรือแตะไฟล์บนเครื่อง งานนี้มาจากแชทในแอปเท่านั้น',
    '',
    '--- ข้อมูลจากแอป ---',
    ...data,
  ].join('\n');

  const k = job.room === 'couple' ? job.couple_id : job.user_id;
  const history = (await pool.query(
    `select * from (select * from chat_messages where ${roomSql(job.room)} and deleted_at is null
       and created_at <= (select created_at from chat_messages where id = $2) order by created_at desc limit 16) x order by created_at`,
    [k, job.message_id])).rows;
  const names = new Map([[asker.id, asker.name], [asker.partnerId, asker.partnerName]]);
  const turns = history.map((m) => (m.from_ai
    ? { role: 'assistant', content: m.text }
    : { role: 'user', content: job.room === 'couple' ? `${names.get(m.sender_id) || 'สมาชิก'}: ${m.text}` : m.text }));
  return [{ role: 'system', content: system }, ...turns];
}

/* ---------- Questions nobody answered ---------- */

export function startChatJobs() {
  const tick = async () => {
    try {
      // A job a bridge took but never answered goes back in the queue once.
      await pool.query("update chat_jobs set status = 'queued', taken_at = null where status = 'taken' and taken_at < now() - interval '3 minutes' and created_at > now() - interval '10 minutes'");
      const { rows } = await pool.query(
        `update chat_jobs set status = 'failed' where status in ('queued', 'taken') and created_at < now() - make_interval(mins => $1) returning *`, [JOB_TTL_MIN]);
      for (const job of rows) {
        const asker = await whoIs(job.user_id).catch(() => null);
        if (!asker) continue;
        await addMessage({ room: job.room, me: asker, ai: true, replyTo: job.message_id, text: 'ขอโทษครับ ตอนนั้นผู้ช่วยออฟไลน์อยู่ (Mac ปิดหรือหลับ) เลยตอบไม่ทัน ถามใหม่ได้เลยครับ' });
      }
      if (rows.length) wakeBridges();
    } catch (e) { console.error('chat jobs', e.message); }
  };
  setInterval(tick, Number(process.env.CHAT_TICK_MS) || 60000).unref();
}

export default router;
