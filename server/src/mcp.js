import express from 'express';
import { pool, asUser } from './db.js';
import { requireUser } from './auth.js';
import { thaiToday } from './noteparse.js';
import { bearer, cors, BASE, MCP_PATH } from './oauth.js';
import {
  isYm, r2, nowYm, ToolError, fail, context, txns, publicTx, range, totals, groupBy,
  budgetsFor, walletsNow, billsData, billMonth, notesList,
} from './mcpcore.js';
import { runTool, listChanges, undoChange, undoable, changeView } from './mcpwrite.js';
import { NOTE_TOOLS } from './mcpnotes.js';
import { MONEY_TOOLS, LARGE } from './mcpmoney.js';

/* Centel as a remote MCP server (Streamable HTTP, stateless, JSON responses only), so
   Claude and ChatGPT can read the person's money, budgets, bills, notes and to-dos and
   summarise them, and (with the scopes the person approved) manage notes and to-dos
   (centel.notes, mcpnotes.js) and budgets and transactions (centel.money, mcpmoney.js).
   Every tool runs as app_user for the signed-in person (asUser), so it sees and changes
   exactly what the app lets them: their own rows plus the couple's shared ones. Changes go
   through mcpwrite.js (confirmation, idempotency keys, audit log, undo). Bills live on the
   device; the app sends a copy (PUT /api/ai/bills) while an AI app is connected. Sign-in is
   OAuth (oauth.js). */

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const WRITE_SCOPES = ['centel.notes', 'centel.money'];
const SCOPE_OF = { note: 'centel.notes', budget: 'centel.money', transaction: 'centel.money' };

/* ---------- Tools ---------- */

const monthArg = { type: 'string', description: 'Month as YYYY-MM. Default: the current month in Thailand.' };
const fromArg = { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' };
const toArg = { type: 'string', description: 'End date YYYY-MM-DD (inclusive).' };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// Every to-do / note / change tool is listed after the read-only ones.
const TOOLS = [
  {
    name: 'get_overview',
    title: 'Monthly overview',
    description: 'One-call summary of a month in Centel: income, spending (by category), budgets, bills to pay, wallet balances and open to-dos. Start here for "สรุปเดือนนี้" style questions. Amounts are THB; for shared (couple) expenses "amount" is the user\'s own share.',
    inputSchema: { type: 'object', properties: { month: monthArg }, additionalProperties: false },
    run: async (db, ctx, a, user) => {
      const r = range({ month: a.month });
      const list = await txns(db, ctx, r.from, r.to);
      const exp = list.filter((t) => t.type === 'expense' && t.counted);
      const bills = billMonth(await billsData(user.id), r.month);
      return {
        month: r.month, today: thaiToday().date,
        user: ctx.me.nickname || ctx.me.display_name, partner: ctx.partner ? ctx.partner.nickname || ctx.partner.display_name : undefined,
        totals: totals(list),
        spendingByCategory: groupBy(exp, (t) => ctx.cats.name(ctx.cats.top(t.category))).slice(0, 12),
        incomeByCategory: groupBy(list.filter((t) => t.type === 'income' && t.counted), (t) => ctx.cats.name(t.category)),
        biggestExpenses: exp.slice().sort((x, y) => y.amount - x.amount).slice(0, 5).map(publicTx),
        transactionCount: list.length,
        budgets: await budgetsFor(db, ctx, r.month),
        bills: bills || 'No bill copy yet: open the Centel app once on the phone so it can send its bills.',
        wallets: await walletsNow(db, ctx),
        openTodos: (await notesList(db)).slice(0, 15),
      };
    },
  },
  {
    name: 'list_transactions',
    title: 'List transactions',
    description: 'Income, expense and transfer records, newest first, filtered by month or date range, type, category, shared/personal, wallet, label or text in the shop name / note.',
    inputSchema: {
      type: 'object',
      properties: {
        month: monthArg, from: fromArg, to: toArg,
        type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
        category: { type: 'string', description: 'Category id or name (includes its sub-categories). See list_categories.' },
        scope: { type: 'string', enum: ['personal', 'shared'] },
        wallet: { type: 'string', description: 'Wallet name or id.' },
        label: { type: 'string', description: 'Label (tag) name or id.' },
        text: { type: 'string', description: 'Words to find in the shop / merchant or note.' },
        min_amount: { type: 'number' }, max_amount: { type: 'number' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' },
      },
      additionalProperties: false,
    },
    run: async (db, ctx, a) => {
      const r = range(a);
      let list = await txns(db, ctx, r.from, r.to);
      if (a.type) list = list.filter((t) => t.type === a.type);
      if (a.scope) list = list.filter((t) => t.scope === a.scope);
      if (a.category) {
        const id = ctx.cats.find(a.category);
        if (!id) fail(`Unknown category "${a.category}". Use list_categories.`);
        const fam = ctx.cats.family(id);
        list = list.filter((t) => fam.has(t.category));
      }
      if (a.wallet) {
        const w = ctx.wallets.find((x) => x.id === a.wallet || x.name.toLowerCase() === String(a.wallet).toLowerCase());
        if (!w) fail(`Unknown wallet "${a.wallet}". Use get_wallets.`);
        list = list.filter((t) => t.walletId === w.id || t.toWalletId === w.id);
      }
      if (a.label) {
        const l = ctx.labels.find((x) => x.id === a.label || x.name.toLowerCase() === String(a.label).toLowerCase());
        if (!l) fail(`Unknown label "${a.label}".`);
        list = list.filter((t) => t.labelIds.includes(l.id));
      }
      if (a.text) {
        const s = String(a.text).toLowerCase();
        list = list.filter((t) => `${t.merchant || ''} ${t.note || ''} ${t.categoryName}`.toLowerCase().includes(s));
      }
      if (a.min_amount != null) list = list.filter((t) => (t.total ?? t.amount) >= Number(a.min_amount));
      if (a.max_amount != null) list = list.filter((t) => (t.total ?? t.amount) <= Number(a.max_amount));
      const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 500);
      return { from: r.from, to: r.to, matched: list.length, totals: totals(list), transactions: list.slice(0, limit).map(publicTx), truncated: list.length > limit || undefined };
    },
  },
  {
    name: 'spending_report',
    title: 'Spending report',
    description: 'Totals grouped by category, sub-category, shop, day, month, label or wallet for a month or date range. Use for "ใช้เงินไปกับอะไรมากที่สุด", trends across months, or comparing periods.',
    inputSchema: {
      type: 'object',
      properties: {
        month: monthArg, from: fromArg, to: toArg,
        type: { type: 'string', enum: ['expense', 'income'], description: 'Default expense.' },
        group_by: { type: 'string', enum: ['category', 'subcategory', 'merchant', 'day', 'month', 'label', 'wallet'], description: 'Default category.' },
        scope: { type: 'string', enum: ['personal', 'shared'] },
      },
      additionalProperties: false,
    },
    run: async (db, ctx, a) => {
      const r = range(a);
      const type = a.type === 'income' ? 'income' : 'expense';
      let list = (await txns(db, ctx, r.from, r.to)).filter((t) => t.type === type && t.counted);
      if (a.scope) list = list.filter((t) => t.scope === a.scope);
      const by = a.group_by || 'category';
      const key = {
        category: (t) => ctx.cats.name(ctx.cats.top(t.category)),
        subcategory: (t) => ctx.cats.name(t.category),
        merchant: (t) => t.merchant || t.note || '(ไม่ระบุร้าน)',
        day: (t) => t.date,
        month: (t) => t.date.slice(0, 7),
        label: (t) => (t.labels && t.labels.length ? t.labels : ['(ไม่มีป้าย)']),
        wallet: (t) => t.wallet || (t.scope === 'shared' ? '(คู่จ่าย)' : '(ไม่ระบุ)'),
      }[by] || fail('bad group_by');
      const groups = groupBy(list, key, ctx);
      if (by === 'day' || by === 'month') groups.sort((x, y) => (x.key < y.key ? -1 : 1));
      return { from: r.from, to: r.to, type, groupBy: by, total: r2(list.reduce((s, t) => s + t.amount, 0)), count: list.length, groups };
    },
  },
  {
    name: 'get_bills',
    title: 'Bills to pay',
    description: 'Bills (credit cards, electricity, water, internet, loans, subscriptions…) due in a month: due date, amount, paid or not, overdue. Also the list of repeating bills. Bills are a copy sent by the user\'s phone app.',
    inputSchema: { type: 'object', properties: { month: monthArg }, additionalProperties: false },
    run: async (_db, _ctx, a, user) => {
      const ym = a.month ? (isYm(a.month) ? a.month : fail('month must be YYYY-MM')) : nowYm();
      const data = await billsData(user.id);
      if (!data) return { month: ym, note: 'No bill copy yet. Ask the user to open the Centel app (signed in) so it can send its bills.' };
      const m = billMonth(data, ym);
      const months = Object.keys(data.months || {}).sort();
      return {
        ...(m || { month: ym, note: `No copy of this month. Months available: ${months.join(', ')}` }),
        repeatingBills: (data.bills || []).map((b) => ({
          name: b.name, category: b.category, kind: b.type, amount: b.amount, amountVaries: b.variable || undefined,
          dueDay: b.dueDay, autopay: b.autopay || undefined, installments: b.months || undefined, startMonth: b.startMonth,
          endMonth: b.endMonth || undefined, date: b.onceDate || undefined, note: b.note || undefined,
        })),
        syncedAt: data.syncedAt,
      };
    },
  },
  {
    name: 'get_wallets',
    title: 'Wallets and balances',
    description: 'Each wallet / bank account / card with its balance today, and the total.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (db, ctx) => walletsNow(db, ctx),
  },
  {
    name: 'list_categories',
    title: 'Categories and labels',
    description: 'The user\'s categories (with sub-categories) and labels, for filtering other tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_db, ctx) => ({ categories: ctx.cats.list, labels: ctx.labels.map((l) => l.name) }),
  },
  ...NOTE_TOOLS,
  ...MONEY_TOOLS,
  {
    name: 'list_changes',
    title: 'Changes made by AI',
    description: 'The latest changes AI apps made in Centel (to-dos, notes, budgets, transactions), newest first, with ids for undo_change.',
    inputSchema: {
      type: 'object',
      properties: { entity: { type: 'string', enum: ['note', 'budget', 'transaction'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    run: async (db, _ctx, a) => ({ changes: await listChanges(db, { entity: a.entity, limit: Math.min(Math.max(Number(a.limit) || 20, 1), 100) }) }),
  },
  {
    name: 'undo_change',
    title: 'Undo a change',
    description: 'Put back what one change from list_changes did (a created item is removed, a changed one goes back, a deleted one comes back). Refused if the item was changed again since. Needs the user\'s confirmation: the first call returns a preview and confirm_token.',
    inputSchema: {
      type: 'object',
      properties: { change_id: { type: 'integer' }, confirm_token: { type: 'string', description: 'After the user confirmed the preview.' } },
      required: ['change_id'],
      additionalProperties: false,
    },
    scope: '*',
    destructive: true,
    confirm: async (db, _ctx, a, user) => {
      const { c: row } = await undoable(db, Number(a.change_id));
      if (!user.scopes?.has(SCOPE_OF[row.entity])) fail('This connection is not allowed to change that kind of item.');
      const c = changeView(row);
      return { action: 'undo', change: c, result: c.action === 'create' ? 'the item will be removed' : c.action === 'delete' ? 'the item will come back' : 'the item goes back to how it was before' };
    },
    run: async (db, _ctx, a, user) => {
      const c = (await db.query('select entity from mcp_audit where id = $1', [Number(a.change_id)])).rows[0];
      if (c && !user.scopes?.has(SCOPE_OF[c.entity])) fail('This connection is not allowed to change that kind of item.');
      return undoChange(db, user, Number(a.change_id));
    },
  },
  // search + fetch: the pair ChatGPT's connectors and deep research look for.
  {
    name: 'search',
    title: 'Search Centel',
    description: 'Search transactions (shop, note, category), to-dos, notes and bills by words. Returns ids to pass to fetch.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run: async (db, ctx, a, user) => {
      const q = String(a.query || '').trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hit = (s) => words.every((w) => s.toLowerCase().includes(w));
      const results = [];
      const ym = /^(\d{4}-\d{2})$/.exec(q);
      if (ym && isYm(ym[1])) results.push({ id: `month:${ym[1]}`, title: `สรุปเดือน ${ym[1]}`, url: `${BASE()}/` });
      const list = await txns(db, ctx, '1970-01-01', '9999-12-31');
      for (const t of list) {
        if (results.length >= 30) break;
        if (!words.length || hit(`${t.merchant || ''} ${t.note || ''} ${t.categoryName} ${t.date} ${(t.labels || []).join(' ')}`)) {
          results.push({ id: `txn:${t.id}`, title: `${t.date} ${t.merchant || t.note || t.categoryName} ${t.type === 'income' ? '+' : t.type === 'expense' ? '-' : ''}${t.amount} ${t.currency}`, url: `${BASE()}/` });
        }
      }
      const notes = [...await notesList(db, { include_done: true }), ...await notesList(db, { kind: 'memo' })];
      for (const n of notes) {
        if (results.length >= 40) break;
        if (words.length && hit(`${n.title} ${n.description || n.content || ''} ${(n.tags || []).join(' ')} ${n.date || ''}`)) {
          results.push({ id: `note:${n.id}`, title: `${n.kind === 'memo' ? 'โน้ต ' : ''}${n.date || ''} ${n.title}`.trim(), url: `${BASE()}/` });
        }
      }
      const bills = await billsData(user.id);
      for (const b of bills?.bills || []) {
        if (words.length && hit(`${b.name} ${b.category || ''}`)) results.push({ id: `bill:${b.id}`, title: `บิล ${b.name}`, url: `${BASE()}/` });
      }
      return { results };
    },
  },
  {
    name: 'fetch',
    title: 'Fetch a Centel item',
    description: 'Full details of one item from search: txn:<id>, note:<id>, bill:<id> or month:YYYY-MM.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: async (db, ctx, a, user) => {
      const [kind, ...rest] = String(a.id || '').split(':');
      const id = rest.join(':');
      let doc;
      if (kind === 'month' && isYm(id)) {
        doc = await TOOLS.find((t) => t.name === 'get_overview').run(db, ctx, { month: id }, user);
      } else if (kind === 'txn' && /^[0-9a-f-]{36}$/i.test(id)) {
        doc = (await txns(db, ctx, '1970-01-01', '9999-12-31')).find((t) => t.id === id);
        if (doc) doc = publicTx(doc);
      } else if (kind === 'note') {
        doc = [...await notesList(db, { include_done: true }), ...await notesList(db, { kind: 'memo' })].find((n) => n.id === id);
      } else if (kind === 'bill') {
        const data = await billsData(user.id);
        const b = (data?.bills || []).find((x) => x.id === id);
        if (b) {
          const history = Object.entries(data.months || {}).sort().flatMap(([ym, list]) =>
            list.filter((o) => o.billId === id).map((o) => ({ month: ym, due: o.due, amount: o.amount, paid: !!o.paid, status: o.status })));
          doc = { ...b, history };
        }
      }
      if (!doc) fail(`Not found: ${a.id}`);
      return { id: a.id, title: doc.title || doc.name || doc.merchant || doc.month || a.id, text: JSON.stringify(doc), url: `${BASE()}/`, metadata: { kind } };
    },
  },
];

const INSTRUCTIONS = [
  'Centel is a Thai family money app: bills to pay, income/expense records, budgets, wallets, notes and to-dos, for one person and (optionally) their partner.',
  'Money is Thai baht (THB) unless a row says otherwise. Dates and times are Thailand time (Asia/Bangkok); work out words like "พรุ่งนี้" or "วันศุกร์หน้า" from today in Bangkok (list_todos returns it), or pass them in `when`.',
  'Write tools (to-dos, notes, budgets, transactions) only change records inside Centel; nothing can move real money. Check details with the user before writing. Deletes, undo, money changes (a transaction or budget amount, type or wallet) and transactions of ' + LARGE.toLocaleString('en-US') + ' baht or more answer first with status "needs_confirmation", a preview and a confirm_token: show the preview, wait for the user to say yes, then call again with the same arguments plus confirm_token. Never confirm on the user\'s behalf.',
  'Never say something was saved, changed or deleted unless the answer\'s status says so (created / updated / completed / rescheduled / deleted / undone). "possible_duplicate" and "already_exists" mean nothing new was saved. Send an idempotency_key (a fresh UUID per user request) on create calls so a retry cannot add things twice. Each change gets a changeId; undo_change can reverse it.',
  'For shared (couple) expenses, "amount" is the user\'s own share and "total" is the whole bill.',
  'Start with get_overview for a summary; use spending_report and list_transactions to dig in. Answer in the user\'s language (usually Thai).',
].join(' ');

/* ---------- JSON-RPC ---------- */

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg, user) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcErr(msg?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification (initialized, cancelled, …)
  switch (method) {
    case 'initialize': {
      const want = params.protocolVersion;
      return rpcOk(id, {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'centel', title: 'Centel', version: '1.0.0', websiteUrl: BASE() },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return rpcOk(id, {});
    case 'tools/list':
      return rpcOk(id, { tools: TOOLS.map(({ name, title, description, inputSchema, scope, destructive }) => ({
        name, title, description, inputSchema,
        annotations: { title, ...(scope ? { ...WRITE, destructiveHint: !!destructive } : RO) },
      })) });
    case 'resources/list': return rpcOk(id, { resources: [] });
    case 'resources/templates/list': return rpcOk(id, { resourceTemplates: [] });
    case 'prompts/list': return rpcOk(id, { prompts: [] });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcErr(id, -32602, `Unknown tool: ${params.name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      // Connections approved before a kind of change was allowed stay without it until approved again.
      const allowed = tool.scope === '*' ? WRITE_SCOPES.some((s) => user.scopes?.has(s)) : !tool.scope || user.scopes?.has(tool.scope);
      if (!allowed) {
        return rpcOk(id, { content: [{ type: 'text', text: `This connection is not allowed to do that yet${tool.scope === 'centel.money' ? ' (budgets and transactions)' : ''}. Nothing was changed. Ask the user to reconnect Centel (disconnect and connect again in the AI app, then tap อนุญาต) to allow it.` }], isError: true });
      }
      try {
        const out = await asUser(user.id, async (db) => runTool(tool, db, await context(db), args, user));
        return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('mcp tool', tool.name, e);
        const msg = e instanceof ToolError ? e.message : tool.scope ? 'Centel could not save that right now. Nothing was changed.' : 'Centel could not read that right now.';
        return rpcOk(id, { content: [{ type: 'text', text: msg }], isError: true });
      }
    }
    default: return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

export const mcpRouter = express.Router();
mcpRouter.use(cors);
mcpRouter.options('/', (_req, res) => res.sendStatus(204));
// No server-to-client stream: every answer comes back on the POST.
mcpRouter.get('/', bearer, (_req, res) => res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }));
mcpRouter.delete('/', (_req, res) => res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }));
mcpRouter.post('/', bearer, wrap(async (req, res) => {
  const body = req.body;
  const user = req.mcpUser;
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, user)))).filter(Boolean);
    return out.length ? res.json(out) : res.sendStatus(202);
  }
  const out = await handle(body, user);
  if (!out) return res.sendStatus(202);
  res.json(out);
}));

/* ---------- The app's side: connected apps and the bill copy ---------- */

export const aiRouter = express.Router();
aiRouter.use(requireUser);

const activeApps = async (userId) => (await pool.query(
  `select g.id, c.name, g.created_at, g.last_used_at from oauth_grants g join oauth_clients c on c.id = g.client_id
   where g.user_id = $1 and g.revoked_at is null order by g.created_at desc`, [userId])).rows;

aiRouter.get('/', wrap(async (req, res) => {
  const apps = await activeApps(req.user.id);
  const bills = (await pool.query('select updated_at from mcp_bills where user_id = $1', [req.user.id])).rows[0];
  res.json({
    url: BASE() + MCP_PATH,
    apps: apps.map((a) => ({ id: a.id, name: a.name, createdAt: a.created_at, lastUsedAt: a.last_used_at })),
    billsAt: bills ? bills.updated_at : null,
  });
}));

aiRouter.delete('/apps/:id', wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  const r = await pool.query('update oauth_grants set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null', [req.params.id, req.user.id]);
  if (r.rowCount) await pool.query('delete from oauth_tokens where grant_id = $1', [req.params.id]);
  // With no app left, the bill copy has no reader: drop it.
  if (!(await activeApps(req.user.id)).length) await pool.query('delete from mcp_bills where user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));

aiRouter.put('/bills', wrap(async (req, res) => {
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.bills) || typeof data.months !== 'object') return res.status(400).json({ error: 'bad_bills' });
  const json = JSON.stringify(data);
  if (json.length > 400000) return res.status(413).json({ error: 'too_large' });
  if (!(await activeApps(req.user.id)).length) return res.status(409).json({ error: 'no_apps' });
  await pool.query(
    `insert into mcp_bills (user_id, data, updated_at) values ($1, $2, now())
     on conflict (user_id) do update set data = excluded.data, updated_at = now()`, [req.user.id, json]);
  res.json({ ok: true });
}));

// What AI apps changed, for บัญชี › เชื่อมกับ AI, and undoing one from the app.
aiRouter.get('/changes', wrap(async (req, res) => {
  const changes = await asUser(req.user.id, (db) => listChanges(db, { limit: 50 }));
  res.json({ changes });
}));

aiRouter.post('/changes/:id/undo', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  try {
    const out = await asUser(req.user.id, (db) => undoChange(db, { grantId: null, client: 'Centel' }, id, 'app'));
    res.json(out);
  } catch (e) {
    if (e instanceof ToolError) return res.status(409).json({ error: 'cannot_undo', message: e.message });
    throw e;
  }
}));
