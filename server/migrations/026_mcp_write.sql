-- AI apps may manage notes, to-dos, budgets and transactions through MCP (2026-11-03).

-- Notes: a row is either a to-do (as before) or a free-form memo (kind 'memo': a title in
-- text, the content in body, never a date or reminder). To-dos gain a description (body),
-- tags, priority, an in-progress flag and a repeat rule: ticking off a repeating to-do moves
-- it to its next date instead of closing it. Older app versions that do not send these keep
-- them as they are (PUT /api/notes only changes the ones it is given).
alter table notes
  add column if not exists kind text not null default 'todo' check (kind in ('todo', 'memo')),
  add column if not exists body text,
  add column if not exists tags text[] not null default '{}',
  add column if not exists priority text check (priority in ('low', 'medium', 'high')),
  add column if not exists in_progress boolean not null default false,
  add column if not exists recurrence text check (recurrence in ('daily', 'weekly', 'monthly', 'yearly'));

-- Budgets: still monthly by default, now also weekly (Monday to Sunday) or one custom date
-- range. An optional name ("ซูชิโร่") and shop filter (only spending whose shop or note
-- contains it) let two budgets share a category.
alter table budgets
  add column if not exists name text,
  add column if not exists period text not null default 'month' check (period in ('month', 'week', 'custom')),
  add column if not exists start_date date,
  add column if not exists end_date date,
  add column if not exists merchant text;
alter table budgets add constraint budgets_custom_range
  check (period <> 'custom' or (start_date is not null and end_date is not null and end_date >= start_date));

-- Every change an AI app makes, with the row before and after, so it can be shown in the
-- app and undone. Written in the same transaction as the change.
create table mcp_audit (
  id         bigserial primary key,
  user_id    uuid not null references users on delete cascade default app_uid(),
  grant_id   uuid,
  client     text,
  tool       text not null,
  entity     text not null check (entity in ('note', 'budget', 'transaction')),
  entity_id  text not null,
  action     text not null check (action in ('create', 'update', 'delete')),
  summary    text,
  before     jsonb,
  after      jsonb,
  undo_of    bigint references mcp_audit on delete set null,
  undone_at  timestamptz,
  created_at timestamptz not null default now()
);
create index mcp_audit_user on mcp_audit (user_id, created_at desc);

-- Idempotency keys: the same key from the same person returns the first answer again.
create table mcp_idem (
  user_id    uuid not null references users on delete cascade default app_uid(),
  key        text not null,
  tool       text not null,
  args_hash  text not null,
  result     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Confirmations: a delete or a money change first answers with a preview and a token;
-- the same call with that token (within 10 minutes, once) does it.
create table mcp_confirms (
  id         uuid primary key,
  user_id    uuid not null references users on delete cascade default app_uid(),
  tool       text not null,
  args_hash  text not null,
  preview    jsonb,
  expires_at timestamptz not null,
  used_at    timestamptz,
  result     jsonb
);

grant select, insert, update on mcp_audit to app_user;
grant usage on sequence mcp_audit_id_seq to app_user;
grant select, insert, delete on mcp_idem to app_user;
grant select, insert, update, delete on mcp_confirms to app_user;
alter table mcp_audit enable row level security;
alter table mcp_idem enable row level security;
alter table mcp_confirms enable row level security;
create policy owner on mcp_audit for all to app_user using (user_id = app_uid()) with check (user_id = app_uid());
create policy owner on mcp_idem for all to app_user using (user_id = app_uid()) with check (user_id = app_uid());
create policy owner on mcp_confirms for all to app_user using (user_id = app_uid()) with check (user_id = app_uid());
