-- ปฏิทินภาษี (2026-11-19): a business's year of filing and payment deadlines, set up once and then
-- reminded through the Centel link of 042 (acc_centel_links), month by month all year.
-- Every row is written by the api (pool) after it has checked access, like 042.

-- What the business has to file. forms holds one entry per form key (see server/src/acc/taxcal.js
-- FORMS): true = remind, false/missing = off, 'auto' (ภ.ง.ด.1/3/53 only) = remind only in months
-- whose recorded payments need the form. The fiscal year itself is acc_businesses.settings.fyStart.
create table acc_tax_profiles (
  business_id uuid primary key references acc_businesses on delete cascade,
  forms       jsonb not null default '{}',
  registered  date,                                   -- วันจดทะเบียนบริษัท: first (short) fiscal year, no ภ.ง.ด.51
  agm_month   int check (agm_month between 1 and 12), -- planned ประชุมสามัญผู้ถือหุ้น; null = the last day allowed
  agm_day     int check (agm_day between 1 and 31),
  filing      text not null default 'online' check (filing in ('online', 'paper')),
  remind_days int  not null default 2 check (remind_days in (0, 1, 2, 3, 7)),
  digest      boolean not null default true,          -- a to-do on the 1st listing the month's deadlines
  created_by  uuid references users on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- A deadline marked as filed / paid (form + period, e.g. pp30 2026-10, pnd50 FY2026).
create table acc_tax_done (
  business_id uuid not null references acc_businesses on delete cascade,
  form        text not null,
  period      text not null,
  ref         text,
  done_by     uuid references users on delete set null,
  done_at     timestamptz not null default now(),
  primary key (business_id, form, period)
);

-- The to-do put into a Centel profile for one deadline, so each is added once.
create table acc_tax_sent (
  business_id uuid not null references acc_businesses on delete cascade,
  form        text not null,
  period      text not null,
  user_id     uuid not null references users on delete cascade,
  due_date    date not null,
  note_id     uuid,
  created_at  timestamptz not null default now(),
  primary key (business_id, form, period, user_id)
);
