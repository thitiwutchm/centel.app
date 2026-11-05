-- Notifications in the native iOS app (2026-11-04). Web Push does not run inside the
-- app's web view, so the app registers its APNs device token here and pushTo() sends to
-- these as well as to push_subs. env is the APNs gateway the token belongs to:
-- production for Ad Hoc / TestFlight / App Store builds, sandbox for builds run from Xcode.
-- Only the api's own connection reads this table, so app_user gets no grant.
create table push_apns (
  token      text primary key,
  user_id    uuid not null references users on delete cascade,
  device     text,
  env        text not null default 'production' check (env in ('production', 'sandbox')),
  created_at timestamptz not null default now(),
  last_ok    timestamptz
);
create index push_apns_user on push_apns (user_id);
