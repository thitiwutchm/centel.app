// Labels on transactions. Needs a running API (API_URL) on a disposable database.
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const A = agent();
const B = agent();
const exp = (bs, id) => bs.expenses.find((e) => e.id === id);

test('labels are created, put on expenses, renamed and deleted', async () => {
  await A.post('/auth/register', { email: `la${run}@t.dev`, password: 'password-a', name: 'A' });
  assert.equal((await A.put('/labels/grab', { name: 'Grabfood' })).ok, true);
  assert.equal((await A.put('/labels/shopee', { name: 'Shopee', sort: 1 })).ok, true);
  assert.equal((await A.put('/labels/x', { name: '  ' })).status, 400);

  const id = crypto.randomUUID();
  await A.post('/expenses', { id, type: 'expense', amount: 120, date: '2026-10-20', category: 'food', labels: ['grab', 'shopee', 'nope'] });
  let bs = await A.get('/bootstrap');
  assert.deepEqual(bs.labels.map((l) => l.name), ['Grabfood', 'Shopee']);
  assert.deepEqual(exp(bs, id).labels.sort(), ['grab', 'shopee']);

  // Editing the expense without labels keeps them; sending labels replaces them.
  await A.put(`/expenses/${id}`, { type: 'expense', amount: 130, date: '2026-10-20', category: 'food' });
  assert.equal(exp(await A.get('/bootstrap'), id).labels.length, 2);
  await A.put(`/expenses/${id}`, { type: 'expense', amount: 130, date: '2026-10-20', category: 'food', labels: ['grab'] });
  assert.deepEqual(exp(await A.get('/bootstrap'), id).labels, ['grab']);

  await A.put('/labels/grab', { name: 'GrabFood' });
  bs = await A.get('/bootstrap');
  assert.equal(bs.labels.find((l) => l.id === 'grab').name, 'GrabFood');

  assert.equal((await A.del('/labels/grab')).ok, true);
  bs = await A.get('/bootstrap');
  assert.deepEqual(bs.labels.map((l) => l.id), ['shopee']);
  assert.deepEqual(exp(bs, id).labels, []);
});

test('each partner labels a shared expense on their own, without re-approval', async () => {
  await B.post('/auth/register', { email: `lb${run}@t.dev`, password: 'password-b', name: 'B' });
  const { code } = await A.post('/couple/invite');
  await B.post('/couple/join', { code });
  const a = await A.get('/bootstrap');
  const b = await B.get('/bootstrap');
  await A.put('/labels/couple', { name: 'Couple budget' });
  await B.put('/labels/babe', { name: 'ForUBabe' });

  const id = crypto.randomUUID();
  await A.post('/expenses', {
    id, type: 'expense', scope: 'shared', amount: 400, date: '2026-10-21', category: 'food',
    payerId: a.user.id, shares: { [a.user.id]: 200 }, submit: true, labels: ['couple'],
  });
  await B.post(`/expenses/${id}/respond`, { approve: true });

  assert.equal((await B.put(`/expenses/${id}/labels`, { labels: ['babe', 'couple'] })).ok, true);
  assert.equal((await A.put(`/expenses/${id}/labels`, { labels: ['couple', 'shopee'] })).ok, true);
  const ea = exp(await A.get('/bootstrap'), id);
  const eb = exp(await B.get('/bootstrap'), id);
  assert.equal(ea.status, 'approved');
  assert.deepEqual(ea.labels.sort(), ['couple', 'shopee']);
  assert.deepEqual(eb.labels, ['babe']); // A's label ids mean nothing to B
  assert.ok(!(await B.get('/bootstrap')).labels.some((l) => l.id === 'couple'));
  assert.equal(b.labels.length, 0);

  // B cannot label A's personal expense.
  const mine = crypto.randomUUID();
  await A.post('/expenses', { id: mine, type: 'expense', amount: 50, date: '2026-10-22', category: 'coffee' });
  assert.equal((await B.put(`/expenses/${mine}/labels`, { labels: ['babe'] })).status, 404);
});

test('import brings labels along', async () => {
  const C = agent();
  await C.post('/auth/register', { email: `lc${run}@t.dev`, password: 'password-c', name: 'C' });
  const r = await C.post('/import', {
    wallets: [{ id: 'cash', name: 'Cash' }],
    labels: [{ id: 'l1', name: 'Trip' }],
    txns: [{ type: 'expense', amount: 10, date: '2026-10-01', category: 'food', walletId: 'cash', labels: ['l1'] }],
  });
  assert.equal(r.imported, 1);
  const bs = await C.get('/bootstrap');
  assert.deepEqual(bs.labels.map((l) => l.name), ['Trip']);
  assert.deepEqual(bs.expenses[0].labels, ['l1']);
});
