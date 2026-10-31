-- Mac status dashboard (2026-10-31): each bridge reports the Mac's health (CPU, memory, disk,
-- Ollama, Hermes gateway, voice/web) every minute. The latest report sits on bridge_tokens and
-- one sample every 5 minutes goes into mac_samples for the 24-hour charts (kept 2 days).
alter table bridge_tokens add column status jsonb;
alter table bridge_tokens add column status_at timestamptz;
create table mac_samples (
  user_id uuid not null references users on delete cascade,
  at      timestamptz not null default now(),
  cpu     real,
  mem     real,
  disk    real,
  primary key (user_id, at)
);
