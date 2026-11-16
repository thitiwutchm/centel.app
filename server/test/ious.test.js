// ติดเงิน (IOUs): who owes whom. Needs a running API (API_URL) on a disposable database.
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

test('IOUs are saved, repaid, kept private and never touch money', async () => {
  await A.post('/auth/register', { email: `ia${run}@t.dev`, password: 'password-a', name: 'A' });
  await B.post('/auth/register', { email: `ib${run}@t.dev`, password: 'password-b', name: 'B' });
  const id = crypto.randomUUID();
  const r = await A.put(`/ious/${id}`, { dir: 'owed', kind: 'advance', person: ' Ball ', amount: 500.456, date: '2026-11-16', note: 'ค่าตั๋ว', due: '2026-11-30' });
  assert.equal(r.ok, true);
  assert.equal(r.iou.person, 'Ball');
  assert.equal(r.iou.amount, 500.46);

  // Bad rows are refused.
  assert.equal((await A.put(`/ious/${crypto.randomUUID()}`, { dir: 'x', person: 'a', amount: 1, date: '2026-11-16' })).status, 400);
  assert.equal((await A.put(`/ious/${crypto.randomUUID()}`, { dir: 'owe', person: '', amount: 1, date: '2026-11-16' })).status, 400);
  assert.equal((await A.put(`/ious/${crypto.randomUUID()}`, { dir: 'owe', person: 'a', amount: 0, date: '2026-11-16' })).status, 400);
  assert.equal((await A.put('/ious/nope', { dir: 'owe', person: 'a', amount: 1, date: '2026-11-16' })).status, 400);

  // A repayment is kept on the row; editing replaces the whole row.
  await A.put(`/ious/${id}`, { dir: 'owed', kind: 'advance', person: 'Ball', amount: 500.46, date: '2026-11-16', note: 'ค่าตั๋ว',
    repaid: [{ id: 'p1', date: '2026-11-20', amount: 200, txnId: 'abc' }, { amount: -5 }] });
  let bs = await A.get('/bootstrap');
  assert.equal(bs.ious.length, 1);
  assert.deepEqual(bs.ious[0].repaid, [{ id: 'p1', date: '2026-11-20', amount: 200, txnId: 'abc' }]);
  assert.equal(bs.ious[0].due, undefined);
  // Nothing about it shows up as money.
  assert.equal(bs.expenses.length, 0);

  // Only the owner sees, changes or deletes it.
  assert.deepEqual((await B.get('/bootstrap')).ious, []);
  await B.del(`/ious/${id}`);
  assert.equal((await A.get('/bootstrap')).ious.length, 1);
  assert.notEqual((await B.put(`/ious/${id}`, { dir: 'owe', person: 'x', amount: 1, date: '2026-11-16' })).ok, true);
  assert.equal((await A.get('/bootstrap')).ious[0].person, 'Ball');

  assert.equal((await A.del(`/ious/${id}`)).ok, true);
  assert.deepEqual((await A.get('/bootstrap')).ious, []);
});

test('IOUs come along when local data is imported', async () => {
  const C = agent();
  await C.post('/auth/register', { email: `ic${run}@t.dev`, password: 'password-c', name: 'C' });
  await C.post('/import', { wallets: [], txns: [], ious: [
    { id: crypto.randomUUID(), dir: 'owe', kind: 'loan', person: 'Mom', amount: 1000, date: '2026-11-01' },
    { id: 'not-a-uuid', dir: 'owed', person: 'Fern', amount: 80, date: '2026-11-02' },
    { dir: 'bad', person: 'x', amount: 1, date: '2026-11-02' },
  ] });
  const bs = await C.get('/bootstrap');
  assert.deepEqual(bs.ious.map((o) => o.person).sort(), ['Fern', 'Mom']);
});
