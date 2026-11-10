// หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) on the Revenue Department's own form.
// forms/50tawi.pdf is the official form (fillable fields and the "Clear Data" button removed);
// we only write the entries onto it. Positions are PDF points measured from that file
// (x from the left, y = text baseline from the bottom, A4 = 595.3 × 841.9).
// Text is drawn on a canvas, so the browser shapes the Thai, then laid over the vector form with pdf-lib.
(function (g) {
  'use strict';
  const T = () => g.Thai;
  const W = 595.3, H = 841.9;
  const FONT = 'Sarabun';
  const INK = '#0b1b3f';

  // 13-digit ID boxes (เลขประจำตัวประชาชน) and 10-digit boxes (เลขประจำตัวผู้เสียภาษีอากร), box centres.
  const ID13 = [380.7, 398.65, 410.6, 422.75, 434.8, 453.5, 465.25, 476.9, 488.9, 501.25, 519.45, 531.55, 550.8];
  const ID10 = [424.8, 442.95, 455.1, 467.1, 478.95, 496.95, 509.1, 521.1, 532.95, 550.8];
  const PARTY = {
    payer: { id13: 747.6, id10: 731.8, dx: 0, name: 731.0, addr: 706.3 },
    payee: { id13: 676.4, id10: 656.9, dx: 0.6, name: 655.4, addr: 627.8 },
  };
  // Checkbox centres.
  const BOX = { pnd3: [477.6, 601.5], pnd53: [401.0, 583.5], whtAtSource: [88.25, 98.0] };
  // Income rows: baseline of the amounts (just above each row's dotted line).
  const ROW = { r1: 523.9, r2: 508.8, r3: 493.9, r4a: 478.8, r5: 193.9, r6: 178.8, total: 156.6 };
  // Columns: date centre, baht right edge | satang centre for amount paid and tax withheld.
  const COL = { date: 366.7, amt: 472.6, amtSt: 482.55, tax: 543.9, taxSt: 553.6 };
  // Words in item 5 that get underlined for the kind of income: [x0, x1, baseline] per segment.
  const ITEM5 = {
    'ค่าบริการ': [[180.6, 212.8, 191.0]],
    'ค่าจ้างทำของ': [[299.9, 321.3, 206.0], [53.2, 76.2, 191.0]],
    'ค่าเช่า': [[122.3, 142.7, 191.0]],
    'ค่าโฆษณา': [[81.3, 117.3, 191.0]],
    'ค่าขนส่ง': [[147.8, 175.8, 191.0]],
    'ค่ารางวัล': [[95.4, 114.4, 221.0], [302.1, 321.0, 221.0]],
    'ค่าเบี้ยประกันวินาศภัย': [[217.4, 295.4, 191.0]],
  };
  // Which line of the form an income kind goes on.
  const rowFor = (income) => (income === 'ค่านายหน้า' ? 'r2' : income === 'ดอกเบี้ย' ? 'r4a' : income === 'เงินปันผล' || income === 'อื่น ๆ' ? 'r6' : 'r5');
  // "ฉบับที่ 1 / 2" lines at the top: underline the one this copy is.
  const COPY = { 1: [20.2, 268.3, 816.7], 2: [20.2, 216.0, 802.3] };

  const digits = (s) => String(s || '').replace(/\D/g, '');
  const splitMoney = (v) => {
    const c = Math.round((Number(v) || 0) * 100);
    return [Math.floor(c / 100).toLocaleString('en-US'), String(c % 100).padStart(2, '0')];
  };

  // ภ.ง.ด.53 for a juristic person (13-digit tax ID starting with 0), ภ.ง.ด.3 for a person.
  function formFor(contact) {
    const id = digits(contact && contact.tax_id);
    if (id.length === 13) return id[0] === '0' ? 'pnd53' : 'pnd3';
    return contact && contact.is_company === false ? 'pnd3' : 'pnd53';
  }

  // Everything that goes on the form, from a paid expense with WHT.
  function certData(doc, business) {
    const c = doc.wht_cert || {};
    const lines = (doc.lines || []).filter((l) => Number(l.wht) > 0);
    const base = Math.round(lines.reduce((s, l) => s + Number(l.base || 0), 0) * 100) / 100;
    const date = (doc.pay && doc.pay.date) || doc.date;
    const [y, m, d] = String(date || '').slice(0, 10).split('-').map(Number);
    const income = c.income || 'ค่าบริการ';
    const withBranch = (p) => {
      const br = T().branchFmt(p.branch);
      return br && digits(p.tax_id)[0] === '0' ? `${p.name || ''} (${br})` : (p.name || '');
    };
    const ct = doc.contact || {};
    return {
      book: c.book || (business.settings && business.settings.whtBook) || (y ? String(y + 543) : ''),
      number: c.number || '',
      payer: { name: withBranch(business), address: business.address || '', id: digits(business.tax_id) },
      payee: { name: withBranch(ct), address: ct.address || '', id: digits(ct.tax_id) },
      form: c.form === 'pnd3' || c.form === 'pnd53' ? c.form : formFor(ct),
      income, row: rowFor(income),
      spec: income === 'อื่น ๆ' ? (lines[0] && (lines[0].name || lines[0].desc)) || '' : income === 'เงินปันผล' ? 'เงินปันผล' : '',
      date: T().slashDate(date), base, tax: Number(doc.wht) || 0,
      words: T().bahtText(doc.wht),
      day: d ? String(d) : '', month: m ? T().TH_MONTHS_LONG[m - 1] : '', year: y ? String(y + 543) : '',
      signer: (business.settings && business.settings.signer) || '',
    };
  }

  /* ---------- drawing (ctx in PDF points, y measured from the bottom) ---------- */

  function text(ctx, s, x, y, { size = 10.5, align = 'left', max = 0, weight = 400 } = {}) {
    s = String(s || '');
    if (!s) return;
    let z = size;
    ctx.font = `${weight} ${z}px ${FONT}`;
    while (max && z > 5.5 && ctx.measureText(s).width > max) { z -= 0.25; ctx.font = `${weight} ${z}px ${FONT}`; }
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, H - y);
  }
  function line(ctx, x0, x1, y, w = 0.7) {
    ctx.beginPath(); ctx.lineWidth = w; ctx.moveTo(x0, H - y); ctx.lineTo(x1, H - y); ctx.stroke();
  }
  function tick(ctx, [cx, cy]) {
    ctx.beginPath(); ctx.lineWidth = 1.3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.moveTo(cx - 3.6, H - cy); ctx.lineTo(cx - 0.9, H - cy + 3.2); ctx.lineTo(cx + 4.4, H - cy - 4.6);
    ctx.stroke();
  }
  function boxes(ctx, id, y, dx) {
    const cells = id.length === 13 ? ID13 : id.length === 10 ? ID10 : null;
    if (!cells) return false;
    cells.forEach((cx, i) => text(ctx, id[i], cx + dx, y, { size: 10.5, align: 'center' }));
    return true;
  }
  const loadImg = (src) => new Promise((ok) => {
    if (!src) return ok(null);
    const i = new Image();
    i.onload = () => ok(i); i.onerror = () => ok(null);
    i.src = src;
  });
  function fitImg(ctx, img, cx, cy, w, h) {
    const k = Math.min(w / img.width, h / img.height);
    const iw = img.width * k, ih = img.height * k;
    ctx.drawImage(img, cx - iw / 2, H - cy - ih / 2, iw, ih);
  }

  // Draws the entries for one copy (1 or 2) onto ctx, already scaled to points.
  async function drawEntries(ctx, D, o) {
    const [sig, stamp] = await Promise.all([loadImg(o.sign && o.signature), loadImg(o.sign && o.stamp)]);
    if (document.fonts && document.fonts.load) await Promise.all([document.fonts.load(`400 12px ${FONT}`, 'ก'), document.fonts.load(`500 12px ${FONT}`, 'ก')]);
    ctx.fillStyle = INK; ctx.strokeStyle = INK;
    const cp = COPY[o.copy];
    if (cp) line(ctx, cp[0], cp[1], cp[2] - 2, 0.8);
    text(ctx, D.book, 538, 782.6, { align: 'center', max: 42 });
    text(ctx, D.number, 517, 768.2, { size: 9.5, max: 50 });
    for (const k of ['payer', 'payee']) {
      const p = D[k], P = PARTY[k];
      if (!boxes(ctx, p.id, p.id.length === 10 ? P.id10 : P.id13, P.dx)) text(ctx, T().taxIdFmt(p.id), 375, P.id13, { max: 180 });
      text(ctx, p.name, 57, P.name, { size: 11, weight: 500, max: 258 });
      text(ctx, p.address, 63, P.addr, { size: 10.5, max: 492 });
    }
    tick(ctx, BOX[D.form]);
    // Income row + totals.
    const y = ROW[D.row];
    const [ab, as] = splitMoney(D.base), [tb, ts] = splitMoney(D.tax);
    text(ctx, D.date, COL.date, y, { size: 10, align: 'center', max: 74 });
    for (const yy of [y, ROW.total]) {
      text(ctx, ab, COL.amt, yy, { size: 10.5, align: 'right', max: 66 });
      text(ctx, as, COL.amtSt, yy, { size: 10.5, align: 'center' });
      text(ctx, tb, COL.tax, yy, { size: 10.5, align: 'right', max: 52 });
      text(ctx, ts, COL.taxSt, yy, { size: 10.5, align: 'center' });
    }
    if (D.row === 'r5') for (const [x0, x1, b] of ITEM5[D.income] || []) line(ctx, x0, x1, b - 1.6, 0.9);
    if (D.row === 'r6' && D.spec) text(ctx, D.spec, 98, ROW.r6, { size: 10, max: 225 });
    text(ctx, `(${D.words})`, 338, 136.6, { size: 11, weight: 500, align: 'center', max: 310 });
    tick(ctx, BOX.whtAtSource);
    // Signer, date, signature and stamp.
    text(ctx, D.signer, 406, 60.0, { size: 11, align: 'center', max: 145 });
    if (sig) fitImg(ctx, sig, 406, 66, 110, 26);
    text(ctx, D.day, 340.4, 44.6, { size: 10.5, align: 'center' });
    text(ctx, D.month, 398, 44.6, { size: 10.5, align: 'center' });
    text(ctx, D.year, 455.6, 44.6, { size: 10.5, align: 'center' });
    if (stamp) fitImg(ctx, stamp, 537, 48, 54, 54);
  }

  // A canvas (scale px per point) with the entries, optionally on top of the blank form picture.
  async function canvas(doc, business, o = {}) {
    const k = o.scale || 300 / 72;
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * k); cv.height = Math.round(H * k);
    const ctx = cv.getContext('2d');
    if (o.background) {
      const bg = await loadImg(o.background);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      if (bg) ctx.drawImage(bg, 0, 0, cv.width, cv.height);
    }
    ctx.scale(k, k);
    await drawEntries(ctx, certData(doc, business), { ...o, signature: business.signature, stamp: business.stamp });
    return cv;
  }

  let libP;
  const loadLib = () => {
    if (g.PDFLib) return Promise.resolve(g.PDFLib);
    libP = libP || new Promise((ok, no) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
      sc.onload = () => ok(g.PDFLib);
      sc.onerror = () => { libP = null; no(new Error('โหลดตัวสร้าง PDF ไม่สำเร็จ')); };
      document.head.appendChild(sc);
    });
    return libP;
  };

  // The filled official form as a PDF Blob. copies: [1, 2] → ฉบับที่ 1 and ฉบับที่ 2 pages.
  async function pdf(doc, business, o = {}) {
    const [lib, tpl] = await Promise.all([loadLib(), fetch(o.formUrl || 'forms/50tawi.pdf').then((r) => {
      if (!r.ok) throw new Error('โหลดแบบฟอร์ม 50 ทวิ ไม่สำเร็จ');
      return r.arrayBuffer();
    })]);
    const src = await lib.PDFDocument.load(tpl);
    const out = await lib.PDFDocument.create();
    out.setTitle(`หนังสือรับรองการหักภาษี ณ ที่จ่าย ${(doc.wht_cert && doc.wht_cert.number) || ''}`.trim());
    for (const copy of o.copies || [1, 2]) {
      const [page] = await out.copyPages(src, [0]);
      out.addPage(page);
      const cv = await canvas(doc, business, { ...o, copy });
      const png = await out.embedPng(await new Promise((ok) => cv.toBlob((b) => b.arrayBuffer().then(ok), 'image/png')));
      page.drawImage(png, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  g.Wht50 = { certData, formFor, canvas, pdf, W, H };
})(typeof window !== 'undefined' ? window : globalThis);
