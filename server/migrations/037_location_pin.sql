-- Pinned place (2026-11-11): the person can pin their shared place by hand (Account ›
-- ตั้งค่าพิเศษ). While pinned, live updates from the page and the iOS app are not saved, and
-- the partner sees the place marked as a pin (📌 ปักหมุด), never as a live location.
alter table user_locations add column pinned boolean not null default false;
