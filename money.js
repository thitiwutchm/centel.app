'use strict';

/* Wallets, transactions and budgets (Money Lover–style tracking).
   Loaded before app.js; everything here runs only when app.js calls it,
   so helpers from app.js (pad, baht, esc, openSheet, …) are available. */

// Kept apart from billplanner.v1 so ThemeA/ThemeB, which rewrite that key, never drop this data.
const MONEY_KEY = 'centel.money.v1';

const WALLET_TYPES = {
  cash:    { label: 'เงินสด',      icon: '💵', color: '#1a9e5c' },
  bank:    { label: 'บัญชีธนาคาร', icon: '🏦', color: '#2f6bff' },
  credit:  { label: 'บัตรเครดิต',  icon: '💳', color: '#7c5cff' },
  ewallet: { label: 'e-Wallet',    icon: '📱', color: '#00b3a4' },
  saving:  { label: 'เงินออม',     icon: '🐷', color: '#e83e8c' },
  invest:  { label: 'การลงทุน',    icon: '📈', color: '#d98a00' },
};

const TX_CATS = {
  // Order here is the order of the category pickers.
  apparel:       { type: 'expense', label: 'Apparel & Accessories',   icon: '👕', color: '#6b7a99' },
  food:          { type: 'expense', label: 'Food & Groceries',        icon: '🍴', color: '#a8844f' },
  coffee:        { type: 'expense', label: 'Coffee & Beverage',       icon: '☕', color: '#d98a2b' },
  hangout:       { type: 'expense', label: 'Hang Out',                icon: '🍸', color: '#d9534f' },
  utility:       { type: 'expense', label: 'Utility Bills',           icon: '🏠', color: '#f0a92e' },
  subscription:  { type: 'expense', label: 'Monthly Subscriptions',   icon: '💳', color: '#4fb3ad' },
  transport:     { type: 'expense', label: 'Transportation',          icon: '🚗', color: '#7a7f88' },
  home:          { type: 'expense', label: 'Home & Living',           icon: '🛏️', color: '#7d7aa8' },
  health:        { type: 'expense', label: 'Health & Medical',        icon: '🩺', color: '#3d8fe0' },
  beauty:        { type: 'expense', label: 'Beauty & Personal Care',  icon: '✂️', color: '#d0507f' },
  travel:        { type: 'expense', label: 'Travel & Trips',          icon: '✈️', color: '#3fae8c' },
  fitness:       { type: 'expense', label: 'Fitness & Sports',        icon: '🏋️', color: '#5b6a8f' },
  pets:          { type: 'expense', label: 'Pets',                    icon: '🐶', color: '#e8a22e' },
  gift:          { type: 'expense', label: 'Gifts & Donations',       icon: '🧡', color: '#d97a3a' },
  gadget:        { type: 'expense', label: 'Gadgets & Electronics',   icon: '📱', color: '#5d6b85' },
  rent:          { type: 'expense', label: 'Rent & Insurance',        icon: '🏛️', color: '#c97a2b' },
  baby:          { type: 'expense', label: 'Babe👼',                  icon: '🧸', color: '#b8a12a' },
  other_exp:     { type: 'expense', label: 'Others',                  icon: '🧾', color: '#8a8f99' },
  salary:        { type: 'income', label: 'เงินเดือน',          icon: '💰', color: '#2f6bff' },
  bonus:         { type: 'income', label: 'โบนัส',              icon: '🎉', color: '#f5a623' },
  sale:          { type: 'income', label: 'ขายของ',             icon: '📦', color: '#b26a3c' },
  interest:      { type: 'income', label: 'ดอกเบี้ยและปันผล',    icon: '📈', color: '#1a9e5c' },
  debt_collect:  { type: 'income', label: 'รับคืนเงินยืม',       icon: '🤝', color: '#00b3a4' },
  other_inc:     { type: 'income', label: 'รายรับอื่นๆ',         icon: '💵', color: '#4f6bed' },
};
const TRANSFER_CAT = { label: 'โอนเงิน', icon: '🔁', color: '#8a8f99' };
const SETTLE_CAT = { label: 'คืนเงินระหว่างคู่', icon: '🤝', color: '#00b3a4' };
const NO_CAT = { label: 'ไม่มีหมวดหมู่', icon: '❔', color: '#8a8f99' };
const ALL_CAT = { label: 'ทุกหมวดหมู่', icon: '🌐', color: '#2f6bff' };
const TOTAL_WALLET = { name: 'ทั้งหมด', icon: '🌐', color: '#2f6bff' };

// Paying a bill is recorded as an expense in the matching category.
const BILL_TX_CAT = {
  credit: 'other_exp', electric: 'utility', water: 'utility', internet: 'utility', phone: 'utility',
  loan: 'rent', insurance: 'rent', rent: 'rent', subscription: 'subscription', other: 'other_exp',
};

// Expense categories from before the current list, and where their records now live.
// server/migrations/004_categories.sql moves synced data the same way.
const OLD_CATS = {
  personal: 'beauty', shopping: 'apparel', creditpay: 'other_exp', loan: 'rent', insurance: 'rent',
  entertainment: 'hangout', family: 'baby', education: 'other_exp',
};
const newCat = (k) => OLD_CATS[k] || k;

const TH_DOW_FULL = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

/* ---------- Store ---------- */

const defaultMoney = () => ({
  wallets: [{ id: 'cash', name: 'เงินสด', type: 'cash', initial: 0 }],
  txns: [],
  // budgets: { id, category ('all' or TX_CATS key), amount, walletId ('total' or wallet id) } — repeats every month
  budgets: [],
  // labels: { id, name } — tags a transaction can carry several of (t.labels = [label ids])
  labels: [],
  prefs: { hideBalance: false },
});

let money = loadMoney();

function loadMoney() {
  try {
    const s = JSON.parse(localStorage.getItem(MONEY_KEY) || 'null');
    if (!s) return defaultMoney();
    const d = defaultMoney();
    return {
      wallets: Array.isArray(s.wallets) && s.wallets.length ? s.wallets : d.wallets,
      txns: Array.isArray(s.txns) ? s.txns.map((t) => (t.category ? { ...t, category: newCat(t.category) } : t)) : [],
      budgets: Array.isArray(s.budgets) ? s.budgets.map((bg) => ({ ...bg, category: newCat(bg.category) })) : [],
      labels: Array.isArray(s.labels) ? s.labels : [],
      prefs: { ...d.prefs, ...(s.prefs || {}) },
    };
  } catch (e) {
    return defaultMoney();
  }
}

function saveMoney() {
  // Signed in, `money` is rebuilt from the server (see cloud.js) and the local profile stays untouched.
  if (isCloud()) return;
  try {
    localStorage.setItem(MONEY_KEY, JSON.stringify(money));
  } catch (e) {
    toast('บันทึกข้อมูลไม่สำเร็จ');
  }
}

/* ---------- Domain ---------- */

function walletById(id) { return money.wallets.find((w) => w.id === id); }
function wType(w) { return WALLET_TYPES[w.type] || WALLET_TYPES.cash; }
// A wallet's own picture (w.icon) is an emoji or a small data:image URL; without one it shows its type's icon.
const WALLET_IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
function wImg(w) { return w && WALLET_IMG.test(w.icon || '') ? w.icon : ''; }
function wEmoji(w) { return w.icon && !w.icon.startsWith('data:') ? w.icon : wType(w).icon; }
function wFace(w) { const img = wImg(w); return img ? `<img src="${img}" alt="">` : esc(wEmoji(w)); }
function txCat(t) {
  if (t.type === 'transfer') return TRANSFER_CAT;
  if (t.type === 'settle') return SETTLE_CAT;
  if (!t.category) return NO_CAT;
  return catById(t.category) || catFallback(t.type);
}
function labelById(id) { return money.labels.find((l) => l.id === id); }
// The labels on a transaction that still exist (a deleted label just disappears).
function txLabels(t) { return (t.labels || []).map(labelById).filter(Boolean); }
function budgetCat(bg) { return bg.category === 'all' ? ALL_CAT : (catById(bg.category) || catFallback('expense')); }

/* ---------- Categories ----------
   The person's own list lives in money.prefs.cats (synced with prefs): [{ id, type, label, icon, color, parent? }]
   in display order. Until they change anything it is null and TX_CATS is used. A category can have
   sub-categories (parent = a top-level id of the same type); reports and budgets roll subs up into the parent.
   Deleting one leaves its transactions alone and records where they now belong in money.prefs.catMoved. */

const DEFAULT_CATS = Object.entries(TX_CATS).map(([id, c]) => ({ id, type: c.type, label: c.label, icon: c.icon, color: c.color }));
// Kept even if the person's list loses them, so a transaction always has somewhere to show up.
const CAT_FALLBACK = { expense: 'other_exp', income: 'other_inc' };
const CAT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const CAT_COLOR = /^#[0-9a-fA-F]{6}$/;
let catCache = { src: {}, list: [], map: new Map() };

// prefs.cats comes from storage or the server, so it is checked before it reaches the page.
function cleanCats(src) {
  const out = [], seen = new Set();
  for (const c of src) {
    if (!c || !CAT_ID.test(c.id) || seen.has(c.id) || !['expense', 'income'].includes(c.type)) continue;
    const label = String(c.label || '').trim().slice(0, 40);
    if (!label) continue;
    const icon = typeof c.icon === 'string' && c.icon.length <= 16 && !/[<>&"']/.test(c.icon) && c.icon.trim() ? c.icon : '🏷️';
    // 🐾 draws almost black on iPhone, so the built-in Pets icon moved to 🐶.
    seen.add(c.id);
    out.push({ id: c.id, type: c.type, label, icon: c.id === 'pets' && icon === '🐾' ? '🐶' : icon, color: CAT_COLOR.test(c.color) ? c.color : '#8a8f99', parent: typeof c.parent === 'string' ? c.parent : undefined });
  }
  // A parent must be a top-level category of the same type.
  const top = new Map(out.filter((c) => !c.parent).map((c) => [c.id, c]));
  out.forEach((c) => { if (c.parent && (!top.has(c.parent) || top.get(c.parent).type !== c.type)) delete c.parent; if (!c.parent) delete c.parent; });
  Object.values(CAT_FALLBACK).forEach((id) => { if (!seen.has(id)) out.push({ ...DEFAULT_CATS.find((c) => c.id === id) }); });
  return out;
}
function catList() {
  const src = money.prefs.cats;
  if (catCache.src !== src) {
    const list = Array.isArray(src) && src.length ? cleanCats(src) : DEFAULT_CATS;
    catCache = { src, list, map: new Map(list.map((c) => [c.id, c])) };
  }
  return catCache.list;
}
function catMap() { catList(); return catCache.map; }
// Follows deletions (catMoved) to the category a transaction now counts under.
function catResolve(id) {
  const moved = money.prefs.catMoved || {};
  for (let i = 0; i < 10 && id && moved[id] && !catMap().has(id); i++) id = moved[id];
  return id;
}
function catById(id) {
  if (!id) return null;
  return catMap().get(catResolve(id)) || null;
}
function catFallback(type) {
  const id = CAT_FALLBACK[type === 'income' ? 'income' : 'expense'];
  return catMap().get(id) || DEFAULT_CATS.find((c) => c.id === id);
}
// The top-level category a key rolls up into (itself when it has no parent).
function catRootId(id, type = 'expense') {
  const c = catById(id) || catFallback(type);
  return c.parent && catMap().has(c.parent) ? c.parent : c.id;
}
// Camera-with-sparkle icon for the AI Slips scan button; stroked with the rainbow gradient's first stop.
const SCAN_ICON = `<svg class="scan-ico" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M13.5 5H9.6L8.2 7H5.5A2.5 2.5 0 0 0 3 9.5v8A2.5 2.5 0 0 0 5.5 20h11a2.5 2.5 0 0 0 2.5-2.5V13"/>
  <circle cx="11" cy="13.5" r="3.2"/>
  <path d="M18.5 2.5c.3 1.9 1 2.6 2.9 2.9-1.9.3-2.6 1-2.9 2.9-.3-1.9-1-2.6-2.9-2.9 1.9-.3 2.6-1 2.9-2.9z"/>
</svg>`;

// Expense categories for AI Slips to choose from (the server falls back to the built-in list).
function slipCats() {
  return catList().filter((c) => c.type === 'expense').map((c) => ({ id: c.id, name: c.label, parent: c.parent ? catById(c.parent).label : undefined }));
}
function catChildren(id) { return catList().filter((c) => c.parent === id); }
// Top-level categories of one type, in order, as [id, cat] pairs.
function catsOf(type) { return catList().filter((c) => c.type === type && !c.parent).map((c) => [c.id, c]); }
// Whether a transaction's category counts toward `id` (the category itself or one of its subs).
function catIn(txCatId, id) {
  const c = catById(txCatId);
  const own = c ? c.id : CAT_FALLBACK.expense;
  return own === id || (!!c && c.parent === id);
}

function firstWalletId() { return (money.wallets.find((w) => !w.excluded) || money.wallets[0]).id; }
function defaultWalletId() {
  if (ui.wallet !== 'total' && walletById(ui.wallet)) return ui.wallet;
  return walletById(money.prefs.lastWallet) ? money.prefs.lastWallet : firstWalletId();
}

// Wallet ids that a selection covers: one wallet, or every wallet counted in the total.
function walletSet(sel) {
  if (sel && sel !== 'total') return new Set([sel]);
  const S = new Set(money.wallets.filter((w) => !w.excluded).map((w) => w.id));
  S.total = true;
  return S;
}

/* Shared expenses (cloud.js) carry: scope 'shared', amount = my share (what counts as my
   spending), total = the whole bill, walletAmount = what left my wallet (the total when I
   paid, else 0), counted = approved. Settlements are type 'settle' with sign ±1. */
function counts(t) { return t.type !== 'settle' && (t.scope !== 'shared' || t.counted); }

// Whether a row's spending belongs to a wallet selection. My share of a bill my partner
// paid has no wallet, so it shows only under the total.
function inSel(t, S) { return t.walletId ? S.has(t.walletId) : (t.scope === 'shared' && !!S.total); }

// How much a transaction moves the balance of a set of wallets.
function deltaFor(t, S) {
  if (t.type === 'settle') return S.has(t.walletId) ? t.sign * t.amount : 0;
  if (t.scope === 'shared') return t.counted && S.has(t.walletId) ? -t.walletAmount : 0;
  if (t.type === 'income') return S.has(t.walletId) ? t.amount : 0;
  if (t.type === 'expense') return S.has(t.walletId) ? -t.amount : 0;
  return (S.has(t.toWalletId) ? t.amount : 0) - (S.has(t.walletId) ? t.amount : 0);
}

function touches(t, S) {
  if (t.type === 'settle') return S.has(t.walletId) || (!!S.total && !t.walletId);
  return inSel(t, S) || (t.type === 'transfer' && S.has(t.toWalletId));
}

// Balance at the end of day `upto` (YYYY-MM-DD, inclusive).
function balanceOf(sel, upto = dateStr(new Date())) {
  const S = walletSet(sel);
  let b = money.wallets.filter((w) => S.has(w.id)).reduce((s, w) => s + (w.initial || 0), 0);
  money.txns.forEach((t) => { if (t.date <= upto) b += deltaFor(t, S); });
  return b;
}

function dayBefore(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d - 1));
}
function parseDs(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d); }

// Totals of real income/expense (transfers are not income or spending).
function totalsIn(list, S) {
  let income = 0, expense = 0;
  list.forEach((t) => {
    if (!counts(t) || !inSel(t, S)) return;
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
  });
  return { income, expense };
}

function txnsInMonth(ym) { return money.txns.filter((t) => t.date.slice(0, 7) === ym); }

// Cumulative income or expense per day of a month, index 0 = day 1.
function cumDaily(ym, type, filter = () => true, value = (t) => t.amount) {
  const dim = daysInMonth(ym);
  const per = new Array(dim).fill(0);
  txnsInMonth(ym).forEach((t) => {
    if (t.type === type && counts(t) && filter(t)) per[Number(t.date.slice(8, 10)) - 1] += value(t);
  });
  for (let i = 1; i < dim; i++) per[i] += per[i - 1];
  return per;
}

// A personal budget counts my spending (my share of shared bills); a shared budget
// counts whole shared bills, once, for the couple.
function budgetFilter(bg) {
  const target = catById(bg.category) ? catById(bg.category).id : bg.category;
  const cat = (t) => bg.category === 'all' || catIn(t.category, target);
  if (bg.scope === 'shared') return (t) => t.type === 'expense' && t.scope === 'shared' && t.counted && cat(t);
  const S = walletSet(bg.walletId || 'total');
  return (t) => t.type === 'expense' && counts(t) && inSel(t, S) && cat(t);
}
function budgetValue(bg) { return bg.scope === 'shared' ? (t) => t.total : (t) => t.amount; }
function budgetSpent(bg, ym) {
  const f = budgetFilter(bg), v = budgetValue(bg);
  return txnsInMonth(ym).filter(f).reduce((s, t) => s + v(t), 0);
}

// Share of the month that has passed: 1 for past months, 0 for future ones.
function monthPace(ym) {
  const cur = ymOf(new Date());
  if (ym < cur) return 1;
  if (ym > cur) return 0;
  return new Date().getDate() / daysInMonth(ym);
}
function paceCls(spent, amount, pace) {
  if (amount <= 0) return 'ok';
  if (spent > amount) return 'bad';
  return spent / amount > pace + 0.02 ? 'warn' : 'ok';
}

/* ---------- Bill payments → transactions ---------- */

function billPayWallet() {
  const p = money.prefs.billWallet;
  if (p === '') return '';
  return walletById(p) ? p : firstWalletId();
}

function removeBillTxn(billId, ym) {
  money.txns.filter((t) => t.billId === billId && t.billYm === ym).forEach(deleteTxn);
}

function recordBillTxn(b, ym, amount, walletId, date = dateStr(new Date())) {
  removeBillTxn(b.id, ym);
  if (!walletId || !walletById(walletId) || !(amount > 0)) return;
  saveTxn({
    id: newId(), type: 'expense', amount, category: BILL_TX_CAT[b.category] || 'other_exp',
    walletId, date, note: tr(`จ่าย${b.name}`), billId: b.id, billYm: ym,
  });
}

/* ---------- Persistence: local profile, or the signed-in account (cloud.js) ---------- */

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : uid();
}

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
}

function saveTxn(t) {
  upsert(money.txns, t);
  if (isCloud()) cloudSaveTxn(t); else saveMoney();
}
function deleteTxn(t) {
  money.txns = money.txns.filter((x) => x.id !== t.id);
  if (isCloud()) cloudCall('DELETE', `/expenses/${t.id}`); else saveMoney();
}
function saveWallet(w) {
  upsert(money.wallets, w);
  if (isCloud()) cloudCall('PUT', `/wallets/${encodeURIComponent(w.id)}`, { ...w, sort: money.wallets.indexOf(w) });
  else saveMoney();
}
function deleteWallet(w) {
  money.wallets = money.wallets.filter((x) => x.id !== w.id);
  money.txns = money.txns.filter((t) => t.scope === 'shared' || (t.walletId !== w.id && t.toWalletId !== w.id));
  money.budgets.forEach((bg) => { if (bg.walletId === w.id) bg.walletId = 'total'; });
  if (isCloud()) cloudCall('DELETE', `/wallets/${encodeURIComponent(w.id)}`); else saveMoney();
}
function saveBudget(bg) {
  upsert(money.budgets, bg);
  if (isCloud()) cloudCall('PUT', `/budgets/${bg.id}`, bg); else saveMoney();
}
function deleteBudget(bg) {
  money.budgets = money.budgets.filter((x) => x.id !== bg.id);
  if (isCloud()) cloudCall('DELETE', `/budgets/${bg.id}`); else saveMoney();
}
function saveLabel(l) {
  upsert(money.labels, l);
  if (isCloud()) cloudCall('PUT', `/labels/${encodeURIComponent(l.id)}`, { ...l, sort: money.labels.indexOf(l) });
  else saveMoney();
}
function deleteLabel(l) {
  money.labels = money.labels.filter((x) => x.id !== l.id);
  money.txns.forEach((t) => { if (t.labels && t.labels.includes(l.id)) t.labels = t.labels.filter((x) => x !== l.id); });
  if (ui.txLabel === l.id) ui.txLabel = '';
  if (isCloud()) cloudCall('DELETE', `/labels/${encodeURIComponent(l.id)}`); else saveMoney();
}
// Labels only (no other change): also works on a partner's shared expense.
function setTxnLabels(t, ids) {
  t.labels = ids;
  if (isCloud()) cloudCall('PUT', `/expenses/${t.id}/labels`, { labels: ids }); else saveMoney();
}
function savePrefs() {
  if (isCloud()) cloudSavePrefs(); else saveMoney();
}

function billTxn(billId, ym) { return money.txns.find((t) => t.billId === billId && t.billYm === ym); }

/* ---------- Formatting ---------- */

function sbaht(n) { return (n < 0 ? '-' : '') + baht(Math.abs(n)); }
function kbaht(n) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${+(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${+(a / 1e3).toFixed(a >= 1e5 ? 0 : 2)}K` : fmt.format(a);
  return `${n < 0 ? '-' : ''}฿${s}`;
}
function masked(s) { return money.prefs.hideBalance ? '฿ ••••••' : s; }
function thDate(ds) { const d = parseDs(ds); return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear() + BE).slice(2)}`; }
function dayLabel(ds) {
  const diff = daysBetween(today(), parseDs(ds));
  if (diff === 0) return 'วันนี้';
  if (diff === -1) return 'เมื่อวาน';
  if (diff === 1) return 'พรุ่งนี้';
  return TH_DOW_FULL[parseDs(ds).getDay()];
}
function txAmtCls(t, S) {
  if (t.type === 'transfer') { const d = deltaFor(t, S); return d > 0 ? 'inc' : d < 0 ? 'exp' : 'xfer'; }
  return t.type === 'income' ? 'inc' : 'exp';
}

/* ---------- Icons ---------- */

const ICONS = {
  search: '<path d="M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM21 21l-5.2-5.2"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  updown: '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  swap: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
  receipt: '<path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z"/><path d="M9 8h6M9 12h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.4-3.6 4.4-5.5 8-5.5s6.6 1.9 8 5.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  repeat: '<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5A1.5 1.5 0 0 0 8 21h8a1.5 1.5 0 0 0 1.5-1.5L18.5 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  tag: '<path d="M3 12.2V4.5A1.5 1.5 0 0 1 4.5 3h7.7l8.8 8.8a1.5 1.5 0 0 1 0 2.1l-7.1 7.1a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.6"/>',
};
function svgIcon(name, cls = 'svg-i') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

function circleIco(c, cls = 'ico round') { return `<div class="${cls}" style="background:${c.color}22">${c.icon}</div>`; }
function walletIco(w, cls = 'ico round') {
  if (!w) return circleIco(TOTAL_WALLET, cls);
  return `<div class="${cls}${wImg(w) ? ' has-img' : ''}" style="background:${wType(w).color}22">${wFace(w)}</div>`;
}

function walletPill() {
  const w = ui.wallet === 'total' ? null : walletById(ui.wallet);
  const name = w ? w.name : TOTAL_WALLET.name;
  return `<button class="pill" data-action="wallet-pick">${walletIco(w, 'pill-ico')}<span>${esc(name)}</span>${svgIcon('updown', 'svg-i sm')}</button>`;
}

/* ---------- Charts (inline SVG) ---------- */

function niceStep(max, n = 3) {
  const raw = max / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/* lines: [{ pts: [[dayIndex, value], …], cls, area, dash, dot }]; hline: { v, cls } */
function lineChart({ dim, lines, hline, xLabels, w = 340, h = 180 }) {
  const padL = 6, padR = 46, padT = 12, padB = 24;
  const iw = w - padL - padR, ih = h - padT - padB;
  let max = Math.max(1, hline ? hline.v : 0, ...lines.flatMap((l) => l.pts.map((p) => p[1])));
  const step = niceStep(max * 1.08);
  max = Math.ceil((max * 1.08) / step) * step;
  const X = (i) => padL + (dim > 1 ? (i / (dim - 1)) * iw : 0);
  const Y = (v) => padT + ih - (v / max) * ih;
  let g = '';
  for (let v = 0; v <= max + 1e-9; v += step) {
    g += `<line class="grid" x1="${padL}" x2="${padL + iw}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text class="ylab" x="${padL + iw + 6}" y="${Y(v) + 3.5}">${kbaht(v).replace('฿', '')}</text>`;
  }
  const id = `g${Math.random().toString(36).slice(2, 7)}`;
  let body = '';
  lines.forEach((l, k) => {
    if (!l.pts.length) return;
    const d = l.pts.map((p, j) => `${j ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    if (l.area) {
      const last = l.pts[l.pts.length - 1], first = l.pts[0];
      body += `<path class="area ${l.cls}" fill="url(#${id}${k})" d="${d}L${X(last[0]).toFixed(1)},${Y(0)}L${X(first[0]).toFixed(1)},${Y(0)}Z"/>`;
      body += `<defs><linearGradient id="${id}${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="stop-a ${l.cls}"/><stop offset="1" class="stop-b ${l.cls}"/></linearGradient></defs>`;
    }
    body += `<path class="ln ${l.cls} ${l.dash ? 'dash' : ''}" d="${d}"/>`;
    if (l.dot) {
      const p = l.pts[l.pts.length - 1];
      body += `<line class="vline" x1="${X(p[0])}" x2="${X(p[0])}" y1="${padT}" y2="${Y(0)}"/>`;
      body += `<circle class="dotm ${l.cls}" cx="${X(p[0])}" cy="${Y(p[1])}" r="4.5"/>`;
    }
  });
  if (hline) body += `<line class="hline ${hline.cls}" x1="${padL}" x2="${padL + iw}" y1="${Y(hline.v)}" y2="${Y(hline.v)}"/>`;
  const xl = (xLabels || []).map(([i, t], j, arr) =>
    `<text class="xlab" x="${X(i)}" y="${h - 6}" text-anchor="${j === 0 ? 'start' : j === arr.length - 1 ? 'end' : 'middle'}">${t}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img">${g}${body}<line class="axis" x1="${padL}" x2="${padL + iw}" y1="${Y(0)}" y2="${Y(0)}"/>${xl}</svg>`;
}

function gauge(ratio, cls) {
  const r = 100, cx = 120, cy = 116, len = Math.PI * r;
  const f = Math.max(0, Math.min(1, ratio));
  const a = Math.PI * (1 - f);
  const kx = cx + r * Math.cos(a), ky = cy - r * Math.sin(a);
  const arc = `M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}`;
  return `<svg class="gauge" viewBox="0 0 240 128" aria-hidden="true">
    <path class="g-bg" d="${arc}"/>
    <path class="g-fg ${cls}" d="${arc}" stroke-dasharray="${(len * f).toFixed(1)} ${len.toFixed(1)}"/>
    ${f > 0 ? `<circle class="g-knob ${cls}" cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="7"/>` : ''}
  </svg>`;
}

function ring(pct, cls) {
  const r = 22, len = 2 * Math.PI * r, f = Math.max(0, Math.min(1, pct / 100));
  return `<svg class="ring" viewBox="0 0 56 56" aria-hidden="true"><circle class="r-bg" cx="28" cy="28" r="${r}"/>
    <circle class="r-fg ${cls}" cx="28" cy="28" r="${r}" stroke-dasharray="${(len * f).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 28 28)"/>
    <text x="28" y="32" text-anchor="middle">${Math.round(pct)}%</text></svg>`;
}

function budgetBar(spent, amount, ym) {
  const pace = monthPace(ym);
  const cls = paceCls(spent, amount, pace);
  const pct = amount > 0 ? Math.min(100, (spent / amount) * 100) : 0;
  const showToday = ym === ymOf(new Date());
  const tp = (pace * 100).toFixed(1);
  return `<div class="bbar"><div class="bfill ${cls}" style="width:${pct}%"></div>${showToday ? `<i class="btoday" style="left:${tp}%"></i>` : ''}</div>
    ${showToday ? `<div class="btoday-wrap"><span class="btoday-lab" style="left:clamp(24px, ${tp}%, calc(100% - 24px))">วันนี้</span></div>` : ''}`;
}

/* ---------- Shared list pieces ---------- */

function txItem(t, S) {
  const c = txCat(t);
  const w = walletById(t.walletId);
  const to = t.type === 'transfer' ? walletById(t.toWalletId) : null;
  let title = t.type === 'transfer' ? `${esc(w ? w.name : '?')} → ${esc(to ? to.name : '?')}` : esc(c.label);
  if (t.type === 'settle') title = t.sign > 0 ? `รับเงินคืนจาก${esc(partnerName())}` : `คืนเงินให้${esc(partnerName())}`;
  const shared = t.scope === 'shared';
  const sub = [
    t.type === 'transfer' ? c.label : '',
    esc(t.merchant || ''),
    esc(t.note || ''),
    shared ? splitLine(t) : '',
  ].filter(Boolean).join(' · ') || (w ? esc(w.name) : '');
  const badges = [
    shared ? '<span class="badge share">ร่วม</span>' : '',
    t.billId ? '<span class="badge muted">บิล</span>' : '',
    t.receiptKey ? '<span class="badge muted">🧾</span>' : '',
    ...txLabels(t).map((l) => `<span class="badge label">${svgIcon('tag', 'svg-i xs')}${esc(l.name)}</span>`),
  ].join(' ');
  const amt = shared ? t.total : t.amount;
  const cls = t.type === 'settle' ? (t.sign > 0 ? 'inc' : 'exp') : shared && !t.counted ? 'xfer' : txAmtCls(t, S);
  return `
    <button class="item tx" data-tx="${t.id}">
      <div class="ico-wrap">${circleIco(c)}${w ? `<span class="mini${wImg(w) ? ' has-img' : ''}" style="background:${wType(w).color}">${wFace(w)}</span>` : ''}</div>
      <div class="main"><div class="name">${title}</div><div class="sub">${sub}</div>${badges.trim() ? `<div class="badges">${badges}</div>` : ''}</div>
      <div class="right"><div class="amt ${cls}">${baht(amt)}</div></div>
    </button>`;
}

function dayGroups(list, S, newestFirst = true) {
  const by = {};
  list.forEach((t) => { (by[t.date] = by[t.date] || []).push(t); });
  const days = Object.keys(by).sort();
  if (newestFirst) days.reverse();
  return days.map((ds) => {
    const items = by[ds];
    const net = items.reduce((s, t) => s + deltaFor(t, S), 0);
    const d = parseDs(ds);
    return `
      <div class="day-card">
        <div class="day-head">
          <div class="dnum">${d.getDate()}</div>
          <div class="dmeta"><div>${dayLabel(ds)}</div><div>${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + BE}</div></div>
          <div class="dtotal">${net > 0 ? '+' : ''}${sbaht(net)}</div>
        </div>
        ${items.map((t) => txItem(t, S)).join('')}
      </div>`;
  }).join('');
}

/* ---------- Home ---------- */

function renderHome() {
  const S = walletSet('total');
  const total = balanceOf('total');
  const ym = ymOf(new Date());
  const alerts = alertCount();
  const hide = money.prefs.hideBalance;

  const wallets = money.wallets.slice(0, 4).map((w) => `
    <button class="item" data-wallet-edit="${w.id}">
      ${walletIco(w)}
      <div class="main"><div class="name">${esc(w.name)}</div>${w.excluded ? '<div class="sub">ไม่รวมในยอดรวม</div>' : ''}</div>
      <div class="right"><div class="amt">${masked(sbaht(balanceOf(w.id)))}</div></div>
    </button>`).join('');

  const occ = state.bills.length ? occurrences(ym).filter((o) => !o.paid) : [];
  const billsLeft = occ.reduce((s, o) => s + o.amount, 0);
  const recent = money.txns.filter((t) => t.date <= dateStr(new Date()) && t.type !== 'settle')
    .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).slice(0, 4);

  view.innerHTML = `
    <div class="hero">
      <div class="hero-top">
        <button class="avatar-btn${userImg(cloud.user) ? ' has-img' : ''}" data-goto="account" aria-label="บัญชี">${cloud.user ? userFace(cloud.user) : svgIcon('user')}</button>
        <button class="search-cap" data-action="search">${svgIcon('search')}<span>ค้นหารายการ</span></button>
        <button class="round-btn" data-action="alerts" aria-label="การแจ้งเตือน">${svgIcon('bell')}${alerts ? `<span class="nbadge">${alerts}</span>` : ''}</button>
      </div>
      <div class="hb">
        <div class="label">ยอดเงินรวม</div>
        <div class="hb-amt">${masked(sbaht(total))}
          <button class="eye" data-action="toggle-hide" aria-label="${hide ? 'แสดงยอดเงิน' : 'ซ่อนยอดเงิน'}">${svgIcon(hide ? 'eyeOff' : 'eye')}</button></div>
        <button class="glass-pill" data-action="wallets">กระเป๋าเงิน ${money.wallets.length} ใบ</button>
      </div>
      <div class="qa-row">
        <button data-action="add-tx"><i>${svgIcon('plus')}</i><span>เพิ่มรายการ</span></button>
        <button data-action="add-transfer"><i>${svgIcon('swap')}</i><span>โอนเงิน</span></button>
        <button data-goto="bills"><i>${svgIcon('receipt')}</i><span>จ่ายบิล</span></button>
        <button data-action="report" data-ym="${ym}"><i>${svgIcon('chart')}</i><span>รายงาน</span></button>
      </div>
    </div>

    <div class="card list-card">
      <div class="card-head"><b>กระเป๋าเงินของฉัน</b><button class="link-btn" data-action="wallets">ดูทั้งหมด</button></div>
      ${wallets}
    </div>

    ${coupleCard()}

    ${state.bills.length ? `
    <div class="section-row"><span>บิลที่ต้องจ่ายเดือนนี้</span><button class="link-btn" data-goto="bills">ดูบิล</button></div>
    <div class="card list-card">
      <div class="card-head"><span class="muted">คงเหลือต้องจ่าย</span><b>${baht(billsLeft)}</b></div>
      ${occ.length ? occ.slice(0, 3).map(occItem).join('') : '<div class="muted pad">🎉 จ่ายครบทุกบิลแล้วเดือนนี้</div>'}
    </div>` : ''}

    ${money.txns.length ? `
    <div class="section-row"><span>รายงานเดือนนี้</span><button class="link-btn" data-action="report" data-ym="${ym}">ดูรายงาน</button></div>
    <div class="card" id="homeReport">${homeReport(ym, S)}</div>
    ${insightCard(ym, S)}
    <div class="section-row"><span>รายการล่าสุด</span><button class="link-btn" data-goto="txns">ดูทั้งหมด</button></div>
    <div class="card list-card">${recent.map((t) => txItem(t, S)).join('') || '<div class="muted pad">ยังไม่มีรายการ</div>'}</div>
    ` : `
    <div class="card empty-card">
      <div class="e-ico">👛</div>
      <b>เริ่มบันทึกรายรับรายจ่าย</b>
      <div class="muted small">บันทึกทุกรายการเพื่อดูยอดเงินแต่ละกระเป๋า รายงานรายเดือน และตั้งงบประมาณ</div>
      <button class="btn" data-action="add-tx" style="margin-top:14px">＋ เพิ่มรายการแรก</button>
      ${state.bills.length || isCloud() ? '' : '<button class="btn ghost" data-action="sample">ลองใช้ข้อมูลตัวอย่าง</button>'}
    </div>`}
    ${state.bills.length || money.txns.length ? '' : installTip()}
  `;
}

function homeReport(ym, S) {
  const type = ui.reportType;
  const { income, expense } = totalsIn(txnsInMonth(ym), S);
  const f = (t) => inSel(t, S);
  const dim = daysInMonth(ym);
  const day = new Date().getDate();
  const cur = cumDaily(ym, type, f).slice(0, day);
  // Average of earlier months that have data, aligned by day of month.
  const prev = [1, 2, 3].map((i) => addMonths(ym, -i)).filter((m) => txnsInMonth(m).some((t) => t.type === type && counts(t)));
  const prevCum = prev.map((m) => cumDaily(m, type, f));
  const avg = prevCum.length
    ? Array.from({ length: dim }, (_, i) => prevCum.reduce((s, a) => s + a[Math.min(i, a.length - 1)], 0) / prevCum.length)
    : [];
  const cls = type === 'expense' ? 'exp' : 'inc';
  const { m } = parseYm(ym);
  const chart = lineChart({
    dim,
    lines: [
      { pts: avg.map((v, i) => [i, v]), cls: 'avg' },
      { pts: cur.map((v, i) => [i, v]), cls, area: true, dot: true },
    ],
    xLabels: [[0, `1/${m}`], [dim - 1, `${dim}/${m}`]],
  });
  const now = cur[cur.length - 1] || 0;
  return `
    <div class="rtabs">
      <button class="${type === 'expense' ? 'on exp' : ''}" data-rtype="expense"><span>ใช้จ่ายทั้งหมด</span><b class="exp">${kbaht(expense)}</b></button>
      <button class="${type === 'income' ? 'on inc' : ''}" data-rtype="income"><span>รายรับทั้งหมด</span><b class="inc">${kbaht(income)}</b></button>
    </div>
    <div class="tip"><span class="muted">${day}/${m}/${parseYm(ym).y + BE}:</span> <b class="${cls}">${kbaht(now)}</b>
      ${avg.length ? `<div class="muted small">เฉลี่ย ${prev.length} เดือนก่อน ณ วันเดียวกัน: <b>${kbaht(avg[day - 1])}</b></div>` : ''}</div>
    ${chart}
    <div class="legend"><span><i class="dot ${cls}"></i>เดือนนี้</span>${avg.length ? `<span><i class="dot avg"></i>เฉลี่ย ${prev.length} เดือนก่อน</span>` : ''}</div>`;
}

function insightCard(ym, S) {
  const exp = txnsInMonth(ym).filter((t) => t.type === 'expense' && counts(t) && t.category && inSel(t, S));
  if (!exp.length) return '';
  const by = {};
  exp.forEach((t) => { const k = catRootId(t.category); by[k] = (by[k] || 0) + t.amount; });
  const [top, spent] = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  const c = catById(top) || catFallback('expense');
  const day = new Date().getDate();
  const lastYm = addMonths(ym, -1);
  const lastSame = txnsInMonth(lastYm)
    .filter((t) => t.type === 'expense' && counts(t) && catIn(t.category, top) && inSel(t, S) && Number(t.date.slice(8, 10)) <= day)
    .reduce((s, t) => s + t.amount, 0);
  let cmp = '';
  if (lastSame > 0) {
    const pct = Math.abs(spent / lastSame - 1) * 100;
    const lower = spent <= lastSame;
    cmp = `<div class="ins-r">${ring(Math.min(pct, 100), lower ? 'ok' : 'bad')}<div class="muted small">${lower ? 'น้อยกว่า' : 'มากกว่า'}เดือนก่อน</div></div>`;
  }
  return `
    <div class="section-row"><span>ข้อมูลเชิงลึก</span></div>
    <div class="card insight">
      <div class="ins-top">${circleIco(c)}<div><b>${esc(c.label)}</b><div class="muted small">หมวดที่ใช้มากที่สุดเดือนนี้ · รวม <b class="exp">${baht(spent)}</b></div></div></div>
      <div class="ins-row">
        <div><div class="muted small">เฉลี่ยเดือนนี้</div><div class="ins-avg">${baht(Math.round((spent / day) * 100) / 100)}<span class="muted">/วัน</span></div></div>
        ${cmp}
      </div>
    </div>`;
}

function alertList() {
  const ym = ymOf(new Date());
  const bills = state.bills.length
    ? occurrences(ym).filter((o) => !o.paid && !o.bill.autopay && (o.status === 'overdue' || o.status === 'soon')) : [];
  // PRD: warn from 80% of a budget, and again once it is over 100%.
  const over = money.budgets.filter((bg) => budgetSpent(bg, ym) >= bg.amount * 0.8);
  return { bills, over };
}
function alertCount() { const a = alertList(); return a.bills.length + a.over.length + (gmailAutoDue() ? 1 : 0); }

function alertsSheet() {
  const { bills, over } = alertList();
  const ym = ymOf(new Date());
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>การแจ้งเตือน</h2><span style="width:40px"></span></div>
    ${gmailAutoDue() ? gmailAutoAlert() : ''}
    ${bills.length ? `<div class="section-title">บิลใกล้ครบกำหนด / เลยกำหนด</div><div class="list">${bills.map(occItem).join('')}</div>` : ''}
    ${over.length ? `<div class="section-title">งบประมาณใช้ไปแล้ว 80% ขึ้นไป</div>${over.map((bg) => budgetRow(bg, ym)).join('')}` : ''}
    ${bills.length || over.length || gmailAutoDue() ? '' : '<div class="empty"><div class="e-ico">🔔</div>ไม่มีการแจ้งเตือน</div>'}
  `);
}

/* ---------- Transactions ---------- */

function periodRange(p) {
  const td = dateStr(new Date());
  const cur = ymOf(new Date());
  if (p === 'future') return { future: true, label: 'อนาคต' };
  if (p === 'this') return { from: `${cur}-01`, to: td, ym: cur, label: 'เดือนนี้' };
  const ym = p === 'last' ? addMonths(cur, -1) : p;
  return { from: `${ym}-01`, to: `${ym}-${pad(daysInMonth(ym))}`, ym, label: p === 'last' ? 'เดือนก่อน' : thMonthYear(ym) };
}

function periodTabs() {
  const cur = ymOf(new Date());
  const earliest = money.txns.reduce((m, t) => (t.date.slice(0, 7) < m ? t.date.slice(0, 7) : m), addMonths(cur, -3));
  const tabs = [];
  for (let ym = earliest; ym < addMonths(cur, -1); ym = addMonths(ym, 1)) {
    const { y, m } = parseYm(ym);
    tabs.push([ym, `${TH_MONTHS_SHORT[m - 1]} ${String(y + BE).slice(2)}`]);
  }
  tabs.push(['last', 'เดือนก่อน'], ['this', 'เดือนนี้'], ['future', 'อนาคต']);
  return tabs;
}

function renderTxns() {
  const sel = walletById(ui.wallet) ? ui.wallet : (ui.wallet = 'total');
  view.innerHTML = `
    <div class="page-head sticky">
      <div class="ph-row">
        <button class="round-btn" data-action="search" aria-label="ค้นหา">${svgIcon('search')}</button>
        ${walletPill()}
        <button class="round-btn" data-action="tx-menu" aria-label="เมนู">${svgIcon('more')}</button>
      </div>
      <div class="ph-bal"><div class="label">ยอดคงเหลือ</div><b>${masked(sbaht(balanceOf(sel)))}</b></div>
      ${ui.searchOpen ? `<div class="searchbar"><input id="txSearch" type="search" placeholder="ค้นหาบันทึก หมวดหมู่ หรือกระเป๋าเงิน" value="${esc(ui.search)}" autocomplete="off"><button class="link-btn" data-action="search-close">ยกเลิก</button></div>` : ''}
      <div class="ptabs" id="ptabs">${periodTabs().map(([k, l]) => `<button data-period="${k}" class="${ui.period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    ${txFilters()}
    <div id="txList">${txListHtml(sel)}</div>
  `;
  const strip = $('#ptabs');
  const on = strip.querySelector('.on');
  if (on) strip.scrollLeft = on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2;
  const input = $('#txSearch');
  if (input) {
    input.addEventListener('input', () => { ui.search = input.value; $('#txList').innerHTML = txListHtml(sel); });
    if (ui.focusSearch) { ui.focusSearch = false; input.focus(); }
  }
}

function txListHtml(sel) {
  const S = walletSet(sel);
  const q = ui.searchOpen ? ui.search.trim().toLowerCase() : '';
  if (q) {
    const hits = money.txns.filter((t) => touches(t, S) && txFilterOk(t) && [t.note, t.merchant, txCat(t).label, (walletById(t.walletId) || {}).name, String(t.amount), ...txLabels(t).map((l) => l.name)]
      .some((s) => String(s || '').toLowerCase().includes(q)));
    return hits.length ? `<div class="muted small pad">พบ ${hits.length} รายการ</div>${dayGroups(hits, S)}` : '<div class="empty">ไม่พบรายการ</div>';
  }
  const r = periodRange(ui.period);
  const td = dateStr(new Date());
  if (r.future) {
    const list = money.txns.filter((t) => t.date > td && touches(t, S) && txFilterOk(t));
    const upcoming = [];
    if (sel === 'total' || sel === billPayWallet()) {
      [0, 1, 2].forEach((i) => occurrences(addMonths(ymOf(new Date()), i))
        .forEach((o) => { if (!o.paid && o.daysLeft >= 0) upcoming.push(o); }));
    }
    return `
      ${upcoming.length ? `<div class="section-title">บิลที่กำลังจะถึง · ${baht(upcoming.reduce((s, o) => s + o.amount, 0))}</div><div class="list" style="margin-bottom:14px">${upcoming.map(occItem).join('')}</div>` : ''}
      ${list.length ? `<div class="section-title">รายการล่วงหน้า</div>${dayGroups(list, S, false)}` : ''}
      ${list.length || upcoming.length ? '' : '<div class="empty"><div class="e-ico">🗓️</div>ไม่มีรายการในอนาคต</div>'}`;
  }
  const list = money.txns.filter((t) => t.date >= r.from && t.date <= r.to && touches(t, S) && txFilterOk(t));
  const open = balanceOf(sel, dayBefore(r.from));
  const end = balanceOf(sel, r.to);
  return `
    <div class="card period-sum">
      <div class="kv"><span>ยอดยกมา</span><span>${sbaht(open)}</span></div>
      <div class="kv"><span>ยอดคงเหลือ</span><span>${sbaht(end)}</span></div>
      <div class="kv net"><span></span><b>${end - open > 0 ? '+' : ''}${sbaht(end - open)}</b></div>
      <button class="link-btn center" data-action="report" data-ym="${r.ym}">ดูรายงานช่วงนี้</button>
    </div>
    ${list.length ? dayGroups(list, S) : `<div class="empty"><div class="e-ico">🧾</div>ยังไม่มีรายการ${r.label}</div>`}`;
}

const TX_FILTERS = [['all', 'ทั้งหมด'], ['personal', 'ส่วนตัว'], ['shared', 'ร่วมกัน']];

function txFilters() {
  const list = cloud.partner ? TX_FILTERS : TX_FILTERS.filter(([k]) => k === 'all');
  const lab = labelById(ui.txLabel);
  const basic = money.txns.some((t) => t.scope === 'shared') || ui.txFilter !== 'all';
  if (!basic && !money.labels.length && !lab) return '';
  const labChip = lab
    ? `<button class="chip on lab" data-txlabel="">${svgIcon('tag', 'svg-i xs')}${esc(lab.name)} ✕</button>`
    : money.labels.length ? `<button class="chip lab" data-action="label-filter">${svgIcon('tag', 'svg-i xs')}ป้ายกำกับ</button>` : '';
  return `<div class="chips filters">${labChip}${basic ? list.map(([k, l]) =>
    `<button class="chip ${ui.txFilter === k ? 'on' : ''}" data-txfilter="${k}">${l}</button>`).join('') : ''}</div>`;
}

function txFilterOk(t) {
  if (ui.txLabel && !(t.labels || []).includes(ui.txLabel)) return false;
  switch (ui.txFilter) {
    case 'personal': return t.scope !== 'shared' && t.type !== 'settle';
    case 'shared': return t.scope === 'shared' || t.type === 'settle';
    default: return true;
  }
}

function txMenu() {
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>ตัวเลือก</h2><span style="width:40px"></span></div>
    <div class="list">
      <button class="item" data-action="report" data-ym="${periodRange(ui.period).ym || ymOf(new Date())}">${circleIco({ icon: '📊', color: '#2f6bff' })}<div class="main"><div class="name">ดูรายงานช่วงนี้</div></div></button>
      <button class="item" data-action="wallets">${circleIco({ icon: '👛', color: '#1a9e5c' })}<div class="main"><div class="name">จัดการกระเป๋าเงิน</div></div></button>
      <button class="item" data-action="labels">${circleIco({ icon: '🏷️', color: '#7a5af8' })}<div class="main"><div class="name">ป้ายกำกับ</div></div></button>
      <button class="item" data-action="csv">${circleIco({ icon: '⬇️', color: '#8a8f99' })}<div class="main"><div class="name">ส่งออกรายการ (CSV)</div></div></button>
    </div>`);
}

function exportCsv() {
  if (!money.txns.length) { toast('ยังไม่มีรายการ'); return; }
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['วันที่', 'ประเภท', 'หมวดหมู่', 'กระเป๋าเงิน', 'ไปยัง', 'จำนวนเงิน', 'ร้านค้า', 'บันทึก', 'ขอบเขต', 'ยอดรวมทั้งบิล', 'ต้นทุน', 'ป้ายกำกับ']];
  const typeTh = { expense: 'รายจ่าย', income: 'รายรับ', transfer: 'โอนเงิน', settle: 'คืนเงินระหว่างคู่' };
  money.txns.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((t) => rows.push([
    t.date, typeTh[t.type], txCat(t).label, (walletById(t.walletId) || {}).name,
    t.type === 'transfer' ? (walletById(t.toWalletId) || {}).name : '', t.type === 'settle' ? t.sign * t.amount : t.amount,
    t.merchant, t.note, t.scope === 'shared' ? 'ร่วมกัน' : 'ส่วนตัว', t.scope === 'shared' ? t.total : '',
    t.scope === 'shared' ? (splitOf(t) === 'full' ? 'รับผิดชอบทั้งหมด' : 'หาร 2') : '', txLabels(t).map((l) => l.name).join(', '),
  ]));
  deliverFile(`transactions-${dateStr(new Date())}.csv`, 'text/csv', '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'));
}

/* ---------- Report ---------- */

function reportSheet(ym) {
  ym = ym || ymOf(new Date());
  const S = walletSet(ui.tab === 'txns' ? ui.wallet : 'total');
  const lab = ui.tab === 'txns' ? labelById(ui.txLabel) : null;
  const list = txnsInMonth(ym).filter((t) => t.type !== 'transfer' && counts(t) && inSel(t, S) && (!lab || (t.labels || []).includes(lab.id)));
  const { income, expense } = totalsIn(list, S);
  const bars = (type) => {
    // Sub-categories roll up into their parent; the split shows under the parent's bar.
    const by = {}, subs = {};
    list.filter((t) => t.type === type).forEach((t) => {
      const k = t.category ? catRootId(t.category, type) : '_review';
      by[k] = (by[k] || 0) + t.amount;
      const own = t.category && catById(t.category);
      if (own && own.id !== k) { subs[k] = subs[k] || {}; subs[k][own.id] = (subs[k][own.id] || 0) + t.amount; }
    });
    const sum = Object.values(by).reduce((s, v) => s + v, 0);
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '<div class="card muted" style="text-align:center">ไม่มีรายการ</div>';
    return `<div class="list">${rows.map(([k, v]) => {
      const c = k === '_review' ? NO_CAT : catById(k) || catFallback(type);
      const p = (v / sum) * 100;
      const split = Object.entries(subs[k] || {}).sort((a, b) => b[1] - a[1])
        .map(([id, x]) => `<div class="rep-sub"><span>${esc(catById(id).label)}</span><span>${baht(x)}</span></div>`).join('');
      return `<div class="item rep">${circleIco(c)}<div class="main"><div class="rep-top"><span class="name">${esc(c.label)}</span><b>${baht(v)}</b></div>
        <div class="rep-bar"><div style="width:${p}%;background:${c.color}"></div></div><div class="sub">${p.toFixed(1)}%</div>${split}</div></div>`;
    }).join('')}</div>`;
  };
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>รายงาน ${thMonthYear(ym)}</h2><span style="width:40px"></span></div>
    ${lab ? `<div class="chips"><span class="chip on lab">${svgIcon('tag', 'svg-i xs')}${esc(lab.name)}</span></div>` : ''}
    <div class="card summary">
      <div class="row" style="margin-top:0">
        <div class="stat inc-soft"><span>รายรับ</span><b class="inc">${baht(income)}</b></div>
        <div class="stat exp-soft"><span>รายจ่าย</span><b class="exp">${baht(expense)}</b></div>
      </div>
      <div class="kv" style="padding:12px 2px 0"><span>คงเหลือสุทธิ</span><b>${income - expense > 0 ? '+' : ''}${sbaht(income - expense)}</b></div>
    </div>
    <div class="section-title">รายจ่ายตามหมวดหมู่</div>${bars('expense')}
    <div class="section-title">รายรับตามหมวดหมู่</div>${bars('income')}
  `);
}

/* ---------- Budgets ---------- */

function budgetYm() { return addMonths(ymOf(new Date()), ui.budgetOff); }

function visibleBudgets() {
  return money.budgets.filter((bg) => bg.scope !== 'shared'
    && (ui.wallet === 'total' || bg.walletId === ui.wallet || (bg.walletId || 'total') === 'total'));
}
function sharedBudgets() { return isCloud() && cloud.partner ? money.budgets.filter((bg) => bg.scope === 'shared') : []; }

function budgetRow(bg, ym) {
  const c = budgetCat(bg);
  const spent = budgetSpent(bg, ym);
  const left = bg.amount - spent;
  const w = bg.walletId && bg.walletId !== 'total' ? walletById(bg.walletId) : null;
  const pct = bg.amount ? (spent / bg.amount) * 100 : 0;
  const badge = `<span class="badge ${pct > 100 ? 'bad' : pct >= 80 ? 'warn' : 'muted'}">${Math.round(pct)}%</span>`;
  return `
    <button class="card budget" data-budget="${bg.id}">
      <div class="b-top">${circleIco(c)}
        <div class="main"><div class="name">${esc(c.label)} ${bg.scope === 'shared' ? '<span class="badge share">ร่วม</span>' : ''} ${badge}</div>${w ? `<div class="sub">${esc(w.name)}</div>` : ''}</div>
        <div class="right"><b>${baht(bg.amount)}</b><div class="sub ${left < 0 ? 'exp' : ''}">${left < 0 ? `เกินงบ ${baht(-left)}` : `เหลือ ${baht(left)}`}</div></div>
      </div>
      ${budgetBar(spent, bg.amount, ym)}
    </button>`;
}

function renderBudgets() {
  const ym = budgetYm();
  const list = visibleBudgets();
  const shared = sharedBudgets();
  const allBg = list.find((bg) => bg.category === 'all');
  const catBgs = list.filter((bg) => bg.category !== 'all');
  const totalBudget = allBg ? allBg.amount : catBgs.reduce((s, bg) => s + bg.amount, 0);
  const totalSpent = allBg ? budgetSpent(allBg, ym) : catBgs.reduce((s, bg) => s + budgetSpent(bg, ym), 0);
  const can = totalBudget - totalSpent;
  const pace = monthPace(ym);
  const cls = paceCls(totalSpent, totalBudget, pace);
  const dim = daysInMonth(ym);
  const cur = ymOf(new Date());
  const daysTxt = ym === cur ? `${dim - new Date().getDate()} วัน` : ym < cur ? 'สิ้นสุดแล้ว' : `${dim} วัน`;

  view.innerHTML = `
    <div class="page-head">
      <div class="ph-row"><h1>งบประมาณ</h1>${walletPill()}</div>
      <div class="ptabs fixed">${[[-1, 'เดือนก่อน'], [0, 'เดือนนี้'], [1, 'เดือนหน้า']].map(([o, l]) =>
        `<button data-boff="${o}" class="${ui.budgetOff === o ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    ${list.length ? `
    <div class="card gauge-card">
      <button class="gc-head" ${allBg ? `data-budget="${allBg.id}"` : 'data-action="add-budget-all"'}>
        ${circleIco(ALL_CAT, 'pill-ico')}<span>${allBg ? 'ทุกหมวดหมู่' : 'รวมทุกงบ'}</span>${svgIcon('chev', 'svg-i sm')}
      </button>
      <div class="gauge-wrap">${gauge(totalBudget ? totalSpent / totalBudget : 0, cls)}
        <div class="g-center"><div class="muted">${can < 0 ? 'ใช้เกินงบแล้ว' : 'จำนวนที่ใช้ได้'}</div><div class="g-amt ${can < 0 ? 'exp' : 'okc'}">${baht(Math.abs(can))}</div></div>
      </div>
      <div class="g-stats">
        <div><b>${kbaht(totalBudget)}</b><span>งบทั้งหมด</span></div>
        <div><b>${kbaht(totalSpent)}</b><span>ใช้ไปแล้ว</span></div>
        <div><b>${daysTxt}</b><span>ถึงสิ้นเดือน</span></div>
      </div>
      <button class="btn pillbtn" data-action="add-budget">สร้างงบประมาณ</button>
    </div>
    ${catBgs.map((bg) => budgetRow(bg, ym)).join('')}
    ` : shared.length ? '' : `
    <div class="card empty-card">
      <div class="e-ico">🎯</div>
      <b>ยังไม่มีงบประมาณ</b>
      <div class="muted small">ตั้งงบรายเดือนสำหรับแต่ละหมวด แล้วดูว่าใช้ไปเท่าไร เหลือเท่าไร และควรใช้วันละเท่าไร</div>
      <button class="btn" data-action="add-budget" style="margin-top:14px">สร้างงบประมาณ</button>
    </div>`}
    ${isCloud() && cloud.partner ? `
    <div class="section-row"><span>งบร่วมกับ ${esc(partnerName())}</span><button class="link-btn" data-action="add-budget-shared">＋ สร้างงบร่วม</button></div>
    ${shared.map((bg) => budgetRow(bg, ym)).join('') || '<div class="card muted small">งบร่วมนับยอดรวมทั้งบิลของรายจ่ายร่วม ทั้งสองคนเห็นงบเดียวกัน</div>'}` : ''}
  `;
}

function budgetDetail(id) {
  const bg = money.budgets.find((x) => x.id === id);
  if (!bg) return;
  const ym = budgetYm();
  const c = budgetCat(bg);
  const dim = daysInMonth(ym);
  const cur = ymOf(new Date());
  const f = budgetFilter(bg);
  const cum = cumDaily(ym, 'expense', f, budgetValue(bg));
  const spent = cum[dim - 1];
  const left = bg.amount - spent;
  const elapsed = ym === cur ? new Date().getDate() : ym < cur ? dim : 0;
  const daysLeft = dim - elapsed;
  const actualDaily = elapsed ? spent / elapsed : 0;
  const projected = ym > cur ? 0 : spent + actualDaily * daysLeft;
  const recommend = left > 0 ? left / Math.max(1, ym === cur ? daysLeft + 1 : ym > cur ? dim : 1) : 0;
  const w = bg.walletId && bg.walletId !== 'total' ? walletById(bg.walletId) : null;
  const { m, y } = parseYm(ym);
  const pts = cum.slice(0, Math.max(elapsed, 1)).map((v, i) => [i, v]);
  const proj = elapsed && daysLeft ? [[elapsed - 1, spent], [dim - 1, projected]] : [];
  const chart = lineChart({
    dim,
    lines: [
      { pts, cls: 'bud', area: true },
      { pts: proj, cls: projected > bg.amount ? 'exp' : 'avg', dash: true },
    ],
    hline: { v: bg.amount, cls: 'exp' },
    xLabels: [[0, `1/${m}/${String(y + BE).slice(2)}`], [dim - 1, `${dim}/${m}/${String(y + BE).slice(2)}`]],
  });
  const list = txnsInMonth(ym).filter(f);
  const S = walletSet(bg.walletId || 'total');

  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>${thMonthYear(ym)}</h2>
      <button class="link-btn" data-action="edit-budget" data-id="${bg.id}">แก้ไข</button>
    </div>
    <div class="card bd">
      <div class="b-top">${circleIco(c)}<div class="main"><div class="name big-name">${esc(c.label)}</div></div></div>
      <div class="bd-body">
        <div class="bd-amt">${baht(bg.amount)}</div>
        <div class="bd-sl"><div><span class="muted">ใช้ไป</span><b>${baht(spent)}</b></div>
          <div style="text-align:right"><span class="muted">${left < 0 ? 'เกินงบ' : 'เหลือ'}</span><b class="${left < 0 ? 'exp' : ''}">${baht(Math.abs(left))}</b></div></div>
        ${budgetBar(spent, bg.amount, ym)}
        <div class="bd-meta"><span>⏳</span><div>1 ${TH_MONTHS_SHORT[m - 1]} – ${dim} ${TH_MONTHS_SHORT[m - 1]} ${y + BE}<div class="muted small">${ym === cur ? `เหลืออีก ${daysLeft} วัน` : ym < cur ? 'สิ้นสุดแล้ว' : 'ยังไม่เริ่ม'}</div></div></div>
        <div class="bd-meta"><span${wImg(w) ? ' class="has-img"' : ''}>${bg.scope === 'shared' ? '🤝' : w ? wFace(w) : '🌐'}</span><div>${bg.scope === 'shared' ? `งบร่วมกับ ${esc(partnerName())}` : w ? esc(w.name) : 'ทุกกระเป๋าเงิน'}</div></div>
      </div>
    </div>
    <div class="card chart-card">
      ${chart}
      <div class="legend"><span><i class="dot bud"></i>ใช้จริงสะสม</span><span><i class="dot exp"></i>งบ ${kbaht(bg.amount)}</span>${proj.length ? '<span><i class="dot avg"></i>คาดการณ์</span>' : ''}</div>
      <div class="kv"><span>ควรใช้ต่อวัน</span><b>${baht(Math.round(recommend * 100) / 100)}</b></div>
      <div class="kv"><span>คาดว่าจะใช้ทั้งเดือน</span><b class="${projected > bg.amount ? 'exp' : ''}">${baht(Math.round(projected * 100) / 100)}</b></div>
      <div class="kv"><span>ใช้จริงเฉลี่ยต่อวัน</span><b>${baht(Math.round(actualDaily * 100) / 100)}</b></div>
    </div>
    ${list.length ? `<div class="section-title">รายการในงบนี้ (${list.length})</div>${dayGroups(list, S)}` : ''}
  `);
}

function budgetForm(bg, preset = {}) {
  const isNew = !bg;
  const d = bg ? { ...bg } : { category: 'food', amount: '', walletId: ui.wallet === 'total' ? 'total' : ui.wallet, scope: 'personal', ...preset };
  const canShare = isCloud() && !!cloud.partner;
  const chips = [['all', ALL_CAT], ...catsOf('expense')].map(([k, c]) =>
    `<button type="button" class="cat ${d.category === k ? 'on' : ''}" data-bcat="${k}">${circleIco(c, 'ico round')}<span>${esc(c.label)}</span></button>`).join('');
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ยกเลิก</button>
      <h2>${isNew ? 'สร้างงบประมาณ' : 'แก้ไขงบประมาณ'}</h2>
      <button class="link-btn strong" id="saveBudget">บันทึก</button>
    </div>
    ${canShare ? `<div class="seg" id="bScope"><button type="button" data-bscope="personal">งบส่วนตัว</button><button type="button" data-bscope="shared">งบร่วมกัน</button></div>` : ''}
    <div class="amount-input"><span>฿</span><input id="bAmount" inputmode="decimal" placeholder="0" value="${d.amount}"></div>
    <div class="section-title">หมวดหมู่</div>
    <div class="cat-grid" id="bCats">${chips}</div>
    <div class="form">
      <div class="field" id="bWalletRow"><label for="bWallet">กระเป๋าเงิน</label><select id="bWallet">
        <option value="total">ทุกกระเป๋าเงิน</option>
        ${money.wallets.map((w) => `<option value="${w.id}" ${d.walletId === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select></div>
      <div class="kv"><span>รอบงบประมาณ</span><span>ทุกเดือน</span></div>
    </div>
    ${isNew ? '' : '<button class="btn danger" id="delBudget">ลบงบประมาณ</button>'}
  `);
  const renderScope = () => {
    document.querySelectorAll('#bScope button').forEach((x) => x.classList.toggle('on', x.dataset.bscope === (d.scope || 'personal')));
    $('#bWalletRow').hidden = d.scope === 'shared';
  };
  renderScope();
  if (canShare) $('#bScope').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bscope]');
    if (b) { d.scope = b.dataset.bscope; renderScope(); }
  });
  $('#bCats').addEventListener('click', (e) => {
    const c = e.target.closest('[data-bcat]');
    if (!c) return;
    d.category = c.dataset.bcat;
    document.querySelectorAll('#bCats .cat').forEach((x) => x.classList.toggle('on', x === c));
  });
  $('#saveBudget').addEventListener('click', () => {
    const amount = num($('#bAmount').value);
    if (!(amount > 0)) { toast('กรุณาใส่จำนวนเงิน'); $('#bAmount').focus(); return; }
    const scope = d.scope === 'shared' ? 'shared' : 'personal';
    const out = { id: d.id || newId(), scope, category: d.category, amount, walletId: scope === 'shared' ? 'total' : $('#bWallet').value };
    const dup = money.budgets.find((x) => x.id !== out.id && (x.scope || 'personal') === scope && x.category === out.category && (x.walletId || 'total') === out.walletId);
    if (dup) { toast('มีงบของหมวดนี้อยู่แล้ว'); return; }
    saveBudget(out); closeSheet(); render(); if (isNew) popIn();
    toast(isNew ? 'สร้างงบประมาณแล้ว' : 'บันทึกแล้ว');
  });
  const del = $('#delBudget');
  if (del) del.addEventListener('click', () => {
    confirmDelete('ลบงบประมาณนี้?', '', () => {
      deleteBudget(d);
      closeSheet(); render(); toast('ลบแล้ว');
    });
  });
  if (isNew) setTimeout(() => $('#bAmount') && $('#bAmount').focus(), 300);
}

/* ---------- Transaction form ---------- */

// Category picker layered over the open sheet: the top-level grid, and a parent with
// sub-categories shows its subs underneath. Picking one calls onPick(id) and closes.
function catPicker(type, current, onPick) {
  const old = $('#catLayer');
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.id = 'catLayer';
  layer.innerHTML = `<div class="sheet-backdrop cat-layer-bg"></div><section class="sheet cat-layer" role="dialog" aria-modal="true">
    <div class="grabber"></div>
    <div class="sheet-head"><button class="link-btn" data-cpclose>ยกเลิก</button><h2>หมวดหมู่</h2><span class="sheet-head-pad"></span></div>
    <div class="cat-grid" id="cpGrid"></div><div class="chips sub-cats" id="cpSubs" hidden></div></section>`;
  document.body.appendChild(layer);
  let root = current ? catRootId(current, type) : '';
  const close = () => layer.remove();
  const paint = () => {
    $('#cpGrid').innerHTML = catsOf(type).map(([k, c]) =>
      `<button type="button" class="cat ${root === k ? 'on' : ''}" data-cp="${k}">${circleIco(c, 'ico round')}<span>${esc(c.label)}</span></button>`).join('');
    const kids = root ? catChildren(root) : [];
    $('#cpSubs').hidden = !kids.length;
    $('#cpSubs').innerHTML = kids.length ? [catById(root), ...kids].map((c, i) =>
      `<button type="button" class="chip sub-pick ${current === c.id ? 'on' : ''}" data-cpsub="${c.id}">${c.icon} ${i ? esc(c.label) : 'ทั่วไป'}</button>`).join('') : '';
  };
  paint();
  layer.addEventListener('click', (e) => {
    if (e.target.closest('[data-cpclose]') || e.target.classList.contains('cat-layer-bg')) return close();
    const sub = e.target.closest('[data-cpsub]');
    if (sub) { onPick(sub.dataset.cpsub); return close(); }
    const top = e.target.closest('[data-cp]');
    if (!top) return;
    // A parent with sub-categories waits for the sub (or ทั่วไป); anything else is picked straight away.
    if (catChildren(top.dataset.cp).length) {
      root = top.dataset.cp;
      paint();
      $('#cpSubs').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else { onPick(top.dataset.cp); close(); }
  });
}

function txnForm(t, preset = {}) {
  const isNew = !t;
  const me = cloud.user ? cloud.user.id : null;
  const canShare = isCloud() && !!cloud.partner;
  const d = t ? { ...t } : {
    type: 'expense', amount: '', category: '', walletId: defaultWalletId(), toWalletId: '',
    date: dateStr(new Date()), note: '', merchant: '', scope: 'personal', ...preset,
  };
  // The form edits the whole bill; a shared row stores my share in `amount` and the bill in `total`.
  if (t && t.scope === 'shared') { d.amount = t.total; d.split = splitOf(t); }
  if (!d.payerId) d.payerId = me;
  if (!d.split) d.split = 'half';
  // Who bears the cost under รับผิดชอบทั้งหมด: the payer, which is me for everything new.
  const fullLabel = d.payerId === me ? 'รับผิดชอบทั้งหมด' : `${esc(partnerName())} รับผิดชอบทั้งหมด`;
  if (d.scope === 'shared' && !canShare) d.scope = 'personal';
  const receipts = isCloud() && cloud.features.storage;
  const wOpts = (selId, skip) => money.wallets.filter((w) => w.id !== skip)
    .map((w) => `<option value="${w.id}" ${selId === w.id ? 'selected' : ''}>${esc(wEmoji(w))} ${esc(w.name)}</option>`).join('');

  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ยกเลิก</button>
      <h2>${isNew ? 'เพิ่มรายการ' : 'แก้ไขรายการ'}</h2>
      <button class="link-btn strong" id="saveTx">บันทึก</button>
    </div>
    <div class="seg" id="txType">
      <button type="button" data-ttype="expense">รายจ่าย</button>
      <button type="button" data-ttype="income">รายรับ</button>
      <button type="button" data-ttype="transfer">โอนเงิน</button>
    </div>
    ${canShare ? `<div class="scope-row" id="txScope">
      <button type="button" data-scope="personal">ส่วนตัว</button>
      <button type="button" data-scope="shared" class="scope-partner" aria-label="ร่วมกับ ${esc(partnerName())}">${userAvatar({ name: partnerName(), avatar: cloud.partner.avatar }, 'scope-av')}<span>${esc(partnerName())}</span></button>
    </div>` : ''}
    ${receipts ? `<div class="section-title">✨ AI Slips</div>
    <p class="hint">อัปโหลดสลิป แล้ว AI จะกรอกหมวด ยอดเงิน และวันที่โอนให้ ตรวจแก้ได้ก่อนบันทึก</p>
    <div class="receipt-row">
      <button type="button" class="scan-btn" id="rcScan">${SCAN_ICON}<span class="scan-text">สแกนสลิป</span></button>
      ${d.receiptKey ? '<button type="button" class="chip" id="rcView">🧾 ดูสลิป</button>' : ''}
      <!-- No capture attribute: iOS then offers camera or photo library from one button. -->
      <input type="file" id="rcIn" accept="image/*" hidden>
    </div><div id="rcStatus"></div>` : ''}
    <div class="amount-input" id="tAmtWrap"><span>฿</span><input id="tAmount" inputmode="decimal" placeholder="0" value="${d.amount}"></div>
    <div id="tCatWrap"><button type="button" class="cat-pick-btn" id="tCatOpen"></button></div>
    <div class="form">
      <div class="field" id="tMerchRow"><label for="tMerchant">ร้านค้า / ผู้รับ</label><input id="tMerchant" placeholder="เช่น 7-Eleven" value="${esc(d.merchant || '')}" autocomplete="off"></div>
      <div id="tShareRows">
        <div class="field col"><label>ต้นทุน</label>
          <div class="seg" id="tSplit"><button type="button" data-split="full">${fullLabel}</button><button type="button" data-split="half">หาร 2</button></div></div>
        <div class="kv"><span>ส่วนของฉัน</span><b id="tMine">-</b></div>
      </div>
      <div class="field" id="tWalletRow"><label for="tWallet" id="tWalletLab">กระเป๋าเงิน</label><select id="tWallet">${wOpts(d.walletId || defaultWalletId())}</select></div>
      <div class="field" id="tToRow"><label for="tTo">ไปยัง</label><select id="tTo"></select></div>
      <div class="field"><label for="tDate">วันที่</label><input type="date" id="tDate" value="${d.date}"></div>
      <div class="field"><label for="tNote">บันทึก</label><input id="tNote" placeholder="เช่น ข้าวกลางวัน" value="${esc(d.note || '')}" autocomplete="off"></div>
      <div class="field col labels-field"><label>ป้ายกำกับ</label><div class="chips lab-pick" id="tLabels"></div></div>
    </div>
    <p class="hint" id="tShareHint">บันทึกให้ ${esc(partnerName())} เห็นเท่านั้น ไม่ใช่การเรียกเก็บเงิน ต้นทุนใช้คำนวณส่วนของฉันในยอดรวมและรายงาน</p>
    ${d.billId ? '<p class="hint">รายการนี้สร้างจากการจ่ายบิล</p>' : ''}
    ${isNew ? '' : '<button class="btn danger" id="delTx">ลบรายการ</button>'}
  `);

  const shared = () => d.scope === 'shared' && d.type === 'expense';
  const myShare = (total) => (d.split === 'full' ? (d.payerId === me ? total : 0) : Math.round((total / 2) * 100) / 100);
  const updateShares = () => {
    if (!shared()) return;
    document.querySelectorAll('#tSplit button').forEach((x) => x.classList.toggle('on', x.dataset.split === d.split));
    $('#tMine').textContent = baht(myShare(num($('#tAmount').value) || 0));
  };
  const renderType = () => {
    document.querySelectorAll('#txType button').forEach((x) => x.classList.toggle('on', x.dataset.ttype === d.type));
    document.querySelectorAll('#txScope button').forEach((x) => x.classList.toggle('on', x.dataset.scope === d.scope));
    if ($('#txScope')) $('#txScope').hidden = d.type !== 'expense';
    $('#tAmtWrap').className = `amount-input ${d.type === 'income' ? 'inc' : d.type === 'expense' ? 'exp' : ''}`;
    const transfer = d.type === 'transfer';
    const sh = shared();
    $('#tCatWrap').hidden = transfer;
    $('#tMerchRow').hidden = transfer;
    $('#tToRow').hidden = !transfer;
    $('#tShareRows').hidden = !sh;
    $('#tShareHint').hidden = !sh;
    // The wallet only matters when I am the one paying.
    $('#tWalletRow').hidden = sh && d.payerId !== me;
    $('#tWalletLab').textContent = transfer ? 'จาก' : sh ? 'จ่ายจาก' : 'กระเป๋าเงิน';
    updateShares();
    if (transfer) {
      const from = $('#tWallet').value;
      if (!d.toWalletId || d.toWalletId === from) d.toWalletId = (money.wallets.find((w) => w.id !== from) || {}).id || '';
      $('#tTo').innerHTML = wOpts(d.toWalletId, from);
      return;
    }
    if (d.category) {
      const c = catById(d.category);
      d.category = c && c.type === d.type ? c.id : catsOf(d.type)[0][0];
    }
    paintCats();
  };
  // The form shows one round button: "?" until a category is picked, then its icon and name.
  // Tapping it opens the category picker on top of this sheet.
  const paintCats = () => {
    const c = d.category ? catById(d.category) : null;
    const root = c ? catRootId(c.id, d.type) : '';
    const parent = c && root !== c.id ? catById(root) : null;
    $('#tCatOpen').classList.toggle('on', !!c);
    $('#tCatOpen').innerHTML = (c ? circleIco(c, 'ico round') : '<span class="ico round q">?</span>')
      + `<span class="cp-name">${parent ? `<small>${esc(parent.label)}</small>` : ''}<b>${c ? esc(c.label) : 'หมวดหมู่'}</b></span><span class="chev">›</span>`;
  };
  renderType();
  const pickedLabels = new Set(d.labels || []);
  const repaintLabels = labelPicker($('#tLabels'), pickedLabels);

  $('#txType').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ttype]');
    if (!b) return;
    d.type = b.dataset.ttype;
    renderType();
  });
  if ($('#txScope')) $('#txScope').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    d.scope = b.dataset.scope;
    renderType();
  });
  $('#tCatOpen').addEventListener('click', () => catPicker(d.type, d.category, (id) => { d.category = id; paintCats(); }));
  $('#tAmount').addEventListener('input', updateShares);
  $('#tSplit').addEventListener('click', (e) => {
    const b = e.target.closest('[data-split]');
    if (!b) return;
    d.split = b.dataset.split;
    updateShares();
  });
  $('#tWallet').addEventListener('change', () => { if (d.type === 'transfer') renderType(); });
  $('#tTo').addEventListener('change', (e) => { d.toWalletId = e.target.value; });

  if (receipts) {
    const status = (html) => { $('#rcStatus').innerHTML = html ? `<p class="hint rc-status">${html}</p>` : ''; };
    const onFile = async (file) => {
      if (!file) return;
      status('⏳ กำลังอัปโหลดและอ่านสลิป…');
      try {
        const r = await uploadReceipt(file, money.labels.map((l) => l.name), slipCats());
        d.receiptKey = r.key;
        const x = r.result;
        if (x) {
          if (x.amount) $('#tAmount').value = x.amount;
          if (x.date) $('#tDate').value = x.date;
          if (x.merchant) $('#tMerchant').value = x.merchant;
          if (x.note && !$('#tNote').value) $('#tNote').value = x.note;
          if (x.reference) d.slipRef = x.reference;
          // AI Slips suggests existing labels by name; they are added, never removed.
          (x.labels || []).forEach((n) => { const l = money.labels.find((y) => y.name === n); if (l) pickedLabels.add(l.id); });
          repaintLabels();
          d.type = 'expense';
          d.category = x.category || null;
          renderType();
        }
        status({
          ok: '✅ อ่านสลิปแล้ว ตรวจสอบข้อมูลอีกครั้งก่อนบันทึก',
          needs_review: '⚠️ อ่านได้ไม่ครบหรือไม่ทราบวัตถุประสงค์ของการโอน กรุณาตรวจสอบและเลือกหมวดหมู่',
          failed: '⚠️ อ่านสลิปไม่สำเร็จ แนบรูปไว้แล้ว กรุณากรอกข้อมูลเอง',
          skipped: '🧾 แนบรูปแล้ว (ยังไม่ได้เปิดการอ่านสลิปอัตโนมัติ)',
        }[r.status] || '🧾 แนบรูปแล้ว');
      } catch (e) {
        status('❌ อัปโหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง');
      }
    };
    $('#rcScan').addEventListener('click', () => $('#rcIn').click());
    $('#rcIn').addEventListener('change', (e) => { onFile(e.target.files[0]); e.target.value = ''; });
    if ($('#rcView')) $('#rcView').addEventListener('click', () => openReceipt(d.receiptKey));
  }

  const save = () => {
    const total = num($('#tAmount').value);
    if (!(total > 0)) { toast('กรุณาใส่จำนวนเงิน'); $('#tAmount').focus(); return; }
    const date = $('#tDate').value;
    if (!date) { toast('กรุณาเลือกวันที่'); return; }
    const out = {
      id: d.id || newId(), type: d.type, amount: total, walletId: $('#tWallet').value, date, note: $('#tNote').value.trim(),
      scope: 'personal', labels: money.labels.filter((l) => pickedLabels.has(l.id)).map((l) => l.id),
    };
    if (d.type === 'transfer') {
      out.toWalletId = $('#tTo').value;
      if (!out.toWalletId || out.toWalletId === out.walletId) { toast('เพิ่มกระเป๋าเงินอีกใบเพื่อโอนเงิน'); return; }
    } else {
      out.category = d.category || null;
      out.merchant = $('#tMerchant').value.trim();
      out.reviewNeeded = false;
      if (d.receiptKey) out.receiptKey = d.receiptKey;
      if (d.slipRef) out.slipRef = d.slipRef;
    }
    if (d.billId) { out.billId = d.billId; out.billYm = d.billYm; }
    if (shared()) {
      // A record for my partner to see, counted straight away; the split only sets each person's cost.
      const mine = myShare(total);
      const payerMe = d.payerId === me;
      Object.assign(out, {
        scope: 'shared', total, amount: mine, payerId: d.payerId, ownerId: me, walletId: payerMe ? out.walletId : null,
        walletAmount: payerMe ? total : 0, counted: true, status: 'approved',
        shares: { [me]: mine, [cloud.partner.id]: Math.round((total - mine) * 100) / 100 },
      });
    }
    saveTxn(out);
    if (out.walletId && money.prefs.lastWallet !== out.walletId) { money.prefs.lastWallet = out.walletId; savePrefs(); }
    closeSheet(); render(); if (isNew) popIn();
    toast(out.scope === 'shared' ? `บันทึกแล้ว ${partnerName()} จะเห็นรายการนี้` : isNew ? 'เพิ่มรายการแล้ว' : 'บันทึกแล้ว');
  };
  $('#saveTx').addEventListener('click', save);
  const del = $('#delTx');
  if (del) del.addEventListener('click', () => {
    confirmDelete('ลบรายการนี้?', '', () => {
      deleteTxn(d);
      closeSheet(); render(); toast('ลบแล้ว');
    });
  });
  if (isNew && !preset.amount) setTimeout(() => $('#tAmount') && $('#tAmount').focus(), 300);
}

/* ---------- Wallets ---------- */

const WALLET_EMOJIS = ['💵', '🏦', '💳', '📱', '🐷', '📈', '👛', '💰', '🪙', '💎', '🛒', '🏠', '🚗', '✈️', '🎓', '❤️', '⭐', '🟢', '🔵', '🟣', '🟠', '🔴'];

// Center-crops a picked photo or logo to a small square data URL that fits in the wallet record
// (it syncs with the wallet, so it stays a few KB). PNG keeps logo transparency; photos use JPEG.
async function squareImage(file, size = 160) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('empty');
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const draw = () => g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    draw();
    const png = cv.toDataURL('image/png');
    if (png.length <= 60000) return png;
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); draw();
    return cv.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

function walletSheet(mode = 'pick') {
  const row = (w) => `
    <button class="item" ${mode === 'pick' ? `data-wallet-sel="${w ? w.id : 'total'}"` : w ? `data-wallet-edit="${w.id}"` : ''}>
      ${walletIco(w)}
      <div class="main"><div class="name">${esc(w ? w.name : 'ยอดรวม')}</div><div class="sub">${masked(sbaht(balanceOf(w ? w.id : 'total')))}</div></div>
      ${mode === 'pick' && ui.wallet === (w ? w.id : 'total') ? '<span class="tick">✓</span>' : ''}
      ${mode === 'edit' && w ? svgIcon('chev', 'svg-i sm muted') : ''}
    </button>`;
  const inc = money.wallets.filter((w) => !w.excluded);
  const exc = money.wallets.filter((w) => w.excluded);
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>${mode === 'pick' ? 'เลือกกระเป๋าเงิน' : 'กระเป๋าเงิน'}</h2>
      <button class="link-btn" data-action="${mode === 'pick' ? 'wallets' : 'wallet-pick'}">${mode === 'pick' ? 'แก้ไข' : 'เสร็จ'}</button>
    </div>
    ${mode === 'pick' ? `<div class="list" style="margin-bottom:14px">${row(null)}</div>` : ''}
    <div class="section-title">รวมในยอดรวม</div>
    <div class="list">${inc.map(row).join('') || '<div class="muted pad">-</div>'}</div>
    ${exc.length ? `<div class="section-title">ไม่รวมในยอดรวม</div><div class="list">${exc.map(row).join('')}</div>` : ''}
    <div class="list" style="margin-top:18px">
      <button class="item add-row" data-action="add-wallet"><span class="plus">＋</span><div class="main"><div class="name">เพิ่มกระเป๋าเงิน</div></div></button>
    </div>
  `);
}

function walletForm(w) {
  const isNew = !w;
  const d = w ? { ...w } : { name: '', type: 'bank', initial: '', excluded: false, icon: '' };
  const emojis = WALLET_EMOJIS.map((e) => `<button type="button" class="chip emoji" data-wemoji="${e}">${e}</button>`).join('');
  const chips = Object.entries(WALLET_TYPES).map(([k, c]) =>
    `<button type="button" class="chip ${d.type === k ? 'on' : ''}" data-wtype="${k}">${c.icon} ${c.label}</button>`).join('');
  const used = w && money.txns.some((t) => t.walletId === w.id || t.toWalletId === w.id);
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ยกเลิก</button>
      <h2>${isNew ? 'เพิ่มกระเป๋าเงิน' : 'แก้ไขกระเป๋าเงิน'}</h2>
      <button class="link-btn strong" id="saveWallet">บันทึก</button>
    </div>
    <div class="w-pic">
      <button type="button" class="w-avatar" id="wAvatar" aria-label="เปลี่ยนรูป"></button>
      <div class="w-pic-actions">
        <button type="button" class="chip" id="wPhoto">📷 เลือกรูป</button>
        <button type="button" class="chip" id="wEmojiBtn">😀 อีโมจิ</button>
        <button type="button" class="chip" id="wReset" hidden>ใช้ไอคอนประเภท</button>
      </div>
      <input type="file" id="wFile" accept="image/*" hidden>
    </div>
    <div class="chips w-emojis" id="wEmojis" hidden>${emojis}<input id="wEmojiIn" class="chip" placeholder="พิมพ์เอง" maxlength="8" autocomplete="off"></div>
    <div class="chips" id="wTypes">${chips}</div>
    <div class="form">
      <div class="field"><label for="wName">ชื่อ</label><input id="wName" placeholder="เช่น KBank ออมทรัพย์" value="${esc(d.name)}" autocomplete="off"></div>
      <div class="field"><label for="wInit">ยอดเริ่มต้น (฿)</label><input id="wInit" inputmode="decimal" placeholder="0" value="${d.initial === '' ? '' : d.initial}"></div>
      <div class="field"><label for="wExcl">ไม่รวมในยอดรวม</label><span style="flex:1"></span><label class="switch"><input type="checkbox" id="wExcl" ${d.excluded ? 'checked' : ''}><span></span></label></div>
    </div>
    <p class="hint">บัตรเครดิตที่มียอดค้างชำระ ให้ใส่ยอดเริ่มต้นเป็นค่าติดลบ เช่น -12000</p>
    ${isNew ? '' : `<button class="btn danger" id="delWallet">ลบกระเป๋าเงิน${used ? 'และรายการทั้งหมด' : ''}</button>`}
  `);
  $('#wTypes').addEventListener('click', (e) => {
    const c = e.target.closest('[data-wtype]');
    if (!c) return;
    d.type = c.dataset.wtype;
    document.querySelectorAll('#wTypes .chip').forEach((x) => x.classList.toggle('on', x === c));
    paintPic();
  });
  const paintPic = () => {
    $('#wAvatar').innerHTML = walletIco(d, 'w-avatar-in') + '<span class="w-cam">✎</span>';
    $('#wReset').hidden = !d.icon;
    document.querySelectorAll('#wEmojis [data-wemoji]').forEach((x) => x.classList.toggle('on', x.dataset.wemoji === d.icon));
  };
  paintPic();
  $('#wAvatar').addEventListener('click', () => $('#wFile').click());
  $('#wPhoto').addEventListener('click', () => $('#wFile').click());
  $('#wEmojiBtn').addEventListener('click', () => { $('#wEmojis').hidden = !$('#wEmojis').hidden; });
  $('#wReset').addEventListener('click', () => { d.icon = ''; $('#wEmojiIn').value = ''; paintPic(); });
  $('#wEmojis').addEventListener('click', (e) => {
    const c = e.target.closest('[data-wemoji]');
    if (c) { d.icon = c.dataset.wemoji; $('#wEmojiIn').value = ''; paintPic(); }
  });
  $('#wEmojiIn').addEventListener('input', (e) => {
    const v = e.target.value.trim().replace(/[<>&"']/g, '');
    if (v) { d.icon = [...v].slice(0, 4).join(''); paintPic(); }
  });
  $('#wFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { d.icon = await squareImage(f); paintPic(); } catch { toast('เปิดรูปนี้ไม่ได้'); }
  });
  $('#saveWallet').addEventListener('click', () => {
    const name = $('#wName').value.trim();
    if (!name) { toast('กรุณาใส่ชื่อกระเป๋าเงิน'); $('#wName').focus(); return; }
    const raw = $('#wInit').value.trim();
    const initial = raw.startsWith('-') ? -num(raw.slice(1)) : num(raw);
    const out = { id: d.id || uid(), name, type: d.type, initial, excluded: $('#wExcl').checked };
    if (d.icon) out.icon = d.icon;
    saveWallet(out); render(); walletSheet('edit');
    toast(isNew ? 'เพิ่มกระเป๋าเงินแล้ว' : 'บันทึกแล้ว');
  });
  const del = $('#delWallet');
  if (del) del.addEventListener('click', () => {
    if (money.wallets.length <= 1) { toast('ต้องมีกระเป๋าเงินอย่างน้อย 1 ใบ'); return; }
    confirmDelete(`ลบ "${w.name}"?`, used ? 'รายการทั้งหมดของกระเป๋านี้จะถูกลบด้วย' : '', () => {
      deleteWallet(w);
      if (ui.wallet === w.id) ui.wallet = 'total';
      if (money.prefs.billWallet === w.id) { delete money.prefs.billWallet; savePrefs(); }
      render(); walletSheet('edit'); toast('ลบแล้ว');
    });
  });
  if (isNew) setTimeout(() => $('#wName') && $('#wName').focus(), 300);
}

/* ---------- Labels ---------- */

// Toggleable label chips plus a "new label" box, drawn into `box`. `picked` is a Set
// of label ids that the chips change in place; onChange runs after each change.
// Returns a function that redraws.
function labelPicker(box, picked, onChange = () => {}) {
  const paint = () => {
    box.innerHTML = money.labels.map((l) =>
      `<button type="button" class="chip lab ${picked.has(l.id) ? 'on' : ''}" data-lpick="${esc(l.id)}">${svgIcon('tag', 'svg-i xs')}${esc(l.name)}</button>`).join('')
      + '<input class="chip lab-new" placeholder="＋ ป้ายใหม่" maxlength="60" autocomplete="off" enterkeyhint="done">';
    const input = box.querySelector('.lab-new');
    const add = () => {
      const name = input.value.trim();
      input.value = '';
      if (!name) return;
      let l = money.labels.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!l) { l = { id: newId(), name }; saveLabel(l); }
      picked.add(l.id);
      paint();
      onChange();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    input.addEventListener('blur', add);
  };
  box.addEventListener('click', (e) => {
    const c = e.target.closest('[data-lpick]');
    if (!c) return;
    const id = c.dataset.lpick;
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    c.classList.toggle('on', picked.has(id));
    onChange();
  });
  paint();
  return paint;
}

// How a label is used: like "15 รายการ ใน 2 กระเป๋า".
function labelUse(l) {
  const list = money.txns.filter((t) => (t.labels || []).includes(l.id));
  const wallets = new Set(list.map((t) => t.walletId).filter(Boolean));
  return { list, n: list.length, wallets: wallets.size };
}

function labelsSheet() {
  const rows = money.labels.map((l) => {
    const u = labelUse(l);
    return `
      <div class="item lab-row">
        <button class="lab-open" data-label-open="${esc(l.id)}">
          <span class="lab-tag">${svgIcon('tag')}</span>
          <div class="main"><div class="name">${esc(l.name)}</div>${u.n ? `<div class="sub">${u.n} รายการ ใน ${u.wallets || 1} กระเป๋า</div>` : ''}</div>
        </button>
        <button class="round-btn sm" data-label-menu="${esc(l.id)}" aria-label="ตัวเลือก">${svgIcon('more')}</button>
      </div>`;
  }).join('');
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>ป้ายกำกับ</h2><button class="link-btn strong" data-action="add-label">เพิ่ม</button></div>
    ${money.labels.length ? `<div class="list">${rows}</div>` : `<div class="empty"><div class="e-ico">🏷️</div>ยังไม่มีป้ายกำกับ<br><span class="muted small">ใช้จัดกลุ่มรายการข้ามหมวดหมู่ เช่น Grabfood, Shopee, ทริปเชียงใหม่</span></div>`}
    <div class="list" style="margin-top:18px">
      <button class="item add-row" data-action="add-label"><span class="plus">＋</span><div class="main"><div class="name">เพิ่มป้ายกำกับ</div></div></button>
    </div>
    <p class="hint">ติดป้ายได้หลายป้ายต่อรายการ ในหน้าเพิ่ม/แก้ไขรายการ${isCloud() ? ' ป้ายกำกับซิงก์กับบัญชีของคุณทุกเครื่อง' : ''}</p>
  `);
}

function labelMenu(id) {
  const l = labelById(id);
  if (!l) return;
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="labels">กลับ</button><h2>${esc(l.name)}</h2><span style="width:40px"></span></div>
    <div class="list">
      <button class="item" data-label-open="${esc(l.id)}">${circleIco({ icon: '📋', color: '#2f6bff' })}<div class="main"><div class="name">ดูรายการ</div></div></button>
      <button class="item" data-txlabel="${esc(l.id)}">${circleIco({ icon: '🔎', color: '#1a9e5c' })}<div class="main"><div class="name">กรองในหน้ารายการ</div></div></button>
      <button class="item" id="lbRename">${circleIco({ icon: '✏️', color: '#8a8f99' })}<div class="main"><div class="name">เปลี่ยนชื่อ</div></div></button>
      <button class="item" id="lbDelete">${circleIco({ icon: '🗑️', color: '#e5484d' })}<div class="main"><div class="name exp">ลบป้ายกำกับ</div></div></button>
    </div>`);
  $('#lbRename').addEventListener('click', () => labelForm(l));
  $('#lbDelete').addEventListener('click', () => labelDelete(l));
}

function labelDelete(l) {
  const n = labelUse(l).n;
  confirmDelete(`ลบป้าย "${l.name}"?`, n ? `ป้ายนี้จะถูกนำออกจาก ${n} รายการ (รายการยังอยู่)` : '', () => {
    deleteLabel(l);
    render(); labelsSheet(); toast('ลบแล้ว');
  });
}

function labelForm(l) {
  const isNew = !l;
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="labels">ยกเลิก</button>
      <h2>${isNew ? 'เพิ่มป้ายกำกับ' : 'เปลี่ยนชื่อป้าย'}</h2>
      <button class="link-btn strong" id="saveLabel">บันทึก</button>
    </div>
    <form class="form" id="lbForm"><div class="field"><label for="lbName">ชื่อ</label><input id="lbName" maxlength="60" placeholder="เช่น Grabfood" value="${esc(l ? l.name : '')}" autocomplete="off"></div></form>
    ${isNew ? '' : '<button class="btn danger" id="lbDel">ลบป้ายกำกับ</button>'}
  `);
  const save = (e) => {
    if (e) e.preventDefault();
    const name = $('#lbName').value.trim();
    if (!name) { toast('กรุณาใส่ชื่อป้าย'); $('#lbName').focus(); return; }
    if (money.labels.some((x) => x.name.toLowerCase() === name.toLowerCase() && (!l || x.id !== l.id))) { toast('มีป้ายชื่อนี้แล้ว'); return; }
    saveLabel({ ...(l || { id: newId() }), name });
    render(); labelsSheet(); if (isNew) popIn();
    toast(isNew ? 'เพิ่มป้ายกำกับแล้ว' : 'บันทึกแล้ว');
  };
  $('#saveLabel').addEventListener('click', save);
  $('#lbForm').addEventListener('submit', save);
  if ($('#lbDel')) $('#lbDel').addEventListener('click', () => labelDelete(l));
  setTimeout(() => $('#lbName') && $('#lbName').focus(), 300);
}

// All transactions with one label, with totals and a per-month summary.
function labelDetail(id) {
  const l = labelById(id);
  if (!l) return;
  const S = walletSet('total');
  const { list } = labelUse(l);
  const counted = list.filter((t) => t.type !== 'transfer' && counts(t));
  const { income, expense } = totalsIn(counted, S);
  const ym = ymOf(new Date());
  const month = totalsIn(counted.filter((t) => t.date.slice(0, 7) === ym), S);
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="labels">กลับ</button><h2>${esc(l.name)}</h2><button class="round-btn sm" data-label-menu="${esc(l.id)}" aria-label="ตัวเลือก">${svgIcon('more')}</button></div>
    <div class="card summary">
      <div class="row" style="margin-top:0">
        <div class="stat exp-soft"><span>รายจ่ายทั้งหมด</span><b class="exp">${baht(expense)}</b></div>
        <div class="stat inc-soft"><span>รายรับทั้งหมด</span><b class="inc">${baht(income)}</b></div>
      </div>
      <div class="kv" style="padding:12px 2px 0"><span>เดือนนี้</span><b>${month.expense ? `จ่าย ${baht(month.expense)}` : ''}${month.expense && month.income ? ' · ' : ''}${month.income ? `รับ ${baht(month.income)}` : ''}${month.expense || month.income ? '' : '-'}</b></div>
      <div class="kv" style="padding:6px 2px 0"><span>จำนวน</span><span>${list.length} รายการ</span></div>
    </div>
    ${list.length ? `<button class="btn ghost" data-txlabel="${esc(l.id)}" style="margin-bottom:12px">กรองในหน้ารายการ</button>${dayGroups(list, S)}`
    : '<div class="empty"><div class="e-ico">🏷️</div>ยังไม่มีรายการที่ติดป้ายนี้</div>'}
  `);
}

function labelFilterSheet() {
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>กรองตามป้ายกำกับ</h2><button class="link-btn" data-action="labels">แก้ไข</button></div>
    <div class="list">
      <button class="item" data-txlabel=""><span class="lab-tag">${svgIcon('tag')}</span><div class="main"><div class="name">ทุกรายการ</div></div>${ui.txLabel ? '' : '<span class="tick">✓</span>'}</button>
      ${money.labels.map((l) => `<button class="item" data-txlabel="${esc(l.id)}"><span class="lab-tag">${svgIcon('tag')}</span>
        <div class="main"><div class="name">${esc(l.name)}</div><div class="sub">${labelUse(l).n} รายการ</div></div>${ui.txLabel === l.id ? '<span class="tick">✓</span>' : ''}</button>`).join('')}
    </div>`);
}

/* ---------- Categories (settings) ---------- */

const CAT_ICONS = ['🍴', '🍜', '☕', '🧋', '🍺', '🍸', '🛒', '👕', '👟', '👜', '💄', '✂️', '🏠', '🛏️', '🧹', '💡', '💧', '🔥', '📞', '🌐', '📺',
  '💳', '🚗', '⛽', '🚕', '🚇', '✈️', '🏨', '🩺', '💊', '🏋️', '⚽', '🎮', '🎬', '🎵', '📚', '🎓', '🐶', '🐱', '🐾', '🧸', '👶', '🎁', '🧡', '🙏',
  '📱', '💻', '🏛️', '🛡️', '🏦', '📈', '💰', '💵', '🎉', '📦', '🤝', '🧾', '🏷️'];
const CAT_COLORS = ['#a8844f', '#d98a2b', '#f0a92e', '#b8a12a', '#3fae8c', '#4fb3ad', '#3d8fe0', '#2f6bff', '#5b6a8f',
  '#7d7aa8', '#9b59b6', '#d0507f', '#d9534f', '#c97a2b', '#7a7f88', '#1a9e5c'];

function setCats(list) {
  money.prefs.cats = list;
  savePrefs();
}
function newCatId() { return `c_${Math.random().toString(36).slice(2, 10)}`; }
// How many transactions sit in a category itself (not its subs).
function catUseCount(id) { return money.txns.filter((t) => t.category && t.type !== 'transfer' && catResolve(t.category) === id).length; }

function catsSheet() {
  const type = ui.catType || 'expense';
  const row = (c, kid) => {
    const n = catUseCount(c.id);
    return `<div class="item cat-row ${kid ? 'kid' : ''}" data-sort="${c.id}">
      <button class="cat-open" data-cat-edit="${c.id}">${circleIco(c)}<div class="main"><div class="name">${esc(c.label)}</div>${n ? `<div class="sub">${n} รายการ</div>` : ''}</div></button>
      <span class="drag-h" aria-label="ลากเพื่อเรียง">${svgIcon('menu')}</span></div>`;
  };
  const groups = catsOf(type).map(([id, c]) => {
    const kids = catChildren(id);
    return `<div class="list cat-group" data-sort="${id}">${row(c, false)}${kids.length ? `<div class="cat-kids">${kids.map((k) => row(k, true)).join('')}</div>` : ''}</div>`;
  }).join('');
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>หมวดหมู่</h2><button class="link-btn strong" data-action="add-cat">เพิ่ม</button></div>
    <div class="seg" id="catType"><button type="button" data-ctype="expense" class="${type === 'expense' ? 'on' : ''}">รายจ่าย</button><button type="button" data-ctype="income" class="${type === 'income' ? 'on' : ''}">รายรับ</button></div>
    <div class="cat-tree" id="catTree">${groups}</div>
    <div class="list" style="margin-top:14px">
      <button class="item add-row" data-action="add-cat"><span class="plus">＋</span><div class="main"><div class="name">เพิ่มหมวดหมู่</div></div></button>
    </div>
    <p class="hint">ลาก ☰ เพื่อเรียงลำดับ แตะหมวดเพื่อแก้ชื่อ ไอคอน สี หรือเพิ่มหมวดย่อย${isCloud() ? ' หมวดหมู่ซิงก์กับบัญชีของคุณทุกเครื่อง' : ''}</p>
  `);
  $('#catType').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctype]');
    if (!b || b.dataset.ctype === type) return;
    ui.catType = b.dataset.ctype;
    catsSheet();
  });
  sortable($('#catTree'), () => {
    // The page order is the new order for this type; the other type keeps its own.
    const ids = [...$('#catTree').querySelectorAll('.cat-row[data-sort]')].map((x) => x.dataset.sort);
    setCats([...catList().filter((c) => c.type !== type), ...ids.map((id) => catMap().get(id))]);
    render();
  });
}

// Drag rows by their .drag-h handle among their siblings (the [data-sort] children of one parent).
function sortable(box, onDone) {
  box.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.drag-h');
    if (!h) return;
    // A handle belongs to its row; a top-level row drags its whole group.
    let el = h.closest('[data-sort]');
    if (el.parentElement.classList.contains('cat-group')) el = el.parentElement;
    const list = el.parentElement;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const base = el.getBoundingClientRect().top;
    el.classList.add('dragging');
    const move = (ev) => {
      const y = ev.clientY;
      const sibs = [...list.children].filter((x) => x !== el && x.matches('[data-sort]'));
      for (const o of sibs) {
        const r = o.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const before = o.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
        if (before && y < mid) { list.insertBefore(el, o); break; }
        if (!before && y > mid) { list.insertBefore(el, o.nextSibling); break; }
      }
      el.style.transform = '';
      const now = el.getBoundingClientRect().top;
      el.style.transform = `translateY(${y - startY - (now - base)}px)`;
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      el.style.transform = '';
      el.classList.remove('dragging');
      onDone();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
}

function catForm(c, preset = {}) {
  const isNew = !c;
  const d = c ? { ...c } : { id: newCatId(), type: preset.type || ui.catType || 'expense', label: '', icon: '🏷️', color: CAT_COLORS[0], parent: preset.parent };
  const fixed = Object.values(CAT_FALLBACK).includes(d.id);
  const kids = isNew ? [] : catChildren(d.id);
  const parents = catsOf(d.type).filter(([id]) => id !== d.id && !Object.values(CAT_FALLBACK).includes(id));
  const back = d.parent && preset.parent ? `data-cat-edit="${d.parent}"` : 'data-action="categories"';
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" ${back}>ยกเลิก</button>
      <h2>${isNew ? (d.parent ? 'เพิ่มหมวดย่อย' : 'เพิ่มหมวดหมู่') : 'แก้ไขหมวดหมู่'}</h2>
      <button class="link-btn strong" id="saveCat">บันทึก</button>
    </div>
    <div class="cat-preview" id="cfPreview"></div>
    <form class="form" id="cfForm">
      <div class="field"><label for="cfName">ชื่อ</label><input id="cfName" maxlength="40" placeholder="เช่น Water Bill" value="${esc(d.label)}" autocomplete="off"></div>
      <div class="field"><label for="cfIcon">ไอคอน</label><input id="cfIcon" maxlength="16" value="${esc(d.icon)}" autocomplete="off" style="text-align:right"></div>
      ${fixed || kids.length ? '' : `<div class="field"><label for="cfParent">อยู่ใต้หมวด</label><select id="cfParent">
        <option value="">ไม่มี (เป็นหมวดหลัก)</option>
        ${parents.map(([id, p]) => `<option value="${id}" ${d.parent === id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
      </select></div>`}
    </form>
    <div class="section-title">เลือกไอคอน</div>
    <div class="emoji-grid" id="cfIcons">${CAT_ICONS.map((x) => `<button type="button" data-icon="${x}">${x}</button>`).join('')}</div>
    <div class="section-title">สี</div>
    <div class="swatches" id="cfColors">${CAT_COLORS.map((x) => `<button type="button" data-color="${x}" style="background:${x}" aria-label="${x}"></button>`).join('')}</div>
    ${isNew || d.parent ? '' : `
      <div class="section-title">หมวดย่อย</div>
      <div class="list">
        ${kids.map((k) => `<button class="item" data-cat-edit="${k.id}">${circleIco(k)}<div class="main"><div class="name">${esc(k.label)}</div></div>${svgIcon('chev', 'svg-i sm muted')}</button>`).join('')}
        ${fixed ? '' : `<button class="item add-row" id="cfAddSub"><span class="plus">＋</span><div class="main"><div class="name">เพิ่มหมวดย่อย</div></div></button>`}
      </div>`}
    ${isNew || fixed ? '' : '<button class="btn danger" id="cfDel" style="margin-top:18px">ลบหมวดหมู่</button>'}
    ${fixed ? '<p class="hint">หมวดนี้ลบไม่ได้ เพราะเป็นที่รวมรายการจากหมวดที่ถูกลบ</p>' : ''}
  `);
  const paint = () => {
    $('#cfPreview').innerHTML = `${circleIco(d, 'ico round big')}<b>${esc($('#cfName').value.trim() || 'ชื่อหมวดหมู่')}</b>`;
    document.querySelectorAll('#cfColors button').forEach((x) => x.classList.toggle('on', x.dataset.color === d.color));
    document.querySelectorAll('#cfIcons button').forEach((x) => x.classList.toggle('on', x.dataset.icon === d.icon));
  };
  paint();
  $('#cfName').addEventListener('input', paint);
  $('#cfIcon').addEventListener('input', (e) => { const v = e.target.value.trim(); if (v && !/[<>&"']/.test(v)) { d.icon = v; paint(); } });
  $('#cfIcons').addEventListener('click', (e) => { const b = e.target.closest('[data-icon]'); if (b) { d.icon = b.dataset.icon; $('#cfIcon').value = d.icon; paint(); } });
  $('#cfColors').addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) { d.color = b.dataset.color; paint(); } });
  const save = (e, then) => {
    if (e) e.preventDefault();
    const label = $('#cfName').value.trim();
    if (!label) { toast('กรุณาใส่ชื่อหมวดหมู่'); $('#cfName').focus(); return false; }
    const out = { id: d.id, type: d.type, label, icon: d.icon, color: d.color };
    const parent = $('#cfParent') ? $('#cfParent').value : d.parent;
    if (parent) out.parent = parent;
    const list = catList();
    setCats(isNew ? [...list, out] : list.map((x) => (x.id === out.id ? out : x)));
    render();
    if (then) then(); else if (out.parent && preset.parent) catForm(catById(out.parent)); else catsSheet();
    toast(isNew ? 'เพิ่มหมวดหมู่แล้ว' : 'บันทึกแล้ว');
    return true;
  };
  $('#saveCat').addEventListener('click', (e) => save(e));
  $('#cfForm').addEventListener('submit', (e) => save(e));
  if ($('#cfAddSub')) $('#cfAddSub').addEventListener('click', () => catForm(null, { type: d.type, parent: d.id }));
  if ($('#cfDel')) $('#cfDel').addEventListener('click', () => catDelete(catById(d.id)));
  if (isNew) setTimeout(() => $('#cfName') && $('#cfName').focus(), 300);
}

// Transactions keep their key; catMoved sends them to the parent (for a sub) or to Others.
function catDelete(c) {
  const target = c.parent || CAT_FALLBACK[c.type];
  const gone = [c.id, ...catChildren(c.id).map((k) => k.id)];
  const n = gone.reduce((s, id) => s + catUseCount(id), 0);
  const budgets = money.budgets.filter((bg) => gone.includes(catResolve(bg.category)));
  const kids = gone.length - 1;
  const text = [
    kids ? `หมวดย่อย ${kids} หมวดจะถูกลบด้วย` : '',
    n ? `${n} รายการจะย้ายไปอยู่ "${catById(target).label}"` : '',
    budgets.length ? `งบประมาณของหมวดนี้ ${budgets.length} รายการจะถูกลบ` : '',
  ].filter(Boolean).join(' · ');
  confirmDelete(`ลบหมวด "${c.label}"?`, text, () => {
    money.prefs.catMoved = { ...(money.prefs.catMoved || {}) };
    gone.forEach((id) => { money.prefs.catMoved[id] = target; });
    budgets.forEach(deleteBudget);
    setCats(catList().filter((x) => !gone.includes(x.id)));
    render(); catsSheet(); toast('ลบแล้ว');
  });
}

/* ---------- Account ---------- */

function accountTop() {
  const ym = ymOf(new Date());
  const { income, expense } = totalsIn(txnsInMonth(ym), walletSet('total'));
  const bw = billPayWallet();
  return `
    <div class="page-head"><div class="ph-row"><h1>บัญชี</h1></div></div>
    ${accountCard()}
    <div class="halves">
      <div class="card"><div class="label">รายรับเดือนนี้</div><b class="inc">${baht(income)}</b></div>
      <div class="card"><div class="label">รายจ่ายเดือนนี้</div><b class="exp">${baht(expense)}</b></div>
    </div>
    <div class="section-title">กระเป๋าเงิน</div>
    <div class="list">
      ${money.wallets.map((w) => `<button class="item" data-wallet-edit="${w.id}">${walletIco(w)}<div class="main"><div class="name">${esc(w.name)}</div><div class="sub">${wType(w).label}${w.excluded ? ' · ไม่รวมในยอดรวม' : ''}</div></div><div class="right"><div class="amt">${masked(sbaht(balanceOf(w.id)))}</div></div></button>`).join('')}
      <button class="item add-row" data-action="add-wallet"><span class="plus">＋</span><div class="main"><div class="name">เพิ่มกระเป๋าเงิน</div></div></button>
    </div>
    <div class="section-title">หมวดหมู่และป้ายกำกับ</div>
    <div class="list">
      <button class="item" data-action="categories">${circleIco({ icon: '🗂️', color: '#2f6bff' })}<div class="main"><div class="name">หมวดหมู่</div>
        <div class="sub">แก้ไข เรียงลำดับ และหมวดย่อย</div></div><span class="muted">${catList().filter((c) => c.type === 'expense' && !c.parent).length}</span>${svgIcon('chev', 'svg-i sm muted')}</button>
      <button class="item" data-action="labels"><div class="ico round lab-ico">${svgIcon('tag')}</div><div class="main"><div class="name">ป้ายกำกับ</div>
        <div class="sub">${money.labels.length ? money.labels.slice(0, 4).map((l) => esc(l.name)).join(', ') + (money.labels.length > 4 ? ` และอีก ${money.labels.length - 4}` : '') : 'ติดป้ายให้รายการ เช่น Grabfood, Shopee'}</div></div>${svgIcon('chev', 'svg-i sm muted')}</button>
    </div>
    <div class="section-title">การจ่ายบิล</div>
    <div class="form">
      <div class="field"><label for="billWallet">บันทึกรายจ่ายจาก</label><select id="billWallet">
        <option value="" ${bw === '' ? 'selected' : ''}>ไม่บันทึกเป็นรายการ</option>
        ${money.wallets.map((w) => `<option value="${w.id}" ${bw === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select></div>
    </div>
    <p class="hint">เมื่อกด "จ่ายแล้ว" ที่บิล แอปจะบันทึกเป็นรายจ่ายในกระเป๋าเงินนี้ให้อัตโนมัติ เพื่อให้ยอดเงินและงบประมาณตรงกัน</p>`;
}

/* ---------- Sample data ---------- */

function sampleMoney() {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const wallets = [
    { id: 'cash', name: 'เงินสด', type: 'cash', initial: 2500 },
    { id: uid(), name: 'KBank ออมทรัพย์', type: 'bank', initial: 42000 },
    { id: uid(), name: 'TrueMoney', type: 'ewallet', initial: 300 },
  ];
  const [cash, bank, ew] = wallets.map((w) => w.id);
  const txns = [];
  const add = (date, type, amount, category, walletId, note, extra = {}) =>
    txns.push({ id: uid(), date, type, amount, category, walletId, note, ...extra });
  const t = today();
  const start = new Date(t.getFullYear(), t.getMonth() - 3, 1);
  const foods = [['ข้าวมันไก่', 50], ['กาแฟ', 65, 'coffee'], ['ก๋วยเตี๋ยว', 60], ['ข้าวกล่องเซเว่น', 45], ['ชานมไข่มุก', 55, 'coffee'], ['ส้มตำ', 80]];
  for (let d = new Date(start); d <= t; d.setDate(d.getDate() + 1)) {
    const ds = dateStr(d);
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const [note, base, cat = 'food'] = pick(foods);
      add(ds, 'expense', base + Math.round(rnd() * 4) * 10, cat, pick([cash, cash, ew]), note);
    }
    if (rnd() < 0.3) add(ds, 'expense', 30 + Math.round(rnd() * 8) * 5, 'transport', pick([ew, cash]), pick(['BTS', 'MRT', 'Grab', 'วินมอไซค์']));
    if (rnd() < 0.12) add(ds, 'expense', 300 + Math.round(rnd() * 30) * 50, 'apparel', bank, pick(['Shopee', 'Lazada', 'เสื้อผ้า', 'รองเท้า']));
    if (rnd() < 0.05) add(ds, 'expense', 200 + Math.round(rnd() * 10) * 50, 'hangout', bank, pick(['ดูหนัง', 'คอนเสิร์ต', 'เกม']));
    if (rnd() < 0.04) add(ds, 'expense', 150 + Math.round(rnd() * 10) * 30, 'health', cash, pick(['ร้านยา', 'คลินิก']));
    if (d.getDate() === 25) add(ds, 'income', 38000, 'salary', bank, 'เงินเดือน');
    if (d.getDay() === 1) add(ds, 'transfer', 1500, undefined, bank, 'กดเงินสด', { toWalletId: cash });
    if (d.getDay() === 4) add(ds, 'transfer', 800, undefined, bank, 'เติมเงิน', { toWalletId: ew });
    if (d.getDate() === 15 && rnd() < 0.6) add(ds, 'income', 1200 + Math.round(rnd() * 10) * 100, 'sale', bank, 'ขายของออนไลน์');
  }
  const f1 = new Date(t); f1.setDate(f1.getDate() + 3);
  const f2 = new Date(t); f2.setDate(f2.getDate() + 9);
  add(dateStr(f1), 'expense', 1500, 'baby', bank, 'ของใช้ลูก');
  add(dateStr(f2), 'expense', 890, 'gift', bank, 'ของขวัญวันเกิดเพื่อน');
  const budgets = [
    { id: uid(), category: 'all', amount: 30000, walletId: 'total' },
    { id: uid(), category: 'food', amount: 5000, walletId: 'total' },
    { id: uid(), category: 'apparel', amount: 3000, walletId: 'total' },
    { id: uid(), category: 'transport', amount: 1200, walletId: 'total' },
  ];
  wallets.forEach((w) => { w.name = tr(w.name); });
  txns.forEach((x) => { x.note = tr(x.note); });
  money = { wallets, txns, budgets, labels: money.labels || [], prefs: { ...money.prefs, billWallet: bank } };
  // Bills already paid in the sample show up as expenses from the bank account.
  const ym = ymOf(t);
  occurrences(ym).filter((o) => o.paid).forEach((o) => recordBillTxn(o.bill, ym, o.amount, bank, dateStr(o.due)));
}

/* ---------- Events ---------- */

function moneyClick(t) {
  const tx = t.closest('[data-tx]');
  if (tx) {
    const x = money.txns.find((y) => y.id === tx.dataset.tx);
    if (!x) return true;
    if (x.type === 'settle') settlementsSheet();
    else if (x.scope === 'shared') sharedSheet(x);
    else txnForm(x);
    return true;
  }
  const tl = t.closest('[data-txlabel]');
  if (tl) { ui.txLabel = tl.dataset.txlabel; closeSheet(); if (ui.tab !== 'txns') setTab('txns'); else render(); return true; }
  const ce = t.closest('[data-cat-edit]');
  if (ce) { const c = catById(ce.dataset.catEdit); if (c) catForm(c); return true; }
  const lm = t.closest('[data-label-menu]');
  if (lm) { labelMenu(lm.dataset.labelMenu); return true; }
  const lo = t.closest('[data-label-open]');
  if (lo) { labelDetail(lo.dataset.labelOpen); return true; }
  const tf = t.closest('[data-txfilter]');
  if (tf) { ui.txFilter = tf.dataset.txfilter; render(); return true; }
  const bud = t.closest('[data-budget]');
  if (bud) { budgetDetail(bud.dataset.budget); return true; }
  const ws = t.closest('[data-wallet-sel]');
  if (ws) { ui.wallet = ws.dataset.walletSel; closeSheet(); render(); return true; }
  const we = t.closest('[data-wallet-edit]');
  if (we) { const w = walletById(we.dataset.walletEdit); if (w) walletForm(w); return true; }
  const per = t.closest('[data-period]');
  if (per) { ui.period = per.dataset.period; render(); return true; }
  const bo = t.closest('[data-boff]');
  if (bo) { ui.budgetOff = Number(bo.dataset.boff); render(); return true; }
  const rt = t.closest('[data-rtype]');
  if (rt) { ui.reportType = rt.dataset.rtype; $('#homeReport').innerHTML = homeReport(ymOf(new Date()), walletSet('total')); return true; }
  const go = t.closest('[data-goto]');
  if (go) { closeSheet(); setTab(go.dataset.goto); return true; }
  return false;
}

function moneyAction(action, el) {
  switch (action) {
    case 'add-tx': txnForm(); break;
    case 'add-transfer': txnForm(null, { type: 'transfer' }); break;
    case 'wallet-pick': walletSheet('pick'); break;
    case 'wallets': walletSheet('edit'); break;
    case 'add-wallet': walletForm(); break;
    case 'toggle-hide': money.prefs.hideBalance = !money.prefs.hideBalance; savePrefs(); render(); break;
    case 'alerts': alertsSheet(); break;
    case 'search':
      ui.searchOpen = true; ui.focusSearch = true;
      if (ui.tab !== 'txns') setTab('txns'); else render();
      break;
    case 'search-close': ui.searchOpen = false; ui.search = ''; render(); break;
    case 'tx-menu': txMenu(); break;
    case 'labels': labelsSheet(); break;
    case 'categories': catsSheet(); break;
    case 'add-cat': catForm(null, { type: ui.catType }); break;
    case 'add-label': labelForm(); break;
    case 'label-filter': labelFilterSheet(); break;
    case 'csv': closeSheet(); exportCsv(); break;
    case 'report': reportSheet(el.dataset.ym); break;
    case 'add-budget': budgetForm(); break;
    case 'add-budget-all': budgetForm(null, { category: 'all' }); break;
    case 'add-budget-shared': budgetForm(null, { scope: 'shared', category: 'all' }); break;
    case 'edit-budget': { const bg = money.budgets.find((x) => x.id === el.dataset.id); if (bg) budgetForm(bg); break; }
    default: return false;
  }
  return true;
}
