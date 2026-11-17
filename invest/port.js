// Portfolio maths for Centel Invest, shared by the page (window.Port) and the tests (require).
// Average cost method: a sell takes out cost at the average price of what was held, and the
// difference is realised profit. A dividend's price is the cash received, its fee the tax withheld.
(function (root) {
  'use strict';
  const r2 = (n) => Math.round(n * 100) / 100;
  const r6 = (n) => Math.round(n * 1e6) / 1e6;

  // trades: rows from /api/invest/trades. Returns one position per symbol, in the stock's own currency.
  function positions(trades) {
    const by = new Map();
    const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.createdAt || '') < String(b.createdAt || '') ? -1 : 1));
    for (const t of sorted) {
      let p = by.get(t.symbol);
      if (!p) {
        p = { symbol: t.symbol, tv: t.tv, name: t.name, currency: t.currency, qty: 0, cost: 0, realized: 0, dividends: 0, fees: 0, trades: [] };
        by.set(t.symbol, p);
      }
      if (t.name) p.name = t.name;
      p.trades.push(t);
      const qty = Number(t.qty) || 0, price = Number(t.price) || 0, fee = Number(t.fee) || 0;
      p.fees += fee;
      if (t.kind === 'buy') {
        p.cost += qty * price + fee;
        p.qty += qty;
      } else if (t.kind === 'sell') {
        const q = Math.min(qty, p.qty);
        const avg = p.qty > 0 ? p.cost / p.qty : 0;
        p.realized += q * price - fee - avg * q;
        p.cost -= avg * q;
        p.qty = r6(p.qty - q);
        if (p.qty <= 0) { p.qty = 0; p.cost = 0; }
      } else if (t.kind === 'div') {
        p.dividends += price - fee;
      }
    }
    for (const p of by.values()) {
      p.cost = r2(p.cost);
      p.realized = r2(p.realized);
      p.dividends = r2(p.dividends);
      p.fees = r2(p.fees);
      p.avg = p.qty > 0 ? p.cost / p.qty : 0;
      p.market = String(p.tv || '').startsWith('SET:') ? 'SET' : 'US';
    }
    return [...by.values()];
  }

  // Adds market value and profit from quotes ({ [symbol]: { price, prevClose } }), plus the baht
  // figures using fx ({ USD: 33.2 }) for anything not in baht.
  function value(pos, quotes, fx) {
    const q = quotes[pos.symbol];
    const rate = pos.currency === 'THB' ? 1 : Number(fx && fx[pos.currency]) || 0;
    const price = q && q.price > 0 ? q.price : null;
    const out = { ...pos, price, prevClose: q ? q.prevClose : null, rate, stale: !q || !!q.stale };
    out.value = price != null ? r2(pos.qty * price) : null;
    out.pl = out.value != null ? r2(out.value - pos.cost) : null;
    out.plPct = out.pl != null && pos.cost > 0 ? (out.pl / pos.cost) * 100 : null;
    out.day = price != null && q.prevClose > 0 ? r2(pos.qty * (price - q.prevClose)) : null;
    out.dayPct = price != null && q.prevClose > 0 ? ((price - q.prevClose) / q.prevClose) * 100 : null;
    const thb = (v) => (v == null || !rate ? null : r2(v * rate));
    out.thb = { value: thb(out.value), cost: thb(pos.cost), pl: thb(out.pl), day: thb(out.day), realized: thb(pos.realized), dividends: thb(pos.dividends) };
    return out;
  }

  // Sums the baht figures of valued positions. Positions with no price count at cost.
  function totals(list) {
    const t = { value: 0, cost: 0, pl: 0, day: 0, prev: 0, realized: 0, dividends: 0, missing: 0 };
    for (const p of list) {
      t.realized += p.thb.realized || 0;
      t.dividends += p.thb.dividends || 0;
      if (p.qty <= 0) continue;
      t.cost += p.thb.cost || 0;
      if (p.thb.value == null) { t.value += p.thb.cost || 0; t.missing += 1; continue; }
      t.value += p.thb.value;
      t.pl += p.thb.pl || 0;
      t.day += p.thb.day || 0;
    }
    for (const k of Object.keys(t)) if (k !== 'missing') t[k] = r2(t[k]);
    t.plPct = t.cost > 0 ? (t.pl / t.cost) * 100 : null;
    const before = t.value - t.day;
    t.dayPct = before > 0 ? (t.day / before) * 100 : null;
    return t;
  }

  const api = { positions, value, totals };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Port = api;
})(typeof window !== 'undefined' ? window : globalThis);
