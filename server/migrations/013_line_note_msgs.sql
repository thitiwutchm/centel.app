-- Which LINE messages belong to which note (2026-10-29): the "ทำนัด …" line someone typed,
-- the bot's answer, and the reminders it pushed. Replying to (quoting) one of them in the
-- group edits or cancels that note; "แก้ไข …" alone edits the sender's latest one. Only the
-- api's own connection reads it, so app_user gets no grant.
create table line_note_msgs (
  message_id   text primary key,
  note_id      uuid not null references notes on delete cascade,
  line_user_id text,
  created_at   timestamptz not null default now()
);
create index line_note_msgs_user on line_note_msgs (line_user_id, created_at desc);
