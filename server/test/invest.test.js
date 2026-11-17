// Investment portfolio: price sources, caching, symbol mapping and the portfolio maths.
// Unit tests, no API or network needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tvSymbol, yahooQuote, tvQuotes, quotes, search, history, FRESH_MS } from '../src/invest.js';

const Port = createRequire(import.meta.url)('../../invest/port.js');
const json = (body) => ({ ok: true, json: async () => body });
const NOW = new Date('2026-11-11T08:00:00Z');

const yahoo = (price, prev, extra = {}) => json({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev, currency: 'THB', longName: 'PTT Public Company Limited', regularMarketTime: 1794389705, ...extra } }] } });

function fakeDb() {
  const rows = new Map();
  return {
    rows,
    query: async (sql, p) => {
      if (sql.startsWith('select')) return { rows: p[0].map((s) => rows.get(s)).filter(Boolean) };
      const r = { symbol: p[0], price: p[1], prev_close: p[2], currency: p[3], name: p[4], src: p[5], market_at: p[6], at: p[7] };
      rows.set(p[0], r);
      return { rows: [r] };
    },
  };
}

test('Yahoo symbols map to TradingView symbols, SET and US only', () => {
  assert.equal(tvSymbol('PTT.BK', 'SET'), 'SET:PTT');
  assert.equal(tvSymbol('AAPL', 'NMS'), 'NASDAQ:AAPL');
  assert.equal(tvSymbol('KO', 'NYQ'), 'NYSE:KO');
  assert.equal(tvSymbol('VOO', 'PCX'), 'AMEX:VOO');
  assert.equal(tvSymbol('BRK-B', 'NYQ'), 'NYSE:BRK.B');
  assert.equal(tvSymbol('7203.T', 'JPX'), null);
  assert.equal(tvSymbol('PTT', 'SET'), null);
});

test('Yahoo chart meta becomes a quote', async () => {
  const q = await yahooQuote('PTT.BK', async (url) => { assert.match(url, /chart\/PTT\.BK\?/); return yahoo(38.25, 38); });
  assert.deepEqual(q, { price: 38.25, prevClose: 38, currency: 'THB', name: 'PTT Public Company Limited', marketAt: new Date(1794389705000).toISOString(), src: 'yahoo' });
  assert.equal(await yahooQuote('X', async () => ({ ok: false })), null);
  assert.equal(await yahooQuote('X', async () => { throw new Error('down'); }), null);
});

test('TradingView scanner answers many symbols, previous close from the day change', async () => {
  let body;
  const out = await tvQuotes([{ symbol: 'PTT.BK', tv: 'SET:PTT' }, { symbol: 'AAPL', tv: 'NASDAQ:AAPL' }], async (url, init) => {
    body = JSON.parse(init.body);
    return json({ data: [{ s: 'SET:PTT', d: [38.25, 0.6578947368421052, 'THB', 'PTT'] }, { s: 'NASDAQ:AAPL', d: [0, 0, 'USD', 'Apple'] }] });
  });
  assert.deepEqual(body.symbols.tickers, ['SET:PTT', 'NASDAQ:AAPL']);
  assert.equal(out['PTT.BK'].price, 38.25);
  assert.equal(out['PTT.BK'].prevClose, 38);
  assert.equal(out['PTT.BK'].src, 'tradingview');
  assert.equal(out.AAPL, undefined);
});

test('prices are cached 15 minutes, Yahoo first, TradingView when Yahoo fails, stale kept', async () => {
  const db = fakeDb();
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (url.includes('PTT.BK')) return yahoo(38.25, 38);
    if (url.includes('scanner')) return json({ data: [{ s: 'NASDAQ:AAPL', d: [354.6, 1, 'USD', 'Apple'] }] });
    return { ok: false };
  };
  const wants = [{ symbol: 'PTT.BK', tv: 'SET:PTT' }, { symbol: 'AAPL', tv: 'NASDAQ:AAPL' }, { symbol: 'ZZZZ', tv: null }];
  const a = await quotes(wants, { fetchImpl: f, db, now: NOW });
  assert.equal(a['PTT.BK'].src, 'yahoo');
  assert.equal(a.AAPL.src, 'tradingview');
  assert.equal(a.ZZZZ, undefined);
  const n = calls.length;
  const b = await quotes(wants.slice(0, 2), { fetchImpl: f, db, now: new Date(NOW.getTime() + FRESH_MS - 1000) });
  assert.equal(calls.length, n, 'fresh rows are not fetched again');
  assert.equal(b['PTT.BK'].price, 38.25);
  const c = await quotes([wants[0]], { fetchImpl: async () => ({ ok: false }), db, now: new Date(NOW.getTime() + FRESH_MS + 1000) });
  assert.equal(c['PTT.BK'].stale, true);
  assert.equal(c['PTT.BK'].price, 38.25);
});

test('search keeps stocks and ETFs on SET and US exchanges', async () => {
  const r = await search('ptt', async () => json({ quotes: [
    { symbol: 'PTTRX', longname: 'PIMCO', exchange: 'NAS', quoteType: 'MUTUALFUND' },
    { symbol: 'PTT.BK', longname: 'PTT Public Company Limited', exchange: 'SET', exchDisp: 'SET', quoteType: 'EQUITY' },
    { symbol: 'VOO', shortname: 'Vanguard S&P 500 ETF', exchange: 'PCX', exchDisp: 'NYSEArca', quoteType: 'ETF' },
    { symbol: 'SAAPL=F', exchange: 'CME', quoteType: 'FUTURE' },
  ] }));
  assert.deepEqual(r.map((x) => [x.symbol, x.tv, x.market, x.currency, x.type]), [
    ['PTT.BK', 'SET:PTT', 'SET', 'THB', 'stock'], ['VOO', 'AMEX:VOO', 'US', 'USD', 'ETF']]);
});

test('average cost, realised profit, dividends and baht totals', () => {
  const trades = [
    { symbol: 'PTT.BK', tv: 'SET:PTT', currency: 'THB', kind: 'buy', date: '2026-01-05', qty: 100, price: 30, fee: 10 },
    { symbol: 'PTT.BK', tv: 'SET:PTT', currency: 'THB', kind: 'buy', date: '2026-02-05', qty: 100, price: 40, fee: 10 },
    { symbol: 'PTT.BK', tv: 'SET:PTT', currency: 'THB', kind: 'sell', date: '2026-03-05', qty: 50, price: 45, fee: 5 },
    { symbol: 'PTT.BK', tv: 'SET:PTT', currency: 'THB', kind: 'div', date: '2026-04-05', qty: 0, price: 300, fee: 30 },
    { symbol: 'AAPL', tv: 'NASDAQ:AAPL', currency: 'USD', kind: 'buy', date: '2026-01-10', qty: 2, price: 100, fee: 0 },
    { symbol: 'KO', tv: 'NYSE:KO', currency: 'USD', kind: 'buy', date: '2026-01-10', qty: 1, price: 60, fee: 0 },
    { symbol: 'KO', tv: 'NYSE:KO', currency: 'USD', kind: 'sell', date: '2026-02-10', qty: 1, price: 70, fee: 0 },
  ];
  const pos = Port.positions(trades);
  const ptt = pos.find((p) => p.symbol === 'PTT.BK');
  assert.equal(ptt.qty, 150);
  assert.equal(ptt.cost, 5265); // 7020 total cost, 35.10 average, 50 sold take out 1755
  assert.equal(ptt.realized, 490); // 50 × 45 − 5 − 1755
  assert.equal(ptt.dividends, 270);
  const ko = pos.find((p) => p.symbol === 'KO');
  assert.equal(ko.qty, 0);
  assert.equal(ko.realized, 10);

  const quotes = { 'PTT.BK': { price: 38, prevClose: 37 }, AAPL: { price: 110, prevClose: 100 } };
  const fx = { USD: 33 };
  const v = pos.map((p) => Port.value(p, quotes, fx));
  const vp = v.find((p) => p.symbol === 'PTT.BK');
  assert.equal(vp.value, 5700);
  assert.equal(vp.pl, 435);
  assert.equal(vp.day, 150);
  const va = v.find((p) => p.symbol === 'AAPL');
  assert.equal(va.thb.value, 7260);
  assert.equal(va.thb.pl, 660);
  const t = Port.totals(v);
  assert.equal(t.value, 12960);
  assert.equal(t.cost, 5265 + 6600);
  assert.equal(t.pl, 1095);
  assert.equal(t.day, 150 + 660);
  assert.equal(t.realized, 490 + 330);
  assert.equal(t.dividends, 270);
  assert.equal(t.missing, 0);
});

test('a stock with no price counts at cost and is flagged', () => {
  const pos = Port.positions([{ symbol: 'NEW.BK', tv: 'SET:NEW', currency: 'THB', kind: 'buy', date: '2026-01-01', qty: 10, price: 5, fee: 0 }]);
  const t = Port.totals(pos.map((p) => Port.value(p, {}, {})));
  assert.equal(t.value, 50);
  assert.equal(t.missing, 1);
  assert.equal(t.pl, 0);
});

test('history gives closing points, skips gaps, and is cached for an hour', async () => {
  let n = 0;
  const f = async (url) => { n += 1; assert.match(url, /range=5y&interval=1wk/); return json({ chart: { result: [{ meta: { currency: 'THB' }, timestamp: [1, 2, 3], indicators: { quote: [{ close: [30, null, 31.256789] }] } }] } }); };
  const h = await history('PTT.BK', '5y', { fetchImpl: f, now: 1000 });
  assert.deepEqual(h.points, [[1, 30], [3, 31.2568]]);
  await history('PTT.BK', '5y', { fetchImpl: f, now: 1000 + 59 * 60000 });
  assert.equal(n, 1);
  assert.equal(await history('X', '1y', { fetchImpl: async () => ({ ok: false }) }), null);
});

test('EODHD: search keeps SET and US stocks / ETFs, tickers map both ways', async () => {
  const urls = [];
  const f = async (url) => {
    urls.push(url);
    if (url.includes('/search/')) return json([
      { Code: 'TLN', Exchange: 'US', Name: 'Talen Energy Corp', Type: 'Common Stock' },
      { Code: 'PTT', Exchange: 'BK', Name: 'PTT Public Company Limited', Type: 'Common Stock' },
      { Code: 'TLN', Exchange: 'F', Name: 'Talen (Frankfurt)', Type: 'Common Stock' },
      { Code: 'VOO', Exchange: 'US', Name: 'Vanguard S&P 500', Type: 'ETF' },
      { Code: 'BRK-B', Exchange: 'US', Name: 'Berkshire B', Type: 'Common Stock' },
      { Code: 'XFUND', Exchange: 'US', Name: 'Some fund', Type: 'FUND' },
    ]);
    return { ok: false };
  };
  const r = await search('tln', f, 'k');
  assert.match(urls[0], /^https:\/\/eodhd\.com\/api\/search\/tln\?api_token=k&fmt=json/);
  assert.deepEqual(r.map((x) => [x.symbol, x.tv, x.market, x.currency, x.type]), [
    ['TLN', 'TLN', 'US', 'USD', 'stock'], ['PTT.BK', 'SET:PTT', 'SET', 'THB', 'stock'],
    ['VOO', 'VOO', 'US', 'USD', 'ETF'], ['BRK-B', 'BRK.B', 'US', 'USD', 'stock']]);
  assert.equal(await search('tln', async () => ({ ok: false, status: 429 }), 'k'), null);
  assert.equal(await search('tln', async () => ({ ok: false, status: 429 }), ''), null);
});

test('EODHD: quotes in one call, closed market falls back to previous close', async () => {
  const db = fakeDb();
  let url;
  const f = async (u) => {
    url = u;
    return json([
      { code: 'PTT.BK', timestamp: 1794389705, close: 38.25, previousClose: 38 },
      { code: 'TLN.US', timestamp: 1794389705, close: 'NA', previousClose: 351.2 },
    ]);
  };
  const out = await quotes([{ symbol: 'PTT.BK', tv: 'SET:PTT' }, { symbol: 'TLN', tv: 'TLN' }], { fetchImpl: f, db, now: NOW, key: 'k' });
  assert.match(url, /real-time\/PTT\.BK\?api_token=k&fmt=json&s=TLN\.US/);
  assert.equal(out['PTT.BK'].price, 38.25);
  assert.equal(out['PTT.BK'].src, 'eodhd');
  assert.equal(out.TLN.price, 351.2);
  assert.equal(out.TLN.currency, 'USD');
});

test('EODHD: history from the end-of-day API, weekly for 5 years', async () => {
  let url;
  const h = await history('TLN', '5y', { key: 'k', now: Date.parse('2026-11-12T00:00:00Z'), fetchImpl: async (u) => { url = u; return json([{ date: '2026-11-03', close: 340 }, { date: '2026-11-10', close: 351.2 }]); } });
  assert.match(url, /eod\/TLN\.US\?api_token=k&fmt=json&from=2021-11-1\d&period=w/);
  assert.deepEqual(h.points.map((p) => p[1]), [340, 351.2]);
  assert.equal(h.currency, 'USD');
});
