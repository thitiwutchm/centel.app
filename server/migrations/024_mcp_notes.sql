-- AI apps may add and change to-do notes / reminders (2026-11-03). What a connection may
-- do is its grant's scope: grants from before this are read-only ('centel.read') until
-- the person connects the app again and approves the new consent page.
alter table oauth_grants add column if not exists scope text not null default 'centel.read';
