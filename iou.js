'use strict';

/* ติดเงิน (IOU): money someone lent me or paid for me first, or that I lent or paid for
   someone. It is only a note of who owes whom and for what: it never moves a wallet and is
   never counted in a total, a budget or a report. It is the 4th choice in the add sheet
   (รายจ่าย · รายรับ · โอนเงิน · ติดเงิน).

   money.ious = [{ id, dir, kind, person, amount, date, due?, note?, repaid: [{ id, date, amount, txnId? }] }]
     dir:  'owed' = เขาติดฉัน (they owe me) · 'owe' = ฉันติดเขา (I owe them)
     kind: 'loan' = ยืมเงิน · 'advance' = สำรองจ่าย (paid for the other first)
   When money comes back the person can also record it in a wallet (an income or an expense,
   through the usual add sheet); that entry's id is kept on the repayment as txnId.
   Signed in, rows sync through /api/ious (server/migrations/043_ious.sql). */

function iouLeft(o) {
  const paid = (o.repaid || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return Math.max(0, Math.round((o.amount - paid) * 100) / 100);
}
const iouOpen = (o) => iouLeft(o) > 0;
// One line saying what happened, e.g. "บอล ยืมเงินฉัน", "ฉันสำรองจ่ายให้ บอล".
function iouLine(o) {
  const p = o.person || 'ใครสักคน';
  if (o.dir === 'owed') return o.kind === 'advance' ? `ฉันสำรองจ่ายให้ ${p}` : `${p} ยืมเงินฉัน`;
  return o.kind === 'advance' ? `${p} สำรองจ่ายให้ฉัน` : `ฉันยืมเงิน ${p}`;
}
function iouTotals() {
  const t = { owed: 0, owe: 0, n: 0 };
  (money.ious || []).forEach((o) => { const l = iouLeft(o); if (l > 0) { t[o.dir] += l; t.n++; } });
  t.owed = Math.round(t.owed * 100) / 100;
  t.owe = Math.round(t.owe * 100) / 100;
  return t;
}
// Names used before, most recent first, for the quick-pick chips.
function iouPeople() {
  const seen = new Map();
  [...(money.ious || [])].sort((a, b) => b.date.localeCompare(a.date)).forEach((o) => {
    const k = o.person.trim().toLowerCase();
    if (k && !seen.has(k)) seen.set(k, o.person.trim());
  });
  if (typeof cloud !== 'undefined' && cloud.partner && !seen.has(partnerName().toLowerCase())) seen.set(partnerName().toLowerCase(), partnerName());
  return [...seen.values()].slice(0, 8);
}

function saveIou(o) {
  money.ious = money.ious || [];
  upsert(money.ious, o);
  if (isCloud()) cloudCall('PUT', `/ious/${o.id}`, o); else saveMoney();
}
function deleteIou(o) {
  money.ious = (money.ious || []).filter((x) => x.id !== o.id);
  if (isCloud()) cloudCall('DELETE', `/ious/${o.id}`); else saveMoney();
}

const IOU_ICON = '<path d="M7 10.5 4 13.5l3 3M4 13.5h9M17 13.5l3-3-3-3M20 10.5h-9"/>';
const IOU_EMOJI = { owed: '🫴', owe: '🙏' };

function iouRow(o) {
  const left = iouLeft(o);
  const done = left <= 0;
  const part = !done && left < o.amount;
  return `
    <button class="item iou-item${done ? ' done' : ''}" data-iou="${o.id}">
      <div class="ico round iou-ico ${o.dir}">${IOU_EMOJI[o.dir]}</div>
      <div class="main"><div class="name"><span translate="no">${esc(o.note || (o.kind === 'advance' ? 'สำรองจ่าย' : 'ยืมเงิน'))}</span></div>
        <div class="sub">${esc(iouLine(o))} · ${thDate(o.date)}${o.due && !done ? ` · กำหนดคืน ${thDate(o.due)}` : ''}</div></div>
      <div class="right"><div class="amt iou-amt ${o.dir}">${done ? 'คืนครบแล้ว' : masked(baht(left))}</div>
        ${part ? `<div class="sub">เต็ม ${baht(o.amount)}</div>` : done ? `<div class="sub">${baht(o.amount)}</div>` : ''}</div>
    </button>`;
}

// The two totals side by side: what others owe me, and what I owe.
function iouTiles(t = iouTotals()) {
  return `<div class="iou-tiles">
      <button type="button" class="iou-tile owed" data-action="ious" data-dir="owed"><span>${IOU_EMOJI.owed} เขาติดฉัน</span><b>${masked(baht(t.owed))}</b></button>
      <button type="button" class="iou-tile owe" data-action="ious" data-dir="owe"><span>${IOU_EMOJI.owe} ฉันติดเขา</span><b>${masked(baht(t.owe))}</b></button>
    </div>`;
}

// Home: shown while anything is still owed either way.
function iouCard() {
  const t = iouTotals();
  if (!t.n) return '';
  const open = (money.ious || []).filter(iouOpen).sort((a, b) => (a.due || a.date).localeCompare(b.due || b.date)).slice(0, 3);
  return `
    <div class="section-row"><span>ติดเงิน</span><button class="link-btn" data-action="ious">ดูทั้งหมด</button></div>
    <div class="card list-card iou-card">
      ${iouTiles(t)}
      ${open.map(iouRow).join('')}
    </div>`;
}

/* ---------- List ---------- */

function iouListSheet(dir = '') {
  let filter = dir;
  let showDone = false;
  const paint = () => {
    const all = money.ious || [];
    const list = all.filter((o) => !filter || o.dir === filter);
    const open = list.filter(iouOpen);
    const done = list.filter((o) => !iouOpen(o)).sort((a, b) => b.date.localeCompare(a.date));
    // Outstanding items grouped by person, the person owing the most first.
    const groups = new Map();
    open.forEach((o) => {
      const k = o.person.trim().toLowerCase();
      if (!groups.has(k)) groups.set(k, { name: o.person.trim(), items: [], net: 0 });
      const g = groups.get(k);
      g.items.push(o);
      g.net += (o.dir === 'owed' ? 1 : -1) * iouLeft(o);
    });
    const gl = [...groups.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    gl.forEach((g) => g.items.sort((a, b) => a.date.localeCompare(b.date)));
    $('#iouBody').innerHTML = `
      ${iouTiles()}
      <div class="chips filters iou-filters">
        <button type="button" class="chip ${!filter ? 'on' : ''}" data-iou-f="">ทั้งหมด</button>
        <button type="button" class="chip ${filter === 'owed' ? 'on' : ''}" data-iou-f="owed">เขาติดฉัน</button>
        <button type="button" class="chip ${filter === 'owe' ? 'on' : ''}" data-iou-f="owe">ฉันติดเขา</button>
      </div>
      ${gl.length ? gl.map((g) => `
        <div class="section-row iou-person"><span translate="no">${esc(g.name)}</span>
          <b class="iou-net ${g.net >= 0 ? 'owed' : 'owe'}">${g.net >= 0 ? 'ติดฉัน' : 'ฉันติด'} ${masked(baht(Math.abs(Math.round(g.net * 100) / 100)))}</b></div>
        <div class="card list-card">${g.items.map(iouRow).join('')}</div>`).join('') : `
        <div class="card empty-card">
          <div class="e-ico">🤝</div>
          <b>${all.length ? 'ไม่มีเงินค้างอยู่' : 'ยังไม่มีรายการติดเงิน'}</b>
          <div class="muted small">จดไว้ว่าใครยืมเงิน หรือใครสำรองจ่ายอะไรให้ใคร ไม่หักจากกระเป๋าเงินและไม่นับในรายงาน</div>
        </div>`}
      ${done.length ? `
        <button type="button" class="section-row iou-done-toggle" id="iouDoneT"><span>คืนครบแล้ว (${done.length})</span>${svgIcon('chev', `svg-i sm${showDone ? ' down' : ''}`)}</button>
        ${showDone ? `<div class="card list-card">${done.map(iouRow).join('')}</div>` : ''}` : ''}`;
  };
  openSheet(`
    <div class="sheet-head">
      <button class="close-x" data-action="close" aria-label="ปิด"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>
      <h2>ติดเงิน</h2>
      <button class="link-btn strong" id="iouAdd">＋ เพิ่ม</button>
    </div>
    <div id="iouBody"></div>
  `);
  paint();
  $('#iouBody').addEventListener('click', (e) => {
    const f = e.target.closest('[data-iou-f]');
    if (f) { filter = f.dataset.iouF; paint(); return; }
    const tile = e.target.closest('.iou-tile');
    if (tile) { e.stopPropagation(); filter = filter === tile.dataset.dir ? '' : tile.dataset.dir; paint(); return; }
    if (e.target.closest('#iouDoneT')) { showDone = !showDone; paint(); return; }
    const row = e.target.closest('[data-iou]');
    if (row) { const o = (money.ious || []).find((x) => x.id === row.dataset.iou); if (o) iouForm(o, {}, { back: () => iouListSheet(filter) }); }
  });
  $('#iouAdd').addEventListener('click', () => iouForm(null, filter ? { dir: filter } : {}, { back: () => iouListSheet(filter) }));
}

/* ---------- Add / edit ----------
   New entries open from the add sheet's 4th choice, so the same type switch sits on top;
   tapping รายจ่าย / รายรับ / โอนเงิน goes back to the usual form with what was typed. */

function iouForm(o, preset = {}, opts = {}) {
  const isNew = !o;
  const d = o ? { ...o, repaid: [...(o.repaid || [])] } : {
    id: newId(), dir: 'owed', kind: 'advance', person: '', amount: '', date: dateStr(new Date()), note: '', repaid: [], ...preset,
  };
  const people = iouPeople();
  const back = () => (opts.back ? opts.back() : closeSheet());
  openSheet(`
    <div class="sheet-head">
      <button class="close-x" data-action="close" aria-label="ยกเลิก"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>
      <h2>${isNew ? 'เพิ่มรายการ' : 'ติดเงิน'}</h2>
      <span class="sheet-head-pad"></span>
    </div>
    ${isNew && !opts.back ? `<div class="seg" id="txType">
      <button type="button" data-ttype="expense">รายจ่าย</button>
      <button type="button" data-ttype="income">รายรับ</button>
      <button type="button" data-ttype="transfer">โอนเงิน</button>
      <button type="button" data-ttype="iou" class="on">ติดเงิน</button>
    </div>` : ''}
    <div class="seg iou-dir" id="iDir">
      <button type="button" data-dir="owed">${IOU_EMOJI.owed} เขาติดฉัน</button>
      <button type="button" data-dir="owe">${IOU_EMOJI.owe} ฉันติดเขา</button>
    </div>
    <div class="form tx-rows">
      <div class="tr tr-amt" id="iAmtWrap">
        <div class="tr-ico"><span class="cur-chip">THB</span></div>
        <div class="tr-body"><label class="tr-lab" for="iAmount">จำนวนเงิน</label><input id="iAmount" inputmode="decimal" placeholder="0" value="${d.amount}"></div>
      </div>
      <div class="tr"><div class="tr-ico">${svgIcon('user')}</div>
        <div class="tr-body col"><input id="iPerson" aria-label="ใคร" placeholder="ใคร เช่น ชื่อเพื่อน" value="${esc(d.person)}" autocomplete="off" translate="no">
          ${people.length ? `<div class="chips iou-people" id="iPeople">${people.map((p) => `<button type="button" class="chip" data-person="${esc(p)}" translate="no">${esc(p)}</button>`).join('')}</div>` : ''}</div></div>
      <div class="tr"><div class="tr-ico">${svgIcon('swap')}</div>
        <div class="tr-body col"><span class="tr-lab">แบบไหน</span>
          <div class="seg" id="iKind"><button type="button" data-kind="advance">สำรองจ่าย</button><button type="button" data-kind="loan">ยืมเงิน</button></div></div></div>
      <div class="tr"><div class="tr-ico">${svgIcon('note')}</div>
        <div class="tr-body"><input id="iNote" aria-label="ค่าอะไร" placeholder="ค่าอะไร เช่น ค่าข้าว ค่าตั๋ว" value="${esc(d.note || '')}" autocomplete="off"></div></div>
      <div class="tr tr-date"><div class="tr-ico">${svgIcon('cal')}</div>
        <div class="tr-body">
          <button type="button" class="day-step" data-step="-1" aria-label="วันก่อนหน้า">${svgIcon('chev', 'svg-i sm flip')}</button>
          <label class="date-pill"><span id="iDateTxt"></span><input type="date" id="iDate" value="${d.date}" aria-label="วันที่"></label>
          <button type="button" class="day-step" data-step="1" aria-label="วันถัดไป">${svgIcon('chev', 'svg-i sm')}</button>
        </div></div>
      <div class="tr"><div class="tr-ico">${svgIcon('clock')}</div>
        <div class="tr-body"><label for="iDue">กำหนดคืน</label><span style="flex:1"></span>
          <label class="date-pill iou-due"><span id="iDueTxt"></span><input type="date" id="iDue" value="${d.due || ''}" aria-label="กำหนดคืน"></label>
          <button type="button" class="iou-due-x" id="iDueX" aria-label="ไม่กำหนด" ${d.due ? '' : 'hidden'}>✕</button></div></div>
    </div>
    <div class="iou-say" id="iSay"></div>
    <p class="hint">จดไว้ดูเท่านั้น ไม่หักจากกระเป๋าเงินและไม่นับในยอดรวม งบประมาณ หรือรายงาน</p>
    ${isNew ? '' : `
      <div class="section-row"><span>ประวัติการคืน</span><span class="iou-left" id="iLeft"></span></div>
      <div class="card list-card" id="iRepaid"></div>
      <button class="btn" id="iRepay">${d.dir === 'owed' ? 'ได้รับเงินคืน' : 'คืนเงินแล้ว'}</button>
      <button class="btn danger" id="iDel">ลบรายการ</button>`}
    <div class="save-bar"><button type="button" class="save-pill" id="iSave">${isNew ? 'บันทึกติดเงิน' : 'บันทึก'}</button></div>
  `);

  const read = () => ({ ...d, person: $('#iPerson').value.trim(), amount: num($('#iAmount').value) || 0, note: $('#iNote').value.trim(), date: $('#iDate').value, due: $('#iDue').value || undefined });
  const paint = () => {
    document.querySelectorAll('#iDir button').forEach((x) => x.classList.toggle('on', x.dataset.dir === d.dir));
    document.querySelectorAll('#iKind button').forEach((x) => x.classList.toggle('on', x.dataset.kind === d.kind));
    $('#iAmtWrap').className = `tr tr-amt ${d.dir === 'owed' ? 'iou-owed' : 'exp'}`;
    const x = read();
    $('#iSay').innerHTML = `<span class="iou-ico ${d.dir}">${IOU_EMOJI[d.dir]}</span><span>${esc(iouLine(x))}${x.amount ? ` <b>${baht(x.amount)}</b>` : ''}${x.note ? ` · ${esc(x.note)}` : ''}</span>`;
    const pv = $('#iDate').value;
    $('#iDateTxt').textContent = pv ? `${TH_DOW_FULL[parseDs(pv).getDay()]} ${thDate(pv)}` : 'เลือกวันที่';
    const dv = $('#iDue').value;
    $('#iDueTxt').textContent = dv ? thDate(dv) : 'ไม่กำหนด';
    $('#iDueX').hidden = !dv;
    document.querySelectorAll('#iPeople [data-person]').forEach((b) => b.classList.toggle('on', b.dataset.person.toLowerCase() === x.person.toLowerCase()));
    if ($('#iRepaid')) {
      const left = iouLeft(x);
      $('#iLeft').textContent = left > 0 ? `ค้างอีก ${baht(left)}` : 'คืนครบแล้ว';
      $('#iLeft').className = `iou-left ${left > 0 ? d.dir : 'done'}`;
      $('#iRepaid').innerHTML = d.repaid.length ? d.repaid.map((r) => `
        <div class="item iou-pay">
          <div class="ico round iou-ico done">✓</div>
          <div class="main"><div class="name">${baht(r.amount)}</div><div class="sub">${thDate(r.date)}${r.txnId ? ` · ${money.txns.some((t) => t.id === r.txnId) ? 'ลงในกระเป๋าเงินแล้ว' : 'รายการในกระเป๋าเงินถูกลบแล้ว'}` : ''}</div></div>
          <button type="button" class="round-btn bare iou-pay-x" data-unpay="${r.id}" aria-label="ลบการคืนนี้">${svgIcon('trash', 'svg-i sm')}</button>
        </div>`).join('') : '<div class="muted pad">ยังไม่ได้คืน</div>';
      $('#iRepay').hidden = left <= 0;
      $('#iRepay').textContent = d.dir === 'owed' ? 'ได้รับเงินคืน' : 'คืนเงินแล้ว';
    }
  };
  paint();

  $('#iDir').addEventListener('click', (e) => { const b = e.target.closest('[data-dir]'); if (b) { d.dir = b.dataset.dir; paint(); } });
  $('#iKind').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) { d.kind = b.dataset.kind; paint(); } });
  ['#iAmount', '#iPerson', '#iNote'].forEach((s) => $(s).addEventListener('input', paint));
  ['#iDate', '#iDue'].forEach((s) => $(s).addEventListener('change', paint));
  $('#iDueX').addEventListener('click', () => { $('#iDue').value = ''; paint(); });
  document.querySelectorAll('.day-step').forEach((b) => b.addEventListener('click', () => {
    const x = parseDs($('#iDate').value || dateStr(new Date()));
    x.setDate(x.getDate() + Number(b.dataset.step));
    $('#iDate').value = dateStr(x);
    paint();
  }));
  if ($('#iPeople')) $('#iPeople').addEventListener('click', (e) => { const b = e.target.closest('[data-person]'); if (b) { $('#iPerson').value = b.dataset.person; paint(); } });
  if ($('#txType')) $('#txType').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ttype]');
    if (!b || b.dataset.ttype === 'iou') return;
    // Back to the usual form, keeping the amount, note and day.
    const x = read();
    txnForm(null, { type: b.dataset.ttype, ...(x.amount ? { amount: x.amount } : {}), note: x.note, date: x.date });
  });

  const check = (x) => {
    if (!(x.amount > 0)) { toast('กรุณาใส่จำนวนเงิน'); $('#iAmount').focus(); return false; }
    if (!x.person) { toast('กรุณาใส่ชื่อคน'); $('#iPerson').focus(); return false; }
    if (!x.date) { toast('กรุณาเลือกวันที่'); return false; }
    return true;
  };
  const clean = (x) => {
    const out = { id: x.id, dir: x.dir, kind: x.kind, person: x.person.slice(0, 80), amount: Math.round(x.amount * 100) / 100, date: x.date, repaid: x.repaid };
    if (x.due) out.due = x.due;
    if (x.note) out.note = x.note.slice(0, 300);
    return out;
  };
  $('#iSave').addEventListener('click', () => {
    const x = read();
    if (!check(x)) return;
    saveIou(clean(x));
    render();
    toast(isNew ? `จดแล้ว ${baht(x.amount)} · ${iouLine(x)}` : 'บันทึกแล้ว');
    back();
  });
  if (isNew) {
    if (!preset.amount) setTimeout(() => $('#iAmount') && $('#iAmount').focus(), 300);
    return;
  }
  $('#iRepaid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unpay]');
    if (!b) return;
    d.repaid = d.repaid.filter((r) => r.id !== b.dataset.unpay);
    saveIou(clean(read()));
    render(); paint();
    toast('ลบการคืนแล้ว รายการในกระเป๋าเงิน (ถ้ามี) ยังอยู่');
  });
  $('#iRepay').addEventListener('click', () => {
    const x = read();
    if (!check(x)) return;
    // Keep any edits made above before stepping into the repayment.
    saveIou(clean(x));
    iouRepaySheet(clean(x), opts);
  });
  $('#iDel').addEventListener('click', () => {
    confirmDelete('ลบรายการติดเงินนี้?', `${iouLine(d)} ${baht(d.amount)}`, () => {
      deleteIou(d);
      render(); toast('ลบแล้ว');
      back();
    });
  });
}

// Money came back (or I paid back): all of it or part. Optionally also recorded in a wallet,
// through the usual add sheet, as income (รับคืนเงินยืม) or an expense.
function iouRepaySheet(o, opts = {}) {
  const left = iouLeft(o);
  const owed = o.dir === 'owed';
  openSheet(`
    <div class="sheet-head">
      <button class="close-x" id="rpBack" aria-label="กลับ"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <h2>${owed ? 'ได้รับเงินคืน' : 'คืนเงินแล้ว'}</h2>
      <span class="sheet-head-pad"></span>
    </div>
    <div class="iou-say"><span class="iou-ico ${o.dir}">${IOU_EMOJI[o.dir]}</span><span>${esc(iouLine(o))} <b>${baht(o.amount)}</b>${o.note ? ` · ${esc(o.note)}` : ''}</span></div>
    <div class="form tx-rows">
      <div class="tr tr-amt ${owed ? 'iou-owed' : 'exp'}">
        <div class="tr-ico"><span class="cur-chip">THB</span></div>
        <div class="tr-body"><label class="tr-lab" for="rpAmt">${owed ? 'ได้คืน' : 'คืนไป'} (ค้าง ${baht(left)})</label><input id="rpAmt" inputmode="decimal" value="${left}"></div>
      </div>
      <div class="tr"><div class="tr-ico">${svgIcon('cal')}</div>
        <div class="tr-body"><label for="rpDate">วันที่</label><span style="flex:1"></span><label class="date-pill iou-rp"><span id="rpDateTxt"></span><input type="date" id="rpDate" value="${dateStr(new Date())}" aria-label="วันที่"></label></div></div>
      <div class="tr"><div class="tr-ico">${svgIcon('wallet')}</div>
        <div class="tr-body"><label for="rpTx">${owed ? 'ลงเป็นรายรับในกระเป๋าเงิน' : 'ลงเป็นรายจ่ายจากกระเป๋าเงิน'}</label><span style="flex:1"></span><label class="switch"><input type="checkbox" id="rpTx"><span></span></label></div></div>
    </div>
    <p class="hint" id="rpHint">${owed
      ? 'เปิดถ้าเงินเข้ากระเป๋าเงินจริง จะเปิดหน้าเพิ่มรายรับ (หมวดรับคืนเงินยืม) ให้ตรวจก่อนบันทึก'
      : 'เปิดถ้าเงินออกจากกระเป๋าเงินจริง จะเปิดหน้าเพิ่มรายจ่ายให้เลือกหมวดหมู่ก่อนบันทึก'}</p>
    <div class="save-bar"><button type="button" class="save-pill" id="rpSave">บันทึกการคืน</button></div>
  `);
  const paintDate = () => { const v = $('#rpDate').value; $('#rpDateTxt').textContent = v ? thDate(v) : 'เลือกวันที่'; };
  paintDate();
  $('#rpDate').addEventListener('change', paintDate);
  const reopen = () => { const cur = (money.ious || []).find((x) => x.id === o.id); if (cur) iouForm(cur, {}, opts); else closeSheet(); };
  $('#rpBack').addEventListener('click', reopen);
  $('#rpSave').addEventListener('click', () => {
    const amt = Math.round(num($('#rpAmt').value) * 100) / 100;
    if (!(amt > 0)) { toast('กรุณาใส่จำนวนเงิน'); $('#rpAmt').focus(); return; }
    if (amt > left + 0.004) { toast(`คืนได้ไม่เกิน ${baht(left)}`); return; }
    const date = $('#rpDate').value || dateStr(new Date());
    const pay = { id: newId(), date, amount: amt };
    const save = () => {
      const cur = (money.ious || []).find((x) => x.id === o.id) || o;
      saveIou({ ...cur, repaid: [...(cur.repaid || []), pay] });
      render();
    };
    save();
    const doneNow = amt >= left - 0.004;
    if (!$('#rpTx').checked) {
      toast(doneNow ? 'คืนครบแล้ว 🎉' : `บันทึกแล้ว ค้างอีก ${baht(Math.round((left - amt) * 100) / 100)}`);
      reopen();
      return;
    }
    // Record the money in a wallet with the usual form; link it back when saved.
    const note = owed ? `${o.person} คืนเงิน${o.note ? ` ${o.note}` : ''}` : `คืนเงิน ${o.person}${o.note ? ` ${o.note}` : ''}`;
    txnForm(null, { type: owed ? 'income' : 'expense', amount: amt, date, note, ...(owed ? { category: 'debt_collect' } : {}) }, {
      noIou: true,
      hint: `🤝 จากรายการติดเงิน: ${iouLine(o)}`,
      onSaved: (t) => {
        const cur = (money.ious || []).find((x) => x.id === o.id);
        if (!cur) return;
        saveIou({ ...cur, repaid: (cur.repaid || []).map((r) => (r.id === pay.id ? { ...r, txnId: t.id } : r)) });
      },
    });
  });
}
