-- Calendar subscription (2026-10-26). Each account can have one secret feed URL
-- (/api/calendar/<token>.ics) that iPhone Calendar subscribes to and refreshes on its
-- own. The app keeps `ics` up to date whenever bills change; the public feed is read
-- by token with the owner role, everything else goes through app_user like the rest.
create table calendar_feeds (
  user_id    uuid primary key references users on delete cascade,
  token      text not null unique,
  ics        text,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on calendar_feeds to app_user;
alter table calendar_feeds enable row level security;
create policy owner on calendar_feeds for all to app_user
  using (user_id = app_uid()) with check (user_id = app_uid());
