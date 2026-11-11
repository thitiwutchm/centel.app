'use strict';

/* Account › ตั้งค่าพิเศษ: a settings page kept out of the way. Tap the version line at the
   bottom of Account 5 times, then enter the code. The code only keeps the page out of
   everyday view; it is not a lock on anything.
   1. ปักหมุดตำแหน่ง: pin the place shared with the partner by hand. While pinned, live updates
      from the phone are not saved, and the partner sees the place marked 📌 ปักหมุด.
      Places are found with Open-Meteo's free geocoding from the phone (no key, no server);
      a "lat, lon" pair or a Google / Apple Maps link also works. Loaded after partnerloc.js. */

(() => {
  const CODE = '6699';
  const sp = { taps: 0, tapAt: 0, open: false, results: [], busy: false, q: '' };

  /* ---------- Way in ---------- */

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.set-foot')) return;
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

  /* ---------- The page ---------- */

  window.specialSettings = () => {
    const P = window.partnerLocPin;
    if (!P || !P.ready()) return '<p class="hint">ต้องเข้าสู่ระบบและเชื่อมบัญชีคู่ก่อน</p>';
    const me = P.me();
    const sharing = me && me.sharing;
    const pinned = me && me.pinned;
    return `
      <div class="section-title">📌 ปักหมุดตำแหน่ง</div>
      ${!sharing ? `<p class="hint">เปิด "แชร์ตำแหน่งกับคู่" ก่อน แล้วจึงปักหมุดได้</p>
        <button class="btn ghost" data-set-open="partnerloc">ไปที่แชร์ตำแหน่งกับคู่</button>` : `
      ${pinned ? `
        <div class="card list-card"><div class="item"><span class="ho-ico" style="--c:#ff3b30">📌</span>
          <div class="main"><div class="name">${esc(me.place || `${me.lat}, ${me.lon}`)}</div><div class="sub">ปักหมุดอยู่ · ตำแหน่งจริงหยุดอัปเดต</div></div></div></div>
        <button class="btn ghost" id="spUnpin" ${sp.busy ? 'disabled' : ''}>เลิกปักหมุด กลับไปใช้ตำแหน่งจริง</button>` : ''}
      <div class="form"><div class="field"><input id="spQ" type="search" enterkeyhint="search" placeholder="ค้นหาสถานที่ หรือวางพิกัด / ลิงก์แผนที่" value="${esc(sp.q)}"></div></div>
      <button class="btn ghost" id="spGoSearch">🔍 ค้นหา</button>
      <div class="list sp-results">${sp.busy ? '<div class="muted pad">กำลังค้นหา…</div>' : sp.results.map((x, i) => `
        <button class="item" data-sp-pick="${i}"><span class="ho-ico" style="--c:#ff3b30">📍</span>
          <div class="main"><div class="name">${esc(x.name)}</div>${x.sub ? `<div class="sub">${esc(x.sub)}</div>` : ''}</div></button>`).join('')}</div>
      <p class="hint">ปักหมุดแล้ว ${esc(partnerName())} จะเห็นตำแหน่งนี้พร้อมป้าย "📌 ปักหมุด" และอากาศที่นั่น ระหว่างนี้ตำแหน่งจริงจากเครื่องจะไม่ถูกส่งขึ้นไป เลิกปักหมุดเมื่อไหร่ก็กลับมาแชร์ตำแหน่งจริงทันที</p>`}`;
  };

  window.specialBind = () => {
    const P = window.partnerLocPin;
    const q = $('#spQ');
    if (q) {
      const run = async () => {
        sp.q = q.value.trim();
        if (sp.q.length < 2) { sp.results = []; return; }
        sp.busy = true; settingsSheet('special', true);
        try { sp.results = await search(sp.q); if (!sp.results.length) toast('ไม่พบสถานที่นี้'); } catch (e) { toast('ค้นหาไม่ได้ ลองใหม่อีกครั้ง'); }
        sp.busy = false;
        if (ui.setSheet === 'special') settingsSheet('special', true);
      };
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q.blur(); run(); } });
      const go = $('#spGoSearch');
      if (go) go.addEventListener('click', run);
    }
    $('#sheet').querySelectorAll('[data-sp-pick]').forEach((b) => b.addEventListener('click', async () => {
      const x = sp.results[Number(b.dataset.spPick)];
      if (!x) return;
      try {
        await P.pin({ lat: x.lat, lon: x.lon, place: x.sub ? `${x.name}, ${x.sub.split(', ')[0]}` : x.name });
        sp.results = []; sp.q = '';
        toast(`📌 ปักหมุดที่ ${x.name} แล้ว`);
      } catch (e) { toast(cloudErr(e)); }
      settingsSheet('special', true);
    }));
    const un = $('#spUnpin');
    if (un) un.addEventListener('click', async () => {
      sp.busy = true; settingsSheet('special', true);
      try { await P.unpin(); toast('เลิกปักหมุดแล้ว กลับไปใช้ตำแหน่งจริง'); } catch (e) { toast(cloudErr(e)); }
      sp.busy = false;
      settingsSheet('special', true);
    });
  };
})();
