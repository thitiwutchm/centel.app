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
    capcourt_key: 'รหัสเชื่อมต่อ CapCourt ไม่ถูกต้องหรือถูกยกเลิก', capcourt_down: 'ติดต่อ CapCourt ไม่ได้ ลองใหม่อีกครั้ง', bad_url: 'ที่อยู่ต้องขึ้นต้นด้วย https://',
    too_large: 'ไฟล์ใหญ่เกินไป', forbidden: 'ไม่มีสิทธิ์ทำรายการนี้', not_found: 'ไม่พบข้อมูล', too_many_requests: 'ลองใหม่อีกครั้งในอีกสักครู่',
    google_mismatch: 'อีเมลนี้ผูกกับบัญชี Google อื่นอยู่', bad_role: 'กรุณาเลือกตำแหน่ง', already_member: 'อีเมลนี้เป็นผู้ใช้งานในกิจการนี้อยู่แล้ว',
    too_many_users: 'เพิ่มผู้ใช้งานได้สูงสุด 50 คนต่อกิจการ', primary_owner: 'เจ้าของหลักของกิจการแก้ไขหรือลบไม่ได้', self_demote: 'เปลี่ยนตำแหน่งของตัวเองไม่ได้ ให้เจ้าของคนอื่นเปลี่ยนให้',
    self_disable: 'ระงับบัญชีของตัวเองไม่ได้', invite_gone: 'คำเชิญนี้หมดอายุหรือถูกใช้ไปแล้ว ขอให้เจ้าของกิจการส่งคำเชิญใหม่',
    invite_other_email: 'คำเชิญนี้ส่งถึงอีเมลอื่น ออกจากระบบแล้วเข้าสู่ระบบด้วยอีเมลที่ได้รับเชิญ', bad_image: 'ไฟล์รูปไม่ถูกต้อง', ref_void: 'เอกสารต้นทางถูกยกเลิกแล้ว', bad_code: 'รหัสบัญชีไม่ถูกต้อง',
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
    tax: I('<path d="M6 3h12v18H6z"/><path d="M9 15l6-6"/><circle cx="9.5" cy="9.5" r=".6"/><circle cx="14.5" cy="14.5" r=".6"/>'),
    reports: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    settings: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    bank: I('<path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'),
    swap: I('<path d="M4 8h14l-3-3M20 16H6l3 3"/>'),
    user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    users: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>'),
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

  function renderAuth(invite) {
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
    // Opened from an invite link: say who invited them and to which email.
    if (invite) {
      api('GET', `/acc/invite-info/${invite}`).then((i) => {
        const box = document.createElement('div');
        box.className = 'invite-banner';
        box.innerHTML = `${i.logo ? `<img src="${esc(i.logo)}" alt="">` : ''}<div><b>${esc(i.business)}</b> เชิญคุณเข้าร่วมเป็น <b>${esc(i.role_name)}</b><small>เข้าสู่ระบบหรือสมัครด้วย ${esc(i.email)}</small></div>`;
        f.prepend(box);
        $('[name=email]', f).value = i.email;
      }, () => {
        const box = document.createElement('div');
        box.className = 'invite-banner bad';
        box.textContent = 'ลิงก์คำเชิญนี้หมดอายุหรือถูกใช้ไปแล้ว ขอให้เจ้าของกิจการส่งคำเชิญใหม่';
        f.prepend(box);
      });
    }
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
    if (id) { S.bizId = id; store.set('acc.biz', id); location.hash = '#/'; await start(); }
    else if (first) newBusiness(true);
  }

  async function switchBusiness() {
    await dialog({
      title: 'เลือกกิจการ', ok: '', cancel: 'ปิด',
      body: `<div class="biz-list">${S.businesses.map((b) => `<button data-b="${b.id}">${b.logo ? `<img src="${esc(b.logo)}" width="36" height="36" style="object-fit:contain;border-radius:6px">` : `<span class="chip">${esc(b.name.slice(0, 2))}</span>`}<span><b>${esc(b.name)}</b><br><small class="muted">${esc(T.taxIdFmt(b.tax_id) || 'ยังไม่ใส่เลขผู้เสียภาษี')}${b.vat_registered ? ' · VAT' : ''}</small></span></button>`).join('')}
        <button data-new>${ICON.plus}<span>เพิ่มกิจการใหม่</span></button></div>`,
      onOpen: (el, close) => el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-b]');
        if (b) { close(); S.bizId = b.dataset.b; store.set('acc.biz', S.bizId); await loadBoot(); app.innerHTML = ''; goHome(); }
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
    ['ภาษี', 'vat'],
    ['ข้อมูล', [['contacts', 'ผู้ติดต่อ', ICON.contacts], ['items', 'สินค้า / บริการ', ICON.items]]],
    ['บัญชี', [['journal', 'สมุดรายวัน', ICON.journal], ['accounts', 'ผังบัญชี', ICON.accounts], ['reports', 'รายงาน', ICON.reports], ['integrations', 'เชื่อมต่อระบบ', ICON.link], ['channels', 'ช่องทางการเงิน', ICON.bank], ['settings', 'ตั้งค่า', ICON.settings]]],
    ['ผู้ใช้งาน', [['profile', 'ข้อมูลส่วนตัว', ICON.user], ['users', 'ผู้ใช้งานในระบบ', ICON.users]]],
  ];
  // What each page needs (see server/src/acc/users.js): area → 1 view.
  const perms = () => S.boot?.perms || { sales: 2, purchase: 2, accounting: 2, settings: 2 };
  const can = (area, lvl = 1) => perms()[area] >= lvl;
  const PAGE_AREA = {
    dashboard: ['accounting'], 'docs/QT': ['sales', 'accounting'], 'docs/IV': ['sales', 'accounting'], 'docs/RE': ['sales', 'accounting'],
    'docs/EX': ['purchase', 'accounting'], contacts: ['sales', 'purchase', 'accounting'], items: ['sales', 'purchase', 'accounting'],
    journal: ['accounting'], accounts: ['accounting'], reports: ['accounting'],
    'vat/purchases': ['purchase', 'accounting'], 'vat/returns': ['accounting'], 'report/vat_sales': ['accounting'], 'report/vat_purchase': ['accounting'], integrations: ['settings'], channels: ['settings'], settings: ['settings'],
  };
  const pageOk = (r) => !PAGE_AREA[r] || PAGE_AREA[r].some((a) => can(a));
  // Where someone lands: the dashboard, or their first page when the dashboard is not theirs.
  const goHome = () => { if (location.hash === '#/') render(); else location.hash = '#/'; };
  const homeRoute = () => navGroups().flatMap(([, items]) => items.map(([r]) => r)).find(pageOk) || 'profile';

  // ภาษีมูลค่าเพิ่ม pages, shown in the menu for VAT-registered businesses only.
  const NAV_VAT = [
    ['vat/purchases', 'จัดการเอกสารภาษีซื้อ', ICON.tax], ['vat/returns', 'เตรียมแบบภาษีรายเดือน', ICON.tax],
    ['report/vat_sales', 'ภาษีขายตามเอกสาร', ICON.reports], ['report/vat_purchase', 'ภาษีซื้อตามเอกสาร', ICON.reports],
  ];
  // The menu groups, with the VAT pages put in for VAT-registered businesses.
  const navGroups = () => NAV.map(([h, items]) => [h, items === 'vat' ? (biz().vat_registered ? NAV_VAT : []) : items]);
  function shell() {
    const b = biz();
    const nav = navGroups();
    app.innerHTML = `<div class="shell">
      <aside class="rail">
        <div class="brand"><span class="brand-mark">${ICON.journal}</span><div>Centel Account<small>ระบบบัญชีออนไลน์</small></div></div>
        <button class="biz-switch" data-switch>${b.logo ? `<img src="${esc(b.logo)}" alt="">` : `<span class="ph">${esc(b.name.slice(0, 1))}</span>`}<span>${esc(b.name)}</span></button>
        <nav class="nav">${nav.map(([h, all]) => { const items = all.filter(([r]) => pageOk(r)); return items.length ? `<div class="nav-h">${h}</div>${items.map(([r, label, ic]) => `<a href="#/${r}" data-r="${r}">${ic}${label}</a>`).join('')}` : ''; }).join('')}</nav>
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
    if (!parts[0] || parts[0] === 'invite') { location.replace(`#/${homeRoute()}`); return; }
    const r = parts[0];
    const key = r === 'docs' || r === 'new' ? `docs/${parts[1] || 'IV'}` : r === 'doc' || r === 'edit' ? null
      : r === 'report' ? (NAV_VAT.some(([k]) => k === `report/${parts[1]}`) ? `report/${parts[1]}` : 'reports')
        : r === 'vat' ? `vat/${parts[1] === 'returns' ? 'returns' : 'purchases'}` : r;
    for (const a of $$('.nav a')) a.classList.toggle('on', a.dataset.r === key);
    // A fresh element per page so listeners from the last page do not pile up.
    const old = $('#main');
    const main = old.cloneNode(false);
    old.replaceWith(main);
    main.innerHTML = '<div class="empty">กำลังโหลด…</div>';
    window.scrollTo(0, 0);
    try {
      if (key && !pageOk(key)) { main.innerHTML = `<div class="empty"><b>ไม่มีสิทธิ์เข้าถึงหน้านี้</b>ตำแหน่งของคุณในกิจการนี้ไม่ได้รับสิทธิ์ ติดต่อเจ้าของกิจการเพื่อขอสิทธิ์เพิ่ม<a class="btn" style="margin-top:12px" href="#/${homeRoute()}">กลับหน้าแรก</a></div>`; return; }
      if (r === 'dashboard') await viewDashboard(main, q);
      else if (r === 'docs') await viewDocs(main, parts[1] || 'IV', q);
      else if (r === 'new') await viewEditor(main, parts[1], null, q);
      else if (r === 'edit') await viewEditor(main, null, parts[1], q);
      else if (r === 'doc') await viewDoc(main, parts[1]);
      else if (r === 'contacts') viewContacts(main, q);
      else if (r === 'items') await viewItems(main, q);
      else if (r === 'accounts') await viewAccounts(main);
      else if (r === 'journal') await viewJournal(main, q);
      else if (r === 'reports') viewReports(main);
      else if (r === 'integrations') await viewIntegrations(main, parts[1]);
      else if (r === 'report') await viewReport(main, parts[1], q);
      else if (r === 'vat' && parts[1] === 'returns') await viewVatReturns(main, q, parts[2]);
      else if (r === 'vat') await viewVatPurchases(main, q);
      else if (r === 'settings') viewSettings(main);
      else if (r === 'channels') viewChannels(main);
      else if (r === 'profile') await viewProfile(main);
      else if (r === 'users' && parts[1] === 'new') await viewInvite(main);
      else if (r === 'users') await viewUsers(main);
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

  // Real .xlsx through SheetJS (cdnjs, loaded on first use); falls back to CSV if it cannot load.
  let xlsxLib;
  async function excel(name, rows, sheet = 'Sheet1') {
    try {
      if (!xlsxLib) {
        xlsxLib = await new Promise((ok, no) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = () => (window.XLSX ? ok(window.XLSX) : no(new Error('xlsx')));
          s.onerror = no;
          document.head.appendChild(s);
        });
      }
      const ws = xlsxLib.utils.aoa_to_sheet(rows);
      ws['!cols'] = (rows[0] || []).map((_, i) => ({ wch: Math.min(48, Math.max(8, ...rows.map((r) => String(r[i] ?? '').length + 2))) }));
      const wb = xlsxLib.utils.book_new();
      xlsxLib.utils.book_append_sheet(wb, ws, String(sheet).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
      xlsxLib.writeFile(wb, `${name}.xlsx`);
    } catch {
      xlsxLib = null;
      csv(name, rows);
    }
  }

  // A small menu next to a button. items: [label, fn, { danger }] or null for a divider.
  function popMenu(anchor, items) {
    $$('.pop').forEach((p) => p.remove());
    const m = document.createElement('div');
    m.className = 'pop';
    m.innerHTML = items.map((it, i) => (it ? `<button type="button" data-i="${i}" class="${it[2]?.danger ? 'danger' : ''}">${esc(it[0])}</button>` : '<hr>')).join('');
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth))}px`;
    m.style.top = `${r.bottom + 4 + m.offsetHeight > innerHeight ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4}px`;
    const close = (e) => {
      if (e && e.type === 'pointerdown' && m.contains(e.target)) return;
      m.remove();
      document.removeEventListener('pointerdown', close, true);
      removeEventListener('scroll', close, true);
      removeEventListener('hashchange', close);
    };
    setTimeout(() => { document.addEventListener('pointerdown', close, true); addEventListener('scroll', close, true); addEventListener('hashchange', close); });
    m.onclick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; close(); items[Number(b.dataset.i)][1](); };
  }
  const DOTS = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  const CHEV = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  // How documents print and download: original / copies, payment details, signature + stamp, language.
  function printPrefs(b = biz()) {
    const s = b.settings || {};
    let p = {};
    try { p = JSON.parse(store.get(`acc.print.${S.bizId}`) || '{}') || {}; } catch { /* ignore */ }
    const canSign = !!(b.signature || b.stamp);
    return {
      original: p.original !== false, copy: p.copy !== false, copies: Math.max(1, Math.min(5, Number(p.copies) || 1)), pay: p.pay !== false,
      lang: p.lang === 'en' || p.lang === 'th' ? p.lang : (s.lang || 'th'), sign: canSign && (p.sign !== undefined ? !!p.sign : !!s.signAuto),
    };
  }
  const savePrintPrefs = (p) => store.set(`acc.print.${S.bizId}`, JSON.stringify(p));

  async function downloadDocs(ids, opts) {
    const docs = [];
    for (const id of ids) {
      const { doc, ref, issuer } = await get(`/docs/${id}`);
      docs.push({ ...doc, ref, issuer });
    }
    const html = docs.map((d) => T.renderSet(d, signedBy(d.issuer), opts)).join('');
    await T.downloadPdf(html, docs.length === 1 ? `${docs[0].number}.pdf` : `เอกสาร-${T.today()}.pdf`);
  }

  // The business as printed on a document: the issuer's own signature (ข้อมูลส่วนตัว) when they have one.
  const signedBy = (issuer) => (issuer?.signature ? { ...biz(), signature: issuer.signature } : biz());

  async function payExpense(doc) {
    return dialog({
      title: `จ่ายเงิน ${doc.number}`,
      body: `<div class="grid g2"><label class="field"><span>วันที่จ่าย</span><input type="date" name="date" value="${T.today()}"></label>
        <label class="field"><span>จ่ายจาก</span><select name="account">${moneyAccounts().map((m) => `<option value="${m.code}" ${m.sys === 'bank' ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        <label class="field"><span>วิธีชำระ</span><select name="method">${Object.entries(T.PAY_METHOD).map(([k, v]) => `<option value="${k}" ${k === 'transfer' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>ค่าธรรมเนียม</span><input type="number" step="0.01" name="fee" class="num" placeholder="0"></label></div>
        <p class="muted">ยอดจ่าย ${money(doc.total - doc.wht)} บาท${doc.wht ? ` (หัก ณ ที่จ่าย ${money(doc.wht)} บาท ระบบออกเลขที่ 50 ทวิ ให้)` : ''}</p>`,
      onOk: async (el) => post(`/docs/${doc.id}/pay`, { pay: formData(el) }),
    });
  }
  async function voidDoc(doc) {
    return dialog({
      title: `ยกเลิก ${doc.number}`, ok: 'ยกเลิกเอกสาร', danger: true,
      body: `<p style="margin-top:0">เอกสารจะถูกขีดว่ายกเลิก เลขที่เดิมจะไม่ถูกนำมาใช้ซ้ำ และรายการบัญชีของเอกสารนี้จะถูกลบ</p><label class="field"><span>เหตุผล</span><input type="text" name="reason"></label>`,
      onOk: async (el) => post(`/docs/${doc.id}/void`, formData(el)),
    });
  }
  async function shareDoc(doc) {
    const { token } = await post(`/docs/${doc.id}/share`);
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}doc.html?t=${token}`;
    await dialog({
      title: 'ลิงก์สำหรับลูกค้า', ok: 'คัดลอกลิงก์', cancel: 'ปิด', extra: '<button class="btn danger" data-off>ปิดลิงก์</button>',
      body: `<p class="muted" style="margin-top:0">ลูกค้าเปิดดู พิมพ์ และดาวน์โหลด PDF ได้โดยไม่ต้องเข้าสู่ระบบ</p><input type="text" readonly value="${esc(url)}">
        <p class="muted" style="margin-bottom:0;font-size:12px">ลิงก์ดาวน์โหลด PDF ทันที: <span class="mono">${esc(url)}&amp;pdf=1</span></p>`,
      onOpen: (el, close) => { $('[data-off]', el).onclick = async () => { await post(`/docs/${doc.id}/share`, { off: true }); toast('ปิดลิงก์แล้ว'); close(); render(); }; },
      onOk: async () => { await navigator.clipboard.writeText(url).catch(() => {}); toast('คัดลอกลิงก์แล้ว'); return true; },
    });
  }

  // The status choices a list row offers; picking "paid" on an invoice goes to the receipt form.
  function statusChoices(type, d) {
    if (d.status === 'void') return [];
    if (type === 'QT') return ['open', 'accepted', 'rejected'];
    if (type === 'IV') return d.status === 'open' ? ['open', 'paid'] : [];
    if (type === 'EX') return ['open', 'paid'];
    return [];
  }
  const statusTone = (s, type) => (s === 'void' || s === 'rejected' ? 'bad' : s === 'paid' || s === 'done' || s === 'accepted' ? 'good' : type === 'QT' ? 'info' : 'warn');
  const CAT_TONES = ['#2F9E44', '#1C7ED6', '#AE3EC9', '#E8590C', '#0C8599', '#C2255C', '#5C7CFA', '#B7791F'];
  const catTone = (code) => CAT_TONES[[...String(code || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % CAT_TONES.length];

  /* ---------- Dashboard ---------- */

  async function viewDashboard(main, q) {
    const month = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : ymNow();
    const d = await get(`/reports/dashboard?month=${month}`);
    const max = Math.max(1, ...d.months.flatMap((m) => [m.income, m.expense]));
    const W = 560; const H = 200; const bw = 26; const gap = W / 6;
    // Faint guide lines at a quarter, half and three quarters of the tallest bar.
    const grid = [0.25, 0.5, 0.75, 1].map((f) => { const y = H - 2 - f * (H - 20); return `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-dasharray="${f === 1 ? '0' : '3 4'}" stroke-width="1"/>`; }).join('')
      + `<line x1="0" x2="${W}" y1="${H - 2}" y2="${H - 2}" stroke="var(--line)" stroke-width="1"/>`;
    const bars = grid + d.months.map((m, i) => {
      const x = i * gap + gap / 2 - bw - 2;
      const hi = (m.income / max) * (H - 20); const he = (m.expense / max) * (H - 20);
      return `<rect x="${x}" y="${H - 2 - hi}" width="${bw}" height="${hi}" rx="4" fill="var(--accent)"><title>รายได้ ${money(m.income)}</title></rect>
        <rect x="${x + bw + 4}" y="${H - 2 - he}" width="${bw}" height="${he}" rx="4" fill="var(--ink-2)" opacity=".55"><title>ค่าใช้จ่าย ${money(m.expense)}</title></rect>`;
    }).join('');
    // Month names sit in HTML under the chart: the SVG stretches to the card width
    // (preserveAspectRatio none), which would stretch any text drawn inside it.
    const monthRow = `<div class="chart-x">${d.months.map((m) => `<span>${T.TH_MONTHS[Number(m.month.slice(5)) - 1]}</span>`).join('')}</div>`;
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
            <div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="กราฟรายได้และค่าใช้จ่าย">${bars}</svg>${monthRow}</div>
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
    const isEx = type === 'EX';
    const who = isEx ? 'ผู้จำหน่าย / ผู้รับเงิน' : 'ลูกค้า';
    let status = q.get('s') || '';
    let per = Number(store.get('acc.per')) || 20;
    let page = 0;
    let showTotal = false;
    const sel = new Set();
    main.innerHTML = `<div class="page-h"><div><h1>${LIST_TITLE[type]}</h1><div class="sub">${docs.length} เอกสาร</div></div>
      <div class="actions"><button class="btn" data-xls title="ดาวน์โหลด Excel">ดาวน์โหลด Excel</button><a class="btn primary" href="#/new/${type}">${ICON.plus}${NEW_LABEL[type]}</a></div></div>
      <div class="card">
        <div class="filters">
          <div class="seg" data-s><button data-v="" class="${status ? '' : 'on'}">ทั้งหมด</button>${statuses.map((s) => `<button data-v="${s}" class="${s === status ? 'on' : ''}">${T.statusName(type, s)}</button>`).join('')}</div>
          <select data-p>${[['all', 'ทุกช่วงเวลา'], ['month', 'เดือนนี้'], ['last', 'เดือนก่อน'], ['year', 'ปีนี้']].map(([v, l]) => `<option value="${v}" ${v === period ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input type="search" placeholder="ค้นหาเลขที่ ชื่อ" data-q style="margin-left:auto">
        </div>
        <div class="bulk" data-bulk hidden><b data-bn></b><button class="btn sm" data-bx>ดาวน์โหลด Excel</button><button class="btn sm" data-bp>ดาวน์โหลด PDF</button><button class="btn sm ghost" data-bc>ล้างที่เลือก</button></div>
        <div class="tbl-wrap"><table class="tbl doc-tbl${isEx ? ' ex' : ''}"><thead><tr>
          <th class="ck"><input type="checkbox" data-all aria-label="เลือกทั้งหมด"></th>${isEx ? '<th></th>' : ''}<th>วันที่</th><th>เลขที่เอกสาร</th><th>${who}</th>${isEx ? '<th>หมวดหมู่</th>' : ''}
          <th class="num">ยอดรวมสุทธิ</th><th>สถานะ</th><th></th></tr></thead>
        <tbody data-body></tbody></table></div>
        <div class="pager" data-pager></div>
      </div>`;
    const filtered = () => {
      const s = $('[data-q]', main).value.trim().toLowerCase();
      return docs.filter((d) => (!status || d.status === status) && (!s || d.number.toLowerCase().includes(s) || (d.contact_name || '').toLowerCase().includes(s)));
    };
    const statusCell = (d) => {
      const opts = statusChoices(type, d);
      const tone = statusTone(d.status, type);
      if (opts.length < 2) return `<span class="st ${tone}"><span>${esc(T.statusName(type, d.status))}</span></span>`;
      return `<label class="st ${tone} pick"><select data-st="${d.id}" aria-label="สถานะ">${opts.map((o) => `<option value="${o}" ${o === d.status ? 'selected' : ''}>${esc(T.statusName(type, o))}</option>`).join('')}</select>${CHEV}</label>`;
    };
    const catCell = (d) => {
      if (!d.account) return '<td></td>';
      const a = S.boot.acc.get(d.account);
      const c = catTone(d.account);
      return `<td><span class="cat" style="--c:${c}">${esc(a ? a.name : d.account)}</span>${d.line_count > 1 ? ` <span class="muted" style="font-size:12px">+${d.line_count - 1}</span>` : ''}</td>`;
    };
    const draw = () => {
      const rows = filtered();
      const pages = Math.max(1, Math.ceil(rows.length / per));
      page = Math.min(page, pages - 1);
      const view = rows.slice(page * per, page * per + per);
      const today = T.today();
      $('[data-body]', main).innerHTML = view.length ? view.map((d) => `<tr class="click${sel.has(d.id) ? ' sel' : ''}" data-id="${d.id}">
        <td class="ck"><input type="checkbox" data-ck ${sel.has(d.id) ? 'checked' : ''} aria-label="เลือก"></td>
        ${isEx ? `<td class="th-cell"><div class="thumb">${d.thumb ? `<img src="${esc(d.thumb)}" alt="" loading="lazy">` : d.attachment ? '<span>PDF</span>' : ICON.ex}</div></td>` : ''}
        <td class="nowrap">${T.thDate(d.date)}${(type === 'IV' || isEx) && d.status === 'open' && d.due_date ? `<div class="muted" style="font-size:12px${d.due_date < today ? ';color:var(--bad)' : ''}">ครบกำหนด ${T.thDate(d.due_date)}</div>` : ''}</td>
        <td><span class="dot ${statusTone(d.status, type)}"></span><span class="doc-no">${esc(d.number)}</span>${d.ext_no ? `<div><span class="chip info">CapCourt ${esc(d.ext_no)}</span></div>` : ''}${d.tax_invoice ? '<div><span class="chip accent">ใบกำกับภาษี</span></div>' : ''}</td>
        <td>${esc(d.contact_name || '')}</td>${isEx ? catCell(d) : ''}
        <td class="num"><b>${money(d.total)}</b>${d.wht ? `<div class="muted" style="font-size:12px">หัก ณ ที่จ่าย ${money(d.wht)}</div>` : ''}</td>
        <td>${statusCell(d)}</td>
        <td class="act"><button class="icon-btn" data-more aria-label="เพิ่มเติม">${DOTS}</button></td></tr>`).join('')
        : `<tr><td colspan="9"><div class="empty"><b>ยังไม่มี${LIST_TITLE[type]}</b><a class="btn primary" style="margin-top:12px" href="#/new/${type}">${NEW_LABEL[type]}</a></div></td></tr>`;
      const live = rows.filter((d) => d.status !== 'void');
      const btn = (p, label, off) => `<button class="pg${!off && off !== false && p === page ? ' on' : ''}" data-pg="${p}" ${off ? 'disabled' : ''}>${label}</button>`;
      const from = Math.max(0, Math.min(page - 2, pages - 5));
      $('[data-pager]', main).innerHTML = `<div class="pg-btns">${btn(0, '«', page === 0)}${btn(Math.max(0, page - 1), '‹', page === 0)}${Array.from({ length: Math.min(5, pages) }, (_, i) => btn(from + i, from + i + 1)).join('')}${btn(Math.min(pages - 1, page + 1), '›', page >= pages - 1)}${btn(pages - 1, '»', page >= pages - 1)}</div>
        <label class="pg-per">รายการต่อหน้า <select data-per>${[20, 50, 100].map((n) => `<option ${n === per ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <span class="pg-total">${showTotal ? `รวม ${live.length} รายการ · ภาษี ${money(live.reduce((a, d) => a + d.vat, 0))} · <b>${money(live.reduce((a, d) => a + d.total, 0))}</b> บาท` : '<button class="link" data-tot>แสดงยอดรวมทั้งหมด</button>'}</span>`;
      const vis = view.map((d) => d.id);
      $('[data-all]', main).checked = vis.length > 0 && vis.every((id) => sel.has(id));
      $('[data-bulk]', main).hidden = !sel.size;
      $('[data-bn]', main).textContent = `เลือก ${sel.size} รายการ`;
    };
    draw();
    const exportRows = (list) => [
      ['วันที่', 'เลขที่เอกสาร', who, ...(isEx ? ['หมวดหมู่'] : []), 'ภาษีมูลค่าเพิ่ม', 'ยอดรวมสุทธิ', 'หัก ณ ที่จ่าย', 'สถานะ'],
      ...list.map((d) => [d.date, d.number, d.contact_name || '', ...(isEx ? [S.boot.acc.get(d.account)?.name || ''] : []), Number(d.vat), Number(d.total), Number(d.wht), T.statusName(type, d.status)]),
    ];
    $('[data-xls]', main).onclick = () => excel(`${LIST_TITLE[type].split(' /')[0]}-${T.today()}`, exportRows(filtered()), LIST_TITLE[type].split(' /')[0]);
    $('[data-bx]', main).onclick = () => excel(`${LIST_TITLE[type].split(' /')[0]}-${T.today()}`, exportRows(docs.filter((d) => sel.has(d.id))));
    $('[data-bp]', main).onclick = async (e) => {
      const ids = docs.filter((d) => sel.has(d.id)).slice(0, 30).map((d) => d.id);
      e.target.disabled = true; e.target.textContent = 'กำลังสร้าง PDF…';
      try { await downloadDocs(ids, { ...printPrefs(), copy: false }); } catch (err) { fail(err); }
      e.target.disabled = false; e.target.textContent = 'ดาวน์โหลด PDF';
    };
    $('[data-bc]', main).onclick = () => { sel.clear(); draw(); };
    $('[data-q]', main).oninput = () => { page = 0; draw(); };
    $('[data-p]', main).onchange = (e) => { location.hash = `#/docs/${type}?p=${e.target.value}${status ? `&s=${status}` : ''}`; };
    $('[data-s]', main).onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      status = b.dataset.v; page = 0;
      $$('[data-s] button', main).forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
    $('[data-all]', main).onchange = (e) => {
      const rows = filtered().slice(page * per, page * per + per);
      rows.forEach((d) => (e.target.checked ? sel.add(d.id) : sel.delete(d.id)));
      draw();
    };
    $('[data-pager]', main).onclick = (e) => {
      const p = e.target.closest('[data-pg]'); if (p) { page = Number(p.dataset.pg); draw(); window.scrollTo(0, 0); }
      if (e.target.closest('[data-tot]')) { showTotal = true; draw(); }
    };
    $('[data-pager]', main).onchange = (e) => { if (e.target.matches('[data-per]')) { per = Number(e.target.value); store.set('acc.per', String(per)); page = 0; draw(); } };
    const body = $('[data-body]', main);
    body.addEventListener('change', async (e) => {
      const ck = e.target.closest('[data-ck]');
      if (ck) { const id = ck.closest('[data-id]').dataset.id; if (ck.checked) sel.add(id); else sel.delete(id); draw(); return; }
      const st = e.target.closest('[data-st]'); if (!st) return;
      const d = docs.find((x) => x.id === st.dataset.st);
      const v = st.value;
      try {
        if (type === 'QT') { await post(`/docs/${d.id}/status`, { status: v }); d.status = v; toast('เปลี่ยนสถานะแล้ว'); }
        if (type === 'IV' && v === 'paid') { location.hash = `#/new/RE?from=${d.id}`; return; }
        if (type === 'EX' && v === 'paid') { if (await payExpense(d)) { d.status = 'paid'; toast('บันทึกจ่ายเงินแล้ว'); } }
        if (type === 'EX' && v === 'open') {
          if (await confirmBox('ยกเลิกการจ่ายเงิน', `${esc(d.number)} จะกลับเป็นรอจ่าย และรายการบัญชีการจ่ายจะถูกลบ`)) { await post(`/docs/${d.id}/pay`, { pay: null }); d.status = 'open'; }
        }
      } catch (err) { fail(err); }
      draw();
    });
    body.addEventListener('click', (e) => {
      if (e.target.closest('.ck, .st')) return;
      const tr = e.target.closest('[data-id]'); if (!tr) return;
      const d = docs.find((x) => x.id === tr.dataset.id);
      const more = e.target.closest('[data-more]');
      if (!more) { location.hash = `#/doc/${d.id}`; return; }
      const live = d.status !== 'void';
      const items = [['ดูเอกสาร', () => { location.hash = `#/doc/${d.id}`; }]];
      if (live && !(type === 'IV' && d.status === 'paid')) items.push(['แก้ไข', () => { location.hash = `#/edit/${d.id}`; }]);
      items.push(['ทำซ้ำ', () => { location.hash = `#/new/${type}?from=${d.id}&copy=1`; }]);
      if (live && type === 'QT') items.push(['แปลงเป็นใบแจ้งหนี้', () => { location.hash = `#/new/IV?from=${d.id}`; }]);
      if (live && type === 'IV' && d.status === 'open') items.push(['รับชำระเงิน', () => { location.hash = `#/new/RE?from=${d.id}`; }]);
      if (live && isEx && d.status === 'open') items.push(['บันทึกจ่ายเงิน', async () => { try { if (await payExpense(d)) { d.status = 'paid'; draw(); } } catch (err) { fail(err); } }]);
      items.push(null, ['ดาวน์โหลด PDF', async () => { try { toast('กำลังสร้าง PDF…'); await downloadDocs([d.id], printPrefs()); } catch (err) { fail(err); } }]);
      if (!isEx) items.push(['ลิงก์ให้ลูกค้า', () => shareDoc(d).catch(fail)]);
      if (isEx && d.attachment) items.push(['ดูไฟล์บิล', async () => { try { const { url } = await get(`/attachment?key=${encodeURIComponent(d.attachment)}`); window.open(url, '_blank', 'noopener'); } catch (err) { fail(err); } }]);
      if (live) items.push(null, ['ยกเลิกเอกสาร', async () => { try { if (await voidDoc(d)) { toast('ยกเลิกแล้ว'); render(); } } catch (err) { fail(err); } }, { danger: true }]);
      popMenu(more, items);
    });
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

  const ITEM_KIND = { service: 'บริการ', product: 'สินค้าไม่นับสต็อก', stock: 'สินค้านับสต็อก' };
  const KIND_ICON = {
    service: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17h16M6 17a6 6 0 0 1 12 0M12 8V6M10 6h4"/></svg>',
    product: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8h16v12H4zM3 4h18v4H3zM10 12h4"/></svg>',
    stock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 13h8v8H3zM13 13h8v8h-8zM8 3h8v8H8z"/></svg>',
  };

  // Shrinks a picked picture to a small square-ish data URL (item pictures, at most `max` px).
  async function smallImage(file, max = 360) {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file); });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  }

  // A photo of a signature or stamp on white paper → transparent PNG cropped to the ink.
  async function cleanMark(file) {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file); });
    const k = Math.min(1, 640 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height);
    const d = px.data;
    let x0 = c.width; let y0 = c.height; let x1 = -1; let y1 = -1;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const sat = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      let a = d[i + 3];
      // Paper is light and grey; ink is dark, stamp ink is coloured. Fade the paper out.
      if (sat < 40) { if (lum > 222) a = 0; else if (lum > 165) a = Math.round((a * (222 - lum)) / 57); } else if (lum > 238) a = 0;
      d[i + 3] = a;
      if (a > 24) { const p = i / 4; const x = p % c.width; const y = (p - x) / c.width; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    g.putImageData(px, 0, 0);
    if (x1 < 0) return c.toDataURL('image/png');
    x0 = Math.max(0, x0 - 4); y0 = Math.max(0, y0 - 4); x1 = Math.min(c.width - 1, x1 + 4); y1 = Math.min(c.height - 1, y1 + 4);
    const o = document.createElement('canvas');
    o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
    o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  }

  async function editItem(it = {}) {
    let image = it.image || null;
    const cats = [...new Set(S.boot.items.map((i) => i.category).filter(Boolean))];
    const kind = it.kind || 'service';
    const saved = await dialog({
      title: it.id ? 'แก้ไขสินค้า / บริการ' : 'เพิ่มสินค้า / บริการ', wide: true,
      body: `<div class="item-form">
        <div class="item-pic"><div class="ip" data-ip>${image ? `<img src="${esc(image)}" alt="">` : 'รูปสินค้า'}</div>
          <button type="button" class="btn sm" data-pick>เลือกรูป</button><button type="button" class="btn sm ghost" data-nopic ${image ? '' : 'hidden'}>เอาออก</button><input type="file" accept="image/*" hidden data-file></div>
        <div class="grid g2">
          <div class="field span2"><span>ประเภท</span><div class="seg" data-seg="kind">${Object.entries(ITEM_KIND).map(([v, l]) => `<button type="button" data-v="${v}" class="${kind === v ? 'on' : ''}">${l}</button>`).join('')}</div><input type="hidden" name="kind" value="${kind}"></div>
          <label class="field span2"><span>ชื่อ</span><input type="text" name="name" value="${esc(it.name || '')}"></label>
          <label class="field"><span>รหัสสินค้า</span><input type="text" name="sku" value="${esc(it.sku || '')}"></label>
          <label class="field"><span>บาร์โค้ด</span><input type="text" name="barcode" inputmode="numeric" value="${esc(it.barcode || '')}"></label>
          <label class="field"><span>หน่วย</span><input type="text" name="unit" value="${esc(it.unit || '')}" placeholder="ชิ้น, ชั่วโมง, เดือน"></label>
          <label class="field"><span>หมวดสินค้า</span><input type="text" name="category" list="cat-dl" value="${esc(it.category || '')}"><datalist id="cat-dl">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
          <label class="field"><span>ราคาขายต่อหน่วย</span><input type="number" step="0.01" name="price" class="num" value="${esc(it.price ?? '')}"></label>
          <label class="field"><span>ราคาทุน / ราคาซื้อ</span><input type="number" step="0.01" name="cost" class="num" value="${esc(Number(it.cost) ? it.cost : '')}"></label>
          <label class="field" data-stock-only><span>ยอดยกมา (จำนวนตั้งต้น)</span><input type="number" step="any" name="stock_open" class="num" value="${esc(Number(it.stock_open) ? it.stock_open : '')}"><small>ขายแล้วลด ซื้อ (บันทึกค่าใช้จ่าย) แล้วเพิ่ม</small></label>
          <label class="field"><span>บัญชีรายได้</span><select name="account">${accOptions(['income'], it.account || (kind === 'service' ? sysAcc('service') : sysAcc('sales')))}</select></label>
          <label class="field span2"><span>รายละเอียด (พิมพ์ใต้ชื่อในเอกสาร)</span><textarea name="description" rows="2">${esc(it.description || '')}</textarea></label>
          ${it.id ? `<label class="check span2"><input type="checkbox" name="archived" ${it.archived ? 'checked' : ''}> ซ่อนรายการนี้</label>` : ''}
        </div></div>`,
      onOpen: (el) => {
        bindSegs(el);
        const sync = () => { $('[data-stock-only]', el).hidden = $('input[name=kind]', el).value !== 'stock'; };
        sync();
        $('[data-seg=kind]', el).addEventListener('click', () => setTimeout(sync));
        const f = $('[data-file]', el);
        $('[data-pick]', el).onclick = () => f.click();
        $('[data-nopic]', el).onclick = (e) => { image = null; $('[data-ip]', el).textContent = 'รูปสินค้า'; e.target.hidden = true; };
        f.onchange = async () => { if (!f.files[0]) return; image = await smallImage(f.files[0]); $('[data-ip]', el).innerHTML = `<img src="${image}" alt="">`; $('[data-nopic]', el).hidden = false; };
      },
      onOk: async (el) => {
        const d = { ...formData(el), image };
        return (it.id ? await put(`/items/${it.id}`, d) : await post('/items', d)).item;
      },
    });
    if (saved) {
      const i = S.boot.items.findIndex((x) => x.id === saved.id);
      if (i >= 0) S.boot.items[i] = saved; else S.boot.items.push(saved);
      S.boot.items.sort((a, b) => a.name.localeCompare(b.name, 'th'));
    }
    return saved;
  }

  async function viewItems(main, q) {
    let kind = ['service', 'product', 'stock'].includes(q.get('k')) ? q.get('k') : '';
    let sort = 'name';
    let dir = 1;
    const [{ stock }] = await Promise.all([get('/stock'), loadBoot()]);
    const onHand = (i) => Math.round((Number(i.stock_open) + (stock[i.id]?.bought || 0) - (stock[i.id]?.sold || 0)) * 10000) / 10000;
    main.innerHTML = `<div class="page-h"><div><h1>สินค้า / บริการ</h1><div class="sub">เลือกใช้ในเอกสารขายและค่าใช้จ่ายได้ทันที</div></div>
      <div class="actions"><button class="btn" data-xls>ดาวน์โหลด Excel</button><button class="btn primary" data-new>${ICON.plus}เพิ่มรายการ</button></div></div>
      <div class="card"><div class="filters">
        <div class="seg" data-k><button data-v="" class="${kind ? '' : 'on'}">แสดงทั้งหมด</button>${Object.entries(ITEM_KIND).map(([v, l]) => `<button data-v="${v}" class="${v === kind ? 'on' : ''}">${KIND_ICON[v]} ${l}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" data-arch> แสดงที่ซ่อน</label>
        <input type="search" placeholder="ค้นหาจาก ชื่อ, รหัสสินค้า หรือบาร์โค้ด" data-q style="margin-left:auto;max-width:320px"></div>
      <div class="tbl-wrap"><table class="tbl item-tbl"><thead><tr><th></th><th></th><th class="sort" data-sort="sku">รหัสสินค้า</th><th class="sort" data-sort="name">ชื่อสินค้า</th><th class="num sort" data-sort="price">ราคาต่อหน่วย</th><th class="num sort" data-sort="stock">จำนวนคงคลัง</th><th>หมวดสินค้า</th><th></th></tr></thead><tbody data-body></tbody></table></div></div>`;
    const rowsOf = () => {
      const s = $('[data-q]', main).value.trim().toLowerCase();
      const arch = $('[data-arch]', main).checked;
      const key = (i) => (sort === 'price' ? Number(i.price) : sort === 'stock' ? (i.kind === 'stock' ? onHand(i) : -Infinity) : String(i[sort] || ''));
      return S.boot.items.filter((i) => (arch || !i.archived) && (!kind || i.kind === kind)
        && (!s || i.name.toLowerCase().includes(s) || (i.sku || '').toLowerCase().includes(s) || (i.barcode || '').includes(s)))
        .sort((a, b) => { const x = key(a); const y = key(b); return (typeof x === 'number' ? x - y : x.localeCompare(y, 'th')) * dir; });
    };
    const draw = () => {
      const rows = rowsOf();
      $$('[data-sort]', main).forEach((th) => { th.classList.toggle('on', th.dataset.sort === sort); th.dataset.dir = dir > 0 ? '▲' : '▼'; });
      $('[data-body]', main).innerHTML = rows.length ? rows.map((i) => {
        const n = i.kind === 'stock' ? onHand(i) : null;
        return `<tr class="click" data-id="${i.id}">
        <td class="th-cell"><div class="thumb">${i.image ? `<img src="${esc(i.image)}" alt="">` : ICON.items}</div></td>
        <td class="kind-ic" title="${ITEM_KIND[i.kind] || ''}">${KIND_ICON[i.kind] || KIND_ICON.service}</td>
        <td class="mono">${esc(i.sku || '')}</td>
        <td><b>${esc(i.name)}</b>${i.archived ? ' <span class="chip">ซ่อน</span>' : ''}${i.barcode ? `<div class="muted mono" style="font-size:12px">${esc(i.barcode)}</div>` : ''}</td>
        <td class="num">${money(i.price)}${i.unit ? ` <span class="muted">/ ${esc(i.unit)}</span>` : ''}</td>
        <td class="num">${n === null ? '<span class="muted">-</span>' : `<span style="${n <= 0 ? 'color:var(--bad);font-weight:600' : ''}">${T.qtyFmt(n)}</span>`}</td>
        <td>${i.category ? `<span class="cat" style="--c:${catTone(i.category)}">${esc(i.category)}</span>` : ''}</td>
        <td class="act"><button class="icon-btn" data-more aria-label="เพิ่มเติม">${DOTS}</button></td></tr>`;
      }).join('')
        : '<tr><td colspan="8"><div class="empty"><b>ไม่มีสินค้าหรือบริการ</b>บันทึกไว้เพื่อกรอกเอกสารได้เร็วขึ้น</div></td></tr>';
    };
    draw();
    $('[data-q]', main).oninput = draw;
    $('[data-arch]', main).onchange = draw;
    $('[data-k]', main).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; kind = b.dataset.v; $$('[data-k] button', main).forEach((x) => x.classList.toggle('on', x === b)); draw(); };
    main.querySelector('thead').onclick = (e) => { const th = e.target.closest('[data-sort]'); if (!th) return; dir = sort === th.dataset.sort ? -dir : 1; sort = th.dataset.sort; draw(); };
    $('[data-new]', main).onclick = async () => { if (await editItem({ kind: kind || 'service' })) draw(); };
    $('[data-xls]', main).onclick = () => excel(`สินค้าและบริการ-${T.today()}`, [
      ['ประเภท', 'รหัสสินค้า', 'บาร์โค้ด', 'ชื่อสินค้า', 'หน่วย', 'ราคาขาย', 'ราคาทุน', 'จำนวนคงคลัง', 'หมวดสินค้า'],
      ...rowsOf().map((i) => [ITEM_KIND[i.kind] || '', i.sku || '', i.barcode || '', i.name, i.unit || '', Number(i.price), Number(i.cost), i.kind === 'stock' ? onHand(i) : '', i.category || '']),
    ], 'สินค้า');
    $('[data-body]', main).onclick = async (e) => {
      const tr = e.target.closest('[data-id]'); if (!tr) return;
      const it = S.boot.items.find((i) => i.id === tr.dataset.id);
      const more = e.target.closest('[data-more]');
      if (!more) { if (await editItem(it)) draw(); return; }
      popMenu(more, [
        ['แก้ไข', async () => { if (await editItem(it)) draw(); }],
        ['ทำซ้ำ', async () => { const { id: _, ...copy } = it; if (await editItem({ ...copy, name: `${it.name} (สำเนา)` })) draw(); }],
        ['สร้างใบแจ้งหนี้', () => { location.hash = `#/new/IV?item=${it.id}`; }],
        null,
        [it.archived ? 'แสดงรายการนี้' : 'ซ่อนรายการนี้', async () => {
          try { const { item } = await put(`/items/${it.id}`, { ...it, archived: !it.archived }); Object.assign(it, item); draw(); } catch (err) { fail(err); }
        }, { danger: !it.archived }],
      ]);
    };
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
      const pick = q.get('item') && S.boot.items.find((i) => i.id === q.get('item'));
      if (pick && !from) {
        doc.lines = [{ ...blankLine(type), name: pick.name, desc: pick.description || '', unit: pick.unit || '', price: Number(type === 'EX' && Number(pick.cost) ? pick.cost : pick.price), itemId: pick.id, ...(type !== 'EX' && pick.account ? { account: pick.account } : {}) }];
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
          Object.assign(l, { price: Number(isEx && Number(it.cost) ? it.cost : it.price), unit: it.unit || '', desc: it.description || l.desc, account: !isEx && it.account ? it.account : l.account, itemId: it.id });
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
      const form = cur.form || window.Wht50.formFor(doc.contact);
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
    const { doc, ref, children, journal, issuer } = await get(`/docs/${id}`);
    const b = signedBy(issuer);
    const printable = { ...doc, ref };
    const t = doc.type;
    const live = doc.status !== 'void';
    const acts = [];
    if (live && t === 'QT') acts.push(`<a class="btn primary" href="#/new/IV?from=${doc.id}">แปลงเป็นใบแจ้งหนี้</a>`, `<a class="btn" href="#/new/RE?from=${doc.id}">ออกใบเสร็จ (ขายสด)</a>`);
    if (live && t === 'IV' && doc.status === 'open') acts.push(`<a class="btn primary" href="#/new/RE?from=${doc.id}">รับชำระเงิน</a>`);
    if (live && t === 'EX' && doc.status === 'open') acts.push('<button class="btn primary" data-act="pay">บันทึกจ่ายเงิน</button>');
    if (live && t === 'EX' && doc.status === 'paid' && doc.wht > 0) acts.push('<button class="btn" data-act="wht">หนังสือรับรองหัก ณ ที่จ่าย</button>');
    const more = [];
    if (live && !(t === 'IV' && doc.status === 'paid')) more.push(`<a class="btn" href="#/edit/${doc.id}">แก้ไข</a>`);
    if (t !== 'EX') more.push(`<button class="btn" data-act="share">${ICON.link}${doc.public_token ? 'คัดลอกลิงก์' : 'สร้างลิงก์ให้ลูกค้า'}</button>`);
    more.push(`<a class="btn" href="#/new/${t}?from=${doc.id}&copy=1">ทำซ้ำ</a>`);
    if (live && t === 'QT') more.push(`<button class="btn" data-act="qt" data-v="${doc.status === 'rejected' ? 'open' : 'rejected'}">${doc.status === 'rejected' ? 'เปิดใหม่' : 'ลูกค้าไม่อนุมัติ'}</button>`);
    if (live && t === 'EX' && doc.status === 'paid') more.push('<button class="btn" data-act="unpay">ยกเลิกการจ่าย</button>');
    if (live) more.push('<button class="btn danger" data-act="void">ยกเลิกเอกสาร</button>');

    const canSign = !!(b.signature || b.stamp);
    const billing = t === 'QT' || t === 'IV';
    const P = printPrefs(b);
    main.innerHTML = `<div class="page-h"><div><h1><span class="mono">${esc(doc.number)}</span></h1><div class="sub">${esc(T.docTitle(doc)[0])} · ${statusChip(t, doc.status)}</div></div>
      <div class="actions">${acts.join('')}<button class="btn" data-act="pdf">ดาวน์โหลด PDF</button><button class="btn dark" data-act="print">${ICON.print}พิมพ์</button></div></div>
      <div class="view">
        <div class="paper-wrap" data-paper></div>
        <div class="side">
          <div class="card card-pad po"><h2>${esc(T.TYPE_NAME[t])}</h2>
            <div class="po-row"><label class="check"><input type="checkbox" data-po="original" ${P.original ? 'checked' : ''}> ต้นฉบับ</label>
              ${t !== 'EX' ? `<label class="check"><input type="checkbox" data-po="copy" ${P.copy ? 'checked' : ''}> สำเนา</label><input type="number" min="1" max="5" data-po="copies" value="${P.copies}" class="po-n" aria-label="จำนวนสำเนา">` : ''}</div>
            ${billing ? `<label class="sw-row"><span>ข้อมูลการรับชำระ</span><input type="checkbox" class="sw" data-po="pay" ${P.pay ? 'checked' : ''}></label>` : ''}
            <label class="sw-row${canSign ? '' : ' off'}"><span>ลายเซ็นและตราประทับ${canSign ? '' : '<small>อัปโหลดได้ที่ <a href="#/settings">ตั้งค่า</a></small>'}</span><input type="checkbox" class="sw" data-po="sign" ${P.sign ? 'checked' : ''} ${canSign ? '' : 'disabled'}></label>
            <label class="sw-row"><span>ภาษาเอกสาร</span><select data-po="lang" style="width:auto"><option value="th" ${P.lang === 'th' ? 'selected' : ''}>ไทย</option><option value="en" ${P.lang === 'en' ? 'selected' : ''}>English</option></select></label>
            <div class="muted" style="font-size:12px" data-pages></div>
          </div>
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
          <div class="card card-pad"><h2>บันทึกบัญชี</h2>${journal.length ? `<table class="journal-mini"><tbody>${journal.map((j) => `<tr><td${j.debit ? '' : ' class="cr"'}><span class="j-code">${esc(j.account)}</span>${esc(j.name || '')}</td><td class="num">${j.debit ? money(j.debit) : ''}</td><td class="num">${j.credit ? money(j.credit) : ''}</td></tr>`).join('')}</tbody></table>`
    : `<div class="muted" style="font-size:13px">${t === 'QT' ? 'ใบเสนอราคาไม่ลงบัญชี' : doc.status === 'void' ? 'เอกสารถูกยกเลิก ไม่มีรายการบัญชี' : '—'}</div>`}</div>
        </div>
      </div>`;

    // Options → preview of the first page, and what print / download produce.
    const opts = () => {
      const o = { ...P };
      $$('[data-po]', main).forEach((i) => { o[i.dataset.po] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Number(i.value) || 1 : i.value; });
      if (!canSign) o.sign = false;
      return o;
    };
    const preview = () => {
      const o = opts();
      savePrintPrefs(o);
      const html = T.renderSet(printable, b, o);
      const n = (html.match(/<article class="paper/g) || []).length;
      const first = !o.original && o.copy !== false && t !== 'EX' ? 'copy' : 'original';
      $('[data-paper]', main).innerHTML = T.renderDoc(printable, b, { ...o, copy: first, page: n > 1 ? '1' : '' });
      $('[data-pages]', main).textContent = `ดาวน์โหลดหรือพิมพ์ได้ ${n} หน้า`;
      fitPaper(main);
    };
    preview();
    main.addEventListener('change', (e) => { if (e.target.closest('[data-po]')) preview(); });

    main.onclick = async (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      try {
        if (act === 'pdf') {
          a.disabled = true;
          const label = a.textContent;
          a.textContent = 'กำลังสร้าง PDF…';
          try { await T.downloadPdf(T.renderSet(printable, b, opts()), `${doc.number}.pdf`); } finally { a.disabled = false; a.textContent = label; }
        }
        if (act === 'print') printHtml(T.renderSet(printable, b, opts()));
        if (act === 'wht') whtDialog(doc, b);
        if (act === 'share') { await shareDoc(doc); render(); }
        if (act === 'pay' && await payExpense(doc)) { toast('บันทึกจ่ายเงินแล้ว'); render(); }
        if (act === 'unpay' && await confirmBox('ยกเลิกการจ่ายเงิน', 'รายการจะกลับเป็นรอจ่าย และรายการบัญชีการจ่ายจะถูกลบ')) { await post(`/docs/${doc.id}/pay`, { pay: null }); render(); }
        if (act === 'qt') { await post(`/docs/${doc.id}/status`, { status: a.dataset.v }); render(); }
        if (act === 'void' && await voidDoc(doc)) { toast('ยกเลิกแล้ว'); render(); }
        if (act === 'file') { const { url } = await get(`/attachment?key=${encodeURIComponent(doc.attachment)}`); window.open(url, '_blank', 'noopener'); }
      } catch (err) { fail(err); }
    };
  }

  // หนังสือรับรองการหักภาษี ณ ที่จ่าย on the official RD form (wht50.js): preview, PDF, print.
  function whtDialog(doc, b) {
    const W = window.Wht50;
    const canSign = !!(b.signature || b.stamp);
    const opts = (el) => ({
      copies: [1, 2].filter((n) => $(`[data-wc="${n}"]`, el).checked),
      sign: canSign && $('[data-ws]', el).checked,
    });
    const make = async (el) => {
      const o = opts(el);
      if (!o.copies.length) throw new Error('เลือกอย่างน้อย 1 ฉบับ');
      return W.pdf(doc, b, o);
    };
    const name = `${doc.wht_cert?.number || doc.number}-50ทวิ.pdf`;
    return dialog({
      title: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย', wide: true, ok: '', cancel: 'ปิด',
      extra: '<button class="btn" data-wpdf>ดาวน์โหลด PDF</button><button class="btn dark" data-wprint>พิมพ์</button>',
      body: `<div class="wht50">
        <div class="wht50-paper" data-wp><div class="muted">กำลังสร้างตัวอย่าง…</div></div>
        <div class="wht50-side">
          <p class="muted" style="margin-top:0">แบบฟอร์มของกรมสรรพากร (50 ทวิ) ระบบเติมข้อมูลให้ในช่องเท่านั้น</p>
          <label class="check"><input type="checkbox" data-wc="1" checked> ฉบับที่ 1 (ให้ผู้ถูกหัก)</label>
          <label class="check"><input type="checkbox" data-wc="2" checked> ฉบับที่ 2 (เก็บเป็นหลักฐาน)</label>
          <label class="sw-row${canSign ? '' : ' off'}"><span>ลายเซ็นและตราประทับ${canSign ? '' : '<small>อัปโหลดได้ที่ <a href="#/settings">ตั้งค่า</a></small>'}</span><input type="checkbox" class="sw" data-ws ${canSign && b.settings?.signAuto ? 'checked' : ''} ${canSign ? '' : 'disabled'}></label>
          ${b.settings?.signer ? '' : '<p class="muted" style="font-size:12px">ใส่ชื่อผู้ลงนามได้ที่ <a href="#/settings">ตั้งค่า</a> › ชื่อผู้มีอำนาจลงนาม</p>'}
        </div></div>`,
      onOpen: (el) => {
        const draw = async () => {
          const o = opts(el);
          try {
            const cv = await W.canvas(doc, b, { ...o, copy: o.copies[0] || 1, background: 'forms/50tawi.png', scale: 2 });
            const box = $('[data-wp]', el);
            box.innerHTML = '';
            box.appendChild(cv);
          } catch (err) { fail(err); }
        };
        draw();
        el.addEventListener('change', (e) => { if (e.target.closest('[data-wc],[data-ws]')) draw(); });
        const busy = async (btn, fn) => {
          const label = btn.textContent;
          btn.disabled = true; btn.textContent = 'กำลังสร้าง PDF…';
          try { await fn(); } catch (err) { fail(err); } finally { btn.disabled = false; btn.textContent = label; }
        };
        $('[data-wpdf]', el).onclick = (e) => busy(e.target, async () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(await make(el));
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        });
        $('[data-wprint]', el).onclick = (e) => {
          const w = window.open('', '_blank');
          busy(e.target, async () => {
            const url = URL.createObjectURL(await make(el));
            if (w) w.location.href = url; else window.location.href = url;
          }).then(() => { if (w && w.location.href === 'about:blank') w.close(); });
        };
      },
    });
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
    vat_sales: ['รายงานภาษีขายตามเอกสาร', 'ใบกำกับภาษีและใบเสร็จขายของเดือน พร้อมเลขผู้เสียภาษี สาขา', 'month', 'tax'],
    vat_purchase: ['รายงานภาษีซื้อตามเอกสาร', 'ค่าใช้จ่ายของเดือน แยกสถานะใบกำกับภาษี', 'month', 'tax'],
    vat_pp36: ['รายงานภาษีซื้อ ภ.พ.36', 'บริการจากต่างประเทศที่ต้องนำส่งภาษีเอง', 'month', 'tax'],
    wht_pnd3: ['ภ.ง.ด.3', 'หัก ณ ที่จ่ายบุคคลธรรมดา', 'month', 'tax'],
    wht_pnd53: ['ภ.ง.ด.53', 'หัก ณ ที่จ่ายนิติบุคคล', 'month', 'tax'],
    wht_recv: ['ภาษีถูกหัก ณ ที่จ่าย', 'ที่ลูกค้าหักไว้ ใช้เครดิตภาษีปลายปี', 'range', 'tax'],
    pnl: ['งบกำไรขาดทุน', 'รายได้ ค่าใช้จ่าย และกำไรสุทธิ', 'range', 'fs'],
    balance: ['งบแสดงฐานะการเงิน', 'สินทรัพย์ หนี้สิน และส่วนของเจ้าของ', 'asof', 'fs'],
    trial: ['งบทดลอง', 'ยอดเดบิต เครดิต ทุกบัญชี', 'range', 'fs'],
    ledger: ['บัญชีแยกประเภท', 'ความเคลื่อนไหวรายบัญชี', 'range', 'books'],
    sales: ['รายงานสรุปยอดขาย', 'ใบแจ้งหนี้และขายสด ตามเอกสาร ลูกค้า หรือสินค้า', 'sales', 'sales'],
    ar: ['ลูกหนี้ค้างรับ', 'ใบแจ้งหนี้ที่ยังไม่ได้รับเงิน แยกตามอายุหนี้', 'none', 'books'],
    ap: ['เจ้าหนี้ค้างจ่าย', 'ค่าใช้จ่ายที่ยังไม่ได้จ่าย', 'none', 'books'],
  };

  function viewReports(main) {
    const groups = [['sales', 'ขาย'], ['tax', 'ภาษี'], ['fs', 'งบการเงิน'], ['books', 'สมุดบัญชีและติดตามหนี้']];
    main.innerHTML = `<div class="page-h"><div><h1>รายงาน</h1><div class="sub">ดาวน์โหลดเป็น Excel หรือพิมพ์ได้ทุกรายงาน</div></div></div>
      ${groups.map(([g, h]) => `<div class="rep-h">${h}</div><div class="rep-grid">${g === 'tax' && biz().vat_registered ? '<a class="card" href="#/vat/purchases"><b>จัดการเอกสารภาษีซื้อ</b><small>สถานะใบกำกับภาษี รอใบกำกับ รอใช้สิทธิ์</small></a><a class="card" href="#/vat/returns"><b>เตรียมแบบภาษีรายเดือน</b><small>ภ.พ.30 และ ภ.พ.36 จากเอกสารของเดือน</small></a>' : ''}${Object.entries(REPORTS).filter(([, r]) => r[3] === g && (g !== 'tax' || biz().vat_registered || !r[0].includes('ภาษีมูลค่าเพิ่ม') && !r[0].includes('ภาษีขาย') && !r[0].includes('ภาษีซื้อ'))).map(([k, r]) => `<a class="card" href="#/report/${k}"><b>${r[0]}</b><small>${r[1]}</small></a>`).join('')}</div>`).join('')}`;
  }

  async function viewReport(main, name, q) {
    if (name === 'sales') return viewSales(main, q);
    if (name === 'vat_sales' || name === 'vat_purchase' || name === 'vat_pp36') return viewVatReport(main, name, q);
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
      <div class="actions">${ctl}<button class="btn" data-csv>ดาวน์โหลด Excel</button><button class="btn dark" data-print>${ICON.print}พิมพ์</button></div></div>
      ${extra}
      <div class="card"><div class="tbl-wrap"><table class="tbl" data-tbl><thead>${head}</thead><tbody>${body || `<tr><td colspan="9"><div class="empty"><b>ไม่มีรายการ</b></div></td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div></div>`;
    main.addEventListener('change', (e) => {
      const c = e.target.dataset.c; if (!c) return;
      const p = new URLSearchParams(q);
      p.set(c, e.target.value);
      if (mode === 'range') { p.set('from', $('[data-c=from]', main).value); p.set('to', $('[data-c=to]', main).value); }
      location.hash = `#/report/${name}?${p}`;
    });
    $('[data-csv]', main).onclick = () => excel(`${title}-${mode === 'month' ? month : to}`, csvRows, title);
    $('[data-print]', main).onclick = () => printHtml(`<div class="print-report"><h2 style="margin:0">${esc(title)}</h2><div>${esc(biz().name)}${biz().tax_id ? ` · เลขประจำตัวผู้เสียภาษี ${esc(T.taxIdFmt(biz().tax_id))}` : ''}</div><div style="margin-bottom:10px">${esc(periodText)}</div>${extra}<table>${$('[data-tbl]', main).innerHTML}</table></div>`);
    main.querySelector('tbody').onclick = (e) => { const tr = e.target.closest('[data-doc]'); if (tr) location.hash = `#/doc/${tr.dataset.doc}`; };
  }

  /* ---------- VAT: reports by document, purchase tax documents, monthly returns ---------- */

  const TH_MONTH_NAMES = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const taxMonthText = (ym) => `${TH_MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ปี ${Number(ym.slice(0, 4)) + 543}`;
  const shiftMonth = (ym, n) => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
  // How an expense stands for input VAT.
  const VAT_ST = {
    got: ['ได้รับใบกำกับภาษีแล้ว', 'good'], wait: ['รอใบกำกับภาษี', 'warn'],
    none: ['ไม่มีใบกำกับภาษี', ''], pp36: ['บริการต่างประเทศ (ภ.พ.36)', 'info'],
  };
  const SALE_ST = { '': 'แสดงทั้งหมด', open: 'รอชำระ', paid: 'ชำระแล้ว', void: 'ยกเลิก' };
  const BUY_ST = { '': 'แสดงทั้งหมด', got: 'ใช้สิทธิ์ภาษีซื้อเดือนนี้', wait: 'รอใบกำกับภาษี', none: 'ไม่มีใบกำกับภาษี', pp36: 'บริการต่างประเทศ (ภ.พ.36)' };
  const VAT_TITLE = { vat_sales: 'รายงานภาษีขายตามเอกสาร', vat_purchase: 'รายงานภาษีซื้อตามเอกสาร', vat_pp36: 'รายงานภาษีซื้อ ภ.พ.36' };

  // The business lines printed under a tax report's title.
  function taxpayerLines(ym) {
    const b = biz();
    return [
      `เดือนภาษี ${taxMonthText(ym)}`,
      `ชื่อผู้ประกอบการ ${b.name}${b.tax_id ? ` เลขประจำตัวผู้เสียภาษีอากร ${T.taxIdFmt(b.tax_id)}` : ''} (${T.branchFmt(b.branch || '00000')})`,
      ...(b.address ? [`ชื่อสถานประกอบการ ${String(b.address).replace(/\s*\n\s*/g, ' ')}`] : []),
    ];
  }

  async function viewVatReport(main, name, q) {
    const now = ymNow();
    const month = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : now;
    const isSale = name === 'vat_sales';
    const isPp36 = name === 'vat_pp36';
    const ST = isSale ? SALE_ST : BUY_ST;
    const status = !isPp36 && Object.keys(ST).includes(q.get('s') || '') ? q.get('s') || '' : '';
    const d = await get(`/reports/${name}?month=${month}${status ? `&status=${status}` : ''}`);
    const title = VAT_TITLE[name];
    const preset = month === now ? 'cur' : month === shiftMonth(now, -1) ? 'last' : 'pick';
    const n = (v) => `<td class="num">${money(v)}</td>`;
    const rateLine = (r) => `<div class="vat-rate"><span>${r.rate}%</span><span>${money(r.rate ? r.base : r.value)}</span></div>`;
    let cols; let body; let foot; let raw;
    if (isPp36) {
      cols = ['ลำดับ', 'วันที่จ่าย', 'เลขที่เอกสาร', 'เลขที่อ้างอิง', 'ผู้ให้บริการ', 'จำนวนเงินที่จ่าย', 'ภาษี 7%'];
      body = d.rows.map((r, i) => `<tr class="click" data-doc="${r.id}"><td>${i + 1}</td><td class="nowrap">${T.slashDate(r.date)}</td><td><span class="doc-no">${esc(r.number)}</span>${r.paid ? '' : ' <span class="chip warn">ยังไม่จ่าย</span>'}</td><td>${esc(r.ref_no)}</td><td>${esc(r.name)}</td>${n(r.base)}${n(r.vat)}</tr>`).join('');
      foot = `<tr><td colspan="5">รวม ${d.totals.count} รายการ</td>${n(d.totals.base)}${n(d.totals.vat)}</tr>`;
      raw = [cols, ...d.rows.map((r, i) => [i + 1, T.slashDate(r.date), r.number, r.ref_no, r.name, r.base, r.vat]), ['', '', '', '', 'รวม', d.totals.base, d.totals.vat]];
    } else if (isSale) {
      cols = ['ลำดับ', 'วันที่', 'เลขที่เอกสาร', 'เอกสารอ้างอิง', 'ชื่อลูกค้า', 'เลขผู้เสียภาษี', 'สาขา', 'มูลค่า', 'ภาษีมูลค่าเพิ่ม', ''];
      body = d.rows.map((r, i) => `<tr class="click${r.void ? ' void' : ''}" data-doc="${r.id}"><td>${i + 1}</td><td class="nowrap">${T.slashDate(r.date)}</td>
        <td class="nowrap"><span class="dot ${r.void ? 'bad' : r.status === 'paid' ? 'good' : 'warn'}"></span><span class="doc-no">${esc(r.number)}</span>${r.void ? ' <span class="chip bad">ยกเลิก</span>' : ''}</td>
        <td>${esc(r.ref_no)}</td><td>${esc(r.name)}</td><td class="mono nowrap">${esc(T.taxIdFmt(r.tax_id))}</td><td>${esc(T.branchFmt(r.branch))}</td>
        <td class="num">${money(r.value)}${r.void ? '' : rateLine(r)}</td>${n(r.vat)}<td class="act"><button class="icon-btn" data-more aria-label="เพิ่มเติม">${DOTS}</button></td></tr>`).join('');
      foot = `<tr><td colspan="7">รวม ${d.shown.count} เอกสาร</td>${n(d.shown.value)}${n(d.shown.vat)}<td></td></tr>`;
      raw = [cols.slice(0, 9).concat(['อัตราภาษี', 'ฐานภาษี 7%', 'อัตรา 0 / ยกเว้น', 'สถานะ']),
        ...d.rows.map((r, i) => [i + 1, T.slashDate(r.date), r.number, r.ref_no, r.name, r.tax_id, T.branchFmt(r.branch), r.value, r.vat, r.void ? '' : `${r.rate}%`, r.base, r.zero, SALE_ST[r.status] || r.status]),
        ['', '', '', '', 'รวม', '', '', d.shown.value, d.shown.vat, '', d.shown.base, d.shown.zero, '']];
    } else {
      cols = ['ลำดับ', 'วันที่', 'เลขที่เอกสาร', 'เลขที่ใบกำกับภาษี', 'ชื่อผู้จำหน่าย', 'เลขผู้เสียภาษี', 'สาขา', 'มูลค่า', 'ภาษีมูลค่าเพิ่ม', 'สถานะ', ''];
      body = d.rows.map((r, i) => `<tr class="click" data-doc="${r.id}"><td>${i + 1}</td><td class="nowrap">${T.slashDate(r.date)}</td>
        <td class="nowrap"><span class="doc-no">${esc(r.number)}</span>${r.deferred ? `<div class="muted" style="font-size:12px">ยกมาจาก ${esc(T.thMonth(r.doc_date.slice(0, 7)))}</div>` : ''}</td>
        <td>${esc(r.ref_no)}</td><td>${esc(r.name)}</td><td class="mono nowrap">${esc(T.taxIdFmt(r.tax_id))}</td><td>${esc(T.branchFmt(r.branch))}</td>
        <td class="num">${money(r.value)}${r.vat ? rateLine(r) : ''}</td>${n(r.vat)}<td><span class="chip ${VAT_ST[r.state][1]}">${esc(VAT_ST[r.state][0])}</span></td>
        <td class="act"><button class="icon-btn" data-more aria-label="เพิ่มเติม">${DOTS}</button></td></tr>`).join('');
      foot = `<tr><td colspan="7">รวม ${d.shown.count} เอกสาร</td>${n(d.shown.value)}${n(d.shown.vat)}<td colspan="2"></td></tr>`;
      raw = [cols.slice(0, 10), ...d.rows.map((r, i) => [i + 1, T.slashDate(r.date), r.number, r.ref_no, r.name, r.tax_id, T.branchFmt(r.branch), r.value, r.vat, VAT_ST[r.state][0]]),
        ['', '', '', '', 'รวม', '', '', d.shown.value, d.shown.vat, '']];
    }
    const sums = isPp36 ? [['ภาษีที่ต้องนำส่ง ภ.พ.36', d.totals.vat]]
      : isSale ? [['ยอดขายทั้งหมด', d.totals.value], ['ยอดขายที่ต้องเสียภาษี', d.totals.base], ['อัตรา 0 / ได้รับยกเว้น', d.totals.zero], ['ภาษีขาย', d.totals.vat]]
        : [['ยอดซื้อที่ใช้สิทธิ์', d.totals.base], ['ภาษีซื้อที่ใช้สิทธิ์', d.totals.vat], ['เอกสารที่ใช้สิทธิ์', `${d.totals.count} ใบ`]];
    const note = !isSale && !isPp36 && d.waiting.count
      ? `<div class="note-box warn" style="margin:0 0 14px">มีเอกสารรอใบกำกับภาษี ${d.waiting.count} ใบ (ภาษี ${money(d.waiting.vat)} บาท) ยังไม่นับเป็นภาษีซื้อ · <a href="#/vat/purchases?s=wait">จัดการเอกสารภาษีซื้อ</a></div>` : '';
    const lines = taxpayerLines(month);
    const table = `<table class="tbl vat-tbl" data-tbl><thead><tr>${cols.map((c, i) => `<th class="${['มูลค่า', 'ภาษีมูลค่าเพิ่ม', 'จำนวนเงินที่จ่าย', 'ภาษี 7%'].includes(c) ? 'num' : ''}">${c}</th>`).join('')}</tr></thead>
      <tbody>${body || `<tr><td colspan="${cols.length}"><div class="empty"><b>ไม่มีเอกสารในเดือนนี้</b>${isSale ? 'ใบแจ้งหนี้ที่เป็นใบกำกับภาษี และใบเสร็จรับเงินของเดือนจะแสดงที่นี่' : isPp36 ? 'ตั้งค่าใช้จ่ายเป็น “บริการต่างประเทศ (ภ.พ.36)” ได้ที่หน้าจัดการเอกสารภาษีซื้อ' : 'ค่าใช้จ่ายของเดือนจะแสดงที่นี่'}</div></td></tr>`}</tbody>
      ${d.rows.length ? `<tfoot>${foot}</tfoot>` : ''}</table>`;
    const head = `<div class="vat-head"><h2>${esc(title)}</h2>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
    const sumBox = `<div class="vat-sums">${sums.map(([k, v]) => `<div><span>${k}</span><b>${typeof v === 'number' ? money(v) : esc(v)}</b></div>`).join('')}</div>`;
    main.innerHTML = `<div class="page-h"><div><a href="#/reports" class="muted" style="text-decoration:none">← รายงาน</a><h1>${esc(title)}</h1><div class="sub">${esc(biz().name)} · เดือนภาษี ${esc(T.thMonth(month))}</div></div>
      <div class="actions"><button class="btn primary" data-xls>ดาวน์โหลดเป็น Excel</button><button class="btn dark" data-print>${ICON.print}พิมพ์</button></div></div>
      <div class="card vat-filter">
        <label class="field"><span>ช่วงเวลา</span><span class="row-in"><select data-c="r">${[['cur', 'เดือนปัจจุบัน'], ['last', 'เดือนก่อน'], ['pick', 'เลือกเดือน']].map(([v, l]) => `<option value="${v}" ${v === preset ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input type="month" value="${month}" data-c="month"></span></label>
        ${isPp36 ? '' : `<label class="field"><span>สถานะ</span><select data-c="s">${Object.entries(ST).map(([v, l]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`}
        <span style="flex:1"></span>
        ${isSale ? '' : '<a class="btn ghost" href="#/vat/purchases">จัดการเอกสารภาษีซื้อ</a>'}<a class="btn ghost" href="#/vat/returns">เตรียมแบบภาษีรายเดือน</a>
      </div>
      ${note}
      <div class="card card-pad">${head}${sumBox}<div class="tbl-wrap">${table}</div></div>`;
    const go = (patch) => {
      const p = new URLSearchParams({ month, ...(status ? { s: status } : {}), ...patch });
      if (!p.get('s')) p.delete('s');
      location.hash = `#/report/${name}?${p}`;
    };
    main.addEventListener('change', (e) => {
      const c = e.target.dataset.c; if (!c) return;
      if (c === 'r') { if (e.target.value === 'cur') go({ month: now }); else if (e.target.value === 'last') go({ month: shiftMonth(now, -1) }); else $('[data-c=month]', main).showPicker?.(); return; }
      if (c === 'month' && /^\d{4}-\d{2}$/.test(e.target.value)) go({ month: e.target.value });
      if (c === 's') go({ s: e.target.value });
    });
    $('[data-xls]', main).onclick = () => excel(`${title}-${month}`, [[title], ...lines.map((l) => [l]), [], raw[0], ...raw.slice(1), [], ...sums], title.replace('รายงาน', ''));
    $('[data-print]', main).onclick = () => printHtml(`<div class="print-report">${head}${table}</div>`);
    main.querySelector('tbody').onclick = (e) => {
      const tr = e.target.closest('[data-doc]'); if (!tr) return;
      const more = e.target.closest('[data-more]');
      if (!more) { location.hash = `#/doc/${tr.dataset.doc}`; return; }
      const items = [['ดูเอกสาร', () => { location.hash = `#/doc/${tr.dataset.doc}`; }], ['ดาวน์โหลด PDF', async () => { try { toast('กำลังสร้าง PDF…'); await downloadDocs([tr.dataset.doc], printPrefs()); } catch (err) { fail(err); } }]];
      if (!isSale) items.push(['เปลี่ยนสถานะใบกำกับภาษี', () => { location.hash = `#/vat/purchases?m=${month}`; }]);
      popMenu(more, items);
    };
  }

  // จัดการเอกสารภาษีซื้อ: every expense with the status of its tax invoice and the month it is claimed in.
  async function viewVatPurchases(main, q) {
    const now = ymNow();
    const m = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : '';
    const period = m ? 'pick' : q.get('p') || 'all';
    const ranges = {
      all: null, month: monthRange(now), last: monthRange(shiftMonth(now, -1)),
      year: [`${now.slice(0, 4)}-01-01`, `${now.slice(0, 4)}-12-31`], pick: m ? monthRange(m) : null,
    };
    const range = ranges[period];
    const { docs } = await get(`/vat/purchases${range ? `?from=${range[0]}&to=${range[1]}` : ''}`);
    const FILTER = { '': 'ทั้งหมด', wait: 'รอใบกำกับภาษี', got: 'ได้รับแล้ว', defer: 'รอใช้สิทธิ์', none: 'ไม่มีใบกำกับภาษี', pp36: 'ภ.พ.36' };
    let status = Object.keys(FILTER).includes(q.get('s') || '') ? q.get('s') || '' : '';
    let rate = '';
    let shown = 50;
    const sel = new Set();
    const deferred = (d) => d.claim_month !== d.date.slice(0, 7);
    main.innerHTML = `<div class="page-h"><div><h1>จัดการเอกสารภาษีซื้อ</h1><div class="sub">สถานะใบกำกับภาษีของค่าใช้จ่าย และเดือนที่ใช้สิทธิ์ภาษีซื้อ</div></div>
      <div class="actions"><button class="btn" data-xls>ดาวน์โหลด Excel</button><a class="btn" href="#/report/vat_purchase">รายงานภาษีซื้อ</a><a class="btn primary" href="#/new/EX">${ICON.plus}บันทึกค่าใช้จ่าย</a></div></div>
      <div class="card">
        <div class="filters">
          <input type="search" placeholder="ค้นหา เลขที่เอกสาร ชื่อผู้จำหน่าย เลขที่ใบกำกับภาษี" data-q style="flex:1;max-width:none;min-width:200px">
          <select data-p>${[['all', 'ทุกช่วงเวลา'], ['month', 'เดือนนี้'], ['last', 'เดือนก่อน'], ['year', 'ปีนี้'], ...(m ? [['pick', T.thMonth(m)]] : [])].map(([v, l]) => `<option value="${v}" ${v === period ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select data-rate><option value="">อัตรา VAT ทั้งหมด</option><option value="7">อัตรา VAT 7%</option><option value="0">ไม่มี VAT</option></select>
        </div>
        <div class="filters"><div class="seg" data-s>${Object.entries(FILTER).map(([v, l]) => `<button data-v="${v}" class="${v === status ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="bulk" data-bulk hidden><b data-bn></b><button class="btn sm" data-set="got">ได้รับใบกำกับภาษีแล้ว</button><button class="btn sm" data-set="wait">รอใบกำกับภาษี</button><button class="btn sm" data-set="defer">ใช้สิทธิ์เดือนอื่น</button><button class="btn sm" data-set="pp36">ภ.พ.36</button><button class="btn sm ghost" data-bc>ล้างที่เลือก</button></div>
        <div class="vat-count" data-count></div>
        <div class="tbl-wrap"><table class="tbl doc-tbl ex"><thead><tr>
          <th class="ck"><input type="checkbox" data-all aria-label="เลือกทั้งหมด"></th><th></th><th>วันที่เอกสาร</th><th>เลขที่เอกสาร</th><th>ชื่อผู้จำหน่าย</th>
          <th class="num">มูลค่า / ภาษีมูลค่าเพิ่ม</th><th>สถานะใบกำกับภาษี</th><th>ใช้สิทธิ์เดือน</th><th></th></tr></thead>
        <tbody data-body></tbody></table></div>
        <div class="pager" data-more-wrap></div>
      </div>`;
    const filtered = () => {
      const s = $('[data-q]', main).value.trim().toLowerCase();
      return docs.filter((d) => (!status || (status === 'defer' ? deferred(d) : d.state === status))
        && (!rate || (rate === '7' ? d.vat > 0 : !(d.vat > 0)))
        && (!s || d.number.toLowerCase().includes(s) || (d.contact_name || '').toLowerCase().includes(s) || (d.ref_no || '').toLowerCase().includes(s) || (d.tax_id || '').includes(s)));
    };
    const stCell = (d) => {
      const hasVat = d.state === 'got' || d.state === 'wait';
      const opts = hasVat ? [['wait', 'รอใบกำกับภาษี'], ['got', 'ได้รับใบกำกับภาษีแล้ว'], ['defer', 'ใช้สิทธิ์เดือนอื่น…']] : [['none', 'ไม่มีใบกำกับภาษี'], ['pp36', 'บริการต่างประเทศ (ภ.พ.36)']];
      return `<label class="st ${VAT_ST[d.state][1]} pick"><select data-st="${d.id}" aria-label="สถานะใบกำกับภาษี">${opts.map(([v, l]) => `<option value="${v}" ${v === d.state ? 'selected' : ''}>${l}</option>`).join('')}</select>${CHEV}</label>`;
    };
    const draw = () => {
      const rows = filtered();
      const view = rows.slice(0, shown);
      $('[data-count]', main).innerHTML = `รายการทั้งหมด <b>${rows.length}</b> รายการ · ภาษีซื้อ ${money(rows.reduce((a, d) => a + (d.state === 'got' ? d.vat : 0), 0))} บาท${rows.some((d) => d.state === 'wait') ? ` · รอใบกำกับภาษี ${money(rows.reduce((a, d) => a + (d.state === 'wait' ? d.vat : 0), 0))} บาท` : ''}`;
      $('[data-body]', main).innerHTML = view.length ? view.map((d) => `<tr class="click${sel.has(d.id) ? ' sel' : ''}" data-id="${d.id}">
        <td class="ck"><input type="checkbox" data-ck ${sel.has(d.id) ? 'checked' : ''} aria-label="เลือก"></td>
        <td class="th-cell"><div class="thumb">${d.thumb ? `<img src="${esc(d.thumb)}" alt="" loading="lazy">` : d.attachment ? '<span>PDF</span>' : ICON.ex}</div></td>
        <td class="nowrap">${T.thDate(d.date)}</td>
        <td class="nowrap"><span class="dot ${statusTone(d.status, 'EX')}"></span><span class="doc-no">${esc(d.number)}</span>${d.ref_no ? `<div class="muted" style="font-size:12px">ใบกำกับ ${esc(d.ref_no)}</div>` : ''}</td>
        <td>${esc(d.contact_name || '')}${d.tax_id ? `<div class="muted mono" style="font-size:12px">${esc(T.taxIdFmt(d.tax_id))}</div>` : ''}</td>
        <td class="num"><b>${money(d.value)}</b><div class="muted" style="font-size:12px">${d.vat > 0 ? money(d.vat) : d.state === 'pp36' ? `ภ.พ.36 ${money(Math.round(d.value * 7) / 100)}` : '–'}</div></td>
        <td>${stCell(d)}</td>
        <td class="nowrap">${d.state === 'got' || d.state === 'wait' ? `${esc(T.thMonth(d.claim_month))}${deferred(d) ? ' <span class="chip info">รอใช้สิทธิ์</span>' : ''}` : '<span class="muted">–</span>'}</td>
        <td class="act"><button class="icon-btn" data-more aria-label="เพิ่มเติม">${DOTS}</button></td></tr>`).join('')
        : '<tr><td colspan="9"><div class="empty"><b>ไม่มีเอกสาร</b>ลองเปลี่ยนช่วงเวลาหรือสถานะ</div></td></tr>';
      $('[data-more-wrap]', main).innerHTML = rows.length > shown ? `<button class="btn sm" data-showmore>แสดงเพิ่ม (${rows.length - shown})</button>` : '';
      $('[data-all]', main).checked = view.length > 0 && view.every((d) => sel.has(d.id));
      $('[data-bulk]', main).hidden = !sel.size;
      $('[data-bn]', main).textContent = `เลือก ${sel.size} รายการ`;
    };
    draw();
    // Ask for the claim month: the document's month up to six months later.
    const pickMonth = async (list) => {
      const own = list.map((d) => d.date.slice(0, 7)).sort().pop();
      const first = list.map((d) => d.date.slice(0, 7)).sort()[0];
      const max = shiftMonth(first, 6);
      return dialog({
        title: 'ใช้สิทธิ์ภาษีซื้อเดือนอื่น', ok: 'บันทึก',
        body: `<p style="margin:0 0 12px">เลือกเดือนภาษีที่จะนำภาษีซื้อไปหัก (ใช้สิทธิ์ได้ภายใน 6 เดือนนับจากเดือนที่ออกใบกำกับภาษี)</p>
          <label class="field"><span>ใช้สิทธิ์ในเดือนภาษี</span><input type="month" name="month" min="${own}" max="${max}" value="${list.length === 1 ? list[0].claim_month : shiftMonth(own, 1) > max ? own : shiftMonth(own, 1)}"></label>`,
        onOk: (el) => { const v = $('[name=month]', el).value; if (!v || v < own || v > max) { toast(`เลือกเดือน ${T.thMonth(own)} ถึง ${T.thMonth(max)}`, true); return false; } return v; },
      });
    };
    const setStatus = async (list, v) => {
      if (!list.length) return;
      let body = { ids: list.map((d) => d.id), status: v };
      if (v === 'defer') {
        const month = await pickMonth(list.filter((d) => d.state === 'got' || d.state === 'wait'));
        if (!month) { draw(); return; }
        body = { ...body, status: 'got', month };
      } else if (v === 'wait') body.month = list.length === 1 ? list[0].vat_month : null;
      const r = await post('/vat/purchases', body);
      for (const d of list) {
        if (r.skipped.includes(d.id)) continue;
        if (body.status === 'got' || body.status === 'wait') { d.state = body.status; d.vat_month = body.month || null; d.claim_month = body.month || d.date.slice(0, 7); } else d.state = body.status;
      }
      toast(r.skipped.length ? `เปลี่ยนแล้ว ${r.updated} รายการ · ข้าม ${r.skipped.length} รายการที่ใช้สถานะนี้ไม่ได้` : `เปลี่ยนสถานะแล้ว ${r.updated} รายการ`);
      draw();
    };
    $('[data-q]', main).oninput = () => { shown = 50; draw(); };
    $('[data-rate]', main).onchange = (e) => { rate = e.target.value; draw(); };
    $('[data-p]', main).onchange = (e) => { location.hash = `#/vat/purchases?p=${e.target.value}${status ? `&s=${status}` : ''}`; };
    $('[data-s]', main).onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      status = b.dataset.v; shown = 50;
      $$('[data-s] button', main).forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
    $('[data-all]', main).onchange = (e) => { filtered().slice(0, shown).forEach((d) => (e.target.checked ? sel.add(d.id) : sel.delete(d.id))); draw(); };
    $('[data-bc]', main).onclick = () => { sel.clear(); draw(); };
    $('[data-bulk]', main).onclick = async (e) => {
      const b = e.target.closest('[data-set]'); if (!b) return;
      try { await setStatus(docs.filter((d) => sel.has(d.id)), b.dataset.set); sel.clear(); draw(); } catch (err) { fail(err); }
    };
    $('[data-more-wrap]', main).onclick = (e) => { if (e.target.closest('[data-showmore]')) { shown += 50; draw(); } };
    $('[data-xls]', main).onclick = () => excel(`เอกสารภาษีซื้อ-${T.today()}`, [
      ['วันที่เอกสาร', 'เลขที่เอกสาร', 'เลขที่ใบกำกับภาษี', 'ชื่อผู้จำหน่าย', 'เลขผู้เสียภาษี', 'มูลค่า', 'ภาษีมูลค่าเพิ่ม', 'สถานะใบกำกับภาษี', 'ใช้สิทธิ์เดือน'],
      ...filtered().map((d) => [d.date, d.number, d.ref_no || '', d.contact_name || '', d.tax_id || '', d.value, d.vat, VAT_ST[d.state][0], d.state === 'got' || d.state === 'wait' ? d.claim_month : '']),
    ], 'เอกสารภาษีซื้อ');
    const body = $('[data-body]', main);
    body.addEventListener('change', async (e) => {
      const ck = e.target.closest('[data-ck]');
      if (ck) { const id = ck.closest('[data-id]').dataset.id; if (ck.checked) sel.add(id); else sel.delete(id); draw(); return; }
      const st = e.target.closest('[data-st]'); if (!st) return;
      try { await setStatus([docs.find((x) => x.id === st.dataset.st)], st.value); } catch (err) { fail(err); draw(); }
    });
    body.addEventListener('click', (e) => {
      if (e.target.closest('.ck, .st')) return;
      const tr = e.target.closest('[data-id]'); if (!tr) return;
      const d = docs.find((x) => x.id === tr.dataset.id);
      const more = e.target.closest('[data-more]');
      if (!more) { location.hash = `#/doc/${d.id}`; return; }
      const items = [['ดูเอกสาร', () => { location.hash = `#/doc/${d.id}`; }], ['แก้ไข', () => { location.hash = `#/edit/${d.id}`; }]];
      if (d.attachment) items.push(['ดูไฟล์บิล', async () => { try { const { url } = await get(`/attachment?key=${encodeURIComponent(d.attachment)}`); window.open(url, '_blank', 'noopener'); } catch (err) { fail(err); } }]);
      if (d.state === 'got' || d.state === 'wait') items.push(null, ['ใช้สิทธิ์เดือนอื่น…', () => setStatus([d], 'defer').catch(fail)]);
      if (deferred(d)) items.push(['ใช้สิทธิ์เดือนของเอกสาร', () => setStatus([d], 'got').catch(fail)]);
      popMenu(more, items);
    });
  }

  // เตรียมแบบภาษีรายเดือน: ภ.พ.30 and ภ.พ.36 worked out from the documents, marked filed when sent to the RD.
  const PP30_LINES = [
    ['l1', '1. ยอดขายในเดือนนี้'], ['l2', '2. ลบ ยอดขายที่เสียภาษีในอัตราร้อยละ 0 และที่ได้รับยกเว้น'], ['l4', '4. ยอดขายที่ต้องเสียภาษี'],
    ['l5', '5. ภาษีขายเดือนนี้'], ['l6', '6. ยอดซื้อที่มีสิทธิ์นำภาษีซื้อมาหักในการคำนวณภาษีเดือนนี้'], ['l7', '7. ภาษีซื้อเดือนนี้'],
    ['l8', '8. ภาษีที่ต้องชำระเดือนนี้ (5 มากกว่า 7)'], ['l9', '9. ภาษีที่ชำระเกินเดือนนี้ (5 น้อยกว่า 7)'], ['l10', '10. ภาษีที่ชำระเกินยกมา'],
    ['l11', '11. ภาษีสุทธิที่ต้องชำระ'], ['l12', '12. ภาษีสุทธิที่ชำระเกิน'],
  ];
  const FORM_NAME = { PP30: 'ภ.พ.30', PP36: 'ภ.พ.36' };
  async function newReturn(form) {
    const month = await dialog({
      title: `เตรียมแบบ ${FORM_NAME[form]}`, ok: 'สร้าง',
      body: `<label class="field"><span>เดือนภาษี</span><input type="month" name="month" value="${shiftMonth(ymNow(), -1)}" max="${ymNow()}"></label>
        <p class="muted" style="margin:10px 0 0;font-size:13px">${form === 'PP30' ? 'คำนวณจากรายงานภาษีขายและภาษีซื้อตามเอกสารของเดือนนั้น พร้อมภาษีชำระเกินยกมาจากเดือนก่อน' : 'คำนวณจากค่าใช้จ่ายที่ตั้งเป็นบริการต่างประเทศ (ภ.พ.36) ที่จ่ายในเดือนนั้น'}</p>`,
      onOk: (el) => $('[name=month]', el).value || false,
    });
    if (!month) return;
    const r = await post('/vat/returns', { form, month });
    location.hash = `#/vat/returns/${r.return.id}`;
  }
  async function viewVatReturns(main, q, id) {
    const { returns } = await get('/vat/returns');
    if (id) return viewVatReturn(main, returns.find((r) => r.id === id));
    const tab = ['PP30', 'PP36'].includes(q.get('f')) ? q.get('f') : '';
    const list = returns.filter((r) => !tab || r.form === tab);
    const net = (r) => (r.form === 'PP36' ? r.data.vat : r.data.l11 ? r.data.l11 : -r.data.l12);
    main.innerHTML = `<div class="page-h"><div><h1>เตรียมแบบภาษีรายเดือน</h1><div class="sub">ภ.พ.30 ภาษีมูลค่าเพิ่ม และ ภ.พ.36 บริการจากต่างประเทศ</div></div>
      <div class="actions"><button class="btn primary" data-new>${ICON.plus}สร้างใหม่ ${CHEV}</button></div></div>
      <div class="seg" style="margin-bottom:14px" data-tab>${[['', 'แสดงทั้งหมด'], ['PP30', 'ภ.พ.30'], ['PP36', 'ภ.พ.36']].map(([v, l]) => `<button data-v="${v}" class="${v === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>วันที่ชำระภาษี</th><th>เดือนที่ยื่นแบบภาษี</th><th>แบบฟอร์มภาษี</th><th class="num">มูลค่าภาษีขาย</th><th class="num">มูลค่าภาษีซื้อ</th><th class="num">ต้องชำระ / ชำระเกิน</th><th>สถานะ</th></tr></thead>
        <tbody data-body>${list.length ? list.map((r) => `<tr class="click" data-id="${r.id}"><td class="nowrap">${r.status === 'filed' ? T.thDate(r.filed_at) : `ภายใน ${T.thDate(r.due.online)}`}</td>
          <td>${esc(T.thMonth(r.month))}</td><td><b>${FORM_NAME[r.form]}</b></td>
          <td class="num">${r.form === 'PP30' ? money(r.data.l5) : '–'}</td><td class="num">${r.form === 'PP30' ? money(r.data.l7) : money(r.data.vat)}</td>
          <td class="num" style="color:${net(r) < 0 ? 'var(--good)' : 'inherit'}">${net(r) < 0 ? `เกิน ${money(-net(r))}` : money(net(r))}</td>
          <td>${r.status === 'filed' ? '<span class="chip good">ยื่นแล้ว</span>' : '<span class="chip warn">ร่าง</span>'}</td></tr>`).join('')
    : `<tr><td colspan="7"><div class="empty"><b>ยังไม่มีแบบภาษี</b>กดปุ่ม ‘สร้างใหม่’ เพื่อเตรียมแบบยื่น ภ.พ.30 หรือ ภ.พ.36</div></td></tr>`}</tbody></table></div></div>`;
    $('[data-new]', main).onclick = (e) => popMenu(e.currentTarget, [['ภ.พ.30 ภาษีมูลค่าเพิ่ม', () => newReturn('PP30').catch(fail)], ['ภ.พ.36 บริการจากต่างประเทศ', () => newReturn('PP36').catch(fail)]]);
    $('[data-tab]', main).onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) location.hash = `#/vat/returns${b.dataset.v ? `?f=${b.dataset.v}` : ''}`; };
    $('[data-body]', main).onclick = (e) => { const tr = e.target.closest('[data-id]'); if (tr) location.hash = `#/vat/returns/${tr.dataset.id}`; };
  }
  function viewVatReturn(main, r) {
    if (!r) { main.innerHTML = '<div class="empty"><b>ไม่พบแบบภาษี</b></div>'; return; }
    const pp30 = r.form === 'PP30';
    const draft = r.status === 'draft';
    const rows = pp30 ? PP30_LINES.map(([k, l]) => [l, r.data[k] || 0, k])
      : [['ค่าบริการที่จ่ายให้ผู้ประกอบการต่างประเทศ', r.data.base, 'base'], ['ภาษีมูลค่าเพิ่มที่ต้องนำส่ง (7%)', r.data.vat, 'vat'], ['จำนวนรายการ', r.data.count, 'count']];
    const strong = ['l5', 'l7', 'l11', 'l12', 'vat'];
    const title = `แบบ ${FORM_NAME[r.form]} เดือนภาษี ${T.thMonth(r.month)}`;
    const lines = taxpayerLines(r.month);
    const table = `<table class="tbl" data-tbl><thead><tr><th>รายการ</th><th class="num">จำนวนเงิน (บาท)</th></tr></thead><tbody>${rows.map(([l, v, k]) => `<tr${strong.includes(k) ? ' style="font-weight:700"' : ''}><td>${esc(l)}</td><td class="num">${k === 'count' ? v : money(v)}</td></tr>`).join('')}</tbody></table>`;
    const waiting = pp30 && r.data.waiting?.count ? `<div class="note-box warn" style="margin-bottom:14px">มีค่าใช้จ่ายรอใบกำกับภาษี ${r.data.waiting.count} ใบ (ภาษี ${money(r.data.waiting.vat)} บาท) ยังไม่รวมในภาษีซื้อ · <a href="#/vat/purchases?m=${r.month}&s=wait">ดูเอกสาร</a></div>` : '';
    main.innerHTML = `<div class="page-h"><div><a href="#/vat/returns" class="muted" style="text-decoration:none">← เตรียมแบบภาษีรายเดือน</a><h1>${esc(title)}</h1>
        <div class="sub">${draft ? `ร่าง · ยื่นภายใน ${T.thDate(r.due.paper)} (ยื่นออนไลน์ภายใน ${T.thDate(r.due.online)})` : `ยื่นแล้ว ${T.thDate(r.filed_at)}${r.filed_ref ? ` · ${esc(r.filed_ref)}` : ''}`}</div></div>
      <div class="actions">${draft ? '<button class="btn" data-refresh>คำนวณใหม่</button><button class="btn" data-del>ลบร่าง</button><button class="btn primary" data-file>บันทึกว่ายื่นแล้ว</button>' : '<button class="btn" data-unfile>กลับเป็นร่าง</button>'}
        <button class="btn" data-xls>ดาวน์โหลด Excel</button><button class="btn dark" data-print>${ICON.print}พิมพ์</button></div></div>
      ${waiting}
      <div class="card card-pad"><div class="vat-head"><h2>${esc(title)}</h2>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>
        <div class="tbl-wrap">${table}</div>
        <div class="vat-links">${pp30 ? `<a href="#/report/vat_sales?month=${r.month}">รายงานภาษีขาย (${r.data.salesCount} ใบ)</a><a href="#/report/vat_purchase?month=${r.month}">รายงานภาษีซื้อ (${r.data.purchaseCount} ใบ)</a>` : `<a href="#/report/vat_pp36?month=${r.month}">รายงานภาษีซื้อ ภ.พ.36</a>`}
          <a href="https://efiling.rd.go.th/" target="_blank" rel="noopener">ยื่นแบบออนไลน์ที่ efiling.rd.go.th ↗</a></div>
        <p class="muted" style="font-size:13px;margin:12px 0 0">${draft ? 'ร่างจะคำนวณจากเอกสารล่าสุดเมื่อกด “คำนวณใหม่” เมื่อบันทึกว่ายื่นแล้ว ตัวเลขจะคงที่' : 'แบบที่ยื่นแล้วจะไม่เปลี่ยนตามเอกสาร ถ้าต้องแก้ ให้กลับเป็นร่างแล้วคำนวณใหม่'}${pp30 ? ' · ยอดอัตรา 0 และยอดที่ได้รับยกเว้นรวมอยู่ในข้อ 2 ให้แยกข้อ 3 ตอนยื่นถ้ามี' : ''}</p></div>`;
    const act = (sel, fn) => { const b = $(sel, main); if (b) b.onclick = () => fn().catch(fail); };
    act('[data-refresh]', async () => { await post('/vat/returns', { form: r.form, month: r.month }); toast('คำนวณใหม่แล้ว'); render(); });
    act('[data-del]', async () => { if (await confirmBox('ลบร่างแบบภาษี', `ลบ ${esc(title)}`)) { await api('DELETE', A(`/vat/returns/${r.id}`)); location.hash = '#/vat/returns'; } });
    act('[data-file]', async () => {
      const ok = await dialog({
        title: 'บันทึกว่ายื่นแบบแล้ว', ok: 'บันทึก',
        body: `<div class="grid g2"><label class="field"><span>วันที่ยื่น / ชำระภาษี</span><input type="date" name="filed_at" value="${T.today()}"></label>
          <label class="field"><span>เลขที่อ้างอิง (ถ้ามี)</span><input type="text" name="filed_ref" placeholder="เลขที่ใบเสร็จกรมสรรพากร"></label></div>`,
        onOk: async (el) => { await post(`/vat/returns/${r.id}/file`, formData(el)); return true; },
      });
      if (ok) { toast('บันทึกแล้ว'); render(); }
    });
    act('[data-unfile]', async () => { await post(`/vat/returns/${r.id}/file`, { filed: false }); render(); });
    $('[data-xls]', main).onclick = () => excel(`${FORM_NAME[r.form]}-${r.month}`, [[title], ...lines.map((l) => [l]), [], ['รายการ', 'จำนวนเงิน'], ...rows.map(([l, v]) => [l, v])], FORM_NAME[r.form]);
    $('[data-print]', main).onclick = () => printHtml(`<div class="print-report"><div class="vat-head"><h2>${esc(title)}</h2>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>${table}</div>`);
  }

  /* ---------- Sales summary ---------- */

  const SALES_STATUS = { '': 'สถานะทั้งหมด', open: 'รอรับชำระ', paid: 'ชำระแล้ว', void: 'ยกเลิก' };
  async function viewSales(main, q) {
    const now = ymNow();
    const preset = q.get('r') || 'month';
    const ranges = {
      month: monthRange(now),
      last: (() => { const d = new Date(`${now}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return monthRange(d.toISOString().slice(0, 7)); })(),
      quarter: (() => { const [y, m] = now.split('-').map(Number); const s = Math.floor((m - 1) / 3) * 3 + 1; return [`${y}-${String(s).padStart(2, '0')}-01`, monthRange(`${y}-${String(s + 2).padStart(2, '0')}`)[1]]; })(),
      year: [`${now.slice(0, 4)}-01-01`, `${now.slice(0, 4)}-12-31`],
    };
    const [from, to] = preset === 'custom' ? [q.get('from') || ranges.month[0], q.get('to') || ranges.month[1]] : ranges[preset] || ranges.month;
    const status = Object.keys(SALES_STATUS).includes(q.get('s') || '') ? q.get('s') || '' : '';
    const by = ['customer', 'item'].includes(q.get('by')) ? q.get('by') : 'doc';
    const d = await get(`/reports/sales?from=${from}&to=${to}&by=${by}${status ? `&status=${status}` : ''}`);
    const b = biz();
    const stName = (r) => (r.status === 'paid' && r.type === 'RE' ? 'ชำระแล้ว (ขายสด)' : SALES_STATUS[r.status] || r.status);
    const cols = by === 'doc' ? ['เลขที่เอกสาร', 'วันที่', 'ชื่อลูกค้า', 'มูลค่า', 'ภาษีมูลค่าเพิ่ม', 'ยอดรวมสุทธิ', 'สถานะ']
      : by === 'customer' ? ['ชื่อลูกค้า', 'เลขผู้เสียภาษี', 'จำนวนเอกสาร', 'มูลค่า', 'ภาษีมูลค่าเพิ่ม', 'ยอดรวมสุทธิ']
        : ['สินค้า / บริการ', 'จำนวนที่ขาย', 'หน่วย', 'จำนวนเอกสาร', 'มูลค่าก่อนภาษี'];
    const numCols = by === 'doc' ? [3, 4, 5] : by === 'customer' ? [2, 3, 4, 5] : [1, 3, 4];
    const cells = (r) => (by === 'doc' ? [r.number, T.thDate(r.date), r.name, money(r.value), money(r.vat), money(r.total), stName(r)]
      : by === 'customer' ? [r.name, T.taxIdFmt(r.tax_id), r.count, money(r.value), money(r.vat), money(r.total)]
        : [r.name, T.qtyFmt(r.qty), r.unit, r.docs, money(r.value)]);
    const raw = (r) => (by === 'doc' ? [r.number, r.date, r.name, r.value, r.vat, r.total, stName(r)]
      : by === 'customer' ? [r.name, r.tax_id, r.count, r.value, r.vat, r.total] : [r.name, r.qty, r.unit, r.docs, r.value]);
    const table = `<table class="tbl sales-tbl" data-tbl><thead><tr>${cols.map((c, i) => `<th class="${numCols.includes(i) ? 'num' : ''}">${c}</th>`).join('')}</tr></thead>
      <tbody>${d.rows.length ? d.rows.map((r) => `<tr${by === 'doc' ? ` class="click${r.status === 'void' ? ' void' : ''}" data-doc="${r.id}"` : ''}>${cells(r).map((c, i) => `<td class="${numCols.includes(i) ? 'num' : ''}">${i === 0 && by === 'doc' ? `<span class="doc-no">${esc(c)}</span>` : esc(c)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}"><div class="empty"><b>ไม่มียอดขายในช่วงนี้</b>ลองเปลี่ยนช่วงเวลาหรือสถานะ</div></td></tr>`}</tbody></table>`;
    const period = `${T.thDate(from)} – ${T.thDate(to)}`;
    const head = `<div class="sum-head"><div><div class="sum-biz">${esc(b.name)}</div>
        <dl><dt>ณ วันที่</dt><dd>${T.thDate(T.today())}</dd><dt>ช่วงเวลา</dt><dd>${period}</dd><dt>จำนวนทั้งหมด</dt><dd>${d.totals.count} เอกสาร</dd></dl></div>
        <dl class="sum-tot"><dt>ยอดรวมทั้งสิ้น</dt><dd class="big">${money(d.totals.total)}</dd><dt>ภาษีมูลค่าเพิ่ม</dt><dd>${money(d.totals.vat)}</dd><dt>ยอดรวมก่อนภาษี</dt><dd>${money(d.totals.value)}</dd></dl></div>`;
    main.innerHTML = `<div class="page-h"><div><a href="#/reports" class="muted" style="text-decoration:none">← รายงาน</a><h1>รายงานสรุปยอดขาย</h1><div class="sub">ใบแจ้งหนี้และขายสด (ใบเสร็จที่ไม่ได้ออกจากใบแจ้งหนี้)</div></div>
      <div class="actions"><button class="btn" data-xls>ดาวน์โหลด Excel</button><button class="btn dark" data-print>${ICON.print}พิมพ์รายงาน</button></div></div>
      <div class="filters card" style="margin-bottom:14px">
        <select data-c="r">${[['month', 'เดือนปัจจุบัน'], ['last', 'เดือนก่อน'], ['quarter', 'ไตรมาสนี้'], ['year', 'ปีนี้'], ['custom', 'กำหนดเอง']].map(([v, l]) => `<option value="${v}" ${v === preset ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span data-custom ${preset === 'custom' ? '' : 'hidden'}><input type="date" value="${from}" data-c="from" style="width:auto"> <span class="muted">ถึง</span> <input type="date" value="${to}" data-c="to" style="width:auto"></span>
        <select data-c="s">${Object.entries(SALES_STATUS).map(([v, l]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="card card-pad">${head}
        <div class="tabs" data-by>${[['doc', 'ตามเอกสาร'], ['customer', 'ตามลูกค้า'], ['item', 'ตามสินค้า']].map(([v, l]) => `<button data-v="${v}" class="${v === by ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="tbl-wrap">${table}</div></div>`;
    const go = (patch) => {
      const p = new URLSearchParams({ r: preset, s: status, by, ...(preset === 'custom' ? { from, to } : {}), ...patch });
      if (p.get('r') !== 'custom') { p.delete('from'); p.delete('to'); }
      location.hash = `#/report/sales?${p}`;
    };
    main.addEventListener('change', (e) => {
      const c = e.target.dataset.c; if (!c) return;
      if (c === 'r' && e.target.value === 'custom') { go({ r: 'custom', from, to }); return; }
      go({ [c]: e.target.value });
    });
    $('[data-by]', main).onclick = (e) => { const t = e.target.closest('[data-v]'); if (t) go({ by: t.dataset.v }); };
    $('[data-xls]', main).onclick = () => excel(`สรุปยอดขาย-${from}-${to}`, [
      [`รายงานสรุปยอดขาย ${b.name}`], [`ช่วงเวลา ${period}`], [],
      cols, ...d.rows.map(raw), [],
      ['ยอดรวมก่อนภาษี', d.totals.value], ['ภาษีมูลค่าเพิ่ม', d.totals.vat], ['ยอดรวมทั้งสิ้น', d.totals.total],
    ], 'สรุปยอดขาย');
    $('[data-print]', main).onclick = () => printHtml(`<div class="print-report"><h2 style="margin:0">รายงานสรุปยอดขาย</h2>${head}${table}</div>`);
    main.querySelector('tbody').onclick = (e) => { const tr = e.target.closest('[data-doc]'); if (tr) location.hash = `#/doc/${tr.dataset.doc}`; };
  }

  // Each report as table HTML plus the rows for CSV export.
  function reportTable(name, d) {
    const m = (v) => money(v);
    const n = (v) => `<td class="num">${m(v)}</td>`;
    const docRow = (id) => (id ? ` class="click" data-doc="${id}"` : '');
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
    main.innerHTML = `<div class="page-h"><div><h1>ตั้งค่า</h1><div class="sub">ข้อมูลกิจการและรูปแบบเอกสาร${can('settings', 2) ? '' : ' · ดูอย่างเดียว'}</div></div><div class="actions">${can('settings', 2) ? '<button class="btn primary" data-save>บันทึก</button>' : ''}</div></div>
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
          <label class="field"><span>เล่มที่ หนังสือรับรอง 50 ทวิ</span><input type="text" data-s="whtBook" maxlength="20" value="${esc(s.whtBook || '')}" placeholder="ว่างไว้ = ปี พ.ศ. ที่จ่าย"></label>
          <label class="field"><span>เครดิตเทอมเริ่มต้น (วัน)</span><input type="number" data-s="creditDays" min="0" value="${esc(s.creditDays ?? 30)}"></label>
          <label class="field"><span>ราคาสินค้าเริ่มต้น</span><select data-s="priceMode"><option value="excl" ${s.priceMode !== 'incl' ? 'selected' : ''}>ไม่รวม VAT</option><option value="incl" ${s.priceMode === 'incl' ? 'selected' : ''}>รวม VAT แล้ว</option></select></label>
          <label class="field"><span>เดือนเริ่มรอบบัญชี</span><select data-s="fyStart">${T.TH_MONTHS_LONG.map((mn, i) => `<option value="${i + 1}" ${(s.fyStart || 1) === i + 1 ? 'selected' : ''}>${mn}</option>`).join('')}</select></label>
          <label class="field"><span>สีหัวเอกสาร</span><input type="color" data-s="color" value="${esc(s.color || '#E8590C')}" style="height:38px;padding:2px"></label>
          ${['QT', 'IV', 'RE'].map((k) => `<label class="field span2"><span>หมายเหตุเริ่มต้นใน${T.TYPE_NAME[k]}</span><textarea data-note="${k}" rows="2">${esc(s.notes?.[k] || '')}</textarea></label>`).join('')}
        </div></div>
        <div class="card card-pad"><h2>ลายเซ็นและตราประทับ</h2>
          <p class="muted" style="margin-top:0">ถ่ายรูปหรือสแกนลายเซ็นบนกระดาษขาว ระบบลบพื้นหลังให้เป็นโปร่งใส แล้ววางในช่อง "ในนาม" ของกิจการใน PDF ใบเสนอราคา ใบแจ้งหนี้ และใบเสร็จ</p>
          <div class="grid g2">
            ${['signature', 'stamp'].map((k) => `<div class="mark-pick"><div class="mp" data-mp="${k}">${b[k] ? `<img src="${esc(b[k])}" alt="">` : (k === 'signature' ? 'ลายเซ็น' : 'ตราประทับ')}</div>
              <div class="actions"><button type="button" class="btn sm" data-up="${k}">${k === 'signature' ? 'อัปโหลดลายเซ็น' : 'อัปโหลดตราประทับ'}</button><button type="button" class="btn sm ghost" data-rm="${k}" ${b[k] ? '' : 'hidden'}>เอาออก</button></div></div>`).join('')}
            <label class="field"><span>ชื่อผู้มีอำนาจลงนาม</span><input type="text" data-s="signer" value="${esc(s.signer || '')}"></label>
            <label class="field"><span>ตำแหน่ง</span><input type="text" data-s="signerTitle" value="${esc(s.signerTitle || '')}" placeholder="กรรมการผู้จัดการ"></label>
            <label class="check span2"><input type="checkbox" data-sign-auto ${s.signAuto ? 'checked' : ''}> ใส่ลายเซ็นและตราประทับในเอกสารโดยอัตโนมัติ รวมถึงลิงก์และ PDF ที่ลูกค้าดาวน์โหลด</label>
            <label class="field"><span>ภาษาเอกสารเริ่มต้น</span><select data-s="lang"><option value="th" ${s.lang !== 'en' ? 'selected' : ''}>ไทย</option><option value="en" ${s.lang === 'en' ? 'selected' : ''}>English</option></select></label>
          </div><input type="file" accept="image/*" hidden data-mf></div>
        <div class="card card-pad"><h2>รับชำระเงิน</h2>
          <p class="muted" style="margin-top:0">พิมพ์ในใบเสนอราคาและใบแจ้งหนี้ (ทั้ง PDF และลิงก์ให้ลูกค้า) ใบที่ยังไม่ชำระจะมี QR พร้อมเพย์ที่ผูกยอดชำระสุทธิไว้ ลูกค้าสแกนแล้วยอดขึ้นเอง</p>
          <div class="grid g2">
            <label class="field"><span>พร้อมเพย์ (เบอร์มือถือ / เลขผู้เสียภาษี / เลขบัตรประชาชน)</span><input type="text" inputmode="numeric" data-pp="id" value="${esc(s.promptpay?.id || '')}" placeholder="0812345678 หรือ 0105567012345"><small data-pp-hint></small></label>
            <label class="field"><span>ชื่อบัญชีพร้อมเพย์</span><input type="text" data-pp="name" value="${esc(s.promptpay?.name || '')}" placeholder="${esc(b.name)}"></label>
            <label class="check span2"><input type="checkbox" data-pp="qr" ${s.promptpay?.qr === false ? '' : 'checked'}> แสดง QR พร้อมเพย์ในเอกสาร</label>
            <div class="field span2"><span>บัญชีธนาคารและช่องทางอื่น</span><a class="ch-link" href="#/channels">${(s.banks || []).filter((x) => x.active !== false).map((x) => `<span class="ch-name">${channelBadge(x)}<span>${esc(x.kind === 'other' ? x.name || x.bank : `${x.bank} ${x.number}`)}</span></span>`).join('') || '<span class="muted">ยังไม่มีบัญชีธนาคาร</span>'}<span class="muted nowrap" style="margin-left:auto">จัดการช่องทางการเงิน ›</span></a></div>
            <label class="field span2"><span>ข้อความเพิ่มเติม (ไม่บังคับ)</span><textarea data-s="payment" rows="2" placeholder="เช่น กรุณาส่งสลิปมาที่ LINE @example">${esc(s.payment || '')}</textarea></label>
          </div></div>
        <a class="card card-pad int-card" href="#/integrations"><span class="int-logo">CC</span><div style="flex:1"><h2 style="margin:0 0 2px">เชื่อมต่อระบบ</h2><div class="muted">CapCourt Admin: ออกใบแจ้งหนี้รายเดือนให้สนามอัตโนมัติ และแจ้งผลการชำระกลับ</div></div><span class="muted nowrap">ตั้งค่า ›</span></a>
        <div class="card card-pad"><h2>กิจการทั้งหมด</h2><p class="muted" style="margin-top:0">มี ${S.businesses.length} กิจการในบัญชีนี้</p><div class="actions"><button class="btn" data-switch2>สลับกิจการ</button><button class="btn" data-newbiz>${ICON.plus}เพิ่มกิจการ</button></div></div>
        ${S.boot.role === 'owner' ? `<div class="card card-pad" style="border-color:var(--bad-soft)"><h2 style="color:var(--bad)">ลบกิจการ</h2><p class="muted" style="margin-top:0">ลบเอกสาร ผู้ติดต่อ และรายการบัญชีทั้งหมดของกิจการนี้ กู้คืนไม่ได้</p><button class="btn danger" data-del>ลบกิจการนี้</button></div>` : ''}
      </div>`;
    let logo = b.logo;
    const marks = { signature: b.signature || null, stamp: b.stamp || null };
    let markKey = null;
    const mf = $('[data-mf]', main);
    main.addEventListener('click', (e) => {
      const up = e.target.closest('[data-up]');
      if (up) { markKey = up.dataset.up; mf.value = ''; mf.click(); }
      const rm = e.target.closest('[data-rm]');
      if (rm) { marks[rm.dataset.rm] = null; $(`[data-mp=${rm.dataset.rm}]`, main).textContent = rm.dataset.rm === 'signature' ? 'ลายเซ็น' : 'ตราประทับ'; rm.hidden = true; }
    });
    mf.onchange = async () => {
      const f = mf.files[0]; if (!f || !markKey) return;
      try {
        marks[markKey] = await cleanMark(f);
        $(`[data-mp=${markKey}]`, main).innerHTML = `<img src="${marks[markKey]}" alt="">`;
        $(`[data-rm=${markKey}]`, main).hidden = false;
        if (!b.signature && !b.stamp) $('[data-sign-auto]', main).checked = true;
      } catch (err) { fail(err); }
    };
    // PromptPay
    const ppHint = () => {
      const d = $('[data-pp=id]', main).value.replace(/\D/g, '');
      const ok = (d.length === 10 && d[0] === '0') || d.length === 13 || d.length === 15;
      const h = $('[data-pp-hint]', main);
      h.textContent = !d ? 'เว้นว่างได้ถ้าไม่ใช้ QR' : ok ? `ใช้ได้ · ${d.length === 10 ? 'เบอร์มือถือ' : d.length === 13 ? 'เลขผู้เสียภาษี / บัตรประชาชน' : 'e-Wallet'}` : 'ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลข 13 หลัก';
      h.style.color = d && !ok ? 'var(--bad)' : '';
    };
    $('[data-pp=id]', main).oninput = ppHint;
    ppHint();
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
    if ($('[data-save]', main)) $('[data-save]', main).onclick = async (e) => {
      const d = formData(main);
      const settings = { ...s, prefixes: {}, notes: { ...(s.notes || {}) } };
      $$('[data-prefix]', main).forEach((i) => { settings.prefixes[i.dataset.prefix] = i.value; });
      $$('[data-s]', main).forEach((i) => { settings[i.dataset.s] = i.value; });
      $$('[data-note]', main).forEach((i) => { settings.notes[i.dataset.note] = i.value; });
      settings.signAuto = $('[data-sign-auto]', main).checked;
      settings.promptpay = { id: $('[data-pp=id]', main).value, name: $('[data-pp=name]', main).value, qr: $('[data-pp=qr]', main).checked };
      e.target.disabled = true;
      try {
        await put('', { name: d.name, name_en: d.name_en, tax_id: d.tax_id, branch: d.branch, address: d.address, phone: d.phone, email: d.email, website: d.website, vat_registered: d.vat_registered, logo, signature: marks.signature, stamp: marks.stamp, settings });
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

  /* ---------- Integrations: CapCourt Admin ---------- */

  const CC_LOGO = '<span class="int-logo">CC</span>';
  const CC_KINDS = [['package', 'แพ็กเกจเว็บรายเดือน'], ['slips', 'ค่าตรวจสลิป'], ['gp', 'GP จากยอดขายคลิป']];
  const thDateTime = (iso) => { if (!iso) return ''; const d = new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString(); return `${T.thDate(d.slice(0, 10))} ${d.slice(11, 16)}`; };

  /* ---------- Payment channels (ช่องทางการเงิน) ---------- */
  // Bank accounts and other ways to pay, kept in business settings.banks. Active ones print on
  // quotations and invoices; switching one to ไม่ใช้งานแล้ว hides it without losing it.

  // Short name and brand tone for the bank badge (initials in a coloured circle, not the banks' logos).
  const BANK_INFO = [
    ['ธนาคารกสิกรไทย', 'KBank', '#138F2D'], ['ธนาคารไทยพาณิชย์', 'SCB', '#4E2A84'], ['ธนาคารกรุงเทพ', 'BBL', '#1E4598'],
    ['ธนาคารกรุงไทย', 'KTB', '#1BA5E1'], ['ธนาคารกรุงศรีอยุธยา', 'BAY', '#C9A100'], ['ธนาคารทหารไทยธนชาต (ttb)', 'ttb', '#0050F0'],
    ['ธนาคารออมสิน', 'GSB', '#EB198D'], ['ธนาคารยูโอบี', 'UOB', '#0B3979'], ['ธนาคารซีไอเอ็มบี ไทย', 'CIMB', '#7E2F36'],
    ['ธนาคารเกียรตินาคินภัทร', 'KKP', '#635D96'], ['ธนาคารแลนด์ แอนด์ เฮ้าส์', 'LH', '#6D6E71'], ['ธ.ก.ส.', 'BAAC', '#4B9B3D'],
    ['ธนาคารทิสโก้', 'TISCO', '#12306B'], ['ธนาคารไอซีบีซี (ไทย)', 'ICBC', '#C4161C'], ['ธนาคารอาคารสงเคราะห์', 'GHB', '#F7941D'],
  ];
  const BANK_NAMES = BANK_INFO.map((x) => x[0]);
  const ACCT_TYPE = { savings: 'ออมทรัพย์', current: 'กระแสรายวัน', fixed: 'ฝากประจำ' };
  const OTHER_KINDS = ['ช่องทางรับชำระออนไลน์ (Payment Gateway)', 'บัตรเครดิต / เดบิต', 'วอลเล็ต (TrueMoney, ShopeePay …)', 'เช็ค', 'อื่นๆ'];
  const fmtAcct = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 4)}-${d.slice(4, 9)}-${d.slice(9)}` : String(n || ''); };
  function channelBadge(c) {
    if (c.kind === 'other') return `<span class="ch-badge other">${ICON.swap}</span>`;
    const info = BANK_INFO.find((x) => x[0] === c.bank);
    return `<span class="ch-badge" style="--c:${info ? info[2] : '#6C717B'}">${esc(info ? info[1] : (c.bank || '?').replace(/^ธนาคาร/, '').slice(0, 3))}</span>`;
  }

  async function saveChannels(list) {
    const s = biz().settings || {};
    await put('', { settings: { ...s, banks: list } });
    await loadBoot();
  }

  function editChannel(c, kind) {
    const isNew = !c;
    c = c || { kind, active: true, acctType: 'savings', bank: kind === 'bank' ? BANK_NAMES[0] : OTHER_KINDS[0] };
    const bank = c.kind !== 'other';
    const body = bank
      ? `<div class="form-rows">
          <label><span>ธนาคาร</span><select name="bank">${[...new Set([...BANK_NAMES, c.bank].filter(Boolean))].map((n) => `<option ${n === c.bank ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <label><span>เลขที่บัญชี</span><input type="text" name="number" inputmode="numeric" value="${esc(c.number || '')}" placeholder="123-4-56789-0"></label>
          <label><span>สาขาธนาคาร</span><input type="text" name="branch" value="${esc(c.branch || '')}"></label>
          <label><span>ชื่อบัญชี</span><input type="text" name="name" value="${esc(c.name || biz().name)}"></label>
          <div class="fr"><span>ประเภทบัญชี</span><div class="radios">${Object.entries(ACCT_TYPE).map(([k, l]) => `<label class="check"><input type="radio" name="acctType" value="${k}" ${(c.acctType || 'savings') === k ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
        </div>`
      : `<div class="form-rows">
          <label><span>ประเภท</span><select name="bank">${[...new Set([...OTHER_KINDS, c.bank].filter(Boolean))].map((n) => `<option ${n === c.bank ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <label><span>ชื่อผู้ให้บริการ</span><input type="text" name="name" value="${esc(c.name || '')}" placeholder="เช่น Stripe, 2C2P, Omise"></label>
          <label><span>รายละเอียด</span><input type="text" name="number" value="${esc(c.number || '')}" placeholder="เช่น ลิงก์ชำระเงิน หรือเลขบัญชีร้านค้า (ไม่บังคับ)"></label>
        </div>`;
    return dialog({
      title: `${isNew ? 'เพิ่ม' : 'แก้ไข'}${bank ? 'บัญชีธนาคาร' : 'ช่องทางชำระอื่นๆ'}`, body, ok: 'บันทึกและปิด',
      onOk: async (el) => {
        const d = formData(el);
        if (bank && !String(d.number || '').replace(/\D/g, '')) { toast('กรอกเลขที่บัญชี', true); return false; }
        if (!bank && !d.name) { toast('กรอกชื่อผู้ให้บริการ', true); return false; }
        const next = { ...c, ...d, number: bank ? fmtAcct(d.number) : d.number };
        const list = (biz().settings?.banks || []).map((x) => ({ ...x }));
        if (isNew) list.push(next); else list.splice(list.findIndex((x) => x.id === c.id), 1, next);
        await saveChannels(list);
        toast('บันทึกแล้ว');
        return true;
      },
    });
  }

  function viewChannels(main) {
    const list = biz().settings?.banks || [];
    const row = (c) => {
      const bank = c.kind !== 'other';
      const detail = bank
        ? `<div>ประเภทบัญชี: ${ACCT_TYPE[c.acctType] || ACCT_TYPE.savings}</div>${c.branch ? `<div>สาขา: ${esc(c.branch)}</div>` : ''}`
        : (c.number ? `<div>${esc(c.number)}</div>` : '');
      const on = c.active !== false;
      return `<tr data-id="${esc(c.id)}"${on ? '' : ' class="off"'}>
        <td class="nowrap">${bank ? 'บัญชีธนาคาร' : 'ช่องทางชำระอื่นๆ'}</td>
        <td><div class="ch-name">${channelBadge(c)}<div><div>${esc(bank ? `${c.bank} ${c.number}` : c.bank)}</div><div class="muted">${esc(c.name || '')}</div></div></div></td>
        <td class="muted ch-detail">${detail}</td>
        <td><label class="st ${on ? 'info' : ''} pick"><select data-active aria-label="สถานะ"><option value="1" ${on ? 'selected' : ''}>ใช้งานอยู่</option><option value="0" ${on ? '' : 'selected'}>ไม่ใช้งานแล้ว</option></select>${CHEV}</label></td>
        <td class="act"><button type="button" class="icon-btn" data-more aria-label="เพิ่มเติม">${DOTS}</button></td></tr>`;
    };
    // Listeners go on a fresh wrapper so a redraw doesn't stack them on <main>.
    main.innerHTML = `<div data-ch><div class="page-h"><div><div class="muted" style="font-size:13px"><a class="link" href="#/settings">ตั้งค่า</a> ›</div><h1>ช่องทางการเงิน</h1><div class="sub">บัญชีธนาคารและช่องทางรับชำระที่ใช้อยู่จะพิมพ์ในใบเสนอราคาและใบแจ้งหนี้</div></div>
      <div class="actions"><div class="split"><button class="btn primary" data-add="bank">${ICON.plus}เพิ่มบัญชี</button><button class="btn primary" data-addmenu aria-label="เลือกประเภท">${CHEV}</button></div></div></div>
      <div class="card"><div class="tbl-wrap"><table class="tbl ch-tbl"><thead><tr><th>ประเภท</th><th>ชื่อบัญชี</th><th>รายละเอียดเพิ่มเติม</th><th>สถานะ</th><th></th></tr></thead>
      <tbody>${list.length ? list.map(row).join('') : `<tr><td colspan="5"><div class="empty"><b>ยังไม่มีช่องทางการเงิน</b>เพิ่มบัญชีธนาคารเพื่อให้ลูกค้าโอนเงินตามใบแจ้งหนี้<div style="margin-top:12px"><button class="btn primary" data-add="bank">${ICON.plus}เพิ่มบัญชีธนาคาร</button></div></div></td></tr>`}</tbody></table></div></div>
      ${biz().settings?.promptpay?.id ? '' : '<p class="muted" style="font-size:13px">ตั้งพร้อมเพย์เพื่อพิมพ์ QR รับเงินในใบแจ้งหนี้ได้ที่ <a class="link" href="#/settings">ตั้งค่า › รับชำระเงิน</a></p>'}</div>`;
    const root = $('[data-ch]', main);
    const redraw = () => viewChannels(main);
    const byId = (id) => (biz().settings?.banks || []).find((x) => x.id === id);
    root.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) return editChannel(null, add.dataset.add).then((r) => r && redraw());
      const am = e.target.closest('[data-addmenu]');
      if (am) return popMenu(am, [['บัญชีธนาคาร', () => editChannel(null, 'bank').then((r) => r && redraw())], ['ช่องทางชำระอื่นๆ', () => editChannel(null, 'other').then((r) => r && redraw())]]);
      const more = e.target.closest('[data-more]');
      if (more) {
        const c = byId(more.closest('tr').dataset.id);
        popMenu(more, [['แก้ไข', () => editChannel(c).then((r) => r && redraw())], null, ['ลบ', async () => {
          if (!(await confirmBox('ลบช่องทางการเงิน', `ลบ ${esc(c.bank)} ${esc(c.number || c.name || '')} ออกจากรายการ? เอกสารที่ออกไปแล้วไม่เปลี่ยน`, 'ลบ'))) return;
          try { await saveChannels((biz().settings?.banks || []).filter((x) => x.id !== c.id)); toast('ลบแล้ว'); redraw(); } catch (err) { fail(err); }
        }, { danger: true }]]);
      }
    });
    root.addEventListener('change', async (e) => {
      if (!e.target.matches('[data-active]')) return;
      const id = e.target.closest('tr').dataset.id;
      try {
        await saveChannels((biz().settings?.banks || []).map((x) => (x.id === id ? { ...x, active: e.target.value === '1' } : x)));
        toast(e.target.value === '1' ? 'เปิดใช้งานแล้ว' : 'ปิดการใช้งานแล้ว'); redraw();
      } catch (err) { fail(err); redraw(); }
    });
  }

  async function viewIntegrations(main, which) {
    if (which === 'capcourt') return viewCapcourt(main);
    const { integration: cc } = await get('/integrations/capcourt');
    main.innerHTML = `<div class="page-h"><div><h1>เชื่อมต่อระบบ</h1><div class="sub">ให้ระบบอื่นออกเอกสารในกิจการนี้ให้อัตโนมัติ</div></div></div>
      <div class="grid" style="max-width:860px">
        <a class="card card-pad int-card" href="#/integrations/capcourt">${CC_LOGO}<div style="flex:1"><h2 style="margin:0 0 2px">CapCourt Admin</h2>
          <div class="muted">ออกใบแจ้งหนี้รายเดือนให้สนามที่ใช้บริการ CapCourt อัตโนมัติทุกวันที่ 1 ออกใบเสร็จ/ใบกำกับภาษีเมื่ออนุมัติการชำระ แล้วแจ้งผลกลับไปที่ CapCourt</div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${cc ? `<span class="chip good">เชื่อมต่อแล้ว</span><span class="chip">${esc(cc.base_url.replace(/^https?:\/\//, ''))}</span><span class="chip">${cc.settings.venues.length} สนาม</span>` : '<span class="chip">ยังไม่เชื่อมต่อ</span>'}</div></div><span class="muted nowrap">ตั้งค่า ›</span></a>
      </div>`;
  }

  async function viewCapcourt(main) {
    const { integration: cc, history } = await get('/integrations/capcourt');
    const head = `<div class="page-h"><div><div class="muted" style="font-size:13px"><a class="link" href="#/integrations">เชื่อมต่อระบบ</a> ›</div><h1>CapCourt Admin</h1><div class="sub">บิลค่าบริการรายเดือนของ CapCourt ออกเป็นใบแจ้งหนี้ของกิจการนี้</div></div>
      <div class="actions">${cc ? '<button class="btn" data-sync>ดึงบิลตอนนี้</button><button class="btn primary" data-save>บันทึก</button>' : ''}</div></div>`;
    const keyFields = (connected) => `<div class="grid g2">
          <label class="field span2"><span>ที่อยู่หลังบ้าน CapCourt</span><input type="text" data-cc="base_url" value="${esc(cc?.base_url || 'https://admin.capcourt.com')}"></label>
          <label class="field span2"><span>รหัสเชื่อมต่อ Centel (จาก CapCourt)</span><input type="text" data-cc="api_key" autocomplete="off" spellcheck="false" placeholder="${connected ? `ccb_…${esc(cc.key_suffix)} (วางรหัสใหม่เพื่อเปลี่ยน)` : 'ccb_…'}">
            <small>สร้างที่ admin.capcourt.com → Billing สนาม → Centel Account → สร้างรหัสเชื่อมต่อ แล้ววางที่นี่ รหัสนี้อ่านบิลของทุกสนาม และแจ้งเลขเอกสารกับการชำระเงินกลับได้เท่านั้น</small></label>
        </div>`;
    if (!cc) {
      main.innerHTML = `${head}<div class="grid" style="max-width:860px"><div class="card card-pad"><h2>เชื่อมต่อ CapCourt</h2>${keyFields(false)}
        <div class="actions" style="margin-top:14px"><button class="btn primary" data-connect>เชื่อมต่อ</button></div></div>${ccHow()}</div>`;
      $('[data-connect]', main).onclick = async (e) => {
        e.target.disabled = true;
        try {
          await put('/integrations/capcourt', { base_url: $('[data-cc=base_url]', main).value, api_key: $('[data-cc=api_key]', main).value.trim() });
          toast('เชื่อมต่อแล้ว กำลังดึงบิล…');
          const { result } = await post('/integrations/capcourt/sync');
          ccToast(result);
          await loadBoot();
          render();
        } catch (err) { fail(err); e.target.disabled = false; }
      };
      return;
    }
    const s = cc.settings;
    const items = S.boot.items.filter((i) => !i.archived);
    const customers = S.boot.contacts.filter((c) => !c.archived && c.kind !== 'vendor');
    const r = cc.last_result;
    main.innerHTML = `${head}
      <div class="grid" style="max-width:860px">
        <div class="card card-pad int-status">${CC_LOGO}<div style="flex:1;min-width:200px"><b>${cc.last_error ? 'เชื่อมต่อไม่สำเร็จ' : 'เชื่อมต่อแล้ว'}</b> <span class="chip ${cc.last_error ? 'bad' : 'good'}">${cc.last_error ? esc(ERR[cc.last_error] || cc.last_error) : 'ทำงานอยู่'}</span>
          <div class="muted" style="font-size:13px;margin-top:2px">${cc.last_sync_at ? `ดึงบิลล่าสุด ${thDateTime(cc.last_sync_at)}${r ? ` · ออกใหม่ ${r.created} ใบ · แจ้ง CapCourt ${r.reported} รายการ` : ''}` : 'ยังไม่เคยดึงบิล'} · ดึงอัตโนมัติทุกชั่วโมง (CapCourt ออกบิลวันที่ 1 หลัง 06:00)</div></div>
          <button class="btn sm ghost danger" data-off>ตัดการเชื่อมต่อ</button></div>

        <div class="card card-pad"><h2>การออกเอกสาร</h2>
          <ol class="cc-flow">
            <li><b>วันที่ 1</b> CapCourt ออกบิลค่าบริการเดือนก่อน แล้วระบบนี้ออก<b>ใบแจ้งหนี้</b>ทันที ใช้ยอดตามที่ CapCourt คำนวณ วันที่เอกสารและวันครบกำหนดตามบิล CapCourt</li>
            <li>สนามเห็นปุ่ม "ชำระ / ดูใบแจ้งหนี้" ในหลังบ้านของสนาม ซึ่งเปิดลิงก์ใบแจ้งหนี้นี้ มี QR พร้อมเพย์ผูกยอดและ PDF</li>
            <li>ได้รับเงินแล้ว เปลี่ยนสถานะใบแจ้งหนี้เป็น <b>ชำระแล้ว</b> ระบบจะออก<b>ใบเสร็จรับเงิน/ใบกำกับภาษี</b>${biz().vat_registered ? '' : ' (กิจการนี้ยังไม่จด VAT จึงเป็นใบเสร็จรับเงินอย่างเดียว)'}</li>
            <li>บิลใน CapCourt และหน้าบิลของสนามเปลี่ยนเป็น "ชำระแล้ว" เอง ถ้า CapCourt ยกเลิกบิลที่ยังไม่ได้รับเงิน ใบแจ้งหนี้ที่นี่จะถูกยกเลิกด้วย</li>
          </ol></div>

        <div class="card card-pad"><h2>รายการในบิล → สินค้า / บริการ</h2><p class="muted" style="margin-top:0">ยอดเงินใช้ตามที่ CapCourt คำนวณ ส่วนนี้เลือกชื่อรายการและบัญชีรายได้ ไม่เลือกจะใช้ชื่อจาก CapCourt และบัญชีรายได้เริ่มต้น</p>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>รายการจาก CapCourt</th><th>สินค้า / บริการใน Centel</th></tr></thead><tbody>
          ${CC_KINDS.map(([k, label]) => `<tr><td><b>${label}</b><div class="muted" style="font-size:12px">${k}</div></td><td><select data-item="${k}"><option value="">ใช้ชื่อจาก CapCourt</option>${items.map((i) => `<option value="${i.id}" ${s.itemMap[k] === i.id ? 'selected' : ''}>${esc(i.sku ? `${i.sku} ` : '')}${esc(i.name)}${i.account ? ` · ${esc(i.account)}` : ''}</option>`).join('')}</select></td></tr>`).join('')}
          </tbody></table></div></div>

        <div class="card card-pad"><h2>สนาม → ลูกค้า</h2><p class="muted" style="margin-top:0">สนามใหม่จะถูกสร้างเป็นผู้ติดต่อให้เองจากข้อมูลใน CapCourt เพิ่มเลขผู้เสียภาษีและที่อยู่ของสนามที่หน้า <a class="link" href="#/contacts">ผู้ติดต่อ</a> ก่อนออกใบเสร็จ/ใบกำกับภาษี</p>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>สนามใน CapCourt</th><th>ลูกค้าใน Centel</th></tr></thead><tbody>
          ${s.venues.length ? s.venues.map((v) => `<tr><td><b>${esc(v.name)}</b><div class="muted" style="font-size:12px">${esc(v.code)}</div></td><td><select data-venue="${v.id}"><option value="">สร้างจากข้อมูลสนาม</option>${customers.map((c) => `<option value="${c.id}" ${s.venueMap[v.id] === c.id ? 'selected' : ''}>${esc(c.name)}${c.tax_id ? ` · ${esc(c.tax_id)}` : ' · ยังไม่มีเลขผู้เสียภาษี'}</option>`).join('')}</select></td></tr>`).join('')
            : '<tr><td colspan="2"><div class="empty">ยังไม่มีสนามที่ออกบิล สนามจะขึ้นที่นี่หลังดึงบิลครั้งแรก</div></td></tr>'}
          </tbody></table></div></div>

        <div class="card card-pad"><h2>การเชื่อมต่อ</h2>${keyFields(true)}</div>

        <div class="card card-pad"><h2>บิลที่ออกเป็นใบแจ้งหนี้แล้ว</h2>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>วันที่</th><th>บิล CapCourt</th><th>ลูกค้า</th><th class="num">ยอด</th><th>เอกสาร Centel</th></tr></thead><tbody>
          ${history.length ? history.map((h) => `<tr class="click" data-doc="${h.id}"><td class="nowrap">${T.thDate(h.date)}</td><td><span class="doc-no">${esc(h.ext_no)}</span></td><td>${esc(h.contact_name || '')}</td><td class="num"><b>${money(h.total)}</b></td>
            <td><span class="dot ${statusTone(h.status, 'IV')}"></span><span class="doc-no">${esc(h.number)}</span>${h.receipt ? ` → <span class="doc-no">${esc(h.receipt)}</span>` : ''}
              <div style="margin-top:4px"><span class="chip ${h.status === 'paid' ? 'good' : h.status === 'void' ? 'bad' : 'warn'}">${esc(T.statusName('IV', h.status))}</span>${h.status !== 'void' ? ` <span class="chip ${h.ext_reported && h.ext_reported !== 'issued' ? 'good' : h.ext_reported ? 'info' : ''}">${h.ext_reported?.startsWith('paid') ? 'แจ้ง CapCourt ว่าชำระแล้ว' : h.ext_reported ? 'แจ้งเลขที่ให้ CapCourt แล้ว' : 'รอแจ้ง CapCourt'}</span>` : ''}</div></td></tr>`).join('')
            : '<tr><td colspan="5"><div class="empty">ยังไม่มี</div></td></tr>'}
          </tbody></table></div></div>
      </div>`;
    main.addEventListener('click', (e) => { const tr = e.target.closest('[data-doc]'); if (tr) location.hash = `#/doc/${tr.dataset.doc}`; });
    $('[data-sync]', main).onclick = async (e) => {
      e.target.disabled = true;
      try { ccToast((await post('/integrations/capcourt/sync')).result); await loadBoot(); render(); } catch (err) { fail(err); e.target.disabled = false; }
    };
    $('[data-save]', main).onclick = async (e) => {
      const itemMap = {}; $$('[data-item]', main).forEach((x) => { if (x.value) itemMap[x.dataset.item] = x.value; });
      const venueMap = {}; $$('[data-venue]', main).forEach((x) => { if (x.value) venueMap[x.dataset.venue] = x.value; });
      const key = $('[data-cc=api_key]', main).value.trim();
      e.target.disabled = true;
      try {
        await put('/integrations/capcourt', { base_url: $('[data-cc=base_url]', main).value, ...(key ? { api_key: key } : {}), itemMap, venueMap });
        toast('บันทึกแล้ว'); render();
      } catch (err) { fail(err); e.target.disabled = false; }
    };
    $('[data-off]', main).onclick = async () => {
      if (!await dialog({ title: 'ตัดการเชื่อมต่อ CapCourt', body: '<p style="margin-top:0">ระบบจะหยุดดึงบิลและหยุดแจ้งผลการชำระ ใบแจ้งหนี้ที่ออกไปแล้วยังอยู่ครบ เชื่อมต่อใหม่ได้ทุกเมื่อด้วยรหัสจาก CapCourt</p>', ok: 'ตัดการเชื่อมต่อ', danger: true, onOk: () => true })) return;
      try { await api('DELETE', A('/integrations/capcourt')); toast('ตัดการเชื่อมต่อแล้ว'); render(); } catch (err) { fail(err); }
    };
  }

  function ccHow() {
    return `<div class="card card-pad"><h2>ทำงานอย่างไร</h2><ol class="cc-flow">
      <li>CapCourt ออกบิลค่าบริการให้สนามทุกวันที่ 1 ระบบนี้ดึงมาออกเป็น<b>ใบแจ้งหนี้</b>ของกิจการนี้ทันที</li>
      <li>สนามเปิดดูและสแกน QR พร้อมเพย์จากลิงก์ใบแจ้งหนี้ได้</li>
      <li>เมื่ออนุมัติการชำระ ระบบออก<b>ใบเสร็จรับเงิน/ใบกำกับภาษี</b> และแจ้ง CapCourt ว่าชำระแล้ว</li></ol></div>`;
  }

  function ccToast(r) {
    if (!r) return;
    if (r.errors?.length && !r.created.length && !r.reported) return toast(ERR[r.errors[0]] || `ดึงบิลไม่สำเร็จ: ${r.errors[0]}`, true);
    toast(r.created.length || r.reported || r.voided.length
      ? [r.created.length ? `ออกใบแจ้งหนี้ใหม่ ${r.created.length} ใบ` : '', r.reported ? `แจ้ง CapCourt ${r.reported} รายการ` : '', r.voided.length ? `ยกเลิก ${r.voided.length} ใบ` : ''].filter(Boolean).join(' · ')
      : 'ไม่มีบิลใหม่');
  }

  /* ---------- Start ---------- */

  /* ---------- Users: profile, users of the business, invites ---------- */

  // The four areas a position reaches (server/src/acc/users.js), with their badge colour.
  const AREAS = [
    ['sales', 'รายรับ', 'ใบเสนอราคา ใบแจ้งหนี้ ใบเสร็จรับเงิน', '#2F7BEA', '<path d="M4 17l5-5 4 4 7-8"/><path d="M15 8h5v5"/>'],
    ['purchase', 'รายจ่าย', 'ค่าใช้จ่าย สแกนบิล จ่ายเงิน', '#1F9D6B', '<path d="M12 4v16M17 8H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H6"/>'],
    ['accounting', 'บัญชีและรายงาน', 'หน้าหลัก สมุดรายวัน ผังบัญชี รายงานภาษีและงบการเงิน', '#E5484D', '<path d="M7 9h10M7 15h10"/>'],
    ['settings', 'ตั้งค่ากิจการ', 'ข้อมูลกิจการ รูปแบบเอกสาร การเชื่อมต่อระบบ', '#3EA8E0', '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"/>'],
  ];
  const LEVEL = ['ไม่มีสิทธิ์', 'ดูอย่างเดียว', 'ดูและแก้ไข'];
  const areaBadges = (p) => `<span class="perm-badges">${AREAS.filter(([k]) => p[k] > 0).map(([k, name, , color, path]) => `<span class="perm-b${p[k] === 1 ? ' ro' : ''}" style="--c:${color}" title="${esc(name)}: ${LEVEL[p[k]]}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>`).join('') || '<span class="muted">—</span>'}</span>`;
  // Emails and names are masked on the list until "แสดงข้อมูล" is on (someone may be looking at the screen).
  const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 1)}${'*'.repeat(Math.max(3, u.length - 1))}@${d}` : esc(e || ''); };
  const maskName = (n) => String(n || '').split(' ').filter(Boolean).map((w) => `${[...w][0]}${'*'.repeat(Math.max(2, [...w].length - 1))}`).join(' ');
  const permTable = (p) => `<table class="tbl perm-tbl"><tbody>${AREAS.map(([k, name, desc]) => `<tr><td><b>${esc(name)}</b><div class="muted" style="font-size:12px">${esc(desc)}</div></td><td class="nowrap">${p[k] === 2 ? '<span class="chip good">ดูและแก้ไข</span>' : p[k] === 1 ? '<span class="chip info">ดูอย่างเดียว</span>' : '<span class="chip">ไม่มีสิทธิ์</span>'}</td></tr>`).join('')}</tbody></table>`;
  const permPickers = (p, locked) => `<div class="perm-pick">${AREAS.map(([k, name, desc, color, path]) => `<label class="perm-row"><span class="perm-b" style="--c:${color}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>
    <span class="perm-t"><b>${esc(name)}</b><small>${esc(desc)}</small></span>
    <select data-perm="${k}" ${locked ? 'disabled' : ''}>${LEVEL.map((l, i) => `<option value="${i}" ${p[k] === i ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`).join('')}</div>`;
  const readPerms = (el) => Object.fromEntries($$('[data-perm]', el).map((x) => [x.dataset.perm, Number(x.value)]));

  function rolesDialog(roles) {
    return dialog({
      title: 'รายละเอียดแต่ละตำแหน่ง', wide: true, ok: '', cancel: 'ปิด',
      body: `<p class="muted" style="margin-top:0">สิทธิ์เริ่มต้นของแต่ละตำแหน่ง ปรับเพิ่มหรือลดให้แต่ละคนได้ตอนเชิญหรือแก้ไขภายหลัง เฉพาะเจ้าของกิจการเท่านั้นที่เพิ่มและจัดการผู้ใช้งานได้</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>ตำแหน่ง</th>${AREAS.map(([, n]) => `<th>${esc(n)}</th>`).join('')}</tr></thead>
        <tbody>${roles.map((r) => `<tr><td class="nowrap"><b>${esc(r.name)}</b></td>${AREAS.map(([k]) => `<td class="nowrap">${r.perms[k] === 2 ? '<span class="chip good">แก้ไข</span>' : r.perms[k] === 1 ? '<span class="chip info">ดู</span>' : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
    });
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => toast('คัดลอกลิงก์แล้ว'), () => prompt('คัดลอกลิงก์นี้', text));
    prompt('คัดลอกลิงก์นี้', text);
    return Promise.resolve();
  }

  // After an invite: the link to send, by email (their mail app), LINE or copy.
  function inviteSent(email, roleName, link) {
    const b = biz();
    const subject = `เชิญเข้าร่วม ${b.name} บน Centel Account`;
    const body = `สวัสดีครับ/ค่ะ\n\nคุณได้รับเชิญให้เข้าใช้งานระบบบัญชีของ ${b.name} ในตำแหน่ง ${roleName}\n\nกดลิงก์นี้แล้วเข้าสู่ระบบหรือสมัครด้วยอีเมล ${email}\n${link}\n\nลิงก์ใช้ได้ 14 วัน`;
    return dialog({
      title: 'สร้างคำเชิญแล้ว', ok: '', cancel: 'เสร็จสิ้น',
      body: `<p style="margin-top:0">ส่งลิงก์นี้ให้ <b>${esc(email)}</b> เพื่อเข้าร่วมเป็น <b>${esc(roleName)}</b> ลิงก์ใช้ได้กับอีเมลนี้เท่านั้น และหมดอายุใน 14 วัน</p>
        <div class="invite-link"><input type="text" readonly value="${esc(link)}" data-link><button class="btn" data-copy>คัดลอก</button></div>
        <div class="actions" style="margin-top:12px">
          <a class="btn primary" href="mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}">ส่งทางอีเมล</a>
          <a class="btn" target="_blank" rel="noopener" href="https://line.me/R/share?text=${encodeURIComponent(`${subject}\n${link}`)}">ส่งทาง LINE</a></div>
        <p class="muted" style="font-size:12px;margin-bottom:0">ถ้าคนนี้เข้าสู่ระบบ Centel ด้วยอีเมลเดียวกันอยู่แล้ว จะเห็นคำเชิญเองทันทีโดยไม่ต้องกดลิงก์</p>`,
      onOpen: (el) => {
        $('[data-copy]', el).onclick = () => copyText(link);
        $('[data-link]', el).onfocus = (e) => e.target.select();
      },
    });
  }

  async function viewUsers(main) {
    const d = await get('/members');
    let show = false;
    const draw = () => {
      const rows = [
        ...d.members.map((m) => `<tr data-u="${m.user_id}">
          <td><div class="u-cell"><span class="u-ic">${ICON.user}</span><div><div>${show ? esc(m.email) : maskEmail(m.email)}${m.me ? ' <span class="chip">คุณ</span>' : ''}</div><div class="muted" style="font-size:12px">${esc(show ? m.name : maskName(m.name))}</div></div></div></td>
          <td>${esc(m.role_name)}${m.primary ? ' <span class="chip info crown">♛ เจ้าของหลัก</span>' : ''}${m.custom ? ' <span class="muted" style="font-size:12px">(ปรับสิทธิ์)</span>' : ''}</td>
          <td class="nowrap">${m.disabled ? '<span class="chip bad">ระงับการใช้งาน</span>' : 'ปกติ'}<div class="u-ok">✓ ยืนยันแล้ว</div></td>
          <td>${areaBadges(m.perms)}</td>
          <td class="act">${(d.can_manage && !m.primary) || (m.me && !m.primary) ? `<button class="icon-btn" data-more aria-label="เพิ่มเติม">${DOTS}</button>` : ''}</td></tr>`),
        ...d.invites.map((i) => `<tr data-inv="${i.id}">
          <td><div class="u-cell"><span class="u-ic pend">${ICON.user}</span><div><div>${show ? esc(i.email) : maskEmail(i.email)}</div><div class="muted" style="font-size:12px">ส่งคำเชิญ ${T.thDate(String(i.created_at).slice(0, 10))}</div></div></div></td>
          <td>${esc(i.role_name)}</td>
          <td class="nowrap">${i.expired ? '<span class="chip bad">คำเชิญหมดอายุ</span>' : '<span class="chip warn">รอตอบรับคำเชิญ</span>'}</td>
          <td>${areaBadges(i.perms)}</td>
          <td class="act"><button class="icon-btn" data-more aria-label="เพิ่มเติม">${DOTS}</button></td></tr>`),
      ];
      main.innerHTML = `<div class="page-h"><div><h1>ผู้ใช้งานในระบบ</h1><div class="sub">ผู้ใช้งานใน${esc(biz().name)} · ${d.members.length} คน${d.invites.length ? ` · รอตอบรับ ${d.invites.length}` : ''}</div></div>
        <div class="actions"><button class="btn ghost" data-show>${show ? 'ซ่อนข้อมูล' : 'แสดงข้อมูล'}</button><button class="btn ghost" data-roles>รายละเอียดแต่ละตำแหน่ง</button>${d.can_manage ? `<a class="btn primary" href="#/users/new">${ICON.plus}เพิ่มผู้ใช้งาน</a>` : ''}</div></div>
        <div class="card"><div class="tbl-wrap"><table class="tbl users-tbl"><thead><tr><th>อีเมลที่ใช้งานในระบบ / ชื่อนามสกุล</th><th>ตำแหน่ง</th><th>สถานะ</th><th>สิทธิ์การเข้าถึง</th><th></th></tr></thead>
        <tbody>${rows.join('')}</tbody></table></div></div>
        <p class="muted perm-legend">${AREAS.map(([k, n]) => `<span class="nowrap">${areaBadges({ [k]: 2 })} ${esc(n)}</span>`).join('')}<span class="nowrap">สีจาง = ดูอย่างเดียว</span></p>`;
    };
    draw();
    const reload = async () => { Object.assign(d, await get('/members')); draw(); };
    main.addEventListener('click', async (e) => {
      if (e.target.closest('[data-show]')) { show = !show; draw(); return; }
      if (e.target.closest('[data-roles]')) { rolesDialog(d.roles); return; }
      const more = e.target.closest('[data-more]');
      if (!more) return;
      const tr = more.closest('tr');
      const m = d.members.find((x) => x.user_id === tr.dataset.u);
      const inv = d.invites.find((x) => x.id === tr.dataset.inv);
      const items = [];
      if (inv) {
        items.push(['สร้างลิงก์เชิญใหม่', async () => { try { const r = await post(`/invites/${inv.id}/link`); await reload(); inviteSent(inv.email, inv.role_name, r.link); } catch (err) { fail(err); } }]);
        items.push(null, ['ยกเลิกคำเชิญ', async () => {
          if (!await confirmBox('ยกเลิกคำเชิญ', `ลิงก์ที่ส่งให้ ${esc(inv.email)} จะใช้ไม่ได้อีก`)) return;
          try { await api('DELETE', A(`/invites/${inv.id}`)); await reload(); toast('ยกเลิกคำเชิญแล้ว'); } catch (err) { fail(err); }
        }, { danger: true }]);
      } else if (m && d.can_manage && !m.me) {
        items.push(['แก้ไขตำแหน่งและสิทธิ์', () => editMember(m, d.roles).then((ok) => ok && reload())]);
        items.push([m.disabled ? 'เปิดใช้งานอีกครั้ง' : 'ระงับการใช้งาน', async () => {
          if (!m.disabled && !await confirmBox('ระงับการใช้งาน', `${esc(m.email)} จะเข้ากิจการนี้ไม่ได้จนกว่าจะเปิดใช้งานอีกครั้ง`, 'ระงับ')) return;
          try { await put(`/members/${m.user_id}`, { role: m.role, perms: m.perms, disabled: !m.disabled }); await reload(); } catch (err) { fail(err); }
        }]);
        items.push(null, ['ลบออกจากกิจการ', async () => {
          if (!await confirmBox('ลบผู้ใช้งาน', `ลบ ${esc(m.email)} ออกจาก${esc(biz().name)} เอกสารที่คนนี้สร้างไว้ยังอยู่ครบ`, 'ลบ')) return;
          try { await api('DELETE', A(`/members/${m.user_id}`)); await reload(); toast('ลบผู้ใช้งานแล้ว'); } catch (err) { fail(err); }
        }, { danger: true }]);
      } else if (m && m.me) {
        items.push(['ออกจากกิจการนี้', () => leaveBusiness()]);
      }
      if (items.length) popMenu(more, items);
    });
  }

  async function editMember(m, roles) {
    return dialog({
      title: 'แก้ไขตำแหน่งและสิทธิ์',
      body: `<p class="muted" style="margin-top:0">${esc(m.email)}${m.name ? ` · ${esc(m.name)}` : ''}</p>
        <label class="field"><span>ตำแหน่ง</span><select data-role>${roles.map((r) => `<option value="${r.key}" ${r.key === m.role ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <div class="field" style="margin-top:14px"><span>สิทธิ์การเข้าถึง</span><div data-pp>${permPickers(m.perms, m.role === 'owner')}</div></div>`,
      onOpen: (el) => {
        $('[data-role]', el).onchange = (e) => { const r = roles.find((x) => x.key === e.target.value); $('[data-pp]', el).innerHTML = permPickers(r.perms, r.key === 'owner'); };
      },
      onOk: async (el) => {
        await put(`/members/${m.user_id}`, { role: $('[data-role]', el).value, perms: readPerms(el) });
        toast('บันทึกแล้ว');
        return true;
      },
    });
  }

  async function leaveBusiness() {
    if (!await confirmBox('ออกจากกิจการ', `คุณจะเข้า${esc(biz().name)}ไม่ได้อีกจนกว่าเจ้าของจะเชิญใหม่`, 'ออกจากกิจการ')) return;
    try {
      const me = (await get('/members')).members.find((x) => x.me);
      await api('DELETE', A(`/members/${me.user_id}`));
      store.set('acc.biz', '');
      location.hash = '#/';
      start();
    } catch (err) { fail(err); }
  }

  async function viewInvite(main) {
    const d = await get('/members');
    if (!d.can_manage) { main.innerHTML = '<div class="empty"><b>เฉพาะเจ้าของกิจการเท่านั้นที่เพิ่มผู้ใช้งานได้</b></div>'; return; }
    main.innerHTML = `<div class="page-h"><div><a href="#/users" class="muted" style="text-decoration:none;font-size:13px">‹ หน้าผู้ใช้งานในกิจการทั้งหมด</a><h1>เพิ่มผู้ใช้งาน</h1></div>
      <div class="actions"><a class="btn" href="#/users">ยกเลิก</a><button class="btn primary" data-send>ส่งคำเชิญผู้ใช้งาน</button></div></div>
      <div class="card card-pad" style="max-width:760px"><h2>เชิญผู้ใช้งานในระบบใหม่</h2>
        <p class="muted" style="margin-top:0">ระบุอีเมลและเลือกตำแหน่งเพื่อเชิญและเพิ่มผู้ใช้งาน</p>
        <div class="grid g2">
          <label class="field span2"><span>อีเมลผู้ใช้งาน</span><input type="email" data-email autocomplete="off" placeholder="name@example.com"></label>
          <label class="field span2"><span>ตำแหน่ง <a href="#" class="link" data-roles style="float:right;font-weight:400">รายละเอียดแต่ละตำแหน่ง</a></span>
            <select data-role><option value="">กรุณาเลือกตำแหน่ง</option>${d.roles.map((r) => `<option value="${r.key}">${esc(r.name)}</option>`).join('')}</select></label>
        </div>
        <div class="field" style="margin-top:16px" data-pwrap hidden><span>สิทธิ์การเข้าถึง <small class="muted">ปรับได้ตามต้องการ</small></span><div data-pp></div></div>
      </div>`;
    const roleSel = $('[data-role]', main);
    roleSel.onchange = () => {
      const r = d.roles.find((x) => x.key === roleSel.value);
      $('[data-pwrap]', main).hidden = !r;
      if (r) $('[data-pp]', main).innerHTML = permPickers(r.perms, r.key === 'owner');
    };
    $('[data-roles]', main).onclick = (e) => { e.preventDefault(); rolesDialog(d.roles); };
    $('[data-send]', main).onclick = async (e) => {
      const btn = e.currentTarget;
      const email = $('[data-email]', main).value.trim();
      const role = roleSel.value;
      if (!email) { toast('กรุณากรอกอีเมล', true); return; }
      if (!role) { toast('กรุณาเลือกตำแหน่ง', true); return; }
      btn.disabled = true;
      try {
        const r = await post('/members/invite', { email, role, perms: readPerms(main) });
        location.hash = '#/users';
        inviteSent(email.toLowerCase(), d.roles.find((x) => x.key === role).name, r.link);
      } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
  }

  async function viewProfile(main) {
    const { profile: p } = await api('GET', '/acc/me');
    const members = await get('/members').catch(() => null);
    const me = members?.members.find((x) => x.me);
    let sig = p.signature || null;
    let sigName = sig ? 'ลายเซ็น.png' : '';
    main.innerHTML = `<div class="page-h"><div><h1>ข้อมูลส่วนตัว</h1><div class="sub">ใช้กับทุกกิจการในบัญชีนี้</div></div><div class="actions"><button class="btn primary" data-save>บันทึก</button></div></div>
      <div class="grid" style="max-width:760px">
        <div class="card card-pad"><h2>ข้อมูลส่วนตัว</h2>
          <div class="form-rows">
            <label class="frow"><span>ชื่อ</span><input type="text" name="first_name" value="${esc(p.first_name || '')}" placeholder="${esc((p.display_name || '').split(' ')[0] || '')}"></label>
            <label class="frow"><span>นามสกุล</span><input type="text" name="last_name" value="${esc(p.last_name || '')}"></label>
            <label class="frow"><span>เบอร์ติดต่อ</span><input type="tel" name="phone" value="${esc(p.phone || '')}"></label>
            <div class="frow"><span>อีเมล (ผู้ใช้ระบบ)</span><div class="frow-v"><input type="email" value="${esc(p.email || '')}" disabled><span class="u-ok nowrap">✓ ยืนยันแล้ว</span></div></div>
            <div class="frow"><span>ตำแหน่ง</span><div><input type="text" value="${esc(me?.role_name || S.boot.role || '')}" disabled>
              ${me ? `<details class="perm-mine"><summary class="link">ดูรายละเอียดสิทธิ์ของตนเอง</summary>${permTable(me.perms)}</details>` : ''}</div></div>
          </div></div>
        <div class="card card-pad"><h2>ลายเซ็นอิเล็กทรอนิกส์</h2>
          <p class="muted" style="margin-top:0">ใส่ในช่องลงนามของกิจการ บนเอกสารที่คุณเป็นผู้ออก (เมื่อเปิด "ลายเซ็นและตราประทับ") ถ้ายังไม่มี ระบบใช้ลายเซ็นของกิจการในหน้าตั้งค่า ถ่ายรูปลายเซ็นบนกระดาษขาวได้ ระบบลบพื้นหลังให้</p>
          <div class="frow"><span>แนบไฟล์ลายเซ็น</span><div>
            <div class="sig-box" data-sig>${sig ? `<img src="${esc(sig)}" alt="ลายเซ็น">` : '<button type="button" class="btn" data-up>อัปโหลดลายเซ็น</button>'}</div>
            <div class="sig-file" data-sf ${sig ? '' : 'hidden'}><span data-sn>${esc(sigName)}</span><button type="button" class="icon-btn" data-rm aria-label="เอาลายเซ็นออก">×</button></div>
            <small class="muted">*ขนาดภาพที่แนะนำ 400×140 px และขนาดไม่เกิน 3MB</small><input type="file" accept="image/*" hidden data-f></div></div>
        </div>
        ${me && !me.primary ? `<div class="card card-pad"><h2>ออกจากกิจการ</h2><p class="muted" style="margin-top:0">เลิกเป็นผู้ใช้งานของ${esc(biz().name)}</p><button class="btn danger" data-leave>ออกจากกิจการนี้</button></div>` : ''}
      </div>`;
    const f = $('[data-f]', main);
    const drawSig = () => {
      $('[data-sig]', main).innerHTML = sig ? `<img src="${esc(sig)}" alt="ลายเซ็น">` : '<button type="button" class="btn" data-up>อัปโหลดลายเซ็น</button>';
      $('[data-sf]', main).hidden = !sig;
      $('[data-sn]', main).textContent = sigName;
    };
    main.addEventListener('click', (e) => {
      if (e.target.closest('[data-up]') || (e.target.closest('[data-sig]') && sig)) { f.value = ''; f.click(); }
      if (e.target.closest('[data-rm]')) { sig = null; sigName = ''; drawSig(); }
      if (e.target.closest('[data-leave]')) leaveBusiness();
    });
    f.onchange = async () => {
      const file = f.files[0]; if (!file) return;
      if (file.size > 3 * 1024 * 1024) { toast('ไฟล์ใหญ่เกิน 3MB', true); return; }
      try { sig = await cleanMark(file); sigName = file.name; drawSig(); } catch { toast('อ่านรูปไม่ได้ ลองไฟล์ PNG หรือ JPG', true); }
    };
    $('[data-save]', main).onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const d = formData(main);
        await api('PUT', '/acc/me', { first_name: d.first_name, last_name: d.last_name, phone: d.phone, signature: sig });
        toast('บันทึกแล้ว');
      } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
  }

  // Invites to my email: join from a dialog (also shown when I have no business yet).
  async function showInvites(invites, first) {
    const joined = await dialog({
      title: 'คุณได้รับคำเชิญ', ok: '', cancel: first ? 'สร้างกิจการของตัวเอง' : 'ภายหลัง',
      body: `<div class="biz-list">${invites.map((i) => `<div class="inv-row">${i.logo ? `<img src="${esc(i.logo)}" width="36" height="36" style="object-fit:contain;border-radius:6px">` : `<span class="chip">${esc(i.business.slice(0, 2))}</span>`}
        <span style="flex:1"><b>${esc(i.business)}</b><br><small class="muted">${esc(i.role_name)}${i.invited_by ? ` · เชิญโดย ${esc(i.invited_by)}` : ''}</small></span>
        <button class="btn sm ghost" data-no="${i.id}">ปฏิเสธ</button><button class="btn sm primary" data-yes="${i.id}">เข้าร่วม</button></div>`).join('')}</div>`,
      onOpen: (el, close) => el.addEventListener('click', async (e) => {
        const yes = e.target.closest('[data-yes]'); const no = e.target.closest('[data-no]');
        try {
          if (yes) { const r = await api('POST', '/acc/invites/accept', { id: yes.dataset.yes }); close(r.business_id); }
          if (no) { await api('POST', `/acc/invites/${no.dataset.no}/decline`); no.closest('.inv-row').remove(); if (!$('.inv-row', el)) close(null); }
        } catch (err) { fail(err); }
      }),
    });
    return joined;
  }

  // #/invite/<token>: the link from an invite email.
  const inviteToken = () => { const m = location.hash.match(/^#\/invite\/([A-Za-z0-9_-]{32})/); return m ? m[1] : null; };

  async function start() {
    const token = inviteToken();
    const load = async () => { const r = await api('GET', '/acc/businesses'); S.user = r.user; S.businesses = r.businesses; };
    try {
      await load();
    } catch (e) {
      if (e.status === 401) return renderAuth(token);
      app.innerHTML = `<div class="boot">เชื่อมต่อไม่สำเร็จ: ${esc(e.message)}</div>`;
      return;
    }
    S.boot = null;
    if (token) {
      history.replaceState(null, '', '#/');
      try {
        const j = await api('POST', '/acc/invites/accept', { token });
        store.set('acc.biz', j.business_id);
        await load();
        toast('เข้าร่วมกิจการแล้ว');
      } catch (e) {
        app.innerHTML = '<div class="boot"></div>';
        await dialog({ title: 'เปิดคำเชิญไม่ได้', body: `<p style="margin:0">${esc(e.message)}</p><p class="muted">เข้าสู่ระบบอยู่ด้วย ${esc(S.user?.email || '')}</p>`, ok: '', cancel: 'ตกลง',
          extra: '<button class="btn" data-out>ออกจากระบบ</button>', onOpen: (el, close) => { $('[data-out]', el).onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); close(); location.hash = `#/invite/${token}`; renderAuth(token); }; } });
        if (!S.user) return;
      }
    }
    // Invites to my email I have not answered yet (asked once per invite unless I have no business).
    let invites = [];
    try { invites = (await api('GET', '/acc/invites')).invites; } catch { /* older api */ }
    const seen = (store.get('acc.invSeen') || '').split(',');
    const fresh = S.businesses.length ? invites.filter((i) => !seen.includes(i.id)) : invites;
    if (fresh.length) {
      store.set('acc.invSeen', [...seen, ...fresh.map((i) => i.id)].slice(-50).join(','));
      app.innerHTML = '<div class="boot"></div>';
      const joined = await showInvites(fresh, !S.businesses.length);
      if (joined) { store.set('acc.biz', joined); await load(); toast('เข้าร่วมกิจการแล้ว'); }
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
