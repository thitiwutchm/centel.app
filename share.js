'use strict';

/* Screenshot → purchase (iOS app only). A picture shared to Centel from the iOS share sheet
   (ios-app CentelShare extension) waits in the App Group's Inbox; the extension opens the app
   at centel://share. This takes the picture through the ShareInbox plugin (App/ShareInbox.swift),
   opens a new expense and hands the picture to AI Slips, which fills in the amount, shop, date
   and category. The person checks it and taps เพิ่มรายการ.
   Also checked whenever the app comes to the front, in case iOS did not let the extension open it.
   Older app builds have no plugin, so nothing happens. Loaded after app.js and widget.js. */

(() => {
  const cap = window.Capacitor;
  const plugin = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.ShareInbox;
  if (!plugin) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false;

  async function take() {
    if (busy) return;
    busy = true;
    try {
      const r = await plugin.take();
      if (!r || !r.image) return;
      const bytes = Uint8Array.from(atob(r.image), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'shared.jpg', { type: 'image/jpeg' });
      // Reading needs the signed-in account; right after a cold start it may still be loading.
      for (let i = 0; i < 40 && !(isCloud() && cloud.features && cloud.features.storage); i++) await sleep(250);
      setTab('home');
      if (!(isCloud() && cloud.features && cloud.features.storage)) {
        toast(isCloud() ? 'ยังอ่านสลิปไม่ได้ตอนนี้ กรอกรายการเองได้เลย' : 'ลงชื่อเข้าใช้ก่อน AI ถึงจะอ่านรูปให้ได้');
        txnForm();
        return;
      }
      txnForm(null, {}, { slip: file });
    } catch (e) {
      /* nothing waiting, or the plugin failed: leave the app as it is */
    } finally {
      busy = false;
    }
  }

  window.centelShareOpen = () => { setTimeout(take, 150); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(take, 400); });
  setTimeout(take, 600);
})();
