-- เลขาช่วยเหลือ (2026-10-30): a second private assistant room per person, 'sec', answered by the
-- same Mac model for anything at all, with web search on the bridge.
alter table chat_messages drop constraint chat_messages_room_check;
alter table chat_messages add constraint chat_messages_room_check check (room in ('couple', 'ai', 'sec'));
alter table chat_reads drop constraint chat_reads_room_check;
alter table chat_reads add constraint chat_reads_room_check check (room in ('couple', 'ai', 'sec'));
create index chat_sec on chat_messages (owner_id, created_at) where room = 'sec';
