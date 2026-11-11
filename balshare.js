'use strict';

/* Balance sharing (แชร์เงินคงเหลือให้คู่): each person can let their partner see how much money
   they have left (ยอดเงินรวม), and optionally each wallet. The switch is the pill under the
   balance on Home, or Account › คู่ของฉัน › แชร์เงินคงเหลือให้คู่. While it is on, this page
   sends its totals to /api/balance whenever they change (server/src/balance.js keeps only the
   latest). The partner sees them in Home's ร่วมกับ … card. Loaded after app.js. */

(() => {
  const bs = { data: null, at: 0, busy: false, sent: '', timer: null };
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
    if (e.target.closest('[data-set-open="balshare"]')) { e.preventDefault(); settingsSheet('balshare'); }
  });

  /* ---------- When to check ---------- */

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => load(true), 900); });
  setInterval(() => { if (document.visibilityState === 'visible' && ui.tab === 'home') load(false); }, 3 * 60000);
  (async () => {
    for (let i = 0; i < 40 && !(isCloud() && cloud.user); i++) await new Promise((r) => setTimeout(r, 250));
    load(true);
  })();
})();
