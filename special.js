'use strict';

/* Account › ตั้งค่าพิเศษ: a settings page kept out of the way. In the iOS app, tap the เวอร์ชันล่าสุด row in
   Account › เวอร์ชันแอป 5 times (on the web, the version line at the bottom of Account), then enter the code. The code only keeps the page out of
   everyday view; it is not a lock on anything.
   1. ปักหมุดตำแหน่ง: pin the place shared with the partner by hand. While pinned, live updates
      from the phone are not saved, and the partner sees "📌 ปักหมุด" on the person's profile (Account › บัญชีคู่ › tap the picture).
      The place is chosen on a map (Leaflet + OpenStreetMap tiles, loaded only when this page
      opens): drag the map so the pin in the middle sits on the place. Search (Open-Meteo's free
      geocoding, or a "lat, lon" pair / Google or Apple Maps link) moves the map there, and the
      place name comes from OpenStreetMap's Nominatim. All of it runs on the phone, not our
      server. Loaded after partnerloc.js. */

(() => {
  const CODE = '6699';
  const sp = { taps: 0, tapAt: 0, open: false, results: [], busy: false, q: '', center: null, zoom: 14, name: '' };
  const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  const BKK = { lat: 13.7563, lon: 100.5018 };

  /* ---------- Way in ---------- */

  document.addEventListener('click', (e) => {
    // In the app: Account › เวอร์ชันแอป › เวอร์ชันล่าสุด. On the web (no such row): the version line.
    const cap = window.Capacitor;
    const app = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
    if (!e.target.closest(app ? '.au-latest' : '.set-foot')) return;
    const now = Date.now();
    sp.taps = now - sp.tapAt < 800 ? sp.taps + 1 : 1;
    sp.tapAt = now;
    if (sp.taps >= 5) { sp.taps = 0; sp.open ? settingsSheet('special') : codeSheet(); }
  });

  function codeSheet() {
    openSheet(`
      <div class="sheet-head">${CLOSE_X}<h2>ตั้งค่าพิเศษ</h2><span style="width:40px"></span></div>
      <p class="ho-intro">ใส่รหัสเพื่อเปิดหน้าตั้งค่าพิเศษ</p>
      <div class="form"><div class="field"><input id="spCode" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="รหัส" style="text-align:center;letter-spacing:.4em;font-size:22px"></div></div>
      <button class="btn" id="spGo">เปิด</button>`);
    const inp = $('#spCode');
    setTimeout(() => inp.focus(), 50);
    const go = () => {
      if (inp.value.trim() === CODE) { sp.open = true; settingsSheet('special'); }
      else { inp.value = ''; toast('รหัสไม่ถูกต้อง'); }
    };
    $('#spGo').addEventListener('click', go);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    inp.addEventListener('input', () => { if (inp.value.length === CODE.length && inp.value === CODE) go(); });
  }

  /* ---------- Finding a place ---------- */

  // "13.75, 100.5", or a Google / Apple Maps link with the coordinates in it.
  function parseCoords(q) {
    const m = q.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/) || q.match(/[@=](-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
    if (!m) return null;
    const lat = Number(m[1]), lon = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  }

  async function search(q) {
    const c = parseCoords(q);
    if (c) return [{ ...c, name: `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`, sub: 'พิกัดที่ใส่' }];
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=th&format=json`);
    if (!r.ok) throw new Error('search');
    const j = await r.json();
    return (j.results || []).map((x) => ({
      lat: x.latitude, lon: x.longitude, name: x.name,
      sub: [x.admin2, x.admin1, x.country].filter((v, i, a) => v && v !== x.name && a.indexOf(v) === i).join(', '),
    }));
  }

  /* ---------- The map ---------- */

  let leafletP = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (!leafletP) {
      leafletP = new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.min.css';
        document.head.appendChild(css);
        const s = document.createElement('script');
        s.src = LEAFLET + 'leaflet.min.js';
        s.onload = () => resolve(window.L);
        s.onerror = () => { leafletP = null; reject(new Error('map')); };
        document.head.appendChild(s);
      });
    }
    return leafletP;
  }

  // A short Thai name for a spot: "ชื่อสถานที่, เขต/อำเภอ, จังหวัด".
  async function placeName(lat, lon) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=17&accept-language=th`);
      if (!r.ok) return '';
      const j = await r.json(), a = j.address || {};
      const area = a.suburb || a.city_district || a.district || a.town || a.village || a.county || '';
      const prov = a.state || a.province || a.city || '';
      return [j.name || a.road || '', area, prov].filter((v, i, x) => v && x.indexOf(v) === i).slice(0, 3).join(', ');
    } catch (e) { return ''; }
  }

  let map = null, nameT = 0, nameSeq = 0;
  function startMap() {
    const box = $('#spMap');
    if (!box) return;
    if (map) { map.remove(); map = null; }
    loadLeaflet().then((L) => {
      if (!document.body.contains(box)) return;
      const c = sp.center || BKK;
      map = L.map(box, { zoomControl: false, attributionControl: true }).setView([c.lat, c.lon], sp.zoom);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      const moved = () => {
        const m = map.getCenter();
        sp.center = { lat: m.lat, lon: m.lng }; sp.zoom = map.getZoom();
        const here = $('#spHere');
        if (here) here.textContent = 'กำลังหาชื่อสถานที่…';
        clearTimeout(nameT);
        const seq = ++nameSeq;
        nameT = setTimeout(async () => {
          const n = await placeName(sp.center.lat, sp.center.lon);
          if (seq !== nameSeq) return;
          sp.name = n;
          const h = $('#spHere');
          if (h) h.textContent = n || `${sp.center.lat.toFixed(5)}, ${sp.center.lon.toFixed(5)}`;
        }, 600);
      };
      map.on('moveend', moved);
      if (!sp.name) moved();
      box.classList.add('ready');
    }).catch(() => { box.innerHTML = '<div class="muted pad">โหลดแผนที่ไม่ได้ ลองค้นหาด้วยชื่อแทน</div>'; });
  }

  function moveTo(lat, lon, name) {
    sp.center = { lat, lon }; sp.zoom = 16; sp.name = name || '';
    const here = $('#spHere');
    if (here && name) here.textContent = name;
    if (map) { nameSeq++; map.setView([lat, lon], 16); if (!name) map.fire('moveend'); }
  }

  /* ---------- The page ---------- */

  window.specialSettings = () => {
    const P = window.partnerLocPin;
    if (!P || !P.ready()) return '<p class="hint">ต้องเข้าสู่ระบบและเชื่อมบัญชีคู่ก่อน</p>';
    const me = P.me();
    const sharing = me && me.sharing;
    const pinned = me && me.pinned;
    if (!sp.center && me && me.lat != null) { sp.center = { lat: me.lat, lon: me.lon }; sp.name = me.place || ''; }
    return `
      <div class="section-title">📌 ปักหมุดตำแหน่ง</div>
      ${!sharing ? `<p class="hint">เปิด "แชร์ตำแหน่งกับคู่" ก่อน แล้วจึงปักหมุดได้</p>
        <button class="btn ghost" data-set-open="partnerloc">ไปที่แชร์ตำแหน่งกับคู่</button>` : `
      ${pinned ? `
        <div class="card list-card"><div class="item"><span class="ho-ico" style="--c:#ff3b30">📌</span>
          <div class="main"><div class="name">${esc(me.place || `${me.lat}, ${me.lon}`)}</div><div class="sub">ปักหมุดอยู่ · ตำแหน่งจริงหยุดอัปเดต</div></div></div></div>
        <button class="btn ghost" id="spUnpin" ${sp.busy ? 'disabled' : ''}>เลิกปักหมุด กลับไปใช้ตำแหน่งจริง</button>` : ''}
      <div class="form"><div class="field"><input id="spQ" type="search" enterkeyhint="search" placeholder="ค้นหาสถานที่ หรือวางพิกัด / ลิงก์แผนที่" value="${esc(sp.q)}" style="text-align:left"></div></div>
      ${sp.busy || sp.results.length ? `<div class="list sp-results">${sp.busy ? '<div class="muted pad">กำลังค้นหา…</div>' : sp.results.map((x, i) => `
        <button class="item" data-sp-pick="${i}"><span class="ho-ico" style="--c:#ff3b30">📍</span>
          <div class="main"><div class="name">${esc(x.name)}</div>${x.sub ? `<div class="sub">${esc(x.sub)}</div>` : ''}</div></button>`).join('')}</div>` : ''}
      <div class="sp-map-wrap"><div id="spMap" class="sp-map"></div><div class="sp-map-pin" aria-hidden="true">📌</div></div>
      <div class="sp-here"><span class="sp-here-k">เลื่อนแผนที่ให้หมุดอยู่ตรงจุดที่ต้องการ</span><div id="spHere" class="sp-here-v">${esc(sp.name || '')}</div></div>
      <button class="btn" id="spPinHere">📌 ปักหมุดตรงนี้</button>
      <p class="hint">ปักหมุดแล้ว ${esc(partnerName())} จะเห็นตำแหน่งนี้และอากาศที่นั่น และเห็นป้าย "📌 ปักหมุด" เมื่อกดรูปของคุณในหน้าบัญชีคู่ ระหว่างนี้ตำแหน่งจริงจากเครื่องจะไม่ถูกส่งขึ้นไป เลิกปักหมุดเมื่อไหร่ก็กลับมาแชร์ตำแหน่งจริงทันที</p>`}`;
  };

  window.specialBind = () => {
    const P = window.partnerLocPin;
    const q = $('#spQ');
    if (q) {
      const run = async () => {
        sp.q = q.value.trim();
        if (sp.q.length < 2) { sp.results = []; return; }
        sp.busy = true; settingsSheet('special', true);
        try {
          sp.results = await search(sp.q);
          if (!sp.results.length) toast('ไม่พบสถานที่นี้');
          else if (sp.results.length === 1) { const x = sp.results[0]; sp.results = []; sp.center = { lat: x.lat, lon: x.lon }; sp.zoom = 16; sp.name = ''; }
        } catch (e) { toast('ค้นหาไม่ได้ ลองใหม่อีกครั้ง'); }
        sp.busy = false;
        if (ui.setSheet === 'special') settingsSheet('special', true);
      };
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q.blur(); run(); } });
    }
    $('#sheet').querySelectorAll('[data-sp-pick]').forEach((b) => b.addEventListener('click', () => {
      const x = sp.results[Number(b.dataset.spPick)];
      if (!x) return;
      sp.results = [];
      const list = $('#sheet .sp-results');
      if (list) list.remove();
      moveTo(x.lat, x.lon, x.sub ? `${x.name}, ${x.sub.split(', ')[0]}` : x.name);
    }));
    const here = $('#spPinHere');
    if (here) here.addEventListener('click', async () => {
      const c = sp.center;
      if (!c) return;
      here.disabled = true;
      try {
        await P.pin({ lat: c.lat, lon: c.lon, place: sp.name || null });
        sp.q = '';
        toast(`📌 ปักหมุดที่ ${sp.name || 'จุดนี้'} แล้ว`);
      } catch (e) { toast(cloudErr(e)); }
      settingsSheet('special', true);
    });
    startMap();
    const un = $('#spUnpin');
    if (un) un.addEventListener('click', async () => {
      sp.busy = true; settingsSheet('special', true);
      try { await P.unpin(); toast('เลิกปักหมุดแล้ว กลับไปใช้ตำแหน่งจริง'); } catch (e) { toast(cloudErr(e)); }
      sp.busy = false;
      settingsSheet('special', true);
    });
  };
})();
