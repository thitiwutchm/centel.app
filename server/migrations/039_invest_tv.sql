-- EODHD's search (2026-11-12) says a US stock is on "US" without its exchange, so a trade's
-- TradingView symbol may now be bare (TLN); the widgets resolve it. SET stays SET:PTT.
alter table inv_trades drop constraint inv_trades_tv_check;
alter table inv_trades add constraint inv_trades_tv_check check (tv ~ '^([A-Z]{2,8}:)?[A-Z0-9.&_-]{1,20}$');
