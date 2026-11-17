'use strict';

/* App version and in-app update (iOS app only), ported from the UMAKER Portal app.
   The app's own version comes from @capacitor/app (App.getInfo), the newest Ad Hoc build from
   /install/build.json, written by ios-app/scripts/build-adhoc.sh next to Centel.ipa. Builds are
   numbered by time (yyyymmddHHMM), so a larger number is newer. When the server has a newer one:
   a card on Home (once per build) and Account › เวอร์ชันแอป offer "อัปเดต", the itms-services
   install link. iOS asks to install it over the app already there, which keeps the sign-in,
   the data and the settings. Loaded after app.js. */

(() => {
  const cap = window.Capacitor;
  if (!(cap && cap.isNativePlatform && cap.isNativePlatform())) return;
  const App = cap.Plugins && cap.Plugins.App;
  const INSTALL = 'itms-services://?action=download-manifest&url=' + encodeURIComponent('https://centel.app/install/manifest.plist');
  const SEEN_KEY = 'centel.appUpdate.seen';
  const CHECK_EVERY = 30 * 60 * 1000;
  const up = { installed: null, latest: null, newer: false, checked: false, at: 0 };

  const newer = (latest, installed) => {
    const a = Number(latest), b = Number(installed);
    return Number.isFinite(a) && Number.isFinite(b) ? a > b : latest !== installed && latest > installed;
  };
  const seen = () => { try { return localStorage.getItem(SEEN_KEY) || ''; } catch (e) { return ''; } };
  const markSeen = (build) => { try { localStorage.setItem(SEEN_KEY, build); } catch (e) { /* private mode */ } };

  const rerender = () => {
    if (ui.tab !== 'home' && ui.tab !== 'account') return;
    const y = window.scrollY; render(); window.scrollTo(0, y);
    if (ui.setSheet === 'appver' && !$('#sheet').hidden) settingsSheet('appver', true);
  };

  async function check(force) {
    if (!force && Date.now() - up.at < 60 * 1000) return;
    up.at = Date.now();
    const before = JSON.stringify([up.installed, up.latest]);
    try {
      const info = App ? await App.getInfo() : null;
      if (info && info.build) up.installed = { version: String(info.version || ''), build: String(info.build) };
    } catch (e) { /* older shell */ }
    try {
      const r = await fetch('/install/build.json', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (j && j.build) up.latest = { version: String(j.version || ''), build: String(j.build), created: j.created_at || '' }; }
    } catch (e) { /* offline */ }
    up.checked = true;
    up.newer = !!(up.installed && up.latest && newer(up.latest.build, up.installed.build));
    if (JSON.stringify([up.installed, up.latest]) !== before) rerender();
  }

  const label = (v) => (v ? `${v.version} (${v.build})` : '');

  window.appUpdateRow = () => setRow({
    set: 'appver', ico: '📲', color: '#636366', name: 'เวอร์ชันแอป',
    value: up.newer ? '<span class="set-dot bad"></span>มีเวอร์ชันใหม่' : up.installed ? esc(up.installed.version) : '',
  });

  window.appUpdateSettings = () => {
    const { installed, latest } = up;
    const rows = `
      <div class="card list-card au-card">
        <div class="item"><div class="main"><div class="name">เวอร์ชันในเครื่องนี้</div></div><span class="set-val" translate="no">${installed ? esc(label(installed)) : up.checked ? '–' : '…'}</span></div>
        <div class="item au-latest"><div class="main"><div class="name">เวอร์ชันล่าสุด</div></div><span class="set-val" translate="no">${latest ? esc(label(latest)) : up.checked ? '–' : '…'}</span></div>
      </div>`;
    if (up.newer) {
      return `${rows}
        <a class="btn" href="${INSTALL}" data-au-install>⬆️ อัปเดตแอป</a>
        <p class="hint">กด "อัปเดตแอป" แล้วเลือก "ติดตั้ง" แอปจะปิดไปและติดตั้งทับของเดิม รอไอคอน METANG บนหน้าจอโฮมโหลดจนเสร็จแล้วเปิดใหม่ ข้อมูลและการเข้าสู่ระบบยังอยู่ครบ</p>`;
    }
    return `${rows}
      <p class="hint">${installed && latest ? '✓ แอปเป็นเวอร์ชันล่าสุดแล้ว' : 'ตรวจเวอร์ชันไม่ได้ ลองอีกครั้งเมื่อต่ออินเทอร์เน็ต'} · ส่วนหน้าตาและฟีเจอร์ส่วนใหญ่อัปเดตเองทันทีโดยไม่ต้องติดตั้งใหม่</p>
      <button class="btn ghost" id="auCheck">ตรวจหาเวอร์ชันใหม่</button>`;
  };

  window.appUpdateBind = () => {
    const b = $('#auCheck');
    if (b) b.addEventListener('click', async () => {
      b.disabled = true;
      await check(true);
      settingsSheet('appver', true);
      if (!up.newer) toast(up.latest ? 'เป็นเวอร์ชันล่าสุดแล้ว' : 'ตรวจเวอร์ชันไม่ได้');
    });
  };

  // Home: shown once for each new build; Account › เวอร์ชันแอป keeps offering it after that.
  window.appUpdateCard = () => {
    if (!up.newer || seen() === up.latest.build) return '';
    return `<div class="card au-home">
      <span class="au-ico">📲</span>
      <div class="main"><b>มีแอปเวอร์ชันใหม่</b><div class="muted small" translate="no">${esc(up.latest.version)} (${esc(up.latest.build)})</div></div>
      <a class="btn small" href="${INSTALL}" data-au-install>อัปเดต</a>
      <button type="button" class="au-x" data-au-close aria-label="ปิด">✕</button>
    </div>`;
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-au-install]') && up.latest) markSeen(up.latest.build);
    if (e.target.closest('[data-au-close]') && up.latest) { markSeen(up.latest.build); rerender(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(() => check(true), CHECK_EVERY);
  setTimeout(() => check(true), 1200);
})();
