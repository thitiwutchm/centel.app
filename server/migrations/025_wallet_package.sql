-- Packages (2026-11-03): a wallet of type 'package' holds a prepaid package, paid in one go
-- and used many times (e.g. 16,000 for 20 sessions). pkg = { price, uses, category, merchant };
-- each use is recorded as an expense of one share out of the wallet. Null for other wallets.
alter table wallets add column if not exists pkg jsonb;
