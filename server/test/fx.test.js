// Exchange rates: source order, caching and the stored fx shape. Unit tests, no API needed
// (except the last one, which saves a converted expense through a running API at API_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { rateFor, readFx, bangkokToday, fetchRate } from '../src/fx.js';

const NOW = new Date('2026-11-07T05:00:00Z');
const json = (body) => ({ ok: true, json: async () => body });

function fakeFetch(answers) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    for (const [part, body] of answers) if (url.includes(part)) return body === 404 ? { ok: false } : json(body);
    return { ok: false };
  };
  f.calls = calls;
  return f;
}

function fakeDb() {
  const rows = new Map();
  return {
    rows,
    query: async (sql, p) => {
      if (sql.startsWith('select')) {
        const r = rows.get(`${p[0]}|${p[1]}`);
        return { rows: r ? [r] : [] };
      }
      rows.set(`${p[0]}|${p[1]}`, { rate: String(p[2]), rate_date: p[3], src: p[4] });
      return { rows: [] };
    },
  };
}

test('Bangkok today is UTC+7', () => {
  assert.equal(bangkokToday(new Date('2026-11-06T17:30:00Z')), '2026-11-07');
  assert.equal(bangkokToday(new Date('2026-11-06T16:30:00Z')), '2026-11-06');
});

test('Bank of Thailand first, then Frankfurter blend, then fawazahmed0', async () => {
  const bot = fakeFetch([['providers=bot', [{ date: '2026-10-30', base: 'USD', quote: 'THB', rate: 33.7215 }]]]);
  assert.deepEqual(await fetchRate('USD', '2026-11-01', bot), { rate: 33.7215, rateDate: '2026-10-30', src: 'bot' });
  assert.equal(bot.calls.length, 1);

  const vnd = fakeFetch([['providers=bot', []], ['frankfurter.dev', [{ date: '2026-11-06', base: 'VND', quote: 'THB', rate: 0.0013057 }]]]);
  assert.deepEqual(await fetchRate('VND', '2026-11-06', vnd), { rate: 0.0013057, rateDate: '2026-11-06', src: 'frankfurter' });

  const rare = fakeFetch([['frankfurter.dev', []], ['jsdelivr', { date: '2026-11-06', mvr: { thb: 2.17 } }]]);
  assert.deepEqual(await fetchRate('MVR', '2026-11-06', rare), { rate: 2.17, rateDate: '2026-11-06', src: 'fawaz' });

  assert.equal(await fetchRate('XYZ', '2026-11-06', fakeFetch([])), null);
});

test('settled days are stored and reused; recent days only kept in memory', async () => {
  const db = fakeDb();
  const f = fakeFetch([['providers=bot', [{ date: '2026-10-15', base: 'JPY', quote: 'THB', rate: 0.212571 }]]]);
  const a = await rateFor('jpy', '2026-10-15', { fetchImpl: f, db, now: NOW });
  assert.deepEqual(a, { currency: 'JPY', day: '2026-10-15', rate: 0.212571, rateDate: '2026-10-15', src: 'bot' });
  assert.equal(db.rows.size, 1);
  const b = await rateFor('JPY', '2026-10-15', { fetchImpl: f, db, now: NOW });
  assert.equal(b.rate, 0.212571);
  assert.equal(f.calls.length, 1, 'second ask comes from the table');

  // Yesterday can still change at the evening publication: not stored.
  const y = fakeFetch([['providers=bot', [{ date: '2026-11-05', base: 'EUR', quote: 'THB', rate: 37.5 }]]]);
  await rateFor('EUR', '2026-11-06', { fetchImpl: y, db, now: NOW });
  assert.equal(db.rows.size, 1);
  await rateFor('EUR', '2026-11-06', { fetchImpl: y, db, now: NOW });
  assert.equal(y.calls.length, 1, 'kept in memory for an hour');
});

test('THB, future dates, bad codes and no source', async () => {
  const db = fakeDb();
  assert.equal((await rateFor('THB', '2026-11-01', { db, now: NOW })).rate, 1);
  const f = fakeFetch([['providers=bot', [{ date: '2026-11-06', base: 'GBP', quote: 'THB', rate: 45 }]]]);
  assert.equal((await rateFor('GBP', '2027-01-01', { fetchImpl: f, db, now: NOW })).day, '2026-11-07');
  await assert.rejects(rateFor('baht', '2026-11-01', { db, now: NOW }), /bad_currency/);
  await assert.rejects(rateFor('ZZZ', '2026-10-01', { fetchImpl: fakeFetch([]), db, now: NOW }), /fx_unavailable/);
});

test('readFx keeps a clean conversion and drops anything else', () => {
  assert.deepEqual(readFx({ cur: 'jpy', amt: 1000.004, rate: 0.2126, date: '2026-10-15', src: 'bot', x: 1 }),
    { cur: 'JPY', amt: 1000, rate: 0.2126, date: '2026-10-15', src: 'bot' });
  assert.deepEqual(readFx({ cur: 'USD', amt: 10, rate: 33, fee: 2.5 }), { cur: 'USD', amt: 10, rate: 33, fee: 2.5 });
  assert.equal(readFx({ cur: 'USD', amt: 10, rate: 33, fee: 99 }).fee, undefined);
  assert.equal(readFx({ cur: 'THB', amt: 10, rate: 1 }), null);
  assert.equal(readFx({ cur: 'USD', amt: -1, rate: 33 }), null);
  assert.equal(readFx({ cur: 'USD', amt: 1, rate: 0 }), null);
  assert.equal(readFx('USD'), null);
});

const API = process.env.API_URL;
test('a converted expense keeps its original amount (API)', { skip: !API && 'API_URL not set' }, async () => {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(API + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-centel': '1', cookie },
      body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  await call('POST', '/auth/register', { email: `fx${crypto.randomBytes(4).toString('hex')}@t.dev`, password: 'password-a', name: 'A' });
  const id = crypto.randomUUID(), plain = crypto.randomUUID();
  const fx = { cur: 'JPY', amt: 1000, rate: 0.2126, fee: 2.5, date: '2026-10-15', src: 'bot' };
  assert.equal((await call('POST', '/expenses', { id, type: 'expense', amount: 217.92, date: '2026-10-15', currency: 'JPY', fx })).status, 200);
  assert.equal((await call('POST', '/expenses', { id: plain, type: 'expense', amount: 5, date: '2026-10-15', currency: 'USD' })).status, 200);
  let boot = await call('GET', '/bootstrap');
  let e = boot.expenses.find((x) => x.id === id);
  assert.equal(e.amount, 217.92);
  assert.equal(e.currency, 'THB', 'converted rows are baht');
  assert.deepEqual(e.fx, fx);
  assert.equal(boot.expenses.find((x) => x.id === plain).fx, undefined);
  // Editing without fx (e.g. switched back to baht) clears it.
  await call('PUT', `/expenses/${id}`, { type: 'expense', amount: 200, date: '2026-10-15' });
  boot = await call('GET', '/bootstrap');
  e = boot.expenses.find((x) => x.id === id);
  assert.equal(e.fx, undefined);
  const bad = await call('GET', '/fx?cur=baht');
  assert.equal(bad.status, 400);
});
