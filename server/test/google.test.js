// Sign in with Google. Needs the API started with GOOGLE_CLIENT_ID=test-client and
// GOOGLE_CERTS_URL pointing at this test's key server (GOOGLE_TEST_PORT, default 3998).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const API = process.env.API_URL || 'http://localhost:3999';
const PORT = Number(process.env.GOOGLE_TEST_PORT || 3998);
const run = crypto.randomBytes(4).toString('hex');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'k' + run;

const keyServer = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }));
});
test.before(() => new Promise((r) => keyServer.listen(PORT, r)));
test.after(() => keyServer.close());

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64({ iss: 'https://accounts.google.com', aud: 'test-client', iat: now, exp: now + 3600, email_verified: true, ...claims })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

function agent() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(API + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-centel': '1', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}

test('config exposes the client id', async () => {
  assert.equal((await agent()('GET', '/config')).googleClientId, 'test-client');
});

test('first Google sign-in creates an account, the next one reuses it', async () => {
  const email = `g${run}@gmail.com`;
  const A = agent();
  assert.equal((await A('POST', '/auth/google', { credential: idToken({ sub: `s${run}`, email, name: 'Gee' }) })).ok, true);
  const me = (await A('GET', '/bootstrap')).user;
  assert.equal(me.email, email);
  assert.equal(me.name, 'Gee');
  const B = agent();
  assert.equal((await B('POST', '/auth/google', { credential: idToken({ sub: `s${run}`, email }) })).ok, true);
  assert.equal((await B('GET', '/bootstrap')).user.id, me.id);
  // A Google-only account has no password to log in with.
  assert.equal((await agent()('POST', '/auth/login', { email, password: 'whatever-pw' })).status, 401);
});

test('Google sign-in links to an email/password account with the same email', async () => {
  const email = `p${run}@gmail.com`;
  const A = agent();
  assert.equal((await A('POST', '/auth/register', { email, password: 'password-p', name: 'P' })).ok, true);
  const id = (await A('GET', '/bootstrap')).user.id;
  const G = agent();
  assert.equal((await G('POST', '/auth/google', { credential: idToken({ sub: `p${run}`, email: email.toUpperCase() }) })).ok, true);
  assert.equal((await G('GET', '/bootstrap')).user.id, id);
  assert.equal((await agent()('POST', '/auth/login', { email, password: 'password-p' })).ok, true);
  // A different Google account with the same email is refused.
  assert.equal((await agent()('POST', '/auth/google', { credential: idToken({ sub: `x${run}`, email }) })).status, 409);
});

test('bad tokens are refused', async () => {
  const C = agent();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const credential of [
    idToken({ sub: `b${run}`, email: `b${run}@gmail.com` }, other),
    idToken({ sub: `b${run}`, email: `b${run}@gmail.com`, aud: 'someone-else' }),
    idToken({ sub: `b${run}`, email: `b${run}@gmail.com`, iss: 'https://evil.example' }),
    idToken({ sub: `b${run}`, email: `b${run}@gmail.com`, exp: 1000 }),
    'not.a.token',
  ]) assert.equal((await C('POST', '/auth/google', { credential })).status, 401);
  assert.equal((await C('POST', '/auth/google', { credential: idToken({ sub: `b${run}`, email: `b${run}@x.dev`, email_verified: false }) })).status, 403);
  assert.equal((await C('GET', '/bootstrap')).status, 401);
});

test('profile: name and picture are saved, and the Google photo is offered only to its owner', async () => {
  const photo = `https://lh3.googleusercontent.com/a/p${run}=s96-c`;
  const A = agent();
  assert.equal((await A('POST', '/auth/google', { credential: idToken({ sub: `pf${run}`, email: `pf${run}@gmail.com`, name: 'Pf', picture: photo }) })).ok, true);
  assert.equal((await A('GET', '/bootstrap')).user.googlePicture, photo);
  assert.equal((await A('PUT', '/profile', { name: '  New name ', avatar: '🐼' })).avatar, '🐼');
  let me = (await A('GET', '/bootstrap')).user;
  assert.equal(me.name, 'New name');
  assert.equal(me.avatar, '🐼');
  assert.equal((await A('PUT', '/profile', { name: 'New name', avatar: photo })).avatar, photo);
  // Someone else's photo URL, markup and an empty name are refused or dropped.
  assert.equal((await A('PUT', '/profile', { name: 'New name', avatar: 'https://lh3.googleusercontent.com/a/other' })).avatar, null);
  assert.equal((await A('PUT', '/profile', { name: 'x', avatar: '<img src=x>' })).avatar, null);
  assert.equal((await A('PUT', '/profile', { name: ' ' })).status, 400);

  // An email/password account can fetch its photo from the Google account with the same email only.
  const E = agent();
  const email = `pe${run}@gmail.com`;
  assert.equal((await E('POST', '/auth/register', { email, password: 'password-pe', name: 'Pe' })).ok, true);
  assert.equal((await E('POST', '/profile/google', { credential: idToken({ sub: `o${run}`, email: `other${run}@gmail.com`, picture: photo }) })).status, 409);
  assert.equal((await E('POST', '/profile/google', { credential: idToken({ sub: `pe${run}`, email, picture: photo }) })).googlePicture, photo);
  assert.equal((await E('PUT', '/profile', { name: 'Pe', avatar: photo })).avatar, photo);
  assert.equal((await E('GET', '/bootstrap')).user.avatar, photo);
});
