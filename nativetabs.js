// iOS app (ios-app/): the native shell's Liquid Glass tab bar replaces .tabbar.
// Older app builds have no NativeTabs plugin, so the call fails and .tabbar stays.
(() => {
  const cap = window.Capacitor;
  if (!cap || !cap.nativePromise || !(cap.isNativePlatform && cap.isNativePlatform())) return;
  const bar = document.querySelector('.tabbar');
  if (!bar) return;
  const SYMBOLS = {
    home: 'house.fill', txns: 'list.bullet.rectangle.portrait', bills: 'doc.text',
    budgets: 'rectangle.stack', account: 'person.crop.circle',
  };
  const hex = (rgb) => {
    const m = String(rgb).match(/\d+(\.\d+)?/g);
    return m ? '#' + m.slice(0, 3).map((n) => Math.round(+n).toString(16).padStart(2, '0')).join('') : '';
  };
  const isDark = (rgb) => {
    const m = String(rgb).match(/\d+(\.\d+)?/g);
    if (!m || (m[3] !== undefined && +m[3] === 0)) return true;
    return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] < 140;
  };
  // Sheets, dialogs and the chat room cover the web tab bar, so the native one steps aside for them.
  const covered = () => document.body.classList.contains('ch-lock')
    || !!document.querySelector('.sheet-backdrop:not([hidden]), .sheet:not([hidden]), .gconfirm');

  let last = '';
  let queued = false;
  function sync() {
    queued = false;
    const btns = [...bar.querySelectorAll('[data-tab]')];
    const active = bar.querySelector('[data-tab].active') || btns[0];
    const msg = {
      tabs: btns.map((b) => ({
        id: b.dataset.tab,
        title: (b.querySelector('.tab-in > span') || b).textContent.trim(),
        symbol: SYMBOLS[b.dataset.tab] || 'circle',
      })),
      selected: active ? active.dataset.tab : '',
      visible: !covered(),
      tint: active ? hex(getComputedStyle(active).color) : '',
      dark: isDark(getComputedStyle(document.body).backgroundColor),
    };
    const key = JSON.stringify(msg);
    if (key === last) return;
    last = key;
    cap.nativePromise('NativeTabs', 'sync', msg)
      .then(() => document.documentElement.classList.add('native-tabs'))
      .catch(() => { document.documentElement.classList.remove('native-tabs'); });
  }
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(sync); } };

  window.centelNativeTab = (id) => { if (typeof setTab === 'function') setTab(id); };
  new MutationObserver(queue).observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'data-theme'],
  });
  new MutationObserver(queue).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
  queue();
})();
