// Shared by the accounting app (app.js) and the public document page (doc.html):
// Thai formatting, document totals (same rules as server/src/acc/ledger.js) and the
// printable A4 layouts for sales documents (the 50 ทวิ certificate is in wht50.js, on the official form).
(function (g) {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (v) => nf.format(Math.round((Number(v) || 0) * 100) / 100);
  const qtyFmt = (v) => {
    const n = Number(v) || 0;
    return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  };
  const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const TH_MONTHS_LONG = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  // 2026-11-09 → 9 พ.ย. 2569
  const thDate = (d) => {
    if (!d) return '';
    const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
    return `${day} ${TH_MONTHS[m - 1]} ${y + 543}`;
  };
  // 2026-11-09 → 09/11/2569 (as printed on documents)
  const slashDate = (d) => {
    if (!d) return '';
    const [y, m, day] = String(d).slice(0, 10).split('-');
    return `${day}/${m}/${Number(y) + 543}`;
  };
  const thMonth = (ym) => {
    const [y, m] = String(ym).split('-').map(Number);
    return `${TH_MONTHS_LONG[m - 1]} ${y + 543}`;
  };
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const taxIdFmt = (t) => {
    const s = String(t || '').replace(/\D/g, '');
    return s.length === 13 ? `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}` : s;
  };
  const branchFmt = (b) => (!b ? '' : b === '00000' || b === 'สำนักงานใหญ่' ? 'สำนักงานใหญ่' : `สาขา ${b}`);

  // Thai words for an amount in baht: 1234.5 → หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์
  const DIG = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const POS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
  function words(n, higher = false) {
    // n: non-negative integer as string
    if (n.length > 6) return words(n.slice(0, -6)) + 'ล้าน' + (Number(n.slice(-6)) ? words(n.slice(-6), true) : '');
    let out = '';
    const len = n.length;
    for (let i = 0; i < len; i++) {
      const d = Number(n[i]);
      const p = len - i - 1;
      if (!d) continue;
      if (p === 0 && d === 1 && (higher || (len > 1 && Number(n.slice(0, -1))))) out += 'เอ็ด';
      else if (p === 1 && d === 2) out += 'ยี่';
      else if (p === 1 && d === 1) out += '';
      else out += DIG[d];
      out += POS[p];
    }
    return out;
  }
  function bahtText(v) {
    const c = Math.round(Math.abs(Number(v) || 0) * 100);
    const b = String(Math.floor(c / 100));
    const s = c % 100;
    if (!c) return 'ศูนย์บาทถ้วน';
    let out = Number(b) ? words(b) + 'บาท' : '';
    out += s ? words(String(s)) + 'สตางค์' : 'ถ้วน';
    return (Number(v) < 0 ? 'ลบ' : '') + out;
  }

  /* ---------- Totals (mirror of server/src/acc/ledger.js) ---------- */

  const WHT_RATES = [0, 1, 1.5, 2, 3, 5, 10, 15];
  const cents = (v) => Math.round((Number(v) || 0) * 100);
  const baht = (c) => Math.round(c) / 100;
  function allocate(total, weights) {
    const sum = weights.reduce((s, w) => s + w, 0);
    if (!sum || !total) return weights.map(() => 0);
    const raw = weights.map((w) => (total * w) / sum);
    const out = raw.map((x) => Math.trunc(x));
    let left = total - out.reduce((s, x) => s + x, 0);
    const order = raw.map((x, i) => [Math.abs(x - Math.trunc(x)), i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; left !== 0 && order.length; k = (k + 1) % order.length) {
      const step = Math.sign(left);
      out[order[k][1]] += step;
      left -= step;
    }
    return out;
  }
  function computeTotals(lines, { discount = 0, priceMode = 'excl', vatRate = 0 } = {}) {
    const ls = lines.map((l) => ({ qty: Number(l.qty) || 0, price: Number(l.price) || 0, disc: Math.max(0, Number(l.disc) || 0), vat: l.vat !== false, wht: WHT_RATES.includes(Number(l.wht)) ? Number(l.wht) : 0 }));
    const gross = ls.map((l) => Math.round(l.qty * cents(l.price)) - cents(l.disc));
    const subtotal = gross.reduce((s, x) => s + x, 0);
    const disc = Math.max(0, Math.min(cents(discount), subtotal));
    const shares = allocate(disc, gross.map((x) => Math.max(x, 0)));
    const net = gross.map((x, i) => x - shares[i]);
    const rate = Number(vatRate) || 0;
    const vatIdx = ls.map((l, i) => (l.vat && rate > 0 ? i : -1)).filter((i) => i >= 0);
    const V = vatIdx.reduce((s, i) => s + net[i], 0);
    const N = net.reduce((s, x) => s + x, 0) - V;
    const base = net.slice();
    let vat;
    if (priceMode === 'incl') {
      vat = Math.round((V * rate) / (100 + rate));
      const parts = allocate(V - vat, vatIdx.map((i) => net[i]));
      vatIdx.forEach((i, k) => { base[i] = parts[k]; });
    } else vat = Math.round((V * rate) / 100);
    const total = priceMode === 'incl' ? V + N : V + N + vat;
    const wht = ls.reduce((s, l, i) => s + Math.round((base[i] * l.wht) / 100), 0);
    return {
      amounts: gross.map(baht), bases: base.map(baht), subtotal: baht(subtotal), discount: baht(disc),
      vat_base: baht(V - (priceMode === 'incl' ? vat : 0)), exempt: baht(N), vat: baht(vat), total: baht(total), wht: baht(wht),
    };
  }

  /* ---------- Document names ---------- */

  function docTitle(d) {
    switch (d.type) {
      case 'QT': return ['ใบเสนอราคา', 'Quotation'];
      case 'IV': return d.tax_invoice ? ['ใบแจ้งหนี้ / ใบกำกับภาษี', 'Invoice / Tax Invoice'] : ['ใบแจ้งหนี้ / ใบวางบิล', 'Invoice / Billing Note'];
      case 'RE': return d.tax_invoice ? ['ใบเสร็จรับเงิน / ใบกำกับภาษี', 'Receipt / Tax Invoice'] : ['ใบเสร็จรับเงิน', 'Receipt'];
      case 'EX': return ['ใบสำคัญจ่าย', 'Payment Voucher'];
      default: return ['เอกสาร', 'Document'];
    }
  }
  const TYPE_NAME = { QT: 'ใบเสนอราคา', IV: 'ใบแจ้งหนี้', RE: 'ใบเสร็จรับเงิน', EX: 'ค่าใช้จ่าย', JV: 'สมุดรายวันทั่วไป' };
  const STATUS = {
    QT: { open: 'รอตอบรับ', accepted: 'ตอบรับแล้ว', rejected: 'ไม่อนุมัติ', void: 'ยกเลิก' },
    IV: { open: 'รอรับชำระ', paid: 'ชำระแล้ว', void: 'ยกเลิก' },
    RE: { done: 'รับเงินแล้ว', void: 'ยกเลิก' },
    EX: { open: 'รอจ่าย', paid: 'จ่ายแล้ว', void: 'ยกเลิก' },
  };
  const statusName = (type, s) => (STATUS[type] && STATUS[type][s]) || s;
  const ACCT_TYPE = { th: { savings: 'ออมทรัพย์', current: 'กระแสรายวัน', fixed: 'ฝากประจำ' }, en: { savings: 'Savings', current: 'Current', fixed: 'Fixed deposit' } };
  const PAY_METHOD = { cash: 'เงินสด', transfer: 'โอนเงิน', cheque: 'เช็ค', card: 'บัตร', other: 'อื่น ๆ' };

  /* ---------- Printable document ---------- */

  // English amount in words for documents printed in English: 1234.5 → One Thousand Two Hundred Thirty-Four Baht and Fifty Satang
  const EN1 = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const EN10 = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function enWords(n) {
    if (n < 20) return EN1[n];
    if (n < 100) return EN10[Math.floor(n / 10)] + (n % 10 ? `-${EN1[n % 10]}` : '');
    if (n < 1000) return `${EN1[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${enWords(n % 100)}` : ''}`;
    for (const [v, w] of [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']]) {
      if (n >= v) return `${enWords(Math.floor(n / v))} ${w}${n % v ? ` ${enWords(n % v)}` : ''}`;
    }
    return '';
  }
  function bahtTextEn(v) {
    const c = Math.round(Math.abs(Number(v) || 0) * 100);
    const b = Math.floor(c / 100);
    const s = c % 100;
    if (!c) return 'Zero Baht Only';
    return `${Number(v) < 0 ? 'Minus ' : ''}${b ? `${enWords(b)} Baht` : ''}${s ? `${b ? ' and ' : ''}${enWords(s)} Satang` : ' Only'}`;
  }

  const L = {
    th: {
      no: 'เลขที่', date: 'วันที่', due: 'ครบกำหนด', valid: 'ยืนราคาถึง', ref: 'อ้างอิง', billNo: 'เลขที่บิลผู้ขาย',
      customer: 'ลูกค้า', payee: 'ผู้รับเงิน / ผู้ขาย', taxId: 'เลขประจำตัวผู้เสียภาษี',
      item: 'รายการ', qty: 'จำนวน', price: 'ราคาต่อหน่วย', disc: 'ส่วนลด', amount: 'จำนวนเงิน',
      subtotal: 'รวมเป็นเงิน', base: 'มูลค่าก่อนภาษี', exempt: 'มูลค่ายกเว้นภาษี', vat: 'ภาษีมูลค่าเพิ่ม', grand: 'จำนวนเงินรวมทั้งสิ้น',
      whtCust: 'ภาษีหัก ณ ที่จ่าย (ลูกค้าหัก)', whtOwn: 'หักภาษี ณ ที่จ่าย', net: 'ยอดชำระสุทธิ', netPaid: 'ยอดจ่ายสุทธิ',
      words: 'จำนวนเงิน (ตัวอักษร)', notes: 'หมายเหตุ', payTo: 'ช่องทางชำระเงิน', promptpay: 'พร้อมเพย์', branch: 'สาขา',
      scan: 'สแกนจ่ายด้วยแอปธนาคาร', baht: 'บาท', original: 'ต้นฉบับ', copy: 'สำเนา', void: 'ยกเลิก', on: 'ในนาม',
      paidBy: (m, d) => `ชำระโดย${m} เมื่อ ${d}`,
      payDone: 'การชำระเงินจะสมบูรณ์เมื่อบริษัทได้รับเงินเรียบร้อยแล้ว', bank: 'ธนาคาร',
      pm: { cash: 'เงินสด', cheque: 'เช็ค', transfer: 'โอนเงิน', card: 'บัตรเครดิต' },
      roles: { QT: ['ผู้อนุมัติสั่งซื้อ', 'ผู้เสนอราคา'], IV: ['ผู้รับวางบิล', 'ผู้วางบิล'], RE: ['ผู้จ่ายเงิน', 'ผู้รับเงิน'], EX: ['ผู้รับเงิน', 'ผู้อนุมัติ'] },
    },
    en: {
      no: 'No.', date: 'Date', due: 'Due date', valid: 'Valid until', ref: 'Reference', billNo: 'Vendor bill no.',
      customer: 'Customer', payee: 'Payee / Vendor', taxId: 'Tax ID',
      item: 'Description', qty: 'Qty', price: 'Unit price', disc: 'Discount', amount: 'Amount',
      subtotal: 'Subtotal', base: 'Amount before VAT', exempt: 'VAT-exempt amount', vat: 'VAT', grand: 'Grand total',
      whtCust: 'Withholding tax (by customer)', whtOwn: 'Withholding tax', net: 'Net amount due', netPaid: 'Net paid',
      words: 'Amount in words', notes: 'Notes', payTo: 'Payment details', promptpay: 'PromptPay', branch: 'Branch',
      scan: 'Scan with any Thai banking app', baht: 'THB', original: 'Original', copy: 'Copy', void: 'VOID', on: 'For',
      paidBy: (m, d) => `Paid by ${m} on ${d}`,
      payDone: 'Payment is complete once the company has received the funds.', bank: 'Bank',
      pm: { cash: 'Cash', cheque: 'Cheque', transfer: 'Transfer', card: 'Credit card' },
      roles: { QT: ['Accepted by', 'Quoted by'], IV: ['Received by', 'Issued by'], RE: ['Paid by', 'Received by'], EX: ['Received by', 'Approved by'] },
    },
  };
  const PAY_METHOD_EN = { cash: 'cash', transfer: 'bank transfer', cheque: 'cheque', card: 'card', other: 'other' };
  const enDate = (d) => { if (!d) return ''; const [y, m, day] = String(d).slice(0, 10).split('-'); return `${day}/${m}/${y}`; };
  const branchText = (b, lang) => (lang !== 'en' ? branchFmt(b) : !b ? '' : b === '00000' || b === 'สำนักงานใหญ่' ? 'Head office' : `Branch ${b}`);
  // A light tint of the document colour, for the table header and the amount due.
  function tint(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0xE8590C;
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function partyBlock(label, p, t, lang) {
    if (!p) return '';
    return `<div class="pp-party"><div class="pp-label">${esc(label)}</div>
      <div class="pp-name">${esc(p.name)}</div>
      ${p.address ? `<div class="pp-addr">${esc(p.address).replace(/\n/g, '<br>')}</div>` : ''}
      ${p.tax_id ? `<div class="pp-small">${t.taxId} ${esc(taxIdFmt(p.tax_id))}${p.branch ? ` · ${esc(branchText(p.branch, lang))}` : ''}</div>` : ''}
      ${p.phone || p.email ? `<div class="pp-small">${esc([p.phone, p.email].filter(Boolean).join(' · '))}</div>` : ''}</div>`;
  }

  // doc: a stored document (or the public shape); business: the business row.
  // opts: copy ('ต้นฉบับ' | 'สำเนา' | 'original' | 'copy'), lang ('th' | 'en'), pay (show payment details, default on),
  //       sign (put the saved signature and stamp on the issuer's line), page (number in the corner).
  function renderDoc(doc, business, opts = {}) {
    if (doc.type === 'EX') return renderVoucher(doc, business, opts);
    const s = business.settings || {};
    const lang = opts.lang || s.lang || 'th';
    const t = L[lang] || L.th;
    const fmtDate = lang === 'en' ? enDate : slashDate;
    const [th, en] = docTitle(doc);
    const color = s.color || '#E8590C';
    const lines = doc.lines || [];
    const showDisc = lines.some((l) => Number(l.disc) > 0);
    const copyKey = opts.copy === 'สำเนา' || opts.copy === 'copy' ? 'copy' : 'original';
    const meta = [
      [t.no, doc.number],
      [t.date, fmtDate(doc.date)],
      doc.due_date ? [doc.type === 'QT' ? t.valid : t.due, fmtDate(doc.due_date)] : null,
      doc.ref ? [t.ref, doc.ref.number] : null,
      doc.type === 'EX' && doc.ref_no ? [t.billNo, doc.ref_no] : null,
    ].filter(Boolean);
    const rows = lines.map((l, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td><div class="pp-item">${esc(l.name)}</div>${l.desc ? `<div class="pp-desc">${esc(l.desc).replace(/\n/g, '<br>')}</div>` : ''}</td>
      <td class="r">${qtyFmt(l.qty)}${l.unit ? ` <span class="pp-unit">${esc(l.unit)}</span>` : ''}</td>
      <td class="r">${money(l.price)}</td>
      ${showDisc ? `<td class="r">${Number(l.disc) ? money(l.disc) : ''}</td>` : ''}
      <td class="r">${money(l.amount ?? (Number(l.qty) * Number(l.price) - (Number(l.disc) || 0)))}</td></tr>`).join('');
    const net = Math.round((doc.total - (doc.wht || 0)) * 100) / 100;
    const hasWht = Number(doc.wht) > 0;
    const totals = [
      [t.subtotal, doc.subtotal],
      Number(doc.discount) ? [t.disc, -doc.discount] : null,
      doc.vat_rate > 0 ? [t.base, doc.vat_base] : null,
      Number(doc.exempt) || (doc.vat_rate > 0 && Math.abs(doc.total - doc.vat - doc.vat_base) > 0.004) ? [t.exempt, Math.round((doc.total - doc.vat - doc.vat_base) * 100) / 100] : null,
      doc.vat_rate > 0 ? [`${t.vat} ${Number(doc.vat_rate)}%`, doc.vat] : null,
    ].filter(Boolean);
    const note = doc.notes || (s.notes && s.notes[doc.type]) || '';
    const billing = (doc.type === 'IV' || doc.type === 'QT') && doc.status !== 'void' && opts.pay !== false;
    const payInfo = billing && s.payment ? s.payment : '';
    // Active payment channels: bank accounts (bank + number) and other channels (e.g. a payment gateway).
    const banks = billing && Array.isArray(s.banks) ? s.banks.filter((b) => b && b.active !== false && (b.kind === 'other' ? b.bank || b.name : b.bank && b.number)) : [];
    const pp = billing && doc.status !== 'paid' && s.promptpay && s.promptpay.id && s.promptpay.qr !== false && net > 0 ? s.promptpay : null;
    const qr = pp ? qrSvg(promptPayPayload(pp.id, net)) : '';
    const payBlock = banks.length || payInfo || pp ? `<section class="pp-pay">
        <div class="pp-pay-text"><div class="pp-label">${t.payTo}</div>
          ${banks.map((b) => (b.kind === 'other'
            ? `<div class="pp-bank"><b>${esc(b.name || b.bank)}</b>${b.name && b.bank ? ` · ${esc(b.bank)}` : ''}${b.number ? `<br>${esc(b.number)}` : ''}</div>`
            : `<div class="pp-bank"><b>${esc(b.bank)}</b>${b.branch ? ` ${t.branch} ${esc(b.branch)}` : ''}${b.acctType && ACCT_TYPE[lang] && ACCT_TYPE[lang][b.acctType] ? ` · ${ACCT_TYPE[lang][b.acctType]}` : ''}<br><span class="pp-mono">${esc(b.number)}</span>${b.name ? ` · ${esc(b.name)}` : ''}</div>`)).join('')}
          ${pp ? `<div class="pp-bank"><b>${t.promptpay}</b><br><span class="pp-mono">${esc(promptPayFmt(pp.id))}</span>${pp.name ? ` · ${esc(pp.name)}` : ''}</div>` : ''}
          ${payInfo ? `<div>${esc(payInfo).replace(/\n/g, '<br>')}</div>` : ''}
        </div>
        ${qr ? `<div class="pp-qr"><div class="pp-qr-card">
            <div class="pp-qr-head"><img src="img/thai-qr-payment.png" alt="Thai QR Payment"></div>
            <div class="pp-qr-body"><img class="pp-qr-pp" src="img/promptpay.png" alt="PromptPay">${qr}
              <div class="pp-qr-name">${qrNameLines(`${lang === 'en' ? 'Name' : 'ชื่อ'} : ${pp.name || (lang === 'en' && business.name_en ? business.name_en : business.name)}`)}</div>
              <div class="pp-qr-amt">${money(net)} ${t.baht}</div></div></div>
          <div class="pp-small">${t.scan}</div></div>` : ''}
      </section>` : '';
    const method = doc.pay && (lang === 'en' ? PAY_METHOD_EN : PAY_METHOD)[doc.pay.method];
    const paid = doc.type === 'RE' && doc.pay ? t.paidBy(method || '', fmtDate(doc.pay.date)) : '';

    // Payment record: the method ticked and the lines filled from the recorded payment on a receipt,
    // left blank on an invoice so the payer can fill it in by hand.
    const payForm = (doc.type === 'RE' || doc.type === 'IV') && doc.status !== 'void' ? (() => {
      const p = doc.type === 'RE' && doc.pay ? doc.pay : null;
      const box = (k) => `<span class="pp-pf-opt"><span class="pp-box">${p && p.method === k ? '✓' : ''}</span>${esc(t.pm[k])}</span>`;
      const fill = (label, v, cls = '') => `<div class="pp-pf-field${cls}"><span>${esc(label)}</span><span class="pp-pf-line">${v ? esc(v) : '&nbsp;'}</span></div>`;
      return `<section class="pp-pf">
        <div class="pp-pf-row"><span class="pp-pf-note">${esc(t.payDone)}</span>${['cash', 'cheque', 'transfer', 'card'].map(box).join('')}</div>
        <div class="pp-pf-row">${fill(t.bank, p && p.bank, ' w')}${fill(t.no, p && p.ref)}${fill(t.date, p && fmtDate(p.date))}${fill(t.amount, p && money(net))}</div>
      </section>`;
    })() : '';

    // Footer: the other party on the left, the business on the right, the company stamp centred between.
    // Each side has a signature line and a date line under "ในนาม …".
    const sign = opts.sign !== undefined ? opts.sign : !!s.signAuto;
    const [otherRole, ownRole] = t.roles[doc.type] || t.roles.IV;
    const otherName = doc.contact?.name || '';
    const side = (who, role, own) => {
      const mark = own && sign;
      return `<div class="pp-side${own ? ' own' : ''}">
        <div class="pp-for">${who ? `${t.on} ${esc(who)}` : '&nbsp;'}</div>
        <div class="pp-pair">
          <div class="pp-cell"><div class="pp-mark">${mark && business.signature ? `<img class="pp-signature" src="${esc(business.signature)}" alt="">` : ''}</div>
            <div class="pp-line"></div><div class="pp-role">${esc(role)}</div>${own && s.signer ? `<div class="pp-small pp-signer">(${esc(s.signer)})</div>${s.signerTitle ? `<div class="pp-small pp-signer">${esc(s.signerTitle)}</div>` : ''}` : ''}</div>
          <div class="pp-cell"><div class="pp-mark pp-date">${mark && (business.signature || business.stamp) ? esc(fmtDate(doc.date)) : ''}</div>
            <div class="pp-line"></div><div class="pp-role">${t.date}</div></div>
        </div></div>`;
    };
    const seal = `<div class="pp-seal">${sign && business.stamp ? `<img class="pp-stamp" src="${esc(business.stamp)}" alt="">` : ''}</div>`;
    const footer = side(otherName, otherRole, false) + seal + side(lang === 'en' && business.name_en ? business.name_en : business.name, ownRole, true);

    return `<article class="paper pp-lang-${lang}" style="--pp-accent:${esc(color)};--pp-soft:${tint(color, 0.09)};--pp-mid:${tint(color, 0.35)}">
      <div class="pp-corner"></div>${opts.page ? `<div class="pp-page">${esc(opts.page)}</div>` : ''}
      ${doc.status === 'void' ? `<div class="pp-void">${t.void}</div>` : ''}
      <header class="pp-top">
        <div class="pp-brand">
          <div class="pp-head">${business.logo ? `<img class="pp-logo" src="${esc(business.logo)}" alt="">` : ''}
          <div class="pp-biz">${esc(lang === 'en' && business.name_en ? business.name_en : business.name)}</div></div>
          ${business.address ? `<div class="pp-addr">${esc(business.address).replace(/\n/g, '<br>')}</div>` : ''}
          ${business.tax_id ? `<div class="pp-small">${t.taxId} ${esc(taxIdFmt(business.tax_id))} · ${esc(branchText(business.branch || '00000', lang))}</div>` : ''}
          ${business.phone || business.email || business.website ? `<div class="pp-small">${esc([business.phone, business.email, business.website].filter(Boolean).join(' · '))}</div>` : ''}
        </div>
        <div class="pp-title">
          <h1>${esc(lang === 'en' ? en : th)}</h1>
          <div class="pp-en">${esc(lang === 'en' ? th : en)}</div>
          <div class="pp-copy">${esc(t[copyKey])}</div>
        </div>
        ${partyBlock(doc.type === 'EX' ? t.payee : t.customer, doc.contact, t, lang) || '<div></div>'}
        <dl class="pp-meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      </header>
      <table class="pp-lines">
        <thead><tr><th class="c">#</th><th>${t.item}</th><th class="r">${t.qty}</th><th class="r">${t.price}</th>${showDisc ? `<th class="r">${t.disc}</th>` : ''}<th class="r">${t.amount}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="pp-sum">
        ${totals.map(([k, v]) => `<tr><td class="pp-left"></td><th>${esc(k)}</th><td class="pp-amt">${money(v)}</td></tr>`).join('')}
        <tr class="pp-grand${hasWht ? '' : ' pp-due'}"><td class="pp-left pp-baht">(${esc(lang === 'en' ? bahtTextEn(doc.total) : bahtText(doc.total))})</td><th>${t.grand}</th><td class="pp-amt">${money(doc.total)}</td></tr>
        ${hasWht ? `<tr><td class="pp-left"></td><th>${doc.type === 'EX' ? t.whtOwn : t.whtCust}</th><td class="pp-amt">${money(-doc.wht)}</td></tr><tr class="pp-due"><td class="pp-left"></td><th>${doc.type === 'EX' ? t.netPaid : t.net}</th><td class="pp-amt">${money(net)}</td></tr>` : ''}
      </table>
      ${paid && !payForm ? `<div class="pp-small pp-paid">${esc(paid)}</div>` : ''}
      ${note ? `<div class="pp-notes"><div class="pp-label">${t.notes}</div><div>${esc(note).replace(/\n/g, '<br>')}</div></div>` : ''}
      ${payBlock}
      ${payForm}
      <footer class="pp-sign">${footer}</footer>
    </article>`;
  }

  /* ---------- Expense documents: ใบสำคัญจ่าย / ใบรับรองแทนใบเสร็จรับเงิน / ใบรับสินค้า ---------- */

  // The three headers an expense prints under. pv: payment voucher, rc: receipt substitute, gr: goods received.
  const VOUCHER_FORMS = {
    pv: ['ใบสำคัญจ่าย', 'Payment Voucher'],
    rc: ['ใบรับรองแทนใบเสร็จรับเงิน', 'Receipt Substitute'],
    gr: ['ใบรับสินค้า', 'Goods Received Note'],
  };
  const VL = {
    th: {
      buyer: 'ผู้ซื้อ', seller: 'ผู้ขาย', payer: 'ผู้จ่ายเงิน', payee: 'ผู้รับเงิน', addr: 'ที่อยู่', taxId: 'เลขที่ภาษี', idNo: 'เลขประจำตัว', contact: 'ติดต่อ',
      no: 'เลขที่เอกสาร', date: 'วันที่ออก', billNo: 'อ้างอิงบิลผู้ขาย', billDate: 'วันที่ในบิล', due: 'ครบกำหนดจ่าย', preparer: 'ผู้จัดทำ',
      desc: 'คำอธิบาย', qty: 'จำนวน', unit: 'หน่วย', price: 'ราคา', disc: 'ส่วนลด', vat: 'VAT', none: 'ไม่มี', amount: 'มูลค่า', amountRc: 'จำนวนเงิน',
      rcDate: 'วัน เดือน ปี', rcDesc: 'รายละเอียดรายจ่าย', check: 'ตรวจรับ',
      summary: 'สรุป', subtotal: 'รวมเป็นเงิน', discount: 'ส่วนลด', vatBase: 'มูลค่าที่คำนวณภาษี', exempt: 'มูลค่าไม่มีหรือยกเว้นภาษี', vatAmt: 'ภาษีมูลค่าเพิ่ม',
      grand: 'จำนวนเงินทั้งสิ้น', words: 'ตัวอักษร', wht: 'จำนวนเงินที่ถูกหัก ณ ที่จ่าย', paidAmt: 'จำนวนเงินที่ชำระ', baht: 'บาท',
      payment: 'ชำระเงิน', payDate: 'วันที่ชำระ', method: 'วิธีชำระ', from: 'จ่ายจาก', toBank: 'ธนาคาร / เลขที่', fee: 'ค่าธรรมเนียม',
      notPaid: 'ยังไม่ได้บันทึกการจ่ายเงิน กรอกด้วยมือเมื่อจ่าย', bankLine: 'ธนาคาร', refLine: 'เลขที่', notes: 'หมายเหตุ', sign: 'รับรอง',
      pm: { cash: 'เงินสด', cheque: 'เช็ค', transfer: 'โอนเงิน', card: 'บัตร', other: 'อื่น ๆ' },
      roles: {
        pv: ['ผู้จัดทำ', 'ผู้อนุมัติ', 'ผู้รับเงิน'], rc: ['ผู้รับเงิน', 'ผู้จ่ายเงิน', 'ผู้อนุมัติ'], gr: ['ผู้ส่งสินค้า', 'ผู้รับสินค้า', 'ผู้อนุมัติ'],
      },
      stamp: 'ตราประทับ', signDate: 'วันที่',
      certify: (who, biz) => `ข้าพเจ้า ${who} ขอรับรองว่ารายจ่ายข้างต้นนี้ไม่อาจเรียกเก็บใบเสร็จรับเงินจากผู้รับเงินได้ และได้จ่ายไปเพื่อกิจการของ ${biz} โดยแท้`,
      certifyH: 'คำรับรอง', grNote: 'ได้รับสินค้าตามรายการข้างต้นไว้ถูกต้องและอยู่ในสภาพเรียบร้อยแล้ว',
      original: 'ต้นฉบับ', void: 'ยกเลิก', ho: 'สำนักงานใหญ่',
    },
    en: {
      buyer: 'Buyer', seller: 'Vendor', payer: 'Payer', payee: 'Payee', addr: 'Address', taxId: 'Tax ID', idNo: 'ID no.', contact: 'Contact',
      no: 'Document no.', date: 'Issue date', billNo: 'Vendor bill no.', billDate: 'Bill date', due: 'Due date', preparer: 'Prepared by',
      desc: 'Description', qty: 'Qty', unit: 'Unit', price: 'Price', disc: 'Discount', vat: 'VAT', none: 'None', amount: 'Amount', amountRc: 'Amount',
      rcDate: 'Date', rcDesc: 'Expense details', check: 'Checked',
      summary: 'Summary', subtotal: 'Subtotal', discount: 'Discount', vatBase: 'Taxable amount', exempt: 'Non-VAT / exempt amount', vatAmt: 'VAT',
      grand: 'Grand total', words: 'In words', wht: 'Withholding tax', paidAmt: 'Amount paid', baht: 'THB',
      payment: 'Payment', payDate: 'Paid on', method: 'Method', from: 'Paid from', toBank: 'Bank / ref.', fee: 'Fee',
      notPaid: 'No payment recorded yet. Fill in by hand when paid.', bankLine: 'Bank', refLine: 'No.', notes: 'Notes', sign: 'Sign-off',
      pm: { cash: 'Cash', cheque: 'Cheque', transfer: 'Transfer', card: 'Card', other: 'Other' },
      roles: {
        pv: ['Prepared by', 'Approved by', 'Received by'], rc: ['Received by', 'Paid by', 'Approved by'], gr: ['Delivered by', 'Received by', 'Approved by'],
      },
      stamp: 'Company stamp', signDate: 'Date',
      certify: (who, biz) => `I, ${who}, certify that no receipt could be obtained from the payee for the expenses above, and that they were paid solely for the business of ${biz}.`,
      certifyH: 'Certification', grNote: 'The goods listed above were received complete and in good condition.',
      original: 'Original', void: 'VOID', ho: 'Head office',
    },
  };

  // doc: an EX document. opts: form ('pv' | 'rc' | 'gr', default the document's own), lang, sign, page,
  //       payFrom (name of the money account the payment came from).
  function renderVoucher(doc, business, opts = {}) {
    const s = business.settings || {};
    const lang = opts.lang === 'en' ? 'en' : opts.lang === 'th' ? 'th' : (s.lang === 'en' ? 'en' : 'th');
    const t = VL[lang];
    const v = doc.voucher || {};
    const form = VOUCHER_FORMS[opts.form] ? opts.form : VOUCHER_FORMS[v.form] ? v.form : 'pv';
    const [th, en] = VOUCHER_FORMS[form];
    const fmtDate = lang === 'en' ? enDate : slashDate;
    const color = s.color || '#E8590C';
    const lines = doc.lines || [];
    const bizName = lang === 'en' && business.name_en ? business.name_en : business.name;
    const c = doc.contact || {};
    const pay = doc.pay || null;
    const net = Math.round((doc.total - (doc.wht || 0)) * 100) / 100;
    const vatOn = Number(doc.vat_rate) > 0;
    const showDisc = lines.some((l) => Number(l.disc) > 0);
    const br = (x) => esc(x).replace(/\n/g, '<br>');
    const dash = '<span class="pv-dim">-</span>';
    const sign = opts.sign !== undefined ? !!opts.sign : !!s.signAuto;

    // Parties: our business pays (ผู้ซื้อ / ผู้จ่ายเงิน), the contact is paid (ผู้ขาย / ผู้รับเงิน).
    const party = (label, p, id) => `<div class="pv-party"><dl>
        <dt>${esc(label)}</dt><dd class="pv-pname">${esc(p.name || '') || dash}</dd>
        <dt>${t.addr}</dt><dd>${p.address ? br(p.address) : dash}</dd>
        <dt>${esc(id.label)}</dt><dd>${id.value ? esc(id.value) : dash}</dd>
        ${p.phone || p.email ? `<dt>${t.contact}</dt><dd>${esc([p.phone, p.email].filter(Boolean).join(' · '))}</dd>` : ''}
      </dl></div>`;
    const bizTax = business.tax_id ? `${taxIdFmt(business.tax_id)} (${branchText(business.branch || '00000', lang)})` : '';
    const cTax = c.tax_id ? `${taxIdFmt(c.tax_id)}${c.branch ? ` (${branchText(c.branch, lang)})` : ''}` : '';
    const payeeId = form === 'rc' && v.received_id ? taxIdFmt(v.received_id) : cTax;
    const us = { name: bizName, address: business.address, phone: business.phone, email: business.email };
    const parties = form === 'rc'
      ? party(t.payee, c, { label: v.received_id ? t.idNo : t.taxId, value: payeeId }) + party(t.payer, us, { label: t.taxId, value: bizTax })
      : party(t.buyer, us, { label: t.taxId, value: bizTax }) + party(form === 'pv' ? `${t.seller} / ${t.payee}` : t.seller, c, { label: t.taxId, value: cTax });

    const meta = [
      [t.no, doc.number],
      [t.date, fmtDate(doc.date)],
      [t.billNo, doc.ref_no || '-'],
      doc.ref_date ? [t.billDate, fmtDate(doc.ref_date)] : null,
      doc.due_date && !pay ? [t.due, fmtDate(doc.due_date)] : null,
    ].filter(Boolean);

    // Items
    let table;
    if (form === 'rc') {
      table = `<table class="pv-lines"><thead><tr><th class="pv-d">${t.rcDate}</th><th>${t.rcDesc}</th><th class="r">${t.amountRc}</th></tr></thead><tbody>
        ${lines.map((l, i) => `<tr><td class="pv-d">${i ? '' : esc(fmtDate(doc.ref_date || doc.date))}</td>
          <td><div class="pp-item">${esc(l.name)}${Number(l.qty) !== 1 ? ` <span class="pv-dim">× ${qtyFmt(l.qty)}${l.unit ? ` ${esc(l.unit)}` : ''}</span>` : ''}</div>${l.desc ? `<div class="pp-desc">${br(l.desc)}</div>` : ''}</td>
          <td class="r">${money(l.amount ?? (Number(l.qty) * Number(l.price) - (Number(l.disc) || 0)))}</td></tr>`).join('')}
        </tbody></table>`;
    } else {
      const gr = form === 'gr';
      table = `<table class="pv-lines"><thead><tr><th>${t.desc}</th><th class="r">${t.qty}</th>${gr ? `<th>${t.unit}</th>` : ''}<th class="r">${t.price}</th>
          ${showDisc ? `<th class="r">${t.disc}</th>` : ''}${vatOn && !gr ? `<th class="r">${t.vat}</th>` : ''}<th class="r">${t.amount}</th>${gr ? `<th class="c">${t.check}</th>` : ''}</tr></thead><tbody>
        ${lines.map((l, i) => `<tr>
          <td><div class="pp-item"><span class="pv-n">${i + 1}.</span>${esc(l.name)}</div>${l.desc ? `<div class="pp-desc pv-ind">${br(l.desc)}</div>` : ''}</td>
          <td class="r">${qtyFmt(l.qty)}</td>${gr ? `<td>${esc(l.unit || '')}</td>` : ''}
          <td class="r">${money(l.price)}</td>
          ${showDisc ? `<td class="r">${money(l.disc || 0)}</td>` : ''}
          ${vatOn && !gr ? `<td class="r">${l.vat !== false ? `${Number(doc.vat_rate)}%` : t.none}</td>` : ''}
          <td class="r">${money(l.amount ?? (Number(l.qty) * Number(l.price) - (Number(l.disc) || 0)))}</td>
          ${gr ? '<td class="c"><span class="pp-box"></span></td>' : ''}</tr>`).join('')}
        </tbody></table>`;
    }

    // Summary: the breakdown and amount in words on the left, the total (and what was paid) on the right.
    const exempt = Math.round((doc.total - (doc.vat || 0) - (vatOn ? doc.vat_base : 0)) * 100) / 100;
    const sumRows = [
      Number(doc.discount) ? [t.subtotal, money(doc.subtotal)] : null,
      Number(doc.discount) ? [t.discount, money(-doc.discount)] : null,
      vatOn ? [t.vatBase, money(doc.vat_base)] : null,
      !vatOn || Math.abs(exempt) > 0.004 ? [t.exempt, money(exempt)] : null,
      vatOn ? [`${t.vatAmt} ${Number(doc.vat_rate)}%`, money(doc.vat)] : null,
    ].filter(Boolean);
    const words = lang === 'en' ? bahtTextEn(doc.total) : bahtText(doc.total);
    const hasWht = Number(doc.wht) > 0 && form !== 'gr';
    const summary = `<section class="pv-sec pv-sum"><div class="pv-h">${t.summary}</div>
      <div class="pv-sum-l"><table>${sumRows.map(([k, x]) => `<tr><th>${esc(k)}</th><td>${x} ${t.baht}</td></tr>`).join('')}
        <tr class="pv-words"><th>${t.grand}</th><td>${esc(words)}</td></tr></table></div>
      <div class="pv-sum-r"><div class="pv-total"><span>${t.grand}</span><b>${money(doc.total)}<small> ${t.baht}</small></b></div>
        ${hasWht || form === 'pv' ? `<table><tr><th>${t.wht}</th><td>${money(doc.wht || 0)} ${t.baht}</td></tr><tr class="pv-net"><th>${t.paidAmt}</th><td>${money(net)} ${t.baht}</td></tr></table>` : ''}</div>
    </section>`;

    // Payment: what was recorded, or lines to fill in by hand.
    let payment = '';
    if (form !== 'gr') {
      if (pay) {
        const pm = t.pm[pay.method] || '';
        payment = `<section class="pv-sec pv-pay"><div class="pv-h">${t.payment}</div>
          <dl class="pv-pay-l"><dt>${t.payDate}</dt><dd>${esc(fmtDate(pay.date))}</dd><dt>${t.method}</dt><dd>${esc(pm)}</dd>
            ${Number(pay.fee) ? `<dt>${t.fee}</dt><dd>${money(pay.fee)} ${t.baht}</dd>` : ''}</dl>
          <div class="pv-pay-m">${opts.payFrom ? `<div><span class="pv-dim">${t.from}</span> <b>${esc(opts.payFrom)}</b></div>` : ''}
            ${pay.bank || pay.ref ? `<div><span class="pv-dim">${t.toBank}</span> ${esc([pay.bank, pay.ref].filter(Boolean).join(' · '))}</div>` : ''}</div>
          <div class="pv-pay-r">${money(net)} ${t.baht}</div></section>`;
      } else {
        const box = (k) => `<span class="pp-pf-opt"><span class="pp-box"></span>${esc(t.pm[k])}</span>`;
        const fill = (label, cls = '') => `<div class="pp-pf-field${cls}"><span>${esc(label)}</span><span class="pp-pf-line">&nbsp;</span></div>`;
        payment = `<section class="pv-sec pv-pay pv-blank"><div class="pv-h">${t.payment}</div>
          <div class="pp-pf pv-pf"><div class="pp-pf-row">${['cash', 'transfer', 'cheque', 'card'].map(box).join('')}<span class="pv-dim pv-hint">${t.notPaid}</span></div>
            <div class="pp-pf-row">${fill(t.bankLine, ' w')}${fill(t.refLine)}${fill(t.payDate)}${fill(t.amountRc)}</div></div></section>`;
      }
    }

    const note = doc.notes || (s.notes && s.notes.EX) || '';
    const notes = `<section class="pv-sec"><div class="pv-h">${t.notes}</div><div class="pv-body">${note ? br(note) : ''}</div></section>`;
    const blank = '..............................';
    const certify = form === 'rc'
      ? `<section class="pv-sec"><div class="pv-h">${t.certifyH}</div><div class="pv-body">${esc(t.certify(v.prepared_by || blank, bizName))}</div></section>`
      : form === 'gr' ? `<section class="pv-sec"><div class="pv-h">${t.certifyH}</div><div class="pv-body">${esc(t.grNote)}</div></section>` : '';

    // Sign-off: three signers and the company stamp. The saved signature goes on the approver.
    const roles = t.roles[form];
    const approver = v.approved_by || s.signer || '';
    const names = form === 'pv' ? [v.prepared_by, approver, v.received_by || c.name]
      : form === 'rc' ? [v.received_by || c.name, v.prepared_by, approver]
        : [c.name, v.received_by || v.prepared_by, approver];
    const signDate = fmtDate((pay && pay.date) || doc.date);
    const cell = (role, name, own) => {
      const mark = own && sign && business.signature;
      return `<div class="pv-signer"><div class="pv-role">${esc(role)}</div>
        <div class="pv-mark">${mark ? `<img class="pp-signature" src="${esc(business.signature)}" alt="">` : ''}</div>
        <div class="pv-sline"></div><div class="pv-sname">${name ? `(${esc(name)})` : `(${blank})`}</div>
        <div class="pv-sdate">${t.signDate} ${mark ? esc(signDate) : '....../....../......'}</div></div>`;
    };
    const ownIdx = form === 'pv' ? 1 : 2;
    const signs = `<section class="pv-sec pv-signs"><div class="pv-h">${t.sign}</div><div class="pv-sgrid">
      ${roles.map((r, i) => cell(r, names[i], i === ownIdx)).join('')}
      <div class="pv-signer"><div class="pv-role">${t.stamp}</div><div class="pv-seal">${sign && business.stamp ? `<img class="pp-stamp" src="${esc(business.stamp)}" alt="">` : ''}</div></div>
    </div></section>`;

    return `<article class="paper pv pp-lang-${lang}" style="--pp-accent:${esc(color)};--pp-soft:${tint(color, 0.09)};--pp-mid:${tint(color, 0.35)}">
      <div class="pp-corner"></div>${opts.page ? `<div class="pp-page">${esc(opts.page)}</div>` : ''}
      ${doc.status === 'void' ? `<div class="pp-void">${t.void}</div>` : ''}
      <header class="pv-top">
        <div class="pp-head">${business.logo ? `<img class="pp-logo" src="${esc(business.logo)}" alt="">` : `<div class="pp-biz">${esc(bizName)}</div>`}</div>
        <div class="pv-title"><div class="pp-copy">${t.original}</div><h1>${esc(lang === 'en' ? en : th)}</h1><div class="pp-en">${esc(lang === 'en' ? th : en)}</div></div>
      </header>
      <section class="pv-info">
        <div class="pv-parties">${parties}</div>
        <div class="pv-side"><dl class="pv-meta">${meta.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join('')}</dl>
          ${v.prepared_by && form !== 'rc' ? `<div class="pv-prep"><div class="pp-label">${t.preparer}</div><div>${esc(v.prepared_by)}</div></div>` : ''}</div>
      </section>
      ${table}
      <div class="pv-foot">
        ${summary}${payment}${certify}${notes}${signs}
      </div>
    </article>`;
  }

  // The account name under the QR as explicit lines: html2canvas misplaces Thai text that the browser wraps itself.
  function qrNameLines(text) {
    const t = String(text || '').trim();
    if (t.length <= 24) return `<div>${esc(t)}</div>`;
    const mid = t.length / 2;
    let cut = -1;
    for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
    if (cut < 0) return `<div>${esc(t)}</div>`;
    return `<div>${esc(t.slice(0, cut))}</div><div>${esc(t.slice(cut + 1))}</div>`;
  }

  // The pages to print or download: the original and/or `copies` copies, numbered in the corner.
  // o: { original, copy, copies, lang, pay, sign }
  function renderSet(doc, business, o = {}) {
    const kinds = [];
    if (o.original !== false) kinds.push('original');
    if (o.copy !== false && doc.type !== 'EX') for (let i = 0; i < Math.max(1, Math.min(5, Number(o.copies) || 1)); i++) kinds.push('copy');
    if (!kinds.length) kinds.push('original');
    return kinds.map((k, i) => renderDoc(doc, business, { ...o, copy: k, page: kinds.length > 1 ? String(i + 1) : '' })).join('');
  }

  /* ---------- PromptPay QR (EMVCo merchant-presented, Thai QR Payment) ---------- */

  function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
  const tlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
  // id: 10-digit mobile (0812345678), 13-digit tax / citizen ID or 15-digit e-wallet ID. amount in baht.
  function promptPayPayload(id, amount) {
    const d = String(id || '').replace(/\D/g, '');
    const target = d.length === 15 ? tlv('03', d) : d.length === 13 ? tlv('02', d) : tlv('01', ('0000000000000' + '66' + d.replace(/^0/, '')).slice(-13));
    const amt = Number(amount) > 0 ? tlv('54', (Math.round(Number(amount) * 100) / 100).toFixed(2)) : '';
    const body = tlv('00', '01') + tlv('01', amt ? '12' : '11') + tlv('29', tlv('00', 'A000000677010111') + target)
      + tlv('58', 'TH') + tlv('53', '764') + amt + '6304';
    return body + crc16(body);
  }
  const promptPayFmt = (id) => {
    const d = String(id || '').replace(/\D/g, '');
    return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d.length === 13 ? taxIdFmt(d) : d;
  };
  // The QR as inline SVG (needs vendor/qrcode.min.js loaded as window.qrcode).
  function qrSvg(text) {
    const Q = g.qrcode;
    if (!Q) return '';
    const q = Q(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + 2} ${r + 2}h1v1h-1z`;
    const w = n + 4;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 8}" height="${w * 8}" viewBox="0 0 ${w} ${w}" shape-rendering="crispEdges"><rect width="${w}" height="${w}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
    // An <img> (not inline SVG) so html2canvas draws it exactly in the downloaded PDF.
    return `<img class="pp-qr-svg" alt="PromptPay QR" src="data:image/svg+xml;base64,${btoa(svg)}">`;
  }

  /* ---------- PDF download (html2pdf from cdnjs, loaded on first use) ---------- */

  let pdfLib;
  function loadPdfLib() {
    if (g.html2pdf) return Promise.resolve(g.html2pdf);
    pdfLib = pdfLib || new Promise((ok, no) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      sc.onload = () => ok(g.html2pdf);
      sc.onerror = () => { pdfLib = null; no(new Error('โหลดตัวสร้าง PDF ไม่สำเร็จ')); };
      document.head.appendChild(sc);
    });
    return pdfLib;
  }
  // html: one or more rendered .paper articles. Saves an A4 PDF named `filename`.
  async function downloadPdf(html, filename) {
    const lib = await loadPdfLib();
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    // html2pdf renders the string in its own overlay container (an off-screen element of ours comes out blank).
    await lib().set({
      margin: 0, filename,
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css'] },
    }).from(`<div class="pdf-render">${html}</div>`, 'string').save();
  }

  g.Thai = {
    downloadPdf, promptPayPayload, promptPayFmt, qrSvg,
    esc, money, qtyFmt, thDate, slashDate, thMonth, today, taxIdFmt, branchFmt, bahtText, computeTotals, WHT_RATES,
    docTitle, VOUCHER_FORMS, renderVoucher, TYPE_NAME, TH_MONTHS, STATUS, statusName, PAY_METHOD, renderDoc, renderSet, TH_MONTHS_LONG, bahtTextEn,
  };
})(typeof window !== 'undefined' ? window : globalThis);
