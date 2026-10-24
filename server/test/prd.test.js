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

test('approver can only approve or reject, never edit amount or shares', async () => {
  const id = crypto.randomUUID();
  const r = await A.post('/expenses', {
    id, scope: 'shared', type: 'expense', amount: 1000, date: '2026-10-21', merchant: 'ซูชิ', category: 'food',
    payerId: a.user.id, shares: { [a.user.id]: 500 }, submit: true,
  });
  assert.equal(r.id, id);
  // Pending: not a debt yet.
  assert.equal((await B.get('/bootstrap')).settlements.length, 0);
  // B tries to edit: refused.
  const edit = await B.put(`/expenses/${id}`, { scope: 'shared', type: 'expense', amount: 10, date: '2026-10-21', payerId: a.user.id });
  assert.equal(edit.status, 404);
  // A cannot approve own request.
  assert.equal((await A.post(`/expenses/${id}/respond`, { approve: true })).status, 409);
  // A cannot edit while pending either.
  assert.equal((await A.put(`/expenses/${id}`, { scope: 'shared', type: 'expense', amount: 10, date: '2026-10-21', payerId: a.user.id })).status, 409);
});

test('rejected request creates no debt and the creator can resubmit', async () => {
  const id = crypto.randomUUID();
  await A.post('/expenses', {
    id, scope: 'shared', type: 'expense', amount: 400, date: '2026-10-22', category: 'food',
    payerId: a.user.id, shares: { [a.user.id]: 200 }, submit: true,
  });
  assert.equal((await B.post(`/expenses/${id}/respond`, { approve: false, reason: 'ยอดผิด' })).ok, true);
  let boot = await A.get('/bootstrap');
  assert.equal(boot.expenses.find((e) => e.id === id).status, 'rejected');
  assert.ok(!boot.settlements.some((s) => s.expenseId === id));
  const re = await A.put(`/expenses/${id}`, {
    scope: 'shared', type: 'expense', amount: 300, date: '2026-10-22', category: 'food',
    payerId: a.user.id, shares: { [a.user.id]: 150 }, submit: true,
  });
  assert.equal(re.id, id);
  boot = await B.get('/bootstrap');
  const e = boot.expenses.find((x) => x.id === id);
  assert.equal(e.status, 'pending');
  assert.equal(e.revision, 2);
  assert.deepEqual(e.events.map((x) => x.action), ['submitted', 'rejected', 'resubmitted']);
});

test('approving 1,000 paid by A split 50/50 shows B owes A 500; repayment adds no spending', async () => {
  const boot0 = await B.get('/bootstrap');
  const sushi = boot0.expenses.find((e) => e.merchant === 'ซูชิ');
  assert.equal((await B.post(`/expenses/${sushi.id}/respond`, { approve: true })).ok, true);
  const boot = await B.get('/bootstrap');
  const st = boot.settlements.filter((s) => s.expenseId === sushi.id);
  assert.equal(st.length, 1);
  assert.equal(st[0].debtorId, b.user.id);
  assert.equal(st[0].creditorId, a.user.id);
  assert.equal(st[0].amount, 500);
  assert.equal(st[0].status, 'unpaid');

  const sharedTotal = () => B.get('/bootstrap').then((x) => x.expenses
    .filter((e) => e.scope === 'shared' && e.status === 'approved').reduce((s, e) => s + e.amount, 0));
  const before = await sharedTotal();
  assert.equal(before, 1000); // counted once, not 1,000 + 500
  assert.equal((await B.post(`/settlements/${st[0].id}`, { paid: true })).ok, true);
  assert.equal(await sharedTotal(), before);
  const after = (await A.get('/bootstrap')).settlements.find((s) => s.id === st[0].id);
  assert.equal(after.status, 'paid');
  // Approved shared expenses are locked.
  assert.equal((await A.del(`/expenses/${sushi.id}`)).status, 409);
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
