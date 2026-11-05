// Partage : carte « J'écoute » (image pour story ou message), fichier audio, sauvegarde.
// Le menu de partage d'iOS (AirDrop, Messages, Instagram…) s'ouvre avec navigator.share.

/** Ouvre le menu de partage avec un fichier ; sinon le télécharge. Renvoie false si annulé. */
export async function shareFile(file, title) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

function loadImage(blob) {
  return new Promise((resolve) => {
    if (!blob) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(blob);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Coupe un texte trop long sur `lines` lignes au plus, avec des points de suspension. */
function wrap(ctx, text, maxWidth, lines) {
  const words = text.split(/\s+/);
  const out = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) line = test;
    else {
      out.push(line);
      line = word;
    }
  }
  out.push(line);
  if (out.length > lines) {
    out.length = lines;
    let last = out[lines - 1];
    while (ctx.measureText(`${last}…`).width > maxWidth && last.length) last = last.slice(0, -1);
    out[lines - 1] = `${last}…`;
  }
  return out.filter(Boolean);
}

/**
 * Carte 1080 × 1920 (format story) : pochette floutée en fond, pochette nette, titre, artiste,
 * et le vinyle qui dépasse, comme dans le lecteur.
 */
export async function nowPlayingCard(track, { label = '#8C8CFF', heading = 'J\'écoute' } = {}) {
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const art = await loadImage(track.art || track.thumb);
  const tint = track.tint ? `rgb(${track.tint.join(',')})` : label;

  // Fond : pochette très floue et assombrie, sinon un dégradé de la teinte.
  ctx.fillStyle = '#0b0b0f';
  ctx.fillRect(0, 0, W, H);
  if (art) {
    ctx.filter = 'blur(90px) saturate(1.6) brightness(0.65)';
    ctx.drawImage(art, (W - H - 600) / 2, -300, H + 600, H + 600);
    ctx.filter = 'none';
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, tint);
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const veil = ctx.createLinearGradient(0, H * 0.45, 0, H);
  veil.addColorStop(0, 'rgba(0,0,0,0)');
  veil.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, W, H);

  // Vinyle qui dépasse à droite de la pochette.
  const side = 720;
  const x = 120;
  const y = 470;
  const cx = x + side * 0.5 + 230;
  const cy = y + side / 2;
  const r = side * 0.47;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 30;
  ctx.fillStyle = '#101014';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#1d1d24';
  ctx.lineWidth = 2;
  for (let rr = r * 0.36; rr < r * 0.98; rr += 7) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = tint;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2);
  ctx.fill();

  // Pochette nette.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 80;
  ctx.shadowOffsetY = 40;
  roundRect(ctx, x, y, side, side, 36);
  ctx.fillStyle = tint;
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, x, y, side, side, 36);
  ctx.clip();
  if (art) ctx.drawImage(art, x, y, side, side);
  ctx.restore();

  // Textes.
  const font = '-apple-system, "SF Pro Display", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `600 44px ${font}`;
  ctx.fillText(heading, 120, 330);
  ctx.fillStyle = '#fff';
  ctx.font = `800 92px ${font}`;
  const titleLines = wrap(ctx, track.title, W - 240, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, 120, 1330 + i * 104));
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = `500 56px ${font}`;
  ctx.fillText(wrap(ctx, track.artist, W - 240, 1)[0] || '', 120, 1330 + titleLines.length * 104 + 30);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `700 40px ${font}`;
  ctx.fillText('Uhqsic', 120, H - 150);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
