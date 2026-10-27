-- Shared expenses are a record for the partner to see, not a request or a debt.
-- Saving one counts it straight away; nobody approves it and no settlement is created.
-- The shares now only say whose cost it is (รับผิดชอบทั้งหมด or หาร 2) for each person's totals.

create or replace function submit_expense(eid uuid) returns void language plpgsql security definer set search_path = public as $$
declare e expenses; total numeric; n int;
begin
  select * into e from expenses where id = eid for update;
  if e.id is null or e.owner_id <> app_uid() then raise exception 'not_found' using errcode = 'P0002'; end if;
  if e.scope <> 'shared' or e.status not in ('draft', 'rejected') then raise exception 'bad_status' using errcode = 'P0001'; end if;
  if e.couple_id is distinct from my_couple() or my_partner() is null then raise exception 'no_partner' using errcode = 'P0001'; end if;
  select coalesce(sum(amount), 0), count(*) into total, n from expense_shares
    where expense_id = eid and user_id in (app_uid(), my_partner());
  if n <> 2 or total <> e.amount then raise exception 'bad_shares' using errcode = 'P0001'; end if;
  if e.payer_id not in (app_uid(), my_partner()) then raise exception 'bad_payer' using errcode = 'P0001'; end if;
  update expenses set status = 'approved', approved_by = app_uid(), approved_at = now(),
    rejected_by = null, rejected_at = null, reject_reason = null, updated_at = now()
    where id = eid;
end $$;

-- The creator may edit or delete their shared rows at any time (an edit drops to draft
-- for a moment while the shares are rewritten, then submit_expense() records it again).
drop policy edit on expenses;
create policy edit on expenses for update to app_user
  using (owner_id = app_uid())
  with check (owner_id = app_uid() and (
    (scope = 'personal' and couple_id is null and status = 'approved')
    or (scope = 'shared' and couple_id = my_couple() and status in ('draft', 'rejected'))
  ));
drop policy remove on expenses;
create policy remove on expenses for delete to app_user using (owner_id = app_uid());

-- Rows still waiting for approval (or sent back) become plain records.
update expenses set status = 'approved', approved_by = owner_id, approved_at = now(),
  rejected_by = null, rejected_at = null, reject_reason = null, updated_at = now()
  where scope = 'shared' and status in ('pending', 'rejected', 'draft') and couple_id is not null;
