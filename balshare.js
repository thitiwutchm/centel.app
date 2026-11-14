'use strict';

/* Balance sharing (แชร์เงินคงเหลือให้คู่): each person can let their partner see how much money
   they have left (ยอดเงินรวม), and optionally each wallet. The switch is the pill under the
   balance on Home, or Account › คู่ของฉัน › แชร์เงินคงเหลือให้คู่. While it is on, this page
   sends its totals to /api/balance whenever they change (server/src/balance.js keeps only the
   latest). The partner sees them in Home's ร่วมกับ … card.
   Expense sharing (แชร์รายจ่ายให้คู่) is a second, separate switch (Account › คู่ของฉัน): while
   it is on, the partner sees all of this person's expenses, a month at a time, read-only
   (/api/balance/expenses). Loaded after app.js. */

(() => {
  const bs = { data: null, at: 0, busy: false, sent: '', timer: null, exp: {}, expYm: '', expBusy: false };
  const ready = () => isCloud() && cloud.user && cloud.partner;
  const me = () => (bs.data && bs.data.me) || { sharing: false, perWallet: false };
  const sharing = () => ready() && me().sharing;

  function ago(iso) {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (!(m >= 0)) return '';
    if (m < 2) return 'เมื่อสักครู่';
    if (m < 60) return `${m} นาทีที่แล้ว`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} ชม.ที่แล้ว` : `${Math.floor(h / 24)} วันที่แล้ว`;
  }

  function rerender() {
    if (ui.tab === 'home' || ui.tab === 'account') render();
    if (ui.tab !== 'account' && ui.setSheet === 'balshare' && !$('#sheet').hidden) settingsSheet('balshare', true);
    if (ui.tab !== 'account' && ui.setSheet === 'expshare' && !$('#sheet').hidden) settingsSheet('expshare', true);
  }

  async function load(force) {
    if (!ready()) return;
    if (!force && Date.now() - bs.at < 60000) return;
    bs.at = Date.now();
    try {
      const next = await api('GET', '/balance');
      const was = JSON.stringify(bs.data);
      bs.data = next;
      if (was !== JSON.stringify(next)) rerender();
      queue();
      if (partnerSharesExp()) loadExp(ymOf(new Date()), force); else bs.exp = {};
    } catch (e) { /* offline: keep what we had */ }
  }

  /* ---------- Sending my totals ---------- */

  // The same total as Home's ยอดเงินรวม; wallets that count in it, without packages.
  function snapshot() {
    return {
      total: Math.round(balanceOf('total') * 100) / 100,
      wallets: money.wallets.filter((w) => !w.excluded && !isPkg(w))
        .map((w) => ({ name: w.name, emoji: wEmoji(w), balance: Math.round(balanceOf(w.id) * 100) / 100 })),
    };
  }
  function queue() {
    if (!sharing() || !cloud.fresh) return;
    const snap = snapshot();
    const key = JSON.stringify([me().perWallet, snap]);
    if (key === bs.sent) return;
    clearTimeout(bs.timer);
    bs.timer = setTimeout(async () => {
      if (!sharing()) return;
      try {
        const r = await api('POST', '/balance', snap);
        bs.sent = key;
        bs.data = { ...(bs.data || {}), me: r.me };
      } catch (e) {
        if (e.status === 409) load(true); // turned off on another device
      }
    }, 1500);
  }
  // Every redraw may follow a change to my money: check whether the totals moved.
  const baseRender = window.render;
  window.render = function () { const out = baseRender.apply(this, arguments); queue(); return out; };

  async function setSharing(on, perWallet = me().perWallet) {
    bs.busy = true;
    rerender();
    try {
      const r = await api('PUT', '/balance/sharing', { on, perWallet: on && perWallet });
      bs.data = { ...(bs.data || {}), me: r.me };
      bs.sent = '';
      if (on) {
        await api('POST', '/balance', snapshot()).then((x) => { bs.data.me = x.me; }).catch(() => {});
        bs.sent = JSON.stringify([r.me.perWallet, snapshot()]);
      }
      toast(on ? `${partnerName()} เห็นเงินคงเหลือของคุณแล้ว` : 'ปิดแชร์เงินคงเหลือแล้ว');
    } catch (e) {
      toast(cloudErr(e));
    } finally {
      bs.busy = false;
      rerender();
    }
  }

  /* ---------- Home ---------- */

  // The pill under ยอดเงินรวม: one tap shares my balance with my partner, or stops.
  window.balShareBtn = () => {
    if (!ready() || !bs.data) return '';
    const on = me().sharing;
    return `<button class="glass-pill bal-share${on ? ' on' : ''}" data-bal-share aria-pressed="${on}" ${bs.busy ? 'disabled' : ''}>
      <span class="bs-dot"></span>${on ? `แชร์ให้ ${esc(partnerName())} อยู่` : `แชร์ให้ ${esc(partnerName())}`}</button>`;
  };

  // My partner's balance, when they share it: rows inside the ร่วมกับ … card (cloud.js coupleCard).
  window.partnerBalRows = () => {
    if (!ready() || !bs.data) return '';
    const p = bs.data.partner;
    if (!p || !p.sharing || p.total == null) return '';
    const hide = money.prefs.hideBalance;
    const amt = (n) => (hide ? '฿ ••••••' : sbaht(n));
    return `
      <button class="item pb-total" data-set-open="balshare">${userAvatar(cloud.partner, 'avatar pb-av')}
        <div class="main"><div class="name">เงินคงเหลือของ ${esc(partnerName())}</div><div class="sub">อัปเดต ${ago(p.at)}</div></div>
        <div class="right"><div class="amt">${amt(p.total)}</div></div></button>
      ${(p.wallets || []).map((w) => `<div class="item pb-wallet"><span class="pb-ico">${esc(w.emoji || '👛')}</span>
        <div class="main"><div class="name">${esc(w.name)}</div></div><div class="right"><div class="amt">${amt(w.balance)}</div></div></div>`).join('')}`;
  };

  /* ---------- My partner's expenses (แชร์รายจ่ายให้คู่) ---------- */

  const partnerSharesExp = () => ready() && !!(bs.data && bs.data.partner && bs.data.partner.expenses);

  // One month of my partner's expenses, kept for a minute. Rerenders what shows it.
  async function loadExp(ym, force) {
    if (!partnerSharesExp()) return;
    const had = bs.exp[ym];
    if (!force && had && Date.now() - had.at < 60000) return;
    try {
      const r = await api('GET', `/balance/expenses?ym=${ym}`);
      const was = had && JSON.stringify([had.total, had.items]);
      bs.exp[ym] = { ...r, at: Date.now() };
      if (was !== JSON.stringify([r.total, r.items])) {
        if (ui.tab === 'home') render();
        if (sheetOpen() && bs.expYm === ym) drawExp();
      }
    } catch (e) {
      if (e.status === 403 || e.status === 404) { bs.exp = {}; load(true); }
      else if (sheetOpen() && bs.expYm === ym && !had) drawExp(cloudErr(e));
    }
  }
  const sheetOpen = () => !$('#sheet').hidden && !!$('#pexpBody');

  // My partner's own categories first (they may have their own), then mine.
  function catFor(x, cats) {
    if (!x.category) return NO_CAT;
    const c = cats.get(x.category) || catById(x.category) || catFallback('expense');
    return c;
  }
  const catsOf = (m) => new Map((Array.isArray(m.cats) && m.cats.length ? cleanCats(m.cats) : []).map((c) => [c.id, c]));

  // Row in the ร่วมกับ … card: this month's total, tap for the list.
  window.partnerExpRow = () => {
    if (!partnerSharesExp()) return '';
    const m = bs.exp[ymOf(new Date())];
    return `
      <button class="item pb-total pe-row" data-pexp>
        <div class="ico round" style="background:#ff6b3d22">🧾</div>
        <div class="main"><div class="name">รายจ่ายของ ${esc(partnerName())}</div>
          <div class="sub">${m ? `ทั้งหมดเดือนนี้ · ${m.items.length} รายการ` : 'กำลังโหลด…'}</div></div>
        <div class="right"><div class="amt">${m ? baht(m.total) : ''}</div></div>
        ${svgIcon('chev', 'svg-i sm muted')}
      </button>`;
  };

  function expItem(x, cats) {
    const c = catFor(x, cats);
    const shared = x.scope === 'shared';
    const sub = [esc(x.merchant), esc(x.note),
      shared ? (Math.abs(x.amount - x.total) < 0.005 ? (x.paidByPartner ? 'รับผิดชอบทั้งหมด' : '') : `หาร 2 · ทั้งหมด ${baht(x.total)}`) : '',
    ].filter(Boolean).join(' · ');
    const badges = [
      shared ? '<span class="badge share">ร่วม</span>' : '',
      x.bill ? '<span class="badge muted">บิล</span>' : '',
      x.inst ? `<span class="badge inst">ผ่อน ${x.inst.n}/${x.inst.of}</span>` : '',
    ].join(' ').trim();
    return `
      <div class="item tx">
        <div class="ico-wrap">${circleIco(c)}</div>
        <div class="main"><div class="name">${esc(c.label)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${badges ? `<div class="badges">${badges}</div>` : ''}</div>
        <div class="right"><div class="amt exp">${curAmt(x.amount, x.currency)}</div>${x.fx ? `<div class="amt-fx">${curAmt(x.fx.amt, x.fx.cur)}</div>` : ''}</div>
      </div>`;
  }

  function expBody(m) {
    const cats = catsOf(m);
    if (!m.items.length) return '<div class="empty"><div class="e-ico">🧾</div>ไม่มีรายจ่ายในเดือนนี้</div>';
    // Biggest categories (rolled up to the top level) as a quick summary.
    const by = new Map();
    m.items.forEach((x) => {
      let c = catFor(x, cats);
      if (c.parent) c = cats.get(c.parent) || catById(c.parent) || c;
      const o = by.get(c.id) || { c, n: 0 };
      o.n += x.amount;
      by.set(c.id, o);
    });
    const top = [...by.values()].sort((a, b) => b.n - a.n);
    const max = top[0].n || 1;
    const summary = `<div class="card list-card pe-cats">${top.slice(0, 6).map((o) => `
      <div class="item">${circleIco(o.c)}<div class="main"><div class="name">${esc(o.c.label)}</div>
        <div class="pe-bar"><i style="width:${Math.max(3, (o.n / max) * 100)}%;background:${o.c.color}"></i></div></div>
        <div class="right"><div class="amt">${baht(o.n)}</div><div class="amt-fx">${Math.round((o.n / (m.total || 1)) * 100)}%</div></div></div>`).join('')}</div>`;
    const days = {};
    m.items.forEach((x) => { (days[x.date] = days[x.date] || []).push(x); });
    const list = Object.keys(days).sort().reverse().map((ds) => {
      const items = days[ds].slice().reverse();
      const d = parseDs(ds);
      const net = items.reduce((n, x) => n + x.amount, 0);
      return `
        <div class="day-card">
          <div class="day-head">
            <div class="dnum">${d.getDate()}</div>
            <div class="dmeta"><div>${dayLabel(ds)}</div><div>${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + BE}</div></div>
            <div class="dtotal">${sbaht(-net)}</div>
          </div>
          ${items.map((x) => expItem(x, cats)).join('')}
        </div>`;
    }).join('');
    return summary + list;
  }

  function drawExp(err) {
    const el = $('#pexpBody');
    if (!el) return;
    const ym = bs.expYm;
    const m = bs.exp[ym];
    const now = ymOf(new Date());
    $('#pexpMonth').textContent = thMonthYear(ym);
    $('#pexpNext').disabled = ym >= now;
    $('#pexpTotal').innerHTML = m ? `${baht(m.total)} <span class="muted small">· ${m.items.length} รายการ</span>` : '…';
    el.innerHTML = m ? expBody(m) : err ? `<div class="empty">${esc(err)}</div>` : '<div class="empty">กำลังโหลด…</div>';
  }

  function openExp(ym) {
    bs.expYm = ym || ymOf(new Date());
    openSheet(`
      <div class="sheet-head"><button class="link-btn" data-action="close">ปิด</button><h2>รายจ่ายของ ${esc(partnerName())}</h2><span style="width:40px"></span></div>
      <div class="pe-month">
        <button type="button" class="day-step" data-pexp-step="-1" aria-label="เดือนก่อน">${svgIcon('chev', 'svg-i sm flip')}</button>
        <div class="pe-mid"><div id="pexpMonth"></div><div class="pe-total" id="pexpTotal"></div></div>
        <button type="button" class="day-step" id="pexpNext" data-pexp-step="1" aria-label="เดือนถัดไป">${svgIcon('chev', 'svg-i sm')}</button>
      </div>
      <p class="hint pe-hint">รายจ่ายส่วนตัวทั้งหมด และส่วนของ ${esc(partnerName())} ในรายจ่ายร่วม · ดูได้อย่างเดียว</p>
      <div id="pexpBody"></div>`);
    drawExp();
    loadExp(bs.expYm, true);
  }

  async function setExpSharing(on) {
    bs.expBusy = true;
    rerender();
    try {
      const r = await api('PUT', '/balance/expenses-sharing', { on });
      bs.data = { ...(bs.data || {}), me: r.me };
      toast(on ? `${partnerName()} เห็นรายจ่ายทั้งหมดของคุณแล้ว` : 'ปิดแชร์รายจ่ายแล้ว');
    } catch (e) {
      toast(cloudErr(e));
    } finally {
      bs.expBusy = false;
      rerender();
    }
  }

  window.expShareRow = () => (ready()
    ? setRow({ set: 'expshare', ico: '🧾', color: '#ff6b3d', name: 'แชร์รายจ่ายให้คู่', value: me().expenses ? 'เปิดอยู่' : 'ปิดอยู่' })
    : '');

  window.expShareSettings = () => {
    const m = me();
    const p = bs.data && bs.data.partner;
    return `
      <div class="form">
        <div class="field"><label for="esOn">ให้ ${esc(partnerName())} ดูรายจ่ายทั้งหมดของฉัน</label><span style="flex:1"></span>
          <label class="switch"><input type="checkbox" id="esOn" ${m.expenses ? 'checked' : ''} ${bs.expBusy ? 'disabled' : ''}><span></span></label></div>
      </div>
      <p class="hint">${esc(partnerName())} จะเห็นรายจ่ายส่วนตัวทุกรายการ (หมวดหมู่ ร้าน โน้ต จำนวนเงิน) และส่วนของคุณในรายจ่ายร่วม ย้อนดูได้ทีละเดือน แก้ไขไม่ได้ · ไม่เห็นรายรับ การโอน กระเป๋าเงิน หรือสลิป · ปิดสวิตช์แล้ว ${esc(partnerName())} จะดูไม่ได้ทันที</p>
      <p class="hint">${p && p.expenses ? `${esc(partnerName())} แชร์รายจ่ายให้คุณอยู่ ดูได้ที่การ์ด ร่วมกับ ${esc(partnerName())} หน้าหลัก` : `${esc(partnerName())} ยังไม่ได้เปิดแชร์รายจ่าย`}</p>`;
  };

  window.expShareBind = () => {
    const on = $('#esOn');
    if (on) on.addEventListener('change', (e) => setExpSharing(e.target.checked));
  };

  /* ---------- Account › คู่ของฉัน › แชร์เงินคงเหลือให้คู่ ---------- */

  window.balShareRow = () => (ready()
    ? setRow({ set: 'balshare', ico: '💰', color: '#34c759', name: 'แชร์เงินคงเหลือให้คู่', value: me().sharing ? 'เปิดอยู่' : 'ปิดอยู่' })
    : '');

  window.balShareSettings = () => {
    const m = me();
    const p = bs.data && bs.data.partner;
    const dis = bs.busy ? 'disabled' : '';
    return `
      <div class="form">
        <div class="field"><label for="bsOn">แชร์เงินคงเหลือของฉันให้ ${esc(partnerName())}</label><span style="flex:1"></span>
          <label class="switch"><input type="checkbox" id="bsOn" ${m.sharing ? 'checked' : ''} ${dis}><span></span></label></div>
        ${m.sharing ? `<div class="field"><label for="bsPer">แสดงแยกแต่ละกระเป๋า</label><span style="flex:1"></span>
          <label class="switch"><input type="checkbox" id="bsPer" ${m.perWallet ? 'checked' : ''} ${dis}><span></span></label></div>` : ''}
      </div>
      ${m.sharing && m.total != null ? `<p class="hint">${esc(partnerName())} เห็นยอดเงินรวมของคุณ ${masked(sbaht(m.total))}${m.perWallet ? ' และยอดแต่ละกระเป๋า' : ''} · อัปเดต ${ago(m.at)}</p>` : ''}
      <p class="hint">${p && p.sharing ? `${esc(partnerName())} แชร์เงินคงเหลือให้คุณอยู่ ดูได้ที่หน้าหลัก` : `${esc(partnerName())} ยังไม่ได้เปิดแชร์เงินคงเหลือ`}</p>
      <p class="hint">ใช้ยอดเดียวกับยอดเงินรวมที่หน้าหลัก (ไม่รวมกระเป๋าที่ตั้งว่าไม่รวมในยอดรวม และแพ็กเกจ) อัปเดตทุกครั้งที่ยอดเปลี่ยนในแอป ${esc(partnerName())} เห็นเฉพาะยอดคงเหลือ ไม่เห็นรายการ · ปิดสวิตช์แล้วยอดที่แชร์จะถูกลบทันที</p>`;
  };

  window.balShareBind = () => {
    const on = $('#bsOn');
    if (on) on.addEventListener('change', (e) => setSharing(e.target.checked));
    const per = $('#bsPer');
    if (per) per.addEventListener('change', (e) => setSharing(true, e.target.checked));
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-bal-share]')) { e.preventDefault(); if (!bs.busy) setSharing(!me().sharing); return; }
    if (e.target.closest('[data-set-open="balshare"]')) { e.preventDefault(); settingsSheet('balshare'); return; }
    if (e.target.closest('[data-pexp]')) { e.preventDefault(); openExp(); return; }
    const step = e.target.closest('[data-pexp-step]');
    if (step && !step.disabled) {
      e.preventDefault();
      bs.expYm = addMonths(bs.expYm, Number(step.dataset.pexpStep));
      drawExp();
      loadExp(bs.expYm, false);
    }
  });

  /* ---------- When to check ---------- */

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => load(true), 900); });
  setInterval(() => { if (document.visibilityState === 'visible' && ui.tab === 'home') load(false); }, 3 * 60000);
  (async () => {
    for (let i = 0; i < 40 && !(isCloud() && cloud.user); i++) await new Promise((r) => setTimeout(r, 250));
    load(true);
  })();
})();
