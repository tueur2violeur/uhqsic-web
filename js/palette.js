// Teintes du fond vivant du lecteur, tirées de la couleur moyenne de la pochette.
// Luminosités plafonnées : le texte blanc reste lisible sur toutes les pochettes.

const FALLBACK = [0x3a, 0x3a, 0xe0];

function toHSV([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}

function css(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})`;
}

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

export function playerPalette(rgb) {
  const [h, s0, v] = toHSV(rgb || FALLBACK);
  const s = Math.min(s0 * 1.15, 0.9);
  return {
    glow: css(h, s, clamp(v, 0.3, 0.62)),
    deep: css(h - 0.03, Math.min(s * 1.1, 0.95), clamp(v * 0.7, 0.22, 0.45)),
    base: css(h, Math.min(s * 1.1, 0.95), 0.14),
    shifted: css(h + 0.07, s * 0.9, 0.5),
    label: css(h, s, clamp(v, 0.45, 0.85)),
  };
}
