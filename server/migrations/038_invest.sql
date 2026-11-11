-- Investment portfolio (invest.centel.app, 2026-11-11). Each person records their own buys,
-- sells and dividends; holdings, average cost and profit are worked out from these rows in
-- the page. Only Thai SET and US stocks / ETFs for now.
--   symbol: Yahoo Finance symbol (PTT.BK, AAPL), what prices are fetched by
--   tv:     TradingView symbol (SET:PTT, NASDAQ:AAPL), what the chart widgets show
--   kind:   buy | sell | div (div: price is the total cash received, qty is 0)
create table inv_trades (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users on delete cascade default app_uid(),
  symbol     text not null check (symbol ~ '^[A-Z0-9][A-Z0-9.&-]{0,19}$'),
  tv         text not null check (tv ~ '^[A-Z]{2,8}:[A-Z0-9.&_-]{1,20}$'),
  name       text,
  currency   text not null check (currency in ('THB', 'USD')),
  kind       text not null check (kind in ('buy', 'sell', 'div')),
  date       date not null,
  qty        numeric(18, 6) not null default 0 check (qty >= 0),
  price      numeric(18, 6) not null check (price >= 0),
  fee        numeric(14, 2) not null default 0 check (fee >= 0),
  note       text,
  created_at timestamptz not null default now()
);
create index inv_trades_user on inv_trades (user_id, date);

grant select, insert, update, delete on inv_trades to app_user;
alter table inv_trades enable row level security;
create policy own on inv_trades for all to app_user using (user_id = app_uid()) with check (user_id = app_uid());

-- Last known price of each symbol, shared by everyone (prices are public). Refreshed from
-- Yahoo Finance at most every 15 minutes, TradingView's scanner when Yahoo fails.
-- Only the api's own connection reads this table, so app_user gets no grant.
create table inv_prices (
  symbol     text primary key,
  price      numeric(18, 6) not null,
  prev_close numeric(18, 6),
  currency   text,
  name       text,
  src        text not null,
  market_at  timestamptz,
  at         timestamptz not null default now()
);
