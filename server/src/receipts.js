import Anthropic from '@anthropic-ai/sdk';

export const RECEIPT_MODEL = process.env.RECEIPT_MODEL || 'claude-haiku-5-5';
// Haiku has no server-side refusal fallback; larger models route refusals with it.
const useFallbacks = !RECEIPT_MODEL.startsWith('claude-haiku');
export const aiEnabled = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// The built-in expense categories in money.js (TX_CATS), with what belongs in each.
// People can rename, add, remove and nest categories; the app then sends its own list.
const CATEGORY_HINTS = {
  apparel: ['Apparel & Accessories', 'clothes, shoes, bags, accessories'],
  food: ['Food & Groceries', 'meals, restaurants, groceries, convenience stores'],
  coffee: ['Coffee & Beverage', 'coffee shops, bubble tea, drinks'],
  hangout: ['Hang Out', 'bars, nightlife, movies, going out'],
  utility: ['Utility Bills', 'electricity, water, phone, internet'],
  subscription: ['Monthly Subscriptions', 'Netflix, Spotify, apps, memberships'],
  transport: ['Transportation', 'fuel, taxi, Grab, BTS/MRT, parking, tolls'],
  home: ['Home & Living', 'furniture, household goods, repairs'],
  health: ['Health & Medical', 'hospital, clinic, pharmacy'],
  beauty: ['Beauty & Personal Care', 'salon, cosmetics, toiletries'],
  travel: ['Travel & Trips', 'hotels, flights, tours'],
  fitness: ['Fitness & Sports', 'gym, sports gear'],
  pets: ['Pets', 'pet food, vet, pet supplies'],
  gift: ['Gifts & Donations', 'gifts, donations, merit-making'],
  gadget: ['Gadgets & Electronics', 'phones, computers, electronics'],
  rent: ['Rent & Insurance', 'rent, insurance, loan installments'],
  baby: ['Babe👼', 'baby and child items'],
  other_exp: ['Others', 'anything that fits nowhere else'],
};
export const EXPENSE_CATEGORIES = Object.keys(CATEGORY_HINTS);
const DEFAULT_CATEGORIES = EXPENSE_CATEGORIES.map((id) => ({ id, name: CATEGORY_HINTS[id][0] }));

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
    purpose_known: { type: 'boolean', description: 'Whether the image shows what the money was for: a memo/note, the items bought, or a payee or shop name that names the business' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string', description: 'Short Thai description of what was bought, or empty' },
  },
};

const SYSTEM = `You read photos of Thai payment documents: bank transfer slips (K PLUS, SCB Easy, Krungthai NEXT, PromptPay and others), store receipts (7-Eleven, Lotus's, Big C and others), restaurant bills and invoices.
Extract the fields in the schema from the image only; do not invent values.
- Thai dates often use the Buddhist Era (e.g. 2569 = 2026) and short Thai month names; convert to a Gregorian YYYY-MM-DD.
- amount is the final total actually paid (after discounts, including VAT and service charge).
- merchant is the shop name, or for a transfer slip the receiving person or company.
- category: pick the key of the closest category from the person's list in the message. When a sub-category clearly fits, use it rather than its parent.
- Infer the category from every clue on the image: the memo/note, the items, and the shop, merchant or payee name. Thai sellers who take PromptPay often show their shop name inside the account name, usually in brackets after the owner's name, e.g. "นายนเรศ พุ่มพวงผล(เจ๊ดาลูกชิ้นปลาไร้สาร)" is a fish-ball stall, so it is food; "ร้านกาแฟ…", "…คาเฟ่", "ชานม…" are coffee/drinks; "ร้านข้าวมันไก่…", "ก๋วยเตี๋ยว…", "หมูกระทะ…", "ส้มตำ…" are food; "คลินิก…", "ร้านยา…" are health; "ร้านตัดผม…", "ซาลอน…" are beauty; "ปั๊ม…", "วินมอเตอร์ไซค์" are transport. When such a word names what the shop sells, set purpose_known to true and pick that category with confidence "medium" or "high".
- For a bank transfer slip to a plain person's name (no shop name, no memo) or a bank/wallet top-up that does not say what the money was for, set category to null and purpose_known to false.
- Use confidence "low" when the image is blurry, cropped, or a field is unreadable, and set unreadable fields to null.`;

const client = aiEnabled ? new Anthropic() : null;

// The category list as the model reads it: one "key: name" line each, subs under their parent.
function categoryLines(cats) {
  return cats.map((c) => {
    // A built-in category keeps its hint only while it keeps its built-in name.
    const h = CATEGORY_HINTS[c.id];
    const hint = h && h[0] === c.name ? ` (e.g. ${h[1]})` : '';
    return `- ${c.id}: ${c.parent ? `${c.parent} › ` : ''}${c.name}${hint}`;
  }).join('\n');
}

// The schema allows only the person's category keys; with their label names it also asks which labels fit.
function schemaFor(labels, cats) {
  const withCats = { ...SCHEMA.properties, category: nullable({ type: 'string', enum: cats.map((c) => c.id) }) };
  if (!labels.length) return { ...SCHEMA, properties: withCats };
  return {
    ...SCHEMA,
    required: [...SCHEMA.required, 'labels'],
    properties: {
      ...withCats,
      labels: {
        type: 'array',
        items: { type: 'string', enum: labels },
        description: "The person's own labels that clearly fit this payment (e.g. a label named after the shop, app or service). Empty when none clearly fit.",
      },
    },
  };
}

// categories: [{ id, name, parent? }] from the app; empty means the built-in list.
export async function analyzeReceipt(base64, mediaType, labels = [], categories = []) {
  if (!client) return { status: 'skipped', result: null };
  const cats = categories.length ? categories : DEFAULT_CATEGORIES;
  const response = await client.beta.messages.create({
    model: RECEIPT_MODEL,
    max_tokens: 4000,
    ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schemaFor(labels, cats) } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: `Extract the receipt fields. Choose the category only from this list, using the payee/shop name too.\n\nExpense categories (key: name):\n${categoryLines(cats)}` },
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
  if (r.category != null && !cats.some((c) => c.id === r.category)) r.category = null;
  r.labels = Array.isArray(r.labels) ? r.labels.filter((x) => labels.includes(x)) : [];
  const needsReview = r.confidence === 'low' || r.category == null || r.amount == null || r.date == null
    || r.kind === 'not_a_receipt';
  return { status: needsReview ? 'needs_review' : 'ok', result: r, model: response.model };
}
