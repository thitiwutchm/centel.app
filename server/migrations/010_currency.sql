-- The currency a transaction was entered in (ISO 4217 code). Totals still add the
-- amounts as they are; there is no conversion.
alter table expenses add column currency text not null default 'THB';
