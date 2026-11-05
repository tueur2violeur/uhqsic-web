// Gestes natifs : glisser depuis le bord gauche pour revenir, glisser une ligne pour agir.
// Le contenu suit le doigt ; au relâchement, la vitesse compte autant que la distance.

import { reducedMotion } from './motion.js';

const AXIS_LOCK = 8; // px avant de décider horizontal ou vertical

/**
 * Bord gauche → retour (page d'une playlist, d'un artiste…).
 * `canStart()` : le geste est permis maintenant ; `onBack()` : fermer la page.
 * `onProgress(p)` : 0 → 1 pendant le glissement (pour la page dessous).
 */
export function setupEdgeBack(page, { canStart, onBack, onProgress = () => {}, edge = 28 }) {
  let g = null;
  page.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.clientX > edge || !canStart()) return;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, t: performance.now(), v: 0, axis: null };
  });
  page.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < AXIS_LOCK) return;
      g.axis = Math.abs(dx) > Math.abs(dy) && dx > 0 ? 'x' : 'y';
      if (g.axis !== 'x') {
        g = null;
        return;
      }
      page.setPointerCapture(e.pointerId);
      page.style.transition = 'none';
    }
    const now = performance.now();
    g.v = (e.clientX - g.lastX) / Math.max(now - g.t, 1);
    g.lastX = e.clientX;
    g.t = now;
    const x = Math.max(0, dx);
    page.style.transform = `translateX(${x}px)`;
    onProgress(Math.min(1, x / page.offsetWidth));
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const done = g.axis === 'x';
    const dx = e.clientX - g.x;
    const velocity = g.v;
    g = null;
    if (!done) return;
    // Lancé vers la droite, ou plus d'un tiers de la largeur : on revient.
    const back = velocity > 0.45 || dx > page.offsetWidth * 0.35;
    page.style.transition = '';
    void page.offsetWidth;
    page.style.transform = '';
    onProgress(back ? 1 : 0, true);
    if (back) onBack();
  };
  page.addEventListener('pointerup', end);
  page.addEventListener('pointercancel', end);
}

/**
 * Glisser une ligne : vers la droite → `right`, vers la gauche → `left`.
 * Chaque action : { label, icon, color, run(row) }. `enabled()` : listes en mode normal.
 */
export function setupRowSwipe(list, { enabled, right, left, threshold = 76 }) {
  let g = null;
  let hint = null;
  const clearHint = () => {
    hint?.remove();
    hint = null;
  };
  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !enabled()) return;
    const row = e.target.closest('.row[data-id]');
    if (!row || e.target.closest('[data-action="drag"], [data-action="more"]')) return;
    g = { id: e.pointerId, row, x: e.clientX, y: e.clientY, axis: null, armed: false, dx: 0 };
  });
  list.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < AXIS_LOCK) return;
      g.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
      if (g.axis !== 'x') {
        g = null;
        return;
      }
      list.setPointerCapture(e.pointerId);
      g.row.classList.add('swiping');
      hint = document.createElement('div');
      hint.className = 'swipe-hint';
      hint.setAttribute('aria-hidden', 'true');
      list.appendChild(hint);
    }
    const action = dx > 0 ? right : left;
    // Au-delà du seuil, la ligne résiste un peu : on sent qu'on peut lâcher.
    const over = Math.max(0, Math.abs(dx) - threshold);
    const x = Math.sign(dx) * Math.min(Math.abs(dx), threshold + over * 0.35);
    g.dx = dx;
    g.row.style.transform = `translateX(${x}px)`;
    const armed = Math.abs(dx) >= threshold;
    if (armed !== g.armed) {
      g.armed = armed;
      if (armed) haptic();
    }
    Object.assign(hint.style, {
      top: `${g.row.offsetTop}px`,
      height: `${g.row.offsetHeight}px`,
      width: `${Math.abs(x)}px`,
      left: dx > 0 ? '0px' : 'auto',
      right: dx > 0 ? 'auto' : '0px',
    });
    // Les variables CSS ne passent que par setProperty.
    hint.style.setProperty('--hint', action.color);
    hint.style.setProperty('--hint-on', action.on || '#fff');
    hint.classList.toggle('armed', armed);
    hint.classList.toggle('from-right', dx < 0);
    if (hint.dataset.side !== String(dx > 0)) {
      hint.dataset.side = String(dx > 0);
      hint.innerHTML = action.icon;
      hint.setAttribute('aria-label', action.label);
    }
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const { row, axis, armed, dx } = g;
    g = null;
    if (axis !== 'x') return;
    // Le tap qui suit ce geste ne doit pas lancer la lecture.
    const swallow = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    list.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => list.removeEventListener('click', swallow, { capture: true }), 50);
    row.classList.remove('swiping');
    row.style.transform = '';
    if (!reducedMotion()) {
      hint?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' }).finished.then(clearHint, clearHint);
    } else {
      clearHint();
    }
    if (armed) (dx > 0 ? right : left).run(row);
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}

/**
 * Retour haptique. Android : vibration. iPhone (iOS 18 et plus) : Safari ne permet pas de vibrer,
 * mais un interrupteur système joue un petit « tic » quand il change d'état ; on en bascule un, invisible.
 */
let hapticSwitch = null;
export function haptic() {
  if (navigator.vibrate) {
    navigator.vibrate(8);
    return;
  }
  if (!hapticSwitch) {
    hapticSwitch = document.createElement('label');
    hapticSwitch.setAttribute('aria-hidden', 'true');
    hapticSwitch.style.cssText = 'position:fixed;left:-20px;top:-20px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    hapticSwitch.appendChild(input);
    document.body.appendChild(hapticSwitch);
  }
  hapticSwitch.click();
}

/** Fenêtre du bas : la tirer vers le bas par sa poignée la ferme, comme sur iPhone. */
export function setupSheetDrag(sheet, handle, dim, { onClose }) {
  let g = null;
  handle.addEventListener('pointerdown', (e) => {
    g = { id: e.pointerId, y: e.clientY, lastY: e.clientY, t: performance.now(), v: 0, moved: false };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dy = Math.max(0, e.clientY - g.y);
    const now = performance.now();
    g.v = (e.clientY - g.lastY) / Math.max(now - g.t, 1);
    g.lastY = e.clientY;
    g.t = now;
    if (!g.moved && dy < 4) return;
    g.moved = true;
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${dy}px)`;
    dim.style.opacity = String(Math.max(0, 1 - dy / (sheet.offsetHeight || 1)));
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const { moved, v } = g;
    const dy = Math.max(0, e.clientY - g.y);
    g = null;
    if (!moved) return;
    if (dy > Math.min(140, sheet.offsetHeight * 0.3) || v > 0.6) {
      // La fermeture part de la position actuelle : pas de saut.
      dim.style.opacity = '';
      onClose();
      setTimeout(() => {
        sheet.style.transition = '';
        sheet.style.transform = '';
      }, 300);
      return;
    }
    sheet.style.transition = reducedMotion() ? 'none' : 'transform 260ms cubic-bezier(0.23, 1, 0.32, 1)';
    sheet.style.transform = '';
    dim.style.opacity = '';
    setTimeout(() => { sheet.style.transition = ''; }, 280);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
