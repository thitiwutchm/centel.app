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
  try {
    localStorage.setItem(MONEY_KEY, JSON.stringify(money));
  } catch (e) {
    toast('บันทึกข้อมูลไม่สำเร็จ');
  }
}

/* ---------- Domain ---------- */

function walletById(id) { return money.wallets.find((w) => w.id === id); }
function wType(w) { return WALLET_TYPES[w.type] || WALLET_TYPES.cash; }
function txCat(t) { return t.type === 'transfer' ? TRANSFER_CAT : (TX_CATS[t.category] || TX_CATS.other_exp); }
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
  return new Set(money.wallets.filter((w) => !w.excluded).map((w) => w.id));
}

// How much a transaction moves the balance of a set of wallets.
function deltaFor(t, S) {
  if (t.type === 'income') return S.has(t.walletId) ? t.amount : 0;
  if (t.type === 'expense') return S.has(t.walletId) ? -t.amount : 0;
  return (S.has(t.toWalletId) ? t.amount : 0) - (S.has(t.walletId) ? t.amount : 0);
}

function touches(t, S) { return S.has(t.walletId) || (t.type === 'transfer' && S.has(t.toWalletId)); }

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
    if (!S.has(t.walletId)) return;
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
  });
  return { income, expense };
}

function txnsInMonth(ym) { return money.txns.filter((t) => t.date.slice(0, 7) === ym); }

// Cumulative income or expense per day of a month, index 0 = day 1.
function cumDaily(ym, type, filter = () => true) {
  const dim = daysInMonth(ym);
  const per = new Array(dim).fill(0);
  txnsInMonth(ym).forEach((t) => {
    if (t.type === type && filter(t)) per[Number(t.date.slice(8, 10)) - 1] += t.amount;
  });
  for (let i = 1; i < dim; i++) per[i] += per[i - 1];
  return per;
}

function budgetFilter(bg) {
  const S = walletSet(bg.walletId || 'total');
  return (t) => t.type === 'expense' && S.has(t.walletId) && (bg.category === 'all' || t.category === bg.category);
}
function budgetSpent(bg, ym) {
  const f = budgetFilter(bg);
  return txnsInMonth(ym).filter(f).reduce((s, t) => s + t.amount, 0);
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
  money.txns = money.txns.filter((t) => !(t.billId === billId && t.billYm === ym));
}

function recordBillTxn(b, ym, amount, walletId, date = dateStr(new Date())) {
  removeBillTxn(b.id, ym);
  if (!walletId || !walletById(walletId) || !(amount > 0)) return;
  money.txns.push({
    id: uid(), type: 'expense', amount, category: BILL_TX_CAT[b.category] || 'other_exp',
    walletId, date, note: `จ่าย${b.name}`, billId: b.id, billYm: ym,
  });
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
};
function svgIcon(name, cls = 'svg-i') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

function circleIco(c, cls = 'ico round') { return `<div class="${cls}" style="background:${c.color}22">${c.icon}</div>`; }
function walletIco(w, cls = 'ico round') { return w ? circleIco(wType(w), cls) : circleIco(TOTAL_WALLET, cls); }

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
  const title = t.type === 'transfer' ? `${esc(w ? w.name : '?')} → ${esc(to ? to.name : '?')}` : c.label;
  const sub = [t.type === 'transfer' ? c.label : '', esc(t.note || '')].filter(Boolean).join(' · ') || (w ? esc(w.name) : '');
  return `
    <button class="item tx" data-tx="${t.id}">
      <div class="ico-wrap">${circleIco(c)}${w ? `<span class="mini" style="background:${wType(w).color}">${wType(w).icon}</span>` : ''}</div>
      <div class="main"><div class="name">${title}</div><div class="sub">${sub}${t.billId ? ' <span class="badge muted">บิล</span>' : ''}</div></div>
      <div class="right"><div class="amt ${txAmtCls(t, S)}">${baht(t.amount)}</div></div>
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
  const recent = money.txns.filter((t) => t.date <= dateStr(new Date()))
    .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).slice(0, 4);

  view.innerHTML = `
    <div class="home-head">
      <div class="hb">
        <div class="hb-amt">${masked(sbaht(total))}
          <button class="eye" data-action="toggle-hide" aria-label="${hide ? 'แสดงยอดเงิน' : 'ซ่อนยอดเงิน'}">${svgIcon(hide ? 'eyeOff' : 'eye')}</button></div>
        <div class="label">ยอดเงินรวม</div>
      </div>
      <div class="head-actions">
        <button class="round-btn" data-action="search" aria-label="ค้นหารายการ">${svgIcon('search')}</button>
        <button class="round-btn" data-action="alerts" aria-label="การแจ้งเตือน">${svgIcon('bell')}${alerts ? `<span class="nbadge">${alerts}</span>` : ''}</button>
      </div>
    </div>

    <div class="card list-card">
      <div class="card-head"><b>กระเป๋าเงินของฉัน</b><button class="link-btn" data-action="wallets">ดูทั้งหมด</button></div>
      ${wallets}
    </div>

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
      ${state.bills.length ? '' : '<button class="btn ghost" data-action="sample">ลองใช้ข้อมูลตัวอย่าง</button>'}
    </div>`}
    ${state.bills.length || money.txns.length ? '' : installTip()}
  `;
}

function homeReport(ym, S) {
  const type = ui.reportType;
  const { income, expense } = totalsIn(txnsInMonth(ym), S);
  const f = (t) => S.has(t.walletId);
  const dim = daysInMonth(ym);
  const day = new Date().getDate();
  const cur = cumDaily(ym, type, f).slice(0, day);
  // Average of earlier months that have data, aligned by day of month.
  const prev = [1, 2, 3].map((i) => addMonths(ym, -i)).filter((m) => txnsInMonth(m).some((t) => t.type === type));
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
  const exp = txnsInMonth(ym).filter((t) => t.type === 'expense' && S.has(t.walletId));
  if (!exp.length) return '';
  const by = {};
  exp.forEach((t) => { by[t.category] = (by[t.category] || 0) + t.amount; });
  const [top, spent] = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  const c = TX_CATS[top] || TX_CATS.other_exp;
  const day = new Date().getDate();
  const lastYm = addMonths(ym, -1);
  const lastSame = txnsInMonth(lastYm)
    .filter((t) => t.type === 'expense' && t.category === top && S.has(t.walletId) && Number(t.date.slice(8, 10)) <= day)
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
  const over = money.budgets.filter((bg) => budgetSpent(bg, ym) > bg.amount);
  return { bills, over };
}
function alertCount() { const a = alertList(); return a.bills.length + a.over.length; }

function alertsSheet() {
  const { bills, over } = alertList();
  const ym = ymOf(new Date());
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>การแจ้งเตือน</h2><span style="width:40px"></span></div>
    ${bills.length ? `<div class="section-title">บิลใกล้ครบกำหนด / เลยกำหนด</div><div class="list">${bills.map(occItem).join('')}</div>` : ''}
    ${over.length ? `<div class="section-title">ใช้เกินงบประมาณ</div><div class="list">${over.map((bg) => budgetRow(bg, ym)).join('')}</div>` : ''}
    ${bills.length || over.length ? '' : '<div class="empty"><div class="e-ico">🔔</div>ไม่มีการแจ้งเตือน</div>'}
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
    const hits = money.txns.filter((t) => touches(t, S) && [t.note, txCat(t).label, (walletById(t.walletId) || {}).name, String(t.amount)]
      .some((s) => String(s || '').toLowerCase().includes(q)));
    return hits.length ? `<div class="muted small pad">พบ ${hits.length} รายการ</div>${dayGroups(hits, S)}` : '<div class="empty">ไม่พบรายการ</div>';
  }
  const r = periodRange(ui.period);
  const td = dateStr(new Date());
  if (r.future) {
    const list = money.txns.filter((t) => t.date > td && touches(t, S));
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
  const list = money.txns.filter((t) => t.date >= r.from && t.date <= r.to && touches(t, S));
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
  const rows = [['วันที่', 'ประเภท', 'หมวดหมู่', 'กระเป๋าเงิน', 'ไปยัง', 'จำนวนเงิน', 'บันทึก']];
  const typeTh = { expense: 'รายจ่าย', income: 'รายรับ', transfer: 'โอนเงิน' };
  money.txns.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((t) => rows.push([
    t.date, typeTh[t.type], txCat(t).label, (walletById(t.walletId) || {}).name,
    t.type === 'transfer' ? (walletById(t.toWalletId) || {}).name : '', t.amount, t.note,
  ]));
  deliverFile(`transactions-${dateStr(new Date())}.csv`, 'text/csv', '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'));
}

/* ---------- Report ---------- */

function reportSheet(ym) {
  ym = ym || ymOf(new Date());
  const S = walletSet(ui.tab === 'txns' ? ui.wallet : 'total');
  const list = txnsInMonth(ym).filter((t) => t.type !== 'transfer' && S.has(t.walletId));
  const { income, expense } = totalsIn(list, S);
  const bars = (type) => {
    const by = {};
    list.filter((t) => t.type === type).forEach((t) => { by[t.category] = (by[t.category] || 0) + t.amount; });
    const sum = Object.values(by).reduce((s, v) => s + v, 0);
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '<div class="card muted" style="text-align:center">ไม่มีรายการ</div>';
    return `<div class="list">${rows.map(([k, v]) => {
      const c = TX_CATS[k] || TX_CATS.other_exp;
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
  return money.budgets.filter((bg) => ui.wallet === 'total' || bg.walletId === ui.wallet || (bg.walletId || 'total') === 'total');
}

function budgetRow(bg, ym) {
  const c = budgetCat(bg);
  const spent = budgetSpent(bg, ym);
  const left = bg.amount - spent;
  const w = bg.walletId && bg.walletId !== 'total' ? walletById(bg.walletId) : null;
  return `
    <button class="card budget" data-budget="${bg.id}">
      <div class="b-top">${circleIco(c)}
        <div class="main"><div class="name">${c.label}</div>${w ? `<div class="sub">${esc(w.name)}</div>` : ''}</div>
        <div class="right"><b>${baht(bg.amount)}</b><div class="sub ${left < 0 ? 'exp' : ''}">${left < 0 ? `เกินงบ ${baht(-left)}` : `เหลือ ${baht(left)}`}</div></div>
      </div>
      ${budgetBar(spent, bg.amount, ym)}
    </button>`;
}

function renderBudgets() {
  const ym = budgetYm();
  const list = visibleBudgets();
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
    ` : `
    <div class="card empty-card">
      <div class="e-ico">🎯</div>
      <b>ยังไม่มีงบประมาณ</b>
      <div class="muted small">ตั้งงบรายเดือนสำหรับแต่ละหมวด แล้วดูว่าใช้ไปเท่าไร เหลือเท่าไร และควรใช้วันละเท่าไร</div>
      <button class="btn" data-action="add-budget" style="margin-top:14px">สร้างงบประมาณ</button>
    </div>`}
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
  const cum = cumDaily(ym, 'expense', f);
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
        <div class="bd-meta"><span>${w ? wType(w).icon : '🌐'}</span><div>${w ? esc(w.name) : 'ทุกกระเป๋าเงิน'}</div></div>
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
  const d = bg ? { ...bg } : { category: 'food', amount: '', walletId: ui.wallet === 'total' ? 'total' : ui.wallet, ...preset };
  const chips = [['all', ALL_CAT], ...catsOf('expense')].map(([k, c]) =>
    `<button type="button" class="cat ${d.category === k ? 'on' : ''}" data-bcat="${k}">${circleIco(c, 'ico round')}<span>${c.label}</span></button>`).join('');
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ยกเลิก</button>
      <h2>${isNew ? 'สร้างงบประมาณ' : 'แก้ไขงบประมาณ'}</h2>
      <button class="link-btn strong" id="saveBudget">บันทึก</button>
    </div>
    <div class="amount-input"><span>฿</span><input id="bAmount" inputmode="decimal" placeholder="0" value="${d.amount}"></div>
    <div class="section-title">หมวดหมู่</div>
    <div class="cat-grid" id="bCats">${chips}</div>
    <div class="form">
      <div class="field"><label for="bWallet">กระเป๋าเงิน</label><select id="bWallet">
        <option value="total">ทุกกระเป๋าเงิน</option>
        ${money.wallets.map((w) => `<option value="${w.id}" ${d.walletId === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select></div>
      <div class="kv"><span>รอบงบประมาณ</span><span>ทุกเดือน</span></div>
    </div>
    ${isNew ? '' : '<button class="btn danger" id="delBudget">ลบงบประมาณ</button>'}
  `);
  $('#bCats').addEventListener('click', (e) => {
    const c = e.target.closest('[data-bcat]');
    if (!c) return;
    d.category = c.dataset.bcat;
    document.querySelectorAll('#bCats .cat').forEach((x) => x.classList.toggle('on', x === c));
  });
  $('#saveBudget').addEventListener('click', () => {
    const amount = num($('#bAmount').value);
    if (!(amount > 0)) { toast('กรุณาใส่จำนวนเงิน'); $('#bAmount').focus(); return; }
    const out = { id: d.id || uid(), category: d.category, amount, walletId: $('#bWallet').value };
    const dup = money.budgets.find((x) => x.id !== out.id && x.category === out.category && (x.walletId || 'total') === out.walletId);
    if (dup) { toast('มีงบของหมวดนี้อยู่แล้ว'); return; }
    const i = money.budgets.findIndex((x) => x.id === out.id);
    if (i >= 0) money.budgets[i] = out; else money.budgets.push(out);
    saveMoney(); closeSheet(); render();
    toast(isNew ? 'สร้างงบประมาณแล้ว' : 'บันทึกแล้ว');
  });
  const del = $('#delBudget');
  if (del) del.addEventListener('click', () => {
    if (!confirm('ลบงบประมาณนี้?')) return;
    money.budgets = money.budgets.filter((x) => x.id !== d.id);
    saveMoney(); closeSheet(); render(); toast('ลบแล้ว');
  });
  if (isNew) setTimeout(() => $('#bAmount') && $('#bAmount').focus(), 300);
}

/* ---------- Transaction form ---------- */

function txnForm(t, preset = {}) {
  const isNew = !t;
  const d = t ? { ...t } : {
    type: 'expense', amount: '', category: 'food', walletId: defaultWalletId(), toWalletId: '',
    date: dateStr(new Date()), note: '', ...preset,
  };
  const wOpts = (selId, skip) => money.wallets.filter((w) => w.id !== skip)
    .map((w) => `<option value="${w.id}" ${selId === w.id ? 'selected' : ''}>${wType(w).icon} ${esc(w.name)}</option>`).join('');

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
    <div class="amount-input" id="tAmtWrap"><span>฿</span><input id="tAmount" inputmode="decimal" placeholder="0" value="${d.amount}"></div>
    <div id="tCatWrap"><div class="section-title">หมวดหมู่</div><div class="cat-grid" id="tCats"></div></div>
    <div class="form">
      <div class="field"><label for="tWallet" id="tWalletLab">กระเป๋าเงิน</label><select id="tWallet">${wOpts(d.walletId)}</select></div>
      <div class="field" id="tToRow"><label for="tTo">ไปยัง</label><select id="tTo"></select></div>
      <div class="field"><label for="tDate">วันที่</label><input type="date" id="tDate" value="${d.date}"></div>
      <div class="field"><label for="tNote">บันทึก</label><input id="tNote" placeholder="เช่น ข้าวกลางวัน" value="${esc(d.note || '')}" autocomplete="off"></div>
    </div>
    ${d.billId ? '<p class="hint">รายการนี้สร้างจากการจ่ายบิล</p>' : ''}
    ${isNew ? '' : '<button class="btn danger" id="delTx">ลบรายการ</button>'}
  `);

  const renderType = () => {
    document.querySelectorAll('#txType button').forEach((x) => x.classList.toggle('on', x.dataset.ttype === d.type));
    $('#tAmtWrap').className = `amount-input ${d.type === 'income' ? 'inc' : d.type === 'expense' ? 'exp' : ''}`;
    const transfer = d.type === 'transfer';
    $('#tCatWrap').hidden = transfer;
    $('#tToRow').hidden = !transfer;
    $('#tWalletLab').textContent = transfer ? 'จาก' : 'กระเป๋าเงิน';
    if (transfer) {
      const from = $('#tWallet').value;
      if (!d.toWalletId || d.toWalletId === from) d.toWalletId = (money.wallets.find((w) => w.id !== from) || {}).id || '';
      $('#tTo').innerHTML = wOpts(d.toWalletId, from);
      return;
    }
    if (!TX_CATS[d.category] || TX_CATS[d.category].type !== d.type) d.category = catsOf(d.type)[0][0];
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
  $('#tCats').addEventListener('click', (e) => {
    const c = e.target.closest('[data-tcat]');
    if (!c) return;
    d.category = c.dataset.tcat;
    document.querySelectorAll('#tCats .cat').forEach((x) => x.classList.toggle('on', x === c));
  });
  $('#tWallet').addEventListener('change', () => { if (d.type === 'transfer') renderType(); });
  $('#tTo').addEventListener('change', (e) => { d.toWalletId = e.target.value; });

  $('#saveTx').addEventListener('click', () => {
    const amount = num($('#tAmount').value);
    if (!(amount > 0)) { toast('กรุณาใส่จำนวนเงิน'); $('#tAmount').focus(); return; }
    const date = $('#tDate').value;
    if (!date) { toast('กรุณาเลือกวันที่'); return; }
    const out = {
      id: d.id || uid(), type: d.type, amount, walletId: $('#tWallet').value, date, note: $('#tNote').value.trim(),
    };
    if (d.type === 'transfer') {
      out.toWalletId = $('#tTo').value;
      if (!out.toWalletId || out.toWalletId === out.walletId) { toast('เพิ่มกระเป๋าเงินอีกใบเพื่อโอนเงิน'); return; }
    } else out.category = d.category;
    if (d.billId) { out.billId = d.billId; out.billYm = d.billYm; }
    const i = money.txns.findIndex((x) => x.id === out.id);
    if (i >= 0) money.txns[i] = out; else money.txns.push(out);
    money.prefs.lastWallet = out.walletId;
    saveMoney(); closeSheet(); render();
    toast(isNew ? 'เพิ่มรายการแล้ว' : 'บันทึกแล้ว');
  });
  const del = $('#delTx');
  if (del) del.addEventListener('click', () => {
    if (!confirm('ลบรายการนี้?')) return;
    money.txns = money.txns.filter((x) => x.id !== d.id);
    saveMoney(); closeSheet(); render(); toast('ลบแล้ว');
  });
  if (isNew) setTimeout(() => $('#tAmount') && $('#tAmount').focus(), 300);
}

/* ---------- Wallets ---------- */

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
  const d = w ? { ...w } : { name: '', type: 'bank', initial: '', excluded: false };
  const chips = Object.entries(WALLET_TYPES).map(([k, c]) =>
    `<button type="button" class="chip ${d.type === k ? 'on' : ''}" data-wtype="${k}">${c.icon} ${c.label}</button>`).join('');
  const used = w && money.txns.some((t) => t.walletId === w.id || t.toWalletId === w.id);
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ยกเลิก</button>
      <h2>${isNew ? 'เพิ่มกระเป๋าเงิน' : 'แก้ไขกระเป๋าเงิน'}</h2>
      <button class="link-btn strong" id="saveWallet">บันทึก</button>
    </div>
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
  });
  $('#saveWallet').addEventListener('click', () => {
    const name = $('#wName').value.trim();
    if (!name) { toast('กรุณาใส่ชื่อกระเป๋าเงิน'); $('#wName').focus(); return; }
    const raw = $('#wInit').value.trim();
    const initial = raw.startsWith('-') ? -num(raw.slice(1)) : num(raw);
    const out = { id: d.id || uid(), name, type: d.type, initial, excluded: $('#wExcl').checked };
    const i = money.wallets.findIndex((x) => x.id === out.id);
    if (i >= 0) money.wallets[i] = out; else money.wallets.push(out);
    saveMoney(); render(); walletSheet('edit');
    toast(isNew ? 'เพิ่มกระเป๋าเงินแล้ว' : 'บันทึกแล้ว');
  });
  const del = $('#delWallet');
  if (del) del.addEventListener('click', () => {
    if (money.wallets.length <= 1) { toast('ต้องมีกระเป๋าเงินอย่างน้อย 1 ใบ'); return; }
    if (!confirm(`ลบ "${w.name}"${used ? ' และรายการทั้งหมดของกระเป๋านี้' : ''}?`)) return;
    money.wallets = money.wallets.filter((x) => x.id !== w.id);
    money.txns = money.txns.filter((t) => t.walletId !== w.id && t.toWalletId !== w.id);
    money.budgets.forEach((bg) => { if (bg.walletId === w.id) bg.walletId = 'total'; });
    if (ui.wallet === w.id) ui.wallet = 'total';
    if (money.prefs.billWallet === w.id) delete money.prefs.billWallet;
    saveMoney(); render(); walletSheet('edit'); toast('ลบแล้ว');
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
    <div class="card acct">
      <div class="avatar">👤</div>
      <div><b>บัญชีของฉัน</b><div class="muted small">ข้อมูลทั้งหมดเก็บในเครื่องนี้เท่านั้น</div></div>
    </div>
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
  if (tx) { const x = money.txns.find((y) => y.id === tx.dataset.tx); if (x) txnForm(x); return true; }
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
    case 'wallet-pick': walletSheet('pick'); break;
    case 'wallets': walletSheet('edit'); break;
    case 'add-wallet': walletForm(); break;
    case 'toggle-hide': money.prefs.hideBalance = !money.prefs.hideBalance; saveMoney(); render(); break;
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
    case 'edit-budget': { const bg = money.budgets.find((x) => x.id === el.dataset.id); if (bg) budgetForm(bg); break; }
    default: return false;
  }
  return true;
}
