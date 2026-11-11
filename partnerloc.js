'use strict';

/* Partner location (แชร์ตำแหน่งกับคู่): partners see where the other one is and how hot it is
   there. Each person turns sharing on for themselves in Account › แชร์ตำแหน่งกับคู่.
   - On the web and in older app builds, the place is sent when the app is opened.
   - In the iOS app (PartnerLocation plugin, App/PartnerLocation.swift) it is also sent in the
     background on iOS significant location changes (roughly every 500 m, battery-friendly),
     with the app's own key from /api/location/token, so the page doesn't have to be open.
   The server keeps only the latest place and fetches the weather there from Open-Meteo
   (server/src/location.js). Home shows both of you in one card. Loaded after app.js. */

(() => {
  const cap = window.Capacitor;
  const plugin = (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.PartnerLocation) || null;
  const pl = { data: null, at: 0, busy: false, native: null, sent: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ready = () => isCloud() && cloud.user && cloud.partner;
  const FRESH = 10 * 60000; // send a new place on open when the last one is older than this

  /* ---------- Weather and time words ---------- */

  // WMO weather code (Open-Meteo) → [emoji, Thai words].
  function wxLook(code, day) {
    const c = Number(code);
    if (c === 0) return [day === false ? '🌙' : '☀️', 'ท้องฟ้าแจ่มใส'];
    if (c === 1 || c === 2) return [day === false ? '☁️' : '🌤️', 'มีเมฆบางส่วน'];
    if (c === 3) return ['☁️', 'เมฆมาก'];
    if (c === 45 || c === 48) return ['🌫️', 'มีหมอก'];
    if (c >= 51 && c <= 57) return ['🌦️', 'ฝนปรอย'];
    if (c >= 61 && c <= 67) return ['🌧️', 'ฝนตก'];
    if (c >= 71 && c <= 77) return ['❄️', 'หิมะตก'];
    if (c >= 80 && c <= 82) return ['🌦️', 'ฝนตกเป็นช่วงๆ'];
    if (c === 85 || c === 86) return ['🌨️', 'หิมะตก'];
    if (c >= 95) return ['⛈️', 'พายุฝนฟ้าคะนอง'];
    return ['🌡️', ''];
  }

  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!(ms >= 0)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 2) return 'เมื่อสักครู่';
    if (m < 60) return `${m} นาทีที่แล้ว`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ชม.ที่แล้ว`;
    const d = Math.floor(h / 24);
    return `${d} วันที่แล้ว`;
  }

  const mapUrl = (p) => `https://maps.apple.com/?ll=${p.lat},${p.lon}&q=${encodeURIComponent(p.place || 'ตำแหน่ง')}`;
  const placeName = (p) => p.place || `${Number(p.lat).toFixed(3)}, ${Number(p.lon).toFixed(3)}`;

  /* ---------- Server ---------- */

  function changed(next) {
    const a = JSON.stringify(pl.data), b = JSON.stringify(next);
    pl.data = next;
    return a !== b;
  }
  function rerender() {
    if (ui.tab === 'home' || ui.tab === 'account') render();
    // Account's render redraws an open settings sheet itself; elsewhere do it here.
    if (ui.tab !== 'account' && ui.setSheet === 'partnerloc' && !$('#sheet').hidden) settingsSheet('partnerloc', true);
  }

  async function load(force) {
    if (!ready()) return;
    if (!force && Date.now() - pl.at < 60000) return;
    pl.at = Date.now();
    try {
      if (changed(await api('GET', '/location'))) rerender();
    } catch (e) { /* offline: keep what we had */ }
  }

  /* ---------- Sending my place ---------- */

  // The page's own way (web, or an app build without the plugin): browser location, then
  // a place name from BigDataCloud's free client lookup, then /api/location.
  function browserPlace(ask) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      const go = () => navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
        let place = '';
        try {
          const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&localityLanguage=th`);
          if (r.ok) {
            const j = await r.json();
            place = [...new Set([j.locality, j.city, j.principalSubdivision].filter(Boolean))].slice(0, 2).join(', ');
            if (j.countryCode && j.countryCode !== 'TH' && j.countryName) place = place ? `${place}, ${j.countryName}` : j.countryName;
          }
        } catch (e) { /* the place name is optional */ }
        resolve({ lat, lon, acc, place });
      }, (err) => resolve({ error: err && err.code === 1 ? 'denied' : 'failed' }),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60000 });
      if (ask) return go();
      // Opening the app only sends a place when location is already allowed (no prompt each time).
      if (!navigator.permissions) return resolve(null);
      navigator.permissions.query({ name: 'geolocation' }).then((s) => (s.state === 'granted' ? go() : resolve(null)), () => resolve(null));
    });
  }

  async function sendFromPage(ask) {
    const p = await browserPlace(ask);
    if (!p || p.error) {
      if (ask) toast(p && p.error === 'denied' ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง เปิดได้ที่ ตั้งค่า > ความเป็นส่วนตัว > บริการหาตำแหน่ง' : 'หาตำแหน่งไม่ได้ ลองใหม่อีกครั้ง');
      return false;
    }
    try {
      const r = await api('POST', '/location', p);
      pl.data = { ...(pl.data || {}), me: r.me };
      pl.sent = Date.now();
      return true;
    } catch (e) { if (ask) toast(cloudErr(e)); return false; }
  }

  // The iOS app: hands it a fresh key and lets it watch for significant moves.
  async function startNative() {
    const { token } = await api('POST', '/location/token');
    pl.native = await plugin.start({ token, url: `${location.origin}/api/location/ping`, userId: cloud.user.id });
    return pl.native;
  }

  async function nativeStatus() {
    try { pl.native = await plugin.status(); } catch (e) { pl.native = null; }
    return pl.native;
  }

  // Run when the app comes to the front: keeps the app's watcher in step with the account
  // and sends a fresh place when the last one is old.
  async function wake() {
    for (let i = 0; i < 40 && !(isCloud() && cloud.user); i++) await sleep(250);
    if (!ready()) return;
    await load(true);
    const me = pl.data && pl.data.me;
    if (!me) return;
    if (plugin) {
      const st = await nativeStatus();
      if (!st) return;
      const mine = st.userId === cloud.user.id;
      if (!me.sharing) {
        if (st.on && mine) await plugin.stop().catch(() => {});
        return;
      }
      if (st.access === 'denied' || st.access === 'restricted') return;
      if (!st.on || !mine || !me.app) { try { await startNative(); } catch (e) { return; } }
      else if (!me.at || Date.now() - new Date(me.at).getTime() > FRESH) await plugin.now().catch(() => {});
      else return;
      await sleep(4000);
      await load(true);
      return;
    }
    if (me.sharing && (!me.at || Date.now() - new Date(me.at).getTime() > FRESH) && Date.now() - pl.sent > FRESH) {
      if (await sendFromPage(false)) await load(true);
    }
  }

  async function setSharing(on) {
    pl.busy = true;
    rerender();
    try {
      const r = await api('PUT', '/location/sharing', { on });
      pl.data = { ...(pl.data || {}), me: r.me };
      if (on) {
        if (plugin) {
          const st = await startNative();
          if (st && (st.access === 'denied' || st.access === 'restricted')) toast('ต้องอนุญาตให้ METANG ใช้ตำแหน่งก่อน');
          else if (st && st.access !== 'always') toast('เลือก "อนุญาตตลอด" เพื่อให้อัปเดตเองแม้ปิดแอป');
          await sleep(3500);
        } else {
          await sendFromPage(true);
        }
        toast(`เปิดแชร์ตำแหน่งให้ ${partnerName()} แล้ว`);
      } else {
        if (plugin) await plugin.stop().catch(() => {});
        toast('ปิดแชร์ตำแหน่งแล้ว ลบตำแหน่งล่าสุดออกแล้ว');
      }
      pl.at = 0;
      await load(true);
    } catch (e) {
      toast(cloudErr(e));
    } finally {
      pl.busy = false;
      rerender();
    }
  }

  async function updateNow() {
    pl.busy = true;
    rerender();
    try {
      if (plugin) {
        const st = await nativeStatus();
        if (!st || !st.on || st.userId !== cloud.user.id) await startNative();
        else await plugin.now();
        await sleep(3500);
      } else {
        await sendFromPage(true);
      }
      await load(true);
    } catch (e) {
      toast('อัปเดตตำแหน่งไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      pl.busy = false;
      rerender();
    }
  }

  /* ---------- Home card ---------- */

  function personRow(u, p, who) {
    const has = p && p.sharing && p.lat != null;
    const wx = has && p.wx;
    const [ico, words] = wx ? wxLook(wx.code, wx.day) : ['', ''];
    const name = who === 'me' ? 'ฉัน' : esc(partnerName());
    const sub = !p || !p.sharing
      ? (who === 'me' ? 'ยังไม่ได้แชร์ตำแหน่งของคุณ' : `${esc(partnerName())} ยังไม่ได้เปิดแชร์ตำแหน่ง`)
      : !has ? 'รอตำแหน่งแรก…'
        : `${words ? `<span>${esc(words)}</span> · ` : ''}<span>${ago(p.at)}</span>`;
    const title = has ? `${name} · ${esc(placeName(p))}` : name;
    const right = wx ? `<div class="right pl-wx"><span class="pl-wx-ico">${ico}</span><b>${Math.round(wx.temp)}°</b></div>` : '';
    const inner = `${userAvatar(u || {}, 'avatar pl-av')}
      <div class="main"><div class="name">${title}</div><div class="sub">${sub}</div></div>${right}`;
    if (has) return `<a class="item pl-row" href="${esc(mapUrl(p))}" target="_blank" rel="noopener">${inner}</a>`;
    if (who === 'me') return `<button class="item pl-row" data-set-open="partnerloc">${inner}${svgIcon('chev', 'svg-i sm muted')}</button>`;
    return `<div class="item pl-row">${inner}</div>`;
  }

  // Straight-line distance between two places, in km.
  function km(a, b) {
    const r = (d) => (d * Math.PI) / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function distRow(me, partner) {
    if (!me || !partner || me.lat == null || partner.lat == null) return '';
    const d = km(me, partner);
    const text = d < 0.1 ? 'อยู่ที่เดียวกัน'
      : d < 1 ? `ห่างกัน ${Math.round(d * 1000 / 10) * 10} ม.`
        : d < 10 ? `ห่างกัน ${d.toFixed(1)} กม.`
          : `ห่างกัน ${Math.round(d).toLocaleString('en-US')} กม.`;
    return `<div class="pl-dist"><span>📏</span><b>${text}</b><span class="muted small">เส้นตรง</span></div>`;
  }

  window.partnerLocCard = () => {
    if (!ready() || !pl.data) return '';
    const { me, partner } = pl.data;
    if (!(me && me.sharing) && !(partner && partner.sharing)) return '';
    return `
      <div class="section-row"><span>📍 ตอนนี้อยู่ที่ไหน</span><button class="link-btn" data-set-open="partnerloc">ตั้งค่า</button></div>
      <div class="card list-card pl-card">
        ${personRow(cloud.partner, partner, 'partner')}
        ${personRow(cloud.user, me, 'me')}
        ${distRow(me, partner)}
      </div>`;
  };

  /* ---------- Account › แชร์ตำแหน่งกับคู่ ---------- */

  window.partnerLocRow = () => (ready()
    ? setRow({ set: 'partnerloc', ico: '📍', color: '#ff2d55', name: 'แชร์ตำแหน่งกับคู่',
      value: pl.data && pl.data.me && pl.data.me.sharing ? 'เปิดอยู่' : 'ปิดอยู่' })
    : '');

  window.partnerLocSettings = () => {
    const me = (pl.data && pl.data.me) || { sharing: false };
    const partner = pl.data && pl.data.partner;
    const st = pl.native;
    let how;
    if (!me.sharing) how = '';
    else if (plugin && st && (st.access === 'denied' || st.access === 'restricted')) how = 'METANG ยังไม่ได้รับสิทธิ์ใช้ตำแหน่ง เปิดได้ที่ การตั้งค่า › METANG › ตำแหน่ง › ตลอดเวลา';
    else if (plugin && st && st.access !== 'always') how = 'ตอนนี้อัปเดตเฉพาะตอนเปิดแอป ถ้าอยากให้อัปเดตเองแม้ปิดแอป ไปที่ การตั้งค่า › METANG › ตำแหน่ง แล้วเลือก "ตลอดเวลา"';
    else if (plugin) how = 'อัปเดตเองแม้ปิดแอป เมื่อคุณย้ายที่ไปราว 500 เมตรขึ้นไป (โหมดประหยัดแบตของ iOS) และทุกครั้งที่เปิดแอป';
    else how = 'อัปเดตทุกครั้งที่เปิดแอป · ถ้าอยากให้อัปเดตเองแม้ปิดแอป ใช้แอป METANG บน iPhone';
    const needSettings = plugin && st && me.sharing && st.access !== 'always';
    return `
      <div class="form">
        <div class="field"><label for="plOn">แชร์ตำแหน่งของฉันให้ ${esc(partnerName())}</label><span style="flex:1"></span>
          <label class="switch"><input type="checkbox" id="plOn" ${me.sharing ? 'checked' : ''} ${pl.busy ? 'disabled' : ''}><span></span></label></div>
      </div>
      ${how ? `<p class="hint">${how}</p>` : ''}
      ${needSettings ? '<button class="btn ghost" id="plSettings">เปิดการตั้งค่า</button>' : ''}
      ${me.sharing ? `<button class="btn ghost" id="plNow" ${pl.busy ? 'disabled' : ''}>${pl.busy ? 'กำลังหาตำแหน่ง…' : '📍 อัปเดตตำแหน่งตอนนี้'}</button>` : ''}
      ${me.sharing && me.at ? `<p class="hint">ตำแหน่งล่าสุดของคุณ: ${esc(placeName(me))} · ${ago(me.at)}</p>` : ''}
      <p class="hint">${partner && partner.sharing ? `${esc(partnerName())} แชร์ตำแหน่งให้คุณอยู่` : `${esc(partnerName())} ยังไม่ได้เปิดแชร์ตำแหน่ง`}</p>
      <p class="hint">${esc(partnerName())} เห็นตำแหน่งล่าสุดของคุณและอุณหภูมิที่นั่นบนหน้าหลัก เซิร์ฟเวอร์เก็บเฉพาะตำแหน่งล่าสุด ไม่เก็บเส้นทางย้อนหลัง ปิดสวิตช์แล้วตำแหน่งจะถูกลบทันที · อากาศจาก Open-Meteo</p>`;
  };

  window.partnerLocBind = () => {
    const sw = $('#plOn');
    if (sw) sw.addEventListener('change', (e) => setSharing(e.target.checked));
    const now = $('#plNow');
    if (now) now.addEventListener('click', updateNow);
    const s = $('#plSettings');
    if (s) s.addEventListener('click', () => plugin.openSettings().catch(() => {}));
    if (plugin) nativeStatus().then((st) => {
      const was = $('#plSettings') ? 'x' : '';
      const need = st && pl.data && pl.data.me && pl.data.me.sharing && st.access !== 'always' ? 'x' : '';
      if (was !== need && ui.setSheet === 'partnerloc') settingsSheet('partnerloc', true);
    });
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set-open="partnerloc"]');
    if (b) { e.preventDefault(); settingsSheet('partnerloc'); }
  });

  /* ---------- When to check ---------- */

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(wake, 900); });
  // Partner's place every few minutes while the app is open on Home.
  setInterval(() => { if (document.visibilityState === 'visible' && ui.tab === 'home') load(false); }, 3 * 60000);
  setTimeout(wake, 1800);
})();
