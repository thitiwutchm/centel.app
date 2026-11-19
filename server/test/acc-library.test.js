// คลังเอกสาร: folders and link cards. Needs a running API (API_URL) on a disposable database.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(API + '/api' + path, {
      method, headers: { 'content-type': 'application/json', 'x-centel': '1', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const A = client();
const B = client();
let P;

test('set up', async () => {
  await A('POST', '/auth/register', { email: `lib${run}@t.dev`, password: 'password-a', name: 'A' });
  await B('POST', '/auth/register', { email: `libb${run}@t.dev`, password: 'password-b', name: 'B' });
  P = `/acc/b/${(await A('POST', '/acc/businesses', { name: 'คลัง จำกัด' })).id}`;
});

test('folders, cards, moving and deleting', async () => {
  const f = (await A('POST', `${P}/library`, { kind: 'folder', name: 'สัญญา', color: 'blue' })).item;
  const sub = (await A('POST', `${P}/library`, { kind: 'folder', name: 'ปี 2569', parent: f.id })).item;
  assert.equal(sub.parent, f.id);
  const card = (await A('POST', `${P}/library`, { kind: 'link', url: 'drive.google.com/file/d/abc/view', parent: sub.id })).item;
  assert.equal(card.url, 'https://drive.google.com/file/d/abc/view');
  assert.equal(card.name, 'drive.google.com');
  assert.equal((await A('POST', `${P}/library`, { kind: 'link', url: 'javascript:alert(1)' })).error, 'bad_url');
  assert.equal((await A('POST', `${P}/library`, { kind: 'link', url: 'ftp://x.com/a' })).error, 'bad_url');
  // A folder can't go inside itself or its own subfolder.
  assert.equal((await A('PUT', `${P}/library/${f.id}`, { parent: sub.id })).error, 'bad_folder');
  assert.equal((await A('PUT', `${P}/library/${f.id}`, { parent: f.id })).error, 'bad_folder');
  assert.equal((await A('PUT', `${P}/library/${card.id}`, { parent: card.id })).error, 'bad_folder');
  const moved = (await A('PUT', `${P}/library/${card.id}`, { parent: null, name: 'สัญญาเช่า' })).item;
  assert.equal(moved.parent, null);
  assert.equal(moved.name, 'สัญญาเช่า');
  await A('PUT', `${P}/library/${card.id}`, { parent: sub.id });
  assert.equal((await A('GET', `${P}/library`)).items.length, 3);
  // Deleting a folder deletes what is inside it.
  assert.equal((await A('DELETE', `${P}/library/${f.id}`)).ok, true);
  assert.equal((await A('GET', `${P}/library`)).items.length, 0);
});

test('another person cannot see or change the library', async () => {
  const c = (await A('POST', `${P}/library`, { kind: 'link', url: 'https://example.com/x', name: 'x' })).item;
  assert.equal((await B('GET', `${P}/library`)).status, 404);
  assert.equal((await B('DELETE', `${P}/library/${c.id}`)).status, 404);
  const other = `/acc/b/${(await B('POST', '/acc/businesses', { name: 'อื่น' })).id}`;
  assert.equal((await B('DELETE', `${other}/library/${c.id}`)).status, 404);
  assert.equal((await B('PUT', `${other}/library/${c.id}`, { name: 'y' })).status, 404);
  const f = (await B('POST', `${other}/library`, { kind: 'folder', name: 'f' })).item;
  assert.equal((await B('PUT', `${other}/library/${f.id}`, { parent: c.id })).error, 'bad_folder');
});
