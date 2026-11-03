// Claude / ChatGPT connector: OAuth sign-in, the read-only MCP tools, and revoking.
// Needs a running API (API_URL) like prd.test.js, started with PUBLIC_URL = API_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');
const ym = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);

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

const A = agent();
const B = agent();
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const form = (o) => new URLSearchParams(o).toString();

async function rpc(token, method, params = {}, id = 1) {
  const res = await fetch(`${API}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const call = async (token, name, args = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200);
  return r.body.result;
};

let client;
let tokens;

test('mcp: discovery documents and 401 point to the auth server', async () => {
  const res = await fetch(`${API}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
  const pr = await (await fetch(`${API}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(pr.resource, `${API}/mcp`);
  const as = await (await fetch(`${API}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${API}/api/oauth/register`);
});

test('mcp: a client registers; bad redirect URIs are refused', async () => {
  let res = await fetch(`${API}/api/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(res.status, 400);
  res = await fetch(`${API}/api/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(res.status, 201);
  client = await res.json();
  assert.match(client.client_id, /^c_/);
  assert.equal(client.client_secret, undefined);
});

test('mcp: sign-in page when signed out, consent page and code when signed in', async () => {
  await A('POST', '/auth/register', { email: `m${run}@t.dev`, password: 'password-m', name: 'Em', nickname: 'em' });
  await A('PUT', '/wallets/kbank', { name: 'KBank', type: 'bank', initial: 10000 });
  await A('POST', '/expenses', { type: 'expense', amount: 250, date: `${ym}-01`, category: 'food', merchant: 'Grab Food', walletId: 'kbank' });
  await A('POST', '/expenses', { type: 'expense', amount: 1200, date: `${ym}-01`, category: 'transport', merchant: 'PTT', walletId: 'kbank' });
  await A('POST', '/expenses', { type: 'income', amount: 30000, date: `${ym}-01`, category: 'salary', walletId: 'kbank' });
  await A('PUT', `/budgets/${crypto.randomUUID()}`, { scope: 'personal', category: 'food', amount: 1000, walletId: 'total' });
  await A('PUT', `/notes/${crypto.randomUUID()}`, { text: 'ไปเยี่ยมแม่', date: `${ym}-20` });
  await B('POST', '/auth/register', { email: `n${run}@t.dev`, password: 'password-n', name: 'En', nickname: 'en' });
  await B('POST', '/expenses', { type: 'expense', amount: 77, date: `${ym}-04`, category: 'food', merchant: 'B secret' });

  const q = form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  let res = await fetch(`${API}/api/oauth/authorize?${q}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /เข้าสู่ระบบ Centel/);

  // Unknown redirect: an error page, never a redirect.
  res = await fetch(`${API}/api/oauth/authorize?${q.replace(encodeURIComponent(REDIRECT), encodeURIComponent('https://evil.example/cb'))}`, { headers: { cookie: A.cookie() }, redirect: 'manual' });
  assert.equal(res.status, 400);

  res = await fetch(`${API}/api/oauth/authorize?${q}`, { headers: { cookie: A.cookie() } });
  const html = await res.text();
  assert.match(html, /อนุญาตให้ Claude ใช้ Centel/);
  assert.match(html, /เพิ่มและแก้ไขสิ่งที่ต้องทำ/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const post = (body, cookie = A.cookie()) => fetch(`${API}/api/oauth/authorize`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: form(body),
  });
  const fields = { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code', state: 'xyz' };

  // Another person's session cannot reuse A's form token.
  assert.equal((await post({ ...fields, csrf, decision: 'allow' }, B.cookie())).status, 403);

  res = await post({ ...fields, csrf, decision: 'deny' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /error=access_denied&state=xyz/);

  res = await post({ ...fields, csrf, decision: 'allow' });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');

  const tok = (body) => fetch(`${API}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
  // Wrong PKCE verifier burns the code.
  res = await tok({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: 'x'.repeat(43) });
  assert.equal(res.status, 400);
  // So get a fresh one.
  res = await post({ ...fields, csrf, decision: 'allow' });
  const code2 = new URL(res.headers.get('location')).searchParams.get('code');
  res = await tok({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
  assert.equal(res.status, 200);
  tokens = await res.json();
  assert.equal(tokens.token_type, 'Bearer');
  // Codes work once.
  res = await tok({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
  assert.equal(res.status, 400);
});

test('mcp: initialize, list tools, and read only this account', async () => {
  const init = await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'centel');
  const note = await fetch(`${API}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(note.status, 202);

  const list = await rpc(tokens.access_token, 'tools/list');
  const names = list.body.result.tools.map((t) => t.name);
  for (const n of ['get_overview', 'list_transactions', 'spending_report', 'get_budgets', 'get_bills', 'get_notes', 'get_wallets', 'search', 'fetch']) assert.ok(names.includes(n), n);
  // Only the to-do tools write.
  assert.deepEqual(list.body.result.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), ['create_note', 'update_note']);

  const ov = (await call(tokens.access_token, 'get_overview')).structuredContent;
  assert.equal(ov.month, ym);
  assert.equal(ov.totals.income, 30000);
  assert.equal(ov.totals.expense, 1450);
  assert.equal(ov.spendingByCategory[0].key, 'Transportation');
  assert.equal(ov.budgets[0].spent, 250);
  assert.equal(ov.budgets[0].remaining, 750);
  assert.equal(ov.wallets.wallets[0].balance, 10000 + 30000 - 1450);
  assert.equal(ov.openTodos[0].text, 'ไปเยี่ยมแม่');
  assert.equal(typeof ov.bills, 'string'); // no copy from the phone yet

  const tx = (await call(tokens.access_token, 'list_transactions', { category: 'food' })).structuredContent;
  assert.equal(tx.matched, 1);
  assert.equal(tx.transactions[0].merchant, 'Grab Food');
  assert.ok(!JSON.stringify(tx).includes('B secret'));

  const rep = (await call(tokens.access_token, 'spending_report', { group_by: 'merchant' })).structuredContent;
  assert.deepEqual(rep.groups.map((g) => g.key), ['PTT', 'Grab Food']);

  const bad = await call(tokens.access_token, 'list_transactions', { month: '2026-13' });
  assert.equal(bad.isError, true);

  const s = (await call(tokens.access_token, 'search', { query: 'grab' })).structuredContent;
  assert.equal(s.results.length, 1);
  const f = (await call(tokens.access_token, 'fetch', { id: s.results[0].id })).structuredContent;
  assert.match(f.text, /Grab Food/);
});

test('mcp: bills copy from the app shows up in get_bills', async () => {
  const data = {
    bills: [{ id: 'b1', name: 'บัตร KTC', category: 'credit', type: 'monthly', amount: 5000, dueDay: 5, startMonth: ym }],
    months: { [ym]: [{ billId: 'b1', name: 'บัตร KTC', category: 'credit', due: `${ym}-01`, amount: 4321, paid: false, status: 'upcoming' }] },
  };
  assert.equal((await B('PUT', '/ai/bills', { data })).status, 409); // B has no connected app
  assert.equal((await A('PUT', '/ai/bills', { data })).status, 200);
  const r = (await call(tokens.access_token, 'get_bills')).structuredContent;
  assert.equal(r.unpaid, 4321);
  assert.ok(['overdue', 'due_today'].includes(r.bills[0].status)); // worked out again for today
  assert.equal(r.repeatingBills[0].dueDay, 5);
});

test('mcp: the AI adds, changes and ticks off a to-do with a reminder', async () => {
  const tom = new Date(Date.now() + 7 * 3600000 + 86400000).toISOString().slice(0, 10);
  const tools = (await rpc(tokens.access_token, 'tools/list')).body.result.tools;
  assert.equal(tools.find((t) => t.name === 'create_note').annotations.readOnlyHint, false);

  const made = await call(tokens.access_token, 'create_note', { text: 'ไปรับพัสดุ', date: tom, time: '10:00', remind_minutes_before: 60 });
  assert.equal(made.isError, false);
  const n = made.structuredContent.note;
  assert.deepEqual([n.text, n.date, n.time, n.remindMinutesBefore, n.shared], ['ไปรับพัสดุ', tom, '10:00', 60, false]);
  // 10:00 Bangkok minus an hour = 02:00 UTC.
  assert.equal(new Date(made.structuredContent.reminderAt).toISOString(), `${tom}T02:00:00.000Z`);

  // The app sees it like any other note.
  const boot = await A('GET', '/bootstrap');
  const inApp = boot.notes.find((x) => x.id === n.id);
  assert.equal(inApp.remind, 60);

  const moved = (await call(tokens.access_token, 'update_note', { id: n.id, time: '15:30' })).structuredContent;
  assert.equal(moved.note.time, '15:30');
  assert.equal(new Date(moved.reminderAt).toISOString(), `${tom}T07:30:00.000Z`);
  const done = (await call(tokens.access_token, 'update_note', { id: n.id, done: true })).structuredContent;
  assert.equal(done.note.done, true);

  // Bad input is explained, not saved.
  assert.equal((await call(tokens.access_token, 'create_note', { text: 'x', remind_minutes_before: 60 })).isError, true);
  assert.equal((await call(tokens.access_token, 'create_note', { text: 'x', date: '2020-01-01', remind_minutes_before: 0 })).isError, true);
  assert.equal((await call(tokens.access_token, 'create_note', { text: 'x', date: tom, time: '25:00' })).isError, true);
  // Another account's note cannot be touched.
  const theirs = crypto.randomUUID();
  await B('PUT', `/notes/${theirs}`, { text: 'B private', date: tom });
  assert.equal((await call(tokens.access_token, 'update_note', { id: theirs, done: true })).isError, true);
  const bNote = (await B('GET', '/bootstrap')).notes.find((x) => x.id === theirs);
  assert.equal(bNote.done, false);
});

test('mcp: a connection approved before notes could be written stays read-only', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const sha = crypto.createHash('sha256').update(tokens.access_token).digest('hex');
  await db.query("update oauth_grants set scope = 'centel.read' where id = (select grant_id from oauth_tokens where token_hash = $1)", [sha]);
  const r = await call(tokens.access_token, 'create_note', { text: 'nope' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /reconnect/);
  assert.equal((await call(tokens.access_token, 'get_notes')).isError, false);
  await db.query("update oauth_grants set scope = 'centel.read centel.notes' where id = (select grant_id from oauth_tokens where token_hash = $1)", [sha]);
  await db.end();
});

test('mcp: refresh rotates, and removing the app cuts it off', async () => {
  const tok = (body) => fetch(`${API}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
  let res = await tok({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(res.status, 200);
  const next = await res.json();
  res = await tok({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(res.status, 400);
  assert.equal((await rpc(next.access_token, 'ping')).status, 200);

  const ai = await A('GET', '/ai');
  assert.equal(ai.url, `${API}/mcp`);
  assert.equal(ai.apps.length, 1);
  assert.equal(ai.apps[0].name, 'Claude');
  assert.ok(ai.billsAt);
  assert.equal((await B('DELETE', `/ai/apps/${ai.apps[0].id}`)).status, 200); // not B's: nothing happens
  assert.equal((await rpc(next.access_token, 'ping')).status, 200);
  assert.equal((await A('DELETE', `/ai/apps/${ai.apps[0].id}`)).status, 200);
  assert.equal((await rpc(next.access_token, 'ping')).status, 401);
  const after = await A('GET', '/ai');
  assert.equal(after.apps.length, 0);
  assert.equal(after.billsAt, null);
});
