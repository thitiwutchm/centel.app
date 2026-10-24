import Anthropic from '@anthropic-ai/sdk';

export const RECEIPT_MODEL = process.env.RECEIPT_MODEL || 'claude-opus-5-5';
export const aiEnabled = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Keys match the expense categories in money.js.
export const EXPENSE_CATEGORIES = [
  'food', 'personal', 'shopping', 'transport', 'utility', 'creditpay', 'loan', 'home', 'health',
  'entertainment', 'family', 'education', 'beauty', 'insurance', 'gift', 'travel', 'other_exp',
];

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'date', 'amount', 'merchant', 'reference', 'category', 'purpose_known', 'confidence', 'note'],
  properties: {
    kind: { type: 'string', enum: ['bank_transfer_slip', 'store_receipt', 'restaurant_receipt', 'invoice', 'other', 'not_a_receipt'] },
    date: nullable({ type: 'string', description: 'Transaction date as YYYY-MM-DD in the Gregorian calendar' }),
    amount: nullable({ type: 'number', description: 'Total paid in THB' }),
    merchant: nullable({ type: 'string' }),
    reference: nullable({ type: 'string', description: 'Transaction / reference number printed on a bank slip' }),
    category: nullable({ type: 'string', enum: EXPENSE_CATEGORIES }),
    purpose_known: { type: 'boolean', description: 'Whether the image says what the money was for' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string', description: 'Short Thai description of what was bought, or empty' },
  },
};

const SYSTEM = `You read photos of Thai payment documents: bank transfer slips (K PLUS, SCB Easy, Krungthai NEXT, PromptPay and others), store receipts (7-Eleven, Lotus's, Big C and others), restaurant bills and invoices.
Extract the fields in the schema from the image only; do not invent values.
- Thai dates often use the Buddhist Era (e.g. 2569 = 2026) and short Thai month names; convert to a Gregorian YYYY-MM-DD.
- amount is the final total actually paid (after discounts, including VAT and service charge).
- merchant is the shop name, or for a transfer slip the receiving person or company.
- category: pick the closest key only when the purchase is clear. For a bank transfer slip that does not say what the money was for, set category to null and purpose_known to false.
- Use confidence "low" when the image is blurry, cropped, or a field is unreadable, and set unreadable fields to null.`;

const client = aiEnabled ? new Anthropic() : null;

export async function analyzeReceipt(base64, mediaType) {
  if (!client) return { status: 'skipped', result: null };
  const response = await client.beta.messages.create({
    model: RECEIPT_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Extract the receipt fields.' },
      ],
    }],
  });
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    return { status: 'failed', result: null, reason: response.stop_reason };
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let r;
  try { r = JSON.parse(text); } catch { return { status: 'failed', result: null, reason: 'bad_json' }; }
  // A transfer slip with no stated purpose waits for the person to choose (PRD: "รอตรวจสอบ").
  if (r.kind === 'bank_transfer_slip' && !r.purpose_known) r.category = null;
  const needsReview = r.confidence === 'low' || r.category == null || r.amount == null || r.date == null
    || r.kind === 'not_a_receipt';
  return { status: needsReview ? 'needs_review' : 'ok', result: r, model: response.model };
}
