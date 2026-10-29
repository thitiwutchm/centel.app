'use strict';

/* To-do notes: the "สิ่งที่ต้องทำ" mini app on Home. A note is one short line such as
   "จันทร์ที่ 1 ไปเยี่ยมแม่ ลำพูน"; typing it in the quick-add box picks the date and time
   out of the words. Signed out, notes live in localStorage (centel.notes.v1); signed in
   they live on the server (/api/notes, in /bootstrap as cloud.notes), and a shared note
   is seen by both partners. remindAt is when the reminder is due: dated notes go into
   the bell list and the subscribed iPhone calendar now, and into the LINE OA group later.
   Loaded after money.js; helpers from app.js are used only at run time. */

const NOTES_KEY = 'centel.notes.v1';
// Minutes before the note's time (09:00 when it has none). null = no reminder.
const NOTE_REMINDS = [[null, 'ไม่เตือน'], [0, 'ตรงเวลา'], [60, 'ล่วงหน้า 1 ชั่วโมง'], [180, 'ล่วงหน้า 3 ชั่วโมง'], [1440, 'ล่วงหน้า 1 วัน'], [4320, 'ล่วงหน้า 3 วัน']];
const NOTE_DAY_START = 9 * 60;
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadLocalNotes() {
  try { const a = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function saveLocalNotes(list) {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(list)); } catch (e) { toast('บันทึกข้อมูลไม่สำเร็จ'); }
}

function notesAll() { return isCloud() ? (cloud.notes || (cloud.notes = [])) : loadLocalNotes(); }
function noteById(id) { return notesAll().find((n) => n.id === id); }
function noteMine(n) { return !isCloud() || !n.ownerId || n.ownerId === cloud.user.id; }

function noteRemindAt(n) {
  if (!n.date || n.remind == null) return null;
  const d = parseDs(n.date);
  const [h, m] = n.time ? n.time.split(':').map(Number) : [0, NOTE_DAY_START];
  d.setHours(h, m - n.remind, 0, 0);
  return d.toISOString();
}

function noteSave(n) {
  n.remindAt = noteRemindAt(n);
  if (!isCloud()) {
    const list = loadLocalNotes();
    upsert(list, n);
    saveLocalNotes(list);
    return;
  }
  upsert(cloud.notes || (cloud.notes = []), n);
  cloudCall('PUT', `/notes/${n.id}`, { text: n.text, date: n.date || null, time: n.time || null, remind: n.remind, remindAt: n.remindAt, shared: !!n.shared, done: !!n.done });
  calFeedChanged();
}

function noteDelete(n) {
  if (!isCloud()) { saveLocalNotes(loadLocalNotes().filter((x) => x.id !== n.id)); return; }
  cloud.notes = (cloud.notes || []).filter((x) => x.id !== n.id);
  cloudCall('DELETE', `/notes/${n.id}`);
  calFeedChanged();
}

// Notes written before signing in move to the account once.
function notesAdopt() {
  const local = loadLocalNotes();
  if (!isCloud() || !local.length) return;
  saveLocalNotes([]);
  local.forEach((n) => noteSave({ ...n, id: UUID_RX.test(n.id) ? n.id : newId(), ownerId: cloud.user.id, shared: false }));
}

/* ---------- Reading a date out of the words ---------- */

// English names need word edges so "lemon" is not Monday; Thai has no spaces to lean on.
// Short Thai forms are read with or without the dots ("ต.ค." or "ตค"). server/src/noteparse.js
// is the same reader for notes typed into the LINE group; keep the two in step.
const NOTE_MONTHS = [
  'มกราคม|มกรา|ม\\.?ค\\.?|\\bjan(?:uary)?\\b', 'กุมภาพันธ์|กุมภา|ก\\.?พ\\.?|\\bfeb(?:ruary)?\\b', 'มีนาคม|มีนา|มี\\.?ค\\.?|\\bmar(?:ch)?\\b',
  'เมษายน|เมษา|เม\\.?ย\\.?|\\bapr(?:il)?\\b', 'พฤษภาคม|พฤษภา|พ\\.?ค\\.?|\\bmay\\b', 'มิถุนายน|มิถุนา|มิ\\.?ย\\.?|\\bjune?\\b',
  'กรกฎาคม|กรกฎา|ก\\.?ค\\.?|\\bjuly?\\b', 'สิงหาคม|สิงหา|ส\\.?ค\\.?|\\baug(?:ust)?\\b', 'กันยายน|กันยา|ก\\.?ย\\.?|\\bsep(?:t|tember)?\\b',
  'ตุลาคม|ตุลา|ต\\.?ค\\.?|\\boct(?:ober)?\\b', 'พฤศจิกายน|พฤศจิกา|พ\\.?ย\\.?|\\bnov(?:ember)?\\b', 'ธันวาคม|ธันวา|ธ\\.?ค\\.?|\\bdec(?:ember)?\\b',
].map((x) => `(?:${x})(?![\\u0E01-\\u0E4E])`);
const NOTE_DOW = ['อาทิตย์|\\bsun(?:day)?\\b', 'จันทร์|\\bmon(?:day)?\\b', 'อังคาร|\\btue(?:s|sday)?\\b', 'พุธ|\\bwed(?:nesday)?\\b',
  'พฤหัส(?:บดี)?|\\bthu(?:rs|rsday)?\\b', 'ศุกร์|\\bfri(?:day)?\\b', 'เสาร์|\\bsat(?:urday)?\\b'];

// Full year from what was typed: 2569 / 69 (Buddhist) or 2026 / 26.
function noteYear(y) {
  let n = Number(y);
  if (n < 100) n += n >= 40 ? 2500 : 2000;
  return n > 2400 ? n - 543 : n;
}

// Returns { text, date, time } with the date words taken out of text. The input is
// left as it was when nothing in it looks like a date or time.
function parseNote(raw, now = new Date()) {
  let s = ` ${raw} `;
  const take = (rx) => { const m = s.match(rx); if (m) s = s.replace(m[0], ' '); return m; };
  let time = '';
  const hm = (h, m = 0) => { if (h >= 0 && h < 24 && m >= 0 && m < 60) time = `${pad(h)}:${pad(m)}`; };
  let m;
  if ((m = take(/(?:เวลา\s*|ตอน\s*)?(\d{1,2})[:.](\d{2})\s*(?:นาฬิกา|น\.?(?![\u0E01-\u0E4E]))?/))) hm(+m[1], +m[2]);
  else if ((m = take(/(?:ตอน\s*)?เที่ยงคืน/))) hm(0);
  else if ((m = take(/(?:ตอน\s*)?เที่ยง(?:วัน)?/))) hm(12);
  else if ((m = take(/(?:ตอน\s*)?บ่าย\s*โมง/))) hm(13);
  else if ((m = take(/(?:ตอน\s*)?บ่าย\s*(\d{1,2})\s*(?:โมง)?/))) hm(12 + +m[1]);
  else if ((m = take(/(?:ตอน\s*)?(\d{1,2})\s*ทุ่ม/))) hm(18 + +m[1]);
  else if ((m = take(/(?:ตอน\s*)?(\d{1,2})\s*โมง\s*(เช้า|เย็น)?/))) hm(m[2] === 'เย็น' && +m[1] < 12 ? +m[1] + 12 : +m[1]);
  else if ((m = take(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) hm((+m[1] % 12) + (/pm/i.test(m[3]) ? 12 : 0), +(m[2] || 0));

  const base = new Date(now); base.setHours(0, 0, 0, 0);
  const addDays = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  let date = null;
  let dow = -1;
  let nextWeek = false;
  NOTE_DOW.some((rx, i) => {
    const w = take(new RegExp(`(?:วัน)?(?:${rx})(?:\\s*(หน้า|นี้|next))?`, 'i'));
    if (w) { dow = i; nextWeek = w[1] === 'หน้า' || w[1] === 'next'; }
    return !!w;
  });
  if ((m = take(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
    const y = m[3] ? noteYear(m[3]) : base.getFullYear();
    date = new Date(y, +m[2] - 1, +m[1]);
    if (!m[3] && date < base) date.setFullYear(y + 1);
  } else if ((m = take(new RegExp(`(?:วันที่|ที่)?\\s*(\\d{1,2})\\s*(${NOTE_MONTHS.map((x) => `(${x})`).join('|')})\\s*(\\d{4}|\\d{2}(?!\\d))?`, 'i')))) {
    const mon = m.slice(3, 15).findIndex(Boolean);
    const yt = m[15];
    const y = yt ? noteYear(yt) : base.getFullYear();
    date = new Date(y, mon, +m[1]);
    if (!yt && date < base) date.setFullYear(y + 1);
  } else if ((m = take(/(?:วันที่|ที่|the)\s*(\d{1,2})(?!\d)(?:st|nd|rd|th)?/i)) && +m[1] >= 1 && +m[1] <= 31) {
    // "จันทร์ที่ 1": the next 1st that is a Monday, if one comes within a year; else the next 1st.
    const day = +m[1];
    const fits = [];
    for (let i = 0; i < 13; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, day);
      if (d.getDate() === day && d >= base) fits.push(d);
    }
    date = (dow >= 0 && fits.find((d) => d.getDay() === dow)) || fits[0] || null;
  }
  if (!date && dow >= 0) date = addDays(((dow - base.getDay() + 7) % 7) + (nextWeek ? 7 : 0));
  if (!date) {
    if (take(/มะรืน(?:นี้)?/)) date = addDays(2);
    else if (take(/พรุ่งนี้|tomorrow/i)) date = addDays(1);
    else if (take(/วันนี้|คืนนี้|today|tonight/i)) date = addDays(0);
  }
  // A time on its own means the next time it comes round: today, or tomorrow once past.
  if (!date && time) date = addDays(time > `${pad(now.getHours())}:${pad(now.getMinutes())}` ? 0 : 1);
  const text = s.replace(/\s+/g, ' ').trim();
  if (!text) return { text: raw.trim(), date: '', time: '' };
  return { text, date: date ? dateStr(date) : '', time };
}

/* ---------- Display ---------- */

function noteWhen(n) {
  if (!n.date) return { cls: 'none', rel: '' };
  const diff = daysBetween(today(), parseDs(n.date));
  if (n.done) return { cls: 'done', rel: '' };
  if (diff < 0) return { cls: 'over', rel: `เลยกำหนด ${-diff} วัน` };
  if (diff === 0) return { cls: 'today', rel: 'วันนี้' };
  if (diff === 1) return { cls: 'soon', rel: 'พรุ่งนี้' };
  return { cls: diff <= 7 ? 'soon' : '', rel: `อีก ${diff} วัน` };
}

function noteLeaf(n, cls) {
  if (!n.date) return `<div class="leaf none" aria-hidden="true">${svgIcon('note')}</div>`;
  const d = parseDs(n.date);
  return `<div class="leaf ${cls}"><span class="lw">${TH_DOW[d.getDay()]}</span><b>${d.getDate()}</b><span class="lm">${TH_MONTHS_SHORT[d.getMonth()]}</span></div>`;
}

function remindLabel(v) { return (NOTE_REMINDS.find(([k]) => k === v) || NOTE_REMINDS[0])[1]; }

function noteRow(n) {
  const w = noteWhen(n);
  const from = isCloud() && n.shared && !noteMine(n);
  const sub = [
    w.rel ? `<span class="nrel ${w.cls}">${w.rel}</span>` : '',
    n.time ? `<span>${svgIcon('clock', 'svg-i xs')}<span>${n.time} น.</span></span>` : '',
    n.date && n.remind != null && !n.done ? `<span>${svgIcon('bell', 'svg-i xs')}<span>${remindLabel(n.remind)}</span></span>` : '',
    n.shared ? `<span>🤝 <span>${from ? `จาก ${esc(partnerName())}` : 'แชร์กับคู่'}</span></span>` : '',
  ].filter(Boolean).join('');
  return `
    <div class="item note-row${n.done ? ' done' : ''}" data-note="${esc(n.id)}" role="button" tabindex="0">
      ${noteLeaf(n, w.cls)}
      <div class="main"><div class="note-text" translate="no">${esc(n.text)}</div>${sub ? `<div class="note-sub">${sub}</div>` : ''}</div>
      <button class="check${n.done ? ' on' : ''}" data-note-done="${esc(n.id)}" aria-label="${n.done ? 'ยังไม่เสร็จ' : 'ทำเสร็จแล้ว'}">${n.done ? '✓' : ''}</button>
    </div>`;
}

// Open notes first by date (overdue on top), notes without a date after, newest first.
function notesOpen() {
  return notesAll().filter((n) => !n.done).sort((a, b) =>
    (a.date ? 0 : 1) - (b.date ? 0 : 1) || (a.date || '').localeCompare(b.date || '')
    || (a.time || '').localeCompare(b.time || '') || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// Dated notes that are due today or already late, for the bell.
function notesDue() {
  const td = dateStr(new Date());
  return notesOpen().filter((n) => n.date && n.date <= td);
}

function noteQuickAdd(id) {
  return `
    <form class="note-add" data-note-add="${id}">
      <span class="na-plus">${svgIcon('plus')}</span>
      <input id="${id}" enterkeyhint="done" autocomplete="off" maxlength="500" placeholder="เพิ่มสิ่งที่ต้องทำ เช่น จันทร์ที่ 1 ไปเยี่ยมแม่ ลำพูน" aria-label="เพิ่มสิ่งที่ต้องทำ">
      <button type="button" class="na-more" data-note-new="${id}" aria-label="ตั้งวันและการเตือน">${svgIcon('cal')}</button>
    </form>
    <div class="note-preview" id="${id}Pv" hidden></div>`;
}

function notesCard() {
  const open = notesOpen();
  const due = notesDue().length;
  return `
    <div class="section-row"><span>สิ่งที่ต้องทำ</span><button class="link-btn" data-action="notes">${open.length > 4 ? `ดูทั้งหมด (${open.length})` : 'ดูทั้งหมด'}</button></div>
    <div class="card list-card notes-card">
      <div class="card-head"><span class="nc-title">${svgIcon('todo')}<b>โน้ตเตือนความจำ</b></span>${due ? `<span class="nc-due">${due} รายการถึงกำหนด</span>` : open.length ? `<span class="muted small">${open.length} รายการ</span>` : ''}</div>
      ${open.slice(0, 4).map(noteRow).join('') || '<div class="muted pad small note-empty">จดสิ่งที่ต้องทำไว้ตรงนี้ ใส่วันในประโยคได้เลย แอปจะตั้งวันให้เอง</div>'}
      ${noteQuickAdd('naHome')}
    </div>`;
}

function notePreviewHtml(p) {
  if (!p.date && !p.time) return '';
  const d = p.date ? parseDs(p.date) : null;
  return `<span class="np-chip">${svgIcon('cal', 'svg-i xs')}<span>${d ? `${TH_DOW_FULL[d.getDay()]}` : ''}</span><span>${d ? `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${d.getFullYear() + BE}` : ''}</span>${p.time ? `<span>· ${p.time} น.</span>` : ''}</span><span class="np-text" translate="no">${esc(p.text)}</span>`;
}

/* ---------- Sheets ---------- */

function notesSheet() {
  const open = notesOpen();
  const td = dateStr(new Date());
  const groups = [
    ['เลยกำหนด', open.filter((n) => n.date && n.date < td)],
    ['วันนี้', open.filter((n) => n.date === td)],
    ['กำลังจะถึง', open.filter((n) => n.date > td)],
    ['ไม่ระบุวัน', open.filter((n) => !n.date)],
  ];
  const done = notesAll().filter((n) => n.done).sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || ''))).slice(0, 30);
  openSheet(`
    <div class="sheet-head">
      <button class="close-x" data-action="close" aria-label="ปิด"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>
      <h2>สิ่งที่ต้องทำ</h2>
      <button class="round-btn sm" data-note-new="" aria-label="เพิ่มสิ่งที่ต้องทำ">${svgIcon('plus')}</button>
    </div>
    <div class="list notes-card">${noteQuickAdd('naSheet')}</div>
    ${groups.filter(([, l]) => l.length).map(([t, l]) => `<div class="section-title">${t} (${l.length})</div><div class="list">${l.map(noteRow).join('')}</div>`).join('')}
    ${open.length ? '' : '<div class="empty"><div class="e-ico">📝</div>ไม่มีสิ่งที่ต้องทำค้างอยู่</div>'}
    ${done.length ? `<div class="section-title">เสร็จแล้ว (${done.length})</div><div class="list">${done.map(noteRow).join('')}</div>` : ''}
    ${lineHint()}
  `);
  ui.notesOpen = true;
}

// LINE reminders are set up once in the Account tab; the list points there.
function lineHint() {
  const on = isCloud() && cloud.line && cloud.line.active;
  return `
    <button class="line-soon" data-goto="account">
      <span class="ls-ico">LINE</span>
      <div><b>แจ้งเตือนในกลุ่ม LINE</b><div class="muted small">${on ? 'ตั้งกลุ่มไว้แล้ว · แก้ไขได้ที่หน้า บัญชี' : 'ตั้งค่า LINE Group ID ได้ที่หน้า บัญชี'}</div></div>
      ${svgIcon('chev', 'svg-i sm')}
    </button>`;
}

function noteForm(n, preset = {}) {
  const isNew = !n;
  const d = n ? { ...n } : { id: newId(), text: '', date: '', time: '', remind: null, shared: false, done: false, ...preset };
  if (isNew && d.date && d.remind == null) d.remind = 0;
  const canShare = isCloud() && !!cloud.partner && noteMine(d);
  const back = ui.notesOpen ? 'notes' : 'close';
  openSheet(`
    <div class="sheet-head">
      <button class="close-x" data-action="${back}" aria-label="ยกเลิก"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>
      <h2>${isNew ? 'สิ่งที่ต้องทำ' : 'แก้ไขโน้ต'}</h2>
      <button class="link-btn strong" id="nSave">บันทึก</button>
    </div>
    <div class="form note-card note-edit"><textarea id="nText" maxlength="500" placeholder="เช่น ไปเยี่ยมแม่ ลำพูน" aria-label="สิ่งที่ต้องทำ">${esc(d.text)}</textarea></div>
    <div class="form prows" id="nRows"></div>
    ${isNew ? '' : noteMine(d) ? '<button class="btn danger" id="nDel">ลบโน้ต</button>' : `<div class="muted small center">โน้ตนี้สร้างโดย ${esc(partnerName())}</div>`}
  `);
  const pick = (label, value, control) => `<label class="prow"><span class="pl">${label}</span><span class="pv">${value}${control ? svgIcon('updown', 'svg-i ud') : ''}</span>${control || ''}</label>`;
  const rows = () => {
    const dt = d.date ? parseDs(d.date) : null;
    let h = pick('วันที่', dt ? `${TH_DOW_FULL[dt.getDay()]} ${thShortDate(dt)} ${dt.getFullYear() + BE}` : 'ไม่ระบุวัน', `<input type="date" data-nset="date" value="${d.date || ''}">`);
    if (d.date) {
      h += pick('เวลา', d.time ? `${d.time} น.` : 'ทั้งวัน', `<input type="time" data-nset="time" value="${d.time || ''}">`);
      h += pick('เตือน', `${svgIcon('bell', 'svg-i xs')} ${remindLabel(d.remind)}`,
        `<select data-nset="remind">${NOTE_REMINDS.map(([k, l]) => `<option value="${k == null ? '' : k}" ${k === d.remind ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
    }
    if (canShare) h += pick(`แชร์กับ ${esc(partnerName())}`, d.shared ? 'ใช่' : 'ไม่', `<select data-nset="shared"><option value="">ไม่</option><option value="1" ${d.shared ? 'selected' : ''}>ใช่</option></select>`);
    $('#nRows').innerHTML = h;
  };
  rows();
  $('#nRows').addEventListener('change', (e) => {
    const k = e.target.dataset.nset;
    if (!k) return;
    const v = e.target.value;
    if (k === 'date') { const had = !!d.date; d.date = v; if (!v) { d.time = ''; d.remind = null; } else if (!had && d.remind == null) d.remind = 0; }
    if (k === 'time') d.time = v;
    if (k === 'remind') d.remind = v === '' ? null : Number(v);
    if (k === 'shared') d.shared = !!v;
    rows();
  });
  $('#nSave').addEventListener('click', () => {
    const text = $('#nText').value.trim();
    if (!text) { toast('กรุณาพิมพ์สิ่งที่ต้องทำ'); $('#nText').focus(); return; }
    if (!d.date) { d.time = ''; d.remind = null; }
    noteSave({ ...d, text, ownerId: d.ownerId || (isCloud() ? cloud.user.id : undefined), createdAt: d.createdAt || new Date().toISOString() });
    toast(isNew ? 'เพิ่มโน้ตแล้ว' : 'บันทึกแล้ว');
    if (ui.notesOpen) notesSheet(); else closeSheet();
    render();
  });
  const del = $('#nDel');
  if (del) del.addEventListener('click', () => confirmDelete('ลบโน้ตนี้?', '', () => {
    noteDelete(d);
    if (ui.notesOpen) notesSheet(); else closeSheet();
    render(); toast('ลบแล้ว');
  }));
  if (isNew && !d.text) setTimeout(() => $('#nText') && $('#nText').focus(), 300);
}

function noteToggle(id, btn) {
  const n = noteById(id);
  if (!n) return;
  n.done = !n.done;
  n.doneAt = n.done ? new Date().toISOString() : undefined;
  noteSave({ ...n });
  const row = btn.closest('.note-row');
  row.classList.toggle('done', n.done);
  btn.classList.toggle('on', n.done);
  btn.textContent = n.done ? '✓' : '';
  if (n.done) toast('เสร็จแล้ว ✓');
  // Let the tick show before the row leaves the list.
  setTimeout(() => { if (ui.notesOpen && !$('#sheet').hidden) notesSheet(); render(); }, 650);
}

function noteQuick(form) {
  const input = form.querySelector('input');
  const raw = input.value.trim();
  if (!raw) return;
  const p = parseNote(raw);
  noteSave({ id: newId(), text: p.text, date: p.date, time: p.time, remind: p.date ? 0 : null, shared: false, done: false,
    ownerId: isCloud() ? cloud.user.id : undefined, createdAt: new Date().toISOString() });
  toast(p.date ? `เพิ่มแล้ว · ${thShortDate(parseDs(p.date))}` : 'เพิ่มโน้ตแล้ว');
  if (ui.notesOpen && !$('#sheet').hidden) { notesSheet(); setTimeout(() => $('#naSheet') && $('#naSheet').focus(), 50); } else {
    render();
    const el = $('#naHome');
    if (el) el.focus({ preventScroll: true });
  }
}

/* ---------- LINE settings (Account tab) ---------- */

const LINE_ID_RX = /^[CR][0-9a-f]{32}$/;

function lineSettings() {
  const l = isCloud() ? cloud.line : null;
  const ready = isCloud() && cloud.features && cloud.features.line;
  const status = !isCloud() ? 'ต้องเข้าสู่ระบบ' : !l ? 'ยังไม่ได้ตั้งค่า' : !l.active ? 'ปิดอยู่' : ready ? 'พร้อมส่ง' : 'รอเชื่อม LINE OA';
  return `
    <div class="section-title">แจ้งเตือนในกลุ่ม LINE</div>
    <div class="form line-set">
      <div class="field"><label>สถานะ</label><span class="ln-status${l && l.active && ready ? ' ok' : ''}">${status}</span></div>
      <div class="field"><label for="lineGroup">LINE Group ID</label>
        <input id="lineGroup" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="C1a2b3…" value="${esc(l ? l.groupId : '')}" ${isCloud() ? '' : 'disabled'}></div>
      <div class="field"><label for="lineOn">ส่งเตือนสิ่งที่ต้องทำเข้ากลุ่ม</label><span style="flex:1"></span>
        <label class="switch"><input type="checkbox" id="lineOn" ${!l || l.active ? 'checked' : ''} ${l ? '' : 'disabled'}><span></span></label></div>
    </div>
    ${isCloud() ? linePeopleList() : ''}
    ${l && l.active && ready ? '<button class="btn ghost" id="lineTest">💬 ส่งข้อความทดสอบเข้ากลุ่ม</button>' : ''}
    <p class="hint">เพิ่ม LINE OA ของ Centel เข้ากลุ่มของบ้าน บอทจะส่ง Group ID (ขึ้นต้นด้วย C) ให้ในกลุ่ม หรือพิมพ์ id ในกลุ่มเพื่อขอใหม่ แล้วนำมาใส่ที่นี่ การเตือนของโน้ตที่ตั้งเวลาไว้จะส่งเข้ากลุ่มนี้${ready ? '' : '<br>ระบบจะเริ่มส่งเมื่อเชื่อม LINE OA เสร็จ'}</p>`;
}

/* Who is who in the LINE group: LINE user ids (U…) with a name and which app account
   they are. Reminders @mention the people a note belongs to. */
const LINE_UID_RX = /^U[0-9a-f]{32}$/;
function myNick() { return (cloud.user && (cloud.user.nickname || cloud.user.name)) || 'ฉัน'; }
function lineWhoLabel(who) { return who === 'me' ? `ฉัน (${myNick()})` : who === 'partner' ? partnerName() : 'ไม่ระบุ'; }

function linePeopleList() {
  const list = cloud.linePeople || [];
  const rows = list.map((p, i) => `
    <button class="item" data-lp="${i}">
      <div class="ico round lp-ico">${esc([...p.name][0] || '?')}</div>
      <div class="main"><div class="name">${esc(p.name)}</div><div class="sub"><span class="mono">${p.userId.slice(0, 6)}…${p.userId.slice(-5)}</span> · <span>${esc(lineWhoLabel(p.who))}</span></div></div>
      ${svgIcon('chev', 'svg-i sm')}
    </button>`).join('');
  return `
    <div class="section-title">คนในกลุ่ม LINE</div>
    <div class="list">${rows}
      <button class="item" data-lp="new"><div class="ico round lp-ico add">${svgIcon('plus')}</div><div class="main"><div class="name">เพิ่มคน</div></div></button>
    </div>
    <p class="hint">ใส่ LINE ID (ขึ้นต้นด้วย U) แล้วบอกว่าเป็นใครในแอป การเตือนจะแท็กคนที่เกี่ยวกับโน้ตนั้น พิมพ์ id ในกลุ่มเพื่อดู LINE ID ของตัวเอง</p>
    <p class="hint">สั่งนัดจากกลุ่มได้ เช่น “ทำนัด 18:00 31 ต.ค. ไปแข่งกีฬา” หรือขึ้นต้นด้วย นัด / เตือน / จด แล้วเว้นวรรค นัดจะขึ้นในแอปของคนที่พิมพ์ แชร์กับคู่</p>`;
}

function linePersonForm(i) {
  const list = cloud.linePeople || [];
  const isNew = i === 'new';
  const d = isNew ? { userId: '', name: '', who: '' } : { ...list[Number(i)] };
  const taken = new Set(list.filter((_, k) => String(k) !== String(i)).map((p) => p.who).filter(Boolean));
  const opt = (v, label) => (v && taken.has(v) ? '' : `<option value="${v}" ${d.who === v ? 'selected' : ''}>${esc(label)}</option>`);
  openSheet(`
    <div class="sheet-head">
      <button class="close-x" data-action="close" aria-label="ยกเลิก"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>
      <h2>${isNew ? 'เพิ่มคนในกลุ่ม LINE' : 'แก้ไข'}</h2>
      <button class="link-btn strong" id="lpSave">บันทึก</button>
    </div>
    <form class="form" id="lpForm">
      <div class="field"><label for="lpName">ชื่อ</label><input id="lpName" maxlength="40" placeholder="เช่น พ่อบุ๊ค" value="${esc(d.name)}" autocomplete="off"></div>
      <div class="field line-set"><label for="lpId">LINE ID</label><input id="lpId" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="U1a2b3…" value="${esc(d.userId)}"></div>
      <div class="field"><label for="lpWho">คือใครในแอป</label><select id="lpWho">${opt('', 'ไม่ระบุ')}${opt('me', `ฉัน (${myNick()})`)}${cloud.partner ? opt('partner', partnerName()) : ''}</select></div>
    </form>
    ${isNew ? '' : '<button class="btn danger" id="lpDel">ลบ</button>'}
  `);
  const put = (next, msg) => {
    cloud.linePeople = next;
    cloudCall('PUT', '/line/people', { people: next }).then((r) => { if (r) toast(msg); });
    closeSheet(); render();
  };
  const save = (e) => {
    if (e) e.preventDefault();
    const name = $('#lpName').value.trim();
    const userId = $('#lpId').value.trim();
    if (!name) { toast('กรุณาใส่ชื่อ'); $('#lpName').focus(); return; }
    if (!LINE_UID_RX.test(userId)) { toast('LINE ID ไม่ถูกต้อง (U ตามด้วยตัวอักษร 32 ตัว)'); $('#lpId').focus(); return; }
    if (list.some((p, k) => p.userId === userId && String(k) !== String(i))) { toast('มี LINE ID นี้แล้ว'); return; }
    const p = { userId, name, who: $('#lpWho').value };
    const next = isNew ? [...list, p] : list.map((x, k) => (String(k) === String(i) ? p : x));
    put(next, isNew ? 'เพิ่มแล้ว' : 'บันทึกแล้ว');
  };
  $('#lpSave').addEventListener('click', save);
  $('#lpForm').addEventListener('submit', save);
  if ($('#lpDel')) $('#lpDel').addEventListener('click', () => confirmDelete(`ลบ ${d.name}?`, '', () => put(list.filter((_, k) => String(k) !== String(i)), 'ลบแล้ว')));
  if (isNew) setTimeout(() => $('#lpName') && $('#lpName').focus(), 300);
}

function lineSettingsBind() {
  const input = $('#lineGroup');
  if (!input || !isCloud()) return;
  const send = (groupId, active) => {
    cloud.line = groupId ? { groupId, active } : null;
    cloudCall('PUT', '/line', { groupId, active }).then((r) => { if (r) toast(groupId ? 'บันทึกแล้ว' : 'ลบ Group ID แล้ว'); });
    const y = window.scrollY; render(); window.scrollTo(0, y);
  };
  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (v && !LINE_ID_RX.test(v)) { toast('Group ID ไม่ถูกต้อง (C ตามด้วยตัวอักษร 32 ตัว)'); input.focus(); return; }
    if (v === (cloud.line ? cloud.line.groupId : '')) return;
    send(v, cloud.line ? cloud.line.active : true);
  });
  $('#lineOn').addEventListener('change', (e) => { if (cloud.line) send(cloud.line.groupId, e.target.checked); });
  const test = $('#lineTest');
  if (test) test.addEventListener('click', async () => {
    test.disabled = true;
    try { await api('POST', '/line/test'); toast('ส่งข้อความทดสอบแล้ว ดูในกลุ่ม LINE'); } catch (e) {
      toast(e.message === 'line_failed' ? 'ส่งไม่สำเร็จ ตรวจว่า LINE OA อยู่ในกลุ่มและ Group ID ถูกต้อง' : cloudErr(e));
    }
    test.disabled = false;
  });
}

/* ---------- Calendar feed ---------- */

// Open dated notes as events in the subscribed iPhone calendar, with the note's reminder.
function notesIcs(stamp, alarm) {
  const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const out = [];
  notesOpen().filter((n) => n.date).forEach((n) => {
    const day = parseDs(n.date);
    const ev = ['BEGIN:VEVENT', `UID:note-${n.id}@centel.app`, `DTSTAMP:${stamp}`];
    if (n.time) {
      const [h, m] = n.time.split(':').map(Number);
      const start = new Date(day); start.setHours(h, m, 0, 0);
      ev.push(`DTSTART:${utc(start)}`, `DTEND:${utc(new Date(start.getTime() + 3600000))}`);
    } else {
      const end = new Date(day); end.setDate(end.getDate() + 1);
      ev.push(`DTSTART;VALUE=DATE:${icsDate(day)}`, `DTEND;VALUE=DATE:${icsDate(end)}`, 'TRANSP:TRANSPARENT');
    }
    ev.push(`SUMMARY:${icsEscape(`📝 ${n.text}`)}`);
    if (n.remind != null) {
      // Timed: before the start. All day: from 09:00 on the day.
      const mins = n.time ? -n.remind : NOTE_DAY_START - n.remind;
      ev.push(...alarm(`${mins < 0 ? '-' : ''}PT${Math.abs(mins)}M`, n.text));
    }
    ev.push('END:VEVENT');
    out.push(...ev);
  });
  return out;
}

/* ---------- Clicks ---------- */

function notesClick(t) {
  const lp = t.closest('[data-lp]');
  if (lp) { linePersonForm(lp.dataset.lp); return true; }
  const dn = t.closest('[data-note-done]');
  if (dn) { noteToggle(dn.dataset.noteDone, dn); return true; }
  const nn = t.closest('[data-note-new]');
  if (nn) {
    const input = nn.dataset.noteNew && $(`#${nn.dataset.noteNew}`);
    const p = input && input.value.trim() ? parseNote(input.value) : {};
    if (!nn.dataset.noteNew || nn.closest('#sheet')) ui.notesOpen = !!nn.closest('#sheet');
    else ui.notesOpen = false;
    noteForm(null, p.text ? { text: p.text, date: p.date, time: p.time } : {});
    return true;
  }
  if (t.closest('.note-add')) return true;
  const row = t.closest('[data-note]');
  if (row) {
    const n = noteById(row.dataset.note);
    if (n) { ui.notesOpen = !!row.closest('#sheet'); noteForm(n); }
    return true;
  }
  return false;
}

function notesAction(action) {
  if (action !== 'notes') return false;
  notesSheet();
  return true;
}

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-note-add]');
  if (!f) return;
  e.preventDefault();
  noteQuick(f);
});

document.addEventListener('input', (e) => {
  const f = e.target.closest('[data-note-add]');
  if (!f) return;
  const pv = document.getElementById(`${e.target.id}Pv`);
  if (!pv) return;
  const v = e.target.value.trim();
  const html = v ? notePreviewHtml(parseNote(v)) : '';
  pv.innerHTML = html;
  pv.hidden = !html;
});
