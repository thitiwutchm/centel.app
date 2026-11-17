-- account.centel.app as its own MCP server for Claude / ChatGPT (2026-11-17).

-- Which sign-in an AI app registered with: Centel (centel.app/mcp) or the accounting app
-- (account.centel.app/mcp). A connection only works on the server it was made for, and each
-- app lists only its own connections.
alter table oauth_clients add column if not exists realm text not null default 'centel'
  check (realm in ('centel', 'acc'));

-- The AI app that created a document (null = made in the app), shown on the document and
-- in เชื่อมต่อระบบ › Claude / ChatGPT.
alter table acc_docs add column if not exists created_via text;
