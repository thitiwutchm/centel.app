// Partner location: sharing switch, what the partner sees, the iOS app's background token,
// and the weather cache. The first tests need nothing; the rest need a running API
// (API_URL) started with OPEN_METEO_URL=http://localhost:3995 (the stand-in below).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { readPlace, parseWeather, wxStale, km, WX_TTL } from '../src/location.js';

test('readPlace keeps real coordinates and a short clean place name', () => {
  assert.deepEqual(readPlace({ lat: 13.7563309, lon: 100.5017651, acc: 35.4, place: '  บางนา,\n กรุงเทพฯ <b>' }),
    { lat: 13.75633, lon: 100.50177, acc: 35, place: 'บางนา, กรุงเทพฯ b' });
  assert.equal(readPlace({ lat: 91, lon: 0 }), null);
  assert.equal(readPlace({ lat: 0, lon: 0 }), null);
  assert.equal(readPlace({ lat: 'x', lon: 1 }), null);
  assert.equal(readPlace(null), null);
  assert.deepEqual(readPlace({ lat: '18.79', lon: '98.98' }), { lat: 18.79, lon: 98.98, acc: null, place: null });
});

test('parseWeather reads Open-Meteo current block', () => {
  assert.deepEqual(parseWeather({ current: { temperature_2m: 31.26, apparent_temperature: 36.4, weather_code: 2, is_day: 1 } }),
    { temp: 31.3, feels: 36.4, code: 2, day: true });
  assert.equal(parseWeather({}), null);
  assert.equal(parseWeather({ current: { temperature_2m: null } }), null);
});

test('weather is fetched again after 30 minutes or a move of more than 3 km', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');
  const row = { lat: 13.75, lon: 100.5, wx_lat: 13.75, wx_lon: 100.5, wx_at: new Date(now - 10 * 60000) };
  assert.equal(wxStale(row, now), false);
  assert.equal(wxStale({ ...row, wx_at: new Date(now - WX_TTL - 1000) }, now), true);
  assert.equal(wxStale({ ...row, lat: 13.8 }, now), true); // ~5.5 km north
  assert.equal(wxStale({ ...row, wx_at: null }, now), true);
  assert.equal(wxStale({ lat: null }, now), false);
  assert.ok(Math.abs(km(13.7563, 100.5018, 18.7883, 98.9853) - 585) < 10); // Bangkok → Chiang Mai
});

/* ---------- Through the API ---------- */

const API = process.env.API_URL;
const run = crypto.randomBytes(4).toString('hex');
let wxCalls = 0;
const stub = http.createServer((req, res) => {
  wxCalls += 1;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ current: { temperature_2m: 29.4, apparent_temperature: 33, weather_code: 61, is_day: 0 } }));
});

function agent() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(API + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-centel': '1', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const ping = (token, body) => fetch(API + '/api/location/ping', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

test('location through the API', { skip: !API && 'needs API_URL' }, async (t) => {
  await new Promise((r) => stub.listen(3995, r));
  t.after(() => stub.close());
  const A = agent(), B = agent(), C = agent();
  await A('POST', '/auth/register', { email: `la${run}@t.dev`, password: 'password-a', name: 'A', nickname: 'เอ' });
  await B('POST', '/auth/register', { email: `lb${run}@t.dev`, password: 'password-b', name: 'B', nickname: 'บี' });
  await C('POST', '/auth/register', { email: `lc${run}@t.dev`, password: 'password-c', name: 'C' });
  const { code } = await A('POST', '/couple/invite');
  await B('POST', '/couple/join', { code });

  // Nothing shared yet; no partner → partner null.
  assert.deepEqual(await A('GET', '/location'), { status: 200, me: { sharing: false, app: false }, partner: { sharing: false } });
  assert.deepEqual((await C('GET', '/location')).partner, null);
  assert.equal((await A('POST', '/location', { lat: 13.75, lon: 100.5 })).status, 409);
  assert.equal((await A('POST', '/location/token')).status, 409);
  assert.equal((await fetch(API + '/api/location')).status, 401);

  // A shares; B sees the place and the weather there.
  assert.deepEqual((await A('PUT', '/location/sharing', { on: true })).me, { sharing: true, app: false });
  const saved = await A('POST', '/location', { lat: 13.6683, lon: 100.6045, acc: 20, place: 'บางนา, กรุงเทพฯ' });
  assert.equal(saved.me.place, 'บางนา, กรุงเทพฯ');
  assert.equal(saved.me.wx.temp, 29.4);
  let seen = (await B('GET', '/location')).partner;
  assert.equal(seen.sharing, true);
  assert.equal(seen.place, 'บางนา, กรุงเทพฯ');
  assert.equal(seen.lat, 13.6683);
  assert.deepEqual({ ...seen.wx, at: undefined }, { temp: 29.4, feels: 33, code: 61, day: false, at: undefined });
  assert.equal(seen.src, 'app');
  assert.equal(seen.app, undefined); // the partner never learns about A's token
  assert.equal((await A('POST', '/location', { lat: 200, lon: 1 })).status, 400);

  // Weather is cached: reading again does not call Open-Meteo.
  const calls = wxCalls;
  await B('GET', '/location');
  await A('GET', '/location');
  assert.equal(wxCalls, calls);

  // The iOS app's background key.
  const { token } = await A('POST', '/location/token');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await A('GET', '/location')).me.app, true);
  assert.deepEqual(await ping(token, { lat: 18.7883, lon: 98.9853, place: 'เชียงใหม่' }), { status: 200, ok: true });
  seen = (await B('GET', '/location')).partner;
  assert.equal(seen.place, 'เชียงใหม่');
  assert.equal(seen.src, 'bg');
  assert.ok(wxCalls > calls, 'moved far: weather fetched again');
  // A small move without a place name keeps the name.
  await ping(token, { lat: 18.789, lon: 98.986 });
  assert.equal((await B('GET', '/location')).partner.place, 'เชียงใหม่');
  assert.equal((await ping('x'.repeat(43), { lat: 1, lon: 1 })).status, 410);
  assert.equal((await ping(token, { lat: 'no' })).status, 400);
  // A new key replaces the old one.
  const { token: t2 } = await A('POST', '/location/token');
  assert.equal((await ping(token, { lat: 18.7, lon: 98.9 })).status, 410);
  assert.equal((await ping(t2, { lat: 18.7, lon: 98.9 })).status, 200);

  // A pin: shown to the partner as a pin, and live updates don't move it.
  const pin = await A('PUT', '/location/pin', { lat: 7.8804, lon: 98.3923, place: 'ภูเก็ต' });
  assert.equal(pin.me.pinned, true);
  assert.equal(pin.me.src, 'pin');
  assert.deepEqual(await ping(t2, { lat: 18.7, lon: 98.9, place: 'เชียงใหม่' }), { status: 200, ok: true });
  assert.equal((await A('POST', '/location', { lat: 13.7, lon: 100.5 })).me.place, 'ภูเก็ต');
  seen = (await B('GET', '/location')).partner;
  assert.equal(seen.place, 'ภูเก็ต');
  assert.equal(seen.pinned, true);
  assert.equal((await A('PUT', '/location/pin', { lat: 999, lon: 1 })).status, 400);
  // Unpinned: the pin is dropped (never shown as live), then live updates come back.
  assert.deepEqual((await A('DELETE', '/location/pin')).me, { sharing: true, app: true });
  await ping(t2, { lat: 18.7, lon: 98.9, place: 'เชียงใหม่' });
  seen = (await B('GET', '/location')).partner;
  assert.equal(seen.place, 'เชียงใหม่');
  assert.equal(seen.pinned, undefined);

  // Off: the place is forgotten and the app's key stops working.
  assert.deepEqual((await A('PUT', '/location/sharing', { on: false })).me, { sharing: false, app: false });
  assert.deepEqual((await B('GET', '/location')).partner, { sharing: false });
  assert.equal((await ping(t2, { lat: 18.7, lon: 98.9 })).status, 410);
  // On again starts empty.
  await A('PUT', '/location/sharing', { on: true });
  assert.deepEqual((await B('GET', '/location')).partner, { sharing: true });
});
