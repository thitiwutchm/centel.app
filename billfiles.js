'use strict';

/* ---------- Bill files (invoice PDFs/images per bill per month) ----------
 * Files are too big for localStorage, so the blobs live in IndexedDB keyed by
 * "billId/YYYY-MM"; the month's record keeps { file: name } so lists stay synchronous.
 * Signed in, each file is also uploaded to the account ({ fileCloud: true } on the record)
 * and other devices fetch it the first time it is opened (see cloud.js).
 */

const FILES_DB = 'centel.files';
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const BILL_FILE_MAX = 10 * 1024 * 1024;

let filesDbP = null;
let pdfJsP = null;

function filesDb() {
  if (!filesDbP) {
    filesDbP = new Promise((resolve, reject) => {
      const req = indexedDB.open(FILES_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { filesDbP = null; reject(req.error); };
    });
  }
  return filesDbP;
}

async function filesTx(mode, fn) {
  const db = await filesDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

function billFileKey(billId, ym) { return `${billId}/${ym}`; }
function billFileGet(billId, ym) { return filesTx('readonly', (s) => s.get(billFileKey(billId, ym))); }
function billFileDel(billId, ym) {
  billFileRemoteDel(billId, ym);
  return filesTx('readwrite', (s) => s.delete(billFileKey(billId, ym))).catch(() => {});
}
function billFilesClear() { return filesTx('readwrite', (s) => s.clear()).catch(() => {}); }

// Store a file for a bill's month and mark the record. Caller saves state.
async function billFilePut(billId, ym, blob, name) {
  if (blob.size > BILL_FILE_MAX) throw new Error('ไฟล์ใหญ่เกิน 10 MB');
  await filesTx('readwrite', (s) => s.put({ name, type: blob.type || 'application/pdf', blob, added: new Date().toISOString() }, billFileKey(billId, ym)));
  setRecord(ym, billId, { file: name, fileCloud: undefined });
  billFileUpload(billId, ym);
}

// A bill took another id (matched to the account's copy of the same bill): move its files.
async function billFileMove(fromId, toId) {
  try {
    const db = await filesDb();
    const keys = await new Promise((resolve, reject) => {
      const req = db.transaction('files').objectStore('files').getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    for (const k of keys.filter((x) => String(x).startsWith(`${fromId}/`))) {
      const ym = String(k).slice(fromId.length + 1);
      const f = await filesTx('readonly', (s) => s.get(k));
      await filesTx('readwrite', (s) => { s.put(f, billFileKey(toId, ym)); return s.delete(k); });
    }
  } catch (e) { /* the file stays under the old id; it can be attached again */ }
}

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfJsP) {
    pdfJsP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS_URL;
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; resolve(window.pdfjsLib); };
      s.onerror = () => { pdfJsP = null; reject(new Error('โหลดตัวอ่าน PDF ไม่สำเร็จ')); };
      document.head.appendChild(s);
    });
  }
  return pdfJsP;
}

// Render the stored file inside a sheet: PDF pages to canvases (works in the iOS home-screen
// app, where opening blob URLs is unreliable), images as <img>.
async function billFileViewer(billId, ym) {
  const b = state.bills.find((x) => x.id === billId);
  openSheet(`
    <div class="sheet-head">
      <button class="link-btn" data-occ="${billId}" data-ym="${ym}">‹ กลับ</button>
      <h2>ใบแจ้งหนี้</h2>
      <button class="link-btn" id="fileShare">แชร์</button>
    </div>
    <p class="hint" style="text-align:center">${esc(b ? b.name : '')} · ${thMonthYear(ym)}</p>
    <div class="file-view" id="fileView"><p class="hint">กำลังเปิดไฟล์…</p></div>
  `);
  const box = $('#fileView');
  try {
    const f = (await billFileGet(billId, ym).catch(() => null)) || await billFileDownload(billId, ym);
    if (!f) { box.innerHTML = `<p class="hint">${record(ym, billId).fileCloud ? 'ดาวน์โหลดไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง' : 'ไม่พบไฟล์ในเครื่องนี้ (แนบจากเครื่องอื่นก่อนซิงก์ไฟล์ ให้แนบใหม่ที่เครื่องนั้น)'}</p>`; return; }
    $('#fileShare').addEventListener('click', () => deliverFile(f.name, f.type, f.blob));
    if (!/pdf/i.test(f.type)) {
      const url = URL.createObjectURL(f.blob);
      box.innerHTML = `<img src="${url}" alt="${esc(f.name)}">`;
      return;
    }
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await f.blob.arrayBuffer()) }).promise;
    box.innerHTML = '';
    const width = box.clientWidth || 340;
    for (let i = 1; i <= Math.min(pdf.numPages, 6); i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const scale = (width / vp.width) * (window.devicePixelRatio || 1);
      const view = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = view.width; canvas.height = view.height;
      box.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
    }
  } catch (err) {
    box.innerHTML = `<p class="hint pea-err">เปิดไฟล์ไม่สำเร็จ${err && err.name === 'PasswordException' ? ' (PDF ล็อกรหัสไว้ กด แชร์ เพื่อเปิดในแอปอื่น)' : ''}</p>`;
  }
}
