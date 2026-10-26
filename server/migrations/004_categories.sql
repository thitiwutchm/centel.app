-- Expense categories now follow KB's list (money.js TX_CATS); move records off retired keys.
with m(old, new) as (values
  ('personal', 'beauty'), ('shopping', 'apparel'), ('creditpay', 'other_exp'), ('loan', 'rent'),
  ('insurance', 'rent'), ('entertainment', 'hangout'), ('family', 'baby'), ('education', 'other_exp'))
update expenses e set category = m.new from m where e.category = m.old;

with m(old, new) as (values
  ('personal', 'beauty'), ('shopping', 'apparel'), ('creditpay', 'other_exp'), ('loan', 'rent'),
  ('insurance', 'rent'), ('entertainment', 'hangout'), ('family', 'baby'), ('education', 'other_exp'))
update budgets b set category = m.new from m where b.category = m.old;
