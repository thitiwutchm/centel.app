-- A wallet's own picture: an emoji, or a small square image as a data URL
-- (resized in the browser). Null shows the wallet type's icon.
alter table wallets add column icon text;
