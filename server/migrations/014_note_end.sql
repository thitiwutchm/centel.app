-- When a note ends (2026-10-29), as in iOS Calendar: Starts / Ends / All-day. end_date is
-- for a note over several days (null = the start day); end_time only on a timed note.
-- A note without a time is all day.
alter table notes add column end_date date, add column end_time time;
