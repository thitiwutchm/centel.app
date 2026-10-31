'use strict';

/* สถานะ Mac: a dashboard for the Mac that runs the chat assistant (Ollama + Hermes gateway +
   the Centel bridge). The bridge reports CPU, memory, disk, uptime, the loaded models and
   voice/web once a minute (POST /api/bridge/status); this sheet reads GET /api/chat/mac and
   refreshes every 30 seconds while it is open. Opened from Account › ผู้ช่วย AI ในแชท. */

const MAC_REFRESH_MS = 30000;
const MAC_GAP_MS = 12 * 60000; // samples further apart than this: the Mac was asleep, so the line breaks
const mac = { data: null, timer: null, err: null };

const macGB = (b) => (b == null ? '–' : `${(b / 1024 ** 3).toFixed(b >= 100 * 1024 ** 3 ? 0 : 1)} GB`);
const macPct = (a, b) => (a != null && b ? Math.round((a / b) * 100) : null);
const macLevel = (p) => (p == null ? 'muted' : p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'ok');
const macLevelText = (p) => (p == null ? '' : p >= 90 ? 'สูงมาก' : p >= 75 ? 'ค่อนข้างสูง' : 'ปกติ');

function macDur(sec) {
  if (sec == null) return '–';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} วัน ${h} ชม.`;
  if (h) return `${h} ชม. ${m} นาที`;
  return `${m} นาที`;
}

function macAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 90) return 'เมื่อสักครู่';
  if (s < 3600) return `${Math.round(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.round(s / 3600)} ชม.ที่แล้ว`;
  return `${chatWhen(iso)} ${chatTime(iso)}`;
}

function macSecs(ms) { return ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} วิ`; }

/* ---------- Pieces ---------- */

function macRing(p, label, sub) {
  const r = 30, c = 2 * Math.PI * r;
  const v = p == null ? 0 : Math.min(100, Math.max(0, p));
  const lv = macLevel(p);
  return `
    <div class="mac-gauge ${lv}">
      <svg viewBox="0 0 76 76" aria-hidden="true">
        <circle cx="38" cy="38" r="${r}" class="mac-track"/>
        <circle cx="38" cy="38" r="${r}" class="mac-arc" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 38 38)"/>
      </svg>
      <div class="mac-gauge-num">${p == null ? '–' : `${Math.round(p)}<small>%</small>`}</div>
      <div class="mac-gauge-label">${label}</div>
      <div class="mac-gauge-sub">${sub}</div>
      ${p != null && lv !== 'ok' ? `<span class="badge ${lv}">${macLevelText(p)}</span>` : ''}
    </div>`;
}

// One metric over 24 hours, 0–100%. Breaks where the Mac was asleep; tap/drag to read a point.
function macSpark(samples, key, title) {
  const pts = samples.filter((s) => s[key] != null);
  if (pts.length < 2) return `<div class="mac-spark"><div class="mac-spark-head"><b>${title}</b><span class="muted small">ยังไม่มีข้อมูลพอ</span></div></div>`;
  const W = 320, H = 64, end = Date.now(), start = end - 864e5;
  const x = (t) => ((Math.max(t, start) - start) / 864e5) * W;
  const y = (v) => H - (Math.min(100, Math.max(0, v)) / 100) * (H - 4) - 2;
  const runs = [];
  pts.forEach((s, i) => {
    if (!i || s.t - pts[i - 1].t > MAC_GAP_MS) runs.push([]);
    runs[runs.length - 1].push(s);
  });
  const line = runs.map((r) => r.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join('')).join('');
  const area = runs.filter((r) => r.length > 1).map((r) =>
    `M${x(r[0].t).toFixed(1)},${H}${r.map((s) => `L${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join('')}L${x(r[r.length - 1].t).toFixed(1)},${H}Z`).join('');
  const vals = pts.map((s) => s[key]);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const now = pts[pts.length - 1][key];
  return `
    <div class="mac-spark" data-key="${key}">
      <div class="mac-spark-head"><b>${title}</b><span class="mac-spark-read muted small">ตอนนี้ ${Math.round(now)}% · เฉลี่ย ${Math.round(avg)}% · สูงสุด ${Math.round(Math.max(...vals))}%</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="mac-spark-svg" role="img" aria-label="${title} 24 ชั่วโมง">
        <line x1="0" x2="${W}" y1="${y(50)}" y2="${y(50)}" class="mac-grid"/>
        <line x1="0" x2="${W}" y1="${y(100)}" y2="${y(100)}" class="mac-grid"/>
        <path d="${area}" class="mac-area"/>
        <path d="${line}" class="mac-line" vector-effect="non-scaling-stroke"/>
        <line class="mac-cross" x1="0" x2="0" y1="0" y2="${H}" vector-effect="non-scaling-stroke" hidden/>
      </svg>
      <div class="mac-spark-axis muted small"><span>24 ชม.ก่อน</span><span>12 ชม.ก่อน</span><span>ตอนนี้</span></div>
    </div>`;
}

function macBindSparks(box, samples) {
  box.querySelectorAll('.mac-spark[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const svg = el.querySelector('svg');
    const read = el.querySelector('.mac-spark-read');
    const cross = el.querySelector('.mac-cross');
    const idle = read.textContent;
    const pts = samples.filter((s) => s[key] != null);
    const start = Date.now() - 864e5;
    const show = (e) => {
      const rc = svg.getBoundingClientRect();
      const t = start + ((e.clientX - rc.left) / rc.width) * 864e5;
      let best = pts[0];
      for (const s of pts) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
      const bx = ((best.t - start) / 864e5) * 320;
      cross.setAttribute('x1', bx); cross.setAttribute('x2', bx); cross.hidden = false;
      read.textContent = `${chatTime(new Date(best.t).toISOString())} · ${Math.round(best[key])}%`;
    };
    const hide = () => { cross.hidden = true; read.textContent = idle; };
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') setTimeout(hide, 1500); });
  });
}

function macRow(label, value, state) {
  const dot = state == null ? '' : `<i class="mac-dot ${state === true ? 'ok' : state === false ? 'bad' : 'muted'}"></i>`;
  return `<div class="mac-row"><span class="mac-row-label">${label}</span><span class="mac-row-val">${dot}${value}</span></div>`;
}

function macCard(m, jobs) {
  const s = m.status;
  const fresh = s && m.statusAt && Date.now() - new Date(m.statusAt) < 3 * 60000;
  const name = (s && s.host) || (m.info ? m.info.split(' · ')[0] : 'Mac');
  const owner = m.owner && !m.mine ? ` · ของ ${esc(m.owner)}` : '';
  const head = `
    <div class="mac-hero">
      <div class="mac-ico">🖥️</div>
      <div class="mac-hero-text">
        <h3 translate="no">${esc(name)}</h3>
        <div class="muted small" translate="no">${s ? esc([s.chip, s.os].filter(Boolean).join(' · ')) : esc(m.info || '')}${owner}</div>
      </div>
      <span class="badge ${m.online ? 'ok' : 'muted'}">${m.online ? 'ออนไลน์' : 'ออฟไลน์'}</span>
    </div>
    <div class="mac-sub muted small">${m.online ? `เปิดเครื่องมา ${s ? macDur(s.uptime) : '–'}` : `เห็นล่าสุด ${macAgo(m.lastSeen) || '–'}`}</div>`;
  if (!s) {
    return `<div class="card mac-card">${head}
      <div class="mac-old">
        <b>bridge บน Mac ยังเป็นรุ่นเก่า</b>
        <p class="hint">อัปเดตครั้งเดียวเพื่อให้ Mac ส่งสถานะเครื่องมาแสดงที่นี่ วางคำสั่งนี้ใน Terminal บน Mac (ค่าที่ตั้งไว้ไม่หาย)</p>
        <pre class="mono" translate="no">${esc(MAC_UPDATE_CMD)}</pre>
        <button class="btn ghost" data-mac-copy>คัดลอกคำสั่ง</button>
      </div></div>`;
  }
  const memP = macPct(s.mem.used, s.mem.total);
  const diskUsed = s.disk.total != null ? s.disk.total - (s.disk.free || 0) : null;
  const diskP = macPct(diskUsed, s.disk.total);
  const ol = s.ollama || {};
  const he = s.hermes || {};
  const br = s.bridge || {};
  const running = (ol.running || []).map((r) => `<span translate="no">${esc(r.name)}</span> <span class="muted">${macGB(r.vram || r.size)}</span>`).join('<br>');
  const models = (ol.models || []).map((x) => `<span class="chip mac-chip" translate="no">${esc(x.name)} <small>${macGB(x.size)}</small></span>`).join('');
  return `<div class="card mac-card${fresh ? '' : ' stale'}">${head}
    ${fresh ? '' : `<div class="mac-stale small">ข้อมูลล่าสุดเมื่อ ${macAgo(m.statusAt)}</div>`}
    <div class="mac-gauges">
      ${macRing(s.cpu.usage, 'CPU', `${s.cpu.cores || '–'} คอร์`)}
      ${macRing(memP, 'RAM', `${s.mem.used != null ? (s.mem.used / 1024 ** 3).toFixed(1) : '–'}/${s.mem.total ? Math.round(s.mem.total / 1024 ** 3) : '–'} GB`)}
      ${macRing(diskP, 'ดิสก์', `ว่าง ${macGB(s.disk.free)}`)}
    </div>
    <div class="mac-sec">ย้อนหลัง 24 ชั่วโมง</div>
    ${macSpark(m.samples || [], 'cpu', 'CPU')}
    ${macSpark(m.samples || [], 'mem', 'RAM')}
    <div class="mac-sec">บริการ</div>
    <div class="mac-rows">
      ${macRow('Ollama', ol.up ? `ทำงาน${ol.version ? ` · v${esc(ol.version)}` : ''}` : 'ไม่ตอบ', !!ol.up)}
      ${macRow('โมเดลที่โหลดอยู่', running || '<span class="muted">ไม่มี (โหลดเมื่อมีคำถาม)</span>')}
      ${macRow('Hermes gateway', he.up == null ? 'ไม่ได้ใช้ (ต่อ Ollama ตรง)' : he.up ? `ทำงาน · ${macSecs(he.ms)}` : 'ไม่ตอบ', he.up == null ? null : !!he.up)}
      ${macRow('ฟังเสียง (Whisper)', s.voice ? 'เปิดอยู่' : 'ปิดอยู่', s.voice ? true : null)}
      ${macRow('ค้นเว็บ', s.web ? 'เปิดอยู่' : 'ปิดอยู่', s.web ? true : null)}
      ${macRow('Load average', esc((s.cpu.load || []).map((v) => v.toFixed(2)).join(' · ') || '–'))}
      ${s.mem.swap ? macRow('Swap', macGB(s.mem.swap)) : ''}
    </div>
    ${models ? `<div class="mac-sec">โมเดลในเครื่อง</div><div class="chips mac-models">${models}</div>` : ''}
    <div class="mac-sec">ผู้ช่วย</div>
    <div class="mac-stats">
      <div><b>${jobs.done}</b><span>ตอบแล้ว 24 ชม.</span></div>
      <div><b>${macSecs(br.avgMs)}</b><span>เวลาตอบเฉลี่ย</span></div>
      <div><b class="${jobs.failed ? 'bad' : ''}">${jobs.failed}</b><span>ตอบไม่ได้ 24 ชม.</span></div>
      <div><b>${jobs.waiting}</b><span>รอคิว</span></div>
    </div>
    ${br.lastError ? `<div class="mac-err small"><b>ผิดพลาดล่าสุด</b> ${macAgo(br.lastErrorAt)}<div class="mono" translate="no">${esc(br.lastError)}</div></div>` : ''}
    <div class="mac-foot muted small">bridge v${esc(br.version || '?')} · เริ่ม ${br.since ? macAgo(br.since) : '–'} · ตอบไป ${br.answered ?? 0} ครั้ง</div>
  </div>`;
}

const MAC_UPDATE_CMD = 'curl -fsSL https://centel.app/bridge/centel_bridge.py -o ~/.centel-bridge/centel_bridge.py && launchctl kickstart -k gui/$(id -u)/app.centel.bridge';

/* ---------- Sheet ---------- */

function macRender() {
  const box = document.getElementById('macDash');
  if (!box) return;
  const d = mac.data;
  let body;
  if (!d) body = mac.err ? `<p class="hint">โหลดสถานะไม่ได้: ${esc(mac.err)}</p>` : '<p class="hint">กำลังโหลด…</p>';
  else if (!d.macs.length) body = '<div class="card"><b>ยังไม่ได้เชื่อม Mac</b><p class="hint">เชื่อม Mac ที่รัน Hermes Agent ได้ที่ บัญชี › ผู้ช่วย AI ในแชท แล้วสถานะเครื่องจะขึ้นที่นี่</p></div>';
  else body = d.macs.map((m) => macCard(m, d.jobs)).join('');
  box.innerHTML = `${body}${d ? `<p class="hint mac-upd">อัปเดต ${chatTime(d.now)} · รีเฟรชเองทุก 30 วินาที</p>` : ''}`;
  if (d) d.macs.forEach((m, i) => macBindSparks(box.querySelectorAll('.mac-card')[i] || box, m.samples || []));
  box.querySelectorAll('[data-mac-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(MAC_UPDATE_CMD); toast('คัดลอกแล้ว วางใน Terminal บน Mac'); } catch (e) { toast('คัดลอกไม่ได้ กดค้างที่คำสั่งเพื่อคัดลอก'); }
  }));
}

async function macLoad() {
  try { mac.data = await api('GET', '/chat/mac'); mac.err = null; } catch (e) { mac.err = cloudErr(e); }
  macRender();
}

function macSheet() {
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>สถานะ Mac</h2>
      <button class="link-btn" id="macRefresh">รีเฟรช</button>
    </div>
    <div id="macDash"></div>`);
  macRender();
  macLoad();
  document.getElementById('macRefresh').addEventListener('click', macLoad);
  clearInterval(mac.timer);
  mac.timer = setInterval(() => {
    // Stops by itself once the sheet is closed or shows something else.
    if (!document.getElementById('macDash') || $('#sheet').hidden) { clearInterval(mac.timer); mac.timer = null; return; }
    if (document.visibilityState === 'visible') macLoad();
  }, MAC_REFRESH_MS);
}
