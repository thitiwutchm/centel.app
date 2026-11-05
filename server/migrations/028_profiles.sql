-- Profiles (2026-11-05): one sign-in can hold more than one profile, each fully separate.
-- A profile is its own users row whose parent_id is the account that signs in (the main
-- profile). Every table is already keyed by user id with row level security, so a
-- profile's wallets, transactions, bills, budgets, labels, categories, to-dos, chat and
-- partner link never mix with another profile's. Switching profile swaps the session to
-- the other users row (POST /api/profiles/switch). Profiles cannot sign in on their own:
-- no email, password or Google link. Deleting the main account deletes its profiles.

alter table users alter column email drop not null;
alter table users add column parent_id uuid references users on delete cascade;
create index users_parent on users (parent_id) where parent_id is not null;
alter table users add constraint users_profile_login check (
  case when parent_id is null then email is not null
       else email is null and password_hash is null and google_sub is null end);
