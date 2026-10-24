import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// numeric → number, date → 'YYYY-MM-DD' string (no timezone shifts).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
});

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const dir = path.join(here, '..', 'migrations');
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(424242)');
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await client.query('begin');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
        console.log(`migrated ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

// Runs fn inside a transaction as app_user for this person, so every query is
// filtered by the row level security policies in the migrations.
export async function asUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role app_user');
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
