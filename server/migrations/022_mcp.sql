-- Connect Claude / ChatGPT (2026-11-02). Centel is a remote MCP server at /mcp that AI
-- apps can read (never change) on the person's behalf. The apps sign in with OAuth 2.1
-- (dynamic client registration + PKCE): the person sees a consent page on centel.app,
-- taps อนุญาต, and the app gets an access token for that one account.
-- Only the api's own connection reads these tables, so app_user gets no grant; the
-- tools themselves then read data as app_user, under the same row level security as the app.

-- Apps that registered themselves (Claude, ChatGPT, …). Anyone may register; a client
-- is nothing until a signed-in person approves it on the consent page.
create table oauth_clients (
  id            text primary key,
  secret_hash   text,
  name          text not null,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now()
);

-- One approval of one app by one person. Revoking it from the Account tab cuts off
-- every token issued under it.
create table oauth_grants (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users on delete cascade,
  client_id    text not null references oauth_clients on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index oauth_grants_user on oauth_grants (user_id);

-- Authorization codes (10 minutes, used once) and tokens, kept as sha256 hashes.
create table oauth_codes (
  code_hash      text primary key,
  grant_id       uuid not null references oauth_grants on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  expires_at     timestamptz not null
);

create table oauth_tokens (
  token_hash text primary key,
  grant_id   uuid not null references oauth_grants on delete cascade,
  kind       text not null check (kind in ('access', 'refresh')),
  expires_at timestamptz not null
);
create index oauth_tokens_grant on oauth_tokens (grant_id);

-- Bills live on the person's device (localStorage). While an AI app is connected the
-- app sends a read-only copy here: the bill list and each bill's months around today.
create table mcp_bills (
  user_id    uuid primary key references users on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
