-- ติดเงิน / IOU (2026-11-16): a record of money someone lent me or paid for me first (I owe
-- them), or that I lent or paid for someone (they owe me). It is only a note of who owes whom
-- and for what: it never touches a wallet, a total, a budget or a report. Repayments are kept
-- on the row (repaid = [{ id, date, amount, txnId? }]); txnId points at the income or expense
-- the person chose to record in a wallet when the money actually moved. Each person's own.
create table ious (
  id         uuid primary key,
  owner_id   uuid not null default app_uid() references users on delete cascade,
  dir        text not null check (dir in ('owed', 'owe')),          -- owed: they owe me · owe: I owe them
  kind       text not null default 'loan' check (kind in ('loan', 'advance')), -- ยืมเงิน · สำรองจ่าย
  person     text not null,
  amount     numeric(14,2) not null check (amount > 0),
  date       date not null,
  due        date,
  note       text,
  repaid     jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ious_owner on ious (owner_id, date);

grant select, insert, update, delete on ious to app_user;
alter table ious enable row level security;
create policy owner on ious for all to app_user
  using (owner_id = app_uid()) with check (owner_id = app_uid());
