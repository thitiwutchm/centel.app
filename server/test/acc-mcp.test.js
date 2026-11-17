// account.centel.app as an MCP server for Claude / ChatGPT: its own OAuth realm, read
// tools, issuing documents with confirmation, positions, and the app's connection list.
// Needs a running API (API_URL) on a disposable database, started with PUBLIC_URL = API_URL.
// Requests for account.centel.app are sent with X-Forwarded-Host, as web's Caddy does.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3999';
const ACC = 'account.centel.app';
const run = crypto.randomBytes(4).toString('hex');
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const form = (o) => new URLSearchParams(o).toString();
const accH = { 'x-forwarded-host': ACC, 'x-forwarded-proto': 'https' };

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
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  call.cookie = () => cookie;
  return call;
}

const O = agent(); // owner
const S = agent(); // sales person
let biz, P, customer;

async function connect(who, { write = true, host = accH } = {}) {
  const reg = await fetch(`${API}/api/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...host },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const fields = { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code', state: 's1' };
  const page = await fetch(`${API}/api/oauth/authorize?${form(fields)}`, { headers: { cookie: who.cookie(), ...host } });
  const html = await page.text();
  assert.equal(page.status, 200, html);
  assert.match(html, /name="csrf"/, html.slice(0, 2000));
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const res = await fetch(`${API}/api/oauth/authorize`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: who.cookie(), ...host },
    body: form({ ...fields, csrf, decision: 'allow', ...(write ? { write: '1' } : {}) }),
  });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.searchParams.get('iss'), `https://${ACC}`);
  const tok = await fetch(`${API}/api/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...host },
    body: form({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }),
  });
  assert.equal(tok.status, 200);
  return { client, html, ...(await tok.json()) };
}

async function rpc(token, method, params = {}, host = accH) {
  const res = await fetch(`${API}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...host },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const call = async (token, name, args = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200);
  return r.body.result;
};
const ok = (r) => { assert.equal(r.isError, false, r.content?.[0]?.text); return r.structuredContent; };

let owner;

test('acc mcp: discovery on account.centel.app is its own issuer', async () => {
  const pr = await (await fetch(`${API}/.well-known/oauth-protected-resource/mcp`, { headers: accH })).json();
  assert.equal(pr.resource, `https://${ACC}/mcp`);
  assert.deepEqual(pr.authorization_servers, [`https://${ACC}`]);
  assert.deepEqual(pr.scopes_supported, ['acc.read', 'acc.write']);
  const as = await (await fetch(`${API}/.well-known/oauth-authorization-server`, { headers: accH })).json();
  assert.equal(as.issuer, `https://${ACC}`);
  assert.equal(as.registration_endpoint, `https://${ACC}/api/oauth/register`);
  const res = await fetch(`${API}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...accH }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), new RegExp(`resource_metadata="https://${ACC}/.well-known/oauth-protected-resource"`));
  // centel.app keeps its own.
  const c = await (await fetch(`${API}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(c.resource, `${API}/mcp`);
});

test('acc mcp: sign in, consent with the write choice, tokens work on account.centel.app only', async () => {
  await O('POST', '/auth/register', { email: `accmcp${run}@t.dev`, password: 'password-o', name: 'Owner' });
  await S('POST', '/auth/register', { email: `accmcps${run}@t.dev`, password: 'password-s', name: 'Sales' });
  biz = (await O('POST', '/acc/businesses', { name: `บริษัท เอไอ ${run} จำกัด`, tax_id: '0105566000001', vat_registered: true })).id;
  P = `/acc/b/${biz}`;
  customer = (await O('POST', `${P}/contacts`, { name: 'บริษัท ลูกค้า จำกัด', tax_id: '0105566000002', kind: 'customer' })).contact;
  await O('POST', `${P}/items`, { name: 'ออกแบบเว็บไซต์', kind: 'service', price: 20000, unit: 'งาน', account: '41200' });

  owner = await connect(O);
  assert.match(owner.html, /Centel Account/);
  assert.match(owner.html, /ให้สร้างเอกสารได้/);
  assert.equal(owner.scope, 'acc.read acc.write');

  // A token for the accounting app does not open Centel, and an accounting client is unknown there.
  assert.equal((await rpc(owner.access_token, 'tools/list', {}, {})).status, 401);
  const page = await fetch(`${API}/api/oauth/authorize?${form({ client_id: owner.client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`, { headers: { cookie: O.cookie() } });
  assert.equal(page.status, 400);

  const init = await rpc(owner.access_token, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.body.result.serverInfo.name, 'centel-account');
  const tools = (await rpc(owner.access_token, 'tools/list')).body.result.tools;
  for (const n of ['list_businesses', 'get_overview', 'list_documents', 'get_document', 'create_document', 'void_document', 'search', 'fetch']) assert.ok(tools.find((t) => t.name === n), n);
  assert.equal(tools.find((t) => t.name === 'void_document').annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'list_documents').annotations.readOnlyHint, true);
});

test('acc mcp: read tools', async () => {
  const b = ok(await call(owner.access_token, 'list_businesses'));
  assert.equal(b.businesses.length, 1);
  assert.equal(b.businesses[0].myRole, 'เจ้าของกิจการ');
  const c = ok(await call(owner.access_token, 'list_contacts', { text: 'ลูกค้า' }));
  assert.equal(c.contacts[0].taxId, '0105566000002');
  const p = ok(await call(owner.access_token, 'list_products'));
  assert.equal(p.products[0].price, 20000);
  const a = ok(await call(owner.access_token, 'list_accounts'));
  assert.ok(a.accounts.find((x) => x.code === '11200' && x.payment));
  const o = ok(await call(owner.access_token, 'get_overview'));
  assert.equal(o.business.vatRegistered, true);
});

test('acc mcp: quotation → invoice → receipt, each confirmed first', async () => {
  const args = { type: 'QT', contact: 'ลูกค้า', lines: [{ product: 'ออกแบบเว็บ', qty: 1, wht_rate: 3 }], date: '2026-11-17', idempotency_key: crypto.randomUUID() };
  const pre = ok(await call(owner.access_token, 'create_document', args));
  assert.equal(pre.status, 'needs_confirmation');
  assert.equal(pre.preview.total, 21400);
  assert.equal(pre.preview.withholdingTax, 600);
  assert.equal(pre.preview.contact.name, 'บริษัท ลูกค้า จำกัด');
  // Nothing issued yet.
  assert.equal((await O('GET', `${P}/docs`)).docs.length, 0);
  // A token cannot be used for other details.
  const other = await call(owner.access_token, 'create_document', { ...args, date: '2026-11-18', confirm_token: pre.confirm_token });
  assert.equal(other.isError, true);

  const qt0 = ok(await call(owner.access_token, 'create_document', { ...args, confirm_token: pre.confirm_token }));
  const qt = qt0.document;
  assert.equal(qt0.status, 'created');
  assert.equal(qt.number, 'QT2026110001');
  assert.equal(qt.madeBy, 'AI: ChatGPT');
  // The same token again does not issue a second one; nor does the same idempotency key.
  const again = ok(await call(owner.access_token, 'create_document', { ...args, confirm_token: pre.confirm_token }));
  assert.equal(again.replayed, true);
  assert.equal((await O('GET', `${P}/docs`)).docs.length, 1);

  const ivArgs = { type: 'IV', from_document: 'qt2026110001', date: '2026-11-17', due_date: '2026-12-17' };
  const ivPre = ok(await call(owner.access_token, 'create_document', ivArgs));
  assert.equal(ivPre.preview.total, 21400);
  assert.equal(ivPre.preview.from, 'QT2026110001');
  const iv = ok(await call(owner.access_token, 'create_document', { ...ivArgs, confirm_token: ivPre.confirm_token })).document;
  assert.equal(iv.number, 'IV2026110001');

  const reArgs = { type: 'RE', from_document: iv.number, date: '2026-11-20', paid: { account: 'ธนาคาร', method: 'transfer' } };
  const rePre = ok(await call(owner.access_token, 'create_document', reArgs));
  assert.equal(rePre.preview.payment.account, '11200');
  const re = ok(await call(owner.access_token, 'create_document', { ...reArgs, confirm_token: rePre.confirm_token })).document;
  assert.equal(re.number, 'RE2026110001');
  assert.equal(re.taxInvoice, true);

  const ivNow = ok(await call(owner.access_token, 'get_document', { document: iv.number }));
  assert.equal(ivNow.status, 'paid');
  assert.equal(ivNow.followUps[0].number, 'RE2026110001');
  const mine = ok(await call(owner.access_token, 'list_documents', { made_by_ai: true }));
  assert.equal(mine.matched, 3);
  const pnl = ok(await call(owner.access_token, 'get_report', { report: 'pnl', month: '2026-11' }));
  assert.ok(pnl.income);
  const s = ok(await call(owner.access_token, 'search', { query: 'IV2026110001' }));
  assert.ok(s.results.length >= 1);
  const f = ok(await call(owner.access_token, 'fetch', { id: s.results[0].id }));
  assert.match(f.text, /IV2026110001/);

  // An expense from a new vendor, paid, with VAT; the vendor is added when it is issued.
  const exArgs = { type: 'EX', new_contact: { name: 'ร้านอุปกรณ์ใหม่', tax_id: '0105566000003' }, vat: true, lines: [{ name: 'เมาส์', price: 500, account: 'วัสดุ' }], paid: { method: 'cash' }, date: '2026-11-17' };
  const exPre = ok(await call(owner.access_token, 'create_document', exArgs));
  assert.equal(exPre.preview.vat, 35);
  assert.equal(exPre.preview.payment.account, '11100');
  assert.ok(exPre.preview.contact.newContact);
  const ex = ok(await call(owner.access_token, 'create_document', { ...exArgs, confirm_token: exPre.confirm_token }));
  assert.equal(ex.status, 'created');
  assert.equal(ex.document.lines[0].account, '52400');
  assert.ok((await O('GET', P)).contacts.find((c) => c.name === 'ร้านอุปกรณ์ใหม่' && c.kind === 'vendor'));

  // Voiding asks first; the invoice cannot go before its receipt.
  const vPre = ok(await call(owner.access_token, 'void_document', { document: iv.number }));
  const vErr = await call(owner.access_token, 'void_document', { document: iv.number, confirm_token: vPre.confirm_token });
  assert.equal(vErr.isError, true);
  assert.match(vErr.content[0].text, /receipt/);
  const rv = ok(await call(owner.access_token, 'void_document', { document: re.number, reason: 'ทดสอบ' }));
  const voided = ok(await call(owner.access_token, 'void_document', { document: re.number, reason: 'ทดสอบ', confirm_token: rv.confirm_token }));
  assert.equal(voided.status, 'voided');
  assert.equal((await O('GET', `${P}/docs/${iv.id}`)).doc.status, 'open');

  const link = ok(await call(owner.access_token, 'share_document', { document: qt.number }));
  assert.match(link.link, /^https:\/\/account\.centel\.app\/doc\.html\?t=/);
});

test('acc mcp: positions apply, read-only connections cannot write, other people see nothing', async () => {
  const inv = await O('POST', `${P}/members/invite`, { email: `accmcps${run}@t.dev`, role: 'sales' });
  await S('POST', '/acc/invites/accept', { token: inv.link.split('/').pop() });
  const sales = await connect(S);
  const ex = await call(sales.access_token, 'create_document', { type: 'EX', contact: 'ร้านอุปกรณ์ใหม่', lines: [{ name: 'x', price: 1 }] });
  assert.equal(ex.isError, true);
  assert.match(ex.content[0].text, /position/);
  const list = ok(await call(sales.access_token, 'list_documents', { type: 'QT' }));
  assert.equal(list.matched, 1);
  assert.equal((await call(sales.access_token, 'get_report', { report: 'pnl' })).isError, true);

  const ro = await connect(O, { write: false });
  assert.equal(ro.scope, 'acc.read');
  const r = await call(ro.access_token, 'create_contact', { name: 'ใครสักคน' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /read-only/);

  const X = agent();
  await X('POST', '/auth/register', { email: `accmcpx${run}@t.dev`, password: 'password-x', name: 'X' });
  const x = await connect(X);
  const none = await call(x.access_token, 'list_documents', { business: biz });
  assert.equal(none.isError, true);
});

test('acc mcp: the app lists and removes its own connections only', async () => {
  const mine = await O('GET', '/acc/ai');
  assert.equal(mine.url, `https://${ACC}/mcp`);
  assert.equal(mine.apps.length, 2);
  assert.equal((await O('GET', '/ai')).apps.length, 0);
  const app = mine.apps.find((a) => a.write);
  await O('DELETE', `/acc/ai/apps/${app.id}`);
  assert.equal((await rpc(owner.access_token, 'tools/list')).status, 401);
  assert.equal((await O('GET', '/acc/ai')).apps.length, 1);
});
