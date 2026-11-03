'use strict';

/* Centel Billing: the owner's back office for the companies they build apps for.
   Talks to /api/billing (server/src/billing.js) with the Centel sign-in cookie.
   Views by hash: #home · #clients · #client/<id> · #invoices · #invoice/<id> · #settings */

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const sheet = $('#sheet');
const B = { me: null, settings: null, today: null, filter: 'unpaid' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, cur = 'THB') => `${cur === 'THB' ? '฿' : cur + ' '}${Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateTH = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '–');
const initial = (s) => esc(String(s || '?').trim().charAt(0).toUpperCase());
const EVERY = { month: 'ทุกเดือน', year: 'ทุกปี', once: 'ครั้งเดียว' };
const STATE = {
  draft: ['ร่าง', ''], issued: ['รอชำระ', 'info'], partial: ['จ่ายบางส่วน', 'warn'], overdue: ['เลยกำหนด', 'bad'], paid: ['จ่ายแล้ว', 'ok'], void: ['ยกเลิก', ''],
};
const ERR = {
  unauthenticated: 'กรุณาเข้าสู่ระบบในแอป Centel ก่อน', forbidden: 'บัญชีนี้ไม่มีสิทธิ์ใช้ Billing', bad_name: 'กรุณาใส่ชื่อ',
  bad_amount: 'จำนวนเงินไม่ถูกต้อง', bad_date: 'วันที่ไม่ถูกต้อง', bad_items: 'กรอกรายการให้ครบ (รายละเอียด จำนวน ราคา)',
  bad_code: 'รหัสใช้ได้เฉพาะตัวอักษร ตัวเลข - _ .', conflict: 'รหัสนี้มีคู่ค้าอื่นใช้แล้ว', already_issued: 'รอบนี้ออกบิลไปแล้ว',
  plan_finished: 'แผนนี้จบแล้ว ไม่มีรอบถัดไป', already_paid: 'ใบนี้จ่ายครบแล้ว', not_issued: 'ใบนี้ยังไม่ได้ออก', not_draft: 'ทำได้เฉพาะใบร่าง',
  client_has_invoices: 'คู่ค้านี้มีใบแจ้งหนี้แล้ว ลบไม่ได้ ใช้ “เก็บเข้าคลัง” แทน', bad_prefix: 'คำนำหน้าเลขที่ใช้ได้เฉพาะ A-Z 0-9 -', invoice_void: 'ใบนี้ถูกยกเลิกแล้ว',
};

async function api(method, path, body) {
  const res = await fetch('/api/billing' + path, {
    method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-centel': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `http_${res.status}`), { status: res.status });
  return data;
}
const errText = (e) => ERR[e.message] || (e.status ? 'ทำรายการไม่สำเร็จ' : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');

let toastT;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

async function copy(text, msg = 'คัดลอกแล้ว') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch (e) { prompt('คัดลอกลิงก์นี้', text); }
}
const invoiceLink = (inv) => `${location.origin}/billing/invoice.html?i=${inv.publicToken}`;
const clientLink = (c) => `${location.origin}/billing/invoice.html?c=${c.portalToken}`;

async function share(url, title) {
  if (navigator.share) { try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  copy(url, 'คัดลอกลิงก์แล้ว');
}

function chip(state) { const [t, c] = STATE[state] || [state, '']; return `<span class="chip ${c}">${t}</span>`; }
function clientChip(st) {
  if (st.overdueCount) return `<span class="chip bad">เลยกำหนด ${st.overdueCount}</span>`;
  if (st.openCount) return `<span class="chip info">รอชำระ ${st.openCount}</span>`;
  return '<span class="chip ok">จ่ายครบ</span>';
}

/* ---------- Shell ---------- */

function frame({ title, back, tab, action }) {
  $('#title').textContent = title;
  document.title = `${title} · Centel Billing`;
  const bk = $('#back');
  bk.hidden = !back;
  bk.onclick = () => (history.length > 1 ? history.back() : (location.hash = back));
  const ba = $('#barAction');
  ba.hidden = !action;
  if (action) { ba.textContent = action.label; ba.onclick = action.run; }
  $('#tabs').hidden = false;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
}

async function route() {
  const [name, id] = location.hash.replace(/^#/, '').split('/');
  window.scrollTo(0, 0);
  try {
    if (name === 'client' && id) await clientView(id);
    else if (name === 'invoice' && id) await invoiceView(id);
    else if (name === 'clients') await clientsView();
    else if (name === 'invoices') await invoicesView();
    else if (name === 'settings') await settingsView();
    else await homeView();
  } catch (e) {
    view.innerHTML = `<div class="card empty">${esc(errText(e))}</div>`;
  }
}

/* ---------- Home ---------- */

async function homeView() {
  frame({ title: 'ภาพรวม Billing', tab: 'home', action: { label: '+ คู่ค้า', run: () => clientForm() } });
  const s = await api('GET', '/summary');
  B.today = s.today;
  const thb = (arr, k) => (arr.find((x) => x.currency === 'THB') || {})[k] || 0;
  const others = s.open.filter((x) => x.currency !== 'THB');
  view.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">ค้างรับทั้งหมด</div><div class="v num">${fmt(thb(s.open, 'outstanding'))}</div><div class="small muted">${thb(s.open, 'openCount')} ใบ</div></div>
      <div class="stat bad"><div class="k">เลยกำหนด</div><div class="v num">${fmt(thb(s.open, 'overdue'))}</div><div class="small muted">${thb(s.open, 'overdueCount')} ใบ</div></div>
      <div class="stat ok"><div class="k">รับแล้วเดือนนี้</div><div class="v num">${fmt(thb(s.paidThisMonth, 'amount'))}</div></div>
    </div>
    ${others.length ? `<p class="hint">สกุลเงินอื่นค้างรับ: ${others.map((o) => fmt(o.outstanding, o.currency)).join(' · ')}</p>` : ''}
    <div class="section-title"><span>บิลที่ถึงรอบใน 31 วัน</span></div>
    <div class="list">${s.upcoming.length ? s.upcoming.map((p) => `
      <div class="row">
        <div class="main"><b>${esc(p.clientName)} · ${esc(p.name)}</b>
          <div class="sub">${p.nextBillDate <= s.today ? '<span class="chip warn">ถึงรอบแล้ว</span> ' : ''}รอบ ${dateTH(p.nextBillDate)} · ${fmt(p.amount, p.currency)}${p.autoIssue ? ' · ออกอัตโนมัติ' : ''}</div></div>
        <button class="btn small" data-issue="${p.id}">ออกบิล</button>
      </div>`).join('') : '<div class="empty">ยังไม่มีรอบบิลที่จะถึง</div>'}</div>
    <div class="section-title"><span>คู่ค้า</span></div>
    ${clientList(s.clients)}`;
  bindIssue(homeView);
}

function clientList(clients) {
  if (!clients.length) return '<div class="list"><div class="empty">ยังไม่มีคู่ค้า กด “+ คู่ค้า” เพื่อเพิ่มบริษัทแรก</div></div>';
  return `<div class="list">${clients.map((c) => `
    <a class="row" href="#client/${c.id}">
      <div class="avatar">${initial(c.name)}</div>
      <div class="main"><b>${esc(c.name)}</b><div class="sub">${c.status.nextBillDate ? `บิลถัดไป ${dateTH(c.status.nextBillDate)}` : 'ไม่มีรอบบิล'}${c.status.lastPayment ? ` · จ่ายล่าสุด ${dateTH(c.status.lastPayment.paidOn)}` : ''}</div></div>
      <div class="end">${c.status.outstanding ? `<div class="amt num">${fmt(c.status.outstanding)}</div>` : ''}${clientChip(c.status)}</div>
    </a>`).join('')}</div>`;
}

function bindIssue(after) {
  view.querySelectorAll('[data-issue]').forEach((b) => b.addEventListener('click', () => issuePlan(b.dataset.issue, after)));
}

async function issuePlan(planId, after) {
  if (!confirm('ออกใบแจ้งหนี้รอบนี้เลยไหม? ระบบจะออกเลขที่และกำหนดวันครบชำระให้')) return;
  try {
    const inv = await api('POST', `/plans/${planId}/issue`, {});
    toast(`ออกบิล ${inv.number} แล้ว`);
    location.hash = `invoice/${inv.id}`;
  } catch (e) {
    toast(errText(e));
    if (after) after();
  }
}

/* ---------- Clients ---------- */

async function clientsView() {
  frame({ title: 'คู่ค้า', tab: 'clients', action: { label: '+ คู่ค้า', run: () => clientForm() } });
  const { clients } = await api('GET', '/clients');
  view.innerHTML = clientList(clients) + '<p class="hint">คู่ค้าที่เก็บเข้าคลังแล้วไม่แสดงที่นี่ แต่ใบแจ้งหนี้เดิมยังอยู่</p>';
}

async function clientView(id) {
  const c = await api('GET', `/clients/${id}`);
  const st = c.status;
  frame({ title: c.name, back: '#clients', tab: 'clients', action: { label: 'แก้ไข', run: () => clientForm(c) } });
  view.innerHTML = `
    <div class="card">
      <div class="hero"><div class="avatar">${initial(c.name)}</div>
        <div><h2>${esc(c.name)}</h2><div class="small muted">${[c.code && `รหัส ${esc(c.code)}`, c.contactName && esc(c.contactName), c.email && esc(c.email), c.phone && esc(c.phone)].filter(Boolean).join(' · ') || 'ยังไม่ใส่ข้อมูลติดต่อ'}</div></div>
      </div>
      <div class="balance num">${st.paidUp ? '<span style="color:var(--ok)">จ่ายครบแล้ว ✓</span>' : fmt(st.outstanding)}</div>
      <div class="small muted">${st.paidUp ? 'ไม่มีบิลค้างชำระ' : `ค้างชำระ ${st.openCount} ใบ${st.overdueCount ? ` · <b style="color:var(--bad)">เลยกำหนด ${st.overdueCount} ใบ (${fmt(st.overdueAmount)})</b>` : ''}${st.nextDue ? ` · ครบกำหนดถัดไป ${dateTH(st.nextDue)}` : ''}`}${st.lastPayment ? ` · จ่ายล่าสุด ${dateTH(st.lastPayment.paidOn)} ${fmt(st.lastPayment.amount)}` : ''}</div>
      <div class="btns full">
        <button class="btn" id="newInv">🧾 เปิดบิลใหม่</button>
        <button class="btn ghost" id="shareClient">🔗 ลิงก์ให้คู่ค้าดูบิล</button>
      </div>
    </div>
    <div class="section-title"><span>รอบบิล (แผน)</span><button class="btn small ghost" id="newPlan">+ เพิ่มรอบบิล</button></div>
    <div class="list">${c.plans.length ? c.plans.map((p) => `
      <div class="row" data-plan="${p.id}">
        <div class="main"><b>${esc(p.name)} · ${fmt(p.amount, p.currency)}</b>
          <div class="sub">${EVERY[p.every]}${p.every !== 'once' ? ` วันที่ ${p.billDay}` : ''} · ${p.active && p.nextBillDate ? `รอบถัดไป ${dateTH(p.nextBillDate)}` : 'จบแล้ว'}${p.autoIssue ? ' · ออกอัตโนมัติ' : ''}${p.vat ? ' · +VAT' : ''}${p.whtRate ? ` · หัก ณ ที่จ่าย ${p.whtRate}%` : ''}</div></div>
        ${p.active && p.nextBillDate ? `<button class="btn small" data-issue="${p.id}">ออกบิล</button>` : ''}
      </div>`).join('') : '<div class="empty">ยังไม่มีรอบบิล เพิ่มค่าบริการรายเดือน/รายปี เพื่อให้ระบบเตือนและออกบิลให้</div>'}</div>
    <div class="section-title"><span>ใบแจ้งหนี้</span></div>
    ${invoiceList(c.invoices, false)}
    ${c.address || c.taxId || c.notes ? `<div class="section-title"><span>ข้อมูลออกบิล</span></div><div class="card"><dl class="kv">
      ${c.taxId ? `<dt>เลขผู้เสียภาษี</dt><dd>${esc(c.taxId)}</dd>` : ''}${c.address ? `<dt>ที่อยู่</dt><dd style="white-space:pre-line">${esc(c.address)}</dd>` : ''}
      ${c.dueDays != null ? `<dt>เครดิต</dt><dd>${c.dueDays} วัน</dd>` : ''}${c.notes ? `<dt>หมายเหตุ</dt><dd style="white-space:pre-line">${esc(c.notes)}</dd>` : ''}</dl></div>` : ''}`;
  $('#newInv').onclick = () => invoiceForm({ clientId: c.id, client: c });
  $('#newPlan').onclick = () => planForm({ clientId: c.id });
  $('#shareClient').onclick = () => share(clientLink(c), `บิลของ ${c.name}`);
  view.querySelectorAll('[data-plan]').forEach((r) => r.addEventListener('click', (e) => {
    if (e.target.closest('[data-issue]')) return;
    planForm(c.plans.find((p) => p.id === r.dataset.plan));
  }));
  bindIssue(() => clientView(id));
}

function clientForm(c = {}) {
  openSheet(c.id ? 'แก้ไขคู่ค้า' : 'เพิ่มคู่ค้า', `
    <div class="field"><label>ชื่อบริษัท *</label><input name="name" value="${esc(c.name)}" required placeholder="บริษัท เอ จำกัด"></div>
    <div class="grid2">
      <div class="field"><label>รหัสย่อ (ใช้เรียกผ่าน API)</label><input name="code" value="${esc(c.code)}" placeholder="A"></div>
      <div class="field"><label>เครดิต (วัน)</label><input name="dueDays" type="number" min="0" max="365" inputmode="numeric" value="${c.dueDays ?? ''}" placeholder="ตามค่าเริ่มต้น"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>ผู้ติดต่อ</label><input name="contactName" value="${esc(c.contactName)}"></div>
      <div class="field"><label>โทร</label><input name="phone" type="tel" value="${esc(c.phone)}"></div>
    </div>
    <div class="field"><label>อีเมล</label><input name="email" type="email" value="${esc(c.email)}"></div>
    <div class="field"><label>เลขประจำตัวผู้เสียภาษี</label><input name="taxId" inputmode="numeric" value="${esc(c.taxId)}"></div>
    <div class="field"><label>ที่อยู่ออกบิล</label><textarea name="address">${esc(c.address)}</textarea></div>
    <div class="field"><label>หมายเหตุ</label><textarea name="notes">${esc(c.notes)}</textarea></div>
    <button class="btn" style="width:100%" type="submit">บันทึก</button>
    ${c.id ? `<div class="btns full"><button class="btn plain" type="button" id="archive">${c.archived ? 'นำออกจากคลัง' : 'เก็บเข้าคลัง'}</button>
      <button class="btn danger" type="button" id="delClient">ลบคู่ค้า</button></div>
      <button class="btn plain small" type="button" id="relink" style="margin-top:10px">สร้างลิงก์คู่ค้าใหม่ (ลิงก์เก่าใช้ไม่ได้)</button>` : ''}`,
  async (f) => {
    const body = { ...f, dueDays: f.dueDays === '' ? null : Number(f.dueDays) };
    const r = c.id ? await api('PUT', `/clients/${c.id}`, body) : await api('POST', '/clients', body);
    closeSheet();
    toast('บันทึกแล้ว');
    if (location.hash === `#client/${r.id}`) route(); else location.hash = `client/${r.id}`;
  });
  if (!c.id) return;
  $('#archive', sheet).onclick = async () => {
    await api('PUT', `/clients/${c.id}`, { archived: !c.archived });
    closeSheet(); toast('บันทึกแล้ว'); location.hash = 'clients';
  };
  $('#delClient', sheet).onclick = async () => {
    if (!confirm(`ลบ ${c.name}?`)) return;
    try { await api('DELETE', `/clients/${c.id}`); closeSheet(); toast('ลบแล้ว'); location.hash = 'clients'; } catch (e) { toast(errText(e)); }
  };
  $('#relink', sheet).onclick = async () => {
    if (!confirm('ลิงก์เดิมที่ส่งให้คู่ค้าจะใช้ไม่ได้ ต่อไหม?')) return;
    const r = await api('POST', `/clients/${c.id}/link`);
    closeSheet(); share(clientLink(r), `บิลของ ${r.name}`);
  };
}

/* ---------- Plans ---------- */

function planForm(p = {}) {
  const today = B.today || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  openSheet(p.id ? 'แก้ไขรอบบิล' : 'เพิ่มรอบบิล', `
    <div class="field"><label>ชื่อค่าบริการ *</label><input name="name" value="${esc(p.name)}" required placeholder="ค่าดูแลระบบแอป"></div>
    <div class="grid2">
      <div class="field"><label>จำนวนเงิน (ก่อน VAT) *</label><input name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${p.amount ?? ''}" required></div>
      <div class="field"><label>สกุลเงิน</label><select name="currency">${['THB', 'USD', 'EUR', 'JPY', 'SGD'].map((x) => `<option ${x === (p.currency || 'THB') ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>ความถี่</label><select name="every">${Object.entries(EVERY).map(([k, v]) => `<option value="${k}" ${k === (p.every || 'month') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>วันที่ออกบิล (1–31)</label><input name="billDay" type="number" min="1" max="31" inputmode="numeric" value="${p.billDay ?? 1}"><span class="hint">เดือนที่สั้นกว่าจะใช้วันสุดท้าย</span></div>
    </div>
    <div class="grid2">
      <div class="field"><label>เริ่ม</label><input name="startDate" type="date" value="${p.startDate || today}"></div>
      <div class="field"><label>สิ้นสุด (ไม่บังคับ)</label><input name="endDate" type="date" value="${p.endDate || ''}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>ครบกำหนดชำระ (วันหลังออกบิล)</label><input name="dueDays" type="number" min="0" max="365" inputmode="numeric" value="${p.dueDays ?? ''}" placeholder="ตามคู่ค้า/ค่าเริ่มต้น"></div>
      <div class="field"><label>หัก ณ ที่จ่าย %</label><select name="whtRate">${[0, 1, 2, 3, 5].map((x) => `<option value="${x}" ${Number(p.whtRate || 0) === x ? 'selected' : ''}>${x ? x + '%' : 'ไม่หัก'}</option>`).join('')}</select></div>
    </div>
    ${p.id ? `<div class="field"><label>รอบถัดไป</label><input name="nextBillDate" type="date" value="${p.nextBillDate || ''}"><span class="hint">เลื่อนรอบถัดไปได้ ถ้าเว้นว่าง แผนนี้จะหยุด</span></div>` : ''}
    <label class="check"><input type="checkbox" name="vat" ${p.vat ? 'checked' : ''}> บวก VAT ${esc(B.settings ? B.settings.vatRate : 7)}%</label>
    <label class="check"><input type="checkbox" name="autoIssue" ${p.autoIssue ? 'checked' : ''}> ออกบิลอัตโนมัติเมื่อถึงรอบ (แจ้งเตือนในแอป)</label>
    ${p.id ? `<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> ใช้งานอยู่</label>` : ''}
    <div class="field"><label>หมายเหตุ</label><textarea name="notes">${esc(p.notes)}</textarea></div>
    <button class="btn" style="width:100%" type="submit">บันทึก</button>
    ${p.id ? '<div class="btns full"><button class="btn danger" type="button" id="delPlan">ลบรอบบิล</button></div>' : ''}`,
  async (f, form) => {
    const body = {
      ...f, amount: Number(f.amount), billDay: Number(f.billDay), whtRate: Number(f.whtRate),
      dueDays: f.dueDays === '' ? null : Number(f.dueDays), endDate: f.endDate || null,
      vat: form.vat.checked, autoIssue: form.autoIssue.checked,
    };
    delete body.nextBillDate;
    if (p.id) {
      body.active = form.active.checked;
      // Only a date the owner changed is sent; otherwise the server works it out from the schedule.
      if ((f.nextBillDate || '') !== (p.nextBillDate || '')) body.nextBillDate = f.nextBillDate || null;
    }
    if (p.id) await api('PUT', `/plans/${p.id}`, body); else await api('POST', '/plans', { ...body, clientId: p.clientId });
    closeSheet(); toast('บันทึกแล้ว'); route();
  });
  if (p.id) $('#delPlan', sheet).onclick = async () => {
    if (!confirm('ลบรอบบิลนี้? ใบแจ้งหนี้ที่ออกไปแล้วยังอยู่')) return;
    await api('DELETE', `/plans/${p.id}`); closeSheet(); toast('ลบแล้ว'); route();
  };
}

/* ---------- Invoices ---------- */

function invoiceList(list, showClient = true) {
  if (!list.length) return '<div class="list"><div class="empty">ยังไม่มีใบแจ้งหนี้</div></div>';
  return `<div class="list">${list.map((i) => `
    <a class="row" href="#invoice/${i.id}">
      <div class="main"><b>${i.number ? esc(i.number) : 'ใบร่าง'}${showClient && i.clientName ? ` · ${esc(i.clientName)}` : ''}</b>
        <div class="sub">${i.issueDate ? `ออก ${dateTH(i.issueDate)}` : 'ยังไม่ออก'}${i.dueDate ? ` · ครบ ${dateTH(i.dueDate)}` : ''}</div></div>
      <div class="end"><div class="amt num">${fmt(i.status === 'issued' ? i.balance : i.total, i.currency)}</div>${chip(i.state)}</div>
    </a>`).join('')}</div>`;
}

const FILTERS = [['unpaid', 'ยังไม่จ่าย'], ['overdue', 'เลยกำหนด'], ['paid', 'จ่ายแล้ว'], ['draft', 'ร่าง'], ['void', 'ยกเลิก'], ['all', 'ทั้งหมด']];

async function invoicesView() {
  frame({ title: 'ใบแจ้งหนี้', tab: 'invoices', action: { label: '+ เปิดบิล', run: () => invoiceForm({}) } });
  const q = B.filter === 'all' ? '' : `?status=${B.filter}`;
  const { invoices } = await api('GET', '/invoices' + q);
  view.innerHTML = `<div class="seg">${FILTERS.map(([k, l]) => `<button data-f="${k}" class="${B.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div style="height:10px"></div>${invoiceList(invoices)}`;
  view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { B.filter = b.dataset.f; invoicesView(); }));
}

async function invoiceView(id) {
  const i = await api('GET', `/invoices/${id}`);
  frame({ title: i.number || 'ใบร่าง', back: `#client/${i.clientId}`, tab: 'invoices', action: i.status === 'void' ? null : { label: 'แก้ไข', run: () => invoiceForm(i) } });
  view.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div><a href="#client/${i.clientId}" style="text-decoration:none"><b>${esc(i.clientName)}</b></a>
          <div class="small muted">${i.issueDate ? `ออก ${dateTH(i.issueDate)}` : 'ยังไม่ออก'}${i.dueDate ? ` · ครบกำหนด ${dateTH(i.dueDate)}` : ''}</div></div>
        ${chip(i.state)}
      </div>
      <div class="balance num">${fmt(i.status === 'issued' ? i.balance : i.total, i.currency)}</div>
      <div class="small muted">${i.status === 'issued' ? `ยอดค้าง จากทั้งหมด ${fmt(i.total, i.currency)}` : i.status === 'paid' ? `จ่ายครบ ${i.paidAt ? new Date(i.paidAt).toLocaleDateString('th-TH') : ''}` : 'ยอดรวม'}</div>
      <div class="btns full">
        ${i.status === 'draft' ? '<button class="btn" id="issue">📤 ออกบิล (ให้เลขที่)</button>' : ''}
        ${i.status === 'issued' ? '<button class="btn ok" id="pay">✓ บันทึกรับเงิน</button>' : ''}
        ${i.status !== 'draft' ? '<button class="btn ghost" id="share">🔗 ส่งลิงก์</button>' : ''}
        ${i.status !== 'draft' ? `<a class="btn plain" href="${invoiceLink(i)}" target="_blank" rel="noopener">🖨️ ดู / พิมพ์</a>` : ''}
      </div>
    </div>
    <div class="section-title"><span>รายการ</span></div>
    <div class="card">
      <table class="items"><thead><tr><th>รายละเอียด</th><th class="r hide-sm">จำนวน</th><th class="r hide-sm">ราคา</th><th class="r">รวม</th></tr></thead>
      <tbody>${i.items.map((x) => `<tr><td class="desc">${esc(x.description)}<div class="small muted show-sm num">${x.qty} × ${fmt(x.unitPrice, i.currency)}</div></td><td class="r num hide-sm">${x.qty}</td><td class="r num hide-sm">${fmt(x.unitPrice, i.currency)}</td><td class="r num">${fmt(x.qty * x.unitPrice, i.currency)}</td></tr>`).join('')}</tbody></table>
      <div class="totals num">
        <div><span>รวม</span><span>${fmt(i.subtotal, i.currency)}</span></div>
        ${i.vatRate ? `<div><span>VAT ${i.vatRate}%</span><span>${fmt(i.vat, i.currency)}</span></div>` : ''}
        ${i.whtRate ? `<div><span>หัก ณ ที่จ่าย ${i.whtRate}%</span><span>−${fmt(i.wht, i.currency)}</span></div>` : ''}
        <div class="grand"><span>ยอดชำระ</span><span>${fmt(i.total, i.currency)}</span></div>
      </div>
      ${i.notes ? `<p class="small muted" style="white-space:pre-line">${esc(i.notes)}</p>` : ''}
    </div>
    ${i.status !== 'draft' ? `<div class="section-title"><span>การชำระ</span></div>
    <div class="list">${i.payments.length ? i.payments.map((p) => `
      <div class="row"><div class="main"><b class="num">${fmt(p.amount, i.currency)}</b><div class="sub">${dateTH(p.paidOn)}${p.method ? ` · ${esc(p.method)}` : ''}${p.reference ? ` · ${esc(p.reference)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</div></div>
        <button class="btn small plain" data-unpay="${p.id}">ลบ</button></div>`).join('') : '<div class="empty">ยังไม่ได้รับเงิน</div>'}</div>` : ''}
    <div class="btns">
      ${i.status === 'draft' ? '<button class="btn danger small" id="del">ลบใบร่าง</button>' : ''}
      ${i.status === 'issued' || i.status === 'paid' ? '<button class="btn danger small" id="void">ยกเลิกใบนี้</button>' : ''}
    </div>`;
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#issue', async () => {
    if (!confirm('ออกบิลใบนี้? จะได้เลขที่ใบแจ้งหนี้และวันครบกำหนด')) return;
    try { await api('POST', `/invoices/${i.id}/issue`, {}); toast('ออกบิลแล้ว'); route(); } catch (e) { toast(errText(e)); }
  });
  on('#pay', () => paymentForm(i));
  on('#share', () => share(invoiceLink(i), `ใบแจ้งหนี้ ${i.number}`));
  on('#del', async () => { if (!confirm('ลบใบร่างนี้?')) return; await api('DELETE', `/invoices/${i.id}`); toast('ลบแล้ว'); location.hash = `client/${i.clientId}`; });
  on('#void', async () => {
    if (!confirm(`ยกเลิก ${i.number}? เลขที่นี้จะไม่ถูกใช้ซ้ำ`)) return;
    try { await api('POST', `/invoices/${i.id}/void`); toast('ยกเลิกแล้ว'); route(); } catch (e) { toast(errText(e)); }
  });
  view.querySelectorAll('[data-unpay]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('ลบรายการรับเงินนี้?')) return;
    try { await api('DELETE', `/invoices/${i.id}/payments/${b.dataset.unpay}`); toast('ลบแล้ว'); route(); } catch (e) { toast(errText(e)); }
  }));
}

function paymentForm(i) {
  openSheet('บันทึกรับเงิน', `
    <div class="field"><label>จำนวนเงิน</label><input name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" value="${i.balance}"><span class="hint">ยอดค้าง ${fmt(i.balance, i.currency)} · ใส่น้อยกว่านี้ได้ถ้าจ่ายบางส่วน</span></div>
    <div class="field"><label>วันที่ได้รับ</label><input name="paidOn" type="date" value="${B.today || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)}"></div>
    <div class="grid2">
      <div class="field"><label>ช่องทาง</label><select name="method">${['โอนเงิน', 'พร้อมเพย์', 'เช็ค', 'เงินสด', 'บัตร', 'อื่นๆ'].map((x) => `<option>${x}</option>`).join('')}</select></div>
      <div class="field"><label>เลขอ้างอิง</label><input name="reference"></div>
    </div>
    <div class="field"><label>หมายเหตุ</label><input name="note"></div>
    <button class="btn ok" style="width:100%" type="submit">บันทึกรับเงิน</button>`,
  async (f) => {
    await api('POST', `/invoices/${i.id}/payments`, { ...f, amount: Number(f.amount) });
    closeSheet(); toast('บันทึกรับเงินแล้ว'); route();
  });
}

async function invoiceForm(inv) {
  const editing = !!inv.id;
  let clients = [];
  if (!inv.clientId) clients = (await api('GET', '/clients')).clients;
  if (!editing && !inv.clientId && !clients.length) { toast('เพิ่มคู่ค้าก่อน'); clientForm(); return; }
  const items = (inv.items && inv.items.length ? inv.items : [{ description: '', qty: 1, unitPrice: '' }]);
  const rate = B.settings ? B.settings.vatRate : 7;
  openSheet(editing ? `แก้ไข ${inv.number || 'ใบร่าง'}` : 'เปิดบิลใหม่', `
    ${!inv.clientId ? `<div class="field"><label>คู่ค้า *</label><select name="clientId">${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>`
      : `<p class="small muted" style="margin-top:0">คู่ค้า: <b>${esc(inv.clientName || (inv.client && inv.client.name) || '')}</b></p>`}
    <div class="field"><label>รายการ</label><div id="items"></div>
      <button class="btn plain small" type="button" id="addItem">+ เพิ่มรายการ</button></div>
    <div class="grid2">
      <label class="check"><input type="checkbox" name="vat" ${inv.vatRate ? 'checked' : ''}> บวก VAT ${esc(rate)}%</label>
      <div class="field"><label>หัก ณ ที่จ่าย %</label><select name="whtRate">${[0, 1, 2, 3, 5].map((x) => `<option value="${x}" ${Number(inv.whtRate || 0) === x ? 'selected' : ''}>${x ? x + '%' : 'ไม่หัก'}</option>`).join('')}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>วันที่ออก</label><input name="issueDate" type="date" value="${inv.issueDate || ''}"><span class="hint">${editing ? '' : 'เว้นว่าง = วันนี้'}</span></div>
      <div class="field"><label>ครบกำหนด</label><input name="dueDate" type="date" value="${inv.dueDate || ''}"><span class="hint">${editing ? '' : 'เว้นว่าง = ตามเครดิตคู่ค้า'}</span></div>
    </div>
    <div class="field"><label>หมายเหตุบนใบแจ้งหนี้</label><textarea name="notes">${esc(inv.notes)}</textarea></div>
    <p class="num" style="text-align:right;font-weight:700" id="sum"></p>
    ${editing ? '<button class="btn" style="width:100%" type="submit">บันทึก</button>'
      : `<div class="btns full" style="margin-top:0"><button class="btn" type="submit" data-issue-now="1">📤 ออกบิลเลย</button>
        <button class="btn plain" type="submit">บันทึกเป็นร่าง</button></div>`}`,
  async (f, form, submitter) => {
    const rows = [...form.querySelectorAll('.item-row')].map((r) => ({
      description: r.querySelector('[data-k=d]').value, qty: Number(r.querySelector('[data-k=q]').value || 1), unitPrice: Number(r.querySelector('[data-k=p]').value),
    })).filter((x) => x.description.trim() || x.unitPrice);
    const body = {
      items: rows, vatRate: form.vat.checked ? rate : 0, whtRate: Number(f.whtRate), notes: f.notes,
      issueDate: f.issueDate || null, dueDate: f.dueDate || null,
    };
    let r;
    if (editing) r = await api('PUT', `/invoices/${inv.id}`, body);
    else r = await api('POST', '/invoices', { ...body, clientId: inv.clientId || f.clientId, issue: !!(submitter && submitter.dataset.issueNow) });
    closeSheet();
    toast(r.number ? `บันทึก ${r.number} แล้ว` : 'บันทึกร่างแล้ว');
    if (location.hash === `#invoice/${r.id}`) route(); else location.hash = `invoice/${r.id}`;
  });
  const box = $('#items', sheet);
  const addRow = (x = {}) => {
    const d = document.createElement('div');
    d.className = 'item-row';
    d.innerHTML = `<input data-k="d" placeholder="รายละเอียด" value="${esc(x.description)}"><input data-k="q" type="number" step="0.01" min="0" inputmode="decimal" placeholder="จำนวน" value="${x.qty ?? 1}">
      <input data-k="p" type="number" step="0.01" inputmode="decimal" placeholder="ราคา/หน่วย" value="${x.unitPrice ?? ''}"><button type="button" aria-label="ลบรายการ">✕</button>`;
    d.querySelector('button').onclick = () => { if (box.children.length > 1) d.remove(); sum(); };
    box.appendChild(d);
  };
  const sum = () => {
    const sub = [...box.querySelectorAll('.item-row')].reduce((s, r) => s + Number(r.querySelector('[data-k=q]').value || 0) * Number(r.querySelector('[data-k=p]').value || 0), 0);
    const form = $('form', sheet);
    const vat = form.vat.checked ? sub * rate / 100 : 0;
    const wht = sub * Number(form.whtRate.value) / 100;
    $('#sum', sheet).textContent = `ยอดชำระ ${fmt(sub + vat - wht, inv.currency || 'THB')}`;
  };
  items.forEach(addRow);
  $('#addItem', sheet).onclick = () => { addRow(); sum(); };
  $('form', sheet).addEventListener('input', sum);
  sum();
}

/* ---------- Settings ---------- */

async function settingsView() {
  frame({ title: 'ตั้งค่า Billing', tab: 'settings' });
  const [s, { keys }] = await Promise.all([api('GET', '/settings'), api('GET', '/keys')]);
  B.settings = s;
  view.innerHTML = `
    <form class="card" id="setForm">
      <div class="field"><label>ชื่อผู้ออกบิล (บริษัท/ชื่อคุณ)</label><input name="sellerName" value="${esc(s.sellerName)}"></div>
      <div class="field"><label>เลขประจำตัวผู้เสียภาษี</label><input name="sellerTaxId" value="${esc(s.sellerTaxId)}"></div>
      <div class="field"><label>ที่อยู่</label><textarea name="sellerAddress">${esc(s.sellerAddress)}</textarea></div>
      <div class="grid2">
        <div class="field"><label>โทร</label><input name="sellerPhone" value="${esc(s.sellerPhone)}"></div>
        <div class="field"><label>อีเมล</label><input name="sellerEmail" value="${esc(s.sellerEmail)}"></div>
      </div>
      <div class="field"><label>ช่องทางชำระเงิน (แสดงบนใบแจ้งหนี้)</label><textarea name="bankInfo" placeholder="ธนาคาร… เลขบัญชี… ชื่อบัญชี…">${esc(s.bankInfo)}</textarea></div>
      <div class="grid2">
        <div class="field"><label>คำนำหน้าเลขที่</label><input name="invoicePrefix" value="${esc(s.invoicePrefix)}"><span class="hint">เช่น ${esc(s.invoicePrefix)}-2026-0001</span></div>
        <div class="field"><label>เครดิตเริ่มต้น (วัน)</label><input name="defaultDueDays" type="number" min="0" max="365" value="${s.defaultDueDays}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>VAT %</label><input name="vatRate" type="number" step="0.01" min="0" max="100" value="${s.vatRate}"></div>
        <div class="field"><label>เตือนก่อนครบกำหนด (วัน)</label><input name="remindDays" type="number" min="0" max="60" value="${s.remindDays}"></div>
      </div>
      <div class="field"><label>ข้อความท้ายใบแจ้งหนี้</label><textarea name="footerNote">${esc(s.footerNote)}</textarea></div>
      <button class="btn" style="width:100%">บันทึก</button>
      <p class="hint">การแจ้งเตือน (ออกบิลอัตโนมัติ ใกล้ครบกำหนด เลยกำหนด) ส่งเข้า iPhone ผ่านการแจ้งเตือนของแอป Centel ที่เปิดไว้ในบัญชี</p>
    </form>
    <div class="section-title"><span>API key สำหรับระบบอื่น</span><button class="btn small ghost" id="newKey">+ สร้าง key</button></div>
    <div id="keyBox"></div>
    <div class="list">${keys.length ? keys.map((k) => `<div class="row"><div class="main"><b>${esc(k.name)}</b><div class="sub mono">${esc(k.prefix)}… · ${k.lastUsedAt ? `ใช้ล่าสุด ${new Date(k.lastUsedAt).toLocaleString('th-TH')}` : 'ยังไม่เคยใช้'}</div></div>
      <button class="btn small danger" data-revoke="${k.id}">ยกเลิก</button></div>`).join('') : '<div class="empty">ยังไม่มี API key</div>'}</div>
    <div class="card" style="margin-top:10px">
      <b>เรียกใช้ API</b>
      <p class="small muted" style="margin:4px 0 0">ใส่ key ใน header <span class="mono">Authorization: Bearer cbk_…</span> ทุก endpoint อยู่ใต้ <span class="mono">${esc(location.origin)}/api/billing</span></p>
      <pre class="code">GET  /clients/A/status          จ่ายมารึยัง (ใช้ id หรือรหัสย่อ)
GET  /summary                   ยอดค้าง/เลยกำหนด/รับเดือนนี้
GET  /invoices?status=unpaid    unpaid|overdue|paid|draft|void
POST /invoices                  {clientId, items:[{description,qty,unitPrice}], issue:true}
POST /plans/{id}/issue          ออกบิลรอบถัดไปของแผน
POST /invoices/{id}/payments    {amount?, paidOn?, method?, reference?}
GET|POST|PUT /clients, /plans   จัดการคู่ค้าและรอบบิล</pre>
      <p class="hint">รายละเอียดเต็มอยู่ใน docs/billing-api.md ของ repo</p>
    </div>`;
  $('#setForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { B.settings = await api('PUT', '/settings', { ...f, defaultDueDays: Number(f.defaultDueDays), vatRate: Number(f.vatRate), remindDays: Number(f.remindDays) }); toast('บันทึกแล้ว'); } catch (err) { toast(errText(err)); }
  });
  $('#newKey').onclick = async () => {
    const name = prompt('ตั้งชื่อ key (เช่น ระบบบัญชี, n8n)', 'API key');
    if (name == null) return;
    const k = await api('POST', '/keys', { name });
    $('#keyBox').innerHTML = `<div class="card" style="margin-bottom:10px"><b>key ใหม่: ${esc(k.name)}</b><pre class="code">${esc(k.key)}</pre>
      <div class="btns"><button class="btn small" id="copyKey">คัดลอก</button></div><p class="hint">แสดงครั้งเดียว เก็บไว้ในที่ปลอดภัย ใครมี key นี้จัดการบิลได้</p></div>`;
    $('#copyKey').onclick = () => copy(k.key);
  };
  view.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('ยกเลิก key นี้? ระบบที่ใช้อยู่จะเรียกไม่ได้ทันที')) return;
    await api('DELETE', `/keys/${b.dataset.revoke}`); toast('ยกเลิกแล้ว'); settingsView();
  }));
}

/* ---------- Sheet ---------- */

function openSheet(title, inner, onSubmit) {
  sheet.innerHTML = `<div class="sheet-head"><h3>${esc(title)}</h3><button type="button" aria-label="ปิด" id="sheetX">✕</button></div>
    <form class="sheet-body" novalidate>${inner}</form>`;
  $('#sheetX', sheet).onclick = closeSheet;
  const form = $('form', sheet);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btns = form.querySelectorAll('button[type=submit], button:not([type])');
    btns.forEach((b) => { b.disabled = true; });
    try { await onSubmit(Object.fromEntries(new FormData(form)), form, e.submitter); } catch (err) { toast(errText(err)); } finally { btns.forEach((b) => { b.disabled = false; }); }
  });
  if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

/* ---------- Start ---------- */

(async function start() {
  try {
    B.me = await api('GET', '/me');
    B.today = B.me.today;
    api('GET', '/settings').then((s) => { B.settings = s; }).catch(() => {});
  } catch (e) {
    const signedOut = e.status === 401;
    view.innerHTML = `<div class="gate"><h2>${signedOut ? 'เข้าสู่ระบบก่อน' : 'ไม่มีสิทธิ์'}</h2>
      <p class="muted">${signedOut ? 'Billing ใช้บัญชีเดียวกับแอป Centel เข้าสู่ระบบในแอปแล้วกลับมาที่หน้านี้' : e.status === 403 ? 'บัญชีนี้ไม่ใช่เจ้าของระบบ Billing' : esc(errText(e))}</p>
      <a class="btn" href="/">เปิดแอป Centel</a></div>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
})();
