-- To-do notes (2026-10-29): the Home "สิ่งที่ต้องทำ" mini app. A note is a short line
-- ("จันทร์ที่ 1 ไปเยี่ยมแม่ ลำพูน") with an optional date, time and reminder. A shared
-- note belongs to the couple: both partners see it, tick it off or change it, and
-- only the creator can delete it. remind_at is the moment the reminder is due
-- (worked out by the app in the person's own time zone) and notified_at is set once
-- it has been sent, so a later LINE OA push job can pick up due rows with one query.
create table notes (
  id          uuid primary key,
  owner_id    uuid not null references users on delete cascade default app_uid(),
  couple_id   uuid references couples on delete set null,
  text        text not null,
  date        date,
  time        time,
  remind      int,
  remind_at   timestamptz,
  notified_at timestamptz,
  done        boolean not null default false,
  done_at     timestamptz,
  done_by     uuid references users on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index notes_owner on notes (owner_id);
create index notes_couple on notes (couple_id) where couple_id is not null;
create index notes_due on notes (remind_at) where notified_at is null and not done;

grant select, insert, update, delete on notes to app_user;
alter table notes enable row level security;

create policy read on notes for select to app_user
  using (owner_id = app_uid() or (couple_id is not null and couple_id = my_couple()));
create policy add on notes for insert to app_user
  with check (owner_id = app_uid() and (couple_id is null or couple_id = my_couple()));
create policy edit on notes for update to app_user
  using (owner_id = app_uid() or (couple_id is not null and couple_id = my_couple()))
  with check ((couple_id is null and owner_id = app_uid()) or couple_id = my_couple());
create policy remove on notes for delete to app_user
  using (owner_id = app_uid());
