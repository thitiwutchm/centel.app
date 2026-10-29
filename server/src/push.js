import webpush from 'web-push';
import { pool } from './db.js';

/* Web Push: real notifications on iPhone (iOS 16.4+, app added to the Home Screen) and
   in desktop browsers. The app subscribes in the Account tab and sends the subscription
   here (push_subs). Due to-do notes are pushed by the reminder job in line.js; bill alerts
   are worked out on the device (bills live there) and stored in push_alerts until due.
   The VAPID key pair comes from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or is made once
   and kept in push_keys, so nothing has to be set up on Railway. */

const SUBJECT = process.env.VAPID_SUBJECT || 'https://centel.app';
let keys = null;

export async function pushKeys() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const made = webpush.generateVAPIDKeys();
    await pool.query('insert into push_keys (public_key, private_key) values ($1, $2) on conflict (id) do nothing', [made.publicKey, made.privateKey]);
    const r = (await pool.query('select public_key, private_key from push_keys where id = 1')).rows[0];
    keys = { publicKey: r.public_key, privateKey: r.private_key };
  }
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  return keys;
}

// Sends { title, body, url, tag } to every device of these users. Devices the push
// service says are gone (404/410) are forgotten. Returns how many devices got it.
export async function pushTo(userIds, msg) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const subs = (await pool.query('select endpoint, p256dh, auth from push_subs where user_id = any($1)', [ids])).rows;
  if (!subs.length) return 0;
  await pushKeys();
  const payload = JSON.stringify({ title: msg.title, body: msg.body || '', url: msg.url || '/', tag: msg.tag || undefined });
  let ok = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600, urgency: 'high' });
      ok++;
      await pool.query('update push_subs set last_ok = now() where endpoint = $1', [s.endpoint]);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await pool.query('delete from push_subs where endpoint = $1', [s.endpoint]);
      else console.error('push', e.statusCode || '', e.body || e.message);
    }
  }));
  return ok;
}

// Only real push services (Apple, Google, Mozilla, Microsoft), so the api never posts to
// an address someone made up. PUSH_TEST_ORIGIN lets the tests use a stand-in.
const PUSH_HOST = /(^|\.)(push\.apple\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const TEST_ORIGIN = process.env.PUSH_TEST_ORIGIN || '';
function pushEndpoint(s) {
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' && PUSH_HOST.test(u.hostname)) || (!!TEST_ORIGIN && u.origin === TEST_ORIGIN);
  } catch (e) { return false; }
}

export async function saveSub(userId, sub, device) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!pushEndpoint(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return false;
  await pool.query(
    `insert into push_subs (endpoint, user_id, p256dh, auth, device) values ($1, $2, $3, $4, $5)
     on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`,
    [endpoint, userId, p256dh, auth, device || null]);
  return true;
}

export const dropSub = (userId, endpoint) =>
  pool.query('delete from push_subs where user_id = $1 and endpoint = $2', [userId, String(endpoint || '')]);

export async function subCount(userId) {
  return (await pool.query('select count(*)::int as n from push_subs where user_id = $1', [userId])).rows[0].n;
}

// Replaces this device's upcoming alerts. Alerts already sent keep their sent_at, so an
// alert sent once is not sent again when the device sends the same list.
export async function saveAlerts(userId, device, alerts) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const keep = alerts.map((a) => a.key);
    await client.query('delete from push_alerts where user_id = $1 and device = $2 and not (key = any($3))', [userId, device, keep]);
    for (const a of alerts) {
      await client.query(
        `insert into push_alerts (user_id, device, key, at, title, body, url) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id, device, key) do update set at = excluded.at, title = excluded.title, body = excluded.body, url = excluded.url,
           sent_at = case when push_alerts.at = excluded.at then push_alerts.sent_at end`,
        [userId, device, a.key, a.at, a.title, a.body, a.url]);
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Claims due alerts first (sent_at), then sends, like the note reminders. More than a
// day late is dropped. The same bill on two devices of one person goes out once.
export async function sendDueAlerts() {
  const { rows } = await pool.query(
    `update push_alerts set sent_at = now()
     where sent_at is null and at <= now() and at > now() - interval '1 day'
     returning user_id, key, title, body, url`);
  const seen = new Set();
  for (const a of rows) {
    const k = `${a.user_id}:${a.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    await pushTo([a.user_id], { title: a.title, body: a.body, url: a.url || '/', tag: a.key });
  }
  return rows.length;
}
