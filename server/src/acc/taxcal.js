// ปฏิทินภาษี: a company's year of filing / payment deadlines (Revenue Department, DBD, Social
// Security), worked out from its fiscal year, its shareholders' meeting and which forms apply, and
// reminded through Centel like the การแจ้งเตือน page (centel.js): a to-do with a reminder goes into
// every linked Centel profile ahead of each deadline, and, if switched on, a summary of the month's
// deadlines on the 1st.
//
// The usual deadlines (statutory, then the RD e-filing date where it is later):
//   ภ.พ.30            VAT, every month                 15th of the next month · online 23rd
//   ภ.ง.ด.1/3/53      withholding tax, every month     7th of the next month · online 15th
//   สปส.1-10          social security contributions   15th of the next month
//   ภ.ง.ด.1ก          the year's wages                 end of February of the next year
//   ภ.ง.ด.51          half-year corporate income tax   2 months after the first 6 months · online +8 days
//                     (none for a first fiscal year shorter than 12 months)
//   ประชุมผู้ถือหุ้น     approve the financial statements within 4 months of the year end
//   บอจ.5              shareholders list, 14 days after the meeting
//   งบการเงิน (DBD)    1 month after the meeting
//   ภ.ง.ด.50          annual corporate income tax, 150 days after the year end · online +8 days
// ภ.ง.ด.1/3/53 are only needed in months with payments that had tax withheld; in 'auto' mode the
// reminder goes out only when that month's recorded expenses show such payments.
import { pool } from '../db.js';
import { addTodo, bangkokToday, thDate } from './centel.js';

const ACC_URL = process.env.ACC_PUBLIC_URL || 'https://account.centel.app';
const DAY = 86400e3;
const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DAY = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const baht = (n) => `฿${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// kind: monthly (for the month before), wages (calendar year), half / annual / agm / boj5 / fs
// (from the fiscal year end). cond: which payments make the form needed (auto mode).
export const FORMS = {
  pp30: { tag: 'ภ.พ.30', title: 'ยื่น ภ.พ.30 ภาษีมูลค่าเพิ่ม', kind: 'monthly', paper: 15, online: 23, agency: 'rd', group: 'vat', path: '#/vat/returns' },
  pnd1: { tag: 'ภ.ง.ด.1', title: 'ยื่น ภ.ง.ด.1 หัก ณ ที่จ่าย เงินเดือน', kind: 'monthly', paper: 7, online: 15, agency: 'rd', group: 'staff', cond: 'salary', path: '#/report/wht_pay' },
  sso: { tag: 'สปส.1-10', title: 'นำส่ง สปส.1-10 เงินสมทบประกันสังคม', kind: 'monthly', paper: 15, online: 15, agency: 'sso', group: 'staff' },
  pnd1a: { tag: 'ภ.ง.ด.1ก', title: 'ยื่น ภ.ง.ด.1ก สรุปเงินเดือนทั้งปี', kind: 'wages', agency: 'rd', group: 'staff' },
  pnd3: { tag: 'ภ.ง.ด.3', title: 'ยื่น ภ.ง.ด.3 หัก ณ ที่จ่าย บุคคลธรรมดา', kind: 'monthly', paper: 7, online: 15, agency: 'rd', group: 'wht', cond: 'pnd3', path: '#/report/wht_pay' },
  pnd53: { tag: 'ภ.ง.ด.53', title: 'ยื่น ภ.ง.ด.53 หัก ณ ที่จ่าย นิติบุคคล', kind: 'monthly', paper: 7, online: 15, agency: 'rd', group: 'wht', cond: 'pnd53', path: '#/report/wht_pay' },
  pnd51: { tag: 'ภ.ง.ด.51', title: 'ยื่น ภ.ง.ด.51 ภาษีเงินได้นิติบุคคลครึ่งปี', kind: 'half', agency: 'rd', group: 'company', yearly: true },
  agm: { tag: 'ประชุมผู้ถือหุ้น', title: 'ประชุมสามัญผู้ถือหุ้น อนุมัติงบการเงิน', kind: 'agm', agency: 'company', group: 'company', yearly: true },
  boj5: { tag: 'บอจ.5', title: 'ยื่น บอจ.5 บัญชีรายชื่อผู้ถือหุ้น', kind: 'boj5', agency: 'dbd', group: 'company', yearly: true },
  fs: { tag: 'งบการเงิน', title: 'ยื่นงบการเงินประจำปี (ส.บช.3) กรมพัฒนาธุรกิจการค้า', kind: 'fs', agency: 'dbd', group: 'company', yearly: true },
  pnd50: { tag: 'ภ.ง.ด.50', title: 'ยื่น ภ.ง.ด.50 ภาษีเงินได้นิติบุคคลประจำปี', kind: 'annual', agency: 'rd', group: 'company', yearly: true },
};
export const AUTO_FORMS = ['pnd1', 'pnd3', 'pnd53'];
const ONLINE_EXTRA = 8; // RD e-filing: ภ.ง.ด.50/51 get 8 more days

/* ---------- Dates ---------- */

const ds = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const parse = (s) => s.split('-').map(Number);
export const addDays = (s, k) => new Date(Date.parse(`${s}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
const weekday = (s) => new Date(`${s}T00:00:00Z`).getUTCDay();
// Months later; the last day of a month stays the last day ("within 4 months of 31 Dec" = 30 Apr).
export function addMonths(s, k, eom = true) {
  const [y, m, d] = parse(s);
  const t = y * 12 + (m - 1) + k;
  const ny = Math.floor(t / 12); const nm = (t % 12) + 1;
  return ds(ny, nm, eom && d === dim(y, m) ? dim(ny, nm) : Math.min(d, dim(ny, nm)));
}
// Weekend deadlines are reminded for the Friday before (never later than the real day).
const effective = (due) => { const w = weekday(due); return w === 6 ? addDays(due, -1) : w === 0 ? addDays(due, -2) : due; };
const monthLabel = (ym) => { const [y, m] = parse(ym); return `${TH_MONTH[m - 1]} ${y + 543}`; };
const monthEnd = (ym) => { const [y, m] = parse(ym); return ds(y, m, dim(y, m)); };

// The fiscal year that ends in calendar year `y` (fyStart = month the year starts, 1 = January).
export function fiscalYear(y, fyStart = 1) {
  const endMonth = fyStart === 1 ? 12 : fyStart - 1;
  const end = ds(y, endMonth, dim(y, endMonth));
  const start = addDays(addMonths(end, -12), 1);
  return { start, end };
}

/* ---------- The deadlines of a year ---------- */

// Every deadline whose due day falls between from and to (inclusive) for a profile.
// p: { forms, registered, agm_month, agm_day, filing }, fyStart from the business settings.
export function deadlines(p, fyStart, from, to) {
  const on = (k) => !!p.forms?.[k];
  const out = [];
  const reg = p.registered || null;
  const add = (form, period, paper, online, extra = {}) => {
    const f = FORMS[form];
    const due = p.filing === 'paper' ? paper : online;
    if (due < from || due > to) return;
    out.push({ form, tag: f.tag, title: f.title, agency: f.agency, group: f.group, period, paper, online, due, date: effective(due), ...extra });
  };
  const [fy] = parse(from); const [ty] = parse(to);

  // Monthly forms: the tax month is the month before the due month.
  for (let t = fy * 12 - 2; t <= ty * 12 + 11; t++) {
    const ym = ds(Math.floor(t / 12), (t % 12) + 1, 1).slice(0, 7);
    if (reg && monthEnd(ym) < reg) continue;
    const next = addMonths(`${ym}-01`, 1, false);
    for (const [k, f] of Object.entries(FORMS)) {
      if (f.kind !== 'monthly' || !on(k)) continue;
      const [ny, nm] = parse(next);
      add(k, ym, ds(ny, nm, Math.min(f.paper, dim(ny, nm))), ds(ny, nm, Math.min(f.online, dim(ny, nm))),
        { periodLabel: `เดือนภาษี ${monthLabel(ym)}`, auto: AUTO_FORMS.includes(k) && p.forms[k] === 'auto', month: ym });
    }
  }
  // ภ.ง.ด.1ก: wages of calendar year y, by the end of February y+1.
  if (on('pnd1a')) for (let y = fy - 1; y <= ty; y++) {
    if (reg && `${y}-12-31` < reg) continue;
    const d = ds(y + 1, 2, dim(y + 1, 2));
    add('pnd1a', String(y), d, d, { periodLabel: `เงินได้ปี ${y + 543}` });
  }
  // Fiscal-year forms.
  for (let y = fy - 2; y <= ty; y++) {
    const { start, end } = fiscalYear(y, fyStart);
    if (reg && end < reg) continue;
    const label = `รอบบัญชีปี ${y + 543} (ปิดบัญชี ${thDate(end)})`;
    const period = `FY${y}`;
    if (on('pnd51') && !(reg && reg > start)) {
      const half = addDays(addMonths(start, 6, false), -1);
      const d = addMonths(half, 2);
      add('pnd51', period, d, addDays(d, ONLINE_EXTRA), { periodLabel: `ครึ่งปีแรก ${thDate(start)} – ${thDate(half)}` });
    }
    const latestAgm = addMonths(end, 4);
    let agm = latestAgm; let planned = false;
    if (p.agm_month && p.agm_day) {
      // The planned day in the 12 months after the year end.
      const [ey] = parse(end);
      for (const yy of [ey, ey + 1]) {
        const c = ds(yy, p.agm_month, Math.min(p.agm_day, dim(yy, p.agm_month)));
        if (c > end) { agm = c; planned = true; break; }
      }
    }
    const agmExtra = { periodLabel: label, agm, agmLate: agm > latestAgm, planned };
    if (on('agm')) add('agm', period, agm, agm, { ...agmExtra, latest: latestAgm });
    if (on('boj5')) { const d = addDays(agm, 14); add('boj5', period, d, d, agmExtra); }
    if (on('fs')) { const d = addMonths(agm, 1, false); add('fs', period, d, d, agmExtra); }
    if (on('pnd50')) { const d = addDays(end, 150); add('pnd50', period, d, addDays(d, ONLINE_EXTRA), { periodLabel: label }); }
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : Object.keys(FORMS).indexOf(a.form) - Object.keys(FORMS).indexOf(b.form)));
}

/* ---------- What the month's records say (ภ.ง.ด.1/3/53 in auto mode) ---------- */

const SALARY_CATS = ['salary', 'allowance', 'overtime', 'commission'];

// Per month (YYYY-MM): paid expenses with tax withheld for ภ.ง.ด.3 / 53, and wages paid.
export async function evidence(bizId, fromMonth, toMonth) {
  const from = `${fromMonth}-01`; const to = monthEnd(toMonth);
  const rows = (await pool.query(
    `select to_char((pay->>'date')::date, 'YYYY-MM') as month,
       count(*) filter (where wht > 0 and wht_cert->>'form' = 'pnd3')::int as pnd3_n,
       coalesce(sum(wht) filter (where wht > 0 and wht_cert->>'form' = 'pnd3'), 0)::float as pnd3_tax,
       count(*) filter (where wht > 0 and wht_cert->>'form' = 'pnd53')::int as pnd53_n,
       coalesce(sum(wht) filter (where wht > 0 and wht_cert->>'form' = 'pnd53'), 0)::float as pnd53_tax,
       count(*) filter (where exists (select 1 from jsonb_array_elements(lines) l where l->>'cat' = any($4) or l->>'account' = '52100'))::int as salary_n,
       coalesce(sum((select sum((l->>'base')::numeric) from jsonb_array_elements(lines) l where l->>'cat' = any($4) or l->>'account' = '52100')), 0)::float as salary_amt
     from acc_docs where business_id = $1 and type = 'EX' and status = 'paid' and (pay->>'date')::date between $2 and $3
     group by 1`, [bizId, from, to, SALARY_CATS])).rows;
  const m = {};
  for (const r of rows) m[r.month] = {
    pnd3: { n: r.pnd3_n, amount: r.pnd3_tax }, pnd53: { n: r.pnd53_n, amount: r.pnd53_tax }, salary: { n: r.salary_n, amount: r.salary_amt },
  };
  return m;
}

// need: the month's records show the form is needed; none: the month is over and nothing needs it;
// wait: the month is not over yet.
function condStatus(d, ev, today) {
  const e = ev[d.month]?.[FORMS[d.form].cond] || { n: 0, amount: 0 };
  if (e.n > 0) return { need: 'need', ev: e };
  return { need: today > monthEnd(d.month) ? 'none' : 'wait', ev: e };
}

const evText = (form, e) => (!e?.n ? ''
  : form === 'pnd1' ? `เดือนนี้บันทึกจ่ายเงินเดือน/ค่าจ้าง ${e.n} รายการ รวม ${baht(e.amount)} ถ้ามีภาษีต้องหักให้ยื่น ภ.ง.ด.1`
    : `เดือนนี้มีรายการจ่ายที่หัก ณ ที่จ่าย ${e.n} รายการ ภาษีที่หักไว้ ${baht(e.amount)}`);

/* ---------- One business's calendar ---------- */

export async function profileOf(bizId) {
  return (await pool.query('select *, registered::text as registered from acc_tax_profiles where business_id = $1', [bizId])).rows[0] || null;
}

// Deadlines between two dates with their status: done, need / none / wait (auto forms), overdue.
export async function calendarOf(bizId, fyStart, profile, from, to, today = bangkokToday()) {
  const list = deadlines(profile, fyStart, from, to);
  if (!list.length) return [];
  const since = profile.created_at ? bangkokToday(new Date(profile.created_at)) : '0000-00-00';
  const months = list.filter((d) => d.month).map((d) => d.month).sort();
  const ev = months.length ? await evidence(bizId, months[0], months[months.length - 1]) : {};
  const done = new Map((await pool.query('select form, period, ref, done_at from acc_tax_done where business_id = $1', [bizId])).rows
    .map((r) => [`${r.form}:${r.period}`, r]));
  // A ภ.พ.30 marked as filed on the เตรียมแบบภาษีรายเดือน page counts as done here too.
  for (const r of (await pool.query("select month, filed_at, filed_ref from acc_vat_returns where business_id = $1 and form = 'PP30' and status = 'filed'", [bizId])).rows) {
    if (!done.has(`pp30:${r.month}`)) done.set(`pp30:${r.month}`, { ref: r.filed_ref, done_at: r.filed_at, vat: true });
  }
  return list.map((d) => {
    const x = done.get(`${d.form}:${d.period}`);
    const c = FORMS[d.form].cond ? condStatus(d, ev, today) : null;
    // Past deadlines from before the calendar was set up are not known to be missed.
    const status = x ? 'done' : d.auto && c.need === 'none' ? 'none' : d.date < today ? (d.date < since ? 'past' : 'overdue') : 'upcoming';
    return { ...d, status, need: c?.need || null, evidence: c?.ev || null, done: x ? { ref: x.ref || null, at: x.done_at, vat: !!x.vat } : null };
  });
}

/* ---------- Reminders through Centel ---------- */

const ahead = (d, remind) => (FORMS[d.form].yearly ? 30 : Math.max(7, remind + 1));
const remindOf = (d, remind) => (FORMS[d.form].yearly ? Math.max(remind, 7) : remind);

export function taxTodo(d, bizName, filing = 'online') {
  const f = FORMS[d.form];
  const head = `${f.title} (${d.form === 'pnd1a' ? d.periodLabel : d.month ? monthLabel(d.month) : d.periodLabel.replace(/ \(.*\)$/, '')}) · ${bizName}`;
  const lines = [`กำหนด${d.form === 'agm' ? 'ประชุม' : d.form === 'sso' ? 'นำส่ง' : 'ยื่น'}ภายในวันที่ ${thDate(d.due)} (${TH_DAY[weekday(d.due)]})`];
  if (d.paper !== d.online) lines.push(filing === 'paper' ? `ยื่นออนไลน์ได้ถึง ${thDate(d.online)}` : `ยื่นแบบกระดาษภายใน ${thDate(d.paper)}`);
  if (d.date !== d.due) lines.push(`ตรงวันหยุดเสาร์-อาทิตย์ จึงเตือนให้ทำก่อนวันศุกร์ที่ ${thDate(d.date)}`);
  if (d.periodLabel) lines.push(d.periodLabel);
  if (['boj5', 'fs'].includes(d.form)) lines.push(`นับจากวันประชุมสามัญผู้ถือหุ้น ${thDate(d.agm)}${d.planned ? '' : ' (วันสุดท้ายที่ประชุมได้)'}`);
  if (d.form === 'agm') lines.push('ให้ผู้สอบบัญชีตรวจงบการเงินก่อนประชุม แล้วยื่น บอจ.5 ภายใน 14 วัน และงบการเงินภายใน 1 เดือนหลังประชุม');
  if (d.form === 'pnd50') lines.push('ต้องยื่นแม้ไม่มีรายได้หรือภาษีเป็น 0 บาท');
  if (d.form === 'pp30') lines.push('ยื่นทุกเดือนแม้ไม่มียอดขาย');
  const ev = evText(d.form, d.evidence);
  if (ev) lines.push(ev);
  if (d.agency === 'rd') lines.push('ถ้าตรงวันหยุดราชการ ตรวจประกาศกรมสรรพากรของเดือนนั้นอีกครั้ง');
  lines.push(`เปิดปฏิทินภาษี: ${ACC_URL}/#/taxcal`);
  return { text: head.slice(0, 500), body: lines.join('\n').slice(0, 5000), tags: ['บัญชี', 'ภาษี'] };
}

function digestTodo(ym, items, bizName) {
  const lines = items.map((d) => `• ${thDate(d.due)} ${FORMS[d.form].tag}${d.auto ? ' (ถ้ามีรายการจ่าย)' : ''} ${d.month ? monthLabel(d.month) : ''}`.trim());
  lines.push(`เปิดปฏิทินภาษี: ${ACC_URL}/#/taxcal`);
  return { text: `ภาษีที่ต้องยื่นเดือน ${monthLabel(ym)} ${items.length} รายการ · ${bizName}`.slice(0, 500), body: lines.join('\n'), tags: ['บัญชี', 'ภาษี'] };
}

const CLAIM = 'insert into acc_tax_sent (business_id, form, period, user_id, due_date) values ($1, $2, $3, $4, $5) on conflict do nothing returning 1';
const SETNOTE = 'update acc_tax_sent set note_id = $6 where business_id = $1 and form = $2 and period = $3 and user_id = $4 and due_date = $5';

// Adds the coming deadlines of every set-up business to its linked Centel profiles, once each.
export async function syncTaxCalendar({ businessId = null, now = new Date() } = {}) {
  const today = bangkokToday(now);
  let added = 0;
  const bizs = (await pool.query(
    `select p.*, p.registered::text as registered, b.name as biz_name, coalesce((b.settings->>'fyStart')::int, 1) as fy_start,
       array(select l.user_id from acc_centel_links l where l.business_id = p.business_id) as users
     from acc_tax_profiles p join acc_businesses b on b.id = p.business_id
     where ($1::uuid is null or p.business_id = $1) and exists (select 1 from acc_centel_links l where l.business_id = p.business_id)`,
    [businessId])).rows;
  for (const b of bizs) {
    const profile = b;
    const list = await calendarOf(b.business_id, b.fy_start, profile, today, addDays(today, 40), today);
    for (const d of list) {
      if (d.status !== 'upcoming') continue;
      if (d.date < today || d.date > addDays(today, ahead(d, b.remind_days))) continue;
      // Auto forms: only once the month's records show the form is needed.
      if (d.auto && d.need !== 'need') continue;
      const todo = taxTodo(d, b.biz_name, b.filing);
      for (const u of b.users) {
        added += await addTodo(CLAIM, [b.business_id, d.form, d.period, u, d.due], SETNOTE, u, todo, d.date, remindOf(d, b.remind_days), now)
          .catch((e) => { console.error('tax calendar', b.business_id, e.message); return 0; });
      }
    }
    // The month's summary on the 1st, put in a week ahead.
    if (b.digest) {
      const first = addMonths(`${today.slice(0, 7)}-01`, today.slice(8) === '01' ? 0 : 1, false);
      if (first <= addDays(today, 7)) {
        const ym = first.slice(0, 7);
        const items = (await calendarOf(b.business_id, b.fy_start, profile, first, monthEnd(ym), today)).filter((d) => d.status !== 'done' && d.status !== 'none');
        if (items.length) {
          const todo = digestTodo(ym, items, b.biz_name);
          for (const u of b.users) {
            added += await addTodo(CLAIM, [b.business_id, 'digest', ym, u, first], SETNOTE, u, todo, first, 0, now)
              .catch((e) => { console.error('tax digest', b.business_id, e.message); return 0; });
          }
        }
      }
    }
  }
  return added;
}

// Takes back calendar to-dos that have not reminded anyone yet (all, or one deadline); a deadline
// marked done also ticks a to-do that already reminded.
export async function withdrawTax(businessId, { form = null, period = null, userId = null, tick = false } = {}) {
  await pool.query(
    `with gone as (
       delete from acc_tax_sent s where s.business_id = $1 and ($2::text is null or s.form = $2) and ($3::text is null or s.period = $3)
         and ($4::uuid is null or s.user_id = $4)
         and (s.note_id is null or exists (select 1 from notes n where n.id = s.note_id and n.notified_at is null and not n.done))
       returning s.note_id)
     delete from notes where id in (select note_id from gone)`, [businessId, form, period, userId]);
  if (tick && form) {
    await pool.query(
      `update notes set done = true where id in (select note_id from acc_tax_sent where business_id = $1 and form = $2 and period = $3)`,
      [businessId, form, period]).catch(() => {});
  }
}

/* ---------- Routes: /api/acc/b/:biz/taxcal ---------- */

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const LEGACY = ['pp30', 'pnd1', 'pnd3', 'pnd53']; // the การแจ้งเตือน page's monthly tax presets

function cleanForms(v) {
  const out = {};
  for (const k of Object.keys(FORMS)) {
    const x = v?.[k];
    out[k] = AUTO_FORMS.includes(k) && x === 'auto' ? 'auto' : !!x;
  }
  return out;
}

export function mountTaxCal(biz, { wrap }) {
  biz.get('/taxcal', wrap(async (req, res) => {
    const profile = await profileOf(req.biz.id);
    const fyStart = req.biz.settings?.fyStart || 1;
    const today = bangkokToday();
    const year = Number(req.query.year) >= 2000 && Number(req.query.year) <= 2100 ? Number(req.query.year) : Number(today.slice(0, 4));
    const items = profile ? await calendarOf(req.biz.id, fyStart, profile, `${year}-01-01`, `${year}-12-31`, today) : [];
    const links = (await pool.query('select count(*)::int as n from acc_centel_links where business_id = $1', [req.biz.id])).rows[0].n;
    const legacy = (await pool.query('select kind from acc_reminders where business_id = $1 and kind = any($2) and active', [req.biz.id, LEGACY])).rows.map((r) => r.kind);
    res.json({ profile, fyStart, vat_registered: !!req.biz.vat_registered, year, today, items, links, legacy, forms: FORMS });
  }));

  biz.put('/taxcal/profile', wrap(async (req, res) => {
    const b = req.body || {};
    const forms = cleanForms(b.forms);
    const registered = b.registered ? (isDate(b.registered) ? b.registered : null) : null;
    if (b.registered && !registered) throw bad('bad_date');
    const agmMonth = b.agm_month ? Number(b.agm_month) : null;
    const agmDay = b.agm_day ? Number(b.agm_day) : null;
    if ((agmMonth && !(agmMonth >= 1 && agmMonth <= 12)) || (agmDay && !(agmDay >= 1 && agmDay <= 31)) || (!agmMonth !== !agmDay)) throw bad('bad_agm');
    const remind = b.remind_days === undefined ? 2 : Number(b.remind_days);
    if (![0, 1, 2, 3, 7].includes(remind)) throw bad('bad_remind');
    const filing = b.filing === 'paper' ? 'paper' : 'online';
    // The fiscal year and VAT registration belong to the business; the setup can change them.
    const fyStart = b.fyStart !== undefined ? Math.min(12, Math.max(1, Math.floor(Number(b.fyStart) || 1))) : null;
    if (fyStart || b.vat_registered !== undefined) {
      await pool.query(
        `update acc_businesses set settings = case when $2::int is null then settings else jsonb_set(coalesce(settings, '{}'), '{fyStart}', to_jsonb($2::int)) end,
           vat_registered = coalesce($3::boolean, vat_registered) where id = $1`,
        [req.biz.id, fyStart, b.vat_registered === undefined ? null : !!b.vat_registered]);
    }
    await withdrawTax(req.biz.id);
    await pool.query(
      `insert into acc_tax_profiles (business_id, forms, registered, agm_month, agm_day, filing, remind_days, digest, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (business_id) do update set forms = $2, registered = $3, agm_month = $4, agm_day = $5, filing = $6,
         remind_days = $7, digest = $8, updated_at = now()`,
      [req.biz.id, JSON.stringify(forms), registered, agmMonth, agmDay, filing, remind, b.digest !== false, req.user.id]);
    // The การแจ้งเตือน page's monthly tax presets for forms the calendar now covers would remind
    // twice: they move here (their unsent to-dos are taken back).
    const moved = (await pool.query('select distinct kind from acc_reminders where business_id = $1 and kind = any($2)',
      [req.biz.id, LEGACY.filter((k) => forms[k])])).rows.map((r) => r.kind);
    if (moved.length) {
      await pool.query(
        `with gone as (
           delete from acc_reminder_sent s using acc_reminders r
           where r.id = s.reminder_id and r.business_id = $1 and r.kind = any($2)
             and (s.note_id is null or exists (select 1 from notes n where n.id = s.note_id and n.notified_at is null and not n.done))
           returning s.note_id)
         delete from notes where id in (select note_id from gone)`, [req.biz.id, moved]);
      await pool.query('delete from acc_reminders where business_id = $1 and kind = any($2)', [req.biz.id, moved]);
    }
    const added = await syncTaxCalendar({ businessId: req.biz.id }).catch((e) => { console.error('tax calendar', e.message); return 0; });
    res.json({ profile: await profileOf(req.biz.id), moved, added });
  }));

  // Mark a deadline filed / paid (or not).
  biz.post('/taxcal/done', wrap(async (req, res) => {
    const { form, period } = req.body || {};
    if (!FORMS[form] || typeof period !== 'string' || !/^(\d{4}-\d{2}|\d{4}|FY\d{4})$/.test(period)) throw bad('bad_item');
    if (req.body.done === false) {
      await pool.query('delete from acc_tax_done where business_id = $1 and form = $2 and period = $3', [req.biz.id, form, period]);
      await syncTaxCalendar({ businessId: req.biz.id }).catch(() => 0);
    } else {
      const ref = req.body.ref ? String(req.body.ref).trim().slice(0, 100) || null : null;
      await pool.query(
        `insert into acc_tax_done (business_id, form, period, ref, done_by) values ($1, $2, $3, $4, $5)
         on conflict (business_id, form, period) do update set ref = $4, done_by = $5, done_at = now()`,
        [req.biz.id, form, period, ref, req.user.id]);
      await withdrawTax(req.biz.id, { form, period, tick: true });
    }
    res.json({ ok: true });
  }));
}
