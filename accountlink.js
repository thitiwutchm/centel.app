'use strict';

/* Centel Account link (account.centel.app → this app). A business in the accounting app sends its
   reminders here: tax deadlines (ภ.พ.30, ภ.ง.ด.1/3/53), paying suppliers, collecting from
   customers, anything else, and unpaid documents coming due. Each one shows up as a to-do with a
   reminder a week before it is due, so the usual notification / LINE group / chat reminder sends it.
   Linking: the accounting app shows a code and a link to centel.app/#link-account=CODE. Opening it
   (or typing the code in Account › การแจ้งเตือน › Centel Account) asks this signed-in profile to
   allow it. Server: server/src/acc/centel.js (/api/acc-link). Loaded after app.js. */

(() => {
  const al = { links: null, at: 0, pending: '' };
  const ready = () => isCloud() && cloud.user;
  const clean = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fmt = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
  const ERR = { code_gone: 'รหัสหมดอายุหรือถูกใช้แล้ว ขอรหัสใหม่ใน Centel Account', not_found: 'ไม่พบการเชื่อมต่อนี้' };
  const errText = (e) => ERR[e.message] || cloudErr(e);

  async function load(force) {
    if (!ready() || (!force && Date.now() - al.at < 60000)) return;
    al.at = Date.now();
    try {
      al.links = (await api('GET', '/acc-link')).links;
      if (ui.tab === 'account') render();
    } catch (e) { /* offline */ }
  }

  /* ---------- Approving a code ---------- */

  async function ask(code) {
    if (!ready()) {
      al.pending = code;
      toast('เข้าสู่ระบบ Centel ก่อน แล้วจะถามเรื่องการเชื่อมต่ออีกครั้ง');
      return;
    }
    al.pending = '';
    let info;
    try { info = await api('GET', `/acc-link/code/${code}`); } catch (e) { toast(errText(e)); return; }
    const who = cloud.user.nickname || cloud.user.name || cloud.user.email || '';
    openSheet(`
      <div class="sheet-head">${CLOSE_X}<h2>เชื่อมต่อ Centel Account</h2><span style="width:40px"></span></div>
      <div class="al-ask">
        <div class="al-logos">${info.logo ? `<img src="${esc(info.logo)}" alt="">` : `<span class="al-biz">${esc((info.business || '?').replace(/^(บริษัท|ห้างหุ้นส่วน(จำกัด|สามัญ)?|หจก\.?|บจก\.?)\s*/, '').replace(/^[เแโใไ]/, '').slice(0, 1))}</span>`}
          <span class="al-plus">⇄</span><span class="al-c">C</span></div>
        <h3>${esc(info.business)}</h3>
        <p class="muted">ขอส่งการแจ้งเตือนจาก Centel Account (ยื่นภาษี จ่ายคู่ค้า รับเงินลูกค้า และอื่นๆ) มาเป็นสิ่งที่ต้องทำและแจ้งเตือนใน Centel ของ <b>${esc(who)}</b></p>
        <p class="hint">ขอโดย ${esc(info.by || '')}${info.email ? ` (${esc(info.email)})` : ''} · รหัส <span style="white-space:nowrap">${fmt(code)}</span><br>Centel Account จะเพิ่มได้แค่สิ่งที่ต้องทำของกิจการนี้ ไม่เห็นข้อมูลเงินหรือรายการอื่นในแอป · ยกเลิกได้ทุกเมื่อที่ บัญชี › การแจ้งเตือน › Centel Account</p>
        <button class="btn" id="alAllow">อนุญาต</button>
        <button class="btn ghost" data-action="close">ไม่อนุญาต</button>
      </div>`);
    $('#alAllow').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('POST', '/acc-link/approve', { code });
        toast(`เชื่อมต่อ ${r.business} แล้ว`);
        closeSheet();
        await load(true);
        if (typeof cloudRefresh === 'function') cloudRefresh().catch(() => {});
      } catch (err) { toast(errText(err)); e.target.disabled = false; }
    });
  }

  // centel.app/#link-account=CODE (from the accounting app's เปิด Centel เพื่ออนุญาต button).
  function fromHash() {
    const m = location.hash.match(/link-account=([A-Za-z0-9-]{8,9})/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    const code = clean(m[1]);
    if (code.length === 8) setTimeout(() => ask(code), 600);
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
  // Signed in after opening the link: ask then.
  const baseRender = window.render;
  window.render = function () {
    const out = baseRender.apply(this, arguments);
    if (al.pending && ready()) ask(al.pending);
    if (ready() && ui.tab === 'account') load();
    return out;
  };

  /* ---------- Account › การแจ้งเตือน › Centel Account ---------- */

  window.accLinkRow = () => (ready()
    ? setRow({ set: 'acclink', ico: '🧾', color: '#f76707', name: 'Centel Account', sub: 'แจ้งเตือนภาษีและกำหนดจ่ายจากระบบบัญชี', value: al.links && al.links.length ? `${al.links.length} กิจการ` : 'ยังไม่เชื่อม' })
    : '');

  SET_SHEETS.acclink = ['Centel Account', () => {
    const list = al.links || [];
    return `
      ${list.length ? `<div class="section-title">กิจการที่เชื่อมต่อ</div><div class="list">${list.map((l) => `
        <div class="item al-row">${l.logo ? `<img class="al-logo" src="${esc(l.logo)}" alt="">` : `<span class="al-biz sm">${esc((l.business || '?').replace(/^(บริษัท|ห้างหุ้นส่วน(จำกัด|สามัญ)?|หจก\.?|บจก\.?)\s*/, '').replace(/^[เแโใไ]/, '').slice(0, 1))}</span>`}
          <div class="main"><div class="name">${esc(l.business)}</div><div class="sub">${l.reminders} การแจ้งเตือนที่เปิดอยู่</div></div>
          <button class="link-btn al-off" data-al-off="${esc(l.id)}">ยกเลิก</button></div>`).join('')}</div>` : ''}
      <div class="section-title">เชื่อมต่อกิจการ</div>
      <div class="form">
        <div class="field"><label for="alCode">รหัสจาก Centel Account</label><input id="alCode" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" maxlength="9" style="text-transform:uppercase"></div>
      </div>
      <button class="btn" id="alGo">ถัดไป</button>
      <p class="hint">ใน <b>account.centel.app</b> ไปที่ การแจ้งเตือน › เชื่อมต่อกับ Centel แล้วกด "เปิด Centel เพื่ออนุญาต" หรือพิมพ์รหัสที่แสดงที่นี่ · การแจ้งเตือนจะขึ้นเป็นสิ่งที่ต้องทำล่วงหน้า 7 วัน และเด้งตามเวลาที่ตั้งไว้ (เปิด แจ้งเตือนบนเครื่องนี้ และกลุ่ม LINE ได้ในหน้านี้)</p>`;
  }];

  window.accLinkBind = () => {
    load();
    const go = $('#alGo');
    if (go) go.addEventListener('click', () => {
      const c = clean($('#alCode').value);
      if (c.length !== 8) { toast('รหัสมี 8 ตัวอักษร'); return; }
      ask(c);
    });
    document.querySelectorAll('[data-al-off]').forEach((b) => b.addEventListener('click', async () => {
      const l = (al.links || []).find((x) => x.id === b.dataset.alOff);
      if (!l || !confirm(`ยกเลิกการเชื่อมต่อ ${l.business}? สิ่งที่ต้องทำที่ยังไม่ถึงเวลาเตือนจะถูกเอาออก`)) return;
      try {
        await api('DELETE', `/acc-link/${l.id}`);
        toast('ยกเลิกการเชื่อมต่อแล้ว');
        await load(true);
        settingsSheet('acclink', true);
        if (typeof cloudRefresh === 'function') cloudRefresh().catch(() => {});
      } catch (e) { toast(errText(e)); }
    }));
  };
})();
