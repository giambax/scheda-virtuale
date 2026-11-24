// breadboard.js — scheda "Breadboard": si montano i componenti su una breadboard da 830 punti,
// si tirano i fili verso i connettori della Nucleo e la simulazione segue i collegamenti veri.
// Circuito, netlist e solutore stanno in circuito.js; qui c'è l'editor (SVG) e il collegamento
// con il simulatore: a ogni cambio dei pin (righe "C"/"M"/"W") si risolve il circuito in continua
// (con una cache per stato dei pin), si fa la media nel tempo per la luminosità (multiplexing) e
// si mandano agli ingressi della scheda i livelli letti sui nodi ("I porta pin livello").
// Usa S, $, esc, cmd, addLog, pinInfo, parseKey, ADC_PIN di app.js, SEG_SHAPE/SEG_DIGIT/buzzSet di devices.js,
// SV di local-server.js. Il circuito si salva nel progetto come file ".breadboard.json".
import * as K from './circuito.js';

const P = 10;                       // pixel SVG per passo (0,1")
const NS = 'http://www.w3.org/2000/svg';
const FILE = '.breadboard.json';
const MONDO = { x: -16, y: -6, w: 120, h: 66 };
const MAX_RISOLUZIONI = 300;        // soluzioni nuove per fotogramma (oltre si aspetta il successivo)
const CACHE_MAX = 600;

const B = {
  proj: null, caricato: null, bb: { v: 1, comps: [], wires: [] },
  sel: new Set(), undo: [], redo: [], clip: null,
  vista: { ...MONDO }, drag: null, hover: null,
  net: null, circ: null, corti: [], dirtyCirc: true,
  cache: new Map(), stato: null, chiaveStato: '', ultimo: null, ultimoMs: 0,
  acc: null, pub: null, premuti: new Set(), enc: {}, encPos: {},
  inviati: new Map(), adcInviati: new Map(), problemi: new Map(), segnalati: new Set(),
  capV: new Map(), salvaT: null, risolte: 0, colore: K.COLORI_FILO[3], rallentato: false,
};
window.BB = B;

// ------------------------------------------------------------------
// Disegno statico: Nucleo + breadboard
const svgEl = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
function disegnoStatico() {
  const N = K.NUCLEO, BB_ = K.BB;
  let s = '';
  // Nucleo
  s += `<rect x="${N.x * P - 4}" y="${N.y * P}" width="${(N.w + 1) * P}" height="${N.h * P}" rx="6" fill="#f2f2f2" stroke="#9aa0a6"/>`;
  s += `<rect x="${N.x * P + 60}" y="${N.y * P + 4}" width="180" height="78" rx="4" fill="#e6e6e6" stroke="#b0b4ba"/>`;
  s += `<text x="${N.x * P + 150}" y="${N.y * P + 30}" font-size="11" text-anchor="middle" fill="#455" font-family="sans-serif">ST-LINK/V2-1</text>`;
  s += `<rect x="${N.x * P + 130}" y="${N.y * P - 6}" width="40" height="18" rx="2" fill="#aab" stroke="#778"/>`;
  s += `<text x="${N.x * P + 150}" y="${N.y * P + 104}" font-size="12" font-weight="bold" text-anchor="middle" fill="#1d3a6b" font-family="sans-serif">NUCLEO-F401RE</text>`;
  s += `<rect x="${N.x * P + 110}" y="${N.y * P + 190}" width="80" height="80" fill="#2b2b2b" stroke="#111"/><text x="${N.x * P + 150}" y="${N.y * P + 234}" font-size="8" text-anchor="middle" fill="#ccc" font-family="sans-serif">STM32F401RE</text>`;
  // LD2 e B1 (disegnati; LD2 si accende come sulla scheda)
  s += `<circle id="bb-ld2" cx="${N.x * P + 200}" cy="${N.y * P + 150}" r="5" fill="#2d4a33"/><text x="${N.x * P + 212}" y="${N.y * P + 153}" font-size="8" fill="#455" font-family="sans-serif">LD2</text>`;
  s += `<rect x="${N.x * P + 80}" y="${N.y * P + 330}" width="26" height="26" rx="3" fill="#ddd" stroke="#888"/><circle cx="${N.x * P + 93}" cy="${N.y * P + 343}" r="8" fill="#1e5bd8"/><text x="${N.x * P + 93}" y="${N.y * P + 370}" font-size="8" text-anchor="middle" fill="#455" font-family="sans-serif">B1</text>`;
  s += `<text x="${1.5 * P}" y="${11 * P - 2}" font-size="8" text-anchor="middle" fill="#455" font-family="sans-serif">CN7</text><text x="${27.5 * P}" y="${11 * P - 2}" font-size="8" text-anchor="middle" fill="#455" font-family="sans-serif">CN10</text>`;
  s += `<text x="${5 * P}" y="${13 * P - 2}" font-size="7" text-anchor="middle" fill="#455" font-family="sans-serif">CN6</text><text x="${5 * P}" y="${22 * P - 2}" font-size="7" text-anchor="middle" fill="#455" font-family="sans-serif">CN8</text>`;
  s += `<text x="${24 * P}" y="${9 * P - 2}" font-size="7" text-anchor="middle" fill="#455" font-family="sans-serif">CN5</text><text x="${24 * P}" y="${20 * P - 2}" font-size="7" text-anchor="middle" fill="#455" font-family="sans-serif">CN9</text>`;
  // connettori: strisce nere sotto i fori
  s += `<rect x="${0.5 * P}" y="${11.5 * P}" width="${2 * P}" height="${19 * P}" fill="#222"/><rect x="${26.5 * P}" y="${11.5 * P}" width="${2 * P}" height="${19 * P}" fill="#222"/>`;
  s += `<rect x="${4.5 * P}" y="${13.5 * P}" width="${P}" height="${8 * P}" fill="#222"/><rect x="${4.5 * P}" y="${22.5 * P}" width="${P}" height="${6 * P}" fill="#222"/>`;
  s += `<rect x="${23.5 * P}" y="${9.5 * P}" width="${P}" height="${10 * P}" fill="#222"/><rect x="${23.5 * P}" y="${20.5 * P}" width="${P}" height="${8 * P}" fill="#222"/>`;
  // breadboard
  const bx = BB_.x * P, by = BB_.y * P;
  s += `<rect x="${bx}" y="${by - 0.8 * P}" width="${BB_.w * P}" height="${(BB_.h + 0.6) * P}" rx="6" fill="#f7f5ee" stroke="#cfcab8"/>`;
  s += `<rect x="${bx + 2}" y="${by + 8.2 * P}" width="${BB_.w * P - 4}" height="${0.6 * P}" fill="#e4e0d2"/>`;
  for (const [dy, col] of [[-0.5, '#d33'], [1.5, '#26c'], [16.5, '#d33'], [18.5, '#26c']]) s += `<line x1="${bx + 3 * P}" x2="${bx + 63 * P}" y1="${by + dy * P}" y2="${by + dy * P}" stroke="${col}" stroke-width="1"/>`;
  for (const [dy, t] of [[0, '+'], [1, '−'], [17, '+'], [18, '−']]) s += `<text x="${bx + 1.6 * P}" y="${by + dy * P + 3}" font-size="9" text-anchor="middle" fill="${t === '+' ? '#d33' : '#26c'}" font-family="sans-serif">${t}</text>`;
  'abcdefghij'.split('').forEach((r, i) => s += `<text x="${bx + 1 * P}" y="${by + (i < 5 ? 3 + i : 5 + i) * P + 3}" font-size="7" text-anchor="middle" fill="#888" font-family="sans-serif">${r}</text>`);
  for (let c = 1; c <= 63; c += c === 1 ? 4 : 5) s += `<text x="${bx + (1 + c) * P}" y="${by + 2.3 * P}" font-size="6.5" text-anchor="middle" fill="#888" font-family="sans-serif">${c}</text>`;
  // fori
  for (const f of K.FORI.values()) s += `<rect x="${f.x * P - 2.2}" y="${f.y * P - 2.2}" width="4.4" height="4.4" rx="0.8" fill="${f.id.startsWith('CN') ? '#c8a85a' : '#3d3d3d'}"/>`;
  return s;
}

// ------------------------------------------------------------------
// Componenti
const BANDE = ['#000', '#7b3f00', '#e00', '#f80', '#ee0', '#0a0', '#00f', '#90f', '#888', '#fff'];
function bandeResistore(r) {
  const e = Math.floor(Math.log10(r) + 1e-9) - 1, d = Math.round(r / 10 ** e);
  const a = Math.floor(d / 10) % 10, b = d % 10;
  return [BANDE[a], BANDE[b], e >= 0 && e <= 9 ? BANDE[e] : e === -1 ? '#c9a227' : '#ccc', '#c9a227'];
}
function cifraSVG(id, d, x, y, sc) {
  return `<g transform="translate(${x} ${y}) scale(${sc}) skewX(-6)">${K.SEGS.slice(0, 7).map(s => `<polygon data-seg="${id}:${d * 8 + K.SEGS.indexOf(s)}" points="${SEG_SHAPE[s]}" fill="#3a1414"/>`).join('')}<circle data-seg="${id}:${d * 8 + 7}" cx="88" cy="150" r="7" fill="#3a1414"/></g>`;
}
function compSVG(c) {
  const o = c.opt, id = c.id;
  const leg = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#a7a9ac" stroke-width="1.6" stroke-linecap="round"/>`;
  switch (c.type) {
    case 'res': {
      const L = (o.span || 4) * P, m = L / 2, w = Math.min(26, L - 6), bd = bandeResistore(o.r);
      return leg(0, 0, L, 0) + `<rect x="${m - w / 2}" y="-4.5" width="${w}" height="9" rx="4" fill="#d9bf8c" stroke="#a08850" stroke-width=".6"/>` +
        bd.map((col, i) => `<rect x="${m - w / 2 + 4 + i * (w - 9) / 3.4 + (i === 3 ? 2 : 0)}" y="-4.5" width="2.4" height="9" fill="${col}"/>`).join('');
    }
    case 'jumper': { const L = (o.span || 2) * P; return `<path d="M0 0 L0 -4 L${L} -4 L${L} 0" fill="none" stroke="#e8822a" stroke-width="3" stroke-linejoin="round"/>`; }
    case 'led': {
      const col = K.LED_COL[o.color][0];
      return leg(0, 0, 2, -6) + leg(P, 0, 8, -6) + `<circle data-glow="${id}" cx="5" cy="-11" r="12" fill="${col}" opacity="0" filter="url(#bb-blur)"/>` +
        `<path d="M-1.5 -8 A6.5 6.5 0 1 1 11.5 -8 L11.5 -5 L-1.5 -5 Z" fill="${col}" fill-opacity=".55" stroke="${col}" stroke-width=".8" data-lens="${id}"/><text x="-2" y="5" font-size="5" fill="#666" font-family="sans-serif">+</text>`;
    }
    case 'diode': return leg(0, 0, 4 * P, 0) + `<rect x="12" y="-3.5" width="16" height="7" rx="1" fill="#222"/><rect x="24" y="-3.5" width="2.5" height="7" fill="#ccc"/>`;
    case 'cap': return o.c >= 1e-6
      ? leg(0, 0, 0, -5) + leg(P, 0, P, -5) + `<rect x="-3" y="-25" width="16" height="20" rx="2" fill="#1f3c88"/><rect x="9" y="-25" width="3" height="20" fill="#9fb3e6"/><text x="10.5" y="-13" font-size="5" text-anchor="middle" fill="#123" font-family="sans-serif">−</text>`
      : leg(0, 0, 2, -5) + leg(P, 0, 8, -5) + `<ellipse cx="5" cy="-9" rx="7" ry="5.5" fill="#e0a040" stroke="#a0702a" stroke-width=".6"/>`;
    case 'button': return `<rect x="-4" y="-9" width="28" height="18" rx="2" fill="#2f2f2f"/><circle data-act="press" data-id="${id}" cx="10" cy="0" r="6.5" fill="#555" stroke="#111"/>`;
    case 'buzzer': return `<circle cx="10" cy="-10" r="13" fill="#1b1b1b"/><circle cx="10" cy="-10" r="2.5" fill="#444"/><text x="0" y="-16" font-size="7" fill="#eee" font-family="sans-serif">+</text><circle data-glow="${id}" cx="10" cy="-10" r="15" fill="none" stroke="#ffd60a" stroke-width="2" opacity="0"/>`;
    case 'motor': return leg(0, 0, 0, -6) + leg(3 * P, 0, 3 * P, -6) + `<circle cx="15" cy="-18" r="14" fill="#9aa0a6" stroke="#666"/><g data-rot="${id}" transform="translate(15 -18)"><rect x="-1.5" y="-12" width="3" height="12" fill="#333"/></g>`;
    case 'npn': case 'pnp':
      return leg(0, 0, 2, -6) + leg(P, 0, P, -6) + leg(2 * P, 0, 18, -6) + `<path d="M-2 -6 L22 -6 L22 -14 A12 9 0 0 0 -2 -14 Z" fill="#222"/>` +
        `<text x="10" y="-11" font-size="4.6" text-anchor="middle" fill="#ddd" font-family="sans-serif">${c.type === 'npn' ? 'BC107' : 'BC212'}</text><text x="10" y="-16.5" font-size="3.6" text-anchor="middle" fill="#aaa" font-family="sans-serif">E B C</text>`;
    case 'pot': return leg(0, 0, 0, -6) + leg(2 * P, 0, 2 * P, -6) + leg(4 * P, 0, 4 * P, -6) + `<rect x="-4" y="-30" width="48" height="24" rx="2" fill="#2a5db0"/>` +
      `<g data-act="pot" data-id="${id}"><circle cx="20" cy="-18" r="9" fill="#f0f0f0" stroke="#888"/><line data-rot="${id}" x1="20" y1="-18" x2="20" y2="-26" stroke="#333" stroke-width="2" transform="rotate(${(o.pos - 0.5) * 270} 20 -18)"/></g>`;
    case 'encoder': return `<rect x="-6" y="-52" width="52" height="48" rx="3" fill="#1a3f8f"/>${['CLK', 'DT', 'SW', '+', 'GND'].map((t, i) => `<text x="${i * P}" y="-7" font-size="3.6" text-anchor="middle" fill="#ddd" font-family="sans-serif">${t}</text>`).join('')}` +
      `<g data-act="enc" data-id="${id}"><circle cx="20" cy="-30" r="15" fill="#888" stroke="#444"/><circle cx="20" cy="-30" r="9" fill="#bbb"/><g data-rot="${id}" transform="rotate(${(B.encPos[id] || 0) * 18} 20 -30)"><rect x="18.5" y="-43" width="3" height="9" fill="#333"/></g></g>`;
    case 'servo': return leg(0, 0, 0, -6) + leg(P, 0, P, -6) + leg(2 * P, 0, 2 * P, -6) + `<path d="M0 -6 C0 -12 ${P} -12 ${P} -16" stroke="#6b3d1f" stroke-width="2" fill="none"/><path d="M${P} -6 L${P} -16" stroke="#d22" stroke-width="2"/><path d="M${2 * P} -6 C${2 * P} -12 ${P} -12 ${P} -16" stroke="#f80" stroke-width="2" fill="none"/>` +
      `<rect x="-12" y="-50" width="44" height="34" rx="3" fill="#2a64c4"/><text x="10" y="-20" font-size="5" text-anchor="middle" fill="#fff" font-family="sans-serif">SG90</text><g data-rot="${id}" transform="rotate(0 10 -36)"><rect x="7" y="-58" width="6" height="26" rx="3" fill="#f5f5f5" stroke="#999"/></g><circle cx="10" cy="-36" r="4" fill="#ddd"/>`;
    case 'seg7': return `<rect x="-6" y="-4" width="52" height="${6 * P + 8}" rx="2" fill="#151515"/>${cifraSVG(id, 0, 6, 4, 0.33)}`;
    case 'seg7x3': return `<rect x="-6" y="-5" width="62" height="${4 * P + 10}" rx="2" fill="#151515"/>${[0, 1, 2].map(d => cifraSVG(id, d, 0 + d * 19, 2, 0.21)).join('')}`;
  }
  return '';
}
function etichetta(c) {
  const pp = K.piediniXY(c), xs = pp.map(p => p.x), ys = pp.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2 * P, cy = (Math.min(...ys) + Math.max(...ys)) / 2 * P, y = Math.max(...ys) * P + 9;
  let t = c.label || '';
  if (c.type === 'res' || c.type === 'pot') t += ' ' + K.scriviValore(c.opt.r).replace(' ', '');
  if (c.type === 'cap') t += ' ' + K.scriviValore(c.opt.c, 'F').replace(' ', '');
  // componenti a due piedini in verticale: la scritta lungo il corpo (se no si sovrappongono)
  const vert = xs.length === 2 && xs[0] === xs[1];
  const pos = vert ? `x="${cx + 7}" y="${cy}" transform="rotate(-90 ${cx + 7} ${cy})"` : `x="${cx}" y="${y}"`;
  return `<text ${pos} font-size="6.5" text-anchor="middle" fill="#334" font-family="sans-serif" paint-order="stroke" stroke="#fff" stroke-width="2">${esc(t.trim())}</text>`;
}
function disegnaComponenti() {
  const g = $('#bb-comps');
  g.innerHTML = B.bb.comps.map(c => `<g class="bbc" data-comp="${c.id}" transform="translate(${c.x * P} ${c.y * P}) rotate(${(c.rot || 0) * 90})">${compSVG(c)}</g>`).join('') +
    B.bb.comps.map(etichetta).join('');
  $('#bb-wires').innerHTML = B.bb.wires.map(w => {
    const pts = w.p.map(q => q.map(v => v * P).join(',')).join(' ');
    const end = (q) => `<circle cx="${q[0] * P}" cy="${q[1] * P}" r="2.6" fill="${w.col}" stroke="#0006" stroke-width=".6"/>`;
    return `<g data-wire="${w.id}"><polyline points="${pts}" fill="none" stroke="#0005" stroke-width="4.2" stroke-linejoin="round" stroke-linecap="round"/><polyline points="${pts}" fill="none" stroke="${w.col}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>${end(w.p[0])}${end(w.p[w.p.length - 1])}</g>`;
  }).join('');
  disegnaSelezione();
}
function disegnaSelezione() {
  const g = $('#bb-sel');
  let s = '';
  for (const id of B.sel) {
    const c = B.bb.comps.find(c => c.id === id), w = B.bb.wires.find(w => w.id === id);
    if (c) {
      const el = document.querySelector(`[data-comp="${id}"]`);
      if (el) { const b = el.getBBox(), r = c.rot || 0; const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].map(([x, y]) => { const [rx, ry] = K.ruota(x, y, r); return [rx + c.x * P, ry + c.y * P]; });
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        s += `<rect x="${Math.min(...xs) - 3}" y="${Math.min(...ys) - 3}" width="${Math.max(...xs) - Math.min(...xs) + 6}" height="${Math.max(...ys) - Math.min(...ys) + 6}" fill="none" stroke="#0a66c2" stroke-dasharray="3 2" stroke-width="1.2"/>`; }
    }
    if (w) s += w.p.map((q, i) => `<circle cx="${q[0] * P}" cy="${q[1] * P}" r="${i === 0 || i === w.p.length - 1 ? 4 : 3}" fill="#fff" stroke="#0a66c2" stroke-width="1.4"/>`).join('');
  }
  g.innerHTML = s;
  pannelloProprieta();
}

// ------------------------------------------------------------------
// Modifiche, annulla/ripeti, salvataggio
function modifica(fn) {
  B.undo.push(JSON.stringify(B.bb)); if (B.undo.length > 100) B.undo.shift();
  B.redo = [];
  fn(B.bb);
  B.bb = K.pulisciBreadboard(B.bb);
  cambiato();
}
function cambiato(salva = true) {
  B.dirtyCirc = true;
  disegnaComponenti();
  if (salva) { clearTimeout(B.salvaT); B.salvaT = setTimeout(salvaOra, 500); }
  aggiornaBottoni();
}
function salvaOra() {
  clearTimeout(B.salvaT); B.salvaT = null;
  if (!B.proj || B.caricato !== B.proj) return;
  const p = B.proj;
  window.SV.saveFile(p, FILE, JSON.stringify(B.bb)).catch(e => addLog({ t: Date.now(), level: 'error', text: 'Breadboard non salvata: ' + (e.message || e) }));
}
function annulla() { if (!B.undo.length) return; B.redo.push(JSON.stringify(B.bb)); B.bb = K.pulisciBreadboard(JSON.parse(B.undo.pop())); B.sel.clear(); cambiato(); }
function ripeti() { if (!B.redo.length) return; B.undo.push(JSON.stringify(B.bb)); B.bb = K.pulisciBreadboard(JSON.parse(B.redo.pop())); B.sel.clear(); cambiato(); }
function nuovaEtichetta(tipo, bb = B.bb) {
  const pref = K.TIPI[tipo].pref;
  let n = 0;
  for (const c of bb.comps) { const m = new RegExp('^' + pref + '(\\d+)$').exec(c.label || ''); if (m && K.TIPI[c.type].pref === pref) n = Math.max(n, +m[1]); }
  return pref + (n + 1);
}
const nuovoId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function aggiungi(tipo, x, y) {
  const opt = Object.fromEntries(K.OPZIONI[tipo].map(([k, d]) => [k, d]));
  const c = { id: nuovoId('c'), type: tipo, x, y, rot: 0, opt, label: nuovaEtichetta(tipo) };
  modifica(bb => bb.comps.push(c));
  B.sel = new Set([c.id]);
  disegnaSelezione();
  return c;
}
function elimina() {
  if (!B.sel.size) return;
  const s = new Set(B.sel);
  modifica(bb => { bb.comps = bb.comps.filter(c => !s.has(c.id)); bb.wires = bb.wires.filter(w => !s.has(w.id)); });
  B.sel.clear(); disegnaSelezione();
}
function ruotaSel() {
  if (![...B.sel].some(id => B.bb.comps.some(c => c.id === id))) return;
  modifica(bb => { for (const c of bb.comps) if (B.sel.has(c.id)) c.rot = ((c.rot || 0) + 1) % 4; });
}
function copia() {
  const comps = B.bb.comps.filter(c => B.sel.has(c.id)), wires = B.bb.wires.filter(w => B.sel.has(w.id));
  if (comps.length || wires.length) B.clip = JSON.parse(JSON.stringify({ comps, wires }));
  aggiornaBottoni();
}
function incolla() {
  if (!B.clip) return;
  const nuovi = new Set();
  modifica(bb => {
    for (const c of B.clip.comps) { const n = { ...JSON.parse(JSON.stringify(c)), id: nuovoId('c'), x: c.x + 2, y: c.y + 2 }; n.label = nuovaEtichetta(c.type, bb); bb.comps.push(n); nuovi.add(n.id); }
    for (const w of B.clip.wires) { const n = { ...JSON.parse(JSON.stringify(w)), id: nuovoId('w') }; n.p = n.p.map(([x, y]) => [x + 2, y + 2]); bb.wires.push(n); nuovi.add(n.id); }
  });
  B.clip = { comps: B.clip.comps.map(c => ({ ...c, x: c.x + 2, y: c.y + 2 })), wires: B.clip.wires.map(w => ({ ...w, p: w.p.map(([x, y]) => [x + 2, y + 2]) })) };
  B.sel = nuovi; disegnaSelezione();
}

// ------------------------------------------------------------------
// Caricamento per progetto
async function caricaProgetto(id) {
  B.proj = id; B.caricato = null;
  let d = null;
  try { d = id ? await window.SV.breadboard(id) : null; } catch {}
  if (B.proj !== id) return;
  B.bb = K.pulisciBreadboard(d);
  B.caricato = id; B.undo = []; B.redo = []; B.sel.clear();
  B.premuti.clear(); B.enc = {}; B.capV.clear();
  rilascia();
  cambiato(false);
}
// gli ingressi che la breadboard pilotava tornano liberi
function rilascia() {
  for (const k of B.inviati.keys()) { const { p, pin } = parseKey(k); cmd(`I ${p} ${pin} -1`); }
  B.inviati.clear(); B.adcInviati.clear();
}

// ------------------------------------------------------------------
// Simulazione: stato esterno → soluzione (cache), media nel tempo, ingressi
function costruisci() {
  B.dirtyCirc = false;
  B.net = K.netlist(B.bb);
  B.corti = K.corti(B.net);
  const { el, usati, G } = K.elementi(B.net);
  B.circ = { el, usati, G, nodi: B.net.nodi };
  B.haCap = el.some(e => e.k === 'C');
  B.cache.clear(); B.chiaveStato = ''; B.ultimo = null;
  B.pinCirc = [...new Set(el.filter(e => e.k === 'P').map(e => e.pin))];
  // pin che non sono più nel circuito: liberi
  for (const k of [...B.inviati.keys()]) if (!B.pinCirc.includes(k)) { const { p, pin } = parseKey(k); cmd(`I ${p} ${pin} -1`); B.inviati.delete(k); }
  B.segnalati.clear(); B.problemi.clear();
  for (const p of B.corti) segnala(p);
}
const inCorsa = () => S.server.status === 'running' && S.server.project && S.server.project.id === B.proj;
function statoPin() {
  const pins = {}, pwm = [];
  if (!inCorsa()) return { pins, pwm };
  for (const k of B.pinCirc) {
    const { p, pin } = parseKey(k), i = pinInfo(p, pin);
    if (!i) continue;
    const af = i.mode === 2 && /^TIM|_TX$/.test(i.func);
    pins[k] = { mode: i.mode, pull: i.pull, od: i.od, level: i.level, af };
    if (i.mode === 2 && i.pwm && i.pwm.duty > 0 && i.pwm.duty < 1000) pwm.push([k, i.pwm.duty / 1000]);
  }
  return { pins, pwm: pwm.slice(0, 3) };
}
function statoEsterno() {
  const { pins, pwm } = statoPin();
  const b1 = !!(S.inputs.PC13 && (S.inputs.PC13.held || S.inputs.PC13.latched));
  return { pins, pwm, premuti: new Set(B.premuti), enc: { ...B.enc }, b1 };
}
const chiaveDi = st => JSON.stringify([st.pins, st.pwm, [...st.premuti].sort(), st.enc, st.b1]);
// una soluzione (cache se non ci sono condensatori)
function soluzione(st, capDt) {
  if (!B.haCap) {
    const k = chiaveDi(st);
    const hit = B.cache.get(k);
    if (hit) return hit;
    if (B.risolte >= MAX_RISOLUZIONI) { B.rallentato = true; return B.ultimo; }
  }
  B.risolte++;
  const res = K.risolvi(B.circ, st, B.ultimo && B.ultimo.res ? B.ultimo.res.reg : null, capDt);
  const r = { res, riass: riassunto(res), prob: [...K.controlli(B.circ, B.net, st, res), ...K.flottanti(B.circ, B.net, st, res)] };
  for (const p of r.prob) segnala(p);
  if (!B.haCap) { if (B.cache.size > CACHE_MAX) B.cache.clear(); B.cache.set(chiaveDi(st), r); }
  return r;
}
function riassunto(res) {
  const comp = {};
  for (const [id, m] of res.comp) comp[id] = { ...m };
  const pin = {};
  for (const [k, x] of Object.entries(res.pin)) pin[k] = { i: x.i, v: x.v };
  return { comp, pin, ld2: res.ld2 || 0 };
}
// valutazione con i pin PWM: media pesata delle combinazioni (alto/basso) dei canali in PWM
function valuta(st, capDt) {
  if (!st.pwm.length) return soluzione(st, capDt);
  const parti = [];
  const n = st.pwm.length;
  for (let m = 0; m < 1 << n; m++) {
    const s2 = { ...st, pins: { ...st.pins }, pwm: [] };
    let w = 1;
    st.pwm.forEach(([k, d], j) => { const on = m >> j & 1; s2.pins[k] = { ...s2.pins[k], level: on }; w *= on ? d : 1 - d; });
    if (w > 0) parti.push([soluzione(s2, capDt), w]);
  }
  const base = parti[0][0];
  const riass = { comp: {}, pin: {}, ld2: 0 };
  for (const [r, w] of parti) somma(riass, r.riass, w);
  return { res: base.res, riass, prob: parti.flatMap(([r]) => r.prob) };
}
function somma(dst, src, w) {
  for (const [id, m] of Object.entries(src.comp)) { const d = dst.comp[id] || (dst.comp[id] = {}); for (const [k, v] of Object.entries(m)) d[k] = (d[k] || 0) + v * w; }
  for (const [k, x] of Object.entries(src.pin)) { const d = dst.pin[k] || (dst.pin[k] = { i: 0, v: 0 }); d.i += x.i * w; d.v += x.v * w; }
  dst.ld2 = (dst.ld2 || 0) + (src.ld2 || 0) * w;
}
// stato attuale (cache per chiave)
function attuale() {
  if (B.dirtyCirc) costruisci();
  if (B.corti.length) return null;
  const st = statoEsterno(), k = chiaveDi(st);
  if (k !== B.chiaveStato || !B.ultimo || B.haCap) {
    if (B.haCap) {
      const cd = new Map();
      for (const e of B.circ.el) if (e.k === 'C') cd.set(e, [B.capV.get(e) || 0, B.passoCap || 1e-3]);
      B.ultimo = valuta(st, cd);
      for (const e of B.circ.el) if (e.k === 'C' && B.ultimo) B.capV.set(e, B.ultimo.res.cap.get(e) || 0);
    } else B.ultimo = valuta(st);
    B.chiaveStato = k; B.stato = st;
  }
  return B.ultimo;
}
// tempo simulato che passa: si somma lo stato tenuto fino a ms
function avanza(ms) {
  if (!B.acc) B.acc = { t: 0, comp: {}, pin: {}, ld2: 0 };
  const dt = ms - B.ultimoMs;
  if (dt <= 0) { if (dt < 0) B.ultimoMs = ms; return; }
  B.ultimoMs = ms;
  if (B.haCap) {
    // condensatori: passi da 1 ms (al massimo 50 per volta, poi un passo lungo)
    const n = Math.min(dt, 50);
    for (let i = 0; i < n; i++) { B.passoCap = (i === n - 1 ? dt - (n - 1) : 1) * 1e-3; B.chiaveStato = ''; const r = attuale(); if (!r) return; somma(B.acc, r.riass, B.passoCap * 1000); B.acc.t += B.passoCap * 1000; }
    return;
  }
  const r = attuale();
  if (!r) return;
  somma(B.acc, r.riass, dt);
  B.acc.t += dt;
  rinfresca(r);
}
// i problemi dello stato che è durato restano evidenziati (nel Registro vanno una volta sola)
function rinfresca(r) {
  const now = performance.now();
  for (const p of r.prob) { const x = B.problemi.get(p.cod + ':' + p.chiave); if (x) x.quando = now; else segnala(p); }
}
window.bbOnC = ms => { if (B.caricato && B.bb.comps.length) avanza(ms); };
window.bbOnM = () => { if (B.caricato && B.bb.comps.length) avanza(S.ms); };
window.bbReset = () => { B.acc = null; B.pub = null; B.ultimoMs = 0; B.segnalati.clear(); B.inviati.clear(); B.adcInviati.clear(); B.capV.clear(); B.chiaveStato = ''; ingressiIniziali(); };
// la scheda riparte: prima che il programma configuri i pin, gli ingressi hanno già il livello del
// circuito (es. CLK e DT dell'encoder a 1 per i pull-up), come sulla breadboard vera
function ingressiIniziali() {
  if (!B.caricato || !B.bb.comps.length || B.proj !== (S.server.project && S.server.project.id)) return;
  if (B.dirtyCirc) costruisci();
  if (B.corti.length) return;
  const res = K.risolvi(B.circ, { pins: {}, pwm: [], premuti: new Set(B.premuti), enc: { ...B.enc }, b1: false }, null, null);
  for (const k of B.pinCirc) {
    const lv = K.livello(res.pin[k].v);
    if (lv === null) continue;
    const { p, pin } = parseKey(k);
    B.inviati.set(k, lv); cmd(`I ${p} ${pin} ${lv}`);
  }
}

// livelli letti dagli ingressi e tensioni per l'ADC
function aggiornaIngressi() {
  if (!inCorsa() || !B.caricato) return;
  const r = attuale();
  if (!r) return;
  for (const k of B.pinCirc) {
    const ps = B.stato.pins[k], x = r.res.pin[k];
    if (!ps || !x) continue;
    const { p, pin } = parseKey(k);
    // il nodo deve avere qualcosa oltre al pin (se no non lo pilota la breadboard)
    if (ps.mode === 0 || (ps.mode === 3 && !Object.values(S.adc).includes(k))) {
      const lv = K.livello(x.v);
      const v = lv === null ? (B.inviati.has(k) ? B.inviati.get(k) : -1) : lv;
      if (B.inviati.get(k) !== v) { B.inviati.set(k, v); cmd(`I ${p} ${pin} ${v}`); }
    }
    if (ps.mode === 3) {
      const ch = Object.keys(S.adc).find(c => S.adc[c] === k);
      if (ch === undefined) continue;
      const val = Math.max(0, Math.min(4095, Math.round(x.v / K.VDD * 4095)));
      if (Math.abs((B.adcInviati.get(ch) ?? -99) - val) > 2) { B.adcInviati.set(ch, val); S.adcVal[ch] = val; cmd(`V ${ch} ${val}`); }
    }
  }
}

// ------------------------------------------------------------------
// Controlli: nel Registro una volta per problema (per avvio), evidenziati finché durano
function segnala(p) {
  B.problemi.set(p.cod + ':' + p.chiave, { ...p, quando: performance.now() });
  if (B.segnalati.has(p.cod + ':' + p.chiave)) return;
  B.segnalati.add(p.cod + ':' + p.chiave);
  addLog({ t: Date.now(), level: p.cod === 'corto' || p.cod === 'conflitto' ? 'error' : 'warn', text: 'Breadboard — ' + p.testo });
}

// ------------------------------------------------------------------
// Aggiornamento a ogni fotogramma
let ultimoFrame = 0;
window.bbFrame = () => {
  if (!$('#bb-svg')) return;
  if (S.selId !== B.proj) { if (B.salvaT) salvaOra(); caricaProgetto(S.selId); return; }
  if (!B.caricato) return;
  B.risolte = 0;
  const now = performance.now();
  if (!B.bb.comps.length) { mostraProblemi(now); return; }
  if (inCorsa()) {
    avanza(S.ms);
    aggiornaIngressi();
    // media pubblicata ogni ≥ 30 ms simulati (o 300 ms veri, se la scheda è lenta)
    if (B.acc && (B.acc.t >= 30 || (B.acc.t > 0 && now - (B.pubT || 0) > 300))) { B.pub = media(B.acc); B.acc = null; B.pubT = now; }
  } else {
    // scheda ferma: i pin sono tutti liberi, le alimentazioni ci sono (USB collegato)
    if (B.haCap) { B.passoCap = Math.min(0.05, (now - ultimoFrame) / 1000 || 0.016); B.chiaveStato = ''; }
    const r = attuale();
    B.pub = r ? media({ t: 1, ...JSON.parse(JSON.stringify(r.riass)) }) : null;
    if (r) rinfresca(r);
  }
  ultimoFrame = now;
  aggiornaVista(now);
};
function media(acc) {
  const t = acc.t || 1, out = { comp: {}, pin: {}, ld2: acc.ld2 / t };
  for (const [id, m] of Object.entries(acc.comp)) { out.comp[id] = {}; for (const [k, v] of Object.entries(m)) out.comp[id][k] = v / t; }
  for (const [k, x] of Object.entries(acc.pin)) out.pin[k] = { i: x.i / t, v: x.v / t };
  return out;
}
const lum = i => i > 5e-5 ? Math.min(1, Math.pow(i / 0.004, 0.7)) : 0;
function aggiornaVista(now) {
  const pub = B.pub;
  for (const c of B.bb.comps) {
    const m = pub && pub.comp[c.id] || {};
    if (c.type === 'led') {
      const b = lum(m.i || 0), g = document.querySelector(`[data-glow="${c.id}"]`), l = document.querySelector(`[data-lens="${c.id}"]`);
      if (g) g.setAttribute('opacity', (b * 0.9).toFixed(2));
      if (l) l.setAttribute('fill-opacity', (0.55 + 0.45 * b).toFixed(2));
    } else if (c.type === 'seg7' || c.type === 'seg7x3') {
      const nd = c.type === 'seg7' ? 1 : 3;
      for (let j = 0; j < nd * 8; j++) {
        const x = document.querySelector(`[data-seg="${c.id}:${j}"]`);
        if (!x) continue;
        const b = lum(m['s' + j] || 0);
        x.setAttribute('fill', b ? `rgb(${Math.round(70 + 185 * b)},${Math.round(20 + 40 * b)},${Math.round(20 + 30 * b)})` : '#3a1414');
      }
    } else if (c.type === 'buzzer') {
      const on = Math.abs(m.v || 0) > 1.5, g = document.querySelector(`[data-glow="${c.id}"]`);
      if (g) g.setAttribute('opacity', on ? '0.9' : '0');
      if (typeof buzzSet === 'function') buzzSet('bb' + c.id, 2300, on && inCorsa() && B.suono && B.suono.has(c.id));
    } else if (c.type === 'motor') {
      const a = B.motAng = B.motAng || {}, v = m.v || 0;
      a[c.id] = ((a[c.id] || 0) + v * 200 * ((now - (B.motT || now)) / 1000)) % 360;
      const r = document.querySelector(`[data-rot="${c.id}"]`);
      if (r) r.setAttribute('transform', `translate(15 -18) rotate(${a[c.id].toFixed(1)})`);
    } else if (c.type === 'servo') {
      const r = document.querySelector(`[data-rot="${c.id}"]`), ang = angoloServo(c);
      if (r && ang !== null) r.setAttribute('transform', `rotate(${ang - 90} 10 -36)`);
    } else if (c.type === 'button') {
      const x = document.querySelector(`[data-act="press"][data-id="${c.id}"]`);
      if (x) x.setAttribute('fill', B.premuti.has(c.id) ? '#9a9a9a' : '#555');
    }
  }
  B.motT = now;
  const ld2 = document.getElementById('bb-ld2');
  if (ld2) ld2.setAttribute('fill', pub && pub.ld2 > 5e-5 ? '#7dffad' : '#2d4a33');
  mostraProblemi(now);
  aggiornaStato();
}
// servo: impulso del PWM sul pin collegato al filo del segnale
function angoloServo(c) {
  if (!B.net || !inCorsa()) return null;
  const cc = B.net.comps.find(x => x.c.id === c.id);
  if (!cc) return null;
  const s = cc.pins.find(p => p.n === 'S'), n = B.net.nodi[s.nodo];
  for (const k of n.pins) { const { p, pin } = parseKey(k); const i = pinInfo(p, pin); if (i && i.pwm && i.pwm.duty >= 0 && i.pwm.freq) { const ms = i.pwm.duty / 1000 / i.pwm.freq * 1000; return Math.max(0, Math.min(180, (ms - 1) * 180)); } }
  return null;
}
// cosa si legge sul display (come nei Dispositivi)
export function letturaDisplay(c, pub = B.pub) {
  const m = pub && pub.comp[c.id] || {}, nd = c.type === 'seg7' ? 1 : 3;
  const vals = Array.from({ length: nd * 8 }, (_, j) => m['s' + j] || 0), max = Math.max(...vals);
  let txt = '';
  for (let d = 0; d < nd; d++) {
    let bits = 0, dp = false;
    for (let j = 0; j < 8; j++) if (vals[d * 8 + j] > Math.max(1e-4, 0.3 * max)) { if (j < 7) bits |= 1 << j; else dp = true; }
    txt += (SEG_DIGIT[bits] ?? '?') + (dp ? '.' : '');
  }
  return txt;
}
function mostraProblemi(now) {
  let s = '';
  const attivi = [...B.problemi.values()].filter(p => now - p.quando < 600 || p.cod === 'corto');
  for (const [k, p] of B.problemi) if (now - p.quando > 600 && p.cod !== 'corto') B.problemi.delete(k);
  const pins = new Set(attivi.flatMap(p => p.pins || [])), comps = new Set(attivi.map(p => p.comp).filter(Boolean));
  for (const f of K.FORI.values()) {
    const sig = f.net;
    if (pins.has(sig) || attivi.some(p => p.alim && p.alim.includes(sig))) s += `<circle cx="${f.x * P}" cy="${f.y * P}" r="5" fill="none" stroke="#e53935" stroke-width="2"/>`;
  }
  for (const id of comps) { const c = B.bb.comps.find(c => c.id === id); if (c) { const pp = K.piediniXY(c); s += pp.map(p => `<circle cx="${p.x * P}" cy="${p.y * P}" r="5" fill="none" stroke="#e53935" stroke-width="2"/>`).join(''); } }
  const g = $('#bb-prob');
  if (g.dataset.k !== s) { g.innerHTML = s; g.dataset.k = s; }
  // pin evidenziati anche sulla scheda disegnata in alto
  document.querySelectorAll('#board .hp').forEach(c => c.classList.toggle('bb-err', pins.has(c.dataset.pin)));
  const box = $('#bb-problemi');
  const t = attivi.map(p => p.testo).join('\n');
  if (box.dataset.t !== t) { box.dataset.t = t; box.replaceChildren(...attivi.map(p => { const d = document.createElement('div'); d.textContent = p.testo; return d; })); box.hidden = !attivi.length; }
}

// ------------------------------------------------------------------
// Riga di stato: nodo sotto il mouse
function aggiornaStato() {
  const el = $('#bb-stato');
  let t = '';
  const h = B.hover;
  if (h && B.net) {
    const f = K.FORI.get(K.chiave(h[0], h[1]));
    const n = B.net.nodoDi(h[0], h[1]);
    const nodo = n >= 0 ? B.net.nodi[n] : null;
    t = f ? f.nome : `(${h[0]}, ${h[1]})`;
    if (nodo) {
      const pin = nodo.pins[0];
      t += ` · nodo ${nodo.nome || '—'}`;
      if (pin && K.ARDUINO[pin]) t += ` (${K.ARDUINO[pin]})`;
      if (B.ultimo && B.ultimo.res && !B.corti.length) { const v = B.ultimo.res.V[n] ?? 0; if (B.circ.usati.has(n) || n === B.circ.G) t += ` · ${(n === B.circ.G ? 0 : v).toFixed(2).replace('.', ',')} V`; }
      if (pin && B.pub && B.pub.pin[pin] && Math.abs(B.pub.pin[pin].i) > 1e-5) t += ` · corrente del pin ${(B.pub.pin[pin].i * 1000).toFixed(1).replace('.', ',')} mA (media)`;
    }
  }
  const disp = B.bb.comps.filter(c => c.type === 'seg7' || c.type === 'seg7x3');
  if (!t && disp.length && B.pub) t = disp.map(c => `${c.label}: si legge «${letturaDisplay(c)}»`).join(' · ');
  if (B.rallentato) { t += (t ? ' · ' : '') + 'circuito lento: alcune soluzioni rimandate'; B.rallentato = false; }
  if (el.textContent !== t) el.textContent = t;
  // evidenzia il nodo
  const g = $('#bb-nodo');
  const k = h ? h.join(',') + ':' + B.bb.wires.length + B.bb.comps.length : '';
  if (g.dataset.k === k) return;
  g.dataset.k = k;
  if (!h || !B.net) { g.innerHTML = ''; return; }
  const n = B.net.nodoDi(h[0], h[1]);
  if (n < 0) { g.innerHTML = ''; return; }
  let s = '';
  for (const f of K.FORI.values()) if (B.net.nodoDi(f.x, f.y) === n) s += `<circle cx="${f.x * P}" cy="${f.y * P}" r="4" fill="#0a66c2" fill-opacity=".35" stroke="#0a66c2" stroke-width="1"/>`;
  for (const w of B.bb.wires) for (const q of [w.p[0], w.p[w.p.length - 1]]) if (B.net.nodoDi(q[0], q[1]) === n) s += `<circle cx="${q[0] * P}" cy="${q[1] * P}" r="4.5" fill="none" stroke="#0a66c2" stroke-width="1.4"/>`;
  g.innerHTML = s;
}

// ------------------------------------------------------------------
// Interazione
function mondo(ev) {
  const svg = $('#bb-svg'), pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const q = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [q.x / P, q.y / P];
}
const griglia = ([x, y]) => [Math.round(x), Math.round(y)];
function applicaVista() {
  const v = B.vista;
  $('#bb-svg').setAttribute('viewBox', `${v.x * P} ${v.y * P} ${v.w * P} ${v.h * P}`);
}
function zoom(f, cx, cy) {
  const v = B.vista, w = Math.min(MONDO.w * 2, Math.max(12, v.w * f)), h = w * v.h / v.w;
  if (cx === undefined) { cx = v.x + v.w / 2; cy = v.y + v.h / 2; }
  v.x = cx - (cx - v.x) * w / v.w; v.y = cy - (cy - v.y) * h / v.h; v.w = w; v.h = h;
  applicaVista();
}
function adatta() {
  const svg = $('#bb-svg'), r = svg.getBoundingClientRect(), ar = r.height / Math.max(1, r.width) || 0.5;
  const v = B.vista;
  v.w = MONDO.w; v.h = MONDO.w * ar;
  if (v.h < MONDO.h) { v.h = MONDO.h; v.w = MONDO.h / ar; }
  v.x = MONDO.x - (v.w - MONDO.w) / 2; v.y = MONDO.y - (v.h - MONDO.h) / 2;
  applicaVista();
}
// cosa c'è sotto il puntatore
function colpito(ev) {
  const t = ev.target;
  const act = t.closest && t.closest('[data-act]');
  if (act && act.dataset.id) return { act: act.dataset.act, id: act.dataset.id };
  const wg = t.closest && t.closest('[data-wire]');
  if (wg) return { wire: wg.dataset.wire };
  const cg = t.closest && t.closest('[data-comp]');
  if (cg) return { comp: cg.dataset.comp };
  return {};
}
function puntoFilo(w, m) {
  // estremo o piega vicina (entro 0,6 passi), se no il segmento più vicino
  let best = null;
  w.p.forEach((q, i) => { const d = Math.hypot(q[0] - m[0], q[1] - m[1]); if (d < 0.6 && (!best || d < best.d)) best = { i, d }; });
  if (best) return { punto: best.i };
  let seg = 0, dm = Infinity;
  for (let i = 0; i < w.p.length - 1; i++) {
    const [a, b] = [w.p[i], w.p[i + 1]], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / L));
    const d = Math.hypot(a[0] + t * dx - m[0], a[1] + t * dy - m[1]);
    if (d < dm) { dm = d; seg = i; }
  }
  return { segmento: seg };
}
function premi(id, on) {
  const st = B.pressT = B.pressT || {};
  clearTimeout(st[id]);
  if (on) { st[id + 't'] = performance.now(); B.premuti.add(id); aggiornaIngressi(); return; }
  const wait = 120 - (performance.now() - (st[id + 't'] || 0));
  const via = () => { B.premuti.delete(id); aggiornaIngressi(); };
  if (wait > 0) st[id] = setTimeout(via, wait); else via();
}
// encoder KY-040: uno scatto = 4 fronti in quadratura (orario: prima CLK, poi DT)
function scatto(id, dir) {
  const seq = dir > 0 ? [[1, 0], [1, 1], [0, 1], [0, 0]] : [[0, 1], [1, 1], [1, 0], [0, 0]];
  const sw = (B.enc[id] || [0, 0, 0])[2];
  B.encCoda = (B.encCoda || Promise.resolve()).then(() => new Promise(res => {
    let i = 0;
    const passo = () => { const [a, b] = seq[i]; B.enc[id] = [a, b, sw]; aggiornaIngressi(); if (++i < seq.length) setTimeout(passo, 12); else res(); };
    passo();
  }));
  B.encPos[id] = (B.encPos[id] || 0) + dir;
  const r = document.querySelector(`[data-rot="${id}"]`);
  if (r) r.setAttribute('transform', `rotate(${B.encPos[id] * 18} 20 -30)`);
}

function wire() {
  const svg = $('#bb-svg');
  svg.addEventListener('pointerdown', ev => {
    if (ev.button === 1 || ev.button === 2) return;
    svg.focus();
    const m = mondo(ev), g = griglia(m), hit = colpito(ev);
    svg.setPointerCapture(ev.pointerId);
    if (B.posa) {   // componente nuovo dalla tavolozza: si posa qui
      const tipo = B.posa; B.posa = null; $('#bb-svg').classList.remove('posa');
      aggiungi(tipo, g[0], g[1]);
      return;
    }
    if (hit.act === 'press') { premi(hit.id, true); B.drag = { kind: 'press', id: hit.id }; return; }
    if (hit.act === 'enc') { const e = B.enc[hit.id] || [0, 0, 0]; B.enc[hit.id] = [e[0], e[1], 1]; aggiornaIngressi(); B.drag = { kind: 'encsw', id: hit.id }; return; }
    if (hit.comp) {
      if (!ev.shiftKey && !B.sel.has(hit.comp)) B.sel = new Set();
      B.sel.add(hit.comp);
      disegnaSelezione();
      B.drag = { kind: 'comp', start: g, prima: JSON.stringify(B.bb), mosso: false };
      return;
    }
    if (hit.wire) {
      const w = B.bb.wires.find(w => w.id === hit.wire);
      if (!ev.shiftKey) B.sel = new Set();
      B.sel.add(w.id); disegnaSelezione();
      const pf = puntoFilo(w, m);
      B.drag = { kind: 'wire', id: w.id, prima: JSON.stringify(B.bb), mosso: false, ...pf, start: g };
      return;
    }
    // su un foro o un piedino: nuovo filo; altrimenti si sposta la vista
    const suForo = K.FORI.has(K.chiave(g[0], g[1])) && Math.hypot(m[0] - g[0], m[1] - g[1]) < 0.45;
    const suPiedino = B.bb.comps.some(c => K.piediniXY(c).some(p => p.x === g[0] && p.y === g[1]));
    if (suForo || suPiedino) {
      B.sel.clear(); disegnaSelezione();
      B.drag = { kind: 'nuovo', from: g, to: g };
      return;
    }
    if (B.sel.size) { B.sel.clear(); disegnaSelezione(); }
    B.drag = { kind: 'pan', start: [ev.clientX, ev.clientY], v: { ...B.vista } };
  });
  svg.addEventListener('pointermove', ev => {
    const m = mondo(ev), g = griglia(m);
    if (!B.hover || B.hover[0] !== g[0] || B.hover[1] !== g[1]) { B.hover = g; aggiornaStato(); }
    const d = B.drag;
    if (B.posa) { const gh = $('#bb-ghost'); gh.setAttribute('transform', `translate(${g[0] * P} ${g[1] * P})`); return; }
    if (!d) return;
    if (d.kind === 'pan') {
      const r = svg.getBoundingClientRect(), k = B.vista.w / r.width;
      B.vista.x = d.v.x - (ev.clientX - d.start[0]) * k; B.vista.y = d.v.y - (ev.clientY - d.start[1]) * k;
      applicaVista();
    } else if (d.kind === 'comp') {
      const dx = g[0] - d.start[0], dy = g[1] - d.start[1];
      if (!dx && !dy) return;
      d.start = g; d.mosso = true;
      for (const c of B.bb.comps) if (B.sel.has(c.id)) { c.x += dx; c.y += dy; }
      for (const w of B.bb.wires) if (B.sel.has(w.id)) w.p = w.p.map(([x, y]) => [x + dx, y + dy]);
      disegnaComponenti();
    } else if (d.kind === 'wire') {
      const w = B.bb.wires.find(w => w.id === d.id);
      if (!w || (g[0] === d.start[0] && g[1] === d.start[1] && !d.mosso)) return;
      if (d.segmento !== undefined && d.punto === undefined) { w.p.splice(d.segmento + 1, 0, g); d.punto = d.segmento + 1; }
      if (d.punto !== undefined) w.p[d.punto] = g;
      d.mosso = true;
      disegnaComponenti();
    } else if (d.kind === 'nuovo') {
      d.to = g;
      const col = coloreFilo(d.from);
      $('#bb-ghost').setAttribute('transform', '');
      $('#bb-ghost').innerHTML = `<line x1="${d.from[0] * P}" y1="${d.from[1] * P}" x2="${g[0] * P}" y2="${g[1] * P}" stroke="${col}" stroke-width="3" stroke-linecap="round" opacity=".8"/>`;
    }
  });
  const fine = ev => {
    const d = B.drag; B.drag = null;
    if (!d) return;
    if (d.kind === 'press') premi(d.id, false);
    else if (d.kind === 'encsw') setTimeout(() => { const e = B.enc[d.id] || [0, 0, 0]; B.enc[d.id] = [e[0], e[1], 0]; aggiornaIngressi(); }, 120);
    else if ((d.kind === 'comp' || d.kind === 'wire') && d.mosso) {
      B.undo.push(d.prima); B.redo = [];
      B.bb = K.pulisciBreadboard(B.bb); cambiato();
    } else if (d.kind === 'nuovo') {
      $('#bb-ghost').innerHTML = '';
      if (d.to[0] !== d.from[0] || d.to[1] !== d.from[1]) {
        const w = { id: nuovoId('w'), p: [d.from, d.to], col: coloreFilo(d.from) };
        modifica(bb => bb.wires.push(w));
        B.sel = new Set([w.id]); disegnaSelezione();
      }
    }
  };
  svg.addEventListener('pointerup', fine);
  svg.addEventListener('pointercancel', fine);
  svg.addEventListener('pointerleave', () => { B.hover = null; aggiornaStato(); });
  svg.addEventListener('dblclick', ev => {
    const hit = colpito(ev);
    if (!hit.wire) return;
    const w = B.bb.wires.find(w => w.id === hit.wire), pf = puntoFilo(w, mondo(ev));
    if (pf.punto > 0 && pf.punto < w.p.length - 1) modifica(() => { const x = B.bb.wires.find(x => x.id === w.id); x.p.splice(pf.punto, 1); });
  });
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const hit = colpito(ev);
    if (hit.act === 'enc') { scatto(hit.id, ev.deltaY > 0 ? 1 : -1); return; }
    if (hit.act === 'pot') { const c = B.bb.comps.find(c => c.id === hit.id); impostaPot(c, c.opt.pos + (ev.deltaY > 0 ? -0.02 : 0.02)); return; }
    const m = mondo(ev);
    zoom(ev.deltaY > 0 ? 1.12 : 1 / 1.12, m[0], m[1]);
  }, { passive: false });
  svg.addEventListener('keydown', ev => {
    const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
    if (mod && k === 'z') { ev.preventDefault(); ev.shiftKey ? ripeti() : annulla(); }
    else if (mod && k === 'y') { ev.preventDefault(); ripeti(); }
    else if (mod && k === 'c') { ev.preventDefault(); copia(); }
    else if (mod && k === 'v') { ev.preventDefault(); incolla(); }
    else if (mod && k === 'd') { ev.preventDefault(); copia(); incolla(); }
    else if (!mod && k === 'r') ruotaSel();
    else if (k === 'delete' || k === 'backspace') { ev.preventDefault(); elimina(); }
    else if (k === 'escape' && $('#pane-breadboard').classList.contains('bb-grande') && !B.posa && !B.sel.size) { $('#pane-breadboard').classList.remove('bb-grande'); setTimeout(adatta, 30); }
    else if (k === 'escape') { B.posa = null; $('#bb-svg').classList.remove('posa'); $('#bb-ghost').innerHTML = ''; B.sel.clear(); disegnaSelezione(); }
  });
  // barra
  $('#bb-add').addEventListener('change', e => {
    const t = e.target.value; e.target.value = '';
    if (!K.TIPI[t]) return;
    B.posa = t; svg.classList.add('posa'); svg.focus();
    $('#bb-ghost').innerHTML = `<g opacity=".6">${compSVG({ id: 'ghost', type: t, opt: Object.fromEntries(K.OPZIONI[t].map(([k, d]) => [k, d])) })}</g>`;
  });
  const btn = (id, fn) => $(id).addEventListener('click', () => { fn(); svg.focus(); });
  btn('#bb-ruota', ruotaSel); btn('#bb-elimina', elimina); btn('#bb-copia', copia); btn('#bb-incolla', incolla);
  btn('#bb-annulla', annulla); btn('#bb-ripeti', ripeti);
  btn('#bb-zin', () => zoom(1 / 1.25)); btn('#bb-zout', () => zoom(1.25)); btn('#bb-adatta', adatta);
  btn('#bb-png', esportaPNG);
  btn('#bb-grande', () => { $('#pane-breadboard').classList.toggle('bb-grande'); setTimeout(adatta, 30); });
  $('#bb-esempio').addEventListener('change', e => {
    const v = e.target.value; e.target.value = '';
    if (!v) return;
    if (B.bb.comps.length && !confirm('Sostituisco il circuito della breadboard con l\'esempio? (Puoi tornare indietro con Annulla.)')) return;
    modifica(bb => { const x = K.esempioCronometro(v === '1k5' ? 1500 : 15000); bb.comps = x.comps; bb.wires = x.wires; });
    B.sel.clear(); disegnaSelezione();
  });
  btn('#bb-svuota', () => { if (B.bb.comps.length + B.bb.wires.length && confirm('Tolgo tutti i componenti e i fili? (Puoi tornare indietro con Annulla.)')) { modifica(bb => { bb.comps = []; bb.wires = []; }); B.sel.clear(); disegnaSelezione(); } });
  $('#bb-colori').innerHTML = K.COLORI_FILO.map(c => `<button class="bbcol" data-col="${c}" style="background:${c}" title="Colore del filo"></button>`).join('');
  $('#bb-colori').addEventListener('click', e => {
    const c = e.target.dataset && e.target.dataset.col;
    if (!c) return;
    B.colore = c;
    const ws = [...B.sel].filter(id => B.bb.wires.some(w => w.id === id));
    if (ws.length) modifica(bb => { for (const w of bb.wires) if (B.sel.has(w.id)) w.col = c; });
    aggiornaBottoni();
  });
  new ResizeObserver(() => { if (!B.vistaFatta && $('#bb-svg').getBoundingClientRect().width > 50) { B.vistaFatta = true; adatta(); } }).observe(svg);
}
// colore iniziale: rosso dalle alimentazioni, nero da GND, se no quello scelto
function coloreFilo(g) {
  const f = K.FORI.get(K.chiave(g[0], g[1]));
  const n = f && f.net;
  if (n === '5V' || n === '3V3' || n === 'bb:T+' || n === 'bb:B+') return K.COLORI_FILO[0];
  if (n === 'GND' || n === 'bb:T-' || n === 'bb:B-') return K.COLORI_FILO[1];
  return B.colore;
}
function aggiornaBottoni() {
  const sel = B.sel.size > 0;
  $('#bb-elimina').disabled = !sel; $('#bb-copia').disabled = !sel; $('#bb-ruota').disabled = ![...B.sel].some(id => B.bb.comps.some(c => c.id === id));
  $('#bb-incolla').disabled = !B.clip; $('#bb-annulla').disabled = !B.undo.length; $('#bb-ripeti').disabled = !B.redo.length;
  document.querySelectorAll('.bbcol').forEach(b => b.classList.toggle('on', b.dataset.col === B.colore));
}
function impostaPot(c, pos) {
  pos = Math.max(0, Math.min(1, Math.round(pos * 100) / 100));
  // il cursore non va nell'annulla (cambia di continuo): si salva e basta
  c.opt.pos = pos;
  B.dirtyCirc = true;
  const r = document.querySelector(`[data-rot="${c.id}"]`);
  if (r) r.setAttribute('transform', `rotate(${(pos - 0.5) * 270} 20 -18)`);
  const sl = $('#bb-prop [data-pos]');
  if (sl && sl.value != pos * 100) sl.value = pos * 100;
  clearTimeout(B.salvaT); B.salvaT = setTimeout(salvaOra, 800);
  aggiornaIngressi();
}

// pannello delle proprietà del componente scelto
function pannelloProprieta() {
  const box = $('#bb-prop');
  const ids = [...B.sel], c = ids.length === 1 && B.bb.comps.find(c => c.id === ids[0]);
  aggiornaBottoni();
  if (!c) {
    const w = ids.length === 1 && B.bb.wires.find(w => w.id === ids[0]);
    box.innerHTML = w ? `<span class="muted small">Filo: trascina un estremo per spostarlo, trascina il filo per piegarlo, doppio clic su una piega per toglierla; colore dalla tavolozza.</span>`
      : `<span class="muted small">${B.bb.comps.length ? 'Clic su un componente per le sue proprietà · trascina da un foro per tirare un filo · rotella = zoom, trascina il fondo per spostarti · R ruota, Canc elimina, ⌘/Ctrl+Z annulla.' : 'Aggiungi un componente dal menu, o carica l\'esempio del cronometro. Trascina da un foro all\'altro per tirare un filo.'}</span>`;
    return;
  }
  const info = K.TIPI[c.type].nome, o = c.opt;
  let h = `<b>${esc(info)}</b> <label>nome <input data-k="label" value="${esc(c.label)}" maxlength="12" size="5"></label>`;
  if (c.type === 'res' || c.type === 'pot') h += ` <label>valore <input data-k="r" value="${esc(K.scriviValore(o.r).replace(' Ω', '').replace(' ', ''))}" size="6" title="Es. 330, 4k7, 15k, 1,5k, 1M"> Ω</label>`;
  if (c.type === 'cap') h += ` <label>capacità <input data-k="c" value="${esc(K.scriviValore(o.c, 'F').replace(' ', '').replace('F', ''))}" size="6" title="Es. 100n, 10u, 100u"> F</label>`;
  if (c.type === 'res' || c.type === 'jumper') h += ` <label>passo <select data-k="span">${Array.from({ length: c.type === 'res' ? 9 : 20 }, (_, i) => i + (c.type === 'res' ? 2 : 1)).map(n => `<option ${n === o.span ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  if (c.type === 'led') h += ` <label>colore <select data-k="color">${Object.entries(K.LED_COL).map(([k, v]) => `<option value="${k}" ${k === o.color ? 'selected' : ''}>${v[2]}</option>`).join('')}</select></label>`;
  if (c.type === 'seg7' || c.type === 'seg7x3') h += ` <label>tipo <select data-k="anode"><option value="0" ${o.anode ? '' : 'selected'}>catodo comune (${c.type === 'seg7' ? '5161AS' : '5361AS'})</option><option value="1" ${o.anode ? 'selected' : ''}>anodo comune (${c.type === 'seg7' ? '5161BS' : '5361BS'})</option></select></label>`;
  if (c.type === 'npn' || c.type === 'pnp') h += ` <label>β (hFE) <input data-k="beta" type="number" min="10" max="1000" value="${o.beta}" style="width:5em"></label>`;
  if (c.type === 'pot') h += ` <label>cursore <input data-pos type="range" min="0" max="100" value="${Math.round(o.pos * 100)}"></label>`;
  if (c.type === 'encoder') h += ` <button class="small" data-enc="-1">↺</button><button class="small" data-enc="1">↻</button> <span class="muted small">rotella sulla manopola, clic = SW</span>`;
  if (c.type === 'buzzer') h += ` <label class="small"><input type="checkbox" data-suono ${B.suono && B.suono.has(c.id) ? 'checked' : ''}> suono</label>`;
  if (c.type === 'button') h += ' <span class="muted small">tieni premuto il tasto nero</span>';
  const q = B.ultimo && B.ultimo.res && B.ultimo.res.q.get(c.id);
  if (q && inCorsa()) h += ` <span class="small mono">${['interdizione', 'zona attiva', 'saturazione'][q.r]} · Ic ${(q.ic * 1000).toFixed(1).replace('.', ',')} mA · Ib ${(q.ib * 1000).toFixed(2).replace('.', ',')} mA · Vce ${q.vce.toFixed(2).replace('.', ',')} V</span>`;
  box.innerHTML = h;
  box.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('change', () => {
    const k = inp.dataset.k;
    let v = inp.value;
    if (k === 'r' || k === 'c') { v = K.leggiValore(v); if (!(v > 0)) { inp.setCustomValidity('valore non valido'); inp.reportValidity(); return; } }
    else if (k === 'span' || k === 'beta' || k === 'anode') v = +v;
    modifica(bb => { const x = bb.comps.find(x => x.id === c.id); if (k === 'label') x.label = v; else x.opt[k] = v; });
  }));
  const sl = box.querySelector('[data-pos]');
  if (sl) sl.addEventListener('input', () => impostaPot(c, sl.value / 100));
  box.querySelectorAll('[data-enc]').forEach(b => b.addEventListener('click', () => scatto(c.id, +b.dataset.enc)));
  const su = box.querySelector('[data-suono]');
  if (su) su.addEventListener('change', () => { B.suono = B.suono || new Set(); if (su.checked) B.suono.add(c.id); else { B.suono.delete(c.id); if (typeof buzzStop === 'function') buzzStop('bb' + c.id); } });
}

// ------------------------------------------------------------------
// Immagine PNG del montaggio (per le relazioni)
async function esportaPNG() {
  const svg = $('#bb-svg').cloneNode(true);
  for (const id of ['bb-sel', 'bb-nodo', 'bb-ghost', 'bb-prob']) { const g = svg.querySelector('#' + id); if (g) g.remove(); }
  const xs = [], ys = [];
  for (const c of B.bb.comps) for (const p of K.piediniXY(c)) { xs.push(p.x); ys.push(p.y); }
  for (const w of B.bb.wires) for (const q of w.p) { xs.push(q[0]); ys.push(q[1]); }
  let x0 = Math.min(MONDO.x, ...xs) - 1, y0 = Math.min(MONDO.y, ...ys) - 7, x1 = Math.max(MONDO.x + MONDO.w, ...xs) + 1, y1 = Math.max(MONDO.y + MONDO.h, ...ys) + 2;
  const W = 2400, H = Math.round(W * (y1 - y0) / (x1 - x0));
  svg.setAttribute('viewBox', `${x0 * P} ${y0 * P} ${(x1 - x0) * P} ${(y1 - y0) * P}`);
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('xmlns', NS);
  const bg = svgEl('rect', { x: x0 * P, y: y0 * P, width: (x1 - x0) * P, height: (y1 - y0) * P, fill: '#ffffff' });
  svg.insertBefore(bg, svg.firstChild.nextSibling);
  const t = svgEl('text', { x: x0 * P + 8, y: y1 * P - 8, 'font-size': 9, fill: '#666', 'font-family': 'sans-serif' });
  t.textContent = `${S.selId || ''} — Scheda Virtuale STM32, ${new Date().toLocaleDateString('it-IT')}`;
  svg.appendChild(t);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  cv.getContext('2d').drawImage(img, 0, 0, W, H);
  URL.revokeObjectURL(url);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `breadboard-${(S.selId || 'progetto').replace(/[^\w\- ]/g, '_')}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  B.ultimoPNG = { w: W, h: H, byte: blob.size };
  return B.ultimoPNG;
}

// ------------------------------------------------------------------
// Avvio
function monta() {
  const pane = $('#pane-breadboard');
  pane.innerHTML = `
    <div class="bb-barra">
      <select id="bb-add" title="Aggiungi un componente: poi clicca sulla breadboard dove posarlo"><option value="">＋ Componente…</option>${Object.entries(K.TIPI).map(([t, x]) => `<option value="${t}">${esc(x.nome)}</option>`).join('')}</select>
      <div class="seg"><button id="bb-ruota" title="Ruota di 90° (R)">⟳</button><button id="bb-elimina" title="Elimina (Canc)">✕</button><button id="bb-copia" title="Copia (⌘/Ctrl+C)">⧉</button><button id="bb-incolla" title="Incolla (⌘/Ctrl+V)">📋</button></div>
      <div class="seg"><button id="bb-annulla" title="Annulla (⌘/Ctrl+Z)">↶</button><button id="bb-ripeti" title="Ripeti (⌘/Ctrl+Shift+Z)">↷</button></div>
      <div class="seg"><button id="bb-zin" title="Zoom avanti (anche con la rotella)">+</button><button id="bb-zout" title="Zoom indietro">−</button><button id="bb-adatta" title="Tutta la scheda">⤢</button></div>
      <span id="bb-colori" class="bb-colori"></span>
      <select id="bb-esempio" title="Circuiti pronti"><option value="">Esempi…</option><option value="15k">Cronometro 3 cifre (Prog_3digit, R11 = 15k come montato)</option><option value="1k5">Cronometro 3 cifre (R11 = 1,5k corretto)</option></select>
      <button id="bb-png" class="ghost small" title="Scarica l'immagine del montaggio (per le relazioni)">PNG</button>
      <button id="bb-svuota" class="ghost small" title="Togli tutto">Svuota</button>
      <button id="bb-grande" class="ghost small" title="Breadboard a tutto schermo (di nuovo per tornare)">⛶</button>
    </div>
    <div id="bb-prop" class="bb-prop"></div>
    <div class="bb-wrap"><svg id="bb-svg" tabindex="0" xmlns="${NS}">
      <defs><filter id="bb-blur" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="4"/></filter></defs>
      <g id="bb-static">${disegnoStatico()}</g><g id="bb-comps"></g><g id="bb-wires"></g><g id="bb-prob"></g><g id="bb-nodo"></g><g id="bb-sel"></g><g id="bb-ghost"></g>
    </svg></div>
    <div id="bb-problemi" class="bb-problemi small" hidden></div>
    <div id="bb-stato" class="bb-stato small mono"></div>`;
  wire();
  applicaVista();
  disegnaComponenti();
}
monta();
// per le prove (strumenti/prova-breadboard-browser.mjs) e per la console
Object.assign(B, { lettura: letturaDisplay, premi, scatto, esportaPNG, impostaPot, modifica, K, seleziona: ids => { B.sel = new Set(ids); disegnaSelezione(); } });
