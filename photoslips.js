'use strict';

/* Slips from Photos (iOS app only): ดึงสลิปจากรูปภาพ.
   Turned on in Account, the app checks new pictures in the iPhone's photo library whenever it
   comes to the front. The PhotoSlips plugin (App/PhotoSlips.swift) reads each picture's text
   on the phone with Apple's Vision and says which look like slips (a money amount, many
   numbers, slip words or a QR code). Only those are sent to AI Slips (/api/receipts, Claude
   Haiku). Each read slip waits in "สลิปรอยืนยัน" on Home: the person approves it as it is (✓),
   opens it to change the category, amount or anything else first, or drops it (✕).
   Nothing is added to the accounts until approved.
   Waiting slips are kept on this device per account (localStorage). Older app builds have no
   plugin, so nothing is shown. Loaded after app.js and share.js. */

(() => {
  const cap = window.Capacitor;
  const plugin = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.PhotoSlips;
  if (!plugin) return;

  const MAX_ITEMS = 60;
  const ps = { access: 'notDetermined', on: false, busy: false, found: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ready = () => isCloud() && cloud.user && cloud.features && cloud.features.storage;

  /* ---------- Waiting list (per account, on this device) ---------- */

  const storeKey = () => `centel.photoSlips.v1.${cloud.user ? cloud.user.id : 'local'}`;
  // { items: [{ id, key, created, status, r }], queue: [{ id, created }] }
  // items: read slips waiting for approval; queue: slips Vision found that are not read yet.
  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(storeKey()) || '{}');
      return { items: Array.isArray(v.items) ? v.items : [], queue: Array.isArray(v.queue) ? v.queue : [] };
    } catch (e) { return { items: [], queue: [] }; }
  }
  function store(v) {
    try { localStorage.setItem(storeKey(), JSON.stringify({ items: v.items.slice(-MAX_ITEMS), queue: v.queue.slice(-MAX_ITEMS) })); } catch (e) { /* full or private */ }
  }
  const items = () => load().items.sort((a, b) => (b.created || 0) - (a.created || 0));
  function drop(id) { const v = load(); v.items = v.items.filter((x) => x.id !== id); store(v); }

  const rerender = () => {
    if (ui.tab === 'home' || ui.tab === 'account') { const y = window.scrollY; render(); window.scrollTo(0, y); }
  };

  /* ---------- Finding and reading slips ---------- */

  async function refreshStatus() {
    try {
      const r = await plugin.status({ lang: LANG });
      ps.access = r.access; ps.on = !!r.on;
    } catch (e) { /* plugin failed: leave as is */ }
  }

  const known = (ref) => ref && (money.txns.some((t) => t.slipRef === ref) || load().items.some((x) => x.r && x.r.reference === ref));

  // Sends one picture Vision picked to AI Slips. -> true when done with it (kept or dropped).
  async function read(q) {
    let img;
    try { img = await plugin.image({ id: q.id }); } catch (e) { return true; }
    if (!img || !img.image) return true; // deleted from Photos since
    let res;
    try {
      res = await api('POST', '/receipts', { image: img.image, mediaType: 'image/jpeg', labels: money.labels.map((l) => l.name), categories: slipCats() });
    } catch (e) {
      return false; // offline or rate limited: try again next time
    }
    const x = res && res.result;
    // AI Slips found no amount: not a slip after all.
    if (!x || !(Number(x.amount) > 0)) return true;
    // Already saved (for example shared to Centel too) or already waiting.
    if (known(x.reference)) return true;
    const v = load();
    v.items.push({ id: q.id, key: res.key, created: q.created, status: res.status, r: x });
    store(v);
    ps.found += 1;
    return true;
  }

  async function run() {
    if (ps.busy || !ps.on || !ready()) return;
    if (ps.access !== 'authorized' && ps.access !== 'limited') return;
    ps.busy = true;
    ps.found = 0;
    try {
      for (let pass = 0; pass < 4; pass++) {
        const r = await plugin.scan({ max: 30 });
        if (r && Array.isArray(r.slips) && r.slips.length) {
          const v = load();
          r.slips.forEach((s) => { if (!v.queue.some((q) => q.id === s.id) && !v.items.some((x) => x.id === s.id)) v.queue.push({ id: s.id, created: s.created }); });
          store(v);
        }
        if (!r || !r.more) break;
      }
      // Read what is waiting, oldest first; stop at the first failure (no network) and keep the rest.
      for (const q of load().queue.slice()) {
        const done = await read(q);
        if (!done) break;
        const v = load(); v.queue = v.queue.filter((x) => x.id !== q.id); store(v);
      }
      if (ps.found) {
        toast(`พบสลิปใหม่ในรูปภาพ ${ps.found} รายการ รอยืนยันที่หน้าหลัก`);
        rerender();
      }
    } catch (e) {
      /* the plugin failed: try again next time */
    } finally {
      ps.busy = false;
    }
  }

  /* ---------- Approving ---------- */

  function labelIds(x) {
    return (x.labels || []).map((n) => (money.labels.find((l) => l.name === n) || {}).id).filter(Boolean);
  }
  const dateOf = (it) => {
    const today = dateStr(new Date());
    const d = it.r.date && it.r.date <= today ? it.r.date : dateStr(new Date(it.created || Date.now()));
    return d > today ? today : d;
  };
  function preset(it) {
    const x = it.r;
    const p = {
      type: 'expense', amount: Number(x.amount), category: x.category || '', merchant: x.merchant || '',
      note: x.note || '', date: dateOf(it), receiptKey: it.key, labels: labelIds(x),
    };
    if (x.reference) p.slipRef = x.reference;
    return p;
  }

  // ✓: saved as AI Slips read it, into the wallet used last.
  function approve(it) {
    const p = preset(it);
    const t = { id: newId(), type: 'expense', amount: p.amount, walletId: defaultWalletId(), date: p.date, note: p.note,
      scope: 'personal', labels: p.labels, category: p.category || null, merchant: p.merchant, reviewNeeded: false, receiptKey: p.receiptKey };
    if (p.slipRef) t.slipRef = p.slipRef;
    saveTxn(t);
    if (money.prefs.lastWallet !== t.walletId && t.walletId) { money.prefs.lastWallet = t.walletId; savePrefs(); }
    drop(it.id);
    toast('เพิ่มรายการแล้ว');
  }

  // Tap: the usual new-expense form, filled in; saving it approves the slip.
  function open(it) {
    closeSheet();
    txnForm(null, preset(it), {
      hint: `📷 สลิปจากรูปภาพ ${thDate(dateOf(it))} ตรวจหมวดหมู่และยอดเงิน แล้วกดบันทึก`,
      onSaved: () => drop(it.id),
    });
  }

  function row(it) {
    const x = it.r;
    const c = x.category ? catById(x.category) : null;
    const title = esc(x.merchant || (c ? c.label : 'ไม่ทราบร้าน'));
    const sub = [c ? esc(c.label) : '<span class="ps-nocat">ยังไม่มีหมวด</span>', thDate(dateOf(it))].join(' · ');
    return `
      <div class="item ps-item" data-ps-open="${esc(it.id)}" role="button" tabindex="0">
        ${circleIco(c || { color: '#8a8f99', icon: '🧾' })}
        <div class="main"><div class="name" translate="no">${title}</div><div class="sub">${sub}</div></div>
        <div class="right"><div class="amt exp">${baht(Number(x.amount))}</div></div>
        <div class="ps-acts">
          <button type="button" class="ps-btn no" data-ps-drop="${esc(it.id)}" aria-label="ไม่ใช่สลิป"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button>
          ${c ? `<button type="button" class="ps-btn ok" data-ps-ok="${esc(it.id)}" aria-label="ยืนยัน"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : '<span class="ps-btn gap"></span>'}
        </div>
      </div>`;
  }

  window.photoSlipsCard = () => {
    if (!ps.on && !items().length) return '';
    const list = items();
    if (!list.length) return '';
    return `
      <div class="section-row"><span>สลิปรอยืนยัน</span>${list.length > 3 ? `<button class="link-btn" data-ps-all>ดูทั้งหมด (${list.length})</button>` : ''}</div>
      <div class="card list-card ps-card">
        <div class="card-head"><span class="muted small">📷 จากรูปภาพในเครื่อง · แตะเพื่อแก้หมวดหมู่ก่อนบันทึก</span></div>
        ${list.slice(0, 3).map(row).join('')}
      </div>`;
  };

  function allSheet() {
    const list = items();
    if (!list.length) { closeSheet(); return; }
    openSheet(`<div class="sheet-head">${CLOSE_X}<h2>สลิปรอยืนยัน</h2><span style="width:40px"></span></div>
      <p class="hint">AI อ่านสลิปเหล่านี้จากรูปภาพในเครื่อง กด ✓ เพื่อบันทึกตามที่อ่านได้ แตะรายการเพื่อแก้หมวดหมู่ก่อน หรือ ✕ ถ้าไม่ใช่สลิป</p>
      <div class="card list-card ps-card">${list.map(row).join('')}</div>
      ${list.some((x) => x.r.category) ? '<button class="btn" data-ps-okall>✓ ยืนยันทุกรายการที่มีหมวดหมู่</button>' : ''}`);
    ps.sheet = true;
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    const find = (id) => items().find((x) => x.id === id);
    const after = () => { render(); if (ps.sheet && !$('#sheet').hidden) allSheet(); };
    const ok = t.closest('[data-ps-ok]');
    if (ok) { e.stopPropagation(); const it = find(ok.dataset.psOk); if (it) { approve(it); after(); } return; }
    const no = t.closest('[data-ps-drop]');
    if (no) { e.stopPropagation(); drop(no.dataset.psDrop); after(); return; }
    if (t.closest('[data-ps-okall]')) {
      const list = items().filter((x) => x.r.category);
      list.forEach(approve);
      toast(`เพิ่ม ${list.length} รายการแล้ว`);
      after();
      return;
    }
    if (t.closest('[data-ps-all]')) { allSheet(); return; }
    const op = t.closest('[data-ps-open]');
    if (op) { const it = find(op.dataset.psOpen); if (it) { ps.sheet = false; open(it); } }
  }, true);

  /* ---------- Account › ดึงสลิปจากรูปภาพ ---------- */

  window.photoSlipsRow = () => setRow({ set: 'photoslips', ico: '📷', color: '#ff9f0a', name: 'ดึงสลิปจากรูปภาพ',
    value: ps.on && (ps.access === 'authorized' || ps.access === 'limited') ? 'เปิดอยู่' : 'ปิดอยู่' });

  window.photoSlipsSettings = () => {
    const denied = ps.access === 'denied' || ps.access === 'restricted';
    let hint;
    if (!ready()) hint = 'ต้องเข้าสู่ระบบก่อน AI ถึงจะอ่านสลิปให้ได้';
    else if (denied) hint = 'METANG ยังไม่ได้รับสิทธิ์เข้าถึงรูปภาพ เปิดได้ที่ การตั้งค่า › METANG › รูปภาพ › รูปภาพทั้งหมด';
    else if (ps.on && ps.access === 'limited') hint = 'ตอนนี้ให้สิทธิ์เฉพาะบางรูป แอปจะเห็นเฉพาะรูปที่เลือกไว้ เลือก "รูปภาพทั้งหมด" ใน การตั้งค่า › METANG › รูปภาพ เพื่อให้เจอสลิปใหม่ทุกใบ';
    else hint = 'ตรวจรูปใหม่ในคลังรูปบนเครื่องนี้ต่อจากครั้งล่าสุด (ครั้งแรกเริ่มจาก 3 วันก่อนเปิดใช้) ทุกครั้งที่เปิดแอป และเป็นระยะตอนปิดแอปอยู่ตามที่ iOS อนุญาต (ส่วนใหญ่ตอนกลางคืนที่ชาร์จแบต) ถ้ารูปไหนมีตัวเลขเยอะและดูเป็นสลิปหรือใบเสร็จ จึงส่งให้ AI อ่าน แล้วรอให้คุณยืนยันที่หน้าหลัก รูปอื่นไม่ถูกส่งออกจากเครื่อง · เปิดแจ้งเตือนไว้เพื่อให้เด้งบอกเมื่อพบสลิปใหม่';
    return `
      <div class="form">
        <div class="field"><label for="psOn">ดึงสลิปจากรูปภาพ</label><span style="flex:1"></span>
          <label class="switch"><input type="checkbox" id="psOn" ${ps.on ? 'checked' : ''} ${ready() ? '' : 'disabled'}><span></span></label></div>
      </div>
      ${denied ? '<button class="btn ghost" id="psSettings">เปิดการตั้งค่า</button>' : ''}
      ${ps.on && !denied ? `<button class="btn ghost" id="psNow" ${ps.busy ? 'disabled' : ''}>${ps.busy ? 'กำลังตรวจรูป…' : '🔍 ตรวจรูปตอนนี้'}</button>` : ''}
      <p class="hint">${hint}</p>`;
  };

  window.photoSlipsBind = () => {
    const sw = $('#psOn');
    if (sw) sw.addEventListener('change', async (e) => {
      try {
        const r = e.target.checked ? await plugin.enable({ days: 3 }) : await plugin.disable();
        ps.access = r.access; ps.on = !!r.on;
        if (e.target.checked && !ps.on) toast('ต้องอนุญาตให้เข้าถึงรูปภาพก่อน');
      } catch (err) { toast('เปิดไม่สำเร็จ ลองใหม่อีกครั้ง'); }
      settingsSheet('photoslips', true);
      if (ps.on) { await run(); if (ui.setSheet === 'photoslips') settingsSheet('photoslips', true); }
    });
    const st = $('#psSettings');
    if (st) st.addEventListener('click', () => plugin.openSettings().catch(() => {}));
    const now = $('#psNow');
    if (now) now.addEventListener('click', async () => {
      const p = run();
      settingsSheet('photoslips', true);
      await p;
      if (ui.setSheet === 'photoslips') settingsSheet('photoslips', true);
      if (!ps.found) toast('ไม่พบสลิปใหม่');
    });
  };

  /* ---------- When to check ---------- */

  async function wake() {
    await refreshStatus();
    if (!ps.on) return;
    // Right after a cold start the account may still be loading.
    for (let i = 0; i < 40 && !ready(); i++) await sleep(250);
    run();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(wake, 800); });
  refreshStatus().then(() => { rerender(); setTimeout(wake, 1500); });
})();
