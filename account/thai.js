// Shared by the accounting app (app.js) and the public document page (doc.html):
// Thai formatting, document totals (same rules as server/src/acc/ledger.js) and the
// printable A4 layouts for sales documents and the 50 ทวิ withholding certificate.
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

  function partyBlock(label, p) {
    if (!p) return '';
    return `<div class="pp-party"><div class="pp-label">${esc(label)}</div>
      <div class="pp-name">${esc(p.name)}</div>
      ${p.address ? `<div class="pp-addr">${esc(p.address).replace(/\n/g, '<br>')}</div>` : ''}
      ${p.tax_id ? `<div class="pp-small">เลขประจำตัวผู้เสียภาษี ${esc(taxIdFmt(p.tax_id))}${p.branch ? ` · ${esc(branchFmt(p.branch))}` : ''}</div>` : ''}
      ${p.phone || p.email ? `<div class="pp-small">${esc([p.phone, p.email].filter(Boolean).join(' · '))}</div>` : ''}</div>`;
  }

  // doc: a stored document (or the public shape); business: the business row; opts.copy: 'ต้นฉบับ' | 'สำเนา'
  function renderDoc(doc, business, opts = {}) {
    const [th, en] = docTitle(doc);
    const s = business.settings || {};
    const color = s.color || '#E8590C';
    const lines = doc.lines || [];
    const showDisc = lines.some((l) => Number(l.disc) > 0);
    const meta = [
      ['เลขที่', doc.number],
      ['วันที่', slashDate(doc.date)],
      doc.due_date ? [doc.type === 'QT' ? 'ยืนราคาถึง' : 'ครบกำหนด', slashDate(doc.due_date)] : null,
      doc.ref ? ['อ้างอิง', doc.ref.number] : null,
      doc.type === 'EX' && doc.ref_no ? ['เลขที่บิลผู้ขาย', doc.ref_no] : null,
    ].filter(Boolean);
    const rows = lines.map((l, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td><div class="pp-item">${esc(l.name)}</div>${l.desc ? `<div class="pp-desc">${esc(l.desc).replace(/\n/g, '<br>')}</div>` : ''}</td>
      <td class="r">${qtyFmt(l.qty)}${l.unit ? ` <span class="pp-unit">${esc(l.unit)}</span>` : ''}</td>
      <td class="r">${money(l.price)}</td>
      ${showDisc ? `<td class="r">${Number(l.disc) ? money(l.disc) : ''}</td>` : ''}
      <td class="r">${money(l.amount ?? (Number(l.qty) * Number(l.price) - (Number(l.disc) || 0)))}</td></tr>`).join('');
    const vatLabel = doc.vat_rate > 0 ? `ภาษีมูลค่าเพิ่ม ${Number(doc.vat_rate)}%` : '';
    const totals = [
      ['รวมเป็นเงิน', doc.subtotal],
      Number(doc.discount) ? ['ส่วนลด', -doc.discount] : null,
      doc.vat_rate > 0 ? ['มูลค่าก่อนภาษี', doc.vat_base] : null,
      Number(doc.exempt) || (doc.vat_rate > 0 && Math.abs(doc.total - doc.vat - doc.vat_base) > 0.004) ? ['มูลค่ายกเว้นภาษี', Math.round((doc.total - doc.vat - doc.vat_base) * 100) / 100] : null,
      doc.vat_rate > 0 ? [vatLabel, doc.vat] : null,
    ].filter(Boolean);
    const net = Math.round((doc.total - (doc.wht || 0)) * 100) / 100;
    const note = doc.notes || (s.notes && s.notes[doc.type]) || '';
    const payInfo = (doc.type === 'IV' || doc.type === 'QT') && s.payment ? s.payment : '';
    const paid = doc.type === 'RE' && doc.pay ? `ชำระโดย ${esc(PAY_METHOD[doc.pay.method] || '')} เมื่อ ${esc(slashDate(doc.pay.date))}` : '';
    const sign = doc.type === 'QT'
      ? [['ผู้เสนอราคา', s.signer], ['ผู้อนุมัติสั่งซื้อ (ลูกค้า)', '']]
      : doc.type === 'RE' ? [['ผู้จ่ายเงิน', ''], ['ผู้รับเงิน', s.signer]]
        : doc.type === 'EX' ? [['ผู้จัดทำ', ''], ['ผู้อนุมัติ', s.signer], ['ผู้รับเงิน', '']]
          : [['ผู้รับวางบิล', ''], ['ผู้วางบิล', s.signer]];
    return `<article class="paper" style="--pp-accent:${esc(color)}">
      ${doc.status === 'void' ? '<div class="pp-void">ยกเลิก</div>' : ''}
      <header class="pp-head">
        <div class="pp-brand">
          ${business.logo ? `<img class="pp-logo" src="${esc(business.logo)}" alt="">` : ''}
          <div>
            <div class="pp-biz">${esc(business.name)}</div>
            ${business.name_en ? `<div class="pp-small">${esc(business.name_en)}</div>` : ''}
            ${business.address ? `<div class="pp-addr">${esc(business.address).replace(/\n/g, '<br>')}</div>` : ''}
            ${business.tax_id ? `<div class="pp-small">เลขประจำตัวผู้เสียภาษี ${esc(taxIdFmt(business.tax_id))} · ${esc(branchFmt(business.branch || '00000'))}</div>` : ''}
            ${business.phone || business.email ? `<div class="pp-small">${esc([business.phone, business.email, business.website].filter(Boolean).join(' · '))}</div>` : ''}
          </div>
        </div>
        <div class="pp-title">
          <div class="pp-copy">${esc(opts.copy || 'ต้นฉบับ')}</div>
          <h1>${esc(th)}</h1>
          <div class="pp-en">${esc(en)}</div>
        </div>
      </header>
      <section class="pp-info">
        ${partyBlock(doc.type === 'EX' ? 'ผู้รับเงิน / ผู้ขาย' : 'ลูกค้า', doc.contact)}
        <dl class="pp-meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      </section>
      <table class="pp-lines">
        <thead><tr><th class="c">#</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคาต่อหน่วย</th>${showDisc ? '<th class="r">ส่วนลด</th>' : ''}<th class="r">จำนวนเงิน</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <section class="pp-sum">
        <div class="pp-words">
          <div class="pp-label">จำนวนเงินรวมทั้งสิ้น (ตัวอักษร)</div>
          <div class="pp-baht">(${esc(bahtText(doc.total))})</div>
          ${paid ? `<div class="pp-small">${paid}</div>` : ''}
        </div>
        <table class="pp-totals">
          ${totals.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${money(v)}</td></tr>`).join('')}
          <tr class="pp-grand"><th>จำนวนเงินรวมทั้งสิ้น</th><td>${money(doc.total)}</td></tr>
          ${Number(doc.wht) ? `<tr><th>${doc.type === 'EX' ? 'หักภาษี ณ ที่จ่าย' : 'ภาษีหัก ณ ที่จ่าย (ลูกค้าหัก)'}</th><td>${money(-doc.wht)}</td></tr><tr class="pp-net"><th>${doc.type === 'EX' ? 'ยอดจ่ายสุทธิ' : 'ยอดชำระสุทธิ'}</th><td>${money(net)}</td></tr>` : ''}
        </table>
      </section>
      ${note || payInfo ? `<section class="pp-notes">
        ${note ? `<div><div class="pp-label">หมายเหตุ</div><div>${esc(note).replace(/\n/g, '<br>')}</div></div>` : ''}
        ${payInfo ? `<div><div class="pp-label">ช่องทางชำระเงิน</div><div>${esc(payInfo).replace(/\n/g, '<br>')}</div></div>` : ''}
      </section>` : ''}
      <footer class="pp-sign">${sign.map(([k, name]) => `<div><div class="pp-line"></div><div>${esc(name ? `(${name})` : '(.................................................)')}</div><div class="pp-small">${esc(k)}</div><div class="pp-small">วันที่ ......../......../............</div></div>`).join('')}</footer>
    </article>`;
  }

  // หนังสือรับรองการหักภาษี ณ ที่จ่าย ตามมาตรา 50 ทวิ, for a paid expense with WHT.
  function renderWht(doc, business) {
    const c = doc.wht_cert || {};
    const box = (on) => `<span class="pp-box">${on ? '✓' : ''}</span>`;
    const byRate = new Map();
    for (const l of doc.lines || []) if (Number(l.wht) > 0) byRate.set(Number(l.wht), (byRate.get(Number(l.wht)) || 0) + Number(l.base || 0));
    const rows = [...byRate].map(([rate, base]) => `<tr><td>5. ${esc(c.income || 'ค่าบริการ')} (อัตรา ${rate}%)<div class="pp-small">การจ่ายเงินได้ที่ต้องหักภาษี ณ ที่จ่าย ตามคำสั่งกรมสรรพากรที่ออกตามมาตรา 3 เตรส</div></td>
      <td class="c">${slashDate(doc.pay?.date)}</td><td class="r">${money(base)}</td><td class="r">${money(Math.round(base * rate) / 100)}</td></tr>`).join('');
    const base = [...byRate.values()].reduce((s, x) => s + x, 0);
    return `<article class="paper pp-wht">
      <div class="pp-copy">ฉบับที่ 1 (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย ใช้แนบพร้อมกับแบบแสดงรายการภาษี)</div>
      <h1 class="pp-wht-title">หนังสือรับรองการหักภาษี ณ ที่จ่าย</h1>
      <div class="pp-wht-sub">ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร <span class="pp-wht-no">เลขที่ ${esc(c.number || '-')}</span></div>
      <section class="pp-wht-party"><div class="pp-label">ผู้มีหน้าที่หักภาษี ณ ที่จ่าย</div>
        <div class="pp-name">${esc(business.name)}</div><div class="pp-addr">${esc(business.address || '')}</div>
        <div class="pp-small">เลขประจำตัวผู้เสียภาษีอากร ${esc(taxIdFmt(business.tax_id))}</div></section>
      <section class="pp-wht-party"><div class="pp-label">ผู้ถูกหักภาษี ณ ที่จ่าย</div>
        <div class="pp-name">${esc(doc.contact?.name)}</div><div class="pp-addr">${esc(doc.contact?.address || '')}</div>
        <div class="pp-small">เลขประจำตัวผู้เสียภาษีอากร ${esc(taxIdFmt(doc.contact?.tax_id))}</div></section>
      <div class="pp-wht-forms">ลำดับที่ ........ ในแบบ ${box(c.form === 'pnd3')} ภ.ง.ด.3 &nbsp; ${box(c.form === 'pnd53')} ภ.ง.ด.53</div>
      <table class="pp-lines">
        <thead><tr><th>ประเภทเงินได้พึงประเมินที่จ่าย</th><th class="c">วัน เดือน ปี ที่จ่าย</th><th class="r">จำนวนเงินที่จ่าย</th><th class="r">ภาษีที่หักและนำส่งไว้</th></tr></thead>
        <tbody>${rows}<tr class="pp-grand"><td colspan="2" class="r">รวมเงินที่จ่ายและภาษีที่หักนำส่ง</td><td class="r">${money(base)}</td><td class="r">${money(doc.wht)}</td></tr></tbody>
      </table>
      <div class="pp-baht">รวมเงินภาษีที่หักนำส่ง (ตัวอักษร) (${esc(bahtText(doc.wht))})</div>
      <div class="pp-wht-forms">ผู้จ่ายเงิน ${box(true)} (1) หัก ณ ที่จ่าย &nbsp; ${box(false)} (2) ออกให้ตลอดไป &nbsp; ${box(false)} (3) ออกให้ครั้งเดียว</div>
      <footer class="pp-sign pp-sign-one"><div>
        <div class="pp-small">ขอรับรองว่าข้อความและตัวเลขดังกล่าวข้างต้นถูกต้องตรงกับความจริงทุกประการ</div>
        <div class="pp-line"></div><div>(${esc(business.settings?.signer || '.................................................')})</div>
        <div class="pp-small">ผู้จ่ายเงิน · วันที่ ${esc(slashDate(doc.pay?.date))}</div></div></footer>
    </article>`;
  }

  g.Thai = {
    esc, money, qtyFmt, thDate, slashDate, thMonth, today, taxIdFmt, branchFmt, bahtText, computeTotals, WHT_RATES,
    docTitle, TYPE_NAME, TH_MONTHS, STATUS, statusName, PAY_METHOD, renderDoc, renderWht, TH_MONTHS_LONG,
  };
})(typeof window !== 'undefined' ? window : globalThis);
