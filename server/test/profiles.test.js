// Profiles: one sign-in, several fully separate profiles. Needs a running API (API_URL) on a disposable database.
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
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p), get cookie() { return cookie; } };
}

test('profiles keep their data apart and switch the session', async () => {
  const A = agent();
  const email = `pa${run}@t.dev`;
  await A.post('/auth/register', { email, password: 'password-a', name: 'Main Person', nickname: 'Main' });
  const main = (await A.get('/bootstrap')).user;
  assert.equal(main.email, email);

  await A.put('/wallets/kbank', { name: 'KBank', type: 'bank', initial: 100 });
  await A.post('/expenses', { type: 'expense', amount: 50, date: '2026-11-05', walletId: 'kbank', category: 'food' });
  await A.put('/planner', { data: { bills: [{ id: 'b1', name: 'Rent' }], records: {}, settings: {} }, baseRev: 0 });

  let r = await A.get('/profiles');
  assert.equal(r.profiles.length, 1);
  assert.equal(r.profiles[0].main, true);
  assert.equal(r.profiles[0].current, true);

  assert.equal((await A.post('/profiles', { name: '  ' })).status, 400);
  const biz = await A.post('/profiles', { name: 'ร้านกาแฟ', avatar: '☕' });
  assert.ok(biz.id);

  // Another account cannot switch into it.
  const X = agent();
  await X.post('/auth/register', { email: `px${run}@t.dev`, password: 'password-x', name: 'Other' });
  assert.equal((await X.post('/profiles/switch', { id: biz.id })).status, 404);
  assert.equal((await X.del(`/profiles/${biz.id}`)).status, 404);

  const before = A.cookie;
  assert.equal((await A.post('/profiles/switch', { id: biz.id })).ok, true);
  assert.notEqual(A.cookie, before);
  // The old session is gone.
  const old = await fetch(API + '/api/bootstrap', { headers: { cookie: before } });
  assert.equal(old.status, 401);

  let b = await A.get('/bootstrap');
  assert.equal(b.user.id, biz.id);
  assert.equal(b.user.name, 'ร้านกาแฟ');
  assert.equal(b.user.nickname, 'ร้านกาแฟ');
  assert.equal(b.user.avatar, '☕');
  assert.equal(b.user.email, email); // shows the account's email
  assert.equal(b.wallets.length, 0);
  assert.equal(b.expenses.length, 0);
  assert.equal(b.planner.data, null);
  assert.deepEqual(b.profiles.map((p) => [p.id, p.main, p.current]), [[main.id, true, false], [biz.id, false, true]]);

  await A.put('/wallets/till', { name: 'Till', type: 'cash', initial: 0 });
  await A.post('/expenses', { type: 'expense', amount: 7, date: '2026-11-05', walletId: 'till', category: 'food' });
  b = await A.get('/bootstrap');
  assert.deepEqual(b.wallets.map((w) => w.id), ['till']);
  assert.deepEqual(b.expenses.map((e) => e.amount), [7]);

  // The profile cannot sign in by itself, and cannot delete itself or the main profile.
  assert.equal((await A.del(`/profiles/${biz.id}`)).status, 409);
  assert.equal((await A.del(`/profiles/${main.id}`)).status, 409);

  // Back to the main profile: its own data, untouched.
  await A.post('/profiles/switch', { id: main.id });
  b = await A.get('/bootstrap');
  assert.equal(b.user.id, main.id);
  assert.deepEqual(b.wallets.map((w) => w.id), ['kbank']);
  assert.deepEqual(b.expenses.map((e) => e.amount), [50]);
  assert.equal(b.planner.data.bills[0].name, 'Rent');

  // Signing in again lands on the main profile.
  const A2 = agent();
  await A2.post('/auth/login', { email, password: 'password-a' });
  assert.equal((await A2.get('/bootstrap')).user.id, main.id);

  // Limit of extra profiles.
  for (let i = 0; i < 4; i++) assert.ok((await A.post('/profiles', { name: `P${i}` })).id);
  assert.equal((await A.post('/profiles', { name: 'one too many' })).status, 409);

  // Deleting a profile deletes its data.
  assert.equal((await A.del(`/profiles/${biz.id}`)).ok, true);
  r = await A.get('/profiles');
  assert.equal(r.profiles.length, 5);
  assert.ok(!r.profiles.some((p) => p.id === biz.id));
});

test('each profile has its own partner link', async () => {
  const A = agent();
  const B = agent();
  await A.post('/auth/register', { email: `ca${run}@t.dev`, password: 'password-a', name: 'A', nickname: 'A' });
  await B.post('/auth/register', { email: `cb${run}@t.dev`, password: 'password-b', name: 'B', nickname: 'B' });
  const { code } = await A.post('/couple/invite');
  await B.post('/couple/join', { code });
  assert.equal((await A.get('/bootstrap')).partner.nickname, 'B');
  const p = await A.post('/profiles', { name: 'Work' });
  await A.post('/profiles/switch', { id: p.id });
  const b = await A.get('/bootstrap');
  assert.equal(b.partner, null);
  assert.equal(b.coupleId, null);
});
