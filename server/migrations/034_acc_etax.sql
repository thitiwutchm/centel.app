-- Centel Account, e-Tax Invoice by Email (Time Stamp, Revenue Department + ETDA) and
-- credit / debit notes (ใบลดหนี้ CN, ใบเพิ่มหนี้ DN) issued against a tax invoice.

alter table acc_docs drop constraint if exists acc_docs_type_check;
alter table acc_docs add constraint acc_docs_type_check check (type in ('QT', 'IV', 'RE', 'EX', 'CN', 'DN'));

-- CN / DN: { reason, orig } (orig = value before VAT on the original tax invoice).
-- IV / RE issued to replace a cancelled tax invoice: { replaces: { id, number, date }, reason }.
alter table acc_docs add column if not exists adjust jsonb;

-- Every time the document was sent as an e-Tax Invoice by Email:
-- { sent: [{ at, to, subject, method: 'gmail' | 'manual', message_id, by }] }.
-- A document that has been sent can no longer be edited, only cancelled and replaced.
alter table acc_docs add column if not exists etax jsonb;
