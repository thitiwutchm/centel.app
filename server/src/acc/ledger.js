// Accounting rules with no database: the starting chart of accounts, document totals
// (VAT, discounts, withholding tax) and the double-entry lines each document posts.
// Money is worked in satang (integers) so every total adds up to the last satang.

// CN ใบลดหนี้ and DN ใบเพิ่มหนี้ are issued against a tax invoice (an IV or RE that is one).
export const DOC_TYPES = ['QT', 'IV', 'RE', 'EX', 'CN', 'DN'];
export const DEFAULT_PREFIX = { QT: 'QT', IV: 'IV', RE: 'RE', EX: 'EX', CN: 'CN', DN: 'DN', JV: 'JV', WHT: 'WT' };
export const WHT_RATES = [0, 1, 1.5, 2, 3, 5, 10, 15];

// A small chart for a Thai service / trading SME. `sys` marks the accounts the app posts to.
export const DEFAULT_ACCOUNTS = [
  ['11100', 'เงินสด', 'Cash', 'asset', 'cash'],
  ['11200', 'เงินฝากธนาคาร', 'Bank deposits', 'asset', 'bank'],
  ['11300', 'ลูกหนี้การค้า', 'Accounts receivable', 'asset', 'ar'],
  ['11400', 'สินค้าคงเหลือ', 'Inventory', 'asset', null],
  ['11500', 'ภาษีซื้อ', 'Input VAT', 'asset', 'vat_in'],
  ['11600', 'ภาษีเงินได้ถูกหัก ณ ที่จ่าย', 'Withholding tax deducted by customers', 'asset', 'wht_recv'],
  ['11900', 'เงินทดรองจ่ายและลูกหนี้อื่น', 'Advances and other receivables', 'asset', null],
  ['12100', 'อุปกรณ์และเครื่องใช้สำนักงาน', 'Office equipment', 'asset', null],
  ['12900', 'ค่าเสื่อมราคาสะสม', 'Accumulated depreciation', 'asset', null],
  ['21100', 'เจ้าหนี้การค้า', 'Accounts payable', 'liability', 'ap'],
  ['21200', 'ภาษีขาย', 'Output VAT', 'liability', 'vat_out'],
  ['21210', 'ภาษีขายยังไม่ถึงกำหนด', 'Output VAT not yet due', 'liability', 'vat_out_pending'],
  ['21300', 'ภาษีหัก ณ ที่จ่ายค้างนำส่ง', 'Withholding tax payable', 'liability', 'wht_pay'],
  ['21400', 'ภาษีมูลค่าเพิ่มค้างชำระ', 'VAT payable', 'liability', 'vat_payable'],
  ['21500', 'ค่าใช้จ่ายค้างจ่าย', 'Accrued expenses', 'liability', null],
  ['21600', 'เงินกู้ยืมจากกรรมการ', 'Loans from directors', 'liability', null],
  ['31100', 'ทุน', 'Capital', 'equity', 'capital'],
  ['32100', 'กำไร (ขาดทุน) สะสม', 'Retained earnings', 'equity', 'retained'],
  ['41100', 'รายได้จากการขาย', 'Sales', 'income', 'sales'],
  ['41200', 'รายได้จากการให้บริการ', 'Service income', 'income', 'service'],
  ['42100', 'รายได้อื่น', 'Other income', 'income', 'other_income'],
  ['42200', 'ดอกเบี้ยรับ', 'Interest income', 'income', null],
  ['51100', 'ต้นทุนขาย', 'Cost of sales', 'expense', 'cogs'],
  ['52100', 'เงินเดือนและค่าจ้าง', 'Salaries and wages', 'expense', null],
  ['52200', 'ค่าเช่า', 'Rent', 'expense', null],
  ['52300', 'ค่าน้ำ ค่าไฟ ค่าโทรศัพท์ อินเทอร์เน็ต', 'Utilities', 'expense', null],
  ['52400', 'วัสดุสิ้นเปลืองและเครื่องเขียน', 'Supplies', 'expense', null],
  ['52500', 'ค่าโฆษณาและการตลาด', 'Advertising and marketing', 'expense', null],
  ['52600', 'ค่าเดินทางและขนส่ง', 'Travel and transport', 'expense', null],
  ['52700', 'ค่าธรรมเนียมวิชาชีพ', 'Professional fees', 'expense', null],
  ['52800', 'ค่าจ้างบริการภายนอก', 'Contractors and outsourcing', 'expense', null],
  ['52900', 'ค่าซอฟต์แวร์และบริการออนไลน์', 'Software and online services', 'expense', null],
  ['53000', 'ค่าธรรมเนียมธนาคาร', 'Bank fees', 'expense', 'bank_fee'],
  ['53100', 'ค่าเสื่อมราคา', 'Depreciation', 'expense', null],
  ['53200', 'ค่ารับรอง', 'Entertainment', 'expense', null],
  ['53900', 'ค่าใช้จ่ายอื่น', 'Other expenses', 'expense', 'other_expense'],
].map(([code, name, name_en, type, sys]) => ({ code, name, name_en, type, sys }));

const cents = (v) => Math.round((Number(v) || 0) * 100);
const baht = (c) => Math.round(c) / 100;

// Splits `total` satang over `weights` in proportion, giving the rounding leftover to the
// biggest shares so the parts always add back up to `total`.
export function allocate(total, weights) {
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

// A line as stored: what the person typed, cleaned up.
export function cleanLine(l) {
  const s = (v, n) => (v == null || v === '' ? '' : String(v).slice(0, n));
  const qty = Number(l?.qty);
  const price = Number(l?.price);
  const wht = Number(l?.wht);
  return {
    itemId: typeof l?.itemId === 'string' && /^[0-9a-f-]{36}$/i.test(l.itemId) ? l.itemId : null,
    name: s(l?.name, 300),
    desc: s(l?.desc, 2000),
    qty: Number.isFinite(qty) ? Math.round(qty * 10000) / 10000 : 1,
    unit: s(l?.unit, 30),
    price: Number.isFinite(price) ? baht(cents(price)) : 0,
    disc: Math.max(0, baht(cents(l?.disc))),
    vat: l?.vat !== false,
    wht: WHT_RATES.includes(wht) ? wht : 0,
    account: typeof l?.account === 'string' && /^[0-9A-Za-z.-]{1,20}$/.test(l.account) ? l.account : null,
  };
}

// Totals for a document. priceMode 'excl' adds VAT on top of the prices; 'incl' means the
// prices already include it. vatRate 0 = no VAT (business not VAT registered).
// Returns baht amounts plus each line's pre-VAT amount (base) for posting and WHT.
export function computeTotals(rawLines, { discount = 0, priceMode = 'excl', vatRate = 0 } = {}) {
  const lines = rawLines.map(cleanLine);
  const gross = lines.map((l) => Math.round(l.qty * cents(l.price)) - cents(l.disc));
  const subtotal = gross.reduce((s, x) => s + x, 0);
  const disc = Math.max(0, Math.min(cents(discount), subtotal));
  const shares = allocate(disc, gross.map((g) => Math.max(g, 0)));
  const net = gross.map((g, i) => g - shares[i]);
  const rate = Number(vatRate) || 0;
  const vatIdx = lines.map((l, i) => (l.vat && rate > 0 ? i : -1)).filter((i) => i >= 0);
  const V = vatIdx.reduce((s, i) => s + net[i], 0);
  const N = net.reduce((s, x) => s + x, 0) - V;
  let vat;
  let base = net.slice();
  if (priceMode === 'incl') {
    vat = Math.round((V * rate) / (100 + rate));
    const parts = allocate(V - vat, vatIdx.map((i) => net[i]));
    vatIdx.forEach((i, k) => { base[i] = parts[k]; });
  } else {
    vat = Math.round((V * rate) / 100);
  }
  const vatBase = V - (priceMode === 'incl' ? vat : 0);
  const total = priceMode === 'incl' ? V + N : V + N + vat;
  const whtC = lines.reduce((s, l, i) => s + Math.round((base[i] * l.wht) / 100), 0);
  return {
    lines: lines.map((l, i) => ({ ...l, amount: baht(gross[i]), base: baht(base[i]) })),
    subtotal: baht(subtotal),
    discount: baht(disc),
    vat_base: baht(vatBase),
    exempt: baht(N),
    vat: baht(vat),
    total: baht(total),
    wht: baht(whtC),
  };
}

// Sums line bases per account; a line with no account goes to `fallback`.
function byAccount(lines, fallback) {
  const m = new Map();
  for (const l of lines) {
    const a = l.account || fallback;
    m.set(a, (m.get(a) || 0) + cents(l.base));
  }
  return m;
}

// The double-entry lines a document posts. `sys` maps roles (ar, vat_out …) to account
// codes; `ref` is the source document (the IV an RE was issued from). Returns
// [{ stage, account, debit, credit, memo }] that balance per stage ('doc' on the document
// date, 'pay' on the payment date of a paid expense), or [] for documents that post nothing.
export function postingsFor(doc, sys, ref = null) {
  if (doc.status === 'void' || doc.type === 'QT') return [];
  const out = [];
  let stage = 'doc';
  const dr = (account, c, memo = null) => {
    if (c > 0) out.push({ stage, account, debit: baht(c), credit: 0, memo });
    else if (c < 0) out.push({ stage, account, debit: 0, credit: baht(-c), memo });
  };
  const cr = (account, c, memo) => dr(account, -c, memo);
  const total = cents(doc.total);
  const vat = cents(doc.vat);
  const wht = cents(doc.wht);
  const need = (k) => { if (!sys[k]) throw Object.assign(new Error(`missing_account_${k}`), { status: 409, expose: true }); return sys[k]; };
  const revenue = () => { for (const [a, c] of byAccount(doc.lines, need('sales'))) cr(a, c); };

  if (doc.type === 'IV') {
    dr(need('ar'), total);
    revenue();
    cr(doc.tax_invoice ? need('vat_out') : need('vat_out_pending'), vat);
  } else if (doc.type === 'RE') {
    const fee = cents(doc.pay?.fee);
    const money = doc.pay?.account || need('cash');
    dr(money, total - wht - fee);
    dr(need('bank_fee'), fee);
    dr(need('wht_recv'), wht);
    if (ref && ref.type === 'IV' && ref.status !== 'void') {
      cr(need('ar'), total);
      // VAT moves to output VAT when the receipt is the tax invoice.
      if (doc.tax_invoice && !ref.tax_invoice && vat) { dr(need('vat_out_pending'), vat); cr(need('vat_out'), vat); }
    } else {
      revenue();
      cr(doc.tax_invoice ? need('vat_out') : need('vat_out_pending'), vat);
    }
  } else if (doc.type === 'EX') {
    for (const [a, c] of byAccount(doc.lines, need('other_expense'))) dr(a, c);
    dr(need('vat_in'), vat);
    cr(need('ap'), total);
    if (doc.status === 'paid') {
      stage = 'pay';
      const fee = cents(doc.pay?.fee);
      dr(need('ap'), total);
      dr(need('bank_fee'), fee);
      cr(doc.pay?.account || need('cash'), total - wht + fee);
      cr(need('wht_pay'), wht);
    }
  } else if (doc.type === 'CN' || doc.type === 'DN') {
    // A debit note books more sales like an invoice; a credit note takes sales and output VAT
    // back. The customer's balance moves on AR until the difference is received or refunded.
    const s = doc.type === 'CN' ? -1 : 1;
    dr(need('ar'), s * total);
    for (const [a, c] of byAccount(doc.lines, need('sales'))) cr(a, s * c);
    cr(need('vat_out'), s * vat);
    if (doc.pay) {
      stage = 'pay';
      dr(doc.pay.account || need('cash'), s * total);
      cr(need('ar'), s * total);
    }
  }
  // Merge same-account same-side lines so the journal stays short.
  const merged = [];
  for (const l of out) {
    const m = merged.find((x) => x.stage === l.stage && x.account === l.account && !!x.debit === !!l.debit && x.memo === l.memo);
    if (m) { m.debit = baht(cents(m.debit) + cents(l.debit)); m.credit = baht(cents(m.credit) + cents(l.credit)); } else merged.push({ ...l });
  }
  return merged;
}

export function balanced(lines) {
  const d = lines.reduce((s, l) => s + cents(l.debit), 0);
  const c = lines.reduce((s, l) => s + cents(l.credit), 0);
  return d === c && d > 0;
}

// QT2026110001: prefix, year and month of the document date, then a running number per month.
export const counterKey = (prefix, date) => `${prefix}${String(date).slice(0, 4)}${String(date).slice(5, 7)}`;
export const docNumber = (prefix, date, n) => `${counterKey(prefix, date)}${String(n).padStart(4, '0')}`;
