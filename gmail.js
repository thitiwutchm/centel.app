'use strict';

/* ---------- Gmail AutoSync: bill-pull rules over Gmail ----------
 * A rule is an Auto Sync bill with `gmail: { sender, account, day, last }`: emails from
 * `sender` (addresses or domains, space-separated) fill that bill's monthly amount and due
 * date, and from day `day` of each month the app pulls new ones on its own.
 * The browser talks to Gmail directly with a short-lived, read-only access token
 * from Google Identity Services. Nothing is sent to our server; the OAuth client
 * id comes from /api/config (Railway variable GOOGLE_CLIENT_ID via the Caddyfile).
 */

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_TOKEN_KEY = 'centel.gmail.token';

// Presets for common Thai e-bill senders; picking one fills a new rule's name, senders and category.
const GMAIL_PROVIDERS = [
  { key: 'ais', name: 'AIS', domains: ['ais.co.th', 'ais.th'], category: 'phone' },
  { key: 'true', name: 'True', domains: ['truecorp.co.th', 'true.th', 'truemoveh.com', 'trueonline.co.th'], category: 'phone' },
  { key: 'dtac', name: 'dtac', domains: ['dtac.co.th'], category: 'phone' },
  { key: '3bb', name: '3BB', domains: ['3bb.co.th'], category: 'internet' },
  { key: 'nt', name: 'NT', domains: ['ntplc.co.th', 'nt.co.th', 'tot.co.th', 'cattelecom.com'], category: 'phone' },
];

const BILL_WORDS = /ใบแจ้งค่าบริการ|ใบแจ้งหนี้|ใบแจ้งยอด|ค่าบริการ|e-?bill|invoice|statement|bill/i;

const gmail = { clientId: null, tokenClient: null, scriptP: null, results: null };

/* ----- Parsing (pure; also used by tests) ----- */

const TH_MONTH_NAMES = [
  ['มกราคม', 'ม.ค.', 'jan'], ['กุมภาพันธ์', 'ก.พ.', 'feb'], ['มีนาคม', 'มี.ค.', 'mar'], ['เมษายน', 'เม.ย.', 'apr'],
  ['พฤษภาคม', 'พ.ค.', 'may'], ['มิถุนายน', 'มิ.ย.', 'jun'], ['กรกฎาคม', 'ก.ค.', 'jul'], ['สิงหาคม', 'ส.ค.', 'aug'],
  ['กันยายน', 'ก.ย.', 'sep'], ['ตุลาคม', 'ต.ค.', 'oct'], ['พฤศจิกายน', 'พ.ย.', 'nov'], ['ธันวาคม', 'ธ.ค.', 'dec'],
];

// Thai bills write years in BE (2569) or short BE (69); English ones in CE.
function gmailYear(y) {
  y = Number(y);
  if (y < 100) y = y >= 50 ? y + 2500 : y + 2000;
  if (y > 2400) y -= 543;
  return y;
}

function gmailMonthIndex(word) {
  const w = word.toLowerCase().replace(/\s/g, '');
  return TH_MONTH_NAMES.findIndex(([full, short, en]) => w === full || w === short.replace(/\s/g, '') || w.startsWith(en));
}

// First date in a string, as "YYYY-MM-DD".
function gmailParseDate(s) {
  let m = s.match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/);
  if (m) return gmailDateStr(gmailYear(m[3]), +m[2], +m[1]);
  m = s.match(/(\d{1,2})\s*([ก-๙.]{3,12}|[A-Za-z]{3,9})\.?\s*,?\s*(\d{2,4})/);
  if (m) {
    const i = gmailMonthIndex(m[2]);
    if (i >= 0) return gmailDateStr(gmailYear(m[3]), i + 1, +m[1]);
  }
  return null;
}

function gmailDateStr(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 2000 && y < 2100)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function gmailMoney(s) { return Number(s.replace(/,/g, '')); }

// Pull amount, due date and account number out of an e-bill's subject + text.
function gmailParseBill({ from, subject, text, date }) {
  const body = `${subject || ''}\n${text || ''}`.replace(/[ ​]/g, ' ');
  const flat = body.replace(/\s+/g, ' ');

  let amount = null;
  const amtRe = /(ยอด(?:เงิน)?(?:รวม)?(?:ที่)?(?:ต้อง)?ชำระ(?:ทั้งสิ้น)?|ยอดค่าบริการ(?:รวม)?|จำนวนเงิน(?:ที่ต้องชำระ)?|total\s*amount\s*(?:due|payable)|amount\s*(?:due|payable)|bill\s*total(?:\s*\(baht\))?|total\s*amount|total\s*due|balance\s*due)[^0-9]{0,40}?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/i;
  let m = flat.match(amtRe);
  if (m) amount = gmailMoney(m[2]);
  if (amount == null) {
    m = flat.match(/([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[0-9]+\.[0-9]{2})\s*(?:บาท|baht|thb)/i)
      || flat.match(/(?:฿|thb)\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[0-9]+\.[0-9]{2})/i);
    if (m) amount = gmailMoney(m[1]);
  }

  let due = null;
  m = flat.match(/(กำหนด(?:การ)?ชำระ(?:เงิน)?(?:ภายใน)?(?:วันที่)?|ครบกำหนด(?:ชำระ)?|ชำระ(?:เงิน)?ภายใน(?:วันที่)?|วันที่ครบกำหนด|due\s*date|payment\s*due(?:\s*date)?|(?:please\s*)?pay\s*by)\s*:?\s*(.{0,40})/i);
  if (m) due = gmailParseDate(m[2]);

  // A mobile number is the most useful key for phone bills; otherwise take the labelled account number.
  let account = '';
  m = flat.match(/\b0[689][0-9]-?[0-9xX*]{3}-?[0-9xX*]{4}\b/);
  if (m) account = m[0].replace(/-/g, '');
  if (!account) m = flat.match(/(?:หมายเลข(?:โทรศัพท์|บริการ|ผู้ใช้บริการ)?|เบอร์(?:โทรศัพท์)?|mobile\s*(?:no\.?|number)|phone\s*(?:no\.?|number)|account\s*(?:no\.?|number)|เลขที่บัญชี|รหัสลูกค้า)\s*:?\s*([0-9][0-9 xX*-]{7,16}[0-9xX*])/i);
  if (!account && m) account = m[1].replace(/[\s-]/g, '');

  const sent = date ? new Date(date) : null;
  const ym = (due || (sent && !isNaN(sent) ? `${sent.getFullYear()}-${String(sent.getMonth() + 1).padStart(2, '0')}` : '')).slice(0, 7) || null;
  return { amount, due, account, ym, isBill: amount != null || BILL_WORDS.test(subject || '') };
}

/* ----- Gmail API ----- */

function gmailB64(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function gmailCellText(c) { return c.textContent.replace(/\s+/g, ' ').trim(); }

// E-bills (e.g. True) lay out "Total Amount Payable | Current Due Date" as a header row with
// the figures in the row below. Pair each header with its value ("label: value") and put
// those lines first so the label regexes hit the right column.
function gmailTablePairs(doc) {
  const out = [];
  doc.querySelectorAll('tr').forEach((tr) => {
    const next = tr.nextElementSibling;
    if (!next || next.tagName !== 'TR') return;
    const heads = Array.from(tr.cells).map(gmailCellText);
    const vals = Array.from(next.cells).map(gmailCellText);
    if (heads.length < 2 || heads.length !== vals.length) return;
    if (!heads.some((x) => /[A-Za-zก-๙]/.test(x)) || heads.some((x) => /\d[\d,]*\.\d{2}/.test(x))) return;
    heads.forEach((hd, i) => { if (hd && vals[i]) out.push(`${hd}: ${vals[i]}`); });
  });
  return out.join('\n');
}

function gmailHtmlToText(html) {
  const doc = new DOMParser().parseFromString(html.replace(/<(br|\/p|\/div|\/tr|\/td|\/th|\/li)[^>]*>/gi, '$& \n'), 'text/html');
  return doc.body ? `${gmailTablePairs(doc)}\n${doc.body.textContent}` : '';
}

function gmailPdfParts(payload) {
  const out = [];
  (function walk(p) {
    if (!p) return;
    if (p.body && p.body.attachmentId && (p.mimeType === 'application/pdf' || /\.pdf$/i.test(p.filename || ''))) out.push(p);
    (p.parts || []).forEach(walk);
  })(payload);
  return out;
}

async function gmailPdfBytes(msgId, part, token) {
  const att = await gmailFetch(`messages/${msgId}/attachments/${part.body.attachmentId}`, token);
  const bin = atob(att.data.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Text of the first pages of a PDF; '' when it is password-protected or unreadable.
async function gmailPdfText(bytes) {
  try {
    const pdfjs = await loadPdfJs();
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 2); i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      pages.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
    }
    return pages.join('\n');
  } catch (e) {
    return '';
  }
}

// Concatenate the readable text parts of a message (prefer HTML; e-bills put figures in tables).
function gmailMessageText(payload) {
  const html = [], plain = [];
  (function walk(p) {
    if (!p) return;
    const data = p.body && p.body.data;
    if (data && p.mimeType === 'text/html') html.push(gmailHtmlToText(gmailB64(data)));
    else if (data && p.mimeType === 'text/plain') plain.push(gmailB64(data));
    (p.parts || []).forEach(walk);
  })(payload);
  return (html.length ? html : plain).join('\n');
}

async function gmailFetch(path, token) {
  const res = await fetch(`${GMAIL_API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { gmailForgetToken(); throw new Error('สิทธิ์หมดอายุ กรุณาเชื่อมใหม่'); }
  if (!res.ok) throw new Error(`Gmail ตอบกลับ ${res.status}`);
  return res.json();
}


function gmailFromAddr(from) {
  return ((String(from || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+/) || [])[0]) || '';
}

function gmailSendersValid(v) {
  const list = String(v || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  return list.length > 0 && list.every((x) => /^([a-z0-9._%+-]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x));
}

function gmailSenders(rule) { return String(rule.gmail.sender || '').toLowerCase().split(/[\s,]+/).filter(Boolean); }

// How well a sender entry matches an address: 2 = exact address, 1 = domain, 0 = no.
function gmailSenderScore(entry, addr) {
  if (entry.includes('@')) return entry === addr ? 2 : 0;
  const domain = addr.split('@')[1] || '';
  return domain === entry || domain.endsWith('.' + entry) ? 1 : 0;
}

// Bills that are Gmail rules, after upgrading links made by older versions.
function gmailRules() {
  gmailMigrate();
  return state.bills.filter((b) => b.gmail && b.gmail.sender);
}

function gmailMigrate() {
  const st = state.settings;
  let changed = false;
  const custom = Array.isArray(st.gmailSources) ? st.gmailSources : [];
  state.bills.forEach((b) => {
    const g = b.gmail;
    if (!g || g.sender || !g.provider) return;
    const preset = GMAIL_PROVIDERS.find((p) => p.key === g.provider);
    const c = custom.find((x) => 'c:' + x.id === g.provider);
    b.gmail = { sender: preset ? preset.domains.join(' ') : c ? c.sender : '', account: g.account || '', day: Number(st.gmailAutoDay) || 0 };
    changed = true;
  });
  // Senders added in the previous version's list become rules of their own.
  custom.forEach((c) => {
    if (state.bills.some((b) => b.gmail && b.gmail.sender === c.sender)) return;
    state.bills.push({
      id: uid(), name: c.name, category: c.category || 'other', amount: 0, variable: true, autopay: false,
      type: 'monthly', dueDay: 25, startMonth: ymOf(new Date()), note: '',
      gmail: { sender: c.sender, account: '', day: Number(st.gmailAutoDay) || 0 },
    });
    changed = true;
  });
  ['gmailSources', 'gmailSenders', 'gmailCats', 'gmailAutoDay', 'gmailLastAuto'].forEach((k) => {
    if (k in st) { delete st[k]; changed = true; }
  });
  if (changed) save();
}

// The rule an email belongs to: best sender match, then the rule whose account matches,
// then one without an account.
function gmailRuleFor(r, rules) {
  const addr = gmailFromAddr(r.from);
  let best = 0, hits = [];
  rules.forEach((b) => {
    const s = Math.max(0, ...gmailSenders(b).map((e) => gmailSenderScore(e, addr)));
    if (s > best) { best = s; hits = [b]; } else if (s && s === best) hits.push(b);
  });
  if (!hits.length) return null;
  return hits.find((b) => r.account && b.gmail.account === r.account)
    || hits.find((b) => !b.gmail.account)
    || null;
}

function gmailQuery(rules) {
  const senders = [...new Set(rules.flatMap(gmailSenders))];
  return `{${senders.map((d) => `from:${d}`).join(' ')}} newer_than:120d -in:chats`;
}

async function gmailSearch(token, rules) {
  if (!rules.length) return [];
  const list = await gmailFetch(`messages?maxResults=50&q=${encodeURIComponent(gmailQuery(rules))}`, token);
  const ids = (list.messages || []).map((x) => x.id);
  const msgs = await Promise.all(ids.map((id) => gmailFetch(`messages/${id}?format=full`, token)));
  const rows = await Promise.all(msgs.map(async (msg) => {
    const h = {};
    (msg.payload.headers || []).forEach((x) => { h[x.name.toLowerCase()] = x.value; });
    const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : h.date;
    const base = { from: h.from, subject: h.subject, date };
    const info = gmailParseBill({ ...base, text: gmailMessageText(msg.payload) });
    const pdfs = gmailPdfParts(msg.payload);
    const pdf = pdfs[0] ? { name: pdfs[0].filename || 'invoice.pdf', part: pdfs[0], bytes: null } : null;
    // Some senders put the figures only in the attached PDF; read it when the body falls short.
    if (pdf && (info.amount == null || !info.due)) {
      try { pdf.bytes = await gmailPdfBytes(msg.id, pdf.part, token); } catch (e) { /* keep the body's figures */ }
      const fromPdf = gmailParseBill({ ...base, text: pdf.bytes ? await gmailPdfText(pdf.bytes) : '' });
      if (info.amount == null) info.amount = fromPdf.amount;
      if (!info.due && fromPdf.due) { info.due = fromPdf.due; info.ym = fromPdf.ym; }
      if (!info.account) info.account = fromPdf.account;
      info.isBill = info.isBill || fromPdf.isBill;
    }
    const row = { id: msg.id, from: h.from || '', subject: h.subject || '(ไม่มีหัวเรื่อง)', date, hasPdf: !!pdf, pdf, ...info };
    row.rule = gmailRuleFor(row, rules);
    return row;
  }));
  return rows.filter((r) => r.rule && r.isBill);
}

/* ----- Google sign-in (token model, popup) ----- */

function gmailSavedToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(GMAIL_TOKEN_KEY) || 'null');
    return t && t.exp > Date.now() + 60000 ? t.token : null;
  } catch (e) { return null; }
}
function gmailForgetToken() { try { sessionStorage.removeItem(GMAIL_TOKEN_KEY); } catch (e) { /* ignore */ } }

// Load the client id and Google's script ahead of the tap, so the popup opens
// straight from the click (iOS blocks popups that open after an await).
function gmailPrepare() {
  if (gmail.scriptP) return gmail.scriptP;
  gmail.scriptP = fetch('/api/config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((cfg) => {
      gmail.clientId = (cfg && cfg.googleClientId) || '';
      if (!gmail.clientId) return;
      return new Promise((resolve, reject) => {
        if (window.google && google.accounts && google.accounts.oauth2) { resolve(); return; }
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('โหลด Google Sign-In ไม่สำเร็จ'));
        document.head.appendChild(s);
      });
    })
    .catch((err) => { gmail.scriptP = null; throw err; });
  return gmail.scriptP;
}

function gmailToken() {
  const saved = gmailSavedToken();
  if (saved) return Promise.resolve(saved);
  if (!gmail.clientId || !window.google) return Promise.reject(new Error('ยังไม่ได้ตั้งค่า Google Client ID'));
  return new Promise((resolve, reject) => {
    gmail.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: gmail.clientId,
      scope: GMAIL_SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) { reject(new Error(r.error_description || r.error || 'ไม่ได้รับสิทธิ์')); return; }
        try { sessionStorage.setItem(GMAIL_TOKEN_KEY, JSON.stringify({ token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 })); } catch (e) { /* ignore */ }
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'ปิดหน้าต่างก่อนอนุญาต' : 'เปิดหน้าต่าง Google ไม่ได้')),
    });
    gmail.tokenClient.requestAccessToken({ prompt: '' });
  });
}

/* ----- Importing into rule bills ----- */

function gmailImported(r) {
  return Object.values(state.records).some((m) => Object.values(m).some((rec) => rec.gmail === r.id));
}

function gmailShortAccount(a) { return a && a.length >= 4 ? `…${a.slice(-4)}` : a; }

// Rule options shared by the bill form and the bill detail sheet. `day` is the monthly fetch
// day (0 = only when the user taps fetch); `payDays` sets the due date that many days after
// the bill is fetched instead of the date printed in the email.
function gmailDayOptions(day) {
  const cur = Number(day) || 0;
  return `<option value="0" ${!cur ? 'selected' : ''}>ไม่ดึงเอง</option>`
    + Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${cur === d ? 'selected' : ''}>วันที่ ${d}</option>`).join('');
}

function gmailPayOptions(n) {
  const cur = Number(n) || 0;
  return `<option value="0" ${!cur ? 'selected' : ''}>ตามวันครบกำหนดในอีเมล</option>`
    + Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${cur === d ? 'selected' : ''}>ภายใน ${d} วันหลังดึง</option>`).join('');
}

function gmailFetchDay(g, ym) { return g.day ? Math.min(Number(g.day), daysInMonth(ym)) : 0; }

// Due date for an email under a "pay within N days" rule: N days after the bill was fetched,
// i.e. after the later of the rule's fetch day and the day the email arrived.
function gmailPayDue(g, r) {
  const got = r.date ? new Date(r.date) : new Date();
  got.setHours(0, 0, 0, 0);
  const ym = ymOf(got);
  const fd = gmailFetchDay(g, ym);
  const base = fd && fd > got.getDate() ? new Date(got.getFullYear(), got.getMonth(), fd) : got;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + Number(g.payDays));
}

// Put the email's amount on its rule's bill for that month; the newest email sets the due day.
function gmailImport(r) {
  const b = r.rule;
  if (b.gmail.payDays) {
    const due = gmailPayDue(b.gmail, r);
    r.ym = ymOf(due);
    r.due = dateStr(due);
  }
  const ym = r.ym || ymOf(new Date());
  if (b.startMonth && ym < b.startMonth) b.startMonth = ym;
  if (r.due && (!b.gmail.dueYm || ym >= b.gmail.dueYm)) { b.dueDay = Number(r.due.slice(8, 10)); b.gmail.dueYm = ym; }
  const prev = record(ym, b.id);
  setRecord(ym, b.id, { amount: r.amount != null ? r.amount : prev.amount, gmail: r.id });
  const tx = billTxn(b.id, ym);
  if (tx && prev.paid && r.amount != null) tx.amount = r.amount;
  return { bill: b, ym };
}

// Keep the email's PDF invoice with the bill's month (fetched now if the scan didn't need it).
async function gmailAttachPdf(r, billId, ym) {
  if (!r.pdf) return false;
  try {
    if (!r.pdf.bytes) r.pdf.bytes = await gmailPdfBytes(r.id, r.pdf.part, await gmailToken());
    await billFilePut(billId, ym, new Blob([r.pdf.bytes], { type: 'application/pdf' }), r.pdf.name);
    save();
    return true;
  } catch (e) {
    return false;
  }
}

/* ----- UI ----- */

function gmailRow(r, i) {
  const b = r.rule;
  const done = gmailImported(r);
  const dueTxt = r.due ? `ครบกำหนด ${thShortDate(new Date(r.due + 'T00:00'))} ${Number(r.due.slice(0, 4)) + BE}` : 'ไม่พบวันครบกำหนด';
  const meta = [b.name, r.account ? gmailShortAccount(r.account) : '', r.ym ? thMonthYear(r.ym) : ''].filter(Boolean).join(' · ');
  const action = done ? '<span class="badge ok">นำเข้าแล้ว</span>'
    : `<button class="btn small pillbtn" data-gmail-import="${i}">นำเข้า</button>`;
  return `
    <div class="item gmail-item">
      ${icoHtml(b)}
      <div class="main">
        <div class="name">${esc(r.subject)}</div>
        <div class="sub">${esc(meta)}</div>
        <div class="sub">${dueTxt}</div>
        ${r.pdf ? `<div class="sub">📎 ${esc(r.pdf.name)} (เก็บไว้กับบิล)</div>` : ''}
        ${r.amount == null ? `<div class="sub warn-txt">ไม่พบยอดในเนื้ออีเมล${r.hasPdf ? ' (PDF แนบอาจล็อกรหัสไว้)' : ''} กรอกยอดเองหลังนำเข้า</div>` : ''}
      </div>
      <div class="right"><div class="amt">${r.amount != null ? baht(r.amount) : '-'}</div>${action}</div>
    </div>`;
}

function gmailRenderResults() {
  const box = $('#gmailResults');
  if (!box) return;
  const rows = gmail.results;
  if (!rows) { box.innerHTML = ''; return; }
  if (!rows.length) {
    box.innerHTML = '<p class="hint">ไม่พบอีเมลบิลจากผู้ส่งในกฎใน 4 เดือนที่ผ่านมา ตรวจอีเมลผู้ส่งในกฎอีกครั้ง หรือดูว่าอีเมลเข้าบัญชี Google ที่ล็อกอินอยู่</p>';
    return;
  }
  const pending = rows.filter((r) => !gmailImported(r));
  box.innerHTML = `
    <div class="section-title">พบ ${rows.length} ฉบับ</div>
    <div class="list">${rows.map(gmailRow).join('')}</div>
    ${pending.length > 1 ? `<button class="btn" id="gmailAll">นำเข้าทั้งหมด (${pending.length})</button>` : ''}`;
  const all = $('#gmailAll');
  if (all) all.addEventListener('click', () => {
    const n = gmailImportAll(pending);
    gmailRenderResults();
    toast(`นำเข้า ${n} บิลแล้ว`);
  });
}

// Oldest first, so the newest email ends up setting each bill's due day.
function gmailImportAll(rows) {
  const done = rows.slice().sort((a, b) => String(a.ym).localeCompare(String(b.ym))).map((r) => [r, gmailImport(r)]);
  save(); saveMoney(); render();
  Promise.all(done.map(([r, d]) => gmailAttachPdf(r, d.bill.id, d.ym))).then(() => render());
  return done.length;
}

async function gmailScan(btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'กำลังเชื่อม Google…';
  try {
    const token = await gmailToken();
    btn.textContent = 'กำลังค้นหาอีเมลบิล…';
    gmail.results = (await gmailSearch(token, gmailRules())).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    gmailRenderResults();
  } catch (err) {
    const box = $('#gmailResults');
    if (box) box.innerHTML = `<p class="hint pea-err">ดึงไม่สำเร็จ: ${esc(err.message || 'ลองใหม่อีกครั้ง')}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/* ----- Monthly pull per rule ----- */

// Google only hands the browser a token from a tap (or reuses one for an hour), so each
// rule's monthly pull happens on the first app open on/after its day: silently while a
// token is still valid, otherwise as a one-tap "sync now" alert.
function gmailDueRules() {
  if (typeof state === 'undefined') return [];
  const now = new Date();
  const ym = ymOf(now);
  return gmailRules().filter((b) => gmailFetchDay(b.gmail, ym) && now.getDate() >= gmailFetchDay(b.gmail, ym) && b.gmail.last !== ym);
}

function gmailAutoDue() { return gmailDueRules().length > 0; }

function gmailAutoAlert() {
  const due = gmailDueRules();
  return `<button class="alert warn gmail-auto" data-action="gmail-auto">📧<div>ถึงรอบดึงบิลจาก Gmail: ${due.map((b) => esc(b.name)).join(', ')} แตะเพื่อดึงบิลเดือนนี้</div></button>`;
}

// Pull and import new emails for the given rules without review.
async function gmailRunRules(rules, quiet) {
  if (gmail.autoBusy || !rules.length) return;
  gmail.autoBusy = true;
  try {
    await gmailPrepare();
    const token = await gmailToken();
    const rows = await gmailSearch(token, rules);
    const n = gmailImportAll(rows.filter((r) => !gmailImported(r)));
    const ym = ymOf(new Date());
    rules.forEach((b) => { b.gmail.last = ym; });
    save(); render();
    if (!quiet || n) toast(n ? `Gmail AutoSync: นำเข้า ${n} บิล` : 'Gmail AutoSync: ยังไม่มีบิลใหม่');
  } catch (err) {
    if (!quiet) toast('Gmail AutoSync ไม่สำเร็จ: ' + (err.message || 'ลองใหม่'));
  } finally {
    gmail.autoBusy = false;
  }
}

function gmailAutoRun(quiet) { return gmailRunRules(gmailDueRules(), quiet); }

// On open/return: pull silently for due rules if a token is still valid.
function gmailAutoTry() {
  if (gmailAutoDue() && gmailSavedToken()) gmailAutoRun(true);
}

function gmailRuleItem(b) {
  const g = b.gmail;
  const sub = [gmailSenders(b).join(', '), g.account ? gmailShortAccount(g.account) : '', g.day ? `ดึงทุกวันที่ ${g.day}` : 'ดึงเองเท่านั้น'].filter(Boolean).join(' · ');
  return `<button class="item" data-edit="${b.id}">${icoHtml(b)}<div class="main"><div class="name">${esc(b.name)}</div><div class="sub">${esc(sub)}</div>
    ${g.last ? `<div class="sub">ดึงล่าสุด ${thMonthYear(g.last)}</div>` : ''}</div><div class="right"><span class="badge muted">${cat(b).label}</span></div></button>`;
}

function gmailSheet() {
  const rules = gmailRules();
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>Gmail AutoSync</h2>
      <span style="width:44px"></span>
    </div>
    <div id="gmailSetup"></div>
    <p class="hint">สร้างกฎดึงบิลได้ทุกประเภท: ตั้งชื่อบิล อีเมลผู้ส่ง วันที่ดึงทุกเดือน และหมวดหมู่ แอปจะหาอีเมลบิลจากผู้ส่งนั้น แล้วเติมยอดกับวันครบกำหนดเข้าบิลให้</p>
    <div class="section-title">กฎดึงบิล</div>
    <div class="list">
      ${rules.map(gmailRuleItem).join('')}
      <button class="item add-row" data-action="gmail-rule"><span class="plus">＋</span><div class="main"><div class="name">เพิ่มกฎดึงบิล</div></div></button>
    </div>
    ${rules.length ? '<button class="btn" id="gmailScan" type="button">🔄 ดึงบิลทุกกฎตอนนี้</button>' : ''}
    <p class="hint">อ่าน Gmail แบบอ่านอย่างเดียว เฉพาะอีเมลจากผู้ส่งในกฎ ย้อนหลัง 4 เดือน จากเครื่องนี้โดยตรง ไม่ส่งอีเมลไปเก็บที่เซิร์ฟเวอร์</p>
    <div id="gmailResults"></div>
    ${gmailSavedToken() ? '<button class="btn ghost" id="gmailOut" type="button">ตัดการเชื่อม Gmail</button>' : ''}
  `);
  gmailRenderResults();

  const scan = $('#gmailScan');
  if (scan) scan.disabled = true;
  gmailPrepare().then(() => {
    if (scan) scan.disabled = !gmail.clientId;
    if (!gmail.clientId) $('#gmailSetup').innerHTML = '<div class="alert warn">⚙️<div>ยังไม่ได้ตั้งค่า Google OAuth Client ID ที่เซิร์ฟเวอร์ (ตัวแปร GOOGLE_CLIENT_ID)</div></div>';
  }, (err) => {
    $('#gmailSetup').innerHTML = `<div class="alert bad">⚠️<div>${esc(err.message)}</div></div>`;
  });
  if (scan) scan.addEventListener('click', () => gmailScan(scan));

  $('#gmailResults').addEventListener('click', (e) => {
    const t = e.target.closest('[data-gmail-import]');
    if (!t) return;
    const r = gmail.results[Number(t.dataset.gmailImport)];
    const { bill: b, ym } = gmailImport(r);
    save(); saveMoney(); render(); gmailRenderResults();
    toast(r.amount != null ? `${b.name}: ${baht(r.amount)}` : `นำเข้า ${b.name} แล้ว กรอกยอดในบิล`);
    gmailAttachPdf(r, b.id, ym).then((ok) => ok && render());
  });
  const out = $('#gmailOut');
  if (out) out.addEventListener('click', () => {
    const t = gmailSavedToken();
    if (t && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(t, () => {});
    gmailForgetToken();
    gmail.results = null;
    gmailSheet();
    toast('ตัดการเชื่อมแล้ว');
  });
}

if (typeof document !== 'undefined') {
  setTimeout(gmailAutoTry, 1500);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') gmailAutoTry(); });
}

if (typeof module !== 'undefined') module.exports = { gmailParseBill, gmailParseDate, gmailSenderScore };
