// Appareils liés : le PC et le téléphone gardent la même bibliothèque.
// Connexion directe entre les appareils (WebRTC). Le serveur public de PeerJS sert seulement
// à se trouver ; la musique et les infos passent d'un appareil à l'autre sans être stockées ailleurs.
// Les deux appareils doivent avoir l'app ouverte en même temps ; tout ce qui a changé entre-temps
// est rattrapé à la connexion suivante.

const LINK = 'uhqsic.link';
const DEVICE = 'uhqsic.device';
const TOMBS = 'uhqsic.tombs';
const ALIAS = 'uhqsic.alias';
const PREFIX = 'uhqsic5';
const CHUNK = 64 * 1024;

// Champs modifiables par l'utilisateur, recopiés d'un appareil à l'autre.
export const SYNC_FIELDS = ['title', 'artist', 'album', 'fav', 'lyrics', 'syncedLyrics', 'lyricsInstrumental', 'lyricsChecked', 'lyricsSource', 'lyricsOffset', 'lyricsLength', 'rating', 'moods', 'tint'];
const BLOB_FIELDS = ['art', 'thumb'];

const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
// Copie de secours dans IndexedDB : si l'app est tuée net (iPhone qui ferme l'app en arrière-plan),
// localStorage peut perdre ses dernières écritures, IndexedDB non. Le lien et l'identité de
// l'appareil y sont donc recopiés, et restaurés au démarrage s'il le faut.
function kv(mode, work) {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open('uhqsic-kv', 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('kv', mode);
      const pending = work(tx.objectStore('kv'));
      tx.oncomplete = () => {
        db.close();
        resolve(pending?.result ?? null);
      };
      tx.onerror = () => {
        db.close();
        resolve(null);
      };
    };
  });
}
const backup = (key, raw) => kv('readwrite', (store) => (raw === null ? store.delete(key) : store.put(raw, key)));

const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Stockage plein : sans conséquence immédiate.
  }
  if (key === LINK) backup(key, JSON.stringify(value));
};

/** Au démarrage : remet le lien et l'identité de l'appareil s'ils ont disparu de localStorage. */
export async function restorePersisted() {
  for (const key of [LINK, DEVICE]) {
    const raw = localStorage.getItem(key);
    if (raw) {
      backup(key, raw);
      continue;
    }
    const saved = await kv('readonly', (store) => store.get(key));
    if (saved) {
      try {
        localStorage.setItem(key, saved);
      } catch {
        // Sans conséquence : la copie de secours reste disponible.
      }
    }
  }
}
/**
 * Preuve de la clé du groupe : HMAC-SHA256 d'un défi aléatoire. La clé ne circule jamais ;
 * un appareil qui ne la connaît pas ne peut ni lire ni modifier la bibliothèque.
 * Anciens liens (avant la clé) : l'identifiant du groupe sert de clé.
 */
export async function proof(secret, challenge) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(challenge));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const groupSecret = () => linkInfo()?.secret || linkInfo()?.group || '';

const randomId = (n = 10) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

export function deviceId() {
  let id = localStorage.getItem(DEVICE);
  if (!id) {
    id = randomId(8);
    localStorage.setItem(DEVICE, id);
    backup(DEVICE, id);
  }
  return id;
}

/** Nom choisi pour cet appareil (« iPhone de Malik »), sinon deviné. */
export function deviceName() {
  return localStorage.getItem('uhqsic.deviceName') || guessDeviceName();
}

/** Nom affiché pour un autre appareil : le surnom donné ici, sinon le nom qu'il annonce. */
export function deviceLabel(device) {
  return linkInfo()?.labels?.[device.id] || device.name || 'Appareil';
}

export function setDeviceLabel(id, label) {
  const link = linkInfo();
  if (!link) return;
  link.labels = { ...(link.labels || {}) };
  if (label) link.labels[id] = label;
  else delete link.labels[id];
  write(LINK, link);
}

export function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Téléphone Android' : 'Tablette Android';
  if (/Windows/.test(ua)) return 'PC Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'PC Linux';
  return 'Appareil';
}

/** Somme des écoutes de chaque appareil : rien ne se perd, rien n'est compté deux fois. */
export function mergeCounts(local, remote) {
  const playsBy = { ...(local.playsBy || {}) };
  for (const [device, n] of Object.entries(remote.playsBy || {})) playsBy[device] = Math.max(playsBy[device] || 0, n);
  const plays = Object.values(playsBy).reduce((a, b) => a + b, 0);
  const lastPlayed = Math.max(local.lastPlayed || 0, remote.lastPlayed || 0) || undefined;
  const changed = plays !== (local.plays || 0) || (lastPlayed || 0) !== (local.lastPlayed || 0) || JSON.stringify(playsBy) !== JSON.stringify(local.playsBy || {});
  return { playsBy, plays, lastPlayed, changed };
}

/**
 * Ce que l'appareil doit faire en recevant l'inventaire de l'autre : morceaux identiques à
 * rapprocher (même fichier importé des deux côtés), infos à demander, fichiers à recevoir.
 */
export function planSync(local, remote, tombs = { tracks: {}, playlists: {} }) {
  const localById = new Map(local.tracks.map((t) => [t.id, t]));
  const remoteIds = new Set(remote.tracks.map((t) => t.id));
  const plan = { rekey: [], meta: [], files: [], counts: [], deletes: [], playlists: [], deletePlaylists: [] };
  for (const [id, at] of Object.entries(remote.tombs?.tracks || {})) {
    const t = localById.get(id);
    if (t && (t.mtime || 0) <= at) plan.deletes.push(id);
  }
  const used = new Set();
  for (const r of remote.tracks) {
    if (tombs.tracks?.[r.id] >= (r.mtime || 0)) continue;
    if (remote.tombs?.tracks?.[r.id]) continue;
    let mine = localById.get(r.id);
    if (!mine) {
      // Même fichier déjà présent ici sous un autre identifiant : on adopte le même des deux côtés.
      mine = local.tracks.find((t) => !used.has(t.id) && !remoteIds.has(t.id) && t.fileName === r.fileName && Math.abs((t.duration || 0) - (r.duration || 0)) <= 2);
      if (mine) {
        const shared = mine.id < r.id ? mine.id : r.id;
        if (shared !== mine.id) plan.rekey.push([mine.id, shared]);
        used.add(mine.id);
        mine = { ...mine, id: shared };
      }
    }
    if (!mine) {
      plan.files.push(r.id);
      continue;
    }
    used.add(mine.id);
    if ((r.mtime || 0) > (mine.mtime || 0)) plan.meta.push(mine.id);
    plan.counts.push([mine.id, r.id]);
  }
  const localPlaylists = new Map(local.playlists.map((p) => [p.id, p]));
  for (const [id, at] of Object.entries(remote.tombs?.playlists || {})) {
    const p = localPlaylists.get(id);
    if (p && (p.mtime || 0) <= at) plan.deletePlaylists.push(id);
  }
  for (const p of remote.playlists) {
    if (tombs.playlists?.[p.id] >= (p.mtime || 0) || remote.tombs?.playlists?.[p.id]) continue;
    const mine = localPlaylists.get(p.id);
    if (!mine || (p.mtime || 0) > (mine.mtime || 0)) plan.playlists.push(p.id);
  }
  return plan;
}

export const isLinked = () => !!read(LINK, null)?.group;
export const linkInfo = () => read(LINK, null);
export const tombs = () => read(TOMBS, { tracks: {}, playlists: {} });
export const alias = () => read(ALIAS, {});

export function addTomb(kind, id, at = Date.now()) {
  const t = tombs();
  t[kind][id] = at;
  write(TOMBS, t);
}

export function addAlias(from, to) {
  const a = alias();
  a[from] = to;
  write(ALIAS, a);
}

/**
 * `host` fournit l'accès à la bibliothèque :
 * tracks(), playlists(), file(id), applyMeta(meta), addTrack(meta, blob), rekey(from, to),
 * applyCounts(id, counts), applyPlaylist(p), deleteTrack(id), deletePlaylist(id), changed(status).
 */
export function createSync(host) {
  const me = deviceId();
  const conns = new Map(); // appareil → connexion ouverte
  const incoming = new Map(); // fichier en cours de réception
  const wanted = []; // fichiers à demander, un à la fois
  let asking = null;
  let peer = null;
  let pairPeer = null;
  let retryTimer = null;
  let beatTimer = null;
  let openedAt = 0;
  let sending = Promise.resolve();
  const status = { linked: isLinked(), connected: [], receiving: 0, received: 0, sending: 0, error: '' };

  const emit = () => {
    status.linked = isLinked();
    status.connectedIds = [...conns.keys()];
    status.connected = status.connectedIds.map((id) => deviceLabel(linkInfo()?.devices?.find((d) => d.id === id) || { id }));
    host.changed?.({ ...status });
  };

  // Plusieurs places par appareil : si l'app a été fermée net, le serveur garde l'ancienne
  // place réservée une minute ; on prend la suivante et l'autre appareil essaie toutes les places.
  const SLOTS = 3;
  let slot = 0;
  const trying = new Set();
  const peerId = (group, device, n) => `${PREFIX}-${group}-${device}-${n}`;
  const options = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } };

  function saveDevices(devices) {
    const link = linkInfo();
    if (!link) return;
    const all = new Map((link.devices || []).map((d) => [d.id, d]));
    for (const d of devices || []) if (d.id !== me) all.set(d.id, { id: d.id, name: d.name });
    link.devices = [...all.values()];
    write(LINK, link);
  }

  // MARK: Connexion

  function start() {
    const link = linkInfo();
    if (!link?.group || peer || !window.Peer) return;
    peer = new window.Peer(peerId(link.group, me, slot), options);
    peer.on('open', () => {
      status.error = '';
      openedAt = Date.now();
      connectAll();
    });
    peer.on('connection', (conn) => setup(conn));
    peer.on('disconnected', () => {
      if (!peer.destroyed) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000);
    });
    peer.on('error', (error) => {
      if (error.type === 'unavailable-id') {
        // Place encore occupée par l'ancienne session : on prend la suivante.
        stop();
        slot = (slot + 1) % SLOTS;
        setTimeout(start, slot === 0 ? 5000 : 200);
      } else if (error.type === 'network' || error.type === 'server-error' || error.type === 'socket-error') {
        status.error = 'Pas de connexion internet';
        emit();
      }
      // « peer-unavailable » : l'autre appareil n'a pas l'app ouverte, c'est normal.
    });
    clearInterval(retryTimer);
    retryTimer = setInterval(connectAll, 7000);
    // Battement de cœur : un appareil fermé net est repéré en quelques secondes.
    clearInterval(beatTimer);
    beatTimer = setInterval(() => {
      for (const c of [...conns.values()]) {
        if (Date.now() - (c.lastSeen || 0) > 16000) {
          c.cleanup?.();
          c.close();
        } else {
          send(c, { t: 'ping' });
        }
      }
      if (!conns.size) connectAll();
    }, 5000);
  }

  function stop() {
    clearInterval(retryTimer);
    clearInterval(beatTimer);
    for (const c of conns.values()) c.close();
    conns.clear();
    peer?.destroy();
    peer = null;
    emit();
  }

  function connectAll() {
    const link = linkInfo();
    if (!peer?.open || !link || document.hidden) return;
    for (const d of link.devices || []) {
      // L'appareil au plus petit identifiant appelle l'autre ; l'autre n'appelle qu'en secours,
      // si personne ne l'a appelé après quelques secondes.
      if (conns.has(d.id) || (d.id > me && Date.now() - openedAt < 12000)) continue;
      for (let n = 0; n < SLOTS; n++) {
        const key = `${d.id}-${n}`;
        if (trying.has(key)) continue;
        trying.add(key);
        const conn = peer.connect(peerId(link.group, d.id, n), { reliable: true, serialization: 'binary', metadata: { device: me } });
        setup(conn);
        // Une place vide ou fantôme ne répond pas : on abandonne cette tentative.
        const giveUp = setTimeout(() => { if (!conn.open) conn.close(); }, 6500);
        const done = () => { clearTimeout(giveUp); trying.delete(key); };
        conn.on('open', () => { clearTimeout(giveUp); trying.delete(key); });
        conn.on('close', done);
        conn.on('error', done);
      }
    }
  }

  function setup(conn) {
    let device = null; // connu au « hello », accepté seulement après la preuve de la clé
    let queue = Promise.resolve();
    let trusted = false;
    let claimed = null; // { device, devices } annoncés avant la preuve
    const nonce = randomId(16);
    conn.on('open', () => {
      conn.lastSeen = Date.now();
      send(conn, { t: 'hello', device: me, name: deviceName(), nonce });
    });
    conn.on('data', (msg) => {
      conn.lastSeen = Date.now();
      if (msg?.t === 'ping') return;
      // Avant la preuve : seuls « hello » et « auth » sont écoutés.
      if (msg?.t === 'hello' && typeof msg.nonce === 'string' && typeof msg.device === 'string') {
        claimed = { device: msg.device, name: msg.name };
        proof(groupSecret(), `${msg.nonce}:${me}`).then((mac) => send(conn, { t: 'auth', mac }));
        return;
      }
      if (msg?.t === 'auth' && claimed && !trusted) {
        proof(groupSecret(), `${nonce}:${claimed.device}`).then((expected) => {
          if (msg.mac !== expected) {
            // Mauvaise clé : on coupe sans rien révéler.
            conn.close();
            return;
          }
          trusted = true;
          accept(claimed);
        });
        return;
      }
      if (!trusted) return;
      if (msg?.t === 'devices') {
        saveDevices(msg.devices);
        emit();
        return;
      }
      // Un message à la fois, dans l'ordre : l'inventaire est traité avant les demandes qui suivent.
      queue = queue.then(() => handle(conn, msg)).catch((error) => console.warn('synchro', error));
    });
    const accept = (hello) => {
      device = hello.device;
      const old = conns.get(device);
      if (old && old !== conn) {
        // Deux connexions entre les mêmes appareils : les deux côtés gardent la même,
        // celle ouverte par le plus petit identifiant (sauf si elle ne répond plus).
        const preferred = me < device ? me : device;
        const oldAlive = Date.now() - (old.lastSeen || 0) < 6000;
        if (oldAlive && old.metadata?.device === preferred && conn.metadata?.device !== preferred) {
          device = null;
          conn.close();
          return;
        }
        old.cleanup?.();
        old.close();
      }
      conns.set(device, conn);
      saveDevices([{ id: hello.device, name: hello.name }]);
      emit();
      send(conn, { t: 'devices', devices: [{ id: me, name: deviceName() }, ...(linkInfo()?.devices || [])] });
      sendManifest(conn);
    };
    const closed = () => {
      // Une tentative qui n'a jamais abouti ne touche à rien.
      if (!device || conns.get(device) !== conn) return;
      conns.delete(device);
      if (asking?.conn === conn) {
        incoming.delete(asking.id);
        asking = null;
      }
      for (let i = wanted.length - 1; i >= 0; i--) if (wanted[i].conn === conn) wanted.splice(i, 1);
      status.receiving = wanted.length;
      if (!status.receiving) status.received = 0;
      emit();
      askNext();
    };
    conn.cleanup = closed;
    conn.on('close', closed);
    conn.on('error', closed);
  }

  function send(conn, msg) {
    try {
      if (conn.open) conn.send(msg);
    } catch (error) {
      console.warn('envoi', error);
    }
  }

  const broadcast = (msg) => {
    for (const c of conns.values()) send(c, msg);
  };

  // MARK: Inventaire et échanges

  async function sendManifest(conn) {
    const tracks = host.tracks().map((t) => ({ id: t.id, fileName: t.fileName, duration: Math.round(t.duration || 0), mtime: t.mtime || 0, playsBy: t.playsBy || (t.plays ? { [me]: t.plays } : {}), lastPlayed: t.lastPlayed || 0 }));
    const playlists = host.playlists().map((p) => ({ id: p.id, mtime: p.mtime || p.createdAt || 0 }));
    send(conn, { t: 'manifest', tracks, playlists, tombs: tombs() });
  }

  async function serializeTrack(track) {
    const meta = { id: track.id, fileName: track.fileName, duration: track.duration, addedAt: track.addedAt, mtime: track.mtime || 0, playsBy: track.playsBy || {}, lastPlayed: track.lastPlayed || 0 };
    for (const f of SYNC_FIELDS) if (track[f] !== undefined) meta[f] = track[f];
    for (const f of BLOB_FIELDS) {
      if (track[f]) {
        meta[f] = await track[f].arrayBuffer();
        meta[`${f}Type`] = track[f].type || 'image/jpeg';
      } else {
        meta[f] = null;
      }
    }
    return meta;
  }

  async function handle(conn, msg) {
    switch (msg?.t) {
      case 'manifest': {
        const local = { tracks: host.tracks(), playlists: host.playlists() };
        const plan = planSync(local, msg, tombs());
        for (const id of plan.deletes) await host.deleteTrack(id);
        for (const id of plan.deletePlaylists) await host.deletePlaylist(id);
        for (const [from, to] of plan.rekey) {
          addAlias(from, to);
          await host.rekey(from, to);
        }
        // Les tombes de l'autre appareil deviennent les nôtres.
        const mine = tombs();
        for (const kind of ['tracks', 'playlists']) {
          for (const [id, at] of Object.entries(msg.tombs?.[kind] || {})) mine[kind][id] = Math.max(mine[kind][id] || 0, at);
        }
        write(TOMBS, mine);
        const byId = new Map(msg.tracks.map((t) => [t.id, t]));
        for (const [id, remoteId] of plan.counts) await host.applyCounts(id, byId.get(remoteId));
        if (plan.meta.length) send(conn, { t: 'getMeta', ids: plan.meta });
        if (plan.playlists.length) send(conn, { t: 'getPlaylists', ids: plan.playlists });
        for (const id of plan.files) if (!wanted.some((w) => w.id === id)) wanted.push({ id, conn });
        status.receiving = wanted.length + (asking ? 1 : 0);
        status.received = 0;
        emit();
        askNext();
        return;
      }
      case 'getMeta':
        for (const id of msg.ids) {
          const t = host.tracks().find((x) => x.id === (alias()[id] || id));
          if (t) send(conn, { t: 'meta', track: await serializeTrack(t) });
        }
        return;
      case 'meta': {
        const track = revive(msg.track);
        track.id = alias()[track.id] || track.id;
        await host.applyMeta(track);
        return;
      }
      case 'counts':
        await host.applyCounts(alias()[msg.id] || msg.id, msg);
        return;
      case 'new':
        if (!host.tracks().some((t) => t.id === msg.id) && !wanted.some((w) => w.id === msg.id)) {
          wanted.push({ id: msg.id, conn });
          status.receiving += 1;
          emit();
          askNext();
        }
        return;
      case 'delete':
        addTomb('tracks', msg.id, msg.at);
        if (host.tracks().some((t) => t.id === msg.id)) await host.deleteTrack(msg.id);
        return;
      case 'getPlaylists':
        for (const id of msg.ids) {
          const p = host.playlists().find((x) => x.id === id);
          if (p) send(conn, { t: 'playlist', playlist: await serializePlaylist(p) });
        }
        return;
      case 'playlist': {
        const p = msg.playlist;
        const map = alias();
        p.trackIds = p.trackIds.map((id) => map[id] || id);
        if (p.cover?.art) p.cover = { ...p.cover, art: new Blob([p.cover.art], { type: 'image/jpeg' }), thumb: p.cover.thumb ? new Blob([p.cover.thumb], { type: 'image/jpeg' }) : null };
        const mine = host.playlists().find((x) => x.id === p.id);
        if (!mine || (p.mtime || 0) > (mine.mtime || 0)) await host.applyPlaylist(p);
        return;
      }
      case 'deletePlaylist':
        addTomb('playlists', msg.id, msg.at);
        await host.deletePlaylist(msg.id);
        return;
      case 'getFile':
        // Envoyé à part : la réception des messages continue pendant l'envoi d'un gros fichier.
        sending = sending.then(() => sendFile(conn, msg.id)).catch((error) => console.warn('envoi', error));
        return;
      case 'fileStart':
        incoming.set(msg.id, { meta: msg.track, parts: [], size: msg.size, type: msg.type });
        return;
      case 'chunk':
        incoming.get(msg.id)?.parts.push(msg.data);
        return;
      case 'fileEnd': {
        const file = incoming.get(msg.id);
        incoming.delete(msg.id);
        if (file) {
          const blob = new Blob(file.parts, { type: file.type || 'audio/mpeg' });
          if (blob.size === file.size) {
            await host.addTrack(revive(file.meta), blob);
            status.received += 1;
          }
        }
        asking = null;
        emit();
        askNext();
        return;
      }
      case 'noFile':
        asking = null;
        askNext();
        return;
      default:
    }
  }

  async function serializePlaylist(p) {
    const copy = { id: p.id, name: p.name, createdAt: p.createdAt, mtime: p.mtime || p.createdAt || 0, trackIds: [...p.trackIds] };
    if (p.cover?.art) copy.cover = { v: p.cover.v, tint: p.cover.tint, art: await p.cover.art.arrayBuffer(), thumb: p.cover.thumb ? await p.cover.thumb.arrayBuffer() : null };
    return copy;
  }

  function revive(meta) {
    const track = { ...meta };
    for (const f of BLOB_FIELDS) {
      track[f] = meta[f] ? new Blob([meta[f]], { type: meta[`${f}Type`] || 'image/jpeg' }) : null;
      delete track[`${f}Type`];
    }
    return track;
  }

  function askNext() {
    if (asking) return;
    while (wanted.length) {
      const next = wanted.shift();
      if (!next.conn.open || host.tracks().some((t) => t.id === next.id)) continue;
      asking = next;
      send(next.conn, { t: 'getFile', id: next.id });
      status.receiving = wanted.length + 1;
      emit();
      return;
    }
    status.receiving = 0;
    emit();
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function sendFile(conn, wantedId) {
    const id = alias()[wantedId] || wantedId;
    const track = host.tracks().find((t) => t.id === id);
    const blob = track && (await host.file(id));
    if (!blob) return send(conn, { t: 'noFile', id: wantedId });
    status.sending += 1;
    emit();
    try {
      send(conn, { t: 'fileStart', id, size: blob.size, type: blob.type, track: await serializeTrack(track) });
      for (let offset = 0; offset < blob.size && conn.open; offset += CHUNK) {
        // Le canal ne garde pas plus d'1 Mo en attente : pas d'explosion de mémoire.
        while (conn.open && ((conn.dataChannel?.bufferedAmount || 0) > 1024 * 1024 || (conn.bufferSize || 0) > 32)) await wait(15);
        send(conn, { t: 'chunk', id, data: await blob.slice(offset, offset + CHUNK).arrayBuffer() });
      }
      send(conn, { t: 'fileEnd', id });
    } finally {
      status.sending -= 1;
      emit();
    }
  }

  // MARK: Jumelage par code

  /** Affiche un code sur cet appareil ; `onPaired(name)` quand l'autre l'a saisi. */
  function startPairing(onPaired, confirmPair = async () => true) {
    cancelPairing();
    const link = linkInfo() || { group: randomId(10), devices: [] };
    link.secret ??= randomId(24);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    return new Promise((resolve, reject) => {
      if (!window.Peer) return reject(new Error('indisponible'));
      pairPeer = new window.Peer(`${PREFIX}-pair-${code}`, options);
      pairPeer.on('open', () => resolve(code));
      pairPeer.on('error', (error) => reject(error));
      pairPeer.on('connection', (conn) => {
        conn.on('data', async (msg) => {
          if (msg?.t !== 'pair' || conn.asked) return;
          conn.asked = true;
          // Rien ne se lie sans un « oui » sur cet appareil : deviner le code ne suffit pas.
          if (!(await confirmPair(String(msg.name || 'Appareil').slice(0, 40)))) {
            send(conn, { t: 'refused' });
            setTimeout(cancelPairing, 800);
            return;
          }
          write(LINK, { ...link, devices: [...(link.devices || []).filter((d) => d.id !== msg.device), { id: msg.device, name: msg.name }] });
          send(conn, { t: 'paired', group: link.group, secret: link.secret, devices: [{ id: me, name: deviceName() }, ...(link.devices || [])] });
          setTimeout(() => {
            cancelPairing();
            stop();
            start();
            onPaired?.(msg.name);
          }, 600);
        });
      });
    });
  }

  function cancelPairing() {
    pairPeer?.destroy();
    pairPeer = null;
  }

  /** Saisit le code affiché sur l'autre appareil. */
  function joinWithCode(code, onWaiting) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) return reject(new Error('indisponible'));
      const temp = new window.Peer(options);
      let timer = setTimeout(() => {
        temp.destroy();
        reject(new Error('code'));
      }, 15000);
      temp.on('error', (error) => {
        clearTimeout(timer);
        temp.destroy();
        reject(error.type === 'peer-unavailable' ? new Error('code') : error);
      });
      temp.on('open', () => {
        const conn = temp.connect(`${PREFIX}-pair-${code.replace(/\D/g, '')}`, { reliable: true, serialization: 'binary' });
        conn.on('open', () => {
          send(conn, { t: 'pair', device: me, name: deviceName() });
          // Connecté : on laisse une minute à l'autre appareil pour accepter.
          clearTimeout(timer);
          timer = setTimeout(() => {
            temp.destroy();
            reject(new Error('attente'));
          }, 60000);
          onWaiting?.();
        });
        conn.on('data', (msg) => {
          if (msg?.t === 'refused') {
            clearTimeout(timer);
            temp.destroy();
            reject(new Error('refus'));
            return;
          }
          if (msg?.t !== 'paired') return;
          clearTimeout(timer);
          write(LINK, { group: msg.group, secret: msg.secret, devices: msg.devices.filter((d) => d.id !== me) });
          setTimeout(() => {
            temp.destroy();
            stop();
            start();
            resolve(msg.devices[0]?.name || 'Appareil');
          }, 300);
        });
      });
    });
  }

  function unlink() {
    stop();
    localStorage.removeItem(LINK);
    backup(LINK, null);
    emit();
  }

  // MARK: Changements locaux envoyés en direct

  return {
    status: () => ({ ...status, linked: isLinked() }),
    start,
    stop,
    startPairing,
    cancelPairing,
    joinWithCode,
    unlink,
    wake() {
      if (!isLinked()) return;
      if (!peer || peer.destroyed) {
        peer = null;
        start();
      } else if (peer.disconnected) peer.reconnect();
      else connectAll();
    },
    async trackChanged(track) {
      if (conns.size) broadcast({ t: 'meta', track: await serializeTrack(track) });
    },
    countsChanged(track) {
      broadcast({ t: 'counts', id: track.id, playsBy: track.playsBy || {}, lastPlayed: track.lastPlayed || 0 });
    },
    trackAdded(track) {
      broadcast({ t: 'new', id: track.id });
    },
    trackDeleted(id) {
      const at = Date.now();
      addTomb('tracks', id, at);
      broadcast({ t: 'delete', id, at });
    },
    async playlistChanged(p) {
      if (conns.size) broadcast({ t: 'playlist', playlist: await serializePlaylist(p) });
    },
    playlistDeleted(id) {
      const at = Date.now();
      addTomb('playlists', id, at);
      broadcast({ t: 'deletePlaylist', id, at });
    },
  };
}
