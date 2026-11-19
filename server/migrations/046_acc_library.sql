-- คลังเอกสาร (document library) for account.centel.app, 2026-11-19: folders and cards. A card is
-- a name plus a link to where the file really lives (Google Drive, OneDrive, Dropbox …); nothing
-- is uploaded here. Folders can sit inside folders; deleting a folder deletes what is inside it.
create table if not exists acc_library (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references acc_businesses on delete cascade,
  parent_id   uuid references acc_library on delete cascade,
  kind        text not null check (kind in ('folder', 'link')),
  name        text not null,
  url         text check (url is null or url ~ '^https?://'),
  note        text,
  color       text,
  created_by  uuid references users on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((kind = 'link') = (url is not null))
);
create index if not exists acc_library_biz on acc_library (business_id, parent_id);

grant select, insert, update, delete on acc_library to app_user;
alter table acc_library enable row level security;
create policy member on acc_library for all to app_user using (acc_can(business_id)) with check (acc_can(business_id));
