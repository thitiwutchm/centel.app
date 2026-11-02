import express from 'express';
import { pool, asUser } from './db.js';
import { requireUser } from './auth.js';
import { thaiToday } from './noteparse.js';
import { bearer, cors, BASE, MCP_PATH } from './oauth.js';

/* Centel as a remote MCP server (Streamable HTTP, stateless, JSON responses only), so
   Claude and ChatGPT can read the person's money, budgets, bills and to-do notes and
   summarise them. Every tool is read-only and runs as app_user for the signed-in
   person (asUser), so it sees exactly what the app shows them: their own rows plus the
   couple's shared ones. Bills live on the device; the app sends a copy (PUT /api/ai/bills)
   while an AI app is connected. Sign-in is OAuth (oauth.js). */

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isYm = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const addMonths = (ym, k) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const nowYm = () => thaiToday().date.slice(0, 7);

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };

/* ---------- Categories ---------- */

// Default names, as in money.js TX_CATS; the person's own list is prefs.data.cats.
const DEFAULT_CATS = {
  apparel: 'Apparel & Accessories', food: 'Food & Groceries', coffee: 'Coffee & Beverage', hangout: 'Hang Out',
  utility: 'Utility Bills', subscription: 'Monthly Subscriptions', transport: 'Transportation', home: 'Home & Living',
  health: 'Health & Medical', beauty: 'Beauty & Personal Care', travel: 'Travel & Trips', fitness: 'Fitness & Sports',
  pets: 'Pets', gift: 'Gifts & Donations', gadget: 'Gadgets & Electronics', rent: 'Rent & Insurance', baby: 'Baby',
  other_exp: 'Others', salary: 'เงินเดือน', bonus: 'โบนัส', sale: 'ขายของ', interest: 'ดอกเบี้ยและปันผล',
  debt_collect: 'รับคืนเงินยืม', other_inc: 'รายรับอื่นๆ',
};

function catBook(prefs) {
  const list = Array.isArray(prefs?.cats) && prefs.cats.length ? prefs.cats : null;
  const byId = new Map();
  if (list) {
    for (const c of list) if (c && typeof c.id === 'string') byId.set(c.id, { name: String(c.label || c.id), parent: c.parent || null, type: c.type });
  }
  for (const [id, name] of Object.entries(DEFAULT_CATS)) if (!byId.has(id)) byId.set(id, { name, parent: null });
  const name = (id) => (id ? byId.get(id)?.name || id : 'รอตรวจสอบ (ไม่มีหมวด)');
  const top = (id) => { const c = id && byId.get(id); return c && c.parent && byId.has(c.parent) ? c.parent : id; };
  // A category and its sub-categories, for filters and budgets.
  const family = (id) => new Set([id, ...[...byId].filter(([, c]) => c.parent === id).map(([k]) => k)]);
  // Matches a category id or (loosely) a name the AI typed.
  const find = (q) => {
    if (!q) return null;
    if (byId.has(q)) return q;
    const s = String(q).toLowerCase();
    for (const [id, c] of byId) if (c.name.toLowerCase() === s) return id;
    for (const [id, c] of byId) if (c.name.toLowerCase().includes(s)) return id;
    return null;
  };
  return { name, top, family, find, list: [...byId].map(([id, c]) => ({ id, name: c.name, parent: c.parent || undefined })) };
}

/* ---------- Loading ---------- */

async function context(db) {
  const me = (await db.query('select id, display_name, nickname from users where id = app_uid()')).rows[0];
  const partner = (await db.query('select id, display_name, nickname from users where id = my_partner()')).rows[0] || null;
  const prefs = (await db.query('select data from prefs where user_id = app_uid()')).rows[0]?.data || {};
  const wallets = (await db.query('select id, name, type, initial, excluded from wallets order by sort, name')).rows;
  const labels = (await db.query('select id, name from labels order by sort, name')).rows;
  return {
    me, partner, cats: catBook(prefs),
    wallets, walletName: (id) => (id ? wallets.find((w) => w.id === id)?.name || id : null),
    labels, labelName: (id) => labels.find((l) => l.id === id)?.name || id,
    who: (id) => (id === me.id ? 'me' : partner && id === partner.id ? 'partner' : 'other'),
  };
}

// Transactions between two dates (inclusive), with my share of shared ones.
async function txns(db, ctx, from, to) {
  const rows = (await db.query(
    `select e.id, e.owner_id, e.scope, e.type, e.date, e.merchant, e.amount, e.currency, e.category, e.note,
            e.wallet_id, e.to_wallet_id, e.payer_id, e.payer_wallet_id, e.status, e.bill_id, e.bill_ym, e.created_at,
            s.amount as my_share,
            coalesce((select array_agg(l.label_id) from expense_labels l where l.expense_id = e.id), '{}') as labels
     from expenses e left join expense_shares s on s.expense_id = e.id and s.user_id = app_uid()
     where e.date between $1 and $2
     order by e.date desc, e.created_at desc`, [from, to])).rows;
  return rows.map((e) => {
    const shared = e.scope === 'shared';
    const mine = shared && e.payer_id === ctx.me.id;
    return {
      id: e.id,
      date: e.date,
      type: e.type,
      scope: e.scope,
      amount: r2(shared ? e.my_share || 0 : e.amount), // my money: my share of a shared row
      total: shared ? r2(e.amount) : undefined,
      currency: e.currency || 'THB',
      category: e.type === 'transfer' ? undefined : e.category,
      categoryName: e.type === 'transfer' ? 'โอนเงิน' : ctx.cats.name(e.category),
      merchant: e.merchant || undefined,
      note: e.note || undefined,
      wallet: shared ? (mine ? ctx.walletName(e.owner_id === ctx.me.id ? e.wallet_id : e.payer_wallet_id) : undefined) : ctx.walletName(e.wallet_id),
      walletId: shared ? (mine ? (e.owner_id === ctx.me.id ? e.wallet_id : e.payer_wallet_id) : null) : e.wallet_id,
      toWallet: e.to_wallet_id ? ctx.walletName(e.to_wallet_id) : undefined,
      toWalletId: e.to_wallet_id || undefined,
      addedBy: ctx.who(e.owner_id),
      paidBy: shared ? ctx.who(e.payer_id) : undefined,
      status: shared && e.status !== 'approved' ? e.status : undefined,
      labels: e.labels.length ? e.labels.map(ctx.labelName) : undefined,
      labelIds: e.labels,
      bill: e.bill_id ? { id: e.bill_id, month: e.bill_ym } : undefined,
      counted: !shared || e.status === 'approved',
    };
  });
}

const publicTx = (t) => { const { counted, labelIds, walletId, toWalletId, ...rest } = t; return rest; };

function range(args, { defaultMonth = true } = {}) {
  if (args.month != null && !isYm(args.month)) fail('month must be YYYY-MM');
  if (args.from != null && !isDate(args.from)) fail('from must be YYYY-MM-DD');
  if (args.to != null && !isDate(args.to)) fail('to must be YYYY-MM-DD');
  if (args.month) return { from: `${args.month}-01`, to: lastDay(args.month), month: args.month };
  if (args.from || args.to) {
    const from = args.from || '1970-01-01', to = args.to || thaiToday().date;
    if (from > to) fail('from is after to');
    return { from, to };
  }
  if (!defaultMonth) return { from: '1970-01-01', to: '9999-12-31' };
  const m = nowYm();
  return { from: `${m}-01`, to: lastDay(m), month: m };
}

function totals(list) {
  let income = 0, expense = 0, sharedExpense = 0;
  for (const t of list) {
    if (!t.counted) continue;
    if (t.type === 'income') income += t.amount;
    if (t.type === 'expense') { expense += t.amount; if (t.scope === 'shared') sharedExpense += t.total; }
  }
  return { income: r2(income), expense: r2(expense), net: r2(income - expense), sharedExpenseWholeCouple: r2(sharedExpense) };
}

function groupBy(list, key, ctx) {
  const m = new Map();
  for (const t of list) {
    const keys = key(t);
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      const g = m.get(k) || { key: k, total: 0, count: 0 };
      g.total += t.amount; g.count += 1;
      m.set(k, g);
    }
  }
  const sum = list.reduce((s, t) => s + t.amount, 0);
  return [...m.values()].map((g) => ({ ...g, total: r2(g.total), percent: sum ? Math.round((g.total / sum) * 1000) / 10 : 0 }))
    .sort((a, b) => b.total - a.total);
}

/* ---------- Budgets / wallets / bills / notes ---------- */

async function budgetsFor(db, ctx, ym) {
  const budgets = (await db.query('select id, scope, category, amount, wallet_id from budgets order by created_at')).rows;
  if (!budgets.length) return [];
  const list = (await txns(db, ctx, `${ym}-01`, lastDay(ym))).filter((t) => t.type === 'expense' && t.counted);
  const t = thaiToday();
  const cur = t.date.slice(0, 7);
  const pace = ym < cur ? 1 : ym > cur ? 0 : Number(t.date.slice(8)) / Number(lastDay(ym).slice(8));
  return budgets.map((b) => {
    const fam = b.category === 'all' ? null : ctx.cats.family(b.category);
    const hit = list.filter((x) => (!fam || fam.has(x.category)) && (b.scope === 'shared'
      ? x.scope === 'shared'
      : (b.wallet_id === 'total' || !b.wallet_id) ? true : x.walletId === b.wallet_id));
    const spent = r2(hit.reduce((s, x) => s + (b.scope === 'shared' ? x.total : x.amount), 0));
    return {
      id: b.id, scope: b.scope, category: b.category === 'all' ? 'ทุกหมวด' : ctx.cats.name(b.category),
      wallet: b.wallet_id && b.wallet_id !== 'total' ? ctx.walletName(b.wallet_id) : 'ทุกกระเป๋า',
      budget: r2(b.amount), spent, remaining: r2(b.amount - spent), usedPercent: Math.round((spent / b.amount) * 1000) / 10,
      monthElapsedPercent: Math.round(pace * 1000) / 10,
      state: spent > b.amount ? 'over' : spent / b.amount > pace + 0.02 ? 'ahead_of_pace' : 'ok',
    };
  });
}

async function walletsNow(db, ctx) {
  const today = thaiToday().date;
  const list = await txns(db, ctx, '1970-01-01', today);
  const settle = (await db.query(
    `select debtor_id, creditor_id, amount, debtor_wallet_id, creditor_wallet_id from settlements where status = 'paid'`)).rows;
  const bal = new Map(ctx.wallets.map((w) => [w.id, Number(w.initial) || 0]));
  const add = (id, v) => { if (id && bal.has(id)) bal.set(id, bal.get(id) + v); };
  for (const t of list) {
    if (t.scope === 'shared') { if (t.counted && t.paidBy === 'me') add(t.walletId, -t.total); continue; }
    if (t.type === 'income') add(t.walletId, t.amount);
    else if (t.type === 'expense') add(t.walletId, -t.amount);
    else if (t.type === 'transfer') { add(t.walletId, -t.amount); add(t.toWalletId, t.amount); }
  }
  for (const s of settle) {
    if (s.debtor_id === ctx.me.id) add(s.debtor_wallet_id, -Number(s.amount));
    if (s.creditor_id === ctx.me.id) add(s.creditor_wallet_id, Number(s.amount));
  }
  const wallets = ctx.wallets.map((w) => ({ id: w.id, name: w.name, type: w.type, balance: r2(bal.get(w.id)), excludedFromTotal: w.excluded || undefined }));
  return { asOf: today, wallets, total: r2(wallets.filter((w) => !w.excludedFromTotal).reduce((s, w) => s + w.balance, 0)) };
}

async function billsData(userId) {
  const row = (await pool.query('select data, updated_at from mcp_bills where user_id = $1', [userId])).rows[0];
  return row ? { ...row.data, syncedAt: row.updated_at } : null;
}

function billMonth(b, ym) {
  const list = Array.isArray(b?.months?.[ym]) ? b.months[ym] : null;
  if (!list) return null;
  // The copy may be days old, so overdue / days left are worked out again for today.
  const today = thaiToday().date;
  const days = (d) => Math.round((Date.parse(d) - Date.parse(today)) / 86400000);
  const items = list.map((o) => ({
    name: o.name, category: o.category, due: o.due, amount: r2(o.amount), amountKnown: !o.needsAmount,
    status: o.paid ? 'paid' : !isDate(o.due) ? o.status : days(o.due) < 0 ? 'overdue' : days(o.due) === 0 ? 'due_today' : 'upcoming',
    daysLeft: o.paid || !isDate(o.due) ? undefined : days(o.due), paid: !!o.paid, paidAt: o.paidAt || undefined, autopay: o.autopay || undefined,
    installment: o.inst ? `${o.inst.n}/${o.inst.of}` : undefined, billId: o.billId,
  }));
  const sum = (f) => r2(items.filter(f).reduce((s, o) => s + o.amount, 0));
  return {
    month: ym, bills: items,
    total: sum(() => true), paid: sum((o) => o.paid), unpaid: sum((o) => !o.paid),
    overdue: items.filter((o) => o.status === 'overdue').map((o) => o.name),
  };
}

async function notesList(db, args = {}) {
  const rows = (await db.query(
    `select id, text, date, time, end_date, end_time, done, done_at, couple_id, owner_id
     from notes ${args.include_done ? '' : 'where not done'} order by date nulls last, time nulls first, created_at`)).rows;
  return rows
    .filter((n) => (!args.from || (n.date && n.date >= args.from)) && (!args.to || (n.date && n.date <= args.to)))
    .map((n) => ({
      id: n.id, text: n.text, date: n.date || undefined, time: n.time ? n.time.slice(0, 5) : undefined,
      endDate: n.end_date || undefined, endTime: n.end_time ? n.end_time.slice(0, 5) : undefined,
      shared: !!n.couple_id, done: n.done || undefined,
    }));
}

/* ---------- Tools ---------- */

const monthArg = { type: 'string', description: 'Month as YYYY-MM. Default: the current month in Thailand.' };
const fromArg = { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' };
const toArg = { type: 'string', description: 'End date YYYY-MM-DD (inclusive).' };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

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
    name: 'get_budgets',
    title: 'Budgets',
    description: 'Monthly budgets with how much is spent, what is left, and whether spending is ahead of the month\'s pace.',
    inputSchema: { type: 'object', properties: { month: monthArg }, additionalProperties: false },
    run: async (db, ctx, a) => {
      const r = range({ month: a.month });
      return { month: r.month, budgets: await budgetsFor(db, ctx, r.month) };
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
    name: 'get_notes',
    title: 'To-do notes',
    description: 'The to-do notes / appointments (สิ่งที่ต้องทำ, นัด) from Centel and its LINE group, with date and time. Open ones only unless include_done.',
    inputSchema: {
      type: 'object',
      properties: { include_done: { type: 'boolean' }, from: fromArg, to: toArg },
      additionalProperties: false,
    },
    run: async (db, _ctx, a) => {
      if (a.from != null && !isDate(a.from)) fail('from must be YYYY-MM-DD');
      if (a.to != null && !isDate(a.to)) fail('to must be YYYY-MM-DD');
      return { today: thaiToday().date, notes: await notesList(db, a) };
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
  // search + fetch: the pair ChatGPT's connectors and deep research look for.
  {
    name: 'search',
    title: 'Search Centel',
    description: 'Search transactions (shop, note, category), to-do notes and bills by words. Returns ids to pass to fetch.',
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
      for (const n of await notesList(db, { include_done: true })) {
        if (results.length >= 40) break;
        if (words.length && hit(`${n.text} ${n.date || ''}`)) results.push({ id: `note:${n.id}`, title: `${n.date || ''} ${n.text}`.trim(), url: `${BASE()}/` });
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
        doc = (await notesList(db, { include_done: true })).find((n) => n.id === id);
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
      return { id: a.id, title: doc.text || doc.name || doc.merchant || doc.month || a.id, text: JSON.stringify(doc), url: `${BASE()}/`, metadata: { kind } };
    },
  },
];

const INSTRUCTIONS = [
  'Centel is a Thai family money app: bills to pay, income/expense records, monthly budgets, wallets and to-do notes, for one person and (optionally) their partner.',
  'All tools are read-only. Money is Thai baht (THB) unless a row says otherwise. Dates are in Thailand time (Asia/Bangkok).',
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
      return rpcOk(id, { tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: { title, ...RO } })) });
    case 'resources/list': return rpcOk(id, { resources: [] });
    case 'resources/templates/list': return rpcOk(id, { resourceTemplates: [] });
    case 'prompts/list': return rpcOk(id, { prompts: [] });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcErr(id, -32602, `Unknown tool: ${params.name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        const out = await asUser(user.id, async (db) => tool.run(db, await context(db), args, user));
        return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('mcp tool', tool.name, e);
        return rpcOk(id, { content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'Centel could not read that right now.' }], isError: true });
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
