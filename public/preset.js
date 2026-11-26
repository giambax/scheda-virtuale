// preset.js — fase Q (26/11/2026): preset del banco. Si parte da un banco già pronto invece che da zero
// (breadboard con i binari già collegati alla Nucleo, tre breadboard unite…), e si può salvare il banco attuale come
// preset proprio: solo il circuito, o anche il codice (allora "Usa" crea un progetto nuovo). I preset propri stanno nel
// browser (localStorage "sv-preset:<utente>") e, con l'account, anche online (tabella preset_banco, migrazione 6):
// si uniscono per id tenendo il più recente. Rinomina, elimina, esporta (.json) e importa.
// Usa BB (breadboard.js), SV (local-server.js), S, selectProject, loadProjects (app.js). Testi degli utenti solo con textContent.
const $ = s => document.querySelector(s);
const ROSSO = '#e53935', NERO = '#212121';
const VERSIONE = 1;

// ------------------------------------------------------------------ preset pronti
// fori della Nucleo (circuito.js): CN6 3V3 (5,17), 5V (5,18), GND (5,19) e (5,20)
const NUC = { '3V3': [5, 17], '5V': [5, 18], GND: [5, 19], GND2: [5, 20] };
// binari di una tavola posata in (X, Y): + in alto y = Y, − y = Y+1; in basso + y = Y+17, − y = Y+18; fori da X+4 a X+62
const binario = (X, Y, quale, i = 0, largo = 62) => [i === 0 ? X + 4 : X + largo, Y + { 'T+': 0, 'T-': 1, 'B+': 17, 'B-': 18 }[quale]];
function filo(fili, a, b, col) {
  const p = a[0] === b[0] || a[1] === b[1] ? [a, b] : [a, [b[0], a[1]], b];
  fili.push({ id: 'w' + fili.length, p, col });
}
function tavola(id, type, x, y) { return { id, type, x, y, rot: 0, opt: {}, label: 'BB' + (+id.slice(2) + 1) }; }
// alim: tensione del binario in alto e in basso ('3V3' | '5V'); n: quante breadboard una sotto l'altra
function bancoAlimentato({ tipo = 'bb830', alto = '3V3', basso = alto, n = 1 } = {}) {
  const largo = tipo === 'bb400' ? 32 : 62, X = 34, PASSO = 21;
  const comps = [], fili = [];
  for (let k = 0; k < n; k++) comps.push(tavola('bb' + k, tipo, X, 12 + k * PASSO));
  // la prima: binari in alto dalla Nucleo
  filo(fili, NUC[alto], binario(X, 12, 'T+'), ROSSO);
  filo(fili, NUC.GND, [binario(X, 12, 'T-')[0] + 1, 13], NERO);
  for (let k = 0; k < n; k++) {
    const Y = 12 + k * PASSO;
    // binari in basso: dalla Nucleo se hanno un'altra tensione, se no un ponticello alla fine come sulle breadboard vere
    if (k === 0 && basso !== alto) {
      filo(fili, NUC[basso], binario(X, Y, 'B+'), ROSSO);
      filo(fili, NUC.GND2, [binario(X, Y, 'B-')[0] + 1, Y + 18], NERO);
    } else if (basso === alto || k > 0) {
      filo(fili, binario(X, Y, 'T+', 1, largo), binario(X, Y, 'B+', 1, largo), ROSSO);
      filo(fili, [binario(X, Y, 'T-', 1, largo)[0] - 1, Y + 1], [binario(X, Y, 'B-', 1, largo)[0] - 1, Y + 18], NERO);
    }
    // la breadboard sotto prende i binari in alto da quelli in basso di questa
    if (k < n - 1) {
      filo(fili, [X + 6, Y + 17], [X + 6, Y + PASSO], ROSSO);
      filo(fili, [X + 7, Y + 18], [X + 7, Y + PASSO + 1], NERO);
    }
  }
  return { v: 2, comps, wires: fili };
}
export const PRONTI = [
  { id: 'vuoto', nome: 'Breadboard vuota', descr: 'Una breadboard da 830 punti, niente fili: come un progetto nuovo.', banco: () => ({ v: 2, comps: [tavola('bb0', 'bb830', 34, 12)], wires: [] }) },
  { id: 'bb-3v3', nome: 'Breadboard alimentata a 3,3 V', descr: 'Binari + e − in alto e in basso già collegati a 3V3 e GND della Nucleo.', banco: () => bancoAlimentato({ alto: '3V3' }) },
  { id: 'bb-5v', nome: 'Breadboard alimentata a 5 V', descr: 'Binari + e − in alto e in basso già collegati a 5V e GND della Nucleo (per moduli a 5 V: LCD, HC-SR04, servo).', banco: () => bancoAlimentato({ alto: '5V' }) },
  { id: 'bb-misto', nome: 'Breadboard 3,3 V sopra e 5 V sotto', descr: 'Binari in alto a 3V3, binari in basso a 5V, GND su tutti e due: per circuiti con sensori a 3,3 V e moduli a 5 V.', banco: () => bancoAlimentato({ alto: '3V3', basso: '5V' }) },
  { id: 'bb-tre', nome: 'Tre breadboard unite e alimentate', descr: 'Tre breadboard da 830 una sotto l\'altra, con i binari collegati tra loro e a 3V3/GND della Nucleo.', banco: () => bancoAlimentato({ alto: '3V3', n: 3 }) },
  { id: 'mezza-3v3', nome: 'Mezza breadboard alimentata a 3,3 V', descr: 'Una breadboard da 400 punti con i binari collegati a 3V3 e GND: per circuiti piccoli.', banco: () => bancoAlimentato({ tipo: 'bb400', alto: '3V3' }) },
];

// ------------------------------------------------------------------ preset propri: browser + account
const chiave = () => 'sv-preset:' + (window.SV ? SV.user : '');
function leggi() { try { const a = JSON.parse(localStorage.getItem(chiave())); return Array.isArray(a) ? a : []; } catch { return []; } }
function scrivi(a) { try { localStorage.setItem(chiave(), JSON.stringify(a)); } catch (e) { throw new Error('Spazio del browser finito: elimina qualche preset o esportalo.'); } }
const vivi = () => leggi().filter(p => !p.cancellato).sort((a, b) => b.aggiornato - a.aggiornato);
const nuovoId = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
// controllo di un preset arrivato da un file o da online: { nome, codice, dati: { breadboard } | { files } }
export function presetPulito(p) {
  if (!p || typeof p !== 'object') throw new Error('non è un preset');
  const nome = String(p.nome || '').trim().slice(0, 60);
  if (!nome) throw new Error('il preset non ha un nome');
  const d = p.dati || {}, codice = !!p.codice;
  if (codice) {
    if (!d.files || typeof d.files !== 'object') throw new Error('preset con codice senza file');
    const files = {};
    let tot = 0;
    for (const [k, v] of Object.entries(d.files)) {
      if (typeof v !== 'string' || !/^[\w .()\-\/]{1,200}$/.test(k) || k.split('/').includes('..') || k.startsWith('/')) continue;
      tot += v.length; if (tot > 1e6) throw new Error('preset troppo grande (più di 1 MB)');
      files[k] = v;
    }
    if (!Object.keys(files).some(k => /\.c$/.test(k))) throw new Error('nel preset non c\'è nessun file .c');
    return { nome, codice, dati: { files } };
  }
  if (!d.breadboard || typeof d.breadboard !== 'object') throw new Error('preset senza circuito');
  const bb = BB.K.pulisciBreadboard(d.breadboard);
  if (JSON.stringify(bb).length > 1e6) throw new Error('preset troppo grande (più di 1 MB)');
  return { nome, codice, dati: { breadboard: bb } };
}
// unione con l'account: per id, vince il più recente; i cancellati in locale si cancellano anche online
let sincronizzando = null;
async function sincronizza() {
  const R = window.SV && SV.account && SV.remote;
  if (!R || !R.preset) return 'locale';
  if (sincronizzando) return sincronizzando;
  sincronizzando = (async () => {
    let online;
    try { online = await R.preset.tutti(); } catch (e) { return e.code === 'assente' ? 'assente' : 'offline'; }
    const loc = leggi(), perId = new Map(loc.map(p => [p.id, p])), visti = new Set();
    for (const o of online) {
      visti.add(o.id);
      const l = perId.get(o.id), t = Date.parse(o.aggiornato);
      if (l && l.cancellato) { try { await R.preset.elimina(o.id); perId.delete(o.id); } catch {} continue; }
      if (!l || t > l.aggiornato) { try { perId.set(o.id, { id: o.id, ...presetPulito(o), aggiornato: t, online: true }); } catch {} }
      else if (l.aggiornato > t + 1000) { try { const r = await R.preset.cambia(l); l.aggiornato = Date.parse(r.aggiornato); l.online = true; } catch {} }
      else l.online = true;
    }
    for (const l of [...perId.values()]) {
      if (visti.has(l.id)) continue;
      if (l.cancellato) { perId.delete(l.id); continue; }
      if (l.online) { perId.delete(l.id); continue; }         // era online e non c'è più: cancellato da un altro dispositivo
      try { const r = await R.preset.crea(l); l.aggiornato = Date.parse(r.aggiornato); l.online = true; } catch {}
    }
    scrivi([...perId.values()]);
    return 'online';
  })().finally(() => { sincronizzando = null; });
  return sincronizzando;
}
async function salvaPreset(nome, codice) {
  if (typeof S === "undefined" || !S.selId) throw new Error('apri prima un progetto');
  let dati;
  if (codice) { if (window.SVeditor) await SVeditor.saveAll(); dati = { files: await SV.filesTesto(S.selId) }; }
  else dati = { breadboard: JSON.parse(JSON.stringify(BB.bb)) };
  const p = { id: nuovoId(), ...presetPulito({ nome, codice, dati }), aggiornato: Date.now() };
  scrivi([...leggi(), p]);
  sincronizza();
  return p;
}
function cambiaPreset(id, fn) {
  const a = leggi(), p = a.find(x => x.id === id);
  if (!p) return;
  fn(p); p.aggiornato = Date.now();
  scrivi(a); sincronizza();
}

// già online: resta un segno "cancellato" finché la sincronizzazione non lo toglie anche dall'account
function elimina(id) {
  const a = leggi(), p = a.find(x => x.id === id);
  if (!p) return;
  if (p.online) { p.cancellato = true; p.aggiornato = Date.now(); scrivi(a); sincronizza(); }
  else scrivi(a.filter(x => x.id !== id));
}

// preset predefinito per i progetti nuovi (★): id di un preset pronto o di uno proprio senza codice
const PRED = 'sv-preset-predefinito';
const predefinito = () => { try { return localStorage.getItem(PRED) || ''; } catch { return ''; } };
function impostaPredefinito(id) { try { if (predefinito() === id) localStorage.removeItem(PRED); else localStorage.setItem(PRED, id); } catch {} }
export function bancoPredefinito() {
  const id = predefinito();
  if (!id) return null;
  const x = PRONTI.find(p => p.id === id);
  if (x) return x.banco();
  const p = vivi().find(p => p.id === id && !p.codice);
  return p ? BB.K.pulisciBreadboard(p.dati.breadboard) : null;
}

// ------------------------------------------------------------------ usare un preset
async function usa(p) {
  if (p.codice) {
    // con il codice: un progetto nuovo (il progetto aperto non si tocca)
    const n = await SV.daFilesTesto(p.nome, p.dati.files);
    await loadProjects(); await selectProject(n);
    SV.log('info', `Creato il progetto «${n}» dal preset «${p.nome}»`);
    return n;
  }
  if (typeof S === "undefined" || !S.selId) throw new Error('apri prima un progetto: il preset cambia il suo banco');
  if (BB.K.haCircuito(BB.bb) && !confirm(`Sostituisco il circuito del banco con il preset «${p.nome}»? (Puoi tornare indietro con Annulla.)`)) return null;
  const bb = BB.K.pulisciBreadboard(p.dati.breadboard);
  BB.modifica(x => { x.comps = bb.comps; x.wires = bb.wires; if (bb.schema) x.schema = bb.schema; });
  BB.adatta && BB.adatta();
  SV.log('info', `Banco dal preset «${p.nome}»`);
  return S.selId;
}
function esporta(p) {
  const blob = new Blob([JSON.stringify({ tipo: 'scheda-virtuale-preset', v: VERSIONE, nome: p.nome, codice: p.codice, dati: p.dati }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = p.nome.replace(/[^\w\- ]+/g, '_').slice(0, 40) + '.preset.json';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importa(file) {
  if (file.size > 2e6) throw new Error('file troppo grande');
  let j;
  try { j = JSON.parse(await file.text()); } catch { throw new Error('non è un file .json'); }
  if (!j || j.tipo !== 'scheda-virtuale-preset') throw new Error('non è un preset della Scheda Virtuale');
  const p = { id: nuovoId(), ...presetPulito(j), aggiornato: Date.now() };
  scrivi([...leggi(), p]); sincronizza();
  return p;
}

// ------------------------------------------------------------------ finestra
const dlg = document.createElement('dialog');
dlg.id = 'preset-dlg'; dlg.className = 'preset-dlg';
dlg.innerHTML = `<h2>Preset del banco</h2>
  <p class="small muted">Parti da un banco già pronto invece che da zero. Un preset con il codice crea un progetto nuovo; uno senza cambia solo il banco del progetto aperto.</p>
  <h3>Pronti</h3><ul class="preset-lista" data-pronti></ul>
  <h3>I miei preset <span class="small muted" data-stato></span></h3><ul class="preset-lista" data-miei></ul>
  <form class="preset-salva" data-salva>
    <label>Salva il banco come preset <input data-nome maxlength="60" placeholder="Nome del preset" required></label>
    <label class="small"><input type="checkbox" data-codice> anche il codice (diventa un progetto pronto)</label>
    <button type="submit" class="primary">Salva</button>
  </form>
  <div class="dlg-pulsanti"><label class="btnlike small" title="Un file .preset.json esportato da qui">Importa…<input type="file" data-importa accept=".json,application/json" hidden></label>
  <span class="tabs-sp"></span><button type="button" data-chiudi>Chiudi</button></div>`;
document.body.append(dlg);
const q = s => dlg.querySelector(s);
const bottone = (t, fn, cls = 'small ghost', titolo = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = t; if (titolo) b.title = titolo; b.addEventListener('click', async () => { try { await fn(); } catch (e) { alert(e.message || e); } }); return b; };
function voce(nome, descr, azioni) {
  const li = document.createElement('li');
  const t = document.createElement('div'); t.className = 'preset-testo';
  const b = document.createElement('b'); b.textContent = nome;
  const d = document.createElement('span'); d.className = 'small muted'; d.textContent = descr;
  t.append(b, d);
  const a = document.createElement('div'); a.className = 'preset-azioni'; a.append(...azioni);
  li.append(t, a);
  return li;
}
function disegna(stato = '') {
  const pr = q('[data-pronti]'); pr.replaceChildren();
  const stella = id => { const b = bottone(predefinito() === id ? '★' : '☆', () => { impostaPredefinito(id); disegna(stato); }, 'small ghost stella', 'Predefinito: i progetti nuovi (＋ Nuovo) partono con questo banco'); b.setAttribute('aria-pressed', predefinito() === id); return b; };
  for (const x of PRONTI) pr.append(voce(x.nome, x.descr, [bottone('Usa', async () => { if (await usa({ nome: x.nome, codice: false, dati: { breadboard: x.banco() } })) dlg.close(); }, 'small primary'), stella(x.id)]));
  const mi = q('[data-miei]'); mi.replaceChildren();
  const miei = vivi();
  if (!miei.length) { const li = document.createElement('li'); li.className = 'small muted'; li.textContent = 'Nessuno: salva il banco con il modulo qui sotto.'; mi.append(li); }
  for (const p of miei) mi.append(voce(p.nome, (p.codice ? 'circuito e codice' : 'solo circuito') + ' · ' + new Date(p.aggiornato).toLocaleDateString('it-IT'), [
    bottone(p.codice ? 'Crea progetto' : 'Usa', async () => { if (await usa(p)) dlg.close(); }, 'small primary'),
    ...(p.codice ? [] : [stella(p.id)]),
    bottone('Rinomina', () => { const n = prompt('Nuovo nome del preset', p.nome); if (n === null) return; const t = n.trim().slice(0, 60); if (!t) return; cambiaPreset(p.id, x => { x.nome = t; }); disegna(); }),
    bottone('Esporta', () => esporta(p), 'small ghost', 'Scarica il preset come file .json (da importare su un altro computer o dare ai compagni)'),
    bottone('Elimina', () => { if (!confirm(`Elimino il preset «${p.nome}»?`)) return; elimina(p.id); disegna(); }, 'small ghost danger'),
  ]));
  q('[data-stato]').textContent = stato === 'online' ? '(salvati anche nel tuo account)' : stato === 'assente' ? '(solo in questo browser: online non ancora attivi)' : stato === 'offline' ? '(solo in questo browser: sei offline)' : window.SV && SV.account ? '' : '(in questo browser; con un account anche online)';
}
export async function apri() {
  q('[data-nome]').value = ''; q('[data-codice]').checked = false;
  disegna();
  dlg.showModal();
  disegna(await sincronizza());
}
q('[data-chiudi]').addEventListener('click', () => dlg.close());
q('[data-salva]').addEventListener('submit', async e => {
  e.preventDefault();
  try { const p = await salvaPreset(q('[data-nome]').value, q('[data-codice]').checked); q('[data-nome]').value = ''; disegna(); SV.log('info', `Salvato il preset «${p.nome}»`); }
  catch (err) { alert(err.message || err); }
});
q('[data-importa]').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const p = await importa(f); disegna(); SV.log('info', `Importato il preset «${p.nome}»`); } catch (err) { alert('Importazione non riuscita: ' + (err.message || err)); }
});
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#bb-preset')) apri(); });
window.SVpreset = { apri, bancoPredefinito, PRONTI, usa, salvaPreset, sincronizza, importa, vivi, presetPulito, elimina, cambiaPreset };
