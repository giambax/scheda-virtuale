// aggiorna.js — sito come app (PWA): "Installa l'app" quando il browser lo permette, avviso "nuova versione
// disponibile" (si confronta il ?v= degli script della pagina pubblicata con quello di questa), e la richiesta
// di archiviazione persistente (navigator.storage.persist), così il browser non svuota progetti e compilatore.
const $ = s => document.querySelector(s);
const QUESTA = new URL(import.meta.url).searchParams.get('v') || '';
let promptInstalla = null;
// --- installazione (Chrome, Edge, Chromebook)
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  promptInstalla = e;
  const b = $('#btn-installa'); if (b) b.hidden = false;
});
window.addEventListener('appinstalled', () => { const b = $('#btn-installa'); if (b) b.hidden = true; promptInstalla = null; });
const bi = document.createElement('button');
bi.id = 'btn-installa'; bi.type = 'button'; bi.className = 'ghost small'; bi.hidden = true; bi.textContent = '⬇ Installa l\'app';
bi.title = 'Installa la Scheda Virtuale come app (si apre nella sua finestra e funziona anche senza Internet)';
bi.addEventListener('click', async () => { if (!promptInstalla) return; promptInstalla.prompt(); await promptInstalla.userChoice.catch(() => null); promptInstalla = null; bi.hidden = true; });
const piede = $('.cassetto-piede'); if (piede) piede.prepend(bi);
// --- nuova versione
async function controlla() {
  if (!QUESTA || !navigator.onLine) return false;
  try {
    const r = await fetch(location.pathname + '?controllo=' + Date.now(), { cache: 'no-store' });
    const m = /local-server\.js\?v=([A-Za-z0-9._-]+)/.exec(await r.text());
    if (m && m[1] !== QUESTA) { avvisa(m[1]); return true; }
  } catch {}
  return false;
}
function avvisa(v) {
  if ($('#nuova-versione')) return;
  const d = document.createElement('div');
  d.id = 'nuova-versione'; d.className = 'nuova-versione'; d.setAttribute('role', 'status');
  d.innerHTML = `<span>È disponibile una nuova versione del sito.</span> <button type="button" class="small primary">Ricarica</button> <button type="button" class="small ghost" title="Più tardi">✕</button>`;
  d.querySelector('.primary').addEventListener('click', () => location.reload());
  d.querySelector('.ghost').addEventListener('click', () => d.remove());
  document.body.append(d);
  window.SVnuovaVersione = v;
}
setInterval(controlla, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') controlla(); });
// --- archiviazione persistente (senza chiedere niente: Chrome la concede ai siti installati o usati spesso)
async function persistente() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
  try { return navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch { return false; }
}
persistente();
window.SVapp = { controlla, avvisa, persistente, get installabile() { return !!promptInstalla; } };
