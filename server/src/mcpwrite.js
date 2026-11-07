import crypto from 'node:crypto';
import { fail, ToolError } from './mcpcore.js';

/* How the MCP server changes data on the person's behalf (notes, to-dos, budgets and
   transactions). Every write tool goes through runTool():

   - Scope: the connection must have been approved for that kind of change (oauth.js).
   - Idempotency: a tool called again with the same idempotency_key and the same details
     answers with the first result and changes nothing (mcp_idem).
   - Confirmation: deletes and money changes first answer with a preview and a
     confirm_token; nothing changes until the same call comes back with that token, within
     10 minutes, once (mcp_confirms). The token is tied to the exact details previewed.
   - Audit: each change is recorded with the row before and after (mcp_audit), shown in the
     app under บัญชี › เชื่อมกับ AI, and can be undone there or with undo_change.

   All of it runs inside the tool's asUser() transaction, so a failed change leaves no
   token used, no key stored and no audit row. */

const CONFIRM_SEC = 600;
const KEY_RX = /^[\w.:\-]{8,200}$/;

// Stable JSON (sorted keys) of the details that matter, without the control fields.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export function argsHash(tool, a) {
  const { confirm_token: _c, idempotency_key: _k, ...rest } = a || {};
  return crypto.createHash('sha256').update(`${tool}\n${stable(rest)}`).digest('hex');
}

const NEEDS_CONFIRM = 'Nothing has been changed yet. Show the preview to the user in their language and ask them to confirm. Only after they clearly say yes, call this tool again with exactly the same arguments plus confirm_token. If they want something different, call it again with the new details (a new preview comes back).';

export async function runTool(tool, db, ctx, a, user) {
  if (!tool.scope) return tool.run(db, ctx, a, user);
  const hash = argsHash(tool.name, a);
  const key = a.idempotency_key;
  if (key != null) {
    if (typeof key !== 'string' || !KEY_RX.test(key)) fail('idempotency_key must be 8–200 letters, digits, dots, dashes, colons or underscores');
    const prev = (await db.query('select tool, args_hash, result from mcp_idem where key = $1', [key])).rows[0];
    if (prev) {
      if (prev.tool !== tool.name || prev.args_hash !== hash) fail('This idempotency_key was already used for a different request. Use a new key for a new request.');
      return { ...prev.result, replayed: true, note: 'Already done earlier with this idempotency_key; nothing was changed again.' };
    }
  }
  let out;
  if (tool.confirm) {
    const token = a.confirm_token;
    if (token != null) {
      if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/i.test(token)) fail('confirm_token is not valid. Call the tool again without it to get a new preview.');
      const c = (await db.query('select * from mcp_confirms where id = $1 for update', [token])).rows[0];
      if (!c) fail('Unknown confirm_token. Call the tool again without it to get a new preview.');
      if (c.tool !== tool.name || c.args_hash !== hash) fail('This confirm_token was given for different details. Nothing was changed. Show the user the new details and get a new preview (call without confirm_token).');
      if (c.used_at) {
        if (c.result) return { ...c.result, replayed: true, note: 'This confirmation was already used; nothing was changed again.' };
        fail('This confirm_token was already used.');
      }
      if (new Date(c.expires_at) < new Date()) fail('This confirm_token has expired (10 minutes). Call the tool again without it to get a new preview and confirm with the user again.');
      out = await tool.run(db, ctx, a, user);
      await db.query('update mcp_confirms set used_at = now(), result = $2 where id = $1', [token, JSON.stringify(out)]);
    } else {
      const preview = await tool.confirm(db, ctx, a, user);
      if (preview) {
        const id = crypto.randomUUID();
        await db.query('delete from mcp_confirms where expires_at < now() - interval \'1 day\'');
        await db.query('insert into mcp_confirms (id, tool, args_hash, preview, expires_at) values ($1, $2, $3, $4, $5)',
          [id, tool.name, hash, JSON.stringify(preview), new Date(Date.now() + CONFIRM_SEC * 1000)]);
        return { status: 'needs_confirmation', confirm_token: id, expires_in_seconds: CONFIRM_SEC, preview, message: NEEDS_CONFIRM };
      }
      out = await tool.run(db, ctx, a, user);
    }
  } else {
    out = await tool.run(db, ctx, a, user);
  }
  if (key != null) {
    await db.query('delete from mcp_idem where created_at < now() - interval \'30 days\'');
    await db.query('insert into mcp_idem (key, tool, args_hash, result) values ($1, $2, $3, $4)', [key, tool.name, hash, JSON.stringify(out)]);
  }
  return out;
}

/* ---------- Audit ---------- */

export async function audit(db, user, tool, entity, entityId, action, before, after, summary, undoOf = null) {
  const r = await db.query(
    `insert into mcp_audit (grant_id, client, tool, entity, entity_id, action, summary, before, after, undo_of)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [user?.grantId || null, user?.client || null, tool, entity, String(entityId), action, summary ? String(summary).slice(0, 300) : null,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, undoOf]);
  return Number(r.rows[0].id);
}

export const changeView = (c) => ({
  id: Number(c.id), at: c.created_at, app: c.client || undefined, tool: c.tool, entity: c.entity, entityId: c.entity_id,
  action: c.action, summary: c.summary || undefined, undone: !!c.undone_at, undoOf: c.undo_of ? Number(c.undo_of) : undefined,
});

export async function listChanges(db, { limit = 30, entity } = {}) {
  const rows = (await db.query(
    `select id, created_at, client, tool, entity, entity_id, action, summary, undo_of, undone_at from mcp_audit
     ${entity ? 'where entity = $2' : ''} order by id desc limit $1`, entity ? [limit, entity] : [limit])).rows;
  return rows.map(changeView);
}

/* ---------- Snapshots and restoring them (for undo) ---------- */

const NOTE_COLS = ['id', 'owner_id', 'couple_id', 'kind', 'text', 'body', 'tags', 'priority', 'in_progress', 'recurrence',
  'date', 'time', 'end_date', 'end_time', 'remind', 'remind_at', 'done', 'done_at', 'done_by'];
const BUDGET_COLS = ['id', 'owner_id', 'couple_id', 'scope', 'category', 'amount', 'wallet_id', 'name', 'period', 'start_date', 'end_date', 'merchant'];
const TXN_COLS = ['id', 'owner_id', 'couple_id', 'scope', 'type', 'date', 'merchant', 'amount', 'category', 'note', 'wallet_id',
  'to_wallet_id', 'payer_id', 'currency', 'fx', 'bill_id', 'bill_ym', 'review_needed', 'receipt_key', 'slip_ref'];

const pick = (row, cols) => (row ? Object.fromEntries(cols.map((k) => [k, row[k] instanceof Date ? row[k].toISOString() : row[k] ?? null])) : null);

export async function snapshot(db, entity, id) {
  if (entity === 'note') return pick((await db.query('select * from notes where id = $1', [id])).rows[0], NOTE_COLS);
  if (entity === 'budget') return pick((await db.query('select * from budgets where id = $1', [id])).rows[0], BUDGET_COLS);
  const row = pick((await db.query('select * from expenses where id = $1', [id])).rows[0], TXN_COLS);
  if (!row) return null;
  const shares = (await db.query('select user_id, amount from expense_shares where expense_id = $1 order by user_id', [id])).rows
    .map((s) => ({ user: s.user_id, amount: Number(s.amount) }));
  const labels = (await db.query('select label_id from expense_labels where expense_id = $1 order by label_id', [id])).rows.map((l) => l.label_id);
  return { ...row, shares, labels };
}

// Writes a note back to a snapshot (null = it did not exist).
async function restoreNote(db, id, s) {
  if (!s) {
    const r = await db.query('delete from notes where id = $1', [id]);
    if (!r.rowCount) fail('This note cannot be removed (only the person who made it can delete it).');
    return;
  }
  const vals = NOTE_COLS.slice(1).map((k) => s[k]);
  const sets = NOTE_COLS.slice(1).map((k, i) => `${k} = $${i + 2}`).join(', ');
  const up = await db.query(`update notes set ${sets}, notified_at = null, updated_at = now() where id = $1`, [id, ...vals]);
  if (!up.rowCount) await db.query(`insert into notes (${NOTE_COLS.join(', ')}) values (${NOTE_COLS.map((_, i) => `$${i + 1}`).join(', ')})`, [id, ...vals]);
  // A reminder time that has already gone by is not sent again.
  await db.query('update notes set notified_at = now() where id = $1 and remind_at <= now()', [id]);
}

async function restoreBudget(db, id, s) {
  if (!s) { await db.query('delete from budgets where id = $1', [id]); return; }
  const vals = BUDGET_COLS.slice(1).map((k) => s[k]);
  const sets = BUDGET_COLS.slice(1).map((k, i) => `${k} = $${i + 2}`).join(', ');
  const up = await db.query(`update budgets set ${sets} where id = $1`, [id, ...vals]);
  if (up.rowCount) return;
  await db.query(`insert into budgets (${BUDGET_COLS.join(', ')}) values (${BUDGET_COLS.map((_, i) => `$${i + 1}`).join(', ')})`, [id, ...vals]);
}

// Saves a transaction exactly as given (row + shares + my labels). Used to create, change
// and restore, with the same rules as POST/PUT /api/expenses: a shared row is written as a
// draft, gets its two shares, then submit_expense() records it.
export async function writeTxn(db, id, s) {
  const shared = s.scope === 'shared';
  const cols = ['scope', 'type', 'date', 'merchant', 'amount', 'category', 'note', 'wallet_id', 'to_wallet_id', 'payer_id',
    'currency', 'fx', 'bill_id', 'bill_ym', 'review_needed', 'receipt_key', 'slip_ref'];
  const vals = cols.map((k) => (k === 'review_needed' ? !!s[k] : k === 'currency' ? s[k] || 'THB' : s[k] ?? null));
  const status = shared ? 'draft' : 'approved';
  const up = await db.query(
    `update expenses set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')},
       couple_id = case when $2 = 'shared' then my_couple() end, status = '${status}', updated_at = now()
     where id = $1 and owner_id = app_uid()`, [id, ...vals]);
  if (!up.rowCount) {
    const exists = (await db.query('select 1 from expenses where id = $1', [id])).rowCount;
    if (exists) fail('Only the person who added this transaction can change it.');
    await db.query(
      `insert into expenses (id, owner_id, couple_id, status, ${cols.join(', ')})
       values ($1, app_uid(), case when $2 = 'shared' then my_couple() end, '${status}', ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
      [id, ...vals]);
  }
  await db.query('delete from expense_shares where expense_id = $1', [id]);
  if (shared) {
    const partner = (await db.query('select my_partner() as p')).rows[0].p;
    if (!partner) fail('No partner is linked, so a shared expense cannot be saved.');
    for (const sh of s.shares || []) await db.query('insert into expense_shares (expense_id, user_id, amount) values ($1, $2, $3)', [id, sh.user, sh.amount]);
    try {
      await db.query('select submit_expense($1)', [id]);
    } catch (e) {
      throw new ToolError(`The shared expense could not be saved (${e.message}).`);
    }
  }
  await db.query('delete from expense_labels where expense_id = $1', [id]);
  if (s.labels && s.labels.length) {
    await db.query('insert into expense_labels (expense_id, label_id) select $1, l.id from labels l where l.id = any($2::text[])', [id, s.labels]);
  }
}

async function restoreTxn(db, id, s) {
  if (!s) {
    const r = await db.query('delete from expenses where id = $1', [id]);
    if (!r.rowCount) fail('Only the person who added this transaction can delete it.');
    return;
  }
  await writeTxn(db, id, s);
}

const RESTORE = { note: restoreNote, budget: restoreBudget, transaction: restoreTxn };

// Compares two snapshots on what a person would notice (not timestamps).
const same = (a, b) => {
  const strip = (s) => s && Object.fromEntries(Object.entries(s).filter(([k]) => !k.endsWith('_at') && k !== 'done_by'));
  return stable(strip(a)) === stable(strip(b));
};

// Undoes one recorded change: puts the row back as it was before, if nobody changed it since.
// The change, if it can still be undone (not undone yet, item not changed since).
export async function undoable(db, id) {
  const c = (await db.query('select * from mcp_audit where id = $1 for update', [id])).rows[0];
  if (!c) fail(`No change ${id} found. Use list_changes.`);
  if (c.undone_at) fail(`Change ${id} was already undone.`);
  const now = await snapshot(db, c.entity, c.entity_id);
  if (!same(now, c.after)) fail(`This ${c.entity} was changed again after change ${id}, so it cannot be undone automatically. Undo the later changes first (list_changes) or edit it directly.`);
  return { c, now };
}

export async function undoChange(db, user, id, via = 'undo_change') {
  const { c, now } = await undoable(db, id);
  await RESTORE[c.entity](db, c.entity_id, c.before);
  const after = await snapshot(db, c.entity, c.entity_id);
  const action = !c.before ? 'delete' : !c.after ? 'create' : 'update';
  const undoId = await audit(db, user, via, c.entity, c.entity_id, action, now, after, `ย้อนกลับ: ${c.summary || c.tool}`, c.id);
  await db.query('update mcp_audit set undone_at = now() where id = $1', [c.id]);
  return { status: 'undone', undoneChangeId: Number(c.id), changeId: undoId, entity: c.entity, entityId: c.entity_id, restored: c.before ? 'previous version' : 'removed (it did not exist before)' };
}
