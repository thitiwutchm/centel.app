-- Accounting users (account.centel.app, 2026-11-13): an owner invites people by email and gives
-- each a position (role). The role sets default access to four areas, which the owner can tune
-- per person in acc_members.perms: sales (QT/IV/RE), purchase (EX), accounting (journal, chart
-- of accounts, reports) and settings. 0 = none, 1 = view, 2 = edit. Only owners manage users.
-- Membership rows are written by the api (pool), never by app_user.

alter table acc_members drop constraint if exists acc_members_role_check;
alter table acc_members add constraint acc_members_role_check check (role in (
  'owner', 'firm', 'accountant', 'sales_manager', 'sales_lead', 'sales', 'trader', 'hr_manager', 'cashier', 'hr',
  'editor', 'viewer'));
alter table acc_members add column perms      jsonb;                 -- null = the role's defaults
alter table acc_members add column disabled   boolean not null default false;
alter table acc_members add column invited_by uuid references users on delete set null;

-- A suspended member keeps the row (so the owner can turn them back on) but reaches nothing.
create or replace function acc_can(b uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from acc_members where business_id = b and user_id = app_uid() and not disabled) $$;

create table acc_invites (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references acc_businesses on delete cascade,
  email       text not null,                                    -- lower case
  role        text not null,
  perms       jsonb,
  token_hash  text not null unique,
  invited_by  uuid references users on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days'
);
create unique index acc_invites_email on acc_invites (business_id, email);
create index acc_invites_lookup on acc_invites (email);

-- A person's own details in the accounting app: name, phone and the signature put on the
-- documents they issue. One row per sign-in, shared by all their businesses.
create table acc_profiles (
  user_id    uuid primary key references users on delete cascade,
  first_name text,
  last_name  text,
  phone      text,
  signature  text,                                              -- small data: URL, transparent PNG
  updated_at timestamptz not null default now()
);
