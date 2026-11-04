// Notifications in the native iOS app (APNs): registering the device token, the test
// push signed with the .p8 key, the BadDeviceToken retry on the other gateway, and a
// token Apple says is gone being forgotten. The stand-in APNs gateway is h2c on :3996.
// Start the API with APNS_TEST_ORIGIN=http://localhost:3996 APNS_KEY_ID=TESTKEY001
// APNS_KEY="$(cat k.p8)" (any P-256 key:
//   openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out k.p8)
// and run this with APNS_TEST_KEY=k.p8. Skipped without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');
const keyFile = process.env.APNS_TEST_KEY;
const got = [];
const gone = new Set();
const wrongEnv = new Set(); // tokens that answer BadDeviceToken on the first try only
const mock = keyFile && http2.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const token = req.headers[':path'].split('/').pop();
    got.push({ token, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    if (gone.has(token)) { res.statusCode = 410; res.end(JSON.stringify({ reason: 'Unregistered' })); return; }
    if (wrongEnv.delete(token)) { res.statusCode = 400; res.end(JSON.stringify({ reason: 'BadDeviceToken' })); return; }
    res.statusCode = 200;
    res.end();
  });
});
// The api keeps its connection open, so close() has to drop it too.
const conns = new Set();
if (mock) mock.on('session', (s) => conns.add(s));

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
const tok = () => crypto.randomBytes(32).toString('hex');
const tA = tok();
const tB = tok();
const to = (t) => got.filter((g) => g.token === t);

test('apns: setup and register', { skip: !keyFile && 'no APNS_TEST_KEY' }, async () => {
  await new Promise((r) => mock.listen(3996, r));
  await A('POST', '/auth/register', { email: `aa${run}@t.dev`, password: 'password-a', name: 'Anna', nickname: 'แอน' });
  await B('POST', '/auth/register', { email: `ab${run}@t.dev`, password: 'password-b', name: 'Ben', nickname: 'เบน' });
  const { code } = await A('POST', '/couple/invite');
  await B('POST', '/couple/join', { code });
  assert.equal((await A('GET', '/bootstrap')).features.apns, true);
  assert.equal((await A('POST', '/push/apns', { token: 'not-hex' })).status, 400);
  assert.equal((await A('POST', '/push/apns', { token: tA, device: 'iA' })).devices, 1);
  assert.equal((await B('POST', '/push/apns', { token: tB.toUpperCase(), device: 'iB', env: 'sandbox' })).devices, 1);
  assert.equal((await A('GET', '/push')).devices, 1);
});

test('apns: the test push is signed with the key and shaped for iOS', { skip: !keyFile }, async () => {
  assert.equal((await A('POST', '/push/test')).devices, 1);
  const [g] = to(tA);
  assert.equal(to(tB).length, 0);
  assert.equal(g.headers['apns-topic'], 'app.centel');
  assert.equal(g.headers['apns-push-type'], 'alert');
  assert.equal(g.headers['apns-collapse-id'], 'test');
  assert.match(g.body.aps.alert.title, /Centel/);
  assert.equal(g.body.aps.sound, 'default');
  assert.equal(g.body.url, '/');
  const [head, claims, sig] = g.headers.authorization.replace(/^bearer /, '').split('.');
  const h = JSON.parse(Buffer.from(head, 'base64url'));
  assert.deepEqual([h.alg, h.kid], ['ES256', 'TESTKEY001']);
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, '5274992QMF');
  const pub = crypto.createPublicKey(fs.readFileSync(keyFile));
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('apns: the partner hears about a new shared expense', { skip: !keyFile }, async () => {
  got.length = 0;
  const me = (await B('GET', '/bootstrap')).user.id;
  await B('POST', '/expenses', { scope: 'shared', type: 'expense', amount: 99, date: '2026-11-04', merchant: 'CFW', payerId: me, shares: {} });
  await wait(500);
  assert.equal(to(tA).length, 1);
  assert.equal(to(tB).length, 0);
});

test('apns: a token for the other gateway is retried there once', { skip: !keyFile }, async () => {
  got.length = 0;
  wrongEnv.add(tA);
  assert.equal((await A('POST', '/push/test')).devices, 1);
  assert.equal(to(tA).length, 2);
  assert.equal((await A('GET', '/push')).devices, 1);
});

test('apns: a token Apple says is gone is forgotten', { skip: !keyFile }, async () => {
  gone.add(tB);
  assert.equal((await B('POST', '/push/test')).status, 404);
  assert.equal((await B('GET', '/push')).devices, 0);
  assert.equal((await A('DELETE', '/push/apns', { token: tA })).devices, 0);
  mock.close();
  conns.forEach((s) => s.destroy());
});
