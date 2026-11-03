-- Billing for the app owner's own business: the companies Centel's owner builds apps for
-- (clients), what each is charged on a schedule (plans), the invoices issued to them,
-- and the payments received. Only the api's own connection reads these tables (owner-only
-- routes in src/billing.js), so app_user gets no grant.

create table billing_settings (
  id               int primary key default 1 check (id = 1),
  seller_name      text not null default '',
  seller_tax_id    text,
  seller_address   text,
  seller_phone     text,
  seller_email     text,
  bank_info        text,
  invoice_prefix   text not null default 'INV',
  default_due_days int not null default 30 check (default_due_days between 0 and 365),
  vat_rate         numeric(5,2) not null default 7 check (vat_rate between 0 and 100),
  remind_days      int not null default 3 check (remind_days between 0 and 60),
  footer_note      text,
  updated_at       timestamptz not null default now()
);
insert into billing_settings (id) values (1);

create table billing_clients (
  id           uuid primary key default gen_random_uuid(),
  code         text unique,
  name         text not null,
  contact_name text,
  email        text,
  phone        text,
  tax_id       text,
  address      text,
  notes        text,
  due_days     int check (due_days between 0 and 365),
  portal_token text unique,
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- A repeating charge: bill_day is the day of the month the invoice goes out (clamped to the
-- month's last day), due_days how long the client has to pay, next_bill_date the next run.
create table billing_plans (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references billing_clients on delete cascade,
  name           text not null,
  amount         numeric(14,2) not null check (amount >= 0),
  currency       text not null default 'THB',
  every          text not null default 'month' check (every in ('month', 'year', 'once')),
  bill_day       int not null default 1 check (bill_day between 1 and 31),
  due_days       int check (due_days between 0 and 365),
  vat            boolean not null default false,
  wht_rate       numeric(5,2) not null default 0 check (wht_rate between 0 and 100),
  start_date     date not null,
  end_date       date,
  next_bill_date date,
  auto_issue     boolean not null default false,
  active         boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now()
);
create index billing_plans_client on billing_plans (client_id);
create index billing_plans_due on billing_plans (next_bill_date) where active;

create table billing_counters (
  year int primary key,
  n    int not null default 0
);

create table billing_invoices (
  id            uuid primary key default gen_random_uuid(),
  number        text unique,
  client_id     uuid not null references billing_clients on delete restrict,
  plan_id       uuid references billing_plans on delete set null,
  status        text not null default 'draft' check (status in ('draft', 'issued', 'paid', 'void')),
  issue_date    date,
  due_date      date,
  period_start  date,
  period_end    date,
  currency      text not null default 'THB',
  items         jsonb not null default '[]',
  subtotal      numeric(14,2) not null default 0,
  vat_rate      numeric(5,2) not null default 0,
  vat           numeric(14,2) not null default 0,
  wht_rate      numeric(5,2) not null default 0,
  wht           numeric(14,2) not null default 0,
  total         numeric(14,2) not null default 0,
  paid_amount   numeric(14,2) not null default 0,
  notes         text,
  public_token  text not null unique,
  issued_at     timestamptz,
  paid_at       timestamptz,
  reminded_at   timestamptz,
  overdue_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index billing_invoices_client on billing_invoices (client_id, issue_date);
create index billing_invoices_open on billing_invoices (due_date) where status = 'issued';
-- One invoice per plan per billing run, so the scheduler and a tap cannot both issue it.
create unique index billing_invoices_plan_period on billing_invoices (plan_id, period_start) where plan_id is not null and status <> 'void';

create table billing_payments (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references billing_invoices on delete cascade,
  amount     numeric(14,2) not null check (amount > 0),
  paid_on    date not null,
  method     text,
  reference  text,
  note       text,
  created_at timestamptz not null default now()
);
create index billing_payments_invoice on billing_payments (invoice_id);

-- Keys for other systems to call the billing API (Authorization: Bearer cbk_...).
create table billing_api_keys (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  prefix       text not null,
  key_hash     text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
