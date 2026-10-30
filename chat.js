'use strict';

/* Chat mini app (Telegram style). Signed in only: the room "บ้านเรา" is shared by the two
   linked accounts, and each person also has a private room with the assistant
   (ผู้ช่วย, Hermes Agent running on the family's Mac through bridge/). Messages live on
   the server (/api/chat, server/src/chat.js); one EventSource per device brings new
   messages, edits, reactions, read marks, typing and the assistant's state.
   "@ผู้ช่วย" (or replying to it) asks the assistant in the shared room; "ทำนัด / เตือน / จด …"
   lines become notes at once. Loaded after notes.js; app.js helpers are used at run time. */

const CHAT_ROOMS = ['couple', 'ai'];
const CHAT_AI_NAME = 'ผู้ช่วย';
const CHAT_MENTION = /@(?:ผู้ช่วย|ai|hermes|bot)/i;
const CHAT_QUICK = ['บิลที่ยังไม่จ่าย', 'สรุปค่าใช้จ่ายเดือนนี้', 'งบเหลือเท่าไหร่', 'นัดที่จะถึง'];

const chat = {
  state: null, // /chat/state: { rooms: { couple, ai }, bridge, reactions }
  rooms: { couple: null, ai: null }, // loaded rooms: { msgs, reads, pending, more }
  open: null, // room on screen
  es: null,
  lastEvent: 0,
  partnerTyping: 0,
  typingSent: 0,
  reply: null, // message being replied to
  edit: null, // own message being edited
  readTimer: null,
  booted: false,
};

/* ---------- Server ---------- */

function chatReady() { return isCloud() && !!cloud.user; }
function chatRooms() { return cloud.coupleId ? CHAT_ROOMS : ['ai']; }

async function chatLoadState() {
  if (!chatReady()) return;
  try {
    chat.state = await api('GET', '/chat/state');
    chatRefreshCard();
    chatRenderHead();
  } catch (e) { /* offline: keep what we have */ }
}

async function chatLoadRoom(room, opts = {}) {
  const r = chat.rooms[room];
  const q = opts.after ? `&after=${encodeURIComponent(opts.after)}` : opts.before ? `&before=${encodeURIComponent(opts.before)}` : '';
  const out = await api('GET', `/chat/messages?room=${room}${q}`);
  if (!r || (!opts.after && !opts.before)) {
    chat.rooms[room] = { msgs: out.messages, reads: out.reads, pending: out.pending, more: out.more };
  } else {
    out.messages.forEach((m) => chatUpsert(room, m));
    if (opts.before) { r.more = out.more; }
    r.reads = out.reads;
    r.pending = out.pending;
  }
}

function chatUpsert(room, m) {
  const r = chat.rooms[room];
  if (!r) return;
  const i = r.msgs.findIndex((x) => x.id === m.id);
  if (i >= 0) r.msgs[i] = { ...r.msgs[i], ...m, sending: false, failed: false };
  else {
    r.msgs.push(m);
    r.msgs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
}

function chatConnect() {
  if (chat.es || !chatReady() || typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/chat/stream');
  chat.es = es;
  chat.lastEvent = Date.now();
  es.onmessage = (e) => {
    chat.lastEvent = Date.now();
    let ev;
    try { ev = JSON.parse(e.data); } catch (err) { return; }
    chatEvent(ev);
  };
  es.addEventListener('ping', () => { chat.lastEvent = Date.now(); });
  es.onopen = () => { chat.lastEvent = Date.now(); };
  es.onerror = () => {
    if (es.readyState === 2) { chat.es = null; setTimeout(chatConnect, 5000); }
  };
}

function chatDisconnect() {
  if (chat.es) chat.es.close();
  chat.es = null;
}

// The stream can go quiet behind a proxy or after the phone sleeps: reconnect and catch up.
async function chatCatchUp() {
  if (!chatReady()) return;
  if (!chat.es || Date.now() - chat.lastEvent > 50000) { chatDisconnect(); chatConnect(); }
  await chatLoadState();
  if (chat.open && chat.rooms[chat.open]) {
    const msgs = chat.rooms[chat.open].msgs.filter((m) => !m.sending);
    const last = msgs.length ? msgs[msgs.length - 1].at : null;
    try { await chatLoadRoom(chat.open, last ? { after: last } : {}); chatRenderWall(); chatMarkRead(); } catch (e) { /* offline */ }
  }
}

function chatEvent(ev) {
  const st = chat.state && chat.state.rooms && chat.state.rooms[ev.room];
  if (ev.type === 'msg') {
    const m = ev.msg;
    chatUpsert(ev.room, m);
    const room = chat.rooms[ev.room];
    if (m.ai && room) room.pending = null;
    if (st) {
      if (!st.last || String(m.at) >= String(st.last.at)) st.last = m;
      const mine = m.senderId === cloud.user.id && !m.ai;
      const seen = chat.open === ev.room && document.visibilityState === 'visible';
      if (!mine && !seen && !m.editedAt && !m.deleted && !m.reactionsOnly) st.unread = (st.unread || 0) + (chatIsNew(ev.room, m) ? 1 : 0);
      if (m.ai) st.pending = null;
    }
    if (chat.open === ev.room) { chatRenderWall(); chatMarkRead(); }
    chatRefreshCard();
    chatRenderHead();
  } else if (ev.type === 'read') {
    const r = chat.rooms[ev.room];
    if (r && ev.userId !== cloud.user.id) { r.reads = { ...(r.reads || {}), partner: ev.at }; if (chat.open === ev.room) chatRenderWall(); }
  } else if (ev.type === 'typing') {
    chat.partnerTyping = Date.now();
    chatRenderHead();
    setTimeout(chatRenderHead, 5200);
  } else if (ev.type === 'ai') {
    const r = chat.rooms[ev.room];
    if (r) r.pending = ev.state === 'offline' ? 'queued' : ev.state;
    if (st) st.pending = r ? r.pending : ev.state;
    if (ev.state === 'offline' && chat.state) chat.state.bridge.online = false;
    if (ev.state === 'typing' && chat.state) chat.state.bridge.online = true;
    if (chat.open === ev.room) { chatRenderWall(); chatRenderHead(); }
  } else if (ev.type === 'note') {
    const list = cloud.notes || (cloud.notes = []);
    const i = list.findIndex((n) => n.id === ev.note.id);
    if (i >= 0) list[i] = ev.note; else list.push(ev.note);
    if (!chat.open && ui.tab === 'home' && $('#sheet').hidden) render();
  }
}

// Counted once: an edit or reaction on a message already counted does not add to unread.
const chatCounted = new Set();
function chatIsNew(room, m) {
  if (chatCounted.has(m.id)) return false;
  chatCounted.add(m.id);
  const r = chat.state && chat.state.rooms[room];
  const read = r && r.reads && r.reads.me;
  return !read || String(m.at) > String(read);
}

function chatMarkRead() {
  clearTimeout(chat.readTimer);
  chat.readTimer = setTimeout(async () => {
    const room = chat.open;
    if (!room || document.visibilityState !== 'visible') return;
    const st = chat.state && chat.state.rooms[room];
    if (st) st.unread = 0;
    chatRefreshCard();
    try {
      const r = await api('POST', '/chat/read', { room });
      if (st) st.reads = { ...(st.reads || {}), me: r.at };
    } catch (e) { /* later */ }
  }, 300);
}

/* ---------- Home card ---------- */

function chatPeople() {
  return { me: cloud.user, partner: cloud.partner };
}

function chatAvatar(kind, cls = 'ch-av') {
  if (kind === 'ai') return `<span class="${cls} ai" aria-hidden="true"></span>`;
  const u = kind === 'me' ? cloud.user : cloud.partner;
  return `<span class="${cls} ${kind}${userImg(u) ? ' has-img' : ''}" aria-hidden="true">${userFace(u)}</span>`;
}

function chatGroupAvatar(cls = 'ch-grp') {
  return `<span class="${cls}" aria-hidden="true">${chatAvatar('me', 'ch-av xs')}${chatAvatar('partner', 'ch-av xs')}${chatAvatar('ai', 'ch-av xs')}</span>`;
}

function chatRoomName(room) { return room === 'couple' ? 'บ้านเรา' : 'ผู้ช่วย Centel'; }

function chatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const t = new Date();
  if (dateStr(d) === dateStr(t)) return chatTime(iso);
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (dateStr(d) === dateStr(y)) return 'เมื่อวาน';
  if (t - d < 6 * 864e5) return `${TH_DOW[d.getDay()]}.`;
  return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]}`;
}
function chatTime(iso) { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function chatPreview(room, m) {
  if (!m) return room === 'couple' ? 'คุยกันได้เลย เรียก @ผู้ช่วย ให้ช่วยได้' : 'ถามเรื่องบิล งบ หรือสั่งทำนัดได้เลย';
  if (m.deleted) return 'ข้อความถูกลบ';
  const who = m.ai ? (room === 'couple' ? `${CHAT_AI_NAME}: ` : '') : m.senderId === cloud.user.id ? 'คุณ: ' : `${partnerName()}: `;
  return `${who}${m.text}`;
}

function chatRow(room) {
  const st = chat.state && chat.state.rooms && chat.state.rooms[room];
  const last = st && st.last;
  const unread = (st && st.unread) || 0;
  const online = chat.state && chat.state.bridge && chat.state.bridge.online;
  const busy = st && st.pending;
  const pv = busy && online ? `<span class="ch-typing-txt">${CHAT_AI_NAME}กำลังพิมพ์…</span>` : `<span translate="no">${esc(chatPreview(room, last))}</span>`;
  return `
    <button class="item ch-row" data-chat-open="${room}">
      ${room === 'couple' ? chatGroupAvatar() : `<span class="ch-av-wrap${online ? ' on' : ''}">${chatAvatar('ai', 'ch-av')}</span>`}
      <div class="main">
        <div class="name">${chatRoomName(room)}${room === 'ai' ? ' <span class="ch-ai-tag">AI</span>' : ''}</div>
        <div class="sub ch-pv">${pv}</div>
      </div>
      <div class="ch-rt"><span>${last ? chatWhen(last.at) : ''}</span>${unread ? `<span class="ch-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
    </button>`;
}

function chatCard() {
  if (!chatReady()) return '';
  return `<div id="chatCard">
    <div class="section-row"><span>แชท</span></div>
    <div class="card list-card ch-card">${chatRooms().map(chatRow).join('')}</div>
  </div>`;
}

function chatRefreshCard() {
  const el = document.getElementById('chatCard');
  if (el) el.outerHTML = chatCard();
  if ('setAppBadge' in navigator && chat.state) {
    // The bill badge (app.js updateBadge) wins when there are bills due; unread chat otherwise.
    const n = Object.values(chat.state.rooms).reduce((s, r) => s + (r.unread || 0), 0);
    if (n) navigator.setAppBadge(n).catch(() => {}); else if (typeof updateBadge === 'function') updateBadge();
  }
}

/* ---------- Room screen ---------- */

async function openChat(room) {
  if (!chatReady()) return;
  if (!chatRooms().includes(room)) room = 'ai';
  chat.open = room;
  chat.reply = null;
  chat.edit = null;
  let el = document.getElementById('chatScreen');
  if (!el) {
    el = document.createElement('div');
    el.id = 'chatScreen';
    el.className = 'ch-screen';
    el.setAttribute('role', 'dialog');
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <header class="ch-head">
      <button class="ch-back" data-chat="close" aria-label="กลับ"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="ch-title"><b>${chatRoomName(room)}</b><span id="chStatus"></span></div>
      ${room === 'couple' ? chatGroupAvatar('ch-grp sm') : `<span class="ch-av-wrap sm">${chatAvatar('ai', 'ch-av sm')}</span>`}
    </header>
    <div class="ch-wall" id="chWall"><div class="ch-loading">กำลังโหลด…</div></div>
    <div class="ch-bottom">
      <div class="ch-chips" id="chChips">${(room === 'ai' ? CHAT_QUICK : ['@ผู้ช่วย', ...CHAT_QUICK.map((q) => `@ผู้ช่วย ${q}`)]).map((q) => `<button type="button" data-chat-chip="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <div class="ch-replybar" id="chReplyBar" hidden></div>
      <form class="ch-composer" id="chForm" autocomplete="off">
        <textarea id="chInput" rows="1" placeholder="ข้อความ" aria-label="พิมพ์ข้อความ" enterkeyhint="send"></textarea>
        <button type="submit" class="ch-send" aria-label="ส่ง"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </form>
    </div>`;
  el.hidden = false;
  document.body.classList.add('ch-lock');
  requestAnimationFrame(() => el.classList.add('in'));
  clearTimeout(chat.coverTimer);
  chat.coverTimer = setTimeout(() => { if (chat.open) document.body.classList.add('ch-covered'); }, 280);
  chatFitStart();
  try { history.replaceState(null, '', `#chat-${room}`); } catch (e) { /* file:// */ }
  chatRenderHead();
  chatBindScreen(el);
  try {
    if (!chat.rooms[room]) await chatLoadRoom(room);
    else {
      const msgs = chat.rooms[room].msgs.filter((m) => !m.sending);
      await chatLoadRoom(room, msgs.length ? { after: msgs[msgs.length - 1].at } : {});
    }
  } catch (e) {
    if (!chat.rooms[room]) { $('#chWall').innerHTML = `<div class="ch-loading">${esc(cloudErr(e))}</div>`; return; }
  }
  if (chat.open !== room) return;
  chatRenderWall(true);
  chatMarkRead();
}

/* iOS keeps the layout viewport full height when the keyboard opens and scrolls the page instead,
   so the room follows the visual viewport: it is exactly as tall as the visible area and the composer
   sits flush on the keyboard. */
function chatFit() {
  const el = document.getElementById('chatScreen');
  if (!el || !chat.open) return;
  const head = el.querySelector('.ch-head');
  if (head) el.style.setProperty('--ch-head', `${head.offsetHeight}px`);
  const vv = window.visualViewport;
  if (!vv) return;
  const wall = document.getElementById('chWall');
  const atEnd = wall && wall.scrollHeight - wall.scrollTop - wall.clientHeight < 40;
  const kb = window.innerHeight - vv.height > 120;
  el.style.height = `${Math.round(vv.height)}px`;
  el.style.top = `${Math.round(vv.offsetTop)}px`;
  el.classList.toggle('kb', kb);
  if (atEnd) wall.scrollTop = wall.scrollHeight;
}

function chatFitStart() {
  chatFitStop();
  chatFit();
  const vv = window.visualViewport;
  if (vv) { vv.addEventListener('resize', chatFit); vv.addEventListener('scroll', chatFit); }
  window.addEventListener('resize', chatFit);
}

function chatFitStop() {
  const vv = window.visualViewport;
  if (vv) { vv.removeEventListener('resize', chatFit); vv.removeEventListener('scroll', chatFit); }
  window.removeEventListener('resize', chatFit);
}

function closeChat() {
  const el = document.getElementById('chatScreen');
  chat.open = null;
  clearTimeout(chat.coverTimer);
  chatFitStop();
  document.body.classList.remove('ch-lock', 'ch-covered');
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  if (el) { el.classList.remove('in'); setTimeout(() => { if (!chat.open) el.remove(); }, 260); }
  render();
}

function chatStatusText() {
  const room = chat.open;
  if (!room) return '';
  const r = chat.rooms[room];
  const online = chat.state && chat.state.bridge && chat.state.bridge.online;
  const set = chat.state && chat.state.bridge && chat.state.bridge.set;
  if (r && r.pending === 'typing') return `<span class="ch-st typing">${CHAT_AI_NAME}กำลังพิมพ์…</span>`;
  if (r && r.pending && !online) return `<span class="ch-st warn">${CHAT_AI_NAME}ออฟไลน์ · จะตอบเมื่อ Mac เปิด</span>`;
  if (room === 'couple' && Date.now() - chat.partnerTyping < 5000) return `<span class="ch-st typing">${esc(partnerName())} กำลังพิมพ์…</span>`;
  const ai = !set ? 'ยังไม่ได้เชื่อม Mac' : online ? 'ผู้ช่วยออนไลน์' : 'ผู้ช่วยออฟไลน์';
  if (room === 'couple') return `<span class="ch-st">${cloud.partner ? `${esc(partnerName())} · ` : ''}${ai}</span>`;
  return `<span class="ch-st${online ? ' ok' : ''}">${ai}</span>`;
}
function chatRenderHead() {
  const s = document.getElementById('chStatus');
  if (s) s.innerHTML = chatStatusText();
}

function chatName(m) {
  if (m.ai) return CHAT_AI_NAME;
  return m.senderId === cloud.user.id ? (cloud.user.nickname || cloud.user.name) : partnerName();
}

// Text the person typed: escaped, newlines kept, @ผู้ช่วย and links highlighted. The assistant
// writes a little Markdown: **bold**, `code`, # headings and - bullets are shown, not printed.
function chatText(s, ai) {
  let h = esc(s);
  if (ai) {
    h = h.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }
  return h
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/@(ผู้ช่วย|ai|hermes|bot)/gi, '<span class="ch-mention">@$1</span>');
}

// One line of a message for a quote or a reply bar, without Markdown marks.
function chatPlain(m) {
  return m.ai ? m.text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/`/g, '') : m.text;
}

function chatDayLabel(ds) {
  const t = dateStr(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (ds === t) return 'วันนี้';
  if (ds === dateStr(y)) return 'เมื่อวาน';
  const d = parseDs(ds);
  return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${d.getFullYear() + BE}`;
}

function chatNoteCard(n) {
  if (!n) return '';
  const live = (cloud.notes || []).find((x) => x.id === n.id) || n;
  const d = live.date ? parseDs(live.date) : null;
  const when = d ? `${TH_DOW[d.getDay()]}. ${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]}${live.time ? ` · ${live.time}${live.endTime ? `–${live.endTime}` : ''} น.` : ''}` : 'ไม่ระบุวัน';
  const remind = live.date ? (live.remind == null ? 'ไม่เตือน' : (NOTE_REMINDS.concat(NOTE_REMINDS_OLD).find(([v]) => v === live.remind) || [0, 'ตั้งไว้'])[1]) : '';
  const gone = !(cloud.notes || []).some((x) => x.id === n.id);
  return `<div class="ch-act">
    <div class="ch-act-h">${svgIcon('todo', 'svg-i sm')}<span>${live.done ? 'เสร็จแล้ว' : 'สิ่งที่ต้องทำ'}</span></div>
    <div class="ch-act-r"><span>เรื่อง</span><b translate="no">${esc(live.text)}</b></div>
    <div class="ch-act-r"><span>เมื่อ</span><b>${when}</b></div>
    ${remind ? `<div class="ch-act-r"><span>เตือน</span><b>${remind}</b></div>` : ''}
    ${gone ? '<div class="ch-act-r"><span>ลบแล้ว</span></div>' : `<div class="ch-act-b"><button type="button" data-chat-note="${esc(n.id)}">เปิดดู / แก้ไข</button></div>`}
  </div>`;
}

function chatTicks(m, r) {
  if (m.ai || m.senderId !== cloud.user.id) return '';
  if (m.failed) return '<span class="ch-tk bad" title="ส่งไม่สำเร็จ">!</span>';
  if (m.sending) return '<span class="ch-tk">🕓</span>';
  const room = chat.open;
  let read = false;
  if (room === 'couple') read = !!(r.reads && r.reads.partner && String(r.reads.partner) >= String(m.at));
  else read = r.msgs.some((x) => x.ai && String(x.at) >= String(m.at));
  return `<span class="ch-tk${read ? ' read' : ''}">${read ? '✓✓' : '✓'}</span>`;
}

function chatBubble(m, r, first, last) {
  const mine = !m.ai && m.senderId === cloud.user.id;
  const kind = m.ai ? 'ai' : mine ? 'me' : 'partner';
  const showName = first && !mine && (chat.open === 'couple' || m.ai);
  const q = m.replyTo && r.msgs.find((x) => x.id === m.replyTo);
  const reacts = Object.entries(m.reactions || {}).reduce((acc, [uid, e]) => ((acc[e] = acc[e] || []).push(uid), acc), {});
  const reactHtml = Object.keys(reacts).length ? `<div class="ch-reacts">${Object.entries(reacts).map(([e, ids]) =>
    `<button type="button" class="ch-react${ids.includes(cloud.user.id) ? ' on' : ''}" data-chat-react="${esc(m.id)}" data-emoji="${e}">${e}${ids.length > 1 ? ` ${ids.length}` : ''}</button>`).join('')}</div>` : '';
  const body = m.deleted ? '<i class="ch-del">ข้อความถูกลบ</i>' : `<span class="ch-txt" translate="no">${chatText(m.text, m.ai)}</span>`;
  const action = m.action && m.action.type === 'note' ? chatNoteCard(m.action.note) : '';
  return `
    <div class="ch-msg ${kind}${last ? ' last' : ''}${first ? ' first' : ''}" data-mid="${esc(m.id)}">
      ${mine ? '' : `<span class="ch-av-slot">${last ? chatAvatar(kind === 'ai' ? 'ai' : 'partner', 'ch-av sm') : ''}</span>`}
      <div class="ch-b">
        ${showName ? `<div class="ch-who ${kind}">${esc(chatName(m))}${m.ai ? ' <span class="ch-ai-tag">AI</span>' : ''}</div>` : ''}
        ${q ? `<button type="button" class="ch-quote" data-chat-jump="${esc(q.id)}"><b>${esc(chatName(q))}</b><span translate="no">${esc(q.deleted ? 'ข้อความถูกลบ' : chatPlain(q).slice(0, 80))}</span></button>` : ''}
        ${body}${action}
        <span class="ch-meta">${m.editedAt && !m.deleted ? 'แก้ไขแล้ว ' : ''}${chatTime(m.at)}${chatTicks(m, r)}</span>
        ${reactHtml}
      </div>
    </div>`;
}

function chatRenderWall(jump) {
  const wall = document.getElementById('chWall');
  const r = chat.rooms[chat.open];
  if (!wall || !r) return;
  const nearBottom = jump || wall.scrollHeight - wall.scrollTop - wall.clientHeight < 140;
  const prevH = wall.scrollHeight;
  const prevTop = wall.scrollTop;
  const msgs = r.msgs;
  let html = r.more ? '<button type="button" class="ch-more" data-chat="more">ดูข้อความก่อนหน้า</button>' : '';
  if (!msgs.length) {
    html += `<div class="ch-empty">${chatGroupAvatar('ch-grp lg')}<b>${chatRoomName(chat.open)}</b><span>${chat.open === 'couple'
      ? `คุยกับ${esc(partnerName())}ได้ที่นี่ พิมพ์ @ผู้ช่วย เพื่อถามผู้ช่วย หรือขึ้นต้นด้วย ทำนัด / เตือน / จด เพื่อจดสิ่งที่ต้องทำ`
      : 'ถามเรื่องบิล งบประมาณ รายจ่าย หรือสั่ง “ทำนัด พรุ่งนี้ 9 โมง ไปธนาคาร” ได้เลย'}</span></div>`;
  }
  let day = '';
  msgs.forEach((m, i) => {
    const ds = dateStr(new Date(m.at));
    if (ds !== day) { day = ds; html += `<div class="ch-day"><span>${chatDayLabel(ds)}</span></div>`; }
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const key = (x) => (x ? `${x.ai ? 'ai' : x.senderId}|${dateStr(new Date(x.at))}` : '');
    const close = (a, b) => a && b && key(a) === key(b) && Math.abs(new Date(b.at) - new Date(a.at)) < 5 * 60000;
    html += chatBubble(m, r, !close(prev, m), !close(m, next));
  });
  if (r.pending === 'typing' || (r.pending && chat.state && chat.state.bridge.online)) {
    html += `<div class="ch-msg ai last first"><span class="ch-av-slot">${chatAvatar('ai', 'ch-av sm')}</span><div class="ch-b"><span class="ch-dots"><i></i><i></i><i></i></span></div></div>`;
  }
  wall.innerHTML = html;
  if (nearBottom) wall.scrollTop = wall.scrollHeight;
  else if (jump === 'keep') wall.scrollTop = prevTop + (wall.scrollHeight - prevH);
}

/* ---------- Sending ---------- */

function chatContext(text, room) {
  if (room !== 'ai' && !CHAT_MENTION.test(text) && !chat.reply) return undefined;
  const ctx = {};
  try {
    ctx.bills = occurrences(ymOf(new Date())).map((o) => ({ name: o.bill.name, amount: o.amount || 0, due: dateStr(o.due), paid: o.paid }));
  } catch (e) { /* no bills */ }
  try { ctx.cats = Object.fromEntries(catList().map((c) => [c.id, c.label])); } catch (e) { /* default names */ }
  return ctx;
}

async function chatSend(text) {
  const room = chat.open;
  text = text.trim();
  if (!room || !text) return;
  const r = chat.rooms[room];
  if (chat.edit) {
    const id = chat.edit;
    chatSetEdit(null);
    try { const out = await api('PUT', `/chat/messages/${id}`, { text }); chatUpsert(room, out.message); chatRenderWall(); } catch (e) { toast(cloudErr(e)); }
    return;
  }
  const m = { id: crypto.randomUUID(), room, senderId: cloud.user.id, ai: false, text, replyTo: chat.reply || undefined, at: new Date().toISOString(), reactions: {}, sending: true };
  const context = chatContext(text, room);
  if (r) { r.msgs.push(m); }
  chatSetReply(null);
  chatRenderWall(true);
  try {
    const out = await api('POST', '/chat/messages', { id: m.id, room, text, replyTo: m.replyTo, context });
    chatUpsert(room, out.message);
    if (out.assistant) chatUpsert(room, out.assistant);
  } catch (e) {
    m.sending = false;
    m.failed = true;
    toast(cloudErr(e));
  }
  chatRenderWall(true);
}

function chatSetReply(id) {
  chat.reply = id;
  if (id) chat.edit = null;
  const bar = document.getElementById('chReplyBar');
  if (!bar) return;
  const r = chat.rooms[chat.open];
  const m = id && r && r.msgs.find((x) => x.id === id);
  bar.hidden = !m;
  bar.innerHTML = m ? `<div><b>ตอบกลับ ${esc(chatName(m))}</b><span translate="no">${esc(chatPlain(m).slice(0, 90))}</span></div><button type="button" data-chat="unreply" aria-label="ยกเลิกการตอบกลับ">✕</button>` : '';
  if (m) document.getElementById('chInput').focus();
}

function chatSetEdit(id) {
  chat.edit = id;
  const bar = document.getElementById('chReplyBar');
  const input = document.getElementById('chInput');
  if (!bar || !input) return;
  const r = chat.rooms[chat.open];
  const m = id && r && r.msgs.find((x) => x.id === id);
  if (m) { chat.reply = null; input.value = m.text; chatGrow(input); input.focus(); }
  else if (!id) input.value = '';
  bar.hidden = !m;
  bar.innerHTML = m ? `<div><b>แก้ไขข้อความ</b><span translate="no">${esc(m.text.slice(0, 90))}</span></div><button type="button" data-chat="unedit" aria-label="ยกเลิกการแก้ไข">✕</button>` : '';
}

function chatGrow(t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 132)}px`; }

/* ---------- Message menu (long press) ---------- */

function chatMenu(id) {
  const r = chat.rooms[chat.open];
  const m = r && r.msgs.find((x) => x.id === id);
  if (!m || m.deleted || m.sending) return;
  const mine = !m.ai && m.senderId === cloud.user.id;
  const canDel = mine || (m.ai && chat.open === 'ai');
  const emojis = (chat.state && chat.state.reactions) || ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const layer = document.createElement('div');
  layer.className = 'ch-menu-layer';
  layer.innerHTML = `<div class="ch-menu" role="menu">
    <div class="ch-menu-emo">${emojis.map((e) => `<button type="button" data-menu-react="${e}" class="${m.reactions && m.reactions[cloud.user.id] === e ? 'on' : ''}">${e}</button>`).join('')}</div>
    <button type="button" data-menu="reply">ตอบกลับ</button>
    <button type="button" data-menu="copy">คัดลอก</button>
    ${mine ? '<button type="button" data-menu="edit">แก้ไข</button>' : ''}
    ${canDel ? '<button type="button" data-menu="delete" class="bad">ลบ</button>' : ''}
  </div>`;
  document.getElementById('chatScreen').appendChild(layer);
  requestAnimationFrame(() => layer.classList.add('in'));
  const close = () => layer.remove();
  layer.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) { close(); return; }
    close();
    if (b.dataset.menuReact) return chatReact(id, b.dataset.menuReact);
    const a = b.dataset.menu;
    if (a === 'reply') chatSetReply(id);
    else if (a === 'edit') chatSetEdit(id);
    else if (a === 'copy') {
      try { await navigator.clipboard.writeText(m.text); toast('คัดลอกแล้ว'); } catch (err) { toast('คัดลอกไม่ได้'); }
    } else if (a === 'delete') {
      try { const out = await api('DELETE', `/chat/messages/${id}`); chatUpsert(chat.open, out.message); chatRenderWall(); } catch (err) { toast(cloudErr(err)); }
    }
  });
}

async function chatReact(id, emoji) {
  const room = chat.open;
  try { const out = await api('POST', `/chat/messages/${id}/react`, { emoji }); chatUpsert(room, out.message); chatRenderWall(); } catch (e) { toast(cloudErr(e)); }
}

function chatBindScreen(el) {
  const form = el.querySelector('#chForm');
  const input = el.querySelector('#chInput');
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; chatGrow(input); chatSend(v); });
  input.addEventListener('keydown', (e) => {
    // Enter sends on a keyboard; on iPhone the return key adds a line and the arrow sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover: hover)').matches) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => {
    chatGrow(input);
    if (chat.open === 'couple' && Date.now() - chat.typingSent > 3000 && input.value.trim()) {
      chat.typingSent = Date.now();
      api('POST', '/chat/typing', { room: 'couple' }).catch(() => {});
    }
  });
  el.addEventListener('click', async (e) => {
    const t = e.target;
    const b = t.closest('[data-chat]');
    if (b) {
      const a = b.dataset.chat;
      if (a === 'close') closeChat();
      else if (a === 'unreply') chatSetReply(null);
      else if (a === 'unedit') chatSetEdit(null);
      else if (a === 'more') {
        const r = chat.rooms[chat.open];
        const first = r && r.msgs[0];
        if (first) { b.disabled = true; try { await chatLoadRoom(chat.open, { before: first.at }); } catch (err) { toast(cloudErr(err)); } chatRenderWall('keep'); }
      }
      return;
    }
    const chip = t.closest('[data-chat-chip]');
    if (chip) {
      const q = chip.dataset.chatChip;
      if (q === '@ผู้ช่วย') { input.value = `@ผู้ช่วย ${input.value}`.trimEnd() + ' '; input.focus(); chatGrow(input); } else chatSend(q);
      return;
    }
    const nb = t.closest('[data-chat-note]');
    if (nb) {
      const n = (cloud.notes || []).find((x) => x.id === nb.dataset.chatNote);
      if (n) { closeChat(); setTimeout(() => noteForm(n), 280); } else toast('ไม่พบโน้ตนี้');
      return;
    }
    const rb = t.closest('[data-chat-react]');
    if (rb) { chatReact(rb.dataset.chatReact, rb.dataset.emoji); return; }
    const jb = t.closest('[data-chat-jump]');
    if (jb) {
      const target = el.querySelector(`[data-mid="${CSS.escape(jb.dataset.chatJump)}"]`);
      if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); }
    }
  });
  // Long press or right click opens the message menu; a swipe to the left replies (like Telegram).
  const wall = el.querySelector('#chWall');
  let press = null;
  wall.addEventListener('touchstart', (e) => {
    const b = e.target.closest('.ch-msg[data-mid]');
    if (!b || e.target.closest('button, a')) return;
    const p = e.touches[0];
    press = { el: b, x: p.clientX, y: p.clientY, dx: 0, timer: setTimeout(() => { if (press && Math.abs(press.dx) < 8) { navigator.vibrate && navigator.vibrate(8); chatMenu(b.dataset.mid); press = null; } }, 480) };
  }, { passive: true });
  wall.addEventListener('touchmove', (e) => {
    if (!press) return;
    const p = e.touches[0];
    press.dx = p.clientX - press.x;
    const dy = p.clientY - press.y;
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(press.dx)) { clearTimeout(press.timer); press.el.style.transform = ''; press = null; return; }
    if (press.dx < -6) { clearTimeout(press.timer); press.el.style.transform = `translateX(${Math.max(press.dx, -70)}px)`; press.el.classList.toggle('swipe-ok', press.dx < -50); }
  }, { passive: true });
  const end = () => {
    if (!press) return;
    clearTimeout(press.timer);
    const { el: b, dx } = press;
    press = null;
    b.style.transform = '';
    b.classList.remove('swipe-ok');
    if (dx < -50) chatSetReply(b.dataset.mid);
  };
  wall.addEventListener('touchend', end);
  wall.addEventListener('touchcancel', end);
  wall.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.ch-msg[data-mid]');
    if (!b) return;
    e.preventDefault();
    chatMenu(b.dataset.mid);
  });
}

/* ---------- Account › ผู้ช่วย AI ---------- */

function chatSettings() {
  if (!chatReady()) return '';
  const b = (chat.state && chat.state.bridge) || {};
  const mine = b.mine;
  const status = b.online ? 'ออนไลน์' : b.set ? 'ออฟไลน์' : 'ยังไม่ได้เชื่อม';
  const seen = b.lastSeen ? ` · เห็นล่าสุด ${chatWhen(b.lastSeen)}${chatWhen(b.lastSeen).includes(':') ? '' : ` ${chatTime(b.lastSeen)}`}` : '';
  return `
    <div class="section-title">ผู้ช่วย AI ในแชท</div>
    <div class="form">
      <div class="field"><label>Hermes บน Mac</label><span class="ln-status${b.online ? ' ok' : ''}">${status}${seen}</span></div>
      ${mine && mine.info ? `<div class="field"><label>เครื่อง</label><span class="muted small" translate="no">${esc(mine.info)}</span></div>` : ''}
    </div>
    <div id="chBridgeBox"></div>
    <button class="btn ghost" id="chBridgeNew">${mine ? '🔑 สร้าง token ใหม่ (ตัวเก่าจะใช้ไม่ได้)' : '🔑 เชื่อม Mac ที่รัน Hermes Agent'}</button>
    ${mine ? '<button class="btn ghost" id="chBridgeOff">ยกเลิกการเชื่อม Mac เครื่องนี้</button>' : ''}
    <p class="hint">ผู้ช่วยในแชทคือ Hermes Agent ที่รันบน Mac ที่บ้าน Mac ต่อออกมาหา centel.app เอง ไม่ต้องเปิดพอร์ต ถ้า Mac ปิดหรือหลับ คำถามจะรอได้ 30 นาที ส่วนคำสั่ง ทำนัด / เตือน / จด ใช้ได้เสมอ</p>`;
}

function chatSettingsBind() {
  const nb = document.getElementById('chBridgeNew');
  if (!nb) return;
  nb.addEventListener('click', async () => {
    nb.disabled = true;
    try {
      const { token } = await api('POST', '/chat/bridge');
      const cmd = `curl -fsSL https://centel.app/bridge/install.sh | bash -s -- ${token}`;
      document.getElementById('chBridgeBox').innerHTML = `
        <div class="card ch-token">
          <b>ติดตั้งบน Mac (ครั้งเดียว)</b>
          <ol>
            <li>ใน <span class="mono">~/.hermes/.env</span> ใส่ <span class="mono">API_SERVER_ENABLED=true</span> และ <span class="mono">API_SERVER_KEY=…</span> แล้วรัน <span class="mono">hermes gateway</span></li>
            <li>เปิด Terminal แล้ววางคำสั่งนี้</li>
          </ol>
          <pre class="mono" translate="no">${esc(cmd)}</pre>
          <button class="btn" id="chCopy">คัดลอกคำสั่ง</button>
          <p class="hint">token นี้แสดงครั้งเดียว ใครมี token จะตอบในแชทแทนผู้ช่วยได้ อย่าแชร์</p>
        </div>`;
      document.getElementById('chCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(cmd); toast('คัดลอกแล้ว วางใน Terminal บน Mac'); } catch (e) { toast('คัดลอกไม่ได้ กดค้างที่คำสั่งเพื่อคัดลอก'); }
      });
      chatLoadState();
    } catch (e) { toast(cloudErr(e)); }
    nb.disabled = false;
  });
  const off = document.getElementById('chBridgeOff');
  if (off) off.addEventListener('click', async () => {
    if (!(await glassConfirm({ title: 'ยกเลิกการเชื่อม Mac?', text: 'ผู้ช่วยจะตอบในแชทไม่ได้จนกว่าจะเชื่อมใหม่', ok: 'ยกเลิกการเชื่อม' }))) return;
    try { await api('DELETE', '/chat/bridge'); await chatLoadState(); if (ui.tab === 'account') render(); toast('ยกเลิกการเชื่อมแล้ว'); } catch (e) { toast(cloudErr(e)); }
  });
}

/* ---------- Start ---------- */

function chatBoot() {
  if (!chatReady()) { chatDisconnect(); chat.state = null; chat.rooms = { couple: null, ai: null }; return; }
  chatConnect();
  chatLoadState().then(() => {
    if (!chat.booted) {
      chat.booted = true;
      const m = /^#chat-(couple|ai)$/.exec(location.hash);
      if (m) openChat(m[1]);
    }
    if (ui.tab === 'account') render();
  });
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-chat-open]');
  if (b) openChat(b.dataset.chatOpen);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') chatCatchUp(); });
setInterval(() => { if (document.visibilityState === 'visible' && chatReady() && Date.now() - chat.lastEvent > 50000) chatCatchUp(); }, 20000);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data && e.data.type === 'open' && /#chat-(couple|ai)$/.exec(e.data.url || '');
    if (m) openChat(m[1]);
  });
}
