-- The couple's own name for their shared chat room (null = the default บ้านเรา).
alter table couples add column chat_name text check (chat_name is null or length(chat_name) between 1 and 40);
