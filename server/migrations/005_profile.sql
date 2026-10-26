-- A profile picture: an emoji, a small square image as a data URL (resized in the
-- browser), or the person's Google photo URL. Null shows the name's first letter.
-- google_picture is the photo from the last Google sign-in, offered in the profile sheet.
alter table users add column avatar text;
alter table users add column google_picture text;
grant select (avatar) on users to app_user;
