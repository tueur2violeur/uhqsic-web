// Mouvements partagés : morph de pochette, ressort de glissement, éclat du favori.
// Tout passe par transform/opacity (Web Animations API), interrompable.

// Réglage de l'iPhone ou réglage « Animations réduites » de l'app.
export const reducedMotion = () =>
  document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;

export const SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

/**
 * Fait voler un clone de pochette d'un rectangle à un autre (technique FLIP).
 * `html` est le balisage de la pochette ; `fromRadius`/`toRadius` en px réels.
 */
export function flyArt(html, from, to, { fromRadius, toRadius, duration = 560 }) {
  if (reducedMotion() || !from.width || !to.width) return Promise.resolve();
  const holder = document.createElement('div');
  holder.innerHTML = html.trim();
  const el = holder.firstElementChild;
  el.classList.add('fly');
  el.removeAttribute('id');
  Object.assign(el.style, { width: `${to.width}px`, height: `${to.height}px` });
  document.body.appendChild(el);

  const scale = from.width / to.width;
  const start = `translate(${from.left}px, ${from.top}px) scale(${scale})`;
  const end = `translate(${to.left}px, ${to.top}px) scale(1)`;
  const animation = el.animate(
    [
      { transform: start, borderRadius: `${fromRadius / scale}px` },
      { transform: end, borderRadius: `${toRadius}px` },
    ],
    { duration, easing: SPRING, fill: 'forwards' },
  );
  return animation.finished.catch(() => {}).then(() => el.remove());
}

/** Résistance progressive au-delà d'une limite (rubber band d'iOS). */
export function rubberBand(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Petite explosion de particules autour d'un bouton. */
export function burst(button, color = '#FF4D7A') {
  if (reducedMotion()) return;
  const count = 10;
  for (let i = 0; i < count; i++) {
    const spark = document.createElement('span');
    spark.className = 'spark';
    spark.style.background = i % 3 === 0 ? '#FFD166' : color;
    button.appendChild(spark);
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 22 + Math.random() * 14;
    spark.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(0.2)`, opacity: 0 },
      ],
      { duration: 520 + Math.random() * 160, easing: OUT },
    ).finished.then(() => spark.remove(), () => spark.remove());
  }
}

/** Entrée latérale d'un bloc lors d'un changement de morceau (sens du geste). */
export function slideIn(el, direction, distance = 28) {
  if (!el || reducedMotion() || !direction) return;
  el.animate(
    [
      { transform: `translateX(${direction * distance}px)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 420, easing: SPRING },
  );
}

/**
 * Listes qui changent (suppression, annulation) : chaque ligne glisse de son ancienne place
 * à la nouvelle au lieu de sauter, les lignes qui reviennent apparaissent en fondu.
 * Seules les lignes visibles sont animées.
 */
export function flipRows(containers, mutate) {
  const before = new Map();
  for (const container of containers) {
    for (const row of container.querySelectorAll('.row[data-id]')) {
      const top = row.getBoundingClientRect().top;
      if (top > -200 && top < innerHeight + 200) before.set(`${container.id}:${row.dataset.id}`, top);
    }
  }
  mutate();
  if (reducedMotion()) return;
  for (const container of containers) {
    for (const row of container.querySelectorAll('.row[data-id]')) {
      const top = row.getBoundingClientRect().top;
      if (top < -200 || top > innerHeight + 200) continue;
      const old = before.get(`${container.id}:${row.dataset.id}`);
      if (old === undefined) {
        row.animate([{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: OUT });
      } else if (Math.abs(old - top) > 1) {
        row.animate([{ transform: `translateY(${old - top}px)` }, { transform: 'none' }], { duration: 240, easing: OUT });
      }
    }
  }
}

/** Ligne qui s'en va : glisse un peu et s'efface (avant d'être retirée de la liste). */
export function leaveRows(rows) {
  if (reducedMotion() || !rows.length) return Promise.resolve();
  return Promise.all(rows.map((row) => row.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-6%)' }],
    { duration: 160, easing: OUT, fill: 'forwards' },
  ).finished.catch(() => {})));
}
