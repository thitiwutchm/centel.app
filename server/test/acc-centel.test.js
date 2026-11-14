// account.centel.app ⇄ Centel: link a business to a Centel profile with a code, then tax reminders
// become to-dos (with reminders) in that profile. Needs a running API (API_URL) on a disposable
// database, like acc-api.test.js. The due-date maths is tested without the API.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { nextDue, todoFor } from '../src/acc/centel.js';

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
const acc = client(); // signed in to account.centel.app
const app = client(); // signed in to Centel (another account)
const other = client(); // someone else
let P;

test('due dates: monthly, short months, weekends moved to Friday, yearly', () => {
  const r = { every: 'monthly', day: 23, early: true };
  // 23 Nov 2026 is a Monday.
  assert.deepEqual(nextDue(r, '2026-11-15'), { due: '2026-11-23', date: '2026-11-23', moved: false });
  // After the 23rd → December; 23 Dec 2026 is a Wednesday.
  assert.equal(nextDue(r, '2026-11-24').due, '2026-12-23');
  // 15 Nov 2026 is a Sunday → reminder for Friday the 13th; on the 14th it is already past, so December.
  assert.deepEqual(nextDue({ every: 'monthly', day: 15, early: true }, '2026-11-01'), { due: '2026-11-15', date: '2026-11-13', moved: true });
  assert.equal(nextDue({ every: 'monthly', day: 15, early: true }, '2026-11-14').due, '2026-12-15');
  assert.deepEqual(nextDue({ every: 'monthly', day: 15, early: false }, '2026-11-14'), { due: '2026-11-15', date: '2026-11-15', moved: false });
  assert.equal(nextDue({ every: 'monthly', day: 31, early: false }, '2027-02-01').due, '2027-02-28');
  assert.equal(nextDue({ every: 'yearly', day: 31, month: 5, early: false }, '2026-11-14').due, '2027-05-31');
  const t = todoFor({ kind: 'pp30', title: 'ยื่น ภ.พ.30 ภาษีมูลค่าเพิ่ม', note: null }, 'บริษัท ก', { due: '2026-11-23', date: '2026-11-23' });
  assert.equal(t.text, 'ยื่น ภ.พ.30 ภาษีมูลค่าเพิ่ม (ต.ค. 2569) · บริษัท ก');
  assert.match(t.body, /23 พ.ย. 2569 \(จันทร์\)/);
});

test('set up a business and a Centel account', async () => {
  await acc('POST', '/auth/register', { email: `acc${run}@t.dev`, password: 'password-a', name: 'Acc' });
  P = `/acc/b/${(await acc('POST', '/acc/businesses', { name: 'บริษัท เตือนภาษี จำกัด' })).id}`;
  await app('POST', '/auth/register', { email: `app${run}@t.dev`, password: 'password-a', name: 'Centel' });
  await other('POST', '/auth/register', { email: `oth${run}@t.dev`, password: 'password-a', name: 'Other' });
});

let reminder;
test('reminders can be set before linking; none go out yet', async () => {
  const r = await acc('POST', `${P}/reminders`, { kind: 'pp30' });
  assert.equal(r.status, 200);
  reminder = r.reminder;
  assert.equal(reminder.day, 23);
  assert.equal(reminder.remind_days, 2);
  assert.ok(reminder.next.due >= '2026-11-23');
  const c = await acc('POST', `${P}/reminders`, { kind: 'custom', title: 'ประกันสังคม สปส.1-10', day: 15, remind_days: 1 });
  assert.equal(c.reminder.title, 'ประกันสังคม สปส.1-10');
  assert.equal((await acc('POST', `${P}/reminders`, { kind: 'custom', title: '', day: 15 })).status, 400);
  assert.equal((await acc('POST', `${P}/reminders`, { kind: 'custom', title: 'x', day: 40 })).status, 400);
  assert.equal((await acc('POST', `${P}/reminders/${reminder.id}/test`)).status, 409);
  // Only members of the business see them.
  assert.equal((await other('GET', `${P}/reminders`)).status, 404);
});

test('link with a code approved in Centel', async () => {
  const c = await acc('POST', `${P}/centel/code`);
  assert.match(c.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(c.url, /#link-account=[A-Z2-9]{8}$/);
  assert.equal((await app('GET', '/acc-link/code/ZZZZ-ZZZZ')).status, 404);
  const info = await app('GET', `/acc-link/code/${c.code.toLowerCase()}`);
  assert.equal(info.business, 'บริษัท เตือนภาษี จำกัด');
  const ok = await app('POST', '/acc-link/approve', { code: c.code });
  assert.equal(ok.status, 200);
  // A code works once.
  assert.equal((await other('POST', '/acc-link/approve', { code: c.code })).status, 404);
  const links = (await acc('GET', `${P}/centel`)).links;
  assert.equal(links.length, 1);
  assert.equal(links[0].email, `app${run}@t.dev`);
  const mine = (await app('GET', '/acc-link')).links;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].reminders, 2);
  assert.equal((await other('GET', '/acc-link')).links.length, 0);
});

const taxNotes = async () => ((await app('GET', '/bootstrap')).notes || []).filter((n) => (n.tags || []).includes('บัญชี'));

test('deadlines within a week become to-dos with a reminder in Centel', async () => {
  const notes = await taxNotes();
  // Which ones are within a week depends on today's date; each is added once.
  for (const n of notes) {
    assert.match(n.text, / · บริษัท เตือนภาษี จำกัด$/);
    assert.ok(n.date);
    assert.ok([1440, 2880].includes(n.remind));
  }
  // Make one that is due tomorrow so it is always added, and check it is added only once.
  const t = new Date(Date.now() + 7 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const day = Number(t.slice(8));
  const r = await acc('POST', `${P}/reminders`, { kind: 'custom', title: `ทดสอบ ${run}`, day, remind_days: 0, early: false });
  assert.equal(r.reminder.next.due, t);
  await acc('PUT', `${P}/reminders/${r.reminder.id}`, { note: 'เอกสารอยู่ในแฟ้มสีฟ้า' });
  const mine = (await taxNotes()).filter((n) => n.text.startsWith(`ทดสอบ ${run}`));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].date, t);
  assert.equal(mine[0].remind, 0);
  assert.match(mine[0].body, /แฟ้มสีฟ้า/);
  // Paused → the to-do that has not reminded yet is taken back.
  await acc('PUT', `${P}/reminders/${r.reminder.id}`, { active: false });
  assert.equal((await taxNotes()).filter((n) => n.text.startsWith(`ทดสอบ ${run}`)).length, 0);
  await acc('PUT', `${P}/reminders/${r.reminder.id}`, { active: true });
  assert.equal((await taxNotes()).filter((n) => n.text.startsWith(`ทดสอบ ${run}`)).length, 1);
  const test1 = await acc('POST', `${P}/reminders/${r.reminder.id}/test`);
  assert.equal(test1.status, 200);
  assert.equal(test1.people, 1);
});

test('paying a supplier once, with contact and amount; unpaid expenses coming due', async () => {
  const P2 = P;
  const vendor = (await acc('POST', `${P2}/contacts`, { name: 'ร้านวัสดุ ข', kind: 'vendor' })).contact;
  const t = new Date(Date.now() + 7 * 3600e3 + 2 * 86400e3).toISOString().slice(0, 10);
  const r = await acc('POST', `${P2}/reminders`, { category: 'pay', every: 'once', date: t, title: 'ค่าเช่าโกดัง', contact_id: vendor.id, amount: 15000, remind_days: 1, early: false });
  assert.equal(r.status, 200);
  assert.equal(r.reminder.next.due, t);
  let n = (await taxNotes()).find((x) => x.text.startsWith('ค่าเช่าโกดัง'));
  assert.equal(n.text, 'ค่าเช่าโกดัง · ร้านวัสดุ ข · ฿15,000.00 · บริษัท เตือนภาษี จำกัด');
  assert.ok(n.tags.includes('จ่ายคู่ค้า'));
  assert.match(n.body, /กำหนดจ่าย/);
  assert.equal((await acc('POST', `${P2}/reminders`, { category: 'pay', every: 'once', title: 'x' })).status, 400);
  // An unpaid expense due in 3 days → a to-do once the switch is on; paid → taken back.
  const ex = (await acc('POST', `${P2}/docs`, { type: 'EX', date: t.slice(0, 8) + '01', due_date: t, contact_id: vendor.id, lines: [{ name: 'ปูน', qty: 1, price: 500, account: '51100' }] })).doc;
  assert.ok(ex, 'expense made');
  assert.equal((await taxNotes()).filter((x) => x.text.includes(ex.number)).length, 0);
  const pr = await acc('PUT', `${P2}/reminders/prefs`, { ex_due: true });
  assert.equal(pr.prefs.ex_due, true);
  n = (await taxNotes()).find((x) => x.text.includes(ex.number));
  if (ex.status === 'open') {
    assert.ok(n, 'expense to-do added');
    assert.match(n.text, /^จ่าย /);
    await acc('PUT', `${P2}/reminders/prefs`, { ex_due: false });
    assert.equal((await taxNotes()).filter((x) => x.text.includes(ex.number)).length, 0);
  }
});

test('unlinking from Centel stops reminders and takes back pending to-dos', async () => {
  const [l] = (await app('GET', '/acc-link')).links;
  assert.equal((await other('DELETE', `/acc-link/${l.id}`)).status, 404);
  assert.equal((await app('DELETE', `/acc-link/${l.id}`)).status, 200);
  assert.equal((await acc('GET', `${P}/centel`)).links.length, 0);
  assert.equal((await taxNotes()).length, 0);
  assert.equal((await acc('DELETE', `${P}/reminders/${reminder.id}`)).status, 200);
});
