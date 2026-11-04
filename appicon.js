'use strict';

/* App icon picker in Account (iOS app only): the orange Centel icon or the green one.
   iOS switches the Home Screen icon through the AppIcon plugin (App/AppIcon.swift) and
   shows its own short notice. Older app builds have no plugin, so nothing is shown.
   Loaded after app.js; renderSettings() calls appIconSettings(). */

(() => {
  const cap = window.Capacitor;
  const plugin = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.AppIcon;
  if (!plugin) return;
  const ICONS = [['orange', 'ส้ม', 'icons/centel-180.png'], ['green', 'เขียว', 'icons/centel-green-180.png']];
  let current = 'orange';
  let busy = false;
  const rerender = () => { if (ui.tab === 'account') { const y = window.scrollY; render(); window.scrollTo(0, y); } };
  plugin.get().then((r) => { if (r && r.icon && r.icon !== current) { current = r.icon; rerender(); } }).catch(() => {});

  window.appIconSettings = () => `
    <div class="section-title">ไอคอนแอป</div>
    <div class="icon-pick">${ICONS.map(([id, label, src]) => `<button type="button" class="ip${id === current ? ' on' : ''}" data-appicon="${id}" aria-pressed="${id === current}">
      <img src="${src}" alt="" width="60" height="60"><span>${label}</span></button>`).join('')}</div>`;

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-appicon]');
    if (!b || busy || b.dataset.appicon === current) return;
    busy = true;
    try {
      const r = await plugin.set({ icon: b.dataset.appicon });
      current = (r && r.icon) || b.dataset.appicon;
      rerender();
    } catch (err) { toast('เปลี่ยนไอคอนไม่สำเร็จ'); } finally { busy = false; }
  });
})();
