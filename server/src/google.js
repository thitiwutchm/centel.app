import crypto from 'node:crypto';

// Verifies a Google Identity Services ID token (a JWT signed with RS256) against
// Google's published keys, without a client library.
const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
let keys = { at: 0, byKid: new Map() };

export const googleClientId = () => process.env.GOOGLE_CLIENT_ID || '';

async function signingKey(kid) {
  // Google rotates keys every few days; refetch hourly or when a kid is new.
  if (!keys.byKid.has(kid) || Date.now() - keys.at > 3600000) {
    const res = await fetch(process.env.GOOGLE_CERTS_URL || CERTS);
    if (!res.ok) throw new Error(`google certs ${res.status}`);
    const { keys: list } = await res.json();
    keys = { at: Date.now(), byKid: new Map(list.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])) };
  }
  return keys.byKid.get(kid);
}

const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Returns the token's claims, or null when it is not a valid token for this app.
export async function verifyGoogleIdToken(token, audience = googleClientId(), now = Date.now()) {
  const [h, p, sig] = String(token || '').split('.');
  if (!h || !p || !sig || !audience) return null;
  let header, claims;
  try { header = part(h); claims = part(p); } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const key = await signingKey(header.kid);
  if (!key) return null;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'));
  if (!ok) return null;
  const secs = now / 1000;
  if (claims.aud !== audience || !ISSUERS.includes(claims.iss)) return null;
  if (!(claims.exp > secs - 60) || (claims.iat && claims.iat > secs + 300)) return null;
  if (!claims.sub) return null;
  return claims;
}
