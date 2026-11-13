// VAT reports by document, the purchase tax documents page and ภ.พ.30 / ภ.พ.36 returns.
// Needs a running API (API_URL) on a disposable database, like acc-api.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');
let cookie = '';
async function call(method, path, body) {
  const res = await fetch(API + '/api' + path, {
    method, headers: { 'content-type': 'application/json', 'x-centel': '1', cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}
const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b);
let P, customer, vendor, foreign;
const doc = async (b) => (await post(`${P}/docs`, b)).doc;

test('set up a VAT-registered business', async () => {
  await post('/auth/register', { email: `vat${run}@t.dev`, password: 'password-a', name: 'V' });
  const r = await post('/acc/businesses', { name: 'บริษัท ภาษี จำกัด', tax_id: '0105566000001', vat_registered: true });
  P = `/acc/b/${r.id}`;
  customer = (await post(`${P}/contacts`, { name: 'ลูกค้า ก', tax_id: '0105566000002', branch: '00000', kind: 'customer' })).contact;
  vendor = (await post(`${P}/contacts`, { name: 'ผู้ขาย ข', tax_id: '0105566000003', kind: 'vendor' })).contact;
  foreign = (await post(`${P}/contacts`, { name: 'Trip.com Travel Singapore', kind: 'vendor' })).contact;
});

test('sales by document: tax invoices and 0% cash sales, no double rows', async () => {
  const lines = [{ name: 'งานบริการ', qty: 1, price: 10000, account: '41200' }];
  const iv = await doc({ type: 'IV', date: '2026-10-03', contact_id: customer.id, lines });
  await doc({ type: 'RE', date: '2026-10-05', ref_id: iv.id, pay: { account: '11200' } });
  await doc({ type: 'RE', date: '2026-10-06', contact_id: customer.id, vat_rate: 0, lines: [{ name: 'ส่งออก', qty: 1, price: 8600, account: '41200' }], pay: { account: '11200' } });
  const unpaid = await doc({ type: 'IV', date: '2026-10-07', contact_id: customer.id, lines });
  const s = await get(`${P}/reports/vat_sales?month=2026-10`);
  assert.equal(s.rows.length, 2);
  assert.ok(!s.rows.find((r) => r.id === unpaid.id));
  const re = s.rows.find((r) => r.vat > 0);
  assert.equal(re.ref_no, iv.number);
  assert.equal(re.rate, 7);
  const zero = s.rows.find((r) => r.vat === 0);
  assert.equal(zero.rate, 0);
  assert.equal(zero.zero, 8600);
  assert.deepEqual([s.totals.value, s.totals.base, s.totals.zero, s.totals.vat], [18600, 10000, 8600, 700]);
  assert.equal((await get(`${P}/reports/vat_sales?month=2026-10&status=void`)).rows.length, 0);
});

test('purchase documents: waiting, claimed later, foreign service', async () => {
  const lines = [{ name: 'ค่าเช่า', qty: 1, price: 3000, account: '52100' }];
  const a = await doc({ type: 'EX', date: '2026-10-10', contact_id: vendor.id, tax_invoice: true, ref_no: 'INV-1', lines });
  const b = await doc({ type: 'EX', date: '2026-10-11', contact_id: vendor.id, tax_invoice: true, lines });
  const c = await doc({ type: 'EX', date: '2026-10-12', contact_id: foreign.id, tax_invoice: false, lines: [{ name: 'Booking', qty: 1, price: 2000, account: '52100' }] });
  let p = await get(`${P}/reports/vat_purchase?month=2026-10`);
  assert.equal(p.rows.length, 3);
  assert.equal(p.totals.vat, 420);
  assert.equal(p.rows.find((r) => r.id === a.id).ref_no, 'INV-1');

  assert.equal((await post(`${P}/vat/purchases`, { ids: [b.id], status: 'wait' })).updated, 1);
  assert.equal((await post(`${P}/vat/purchases`, { ids: [a.id], status: 'got', month: '2026-12' })).updated, 1);
  assert.equal((await post(`${P}/vat/purchases`, { ids: [a.id], status: 'got', month: '2027-06' })).error, 'claim_month_range');
  const r = await post(`${P}/vat/purchases`, { ids: [c.id, a.id], status: 'pp36' });
  assert.deepEqual([r.updated, r.skipped], [1, [a.id]]);

  p = await get(`${P}/reports/vat_purchase?month=2026-10`);
  assert.equal(p.rows.length, 2);
  assert.equal(p.totals.vat, 0);
  assert.equal(p.waiting.count, 1);
  assert.equal((await get(`${P}/reports/vat_purchase?month=2026-10&status=pp36`)).rows.length, 1);
  assert.equal((await get(`${P}/reports/vat_purchase?month=2026-12`)).totals.vat, 210);
  const list = (await get(`${P}/vat/purchases?from=2026-10-01&to=2026-10-31`)).docs;
  assert.deepEqual(list.map((d) => d.state).sort(), ['got', 'pp36', 'wait']);
  assert.equal(list.find((d) => d.id === a.id).claim_month, '2026-12');
  const pp36 = await get(`${P}/reports/vat_pp36?month=2026-10`);
  assert.equal(pp36.totals.vat, 140);
});

test('ภ.พ.30 return: figures, carry forward, filed returns freeze', async () => {
  const oct = (await post(`${P}/vat/returns`, { form: 'PP30', month: '2026-10' })).return;
  assert.equal(oct.status, 'draft');
  assert.equal(oct.data.l5, 700);
  assert.equal(oct.data.l7, 0);
  assert.equal(oct.data.l11, 700);
  assert.equal(oct.due.paper, '2026-11-15');
  // November: only input VAT, so it is overpaid and carries into December.
  await doc({ type: 'EX', date: '2026-11-02', contact_id: vendor.id, tax_invoice: true, lines: [{ name: 'อุปกรณ์', qty: 1, price: 5000, account: '52100' }] });
  const nov = (await post(`${P}/vat/returns`, { form: 'PP30', month: '2026-11' })).return;
  assert.equal(nov.data.l12, 350);
  const dec = (await post(`${P}/vat/returns`, { form: 'PP30', month: '2026-12' })).return;
  assert.equal(dec.data.l7, 210);
  assert.equal(dec.data.l10, 350);
  assert.equal(dec.data.l12, 560);
  const filed = (await post(`${P}/vat/returns/${oct.id}/file`, { filed_at: '2026-11-14', filed_ref: 'RD-1' })).return;
  assert.equal(filed.status, 'filed');
  assert.equal((await post(`${P}/vat/returns`, { form: 'PP30', month: '2026-10' })).status, 409);
  assert.equal((await call('DELETE', `${P}/vat/returns/${oct.id}`)).status, 404);
  const p36 = (await post(`${P}/vat/returns`, { form: 'PP36', month: '2026-10' })).return;
  assert.equal(p36.data.vat, 140);
  assert.equal(p36.due.paper, '2026-11-07');
  assert.equal((await get(`${P}/vat/returns`)).returns.length, 4);
  assert.equal((await call('DELETE', `${P}/vat/returns/${p36.id}`)).ok, true);
});
