'use strict';

/* English / Thai UI. Thai is the source language: the app code writes Thai, and in
   English mode this file translates what reaches the screen. A MutationObserver
   rewrites Thai text nodes and placeholder / aria-label / title attributes before
   the browser paints, and alert / confirm / prompt are wrapped the same way.
   The choice is kept per device in localStorage (centel.lang). Loaded in <head>. */

const LANG_KEY = 'centel.lang';
const LANG = (() => { try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'th'; } catch (e) { return 'th'; } })();
// Thai dates show the Buddhist year (+543); English shows the Gregorian year.
const BE = LANG === 'en' ? 0 : 543;

function setLang(l) {
  try { localStorage.setItem(LANG_KEY, l === 'en' ? 'en' : 'th'); } catch (e) { /* private mode */ }
  location.reload();
}

/* Thai → English. {0}, {1}… stand for values the code fills in (numbers, names,
   dates); the English side may use them in any order. Keys are whole text nodes. */
const I18N_EN = {
  // Tabs, top bar, add button
  'เดือนก่อนหน้า': 'Previous month', 'กลับไปเดือนปัจจุบัน': 'Back to this month', 'เดือนถัดไป': 'Next month',
  'เพิ่มรายการ': 'Add transaction', 'หน้าหลัก': 'Home', 'รายการ': 'Transactions', 'บิล': 'Bills',
  'งบประมาณ': 'Budgets', 'บัญชี': 'Account', 'เพิ่มบิล': 'Add bill', 'บิลทั้งหมด': 'All bills',
  'วางแผนการจ่ายบิล บันทึกรายรับรายจ่าย กระเป๋าเงิน และงบประมาณรายเดือน': 'Plan bill payments, track income and spending, wallets and monthly budgets',

  // Months and weekdays
  'มกราคม': 'January', 'กุมภาพันธ์': 'February', 'มีนาคม': 'March', 'เมษายน': 'April', 'พฤษภาคม': 'May', 'มิถุนายน': 'June',
  'กรกฎาคม': 'July', 'สิงหาคม': 'August', 'กันยายน': 'September', 'ตุลาคม': 'October', 'พฤศจิกายน': 'November', 'ธันวาคม': 'December',
  'ม.ค.': 'Jan', 'ก.พ.': 'Feb', 'มี.ค.': 'Mar', 'เม.ย.': 'Apr', 'พ.ค.': 'May', 'มิ.ย.': 'Jun',
  'ก.ค.': 'Jul', 'ส.ค.': 'Aug', 'ก.ย.': 'Sep', 'ต.ค.': 'Oct', 'พ.ย.': 'Nov', 'ธ.ค.': 'Dec',
  'อา': 'S', 'จ': 'M', 'อ': 'T', 'พ': 'W', 'พฤ': 'T', 'ศ': 'F', 'ส': 'S',
  'อาทิตย์': 'Sunday', 'จันทร์': 'Monday', 'อังคาร': 'Tuesday', 'พุธ': 'Wednesday', 'พฤหัสบดี': 'Thursday', 'ศุกร์': 'Friday', 'เสาร์': 'Saturday',
  'วันนี้': 'Today', 'เมื่อวาน': 'Yesterday', 'พรุ่งนี้': 'Tomorrow',

  // Bill categories
  'บัตรเครดิต': 'Credit card', 'ค่าไฟ': 'Electricity', 'ค่าน้ำ': 'Water', 'อินเทอร์เน็ต': 'Internet', 'ค่าโทรศัพท์': 'Phone',
  'ผ่อนชำระ': 'Installments', 'ประกัน': 'Insurance', 'ค่าเช่า/ส่วนกลาง': 'Rent / common fee', 'สมาชิกรายเดือน': 'Subscriptions', 'อื่นๆ': 'Other',

  // Bill list and status
  'บันทึกข้อมูลไม่สำเร็จ': 'Could not save data', 'จ่ายแล้ว': 'Paid', 'ตัดอัตโนมัติ': 'Autopay',
  'เลยกำหนด {0} วัน': 'Overdue {0} days', 'ครบกำหนดวันนี้': 'Due today', 'อีก {0} วัน': 'In {0} days',
  'เดือนนี้': 'This month', 'ปฏิทิน': 'Calendar', 'ทั้งหมด': 'All', 'ครบกำหนด {0}': 'Due {0}', 'งวด {0}/{1}': 'Installment {0}/{1}',
  '⚡ ดึงยอด': '⚡ Fetch amount', 'ระบุยอด': 'Enter amount', 'ยกเลิกจ่ายแล้ว': 'Mark as unpaid', 'ทำเครื่องหมายว่าจ่ายแล้ว': 'Mark as paid',
  'เลยกำหนดชำระ {0} รายการ รวม {1}': '{0} overdue, {1} in total', 'ใกล้ครบกำหนด: {0}': 'Due soon: {0}',
  'ยังไม่ได้ระบุยอดเดือนนี้: {0}': 'No amount yet this month: {0}',
  'ถึงรอบบิลค่าไฟ กดที่บิลเพื่อดึงยอดเดือนนี้จาก PEA: {0}': 'Electricity bill is out. Tap the bill to fetch this month from PEA: {0}',
  '🎉 จ่ายครบทุกบิลแล้วเดือนนี้': '🎉 All bills paid this month', 'จ่ายแล้ว ({0})': 'Paid ({0})',
  'ยอดบิลทั้งเดือน': 'Bills this month', 'คงเหลือต้องจ่าย': 'Left to pay',
  'ต้องเตรียม วันที่ 1–15': 'Needed for days 1–15', 'ต้องเตรียม วันที่ 16–{0}': 'Needed for days 16–{0}',
  'ยังไม่จ่าย ({0})': 'Unpaid ({0})', 'ไม่มีบิลในเดือนนี้': 'No bills this month', 'ยังไม่มีบิล': 'No bills yet',
  'เพิ่มบัตรเครดิต ค่าน้ำ ค่าไฟ หรือบิลอื่นๆ เพื่อเริ่มวางแผน': 'Add credit cards, water, electricity or other bills to start planning',
  '＋ เพิ่มบิลแรก': '＋ Add your first bill', 'ลองใช้ข้อมูลตัวอย่าง': 'Try sample data',
  'ไม่มีบิลครบกำหนดวันนี้': 'No bills due this day', 'รอจ่าย': 'Unpaid', 'ใกล้ครบกำหนด': 'Due soon', 'เลยกำหนด': 'Overdue',
  'ประมาณการรายจ่ายประจำต่อเดือน': 'Estimated regular spending per month',
  '{0} รายการ · บิลยอดไม่แน่นอนคิดจากยอดประมาณ': '{0} bills · variable bills use their estimate',
  'ไม่แน่นอน': 'Variable', 'ครั้งเดียว {0} {1} {2}': 'Once, {0} {1} {2}', 'ทุกวันที่ {0}': 'Monthly on day {0}',
  '{0} งวด ถึง {1} {2}': '{0} installments until {1} {2}', '· ยอดไม่แน่นอน': '· variable amount',

  // Account / settings
  '📲 ติดตั้งเป็นแอปบน iPhone': '📲 Install as an iPhone app', 'เปิดหน้านี้ใน Safari': 'Open this page in Safari',
  'แตะปุ่ม': 'Tap the', 'แชร์': 'Share', '(สี่เหลี่ยมมีลูกศรขึ้น)': 'button (square with an up arrow)', 'เลือก': 'Choose',
  'เพิ่มไปยังหน้าจอโฮม': 'Add to Home Screen', 'ใช้งานแบบออฟไลน์ได้ ข้อมูลเก็บไว้ในเครื่องของคุณเท่านั้น': 'Works offline. Your data stays on your device.',
  'วันครบกำหนด': 'On the due date', 'วัน': 'days', '{0} วัน': '{0} days',
  'รายการรับจ่าย งบประมาณ และรายจ่ายร่วมซิงก์กับบัญชีออนไลน์ ส่วนรายการบิลเก็บในเครื่องนี้ ควรส่งออกเก็บไว้เป็นระยะ':
    'Transactions, budgets and shared expenses sync with your online account; bills are kept on this device. Export a backup now and then.',
  'ข้อมูลทั้งหมดเก็บในเครื่องนี้ (localStorage) ไม่มีการส่งไปที่ใด ควรส่งออกเก็บไว้เป็นระยะ':
    'All data is stored on this device (localStorage) and sent nowhere. Export a backup now and then.',
  'การแจ้งเตือน': 'Reminders', 'เตือนล่วงหน้า': 'Remind me',
  'แอปจะแสดงบิลที่ใกล้ครบกำหนดเมื่อเปิดแอป และแสดงตัวเลขบนไอคอน (iOS 16.4 ขึ้นไป เมื่อติดตั้งที่หน้าจอโฮม)':
    'The app shows bills that are due soon when you open it, and a badge on its icon (iOS 16.4+, when installed on the Home Screen).',
  '📆 เพิ่มการเตือนลงปฏิทิน iPhone': '📆 Add reminders to iPhone Calendar',
  'สร้างไฟล์ปฏิทิน (.ics) ของบิลทั้งหมด พร้อมเสียงเตือนก่อนวันครบกำหนดตามที่ตั้งไว้ เปิดไฟล์แล้วเลือก "เพิ่มทั้งหมด" ในแอปปฏิทิน · หากแก้ไขบิล ให้ลบปฏิทินเดิมแล้วสร้างใหม่':
    'Creates a calendar file (.ics) of all bills with alerts before each due date as set above. Open it and choose "Add All" in Calendar · If you change bills, delete the old calendar and create it again.',
  // Calendar subscription (calfeed.js)
  '📆 ซิงก์บิลเข้าปฏิทิน iPhone อัตโนมัติ': '📆 Auto-sync bills to iPhone Calendar',
  '📆 ปฏิทิน iPhone: ซิงก์อัตโนมัติอยู่': '📆 iPhone Calendar: auto sync on',
  'สมัครปฏิทินครั้งเดียว แล้วทุกบิลที่มีกำหนดจ่ายจะไปอยู่ในปฏิทิน iPhone พร้อมเสียงเตือน และอัปเดตเองเมื่อเพิ่ม แก้ไข หรือจ่ายบิล':
    'Subscribe once and every bill with a due date goes into iPhone Calendar with alerts, updating by itself when you add, edit or pay bills.',
  'สมัครปฏิทินครั้งเดียว แล้วทุกบิลที่มีกำหนดจ่ายจะไปอยู่ในปฏิทิน iPhone พร้อมเสียงเตือน และอัปเดตเองเมื่อเพิ่ม แก้ไข หรือจ่ายบิล (ต้องเข้าสู่ระบบ)':
    'Subscribe once and every bill with a due date goes into iPhone Calendar with alerts, updating by itself when you add, edit or pay bills (sign-in needed).',
  'บิลใหม่ บิลที่แก้ไข และบิลที่จ่ายแล้วจะอัปเดตในปฏิทินเอง': 'New, edited and paid bills update in Calendar by themselves',
  'ส่งล่าสุด {0}': 'Last sent {0}',
  '📄 ดาวน์โหลดไฟล์ปฏิทิน (.ics) ครั้งเดียว': '📄 One-time .ics file',
  'ไฟล์ไม่อัปเดตเอง หากแก้ไขบิลต้องลบปฏิทินเดิมแล้วนำเข้าใหม่': 'A file does not update itself: after changing bills, delete the old events and import it again.',
  'เข้าสู่ระบบก่อน เพื่อให้ปฏิทินอัปเดตอัตโนมัติ': 'Sign in first so the calendar can update automatically',
  'ปฏิทิน iPhone': 'iPhone Calendar',
  'แอปจะสร้างลิงก์ปฏิทินส่วนตัวของบัญชีนี้ แล้วเปิดให้ iPhone กด': 'The app makes a private calendar link for this account and opens it so iPhone asks you to tap',
  'สมัคร': 'Subscribe',
  'ครั้งเดียว หลังจากนั้นบิลทุกใบที่มีกำหนดจ่ายจะอยู่ในแอปปฏิทินและอัปเดตเอง': 'once. After that every bill with a due date is in Calendar and updates by itself.',
  'เตือนล่วงหน้า {0} วัน และเช้าวันครบกำหนด (09:00)': 'Alerts {0} days before and on the morning of the due date (09:00)',
  'เตือนเช้าวันครบกำหนด (09:00)': 'Alert on the morning of the due date (09:00)',
  'เดือนที่จ่ายแล้วขึ้นเป็น ✅ และไม่เตือนซ้ำ': 'Paid months show ✅ with no more alerts',
  'บิลที่ตั้งตัดบัญชีอัตโนมัติจะไม่ใส่ในปฏิทิน': 'Autopay bills are left out of the calendar',
  '📆 เปิดซิงก์และสมัครในปฏิทิน': '📆 Turn on and subscribe in Calendar',
  'ถ้าเคยนำเข้าไฟล์ .ics ไว้ ให้ลบกิจกรรมเดิมออก จะได้ไม่ซ้ำกัน': 'If you imported an .ics file before, delete those events so bills do not show twice.',
  '✅ ซิงก์อัตโนมัติอยู่': '✅ Auto sync is on',
  'ส่งปฏิทินล่าสุด {0} · iPhone ดึงข้อมูลใหม่เองเป็นระยะ': 'Calendar last sent {0} · iPhone fetches updates by itself',
  '📲 สมัครในปฏิทินเครื่องนี้': '📲 Subscribe on this device',
  '🔗 คัดลอกลิงก์ปฏิทิน': '🔗 Copy calendar link',
  'ถ้ากดสมัครแล้วไม่ขึ้น: เปิด': 'If nothing appears: open',
  'การตั้งค่า › ปฏิทิน › บัญชี › เพิ่มบัญชี › อื่นๆ › เพิ่มปฏิทินที่สมัครรับ': 'Settings › Calendar › Accounts › Add Account › Other › Add Subscribed Calendar',
  'แล้ววางลิงก์ · ถ้าไม่มีเสียงเตือน ให้ปิด "ลบการเตือน" (Remove Alerts) ในหน้าตั้งค่าของปฏิทินนี้ · ลิงก์นี้เป็นความลับ ใครมีลิงก์จะเห็นรายการบิล':
    'and paste the link · If there are no alerts, turn off "Remove Alerts" in this calendar\'s settings · Keep the link private: anyone with it can see your bills.',
  '🔄 สร้างลิงก์ใหม่ (ลิงก์เดิมใช้ไม่ได้)': '🔄 New link (the old one stops working)',
  'ปิดการซิงก์ปฏิทิน': 'Turn off calendar sync',
  'คัดลอกลิงก์แล้ว': 'Link copied', 'คัดลอกลิงก์ปฏิทิน': 'Copy calendar link',
  'สร้างลิงก์ใหม่? ปฏิทินที่สมัครด้วยลิงก์เดิมจะหยุดอัปเดต ต้องสมัครใหม่ทุกเครื่อง': 'Make a new link? Calendars subscribed with the old link stop updating and must subscribe again.',
  'สร้างลิงก์ใหม่แล้ว กดสมัครอีกครั้ง': 'New link made. Tap Subscribe again.',
  'ปิดการซิงก์? ปฏิทินที่สมัครไว้จะหยุดอัปเดต (ลบปฏิทินออกได้ที่ การตั้งค่า › ปฏิทิน › บัญชี)': 'Turn off sync? The subscribed calendar stops updating (remove it in Settings › Calendar › Accounts).',
  'ปิดการซิงก์ปฏิทินแล้ว': 'Calendar sync turned off',
  'บิลที่ต้องจ่าย · centel': 'Bills to pay · centel',
  'สำรองข้อมูล': 'Backup', '⬇️ ส่งออกข้อมูล (JSON)': '⬇️ Export data (JSON)', '⬆️ นำเข้าข้อมูล': '⬆️ Import data',
  'ลบข้อมูลทั้งหมด': 'Delete all data', 'Centel · เวอร์ชัน 2.0': 'Centel · version 2.0', 'บันทึกแล้ว': 'Saved',
  'ภาษา · Language': 'Language',

  // PEA electricity
  'ไม่พบข้อมูลค่าไฟ': 'No electricity data found', 'ไม่พบข้อมูลย้อนหลัง': 'No past bills found',
  'กด "บันทึก" เพื่อเติมยอดเหล่านี้เข้าบิลแต่ละเดือน': 'Tap "Save" to fill these amounts into each month',
  'กรอกหมายเลขผู้ใช้ไฟฟ้าและรหัสเครื่องวัดก่อน': 'Enter the customer number and meter number first',
  'กำลังดึงข้อมูล…': 'Fetching…', 'ยอดล่าสุด {0}': 'Latest {0}', 'ดึงข้อมูลแล้ว': 'Fetched',
  'ลองใหม่อีกครั้ง': 'Please try again', 'ดึงไม่สำเร็จ: {0}': 'Could not fetch: {0}', 'ดึงไม่สำเร็จ:': 'Could not fetch:',
  'ดึงยอดค่าไฟไม่สำเร็จ': 'Could not fetch the electricity bill', '⚡ ดึงยอดค่าไฟจาก PEA': '⚡ Fetch electricity bill from PEA',
  'เลข 12 หลักบนใบแจ้งค่าไฟ': '12-digit number on the bill', 'เลขมิเตอร์บนใบแจ้งค่าไฟ': 'Meter number on the bill',
  'เชื่อมกับการไฟฟ้าส่วนภูมิภาค (PEA)': 'Connect to the Provincial Electricity Authority (PEA)',
  'หมายเลขผู้ใช้ไฟฟ้า': 'Customer number', 'รหัสเครื่องวัด': 'Meter number',
  'ดึงยอดค่าไฟย้อนหลังได้สูงสุด 6 เดือนจากเว็บ กฟภ. โดยตรง ไม่ต้องล็อกอิน · ตั้ง "ชื่อบิล" เป็นชื่อบ้าน เช่น บ้านหลังใหญ่ เพื่อแยกหลายมิเตอร์':
    'Fetches up to 6 months of bills straight from the PEA website, no login needed · Name the bill after the house, e.g. Main house, to tell meters apart',
  'เช่น KBank, กฟน.': 'e.g. KBank, MEA', 'เช่น ค่าโทรศัพท์ True, บัตร KTC': 'e.g. True phone bill, KTC card',
  'ชื่อบ้าน เช่น บ้านหลังใหญ่': 'House name, e.g. Main house', '⚡ ค่าไฟ (PEA)': '⚡ Electricity (PEA)',
  'Auto Sync ดึงยอดบิลแต่ละเดือนให้อัตโนมัติ บิลที่ได้จะแสดงในรายการบิลเหมือนบิลปกติ':
    'Auto Sync fetches each month’s bill for you. The bills show up in your bill list like any other bill.',

  // Bill form
  'ไม่บันทึกเป็นรายการ': 'Don’t record a transaction', 'แก้ไขบิล': 'Edit bill', 'ลบบิลนี้': 'Delete this bill',
  'ชื่อบิล': 'Bill name', 'ยอดเงิน': 'Amount', 'บันทึก เช่น เลขบัญชี, วันตัดรอบบัตร': 'Note, e.g. account number, statement date',
  'บันทึก': 'Save', 'ยกเลิก': 'Cancel', 'ครั้งเดียว': 'Once', 'ทุกเดือน': 'Monthly', 'ผ่อนงวด': 'Installments',
  'หมวดหมู่': 'Category', 'ยอดไม่แน่นอน': 'Variable amount', 'กรอกยอดจริงทุกเดือน': 'Enter the real amount each month',
  'จ่ายจาก': 'Pay from', 'เตือน': 'Remind', 'ตัดบัญชีอัตโนมัติ': 'Autopay', 'วันที่ {0}': 'Day {0}',
  'ครบกำหนด': 'Due', 'เริ่มเดือน': 'Starts', 'วันที่จ่าย': 'Payment date', 'จำนวนงวด': 'Installments', 'สิ้นสุด': 'Ends',
  'ไม่มีวันสิ้นสุด': 'Never', 'เช่น ebill@ktc.co.th': 'e.g. ebill@ktc.co.th', 'ไม่บังคับ': 'Optional',
  'กฎดึงบิลจาก Gmail': 'Gmail bill rule', 'อีเมลผู้ส่ง': 'Sender email', 'เบอร์/เลขบัญชี': 'Phone / account no.',
  'ดึงทุกเดือน': 'Fetch monthly on', 'ไม่ดึงเอง': 'Manual only',
  'ดึงจาก Gmail': 'Fetch from Gmail', 'จ่ายภายใน': 'Pay within', 'ตามวันครบกำหนดในอีเมล': 'Due date in the email',
  'ภายใน {0} วันหลังดึง': 'Within {0} days of fetching', '{0} วันหลังดึง': '{0} days after fetch',
  '"จ่ายภายใน" ตั้งวันครบกำหนดเป็นจำนวนวันหลังดึงบิล แทนวันที่ในอีเมล': '"Pay within" sets the due date that many days after the bill is fetched, instead of the date in the email',
  'ดึงอัตโนมัติ': 'Auto fetch', 'ดึงค่าไฟอัตโนมัติ': 'Auto fetch', 'ตามวันครบกำหนด': 'On the due day',
  'ตามวันครบกำหนด (วันที่ {0})': 'On the due day (day {0})', 'ดึงค่าไฟ {0}: {1}': 'Electricity fetched · {0}: {1}',
  'แอปจะดึงยอดให้เองตั้งแต่วันที่ {0} เมื่อเปิดแอป': 'The app fetches this for you from day {0} whenever you open it',
  'ใส่อีเมลเต็มเพื่อดึงเฉพาะผู้ส่งนั้น หรือแค่โดเมน (เช่น ktc.co.th) เพื่อดึงทุกอีเมลจากบริษัทนั้น ใส่หลายรายการคั่นด้วยเว้นวรรคได้ · ใส่เบอร์/เลขบัญชีเมื่อมีหลายบิลจากผู้ส่งเดียวกัน · ตั้งแต่วันที่เลือก แอปจะดึงบิลของเดือนให้เองเมื่อเปิดแอป · "จ่ายภายใน" ตั้งวันครบกำหนดเป็นจำนวนวันหลังดึงบิล แทนวันที่ในอีเมล · เลือกหมวดหมู่ด้านล่าง':
    'Enter a full email to fetch only that sender, or just the domain (e.g. ktc.co.th) for every email from that company; separate several with spaces · Add the phone / account number when one sender sends several bills · From the chosen day on, the app fetches that month’s bill when you open it · “Pay within” sets the due date that many days after the bill is fetched, instead of the date in the email · Pick a category below',
  'กรุณาใส่ชื่อบิล': 'Please enter a bill name', 'ใส่อีเมลหรือโดเมนผู้ส่งให้ถูกต้อง': 'Enter a valid sender email or domain',
  'กรุณาเลือกวันครบกำหนด': 'Please choose a due date', 'บันทึกและเติมยอดค่าไฟ {0} เดือน': 'Saved and filled {0} months of electricity',
  'เพิ่มบิลแล้ว': 'Bill added', 'ลบ "{0}"?': 'Delete "{0}"?', 'ประวัติการจ่ายทั้งหมดของบิลนี้จะถูกลบด้วย': 'All payment history of this bill is deleted too',
  'ลบแล้ว': 'Deleted', 'ล่วงหน้า {0} วัน': '{0} days before', 'ค่าเริ่มต้น ({0})': 'Default ({0})',

  // Bill occurrence sheet
  'ยังไม่จ่าย': 'Unpaid', 'งวดที่': 'Installment', 'จ่ายเมื่อ': 'Paid on',
  'บิลนี้ผูกกับ PEA ต้องดึงยอด{0}ก่อนจึงจะกดจ่ายได้': 'This bill is linked to PEA. Fetch the {0} amount before marking it paid.',
  '⚡ ดึงยอดจาก PEA': '⚡ Fetch from PEA', '⚡ ดึงยอดเดือนนี้จาก PEA': '⚡ Fetch this month from PEA',
  'บันทึกยอด': 'Save amount', 'ยกเลิกสถานะจ่ายแล้ว': 'Mark as unpaid', '✓ จ่ายแล้ว': '✓ Paid', 'บันทึกยอด (ยังไม่จ่าย)': 'Save amount (not paid yet)',
  'แตะเพื่อเปิดดู': 'Tap to open', 'ลบไฟล์แนบ': 'Remove attachment', 'แนบ PDF หรือรูปใบแจ้งหนี้': 'Attach a PDF or photo of the bill',
  'ย้อนหลัง': 'History', 'ปิด': 'Close', '{0} · ครบกำหนด {1} {2}': '{0} · due {1} {2}', 'ยอดเดือนนี้ (฿)': 'This month (฿)',
  'ใบแจ้งหนี้': 'Bill document', 'จ่าย {0} แล้ว': 'Paid {0}', 'บันทึกยอดแล้ว': 'Amount saved', 'ลบไฟล์ใบแจ้งหนี้ของเดือนนี้?': 'Remove this month’s bill file?',
  'จ่ายด้วยสลิป': 'Pay with slip', 'อัปโหลดสลิปโอนเงิน AI อ่านยอดและวันที่ แล้วตัดบิลนี้ให้': 'Upload the transfer slip: AI reads the amount and date, then marks this bill paid',
  'สลิปการจ่าย': 'Payment slip', 'ดูสลิป': 'View slip', 'แนบสลิปการจ่าย': 'Attach payment slip', 'แนบสลิปแล้ว': 'Slip attached',
  'จ่าย {0} แล้ว {1}': 'Paid {0} {1}', 'จ่าย {0} แล้ว อ่านยอดจากสลิปไม่ได้ กรอกยอดเอง': 'Paid {0}. Could not read the amount from the slip, enter it yourself',
  'อัปโหลดสลิปไม่สำเร็จ ลองใหม่อีกครั้ง': 'Could not upload the slip, try again', 'ตัดบิล': 'Pays bill', 'บิล · {0}': 'Bill · {0}', 'รายการที่จ่าย': 'Paid with', 'เปิดบิล': 'Open bill', 'ไม่ใช่การจ่ายบิล': 'Not a bill payment',
  '🧾 ยอดตรงกับบิล {0} ({1}) จะตัดบิลนี้ให้เมื่อบันทึก': '🧾 Amount matches the bill {0} ({1}). It will be marked paid when you save',
  'แนบไฟล์แล้ว': 'File attached', 'แนบไฟล์ไม่สำเร็จ': 'Could not attach the file', 'กำลังดึง…': 'Fetching…', 'ยอด{0} {1} {2}': '{0} {1}: {2}',
  '(จดมิเตอร์ราววันที่ {0})': '(meter read around day {0})',
  'ยังไม่มีบิล{0}ในระบบ กฟภ.{1} อัปเดต {2} เดือนอื่นแล้ว': 'PEA has no {0} bill yet{1}. Updated {2} other months.',
  'ลองใหม่': 'try again', 'ดึงยอดเดือนนี้จาก PEA ก่อน': 'Fetch this month from PEA first', 'กรอกยอดจริงของเดือนนี้ก่อน': 'Enter this month’s real amount first',

  // Import / export / sample / reset
  'นำเข้า {0} บิล? ข้อมูลปัจจุบันจะถูกแทนที่': 'Import {0} bills? Your current data will be replaced.',
  'นำเข้าข้อมูลแล้ว': 'Data imported', 'ไฟล์ไม่ถูกต้อง': 'Invalid file', 'วางแผนจ่ายบิล': 'Bill planner',
  '{0} จ่าย{1}{2}': '{0} Pay {1}{2}', 'อีก {0} วันครบกำหนด {1}': '{1} is due in {0} days', 'วันนี้ครบกำหนด {0}': '{0} is due today',
  'ทุกบิลตั้งเป็นตัดบัญชีอัตโนมัติ': 'Every bill is on autopay', 'ข้อมูลตัวอย่างใช้ได้เฉพาะเมื่อไม่ได้เข้าสู่ระบบ': 'Sample data only works when signed out',
  'แทนที่ข้อมูลปัจจุบันด้วยข้อมูลตัวอย่าง?': 'Replace your current data with sample data?', 'เพิ่มข้อมูลตัวอย่างแล้ว': 'Sample data added',
  'ลบข้อมูลบิลในเครื่องนี้? (รายการรับจ่ายในบัญชีออนไลน์จะไม่ถูกลบ)': 'Delete the bills on this device? (Transactions in your online account are kept)',
  'ลบข้อมูลบิลแล้ว': 'Bills deleted', 'ลบบิล รายการรับจ่าย งบประมาณ และประวัติทั้งหมด? ไม่สามารถกู้คืนได้': 'Delete all bills, transactions, budgets and history? This cannot be undone.',
  'ลบข้อมูลแล้ว': 'Data deleted',

  // Wallets and transaction categories
  'เงินสด': 'Cash', 'บัญชีธนาคาร': 'Bank account', 'เงินออม': 'Savings', 'การลงทุน': 'Investments',
  'เงินเดือน': 'Salary', 'โบนัส': 'Bonus', 'ขายของ': 'Sales', 'ดอกเบี้ยและปันผล': 'Interest & dividends', 'รับคืนเงินยืม': 'Loan repaid to me',
  'รายรับอื่นๆ': 'Other income', 'โอนเงิน': 'Transfer', 'คืนเงินระหว่างคู่': 'Couple settle-up', 'รอตรวจสอบ': 'To review', 'ไม่มีหมวดหมู่': 'No category', 'ทุกหมวดหมู่': 'All categories',

  // Home / transactions
  'จ่าย{0}': 'Pay {0}', 'ร่าง': 'Draft', 'รออนุมัติ': 'Awaiting approval', 'ถูกปฏิเสธ': 'Rejected',
  'รับเงินคืนจาก{0}': 'Repaid by {0}', 'คืนเงินให้{0}': 'Repaid {0}', 'ส่วนของฉัน {0}': 'My share {0}', 'ร่วม': 'Shared',
  'ไม่รวมในยอดรวม': 'Excluded from total', 'แสดงยอดเงิน': 'Show balances', 'ซ่อนยอดเงิน': 'Hide balances',
  'บิลที่ต้องจ่ายเดือนนี้': 'Bills to pay this month', 'ดูบิล': 'See bills', 'ยังไม่มีรายการ': 'No transactions yet',
  'รายงานเดือนนี้': 'This month’s report', 'ดูรายงาน': 'See report', 'รายการล่าสุด': 'Recent transactions', 'ดูทั้งหมด': 'See all',
  'เริ่มบันทึกรายรับรายจ่าย': 'Start tracking income and spending',
  'บันทึกทุกรายการเพื่อดูยอดเงินแต่ละกระเป๋า รายงานรายเดือน และตั้งงบประมาณ': 'Record every transaction to see each wallet’s balance, monthly reports and budgets',
  '＋ เพิ่มรายการแรก': '＋ Add your first transaction', 'ค้นหารายการ': 'Search transactions', 'ยอดเงินรวม': 'Total balance',
  'กระเป๋าเงิน {0} ใบ': '{0} wallets', 'จ่ายบิล': 'Pay bills', 'รายงาน': 'Report', 'กระเป๋าเงินของฉัน': 'My wallets',
  'เฉลี่ย {0} เดือนก่อน ณ วันเดียวกัน:': 'Average of the last {0} months on the same day:', 'เฉลี่ย {0} เดือนก่อน': 'Last {0} months average',
  'ใช้จ่ายทั้งหมด': 'Total spent', 'รายรับทั้งหมด': 'Total income', 'น้อยกว่าเดือนก่อน': 'Less than last month', 'มากกว่าเดือนก่อน': 'More than last month',
  'ข้อมูลเชิงลึก': 'Insights', 'หมวดที่ใช้มากที่สุดเดือนนี้ · รวม': 'Top category this month · total', 'เฉลี่ยเดือนนี้': 'Average this month', '/วัน': '/day',
  'รอคุณอนุมัติ': 'Waiting for your approval', 'บิลใกล้ครบกำหนด / เลยกำหนด': 'Bills due soon / overdue',
  'งบประมาณใช้ไปแล้ว 80% ขึ้นไป': 'Budgets 80% or more used', 'ไม่มีการแจ้งเตือน': 'No notifications',
  'อนาคต': 'Future', 'เดือนก่อน': 'Last month', 'ค้นหาบันทึก หมวดหมู่ หรือกระเป๋าเงิน': 'Search notes, categories or wallets',
  'ค้นหา': 'Search', 'เมนู': 'Menu', 'ยอดคงเหลือ': 'Balance', 'พบ {0} รายการ': '{0} found', 'ไม่พบรายการ': 'Nothing found',
  'บิลที่กำลังจะถึง · {0}': 'Upcoming bills · {0}', 'รายการล่วงหน้า': 'Scheduled transactions', 'ไม่มีรายการในอนาคต': 'No future transactions',
  'ยังไม่มีรายการ{0}': 'No transactions yet {0}', 'ยอดยกมา': 'Opening balance', 'ดูรายงานช่วงนี้': 'See report for this period',
  'ส่วนตัว': 'Personal', 'ร่วมกัน': 'Shared', 'ป้ายกำกับ': 'Labels', 'ตัวเลือก': 'Options', 'จัดการกระเป๋าเงิน': 'Manage wallets',
  'ส่งออกรายการ (CSV)': 'Export transactions (CSV)', 'วันที่': 'Date', 'ประเภท': 'Type', 'กระเป๋าเงิน': 'Wallet', 'ไปยัง': 'To',
  'จำนวนเงิน': 'Amount', 'ร้านค้า': 'Merchant', 'ขอบเขต': 'Scope', 'ยอดรวมทั้งบิล': 'Bill total', 'สถานะ': 'Status',
  'รายจ่าย': 'Expense', 'รายรับ': 'Income', 'อนุมัติแล้ว': 'Approved', 'ไม่มีรายการ': 'No transactions',
  'รายงาน {0}': 'Report {0}', 'คงเหลือสุทธิ': 'Net', 'รายจ่ายตามหมวดหมู่': 'Spending by category', 'รายรับตามหมวดหมู่': 'Income by category',

  // Budgets
  'เกินงบ {0}': 'Over by {0}', 'เหลือ {0}': '{0} left', 'สิ้นสุดแล้ว': 'Ended', 'เดือนหน้า': 'Next month', 'รวมทุกงบ': 'All budgets', 'งบร่วมทั้งหมด': 'All shared budgets',
  'ใช้เกินงบแล้ว': 'Over budget', 'จำนวนที่ใช้ได้': 'Available', 'งบทั้งหมด': 'Total budget', 'ใช้ไปแล้ว': 'Spent', 'ถึงสิ้นเดือน': 'Until month end',
  'สร้างงบประมาณ': 'Create budget', 'ยังไม่มีงบประมาณ': 'No budgets yet',
  'ตั้งงบรายเดือนสำหรับแต่ละหมวด แล้วดูว่าใช้ไปเท่าไร เหลือเท่าไร และควรใช้วันละเท่าไร': 'Set a monthly budget per category and see what you spent, what is left and how much you can spend per day',
  'งบร่วมนับยอดรวมทั้งบิลของรายจ่ายร่วมที่อนุมัติแล้ว ทั้งสองคนเห็นงบเดียวกัน': 'Shared budgets count the full total of approved shared expenses. You both see the same budget.',
  'งบร่วมกับ {0}': 'Shared with {0}', '＋ สร้างงบร่วม': '＋ Create shared budget', 'เกินงบ': 'Over', 'เหลือ': 'Left',
  'เหลืออีก {0} วัน': '{0} days left', 'ยังไม่เริ่ม': 'Not started', 'ทุกกระเป๋าเงิน': 'All wallets', 'คาดการณ์': 'Forecast',
  'รายการในงบนี้ ({0})': 'Transactions in this budget ({0})', 'แก้ไข': 'Edit', 'ใช้ไป': 'Spent', 'ใช้จริงสะสม': 'Actual to date',
  'งบ {0}': 'Budget {0}', 'ควรใช้ต่อวัน': 'Can spend per day', 'คาดว่าจะใช้ทั้งเดือน': 'Projected for the month', 'ใช้จริงเฉลี่ยต่อวัน': 'Actual per day',
  'แก้ไขงบประมาณ': 'Edit budget', 'งบส่วนตัว': 'Personal budget', 'งบร่วมกัน': 'Shared budget', 'ลบงบประมาณ': 'Delete budget',
  'รอบงบประมาณ': 'Budget period', 'กรุณาใส่จำนวนเงิน': 'Please enter an amount', 'มีงบของหมวดนี้อยู่แล้ว': 'This category already has a budget',
  'สร้างงบประมาณแล้ว': 'Budget created', 'ลบงบประมาณนี้?': 'Delete this budget?',

  // Transaction form
  'แก้ไขรายการ': 'Edit transaction', 'ร่วมกับ {0}': 'Shared with {0}', '🧾 ดูสลิป': '🧾 View slip',
  'อัปโหลดสลิป แล้ว AI จะกรอกหมวด ยอดเงิน และวันที่โอนให้ ตรวจแก้ได้ก่อนบันทึก': 'Upload a slip and AI fills in the category, amount and date. You can check it before saving.',
  'สแกนสลิป': 'Scan receipt',
  'ถูกปฏิเสธ — แก้ไขแล้วกดบันทึกเพื่อส่งใหม่': 'Rejected — edit and save to send again',
  'ถูกปฏิเสธ: {0} — แก้ไขแล้วกดบันทึกเพื่อส่งใหม่': 'Rejected: {0} — edit and save to send again',
  'รายการนี้สร้างจากการจ่ายบิล': 'This transaction was created by paying a bill', 'ลบรายการ': 'Delete transaction',
  'เช่น 7-Eleven': 'e.g. 7-Eleven', 'เช่น ข้าวกลางวัน': 'e.g. Lunch',
  'ยังไม่ได้เลือกหมวดหมู่': 'No category picked yet', 'เลือกหมวดหมู่': 'Select category', 'สกุลเงิน': 'Currency', 'ค้นหาสกุลเงิน': 'Search', 'ไม่พบสกุลเงิน': 'No currency found', 'ย้อนกลับ': 'Back',
  'โน้ต': 'Note', 'วันก่อนหน้า': 'Previous day', 'วันถัดไป': 'Next day', 'เลือกวันที่': 'Pick a date',
  'ร้านค้า / ผู้รับ': 'Merchant / payee', 'ใครจ่าย': 'Who paid', 'ฉัน': 'Me', 'ส่วนของฉัน (฿)': 'My share (฿)', 'ส่วนของ {0}': '{0}’s share',
  'ใส่ยอดรวมทั้งบิล ค่าเริ่มต้นแบ่งครึ่ง แก้ส่วนของแต่ละคนได้ รายการจะนับเป็นรายจ่ายเมื่อ {0} อนุมัติแล้วเท่านั้น':
    'Enter the full bill total. It is split in half by default and you can change each share. It counts as spending only after {0} approves.',
  'บันทึกเป็นร่าง (ยังไม่ส่ง)': 'Save as draft (don’t send yet)', 'จาก': 'From', 'ทั่วไป': 'General',
  '⏳ กำลังอัปโหลดและอ่านสลิป…': '⏳ Uploading and reading the slip…', 'กำลังอ่านสลิป…': 'Reading slip…', '✅ อ่านสลิปแล้ว ตรวจสอบข้อมูลอีกครั้งก่อนบันทึก': '✅ Slip read. Check the details before saving.',
  '⚠️ อ่านได้ไม่ครบหรือไม่ทราบวัตถุประสงค์ของการโอน กรุณาตรวจสอบและเลือกหมวดหมู่': '⚠️ Some details or the purpose could not be read. Please check and pick a category.',
  '⚠️ อ่านสลิปไม่สำเร็จ แนบรูปไว้แล้ว กรุณากรอกข้อมูลเอง': '⚠️ Could not read the slip. The image is attached; please fill in the details.',
  '🧾 แนบรูปแล้ว (ยังไม่ได้เปิดการอ่านสลิปอัตโนมัติ)': '🧾 Image attached (automatic slip reading is not set up)', '🧾 แนบรูปแล้ว': '🧾 Image attached',
  '❌ อัปโหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง': '❌ Upload failed. Please try again.', 'กรุณาเลือกวันที่': 'Please choose a date',
  'เพิ่มกระเป๋าเงินอีกใบเพื่อโอนเงิน': 'Add another wallet to make transfers', 'ส่วนของฉันต้องไม่เกินยอดรวม': 'My share can’t be more than the total',
  'ส่งให้ {0} อนุมัติแล้ว': 'Sent to {0} for approval', 'บันทึกร่างแล้ว': 'Draft saved', 'เพิ่มรายการแล้ว': 'Transaction added', 'ลบรายการนี้?': 'Delete this transaction?',

  // Wallet sheets
  'ยอดรวม': 'Total', 'เลือกกระเป๋าเงิน': 'Choose wallet', 'เสร็จ': 'Done', 'รวมในยอดรวม': 'Include in total', 'เพิ่มกระเป๋าเงิน': 'Add wallet',
  'แก้ไขกระเป๋าเงิน': 'Edit wallet', 'ลบกระเป๋าเงิน': 'Delete wallet', 'ลบกระเป๋าเงินและรายการทั้งหมด': 'Delete wallet and all its transactions',
  'เปลี่ยนรูป': 'Change picture', 'พิมพ์เอง': 'Type your own', 'เช่น KBank ออมทรัพย์': 'e.g. KBank Savings', '📷 เลือกรูป': '📷 Choose photo',
  '😀 อีโมจิ': '😀 Emoji', 'ใช้ไอคอนประเภท': 'Use type icon', 'ใช้ไอคอนหมวดหมู่': 'Use category icon', 'ชื่อ': 'Name', 'ยอดเริ่มต้น (฿)': 'Starting balance (฿)',
  'บัตรเครดิตที่มียอดค้างชำระ ให้ใส่ยอดเริ่มต้นเป็นค่าติดลบ เช่น -12000': 'For a credit card with an outstanding balance, enter a negative starting balance, e.g. -12000',
  'เปิดรูปนี้ไม่ได้': 'Can’t open this image', 'กรุณาใส่ชื่อกระเป๋าเงิน': 'Please enter a wallet name', 'เพิ่มกระเป๋าเงินแล้ว': 'Wallet added',
  'ต้องมีกระเป๋าเงินอย่างน้อย 1 ใบ': 'You need at least one wallet', 'รายการทั้งหมดของกระเป๋านี้จะถูกลบด้วย': 'All transactions in this wallet are deleted too',
  'ลบกระเป๋าเงิน{0}?': 'Delete wallet {0}?',

  // Labels
  '＋ ป้ายใหม่': '＋ New label', '{0} รายการ ใน {1} กระเป๋า': '{0} transactions in {1} wallets', 'ยังไม่มีป้ายกำกับ': 'No labels yet',
  'ใช้จัดกลุ่มรายการข้ามหมวดหมู่ เช่น Grabfood, Shopee, ทริปเชียงใหม่': 'Group transactions across categories, e.g. Grabfood, Shopee, Chiang Mai trip',
  'ป้ายกำกับซิงก์กับบัญชีของคุณทุกเครื่อง': 'Labels sync with your account on every device', 'เพิ่ม': 'Add', 'เพิ่มป้ายกำกับ': 'Add label',
  'ติดป้ายได้หลายป้ายต่อรายการ ในหน้าเพิ่ม/แก้ไขรายการ': 'A transaction can have several labels; add them when adding or editing it',
  'ติดป้ายได้หลายป้ายต่อรายการ ในหน้าเพิ่ม/แก้ไขรายการ{0}': 'A transaction can have several labels; add them when adding or editing it{0}',
  'กลับ': 'Back', 'ดูรายการ': 'View transactions', 'กรองในหน้ารายการ': 'Filter transactions', 'เปลี่ยนชื่อ': 'Rename', 'ลบป้ายกำกับ': 'Delete label',
  'ลบป้าย "{0}"?': 'Delete label "{0}"?', 'ป้ายนี้จะถูกนำออกจาก {0} รายการ (รายการยังอยู่)': 'It will be removed from {0} transactions (they are kept)',
  'เปลี่ยนชื่อป้าย': 'Rename label', 'เช่น Grabfood': 'e.g. Grabfood', 'กรุณาใส่ชื่อป้าย': 'Please enter a label name', 'มีป้ายชื่อนี้แล้ว': 'That label already exists',
  'เพิ่มป้ายกำกับแล้ว': 'Label added', 'จ่าย {0}': 'Spent {0}', 'รับ {0}': 'Received {0}', 'ยังไม่มีรายการที่ติดป้ายนี้': 'No transactions with this label yet',
  'รายจ่ายทั้งหมด': 'Total spending', 'จำนวน': 'Count', '{0} รายการ': '{0} transactions', 'กรองตามป้ายกำกับ': 'Filter by label', 'ทุกรายการ': 'All transactions',

  // Categories
  'ลากเพื่อเรียง': 'Drag to reorder', 'หมวดหมู่ซิงก์กับบัญชีของคุณทุกเครื่อง': 'Categories sync with your account on every device', 'เพิ่มหมวดหมู่': 'Add category',
  'ลาก ☰ เพื่อเรียงลำดับ แตะหมวดเพื่อแก้ชื่อ ไอคอน สี หรือเพิ่มหมวดย่อย': 'Drag ☰ to reorder. Tap a category to change its name, icon or colour, or add sub-categories',
  'ลาก ☰ เพื่อเรียงลำดับ แตะหมวดเพื่อแก้ชื่อ ไอคอน สี หรือเพิ่มหมวดย่อย{0}': 'Drag ☰ to reorder. Tap a category to change its name, icon or colour, or add sub-categories{0}',
  'เพิ่มหมวดย่อย': 'Add sub-category', 'แก้ไขหมวดหมู่': 'Edit category', 'อยู่ใต้หมวด': 'Parent category', 'ไม่มี (เป็นหมวดหลัก)': 'None (top level)',
  'หมวดย่อย': 'Sub-categories', 'ลบหมวดหมู่': 'Delete category', 'หมวดนี้ลบไม่ได้ เพราะเป็นที่รวมรายการจากหมวดที่ถูกลบ': 'This category can’t be deleted: it collects transactions from deleted categories',
  'เช่น Water Bill': 'e.g. Water Bill', 'ไอคอน': 'Icon', 'เลือกไอคอน': 'Choose icon', 'สี': 'Colour', 'ชื่อหมวดหมู่': 'Category name',
  'กรุณาใส่ชื่อหมวดหมู่': 'Please enter a category name', 'เพิ่มหมวดหมู่แล้ว': 'Category added',
  'หมวดย่อย {0} หมวดจะถูกลบด้วย': 'Its {0} sub-categories are deleted too', '{0} รายการจะย้ายไปอยู่ "{1}"': '{0} transactions move to "{1}"',
  'งบประมาณของหมวดนี้ {0} รายการจะถูกลบ': '{0} budgets for this category are deleted', 'ลบหมวด "{0}"?': 'Delete category "{0}"?',

  // Account tab (money part)
  '· ไม่รวมในยอดรวม': '· excluded from total', 'และอีก {0}': 'and {0} more', 'ติดป้ายให้รายการ เช่น Grabfood, Shopee': 'Tag transactions, e.g. Grabfood, Shopee',
  'รายรับเดือนนี้': 'Income this month', 'รายจ่ายเดือนนี้': 'Spending this month', 'หมวดหมู่และป้ายกำกับ': 'Categories & labels',
  'แก้ไข เรียงลำดับ และหมวดย่อย': 'Edit, reorder and sub-categories', 'การจ่ายบิล': 'Bill payments', 'บันทึกรายจ่ายจาก': 'Record spending from',
  'เมื่อกด "จ่ายแล้ว" ที่บิล แอปจะบันทึกเป็นรายจ่ายในกระเป๋าเงินนี้ให้อัตโนมัติ เพื่อให้ยอดเงินและงบประมาณตรงกัน':
    'When you mark a bill "Paid", the app records the expense in this wallet so balances and budgets stay right',

  // Online account, couple
  'คู่ของฉัน': 'My partner', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง': 'Wrong email or password', 'อีเมลนี้มีบัญชีอยู่แล้ว ลองเข้าสู่ระบบ': 'This email already has an account. Try signing in.',
  'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร': 'Password must be at least 8 characters', 'อีเมลไม่ถูกต้อง': 'Invalid email', 'กรุณาใส่ชื่อ': 'Please enter a name',
  'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่': 'Too many attempts. Wait a moment and try again', 'รหัสเชิญไม่ถูกต้องหรือหมดอายุแล้ว': 'Invite code is wrong or expired',
  'บัญชีนี้เชื่อมกับคู่แล้ว': 'This account is already linked to a partner', 'บัญชีคู่นี้มีสมาชิกครบแล้ว': 'This couple account is already full',
  'ยังไม่ได้เชื่อมบัญชีกับคู่': 'Not linked to a partner yet', 'รายการนี้แก้ไขไม่ได้แล้ว': 'This transaction can no longer be edited',
  'สถานะรายการเปลี่ยนไปแล้ว': 'The transaction status has changed', 'ผู้สร้างรายการอนุมัติเองไม่ได้': 'The creator can’t approve their own transaction',
  'ไฟล์ใหญ่เกินไป': 'File too large', 'ยังไม่ได้ตั้งค่าที่เก็บสลิป': 'Slip storage is not set up', 'กรุณาเข้าสู่ระบบอีกครั้ง': 'Please sign in again',
  'เข้าสู่ระบบด้วย Google ไม่สำเร็จ ลองใหม่อีกครั้ง': 'Google sign-in failed. Please try again', 'อีเมล Google นี้ยังไม่ได้ยืนยัน': 'This Google email is not verified',
  'อีเมลนี้เชื่อมกับบัญชี Google อื่นอยู่แล้ว': 'This email is linked to another Google account', 'ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google': 'Google sign-in is not set up',
  'บัญชี Google นี้ไม่มีรูปโปรไฟล์': 'This Google account has no profile picture', 'บัญชี Google นี้ไม่ใช่บัญชีที่เข้าสู่ระบบอยู่': 'This Google account is not the signed-in account',
  'ทำรายการไม่สำเร็จ': 'Something went wrong', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้': 'Can’t reach the server',
  'สลิปนี้อาจซ้ำกับรายการที่บันทึกไว้แล้ว ต้องการบันทึกซ้ำหรือไม่?': 'This slip may duplicate a saved transaction. Save it anyway?',
  'หาร 2': 'Split in half', 'รับผิดชอบทั้งหมด': 'I cover it all', '{0} รับผิดชอบทั้งหมด': '{0} covers it all', 'ต้นทุน': 'Cost',
  'ลงโดย': 'Logged by', 'การคืนเงินที่ผ่านมา': 'Past settle-ups', 'รายจ่ายร่วมเดือนนี้ {0}': 'Shared spending this month {0}',
  'บันทึกแล้ว {0} จะเห็นรายการนี้': 'Saved. {0} will see it',
  'บันทึกให้ {0} เห็นเท่านั้น ไม่ใช่การเรียกเก็บเงิน ต้นทุนใช้คำนวณส่วนของฉันในยอดรวมและรายงาน':
    'Logged so {0} can see it, not a request for money. The cost choice sets my share in totals and reports.',
  'บันทึกไว้ให้ทั้งสองคนเห็นเท่านั้น ไม่ใช่การเรียกเก็บเงิน ส่วนของแต่ละคนใช้คำนวณต้นทุนในรายงาน':
    'Logged for both of you to see, not a request for money. Each share is used for cost in reports.',
  'เชิญคู่เข้าบัญชี แยกรายจ่ายส่วนตัว และลงรายจ่ายร่วมให้อีกฝ่ายเห็น': 'Invite your partner, keep personal spending private and log shared expenses for each other to see',
  'งบร่วมนับยอดรวมทั้งบิลของรายจ่ายร่วม ทั้งสองคนเห็นงบเดียวกัน': 'Shared budgets count the full total of shared expenses. You both see the same budget.',
  '{0} เห็นเฉพาะรายจ่ายร่วมและงบร่วมของคุณทั้งสอง รายจ่ายส่วนตัวของแต่ละคนมองไม่เห็น': '{0} only sees your shared expenses and shared budgets. Personal spending stays private.',
  'ไม่มียอดค้างคืน': 'All settled', '{0} ต้องคืนคุณ': '{0} owes you', 'คุณต้องคืน {0}': 'You owe {0}',
  'ใช้ร่วมกับคู่ของคุณ': 'Use it with your partner', 'เชิญคู่เข้าบัญชี แยกรายจ่ายส่วนตัว และส่งรายจ่ายร่วมให้อีกฝ่ายอนุมัติ': 'Invite your partner, keep personal spending private and send shared expenses for approval',
  'เชื่อมบัญชีคู่': 'Link partner', 'รอ {0} อนุมัติ': 'Waiting for {0}', 'ถูกปฏิเสธ / ร่างที่ยังไม่ส่ง': 'Rejected / unsent drafts',
  'รายจ่ายร่วมเดือนนี้ {0} (อนุมัติแล้ว)': 'Shared spending this month {0} (approved)', '＋ รายจ่ายร่วม': '＋ Shared expense',
  'ถูกปฏิเสธ / ร่าง': 'Rejected / drafts', 'รายจ่ายร่วมทั้งหมด': 'All shared expenses', 'ส่งขออนุมัติ': 'Send for approval', 'แก้ไขและส่งใหม่': 'Edit and resend',
  'อนุมัติ': 'Approve', 'ปฏิเสธ': 'Reject', 'ร่าง (ยังไม่ส่ง)': 'Draft (not sent)', 'ไม่ระบุ': 'Not set', 'เหตุผลที่ปฏิเสธ': 'Reason for rejecting',
  'ตรวจสอบยอดและการแบ่งให้ถูกต้อง ถ้าไม่ถูกให้ปฏิเสธพร้อมเหตุผล ผู้สร้างจะแก้ไขแล้วส่งใหม่': 'Check the amount and split. If something is wrong, reject it with a reason and the creator will fix and resend it.',
  'การคืนเงิน': 'Settle-up', '{0} · ครั้งที่ {1}{2}': '{0} · round {1}{2}', 'ประวัติ': 'History', 'ยกเลิกคำขอและลบ': 'Cancel request and delete',
  'รายจ่ายร่วม': 'Shared expense', 'ผู้จ่าย': 'Paid by', 'ส่วนของฉัน': 'My share', 'สร้างโดย': 'Created by', 'ป้ายกำกับของฉัน': 'My labels',
  'เหตุผลที่ปฏิเสธ (ผู้สร้างจะเห็นข้อความนี้)': 'Reason for rejecting (the creator will see this)', 'ปฏิเสธแล้ว': 'Rejected',
  'ชำระแล้ว {0}': 'Settled {0}', 'ยังไม่ชำระ': 'Not settled', 'ชำระแล้ว': 'Settled', 'ยังไม่มียอดค้างคืน': 'Nothing to settle yet',
  'ยอดค้างคืน': 'Balance owed', 'สรุป': 'Summary', 'ยอดค้างเกิดเมื่อรายจ่ายร่วมได้รับอนุมัติแล้วเท่านั้น การคืนเงินไม่นับเป็นรายจ่ายซ้ำ': 'A balance only appears once shared expenses are approved. Settle-ups are not counted as spending again.',
  'คืนจากกระเป๋า': 'Pay from wallet', 'รับเข้ากระเป๋า': 'Receive into wallet', 'ทำเครื่องหมายว่าชำระแล้ว': 'Mark as settled', 'บันทึกกระเป๋าเงิน': 'Save wallet',
  'ยกเลิก: ยังไม่ชำระ': 'Undo: not settled', 'บันทึกการคืนเงินแล้ว': 'Settle-up recorded', 'เปลี่ยนเป็นยังไม่ชำระแล้ว': 'Marked as not settled',
  'เชื่อมกับ {0}': 'Linked with {0}', 'ส่งรหัสเชิญให้คู่ หรือใส่รหัสจากคู่': 'Send your partner an invite code, or enter theirs',
  'แก้ไขโปรไฟล์': 'Edit profile', '{0} · ซิงก์กับบัญชีออนไลน์': '{0} · synced online', 'ออกจากระบบ': 'Sign out',
  'สมัครบัญชีเพื่อซิงก์ข้อมูล เชื่อมบัญชีกับคู่ แยกรายจ่ายส่วนตัว/ร่วม และให้ AI อ่านสลิป': 'Create an account to sync your data, link with your partner, split personal / shared spending and let AI read slips',
  'เข้าสู่ระบบ / สมัครสมาชิก': 'Sign in / Sign up', 'บัญชีของฉัน': 'My account', 'ข้อมูลทั้งหมดเก็บในเครื่องนี้เท่านั้น': 'All data is stored only on this device',
  'เชื่อมต่อไม่สำเร็จ': 'Connection failed', 'สวัสดี {0}': 'Hi {0}', 'เข้าสู่ระบบ': 'Sign in', 'สมัครสมาชิก': 'Sign up',
  'เช่น ต้นกล้า ใจดี': 'e.g. Alex Smith', 'เช่น ต้น': 'e.g. Alex', 'ชื่อที่แสดง': 'Display name', 'ชื่อเล่น': 'Nickname',
  'อย่างน้อย 8 ตัวอักษร': 'At least 8 characters', 'สร้างบัญชี': 'Create account', 'หรือใช้อีเมล': 'or use email', 'อีเมล': 'Email', 'รหัสผ่าน': 'Password',
  'แต่ละคนมีบัญชีของตัวเอง รายจ่ายส่วนตัวเห็นได้เฉพาะเจ้าของ รายจ่ายร่วมเห็นทั้งสองคนหลังเชื่อมบัญชี': 'Each person has their own account. Personal spending is visible only to its owner; shared spending is visible to both once linked.',
  'กรุณาใส่ชื่อเล่น': 'Please enter a nickname', 'นำข้อมูลในเครื่องนี้ ({0} รายการ) ขึ้นบัญชีออนไลน์ไหม?': 'Upload the data on this device ({0} transactions) to your online account?',
  'นำเข้า {0} รายการแล้ว': 'Imported {0} transactions', 'ออกจากระบบ? ข้อมูลยังอยู่ในบัญชีออนไลน์': 'Sign out? Your data stays in your online account.',
  'ออกจากระบบแล้ว': 'Signed out', 'บัญชีคู่': 'Couple account',
  '{0} เห็นเฉพาะรายจ่ายร่วม งบร่วม และยอดค้างคืนของคุณทั้งสอง รายจ่ายส่วนตัวของแต่ละคนมองไม่เห็น': '{0} only sees shared expenses, shared budgets and what you owe each other. Personal spending stays private.',
  'ใช้ได้ถึง {0}': 'Valid until {0}', 'ส่งรหัสให้คู่': 'Send code to partner', 'สร้างรหัสเชิญ แล้วส่งให้คู่ใส่ในแอปของเขา': 'Create an invite code and send it for your partner to enter in their app',
  'สร้างรหัสใหม่': 'New code', 'สร้างรหัสเชิญ': 'Create invite code', 'เชิญคู่ของคุณ': 'Invite your partner', 'หรือใส่รหัสจากคู่': 'Or enter your partner’s code',
  'รหัสเชิญ': 'Invite code', 'เชื่อมบัญชี': 'Link accounts',
  'ใส่รหัส {0} ในแอป centel.app (บัญชี > เชื่อมบัญชีคู่) เพื่อใช้บันทึกรายจ่ายร่วมกัน': 'Enter code {0} in the centel.app app (Account > Link partner) to share expenses with me',
  'คัดลอกแล้ว': 'Copied', 'รหัสเชิญมี 6 ตัวอักษร': 'Invite codes have 6 characters', 'เชื่อมกับ {0} แล้ว': 'Linked with {0}',
  'รูปจาก Google': 'Google photo', 'ใช้ตัวอักษรย่อ': 'Use initials',
  'ชื่อและรูปนี้จะแสดงในทุกเครื่องที่เข้าสู่ระบบ และคู่ของคุณเมื่อเชื่อมบัญชีแล้ว': 'This name and picture show on every signed-in device, and to your partner once linked',
  'ชื่อและรูปนี้จะแสดงในทุกเครื่องที่เข้าสู่ระบบ และ {0} จะเห็นด้วย': 'This name and picture show on every signed-in device, and {0} will see them too',
  'บันทึกโปรไฟล์แล้ว': 'Profile saved', 'คู่ของคุณ': 'your partner', 'ตั้งชื่อเล่น': 'Set a nickname',
  'ชื่อเล่นจะแสดงให้{0}เห็นในรายจ่ายร่วม': 'Your nickname is shown to {0} on shared expenses',
  'เปลี่ยนได้ภายหลังที่ บัญชี → แตะการ์ดโปรไฟล์': 'Change it later in Account → tap the profile card', 'บันทึกชื่อเล่นแล้ว': 'Nickname saved',

  // Gmail AutoSync
  'สิทธิ์หมดอายุ กรุณาเชื่อมใหม่': 'Access expired. Please reconnect.', 'Gmail ตอบกลับ {0}': 'Gmail replied {0}', '(ไม่มีหัวเรื่อง)': '(no subject)',
  'โหลด Google Sign-In ไม่สำเร็จ': 'Could not load Google Sign-In', 'ยังไม่ได้ตั้งค่า Google Client ID': 'Google Client ID is not set up',
  'ไม่ได้รับสิทธิ์': 'Permission not granted', 'ปิดหน้าต่างก่อนอนุญาต': 'The window was closed before allowing access', 'เปิดหน้าต่าง Google ไม่ได้': 'Could not open the Google window',
  'ครบกำหนด {0} {1}': 'Due {0} {1}', 'ไม่พบวันครบกำหนด': 'No due date found', 'นำเข้าแล้ว': 'Imported', 'นำเข้า': 'Import',
  '📎 {0} (เก็บไว้กับบิล)': '📎 {0} (kept with the bill)', '(PDF แนบอาจล็อกรหัสไว้)': '(the attached PDF may be password-protected)',
  'ไม่พบยอดในเนื้ออีเมล{0} กรอกยอดเองหลังนำเข้า': 'No amount found in the email{0}. Enter it yourself after importing.',
  'ไม่พบอีเมลบิลจากผู้ส่งในกฎใน 4 เดือนที่ผ่านมา ตรวจอีเมลผู้ส่งในกฎอีกครั้ง หรือดูว่าอีเมลเข้าบัญชี Google ที่ล็อกอินอยู่':
    'No bill emails from the rule senders in the last 4 months. Check the sender emails, or that the emails arrive in the signed-in Google account.',
  'นำเข้าทั้งหมด ({0})': 'Import all ({0})', 'พบ {0} ฉบับ': '{0} found', 'นำเข้า {0} บิลแล้ว': 'Imported {0} bills',
  'กำลังเชื่อม Google…': 'Connecting to Google…', 'กำลังค้นหาอีเมลบิล…': 'Searching for bill emails…',
  'ถึงรอบดึงบิลจาก Gmail: {0} แตะเพื่อดึงบิลเดือนนี้': 'Time to fetch bills from Gmail: {0}. Tap to fetch this month.',
  'Gmail AutoSync: นำเข้า {0} บิล': 'Gmail AutoSync: imported {0} bills', 'Gmail AutoSync: ยังไม่มีบิลใหม่': 'Gmail AutoSync: no new bills yet',
  'Gmail AutoSync ไม่สำเร็จ:': 'Gmail AutoSync failed:', 'Gmail AutoSync ไม่สำเร็จ: {0}': 'Gmail AutoSync failed: {0}',
  'ดึงทุกวันที่ {0}': 'Fetches monthly on day {0}', 'ดึงเองเท่านั้น': 'Manual only', 'ดึงล่าสุด {0}': 'Last fetched {0}',
  '🔄 ดึงบิลทุกกฎตอนนี้': '🔄 Fetch all rules now', 'ตัดการเชื่อม Gmail': 'Disconnect Gmail',
  'สร้างกฎดึงบิลได้ทุกประเภท: ตั้งชื่อบิล อีเมลผู้ส่ง วันที่ดึงทุกเดือน และหมวดหมู่ แอปจะหาอีเมลบิลจากผู้ส่งนั้น แล้วเติมยอดกับวันครบกำหนดเข้าบิลให้':
    'Create a rule for any kind of bill: a bill name, sender email, monthly fetch day and category. The app finds that sender’s bill emails and fills in the amount and due date.',
  'กฎดึงบิล': 'Bill rules', 'เพิ่มกฎดึงบิล': 'Add bill rule',
  'อ่าน Gmail แบบอ่านอย่างเดียว เฉพาะอีเมลจากผู้ส่งในกฎ ย้อนหลัง 4 เดือน จากเครื่องนี้โดยตรง ไม่ส่งอีเมลไปเก็บที่เซิร์ฟเวอร์':
    'Reads Gmail read-only, only emails from rule senders in the last 4 months, directly from this device. Emails are never stored on the server.',
  'ยังไม่ได้ตั้งค่า Google OAuth Client ID ที่เซิร์ฟเวอร์ (ตัวแปร GOOGLE_CLIENT_ID)': 'The Google OAuth Client ID is not set on the server (GOOGLE_CLIENT_ID)',
  'นำเข้า {0} แล้ว กรอกยอดในบิล': 'Imported {0}. Enter the amount in the bill.', 'ตัดการเชื่อมแล้ว': 'Disconnected',

  // Schedule
  'Auto Sync · ค่าไฟ PEA': 'Auto Sync · PEA electricity', 'ผ่อน {0} งวด': '{0} installments', 'วันที่ {0} {1}': 'Day {0} {1}',
  'กำลังจะถึง': 'Upcoming', '🎉 จ่ายครบทุกรายการประจำเดือนนี้แล้ว': '🎉 All repeating bills paid this month', 'ไม่มีบิลประจำในเดือนนี้': 'No repeating bills this month',
  'ดูทั้งเดือน': 'See whole month', 'รายการประจำ ({0})': 'Repeating ({0})', 'ครั้งถัดไป {0}': 'Next {0}', 'ครบแล้ว': 'Finished',
  'ยังไม่มีบิลแบบทำซ้ำ กด "เพิ่ม" เพื่อสร้าง': 'No repeating bills yet. Tap "Add" to create one.', 'ประมาณการต่อเดือน': 'Estimated per month',
  '{0} งวด': '{0} installments', '1 รายการ': '1 transaction', 'ทำซ้ำ': 'Repeat', 'ไม่ทำซ้ำ': 'Never', 'เริ่ม': 'Starts', '{0} · {1} งวด': '{0} · {1} installments',
  'ใช่': 'Yes', 'ไม่': 'No', '· ยอดประมาณ': '· estimate', 'ยอดประมาณ': 'Estimate', 'ครั้งถัดไป {0} ›': 'Next {0} ›', 'ลบบิล': 'Delete bill', 'เพิ่มบันทึก': 'Add note',

  // Bill files, dialogs
  'ไฟล์ใหญ่เกิน 10 MB': 'File is over 10 MB', 'โหลดตัวอ่าน PDF ไม่สำเร็จ': 'Could not load the PDF reader', '‹ กลับ': '‹ Back',
  'กำลังเปิดไฟล์…': 'Opening file…', 'ไม่พบไฟล์ในเครื่องนี้': 'File not found on this device',
  '(PDF ล็อกรหัสไว้ กด แชร์ เพื่อเปิดในแอปอื่น)': '(the PDF is password-protected; tap Share to open it in another app)', 'เปิดไฟล์ไม่สำเร็จ{0}': 'Could not open the file{0}',
  'ยืนยัน': 'Confirm', 'ลบ': 'Delete',

  // Sample data (created in the chosen language)
  'บัตร KBank': 'KBank card', 'บัตร SCB': 'SCB card', 'ค่าไฟ (MEA)': 'Electricity (MEA)', 'ค่าน้ำ (MWA)': 'Water (MWA)',
  'อินเทอร์เน็ตบ้าน': 'Home internet', 'ผ่อนมือถือ': 'Phone installments', 'ตัดรอบวันที่ 20': 'Statement on day 20',
  'KBank ออมทรัพย์': 'KBank Savings', 'ข้าวมันไก่': 'Chicken rice', 'กาแฟ': 'Coffee', 'ก๋วยเตี๋ยว': 'Noodles',
  'ข้าวกล่องเซเว่น': '7-Eleven meal', 'ชานมไข่มุก': 'Bubble tea', 'ส้มตำ': 'Papaya salad', 'วินมอไซค์': 'Motorbike taxi',
  'เสื้อผ้า': 'Clothes', 'รองเท้า': 'Shoes', 'ดูหนัง': 'Movie', 'คอนเสิร์ต': 'Concert', 'เกม': 'Games', 'ร้านยา': 'Pharmacy',
  'คลินิก': 'Clinic', 'กดเงินสด': 'Cash withdrawal', 'เติมเงิน': 'Top-up', 'ขายของออนไลน์': 'Online sales',
  'ของใช้ลูก': 'Baby supplies', 'ของขวัญวันเกิดเพื่อน': 'Friend’s birthday gift',

  // Colour themes (theme.js)
  'ธีม': 'Theme', 'ฟ้า': 'Blue', 'ชมพูพาสเทล': 'Pastel pink', 'ดำสนิท': 'Black', 'ขาว': 'White',
  'ธีมฟ้าเปลี่ยนสว่าง/มืดตามโหมดของเครื่อง · ธีมจำไว้ในเครื่องนี้ · บน iPhone สีแถบสถานะด้านบนจะเปลี่ยนตามเมื่อเปิดแอปใหม่':
    'The blue theme follows the phone’s light / dark mode · The theme is remembered on this device · On iPhone the status bar colour changes the next time you open the app',

  // To-do notes (notes.js)
  'สิ่งที่ต้องทำ': 'To-do', 'โน้ตเตือนความจำ': 'Reminder notes', '{0} รายการถึงกำหนด': '{0} due', 'ดูทั้งหมด ({0})': 'See all ({0})',
  'จดสิ่งที่ต้องทำไว้ตรงนี้ ใส่วันในประโยคได้เลย แอปจะตั้งวันให้เอง': 'Jot down what you need to do. Put the day in the sentence and the app sets the date for you.',
  'เพิ่มสิ่งที่ต้องทำ เช่น จันทร์ที่ 1 ไปเยี่ยมแม่ ลำพูน': 'Add a to-do, e.g. Mon the 1st visit Mom', 'เพิ่มสิ่งที่ต้องทำ': 'Add a to-do',
  'ตั้งวันและการเตือน': 'Set date and reminder', 'ไม่เตือน': 'No reminder', 'ตรงเวลา': 'At the time',
  'ล่วงหน้า 2 ชั่วโมง': '2 hours before', 'ล่วงหน้า 6 ชั่วโมง': '6 hours before', 'ล่วงหน้า 2 วัน': '2 days before',
  'ล่วงหน้า 1 ชั่วโมง': '1 hour before', 'ล่วงหน้า 3 ชั่วโมง': '3 hours before', 'ล่วงหน้า 1 วัน': '1 day before', 'ล่วงหน้า 3 วัน': '3 days before',
  '{0} น.': '{0}', 'จาก {0}': 'From {0}', 'แชร์กับคู่': 'Shared', 'ยังไม่เสร็จ': 'Not done', 'ทำเสร็จแล้ว': 'Mark as done',
  'ไม่ระบุวัน': 'No date', 'เสร็จแล้ว': 'Done', 'เลยกำหนด ({0})': 'Overdue ({0})', 'วันนี้ ({0})': 'Today ({0})', 'กำลังจะถึง ({0})': 'Upcoming ({0})',
  'ไม่ระบุวัน ({0})': 'No date ({0})', 'เสร็จแล้ว ({0})': 'Done ({0})', 'ไม่มีสิ่งที่ต้องทำค้างอยู่': 'Nothing left to do',
  'แจ้งเตือนในกลุ่ม LINE': 'Reminders in a LINE group', 'ตั้งกลุ่มไว้แล้ว · แก้ไขได้ที่หน้า บัญชี': 'Group set · change it in Account',
  'ตั้งค่า LINE Group ID ได้ที่หน้า บัญชี': 'Set the LINE Group ID in Account', 'ต้องเข้าสู่ระบบ': 'Sign in first',
  'ยังไม่ได้ตั้งค่า': 'Not set', 'ปิดอยู่': 'Off', 'พร้อมส่ง': 'Ready', 'รอเชื่อม LINE OA': 'Waiting for LINE OA',
  'ส่งเตือนสิ่งที่ต้องทำเข้ากลุ่ม': 'Send to-do reminders to the group', 'ลบ Group ID แล้ว': 'Group ID removed',
  'Group ID ไม่ถูกต้อง (C ตามด้วยตัวอักษร 32 ตัว)': 'Invalid Group ID (C followed by 32 characters)',
  'เพิ่ม LINE OA ของ Centel เข้ากลุ่มของบ้าน แล้วใส่ Group ID (ขึ้นต้นด้วย C) ที่นี่ การเตือนของโน้ตที่ตั้งเวลาไว้จะส่งเข้ากลุ่มนี้': 'Add the Centel LINE OA to your family group and enter its Group ID (starts with C) here. Note reminders are posted to this group.',
  'ระบบจะเริ่มส่งเมื่อเชื่อม LINE OA เสร็จ': 'Sending starts once the LINE OA is connected.',
  'คนในกลุ่ม LINE': 'People in the LINE group', 'เพิ่มคน': 'Add person', 'เพิ่มคนในกลุ่ม LINE': 'Add a person in the LINE group',
  'ฉัน ({0})': 'Me ({0})', 'คือใครในแอป': 'Who in the app', 'เช่น พ่อบุ๊ค': 'e.g. Dad', 'LINE ID': 'LINE ID',
  'LINE ID ไม่ถูกต้อง (U ตามด้วยตัวอักษร 32 ตัว)': 'Invalid LINE ID (U followed by 32 characters)',
  'มี LINE ID นี้แล้ว': 'This LINE ID is already in the list', 'เพิ่มแล้ว': 'Added', 'ลบ {0}?': 'Delete {0}?',
  'ใส่ LINE ID (ขึ้นต้นด้วย U) แล้วบอกว่าเป็นใครในแอป การเตือนจะแท็กคนที่เกี่ยวกับโน้ตนั้น พิมพ์ id ในกลุ่มเพื่อดู LINE ID ของตัวเอง':
    'Enter a LINE ID (starts with U) and who they are in the app. Reminders tag the people a note belongs to. Type id in the group to see your own LINE ID.',
  'สั่งนัดจากกลุ่มได้ เช่น “ทำนัด 18:00 31 ต.ค. ไปแข่งกีฬา” หรือขึ้นต้นด้วย นัด / เตือน / จด แล้วเว้นวรรค ต่อท้าย “เตือนก่อน 2 ชม.” หรือ “ล่วงหน้า 1 วัน” ได้ นัดจะขึ้นในแอปของคนที่พิมพ์ แชร์กับคู่':
    'You can add notes from the group, e.g. “ทำนัด 18:00 31 ต.ค. ไปแข่งกีฬา”, or start with นัด / เตือน / จด and a space. Add “เตือนก่อน 2 ชม.” or “ล่วงหน้า 1 วัน” to be reminded earlier. The note shows in the app of whoever typed it, shared with their partner.',
  '💬 ส่งข้อความทดสอบเข้ากลุ่ม': '💬 Send a test message to the group', 'ส่งข้อความทดสอบแล้ว ดูในกลุ่ม LINE': 'Test message sent, check the LINE group',
  'ส่งไม่สำเร็จ ตรวจว่า LINE OA อยู่ในกลุ่มและ Group ID ถูกต้อง': 'Could not send. Check the LINE OA is in the group and the Group ID is right',
  'เพิ่ม LINE OA ของ Centel เข้ากลุ่มของบ้าน บอทจะส่ง Group ID (ขึ้นต้นด้วย C) ให้ในกลุ่ม หรือพิมพ์ id ในกลุ่มเพื่อขอใหม่ แล้วนำมาใส่ที่นี่ การเตือนของโน้ตที่ตั้งเวลาไว้จะส่งเข้ากลุ่มนี้':
    'Add the Centel LINE OA to your family group. The bot posts the Group ID (starts with C) there, or type id in the group to get it again. Enter it here and note reminders are posted to this group.',
  'แก้ไขโน้ต': 'Edit note', 'เช่น ไปเยี่ยมแม่ ลำพูน': 'e.g. Visit Mom in Lamphun', 'ลบโน้ต': 'Delete note', 'โน้ตนี้สร้างโดย {0}': 'Created by {0}',
  'เวลา': 'Time', 'ทั้งวัน': 'All day', 'แชร์กับ {0}': 'Share with {0}', 'กรุณาพิมพ์สิ่งที่ต้องทำ': 'Please type what to do',
  'เพิ่มโน้ตแล้ว': 'Note added', 'เพิ่มแล้ว · {0}': 'Added · {0}', 'เสร็จแล้ว ✓': 'Done ✓', 'ลบโน้ตนี้?': 'Delete this note?',
  'สิ่งที่ต้องทำวันนี้ / เลยกำหนด': 'To-dos due today or overdue',
  // iPhone notifications (push.js)
  'แจ้งเตือนบนเครื่องนี้': 'Notifications on this device', '🔔 ส่งแจ้งเตือนทดสอบ': '🔔 Send a test notification',
  'บน iPhone ต้องเพิ่มแอปไปยังหน้าจอโฮมก่อน (Safari › แชร์ › เพิ่มไปยังหน้าจอโฮม) แล้วเปิดจากไอคอน จึงจะเปิดการแจ้งเตือนได้ (iOS 16.4 ขึ้นไป)':
    'On iPhone, add the app to the Home Screen first (Safari › Share › Add to Home Screen) and open it from the icon to turn on notifications (iOS 16.4 or later)',
  'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน': 'This browser does not support notifications',
  'ต้องเข้าสู่ระบบก่อน การแจ้งเตือนส่งมาจากเซิร์ฟเวอร์ จึงเด้งได้แม้ปิดแอปอยู่': 'Sign in first. Notifications come from the server, so they arrive even when the app is closed',
  'การแจ้งเตือนถูกปิดไว้ เปิดได้ที่ การตั้งค่า › การแจ้งเตือน › Centel': 'Notifications are turned off. Turn them on in Settings › Notifications › Centel',
  'จะเด้งเตือนบนเครื่องนี้เมื่อ บิลใกล้ครบกำหนด (09:00 ของวันเตือนล่วงหน้าและวันครบกำหนด) · โน้ตสิ่งที่ต้องทำถึงเวลาเตือน · คู่ของคุณเพิ่มรายจ่ายร่วม':
    'This device is notified when a bill is coming due (09:00 on the remind day and the due day), when a to-do reminder is due, and when your partner adds a shared expense',
  'เปิดแล้วจะเด้งเตือนแม้ปิดแอปอยู่: บิลใกล้ครบกำหนด โน้ตสิ่งที่ต้องทำที่ตั้งเตือนไว้ และเมื่อคู่ของคุณเพิ่มรายจ่ายร่วม':
    'Turn on to get notified even when the app is closed: bills coming due, to-do reminders, and shared expenses your partner adds',
  'ต้องเข้าสู่ระบบก่อน': 'Sign in first', 'ยังไม่ได้อนุญาตการแจ้งเตือน': 'Notifications were not allowed',
  'เปิดการแจ้งเตือนแล้ว': 'Notifications on', 'ปิดการแจ้งเตือนแล้ว': 'Notifications off', 'เปิดการแจ้งเตือนไม่สำเร็จ': 'Could not turn on notifications',
  'ส่งแล้ว ดูการแจ้งเตือนบนเครื่อง': 'Sent, check your notifications', 'ไม่พบเครื่องที่เปิดการแจ้งเตือน ลองปิดแล้วเปิดใหม่': 'No device with notifications on. Turn it off and on again',
};

// Thai letters, not the ฿ sign (U+0E3F) that amounts carry in both languages.
const TH_RE = /[\u0E01-\u0E3A\u0E40-\u0E5B]/;
const I18N_PATTERNS = (() => {
  const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  return Object.keys(I18N_EN).filter((k) => /\{\d\}/.test(k))
    .map((k) => {
      const order = [];
      const src = esc(k).replace(/\{(\d)\}/g, (_, n) => { order.push(Number(n)); return '(.*?)'; });
      return { re: new RegExp(`^${src}$`, 's'), order, en: I18N_EN[k], lit: k.replace(/\{\d\}/g, '').length };
    })
    // Most specific first, so "พบ {0} รายการ" wins over "{0} รายการ".
    .sort((a, b) => b.lit - a.lit);
})();

// Translate one piece of UI text. Returns it unchanged in Thai mode or when unknown.
function tr(s) {
  if (LANG !== 'en' || !s || !TH_RE.test(s)) return s;
  const lead = s.match(/^\s*/)[0];
  const trail = s.slice(lead.length).match(/\s*$/)[0];
  const core = s.slice(lead.length, s.length - trail.length);
  return lead + trCore(core) + trail;
}

function trCore(core) {
  if (Object.prototype.hasOwnProperty.call(I18N_EN, core)) return I18N_EN[core];
  for (const p of I18N_PATTERNS) {
    const m = core.match(p.re);
    if (!m) continue;
    const vals = [];
    p.order.forEach((n, i) => { vals[n] = m[i + 1]; });
    return p.en.replace(/\{(\d)\}/g, (_, n) => tr(vals[n] || ''));
  }
  // Parts joined with " · " are translated one by one.
  if (core.includes(' · ')) return core.split(' · ').map((x) => tr(x)).join(' · ');
  // Unknown sentence: translate each Thai run that is a known word or phrase
  // (dates like "5 ต.ค. 69", "ตุลาคม 2025"), leave anything else as typed.
  return core.replace(/[\u0E01-\u0E3A\u0E40-\u0E5B][.\u0E01-\u0E3A\u0E40-\u0E5B]*(?: +[\u0E01-\u0E3A\u0E40-\u0E5B][.\u0E01-\u0E3A\u0E40-\u0E5B]*)*/g, (run) => {
    if (Object.prototype.hasOwnProperty.call(I18N_EN, run)) return I18N_EN[run];
    const words = run.split(/ +/);
    return words.every((w) => Object.prototype.hasOwnProperty.call(I18N_EN, w)) ? words.map((w) => I18N_EN[w]).join(' ') : run;
  });
}

if (LANG === 'en') {
  document.documentElement.lang = 'en';
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
  const trText = (n) => {
    const v = n.nodeValue;
    if (!TH_RE.test(v) || (n.parentNode && SKIP.has(n.parentNode.nodeName))) return;
    // Text the person typed (marked translate="no") stays as written.
    if (n.parentElement && n.parentElement.closest('[translate="no"]')) return;
    const t = tr(v);
    if (t !== v) n.nodeValue = t;
  };
  const trAttrs = (el) => {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && TH_RE.test(v)) { const t = tr(v); if (t !== v) el.setAttribute(a, t); }
    }
  };
  const walk = (root) => {
    if (root.nodeType === 3) { trText(root); return; }
    if (root.nodeType !== 1 || root.nodeName === 'SCRIPT' || root.nodeName === 'STYLE') return;
    trAttrs(root);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = it.nextNode())) {
      if (n.nodeType === 3) trText(n);
      else trAttrs(n);
    }
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') trText(m.target);
      else if (m.type === 'attributes') trAttrs(m.target);
      else m.addedNodes.forEach(walk);
    }
  });
  const start = () => {
    walk(document.body);
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  document.title = tr(document.title);
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.content = tr(meta.content);

  // Native dialogs.
  const nAlert = window.alert.bind(window), nConfirm = window.confirm.bind(window), nPrompt = window.prompt.bind(window);
  window.alert = (m) => nAlert(tr(String(m)));
  window.confirm = (m) => nConfirm(tr(String(m)));
  window.prompt = (m, d) => nPrompt(tr(String(m)), d);
}
