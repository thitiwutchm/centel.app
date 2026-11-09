// e-Tax Invoice by Email (กรมสรรพากร "จัดทำใบกำกับภาษีโดยการประทับรับรองเวลา (Time Stamp)").
// A VAT-registered business approved for it emails each tax invoice as one PDF/A-3 file to
// the buyer, with csemail@etax.teda.th in CC and a fixed subject; ETDA stamps the time on it
// and sends it back to both. Shared by the accounting app (window.Etax) and the tests (node).
//
// Rules (RD Time Stamp manual, 1 Jun 2023): PDF/A-3 only, at most 3 MB, not encrypted, one
// tax invoice per file and per email, one address in To, sent from the address registered
// with the Revenue Department, subject with no spaces:
//   tax invoice            [DDMMYYYY][INV][number]            (date in BE: 12012560)
//   debit note             [DDMMYYYY][DBN][number][original tax invoice number]
//   credit note            [DDMMYYYY][CRN][number][original tax invoice number]
//   cancel and replace     [DDMMYYYY][INV][new number][cancelled number]
(function (g) {
  'use strict';

  const CC = 'csemail@etax.teda.th';
  const MAX_BYTES = 3 * 1024 * 1024;

  // 2026-11-09 → 09112569
  function subjectDate(d) {
    const [y, m, day] = String(d || '').slice(0, 10).split('-');
    return `${day}${m}${Number(y) + 543}`;
  }
  // The subject line for a document; ref = the tax invoice a credit / debit note adjusts.
  function subject(doc, ref) {
    const clean = (s) => String(s || '').replace(/[[\]\s]/g, '');
    const head = `[${subjectDate(doc.date)}]`;
    if (doc.type === 'CN' || doc.type === 'DN') return `${head}[${doc.type === 'CN' ? 'CRN' : 'DBN'}][${clean(doc.number)}][${clean(ref?.number)}]`;
    const old = doc.adjust?.replaces?.number;
    return `${head}[INV][${clean(doc.number)}]${old ? `[${clean(old)}]` : ''}`;
  }
  const canSend = (d) => !!d && d.status !== 'void' && (((d.type === 'IV' || d.type === 'RE') && d.tax_invoice) || d.type === 'CN' || d.type === 'DN');

  /* ---------- PDF/A-3b ---------- */

  // A compact sRGB IEC61966-2.1 profile (Little CMS built-in) for the PDF/A output intent.
  const SRGB_ICC = 'AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oACwAJABEACQACYWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c';

  const b64ToBytes = (b64) => {
    if (typeof Buffer !== 'undefined' && !g.atob) return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = g.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const isoDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hex = (n) => {
    const a = new Uint8Array(n);
    (g.crypto || globalThis.crypto).getRandomValues(a);
    return [...a].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  };

  // Turns the PDF html2pdf / jsPDF made (pictures of the pages) into PDF/A-3b: XMP metadata
  // that matches the document info, an sRGB output intent, a file ID, no unembedded fonts.
  // PDFLib = the pdf-lib module. meta: { title, author, date }.
  async function toPdfA3(PDFLib, bytes, meta = {}) {
    const { PDFDocument, PDFName, PDFString, PDFHexString, PDFRawStream, PDFHeader, decodePDFRawStream } = PDFLib;
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = pdf.context;
    if (PDFHeader) ctx.header = PDFHeader.forVersion(1, 7);
    const when = new Date(Math.floor((meta.date ? new Date(meta.date) : new Date()).getTime() / 1000) * 1000);
    const producer = 'Centel Account';

    // Fresh document info, mirrored in XMP below (PDF/A wants the two to agree).
    if (ctx.trailerInfo.Info && ctx.trailerInfo.Info.objectNumber !== undefined) ctx.delete(ctx.trailerInfo.Info);
    ctx.trailerInfo.Info = undefined;
    pdf.setTitle(meta.title || 'Tax invoice');
    if (meta.author) pdf.setAuthor(meta.author);
    pdf.setCreator(producer);
    pdf.setProducer(producer);
    pdf.setCreationDate(when);
    pdf.setModificationDate(when);

    const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(meta.title || 'Tax invoice')}</rdf:li></rdf:Alt></dc:title>
${meta.author ? `   <dc:creator><rdf:Seq><rdf:li>${xmlEsc(meta.author)}</rdf:li></rdf:Seq></dc:creator>\n` : ''}   <xmp:CreatorTool>${producer}</xmp:CreatorTool>
   <xmp:CreateDate>${isoDate(when)}</xmp:CreateDate>
   <xmp:ModifyDate>${isoDate(when)}</xmp:ModifyDate>
   <xmp:MetadataDate>${isoDate(when)}</xmp:MetadataDate>
   <pdf:Producer>${producer}</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    const xmpBytes = new TextEncoder().encode(xmp);
    const metaStream = ctx.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML', Length: xmpBytes.length });
    pdf.catalog.set(PDFName.of('Metadata'), ctx.register(metaStream));

    const icc = b64ToBytes(SRGB_ICC);
    const iccRef = ctx.register(ctx.stream(icc, { N: 3, Length: icc.length }));
    const intent = ctx.obj({
      Type: 'OutputIntent', S: 'GTS_PDFA1',
      OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'), Info: PDFString.of('sRGB IEC61966-2.1'),
      RegistryName: PDFString.of('http://www.color.org'), DestOutputProfile: iccRef,
    });
    pdf.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));
    pdf.catalog.set(PDFName.of('Lang'), PDFString.of(meta.lang || 'th-TH'));

    // jsPDF lists the 14 standard fonts on every page without embedding them; the pages are
    // pictures, so drop fonts that no content stream uses.
    const unused = new Set();
    for (const page of pdf.getPages()) {
      const node = page.node;
      const res = node.Resources && node.Resources();
      if (!res) continue;
      let text = '';
      const contents = node.Contents && node.Contents();
      const streams = !contents ? [] : contents.asArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
      for (const s of streams) {
        try {
          const raw = s instanceof PDFRawStream && decodePDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
          text += new TextDecoder('latin1').decode(raw);
        } catch { text += 'Tf'; }
      }
      if (/\sTf\b/.test(text)) continue;
      const fontsRef = res.get(PDFName.of('Font'));
      const fonts = fontsRef && ctx.lookup(fontsRef);
      if (fonts && fonts.entries) for (const [, ref] of fonts.entries()) if (ref && ref.objectNumber !== undefined) unused.add(ref);
      if (fontsRef && fontsRef.objectNumber !== undefined) unused.add(fontsRef);
      res.delete(PDFName.of('Font'));
    }

    // Fonts nothing points to any more (a page that still writes text keeps them).
    const kept = new Set();
    for (const page of pdf.getPages()) {
      const f = page.node.Resources()?.get(PDFName.of('Font'));
      const fd = f && ctx.lookup(f);
      if (f && f.objectNumber !== undefined) kept.add(f.toString());
      if (fd && fd.entries) for (const [, r] of fd.entries()) if (r && r.objectNumber !== undefined) kept.add(r.toString());
    }
    for (const r of unused) if (!kept.has(r.toString())) ctx.delete(r);

    const id = hex(16);
    ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
    // Viewer actions and scripts are not allowed in PDF/A.
    for (const k of ['OpenAction', 'AA', 'Names']) pdf.catalog.delete(PDFName.of(k));
    return pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  }

  /* ---------- Email ---------- */

  const utf8b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    return bytesToB64(bytes);
  };
  function bytesToB64(bytes) {
    if (typeof Buffer !== 'undefined' && !g.btoa) return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return g.btoa(bin);
  }
  const wrap76 = (s) => s.replace(/.{1,76}/g, (m) => `${m}\r\n`);
  const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8b64(s)}?=`);
  const addr = (name, email) => (name ? `${word(String(name).replace(/["\r\n]/g, ''))} <${email}>` : email);

  // An RFC 822 message with the PDF attached, ready for Gmail's messages.send (raw, base64url).
  function mime({ from, fromName, to, subject: subj, text, filename, pdf }) {
    const boundary = `centel-${hex(8)}`;
    const lines = [
      `From: ${addr(fromName, from)}`,
      `To: ${to}`,
      `Cc: ${CC}`,
      `Subject: ${word(subj)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(utf8b64(text || '')).trimEnd(),
      `--${boundary}`,
      `Content-Type: application/pdf; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(bytesToB64(pdf)).trimEnd(),
      `--${boundary}--`,
      '',
    ];
    return lines.join('\r\n');
  }
  const base64url = (s) => utf8b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // The message as Gmail wants it: the raw MIME text, base64url (it is plain ASCII already).
  const rawMessage = (m) => (typeof Buffer !== 'undefined' && !g.btoa ? Buffer.from(m, 'latin1').toString('base64') : g.btoa(m)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // The email body: Gmail may block an e-Tax mail with no text, so there is always some.
  function bodyText(doc, business, kind) {
    return [
      `เรียน ${doc.contact?.name || 'ลูกค้า'}`,
      '',
      `${business.name} ขอส่ง${kind} เลขที่ ${doc.number} ในรูปแบบอิเล็กทรอนิกส์ (e-Tax Invoice by Email) ตามไฟล์แนบ`,
      'เอกสารนี้ส่งผ่านระบบประทับรับรองเวลาของ ETDA และกรมสรรพากร ท่านจะได้รับไฟล์ที่ประทับเวลาแล้วอีกฉบับจากระบบ',
      '',
      'ขอบคุณครับ/ค่ะ',
      business.name,
      [business.phone, business.email].filter(Boolean).join(' · '),
    ].join('\n');
  }

  g.Etax = { CC, MAX_BYTES, subject, subjectDate, canSend, toPdfA3, mime, rawMessage, bodyText, base64url };
})(typeof window !== 'undefined' ? window : globalThis);
