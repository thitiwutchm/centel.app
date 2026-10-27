/* Colour themes. Loaded in <head> so the saved theme is on <html> before the first paint.
   Each device keeps its own choice (localStorage centel.theme); 'glass' is the original
   ice-blue look that follows the phone's light/dark setting. */

const THEME_KEY = 'centel.theme';
const THEMES = [
  { id: 'glass', label: 'ฟ้า', bar: null, light: null },
  { id: 'pink', label: 'ชมพูพาสเทล', bar: '#fbdbe7', light: true },
  { id: 'black', label: 'ดำสนิท', bar: '#000000', light: false },
  { id: 'white', label: 'ขาว', bar: '#ffffff', light: true },
];

function themeId() {
  let id = '';
  try { id = localStorage.getItem(THEME_KEY) || ''; } catch (e) { /* private mode */ }
  return THEMES.some((t) => t.id === id) ? id : 'glass';
}

function themeOf(id = themeId()) { return THEMES.find((t) => t.id === id) || THEMES[0]; }

// True when cards and sheets are drawn dark (used for canvas tints and the Google button).
function themeIsDark() {
  const t = themeOf();
  return t.light === null ? window.matchMedia('(prefers-color-scheme: dark)').matches : !t.light;
}

function applyTheme(id = themeId()) {
  const t = themeOf(id);
  const root = document.documentElement;
  if (t.id === 'glass') { delete root.dataset.theme; delete root.dataset.backdrop; }
  else { root.dataset.theme = t.id; root.dataset.backdrop = t.light ? 'light' : 'dark'; }
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (!m.dataset.orig) m.dataset.orig = m.content;
    m.content = t.bar || m.dataset.orig;
  });
  // Light backdrops need dark status-bar text; iOS picks this up the next time the app opens.
  const sb = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (sb) sb.content = t.light ? 'default' : 'black-translucent';
}

function setTheme(id) {
  try { localStorage.setItem(THEME_KEY, id); } catch (e) { /* keep it for this visit only */ }
  applyTheme(id);
}

applyTheme();
