'use strict';

/* Schedule: a month calendar of repeating bills (ทุกเดือน, ผ่อนเป็นงวด, Auto Sync) with
   each day's total, the month's upcoming payments, and a "รายการประจำ" list whose items
   open a clean detail sheet with value pickers. Loaded before app.js; uses its globals. */

function isRepeating(b) { return b.type !== 'once'; }
function repeatingBills() {
  return state.bills.filter(isRepeating).sort((a, b) => (a.dueDay || 0) - (b.dueDay || 0) || a.name.localeCompare(b.name, 'th'));
}

// Compact day total for the calendar cell, e.g. -1k, -2.9k, -399.
function shortAmt(n) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${+(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${+(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : String(Math.round(a));
  return `-${s}`;
}

function repeatText(b) {
  if (b.pea) return 'Auto Sync · ค่าไฟ PEA';
  if (b.gmail) return 'Auto Sync · Gmail';
  if (b.type === 'installment') return `ผ่อน ${b.months} งวด`;
  if (b.type === 'once') return 'ครั้งเดียว';
  return 'ทุกเดือน';
}

// The next unpaid due date of a bill from this month on (null once it has ended).
function nextDue(b) {
  let ym = ymOf(new Date());
  if (b.startMonth && ym < b.startMonth) ym = b.startMonth;
  for (let i = 0; i < 24; i++, ym = addMonths(ym, 1)) {
    if (!billAppliesTo(b, ym)) { if (b.type === 'once' || (billEndMonth(b) && ym > billEndMonth(b))) return null; continue; }
    if (!record(ym, b.id).paid) return { ym, due: dueDateFor(b, ym) };
  }
  return null;
}

function renderSchedule() {
  const thisYm = ymOf(new Date());
  if (!ui.schedYm || ui.schedYm < thisYm) ui.schedYm = thisYm;
  const ym = ui.schedYm;
  const { y, m } = parseYm(ym);
  const t = today();
  const occ = occurrences(ym).filter((o) => isRepeating(o.bill));
  const byDay = {};
  occ.forEach((o) => { (byDay[o.due.getDate()] = byDay[o.due.getDate()] || []).push(o); });
  if (ui.schedDay && !byDay[ui.schedDay]) ui.schedDay = null;

  const months = Array.from({ length: 12 }, (_, i) => addMonths(thisYm, i));
  const chip = (k) => {
    const p = parseYm(k);
    const label = k === thisYm ? 'เดือนนี้' : `${TH_MONTHS_SHORT[p.m - 1]} ${String(p.y + BE).slice(2)}`;
    return `<button class="chip ${k === ym ? 'on' : ''}" data-sched-ym="${k}">${label}</button>`;
  };

  let cells = TH_DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('');
  const first = new Date(y, m - 1, 1).getDay();
  for (let i = 0; i < first; i++) cells += `<div class="sc-day blank"></div>`;
  for (let d = 1; d <= daysInMonth(ym); d++) {
    const list = byDay[d];
    const isToday = ymOf(t) === ym && t.getDate() === d;
    if (!list) { cells += `<div class="sc-day ${isToday ? 'today' : ''}"><span class="n">${d}</span></div>`; continue; }
    const due = list.filter((o) => !o.paid);
    const sum = (due.length ? due : list).reduce((s, o) => s + o.amount, 0);
    const st = !due.length ? 'paid' : due.some((o) => o.status === 'overdue') ? 'over' : due.some((o) => o.status === 'soon') ? 'soon' : '';
    cells += `<button class="sc-day has ${st} ${isToday ? 'today' : ''} ${ui.schedDay === d ? 'sel' : ''}" data-sched-day="${d}" aria-label="วันที่ ${d} ${baht(sum)}">
      <span class="n">${d}</span><span class="amt">${due.length ? shortAmt(sum) : '✓'}</span><i></i></button>`;
  }

  // Upcoming: what is still to pay this month (or on the picked day, everything due that day).
  const shown = ui.schedDay ? byDay[ui.schedDay] : occ.filter((o) => !o.paid);
  const total = shown.filter((o) => !o.paid).reduce((s, o) => s + o.amount, 0);
  const title = ui.schedDay ? `${ui.schedDay} ${TH_MONTHS_SHORT[m - 1]} ${y + BE}` : 'กำลังจะถึง';
  const n = repeatingBills().length;

  view.innerHTML = `
    <div class="chips filters sched-months">${months.map(chip).join('')}</div>
    <div class="cal sched-cal"><div class="cal-grid">${cells}</div></div>
    <div class="section-row sched-head"><span>${title}</span><b>${total ? '-' + baht(total) : ''}</b></div>
    ${shown.length
      ? `<div class="list">${shown.map(schedItem).join('')}</div>`
      : `<div class="card muted" style="text-align:center">${occ.length ? '🎉 จ่ายครบทุกรายการประจำเดือนนี้แล้ว' : 'ไม่มีบิลประจำในเดือนนี้'}</div>`}
    ${ui.schedDay ? '<button class="btn ghost small" data-sched-day="0">ดูทั้งเดือน</button>' : ''}
    <div class="sched-spacer"></div>
    <button class="sched-fab" data-action="recurring">${svgIcon('repeat')}<span>รายการประจำ (${n})</span></button>`;
  const on = view.querySelector('.sched-months .chip.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function schedItem(o) {
  const b = o.bill;
  const c = cat(b);
  const sub = [`${o.due.getDate()} ${TH_MONTHS[o.due.getMonth()]} ${o.due.getFullYear() + BE}`, o.inst ? `งวด ${o.inst.n}/${o.inst.of}` : ''].filter(Boolean).join(' · ');
  const amt = o.needsAmount ? `<span class="badge warn">${b.pea ? '⚡ ดึงยอด' : 'ระบุยอด'}</span>` : `-${baht(o.amount)}`;
  return `
    <div class="item sched-item ${o.paid ? 'paid' : ''}" data-occ="${b.id}" data-ym="${o.ym}" role="button" tabindex="0">
      ${icoHtml(b)}
      <div class="main">
        <div class="name">${esc(b.name)}</div>
        <div class="sub">${sub}</div>
        ${b.note ? `<div class="sub note">${esc(b.note)}</div>` : `<div class="sub note">${c.label}</div>`}
        ${statusBadge(o)}
      </div>
      <div class="right"><div class="amt">${amt}</div></div>
    </div>`;
}

function recurringSheet() {
  const list = repeatingBills();
  const monthly = list.filter((b) => billAppliesTo(b, ymOf(new Date()))).reduce((s, b) => s + (b.amount || 0), 0);
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>รายการประจำ (${list.length})</h2>
      <button class="link-btn strong" data-action="add">เพิ่ม</button>
    </div>
    <div class="hero-sum"><span>ประมาณการต่อเดือน</span><b>-${baht(monthly)}</b></div>
    ${list.length ? `<div class="list">${list.map((b) => {
      const nx = nextDue(b);
      return `<button class="item" data-bill="${b.id}">
        ${icoHtml(b)}
        <div class="main"><div class="name">${esc(b.name)}</div>
          <div class="sub">${repeatText(b)} · ${nx ? `ครั้งถัดไป ${thShortDate(nx.due)}` : 'ครบแล้ว'}</div></div>
        <div class="right"><div class="amt">${b.variable && !b.amount ? '<span class="muted small">ไม่แน่นอน</span>' : `-${baht(b.amount)}`}</div></div>
      </button>`;
    }).join('')}</div>` : '<div class="card muted" style="text-align:center">ยังไม่มีบิลแบบทำซ้ำ กด "เพิ่ม" เพื่อสร้าง</div>'}
  `);
}

// Detail sheet for any bill: icon, category, amount, then pickers that save right away.
function billDetail(id) {
  const b = state.bills.find((x) => x.id === id);
  if (!b) return;
  const c = cat(b);
  const nx = nextDue(b);
  const w = billWallet(b);
  const wal = w ? walletById(w) : null;
  const days = Array.from({ length: 31 }, (_, i) => i + 1)
    .map((d) => `<option value="${d}" ${Number(b.dueDay) === d ? 'selected' : ''}>วันที่ ${d}</option>`).join('');
  const remindLab = (n) => (n === 0 ? 'วันครบกำหนด' : `ล่วงหน้า ${n} วัน`);
  const pick = (label, value, control) => `<label class="prow"><span class="pl">${label}</span><span class="pv">${value}${control ? svgIcon('updown', 'svg-i ud') : ''}</span>${control || ''}</label>`;
  const end = billEndMonth(b);
  const months = Array.from({ length: 120 }, (_, i) => i + 1)
    .map((n) => `<option value="${n}" ${b.months === n ? 'selected' : ''}>${n} งวด</option>`).join('');

  let rows = pick('จ่ายจาก', wal ? `${walletIco(wal, 'wico')}${esc(wal.name)}` : 'ไม่บันทึกเป็นรายการ',
    `<select data-bset="walletId"><option value="">ไม่บันทึกเป็นรายการ</option>${money.wallets.map((x) => `<option value="${x.id}" ${x.id === w ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`);
  if (b.type === 'once') {
    const d = parseDs(b.onceDate);
    rows += pick('วันที่', `${thShortDate(d)} ${d.getFullYear() + BE}`, `<input type="date" data-bset="onceDate" value="${b.onceDate}">`);
    rows += pick('ทำซ้ำ', `${svgIcon('repeat', 'svg-i xs')} ไม่ทำซ้ำ`);
  } else {
    rows += pick('เริ่ม', thMonthYear(b.startMonth), `<input type="month" data-bset="startMonth" value="${b.startMonth}">`);
    rows += pick('ครบกำหนด', `ทุกวันที่ ${b.dueDay}`, `<select data-bset="dueDay">${days}</select>`);
    rows += pick('ทำซ้ำ', `${svgIcon('repeat', 'svg-i xs')} ${repeatText(b)}`);
    rows += b.type === 'installment'
      ? pick('สิ้นสุด', `${thMonthYear(end)} · ${b.months} งวด`, `<select data-bset="months">${months}</select>`)
      : pick('สิ้นสุด', 'ไม่มีวันสิ้นสุด');
  }
  if (b.pea) {
    const fd = b.pea.day === undefined ? 'due' : b.pea.day;
    rows += pick('ดึงค่าไฟอัตโนมัติ', fd === 'due' ? `ตามวันครบกำหนด (วันที่ ${b.dueDay})` : fd ? `ทุกวันที่ ${fd}` : 'ไม่ดึงเอง',
      `<select data-bset="peaDay">${peaDayOptions(fd)}</select>`);
  }
  rows += pick('เตือน', `${svgIcon('bell', 'svg-i xs')} ${remindLab(remindOf(b))}`, `<select data-bset="remind">${remindOpts(b.remind)}</select>`);
  rows += pick('ตัดบัญชีอัตโนมัติ', b.autopay ? 'ใช่' : 'ไม่',
    `<select data-bset="autopay"><option value="">ไม่</option><option value="1" ${b.autopay ? 'selected' : ''}>ใช่</option></select>`);

  const amount = b.variable && !b.amount ? 'ยอดไม่แน่นอน' : `-${baht(b.amount)}`;
  openSheet(`
    <div class="detail-bar">
      <button class="round-btn sm" data-action="close" aria-label="ปิด">✕</button>
      <span style="flex:1"></span>
      <button class="pill-btn" data-edit="${b.id}">แก้ไข</button>
      <button class="round-btn sm" id="bdDel" aria-label="ลบบิล">${svgIcon('trash')}</button>
    </div>
    <div class="bd-hero">
      <div class="hero-ico" style="background:${c.color}2e">${c.icon}</div>
      <div class="bd-name">${esc(b.name)}</div>
      <div class="bd-cat">${c.label}${b.variable && b.amount ? ' · ยอดประมาณ' : ''}</div>
      <div class="bd-amt">${amount}</div>
      ${nx ? `<button class="bd-next" data-occ="${b.id}" data-ym="${nx.ym}">ครั้งถัดไป ${thShortDate(nx.due)} ${nx.due.getFullYear() + BE} ›</button>` : ''}
    </div>
    <div class="form prows">${rows}</div>
    <div class="form note-card"><textarea id="bdNote" placeholder="เพิ่มบันทึก" aria-label="บันทึก">${esc(b.note || '')}</textarea></div>
  `);

  $('#sheet').querySelectorAll('[data-bset]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.bset;
    const v = el.value;
    if (k === 'dueDay' || k === 'months') b[k] = Number(v);
    else if (k === 'remind') { if (v === '') delete b.remind; else b.remind = Number(v); }
    else if (k === 'autopay') b.autopay = !!v;
    else if (k === 'peaDay') { b.pea.day = v === 'due' ? 'due' : Number(v); delete b.pea.tried; setTimeout(peaAutoTry, 0); }
    else if (k === 'startMonth' || k === 'onceDate') { if (!v) return; b[k] = v; }
    else b[k] = v;
    save();
    render();
    billDetail(id);
    toast('บันทึกแล้ว');
  }));
  $('#bdNote').addEventListener('change', (e) => { b.note = e.target.value.trim(); save(); render(); toast('บันทึกแล้ว'); });
  $('#bdDel').addEventListener('click', () => deleteBill(b));
}
