'use strict';

/* ---------- Constants ---------- */

const STORAGE_KEY = 'billplanner.v1';

const CATEGORIES = {
  credit:    { label: 'บัตรเครดิต', icon: '💳', color: '#7c5cff' },
  electric:  { label: 'ค่าไฟ',      icon: '⚡', color: '#f5a623' },
  water:     { label: 'ค่าน้ำ',      icon: '💧', color: '#2fa8ff' },
  internet:  { label: 'อินเทอร์เน็ต', icon: '📶', color: '#00b3a4' },
  phone:     { label: 'ค่าโทรศัพท์', icon: '📱', color: '#4f6bed' },
  loan:      { label: 'ผ่อนชำระ',   icon: '🏦', color: '#e0552b' },
  insurance: { label: 'ประกัน',     icon: '🛡️', color: '#1a9e5c' },
  rent:      { label: 'ค่าเช่า/ส่วนกลาง', icon: '🏠', color: '#b26a3c' },
  subscription: { label: 'สมาชิกรายเดือน', icon: '🎬', color: '#e83e8c' },
  other:     { label: 'อื่นๆ',      icon: '🧾', color: '#8a8f99' },
};

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/* ---------- State ---------- */

const defaultState = () => ({
  bills: [],
  // records["YYYY-MM"][billId] = { amount?: number, paid?: boolean, paidAt?: ISO string }
  records: {},
  settings: { remindDays: 3, payday: 25 },
});

let state = load();
const ui = {
  tab: 'home',          // home | txns | bills | budgets | account
  billView: 'month',    // month | calendar | list (inside the bills tab)
  ym: ymOf(new Date()),
  selDay: null,
  wallet: 'total',
  period: 'this',
  search: '',
  searchOpen: false,
  reportType: 'expense',
  budgetOff: 0,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    return {
      bills: Array.isArray(s.bills) ? s.bills : [],
      records: s.records && typeof s.records === 'object' ? s.records : {},
      settings: { ...d.settings, ...(s.settings || {}) },
    };
  } catch (e) {
    return defaultState();
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('บันทึกข้อมูลไม่สำเร็จ');
  }
  updateBadge();
}

/* ---------- Date helpers ---------- */

function pad(n) { return String(n).padStart(2, '0'); }
function ymOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function parseYm(ym) { const [y, m] = ym.split('-').map(Number); return { y, m }; }
function addMonths(ym, n) {
  const { y, m } = parseYm(ym);
  return ymOf(new Date(y, m - 1 + n, 1));
}
function daysInMonth(ym) { const { y, m } = parseYm(ym); return new Date(y, m, 0).getDate(); }
function monthDiff(a, b) { const A = parseYm(a), B = parseYm(b); return (B.y - A.y) * 12 + (B.m - A.m); }
function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function thMonthYear(ym) { const { y, m } = parseYm(ym); return `${TH_MONTHS[m - 1]} ${y + 543}`; }
function thShortDate(d) { return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]}`; }
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

/* ---------- Money ---------- */

const fmt = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
function baht(n) { return `฿${fmt.format(n || 0)}`; }
function num(v) {
  const n = parseFloat(String(v).replace(/[,\s฿]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/* ---------- Domain ---------- */

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function billEndMonth(b) {
  if (b.type === 'installment' && b.months > 0) return addMonths(b.startMonth, b.months - 1);
  return null;
}

function billAppliesTo(b, ym) {
  if (b.type === 'once') return (b.onceDate || '').slice(0, 7) === ym;
  if (b.startMonth && ym < b.startMonth) return false;
  const end = billEndMonth(b);
  if (end && ym > end) return false;
  return true;
}

function dueDateFor(b, ym) {
  const { y, m } = parseYm(ym);
  if (b.type === 'once') {
    const [yy, mm, dd] = b.onceDate.split('-').map(Number);
    return new Date(yy, mm - 1, dd);
  }
  return new Date(y, m - 1, Math.min(b.dueDay || 1, daysInMonth(ym)));
}

function record(ym, id) { return (state.records[ym] || {})[id] || {}; }
function setRecord(ym, id, patch) {
  state.records[ym] = state.records[ym] || {};
  const next = { ...record(ym, id), ...patch };
  Object.keys(next).forEach((k) => next[k] === undefined && delete next[k]);
  if (Object.keys(next).length) state.records[ym][id] = next;
  else delete state.records[ym][id];
  if (!Object.keys(state.records[ym]).length) delete state.records[ym];
}

function occurrences(ym) {
  const t = today();
  const remind = state.settings.remindDays;
  return state.bills
    .filter((b) => billAppliesTo(b, ym))
    .map((b) => {
      const rec = record(ym, b.id);
      const due = dueDateFor(b, ym);
      const amount = rec.amount != null ? rec.amount : (b.amount || 0);
      const needsAmount = rec.amount == null && (b.variable || !!b.pea);
      const paid = !!rec.paid;
      const daysLeft = daysBetween(t, due);
      let status = 'upcoming';
      if (paid) status = 'paid';
      else if (daysLeft < 0) status = 'overdue';
      else if (daysLeft <= remind) status = 'soon';
      const inst = b.type === 'installment' ? { n: monthDiff(b.startMonth, ym) + 1, of: b.months } : null;
      return { bill: b, ym, due, amount, needsAmount, paid, paidAt: rec.paidAt, status, daysLeft, inst };
    })
    .sort((a, b) => a.due - b.due || a.bill.name.localeCompare(b.bill.name, 'th'));
}

function statusBadge(o) {
  if (o.status === 'paid') return `<span class="badge ok">จ่ายแล้ว</span>`;
  if (o.bill.autopay) return `<span class="badge muted">ตัดอัตโนมัติ</span>`;
  if (o.status === 'overdue') return `<span class="badge bad">เลยกำหนด ${-o.daysLeft} วัน</span>`;
  if (o.daysLeft === 0) return `<span class="badge bad">ครบกำหนดวันนี้</span>`;
  if (o.status === 'soon') return `<span class="badge warn">อีก ${o.daysLeft} วัน</span>`;
  return '';
}

/* ---------- Rendering ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cat(b) { return CATEGORIES[b.category] || CATEGORIES.other; }

function icoHtml(b, cls = 'ico') {
  const c = cat(b);
  return `<div class="${cls}" style="background:${c.color}22">${c.icon}</div>`;
}

function render() {
  const bills = ui.tab === 'bills';
  const nav = bills && ui.billView !== 'list';
  document.body.classList.toggle('with-topbar', bills);
  $('.topbar').hidden = !bills;
  $('.topbar').classList.toggle('hide-nav', !nav);
  $('#monthTitle').textContent = nav ? thMonthYear(ui.ym) : 'บิลทั้งหมด';
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const fab = $('#addBtn');
  fab.hidden = ui.tab === 'account';
  fab.classList.toggle('ext', ui.tab === 'home' && !ui.fabMini);
  fab.setAttribute('aria-label', bills ? 'เพิ่มบิล' : 'เพิ่มรายการ');
  $('#addLabel').textContent = bills ? 'เพิ่มบิล' : 'เพิ่มรายการ';
  if (ui.tab === 'home') renderHome();
  else if (ui.tab === 'txns') renderTxns();
  else if (ui.tab === 'budgets') renderBudgets();
  else if (ui.tab === 'account') renderSettings();
  else {
    if (ui.billView === 'month') renderMonth();
    else if (ui.billView === 'calendar') renderCalendar();
    else renderBills();
    view.insertAdjacentHTML('afterbegin', `<div class="seg bill-seg">${[['month', 'เดือนนี้'], ['calendar', 'ปฏิทิน'], ['list', 'บิลทั้งหมด']]
      .map(([k, l]) => `<button data-billview="${k}" class="${ui.billView === k ? 'on' : ''}">${l}</button>`).join('')}</div>`);
  }
}

function setTab(tab) {
  ui.tab = tab;
  ui.fabMini = false;
  window.scrollTo(0, 0);
  render();
}

function occItem(o) {
  const b = o.bill;
  const dueTxt = `ครบกำหนด ${thShortDate(o.due)}`;
  const extra = [o.inst ? `งวด ${o.inst.n}/${o.inst.of}` : '', b.note ? esc(b.note) : ''].filter(Boolean).join(' · ');
  const amt = o.needsAmount ? `<span class="badge warn">${b.pea ? '⚡ ดึงยอด' : 'ระบุยอด'}</span>` : baht(o.amount);
  return `
    <div class="item ${o.paid ? 'paid' : ''}" data-occ="${b.id}" data-ym="${o.ym}" role="button" tabindex="0">
      ${icoHtml(b)}
      <div class="main">
        <div class="name">${esc(b.name)}</div>
        <div class="sub">${dueTxt}${extra ? ' · ' + extra : ''}</div>
        ${statusBadge(o)}
      </div>
      <div class="right"><div class="amt">${amt}</div></div>
      <button class="check ${o.paid ? 'on' : ''}" data-toggle="${b.id}" data-ym="${o.ym}" aria-label="${o.paid ? 'ยกเลิกจ่ายแล้ว' : 'ทำเครื่องหมายว่าจ่ายแล้ว'}">${o.paid ? '✓' : ''}</button>
    </div>`;
}

function renderMonth() {
  const occ = occurrences(ui.ym);
  if (!state.bills.length) {
    view.innerHTML = emptyState();
    return;
  }
  const total = occ.reduce((s, o) => s + o.amount, 0);
  const paid = occ.filter((o) => o.paid).reduce((s, o) => s + o.amount, 0);
  const left = total - paid;
  const pct = total ? Math.round((paid / total) * 100) : 0;
  const firstHalf = occ.filter((o) => !o.paid && o.due.getDate() <= 15).reduce((s, o) => s + o.amount, 0);
  const secondHalf = occ.filter((o) => !o.paid && o.due.getDate() > 15).reduce((s, o) => s + o.amount, 0);

  const overdue = occ.filter((o) => o.status === 'overdue' && !o.bill.autopay);
  const soon = occ.filter((o) => o.status === 'soon' && !o.bill.autopay);
  const missing = occ.filter((o) => o.needsAmount && !o.paid && !o.bill.pea);
  const peaDue = occ.filter((o) => o.needsAmount && !o.paid && o.bill.pea);

  let alerts = '';
  if (overdue.length) alerts += `<div class="alert bad">⚠️<div>เลยกำหนดชำระ ${overdue.length} รายการ รวม ${baht(overdue.reduce((s, o) => s + o.amount, 0))}</div></div>`;
  if (soon.length) alerts += `<div class="alert warn">⏰<div>ใกล้ครบกำหนดภายใน ${state.settings.remindDays} วัน: ${soon.map((o) => esc(o.bill.name)).join(', ')}</div></div>`;
  if (missing.length) alerts += `<div class="alert warn">✏️<div>ยังไม่ได้ระบุยอดเดือนนี้: ${missing.map((o) => esc(o.bill.name)).join(', ')}</div></div>`;
  if (peaDue.length) alerts += `<div class="alert warn">⚡<div>ถึงรอบบิลค่าไฟ กดที่บิลเพื่อดึงยอดเดือนนี้จาก PEA: ${peaDue.map((o) => esc(o.bill.name)).join(', ')}</div></div>`;

  alerts += `<button class="btn ghost gmail-btn" data-action="gmail">📧 ดึงบิลค่าโทรศัพท์จาก Gmail</button>`;

  const unpaid = occ.filter((o) => !o.paid);
  const done = occ.filter((o) => o.paid);

  view.innerHTML = `
    <div class="card summary">
      <div class="label">ยอดบิลทั้งเดือน</div>
      <div class="big">${baht(total)}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="row">
        <div class="stat paid"><span>จ่ายแล้ว</span><b>${baht(paid)}</b></div>
        <div class="stat left"><span>คงเหลือต้องจ่าย</span><b>${baht(left)}</b></div>
      </div>
    </div>
    ${alerts}
    <div class="halves">
      <div class="card"><div class="label">ต้องเตรียม วันที่ 1–15</div><b>${baht(firstHalf)}</b></div>
      <div class="card"><div class="label">ต้องเตรียม วันที่ 16–${daysInMonth(ui.ym)}</div><b>${baht(secondHalf)}</b></div>
    </div>
    <div class="section-title">ยังไม่จ่าย (${unpaid.length})</div>
    ${unpaid.length ? `<div class="list">${unpaid.map(occItem).join('')}</div>` : `<div class="card muted" style="text-align:center">🎉 จ่ายครบทุกบิลแล้วเดือนนี้</div>`}
    ${done.length ? `<div class="section-title">จ่ายแล้ว (${done.length})</div><div class="list">${done.map(occItem).join('')}</div>` : ''}
  `;
  if (!occ.length) {
    view.innerHTML = `<div class="empty"><div class="e-ico">🗓️</div>ไม่มีบิลในเดือนนี้</div>`;
  }
}

function emptyState() {
  return `
    <div class="empty">
      <div class="e-ico">🧾</div>
      <div style="font-weight:600;color:var(--text);font-size:18px">ยังไม่มีบิล</div>
      <div>เพิ่มบัตรเครดิต ค่าน้ำ ค่าไฟ หรือบิลอื่นๆ เพื่อเริ่มวางแผน</div>
      <div style="margin-top:20px"><button class="btn" data-action="add">＋ เพิ่มบิลแรก</button></div>
      <button class="btn ghost" data-action="sample">ลองใช้ข้อมูลตัวอย่าง</button>
    </div>
    ${installTip()}`;
}

function renderCalendar() {
  const occ = occurrences(ui.ym);
  const { y, m } = parseYm(ui.ym);
  const first = new Date(y, m - 1, 1).getDay();
  const dim = daysInMonth(ui.ym);
  const t = today();
  const byDay = {};
  occ.forEach((o) => { (byDay[o.due.getDate()] = byDay[o.due.getDate()] || []).push(o); });

  if (ui.selDay == null || ui.selDay > dim) {
    ui.selDay = ymOf(t) === ui.ym ? t.getDate() : (occ[0] ? occ[0].due.getDate() : 1);
  }

  let cells = TH_DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < first; i++) cells += `<div class="cal-day blank"></div>`;
  for (let d = 1; d <= dim; d++) {
    const isToday = ymOf(t) === ui.ym && t.getDate() === d;
    const dots = (byDay[d] || []).slice(0, 4).map((o) => {
      const cls = o.status === 'paid' ? 'paid' : o.status === 'overdue' ? 'over' : o.status === 'soon' ? 'soon' : '';
      return `<span class="dot ${cls}"></span>`;
    }).join('');
    cells += `<button class="cal-day ${isToday ? 'today' : ''} ${ui.selDay === d ? 'sel' : ''}" data-day="${d}">
      <span class="n">${d}</span><span class="dots">${dots}</span></button>`;
  }

  const sel = byDay[ui.selDay] || [];
  const selDate = new Date(y, m - 1, ui.selDay);
  const selTotal = sel.reduce((s, o) => s + o.amount, 0);
  view.innerHTML = `
    <div class="cal">
      <div class="cal-grid">${cells}</div>
      <div class="legend">
        <span><i class="dot"></i>รอจ่าย</span><span><i class="dot soon"></i>ใกล้ครบกำหนด</span>
        <span><i class="dot over"></i>เลยกำหนด</span><span><i class="dot paid"></i>จ่ายแล้ว</span>
      </div>
    </div>
    <div class="section-title">${thShortDate(selDate)} ${y + 543}${sel.length ? ` · ${baht(selTotal)}` : ''}</div>
    ${sel.length ? `<div class="list">${sel.map(occItem).join('')}</div>` : `<div class="card muted" style="text-align:center">ไม่มีบิลครบกำหนดวันนี้</div>`}
  `;
}

function renderBills() {
  if (!state.bills.length) { view.innerHTML = emptyState(); return; }
  const groups = {};
  state.bills.forEach((b) => { (groups[b.category] = groups[b.category] || []).push(b); });
  const monthlyTotal = state.bills
    .filter((b) => b.type !== 'once' && billAppliesTo(b, ymOf(new Date())))
    .reduce((s, b) => s + (b.amount || 0), 0);
  let html = `<div class="card summary"><div class="label">ประมาณการรายจ่ายประจำต่อเดือน</div><div class="big">${baht(monthlyTotal)}</div>
    <div class="label small">${state.bills.length} รายการ · บิลยอดไม่แน่นอนคิดจากยอดประมาณ</div></div>`;
  Object.keys(CATEGORIES).forEach((k) => {
    const list = groups[k];
    if (!list) return;
    html += `<div class="section-title">${CATEGORIES[k].icon} ${CATEGORIES[k].label}</div><div class="list">`;
    list.sort((a, b) => (a.dueDay || 0) - (b.dueDay || 0)).forEach((b) => {
      html += `
        <button class="item" data-edit="${b.id}">
          ${icoHtml(b)}
          <div class="main"><div class="name">${esc(b.name)}</div><div class="sub">${billScheduleText(b)}</div></div>
          <div class="right"><div class="amt">${b.variable && !b.amount ? '<span class="muted small">ไม่แน่นอน</span>' : baht(b.amount)}</div>
          ${b.autopay ? '<span class="badge muted">ตัดอัตโนมัติ</span>' : ''}</div>
        </button>`;
    });
    html += `</div>`;
  });
  view.innerHTML = html;
}

function billScheduleText(b) {
  if (b.type === 'once') {
    const [y, m, d] = b.onceDate.split('-').map(Number);
    return `ครั้งเดียว ${d} ${TH_MONTHS_SHORT[m - 1]} ${y + 543}`;
  }
  let s = `ทุกวันที่ ${b.dueDay}`;
  if (b.type === 'installment') {
    const end = parseYm(billEndMonth(b));
    s += ` · ${b.months} งวด ถึง ${TH_MONTHS_SHORT[end.m - 1]} ${String(end.y + 543).slice(2)}`;
  }
  if (b.variable) s += ' · ยอดไม่แน่นอน';
  return s;
}

function installTip() {
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) return '';
  return `
    <div class="card install-tip">
      <b>📲 ติดตั้งเป็นแอปบน iPhone</b>
      <ol>
        <li>เปิดหน้านี้ใน Safari</li>
        <li>แตะปุ่ม <b>แชร์</b> (สี่เหลี่ยมมีลูกศรขึ้น)</li>
        <li>เลือก <b>เพิ่มไปยังหน้าจอโฮม</b></li>
      </ol>
      <div class="muted small" style="margin-top:6px">ใช้งานแบบออฟไลน์ได้ ข้อมูลเก็บไว้ในเครื่องของคุณเท่านั้น</div>
    </div>`;
}

function renderSettings() {
  const s = state.settings;
  view.innerHTML = `
    ${accountTop()}
    <div class="section-title">การแจ้งเตือน</div>
    <div class="form">
      <div class="field"><label for="remindDays">เตือนล่วงหน้า</label>
        <select id="remindDays">${[0, 1, 2, 3, 5, 7].map((n) => `<option value="${n}" ${s.remindDays === n ? 'selected' : ''}>${n === 0 ? 'วันครบกำหนด' : n + ' วัน'}</option>`).join('')}</select>
      </div>
    </div>
    <p class="hint">แอปจะแสดงบิลที่ใกล้ครบกำหนดเมื่อเปิดแอป และแสดงตัวเลขบนไอคอน (iOS 16.4 ขึ้นไป เมื่อติดตั้งที่หน้าจอโฮม)</p>
    <button class="btn" data-action="ics">📆 เพิ่มการเตือนลงปฏิทิน iPhone</button>
    <p class="hint">สร้างไฟล์ปฏิทิน (.ics) ของบิลทั้งหมด พร้อมเสียงเตือนก่อนวันครบกำหนดตามที่ตั้งไว้ เปิดไฟล์แล้วเลือก "เพิ่มทั้งหมด" ในแอปปฏิทิน · หากแก้ไขบิล ให้ลบปฏิทินเดิมแล้วสร้างใหม่</p>

    <div class="section-title">เชื่อมบัญชี</div>
    <button class="btn ghost" data-action="gmail">📧 ดึงบิลค่าโทรศัพท์จาก Gmail</button>
    <p class="hint">ค้นหาใบแจ้งค่าบริการจาก AIS, True, dtac, 3BB, NT ใน Gmail แล้วเพิ่มยอดและวันครบกำหนดเข้าบิลให้อัตโนมัติ</p>

    <div class="section-title">สำรองข้อมูล</div>
    <button class="btn ghost" data-action="export">⬇️ ส่งออกข้อมูล (JSON)</button>
    <button class="btn ghost" data-action="import">⬆️ นำเข้าข้อมูล</button>
    <input type="file" id="importFile" accept="application/json,.json" hidden>
    <p class="hint">ข้อมูลทั้งหมดเก็บในเครื่องนี้ (localStorage) ไม่มีการส่งไปที่ใด ควรส่งออกเก็บไว้เป็นระยะ</p>

    ${installTip()}

    <div class="section-title">อื่นๆ</div>
    <button class="btn danger" data-action="reset">ลบข้อมูลทั้งหมด</button>
    <p class="hint" style="text-align:center">วางแผนจ่ายบิล · เวอร์ชัน 2.0</p>
  `;
  $('#billWallet').addEventListener('change', (e) => {
    money.prefs.billWallet = e.target.value;
    saveMoney();
    toast('บันทึกแล้ว');
  });
  $('#remindDays').addEventListener('change', (e) => {
    state.settings.remindDays = Number(e.target.value);
    save();
    toast('บันทึกแล้ว');
  });
  $('#importFile').addEventListener('change', importData);
}

/* ---------- Sheets ---------- */

function openSheet(html) {
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="grabber"></div>${html}`;
  sheet.hidden = false;
  $('#backdrop').hidden = false;
  sheet.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
  document.body.style.overflow = '';
}

/* ---------- PEA electricity bill lookup ---------- */

// Convert a PEA billperiod into our "YYYY-MM". PEA tends to send 6-digit YYYYMM
// (Gregorian or Buddhist year); also tolerate "YYYY-MM", "MM/YYYY", ISO dates.
function peaPeriodToYm(p) {
  if (p == null) return null;
  const s = String(p).trim();
  let y, m;
  let mm = s.match(/^(\d{4})[-/.](\d{1,2})$/);          // YYYY-MM
  if (mm) { y = +mm[1]; m = +mm[2]; }
  else if ((mm = s.match(/^(\d{1,2})[-/.](\d{4})$/))) { m = +mm[1]; y = +mm[2]; } // MM/YYYY
  else if ((mm = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +mm[1]; m = +mm[2]; } // YYYYMMDD (PEA mrdate)
  else if ((mm = s.match(/^(\d{4})(\d{2})$/))) { y = +mm[1]; m = +mm[2]; }        // YYYYMM
  else if ((mm = s.match(/^(\d{4})-(\d{2})-\d{2}/))) { y = +mm[1]; m = +mm[2]; }  // ISO date
  else if ((mm = s.match(/^(\S+)\s+(\d{4})$/))) {                                  // "ต.ค. 2569"
    const i = TH_MONTHS_SHORT.indexOf(mm[1]) >= 0 ? TH_MONTHS_SHORT.indexOf(mm[1]) : TH_MONTHS.indexOf(mm[1]);
    if (i < 0) return null;
    m = i + 1; y = +mm[2];
  }
  else return null;
  if (y > 2400) y -= 543;                                // Buddhist -> Gregorian
  if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) return null;
  return `${y}-${pad(m)}`;
}

// Pull a money amount from a PEA row regardless of exact field casing.
function peaRowAmount(row) {
  if (!row || typeof row !== 'object') return null;
  const keys = ['totalAmountInv', 'totalamountinv', 'totalAmount', 'totalamount',
    'amount', 'netAmount', 'netamount'];
  for (const k of keys) if (row[k] != null && row[k] !== '') return num(row[k]);
  return null;
}

async function fetchPeaBills(ca, peano) {
  const res = await fetch('/api/pea-bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ca: String(ca).trim(), peano: String(peano).trim(), lang: 'th' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.result) throw new Error((data && data.message) || 'ไม่พบข้อมูลค่าไฟ');
  const rows = Array.isArray(data.data) ? data.data : [];
  // Newest period first, with our parsed month and amount attached.
  // PEA's billperiod is Thai text ("ต.ค. 2569"); mrdate (YYYYMMDD) is the reliable month.
  // PEA lists oldest first, so the row position breaks ties when a month can't be read.
  return rows
    .map((r, i) => ({
      raw: r,
      i,
      ym: peaPeriodToYm(r.mrdate) || peaPeriodToYm(r.billperiod ?? r.billPeriod ?? r.period),
      amount: peaRowAmount(r),
    }))
    .sort((a, b2) => (a.ym && b2.ym && a.ym !== b2.ym ? (a.ym < b2.ym ? 1 : -1) : b2.i - a.i));
}

// Write fetched monthly amounts into a bill's records (keeps paid status).
function applyPeaRows(billId, rows) {
  let n = 0;
  rows.forEach((r) => {
    if (!r.ym || r.amount == null) return;
    const prev = record(r.ym, billId);
    setRecord(r.ym, billId, { amount: r.amount, pea: true });
    const tx = billTxn(billId, r.ym);
    if (tx && prev.paid) { tx.amount = r.amount; }
    n++;
  });
  return n;
}

function billForm(b) {
  const isNew = !b;
  b = b || {
    category: 'credit', type: 'monthly', dueDay: 25, amount: '', variable: true,
    startMonth: ui.ym, months: 12, onceDate: `${ui.ym}-${pad(Math.min(today().getDate(), daysInMonth(ui.ym)))}`,
  };
  const draft = { ...b };

  const chips = Object.entries(CATEGORIES).map(([k, c]) =>
    `<button type="button" class="chip ${draft.category === k ? 'on' : ''}" data-cat="${k}">${c.icon} ${c.label}</button>`).join('');

  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ยกเลิก</button>
      <h2>${isNew ? 'เพิ่มบิล' : 'แก้ไขบิล'}</h2>
      <button class="link-btn strong" id="saveBill">บันทึก</button>
    </div>
    <div class="chips" id="catChips">${chips}</div>
    <div class="form">
      <div class="field"><label for="fName">ชื่อบิล</label><input id="fName" placeholder="เช่น KBank, กฟน." value="${esc(draft.name || '')}" autocomplete="off"></div>
      <div class="field"><label for="fAmount">ยอดเงิน (฿)</label><input id="fAmount" inputmode="decimal" placeholder="0" value="${draft.amount === '' || draft.amount == null ? '' : draft.amount}"></div>
      <div class="field"><label for="fVariable">ยอดไม่แน่นอน</label>
        <span style="flex:1"></span><label class="switch"><input type="checkbox" id="fVariable" ${draft.variable ? 'checked' : ''}><span></span></label></div>
    </div>
    <p class="hint">เปิด "ยอดไม่แน่นอน" สำหรับบัตรเครดิต ค่าน้ำ ค่าไฟ แล้วกรอกยอดจริงในแต่ละเดือน ยอดด้านบนจะใช้เป็นยอดประมาณ</p>

    <div id="peaFields"></div>

    <div class="seg" id="typeSeg">
      <button type="button" data-type="monthly">ทุกเดือน</button>
      <button type="button" data-type="installment">ผ่อนเป็นงวด</button>
      <button type="button" data-type="once">ครั้งเดียว</button>
    </div>
    <div class="form" id="schedFields"></div>

    <div class="form">
      <div class="field"><label for="fAutopay">ตัดบัญชีอัตโนมัติ</label>
        <span style="flex:1"></span><label class="switch"><input type="checkbox" id="fAutopay" ${draft.autopay ? 'checked' : ''}><span></span></label></div>
      <div class="field col"><label for="fNote">บันทึก</label><textarea id="fNote" placeholder="เช่น เลขบัญชี, วันตัดรอบบัตร">${esc(draft.note || '')}</textarea></div>
    </div>
    ${isNew ? '' : `<button class="btn danger" id="delBill">ลบบิลนี้</button>`}
  `);

  const renderSched = () => {
    document.querySelectorAll('#typeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.type === draft.type));
    const days = Array.from({ length: 31 }, (_, i) => i + 1)
      .map((d) => `<option value="${d}" ${Number(draft.dueDay) === d ? 'selected' : ''}>วันที่ ${d}</option>`).join('');
    let html = '';
    if (draft.type === 'once') {
      html = `<div class="field"><label for="fOnce">วันครบกำหนด</label><input type="date" id="fOnce" value="${draft.onceDate}"></div>`;
    } else {
      html = `<div class="field"><label for="fDue">ครบกำหนด</label><select id="fDue">${days}</select></div>
        <div class="field"><label for="fStart">เริ่มเดือน</label><input type="month" id="fStart" value="${draft.startMonth || ui.ym}"></div>`;
      if (draft.type === 'installment') {
        html += `<div class="field"><label for="fMonths">จำนวนงวด</label><input id="fMonths" inputmode="numeric" value="${draft.months || 12}"></div>`;
      }
    }
    $('#schedFields').innerHTML = html;
  };
  renderSched();

  const sync = () => {
    draft.name = $('#fName').value.trim();
    draft.amount = $('#fAmount').value;
    draft.variable = $('#fVariable').checked;
    draft.autopay = $('#fAutopay').checked;
    draft.note = $('#fNote').value.trim();
    if ($('#fDue')) draft.dueDay = Number($('#fDue').value);
    if ($('#fStart')) draft.startMonth = $('#fStart').value || ui.ym;
    if ($('#fMonths')) draft.months = parseInt($('#fMonths').value, 10) || 1;
    if ($('#fOnce')) draft.onceDate = $('#fOnce').value;
    if ($('#fPeaCa')) draft.pea = { ca: $('#fPeaCa').value.trim(), peano: $('#fPeaNo') ? $('#fPeaNo').value.trim() : '' };
  };

  // Rows last fetched from PEA, written into records when the bill is saved.
  let peaRows = null;

  const renderPeaResult = (rows) => {
    const box = $('#peaResult');
    if (!box) return;
    if (!rows || !rows.length) { box.innerHTML = '<p class="hint">ไม่พบข้อมูลย้อนหลัง</p>'; return; }
    const items = rows.map((r) => {
      const label = r.ym ? thMonthYear(r.ym) : esc(String(r.raw.billperiod ?? r.raw.billPeriod ?? ''));
      return `<div class="kv"><span>${label}</span><span>${r.amount != null ? baht(r.amount) : '-'}</span></div>`;
    }).join('');
    box.innerHTML = `<div class="form history">${items}</div><p class="hint">กด "บันทึก" เพื่อเติมยอดเหล่านี้เข้าบิลแต่ละเดือน</p>`;
  };

  const onPeaFetch = async () => {
    sync();
    const ca = ($('#fPeaCa').value || '').trim();
    const peano = ($('#fPeaNo').value || '').trim();
    if (!ca || !peano) { toast('กรอกหมายเลขผู้ใช้ไฟฟ้าและรหัสเครื่องวัดก่อน'); return; }
    const btn = $('#peaFetch');
    btn.disabled = true; btn.textContent = 'กำลังดึงข้อมูล…';
    try {
      const rows = await fetchPeaBills(ca, peano);
      peaRows = rows;
      const latest = rows.find((r) => r.amount != null);
      if (latest && $('#fAmount')) { $('#fAmount').value = latest.amount; draft.amount = String(latest.amount); }
      renderPeaResult(rows);
      toast(latest ? `ยอดล่าสุด ${baht(latest.amount)}` : 'ดึงข้อมูลแล้ว');
    } catch (err) {
      const box = $('#peaResult');
      if (box) box.innerHTML = `<p class="hint pea-err">ดึงไม่สำเร็จ: ${esc(err.message || 'ลองใหม่อีกครั้ง')}</p>`;
      toast('ดึงยอดค่าไฟไม่สำเร็จ');
    } finally {
      btn.disabled = false; btn.textContent = '⚡ ดึงยอดค่าไฟจาก PEA';
    }
  };

  const renderPea = () => {
    const box = $('#peaFields');
    if (!box) return;
    if (draft.category !== 'electric') { box.innerHTML = ''; return; }
    const p = draft.pea || {};
    box.innerHTML = `
      <div class="section-title">⚡ เชื่อมกับการไฟฟ้าส่วนภูมิภาค (PEA)</div>
      <div class="form">
        <div class="field"><label for="fPeaCa">หมายเลขผู้ใช้ไฟฟ้า</label><input id="fPeaCa" inputmode="numeric" placeholder="เลข 12 หลักบนใบแจ้งค่าไฟ" value="${esc(p.ca || '')}" autocomplete="off"></div>
        <div class="field"><label for="fPeaNo">รหัสเครื่องวัด</label><input id="fPeaNo" inputmode="numeric" placeholder="เลขมิเตอร์บนใบแจ้งค่าไฟ" value="${esc(p.peano || '')}" autocomplete="off"></div>
      </div>
      <button class="btn" id="peaFetch" type="button">⚡ ดึงยอดค่าไฟจาก PEA</button>
      <div id="peaResult"></div>
      <p class="hint">ดึงยอดค่าไฟย้อนหลังได้สูงสุด 6 เดือนจากเว็บ กฟภ. โดยตรง ไม่ต้องล็อกอิน · ตั้ง "ชื่อบิล" เป็นชื่อบ้าน เช่น บ้านหลังใหญ่ เพื่อแยกหลายมิเตอร์</p>
    `;
    $('#peaFetch').addEventListener('click', onPeaFetch);
  };
  renderPea();

  $('#catChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]');
    if (!c) return;
    draft.category = c.dataset.cat;
    document.querySelectorAll('#catChips .chip').forEach((x) => x.classList.toggle('on', x === c));
    if (['credit', 'electric', 'water'].includes(draft.category) && isNew) $('#fVariable').checked = true;
    if (['loan', 'insurance', 'rent', 'subscription', 'internet'].includes(draft.category) && isNew) $('#fVariable').checked = false;
    if (draft.category === 'loan' && isNew && draft.type === 'monthly') { sync(); draft.type = 'installment'; renderSched(); }
    renderPea();
  });
  $('#typeSeg').addEventListener('click', (e) => {
    const t = e.target.closest('[data-type]');
    if (!t) return;
    sync();
    draft.type = t.dataset.type;
    renderSched();
  });
  $('#saveBill').addEventListener('click', () => {
    sync();
    if (!draft.name) { toast('กรุณาใส่ชื่อบิล'); $('#fName').focus(); return; }
    if (draft.type === 'once' && !draft.onceDate) { toast('กรุณาเลือกวันครบกำหนด'); return; }
    const out = {
      id: draft.id || uid(),
      name: draft.name,
      category: draft.category,
      amount: num(draft.amount),
      variable: !!draft.variable,
      autopay: !!draft.autopay,
      type: draft.type,
      note: draft.note,
    };
    if (draft.type === 'once') out.onceDate = draft.onceDate;
    else {
      out.dueDay = Math.min(31, Math.max(1, draft.dueDay || 1));
      out.startMonth = draft.startMonth || ui.ym;
      if (draft.type === 'installment') out.months = Math.max(1, draft.months || 1);
    }
    if (draft.category === 'electric' && draft.pea && (draft.pea.ca || draft.pea.peano)) {
      out.pea = { ca: draft.pea.ca || '', peano: draft.pea.peano || '' };
    }
    const i = state.bills.findIndex((x) => x.id === out.id);
    if (i >= 0) state.bills[i] = out; else state.bills.push(out);
    let filled = 0;
    if (out.pea && peaRows && peaRows.length) filled = applyPeaRows(out.id, peaRows);
    save();
    saveMoney();
    closeSheet();
    render();
    toast(filled ? `บันทึกและเติมยอดค่าไฟ ${filled} เดือน` : (isNew ? 'เพิ่มบิลแล้ว' : 'บันทึกแล้ว'));
  });
  const del = $('#delBill');
  if (del) {
    del.addEventListener('click', () => {
      if (!confirm(`ลบ "${b.name}" และประวัติการจ่ายทั้งหมดของบิลนี้?`)) return;
      state.bills = state.bills.filter((x) => x.id !== b.id);
      Object.keys(state.records).forEach((ym) => setRecord(ym, b.id, { amount: undefined, paid: undefined, paidAt: undefined }));
      // Payments already made stay in the wallets as ordinary expenses.
      money.txns.forEach((t) => { if (t.billId === b.id) { delete t.billId; delete t.billYm; } });
      save();
      saveMoney();
      closeSheet();
      render();
      toast('ลบแล้ว');
    });
  }
  if (isNew) setTimeout(() => $('#fName') && $('#fName').focus(), 300);
}

function occurrenceSheet(id, ym) {
  const b = state.bills.find((x) => x.id === id);
  if (!b) return;
  const o = occurrences(ym).find((x) => x.bill.id === id);
  const rec = record(ym, id);
  const c = cat(b);
  const peaNeeded = !!b.pea && rec.amount == null && !o.paid;

  const history = [];
  for (let i = 1; i <= 6; i++) {
    const pm = addMonths(ym, -i);
    if (!billAppliesTo(b, pm)) continue;
    const r = record(pm, id);
    const amt = r.amount != null ? r.amount : b.amount;
    history.push(`<div class="kv"><span>${thMonthYear(pm)}</span><span>${baht(amt)} ${r.paid ? '✅' : '<span class="badge muted">ยังไม่จ่าย</span>'}</span></div>`);
  }

  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>${thMonthYear(ym)}</h2>
      <button class="link-btn" data-edit="${b.id}">แก้ไขบิล</button>
    </div>
    <div class="detail-head">
      <div class="ico" style="background:${c.color}22">${c.icon}</div>
      <h3>${esc(b.name)}</h3>
      <div class="sub">${c.label} · ครบกำหนด ${thShortDate(o.due)} ${o.due.getFullYear() + 543}</div>
      <div style="margin-top:6px">${statusBadge(o)}</div>
    </div>
    <div class="form">
      <div class="field"><label for="oAmount">ยอดเดือนนี้ (฿)</label>
        <input id="oAmount" inputmode="decimal" value="${rec.amount != null ? rec.amount : (b.amount || '')}" placeholder="0"></div>
      ${o.inst ? `<div class="kv"><span>งวดที่</span><span>${o.inst.n} / ${o.inst.of}</span></div>` : ''}
      ${o.paid && o.paidAt ? `<div class="kv"><span>จ่ายเมื่อ</span><span>${thShortDate(new Date(o.paidAt))} ${new Date(o.paidAt).getFullYear() + 543}</span></div>` : ''}
      ${b.note ? `<div class="kv"><span>บันทึก</span><span style="text-align:right;max-width:65%">${esc(b.note)}</span></div>` : ''}
      ${o.paid ? '' : `<div class="field"><label for="oWallet">จ่ายจาก</label><select id="oWallet">
        <option value="">ไม่บันทึกเป็นรายการ</option>
        ${money.wallets.map((w) => `<option value="${w.id}" ${billPayWallet() === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select></div>`}
    </div>
    ${peaNeeded ? `<div class="alert warn">⚡<div>บิลนี้ผูกกับ PEA ต้องดึงยอด${thMonthYear(ym)}ก่อนจึงจะกดจ่ายได้</div></div>` : ''}
    ${b.pea ? `<button class="btn ${peaNeeded ? '' : 'ghost'}" id="oPea" type="button">⚡ ดึงยอด${peaNeeded ? 'เดือนนี้' : ''}จาก PEA</button>` : ''}
    ${o.paid
      ? `<button class="btn ghost" id="oSave">บันทึกยอด</button><button class="btn danger" id="oUnpay">ยกเลิกสถานะจ่ายแล้ว</button>`
      : `${peaNeeded ? '' : '<button class="btn ok" id="oPay">✓ จ่ายแล้ว</button>'}<button class="btn ghost" id="oSave">บันทึกยอด (ยังไม่จ่าย)</button>`}
    ${history.length ? `<div class="section-title">ย้อนหลัง</div><div class="form history">${history.join('')}</div>` : ''}
  `);

  const readAmount = () => {
    const v = $('#oAmount').value.trim();
    return v === '' ? undefined : num(v);
  };
  const pay = $('#oPay');
  if (pay) pay.addEventListener('click', () => {
    const amount = readAmount();
    const walletId = $('#oWallet').value;
    setRecord(ym, id, { amount, paid: true, paidAt: new Date().toISOString() });
    money.prefs.billWallet = walletId;
    recordBillTxn(b, ym, amount != null ? amount : (b.amount || 0), walletId);
    save(); saveMoney(); closeSheet(); render(); toast(`จ่าย ${b.name} แล้ว`);
  });
  const unpay = $('#oUnpay');
  if (unpay) unpay.addEventListener('click', () => {
    setRecord(ym, id, { paid: undefined, paidAt: undefined });
    removeBillTxn(id, ym);
    save(); saveMoney(); closeSheet(); render();
  });
  $('#oSave').addEventListener('click', () => {
    const amount = readAmount();
    setRecord(ym, id, { amount });
    const tx = billTxn(id, ym);
    if (tx) { tx.amount = amount != null ? amount : (b.amount || 0); saveMoney(); }
    save(); closeSheet(); render(); toast('บันทึกยอดแล้ว');
  });
  const oPea = $('#oPea');
  if (oPea) oPea.addEventListener('click', async () => {
    const label = oPea.textContent;
    oPea.disabled = true; oPea.textContent = 'กำลังดึง…';
    try {
      const rows = await fetchPeaBills(b.pea.ca, b.pea.peano);
      const filled = applyPeaRows(id, rows);
      const match = rows.find((r) => r.ym === ym && r.amount != null);
      save(); saveMoney();
      if (match) toast(`ยอด${thMonthYear(ym)} ${baht(match.amount)}`);
      else {
        // PEA issues a month's bill only after the meter is read (around the same day each month).
        const readDay = String((rows[0] && rows[0].raw.mrdate) || '').slice(6, 8);
        toast(`ยังไม่มีบิล${thMonthYear(ym)}ในระบบ กฟภ.${readDay ? ` (จดมิเตอร์ราววันที่ ${+readDay})` : ''} อัปเดต ${filled} เดือนอื่นแล้ว`);
      }
      occurrenceSheet(id, ym);
    } catch (err) {
      oPea.disabled = false; oPea.textContent = label;
      toast('ดึงไม่สำเร็จ: ' + (err.message || 'ลองใหม่'));
    }
  });
}

function togglePaid(id, ym) {
  const rec = record(ym, id);
  const b = state.bills.find((x) => x.id === id);
  if (rec.paid) {
    setRecord(ym, id, { paid: undefined, paidAt: undefined });
    removeBillTxn(id, ym);
  } else {
    if (b.pea && rec.amount == null) { occurrenceSheet(id, ym); toast('ดึงยอดเดือนนี้จาก PEA ก่อน'); return; }
    if (b.variable && rec.amount == null) { occurrenceSheet(id, ym); toast('กรอกยอดจริงของเดือนนี้ก่อน'); return; }
    setRecord(ym, id, { paid: true, paidAt: new Date().toISOString() });
    recordBillTxn(b, ym, rec.amount != null ? rec.amount : (b.amount || 0), billPayWallet());
    toast(`จ่าย ${b.name} แล้ว`);
  }
  save();
  saveMoney();
  render();
}

/* ---------- Export / import / ICS ---------- */

async function deliverFile(name, mime, text) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportData() {
  const stamp = dateStr(new Date());
  deliverFile(`bill-planner-${stamp}.json`, 'application/json', JSON.stringify({ app: 'bill-planner', version: 2, exportedAt: new Date().toISOString(), ...state, money }, null, 2));
}

function importData(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.bills)) throw new Error('bad');
      if (!confirm(`นำเข้า ${data.bills.length} บิล? ข้อมูลปัจจุบันจะถูกแทนที่`)) return;
      state = {
        bills: data.bills,
        records: data.records || {},
        settings: { ...defaultState().settings, ...(data.settings || {}) },
      };
      if (data.money) {
        localStorage.setItem(MONEY_KEY, JSON.stringify(data.money));
        money = loadMoney();
      }
      save();
      saveMoney();
      render();
      toast('นำเข้าข้อมูลแล้ว');
    } catch (err) {
      toast('ไฟล์ไม่ถูกต้อง');
    }
    e.target.value = '';
  };
  reader.readAsText(f);
}

function icsEscape(s) { return String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n'); }
function icsDate(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }

// Fold lines to 75 octets per RFC 5545 (safe for multi-byte Thai text).
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const l = enc.encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function buildIcs() {
  const remind = state.settings.remindDays;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//centel.app//Bill Planner//TH', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:วางแผนจ่ายบิล'];
  const alarm = (trigger, desc) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(desc)}`, `TRIGGER:${trigger}`, 'END:VALARM'];
  let count = 0;
  state.bills.forEach((b) => {
    if (b.autopay) return;
    const c = cat(b);
    const summary = `${c.icon} จ่าย${b.name}${b.amount ? ` ${baht(b.amount)}` : ''}`;
    let start;
    const ev = ['BEGIN:VEVENT', `UID:${b.id}@centel.app`, `DTSTAMP:${stamp}`];
    if (b.type === 'once') {
      start = dueDateFor(b, b.onceDate.slice(0, 7));
    } else {
      start = dueDateFor(b, b.startMonth);
      const rule = b.dueDay > 28
        ? `FREQ=MONTHLY;BYMONTHDAY=${Array.from({ length: b.dueDay - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1`
        : `FREQ=MONTHLY;BYMONTHDAY=${b.dueDay}`;
      ev.push(`RRULE:${rule}${b.type === 'installment' ? `;COUNT=${b.months}` : ''}`);
    }
    const end = new Date(start); end.setDate(end.getDate() + 1);
    ev.push(`DTSTART;VALUE=DATE:${icsDate(start)}`, `DTEND;VALUE=DATE:${icsDate(end)}`,
      `SUMMARY:${icsEscape(summary)}`, `DESCRIPTION:${icsEscape([c.label, b.note].filter(Boolean).join('\n'))}`,
      'TRANSP:TRANSPARENT');
    // All-day events start at midnight; fire reminders at 09:00.
    if (remind > 0) ev.push(...alarm(`-P${remind - 1}DT15H`, `อีก ${remind} วันครบกำหนด ${b.name}`));
    ev.push(...alarm('PT9H', `วันนี้ครบกำหนด ${b.name}`));
    ev.push('END:VEVENT');
    lines.push(...ev);
    count++;
  });
  lines.push('END:VCALENDAR');
  return { text: lines.map(icsFold).join('\r\n') + '\r\n', count };
}

function exportIcs() {
  if (!state.bills.length) { toast('ยังไม่มีบิล'); return; }
  const { text, count } = buildIcs();
  if (!count) { toast('ทุกบิลตั้งเป็นตัดบัญชีอัตโนมัติ'); return; }
  deliverFile('bill-reminders.ics', 'text/calendar', text);
}

/* ---------- Sample data ---------- */

function loadSample() {
  if ((state.bills.length || money.txns.length) && !confirm('แทนที่ข้อมูลปัจจุบันด้วยข้อมูลตัวอย่าง?')) return;
  const ym = ymOf(new Date());
  state.bills = [
    { id: uid(), name: 'บัตร KBank', category: 'credit', amount: 8000, variable: true, type: 'monthly', dueDay: 5, startMonth: ym, note: 'ตัดรอบวันที่ 20' },
    { id: uid(), name: 'บัตร SCB', category: 'credit', amount: 4500, variable: true, type: 'monthly', dueDay: 18, startMonth: ym },
    { id: uid(), name: 'ค่าไฟ (MEA)', category: 'electric', amount: 1800, variable: true, type: 'monthly', dueDay: 12, startMonth: ym },
    { id: uid(), name: 'ค่าน้ำ (MWA)', category: 'water', amount: 250, variable: true, type: 'monthly', dueDay: 15, startMonth: ym },
    { id: uid(), name: 'อินเทอร์เน็ตบ้าน', category: 'internet', amount: 599, type: 'monthly', dueDay: 25, startMonth: ym, autopay: true },
    { id: uid(), name: 'ผ่อนมือถือ', category: 'loan', amount: 2290, type: 'installment', months: 10, dueDay: 28, startMonth: addMonths(ym, -3) },
    { id: uid(), name: 'Netflix', category: 'subscription', amount: 419, type: 'monthly', dueDay: 9, startMonth: ym, autopay: true },
  ];
  state.records = {};
  // Mark most bills already due this month as paid so the demo looks lived-in.
  occurrences(ym).filter((o) => o.daysLeft < 0 && o.bill.name !== 'ค่าน้ำ (MWA)').forEach((o) => {
    setRecord(ym, o.bill.id, { amount: o.bill.variable ? Math.round(o.bill.amount * 0.9) : undefined, paid: true, paidAt: new Date().toISOString() });
  });
  sampleMoney();
  save();
  saveMoney();
  render();
  toast('เพิ่มข้อมูลตัวอย่างแล้ว');
}

/* ---------- Badge, toast ---------- */

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const n = occurrences(ymOf(new Date()))
    .filter((o) => !o.paid && !o.bill.autopay && (o.status === 'overdue' || o.status === 'soon')).length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------- Events ---------- */

$('#prevMonth').addEventListener('click', () => { ui.ym = addMonths(ui.ym, -1); ui.selDay = null; render(); });
$('#nextMonth').addEventListener('click', () => { ui.ym = addMonths(ui.ym, 1); ui.selDay = null; render(); });
$('#monthTitle').addEventListener('click', () => { ui.ym = ymOf(new Date()); ui.selDay = null; render(); });
$('#addBtn').addEventListener('click', () => (ui.tab === 'bills' ? billForm() : txnForm()));
$('#backdrop').addEventListener('click', closeSheet);
document.querySelector('.tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

// The home screen's "＋ เพิ่มรายการ" pill shrinks to a round button once you scroll.
window.addEventListener('scroll', () => {
  const mini = window.scrollY > 60;
  if (mini === !!ui.fabMini) return;
  ui.fabMini = mini;
  $('#addBtn').classList.toggle('ext', ui.tab === 'home' && !mini);
}, { passive: true });

document.addEventListener('click', (e) => {
  const t = e.target;
  const toggle = t.closest('[data-toggle]');
  if (toggle) { e.stopPropagation(); togglePaid(toggle.dataset.toggle, toggle.dataset.ym); return; }
  const edit = t.closest('[data-edit]');
  if (edit) { const b = state.bills.find((x) => x.id === edit.dataset.edit); if (b) billForm(b); return; }
  const occ = t.closest('[data-occ]');
  if (occ) { occurrenceSheet(occ.dataset.occ, occ.dataset.ym); return; }
  const day = t.closest('[data-day]');
  if (day) { ui.selDay = Number(day.dataset.day); render(); return; }
  const bv = t.closest('[data-billview]');
  if (bv) { ui.billView = bv.dataset.billview; render(); return; }
  if (moneyClick(t)) return;
  const act = t.closest('[data-action]');
  if (!act) return;
  if (moneyAction(act.dataset.action, act)) return;
  switch (act.dataset.action) {
    case 'close': closeSheet(); break;
    case 'add': billForm(); break;
    case 'sample': loadSample(); break;
    case 'export': exportData(); break;
    case 'import': $('#importFile').click(); break;
    case 'ics': exportIcs(); break;
    case 'gmail': gmailSheet(); break;
    case 'reset':
      if (confirm('ลบบิล รายการรับจ่าย งบประมาณ และประวัติทั้งหมด? ไม่สามารถกู้คืนได้')) {
        state = defaultState(); money = defaultMoney(); ui.wallet = 'total';
        save(); saveMoney(); render(); toast('ลบข้อมูลแล้ว');
      }
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-occ]')) {
    e.preventDefault();
    occurrenceSheet(e.target.dataset.occ, e.target.dataset.ym);
  }
});

// Re-render when returning to the app so "today" and statuses stay current.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); updateBadge(); }
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render();
updateBadge();
