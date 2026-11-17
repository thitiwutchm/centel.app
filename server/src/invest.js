// Investment portfolio (invest.centel.app), mounted at /api/invest. With EODHD_API_KEY set,
// search, prices (15-20 minutes delayed) and history for Thai SET and US stocks come from
// EODHD (eodhd.com, a paid API with a key). Without it they come from Yahoo Finance's public
// endpoints (no key, unofficial; Yahoo answers 429 to servers it rate-limits), with
// TradingView's scanner as the backup for prices. Prices are kept in inv_prices for
// 15 minutes so the page never makes us call Yahoo more than that. Trades run as app_user
// (asUser), so the row level security in migrations/038_invest.sql keeps them per person.
import express from 'express';
import { pool, asUser } from './db.js';
import { requireUser, rateLimit } from './auth.js';

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const str = (v, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

export const FRESH_MS = 15 * 60000;
const TIMEOUT = 8000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
export const SYMBOL = /^[A-Z0-9][A-Z0-9.&-]{0,19}$/;
// Exchange-prefixed (SET:PTT, NASDAQ:AAPL), or bare for a US stock whose exchange EODHD's search
// doesn't say (TradingView's widgets resolve TLN on their own).
export const TV = /^([A-Z]{2,8}:)?[A-Z0-9.&_-]{1,20}$/;
const tvPrefixed = (tv) => typeof tv === 'string' && tv.includes(':');
const eodKey = () => process.env.EODHD_API_KEY || '';

// Yahoo exchange code → TradingView exchange prefix. Only these markets are offered.
const EXCH = {
  SET: 'SET',
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ',
  NYQ: 'NYSE', NYS: 'NYSE',
  PCX: 'AMEX', ASE: 'AMEX', NYM: 'AMEX',
  BTS: 'CBOE',
};

// PTT.BK + SET → SET:PTT, AAPL + NMS → NASDAQ:AAPL, BRK-B → NYSE:BRK.B. null when not a market we cover.
export function tvSymbol(symbol, exchange) {
  const ex = EXCH[String(exchange || '').toUpperCase()];
  if (!ex) return null;
  let s = String(symbol || '').toUpperCase();
  if (ex === 'SET') {
    if (!s.endsWith('.BK')) return null;
    s = s.slice(0, -3);
  } else s = s.replace(/-/g, '.');
  const out = `${ex}:${s}`;
  return TV.test(out) ? out : null;
}

async function getJson(url, fetchImpl, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetchImpl(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA, ...(init.headers || {}) } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

const good = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

// One symbol from Yahoo's chart endpoint: { price, prevClose, currency, name, marketAt }.
export async function yahooQuote(symbol, fetchImpl = fetch) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, fetchImpl);
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || !good(m.regularMarketPrice)) return null;
  return {
    price: m.regularMarketPrice,
    prevClose: good(m.chartPreviousClose) ? m.chartPreviousClose : good(m.previousClose) ? m.previousClose : null,
    currency: typeof m.currency === 'string' ? m.currency.toUpperCase().slice(0, 3) : null,
    name: str(m.longName || m.shortName, 120),
    marketAt: Number.isFinite(m.regularMarketTime) ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    src: 'yahoo',
  };
}

// Many symbols at once from TradingView's scanner (the screener's own endpoint). wants is
// [{ symbol, tv }]; answers keyed by Yahoo symbol.
export async function tvQuotes(wants, fetchImpl = fetch) {
  if (!wants.length) return {};
  const j = await getJson('https://scanner.tradingview.com/global/scan', fetchImpl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: wants.map((w) => w.tv) }, columns: ['close', 'change', 'currency', 'description'] }),
  });
  const out = {};
  for (const row of Array.isArray(j?.data) ? j.data : []) {
    const w = wants.find((x) => x.tv === row.s);
    const [close, change, currency, description] = Array.isArray(row.d) ? row.d : [];
    if (!w || !good(close)) continue;
    // change is today's percent move, so yesterday's close is close / (1 + change%).
    const prev = Number.isFinite(change) && change > -100 ? close / (1 + change / 100) : null;
    out[w.symbol] = {
      price: close,
      prevClose: good(prev) ? Math.round(prev * 1e6) / 1e6 : null,
      currency: typeof currency === 'string' ? currency.toUpperCase().slice(0, 3) : null,
      name: str(description, 120),
      marketAt: null,
      src: 'tradingview',
    };
  }
  return out;
}

const rowOut = (r) => ({
  symbol: r.symbol, price: Number(r.price), prevClose: r.prev_close == null ? null : Number(r.prev_close),
  currency: r.currency, name: r.name, src: r.src, marketAt: r.market_at, at: r.at,
});

// Prices for [{ symbol, tv }]: fresh cached rows as they are, the rest fetched (Yahoo, a few
// at a time; whatever Yahoo misses goes to TradingView in one call). A symbol nobody answers
// keeps its last stored price, marked stale.
export async function quotes(wants, { fetchImpl = fetch, db = pool, now = new Date(), key = eodKey() } = {}) {
  const syms = wants.map((w) => w.symbol);
  const have = new Map((await db.query('select * from inv_prices where symbol = any($1)', [syms])).rows.map((r) => [r.symbol, r]));
  const out = {};
  const need = [];
  for (const w of wants) {
    const r = have.get(w.symbol);
    if (r && now.getTime() - new Date(r.at).getTime() < FRESH_MS) out[w.symbol] = rowOut(r);
    else need.push(w);
  }
  const got = key && need.length ? await eodQuotes(need.map((w) => w.symbol), key, fetchImpl) : {};
  for (let i = 0; i < need.length && !key; i += 5) {
    const part = need.slice(i, i + 5);
    const res = await Promise.all(part.map((w) => yahooQuote(w.symbol, fetchImpl)));
    part.forEach((w, k) => { if (res[k]) got[w.symbol] = res[k]; });
  }
  const missing = need.filter((w) => !got[w.symbol] && tvPrefixed(w.tv));
  if (missing.length) Object.assign(got, await tvQuotes(missing, fetchImpl));
  for (const w of need) {
    const q = got[w.symbol];
    if (q) {
      const r = (await db.query(
        `insert into inv_prices (symbol, price, prev_close, currency, name, src, market_at, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (symbol) do update set price = excluded.price, prev_close = excluded.prev_close,
           currency = coalesce(excluded.currency, inv_prices.currency), name = coalesce(inv_prices.name, excluded.name),
           src = excluded.src, market_at = excluded.market_at, at = excluded.at
         returning *`,
        [w.symbol, q.price, q.prevClose, q.currency, q.name, q.src, q.marketAt, now])).rows[0];
      out[w.symbol] = rowOut(r || { symbol: w.symbol, ...q, prev_close: q.prevClose, market_at: q.marketAt, at: now });
    } else if (have.get(w.symbol)) {
      out[w.symbol] = { ...rowOut(have.get(w.symbol)), stale: true };
    }
  }
  return out;
}

// Symbol search, kept to stocks and ETFs on SET and the US exchanges.
export async function search(q, fetchImpl = fetch, key = eodKey()) {
  return key ? eodSearch(q, key, fetchImpl) : yahooSearch(q, fetchImpl);
}

async function yahooSearch(q, fetchImpl) {
  const j = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0`, fetchImpl);
  if (!j) return null;
  const out = [];
  for (const x of Array.isArray(j?.quotes) ? j.quotes : []) {
    if (!['EQUITY', 'ETF'].includes(x.quoteType)) continue;
    const symbol = String(x.symbol || '').toUpperCase();
    const tv = tvSymbol(symbol, x.exchange);
    if (!tv || !SYMBOL.test(symbol)) continue;
    out.push({
      symbol, tv, name: str(x.longname || x.shortname, 120) || symbol,
      market: tv.startsWith('SET:') ? 'SET' : 'US', currency: tv.startsWith('SET:') ? 'THB' : 'USD',
      type: x.quoteType === 'ETF' ? 'ETF' : 'stock', exchange: str(x.exchDisp, 40),
    });
  }
  return out;
}

// Closing prices over a range, for the page's own chart. TradingView's free widgets refuse
// SET symbols ("only available on TradingView"), so Thai stocks are drawn from this instead.
export const RANGES = { '1mo': '1d', '6mo': '1d', '1y': '1d', '5y': '1wk' };
const histCache = new Map();
export async function history(symbol, range, { fetchImpl = fetch, now = Date.now(), key: apiKey = eodKey() } = {}) {
  const key = `${symbol}|${range}`;
  const hit = histCache.get(key);
  if (hit && now - hit.at < 60 * 60000) return hit.value;
  const value = apiKey ? await eodHistory(symbol, range, apiKey, fetchImpl, now) : await yahooHistory(symbol, range, fetchImpl);
  if (!value) return null;
  if (histCache.size > 400) histCache.clear();
  histCache.set(key, { at: now, value });
  return value;
}

async function yahooHistory(symbol, range, fetchImpl) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${RANGES[range]}`, fetchImpl);
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(cl)) return null;
  const points = [];
  ts.forEach((t, i) => { if (Number.isFinite(t) && good(cl[i])) points.push([t, Math.round(cl[i] * 1e4) / 1e4]); });
  if (!points.length) return null;
  return { symbol, range, currency: r.meta?.currency || null, points };
}

/* ---------- EODHD ---------- */
// Our symbols are Yahoo-style (PTT.BK, AAPL, BRK-B); EODHD wants PTT.BK, AAPL.US, BRK-B.US.
export const eodTicker = (symbol) => (symbol.endsWith('.BK') ? symbol : `${symbol}.US`);
const fromEod = (code) => (code.endsWith('.BK') ? code : code.replace(/\.US$/, ''));
const eodUrl = (path, key, params = '') => `https://eodhd.com/api/${path}?api_token=${encodeURIComponent(key)}&fmt=json${params}`;

// Delayed live prices, 20 tickers a call (each ticker costs one API call either way).
export async function eodQuotes(symbols, key, fetchImpl = fetch) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 20) {
    const part = symbols.slice(i, i + 20).map(eodTicker);
    const j = await getJson(eodUrl(`real-time/${encodeURIComponent(part[0])}`, key, part.length > 1 ? `&s=${encodeURIComponent(part.slice(1).join(','))}` : ''), fetchImpl);
    for (const x of Array.isArray(j) ? j : j ? [j] : []) {
      const code = String(x?.code || '').toUpperCase();
      // Outside trading hours close can be 'NA'; the previous close is still the last price.
      const close = good(Number(x.close)) ? Number(x.close) : good(Number(x.previousClose)) ? Number(x.previousClose) : null;
      if (!code || close == null) continue;
      out[fromEod(code)] = {
        price: close,
        prevClose: good(Number(x.previousClose)) ? Number(x.previousClose) : null,
        currency: code.endsWith('.BK') ? 'THB' : 'USD',
        name: null,
        marketAt: Number.isFinite(x.timestamp) ? new Date(x.timestamp * 1000).toISOString() : null,
        src: 'eodhd',
      };
    }
  }
  return out;
}

export async function eodSearch(q, key, fetchImpl = fetch) {
  const j = await getJson(eodUrl(`search/${encodeURIComponent(q)}`, key, '&limit=30'), fetchImpl);
  if (!Array.isArray(j)) return null;
  const out = [];
  for (const x of Array.isArray(j) ? j : []) {
    const ex = String(x.Exchange || '').toUpperCase();
    if (ex !== 'BK' && ex !== 'US') continue;
    if (!['Common Stock', 'ETF', 'Preferred Stock'].includes(x.Type)) continue;
    const code = String(x.Code || '').toUpperCase();
    const symbol = ex === 'BK' ? `${code}.BK` : code;
    const tv = ex === 'BK' ? `SET:${code}` : code.replace(/-/g, '.');
    if (!SYMBOL.test(symbol) || !TV.test(tv) || out.some((o) => o.symbol === symbol)) continue;
    out.push({
      symbol, tv, name: str(x.Name, 120) || symbol,
      market: ex === 'BK' ? 'SET' : 'US', currency: ex === 'BK' ? 'THB' : 'USD',
      type: x.Type === 'ETF' ? 'ETF' : 'stock', exchange: ex === 'BK' ? 'SET' : 'US',
    });
    if (out.length >= 12) break;
  }
  return out;
}

const RANGE_DAYS = { '1mo': 31, '6mo': 183, '1y': 366, '5y': 1827 };
export async function eodHistory(symbol, range, key, fetchImpl = fetch, now = Date.now()) {
  const from = new Date(now - RANGE_DAYS[range] * 86400000).toISOString().slice(0, 10);
  const j = await getJson(eodUrl(`eod/${encodeURIComponent(eodTicker(symbol))}`, key, `&from=${from}&period=${range === '5y' ? 'w' : 'd'}`), fetchImpl);
  const points = [];
  for (const x of Array.isArray(j) ? j : []) {
    const t = Date.parse(`${x.date}T00:00:00Z`) / 1000;
    if (Number.isFinite(t) && good(Number(x.close))) points.push([t, Math.round(Number(x.close) * 1e4) / 1e4]);
  }
  if (!points.length) return null;
  return { symbol, range, currency: symbol.endsWith('.BK') ? 'THB' : 'USD', points };
}

/* ---------- Routes ---------- */

router.use(requireUser);
const tx = (req, fn) => asUser(req.user.id, fn);

// Which source the prices come from, so the page can say so.
router.get('/source', (_req, res) => res.json({ source: eodKey() ? 'eodhd' : 'yahoo' }));

router.get('/search', rateLimit(300, 60 * 60000), wrap(async (req, res) => {
  const q = str(req.query.q, 40);
  if (!q) return res.json({ results: [] });
  const results = await search(q);
  // The source refused or is down: say so, rather than "nothing found".
  if (!results) throw bad('search_unavailable', 503);
  res.json({ results });
}));

// ?s=PTT.BK~SET:PTT,AAPL~NASDAQ:AAPL (the TradingView half lets the backup source answer too).
router.get('/quotes', rateLimit(600, 60 * 60000), wrap(async (req, res) => {
  const wants = [];
  for (const part of String(req.query.s || '').split(',').slice(0, 60)) {
    const [s, t] = part.split('~');
    const symbol = String(s || '').trim().toUpperCase();
    const tv = String(t || '').trim().toUpperCase();
    if (SYMBOL.test(symbol) && !wants.some((w) => w.symbol === symbol)) wants.push({ symbol, tv: TV.test(tv) ? tv : null });
  }
  res.set('Cache-Control', 'no-store').json({ quotes: await quotes(wants) });
}));

router.get('/history', rateLimit(600, 60 * 60000), wrap(async (req, res) => {
  const symbol = String(req.query.s || '').trim().toUpperCase();
  const range = String(req.query.range || '1y');
  if (!SYMBOL.test(symbol) || !RANGES[range]) throw bad('bad_request');
  const h = await history(symbol, range);
  if (!h) throw bad('history_unavailable', 503);
  res.json(h);
}));

const tradeOut = (t) => ({
  id: t.id, symbol: t.symbol, tv: t.tv, name: t.name, currency: t.currency, kind: t.kind, date: t.date,
  qty: Number(t.qty), price: Number(t.price), fee: Number(t.fee), note: t.note, createdAt: t.created_at,
});

function readTrade(b) {
  const symbol = String(b.symbol || '').trim().toUpperCase();
  const tv = String(b.tv || '').trim().toUpperCase();
  if (!SYMBOL.test(symbol) || !TV.test(tv)) throw bad('bad_symbol');
  const kind = ['buy', 'sell', 'div'].includes(b.kind) ? b.kind : null;
  if (!kind) throw bad('bad_kind');
  const currency = symbol.endsWith('.BK') ? 'THB' : 'USD';
  const date = isDate(b.date) ? b.date : null;
  if (!date) throw bad('bad_date');
  const qty = kind === 'div' ? 0 : Math.round(Number(b.qty) * 1e6) / 1e6;
  const price = Math.round(Number(b.price) * 1e6) / 1e6;
  const fee = Math.round(Number(b.fee || 0) * 100) / 100;
  if (kind !== 'div' && !(qty > 0 && qty < 1e11)) throw bad('bad_qty');
  if (!(price >= 0 && price < 1e11) || (kind === 'div' && !(price > 0))) throw bad('bad_price');
  if (!(fee >= 0 && fee < 1e10)) throw bad('bad_fee');
  return { symbol, tv, name: str(b.name, 120), currency, kind, date, qty, price, fee, note: str(b.note, 300) };
}

router.get('/trades', wrap(async (req, res) => {
  const rows = await tx(req, async (db) => (await db.query('select * from inv_trades order by date, created_at')).rows);
  res.json({ trades: rows.map(tradeOut), user: { email: req.user.email, name: req.user.display_name } });
}));

router.post('/trades', rateLimit(600, 60 * 60000), wrap(async (req, res) => {
  const t = readTrade(req.body || {});
  const row = await tx(req, async (db) => {
    const n = (await db.query('select count(*)::int as n from inv_trades')).rows[0].n;
    if (n >= 5000) throw bad('too_many_trades', 409);
    return (await db.query(
      `insert into inv_trades (symbol, tv, name, currency, kind, date, qty, price, fee, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [t.symbol, t.tv, t.name, t.currency, t.kind, t.date, t.qty, t.price, t.fee, t.note])).rows[0];
  });
  res.json({ trade: tradeOut(row) });
}));

router.put('/trades/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const t = readTrade(req.body || {});
  const row = await tx(req, async (db) => (await db.query(
    `update inv_trades set symbol = $2, tv = $3, name = $4, currency = $5, kind = $6, date = $7, qty = $8, price = $9, fee = $10, note = $11
     where id = $1 returning *`,
    [req.params.id, t.symbol, t.tv, t.name, t.currency, t.kind, t.date, t.qty, t.price, t.fee, t.note])).rows[0]);
  if (!row) throw bad('not_found', 404);
  res.json({ trade: tradeOut(row) });
}));

router.delete('/trades/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('not_found', 404);
  const n = await tx(req, async (db) => (await db.query('delete from inv_trades where id = $1', [req.params.id])).rowCount);
  if (!n) throw bad('not_found', 404);
  res.json({ ok: true });
}));

export default router;
