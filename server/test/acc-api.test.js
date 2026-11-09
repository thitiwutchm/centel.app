// Accounting API end to end: a business, documents through their life, reports and isolation.
// Needs a running API (API_URL) on a disposable database, like prd.test.js.
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p, b) => call('DELETE', p, b) };
}

const A = agent();
const B = agent();
let biz, P, customer, vendor;

test('create a VAT-registered business with the starting chart', async () => {
  await A.post('/auth/register', { email: `acc${run}@t.dev`, password: 'password-a', name: 'A' });
  await B.post('/auth/register', { email: `accb${run}@t.dev`, password: 'password-b', name: 'B' });
  const r = await A.post('/acc/businesses', { name: 'บริษัท ทดสอบ จำกัด', tax_id: '0105566000001', vat_registered: true });
  biz = r.id;
  P = `/acc/b/${biz}`;
  const boot = await A.get(P);
  assert.equal(boot.business.vat_registered, true);
  assert.ok(boot.accounts.find((a) => a.sys === 'ar'));
  assert.equal((await A.get('/acc/businesses')).businesses.length, 1);
  customer = (await A.post(`${P}/contacts`, { name: 'ลูกค้า ก', tax_id: '0-1055-66000-00-2', kind: 'customer' })).contact;
  vendor = (await A.post(`${P}/contacts`, { name: 'นาย ข', kind: 'vendor', is_company: false })).contact;
  assert.equal(customer.tax_id, '0105566000002');
});

test('another person cannot see the business', async () => {
  assert.equal((await B.get(P)).status, 404);
  assert.equal((await B.get('/acc/businesses')).businesses.length, 0);
  assert.equal((await B.post(`${P}/contacts`, { name: 'x' })).status, 404);
});

test('quotation → invoice → receipt, numbered and posted', async () => {
  const lines = [{ name: 'พัฒนาเว็บ', qty: 1, price: 50000, wht: 3, account: '41200' }];
  const qt = (await A.post(`${P}/docs`, { type: 'QT', date: '2026-11-02', contact_id: customer.id, lines })).doc;
  assert.equal(qt.number, 'QT2026110001');
  assert.equal(qt.total, 53500);
  const iv = (await A.post(`${P}/docs`, { type: 'IV', date: '2026-11-03', due_date: '2026-11-10', contact_id: customer.id, lines, ref_id: qt.id })).doc;
  assert.equal(iv.number, 'IV2026110001');
  assert.equal((await A.get(`${P}/docs/${qt.id}`)).doc.status, 'accepted');

  let ar = await A.get(`${P}/reports/ar`);
  assert.equal(ar.total, 53500);

  const re = await A.post(`${P}/docs`, { type: 'RE', date: '2026-11-05', ref_id: iv.id, pay: { account: '11200', method: 'transfer' } });
  assert.equal(re.doc.tax_invoice, true);
  assert.equal(re.doc.wht, 1500);
  assert.equal((await A.get(`${P}/docs/${iv.id}`)).doc.status, 'paid');
  assert.equal((await A.post(`${P}/docs`, { type: 'RE', ref_id: iv.id, pay: { account: '11200' } })).error, 'already_received');
  assert.equal((await A.post(`${P}/docs/${iv.id}/void`)).error, 'has_receipt');

  ar = await A.get(`${P}/reports/ar`);
  assert.equal(ar.total, 0);
  const vat = await A.get(`${P}/reports/vat_sales?month=2026-11`);
  assert.equal(vat.rows.length, 1);
  assert.equal(vat.totals.vat, 3500);
  const recv = await A.get(`${P}/reports/wht_recv?from=2026-11-01&to=2026-11-30`);
  assert.equal(recv.totals.tax, 1500);
});

test('expense paid with WHT gets a 50 ทวิ number and shows in ภ.ง.ด.3', async () => {
  const ex = (await A.post(`${P}/docs`, {
    type: 'EX', date: '2026-11-06', contact_id: vendor.id, tax_invoice: false,
    lines: [{ name: 'ค่าจ้างถ่ายภาพ', qty: 1, price: 10000, wht: 3, account: '52800' }],
  })).doc;
  assert.equal(ex.status, 'open');
  assert.equal(ex.vat, 0);
  const paid = (await A.post(`${P}/docs/${ex.id}/pay`, { pay: { account: '11200', date: '2026-11-07' } })).doc;
  assert.equal(paid.status, 'paid');
  assert.match(paid.wht_cert.number, /^WT2026110001$/);
  assert.equal(paid.wht_cert.form, 'pnd3');
  const pnd3 = await A.get(`${P}/reports/wht_pay?month=2026-11&form=pnd3`);
  assert.equal(pnd3.totals.tax, 300);
  assert.equal((await A.get(`${P}/reports/wht_pay?month=2026-11&form=pnd53`)).rows.length, 0);
});

test('trial balance balances; P&L and balance sheet agree', async () => {
  const tb = await A.get(`${P}/reports/trial?from=2026-11-01&to=2026-11-30`);
  assert.equal(tb.totals.debit, tb.totals.credit);
  const pl = await A.get(`${P}/reports/pnl?from=2026-11-01&to=2026-11-30`);
  assert.equal(pl.income, 50000);
  assert.equal(pl.expense, 10000);
  assert.equal(pl.net, 40000);
  const bs = await A.get(`${P}/reports/balance?to=2026-11-30`);
  assert.equal(bs.totals.assets, Math.round((bs.totals.liabilities + bs.totals.equity) * 100) / 100);
  assert.equal(bs.currentProfit, 40000);
});

test('manual journal must balance; voiding a receipt reopens the invoice', async () => {
  assert.equal((await A.post(`${P}/journal`, { date: '2026-11-01', lines: [{ account: '11200', debit: 100 }, { account: '31100', credit: 90 }] })).error, 'unbalanced');
  const jv = await A.post(`${P}/journal`, { date: '2026-11-01', memo: 'ทุนเริ่มต้น', lines: [{ account: '11200', debit: 100000 }, { account: '31100', credit: 100000 }] });
  assert.ok(jv.id);
  const docs = (await A.get(`${P}/docs?type=RE`)).docs;
  await A.post(`${P}/docs/${docs[0].id}/void`, { reason: 'ทดสอบ' });
  assert.equal((await A.get(`${P}/reports/ar`)).total, 53500);
  const dash = await A.get(`${P}/reports/dashboard?month=2026-11`);
  assert.equal(dash.income, 50000);
  assert.equal(dash.months.length, 6);
});

test('a shared link shows the document without signing in', async () => {
  const iv = (await A.get(`${P}/docs?type=IV`)).docs[0];
  const { token } = await A.post(`${P}/docs/${iv.id}/share`);
  const pub = await (await fetch(`${API}/api/acc/public/${token}`)).json();
  assert.equal(pub.doc.number, iv.number);
  assert.equal(pub.business.name, 'บริษัท ทดสอบ จำกัด');
  assert.equal(pub.doc.lines[0].account, undefined);
  await A.post(`${P}/docs/${iv.id}/share`, { off: true });
  assert.equal((await fetch(`${API}/api/acc/public/${token}`)).status, 404);
});
