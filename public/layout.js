// layout.js — il "banco di lavoro" (24/11/2026, tappa A): cassetto dei progetti (☰), pannello a schede in
// basso che si alza, si abbassa e si ridimensiona, tema scuro/chiaro, guida al primo avvio (5 passi).
// Usa $, showTab di app.js. Le preferenze stanno in localStorage (solo comodità di chi guarda).
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const root = document.documentElement;

// altezza della barra in alto (va a capo su schermi stretti)
const top = document.querySelector('header.top');
const misuraTop = () => root.style.setProperty('--top-h', top.getBoundingClientRect().height + 'px');
new ResizeObserver(misuraTop).observe(top);
misuraTop();

// ------------------------------------------------------------------
// Cassetto: progetti, account, zip, condividi, esercizio
const cassetto = document.getElementById('cassetto');
export function cassettoAperto(v) {
  document.body.classList.toggle('cassetto-aperto', v);
  document.getElementById('btn-cassetto').classList.toggle('on', v);
}
document.getElementById('btn-cassetto').addEventListener('click', () => cassettoAperto(!document.body.classList.contains('cassetto-aperto')));
document.addEventListener('pointerdown', e => {
  if (!document.body.classList.contains('cassetto-aperto')) return;
  if (cassetto.contains(e.target) || e.target.closest('#btn-cassetto') || e.target.closest('dialog')) return;
  cassettoAperto(false);
});
// scelto un progetto dall'elenco: il cassetto si chiude
document.getElementById('projlist').addEventListener('click', e => { if (e.target.closest('.proj')) setTimeout(() => cassettoAperto(false), 120); });
// nessun progetto ancora: si apre da solo
setTimeout(() => { if ((typeof S === 'undefined' || !S.selId) && !card && ls.get('sv-tour') === 'fatto') cassettoAperto(true); }, 1500);

// ------------------------------------------------------------------
// Pannello in basso
const MIN = 120;
const pannelloH = () => parseInt(getComputedStyle(root).getPropertyValue('--pannello-h')) || 300;
function impostaH(h) {
  h = Math.max(MIN, Math.min(Math.round(window.innerHeight * 0.8), Math.round(h)));
  root.style.setProperty('--pannello-h', h + 'px');
  ls.set('sv-pannello-h', String(h));
}
export function pannelloChiuso(v) {
  document.body.classList.toggle('pannello-chiuso', v);
  document.getElementById('pannello-su').textContent = v ? '▴' : '▾';
  ls.set('sv-pannello-chiuso', v ? '1' : '');
  window.dispatchEvent(new Event('resize'));
}
{
  const h = +ls.get('sv-pannello-h');
  if (h) impostaH(h);
  pannelloChiuso(ls.get('sv-pannello-chiuso') === '1');
  const man = document.getElementById('pannello-maniglia');
  man.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { man.setPointerCapture(e.pointerId); } catch {}
    man.classList.add('attiva');
    if (document.body.classList.contains('pannello-chiuso')) { pannelloChiuso(false); impostaH(MIN); }
    const y0 = e.clientY, h0 = pannelloH();
    const muovi = ev => impostaH(h0 + (y0 - ev.clientY));
    const fine = () => { man.classList.remove('attiva'); man.removeEventListener('pointermove', muovi); window.dispatchEvent(new Event('resize')); };
    man.addEventListener('pointermove', muovi);
    man.addEventListener('pointerup', fine, { once: true });
    man.addEventListener('pointercancel', fine, { once: true });
  });
  man.addEventListener('dblclick', () => pannelloChiuso(!document.body.classList.contains('pannello-chiuso')));
  document.getElementById('pannello-su').addEventListener('click', () => pannelloChiuso(!document.body.classList.contains('pannello-chiuso')));
  // una scheda cliccata con il pannello chiuso lo riapre
  document.querySelectorAll('#pannello .tab').forEach(t => t.addEventListener('click', () => { if (document.body.classList.contains('pannello-chiuso')) pannelloChiuso(false); }));
  // scheda salvata che non c'è più (es. "breadboard", ora al centro)
  if (!document.querySelector('#pannello .tab.active:not([hidden])')) showTab('code');
}

// ------------------------------------------------------------------
// Tema
const bTema = document.getElementById('btn-tema');
const tema = () => root.dataset.theme === 'light' ? 'light' : 'dark';
bTema.textContent = tema() === 'dark' ? 'Tema chiaro' : 'Tema scuro';
bTema.addEventListener('click', () => {
  const t = tema() === 'dark' ? 'light' : 'dark';
  root.dataset.theme = t; ls.set('sv-tema', t);
  bTema.textContent = t === 'dark' ? 'Tema chiaro' : 'Tema scuro';
});

// ------------------------------------------------------------------
// Guida al primo avvio: 5 passi, riapribile dal "?" del banco o dal cassetto
const PASSI = [
  { el: '#palette', t: '1. Metti un componente', p: 'Trascina un componente dalla palette sulla breadboard (o cliccalo e poi clicca dove posarlo). I fori verdi dicono dove si aggancia, quelli rossi dove no. R lo ruota.' },
  { el: '#bb-svg', t: '2. Fai un filo', p: 'Clicca un foro o un pin della Nucleo, poi clicca l\'arrivo: il filo si fa da solo, a 90°, rosso per 5V/3V3, nero per GND. Esc annulla, W fa partire un filo dal punto sotto il mouse.' },
  { el: '#btn-cassetto', t: '3. Carica il codice', p: 'Nel menu ☰ apri o crea un progetto (📁 Cartella o 🗜 Zip del progetto CubeIDE, oppure ＋ Nuovo). Il codice si scrive nella scheda Codice qui sotto.' },
  { el: '#btn-run', t: '4. Avvia', p: 'Compila e fa partire la scheda virtuale: LED e display della breadboard si accendono con le correnti vere, i pulsanti si premono con il mouse.' },
  { el: '#pannello .tab[data-tab="scope"]', t: '5. Guarda i segnali', p: 'Nella scheda Segnali c\'è l\'analizzatore logico dei pin; in Registro gli avvisi del laboratorio (corti, LED senza resistenza, pin oltre 25 mA).' },
];
let luce = null, card = null, passo = 0;
function chiudiTour() { luce?.remove(); card?.remove(); luce = card = null; ls.set('sv-tour', 'fatto'); if (typeof S === 'undefined' || !S.selId) cassettoAperto(true); }
function mostra(i) {
  passo = i;
  const s = PASSI[i], t = document.querySelector(s.el);
  if (!luce) { luce = document.createElement('div'); luce.className = 'tour-luce'; document.body.append(luce); }
  if (!card) { card = document.createElement('div'); card.className = 'tour-card'; card.setAttribute('role', 'dialog'); document.body.append(card); }
  const r = t ? t.getBoundingClientRect() : { left: innerWidth / 2 - 40, top: innerHeight / 2 - 40, width: 80, height: 80 };
  Object.assign(luce.style, { left: r.left - 4 + 'px', top: r.top - 4 + 'px', width: r.width + 8 + 'px', height: r.height + 8 + 'px' });
  card.replaceChildren();
  const h = document.createElement('h3'); h.textContent = s.t;
  const p = document.createElement('p'); p.textContent = s.p;
  const bar = document.createElement('div'); bar.className = 'right';
  const n = document.createElement('span'); n.className = 'passo muted small'; n.textContent = `${i + 1} di ${PASSI.length}`;
  const b = (txt, cls, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = cls; x.textContent = txt; x.addEventListener('click', fn); return x; };
  bar.append(n, b('Salta', 'ghost small', chiudiTour));
  if (i > 0) bar.append(b('Indietro', 'small', () => mostra(i - 1)));
  bar.append(b(i < PASSI.length - 1 ? 'Avanti' : 'Fine', 'primary small', () => i < PASSI.length - 1 ? mostra(i + 1) : chiudiTour()));
  card.append(h, p, bar);
  // la scheda accanto all'elemento, dentro lo schermo
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x = r.right + 14, y = r.top;
  if (x + cw > innerWidth - 8) x = Math.max(8, r.left - cw - 14);
  if (x < 8 || r.width > innerWidth * 0.5) { x = Math.min(innerWidth - cw - 8, Math.max(8, r.left + 20)); y = r.bottom + 14 > innerHeight - ch - 8 ? Math.max(8, r.top + 20) : r.bottom + 14; }
  card.style.left = x + 'px'; card.style.top = Math.min(innerHeight - ch - 8, Math.max(8, y)) + 'px';
}
export function tour() { cassettoAperto(false); mostra(0); }
document.addEventListener('keydown', e => { if (card && e.key === 'Escape') chiudiTour(); });
window.addEventListener('resize', () => { if (card) mostra(passo); });
document.getElementById('btn-tour').addEventListener('click', () => { cassettoAperto(false); tour(); });
// ------------------------------------------------------------------
// Vista al centro: Breadboard o Scheda e dispositivi (Nucleo disegnata, Dispositivi, interrupt).
// Una sola delle due al centro; la scelta resta per progetto (e come ultima scelta in generale).
// La simulazione non si ferma: tutte e due si aggiornano anche quando non si vedono.
const chiaveVista = () => 'sv-vista:' + ((typeof S !== 'undefined' && S.selId) || '');
export function vista(v, salva = true) {
  if (v !== 'scheda') v = 'breadboard';
  document.getElementById('pane-breadboard').hidden = v !== 'breadboard';
  document.getElementById('vista-scheda').hidden = v !== 'scheda';
  document.querySelectorAll('.vista-btn').forEach(b => { b.classList.toggle('on', b.dataset.vista === v); b.setAttribute('aria-selected', b.dataset.vista === v); });
  document.body.dataset.vista = v;
  if (salva) { ls.set(chiaveVista(), v); ls.set('sv-vista', v); }
  if (typeof S !== 'undefined') S.dirty = true;
  window.dispatchEvent(new Event('resize'));
}
document.querySelectorAll('.vista-btn').forEach(b => b.addEventListener('click', () => vista(b.dataset.vista)));
let progettoVista = null;
setInterval(() => { const id = typeof S !== 'undefined' && S.selId; if (id !== progettoVista) { progettoVista = id; vista(ls.get(chiaveVista()) || ls.get('sv-vista') || 'breadboard', false); } }, 300);
vista(ls.get('sv-vista') || 'breadboard', false);
// V = cambia vista (B no: è già il pulsante B1 della scheda; non mentre si scrive o con una finestra aperta)
document.addEventListener('keydown', e => {
  const t = e.target;
  if (e.ctrlKey || e.metaKey || e.altKey || (t && t.closest && t.closest('input, textarea, select, [contenteditable], .cm-editor'))) return;
  if (document.querySelector('dialog[open]') || card) return;
  const k = e.key.toLowerCase();
  if (k === 'v' && !e.repeat) { e.preventDefault(); vista(document.body.dataset.vista === 'scheda' ? 'breadboard' : 'scheda'); }
});

window.SVlayout = { tour, cassettoAperto, pannelloChiuso, impostaH, vista };
if (ls.get('sv-tour') !== 'fatto' && !document.body.classList.contains('anteprima')) setTimeout(tour, 1200);
