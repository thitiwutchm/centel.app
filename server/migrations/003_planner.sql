-- Bill planner sync (2026-10-26). Bills, monthly records and settings used to live
-- only in each device's localStorage. Signed in, the whole planner document is kept
-- here; `rev` lets a device tell when another device saved first and merge before
-- writing (see cloud.js).
create table planner (
  user_id    uuid primary key references users on delete cascade,
  data       jsonb not null default '{}',
  rev        int not null default 0,
  updated_at timestamptz not null default now()
);

grant select, insert, update on planner to app_user;
alter table planner enable row level security;
create policy owner on planner for all to app_user
  using (user_id = app_uid()) with check (user_id = app_uid());
