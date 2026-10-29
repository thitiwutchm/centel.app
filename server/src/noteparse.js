/* Reads a date and time out of a note line, for notes typed into the LINE group.
   A port of parseNote() in the app's notes.js (keep the two in step), working in
   Thai time (UTC+7) whatever the server's own time zone is: the Date values here
   carry Bangkok wall-clock time in their UTC fields. */

const TZ_MS = 7 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');

// English names need word edges so "lemon" is not Monday; Thai has no spaces to lean on.
// Short Thai forms are read with or without the dots ("ต.ค." or "ตค").
const NO_THAI = '(?![\\u0E01-\\u0E4E])';
const NOTE_MONTHS = [
  'มกราคม|มกรา|ม\\.?ค\\.?|\\bjan(?:uary)?\\b', 'กุมภาพันธ์|กุมภา|ก\\.?พ\\.?|\\bfeb(?:ruary)?\\b', 'มีนาคม|มีนา|มี\\.?ค\\.?|\\bmar(?:ch)?\\b',
  'เมษายน|เมษา|เม\\.?ย\\.?|\\bapr(?:il)?\\b', 'พฤษภาคม|พฤษภา|พ\\.?ค\\.?|\\bmay\\b', 'มิถุนายน|มิถุนา|มิ\\.?ย\\.?|\\bjune?\\b',
  'กรกฎาคม|กรกฎา|ก\\.?ค\\.?|\\bjuly?\\b', 'สิงหาคม|สิงหา|ส\\.?ค\\.?|\\baug(?:ust)?\\b', 'กันยายน|กันยา|ก\\.?ย\\.?|\\bsep(?:t|tember)?\\b',
  'ตุลาคม|ตุลา|ต\\.?ค\\.?|\\boct(?:ober)?\\b', 'พฤศจิกายน|พฤศจิกา|พ\\.?ย\\.?|\\bnov(?:ember)?\\b', 'ธันวาคม|ธันวา|ธ\\.?ค\\.?|\\bdec(?:ember)?\\b',
].map((x) => `(?:${x})${NO_THAI}`);
const NOTE_DOW = ['อาทิตย์|\\bsun(?:day)?\\b', 'จันทร์|\\bmon(?:day)?\\b', 'อังคาร|\\btue(?:s|sday)?\\b', 'พุธ|\\bwed(?:nesday)?\\b',
  'พฤหัส(?:บดี)?|\\bthu(?:rs|rsday)?\\b', 'ศุกร์|\\bfri(?:day)?\\b', 'เสาร์|\\bsat(?:urday)?\\b'];

// Full year from what was typed: 2569 / 69 (Buddhist) or 2026 / 26.
function noteYear(y) {
  let n = Number(y);
  if (n < 100) n += n >= 40 ? 2500 : 2000;
  return n > 2400 ? n - 543 : n;
}

const day = (y, m, d) => new Date(Date.UTC(y, m, d));
const dateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Today in Thailand as YYYY-MM-DD plus the weekday name, for the AI's prompt.
export function thaiToday(now = new Date()) {
  const t = new Date(now.getTime() + TZ_MS);
  return { date: dateStr(t), time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`, weekday: t.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) };
}

// Returns { text, date, time } with the date words taken out of text; date is '' when
// nothing in the line looks like a date or time. timeOnly is set when only a time was given.
export function parseNote(raw, now = new Date()) {
  const t = new Date(now.getTime() + TZ_MS);
  let s = ` ${raw} `;
  const take = (rx) => { const m = s.match(rx); if (m) s = s.replace(m[0], ' '); return m; };
  let time = '';
  let endTime = '';
  const hhmm = (h, m = 0) => (h >= 0 && h < 24 && m >= 0 && m < 60 ? `${pad(h)}:${pad(m)}` : '');
  const hm = (h, m = 0) => { time = hhmm(h, m); };
  const ap = (h, x) => (h % 12) + (/pm/i.test(x) ? 12 : 0);
  let m;
  // A range first: "10:00-12:00", "10.00 ถึง 12.00 น.", "11 AM - 12 PM", "11:00 am to 1:30 pm".
  if ((m = take(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) {
    hm(ap(+m[1], m[3] || m[6]), +(m[2] || 0)); endTime = hhmm(ap(+m[4], m[6]), +(m[5] || 0));
  } else if ((m = take(/(?:เวลา\s*|ตอน\s*)?(\d{1,2})[:.](\d{2})\s*(?:น\.?)?\s*(?:-|–|ถึง|to)\s*(\d{1,2})[:.](\d{2})\s*(?:นาฬิกา|น\.?(?![\u0E01-\u0E4E]))?/i))) {
    hm(+m[1], +m[2]); endTime = hhmm(+m[3], +m[4]);
  }
  if (time) { if (!endTime || endTime <= time) endTime = ''; m = null; } else
  if ((m = take(/(?:เวลา\s*|ตอน\s*)?(\d{1,2})[:.](\d{2})\s*(?:นาฬิกา|น\.?(?![ก-๎]))?/))) hm(+m[1], +m[2]);
  else if ((m = take(/(?:ตอน\s*)?เที่ยงคืน/))) hm(0);
  else if ((m = take(/(?:ตอน\s*)?เที่ยง(?:วัน)?/))) hm(12);
  else if ((m = take(/(?:ตอน\s*)?บ่าย\s*โมง/))) hm(13);
  else if ((m = take(/(?:ตอน\s*)?บ่าย\s*(\d{1,2})\s*(?:โมง)?/))) hm(12 + +m[1]);
  else if ((m = take(/(?:ตอน\s*)?(\d{1,2})\s*ทุ่ม/))) hm(18 + +m[1]);
  else if ((m = take(/(?:ตอน\s*)?(\d{1,2})\s*โมง\s*(เช้า|เย็น)?/))) hm(m[2] === 'เย็น' && +m[1] < 12 ? +m[1] + 12 : +m[1]);
  else if ((m = take(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) hm((+m[1] % 12) + (/pm/i.test(m[3]) ? 12 : 0), +(m[2] || 0));

  const base = day(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const addDays = (n) => day(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + n);
  let date = null;
  let dow = -1;
  let nextWeek = false;
  NOTE_DOW.some((rx, i) => {
    const w = take(new RegExp(`(?:วัน)?(?:${rx})(?:\\s*(หน้า|นี้|next))?`, 'i'));
    if (w) { dow = i; nextWeek = w[1] === 'หน้า' || w[1] === 'next'; }
    return !!w;
  });
  if ((m = take(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
    const y = m[3] ? noteYear(m[3]) : base.getUTCFullYear();
    date = day(y, +m[2] - 1, +m[1]);
    if (!m[3] && date < base) date = day(y + 1, +m[2] - 1, +m[1]);
  } else if ((m = take(new RegExp(`(?:วันที่|ที่)?\\s*(\\d{1,2})\\s*(${NOTE_MONTHS.map((x) => `(${x})`).join('|')})\\s*(\\d{4}|\\d{2}(?!\\d))?`, 'i')))) {
    const mon = m.slice(3, 15).findIndex(Boolean);
    const yt = m[15];
    const y = yt ? noteYear(yt) : base.getUTCFullYear();
    date = day(y, mon, +m[1]);
    if (!yt && date < base) date = day(y + 1, mon, +m[1]);
  } else if ((m = take(new RegExp(`(${NOTE_MONTHS.map((x) => `(${x})`).join('|')})\\s*(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, 'i')))) {
    // "Nov 30", "Nov 30, 2026": month first, as English writes it.
    const mon = m.slice(2, 14).findIndex(Boolean);
    const y = m[15] ? noteYear(m[15]) : base.getUTCFullYear();
    date = day(y, mon, +m[14]);
    if (!m[15] && date < base) date = day(y + 1, mon, +m[14]);
  } else if ((m = take(/(?:วันที่|ที่|the)\s*(\d{1,2})(?!\d)(?:st|nd|rd|th)?/i)) && +m[1] >= 1 && +m[1] <= 31) {
    // "จันทร์ที่ 1": the next 1st that is a Monday, if one comes within a year; else the next 1st.
    const dd = +m[1];
    const fits = [];
    for (let i = 0; i < 13; i++) {
      const d = day(base.getUTCFullYear(), base.getUTCMonth() + i, dd);
      if (d.getUTCDate() === dd && d >= base) fits.push(d);
    }
    date = (dow >= 0 && fits.find((d) => d.getUTCDay() === dow)) || fits[0] || null;
  }
  if (!date && dow >= 0) date = addDays(((dow - base.getUTCDay() + 7) % 7) + (nextWeek ? 7 : 0));
  if (!date) {
    if (take(/มะรืน(?:นี้)?/)) date = addDays(2);
    else if (take(/พรุ่งนี้|tomorrow/i)) date = addDays(1);
    else if (take(/วันนี้|คืนนี้|today|tonight/i)) date = addDays(0);
  }
  // A time on its own means the next time it comes round: today, or tomorrow once past.
  const timeOnly = !date && !!time;
  if (timeOnly) date = addDays(time > `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` ? 0 : 1);
  // Commas left between the words taken out ("…, Nov 30, 10 AM") go too.
  const text = s.replace(/\s+/g, ' ').replace(/(\s*,)+\s*$/, '').replace(/^\s*,/, '').replace(/,(\s*,)+/g, ',').trim();
  // A line that is only a date or time ("19:30", an edit) keeps it; the words stay as the text.
  // timeOnly: the date was not in the words, only worked out from the time.
  return { text: text || raw.trim(), date: date ? dateStr(date) : '', time, endTime: time ? endTime : '', ...(timeOnly ? { timeOnly } : {}) };
}

// When the reminder is due: `remind` minutes before the note's time in Thailand,
// or before 09:00 on a note without one (as noteRemindAt() in the app).
export function remindAt(date, time, remind) {
  if (!date || remind == null) return null;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time ? time.split(':').map(Number) : [9, 0];
  return new Date(Date.UTC(y, mo - 1, d, h, mi - remind) - TZ_MS);
}
