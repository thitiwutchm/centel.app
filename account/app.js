// Centel Account: the accounting web app served at account.centel.app.
// Plain JS, hash routes (#/docs/IV, #/doc/<id> …), talks to the api at /api/acc.
(() => {
  'use strict';
  const T = window.Thai;
  const { esc, money } = T;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const S = { user: null, businesses: [], bizId: null, boot: null };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  /* ---------- API ---------- */

  const ERR = {
    bad_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', email_taken: 'อีเมลนี้มีบัญชีแล้ว', weak_password: 'รหัสผ่านอย่างน้อย 8 ตัวอักษร',
    bad_email: 'อีเมลไม่ถูกต้อง', bad_name: 'กรุณากรอกชื่อ', no_lines: 'เพิ่มรายการอย่างน้อย 1 รายการ', bad_contact: 'เลือกหรือกรอกชื่อผู้ติดต่อ',
    already_received: 'ใบแจ้งหนี้นี้ออกใบเสร็จไปแล้ว', has_receipt: 'ยกเลิกใบเสร็จของใบแจ้งหนี้นี้ก่อน', doc_paid: 'ใบแจ้งหนี้ที่รับชำระแล้วแก้ไขไม่ได้ ยกเลิกใบเสร็จก่อน',
    doc_void: 'เอกสารถูกยกเลิกแล้ว', unbalanced: 'ยอดเดบิตและเครดิตต้องเท่ากัน', debit_and_credit: 'บรรทัดหนึ่งใส่ได้แค่เดบิตหรือเครดิต',
    unknown_account: 'มีรหัสบัญชีที่ไม่อยู่ในผังบัญชี', account_in_use: 'บัญชีนี้มีรายการหรือระบบใช้อยู่ ลบหรือเปลี่ยนหมวดไม่ได้',
    bad_pay_account: 'เลือกบัญชีเงินสดหรือธนาคาร', negative_total: 'ยอดรวมติดลบไม่ได้', confirm_name: 'พิมพ์ชื่อกิจการให้ตรงเพื่อยืนยัน',
    too_large: 'ไฟล์ใหญ่เกินไป', forbidden: 'ไม่มีสิทธิ์ทำรายการนี้', not_found: 'ไม่พบข้อมูล', too_many_requests: 'ลองใหม่อีกครั้งในอีกสักครู่',
    google_mismatch: 'อีเมลนี้ผูกกับบัญชี Google อื่นอยู่', ref_void: 'เอกสารต้นทางถูกยกเลิกแล้ว', bad_code: 'รหัสบัญชีไม่ถูกต้อง',
  };
  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-centel': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(ERR[json.error] || json.error || `ผิดพลาด (${res.status})`);
      e.status = res.status; e.code = json.error;
      throw e;
    }
    return json;
  }
  const A = (path) => `/acc/b/${S.bizId}${path}`;
  const get = (p) => api('GET', A(p));
  const post = (p, b) => api('POST', A(p), b || {});
  const put = (p, b) => api('PUT', A(p), b || {});

  let toastT;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `show${err ? ' err' : ''}`;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.className = ''; }, err ? 4200 : 2400);
  }
  const fail = (e) => { console.error(e); toast(e.message || 'เกิดข้อผิดพลาด', true); };

  // A modal dialog. body is HTML; onOk(el) returns false to keep it open. Resolves with onOk's result.
  function dialog({ title, body, ok = 'บันทึก', cancel = 'ยกเลิก', wide = false, danger = false, onOk, onOpen, extra = '' }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'dlg-back';
      back.innerHTML = `<div class="dlg${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
        <div class="dlg-h"><h3>${esc(title)}</h3><button class="x" data-x aria-label="ปิด">×</button></div>
        <div class="dlg-b">${body}</div>
        <div class="dlg-f">${extra}<span style="flex:1"></span>${cancel ? `<button class="btn" data-x>${esc(cancel)}</button>` : ''}${ok ? `<button class="btn ${danger ? 'dark' : 'primary'}" data-ok>${esc(ok)}</button>` : ''}</div></div>`;
      document.body.appendChild(back);
      const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      back.addEventListener('click', async (e) => {
        if (e.target === back || e.target.closest('[data-x]')) return close(null);
        if (e.target.closest('[data-ok]')) {
          const btn = e.target.closest('[data-ok]');
          btn.disabled = true;
          try {
            const r = onOk ? await onOk(back) : true;
            if (r !== false) close(r);
          } catch (err) { fail(err); } finally { btn.disabled = false; }
        }
      });
      if (onOpen) onOpen(back, close);
      const first = back.querySelector('input:not([type=checkbox]), select, textarea');
      if (first) setTimeout(() => first.focus(), 30);
    });
  }
  const confirmBox = (title, text, ok = 'ยืนยัน') => dialog({ title, body: `<p style="margin:0">${text}</p>`, ok, danger: true });
  const formData = (el) => {
    const o = {};
    for (const f of $$('[name]', el)) {
      if (f.type === 'checkbox') o[f.name] = f.checked;
      else if (f.type === 'radio') { if (f.checked) o[f.name] = f.value; } else o[f.name] = f.value;
    }
    return o;
  };

  /* ---------- Icons ---------- */
  const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    home: I('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
    qt: I('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/>'),
    iv: I('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
    re: I('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 12l3 3 5-6"/>'),
    ex: I('<path d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6"/>'),
    contacts: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5 5 0 0 1 3.5 6"/>'),
    items: I('<path d="M21 8l-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>'),
    accounts: I('<path d="M4 4h16v16H4zM4 9h16M9 9v11"/>'),
    journal: I('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>'),
    reports: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    settings: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    print: I('<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z"/>'),
    link: I('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    menu: I('<path d="M4 6h16M4 12h16M4 18h16"/>'),
    scan: I('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>'),
  };

  /* ---------- Auth ---------- */

  async function loadGoogle(container) {
    try {
      const cfg = await api('GET', '/config');
      if (!cfg.googleClientId) return;
      await new Promise((ok, no) => {
        if (window.google?.accounts) return ok();
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client'; s.onload = ok; s.onerror = no;
        document.head.appendChild(s);
      });
      window.google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: async (r) => {
          try { await api('POST', '/auth/google', { credential: r.credential }); start(); } catch (e) { fail(e); }
        },
      });
      container.hidden = false;
      window.google.accounts.id.renderButton($('.gbtn', container), { theme: 'outline', size: 'large', width: 340, text: 'continue_with', locale: 'th' });
    } catch { /* Google sign-in not available here */ }
  }

  function renderAuth() {
    let mode = 'login';
    app.innerHTML = `<div class="auth">
      <div class="auth-art">
        <div class="brand" style="padding:0"><span class="brand-mark">${ICON.journal}</span><div>Centel Account<small>account.centel.app</small></div></div>
        <div>
          <h1>บัญชีของธุรกิจคุณ<br>ครบในที่เดียว</h1>
          <p>ออกใบเสนอราคา ใบแจ้งหนี้ ใบเสร็จ และใบกำกับภาษี บันทึกค่าใช้จ่ายจากรูปบิล ระบบลงบัญชีคู่ให้อัตโนมัติ พร้อมรายงานภาษีซื้อขาย ภ.ง.ด. และงบการเงิน</p>
        </div>
        <svg class="ledger" viewBox="0 0 420 260" fill="none" aria-hidden="true">
          <rect x="20" y="20" width="380" height="230" rx="14" fill="#1E2126" stroke="#2C3038"/>
          ${[0, 1, 2, 3, 4, 5].map((i) => `<path d="M44 ${70 + i * 30}h220" stroke="#2C3038"/><path d="M300 ${70 + i * 30}h${60 - (i % 3) * 14}" stroke="${i === 5 ? '#F76707' : '#3A3F48'}" stroke-width="6" stroke-linecap="round"/>`).join('')}
          <path d="M44 46h120" stroke="#F76707" stroke-width="6" stroke-linecap="round"/>
        </svg>
        <div class="muted" style="font-size:12px">ส่วนหนึ่งของ Centel · ใช้บัญชีเดียวกับแอป Centel ได้</div>
      </div>
      <div class="auth-form"><form class="card" novalidate>
        <h2 data-t>เข้าสู่ระบบ</h2>
        <p class="muted" style="margin:0 0 18px" data-s>ใช้อีเมลเดียวกับบัญชี Centel</p>
        <div data-google hidden><div class="gbtn"></div><div class="or">หรือ</div></div>
        <div class="grid">
          <label class="field" data-name hidden><span>ชื่อ</span><input type="text" name="name" autocomplete="name"></label>
          <label class="field"><span>อีเมล</span><input type="email" name="email" autocomplete="email" required></label>
          <label class="field"><span>รหัสผ่าน</span><input type="password" name="password" autocomplete="current-password" required></label>
          <div class="err-text" data-err></div>
          <button class="btn primary" style="justify-content:center;height:42px" data-go>เข้าสู่ระบบ</button>
          <button type="button" class="btn ghost" data-switch>ยังไม่มีบัญชี? สมัครใช้งาน</button>
        </div>
      </form></div></div>`;
    const f = $('form', app);
    loadGoogle($('[data-google]', f));
    $('[data-switch]', f).onclick = () => {
      mode = mode === 'login' ? 'register' : 'login';
      $('[data-name]', f).hidden = mode === 'login';
      $('[data-t]', f).textContent = mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครใช้งาน';
      $('[data-go]', f).textContent = mode === 'login' ? 'เข้าสู่ระบบ' : 'สร้างบัญชี';
      $('[data-switch]', f).textContent = mode === 'login' ? 'ยังไม่มีบัญชี? สมัครใช้งาน' : 'มีบัญชีแล้ว? เข้าสู่ระบบ';
      $('[name=password]', f).autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(f);
      $('[data-err]', f).textContent = '';
      try {
        await api('POST', mode === 'login' ? '/auth/login' : '/auth/register', mode === 'login' ? { email: d.email, password: d.password } : { email: d.email, password: d.password, name: d.name || d.email.split('@')[0] });
        start();
      } catch (err) { $('[data-err]', f).textContent = err.message; }
    };
  }

  /* ---------- Businesses ---------- */

  function businessFields(b = {}) {
    return `<div class="grid g2">
      <label class="field span2"><span>ชื่อกิจการ (ตามที่จดทะเบียน)</span><input type="text" name="name" value="${esc(b.name || '')}" placeholder="บริษัท ตัวอย่าง จำกัด" required></label>
      <label class="field"><span>เลขประจำตัวผู้เสียภาษี</span><input type="text" name="tax_id" inputmode="numeric" maxlength="17" value="${esc(b.tax_id || '')}" placeholder="13 หลัก"></label>
      <label class="field"><span>สาขา</span><input type="text" name="branch" value="${esc(b.branch || '00000')}"><small>00000 = สำนักงานใหญ่</small></label>
      <label class="field span2"><span>ที่อยู่</span><textarea name="address" rows="2">${esc(b.address || '')}</textarea></label>
      <label class="field"><span>โทรศัพท์</span><input type="text" name="phone" value="${esc(b.phone || '')}"></label>
      <label class="field"><span>อีเมล</span><input type="email" name="email" value="${esc(b.email || '')}"></label>
      <label class="check span2"><input type="checkbox" name="vat_registered" ${b.vat_registered ? 'checked' : ''}> จดทะเบียนภาษีมูลค่าเพิ่ม (VAT 7%)</label>
    </div>`;
  }

  async function newBusiness(first) {
    const id = await dialog({
      title: first ? 'เริ่มต้นสร้างกิจการ' : 'เพิ่มกิจการ',
      body: `${first ? '<p class="muted" style="margin-top:0">ข้อมูลนี้จะพิมพ์บนหัวเอกสาร แก้ไขภายหลังได้ในหน้าตั้งค่า ระบบจะสร้างผังบัญชีมาตรฐานให้</p>' : ''}${businessFields()}`,
      ok: 'สร้างกิจการ', cancel: first ? '' : 'ยกเลิก',
      onOk: async (el) => (await api('POST', '/acc/businesses', formData(el))).id,
    });
    if (id) { S.bizId = id; store.set('acc.biz', id); await start(); location.hash = '#/dashboard'; }
    else if (first) newBusiness(true);
  }

  async function switchBusiness() {
    await dialog({
      title: 'เลือกกิจการ', ok: '', cancel: 'ปิด',
      body: `<div class="biz-list">${S.businesses.map((b) => `<button data-b="${b.id}">${b.logo ? `<img src="${esc(b.logo)}" width="36" height="36" style="object-fit:contain;border-radius:6px">` : `<span class="chip">${esc(b.name.slice(0, 2))}</span>`}<span><b>${esc(b.name)}</b><br><small class="muted">${esc(T.taxIdFmt(b.tax_id) || 'ยังไม่ใส่เลขผู้เสียภาษี')}${b.vat_registered ? ' · VAT' : ''}</small></span></button>`).join('')}
        <button data-new>${ICON.plus}<span>เพิ่มกิจการใหม่</span></button></div>`,
      onOpen: (el, close) => el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-b]');
        if (b) { close(); S.bizId = b.dataset.b; store.set('acc.biz', S.bizId); await loadBoot(); location.hash = '#/dashboard'; render(); }
        if (e.target.closest('[data-new]')) { close(); newBusiness(false); }
      }),
    });
  }

  async function loadBoot() {
    S.boot = await get('');
    S.boot.acc = new Map(S.boot.accounts.map((a) => [a.code, a]));
  }
  const biz = () => S.boot.business;
  const sysAcc = (k) => S.boot.accounts.find((a) => a.sys === k)?.code;
  const moneyAccounts = () => S.boot.accounts.filter((a) => a.active && a.type === 'asset' && (a.sys === 'cash' || a.sys === 'bank' || a.bank));
  const accName = (code) => { const a = S.boot.acc.get(code); return a ? `${a.code} ${a.name}` : code; };
  const accOptions = (types, sel, { money: allowMoney = false } = {}) => S.boot.accounts
    .filter((a) => a.active && types.includes(a.type) && (allowMoney || !(a.sys === 'cash' || a.sys === 'bank' || a.bank)))
    .map((a) => `<option value="${a.code}" ${a.code === sel ? 'selected' : ''}>${esc(a.code)} ${esc(a.name)}</option>`).join('');

  /* ---------- Shell and routing ---------- */

  const NAV = [
    ['ภาพรวม', [['dashboard', 'หน้าหลัก', ICON.home]]],
    ['รายรับ', [['docs/QT', 'ใบเสนอราคา', ICON.qt], ['docs/IV', 'ใบแจ้งหนี้', ICON.iv], ['docs/RE', 'ใบเสร็จรับเงิน', ICON.re]]],
    ['รายจ่าย', [['docs/EX', 'ค่าใช้จ่าย', ICON.ex]]],
    ['ข้อมูล', [['contacts', 'ผู้ติดต่อ', ICON.contacts], ['items', 'สินค้า / บริการ', ICON.items]]],
    ['บัญชี', [['journal', 'สมุดรายวัน', ICON.journal], ['accounts', 'ผังบัญชี', ICON.accounts], ['reports', 'รายงาน', ICON.reports], ['settings', 'ตั้งค่า', ICON.settings]]],
  ];

  function shell() {
    const b = biz();
    app.innerHTML = `<div class="shell">
      <aside class="rail">
        <div class="brand"><span class="brand-mark">${ICON.journal}</span><div>Centel Account<small>ระบบบัญชีออนไลน์</small></div></div>
        <button class="biz-switch" data-switch>${b.logo ? `<img src="${esc(b.logo)}" alt="">` : `<span class="ph">${esc(b.name.slice(0, 1))}</span>`}<span>${esc(b.name)}</span></button>
        <nav class="nav">${NAV.map(([h, items]) => `<div class="nav-h">${h}</div>${items.map(([r, label, ic]) => `<a href="#/${r}" data-r="${r}">${ic}${label}</a>`).join('')}`).join('')}</nav>
        <div class="rail-foot">${esc(S.user?.email || '')}<br><button data-logout>ออกจากระบบ</button></div>
      </aside>
      <div>
        <div class="topbar"><button data-menu aria-label="เมนู">${ICON.menu}</button><b>${esc(b.name)}</b></div>
        <main class="main" id="main"></main>
      </div></div>`;
    $('[data-switch]').onclick = switchBusiness;
    $('[data-menu]').onclick = () => $('.shell').classList.toggle('menu');
    $('.rail').addEventListener('click', (e) => { if (e.target.closest('a')) $('.shell').classList.remove('menu'); });
    $('.shell').addEventListener('click', (e) => { if (e.target === $('.shell') || (e.target.closest('.main') && $('.shell').classList.contains('menu'))) $('.shell').classList.remove('menu'); });
    $('[data-logout]').onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); location.hash = ''; start(); };
  }

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
  }

  async function render() {
    if (!S.boot) return;
    if (!$('.shell')) shell();
    const { parts, q } = parseHash();
    const r = parts[0] || 'dashboard';
    const key = r === 'docs' || r === 'new' ? `docs/${parts[1] || 'IV'}` : r === 'doc' || r === 'edit' ? null : r === 'report' ? 'reports' : r;
    for (const a of $$('.nav a')) a.classList.toggle('on', a.dataset.r === key);
    // A fresh element per page so listeners from the last page do not pile up.
    const old = $('#main');
    const main = old.cloneNode(false);
    old.replaceWith(main);
    main.innerHTML = '<div class="empty">กำลังโหลด…</div>';
    window.scrollTo(0, 0);
    try {
      if (r === 'dashboard') await viewDashboard(main, q);
      else if (r === 'docs') await viewDocs(main, parts[1] || 'IV', q);
      else if (r === 'new') await viewEditor(main, parts[1], null, q);
      else if (r === 'edit') await viewEditor(main, null, parts[1], q);
      else if (r === 'doc') await viewDoc(main, parts[1]);
      else if (r === 'contacts') viewContacts(main, q);
      else if (r === 'items') viewItems(main);
      else if (r === 'accounts') await viewAccounts(main);
      else if (r === 'journal') await viewJournal(main, q);
      else if (r === 'reports') viewReports(main);
      else if (r === 'report') await viewReport(main, parts[1], q);
      else if (r === 'settings') viewSettings(main);
      else main.innerHTML = '<div class="empty"><b>ไม่พบหน้านี้</b></div>';
    } catch (e) {
      if (e.status === 401) return start();
      main.innerHTML = `<div class="empty"><b>โหลดไม่สำเร็จ</b>${esc(e.message)}</div>`;
    }
  }
  window.addEventListener('hashchange', render);

  /* ---------- Shared bits ---------- */

  const statusChip = (type, s) => {
    const cls = s === 'void' ? 'bad' : s === 'paid' || s === 'done' || s === 'accepted' ? 'good' : s === 'rejected' ? 'bad' : type === 'QT' ? 'info' : 'warn';
    return `<span class="chip ${cls}">${esc(T.statusName(type, s))}</span>`;
  };
  const NEW_LABEL = { QT: 'สร้างใบเสนอราคา', IV: 'สร้างใบแจ้งหนี้', RE: 'สร้างใบเสร็จรับเงิน', EX: 'บันทึกค่าใช้จ่าย' };
  const ymNow = () => T.today().slice(0, 7);
  const monthRange = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
  };
  function csv(name, rows) {
    const text = '﻿' + rows.map((r) => r.map((c) => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = `${name}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function printHtml(html) {
    $('#print').innerHTML = html;
    const imgs = $$('#print img');
    Promise.all(imgs.map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = r; i.onerror = r; })))).then(() => {
      window.print();
    });
  }

  /* ---------- Dashboard ---------- */

  async function viewDashboard(main, q) {
    const month = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : ymNow();
    const d = await get(`/reports/dashboard?month=${month}`);
    const max = Math.max(1, ...d.months.flatMap((m) => [m.income, m.expense]));
    const W = 560; const H = 200; const bw = 26; const gap = W / 6;
    const bars = d.months.map((m, i) => {
      const x = i * gap + gap / 2 - bw - 2;
      const hi = (m.income / max) * (H - 40); const he = (m.expense / max) * (H - 40);
      return `<rect x="${x}" y="${H - 22 - hi}" width="${bw}" height="${hi}" rx="4" fill="var(--accent)"><title>รายได้ ${money(m.income)}</title></rect>
        <rect x="${x + bw + 4}" y="${H - 22 - he}" width="${bw}" height="${he}" rx="4" fill="var(--ink-2)" opacity=".55"><title>ค่าใช้จ่าย ${money(m.expense)}</title></rect>
        <text x="${i * gap + gap / 2}" y="${H - 4}" text-anchor="middle" font-size="12" fill="var(--muted)">${T.TH_MONTHS[Number(m.month.slice(5)) - 1]}</text>`;
    }).join('');
    main.innerHTML = `<div class="page-h"><div><h1>สวัสดี ${esc(S.user?.name || '')}</h1><div class="sub">${esc(biz().name)} · ${esc(T.thMonth(month))}</div></div>
      <div class="actions"><input type="month" value="${month}" data-month style="width:auto"></div></div>
      <div class="quick">
        <a href="#/new/QT"><span class="ic">QT</span><span><b>ใบเสนอราคา</b><small>เสนอราคาลูกค้า</small></span></a>
        <a href="#/new/IV"><span class="ic">IV</span><span><b>ใบแจ้งหนี้</b><small>วางบิล / ใบกำกับภาษี</small></span></a>
        <a href="#/new/RE"><span class="ic">RE</span><span><b>ใบเสร็จรับเงิน</b><small>ขายสด รับเงินทันที</small></span></a>
        <a href="#/new/EX"><span class="ic">EX</span><span><b>ค่าใช้จ่าย</b><small>สแกนบิลด้วย AI ได้</small></span></a>
      </div>
      <div class="kpis">
        <div class="card kpi"><div class="k">รายได้เดือนนี้</div><div class="v">${money(d.income)}</div><div class="d">ตามสมุดบัญชี ไม่รวม VAT</div></div>
        <div class="card kpi"><div class="k">ค่าใช้จ่ายเดือนนี้</div><div class="v">${money(d.expense)}</div><div class="d">ไม่รวมภาษีซื้อ</div></div>
        <div class="card kpi accent"><div class="k">กำไร (ขาดทุน)</div><div class="v">${money(d.net)}</div><div class="d">${d.income ? `อัตรากำไร ${Math.round((d.net / d.income) * 100)}%` : '—'}</div></div>
        <div class="card kpi"><div class="k">เงินสดและเงินฝาก</div><div class="v">${money(d.money.reduce((s, m) => s + m.amount, 0))}</div><div class="d">${d.money.length} บัญชี</div></div>
      </div>
      <div class="dash">
        <div class="grid">
          <div class="card"><div class="card-h"><h2>รายได้และค่าใช้จ่าย 6 เดือน</h2></div>
            <div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="กราฟรายได้และค่าใช้จ่าย">${bars}</svg></div>
            <div class="legend" style="padding-bottom:14px"><span><i style="background:var(--accent)"></i>รายได้</span><span><i style="background:var(--ink-2);opacity:.55"></i>ค่าใช้จ่าย</span></div></div>
          <div class="card"><div class="card-h"><h2>เอกสารล่าสุด</h2></div>
            ${d.recent.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${d.recent.map((r) => `<tr class="click" data-go="#/doc/${r.id}"><td><span class="doc-no">${esc(r.number)}</span><div class="muted" style="font-size:12px">${esc(T.TYPE_NAME[r.type])} · ${T.thDate(r.date)}</div></td><td>${esc(r.contact_name || '')}</td><td>${statusChip(r.type, r.status)}</td><td class="num">${money(r.total)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty"><b>ยังไม่มีเอกสาร</b>เริ่มจากสร้างใบเสนอราคาหรือใบแจ้งหนี้ใบแรก</div>'}</div>
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-h"><h2>ลูกหนี้ค้างรับ</h2><a class="btn sm ghost" href="#/report/ar">ดูทั้งหมด</a></div>
            <div class="card-pad"><div class="num" style="font-size:22px;font-weight:600">${money(d.ar.total)}</div><div class="muted">${d.ar.count} ใบ${d.ar.late ? ` · <span style="color:var(--bad)">เกินกำหนด ${money(d.ar.late)}</span>` : ''}</div></div></div>
          <div class="card"><div class="card-h"><h2>เจ้าหนี้ค้างจ่าย</h2><a class="btn sm ghost" href="#/report/ap">ดูทั้งหมด</a></div>
            <div class="card-pad"><div class="num" style="font-size:22px;font-weight:600">${money(d.ap.total)}</div><div class="muted">${d.ap.count} รายการ${d.ap.late ? ` · <span style="color:var(--bad)">เกินกำหนด ${money(d.ap.late)}</span>` : ''}</div></div></div>
          ${d.vat ? `<div class="card"><div class="card-h"><h2>ภาษีมูลค่าเพิ่ม (ภ.พ.30)</h2><a class="btn sm ghost" href="#/report/vat_summary?month=${month}">รายละเอียด</a></div>
            <ul class="mini-list"><li><span>ภาษีขาย</span><span class="num">${money(d.vat.sales.vat)}</span></li><li><span>ภาษีซื้อ</span><span class="num">${money(d.vat.purchase.vat)}</span></li>
            <li><b>${d.vat.payable >= 0 ? 'ต้องชำระ' : 'ขอคืน / ยกไป'}</b><b class="num">${money(Math.abs(d.vat.payable))}</b></li></ul></div>` : ''}
          <div class="card"><div class="card-h"><h2>บัญชีเงิน</h2><a class="btn sm ghost" href="#/accounts">จัดการ</a></div>
            <ul class="mini-list">${d.money.map((m) => `<li><a href="#/report/ledger?account=${m.code}" style="text-decoration:none">${esc(m.name)}</a><span class="num">${money(m.amount)}</span></li>`).join('')}</ul></div>
        </div>
      </div>`;
    $('[data-month]', main).onchange = (e) => { location.hash = `#/dashboard?m=${e.target.value}`; };
    main.addEventListener('click', (e) => { const tr = e.target.closest('[data-go]'); if (tr) location.hash = tr.dataset.go; });
  }

  /* ---------- Document lists ---------- */

  const LIST_TITLE = { QT: 'ใบเสนอราคา', IV: 'ใบแจ้งหนี้ / ใบวางบิล', RE: 'ใบเสร็จรับเงิน', EX: 'ค่าใช้จ่าย / บันทึกซื้อ' };

  async function viewDocs(main, type, q) {
    if (!LIST_TITLE[type]) type = 'IV';
    const period = q.get('p') || 'all';
    let range = '';
    const now = ymNow();
    if (period === 'month') { const [a, b] = monthRange(now); range = `&from=${a}&to=${b}`; }
    if (period === 'last') { const d = new Date(`${now}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); const [a, b] = monthRange(d.toISOString().slice(0, 7)); range = `&from=${a}&to=${b}`; }
    if (period === 'year') range = `&from=${now.slice(0, 4)}-01-01&to=${now.slice(0, 4)}-12-31`;
    const { docs } = await get(`/docs?type=${type}${range}`);
    const statuses = Object.keys(T.STATUS[type]);
    main.innerHTML = `<div class="page-h"><div><h1>${LIST_TITLE[type]}</h1><div class="sub">${docs.length} เอกสาร</div></div>
      <div class="actions"><a class="btn primary" href="#/new/${type}">${ICON.plus}${NEW_LABEL[type]}</a></div></div>
      <div class="card">
        <div class="filters">
          <input type="search" placeholder="ค้นหาเลขที่ หรือชื่อ" data-q>
          <select data-p>${[['all', 'ทุกช่วงเวลา'], ['month', 'เดือนนี้'], ['last', 'เดือนก่อน'], ['year', 'ปีนี้']].map(([v, l]) => `<option value="${v}" ${v === period ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <div class="seg" data-s><button class="on" data-v="">ทั้งหมด</button>${statuses.map((s) => `<button data-v="${s}">${T.statusName(type, s)}</button>`).join('')}</div>
        </div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>วันที่</th><th>เลขที่</th><th>${type === 'EX' ? 'ผู้ขาย' : 'ลูกค้า'}</th><th>สถานะ</th>${type === 'IV' || type === 'EX' ? '<th>ครบกำหนด</th>' : ''}<th class="num">ภาษี</th><th class="num">ยอดรวม</th></tr></thead>
        <tbody data-body></tbody><tfoot data-foot></tfoot></table></div>
      </div>`;
    let status = '';
    const draw = () => {
      const s = $('[data-q]', main).value.trim().toLowerCase();
      const rows = docs.filter((d) => (!status || d.status === status) && (!s || d.number.toLowerCase().includes(s) || (d.contact_name || '').toLowerCase().includes(s)));
      const today = T.today();
      $('[data-body]', main).innerHTML = rows.length ? rows.map((d) => `<tr class="click" data-id="${d.id}">
        <td>${T.thDate(d.date)}</td><td><span class="doc-no">${esc(d.number)}</span>${d.tax_invoice ? ' <span class="chip accent">ใบกำกับภาษี</span>' : ''}</td>
        <td>${esc(d.contact_name || '')}</td><td>${statusChip(type, d.status)}</td>
        ${type === 'IV' || type === 'EX' ? `<td${d.status === 'open' && d.due_date && d.due_date < today ? ' style="color:var(--bad)"' : ''}>${T.thDate(d.due_date)}</td>` : ''}
        <td class="num">${d.vat ? money(d.vat) : '–'}</td><td class="num">${money(d.total)}</td></tr>`).join('')
        : `<tr><td colspan="7"><div class="empty"><b>ยังไม่มี${LIST_TITLE[type]}</b><a class="btn primary" style="margin-top:12px" href="#/new/${type}">${NEW_LABEL[type]}</a></div></td></tr>`;
      const live = rows.filter((d) => d.status !== 'void');
      $('[data-foot]', main).innerHTML = live.length ? `<tr><td colspan="${type === 'IV' || type === 'EX' ? 5 : 4}">รวม ${live.length} รายการ (ไม่รวมที่ยกเลิก)</td><td class="num">${money(live.reduce((a, d) => a + d.vat, 0))}</td><td class="num">${money(live.reduce((a, d) => a + d.total, 0))}</td></tr>` : '';
    };
    draw();
    $('[data-q]', main).oninput = draw;
    $('[data-p]', main).onchange = (e) => { location.hash = `#/docs/${type}?p=${e.target.value}`; };
    $('[data-s]', main).onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      status = b.dataset.v;
      $$('[data-s] button', main).forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
    $('[data-body]', main).onclick = (e) => { const tr = e.target.closest('[data-id]'); if (tr) location.hash = `#/doc/${tr.dataset.id}`; };
  }

  /* ---------- Contacts ---------- */

  function contactForm(c = {}) {
    return `<div class="grid g2">
      <div class="field span2"><span>ประเภท</span><div class="seg" data-seg="kind">${[['customer', 'ลูกค้า'], ['vendor', 'ผู้ขาย / ผู้รับเงิน'], ['both', 'ทั้งสองแบบ']].map(([v, l]) => `<button type="button" data-v="${v}" class="${(c.kind || 'customer') === v ? 'on' : ''}">${l}</button>`).join('')}</div><input type="hidden" name="kind" value="${esc(c.kind || 'customer')}"></div>
      <div class="field span2"><span>รูปแบบ</span><div class="seg" data-seg="is_company"><button type="button" data-v="1" class="${c.is_company !== false ? 'on' : ''}">นิติบุคคล</button><button type="button" data-v="0" class="${c.is_company === false ? 'on' : ''}">บุคคลธรรมดา</button></div><input type="hidden" name="is_company" value="${c.is_company === false ? '0' : '1'}"></div>
      <label class="field span2"><span>ชื่อ</span><input type="text" name="name" value="${esc(c.name || '')}" required></label>
      <label class="field"><span>เลขประจำตัวผู้เสียภาษี</span><input type="text" name="tax_id" inputmode="numeric" value="${esc(c.tax_id || '')}"></label>
      <label class="field"><span>สาขา</span><input type="text" name="branch" value="${esc(c.branch || '')}" placeholder="00000 = สำนักงานใหญ่"></label>
      <label class="field span2"><span>ที่อยู่</span><textarea name="address" rows="2">${esc(c.address || '')}</textarea></label>
      <label class="field"><span>ผู้ติดต่อ</span><input type="text" name="contact_name" value="${esc(c.contact_name || '')}"></label>
      <label class="field"><span>โทรศัพท์</span><input type="text" name="phone" value="${esc(c.phone || '')}"></label>
      <label class="field"><span>อีเมล</span><input type="email" name="email" value="${esc(c.email || '')}"></label>
      <label class="field"><span>เครดิต (วัน)</span><input type="number" name="credit_days" min="0" value="${esc(c.credit_days ?? '')}"></label>
      <label class="field span2"><span>หมายเหตุ</span><input type="text" name="note" value="${esc(c.note || '')}"></label>
      ${c.id ? `<label class="check span2"><input type="checkbox" name="archived" ${c.archived ? 'checked' : ''}> ซ่อนผู้ติดต่อนี้</label>` : ''}
    </div>`;
  }
  const bindSegs = (el) => el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg] button'); if (!b) return;
    const seg = b.parentElement;
    $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
    $(`input[name="${seg.dataset.seg}"]`, el).value = b.dataset.v;
  });

  async function editContact(c = {}) {
    const saved = await dialog({
      title: c.id ? 'แก้ไขผู้ติดต่อ' : 'เพิ่มผู้ติดต่อ', body: contactForm(c), onOpen: bindSegs,
      onOk: async (el) => {
        const d = formData(el);
        d.is_company = d.is_company === '1';
        const r = c.id ? await put(`/contacts/${c.id}`, d) : await post('/contacts', d);
        return r.contact;
      },
    });
    if (saved) {
      const i = S.boot.contacts.findIndex((x) => x.id === saved.id);
      if (i >= 0) S.boot.contacts[i] = saved; else S.boot.contacts.push(saved);
      S.boot.contacts.sort((a, b) => a.name.localeCompare(b.name, 'th'));
    }
    return saved;
  }

  function viewContacts(main, q) {
    let kind = q.get('k') || '';
    main.innerHTML = `<div class="page-h"><div><h1>ผู้ติดต่อ</h1><div class="sub">ลูกค้าและผู้ขาย</div></div><div class="actions"><button class="btn primary" data-new>${ICON.plus}เพิ่มผู้ติดต่อ</button></div></div>
      <div class="card"><div class="filters"><input type="search" placeholder="ค้นหาชื่อ เลขผู้เสียภาษี" data-q>
        <div class="seg" data-k>${[['', 'ทั้งหมด'], ['customer', 'ลูกค้า'], ['vendor', 'ผู้ขาย']].map(([v, l]) => `<button data-v="${v}" class="${v === kind ? 'on' : ''}">${l}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" data-arch> แสดงที่ซ่อน</label></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>ชื่อ</th><th>ประเภท</th><th>เลขผู้เสียภาษี</th><th>โทร / อีเมล</th></tr></thead><tbody data-body></tbody></table></div></div>`;
    const draw = () => {
      const s = $('[data-q]', main).value.trim().toLowerCase();
      const arch = $('[data-arch]', main).checked;
      const rows = S.boot.contacts.filter((c) => (arch || !c.archived) && (!kind || c.kind === kind || c.kind === 'both') && (!s || c.name.toLowerCase().includes(s) || (c.tax_id || '').includes(s)));
      $('[data-body]', main).innerHTML = rows.length ? rows.map((c) => `<tr class="click" data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.archived ? ' <span class="chip">ซ่อน</span>' : ''}<div class="muted" style="font-size:12px">${c.is_company ? 'นิติบุคคล' : 'บุคคลธรรมดา'}${c.branch ? ` · ${esc(T.branchFmt(c.branch))}` : ''}</div></td>
        <td>${c.kind === 'customer' ? '<span class="chip info">ลูกค้า</span>' : c.kind === 'vendor' ? '<span class="chip warn">ผู้ขาย</span>' : '<span class="chip">ลูกค้า · ผู้ขาย</span>'}</td>
        <td class="mono">${esc(T.taxIdFmt(c.tax_id))}</td><td>${esc([c.phone, c.email].filter(Boolean).join(' · '))}</td></tr>`).join('')
        : '<tr><td colspan="4"><div class="empty"><b>ยังไม่มีผู้ติดต่อ</b>เพิ่มลูกค้าหรือผู้ขายเพื่อใช้ในเอกสาร</div></td></tr>';
    };
    draw();
    $('[data-q]', main).oninput = draw;
    $('[data-arch]', main).onchange = draw;
    $('[data-k]', main).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; kind = b.dataset.v; $$('[data-k] button', main).forEach((x) => x.classList.toggle('on', x === b)); draw(); };
    $('[data-new]', main).onclick = async () => { if (await editContact({ kind: kind || 'customer' })) draw(); };
    $('[data-body]', main).onclick = async (e) => {
      const tr = e.target.closest('[data-id]'); if (!tr) return;
      if (await editContact(S.boot.contacts.find((c) => c.id === tr.dataset.id))) draw();
    };
  }

  /* ---------- Items ---------- */

  async function editItem(it = {}) {
    const saved = await dialog({
      title: it.id ? 'แก้ไขสินค้า / บริการ' : 'เพิ่มสินค้า / บริการ',
      body: `<div class="grid g2">
        <div class="field span2"><span>ประเภท</span><div class="seg" data-seg="kind"><button type="button" data-v="service" class="${it.kind !== 'product' ? 'on' : ''}">บริการ</button><button type="button" data-v="product" class="${it.kind === 'product' ? 'on' : ''}">สินค้า</button></div><input type="hidden" name="kind" value="${it.kind || 'service'}"></div>
        <label class="field span2"><span>ชื่อ</span><input type="text" name="name" value="${esc(it.name || '')}"></label>
        <label class="field"><span>รหัส</span><input type="text" name="sku" value="${esc(it.sku || '')}"></label>
        <label class="field"><span>หน่วย</span><input type="text" name="unit" value="${esc(it.unit || '')}" placeholder="ชิ้น, ชั่วโมง, เดือน"></label>
        <label class="field"><span>ราคาขายต่อหน่วย</span><input type="number" step="0.01" name="price" class="num" value="${esc(it.price ?? '')}"></label>
        <label class="field"><span>บัญชีรายได้</span><select name="account">${accOptions(['income'], it.account || (it.kind === 'product' ? sysAcc('sales') : sysAcc('service')))}</select></label>
        <label class="field span2"><span>รายละเอียด (พิมพ์ใต้ชื่อในเอกสาร)</span><textarea name="description" rows="2">${esc(it.description || '')}</textarea></label>
        ${it.id ? `<label class="check span2"><input type="checkbox" name="archived" ${it.archived ? 'checked' : ''}> ซ่อนรายการนี้</label>` : ''}
      </div>`,
      onOpen: bindSegs,
      onOk: async (el) => (it.id ? await put(`/items/${it.id}`, formData(el)) : await post('/items', formData(el))).item,
    });
    if (saved) {
      const i = S.boot.items.findIndex((x) => x.id === saved.id);
      if (i >= 0) S.boot.items[i] = saved; else S.boot.items.push(saved);
    }
    return saved;
  }

  function viewItems(main) {
    main.innerHTML = `<div class="page-h"><div><h1>สินค้า / บริการ</h1><div class="sub">เลือกใช้ในเอกสารขายได้ทันที</div></div><div class="actions"><button class="btn primary" data-new>${ICON.plus}เพิ่มรายการ</button></div></div>
      <div class="card"><div class="filters"><input type="search" placeholder="ค้นหา" data-q></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>ชื่อ</th><th>ประเภท</th><th>บัญชีรายได้</th><th class="num">ราคา</th></tr></thead><tbody data-body></tbody></table></div></div>`;
    const draw = () => {
      const s = $('[data-q]', main).value.trim().toLowerCase();
      const rows = S.boot.items.filter((i) => !s || i.name.toLowerCase().includes(s) || (i.sku || '').toLowerCase().includes(s));
      $('[data-body]', main).innerHTML = rows.length ? rows.map((i) => `<tr class="click" data-id="${i.id}"><td><b>${esc(i.name)}</b>${i.archived ? ' <span class="chip">ซ่อน</span>' : ''}${i.sku ? `<div class="muted mono" style="font-size:12px">${esc(i.sku)}</div>` : ''}</td><td>${i.kind === 'product' ? 'สินค้า' : 'บริการ'}</td><td>${esc(accName(i.account) || '')}</td><td class="num">${money(i.price)}${i.unit ? ` <span class="muted">/ ${esc(i.unit)}</span>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="4"><div class="empty"><b>ยังไม่มีสินค้าหรือบริการ</b>บันทึกไว้เพื่อกรอกเอกสารได้เร็วขึ้น</div></td></tr>';
    };
    draw();
    $('[data-q]', main).oninput = draw;
    $('[data-new]', main).onclick = async () => { if (await editItem()) draw(); };
    $('[data-body]', main).onclick = async (e) => { const tr = e.target.closest('[data-id]'); if (tr && await editItem(S.boot.items.find((i) => i.id === tr.dataset.id))) draw(); };
  }

  /* ---------- Document editor ---------- */

  const blankLine = (type) => ({ name: '', desc: '', qty: 1, unit: '', price: 0, disc: 0, wht: 0, account: type === 'EX' ? sysAcc('other_expense') : sysAcc('service'), vat: true });

  async function viewEditor(main, type, editId, q) {
    const b = biz();
    let doc;
    let src = null;
    if (editId) {
      doc = (await get(`/docs/${editId}`)).doc;
      type = doc.type;
    } else {
      if (!LIST_TITLE[type]) type = 'IV';
      const credit = Number(b.settings?.creditDays ?? 30);
      doc = {
        type, date: T.today(), due_date: type === 'QT' ? addDays(T.today(), 30) : type === 'IV' ? addDays(T.today(), credit) : null,
        contact_id: null, contact: null, tax_invoice: false, price_mode: b.settings?.priceMode || 'excl', vat_rate: b.vat_registered ? 7 : 0,
        lines: [blankLine(type)], discount: 0, notes: '', pay: null,
      };
      const from = q.get('from');
      if (from) {
        src = (await get(`/docs/${from}`)).doc;
        Object.assign(doc, {
          contact_id: src.contact_id, contact: src.contact, price_mode: src.price_mode, vat_rate: Number(src.vat_rate),
          lines: src.lines.map((l) => ({ ...l })), discount: src.discount, tax_invoice: type === 'IV' ? src.tax_invoice : false,
        });
        if (q.get('copy') !== '1') doc.ref_id = src.id; else src = null;
      }
      if (type === 'RE') doc.pay = { date: T.today(), account: sysAcc('bank') || sysAcc('cash'), method: 'transfer', fee: 0 };
    }
    const fromInvoice = type === 'RE' && ((src && src.type === 'IV' && doc.ref_id) || (editId && doc.ref_id && (await get(`/docs/${doc.ref_id}`).catch(() => null))?.doc?.type === 'IV'));
    const isEx = type === 'EX';
    const vatReg = b.vat_registered;
    const lineTypes = isEx ? ['expense', 'asset'] : ['income'];
    const contacts = () => S.boot.contacts.filter((c) => !c.archived && (isEx ? c.kind !== 'customer' : c.kind !== 'vendor'));
    let paidNow = isEx ? !!doc.pay : false;
    if (isEx && !doc.pay) doc.pay = null;
    let payDraft = doc.pay || { date: T.today(), account: sysAcc('bank') || sysAcc('cash'), method: 'transfer', fee: 0 };
    let vatMode = Number(doc.vat_rate) > 0 ? doc.price_mode : 'none';
    if (isEx && !doc.tax_invoice) vatMode = 'none';

    const title = editId ? `แก้ไข ${doc.number}` : src ? `${NEW_LABEL[type]} จาก ${src.number}` : NEW_LABEL[type];
    main.innerHTML = `<div class="page-h"><div><h1>${esc(title)}</h1><div class="sub">${esc(T.docTitle({ ...doc, tax_invoice: doc.tax_invoice || (type === 'RE' && vatReg) }).join(' · '))}</div></div>
      <div class="actions"><a class="btn ghost" href="${editId ? `#/doc/${editId}` : `#/docs/${type}`}">ยกเลิก</a><button class="btn primary" data-save>บันทึก</button></div></div>
      <div class="editor">
        <div class="grid">
          ${isEx && !editId ? `<div class="scan-drop" data-scan>${ICON.scan}<b>สแกนบิล / ใบกำกับภาษีด้วย AI</b><span class="muted">เลือกรูปหรือ PDF ระบบจะกรอกผู้ขาย รายการ และภาษีให้</span><input type="file" accept="image/*,application/pdf" hidden></div>` : ''}
          <div class="card card-pad">
            <div class="grid g2">
              <div class="field span2"><span>${isEx ? 'ผู้ขาย / ผู้รับเงิน' : 'ลูกค้า'}</span><div class="contact-pick" data-cp></div></div>
              <label class="field"><span>วันที่</span><input type="date" name="date" value="${doc.date}"></label>
              ${type !== 'RE' ? `<label class="field"><span>${type === 'QT' ? 'ยืนราคาถึง' : 'ครบกำหนดชำระ'}</span><input type="date" name="due_date" value="${doc.due_date || ''}"></label>` : '<div></div>'}
              ${isEx ? `<label class="field"><span>เลขที่บิล / ใบกำกับภาษีของผู้ขาย</span><input type="text" name="ref_no" value="${esc(doc.ref_no || '')}"></label>
                <label class="field"><span>วันที่ในใบกำกับภาษี</span><input type="date" name="ref_date" value="${doc.ref_date || ''}"></label>` : ''}
            </div>
          </div>
          <div class="card card-pad">
            <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
              <h2 style="margin:0">รายการ</h2>
              <div class="actions" data-vatbox></div>
            </div>
            <div class="tbl-wrap"><table class="lines"><thead><tr><th>รายการ</th><th class="w-qty">จำนวน</th><th class="w-unit">หน่วย</th><th class="w-price">ราคา/หน่วย</th><th class="w-disc">ส่วนลด</th><th class="w-wht">หัก ณ ที่จ่าย</th><th class="w-amt">จำนวนเงิน</th><th class="w-x"></th></tr></thead><tbody data-lines></tbody></table></div>
            ${fromInvoice ? '<div class="note-box" style="margin-top:10px">รายการและยอดดึงจากใบแจ้งหนี้ แก้ได้เฉพาะภาษีหัก ณ ที่จ่ายที่ลูกค้าหัก</div>' : `<button class="btn sm add-line" data-add>${ICON.plus}เพิ่มรายการ</button>`}
            <datalist id="items-dl">${S.boot.items.filter((i) => !i.archived).map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>
          </div>
          <div class="card card-pad"><div class="grid g2">
            <label class="field"><span>หมายเหตุในเอกสาร</span><textarea name="notes" rows="3" placeholder="${esc(b.settings?.notes?.[type] || '')}">${esc(doc.notes || '')}</textarea></label>
            <div class="field" data-whtbox></div>
          </div></div>
        </div>
        <div class="side">
          <div class="card card-pad"><h2>สรุปยอด</h2><table class="sum-tbl" data-sum></table><div class="words" data-words></div></div>
          ${type === 'RE' || isEx ? '<div class="card card-pad" data-paybox></div>' : ''}
          <button class="btn primary" style="height:44px;justify-content:center" data-save>บันทึก${editId ? 'การแก้ไข' : ''}</button>
        </div>
      </div>`;

    // Contact picker
    const cp = $('[data-cp]', main);
    const drawContact = () => {
      if (doc.contact && doc.contact.name) {
        cp.innerHTML = `<div class="card" style="padding:10px 12px;display:flex;justify-content:space-between;gap:10px;box-shadow:none;background:var(--panel-2)">
          <div><b>${esc(doc.contact.name)}</b><div class="muted" style="font-size:12px">${esc([T.taxIdFmt(doc.contact.tax_id), T.branchFmt(doc.contact.branch), doc.contact.address].filter(Boolean).join(' · ') || 'ไม่มีเลขผู้เสียภาษี')}</div></div>
          ${fromInvoice ? '' : '<button class="btn sm ghost" data-change>เปลี่ยน</button>'}</div>`;
        const ch = $('[data-change]', cp);
        if (ch) ch.onclick = () => { doc.contact = null; doc.contact_id = null; drawContact(); $('input', cp)?.focus(); };
        return;
      }
      cp.innerHTML = `<input type="text" placeholder="พิมพ์ชื่อเพื่อค้นหา หรือเพิ่มใหม่" autocomplete="off"><div class="suggest" hidden></div>`;
      const inp = $('input', cp); const sg = $('.suggest', cp);
      const show = () => {
        const s = inp.value.trim().toLowerCase();
        const list = contacts().filter((c) => !s || c.name.toLowerCase().includes(s) || (c.tax_id || '').includes(s)).slice(0, 8);
        sg.innerHTML = list.map((c) => `<button type="button" data-id="${c.id}">${esc(c.name)}<small>${esc(T.taxIdFmt(c.tax_id) || '')}</small></button>`).join('')
          + `<button type="button" data-add>+ เพิ่ม${inp.value.trim() ? ` "${esc(inp.value.trim())}"` : ''} เป็นผู้ติดต่อใหม่</button>`;
        sg.hidden = false;
      };
      inp.onfocus = show; inp.oninput = show;
      inp.onblur = () => setTimeout(() => { sg.hidden = true; }, 180);
      sg.onmousedown = (e) => e.preventDefault();
      sg.onclick = async (e) => {
        const pick = e.target.closest('[data-id]');
        if (pick) { const c = S.boot.contacts.find((x) => x.id === pick.dataset.id); setContact(c); return; }
        if (e.target.closest('[data-add]')) { const c = await editContact({ name: inp.value.trim(), kind: isEx ? 'vendor' : 'customer' }); if (c) setContact(c); }
      };
    };
    const setContact = (c) => {
      doc.contact_id = c.id;
      doc.contact = { name: c.name, tax_id: c.tax_id, branch: c.branch, address: c.address, is_company: c.is_company };
      if (c.credit_days != null && type === 'IV' && !editId) { doc.due_date = addDays(doc.date, c.credit_days); const dd = $('[name=due_date]', main); if (dd) dd.value = doc.due_date; }
      drawContact();
      drawWht();
    };
    drawContact();

    // VAT controls
    const drawVat = () => {
      const box = $('[data-vatbox]', main);
      if (fromInvoice) { box.innerHTML = vatMode === 'none' ? '' : `<span class="chip">${vatMode === 'incl' ? 'ราคารวม VAT' : 'ราคาไม่รวม VAT'}</span>`; return; }
      const parts = [];
      if (isEx) parts.push(`<label class="check"><input type="checkbox" data-ti ${doc.tax_invoice ? 'checked' : ''}> ได้รับใบกำกับภาษี</label>`);
      else if (type === 'IV' && vatReg) parts.push(`<label class="check" title="ใช้เมื่อส่งมอบสินค้า (จุดความรับผิดชอบภาษีเกิดตอนส่งมอบ) ถ้าเป็นงานบริการ ใบเสร็จจะเป็นใบกำกับภาษีแทน"><input type="checkbox" data-ti ${doc.tax_invoice ? 'checked' : ''}> ออกเป็นใบกำกับภาษีด้วย</label>`);
      if ((isEx && doc.tax_invoice) || (!isEx && vatReg)) {
        parts.push(`<div class="seg" data-vm>${[['excl', 'ไม่รวม VAT'], ['incl', 'รวม VAT'], ['none', 'ไม่มี VAT']].map(([v, l]) => `<button type="button" data-v="${v}" class="${vatMode === v ? 'on' : ''}">${l}</button>`).join('')}</div>`);
      }
      box.innerHTML = parts.join('');
      const ti = $('[data-ti]', box);
      if (ti) ti.onchange = () => { doc.tax_invoice = ti.checked; if (isEx) vatMode = ti.checked ? 'excl' : 'none'; drawVat(); recalc(); };
      const vm = $('[data-vm]', box);
      if (vm) vm.onclick = (e) => { const bt = e.target.closest('button'); if (!bt) return; vatMode = bt.dataset.v; drawVat(); recalc(); };
    };

    // Lines
    const whtOpts = (v) => T.WHT_RATES.map((r) => `<option value="${r}" ${Number(v) === r ? 'selected' : ''}>${r ? `${r}%` : '–'}</option>`).join('');
    const drawLines = () => {
      $('[data-lines]', main).innerHTML = doc.lines.map((l, i) => `<tr data-i="${i}">
        <td class="l-name" data-l="รายการ"><input type="text" data-f="name" list="items-dl" value="${esc(l.name)}" placeholder="ชื่อสินค้า / บริการ" ${fromInvoice ? 'readonly' : ''}>
          <textarea data-f="desc" placeholder="รายละเอียด (ไม่บังคับ)" ${fromInvoice ? 'readonly' : ''}>${esc(l.desc || '')}</textarea>
          ${fromInvoice ? '' : `<label class="l-acc"><span>บัญชี</span><select data-f="account">${accOptions(lineTypes, l.account)}</select></label>`}</td>
        <td class="w-qty" data-l="จำนวน"><input type="number" step="any" class="num" data-f="qty" value="${l.qty}" ${fromInvoice ? 'readonly' : ''}></td>
        <td class="w-unit" data-l="หน่วย"><input type="text" data-f="unit" value="${esc(l.unit || '')}" ${fromInvoice ? 'readonly' : ''}></td>
        <td class="w-price" data-l="ราคา/หน่วย"><input type="number" step="0.01" class="num" data-f="price" value="${l.price}" ${fromInvoice ? 'readonly' : ''}></td>
        <td class="w-disc" data-l="ส่วนลด"><input type="number" step="0.01" class="num" data-f="disc" value="${l.disc || ''}" placeholder="0" ${fromInvoice ? 'readonly' : ''}></td>
        <td class="w-wht" data-l="หัก ณ ที่จ่าย"><select data-f="wht">${whtOpts(l.wht)}</select></td>
        <td class="w-amt num" data-l="จำนวนเงิน" data-amt></td>
        <td class="w-x">${fromInvoice || doc.lines.length < 2 ? '' : '<button class="rm" data-rm aria-label="ลบ">✕</button>'}</td></tr>`).join('');
      recalc();
    };
    const lt = $('[data-lines]', main);
    lt.addEventListener('input', (e) => {
      const tr = e.target.closest('[data-i]'); const f = e.target.dataset.f; if (!tr || !f) return;
      const l = doc.lines[Number(tr.dataset.i)];
      l[f] = ['qty', 'price', 'disc', 'wht'].includes(f) ? Number(e.target.value) || 0 : e.target.value;
      if (f === 'name') {
        const it = S.boot.items.find((x) => x.name === e.target.value);
        if (it) {
          Object.assign(l, { price: Number(it.price), unit: it.unit || '', desc: it.description || l.desc, account: !isEx && it.account ? it.account : l.account, itemId: it.id });
          drawLines(); return;
        }
      }
      recalc();
    });
    lt.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
    lt.addEventListener('click', (e) => { const rm = e.target.closest('[data-rm]'); if (!rm) return; doc.lines.splice(Number(rm.closest('[data-i]').dataset.i), 1); drawLines(); });
    const add = $('[data-add]', main);
    if (add) add.onclick = () => { doc.lines.push(blankLine(type)); drawLines(); $$('[data-f=name]', main).pop().focus(); };

    // Totals
    let totals;
    function recalc() {
      const vatRate = vatMode === 'none' ? 0 : 7;
      totals = T.computeTotals(doc.lines, { discount: doc.discount, priceMode: vatMode === 'incl' ? 'incl' : 'excl', vatRate });
      $$('[data-amt]', main).forEach((td, i) => { td.textContent = money(totals.amounts[i]); });
      const rows = [
        ['รวมเป็นเงิน', money(totals.subtotal)],
        [`ส่วนลดท้ายบิล`, fromInvoice ? money(totals.discount) : `<input type="number" step="0.01" class="num" data-disc value="${doc.discount || ''}" placeholder="0" style="width:120px;height:32px">`],
        vatRate ? ['มูลค่าก่อนภาษี', money(totals.vat_base)] : null,
        vatRate ? ['ภาษีมูลค่าเพิ่ม 7%', money(totals.vat)] : null,
      ].filter(Boolean);
      const sum = $('[data-sum]', main);
      const focused = document.activeElement?.hasAttribute?.('data-disc');
      sum.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')
        + `<tr class="grand"><td>ยอดรวม</td><td>${money(totals.total)}</td></tr>`
        + (totals.wht ? `<tr><td>หัก ณ ที่จ่าย</td><td>-${money(totals.wht)}</td></tr><tr class="net"><td>${isEx ? 'ยอดจ่ายสุทธิ' : 'ยอดรับสุทธิ'}</td><td>${money(totals.total - totals.wht)}</td></tr>` : '');
      $('[data-words]', main).textContent = `(${T.bahtText(totals.total)})`;
      const dIn = $('[data-disc]', sum);
      if (dIn) {
        dIn.oninput = () => { doc.discount = Number(dIn.value) || 0; recalc(); };
        if (focused) { dIn.focus(); const v = dIn.value; dIn.value = ''; dIn.value = v; }
      }
      drawWht();
      drawPay();
    }

    // WHT note / income type on expenses
    function drawWht() {
      const box = $('[data-whtbox]', main);
      if (!box || !totals) return;
      if (!totals.wht) { box.innerHTML = ''; return; }
      if (!isEx) { box.innerHTML = '<span>ภาษีหัก ณ ที่จ่าย</span><div class="note-box">ลูกค้าจะหักภาษี ณ ที่จ่าย และส่งหนังสือรับรอง 50 ทวิ ให้ ระบบบันทึกเป็นภาษีถูกหัก ณ ที่จ่าย (นำไปเครดิตภาษีเงินได้)</div>'; return; }
      const cur = doc.wht_cert || {};
      const form = cur.form || (doc.contact && doc.contact.is_company === false ? 'pnd3' : 'pnd53');
      box.innerHTML = `<span>หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ)</span>
        <div class="grid g2"><select data-wf><option value="pnd53" ${form === 'pnd53' ? 'selected' : ''}>ภ.ง.ด.53 (นิติบุคคล)</option><option value="pnd3" ${form === 'pnd3' ? 'selected' : ''}>ภ.ง.ด.3 (บุคคลธรรมดา)</option></select>
        <select data-wi>${['ค่าบริการ', 'ค่าจ้างทำของ', 'ค่าเช่า', 'ค่าโฆษณา', 'ค่าขนส่ง', 'ค่าวิชาชีพอิสระ', 'ค่านายหน้า', 'อื่น ๆ'].map((x) => `<option ${cur.income === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <small>ออกเลขที่หนังสือรับรองเมื่อบันทึกจ่ายเงิน</small>`;
      $('[data-wf]', box).onchange = (e) => { doc.wht_cert = { ...(doc.wht_cert || {}), form: e.target.value }; };
      $('[data-wi]', box).onchange = (e) => { doc.wht_cert = { ...(doc.wht_cert || {}), income: e.target.value }; };
      if (!doc.wht_cert) doc.wht_cert = { form, income: 'ค่าบริการ' };
    }

    // Payment box (receipts always; expenses when paid now)
    function drawPay() {
      const box = $('[data-paybox]', main);
      if (!box) return;
      const fields = `<div class="grid">
        <label class="field"><span>วันที่${isEx ? 'จ่าย' : 'รับ'}เงิน</span><input type="date" data-p="date" value="${payDraft.date}"></label>
        <label class="field"><span>${isEx ? 'จ่ายจาก' : 'รับเข้า'}</span><select data-p="account">${moneyAccounts().map((a) => `<option value="${a.code}" ${a.code === payDraft.account ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
        <label class="field"><span>วิธีชำระ</span><select data-p="method">${Object.entries(T.PAY_METHOD).map(([k, v]) => `<option value="${k}" ${k === payDraft.method ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>ค่าธรรมเนียมธนาคาร</span><input type="number" step="0.01" class="num" data-p="fee" value="${payDraft.fee || ''}" placeholder="0"></label></div>`;
      if (box.dataset.drawn) return;
      box.dataset.drawn = '1';
      box.innerHTML = isEx ? `<label class="check" style="margin-bottom:10px"><input type="checkbox" data-paid ${paidNow ? 'checked' : ''}> <b>จ่ายเงินแล้ว</b></label><div data-pf ${paidNow ? '' : 'hidden'}>${fields}</div>` : `<h2>การรับเงิน</h2>${fields}`;
      box.addEventListener('input', (e) => { const k = e.target.dataset.p; if (k) payDraft[k] = k === 'fee' ? Number(e.target.value) || 0 : e.target.value; });
      box.addEventListener('change', (e) => { const k = e.target.dataset.p; if (k) payDraft[k] = k === 'fee' ? Number(e.target.value) || 0 : e.target.value; });
      const pc = $('[data-paid]', box);
      if (pc) pc.onchange = () => { paidNow = pc.checked; $('[data-pf]', box).hidden = !paidNow; };
    }

    // Scan a purchase bill
    const scan = $('[data-scan]', main);
    if (scan) {
      const fi = $('input[type=file]', scan);
      scan.onclick = (e) => { if (e.target !== fi) fi.click(); };
      fi.onchange = async () => {
        const f = fi.files[0]; if (!f) return;
        scan.innerHTML = '<b>กำลังอ่านบิล…</b><span class="muted">ใช้เวลาประมาณ 5–15 วินาที</span>';
        try {
          const { data, mediaType } = await fileToUpload(f);
          const r = await post('/scan', { data, mediaType });
          doc.attachment = r.attachment;
          if (!r.result) { scan.innerHTML = '<b>แนบไฟล์แล้ว</b><span class="muted">อ่านข้อมูลอัตโนมัติไม่ได้ กรุณากรอกเอง</span>'; return; }
          applyScan(r.result);
          scan.innerHTML = `<b>อ่านบิลแล้ว ✓</b><span class="muted">ตรวจสอบข้อมูลก่อนบันทึก${r.result.confidence === 'low' ? ' (ภาพไม่ชัด ตรวจละเอียดอีกครั้ง)' : ''}</span>`;
        } catch (err) { fail(err); scan.innerHTML = '<b>สแกนไม่สำเร็จ</b><span class="muted">ลองอีกครั้ง หรือกรอกเอง</span>'; }
      };
    }
    async function applyScan(r) {
      if (r.date) { doc.date = r.date; $('[name=date]', main).value = r.date; }
      if (r.doc_no) $('[name=ref_no]', main).value = r.doc_no;
      if (r.tax_invoice && r.date) $('[name=ref_date]', main).value = r.date;
      doc.tax_invoice = !!r.tax_invoice && (r.vat || 0) > 0;
      vatMode = doc.tax_invoice ? r.price_mode : 'none';
      if (Array.isArray(r.lines) && r.lines.length) doc.lines = r.lines.map((l) => ({ ...blankLine('EX'), name: l.name, qty: l.qty || 1, price: l.price || 0, account: r.account || sysAcc('other_expense') }));
      else if (r.total) doc.lines = [{ ...blankLine('EX'), name: r.vendor?.name || 'ค่าใช้จ่าย', price: r.total, account: r.account || sysAcc('other_expense') }];
      if (r.vendor?.name) {
        let c = S.boot.contacts.find((x) => (r.vendor.tax_id && x.tax_id === r.vendor.tax_id) || x.name === r.vendor.name);
        if (!c) {
          c = (await post('/contacts', { kind: 'vendor', name: r.vendor.name, tax_id: r.vendor.tax_id, branch: r.vendor.branch, address: r.vendor.address, is_company: r.vendor.is_company })).contact;
          S.boot.contacts.push(c);
        }
        setContact(c);
      }
      drawVat(); drawLines();
      if (r.total && Math.abs(r.total - totals.total) > 0.01) toast(`ยอดในบิล ${money(r.total)} ต่างจากที่คำนวณ ${money(totals.total)} ตรวจสอบรายการอีกครั้ง`, true);
    }

    drawVat();
    drawLines();
    main.addEventListener('input', (e) => {
      if (e.target.name === 'date') { doc.date = e.target.value; if (!fromInvoice && type === 'RE' && payDraft) { payDraft.date = e.target.value; const pd = $('[data-p=date]', main); if (pd) pd.value = e.target.value; } }
      if (e.target.name === 'due_date') doc.due_date = e.target.value;
    });

    const save = async (btn) => {
      btn.disabled = true;
      try {
        const body = {
          type, date: doc.date, due_date: $('[name=due_date]', main)?.value || null, contact_id: doc.contact_id,
          contact: doc.contact_id ? undefined : doc.contact, tax_invoice: doc.tax_invoice, price_mode: vatMode === 'incl' ? 'incl' : 'excl',
          vat_rate: vatMode === 'none' ? 0 : 7, lines: doc.lines, discount: doc.discount, notes: $('[name=notes]', main).value,
          ref_id: doc.ref_id, ref_no: $('[name=ref_no]', main)?.value, ref_date: $('[name=ref_date]', main)?.value || null,
          attachment: doc.attachment, wht_income: doc.wht_cert?.income, wht_form: doc.wht_cert?.form,
        };
        if (!body.contact_id && !body.contact) throw new Error('เลือกหรือเพิ่ม' + (isEx ? 'ผู้ขาย' : 'ลูกค้า'));
        if (type === 'RE') body.pay = payDraft;
        if (isEx) body.pay = paidNow ? payDraft : null;
        const r = editId ? await put(`/docs/${editId}`, body) : await post('/docs', body);
        toast(editId ? 'บันทึกการแก้ไขแล้ว' : `สร้าง ${r.doc.number} แล้ว`);
        location.hash = `#/doc/${r.doc.id}`;
      } catch (e) { fail(e); } finally { btn.disabled = false; }
    };
    $$('[data-save]', main).forEach((bt) => { bt.onclick = () => save(bt); });
  }

  function addDays(d, n) {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + Number(n || 0));
    return t.toISOString().slice(0, 10);
  }

  // Images are shrunk to about 2000px JPEG before upload; PDFs go as they are.
  async function fileToUpload(f) {
    if (f.type === 'application/pdf') {
      if (f.size > 8 * 1024 * 1024) throw new Error('ไฟล์ PDF ใหญ่เกิน 8 MB');
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { data: btoa(bin), mediaType: 'application/pdf' };
    }
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(f); });
    const k = Math.min(1, 2000 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/jpeg', 0.85).split(',')[1], mediaType: 'image/jpeg' };
  }

  /* ---------- Document view ---------- */

  async function viewDoc(main, id) {
    const { doc, ref, children, journal } = await get(`/docs/${id}`);
    const b = biz();
    const printable = { ...doc, ref };
    const t = doc.type;
    const live = doc.status !== 'void';
    const acts = [];
    if (live && t === 'QT') acts.push(`<a class="btn primary" href="#/new/IV?from=${doc.id}">แปลงเป็นใบแจ้งหนี้</a>`, `<a class="btn" href="#/new/RE?from=${doc.id}">ออกใบเสร็จ (ขายสด)</a>`);
    if (live && t === 'IV' && doc.status === 'open') acts.push(`<a class="btn primary" href="#/new/RE?from=${doc.id}">รับชำระเงิน</a>`);
    if (live && t === 'EX' && doc.status === 'open') acts.push('<button class="btn primary" data-act="pay">บันทึกจ่ายเงิน</button>');
    if (live && t === 'EX' && doc.status === 'paid' && doc.wht > 0) acts.push('<button class="btn" data-act="wht">พิมพ์ 50 ทวิ</button>');
    const more = [];
    if (live && !(t === 'IV' && doc.status === 'paid')) more.push(`<a class="btn" href="#/edit/${doc.id}">แก้ไข</a>`);
    if (t !== 'EX') more.push(`<button class="btn" data-act="share">${ICON.link}${doc.public_token ? 'คัดลอกลิงก์' : 'สร้างลิงก์ให้ลูกค้า'}</button>`);
    more.push(`<a class="btn" href="#/new/${t}?from=${doc.id}&copy=1">ทำซ้ำ</a>`);
    if (live && t === 'QT') more.push(`<button class="btn" data-act="qt" data-v="${doc.status === 'rejected' ? 'open' : 'rejected'}">${doc.status === 'rejected' ? 'เปิดใหม่' : 'ลูกค้าไม่อนุมัติ'}</button>`);
    if (live && t === 'EX' && doc.status === 'paid') more.push('<button class="btn" data-act="unpay">ยกเลิกการจ่าย</button>');
    if (live) more.push('<button class="btn danger" data-act="void">ยกเลิกเอกสาร</button>');

    main.innerHTML = `<div class="page-h"><div><h1><span class="mono">${esc(doc.number)}</span></h1><div class="sub">${esc(T.docTitle(doc)[0])} · ${statusChip(t, doc.status)}</div></div>
      <div class="actions">${acts.join('')}<button class="btn dark" data-act="print">${ICON.print}พิมพ์ / PDF</button></div></div>
      <div class="view">
        <div class="paper-wrap" data-paper>${T.renderDoc(printable, b)}</div>
        <div class="side">
          <div class="card card-pad"><dl class="kv">
            <dt>${t === 'EX' ? 'ผู้ขาย' : 'ลูกค้า'}</dt><dd>${esc(doc.contact?.name || '')}</dd>
            <dt>ยอดรวม</dt><dd class="num">${money(doc.total)}</dd>
            ${doc.vat ? `<dt>ภาษีมูลค่าเพิ่ม</dt><dd class="num">${money(doc.vat)}</dd>` : ''}
            ${doc.wht ? `<dt>หัก ณ ที่จ่าย</dt><dd class="num">${money(doc.wht)}</dd>` : ''}
            ${doc.pay ? `<dt>${t === 'EX' ? 'จ่ายเมื่อ' : 'รับเงินเมื่อ'}</dt><dd>${T.thDate(doc.pay.date)}</dd><dt>บัญชี</dt><dd>${esc(accName(doc.pay.account))}</dd>` : ''}
            ${doc.wht_cert?.number ? `<dt>เลขที่ 50 ทวิ</dt><dd class="mono">${esc(doc.wht_cert.number)}</dd>` : ''}
            ${doc.ref_no ? `<dt>เลขที่บิลผู้ขาย</dt><dd>${esc(doc.ref_no)}</dd>` : ''}
          </dl>
          ${doc.attachment ? '<button class="btn sm" style="margin-top:12px" data-act="file">ดูไฟล์บิลที่แนบ</button>' : ''}</div>
          <div class="card card-pad"><div class="actions">${more.join('')}</div></div>
          ${ref || children.length ? `<div class="card card-pad"><h2>เอกสารที่เกี่ยวข้อง</h2><div class="rel">
            ${ref ? `<a href="#/doc/${ref.id}"><span>${esc(T.TYPE_NAME[ref.type])} <span class="mono">${esc(ref.number)}</span></span>${statusChip(ref.type, ref.status)}</a>` : ''}
            ${children.map((c) => `<a href="#/doc/${c.id}"><span>${esc(T.TYPE_NAME[c.type])} <span class="mono">${esc(c.number)}</span></span>${statusChip(c.type, c.status)}</a>`).join('')}</div></div>` : ''}
          <div class="card card-pad"><h2>บันทึกบัญชี</h2>${journal.length ? `<table class="journal-mini"><tbody>${journal.map((j) => `<tr><td>${j.debit ? '' : '&emsp;'}${esc(j.account)} ${esc(j.name || '')}</td><td class="num">${j.debit ? money(j.debit) : ''}</td><td class="num">${j.credit ? money(j.credit) : ''}</td></tr>`).join('')}</tbody></table>`
    : `<div class="muted" style="font-size:13px">${t === 'QT' ? 'ใบเสนอราคาไม่ลงบัญชี' : doc.status === 'void' ? 'เอกสารถูกยกเลิก ไม่มีรายการบัญชี' : '—'}</div>`}</div>
        </div>
      </div>`;
    fitPaper(main);

    main.onclick = async (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      try {
        if (act === 'print') printHtml(T.renderDoc(printable, b, { copy: 'ต้นฉบับ' }) + (t === 'EX' ? '' : T.renderDoc(printable, b, { copy: 'สำเนา' })));
        if (act === 'wht') printHtml(T.renderWht(doc, b));
        if (act === 'share') {
          const { token } = await post(`/docs/${doc.id}/share`);
          const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}doc.html?t=${token}`;
          await dialog({
            title: 'ลิงก์สำหรับลูกค้า', ok: 'คัดลอกลิงก์', cancel: 'ปิด', extra: '<button class="btn danger" data-off>ปิดลิงก์</button>',
            body: `<p class="muted" style="margin-top:0">ลูกค้าเปิดดูและบันทึกเป็น PDF ได้โดยไม่ต้องเข้าสู่ระบบ</p><input type="text" readonly value="${esc(url)}">`,
            onOpen: (el, close) => { $('[data-off]', el).onclick = async () => { await post(`/docs/${doc.id}/share`, { off: true }); toast('ปิดลิงก์แล้ว'); close(); render(); }; },
            onOk: async () => { await navigator.clipboard.writeText(url).catch(() => {}); toast('คัดลอกลิงก์แล้ว'); return true; },
          });
          render();
        }
        if (act === 'pay') {
          const ok = await dialog({
            title: `จ่ายเงิน ${doc.number}`,
            body: `<div class="grid g2"><label class="field"><span>วันที่จ่าย</span><input type="date" name="date" value="${T.today()}"></label>
              <label class="field"><span>จ่ายจาก</span><select name="account">${moneyAccounts().map((m) => `<option value="${m.code}" ${m.sys === 'bank' ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
              <label class="field"><span>วิธีชำระ</span><select name="method">${Object.entries(T.PAY_METHOD).map(([k, v]) => `<option value="${k}" ${k === 'transfer' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
              <label class="field"><span>ค่าธรรมเนียม</span><input type="number" step="0.01" name="fee" class="num" placeholder="0"></label></div>
              <p class="muted">ยอดจ่าย ${money(doc.total - doc.wht)} บาท${doc.wht ? ` (หัก ณ ที่จ่าย ${money(doc.wht)} บาท ระบบออกเลขที่ 50 ทวิ ให้)` : ''}</p>`,
            onOk: async (el) => post(`/docs/${doc.id}/pay`, { pay: formData(el) }),
          });
          if (ok) { toast('บันทึกจ่ายเงินแล้ว'); render(); }
        }
        if (act === 'unpay' && await confirmBox('ยกเลิกการจ่ายเงิน', 'รายการจะกลับเป็นรอจ่าย และรายการบัญชีการจ่ายจะถูกลบ')) { await post(`/docs/${doc.id}/pay`, { pay: null }); render(); }
        if (act === 'qt') { await post(`/docs/${doc.id}/status`, { status: a.dataset.v }); render(); }
        if (act === 'void') {
          const ok = await dialog({
            title: `ยกเลิก ${doc.number}`, ok: 'ยกเลิกเอกสาร', danger: true,
            body: `<p style="margin-top:0">เอกสารจะถูกขีดว่ายกเลิก เลขที่เดิมจะไม่ถูกนำมาใช้ซ้ำ และรายการบัญชีของเอกสารนี้จะถูกลบ</p><label class="field"><span>เหตุผล</span><input type="text" name="reason"></label>`,
            onOk: async (el) => post(`/docs/${doc.id}/void`, formData(el)),
          });
          if (ok) { toast('ยกเลิกแล้ว'); render(); }
        }
        if (act === 'file') { const { url } = await get(`/attachment?key=${encodeURIComponent(doc.attachment)}`); window.open(url, '_blank', 'noopener'); }
      } catch (err) { fail(err); }
    };
  }

  // Scales the A4 paper down to fit narrow screens.
  function fitPaper(main) {
    const wrap = $('[data-paper]', main);
    const p = wrap && $('.paper', wrap);
    if (!p) return;
    const k = Math.min(1, wrap.clientWidth / p.offsetWidth);
    p.style.transform = k < 1 ? `scale(${k})` : '';
    p.style.transformOrigin = 'top left';
    wrap.style.height = k < 1 ? `${p.offsetHeight * k}px` : '';
  }
  window.addEventListener('resize', () => { const m = $('#main'); if (m) fitPaper(m); });

  /* ---------- Chart of accounts ---------- */

  const TYPE_TH = { asset: 'สินทรัพย์', liability: 'หนี้สิน', equity: 'ส่วนของเจ้าของ', income: 'รายได้', expense: 'ค่าใช้จ่าย' };

  async function viewAccounts(main) {
    const tb = await get(`/reports/trial?from=1900-01-01&to=${T.today()}`);
    const bal = new Map(tb.rows.map((r) => [r.code, r.closing]));
    const sign = (t) => (t === 'asset' || t === 'expense' ? 1 : -1);
    main.innerHTML = `<div class="page-h"><div><h1>ผังบัญชี</h1><div class="sub">ยอดคงเหลือ ณ ${T.thDate(T.today())}</div></div><div class="actions"><button class="btn" data-bank>เพิ่มบัญชีธนาคาร</button><button class="btn primary" data-new>${ICON.plus}เพิ่มบัญชี</button></div></div>
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>รหัส</th><th>ชื่อบัญชี</th><th></th><th class="num">ยอดคงเหลือ</th></tr></thead><tbody>
      ${Object.keys(TYPE_TH).map((t) => `<tr class="sec"><td colspan="4">${TYPE_TH[t]}</td></tr>${S.boot.accounts.filter((a) => a.type === t).map((a) => `<tr class="click" data-code="${esc(a.code)}">
        <td class="mono">${esc(a.code)}</td><td>${esc(a.name)}${a.bank ? `<div class="muted" style="font-size:12px">${esc([a.bank.bank, a.bank.number].filter(Boolean).join(' · '))}</div>` : ''}</td>
        <td>${a.sys ? '<span class="chip">ระบบ</span>' : ''}${a.active ? '' : ' <span class="chip">ปิดใช้</span>'}</td>
        <td class="num"><a href="#/report/ledger?account=${encodeURIComponent(a.code)}" style="text-decoration:none">${bal.has(a.code) ? money(sign(a.type) * bal.get(a.code)) : '–'}</a></td></tr>`).join('')}`).join('')}
      </tbody></table></div></div>`;
    const edit = async (a, bank) => {
      const isNew = !a;
      a = a || { type: bank ? 'asset' : 'expense', active: true, bank: bank ? {} : null };
      const ok = await dialog({
        title: isNew ? (bank ? 'เพิ่มบัญชีธนาคาร' : 'เพิ่มบัญชี') : `แก้ไขบัญชี ${a.code}`,
        body: `<div class="grid g2">
          <label class="field"><span>รหัสบัญชี</span><input type="text" name="code" value="${esc(a.code || (bank ? nextCode('112') : ''))}" ${isNew ? '' : 'readonly'}></label>
          <label class="field"><span>หมวด</span><select name="type" ${a.sys ? 'disabled' : ''}>${Object.entries(TYPE_TH).map(([k, v]) => `<option value="${k}" ${k === a.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field span2"><span>ชื่อบัญชี</span><input type="text" name="name" value="${esc(a.name || (bank ? 'เงินฝากธนาคาร' : ''))}"></label>
          <label class="field span2"><span>ชื่อภาษาอังกฤษ</span><input type="text" name="name_en" value="${esc(a.name_en || '')}"></label>
          <label class="check span2"><input type="checkbox" name="is_bank" ${a.bank || a.sys === 'bank' ? 'checked' : ''} ${a.sys === 'bank' || a.sys === 'cash' ? 'disabled' : ''}> เป็นบัญชีเงินสด / ธนาคาร (ใช้รับและจ่ายเงิน)</label>
          <label class="field"><span>ธนาคาร</span><input type="text" name="bank" value="${esc(a.bank?.bank || '')}"></label>
          <label class="field"><span>เลขที่บัญชี</span><input type="text" name="number" value="${esc(a.bank?.number || '')}"></label>
          ${isNew ? '' : `<label class="check span2"><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> ใช้งานอยู่</label>`}
        </div>`,
        extra: !isNew && !a.sys ? '<button class="btn danger" data-del>ลบ</button>' : '',
        onOpen: (el, close) => { const d = $('[data-del]', el); if (d) d.onclick = async () => { try { await api('DELETE', A(`/accounts/${encodeURIComponent(a.code)}`)); close(true); } catch (err) { fail(err); } }; },
        onOk: async (el) => {
          const d = formData(el);
          const type = a.sys ? a.type : d.type;
          const isBank = a.sys === 'bank' || a.sys === 'cash' ? null : d.is_bank;
          await put(`/accounts/${encodeURIComponent(d.code.trim())}`, {
            name: d.name, name_en: d.name_en, type, active: isNew ? true : d.active,
            bank: isBank || a.sys === 'bank' ? { bank: d.bank, number: d.number } : null,
          });
          return true;
        },
      });
      if (ok) { await loadBoot(); render(); }
    };
    const nextCode = (p) => {
      const used = S.boot.accounts.map((a) => a.code).filter((c) => c.startsWith(p)).map(Number);
      return String(Math.max(Number(`${p}00`), ...used) + 1);
    };
    $('[data-new]', main).onclick = () => edit(null, false);
    $('[data-bank]', main).onclick = () => edit(null, true);
    main.querySelector('tbody').onclick = (e) => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('[data-code]'); if (tr) edit(S.boot.acc.get(tr.dataset.code));
    };
  }

  /* ---------- Journal ---------- */

  async function viewJournal(main, q) {
    const month = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : ymNow();
    const manual = q.get('only') === 'manual';
    const [from, to] = monthRange(month);
    const { entries } = await get(`/journal?from=${from}&to=${to}${manual ? '&manual=1' : ''}`);
    main.innerHTML = `<div class="page-h"><div><h1>สมุดรายวัน</h1><div class="sub">รายการบัญชีทั้งหมด ทั้งที่ระบบลงให้และที่บันทึกเอง</div></div>
      <div class="actions"><input type="month" value="${month}" data-m style="width:auto"><div class="seg" data-o><button class="${manual ? '' : 'on'}" data-v="">ทั้งหมด</button><button class="${manual ? 'on' : ''}" data-v="manual">บันทึกเอง</button></div>
      <button class="btn primary" data-new>${ICON.plus}บันทึกรายการบัญชี</button></div></div>
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>วันที่</th><th>เลขที่</th><th>บัญชี</th><th class="num">เดบิต</th><th class="num">เครดิต</th></tr></thead><tbody>
      ${entries.length ? entries.map((e) => e.lines.map((l, i) => `<tr class="click" data-id="${e.id}" data-doc="${e.doc_id || ''}">
        ${i === 0 ? `<td rowspan="${e.lines.length}">${T.thDate(e.date)}</td><td rowspan="${e.lines.length}"><span class="doc-no">${esc(e.number || '')}</span><div class="muted" style="font-size:12px">${esc(e.memo || '')}</div></td>` : ''}
        <td>${l.credit ? '&emsp;&emsp;' : ''}${esc(accName(l.account))}${l.memo ? `<div class="muted" style="font-size:12px">${esc(l.memo)}</div>` : ''}</td>
        <td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td></tr>`).join('')).join('')
    : '<tr><td colspan="5"><div class="empty"><b>ไม่มีรายการในเดือนนี้</b></div></td></tr>'}
      </tbody></table></div></div>`;
    $('[data-m]', main).onchange = (e) => { location.hash = `#/journal?m=${e.target.value}${manual ? '&only=manual' : ''}`; };
    $('[data-o]', main).onclick = (e) => { const b = e.target.closest('button'); if (b) location.hash = `#/journal?m=${month}${b.dataset.v ? '&only=manual' : ''}`; };
    $('[data-new]', main).onclick = () => editJournal();
    main.querySelector('tbody').onclick = (e) => {
      const tr = e.target.closest('[data-id]'); if (!tr) return;
      if (tr.dataset.doc) location.hash = `#/doc/${tr.dataset.doc}`;
      else editJournal(entries.find((x) => x.id === tr.dataset.id));
    };
  }

  async function editJournal(entry) {
    let lines = entry ? entry.lines.map((l) => ({ ...l })) : [{ account: '', debit: 0, credit: 0, memo: '' }, { account: '', debit: 0, credit: 0, memo: '' }];
    const allAcc = S.boot.accounts.filter((a) => a.active).map((a) => `<option value="${esc(a.code)}">${esc(a.code)} ${esc(a.name)}</option>`).join('');
    const ok = await dialog({
      title: entry ? `แก้ไข ${entry.number}` : 'บันทึกรายการบัญชี (สมุดรายวันทั่วไป)', wide: true,
      body: `<div class="grid g2" style="margin-bottom:12px"><label class="field"><span>วันที่</span><input type="date" name="date" value="${entry?.date || T.today()}"></label>
        <label class="field"><span>คำอธิบาย</span><input type="text" name="memo" value="${esc(entry?.memo || '')}" placeholder="เช่น ยอดยกมา, ค่าเสื่อมราคา"></label></div>
        <table class="lines"><thead><tr><th>บัญชี</th><th class="w-price">เดบิต</th><th class="w-price">เครดิต</th><th>หมายเหตุ</th><th class="w-x"></th></tr></thead><tbody data-jl></tbody></table>
        <button class="btn sm add-line" data-ja>${ICON.plus}เพิ่มบรรทัด</button>
        <div data-jt style="margin-top:12px;text-align:right" class="num"></div>`,
      extra: entry ? '<button class="btn danger" data-del>ลบรายการ</button>' : '',
      onOpen: (el, close) => {
        const draw = () => {
          $('[data-jl]', el).innerHTML = lines.map((l, i) => `<tr data-i="${i}"><td class="l-name" data-l="บัญชี"><select data-f="account"><option value="">เลือกบัญชี</option>${allAcc.replace(`value="${esc(l.account)}"`, `value="${esc(l.account)}" selected`)}</select></td>
            <td class="w-price" data-l="เดบิต"><input type="number" step="0.01" class="num" data-f="debit" value="${l.debit || ''}"></td>
            <td class="w-price" data-l="เครดิต"><input type="number" step="0.01" class="num" data-f="credit" value="${l.credit || ''}"></td>
            <td data-l="หมายเหตุ"><input type="text" data-f="memo" value="${esc(l.memo || '')}"></td>
            <td class="w-x">${lines.length > 2 ? '<button class="rm" data-rm>✕</button>' : ''}</td></tr>`).join('');
          tot();
        };
        const tot = () => {
          const d = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0); const c = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
          $('[data-jt]', el).innerHTML = `เดบิต ${money(d)} · เครดิต ${money(c)} ${Math.abs(d - c) < 0.005 && d > 0 ? '<span class="chip good">สมดุล</span>' : `<span class="chip bad">ต่างกัน ${money(Math.abs(d - c))}</span>`}`;
        };
        $('[data-jl]', el).addEventListener('input', (e) => { const tr = e.target.closest('[data-i]'); const f = e.target.dataset.f; if (!tr || !f) return; lines[Number(tr.dataset.i)][f] = f === 'debit' || f === 'credit' ? Number(e.target.value) || 0 : e.target.value; tot(); });
        $('[data-jl]', el).addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') lines[Number(e.target.closest('[data-i]').dataset.i)].account = e.target.value; });
        $('[data-jl]', el).addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { lines.splice(Number(e.target.closest('[data-i]').dataset.i), 1); draw(); } });
        $('[data-ja]', el).onclick = () => { lines.push({ account: '', debit: 0, credit: 0, memo: '' }); draw(); };
        const del = $('[data-del]', el);
        if (del) del.onclick = async () => { try { await api('DELETE', A(`/journal/${entry.id}`)); close(true); } catch (err) { fail(err); } };
        draw();
      },
      onOk: async (el) => {
        const d = formData(el);
        const body = { date: d.date, memo: d.memo, lines };
        if (entry) await put(`/journal/${entry.id}`, body); else await post('/journal', body);
        return true;
      },
    });
    if (ok) { toast('บันทึกแล้ว'); render(); }
  }

  /* ---------- Reports ---------- */

  const REPORTS = {
    vat_summary: ['สรุปภาษีมูลค่าเพิ่ม (ภ.พ.30)', 'ภาษีขาย ภาษีซื้อ และยอดที่ต้องชำระของเดือน', 'month', 'tax'],
    vat_sales: ['รายงานภาษีขาย', 'ใบกำกับภาษีที่ออกในเดือน', 'month', 'tax'],
    vat_purchase: ['รายงานภาษีซื้อ', 'ใบกำกับภาษีที่ได้รับในเดือน', 'month', 'tax'],
    wht_pnd3: ['ภ.ง.ด.3', 'หัก ณ ที่จ่ายบุคคลธรรมดา', 'month', 'tax'],
    wht_pnd53: ['ภ.ง.ด.53', 'หัก ณ ที่จ่ายนิติบุคคล', 'month', 'tax'],
    wht_recv: ['ภาษีถูกหัก ณ ที่จ่าย', 'ที่ลูกค้าหักไว้ ใช้เครดิตภาษีปลายปี', 'range', 'tax'],
    pnl: ['งบกำไรขาดทุน', 'รายได้ ค่าใช้จ่าย และกำไรสุทธิ', 'range', 'fs'],
    balance: ['งบแสดงฐานะการเงิน', 'สินทรัพย์ หนี้สิน และส่วนของเจ้าของ', 'asof', 'fs'],
    trial: ['งบทดลอง', 'ยอดเดบิต เครดิต ทุกบัญชี', 'range', 'fs'],
    ledger: ['บัญชีแยกประเภท', 'ความเคลื่อนไหวรายบัญชี', 'range', 'books'],
    ar: ['ลูกหนี้ค้างรับ', 'ใบแจ้งหนี้ที่ยังไม่ได้รับเงิน แยกตามอายุหนี้', 'none', 'books'],
    ap: ['เจ้าหนี้ค้างจ่าย', 'ค่าใช้จ่ายที่ยังไม่ได้จ่าย', 'none', 'books'],
  };

  function viewReports(main) {
    const groups = [['tax', 'ภาษี'], ['fs', 'งบการเงิน'], ['books', 'สมุดบัญชีและติดตามหนี้']];
    main.innerHTML = `<div class="page-h"><div><h1>รายงาน</h1><div class="sub">ส่งออกเป็น Excel (CSV) หรือพิมพ์ได้ทุกรายงาน</div></div></div>
      ${groups.map(([g, h]) => `<div class="rep-h">${h}</div><div class="rep-grid">${Object.entries(REPORTS).filter(([, r]) => r[3] === g && (g !== 'tax' || biz().vat_registered || !r[0].includes('ภาษีมูลค่าเพิ่ม') && !r[0].includes('ภาษีขาย') && !r[0].includes('ภาษีซื้อ'))).map(([k, r]) => `<a class="card" href="#/report/${k}"><b>${r[0]}</b><small>${r[1]}</small></a>`).join('')}</div>`).join('')}`;
  }

  async function viewReport(main, name, q) {
    const R = REPORTS[name];
    if (!R) { main.innerHTML = '<div class="empty"><b>ไม่พบรายงาน</b></div>'; return; }
    const [title, , mode] = R;
    const month = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : ymNow();
    const yr = T.today().slice(0, 4);
    const from = q.get('from') || (name === 'pnl' || name === 'wht_recv' ? `${yr}-01-01` : monthRange(month)[0]);
    const to = q.get('to') || T.today();
    const account = q.get('account') || sysAcc('bank');
    let path;
    if (name === 'wht_pnd3' || name === 'wht_pnd53') path = `/reports/wht_pay?month=${month}&form=${name.slice(4)}`;
    else if (mode === 'month') path = `/reports/${name}?month=${month}`;
    else if (mode === 'asof') path = `/reports/${name}?to=${to}`;
    else if (mode === 'range') path = `/reports/${name}?from=${from}&to=${to}${name === 'ledger' ? `&account=${encodeURIComponent(account)}` : ''}`;
    else path = `/reports/${name}`;
    const d = await get(path);
    const ctl = mode === 'month' ? `<input type="month" value="${month}" data-c="month" style="width:auto">`
      : mode === 'asof' ? `<label class="check">ณ วันที่ <input type="date" value="${to}" data-c="to" style="width:auto"></label>`
        : mode === 'range' ? `${name === 'ledger' ? `<select data-c="account" style="width:auto;max-width:260px">${S.boot.accounts.map((a) => `<option value="${esc(a.code)}" ${a.code === account ? 'selected' : ''}>${esc(a.code)} ${esc(a.name)}</option>`).join('')}</select>` : ''}<input type="date" value="${from}" data-c="from" style="width:auto"><span class="muted">ถึง</span><input type="date" value="${to}" data-c="to" style="width:auto">` : '';
    const { head, body, foot, rows: csvRows, extra = '' } = reportTable(name, d);
    const periodText = mode === 'month' ? `เดือน ${T.thMonth(month)}` : mode === 'asof' ? `ณ วันที่ ${T.thDate(to)}` : mode === 'range' ? `${T.thDate(from)} – ${T.thDate(to)}` : `ณ วันที่ ${T.thDate(T.today())}`;
    main.innerHTML = `<div class="page-h"><div><a href="#/reports" class="muted" style="text-decoration:none">← รายงาน</a><h1>${esc(title)}</h1><div class="sub">${esc(biz().name)} · ${esc(periodText)}</div></div>
      <div class="actions">${ctl}<button class="btn" data-csv>ส่งออก Excel</button><button class="btn dark" data-print>${ICON.print}พิมพ์</button></div></div>
      ${extra}
      <div class="card"><div class="tbl-wrap"><table class="tbl" data-tbl><thead>${head}</thead><tbody>${body || `<tr><td colspan="9"><div class="empty"><b>ไม่มีรายการ</b></div></td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div></div>`;
    main.addEventListener('change', (e) => {
      const c = e.target.dataset.c; if (!c) return;
      const p = new URLSearchParams(q);
      p.set(c, e.target.value);
      if (mode === 'range') { p.set('from', $('[data-c=from]', main).value); p.set('to', $('[data-c=to]', main).value); }
      location.hash = `#/report/${name}?${p}`;
    });
    $('[data-csv]', main).onclick = () => csv(`${title}-${mode === 'month' ? month : to}`, csvRows);
    $('[data-print]', main).onclick = () => printHtml(`<div class="print-report"><h2 style="margin:0">${esc(title)}</h2><div>${esc(biz().name)}${biz().tax_id ? ` · เลขประจำตัวผู้เสียภาษี ${esc(T.taxIdFmt(biz().tax_id))}` : ''}</div><div style="margin-bottom:10px">${esc(periodText)}</div>${extra}<table>${$('[data-tbl]', main).innerHTML}</table></div>`);
    main.querySelector('tbody').onclick = (e) => { const tr = e.target.closest('[data-doc]'); if (tr) location.hash = `#/doc/${tr.dataset.doc}`; };
  }

  // Each report as table HTML plus the rows for CSV export.
  function reportTable(name, d) {
    const m = (v) => money(v);
    const n = (v) => `<td class="num">${m(v)}</td>`;
    const docRow = (id) => (id ? ` class="click" data-doc="${id}"` : '');
    if (name === 'vat_sales' || name === 'vat_purchase') {
      const s = name === 'vat_sales';
      const cols = ['ลำดับ', 'วันที่', 'เลขที่', s ? 'ชื่อผู้ซื้อ' : 'ชื่อผู้ขาย', 'เลขประจำตัวผู้เสียภาษี', 'สาขา', 'มูลค่าสินค้า/บริการ', 'ภาษีมูลค่าเพิ่ม'];
      return {
        head: `<tr>${cols.map((c, i) => `<th${i >= 6 ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`,
        body: d.rows.map((r, i) => `<tr${docRow(r.id)}><td>${i + 1}</td><td>${T.slashDate(r.date)}</td><td class="mono">${esc(s ? r.number : r.ref_no || r.number)}</td><td>${esc(r.name)}${r.void ? ' <span class="chip bad">ยกเลิก</span>' : ''}</td><td class="mono">${esc(T.taxIdFmt(r.tax_id))}</td><td>${esc(T.branchFmt(r.branch))}</td>${n(r.base)}${n(r.vat)}</tr>`).join(''),
        foot: `<tr><td colspan="6">รวม</td>${n(d.totals.base)}${n(d.totals.vat)}</tr>`,
        rows: [cols, ...d.rows.map((r, i) => [i + 1, T.slashDate(r.date), s ? r.number : r.ref_no || r.number, r.name + (r.void ? ' (ยกเลิก)' : ''), r.tax_id, T.branchFmt(r.branch), r.base, r.vat]), ['', '', '', 'รวม', '', '', d.totals.base, d.totals.vat]],
      };
    }
    if (name === 'vat_summary') {
      const rows = [['ยอดขาย (ฐานภาษี)', d.sales.base], ['ภาษีขาย', d.sales.vat], ['ยอดซื้อ (ฐานภาษี)', d.purchase.base], ['ภาษีซื้อ', d.purchase.vat], [d.payable >= 0 ? 'ภาษีที่ต้องชำระ' : 'ภาษีที่ชำระเกิน', Math.abs(d.payable)]];
      return {
        head: '<tr><th>รายการ</th><th class="num">จำนวนเงิน</th></tr>',
        body: rows.map(([k, v], i) => `<tr${i === 4 ? ' style="font-weight:700"' : ''}><td>${k}</td>${n(v)}</tr>`).join(''),
        rows: [['รายการ', 'จำนวนเงิน'], ...rows],
        extra: `<div class="note-box" style="margin-bottom:14px">ยื่น ภ.พ.30 ภายในวันที่ 15 ของเดือนถัดไป (ยื่นออนไลน์ได้ถึงวันที่ 23) · ใบกำกับภาษีขาย ${d.salesCount} ใบ · ภาษีซื้อ ${d.purchaseCount} ใบ</div>`,
      };
    }
    if (name === 'wht_pnd3' || name === 'wht_pnd53') {
      const cols = ['ลำดับ', 'เลขที่ 50 ทวิ', 'วันที่จ่าย', 'ชื่อผู้มีเงินได้', 'เลขประจำตัวผู้เสียภาษี', 'ประเภทเงินได้', 'อัตรา', 'จำนวนเงินที่จ่าย', 'ภาษีที่หัก'];
      return {
        head: `<tr>${cols.map((c, i) => `<th${i >= 7 ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`,
        body: d.rows.map((r, i) => `<tr${docRow(r.id)}><td>${i + 1}</td><td class="mono">${esc(r.cert)}</td><td>${T.slashDate(r.date)}</td><td>${esc(r.name)}<div class="muted" style="font-size:12px">${esc(r.address)}</div></td><td class="mono">${esc(T.taxIdFmt(r.tax_id))}</td><td>${esc(r.income)}</td><td>${r.rates.map((x) => `${x.rate}%`).join(', ')}</td>${n(r.base)}${n(r.tax)}</tr>`).join(''),
        foot: `<tr><td colspan="7">รวม</td>${n(d.totals.base)}${n(d.totals.tax)}</tr>`,
        rows: [cols, ...d.rows.map((r, i) => [i + 1, r.cert, T.slashDate(r.date), r.name, r.tax_id, r.income, r.rates.map((x) => `${x.rate}%`).join(' '), r.base, r.tax])],
        extra: '<div class="note-box" style="margin-bottom:14px">นำส่งภาษีหัก ณ ที่จ่ายภายในวันที่ 7 ของเดือนถัดไป (ยื่นออนไลน์ได้ถึงวันที่ 15)</div>',
      };
    }
    if (name === 'wht_recv') {
      const cols = ['วันที่', 'เลขที่ใบเสร็จ', 'ผู้จ่ายเงิน (ลูกค้า)', 'เลขประจำตัวผู้เสียภาษี', 'เงินได้', 'ภาษีถูกหัก'];
      return {
        head: `<tr>${cols.map((c, i) => `<th${i >= 4 ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`,
        body: d.rows.map((r) => `<tr${docRow(r.id)}><td>${T.slashDate(r.date)}</td><td class="mono">${esc(r.number)}</td><td>${esc(r.name)}</td><td class="mono">${esc(T.taxIdFmt(r.tax_id))}</td>${n(r.base)}${n(r.tax)}</tr>`).join(''),
        foot: `<tr><td colspan="4">รวม</td>${n(d.totals.base)}${n(d.totals.tax)}</tr>`,
        rows: [cols, ...d.rows.map((r) => [T.slashDate(r.date), r.number, r.name, r.tax_id, r.base, r.tax])],
      };
    }
    if (name === 'pnl') {
      const inc = d.rows.filter((r) => r.type === 'income'); const exp = d.rows.filter((r) => r.type === 'expense');
      const line = (r) => `<tr class="sub"><td>${esc(r.code)} ${esc(r.name)}</td>${n(r.amount)}</tr>`;
      return {
        head: '<tr><th>รายการ</th><th class="num">จำนวนเงิน</th></tr>',
        body: `<tr class="sec"><td colspan="2">รายได้</td></tr>${inc.map(line).join('')}<tr><td><b>รวมรายได้</b></td><td class="num"><b>${m(d.income)}</b></td></tr>
          <tr class="sec"><td colspan="2">ค่าใช้จ่าย</td></tr>${exp.map(line).join('')}<tr><td><b>รวมค่าใช้จ่าย</b></td><td class="num"><b>${m(d.expense)}</b></td></tr>`,
        foot: `<tr><td>${d.net >= 0 ? 'กำไรสุทธิ' : 'ขาดทุนสุทธิ'}</td>${n(d.net)}</tr>`,
        rows: [['รายการ', 'จำนวนเงิน'], ['รายได้', ''], ...inc.map((r) => [`${r.code} ${r.name}`, r.amount]), ['รวมรายได้', d.income], ['ค่าใช้จ่าย', ''], ...exp.map((r) => [`${r.code} ${r.name}`, r.amount]), ['รวมค่าใช้จ่าย', d.expense], ['กำไร (ขาดทุน) สุทธิ', d.net]],
      };
    }
    if (name === 'balance') {
      const line = (r) => `<tr class="sub"><td>${esc(r.code)} ${esc(r.name)}</td>${n(r.amount)}</tr>`;
      const eq = [...d.equity, { code: '', name: 'กำไร (ขาดทุน) สะสมปีก่อน', amount: d.priorProfit }, { code: '', name: 'กำไร (ขาดทุน) งวดปัจจุบัน', amount: d.currentProfit }].filter((r) => r.amount);
      const ok = Math.abs(d.totals.assets - d.totals.liabilities - d.totals.equity) < 0.01;
      return {
        head: '<tr><th>รายการ</th><th class="num">จำนวนเงิน</th></tr>',
        body: `<tr class="sec"><td colspan="2">สินทรัพย์</td></tr>${d.assets.map(line).join('')}<tr><td><b>รวมสินทรัพย์</b></td><td class="num"><b>${m(d.totals.assets)}</b></td></tr>
          <tr class="sec"><td colspan="2">หนี้สิน</td></tr>${d.liabilities.map(line).join('')}<tr><td><b>รวมหนี้สิน</b></td><td class="num"><b>${m(d.totals.liabilities)}</b></td></tr>
          <tr class="sec"><td colspan="2">ส่วนของเจ้าของ</td></tr>${eq.map(line).join('')}<tr><td><b>รวมส่วนของเจ้าของ</b></td><td class="num"><b>${m(d.totals.equity)}</b></td></tr>`,
        foot: `<tr><td>รวมหนี้สินและส่วนของเจ้าของ ${ok ? '<span class="chip good">สมดุล</span>' : '<span class="chip bad">ไม่สมดุล</span>'}</td>${n(d.totals.liabilities + d.totals.equity)}</tr>`,
        rows: [['รายการ', 'จำนวนเงิน'], ['สินทรัพย์', ''], ...d.assets.map((r) => [`${r.code} ${r.name}`, r.amount]), ['รวมสินทรัพย์', d.totals.assets], ['หนี้สิน', ''], ...d.liabilities.map((r) => [`${r.code} ${r.name}`, r.amount]), ['รวมหนี้สิน', d.totals.liabilities], ['ส่วนของเจ้าของ', ''], ...eq.map((r) => [`${r.code} ${r.name}`.trim(), r.amount]), ['รวมส่วนของเจ้าของ', d.totals.equity]],
      };
    }
    if (name === 'trial') {
      const cols = ['รหัส', 'ชื่อบัญชี', 'ยอดยกมา', 'เดบิต', 'เครดิต', 'ยอดคงเหลือ'];
      return {
        head: `<tr>${cols.map((c, i) => `<th${i >= 2 ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`,
        body: d.rows.map((r) => `<tr><td class="mono">${esc(r.code)}</td><td>${esc(r.name)}</td>${n(r.opening)}${n(r.debit)}${n(r.credit)}${n(r.closing)}</tr>`).join(''),
        foot: `<tr><td colspan="3">รวม ${d.totals.debit === d.totals.credit ? '<span class="chip good">สมดุล</span>' : '<span class="chip bad">ไม่สมดุล</span>'}</td>${n(d.totals.debit)}${n(d.totals.credit)}<td></td></tr>`,
        rows: [cols, ...d.rows.map((r) => [r.code, r.name, r.opening, r.debit, r.credit, r.closing]), ['', 'รวม', '', d.totals.debit, d.totals.credit, '']],
      };
    }
    if (name === 'ledger') {
      const cols = ['วันที่', 'เลขที่', 'คำอธิบาย', 'เดบิต', 'เครดิต', 'คงเหลือ'];
      if (!d.account) return { head: '', body: '', rows: [] };
      return {
        head: `<tr>${cols.map((c, i) => `<th${i >= 3 ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`,
        body: `<tr class="sec"><td colspan="5">ยอดยกมา</td>${n(d.opening)}</tr>${d.rows.map((r) => `<tr${docRow(r.doc_id)}><td>${T.slashDate(r.date)}</td><td class="mono">${esc(r.number || '')}</td><td>${esc(r.line_memo || r.memo || '')}</td><td class="num">${r.debit ? m(r.debit) : ''}</td><td class="num">${r.credit ? m(r.credit) : ''}</td>${n(r.balance)}</tr>`).join('')}`,
        foot: `<tr><td colspan="5">ยอดคงเหลือ</td>${n(d.closing)}</tr>`,
        rows: [cols, ['', '', 'ยอดยกมา', '', '', d.opening], ...d.rows.map((r) => [T.slashDate(r.date), r.number, r.line_memo || r.memo, r.debit, r.credit, r.balance])],
        extra: `<div class="muted" style="margin-bottom:10px">${esc(d.account.code)} ${esc(d.account.name)}</div>`,
      };
    }
    if (name === 'ar' || name === 'ap') {
      const cols = ['เลขที่', 'วันที่', 'ครบกำหนด', name === 'ar' ? 'ลูกค้า' : 'ผู้ขาย', 'เกินกำหนด (วัน)', 'ยอดค้าง'];
      const b = d.buckets;
      return {
        head: `<tr>${cols.map((c, i) => `<th${i >= 4 ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`,
        body: d.rows.map((r) => `<tr${docRow(r.id)}><td class="mono">${esc(r.number)}</td><td>${T.slashDate(r.date)}</td><td>${T.slashDate(r.due_date)}</td><td>${esc(r.name)}</td><td class="num"${r.late ? ' style="color:var(--bad)"' : ''}>${r.late || '–'}</td>${n(r.total)}</tr>`).join(''),
        foot: `<tr><td colspan="5">รวม</td>${n(d.total)}</tr>`,
        rows: [cols, ...d.rows.map((r) => [r.number, T.slashDate(r.date), T.slashDate(r.due_date), r.name, r.late, r.total])],
        extra: `<div class="kpis">${[['ยังไม่ถึงกำหนด', 'current'], ['เกิน 1–30 วัน', '1-30'], ['31–60 วัน', '31-60'], ['เกิน 60 วัน', '61-90']].map(([l, k]) => `<div class="card kpi"><div class="k">${l}</div><div class="v" style="font-size:19px">${m(k === '61-90' ? (b['61-90'] || 0) + (b['90+'] || 0) : b[k] || 0)}</div></div>`).join('')}</div>`,
      };
    }
    return { head: '', body: '', rows: [] };
  }

  /* ---------- Settings ---------- */

  function viewSettings(main) {
    const b = biz(); const s = b.settings || {};
    const P = s.prefixes || {};
    main.innerHTML = `<div class="page-h"><div><h1>ตั้งค่า</h1><div class="sub">ข้อมูลกิจการและรูปแบบเอกสาร</div></div><div class="actions"><button class="btn primary" data-save>บันทึก</button></div></div>
      <div class="grid" style="max-width:860px">
        <div class="card card-pad"><h2>ข้อมูลกิจการ</h2>
          <div class="logo-pick" style="margin-bottom:14px"><div class="lp" data-lp>${b.logo ? `<img src="${esc(b.logo)}" alt="">` : 'โลโก้'}</div>
            <div><button class="btn sm" data-logo>เลือกรูปโลโก้</button> ${b.logo ? '<button class="btn sm ghost" data-nologo>เอาออก</button>' : ''}<div class="muted" style="font-size:12px;margin-top:4px">PNG หรือ JPG พื้นหลังโปร่งใสจะสวยที่สุด</div><input type="file" accept="image/*" hidden data-lf></div></div>
          ${businessFields(b)}
          <div class="grid g2" style="margin-top:14px"><label class="field span2"><span>ชื่อภาษาอังกฤษ</span><input type="text" name="name_en" value="${esc(b.name_en || '')}"></label>
          <label class="field span2"><span>เว็บไซต์</span><input type="text" name="website" value="${esc(b.website || '')}"></label></div>
        </div>
        <div class="card card-pad"><h2>เอกสาร</h2><div class="grid g2">
          <div class="field span2"><span>ตัวอักษรนำหน้าเลขที่เอกสาร</span><div class="grid g4">${[['QT', 'ใบเสนอราคา'], ['IV', 'ใบแจ้งหนี้'], ['RE', 'ใบเสร็จ'], ['EX', 'ค่าใช้จ่าย'], ['JV', 'สมุดรายวัน'], ['WHT', '50 ทวิ']].map(([k, l]) => `<label class="field"><small>${l}</small><input type="text" data-prefix="${k}" value="${esc(P[k] || k)}" maxlength="8"></label>`).join('')}</div><small>เลขที่จะเป็น ตัวนำหน้า + ปี ค.ศ. + เดือน + ลำดับ เช่น IV2026110001</small></div>
          <label class="field"><span>ชื่อผู้มีอำนาจลงนาม</span><input type="text" data-s="signer" value="${esc(s.signer || '')}"></label>
          <label class="field"><span>เครดิตเทอมเริ่มต้น (วัน)</span><input type="number" data-s="creditDays" min="0" value="${esc(s.creditDays ?? 30)}"></label>
          <label class="field"><span>ราคาสินค้าเริ่มต้น</span><select data-s="priceMode"><option value="excl" ${s.priceMode !== 'incl' ? 'selected' : ''}>ไม่รวม VAT</option><option value="incl" ${s.priceMode === 'incl' ? 'selected' : ''}>รวม VAT แล้ว</option></select></label>
          <label class="field"><span>เดือนเริ่มรอบบัญชี</span><select data-s="fyStart">${T.TH_MONTHS_LONG.map((mn, i) => `<option value="${i + 1}" ${(s.fyStart || 1) === i + 1 ? 'selected' : ''}>${mn}</option>`).join('')}</select></label>
          <label class="field"><span>สีหัวเอกสาร</span><input type="color" data-s="color" value="${esc(s.color || '#E8590C')}" style="height:38px;padding:2px"></label>
          <label class="field span2"><span>ช่องทางชำระเงิน (พิมพ์ในใบเสนอราคาและใบแจ้งหนี้)</span><textarea data-s="payment" rows="2" placeholder="ธนาคารกสิกรไทย 123-4-56789-0 ชื่อบัญชี บริษัท ตัวอย่าง จำกัด">${esc(s.payment || '')}</textarea></label>
          ${['QT', 'IV', 'RE'].map((k) => `<label class="field span2"><span>หมายเหตุเริ่มต้นใน${T.TYPE_NAME[k]}</span><textarea data-note="${k}" rows="2">${esc(s.notes?.[k] || '')}</textarea></label>`).join('')}
        </div></div>
        <div class="card card-pad"><h2>กิจการทั้งหมด</h2><p class="muted" style="margin-top:0">มี ${S.businesses.length} กิจการในบัญชีนี้</p><div class="actions"><button class="btn" data-switch2>สลับกิจการ</button><button class="btn" data-newbiz>${ICON.plus}เพิ่มกิจการ</button></div></div>
        ${S.boot.role === 'owner' ? `<div class="card card-pad" style="border-color:var(--bad-soft)"><h2 style="color:var(--bad)">ลบกิจการ</h2><p class="muted" style="margin-top:0">ลบเอกสาร ผู้ติดต่อ และรายการบัญชีทั้งหมดของกิจการนี้ กู้คืนไม่ได้</p><button class="btn danger" data-del>ลบกิจการนี้</button></div>` : ''}
      </div>`;
    let logo = b.logo;
    const lf = $('[data-lf]', main);
    $('[data-logo]', main).onclick = () => lf.click();
    const nl = $('[data-nologo]', main); if (nl) nl.onclick = () => { logo = null; $('[data-lp]', main).textContent = 'โลโก้'; };
    lf.onchange = async () => {
      const f = lf.files[0]; if (!f) return;
      const img = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = URL.createObjectURL(f); });
      const k = Math.min(1, 320 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      logo = c.toDataURL('image/png');
      if (logo.length > 380000) logo = c.toDataURL('image/jpeg', 0.85);
      $('[data-lp]', main).innerHTML = `<img src="${logo}" alt="">`;
    };
    $('[data-save]', main).onclick = async (e) => {
      const d = formData(main);
      const settings = { ...s, prefixes: {}, notes: { ...(s.notes || {}) } };
      $$('[data-prefix]', main).forEach((i) => { settings.prefixes[i.dataset.prefix] = i.value; });
      $$('[data-s]', main).forEach((i) => { settings[i.dataset.s] = i.value; });
      $$('[data-note]', main).forEach((i) => { settings.notes[i.dataset.note] = i.value; });
      e.target.disabled = true;
      try {
        await put('', { name: d.name, name_en: d.name_en, tax_id: d.tax_id, branch: d.branch, address: d.address, phone: d.phone, email: d.email, website: d.website, vat_registered: d.vat_registered, logo, settings });
        await loadBoot();
        const list = await api('GET', '/acc/businesses'); S.businesses = list.businesses;
        shell(); render(); toast('บันทึกแล้ว');
      } catch (err) { fail(err); } finally { e.target.disabled = false; }
    };
    $('[data-switch2]', main).onclick = switchBusiness;
    $('[data-newbiz]', main).onclick = () => newBusiness(false);
    const del = $('[data-del]', main);
    if (del) del.onclick = () => dialog({
      title: 'ลบกิจการ', ok: 'ลบถาวร', danger: true,
      body: `<p style="margin-top:0">พิมพ์ <b>${esc(b.name)}</b> เพื่อยืนยัน</p><input type="text" name="confirm">`,
      onOk: async (el) => {
        await api('DELETE', A(''), { confirm: formData(el).confirm });
        S.bizId = null; store.set('acc.biz', '');
        location.hash = ''; start(); return true;
      },
    });
  }

  /* ---------- Start ---------- */

  async function start() {
    try {
      const r = await api('GET', '/acc/businesses');
      S.user = r.user; S.businesses = r.businesses;
    } catch (e) {
      if (e.status === 401) return renderAuth();
      app.innerHTML = `<div class="boot">เชื่อมต่อไม่สำเร็จ: ${esc(e.message)}</div>`;
      return;
    }
    if (!S.businesses.length) {
      app.innerHTML = '<div class="boot"></div>';
      return newBusiness(true);
    }
    const saved = store.get('acc.biz');
    S.bizId = S.businesses.some((b) => b.id === saved) ? saved : S.businesses[0].id;
    store.set('acc.biz', S.bizId);
    await loadBoot();
    app.innerHTML = '';
    render();
  }
  start();
})();
