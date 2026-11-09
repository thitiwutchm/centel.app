-- Bill reminders in the LINE group (2026-11-09). line_targets.bills turns them on next to
-- the to-do reminders (on by default). Bills live on the device, so a signed-in device sends
-- its upcoming bill reminders (line_bill_alerts, one list per person, same keys on every
-- device) and the minute job sends the due ones to the person's group as a Flex card.
-- Only the api's own connection reads line_bill_alerts, so app_user gets no grant.
alter table line_targets add column if not exists bills boolean not null default true;

create table if not exists line_bill_alerts (
  user_id  uuid not null references users on delete cascade,
  key      text not null,
  at       timestamptz not null,
  bill     jsonb not null,
  sent_at  timestamptz,
  primary key (user_id, key)
);
create index if not exists line_bill_alerts_due on line_bill_alerts (at) where sent_at is null;
