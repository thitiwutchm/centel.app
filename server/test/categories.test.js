// The person's own categories travel in prefs. Needs a running API (API_URL) on a disposable database.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3999';
const run = crypto.randomBytes(4).toString('hex');

function agent() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(API + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-centel': '1', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

test('a long category list with sub-categories syncs through prefs', async () => {
  const A = agent();
  await A.post('/auth/register', { email: `ca${run}@t.dev`, password: 'password-a', name: 'A' });
  // ~150 categories is well past the old 10k prefs cap.
  const cats = Array.from({ length: 150 }, (_, i) => ({
    id: `c_${i}`, type: 'expense', label: `Category number ${i} with a long name`, icon: '🏷️', color: '#3d8fe0',
    parent: i % 4 ? 'c_0' : undefined,
  }));
  const prefs = { hideBalance: false, cats, catMoved: { pets: 'other_exp' } };
  assert.ok(JSON.stringify(prefs).length > 10000);
  assert.equal((await A.put('/prefs', { data: prefs })).ok, true);

  const id = crypto.randomUUID();
  await A.post('/expenses', { id, type: 'expense', amount: 640, date: '2026-10-20', category: 'c_5' });
  const bs = await A.get('/bootstrap');
  assert.equal(bs.prefs.cats.length, 150);
  assert.equal(bs.prefs.cats[5].parent, 'c_0');
  assert.deepEqual(bs.prefs.catMoved, { pets: 'other_exp' });
  assert.equal(bs.expenses.find((e) => e.id === id).category, 'c_5');
});
