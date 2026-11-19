// ปฏิทินภาษี: the year's deadlines from a company's fiscal year / shareholders' meeting, the
// setup, records deciding ภ.ง.ด.1/3/53, marking filed, and to-dos in a linked Centel.
// The date maths runs without the API; the rest needs a running API (API_URL) on a disposable
// database (DATABASE_URL, for calling the reminder job with a fixed date), like acc-centel.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { deadlines, addMonths, fiscalYear, taxTodo } from '../src/acc/taxcal.js';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(API + '/api' + path, {
      method, headers: { 'content-type': 'application/json', 'x-centel': '1', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const acc = client();
const app = client();
const ALL = { pp30: true, pnd1: 'auto', sso: true, pnd1a: true, pnd3: 'auto', pnd53: 'auto', pnd51: true, agm: true, boj5: true, fs: true, pnd50: true };
const pick = (list, form, period) => list.find((d) => d.form === form && (!period || d.period === period));

test('month maths keeps month ends', () => {
  assert.equal(addMonths('2026-12-31', 4), '2027-04-30');
  assert.equal(addMonths('2027-06-30', 2), '2027-08-31');
  assert.equal(addMonths('2027-04-30', 1, false), '2027-05-30');
  assert.equal(addMonths('2027-01-31', 1, false), '2027-02-28');
  assert.deepEqual(fiscalYear(2027, 1), { start: '2027-01-01', end: '2027-12-31' });
  assert.deepEqual(fiscalYear(2027, 7), { start: '2026-07-01', end: '2027-06-30' });
});

test('a calendar-year company: the usual deadlines of 2027', () => {
  const list = deadlines({ forms: ALL, filing: 'paper' }, 1, '2027-01-01', '2027-12-31');
  // ภ.ง.ด.50 for 2026: 150 days after 31 Dec = 30 May; online 8 days more.
  const p50 = pick(list, 'pnd50', 'FY2026');
  assert.equal(p50.paper, '2027-05-30');
  assert.equal(p50.online, '2027-06-07');
  assert.equal(p50.due, '2027-05-30');
  assert.equal(p50.date, '2027-05-28'); // a Sunday → Friday before
  // ภ.ง.ด.51 for 2027: half year ends 30 Jun → 31 Aug.
  assert.equal(pick(list, 'pnd51', 'FY2027').paper, '2027-08-31');
  // No meeting date set: the last day allowed (4 months) → บอจ.5 14 days, งบการเงิน 1 month later.
  assert.equal(pick(list, 'agm').due, '2027-04-30');
  assert.equal(pick(list, 'boj5').due, '2027-05-14');
  assert.equal(pick(list, 'fs').due, '2027-05-30');
  assert.equal(pick(list, 'pnd1a', '2026').due, '2027-02-28');
  // Monthly: ภ.พ.30 for Dec 2026 on 15 Jan 2027 (paper); 12 a year.
  assert.equal(pick(list, 'pp30', '2026-12').due, '2027-01-15');
  assert.equal(list.filter((d) => d.form === 'pp30').length, 12);
  assert.equal(pick(list, 'pnd3', '2027-03').paper, '2027-04-07');
  assert.equal(pick(list, 'pnd3', '2027-03').auto, true);
  // Online filing uses the later dates.
  const online = deadlines({ forms: ALL, filing: 'online' }, 1, '2027-01-01', '2027-12-31');
  assert.equal(pick(online, 'pp30', '2026-12').due, '2027-01-23');
  assert.equal(pick(online, 'pnd53', '2027-03').due, '2027-04-15');
  assert.equal(pick(online, 'pnd50').due, '2027-06-07');
  // Sorted by due date.
  assert.deepEqual(list.map((d) => d.due), [...list.map((d) => d.due)].sort());
});

test('meeting date, other fiscal year end, first short year', () => {
  const agm = deadlines({ forms: ALL, agm_month: 4, agm_day: 20 }, 1, '2027-01-01', '2027-12-31');
  assert.equal(pick(agm, 'agm').due, '2027-04-20');
  assert.equal(pick(agm, 'boj5').due, '2027-05-04');
  assert.equal(pick(agm, 'fs').due, '2027-05-20');
  // Year ends 30 Jun: ภ.ง.ด.50 150 days → 27 Nov; ภ.ง.ด.51 for the year starting Jul 2026 → 28 Feb 2027.
  const jun = deadlines({ forms: ALL, filing: 'paper' }, 7, '2027-01-01', '2027-12-31');
  assert.equal(pick(jun, 'pnd50', 'FY2027').due, '2027-11-27');
  assert.equal(pick(jun, 'pnd51', 'FY2027').due, '2027-02-28');
  assert.equal(pick(jun, 'agm', 'FY2027').due, '2027-10-31');
  // Registered 15 Mar 2026: no ภ.ง.ด.51 for the first (short) year, nothing monthly before March.
  const first = deadlines({ forms: ALL, registered: '2026-03-15', filing: 'paper' }, 1, '2026-01-01', '2027-12-31');
  assert.equal(pick(first, 'pnd51', 'FY2026'), undefined);
  assert.ok(pick(first, 'pnd51', 'FY2027'));
  assert.ok(pick(first, 'pnd50', 'FY2026'));
  assert.equal(pick(first, 'pp30', '2026-02'), undefined);
  assert.ok(pick(first, 'pp30', '2026-03'));
  // Only what was switched on.
  assert.deepEqual([...new Set(deadlines({ forms: { pnd50: true, pp30: false } }, 1, '2027-01-01', '2027-12-31').map((d) => d.form))], ['pnd50']);
});

test('to-do text', () => {
  const [d] = deadlines({ forms: { pnd50: true }, filing: 'online' }, 1, '2027-01-01', '2027-12-31');
  const t = taxTodo(d, 'K&B Tech', 'online');
  assert.equal(t.text, 'ยื่น ภ.ง.ด.50 ภาษีเงินได้นิติบุคคลประจำปี (รอบบัญชีปี 2569) · K&B Tech');
  assert.match(t.body, /7 มิ.ย. 2570/);
  assert.match(t.body, /แบบกระดาษภายใน 30 พ.ค. 2570/);
  assert.match(t.body, /แม้ไม่มีรายได้/);
});

let P;
test('set up: no calendar until the setup is saved; monthly presets move in', async () => {
  await acc('POST', '/auth/register', { email: `tc${run}@t.dev`, password: 'password-a', name: 'Acc' });
  P = `/acc/b/${(await acc('POST', '/acc/businesses', { name: 'บริษัท ปฏิทิน จำกัด', vat_registered: true })).id}`;
  const before = await acc('GET', `${P}/taxcal`);
  assert.equal(before.status, 200);
  assert.equal(before.profile, null);
  assert.deepEqual(before.items, []);
  await acc('POST', `${P}/reminders`, { kind: 'pp30' });
  await acc('POST', `${P}/reminders`, { kind: 'custom', title: 'ค่าเช่า', day: 5 });
  assert.deepEqual((await acc('GET', `${P}/taxcal`)).legacy, ['pp30']);
  assert.equal((await acc('PUT', `${P}/taxcal/profile`, { forms: ALL, agm_month: 4 })).status, 400); // day missing
  const s = await acc('PUT', `${P}/taxcal/profile`, { forms: { ...ALL, bogus: true }, registered: '2025-01-10', remind_days: 3, fyStart: 1, vat_registered: true });
  assert.equal(s.status, 200);
  assert.deepEqual(s.moved, ['pp30']);
  assert.equal(s.profile.forms.pnd3, 'auto');
  assert.equal(s.profile.forms.bogus, undefined);
  assert.equal(s.profile.registered, '2025-01-10');
  const rem = (await acc('GET', `${P}/reminders`)).reminders.map((r) => r.kind);
  assert.deepEqual(rem, ['custom']);
  const cal = await acc('GET', `${P}/taxcal?year=2027`);
  assert.equal(cal.year, 2027);
  assert.equal(pick(cal.items, 'pnd50', 'FY2026').due, '2027-06-07');
});

test('records decide ภ.ง.ด.3/53 and ภ.ง.ด.1; marking filed', async () => {
  const company = (await acc('POST', `${P}/contacts`, { name: 'บริษัท โฆษณา จำกัด', tax_id: '0105566000099', kind: 'vendor' })).contact;
  const ex = await acc('POST', `${P}/docs`, {
    type: 'EX', date: '2026-10-05', contact_id: company.id, pay: { account: '11100', date: '2026-10-05' },
    lines: [{ name: 'ค่าโฆษณา', qty: 1, price: 10000, account: '53100', wht: 2 }],
  });
  assert.equal(ex.status, 200);
  const staff = (await acc('POST', `${P}/contacts`, { name: 'พนักงาน ก', kind: 'vendor' })).contact;
  const sal = await acc('POST', `${P}/docs`, {
    type: 'EX', date: '2026-10-25', contact_id: staff.id, pay: { account: '11100', date: '2026-10-25' },
    lines: [{ name: 'เงินเดือน ต.ค.', qty: 1, price: 15000, account: '52100', cat: 'salary' }],
  });
  assert.equal(sal.status, 200, JSON.stringify(sal));
  const cal = await acc('GET', `${P}/taxcal?year=2026`);
  const p53 = pick(cal.items, 'pnd53', '2026-10');
  assert.equal(p53.need, 'need');
  assert.equal(p53.evidence.n, 1);
  assert.equal(p53.evidence.amount, 200);
  const p3 = pick(cal.items, 'pnd3', '2026-10');
  assert.equal(p3.need, 'none');
  assert.equal(p3.status, 'none');
  assert.equal(pick(cal.items, 'pnd1', '2026-10').need, 'need');
  assert.equal(pick(cal.items, 'pnd1', '2026-10').evidence.amount, 15000);
  // Mark ภ.พ.30 for October filed, then not.
  assert.equal((await acc('POST', `${P}/taxcal/done`, { form: 'pp30', period: 'x' })).status, 400);
  assert.equal((await acc('POST', `${P}/taxcal/done`, { form: 'pp30', period: '2026-10', ref: 'RD-123' })).status, 200);
  let x = pick((await acc('GET', `${P}/taxcal?year=2026`)).items, 'pp30', '2026-10');
  assert.equal(x.status, 'done');
  assert.equal(x.done.ref, 'RD-123');
  await acc('POST', `${P}/taxcal/done`, { form: 'pp30', period: '2026-10', done: false });
  x = pick((await acc('GET', `${P}/taxcal?year=2026`)).items, 'pp30', '2026-10');
  assert.notEqual(x.status, 'done');
});

test('linked Centel gets to-dos ahead of each deadline, once; filed takes them back', { skip: !process.env.DATABASE_URL && 'needs DATABASE_URL' }, async () => {
  const { syncTaxCalendar } = await import('../src/acc/taxcal.js');
  await app('POST', '/auth/register', { email: `tcapp${run}@t.dev`, password: 'password-a', name: 'Centel' });
  const c = await acc('POST', `${P}/centel/code`);
  assert.equal((await app('POST', '/acc-link/approve', { code: c.code })).status, 200);
  const bizId = P.split('/').pop();
  const notes = async () => ((await app('GET', '/bootstrap')).notes || []).filter((n) => (n.tags || []).includes('ภาษี'));
  // As if it were 10 Nov 2026: ภ.ง.ด.53 and ภ.ง.ด.1 for October (records show them) are due 15 Nov
  // (a Sunday → Friday 13th); ภ.ง.ด.3 has no payments, so no to-do.
  await syncTaxCalendar({ businessId: bizId, now: new Date('2026-11-10T03:00:00Z') });
  await syncTaxCalendar({ businessId: bizId, now: new Date('2026-11-10T03:00:00Z') });
  let list = await notes();
  const p53 = list.filter((n) => n.text.startsWith('ยื่น ภ.ง.ด.53'));
  assert.equal(p53.length, 1);
  assert.equal(p53[0].text, 'ยื่น ภ.ง.ด.53 หัก ณ ที่จ่าย นิติบุคคล (ต.ค. 2569) · บริษัท ปฏิทิน จำกัด');
  assert.equal(p53[0].date, '2026-11-13');
  assert.equal(p53[0].remind, 3 * 1440);
  assert.match(p53[0].body, /ภาษีที่หักไว้ ฿200.00/);
  assert.equal(list.filter((n) => n.text.startsWith('ยื่น ภ.ง.ด.3 ')).length, 0);
  assert.equal(list.filter((n) => n.text.startsWith('ยื่น ภ.ง.ด.1 ')).length, 1);
  assert.equal(list.filter((n) => n.text.startsWith('นำส่ง สปส.1-10')).length, 1);
  // Filed → the to-do that has not reminded yet goes.
  await acc('POST', `${P}/taxcal/done`, { form: 'pnd53', period: '2026-10' });
  assert.equal((await notes()).filter((n) => n.text.startsWith('ยื่น ภ.ง.ด.53')).length, 0);
  // The month's summary goes in a week before the 1st.
  await syncTaxCalendar({ businessId: bizId, now: new Date('2026-11-25T03:00:00Z') });
  list = await notes();
  const dg = list.find((n) => n.text.startsWith('ภาษีที่ต้องยื่นเดือน ธ.ค. 2569'));
  assert.ok(dg, 'digest');
  assert.equal(dg.date, '2026-12-01');
  assert.match(dg.body, /ภ.พ.30/);
  // Yearly forms come in 30 days ahead, reminding at least 7 days before.
  await syncTaxCalendar({ businessId: bizId, now: new Date('2027-05-10T03:00:00Z') });
  const p50 = (await notes()).find((n) => n.text.startsWith('ยื่น ภ.ง.ด.50'));
  assert.ok(p50);
  assert.equal(p50.date, '2027-06-07');
  assert.equal(p50.remind, 7 * 1440);
  // Unlinking takes back what has not reminded.
  const link = (await app('GET', '/acc-link')).links[0];
  await app('DELETE', `/acc-link/${link.id}`);
  assert.equal((await notes()).filter((n) => n.text.startsWith('ยื่น ภ.ง.ด.50')).length, 0);
});
