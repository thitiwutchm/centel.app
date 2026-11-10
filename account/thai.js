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
    const banks = billing && Array.isArray(s.banks) ? s.banks.filter((b) => b && b.bank && b.number) : [];
    const pp = billing && doc.status !== 'paid' && s.promptpay && s.promptpay.id && s.promptpay.qr !== false && net > 0 ? s.promptpay : null;
    const qr = pp ? qrSvg(promptPayPayload(pp.id, net)) : '';
    const payBlock = banks.length || payInfo || pp ? `<section class="pp-pay">
        <div class="pp-pay-text"><div class="pp-label">${t.payTo}</div>
          ${banks.map((b) => `<div class="pp-bank"><b>${esc(b.bank)}</b>${b.branch ? ` ${t.branch} ${esc(b.branch)}` : ''}<br><span class="pp-mono">${esc(b.number)}</span>${b.name ? ` · ${esc(b.name)}` : ''}</div>`).join('')}
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
      <section class="pp-sum">
        <div class="pp-words">
          <div class="pp-label">${t.words}</div>
          <div class="pp-baht">(${esc(lang === 'en' ? bahtTextEn(doc.total) : bahtText(doc.total))})</div>
          ${paid ? `<div class="pp-small">${esc(paid)}</div>` : ''}
          ${note ? `<div class="pp-notes"><div class="pp-label">${t.notes}</div><div>${esc(note).replace(/\n/g, '<br>')}</div></div>` : ''}
        </div>
        <table class="pp-totals">
          ${totals.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${money(v)}</td></tr>`).join('')}
          <tr class="pp-grand${hasWht ? '' : ' pp-due'}"><th>${t.grand}</th><td>${money(doc.total)}</td></tr>
          ${hasWht ? `<tr><th>${doc.type === 'EX' ? t.whtOwn : t.whtCust}</th><td>${money(-doc.wht)}</td></tr><tr class="pp-due"><th>${doc.type === 'EX' ? t.netPaid : t.net}</th><td>${money(net)}</td></tr>` : ''}
        </table>
      </section>
      ${payBlock}
      <footer class="pp-sign">${footer}</footer>
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
    docTitle, TYPE_NAME, TH_MONTHS, STATUS, statusName, PAY_METHOD, renderDoc, renderSet, TH_MONTHS_LONG, bahtTextEn,
  };
})(typeof window !== 'undefined' ? window : globalThis);
