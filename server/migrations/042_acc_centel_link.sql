-- Reminders through Centel (2026-11-15). A business in account.centel.app is linked once to a
-- person's Centel app (centel.app): the accounting app makes a short code, the person approves it
-- signed in to Centel, and from then on the reminders set up on the business's การแจ้งเตือน page
-- (tax deadlines, paying suppliers, collecting from customers, anything else, and optionally
-- unpaid invoices / expenses reaching their due date) are put into that person's Centel as to-dos, so Centel's own reminder job sends them
-- (iPhone / browser notification, LINE group, chat). Every row here is written by the api
-- (pool) after it has checked access, never by app_user.

-- A pending link: shown in account.centel.app, approved (or typed in) in Centel within 15 minutes.
create table acc_centel_codes (
  code_hash   text primary key,
  business_id uuid not null references acc_businesses on delete cascade,
  created_by  uuid not null references users on delete cascade,
  expires_at  timestamptz not null,
  approved_by uuid references users on delete cascade,      -- the Centel profile that said yes
  created_at  timestamptz not null default now()
);
create index acc_centel_codes_biz on acc_centel_codes (business_id);

-- Which Centel profiles get this business's reminders. Either side can remove the link.
create table acc_centel_links (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references acc_businesses on delete cascade,
  user_id     uuid not null references users on delete cascade, -- the Centel profile
  linked_by   uuid references users on delete set null,          -- who asked, in the accounting app
  created_at  timestamptz not null default now(),
  unique (business_id, user_id)
);
create index acc_centel_links_user on acc_centel_links (user_id);

-- A deadline. kind is a tax preset (pp30, pnd1, pnd3, pnd53) or custom; category groups them
-- (tax, pay = pay a supplier / partner, collect = collect from a customer, other). Monthly ones are
-- due on `day` every month; yearly ones on `day` of `month`; once on `date`. contact and amount
-- are optional details shown in the to-do. remind_days is how long before the
-- due day Centel reminds (09:00 Bangkok). early: when the due day is a Saturday or Sunday the
-- reminder is for the Friday before (never later than the real date).
create table acc_reminders (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references acc_businesses on delete cascade,
  kind        text not null default 'custom',
  category    text not null default 'other' check (category in ('tax', 'pay', 'collect', 'other')),
  title       text not null,
  every       text not null default 'monthly' check (every in ('monthly', 'yearly', 'once')),
  day         int  check (day between 1 and 31),
  month       int  check (month between 1 and 12),
  date        date,
  contact_id  uuid references acc_contacts on delete set null,
  amount      numeric(14,2),
  remind_days int  not null default 2 check (remind_days in (0, 1, 2, 3)),
  early       boolean not null default true,
  note        text,
  active      boolean not null default true,
  created_by  uuid references users on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((every = 'once' and date is not null) or (every = 'monthly' and day is not null)
         or (every = 'yearly' and day is not null and month is not null))
);
create index acc_reminders_biz on acc_reminders (business_id);

-- The to-do made in someone's Centel for one due date, so each deadline is added once.
create table acc_reminder_sent (
  reminder_id uuid not null references acc_reminders on delete cascade,
  due_date    date not null,
  user_id     uuid not null references users on delete cascade,
  note_id     uuid,
  created_at  timestamptz not null default now(),
  primary key (reminder_id, due_date, user_id)
);

-- Reminders from documents: an unpaid expense (EX, รอจ่าย) or invoice (IV, รอรับชำระ) reaching
-- its due date. Off until switched on, per business.
create table acc_reminder_prefs (
  business_id uuid primary key references acc_businesses on delete cascade,
  ex_due      boolean not null default false,
  iv_due      boolean not null default false,
  remind_days int not null default 1 check (remind_days in (0, 1, 2, 3)),
  updated_at  timestamptz not null default now()
);

-- One to-do per document, due date and Centel profile. Taken back when the document is paid or
-- voided before the reminder went out.
create table acc_doc_reminder_sent (
  doc_id     uuid not null references acc_docs on delete cascade,
  due_date   date not null,
  user_id    uuid not null references users on delete cascade,
  note_id    uuid,
  created_at timestamptz not null default now(),
  primary key (doc_id, due_date, user_id)
);
