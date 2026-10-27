// PRD section 12 acceptance checks. Needs a running API (API_URL) on an empty or
// disposable database (DATABASE_URL, used for the direct-query check).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

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
  return { call, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const A = agent();
const B = agent();
let a, b;

test('register two accounts and link them with an invite', async () => {
  assert.equal((await A.post('/auth/register', { email: `a${run}@t.dev`, password: 'password-a', name: 'A' })).ok, true);
  assert.equal((await B.post('/auth/register', { email: `b${run}@t.dev`, password: 'password-b', name: 'B' })).ok, true);
  const { code } = await A.post('/couple/invite');
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.equal((await B.post('/couple/join', { code })).ok, true);
  a = (await A.get('/bootstrap'));
  b = (await B.get('/bootstrap'));
  assert.equal(a.partner.id, b.user.id);
  assert.equal(b.partner.id, a.user.id);
});

test('A cannot see B personal expenses, even querying the database directly', async () => {
  const personal = crypto.randomUUID();
  assert.equal((await B.post('/expenses', { id: personal, type: 'expense', amount: 99, date: '2026-10-20', category: 'food', note: 'secret' })).id, personal);
  const seen = (await A.get('/bootstrap')).expenses.map((e) => e.id);
  assert.ok(!seen.includes(personal));
  assert.equal((await A.del(`/expenses/${personal}`)).status, 409);

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('begin');
    await db.query('set local role app_user');
    await db.query("select set_config('app.user_id', $1, true)", [a.user.id]);
    assert.equal((await db.query('select * from expenses where id = $1', [personal])).rowCount, 0);
    assert.equal((await db.query('update expenses set amount = 1 where id = $1', [personal])).rowCount, 0);
    await assert.rejects(db.query('select password_hash from users'));
    await db.query('rollback');
  } finally {
    await db.end();
  }
});

test('a shared expense is recorded for both straight away, with no approval and no debt', async () => {
  const id = crypto.randomUUID();
  const r = await A.post('/expenses', {
    id, scope: 'shared', type: 'expense', amount: 1000, date: '2026-10-21', merchant: 'ซูชิ', category: 'food',
    payerId: a.user.id, shares: { [a.user.id]: 500 },
  });
  assert.equal(r.id, id);
  const boot = await B.get('/bootstrap');
  const e = boot.expenses.find((x) => x.id === id);
  assert.equal(e.status, 'approved');
  assert.deepEqual(e.shares, { [a.user.id]: 500, [b.user.id]: 500 });
  assert.equal(boot.settlements.length, 0);
  // Only the creator can change it.
  const edit = await B.put(`/expenses/${id}`, { scope: 'shared', type: 'expense', amount: 10, date: '2026-10-21', payerId: a.user.id });
  assert.equal(edit.status, 404);
  assert.equal((await B.del(`/expenses/${id}`)).status, 409);
});

test('รับผิดชอบทั้งหมด puts the whole cost on the creator; edits stay recorded', async () => {
  const id = crypto.randomUUID();
  await A.post('/expenses', {
    id, scope: 'shared', type: 'expense', amount: 400, date: '2026-10-22', category: 'food',
    payerId: a.user.id, shares: { [a.user.id]: 400 },
  });
  let e = (await B.get('/bootstrap')).expenses.find((x) => x.id === id);
  assert.deepEqual(e.shares, { [a.user.id]: 400, [b.user.id]: 0 });
  // Switch to หาร 2.
  assert.equal((await A.put(`/expenses/${id}`, {
    scope: 'shared', type: 'expense', amount: 300, date: '2026-10-22', category: 'food',
    payerId: a.user.id, shares: { [a.user.id]: 150 },
  })).id, id);
  const boot = await B.get('/bootstrap');
  e = boot.expenses.find((x) => x.id === id);
  assert.equal(e.status, 'approved');
  assert.equal(e.amount, 300);
  assert.deepEqual(e.shares, { [a.user.id]: 150, [b.user.id]: 150 });
  assert.equal(boot.settlements.length, 0);
  // The creator can make it personal again, or delete it.
  assert.equal((await A.put(`/expenses/${id}`, { scope: 'personal', type: 'expense', amount: 300, date: '2026-10-22', category: 'food' })).id, id);
  assert.ok(!(await B.get('/bootstrap')).expenses.some((x) => x.id === id));
  assert.equal((await A.del(`/expenses/${id}`)).ok, true);
});

test('duplicate slip reference is flagged before saving', async () => {
  const base = { type: 'expense', amount: 250, date: '2026-10-23', category: 'food', slipRef: `REF${run}` };
  assert.ok((await A.post('/expenses', base)).id);
  const dup = await A.post('/expenses', base);
  assert.equal(dup.status, 409);
  assert.equal(dup.error, 'duplicate');
  assert.ok((await A.post('/expenses', { ...base, force: true })).id);
});

test('mutations without the CSRF header are refused', async () => {
  const res = await fetch(API + '/api/couple/invite', { method: 'POST' });
  assert.equal(res.status, 403);
});
