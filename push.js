'use strict';

/* ---------- iPhone notifications (Web Push) ----------
 * Signed in, a device can turn on notifications in Account › การแจ้งเตือน. On iPhone this
 * needs iOS 16.4+ and the app opened from its Home Screen icon (Safari tabs cannot get push).
 * The subscription goes to /api/push/subscribe; the server then pushes:
 *  - to-do notes when their reminder is due (same job as the LINE reminders),
 *  - bills: bills live on the device, so this file sends the device's upcoming bill alerts
 *    (09:00 on the remind-before day and on the due day) to /api/push/alerts whenever bills
 *    change, and the server sends each one when its time comes, even with the app closed,
 *  - a new shared expense the partner added.
 * sw.js shows the notification and opens the app when it is tapped.
 * Inside the iOS app (ios-app/, Capacitor) there is no Web Push, so the same switch asks
 * iOS for permission through @capacitor/push-notifications and sends the APNs device token
 * to /api/push/apns instead; the server sends the same notifications through Apple.
 * Loaded after calfeed.js and before app.js; `state`, `occurrences`, `api` are looked up at call time.
 */

const PUSH_KEY = 'centel.push.v1'; // { userId, endpoint, sent: hash of the last alert list }
const DEVICE_KEY = 'centel.device.v1';

const push = { on: null, busy: false, timer: null, checking: false };

// The iOS app's push plugin, when running inside it.
function pushNative() {
  const c = window.Capacitor;
  return c && c.isNativePlatform && c.isNativePlatform() && c.Plugins && c.Plugins.PushNotifications;
}

function pushSupported() {
  if (pushNative()) return true;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
}
function pushStandalone() {
  return window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
}
function pushIsIos() { return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

function pushDevice() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch (e) { return 'device'; }
}

function pushLocal() {
  try {
    const p = JSON.parse(localStorage.getItem(PUSH_KEY) || 'null');
    return p && cloud.user && p.userId === cloud.user.id ? p : null;
  } catch (e) { return null; }
}
function setPushLocal(p) {
  try {
    if (p) localStorage.setItem(PUSH_KEY, JSON.stringify({ userId: cloud.user.id, ...p }));
    else localStorage.removeItem(PUSH_KEY);
  } catch (e) { /* full */ }
}

function pushKeyBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// Is this device subscribed right now? Updates the Account tab when the answer changes.
async function pushCheck() {
  if (!pushSupported() || !isCloud() || push.checking) return;
  if (pushNative()) return pushNativeCheck();
  push.checking = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const on = !!sub && Notification.permission === 'granted' && !!pushLocal();
    if (sub && !pushLocal() && Notification.permission === 'granted') {
      // Subscribed for another account on this device, or the local note was cleared: send it again.
      await api('POST', '/push/subscribe', { subscription: sub.toJSON(), device: pushDevice() });
      setPushLocal({ endpoint: sub.endpoint, sent: null });
      push.on = true;
    } else if (push.on !== on) {
      push.on = on;
    } else return;
    if (ui.tab === 'account') { const y = window.scrollY; render(); window.scrollTo(0, y); }
    pushAlertsChanged(0);
  } catch (e) { /* offline */ } finally {
    push.checking = false;
  }
}

async function pushEnable() {
  if (push.busy) return;
  if (!isCloud()) { toast('ต้องเข้าสู่ระบบก่อน'); return; }
  if (pushNative()) return pushNativeEnable();
  push.busy = true;
  try {
    // Must be asked straight from the tap, before anything else awaits on iPhone.
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast(perm === 'denied' ? 'การแจ้งเตือนถูกปิดไว้ เปิดได้ที่ การตั้งค่า › การแจ้งเตือน › Centel' : 'ยังไม่ได้อนุญาตการแจ้งเตือน');
      return;
    }
    const { publicKey } = await api('GET', '/push');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(publicKey) });
    await api('POST', '/push/subscribe', { subscription: sub.toJSON(), device: pushDevice() });
    setPushLocal({ endpoint: sub.endpoint, sent: null });
    push.on = true;
    toast('เปิดการแจ้งเตือนแล้ว');
    pushAlertsChanged(0);
  } catch (e) {
    toast(e.status ? cloudErr(e) : 'เปิดการแจ้งเตือนไม่สำเร็จ');
  } finally {
    push.busy = false;
    if (ui.tab === 'account') { const y = window.scrollY; render(); window.scrollTo(0, y); }
  }
}

async function pushDisable() {
  if (push.busy) return;
  if (pushNative()) return pushNativeDisable();
  push.busy = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('DELETE', '/push/subscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    await api('PUT', '/push/alerts', { device: pushDevice(), alerts: [] }).catch(() => {});
    setPushLocal(null);
    push.on = false;
    toast('ปิดการแจ้งเตือนแล้ว');
  } catch (e) { toast('ทำรายการไม่สำเร็จ'); } finally {
    push.busy = false;
    if (ui.tab === 'account') { const y = window.scrollY; render(); window.scrollTo(0, y); }
  }
}

/* ---------- Inside the iOS app: APNs ---------- */

// iOS hands out the device token after register(); it can change (restore, reinstall),
// so the app registers again on every start and sends it whenever it differs.
let pushTokenWait = null;
function pushNativeToken() {
  const P = pushNative();
  if (pushTokenWait) return pushTokenWait;
  pushTokenWait = new Promise((resolve, reject) => {
    let done = false;
    const end = (fn, v) => { if (!done) { done = true; pushTokenWait = null; fn(v); } };
    pushNativeListen();
    push.onToken = (t) => end(resolve, t);
    push.onTokenErr = (e) => end(reject, e);
    setTimeout(() => end(reject, new Error('timeout')), 20000);
    P.register().catch((e) => end(reject, e));
  });
  return pushTokenWait;
}

let pushListening = false;
function pushNativeListen() {
  const P = pushNative();
  if (!P || pushListening) return;
  pushListening = true;
  P.addListener('registration', (t) => push.onToken && push.onToken(t.value));
  P.addListener('registrationError', (e) => push.onTokenErr && push.onTokenErr(new Error(e.error || 'registration')));
  // Tapped a notification: open what it points at, as sw.js does in the Home Screen app.
  P.addListener('pushNotificationActionPerformed', (a) => {
    const url = (a && a.notification && a.notification.data && a.notification.data.url) || '/';
    pushOpenUrl(url);
  });
}

function pushOpenUrl(url) {
  const m = /#chat-(couple|ai|sec)$/.exec(url);
  if (m && typeof openChat === 'function') { openChat(m[1]); return; }
  if (ui.tab !== 'home' && url === '/') { ui.tab = 'home'; render(); }
}

async function pushNativeSend(token) {
  await api('POST', '/push/apns', { token, device: pushDevice() });
  const cur = pushLocal();
  setPushLocal({ token, sent: cur && cur.token === token ? cur.sent : null });
}

async function pushNativeCheck() {
  if (push.checking) return;
  push.checking = true;
  try {
    const P = pushNative();
    pushNativeListen();
    const perm = (await P.checkPermissions()).receive;
    const local = pushLocal();
    const on = perm === 'granted' && !!local;
    if (on && !push.tokenChecked) {
      // Once per app start: ask iOS for the current token and send it when it changed.
      const token = await pushNativeToken();
      if (token !== local.token) await pushNativeSend(token);
      push.tokenChecked = true;
    }
    if (push.on !== on) {
      push.on = on;
      if (ui.tab === 'account') { const y = window.scrollY; render(); window.scrollTo(0, y); }
    }
    pushAlertsChanged(0);
  } catch (e) { /* offline */ } finally {
    push.checking = false;
  }
}

async function pushNativeEnable() {
  push.busy = true;
  try {
    const P = pushNative();
    if (cloud.features && cloud.features.apns === false) { toast('เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า Apple Push'); return; }
    let perm = (await P.checkPermissions()).receive;
    if (perm !== 'granted' && perm !== 'denied') perm = (await P.requestPermissions()).receive;
    if (perm !== 'granted') {
      toast(perm === 'denied' ? 'การแจ้งเตือนถูกปิดไว้ เปิดได้ที่ การตั้งค่า › การแจ้งเตือน › Centel' : 'ยังไม่ได้อนุญาตการแจ้งเตือน');
      return;
    }
    await pushNativeSend(await pushNativeToken());
    push.tokenChecked = true;
    push.on = true;
    toast('เปิดการแจ้งเตือนแล้ว');
    pushAlertsChanged(0);
  } catch (e) {
    toast(e.status ? (e.message === 'apns_off' ? 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า Apple Push' : cloudErr(e)) : 'เปิดการแจ้งเตือนไม่สำเร็จ');
  } finally {
    push.busy = false;
    if (ui.tab === 'account') { const y = window.scrollY; render(); window.scrollTo(0, y); }
  }
}

async function pushNativeDisable() {
  push.busy = true;
  try {
    const cur = pushLocal();
    if (cur && cur.token) await api('DELETE', '/push/apns', { token: cur.token }).catch(() => {});
    await api('PUT', '/push/alerts', { device: pushDevice(), alerts: [] }).catch(() => {});
    setPushLocal(null);
    push.on = false;
    toast('ปิดการแจ้งเตือนแล้ว');
  } catch (e) { toast('ทำรายการไม่สำเร็จ'); } finally {
    push.busy = false;
    if (ui.tab === 'account') { const y = window.scrollY; render(); window.scrollTo(0, y); }
  }
}

/* Bill alerts for the next two months: 09:00 on the remind-before day and on the due day,
   for unpaid bills that are not autopay. Keys stay the same while the bill and its due
   date stay the same, so the server sends each one once. */
function pushBillAlerts() {
  const now = Date.now();
  const until = now + 62 * 86400000;
  const out = [];
  const add = (key, at, title, body) => {
    if (at.getTime() < now - 86400000 || at.getTime() > until) return;
    out.push({ key, at: at.toISOString(), title, body, url: '/' });
  };
  const ym0 = ymOf(new Date());
  [0, 1, 2].map((n) => addMonths(ym0, n)).forEach((ym) => {
    occurrences(ym).forEach((o) => {
      if (o.paid || o.bill.autopay) return;
      const b = o.bill;
      const body = [o.needsAmount ? tr('ระบุยอด') : baht(o.amount), tr(cat(b).label)].join(' · ');
      const at9 = (days) => { const d = new Date(o.due); d.setDate(d.getDate() - days); d.setHours(9, 0, 0, 0); return d; };
      const remind = remindOf(b);
      if (remind > 0) add(`bill:${b.id}:${ym}:r${remind}`, at9(remind), `⏰ ${tr(`อีก ${remind} วันครบกำหนด ${b.name}`)}`, body);
      add(`bill:${b.id}:${ym}:due`, at9(0), `📅 ${tr(`วันนี้ครบกำหนด ${b.name}`)}`, body);
    });
  });
  return out.slice(0, 500);
}

function pushHash(list) {
  const s = JSON.stringify(list);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// Called by save() in app.js, on start and when the app comes back to the screen.
function pushAlertsChanged(delay = 1500) {
  if (!isCloud() || !pushLocal()) return;
  clearTimeout(push.timer);
  push.timer = setTimeout(pushAlertsSend, delay);
}

async function pushAlertsSend() {
  const cur = pushLocal();
  if (!isCloud() || !cur) return;
  const alerts = pushBillAlerts();
  const hash = pushHash(alerts);
  if (cur.sent === hash) return;
  try {
    await api('PUT', '/push/alerts', { device: pushDevice(), alerts });
    setPushLocal({ ...cur, sent: hash });
  } catch (e) { /* offline: sent next time */ }
}

// The block in Account › การแจ้งเตือน.
function pushSettings() {
  if (isCloud() && pushSupported()) setTimeout(pushCheck, 0);
  let hint;
  let can = false;
  if (!pushSupported()) {
    hint = pushIsIos() && !pushStandalone()
      ? 'บน iPhone ต้องเพิ่มแอปไปยังหน้าจอโฮมก่อน (Safari › แชร์ › เพิ่มไปยังหน้าจอโฮม) แล้วเปิดจากไอคอน จึงจะเปิดการแจ้งเตือนได้ (iOS 16.4 ขึ้นไป)'
      : 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน';
  } else if (!isCloud()) {
    hint = 'ต้องเข้าสู่ระบบก่อน การแจ้งเตือนส่งมาจากเซิร์ฟเวอร์ จึงเด้งได้แม้ปิดแอปอยู่';
  } else if (!pushNative() && Notification.permission === 'denied') {
    hint = 'การแจ้งเตือนถูกปิดไว้ เปิดได้ที่ การตั้งค่า › การแจ้งเตือน › Centel';
  } else {
    can = true;
    hint = push.on
      ? 'จะเด้งเตือนบนเครื่องนี้เมื่อ บิลใกล้ครบกำหนด (09:00 ของวันเตือนล่วงหน้าและวันครบกำหนด) · โน้ตสิ่งที่ต้องทำถึงเวลาเตือน · คู่ของคุณเพิ่มรายจ่ายร่วม'
      : 'เปิดแล้วจะเด้งเตือนแม้ปิดแอปอยู่: บิลใกล้ครบกำหนด โน้ตสิ่งที่ต้องทำที่ตั้งเตือนไว้ และเมื่อคู่ของคุณเพิ่มรายจ่ายร่วม';
  }
  return `
    <div class="form">
      <div class="field"><label for="pushOn">แจ้งเตือนบนเครื่องนี้</label><span style="flex:1"></span>
        <label class="switch"><input type="checkbox" id="pushOn" ${push.on ? 'checked' : ''} ${can && !push.busy ? '' : 'disabled'}><span></span></label></div>
    </div>
    ${push.on ? '<button class="btn ghost" id="pushTest">🔔 ส่งแจ้งเตือนทดสอบ</button>' : ''}
    <p class="hint">${hint}</p>`;
}

function pushSettingsBind() {
  const sw = $('#pushOn');
  if (sw) sw.addEventListener('change', (e) => { if (e.target.checked) pushEnable(); else pushDisable(); });
  const test = $('#pushTest');
  if (test) test.addEventListener('click', async () => {
    test.disabled = true;
    try { await api('POST', '/push/test'); toast('ส่งแล้ว ดูการแจ้งเตือนบนเครื่อง'); } catch (e) {
      toast(e.message === 'no_device' ? 'ไม่พบเครื่องที่เปิดการแจ้งเตือน ลองปิดแล้วเปิดใหม่' : cloudErr(e));
    }
    test.disabled = false;
  });
}

// In the iOS app: listen for taps on notifications from the start (iOS keeps the tap that
// opened the app until a listener takes it), and refresh the device token once signed in.
if (pushNative()) {
  setTimeout(pushNativeListen, 0);
  let tries = 0;
  const wait = setInterval(() => { if (isCloud() || ++tries > 30) { clearInterval(wait); if (isCloud()) pushCheck(); } }, 1000);
}
