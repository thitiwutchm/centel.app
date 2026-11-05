/* Profiles: one sign-in can hold more than one profile (e.g. ส่วนตัว and ร้านกาแฟ), and each
   profile is fully separate: its own wallets, transactions, bills, budgets, labels, categories,
   to-dos, chat and partner link. Nothing is shared or added up across profiles. On the server
   a profile is its own user (server/src/profiles.js), so switching swaps this device's session
   to the other profile and reloads the app with that profile's data.
   Loaded after cloud.js; uses its api(), planner helpers and the sheet helpers in app.js. */

const PROFILE_EMOJIS = ['🙂', '💼', '🏪', '☕', '🏠', '👪', '🎓', '✈️', '🐶', '🌸', '💰', '🛒'];
const PROFILE_ERRORS = {
  too_many_profiles: 'มีโปรไฟล์ครบจำนวนแล้ว',
  main_profile: 'ลบโปรไฟล์หลักไม่ได้',
  current_profile: 'สลับไปโปรไฟล์อื่นก่อนแล้วค่อยลบ',
  profile_linked: 'โปรไฟล์นี้ยังมีรายจ่ายร่วมกับคู่ ลบไม่ได้',
};
function profileErr(e) { return PROFILE_ERRORS[e.message] || cloudErr(e); }

function profilesList() { return (isCloud() && Array.isArray(cloud.profiles) && cloud.profiles.length) ? cloud.profiles : []; }

// Row under the account card: which profile is in use, and the way to the others.
function profileRow() {
  if (!isCloud()) return '';
  const list = profilesList();
  const others = list.filter((p) => !p.current);
  const faces = others.slice(0, 3).map((p) => userAvatar(p, 'avatar pf-mini')).join('');
  const sub = list.length > 1 ? `ใช้อยู่: ${cloud.user.nickname || cloud.user.name} · ${list.length} โปรไฟล์` : 'แยกข้อมูลเป็นหลายชุด เช่น ส่วนตัว / ธุรกิจ';
  return `
      <button class="item" data-action="profiles"><div class="ico round" style="background:#5b8cff22">🔄</div>
        <div class="main"><div class="name">สลับโปรไฟล์</div><div class="sub">${esc(sub)}</div></div>
        ${faces ? `<span class="pf-faces">${faces}</span>` : ''}${svgIcon('chev', 'svg-i sm muted')}</button>`;
}

// "Who's using?" grid: big round faces, the one in use ringed with a check. แก้ไข shows a
// remove badge on the profiles that can be deleted (not the main one, not the one in use).
function profilesSheet(editing = false) {
  if (!isCloud()) { loginSheet(); return; }
  const list = profilesList().length ? profilesList() : [{ ...cloud.user, main: true, current: true }];
  const max = (cloud.profilesMax || 5) + 1;
  const canEdit = list.some((p) => !p.main && !p.current);
  const tiles = list.map((p, i) => {
    const del = editing && !p.main && !p.current;
    return `
      <div class="pf-tile${p.current ? ' on' : ''}${del ? ' del' : ''}" style="--i:${i}">
        <button class="pf-face" ${del ? `data-pf-del="${esc(p.id)}" aria-label="ลบโปรไฟล์"` : `data-pf-switch="${esc(p.id)}"`}>
          ${userAvatar(p, 'avatar pf-av')}
          ${p.current ? '<span class="pf-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></span>' : ''}
          ${del ? '<span class="pf-minus" aria-hidden="true">−</span>' : ''}
        </button>
        <div class="pf-name">${esc(p.nickname || p.name)}</div>
        <div class="pf-sub">${p.current ? 'กำลังใช้' : p.main ? 'หลัก' : ''}</div>
      </div>`;
  }).join('');
  const add = !editing && list.length < max ? `
      <div class="pf-tile add" style="--i:${list.length}">
        <button class="pf-face" id="pfAdd" aria-label="เพิ่มโปรไฟล์"><span class="avatar pf-av pf-plus">＋</span></button>
        <div class="pf-name">เพิ่ม</div><div class="pf-sub"></div>
      </div>` : '';
  openSheet(`
    <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>สลับโปรไฟล์</h2>
      ${canEdit ? `<button class="link-btn${editing ? ' strong' : ''}" id="pfEdit">${editing ? 'เสร็จ' : 'แก้ไข'}</button>` : '<span style="width:40px"></span>'}</div>
    <div class="pf-grid">${tiles}${add}</div>
    <p class="hint pf-hint">${editing ? 'แตะโปรไฟล์ที่มีเครื่องหมาย − เพื่อลบ ข้อมูลในโปรไฟล์นั้นจะหายถาวร' : 'แต่ละโปรไฟล์แยกข้อมูลกันทั้งหมด ทั้งกระเป๋าเงิน รายการ บิล งบประมาณ หมวดหมู่ ป้ายกำกับ โน้ต และการเชื่อมบัญชีคู่ ไม่รวมยอดหรือใช้ร่วมกัน'}</p>
  `);
  $('#sheet').querySelectorAll('[data-pf-switch]').forEach((b) => b.addEventListener('click', () => switchProfile(b.dataset.pfSwitch)));
  $('#sheet').querySelectorAll('[data-pf-del]').forEach((b) => b.addEventListener('click', () => deleteProfile(b.dataset.pfDel)));
  const ed = $('#pfEdit');
  if (ed) ed.addEventListener('click', () => profilesSheet(!editing));
  const a = $('#pfAdd');
  if (a) a.addEventListener('click', newProfileSheet);
}

// Full-screen card while the app swaps to another profile; shown again for a moment after the reload.
const PF_SWITCH_KEY = 'centel.pfswitch';
function profileCurtain(p, text) {
  let el = document.getElementById('pfCurtain');
  if (!el) { el = document.createElement('div'); el.id = 'pfCurtain'; el.className = 'pf-curtain'; document.body.appendChild(el); }
  el.innerHTML = `<div class="pf-curtain-in">${userAvatar(p, 'avatar pf-big')}<b>${esc(p.nickname || p.name)}</b><span>${esc(text)}</span></div>`;
  requestAnimationFrame(() => el.classList.add('show'));
  return el;
}
(function profileWelcome() {
  let p = null;
  try { p = JSON.parse(sessionStorage.getItem(PF_SWITCH_KEY) || 'null'); sessionStorage.removeItem(PF_SWITCH_KEY); } catch (e) { /* ignore */ }
  if (!p) return;
  const show = () => {
    const el = profileCurtain(p, 'พร้อมใช้งาน');
    el.classList.add('show', 'done');
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 650);
  };
  // After every script has loaded (esc, userAvatar live in later files).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();

function newProfileSheet() {
  const d = { avatar: PROFILE_EMOJIS[1] };
  openSheet(`
    <div class="sheet-head"><button class="link-btn" id="pfBack">กลับ</button><h2>เพิ่มโปรไฟล์</h2><button class="link-btn strong" id="pfSave">สร้าง</button></div>
    <div class="w-pic"><div class="avatar pf-big" id="pfFace"></div></div>
    <div class="chips w-emojis" id="pfEmojis">${PROFILE_EMOJIS.map((e) => `<button type="button" class="chip emoji" data-pfemoji="${e}">${e}</button>`).join('')}</div>
    <div class="form">
      <div class="field"><label for="pfName">ชื่อโปรไฟล์</label><input id="pfName" maxlength="60" placeholder="เช่น ธุรกิจ, ร้านกาแฟ"></div>
    </div>
    <p class="hint">โปรไฟล์ใหม่เริ่มว่างเปล่า มีกระเป๋าเงินสด หมวดหมู่ตั้งต้น และไม่มีข้อมูลจากโปรไฟล์อื่น เปลี่ยนรูปและชื่อได้ภายหลังจากการ์ดบัญชี</p>
  `);
  const paint = () => {
    $('#pfFace').textContent = d.avatar;
    $('#sheet').querySelectorAll('[data-pfemoji]').forEach((x) => x.classList.toggle('on', x.dataset.pfemoji === d.avatar));
  };
  paint();
  $('#pfBack').addEventListener('click', () => profilesSheet());
  $('#pfEmojis').addEventListener('click', (e) => { const c = e.target.closest('[data-pfemoji]'); if (c) { d.avatar = c.dataset.pfemoji; paint(); } });
  $('#pfSave').addEventListener('click', async () => {
    const name = $('#pfName').value.trim();
    if (!name) { toast('กรุณาใส่ชื่อโปรไฟล์'); $('#pfName').focus(); return; }
    const btn = $('#pfSave');
    btn.disabled = true;
    try {
      const r = await api('POST', '/profiles', { name, avatar: d.avatar });
      cloud.profiles = [...profilesList(), { id: r.id, name, nickname: name.slice(0, 20), avatar: d.avatar, main: false, current: false }];
      await switchProfile(r.id, true);
    } catch (e) {
      toast(profileErr(e));
    } finally {
      btn.disabled = false;
    }
  });
}

let switchingProfile = false;
async function switchProfile(id, created = false) {
  if (!isCloud() || switchingProfile) return;
  if (cloud.user && id === cloud.user.id) { closeSheet(); return; }
  switchingProfile = true;
  try {
    // This profile's unsent changes go up first, so nothing of it stays behind on this device.
    await cloud.queue;
    if (!cloud.fresh) await cloudRefresh();
    clearTimeout(planner.timer);
    if (planner.sending) await planner.sending;
    await plannerSend();
    const base = plannerBase(cloud.user.id);
    if (!base || !sameJson(plannerDoc(state), base.data)) { toast('ยังบันทึกบิลของโปรไฟล์นี้ขึ้นบัญชีไม่ได้ ลองใหม่เมื่อออนไลน์'); return; }
    const target = profilesList().find((x) => x.id === id) || { id, name: created || '', avatar: undefined };
    closeSheet();
    profileCurtain(target, created ? 'กำลังสร้างโปรไฟล์…' : 'กำลังเปิดโปรไฟล์…');
    await api('POST', '/profiles/switch', { id });
    try { sessionStorage.setItem(PF_SWITCH_KEY, JSON.stringify({ name: target.name, nickname: target.nickname, avatar: target.avatar })); } catch (e) { /* ignore */ }
    await profileLoadAndReload();
  } catch (e) {
    const c = document.getElementById('pfCurtain');
    if (c) { c.classList.remove('show'); setTimeout(() => c.remove(), 400); }
    toast(profileErr(e));
  } finally {
    switchingProfile = false;
  }
}

// Puts the new profile's own copy on this device, then starts the app again on it, so no
// screen, chat connection or cached value of the previous profile is left running.
async function profileLoadAndReload() {
  try {
    const b = await api('GET', '/bootstrap');
    const rdoc = b.planner && b.planner.data ? { ...emptyPlanner(), ...b.planner.data } : emptyPlanner();
    localStorage.setItem(CLOUD_KEY, JSON.stringify({ ...b, planner: undefined }));
    setPlannerBase(b.user.id, (b.planner && b.planner.rev) || 0, rdoc);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rdoc, settings: { ...defaultState().settings, ...rdoc.settings } }));
  } catch (e) {
    // Offline right after switching: start empty and let the app fetch it.
    try {
      localStorage.removeItem(CLOUD_KEY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultState()));
    } catch (err) { /* ignore */ }
  }
  ui.wallet = 'total';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  location.reload();
}

async function deleteProfile(id) {
  const p = profilesList().find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`ลบโปรไฟล์ "${p.name}"? ข้อมูลทั้งหมดในโปรไฟล์นี้จะถูกลบถาวร กู้คืนไม่ได้`)) return;
  try {
    await api('DELETE', `/profiles/${encodeURIComponent(id)}`);
    cloud.profiles = profilesList().filter((x) => x.id !== id);
    toast('ลบโปรไฟล์แล้ว');
    profilesSheet(profilesList().some((x) => !x.main && !x.current));
    render();
  } catch (e) {
    toast(profileErr(e));
  }
}
