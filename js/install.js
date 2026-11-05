// Aide à l'installation sur l'écran d'accueil.
// Installée, l'app s'ouvre en plein écran, marche hors connexion, et Safari ne peut plus
// effacer ses données (il le fait pour les sites non installés qu'on n'ouvre plus pendant 7 jours).

const LATER = 'uhqsic.installLater';
let deferredPrompt = null;

// Android et ordinateur : le navigateur propose sa propre fenêtre d'installation.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
window.addEventListener('appinstalled', () => { deferredPrompt = null; });

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const canPrompt = () => !!deferredPrompt;
export const canInstall = () => !isStandalone() && (isIOS() || canPrompt());

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const event = deferredPrompt;
  deferredPrompt = null;
  event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === 'accepted';
}

/** Proposée une fois, puis de nouveau au plus tôt dans quelques jours si on dit « Plus tard ». */
export function shouldSuggest(now = Date.now()) {
  if (!canInstall()) return false;
  return now > Number(localStorage.getItem(LATER) || 0);
}

export function remindLater(days = 3) {
  try {
    localStorage.setItem(LATER, String(Date.now() + days * 86400000));
  } catch {
    // Sans conséquence : la proposition reviendra au prochain lancement.
  }
}

const shareIcon = '<svg viewBox="0 0 24 24" class="i"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>';
const addIcon = '<svg viewBox="0 0 24 24" class="i"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>';

export function installGuideHTML() {
  const why = '<p class="sheet-sub install-why">En plein écran, sans internet, et ta musique ne risque plus d\'être effacée par Safari.</p>';
  if (!isIOS()) {
    return `
      <div class="install" data-install>
        <img class="install-icon" src="icons/icon-180.png" alt="" width="72" height="72">
        <h3>Installer Uhqsic</h3>
        ${why}
        <div class="sheet-footer">
          <button type="button" class="soft-btn" data-install-later>Plus tard</button>
          <button type="button" class="accent-btn" data-install-now>Installer</button>
        </div>
      </div>`;
  }
  return `
    <div class="install" data-install>
      <img class="install-icon" src="icons/icon-180.png" alt="" width="72" height="72">
      <h3>Installe Uhqsic sur ton iPhone</h3>
      ${why}
      <ol class="install-steps">
        <li>
          <span class="step-n">1</span>
          <span class="step-text">Dans Safari, touche <b>Partager</b>${' '}<span class="muted">(parfois sous « ⋯ »)</span></span>
          <span class="step-art safari-bar" aria-hidden="true"><i></i><i></i><span class="hl">${shareIcon}</span><i></i><i></i></span>
        </li>
        <li>
          <span class="step-n">2</span>
          <span class="step-text">Choisis <b>Sur l'écran d'accueil</b></span>
          <span class="step-art share-row" aria-hidden="true"><span>Sur l'écran d'accueil</span>${addIcon}</span>
        </li>
        <li>
          <span class="step-n">3</span>
          <span class="step-text">Touche <b>Ajouter</b>, en haut à droite</span>
          <span class="step-art add-head" aria-hidden="true"><span class="muted">Annuler</span><b>Ajouter</b></span>
        </li>
      </ol>
      <p class="sheet-sub install-then">Ensuite, ouvre Uhqsic depuis son icône sur l'écran d'accueil.</p>
      <div class="sheet-footer">
        <button type="button" class="accent-btn" data-install-later>Compris</button>
      </div>
    </div>`;
}
