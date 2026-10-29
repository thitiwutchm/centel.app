import Anthropic from '@anthropic-ai/sdk';
import { aiEnabled } from './receipts.js';
import { thaiToday } from './noteparse.js';

/* Reads a note typed into the LINE group when parseNote() finds no date in it
   ("เสาร์นี้หลังเลิกงานไปตลาด"), so only the hard lines cost a model call. */

export const NOTE_MODEL = process.env.NOTE_MODEL || 'claude-haiku-5-5';
const client = aiEnabled ? new Anthropic() : null;

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'date', 'time'],
  properties: {
    text: { type: 'string', description: 'What to do, in the words of the message, without the date, time and command words' },
    date: nullable({ type: 'string', description: 'YYYY-MM-DD in the Gregorian calendar, or null when the message gives no day' }),
    time: nullable({ type: 'string', description: 'HH:MM in 24-hour time, or null when the message gives no time' }),
  },
};

const SYSTEM = `You turn a short Thai or English message from a family LINE group into a to-do note with a date and time.
- Dates are in Thailand (UTC+7). Thai years may be Buddhist Era (2569 = 2026). Resolve words like พรุ่งนี้, มะรืน, เสาร์นี้, อาทิตย์หน้า, สิ้นเดือน, ต้นเดือนหน้า from today's date given in the message; a day with no month is the next one to come.
- Thai clock words: X โมงเช้า = X:00, บ่าย X (โมง) = 12+X, X โมงเย็น = 12+X, X ทุ่ม = 18+X, ตีX = X:00, เที่ยง = 12:00, เที่ยงคืน = 00:00. Loose times: เช้า 09:00, หลังเลิกงาน 18:00, เย็น 17:00, ค่ำ 19:00.
- text keeps the place and people as written. Do not invent anything the message does not say.`;

// Returns { text, date, time } or null when there is no AI or the call fails.
export async function aiReadNote(message, now = new Date()) {
  if (!client) return null;
  const t = thaiToday(now);
  try {
    const response = await client.beta.messages.create({
      model: NOTE_MODEL,
      max_tokens: 400,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Today is ${t.weekday} ${t.date}, ${t.time} in Thailand.\n\nMessage:\n${message}` }],
    });
    if (response.stop_reason !== 'end_turn') return null;
    const r = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') && !Number.isNaN(Date.parse(r.date)) ? r.date : '';
    const time = date && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || '') ? r.time : '';
    return { text: String(r.text || '').trim() || message, date, time };
  } catch (e) {
    console.error('note ai', e.message);
    return null;
  }
}
