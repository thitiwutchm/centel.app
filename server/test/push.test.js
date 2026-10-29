// iPhone notifications (Web Push): subscribing, the test push, bill alerts sent once when
// due, shared note reminders to both partners, and the partner told about a shared
// expense. web-push only speaks https, so the stand-in push service on :3997 needs a
// self-signed pair:
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 2 -subj /CN=localhost
// Start the API with PUSH_TEST_ORIGIN=https://localhost:3997 NODE_EXTRA_CA_CERTS=c.pem
// LINE_TICK_MS=500, and run this with PUSH_TEST_KEY=k.pem PUSH_TEST_CERT=c.pem.
// Skipped without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');
const got = [];
const gone = new Set();
const tls = process.env.PUSH_TEST_KEY && process.env.PUSH_TEST_CERT;
const mock = tls && https.createServer({ key: fs.readFileSync(process.env.PUSH_TEST_KEY), cert: fs.readFileSync(process.env.PUSH_TEST_CERT) }, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    got.push({ path: req.url, auth: req.headers.authorization || '', encoding: req.headers['content-encoding'], size: Buffer.concat(chunks).length });
    res.statusCode = gone.has(req.url) ? 410 : 201;
    res.end();
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sub = (path) => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://localhost:3997${path}`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
};
const pA = `/a-${run}`;
const pB = `/b-${run}`;
const to = (p) => got.filter((g) => g.path === p);

test('push: setup and subscribe', { skip: !tls && 'no PUSH_TEST_KEY / PUSH_TEST_CERT' }, async () => {
  await new Promise((r) => mock.listen(3997, r));
  await A('POST', '/auth/register', { email: `pa${run}@t.dev`, password: 'password-a', name: 'Anna', nickname: 'แอน' });
  await B('POST', '/auth/register', { email: `pb${run}@t.dev`, password: 'password-b', name: 'Ben', nickname: 'เบน' });
  const { code } = await A('POST', '/couple/invite');
  await B('POST', '/couple/join', { code });
  assert.equal((await A('GET', '/bootstrap')).features.push, true);
  const k = await A('GET', '/push');
  assert.match(k.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(k.devices, 0);
  // Only real push services are accepted.
  assert.equal((await A('POST', '/push/subscribe', { subscription: { ...sub(pA), endpoint: 'https://evil.example/x' } })).status, 400);
  assert.equal((await A('POST', '/push/test')).status, 404);
  assert.equal((await A('POST', '/push/subscribe', { subscription: sub(pA), device: 'dA' })).devices, 1);
  assert.equal((await B('POST', '/push/subscribe', { subscription: sub(pB), device: 'dB' })).devices, 1);
});

test('push: the test notification is encrypted and VAPID signed', { skip: !tls }, async () => {
  assert.equal((await A('POST', '/push/test')).devices, 1);
  const g = to(pA);
  assert.equal(g.length, 1);
  assert.equal(g[0].encoding, 'aes128gcm');
  assert.match(g[0].auth, /^vapid t=.+, k=.+/);
  assert.ok(g[0].size > 100);
  assert.equal(to(pB).length, 0);
});

test('push: bill alerts are sent once when due', { skip: !tls }, async () => {
  got.length = 0;
  const past = new Date(Date.now() - 60000).toISOString();
  const alerts = [
    { key: 'bill:x:2026-10:due', at: past, title: '📅 วันนี้ครบกำหนด ค่าไฟ', body: '฿1,200 · ค่าไฟ' },
    { key: 'bill:y:2099-01:due', at: '2099-01-01T02:00:00Z', title: 'later', body: '' },
  ];
  assert.equal((await A('PUT', '/push/alerts', { device: 'dA', alerts: [{ key: 'bad key!', at: past, title: 'x' }] })).status, 400);
  assert.equal((await A('PUT', '/push/alerts', { device: 'dA', alerts })).count, 2);
  await wait(1500);
  assert.equal(to(pA).length, 1);
  // The same list again (the app reopened) does not send it twice.
  await A('PUT', '/push/alerts', { device: 'dA', alerts });
  await wait(1200);
  assert.equal(to(pA).length, 1);
  assert.equal(to(pB).length, 0);
});

test('push: a shared note reminder goes to both partners', { skip: !tls }, async () => {
  got.length = 0;
  const id = crypto.randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  await A('PUT', `/notes/${id}`, { text: 'ไปเยี่ยมแม่ ลำพูน', date: today, remind: 0, remindAt: new Date(Date.now() - 1000).toISOString(), shared: true });
  await wait(1500);
  assert.equal(to(pA).length, 1);
  assert.equal(to(pB).length, 1);
});

test('push: the partner hears about a new shared expense', { skip: !tls }, async () => {
  got.length = 0;
  const me = (await B('GET', '/bootstrap')).user.id;
  const r = await B('POST', '/expenses', { scope: 'shared', type: 'expense', amount: 1860.25, date: '2026-10-29', merchant: 'CFW', payerId: me, shares: {} });
  assert.ok(r.id);
  await wait(500);
  assert.equal(to(pA).length, 1);
  assert.equal(to(pB).length, 0);
});

test('push: a device the push service says is gone is forgotten', { skip: !tls }, async () => {
  gone.add(pB);
  await B('POST', '/push/test');
  assert.equal((await B('GET', '/push')).devices, 0);
  assert.equal((await A('DELETE', '/push/subscribe', { endpoint: sub(pA).endpoint })).devices, 0);
  mock.close();
});
