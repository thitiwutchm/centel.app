// Calendar subscription feed: token lifecycle and the public .ics URL.
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
const ics = (name) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:b1@centel.app\r\nSUMMARY:จ่าย${name}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const feed = (token) => fetch(`${API}/api/calendar/${token}.ics`);

test('calendar: needs a session, and a feed before it takes a calendar', async () => {
  assert.equal((await A('GET', '/calendar')).status, 401);
  await A('POST', '/auth/register', { email: `c${run}@t.dev`, password: 'password-c', name: 'C' });
  assert.deepEqual(await A('GET', '/calendar'), { status: 200, token: null });
  assert.equal((await A('PUT', '/calendar', { ics: ics('x') })).status, 404);
});

let token;
test('calendar: the secret URL serves the latest calendar without a cookie', async () => {
  token = (await A('POST', '/calendar/token')).token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  let r = await feed(token);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/calendar/);
  assert.match(await r.text(), /^BEGIN:VCALENDAR/);
  assert.equal((await A('PUT', '/calendar', { ics: ics('KTC') })).token, token);
  r = await feed(token);
  assert.match(await r.text(), /จ่ายKTC/);
  assert.equal((await A('GET', '/calendar')).token, token);
  assert.equal((await A('PUT', '/calendar', { ics: '<html>' })).status, 400);
});

test('calendar: another account cannot see or change it', async () => {
  await B('POST', '/auth/register', { email: `d${run}@t.dev`, password: 'password-d', name: 'D' });
  assert.deepEqual(await B('GET', '/calendar'), { status: 200, token: null });
  assert.equal((await B('PUT', '/calendar', { ics: ics('evil') })).status, 404);
  assert.match(await (await feed(token)).text(), /จ่ายKTC/);
});

test('calendar: a new link cuts off the old one, and turning it off removes it', async () => {
  const next = (await A('POST', '/calendar/token')).token;
  assert.notEqual(next, token);
  assert.equal((await feed(token)).status, 404);
  assert.match(await (await feed(next)).text(), /จ่ายKTC/); // keeps the calendar it had
  assert.equal((await A('DELETE', '/calendar')).ok, true);
  assert.equal((await feed(next)).status, 404);
  assert.equal((await feed('short')).status, 404);
});
