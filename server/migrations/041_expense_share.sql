-- Expense sharing (2026-11-14): besides the balance, each person can let their partner see
-- all of their own expenses (personal ones too), by month, read-only. It is the person's own
-- switch on the same row as balance sharing; nothing is copied, the partner's page reads the
-- expenses live through /api/balance/expenses while the switch is on.
alter table user_balance_share add column share_expenses boolean not null default false;
