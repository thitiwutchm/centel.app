// Traveller mode (Account › โหมดนักเดินทาง): new transactions start in the currency of the
// country you're in, found from the device location, or one picked by hand. Kept in
// money.prefs.travel = { on, auto, currency, country, at } so it syncs with the account.

// ISO 3166 country → ISO 4217 currency for the places people travel to (others: pick by hand).
const COUNTRY_CUR = (() => {
  const m = {};
  const add = (cur, list) => list.split(' ').forEach((c) => { m[c] = cur; });
  add('EUR', 'AT BE HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES AD MC SM VA ME XK');
  add('USD', 'US EC SV PA TL PR GU AS VI MH FM PW ZW');
  add('XOF', 'BJ BF CI GW ML NE SN TG');
  add('XAF', 'CM CF TD CG GQ GA');
  add('AUD', 'AU KI NR TV');
  add('NZD', 'NZ CK NU');
  add('CHF', 'CH LI');
  add('DKK', 'DK FO GL');
  add('NOK', 'NO SJ');
  add('GBP', 'GB IM JE GG');
  add('ILS', 'IL PS');
  Object.assign(m, {
    TH: 'THB', JP: 'JPY', CN: 'CNY', KR: 'KRW', TW: 'TWD', HK: 'HKD', MO: 'MOP', SG: 'SGD', MY: 'MYR', ID: 'IDR',
    PH: 'PHP', VN: 'VND', LA: 'LAK', KH: 'KHR', MM: 'MMK', BN: 'BND', IN: 'INR', LK: 'LKR', NP: 'NPR', BT: 'BTN',
    BD: 'BDT', PK: 'PKR', MV: 'MVR', MN: 'MNT', KZ: 'KZT', UZ: 'UZS', KG: 'KGS', TJ: 'TJS', TM: 'TMT', AF: 'AFN',
    AE: 'AED', SA: 'SAR', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR', JO: 'JOD', LB: 'LBP', IQ: 'IQD', IR: 'IRR',
    TR: 'TRY', GE: 'GEL', AM: 'AMD', AZ: 'AZN', EG: 'EGP', MA: 'MAD', TN: 'TND', DZ: 'DZD', ZA: 'ZAR', KE: 'KES',
    TZ: 'TZS', UG: 'UGX', RW: 'RWF', ET: 'ETB', NG: 'NGN', GH: 'GHS', MU: 'MUR', SC: 'SCR', MG: 'MGA', NA: 'NAD',
    BW: 'BWP', ZM: 'ZMW', MZ: 'MZN', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP', PE: 'PEN', CO: 'COP',
    UY: 'UYU', BO: 'BOB', PY: 'PYG', CR: 'CRC', GT: 'GTQ', DO: 'DOP', CU: 'CUP', JM: 'JMD', BS: 'BSD', IS: 'ISK',
    SE: 'SEK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', RS: 'RSD', BA: 'BAM', MK: 'MKD', AL: 'ALL',
    MD: 'MDL', UA: 'UAH', BY: 'BYN', RU: 'RUB', FJ: 'FJD', PG: 'PGK',
  });
  return m;
})();

const travel = { busy: false };

/* ---------- Converting foreign amounts to baht ---------- */

// The exchange / card fee added on top of the day's rate, in percent. Set in Traveller
// settings; 2.5 is about what Thai cards charge abroad, 0 uses the rate as it is.
const FX_FEE_DEFAULT = 2.5;
function fxFee() {
  const t = money.prefs.travel;
  const f = t && t.fee != null ? Number(t.fee) : FX_FEE_DEFAULT;
  return f >= 0 && f <= 20 ? f : FX_FEE_DEFAULT;
}
// Rates exist up to today only.
function fxDay(date) {
  const today = dateStr(new Date());
  return !date || date > today ? today : date;
}
// Baht for one unit of cur on a day: { rate, rateDate, src }. Signed in, the API looks it up and
// keeps it (Bank of Thailand first); signed out, the app asks Frankfurter itself.
const fxCache = new Map();
function fxRate(cur, date) {
  const key = `${cur}|${date}`;
  if (fxCache.has(key)) return fxCache.get(key);
  const p = (async () => {
    if (isCloud()) return api('GET', `/fx?cur=${encodeURIComponent(cur)}&date=${encodeURIComponent(date)}`);
    for (const bot of [true, false]) {
      const r = await fetch(`https://api.frankfurter.dev/v2/rates?date=${date}&base=${encodeURIComponent(cur)}&quotes=THB${bot ? '&providers=bot' : ''}`);
      const j = r.ok ? await r.json() : [];
      const row = Array.isArray(j) && j.find((x) => x && x.quote === 'THB');
      if (row && row.rate > 0) return { rate: row.rate, rateDate: row.date, src: bot ? 'bot' : 'frankfurter' };
    }
    throw new Error('fx_unavailable');
  })();
  fxCache.set(key, p);
  p.catch(() => fxCache.delete(key));
  return p;
}
const fxThb = (amt, rate, fee) => Math.round(amt * rate * (1 + (fee || 0) / 100) * 100) / 100;
// What a converted transaction keeps: the slip's amount and currency, the rate and its date, the fee.
function fxOf(cur, amt, r, fee) {
  const o = { cur, amt, rate: r.rate, date: r.rateDate, src: r.src };
  if (fee > 0) o.fee = fee;
  return o;
}
const FX_SRC = { bot: 'ธปท.', frankfurter: 'ธนาคารกลาง', fawaz: 'ตลาด', manual: 'กำหนดเอง' };
// "≈ ฿2,179.20 · 1 JPY = ฿0.2126 (ธปท. 15 ต.ค.) + 2.5%"
function fxLine(cur, amt, r, fee) {
  const rate = r.rate >= 1 ? r.rate.toFixed(2) : r.rate < 0.01 ? r.rate.toPrecision(3) : r.rate.toFixed(4);
  const parts = [`1 ${esc(cur)} = ฿${rate}`, `${FX_SRC[r.src] || ''} ${r.rateDate ? thDate(r.rateDate) : ''}`.trim()];
  if (fee > 0) parts.push(`ค่าธรรมเนียม ${fee}%`);
  return `${amt > 0 ? `<b>≈ ${baht(fxThb(amt, r.rate, fee))}</b> · ` : ''}${parts.join(' · ')}`;
}
function travelPrefs() { return money.prefs.travel || (money.prefs.travel = { on: false, auto: true, currency: 'THB' }); }

// The currency new transactions start in, or '' when Traveller mode is off.
function travelCurrency() {
  const t = money.prefs.travel;
  return t && t.on && t.currency && t.currency !== 'THB' ? t.currency : '';
}

function travelCountryName(cc) {
  try { return new Intl.DisplayNames([LANG === 'en' ? 'en' : 'th'], { type: 'region' }).of(cc); } catch (e) { return cc; }
}

// Device location → country code. The lookup service gets the coordinates only.
function travelLocate(quiet) {
  if (travel.busy) return;
  if (!navigator.geolocation) { if (!quiet) toast('เครื่องนี้ไม่รองรับตำแหน่ง'); return; }
  travel.busy = true;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude, longitude } = pos.coords;
      const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude.toFixed(3)}&longitude=${longitude.toFixed(3)}&localityLanguage=en`);
      const cc = r.ok ? String((await r.json()).countryCode || '').toUpperCase() : '';
      if (!/^[A-Z]{2}$/.test(cc)) throw new Error('no_country');
      const t = travelPrefs();
      const was = t.currency;
      t.country = cc;
      t.at = Date.now();
      if (t.auto && COUNTRY_CUR[cc]) t.currency = COUNTRY_CUR[cc];
      savePrefs();
      if (ui.tab === 'account') render();
      if (!quiet || was !== t.currency) toast(`${curFlag(t.currency)} ${travelCountryName(cc)} · ใช้สกุลเงิน ${t.currency}`);
    } catch (e) {
      if (!quiet) toast('หาประเทศจากตำแหน่งไม่ได้ เลือกสกุลเงินเองได้');
    } finally { travel.busy = false; }
  }, (err) => {
    travel.busy = false;
    if (!quiet) toast(err && err.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง เปิดได้ที่ ตั้งค่า > ความเป็นส่วนตัว > บริการหาตำแหน่ง' : 'หาตำแหน่งไม่ได้ ลองใหม่อีกครั้ง');
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 30 * 60000 });
}

// Opening the app abroad picks up the new country, but only once location is already allowed.
async function travelRefresh() {
  const t = money.prefs.travel;
  if (!t || !t.on || !t.auto || (t.at && Date.now() - t.at < 3 * 3600000)) return;
  try {
    if (!navigator.permissions) return;
    if ((await navigator.permissions.query({ name: 'geolocation' })).state !== 'granted') return;
  } catch (e) { return; }
  travelLocate(true);
}

function travelSettings() {
  const t = travelPrefs();
  const where = t.country ? `${curFlag(t.country)} ${esc(travelCountryName(t.country))}` : '';
  return `
    <div class="section-title">✈️ โหมดนักเดินทาง</div>
    <div class="form">
      <div class="field"><label for="trOn">Traveller</label><span style="flex:1"></span>
        <label class="switch"><input type="checkbox" id="trOn" data-travel="on" ${t.on ? 'checked' : ''}><span></span></label></div>
      ${t.on ? `
      <div class="field"><label for="trAuto">เลือกจากตำแหน่งอัตโนมัติ</label><span style="flex:1"></span>
        <label class="switch"><input type="checkbox" id="trAuto" data-travel="auto" ${t.auto ? 'checked' : ''}><span></span></label></div>
      <div class="field"><label>สกุลเงินที่ใช้</label><span style="flex:1"></span>
        <button type="button" class="cur-chip" data-travel="pick">${curFlag(t.currency)} ${esc(t.currency)}</button></div>` : ''}
      <div class="field"><label for="trFee">ค่าธรรมเนียมแลกเงิน</label><span style="flex:1"></span>
        <input id="trFee" class="fee-in" data-travel="fee" type="number" inputmode="decimal" min="0" max="20" step="0.1" value="${fxFee()}"><span class="fee-pct">%</span></div>
    </div>
    ${t.on ? `<button class="btn ghost" data-travel="locate">📍 ตรวจตำแหน่งตอนนี้</button>` : ''}
    <p class="hint">${t.on
      ? `รายการใหม่จะเริ่มที่สกุล ${esc(t.currency)}${where ? ` · ตำแหน่งล่าสุด ${where}` : ''}`
      : 'เปิดตอนไปต่างประเทศ แอปจะใช้ตำแหน่งเพื่อเลือกสกุลเงินของประเทศที่อยู่ให้รายการใหม่เอง'}</p>
    <p class="hint">รายการเงินต่างประเทศแปลงเป็นบาทตอนบันทึก ด้วยอัตราแลกเปลี่ยนเฉลี่ยของธนาคารพาณิชย์ที่แบงก์ชาติประกาศวันนั้น (วันหยุดใช้วันทำการก่อนหน้า) บวกค่าธรรมเนียมนี้ แนะนำ 2.5% ตามที่บัตรส่วนใหญ่คิด ใส่ 0 ถ้าใช้เรทตรงๆ</p>`;
}

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-travel]');
  if (!el) return;
  const t = travelPrefs();
  if (el.dataset.travel === 'on') {
    t.on = el.checked;
    savePrefs();
    render();
    if (t.on && t.auto) travelLocate(false);
  } else if (el.dataset.travel === 'fee') {
    const f = Math.round(Number(el.value) * 100) / 100;
    t.fee = f >= 0 && f <= 20 ? f : FX_FEE_DEFAULT;
    el.value = t.fee;
    savePrefs();
    toast(`ค่าธรรมเนียมแลกเงิน ${t.fee}%`);
  } else if (el.dataset.travel === 'auto') {
    t.auto = el.checked;
    savePrefs();
    render();
    if (t.auto) travelLocate(false);
  }
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('button[data-travel]');
  if (!el) return;
  const t = travelPrefs();
  if (el.dataset.travel === 'locate') travelLocate(false);
  else if (el.dataset.travel === 'pick') {
    currencyPicker(t.currency, (code) => { t.currency = code; t.auto = false; savePrefs(); render(); });
  }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') travelRefresh(); });
setTimeout(travelRefresh, 3000);
