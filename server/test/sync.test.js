// Cross-device sync: planner revisions and idempotent import of a device's local data.
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
const doc = (name) => ({ bills: [{ id: 'b1', name }], records: { '2026-10': { b1: { paid: true } } }, settings: { payday: 25 } });

test('planner: a stale device gets the newer copy back instead of overwriting it', async () => {
  await A('POST', '/auth/register', { email: `s${run}@t.dev`, password: 'password-s', name: 'S' });
  assert.deepEqual((await A('GET', '/bootstrap')).planner, { data: null, rev: 0 });
  assert.equal((await A('PUT', '/planner', { data: doc('KTC'), baseRev: 0 })).rev, 1);
  const stale = await A('PUT', '/planner', { data: doc('Other'), baseRev: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.rev, 1);
  assert.equal(stale.data.bills[0].name, 'KTC');
  assert.equal((await A('PUT', '/planner', { data: doc('KTC2'), baseRev: 1 })).rev, 2);
  const b = await A('GET', '/bootstrap');
  assert.equal(b.planner.rev, 2);
  assert.equal(b.planner.data.bills[0].name, 'KTC2');
  assert.equal((await A('PUT', '/planner', { data: { bills: 'x' }, baseRev: 2 })).status, 400);
});

test('planner: another account cannot read it', async () => {
  await B('POST', '/auth/register', { email: `t${run}@t.dev`, password: 'password-t', name: 'T' });
  assert.deepEqual((await B('GET', '/planner')), { status: 200, data: null, rev: 0 });
});

test('import: the same device imported twice counts once, budgets do not duplicate', async () => {
  const data = {
    wallets: [{ id: 'cash', name: 'เงินสด', type: 'cash', initial: 0 }, { id: 'kb', name: 'KBank', type: 'bank', initial: 1000 }],
    txns: [
      { id: 'local1', type: 'expense', amount: 50, date: '2026-10-01', category: 'food', walletId: 'cash' },
      { id: 'local2', type: 'income', amount: 900, date: '2026-10-02', category: 'salary', walletId: 'kb', billId: 'b1', billYm: '2026-10' },
    ],
    budgets: [{ id: 'bg1', category: 'food', amount: 5000, walletId: 'total' }],
  };
  assert.equal((await A('POST', '/import', data)).imported, 2);
  assert.equal((await A('POST', '/import', data)).imported, 0);
  const second = { txns: [{ id: 'phone1', type: 'expense', amount: 70, date: '2026-10-03', category: 'food' }], budgets: [{ id: 'bg9', category: 'food', amount: 1, walletId: 'total' }] };
  assert.equal((await A('POST', '/import', second)).imported, 1);
  const b = await A('GET', '/bootstrap');
  assert.equal(b.expenses.length, 3);
  assert.equal(b.wallets.length, 2);
  assert.equal(b.budgets.length, 1);
  assert.equal(b.budgets[0].amount, 5000);
  assert.equal(b.expenses.find((e) => e.amount === 900).billId, 'b1');
  assert.equal((await B('GET', '/bootstrap')).expenses.length, 0);
});

test('bill files: bad ids are refused before touching storage', async () => {
  const r = await A('GET', '/bill-files/..%2Fx/2026-10');
  assert.equal(r.status, 400);
});
