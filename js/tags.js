// Lecture des tags (titre, artiste, album, pochette) et de la durée des MP3, M4A, FLAC et WAV.
// Ne lit que les octets utiles du fichier (Blob.slice), jamais le fichier entier :
// la durée vient des en-têtes, sans décoder l'audio (Safari iOS ne précharge rien sans geste).

const empty = () => ({ title: null, artist: null, album: null, picture: null, duration: null });

export async function readTags(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const sig = ascii(head, 0, 4);
    if (sig.startsWith('ID3')) {
      const tags = await readID3(blob, 0);
      const footer = head[5] & 0x10 ? 10 : 0;
      tags.duration = await mp3Duration(blob, 10 + synchsafe(head, 6) + footer);
      return tags;
    }
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return { ...empty(), duration: await mp3Duration(blob, 0) };
    if (sig === 'fLaC') return await readFLAC(blob);
    if (sig === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return await readWAV(blob);
    if (ascii(head, 4, 4) === 'ftyp') return await readMP4(blob);
  } catch {
    // Fichier mal formé : on retombe sur le nom de fichier.
  }
  return empty();
}

// MARK: Durée MP3

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = [44100, 48000, 32000];

/** Première trame après les tags : en-tête Xing/Info ou VBRI si présent, sinon débit constant. */
async function mp3Duration(blob, start) {
  const chunk = await bytesAt(blob, start, 65536);
  for (let i = 0; i + 4 < chunk.length; i++) {
    if (chunk[i] !== 0xff || (chunk[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (chunk[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (chunk[i + 1] >> 1) & 3; // 1 = Layer III
    const bitrateIndex = chunk[i + 2] >> 4;
    const rateIndex = (chunk[i + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) continue;
    const mpeg1 = version === 3;
    const sampleRate = MP3_RATES[rateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
    const samplesPerFrame = layer === 1 && !mpeg1 ? 576 : layer === 3 ? 384 : 1152;
    const mono = chunk[i + 3] >> 6 === 3;
    const side = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);

    const xing = i + 4 + side;
    const tag = ascii(chunk, xing, 4);
    if ((tag === 'Xing' || tag === 'Info') && be32(chunk, xing + 4) & 1) {
      return (be32(chunk, xing + 8) * samplesPerFrame) / sampleRate;
    }
    if (ascii(chunk, i + 36, 4) === 'VBRI') {
      return (be32(chunk, i + 36 + 14) * samplesPerFrame) / sampleRate;
    }
    const kbps = (mpeg1 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[bitrateIndex];
    return ((blob.size - start - i) * 8) / (kbps * 1000);
  }
  return null;
}

// MARK: Utilitaires

function ascii(bytes, start, length) {
  let s = '';
  for (let i = start; i < start + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

async function bytesAt(blob, start, length) {
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

function clean(text) {
  if (text == null) return null;
  const t = text.replace(/\0+$/g, '').trim();
  return t || null;
}

function decode(bytes, encoding) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function picture(mime, data) {
  if (!data || data.length < 16) return null;
  let type = (mime || '').toLowerCase();
  if (!type.includes('/')) type = type === 'png' ? 'image/png' : 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50) type = 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) type = 'image/jpeg';
  return { mime: type, data };
}

// MARK: ID3v2 (MP3, et WAV avec un bloc « id3 »)

async function readID3(blob, offset) {
  const header = await bytesAt(blob, offset, 10);
  const major = header[3];
  const size = synchsafe(header, 6);
  const tag = await bytesAt(blob, offset + 10, size);
  const result = empty();
  const v2 = major === 2;
  const idLength = v2 ? 3 : 4;
  const headerLength = v2 ? 6 : 10;
  const map = v2
    ? { TT2: 'title', TP1: 'artist', TAL: 'album' }
    : { TIT2: 'title', TPE1: 'artist', TALB: 'album' };

  let i = 0;
  // Saut de l'en-tête étendu (rare).
  if (!v2 && header[5] & 0x40) i = major === 4 ? synchsafe(tag, 0) : be32(tag, 0) + 4;

  while (i + headerLength <= tag.length) {
    const id = ascii(tag, i, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const frameSize = v2 ? be24(tag, i + 3) : major === 4 ? synchsafe(tag, i + 4) : be32(tag, i + 4);
    const start = i + headerLength;
    const body = tag.subarray(start, start + frameSize);
    if (map[id]) {
      result[map[id]] = clean(id3Text(body));
    } else if ((id === 'APIC' || id === 'PIC') && !result.picture) {
      result.picture = id3Picture(body, v2);
    }
    i = start + frameSize;
  }
  return result;
}

function id3Encoding(byte) {
  return ['latin1', 'utf-16', 'utf-16be', 'utf-8'][byte] || 'latin1';
}

function id3Text(body) {
  if (body.length < 2) return null;
  return decode(body.subarray(1), id3Encoding(body[0])).split('\0')[0];
}

function id3Picture(body, v2) {
  const encoding = body[0];
  let i = 1;
  let mime;
  if (v2) {
    mime = ascii(body, 1, 3);
    i = 4;
  } else {
    const end = body.indexOf(0, i);
    mime = ascii(body, i, end - i);
    i = end + 1;
  }
  i += 1; // type d'image
  // Description, terminée par 0 (ou 00 00 en UTF-16).
  if (encoding === 1 || encoding === 2) {
    while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2;
    i += 2;
  } else {
    while (i < body.length && body[i] !== 0) i += 1;
    i += 1;
  }
  return picture(mime, body.slice(i));
}

// MARK: FLAC

async function readFLAC(blob) {
  const result = empty();
  let offset = 4;
  for (let guard = 0; guard < 64; guard++) {
    const header = await bytesAt(blob, offset, 4);
    if (header.length < 4) break;
    const last = header[0] & 0x80;
    const type = header[0] & 0x7f;
    const length = be24(header, 1);
    if (type === 0) {
      const info = await bytesAt(blob, offset + 4, 18);
      const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
      const samples = (info[13] & 0x0f) * 2 ** 32 + be32(info, 14);
      if (sampleRate && samples) result.duration = samples / sampleRate;
    }
    if (type === 4 || type === 6) {
      const block = await bytesAt(blob, offset + 4, length);
      if (type === 4) Object.assign(result, vorbisComments(block, result));
      if (type === 6 && !result.picture) result.picture = flacPicture(block);
    }
    offset += 4 + length;
    if (last) break;
  }
  return result;
}

function vorbisComments(block, current) {
  const out = { title: current.title, artist: current.artist, album: current.album };
  let i = 4 + le32(block, 0);
  const count = le32(block, i);
  i += 4;
  for (let n = 0; n < count && i + 4 <= block.length; n++) {
    const length = le32(block, i);
    const entry = decode(block.subarray(i + 4, i + 4 + length), 'utf-8');
    i += 4 + length;
    const eq = entry.indexOf('=');
    const key = entry.slice(0, eq).toUpperCase();
    const value = clean(entry.slice(eq + 1));
    if (key === 'TITLE' && !out.title) out.title = value;
    if (key === 'ARTIST' && !out.artist) out.artist = value;
    if (key === 'ALBUM' && !out.album) out.album = value;
  }
  return out;
}

function flacPicture(block) {
  let i = 4;
  const mimeLength = be32(block, i);
  const mime = ascii(block, i + 4, mimeLength);
  i += 4 + mimeLength;
  i += 4 + be32(block, i); // description
  i += 16; // largeur, hauteur, profondeur, couleurs
  const dataLength = be32(block, i);
  return picture(mime, block.slice(i + 4, i + 4 + dataLength));
}

// MARK: MP4 / M4A

async function readMP4(blob) {
  const moov = await findAtom(blob, 0, blob.size, 'moov');
  if (!moov) return empty();
  const body = await bytesAt(blob, moov.start, moov.size);
  const result = empty();
  const mvhd = childAtom(body, 8, body.length, 'mvhd');
  if (mvhd) {
    const p = mvhd.start + 8;
    const v1 = body[p] === 1;
    const timescale = be32(body, p + (v1 ? 20 : 12));
    const length = v1 ? be32(body, p + 24) * 2 ** 32 + be32(body, p + 28) : be32(body, p + 16);
    if (timescale) result.duration = length / timescale;
  }
  const udta = childAtom(body, 8, body.length, 'udta');
  const meta = udta && childAtom(body, udta.start + 8, udta.end, 'meta');
  // « meta » est une full box : 4 octets de version/flags avant ses enfants.
  const ilst = meta && childAtom(body, meta.start + 12, meta.end, 'ilst');
  if (!ilst) return result;

  for (let i = ilst.start + 8; i + 8 <= ilst.end; ) {
    const size = be32(body, i);
    if (size < 8) break;
    const name = ascii(body, i + 4, 4);
    const data = childAtom(body, i + 8, i + size, 'data');
    if (data) {
      const type = be32(body, data.start + 8) & 0xffffff;
      const payload = body.subarray(data.start + 16, data.end);
      if (name === '©nam') result.title = clean(decode(payload, 'utf-8'));
      if (name === '©ART' || (name === 'aART' && !result.artist)) result.artist = clean(decode(payload, 'utf-8'));
      if (name === '©alb') result.album = clean(decode(payload, 'utf-8'));
      if (name === 'covr' && !result.picture) result.picture = picture(type === 14 ? 'image/png' : 'image/jpeg', payload.slice());
    }
    i += size;
  }
  return result;
}

/** Cherche un atome de premier niveau en ne lisant que les en-têtes. */
async function findAtom(blob, start, end, name) {
  let offset = start;
  for (let guard = 0; guard < 256 && offset + 8 <= end; guard++) {
    const header = await bytesAt(blob, offset, 16);
    let size = be32(header, 0);
    const type = ascii(header, 4, 4);
    if (size === 1) size = be32(header, 8) * 2 ** 32 + be32(header, 12);
    if (size === 0) size = end - offset;
    if (size < 8) return null;
    if (type === name) return { start: offset, size };
    offset += size;
  }
  return null;
}

function childAtom(bytes, start, end, name) {
  for (let i = start; i + 8 <= end; ) {
    const size = be32(bytes, i);
    if (size < 8) return null;
    if (ascii(bytes, i + 4, 4) === name) return { start: i, end: Math.min(i + size, end) };
    i += size;
  }
  return null;
}

// MARK: WAV

async function readWAV(blob) {
  const result = empty();
  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  for (let guard = 0; guard < 64 && offset + 8 <= blob.size; guard++) {
    const header = await bytesAt(blob, offset, 20);
    const id = ascii(header, 0, 4);
    const size = le32(header, 4);
    if (id === 'fmt ') byteRate = le32(header, 16);
    if (id === 'data') dataSize = Math.min(size, blob.size - offset - 8);
    if (id.toLowerCase() === 'id3 ') {
      const id3 = await readID3(blob, offset + 8);
      for (const key of ['title', 'artist', 'album', 'picture']) result[key] = id3[key] || result[key];
    }
    if (id === 'LIST' && ascii(header, 8, 4) === 'INFO') {
      const list = await bytesAt(blob, offset + 12, size - 4);
      for (let i = 0; i + 8 <= list.length; ) {
        const key = ascii(list, i, 4);
        const length = le32(list, i + 4);
        const value = clean(decode(list.subarray(i + 8, i + 8 + length), 'utf-8'));
        if (key === 'INAM' && !result.title) result.title = value;
        if (key === 'IART' && !result.artist) result.artist = value;
        if (key === 'IPRD' && !result.album) result.album = value;
        i += 8 + length + (length % 2);
      }
    }
    offset += 8 + size + (size % 2);
  }
  if (byteRate && dataSize) result.duration = dataSize / byteRate;
  return result;
}
