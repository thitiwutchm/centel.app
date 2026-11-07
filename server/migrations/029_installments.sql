-- 0% installments (2026-11-07): one purchase paid over several months is saved as one expense per
-- month. inst = { id, n, of, total }: the plan id shared by its months, this month's number,
-- the number of months and the full price. Null for everything else.
alter table expenses add column if not exists inst jsonb;
