/* Signed-in mode: the account, the couple link, wallets, transactions, budgets, shared expenses
   and the bill planner (bills, monthly records, settings, invoice files) live in the centel.app
   API (/api, see server/), so every device signed in to the account shows the same data.
   Signed out, the app keeps working from localStorage.
   Loaded before money.js; `money`, `render`, `toast` and friends are looked up at call time. */

const CLOUD_KEY = 'centel.cloud.v1';

const cloud = {
  available: null, // null = not checked yet, false = this host has no API
  on: false,
  user: null,
  partner: null,
  coupleId: null,
  invite: null,
  settlements: [],
  features: {},
  ids: new Set(),
  queue: Promise.resolve(),
  fresh: false, // got the server copy at least once since signing in (not just the cached one)
  loginPrompt: false,
};

function isCloud() { return cloud.on; }
function partnerName() { return (cloud.partner && cloud.partner.name) || 'คู่ของฉัน'; }
function nameOf(id) {
  if (cloud.user && id === cloud.user.id) return 'ฉัน';
  if (cloud.partner && id === cloud.partner.id) return partnerName();
  return '-';
}

const CLOUD_ERRORS = {
  bad_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  email_taken: 'อีเมลนี้มีบัญชีอยู่แล้ว ลองเข้าสู่ระบบ',
  weak_password: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร',
  bad_email: 'อีเมลไม่ถูกต้อง',
  bad_name: 'กรุณาใส่ชื่อ',
  too_many_requests: 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่',
  bad_invite: 'รหัสเชิญไม่ถูกต้องหรือหมดอายุแล้ว',
  already_linked: 'บัญชีนี้เชื่อมกับคู่แล้ว',
  couple_full: 'บัญชีคู่นี้มีสมาชิกครบแล้ว',
  no_partner: 'ยังไม่ได้เชื่อมบัญชีกับคู่',
  locked: 'รายการนี้แก้ไขไม่ได้แล้ว',
  bad_status: 'สถานะรายการเปลี่ยนไปแล้ว',
  creator_cannot_respond: 'ผู้สร้างรายการอนุมัติเองไม่ได้',
  not_found: 'ไม่พบรายการ',
  too_large: 'ไฟล์ใหญ่เกินไป',
  storage_disabled: 'ยังไม่ได้ตั้งค่าที่เก็บสลิป',
  unauthorized: 'กรุณาเข้าสู่ระบบอีกครั้ง',
  bad_google_token: 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ ลองใหม่อีกครั้ง',
  google_unverified: 'อีเมล Google นี้ยังไม่ได้ยืนยัน',
  google_mismatch: 'อีเมลนี้เชื่อมกับบัญชี Google อื่นอยู่แล้ว',
  google_disabled: 'ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google',
  bad_file: 'ไฟล์ไม่รองรับ',
};
function cloudErr(e) { return CLOUD_ERRORS[e.message] || (e.status ? 'ทำรายการไม่สำเร็จ' : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); }

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-centel': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `http_${res.status}`), { status: res.status, data });
  return data;
}

/* ---------- Bootstrap → `money` ---------- */

function mapExpense(e, me) {
  const base = {
    id: e.id, ownerId: e.ownerId, type: e.type, date: e.date, amount: e.amount, category: e.category,
    note: e.note || '', merchant: e.merchant || '', walletId: e.walletId, toWalletId: e.toWalletId,
    reviewNeeded: e.reviewNeeded, receiptKey: e.receiptKey, slipRef: e.slipRef, billId: e.billId, billYm: e.billYm,
    scope: e.scope, status: e.status,
  };
  if (!base.billId) { delete base.billId; delete base.billYm; }
  if (e.scope !== 'shared') return base;
  const payerMe = e.payerId === me;
  return {
    ...base,
    total: e.amount,
    amount: (e.shares && e.shares[me]) || 0,
    shares: e.shares || {},
    payerId: e.payerId,
    walletId: payerMe ? (e.ownerId === me ? e.walletId : e.payerWalletId) : null,
    walletAmount: payerMe ? e.amount : 0,
    counted: e.status === 'approved',
    events: e.events || [],
    revision: e.revision,
    rejectReason: e.rejectReason,
    approvedBy: e.approvedBy, approvedAt: e.approvedAt,
  };
}

function localDate(iso) { return iso ? dateStr(new Date(iso)) : dateStr(new Date()); }

function applyBootstrap(b) {
  const me = b.user.id;
  cloud.on = true;
  cloud.user = b.user;
  cloud.partner = b.partner;
  cloud.coupleId = b.coupleId;
  cloud.invite = b.invite;
  cloud.features = b.features || {};
  cloud.settlements = b.settlements || [];
  cloud.ids = new Set(b.expenses.map((e) => e.id));
  const txns = b.expenses.map((e) => mapExpense(e, me));
  // A repayment moves money between our wallets but is not income or spending.
  cloud.settlements.filter((s) => s.status === 'paid').forEach((s) => {
    const debtor = s.debtorId === me;
    txns.push({
      id: `st_${s.id}`, settlementId: s.id, expenseId: s.expenseId, type: 'settle', amount: s.amount,
      sign: debtor ? -1 : 1, walletId: (debtor ? s.debtorWalletId : s.creditorWalletId) || null, date: localDate(s.paidAt),
    });
  });
  const prefs = { hideBalance: false, ...(b.prefs || {}) };
  money = {
    wallets: b.wallets.length ? b.wallets : [{ id: 'cash', name: 'เงินสด', type: 'cash', initial: 0 }],
    txns,
    budgets: b.budgets.map((x) => ({ id: x.id, ownerId: x.ownerId, scope: x.scope, category: x.category, amount: x.amount, walletId: x.walletId })),
    prefs,
  };
  if (ui.wallet !== 'total' && !walletById(ui.wallet)) ui.wallet = 'total';
}

async function cloudRefresh() {
  try {
    const b = await api('GET', '/bootstrap');
    if (!b || !b.user) throw Object.assign(new Error('no_api'), { status: 404 });
    cloud.available = true;
    applyBootstrap(b);
    const first = !cloud.fresh;
    cloud.fresh = true;
    plannerMergeIn(b.user.id, b.planner);
    try { localStorage.setItem(CLOUD_KEY, JSON.stringify({ ...b, planner: undefined })); } catch (e) { /* full */ }
    render();
    if (first) {
      const ask = cloud.loginPrompt;
      cloud.loginPrompt = false;
      setTimeout(() => offerLocalMerge(b, !ask), 400);
      setTimeout(billFilesSweep, 1500);
    }
    return b;
  } catch (e) {
    if (e.status === 401) {
      cloud.available = true;
      if (cloud.on) cloudSignedOut();
    } else if (!cloud.on) {
      // No API on this host (or it is down): stay a local-only app. Signed in, keep the synced copy.
      cloud.available = false;
    }
    if (ui.tab === 'account') render();
    return null;
  }
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(cloudRefresh, 250);
}

function cloudSignedOut() {
  cloud.on = false;
  cloud.fresh = false;
  clearTimeout(planner.timer);
  cloud.user = cloud.partner = cloud.coupleId = cloud.invite = null;
  cloud.settlements = [];
  cloud.ids = new Set();
  try { localStorage.removeItem(CLOUD_KEY); } catch (e) { /* ignore */ }
  money = loadMoney();
  ui.wallet = 'total';
  ui.txFilter = 'all';
  render();
}

// Show the last synced copy at once (works offline), then ask the server.
function cloudStart() {
  try {
    const cached = JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null');
    if (cached && cached.user) { applyBootstrap(cached); render(); }
  } catch (e) { /* ignore */ }
  if (location.protocol === 'file:') { cloud.available = false; return; }
  cloudRefresh();
}

// Writes run one at a time in order; the screen updates first and the server copy wins after.
function cloudCall(method, path, body, onError) {
  const p = cloud.queue.then(() => api(method, path, body)).then((r) => { scheduleRefresh(); return r; }, async (e) => {
    if (onError && await onError(e)) return null;
    toast(cloudErr(e));
    scheduleRefresh();
    return null;
  });
  cloud.queue = p.catch(() => {});
  return p;
}

function cloudSaveTxn(t, extra = {}) {
  const shared = t.scope === 'shared';
  const body = {
    id: t.id, type: t.type, scope: shared ? 'shared' : 'personal', amount: shared ? t.total : t.amount, date: t.date,
    merchant: t.merchant, category: t.category, note: t.note, walletId: t.walletId, toWalletId: t.toWalletId,
    reviewNeeded: !!t.reviewNeeded, receiptKey: t.receiptKey, slipRef: t.slipRef, billId: t.billId, billYm: t.billYm,
    payerId: t.payerId, shares: shared ? { [cloud.user.id]: t.amount } : undefined, submit: !!extra.submit,
  };
  const known = cloud.ids.has(t.id);
  cloud.ids.add(t.id);
  const send = (force) => cloudCall(known ? 'PUT' : 'POST', known ? `/expenses/${t.id}` : '/expenses', { ...body, force }, async (e) => {
    if (e.status !== 409 || e.message !== 'duplicate') { if (!known) cloud.ids.delete(t.id); return false; }
    // PRD: the same slip must not be counted twice without the person saying so.
    if (confirm('สลิปนี้อาจซ้ำกับรายการที่บันทึกไว้แล้ว ต้องการบันทึกซ้ำหรือไม่?')) { send(true); return true; }
    if (!known) cloud.ids.delete(t.id);
    scheduleRefresh();
    return true;
  });
  send(false);
}

let prefsTimer;
function cloudSavePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => cloudCall('PUT', '/prefs', { data: money.prefs }), 500);
}

/* ---------- Receipts ---------- */

// Phone photos are shrunk before upload: smaller, faster, and enough for reading a slip.
function shrinkImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad_image')); };
    img.src = url;
  });
}

async function uploadReceipt(file) {
  const image = await shrinkImage(file);
  return api('POST', '/receipts', { image, mediaType: 'image/jpeg' });
}

async function openReceipt(key) {
  const win = window.open('', '_blank');
  try {
    const { url } = await api('GET', `/receipts/url?key=${encodeURIComponent(key)}`);
    if (win) win.location = url; else location.href = url;
  } catch (e) {
    if (win) win.close();
    toast(cloudErr(e));
  }
}

/* ---------- Couple summaries ---------- */

function sharedRows() { return isCloud() ? money.txns.filter((t) => t.scope === 'shared') : []; }
function toApprove() { return sharedRows().filter((t) => t.status === 'pending' && t.ownerId !== cloud.user.id); }
function myPending() { return sharedRows().filter((t) => t.status === 'pending' && t.ownerId === cloud.user.id); }
function toFix() { return sharedRows().filter((t) => t.ownerId === cloud.user.id && (t.status === 'rejected' || t.status === 'draft')); }

// Positive: my partner owes me. Only approved, unpaid debts count.
function netOwed() {
  const me = cloud.user.id;
  return cloud.settlements.filter((s) => s.status === 'unpaid')
    .reduce((n, s) => n + (s.creditorId === me ? s.amount : s.debtorId === me ? -s.amount : 0), 0);
}

function owedLine(n) {
  if (Math.abs(n) < 0.005) return 'ไม่มียอดค้างคืน';
  return n > 0 ? `${esc(partnerName())} ต้องคืนคุณ <b class="inc">${baht(n)}</b>` : `คุณต้องคืน ${esc(partnerName())} <b class="exp">${baht(-n)}</b>`;
}

function coupleCard() {
  if (!isCloud()) return '';
  if (!cloud.partner) {
    return `
    <div class="card couple">
      <div class="cp-top"><span class="cp-ico">💞</span><div><b>ใช้ร่วมกับคู่ของคุณ</b>
        <div class="muted small">เชิญคู่เข้าบัญชี แยกรายจ่ายส่วนตัว และส่งรายจ่ายร่วมให้อีกฝ่ายอนุมัติ</div></div></div>
      <button class="btn pillbtn" data-action="couple">เชื่อมบัญชีคู่</button>
    </div>`;
  }
  const ym = ymOf(new Date());
  const appr = toApprove(), mine = myPending(), fix = toFix();
  const month = sharedRows().filter((t) => t.counted && t.type === 'expense' && t.date.slice(0, 7) === ym).reduce((s, t) => s + t.total, 0);
  const row = (n, label, kind, cls = '') => (n ? `<button class="item" data-action="shared-list" data-kind="${kind}">
      <div class="main"><div class="name">${label}</div></div><span class="badge ${cls}">${n}</span>${svgIcon('chev', 'svg-i sm muted')}</button>` : '');
  return `
    <div class="section-row"><span>ร่วมกับ ${esc(partnerName())}</span><button class="link-btn" data-action="shared-list" data-kind="all">ดูทั้งหมด</button></div>
    <div class="card list-card couple">
      <button class="item" data-action="settlements">
        <div class="ico round" style="background:#00b3a422">🤝</div>
        <div class="main"><div class="name">${owedLine(netOwed())}</div><div class="sub">รายจ่ายร่วมเดือนนี้ ${baht(month)} (อนุมัติแล้ว)</div></div>
        ${svgIcon('chev', 'svg-i sm muted')}
      </button>
      ${row(appr.length, 'รอคุณอนุมัติ', 'approve', 'warn')}
      ${row(mine.length, `รอ ${esc(partnerName())} อนุมัติ`, 'mine', 'muted')}
      ${row(fix.length, 'ถูกปฏิเสธ / ร่างที่ยังไม่ส่ง', 'fix', 'bad')}
      <div class="cp-actions"><button class="btn pillbtn" data-action="add-shared">＋ รายจ่ายร่วม</button></div>
    </div>`;
}

function sharedListSheet(kind) {
  const lists = { approve: ['รอคุณอนุมัติ', toApprove()], mine: [`รอ ${partnerName()} อนุมัติ`, myPending()], fix: ['ถูกปฏิเสธ / ร่าง', toFix()], all: ['รายจ่ายร่วมทั้งหมด', sharedRows()] };
  const [title, list] = lists[kind] || lists.all;
  const S = walletSet('total');
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>${esc(title)}</h2><span style="width:40px"></span></div>
    ${list.length ? dayGroups(list, S) : '<div class="empty"><div class="e-ico">🤝</div>ไม่มีรายการ</div>'}
  `);
}

/* ---------- One shared expense: approve / reject / resubmit / repayment ---------- */

const EVENT_TH = { submitted: 'ส่งขออนุมัติ', resubmitted: 'แก้ไขและส่งใหม่', approved: 'อนุมัติ', rejected: 'ปฏิเสธ' };
const STATUS_TH = { draft: 'ร่าง (ยังไม่ส่ง)', pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ถูกปฏิเสธ' };

function thTime(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear() + 543).slice(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function walletSelect(id, label) {
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}">
    <option value="">ไม่ระบุ</option>
    ${money.wallets.map((w) => `<option value="${w.id}" ${w.id === defaultWalletId() ? 'selected' : ''}>${wType(w).icon} ${esc(w.name)}</option>`).join('')}
  </select></div>`;
}

function sharedSheet(t) {
  const me = cloud.user.id;
  const mineOwner = t.ownerId === me;
  const c = txCat(t);
  const st = cloud.settlements.filter((s) => s.expenseId === t.id);
  const canRespond = !mineOwner && t.status === 'pending';
  const canEdit = mineOwner && (t.status === 'draft' || t.status === 'rejected');
  const partnerShare = t.shares[cloud.partner ? cloud.partner.id : ''] || 0;
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>รายจ่ายร่วม</h2>
      ${canEdit ? `<button class="link-btn" id="shEdit">แก้ไข</button>` : '<span style="width:40px"></span>'}
    </div>
    <div class="card bd">
      <div class="b-top">${circleIco(c)}<div class="main"><div class="name big-name">${esc(t.merchant || c.label)}</div>
        <div class="sub">${c.label} · ${thDate(t.date)}</div></div></div>
      <div class="bd-body">
        <div class="bd-amt">${baht(t.total)}</div>
        <div class="badges">${STATUS_BADGE[t.status] || '<span class="badge ok">อนุมัติแล้ว</span>'} ${t.reviewNeeded || !t.category ? '<span class="badge warn">รอตรวจสอบ</span>' : ''}</div>
        <div class="kv"><span>ผู้จ่าย</span><b>${esc(nameOf(t.payerId))}</b></div>
        <div class="kv"><span>ส่วนของฉัน</span><b>${baht(t.amount)}</b></div>
        <div class="kv"><span>ส่วนของ ${esc(partnerName())}</span><b>${baht(partnerShare)}</b></div>
        <div class="kv"><span>สร้างโดย</span><b>${esc(nameOf(t.ownerId))}</b></div>
        ${t.note ? `<div class="kv"><span>บันทึก</span><span>${esc(t.note)}</span></div>` : ''}
        ${t.status === 'rejected' && t.rejectReason ? `<div class="kv"><span>เหตุผลที่ปฏิเสธ</span><span class="exp">${esc(t.rejectReason)}</span></div>` : ''}
        ${t.receiptKey ? '<button class="btn ghost" id="shReceipt">🧾 ดูสลิป</button>' : ''}
      </div>
    </div>
    ${canRespond ? `
      <div class="form">${t.payerId === me ? walletSelect('shWallet', 'จ่ายจาก') : ''}</div>
      <p class="hint">ตรวจสอบยอดและการแบ่งให้ถูกต้อง ถ้าไม่ถูกให้ปฏิเสธพร้อมเหตุผล ผู้สร้างจะแก้ไขแล้วส่งใหม่</p>
      <div class="halves"><button class="btn danger" id="shReject">ปฏิเสธ</button><button class="btn" id="shApprove">อนุมัติ</button></div>` : ''}
    ${mineOwner && t.status === 'draft' ? '<button class="btn" id="shSubmit">ส่งขออนุมัติ</button>' : ''}
    ${canEdit && t.status === 'rejected' ? '<button class="btn" id="shResubmit">แก้ไขและส่งใหม่</button>' : ''}
    ${st.length ? `<div class="section-title">การคืนเงิน</div><div class="list">${st.map(settleItem).join('')}</div>` : ''}
    ${t.events.length ? `<div class="section-title">ประวัติ</div><div class="list">${t.events.map((e) => `
      <div class="item"><div class="main"><div class="name">${EVENT_TH[e.action] || e.action} · ${esc(nameOf(e.actorId))}</div>
        <div class="sub">${thTime(e.at)} · ครั้งที่ ${e.revision}${e.note ? ` · ${esc(e.note)}` : ''}</div></div></div>`).join('')}</div>` : ''}
    ${mineOwner && t.status !== 'approved' ? `<button class="btn danger" id="shDelete">${t.status === 'pending' ? 'ยกเลิกคำขอและลบ' : 'ลบรายการ'}</button>` : ''}
  `);
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  const done = (msg) => { closeSheet(); render(); toast(msg); };
  on('#shEdit', () => txnForm(t));
  on('#shResubmit', () => txnForm(t));
  on('#shReceipt', () => openReceipt(t.receiptKey));
  on('#shApprove', () => {
    const walletId = $('#shWallet') ? $('#shWallet').value || null : null;
    Object.assign(t, { status: 'approved', counted: true });
    if (t.payerId === me) t.walletId = walletId;
    cloudCall('POST', `/expenses/${t.id}/respond`, { approve: true, walletId });
    done('อนุมัติแล้ว');
  });
  on('#shReject', () => {
    const reason = prompt('เหตุผลที่ปฏิเสธ (ผู้สร้างจะเห็นข้อความนี้)', '');
    if (reason === null) return;
    t.status = 'rejected';
    cloudCall('POST', `/expenses/${t.id}/respond`, { approve: false, reason });
    done('ปฏิเสธแล้ว');
  });
  on('#shSubmit', () => {
    t.status = 'pending';
    cloudCall('POST', `/expenses/${t.id}/submit`);
    done(`ส่งให้ ${partnerName()} อนุมัติแล้ว`);
  });
  on('#shDelete', () => {
    if (!confirm('ลบรายการนี้?')) return;
    deleteTxn(t);
    done('ลบแล้ว');
  });
}

/* ---------- Repayments ---------- */

function settleItem(s) {
  const me = cloud.user.id;
  const e = money.txns.find((t) => t.id === s.expenseId);
  const owe = s.debtorId === me;
  const title = owe ? `คุณต้องคืน ${esc(partnerName())}` : `${esc(partnerName())} ต้องคืนคุณ`;
  return `
    <button class="item" data-settle="${s.id}">
      <div class="ico round" style="background:#00b3a422">🤝</div>
      <div class="main"><div class="name">${title}</div>
        <div class="sub">${e ? `${esc(e.merchant || txCat(e).label)} · ${thDate(e.date)}` : ''}</div>
        <div class="badges">${s.status === 'paid' ? `<span class="badge ok">ชำระแล้ว ${s.paidAt ? thDate(localDate(s.paidAt)) : ''}</span>` : '<span class="badge warn">ยังไม่ชำระ</span>'}</div></div>
      <div class="right"><div class="amt ${owe ? 'exp' : 'inc'}">${baht(s.amount)}</div></div>
    </button>`;
}

function settlementsSheet() {
  if (!isCloud()) return;
  const unpaid = cloud.settlements.filter((s) => s.status === 'unpaid');
  const paid = cloud.settlements.filter((s) => s.status === 'paid').slice().reverse();
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>ยอดค้างคืน</h2><span style="width:40px"></span></div>
    <div class="card summary"><div class="kv" style="padding:0"><span>สรุป</span><span>${owedLine(netOwed())}</span></div>
      <p class="hint" style="margin:8px 0 0">ยอดค้างเกิดเมื่อรายจ่ายร่วมได้รับอนุมัติแล้วเท่านั้น การคืนเงินไม่นับเป็นรายจ่ายซ้ำ</p></div>
    ${unpaid.length ? `<div class="section-title">ยังไม่ชำระ</div><div class="list">${unpaid.map(settleItem).join('')}</div>` : ''}
    ${paid.length ? `<div class="section-title">ชำระแล้ว</div><div class="list">${paid.map(settleItem).join('')}</div>` : ''}
    ${cloud.settlements.length ? '' : '<div class="empty"><div class="e-ico">🤝</div>ยังไม่มียอดค้างคืน</div>'}
  `);
}

function settleSheet(id) {
  const s = cloud.settlements.find((x) => x.id === id);
  if (!s) return;
  const me = cloud.user.id;
  const owe = s.debtorId === me;
  const myWallet = owe ? s.debtorWalletId : s.creditorWalletId;
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="settlements">กลับ</button><h2>การคืนเงิน</h2><span style="width:40px"></span></div>
    <div class="list">${settleItem(s)}</div>
    <div class="form">${walletSelect('stWallet', owe ? 'คืนจากกระเป๋า' : 'รับเข้ากระเป๋า')}</div>
    ${s.status === 'unpaid'
    ? '<button class="btn" id="stPaid">ทำเครื่องหมายว่าชำระแล้ว</button>'
    : `${myWallet ? '' : '<button class="btn" id="stWalletOnly">บันทึกกระเป๋าเงิน</button>'}<button class="btn ghost" id="stUnpaid">ยกเลิก: ยังไม่ชำระ</button>`}
  `);
  if (myWallet) $('#stWallet').value = myWallet;
  const finish = (body, msg) => { cloudCall('POST', `/settlements/${s.id}`, body); closeSheet(); toast(msg); };
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
  on('#stPaid', () => finish({ paid: true, walletId: $('#stWallet').value || null }, 'บันทึกการคืนเงินแล้ว'));
  on('#stUnpaid', () => finish({ paid: false }, 'เปลี่ยนเป็นยังไม่ชำระแล้ว'));
  on('#stWalletOnly', () => finish({ walletOnly: true, walletId: $('#stWallet').value || null }, 'บันทึกแล้ว'));
}

/* ---------- Account: sign in, couple link ---------- */

function accountCard() {
  if (isCloud()) {
    return `
    <div class="card acct">
      <div class="avatar">${esc((cloud.user.name || '?').slice(0, 1).toUpperCase())}</div>
      <div><b>${esc(cloud.user.name)}</b><div class="muted small">${esc(cloud.user.email)} · ซิงก์ทุกเครื่องที่เข้าสู่ระบบบัญชีนี้</div></div>
    </div>
    <div class="list" style="margin-bottom:14px">
      ${(() => {
    const n = localPending().count;
    return n ? `<button class="item" data-action="merge-local"><div class="ico round" style="background:#2fa8ff22">⤴️</div>
        <div class="main"><div class="name">รวมข้อมูลในเครื่องนี้เข้าบัญชี</div><div class="sub">มี ${n} รายการที่ยังไม่อยู่ในบัญชีออนไลน์</div></div>${svgIcon('chev', 'svg-i sm muted')}</button>` : '';
  })()}
      <button class="item" data-action="couple"><div class="ico round" style="background:#ff4d8d22">💞</div>
        <div class="main"><div class="name">${cloud.partner ? `เชื่อมกับ ${esc(partnerName())}` : 'เชื่อมบัญชีคู่'}</div>
        <div class="sub">${cloud.partner ? esc(cloud.partner.email) : 'ส่งรหัสเชิญให้คู่ หรือใส่รหัสจากคู่'}</div></div>${svgIcon('chev', 'svg-i sm muted')}</button>
      ${cloud.partner ? `<button class="item" data-action="settlements"><div class="ico round" style="background:#00b3a422">🤝</div>
        <div class="main"><div class="name">ยอดค้างคืน</div><div class="sub">${owedLine(netOwed())}</div></div>${svgIcon('chev', 'svg-i sm muted')}</button>` : ''}
      <button class="item" data-action="logout"><div class="ico round" style="background:#8a8f9922">🚪</div><div class="main"><div class="name">ออกจากระบบ</div></div></button>
    </div>`;
  }
  return `
    <div class="card acct">
      <div class="avatar">👤</div>
      <div><b>บัญชีของฉัน</b><div class="muted small">ข้อมูลทั้งหมดเก็บในเครื่องนี้เท่านั้น</div></div>
    </div>
    ${cloud.available === false ? '' : `
    <div class="card couple">
      <div class="cp-top"><span class="cp-ico">💞</span><div><b>ใช้ร่วมกับคู่ของคุณ</b>
        <div class="muted small">สมัครบัญชีเพื่อซิงก์ข้อมูล เชื่อมบัญชีกับคู่ แยกรายจ่ายส่วนตัว/ร่วม และให้ AI อ่านสลิป</div></div></div>
      <button class="btn pillbtn" data-action="login">เข้าสู่ระบบ / สมัครสมาชิก</button>
    </div>`}`;
}

/* ---------- Sign in with Google ---------- */

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let googleP = null;

// Resolves to the OAuth client id once Google Identity Services is loaded, or ''
// when no client id is configured (the Google button is then left out).
function googleReady() {
  if (!googleP) {
    googleP = api('GET', '/config').then((cfg) => {
      const id = (cfg && cfg.googleClientId) || '';
      if (!id || (window.google && google.accounts && google.accounts.id)) return id;
      return new Promise((resolve, reject) => {
        let s = document.querySelector(`script[src="${GSI_SRC}"]`);
        if (!s) { s = document.createElement('script'); s.src = GSI_SRC; s.async = true; document.head.appendChild(s); }
        s.addEventListener('load', () => resolve(id));
        s.addEventListener('error', () => reject(new Error('gsi_load')));
      });
    }).catch((e) => { googleP = null; throw e; });
  }
  return googleP;
}

async function googleButton(box, mode) {
  let id = '';
  try { id = await googleReady(); } catch (e) { /* offline or blocked: email login still works */ }
  if (!id || !box.isConnected) return;
  google.accounts.id.initialize({ client_id: id, callback: (r) => googleSignedIn(r.credential), ux_mode: 'popup', auto_select: false });
  box.hidden = false;
  google.accounts.id.renderButton(box.querySelector('.gbtn'), {
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline',
    size: 'large', shape: 'pill', locale: 'th',
    text: mode === 'login' ? 'signin_with' : 'signup_with',
    width: Math.min(400, box.clientWidth || 320),
  });
}

async function googleSignedIn(credential) {
  try {
    await api('POST', '/auth/google', { credential });
    await signedIn();
  } catch (err) {
    toast(cloudErr(err));
  }
}

async function signedIn() {
  cloud.fresh = false;
  cloud.loginPrompt = true;
  const b = await cloudRefresh();
  closeSheet();
  if (!b) { toast('เชื่อมต่อไม่สำเร็จ'); return; }
  toast(`สวัสดี ${b.user.name}`);
}

function loginSheet(mode = 'login') {
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ยกเลิก</button><h2>${mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก'}</h2><span style="width:40px"></span></div>
    <div class="seg" id="lgMode"><button type="button" data-lg="login" class="${mode === 'login' ? 'on' : ''}">เข้าสู่ระบบ</button><button type="button" data-lg="register" class="${mode === 'register' ? 'on' : ''}">สมัครสมาชิก</button></div>
    <div class="gsignin" id="lgGoogle" hidden><div class="gbtn"></div><div class="or"><span>หรือใช้อีเมล</span></div></div>
    <form class="form" id="lgForm">
      ${mode === 'register' ? '<div class="field"><label for="lgName">ชื่อที่แสดง</label><input id="lgName" autocomplete="nickname" placeholder="เช่น ต้น"></div>' : ''}
      <div class="field"><label for="lgEmail">อีเมล</label><input id="lgEmail" type="email" autocomplete="email" inputmode="email"></div>
      <div class="field"><label for="lgPass">รหัสผ่าน</label><input id="lgPass" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" placeholder="${mode === 'login' ? '' : 'อย่างน้อย 8 ตัวอักษร'}"></div>
      <button class="btn" type="submit" id="lgGo" style="margin-top:12px">${mode === 'login' ? 'เข้าสู่ระบบ' : 'สร้างบัญชี'}</button>
    </form>
    <p class="hint">แต่ละคนมีบัญชีของตัวเอง รายจ่ายส่วนตัวเห็นได้เฉพาะเจ้าของ รายจ่ายร่วมเห็นทั้งสองคนหลังเชื่อมบัญชี</p>
  `);
  googleButton($('#lgGoogle'), mode);
  $('#lgMode').addEventListener('click', (e) => { const b = e.target.closest('[data-lg]'); if (b && b.dataset.lg !== mode) loginSheet(b.dataset.lg); });
  $('#lgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#lgGo');
    btn.disabled = true;
    try {
      const body = { email: $('#lgEmail').value.trim(), password: $('#lgPass').value };
      if (mode === 'register') body.name = $('#lgName').value.trim();
      await api('POST', mode === 'login' ? '/auth/login' : '/auth/register', body);
      await signedIn();
    } catch (err) {
      toast(cloudErr(err));
    } finally {
      btn.disabled = false;
    }
  });
  setTimeout(() => $(mode === 'register' ? '#lgName' : '#lgEmail') && $(mode === 'register' ? '#lgName' : '#lgEmail').focus(), 300);
}

/* ---------- This device's own wallets/transactions/budgets → the account ----------
   Signed out, money lives in this device's local profile (centel.money.v1). Signing in on a
   device brings over whatever the account does not have yet, so a second device adds to the
   account instead of being hidden by it. Rows the device already sent are remembered (and the
   server derives their ids from the device's ids), so nothing is counted twice. */

const IMPORTED_KEY = 'centel.imported.v1'; // { [userId]: { ids: [local ids sent], asked: bool } }

function importedFor(userId) {
  try { return (JSON.parse(localStorage.getItem(IMPORTED_KEY) || '{}') || {})[userId] || { ids: [] }; } catch (e) { return { ids: [] }; }
}
function setImported(userId, patch) {
  try {
    const all = JSON.parse(localStorage.getItem(IMPORTED_KEY) || '{}') || {};
    const cur = all[userId] || { ids: [] };
    all[userId] = { ...cur, ...patch, ids: [...new Set([...(cur.ids || []), ...(patch.ids || [])])] };
    localStorage.setItem(IMPORTED_KEY, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}

const txSig = (t) => [t.type, t.date, Number(t.amount).toFixed(2), t.category || '', t.walletId || '', t.toWalletId || '', (t.note || '').trim()].join('|');

// Local rows the account does not have: not sent before, and not already there under another id
// (an older version of the app imported with new ids).
function localPending() {
  if (!isCloud()) return { count: 0 };
  const local = loadMoney();
  const done = new Set(importedFor(cloud.user.id).ids);
  const have = new Map();
  money.txns.filter((t) => t.scope !== 'shared' && t.type !== 'settle').forEach((t) => have.set(txSig(t), (have.get(txSig(t)) || 0) + 1));
  const txns = local.txns.filter((t) => {
    if (t.type === 'settle' || t.scope === 'shared' || done.has(t.id)) return false;
    const n = have.get(txSig(t)) || 0;
    if (n) { have.set(txSig(t), n - 1); return false; }
    return true;
  });
  const budgets = local.budgets.filter((x) => x.scope !== 'shared' && !done.has(`budget:${x.id}`)
    && !money.budgets.some((m) => m.scope !== 'shared' && m.category === x.category && m.walletId === x.walletId));
  const wallets = local.wallets.filter((w) => !money.wallets.some((m) => m.id === w.id) && (w.id !== 'cash' || w.initial));
  return { local, txns, budgets, wallets, count: txns.length + budgets.length + wallets.length };
}

async function offerLocalMerge(b, auto) {
  if (!isCloud() || cloud.user.id !== b.user.id) return;
  const p = localPending();
  const saveCash = () => { if (!b.wallets.length) saveWallet({ id: 'cash', name: 'เงินสด', type: 'cash', initial: 0, excluded: false }); };
  if (!p.count || (auto && importedFor(b.user.id).asked)) { saveCash(); return; }
  setImported(b.user.id, { asked: true });
  const what = [p.txns.length && `${p.txns.length} รายการรับจ่าย`, p.wallets.length && `${p.wallets.length} กระเป๋าเงิน`, p.budgets.length && `${p.budgets.length} งบประมาณ`].filter(Boolean).join(', ');
  if (!confirm(`เครื่องนี้มีข้อมูลที่ยังไม่อยู่ในบัญชีออนไลน์ (${what}) รวมเข้าบัญชีเลยไหม? ข้อมูลที่มีอยู่ในบัญชีจะไม่ถูกลบหรือแทนที่`)) { saveCash(); return; }
  await cloudImport({ wallets: p.local.wallets, txns: p.txns, budgets: p.budgets, prefs: p.local.prefs });
}

async function cloudImport(data) {
  try {
    const txns = (data.txns || []).filter((t) => t.type !== 'settle' && t.scope !== 'shared');
    const budgets = (data.budgets || []).filter((x) => x.scope !== 'shared');
    const r = await api('POST', '/import', { wallets: data.wallets || [], txns, budgets });
    setImported(cloud.user.id, { ids: [...txns.map((t) => t.id), ...budgets.map((x) => `budget:${x.id}`)].filter(Boolean) });
    // The account's own settings win; the device only fills in what the account has not set.
    if (data.prefs) { money.prefs = { ...data.prefs, ...money.prefs }; cloudSavePrefs(); }
    await cloudRefresh();
    toast(`รวมข้อมูลแล้ว ${r.imported} รายการ`);
  } catch (e) {
    toast(cloudErr(e));
  }
}

/* ---------- Bill planner sync ----------
   The planner (state: bills, records, settings) is one document per account with a revision
   number. Each device keeps the last copy it agreed on with the server (the base) and merges
   three ways: whatever changed on only one side since the base is kept, and when both sides
   changed the same field this device's edit wins. A device seeing the account for the first
   time adds its bills to the account's, matching bills that look the same (name + category). */

const PLANNER_BASE_KEY = 'centel.planner.base.v1'; // { userId, rev, data }

const planner = { timer: null, sending: null, again: false };

function plannerBase(userId) {
  try {
    const b = JSON.parse(localStorage.getItem(PLANNER_BASE_KEY) || 'null');
    return b && b.userId === userId ? b : null;
  } catch (e) { return null; }
}
function setPlannerBase(userId, rev, data) {
  try { localStorage.setItem(PLANNER_BASE_KEY, JSON.stringify({ userId, rev, data })); } catch (e) { /* full */ }
}

// The server stores JSON with its keys reordered, so compare by content, not by text.
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
const sameJson = (a, b) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && stableJson(a) === stableJson(b));

function pickMerged(base, local, remote) {
  if (sameJson(local, base)) return remote;
  if (sameJson(remote, base)) return local;
  const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!obj(local) || !obj(remote)) return local;
  const out = {};
  new Set([...Object.keys(remote), ...Object.keys(local)]).forEach((k) => {
    const v = pickMerged(obj(base) ? base[k] : undefined, local[k], remote[k]);
    if (v !== undefined) out[k] = v;
  });
  return out;
}

function plannerDoc(s) { return { bills: s.bills, records: s.records, settings: s.settings }; }
const emptyPlanner = () => ({ bills: [], records: {}, settings: {} });
const flatRecords = (records) => {
  const out = {};
  Object.entries(records || {}).forEach(([ym, m]) => Object.entries(m || {}).forEach(([id, r]) => { out[`${ym}|${id}`] = r; }));
  return out;
};

function mergePlanner(base, local, remote) {
  const moved = {};
  if (!base) {
    // First sync on this device: the same bill typed on two devices becomes one.
    const key = (b) => `${String(b.name || '').trim().toLowerCase()}|${b.category}|${b.type}`;
    const remoteIds = new Set(remote.bills.map((b) => b.id));
    const localIds = new Set(local.bills.map((b) => b.id));
    const free = new Map();
    remote.bills.filter((b) => !localIds.has(b.id)).forEach((b) => { if (!free.has(key(b))) free.set(key(b), b.id); });
    local.bills.forEach((b) => {
      if (remoteIds.has(b.id) || !free.has(key(b))) return;
      moved[b.id] = free.get(key(b));
      free.delete(key(b));
    });
    if (Object.keys(moved).length) {
      const records = {};
      Object.entries(local.records).forEach(([ym, m]) => {
        records[ym] = {};
        Object.entries(m).forEach(([id, r]) => { records[ym][moved[id] || id] = r; });
      });
      local = { ...local, bills: local.bills.map((b) => (moved[b.id] ? { ...b, id: moved[b.id] } : b)), records };
    }
    // Settings: the account's values win, this device fills in what the account has not set.
    base = { bills: [], records: {}, settings: {} };
    local = { ...local, settings: { ...local.settings, ...remote.settings } };
  }
  const B = Object.fromEntries((base.bills || []).map((b) => [b.id, b]));
  const L = Object.fromEntries(local.bills.map((b) => [b.id, b]));
  const R = Object.fromEntries(remote.bills.map((b) => [b.id, b]));
  const order = [...remote.bills.map((b) => b.id), ...local.bills.map((b) => b.id).filter((id) => !(id in R))];
  const bills = [...new Set(order)].map((id) => pickMerged(B[id], L[id], R[id])).filter(Boolean);
  const fb = flatRecords(base.records), fl = flatRecords(local.records), fr = flatRecords(remote.records);
  const records = {};
  new Set([...Object.keys(fr), ...Object.keys(fl)]).forEach((k) => {
    const r = pickMerged(fb[k], fl[k], fr[k]);
    if (!r || !Object.keys(r).length) return;
    const [ym, id] = k.split('|');
    (records[ym] = records[ym] || {})[id] = r;
  });
  const settings = pickMerged(base.settings || {}, local.settings || {}, remote.settings || {}) || {};
  return { doc: { bills, records, settings }, moved };
}

// Bring the account's planner into `state`; returns nothing, pushes if this device has more.
function plannerMergeIn(userId, remote) {
  if (!remote) return;
  const base = plannerBase(userId);
  const rdoc = remote.data ? { ...emptyPlanner(), ...remote.data } : emptyPlanner();
  const { doc, moved } = mergePlanner(base && base.data, plannerDoc(state), rdoc);
  if (Object.keys(moved).length) plannerMovedBills(moved);
  setPlannerBase(userId, remote.rev, rdoc);
  if (!sameJson(doc, plannerDoc(state))) {
    state = { ...state, ...doc, settings: { ...defaultState().settings, ...doc.settings } };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* full */ }
    updateBadge();
  }
  if (!sameJson(plannerDoc(state), rdoc)) plannerChanged(0);
}

// Bills matched to the account's copy got the account's id: follow it in this device's
// own transactions and stored invoice files.
function plannerMovedBills(moved) {
  try {
    const local = JSON.parse(localStorage.getItem(MONEY_KEY) || 'null');
    if (local && Array.isArray(local.txns)) {
      local.txns.forEach((t) => { if (t.billId && moved[t.billId]) t.billId = moved[t.billId]; });
      localStorage.setItem(MONEY_KEY, JSON.stringify(local));
    }
  } catch (e) { /* ignore */ }
  Object.entries(moved).forEach(([from, to]) => billFileMove(from, to));
}

// Called by save() in app.js whenever the planner changes on this device.
function plannerChanged(delay = 800) {
  if (!cloud.on || !cloud.fresh) return; // merged on the next refresh instead
  clearTimeout(planner.timer);
  planner.timer = setTimeout(plannerSend, delay);
}

async function plannerSend() {
  if (planner.sending) { planner.again = true; return; }
  const userId = cloud.user && cloud.user.id;
  if (!userId) return;
  planner.sending = (async () => {
    for (let i = 0; i < 4; i++) {
      const base = plannerBase(userId);
      const data = plannerDoc(state);
      if (base && sameJson(data, base.data)) return;
      try {
        const r = await api('PUT', '/planner', { data, baseRev: base ? base.rev : 0 });
        setPlannerBase(userId, r.rev, JSON.parse(JSON.stringify(data)));
        return;
      } catch (e) {
        // Another device saved first: merge its copy, then try again on top of it.
        if (e.status === 409 && e.data && e.data.error === 'stale') { plannerMergeIn(userId, e.data); render(); continue; }
        if (e.status === 401) { cloudSignedOut(); return; }
        return; // offline: kept locally, merged on the next refresh
      }
    }
  })();
  await planner.sending;
  planner.sending = null;
  if (planner.again) { planner.again = false; plannerSend(); }
}

/* ---------- Bill invoice files in the account (receipts bucket) ---------- */

function billFilesOn() { return isCloud() && cloud.features && cloud.features.storage; }
const billFilePath = (billId, ym) => `/api/bill-files/${encodeURIComponent(billId)}/${ym}`;

async function billFileUpload(billId, ym) {
  if (!billFilesOn()) return false;
  const f = await billFileGet(billId, ym).catch(() => null);
  if (!f || !f.blob) return false;
  const type = /pdf/i.test(f.type) ? 'application/pdf' : (f.type || 'image/jpeg');
  try {
    const res = await fetch(billFilePath(billId, ym), {
      method: 'PUT', credentials: 'same-origin', headers: { 'content-type': type, 'x-centel': '1' }, body: f.blob,
    });
    if (!res.ok) return false;
  } catch (e) { return false; }
  if (record(ym, billId).file) { setRecord(ym, billId, { fileCloud: true }); save(); }
  return true;
}

// A file attached on another device: fetch it from the account and keep a copy here.
async function billFileDownload(billId, ym) {
  if (!isCloud() || !record(ym, billId).fileCloud) return null;
  const res = await fetch(billFilePath(billId, ym), { credentials: 'same-origin' });
  if (!res.ok) return null;
  const blob = await res.blob();
  const f = { name: record(ym, billId).file || 'invoice', type: blob.type || 'application/pdf', blob, added: new Date().toISOString() };
  await filesTx('readwrite', (s) => s.put(f, billFileKey(billId, ym))).catch(() => {});
  return f;
}

function billFileRemoteDel(billId, ym) {
  if (!billFilesOn()) return;
  fetch(billFilePath(billId, ym), { method: 'DELETE', credentials: 'same-origin', headers: { 'x-centel': '1' } }).catch(() => {});
}

// Files attached before signing in (or while offline) go up once the account is reachable.
let sweeping = false;
async function billFilesSweep() {
  if (sweeping || !billFilesOn()) return;
  sweeping = true;
  try {
    for (const [ym, m] of Object.entries(state.records)) {
      for (const [id, r] of Object.entries(m)) {
        if (r.file && !r.fileCloud) await billFileUpload(id, ym);
      }
    }
  } finally { sweeping = false; }
}

async function logout() {
  if (!confirm('ออกจากระบบ? ข้อมูลยังอยู่ในบัญชีออนไลน์')) return;
  await cloud.queue;
  try { await api('POST', '/auth/logout'); } catch (e) { /* signed out anyway */ }
  cloudSignedOut();
  toast('ออกจากระบบแล้ว');
}

function coupleSheet() {
  if (!isCloud()) { loginSheet(); return; }
  if (cloud.partner) {
    openSheet(`
      <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>บัญชีคู่</h2><span style="width:40px"></span></div>
      <div class="card acct"><div class="avatar">💞</div><div><b>${esc(partnerName())}</b><div class="muted small">${esc(cloud.partner.email)}</div></div></div>
      <p class="hint">${esc(partnerName())} เห็นเฉพาะรายจ่ายร่วม งบร่วม และยอดค้างคืนของคุณทั้งสอง รายจ่ายส่วนตัวของแต่ละคนมองไม่เห็น</p>
    `);
    return;
  }
  const inv = cloud.invite;
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>เชื่อมบัญชีคู่</h2><span style="width:40px"></span></div>
    <div class="section-title">เชิญคู่ของคุณ</div>
    <div class="card" style="text-align:center">
      ${inv ? `<div class="invite-code">${esc(inv.code)}</div><div class="muted small">ใช้ได้ถึง ${thTime(inv.expiresAt)}</div>
        <button class="btn ghost" id="cpShare" style="margin-top:10px">ส่งรหัสให้คู่</button>`
    : '<div class="muted small">สร้างรหัสเชิญ แล้วส่งให้คู่ใส่ในแอปของเขา</div>'}
      <button class="btn ${inv ? 'ghost' : ''}" id="cpInvite" style="margin-top:10px">${inv ? 'สร้างรหัสใหม่' : 'สร้างรหัสเชิญ'}</button>
    </div>
    <div class="section-title">หรือใส่รหัสจากคู่</div>
    <div class="form"><div class="field"><label for="cpCode">รหัสเชิญ</label><input id="cpCode" maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="ABC123"></div></div>
    <button class="btn" id="cpJoin">เชื่อมบัญชี</button>
  `);
  $('#cpInvite').addEventListener('click', async () => {
    try { await api('POST', '/couple/invite'); await cloudRefresh(); coupleSheet(); } catch (e) { toast(cloudErr(e)); }
  });
  const share = $('#cpShare');
  if (share) share.addEventListener('click', async () => {
    const text = `ใส่รหัส ${inv.code} ในแอป centel.app (บัญชี > เชื่อมบัญชีคู่) เพื่อใช้บันทึกรายจ่ายร่วมกัน`;
    try {
      if (navigator.share) await navigator.share({ text, url: location.origin });
      else { await navigator.clipboard.writeText(text); toast('คัดลอกแล้ว'); }
    } catch (e) { /* cancelled */ }
  });
  $('#cpJoin').addEventListener('click', async () => {
    const code = $('#cpCode').value.trim().toUpperCase();
    if (code.length !== 6) { toast('รหัสเชิญมี 6 ตัวอักษร'); return; }
    try {
      await api('POST', '/couple/join', { code });
      await cloudRefresh();
      closeSheet();
      toast(`เชื่อมกับ ${partnerName()} แล้ว`);
    } catch (e) { toast(cloudErr(e)); }
  });
}

/* ---------- Events ---------- */

function cloudClick(t) {
  const st = t.closest('[data-settle]');
  if (st) { settleSheet(st.dataset.settle); return true; }
  return false;
}

function cloudAction(action, el) {
  switch (action) {
    case 'login': loginSheet(); break;
    case 'logout': logout(); break;
    case 'merge-local': offerLocalMerge({ user: cloud.user, wallets: money.wallets }, false); break;
    case 'couple': coupleSheet(); break;
    case 'settlements': settlementsSheet(); break;
    case 'shared-list': sharedListSheet(el.dataset.kind); break;
    case 'add-shared': txnForm(null, { scope: 'shared' }); break;
    default: return false;
  }
  return true;
}
