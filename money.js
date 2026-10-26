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
  food:          { type: 'expense', label: 'อาหารและเครื่องดื่ม', icon: '🍜', color: '#f5a623' },
  personal:      { type: 'expense', label: 'ของใช้ส่วนตัว',       icon: '🧴', color: '#4f6bed' },
  shopping:      { type: 'expense', label: 'ช้อปปิ้ง',           icon: '🛍️', color: '#e83e8c' },
  transport:     { type: 'expense', label: 'การเดินทาง',         icon: '🚗', color: '#4f6bed' },
  utility:       { type: 'expense', label: 'ค่าน้ำ ค่าไฟ ค่าเน็ต', icon: '💡', color: '#00b3a4' },
  creditpay:     { type: 'expense', label: 'ชำระบัตรเครดิต',      icon: '💳', color: '#7c5cff' },
  loan:          { type: 'expense', label: 'ผ่อนชำระ',           icon: '🏦', color: '#e0552b' },
  home:          { type: 'expense', label: 'บ้านและที่พัก',       icon: '🏠', color: '#b26a3c' },
  health:        { type: 'expense', label: 'สุขภาพและฟิตเนส',     icon: '💊', color: '#e0352b' },
  entertainment: { type: 'expense', label: 'บันเทิง',             icon: '🎬', color: '#9b59b6' },
  family:        { type: 'expense', label: 'ครอบครัว',           icon: '👨‍👩‍👧', color: '#1a9e5c' },
  education:     { type: 'expense', label: 'การศึกษา',           icon: '📚', color: '#2fa8ff' },
  beauty:        { type: 'expense', label: 'ความงาม',            icon: '💄', color: '#ff6f91' },
  insurance:     { type: 'expense', label: 'ประกัน',             icon: '🛡️', color: '#2e8b57' },
  gift:          { type: 'expense', label: 'ของขวัญและบริจาค',    icon: '🎁', color: '#c0392b' },
  travel:        { type: 'expense', label: 'ท่องเที่ยว',          icon: '✈️', color: '#16a085' },
  other_exp:     { type: 'expense', label: 'รายจ่ายอื่นๆ',        icon: '🧾', color: '#8a8f99' },
  salary:        { type: 'income', label: 'เงินเดือน',          icon: '💰', color: '#2f6bff' },
  bonus:         { type: 'income', label: 'โบนัส',              icon: '🎉', color: '#f5a623' },
  sale:          { type: 'income', label: 'ขายของ',             icon: '📦', color: '#b26a3c' },
  interest:      { type: 'income', label: 'ดอกเบี้ยและปันผล',    icon: '📈', color: '#1a9e5c' },
  debt_collect:  { type: 'income', label: 'รับคืนเงินยืม',       icon: '🤝', color: '#00b3a4' },
  other_inc:     { type: 'income', label: 'รายรับอื่นๆ',         icon: '💵', color: '#4f6bed' },
};
const TRANSFER_CAT = { label: 'โอนเงิน', icon: '🔁', color: '#8a8f99' };
const SETTLE_CAT = { label: 'คืนเงินระหว่างคู่', icon: '🤝', color: '#00b3a4' };
const REVIEW_CAT = { label: 'รอตรวจสอบ', icon: '❔', color: '#d98a00' };
const ALL_CAT = { label: 'ทุกหมวดหมู่', icon: '🌐', color: '#2f6bff' };
const TOTAL_WALLET = { name: 'ทั้งหมด', icon: '🌐', color: '#2f6bff' };

// Paying a bill is recorded as an expense in the matching category.
const BILL_TX_CAT = {
  credit: 'creditpay', electric: 'utility', water: 'utility', internet: 'utility', phone: 'utility',
  loan: 'loan', insurance: 'insurance', rent: 'home', subscription: 'entertainment', other: 'other_exp',
};

const TH_DOW_FULL = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

/* ---------- Store ---------- */

const defaultMoney = () => ({
  wallets: [{ id: 'cash', name: 'เงินสด', type: 'cash', initial: 0 }],
  txns: [],
  // budgets: { id, category ('all' or TX_CATS key), amount, walletId ('total' or wallet id) } — repeats every month
  budgets: [],
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
      txns: Array.isArray(s.txns) ? s.txns : [],
      budgets: Array.isArray(s.budgets) ? s.budgets : [],
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
  if (!t.category) return REVIEW_CAT;
  return TX_CATS[t.category] || TX_CATS.other_exp;
}
function budgetCat(bg) { return bg.category === 'all' ? ALL_CAT : (TX_CATS[bg.category] || TX_CATS.other_exp); }
function catsOf(type) { return Object.entries(TX_CATS).filter(([, c]) => c.type === type); }

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
// counts whole approved shared bills, once, for the couple.
function budgetFilter(bg) {
  const cat = (t) => bg.category === 'all' || t.category === bg.category;
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
    walletId, date, note: `จ่าย${b.name}`, billId: b.id, billYm: ym,
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

function saveTxn(t, extra) {
  upsert(money.txns, t);
  if (isCloud()) cloudSaveTxn(t, extra); else saveMoney();
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
function thDate(ds) { const d = parseDs(ds); return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear() + 543).slice(2)}`; }
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

const STATUS_BADGE = {
  draft: '<span class="badge muted">ร่าง</span>',
  pending: '<span class="badge warn">รออนุมัติ</span>',
  rejected: '<span class="badge bad">ถูกปฏิเสธ</span>',
};

function txItem(t, S) {
  const c = txCat(t);
  const w = walletById(t.walletId);
  const to = t.type === 'transfer' ? walletById(t.toWalletId) : null;
  let title = t.type === 'transfer' ? `${esc(w ? w.name : '?')} → ${esc(to ? to.name : '?')}` : c.label;
  if (t.type === 'settle') title = t.sign > 0 ? `รับเงินคืนจาก${esc(partnerName())}` : `คืนเงินให้${esc(partnerName())}`;
  const shared = t.scope === 'shared';
  const sub = [
    t.type === 'transfer' ? c.label : '',
    esc(t.merchant || ''),
    esc(t.note || ''),
    shared ? `ส่วนของฉัน ${baht(t.amount)}` : '',
  ].filter(Boolean).join(' · ') || (w ? esc(w.name) : '');
  const badges = [
    shared ? '<span class="badge share">ร่วม</span>' : '',
    shared ? STATUS_BADGE[t.status] || '' : '',
    t.reviewNeeded || (!t.category && t.type === 'expense') ? '<span class="badge warn">รอตรวจสอบ</span>' : '',
    t.billId ? '<span class="badge muted">บิล</span>' : '',
    t.receiptKey ? '<span class="badge muted">🧾</span>' : '',
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
          <div class="dmeta"><div>${dayLabel(ds)}</div><div>${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}</div></div>
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
        <button class="avatar-btn" data-goto="account" aria-label="บัญชี">${cloud.user ? esc((cloud.user.name || '?').slice(0, 1).toUpperCase()) : svgIcon('user')}</button>
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
    <div class="tip"><span class="muted">${day}/${m}/${parseYm(ym).y + 543}:</span> <b class="${cls}">${kbaht(now)}</b>
      ${avg.length ? `<div class="muted small">เฉลี่ย ${prev.length} เดือนก่อน ณ วันเดียวกัน: <b>${kbaht(avg[day - 1])}</b></div>` : ''}</div>
    ${chart}
    <div class="legend"><span><i class="dot ${cls}"></i>เดือนนี้</span>${avg.length ? `<span><i class="dot avg"></i>เฉลี่ย ${prev.length} เดือนก่อน</span>` : ''}</div>`;
}

function insightCard(ym, S) {
  const exp = txnsInMonth(ym).filter((t) => t.type === 'expense' && counts(t) && t.category && inSel(t, S));
  if (!exp.length) return '';
  const by = {};
  exp.forEach((t) => { by[t.category] = (by[t.category] || 0) + t.amount; });
  const [top, spent] = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  const c = TX_CATS[top] || TX_CATS.other_exp;
  const day = new Date().getDate();
  const lastYm = addMonths(ym, -1);
  const lastSame = txnsInMonth(lastYm)
    .filter((t) => t.type === 'expense' && counts(t) && t.category === top && inSel(t, S) && Number(t.date.slice(8, 10)) <= day)
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
      <div class="ins-top">${circleIco(c)}<div><b>${c.label}</b><div class="muted small">หมวดที่ใช้มากที่สุดเดือนนี้ · รวม <b class="exp">${baht(spent)}</b></div></div></div>
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
  const approvals = toApprove();
  return { bills, over, approvals };
}
function alertCount() { const a = alertList(); return a.bills.length + a.over.length + a.approvals.length + (gmailAutoDue() ? 1 : 0); }

function alertsSheet() {
  const { bills, over, approvals } = alertList();
  const ym = ymOf(new Date());
  const S = walletSet('total');
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>การแจ้งเตือน</h2><span style="width:40px"></span></div>
    ${gmailAutoDue() ? gmailAutoAlert() : ''}
    ${approvals.length ? `<div class="section-title">รอคุณอนุมัติ</div><div class="list">${approvals.map((t) => txItem(t, S)).join('')}</div>` : ''}
    ${bills.length ? `<div class="section-title">บิลใกล้ครบกำหนด / เลยกำหนด</div><div class="list">${bills.map(occItem).join('')}</div>` : ''}
    ${over.length ? `<div class="section-title">งบประมาณใช้ไปแล้ว 80% ขึ้นไป</div>${over.map((bg) => budgetRow(bg, ym)).join('')}` : ''}
    ${bills.length || over.length || approvals.length || gmailAutoDue() ? '' : '<div class="empty"><div class="e-ico">🔔</div>ไม่มีการแจ้งเตือน</div>'}
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
    tabs.push([ym, `${TH_MONTHS_SHORT[m - 1]} ${String(y + 543).slice(2)}`]);
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
    const hits = money.txns.filter((t) => touches(t, S) && txFilterOk(t) && [t.note, t.merchant, txCat(t).label, (walletById(t.walletId) || {}).name, String(t.amount)]
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

const TX_FILTERS = [['all', 'ทั้งหมด'], ['personal', 'ส่วนตัว'], ['shared', 'ร่วมกัน'], ['pending', 'รออนุมัติ'], ['review', 'รอตรวจสอบ']];

function txFilters() {
  const list = cloud.partner ? TX_FILTERS : TX_FILTERS.filter(([k]) => k === 'all' || k === 'review');
  if (!money.txns.some((t) => t.reviewNeeded || t.scope === 'shared') && ui.txFilter === 'all') return '';
  return `<div class="chips filters">${list.map(([k, l]) =>
    `<button class="chip ${ui.txFilter === k ? 'on' : ''}" data-txfilter="${k}">${l}</button>`).join('')}</div>`;
}

function txFilterOk(t) {
  switch (ui.txFilter) {
    case 'personal': return t.scope !== 'shared' && t.type !== 'settle';
    case 'shared': return t.scope === 'shared' || t.type === 'settle';
    case 'pending': return t.scope === 'shared' && t.status !== 'approved';
    case 'review': return !!t.reviewNeeded || (t.type === 'expense' && !t.category);
    default: return true;
  }
}

function txMenu() {
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>ตัวเลือก</h2><span style="width:40px"></span></div>
    <div class="list">
      <button class="item" data-action="report" data-ym="${periodRange(ui.period).ym || ymOf(new Date())}">${circleIco({ icon: '📊', color: '#2f6bff' })}<div class="main"><div class="name">ดูรายงานช่วงนี้</div></div></button>
      <button class="item" data-action="wallets">${circleIco({ icon: '👛', color: '#1a9e5c' })}<div class="main"><div class="name">จัดการกระเป๋าเงิน</div></div></button>
      <button class="item" data-action="csv">${circleIco({ icon: '⬇️', color: '#8a8f99' })}<div class="main"><div class="name">ส่งออกรายการ (CSV)</div></div></button>
    </div>`);
}

function exportCsv() {
  if (!money.txns.length) { toast('ยังไม่มีรายการ'); return; }
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['วันที่', 'ประเภท', 'หมวดหมู่', 'กระเป๋าเงิน', 'ไปยัง', 'จำนวนเงิน', 'ร้านค้า', 'บันทึก', 'ขอบเขต', 'ยอดรวมทั้งบิล', 'สถานะ']];
  const typeTh = { expense: 'รายจ่าย', income: 'รายรับ', transfer: 'โอนเงิน', settle: 'คืนเงินระหว่างคู่' };
  const statusTh = { draft: 'ร่าง', pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ถูกปฏิเสธ' };
  money.txns.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((t) => rows.push([
    t.date, typeTh[t.type], txCat(t).label, (walletById(t.walletId) || {}).name,
    t.type === 'transfer' ? (walletById(t.toWalletId) || {}).name : '', t.type === 'settle' ? t.sign * t.amount : t.amount,
    t.merchant, t.note, t.scope === 'shared' ? 'ร่วมกัน' : 'ส่วนตัว', t.scope === 'shared' ? t.total : '',
    t.scope === 'shared' ? statusTh[t.status] : '',
  ]));
  deliverFile(`transactions-${dateStr(new Date())}.csv`, 'text/csv', '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'));
}

/* ---------- Report ---------- */

function reportSheet(ym) {
  ym = ym || ymOf(new Date());
  const S = walletSet(ui.tab === 'txns' ? ui.wallet : 'total');
  const list = txnsInMonth(ym).filter((t) => t.type !== 'transfer' && counts(t) && inSel(t, S));
  const { income, expense } = totalsIn(list, S);
  const bars = (type) => {
    const by = {};
    list.filter((t) => t.type === type).forEach((t) => { const k = t.category || '_review'; by[k] = (by[k] || 0) + t.amount; });
    const sum = Object.values(by).reduce((s, v) => s + v, 0);
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '<div class="card muted" style="text-align:center">ไม่มีรายการ</div>';
    return `<div class="list">${rows.map(([k, v]) => {
      const c = k === '_review' ? REVIEW_CAT : TX_CATS[k] || TX_CATS.other_exp;
      const p = (v / sum) * 100;
      return `<div class="item rep">${circleIco(c)}<div class="main"><div class="rep-top"><span class="name">${c.label}</span><b>${baht(v)}</b></div>
        <div class="rep-bar"><div style="width:${p}%;background:${c.color}"></div></div><div class="sub">${p.toFixed(1)}%</div></div></div>`;
    }).join('')}</div>`;
  };
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>รายงาน ${thMonthYear(ym)}</h2><span style="width:40px"></span></div>
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
        <div class="main"><div class="name">${c.label} ${bg.scope === 'shared' ? '<span class="badge share">ร่วม</span>' : ''} ${badge}</div>${w ? `<div class="sub">${esc(w.name)}</div>` : ''}</div>
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
    ${shared.map((bg) => budgetRow(bg, ym)).join('') || '<div class="card muted small">งบร่วมนับยอดรวมทั้งบิลของรายจ่ายร่วมที่อนุมัติแล้ว ทั้งสองคนเห็นงบเดียวกัน</div>'}` : ''}
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
    xLabels: [[0, `1/${m}/${String(y + 543).slice(2)}`], [dim - 1, `${dim}/${m}/${String(y + 543).slice(2)}`]],
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
      <div class="b-top">${circleIco(c)}<div class="main"><div class="name big-name">${c.label}</div></div></div>
      <div class="bd-body">
        <div class="bd-amt">${baht(bg.amount)}</div>
        <div class="bd-sl"><div><span class="muted">ใช้ไป</span><b>${baht(spent)}</b></div>
          <div style="text-align:right"><span class="muted">${left < 0 ? 'เกินงบ' : 'เหลือ'}</span><b class="${left < 0 ? 'exp' : ''}">${baht(Math.abs(left))}</b></div></div>
        ${budgetBar(spent, bg.amount, ym)}
        <div class="bd-meta"><span>⏳</span><div>1 ${TH_MONTHS_SHORT[m - 1]} – ${dim} ${TH_MONTHS_SHORT[m - 1]} ${y + 543}<div class="muted small">${ym === cur ? `เหลืออีก ${daysLeft} วัน` : ym < cur ? 'สิ้นสุดแล้ว' : 'ยังไม่เริ่ม'}</div></div></div>
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
    `<button type="button" class="cat ${d.category === k ? 'on' : ''}" data-bcat="${k}">${circleIco(c, 'ico round')}<span>${c.label}</span></button>`).join('');
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

function txnForm(t, preset = {}) {
  const isNew = !t;
  const me = cloud.user ? cloud.user.id : null;
  const canShare = isCloud() && !!cloud.partner;
  const d = t ? { ...t } : {
    type: 'expense', amount: '', category: 'food', walletId: defaultWalletId(), toWalletId: '',
    date: dateStr(new Date()), note: '', merchant: '', scope: 'personal', ...preset,
  };
  // The form edits the whole bill; a shared row stores my share in `amount` and the bill in `total`.
  let shareEdited = false;
  if (t && t.scope === 'shared') { d.amount = t.total; d.myShare = t.amount; shareEdited = true; }
  if (!d.payerId) d.payerId = me;
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
    ${canShare ? `<div class="seg" id="txScope">
      <button type="button" data-scope="personal">ส่วนตัว</button>
      <button type="button" data-scope="shared">ร่วมกับ ${esc(partnerName())}</button>
    </div>` : ''}
    ${receipts ? `<div class="section-title">✨ AI Slips</div>
    <p class="hint">อัปโหลดสลิป แล้ว AI จะกรอกหมวด ยอดเงิน และวันที่โอนให้ ตรวจแก้ได้ก่อนบันทึก</p>
    <div class="receipt-row">
      <button type="button" class="chip" id="rcCam">📷 ถ่ายสลิป</button>
      <button type="button" class="chip" id="rcPick">🖼️ เลือกรูปสลิป</button>
      ${d.receiptKey ? '<button type="button" class="chip" id="rcView">🧾 ดูสลิป</button>' : ''}
      <input type="file" id="rcCamIn" accept="image/*" capture="environment" hidden>
      <input type="file" id="rcPickIn" accept="image/jpeg,image/png,image/webp,image/*" hidden>
    </div><div id="rcStatus"></div>` : ''}
    <div class="amount-input" id="tAmtWrap"><span>฿</span><input id="tAmount" inputmode="decimal" placeholder="0" value="${d.amount}"></div>
    <div id="tCatWrap"><div class="section-title">หมวดหมู่</div><div class="cat-grid" id="tCats"></div><p class="hint" id="tCatHint" hidden>ยังไม่ได้เลือกหมวดหมู่ รายการจะถูกบันทึกเป็น "รอตรวจสอบ" จนกว่าจะเลือก</p></div>
    <div class="form">
      <div class="field" id="tMerchRow"><label for="tMerchant">ร้านค้า / ผู้รับ</label><input id="tMerchant" placeholder="เช่น 7-Eleven" value="${esc(d.merchant || '')}" autocomplete="off"></div>
      <div id="tShareRows">
        <div class="field"><label for="tPayer">ใครจ่าย</label><select id="tPayer">
          <option value="${me}" ${d.payerId === me ? 'selected' : ''}>ฉัน</option>
          ${canShare ? `<option value="${cloud.partner.id}" ${d.payerId === cloud.partner.id ? 'selected' : ''}>${esc(partnerName())}</option>` : ''}
        </select></div>
        <div class="field"><label for="tMine">ส่วนของฉัน (฿)</label><input id="tMine" inputmode="decimal" value="${d.myShare ?? ''}"></div>
        <div class="kv"><span>ส่วนของ ${esc(partnerName())}</span><b id="tTheirs">-</b></div>
      </div>
      <div class="field" id="tWalletRow"><label for="tWallet" id="tWalletLab">กระเป๋าเงิน</label><select id="tWallet">${wOpts(d.walletId || defaultWalletId())}</select></div>
      <div class="field" id="tToRow"><label for="tTo">ไปยัง</label><select id="tTo"></select></div>
      <div class="field"><label for="tDate">วันที่</label><input type="date" id="tDate" value="${d.date}"></div>
      <div class="field"><label for="tNote">บันทึก</label><input id="tNote" placeholder="เช่น ข้าวกลางวัน" value="${esc(d.note || '')}" autocomplete="off"></div>
      <div class="field" id="tReviewRow"><label for="tReview">รอตรวจสอบ</label><span style="flex:1"></span><label class="switch"><input type="checkbox" id="tReview" ${d.reviewNeeded ? 'checked' : ''}><span></span></label></div>
    </div>
    <p class="hint" id="tShareHint">ใส่ยอดรวมทั้งบิล ค่าเริ่มต้นแบ่งครึ่ง แก้ส่วนของแต่ละคนได้ รายการจะนับเป็นรายจ่ายเมื่อ ${esc(partnerName())} อนุมัติแล้วเท่านั้น</p>
    ${d.status === 'rejected' ? `<p class="hint bad-text">ถูกปฏิเสธ${d.rejectReason ? `: ${esc(d.rejectReason)}` : ''} — แก้ไขแล้วกดบันทึกเพื่อส่งใหม่</p>` : ''}
    ${d.billId ? '<p class="hint">รายการนี้สร้างจากการจ่ายบิล</p>' : ''}
    <button class="btn ghost" id="draftTx" hidden>บันทึกเป็นร่าง (ยังไม่ส่ง)</button>
    ${isNew ? '' : '<button class="btn danger" id="delTx">ลบรายการ</button>'}
  `);

  const shared = () => d.scope === 'shared' && d.type === 'expense';
  const updateShares = () => {
    if (!shared()) return;
    const total = num($('#tAmount').value) || 0;
    if (!shareEdited) $('#tMine').value = total ? Math.round((total / 2) * 100) / 100 : '';
    const mine = num($('#tMine').value) || 0;
    $('#tTheirs').textContent = baht(Math.max(0, Math.round((total - mine) * 100) / 100));
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
    $('#tReviewRow').hidden = transfer;
    $('#tToRow').hidden = !transfer;
    $('#tShareRows').hidden = !sh;
    $('#tShareHint').hidden = !sh;
    $('#draftTx').hidden = !sh;
    $('#saveTx').textContent = sh ? 'ส่งขออนุมัติ' : 'บันทึก';
    // The wallet only matters when I am the one paying.
    $('#tWalletRow').hidden = sh && $('#tPayer').value !== me;
    $('#tWalletLab').textContent = transfer ? 'จาก' : sh ? 'จ่ายจาก' : 'กระเป๋าเงิน';
    updateShares();
    if (transfer) {
      const from = $('#tWallet').value;
      if (!d.toWalletId || d.toWalletId === from) d.toWalletId = (money.wallets.find((w) => w.id !== from) || {}).id || '';
      $('#tTo').innerHTML = wOpts(d.toWalletId, from);
      return;
    }
    if (d.category && (!TX_CATS[d.category] || TX_CATS[d.category].type !== d.type)) d.category = catsOf(d.type)[0][0];
    $('#tCatHint').hidden = !!d.category;
    $('#tCats').innerHTML = catsOf(d.type).map(([k, c]) =>
      `<button type="button" class="cat ${d.category === k ? 'on' : ''}" data-tcat="${k}">${circleIco(c, 'ico round')}<span>${c.label}</span></button>`).join('');
  };
  renderType();

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
  $('#tCats').addEventListener('click', (e) => {
    const c = e.target.closest('[data-tcat]');
    if (!c) return;
    d.category = c.dataset.tcat;
    $('#tCatHint').hidden = true;
    document.querySelectorAll('#tCats .cat').forEach((x) => x.classList.toggle('on', x === c));
  });
  $('#tAmount').addEventListener('input', updateShares);
  $('#tMine').addEventListener('input', () => { shareEdited = true; updateShares(); });
  $('#tPayer').addEventListener('change', renderType);
  $('#tWallet').addEventListener('change', () => { if (d.type === 'transfer') renderType(); });
  $('#tTo').addEventListener('change', (e) => { d.toWalletId = e.target.value; });

  if (receipts) {
    const status = (html) => { $('#rcStatus').innerHTML = html ? `<p class="hint rc-status">${html}</p>` : ''; };
    const onFile = async (file) => {
      if (!file) return;
      status('⏳ กำลังอัปโหลดและอ่านสลิป…');
      try {
        const r = await uploadReceipt(file);
        d.receiptKey = r.key;
        const x = r.result;
        if (x) {
          if (x.amount) $('#tAmount').value = x.amount;
          if (x.date) $('#tDate').value = x.date;
          if (x.merchant) $('#tMerchant').value = x.merchant;
          if (x.note && !$('#tNote').value) $('#tNote').value = x.note;
          if (x.reference) d.slipRef = x.reference;
          d.type = 'expense';
          d.category = x.category || null;
          renderType();
        }
        $('#tReview').checked = r.status !== 'ok';
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
    $('#rcCam').addEventListener('click', () => $('#rcCamIn').click());
    $('#rcPick').addEventListener('click', () => $('#rcPickIn').click());
    $('#rcCamIn').addEventListener('change', (e) => onFile(e.target.files[0]));
    $('#rcPickIn').addEventListener('change', (e) => onFile(e.target.files[0]));
    if ($('#rcView')) $('#rcView').addEventListener('click', () => openReceipt(d.receiptKey));
  }

  const save = (submit) => {
    const total = num($('#tAmount').value);
    if (!(total > 0)) { toast('กรุณาใส่จำนวนเงิน'); $('#tAmount').focus(); return; }
    const date = $('#tDate').value;
    if (!date) { toast('กรุณาเลือกวันที่'); return; }
    const out = {
      id: d.id || newId(), type: d.type, amount: total, walletId: $('#tWallet').value, date, note: $('#tNote').value.trim(),
      scope: 'personal',
    };
    if (d.type === 'transfer') {
      out.toWalletId = $('#tTo').value;
      if (!out.toWalletId || out.toWalletId === out.walletId) { toast('เพิ่มกระเป๋าเงินอีกใบเพื่อโอนเงิน'); return; }
    } else {
      out.category = d.category || null;
      out.merchant = $('#tMerchant').value.trim();
      out.reviewNeeded = $('#tReview').checked || !out.category;
      if (d.receiptKey) out.receiptKey = d.receiptKey;
      if (d.slipRef) out.slipRef = d.slipRef;
    }
    if (d.billId) { out.billId = d.billId; out.billYm = d.billYm; }
    if (shared()) {
      const mine = num($('#tMine').value) || 0;
      if (mine < 0 || mine > total) { toast('ส่วนของฉันต้องไม่เกินยอดรวม'); $('#tMine').focus(); return; }
      const payer = $('#tPayer').value;
      const payerMe = payer === me;
      Object.assign(out, {
        scope: 'shared', total, amount: mine, payerId: payer, ownerId: me, walletId: payerMe ? out.walletId : null,
        walletAmount: payerMe ? total : 0, counted: false, status: submit ? 'pending' : 'draft',
        shares: { [me]: mine, [cloud.partner.id]: Math.round((total - mine) * 100) / 100 },
        events: d.events || [], revision: d.revision || 1,
      });
    }
    saveTxn(out, { submit: !!submit });
    if (out.walletId && money.prefs.lastWallet !== out.walletId) { money.prefs.lastWallet = out.walletId; savePrefs(); }
    closeSheet(); render(); if (isNew) popIn();
    toast(out.scope === 'shared' ? (submit ? `ส่งให้ ${partnerName()} อนุมัติแล้ว` : 'บันทึกร่างแล้ว') : isNew ? 'เพิ่มรายการแล้ว' : 'บันทึกแล้ว');
  };
  $('#saveTx').addEventListener('click', () => save(true));
  $('#draftTx').addEventListener('click', () => save(false));
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
  const foods = [['ข้าวมันไก่', 50], ['กาแฟ', 65], ['ก๋วยเตี๋ยว', 60], ['ข้าวกล่องเซเว่น', 45], ['ชานมไข่มุก', 55], ['ส้มตำ', 80]];
  for (let d = new Date(start); d <= t; d.setDate(d.getDate() + 1)) {
    const ds = dateStr(d);
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const [note, base] = pick(foods);
      add(ds, 'expense', base + Math.round(rnd() * 4) * 10, 'food', pick([cash, cash, ew]), note);
    }
    if (rnd() < 0.3) add(ds, 'expense', 30 + Math.round(rnd() * 8) * 5, 'transport', pick([ew, cash]), pick(['BTS', 'MRT', 'Grab', 'วินมอไซค์']));
    if (rnd() < 0.12) add(ds, 'expense', 300 + Math.round(rnd() * 30) * 50, 'shopping', bank, pick(['Shopee', 'Lazada', 'เสื้อผ้า', 'ของใช้ในบ้าน']));
    if (rnd() < 0.05) add(ds, 'expense', 200 + Math.round(rnd() * 10) * 50, 'entertainment', bank, pick(['ดูหนัง', 'คอนเสิร์ต', 'เกม']));
    if (rnd() < 0.04) add(ds, 'expense', 150 + Math.round(rnd() * 10) * 30, 'health', cash, pick(['ร้านยา', 'คลินิก']));
    if (d.getDate() === 25) add(ds, 'income', 38000, 'salary', bank, 'เงินเดือน');
    if (d.getDay() === 1) add(ds, 'transfer', 1500, undefined, bank, 'กดเงินสด', { toWalletId: cash });
    if (d.getDay() === 4) add(ds, 'transfer', 800, undefined, bank, 'เติมเงิน', { toWalletId: ew });
    if (d.getDate() === 15 && rnd() < 0.6) add(ds, 'income', 1200 + Math.round(rnd() * 10) * 100, 'sale', bank, 'ขายของออนไลน์');
  }
  const f1 = new Date(t); f1.setDate(f1.getDate() + 3);
  const f2 = new Date(t); f2.setDate(f2.getDate() + 9);
  add(dateStr(f1), 'expense', 1500, 'family', bank, 'ค่าเทอมพิเศษลูก');
  add(dateStr(f2), 'expense', 890, 'gift', bank, 'ของขวัญวันเกิดเพื่อน');
  const budgets = [
    { id: uid(), category: 'all', amount: 30000, walletId: 'total' },
    { id: uid(), category: 'food', amount: 5000, walletId: 'total' },
    { id: uid(), category: 'shopping', amount: 3000, walletId: 'total' },
    { id: uid(), category: 'transport', amount: 1200, walletId: 'total' },
  ];
  money = { wallets, txns, budgets, prefs: { ...money.prefs, billWallet: bank } };
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
