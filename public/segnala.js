// segnala.js — "Segnala un bug": modulo (titolo, descrizione, passi, cosa ti aspettavi, allegati facoltativi)
// e le mie segnalazioni con stato e risposta; per l'amministratore la pagina "Segnalazioni" (elenco, filtri,
// dettaglio, stato e risposta). Dati su Supabase (supabase/migrazione-3-segnalazioni.sql), via SV.remote.
// Chi è amministratore lo decide il database (is_admin(), legato all'ID): il pulsante si vede solo
// all'utente giamba, ma è solo una comodità, la sicurezza la fanno le regole RLS.
// Tutto quello che scrivono gli utenti si mostra con textContent, mai come HTML.
import { SEGN, SEGN_STATI } from './remote.js?v=2026-11-26c';

// versione del sito: quella nell'indirizzo di questo file (?v=…, la mette strumenti/alza-versione.sh)
export const VERSIONE_SITO = new URL(import.meta.url).searchParams.get('v') || 'sviluppo';
const ADMIN_NOME = 'giamba';
const BOZZA = 'sv-segnala-bozza', ULTIMA = 'sv-segnala-ultima';
const ATTESA_MS = 30000;
const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const quando = t => t ? new Date(t).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const R = () => window.SV && window.SV.remote && window.SV.remote.segnalazioni ? window.SV.remote.segnalazioni : null;
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };
const CAMPI = ['titolo', 'descrizione', 'passi', 'atteso'];

// ------------------------------------------------------------------
// Allegati
function ultimoRegistro() {
  const righe = [...document.querySelectorAll('#log .le')].slice(-200).map(x => [...x.children].map(c => c.textContent).join(' '));
  return righe.join('\n').slice(-SEGN.registro[1]);
}
async function progettoCorrente() {
  if (!S.selId) return null;
  const p = await SV.perLink(S.selId);
  return { nome: p.nome, files: p.files, devices: p.devices, breadboard: p.breadboard || null };
}
const browserInfo = () => (navigator.userAgent || '').slice(0, SEGN.browser[1]);

// ------------------------------------------------------------------
// Finestra "Segnala un bug"
const d = $('#segnala');
function messaggio(t, tipo = '') { const m = $('#segn-msg'); m.textContent = t; m.className = 'segn-msg small ' + tipo; m.hidden = !t; }
function salvaBozza() { const b = {}; for (const k of CAMPI) b[k] = $('#segn-' + k).value; ls.set(BOZZA, JSON.stringify(b)); }
function caricaBozza() { let b = {}; try { b = JSON.parse(ls.get(BOZZA)) || {}; } catch {} for (const k of CAMPI) $('#segn-' + k).value = typeof b[k] === 'string' ? b[k] : ''; }
function contatori() { for (const k of CAMPI) { const c = $(`[data-conta="${k}"]`); if (c) c.textContent = `${$('#segn-' + k).value.length}/${SEGN[k][1]}`; } }

async function apri() {
  caricaBozza(); contatori();
  messaggio('');
  const senza = !R() || !SV.account;
  $('#segn-senza p').textContent = SV.ospite
    ? 'Segnala un bug è per chi ha un account (così ti possiamo rispondere). Crea un account o entra dalla striscia in alto: i progetti che hai aperto vengono con te.'
    : 'Per mandare una segnalazione serve un account: in questa versione del sito non ci sono gli account.';
  $('#segn-form').hidden = senza;
  $('#segn-senza').hidden = !senza;
  $('#segn-prog').disabled = !S.selId;
  $('#segn-prog-nome').textContent = S.selId ? `«${S.selId}»` : '(nessun progetto scelto)';
  d.showModal();
  if (!senza) mie();
}
async function mie() {
  const box = $('#segn-mie');
  box.replaceChildren(el('p', 'muted small', 'Carico le tue segnalazioni…'));
  try {
    const l = await R().mie();
    box.replaceChildren();
    if (!l.length) { box.append(el('p', 'muted small', 'Non hai ancora mandato segnalazioni.')); return; }
    for (const s of l) {
      const r = el('div', 'segn-riga');
      const h = el('div', 'segn-rh');
      h.append(el('span', 'segn-stato st-' + s.stato.replace(' ', '-'), s.stato), el('b', '', s.titolo), el('span', 'muted small', quando(s.creata)));
      r.append(h);
      if (s.risposta) { const a = el('div', 'segn-risposta small'); a.append(el('b', '', 'Risposta: '), document.createTextNode(s.risposta)); r.append(a); }
      box.append(r);
    }
  } catch (e) { box.replaceChildren(el('p', 'small ' + (e.code === 'assente' ? 'muted' : 'segn-err'), e.message || String(e))); }
}
async function invia(ev) {
  ev.preventDefault();
  const ult = +(ls.get(ULTIMA) || 0);
  if (Date.now() - ult < ATTESA_MS) { messaggio(`Aspetta ancora ${Math.ceil((ATTESA_MS - (Date.now() - ult)) / 1000)} secondi prima di mandarne un'altra.`, 'segn-err'); return; }
  const b = $('#segn-invia');
  b.disabled = true;
  messaggio('Invio…');
  try {
    const s = { titolo: $('#segn-titolo').value, descrizione: $('#segn-descrizione').value, passi: $('#segn-passi').value, atteso: $('#segn-atteso').value };
    if ($('#segn-reg').checked) s.registro = ultimoRegistro();
    if ($('#segn-br').checked) { s.browser = browserInfo(); s.versione = VERSIONE_SITO; }
    if ($('#segn-prog').checked && S.selId) {
      if (window.SVeditor && SVeditor.isDirty()) await SVeditor.saveAll();
      s.progetto = await progettoCorrente();
    }
    const r = await R().invia(s);
    ls.set(ULTIMA, String(Date.now()));
    ls.del(BOZZA);
    for (const k of CAMPI) $('#segn-' + k).value = '';
    contatori();
    messaggio(`Grazie! Segnalazione n. ${r.id} inviata: qui sotto ne vedi lo stato e la risposta.`, 'segn-ok');
    mie();
  } catch (e) {
    messaggio(e.message || String(e), e.code === 'assente' ? 'segn-info' : 'segn-err');
  } finally { b.disabled = false; }
}

// ------------------------------------------------------------------
// Pagina "Segnalazioni" (amministratore)
const A = $('#segn-admin');
let elenco = [], nomi = {}, aperta = null;
async function apriAdmin() {
  A.showModal();
  const box = $('#sa-lista');
  box.replaceChildren(el('p', 'muted small', 'Controllo…'));
  $('#sa-dett').replaceChildren();
  try {
    if (!(await R().admin())) { box.replaceChildren(el('p', 'small segn-err', 'Questa pagina è solo per l\'amministratore (o le segnalazioni non sono ancora attive sul database).')); return; }
    await caricaAdmin();
  } catch (e) { box.replaceChildren(el('p', 'small segn-err', e.message || String(e))); }
}
async function caricaAdmin() {
  elenco = await R().tutte({ stato: $('#sa-stato').value || undefined });
  const ids = [...new Set(elenco.map(s => s.autore).filter(Boolean))].filter(id => !(id in nomi));
  if (ids.length) for (const n of await R().nomi(ids)) nomi[n.id] = n.username;
  disegnaAdmin();
}
function disegnaAdmin() {
  const f = $('#sa-cerca').value.trim().toLowerCase();
  const l = elenco.filter(s => !f || s.titolo.toLowerCase().includes(f) || (nomi[s.autore] || '').includes(f) || String(s.id) === f);
  const box = $('#sa-lista');
  box.replaceChildren();
  const conta = {};
  for (const s of elenco) conta[s.stato] = (conta[s.stato] || 0) + 1;
  $('#sa-conta').textContent = elenco.length ? SEGN_STATI.filter(x => conta[x]).map(x => `${conta[x]} ${x}`).join(' · ') : '';
  if (!l.length) { box.append(el('p', 'muted small', 'Nessuna segnalazione.')); return; }
  for (const s of l) {
    const r = el('button', 'sa-riga' + (aperta === s.id ? ' on' : ''));
    r.type = 'button';
    r.append(el('span', 'muted small', '#' + s.id), el('span', 'segn-stato st-' + s.stato.replace(' ', '-'), s.stato), el('b', '', s.titolo), el('span', 'muted small', `${nomi[s.autore] || '?'} · ${quando(s.creata)}`));
    r.addEventListener('click', () => dettaglio(s.id));
    box.append(r);
  }
}
async function dettaglio(id) {
  aperta = id; disegnaAdmin();
  const box = $('#sa-dett');
  box.replaceChildren(el('p', 'muted small', 'Carico…'));
  let s;
  try { s = await R().dettaglio(id); } catch (e) { box.replaceChildren(el('p', 'small segn-err', e.message)); return; }
  if (!s) { box.replaceChildren(el('p', 'small segn-err', 'Segnalazione non trovata.')); return; }
  box.replaceChildren();
  box.append(el('h3', '', `#${s.id} — ${s.titolo}`), el('p', 'muted small', `${nomi[s.autore] || '?'} · ${quando(s.creata)}${s.versione ? ' · sito ' + s.versione : ''}`));
  const sez = (t, v, pre) => { if (!v) return; box.append(el('h4', '', t)); box.append(el(pre ? 'pre' : 'p', pre ? 'sa-pre' : 'sa-testo', v)); };
  sez('Descrizione', s.descrizione); sez('Passi per riprodurre', s.passi); sez('Cosa si aspettava', s.atteso);
  sez('Browser', s.browser); sez('Registro', s.registro, true);
  if (s.progetto && typeof s.progetto === 'object') {
    box.append(el('h4', '', 'Progetto allegato'));
    const nf = s.progetto.files ? Object.keys(s.progetto.files).length : 0;
    const riga = el('div', 'sa-azioni');
    const scarica = el('button', 'small', 'Scarica (.json)');
    scarica.type = 'button';
    scarica.addEventListener('click', () => {
      const a = el('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(s.progetto, null, 1)], { type: 'application/json' }));
      a.download = `segnalazione-${s.id}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    const apri = el('button', 'small', 'Apri nei miei progetti');
    apri.type = 'button';
    apri.addEventListener('click', async () => {
      try {
        const nome = `Segnalazione ${s.id} - ${String(s.progetto.nome || 'progetto').replace(/[^\w\- ()]/g, '_').slice(0, 40)}`, u = {}, enc = new TextEncoder();
        for (const [k, v] of Object.entries(s.progetto.files || {})) if (typeof v === 'string' && !k.split('/').includes('..')) u[nome + '/' + k] = enc.encode(v);
        if (s.progetto.breadboard) u[nome + '/.breadboard.json'] = enc.encode(JSON.stringify(s.progetto.breadboard));
        if (Array.isArray(s.progetto.devices)) u[nome + '/.scheda-virtuale.json'] = enc.encode(JSON.stringify({ devices: s.progetto.devices }));
        const trovati = SV.findProjects(u).slice(0, 1);
        if (!trovati.length) throw new Error('nel progetto allegato non c\'è un progetto CubeIDE');
        trovati[0].nome = nome;   // se no prenderebbe il nome dal .ioc
        const n = await SV.addProjects(trovati, false);
        await loadProjects(); if (n[0]) await selectProject(n[0]);
        A.close();
      } catch (e) { alert('Non riesco ad aprirlo: ' + (e.message || e)); }
    });
    riga.append(el('span', 'small', `«${s.progetto.nome || '?'}», ${nf} file${s.progetto.breadboard ? ', breadboard' : ''}`), scarica, apri);
    box.append(riga);
  }
  // stato e risposta
  box.append(el('h4', '', 'Stato e risposta'));
  const st = el('select');
  for (const x of SEGN_STATI) { const o = el('option', '', x); o.value = x; o.selected = x === s.stato; st.append(o); }
  const ri = el('textarea'); ri.maxLength = 5000; ri.rows = 4; ri.value = s.risposta || ''; ri.placeholder = 'Risposta per chi l\'ha mandata (la vede nelle sue segnalazioni)';
  const salva = el('button', 'primary small', 'Salva'); salva.type = 'button';
  const esito = el('span', 'small muted');
  salva.addEventListener('click', async () => {
    salva.disabled = true;
    try { const r = await R().aggiorna(s.id, { stato: st.value, risposta: ri.value }); Object.assign(elenco.find(x => x.id === s.id) || {}, r); disegnaAdmin(); esito.textContent = 'Salvato.'; }
    catch (e) { esito.textContent = e.message || String(e); }
    finally { salva.disabled = false; }
  });
  const r = el('div', 'sa-azioni'); r.append(st, salva, esito);
  box.append(ri, r);
}

// ------------------------------------------------------------------
$('#btn-bug').addEventListener('click', apri);
$('#segn-form').addEventListener('submit', invia);
$('#segn-form').addEventListener('input', () => { salvaBozza(); contatori(); });
$('#segn-chiudi').addEventListener('click', () => d.close());
$('#segn-chiudi2').addEventListener('click', () => d.close());
for (const k of CAMPI) { const i = $('#segn-' + k); i.maxLength = SEGN[k][1]; if (SEGN[k][0]) i.minLength = SEGN[k][0]; }
$('#sa-stato').addEventListener('change', () => caricaAdmin().catch(e => $('#sa-lista').replaceChildren(el('p', 'small segn-err', e.message))));
$('#sa-cerca').addEventListener('input', disegnaAdmin);
$('#sa-aggiorna').addEventListener('click', () => caricaAdmin().catch(e => $('#sa-lista').replaceChildren(el('p', 'small segn-err', e.message))));
$('#sa-chiudi').addEventListener('click', () => A.close());
$('#btn-segn-admin').addEventListener('click', apriAdmin);
// il pulsante della pagina amministratore: solo per giamba (la verifica vera è is_admin() nel database)
$('#btn-segn-admin').hidden = !(SV.account && SV.account.username === ADMIN_NOME && R());
window.SVsegnala = { apri, apriAdmin };
