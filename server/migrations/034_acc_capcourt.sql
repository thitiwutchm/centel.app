-- Centel Account ↔ CapCourt Admin (2026-11-10). A business (CapCourt) connects its CapCourt
-- billing key; every hour the api pulls CapCourt's monthly venue bills and issues each one as
-- an invoice (IV) here, then reports the invoice number, its customer link and, once a
-- receipt (ใบเสร็จ/ใบกำกับภาษี) is issued, the payment back to CapCourt.

create table acc_integrations (
  business_id uuid not null references acc_businesses on delete cascade,
  kind        text not null check (kind in ('capcourt')),
  base_url    text not null,
  api_key     text not null,                  -- never sent to the browser; only its last 4 characters
  settings    jsonb not null default '{}',    -- itemMap, venueMap, venues (last seen)
  user_id     uuid not null references users on delete cascade,  -- the background sync runs as this person
  enabled     boolean not null default true,
  last_sync_at timestamptz,
  last_error  text,
  created_at  timestamptz not null default now(),
  primary key (business_id, kind)
);
grant select, insert, update, delete on acc_integrations to app_user;
alter table acc_integrations enable row level security;
create policy member on acc_integrations for all to app_user using (acc_can(business_id)) with check (acc_can(business_id));

-- Where a document came from: ext_source 'capcourt', ext_id = CapCourt invoice id, ext_no = CC-YYYYMM-NNNN.
-- ext_reported is the last state told to the source ('issued' or 'paid:<receipt number>').
alter table acc_docs add column if not exists ext_source text;
alter table acc_docs add column if not exists ext_id text;
alter table acc_docs add column if not exists ext_no text;
alter table acc_docs add column if not exists ext_reported text;
create unique index if not exists acc_docs_ext on acc_docs (business_id, ext_source, ext_id) where ext_id is not null;
