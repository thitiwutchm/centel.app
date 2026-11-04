// verifyGoogleIdToken accepts the web and the iOS app's client ids (no API needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'aud-test';
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }));
});
let verify;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.GOOGLE_CERTS_URL = `http://localhost:${server.address().port}`;
  process.env.GOOGLE_CLIENT_ID = 'web-client';
  process.env.GOOGLE_IOS_CLIENT_ID = 'ios-client';
  ({ verifyGoogleIdToken: verify } = await import('../src/google.js'));
});
test.after(() => server.close());

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(aud) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid })}.${b64({ iss: 'https://accounts.google.com', aud, sub: '42', iat: now, exp: now + 3600 })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

test('google: web and iOS client ids are both accepted, others are not', async () => {
  assert.equal((await verify(idToken('web-client'))).sub, '42');
  assert.equal((await verify(idToken('ios-client'))).sub, '42');
  assert.equal(await verify(idToken('someone-else')), null);
  assert.equal(await verify(idToken('ios-client'), 'web-client'), null);
});
