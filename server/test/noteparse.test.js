// The server's date reader for notes typed into the LINE group (no API needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNote, remindAt } from '../src/noteparse.js';

// 29 Oct 2026 23:20 in Thailand (a Thursday), while it is still the 29th 16:20 UTC.
const now = new Date('2026-10-29T16:20:00Z');
// endTime is left out of the expectations when there is none.
const p = (s) => { const { endTime, ...r } = parseNote(s, now); return endTime ? { ...r, endTime } : r; };

test('noteparse: Thai dates and times, with or without dots', () => {
  assert.deepEqual(p('18:00 น 31 ตค ไปแข่งกีฬาที่สนาม welcomedink'), { text: 'ไปแข่งกีฬาที่สนาม welcomedink', date: '2026-10-31', time: '18:00' });
  assert.deepEqual(p('18:00 น. 31 ต.ค. ไปแข่ง'), { text: 'ไปแข่ง', date: '2026-10-31', time: '18:00' });
  assert.deepEqual(p('พรุ่งนี้ 2 ทุ่ม กินข้าว'), { text: 'กินข้าว', date: '2026-10-30', time: '20:00' });
  assert.deepEqual(p('5 พค 2570 วันเกิด'), { text: 'วันเกิด', date: '2027-05-05', time: '' });
  assert.deepEqual(p('เสาร์ บ่าย 3 ล้างรถ'), { text: 'ล้างรถ', date: '2026-10-31', time: '15:00' });
});

test('noteparse: "น" and short months only when they stand alone', () => {
  assert.deepEqual(p('18:00 นัดหมอ'), { text: 'นัดหมอ', date: '2026-10-30', time: '18:00', timeOnly: true });
  assert.deepEqual(p('ไปตลาด'), { text: 'ไปตลาด', date: '', time: '' });
});

test('noteparse: time ranges and English month-first dates', () => {
  assert.deepEqual(p('ประชุม 31 ตค 10:00-12:00'), { text: 'ประชุม', date: '2026-10-31', time: '10:00', endTime: '12:00' });
  assert.deepEqual(p('พรุ่งนี้ 10.00 ถึง 12.30 น. ตลาด'), { text: 'ตลาด', date: '2026-10-30', time: '10:00', endTime: '12:30' });
  assert.deepEqual(p('นัดตรวจครรภ์แม่เฟิร์น , Nov 30, 11:00 AM - 12:00 PM'), { text: 'นัดตรวจครรภ์แม่เฟิร์น', date: '2026-11-30', time: '11:00', endTime: '12:00' });
  assert.deepEqual(p('Dec 1, 2027 trip'), { text: 'trip', date: '2027-12-01', time: '' });
  // An end before the start is dropped.
  assert.deepEqual(p('31 ตค 18:00-09:00 x'), { text: 'x', date: '2026-10-31', time: '18:00' });
});

test('noteparse: reminder time is in Thai time', () => {
  assert.equal(remindAt('2026-10-31', '18:00', 0).toISOString(), '2026-10-31T11:00:00.000Z');
  assert.equal(remindAt('2026-10-31', '', 60).toISOString(), '2026-10-31T01:00:00.000Z');
  assert.equal(remindAt('', '', 0), null);
});
