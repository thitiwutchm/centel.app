// LINE OA reminders: webhook signature + Group ID reply, test message, and due notes
// sent once to the owner's and the partner's groups. Needs the API started with
//   LINE_API_URL=http://localhost:3998 LINE_CHANNEL_SECRET=test-secret
//   LINE_CHANNEL_ACCESS_TOKEN=test-token LINE_TICK_MS=500
// (a stand-in LINE runs on :3998 inside this test). Skipped when the API has no LINE.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');
const sent = [];
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    sent.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.parse(b || '{}').to === 'C' + '0'.repeat(32) ? (res.statusCode = 400, '{"message":"bad"}') : '{}');
  });
});

function agent() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(API + '/api' + path, {
      method, headers: { 'content-type': 'application/json', 'x-centel': '1', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const A = agent();
const B = agent();
const gA = 'C' + crypto.randomBytes(16).toString('hex');
const gB = 'C' + crypto.randomBytes(16).toString('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hook = (body, secret = 'test-secret') => {
  const raw = JSON.stringify(body);
  return fetch(API + '/api/line/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': crypto.createHmac('sha256', secret).update(raw).digest('base64') }, body: raw,
  });
};

let on = false;
test('line: setup', async () => {
  await new Promise((r) => mock.listen(3998, r));
  await A('POST', '/auth/register', { email: `la${run}@t.dev`, password: 'password-a', name: 'Anna', nickname: 'แอน' });
  await B('POST', '/auth/register', { email: `lb${run}@t.dev`, password: 'password-b', name: 'Ben', nickname: 'เบน' });
  const { code } = await A('POST', '/couple/invite');
  await B('POST', '/couple/join', { code });
  on = !!(await A('GET', '/bootstrap')).features.line;
});

test('line: the webhook checks the signature and answers a join with the Group ID', async (t) => {
  if (!on) return t.skip('API has no LINE');
  const ev = { events: [{ type: 'join', replyToken: 'rt1', source: { type: 'group', groupId: gA } }] };
  assert.equal((await hook(ev, 'wrong')).status, 401);
  assert.equal((await hook(ev)).status, 200);
  await wait(200);
  const r = sent.find((s) => s.path === '/reply' && s.body.replyToken === 'rt1');
  assert.ok(r);
  assert.equal(r.auth, 'Bearer test-token');
  assert.match(r.body.messages[0].text, new RegExp(gA));
});

test('line: test message goes to the saved group', async (t) => {
  if (!on) return t.skip('API has no LINE');
  assert.equal((await A('POST', '/line/test')).status, 404);
  await A('PUT', '/line', { groupId: gA });
  await B('PUT', '/line', { groupId: gB });
  assert.equal((await A('POST', '/line/test')).ok, true);
  assert.ok(sent.some((s) => s.path === '/push' && s.body.to === gA));
});

test('line: a due note is sent once, a shared one to both groups, a switched-off group gets nothing', async (t) => {
  if (!on) return t.skip('API has no LINE');
  const past = new Date(Date.now() - 60000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const mine = crypto.randomUUID(), shared = crypto.randomUUID(), later = crypto.randomUUID(), old = crypto.randomUUID();
  await A('PUT', `/notes/${mine}`, { text: 'จ่ายค่าน้ำ', date: today, time: '10:00', remind: 0, remindAt: past });
  await A('PUT', `/notes/${shared}`, { text: 'ไปเยี่ยมแม่ ลำพูน', date: today, remind: 1440, remindAt: past, shared: true });
  await A('PUT', `/notes/${later}`, { text: 'ยังไม่ถึง', date: '2099-01-01', remind: 0, remindAt: '2099-01-01T02:00:00Z' });
  await A('PUT', `/notes/${old}`, { text: 'เก่ามาก', date: '2020-01-01', remind: 0, remindAt: '2020-01-01T02:00:00Z' });
  await wait(1500);
  const pushes = (txt) => sent.filter((s) => s.path === '/push' && s.body.messages[0].text.includes(txt));
  assert.deepEqual(pushes('จ่ายค่าน้ำ').map((s) => s.body.to), [gA]);
  assert.match(pushes('จ่ายค่าน้ำ')[0].body.messages[0].text, /10:00 น\./);
  assert.deepEqual(pushes('ไปเยี่ยมแม่').map((s) => s.body.to).sort(), [gA, gB].sort());
  assert.match(pushes('ไปเยี่ยมแม่')[0].body.messages[0].text, /จาก แอน/);
  assert.equal(pushes('ยังไม่ถึง').length, 0);
  assert.equal(pushes('เก่ามาก').length, 0);
  const n = (await A('GET', '/bootstrap')).notes.find((x) => x.id === mine);
  assert.ok(n.notifiedAt);
  // A new reminder time is sent again, but not to a group that is switched off.
  await A('PUT', '/line', { groupId: gA, active: false });
  await A('PUT', `/notes/${mine}`, { text: 'จ่ายค่าน้ำ', date: today, time: '10:00', remind: 60, remindAt: new Date(Date.now() - 1000).toISOString() });
  await wait(1500);
  assert.equal(pushes('จ่ายค่าน้ำ').length, 1);
});

test('line: teardown', () => { mock.close(); });
