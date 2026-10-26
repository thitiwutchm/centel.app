-- Sign in with Google. A Google-only account has no password; google_sub is the
-- stable Google account id, linked to an existing account by verified email.
alter table users alter column password_hash drop not null;
alter table users add column google_sub text unique;
