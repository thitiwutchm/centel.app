import { pool } from './db.js';
import { thaiToday } from './noteparse.js';

/* Shared pieces of the MCP server (mcp.js): reading the person's data the way the app
   shows it, and the small checks every tool uses. */

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

const INCOME_CATS = new Set(['salary', 'bonus', 'sale', 'interest', 'debt_collect', 'other_inc']);

function catBook(prefs) {
  const list = Array.isArray(prefs?.cats) && prefs.cats.length ? prefs.cats : null;
  const byId = new Map();
  if (list) {
    for (const c of list) if (c && typeof c.id === 'string') byId.set(c.id, { name: String(c.label || c.id), parent: c.parent || null, type: c.type });
  }
  for (const [id, name] of Object.entries(DEFAULT_CATS)) if (!byId.has(id)) byId.set(id, { name, parent: null });
  for (const [id, c] of byId) if (!c.type) c.type = INCOME_CATS.has(id) || INCOME_CATS.has(c.parent) ? 'income' : 'expense';
  const name = (id) => (id ? byId.get(id)?.name || id : 'รอตรวจสอบ (ไม่มีหมวด)');
  const top = (id) => { const c = id && byId.get(id); return c && c.parent && byId.has(c.parent) ? c.parent : id; };
  // A category and its sub-categories, for filters and budgets.
  const family = (id) => new Set([id, ...[...byId].filter(([, c]) => c.parent === id).map(([k]) => k)]);
  // Matches a category id or (loosely) a name the AI typed.
  // With a type, only categories of that type (expense / income) match.
  const find = (q, type) => {
    if (!q) return null;
    const ok = (c) => !type || c.type === type;
    if (byId.has(q)) return ok(byId.get(q)) ? q : null;
    const s = String(q).toLowerCase();
    for (const [id, c] of byId) if (ok(c) && c.name.toLowerCase() === s) return id;
    for (const [id, c] of byId) if (ok(c) && c.name.toLowerCase().includes(s)) return id;
    return null;
  };
  const typeOf = (id) => byId.get(id)?.type || null;
  return { name, top, family, find, typeOf, list: [...byId].map(([id, c]) => ({ id, name: c.name, type: c.type, parent: c.parent || undefined })) };
}

/* ---------- Loading ---------- */

async function context(db) {
  const me = (await db.query('select id, display_name, nickname from users where id = app_uid()')).rows[0];
  const partner = (await db.query('select id, display_name, nickname from users where id = my_partner()')).rows[0] || null;
  const prefs = (await db.query('select data from prefs where user_id = app_uid()')).rows[0]?.data || {};
  const wallets = (await db.query('select id, name, type, initial, excluded from wallets order by sort, name')).rows;
  const labels = (await db.query('select id, name from labels order by sort, name')).rows;
  return {
    me, partner, prefs, cats: catBook(prefs),
    wallets, walletName: (id) => (id ? wallets.find((w) => w.id === id)?.name || id : null),
    labels, labelName: (id) => labels.find((l) => l.id === id)?.name || id,
    who: (id) => (id === me.id ? 'me' : partner && id === partner.id ? 'partner' : 'other'),
  };
}

// Transactions between two dates (inclusive), with my share of shared ones.
async function txns(db, ctx, from, to) {
  const rows = (await db.query(
    `select e.id, e.owner_id, e.scope, e.type, e.date, e.merchant, e.amount, e.currency, e.fx, e.category, e.note,
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
      original: e.fx ? { currency: e.fx.cur, amount: e.fx.amt, rateToThb: e.fx.rate, rateDate: e.fx.date } : undefined,
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

// Day arithmetic on YYYY-MM-DD strings (UTC, no time zone shifts).
const dayMs = 86400000;
const addDays = (ds, k) => new Date(Date.parse(ds) + k * dayMs).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);
const weekStart = (ds) => addDays(ds, -((new Date(Date.parse(ds)).getUTCDay() + 6) % 7)); // Monday

// The dates a budget covers around a day: its month, its Monday–Sunday week, or its own range.
function budgetWindow(b, ref) {
  if (b.period === 'custom') return { from: b.start_date, to: b.end_date };
  if (b.period === 'week') { const from = weekStart(ref); return { from, to: addDays(from, 6) }; }
  const ym = ref.slice(0, 7);
  return { from: `${ym}-01`, to: lastDay(ym) };
}
// The window before (k = -1) or after this one; a custom budget has only its own.
function shiftWindow(b, win, k) {
  if (b.period === 'week') return { from: addDays(win.from, 7 * k), to: addDays(win.to, 7 * k) };
  const ym = addMonths(win.from.slice(0, 7), k);
  return { from: `${ym}-01`, to: lastDay(ym) };
}

const budgetCols = 'id, owner_id, couple_id, scope, category, amount, wallet_id, name, period, start_date, end_date, merchant, created_at';

// What one budget has spent in a window, worked out like the app's budgetSpent().
function budgetUse(b, ctx, list, win, today) {
  const fam = b.category === 'all' ? null : ctx.cats.family(b.category);
  const shop = b.merchant ? b.merchant.toLowerCase() : null;
  const hit = list.filter((x) => x.type === 'expense' && x.counted && x.date >= win.from && x.date <= win.to
    && (!fam || fam.has(x.category))
    && (!shop || `${x.merchant || ''} ${x.note || ''}`.toLowerCase().includes(shop))
    && (b.scope === 'shared' ? x.scope === 'shared' : (b.wallet_id === 'total' || !b.wallet_id) ? true : x.walletId === b.wallet_id));
  const amount = Number(b.amount);
  const spent = r2(hit.reduce((s, x) => s + (b.scope === 'shared' ? x.total : x.amount), 0));
  const days = daysBetween(win.from, win.to) + 1;
  const elapsed = today < win.from ? 0 : today > win.to ? days : daysBetween(win.from, today) + 1;
  const pace = elapsed / days;
  const daysLeft = days - elapsed;
  const remaining = r2(amount - spent);
  return {
    from: win.from, to: win.to, budget: r2(amount), spent, remaining,
    usedPercent: amount ? Math.round((spent / amount) * 1000) / 10 : 0,
    periodElapsedPercent: Math.round(pace * 1000) / 10,
    daysLeft,
    perDayLeft: remaining > 0 && today <= win.to ? r2(remaining / Math.max(1, today < win.from ? days : daysLeft + 1)) : 0,
    state: spent > amount ? 'over' : spent / amount > pace + 0.02 ? 'ahead_of_pace' : 'ok',
    transactions: hit.length,
  };
}

const PERIOD_NAME = { month: 'รายเดือน', week: 'รายสัปดาห์', custom: 'กำหนดช่วงเอง' };

function budgetInfo(b, ctx) {
  return {
    id: b.id,
    name: b.name || (b.category === 'all' ? 'ทุกหมวด' : ctx.cats.name(b.category)),
    scope: b.scope,
    category: b.category === 'all' ? 'all' : b.category,
    categoryName: b.category === 'all' ? 'ทุกหมวด' : ctx.cats.name(b.category),
    period: b.period || 'month', periodName: PERIOD_NAME[b.period || 'month'],
    startDate: b.start_date || undefined, endDate: b.end_date || undefined,
    merchant: b.merchant || undefined,
    wallet: b.wallet_id && b.wallet_id !== 'total' ? ctx.walletName(b.wallet_id) : 'ทุกกระเป๋า',
    amount: r2(b.amount),
  };
}

async function budgetRows(db) { return (await db.query(`select ${budgetCols} from budgets order by created_at`)).rows; }

// Every budget with its status on a day (default today); `ym` picks a month instead
// (its last day for a past month, its first for a future one, today for this month).
async function budgetsFor(db, ctx, ym, { ref } = {}) {
  const budgets = await budgetRows(db);
  if (!budgets.length) return [];
  const today = thaiToday().date;
  if (!ref) ref = !ym || ym === today.slice(0, 7) ? today : ym < today.slice(0, 7) ? lastDay(ym) : `${ym}-01`;
  const wins = budgets.map((b) => budgetWindow(b, ref));
  const from = wins.reduce((m, w) => (w.from < m ? w.from : m), '9999-12-31');
  const to = wins.reduce((m, w) => (w.to > m ? w.to : m), '0000-01-01');
  const list = await txns(db, ctx, from, to);
  return budgets.map((b, i) => ({ ...budgetInfo(b, ctx), ...budgetUse(b, ctx, list, wins[i], today) }));
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

const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

// A note row as the AI sees it: a to-do (with its status) or a memo.
function noteView(n) {
  const base = {
    id: n.id, kind: n.kind || 'todo', title: n.text, shared: !!n.couple_id,
    tags: n.tags && n.tags.length ? n.tags : undefined,
    createdAt: n.created_at, updatedAt: n.updated_at,
  };
  if (base.kind === 'memo') return { ...base, content: n.body || '' };
  const today = thaiToday().date;
  return {
    ...base,
    description: n.body || undefined,
    status: n.done ? 'completed' : n.in_progress ? 'in_progress' : 'pending',
    priority: n.priority || undefined,
    date: n.date || undefined, time: hhmm(n.time) || undefined,
    endDate: n.end_date || undefined, endTime: hhmm(n.end_time) || undefined,
    overdue: !n.done && n.date && n.date < today ? true : undefined,
    remindMinutesBefore: n.remind ?? undefined, reminderAt: n.remind_at || undefined,
    recurrence: n.recurrence || undefined,
    timezone: 'Asia/Bangkok',
    completedAt: n.done ? n.done_at || undefined : undefined,
  };
}

// To-dos (default) or memos, with simple filters; open to-dos only unless include_done.
async function notesList(db, args = {}) {
  const kind = args.kind === 'memo' ? 'memo' : 'todo';
  const rows = (await db.query(
    `select * from notes where kind = $1 ${kind === 'todo' && !args.include_done ? 'and not done' : ''}
     order by ${kind === 'memo' ? 'updated_at desc' : 'date nulls last, time nulls first, created_at'}`, [kind])).rows;
  return rows
    .filter((n) => (!args.from || (n.date && n.date >= args.from)) && (!args.to || (n.date && n.date <= args.to)))
    .map(noteView);
}

export {
  isYm, isDate, r2, pad, lastDay, addMonths, nowYm, addDays, daysBetween, weekStart, hhmm,
  ToolError, fail, catBook, context, txns, publicTx, range, totals, groupBy,
  budgetWindow, shiftWindow, budgetUse, budgetInfo, budgetRows, budgetsFor, budgetCols, PERIOD_NAME,
  walletsNow, billsData, billMonth, noteView, notesList,
};
