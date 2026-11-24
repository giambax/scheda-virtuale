// ospite.js — "Continua come ospite": striscia di avviso sopra il banco, avviso prima di chiudere o
// ricaricare se ci sono progetti, passaggio dei progetti in un account ("Crea un account" / "Entra").
// I progetti dell'ospite stanno solo in memoria (local-server.js, MEM): niente IndexedDB né localStorage.
const $ = s => document.querySelector(s);
const striscia = document.createElement('div');
striscia.className = 'ospite-striscia';
striscia.id = 'ospite-striscia';
striscia.innerHTML = `<b>Sei ospite:</b> <span>i progetti non vengono salvati (chiudendo o ricaricando la pagina si perdono).</span>
  <button type="button" class="small" data-zip>⬇ Scarica lo zip per tenerli</button>
  <button type="button" class="small primary" data-crea>Crea un account</button>
  <button type="button" class="small ghost" data-entra>Entra</button>`;
$('#banco').prepend(striscia);
let esco = false;
function scarica() {
  SV.exportZip().then(z => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([z], { type: 'application/zip' }));
    a.download = 'scheda-virtuale-ospite.zip';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
}
async function versoAccount(pane) {
  try {
    const n = await SV.portaInAccount();
    sessionStorage.setItem('sv-accesso-pane', pane);
    if (n && !confirm(`Ti porto nell'account ${n === 1 ? 'il progetto aperto' : `i ${n} progetti aperti`}: dopo l'accesso li ritrovi tra i tuoi. Continuo?`)) { sessionStorage.removeItem('sv-ospite-porta'); return; }
    esco = true;
    location.reload();
  } catch (e) { alert(e.message || String(e)); }
}
striscia.querySelector('[data-zip]').addEventListener('click', scarica);
striscia.querySelector('[data-crea]').addEventListener('click', () => versoAccount('iscriviti'));
striscia.querySelector('[data-entra]').addEventListener('click', () => versoAccount('entra'));
// nel cassetto: niente "cambia nome" (l'ospite non ha un nome), al suo posto "Entra"
const bu = $('#btn-utente');
if (bu) { const nuovo = bu.cloneNode(true); nuovo.textContent = 'entra'; nuovo.title = 'Entra o crea un account (i progetti aperti vengono con te)'; bu.replaceWith(nuovo); nuovo.addEventListener('click', () => versoAccount('entra')); }
// prima di chiudere o ricaricare: se ci sono progetti, il browser chiede conferma
window.addEventListener('beforeunload', e => {
  if (esco || !(typeof S !== 'undefined' && S.projects && S.projects.length)) return;
  e.preventDefault();
  e.returnValue = 'I progetti da ospite non sono salvati.';
});
window.SVospite = { scarica, versoAccount };
