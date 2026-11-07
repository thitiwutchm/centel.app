import crypto from 'node:crypto';
import { thaiToday, parseNote } from './noteparse.js';
import {
  fail, isDate, r2, addDays, txns, publicTx, budgetWindow, shiftWindow, budgetUse, budgetInfo, budgetRows, budgetCols,
} from './mcpcore.js';
import { audit, snapshot, writeTxn } from './mcpwrite.js';

/* MCP tools that change money records: budgets and income / expense transactions.
   Writing needs the centel.money scope. Never moves real money: these are the person's
   own records in Centel, nothing reaches a bank.

   Confirmation (see mcpwrite.js runTool): deleting anything, changing an amount (a
   transaction's amount / type / wallet / currency, a budget's amount) and recording a
   single transaction of LARGE baht or more first return a preview and a confirm_token. */

const SCOPE = 'centel.money';
export const LARGE = 10000;
const MAX = 1e9;
const isId = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const fmt = (n) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(n);

const idemArg = { type: 'string', description: 'Optional key (8–200 chars) unique to this request, e.g. a UUID. Sending the same request again with the same key returns the first result and changes nothing.' };
const confirmArg = { type: 'string', description: 'Only after the user confirmed the preview: the confirm_token from the previous answer.' };

function amountOf(v, what = 'amount') {
  const n = typeof v === 'string' ? Number(v.replace(/[,\s฿]/g, '')) : Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(`${what} must be a number above 0`);
  if (n > MAX) fail(`${what} is too large`);
  return r2(n);
}
const textOf = (v, max) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

function walletOf(ctx, q, { allowTotal = false } = {}) {
  if (q == null || q === '') return null;
  if (allowTotal && ['total', 'all', 'ทุกกระเป๋า'].includes(String(q).toLowerCase())) return 'total';
  const s = String(q).toLowerCase();
  const w = ctx.wallets.find((x) => x.id === q) || ctx.wallets.find((x) => x.name.toLowerCase() === s)
    || ctx.wallets.find((x) => x.name.toLowerCase().includes(s));
  if (!w) fail(`Unknown wallet "${q}". Wallets: ${ctx.wallets.map((x) => x.name).join(', ') || 'none'}.`);
  return w.id;
}

async function partnerId(db) { return (await db.query('select my_partner() as p')).rows[0].p; }

/* ---------- Budgets ---------- */

// A budget's identity: two budgets with the same identity would count the same spending.
const identity = (b) => [b.scope, b.category, b.wallet_id || 'total', b.period || 'month', b.start_date || '', b.end_date || '',
  (b.name || '').toLowerCase(), (b.merchant || '').toLowerCase()].join('|');

async function budgetInput(db, ctx, a, cur = {}) {
  const has = (k) => a[k] !== undefined;
  const scope = has('scope') ? a.scope : cur.scope || 'personal';
  if (!['personal', 'shared'].includes(scope)) fail('scope must be personal or shared');
  if (scope === 'shared' && !(await partnerId(db))) fail('No partner is linked, so a shared budget cannot be made.');
  let category = cur.category || 'all';
  if (has('category')) {
    if (a.category == null || ['all', 'ทุกหมวด', 'ทั้งหมด'].includes(String(a.category).toLowerCase())) category = 'all';
    else {
      category = ctx.cats.find(a.category, 'expense');
      if (!category) fail(`Unknown expense category "${a.category}". Use list_categories, or leave category out (all spending) and give a name / merchant.`);
    }
  }
  const period = has('period') ? a.period : cur.period || 'month';
  if (!['month', 'week', 'custom'].includes(period)) fail('period must be month, week or custom');
  let startDate = has('start_date') ? a.start_date : cur.start_date || null;
  let endDate = has('end_date') ? a.end_date : cur.end_date || null;
  if (period === 'custom') {
    if (!isDate(startDate) || !isDate(endDate)) fail('A custom budget needs start_date and end_date (YYYY-MM-DD)');
    if (endDate < startDate) fail('end_date is before start_date');
  } else { startDate = null; endDate = null; }
  let walletId = cur.wallet_id || 'total';
  if (has('wallet')) walletId = a.wallet == null ? 'total' : walletOf(ctx, a.wallet, { allowTotal: true });
  if (scope === 'shared') walletId = 'total';
  const name = has('name') ? textOf(a.name, 60) : cur.name || null;
  const merchant = has('merchant') ? textOf(a.merchant, 60) : cur.merchant || null;
  return { scope, category, period, start_date: startDate, end_date: endDate, wallet_id: walletId, name, merchant };
}

// One budget from an id, a name or a category name; it must match exactly one.
async function findBudget(db, ctx, q) {
  if (q == null || q === '') fail('Say which budget: its id, name or category (see list_budgets).');
  const rows = await budgetRows(db);
  if (isId(q)) {
    const b = rows.find((x) => x.id === q);
    if (!b) fail('Budget not found');
    return b;
  }
  const s = String(q).toLowerCase();
  const label = (b) => (b.name || '').toLowerCase();
  const cat = (b) => (b.category === 'all' ? 'ทุกหมวด' : ctx.cats.name(b.category).toLowerCase());
  let hits = rows.filter((b) => label(b) === s);
  if (!hits.length) hits = rows.filter((b) => !b.name && (cat(b) === s || b.category === q));
  if (!hits.length) hits = rows.filter((b) => label(b).includes(s) || cat(b).includes(s));
  if (!hits.length) fail(`No budget matches "${q}". Use list_budgets.`);
  if (hits.length > 1) fail(`"${q}" matches ${hits.length} budgets: ${hits.map((b) => `${budgetInfo(b, ctx).name} (${b.period}, id ${b.id})`).join('; ')}. Pass the id.`);
  return hits[0];
}

async function statusOf(db, ctx, b, ref) {
  const today = thaiToday().date;
  const win = budgetWindow(b, ref || today);
  const list = await txns(db, ctx, win.from, win.to);
  return { ...budgetInfo(b, ctx), ...budgetUse(b, ctx, list, win, today) };
}

const budgetItem = {
  type: 'object',
  properties: {
    amount: { type: 'number', description: 'Budget for one period in THB.' },
    category: { type: 'string', description: 'Expense category id or name (list_categories), or "all" for all spending. Default all.' },
    name: { type: 'string', description: 'Optional label, e.g. "ซูชิโร่" or "เงินสำรอง". Needed to tell apart two budgets on the same category.' },
    merchant: { type: 'string', description: 'Optional: count only spending whose shop or note contains this, e.g. "ซูชิโร่".' },
    period: { type: 'string', enum: ['month', 'week', 'custom'], description: 'Default month. week = Monday–Sunday.' },
    start_date: { type: 'string', description: 'custom only, YYYY-MM-DD' },
    end_date: { type: 'string', description: 'custom only, YYYY-MM-DD' },
    wallet: { type: 'string', description: 'Only spending from this wallet (name or id). Default all wallets.' },
    scope: { type: 'string', enum: ['personal', 'shared'], description: 'shared = a couple budget that counts shared expenses. Default personal.' },
  },
  required: ['amount'],
  additionalProperties: false,
};

const BUDGET_TOOLS = [
  {
    name: 'list_budgets',
    title: 'List budgets',
    description: 'All budgets (monthly, weekly or a custom date range) with their settings and how much is spent / left in the current period. Includes the budget ids for update_budget / delete_budget.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (db, ctx) => {
      const rows = await budgetRows(db);
      const out = [];
      for (const b of rows) out.push(await statusOf(db, ctx, b));
      return { today: thaiToday().date, count: out.length, budgets: out };
    },
  },
  {
    name: 'get_budget_status',
    title: 'Budget status',
    description: 'How much of a budget is used and left in the period containing a date (default today), with how much can be spent per day for the rest of it. Without `budget`: every budget plus the overall picture for the month ("เดือนนี้เหลืองบเท่าไหร่").',
    inputSchema: {
      type: 'object',
      properties: { budget: { type: 'string', description: 'Budget id, name or category. Omit for all.' }, date: { type: 'string', description: 'YYYY-MM-DD, default today.' } },
      additionalProperties: false,
    },
    run: async (db, ctx, a) => {
      if (a.date != null && !isDate(a.date)) fail('date must be YYYY-MM-DD');
      const ref = a.date || thaiToday().date;
      if (a.budget) return { date: ref, budget: await statusOf(db, ctx, await findBudget(db, ctx, a.budget), ref) };
      const all = [];
      for (const b of await budgetRows(db)) all.push(await statusOf(db, ctx, b, ref));
      const monthly = all.filter((b) => b.period === 'month' && b.scope === 'personal');
      const cap = monthly.find((b) => b.category === 'all' && !b.merchant);
      const parts = monthly.filter((b) => b !== cap);
      const sum = (k) => r2(parts.reduce((s, b) => s + b[k], 0));
      const overall = cap
        ? { basis: 'overall monthly budget (ทุกหมวด)', budget: cap.budget, spent: cap.spent, remaining: cap.remaining, perDayLeft: cap.perDayLeft, categoryBudgetsTotal: sum('budget') }
        : parts.length ? { basis: 'sum of monthly category budgets', budget: sum('budget'), spent: sum('spent'), remaining: sum('remaining') } : null;
      return { date: ref, overall, over: all.filter((b) => b.state === 'over').map((b) => b.name), budgets: all };
    },
  },
  {
    name: 'get_budget_history',
    title: 'Budget history',
    description: 'Past periods of budgets: budget, spent and left for each of the last N months (or weeks for a weekly budget), newest first.',
    inputSchema: {
      type: 'object',
      properties: { budget: { type: 'string', description: 'Budget id, name or category. Omit for all.' }, periods: { type: 'integer', minimum: 1, maximum: 24, description: 'Default 6, including the current one.' } },
      additionalProperties: false,
    },
    run: async (db, ctx, a) => {
      const rows = a.budget ? [await findBudget(db, ctx, a.budget)] : await budgetRows(db);
      const n = Math.min(Math.max(Number(a.periods) || 6, 1), 24);
      const today = thaiToday().date;
      const out = [];
      for (const b of rows) {
        const wins = [];
        let w = budgetWindow(b, today);
        for (let i = 0; i < (b.period === 'custom' ? 1 : n); i++) { wins.push(w); w = shiftWindow(b, w, -1); }
        const list = await txns(db, ctx, wins[wins.length - 1].from, wins[0].to);
        const history = wins.map((win) => {
          const u = budgetUse(b, ctx, list, win, today);
          return { from: u.from, to: u.to, budget: u.budget, spent: u.spent, remaining: u.remaining, usedPercent: u.usedPercent, state: u.state };
        });
        const closed = history.filter((h) => h.to < today);
        out.push({ ...budgetInfo(b, ctx), history, averageSpent: closed.length ? r2(closed.reduce((s, h) => s + h.spent, 0) / closed.length) : undefined, periodsOver: closed.filter((h) => h.state === 'over').length });
      }
      return { today, budgets: out };
    },
  },
  {
    name: 'create_budget',
    title: 'Create budgets',
    description: 'Create one or more budgets in one call (e.g. a whole monthly plan). Each item: amount, category (or "all"), optional name / merchant filter, period month / week / custom, wallet, scope. Give expected_total so Centel checks the category budgets add up before saving anything. A budget that already exists with the same amount is skipped (not duplicated); one that exists with a different amount stops the call (use update_budget). Only tell the user budgets were created when status is "created".',
    inputSchema: {
      type: 'object',
      properties: {
        budgets: { type: 'array', items: budgetItem, minItems: 1, maxItems: 30 },
        expected_total: { type: 'number', description: 'What the budgets in this call add up to, not counting an overall "all" budget. If the sum differs, nothing is saved.' },
        idempotency_key: idemArg,
      },
      required: ['budgets'],
      additionalProperties: false,
    },
    scope: SCOPE,
    run: async (db, ctx, a, user) => {
      if (!Array.isArray(a.budgets) || !a.budgets.length) fail('budgets must be a list of at least one budget');
      if (a.budgets.length > 30) fail('At most 30 budgets per call');
      const items = [];
      for (const [i, it] of a.budgets.entries()) {
        try {
          items.push({ ...(await budgetInput(db, ctx, it)), amount: amountOf(it.amount) });
        } catch (e) { fail(`Budget ${i + 1}: ${e.message}`); }
      }
      const seen = new Set();
      for (const it of items) {
        const k = identity(it);
        if (seen.has(k)) fail(`Two budgets in this call are the same (${it.name || ctx.cats.name(it.category)}). Give them different names or merge them.`);
        seen.add(k);
      }
      const parts = items.filter((it) => !(it.category === 'all' && !it.merchant));
      const total = r2(parts.reduce((s, it) => s + it.amount, 0));
      if (a.expected_total != null && Math.abs(total - amountOf(a.expected_total, 'expected_total')) > 0.009) {
        fail(`The budgets add up to ${fmt(total)}, not ${fmt(a.expected_total)}. Nothing was saved; fix the amounts and try again.`);
      }
      const existing = await budgetRows(db);
      const byKey = new Map(existing.map((b) => [identity(b), b]));
      const conflicts = items.filter((it) => byKey.has(identity(it)) && Number(byKey.get(identity(it)).amount) !== it.amount);
      if (conflicts.length) {
        fail(`These budgets already exist with another amount: ${conflicts.map((it) => { const b = byKey.get(identity(it)); return `${budgetInfo(b, ctx).name} ${fmt(b.amount)} (id ${b.id})`; }).join('; ')}. Nothing was saved. Use update_budget to change them.`);
      }
      const created = [], skipped = [];
      for (const it of items) {
        const old = byKey.get(identity(it));
        if (old) { skipped.push({ ...budgetInfo(old, ctx), reason: 'already exists with the same amount' }); continue; }
        const id = crypto.randomUUID();
        const row = (await db.query(
          `insert into budgets (id, owner_id, scope, couple_id, category, amount, wallet_id, name, period, start_date, end_date, merchant, created_at)
           values ($1, app_uid(), $2, case when $2 = 'shared' then my_couple() end, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp()) returning ${budgetCols}`,
          [id, it.scope, it.category, it.amount, it.wallet_id, it.name, it.period, it.start_date, it.end_date, it.merchant])).rows[0];
        const info = budgetInfo(row, ctx);
        const changeId = await audit(db, user, 'create_budget', 'budget', id, 'create', null, await snapshot(db, 'budget', id), `สร้างงบ ${info.name} ${fmt(it.amount)} (${info.periodName})`);
        created.push({ ...info, changeId });
      }
      // A plan over its overall cap is allowed, but said.
      const warnings = [];
      for (const per of ['month', 'week']) {
        const all = [...existing, ...items].filter((b) => b.period === per && b.category === 'all' && !b.merchant && b.scope === 'personal');
        const capAmount = all.length ? Math.max(...all.map((b) => Number(b.amount))) : null;
        const sumPer = [...existing.filter((b) => !items.some((it) => identity(it) === identity(b))), ...items]
          .filter((b) => b.period === per && b.scope === 'personal' && !(b.category === 'all' && !b.merchant)).reduce((s, b) => s + Number(b.amount), 0);
        if (capAmount != null && sumPer > capAmount + 0.009) warnings.push(`${per === 'month' ? 'Monthly' : 'Weekly'} category budgets add up to ${fmt(sumPer)}, more than the overall ${fmt(capAmount)}.`);
      }
      return {
        status: created.length ? 'created' : 'already_exists',
        created, skipped, total, ...(warnings.length ? { warnings } : {}),
        message: created.length ? `Created ${created.length} budget(s)${skipped.length ? `, ${skipped.length} already existed` : ''}.` : 'All of these budgets already exist; nothing new was created.',
      };
    },
  },
  {
    name: 'update_budget',
    title: 'Change a budget',
    description: 'Change one budget: set a new amount, or raise / lower it with change_by (e.g. -3000 for "ลดงบช้อปปิ้งลง 3,000"), or change its name, category, period, wallet or merchant filter. Changing the amount needs the user\'s confirmation: the first call returns a preview and confirm_token; call again with confirm_token after they say yes.',
    inputSchema: {
      type: 'object',
      properties: {
        budget: { type: 'string', description: 'Budget id, name or category (list_budgets).' },
        amount: { type: 'number', description: 'New amount per period.' },
        change_by: { type: 'number', description: 'Add (positive) or take off (negative) this much instead of giving amount.' },
        ...Object.fromEntries(Object.entries(budgetItem.properties).filter(([k]) => k !== 'amount' && k !== 'scope')),
        confirm_token: confirmArg,
        idempotency_key: idemArg,
      },
      required: ['budget'],
      additionalProperties: false,
    },
    scope: SCOPE,
    confirm: async (db, ctx, a) => {
      const { cur, next } = await budgetChange(db, ctx, a);
      if (Number(cur.amount) === next.amount) return null;
      return { action: 'change budget amount', budget: budgetInfo(cur, ctx).name, from: r2(cur.amount), to: next.amount, difference: r2(next.amount - cur.amount), period: next.period };
    },
    run: async (db, ctx, a, user) => {
      const { cur, next } = await budgetChange(db, ctx, a);
      const before = await snapshot(db, 'budget', cur.id);
      const row = (await db.query(
        `update budgets set scope = $2, couple_id = case when $2 = 'shared' then my_couple() end, category = $3, amount = $4, wallet_id = $5,
           name = $6, period = $7, start_date = $8, end_date = $9, merchant = $10 where id = $1 returning ${budgetCols}`,
        [cur.id, next.scope, next.category, next.amount, next.wallet_id, next.name, next.period, next.start_date, next.end_date, next.merchant])).rows[0];
      if (!row) fail('This budget cannot be changed');
      const info = budgetInfo(row, ctx);
      const changeId = await audit(db, user, 'update_budget', 'budget', cur.id, 'update', before, await snapshot(db, 'budget', cur.id),
        Number(cur.amount) !== next.amount ? `งบ ${info.name} ${fmt(cur.amount)} → ${fmt(next.amount)}` : `แก้งบ ${info.name}`);
      return { status: 'updated', id: cur.id, changeId, previousAmount: r2(cur.amount), budget: await statusOf(db, ctx, row) };
    },
  },
  {
    name: 'delete_budget',
    title: 'Delete a budget',
    description: 'Delete one budget (transactions are not touched). Needs the user\'s confirmation: the first call returns a preview and confirm_token; call again with confirm_token after they say yes.',
    inputSchema: { type: 'object', properties: { budget: { type: 'string', description: 'Budget id, name or category.' }, confirm_token: confirmArg }, required: ['budget'], additionalProperties: false },
    scope: SCOPE,
    destructive: true,
    confirm: async (db, ctx, a) => ({ action: 'delete budget', budget: await statusOf(db, ctx, await findBudget(db, ctx, a.budget)) }),
    run: async (db, ctx, a, user) => {
      const b = await findBudget(db, ctx, a.budget);
      const before = await snapshot(db, 'budget', b.id);
      const r = await db.query('delete from budgets where id = $1', [b.id]);
      if (!r.rowCount) fail('This budget cannot be deleted');
      const info = budgetInfo(b, ctx);
      const changeId = await audit(db, user, 'delete_budget', 'budget', b.id, 'delete', before, null, `ลบงบ ${info.name} ${fmt(b.amount)}`);
      return { status: 'deleted', id: b.id, changeId, budget: info, undo: 'undo_change can bring it back.' };
    },
  },
];

async function budgetChange(db, ctx, a) {
  const cur = await findBudget(db, ctx, a.budget);
  if (a.amount != null && a.change_by != null) fail('Give amount or change_by, not both');
  let amount = Number(cur.amount);
  if (a.amount != null) amount = amountOf(a.amount);
  if (a.change_by != null) {
    const d = Number(a.change_by);
    if (!Number.isFinite(d) || d === 0) fail('change_by must be a number other than 0');
    amount = r2(amount + d);
    if (amount <= 0) fail(`That would leave the budget at ${fmt(amount)}; a budget must stay above 0 (delete it instead).`);
  }
  const next = { ...(await budgetInput(db, ctx, a, cur)), amount };
  const clash = (await budgetRows(db)).find((b) => b.id !== cur.id && identity(b) === identity(next));
  if (clash) fail(`Another budget already covers this (${budgetInfo(clash, ctx).name}, id ${clash.id}). Give a different name or change that one.`);
  return { cur, next };
}

/* ---------- Transactions ---------- */

// A spending day from words, looking back (parseNote looks forward, for appointments):
// วันนี้ / เมื่อวาน / เมื่อวานซืน / 3 วันก่อน / วันจันทร์ (the last one) / "3 พ.ย." (this year's, or last year's if still ahead).
const DOW = ['อาทิตย์|sun', 'จันทร์|mon', 'อังคาร|tue', 'พุธ|wed', 'พฤหัส|thu', 'ศุกร์|fri', 'เสาร์|sat'];
export function pastDate(words, today = thaiToday().date) {
  const w = String(words).trim().toLowerCase();
  if (/^(วันนี้|today|เมื่อเช้า|เมื่อกี้|ตอนนี้|this morning|tonight|คืนนี้)/.test(w)) return today;
  if (/^(เมื่อวานซืน|day before yesterday)/.test(w)) return addDays(today, -2);
  if (/^(เมื่อวาน|เมื่อคืน|yesterday|last night)/.test(w)) return addDays(today, -1);
  const ago = /^(\d{1,3})\s*(วัน|days?)\s*(ก่อน|ที่แล้ว|ago)/.exec(w);
  if (ago) return addDays(today, -Number(ago[1]));
  const i = DOW.findIndex((d) => new RegExp(`(^|วัน)(${d})`).test(w));
  if (i >= 0 && !/หน้า|next/.test(w)) {
    const back = (new Date(Date.parse(today)).getUTCDay() - i + 7) % 7;
    return addDays(today, -(back || (/ที่แล้ว|last/.test(w) ? 7 : 0)));
  }
  const p = parseNote(String(words));
  if (!p.date) return null;
  if (p.date > today && /^\d{1,2}\s*\D/.test(w)) return `${Number(p.date.slice(0, 4)) - 1}${p.date.slice(4)}`;
  return p.date;
}

function dateOf(a, fallback) {
  if (a.when != null) {
    const d = pastDate(a.when);
    if (!d) fail(`Could not read a date from "${a.when}". Pass date as YYYY-MM-DD.`);
    return d;
  }
  if (a.date != null) { if (!isDate(a.date)) fail('date must be YYYY-MM-DD'); return a.date; }
  return fallback;
}

function labelsOf(ctx, v) {
  if (v == null) return null;
  if (!Array.isArray(v)) fail('labels must be a list');
  return v.map((q) => {
    const l = ctx.labels.find((x) => x.id === q || x.name.toLowerCase() === String(q).toLowerCase());
    if (!l) fail(`Unknown label "${q}". Labels: ${ctx.labels.map((x) => x.name).join(', ') || 'none'}.`);
    return l.id;
  });
}

function categoryOf(ctx, q, type) {
  if (q == null || q === '') return null;
  const id = ctx.cats.find(q, type);
  if (!id) fail(`Unknown ${type} category "${q}". Use list_categories (or leave it out to file it under รอตรวจสอบ).`);
  return id;
}

// Rows that look like the same record: same type, amount and day, and the same shop or category.
async function duplicates(db, ctx, x, selfId = null) {
  const list = await txns(db, ctx, addDays(x.date, -1), addDays(x.date, 1));
  const shop = (x.merchant || '').toLowerCase();
  return list.filter((t) => t.id !== selfId && t.type === x.type && t.date === x.date
    && r2(t.total ?? t.amount) === x.amount
    && ((shop && (t.merchant || '').toLowerCase() === shop) || (!shop && !t.merchant) || (x.category && t.category === x.category)))
    .map(publicTx);
}

// A new transaction's snapshot from tool arguments.
async function newTxn(db, ctx, a) {
  const type = a.type || 'expense';
  if (!['expense', 'income'].includes(type)) fail('type must be expense or income (wallet transfers come later)');
  const amount = amountOf(a.amount);
  const date = dateOf(a, thaiToday().date);
  const scope = a.scope || 'personal';
  if (!['personal', 'shared'].includes(scope)) fail('scope must be personal or shared');
  if (scope === 'shared' && type !== 'expense') fail('Only expenses can be shared');
  const currency = a.currency == null ? 'THB' : String(a.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('currency must be a 3-letter code like THB or USD');
  const me = ctx.me.id;
  let walletId = a.wallet != null ? walletOf(ctx, a.wallet) : null;
  if (!walletId) walletId = ctx.wallets.some((w) => w.id === ctx.prefs.lastWallet) ? ctx.prefs.lastWallet : ctx.wallets[0]?.id || null;
  const row = {
    scope, type, date, amount, currency, fx: null,
    merchant: textOf(a.merchant, 120), note: textOf(a.note, 500), category: categoryOf(ctx, a.category, type),
    wallet_id: walletId, to_wallet_id: null, payer_id: null, bill_id: null, bill_ym: null, review_needed: false, receipt_key: null, slip_ref: null,
    labels: labelsOf(ctx, a.labels) || [], shares: [],
  };
  if (scope === 'shared') {
    const partner = await partnerId(db);
    if (!partner) fail('No partner is linked, so the expense cannot be shared.');
    const payer = a.paid_by === 'partner' ? partner : me;
    const split = a.split || 'half';
    if (!['half', 'payer_pays_all'].includes(split)) fail('split must be half or payer_pays_all');
    const mine = split === 'half' ? r2(amount / 2) : payer === me ? amount : 0;
    row.payer_id = payer;
    if (payer !== me) row.wallet_id = null;
    row.shares = [{ user: me, amount: mine }, { user: partner, amount: r2(amount - mine) }];
  }
  return row;
}

// The current row of one of my transactions, with the changes applied.
async function changedTxn(db, ctx, a) {
  if (!isId(a.id)) fail('id must be a transaction id (from list_transactions)');
  const cur = await snapshot(db, 'transaction', a.id);
  if (!cur) fail('Transaction not found');
  if (cur.owner_id !== ctx.me.id) fail('Only the person who added this transaction can change it (it was added by your partner).');
  const next = { ...cur, shares: cur.shares.map((s) => ({ ...s })), labels: [...cur.labels] };
  if (a.type !== undefined) {
    if (cur.type === 'transfer' || !['expense', 'income'].includes(a.type)) fail('type can only switch between expense and income');
    if (cur.scope === 'shared' && a.type !== 'expense') fail('A shared expense cannot become income');
    next.type = a.type;
    if (a.category === undefined && next.category && ctx.cats.typeOf(next.category) !== a.type) next.category = null;
  }
  if (a.amount !== undefined) next.amount = amountOf(a.amount);
  if (a.date !== undefined || a.when !== undefined) next.date = dateOf(a, cur.date);
  if (a.category !== undefined) next.category = next.type === 'transfer' ? null : categoryOf(ctx, a.category, next.type);
  if (a.merchant !== undefined) next.merchant = textOf(a.merchant, 120);
  if (a.note !== undefined) next.note = textOf(a.note, 500);
  if (a.wallet !== undefined) {
    if (cur.scope === 'shared' && cur.payer_id !== ctx.me.id) fail('Your partner paid this one, so it has no wallet of yours.');
    next.wallet_id = walletOf(ctx, a.wallet);
  }
  if (a.currency !== undefined) {
    const c = String(a.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) fail('currency must be a 3-letter code');
    next.currency = c;
  }
  if (a.labels !== undefined) next.labels = labelsOf(ctx, a.labels) || [];
  // A converted entry's original amount no longer matches once its baht amount or currency changes.
  if (next.amount !== cur.amount || next.currency !== cur.currency) next.fx = null;
  if (next.scope === 'shared' && next.amount !== cur.amount) {
    // Keep the split: the same share of the new amount.
    const mine = cur.shares.find((s) => s.user === ctx.me.id);
    const ratio = mine && cur.amount ? mine.amount / cur.amount : 0.5;
    const m = r2(next.amount * ratio);
    next.shares = cur.shares.map((s) => ({ user: s.user, amount: s.user === ctx.me.id ? m : r2(next.amount - m) }));
  }
  return { cur, next };
}

const moneyChanged = (c, n) => c.amount !== n.amount || c.type !== n.type || c.wallet_id !== n.wallet_id || c.currency !== n.currency;

function txView(s, ctx) {
  const mine = s.scope === 'shared' ? s.shares.find((x) => x.user === ctx.me.id)?.amount : undefined;
  return {
    type: s.type, date: s.date, amount: s.amount, currency: s.currency || 'THB',
    category: s.category || undefined, categoryName: s.type === 'transfer' ? 'โอนเงิน' : ctx.cats.name(s.category),
    merchant: s.merchant || undefined, note: s.note || undefined, wallet: ctx.walletName(s.wallet_id) || undefined,
    scope: s.scope, myShare: mine, labels: s.labels && s.labels.length ? s.labels.map(ctx.labelName) : undefined,
    bill: s.bill_id ? { id: s.bill_id, month: s.bill_ym } : undefined,
  };
}

const txSummary = (s, ctx) => `${s.type === 'income' ? 'รายรับ' : 'รายจ่าย'} ${s.merchant || s.note || ctx.cats.name(s.category)} ${fmt(s.amount)} ${s.currency === 'THB' ? 'บาท' : s.currency} (${s.date})`;

const txArgs = {
  amount: { type: 'number', description: 'Amount (positive), in THB unless currency is given.' },
  date: { type: 'string', description: 'YYYY-MM-DD (Bangkok). Default today.' },
  when: { type: 'string', description: 'Instead of date: "เมื่อวาน", "วันจันทร์", "3 พ.ย."' },
  category: { type: 'string', description: 'Category id or name (list_categories).' },
  merchant: { type: 'string', description: 'Shop / payee, e.g. "ปตท." or "Starbucks".' },
  note: { type: 'string' },
  wallet: { type: 'string', description: 'Wallet name or id (get_wallets). Default the wallet used last in the app.' },
  currency: { type: 'string', description: 'ISO code, default THB. No conversion is done.' },
  labels: { type: 'array', items: { type: 'string' }, description: 'Label names.' },
};

const TXN_TOOLS = [
  {
    name: 'create_transaction',
    title: 'Record income or expense',
    description: `Record one income or expense (บันทึกรายรับรายจ่าย), e.g. "กินข้าว 350" or "เมื่อวานเติมน้ำมัน 1,500". This is only a record in Centel; no money moves. If a matching record (same type, amount, day and shop or category) already exists, nothing is saved and it is returned as a possible duplicate: ask the user, and only with allow_duplicate: true save another. Amounts of ${fmt(LARGE)} or more need the user's confirmation (preview + confirm_token). Only tell the user it was saved when status is "created".`,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['expense', 'income'], description: 'Default expense.' },
        ...txArgs,
        scope: { type: 'string', enum: ['personal', 'shared'], description: 'shared = a couple expense both partners see. Default personal.' },
        paid_by: { type: 'string', enum: ['me', 'partner'], description: 'Shared only: who paid. Default me.' },
        split: { type: 'string', enum: ['half', 'payer_pays_all'], description: 'Shared only: หาร 2 (default) or the payer covers all (รับผิดชอบทั้งหมด).' },
        allow_duplicate: { type: 'boolean' },
        confirm_token: confirmArg,
        idempotency_key: idemArg,
      },
      required: ['amount'],
      additionalProperties: false,
    },
    scope: SCOPE,
    confirm: async (db, ctx, a) => {
      const x = await newTxn(db, ctx, a);
      if (!a.allow_duplicate && (await duplicates(db, ctx, x)).length) return null; // run() reports the duplicate
      if (x.amount < LARGE) return null;
      return { action: 'record', transaction: txView(x, ctx), reason: `amount is ${fmt(LARGE)} or more` };
    },
    run: async (db, ctx, a, user) => {
      const x = await newTxn(db, ctx, a);
      if (!a.allow_duplicate) {
        const dups = await duplicates(db, ctx, x);
        if (dups.length) {
          return { status: 'possible_duplicate', created: false, duplicates: dups, message: 'Nothing was saved: this looks like a record that already exists. Ask the user; if they really spent it twice, call again with allow_duplicate: true.' };
        }
      }
      const id = crypto.randomUUID();
      await writeTxn(db, id, x);
      const after = await snapshot(db, 'transaction', id);
      const changeId = await audit(db, user, 'create_transaction', 'transaction', id, 'create', null, after, `บันทึก${txSummary(after, ctx)}`);
      return { status: 'created', id, changeId, transaction: txView(after, ctx) };
    },
  },
  {
    name: 'update_transaction',
    title: 'Change a transaction',
    description: 'Change one of the user\'s transactions (amount, date, category, shop, note, wallet, type, labels). Get the id from list_transactions, e.g. find "กาแฟ" this morning before changing 150 → 120. Changing the amount, type, wallet or currency needs the user\'s confirmation (preview + confirm_token). A partner\'s shared expense cannot be changed.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, type: { type: 'string', enum: ['expense', 'income'] }, ...txArgs, confirm_token: confirmArg, idempotency_key: idemArg },
      required: ['id'],
      additionalProperties: false,
    },
    scope: SCOPE,
    confirm: async (db, ctx, a) => {
      const { cur, next } = await changedTxn(db, ctx, a);
      if (!moneyChanged(cur, next)) return null;
      return { action: 'change transaction', before: txView(cur, ctx), after: txView(next, ctx) };
    },
    run: async (db, ctx, a, user) => {
      const { cur, next } = await changedTxn(db, ctx, a);
      await writeTxn(db, a.id, next);
      const after = await snapshot(db, 'transaction', a.id);
      const changeId = await audit(db, user, 'update_transaction', 'transaction', a.id, 'update', cur, after,
        cur.amount !== after.amount ? `แก้${txSummary(after, ctx)} จาก ${fmt(cur.amount)}` : `แก้${txSummary(after, ctx)}`);
      return { status: 'updated', id: a.id, changeId, before: txView(cur, ctx), transaction: txView(after, ctx) };
    },
  },
  {
    name: 'categorize_transaction',
    title: 'Change category',
    description: 'Put one or more of the user\'s transactions into a category (e.g. the รอตรวจสอบ ones). Ids from list_transactions.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 }, category: { type: 'string' }, idempotency_key: idemArg },
      required: ['ids', 'category'],
      additionalProperties: false,
    },
    scope: SCOPE,
    run: async (db, ctx, a, user) => {
      if (!Array.isArray(a.ids) || !a.ids.length || a.ids.length > 50) fail('ids must list 1–50 transaction ids');
      const done = [];
      for (const id of [...new Set(a.ids)]) {
        let r;
        try { r = await changedTxn(db, ctx, { id, category: a.category }); } catch (e) { fail(`${id}: ${e.message} Nothing was changed.`); }
        if (r.cur.type === 'transfer') fail(`${id} is a transfer and has no category. Nothing was changed.`);
        if (r.cur.category === r.next.category) { done.push({ id, status: 'unchanged' }); continue; }
        await db.query('update expenses set category = $2, review_needed = false, updated_at = now() where id = $1 and owner_id = app_uid()', [id, r.next.category]);
        const after = await snapshot(db, 'transaction', id);
        const changeId = await audit(db, user, 'categorize_transaction', 'transaction', id, 'update', r.cur, after,
          `ย้ายหมวด ${txSummary(after, ctx)}: ${ctx.cats.name(r.cur.category)} → ${ctx.cats.name(after.category)}`);
        done.push({ id, status: 'updated', changeId, from: ctx.cats.name(r.cur.category), to: ctx.cats.name(after.category) });
      }
      return { status: done.some((d) => d.status === 'updated') ? 'updated' : 'unchanged', category: ctx.cats.name(ctx.cats.find(a.category)), results: done };
    },
  },
  {
    name: 'delete_transaction',
    title: 'Delete a transaction',
    description: 'Delete one of the user\'s transactions. Needs the user\'s confirmation: the first call returns a preview and confirm_token; call again with confirm_token after they say yes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, confirm_token: confirmArg }, required: ['id'], additionalProperties: false },
    scope: SCOPE,
    destructive: true,
    confirm: async (db, ctx, a) => {
      const { cur } = await changedTxn(db, ctx, { id: a.id });
      return { action: 'delete transaction', transaction: txView(cur, ctx), ...(cur.bill_id ? { warning: 'This is the payment of a bill; the bill stays marked paid in the app until it is unmarked there.' } : {}) };
    },
    run: async (db, ctx, a, user) => {
      const { cur } = await changedTxn(db, ctx, { id: a.id });
      const r = await db.query('delete from expenses where id = $1 and owner_id = app_uid()', [a.id]);
      if (!r.rowCount) fail('This transaction cannot be deleted');
      const changeId = await audit(db, user, 'delete_transaction', 'transaction', a.id, 'delete', cur, null, `ลบ${txSummary(cur, ctx)}`);
      return { status: 'deleted', id: a.id, changeId, transaction: txView(cur, ctx), undo: 'undo_change can bring it back.' };
    },
  },
];

export const MONEY_TOOLS = [...BUDGET_TOOLS, ...TXN_TOOLS];
