'use strict';

/* iPhone Home Screen / Lock Screen widget (ios-app/CentelWidget). Bills live on the device
   and the widget cannot run this page, so whenever the data could have changed the page
   hands the iOS app a small snapshot (WidgetData plugin, App/WidgetData.swift): this
   month's spending, the next unpaid bills and the open to-dos. The app keeps it in the
   App Group group.app.centel, where the widget reads it, and asks iOS to redraw.
   Only inside the iOS app; older builds without the plugin skip it.
   Loaded after app.js; money.js, notes.js and app.js helpers are used at run time. */

(() => {
  const cap = window.Capacitor;
  const plugin = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.WidgetData;
  if (!plugin) return;

  const WORDS = {
    th: { spend: 'ใช้จ่ายเดือนนี้', expenses: 'ใช้จ่าย', vsLast: 'เทียบเดือนก่อน', income: 'รายรับ', bills: 'บิลที่ใกล้ถึง', todos: 'สิ่งที่ต้องทำ', noBills: 'ไม่มีบิลค้างจ่าย', noTodos: 'ไม่มีสิ่งที่ต้องทำ', today: 'วันนี้', tomorrow: 'พรุ่งนี้', late: 'เลยกำหนด', inDays: 'อีก {0} วัน', needsAmount: 'ระบุยอด', open: 'เปิด Centel เพื่ออัปเดต' },
    en: { spend: 'Spent this month', expenses: 'Expenses', vsLast: 'vs last month', income: 'Income', bills: 'Upcoming bills', todos: 'To-dos', noBills: 'No unpaid bills', noTodos: 'Nothing to do', today: 'Today', tomorrow: 'Tomorrow', late: 'Overdue', inDays: 'In {0} days', needsAmount: 'Enter amount', open: 'Open Centel to update' },
  };

  function snapshot() {
    const now = new Date();
    const ym = ymOf(now);
    const lang = typeof LANG !== 'undefined' && LANG === 'en' ? 'en' : 'th';
    const S = walletSet('total');
    const { income, expense } = totalsIn(txnsInMonth(ym), S);
    // Spending added up day by day, this month up to today and all of last month, for the
    // Expenses widget's line and its "vs last month by today" chip.
    const prev = addMonths(ym, -1);
    const inS = (t) => inSel(t, S);
    const daily = cumDaily(ym, 'expense', inS).slice(0, now.getDate()).map((n) => Math.round(n));
    const lastDaily = cumDaily(prev, 'expense', inS).map((n) => Math.round(n));
    const lastSameDay = lastDaily.length ? lastDaily[Math.min(now.getDate(), lastDaily.length) - 1] : 0;
    const bills = [ym, addMonths(ym, 1)].flatMap((m) => occurrences(m))
      .filter((o) => !o.paid)
      .slice(0, 8)
      .map((o) => {
        const c = cat(o.bill);
        const face = o.bill.icon && !billImg(o.bill) ? o.bill.icon : c.icon;
        return { id: `${o.bill.id}:${o.ym}`, name: o.bill.name, amount: o.amount || 0, needsAmount: !!o.needsAmount, autopay: !!o.bill.autopay,
          due: dateStr(o.due), icon: face, color: String(c.color || '').slice(0, 9) };
      });
    const todos = (typeof notesOpen === 'function' ? notesOpen() : []).slice(0, 8)
      .map((n) => ({ id: n.id, text: String(n.text || '').slice(0, 120), date: n.date || null, time: n.time || null, shared: !!n.shared }));
    const css = getComputedStyle(document.documentElement);
    return {
      v: 1, lang, words: WORDS[lang], ym, monthLabel: tr(thMonthYear(ym)),
      expense, income, currency: '฿', bills, todos,
      daily, lastDaily, lastSameDay, daysInMonth: daysInMonth(ym), monthName: tr(TH_MONTHS[now.getMonth()]),
      accent: css.getPropertyValue('--accent').trim() || '#ff7a00',
      signedIn: typeof isCloud === 'function' && isCloud(),
    };
  }

  let last = '';
  let timer = null;
  function send() {
    timer = null;
    let json;
    try { json = JSON.stringify(snapshot()); } catch (e) { return; }
    if (json === last) return;
    plugin.set({ json }).then(() => { last = json; }).catch(() => {});
  }
  // Called after every render (cheap: the same snapshot is not sent twice) and when the
  // app goes to the background, which is when the person looks at the widget next.
  window.widgetChanged = (delay = 1500) => {
    clearTimeout(timer);
    if (delay <= 0) send(); else timer = setTimeout(send, delay);
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') window.widgetChanged(0); });
  // The widget's links: centel://bills, centel://todos, centel://home, centel://add (new transaction).
  window.centelWidgetOpen = (what) => {
    setTab(what === 'bills' ? 'bills' : 'home');
    if (what === 'todos') notesAction('notes');
    if (what === 'add') txnForm();
  };
  window.widgetChanged(2500);
  // A widget tap that opened the app before this page had loaded.
  if (plugin.pending) plugin.pending().then((r) => { if (r && r.link) setTimeout(() => window.centelWidgetOpen(r.link), 300); }).catch(() => {});
})();
