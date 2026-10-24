-- Couple expense tracking (PRD 2026-10-24).
-- The API connects as the database owner but runs every user request as role
-- app_user with app.user_id set, so the row level security policies below decide
-- what each person can read or change, even for queries the API builds itself.

create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

/* ---------- Accounts (owner only; never exposed to app_user except id/name/email) ---------- */

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  display_name  text not null,
  created_at    timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id    uuid not null references users on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create function app_uid() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

/* ---------- Couples ---------- */

create table couples (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table couple_members (
  couple_id uuid not null references couples on delete cascade,
  user_id   uuid not null unique references users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (couple_id, user_id)
);

create table couple_invites (
  code       text primary key,
  couple_id  uuid not null references couples on delete cascade,
  created_by uuid not null references users on delete cascade,
  expires_at timestamptz not null,
  used_by    uuid references users,
  used_at    timestamptz
);

-- Security definer so policies can look up membership without recursing into RLS.
create function my_couple() returns uuid language sql stable security definer set search_path = public as
$$ select couple_id from couple_members where user_id = app_uid() $$;

create function my_partner() returns uuid language sql stable security definer set search_path = public as
$$ select m.user_id from couple_members m
   where m.couple_id = (select couple_id from couple_members where user_id = app_uid())
     and m.user_id <> app_uid() $$;

/* ---------- Money ---------- */

create table wallets (
  owner_id uuid not null references users on delete cascade,
  id       text not null,
  name     text not null,
  type     text not null default 'cash',
  initial  numeric(14,2) not null default 0,
  excluded boolean not null default false,
  sort     int not null default 0,
  primary key (owner_id, id)
);

create table expenses (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references users on delete cascade,  -- creator
  couple_id      uuid references couples on delete set null,
  scope          text not null default 'personal' check (scope in ('personal', 'shared')),
  type           text not null default 'expense' check (type in ('expense', 'income', 'transfer')),
  date           date not null,
  merchant       text,
  amount         numeric(14,2) not null check (amount > 0),
  category       text,                        -- null = waiting for the owner to pick (รอตรวจสอบ)
  note           text,
  wallet_id      text,                        -- creator's wallet (personal rows, or shared rows the creator paid)
  to_wallet_id   text,                        -- transfers
  payer_id       uuid references users,       -- shared rows: who actually paid
  payer_wallet_id text,                       -- set by the approver when the approver is the payer
  status         text not null default 'approved'
                 check (status in ('draft', 'pending', 'approved', 'rejected')),
  review_needed  boolean not null default false,
  receipt_key    text,
  slip_ref       text,
  bill_id        text,
  bill_ym        text,
  revision       int not null default 1,
  approved_by    uuid references users,
  approved_at    timestamptz,
  rejected_by    uuid references users,
  rejected_at    timestamptz,
  reject_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (scope = 'personal' or (type = 'expense' and couple_id is not null and payer_id is not null)),
  check (scope = 'shared' or status = 'approved')
);
create index expenses_owner_date on expenses (owner_id, date);
create index expenses_couple_date on expenses (couple_id, date) where scope = 'shared';
create index expenses_slip_ref on expenses (slip_ref) where slip_ref is not null;

create table expense_shares (
  expense_id uuid not null references expenses on delete cascade,
  user_id    uuid not null references users on delete cascade,
  amount     numeric(14,2) not null check (amount >= 0),
  primary key (expense_id, user_id)
);

create table approval_events (
  id         bigserial primary key,
  expense_id uuid not null references expenses on delete cascade,
  actor_id   uuid not null references users,
  action     text not null check (action in ('submitted', 'resubmitted', 'approved', 'rejected')),
  revision   int not null,
  snapshot   jsonb,
  note       text,
  created_at timestamptz not null default now()
);

-- What one partner owes the other for an approved shared expense. Repayment is
-- tracked here only; it never creates a new expense, so couple totals count once.
create table settlements (
  id                 uuid primary key default gen_random_uuid(),
  couple_id          uuid not null references couples on delete cascade,
  expense_id         uuid not null references expenses on delete cascade,
  debtor_id          uuid not null references users,
  creditor_id        uuid not null references users,
  amount             numeric(14,2) not null check (amount > 0),
  status             text not null default 'unpaid' check (status in ('unpaid', 'paid')),
  paid_at            timestamptz,
  marked_by          uuid references users,
  debtor_wallet_id   text,
  creditor_wallet_id text,
  created_at         timestamptz not null default now()
);

create table budgets (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references users on delete cascade,
  couple_id  uuid references couples on delete cascade,
  scope      text not null default 'personal' check (scope in ('personal', 'shared')),
  category   text not null default 'all',
  amount     numeric(14,2) not null check (amount > 0),
  wallet_id  text not null default 'total',
  created_at timestamptz not null default now(),
  check (scope = 'personal' or couple_id is not null)
);

create table receipt_analysis (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users on delete cascade,
  receipt_key text not null,
  model       text,
  result      jsonb,
  status      text not null check (status in ('ok', 'needs_review', 'failed', 'skipped')),
  created_at  timestamptz not null default now()
);

create table prefs (
  user_id uuid primary key references users on delete cascade,
  data    jsonb not null default '{}'
);

/* ---------- Grants ---------- */

grant usage on schema public to app_user;
grant select (id, email, display_name) on users to app_user;
grant select on couples, couple_members to app_user;
grant select, insert, update, delete on wallets, expenses, expense_shares, budgets, prefs to app_user;
grant select on approval_events, settlements to app_user;
grant select, insert on receipt_analysis to app_user;
grant execute on function app_uid(), my_couple(), my_partner() to app_user;

/* ---------- Row level security ---------- */

alter table users enable row level security;
alter table couples enable row level security;
alter table couple_members enable row level security;
alter table couple_invites enable row level security;
alter table wallets enable row level security;
alter table expenses enable row level security;
alter table expense_shares enable row level security;
alter table approval_events enable row level security;
alter table settlements enable row level security;
alter table budgets enable row level security;
alter table receipt_analysis enable row level security;
alter table prefs enable row level security;

create policy self_or_partner on users for select to app_user
  using (id = app_uid() or id = my_partner());

create policy member on couples for select to app_user using (id = my_couple());
create policy member on couple_members for select to app_user using (couple_id = my_couple());

create policy owner on wallets for all to app_user
  using (owner_id = app_uid()) with check (owner_id = app_uid());

create policy owner on prefs for all to app_user
  using (user_id = app_uid()) with check (user_id = app_uid());

create policy owner on receipt_analysis for all to app_user
  using (user_id = app_uid()) with check (user_id = app_uid());

-- Personal rows: owner only. Shared rows: both members, once submitted.
create policy read on expenses for select to app_user using (
  owner_id = app_uid()
  or (scope = 'shared' and couple_id = my_couple() and status <> 'draft')
);
-- New shared rows start as drafts; submit_expense() moves them to pending.
create policy add on expenses for insert to app_user with check (
  owner_id = app_uid() and (
    (scope = 'personal' and couple_id is null and status = 'approved')
    or (scope = 'shared' and couple_id = my_couple() and status = 'draft' and approved_by is null)
  )
);
-- The creator may edit personal rows, and shared rows only while draft or rejected.
-- Nobody can set a shared row to pending/approved here; that goes through the functions.
create policy edit on expenses for update to app_user
  using (owner_id = app_uid() and (scope = 'personal' or status in ('draft', 'rejected')))
  with check (owner_id = app_uid() and (
    (scope = 'personal' and couple_id is null and status = 'approved')
    or (scope = 'shared' and couple_id = my_couple() and status in ('draft', 'rejected'))
  ));
create policy remove on expenses for delete to app_user
  using (owner_id = app_uid() and (scope = 'personal' or status <> 'approved'));

create policy read on expense_shares for select to app_user
  using (exists (select 1 from expenses e where e.id = expense_id));  -- inherits expenses RLS
create policy write on expense_shares for all to app_user
  using (exists (select 1 from expenses e where e.id = expense_id and e.owner_id = app_uid()
                 and e.scope = 'shared' and e.status in ('draft', 'rejected')))
  with check (exists (select 1 from expenses e where e.id = expense_id and e.owner_id = app_uid()
                 and e.scope = 'shared' and e.status in ('draft', 'rejected')));

create policy read on approval_events for select to app_user
  using (exists (select 1 from expenses e where e.id = expense_id));

create policy member on settlements for select to app_user using (couple_id = my_couple());

create policy read on budgets for select to app_user using (
  (scope = 'personal' and owner_id = app_uid()) or (scope = 'shared' and couple_id = my_couple())
);
create policy write on budgets for all to app_user
  using ((scope = 'personal' and owner_id = app_uid()) or (scope = 'shared' and couple_id = my_couple()))
  with check (
    (scope = 'personal' and owner_id = app_uid() and couple_id is null)
    or (scope = 'shared' and couple_id = my_couple())
  );

/* ---------- Workflow functions (security definer; each checks the caller itself) ---------- */

create function snapshot_of(eid uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(e) - 'created_at' - 'updated_at'
    || jsonb_build_object('shares', (select coalesce(jsonb_agg(jsonb_build_object('user_id', s.user_id, 'amount', s.amount)), '[]')
                                     from expense_shares s where s.expense_id = e.id))
  from expenses e where e.id = eid
$$;

-- Creator sends a draft (or a rejected, edited row) to the partner for approval.
create function submit_expense(eid uuid) returns void language plpgsql security definer set search_path = public as $$
declare e expenses; total numeric; n int; was text;
begin
  select * into e from expenses where id = eid for update;
  if e.id is null or e.owner_id <> app_uid() then raise exception 'not_found' using errcode = 'P0002'; end if;
  if e.scope <> 'shared' or e.status not in ('draft', 'rejected') then raise exception 'bad_status' using errcode = 'P0001'; end if;
  if e.couple_id is distinct from my_couple() or my_partner() is null then raise exception 'no_partner' using errcode = 'P0001'; end if;
  select coalesce(sum(amount), 0), count(*) into total, n from expense_shares
    where expense_id = eid and user_id in (app_uid(), my_partner());
  if n <> 2 or total <> e.amount then raise exception 'bad_shares' using errcode = 'P0001'; end if;
  if e.payer_id not in (app_uid(), my_partner()) then raise exception 'bad_payer' using errcode = 'P0001'; end if;
  was := e.status;
  update expenses set status = 'pending',
    revision = case when was = 'rejected' then revision + 1 else revision end,
    rejected_by = null, rejected_at = null, reject_reason = null, updated_at = now()
    where id = eid;
  insert into approval_events (expense_id, actor_id, action, revision, snapshot)
    values (eid, app_uid(), case when was = 'rejected' then 'resubmitted' else 'submitted' end,
            (select revision from expenses where id = eid), snapshot_of(eid));
end $$;

-- The partner (never the creator) approves or rejects; nothing else can be changed.
create function respond_expense(eid uuid, approve boolean, reason text default null, wallet text default null)
returns void language plpgsql security definer set search_path = public as $$
declare e expenses; s record;
begin
  select * into e from expenses where id = eid for update;
  if e.id is null or e.scope <> 'shared' or e.couple_id is distinct from my_couple() then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if e.owner_id = app_uid() then raise exception 'creator_cannot_respond' using errcode = 'P0001'; end if;
  if e.status <> 'pending' then raise exception 'bad_status' using errcode = 'P0001'; end if;
  if approve then
    update expenses set status = 'approved', approved_by = app_uid(), approved_at = now(), updated_at = now(),
      payer_wallet_id = case when e.payer_id = app_uid() then wallet else payer_wallet_id end
      where id = eid;
    for s in select user_id, amount from expense_shares where expense_id = eid and user_id <> e.payer_id and amount > 0 loop
      insert into settlements (couple_id, expense_id, debtor_id, creditor_id, amount)
        values (e.couple_id, eid, s.user_id, e.payer_id, s.amount);
    end loop;
  else
    update expenses set status = 'rejected', rejected_by = app_uid(), rejected_at = now(),
      reject_reason = nullif(trim(reason), ''), updated_at = now()
      where id = eid;
  end if;
  insert into approval_events (expense_id, actor_id, action, revision, note)
    values (eid, app_uid(), case when approve then 'approved' else 'rejected' end, e.revision, nullif(trim(reason), ''));
end $$;

-- Either partner records a repayment (manual in the MVP), naming their own wallet.
create function mark_settlement(sid uuid, paid boolean, wallet text default null)
returns void language plpgsql security definer set search_path = public as $$
declare st settlements;
begin
  select * into st from settlements where id = sid for update;
  if st.id is null or st.couple_id is distinct from my_couple() then raise exception 'not_found' using errcode = 'P0002'; end if;
  update settlements set
    status = case when paid then 'paid' else 'unpaid' end,
    paid_at = case when paid then now() else null end,
    marked_by = app_uid(),
    debtor_wallet_id = case when not paid then null when app_uid() = debtor_id then wallet else debtor_wallet_id end,
    creditor_wallet_id = case when not paid then null when app_uid() = creditor_id then wallet else creditor_wallet_id end
    where id = sid;
end $$;

-- Lets the side that did not mark the repayment say which of their wallets moved.
create function set_settlement_wallet(sid uuid, wallet text)
returns void language plpgsql security definer set search_path = public as $$
declare st settlements;
begin
  select * into st from settlements where id = sid for update;
  if st.id is null or st.couple_id is distinct from my_couple() or st.status <> 'paid' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update settlements set
    debtor_wallet_id = case when app_uid() = debtor_id then wallet else debtor_wallet_id end,
    creditor_wallet_id = case when app_uid() = creditor_id then wallet else creditor_wallet_id end
    where id = sid;
end $$;

create function create_invite() returns text language plpgsql security definer set search_path = public as $$
declare cid uuid; c text;
begin
  cid := my_couple();
  if cid is null then
    insert into couples default values returning id into cid;
    insert into couple_members (couple_id, user_id) values (cid, app_uid());
  elsif (select count(*) from couple_members where couple_id = cid) >= 2 then
    raise exception 'couple_full' using errcode = 'P0001';
  end if;
  c := upper(substr(replace(encode(gen_random_bytes(6), 'base64'), '/', ''), 1, 6));
  c := translate(c, '+0O1I', 'XQPLK');
  insert into couple_invites (code, couple_id, created_by, expires_at) values (c, cid, app_uid(), now() + interval '7 days');
  return c;
end $$;

create function join_couple(invite text) returns uuid language plpgsql security definer set search_path = public as $$
declare inv couple_invites;
begin
  if my_couple() is not null then raise exception 'already_linked' using errcode = 'P0001'; end if;
  select * into inv from couple_invites where code = upper(trim(invite)) for update;
  if inv.code is null or inv.used_by is not null or inv.expires_at < now() then
    raise exception 'bad_invite' using errcode = 'P0001';
  end if;
  if (select count(*) from couple_members where couple_id = inv.couple_id) >= 2 then
    raise exception 'couple_full' using errcode = 'P0001';
  end if;
  insert into couple_members (couple_id, user_id) values (inv.couple_id, app_uid());
  update couple_invites set used_by = app_uid(), used_at = now() where code = inv.code;
  return inv.couple_id;
end $$;

revoke execute on function submit_expense(uuid), respond_expense(uuid, boolean, text, text),
  mark_settlement(uuid, boolean, text), set_settlement_wallet(uuid, text), create_invite(), join_couple(text),
  snapshot_of(uuid) from public;
grant execute on function submit_expense(uuid), respond_expense(uuid, boolean, text, text),
  mark_settlement(uuid, boolean, text), set_settlement_wallet(uuid, text), create_invite(), join_couple(text)
  to app_user;
