// iPhone UDID lookup for Ad Hoc installs. /udid/ hands out a "Profile Service"
// .mobileconfig; iOS then POSTs a signed plist (PKCS#7 around XML) here with the
// device's UDID, and we send Safari back to /udid/ to show it. Nothing is stored.

const pick = (xml, key) => {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,100})</string>`));
  return m ? m[1].trim() : '';
};

// The XML plist sits in the clear inside the PKCS#7 envelope, so no signature parsing is needed.
export function parseUdidReply(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>', start);
  if (start < 0 || end < 0) return null;
  const xml = text.slice(start, end + 8);
  const udid = pick(xml, 'UDID');
  if (!/^[0-9A-Fa-f-]{24,40}$/.test(udid)) return null;
  const clean = (s) => s.replace(/[^\w ,.()-]/g, '').slice(0, 40);
  return { udid, product: clean(pick(xml, 'PRODUCT')), version: clean(pick(xml, 'VERSION')) };
}

export function udidReply(req, res) {
  const r = parseUdidReply(req.body);
  const q = r ? new URLSearchParams(r).toString() : 'error=1';
  // iOS only follows a 301 from the profile service back into Safari.
  res.redirect(301, `https://centel.app/udid/?${q}`);
}
