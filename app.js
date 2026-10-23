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
  tab: 'month',
  ym: ymOf(new Date()),
  selDay: null,
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
      const needsAmount = rec.amount == null && b.variable;
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
  const nav = ui.tab === 'month' || ui.tab === 'calendar';
  const title = nav ? thMonthYear(ui.ym) : ui.tab === 'bills' ? 'บิลทั้งหมด' : 'ตั้งค่า';
  $('#largeHead').classList.toggle('hide-nav', !nav);
  $('#monthTitle').textContent = title;
  $('#monthTitle').disabled = !nav;
  $('#barTitle').textContent = title;
  $('#todayBtn').hidden = !nav || ui.ym === ymOf(new Date());
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $('#addBtn').hidden = ui.tab === 'settings';
  if (ui.tab === 'month') renderMonth();
  else if (ui.tab === 'calendar') renderCalendar();
  else if (ui.tab === 'bills') renderBills();
  else renderSettings();
}

const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function occItem(o) {
  const b = o.bill;
  const dueTxt = `ครบกำหนด ${thShortDate(o.due)}`;
  const extra = [o.inst ? `งวด ${o.inst.n}/${o.inst.of}` : '', b.note ? esc(b.note) : ''].filter(Boolean).join(' · ');
  const amt = o.needsAmount ? `<span class="badge warn">ระบุยอด</span>` : baht(o.amount);
  return `
    <div class="item ${o.paid ? 'paid' : ''}" data-occ="${b.id}" data-ym="${o.ym}" role="button" tabindex="0">
      ${icoHtml(b)}
      <div class="main">
        <div class="name">${esc(b.name)}</div>
        <div class="sub">${dueTxt}${extra ? ' · ' + extra : ''}</div>
        ${statusBadge(o)}
      </div>
      <div class="right"><div class="amt">${amt}</div></div>
      <button class="check ${o.paid ? 'on' : ''}" data-toggle="${b.id}" data-ym="${o.ym}" aria-label="${o.paid ? 'ยกเลิกจ่ายแล้ว' : 'ทำเครื่องหมายว่าจ่ายแล้ว'}">${CHECK_SVG}</button>
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
  const missing = occ.filter((o) => o.needsAmount && !o.paid);

  let alerts = '';
  if (overdue.length) alerts += `<div class="alert bad">⚠️<div>เลยกำหนดชำระ ${overdue.length} รายการ รวม ${baht(overdue.reduce((s, o) => s + o.amount, 0))}</div></div>`;
  if (soon.length) alerts += `<div class="alert warn">⏰<div>ใกล้ครบกำหนดภายใน ${state.settings.remindDays} วัน: ${soon.map((o) => esc(o.bill.name)).join(', ')}</div></div>`;
  if (missing.length) alerts += `<div class="alert warn">✏️<div>ยังไม่ได้ระบุยอดเดือนนี้: ${missing.map((o) => esc(o.bill.name)).join(', ')}</div></div>`;

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
    <div class="section-title">การแจ้งเตือน</div>
    <div class="form">
      <div class="field"><label for="remindDays">เตือนล่วงหน้า</label>
        <select id="remindDays">${[0, 1, 2, 3, 5, 7].map((n) => `<option value="${n}" ${s.remindDays === n ? 'selected' : ''}>${n === 0 ? 'วันครบกำหนด' : n + ' วัน'}</option>`).join('')}</select>
      </div>
    </div>
    <p class="hint">แอปจะแสดงบิลที่ใกล้ครบกำหนดเมื่อเปิดแอป และแสดงตัวเลขบนไอคอน (iOS 16.4 ขึ้นไป เมื่อติดตั้งที่หน้าจอโฮม)</p>
    <button class="btn" data-action="ics">📆 เพิ่มการเตือนลงปฏิทิน iPhone</button>
    <p class="hint">สร้างไฟล์ปฏิทิน (.ics) ของบิลทั้งหมด พร้อมเสียงเตือนก่อนวันครบกำหนดตามที่ตั้งไว้ เปิดไฟล์แล้วเลือก "เพิ่มทั้งหมด" ในแอปปฏิทิน · หากแก้ไขบิล ให้ลบปฏิทินเดิมแล้วสร้างใหม่</p>

    <div class="section-title">สำรองข้อมูล</div>
    <button class="btn ghost" data-action="export">⬇️ ส่งออกข้อมูล (JSON)</button>
    <button class="btn ghost" data-action="import">⬆️ นำเข้าข้อมูล</button>
    <input type="file" id="importFile" accept="application/json,.json" hidden>
    <p class="hint">ข้อมูลทั้งหมดเก็บในเครื่องนี้ (localStorage) ไม่มีการส่งไปที่ใด ควรส่งออกเก็บไว้เป็นระยะ</p>

    ${installTip()}

    <div class="section-title">อื่นๆ</div>
    <button class="btn danger" data-action="reset">ลบข้อมูลทั้งหมด</button>
    <p class="hint" style="text-align:center">วางแผนจ่ายบิล · เวอร์ชัน 1.0</p>
  `;
  $('#remindDays').addEventListener('change', (e) => {
    state.settings.remindDays = Number(e.target.value);
    save();
    toast('บันทึกแล้ว');
  });
  $('#importFile').addEventListener('change', importData);
}

/* ---------- Sheets ---------- */

/*
  The sheet is positioned by a spring rather than CSS keyframes so it can be
  grabbed mid-flight, follows the finger 1:1, and inherits release velocity.
  Spring params follow Apple's damping/response model.
*/
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function spring({ from, to, velocity = 0, damping = 1, response = 0.4, onUpdate, onDone }) {
  const k = (2 * Math.PI / response) ** 2;
  const c = (4 * Math.PI * damping) / response;
  let x = from, v = velocity, last = performance.now(), raf = 0;
  const step = (now) => {
    let dt = Math.min((now - last) / 1000, 0.064);
    last = now;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240);
      v += (-k * (x - to) - c * v) * h;
      x += v * h;
      dt -= h;
    }
    if (Math.abs(v) < 5 && Math.abs(x - to) < 0.5) { onUpdate(to); if (onDone) onDone(); return; }
    onUpdate(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return { stop: () => cancelAnimationFrame(raf) };
}

// Apple's momentum projection: where a flick would come to rest.
function project(velocity, decel = 0.998) { return (velocity / 1000) * decel / (1 - decel); }

function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

const sheetState = { open: false, y: 0, anim: null };

function sheetHeight() { return $('#sheet').offsetHeight || window.innerHeight; }

function setSheetY(y) {
  sheetState.y = y;
  $('#sheet').style.transform = `translate3d(0, ${y}px, 0)`;
  $('#backdrop').style.opacity = String(Math.min(1, Math.max(0, 1 - y / sheetHeight())));
}

function moveSheet(to, { velocity = 0, damping = 1, response = 0.35, done } = {}) {
  if (sheetState.anim) sheetState.anim.stop();
  sheetState.anim = null;
  if (reduceMotion.matches) {
    // Cross-fade instead of sliding.
    const sheet = $('#sheet'), bd = $('#backdrop');
    const show = to === 0;
    sheet.style.transform = 'none';
    sheet.style.transition = bd.style.transition = 'opacity 200ms ease';
    sheet.style.opacity = bd.style.opacity = show ? '1' : '0';
    sheetState.y = show ? 0 : sheetHeight();
    if (done) setTimeout(done, 200);
    return;
  }
  sheetState.anim = spring({
    from: sheetState.y, to, velocity, damping, response, onUpdate: setSheetY,
    onDone: () => { sheetState.anim = null; if (done) done(); },
  });
}

function openSheet(html) {
  const sheet = $('#sheet'), bd = $('#backdrop');
  sheet.innerHTML = `<div class="grabber"></div>${html}`;
  sheet.scrollTop = 0;
  if (sheet.hidden) {
    // Fully closed: start just below the screen. (If it was still closing,
    // it simply turns around from where it is now.)
    sheet.hidden = false;
    bd.hidden = false;
    if (reduceMotion.matches) {
      sheet.style.opacity = bd.style.opacity = '0';
      sheet.getBoundingClientRect();
    } else {
      sheet.style.opacity = '';
      sheet.style.transition = bd.style.transition = '';
      setSheetY(sheetHeight());
    }
  }
  sheetState.open = true;
  document.body.style.overflow = 'hidden';
  moveSheet(0);
}

function closeSheet(velocity = 0) {
  if (!sheetState.open) return;
  sheetState.open = false;
  document.body.style.overflow = '';
  if (document.activeElement && $('#sheet').contains(document.activeElement)) document.activeElement.blur();
  moveSheet(sheetHeight() + 12, {
    velocity: typeof velocity === 'number' ? velocity : 0,
    done: () => {
      if (sheetState.open) return;
      $('#sheet').hidden = true;
      $('#backdrop').hidden = true;
      $('#sheet').innerHTML = '';
    },
  });
}

/* Drag to dismiss: hysteresis, 1:1 tracking, rubber-band past the top,
   decide with velocity + projection, then hand velocity to the spring. */
let drag = null;

function dragStart(y, target) {
  const sheet = $('#sheet');
  if (sheet.hidden || reduceMotion.matches) return;
  if (target.closest('input, select, textarea')) return;
  const caught = !!sheetState.anim; // grabbing a sheet that is still moving
  if (caught) { sheetState.anim.stop(); sheetState.anim = null; sheetState.open = true; }
  drag = {
    y0: y, sheetY0: sheetState.y, active: caught, caught,
    handle: !!target.closest('.grabber, .sheet-head'),
    hist: [{ y, t: performance.now() }],
  };
}

function dragMove(y, e) {
  if (!drag) return;
  const sheet = $('#sheet');
  const dy = y - drag.y0;
  if (!drag.active) {
    const atTop = sheet.scrollTop <= 0;
    if (dy > 0 && (atTop || drag.handle) && e.cancelable) e.preventDefault(); // nothing to scroll; avoid content bounce
    if (Math.abs(dy) < 10) return;
    if (dy < 0 || (!atTop && !drag.handle)) { drag = null; return; } // it's a scroll
    drag.active = true;
    drag.y0 = y; // track from here so there's no jump at the threshold
    drag.sheetY0 = sheetState.y;
  }
  if (e.cancelable) e.preventDefault();
  let ny = drag.sheetY0 + (y - drag.y0);
  if (ny < 0) ny = -rubberband(-ny, sheetHeight());
  setSheetY(ny);
  const now = performance.now();
  drag.hist.push({ y, t: now });
  while (drag.hist.length > 2 && now - drag.hist[0].t > 100) drag.hist.shift();
}

function dragEnd() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.active) return;
  const sheet = $('#sheet');
  sheet.dataset.dragged = '1';
  setTimeout(() => { delete sheet.dataset.dragged; }, 0);
  const a = d.hist[0], b = d.hist[d.hist.length - 1];
  const velocity = b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0; // px/s
  const h = sheetHeight();
  const projected = sheetState.y + project(velocity);
  const dismiss = velocity > 400 || (velocity > -400 && projected > h * 0.5);
  sheetState.open = true;
  if (dismiss) {
    closeSheet(velocity);
  } else {
    document.body.style.overflow = 'hidden';
    // A flick back up carried momentum, so allow a little bounce.
    moveSheet(0, { velocity, damping: Math.abs(velocity) > 300 ? 0.8 : 1, response: 0.3 });
  }
}

(() => {
  const sheet = $('#sheet');
  sheet.addEventListener('touchstart', (e) => { if (e.touches.length === 1) dragStart(e.touches[0].clientY, e.target); }, { passive: true });
  sheet.addEventListener('touchmove', (e) => { if (e.touches.length === 1) dragMove(e.touches[0].clientY, e); }, { passive: false });
  sheet.addEventListener('touchend', dragEnd);
  sheet.addEventListener('touchcancel', dragEnd);
  sheet.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    dragStart(e.clientY, e.target);
    const move = (ev) => dragMove(ev.clientY, ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); dragEnd(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // A drag shouldn't also count as a tap on whatever it started on.
  sheet.addEventListener('click', (e) => { if (sheet.dataset.dragged) { e.stopPropagation(); e.preventDefault(); } }, true);
  $('#backdrop').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
})();

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
  };

  $('#catChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]');
    if (!c) return;
    draft.category = c.dataset.cat;
    document.querySelectorAll('#catChips .chip').forEach((x) => x.classList.toggle('on', x === c));
    if (['credit', 'electric', 'water'].includes(draft.category) && isNew) $('#fVariable').checked = true;
    if (['loan', 'insurance', 'rent', 'subscription', 'internet'].includes(draft.category) && isNew) $('#fVariable').checked = false;
    if (draft.category === 'loan' && isNew && draft.type === 'monthly') { sync(); draft.type = 'installment'; renderSched(); }
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
    const i = state.bills.findIndex((x) => x.id === out.id);
    if (i >= 0) state.bills[i] = out; else state.bills.push(out);
    save();
    closeSheet();
    render();
    toast(isNew ? 'เพิ่มบิลแล้ว' : 'บันทึกแล้ว');
  });
  const del = $('#delBill');
  if (del) {
    del.addEventListener('click', () => {
      if (!confirm(`ลบ "${b.name}" และประวัติการจ่ายทั้งหมดของบิลนี้?`)) return;
      state.bills = state.bills.filter((x) => x.id !== b.id);
      Object.keys(state.records).forEach((ym) => setRecord(ym, b.id, { amount: undefined, paid: undefined, paidAt: undefined }));
      save();
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
    </div>
    ${o.paid
      ? `<button class="btn ghost" id="oSave">บันทึกยอด</button><button class="btn danger" id="oUnpay">ยกเลิกสถานะจ่ายแล้ว</button>`
      : `<button class="btn ok" id="oPay">✓ จ่ายแล้ว</button><button class="btn ghost" id="oSave">บันทึกยอด (ยังไม่จ่าย)</button>`}
    ${history.length ? `<div class="section-title">ย้อนหลัง</div><div class="form history">${history.join('')}</div>` : ''}
  `);

  const readAmount = () => {
    const v = $('#oAmount').value.trim();
    return v === '' ? undefined : num(v);
  };
  const pay = $('#oPay');
  if (pay) pay.addEventListener('click', () => {
    setRecord(ym, id, { amount: readAmount(), paid: true, paidAt: new Date().toISOString() });
    save(); closeSheet(); render(); toast(`จ่าย ${b.name} แล้ว`);
  });
  const unpay = $('#oUnpay');
  if (unpay) unpay.addEventListener('click', () => {
    setRecord(ym, id, { paid: undefined, paidAt: undefined });
    save(); closeSheet(); render();
  });
  $('#oSave').addEventListener('click', () => {
    setRecord(ym, id, { amount: readAmount() });
    save(); closeSheet(); render(); toast('บันทึกยอดแล้ว');
  });
}

function togglePaid(id, ym) {
  const rec = record(ym, id);
  const b = state.bills.find((x) => x.id === id);
  if (rec.paid) {
    setRecord(ym, id, { paid: undefined, paidAt: undefined });
  } else {
    if (b.variable && rec.amount == null) { occurrenceSheet(id, ym); toast('กรอกยอดจริงของเดือนนี้ก่อน'); return; }
    setRecord(ym, id, { paid: true, paidAt: new Date().toISOString() });
    toast(`จ่าย ${b.name} แล้ว`);
  }
  save();
  render();
  const btn = document.querySelector(`[data-toggle="${id}"][data-ym="${ym}"]`);
  if (btn && btn.classList.contains('on')) {
    btn.classList.remove('on');
    btn.classList.add('pop');
    btn.getBoundingClientRect(); // commit the unchecked frame so the stroke draws in
    btn.classList.add('on');
  }
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
  deliverFile(`bill-planner-${stamp}.json`, 'application/json', JSON.stringify({ app: 'bill-planner', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2));
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
      save();
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
  save();
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
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* Scroll edge: the bar becomes material only once content is under it,
   and the compact title appears once the large title has scrolled away. */
function updateBar() {
  const s = window.scrollY;
  const bar = $('#topbar');
  bar.classList.toggle('scrolled', s > 1);
  bar.classList.toggle('compact', s > $('#largeHead').offsetHeight - 10);
}
let barRaf = 0;
window.addEventListener('scroll', () => {
  if (!barRaf) barRaf = requestAnimationFrame(() => { barRaf = 0; updateBar(); });
}, { passive: true });

// iOS Safari only applies :active styles when a touch listener exists.
document.addEventListener('touchstart', () => {}, { passive: true });

/* ---------- Events ---------- */

$('#prevMonth').addEventListener('click', () => { ui.ym = addMonths(ui.ym, -1); ui.selDay = null; render(); });
$('#nextMonth').addEventListener('click', () => { ui.ym = addMonths(ui.ym, 1); ui.selDay = null; render(); });
$('#monthTitle').addEventListener('click', () => { ui.ym = ymOf(new Date()); ui.selDay = null; render(); });
$('#todayBtn').addEventListener('click', () => { ui.ym = ymOf(new Date()); ui.selDay = null; render(); });
$('#addBtn').addEventListener('click', () => billForm());
$('#backdrop').addEventListener('click', () => closeSheet());
document.querySelector('.tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab;
  window.scrollTo(0, 0);
  render();
  updateBar();
});

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
  const act = t.closest('[data-action]');
  if (!act) return;
  switch (act.dataset.action) {
    case 'close': closeSheet(); break;
    case 'add': billForm(); break;
    case 'sample': loadSample(); break;
    case 'export': exportData(); break;
    case 'import': $('#importFile').click(); break;
    case 'ics': exportIcs(); break;
    case 'reset':
      if (confirm('ลบบิลและประวัติทั้งหมด? ไม่สามารถกู้คืนได้')) { state = defaultState(); save(); render(); toast('ลบข้อมูลแล้ว'); }
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
updateBar();
updateBadge();
