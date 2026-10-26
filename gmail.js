'use strict';

/* ---------- Phone/internet e-bills from Gmail ----------
 * The browser talks to Gmail directly with a short-lived, read-only access token
 * from Google Identity Services. Nothing is sent to our server; the OAuth client
 * id comes from /api/config (Railway variable GOOGLE_CLIENT_ID via the Caddyfile).
 */

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_TOKEN_KEY = 'centel.gmail.token';

// Sender domains of Thai telcos/ISPs. `category` is the default bill category.
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

function gmailProvider(from) {
  const f = String(from || '').toLowerCase();
  const domain = (f.match(/@([a-z0-9.-]+)/) || [])[1] || '';
  return GMAIL_PROVIDERS.find((p) => p.domains.some((d) => domain === d || domain.endsWith('.' + d))) || null;
}

// Pull amount, due date and account number out of an e-bill's subject + text.
function gmailParseBill({ from, subject, text, date }) {
  const body = `${subject || ''}\n${text || ''}`.replace(/[ ​]/g, ' ');
  const flat = body.replace(/\s+/g, ' ');
  const provider = gmailProvider(from);

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
  return { provider, amount, due, account, ym, isBill: amount != null || BILL_WORDS.test(subject || '') };
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

function gmailQuery() {
  const domains = GMAIL_PROVIDERS.flatMap((p) => p.domains);
  const extra = (state.settings.gmailSenders || '').split(/[\s,]+/).filter(Boolean);
  return `{${[...domains, ...extra].map((d) => `from:${d}`).join(' ')}} newer_than:120d -in:chats`;
}

async function gmailSearch(token) {
  const list = await gmailFetch(`messages?maxResults=25&q=${encodeURIComponent(gmailQuery())}`, token);
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
    // Some providers put the figures only in the attached PDF; read it when the body falls short.
    if (pdf && (info.amount == null || !info.due)) {
      try { pdf.bytes = await gmailPdfBytes(msg.id, pdf.part, token); } catch (e) { /* keep the body's figures */ }
      const fromPdf = gmailParseBill({ ...base, text: pdf.bytes ? await gmailPdfText(pdf.bytes) : '' });
      if (info.amount == null) info.amount = fromPdf.amount;
      if (!info.due && fromPdf.due) { info.due = fromPdf.due; info.ym = fromPdf.ym; }
      if (!info.account) info.account = fromPdf.account;
      info.isBill = info.isBill || fromPdf.isBill;
    }
    return { id: msg.id, from: h.from || '', subject: h.subject || '(ไม่มีหัวเรื่อง)', date, hasPdf: !!pdf, pdf, ...info };
  }));
  return rows.filter((r) => r.isBill);
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

/* ----- Matching to bills ----- */

function gmailBillFor(r) {
  if (!r.provider) return null;
  const linked = state.bills.filter((b) => b.gmail && b.gmail.provider === r.provider.key);
  return linked.find((b) => r.account && b.gmail.account === r.account)
    || linked.find((b) => !b.gmail.account || !r.account)
    || null;
}

function gmailImported(r) {
  return Object.values(state.records).some((m) => Object.values(m).some((rec) => rec.gmail === r.id));
}

function gmailShortAccount(a) { return a && a.length >= 4 ? `…${a.slice(-4)}` : a; }

// Add the email's amount to its bill for that month, creating the bill when needed.
function gmailImport(r) {
  let b = gmailBillFor(r);
  const ym = r.ym || ymOf(new Date());
  if (!b) {
    const p = r.provider || { key: 'other', name: 'บิลอีเมล', category: 'phone' };
    b = {
      id: uid(),
      name: `${p.name}${r.account ? ' ' + gmailShortAccount(r.account) : ''}`,
      category: p.category,
      amount: r.amount || 0,
      variable: true,
      autopay: false,
      type: 'monthly',
      dueDay: r.due ? Number(r.due.slice(8, 10)) : 25,
      startMonth: ym,
      note: r.account ? `หมายเลข ${r.account}` : '',
      gmail: { provider: p.key, account: r.account || '' },
    };
    state.bills.push(b);
  } else if (b.startMonth && ym < b.startMonth) {
    b.startMonth = ym;
  }
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
  const b = gmailBillFor(r);
  const done = gmailImported(r);
  const icon = (CATEGORIES[(r.provider && r.provider.category) || 'phone'] || CATEGORIES.phone).icon;
  const dueTxt = r.due ? `ครบกำหนด ${thShortDate(new Date(r.due + 'T00:00'))} ${Number(r.due.slice(0, 4)) + 543}` : 'ไม่พบวันครบกำหนด';
  const meta = [r.provider ? r.provider.name : '', r.account ? gmailShortAccount(r.account) : '', r.ym ? thMonthYear(r.ym) : ''].filter(Boolean).join(' · ');
  const action = done ? '<span class="badge ok">นำเข้าแล้ว</span>'
    : `<button class="btn small pillbtn" data-gmail-import="${i}">${b ? 'เติมยอด' : 'เพิ่มบิล'}</button>`;
  return `
    <div class="item gmail-item">
      <div class="ico" style="background:#4f6bed22">${icon}</div>
      <div class="main">
        <div class="name">${esc(r.subject)}</div>
        <div class="sub">${esc(meta)}</div>
        <div class="sub">${dueTxt}${b ? ` · บิล "${esc(b.name)}"` : ''}</div>
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
    box.innerHTML = '<p class="hint">ไม่พบอีเมลใบแจ้งค่าบริการจาก AIS, True, dtac, 3BB หรือ NT ใน 4 เดือนที่ผ่านมา ถ้าผู้ให้บริการส่งจากอีเมลอื่น เพิ่มโดเมนผู้ส่งด้านล่าง</p>';
    return;
  }
  const pending = rows.filter((r) => !gmailImported(r));
  box.innerHTML = `
    <div class="section-title">พบ ${rows.length} ฉบับ</div>
    <div class="list">${rows.map(gmailRow).join('')}</div>
    ${pending.length > 1 ? `<button class="btn" id="gmailAll">นำเข้าทั้งหมด (${pending.length})</button>` : ''}`;
  const all = $('#gmailAll');
  if (all) all.addEventListener('click', () => {
    // Oldest first, so a new bill's start month and due day come from its earliest email.
    const done = pending.slice().sort((a, b) => String(a.ym).localeCompare(String(b.ym))).map((r) => [r, gmailImport(r)]);
    save(); saveMoney(); render(); gmailRenderResults();
    toast(`นำเข้า ${pending.length} บิลแล้ว`);
    Promise.all(done.map(([r, d]) => gmailAttachPdf(r, d.bill.id, d.ym))).then(() => render());
  });
}

async function gmailScan(btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'กำลังเชื่อม Google…';
  try {
    const token = await gmailToken();
    btn.textContent = 'กำลังค้นหาอีเมลบิล…';
    gmail.results = (await gmailSearch(token)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    gmailRenderResults();
  } catch (err) {
    const box = $('#gmailResults');
    if (box) box.innerHTML = `<p class="hint pea-err">ดึงไม่สำเร็จ: ${esc(err.message || 'ลองใหม่อีกครั้ง')}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

function gmailSheet() {
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-action="close">ปิด</button>
      <h2>บิลจาก Gmail</h2>
      <span style="width:44px"></span>
    </div>
    <div id="gmailSetup"></div>
    <button class="btn" id="gmailScan" type="button">📧 ค้นหาบิลค่าโทรศัพท์ใน Gmail</button>
    <p class="hint">อ่านอีเมลแบบอ่านอย่างเดียว เฉพาะจาก AIS, True, dtac, 3BB, NT ย้อนหลัง 4 เดือน แอปอ่าน Gmail จากเครื่องนี้โดยตรง ไม่ส่งอีเมลไปเก็บที่เซิร์ฟเวอร์</p>
    <div id="gmailResults"></div>
    <div class="section-title">ผู้ส่งเพิ่มเติม</div>
    <div class="form">
      <div class="field"><label for="gmailSenders">โดเมน/อีเมล</label><input id="gmailSenders" placeholder="เช่น ebill@provider.co.th" value="${esc(state.settings.gmailSenders || '')}" autocomplete="off" autocapitalize="off"></div>
    </div>
    <p class="hint">คั่นหลายรายการด้วยเว้นวรรค ใช้เมื่อผู้ให้บริการส่งใบแจ้งค่าบริการจากอีเมลที่แอปยังไม่รู้จัก</p>
    ${gmailSavedToken() ? '<button class="btn ghost" id="gmailOut" type="button">ตัดการเชื่อม Gmail</button>' : ''}
  `);
  gmailRenderResults();

  const scan = $('#gmailScan');
  scan.disabled = true;
  gmailPrepare().then(() => {
    scan.disabled = false;
    if (!gmail.clientId) {
      scan.disabled = true;
      $('#gmailSetup').innerHTML = '<div class="alert warn">⚙️<div>ยังไม่ได้ตั้งค่า Google OAuth Client ID ที่เซิร์ฟเวอร์ (ตัวแปร GOOGLE_CLIENT_ID)</div></div>';
    }
  }, (err) => {
    $('#gmailSetup').innerHTML = `<div class="alert bad">⚠️<div>${esc(err.message)}</div></div>`;
  });
  scan.addEventListener('click', () => gmailScan(scan));

  $('#gmailSenders').addEventListener('change', (e) => {
    state.settings.gmailSenders = e.target.value.trim();
    save();
    toast('บันทึกแล้ว');
  });
  $('#gmailResults').addEventListener('click', (e) => {
    const t = e.target.closest('[data-gmail-import]');
    if (!t) return;
    const r = gmail.results[Number(t.dataset.gmailImport)];
    const { bill: b, ym } = gmailImport(r);
    save(); saveMoney(); render(); gmailRenderResults();
    toast(r.amount != null ? `${b.name}: ${baht(r.amount)}` : `เพิ่ม ${b.name} แล้ว กรอกยอดในบิล`);
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

if (typeof module !== 'undefined') module.exports = { gmailParseBill, gmailParseDate, gmailProvider };
