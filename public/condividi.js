// condividi.js — "Condividi" ed "Esercizio" (link con dentro una copia del progetto, link.js),
// l'anteprima di un link aperto e il riquadro con la consegna dell'esercizio accanto all'editor.
// Usa S, $, showTab, selectProject di app.js e SV di local-server.js.
// Tutto quello che arriva da un link (nomi, titolo, consegna) si scrive con textContent, mai come HTML.
import { creaLink, LINK_LUNGO, LINK_TROPPO } from './link.js';

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };

// ------------------------------------------------------------------
// Consegna: markdown minimo (# titolo, - elenco, ``` blocco, **grassetto**, *corsivo*, `codice`) → nodi DOM
function inline(parent, s) {
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) parent.append(s.slice(last, m.index));
    parent.append(m[2] !== undefined ? el('b', '', m[2]) : m[3] !== undefined ? el('i', '', m[3]) : el('code', '', m[4]));
    last = re.lastIndex;
  }
  if (last < s.length) parent.append(s.slice(last));
}
export function rendiConsegna(box, testo) {
  box.replaceChildren();
  let ul = null, pre = null, p = null;
  for (const riga of testo.split('\n')) {
    if (pre) { if (/^```/.test(riga)) pre = null; else pre.textContent += (pre.textContent ? '\n' : '') + riga; continue; }
    if (/^```/.test(riga)) { pre = el('pre'); box.append(pre); ul = p = null; continue; }
    const h = /^#{1,3}\s+(.*)$/.exec(riga), li = /^\s*[-*]\s+(.*)$/.exec(riga);
    if (h) { const e = el('h4'); inline(e, h[1]); box.append(e); ul = p = null; }
    else if (li) { if (!ul) { ul = el('ul'); box.append(ul); } const e = el('li'); inline(e, li[1]); ul.append(e); p = null; }
    else if (!riga.trim()) { ul = p = null; }
    else { if (!p) { p = el('p'); box.append(p); } else p.append(el('br')); inline(p, riga); ul = null; }
  }
}

async function aggiornaConsegna() {
  const box = $('#consegna');
  const es = S.selId ? await SV.esercizio(S.selId) : null;
  box.hidden = !es;
  if (!es) return;
  $('#consegna-titolo').textContent = es.titolo;
  rendiConsegna($('#consegna-testo'), es.testo);
}
const _renderFiles = window.renderFiles;
window.renderFiles = function () { _renderFiles(); aggiornaConsegna(); };

// ------------------------------------------------------------------
// Anteprima di un link
const ant = SV.anteprima;
if (ant) {
  document.body.classList.add('anteprima');
  $('#anteprima').hidden = false;
  $('#ant-titolo').textContent = (ant.tipo === 'esercizio' ? 'Esercizio: ' : 'Progetto condiviso: ') + ant.nome;
  $('#btn-salva-copia').addEventListener('click', async () => {
    if (window.SVeditor && SVeditor.isDirty()) await SVeditor.saveAll();
    SV.salvaAnteprima();
  });
  window.addEventListener('sv-aperto-da-link', () => { if (ant.tipo === 'esercizio') showTab('code'); }, { once: true });
}

// ------------------------------------------------------------------
// Finestra "Condividi" / "Esercizio"
const d = $('#condividi');
let base = null;   // dati del progetto per il link (SV.perLink)

function mostraLink(p) {
  const r = creaLink(location.origin + location.pathname, p);
  $('#cond-link').value = r.url;
  const kb = (r.lunghezza / 1000).toFixed(1).replace('.', ',');
  const lung = $('#cond-lung');
  lung.className = 'small' + (r.lunghezza > LINK_LUNGO ? ' avviso' : '');
  lung.textContent = `Lunghezza: ${r.lunghezza.toLocaleString('it-IT')} caratteri (${kb} k).` +
    (r.lunghezza > LINK_TROPPO ? ' Troppo lungo: molte chat e programmi lo tagliano. Meglio mandare lo zip (⬇ Zip).'
      : r.lunghezza > LINK_LUNGO ? ' È lungo: va bene per mail e Classroom, ma qualche chat potrebbe tagliarlo. Se chi lo apre vede «link rovinato», manda lo zip.'
      : ' Va bene per chat, mail e Classroom.') +
    (r.tolti.length ? ` Non servono e non ci sono: ${r.tolti.map(f => f.split('/').pop()).join(', ')}.` : '');
  $('#cond-out').hidden = false;
  $('#cond-copiato').hidden = true;
}

async function apri(esercizio) {
  if (!S.selId) return;
  if (window.SVeditor && SVeditor.isDirty()) await SVeditor.saveAll();
  base = await SV.perLink(S.selId);
  $('#cond-titolo').textContent = esercizio ? 'Crea un esercizio' : 'Condividi con un link';
  $('#cond-spiega').textContent = esercizio
    ? `Da «${base.nome}»: chi apre il link vede la consegna accanto al codice e lavora su una sua copia (anche senza account).`
    : `Nel link c'è una copia di «${base.nome}» (file, dispositivi collegati, canali dei Segnali). Chi lo apre la prova e può salvarsela; il tuo progetto non cambia. Il progetto viaggia dentro il link: non passa da nessun server.`;
  $('#cond-es').hidden = !esercizio;
  $('#cond-out').hidden = true;
  if (esercizio) {
    const es = base.esercizio || { titolo: '', testo: '', sola: [] };
    $('#cond-es-titolo').value = es.titolo || base.nome;
    $('#cond-es-testo').value = es.testo;
    const box = $('#cond-es-file');
    box.replaceChildren();
    for (const rel of Object.keys(base.files).filter(f => /\.(c|h)$/.test(f)).sort()) {
      const l = el('label'), c = el('input');
      c.type = 'checkbox'; c.value = rel; c.checked = es.sola.includes(rel);
      l.append(c, ' ' + rel.split('/').pop());
      l.title = rel;
      box.append(l);
    }
  } else mostraLink({ ...base });
  d.showModal();
}
$('#btn-condividi').addEventListener('click', () => apri(false));
$('#btn-esercizio').addEventListener('click', () => apri(true));
$('#cond-crea').addEventListener('click', () => mostraLink({
  ...base,
  esercizio: {
    titolo: $('#cond-es-titolo').value.trim() || base.nome,
    testo: $('#cond-es-testo').value,
    sola: [...$('#cond-es-file').querySelectorAll('input:checked')].map(c => c.value),
  },
}));
$('#cond-copia').addEventListener('click', async () => {
  const t = $('#cond-link');
  try { await navigator.clipboard.writeText(t.value); }
  catch { t.select(); document.execCommand('copy'); }
  $('#cond-copiato').hidden = false;
});

// link incollato nella barra di una scheda già aperta sul sito: cambia solo il # → si ricarica per aprirlo
window.addEventListener('hashchange', () => { if (/^#(progetto|esercizio)=/.test(location.hash)) location.reload(); });
