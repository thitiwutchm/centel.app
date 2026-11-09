// Reads a photo or PDF of a purchase bill / tax invoice into an expense record draft.
import Anthropic from '@anthropic-ai/sdk';
import { RECEIPT_MODEL } from '../receipts.js';

const enabled = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = enabled ? new Anthropic() : null;
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

function schemaFor(codes) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['vendor', 'doc_no', 'date', 'tax_invoice', 'price_mode', 'lines', 'vat', 'total', 'account', 'confidence'],
    properties: {
      vendor: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'tax_id', 'branch', 'address', 'is_company'],
        properties: {
          name: nullable({ type: 'string' }),
          tax_id: nullable({ type: 'string', description: '13-digit Thai tax ID, digits only' }),
          branch: nullable({ type: 'string', description: '00000 for head office (สำนักงานใหญ่), else the 5-digit branch number' }),
          address: nullable({ type: 'string' }),
          is_company: { type: 'boolean', description: 'true for a company / juristic person (บริษัท, หจก.), false for an individual' },
        },
      },
      doc_no: nullable({ type: 'string', description: 'The bill / tax invoice number' }),
      date: nullable({ type: 'string', description: 'Document date as Gregorian YYYY-MM-DD' }),
      tax_invoice: { type: 'boolean', description: 'true when the document is a full tax invoice (ใบกำกับภาษี) showing the seller tax ID and VAT' },
      price_mode: { type: 'string', enum: ['excl', 'incl'], description: 'excl when line prices are before VAT, incl when they include VAT' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'qty', 'price'],
          properties: { name: { type: 'string' }, qty: { type: 'number' }, price: { type: 'number', description: 'Unit price as printed' } },
        },
      },
      vat: nullable({ type: 'number' }),
      total: nullable({ type: 'number', description: 'Grand total including VAT' }),
      account: nullable({ type: 'string', enum: codes }),
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
  };
}

export async function readPurchaseDoc(base64, mediaType, accounts, biz) {
  if (!client) return null;
  const file = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
  const response = await client.beta.messages.create({
    model: RECEIPT_MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schemaFor(accounts.map((a) => a.code)) } },
    system: `You read Thai purchase documents (tax invoices, receipts, bills) for the books of "${biz.name}". The vendor is the seller who issued the document, never "${biz.name}" itself. Thai dates may use the Buddhist Era (2569 = 2026): convert to Gregorian. Read only what is printed; use null for what is missing. Keep at most 30 lines; if the document lists many items, group them sensibly. Pick the expense account that fits best from the list.`,
    messages: [{
      role: 'user',
      content: [file, { type: 'text', text: `Expense accounts (code: name):\n${accounts.map((a) => `- ${a.code}: ${a.name}`).join('\n')}` }],
    }],
  });
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const r = JSON.parse(text);
    if (r.vendor?.tax_id) r.vendor.tax_id = String(r.vendor.tax_id).replace(/\D/g, '').slice(0, 13) || null;
    return r;
  } catch {
    return null;
  }
}
