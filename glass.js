/* Glass UI motion, after Revolut's create / close pocket interaction:
   - glassConfirm(): a floating confirmation sheet that rises over the open sheet.
   - dissolve(): the item shrinks slightly, then breaks into fine glowing particles
     that sweep left to right and drift away.
   - popIn(): a newly created item's screen scales up into place from a dim backdrop. */

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function glassConfirm({ title, text = '', ok = 'ยืนยัน', cancel = 'ยกเลิก', danger = true }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'gconfirm';
    wrap.innerHTML = `
      <div class="gc-scrim"></div>
      <div class="gc-card" role="alertdialog" aria-modal="true" aria-labelledby="gcTitle">
        <h3 id="gcTitle">${esc(title)}</h3>
        ${text ? `<p>${esc(text)}</p>` : ''}
        <div class="gc-actions">
          <button class="btn ghost" data-gc="0">${esc(cancel)}</button>
          <button class="btn ${danger ? 'dark' : ''}" data-gc="1">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const done = (yes) => {
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), reduceMotion() ? 0 : 260);
      resolve(yes);
    };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gc]');
      if (b) done(b.dataset.gc === '1');
      else if (e.target.classList.contains('gc-scrim')) done(false);
    });
    wrap.querySelector('[data-gc="1"]').focus({ preventScroll: true });
  });
}

// Breaks `el` into particles. Resolves once the element is fully gone so the caller can remove it.
function dissolve(el) {
  if (!el || reduceMotion()) return Promise.resolve();
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return Promise.resolve();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cv = document.createElement('canvas');
  cv.className = 'dissolve-canvas';
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const tints = themeId() === 'pink' ? ['255,255,255', '255,214,230', '244,170,200']
    : themeId() === 'white' ? ['200,204,212', '170,176,186', '226,228,232']
    : themeIsDark() ? ['214,232,255', '160,196,240', '255,255,255'] : ['255,255,255', '214,232,255', '178,208,240'];

  el.style.transition = 'transform .28s cubic-bezier(.3,.7,.4,1)';
  el.style.transform = 'scale(.96)';
  el.style.transformOrigin = '50% 50%';

  const SHRINK = 280, SWEEP = 760, FADE = 900;
  const parts = [];
  let front = 0; // 0..1 across the element, left to right
  const t0 = performance.now();
  return new Promise((resolve) => {
    const frame = (now) => {
      const t = now - t0;
      if (t > SHRINK) {
        const p = Math.min(1, (t - SHRINK) / SWEEP);
        const eased = p * p * (3 - 2 * p);
        const next = eased * 1.08;
        // Spawn particles across the band the front passed this frame.
        const band = Math.max(0, Math.min(1, next) - front);
        const n = Math.ceil(band * r.width * r.height / 38);
        const s = 0.96, ox = r.left + r.width * (1 - s) / 2, oy = r.top + r.height * (1 - s) / 2;
        for (let i = 0; i < n; i++) {
          const fx = front + Math.random() * band;
          parts.push({
            x: ox + fx * r.width * s, y: oy + Math.random() * r.height * s,
            vx: 0.15 + Math.random() * 0.7, vy: -0.25 - Math.random() * 0.6,
            r: 0.5 + Math.random() * 1.1, born: t, life: FADE * (0.6 + Math.random() * 0.6),
            c: tints[(Math.random() * tints.length) | 0],
          });
        }
        front = Math.min(1, next);
        const edge = front * 100;
        el.style.webkitMaskImage = el.style.maskImage =
          `linear-gradient(90deg, transparent ${edge - 4}%, #000 ${edge + 4}%)`;
      }
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      let alive = 0;
      for (const q of parts) {
        const age = t - q.born;
        if (age > q.life) continue;
        alive++;
        const k = age / q.life;
        q.x += q.vx; q.y += q.vy; q.vy -= 0.004;
        ctx.fillStyle = `rgba(${q.c},${(1 - k) * 0.9})`;
        ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (1 - k * 0.5), 0, 6.283); ctx.fill();
      }
      if (front >= 1 && el.style.opacity !== '0') { el.style.opacity = '0'; resolve(); }
      if (front < 1 || alive) requestAnimationFrame(frame);
      else cv.remove();
    };
    requestAnimationFrame(frame);
  });
}

// Resets the inline styles dissolve() left on an element that is reused (the sheet).
function undissolve(el) {
  if (!el) return;
  ['transition', 'transform', 'transformOrigin', 'opacity', 'maskImage', 'webkitMaskImage'].forEach((k) => { el.style[k] = ''; });
}

function popIn(el = document.getElementById('view')) {
  if (!el || reduceMotion()) return;
  el.classList.remove('pop-in');
  void el.offsetWidth;
  el.classList.add('pop-in');
  el.addEventListener('animationend', () => el.classList.remove('pop-in'), { once: true });
}

// Confirm, dissolve the open sheet, then run `remove` (which closes the sheet and re-renders).
async function confirmDelete(title, text, remove) {
  if (!(await glassConfirm({ title, text, ok: 'ลบ' }))) return;
  const sheet = document.getElementById('sheet');
  await dissolve(sheet && !sheet.hidden ? sheet : null);
  remove();
  undissolve(sheet);
}
