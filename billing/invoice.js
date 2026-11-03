'use strict';

/* The page a client opens from the owner's link, no sign-in:
   ?i=<token>  one invoice, printable (Save as PDF from the print dialog)
   ?c=<token>  the client's account: what is still owed and every invoice issued */

const doc = document.getElementById('doc');
const q = new URLSearchParams(location.search);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n, cur = 'THB') => `${Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === 'THB' ? 'บาท' : cur}`;
const dateTH = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '–');
const STATE = { issued: ['รอชำระ', 'info'], partial: ['ชำระบางส่วน', 'warn'], overdue: ['เลยกำหนดชำระ', 'bad'], paid: ['ชำระแล้ว', 'ok'], void: ['ยกเลิก', ''] };
const chip = (s) => { const [t, c] = STATE[s] || [s, '']; return `<span class="chip ${c}">${t}</span>`; };

const party = (title, p) => `<div class="party"><div class="small muted">${title}</div><b>${esc(p.name)}</b>
  <div>${[p.address, p.taxId && `เลขประจำตัวผู้เสียภาษี ${p.taxId}`, [p.phone, p.email].filter(Boolean).join(' · ')].filter(Boolean).map(esc).join('\n')}</div></div>`;

function invoicePage({ seller, buyer, invoice: i }) {
  document.title = `ใบแจ้งหนี้ ${i.number}`;
  const cur = i.currency;
  doc.innerHTML = `
    <div class="doc-actions"><button class="btn plain small" onclick="window.print()">🖨️ พิมพ์ / บันทึก PDF</button></div>
    <div class="paper">
      <div class="paper-head">
        <div><h1>ใบแจ้งหนี้</h1><div class="muted">INVOICE</div></div>
        <div style="text-align:right"><div><b class="num">${esc(i.number)}</b></div>${chip(i.state)}
          <div class="small">วันที่ ${dateTH(i.issueDate)}</div><div class="small">ครบกำหนดชำระ <b>${dateTH(i.dueDate)}</b></div></div>
      </div>
      <div class="parties">${party('ผู้ออกใบแจ้งหนี้', seller)}${party('ลูกค้า', buyer)}</div>
      ${i.periodStart ? `<p class="small muted">รอบบริการ ${dateTH(i.periodStart)}${i.periodEnd ? ` – ${dateTH(i.periodEnd)}` : ''}</p>` : ''}
      <table class="items"><thead><tr><th class="hide-sm">#</th><th>รายละเอียด</th><th class="r hide-sm">จำนวน</th><th class="r hide-sm">ราคา/หน่วย</th><th class="r">จำนวนเงิน (${cur === 'THB' ? 'บาท' : esc(cur)})</th></tr></thead>
        <tbody>${i.items.map((x, n) => `<tr><td class="hide-sm">${n + 1}</td><td class="desc">${esc(x.description)}<div class="small muted show-sm num">${x.qty} × ${num(x.unitPrice)}</div></td><td class="r num hide-sm">${x.qty}</td><td class="r num hide-sm">${num(x.unitPrice)}</td><td class="r num">${num(x.qty * x.unitPrice)}</td></tr>`).join('')}</tbody></table>
      <div class="totals num">
        <div><span>รวมเป็นเงิน</span><span>${fmt(i.subtotal, cur)}</span></div>
        ${i.vatRate ? `<div><span>ภาษีมูลค่าเพิ่ม ${i.vatRate}%</span><span>${fmt(i.vat, cur)}</span></div>` : ''}
        ${i.whtRate ? `<div><span>หัก ณ ที่จ่าย ${i.whtRate}%</span><span>−${fmt(i.wht, cur)}</span></div>` : ''}
        <div class="grand"><span>ยอดที่ต้องชำระ</span><span>${fmt(i.total, cur)}</span></div>
        ${i.paidAmount ? `<div><span>ชำระแล้ว</span><span>${fmt(i.paidAmount, cur)}</span></div><div><b>คงเหลือ</b><b>${fmt(i.balance, cur)}</b></div>` : ''}
      </div>
      ${seller.bankInfo && i.status === 'issued' ? `<div class="card" style="margin-top:18px"><b>ช่องทางชำระเงิน</b><div style="white-space:pre-line">${esc(seller.bankInfo)}</div></div>` : ''}
      ${i.note ? `<p style="white-space:pre-line">${esc(i.note)}</p>` : ''}
      ${i.payments && i.payments.length ? `<p class="small muted">รับชำระ: ${i.payments.map((p) => `${dateTH(p.paidOn)} ${fmt(p.amount, cur)}`).join(' · ')}</p>` : ''}
      ${seller.footerNote ? `<p class="small muted" style="white-space:pre-line;margin-top:18px">${esc(seller.footerNote)}</p>` : ''}
    </div>`;
}

function accountPage({ seller, buyer, status: s, invoices }) {
  document.title = `บิลของ ${buyer.name}`;
  doc.innerHTML = `
    <div class="paper">
      <div class="small muted">${esc(seller.name)}</div>
      <h1 style="margin:2px 0 4px;font-size:22px">${esc(buyer.name)}</h1>
      <div class="balance num">${s.paidUp ? '<span style="color:var(--ok)">ชำระครบแล้ว ✓</span>' : fmt(s.outstanding)}</div>
      <div class="small muted">${s.paidUp ? 'ไม่มียอดค้างชำระ' : `ค้างชำระ ${s.openCount} ใบ${s.overdueCount ? ` · <b style="color:var(--bad)">เลยกำหนด ${s.overdueCount} ใบ</b>` : ''}${s.nextDue ? ` · ครบกำหนดถัดไป ${dateTH(s.nextDue)}` : ''}`}</div>
      ${seller.bankInfo && !s.paidUp ? `<div class="card" style="margin-top:14px"><b>ช่องทางชำระเงิน</b><div style="white-space:pre-line">${esc(seller.bankInfo)}</div></div>` : ''}
    </div>
    <div class="section-title"><span>ใบแจ้งหนี้</span></div>
    <div class="list">${invoices.length ? invoices.map((i) => `
      <a class="row" href="?i=${encodeURIComponent(i.publicToken)}">
        <div class="main"><b>${esc(i.number)}</b><div class="sub">${dateTH(i.issueDate)} · ครบ ${dateTH(i.dueDate)}</div></div>
        <div class="end"><div class="amt num">${fmt(i.status === 'issued' ? i.balance : i.total, i.currency)}</div>${chip(i.state)}</div>
      </a>`).join('') : '<div class="empty">ยังไม่มีใบแจ้งหนี้</div>'}</div>`;
}

(async () => {
  const i = q.get('i'), c = q.get('c');
  const path = i ? `/invoice/${encodeURIComponent(i)}` : c ? `/client/${encodeURIComponent(c)}` : null;
  try {
    if (!path) throw new Error('missing');
    const res = await fetch('/api/billing/public' + path);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (i) invoicePage(data); else accountPage(data);
  } catch (e) {
    doc.innerHTML = '<div class="gate"><h2>ไม่พบใบแจ้งหนี้</h2><p class="muted">ลิงก์อาจหมดอายุหรือถูกเปลี่ยน ติดต่อผู้ออกใบแจ้งหนี้เพื่อขอลิงก์ใหม่</p></div>';
  }
})();
