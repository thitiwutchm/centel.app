-- In-app chat (2026-10-30): a Telegram-style chat mini app on Home. Each couple has one
-- shared room ('couple', keyed by couple_id) and each person has a private room with the
-- assistant ('ai', keyed by owner_id). Assistant messages have from_ai. The assistant is
-- Hermes Agent running on the family's own Mac: a small bridge there (bridge/ in the repo)
-- signs in with a token from bridge_tokens, takes questions from chat_jobs and posts the
-- answers back. Only the api's own connection reads these tables (it checks the couple
-- itself, like line.js), so app_user gets no grant.
create table chat_messages (
  id         uuid primary key,
  room       text not null check (room in ('couple', 'ai')),
  couple_id  uuid references couples on delete cascade,
  owner_id   uuid not null references users on delete cascade,
  sender_id  uuid references users on delete set null,
  from_ai    boolean not null default false,
  text       text not null default '',
  reply_to   uuid,
  action     jsonb,
  reactions  jsonb not null default '{}',
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz,
  check ((room = 'couple') = (couple_id is not null))
);
create index chat_couple on chat_messages (couple_id, created_at) where room = 'couple';
create index chat_ai on chat_messages (owner_id, created_at) where room = 'ai';

-- How far each person has read each room: unread counts and the partner's ✓✓.
create table chat_reads (
  user_id   uuid not null references users on delete cascade,
  room      text not null check (room in ('couple', 'ai')),
  last_read timestamptz not null,
  primary key (user_id, room)
);

-- Questions waiting for the assistant. context holds what the asking device knows that
-- the server does not (this month's bills live on the device).
create table chat_jobs (
  id         uuid primary key,
  message_id uuid not null references chat_messages on delete cascade,
  user_id    uuid not null references users on delete cascade,
  room       text not null,
  couple_id  uuid,
  context    jsonb,
  status     text not null default 'queued' check (status in ('queued', 'taken', 'done', 'failed')),
  taken_at   timestamptz,
  created_at timestamptz not null default now()
);
create index chat_jobs_queued on chat_jobs (created_at) where status = 'queued';

-- One bridge token per person (stored hashed); it serves that person's couple.
create table bridge_tokens (
  user_id    uuid primary key references users on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen  timestamptz,
  info       text
);
