// In-app chat: the couple room, the private assistant room, note commands, and the Mac
// bridge (token, long poll, answer with a note). Needs a running API (API_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');

function agent() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(API + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-centel': '1', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  call.cookie = () => cookie;
  return call;
}

const A = agent();
const B = agent();
const C = agent();
const send = (who, room, text, extra = {}) => who('POST', '/chat/messages', { id: crypto.randomUUID(), room, text, ...extra });
const bridge = async (token, method, path, body) => {
  const res = await fetch(API + '/api/bridge' + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-bridge-info': 'test-mac · hermes-agent' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
};

test('chat: setup a couple and an outsider', async () => {
  assert.equal((await A('GET', '/chat/state')).status, 401);
  await A('POST', '/auth/register', { email: `ca${run}@t.dev`, password: 'password-a', name: 'Book', nickname: 'พ่อบุ๊ค' });
  await B('POST', '/auth/register', { email: `cb${run}@t.dev`, password: 'password-b', name: 'Fern', nickname: 'แม่เฟิร์น' });
  await C('POST', '/auth/register', { email: `cc${run}@t.dev`, password: 'password-c', name: 'C', nickname: 'C' });
  const { code } = await A('POST', '/couple/invite');
  assert.equal((await B('POST', '/couple/join', { code })).ok, true);
});

test('chat: the couple room is shared, private to the two, with unread and read marks', async () => {
  const st0 = await A('GET', '/chat/state');
  assert.deepEqual(Object.keys(st0.rooms).sort(), ['ai', 'couple']);
  assert.equal((await C('GET', '/chat/state')).rooms.couple, undefined);
  assert.equal((await send(C, 'couple', 'hi')).status, 409);

  const r = await send(A, 'couple', 'พรุ่งนี้ไปลำพูนกี่โมง');
  assert.equal(r.status, 200);
  assert.equal(r.message.senderId, (await A('GET', '/bootstrap')).user.id);
  assert.equal(r.assistant, null);
  const page = await B('GET', '/chat/messages?room=couple');
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].text, 'พรุ่งนี้ไปลำพูนกี่โมง');
  assert.equal((await B('GET', '/chat/state')).rooms.couple.unread, 1);
  assert.equal((await A('GET', '/chat/state')).rooms.couple.unread, 0);
  assert.equal((await C('GET', '/chat/messages?room=couple')).status, 409);

  await B('POST', '/chat/read', { room: 'couple' });
  assert.equal((await B('GET', '/chat/state')).rooms.couple.unread, 0);
  assert.ok((await A('GET', '/chat/messages?room=couple')).reads.partner);

  // Sending the same id twice keeps one message.
  const id = crypto.randomUUID();
  await A('POST', '/chat/messages', { id, room: 'couple', text: 'once' });
  await A('POST', '/chat/messages', { id, room: 'couple', text: 'once' });
  assert.equal((await A('GET', '/chat/messages?room=couple')).messages.filter((m) => m.id === id).length, 1);
  assert.equal((await B('POST', '/chat/messages', { id, room: 'couple', text: 'steal' })).status, 409);
  assert.equal((await send(A, 'couple', '   ')).status, 400);
  assert.equal((await send(A, 'nope', 'x')).status, 400);
});

test('chat: the couple can rename their room', async () => {
  assert.equal((await A('GET', '/chat/state')).rooms.couple.name, null);
  assert.equal((await A('PUT', '/chat/room', { name: '  บ้าน  ลำพูน ' })).name, 'บ้าน ลำพูน');
  assert.equal((await B('GET', '/chat/state')).rooms.couple.name, 'บ้าน ลำพูน');
  assert.equal((await C('PUT', '/chat/room', { name: 'x' })).status, 409);
  assert.equal((await B('PUT', '/chat/room', { name: '' })).name, null);
  assert.equal((await A('GET', '/chat/state')).rooms.couple.name, null);
});

test('chat: the app reports whether it is on screen', async () => {
  assert.equal((await A('POST', '/chat/view', { visible: true })).ok, true);
  assert.equal((await A('POST', '/chat/view', { visible: false })).ok, true);
});

test('chat: edit, delete and reactions', async () => {
  const { message: m } = await send(A, 'couple', 'ซื้อนม');
  assert.equal((await B('PUT', `/chat/messages/${m.id}`, { text: 'evil' })).status, 403);
  assert.equal((await C('PUT', `/chat/messages/${m.id}`, { text: 'evil' })).status, 404);
  const e = await A('PUT', `/chat/messages/${m.id}`, { text: 'ซื้อนม 2 กล่อง' });
  assert.equal(e.message.text, 'ซื้อนม 2 กล่อง');
  assert.ok(e.message.editedAt);

  const r1 = await B('POST', `/chat/messages/${m.id}/react`, { emoji: '❤️' });
  assert.deepEqual(Object.values(r1.message.reactions), ['❤️']);
  const r2 = await B('POST', `/chat/messages/${m.id}/react`, { emoji: '❤️' });
  assert.deepEqual(r2.message.reactions, {});
  assert.equal((await B('POST', `/chat/messages/${m.id}/react`, { emoji: '💩' })).status, 400);

  assert.equal((await B('DELETE', `/chat/messages/${m.id}`)).status, 403);
  const d = await A('DELETE', `/chat/messages/${m.id}`);
  assert.equal(d.message.deleted, true);
  assert.equal(d.message.text, '');
});

test('chat: a ทำนัด line becomes a shared note at once', async () => {
  const r = await send(A, 'couple', '@ผู้ช่วย ทำนัด 15 ม.ค. 2570 08:00 ไปเยี่ยมแม่ ลำพูน เตือนก่อน 2 ชม.');
  assert.ok(r.assistant, 'assistant answered');
  assert.equal(r.assistant.ai, true);
  assert.match(r.assistant.text, /ทำนัดให้ พ่อบุ๊ค/);
  assert.equal(r.assistant.action.type, 'note');
  assert.equal(r.assistant.action.note.date, '2027-01-15');
  assert.equal(r.assistant.action.note.time, '08:00');
  assert.equal(r.assistant.action.note.remind, 120);
  assert.equal(r.assistant.action.note.shared, true);
  const notes = (await B('GET', '/bootstrap')).notes;
  assert.ok(notes.some((n) => n.id === r.assistant.action.note.id));
});

test('chat: a due reminder lands in the couple room', async () => {
  // Five minutes ago in Bangkok, so the next reminder tick sends it.
  const t = new Date(Date.now() + 7 * 3600e3 - 5 * 60e3);
  const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const date = `${t.getUTCDate()}/${t.getUTCMonth() + 1}/${t.getUTCFullYear()}`;
  const r = await send(B, 'couple', `ทำนัด ${date} ${hhmm} รับลูกที่โรงเรียน เตือนตรงเวลา`);
  assert.equal(r.assistant.action.note.remind, 0);
  let hit;
  for (let i = 0; i < 40 && !hit; i++) {
    await new Promise((res) => setTimeout(res, 250));
    hit = (await A('GET', '/chat/messages?room=couple')).messages.find((m) => m.ai && /^🔔 ถึงเวลาแล้ว/.test(m.text));
  }
  assert.ok(hit, 'reminder posted');
  assert.match(hit.text, /@พ่อบุ๊ค|@แม่เฟิร์น/);
  assert.equal(hit.action.note.text, 'รับลูกที่โรงเรียน');
});

let token;
test('chat: the bridge token is shown once and checked', async () => {
  assert.equal((await A('GET', '/chat/bridge')).set, false);
  const t = await A('POST', '/chat/bridge');
  assert.match(t.token, /^cb_[A-Za-z0-9_-]{32}$/);
  token = t.token;
  assert.equal((await bridge('cb_' + 'x'.repeat(32), 'GET', '/next?wait=0')).status, 401);
  assert.equal((await bridge(token, 'GET', '/next?wait=0')).status, 204);
  const st = await B('GET', '/chat/bridge');
  assert.equal(st.online, true);
  assert.equal(st.mine, null);
  assert.equal((await A('GET', '/chat/bridge')).mine.info, 'test-mac · hermes-agent');
});

test('chat: questions go to the Mac and the answer comes back, with a note', async () => {
  const q = await send(B, 'ai', 'งบอาหารเหลือเท่าไหร่', { context: { bills: [{ name: 'ค่าไฟ PEA', amount: 1382, due: '2026-11-05', paid: false }] } });
  assert.equal(q.assistant, null);
  assert.equal((await B('GET', '/chat/state')).rooms.ai.pending, 'queued');
  // A plain couple message does not call the assistant.
  await send(A, 'couple', 'กินข้าวยัง');
  const job = await bridge(token, 'GET', '/next?wait=2');
  assert.equal(job.status, 200);
  assert.equal(job.messages[0].role, 'system');
  assert.match(job.messages[0].content, /ค่าไฟ PEA: 1,382 บาท/);
  assert.match(job.messages[0].content, /แม่เฟิร์น/);
  assert.equal(job.messages.at(-1).role, 'user');
  assert.equal(job.messages.at(-1).content, 'งบอาหารเหลือเท่าไหร่');
  assert.equal((await B('GET', '/chat/state')).rooms.ai.pending, 'typing');
  // Nothing else is waiting.
  assert.equal((await bridge(token, 'GET', '/next?wait=0')).status, 204);

  const ans = await bridge(token, 'POST', `/jobs/${job.id}`, {
    reply: '<think>hmm</think>ยังไม่ได้ตั้งงบอาหารครับ จดไว้ให้แล้ว\n<centel-note>{"text": "ตั้งงบอาหาร", "date": "2027-02-01", "time": "09:00", "remind": 1440}</centel-note>',
  });
  assert.equal(ans.ok, true);
  assert.equal(ans.message.text, 'ยังไม่ได้ตั้งงบอาหารครับ จดไว้ให้แล้ว');
  assert.equal(ans.message.action.note.text, 'ตั้งงบอาหาร');
  assert.equal(ans.message.action.note.remind, 1440);
  const page = await B('GET', '/chat/messages?room=ai');
  assert.equal(page.messages.length, 2);
  assert.equal(page.pending, null);
  // The private room is not the partner's.
  assert.equal((await A('GET', '/chat/messages?room=ai')).messages.length, 0);
  assert.equal((await bridge(token, 'POST', `/jobs/${job.id}`, { reply: 'again' })).status, 404);

  // A bare @ผู้ช่วย followed by the question still asks.
  await send(A, 'couple', '@ผู้ช่วย');
  assert.equal((await bridge(token, 'GET', '/next?wait=0')).status, 204);
  await send(A, 'couple', 'สวัสดีครับ');
  const j0 = await bridge(token, 'GET', '/next?wait=2');
  assert.equal(j0.status, 200);
  assert.match(j0.messages.at(-1).content, /สวัสดีครับ/);
  await bridge(token, 'POST', `/jobs/${j0.id}`, { reply: 'สวัสดีครับ' });

  // In the couple room: @ผู้ช่วย asks, and a failed answer says so.
  await send(A, 'couple', '@ผู้ช่วย สรุปรายจ่ายเดือนนี้');
  const j2 = await bridge(token, 'GET', '/next?wait=2');
  assert.match(j2.messages.at(-1).content, /^พ่อบุ๊ค: @ผู้ช่วย สรุปรายจ่ายเดือนนี้/);
  await bridge(token, 'POST', `/jobs/${j2.id}`, { error: 'connection refused' });
  const last = (await B('GET', '/chat/messages?room=couple')).messages.at(-1);
  assert.equal(last.ai, true);
  assert.match(last.text, /ตอบไม่ได้/);
});

test('chat: a long poll wakes when a question arrives, and the stream delivers events', async () => {
  const ac = new AbortController();
  const events = [];
  const stream = fetch(API + '/api/chat/stream', { headers: { cookie: B.cookie() }, signal: ac.signal }).then(async (res) => {
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      for (const m of buf.matchAll(/^data: (.+)$/gm)) events.push(JSON.parse(m[1]));
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    }
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const poll = bridge(token, 'GET', '/next?wait=10');
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await send(A, 'couple', '@ผู้ช่วย บิลที่ยังไม่จ่าย');
  const job = await poll;
  assert.equal(job.status, 200);
  assert.ok(Date.now() - t0 < 3000, 'woke up quickly');
  await bridge(token, 'POST', `/jobs/${job.id}`, { reply: 'ไม่มีบิลค้างครับ' });
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  await stream;
  assert.ok(events.some((e) => e.type === 'msg' && e.msg.text === '@ผู้ช่วย บิลที่ยังไม่จ่าย'));
  assert.ok(events.some((e) => e.type === 'ai' && e.state === 'typing'));
  assert.ok(events.some((e) => e.type === 'msg' && e.msg.ai && e.msg.text === 'ไม่มีบิลค้างครับ'));
});

test('chat: a spoken question is heard on the Mac, then answered', async () => {
  const id = crypto.randomUUID();
  const audio = crypto.randomBytes(4000).toString('base64');
  assert.equal((await B('POST', '/chat/voice', { id, room: 'ai', audio: 'abc', mime: 'audio/mp4' })).status, 400);
  const v = await B('POST', '/chat/voice', { id, room: 'ai', audio, mime: 'audio/mp4' });
  assert.equal(v.ok, true);
  assert.equal((await B('GET', '/chat/state')).rooms.ai.pending, 'listening');
  // A bridge that cannot transcribe does not get it.
  assert.equal((await bridge(token, 'GET', '/next?wait=0')).status, 204);
  const res = await fetch(API + '/api/bridge/next?wait=2', { headers: { authorization: `Bearer ${token}`, 'x-bridge-caps': 'stt' } });
  const job = await res.json();
  assert.equal(job.kind, 'transcribe');
  assert.equal(job.audio, audio);
  const done = await bridge(token, 'POST', `/jobs/${job.id}`, { text: '  งบอาหารเหลือ   เท่าไหร่ ' });
  assert.equal(done.message.id, id);
  assert.equal(done.message.text, 'งบอาหารเหลือ เท่าไหร่');
  assert.equal(done.message.action.type, 'voice');
  const reply = await bridge(token, 'GET', '/next?wait=2');
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.messages.at(-1).content, 'งบอาหารเหลือ เท่าไหร่');
  await bridge(token, 'POST', `/jobs/${reply.id}`, { reply: 'ยังไม่ได้ตั้งงบครับ' });
  // Nothing heard: the room is told.
  await B('POST', '/chat/voice', { id: crypto.randomUUID(), room: 'ai', audio, mime: 'audio/webm' });
  const j2 = await (await fetch(API + '/api/bridge/next?wait=2', { headers: { authorization: `Bearer ${token}`, 'x-bridge-caps': 'stt' } })).json();
  await bridge(token, 'POST', `/jobs/${j2.id}`, { text: '' });
  assert.match((await B('GET', '/chat/messages?room=ai')).messages.at(-1).text, /ฟังไม่ชัด/);
});

test('chat: revoking the token stops the bridge', async () => {
  await A('DELETE', '/chat/bridge');
  assert.equal((await bridge(token, 'GET', '/next?wait=0')).status, 401);
  assert.equal((await A('GET', '/chat/bridge')).set, false);
});
