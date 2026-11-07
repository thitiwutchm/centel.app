-- Foreign-currency conversion (2026-11-07). A transaction entered in another currency is saved
-- in baht: amount is THB and fx = { cur, amt, rate, date, src } keeps what the slip said and the
-- rate used (baht per unit, on the rate's own date). Null for baht entries and older rows.
alter table expenses add column if not exists fx jsonb;

-- Rates already looked up, per currency and day asked for. Only settled days are stored.
create table if not exists fx_rates (
  currency text not null,
  day date not null,
  rate numeric not null,
  rate_date date not null,
  src text not null,
  created_at timestamptz not null default now(),
  primary key (currency, day)
);
