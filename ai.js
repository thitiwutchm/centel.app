'use strict';

/* ---------- Connect Claude / ChatGPT (Account › เชื่อมกับ AI) ----------
 * Centel is a remote MCP server at <host>/mcp (server/src/mcp.js). The person adds that URL
 * as a connector in Claude or ChatGPT, signs in to Centel on the consent page and taps
 * อนุญาต; the AI can then read (never change) their transactions, budgets, wallets, notes
 * and bills, and summarise them. Bills live on this device, so while at least one AI app
 * is connected the app sends a copy of them (PUT /api/ai/bills) whenever they change.
 * Loaded after cloud.js and before app.js; `state`, `occurrences`, `api` are looked up at call time.
 */

const AIC_KEY = 'centel.ai.v1'; // { userId, sent: hash of the last bill copy sent }
const aic = { info: null, checkedAt: 0, user: null, timer: null, sending: false };

function aiMcpUrl() { return (aic.info && aic.info.url) || `${location.origin}/mcp`; }

// What this account has connected; asked again when the app comes back (the person may
// have just connected Claude in another tab).
async function aiCheck(force = false) {
  if (!isCloud()) return;
  if (!force && aic.user === cloud.user.id && Date.now() - aic.checkedAt < 60000) return;
  aic.user = cloud.user.id;
  aic.checkedAt = Date.now();
  try {
    const before = aic.info ? aic.info.apps.length : -1;
    aic.info = await api('GET', '/ai');
    if (aic.info.apps.length && !aic.info.billsAt) aiSetLocal(null); // copy was dropped: send again
    if (aic.info.apps.length) aiBillsChanged(0);
    if (ui.tab === 'account' && before !== aic.info.apps.length) { const y = window.scrollY; render(); window.scrollTo(0, y); }
  } catch (e) { aic.checkedAt = 0; }
}

function aiLocal() {
  try {
    const c = JSON.parse(localStorage.getItem(AIC_KEY) || 'null');
    return c && cloud.user && c.userId === cloud.user.id ? c : null;
  } catch (e) { return null; }
}
function aiSetLocal(c) {
  try {
    if (c) localStorage.setItem(AIC_KEY, JSON.stringify({ userId: cloud.user.id, ...c }));
    else localStorage.removeItem(AIC_KEY);
  } catch (e) { /* full */ }
}

// The bill list and each bill's months from 6 months back to 3 ahead.
function aiBillsSnapshot() {
  const ym0 = ymOf(new Date());
  const months = {};
  for (let k = -6; k <= 3; k++) {
    const ym = addMonths(ym0, k);
    months[ym] = occurrences(ym).map((o) => ({
      billId: o.bill.id, name: o.bill.name, category: cat(o.bill).label, due: dateStr(o.due),
      amount: o.amount || 0, needsAmount: !!o.needsAmount || undefined, paid: o.paid || undefined, paidAt: o.paidAt || undefined,
      status: o.status, autopay: o.bill.autopay || undefined, inst: o.inst || undefined,
    }));
  }
  const bills = state.bills.map((b) => ({
    id: b.id, name: b.name, category: cat(b).label, type: b.type, amount: b.amount || 0, variable: !!b.variable || undefined,
    autopay: !!b.autopay || undefined, dueDay: b.dueDay, startMonth: b.startMonth, months: b.months || undefined,
    endMonth: b.type === 'once' ? undefined : billEndMonth(b) || undefined, onceDate: b.onceDate || undefined, note: b.note || undefined,
  }));
  return { v: 1, bills, months };
}

function aiHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// Called by save() in app.js, on start and when the app comes back to the screen.
function aiBillsChanged(delay = 1500) {
  if (!isCloud()) return;
  if (aic.user !== cloud.user.id || Date.now() - aic.checkedAt > 60000) { aiCheck(); return; }
  if (!aic.info || !aic.info.apps.length) return;
  clearTimeout(aic.timer);
  aic.timer = setTimeout(aiBillsSend, delay);
}

async function aiBillsSend() {
  if (!isCloud() || aic.sending || !aic.info || !aic.info.apps.length) return;
  const data = aiBillsSnapshot();
  // Statuses (overdue, soon) move with the date, so the day is part of what counts as changed.
  const hash = aiHash(dateStr(new Date()) + JSON.stringify(data));
  const cur = aiLocal();
  if (cur && cur.sent === hash) return;
  aic.sending = true;
  try {
    await api('PUT', '/ai/bills', { data });
    aiSetLocal({ sent: hash });
    aic.info.billsAt = new Date().toISOString();
  } catch (e) {
    if (e.status === 409) aic.info.apps = []; // every app was removed on another device
  } finally {
    aic.sending = false;
  }
}

function aiWhen(iso) {
  if (!iso) return 'ยังไม่เคยใช้';
  const d = new Date(iso);
  return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The block in Account, under the chat assistant.
function aiSettings() {
  if (isCloud()) aiCheck();
  const n = aic.info ? aic.info.apps.length : 0;
  return `
    <div class="section-title">เชื่อมกับ AI</div>
    <button class="btn${n ? ' ghost' : ''}" id="aiOpen">✨ ${n ? `เชื่อมกับ AI อยู่ ${n} แอป` : 'ให้ Claude / ChatGPT อ่านข้อมูลสรุปให้'}</button>
    <p class="hint">${isCloud()
      ? 'เพิ่ม Centel เป็น connector ใน Claude หรือ ChatGPT แล้วถามหรือสั่งได้เลย เช่น "สรุปรายจ่ายเดือนนี้" "กินข้าวไป 350 บันทึกให้หน่อย" "ตั้งงบอาหาร 20,000 ต่อเดือน" หรือ "เตือนพรุ่งนี้ 10 โมงไปรับพัสดุ" · การลบและการเปลี่ยนยอดเงิน AI ต้องถามคุณก่อน และโอนเงินจริงไม่ได้'
      : 'ต้องเข้าสู่ระบบก่อน AI อ่านข้อมูลจากบัญชีออนไลน์ของคุณ'}</p>`;
}

function aiSettingsBind() {
  const b = document.getElementById('aiOpen');
  if (b) b.addEventListener('click', () => (isCloud() ? aiSheet() : loginSheet()));
}

function aiSheet() {
  const url = aiMcpUrl();
  const apps = (aic.info && aic.info.apps) || [];
  openSheet(`
    <div class="sheet-head">${CLOSE_X}<h2>เชื่อมกับ AI</h2><span style="width:40px"></span></div>
    <p class="hint">ลิงก์ MCP ของ Centel (ใช้ได้ทั้ง Claude และ ChatGPT)</p>
    <div class="card"><code translate="no" style="word-break:break-all;font-size:15px">${esc(url)}</code></div>
    <button class="btn" id="aiCopy">🔗 คัดลอกลิงก์</button>

    <div class="section-title">Claude</div>
    <ol class="hint">
      <li>เปิด claude.ai หรือแอป Claude › <b>Settings › Connectors</b></li>
      <li>กด <b>Add custom connector</b> ตั้งชื่อ Centel แล้ววางลิงก์ด้านบน</li>
      <li>กด <b>Connect</b> เข้าสู่ระบบ Centel แล้วกด <b>อนุญาต</b></li>
    </ol>
    <div class="section-title">ChatGPT</div>
    <ol class="hint">
      <li>เปิด chatgpt.com › <b>Settings › Apps &amp; Connectors › Advanced settings</b> เปิด <b>Developer mode</b></li>
      <li>กลับมาที่ Apps &amp; Connectors กด <b>Create</b> ตั้งชื่อ Centel วางลิงก์ เลือก Authentication <b>OAuth</b></li>
      <li>กด <b>Create</b> เข้าสู่ระบบ Centel แล้วกด <b>อนุญาต</b> · ในแชทเลือก Centel จากปุ่ม + ก่อนถาม</li>
    </ol>

    <div class="section-title">แอปที่เชื่อมอยู่</div>
    ${apps.length ? `<div class="form">${apps.map((a) => `
      <div class="field"><label>${esc(a.name)}<span class="muted small" style="display:block">ใช้ล่าสุด ${esc(aiWhen(a.lastUsedAt))}</span></label>
        <span style="flex:1"></span><button class="btn ghost" style="width:auto;margin:0;padding:8px 14px" data-ai-remove="${esc(a.id)}">ยกเลิก</button></div>`).join('')}</div>`
    : '<p class="hint">ยังไม่มี เชื่อมแล้วกลับมาหน้านี้ จะเห็นชื่อแอปที่นี่</p>'}
    <div class="section-title">สิ่งที่ AI เปลี่ยนล่าสุด</div>
    <div id="aiChanges"><p class="hint">กำลังโหลด…</p></div>
    <p class="hint">AI เห็นรายการรับจ่าย งบประมาณ กระเป๋าเงิน โน้ต สิ่งที่ต้องทำ และรายจ่ายร่วมกับคู่ เหมือนที่คุณเห็นในแอป จดโน้ต เพิ่ม/แก้สิ่งที่ต้องทำพร้อมตั้งเตือน สร้าง/แก้งบประมาณ และบันทึก/แก้รายรับรายจ่ายได้ · การลบ การเปลี่ยนยอดเงิน และรายการตั้งแต่ 10,000 บาท AI ต้องถามคุณก่อนทุกครั้ง · AI โอนเงินจริง แก้กระเป๋าเงิน หรือแก้บิลไม่ได้ · ทุกอย่างที่ AI เปลี่ยนแสดงด้านบน กดย้อนกลับได้ · แอปที่เชื่อมก่อนวันที่ 4 พ.ย. ต้องยกเลิกแล้วเชื่อมใหม่หนึ่งครั้งจึงจะแก้งบและรายรับรายจ่ายได้ · บิลเก็บอยู่ในเครื่อง แอปจะส่งสำเนาบิลให้ AI อ่านเมื่อมีการเปลี่ยนแปลง${aic.info && aic.info.billsAt ? ` (ส่งล่าสุด ${esc(aiWhen(aic.info.billsAt))})` : ''} · ยกเลิกแล้วสำเนาบิลจะถูกลบ</p>
  `);
  $('#aiCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); toast('คัดลอกลิงก์แล้ว'); } catch (e) { prompt('คัดลอกลิงก์', url); }
  });
  document.querySelectorAll('[data-ai-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('ยกเลิกการเชื่อมแอปนี้? AI จะอ่านข้อมูล Centel ไม่ได้อีก จนกว่าจะเชื่อมใหม่')) return;
    try {
      await api('DELETE', `/ai/apps/${b.dataset.aiRemove}`);
      await aiCheck(true);
      aiSheet();
      render();
      toast('ยกเลิกแล้ว');
    } catch (e) { toast(cloudErr(e)); }
  }));
  if (isCloud()) aiCheck(true).then(() => { if (aic.info && aic.info.apps.length !== apps.length && document.getElementById('aiCopy')) aiSheet(); });
  aiChangesLoad();
}

const AI_ENTITY = { note: '📝', budget: '🎯', transaction: '💸' };

// The latest changes made by AI apps (server mcp_audit), each with an undo button.
async function aiChangesLoad() {
  const box = document.getElementById('aiChanges');
  if (!box || !isCloud()) return;
  let list;
  try { list = (await api('GET', '/ai/changes')).changes || []; } catch (e) { box.innerHTML = `<p class="hint">${esc(cloudErr(e))}</p>`; return; }
  if (!document.getElementById('aiChanges')) return;
  box.innerHTML = list.length ? `<div class="form">${list.slice(0, 20).map((c) => `
    <div class="field" style="gap:10px"><label style="flex:1;min-width:0;overflow-wrap:anywhere">${AI_ENTITY[c.entity] || '•'} ${esc(c.summary || c.tool)}<span class="muted small" style="display:block">${esc(c.app || 'Centel')} · ${esc(aiWhen(c.at))}${c.undone ? ' · ย้อนกลับแล้ว' : ''}</span></label>
      ${c.undone || c.undoOf ? '' : `<button class="btn ghost" style="width:auto;flex:none;white-space:nowrap;margin:0;padding:8px 14px" data-ai-undo="${c.id}">ย้อนกลับ</button>`}</div>`).join('')}</div>`
    : '<p class="hint">ยังไม่มี เมื่อ AI จดโน้ต ตั้งงบ หรือบันทึกรายการ จะแสดงที่นี่</p>';
  box.querySelectorAll('[data-ai-undo]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('ย้อนกลับการเปลี่ยนแปลงนี้?')) return;
    b.disabled = true;
    try {
      await api('POST', `/ai/changes/${b.dataset.aiUndo}/undo`);
      toast('ย้อนกลับแล้ว');
      scheduleRefresh();
    } catch (e) {
      toast(e.status === 409 ? 'ย้อนกลับไม่ได้ เพราะรายการนี้ถูกแก้อีกครั้งหลังจากนั้น' : cloudErr(e));
    }
    aiChangesLoad();
  }));
}
