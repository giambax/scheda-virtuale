// classi.js — classi ed esercizi (fase 3, punto N, 26/11/2026). Pulsante «🎓 Classi» nel cassetto.
// Il prof (docente nominato dall'amministratore) crea la classe e dà il codice d'invito; gli studenti entrano con
// il codice. Il prof dà gli esercizi (consegna, progetto di partenza preso dal progetto aperto o dalla galleria
// degli esempi, file in sola lettura, scadenza); lo studente apre l'esercizio (diventa un suo progetto con la
// consegna) e consegna; il prof vede l'elenco delle consegne, apre i progetti e lascia commento e voto.
// Dati su Supabase con supabase/migrazione-5-classi.sql (SV.remote.classi); prima che sia applicata il
// pannello lo dice e il resto del sito funziona come prima. Tutti i testi degli utenti vanno in textContent.
import { CLASSI_ASSENTE } from './remote.js?v=2026-11-26e';

const dlg = document.getElementById('classi-dlg');
const corpo = dlg.querySelector('[data-corpo]');
const R = () => window.SV && SV.remote && SV.remote.classi ? SV.remote.classi : null;
const st = { vista: 'elenco', classe: null, es: null, docente: false, admin: false };

// elemento con testo sicuro: el('button', { class: 'small', onclick }, 'testo', figlio…)
function el(tag, attr = {}, ...figli) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of figli.flat()) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}
const quando = t => t ? new Date(t).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
function messaggio(t, cls = 'muted') { corpo.replaceChildren(el('p', { class: 'small ' + cls }, t)); }
function errore(e) {
  const m = e && e.code === 'assente' ? CLASSI_ASSENTE : (e && e.message) || String(e);
  const p = dlg.querySelector('[data-errore]');
  p.textContent = m; p.hidden = false;
  if (e && e.code === 'assente') corpo.replaceChildren();
}
const ERR = Symbol('errore');   // prova() lo restituisce se la chiamata è fallita (le funzioni "void" restituiscono undefined/null)
async function prova(fn) {
  dlg.querySelector('[data-errore]').hidden = true;
  try { return await fn(); } catch (e) { errore(e); return ERR; }
}

// ------------------------------------------------------------------
async function apri() {
  dlg.querySelector('[data-errore]').hidden = true;
  if (!dlg.open) dlg.showModal();
  if (!R()) { messaggio('Le classi servono un account: entra o iscriviti (con «Continua come ospite» non si salva niente online).'); return; }
  messaggio('Carico…');
  const r = await prova(async () => {
    st.docente = await R().docente();
    try { st.admin = await SV.remote.segnalazioni.admin(); } catch { st.admin = false; }
    return R().mie();
  });
  if (r === ERR) return;
  if (st.vista === 'classe' && st.classe) { const k = r.find(x => x.id === st.classe.id); if (k) return vistaClasse(k); }
  vistaElenco(r);
}

function vistaElenco(classi) {
  st.vista = 'elenco'; st.classe = null;
  const cod = el('input', { maxlength: 8, size: 9, placeholder: 'es. K7QH2M', 'aria-label': 'Codice della classe', autocapitalize: 'characters' });
  const parti = [
    el('div', { class: 'cl-riga' }, el('b', {}, 'Entra in una classe'), cod, el('button', { class: 'small primary', onclick: async () => {
      const x = await prova(() => R().entra(cod.value));
      if (x === ERR) return;
      if (!x) { errore({ message: 'Codice sbagliato (sono 6 caratteri, chiedilo al prof).' }); return; }
      apri();
    } }, 'Entra')),
  ];
  if (st.docente) {
    const nome = el('input', { maxlength: 60, placeholder: 'es. 5BEC Sistemi', 'aria-label': 'Nome della classe' });
    parti.push(el('div', { class: 'cl-riga' }, el('b', {}, 'Nuova classe'), nome, el('button', { class: 'small', onclick: async () => {
      if (!nome.value.trim()) return;
      const x = await prova(() => R().crea(nome.value));
      if (x && x !== ERR) apri();
    } }, 'Crea')));
  }
  if (st.admin) {
    const u = el('input', { maxlength: 20, placeholder: 'nome utente', 'aria-label': 'Nome utente del docente' });
    parti.push(el('div', { class: 'cl-riga' }, el('b', {}, 'Nomina docente'), u,
      el('button', { class: 'small', onclick: async () => { const x = await prova(() => R().nominaDocente(u.value, true)); if (x !== ERR) messaggioBreve(`${x} ora è docente: può creare classi.`); } }, 'Nomina'),
      el('button', { class: 'small ghost', onclick: async () => { const x = await prova(() => R().nominaDocente(u.value, false)); if (x !== ERR) messaggioBreve(`${x} non è più docente.`); } }, 'Togli')));
  }
  parti.push(el('h4', {}, 'Le mie classi'));
  if (!classi.length) parti.push(el('p', { class: 'muted small' }, st.docente ? 'Nessuna classe: creane una e dai il codice agli studenti.' : 'Non sei ancora in nessuna classe: inserisci il codice che ti ha dato il prof.'));
  for (const k of classi) parti.push(el('button', { class: 'cl-classe', onclick: () => vistaClasse(k) },
    el('b', {}, k.nome), el('span', { class: 'small muted' }, ` ${k.ruolo === 'prof' ? 'prof' : 'studente'} · ${k.esercizi} esercizi${k.ruolo === 'prof' ? ` · ${k.membri} studenti · codice ${k.codice}` : ''}${k.archiviata ? ' · archiviata' : ''}`)));
  corpo.replaceChildren(...parti);
}
function messaggioBreve(t) { const p = dlg.querySelector('[data-errore]'); p.textContent = t; p.hidden = false; p.classList.add('ok'); setTimeout(() => p.classList.remove('ok'), 4000); }

// ------------------------------------------------------------------
async function vistaClasse(k) {
  st.vista = 'classe'; st.classe = k;
  messaggio('Carico…');
  const es = await prova(() => R().esercizi(k.id));
  if (es === ERR) return;
  const prof = k.ruolo === 'prof';
  const parti = [el('div', { class: 'cl-riga' }, el('button', { class: 'small ghost', onclick: apri }, '← Classi'), el('h4', {}, k.nome))];
  if (prof) {
    parti.push(el('p', { class: 'cl-codice' }, 'Codice per entrare: ', el('b', { 'data-codice': '' }, k.codice), ' ',
      el('button', { class: 'small ghost', onclick: () => navigator.clipboard && navigator.clipboard.writeText(k.codice) }, 'Copia')));
    parti.push(await sezioneMembri(k));
    parti.push(sezioneNuovoEsercizio(k));
  }
  parti.push(el('h4', {}, 'Esercizi'));
  if (!es.length) parti.push(el('p', { class: 'muted small' }, prof ? 'Nessun esercizio: aggiungine uno qui sopra.' : 'Il prof non ha ancora dato esercizi.'));
  for (const e of es) parti.push(await rigaEsercizio(k, e));
  corpo.replaceChildren(...parti);
}

async function sezioneMembri(k) {
  const m0 = await prova(() => R().membri(k.id)), m = m0 === ERR || !m0 ? [] : m0;
  const stud = m.filter(x => x.ruolo === 'studente'), prof = m.filter(x => x.ruolo === 'prof');
  const box = el('details', { class: 'cl-sez' }, el('summary', {}, `Studenti (${stud.length}) e prof (${prof.length})`));
  const ul = el('ul', { class: 'cl-membri small' });
  for (const x of m) ul.append(el('li', {}, `${x.username || '(senza nome)'}${x.ruolo === 'prof' ? ' — prof' : ''} `,
    x.ruolo === 'studente' ? el('button', { class: 'small ghost', onclick: async () => { if (confirm(`Tolgo ${x.username} dalla classe?`) && (await prova(() => R().togli(k.id, x.user_id))) !== ERR) vistaClasse(k); } }, 'Togli') : null));
  box.append(ul);
  if (k.creatore) {
    const u = el('input', { maxlength: 20, placeholder: 'nome utente', 'aria-label': 'Altro prof' });
    box.append(el('div', { class: 'cl-riga' }, 'Altro prof della classe:', u, el('button', { class: 'small', onclick: async () => { if ((await prova(() => R().aggiungiProf(k.id, u.value, true))) !== ERR) vistaClasse(k); } }, 'Aggiungi')),
      el('div', { class: 'cl-riga' }, el('button', { class: 'small ghost', onclick: async () => { if ((await prova(() => R().archivia(k.id, !k.archiviata))) !== ERR) { k.archiviata = !k.archiviata; vistaClasse(k); } } },
        k.archiviata ? 'Riapri la classe' : 'Archivia la classe (niente più ingressi né consegne)')));
  }
  return box;
}

// nuovo esercizio: dal progetto aperto o da un esempio della galleria
function sezioneNuovoEsercizio(k) {
  const box = el('details', { class: 'cl-sez' }, el('summary', {}, '＋ Nuovo esercizio'));
  const titolo = el('input', { maxlength: 120, placeholder: 'Titolo', 'aria-label': 'Titolo', 'data-titolo': '' });
  const testo = el('textarea', { rows: 4, maxlength: 20000, placeholder: 'Consegna (cosa deve fare lo studente). **grassetto**, `codice`, - elenchi', 'aria-label': 'Consegna', 'data-testo': '' });
  const scad = el('input', { type: 'datetime-local', 'aria-label': 'Scadenza', 'data-scadenza': '' });
  const fonte = el('select', { 'aria-label': 'Progetto di partenza', 'data-fonte': '' }, el('option', { value: '' }, `Progetto aperto (${S.selId || 'nessuno'})`));
  const sola = el('div', { class: 'cl-sola small' });
  let galleria = [];
  fetch('esempi/elenco.json?v=2026-11-26e').then(r => r.json()).then(g => { galleria = g; for (const x of g) fonte.append(el('option', { value: x.id }, 'Galleria: ' + x.nome)); }).catch(() => {});
  const files = async () => fonte.value
    ? (await (await fetch(`esempi/${encodeURIComponent(fonte.value)}.json?v=2026-11-26e`)).json()).files
    : S.selId ? await SV.filesTesto(S.selId) : null;
  const aggiornaSola = async () => {
    const f = await files().catch(() => null);
    sola.replaceChildren('In sola lettura per lo studente: ');
    for (const rel of Object.keys(f || {}).filter(r => /\.(c|h)$/.test(r)).sort()) sola.append(el('label', {}, el('input', { type: 'checkbox', value: rel }), rel.split('/').pop(), ' '));
    const g = galleria.find(x => x.id === fonte.value);
    if (g && !titolo.value) { titolo.value = g.nome; testo.value = g.consegna || g.descr; }
  };
  fonte.addEventListener('change', aggiornaSola);
  box.addEventListener('toggle', () => { if (box.open) aggiornaSola(); });
  box.append(el('div', { class: 'cl-form' }, titolo, testo, el('label', { class: 'small' }, 'Scadenza (facoltativa) ', scad), el('label', { class: 'small' }, 'Progetto di partenza ', fonte), sola,
    el('button', { class: 'small primary', 'data-salva-es': '', onclick: async () => {
      if (!titolo.value.trim()) { errore({ message: 'Scrivi il titolo dell\'esercizio.' }); return; }
      const f = await files();
      if (!f) { errore({ message: 'Apri un progetto (o scegli un esempio della galleria) da usare come partenza.' }); return; }
      delete f['.esercizio.json'];
      const x = await prova(() => R().salvaEsercizio({ classe: k.id, titolo: titolo.value, consegna: testo.value, progetto: f,
        sola: [...sola.querySelectorAll('input:checked')].map(i => i.value), scadenza: scad.value ? new Date(scad.value).toISOString() : null }));
      if (x !== ERR) vistaClasse(k);
    } }, 'Dai l\'esercizio alla classe')));
  return box;
}

async function rigaEsercizio(k, e) {
  const prof = k.ruolo === 'prof', scaduto = e.scadenza && Date.now() > Date.parse(e.scadenza);
  const box = el('div', { class: 'cl-es', 'data-es': e.id }, el('div', { class: 'cl-riga' }, el('b', {}, e.titolo),
    e.scadenza ? el('span', { class: 'small ' + (scaduto ? 'err' : 'muted') }, ` scadenza ${quando(e.scadenza)}`) : el('span', { class: 'small muted' }, ' senza scadenza')));
  if (e.consegna) box.append(el('p', { class: 'small cl-consegna' }, e.consegna));
  if (!prof) {
    const mia0 = await prova(() => R().miaConsegna(e.id)), mia = mia0 === ERR ? null : mia0;
    const stato = !mia ? (scaduto ? 'Non consegnato (scaduto)' : 'Da consegnare')
      : `Consegnato il ${quando(mia.consegnata)} (versione ${mia.versione})${e.scadenza && Date.parse(mia.consegnata) > Date.parse(e.scadenza) ? ' — in ritardo' : ''}`;
    box.append(el('p', { class: 'small', 'data-stato': '' }, stato));
    if (mia && (mia.voto || mia.commento)) box.append(el('p', { class: 'small cl-voto', 'data-voto': '' }, mia.voto ? `Voto: ${mia.voto}. ` : '', mia.commento || ''));
    const aperto = S.selId && await legato(S.selId, e.id);
    box.append(el('div', { class: 'cl-riga' },
      el('button', { class: 'small', onclick: () => apriEsercizio(k, e) }, 'Apri (diventa un mio progetto)'),
      el('button', { class: 'small primary ok', 'data-consegna': '', onclick: () => consegna(k, e) }, aperto ? `Consegna «${S.selId}»` : 'Consegna il progetto aperto')));
  } else {
    box.append(el('div', { class: 'cl-riga' },
      el('button', { class: 'small', 'data-vedi': '', onclick: () => vistaConsegne(k, e, box) }, 'Consegne'),
      el('button', { class: 'small ghost', onclick: () => apriEsercizio(k, e) }, 'Apri il progetto di partenza'),
      el('button', { class: 'small ghost danger', onclick: async () => { if (confirm(`Tolgo «${e.titolo}» e tutte le sue consegne?`) && (await prova(() => R().eliminaEsercizio(e.id))) !== ERR) vistaClasse(k); } }, 'Togli')));
  }
  return box;
}
// il progetto è stato aperto da questo esercizio? (.esercizio.json con classe.es)
async function legato(nome, es) {
  try { const f = await SV.filesTesto(nome); return JSON.parse(f['.esercizio.json'] || '{}').classe?.es === es; } catch { return false; }
}
async function apriEsercizio(k, e) {
  const x = await prova(() => R().esercizio(e.id));
  if (!x || x === ERR) return;
  const nome = await SV.daFilesTesto(`${e.titolo} (${k.nome})`, x.progetto, { titolo: e.titolo, testo: e.consegna, sola: x.sola || [], classe: { es: e.id, nome: k.nome } });
  await loadProjects(); await selectProject(nome);
  dlg.close(); if (window.SVlayout) SVlayout.cassettoAperto(false);
  showTab('code');
}
async function consegna(k, e) {
  if (!S.selId) { errore({ message: 'Apri prima il progetto da consegnare.' }); return; }
  if (!(await legato(S.selId, e.id)) && !confirm(`Il progetto aperto «${S.selId}» non è stato aperto da questo esercizio. Lo consegno lo stesso per «${e.titolo}»?`)) return;
  if (window.SVeditor) await SVeditor.saveAll();          // prima le modifiche non salvate dell'editor
  const f = await SV.filesTesto(S.selId);
  const r = await prova(() => R().consegna(e.id, f));
  if (r && r !== ERR) { messaggioBreve(`Consegnato «${S.selId}» (versione ${r.versione})${r.in_ritardo ? ', in ritardo' : ''}.`); vistaClasse(k); }
}

async function vistaConsegne(k, e, box) {
  const vecchia = box.querySelector('.cl-tab');
  if (vecchia) { vecchia.remove(); return; }
  const righe = await prova(() => R().consegne(e.id));
  if (righe === ERR) return;
  const fatte = righe.filter(r => r.consegna_id).length;
  const tab = el('div', { class: 'cl-tab' }, el('p', { class: 'small muted' }, `Consegnati ${fatte} su ${righe.length}`));
  for (const r of righe) {
    const voto = el('input', { maxlength: 20, size: 4, value: r.voto || '', 'aria-label': 'Voto', disabled: !r.consegna_id });
    const comm = el('input', { maxlength: 5000, size: 26, value: r.commento || '', placeholder: 'Commento', 'aria-label': 'Commento', disabled: !r.consegna_id });
    tab.append(el('div', { class: 'cl-riga small', 'data-studente': r.username || '' }, el('b', {}, r.username || '(senza nome)'),
      el('span', { class: r.consegna_id ? (r.in_ritardo ? 'err' : 'ok') : 'muted' }, r.consegna_id ? `${quando(r.consegnata)} v${r.versione}${r.in_ritardo ? ' in ritardo' : ''}` : 'non consegnato'),
      r.consegna_id ? el('button', { class: 'small', onclick: async () => {
        const p = await prova(() => R().progettoConsegna(r.consegna_id));
        if (!p || p === ERR) return;
        const nome = await SV.daFilesTesto(`${e.titolo} — ${r.username}`, p, null);
        await loadProjects(); await selectProject(nome);
        dlg.close(); if (window.SVlayout) SVlayout.cassettoAperto(false);
        showTab('code');
      } }, 'Apri') : null,
      voto, comm,
      r.consegna_id ? el('button', { class: 'small', 'data-salva-voto': '', onclick: async () => { if ((await prova(() => R().valuta(r.consegna_id, comm.value, voto.value))) !== ERR) messaggioBreve(`Salvato per ${r.username}.`); } }, 'Salva') : null));
  }
  box.append(tab);
}

document.getElementById('btn-classi').addEventListener('click', () => { st.vista = 'elenco'; apri(); });
window.SVclassi = { apri };
