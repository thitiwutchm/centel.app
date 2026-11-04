// MCP write tools: notes and to-dos, budgets, transactions, confirmation, idempotency,
// audit log and undo. Needs a running API (API_URL) started with PUBLIC_URL = API_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');
const bkk = (d = 0) => new Date(Date.now() + 7 * 3600000 + d * 86400000).toISOString().slice(0, 10);
const today = bkk();
const ym = today.slice(0, 7);

function agent() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(API + '/api' + path, {
      method, headers: { 'content-type': 'application/json', 'x-centel': '1', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  call.cookie = () => cookie;
  return call;
}
const form = (o) => new URLSearchParams(o).toString();

// Signs `who` in through the whole OAuth flow and returns an access token.
async function connect(who) {
  const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const client = await (await fetch(`${API}/api/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  })).json();
  const fields = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's' };
  const html = await (await fetch(`${API}/api/oauth/authorize?${form(fields)}`, { headers: { cookie: who.cookie() } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const res = await fetch(`${API}/api/oauth/authorize`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: who.cookie() },
    body: form({ ...fields, csrf, decision: 'allow' }),
  });
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  const tok = await (await fetch(`${API}/api/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }),
  })).json();
  return { token: tok.access_token, html };
}

let token, tokenB;
const A = agent();
const B = agent();
async function call(name, args = {}, tk = token) {
  const res = await fetch(`${API}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${tk}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  const r = (await res.json()).result;
  return { ...r, out: r.structuredContent, text: r.content[0].text };
}
// Calls a tool that asks for confirmation, checks the preview, then confirms.
async function confirmed(name, args) {
  const first = await call(name, args);
  assert.equal(first.isError, false, first.text);
  assert.equal(first.out.status, 'needs_confirmation', JSON.stringify(first.out));
  const done = await call(name, { ...args, confirm_token: first.out.confirm_token });
  assert.equal(done.isError, false, done.text);
  return { preview: first.out.preview, out: done.out };
}

test('mcpwrite: sign in, consent lists the new rights, tools are annotated', async () => {
  await A('POST', '/auth/register', { email: `w${run}@t.dev`, password: 'password-w', name: 'Wa', nickname: 'wa' });
  await A('PUT', '/wallets/kbank', { name: 'KBank', type: 'bank', initial: 50000 });
  await A('PUT', '/wallets/cash', { name: 'เงินสด', type: 'cash', initial: 1000 });
  await B('POST', '/auth/register', { email: `x${run}@t.dev`, password: 'password-x', name: 'Xa', nickname: 'xa' });
  const c = await connect(A);
  token = c.token;
  assert.match(c.html, /สร้างและแก้ไขงบประมาณ/);
  assert.match(c.html, /ต้องถามคุณก่อนทุกครั้ง/);
  tokenB = (await connect(B)).token;

  const res = await fetch(`${API}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = (await res.json()).result.tools;
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  for (const n of ['create_todo', 'list_todos', 'get_todo', 'update_todo', 'complete_todo', 'reopen_todo', 'delete_todo', 'search_todos',
    'create_note', 'list_notes', 'get_note', 'update_note', 'delete_note', 'search_notes',
    'list_budgets', 'create_budget', 'update_budget', 'delete_budget', 'get_budget_status', 'get_budget_history',
    'create_transaction', 'update_transaction', 'delete_transaction', 'list_transactions', 'categorize_transaction', 'list_changes', 'undo_change']) {
    assert.ok(by[n], n);
  }
  assert.equal(by.list_todos.readOnlyHint, true);
  assert.equal(by.create_todo.readOnlyHint, false);
  assert.equal(by.delete_todo.destructiveHint, true);
  assert.equal(by.delete_transaction.destructiveHint, true);
  assert.equal(by.create_transaction.destructiveHint, false);
});

test('mcpwrite: to-dos — create with a Thai date phrase, no duplicates, complete, repeat, reopen, delete with confirmation', async () => {
  const made = await call('create_todo', { title: 'โทรหาบัญชี', when: 'พรุ่งนี้ 10:00', remind_minutes_before: 60, priority: 'high', tags: ['งาน'], idempotency_key: `todo-${run}-1` });
  assert.equal(made.isError, false, made.text);
  assert.equal(made.out.status, 'created');
  const t = made.out.todo;
  assert.deepEqual([t.title, t.date, t.time, t.priority, t.status, t.timezone], ['โทรหาบัญชี', bkk(1), '10:00', 'high', 'pending', 'Asia/Bangkok']);
  assert.equal(new Date(t.reminderAt).toISOString(), `${bkk(1)}T02:00:00.000Z`);

  // Same key again: same answer, nothing new.
  const again = await call('create_todo', { title: 'โทรหาบัญชี', when: 'พรุ่งนี้ 10:00', remind_minutes_before: 60, priority: 'high', tags: ['งาน'], idempotency_key: `todo-${run}-1` });
  assert.equal(again.out.replayed, true);
  assert.equal(again.out.id, made.out.id);
  // Same key, other details: refused.
  assert.equal((await call('create_todo', { title: 'อย่างอื่น', idempotency_key: `todo-${run}-1` })).isError, true);
  // No key but the same open to-do on the same day: returned, not added.
  const dup = await call('create_todo', { title: 'โทรหาบัญชี', date: bkk(1), time: '10:00' });
  assert.equal(dup.out.status, 'already_exists');
  assert.equal((await call('list_todos', { tag: 'งาน' })).out.count, 1);

  // The app sees it with the new fields.
  const inApp = (await A('GET', '/bootstrap')).notes.find((n) => n.id === t.id);
  assert.deepEqual([inApp.kind, inApp.priority, inApp.tags[0], inApp.remind], ['todo', 'high', 'งาน', 60]);
  // An app save that does not know the new fields keeps them.
  await A('PUT', `/notes/${t.id}`, { text: 'โทรหาบัญชี (แก้ในแอป)', date: bkk(1), time: '10:00', remind: 60, remindAt: t.reminderAt });
  const kept = (await call('get_todo', { id: t.id })).out.todo;
  assert.equal(kept.title, 'โทรหาบัญชี (แก้ในแอป)');
  assert.equal(kept.priority, 'high');

  const prog = await call('update_todo', { id: t.id, status: 'in_progress', description: 'เรื่องภาษีปีนี้' });
  assert.equal(prog.out.todo.status, 'in_progress');
  const fin = await call('complete_todo', { id: t.id });
  assert.equal(fin.out.status, 'completed');
  assert.equal((await call('list_todos', { status: 'completed' })).out.todos[0].id, t.id);
  assert.equal((await call('reopen_todo', { id: t.id })).out.todo.status, 'pending');

  // A monthly to-do moves to its next date when ticked off.
  const rent = (await call('create_todo', { title: 'จ่ายค่าเช่าบ้าน', date: '2026-01-31', recurrence: 'monthly' })).out.todo;
  const next = await call('complete_todo', { id: rent.id });
  assert.equal(next.out.status, 'rescheduled');
  assert.ok(next.out.nextDate >= today);
  assert.equal(next.out.todo.status, 'pending');
  assert.equal((await call('create_todo', { title: 'x', recurrence: 'weekly' })).isError, true); // repeat needs a date

  // Overdue and today views.
  await call('create_todo', { title: 'ส่งเอกสารวีซ่า', date: bkk(-2) });
  const over = (await call('list_todos', { due: 'overdue' })).out;
  assert.ok(over.todos.some((x) => x.title === 'ส่งเอกสารวีซ่า' && x.overdue));
  const found = (await call('search_todos', { query: 'วีซ่า' })).out.todos[0];
  assert.equal((await call('complete_todo', { id: found.id })).out.status, 'completed');

  // Delete: preview first, nothing gone until confirmed.
  const pre = await call('delete_todo', { id: t.id });
  assert.equal(pre.out.status, 'needs_confirmation');
  assert.equal((await call('get_todo', { id: t.id })).isError, false);
  // A token only works for the details it was given for.
  assert.equal((await call('delete_todo', { id: rent.id, confirm_token: pre.out.confirm_token })).isError, true);
  const del = await call('delete_todo', { id: t.id, confirm_token: pre.out.confirm_token });
  assert.equal(del.out.status, 'deleted');
  assert.equal((await call('get_todo', { id: t.id })).isError, true);
  // Used once: the same token again changes nothing more.
  assert.equal((await call('delete_todo', { id: t.id, confirm_token: pre.out.confirm_token })).out.replayed, true);

  // Undo brings it back.
  const u = await confirmed('undo_change', { change_id: del.out.changeId });
  assert.equal(u.out.status, 'undone');
  assert.equal((await call('get_todo', { id: t.id })).out.todo.title, 'โทรหาบัญชี (แก้ในแอป)');
});

test('mcpwrite: notes (memos) — create, append, search, delete; not in the to-do list', async () => {
  const n = (await call('create_note', { title: 'คุยกับ Echo', content: 'ประชุมเรื่องค่าใช้จ่ายบ้าน', tags: ['บ้าน'] })).out;
  assert.equal(n.status, 'created');
  const up = await call('update_note', { id: n.id, append: 'ต้องคุยกับบัญชีเรื่องภาษี' });
  assert.equal(up.out.note.content, 'ประชุมเรื่องค่าใช้จ่ายบ้าน\nต้องคุยกับบัญชีเรื่องภาษี');
  assert.equal((await call('search_notes', { query: 'ค่าใช้จ่าย บ้าน' })).out.count, 1);
  assert.equal((await call('list_notes')).out.notes[0].id, n.id);
  assert.ok(!(await call('list_todos', { status: 'all' })).out.todos.some((x) => x.id === n.id));
  assert.equal((await call('get_todo', { id: n.id })).isError, true); // a memo is not a to-do
  const boot = (await A('GET', '/bootstrap')).notes.find((x) => x.id === n.id);
  assert.equal(boot.kind, 'memo');
  // Another person cannot see or delete it.
  assert.equal((await call('get_note', { id: n.id }, tokenB)).isError, true);
  assert.equal((await call('delete_note', { id: n.id }, tokenB)).isError, true);
  const d = await confirmed('delete_note', { id: n.id });
  assert.equal(d.out.status, 'deleted');
});

test('mcpwrite: the 100,000 monthly budget plan — sum checked, created once, status and history', async () => {
  const plan = [
    { category: 'rent', name: 'ค่าเช่าบ้าน', amount: 40000 },
    { category: 'utility', name: 'ค่าไฟ', amount: 5000 },
    { category: 'fitness', name: 'ฟิตเนส', amount: 3200 },
    { category: 'food', name: 'อาหารทั่วไป', amount: 20000 },
    { category: 'food', name: 'ซูชิโร่', merchant: 'ซูชิโร่', amount: 4500 },
    { category: 'baby', name: 'ค่าใช้จ่ายลูก', amount: 10000 },
    { category: 'other_exp', name: 'เงินสำรอง', amount: 5000 },
    { category: 'other_exp', name: 'ค่าใช้จ่ายยืดหยุ่น', amount: 12300 },
  ];
  // A wrong total saves nothing.
  const bad = await call('create_budget', { budgets: plan, expected_total: 99000 });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /100,000/);
  assert.equal((await call('list_budgets')).out.count, 0);

  const ok = await call('create_budget', { budgets: [{ category: 'all', name: 'งบรายเดือน', amount: 100000 }, ...plan], expected_total: 100000, idempotency_key: `plan-${run}` });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.out.status, 'created');
  assert.equal(ok.out.created.length, 9);
  assert.equal(ok.out.total, 100000);
  // Sent again (no key): nothing new.
  const again = await call('create_budget', { budgets: plan, expected_total: 100000 });
  assert.equal(again.out.status, 'already_exists');
  assert.equal(again.out.skipped.length, 8);
  assert.equal((await call('list_budgets')).out.count, 9);
  // The same budget with another amount is refused (use update_budget).
  assert.equal((await call('create_budget', { budgets: [{ category: 'utility', name: 'ค่าไฟ', amount: 6000 }] })).isError, true);

  // The app sees the budgets with their names.
  const bb = (await A('GET', '/bootstrap')).budgets;
  assert.ok(bb.some((b) => b.name === 'ซูชิโร่' && b.merchant === 'ซูชิโร่' && b.period === 'month'));

  // Spending: sushi counts in both food budgets, the other meal only in อาหารทั่วไป.
  await call('create_transaction', { amount: 850, category: 'food', merchant: 'ซูชิโร่ เซ็นทรัล', wallet: 'KBank' });
  await call('create_transaction', { amount: 350, category: 'food', merchant: 'ข้าวมันไก่' });
  // A package wallet is only spent by its own uses in the app, never by other payments.
  await A('PUT', '/wallets/gym', { name: 'ฟิตเนส', type: 'package', initial: 16000, pkg: { price: 16000, uses: 20 } });
  const pk = await call('create_transaction', { amount: 100, category: 'food', merchant: 'ร้านกาแฟ', wallet: 'ฟิตเนส' });
  assert.equal(pk.isError, true);
  assert.match(pk.text, /package wallet/);
  const st = (await call('get_budget_status')).out;
  const b = (n) => st.budgets.find((x) => x.name === n);
  assert.equal(b('ซูชิโร่').spent, 850);
  assert.equal(b('อาหารทั่วไป').spent, 1200);
  assert.equal(st.overall.budget, 100000);
  assert.equal(st.overall.spent, 1200);
  assert.equal(st.overall.remaining, 98800);
  assert.equal(st.overall.categoryBudgetsTotal, 100000);

  // "เพิ่มงบอาหารเป็น 25,000" needs confirmation; "ลดงบ... ลง 3,000" with change_by.
  const up = await confirmed('update_budget', { budget: 'อาหารทั่วไป', amount: 25000 });
  assert.deepEqual([up.preview.from, up.preview.to], [20000, 25000]);
  assert.equal(up.out.budget.amount, 25000);
  const down = await confirmed('update_budget', { budget: 'ค่าใช้จ่ายยืดหยุ่น', change_by: -3000 });
  assert.equal(down.out.budget.amount, 9300);
  // Renaming changes no money: no confirmation.
  const ren = await call('update_budget', { budget: 'ฟิตเนส', name: 'ฟิตเนส + โยคะ' });
  assert.equal(ren.out.status, 'updated');
  assert.equal((await call('update_budget', { budget: 'ค่าไฟ', change_by: -9000 })).isError, true); // would go below 0

  const hist = (await call('get_budget_history', { budget: 'ซูชิโร่', periods: 3 })).out.budgets[0];
  assert.equal(hist.history.length, 3);
  assert.equal(hist.history[0].spent, 850);

  // Weekly and custom budgets.
  const wk = await call('create_budget', { budgets: [{ category: 'coffee', amount: 700, period: 'week' }, { name: 'ทริปเชียงใหม่', amount: 15000, period: 'custom', start_date: bkk(-1), end_date: bkk(5) }] });
  assert.equal(wk.out.created.length, 2);
  const w = wk.out.created[0];
  const st2 = (await call('get_budget_status', { budget: w.id })).out.budget;
  assert.equal(new Date(st2.from).getUTCDay(), 1); // Monday
  assert.equal(st2.to, new Date(Date.parse(st2.from) + 6 * 86400000).toISOString().slice(0, 10));
  assert.equal((await call('create_budget', { budgets: [{ amount: 1, period: 'custom', start_date: bkk(3), end_date: bkk(1) }] })).isError, true);

  // Delete needs confirmation; undo brings it back.
  const del = await confirmed('delete_budget', { budget: 'ทริปเชียงใหม่' });
  assert.equal(del.out.status, 'deleted');
  await confirmed('undo_change', { change_id: del.out.changeId });
  assert.ok((await call('list_budgets')).out.budgets.some((x) => x.name === 'ทริปเชียงใหม่'));
  // The other account sees none of these.
  assert.equal((await call('list_budgets', {}, tokenB)).out.count, 0);
  assert.equal((await call('update_budget', { budget: w.id, amount: 1 }, tokenB)).isError, true);
});

test('mcpwrite: transactions — record, duplicate check, big amounts, edit with confirmation, categorize, delete, undo', async () => {
  const yest = bkk(-1);
  const fuel = await call('create_transaction', { amount: 1500, when: 'เมื่อวาน', category: 'Transportation', merchant: 'ปตท.', idempotency_key: `fuel-${run}` });
  assert.equal(fuel.isError, false, fuel.text);
  assert.equal(fuel.out.status, 'created');
  assert.equal(fuel.out.transaction.date, yest);
  assert.equal(fuel.out.transaction.wallet, 'KBank'); // first wallet when the app has not used one yet
  // Retry with the key: same record.
  assert.equal((await call('create_transaction', { amount: 1500, when: 'เมื่อวาน', category: 'Transportation', merchant: 'ปตท.', idempotency_key: `fuel-${run}` })).out.id, fuel.out.id);
  // Without a key but the same purchase: flagged, not saved.
  const dup = await call('create_transaction', { amount: 1500, date: yest, merchant: 'ปตท.' });
  assert.equal(dup.out.status, 'possible_duplicate');
  assert.equal(dup.out.duplicates[0].id, fuel.out.id);
  const two = await call('create_transaction', { amount: 1500, date: yest, merchant: 'ปตท.', allow_duplicate: true });
  assert.equal(two.out.status, 'created');

  // 10,000 or more needs confirmation.
  const big = await confirmed('create_transaction', { type: 'income', amount: 45000, category: 'salary', wallet: 'KBank' });
  assert.equal(big.preview.transaction.amount, 45000);
  assert.equal(big.out.status, 'created');

  // "แก้ค่ากาแฟเมื่อเช้าจาก 150 เป็น 120"
  const coffee = (await call('create_transaction', { amount: 150, category: 'coffee', merchant: 'Café Amazon', wallet: 'เงินสด' })).out;
  const found = (await call('list_transactions', { text: 'amazon', from: today, to: today })).out.transactions[0];
  assert.equal(found.id, coffee.id);
  const fix = await confirmed('update_transaction', { id: coffee.id, amount: 120 });
  assert.equal(fix.preview.before.amount, 150);
  assert.equal(fix.out.transaction.amount, 120);
  // A note change is not a money change: no confirmation.
  assert.equal((await call('update_transaction', { id: coffee.id, note: 'ลาเต้' })).out.status, 'updated');

  // categorize
  const unc = (await call('create_transaction', { amount: 99, merchant: 'ร้านไม่รู้หมวด' })).out;
  assert.equal(unc.transaction.categoryName, 'รอตรวจสอบ (ไม่มีหมวด)');
  const cat = await call('categorize_transaction', { ids: [unc.id], category: 'food' });
  assert.equal(cat.out.results[0].to, 'Food & Groceries');
  assert.equal((await call('categorize_transaction', { ids: [unc.id], category: 'salary' })).isError, true); // income category on an expense

  // Wallet balances follow: only the coffee went to เงินสด, the rest to KBank (the first wallet).
  const wal = (await call('get_wallets')).out.wallets;
  assert.equal(wal.find((x) => x.name === 'เงินสด').balance, 1000 - 120);
  assert.equal(wal.find((x) => x.name === 'KBank').balance, 50000 - 850 - 350 - 1500 - 1500 + 45000 - 99);

  // Another account cannot touch it.
  assert.equal((await call('update_transaction', { id: coffee.id, note: 'x' }, tokenB)).isError, true);
  assert.equal((await call('delete_transaction', { id: coffee.id }, tokenB)).isError, true);

  const del = await confirmed('delete_transaction', { id: two.out.id });
  assert.equal(del.out.status, 'deleted');
  assert.ok(!(await A('GET', '/bootstrap')).expenses.some((e) => e.id === two.out.id));
  await confirmed('undo_change', { change_id: del.out.changeId });
  assert.ok((await A('GET', '/bootstrap')).expenses.some((e) => e.id === two.out.id));

  // Undo of the amount fix puts 150 back; a later change blocks undoing an older one.
  const changes = (await call('list_changes', { entity: 'transaction' })).out.changes;
  const amountFix = changes.find((c) => c.tool === 'update_transaction' && c.summary.includes('จาก 150'));
  const blocked = await call('undo_change', { change_id: amountFix.id });
  assert.equal(blocked.isError, true); // the note was changed after it
});

test('mcpwrite: the app lists AI changes and can undo one; old grants cannot write money', async () => {
  const list = await A('GET', '/ai/changes');
  assert.ok(list.changes.length > 10);
  const last = list.changes.find((c) => c.tool === 'categorize_transaction');
  assert.equal(last.app, 'ChatGPT');
  const r = await A('POST', `/ai/changes/${last.id}/undo`);
  assert.equal(r.undoneChangeId, last.id);
  assert.equal((await A('POST', `/ai/changes/${last.id}/undo`)).error, 'cannot_undo');
  assert.equal((await B('POST', `/ai/changes/${last.id}/undo`)).error, 'cannot_undo'); // not B's

  if (!process.env.DATABASE_URL) return;
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const sha = crypto.createHash('sha256').update(token).digest('hex');
  await db.query("update oauth_grants set scope = 'centel.read centel.notes' where id = (select grant_id from oauth_tokens where token_hash = $1)", [sha]);
  const no = await call('create_transaction', { amount: 10 });
  assert.equal(no.isError, true);
  assert.match(no.text, /reconnect/);
  assert.equal((await call('create_todo', { title: 'ยังทำได้' })).isError, false);
  await db.end();
});
