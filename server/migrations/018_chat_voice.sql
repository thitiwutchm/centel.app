-- Voice questions: the Mac turns the recording into text (kind 'transcribe') before answering.
alter table chat_jobs alter column message_id drop not null;
alter table chat_jobs add column kind text not null default 'reply' check (kind in ('reply', 'transcribe'));
alter table chat_jobs add column audio bytea;
alter table chat_jobs add column audio_mime text;
