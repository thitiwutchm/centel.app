/* Signed-in mode: the account, the couple link and shared expenses live in the
   centel.app API (/api, see server/). Signed out, the app keeps working from localStorage.
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
};

function isCloud() { return cloud.on; }
// The partner by nickname (ชื่อเล่น) when they have set one.
function partnerName() { return (cloud.partner && (cloud.partner.nickname || cloud.partner.name)) || 'คู่ของฉัน'; }
function needNickname() { return isCloud() && !!cloud.user && !cloud.user.nickname; }
// A person's picture: an uploaded photo, their Google photo or an emoji; otherwise the first letter of their name.
const PHOTO_SRC = /^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*|https:\/\/[a-z0-9-]+\.googleusercontent\.com\/[^\s"'<>]+)$/;
function userImg(u) { return u && PHOTO_SRC.test(u.avatar || '') ? u.avatar : ''; }
function userFace(u) {
  const img = userImg(u);
  if (img) return `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">`;
  if (u && u.avatar) return esc(u.avatar);
  return esc(((u && u.name) || '?').slice(0, 1).toUpperCase());
}
function userAvatar(u, cls = 'avatar') { return `<div class="${cls}${userImg(u) ? ' has-img' : ''}">${userFace(u)}</div>`; }

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
  not_found: 'ไม่พบรายการ',
  too_large: 'ไฟล์ใหญ่เกินไป',
  storage_disabled: 'ยังไม่ได้ตั้งค่าที่เก็บสลิป',
  unauthorized: 'กรุณาเข้าสู่ระบบอีกครั้ง',
  bad_google_token: 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ ลองใหม่อีกครั้ง',
  google_unverified: 'อีเมล Google นี้ยังไม่ได้ยืนยัน',
  google_mismatch: 'อีเมลนี้เชื่อมกับบัญชี Google อื่นอยู่แล้ว',
  google_disabled: 'ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google',
  no_google_photo: 'บัญชี Google นี้ไม่มีรูปโปรไฟล์',
  google_other_account: 'บัญชี Google นี้ไม่ใช่บัญชีที่เข้าสู่ระบบอยู่',
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
    id: e.id, ownerId: e.ownerId, type: e.type, date: e.date, amount: e.amount, category: e.category && newCat(e.category),
    note: e.note || '', merchant: e.merchant || '', walletId: e.walletId, toWalletId: e.toWalletId,
    reviewNeeded: e.reviewNeeded, receiptKey: e.receiptKey, slipRef: e.slipRef, billId: e.billId, billYm: e.billYm,
    scope: e.scope, status: e.status, labels: e.labels || [],
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
    budgets: b.budgets.map((x) => ({ id: x.id, ownerId: x.ownerId, scope: x.scope, category: newCat(x.category), amount: x.amount, walletId: x.walletId })),
    labels: (b.labels || []).map((l) => ({ id: l.id, name: l.name })),
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
    try { localStorage.setItem(CLOUD_KEY, JSON.stringify(b)); } catch (e) { /* full */ }
    render();
    if (needNickname() && $('#sheet').hidden) nicknameSheet();
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
  cloud.user = cloud.partner = cloud.coupleId = cloud.invite = null;
  cloud.settlements = [];
  cloud.ids = new Set();
  try { localStorage.removeItem(CLOUD_KEY); } catch (e) { /* ignore */ }
  money = loadMoney();
  ui.wallet = 'total';
  ui.txFilter = 'all';
  ui.txLabel = '';
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

function cloudSaveTxn(t) {
  const shared = t.scope === 'shared';
  const body = {
    id: t.id, type: t.type, scope: shared ? 'shared' : 'personal', amount: shared ? t.total : t.amount, date: t.date,
    merchant: t.merchant, category: t.category, note: t.note, walletId: t.walletId, toWalletId: t.toWalletId,
    reviewNeeded: !!t.reviewNeeded, receiptKey: t.receiptKey, slipRef: t.slipRef, billId: t.billId, billYm: t.billYm,
    payerId: t.payerId, shares: shared ? { [cloud.user.id]: t.amount } : undefined,
    labels: t.labels || [],
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

// labels: the person's label names, so AI Slips can suggest the ones that fit.
// categories: the person's expense categories ({ id, name, parent }), so AI Slips picks from their own list.
async function uploadReceipt(file, labels = [], categories = []) {
  const image = await shrinkImage(file);
  return api('POST', '/receipts', { image, mediaType: 'image/jpeg', labels, categories });
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

// A shared expense is only a record for the partner to see. Its split says whose cost it is:
// 'full' when the payer bears all of it (รับผิดชอบทั้งหมด), else 'half' (หาร 2).
function splitOf(t) { return t.shares && Math.abs((t.shares[t.payerId] || 0) - t.total) < 0.005 ? 'full' : 'half'; }
function splitLine(t) {
  if (splitOf(t) === 'half') return `หาร 2 · ส่วนของฉัน ${baht(t.amount)}`;
  return t.payerId === cloud.user.id ? 'รับผิดชอบทั้งหมด' : `${esc(nameOf(t.payerId))} รับผิดชอบทั้งหมด`;
}

function coupleCard() {
  if (!isCloud()) return '';
  if (!cloud.partner) {
    return `
    <div class="card couple">
      <div class="cp-top"><span class="cp-ico">💞</span><div><b>ใช้ร่วมกับคู่ของคุณ</b>
        <div class="muted small">เชิญคู่เข้าบัญชี แยกรายจ่ายส่วนตัว และลงรายจ่ายร่วมให้อีกฝ่ายเห็น</div></div></div>
      <button class="btn pillbtn" data-action="couple">เชื่อมบัญชีคู่</button>
    </div>`;
  }
  const ym = ymOf(new Date());
  const month = sharedRows().filter((t) => t.counted && t.type === 'expense' && t.date.slice(0, 7) === ym);
  const total = month.reduce((n, t) => n + t.total, 0);
  const mine = month.reduce((n, t) => n + t.amount, 0);
  return `
    <div class="section-row"><span>ร่วมกับ ${esc(partnerName())}</span><button class="link-btn" data-action="shared-list">ดูทั้งหมด</button></div>
    <div class="card list-card couple">
      <button class="item" data-action="shared-list">
        <div class="ico round" style="background:#00b3a422">🤝</div>
        <div class="main"><div class="name">รายจ่ายร่วมเดือนนี้ ${baht(total)}</div><div class="sub">ส่วนของฉัน ${baht(mine)}</div></div>
        ${svgIcon('chev', 'svg-i sm muted')}
      </button>
      <div class="cp-actions"><button class="btn pillbtn" data-action="add-shared">＋ รายจ่ายร่วม</button></div>
    </div>`;
}

function sharedListSheet() {
  const list = sharedRows();
  const S = walletSet('total');
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>รายจ่ายร่วมทั้งหมด</h2><span style="width:40px"></span></div>
    ${list.length ? dayGroups(list, S) : '<div class="empty"><div class="e-ico">🤝</div>ไม่มีรายการ</div>'}
  `);
}

/* ---------- One shared expense ---------- */

function thTime(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear() + BE).slice(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function walletSelect(id, label) {
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}">
    <option value="">ไม่ระบุ</option>
    ${money.wallets.map((w) => `<option value="${w.id}" ${w.id === defaultWalletId() ? 'selected' : ''}>${esc(wEmoji(w))} ${esc(w.name)}</option>`).join('')}
  </select></div>`;
}

function sharedSheet(t) {
  const mineOwner = t.ownerId === cloud.user.id;
  const c = txCat(t);
  const partnerShare = t.shares[cloud.partner ? cloud.partner.id : ''] || 0;
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>รายจ่ายร่วม</h2>
      ${mineOwner ? `<button class="link-btn" id="shEdit">แก้ไข</button>` : '<span style="width:40px"></span>'}
    </div>
    <div class="card bd">
      <div class="b-top">${circleIco(c)}<div class="main"><div class="name big-name">${esc(t.merchant || c.label)}</div>
        <div class="sub">${esc(c.label)} · ${thDate(t.date)}</div></div></div>
      <div class="bd-body">
        <div class="bd-amt">${baht(t.total)}</div>
        <div class="badges"><span class="badge share">ร่วม</span></div>
        <div class="kv"><span>ผู้จ่าย</span><b>${esc(nameOf(t.payerId))}</b></div>
        <div class="kv"><span>ต้นทุน</span><b>${splitOf(t) === 'full' ? 'รับผิดชอบทั้งหมด' : 'หาร 2'}</b></div>
        <div class="kv"><span>ส่วนของฉัน</span><b>${baht(t.amount)}</b></div>
        <div class="kv"><span>ส่วนของ ${esc(partnerName())}</span><b>${baht(partnerShare)}</b></div>
        <div class="kv"><span>ลงโดย</span><b>${esc(nameOf(t.ownerId))}</b></div>
        ${t.note ? `<div class="kv"><span>บันทึก</span><span>${esc(t.note)}</span></div>` : ''}
        ${t.receiptKey ? '<button class="btn ghost" id="shReceipt">🧾 ดูสลิป</button>' : ''}
      </div>
    </div>
    <p class="hint">บันทึกไว้ให้ทั้งสองคนเห็นเท่านั้น ไม่ใช่การเรียกเก็บเงิน ส่วนของแต่ละคนใช้คำนวณต้นทุนในรายงาน</p>
    <div class="section-title">ป้ายกำกับของฉัน</div>
    <div class="chips lab-pick" id="shLabels"></div>
    ${mineOwner ? '<button class="btn danger" id="shDelete">ลบรายการ</button>' : ''}
  `);
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  // My own labels on this row; the partner never sees them.
  const picked = new Set(t.labels || []);
  labelPicker($('#shLabels'), picked, () => setTxnLabels(t, money.labels.filter((l) => picked.has(l.id)).map((l) => l.id)));
  on('#shEdit', () => txnForm(t));
  on('#shReceipt', () => openReceipt(t.receiptKey));
  on('#shDelete', () => {
    if (!confirm('ลบรายการนี้?')) return;
    deleteTxn(t);
    closeSheet(); render(); toast('ลบแล้ว');
  });
}

/* ---------- Repayments ---------- */

function settleItem(s) {
  const me = cloud.user.id;
  const e = money.txns.find((t) => t.id === s.expenseId);
  const owe = s.debtorId === me;
  const title = owe ? `คืนเงินให้${esc(partnerName())}` : `รับเงินคืนจาก${esc(partnerName())}`;
  return `
    <button class="item" data-settle="${s.id}">
      <div class="ico round" style="background:#00b3a422">🤝</div>
      <div class="main"><div class="name">${title}</div>
        <div class="sub">${e ? `${esc(e.merchant || txCat(e).label)} · ${thDate(e.date)}` : ''}</div>
        <div class="badges">${s.status === 'paid' ? `<span class="badge ok">ชำระแล้ว ${s.paidAt ? thDate(localDate(s.paidAt)) : ''}</span>` : '<span class="badge warn">ยังไม่ชำระ</span>'}</div></div>
      <div class="right"><div class="amt ${owe ? 'exp' : 'inc'}">${baht(s.amount)}</div></div>
    </button>`;
}

// Repayments recorded before shared expenses became records only; nothing new is owed.
function settlementsSheet() {
  if (!isCloud()) return;
  const paid = cloud.settlements.filter((s) => s.status === 'paid').slice().reverse();
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>การคืนเงินที่ผ่านมา</h2><span style="width:40px"></span></div>
    ${paid.length ? `<div class="list">${paid.map(settleItem).join('')}</div>` : '<div class="empty"><div class="e-ico">🤝</div>ไม่มีรายการ</div>'}
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
    ${myWallet ? '' : '<button class="btn" id="stWalletOnly">บันทึกกระเป๋าเงิน</button>'}
  `);
  if (myWallet) $('#stWallet').value = myWallet;
  const finish = (body, msg) => { cloudCall('POST', `/settlements/${s.id}`, body); closeSheet(); toast(msg); };
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
  on('#stWalletOnly', () => finish({ walletOnly: true, walletId: $('#stWallet').value || null }, 'บันทึกแล้ว'));
}

/* ---------- Account: sign in, couple link ---------- */

function accountCard() {
  if (isCloud()) {
    return `
    <button class="card acct tap" data-action="profile" aria-label="แก้ไขโปรไฟล์">
      ${userAvatar(cloud.user)}
      <div class="acct-main"><b>${esc(cloud.user.name)}</b><div class="muted small">${esc(cloud.user.email)} · ซิงก์กับบัญชีออนไลน์</div></div>
      ${svgIcon('chev', 'svg-i sm muted')}
    </button>
    <div class="list" style="margin-bottom:14px">
      <button class="item" data-action="couple"><div class="ico round" style="background:#ff4d8d22">💞</div>
        <div class="main"><div class="name">${cloud.partner ? `เชื่อมกับ ${esc(partnerName())}` : 'เชื่อมบัญชีคู่'}</div>
        <div class="sub">${cloud.partner ? esc(cloud.partner.email) : 'ส่งรหัสเชิญให้คู่ หรือใส่รหัสจากคู่'}</div></div>${svgIcon('chev', 'svg-i sm muted')}</button>
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
    theme: themeIsDark() ? 'filled_black' : 'outline',
    size: 'large', shape: 'pill', locale: LANG,
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
  const local = loadMoney();
  const b = await cloudRefresh();
  closeSheet();
  if (!b) { toast('เชื่อมต่อไม่สำเร็จ'); return; }
  toast(`สวัสดี ${b.user.name}`);
  offerImport(local, b);
}

function loginSheet(mode = 'login') {
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ยกเลิก</button><h2>${mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก'}</h2><span style="width:40px"></span></div>
    <div class="seg" id="lgMode"><button type="button" data-lg="login" class="${mode === 'login' ? 'on' : ''}">เข้าสู่ระบบ</button><button type="button" data-lg="register" class="${mode === 'register' ? 'on' : ''}">สมัครสมาชิก</button></div>
    <div class="gsignin" id="lgGoogle" hidden><div class="gbtn"></div><div class="or"><span>หรือใช้อีเมล</span></div></div>
    <form class="form" id="lgForm">
      ${mode === 'register' ? `<div class="field"><label for="lgName">ชื่อที่แสดง</label><input id="lgName" autocomplete="name" placeholder="เช่น ต้นกล้า ใจดี"></div>
        <div class="field"><label for="lgNick">ชื่อเล่น</label><input id="lgNick" maxlength="20" autocomplete="nickname" placeholder="เช่น ต้น"></div>` : ''}
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
      if (mode === 'register') {
        body.name = $('#lgName').value.trim();
        body.nickname = $('#lgNick').value.trim();
        if (!body.nickname) { toast('กรุณาใส่ชื่อเล่น'); $('#lgNick').focus(); return; }
      }
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

// The first sign-in can bring this device's records into the account.
async function offerImport(local, b) {
  const mine = b.expenses.filter((e) => e.ownerId === b.user.id).length;
  const hasLocal = local.txns.length || local.budgets.length || local.wallets.some((w) => w.id !== 'cash' || w.initial);
  if (!hasLocal || mine || b.wallets.length) {
    if (!b.wallets.length) saveWallet({ id: 'cash', name: 'เงินสด', type: 'cash', initial: 0, excluded: false });
    return;
  }
  if (!confirm(`นำข้อมูลในเครื่องนี้ (${local.txns.length} รายการ) ขึ้นบัญชีออนไลน์ไหม?`)) {
    saveWallet({ id: 'cash', name: 'เงินสด', type: 'cash', initial: 0, excluded: false });
    return;
  }
  await cloudImport(local);
}

async function cloudImport(data) {
  try {
    const r = await api('POST', '/import', {
      wallets: data.wallets || [],
      txns: (data.txns || []).filter((t) => t.type !== 'settle' && t.scope !== 'shared'),
      budgets: (data.budgets || []).filter((x) => x.scope !== 'shared'),
      labels: data.labels || [],
    });
    if (data.prefs) { money.prefs = { ...money.prefs, ...data.prefs }; cloudSavePrefs(); }
    await cloudRefresh();
    toast(`นำเข้า ${r.imported} รายการแล้ว`);
  } catch (e) {
    toast(cloudErr(e));
  }
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
      <div class="card acct">${cloud.partner.avatar ? userAvatar(cloud.partner) : '<div class="avatar">💞</div>'}<div><b>${esc(partnerName())}</b><div class="muted small">${esc(cloud.partner.email)}</div></div></div>
      <p class="hint">${esc(partnerName())} เห็นเฉพาะรายจ่ายร่วมและงบร่วมของคุณทั้งสอง รายจ่ายส่วนตัวของแต่ละคนมองไม่เห็น</p>
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

/* ---------- Profile: display name and picture ---------- */

function profileSheet() {
  if (!isCloud()) { loginSheet(); return; }
  const d = { name: cloud.user.name || '', avatar: cloud.user.avatar || '', googlePicture: cloud.user.googlePicture || '' };
  const emojis = WALLET_EMOJIS.concat(['😀', '😎', '🥰', '🐶', '🐱', '🐻', '🐼', '🦊', '🌸', '🍀'])
    .map((e) => `<button type="button" class="chip emoji" data-pemoji="${e}">${e}</button>`).join('');
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ยกเลิก</button>
      <h2>แก้ไขโปรไฟล์</h2>
      <button class="link-btn strong" id="saveProfile">บันทึก</button>
    </div>
    <div class="w-pic">
      <button type="button" class="w-avatar" id="pAvatar" aria-label="เปลี่ยนรูป"></button>
      <div class="w-pic-actions">
        <button type="button" class="chip" id="pPhoto">📷 เลือกรูป</button>
        <button type="button" class="chip" id="pEmojiBtn">😀 อีโมจิ</button>
        <button type="button" class="chip" id="pGoogle" hidden>รูปจาก Google</button>
        <button type="button" class="chip" id="pReset" hidden>ใช้ตัวอักษรย่อ</button>
      </div>
      <input type="file" id="pFile" accept="image/*" hidden>
    </div>
    <div class="gsignin gphoto" id="pGoogleBox" hidden><div class="gbtn"></div></div>
    <div class="chips w-emojis" id="pEmojis" hidden>${emojis}<input id="pEmojiIn" class="chip" placeholder="พิมพ์เอง" maxlength="8" autocomplete="off"></div>
    <div class="form">
      <div class="field"><label for="pName">ชื่อที่แสดง</label><input id="pName" maxlength="60" autocomplete="name" value="${esc(d.name)}"></div>
      <div class="field"><label for="pNick">ชื่อเล่น</label><input id="pNick" maxlength="20" autocomplete="nickname" placeholder="เช่น ต้น" value="${esc(cloud.user.nickname || '')}"></div>
      <div class="field"><label>อีเมล</label><span class="muted" style="flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis">${esc(cloud.user.email)}</span></div>
    </div>
    <p class="hint">ชื่อและรูปนี้จะแสดงในทุกเครื่องที่เข้าสู่ระบบ${cloud.partner ? ` และ ${esc(partnerName())} จะเห็นด้วย` : ' และคู่ของคุณเมื่อเชื่อมบัญชีแล้ว'}</p>
  `);
  const paint = () => {
    $('#pAvatar').innerHTML = userAvatar({ name: $('#pName').value.trim() || d.name, avatar: d.avatar }, 'w-avatar-in p-avatar-in') + '<span class="w-cam">✎</span>';
    $('#pReset').hidden = !d.avatar;
    $('#pGoogle').hidden = !d.googlePicture || d.avatar === d.googlePicture;
    document.querySelectorAll('#pEmojis [data-pemoji]').forEach((x) => x.classList.toggle('on', x.dataset.pemoji === d.avatar));
  };
  paint();
  $('#pName').addEventListener('input', paint);
  $('#pAvatar').addEventListener('click', () => $('#pFile').click());
  $('#pPhoto').addEventListener('click', () => $('#pFile').click());
  $('#pEmojiBtn').addEventListener('click', () => { $('#pEmojis').hidden = !$('#pEmojis').hidden; });
  $('#pReset').addEventListener('click', () => { d.avatar = ''; $('#pEmojiIn').value = ''; paint(); });
  $('#pGoogle').addEventListener('click', () => { d.avatar = d.googlePicture; paint(); });
  $('#pEmojis').addEventListener('click', (e) => {
    const c = e.target.closest('[data-pemoji]');
    if (c) { d.avatar = c.dataset.pemoji; $('#pEmojiIn').value = ''; paint(); }
  });
  $('#pEmojiIn').addEventListener('input', (e) => {
    const v = e.target.value.trim().replace(/[<>&"']/g, '');
    if (v) { d.avatar = [...v].slice(0, 4).join(''); paint(); }
  });
  $('#pFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { d.avatar = await squareImage(f, 240); paint(); } catch { toast('เปิดรูปนี้ไม่ได้'); }
  });
  // No Google photo kept yet (signed in before photos were saved, or with email):
  // a Google button fetches it from the person's own Google account.
  if (!d.googlePicture) googlePhotoButton($('#pGoogleBox'), (pic) => {
    d.googlePicture = cloud.user.googlePicture = pic;
    d.avatar = pic;
    $('#pGoogleBox').hidden = true;
    paint();
  });
  $('#saveProfile').addEventListener('click', async (e) => {
    const name = $('#pName').value.trim();
    const nickname = $('#pNick').value.trim();
    if (!name) { toast('กรุณาใส่ชื่อ'); $('#pName').focus(); return; }
    if (!nickname) { toast('กรุณาใส่ชื่อเล่น'); $('#pNick').focus(); return; }
    e.target.disabled = true;
    try {
      const r = await api('PUT', '/profile', { name, nickname, avatar: d.avatar || null });
      cloud.user = { ...cloud.user, name, nickname: r.nickname || nickname, avatar: r.avatar || undefined };
      closeSheet(); render(); toast('บันทึกโปรไฟล์แล้ว');
      cloudRefresh();
    } catch (err) {
      toast(cloudErr(err));
      e.target.disabled = false;
    }
  });
}

// Everyone needs a nickname (it names them on shared expenses), including accounts
// made before it existed. The sheet stays until one is saved.
function nicknameSheet() {
  if (!needNickname()) return;
  const guess = (cloud.user.name || '').trim().split(/\s+/)[0].slice(0, 20);
  openSheet(`
    <div class="sheet-head"><span style="width:40px"></span><h2>ตั้งชื่อเล่น</h2><button class="link-btn strong" id="saveNick">บันทึก</button></div>
    <div class="nick-hero">${userAvatar(cloud.user, 'avatar big')}<p>ชื่อเล่นจะแสดงให้${cloud.partner ? esc(cloud.partner.nickname || cloud.partner.name || 'คู่ของคุณ') : 'คู่ของคุณ'}เห็นในรายจ่ายร่วม</p></div>
    <form class="form" id="nickForm"><div class="field"><label for="nkName">ชื่อเล่น</label><input id="nkName" maxlength="20" autocomplete="nickname" placeholder="เช่น ต้น" value="${esc(guess)}"></div></form>
    <p class="hint">เปลี่ยนได้ภายหลังที่ บัญชี → แตะการ์ดโปรไฟล์</p>
  `);
  $('#sheet').dataset.locked = '1';
  const save = async (e) => {
    if (e) e.preventDefault();
    const nickname = $('#nkName').value.trim();
    if (!nickname) { toast('กรุณาใส่ชื่อเล่น'); $('#nkName').focus(); return; }
    $('#saveNick').disabled = true;
    try {
      const r = await api('PUT', '/profile', { name: cloud.user.name || nickname, nickname, avatar: cloud.user.avatar || null });
      cloud.user = { ...cloud.user, nickname: r.nickname || nickname };
      delete $('#sheet').dataset.locked;
      closeSheet(); render(); toast('บันทึกชื่อเล่นแล้ว');
    } catch (err) {
      toast(cloudErr(err));
      $('#saveNick').disabled = false;
    }
  };
  $('#saveNick').addEventListener('click', save);
  $('#nickForm').addEventListener('submit', save);
  setTimeout(() => $('#nkName') && $('#nkName').focus(), 300);
}

async function googlePhotoButton(box, done) {
  let id = '';
  try { id = await googleReady(); } catch (e) { /* offline: upload and emoji still work */ }
  if (!id || !box.isConnected) return;
  google.accounts.id.initialize({
    client_id: id, ux_mode: 'popup', auto_select: false,
    callback: async (r) => {
      try { done((await api('POST', '/profile/google', { credential: r.credential })).googlePicture); } catch (err) { toast(cloudErr(err)); }
    },
  });
  box.hidden = false;
  google.accounts.id.renderButton(box.querySelector('.gbtn'), {
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline',
    size: 'medium', shape: 'pill', locale: LANG, text: 'continue_with',
    width: Math.min(400, box.clientWidth || 320),
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
    case 'couple': coupleSheet(); break;
    case 'profile': profileSheet(); break;
    case 'settlements': settlementsSheet(); break;
    case 'shared-list': sharedListSheet(); break;
    case 'add-shared': txnForm(null, { scope: 'shared' }); break;
    default: return false;
  }
  return true;
}
