-- Centel Account, round two: signature and company stamp images for documents, and
-- products that count stock (with a picture, barcode, cost and opening quantity).

alter table acc_businesses add column if not exists signature text;   -- data:image/png;base64,… (transparent PNG)
alter table acc_businesses add column if not exists stamp text;

alter table acc_items drop constraint if exists acc_items_kind_check;
alter table acc_items add constraint acc_items_kind_check check (kind in ('service', 'product', 'stock'));
alter table acc_items add column if not exists barcode text;
alter table acc_items add column if not exists image text;             -- small data URL
alter table acc_items add column if not exists cost numeric(14,2) not null default 0;
alter table acc_items add column if not exists stock_open numeric(14,4) not null default 0;
alter table acc_items add column if not exists category text;
