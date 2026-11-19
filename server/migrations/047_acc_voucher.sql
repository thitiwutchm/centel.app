-- ใบสำคัญจ่าย (payment voucher) details on expense documents, 2026-11-19: who prepared, approved and
-- received the payment, the payee's ID number (for ใบรับรองแทนใบเสร็จรับเงิน) and which form prints by default.
alter table acc_docs add column if not exists voucher jsonb;
