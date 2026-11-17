// Investment portfolio API end to end: trades are saved, validated and kept per person.
// Needs a running API (API_URL) on a disposable database, like acc-api.test.js.
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

test('signed out gets 401', async () => {
  assert.equal((await agent().get('/invest/trades')).status, 401);
});

test('trades are saved, edited, deleted and private to their owner', async () => {
  await A.post('/auth/register', { email: `inv${run}@t.dev`, password: 'password-a', name: 'A' });
  await B.post('/auth/register', { email: `invb${run}@t.dev`, password: 'password-b', name: 'B' });
  const buy = await A.post('/invest/trades', { symbol: 'ptt.bk', tv: 'SET:PTT', name: 'PTT', kind: 'buy', date: '2026-11-10', qty: 100, price: 38.25, fee: 6.43 });
  assert.equal(buy.status, 200);
  assert.equal(buy.trade.symbol, 'PTT.BK');
  assert.equal(buy.trade.currency, 'THB');
  const us = await A.post('/invest/trades', { symbol: 'AAPL', tv: 'NASDAQ:AAPL', kind: 'buy', date: '2026-11-10', qty: 0.5, price: 354.2 });
  assert.equal(us.trade.currency, 'USD');
  assert.equal(us.trade.qty, 0.5);
  const bare = await A.post('/invest/trades', { symbol: 'TLN', tv: 'TLN', kind: 'buy', date: '2026-11-10', qty: 1, price: 351.2 });
  assert.equal(bare.status, 200);
  assert.equal(bare.trade.currency, 'USD');
  assert.equal((await A.del(`/invest/trades/${bare.trade.id}`)).ok, true);
  const div = await A.post('/invest/trades', { symbol: 'PTT.BK', tv: 'SET:PTT', kind: 'div', date: '2026-11-11', qty: 5, price: 140, fee: 14 });
  assert.equal(div.trade.qty, 0);

  assert.equal((await A.post('/invest/trades', { symbol: 'PTT.BK', tv: 'SET:PTT', kind: 'buy', date: '2026-11-10', qty: 0, price: 1 })).error, 'bad_qty');
  assert.equal((await A.post('/invest/trades', { symbol: 'PTT.BK', tv: 'NOT A SYMBOL', kind: 'buy', date: '2026-11-10', qty: 1, price: 1 })).error, 'bad_symbol');
  assert.equal((await A.post('/invest/trades', { symbol: 'PTT.BK', tv: 'SET:PTT', kind: 'hold', date: '2026-11-10', qty: 1, price: 1 })).error, 'bad_kind');
  assert.equal((await A.post('/invest/trades', { symbol: 'PTT.BK', tv: 'SET:PTT', kind: 'buy', date: 'x', qty: 1, price: 1 })).error, 'bad_date');

  const listA = await A.get('/invest/trades');
  assert.equal(listA.trades.length, 3);
  assert.equal((await B.get('/invest/trades')).trades.length, 0);
  assert.equal((await B.put(`/invest/trades/${buy.trade.id}`, { symbol: 'PTT.BK', tv: 'SET:PTT', kind: 'buy', date: '2026-11-10', qty: 1, price: 1 })).status, 404);
  assert.equal((await B.del(`/invest/trades/${buy.trade.id}`)).status, 404);

  const ed = await A.put(`/invest/trades/${buy.trade.id}`, { symbol: 'PTT.BK', tv: 'SET:PTT', kind: 'buy', date: '2026-11-09', qty: 200, price: 38, fee: 12 });
  assert.equal(ed.trade.qty, 200);
  assert.equal(ed.trade.date, '2026-11-09');
  assert.equal((await A.del(`/invest/trades/${us.trade.id}`)).ok, true);
  assert.equal((await A.get('/invest/trades')).trades.length, 2);
});

test('quotes take a list and ignore junk', async () => {
  const r = await A.get('/invest/quotes?s=' + encodeURIComponent('bad symbol!,'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.quotes, {});
});
