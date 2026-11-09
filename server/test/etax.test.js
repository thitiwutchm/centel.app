// e-Tax Invoice by Email helpers (account/etax.js): the subject line the Revenue Department
// requires and the email Gmail sends. Unit tests, no API.
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../account/etax.js');
const E = globalThis.Etax;

test('subject lines follow the RD Time Stamp manual', () => {
  // The manual's own examples (dates in BE, no spaces).
  assert.equal(E.subject({ type: 'IV', date: '2017-01-12', number: 'INV0001', tax_invoice: true }), '[12012560][INV][INV0001]');
  assert.equal(E.subject({ type: 'DN', date: '2017-01-18', number: 'INV0001IND' }, { number: 'INV0001' }), '[18012560][DBN][INV0001IND][INV0001]');
  assert.equal(E.subject({ type: 'CN', date: '2017-01-18', number: 'INV0001INC' }, { number: 'INV0001' }), '[18012560][CRN][INV0001INC][INV0001]');
  assert.equal(E.subject({ type: 'RE', date: '2017-01-18', number: 'INV0004INC', adjust: { replaces: { number: 'INV0001INC' } } }), '[18012560][INV][INV0004INC][INV0001INC]');
});

test('only live tax invoices, credit and debit notes can be sent', () => {
  assert.equal(E.canSend({ type: 'RE', tax_invoice: true, status: 'done' }), true);
  assert.equal(E.canSend({ type: 'IV', tax_invoice: false, status: 'open' }), false);
  assert.equal(E.canSend({ type: 'CN', status: 'open' }), true);
  assert.equal(E.canSend({ type: 'RE', tax_invoice: true, status: 'void' }), false);
  assert.equal(E.canSend({ type: 'QT', status: 'open' }), false);
});

test('the email has one To, the ETDA CC, the subject and one PDF', () => {
  const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
  const m = E.mime({ from: 'billing@example.co.th', fromName: 'บริษัท ทดสอบ จำกัด', to: 'ap@buyer.co.th', subject: '[09112569][INV][RE2026110001]', text: 'เรียน ลูกค้า', filename: 'RE2026110001.pdf', pdf });
  assert.match(m, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <billing@example\.co\.th>\r\n/);
  assert.match(m, /\r\nTo: ap@buyer\.co\.th\r\n/);
  assert.match(m, /\r\nCc: csemail@etax\.teda\.th\r\n/);
  assert.match(m, /\r\nSubject: \[09112569\]\[INV\]\[RE2026110001\]\r\n/);
  assert.equal((m.match(/Content-Type: application\/pdf/g) || []).length, 1);
  assert.ok(m.includes(Buffer.from(pdf).toString('base64')));
  assert.ok(/^[\x00-\x7f]*$/.test(m), 'the raw message is ASCII');
  const raw = E.rawMessage(m);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(raw));
  assert.equal(Buffer.from(raw, 'base64url').toString('latin1'), m);
});
