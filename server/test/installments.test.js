// 0% installments: each month of a plan is a personal expense carrying inst = { id, n, of, total }.
// Needs a running API (API_URL) on a disposable database.
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

test('installment months keep their plan; bad plans and other rows drop it', async () => {
  const A = agent();
  await A.post('/auth/register', { email: `in${run}@t.dev`, password: 'password-a', name: 'A' });
  const plan = crypto.randomUUID();
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (let k = 0; k < 3; k++) {
    const r = await A.post('/expenses', { id: ids[k], type: 'expense', amount: k === 2 ? 3333.34 : 3333.33, walletId: 'card',
      category: 'shopping', date: `2026-1${k + 1}-07`.replace('2026-13', '2027-01'), merchant: 'Shopee', inst: { id: plan, n: k + 1, of: 3, total: 10000 } });
    assert.equal(r.status, 200);
  }
  const bad = crypto.randomUUID(), inc = crypto.randomUUID();
  await A.post('/expenses', { id: bad, type: 'expense', amount: 10, date: '2026-11-07', inst: { id: plan, n: 4, of: 3, total: 30 } });
  await A.post('/expenses', { id: inc, type: 'income', amount: 10, date: '2026-11-07', inst: { id: plan, n: 1, of: 3, total: 30 } });
  // Editing one month keeps its place in the plan.
  await A.put(`/expenses/${ids[1]}`, { type: 'expense', amount: 3333.33, date: '2026-12-08', merchant: 'Shopee', inst: { id: plan, n: 2, of: 3, total: 10000 } });
  const bs = await A.get('/bootstrap');
  const e = (id) => bs.expenses.find((x) => x.id === id);
  assert.deepEqual(e(ids[1]).inst, { id: plan, n: 2, of: 3, total: 10000 });
  assert.equal(e(ids[1]).date.slice(0, 10), '2026-12-08');
  assert.equal(bs.expenses.filter((x) => x.inst && x.inst.id === plan).length, 3);
  assert.equal(e(bad).inst, undefined);
  assert.equal(e(inc).inst, undefined);
});
