// cartella.js — "📂 Collega una cartella di progetti" (File System Access API: Chrome ed Edge su Mac, Windows,
// ChromeOS). La cartella (es. STM32 con più progetti CubeIDE, o un progetto solo) si sceglie una volta; l'handle
// resta in IndexedDB e ai successivi avvii basta il permesso (un clic, o niente con l'app installata).
// I progetti compaiono con 📂; "Salva" scrive sul disco (local-server.js); ogni 1,5 s, con la scheda visibile,
// si controllano i file del progetto aperto: se cambiano da fuori (CubeIDE) si ricaricano e, se scelto, si ricompila.
// Safari e Firefox non hanno l'API: niente pulsante, solo una riga che lo spiega.
const $ = s => document.querySelector(s);
const C = SV.cartella;
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const box = document.createElement('div');
box.className = 'cartella small';
box.id = 'cartella';
$('.carica').after(box);
let messaggio = '';
function disegna() {
  if (!C.supportata) { box.innerHTML = '<span class="muted">Collegare una cartella del computer funziona in Chrome ed Edge (Mac, Windows, Chromebook): qui usa 📁 Cartella o 🗜 Zip.</span>'; return; }
  const st = C.stato;
  box.replaceChildren();
  const b = (t, title, fn, cls = 'ghost small') => { const x = document.createElement('button'); x.type = 'button'; x.className = cls; x.textContent = t; x.title = title; x.addEventListener('click', fn); return x; };
  if (st.stato === 'nessuna') box.append(b('📂 Collega una cartella di progetti', 'Scegli la cartella dei progetti CubeIDE (es. STM32): si lavora sui file del disco, si salva lì e si vedono le modifiche fatte in CubeIDE', collega));
  else if (st.stato === 'permesso') {
    const t = document.createElement('span'); t.textContent = `Cartella «${st.nome}»: serve il permesso per leggerla. `;
    box.append(t, b('📂 Riapri', 'Chiede al browser il permesso per la cartella collegata', riapri, 'small primary'), b('Scollega', 'Il sito dimentica la cartella (sul disco non cambia niente)', scollega));
  } else {
    const t = document.createElement('span'); t.textContent = `📂 «${st.nome}»: ${st.progetti.length} progett${st.progetti.length === 1 ? 'o' : 'i'} sul disco `;
    const ric = document.createElement('label'); ric.className = 'latch'; ric.title = 'Se un file del progetto aperto cambia sul disco (es. lo salvi in CubeIDE), il sito lo ricarica e ricompila';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = ls.get('sv-ricompila-disco') !== '0'; cb.addEventListener('change', () => ls.set('sv-ricompila-disco', cb.checked ? '1' : '0'));
    ric.append(cb, ' ricompila quando cambia');
    box.append(t, b('↻', 'Rileggi la cartella (progetti nuovi)', async () => { await C.ricarica(); await loadProjects(); disegna(); }), b('Scollega', 'Il sito dimentica la cartella (sul disco non cambia niente)', scollega), document.createElement('br'), ric);
  }
  if (messaggio) { const m = document.createElement('div'); m.className = 'muted'; m.textContent = messaggio; box.append(m); }
}
async function dopo(fn) {
  try { messaggio = ''; await fn(); } catch (e) { if (e && e.name === 'AbortError') return; messaggio = e.message || String(e); }
  await loadProjects();
  disegna();
  progazioni();
}
const collega = () => dopo(async () => { const h = await window.showDirectoryPicker({ id: 'sv-progetti', mode: 'readwrite' }); const n = await C.collega(h); if (!n.length) messaggio = 'In questa cartella non ho trovato progetti CubeIDE (cartelle con un .ioc e Core/Src/main.c).'; });
const riapri = () => dopo(() => C.permesso());
const scollega = () => dopo(async () => { if (C.eCartella(S.selId)) S.selId = null; await C.scollega(); });

// "Copia nel mio account" per i progetti della cartella (rinomina ed elimina non valgono: i file sono sul disco)
const bCopia = document.createElement('button');
bCopia.type = 'button'; bCopia.className = 'ghost small'; bCopia.id = 'btn-copia-account'; bCopia.hidden = true;
bCopia.textContent = '⧉ Copia nel mio account'; bCopia.title = 'Una copia di questo progetto tra i tuoi (online, se hai un account): i file sul disco non cambiano';
bCopia.addEventListener('click', async () => { try { const n = await C.copia(S.selId); await loadProjects(); await selectProject(n); SV.log('info', `Copiato tra i tuoi progetti: ${n}`); } catch (e) { alert(e.message || e); } });
$('#btn-rinomina').before(bCopia);
function progazioni() {
  const c = !!S.selId && C.eCartella(S.selId);
  bCopia.hidden = !c;
  $('#btn-rinomina').hidden = c; $('#btn-elimina').hidden = c;
}
// controllo dei file del progetto aperto (CubeIDE li salva? si ricarica)
let occupato = false;
setInterval(async () => {
  progazioni();
  if (occupato || document.visibilityState !== 'visible' || !S.selId || !C.eCartella(S.selId)) return;
  occupato = true;
  try {
    const id = S.selId, cambiati = await C.controlla(id);
    if (cambiati.length && S.selId === id) {
      const tolti = cambiati.eliminati || [], nomi = l => l.map(r => r.split('/').pop()).join(', ');
      const nuovi = cambiati.filter(r => !tolti.includes(r));
      SV.log('info', [nuovi.length && 'Cambiato sul disco: ' + nomi(nuovi), tolti.length && 'Tolto dal disco: ' + nomi(tolti)].filter(Boolean).join('; ') + ' — ricaricato');
      const giraVa = S.server.status === 'running' && S.server.project && S.server.project.id === id;
      await selectProject(id, true);   // resta sullo stesso file; l'editor ricarica i file non modificati
      if (giraVa && ls.get('sv-ricompila-disco') !== '0' && cambiati.some(r => /\.(c|h|ioc)$/.test(r))) doRun(!!S.server.debug);
    }
  } finally { occupato = false; }
}, 1500);
if (C.supportata) { const r = await C.ricorda().catch(() => 'nessuna'); if (r !== 'nessuna') await loadProjects(); }
disegna();
progazioni();
window.SVcartella = { disegna, collega, riapri };
