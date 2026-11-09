// Accounting rules: document totals, VAT, WHT and the journal lines each document posts. Unit tests, no API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, postingsFor, balanced, allocate, docNumber, DEFAULT_ACCOUNTS } from '../src/acc/ledger.js';
import { fiscalStart } from '../src/acc/reports.js';

const sys = Object.fromEntries(DEFAULT_ACCOUNTS.filter((a) => a.sys).map((a) => [a.sys, a.code]));
const sum = (ls, k) => Math.round(ls.reduce((s, l) => s + l[k] * 100, 0)) / 100;

test('allocate keeps the parts adding up', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(allocate(1001, [3, 7, 11]).reduce((s, x) => s + x, 0), 1001);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
});

test('VAT on top, with a document discount and 3% WHT', () => {
  const t = computeTotals([
    { name: 'ออกแบบ', qty: 1, price: 10000, wht: 3 },
    { name: 'โฮสติ้ง', qty: 12, price: 250 },
  ], { discount: 1000, priceMode: 'excl', vatRate: 7 });
  assert.equal(t.subtotal, 13000);
  assert.equal(t.discount, 1000);
  assert.equal(t.vat_base, 12000);
  assert.equal(t.vat, 840);
  assert.equal(t.total, 12840);
  // The 10,000 line carries 10/13 of the discount: 9,230.77 base → WHT 276.92.
  assert.equal(t.lines[0].base, 9230.77);
  assert.equal(t.wht, 276.92);
});

test('prices including VAT split back into base and VAT', () => {
  const t = computeTotals([{ name: 'ของ', qty: 1, price: 1070 }], { priceMode: 'incl', vatRate: 7 });
  assert.equal(t.vat, 70);
  assert.equal(t.vat_base, 1000);
  assert.equal(t.total, 1070);
  assert.equal(t.lines[0].base, 1000);
});

test('VAT-exempt lines and a business without VAT', () => {
  const t = computeTotals([{ name: 'a', qty: 1, price: 100 }, { name: 'b', qty: 1, price: 50, vat: false }], { vatRate: 7 });
  assert.equal(t.vat, 7);
  assert.equal(t.exempt, 50);
  assert.equal(t.total, 157);
  const n = computeTotals([{ name: 'a', qty: 2, price: 99.99 }], { vatRate: 0 });
  assert.equal(n.vat, 0);
  assert.equal(n.total, 199.98);
});

const iv = (over = {}) => {
  const t = computeTotals([{ name: 'งาน', qty: 1, price: 10000, wht: 3, account: '41200' }], { vatRate: 7 });
  return { type: 'IV', status: 'open', tax_invoice: false, ...t, ...over };
};

test('invoice: receivable against income and VAT not yet due', () => {
  const p = postingsFor(iv(), sys);
  assert.ok(balanced(p));
  assert.deepEqual(p.map((l) => [l.account, l.debit, l.credit]), [['11300', 10700, 0], ['41200', 0, 10000], ['21210', 0, 700]]);
  const ti = postingsFor(iv({ tax_invoice: true }), sys);
  assert.equal(ti.find((l) => l.account === '21200').credit, 700);
});

test('receipt for an invoice: bank, WHT deducted, VAT becomes due', () => {
  const ref = iv();
  const re = { ...iv(), type: 'RE', status: 'done', tax_invoice: true, pay: { account: '11200', fee: 10 } };
  const p = postingsFor(re, sys, ref);
  assert.ok(balanced(p));
  const get = (a, k) => sum(p.filter((l) => l.account === a), k);
  assert.equal(get('11200', 'debit'), 10700 - 300 - 10);
  assert.equal(get('53000', 'debit'), 10);
  assert.equal(get('11600', 'debit'), 300);
  assert.equal(get('11300', 'credit'), 10700);
  assert.equal(get('21210', 'debit'), 700);
  assert.equal(get('21200', 'credit'), 700);
});

test('cash sale receipt posts income straight away', () => {
  const p = postingsFor({ ...iv(), type: 'RE', tax_invoice: true, wht: 0, pay: { account: '11100' } }, sys);
  assert.ok(balanced(p));
  assert.deepEqual(p.map((l) => l.account).sort(), ['11100', '21200', '41200']);
});

test('expense: cost and input VAT to payables, then paid with WHT held back', () => {
  const t = computeTotals([{ name: 'ค่าจ้าง', qty: 1, price: 20000, wht: 3, account: '52800' }], { vatRate: 7 });
  const ex = { type: 'EX', status: 'open', tax_invoice: true, ...t };
  const open = postingsFor(ex, sys);
  assert.ok(balanced(open));
  assert.equal(open.length, 3);
  const paid = postingsFor({ ...ex, status: 'paid', pay: { account: '11200', fee: 0 } }, sys);
  const pay = paid.filter((l) => l.stage === 'pay');
  assert.ok(balanced(pay));
  assert.equal(sum(pay.filter((l) => l.account === '11200'), 'credit'), 21400 - 600);
  assert.equal(sum(pay.filter((l) => l.account === '21300'), 'credit'), 600);
});

test('void and quotation documents post nothing', () => {
  assert.deepEqual(postingsFor(iv({ status: 'void' }), sys), []);
  assert.deepEqual(postingsFor(iv({ type: 'QT' }), sys), []);
});

test('numbers and fiscal years', () => {
  assert.equal(docNumber('IV', '2026-11-09', 7), 'IV2026110007');
  assert.equal(fiscalStart('2026-11-09', 1), '2026-01-01');
  assert.equal(fiscalStart('2026-03-09', 10), '2025-10-01');
});

test('credit and debit notes move sales, output VAT and the customer balance', () => {
  const lines = computeTotals([{ name: 'ส่วนลดหลังขาย', qty: 1, price: 1000, account: '41200' }], { vatRate: 7 }).lines;
  const base = { lines, total: 1070, vat: 70, wht: 0, status: 'open' };
  const cn = postingsFor({ ...base, type: 'CN' }, sys);
  assert.ok(balanced(cn));
  assert.deepEqual(cn.map((l) => [l.account, l.debit, l.credit]), [[sys.ar, 0, 1070], ['41200', 1000, 0], [sys.vat_out, 70, 0]]);
  const dn = postingsFor({ ...base, type: 'DN' }, sys);
  assert.deepEqual(dn.map((l) => [l.account, l.debit, l.credit]), [[sys.ar, 1070, 0], ['41200', 0, 1000], [sys.vat_out, 0, 70]]);
  // Refunding the credit note clears the customer balance through the bank.
  const paid = postingsFor({ ...base, type: 'CN', status: 'done', pay: { account: sys.bank, date: '2026-11-10' } }, sys);
  const pay = paid.filter((l) => l.stage === 'pay');
  assert.ok(balanced(pay));
  assert.deepEqual(pay.map((l) => [l.account, l.debit, l.credit]), [[sys.bank, 0, 1070], [sys.ar, 1070, 0]]);
  assert.deepEqual(postingsFor({ ...base, type: 'CN', status: 'void' }, sys), []);
});
