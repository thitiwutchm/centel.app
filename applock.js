'use strict';

/* Face ID lock (iOS app only): Account › ล็อกแอปด้วย Face ID.
   Ported from the UMAKER Portal app. The AppLock plugin (App/AppLock.swift) covers the page
   on a cold start and after more than a minute away until Face ID (or the iPhone passcode)
   unlocks it. This file is the switch, and tells the cover the theme colour and language so it
   matches the app. App builds older than 1.1 have no plugin: the row says to update instead.
   Loaded after app.js; renderSettings() calls appLockRow(). */

(() => {
  const cap = window.Capacitor;
  if (!(cap && cap.isNativePlatform && cap.isNativePlatform())) return;
  const plugin = cap.Plugins && cap.Plugins.AppLock;
  const al = { ready: !plugin, status: null, busy: false, note: null };

  const NAMES = { touchID: 'Touch ID', opticID: 'Optic ID' };
  const name = () => NAMES[al.status && al.status.biometry] || 'Face ID';

  const hex = (rgb) => {
    const m = String(rgb).match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return '';
    return '#' + m.slice(0, 3).map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('');
  };
  // The cover uses the selected tab's colour (as the native tab bar does) and the theme's dark/light.
  function look() {
    const active = document.querySelector('.tabbar [data-tab].active');
    return { accent: active ? hex(getComputedStyle(active).color) : '', theme: themeIsDark() ? 'dark' : 'light', language: LANG };
  }

  const rerender = () => {
    if (ui.tab !== 'account') return;
    const y = window.scrollY; render(); window.scrollTo(0, y);
  };

  async function refresh() {
    if (!plugin) return;
    try { al.status = await plugin.status(look()); } catch (e) { /* keep the last answer */ }
    al.ready = true;
  }

  window.appLockRow = () => {
    if (!al.ready) return '';
    if (!plugin) return setRow({ set: 'appver', ico: '🔒', color: '#34c759', name: 'ล็อกแอปด้วย Face ID', sub: 'อัปเดตแอปเป็นเวอร์ชันล่าสุดก่อน' });
    return setRow({ set: 'applock', ico: '🔒', color: '#34c759', name: `ล็อกแอปด้วย ${name()}`, value: al.status && al.status.enabled ? 'เปิดอยู่' : 'ปิดอยู่' });
  };

  window.appLockSettings = () => {
    const s = al.status || {};
    const n = name();
    const note = al.note
      ? `<p class="hint al-note" role="alert">${al.note.text}</p>${al.note.settings ? '<button class="btn ghost" id="alSettings">เปิดการตั้งค่า</button>' : ''}`
      : '';
    return `
      <div class="form">
        <div class="field"><label for="alOn">ล็อกแอปด้วย ${n}</label><span style="flex:1"></span>
          <label class="switch"><input type="checkbox" id="alOn" ${s.enabled ? 'checked' : ''} ${al.busy ? 'disabled' : ''}><span></span></label></div>
      </div>
      ${note}
      <p class="hint">${s.enabled
        ? `แอปล็อกเมื่อเปิดใหม่ หรือกลับมาหลังออกไปเกิน 1 นาที ถ้าสแกนไม่ผ่านใช้รหัสเครื่องแทนได้ · ตอนสลับแอป หน้าจอ METANG จะถูกซ่อนไว้ ไม่ให้เห็นยอดเงิน`
        : `ให้ METANG ล็อกไว้ และเปิดด้วย ${n} ทุกครั้งที่เปิดแอป หรือกลับมาหลังออกไปเกิน 1 นาที`}</p>`;
  };

  function failNote(code) {
    const n = name();
    if (code === 'denied') return { text: `METANG ยังไม่ได้รับสิทธิ์ใช้ ${n} เปิดได้ที่ การตั้งค่า › METANG › ${n}`, settings: true };
    if (code === 'not_enrolled') return { text: `ยังไม่ได้ตั้งค่า ${n} ในเครื่องนี้ ตั้งได้ที่ การตั้งค่า › ${n} และรหัส` };
    if (code === 'no_passcode') return { text: 'ตั้งรหัสเครื่องก่อน จึงจะใช้ Face ID ได้' };
    if (code === 'lockout') return { text: `${n} ถูกล็อกชั่วคราว ล็อกหน้าจอแล้วปลดด้วยรหัสเครื่อง แล้วลองใหม่` };
    if (code === 'unavailable') return { text: 'เครื่องนี้ไม่มี Face ID หรือ Touch ID' };
    return { text: `เปิด ${n} ไม่สำเร็จ ลองอีกครั้ง` };
  }

  window.appLockBind = () => {
    const sw = $('#alOn');
    if (sw) sw.addEventListener('change', async (e) => {
      if (al.busy) return;
      al.busy = true; al.note = null;
      try {
        al.status = e.target.checked ? await plugin.enable() : await plugin.disable();
        toast(al.status.enabled ? `เปิดล็อกด้วย ${name()} แล้ว` : 'ปิดล็อกแอปแล้ว');
      } catch (err) {
        const code = (err && (err.code || err.message)) || 'failed';
        if (code !== 'cancelled') al.note = failNote(code);
      } finally { al.busy = false; }
      settingsSheet('applock', true);
      rerender();
    });
    const st = $('#alSettings');
    if (st) st.addEventListener('click', () => plugin.openSettings().catch(() => {}));
  };

  // Keep the cover's colours in step with the theme and language (read when the app goes away).
  document.addEventListener('visibilitychange', () => { if (plugin && document.visibilityState === 'hidden') plugin.status(look()).catch(() => {}); });
  refresh().then(rerender);
})();
