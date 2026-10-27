'use strict';

/* ---------- Calendar subscription (iPhone Calendar keeps itself up to date) ----------
 * Signed in, the account can have a secret feed URL (webcal://<host>/api/calendar/<token>.ics,
 * see server/src/routes.js). iPhone subscribes to it once and re-fetches it by itself, so new,
 * edited, paid or deleted bills show up without importing a file again. The app sends the whole
 * calendar (buildIcs in app.js) whenever bills or settings change, and when the app is opened.
 * Signed out, the one-time .ics file (exportIcs) is still offered.
 * Loaded after cloud.js and before app.js; `state`, `buildIcs`, `api` are looked up at call time.
 */

const CALFEED_KEY = 'centel.calfeed.v1'; // { userId, token, updatedAt, sent: hash of the last calendar sent }

const calfeed = { checked: null, timer: null, sending: false, again: false, afterLogin: false };

function calFeedLocal() {
  try {
    const c = JSON.parse(localStorage.getItem(CALFEED_KEY) || 'null');
    return c && cloud.user && c.userId === cloud.user.id ? c : null;
  } catch (e) { return null; }
}
function setCalFeedLocal(c) {
  try {
    if (c) localStorage.setItem(CALFEED_KEY, JSON.stringify({ userId: cloud.user.id, ...c }));
    else localStorage.removeItem(CALFEED_KEY);
  } catch (e) { /* full */ }
}

function calFeedUrl(token, scheme = 'webcal') { return `${scheme}://${location.host}/api/calendar/${token}.ics`; }

// DTSTAMP changes on every build; compare the rest to tell whether anything changed.
function calFeedHash(text) {
  const body = text.replace(/^DTSTAMP:.*$/gm, '');
  let h = 2166136261;
  for (let i = 0; i < body.length; i++) { h ^= body.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// Ask the server once per sign-in whether this account has a feed (another device may have made it).
async function calFeedCheck() {
  if (!isCloud() || calfeed.checked === cloud.user.id) return;
  calfeed.checked = cloud.user.id;
  try {
    const r = await api('GET', '/calendar');
    const cur = calFeedLocal();
    if (!r.token) setCalFeedLocal(null);
    else if (!cur || cur.token !== r.token) setCalFeedLocal({ token: r.token, updatedAt: r.updatedAt, sent: null });
    if (ui.tab === 'account') render();
    if (r.token) calFeedChanged(0);
    if (calfeed.afterLogin) { calfeed.afterLogin = false; setTimeout(calFeedSheet, 300); }
  } catch (e) { calfeed.checked = null; }
}

// Called by save() in app.js, on start and when the app comes back to the screen.
function calFeedChanged(delay = 1500) {
  if (!isCloud()) return;
  if (calfeed.checked !== cloud.user.id) { calFeedCheck(); return; }
  if (!calFeedLocal()) return;
  clearTimeout(calfeed.timer);
  calfeed.timer = setTimeout(calFeedSend, delay);
}

async function calFeedSend(force = false) {
  if (calfeed.sending) { calfeed.again = true; return; }
  const cur = calFeedLocal();
  if (!isCloud() || !cur) return;
  const { text } = buildIcs({ feed: true });
  const hash = calFeedHash(text);
  if (!force && cur.sent === hash) return;
  calfeed.sending = true;
  try {
    const r = await api('PUT', '/calendar', { ics: text });
    setCalFeedLocal({ token: r.token, updatedAt: r.updatedAt, sent: hash });
  } catch (e) {
    if (e.status === 404) { setCalFeedLocal(null); if (ui.tab === 'account') render(); } // turned off on another device
    // offline: sent next time the app opens
  } finally {
    calfeed.sending = false;
  }
  if (calfeed.again) { calfeed.again = false; calFeedSend(); }
}

function calFeedWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The block in Settings → การแจ้งเตือน. Auto sync is the main option; the one-time file is secondary.
function calFeedSettings() {
  const cur = isCloud() ? calFeedLocal() : null;
  if (isCloud()) calFeedCheck();
  const sub = cur
    ? `บิลใหม่ บิลที่แก้ไข และบิลที่จ่ายแล้วจะอัปเดตในปฏิทินเอง${cur.updatedAt ? ` · ส่งล่าสุด ${calFeedWhen(cur.updatedAt)}` : ''}`
    : `สมัครปฏิทินครั้งเดียว แล้วทุกบิลที่มีกำหนดจ่ายจะไปอยู่ในปฏิทิน iPhone พร้อมเสียงเตือน และอัปเดตเองเมื่อเพิ่ม แก้ไข หรือจ่ายบิล${isCloud() ? '' : ' (ต้องเข้าสู่ระบบ)'}`;
  return `
    <button class="btn" data-action="calfeed">📆 ${cur ? 'ปฏิทิน iPhone: ซิงก์อัตโนมัติอยู่' : 'ซิงก์บิลเข้าปฏิทิน iPhone อัตโนมัติ'}</button>
    <p class="hint">${sub}</p>
    ${cur ? '' : `<button class="btn ghost" data-action="ics">📄 ดาวน์โหลดไฟล์ปฏิทิน (.ics) ครั้งเดียว</button>
    <p class="hint">ไฟล์ไม่อัปเดตเอง หากแก้ไขบิลต้องลบปฏิทินเดิมแล้วนำเข้าใหม่</p>`}`;
}

const CLOSE_X = '<button class="close-x" data-action="close" aria-label="ปิด"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>';

function calFeedSheet() {
  if (!isCloud()) {
    // Signing in first: once the account is ready, this sheet opens again (calFeedCheck).
    calfeed.afterLogin = true;
    loginSheet();
    toast('เข้าสู่ระบบก่อน เพื่อให้ปฏิทินอัปเดตอัตโนมัติ');
    return;
  }
  const cur = calFeedLocal();
  if (!cur) {
    openSheet(`
      <div class="sheet-head">${CLOSE_X}<h2>ปฏิทิน iPhone</h2><span style="width:40px"></span></div>
      <p class="hint">แอปจะสร้างลิงก์ปฏิทินส่วนตัวของบัญชีนี้ แล้วเปิดให้ iPhone กด <b>สมัคร</b> ครั้งเดียว หลังจากนั้นบิลทุกใบที่มีกำหนดจ่ายจะอยู่ในแอปปฏิทินและอัปเดตเอง</p>
      <ul class="hint">
        <li>${state.settings.remindDays ? `เตือนล่วงหน้า ${state.settings.remindDays} วัน และเช้าวันครบกำหนด (09:00)` : 'เตือนเช้าวันครบกำหนด (09:00)'}</li>
        <li>เดือนที่จ่ายแล้วขึ้นเป็น ✅ และไม่เตือนซ้ำ</li>
        <li>บิลที่ตั้งตัดบัญชีอัตโนมัติจะไม่ใส่ในปฏิทิน</li>
      </ul>
      <button class="btn" id="cfOn">📆 เปิดซิงก์และสมัครในปฏิทิน</button>
      <p class="hint">ถ้าเคยนำเข้าไฟล์ .ics ไว้ ให้ลบกิจกรรมเดิมออก จะได้ไม่ซ้ำกัน</p>
    `);
    $('#cfOn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('POST', '/calendar/token');
        setCalFeedLocal({ token: r.token, updatedAt: r.updatedAt, sent: null });
        await calFeedSend(true);
        render();
        calFeedSheet();
        location.href = calFeedUrl(r.token);
      } catch (err) {
        e.target.disabled = false;
        toast(cloudErr(err));
      }
    });
    return;
  }
  openSheet(`
    <div class="sheet-head">${CLOSE_X}<h2>ปฏิทิน iPhone</h2><span style="width:40px"></span></div>
    <div class="card"><b>✅ ซิงก์อัตโนมัติอยู่</b>
      <div class="muted small" style="margin-top:4px">ส่งปฏิทินล่าสุด ${esc(calFeedWhen(calFeedLocal().updatedAt))} · iPhone ดึงข้อมูลใหม่เองเป็นระยะ</div></div>
    <button class="btn" id="cfSub">📲 สมัครในปฏิทินเครื่องนี้</button>
    <button class="btn ghost" id="cfCopy">🔗 คัดลอกลิงก์ปฏิทิน</button>
    <p class="hint">ถ้ากดสมัครแล้วไม่ขึ้น: เปิด <b>การตั้งค่า › ปฏิทิน › บัญชี › เพิ่มบัญชี › อื่นๆ › เพิ่มปฏิทินที่สมัครรับ</b> แล้ววางลิงก์ · ถ้าไม่มีเสียงเตือน ให้ปิด "ลบการเตือน" (Remove Alerts) ในหน้าตั้งค่าของปฏิทินนี้ · ลิงก์นี้เป็นความลับ ใครมีลิงก์จะเห็นรายการบิล</p>
    <button class="btn ghost" id="cfNew">🔄 สร้างลิงก์ใหม่ (ลิงก์เดิมใช้ไม่ได้)</button>
    <button class="btn ghost" data-action="ics">📄 ดาวน์โหลดไฟล์ปฏิทิน (.ics) ครั้งเดียว</button>
    <button class="btn danger" id="cfOff">ปิดการซิงก์ปฏิทิน</button>
  `);
  $('#cfSub').addEventListener('click', () => { location.href = calFeedUrl(calFeedLocal().token); });
  $('#cfCopy').addEventListener('click', async () => {
    const url = calFeedUrl(calFeedLocal().token, 'https');
    try { await navigator.clipboard.writeText(url); toast('คัดลอกลิงก์แล้ว'); } catch (e) { prompt('คัดลอกลิงก์ปฏิทิน', url); }
  });
  $('#cfNew').addEventListener('click', async () => {
    if (!confirm('สร้างลิงก์ใหม่? ปฏิทินที่สมัครด้วยลิงก์เดิมจะหยุดอัปเดต ต้องสมัครใหม่ทุกเครื่อง')) return;
    try {
      const r = await api('POST', '/calendar/token');
      setCalFeedLocal({ token: r.token, updatedAt: r.updatedAt, sent: null });
      await calFeedSend(true);
      calFeedSheet();
      toast('สร้างลิงก์ใหม่แล้ว กดสมัครอีกครั้ง');
    } catch (e) { toast(cloudErr(e)); }
  });
  $('#cfOff').addEventListener('click', async () => {
    if (!confirm('ปิดการซิงก์? ปฏิทินที่สมัครไว้จะหยุดอัปเดต (ลบปฏิทินออกได้ที่ การตั้งค่า › ปฏิทิน › บัญชี)')) return;
    try {
      await api('DELETE', '/calendar');
      setCalFeedLocal(null);
      closeSheet();
      render();
      toast('ปิดการซิงก์ปฏิทินแล้ว');
    } catch (e) { toast(cloudErr(e)); }
  });
}
