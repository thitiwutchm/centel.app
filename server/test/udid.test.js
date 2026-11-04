// UDID profile reply parsing (no API needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUdidReply } from '../src/udid.js';

const plist = (udid) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PRODUCT</key><string>iPhone17,1</string>
<key>UDID</key><string>${udid}</string>
<key>VERSION</key><string>23B85</string>
</dict></plist>`;

test('udid: reads the UDID out of the signed reply', () => {
  const signed = Buffer.concat([Buffer.from([0x30, 0x80, 0x06, 0x09]), Buffer.from(plist('00008140-001A2B3C4D5E801C')), Buffer.from([0xa0, 0x80])]);
  assert.deepEqual(parseUdidReply(signed), { udid: '00008140-001A2B3C4D5E801C', product: 'iPhone17,1', version: '23B85' });
});

test('udid: rejects junk and bad UDIDs', () => {
  assert.equal(parseUdidReply(Buffer.from('hello')), null);
  assert.equal(parseUdidReply(Buffer.from(plist('<script>'))), null);
  assert.equal(parseUdidReply(Buffer.from(plist('abc'))), null);
});
