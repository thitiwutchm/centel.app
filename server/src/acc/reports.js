// Accounting reports, read from the journal (acc_lines) and the documents (acc_docs).
// `db` is an asUser client, so every query is already limited to the person's businesses.

export const REPORTS = ['dashboard', 'trial', 'pnl', 'balance', 'ledger', 'vat_sales', 'vat_purchase', 'vat_summary', 'wht_pay', 'wht_recv', 'ar', 'ap'];

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const monthOf = (m) => {
  const ym = typeof m === 'string' && /^\d{4}-\d{2}$/.test(m) ? m : today().slice(0, 7);
  const [y, mo] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { month: ym, from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
};
function period(q) {
  if (isDate(q.from) && isDate(q.to)) return { from: q.from, to: q.to };
  const m = monthOf(q.month);
  return { from: m.from, to: m.to };
}
// First day of the fiscal year that `date` falls in; fyStart is the month it starts (1 = January).
export function fiscalStart(date, fyStart = 1) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const year = m >= fyStart ? y : y - 1;
  return `${year}-${String(fyStart).padStart(2, '0')}-01`;
}
// Natural balance: debit side for assets and expenses, credit side for the rest.
const sign = (type) => (type === 'asset' || type === 'expense' ? 1 : -1);

async function balances(db, bizId, from, to) {
  return (await db.query(
    `select a.code, a.name, a.name_en, a.type, a.sys, a.bank,
            coalesce(sum(l.debit - l.credit) filter (where e.date < $2), 0) as opening,
            coalesce(sum(l.debit) filter (where e.date between $2 and $3), 0) as debit,
            coalesce(sum(l.credit) filter (where e.date between $2 and $3), 0) as credit
     from acc_accounts a
     left join acc_lines l on l.business_id = a.business_id and l.account = a.code
     left join acc_entries e on e.id = l.entry_id
     where a.business_id = $1
     group by a.code, a.name, a.name_en, a.type, a.sys, a.bank order by a.code`, [bizId, from, to])).rows;
}

async function trial(db, biz, q) {
  const { from, to } = period(q);
  const rows = (await balances(db, biz.id, from, to)).map((a) => ({
    ...a, closing: r2(a.opening + a.debit - a.credit),
  })).filter((a) => a.opening || a.debit || a.credit);
  const sum = (k) => r2(rows.reduce((s, a) => s + a[k], 0));
  return { from, to, rows, totals: { debit: sum('debit'), credit: sum('credit') } };
}

async function pnl(db, biz, q) {
  const { from, to } = period(q);
  const rows = (await balances(db, biz.id, from, to))
    .filter((a) => a.type === 'income' || a.type === 'expense')
    .map((a) => ({ code: a.code, name: a.name, name_en: a.name_en, type: a.type, sys: a.sys, amount: r2(sign(a.type) * (a.debit - a.credit)) }))
    .filter((a) => a.amount);
  const income = r2(rows.filter((a) => a.type === 'income').reduce((s, a) => s + a.amount, 0));
  const expense = r2(rows.filter((a) => a.type === 'expense').reduce((s, a) => s + a.amount, 0));
  const cogs = r2(rows.filter((a) => a.sys === 'cogs').reduce((s, a) => s + a.amount, 0));
  return { from, to, rows, income, expense, cogs, gross: r2(income - cogs), net: r2(income - expense) };
}

async function balance(db, biz, q) {
  const asOf = isDate(q.to) ? q.to : today();
  const fy = fiscalStart(asOf, biz.settings?.fyStart || 1);
  const all = await balances(db, biz.id, '1900-01-01', asOf);
  const bal = (a) => r2(sign(a.type) * (a.opening + a.debit - a.credit));
  const profit = (rows) => r2(rows.reduce((s, a) => s + (a.type === 'income' ? bal(a) : a.type === 'expense' ? -bal(a) : 0), 0));
  const prior = profit(await balances(db, biz.id, '1900-01-01', addDays(fy, -1)));
  const total = profit(all);
  const group = (t) => all.filter((a) => a.type === t).map((a) => ({ code: a.code, name: a.name, name_en: a.name_en, sys: a.sys, amount: bal(a) })).filter((a) => a.amount);
  const assets = group('asset');
  const liabilities = group('liability');
  const equity = group('equity');
  const sum = (rows) => r2(rows.reduce((s, a) => s + a.amount, 0));
  return {
    asOf, fiscalStart: fy, assets, liabilities, equity,
    priorProfit: prior, currentProfit: r2(total - prior),
    totals: { assets: sum(assets), liabilities: sum(liabilities), equity: r2(sum(equity) + total) },
  };
}

function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

async function ledger(db, biz, q) {
  const { from, to } = period(q);
  const code = String(q.account || '');
  const a = (await db.query('select code, name, type from acc_accounts where business_id = $1 and code = $2', [biz.id, code])).rows[0];
  if (!a) return { from, to, account: null, rows: [] };
  const open = (await db.query(
    `select coalesce(sum(l.debit - l.credit), 0) as v from acc_lines l join acc_entries e on e.id = l.entry_id
     where l.business_id = $1 and l.account = $2 and e.date < $3`, [biz.id, code, from])).rows[0].v;
  const rows = (await db.query(
    `select e.id, e.date, e.number, e.memo, e.doc_id, l.debit, l.credit, l.memo as line_memo
     from acc_lines l join acc_entries e on e.id = l.entry_id
     where l.business_id = $1 and l.account = $2 and e.date between $3 and $4
     order by e.date, e.created_at, l.debit desc`, [biz.id, code, from, to])).rows;
  let run = sign(a.type) * open;
  for (const r of rows) { run = r2(run + sign(a.type) * (r.debit - r.credit)); r.balance = run; }
  return { from, to, account: a, opening: r2(sign(a.type) * open), closing: r2(run), rows };
}

async function vatSales(db, biz, q) {
  const m = monthOf(q.month);
  const rows = (await db.query(
    `select id, type, number, date, status, contact, vat_base, vat, total
     from acc_docs where business_id = $1 and type in ('IV', 'RE') and tax_invoice and date between $2 and $3
     order by date, number`, [biz.id, m.from, m.to])).rows.map((d) => {
    const v = d.status === 'void';
    return { id: d.id, type: d.type, number: d.number, date: d.date, void: v, name: d.contact?.name || '', tax_id: d.contact?.tax_id || '', branch: d.contact?.branch || '', base: v ? 0 : d.vat_base, vat: v ? 0 : d.vat };
  });
  return { ...m, rows, totals: { base: r2(rows.reduce((s, x) => s + x.base, 0)), vat: r2(rows.reduce((s, x) => s + x.vat, 0)) } };
}

async function vatPurchase(db, biz, q) {
  const m = monthOf(q.month);
  const rows = (await db.query(
    `select id, number, date, ref_no, ref_date, contact, vat_base, vat
     from acc_docs where business_id = $1 and type = 'EX' and tax_invoice and vat > 0 and status <> 'void' and date between $2 and $3
     order by coalesce(ref_date, date), number`, [biz.id, m.from, m.to])).rows.map((d) => ({
    id: d.id, number: d.number, date: d.ref_date || d.date, ref_no: d.ref_no || '', name: d.contact?.name || '', tax_id: d.contact?.tax_id || '', branch: d.contact?.branch || '', base: d.vat_base, vat: d.vat,
  }));
  return { ...m, rows, totals: { base: r2(rows.reduce((s, x) => s + x.base, 0)), vat: r2(rows.reduce((s, x) => s + x.vat, 0)) } };
}

async function vatSummary(db, biz, q) {
  const s = await vatSales(db, biz, q);
  const p = await vatPurchase(db, biz, q);
  return { month: s.month, sales: s.totals, purchase: p.totals, payable: r2(s.totals.vat - p.totals.vat), salesCount: s.rows.length, purchaseCount: p.rows.length };
}

// Withholding tax this business took off its payments (ภ.ง.ด.3 people / ภ.ง.ด.53 companies).
async function whtPay(db, biz, q) {
  const m = monthOf(q.month);
  const form = q.form === 'pnd3' || q.form === 'pnd53' ? q.form : null;
  const docs = (await db.query(
    `select id, number, contact, lines, wht, wht_cert, pay from acc_docs
     where business_id = $1 and type = 'EX' and status = 'paid' and wht > 0 and (pay->>'date')::date between $2 and $3
     ${form ? "and wht_cert->>'form' = $4" : ''} order by (pay->>'date'), number`, form ? [biz.id, m.from, m.to, form] : [biz.id, m.from, m.to])).rows;
  const rows = docs.map((d) => {
    const byRate = new Map();
    for (const l of d.lines) if (l.wht > 0) byRate.set(l.wht, r2((byRate.get(l.wht) || 0) + l.base));
    return {
      id: d.id, number: d.number, cert: d.wht_cert?.number || '', form: d.wht_cert?.form || '', income: d.wht_cert?.income || '', date: d.pay?.date,
      name: d.contact?.name || '', tax_id: d.contact?.tax_id || '', branch: d.contact?.branch || '', address: d.contact?.address || '',
      rates: [...byRate].map(([rate, base]) => ({ rate, base })), base: r2([...byRate.values()].reduce((s, x) => s + x, 0)), tax: d.wht,
    };
  });
  return { ...m, form, rows, totals: { base: r2(rows.reduce((s, x) => s + x.base, 0)), tax: r2(rows.reduce((s, x) => s + x.tax, 0)) } };
}

// Withholding tax customers took off what they paid this business (a credit against income tax).
async function whtRecv(db, biz, q) {
  const { from, to } = period(q);
  const rows = (await db.query(
    `select id, number, date, contact, lines, wht from acc_docs
     where business_id = $1 and type = 'RE' and status <> 'void' and wht > 0 and date between $2 and $3 order by date, number`,
    [biz.id, from, to])).rows.map((d) => ({
    id: d.id, number: d.number, date: d.date, name: d.contact?.name || '', tax_id: d.contact?.tax_id || '',
    base: r2(d.lines.filter((l) => l.wht > 0).reduce((s, l) => s + l.base, 0)), tax: d.wht,
  }));
  return { from, to, rows, totals: { base: r2(rows.reduce((s, x) => s + x.base, 0)), tax: r2(rows.reduce((s, x) => s + x.tax, 0)) } };
}

async function openDocs(db, biz, type) {
  const t = today();
  const rows = (await db.query(
    `select id, number, date, due_date, contact_id, contact->>'name' as name, total, wht from acc_docs
     where business_id = $1 and type = $2 and status = 'open' order by coalesce(due_date, date), number`, [biz.id, type])).rows
    .map((d) => {
      const late = d.due_date && d.due_date < t ? Math.round((Date.parse(t) - Date.parse(d.due_date)) / 86400000) : 0;
      return { ...d, late, bucket: !late ? 'current' : late <= 30 ? '1-30' : late <= 60 ? '31-60' : late <= 90 ? '61-90' : '90+' };
    });
  const buckets = {};
  for (const r of rows) buckets[r.bucket] = r2((buckets[r.bucket] || 0) + r.total);
  return { asOf: t, rows, buckets, total: r2(rows.reduce((s, x) => s + x.total, 0)) };
}

async function dashboard(db, biz, q) {
  const m = monthOf(q.month);
  const p = await pnl(db, biz, { from: m.from, to: m.to });
  const money = (await balances(db, biz.id, '1900-01-01', today()))
    .filter((a) => a.type === 'asset' && (a.sys === 'cash' || a.sys === 'bank' || a.bank))
    .map((a) => ({ code: a.code, name: a.name, amount: r2(a.opening + a.debit - a.credit) }));
  const ar = await openDocs(db, biz, 'IV');
  const ap = await openDocs(db, biz, 'EX');
  const vat = biz.vat_registered ? await vatSummary(db, biz, { month: m.month }) : null;
  const start = addMonths(m.from, -5);
  const series = (await db.query(
    `select to_char(e.date, 'YYYY-MM') as month, a.type, sum(l.credit - l.debit) as v
     from acc_lines l join acc_entries e on e.id = l.entry_id join acc_accounts a on a.business_id = l.business_id and a.code = l.account
     where l.business_id = $1 and a.type in ('income', 'expense') and e.date between $2 and $3
     group by 1, 2`, [biz.id, start, m.to])).rows;
  const months = [];
  for (let i = 0; i < 6; i++) {
    const ym = addMonths(start, i).slice(0, 7);
    const get = (t) => r2(Math.abs(series.find((s) => s.month === ym && s.type === t)?.v || 0));
    months.push({ month: ym, income: get('income'), expense: get('expense') });
  }
  const recent = (await db.query(
    `select id, type, number, status, date, contact->>'name' as contact_name, total from acc_docs
     where business_id = $1 order by created_at desc limit 8`, [biz.id])).rows;
  return {
    month: m.month, income: p.income, expense: p.expense, net: p.net, money,
    ar: { total: ar.total, late: r2(ar.rows.filter((r) => r.late).reduce((s, r) => s + r.total, 0)), count: ar.rows.length },
    ap: { total: ap.total, late: r2(ap.rows.filter((r) => r.late).reduce((s, r) => s + r.total, 0)), count: ap.rows.length },
    vat, months, recent,
  };
}

function addMonths(d, n) {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  const t = new Date(Date.UTC(y, m, 1));
  return t.toISOString().slice(0, 10);
}

export async function report(db, biz, name, q = {}) {
  switch (name) {
    case 'dashboard': return dashboard(db, biz, q);
    case 'trial': return trial(db, biz, q);
    case 'pnl': return pnl(db, biz, q);
    case 'balance': return balance(db, biz, q);
    case 'ledger': return ledger(db, biz, q);
    case 'vat_sales': return vatSales(db, biz, q);
    case 'vat_purchase': return vatPurchase(db, biz, q);
    case 'vat_summary': return vatSummary(db, biz, q);
    case 'wht_pay': return whtPay(db, biz, q);
    case 'wht_recv': return whtRecv(db, biz, q);
    case 'ar': return openDocs(db, biz, 'IV');
    case 'ap': return openDocs(db, biz, 'EX');
    default: return null;
  }
}
