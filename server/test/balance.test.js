// Balance sharing: the switch, what the partner sees, and per-wallet detail.
// The first test needs nothing; the rest need a running API (API_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readSnapshot } from '../src/balance.js';

test('readSnapshot keeps a numeric total and clean wallet rows', () => {
  assert.deepEqual(readSnapshot({ total: 1234.567, wallets: [{ name: ' กสิกร <b>', emoji: '🏦', balance: '500.5' }, { name: '', balance: 1 }, { name: 'x', balance: 'no' }] }),
    { total: 1234.57, wallets: [{ name: 'กสิกร b', emoji: '🏦', balance: 500.5 }] });
  assert.equal(readSnapshot({ total: 'abc' }), null);
  assert.equal(readSnapshot(null), null);
  assert.deepEqual(readSnapshot({ total: -20 }), { total: -20, wallets: [] });
});

const API = process.env.API_URL;
const run = crypto.randomBytes(4).toString('hex');
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

test('balance sharing through the API', { skip: !API && 'needs API_URL' }, async () => {
  const A = agent(), B = agent(), C = agent();
  await A('POST', '/auth/register', { email: `ba${run}@t.dev`, password: 'password-a', name: 'A', nickname: 'เอ' });
  await B('POST', '/auth/register', { email: `bb${run}@t.dev`, password: 'password-b', name: 'B', nickname: 'บี' });
  await C('POST', '/auth/register', { email: `bc${run}@t.dev`, password: 'password-c', name: 'C' });
  const { code } = await A('POST', '/couple/invite');
  await B('POST', '/couple/join', { code });

  assert.deepEqual(await A('GET', '/balance'), { status: 200, me: { sharing: false, perWallet: false }, partner: { sharing: false, perWallet: false } });
  assert.equal((await C('GET', '/balance')).partner, null);
  assert.equal((await A('POST', '/balance', { total: 100 })).status, 409);
  assert.equal((await fetch(API + '/api/balance')).status, 401);

  // A shares the total only: B sees it, without wallets.
  await A('PUT', '/balance/sharing', { on: true });
  const w = [{ name: 'กสิกร', emoji: '🏦', balance: 900 }, { name: 'เงินสด', balance: 100 }];
  assert.equal((await A('POST', '/balance', { total: 1000, wallets: w })).me.total, 1000);
  let seen = (await B('GET', '/balance')).partner;
  assert.equal(seen.sharing, true);
  assert.equal(seen.total, 1000);
  assert.equal(seen.wallets, undefined);
  assert.equal((await C('GET', '/balance')).partner, null);

  // Each wallet too.
  await A('PUT', '/balance/sharing', { on: true, perWallet: true });
  await A('POST', '/balance', { total: 950.25, wallets: w });
  seen = (await B('GET', '/balance')).partner;
  assert.equal(seen.total, 950.25);
  assert.deepEqual(seen.wallets, w);
  assert.equal((await A('POST', '/balance', { total: 'x' })).status, 400);

  // Off: B sees nothing and the snapshot is gone.
  await A('PUT', '/balance/sharing', { on: false });
  assert.deepEqual((await B('GET', '/balance')).partner, { sharing: false, perWallet: false });
  await A('PUT', '/balance/sharing', { on: true });
  assert.equal((await B('GET', '/balance')).partner.total, undefined);
});
