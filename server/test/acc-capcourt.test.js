// CapCourt Admin → Centel Account. The first tests need nothing; the rest need a running API
// (API_URL) on a disposable database, like acc-api.test.js, and stand up a fake CapCourt here.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { cleanBase, cleanKey, reportFor, sinceMonth, toDocBody, venueContact } from '../src/acc/capcourt.js';
import { computeTotals } from '../src/acc/ledger.js';

const BILL = {
  id: '44444444-4444-4444-8444-444444444444', number: 'CC-202610-0001', status: 'issued',
  period: { start: '2026-10-01', end: '2026-10-31' }, issued_on: '2026-11-01', due_on: '2026-11-08',
  currency: 'THB', subtotal: '1048.13', vat: '73.37', total: '1121.50', paid_at: null, centel: null,
  seller: 'CapCourt', vat_rate: '7.00', prices_include_vat: true,
  venue: { id: '11111111-1111-4111-8111-111111111111', name: 'Welcome Dink', code: 'welcomedink', address: '1 ถนนทดสอบ', province: 'กรุงเทพ', contact_name: 'คุณ ก', contact_email: 'venue@example.invalid', contact_phone: '0812345678' },
  lines: [
    { kind: 'package', description: 'แพ็กเกจเว็บรายเดือน 10/2026', quantity: '1.00', unit_price: '990', amount: '990.00' },
    { kind: 'slips', description: 'ค่าตรวจสลิป 3 ใบ × ฿0.50', quantity: '3.00', unit_price: '0.5', amount: '1.50' },
    { kind: 'gp', description: 'GP 10% จากยอดขายคลิปสุทธิ ฿1,300.00', quantity: '1300.00', unit_price: '0.1', amount: '130.00' },
  ],
  payment_instructions: '', note: '',
};

test('a CapCourt bill becomes an invoice with the same total, not a tax invoice', () => {
  const body = toDocBody(BILL, {}, { vatRegistered: true, contactId: 'c' });
  assert.equal(body.type, 'IV');
  assert.equal(body.tax_invoice, false);
  assert.equal(body.date, '2026-11-01');
  assert.equal(body.due_date, '2026-11-08');
  assert.equal(body.lines.length, 3);
  const t = computeTotals(body.lines, { priceMode: body.price_mode, vatRate: body.vat_rate });
  assert.equal(t.total, 1121.5);
  assert.equal(t.vat, 73.37);
  // Not VAT registered: no VAT, the same amount due.
  const plain = toDocBody(BILL, {}, { vatRegistered: false, contactId: 'c' });
  assert.equal(computeTotals(plain.lines, { priceMode: plain.price_mode, vatRate: plain.vat_rate }).total, 1121.5);
});

test('mapped items name the lines and pick the income account', () => {
  const items = new Map([['i1', { id: 'i1', name: 'แพ็กเกจเว็บ CapCourt', account: '4110' }]]);
  const [pkg] = toDocBody(BILL, { itemMap: { package: 'i1' } }, { vatRegistered: true, contactId: 'c', items }).lines;
  assert.equal(pkg.name, 'แพ็กเกจเว็บ CapCourt');
  assert.equal(pkg.account, '4110');
  assert.equal(pkg.desc, 'แพ็กเกจเว็บรายเดือน 10/2026');
});

test('reports go once per state', () => {
  const doc = { number: 'IV2026110001', status: 'open', public_token: 'x'.repeat(32), ext_reported: null };
  assert.deepEqual(reportFor(doc, null).body, { number: 'IV2026110001', url: `https://account.centel.app/doc.html?t=${'x'.repeat(32)}`, status: 'issued' });
  assert.equal(reportFor({ ...doc, ext_reported: 'issued' }, null), null);
  const paid = reportFor({ ...doc, ext_reported: 'issued' }, { number: 'RE2026110001', pay: { date: '2026-11-05' } });
  assert.equal(paid.state, 'paid:RE2026110001');
  assert.equal(paid.body.paid_at, '2026-11-05T12:00:00+07:00');
  assert.equal(reportFor({ ...doc, status: 'void' }, null), null);
});

test('inputs are checked', () => {
  assert.equal(cleanBase(''), 'https://admin.capcourt.com');
  assert.equal(cleanBase('http://evil.example'), null);
  assert.equal(cleanBase('https://admin.capcourt.com/'), 'https://admin.capcourt.com');
  assert.equal(cleanKey('cc_venue'), null);
  assert.equal(cleanKey('ccb_abcdefghijk'), 'ccb_abcdefghijk');
  assert.equal(sinceMonth('2026-01-15'), '2025-11');
  assert.equal(venueContact(BILL.venue).address, '1 ถนนทดสอบ กรุงเทพ');
});

/* ---------- End to end against a fake CapCourt ---------- */

const API = process.env.API_URL;
const e2e = API ? test : test.skip;
const KEY = 'ccb_test-key-1234567890';

function fakeCapcourt() {
  const bills = [structuredClone(BILL), { ...structuredClone(BILL), id: '55555555-5555-4555-8555-555555555555', number: 'CC-202609-0001', status: 'paid', issued_on: '2026-10-01', due_on: '2026-10-08' }];
  const reports = [];
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'bad key' });
    if (req.method === 'GET' && req.url.startsWith('/api/v1/billing/invoices/?since=')) return send(200, { invoices: bills });
    const m = req.url.match(/^\/api\/v1\/billing\/invoices\/([0-9a-f-]+)\/centel\/$/);
    if (req.method === 'POST' && m) {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      reports.push({ id: m[1], ...body });
      const bill = bills.find((b) => b.id === m[1]);
      if (body.status === 'paid' && bill.status === 'issued') bill.status = 'paid';
      return send(200, bill);
    }
    send(404, {});
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, bills, reports, base: `http://localhost:${server.address().port}` })));
}

function agent() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(API + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-centel': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p, b) => call('DELETE', p, b) };
}

e2e('connect, issue the bill once, receipt reports payment back', async () => {
  const cc = await fakeCapcourt();
  const A = agent();
  const run = crypto.randomBytes(4).toString('hex');
  await A.post('/auth/register', { email: `cc${run}@t.dev`, password: 'password-a', name: 'A' });
  const biz = (await A.post('/acc/businesses', { name: 'บริษัท แคปคอร์ท จำกัด', vat_registered: true })).id;
  const P = `/acc/b/${biz}`;
  try {
    assert.equal((await A.put(`${P}/integrations/capcourt`, { base_url: cc.base, api_key: 'ccb_wrong-key-000000' })).error, 'capcourt_key');
    const saved = await A.put(`${P}/integrations/capcourt`, { base_url: cc.base, api_key: KEY });
    assert.equal(saved.integration.key_suffix, '7890');
    assert.equal(JSON.stringify(saved).includes(KEY), false, 'the key never comes back');

    const first = (await A.post(`${P}/integrations/capcourt/sync`)).result;
    assert.equal(first.created.length, 1, 'only the unpaid bill');
    assert.equal(first.created[0].total, 1121.5);
    assert.deepEqual(first.errors, []);
    assert.equal((await A.post(`${P}/integrations/capcourt/sync`)).result.created.length, 0, 'no duplicate');

    const { docs } = await A.get(`${P}/docs?type=IV`);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].ext_no, 'CC-202610-0001');
    assert.equal(docs[0].tax_invoice, false);
    assert.equal(cc.reports.length, 1);
    assert.equal(cc.reports[0].status, 'issued');
    assert.match(cc.reports[0].url, /doc\.html\?t=/);
    const boot = await A.get(P);
    assert.equal(boot.contacts[0].name, 'Welcome Dink', 'contact made from the venue');

    // Approve the payment: a receipt from the invoice is the tax invoice, and CapCourt hears about it.
    const cash = boot.accounts.find((a) => a.sys === 'cash').code;
    const re = (await A.post(`${P}/docs`, { type: 'RE', ref_id: docs[0].id, pay: { account: cash, method: 'transfer' } })).doc;
    assert.equal(re.tax_invoice, true);
    await new Promise((ok) => setTimeout(ok, 1500));
    const paid = cc.reports.find((r) => r.status === 'paid');
    assert.ok(paid, 'payment reported');
    assert.equal(paid.receipt, re.number);
    assert.equal(cc.bills[0].status, 'paid');

    const page = await A.get(`${P}/integrations/capcourt`);
    assert.equal(page.history[0].receipt, re.number);
    assert.equal(page.integration.settings.venues[0].code, 'welcomedink');
  } finally {
    await A.del(P, { confirm: 'บริษัท แคปคอร์ท จำกัด' });
    cc.server.close();
  }
});

e2e('a bill CapCourt voids is voided here', async () => {
  const cc = await fakeCapcourt();
  const A = agent();
  const run = crypto.randomBytes(4).toString('hex');
  await A.post('/auth/register', { email: `cv${run}@t.dev`, password: 'password-a', name: 'A' });
  const biz = (await A.post('/acc/businesses', { name: 'ทดสอบยกเลิก', vat_registered: true })).id;
  const P = `/acc/b/${biz}`;
  try {
    await A.put(`${P}/integrations/capcourt`, { base_url: cc.base, api_key: KEY });
    await A.post(`${P}/integrations/capcourt/sync`);
    cc.bills[0].status = 'void';
    const r = (await A.post(`${P}/integrations/capcourt/sync`)).result;
    assert.equal(r.voided.length, 1);
    assert.equal((await A.get(`${P}/docs?type=IV`)).docs[0].status, 'void');
  } finally {
    await A.del(P, { confirm: 'ทดสอบยกเลิก' });
    cc.server.close();
  }
});
