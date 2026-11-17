// Centel Invest: the investment portfolio web app served at invest.centel.app.
// Plain JS, hash routes ('' = portfolio, #/s/<symbol> = one stock), talks to the api at
// /api/invest. Prices come from the api (Yahoo Finance, cached 15 minutes); charts and the
// ticker tape are TradingView's free embed widgets. Uses the same Centel sign-in.
(() => {
  'use strict';
  const P = window.Port;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const S = { user: null, trades: [], quotes: {}, fx: { THB: 1 }, fxDay: null, filter: store.get('inv.filter') || 'all', loadedAt: 0 };

  /* ---------- Formatting ---------- */
  const nf2 = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf4 = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const nfq = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 6 });
  const money = (v) => (v == null ? '–' : nf2.format(v));
  const price = (v) => (v == null ? '–' : (Math.abs(v) < 10 ? nf4 : nf2).format(v));
  const qtyFmt = (v) => nfq.format(v || 0);
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
  const signed = (v) => (v == null ? '–' : sign(v) + nf2.format(Math.abs(v)));
  const pct = (v) => (v == null || !Number.isFinite(v) ? '–' : `${sign(v)}${nf2.format(Math.abs(v))}%`);
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const cur = (c) => (c === 'USD' ? '$' : '฿');
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const thDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
  const ticker = (symbol) => String(symbol).replace(/\.BK$/, '');
  const HUES = [24, 200, 150, 280, 340, 45, 175, 220, 0, 110];
  const hue = (s) => HUES[[...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
  const logo = (s, cls = 'logo') => `<span class="${cls}" style="background:hsl(${hue(s)} 55% 42%)">${esc(ticker(s).slice(0, 4))}</span>`;
  const KIND = { buy: 'ซื้อ', sell: 'ขาย', div: 'ปันผล' };
  const MARKET = { SET: 'หุ้นไทย', US: 'หุ้นอเมริกา' };

  /* ---------- API ---------- */
  const ERR = {
    bad_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', email_taken: 'อีเมลนี้มีบัญชีแล้ว', weak_password: 'รหัสผ่านอย่างน้อย 8 ตัวอักษร',
    bad_email: 'อีเมลไม่ถูกต้อง', bad_symbol: 'เลือกหุ้นจากรายการค้นหา', bad_kind: 'เลือกประเภทรายการ', bad_date: 'วันที่ไม่ถูกต้อง',
    bad_qty: 'จำนวนหุ้นต้องมากกว่า 0', bad_price: 'กรอกราคาให้ถูกต้อง', bad_fee: 'ค่าธรรมเนียมไม่ถูกต้อง', too_many_trades: 'รายการเยอะเกินไป',
    not_found: 'ไม่พบข้อมูล', too_many_requests: 'ลองใหม่อีกครั้งในอีกสักครู่', google_mismatch: 'อีเมลนี้ผูกกับบัญชี Google อื่นอยู่',
    fx_unavailable: 'ดึงอัตราแลกเปลี่ยนไม่ได้', history_unavailable: 'ดึงกราฟไม่ได้',
  };
  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-centel': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(ERR[json.error] || json.error || `ผิดพลาด (${res.status})`);
      e.status = res.status; e.code = json.error;
      throw e;
    }
    return json;
  }

  let toastT;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `show${err ? ' err' : ''}`;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.className = ''; }, err ? 4200 : 2400);
  }
  const fail = (e) => { console.error(e); toast(e.message || 'เกิดข้อผิดพลาด', true); };

  function dialog({ title, body, ok = 'บันทึก', cancel = 'ยกเลิก', extra = '', onOk, onOpen }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'dlg-back';
      back.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">
        <div class="dlg-h"><h3>${esc(title)}</h3><button class="x" data-x aria-label="ปิด">×</button></div>
        <div class="dlg-b">${body}</div>
        <div class="dlg-f">${extra}<span style="flex:1"></span>${cancel ? `<button class="btn" data-x>${esc(cancel)}</button>` : ''}${ok ? `<button class="btn primary" data-ok>${esc(ok)}</button>` : ''}</div></div>`;
      document.body.appendChild(back);
      const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      back.addEventListener('click', async (e) => {
        if (e.target === back || e.target.closest('[data-x]')) return close(null);
        const btn = e.target.closest('[data-ok]');
        if (btn) {
          btn.disabled = true;
          try {
            const r = onOk ? await onOk(back) : true;
            if (r !== false) close(r);
          } catch (err) { fail(err); } finally { btn.disabled = false; }
        }
      });
      if (onOpen) onOpen(back, close);
    });
  }

  /* ---------- Icons ---------- */
  const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    mark: I('<path d="M4 17l6-6 4 4 7-8"/><path d="M15 7h6v6"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    back: I('<path d="M15 18l-6-6 6-6"/>'),
    refresh: I('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
    out: I('<path d="M15 4h4v16h-4M10 17l5-5-5-5M15 12H3"/>'),
  };

  /* ---------- TradingView widgets ---------- */
  const dark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  function tvWidget(el, name, config) {
    el.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
    const s = document.createElement('script');
    s.src = `https://s3.tradingview.com/external-embedding/embed-widget-${name}.js`;
    s.async = true;
    s.textContent = JSON.stringify(config);
    el.firstChild.appendChild(s);
  }
  // TradingView's free widgets don't carry SET prices ("only available on TradingView"), so the
  // tape shows US holdings plus the US indices and the baht rate, and Thai stocks get our own chart.
  function tape(el, list) {
    const syms = list.filter((p) => p.market === 'US').slice(0, 16).map((p) => ({ proName: p.tv, title: ticker(p.symbol) }));
    syms.push({ proName: 'FOREXCOM:SPXUSD', title: 'S&P 500' }, { proName: 'FOREXCOM:NSXUSD', title: 'Nasdaq 100' }, { proName: 'FX_IDC:USDTHB', title: 'USD/THB' });
    tvWidget(el, 'ticker-tape', { symbols: syms, showSymbolLogo: true, isTransparent: true, displayMode: 'adaptive', colorTheme: dark() ? 'dark' : 'light', locale: 'th_TH' });
  }

  const RANGE = [['1mo', '1 เดือน'], ['6mo', '6 เดือน'], ['1y', '1 ปี'], ['5y', '5 ปี']];
  async function ownChart(el, p, range = store.get('inv.range') || '1y') {
    el.classList.add('own');
    el.innerHTML = `<div class="ranges">${RANGE.map(([k, l]) => `<button data-r="${k}" class="${k === range ? 'on' : ''}">${l}</button>`).join('')}</div><div class="plot"><div class="boot" style="min-height:0;height:100%">กำลังโหลดกราฟ…</div></div>`;
    $$('[data-r]', el).forEach((b) => { b.onclick = () => { store.set('inv.range', b.dataset.r); ownChart(el, p, b.dataset.r); }; });
    let h;
    try { h = await api('GET', `/invest/history?s=${encodeURIComponent(p.symbol)}&range=${range}`); } catch { $('.plot', el).innerHTML = '<div class="boot" style="min-height:0;height:100%">ดึงกราฟไม่ได้</div>'; return; }
    if (!el.isConnected) return;
    const pts = h.points;
    const W = 600, H = 300, pad = 6;
    const vals = pts.map((x) => x[1]).concat(p.qty > 0 && p.avg ? [p.avg] : []);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const x = (i) => (pts.length > 1 ? (i / (pts.length - 1)) * W : W / 2);
    const y = (v) => pad + (1 - (v - lo) / span) * (H - pad * 2);
    const line = pts.map((q, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(q[1]).toFixed(1)}`).join('');
    const upish = pts[pts.length - 1][1] >= pts[0][1];
    const col = upish ? 'var(--up)' : 'var(--down)';
    const chg = ((pts[pts.length - 1][1] - pts[0][1]) / pts[0][1]) * 100;
    const fmtD = (t) => new Date(t * 1000).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
    $('.plot', el).innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:100%">
        <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
        <path d="${line}L${W},${H}L0,${H}Z" fill="url(#g)"/>
        <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
        ${p.qty > 0 && p.avg ? `<path d="M0,${y(p.avg).toFixed(1)}H${W}" stroke="var(--muted)" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/>` : ''}
      </svg>
      <div class="plot-k"><span>${fmtD(pts[0][0])}</span><span class="${tone(chg)}">${pct(chg)} ในช่วงนี้</span><span>${fmtD(pts[pts.length - 1][0])}</span></div>
      <div class="plot-y"><span>${price(hi)}</span>${p.qty > 0 && p.avg ? `<span class="muted">- - ทุนเฉลี่ย ${price(p.avg)}</span>` : ''}<span>${price(lo)}</span></div>`;
  }

  function chart(el, p) {
    if (p.market === 'SET') return ownChart(el, p);
    tvWidget(el, 'advanced-chart', {
      autosize: true, symbol: p.tv, interval: 'D', range: '12M', timezone: 'Asia/Bangkok', theme: dark() ? 'dark' : 'light',
      style: '3', locale: 'th_TH', allow_symbol_change: false, hide_side_toolbar: true, hide_volume: false,
      save_image: false, calendar: false, support_host: 'https://www.tradingview.com',
      backgroundColor: dark() ? 'rgba(22, 23, 26, 1)' : 'rgba(255, 255, 255, 1)',
    });
  }

  /* ---------- Data ---------- */
  async function loadTrades() {
    const r = await api('GET', '/invest/trades');
    S.user = r.user;
    S.trades = r.trades;
  }
  async function loadPrices() {
    const pos = P.positions(S.trades);
    const wants = pos.map((p) => `${p.symbol}~${p.tv}`);
    const jobs = [];
    if (wants.length) jobs.push(api('GET', `/invest/quotes?s=${encodeURIComponent(wants.join(','))}`).then((r) => { S.quotes = { ...S.quotes, ...r.quotes }; }));
    if (pos.some((p) => p.currency === 'USD')) {
      jobs.push(api('GET', '/fx?cur=USD').then((r) => { S.fx.USD = r.rate; S.fxDay = r.rateDate; }).catch(() => {}));
    }
    await Promise.all(jobs);
    S.loadedAt = Date.now();
  }
  const valued = () => {
    const list = P.positions(S.trades).map((p) => P.value(p, S.quotes, S.fx));
    return list.sort((a, b) => (b.thb.value ?? b.thb.cost ?? 0) - (a.thb.value ?? a.thb.cost ?? 0));
  };

  /* ---------- Sign in ---------- */
  async function loadGoogle(container) {
    try {
      const cfg = await api('GET', '/config');
      if (!cfg.googleClientId) return;
      await new Promise((ok, no) => {
        if (window.google?.accounts) return ok();
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client'; s.onload = ok; s.onerror = no;
        document.head.appendChild(s);
      });
      window.google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: async (r) => {
          try { await api('POST', '/auth/google', { credential: r.credential }); start(); } catch (e) { fail(e); }
        },
      });
      container.hidden = false;
      window.google.accounts.id.renderButton($('.gbtn', container), { theme: dark() ? 'filled_black' : 'outline', size: 'large', width: 320, text: 'continue_with', locale: 'th' });
    } catch { /* Google sign-in not available here */ }
  }

  function renderAuth() {
    let mode = 'login';
    app.innerHTML = `<div class="auth"><form class="card" novalidate>
      <div class="brand"><span class="brand-mark">${ICON.mark}</span><div>Centel Invest<small>พอร์ตหุ้นไทยและหุ้นอเมริกา</small></div></div>
      <h2 data-t>เข้าสู่ระบบ</h2>
      <p class="muted" style="margin:0 0 18px">ใช้บัญชีเดียวกับแอป Centel</p>
      <div data-google hidden><div class="gbtn"></div><div class="or">หรือ</div></div>
      <div class="grid">
        <label class="field" data-name hidden><span>ชื่อ</span><input type="text" name="name" autocomplete="name"></label>
        <label class="field"><span>อีเมล</span><input type="email" name="email" autocomplete="email" required></label>
        <label class="field"><span>รหัสผ่าน</span><input type="password" name="password" autocomplete="current-password" required></label>
        <div class="err-text" data-err></div>
        <button class="btn primary" style="height:44px" data-go>เข้าสู่ระบบ</button>
        <button type="button" class="btn" style="border:0;background:none" data-switch>ยังไม่มีบัญชี? สมัครใช้งาน</button>
      </div></form></div>`;
    const f = $('form', app);
    loadGoogle($('[data-google]', f));
    $('[data-switch]', f).onclick = () => {
      mode = mode === 'login' ? 'register' : 'login';
      $('[data-name]', f).hidden = mode === 'login';
      $('[data-t]', f).textContent = mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครใช้งาน';
      $('[data-go]', f).textContent = mode === 'login' ? 'เข้าสู่ระบบ' : 'สร้างบัญชี';
      $('[data-switch]', f).textContent = mode === 'login' ? 'ยังไม่มีบัญชี? สมัครใช้งาน' : 'มีบัญชีแล้ว? เข้าสู่ระบบ';
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const email = $('[name=email]', f).value.trim(), password = $('[name=password]', f).value, name = $('[name=name]', f).value.trim();
      $('[data-err]', f).textContent = '';
      try {
        await api('POST', mode === 'login' ? '/auth/login' : '/auth/register', mode === 'login' ? { email, password } : { email, password, name: name || email.split('@')[0] });
        start();
      } catch (err) { $('[data-err]', f).textContent = err.message; }
    };
  }

  /* ---------- Portfolio ---------- */
  function topBar() {
    return `<div class="top">
      <div class="brand"><span class="brand-mark">${ICON.mark}</span><div>Centel Invest<small>${esc(S.user?.name || S.user?.email || '')}</small></div></div>
      <button class="icon-btn" data-refresh title="อัปเดตราคา" aria-label="อัปเดตราคา">${ICON.refresh}</button>
      <button class="icon-btn" data-logout title="ออกจากระบบ" aria-label="ออกจากระบบ">${ICON.out}</button>
    </div>`;
  }

  function renderHome() {
    const all = valued();
    const open = all.filter((p) => p.qty > 0);
    const closed = all.filter((p) => p.qty <= 0);
    const shown = open.filter((p) => S.filter === 'all' || p.market === S.filter);
    const t = P.totals(all);
    const totalVal = open.reduce((a, p) => a + (p.thb.value ?? p.thb.cost ?? 0), 0);
    const usd = open.some((p) => p.currency === 'USD');
    const asOf = S.loadedAt ? new Date(S.loadedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '';
    app.innerHTML = `<div class="page">
      ${topBar()}
      <div class="tape" data-tape></div>
      <section class="hero">
        <div class="lbl">มูลค่าพอร์ต</div>
        <div class="big">${money(t.value)}<small>บาท</small></div>
        <div class="chg">
          <span class="${tone(t.pl)}">${signed(t.pl)} (${pct(t.plPct)}) ทั้งหมด</span>
          <span class="${tone(t.day)}">${signed(t.day)} (${pct(t.dayPct)}) วันนี้</span>
        </div>
        <div class="hero-grid">
          <div><span>ต้นทุน</span><b>${money(t.cost)}</b></div>
          <div><span>กำไรที่ขายแล้ว</span><b class="${tone(t.realized)}">${signed(t.realized)}</b></div>
          <div><span>เงินปันผลรับ</span><b>${money(t.dividends)}</b></div>
        </div>
        <div class="fxline">${usd ? `หุ้นอเมริกาคิดเป็นบาทที่ 1 USD = ${S.fx.USD ? nf4.format(S.fx.USD) : '–'} บาท (ธปท.${S.fxDay ? ` ${thDate(S.fxDay)}` : ''}) · ` : ''}ราคาล่าสุด ${asOf} น. อาจล่าช้าราว 15 นาที${t.missing ? ` · ${t.missing} ตัวยังไม่มีราคา คิดที่ต้นทุน` : ''}</div>
      </section>
      ${open.length ? allocation(open, totalVal) : ''}
      ${open.length ? `<div class="tabs">${[['all', 'ทั้งหมด'], ['SET', 'หุ้นไทย'], ['US', 'หุ้นอเมริกา']].map(([k, l]) => `<button data-f="${k}" class="${S.filter === k ? 'on' : ''}">${l} ${k === 'all' ? open.length : open.filter((p) => p.market === k).length}</button>`).join('')}</div>` : ''}
      <div class="card list">${shown.length ? shown.map(holdingRow).join('') : `<div class="empty"><b>${open.length ? 'ไม่มีหุ้นในตลาดนี้' : 'ยังไม่มีหุ้นในพอร์ต'}</b>${open.length ? '' : 'กด “เพิ่มรายการ” เพื่อบันทึกการซื้อหุ้นไทยหรือหุ้นอเมริกาตัวแรก'}</div>`}</div>
      ${closed.length ? `<div class="sec-h"><span>ขายหมดแล้ว</span><span class="muted" style="font-weight:400;font-size:13px">${closed.length} ตัว</span></div>
        <div class="card list">${closed.map(closedRow).join('')}</div>` : ''}
    </div>
    <button class="fab" data-add>${ICON.plus}เพิ่มรายการ</button>`;
    tape($('[data-tape]'), open);
    wireTop();
    $$('[data-f]').forEach((b) => { b.onclick = () => { S.filter = b.dataset.f; store.set('inv.filter', S.filter); renderHome(); }; });
    $$('[data-s]').forEach((r) => { r.onclick = () => { location.hash = `#/s/${encodeURIComponent(r.dataset.s)}`; }; });
    $('[data-add]').onclick = () => tradeDialog();
  }

  function allocation(open, total) {
    if (!(total > 0)) return '';
    const parts = open.slice(0, 6).map((p) => ({ label: ticker(p.symbol), v: p.thb.value ?? p.thb.cost ?? 0, c: `hsl(${hue(p.symbol)} 55% 48%)` }));
    const rest = open.slice(6).reduce((a, p) => a + (p.thb.value ?? p.thb.cost ?? 0), 0);
    if (rest > 0) parts.push({ label: 'อื่นๆ', v: rest, c: 'var(--muted)' });
    return `<div class="alloc">${parts.map((p) => `<i style="width:${(p.v / total) * 100}%;background:${p.c}"></i>`).join('')}</div>
      <div class="alloc-key">${parts.map((p) => `<span><span class="dot" style="background:${p.c}"></span><b>${esc(p.label)}</b> ${nf2.format((p.v / total) * 100)}%</span>`).join('')}</div>`;
  }

  function holdingRow(p) {
    return `<div class="row" data-s="${esc(p.symbol)}">
      ${logo(p.symbol)}
      <div class="t"><b>${esc(ticker(p.symbol))}<span class="tag">${p.market === 'SET' ? 'TH' : 'US'}</span></b>
        <small>${qtyFmt(p.qty)} หุ้น · ทุน ${cur(p.currency)}${price(p.avg)} · ราคา ${p.price != null ? cur(p.currency) + price(p.price) : '–'}</small></div>
      <div class="v"><b>${money(p.thb.value ?? p.thb.cost)}</b>
        <span class="pill ${tone(p.pl)}">${pct(p.plPct)}</span>
        <small class="${tone(p.dayPct)}" style="display:block;font-size:12px">วันนี้ ${pct(p.dayPct)}</small></div>
    </div>`;
  }

  function closedRow(p) {
    const got = (p.thb.realized || 0) + (p.thb.dividends || 0);
    return `<div class="row" data-s="${esc(p.symbol)}">
      ${logo(p.symbol)}
      <div class="t"><b>${esc(ticker(p.symbol))}<span class="tag">${p.market === 'SET' ? 'TH' : 'US'}</span></b><small>${esc(p.name || '')}</small></div>
      <div class="v"><b class="${tone(got)}">${signed(got)}</b><small class="muted" style="font-size:12px">กำไร + ปันผล (บาท)</small></div>
    </div>`;
  }

  /* ---------- One stock ---------- */
  function renderStock(symbol) {
    const p = valued().find((x) => x.symbol === symbol);
    if (!p) { location.hash = ''; return; }
    const c = cur(p.currency);
    const usd = p.currency === 'USD';
    const both = (v) => (v == null ? '–' : `${c}${money(v)}${usd && p.rate ? `<small class="muted" style="font-weight:400"> ≈ ฿${money(v * p.rate)}</small>` : ''}`);
    const trades = [...p.trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    app.innerHTML = `<div class="page">
      <button class="back" data-back>${ICON.back}พอร์ต</button>
      <div class="d-head">${logo(p.symbol)}<div style="flex:1;min-width:0"><h1>${esc(ticker(p.symbol))}</h1><p>${esc(p.name || '')} · ${MARKET[p.market]}</p></div></div>
      <div class="d-price">${p.price != null ? c + price(p.price) : '–'}</div>
      <div class="${tone(p.dayPct)}" style="font-weight:600">${p.price != null && p.prevClose ? `${signed(p.price - p.prevClose)} (${pct(p.dayPct)}) วันนี้` : ''}${p.stale ? ' <span class="muted" style="font-weight:400">· ราคาเก่า</span>' : ''}</div>
      <div class="chart" data-chart></div>
      ${p.qty > 0 || p.realized || p.dividends ? `<div class="card stats">
        <div><span>จำนวนหุ้น</span><b>${qtyFmt(p.qty)}</b></div>
        <div><span>ต้นทุนเฉลี่ย</span><b>${p.qty > 0 ? c + price(p.avg) : '–'}</b></div>
        <div><span>มูลค่าตอนนี้</span><b>${both(p.value)}</b></div>
        <div><span>ต้นทุนรวม</span><b>${both(p.cost)}</b></div>
        <div><span>กำไร/ขาดทุน</span><b class="${tone(p.pl)}">${p.pl != null ? `${signed(p.pl)} (${pct(p.plPct)})` : '–'}</b></div>
        <div><span>วันนี้</span><b class="${tone(p.day)}">${signed(p.day)}</b></div>
        <div><span>กำไรที่ขายแล้ว</span><b class="${tone(p.realized)}">${signed(p.realized)}</b></div>
        <div><span>เงินปันผลรับ (หลังภาษี)</span><b>${money(p.dividends)}</b></div>
      </div>` : ''}
      <div class="sec-h"><span>รายการ</span><button class="btn" data-add style="height:34px">${ICON.plus}เพิ่ม</button></div>
      <div class="card list">${trades.map((t) => `<div class="trade" data-t="${t.id}">
        <span class="kind ${t.kind}">${KIND[t.kind]}</span>
        <div><b>${t.kind === 'div' ? `${c}${money(t.price)}` : `${qtyFmt(t.qty)} หุ้น @ ${c}${price(t.price)}`}</b>
          <small class="muted" style="display:block;font-size:12px">${thDate(t.date)}${t.fee ? ` · ${t.kind === 'div' ? 'ภาษี' : 'ค่าธรรมเนียม'} ${c}${money(t.fee)}` : ''}${t.note ? ` · ${esc(t.note)}` : ''}</small></div>
        <b>${t.kind === 'div' ? '' : `${c}${money(t.qty * t.price)}`}</b>
      </div>`).join('')}</div>
    </div>`;
    chart($('[data-chart]'), p);
    $('[data-back]').onclick = () => { location.hash = ''; };
    $('[data-add]').onclick = () => tradeDialog({ preset: p });
    $$('[data-t]').forEach((r) => { r.onclick = () => tradeDialog({ trade: S.trades.find((t) => t.id === r.dataset.t) }); });
  }

  /* ---------- Add / edit a trade ---------- */
  function tradeDialog({ trade = null, preset = null } = {}) {
    const st = {
      kind: trade?.kind || 'buy',
      stock: trade ? { symbol: trade.symbol, tv: trade.tv, name: trade.name, currency: trade.currency, market: trade.tv.startsWith('SET:') ? 'SET' : 'US' }
        : preset ? { symbol: preset.symbol, tv: preset.tv, name: preset.name, currency: preset.currency, market: preset.market } : null,
    };
    const held = (sym) => { const p = P.positions(S.trades.filter((t) => t.id !== trade?.id)).find((x) => x.symbol === sym); return p ? p.qty : 0; };
    const body = `<div class="grid">
      <div class="seg">${['buy', 'sell', 'div'].map((k) => `<button type="button" data-k="${k}">${KIND[k]}</button>`).join('')}</div>
      <div data-stock></div>
      <div class="grid g2">
        <label class="field span2"><span>วันที่</span><input type="date" name="date" max="${today()}" value="${esc(trade?.date || today())}"></label>
        <label class="field" data-qty><span>จำนวนหุ้น</span><input type="number" name="qty" inputmode="decimal" step="any" min="0" value="${trade && trade.kind !== 'div' ? trade.qty : ''}" placeholder="0"><small data-held></small></label>
        <label class="field" data-price><span data-pl>ราคาต่อหุ้น</span><input type="number" name="price" inputmode="decimal" step="any" min="0" value="${trade ? trade.price : ''}" placeholder="0.00"></label>
        <label class="field"><span data-fl>ค่าธรรมเนียม</span><input type="number" name="fee" inputmode="decimal" step="any" min="0" value="${trade?.fee || ''}" placeholder="0.00"></label>
        <label class="field"><span>บันทึก</span><input type="text" name="note" maxlength="300" value="${esc(trade?.note || '')}" placeholder="ไม่บังคับ"></label>
      </div>
      <div class="sum" data-sum></div>
      <div class="err-text" data-err></div>
    </div>`;
    return dialog({
      title: trade ? 'แก้ไขรายการ' : 'เพิ่มรายการ',
      body,
      extra: trade ? '<button class="btn danger" data-del>ลบ</button>' : '',
      onOpen: (el, close) => {
        const f = (n) => $(`[name=${n}]`, el);
        const paint = () => {
          $$('.seg button', el).forEach((b) => b.classList.toggle('on', b.dataset.k === st.kind));
          const div = st.kind === 'div';
          $('[data-qty]', el).hidden = div;
          $('[data-pl]', el).textContent = div ? 'เงินปันผลที่ได้รับ (ก่อนภาษี)' : 'ราคาต่อหุ้น';
          $('[data-fl]', el).textContent = div ? 'ภาษีหัก ณ ที่จ่าย' : 'ค่าธรรมเนียม + VAT';
          const c = st.stock ? cur(st.stock.currency) : '';
          const h = st.stock ? held(st.stock.symbol) : 0;
          $('[data-held]', el).textContent = st.kind === 'sell' && st.stock ? `มีอยู่ ${qtyFmt(h)} หุ้น` : '';
          const qty = Number(f('qty').value) || 0, pr = Number(f('price').value) || 0, fee = Number(f('fee').value) || 0;
          const total = div ? pr - fee : st.kind === 'buy' ? qty * pr + fee : qty * pr - fee;
          $('[data-sum]', el).innerHTML = `<span>${div ? 'ได้รับสุทธิ' : st.kind === 'buy' ? 'จ่ายทั้งหมด' : 'ได้รับสุทธิ'}</span><span>${c}${money(total)}</span>`;
          paintStock();
        };
        const paintStock = () => {
          const box = $('[data-stock]', el);
          if (box.dataset.for === (st.stock?.symbol || '')) return;
          box.dataset.for = st.stock?.symbol || '';
          if (st.stock) {
            box.innerHTML = `<div class="picked">${logo(st.stock.symbol)}<div><b>${esc(ticker(st.stock.symbol))}</b><small>${esc(st.stock.name || '')} · ${MARKET[st.stock.market]}</small></div>${trade || preset ? '' : '<button type="button" class="btn" data-change style="height:34px">เปลี่ยน</button>'}</div>`;
            const ch = $('[data-change]', box);
            if (ch) ch.onclick = () => { st.stock = null; paint(); };
            return;
          }
          box.innerHTML = `<div class="grid"><label class="field"><span>หุ้น</span><input type="search" data-q placeholder="ค้นหา เช่น PTT, KBANK, AAPL, VOO" autocomplete="off" autocapitalize="characters"></label><div class="results" data-res hidden></div></div>`;
          const q = $('[data-q]', box), res = $('[data-res]', box);
          let timer, seq = 0;
          q.oninput = () => {
            clearTimeout(timer);
            const v = q.value.trim();
            if (!v) { res.hidden = true; return; }
            timer = setTimeout(async () => {
              const my = ++seq;
              try {
                const r = await api('GET', `/invest/search?q=${encodeURIComponent(v)}`);
                if (my !== seq) return;
                res.hidden = false;
                res.innerHTML = r.results.length ? r.results.map((x, i) => `<button type="button" data-i="${i}">${logo(x.symbol)}<div><b>${esc(ticker(x.symbol))}</b> <span class="tag">${x.market === 'SET' ? 'TH' : 'US'}</span><small>${esc(x.name)}${x.type === 'ETF' ? ' · ETF' : ''}</small></div></button>`).join('')
                  : '<div class="empty" style="padding:16px">ไม่พบหุ้นไทยหรือหุ้นอเมริกาที่ตรงกัน</div>';
                $$('[data-i]', res).forEach((b) => {
                  b.onclick = async () => {
                    st.stock = r.results[Number(b.dataset.i)];
                    paint();
                    if (!f('price').value && st.kind !== 'div') {
                      try {
                        const qq = await api('GET', `/invest/quotes?s=${encodeURIComponent(`${st.stock.symbol}~${st.stock.tv}`)}`);
                        const got = qq.quotes[st.stock.symbol];
                        if (got && !f('price').value) { f('price').value = got.price; S.quotes[st.stock.symbol] = got; paint(); }
                      } catch { /* no price yet */ }
                    }
                  };
                });
              } catch (e) { fail(e); }
            }, 280);
          };
          setTimeout(() => q.focus(), 40);
        };
        $$('.seg button', el).forEach((b) => { b.onclick = () => { st.kind = b.dataset.k; paint(); }; });
        ['qty', 'price', 'fee'].forEach((n) => f(n).addEventListener('input', paint));
        const del = $('[data-del]', el);
        if (del) {
          del.onclick = async () => {
            if (!confirm('ลบรายการนี้?')) return;
            try {
              await api('DELETE', `/invest/trades/${trade.id}`);
              S.trades = S.trades.filter((t) => t.id !== trade.id);
              close(true); toast('ลบแล้ว'); route();
            } catch (e) { fail(e); }
          };
        }
        paint();
      },
      onOk: async (el) => {
        const f = (n) => $(`[name=${n}]`, el).value;
        const err = $('[data-err]', el);
        err.textContent = '';
        if (!st.stock) { err.textContent = 'เลือกหุ้นก่อน'; return false; }
        const qty = Number(f('qty'));
        if (st.kind === 'sell' && qty > held(st.stock.symbol) + 1e-9) { err.textContent = `มีหุ้นนี้อยู่ ${qtyFmt(held(st.stock.symbol))} หุ้น ขายเกินไม่ได้`; return false; }
        const payload = { symbol: st.stock.symbol, tv: st.stock.tv, name: st.stock.name, kind: st.kind, date: f('date'), qty: st.kind === 'div' ? 0 : qty, price: Number(f('price')), fee: Number(f('fee') || 0), note: f('note') };
        try {
          const r = trade ? await api('PUT', `/invest/trades/${trade.id}`, payload) : await api('POST', '/invest/trades', payload);
          S.trades = trade ? S.trades.map((t) => (t.id === trade.id ? r.trade : t)) : [...S.trades, r.trade];
        } catch (e) { err.textContent = e.message; return false; }
        toast(trade ? 'บันทึกแล้ว' : `เพิ่ม${KIND[st.kind]} ${ticker(st.stock.symbol)} แล้ว`);
        const fresh = !S.quotes[st.stock.symbol] || (st.stock.currency === 'USD' && !S.fx.USD);
        route();
        if (fresh) loadPrices().then(route).catch(() => {});
        return true;
      },
    });
  }

  /* ---------- Shell ---------- */
  function wireTop() {
    const r = $('[data-refresh]');
    if (r) r.onclick = async () => { r.disabled = true; try { await loadPrices(); route(); toast('อัปเดตราคาแล้ว'); } catch (e) { fail(e); } finally { r.disabled = false; } };
    const o = $('[data-logout]');
    if (o) o.onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); location.hash = ''; start(); };
  }

  let lastRoute = '';
  function route() {
    if (!S.user) return;
    const h = location.hash;
    const m = h.match(/^#\/s\/(.+)$/);
    const changed = h !== lastRoute;
    lastRoute = h;
    if (m) renderStock(decodeURIComponent(m[1]));
    else renderHome();
    if (changed) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', route);
  // Prices refresh every 5 minutes while the page is open (the api itself only goes out every 15).
  setInterval(() => { if (S.user && document.visibilityState === 'visible' && !$('.dlg-back')) loadPrices().then(route).catch(() => {}); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => {
    if (S.user && document.visibilityState === 'visible' && Date.now() - S.loadedAt > 5 * 60000 && !$('.dlg-back')) loadPrices().then(route).catch(() => {});
  });

  async function start() {
    try {
      await loadTrades();
    } catch (e) {
      S.user = null;
      if (e.status === 401) return renderAuth();
      app.innerHTML = `<div class="boot">เชื่อมต่อไม่สำเร็จ: ${esc(e.message)}</div>`;
      return;
    }
    route();
    try { await loadPrices(); } catch (e) { fail(e); }
    route();
  }
  start();
})();
