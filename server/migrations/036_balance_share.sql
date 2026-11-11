-- Balance sharing (2026-11-11): each person can show their partner how much money they have
-- left. The page sends its own totals (the server never works them out); only the latest
-- snapshot is kept, one row per person, never a history. `sharing` is the person's own
-- switch; turning it off clears the snapshot. `wallets` (each wallet's name, emoji and
-- balance) is kept only when the person also chose to show each wallet.
-- Only the api's own connection reads this table, so app_user gets no grant.
create table user_balance_share (
  user_id    uuid primary key references users on delete cascade,
  sharing    boolean not null default false,
  per_wallet boolean not null default false,
  total      numeric(14, 2),
  wallets    jsonb,
  at         timestamptz,
  updated_at timestamptz not null default now()
);
