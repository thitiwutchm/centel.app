-- Accounting (account.centel.app, 2026-11-09): Thai SME bookkeeping. A person can keep the
-- books of several businesses. Every row carries business_id and the row level security
-- policies let a person reach only the businesses they are a member of (acc_members),
-- so a business can later be shared with an accountant or a partner.
--
-- Sales and purchase documents live in acc_docs; each document that moves money posts
-- double-entry lines to the journal (acc_entries + acc_lines), rebuilt whenever the
-- document changes. Reports read the journal.

create table acc_businesses (
  id             uuid primary key default gen_random_uuid(),
  created_by     uuid not null references users on delete cascade,
  name           text not null,
  name_en        text,
  tax_id         text,
  branch         text not null default '00000',      -- 00000 = สำนักงานใหญ่
  address        text,
  phone          text,
  email          text,
  website        text,
  logo           text,                                -- small data: URL
  vat_registered boolean not null default false,
  settings       jsonb not null default '{}',         -- prefixes, payment info, notes, signer
  created_at     timestamptz not null default now()
);

create table acc_members (
  business_id uuid not null references acc_businesses on delete cascade,
  user_id     uuid not null references users on delete cascade,
  role        text not null default 'owner' check (role in ('owner', 'editor', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index acc_members_user on acc_members (user_id);

-- Security definer so the policies can read membership without recursing into RLS.
create function acc_can(b uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from acc_members where business_id = b and user_id = app_uid()) $$;

-- A new business and its owner membership in one step (app_user cannot add members itself).
create function acc_new_business(p_name text) returns uuid language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  if app_uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  insert into acc_businesses (created_by, name) values (app_uid(), p_name) returning id into b;
  insert into acc_members (business_id, user_id, role) values (b, app_uid(), 'owner');
  return b;
end $$;

/* ---------- Chart of accounts ---------- */

create table acc_accounts (
  business_id uuid not null references acc_businesses on delete cascade,
  code        text not null,
  name        text not null,
  name_en     text,
  type        text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  sys         text,                                   -- role the app posts to: ar, ap, vat_out, cash …
  bank        jsonb,                                  -- money account: { bank, number, holder }
  active      boolean not null default true,
  primary key (business_id, code)
);
create unique index acc_accounts_sys on acc_accounts (business_id, sys) where sys is not null;

/* ---------- Contacts and products ---------- */

create table acc_contacts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references acc_businesses on delete cascade,
  kind         text not null default 'customer' check (kind in ('customer', 'vendor', 'both')),
  is_company   boolean not null default true,
  name         text not null,
  tax_id       text,
  branch       text,
  address      text,
  phone        text,
  email        text,
  contact_name text,
  credit_days  int,
  note         text,
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index acc_contacts_biz on acc_contacts (business_id);

create table acc_items (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references acc_businesses on delete cascade,
  kind         text not null default 'service' check (kind in ('service', 'product')),
  sku          text,
  name         text not null,
  unit         text,
  price        numeric(14,2) not null default 0,
  account      text,                                  -- income account code
  description  text,
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index acc_items_biz on acc_items (business_id);

/* ---------- Documents ---------- */

-- type: QT ใบเสนอราคา, IV ใบแจ้งหนี้/ใบวางบิล, RE ใบเสร็จรับเงิน, EX ค่าใช้จ่าย/บันทึกซื้อ.
-- Amounts are worked out by the api from lines (see src/acc/ledger.js), never taken from the browser.
create table acc_docs (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references acc_businesses on delete cascade,
  type         text not null check (type in ('QT', 'IV', 'RE', 'EX')),
  number       text not null,
  status       text not null,
  date         date not null,
  due_date     date,
  contact_id   uuid references acc_contacts on delete set null,
  contact      jsonb not null default '{}',          -- snapshot printed on the document
  tax_invoice  boolean not null default false,       -- IV/RE: is also ใบกำกับภาษี; EX: vendor gave one
  price_mode   text not null default 'excl' check (price_mode in ('excl', 'incl')),
  vat_rate     numeric(5,2) not null default 0,
  lines        jsonb not null default '[]',
  discount     numeric(14,2) not null default 0,
  subtotal     numeric(14,2) not null default 0,
  vat_base     numeric(14,2) not null default 0,
  vat          numeric(14,2) not null default 0,
  total        numeric(14,2) not null default 0,
  wht          numeric(14,2) not null default 0,
  ref_id       uuid references acc_docs on delete set null,
  ref_no       text,                                 -- EX: the vendor's invoice / tax invoice number
  ref_date     date,
  pay          jsonb,                                -- RE / paid EX: { date, account, fee, method }
  wht_cert     jsonb,                                -- EX with WHT: { number, form, income }
  notes        text,
  attachment   text,                                 -- storage key of a scanned bill
  public_token text unique,
  created_by   uuid references users on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (business_id, number)
);
create index acc_docs_biz on acc_docs (business_id, type, date desc);
create index acc_docs_ref on acc_docs (ref_id) where ref_id is not null;

create table acc_counters (
  business_id uuid not null references acc_businesses on delete cascade,
  key         text not null,
  last        int not null default 0,
  primary key (business_id, key)
);

/* ---------- Journal ---------- */

create table acc_entries (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references acc_businesses on delete cascade,
  date        date not null,
  number      text,
  memo        text,
  doc_id      uuid references acc_docs on delete cascade,   -- null for a manual journal voucher
  created_at  timestamptz not null default now()
);
create index acc_entries_biz on acc_entries (business_id, date);
create index acc_entries_doc on acc_entries (doc_id) where doc_id is not null;

create table acc_lines (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references acc_entries on delete cascade,
  business_id uuid not null,
  account     text not null,
  debit       numeric(14,2) not null default 0 check (debit >= 0),
  credit      numeric(14,2) not null default 0 check (credit >= 0),
  memo        text,
  contact_id  uuid references acc_contacts on delete set null,
  foreign key (business_id, account) references acc_accounts (business_id, code) on update cascade
);
create index acc_lines_entry on acc_lines (entry_id);
create index acc_lines_acct on acc_lines (business_id, account);

/* ---------- Access ---------- */

grant select, update on acc_businesses to app_user;
grant select on acc_members to app_user;
grant select, insert, update, delete on acc_accounts, acc_contacts, acc_items, acc_docs, acc_counters, acc_entries, acc_lines to app_user;
grant execute on function acc_new_business(text) to app_user;

alter table acc_businesses enable row level security;
alter table acc_members enable row level security;
create policy member on acc_businesses for all to app_user using (acc_can(id)) with check (acc_can(id));
create policy self on acc_members for select to app_user using (acc_can(business_id));

do $$ declare t text; begin
  foreach t in array array['acc_accounts', 'acc_contacts', 'acc_items', 'acc_docs', 'acc_counters', 'acc_entries', 'acc_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy member on %I for all to app_user using (acc_can(business_id)) with check (acc_can(business_id))', t);
  end loop;
end $$;
