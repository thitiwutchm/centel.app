// Owner billing: clients, plans with billing/due days, one-tap invoices, payments, API keys,
// the client's public links and the daily auto-issue job. Needs a running API (API_URL)
// started with BILLING_ADMINS=billing-owner@t.dev, like prd.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { firstRun, nextRun, totals, addDays } from '../src/billing.js';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');

function agent(bearer) {
  let cookie = '';
  return async (method, path, body, extra = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    else { headers['x-centel'] = '1'; headers.cookie = cookie; }
    Object.assign(headers, extra);
    const res = await fetch(API + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { ...(await res.json().catch(() => ({}))), code: res.status };
  };
}

const owner = agent();
const other = agent();
let client, plan, key;

test('dates: billing day is clamped to the month and plans step by month or year', () => {
  assert.equal(firstRun({ every: 'month', bill_day: 25, start_date: '2026-11-03' }), '2026-11-25');
  assert.equal(firstRun({ every: 'month', bill_day: 1, start_date: '2026-11-03' }), '2026-12-01');
  assert.equal(nextRun({ every: 'month', bill_day: 31 }, '2026-01-31'), '2026-02-28');
  assert.equal(nextRun({ every: 'month', bill_day: 31 }, '2026-02-28'), '2026-03-31');
  assert.equal(nextRun({ every: 'year', bill_day: 15 }, '2026-12-15'), '2027-12-15');
  assert.equal(nextRun({ every: 'month', bill_day: 1, end_date: '2027-01-15' }, '2027-01-01'), null);
  assert.equal(nextRun({ every: 'once', bill_day: 1 }, '2027-01-01'), null);
  assert.equal(addDays('2026-12-20', 15), '2027-01-04');
  assert.deepEqual(totals([{ qty: 2, unitPrice: 5000 }], 7, 3), { subtotal: 10000, vat: 700, wht: 300, total: 10400 });
});

test('only the owner can open billing', async () => {
  let r = await owner('POST', '/auth/register', { email: 'billing-owner@t.dev', password: 'password-owner', name: 'Owner' });
  if (r.code === 409) r = await owner('POST', '/auth/login', { email: 'billing-owner@t.dev', password: 'password-owner' });
  assert.equal(r.ok, true);
  assert.equal((await other('POST', '/auth/register', { email: `x${run}@t.dev`, password: 'password-x', name: 'X' })).ok, true);
  assert.equal((await owner('GET', '/billing/me')).admin, true);
  assert.equal((await owner('GET', '/bootstrap')).features.billing, true);
  assert.equal((await other('GET', '/billing/me')).code, 403);
  assert.equal((await other('GET', '/bootstrap')).features.billing, false);
  assert.equal((await agent()('GET', '/billing/summary')).code, 401);
  // A mutation without the app's header is refused (CSRF).
  assert.equal((await owner('POST', '/billing/clients', { name: 'x' }, { 'x-centel': '' })).code, 403);
});

test('a client, a monthly plan, and one tap to issue its bill', async () => {
  await owner('PUT', '/billing/settings', { sellerName: 'KB Tech', invoicePrefix: 'kb', defaultDueDays: 30, bankInfo: 'KBank 123' });
  client = await owner('POST', '/billing/clients', { name: `บริษัท A ${run}`, code: `A${run}`, dueDays: 15, taxId: '0105555000000' });
  assert.equal(client.name, `บริษัท A ${run}`);
  assert.equal(client.status.paidUp, true);
  plan = await owner('POST', '/billing/plans', {
    clientId: client.id, name: 'ค่าดูแลแอป', amount: 15000, every: 'month', billDay: 25, startDate: '2026-11-03', vat: true, whtRate: 3,
  });
  assert.equal(plan.nextBillDate, '2026-11-25');
  const inv = await owner('POST', `/billing/plans/${plan.id}/issue`, { issueDate: '2026-11-03' });
  assert.equal(inv.status, 'issued');
  assert.match(inv.number, /^KB-2026-\d{4}$/);
  assert.equal(inv.dueDate, '2026-11-18'); // client's 15 days
  assert.equal(inv.periodStart, '2026-11-25');
  assert.equal(inv.periodEnd, '2026-12-24');
  assert.equal(inv.total, 15600); // 15000 + 7% VAT − 3% WHT
  const st = await owner('GET', `/billing/clients/A${run}/status`);
  assert.equal(st.paidUp, false);
  assert.equal(st.outstanding, 15600);
  assert.equal(st.nextBillDate, '2026-12-25');
  assert.equal(st.unpaid.length, 1);
});

test('payments: part, then the rest, and undoing one', async () => {
  const inv = (await owner('GET', `/billing/invoices?clientId=${client.id}`)).invoices[0];
  let r = await owner('POST', `/billing/invoices/${inv.id}/payments`, { amount: 5600, paidOn: '2026-11-01', method: 'โอน' });
  assert.equal(r.state, 'partial');
  assert.equal(r.balance, 10000);
  r = await owner('POST', `/billing/invoices/${inv.id}/payments`, {});
  assert.equal(r.status, 'paid');
  assert.equal(r.payments.length, 2);
  assert.equal((await owner('POST', `/billing/invoices/${inv.id}/payments`, { amount: 1 })).error, 'already_paid');
  r = await owner('DELETE', `/billing/invoices/${inv.id}/payments/${r.payments.find((p) => p.amount === 10000).id}`);
  assert.equal(r.status, 'issued');
  assert.equal(r.balance, 10000);
});

test('one-off invoice: draft has no number until issued; only drafts delete', async () => {
  const d = await owner('POST', '/billing/invoices', { clientId: client.id, items: [{ description: 'ออกแบบหน้าจอ', qty: 2, unitPrice: 8000 }] });
  assert.equal(d.status, 'draft');
  assert.equal(d.number, null);
  assert.equal(d.total, 16000);
  const pub = await agent()('GET', `/billing/public/invoice/${d.publicToken}`);
  assert.equal(pub.code, 404); // drafts are not shared
  const i = await owner('POST', `/billing/invoices/${d.id}/issue`, { issueDate: '2026-10-01' });
  assert.equal(i.status, 'issued');
  assert.equal(i.dueDate, '2026-10-16');
  assert.equal(i.state, 'overdue');
  assert.equal((await owner('DELETE', `/billing/invoices/${d.id}`)).error, 'not_draft');
  const v = await owner('POST', `/billing/invoices/${d.id}/void`);
  assert.equal(v.status, 'void');
});

test('the client sees their bill and their account without signing in', async () => {
  const inv = (await owner('GET', `/billing/invoices?clientId=${client.id}&status=unpaid`)).invoices[0];
  const pub = await agent()('GET', `/billing/public/invoice/${inv.publicToken}`);
  assert.equal(pub.seller.name, 'KB Tech');
  assert.equal(pub.buyer.name, client.name);
  assert.equal(pub.invoice.balance, 10000);
  assert.equal(pub.invoice.clientId, undefined);
  const acct = await agent()('GET', `/billing/public/client/${client.portalToken}`);
  assert.equal(acct.status.outstanding, 10000);
  assert.equal(acct.invoices.some((x) => x.status === 'void'), false);
  const fresh = await owner('POST', `/billing/clients/${client.id}/link`);
  assert.notEqual(fresh.portalToken, client.portalToken);
  assert.equal((await agent()('GET', `/billing/public/client/${client.portalToken}`)).code, 404);
});

test('API key: another system checks status and records a payment; keys cannot make keys', async () => {
  key = await owner('POST', '/billing/keys', { name: 'ERP' });
  assert.match(key.key, /^cbk_/);
  const sys = agent(key.key);
  assert.equal((await sys('GET', '/billing/me')).via, 'api_key');
  const st = await sys('GET', `/billing/clients/A${run}/status`);
  assert.equal(st.outstanding, 10000);
  const r = await sys('POST', `/billing/invoices/${st.unpaid[0].id}/payments`, { reference: 'TRX-1' });
  assert.equal(r.status, 'paid');
  assert.equal((await sys('POST', '/billing/keys', { name: 'x' })).code, 403);
  assert.equal((await owner('DELETE', `/billing/keys/${key.id}`)).ok, true);
  assert.equal((await sys('GET', '/billing/me')).code, 401);
});

test('a client with issued bills archives instead of deleting', async () => {
  assert.equal((await owner('DELETE', `/billing/clients/${client.id}`)).error, 'client_has_invoices');
  const a = await owner('PUT', `/billing/clients/${client.id}`, { archived: true });
  assert.equal(a.archived, true);
  assert.equal((await owner('GET', '/billing/clients')).clients.some((c) => c.id === client.id), false);
});

test('the daily job issues auto plans that are due and moves them on', { skip: !process.env.DATABASE_URL }, async () => {
  const { billingTick } = await import('../src/billing.js');
  const c = await owner('POST', '/billing/clients', { name: `บริษัท B ${run}` });
  const p = await owner('POST', '/billing/plans', { clientId: c.id, name: 'ค่าเช่าเซิร์ฟเวอร์', amount: 1200, billDay: 1, startDate: '2026-10-01', autoIssue: true });
  assert.equal(p.nextBillDate, '2026-10-01');
  const out = await billingTick(new Date('2026-11-03T03:00:00Z'));
  assert.ok(out.issued >= 1);
  const invs = (await owner('GET', `/billing/invoices?clientId=${c.id}`)).invoices;
  assert.equal(invs.length, 1);
  assert.equal(invs[0].issueDate, '2026-10-01');
  assert.equal(invs[0].dueDate, '2026-10-31');
  assert.equal((await owner('GET', `/billing/clients/${c.id}`)).plans[0].nextBillDate, '2026-11-01');
  // A plan that fell behind catches up one run per tick.
  await billingTick(new Date('2026-11-03T03:00:00Z'));
  assert.equal((await owner('GET', `/billing/invoices?clientId=${c.id}`)).invoices.length, 2);
  assert.equal((await owner('GET', `/billing/clients/${c.id}`)).plans[0].nextBillDate, '2026-12-01');
  // Two attempts at the same period cannot both issue (unique per plan and period).
  const { issueFromPlan } = await import('../src/billing.js');
  const p2 = await owner('POST', '/billing/plans', { clientId: c.id, name: 'ครั้งเดียว', amount: 500, every: 'once', startDate: '2026-11-05' });
  const both = await Promise.allSettled([issueFromPlan(p2.id), issueFromPlan(p2.id)]);
  assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal((await owner('GET', `/billing/clients/${c.id}`)).plans.find((x) => x.id === p2.id).active, false);
});
