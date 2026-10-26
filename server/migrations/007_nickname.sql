-- A short nickname (ชื่อเล่น) shown to the partner on shared expenses, e.g. "ต้น".
-- Null until the person sets it; the app asks everyone without one.
alter table users add column nickname text;
grant select (nickname) on users to app_user;
