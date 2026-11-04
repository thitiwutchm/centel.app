// Bill planner sync across devices: revisions, conflicts and isolation.
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
  await A('POST', '/auth/register', { email: `p${run}@t.dev`, password: 'password-p', name: 'P', nickname: 'P' });
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
  await B('POST', '/auth/register', { email: `q${run}@t.dev`, password: 'password-q', name: 'Q', nickname: 'Q' });
  assert.deepEqual(await B('GET', '/planner'), { status: 200, data: null, rev: 0 });
  assert.equal((await B('GET', '/bootstrap')).planner.rev, 0);
});

test('bill files: bad ids are refused before touching storage', async () => {
  assert.equal((await A('GET', '/bill-files/..%2Fx/2026-10')).status, 400);
  assert.equal((await A('GET', '/bill-files/b1/2026-1')).status, 400);
});
