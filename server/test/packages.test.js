// Package wallets: prepaid value used a share at a time. Needs a running API (API_URL) on a disposable database.
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

test('a package wallet keeps its terms; other wallets drop them', async () => {
  const A = agent();
  await A.post('/auth/register', { email: `pk${run}@t.dev`, password: 'password-a', name: 'A' });
  await A.put('/wallets/gym', { name: 'Playground', type: 'package', initial: 0, pkg: { price: 16000, uses: 20, category: 'fitness', merchant: 'เพลย์กราวด์' } });
  await A.put('/wallets/bad', { name: 'Bad', type: 'package', initial: 0, pkg: { price: 100, uses: 0 } });
  await A.put('/wallets/bank', { name: 'Bank', type: 'bank', initial: 0, pkg: { price: 1, uses: 1 } });
  // Paying: a transfer into the package. One use: an expense of 800 out of it.
  await A.post('/expenses', { id: crypto.randomUUID(), type: 'transfer', amount: 16000, walletId: 'cash', toWalletId: 'gym', date: '2026-11-03' });
  await A.post('/expenses', { id: crypto.randomUUID(), type: 'expense', amount: 800, walletId: 'gym', category: 'fitness', date: '2026-11-03' });
  const bs = await A.get('/bootstrap');
  const w = (id) => bs.wallets.find((x) => x.id === id);
  assert.deepEqual(w('gym').pkg, { price: 16000, uses: 20, category: 'fitness', merchant: 'เพลย์กราวด์' });
  assert.equal(w('bad').pkg, undefined);
  assert.equal(w('bank').pkg, undefined);
  const spent = bs.expenses.filter((e) => e.type === 'expense').reduce((s, e) => s + Number(e.amount), 0);
  assert.equal(spent, 800);
});
