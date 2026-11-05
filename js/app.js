import { db, persistStorage, wipeDatabase } from './db.js';
import { prefs, setPref, applyPrefs, isDark, ACCENTS, THEMES, themeById } from './settings.js';
import { importFile, processArtwork } from './importer.js';
import { PlaybackQueue, RepeatMode, nextRepeatMode } from './queue.js';
import { playerPalette } from './palette.js';
import { flyArt, rubberBand, burst, slideIn, reducedMotion, flipRows, leaveRows, SPRING, OUT } from './motion.js';
import { setupEdgeBack, setupRowSwipe, setupSheetDrag, haptic } from './gestures.js';
import { loadStats, saveStats, addListening, recap, monthKey, monthName, PLAY_THRESHOLD, SMART, smartTracks, recentlyPlayed } from './stats.js';
import { buildBackup, matchBackup } from './backup.js';
import { shareFile, nowPlayingCard } from './share.js';
import { findLyrics, parseLRC, currentLine, searchLyricsCandidates, identity } from './lyrics.js';
import { dailyMix, artistRadio, MOODS, moodTracks, usedMoods, topRated, loadHistory, addHistory, historyByDay, dayKey } from './discover.js';
import { createResumer } from './resume.js';
import { isIOS, isStandalone, canInstall, canPrompt, installGuideHTML, promptInstall, remindLater, shouldSuggest } from './install.js';
import { createSync, restorePersisted, deviceId, deviceName, deviceLabel, setDeviceLabel, mergeCounts, linkInfo, SYNC_FIELDS } from './sync.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

const state = {
  tracks: new Map(),
  playlists: [],
  search: '',
  tab: 'songs',
  collection: null, // { kind: 'playlist' | 'favorites' | 'artist' | 'album', key }
  editing: false,
  importing: { total: 0, done: 0 },
  loaded: false,
  selecting: false,
  selected: new Set(),
};
const stats = loadStats();
const history = loadHistory();
let ME = null; // identité de cet appareil, connue après la restauration au démarrage
let sync = null; // appareils liés, créé au démarrage

/** Enregistre un morceau. `edited` : changement fait par l'utilisateur, envoyé aux appareils liés. */
async function saveTrack(track, edited = true) {
  if (edited) track.mtime = Date.now();
  await db.saveTrack(track);
  if (edited) sync?.trackChanged(track);
}

async function savePlaylist(playlist) {
  playlist.mtime = Date.now();
  await db.savePlaylist(playlist);
  sync?.playlistChanged(playlist);
}

const isWide = () => matchMedia('(min-width: 900px)').matches;

const queue = new PlaybackQueue();
let currentId = null;
let currentUrl = null;
let pendingDirection = 0; // sens du dernier changement de morceau : 1 suivant, -1 précédent

// MARK: Utilitaires

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmt(seconds) {
  const v = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = String(v % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function summary(tracks) {
  const count = tracks.length === 1 ? '1 morceau' : `${tracks.length} morceaux`;
  const minutes = Math.floor(tracks.reduce((n, t) => n + (t.duration || 0), 0) / 60);
  if (!minutes) return count;
  return `${count}, ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}`;
}

const urls = new Map();
function blobUrl(key, blob) {
  if (!blob) return null;
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}

const tintOf = (track) => (track?.tint ? `rgb(${track.tint.join(',')})` : 'var(--accent)');

function artHTML(track, { full = false, extra = '' } = {}) {
  const blob = track && (full ? track.art || track.thumb : track.thumb || track.art);
  const url = track && blobUrl(`${track.id}:${full ? 'l' : 's'}`, blob);
  if (!url) return `<span class="art placeholder ${extra}" style="--glow:${tintOf(track)}"></span>`;
  return `<span class="art has-image ${extra}" style="background-image:url('${url}');--glow:${tintOf(track)}"></span>`;
}

/** Remplace une pochette en gardant son id et ses classes de mise en page (big-art, tiny…). */
function setArt(el, track, full) {
  const extra = [...el.classList].filter((c) => !['art', 'placeholder', 'has-image', 'fly-hide'].includes(c)).join(' ');
  el.outerHTML = artHTML(track, { full, extra }).replace('<span ', `<span id="${el.id}" `);
}

let toastTimer;
/** Notification en haut de l'écran ; avec `action`, un bouton (« Annuler ») reste touchable. */
function toast(message, { action = '', onAction = null, duration = 1800 } = {}) {
  const el = $('toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button" class="toast-btn">${esc(action)}</button>` : ''}`;
  el.classList.toggle('actionable', !!action);
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (action) {
    el.querySelector('.toast-btn').onclick = () => {
      clearTimeout(toastTimer);
      el.classList.remove('show', 'actionable');
      onAction?.();
    };
  }
  toastTimer = setTimeout(() => el.classList.remove('show', 'actionable'), duration);
}

const heartSVG = (cls = 'i') => `<svg viewBox="0 0 24 24" class="${cls}"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.6 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>`;
const eqHTML = '<span class="eq" role="img" aria-label="En cours de lecture"><span></span><span></span><span></span><span></span></span>';

const byTitle = (a, b) => collator.compare(a.title, b.title);
const SORTS = {
  title: byTitle,
  artist: (a, b) => collator.compare(a.artist, b.artist) || byTitle(a, b),
  recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
};
const sortedTracks = () => [...state.tracks.values()].sort(SORTS[prefs.sort] || byTitle);
const playlistTracks = (p) => (p ? p.trackIds.map((id) => state.tracks.get(id)).filter(Boolean) : []);
const playlistById = (id) => state.playlists.find((p) => p.id === id);
const favorites = () => sortedTracks().filter((t) => t.fav);

function normalize(s) {
  return (s || '').toLocaleLowerCase('fr').normalize('NFD').replace(/\p{M}/gu, '');
}

// Recherche dans les paroles : « une phrase dont on se souvient » retrouve le morceau.
const lyricHits = new Map(); // id → vers trouvé
const lyricIndex = new WeakMap();
function lyricText(track) {
  if (!track.lyrics) return '';
  let entry = lyricIndex.get(track);
  if (!entry || entry.source !== track.lyrics) {
    entry = { source: track.lyrics, text: normalize(track.lyrics).replace(/\s+/g, ' ') };
    lyricIndex.set(track, entry);
  }
  return entry.text;
}

function filtered() {
  const all = sortedTracks();
  lyricHits.clear();
  const needle = normalize(state.search.trim()).replace(/\s+/g, ' ');
  if (!needle) return all;
  const direct = all.filter((t) => [t.title, t.artist, t.album].some((f) => normalize(f).includes(needle)));
  if (needle.length < 3) return direct;
  const found = new Set(direct.map((t) => t.id));
  const inLyrics = all.filter((t) => !found.has(t.id) && lyricText(t).includes(needle));
  for (const t of inLyrics) {
    const words = needle.split(' ');
    const line = t.lyrics.split('\n').find((l) => normalize(l).includes(needle)) || t.lyrics.split('\n').find((l) => normalize(l).includes(words[0])) || '';
    lyricHits.set(t.id, line.trim());
  }
  return [...direct, ...inLyrics];
}

function groupBy(tracks, key) {
  const groups = new Map();
  for (const t of tracks) {
    const name = (t[key] || '').trim();
    if (!name) continue;
    const id = normalize(name);
    if (!groups.has(id)) groups.set(id, { name, tracks: [] });
    groups.get(id).tracks.push(t);
  }
  return [...groups.values()].sort((a, b) => collator.compare(a.name, b.name));
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// MARK: Bibliothèque

function rowHTML(track, i, { mode = 'list', animate = false, time = '' } = {}) {
  const current = track.id === currentId;
  const lead = mode === 'edit'
    ? `<button class="remove press" data-action="remove" aria-label="Retirer ${esc(track.title)}"><svg viewBox="0 0 24 24" class="i"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg></button>`
    : '';
  if (mode === 'select') {
    const on = state.selected.has(track.id);
    return `<li class="row selectable${on ? ' selected' : ''}" data-id="${track.id}" data-index="${i}" data-letter="${letterOf(track.title)}">
      <button class="main" data-action="select" aria-pressed="${on}">
        <span class="check"></span>${artHTML(track)}
        <span class="text"><span class="t">${esc(track.title)}</span><span class="a">${esc(track.artist)}</span></span>
      </button>
    </li>`;
  }
  const tail = mode === 'edit'
    ? '<span class="handle" data-action="drag" aria-label="Déplacer"><svg viewBox="0 0 24 24" class="i"><path d="M4 8h16M4 12h16M4 16h16"/></svg></span>'
    : `<span class="end">${current ? eqHTML : `<span>${time || fmt(track.duration)}</span>`}</span><button class="more" data-action="more" aria-label="Options pour ${esc(track.title)}"><svg viewBox="0 0 24 24" class="i fill sm"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>`;
  const fav = track.fav ? `${heartSVG('i fav-dot')} ` : '';
  const plays = track.plays ? `<span class="plays">, ${track.plays} écoute${track.plays > 1 ? 's' : ''}</span>` : '';
  const hit = mode === 'list' && lyricHits.get(track.id);
  const sub = hit ? `<span class="lyric-hit">« ${esc(hit.slice(0, 90))} »</span>` : `${fav}${esc(track.artist)}${plays}`;
  return `<li class="row${current ? ' current' : ''}${animate ? ' enter' : ''}" data-id="${track.id}" data-index="${i}" data-letter="${letterOf(track.title)}" style="--delay:${Math.min(i, 12) * 35}ms">
    ${lead}
    <button class="main" data-action="play" ${mode === 'edit' ? 'disabled' : ''}>
      ${artHTML(track)}
      <span class="text"><span class="t">${esc(track.title)}</span><span class="a">${sub}</span></span>
    </button>
    ${tail}
  </li>`;
}

const letterOf = (title) => {
  const c = normalize(title).charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
};

// Grosse bibliothèque : les premières lignes tout de suite, le reste par paquets entre deux images.
// L'écran répond aussitôt, même avec des milliers de morceaux.
const FIRST_ROWS = 60;
const ROWS_PER_FRAME = 150;
const pendingRows = new Map(); // liste → { rows, next, frame }

function renderRows(list, rows) {
  cancelRows(list);
  list.innerHTML = rows.slice(0, FIRST_ROWS).join('');
  if (rows.length <= FIRST_ROWS) return;
  const job = { rows, next: FIRST_ROWS, frame: 0 };
  pendingRows.set(list, job);
  const step = () => {
    if (pendingRows.get(list) !== job) return;
    list.insertAdjacentHTML('beforeend', rows.slice(job.next, job.next + ROWS_PER_FRAME).join(''));
    job.next += ROWS_PER_FRAME;
    if (job.next < rows.length) job.frame = requestAnimationFrame(step);
    else pendingRows.delete(list);
  };
  job.frame = requestAnimationFrame(step);
}

function cancelRows(list) {
  const job = pendingRows.get(list);
  if (!job) return;
  cancelAnimationFrame(job.frame);
  pendingRows.delete(list);
}

/** Termine tout de suite l'affichage en cours (saut A-Z, sélection de tout). */
function finishRows(list) {
  const job = pendingRows.get(list);
  if (!job) return;
  cancelRows(list);
  list.insertAdjacentHTML('beforeend', job.rows.slice(job.next).join(''));
}

let firstRender = true;
function renderLibrary() {
  const hasAny = state.tracks.size > 0;
  const tracks = filtered();
  const animate = firstRender && state.loaded;
  if (state.loaded) firstRender = false;

  const showEmpty = state.loaded && !hasAny && state.importing.total === 0;
  $('empty').hidden = !showEmpty;
  $('tabs').hidden = !hasAny;
  document.querySelector('.search').hidden = !hasAny;
  for (const tab of ['songs', 'artists', 'albums']) $(`view-${tab}`).hidden = !hasAny || state.tab !== tab;

  let resultCount = tracks.length;
  if (state.tab === 'songs') {
    renderRows($('tracks'), tracks.map((t, i) => {
      const label = lyricHits.has(t.id) && !lyricHits.has(tracks[i - 1]?.id) ? '<li class="list-label">Dans les paroles</li>' : '';
      return label + rowHTML(t, i, { animate, mode: state.selecting ? 'select' : 'list' });
    }));
    $('summary').textContent = state.selecting ? `${state.selected.size} sur ${tracks.length}` : summary(tracks);
    $('tracks-actions').hidden = tracks.length === 0 || state.selecting;
    $('select-actions').hidden = !state.selecting;
    $('playlists-section').hidden = !!state.search.trim() || state.selecting;
    // Pendant une recherche, playlists et humeurs sont cachées : inutile de les recalculer.
    if (!state.search.trim()) renderCarousel();
    renderRecent();
    renderMoods();
  } else if (state.tab === 'artists') {
    const artists = groupBy(tracks, 'artist');
    resultCount = artists.length;
    $('artists').innerHTML = artists.map((a, i) => `<li class="row artist${animate ? ' enter' : ''}" style="--delay:${Math.min(i, 12) * 35}ms">
      <button class="main" data-artist="${esc(a.name)}">
        ${artHTML(a.tracks.find((t) => t.thumb) || a.tracks[0])}
        <span class="text"><span class="t">${esc(a.name)}</span><span class="a">${summary(a.tracks)}</span></span>
        <span class="chev"><svg viewBox="0 0 24 24" class="i sm"><path d="M9 5l7 7-7 7"/></svg></span>
      </button>
    </li>`).join('');
  } else {
    const albums = groupBy(tracks, 'album');
    resultCount = albums.length;
    $('albums').innerHTML = albums.length
      ? albums.map((a) => {
        const cover = a.tracks.find((t) => t.art) || a.tracks[0];
        return `<button class="album press" data-album="${esc(a.name)}">
          ${artHTML(cover, { full: true })}
          <span class="name">${esc(a.name)}</span>
          <span class="meta">${esc(mostCommon(a.tracks.map((t) => t.artist)))}</span>
        </button>`;
      }).join('')
      : '<p class="muted small" style="grid-column: 1 / -1; text-align: center">Aucun album dans les tags de tes fichiers.</p>';
  }
  $('no-results').hidden = !hasAny || !state.search.trim() || resultCount > 0;
  if (state.tab !== 'songs') {
    $('recent-section').hidden = true;
    $('moods-section').hidden = true;
  }
  renderSelectBar();
  renderAZ();
}

function renderRecent() {
  const recent = state.search.trim() || state.selecting ? [] : recentlyPlayed([...state.tracks.values()], 12);
  $('recent-section').hidden = recent.length < 2;
  $('recent').innerHTML = recent.map((t, i) => `<button class="recent-card press" data-recent="${i}" style="--glow:${tintOf(t)}">
    ${artHTML(t, { full: true })}
    <span class="name">${esc(t.title)}</span><span class="meta">${esc(t.artist)}</span>
  </button>`).join('');
}

/** Pochette d'une playlist : sa photo si elle en a une, sinon une mosaïque. */
function playlistCoverHTML(p, tracks) {
  if (p?.cover?.art) return `<span class="mosaic single">${artHTML({ id: `pl-${p.id}-${p.cover.v}`, art: p.cover.art, thumb: p.cover.thumb, tint: p.cover.tint }, { full: true })}</span>`;
  return mosaicHTML(tracks);
}

const smartIcon = {
  top: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>',
  recent: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  never: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9l5 3-5 3z" class="fill"/>',
  forgotten: '<path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.6 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/>',
};

function currentRecap() {
  const now = new Date();
  const thisMonth = recap(stats, monthKey(now));
  if (thisMonth) return thisMonth;
  // Début de mois : le récap du mois précédent reste affiché une semaine.
  if (now.getDate() <= 7) return recap(stats, monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
  return null;
}

function mosaicHTML(tracks) {
  if (tracks.length >= 4) return `<span class="mosaic">${tracks.slice(0, 4).map((t) => artHTML(t)).join('')}</span>`;
  return `<span class="mosaic single">${artHTML(tracks[0], { full: true })}</span>`;
}

function renderCarousel() {
  const cards = [];
  const monthly = currentRecap();
  if (monthly) {
    const top = state.tracks.get(monthly.tracks[0]?.id);
    cards.push(`<button class="card recap-card press" data-recap="${monthly.key}" style="--glow:${tintOf(top)}">
      <span class="mosaic single">${artHTML(top, { full: true })}<span class="recap-badge"><b>${monthly.minutes}</b> min</span></span>
      <span class="name">Ton récap</span><span class="meta">${monthName(monthly.key)}</span>
    </button>`);
  }
  const mix = todayMix();
  if (mix.length) {
    const now = new Date();
    cards.push(`<button class="card mix-card press" data-mix style="--glow:${tintOf(mix[0])}">
      ${mosaicHTML(mix)}<span class="recap-badge mix-badge"><b>${now.getDate()}</b> ${now.toLocaleDateString('fr', { month: 'short' })}</span>
      <span class="name">Mix du jour</span><span class="meta">${summary(mix)}</span>
    </button>`);
  }
  const favs = favorites();
  if (favs.length) {
    cards.push(`<button class="card fav press" data-favorites>
      <span class="mosaic">${heartSVG('i')}</span>
      <span class="name">Favoris</span><span class="meta">${summary(favs)}</span>
    </button>`);
  }
  const all = [...state.tracks.values()];
  for (const smart of SMART) {
    const tracks = smartTracks(smart.id, all);
    if (!tracks.length || (smart.id === 'never' && tracks.length === all.length)) continue;
    cards.push(`<button class="card smart press" data-smart="${smart.id}" style="--glow:${tintOf(tracks[0])}">
      ${mosaicHTML(tracks)}<span class="smart-badge"><svg viewBox="0 0 24 24" class="i sm">${smartIcon[smart.id]}</svg></span>
      <span class="name">${smart.name}</span><span class="meta">${summary(tracks)}</span>
    </button>`);
  }
  const rated = topRated(all);
  if (rated.length) {
    cards.push(`<button class="card smart press" data-rated style="--glow:${tintOf(rated[0])}">
      ${mosaicHTML(rated)}<span class="smart-badge"><svg viewBox="0 0 24 24" class="i sm">${smartIcon.top}</svg></span>
      <span class="name">Les mieux notés</span><span class="meta">${summary(rated)}</span>
    </button>`);
  }
  for (const p of [...state.playlists].sort((a, b) => b.createdAt - a.createdAt)) {
    const tracks = playlistTracks(p);
    cards.push(`<button class="card press" data-playlist="${p.id}" style="--glow:${p.cover?.tint ? `rgb(${p.cover.tint.join(',')})` : tintOf(tracks[0])}">
      ${playlistCoverHTML(p, tracks)}
      <span class="name">${esc(p.name)}</span><span class="meta">${summary(tracks)}</span>
    </button>`);
  }
  cards.push(`<button class="card new press" data-action="new-playlist">
    <span class="mosaic"><svg viewBox="0 0 24 24" class="i"><path d="M12 5v14M5 12h14"/></svg></span>
    <span class="name">Nouvelle playlist</span><span class="meta">Créer</span>
  </button>`);
  $('carousel').innerHTML = cards.join('');
}

/** Mix du jour : choisi une fois par jour et gardé, même si les écoutes changent dans la journée. */
function todayMix() {
  const day = dayKey();
  let cache = null;
  try {
    cache = JSON.parse(localStorage.getItem('uhqsic.daily') || 'null');
  } catch {
    cache = null;
  }
  if (cache?.day !== day || !cache.ids?.length) {
    cache = { day, ids: dailyMix([...state.tracks.values()]).map((t) => t.id) };
    if (cache.ids.length) {
      try { localStorage.setItem('uhqsic.daily', JSON.stringify(cache)); } catch { /* sans conséquence */ }
    }
  }
  return cache.ids.map((id) => state.tracks.get(id)).filter(Boolean);
}

function renderMoods() {
  const used = state.search.trim() || state.selecting ? [] : usedMoods([...state.tracks.values()]);
  $('moods-section').hidden = used.length === 0;
  $('moods').innerHTML = used.map((m) => `<button class="mood-chip press" data-mood="${m.id}" style="--h:${m.hue}"><span class="dot"></span>${m.name}<span class="count">${m.count}</span></button>`).join('');
}

const moodById = (id) => MOODS.find((m) => m.id === id);

function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  const index = ['songs', 'artists', 'albums'].indexOf(tab);
  $('tab-pill').style.transform = `translateX(${index * 100}%)`;
  for (const button of document.querySelectorAll('.tab')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  renderLibrary();
  const view = $(`view-${tab}`);
  view.classList.remove('entering');
  void view.offsetWidth;
  view.classList.add('entering');
}

/** Grand titre qui s'efface au défilement, barre compacte floutée qui prend le relais. */
function setupCollapsingHeader() {
  const library = $('library');
  const title = $('big-title');
  const bar = $('compact-bar');
  let ticking = false;
  library.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = Math.max(0, library.scrollTop);
      const p = Math.min(y / 52, 1);
      title.style.opacity = String(1 - p);
      title.style.transform = `scale(${1 - p * 0.06}) translateY(${-p * 6}px)`;
      bar.classList.toggle('shown', y > 46);
    });
  }, { passive: true });
}

// MARK: Collections (playlist, favoris, artiste, album)

function collectionData(c) {
  if (!c) return null;
  if (c.kind === 'playlist') {
    const p = playlistById(c.key);
    return p && { title: p.name, tracks: playlistTracks(p), editable: true, playlist: p };
  }
  if (c.kind === 'favorites') return { title: 'Favoris', tracks: favorites() };
  if (c.kind === 'mix') return { title: 'Mix du jour', tracks: todayMix() };
  if (c.kind === 'rated') return { title: 'Les mieux notés', tracks: topRated(sortedTracks()) };
  if (c.kind === 'mood') return { title: moodById(c.key)?.name || '', tracks: moodTracks(c.key, sortedTracks()) };
  if (c.kind === 'journal') {
    const days = historyByDay(history.slice(-400), (id) => state.tracks.has(id));
    return { title: 'Journal d\'écoute', days, tracks: days.flatMap((d) => d.entries.map((e) => state.tracks.get(e.id))) };
  }
  if (c.kind === 'smart') return { title: SMART.find((x) => x.id === c.key)?.name || '', tracks: smartTracks(c.key, sortedTracks()) };
  const key = normalize(c.key);
  const tracks = sortedTracks().filter((t) => normalize(t[c.kind]) === key);
  if (c.kind === 'artist') tracks.sort((a, b) => collator.compare(a.album || '￿', b.album || '￿') || byTitle(a, b));
  return { title: c.key, tracks };
}

function openCollection(collection) {
  state.collection = collection;
  state.editing = false;
  renderCollection();
  const page = $('collection');
  page.hidden = false;
  page.scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    page.classList.add('shown');
    document.body.classList.add('subpage-open');
  }));
}

function closeCollection() {
  const page = $('collection');
  page.classList.remove('shown');
  document.body.classList.remove('subpage-open');
  state.collection = null;
  state.editing = false;
  setTimeout(() => { if (!state.collection) page.hidden = true; }, 460);
  renderLibrary();
}

function renderCollection() {
  const data = collectionData(state.collection);
  if (!data) return;
  const { tracks, editable } = data;
  const kind = state.collection.kind;
  const cover = $('col-cover');
  cover.classList.toggle('round', kind === 'artist');
  if (kind === 'favorites') cover.innerHTML = `<span class="fav-cover">${heartSVG('i')}</span>`;
  else if (kind === 'mood') cover.innerHTML = `<span class="fav-cover mood-cover" style="--h:${moodById(state.collection.key)?.hue || 200}"><svg viewBox="0 0 24 24" class="i"><path d="M3 12c2.5-4 4.5-4 7 0s4.5 4 7 0 3.5-3 4-2"/></svg></span>`;
  else if (kind === 'journal') cover.innerHTML = `<span class="fav-cover journal-cover"><svg viewBox="0 0 24 24" class="i"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></span>`;
  else if ((kind === 'mix' || kind === 'rated' || kind === 'smart') && tracks.length >= 4) cover.innerHTML = `<span class="mosaic">${tracks.slice(0, 4).map((t) => artHTML(t)).join('')}</span>`;
  else if (kind === 'playlist' && data.playlist.cover?.art) cover.innerHTML = playlistCoverHTML(data.playlist, tracks).replace('mosaic single', 'mosaic-full');
  else if (kind === 'playlist' && tracks.length >= 4) cover.innerHTML = `<span class="mosaic">${tracks.slice(0, 4).map((t) => artHTML(t)).join('')}</span>`;
  else cover.innerHTML = artHTML(tracks.find((t) => t.art) || tracks[0], { full: true });
  const moodTint = kind === 'mood' ? `hsl(${moodById(state.collection.key)?.hue || 200} 75% 52%)` : null;
  $('col-backdrop').style.setProperty('--col-tint', kind === 'favorites' ? '#E0245E' : moodTint || (kind === 'journal' ? 'var(--accent)' : tintOf(tracks.find((t) => t.tint))));
  $('col-name').textContent = data.title;
  $('col-summary').textContent = kind === 'journal' && !tracks.length ? 'Chaque morceau écouté y apparaîtra.' : kind === 'journal' ? `${tracks.length} écoute${tracks.length > 1 ? 's' : ''}` : summary(tracks);
  $('col-radio').hidden = kind !== 'artist' || tracks.length === 0;
  $('col-actions').hidden = tracks.length === 0 || state.editing;
  $('col-add-empty').hidden = !editable || tracks.length > 0;
  $('edit-btn').hidden = !editable || tracks.length === 0;
  $('col-menu-btn').hidden = !(editable || kind === 'artist' || kind === 'album');
  $('col-menu-btn').setAttribute('aria-label', kind === 'playlist' ? 'Options de la playlist' : kind === 'artist' ? 'Options de l\'artiste' : 'Options de l\'album');
  $('edit-btn').textContent = state.editing ? 'OK' : 'Modifier';
  $('edit-btn').style.fontWeight = state.editing ? '650' : '';
  if (kind === 'journal') {
    let i = 0;
    const clock = (at) => new Date(at).toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' });
    $('col-tracks').innerHTML = data.days.map((d) => `<li class="list-label">${esc(d.label)}</li>${d.entries.map((e) => rowHTML(state.tracks.get(e.id), i++, { time: clock(e.at) })).join('')}`).join('');
    return;
  }
  $('col-tracks').innerHTML = tracks.map((t, i) => rowHTML(t, i, { mode: state.editing ? 'edit' : 'list' })).join('');
}

// MARK: Lecture

function playList(tracks, index, shuffled) {
  if (!tracks.length) return;
  queue.load(tracks.map((t) => t.id), index, shuffled ?? queue.isShuffled);
  persistModes();
  pendingDirection = 0;
  loadCurrent(true);
}

// Le fichier n'est lu dans IndexedDB qu'au moment de le jouer : le démarrage reste
// instantané quelle que soit la taille de la bibliothèque.
let loadToken = 0;
async function loadCurrent(autoplay) {
  const token = ++loadToken;
  // Les morceaux supprimés sont sautés.
  let guard = queue.items.length;
  while (queue.current && !state.tracks.has(queue.current) && guard-- > 0) {
    if (!queue.skipForward()) break;
  }
  const id = queue.current;
  if (!id || !state.tracks.has(id)) return stop();

  currentId = id;
  setPlaying(autoplay);
  renderNowPlaying();
  updateMediaSession();
  saveSession();

  let blob;
  try {
    blob = await db.file(id);
  } catch {
    blob = null;
  }
  if (token !== loadToken) return; // un autre morceau a été demandé entre-temps
  if (!blob) {
    toast('Fichier introuvable, morceau suivant');
    if (queue.items.length > 1 && queue.skipForward()) return loadCurrent(autoplay);
    return stop();
  }
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  audio.src = currentUrl;
  audio.playbackRate = audio.defaultPlaybackRate = speed;
  pendingResume = id;
  if (autoplay) audio.play().catch(() => setPlaying(false));
}

// Écoute réelle : temps écouté (statistiques), une écoute comptée après 30 s,
// et position gardée pour les morceaux longs (mixes, podcasts).
const LONG_TRACK = 600;
let listen = { id: null, last: 0, listened: 0, counted: false };
let pendingResume = null;
let sessionResume = null; // { id, time } : position retrouvée au lancement
let statsDirty = 0;
let lastResumeSave = 0;

function trackListening() {
  const track = state.tracks.get(currentId);
  if (!track || audio.paused || audio.src === SILENCE) return;
  const t = audio.currentTime;
  if (listen.id !== track.id) {
    listen = { id: track.id, last: t, listened: 0, counted: false };
    return;
  }
  const delta = t - listen.last;
  listen.last = t;
  if (!(delta > 0 && delta < 3)) return; // saut dans le morceau : ce n'est pas de l'écoute
  const real = delta / (audio.playbackRate || 1);
  listen.listened += real;
  addListening(stats, track, real);
  statsDirty += real;
  if (statsDirty > 15) flushStats();
  if (!listen.counted && listen.listened >= Math.min(PLAY_THRESHOLD, (track.duration || 60) * 0.5)) {
    listen.counted = true;
    // Chaque appareil compte ses écoutes : additionnées sans doublon entre appareils liés.
    track.playsBy = { ...(track.playsBy || (track.plays ? { [ME]: track.plays } : {})) };
    track.playsBy[ME] = (track.playsBy[ME] || 0) + 1;
    track.plays = Object.values(track.playsBy).reduce((a, b) => a + b, 0);
    track.lastPlayed = Date.now();
    addHistory(history, track.id);
    saveTrack(track, false).catch(() => {});
    sync?.countsChanged(track);
    renderLibraryCounts(track);
  }
  if (track.duration > LONG_TRACK && Date.now() - lastResumeSave > 10000) {
    lastResumeSave = Date.now();
    track.resumeAt = t;
    saveTrack(track, false).catch(() => {});
  }
}

function flushStats() {
  statsDirty = 0;
  saveStats(stats);
}

/** Met à jour le compteur d'une ligne et « Écoutés récemment » sans tout redessiner. */
function renderLibraryCounts(track) {
  for (const row of document.querySelectorAll(`.row[data-id="${track.id}"] .a`)) {
    row.querySelector('.plays')?.remove();
    row.insertAdjacentHTML('beforeend', `<span class="plays">, ${track.plays} écoute${track.plays > 1 ? 's' : ''}</span>`);
  }
  if (state.tab === 'songs' && !state.selecting) {
    renderRecent();
    // Les playlists automatiques changent avec les écoutes ; la rangée garde sa position.
    const carousel = $('carousel');
    const left = carousel.scrollLeft;
    renderCarousel();
    carousel.scrollLeft = left;
  }
}

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
let speed = Number(localStorage.getItem('uhqsic.speed')) || 1;
function renderSpeed() {
  $('speed-btn').textContent = `${String(speed).replace('.', ',')}×`;
  $('speed-btn').classList.toggle('on', speed !== 1);
  $('speed-btn').setAttribute('aria-label', `Vitesse de lecture : ${String(speed).replace('.', ',')} fois`);
}
function cycleSpeed() {
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  localStorage.setItem('uhqsic.speed', String(speed));
  audio.playbackRate = audio.defaultPlaybackRate = speed;
  renderSpeed();
  updatePositionState();
}

// Safari iOS n'autorise la lecture que pendant un geste. Au premier toucher, l'élément audio
// joue un court silence : il est alors « débloqué » et pourra jouer ensuite sans geste
// (après la lecture du fichier dans IndexedDB, ou au morceau suivant écran verrouillé).
const SILENCE = (() => {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (o, t) => [...t].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
})();
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const retry = (e) => { if (e?.name === 'NotAllowedError') audioUnlocked = false; };
  if (audio.getAttribute('src')) {
    // Un morceau est déjà chargé (session reprise) : un play/pause immédiat suffit.
    audio.play().then(() => { if (!document.body.classList.contains('playing')) pauseOnPurpose(); }).catch(retry);
    return;
  }
  audio.src = SILENCE;
  audio.play().then(() => { if (audio.src === SILENCE) audio.pause(); }).catch(retry);
}

function stop() {
  pauseOnPurpose();
  audio.removeAttribute('src');
  audio.load();
  queue.clear();
  currentId = null;
  setPlaying(false);
  saveSession();
  renderNowPlaying();
  if (navigator.mediaSession) navigator.mediaSession.metadata = null;
}

function setPlaying(on) {
  document.body.classList.toggle('playing', on);
  const label = on ? 'Pause' : 'Lecture';
  $('toggle').setAttribute('aria-label', label);
  $('mini-toggle').setAttribute('aria-label', label);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
}

function togglePlay() {
  if (!currentId) return;
  if (audio.paused) audio.play().catch(() => {});
  else pauseOnPurpose();
}

// MARK: Interruptions d'iOS (Siri, appel, alarme…) : la musique reprend toute seule ensuite

const resumer = createResumer({ isPaused: () => audio.paused, play: () => audio.play() });

/** Pause voulue (bouton, écran verrouillé, AirPods, minuterie) : jamais relancée automatiquement. */
function pauseOnPurpose() {
  resumer.pausing();
  audio.pause();
}

function setupAudioSession() {
  const session = navigator.audioSession;
  if (!session) return;
  // « playback » : un lecteur de musique, qui continue écran verrouillé et ignore le mode silencieux.
  try {
    session.type = 'playback';
  } catch {
    // Type refusé : le réglage par défaut de Safari reste valable.
  }
  const onChange = () => resumer.session(session.state);
  if (session.addEventListener) session.addEventListener('statechange', onChange);
  else session.onstatechange = onChange;
}

function next() {
  if (queue.isEmpty) return;
  const keep = queue.skipForward() && !audio.paused;
  pendingDirection = 1;
  loadCurrent(keep);
}

/** `force` : depuis un balayage, on change toujours de morceau (pas de retour au début). */
function previous(force = false) {
  if (queue.isEmpty) return;
  if (!force && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const wasPlaying = !audio.paused;
  queue.skipBackward();
  pendingDirection = -1;
  loadCurrent(wasPlaying);
}

function persistModes() {
  localStorage.setItem('uhqsic.repeat', String(queue.repeatMode));
  localStorage.setItem('uhqsic.shuffle', queue.isShuffled ? '1' : '0');
}

let lastSessionSave = 0;
function saveSession() {
  lastSessionSave = Date.now();
  try {
    const time = currentId && audio.src !== SILENCE && Number.isFinite(audio.currentTime) ? Math.round(audio.currentTime * 10) / 10 : 0;
    localStorage.setItem('uhqsic.session', JSON.stringify({ items: queue.items, current: currentId, time }));
  } catch {
    // Stockage plein : sans conséquence, on perd juste la reprise.
  }
}

function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem('uhqsic.session') || 'null');
    const items = (saved?.items || []).filter((id) => state.tracks.has(id));
    if (!items.length) return;
    const start = Math.max(0, items.indexOf(saved.current));
    queue.load(items, start, queue.isShuffled);
    // Le morceau reprend à la seconde où on l'avait laissé.
    if (saved.time > 2 && saved.current === items[start]) sessionResume = { id: saved.current, time: saved.time };
    loadCurrent(false);
  } catch {
    // Session illisible : on démarre à vide.
  }
}

audio.addEventListener('play', () => {
  if (audio.src === SILENCE) return;
  setPlaying(true);
  resumer.played();
});
audio.addEventListener('pause', () => {
  if (audio.src === SILENCE) return;
  setPlaying(false);
  updatePositionState();
  saveSession();
});
audio.addEventListener('loadedmetadata', () => {
  const track = state.tracks.get(currentId);
  if (audio.src === SILENCE || !track) return;
  // Durée inconnue à l'import (format inhabituel) : on garde celle du lecteur.
  if (Number.isFinite(audio.duration) && (!track.duration || Math.abs(track.duration - audio.duration) > 2)) {
    track.duration = audio.duration;
    saveTrack(track, false).catch(() => {});
  }
  if (sessionResume?.id === track.id) {
    const { time } = sessionResume;
    sessionResume = null;
    pendingResume = null;
    if (time < audio.duration - 2) audio.currentTime = time;
  }
  if (pendingResume === track.id) {
    pendingResume = null;
    if (track.duration > LONG_TRACK && track.resumeAt > 30 && track.resumeAt < audio.duration - 30) {
      audio.currentTime = track.resumeAt;
      toast(`Reprise à ${fmt(track.resumeAt)}`);
    }
  }
  updatePositionState();
  updateProgress();
});
audio.addEventListener('timeupdate', () => {
  resumer.heard();
  if (!audio.paused && Date.now() - lastSessionSave > 5000) saveSession();
  updateProgress();
  trackListening();
  syncLyrics();
});
audio.addEventListener('seeked', () => {
  updatePositionState();
  userScrolledAt = 0;
  syncLyrics(true);
  listen.last = audio.currentTime;
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    resumer.resume();
    return;
  }
  flushStats();
  saveSession();
  flushDeletion();
});
window.addEventListener('pagehide', () => {
  flushStats();
  saveSession();
  flushDeletion();
});
audio.addEventListener('ended', () => {
  if (audio.src === SILENCE) return;
  resumer.pausing();
  const finished = state.tracks.get(currentId);
  if (finished?.resumeAt) {
    finished.resumeAt = 0;
    saveTrack(finished, false).catch(() => {});
  }
  if (sleep.mode === 'end') {
    setSleep('off');
    toast('Bonne nuit');
    return;
  }
  if (queue.repeatMode === RepeatMode.one) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  pendingDirection = 1;
  loadCurrent(queue.advanceAfterFinish());
});
audio.addEventListener('error', () => {
  if (!currentId || audio.src === SILENCE || !audio.getAttribute('src')) return;
  toast('Lecture impossible, morceau suivant');
  if (queue.items.length > 1 && queue.skipForward()) loadCurrent(true);
});

// MARK: Écran verrouillé et Centre de contrôle

const artDataUrls = new Map();
function readAsDataURL(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const track = state.tracks.get(currentId);
  if (!track) return;
  const base = { title: track.title, artist: track.artist, album: track.album || '' };
  navigator.mediaSession.metadata = new MediaMetadata(base);
  if (!track.art) return;
  if (!artDataUrls.has(track.id)) artDataUrls.set(track.id, await readAsDataURL(track.art));
  const art = artDataUrls.get(track.id);
  if (art && track.id === currentId) {
    navigator.mediaSession.metadata = new MediaMetadata({ ...base, artwork: [{ src: art, sizes: '640x640', type: 'image/jpeg' }] });
  }
}

function updatePositionState() {
  if (!navigator.mediaSession?.setPositionState || !Number.isFinite(audio.duration) || !audio.duration) return;
  try {
    navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: speed, position: Math.min(audio.currentTime, audio.duration) });
  } catch {
    // Valeurs transitoires pendant un changement de morceau.
  }
}

function registerMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => audio.play().catch(() => {}),
    pause: () => pauseOnPurpose(),
    previoustrack: () => previous(),
    nexttrack: next,
    seekto: (d) => { audio.currentTime = d.seekTime; updatePositionState(); },
    // Sans sauts de ±10 s, l'écran verrouillé garde « précédent / suivant ».
    seekbackward: null,
    seekforward: null,
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* action non prise en charge */ }
  }
}

// MARK: Lecteur

let renderedId = null;
function renderNowPlaying() {
  const track = state.tracks.get(currentId);
  $('mini').hidden = !track;
  document.body.classList.toggle('has-track', !!track);
  if (!track) {
    closePlayer();
    renderedId = null;
    renderLibrary();
    if (state.collection) renderCollection();
    return;
  }
  const changed = renderedId !== null && renderedId !== track.id;
  renderedId = track.id;

  setArt($('mini-art'), track, false);
  setArt($('player-art'), track, true);
  $('mini-title').textContent = track.title;
  $('mini-artist').textContent = track.artist;
  $('player-title').textContent = track.title;
  $('player-artist').textContent = track.artist;

  const pal = playerPalette(track.tint);
  const player = $('player');
  player.style.setProperty('--c1', pal.glow);
  player.style.setProperty('--c2', pal.deep);
  player.style.setProperty('--c3', pal.base);
  player.style.setProperty('--c4', pal.shifted);
  document.documentElement.style.setProperty('--label', pal.label);
  $('stage').style.setProperty('--aura', tintOf(track));
  setAmbient(track);
  renderFav(track);
  renderLyrics(track);

  if (changed) {
    slideIn($('titles'), pendingDirection);
    slideIn($('mini-text'), pendingDirection, 18);
    if (!swipeInFlight) slideIn($('turntable-move'), pendingDirection, 60);
  }
  pendingDirection = 0;

  renderModes();
  renderLibraryHighlight();
  updateProgress();
}

// Fond tiré de la pochette : une version de 24 px, agrandie, donc naturellement floue.
const tinyArt = new Map();
async function tinyArtUrl(track) {
  if (!track?.thumb) return null;
  if (!tinyArt.has(track.id)) {
    try {
      const bitmap = await createImageBitmap(track.thumb);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 24;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, 24, 24);
      bitmap.close?.();
      tinyArt.set(track.id, canvas.toDataURL('image/png'));
    } catch {
      tinyArt.set(track.id, null);
    }
  }
  return tinyArt.get(track.id);
}

let ambientLayer = 'a';
async function setAmbient(track) {
  const url = await tinyArtUrl(track);
  if (track.id !== currentId) return;
  const current = $(`amb-${ambientLayer}`);
  if (!url) {
    $('amb-a').classList.remove('on');
    $('amb-b').classList.remove('on');
    return;
  }
  if (current.dataset.src === url && current.classList.contains('on')) return;
  ambientLayer = ambientLayer === 'a' ? 'b' : 'a';
  const incoming = $(`amb-${ambientLayer}`);
  incoming.dataset.src = url;
  for (const layer of incoming.querySelectorAll('.amb')) layer.style.backgroundImage = `url('${url}')`;
  incoming.classList.add('on');
  current.classList.remove('on');
}

function renderFav(track) {
  const button = $('fav-btn');
  button.classList.toggle('on', !!track.fav);
  button.setAttribute('aria-pressed', String(!!track.fav));
  button.setAttribute('aria-label', track.fav ? 'Retirer des favoris' : 'Ajouter aux favoris');
}

async function toggleFav(track = state.tracks.get(currentId)) {
  if (!track) return;
  track.fav = !track.fav;
  await saveTrack(track);
  if (track.id === currentId) {
    renderFav(track);
    const button = $('fav-btn');
    if (track.fav) {
      haptic();
      button.classList.remove('pop');
      void button.offsetWidth;
      button.classList.add('pop');
      burst(button);
    }
  }
  toast(track.fav ? 'Ajouté aux favoris' : 'Retiré des favoris');
  renderLibrary();
  if (state.collection) renderCollection();
}

function renderModes() {
  const shuffle = $('shuffle');
  shuffle.classList.toggle('on', queue.isShuffled);
  shuffle.setAttribute('aria-pressed', String(queue.isShuffled));
  const repeat = $('repeat');
  repeat.classList.toggle('on', queue.repeatMode !== RepeatMode.off);
  repeat.classList.toggle('one', queue.repeatMode === RepeatMode.one);
  repeat.setAttribute('aria-label', ['Répéter : désactivé', 'Répéter : toute la file', 'Répéter : ce morceau'][queue.repeatMode]);

  const upNext = state.tracks.get(queue.upNext);
  const button = $('up-next');
  button.classList.toggle('hidden-content', !upNext);
  button.disabled = !upNext;
  if (upNext) {
    setArt($('up-next-art'), upNext, false);
    $('up-next-title').textContent = upNext.title;
    button.setAttribute('aria-label', `À suivre : ${upNext.title}, ${upNext.artist}`);
  }
}

/** Met à jour l'état « en cours » des lignes sans tout redessiner (pas d'animation d'entrée). */
function renderLibraryHighlight() {
  for (const list of [$('tracks'), $('col-tracks')]) {
    for (const row of list.querySelectorAll('.row')) {
      const isCurrent = row.dataset.id === currentId;
      if (row.classList.contains('current') === isCurrent) continue;
      const track = state.tracks.get(row.dataset.id);
      if (!track || row.querySelector('.handle')) continue;
      row.classList.toggle('current', isCurrent);
      row.querySelector('.end').innerHTML = isCurrent ? eqHTML : `<span>${fmt(track.duration)}</span>`;
    }
  }
}

let scrubbing = false;
function updateProgress() {
  const duration = Number.isFinite(audio.duration) && audio.duration ? audio.duration : state.tracks.get(currentId)?.duration || 0;
  const time = scrubbing ? Number($('scrub').value) : audio.currentTime || 0;
  const fraction = duration ? Math.min(time / duration, 1) : 0;
  $('mini-fill').style.transform = `scaleX(${fraction})`;
  $('scrub-fill').style.transform = `scaleX(${fraction})`;
  if (!scrubbing) {
    $('scrub').max = String(duration || 1);
    $('scrub').value = String(time);
  } else {
    $('scrub-bubble').textContent = fmt(time);
    $('scrub-bubble').style.left = `${fraction * 100}%`;
  }
  $('elapsed').textContent = fmt(time);
  $('remaining').textContent = `-${fmt(duration - time)}`;
}

// MARK: Paroles (cherchées sur LRCLIB, synchronisées quand c'est possible)

let showLyrics = false;
let lyricsLines = [];
let activeLine = -1;
let userScrolledAt = 0;
let lyricsSearching = null;
let calibrating = false; // « Caler » : toucher la ligne au moment où elle est chantée

const lyricsOffset = () => state.tracks.get(currentId)?.lyricsOffset || 0;
const fmtOffset = (o) => `${o > 0 ? '+' : o < 0 ? '−' : ''}${Math.abs(o).toLocaleString('fr', { maximumFractionDigits: 1 })} s`;

/** Paroles d'une autre version que le fichier (durées différentes) : sans doute décalées. */
const lyricsMismatch = (track) => track.lyricsLength > 0 && track.duration > 0 && Math.abs(track.lyricsLength - track.duration) > 4 && !track.lyricsOffset;

function lyricToolsHTML(track) {
  if (calibrating !== track.id) {
    return `<button class="lrc-tool press${lyricsMismatch(track) ? ' warn' : ''}" data-calib>${lyricsMismatch(track) ? 'Autre version : paroles décalées ?' : 'Paroles décalées ?'}</button>`;
  }
  return `<div class="lrc-calib">
    <p>Touche la ligne au moment où elle est chantée.</p>
    <div class="lrc-calib-row">
      <button class="foot-pill press" data-shift="-0.5" aria-label="Paroles plus tôt">−0,5 s</button>
      <span class="lrc-offset" aria-live="polite">${track.lyricsOffset ? fmtOffset(track.lyricsOffset) : 'Aucun décalage'}</span>
      <button class="foot-pill press" data-shift="0.5" aria-label="Paroles plus tard">+0,5 s</button>
      <button class="foot-pill on press" data-calib-done>OK</button>
    </div>
  </div>`;
}

function renderLyricTools(track = state.tracks.get(currentId)) {
  const tools = $('lyrics').querySelector('.lrc-tools');
  if (tools && track) tools.innerHTML = lyricToolsHTML(track);
  $('lyrics').querySelector('.lrc')?.classList.toggle('calibrating', calibrating === track?.id);
}

let offsetSaveTimer = null;
function setLyricsOffset(track, offset) {
  track.lyricsOffset = Math.round(offset * 10) / 10;
  renderLyricTools(track);
  syncLyrics(true);
  clearTimeout(offsetSaveTimer);
  offsetSaveTimer = setTimeout(() => saveTrack(track).catch(() => {}), 600);
}

const lyricsFooter = (track) => `<div class="lyrics-foot">
  <button class="foot-pill press" data-edit-lyrics>Modifier</button>
  <button class="foot-pill press" data-pick-lyrics>Pas les bonnes ?</button>
  ${track.syncedLyrics || track.lyrics ? `<span>${esc(track.lyricsSource || 'LRCLIB')}</span>` : ''}
</div>`;

const geniusURL = (track) => {
  const id = identity(track);
  return `https://genius.com/search?q=${encodeURIComponent(`${id.artist} ${id.title}`.trim())}`;
};

function renderLyrics(track = state.tracks.get(currentId)) {
  const box = $('lyrics');
  $('player').classList.toggle('show-lyrics', showLyrics);
  $('lyrics-btn').setAttribute('aria-pressed', String(showLyrics));
  $('lyrics-btn').classList.toggle('on', showLyrics);
  lyricsLines = [];
  activeLine = -1;
  if (!track) return;

  if (track.syncedLyrics) {
    lyricsLines = parseLRC(track.syncedLyrics);
    box.innerHTML = `<div class="lrc${calibrating === track.id ? ' calibrating' : ''}">${lyricsLines.map((l, i) => `<button class="lrc-line" data-line="${i}">${esc(l.text) || '<span class="lrc-pause" aria-label="Pause musicale">•••</span>'}</button>`).join('')}</div>${lyricsFooter(track)}<div class="lrc-tools">${lyricToolsHTML(track)}</div>`;
    syncLyrics(true);
  } else if (track.lyrics) {
    box.innerHTML = `<div class="lyrics-text">${esc(track.lyrics).replace(/\n/g, '<br>')}</div>${lyricsFooter(track)}`;
  } else if (track.lyricsInstrumental) {
    box.innerHTML = `<div class="lyrics-empty"><p>Morceau instrumental, il n'y a pas de paroles.</p><button class="foot-pill press" data-edit-lyrics>Ajouter à la main</button></div>`;
  } else if (lyricsSearching === track.id) {
    box.innerHTML = `<div class="lyrics-empty"><div class="searching" aria-hidden="true"><span class="vinyl-face"></span></div><p>Recherche des paroles…</p></div>`;
  } else if (track.lyricsChecked || !prefs.autoLyrics) {
    box.innerHTML = `<div class="lyrics-empty">
      <p>${track.lyricsChecked ? `Paroles introuvables pour « ${esc(track.title)} ». Vérifie le titre et l'artiste dans Modifier les infos, ou ajoute-les toi-même.` : 'Les paroles ne sont pas encore cherchées.'}</p>
      <button class="accent-btn press" data-search-lyrics>${track.lyricsChecked ? 'Chercher à nouveau' : 'Chercher les paroles'}</button>
      <div class="lyrics-alt">
        ${track.lyricsChecked ? '<button class="foot-pill press" data-pick-lyrics>Choisir parmi les résultats</button>' : ''}
        <a class="foot-pill press" href="${geniusURL(track)}" target="_blank" rel="noopener">Chercher sur Genius</a>
        <button class="foot-pill press" data-edit-lyrics>Ajouter à la main</button>
      </div>
    </div>`;
  } else {
    // Première ouverture des paroles de ce morceau : on les cherche tout de suite.
    if (showLyrics) searchLyrics(track);
    else box.innerHTML = '';
  }
  if (showLyrics && !track.syncedLyrics) box.scrollTop = 0;
}

async function searchLyrics(track) {
  if (lyricsSearching === track.id) return;
  lyricsSearching = track.id;
  renderLyrics(track);
  try {
    const found = await findLyrics(track);
    if (found) {
      track.lyrics = found.plain;
      track.syncedLyrics = found.synced;
      track.lyricsInstrumental = found.instrumental;
      track.lyricsSource = found.source;
      track.lyricsLength = found.length;
      track.lyricsOffset = 0;
    }
    track.lyricsChecked = Date.now();
    await saveTrack(track);
  } catch {
    toast(navigator.onLine ? 'La recherche de paroles n\'a pas abouti' : 'Pas de connexion pour chercher les paroles');
  }
  lyricsSearching = null;
  if (track.id === currentId) renderLyrics(track);
}

/** Surligne la ligne chantée et la garde au centre, sauf si l'on vient de faire défiler à la main. */
function syncLyrics(force = false) {
  if (!showLyrics || !lyricsLines.length) return;
  const index = currentLine(lyricsLines, (audio.currentTime || 0) - lyricsOffset());
  if (index === activeLine && !force) return;
  const box = $('lyrics');
  box.querySelector('.lrc-line.active')?.classList.remove('active');
  activeLine = index;
  const line = index >= 0 ? box.querySelector(`[data-line="${index}"]`) : null;
  if (!line) return;
  line.classList.add('active');
  if (Date.now() - userScrolledAt > 3500) {
    box.scrollTo({ top: line.offsetTop - box.clientHeight * 0.32, behavior: force || reducedMotion() ? 'auto' : 'smooth' });
  }
}

/** Résultats d'une recherche libre : on choisit soi-même les bonnes paroles. */
function openLyricsPicker(track) {
  const id = identity(track);
  let results = [];
  openSheet(`
    <h3>Choisir les paroles</h3>
    <form class="lyr-search" data-lyr-search>
      <label class="search inline"><svg viewBox="0 0 24 24" class="i sm"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
        <input name="q" type="search" value="${esc(`${id.artist} ${id.title}`.trim())}" aria-label="Rechercher des paroles" autocomplete="off" enterkeyhint="search">
      </label>
    </form>
    <div data-lyr-results><p class="sheet-sub">Recherche…</p></div>
    <div class="sheet-sep"></div>
    <a class="sheet-item" href="${geniusURL(track)}" target="_blank" rel="noopener">${icon.share} Chercher sur Genius (puis copier-coller)</a>
    <button class="sheet-item" data-manual>${icon.pencil} Ajouter à la main</button>
  `, (body) => {
    const box = body.querySelector('[data-lyr-results]');
    const run = async () => {
      box.innerHTML = '<p class="sheet-sub">Recherche…</p>';
      try {
        results = await searchLyricsCandidates(body.querySelector('[name="q"]').value.trim(), track.duration);
      } catch {
        box.innerHTML = '<p class="sheet-sub">Pas de connexion.</p>';
        return;
      }
      box.innerHTML = results.length
        ? results.map((r, i) => `<button class="sheet-item lyr-result" data-pick="${i}"><span class="text"><span class="t">${esc(r.title)}</span><span class="a">${esc(r.artist)}${r.duration ? `, ${fmt(r.duration)}` : ''}${r.sameLength ? ', même durée que ton fichier' : ''}</span></span>${r.synced ? `<span class="sync-badge${r.sameLength ? '' : ' far'}">Synchro</span>` : ''}</button>`).join('')
        : '<p class="sheet-sub">Aucun résultat. Essaie avec moins de mots, ou cherche sur Genius.</p>';
    };
    body.querySelector('[data-lyr-search]').onsubmit = (e) => {
      e.preventDefault();
      body.querySelector('[name="q"]').blur();
      run();
    };
    body.onclick = async (e) => {
      if (e.target.closest('[data-manual]')) return openLyricsEditor(track);
      const pick = e.target.closest('[data-pick]');
      if (!pick) return;
      const { lyrics } = results[Number(pick.dataset.pick)];
      Object.assign(track, { lyrics: lyrics.plain, syncedLyrics: lyrics.synced, lyricsInstrumental: lyrics.instrumental, lyricsSource: lyrics.source, lyricsLength: lyrics.length, lyricsOffset: 0, lyricsChecked: Date.now() });
      await saveTrack(track);
      closeSheet();
      if (track.id === currentId) {
        showLyrics = true;
        renderLyrics(track);
      }
      toast('Paroles choisies');
    };
    run();
  });
}

function toggleLyrics() {
  showLyrics = !showLyrics;
  renderLyrics();
}

function openLyricsEditor(track) {
  let found = null;
  openSheet(`
    <h3>Paroles</h3>
    <p class="sheet-sub">${esc(track.title)}, ${esc(track.artist)}.</p>
    <form data-lyrics-form class="edit-form">
      <label class="field"><span class="field-label">Paroles</span>
        <textarea name="lyrics" rows="10" placeholder="Colle les paroles ici, une ligne par vers">${esc(track.lyrics || '')}</textarea>
      </label>
      <div class="field-actions"><button type="button" class="foot-pill press" data-find>Chercher en ligne</button><a class="foot-pill press" href="${geniusURL(track)}" target="_blank" rel="noopener">Genius</a><span class="muted small" data-find-status></span></div>
      <div class="sheet-footer">
        <button type="button" class="soft-btn" data-cancel>Annuler</button>
        <button type="submit" class="accent-btn">Enregistrer</button>
      </div>
    </form>
  `, (body) => {
    const form = body.querySelector('[data-lyrics-form]');
    const status = body.querySelector('[data-find-status]');
    body.querySelector('[data-cancel]').onclick = closeSheet;
    body.querySelector('[data-find]').onclick = async () => {
      status.textContent = 'Recherche…';
      try {
        found = await findLyrics(track);
        if (found?.plain) {
          form.elements.lyrics.value = found.plain;
          status.textContent = found.synced ? 'Trouvées, avec la synchronisation' : 'Trouvées';
        } else {
          status.textContent = found?.instrumental ? 'Morceau instrumental' : 'Introuvables';
        }
      } catch {
        status.textContent = 'Pas de connexion';
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = form.elements.lyrics.value.replace(/\r/g, '').trim();
      // Paroles modifiées à la main : la synchronisation ne correspond plus.
      const keepsSync = (found?.synced && text === found.plain.trim()) || (!found && text === (track.lyrics || '').trim());
      track.syncedLyrics = keepsSync ? (found?.synced || track.syncedLyrics || '') : '';
      track.lyrics = text;
      track.lyricsInstrumental = false;
      track.lyricsChecked = Date.now();
      track.lyricsSource = keepsSync && found ? found.source : 'Ajoutées à la main';
      if (found && keepsSync) {
        track.lyricsLength = found.length;
        track.lyricsOffset = 0;
      }
      await saveTrack(track);
      closeSheet();
      if (track.id === currentId) renderLyrics(track);
      toast(text ? 'Paroles enregistrées' : 'Paroles supprimées');
    };
  });
}

// MARK: Ouverture et fermeture du lecteur (la pochette vole)

const isPlayerOpen = () => document.body.classList.contains('player-open');

function openPlayer() {
  const track = state.tracks.get(currentId);
  if (!track || isPlayerOpen() || isWide()) return;
  const from = $('mini-art').getBoundingClientRect();
  document.body.classList.add('player-open');
  $('player').setAttribute('aria-hidden', 'false');
  const player = $('player').getBoundingClientRect();
  const art = $('player-art');
  const rect = art.getBoundingClientRect();
  const to = { left: rect.left - player.left, top: rect.top - player.top, width: rect.width, height: rect.height };
  if (reducedMotion()) return;
  art.classList.add('fly-hide');
  flyArt(artHTML(track, { full: true }), from, to, { fromRadius: 12, toRadius: 18 }).then(() => $('player-art').classList.remove('fly-hide'));
}

function closePlayer() {
  if (!isPlayerOpen()) return;
  const track = state.tracks.get(currentId);
  const art = $('player-art');
  const from = art.getBoundingClientRect();
  document.body.classList.remove('player-open');
  $('player').setAttribute('aria-hidden', 'true');
  if (!track || reducedMotion()) return;
  const mini = $('mini-art');
  // La bibliothèque est encore réduite (scale 0.93 depuis le bas) : on vise la place
  // finale de la vignette, une fois la scène revenue à sa taille.
  const r = mini.getBoundingClientRect();
  const s = 0.93;
  const ox = window.innerWidth / 2;
  const oy = window.innerHeight;
  const to = { left: ox + (r.left - ox) / s, top: oy + (r.top - oy) / s + 8, width: r.width / s, height: r.height / s };
  art.classList.add('fly-hide');
  mini.classList.add('fly-hide');
  flyArt(artHTML(track, { full: true }), from, to, { fromRadius: 18, toRadius: 12 }).then(() => {
    $('player-art').classList.remove('fly-hide');
    $('mini-art').classList.remove('fly-hide');
  });
}

// MARK: Gestes du lecteur : glisser vers le bas pour fermer, balayer la pochette pour changer de morceau

let swipeInFlight = false;
function setupPlayerGestures() {
  const player = $('player');
  const turntable = $('turntable');
  const move = $('turntable-move');
  let g = null;

  player.addEventListener('pointerdown', (e) => {
    // Les paroles défilent : on ne ferme pas le lecteur en les faisant glisser.
    if (e.target.closest('button, input, a') || (!isPlayerOpen() && !isWide()) || swipeInFlight || (showLyrics && e.target.closest('#lyrics'))) return;
    // Sur ordinateur, le lecteur reste ouvert : seul le balayage de la pochette sert.
    if (isWide() && !turntable.contains(e.target)) return;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, t: performance.now(), vx: 0, vy: 0, axis: null, onArt: turntable.contains(e.target) };
  });
  player.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const now = performance.now();
    const dt = Math.max(now - g.t, 1);
    g.vx = (e.clientX - g.lastX) / dt;
    g.vy = (e.clientY - g.lastY) / dt;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    g.t = now;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      g.axis = g.onArt && (Math.abs(dx) > Math.abs(dy) || isWide()) ? 'x' : 'y';
      player.setPointerCapture(e.pointerId);
      if (g.axis === 'y') player.style.transition = 'none';
    }
    if (g.axis === 'y') {
      const h = window.innerHeight;
      player.style.transform = `translateY(${dy >= 0 ? dy : -rubberBand(-dy, h)}px)`;
    } else {
      const hasNeighbour = dx < 0 ? queue.upNext : queue.order.length > 1;
      const x = hasNeighbour ? dx : rubberBand(dx, turntable.offsetWidth) * 0.5;
      move.style.transform = `translateX(${x}px) rotate(${x / 40}deg)`;
    }
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const { axis, vx, vy } = g;
    const dx = g.lastX - g.x;
    const dy = g.lastY - g.y;
    g = null;
    if (axis === 'y') {
      player.style.transition = '';
      player.style.transform = '';
      // Fin projetée avec l'élan : un petit geste vif suffit à fermer.
      if (dy + vy * 250 > window.innerHeight * 0.3 && vy > -0.2) closePlayer();
    } else if (axis === 'x') {
      finishSwipe(move, dx, vx, turntable.offsetWidth);
    }
  };
  player.addEventListener('pointerup', end);
  player.addEventListener('pointercancel', end);
}

/** Relâchement d'un balayage : le morceau suivant si l'élan suffit, sinon retour en place. */
function finishSwipe(el, dx, vx, width, onCommit) {
  const projected = dx + vx * 200;
  const from = getComputedStyle(el).transform;
  el.style.transform = '';
  const canNext = !!queue.upNext;
  const commit = Math.abs(projected) > width * 0.33 && (projected < 0 ? canNext : queue.order.length > 1);
  if (!commit || reducedMotion()) {
    el.animate([{ transform: from === 'none' ? 'none' : from }, { transform: 'none' }], { duration: 380, easing: SPRING });
    if (commit) projected < 0 ? next() : previous(true);
    return;
  }
  const direction = projected < 0 ? 1 : -1;
  swipeInFlight = true;
  el.animate([{ transform: from }, { transform: `translateX(${-direction * width * 1.1}px) rotate(${-direction * 8}deg)`, opacity: 0 }], { duration: 200, easing: OUT })
    .finished.catch(() => {}).then(() => {
      if (direction > 0) next(); else previous(true);
      swipeInFlight = false;
      slideIn(el, direction, width * 0.9);
      onCommit?.();
    });
}

/** Mini-lecteur : balayer pour changer de morceau, glisser vers le haut pour ouvrir. */
function setupMiniGestures() {
  const mini = $('mini');
  const slide = $('mini-slide');
  let g = null;
  let suppressClick = false;
  mini.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#mini-toggle, #mini-next')) return;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, t: performance.now(), vx: 0, axis: null };
  });
  mini.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const now = performance.now();
    g.vx = (e.clientX - g.lastX) / Math.max(now - g.t, 1);
    g.lastX = e.clientX;
    g.t = now;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < 10) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (g.axis === 'x') mini.setPointerCapture(e.pointerId);
    }
    if (g.axis === 'x') slide.style.transform = `translateX(${dx}px)`;
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = g.lastX - g.x;
    const dy = e.clientY - g.y;
    if (g.axis === 'x') {
      suppressClick = true;
      finishSwipe(slide, dx, g.vx, slide.offsetWidth * 0.5);
    } else if (g.axis === 'y' && dy < -24) {
      suppressClick = true;
      openPlayer();
    }
    g = null;
  };
  mini.addEventListener('pointerup', end);
  mini.addEventListener('pointercancel', end);
  $('mini-open').addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      return;
    }
    openPlayer();
  });
}

// MARK: Feuilles (menus et choix)

let sheetCleanup = null;
let sheetHideTimer = null;
function openSheet(html, bind) {
  const sheet = $('sheet');
  const dim = $('sheet-dim');
  // Une feuille qui en remplace une autre : l'ancienne se termine, sa fermeture en cours est annulée.
  clearTimeout(sheetHideTimer);
  const previous = sheetCleanup;
  sheetCleanup = null;
  previous?.();
  sheet.classList.remove('closing');
  dim.classList.remove('closing');
  $('sheet-body').innerHTML = html;
  sheet.hidden = false;
  dim.hidden = false;
  sheet.scrollTop = 0;
  sheetCleanup = bind?.($('sheet-body')) || null;
}

function closeSheet() {
  const sheet = $('sheet');
  const dim = $('sheet-dim');
  if (sheet.hidden) return;
  sheet.classList.add('closing');
  dim.classList.add('closing');
  const cleanup = sheetCleanup;
  sheetCleanup = null;
  cleanup?.();
  clearTimeout(sheetHideTimer);
  sheetHideTimer = setTimeout(() => {
    sheet.hidden = true;
    dim.hidden = true;
  }, 250);
}

/**
 * Fenêtre de l'app à la place des boîtes grises du système.
 * Confirmation → true / false ; avec `input` → le texte saisi, ou null si annulé.
 */
function ask({ title, message = '', ok = 'OK', cancel = 'Annuler', danger = false, input = null }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    openSheet(`
      <div class="ask" data-ask>
        <h3>${esc(title)}</h3>
        ${message ? `<p class="sheet-sub ask-text">${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
        ${input ? `<label class="field ask-field"><input data-ask-input value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" aria-label="${esc(title)}" autocomplete="off" autocapitalize="sentences" enterkeyhint="done"></label>` : ''}
        <div class="sheet-footer">
          ${cancel ? `<button type="button" class="soft-btn" data-ask-cancel>${esc(cancel)}</button>` : ''}
          <button type="button" class="accent-btn${danger ? ' danger-btn' : ''}" data-ask-ok>${esc(ok)}</button>
        </div>
      </div>
    `, (body) => {
      const field = body.querySelector('[data-ask-input]');
      const accept = () => {
        finish(input ? field.value : true);
        closeSheet();
      };
      body.querySelector('[data-ask-ok]').onclick = accept;
      body.querySelector('[data-ask-cancel]')?.addEventListener('click', () => {
        finish(input ? null : false);
        closeSheet();
      });
      if (field) {
        field.addEventListener('keydown', (e) => { if (e.key === 'Enter') accept(); });
        setTimeout(() => field.focus(), 60);
      }
      return () => finish(input ? null : false);
    });
  });
}

const notice = (title, message = '') => ask({ title, message, cancel: '' });

const icon = {
  plus: '<svg viewBox="0 0 24 24" class="i"><path d="M12 5v14M5 12h14"/></svg>',
  list: '<svg viewBox="0 0 24 24" class="i"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M19 4v11"/><circle cx="17" cy="16" r="2.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" class="i"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" class="i"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  playNext: '<svg viewBox="0 0 24 24" class="i"><path d="M4 6h10M4 11h10M4 16h6"/><path d="M16 13v7l5-3.5z" class="fill"/></svg>',
  person: '<svg viewBox="0 0 24 24" class="i"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  undo: '<svg viewBox="0 0 24 24" class="i"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  image: '<svg viewBox="0 0 24 24" class="i"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  playLast: '<svg viewBox="0 0 24 24" class="i"><path d="M4 6h16M4 11h16M4 16h8"/><path d="M15 19l3 2 3-2M18 14v7"/></svg>',
  lyrics: '<svg viewBox="0 0 24 24" class="i"><path d="M5 6h14M5 11h14M5 16h9"/></svg>',
  share: '<svg viewBox="0 0 24 24" class="i"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>',
  card: '<svg viewBox="0 0 24 24" class="i"><rect x="6" y="2.5" width="12" height="19" rx="3"/><rect x="8.5" y="6" width="7" height="7" rx="1.5"/></svg>',
  music: '<svg viewBox="0 0 24 24" class="i"><path d="M9 17.5V5.2l11-2.2v12.3"/><circle cx="6.5" cy="17.5" r="2.8"/><circle cx="17.5" cy="15.3" r="2.8"/></svg>',
  save: '<svg viewBox="0 0 24 24" class="i"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>',
  mood: '<svg viewBox="0 0 24 24" class="i"><path d="M3 12c2.5-4 4.5-4 7 0s4.5 4 7 0 3.5-3 4-2"/><path d="M3 18c2.5-4 4.5-4 7 0s4.5 4 7 0 3.5-3 4-2" opacity=".45"/></svg>',
  radio: '<svg viewBox="0 0 24 24" class="i"><circle cx="12" cy="12" r="2"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>',
  link: '<svg viewBox="0 0 24 24" class="i"><rect x="2.5" y="5" width="12" height="9" rx="1.5"/><path d="M6 18h5"/><rect x="16.5" y="8" width="5" height="11" rx="1.5"/></svg>',
};

function openTrackActions(track) {
  const playlist = state.collection?.kind === 'playlist' ? playlistById(state.collection.key) : null;
  openSheet(`
    <h3>${esc(track.title)}</h3><p class="sheet-sub">${esc(track.artist)}</p>
    ${starsHTML(track.rating)}
    <button class="sheet-item" data-act="edit">${icon.pencil} Modifier les infos</button>
    ${track.original ? `<button class="sheet-item" data-act="restore">${icon.undo} Revenir au nom d'origine</button>` : ''}
    <button class="sheet-item" data-act="next">${icon.playNext} Lire ensuite</button>
    <button class="sheet-item" data-act="last">${icon.playLast} Lire en dernier</button>
    <button class="sheet-item" data-act="lyrics">${icon.lyrics} ${track.lyrics ? 'Modifier les paroles' : 'Ajouter les paroles'}</button>
    <button class="sheet-item" data-act="pick-lyrics">${icon.lyrics} Choisir d'autres paroles</button>
    ${track.syncedLyrics && track.id === currentId ? `<button class="sheet-item" data-act="calib">${icon.lyrics} Paroles décalées ? Les recaler</button>` : ''}
    <button class="sheet-item" data-act="share">${icon.share} Partager</button>
    <button class="sheet-item" data-act="fav">${heartSVG('i')} ${track.fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}</button>
    <button class="sheet-item" data-act="add">${icon.list} Ajouter à une playlist</button>
    <button class="sheet-item" data-act="moods">${icon.mood} Humeurs${track.moods?.length ? `<span class="item-value">${track.moods.map((m) => moodById(m)?.name).filter(Boolean).join(', ')}</span>` : ''}</button>
    <button class="sheet-item" data-act="radio">${icon.radio} Radio de l'artiste</button>
    ${state.collection?.kind !== 'artist' ? `<button class="sheet-item" data-act="artist">${icon.person} Voir l'artiste</button>` : ''}
    ${playlist ? `<button class="sheet-item danger" data-act="remove-from">${icon.trash} Retirer de « ${esc(playlist.name)} »</button>` : ''}
    <div class="sheet-sep"></div>
    <button class="sheet-item danger" data-act="delete">${icon.trash} Supprimer du téléphone</button>
  `, (body) => {
    body.onclick = async (e) => {
      const star = e.target.closest('[data-rate]');
      if (star) return rate(track, Number(star.dataset.rate), star.closest('.stars'));
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'add') return openAddToPlaylist([track.id]);
      if (act === 'moods') return openMoodPicker([track.id]);
      if (act === 'edit') return openEditTrack(track);
      if (act === 'lyrics') return openLyricsEditor(track);
      if (act === 'pick-lyrics') return openLyricsPicker(track);
      if (act === 'share') return openShare(track);
      closeSheet();
      if (act === 'restore') await restoreOriginal(track);
      if (act === 'next') queueNext(track);
      if (act === 'last') {
        if (queue.isEmpty) return playList([track], 0, false);
        queue.insertLast(track.id);
        renderModes();
        saveSession();
        toast('Ajouté à la fin de la file');
      }
      if (act === 'fav') await toggleFav(track);
      if (act === 'artist') openCollection({ kind: 'artist', key: track.artist });
      if (act === 'radio') startRadio(track.artist);
      if (act === 'remove-from') {
        playlist.trackIds = playlist.trackIds.filter((id) => id !== track.id);
        await savePlaylist(playlist);
        renderCollection();
        renderCarousel();
      }
      if (act === 'delete') removeWithUndo([track]);
      if (act === 'calib') {
        showLyrics = true;
        calibrating = track.id;
        renderLyrics(track);
        openPlayer();
      }
    };
  });
}

const STAR = '<svg viewBox="0 0 24 24" class="i"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>';
const starsHTML = (rating = 0) => `<div class="stars" role="radiogroup" aria-label="Note">${[1, 2, 3, 4, 5].map((n) => `<button class="star press${rating >= n ? ' on' : ''}" role="radio" aria-checked="${rating === n}" data-rate="${n}" aria-label="${n} étoile${n > 1 ? 's' : ''}">${STAR}</button>`).join('')}</div>`;

/** Note de 1 à 5 ; toucher la note actuelle l'enlève. */
async function rate(track, n, box) {
  track.rating = track.rating === n ? 0 : n;
  await saveTrack(track);
  if (box) box.outerHTML = starsHTML(track.rating);
  haptic();
  renderCarousel();
  if (state.collection) renderCollection();
}

function startRadio(artist) {
  const list = artistRadio(artist, [...state.tracks.values()], state.playlists, stats);
  if (!list.length) return toast('Aucun morceau de cet artiste');
  playList(list, 0, false);
  toast(`Radio ${artist}`);
}

/** Humeurs d'un ou plusieurs morceaux. Avec plusieurs, une humeur cochée l'est pour tous. */
function openMoodPicker(ids, onDone) {
  const tracks = ids.map((id) => state.tracks.get(id)).filter(Boolean);
  const initial = new Set(MOODS.filter((m) => tracks.every((t) => t.moods?.includes(m.id))).map((m) => m.id));
  const on = new Set(initial);
  openSheet(`
    <h3>Humeurs</h3>
    <p class="sheet-sub">${tracks.length === 1 ? esc(tracks[0].title) : `${tracks.length} morceaux`}. Retrouve-les ensuite dans la bibliothèque.</p>
    <div class="mood-grid">${MOODS.map((m) => `<button class="mood-chip big press${on.has(m.id) ? ' on' : ''}" aria-pressed="${on.has(m.id)}" data-mood-pick="${m.id}" style="--h:${m.hue}"><span class="dot"></span>${m.name}</button>`).join('')}</div>
    <div class="sheet-footer"><button class="accent-btn" data-done>OK</button></div>
  `, (body) => {
    body.onclick = async (e) => {
      const chip = e.target.closest('[data-mood-pick]');
      if (chip) {
        const id = chip.dataset.moodPick;
        if (on.has(id)) on.delete(id); else on.add(id);
        chip.classList.toggle('on', on.has(id));
        chip.setAttribute('aria-pressed', String(on.has(id)));
        return;
      }
      if (!e.target.closest('[data-done]')) return;
      for (const t of tracks) {
        const set = new Set(t.moods || []);
        for (const m of MOODS) {
          if (on.has(m.id)) set.add(m.id);
          else if (initial.has(m.id)) set.delete(m.id);
        }
        const next = MOODS.map((m) => m.id).filter((id) => set.has(id));
        if (next.join() !== (t.moods || []).join()) {
          t.moods = next;
          await saveTrack(t);
        }
      }
      closeSheet();
      onDone?.();
      renderLibrary();
      if (state.collection) renderCollection();
      toast('Humeurs enregistrées');
    };
  });
}

function queueNext(track) {
  if (!track) return;
  if (queue.isEmpty) return playList([track], 0, false);
  queue.insertNext(track.id);
  renderModes();
  saveSession();
  toast('Sera joué ensuite');
}

function openAddToPlaylist(trackIds) {
  const playlists = [...state.playlists].sort((a, b) => collator.compare(a.name, b.name));
  openSheet(`
    <h3>Ajouter à une playlist</h3>
    <button class="sheet-item" data-new>${icon.plus} Nouvelle playlist…</button>
    ${playlists.length ? '<div class="sheet-sep"></div>' : ''}
    ${playlists.map((p) => `<button class="sheet-item" data-pl="${p.id}">${icon.list} ${esc(p.name)}</button>`).join('')}
  `, (body) => {
    body.onclick = async (e) => {
      const target = e.target.closest('[data-pl], [data-new]');
      if (!target) return;
      closeSheet();
      const playlist = target.hasAttribute('data-new') ? await createPlaylist() : playlistById(target.dataset.pl);
      if (!playlist) return;
      playlist.trackIds.push(...trackIds);
      await savePlaylist(playlist);
      toast(`Ajouté à « ${playlist.name} »`);
      renderCarousel();
      if (state.collection?.key === playlist.id) renderCollection();
    };
  });
}

function openTrackPicker(playlist) {
  const tracks = sortedTracks();
  const selected = new Set();
  openSheet(`
    <h3>Ajouter à « ${esc(playlist.name)} »</h3>
    ${tracks.length ? '' : '<p class="sheet-sub">Ta bibliothèque est vide : importe d\'abord des fichiers.</p>'}
    <ul class="list">${tracks.map((t) => `<li><button class="row" data-id="${t.id}">
      <span class="check"></span>${artHTML(t)}
      <span class="text"><span class="t">${esc(t.title)}</span><span class="a">${esc(t.artist)}</span></span>
    </button></li>`).join('')}</ul>
    <div class="sheet-footer"><button class="accent-btn" data-done disabled>Ajouter</button></div>
  `, (body) => {
    const done = body.querySelector('[data-done]');
    body.onclick = async (e) => {
      if (e.target.closest('[data-done]')) {
        // Ordre de la bibliothèque, pas celui des taps.
        playlist.trackIds.push(...tracks.filter((t) => selected.has(t.id)).map((t) => t.id));
        await savePlaylist(playlist);
        closeSheet();
        renderCollection();
        renderCarousel();
        return;
      }
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const id = row.dataset.id;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      row.classList.toggle('selected', selected.has(id));
      done.disabled = selected.size === 0;
      done.textContent = selected.size ? `Ajouter (${selected.size})` : 'Ajouter';
    };
  });
}

function openQueue() {
  const current = state.tracks.get(currentId);
  const upcoming = queue.upcoming(80).filter((u) => state.tracks.has(u.item));
  openSheet(`
    <h3>File d'attente</h3>
    ${current ? `<div class="sheet-label">En cours</div><ul class="list"><li class="row now">${artHTML(current)}<span class="text"><span class="t">${esc(current.title)}</span><span class="a">${esc(current.artist)}</span></span><span class="end">${eqHTML}</span></li></ul>` : ''}
    <div class="sheet-label">À suivre${queue.isShuffled ? ' (aléatoire)' : ''}</div>
    ${upcoming.length ? `<p class="sheet-hint">Fais glisser ${'<svg viewBox="0 0 24 24" class="i sm inline"><path d="M4 8h16M4 12h16M4 16h16"/></svg>'} pour changer l'ordre.</p><ul class="list" id="queue-list">${upcoming.map((u) => {
      const t = state.tracks.get(u.item);
      return `<li class="row queue-row" data-position="${u.position}">
        <button class="main" data-action="jump">${artHTML(t)}<span class="text"><span class="t">${esc(t.title)}</span><span class="a">${esc(t.artist)}</span></span></button>
        <button class="more" data-action="unqueue" aria-label="Retirer ${esc(t.title)} de la file"><svg viewBox="0 0 24 24" class="i sm"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <span class="handle" data-action="drag" aria-label="Déplacer"><svg viewBox="0 0 24 24" class="i"><path d="M4 8h16M4 12h16M4 16h16"/></svg></span>
      </li>`;
    }).join('')}</ul>` : '<p class="sheet-sub" style="margin-top:4px">Rien après ce morceau.</p>'}
  `, (body) => {
    body.onclick = (e) => {
      const row = e.target.closest('[data-position]');
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!row || !action) return;
      const position = Number(row.dataset.position);
      if (action === 'unqueue') {
        queue.removeAt(position);
        saveSession();
        renderModes();
        return openQueue();
      }
      if (action !== 'jump') return;
      closeSheet();
      queue.jumpTo(position);
      pendingDirection = 1;
      loadCurrent(true);
    };
    const list = body.querySelector('#queue-list');
    if (list) {
      attachReorder(list, (from, to) => {
        const base = queue.cursor + 1;
        queue.move(base + from, base + to);
        saveSession();
        renderModes();
        openQueue();
      });
    }
  });
}

/** Glisser une ligne par sa poignée pour la déplacer (playlist, file d'attente). */
function attachReorder(list, onMove) {
  let drag = null;
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-action="drag"]');
    if (!handle) return;
    e.preventDefault();
    const row = handle.closest('.row');
    const rows = [...list.querySelectorAll('.row')];
    drag = { row, rows, from: rows.indexOf(row), to: rows.indexOf(row), y: e.clientY, h: row.offsetHeight, id: e.pointerId };
    row.classList.add('dragging');
    rows.forEach((r) => r !== row && r.classList.add('shifting'));
    handle.setPointerCapture(e.pointerId);
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    drag.row.style.transform = `translateY(${dy}px) scale(1.02)`;
    const to = Math.max(0, Math.min(drag.rows.length - 1, drag.from + Math.round(dy / drag.h)));
    drag.to = to;
    drag.rows.forEach((r, i) => {
      if (r === drag.row) return;
      let shift = 0;
      if (drag.from < to && i > drag.from && i <= to) shift = -drag.h;
      if (to < drag.from && i >= to && i < drag.from) shift = drag.h;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { from, to, rows } = drag;
    drag = null;
    rows.forEach((r) => { r.style.transform = ''; r.classList.remove('dragging', 'shifting'); });
    if (from !== to) onMove(from, to);
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}

// MARK: Partage

function openShare(track) {
  openSheet(`
    <h3>Partager</h3>
    <p class="sheet-sub">${esc(track.title)}, ${esc(track.artist)}</p>
    <button class="sheet-item" data-share="card">${icon.card} Carte « J'écoute » (image)</button>
    <button class="sheet-item" data-share="file">${icon.music} Le fichier audio</button>
  `, (body) => {
    body.onclick = async (e) => {
      const kind = e.target.closest('[data-share]')?.dataset.share;
      if (!kind) return;
      const item = e.target.closest('[data-share]');
      item.classList.add('busy');
      try {
        if (kind === 'card') {
          const label = getComputedStyle(document.documentElement).getPropertyValue('--a-dark').trim();
          const png = await nowPlayingCard(track, { label });
          await shareFile(new File([png], `${safeName(track.title)}.png`, { type: 'image/png' }), track.title);
        } else {
          const blob = await db.file(track.id);
          if (!blob) return toast('Fichier introuvable');
          await shareFile(new File([blob], track.fileName || `${safeName(track.title)}.mp3`, { type: blob.type || 'audio/mpeg' }), track.title);
        }
        closeSheet();
      } finally {
        item.classList.remove('busy');
      }
    };
  });
}

const safeName = (s) => (s || 'uhqsic').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'uhqsic';

function openPlaylistMenu(playlist) {
  openSheet(`
    <h3>${esc(playlist.name)}</h3>
    <button class="sheet-item" data-act="add">${icon.plus} Ajouter des morceaux</button>
    <button class="sheet-item" data-act="rename">${icon.pencil} Renommer</button>
    <button class="sheet-item" data-act="photo">${icon.image} ${playlist.cover ? 'Changer la photo' : 'Ajouter une photo'}</button>
    ${playlist.cover ? `<button class="sheet-item" data-act="unphoto">${icon.undo} Revenir à la mosaïque</button>` : ''}
    <div class="sheet-sep"></div>
    <button class="sheet-item danger" data-act="delete">${icon.trash} Supprimer la playlist</button>
  `, (body) => {
    body.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add') return openTrackPicker(playlist);
      if (!act) return;
      closeSheet();
      if (act === 'rename') {
        const name = await ask({ title: 'Renommer la playlist', input: { value: playlist.name }, ok: 'Renommer' });
        if (name && name.trim()) {
          playlist.name = name.trim();
          await savePlaylist(playlist);
          renderCollection();
          renderCarousel();
        }
      }
      if (act === 'photo') {
        const art = await pickImage();
        if (art?.art) {
          playlist.cover = { ...art, v: Date.now() };
          await savePlaylist(playlist);
          renderCollection();
          renderCarousel();
        }
      }
      if (act === 'unphoto') {
        delete playlist.cover;
        await savePlaylist(playlist);
        renderCollection();
        renderCarousel();
      }
      if (act === 'delete' && await ask({ title: `Supprimer « ${playlist.name} » ?`, message: 'Les morceaux restent dans la bibliothèque.', ok: 'Supprimer', danger: true })) {
        state.playlists = state.playlists.filter((p) => p.id !== playlist.id);
        await db.deletePlaylist(playlist.id);
        sync?.playlistDeleted(playlist.id);
        closeCollection();
      }
    };
  });
}

// MARK: Modifier les infos (morceau, artiste, album)

const forgetArt = (track) => {
  for (const key of [`${track.id}:s`, `${track.id}:l`]) {
    if (urls.has(key)) URL.revokeObjectURL(urls.get(key));
    urls.delete(key);
  }
  tinyArt.delete(track.id);
  artDataUrls.delete(track.id);
};

function refreshAfterEdit(tracks) {
  for (const track of tracks) forgetArt(track);
  if (tracks.some((t) => t.id === currentId)) {
    renderedId = null; // pas d'animation de changement de morceau
    renderNowPlaying();
    updateMediaSession();
  }
  renderLibrary();
  if (state.collection) renderCollection();
}

/** Garde la première version des infos : « Revenir au nom d'origine » reste possible. */
function rememberOriginal(track) {
  track.original ??= { title: track.title, artist: track.artist, album: track.album, art: track.art, thumb: track.thumb, tint: track.tint };
}

async function restoreOriginal(track) {
  if (!track.original) return;
  Object.assign(track, track.original);
  delete track.original;
  await saveTrack(track);
  refreshAfterEdit([track]);
  toast('Infos d\'origine rétablies');
}

/** Choix d'une image dans Photos ou Fichiers, prête à servir de pochette. */
function pickImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await processArtwork(file) : null);
    };
    input.click();
  });
}

function openEditTrack(track) {
  let newArt = null;
  const field = (name, label, value, placeholder) => `<label class="field">
    <span class="field-label">${label}</span>
    <input name="${name}" value="${esc(value)}" placeholder="${placeholder}" autocomplete="off" autocapitalize="sentences" enterkeyhint="next">
  </label>`;
  openSheet(`
    <h3>Modifier les infos</h3>
    <form class="edit-form" data-edit>
      <div class="edit-cover">
        <span class="edit-art" id="edit-art">${artHTML(track, { full: true })}</span>
        <button type="button" class="text-btn" data-pick-art>Changer la pochette</button>
      </div>
      ${field('title', 'Titre', track.title, 'Titre du morceau')}
      ${field('artist', 'Artiste', track.artist === 'Artiste inconnu' ? '' : track.artist, 'Artiste inconnu')}
      ${field('album', 'Album', track.album, 'Aucun album')}
      <div class="sheet-footer">
        <button type="button" class="soft-btn" data-cancel>Annuler</button>
        <button type="submit" class="accent-btn">Enregistrer</button>
      </div>
    </form>
  `, (body) => {
    const form = body.querySelector('[data-edit]');
    body.querySelector('[data-cancel]').onclick = closeSheet;
    body.querySelector('[data-pick-art]').onclick = async () => {
      const art = await pickImage();
      if (!art?.art) return;
      newArt = art;
      const url = URL.createObjectURL(art.art);
      $('edit-art').innerHTML = `<span class="art has-image" style="background-image:url('${url}')"></span>`;
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const title = data.title.trim() || track.title;
      const artist = data.artist.trim() || 'Artiste inconnu';
      const album = data.album.trim();
      if (title === track.title && artist === track.artist && album === track.album && !newArt) return closeSheet();
      rememberOriginal(track);
      Object.assign(track, { title, artist, album }, newArt || {});
      await saveTrack(track);
      closeSheet();
      refreshAfterEdit([track]);
      toast('Infos enregistrées');
    };
  });
}

/** Renomme un artiste ou un album sur tous ses morceaux d'un coup. */
async function renameGroup(kind, oldName) {
  const label = kind === 'artist' ? 'l\'artiste' : 'l\'album';
  const name = await ask({ title: `Renommer ${label}`, input: { value: oldName }, ok: 'Renommer' });
  if (name === null || !name.trim() || name.trim() === oldName) return;
  const tracks = collectionData({ kind, key: oldName }).tracks;
  for (const track of tracks) {
    rememberOriginal(track);
    track[kind] = name.trim();
    await saveTrack(track);
  }
  state.collection = { kind, key: name.trim() };
  refreshAfterEdit(tracks);
  toast(`${tracks.length} morceau${tracks.length > 1 ? 'x' : ''} mis à jour`);
}

async function setAlbumArt(albumName) {
  const art = await pickImage();
  if (!art?.art) return;
  const tracks = collectionData({ kind: 'album', key: albumName }).tracks;
  for (const track of tracks) {
    rememberOriginal(track);
    Object.assign(track, art);
    await saveTrack(track);
  }
  refreshAfterEdit(tracks);
  toast('Pochette de l\'album changée');
}

function openGroupMenu(kind, name) {
  openSheet(`
    <h3>${esc(name)}</h3>
    <button class="sheet-item" data-act="rename">${icon.pencil} ${kind === 'artist' ? 'Renommer l\'artiste' : 'Renommer l\'album'}</button>
    ${kind === 'album' ? `<button class="sheet-item" data-act="art">${icon.image} Changer la pochette de l'album</button>` : ''}
  `, (body) => {
    body.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      closeSheet();
      if (act === 'rename') await renameGroup(kind, name);
      if (act === 'art') await setAlbumArt(name);
    };
  });
}

// MARK: Sélection multiple

function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  renderLibrary();
}

function renderSelectBar() {
  const show = state.selecting && state.tab === 'songs';
  $('select-bar').hidden = !show;
  document.body.classList.toggle('selecting', show);
  if (!show) return;
  const n = state.selected.size;
  $('select-count').textContent = n ? `${n} morceau${n > 1 ? 'x' : ''}` : 'Touche les morceaux';
  for (const b of document.querySelectorAll('[data-bulk]')) b.disabled = n === 0;
  $('summary').textContent = `${n} sur ${filtered().length}`;
}

async function bulkAction(kind) {
  const tracks = [...state.selected].map((id) => state.tracks.get(id)).filter(Boolean);
  if (!tracks.length) return;
  if (kind === 'playlist') return openAddToPlaylist(tracks.map((t) => t.id));
  if (kind === 'mood') return openMoodPicker(tracks.map((t) => t.id), () => setSelecting(false));
  if (kind === 'fav') {
    const allFav = tracks.every((t) => t.fav);
    for (const t of tracks) {
      t.fav = !allFav;
      await saveTrack(t);
    }
    toast(allFav ? 'Retirés des favoris' : 'Ajoutés aux favoris');
    setSelecting(false);
    return;
  }
  if (kind === 'delete') {
    setSelecting(false);
    removeWithUndo(tracks);
  }
}

// MARK: Barre A-Z

function renderAZ() {
  const az = $('az');
  const show = state.tab === 'songs' && prefs.sort === 'title' && !state.search.trim() && state.tracks.size >= 30 && !state.selecting;
  az.hidden = !show;
  document.body.classList.toggle('has-az', show);
  if (!show) return;
  const present = new Set(filtered().map((t) => letterOf(t.title)));
  az.innerHTML = [...'#ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `<span class="${present.has(l) ? '' : 'off'}" data-letter="${l}">${l}</span>`).join('');
}

function setupAZ() {
  const az = $('az');
  const bubble = $('az-bubble');
  let active = false;
  let last = '';
  let hideTimer;
  const jump = (y) => {
    finishRows($('tracks'));
    const letters = [...az.querySelectorAll('[data-letter]')];
    const r = az.getBoundingClientRect();
    const i = Math.max(0, Math.min(letters.length - 1, Math.floor(((y - r.top) / r.height) * letters.length)));
    const order = [...'#ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    // Lettre sans morceau : on va à la suivante qui en a.
    let row = null;
    for (let k = i; k < order.length && !row; k++) row = $('tracks').querySelector(`.row[data-letter="${order[k]}"]`);
    const letter = order[i];
    if (letter !== last) {
      last = letter;
      haptic();
    }
    bubble.textContent = letter;
    bubble.classList.add('shown');
    if (row) {
      // Position mesurée par rapport à la page qui défile (la liste est elle-même positionnée).
      const library = $('library');
      library.scrollTop += row.getBoundingClientRect().top - library.getBoundingClientRect().top - 64;
    }
  };
  az.addEventListener('pointerdown', (e) => {
    active = true;
    az.setPointerCapture(e.pointerId);
    clearTimeout(hideTimer);
    jump(e.clientY);
  });
  az.addEventListener('pointermove', (e) => { if (active) jump(e.clientY); });
  const end = () => {
    active = false;
    last = '';
    hideTimer = setTimeout(() => bubble.classList.remove('shown'), 350);
  };
  az.addEventListener('pointerup', end);
  az.addEventListener('pointercancel', end);
}

// MARK: Récap du mois

async function openRecap(key) {
  const r = recap(stats, key);
  if (!r) return;
  const tracks = r.tracks.map((x) => ({ ...x, track: state.tracks.get(x.id) })).filter((x) => x.track);
  const top = tracks[0]?.track;
  const hours = Math.floor(r.minutes / 60);
  const time = hours ? `${hours} h ${r.minutes % 60} min` : `${r.minutes} min`;
  $('recap-bg').style.setProperty('--recap-tint', tintOf(top));
  $('recap-body').innerHTML = `
    <h2 class="display recap-title">Ton mois ${/^[aeiou]/i.test(monthName(r.key)) ? 'd’' : 'de '}${monthName(r.key).split(' ')[0]}</h2>
    <div class="recap-hero">
      <span class="recap-art">${artHTML(top, { full: true })}</span>
      <p class="recap-time"><b>${time}</b> d'écoute</p>
      ${r.artists[0] ? `<p class="recap-lead">Ton artiste du mois : <b>${esc(r.artists[0].name)}</b></p>` : ''}
    </div>
    ${tracks.length ? '<h3 class="recap-h">Tes morceaux</h3>' : ''}
    <ol class="recap-list">${tracks.map((x, i) => `<li><span class="rank">${i + 1}</span>${artHTML(x.track)}<span class="text"><span class="t">${esc(x.track.title)}</span><span class="a">${esc(x.track.artist)}</span></span><span class="mins">${x.minutes} min</span></li>`).join('')}</ol>
    ${r.artists.length ? '<h3 class="recap-h">Tes artistes</h3>' : ''}
    <ol class="recap-list artists">${r.artists.map((a, i) => `<li><span class="rank">${i + 1}</span><span class="text"><span class="t">${esc(a.name)}</span></span><span class="mins">${a.minutes} min</span></li>`).join('')}</ol>
    <button class="accent-btn recap-share press" id="recap-share">${icon.share} Partager mon récap</button>
  `;
  $('recap-share').onclick = async () => {
    if (!top) return;
    const label = getComputedStyle(document.documentElement).getPropertyValue('--a-dark').trim();
    const png = await nowPlayingCard({ ...top, title: `${time} d'écoute`, artist: `Mon n°1 : ${top.title}, ${top.artist}` }, { label, heading: `Mon ${monthName(r.key)}` });
    await shareFile(new File([png], `recap-${r.key}.png`, { type: 'image/png' }), 'Mon récap Uhqsic');
  };
  const page = $('recap');
  page.hidden = false;
  page.scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => page.classList.add('shown')));
}

function closeRecap() {
  const page = $('recap');
  page.classList.remove('shown');
  setTimeout(() => { page.hidden = true; }, 420);
}

// MARK: Sauvegarde

async function exportBackup() {
  const backup = buildBackup([...state.tracks.values()], state.playlists, stats, prefs);
  const date = new Date().toISOString().slice(0, 10);
  const file = new File([JSON.stringify(backup)], `uhqsic-sauvegarde-${date}.json`, { type: 'application/json' });
  if (await shareFile(file, 'Sauvegarde Uhqsic')) toast('Sauvegarde créée');
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let result;
    try {
      result = matchBackup(JSON.parse(await file.text()), [...state.tracks.values()]);
    } catch (error) {
      notice('Restauration impossible', error?.message?.includes('Uhqsic') ? error.message : 'Ce fichier n\'est pas une sauvegarde Uhqsic lisible.');
      return;
    }
    const missing = result.missing ? `\n\n${result.missing} morceau${result.missing > 1 ? 'x' : ''} de la sauvegarde ne sont pas sur ce téléphone : importe d'abord les mêmes fichiers, puis restaure à nouveau.` : '';
    if (!await ask({ title: 'Restaurer la sauvegarde ?', message: `${result.found} morceau${result.found > 1 ? 'x' : ''} retrouvé${result.found > 1 ? 's' : ''} et ${result.playlists.length} playlist${result.playlists.length > 1 ? 's' : ''}. Les infos actuelles de ces morceaux seront remplacées.${missing}`, ok: 'Restaurer' })) return;
    for (const { id, fields } of result.updates) {
      const track = state.tracks.get(id);
      Object.assign(track, fields);
      await saveTrack(track);
      forgetArt(track);
    }
    for (const saved of result.playlists) {
      const existing = state.playlists.find((p) => p.name === saved.name);
      if (existing) existing.trackIds = saved.trackIds;
      const playlist = existing || { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), ...saved };
      if (!existing) state.playlists.push(playlist);
      await savePlaylist(playlist);
    }
    const backupStats = JSON.parse(await file.text()).stats;
    for (const [key, month] of Object.entries(backupStats?.months || {})) stats.months[key] ??= month;
    flushStats();
    closeSettings();
    renderLibrary();
    if (currentId) renderNowPlaying();
    toast('Sauvegarde restaurée');
  };
  input.click();
}

// MARK: Accueil (premier lancement)

function maybeWelcome() {
  if (localStorage.getItem('uhqsic.welcomed') || state.tracks.size > 0) return;
  const page = $('welcome');
  page.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => page.classList.add('shown')));
  const close = () => {
    localStorage.setItem('uhqsic.welcomed', '1');
    page.classList.remove('shown');
    page.classList.add('leaving');
    setTimeout(() => { page.hidden = true; }, 500);
    setTimeout(maybeSuggestInstall, 1200);
  };
  $('welcome-import').onclick = () => {
    close();
    $('file-input').click();
  };
  $('welcome-later').onclick = close;
}

// MARK: Installation sur l'écran d'accueil

function openInstallGuide() {
  openSheet(installGuideHTML(), (body) => {
    let answered = false;
    body.querySelector('[data-install-now]')?.addEventListener('click', async () => {
      answered = true;
      closeSheet();
      if (await promptInstall()) toast('Uhqsic est installée');
    });
    body.querySelector('[data-install-later]').onclick = () => {
      answered = true;
      remindLater(14);
      closeSheet();
    };
    // Fermée sans répondre : on reproposera dans quelques jours.
    return () => { if (!answered) remindLater(3); };
  });
}

function maybeSuggestInstall() {
  if (!shouldSuggest() || !$('sheet').hidden || isSettingsOpen() || !$('welcome').hidden) return;
  openInstallGuide();
}

// MARK: Minuterie de sommeil

const sleep = { mode: 'off', until: 0, timer: null };
const SLEEP_CHOICES = [
  { id: 'off', label: 'Désactivée' },
  { id: '15', label: '15 minutes' },
  { id: '30', label: '30 minutes' },
  { id: '45', label: '45 minutes' },
  { id: '60', label: '1 heure' },
  { id: 'end', label: 'À la fin du morceau' },
];

function setSleep(choice) {
  clearInterval(sleep.timer);
  sleep.timer = null;
  sleep.mode = choice === 'off' || choice === 'end' ? choice : 'time';
  sleep.choice = choice;
  if (sleep.mode === 'time') {
    sleep.until = Date.now() + Number(choice) * 60000;
    sleep.timer = setInterval(tickSleep, 15000);
  }
  tickSleep();
}

function tickSleep() {
  const badge = $('sleep-badge');
  if (sleep.mode === 'time' && Date.now() >= sleep.until) {
    pauseOnPurpose();
    setSleep('off');
    return;
  }
  const on = sleep.mode !== 'off';
  badge.classList.toggle('on', on);

  if (sleep.mode === 'end') $('sleep-text').textContent = 'Arrêt à la fin du morceau';
  if (sleep.mode === 'time') $('sleep-text').textContent = `Arrêt dans ${Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000))} min`;
}

function sleepLabel() {
  if (sleep.mode === 'off') return 'Désactivée';
  if (sleep.mode === 'end') return 'Fin du morceau';
  return `${Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000))} min`;
}

function openSleepChoices() {
  openSheet(`
    <h3>Minuterie de sommeil</h3>
    <p class="sheet-sub">La musique se met en pause toute seule.</p>
    ${SLEEP_CHOICES.map((c) => `<button class="sheet-item" data-sleep="${c.id}">${c.label}${(sleep.choice || 'off') === c.id ? ' <svg viewBox="0 0 24 24" class="i" style="margin-left:auto"><path d="M5 12l5 5L20 7"/></svg>' : ''}</button>`).join('')}
  `, (body) => {
    body.onclick = (e) => {
      const choice = e.target.closest('[data-sleep]')?.dataset.sleep;
      if (!choice) return;
      setSleep(choice);
      closeSheet();
      if (choice !== 'off') toast(choice === 'end' ? 'Pause à la fin du morceau' : `Pause dans ${SLEEP_CHOICES.find((c) => c.id === choice).label}`);
      if (isSettingsOpen()) renderSettings();
    };
  });
}

// MARK: Réglages

const isSettingsOpen = () => $('settings').classList.contains('shown');

function segHTML(name, options, value) {
  const index = Math.max(0, options.findIndex((o) => o.id === value));
  return `<div class="seg" role="radiogroup" data-seg="${name}" style="--n:${options.length};--i:${index}">
    <span class="seg-pill" aria-hidden="true"></span>
    ${options.map((o) => `<button role="radio" aria-checked="${o.id === value}" data-value="${o.id}">${o.label}</button>`).join('')}
  </div>`;
}

const switchHTML = (name, on, label) => `<button class="setting" role="switch" aria-checked="${on}" data-switch="${name}">
  <span class="label">${label}</span><span class="switch" aria-checked="${on}"></span>
</button>`;

function formatBytes(bytes) {
  if (!bytes) return '0 Mo';
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString('fr', { maximumFractionDigits: 1 })} Go`;
  return `${Math.max(1, Math.round(bytes / 1e6))} Mo`;
}

function renderSettings() {
  const themes = [
    { id: 'auto', label: 'Automatique', shot: 'shot-auto' },
    { id: 'light', label: 'Clair', shot: 'shot-light' },
    { id: 'dark', label: 'Sombre', shot: 'shot-dark' },
  ];
  $('settings-body').innerHTML = `
    ${canInstall() ? `<div class="group install-group"><button class="setting" data-open="install"><span class="label">Installer sur l'écran d'accueil</span>${icon.plus}</button></div>
    <p class="group-note">Installée, l'app s'ouvre en plein écran, marche sans internet, et Safari ne peut plus effacer ta musique.</p>` : ''}
    <h3 class="group-title">Apparence</h3>
    <div class="group"><div class="setting stack">
      <div class="theme-pick" role="radiogroup" aria-label="Thème">
        ${themes.map((t) => `<button role="radio" aria-checked="${prefs.theme === t.id}" data-theme-pick="${t.id}">
          <span class="theme-shot ${t.shot}" aria-hidden="true"><i class="t1"></i><i class="t2"></i><i class="t3"></i><i class="t4"></i><i class="t5"></i></span>${t.label}
        </button>`).join('')}
      </div>
    </div></div>
    <p class="group-note">Automatique suit le réglage de ton téléphone, clair le jour et sombre le soir si tu l'as programmé.</p>

    <h3 class="group-title">Ambiances</h3>
    <div class="group"><div class="setting stack">
      <div class="ambiances" role="radiogroup" aria-label="Ambiance">
        ${THEMES.map((t) => `<button class="amb-card" role="radio" aria-checked="${prefs.theme === t.id}" data-theme-pick="${t.id}"
          style="--p-stage:${themePreviewBg(t)};--p-surface:${t.surface};--p-text:${t.text};--p-accent:${t.accent};--p-glow:${t.glow}">
          <span class="amb-shot" aria-hidden="true"><i class="l l1"></i><i class="l l2"></i><i class="l l3"></i><i class="card"></i><i class="pill"></i>
            <span class="check"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span></span>${t.name}
        </button>`).join('')}
      </div>
    </div></div>
    <p class="group-note">Chaque ambiance change les couleurs, le fond et parfois la police. Le lecteur garde les couleurs de la pochette.</p>

    ${themeById(prefs.theme) ? '' : `<h3 class="group-title">Couleur</h3>
    <div class="group"><div class="setting stack">
      <div class="swatches" role="radiogroup" aria-label="Couleur de l'app">
        ${ACCENTS.map((a) => `<button class="swatch" role="radio" aria-checked="${prefs.accent === a.id}" data-accent-pick="${a.id}" style="--sw:${isDark() ? a.dark : a.light}">
          <span class="dot" aria-hidden="true"></span>${a.name}
        </button>`).join('')}
      </div>
    </div></div>`}

    <h3 class="group-title">Lecteur</h3>
    <div class="group">
      ${switchHTML('vinyl', prefs.vinyl, 'Vinyle derrière la pochette')}
      ${switchHTML('ambient', prefs.ambient, 'Fond tiré de la pochette')}
      <div class="setting stack"><span class="label">Animations</span>${segHTML('motion', [{ id: 'full', label: 'Complètes' }, { id: 'reduced', label: 'Réduites' }], prefs.motion)}</div>
      ${switchHTML('autoLyrics', prefs.autoLyrics, 'Chercher les paroles automatiquement')}
      <button class="setting" data-open="sleep"><span class="label">Minuterie de sommeil</span><span class="value">${sleepLabel()}</span><svg viewBox="0 0 24 24" class="i sm" style="color:var(--secondary)"><path d="M9 5l7 7-7 7"/></svg></button>
    </div>
    <p class="group-note">Les paroles viennent de LRCLIB et lyrics.ovh, des bases ouvertes et gratuites : seuls le titre, l'artiste et la durée du morceau sont envoyés. Avec Animations réduites, tout apparaît en fondu, sans mouvement.</p>

    <h3 class="group-title">Appareils liés</h3>
    <div class="group" id="devices-group"></div>
    <p class="group-note">Lie ton PC et ton téléphone : la musique, les infos modifiées, les favoris, les notes, les humeurs, les paroles et les playlists passent de l'un à l'autre, quand l'app est ouverte sur les deux. Plus rapide sur le même wifi. Rien n'est gardé sur internet : la connexion va directement d'un appareil à l'autre.</p>

    <h3 class="group-title">Bibliothèque</h3>
    <div class="group">
      <div class="setting stack"><span class="label">Trier les morceaux par</span>${segHTML('sort', [{ id: 'title', label: 'Titre' }, { id: 'artist', label: 'Artiste' }, { id: 'recent', label: 'Ajout récent' }], prefs.sort)}</div>
    </div>
    <p class="group-note">Pour renommer un morceau, touche « ⋯ » puis Modifier les infos. Pour un artiste ou un album, ouvre sa page et touche « ⋯ ».</p>

    <h3 class="group-title">Stockage</h3>
    <div class="group">
      <div class="setting"><span class="label">Morceaux</span><span class="value">${state.tracks.size}</span></div>
      <div class="setting"><span class="label">Playlists</span><span class="value">${state.playlists.length}</span></div>
      <div class="setting"><span class="label">Espace utilisé</span><span class="value" id="storage-used">…</span></div>
      <button class="setting" data-open="backup"><span class="label">Sauvegarder</span>${icon.save}</button>
      <button class="setting" data-open="restore"><span class="label">Restaurer une sauvegarde</span>${icon.undo}</button>
      <button class="setting danger" data-open="wipe"><span class="label">Tout effacer…</span></button>
    </div>
    <p class="group-note">La sauvegarde garde tes playlists, favoris, paroles, écoutes et infos modifiées, mais pas les fichiers audio. Sur un autre téléphone, importe les mêmes fichiers puis restaure.</p>
    <div class="group"><button class="setting" data-open="share-app"><span class="label">Faire découvrir Uhqsic à un pote</span>${icon.share}</button></div>
    <p class="group-note">Ta musique reste sur tes appareils.</p>
    <p class="group-note" style="text-align:center;margin-top:28px">Uhqsic 5</p>
  `;
  renderDevices();
  navigator.storage?.estimate?.().then((e) => {
    const el = $('storage-used');
    if (el) el.textContent = formatBytes(e.usage);
  }).catch(() => {});
}

/** Fond miniature d'une ambiance : sa couleur et une lueur de sa teinte. */
const themePreviewBg = (t) => `radial-gradient(120% 70% at 50% -10%, ${t.glow}${t.dark ? '99' : '88'}, transparent 70%), ${t.bg}`;

function openSettings() {
  renderSettings();
  $('settings').scrollTop = 0;
  $('settings').setAttribute('aria-hidden', 'false');
  $('settings').classList.add('shown');
  $('settings-dim').classList.add('shown');
}

function closeSettings() {
  $('settings').setAttribute('aria-hidden', 'true');
  $('settings').classList.remove('shown');
  $('settings-dim').classList.remove('shown');
}

/** Change une option en gardant l'élément en place : la pastille glisse au lieu de réapparaître. */
function updateSeg(seg, value) {
  const buttons = [...seg.querySelectorAll('[data-value]')];
  seg.style.setProperty('--i', String(Math.max(0, buttons.findIndex((b) => b.dataset.value === value))));
  for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === value));
}

function bindSettings() {
  $('settings-btn').onclick = openSettings;
  $('settings-done').onclick = closeSettings;
  $('settings-dim').onclick = closeSettings;
  $('settings-body').addEventListener('click', async (e) => {
    const theme = e.target.closest('[data-theme-pick]');
    if (theme) {
      setPref('theme', theme.dataset.themePick);
      renderSettings(); // les pastilles de couleur suivent le thème
      return;
    }
    const accent = e.target.closest('[data-accent-pick]');
    if (accent) {
      setPref('accent', accent.dataset.accentPick);
      for (const b of document.querySelectorAll('[data-accent-pick]')) b.setAttribute('aria-checked', String(b === accent));
      if (!currentId || !state.tracks.get(currentId)?.tint) $('stage').style.setProperty('--aura', 'var(--accent)');
      return;
    }
    const toggle = e.target.closest('[data-switch]');
    if (toggle) {
      const key = toggle.dataset.switch;
      setPref(key, !prefs[key]);
      toggle.setAttribute('aria-checked', String(prefs[key]));
      toggle.querySelector('.switch').setAttribute('aria-checked', String(prefs[key]));
      return;
    }
    const option = e.target.closest('.seg [data-value]');
    if (option) {
      const seg = option.closest('[data-seg]');
      setPref(seg.dataset.seg, option.dataset.value);
      updateSeg(seg, option.dataset.value);
      if (seg.dataset.seg === 'sort') {
        firstRender = true;
        renderLibrary();
      }
      return;
    }
    const open = e.target.closest('[data-open]')?.dataset.open;
    if (open === 'sleep') openSleepChoices();
    if (open === 'backup') exportBackup();
    if (open === 'restore') importBackup();
    if (open === 'pair') openPairing();
    if (open === 'share-app') {
      const url = new URL('decouvrir/', location.href.split('#')[0].replace(/[^/]*$/, '')).href;
      try {
        if (navigator.share) await navigator.share({ title: 'Uhqsic', text: 'Mon lecteur de musique : tes fichiers, les paroles synchronisées, sans compte ni pub.', url });
        else {
          await navigator.clipboard.writeText(url);
          toast('Lien copié');
        }
      } catch {
        // Partage annulé : rien à faire.
      }
    }
    if (open === 'install') {
      if (canPrompt()) {
        if (await promptInstall()) toast('Uhqsic est installée');
      } else {
        openInstallGuide();
      }
    }
    if (e.target.closest('[data-rename-self]')) {
      const name = await ask({ title: 'Nom de cet appareil', message: 'C\'est le nom que verront tes autres appareils et tes potes liés.', input: { value: deviceName(), placeholder: 'iPhone de…' }, ok: 'Enregistrer' });
      if (name !== null) {
        if (name.trim()) localStorage.setItem('uhqsic.deviceName', name.trim().slice(0, 40));
        else localStorage.removeItem('uhqsic.deviceName');
        sync?.wake();
        renderDevices();
      }
      return;
    }
    const other = e.target.closest('[data-rename-device]');
    if (other) {
      const device = linkInfo()?.devices?.find((d) => d.id === other.dataset.renameDevice);
      if (!device) return;
      const name = await ask({ title: 'Renommer l\'appareil', message: `Ce nom n'est utilisé que sur cet appareil. Il s'annonce comme « ${device.name} ».`, input: { value: deviceLabel(device) }, ok: 'Renommer' });
      if (name !== null) {
        setDeviceLabel(device.id, name.trim() && name.trim() !== device.name ? name.trim().slice(0, 40) : '');
        renderDevices();
      }
      return;
    }
    if (open === 'join') openJoin();
    if (open === 'unlink' && await ask({ title: 'Délier cet appareil ?', message: 'La musique déjà reçue reste ici. Les changements ne seront plus partagés.', ok: 'Délier', danger: true })) {
      sync.unlink();
      renderDevices();
    }
    if (open === 'wipe' && await ask({ title: 'Tout effacer ?', message: 'Tous les morceaux, playlists et favoris seront supprimés de cet appareil. Cette action est définitive.', ok: 'Tout effacer', danger: true })) {
      stop();
      await wipeDatabase();
      for (const key of ['uhqsic.session', 'uhqsic.repeat', 'uhqsic.shuffle', 'uhqsic.stats', 'uhqsic.speed', 'uhqsic.history', 'uhqsic.daily', 'uhqsic.alias', 'uhqsic.tombs']) localStorage.removeItem(key);
      location.reload();
    }
  });
}

// MARK: Actions sur la bibliothèque

async function createPlaylist() {
  const name = await ask({ title: 'Nouvelle playlist', input: { value: '', placeholder: 'Nom de la playlist' }, ok: 'Créer' });
  if (name === null) return null;
  const playlist = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: name.trim() || 'Nouvelle playlist',
    createdAt: Date.now(),
    trackIds: [],
  };
  state.playlists.push(playlist);
  await savePlaylist(playlist);
  renderCarousel();
  return playlist;
}

// MARK: Suppression annulable : le morceau disparaît tout de suite, l'effacement attend quelques secondes.

let pendingDeletion = null; // { entries: [{ track, places: [[playlist, index]] }], timer }

async function removeWithUndo(tracks) {
  flushDeletion();
  const ids = new Set(tracks.map((t) => t.id));
  await leaveRows([...document.querySelectorAll('#tracks .row[data-id], #col-tracks .row[data-id]')].filter((r) => ids.has(r.dataset.id)));
  const entries = [];
  let removedCurrent = false;
  flipRows([$('tracks'), $('col-tracks')], () => {
    for (const track of tracks) {
      const places = [];
      for (const p of state.playlists) {
        const index = p.trackIds.indexOf(track.id);
        if (index === -1) continue;
        places.push([p, index]);
        p.trackIds = p.trackIds.filter((id) => id !== track.id);
      }
      if (queue.removeWhere((id) => id === track.id)) removedCurrent = true;
      state.tracks.delete(track.id);
      state.selected.delete(track.id);
      entries.push({ track, places });
    }
    if (queue.isEmpty) stop();
    else if (removedCurrent) loadCurrent(!audio.paused);
    else renderModes();
    renderLibrary();
    if (state.collection) renderCollection();
  });
  pendingDeletion = { entries, timer: setTimeout(flushDeletion, 6000) };
  const n = tracks.length;
  toast(n === 1 ? 'Morceau supprimé' : `${n} morceaux supprimés`, { action: 'Annuler', onAction: undoDeletion, duration: 6000 });
}

async function flushDeletion() {
  const pending = pendingDeletion;
  if (!pending) return;
  pendingDeletion = null;
  clearTimeout(pending.timer);
  for (const { track, places } of pending.entries) {
    await db.deleteTrack(track.id, places.map(([p]) => p)).catch(() => {});
    sync?.trackDeleted(track.id);
    forgetArt(track);
  }
}

function undoDeletion() {
  const pending = pendingDeletion;
  if (!pending) return;
  pendingDeletion = null;
  clearTimeout(pending.timer);
  // Dans l'ordre inverse : chaque morceau reprend sa place exacte dans ses playlists.
  flipRows([$('tracks'), $('col-tracks')], () => {
    for (const { track, places } of [...pending.entries].reverse()) {
      state.tracks.set(track.id, track);
      for (const [p, index] of places) p.trackIds.splice(Math.min(index, p.trackIds.length), 0, track.id);
    }
    renderLibrary();
    if (state.collection) renderCollection();
  });
  toast('Suppression annulée');
}

async function deleteTrack(track, { quiet = false, fromSync = false } = {}) {
  const removedCurrent = queue.removeWhere((id) => id === track.id);
  const touched = [];
  for (const p of state.playlists) {
    if (p.trackIds.includes(track.id)) {
      p.trackIds = p.trackIds.filter((id) => id !== track.id);
      touched.push(p);
    }
  }
  await db.deleteTrack(track.id, touched);
  if (!fromSync) sync?.trackDeleted(track.id);
  state.tracks.delete(track.id);
  for (const key of [`${track.id}:s`, `${track.id}:l`]) {
    if (urls.has(key)) URL.revokeObjectURL(urls.get(key));
    urls.delete(key);
  }
  if (queue.isEmpty) stop();
  else if (removedCurrent) loadCurrent(!audio.paused);
  else renderModes();
  state.selected.delete(track.id);
  if (quiet) return;
  renderLibrary();
  if (state.collection) renderCollection();
  toast('Morceau supprimé');
}

async function importFiles(files) {
  if (!files.length) return;
  persistStorage();
  state.importing.total += files.length;
  renderImport();
  renderLibrary();
  const failures = [];
  for (const [index, file] of files.entries()) {
    try {
      const { track, blob } = await importFile(file);
      await db.addTrack(track, blob);
      state.tracks.set(track.id, track);
      sync?.trackAdded(track);
    } catch (error) {
      failures.push(error?.name === 'QuotaExceededError' ? `« ${file.name} » : plus assez d'espace sur le téléphone.` : `« ${file.name} » n'a pas pu être importé.`);
    }
    state.importing.done += 1;
    renderImport();
    // La liste se remplit au fur et à mesure, sans tout redessiner à chaque fichier.
    if (index % 15 === 14) renderLibrary();
  }
  state.importing = { total: 0, done: 0 };
  renderImport();
  renderLibrary();
  if (failures.length) notice('Certains fichiers n\'ont pas été importés', failures.join('\n'));
  else toast(files.length === 1 ? 'Morceau importé' : `${files.length} morceaux importés`);
}

function renderImport() {
  const { total, done } = state.importing;
  const receiving = !total && lastSync.receiving > 0;
  $('import-progress').hidden = total === 0 && !receiving;
  if (receiving) {
    const all = lastSync.received + lastSync.receiving;
    $('import-label').textContent = `Réception depuis ${lastSync.connected?.[0] || 'l\'autre appareil'} : ${Math.min(lastSync.received + 1, all)} sur ${all}…`;
    $('import-fill').style.transform = `scaleX(${lastSync.received / all})`;
    return;
  }
  if (!total) return;
  $('import-label').textContent = `Import de ${Math.min(done + 1, total)} sur ${total}…`;
  $('import-fill').style.transform = `scaleX(${done / total})`;
}

// MARK: Gestes natifs

function setupNativeGestures() {
  // Bord gauche → retour. Dans un onglet Safari, ce geste appartient au navigateur : seulement dans l'app installée.
  const library = $('library');
  setupEdgeBack($('collection'), {
    canStart: () => !!state.collection && !state.editing && (isStandalone() || !isIOS()),
    onBack: closeCollection,
    onProgress: (p, released) => {
      if (released) {
        library.style.transition = '';
        library.style.transform = '';
        library.style.opacity = '';
        return;
      }
      library.style.transition = 'none';
      library.style.transform = `translateX(${-28 + 28 * p}%)`;
      library.style.opacity = String(0.6 + 0.4 * p);
    },
  });
  // Glisser une ligne : à droite « Lire ensuite », à gauche favori.
  const actions = {
    enabled: () => !state.selecting && !state.editing,
    right: { label: 'Lire ensuite', color: 'var(--accent)', on: 'var(--on-accent)', icon: icon.playNext, run: (row) => queueNext(state.tracks.get(row.dataset.id)) },
    left: { label: 'Favori', color: '#E0245E', on: '#fff', icon: heartSVG('i'), run: (row) => toggleFav(state.tracks.get(row.dataset.id)) },
  };
  setupRowSwipe($('tracks'), actions);
  setupRowSwipe($('col-tracks'), actions);
}

// MARK: Réordonner une playlist

function setupReorder() {
  const list = $('col-tracks');
  let drag = null;
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-action="drag"]');
    if (!handle) return;
    e.preventDefault();
    const row = handle.closest('.row');
    const rows = [...list.querySelectorAll('.row')];
    drag = { row, rows, from: rows.indexOf(row), to: rows.indexOf(row), y: e.clientY, h: row.offsetHeight, id: e.pointerId };
    row.classList.add('dragging');
    rows.forEach((r) => r !== row && r.classList.add('shifting'));
    handle.setPointerCapture(e.pointerId);
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    drag.row.style.transform = `translateY(${dy}px) scale(1.02)`;
    const to = Math.max(0, Math.min(drag.rows.length - 1, drag.from + Math.round(dy / drag.h)));
    drag.to = to;
    drag.rows.forEach((r, i) => {
      if (r === drag.row) return;
      let shift = 0;
      if (drag.from < to && i > drag.from && i <= to) shift = -drag.h;
      if (to < drag.from && i >= to && i < drag.from) shift = drag.h;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  });
  const end = async (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { from, to } = drag;
    drag = null;
    const playlist = state.collection?.kind === 'playlist' && playlistById(state.collection.key);
    if (playlist && from !== to) {
      const ids = playlistTracks(playlist).map((t) => t.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      playlist.trackIds = ids;
      await savePlaylist(playlist);
      renderCarousel();
    }
    renderCollection();
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}

// MARK: Branchements

function bind() {
  const pickFiles = () => $('file-input').click();
  $('import-btn').onclick = pickFiles;
  $('empty-import').onclick = pickFiles;
  $('file-input').onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    importFiles(files);
  };
  // La liste n'est redessinée qu'après une courte pause dans la frappe.
  let searchTimer = null;
  $('search').oninput = (e) => {
    const value = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = value;
      renderLibrary();
    }, value ? 120 : 0);
  };
  $('tabs').onclick = (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) setTab(tab.dataset.tab);
  };
  $('play-all').onclick = () => playList(filtered(), 0, false);
  $('shuffle-all').onclick = () => {
    const tracks = filtered();
    playList(tracks, Math.floor(Math.random() * tracks.length), true);
  };

  const onTrackList = (getTracks) => (e) => {
    const row = e.target.closest('.row');
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!row || !action) return;
    const track = state.tracks.get(row.dataset.id);
    if (action === 'more') return openTrackActions(track);
    if (action === 'play') playList(getTracks(), Number(row.dataset.index));
  };
  $('tracks').onclick = (e) => {
    if (state.selecting) {
      const row = e.target.closest('.row');
      if (!row) return;
      const id = row.dataset.id;
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      row.classList.toggle('selected', state.selected.has(id));
      row.querySelector('.main').setAttribute('aria-pressed', String(state.selected.has(id)));
      renderSelectBar();
      return;
    }
    onTrackList(filtered)(e);
  };
  $('select-btn').onclick = () => setSelecting(true);
  $('select-done').onclick = () => setSelecting(false);
  $('select-all').onclick = () => {
    const ids = filtered().map((t) => t.id);
    const all = ids.every((id) => state.selected.has(id));
    state.selected = new Set(all ? [] : ids);
    renderLibrary();
  };
  $('select-bar').onclick = (e) => {
    const kind = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (kind) bulkAction(kind);
  };
  $('recent').onclick = (e) => {
    const card = e.target.closest('[data-recent]');
    if (card) playList(recentlyPlayed([...state.tracks.values()], 12), Number(card.dataset.recent), false);
  };
  $('artists').onclick = (e) => {
    const button = e.target.closest('[data-artist]');
    if (button) openCollection({ kind: 'artist', key: button.dataset.artist });
  };
  $('albums').onclick = (e) => {
    const button = e.target.closest('[data-album]');
    if (button) openCollection({ kind: 'album', key: button.dataset.album });
  };
  $('moods').onclick = (e) => {
    const chip = e.target.closest('[data-mood]');
    if (chip) openCollection({ kind: 'mood', key: chip.dataset.mood });
  };
  $('journal-btn').onclick = () => openCollection({ kind: 'journal' });
  $('col-radio').onclick = () => state.collection?.kind === 'artist' && startRadio(state.collection.key);
  $('carousel').onclick = async (e) => {
    if (e.target.closest('[data-mix]')) return openCollection({ kind: 'mix' });
    if (e.target.closest('[data-rated]')) return openCollection({ kind: 'rated' });
    const card = e.target.closest('[data-playlist]');
    if (card) return openCollection({ kind: 'playlist', key: card.dataset.playlist });
    if (e.target.closest('[data-favorites]')) return openCollection({ kind: 'favorites' });
    const smart = e.target.closest('[data-smart]');
    if (smart) return openCollection({ kind: 'smart', key: smart.dataset.smart });
    const monthly = e.target.closest('[data-recap]');
    if (monthly) return openRecap(monthly.dataset.recap);
    if (e.target.closest('[data-action="new-playlist"]')) {
      const playlist = await createPlaylist();
      if (playlist) openCollection({ kind: 'playlist', key: playlist.id });
    }
  };

  const collectionTracks = () => collectionData(state.collection)?.tracks || [];
  const currentPlaylist = () => (state.collection?.kind === 'playlist' ? playlistById(state.collection.key) : null);
  $('back-btn').onclick = closeCollection;
  $('edit-btn').onclick = () => {
    state.editing = !state.editing;
    renderCollection();
  };
  $('col-menu-btn').onclick = () => {
    const c = state.collection;
    if (c?.kind === 'playlist' && currentPlaylist()) openPlaylistMenu(currentPlaylist());
    if (c?.kind === 'artist' || c?.kind === 'album') openGroupMenu(c.kind, c.key);
  };
  $('col-add-empty').onclick = () => currentPlaylist() && openTrackPicker(currentPlaylist());
  $('col-play').onclick = () => playList(collectionTracks(), 0, false);
  $('col-shuffle').onclick = () => {
    const tracks = collectionTracks();
    playList(tracks, Math.floor(Math.random() * tracks.length), true);
  };
  $('col-tracks').addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    const action = e.target.closest('[data-action]')?.dataset.action;
    const playlist = currentPlaylist();
    if (row && action === 'remove' && playlist) {
      const ids = playlistTracks(playlist).map((t) => t.id);
      ids.splice(Number(row.dataset.index), 1);
      playlist.trackIds = ids;
      await savePlaylist(playlist);
      renderCollection();
      renderCarousel();
      return;
    }
    onTrackList(collectionTracks)(e);
  });

  $('mini-toggle').onclick = togglePlay;
  $('mini-next').onclick = next;

  $('player-close').onclick = closePlayer;
  $('toggle').onclick = togglePlay;
  $('next').onclick = next;
  $('prev').onclick = () => previous();
  $('up-next').onclick = next;
  $('queue-btn').onclick = openQueue;
  $('lyrics-btn').onclick = toggleLyrics;
  $('lyrics').onclick = (e) => {
    const track = state.tracks.get(currentId);
    if (!track) return;
    if (e.target.closest('[data-edit-lyrics]')) return openLyricsEditor(track);
    if (e.target.closest('[data-search-lyrics]')) return searchLyrics(track);
    if (e.target.closest('[data-pick-lyrics]')) return openLyricsPicker(track);
    if (e.target.closest('[data-calib]')) {
      calibrating = track.id;
      renderLyricTools(track);
      return;
    }
    if (e.target.closest('[data-calib-done]')) {
      calibrating = false;
      renderLyricTools(track);
      return;
    }
    const shift = e.target.closest('[data-shift]');
    if (shift) return setLyricsOffset(track, (track.lyricsOffset || 0) + Number(shift.dataset.shift));
    const line = e.target.closest('[data-line]');
    if (!line) return;
    const lyric = lyricsLines[Number(line.dataset.line)];
    if (calibrating === track.id) {
      // Ligne touchée au moment où elle est chantée (moins le temps de réaction) : tout se recale.
      setLyricsOffset(track, (audio.currentTime || 0) - 0.25 - lyric.time);
      haptic();
      toast(`Paroles recalées (${fmtOffset(track.lyricsOffset)})`);
      return;
    }
    // Toucher une ligne y emmène la lecture.
    audio.currentTime = Math.max(0, lyric.time + (track.lyricsOffset || 0));
    userScrolledAt = 0;
  };
  for (const type of ['touchstart', 'wheel']) $('lyrics').addEventListener(type, () => { userScrolledAt = Date.now(); }, { passive: true });
  $('speed-btn').onclick = cycleSpeed;
  // Volume réglable sur ordinateur (sur iPhone, seuls les boutons du téléphone le changent).
  const volume = $('volume');
  volume.value = localStorage.getItem('uhqsic.volume') || '1';
  audio.volume = Number(volume.value);
  volume.oninput = () => {
    audio.volume = Number(volume.value);
    localStorage.setItem('uhqsic.volume', volume.value);
  };
  $('recap-close').onclick = closeRecap;
  $('fav-btn').onclick = () => toggleFav();
  $('shuffle').onclick = () => {
    queue.setShuffled(!queue.isShuffled);
    persistModes();
    renderModes();
    saveSession();
  };
  $('repeat').onclick = () => {
    queue.repeatMode = nextRepeatMode(queue.repeatMode);
    persistModes();
    renderModes();
  };
  $('player-menu').onclick = () => currentId && openTrackActions(state.tracks.get(currentId));

  const scrub = $('scrub');
  const scrubber = $('scrubber');
  const startScrub = () => { scrubbing = true; scrubber.classList.add('active'); updateProgress(); };
  const endScrub = () => {
    if (!scrubbing) return;
    audio.currentTime = Number(scrub.value);
    scrubbing = false;
    scrubber.classList.remove('active');
    updatePositionState();
  };
  scrub.addEventListener('pointerdown', startScrub);
  scrub.addEventListener('input', () => { if (!scrubbing) startScrub(); updateProgress(); });
  scrub.addEventListener('change', endScrub);
  scrub.addEventListener('pointerup', endScrub);

  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    audio.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      $('airplay-btn').hidden = e.availability !== 'available';
    });
    $('airplay-btn').onclick = () => audio.webkitShowPlaybackTargetPicker();
  }

  $('sheet-dim').onclick = closeSheet;
  setupSheetDrag($('sheet'), document.querySelector('#sheet .sheet-grabber'), $('sheet-dim'), { onClose: closeSheet });
  document.addEventListener('keydown', onKey);
  setupCollapsingHeader();
  setupPlayerGestures();
  setupMiniGestures();
  setupReorder();
  setupAZ();
  setupNativeGestures();
  renderSpeed();
}

// MARK: Clavier (ordinateur)

function onKey(e) {
  if (e.target.closest?.('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (!$('sheet').hidden) return closeSheet();
    if (isSettingsOpen()) return closeSettings();
    if (!$('recap').hidden) return closeRecap();
    if (isPlayerOpen()) return closePlayer();
    if (state.collection) return closeCollection();
    return;
  }
  if (e.key === '/' ) {
    e.preventDefault();
    $('search').focus();
    return;
  }
  if (!currentId) return;
  const actions = {
    ' ': togglePlay,
    k: togglePlay,
    ArrowRight: () => (e.shiftKey ? next() : (audio.currentTime = Math.min((audio.duration || 0) - 0.5, audio.currentTime + 10))),
    ArrowLeft: () => (e.shiftKey ? previous(true) : (audio.currentTime = Math.max(0, audio.currentTime - 10))),
    n: next,
    p: () => previous(true),
    l: toggleLyrics,
    f: () => toggleFav(),
    s: () => $('shuffle').click(),
  };
  const action = actions[e.key];
  if (!action) return;
  e.preventDefault();
  action();
}

// MARK: Appareils liés

let syncRefreshTimer = null;
const syncTouched = new Set();
/** Les changements reçus arrivent par rafales : un seul rafraîchissement de l'écran. */
function refreshFromSync(tracks = []) {
  for (const t of tracks) syncTouched.add(t);
  clearTimeout(syncRefreshTimer);
  syncRefreshTimer = setTimeout(() => {
    const touched = [...syncTouched];
    syncTouched.clear();
    for (const t of touched) forgetArt(t);
    if (touched.some((t) => t.id === currentId)) {
      renderedId = null;
      renderNowPlaying();
      updateMediaSession();
    }
    renderLibrary();
    if (state.collection) collectionData(state.collection) ? renderCollection() : closeCollection();
    if (isSettingsOpen()) renderDevices();
  }, 250);
}

let lastSync = { receiving: 0, received: 0 };
function onSyncStatus(s) {
  const wasReceiving = lastSync.receiving > 0;
  lastSync = s;
  renderImport();
  if (wasReceiving && !s.receiving && s.received) toast(`${s.received} morceau${s.received > 1 ? 'x' : ''} reçu${s.received > 1 ? 's' : ''}`);
  if (isSettingsOpen()) renderDevices();
}

function setupSync() {
  sync = createSync({
    tracks: () => [...state.tracks.values(), ...(pendingDeletion?.entries.map((e) => e.track) || [])],
    playlists: () => state.playlists,
    file: (id) => db.file(id),
    async applyMeta(meta) {
      const track = state.tracks.get(meta.id);
      if (!track || (meta.mtime || 0) <= (track.mtime || 0)) return;
      for (const f of SYNC_FIELDS) {
        if (f in meta) track[f] = meta[f];
        else delete track[f];
      }
      track.art = meta.art;
      track.thumb = meta.thumb;
      track.mtime = meta.mtime;
      await db.saveTrack(track);
      refreshFromSync([track]);
    },
    async addTrack(meta, blob) {
      if (state.tracks.has(meta.id)) return;
      const track = { ...meta, plays: Object.values(meta.playsBy || {}).reduce((a, b) => a + b, 0) };
      if (!track.lastPlayed) delete track.lastPlayed;
      await db.addTrack(track, blob);
      state.tracks.set(track.id, track);
      refreshFromSync();
    },
    async rekey(from, to) {
      const track = state.tracks.get(from);
      if (!track || state.tracks.has(to)) return;
      const blob = await db.file(from);
      const touched = state.playlists.filter((p) => p.trackIds.includes(from));
      for (const p of touched) p.trackIds = p.trackIds.map((id) => (id === from ? to : id));
      forgetArt(track);
      track.id = to;
      await db.rekeyTrack(from, track, blob, touched);
      state.tracks.delete(from);
      state.tracks.set(to, track);
      queue.items = queue.items.map((id) => (id === from ? to : id));
      if (currentId === from) {
        currentId = to;
        renderedId = to;
      }
      for (const month of Object.values(stats.months)) {
        if (!month.tracks?.[from]) continue;
        month.tracks[to] = (month.tracks[to] || 0) + month.tracks[from];
        delete month.tracks[from];
      }
      flushStats();
      for (const h of history) if (h[0] === from) h[0] = to;
      try { localStorage.setItem('uhqsic.history', JSON.stringify(history)); } catch { /* sans conséquence */ }
      saveSession();
      refreshFromSync();
    },
    async applyCounts(id, remote) {
      const track = state.tracks.get(id);
      if (!track || !remote) return;
      if (!track.playsBy && track.plays) track.playsBy = { [ME]: track.plays };
      const merged = mergeCounts(track, remote);
      if (!merged.changed) return;
      Object.assign(track, { playsBy: merged.playsBy, plays: merged.plays, lastPlayed: merged.lastPlayed });
      await db.saveTrack(track);
      refreshFromSync();
    },
    async applyPlaylist(p) {
      const index = state.playlists.findIndex((x) => x.id === p.id);
      if (index >= 0) state.playlists[index] = p;
      else state.playlists.push(p);
      await db.savePlaylist(p);
      refreshFromSync();
    },
    async deleteTrack(id) {
      const track = state.tracks.get(id);
      if (track) await deleteTrack(track, { quiet: true, fromSync: true });
      refreshFromSync();
    },
    async deletePlaylist(id) {
      if (!state.playlists.some((p) => p.id === id)) return;
      state.playlists = state.playlists.filter((p) => p.id !== id);
      await db.deletePlaylist(id);
      refreshFromSync();
    },
    changed: onSyncStatus,
  });
  sync.start();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync.wake(); });
  window.addEventListener('online', () => sync.wake());
}

function renderDevices() {
  const box = $('devices-group');
  if (!box) return;
  const link = linkInfo();
  const s = sync?.status() || {};
  const devices = link?.devices || [];
  const transfer = s.receiving ? `<div class="setting"><span class="label">Réception de la musique</span><span class="value">${s.received} sur ${s.received + s.receiving}</span></div>` : '';
  box.innerHTML = devices.length
    ? `<button class="setting" data-rename-self><span class="label">Cet appareil</span><span class="value">${esc(deviceName())}</span>${icon.pencil}</button>
      ${devices.map((d) => {
      const on = s.connectedIds?.includes(d.id);
      return `<button class="setting" data-rename-device="${esc(d.id)}"><span class="label device-label">${icon.link} ${esc(deviceLabel(d))}</span><span class="value device-state${on ? ' on' : ''}">${on ? 'Connecté' : 'App fermée'}</span></button>`;
    }).join('')}${transfer}
      ${s.error ? `<div class="setting"><span class="label">${esc(s.error)}</span></div>` : ''}
      <button class="setting" data-open="pair"><span class="label">Lier un autre appareil</span>${icon.plus}</button>
      <button class="setting danger" data-open="unlink"><span class="label">Délier cet appareil</span></button>`
    : `<button class="setting" data-open="pair"><span class="label">Afficher un code de liaison</span>${icon.link}</button>
      <button class="setting" data-open="join"><span class="label">J'ai un code</span>${icon.plus}</button>`;
}

function openPairing() {
  openSheet(`
    <h3>Lier un appareil</h3>
    <p class="sheet-sub">Sur l'autre appareil, ouvre Uhqsic, puis Réglages, Appareils liés, « J'ai un code ».</p>
    <div class="pair-code" data-code aria-live="polite">· · · · · ·</div>
    <p class="sheet-sub center" data-pair-status>Préparation du code…</p>
  `, (body) => {
    let shown = true; // la feuille du code est à l'écran
    let confirming = false; // la fenêtre « Lier ? » l'a remplacée : la liaison continue
    sync.startPairing((name) => {
      toast(`Lié à ${name}`);
      if (isSettingsOpen()) renderDevices();
    }, async (name) => {
      // L'autre appareil a tapé le code : on demande l'accord ici.
      confirming = true;
      const yes = await ask({ title: `Lier « ${name} » ?`, message: 'Cet appareil verra et modifiera ta bibliothèque : musique, playlists, favoris, paroles. Accepte seulement si c\'est le tien ou celui d\'un pote de confiance.', ok: 'Lier', cancel: 'Refuser' });
      return yes;
    }).then((code) => {
      if (!shown) return;
      body.querySelector('[data-code]').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
      body.querySelector('[data-pair-status]').textContent = 'Garde cet écran ouvert pendant la saisie.';
    }).catch(() => {
      if (shown) body.querySelector('[data-pair-status]').textContent = 'Impossible de créer un code. Vérifie la connexion internet.';
    });
    return () => {
      shown = false;
      if (!confirming) sync.cancelPairing();
    };
  });
}

function openJoin() {
  openSheet(`
    <h3>J'ai un code</h3>
    <p class="sheet-sub">Sur l'autre appareil : Réglages, Appareils liés, « Afficher un code de liaison ».</p>
    <form class="edit-form" data-join>
      <label class="field"><span class="field-label">Code</span>
        <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" enterkeyhint="go">
      </label>
      <p class="sheet-sub" data-join-status></p>
      <div class="sheet-footer">
        <button type="button" class="soft-btn" data-cancel>Annuler</button>
        <button type="submit" class="accent-btn">Lier</button>
      </div>
    </form>
  `, (body) => {
    const form = body.querySelector('[data-join]');
    const status = body.querySelector('[data-join-status]');
    body.querySelector('[data-cancel]').onclick = closeSheet;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const code = form.elements.code.value.replace(/\D/g, '');
      if (code.length !== 6) {
        status.textContent = 'Le code a 6 chiffres.';
        return;
      }
      status.textContent = 'Connexion…';
      form.querySelector('[type="submit"]').disabled = true;
      try {
        const name = await sync.joinWithCode(code, () => { status.textContent = 'Accepte la liaison sur l\'autre appareil…'; });
        closeSheet();
        toast(`Lié à ${name}`);
        if (isSettingsOpen()) renderDevices();
      } catch (error) {
        status.textContent = error?.message === 'code'
          ? 'Code introuvable. Vérifie qu\'il est toujours affiché sur l\'autre appareil.'
          : error?.message === 'refus'
            ? 'La liaison a été refusée sur l\'autre appareil.'
            : error?.message === 'attente'
              ? 'Pas de réponse de l\'autre appareil. Recommence avec un nouveau code.'
              : 'Connexion impossible. Vérifie internet sur les deux appareils.';
        form.querySelector('[type="submit"]').disabled = false;
      }
    };
  });
}

// MARK: Démarrage

async function start() {
  await restorePersisted();
  ME = deviceId();
  queue.repeatMode = Number(localStorage.getItem('uhqsic.repeat') || 0) % 3;
  queue.isShuffled = localStorage.getItem('uhqsic.shuffle') === '1';
  applyPrefs();
  bind();
  bindSettings();
  registerMediaSession();
  setupAudioSession();
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  document.addEventListener('touchend', unlockAudio, { capture: true });
  renderLibrary();
  try {
    const [tracks, playlists] = await Promise.all([db.allTracks(), db.allPlaylists()]);
    for (const t of tracks) state.tracks.set(t.id, t);
    state.playlists = playlists;
  } catch {
    notice('Bibliothèque illisible', 'Impossible d\'ouvrir la bibliothèque. Ferme l\'app et rouvre-la.');
  }
  state.loaded = true;
  renderLibrary();
  restoreSession();
  maybeWelcome();
  setupSync();
  if ('serviceWorker' in navigator) {
    // Une nouvelle version s'installe en arrière-plan ; elle s'applique au prochain lancement,
    // ou tout de suite avec « Relancer ».
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Nouvelle version installée', { action: 'Relancer', onAction: () => location.reload(), duration: 8000 });
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if ($('welcome').hidden) setTimeout(maybeSuggestInstall, 1500);
}

start();
