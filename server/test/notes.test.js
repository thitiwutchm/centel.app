// To-do notes: own notes, sharing with the partner, and the reminder bookkeeping.
// Needs a running API (API_URL) like prd.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');

function agent() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(API + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-centel': '1', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}

const A = agent();
const B = agent();
const C = agent();
const id1 = crypto.randomUUID();
const id2 = crypto.randomUUID();
const notes = async (who) => (await who('GET', '/bootstrap')).notes;

test('notes: setup a couple and an outsider', async () => {
  assert.equal((await A('PUT', `/notes/${id1}`, { text: 'x' })).status, 401);
  await A('POST', '/auth/register', { email: `na${run}@t.dev`, password: 'password-a', name: 'A', nickname: 'A' });
  await B('POST', '/auth/register', { email: `nb${run}@t.dev`, password: 'password-b', name: 'B', nickname: 'B' });
  await C('POST', '/auth/register', { email: `nc${run}@t.dev`, password: 'password-c', name: 'C', nickname: 'C' });
  const { code } = await A('POST', '/couple/invite');
  assert.equal((await B('POST', '/couple/join', { code })).ok, true);
});

test('notes: a private note is only the owner\'s', async () => {
  const r = await A('PUT', `/notes/${id1}`, { text: ' ไปเยี่ยมแม่ ลำพูน ', date: '2027-02-01', time: '09:30', remind: 1440, remindAt: '2027-01-31T02:30:00.000Z' });
  assert.equal(r.status, 200);
  assert.equal(r.note.text, 'ไปเยี่ยมแม่ ลำพูน');
  assert.equal(r.note.date, '2027-02-01');
  assert.equal(r.note.time, '09:30');
  assert.equal(r.note.remind, 1440);
  assert.equal(r.note.shared, false);
  assert.equal((await notes(A)).length, 1);
  assert.equal((await notes(B)).length, 0);
  assert.equal((await A('PUT', `/notes/${id1}`, { text: '' })).status, 400);
  assert.equal((await A('PUT', '/notes/not-a-uuid', { text: 'x' })).status, 400);
  // Someone else's id is not theirs to overwrite.
  assert.notEqual((await C('PUT', `/notes/${id1}`, { text: 'evil' })).status, 200);
  assert.equal((await notes(A))[0].text, 'ไปเยี่ยมแม่ ลำพูน');
});

test('notes: a reminder needs a date, and an unknown reminder is dropped', async () => {
  const r = await A('PUT', `/notes/${id2}`, { text: 'ซื้อนม', time: '10:00', remind: 60, remindAt: '2027-01-01T00:00:00Z' });
  assert.equal(r.note.date, '');
  assert.equal(r.note.time, '');
  assert.equal(r.note.remind, null);
  assert.equal(r.note.remindAt, null);
  assert.equal((await A('PUT', `/notes/${id2}`, { text: 'ซื้อนม', date: '2027-01-01', remind: 7 })).note.remind, null);
});

test('notes: a note keeps its end, and an end before the start is dropped', async () => {
  const id = crypto.randomUUID();
  let n = (await A('PUT', `/notes/${id}`, { text: 'ประชุม', date: '2026-11-30', time: '11:00', endTime: '12:00' })).note;
  assert.deepEqual([n.endDate, n.endTime], ['', '12:00']);
  n = (await A('PUT', `/notes/${id}`, { text: 'ประชุม', date: '2026-11-30', time: '11:00', endTime: '10:00' })).note;
  assert.equal(n.endTime, '');
  n = (await A('PUT', `/notes/${id}`, { text: 'ทริป', date: '2026-11-30', time: '', endDate: '2026-12-02', endTime: '10:00' })).note;
  assert.deepEqual([n.endDate, n.endTime], ['2026-12-02', '']);
  n = (await A('PUT', `/notes/${id}`, { text: 'ทริป', date: '2026-11-30', endDate: '2026-11-01' })).note;
  assert.equal(n.endDate, '');
});

test('notes: a shared note is seen and ticked by the partner, but only the owner deletes it', async () => {
  await A('PUT', `/notes/${id1}`, { text: 'ไปเยี่ยมแม่ ลำพูน', date: '2027-02-01', remind: 0, remindAt: '2027-02-01T02:00:00Z', shared: true });
  const seen = (await notes(B)).find((n) => n.id === id1);
  assert.equal(seen.shared, true);
  assert.equal((await notes(C)).length, 0);
  // B ticks it off and cannot unshare it.
  const r = await B('PUT', `/notes/${id1}`, { text: seen.text, date: seen.date, remind: 0, remindAt: '2027-02-01T02:00:00Z', shared: false, done: true });
  assert.equal(r.note.done, true);
  assert.equal(r.note.shared, true);
  assert.ok(r.note.doneAt);
  await B('DELETE', `/notes/${id1}`);
  assert.ok((await notes(A)).some((n) => n.id === id1 && n.done));
  assert.equal((await A('DELETE', `/notes/${id1}`)).ok, true);
  assert.equal((await notes(B)).length, 0);
});

test('notes: the LINE group for reminders is set, switched off and removed in Account', async () => {
  const gid = 'C' + crypto.randomBytes(16).toString('hex');
  assert.equal((await A('GET', '/bootstrap')).line, null);
  assert.equal((await A('PUT', '/line', { groupId: 'not-an-id' })).status, 400);
  assert.deepEqual((await A('PUT', '/line', { groupId: gid })).line, { groupId: gid, active: true });
  assert.deepEqual((await A('PUT', '/line', { groupId: gid, active: false })).line, { groupId: gid, active: false });
  assert.deepEqual((await A('GET', '/bootstrap')).line, { groupId: gid, active: false });
  assert.equal((await B('GET', '/bootstrap')).line, null);
  assert.equal((await A('PUT', '/line', { groupId: '' })).line, null);
  assert.equal((await A('GET', '/bootstrap')).line, null);
});
