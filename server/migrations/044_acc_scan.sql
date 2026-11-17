-- Scanned purchase bills: the heading printed on the vendor's document (หัวเอกสาร, e.g.
-- ใบกำกับภาษี/ใบเสร็จรับเงิน) and an optional project the expense belongs to.
alter table acc_docs add column if not exists ref_title text;
alter table acc_docs add column if not exists project text;
