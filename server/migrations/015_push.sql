-- iPhone / browser notifications (Web Push, 2026-10-29). A device that turned
-- notifications on in the Account tab sends its push subscription (push_subs, one row
-- per device). To-do reminders reuse notes.remind_at; bills live only on the device, so
-- each device sends its own upcoming bill alerts (push_alerts, replaced as a whole per
-- device) and the minute job sends the ones that are due. The VAPID key pair is made on
-- first start and kept in push_keys unless VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set.
-- Only the api's own connection reads these tables, so app_user gets no grant.
create table push_subs (
  endpoint   text primary key,
  user_id    uuid not null references users on delete cascade,
  p256dh     text not null,
  auth       text not null,
  device     text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz
);
create index push_subs_user on push_subs (user_id);

create table push_alerts (
  user_id  uuid not null references users on delete cascade,
  device   text not null,
  key      text not null,
  at       timestamptz not null,
  title    text not null,
  body     text not null default '',
  url      text,
  sent_at  timestamptz,
  primary key (user_id, device, key)
);
create index push_alerts_due on push_alerts (at) where sent_at is null;

create table push_keys (
  id          int primary key default 1 check (id = 1),
  public_key  text not null,
  private_key text not null
);
