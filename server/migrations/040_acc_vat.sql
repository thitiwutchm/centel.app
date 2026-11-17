-- Centel Account: VAT management (2026-11-13), like FlowAccount's บริหารภาษีมูลค่าเพิ่ม.
--   vat_status (EX only): wait = รอใบกำกับภาษี, got = ได้รับใบกำกับภาษีแล้ว (null on a tax invoice
--              means got, so older expenses keep counting), pp36 = บริการจากต่างประเทศ, VAT paid
--              by the business itself on ภ.พ.36.
--   vat_month: the tax month the input VAT is claimed in (รอใช้สิทธิ์). Null = the document's month.
--              Thai law lets input VAT be claimed up to six months after the tax invoice month.
alter table acc_docs add column if not exists vat_status text check (vat_status in ('wait', 'got', 'pp36'));
alter table acc_docs add column if not exists vat_month text check (vat_month ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- เตรียมแบบภาษีรายเดือน: one ภ.พ.30 / ภ.พ.36 per business per month. data holds the figures
-- worked out from the documents when the return was made or refreshed; a filed return is frozen.
create table if not exists acc_vat_returns (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references acc_businesses on delete cascade,
  form        text not null check (form in ('PP30', 'PP36')),
  month       text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status      text not null default 'draft' check (status in ('draft', 'filed')),
  data        jsonb not null default '{}',
  filed_at    date,
  filed_ref   text,
  created_by  uuid references users on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (business_id, form, month)
);

grant select, insert, update, delete on acc_vat_returns to app_user;
alter table acc_vat_returns enable row level security;
create policy member on acc_vat_returns for all to app_user using (acc_can(business_id)) with check (acc_can(business_id));
