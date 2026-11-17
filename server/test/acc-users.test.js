// Accounting users: invites by email, positions and per-area access, suspend/remove, profile.
// Needs a running API (API_URL) on a disposable database, like acc-api.test.js.
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

const O = agent(); // owner
const S = agent(); // sales person
const X = agent(); // someone else
const mail = (k) => `${k}${run}@t.dev`;
let P, oId, sId;

test('owner invites a sales person by email; the link works only for that email', async () => {
  await O.post('/auth/register', { email: mail('owner'), password: 'password-o', name: 'O' });
  await S.post('/auth/register', { email: mail('sales'), password: 'password-s', name: 'S' });
  await X.post('/auth/register', { email: mail('other'), password: 'password-x', name: 'X' });
  P = `/acc/b/${(await O.post('/acc/businesses', { name: 'ร้านทดสอบ' })).id}`;

  const list0 = await O.get(`${P}/members`);
  assert.equal(list0.members.length, 1);
  assert.equal(list0.members[0].primary, true);
  oId = list0.members[0].user_id;
  assert.ok(list0.roles.find((r) => r.key === 'sales'));

  assert.equal((await O.post(`${P}/members/invite`, { email: 'nope', role: 'sales' })).error, 'bad_email');
  assert.equal((await O.post(`${P}/members/invite`, { email: mail('owner'), role: 'sales' })).error, 'already_member');
  const inv = await O.post(`${P}/members/invite`, { email: mail('SALES'), role: 'sales' });
  assert.match(inv.link, /#\/invite\/[A-Za-z0-9_-]{32}$/);
  const token = inv.link.split('/').pop();

  const info = await X.get(`/acc/invite-info/${token}`);
  assert.equal(info.business, 'ร้านทดสอบ');
  assert.equal(info.role_name, 'พนักงานขาย');

  assert.equal((await X.post('/acc/invites/accept', { token })).error, 'invite_other_email');
  assert.equal((await S.get('/acc/invites')).invites.length, 1);
  assert.equal((await S.get(P)).status, 404);
  const ok = await S.post('/acc/invites/accept', { token });
  assert.ok(ok.business_id);
  assert.equal((await S.post('/acc/invites/accept', { token })).error, 'invite_gone');
  assert.equal((await S.get('/acc/invites')).invites.length, 0);

  const boot = await S.get(P);
  assert.equal(boot.role, 'sales');
  assert.deepEqual(boot.perms, { sales: 2, purchase: 0, accounting: 0, settings: 0 });
  sId = (await O.get(`${P}/members`)).members.find((m) => !m.primary).user_id;
});

test('a sales person reaches sales documents only', async () => {
  const contact = (await S.post(`${P}/contacts`, { name: 'ลูกค้า' })).contact;
  assert.ok(contact.id);
  const lines = [{ name: 'งาน', qty: 1, price: 1000, account: '41200' }];
  const qt = await S.post(`${P}/docs`, { type: 'QT', contact_id: contact.id, lines });
  assert.ok(qt.doc.id);
  assert.equal((await S.post(`${P}/docs`, { type: 'EX', contact_id: contact.id, lines })).status, 403);

  const ex = (await O.post(`${P}/docs`, { type: 'EX', contact_id: contact.id, lines: [{ name: 'ค่าเช่า', qty: 1, price: 500, account: '53100' }] })).doc;
  assert.ok(ex.id);
  assert.equal((await S.get(`${P}/docs/${ex.id}`)).status, 403);
  assert.equal((await S.get(`${P}/docs?type=EX`)).status, 403);
  const all = await S.get(`${P}/docs`);
  assert.ok(all.docs.every((d) => d.type !== 'EX'));
  assert.equal((await S.post(`${P}/docs/${ex.id}/void`)).status, 403);

  assert.equal((await S.get(`${P}/reports/dashboard`)).error, 'forbidden');
  assert.equal((await S.get(`${P}/reports/sales`)).error, undefined);
  assert.equal((await S.get(`${P}/reports/pnl`)).status, 403);
  assert.equal((await S.get(`${P}/journal`)).status, 403);
  assert.equal((await S.put(P, { name: 'เปลี่ยนชื่อ' })).status, 403);
  assert.equal((await S.post(`${P}/members/invite`, { email: mail('z'), role: 'sales' })).status, 403);
});

test('owner changes access, suspends and removes; the primary owner is protected', async () => {
  assert.equal((await O.put(`${P}/members/${sId}`, { role: 'sales', perms: { accounting: 1 } })).ok, true);
  assert.equal((await S.get(`${P}/reports/pnl`)).error, undefined);
  assert.equal((await S.post(`${P}/journal`, { lines: [] })).status, 403);
  const m = (await O.get(`${P}/members`)).members.find((x) => x.user_id === sId);
  assert.equal(m.custom, true);
  assert.equal(m.perms.accounting, 1);

  assert.equal((await O.put(`${P}/members/${sId}`, { disabled: true })).ok, true);
  assert.equal((await S.get(P)).status, 404);
  assert.equal((await S.get('/acc/businesses')).businesses.length, 0);
  assert.equal((await O.put(`${P}/members/${sId}`, { disabled: false })).ok, true);
  assert.equal((await S.get(P)).status, 200);

  assert.equal((await O.put(`${P}/members/${sId}`, { role: 'owner' })).ok, true);
  assert.equal((await S.put(`${P}/members/${oId}`, { role: 'sales' })).error, 'primary_owner');
  assert.equal((await S.del(`${P}/members/${oId}`)).error, 'primary_owner');
  assert.equal((await O.del(`${P}/members/${sId}`)).ok, true);
  assert.equal((await S.get(P)).status, 404);
});

test('profile with signature signs the documents that person issues', async () => {
  const sig = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await O.put('/acc/me', { first_name: 'ฐิติวุฒิ', last_name: 'จามรมาน', phone: '0918846699', signature: sig })).ok, true);
  assert.equal((await O.put('/acc/me', { signature: 'javascript:alert(1)' })).error, 'bad_image');
  const me = (await O.get('/acc/me')).profile;
  assert.equal(me.first_name, 'ฐิติวุฒิ');
  assert.equal(me.signature, sig);
  const c = (await O.post(`${P}/contacts`, { name: 'ลูกค้า 2' })).contact;
  const iv = (await O.post(`${P}/docs`, { type: 'IV', contact_id: c.id, lines: [{ name: 'x', qty: 1, price: 100, account: '41200' }] })).doc;
  const got = await O.get(`${P}/docs/${iv.id}`);
  assert.equal(got.issuer.signature, sig);
  assert.equal(got.issuer.name, 'ฐิติวุฒิ จามรมาน');
});
