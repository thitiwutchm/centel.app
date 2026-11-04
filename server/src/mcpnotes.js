import crypto from 'node:crypto';
import { thaiToday, remindAt, parseNote } from './noteparse.js';
import { fail, isDate, hhmm, addDays, noteView, notesList } from './mcpcore.js';
import { audit, snapshot } from './mcpwrite.js';

/* MCP tools for notes (memos: a title, content and tags) and to-dos (title, description,
   status, priority, date / time, reminder, repeat, tags). Both live in the notes table
   (kind 'memo' / 'todo'), so the app, the LINE group, the calendar feed and the reminder
   job see them like notes made in the app. Writing needs the centel.notes scope. */

const SCOPE = 'centel.notes';
const REMIND_LIST = [0, 60, 120, 180, 360, 1440, 2880, 4320];
const PRIORITIES = ['low', 'medium', 'high'];
const RECUR = ['daily', 'weekly', 'monthly', 'yearly'];
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isId = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

const idemArg = { type: 'string', description: 'Optional key (8–200 chars) unique to this request, e.g. a UUID. Sending the same request again with the same key returns the first result and creates nothing new.' };
const confirmArg = { type: 'string', description: 'Only after the user confirmed the preview: the confirm_token from the previous answer.' };
const tagsArg = { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Tags, e.g. ["บ้าน", "ภาษี"].' };

function cleanTags(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) fail('tags must be a list of words');
  const out = [...new Set(v.map((t) => String(t).trim().replace(/^#/, '').slice(0, 30)).filter(Boolean))];
  if (out.length > 10) fail('At most 10 tags');
  return out;
}
const cleanText = (v, max, what) => {
  const s = String(v ?? '').trim();
  if (s.length > max) fail(`${what} is too long (max ${max} characters)`);
  return s;
};

// The next date of a repeating to-do after `ds`.
export function nextOccurrence(ds, rule) {
  if (rule === 'daily') return addDays(ds, 1);
  if (rule === 'weekly') return addDays(ds, 7);
  const [y, m, d] = ds.split('-').map(Number);
  const months = rule === 'yearly' ? 12 : 1;
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

// To-do fields from tool arguments over the current row ({} for a new one), checked the
// way PUT /api/notes checks them. `when` is a Thai or English phrase ("พรุ่งนี้ 10 โมง",
// "วันศุกร์หน้า") read in Bangkok time, as in the app's quick add and the LINE group.
function todoInput(a, cur, isNew) {
  const has = (k) => a[k] !== undefined;
  let title = has('title') ? cleanText(a.title, 500, 'title') : cur.text || '';
  let date = has('date') ? a.date : has('due_date') ? a.due_date : cur.date ?? null;
  let time = has('time') ? a.time : hhmm(cur.time);
  if (a.when != null) {
    const p = parseNote(String(a.when));
    if (!p.date) fail(`Could not read a date from "${a.when}". Pass date as YYYY-MM-DD instead.`);
    date = p.date;
    if (p.time) time = p.time;
  }
  if (isNew && !title) fail('title is required');
  if (!title) fail('title cannot be empty');
  if (date != null && date !== '' && !isDate(date)) fail('date must be YYYY-MM-DD (Gregorian; พ.ศ. minus 543)');
  date = date || null;
  time = date ? hhmm(time) : null;
  if (time != null && !isTime(time)) fail('time must be HH:MM (24-hour)');
  let endDate = date ? (has('end_date') ? a.end_date : cur.end_date ?? null) : null;
  if (endDate != null && (!isDate(endDate) || endDate <= date)) fail('end_date must be a later YYYY-MM-DD than date');
  let endTime = time ? (has('end_time') ? hhmm(a.end_time) : hhmm(cur.end_time)) : null;
  if (endTime != null && (!isTime(endTime) || (!endDate && endTime <= time))) fail('end_time must be HH:MM after time');
  let remind = has('remind_minutes_before') ? a.remind_minutes_before : cur.remind ?? null;
  if (remind != null && !REMIND_LIST.includes(remind)) fail(`remind_minutes_before must be one of ${REMIND_LIST.join(', ')}`);
  if (remind != null && !date) {
    if (a.remind_minutes_before != null) fail('A reminder needs a date');
    remind = null;
  }
  const at = remindAt(date, time, remind);
  if (at && a.remind_minutes_before != null && at < new Date()) fail(`That reminder time (${at.toISOString()}) has already passed`);
  const body = has('description') ? cleanText(a.description, 5000, 'description') || null : cur.body ?? null;
  const priority = has('priority') ? a.priority : cur.priority ?? null;
  if (priority != null && !PRIORITIES.includes(priority)) fail('priority must be low, medium or high');
  const recurrence = has('recurrence') ? a.recurrence : cur.recurrence ?? null;
  if (recurrence != null && !RECUR.includes(recurrence)) fail('recurrence must be daily, weekly, monthly or yearly');
  if (recurrence && !date) fail('A repeating to-do needs a date (its first due day)');
  const tags = has('tags') ? cleanTags(a.tags) : cur.tags || [];
  let inProgress = cur.in_progress || false;
  if (has('status')) {
    if (!['pending', 'in_progress'].includes(a.status)) fail('status here is pending or in_progress; use complete_todo / reopen_todo to finish or reopen');
    inProgress = a.status === 'in_progress';
  }
  return { title, body, date, time, endDate, endTime, remind, remindAt: at, priority, recurrence, tags, inProgress };
}

async function loadNote(db, id, kind) {
  if (!isId(id)) fail(`id must be a ${kind === 'memo' ? 'note' : 'to-do'} id (from list_${kind === 'memo' ? 'notes' : 'todos'} or search)`);
  const n = (await db.query('select * from notes where id = $1', [id])).rows[0];
  if (!n || (n.kind || 'todo') !== kind) fail(kind === 'memo' ? 'Note not found' : 'To-do not found');
  return n;
}

const searchHit = (q) => {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) fail('query is required');
  return (n) => {
    const hay = `${n.title} ${n.content || ''} ${n.description || ''} ${(n.tags || []).join(' ')} ${n.date || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
};

const done = (status, n, extra = {}) => ({ status, id: n.id, ...extra, [n.kind === 'memo' ? 'note' : 'todo']: noteView(n) });

export const NOTE_TOOLS = [
  /* ---------- To-dos ---------- */
  {
    name: 'list_todos',
    title: 'List to-dos',
    description: 'To-dos / appointments (สิ่งที่ต้องทำ, นัด) with status, priority, date/time, reminder and repeat. Use due="today" for "วันนี้มีอะไรต้องทำ", due="overdue" for "งานไหนเลยกำหนด". Dates are Asia/Bangkok.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'pending', 'in_progress', 'completed', 'all'], description: 'Default open (pending + in_progress).' },
        due: { type: 'string', enum: ['today', 'overdue', 'upcoming', 'this_week', 'no_date'] },
        from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' },
        tag: { type: 'string' }, priority: { type: 'string', enum: PRIORITIES },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    run: async (db, _ctx, a) => {
      if (a.from != null && !isDate(a.from)) fail('from must be YYYY-MM-DD');
      if (a.to != null && !isDate(a.to)) fail('to must be YYYY-MM-DD');
      const st = a.status || 'open';
      const t = thaiToday();
      let list = await notesList(db, { include_done: st === 'completed' || st === 'all', from: a.from, to: a.to });
      if (st === 'open') list = list.filter((n) => n.status !== 'completed');
      else if (st !== 'all') list = list.filter((n) => n.status === st);
      const week = addDays(t.date, 6);
      if (a.due === 'today') list = list.filter((n) => n.date && n.date <= t.date && (n.endDate || n.date) >= t.date);
      if (a.due === 'overdue') list = list.filter((n) => n.status !== 'completed' && n.date && n.date < t.date);
      if (a.due === 'upcoming') list = list.filter((n) => n.date && n.date > t.date);
      if (a.due === 'this_week') list = list.filter((n) => n.date && n.date >= t.date && n.date <= week);
      if (a.due === 'no_date') list = list.filter((n) => !n.date);
      if (a.tag) list = list.filter((n) => (n.tags || []).some((x) => x.toLowerCase() === String(a.tag).replace(/^#/, '').toLowerCase()));
      if (a.priority) list = list.filter((n) => n.priority === a.priority);
      if (st === 'completed') list.sort((x, y) => String(y.completedAt || '').localeCompare(String(x.completedAt || '')));
      const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 200);
      return { today: t.date, weekday: t.weekday, now: t.time, count: list.length, todos: list.slice(0, limit) };
    },
  },
  {
    name: 'get_todo',
    title: 'Get a to-do',
    description: 'One to-do with all its details.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: async (db, _ctx, a) => ({ todo: noteView(await loadNote(db, a.id, 'todo')) }),
  },
  {
    name: 'search_todos',
    title: 'Search to-dos',
    description: 'Find to-dos (open and completed) whose title, description or tags contain all the words.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, include_completed: { type: 'boolean', description: 'Default true.' } }, required: ['query'], additionalProperties: false },
    run: async (db, _ctx, a) => {
      const hit = searchHit(a.query);
      const list = (await notesList(db, { include_done: a.include_completed !== false })).filter(hit);
      return { count: list.length, todos: list.slice(0, 50) };
    },
  },
  {
    name: 'create_todo',
    title: 'Add a to-do',
    description: 'Add a to-do / appointment / reminder (สิ่งที่ต้องทำ, นัด, เตือน). Give date (YYYY-MM-DD, Bangkok) or a phrase in `when` such as "พรุ่งนี้ 10:00" or "วันศุกร์หน้า". With remind_minutes_before the user is reminded (LINE group, iPhone notification, in-app chat). recurrence makes it repeat (e.g. "จ่ายค่าเช่าวันที่ 5 ทุกเดือน" = date of the next 5th + monthly). If the same open to-do already exists on that day it is returned instead of adding another. Only tell the user it was added when status is "created".',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to do, short, without the date words. e.g. "โทรหาบัญชี"' },
        description: { type: 'string', description: 'Longer details.' },
        date: { type: 'string', description: 'Due day YYYY-MM-DD.' },
        when: { type: 'string', description: 'Instead of date/time: a Thai or English phrase, e.g. "พรุ่งนี้ 10 โมง", "วันศุกร์หน้า", "5 ธ.ค."' },
        time: { type: 'string', description: 'HH:MM 24-hour. Omit for all day.' },
        end_date: { type: 'string' }, end_time: { type: 'string' },
        remind_minutes_before: { type: 'integer', enum: REMIND_LIST, description: '0 = at the time (09:00 when no time), 60, 120, 180, 360, 1440 = a day, 2880, 4320 = 3 days before.' },
        priority: { type: 'string', enum: PRIORITIES },
        status: { type: 'string', enum: ['pending', 'in_progress'] },
        recurrence: { type: 'string', enum: RECUR },
        tags: tagsArg,
        shared: { type: 'boolean', description: 'Shared with the partner (both see it and get the reminder).' },
        allow_duplicate: { type: 'boolean', description: 'true only if the user really wants a second identical to-do.' },
        idempotency_key: idemArg,
      },
      required: ['title'],
      additionalProperties: false,
    },
    scope: SCOPE,
    run: async (db, _ctx, a, user) => {
      const x = todoInput(a, {}, true);
      if (!a.allow_duplicate) {
        const dup = (await db.query(
          `select * from notes where kind = 'todo' and not done and lower(text) = lower($1) and date is not distinct from $2 limit 1`, [x.title, x.date])).rows[0];
        if (dup) return done('already_exists', dup, { message: 'An identical open to-do already exists, so nothing new was added.' });
      }
      const row = (await db.query(
        `insert into notes (id, couple_id, kind, text, body, tags, priority, in_progress, recurrence, date, time, end_date, end_time, remind, remind_at)
         values ($1, case when $2 then my_couple() end, 'todo', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
        [crypto.randomUUID(), !!a.shared, x.title, x.body, x.tags, x.priority, x.inProgress, x.recurrence, x.date, x.time, x.endDate, x.endTime, x.remind, x.remindAt])).rows[0];
      const changeId = await audit(db, user, 'create_todo', 'note', row.id, 'create', null, await snapshot(db, 'note', row.id), `เพิ่มสิ่งที่ต้องทำ "${x.title}"`);
      return done('created', row, { changeId, ...(a.shared && !row.couple_id ? { warning: 'No partner linked, so it was saved as personal.' } : {}) });
    },
  },
  {
    name: 'update_todo',
    title: 'Change a to-do',
    description: 'Change a to-do: title, description, date/time (or `when` phrase), reminder, priority, repeat, tags, or status pending / in_progress. Only the fields given change; null clears date, time, reminder, priority or repeat.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' }, description: { type: ['string', 'null'] },
        date: { type: ['string', 'null'] }, when: { type: 'string' }, time: { type: ['string', 'null'] },
        end_date: { type: ['string', 'null'] }, end_time: { type: ['string', 'null'] },
        remind_minutes_before: { type: ['integer', 'null'], enum: [...REMIND_LIST, null] },
        priority: { type: ['string', 'null'], enum: [...PRIORITIES, null] },
        recurrence: { type: ['string', 'null'], enum: [...RECUR, null] },
        status: { type: 'string', enum: ['pending', 'in_progress'] },
        tags: tagsArg,
        idempotency_key: idemArg,
      },
      required: ['id'],
      additionalProperties: false,
    },
    scope: SCOPE,
    run: async (db, _ctx, a, user) => {
      const cur = await loadNote(db, a.id, 'todo');
      const before = await snapshot(db, 'note', a.id);
      const x = todoInput(a, cur, false);
      const row = (await db.query(
        `update notes set text = $2, body = $3, tags = $4, priority = $5, in_progress = $6, recurrence = $7, date = $8, time = $9,
           end_date = $10, end_time = $11, remind = $12, remind_at = $13,
           notified_at = case when remind_at is not distinct from $13 then notified_at end, updated_at = now()
         where id = $1 returning *`,
        [a.id, x.title, x.body, x.tags, x.priority, x.inProgress, x.recurrence, x.date, x.time, x.endDate, x.endTime, x.remind, x.remindAt])).rows[0];
      if (!row) fail('This to-do cannot be changed');
      const changeId = await audit(db, user, 'update_todo', 'note', row.id, 'update', before, await snapshot(db, 'note', row.id), `แก้สิ่งที่ต้องทำ "${row.text}"`);
      return done('updated', row, { changeId });
    },
  },
  {
    name: 'complete_todo',
    title: 'Tick off a to-do',
    description: 'Mark a to-do done (ทำเสร็จแล้ว). A repeating to-do moves to its next date instead and stays open.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, idempotency_key: idemArg }, required: ['id'], additionalProperties: false },
    scope: SCOPE,
    run: async (db, _ctx, a, user) => {
      const cur = await loadNote(db, a.id, 'todo');
      if (cur.done) return done('already_completed', cur);
      const before = await snapshot(db, 'note', a.id);
      let row;
      if (cur.recurrence && cur.date) {
        const today = thaiToday().date;
        let next = nextOccurrence(cur.date, cur.recurrence);
        while (next < today) next = nextOccurrence(next, cur.recurrence);
        const shift = (d) => (d ? addDays(next, Math.round((Date.parse(d) - Date.parse(cur.date)) / 86400000)) : null);
        const at = remindAt(next, hhmm(cur.time), cur.remind);
        row = (await db.query(
          `update notes set date = $2, end_date = $3, remind_at = $4, notified_at = null, in_progress = false, updated_at = now()
           where id = $1 returning *`, [a.id, next, shift(cur.end_date), at])).rows[0];
        const changeId = await audit(db, user, 'complete_todo', 'note', a.id, 'update', before, await snapshot(db, 'note', a.id), `ทำเสร็จ "${cur.text}" (ครั้งถัดไป ${next})`);
        return done('rescheduled', row, { changeId, nextDate: next, message: `Done for ${cur.date}; it repeats ${cur.recurrence}, so it is now due ${next}.` });
      }
      row = (await db.query(
        `update notes set done = true, done_at = now(), done_by = app_uid(), in_progress = false, updated_at = now() where id = $1 returning *`, [a.id])).rows[0];
      const changeId = await audit(db, user, 'complete_todo', 'note', a.id, 'update', before, await snapshot(db, 'note', a.id), `ทำเสร็จ "${cur.text}"`);
      return done('completed', row, { changeId });
    },
  },
  {
    name: 'reopen_todo',
    title: 'Reopen a to-do',
    description: 'Mark a completed to-do as not done again.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, idempotency_key: idemArg }, required: ['id'], additionalProperties: false },
    scope: SCOPE,
    run: async (db, _ctx, a, user) => {
      const cur = await loadNote(db, a.id, 'todo');
      if (!cur.done) return done('already_open', cur);
      const before = await snapshot(db, 'note', a.id);
      const row = (await db.query(
        `update notes set done = false, done_at = null, done_by = null, updated_at = now() where id = $1 returning *`, [a.id])).rows[0];
      const changeId = await audit(db, user, 'reopen_todo', 'note', a.id, 'update', before, await snapshot(db, 'note', a.id), `เปิด "${cur.text}" อีกครั้ง`);
      return done('reopened', row, { changeId });
    },
  },
  {
    name: 'delete_todo',
    title: 'Delete a to-do',
    description: 'Delete a to-do. Needs the user\'s confirmation: the first call returns a preview and confirm_token; call again with confirm_token after the user says yes. Only the person who made it can delete it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, confirm_token: confirmArg }, required: ['id'], additionalProperties: false },
    scope: SCOPE,
    destructive: true,
    confirm: async (db, _ctx, a) => ({ action: 'delete', todo: noteView(await loadNote(db, a.id, 'todo')) }),
    run: async (db, _ctx, a, user) => deleteNote(db, a, user, 'todo'),
  },

  /* ---------- Notes (memos) ---------- */
  {
    name: 'list_notes',
    title: 'List notes',
    description: 'Free-form notes / memos (โน้ต): title, content and tags, newest first. To-dos are in list_todos.',
    inputSchema: { type: 'object', properties: { tag: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
    run: async (db, _ctx, a) => {
      let list = await notesList(db, { kind: 'memo' });
      if (a.tag) list = list.filter((n) => (n.tags || []).some((x) => x.toLowerCase() === String(a.tag).replace(/^#/, '').toLowerCase()));
      const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 200);
      return { count: list.length, notes: list.slice(0, limit).map((n) => ({ ...n, content: n.content.length > 300 ? `${n.content.slice(0, 300)}…` : n.content })) };
    },
  },
  {
    name: 'get_note',
    title: 'Read a note',
    description: 'One note with its full content.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: async (db, _ctx, a) => ({ note: noteView(await loadNote(db, a.id, 'memo')) }),
  },
  {
    name: 'search_notes',
    title: 'Search notes',
    description: 'Find notes whose title, content or tags contain all the words (e.g. "ค่าใช้จ่าย บ้าน").',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run: async (db, _ctx, a) => {
      const list = (await notesList(db, { kind: 'memo' })).filter(searchHit(a.query));
      return { count: list.length, notes: list.slice(0, 50) };
    },
  },
  {
    name: 'create_note',
    title: 'Write a note',
    description: 'Save a free-form note (จดโน้ต): a title and content, e.g. meeting notes. For something to do on a date use create_todo. Only tell the user it was saved when status is "created".',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "คุยกับบัญชีเรื่องภาษี"' },
        content: { type: 'string', description: 'The note itself (plain text, up to 20,000 characters).' },
        tags: tagsArg,
        shared: { type: 'boolean', description: 'Shared with the partner.' },
        idempotency_key: idemArg,
      },
      required: ['title'],
      additionalProperties: false,
    },
    scope: SCOPE,
    run: async (db, _ctx, a, user) => {
      const title = cleanText(a.title, 500, 'title');
      if (!title) fail('title is required');
      const content = cleanText(a.content, 20000, 'content');
      const row = (await db.query(
        `insert into notes (id, couple_id, kind, text, body, tags) values ($1, case when $2 then my_couple() end, 'memo', $3, $4, $5) returning *`,
        [crypto.randomUUID(), !!a.shared, title, content || null, cleanTags(a.tags)])).rows[0];
      const changeId = await audit(db, user, 'create_note', 'note', row.id, 'create', null, await snapshot(db, 'note', row.id), `จดโน้ต "${title}"`);
      return done('created', row, { changeId });
    },
  },
  {
    name: 'update_note',
    title: 'Edit a note',
    description: 'Change a note\'s title, replace its content, add text to the end (append), or change tags.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string', description: 'Replaces the whole content.' },
        append: { type: 'string', description: 'Added on a new line at the end of the content.' },
        tags: tagsArg,
        idempotency_key: idemArg,
      },
      required: ['id'],
      additionalProperties: false,
    },
    scope: SCOPE,
    run: async (db, _ctx, a, user) => {
      const cur = await loadNote(db, a.id, 'memo');
      if (a.content !== undefined && a.append !== undefined) fail('Give content or append, not both');
      const before = await snapshot(db, 'note', a.id);
      const title = a.title !== undefined ? cleanText(a.title, 500, 'title') : cur.text;
      if (!title) fail('title cannot be empty');
      let content = cur.body || '';
      if (a.content !== undefined) content = cleanText(a.content, 20000, 'content');
      if (a.append !== undefined) content = cleanText(`${content}${content ? '\n' : ''}${String(a.append).trim()}`, 20000, 'content');
      const tags = a.tags !== undefined ? cleanTags(a.tags) : cur.tags || [];
      const row = (await db.query('update notes set text = $2, body = $3, tags = $4, updated_at = now() where id = $1 returning *',
        [a.id, title, content || null, tags])).rows[0];
      if (!row) fail('This note cannot be changed');
      const changeId = await audit(db, user, 'update_note', 'note', a.id, 'update', before, await snapshot(db, 'note', a.id), `แก้โน้ต "${title}"`);
      return done('updated', row, { changeId });
    },
  },
  {
    name: 'delete_note',
    title: 'Delete a note',
    description: 'Delete a note. Needs the user\'s confirmation: the first call returns a preview and confirm_token; call again with confirm_token after the user says yes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, confirm_token: confirmArg }, required: ['id'], additionalProperties: false },
    scope: SCOPE,
    destructive: true,
    confirm: async (db, _ctx, a) => ({ action: 'delete', note: noteView(await loadNote(db, a.id, 'memo')) }),
    run: async (db, _ctx, a, user) => deleteNote(db, a, user, 'memo'),
  },
];

async function deleteNote(db, a, user, kind) {
  const cur = await loadNote(db, a.id, kind);
  const before = await snapshot(db, 'note', a.id);
  const r = await db.query('delete from notes where id = $1', [a.id]);
  if (!r.rowCount) fail(`Only the person who made this ${kind === 'memo' ? 'note' : 'to-do'} can delete it.`);
  const changeId = await audit(db, user, kind === 'memo' ? 'delete_note' : 'delete_todo', 'note', a.id, 'delete', before, null,
    `ลบ${kind === 'memo' ? 'โน้ต' : 'สิ่งที่ต้องทำ'} "${cur.text}"`);
  return { status: 'deleted', id: a.id, changeId, title: cur.text, undo: 'undo_change can bring it back.' };
}
