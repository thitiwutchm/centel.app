import crypto from 'node:crypto';
import http2 from 'node:http2';

/* Apple Push (APNs) for the native iOS app (ios-app/). Web Push does not run inside the
   app's web view, so the app registers its APNs device token instead (push_apns) and
   pushTo() in push.js sends to both. Needs an APNs auth key (.p8) from
   developer.apple.com > Keys, set on the api service:
     APNS_KEY     the .p8 file's text (the BEGIN/END lines included; "\n" may be literal)
     APNS_KEY_ID  the key's 10-character Key ID
     APNS_TEAM_ID the Team ID (5274992QMF when unset)
     APNS_TOPIC   the app's bundle id (app.centel when unset)
   Ad Hoc / TestFlight / App Store builds use the production gateway, builds run from
   Xcode the sandbox one; a token stored for the wrong one is retried on the other once.
   APNS_TEST_ORIGIN (an http:// h2c origin) lets the tests use a stand-in. */

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const TEST_ORIGIN = process.env.APNS_TEST_ORIGIN || '';
const TOPIC = () => process.env.APNS_TOPIC || 'app.centel';

export function apnsEnabled() {
  return !!(process.env.APNS_KEY && process.env.APNS_KEY_ID);
}

let jwt = null; // { token, at }
function providerToken() {
  // Apple wants a fresh token at most once every 20 minutes and refuses ones older than an hour.
  if (jwt && Date.now() - jwt.at < 40 * 60000) return jwt.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'ES256', kid: process.env.APNS_KEY_ID })}.${b64({ iss: process.env.APNS_TEAM_ID || '5274992QMF', iat })}`;
  const key = crypto.createPrivateKey(String(process.env.APNS_KEY).replace(/\\n/g, '\n'));
  const sig = crypto.sign('sha256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwt = { token: `${head}.${sig}`, at: Date.now() };
  return jwt.token;
}

// One HTTP/2 connection per gateway, made when first needed and dropped when it closes.
const sessions = {};
function session(env) {
  const origin = TEST_ORIGIN || HOSTS[env];
  const s = sessions[origin];
  if (s && !s.closed && !s.destroyed) return s;
  const made = http2.connect(origin);
  made.on('error', (e) => console.error('apns', env, e.message));
  made.on('close', () => { if (sessions[origin] === made) delete sessions[origin]; });
  made.setTimeout(10 * 60000, () => made.close());
  sessions[origin] = made;
  return made;
}

// -> { status, reason }
function post(env, token, payload, headers) {
  return new Promise((resolve) => {
    let req;
    try {
      req = session(env).request({
        ':method': 'POST', ':path': `/3/device/${token}`,
        authorization: `bearer ${providerToken()}`, 'apns-topic': TOPIC(), 'apns-push-type': 'alert',
        'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
        'content-type': 'application/json', ...headers,
      });
    } catch (e) { resolve({ status: 0, reason: e.message }); return; }
    let status = 0;
    let body = '';
    req.setTimeout(15000, () => { req.close(); resolve({ status: 0, reason: 'timeout' }); });
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let reason = '';
      try { reason = JSON.parse(body).reason || ''; } catch (e) { /* empty body on success */ }
      resolve({ status, reason });
    });
    req.on('error', (e) => resolve({ status: 0, reason: e.message }));
    req.end(payload);
  });
}

// msg { title, body, url, tag }. -> 'ok' | 'gone' (forget the token) | 'failed'
// | { env } when it only went through on the other gateway (store that one).
export async function apnsSend(token, env, msg) {
  const payload = JSON.stringify({
    aps: { alert: { title: msg.title, body: msg.body || '' }, sound: 'default', ...(msg.tag ? { 'thread-id': String(msg.tag).slice(0, 64) } : {}) },
    url: msg.url || '/',
  });
  const headers = msg.tag ? { 'apns-collapse-id': String(msg.tag).slice(0, 64) } : {};
  const first = env === 'sandbox' ? 'sandbox' : 'production';
  let r = await post(first, token, payload, headers);
  if (r.status === 200) return 'ok';
  if (r.status === 400 && r.reason === 'BadDeviceToken') {
    const other = first === 'production' ? 'sandbox' : 'production';
    r = await post(other, token, payload, headers);
    if (r.status === 200) return { env: other };
  }
  if (r.status === 410 || (r.status === 400 && (r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic'))) return 'gone';
  console.error('apns', r.status, r.reason);
  return 'failed';
}
