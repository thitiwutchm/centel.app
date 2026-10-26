-- Labels: each person's own tags for transactions (like "Grabfood", "Couple budget").
-- A transaction can carry many labels. Links are per person, so on a shared expense
-- each partner keeps their own labels and changing them never touches the expense row
-- (no re-approval). Only the owner can see or change their labels and links.

create table labels (
  owner_id uuid not null references users on delete cascade,
  id       text not null,
  name     text not null,
  sort     int not null default 0,
  primary key (owner_id, id)
);

create table expense_labels (
  expense_id uuid not null references expenses on delete cascade,
  owner_id   uuid not null default app_uid(),
  label_id   text not null,
  primary key (expense_id, owner_id, label_id),
  foreign key (owner_id, label_id) references labels (owner_id, id) on delete cascade
);
create index expense_labels_owner on expense_labels (owner_id, label_id);

grant select, insert, update, delete on labels, expense_labels to app_user;

alter table labels enable row level security;
alter table expense_labels enable row level security;

create policy owner on labels for all to app_user
  using (owner_id = app_uid()) with check (owner_id = app_uid());

-- Only on expenses the person can see (expenses RLS applies inside the subquery).
create policy owner on expense_labels for all to app_user
  using (owner_id = app_uid())
  with check (owner_id = app_uid() and exists (select 1 from expenses e where e.id = expense_id));
