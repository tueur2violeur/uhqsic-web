// Réglages de l'app : thème, couleur, lecteur, tri. Gardés dans le téléphone (localStorage).

const KEY = 'uhqsic.prefs';

export const ACCENTS = [
  { id: 'outremer', name: 'Outremer', light: '#3A3AE0', dark: '#8C8CFF' },
  { id: 'framboise', name: 'Framboise', light: '#C81E54', dark: '#FF6B93' },
  { id: 'sapin', name: 'Sapin', light: '#1A7A50', dark: '#4CD995' },
  { id: 'ambre', name: 'Ambre', light: '#9A5A00', dark: '#FFB340' },
  { id: 'graphite', name: 'Graphite', light: '#3A3A3C', dark: '#E5E5EA' },
];

/** Ambiances : un thème complet (couleurs, fond, parfois la police). `dark` : thème sombre. */
export const THEMES = [
  { id: 'minuit', name: 'Minuit', dark: true, bg: '#060A1C', surface: '#10163A', text: '#F2F4FF', accent: '#7C93FF', glow: '#2A3A9E' },
  { id: 'neon', name: 'Néon', dark: true, bg: '#07020D', surface: '#150A22', text: '#FFFFFF', accent: '#FF3EA5', glow: '#00E5FF' },
  { id: 'coucher', name: 'Coucher de soleil', dark: true, bg: '#170914', surface: '#261220', text: '#FFF4EE', accent: '#FF8A4C', glow: '#D63384' },
  { id: 'aurore', name: 'Aurore', dark: true, bg: '#070814', surface: '#12122A', text: '#F4F2FF', accent: '#A78BFA', glow: '#34D399' },
  { id: 'foret', name: 'Forêt', dark: true, bg: '#06120C', surface: '#0E2117', text: '#EFFFF5', accent: '#4ADE80', glow: '#14532D' },
  { id: 'lave', name: 'Lave', dark: true, bg: '#110605', surface: '#22100C', text: '#FFF3EE', accent: '#FF6A3D', glow: '#B91C1C' },
  { id: 'oled', name: 'Noir absolu', dark: true, bg: '#000000', surface: '#0D0D0D', text: '#FFFFFF', accent: '#FFFFFF', glow: '#000000' },
  { id: 'vinyle', name: 'Vinyle', dark: false, bg: '#F2E8D5', surface: '#FBF4E6', text: '#2B1D12', accent: '#A8340C', glow: '#E9B872' },
  { id: 'sakura', name: 'Sakura', dark: false, bg: '#FFF0F4', surface: '#FFFFFF', text: '#3A0A1F', accent: '#C8125F', glow: '#FF9CC2' },
  { id: 'glacier', name: 'Glacier', dark: false, bg: '#EAF4FA', surface: '#F7FBFE', text: '#062033', accent: '#0369A1', glow: '#7DD3FC' },
  { id: 'encre', name: 'Encre', dark: false, bg: '#FAFAF7', surface: '#FFFFFF', text: '#0A0A0A', accent: '#0A0A0A', glow: '#D4D4CF' },
];
export const themeById = (id) => THEMES.find((t) => t.id === id);

const DEFAULTS = { theme: 'auto', accent: 'outremer', vinyl: true, ambient: true, motion: 'full', sort: 'title', autoLyrics: true };

export const prefs = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
})();

export function setPref(key, value) {
  prefs[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Stockage plein : le réglage vaut pour cette session.
  }
  applyPrefs();
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
export const isDark = () => {
  const theme = themeById(prefs.theme);
  if (theme) return theme.dark;
  return prefs.theme === 'dark' || (prefs.theme === 'auto' && darkQuery.matches);
};

export function applyPrefs() {
  const root = document.documentElement;
  // data-theme : le thème choisi ; data-scheme : clair ou sombre, pour tout ce qui en dépend.
  if (prefs.theme === 'auto') {
    delete root.dataset.theme;
    delete root.dataset.scheme;
  } else {
    root.dataset.theme = prefs.theme;
    root.dataset.scheme = isDark() ? 'dark' : 'light';
  }
  if (prefs.accent === 'outremer') delete root.dataset.accent;
  else root.dataset.accent = prefs.accent;
  root.classList.toggle('no-vinyl', !prefs.vinyl);
  root.classList.toggle('no-ambient', !prefs.ambient);
  root.classList.toggle('reduce-motion', prefs.motion === 'reduced');

  // Barre d'état et couleur du navigateur assorties au thème réellement affiché.
  const color = themeById(prefs.theme)?.bg || (isDark() ? '#000000' : '#F7F7FA');
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.content = prefs.theme === 'auto' ? (meta.media.includes('dark') ? '#000000' : '#F7F7FA') : color;
  }
}

darkQuery.addEventListener('change', applyPrefs);
