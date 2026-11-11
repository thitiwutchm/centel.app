-- Partner location (2026-11-11): partners see where the other one is and the temperature
-- there. Only the latest place is kept, one row per person, never a history. `sharing` is
-- the person's own switch; turning it off clears the place, the weather and the app token.
-- token_hash is the iOS app's own key for background updates (POST /api/location/ping),
-- since the app posts while the page is not running and has no cookie. Weather comes from
-- Open-Meteo and is kept with the row (wx_*) for 30 minutes.
-- Only the api's own connection reads this table, so app_user gets no grant.
create table user_locations (
  user_id    uuid primary key references users on delete cascade,
  sharing    boolean not null default false,
  token_hash text unique,
  lat        double precision,
  lon        double precision,
  acc        real,
  place      text,
  src        text,
  at         timestamptz,
  temp       real,
  feels      real,
  wcode      int,
  is_day     boolean,
  wx_lat     double precision,
  wx_lon     double precision,
  wx_at      timestamptz,
  updated_at timestamptz not null default now()
);
