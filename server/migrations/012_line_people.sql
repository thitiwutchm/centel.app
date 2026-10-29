-- Who is who in the LINE group (2026-10-29): each person's own list of LINE user ids
-- (U…) with a name, and which app account they are ('me' / 'partner'). Reminders
-- @mention the people a note belongs to, and the bot greets known people by name.
create table line_people (
  owner_id     uuid not null references users on delete cascade default app_uid(),
  line_user_id text not null check (line_user_id ~ '^U[0-9a-f]{32}$'),
  name         text not null,
  who          text not null default '' check (who in ('', 'me', 'partner')),
  sort         int not null default 0,
  primary key (owner_id, line_user_id)
);

grant select, insert, update, delete on line_people to app_user;
alter table line_people enable row level security;
create policy owner on line_people for all to app_user
  using (owner_id = app_uid()) with check (owner_id = app_uid());
