// Exchange rates for foreign-currency transactions: how many baht one unit of a currency was
// worth on a day. Tried in order, all free with no key:
//   1. Bank of Thailand (average rate of Thai commercial banks) through Frankfurter, ~20 major currencies
//   2. Frankfurter's blend of central banks, for currencies BOT doesn't publish (VND, LAK…)
//   3. fawazahmed0 currency-api on jsDelivr, 300+ codes
// A weekend or holiday gets the last business day before it. BOT publishes a day's rate in the
// evening, so a slip from earlier today gets yesterday's. Settled days are kept in fx_rates.
import { pool } from './db.js';

const isCode = (c) => /^[A-Z]{3}$/.test(c);
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const TIMEOUT = 8000;

export function bangkokToday(now = new Date()) {
  return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}
const addDays = (day, n) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);

async function getJson(url, fetchImpl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally { clearTimeout(t); }
}

const good = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

// Frankfurter v2: [{ date, base, quote, rate }]; [] when the provider has no such currency.
async function frankfurter(cur, day, bot, fetchImpl) {
  const q = `date=${day}&base=${cur}&quotes=THB${bot ? '&providers=bot' : ''}`;
  const j = await getJson(`https://api.frankfurter.dev/v2/rates?${q}`, fetchImpl);
  const row = Array.isArray(j) ? j.find((x) => x && x.quote === 'THB') : null;
  if (!row || !good(row.rate) || !isDay(String(row.date))) return null;
  return { rate: row.rate, rateDate: row.date, src: bot ? 'bot' : 'frankfurter' };
}

// fawazahmed0: { date, jpy: { thb: 0.21, … } }, one file per day (falls back to its mirror).
async function fawaz(cur, day, fetchImpl) {
  const c = cur.toLowerCase();
  const path = `@fawazahmed0/currency-api@${day}/v1/currencies/${c}.json`;
  const j = (await getJson(`https://cdn.jsdelivr.net/npm/${path}`, fetchImpl))
    || (await getJson(`https://${day}.currency-api.pages.dev/v1/currencies/${c}.json`, fetchImpl));
  const rate = j && j[c] && j[c].thb;
  if (!good(rate)) return null;
  return { rate, rateDate: isDay(String(j.date)) ? j.date : day, src: 'fawaz' };
}

export async function fetchRate(cur, day, fetchImpl = fetch) {
  return (await frankfurter(cur, day, true, fetchImpl))
    || (await frankfurter(cur, day, false, fetchImpl))
    || (await fawaz(cur, day, fetchImpl));
}

// Today's and yesterday's answers can still change (the evening publication), so they're only
// kept in memory for an hour; older days are final and go to the database.
const recent = new Map();

export async function rateFor(curIn, dayIn, { fetchImpl = fetch, db = pool, now = new Date() } = {}) {
  const cur = String(curIn || '').toUpperCase();
  if (!isCode(cur)) throw Object.assign(new Error('bad_currency'), { status: 400, expose: true });
  const today = bangkokToday(now);
  let day = isDay(String(dayIn || '')) ? String(dayIn) : today;
  if (day > today) day = today;
  if (cur === 'THB') return { currency: cur, day, rate: 1, rateDate: day, src: 'same' };
  const settled = day < addDays(today, -1);
  const key = `${cur}|${day}`;
  if (settled) {
    const r = (await db.query('select rate, rate_date, src from fx_rates where currency = $1 and day = $2', [cur, day])).rows[0];
    if (r) return { currency: cur, day, rate: Number(r.rate), rateDate: String(r.rate_date), src: r.src };
  } else {
    const hit = recent.get(key);
    if (hit && now.getTime() - hit.at < 3600000) return hit.value;
  }
  const got = await fetchRate(cur, day, fetchImpl);
  if (!got) throw Object.assign(new Error('fx_unavailable'), { status: 503, expose: true });
  const value = { currency: cur, day, rate: got.rate, rateDate: got.rateDate, src: got.src };
  if (settled) {
    await db.query(
      `insert into fx_rates (currency, day, rate, rate_date, src) values ($1, $2, $3, $4, $5)
       on conflict (currency, day) do nothing`, [cur, day, got.rate, got.rateDate, got.src]);
  } else {
    if (recent.size > 500) recent.clear();
    recent.set(key, { at: now.getTime(), value });
  }
  return value;
}

// A stored conversion on a transaction: { cur, amt, rate, fee, date, src }. amt is what the slip
// said in cur, the row's amount is that in baht (amt × rate, plus fee %). Anything malformed is dropped.
export function readFx(v) {
  if (!v || typeof v !== 'object') return null;
  const cur = String(v.cur || '').toUpperCase();
  const amt = Math.round(Number(v.amt) * 100) / 100, rate = Number(v.rate);
  if (!isCode(cur) || cur === 'THB' || !(amt > 0) || amt > 1e13 || !good(rate) || rate > 1e6) return null;
  const out = { cur, amt, rate };
  // The card / exchange fee added on top of the rate, in percent (the app suggests 2.5).
  const fee = Number(v.fee);
  if (fee > 0 && fee <= 20) out.fee = Math.round(fee * 100) / 100;
  if (isDay(String(v.date || ''))) out.date = String(v.date);
  if (['bot', 'frankfurter', 'fawaz', 'manual'].includes(v.src)) out.src = v.src;
  return out;
}
