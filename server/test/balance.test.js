// Balance sharing: the switch, what the partner sees, and per-wallet detail.
// The first test needs nothing; the rest need a running API (API_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readSnapshot, monthRange } from '../src/balance.js';

test('readSnapshot keeps a numeric total and clean wallet rows', () => {
  assert.deepEqual(readSnapshot({ total: 1234.567, wallets: [{ name: ' กสิกร <b>', emoji: '🏦', balance: '500.5' }, { name: '', balance: 1 }, { name: 'x', balance: 'no' }] }),
    { total: 1234.57, wallets: [{ name: 'กสิกร b', emoji: '🏦', balance: 500.5 }] });
  assert.equal(readSnapshot({ total: 'abc' }), null);
  assert.equal(readSnapshot(null), null);
  assert.deepEqual(readSnapshot({ total: -20 }), { total: -20, wallets: [] });
});

test('monthRange gives the first day of the month and of the next one', () => {
  assert.deepEqual(monthRange('2026-11'), ['2026-11-01', '2026-12-01']);
  assert.deepEqual(monthRange('2026-12'), ['2026-12-01', '2027-01-01']);
  assert.equal(monthRange('2026-13'), null);
  assert.equal(monthRange('x'), null);
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

  assert.deepEqual(await A('GET', '/balance'), { status: 200, me: { sharing: false, perWallet: false, expenses: false }, partner: { sharing: false, perWallet: false, expenses: false } });
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
  assert.deepEqual((await B('GET', '/balance')).partner, { sharing: false, perWallet: false, expenses: false });
  await A('PUT', '/balance/sharing', { on: true });
  assert.equal((await B('GET', '/balance')).partner.total, undefined);
});

test('expense sharing through the API', { skip: !API && 'needs API_URL' }, async () => {
  const A = agent(), B = agent(), C = agent();
  await A('POST', '/auth/register', { email: `ea${run}@t.dev`, password: 'password-a', name: 'A', nickname: 'เอ' });
  await B('POST', '/auth/register', { email: `eb${run}@t.dev`, password: 'password-b', name: 'B', nickname: 'บี' });
  await C('POST', '/auth/register', { email: `ec${run}@t.dev`, password: 'password-c', name: 'C' });
  const { code } = await A('POST', '/couple/invite');
  await B('POST', '/couple/join', { code });
  const a = (await A('GET', '/bootstrap')).user.id, b = (await B('GET', '/bootstrap')).user.id;

  await A('POST', '/expenses', { type: 'expense', amount: 120, date: '2026-11-03', merchant: 'ร้านข้าว', category: 'food', note: 'กลางวัน' });
  await A('POST', '/expenses', { type: 'expense', amount: 80, date: '2026-10-30', category: 'food' });
  await A('POST', '/expenses', { type: 'income', amount: 5000, date: '2026-11-01' });
  await B('POST', '/expenses', { scope: 'shared', type: 'expense', amount: 300, date: '2026-11-05', payerId: b, shares: { [a]: 150, [b]: 150 } });
  await B('POST', '/expenses', { type: 'expense', amount: 999, date: '2026-11-05' });

  // Not shared yet: B cannot read A's expenses, C has no partner.
  assert.equal((await B('GET', '/balance/expenses?ym=2026-11')).status, 403);
  assert.equal((await C('GET', '/balance/expenses?ym=2026-11')).status, 404);
  assert.equal((await A('PUT', '/balance/expenses-sharing', { on: true })).me.expenses, true);
  assert.equal((await B('GET', '/balance')).partner.expenses, true);
  assert.equal((await B('GET', '/balance')).partner.sharing, false);
  assert.equal((await B('GET', '/balance/expenses?ym=2026-13')).status, 400);

  // A's personal expenses at full amount and A's half of the shared one; no income, no B's own.
  const m = await B('GET', '/balance/expenses?ym=2026-11');
  assert.equal(m.status, 200);
  assert.equal(m.total, 270);
  assert.deepEqual(m.items.map((x) => [x.date, x.amount, x.scope]), [['2026-11-03', 120, 'personal'], ['2026-11-05', 150, 'shared']]);
  assert.equal(m.items[0].merchant, 'ร้านข้าว');
  assert.equal(m.items[1].total, 300);
  assert.equal((await B('GET', '/balance/expenses?ym=2026-10')).total, 80);
  // A doesn't see B's (B hasn't shared); off stops B right away.
  assert.equal((await A('GET', '/balance/expenses?ym=2026-11')).status, 403);
  await A('PUT', '/balance/expenses-sharing', { on: false });
  assert.equal((await B('GET', '/balance/expenses?ym=2026-11')).status, 403);
});
