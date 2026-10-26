// Nicknames (ชื่อเล่น) for the couple. Needs a running API (API_URL) on a disposable database.
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


test('nicknames are kept, required once sent, and shown to the partner', async () => {
  const A = agent();
  const B = agent();
  await A.post('/auth/register', { email: `na${run}@t.dev`, password: 'password-a', name: 'Tonkla Jaidee', nickname: ' ต้น ' });
  // An account from before nicknames: none set.
  await B.post('/auth/register', { email: `nb${run}@t.dev`, password: 'password-b', name: 'Nijawan Jaijam' });
  assert.equal((await A.get('/bootstrap')).user.nickname, 'ต้น');
  assert.equal((await B.get('/bootstrap')).user.nickname, undefined);

  const { code } = await A.post('/couple/invite');
  assert.equal((await B.post('/couple/join', { code })).ok, true);
  assert.equal((await B.get('/bootstrap')).partner.nickname, 'ต้น');

  assert.equal((await B.put('/profile', { name: 'Nijawan Jaijam', nickname: '  ' })).status, 400);
  const r = await B.put('/profile', { name: 'Nijawan Jaijam', nickname: 'แนน' });
  assert.equal(r.nickname, 'แนน');
  assert.equal((await A.get('/bootstrap')).partner.nickname, 'แนน');
  // Leaving it out (older clients) keeps it.
  await B.put('/profile', { name: 'Nijawan J.' });
  assert.equal((await B.get('/bootstrap')).user.nickname, 'แนน');
});
