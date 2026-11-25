// breadboard.js — scheda "Breadboard": si montano i componenti su una breadboard da 830 punti,
// si tirano i fili verso i connettori della Nucleo e la simulazione segue i collegamenti veri.
// Circuito, netlist e solutore stanno in circuito.js; qui c'è l'editor (SVG) e il collegamento
// con il simulatore: a ogni cambio dei pin (righe "C"/"M"/"W") si risolve il circuito in continua
// (con una cache per stato dei pin), si fa la media nel tempo per la luminosità (multiplexing) e
// si mandano agli ingressi della scheda i livelli letti sui nodi ("I porta pin livello").
// Usa S, $, esc, cmd, addLog, pinInfo, parseKey, ADC_PIN di app.js, SEG_SHAPE/SEG_DIGIT/buzzSet di devices.js,
// SV di local-server.js. Il circuito si salva nel progetto come file ".breadboard.json".
import * as K from './circuito.js?v=2026-11-25e';

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
  capV: new Map(), salvaT: null, tempo: false, oscStato: {}, pannello: null, ta: 0, regT: null, osc: {}, budget: 0, richiesti: 0, fatti: 0, tratto: 0, tCtrl: 0, ritardo: 0, risolte: 0, colore: K.COLORI_FILO[3], rallentato: false,
};
window.BB = B;

// ------------------------------------------------------------------
// Disegno statico: Nucleo + breadboard
const svgEl = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
function disegnoStatico() {
  const N = K.NUCLEO, BB_ = K.BB;
  let s = '';
  // Nucleo
  s += `<rect x="${N.x * P - 26}" y="${N.y * P}" width="${(N.w + 1) * P + 26}" height="${N.h * P}" rx="6" fill="#f2f2f2" stroke="#9aa0a6"/>`;
  s += `<rect x="${N.x * P + 60}" y="${N.y * P + 4}" width="180" height="78" rx="4" fill="#e6e6e6" stroke="#b0b4ba"/>`;
  s += `<text x="${N.x * P + 150}" y="${N.y * P + 30}" font-size="11" text-anchor="middle" fill="#455" font-family="sans-serif">ST-LINK/V2-1</text>`;
  s += `<rect x="${N.x * P + 130}" y="${N.y * P - 6}" width="40" height="18" rx="2" fill="#aab" stroke="#778"/>`;
  s += `<text x="${N.x * P + 150}" y="${N.y * P + 104}" font-size="12" font-weight="bold" text-anchor="middle" fill="#1d3a6b" font-family="sans-serif">NUCLEO-F401RE</text>`;
  s += `<rect x="${N.x * P + 110}" y="${N.y * P + 190}" width="80" height="80" fill="#2b2b2b" stroke="#111"/><text x="${N.x * P + 150}" y="${N.y * P + 234}" font-size="8" text-anchor="middle" fill="#ccc" font-family="sans-serif">STM32F401RE</text>`;
  // LD2 e B1 (disegnati; LD2 si accende come sulla scheda)
  s += `<circle id="bb-ld2" cx="${N.x * P + 168}" cy="${N.y * P + 150}" r="5" fill="#2d4a33"/><text x="${N.x * P + 176}" y="${N.y * P + 153}" font-size="7" fill="#455" font-family="sans-serif">LD2</text>`;
  s += `<rect x="${N.x * P + 80}" y="${N.y * P + 330}" width="26" height="26" rx="3" fill="#ddd" stroke="#888"/><circle cx="${N.x * P + 93}" cy="${N.y * P + 343}" r="8" fill="#1e5bd8"/><text x="${N.x * P + 93}" y="${N.y * P + 370}" font-size="8" text-anchor="middle" fill="#455" font-family="sans-serif">B1</text>`;
  s += `<text x="${1.5 * P}" y="${11 * P - 2}" font-size="8" text-anchor="middle" fill="#455" font-family="sans-serif">CN7</text><text x="${27.5 * P}" y="${11 * P - 2}" font-size="8" text-anchor="middle" fill="#455" font-family="sans-serif">CN10</text>`;
  s += `<text x="${5 * P}" y="${13 * P - 2}" font-size="6" text-anchor="middle" fill="#455" font-family="sans-serif">CN6</text><text x="${24 * P}" y="${9 * P - 2}" font-size="6" text-anchor="middle" fill="#455" font-family="sans-serif">CN5</text>`;
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
  // nomi dei pin accanto ai connettori: STM32 sui Morpho (CN7, CN10), Arduino + STM32 sugli Arduino
  // (CN5, CN6, CN8, CN9). Allontanando la vista spariscono (classe "lontano"); il dettaglio resta nella riga in basso.
  s += '<g id="bb-nomi-pin" font-family="ui-monospace, Menlo, monospace" fill="#2b3440">';
  for (const f of K.FORI.values()) {
    const m = /^CN(\d+)[- ](.*)$/.exec(f.nome);
    if (!m) continue;
    const cn = +m[1], resto = m[2];
    let t = '', lato = 1, fs = 6.5;
    if (cn === 7 || cn === 10) {
      const sig = resto.split(' ')[1] || '';
      t = sig.replace(/^\+/, ''); fs = 6;
      lato = (cn === 7 ? f.x === 1 : f.x === 27) ? -1 : 1;
    } else {
      const mm = /^(\S+)(?: \((\S+)\))?$/.exec(resto) || [];
      t = mm[2] && mm[1] !== mm[2] ? (/^P/.test(mm[2]) ? `${mm[1]} ${mm[2]}` : mm[1]) : (mm[1] || '');
      lato = cn === 5 || cn === 9 ? -1 : 1;
    }
    if (!t || t === 'NC') continue;
    const pw = /^(5V|3V3|U5V|E5V|VIN|VDD|AVDD|IOREF)$/.test(t) ? ' fill="#b3261e"' : /^(GND|AGND)$/.test(t) ? ' fill="#111"' : '';
    s += `<text x="${(f.x + lato * 0.5) * P}" y="${f.y * P + fs * 0.36}" font-size="${fs}" text-anchor="${lato < 0 ? 'end' : 'start'}"${pw}>${esc(t)}</text>`;
  }
  s += '</g>';
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
    case 'dmm': case 'scope': case 'gen': case 'psu': return strumentoSVG(c);
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
  return `<text ${pos} font-size="6.5" text-anchor="middle" fill="#334" font-family="sans-serif" paint-order="stroke" stroke="#fff" stroke-width="2" pointer-events="none">${esc(t.trim())}</text>`;
}
function disegnaComponenti() {
  const g = $('#bb-comps');
  g.innerHTML = B.bb.comps.map(c => `<g class="bbc" data-comp="${c.id}" transform="translate(${c.x * P} ${c.y * P}) rotate(${(c.rot || 0) * 90})">${compSVG(c)}</g>`).join('') +
    B.bb.comps.map(etichetta).join('');
  // area di presa: tutto il riquadro del componente (il ponticello, disegnato solo con il tratto, prima si
  // prendeva solo cliccando esattamente sulla linea: il clic finiva sul foro sotto e partiva un filo)
  B.ingombri = [];
  g.querySelectorAll('[data-comp]').forEach(el => { try {
    const b = el.getBBox(), m = 2.5, c = B.bb.comps.find(c => c.id === el.dataset.comp);
    el.insertAdjacentHTML('afterbegin', `<rect class="presa" x="${b.x - m}" y="${b.y - m}" width="${b.width + 2 * m}" height="${b.height + 2 * m}" fill="transparent"/>`);
    // ingombro nel banco (passi), ruotato come il componente: i fori sotto il corpo sono coperti
    const pts = [[b.x, b.y], [b.x + b.width, b.y + b.height]].map(([x, y]) => K.ruota(x / P, y / P, c.rot || 0));
    B.ingombri.push({ id: c.id, x0: c.x + Math.min(pts[0][0], pts[1][0]), x1: c.x + Math.max(pts[0][0], pts[1][0]), y0: c.y + Math.min(pts[0][1], pts[1][1]), y1: c.y + Math.max(pts[0][1], pts[1][1]),
      pins: new Set(K.piediniXY(c).map(p => p.x + ',' + p.y)) });
  } catch {} });
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
  window.dispatchEvent(new Event('bb-cambiato'));   // la vista schema (schema.js) si ridisegna
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
function aggiungi(tipo, x, y, rot = 0) {
  const opt = Object.fromEntries(K.OPZIONI[tipo].map(([k, d]) => [k, d]));
  const c = { id: nuovoId('c'), type: tipo, x, y, rot, opt, label: nuovaEtichetta(tipo) };
  modifica(bb => bb.comps.push(c));
  B.sel = new Set([c.id]);
  disegnaSelezione();
  if (K.STRUMENTI.includes(tipo)) apriPannello(c.id);   // come in Multisim: il pannello si apre subito
  return c;
}
function elimina() {
  if (!B.sel.size) return;
  const s = new Set(B.sel);
  modifica(bb => { bb.comps = bb.comps.filter(c => !s.has(c.id)); bb.wires = bb.wires.filter(w => !s.has(w.id)); });
  B.sel.clear(); disegnaSelezione();
}
function copia() {
  const comps = B.bb.comps.filter(c => B.sel.has(c.id)), wires = B.bb.wires.filter(w => B.sel.has(w.id));
  if (comps.length || wires.length) B.clip = JSON.parse(JSON.stringify({ comps, wires }));
  aggiornaBottoni();
}
function incolla(off = 2) {
  if (!B.clip) return;
  const nuovi = new Set();
  modifica(bb => {
    for (const c of B.clip.comps) { const n = { ...JSON.parse(JSON.stringify(c)), id: nuovoId('c'), x: c.x + off, y: c.y + off }; n.label = nuovaEtichetta(c.type, bb); bb.comps.push(n); nuovi.add(n.id); }
    for (const w of B.clip.wires) { const n = { ...JSON.parse(JSON.stringify(w)), id: nuovoId('w') }; n.p = n.p.map(([x, y]) => [x + off, y + off]); bb.wires.push(n); nuovi.add(n.id); }
  });
  B.clip = { comps: B.clip.comps.map(c => ({ ...c, x: c.x + off, y: c.y + off })), wires: B.clip.wires.map(w => ({ ...w, p: w.p.map(([x, y]) => [x + off, y + off]) })) };
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
  // nel tempo: condensatori, generatore, oscilloscopio (gli altri strumenti vanno anche in continua)
  B.tempo = el.some(e => e.k === 'C' || e.k === 'GEN') || B.bb.comps.some(c => c.type === 'scope');
  B.regT = null;
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
  if (!B.tempo) {
    const k = chiaveDi(st);
    const hit = B.cache.get(k);
    if (hit) return hit;
    if (B.risolte >= MAX_RISOLUZIONI) { B.rallentato = true; return B.ultimo; }
  }
  B.risolte++;
  const res = K.risolvi(B.circ, st, B.ultimo && B.ultimo.res ? B.ultimo.res.reg : null, capDt);
  const r = { res, riass: riassunto(res), prob: [...K.controlli(B.circ, B.net, st, res), ...K.flottanti(B.circ, B.net, st, res)] };
  for (const p of r.prob) segnala(p);
  if (!B.tempo) { if (B.cache.size > CACHE_MAX) B.cache.clear(); B.cache.set(chiaveDi(st), r); }
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
  if (B.tempo && B.ultimo) return B.ultimo;   // nel tempo l'ultimo passo calcolato da integra()
  if (k !== B.chiaveStato || !B.ultimo) {
    B.ultimo = valuta(st);
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
  if (B.tempo) { if (ms * 1e-3 < B.ta - 1e-9) B.ta = ms * 1e-3; integra(ms * 1e-3); return; }
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
window.bbReset = () => { B.ta = 0; B.osc = {}; B.regT = null; B.tratto++; B.acc = null; B.pub = null; B.ultimoMs = 0; B.segnalati.clear(); B.inviati.clear(); B.adcInviati.clear(); B.capV.clear(); B.chiaveStato = ''; ingressiIniziali(); };
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
// Simulazione nel tempo (tappa B): serve con generatore, oscilloscopio o condensatori.
// Passo dt: 1 ms, più piccolo per il generatore (40 punti per periodo), per l'oscilloscopio (500 punti per
// schermata) e per il PWM che l'oscilloscopio deve vedere (20 punti per periodo); mai sotto 2 µs.
// Al massimo PASSI_FOTOGRAMMA passi per fotogramma (~10 µs l'uno su un circuito piccolo, ~40 µs sul cronometro):
// se non basta, il tempo analogico salta in avanti e lo si dice (B.ritardo) — l'oscilloscopio si aggancia
// solo dentro un tratto continuo, quindi la forma d'onda resta giusta.
const PASSI_FOTOGRAMMA = 1500, BUF_OSC = 40000;
function passoTempo(st) {
  let dt = 1e-3;
  const osc = B.bb.comps.filter(c => c.type === 'scope');
  for (const c of B.bb.comps) if (c.type === 'gen') dt = Math.min(dt, 1 / (c.opt.f * 40));
  for (const c of osc) dt = Math.min(dt, c.opt.sdiv * 10 / 500);
  if (osc.length && st) for (const [k] of st.pwm) { const { p, pin } = parseKey(k), i = pinInfo(p, pin); if (i && i.pwm && i.pwm.freq) dt = Math.min(dt, 1 / (i.pwm.freq * 20)); }
  return Math.max(2e-6, dt);
}
function bufferOsc(id) {
  return B.osc[id] || (B.osc[id] = { t: new Float64Array(BUF_OSC), a: new Float32Array(BUF_OSC), b: new Float32Array(BUF_OSC), tratto: new Int32Array(BUF_OSC), i: 0, n: 0 });
}
// avanza il tempo analogico fino a tFine (s) con lo stato dei pin di adesso
function integra(tFine) {
  if (B.dirtyCirc) costruisci();
  if (B.corti.length) { B.ta = tFine; return; }
  const st = statoEsterno();
  const dt = passoTempo(st);
  let n = Math.ceil((tFine - B.ta) / dt - 1e-9);
  if (n <= 0) return;
  B.richiesti += n;
  if (n > B.budget) { B.ta = tFine - B.budget * dt; n = B.budget; B.tratto++; }   // non ce la fa: salta in avanti
  if (n <= 0) { B.ta = tFine; return; }
  B.budget -= n; B.fatti += n;
  if (!B.acc) B.acc = { t: 0, comp: {}, pin: {}, ld2: 0 };
  const caps = B.circ.el.filter(e => e.k === 'C'), osc = B.bb.comps.filter(c => c.type === 'scope');
  const pwm = st.pwm.map(([k]) => { const { p, pin } = parseKey(k), i = pinInfo(p, pin); return [k, i.pwm.duty / 1000, i.pwm.freq]; }).filter(x => x[2] > 0);
  const s2 = { ...st, pwm: [], pins: { ...st.pins } };
  let res = null;
  for (let j = 0; j < n; j++) {
    const t = B.ta + dt;
    s2.t = t;
    for (const [k, d, f] of pwm) s2.pins[k] = { ...st.pins[k], level: ((t * f) % 1) < d ? 1 : 0 };
    const cd = caps.length ? new Map(caps.map(e => [e, [B.capV.get(e) || 0, dt]])) : null;
    res = K.risolvi(B.circ, s2, B.regT, cd);
    B.regT = res.reg;
    for (const e of caps) B.capV.set(e, res.cap.get(e) || 0);
    const w = dt * 1000, a = B.acc;
    for (const [id, m] of res.comp) { const d = a.comp[id] || (a.comp[id] = {}); for (const k in m) d[k] = (d[k] || 0) + m[k] * w; }
    for (const k in res.pin) { const d = a.pin[k] || (a.pin[k] = { i: 0, v: 0 }); d.i += res.pin[k].i * w; d.v += res.pin[k].v * w; }
    a.ld2 += (res.ld2 || 0) * w; a.t += w;
    for (const c of osc) { const m = res.comp.get(c.id) || {}, bf = bufferOsc(c.id); bf.t[bf.i] = t; bf.a[bf.i] = m.a || 0; bf.b[bf.i] = m.b || 0; bf.tratto[bf.i] = B.tratto; bf.i = (bf.i + 1) % BUF_OSC; bf.n = Math.min(BUF_OSC, bf.n + 1); }
    // i controlli del laboratorio ogni ~1 ms simulato (non a ogni passo: costano)
    if (t - B.tCtrl >= 1e-3 || j === n - 1) { B.tCtrl = t; for (const p of [...K.controlli(B.circ, B.net, s2, res), ...K.flottanti(B.circ, B.net, s2, res)]) { const x = B.problemi.get(p.cod + ':' + p.chiave); if (x) x.quando = performance.now(); else segnala(p); } }
    B.ta = t;
  }
  B.ultimo = { res, riass: riassunto(res), prob: [] };
  B.stato = s2; B.chiaveStato = '';
}

// ------------------------------------------------------------------
// Strumenti (tappa B): disegno sul banco, letture, pannelli come in Multisim (doppio clic sullo strumento)
const fmtV = v => { const a = Math.abs(v); return a >= 100 ? v.toFixed(1) : a >= 10 ? v.toFixed(2) : v.toFixed(3); };
const fmtSI = (v, u) => { const a = Math.abs(v); if (!isFinite(v)) return "OL"; const [k, p] = a >= 1e6 ? [1e-6, "M"] : a >= 1e3 ? [1e-3, "k"] : a >= 1 || a === 0 ? [1, ""] : a >= 1e-3 ? [1e3, "m"] : [1e6, "µ"]; return (v * k).toFixed(Math.abs(v * k) >= 100 ? (Number.isInteger(+(v * k).toFixed(3)) ? 0 : 1) : Math.abs(v * k) >= 10 ? 2 : 3).replace('.', ',') + ' ' + p + u; };
function strumentoSVG(c) {
  const o = c.opt, id = c.id, leg = (x, col) => `<line x1="${x}" y1="0" x2="${x}" y2="-8" stroke="${col}" stroke-width="2.4"/><circle cx="${x}" cy="0" r="3.2" fill="${col}" stroke="#111" stroke-width=".8"/>`;
  const lab = (x, t) => `<text x="${x}" y="-11" font-size="5.5" text-anchor="middle" fill="#ddd" font-family="sans-serif">${t}</text>`;
  switch (c.type) {
    case 'dmm': return `<rect x="-10" y="-84" width="80" height="78" rx="8" fill="#f2b705" stroke="#8a6a00"/><rect x="-4" y="-78" width="68" height="62" rx="5" fill="#2a2d33"/>
      <rect x="0" y="-74" width="60" height="22" rx="2" fill="#b9c8a6"/><text data-lcd="${id}" x="57" y="-57" font-size="13" text-anchor="end" fill="#1d2a14" font-family="ui-monospace, Menlo, monospace">${o.modo === 'Ω' ? 'OL' : '0.000'}</text>
      <text data-lcdu="${id}" x="3" y="-56" font-size="6" fill="#1d2a14" font-family="sans-serif">${o.modo === 'Ω' ? 'Ω' : o.modo}${o.ac ? '~' : '⎓'}</text>
      <text x="30" y="-38" font-size="7" text-anchor="middle" fill="#ddd" font-family="sans-serif">${o.modo === 'V' ? 'VOLT' : o.modo === 'A' ? 'AMPERE' : 'OHM'} ${o.ac ? 'AC' : 'DC'}</text>
      ${lab(0, 'COM')}${lab(30, 'V Ω')}${lab(60, 'A')}${leg(0, '#222')}${leg(30, '#d22')}${leg(60, '#d22')}`;
    case 'scope': return `<rect x="-14" y="-92" width="108" height="86" rx="6" fill="#3b4250" stroke="#20252d"/><rect x="-6" y="-86" width="70" height="52" rx="3" fill="#0b1a12"/>
      <g stroke="#1c3a2a" stroke-width=".5">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<line x1="${-6 + i * 7}" y1="-86" x2="${-6 + i * 7}" y2="-34"/>`).join('')}${[1, 2, 3, 4, 5, 6, 7].map(i => `<line x1="-6" y1="${-86 + i * 6.5}" x2="64" y2="${-86 + i * 6.5}"/>`).join('')}</g>
      <polyline data-oscmini="${id}:a" points="" fill="none" stroke="#ffd54a" stroke-width="1"/><polyline data-oscmini="${id}:b" points="" fill="none" stroke="#4fc3f7" stroke-width="1"/>
      <text x="80" y="-70" font-size="6" text-anchor="middle" fill="#ddd" font-family="sans-serif">XSC</text><circle cx="80" cy="-56" r="5" fill="#222" stroke="#999"/><circle cx="80" cy="-42" r="5" fill="#222" stroke="#999"/>
      <text x="29" y="-22" font-size="6" text-anchor="middle" fill="#ccc" font-family="sans-serif">doppio clic: pannello</text>
      ${lab(0, 'A')}${lab(40, 'B')}${lab(80, 'GND')}${leg(0, '#ffd54a')}${leg(40, '#4fc3f7')}${leg(80, '#222')}`;
    case 'gen': return `<rect x="-14" y="-66" width="58" height="60" rx="6" fill="#3b4250" stroke="#20252d"/><rect x="-8" y="-60" width="46" height="20" rx="2" fill="#10202a"/>
      <text data-genl="${id}" x="15" y="-46" font-size="7.5" text-anchor="middle" fill="#7fe0ff" font-family="ui-monospace, Menlo, monospace">${esc(String(o.f))} Hz</text>
      <text x="15" y="-30" font-size="6" text-anchor="middle" fill="#ddd" font-family="sans-serif">${o.forma === 'sin' ? '∿ sinusoide' : o.forma === 'quadra' ? '⊓ quadra' : '△ triangolare'}</text>
      ${lab(0, '+')}${lab(30, 'COM')}${leg(0, '#d22')}${leg(30, '#222')}`;
    case 'psu': return `<rect x="-14" y="-66" width="58" height="60" rx="6" fill="#2f3640" stroke="#20252d"/><rect x="-8" y="-60" width="46" height="13" rx="2" fill="#2b0d0d"/><rect x="-8" y="-45" width="46" height="13" rx="2" fill="#2b0d0d"/>
      <text data-psuv="${id}" x="35" y="-50" font-size="9" text-anchor="end" fill="#ff5a4f" font-family="ui-monospace, Menlo, monospace">${o.v.toFixed(2)}V</text>
      <text data-psui="${id}" x="35" y="-35" font-size="9" text-anchor="end" fill="#ff5a4f" font-family="ui-monospace, Menlo, monospace">0.000A</text>
      <circle data-psucc="${id}" cx="-3" cy="-24" r="2.5" fill="#333"/><text x="2" y="-22" font-size="5.5" fill="#ddd" font-family="sans-serif">CC</text>
      ${lab(0, '+')}${lab(30, '−')}${leg(0, '#d22')}${leg(30, '#222')}`;
  }
  return '';
}
// lettura del multimetro (media sull'ultima finestra; AC = valore efficace della parte alternata)
function letturaDMM(c, m) {
  const o = c.opt;
  if (o.modo === 'Ω') {
    const now = performance.now();
    if (!B.ohm || B.ohm.id !== c.id || now - B.ohm.t > 300 || B.ohm.chiave !== JSON.stringify(B.bb)) {
      if (B.dirtyCirc) costruisci();
      B.ohm = { id: c.id, t: now, chiave: JSON.stringify(B.bb), r: B.circ ? K.misuraOhm(B.circ, c) : null };
    }
    const r = B.ohm.r;
    return r === null || !isFinite(r) ? ['OL', 'Ω'] : [fmtSI(r, 'Ω').replace(/ ([kM]?)Ω$/, ''), (fmtSI(r, 'Ω').match(/ ([kM]?)Ω$/) || [, ''])[1] + 'Ω'];
  }
  const [x, x2, u] = o.modo === 'V' ? [m.v || 0, m.v2 || 0, 'V'] : [m.i || 0, m.i2 || 0, 'A'];
  const val = o.ac ? Math.sqrt(Math.max(0, x2 - x * x)) : x;
  const s = fmtSI(val, u);
  return [s.replace(/ ([mµk]?)[VA]$/, ''), (s.match(/ ([mµk]?[VA])$/) || [, u])[1] + (o.ac ? '~' : '⎓')];
}
function aggiornaStrumenti(pub) {
  for (const c of B.bb.comps) {
    if (!K.STRUMENTI.includes(c.type)) continue;
    const m = pub && pub.comp[c.id] || {};
    const set = (sel, t) => { const x = document.querySelector(sel); if (x && x.textContent !== t) x.textContent = t; };
    if (c.type === 'dmm') { const [v, u] = letturaDMM(c, m); set(`[data-lcd="${c.id}"]`, v); set(`[data-lcdu="${c.id}"]`, u); }
    if (c.type === 'psu') {
      set(`[data-psuv="${c.id}"]`, (m.v ?? c.opt.v).toFixed(2) + 'V'); set(`[data-psui="${c.id}"]`, Math.abs(m.i || 0).toFixed(3) + 'A');
      const cc = document.querySelector(`[data-psucc="${c.id}"]`); if (cc) cc.setAttribute('fill', m.cc > 0.5 ? '#ff3b30' : '#333');
    }
    if (c.type === 'scope') {
      const tr = tracciaOsc(c);
      for (const ch of ['a', 'b']) {
        const pl = document.querySelector(`[data-oscmini="${c.id}:${ch}"]`);
        if (!pl) continue;
        const vdiv = c.opt['v' + ch], y0 = c.opt['y' + ch];
        pl.setAttribute('points', tr ? tr.punti.filter((_, k) => k % 4 === 0).map(q => `${(-6 + q.x * 70).toFixed(1)},${(-60 - (q[ch] / vdiv + y0) * 6.5).toFixed(1)}`).filter(s => !s.includes('NaN')).join(' ') : '');
      }
    }
    if (c.type === 'gen') set(`[data-genl="${c.id}"]`, fmtSI(c.opt.f, 'Hz').replace(',000', '').replace(/,(\d*?)0+ /, (_, d) => d ? ',' + d + ' ' : ' '));
  }
  if (B.pannello) disegnaPannello();
}
// la schermata dell'oscilloscopio: aggancio (trigger) sul canale scelto, solo dentro un tratto continuo
function tracciaOsc(c) {
  const bf = B.osc[c.id];
  if (!bf || bf.n < 2) return null;
  const o = c.opt, W = o.sdiv * 10, N = bf.n, at = k => (bf.i - N + k + BUF_OSC) % BUF_OSC;   // k = 0 il più vecchio
  const ult = at(N - 1), tUlt = bf.t[ult], trCorr = bf.tratto[ult];
  const ch = o.trig === 'B' ? bf.b : bf.a, lv = o.livello, su = o.fronte == 1;
  let start = -1;
  const stato = B.oscStato[c.id] || (B.oscStato[c.id] = { fermo: null });
  if (o.modoT === 'singolo' && stato.fermo) return stato.fermo;
  // fronte più recente che lascia una schermata intera dopo di sé
  for (let k = N - 2; k >= 0; k--) {
    const i0 = at(k), i1 = at(k + 1);
    if (bf.tratto[i0] !== trCorr) break;
    if (bf.t[i1] > tUlt - W * 0.9) continue;
    if (su ? ch[i0] < lv && ch[i1] >= lv : ch[i0] > lv && ch[i1] <= lv) { start = k + 1; break; }
  }
  let t0;
  if (start >= 0) t0 = bf.t[at(start)] - W * 0.1;
  else if (o.modoT === 'auto') t0 = tUlt - W;
  else return stato.ultimo || null;
  const punti = [];
  for (let k = 0; k < N; k++) { const i = at(k); const t = bf.t[i]; if (t < t0 || bf.tratto[i] !== trCorr) continue; if (t > t0 + W) break; punti.push({ x: (t - t0) / W, t: t - t0, a: bf.a[i], b: bf.b[i] }); }
  const r = { punti, t0, agganciato: start >= 0 };
  stato.ultimo = r;
  if (o.modoT === 'singolo' && start >= 0) stato.fermo = r;
  return r;
}
// ------------------------------------------------------------------
// pannelli (finestre sul banco, si spostano trascinando il titolo)
function apriPannello(id) {
  const c = B.bb.comps.find(c => c.id === id);
  if (!c || !K.STRUMENTI.includes(c.type)) return;
  chiudiPannello();
  B.pannello = id;
  const d = document.createElement('div');
  d.className = 'strum-pan'; d.id = 'strum-pan';
  d.innerHTML = `<div class="sp-tit"><b></b><button type="button" class="ghost small" data-chiudi title="Chiudi">✕</button></div><div class="sp-corpo"></div>`;
  d.querySelector('b').textContent = `${c.label} — ${K.TIPI[c.type].nome}`;
  $('.bb-wrap').append(d);
  const pos = B.posPan || { x: 16, y: 16 };
  d.style.left = pos.x + 'px'; d.style.top = pos.y + 'px';
  d.querySelector('[data-chiudi]').addEventListener('click', chiudiPannello);
  const tit = d.querySelector('.sp-tit');
  tit.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const x0 = e.clientX - d.offsetLeft, y0 = e.clientY - d.offsetTop;
    try { tit.setPointerCapture(e.pointerId); } catch {}
    const mv = ev => { B.posPan = { x: Math.max(0, ev.clientX - x0), y: Math.max(0, ev.clientY - y0) }; d.style.left = B.posPan.x + 'px'; d.style.top = B.posPan.y + 'px'; };
    tit.addEventListener('pointermove', mv);
    tit.addEventListener('pointerup', () => tit.removeEventListener('pointermove', mv), { once: true });
  });
  corpoPannello(c, d.querySelector('.sp-corpo'));
}
function chiudiPannello() { const d = $('#strum-pan'); if (d) d.remove(); B.pannello = null; }
function opzStrumento(c, k, v) {
  modifica(bb => { const x = bb.comps.find(x => x.id === c.id); x.opt[k] = v; });
  B.oscStato[c.id] = null;
  if (B.pannello === c.id) apriPannello(c.id);
}
function corpoPannello(c, box) {
  const o = c.opt, sel = (k, vals, fmt = x => x) => `<select data-k="${k}">${vals.map(v => `<option value="${v}" ${String(v) === String(o[k]) ? 'selected' : ''}>${esc(fmt(v))}</option>`).join('')}</select>`;
  const vals = k => K.OPZIONI[c.type].find(x => x[0] === k)[2];
  if (c.type === 'dmm') box.innerHTML = `<div class="sp-lcd"><span data-pv>—</span><small data-pu></small></div>
    <div class="sp-riga seg">${['V', 'A', 'Ω'].map(m => `<button type="button" data-modo="${m}" class="${o.modo === m ? 'on' : ''}">${m}</button>`).join('')}</div>
    <div class="sp-riga seg"><button type="button" data-ac="0" class="${o.ac ? '' : 'on'}">⎓ DC</button><button type="button" data-ac="1" class="${o.ac ? 'on' : ''}">∿ AC (efficace)</button></div>
    <p class="muted small">V: tra «V Ω» e «COM» (10 MΩ). A: in serie, tra «A» e «COM» (0,1 Ω). Ω: misura con il circuito spento (le sorgenti si scollegano da sole), 1 mA di prova.</p>`;
  if (c.type === 'gen') box.innerHTML = `<div class="sp-riga seg">${['sin', 'quadra', 'tri'].map(f => `<button type="button" data-forma="${f}" class="${o.forma === f ? 'on' : ''}">${{ sin: '∿ Sinusoide', quadra: '⊓ Quadra', tri: '△ Triangolare' }[f]}</button>`).join('')}</div>
    <label class="sp-campo">Frequenza <input type="number" data-n="f" min="0.1" max="${K.GEN_FMAX}" step="any" value="${o.f}"> Hz</label>
    <label class="sp-campo">Ampiezza (di picco) <input type="number" data-n="amp" min="0" max="10" step="0.1" value="${o.amp}"> V</label>
    <label class="sp-campo">Offset <input type="number" data-n="off" min="-10" max="10" step="0.1" value="${o.off}"> V</label>
    <p class="muted small">Uscita con 50 Ω interni, tra «+» e «COM». Fino a ${K.GEN_FMAX / 1000} kHz; sopra 1–2 kHz il calcolo nel tempo può non stare al passo del tempo reale (lo dice la riga in basso).</p>`;
  if (c.type === 'psu') box.innerHTML = `<label class="sp-campo">Tensione <input type="range" data-n="v" min="0" max="12" step="0.05" value="${o.v}"> <input type="number" data-n="v" min="0" max="12" step="0.05" value="${o.v}"> V</label>
    <label class="sp-campo">Limite di corrente <input type="number" data-n="ilim" min="0.001" max="3" step="0.01" value="${o.ilim}"> A</label>
    <div class="sp-lcd rosso"><span data-pv>—</span><small data-pu></small></div>
    <p class="muted small">Se il carico chiede più del limite, l'alimentatore passa a corrente costante (spia CC) e la tensione scende.</p>`;
  if (c.type === 'scope') box.innerHTML = `<canvas class="osc" width="560" height="360"></canvas>
    <div class="sp-osc">
      <label>Tempo/div ${sel('sdiv', vals('sdiv'), v => fmtSI(+v, 's').replace(',000', ''))}</label>
      <label><span class="cA">A</span> V/div ${sel('va', vals('va'), v => fmtSI(+v, 'V').replace(',000', ''))}</label>
      <label><span class="cA">A</span> posiz. <input type="number" data-n="ya" min="-10" max="10" step="0.5" value="${o.ya}"></label>
      <label><span class="cB">B</span> V/div ${sel('vb', vals('vb'), v => fmtSI(+v, 'V').replace(',000', ''))}</label>
      <label><span class="cB">B</span> posiz. <input type="number" data-n="yb" min="-10" max="10" step="0.5" value="${o.yb}"></label>
      <label>Trigger ${sel('trig', ['A', 'B'])} ${sel('fronte', [1, 0], v => +v ? '↑' : '↓')}</label>
      <label>Livello <input type="number" data-n="livello" min="-20" max="20" step="0.1" value="${o.livello}"> V</label>
      <label>Modo ${sel('modoT', ['auto', 'normale', 'singolo'])} <button type="button" class="small" data-riarma>Riarma</button></label>
    </div>
    <div class="sp-cursori small mono" data-cursori>Trascina sullo schermo per i cursori T1 e T2.</div>`;
  box.querySelectorAll('select[data-k]').forEach(s => s.addEventListener('change', () => { const v = s.value; opzStrumento(c, s.dataset.k, isNaN(+v) || s.dataset.k === 'trig' || s.dataset.k === 'modoT' ? v : +v); }));
  box.querySelectorAll('input[data-n]').forEach(i => i.addEventListener('change', () => { const v = +i.value; if (isFinite(v)) opzStrumento(c, i.dataset.n, v); }));
  box.querySelectorAll('[data-modo]').forEach(b => b.addEventListener('click', () => opzStrumento(c, 'modo', b.dataset.modo)));
  box.querySelectorAll('[data-ac]').forEach(b => b.addEventListener('click', () => opzStrumento(c, 'ac', +b.dataset.ac)));
  box.querySelectorAll('[data-forma]').forEach(b => b.addEventListener('click', () => opzStrumento(c, 'forma', b.dataset.forma)));
  const ri = box.querySelector('[data-riarma]'); if (ri) ri.addEventListener('click', () => { B.oscStato[c.id] = null; });
  const cv = box.querySelector('canvas.osc');
  if (cv) {
    const tAt = e => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    cv.addEventListener('pointerdown', e => { try { cv.setPointerCapture(e.pointerId); } catch {} const x = tAt(e); B.cursori = B.cursori && B.cursori.id === c.id ? B.cursori : { id: c.id, t1: x, t2: x }; const k = Math.abs(B.cursori.t1 - x) < Math.abs(B.cursori.t2 - x) ? 't1' : 't2'; B.cursori[k] = x; B.cursori.trasc = k; });
    cv.addEventListener('pointermove', e => { if (B.cursori && B.cursori.trasc) B.cursori[B.cursori.trasc] = tAt(e); });
    cv.addEventListener('pointerup', () => { if (B.cursori) B.cursori.trasc = null; });
  }
}
function disegnaPannello() {
  const c = B.bb.comps.find(c => c.id === B.pannello), d = $('#strum-pan');
  if (!c || !d) { chiudiPannello(); return; }
  const m = B.pub && B.pub.comp[c.id] || {};
  const set = (sel, t) => { const x = d.querySelector(sel); if (x && x.textContent !== t) x.textContent = t; };
  if (c.type === 'dmm') { const [v, u] = letturaDMM(c, m); set('[data-pv]', v); set('[data-pu]', ' ' + u); }
  if (c.type === 'psu') { set('[data-pv]', `${(m.v ?? 0).toFixed(2)} V  ${Math.abs(m.i || 0).toFixed(3)} A`); set('[data-pu]', m.cc > 0.5 ? ' CC' : ' CV'); }
  if (c.type !== 'scope') return;
  const cv = d.querySelector('canvas.osc'), g = cv.getContext('2d'), W = cv.width, H = cv.height, o = c.opt;
  g.fillStyle = '#06120c'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#163a28'; g.lineWidth = 1;
  for (let i = 1; i < 10; i++) { g.beginPath(); g.moveTo(i * W / 10 + .5, 0); g.lineTo(i * W / 10 + .5, H); g.stroke(); }
  for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(0, i * H / 8 + .5); g.lineTo(W, i * H / 8 + .5); g.stroke(); }
  g.strokeStyle = '#2f6b4a'; g.beginPath(); g.moveTo(W / 2 + .5, 0); g.lineTo(W / 2 + .5, H); g.moveTo(0, H / 2 + .5); g.lineTo(W, H / 2 + .5); g.stroke();
  const tr = tracciaOsc(c);
  const yOf = (v, ch) => H / 2 - (v / o['v' + ch] + o['y' + ch]) * H / 8;
  for (const [ch, col] of [['a', '#ffd54a'], ['b', '#4fc3f7']]) {
    // marcatore dello zero del canale
    g.fillStyle = col; g.fillRect(0, yOf(0, ch) - 3, 6, 6);
    if (!tr || !tr.punti.length) continue;
    g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath();
    tr.punti.forEach((q, k) => { const x = q.x * W, y = yOf(q[ch], ch); if (k) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
  }
  // livello di trigger e cursori
  g.strokeStyle = '#ff8a65'; g.setLineDash([4, 4]); g.beginPath(); const yt = yOf(o.livello, o.trig === 'B' ? 'b' : 'a'); g.moveTo(0, yt); g.lineTo(14, yt); g.stroke(); g.setLineDash([]);
  g.font = '12px ui-monospace, Menlo, monospace'; g.fillStyle = '#9fd8b4';
  g.fillText(`${fmtSI(o.sdiv, 's')}/div   A ${fmtSI(o.va, 'V')}/div   B ${fmtSI(o.vb, 'V')}/div   ${tr ? (tr.agganciato ? 'Trig ✓' : o.modoT === 'auto' ? 'Auto' : 'Attesa…') : 'nessun segnale'}${B.ritardo ? `   calcolo al ${B.ritardo}%` : ''}`, 8, H - 8);
  const cu = B.cursori && B.cursori.id === c.id ? B.cursori : null;
  if (cu && tr && tr.punti.length) {
    const val = x => { let best = tr.punti[0]; for (const q of tr.punti) if (Math.abs(q.x - x) < Math.abs(best.x - x)) best = q; return best; };
    for (const [k, col] of [['t1', '#ff5252'], ['t2', '#b388ff']]) { g.strokeStyle = col; g.beginPath(); g.moveTo(cu[k] * W, 0); g.lineTo(cu[k] * W, H); g.stroke(); g.fillStyle = col; g.fillText(k.toUpperCase(), cu[k] * W + 3, 14); }
    const q1 = val(cu.t1), q2 = val(cu.t2), dT = Math.abs(cu.t2 - cu.t1) * o.sdiv * 10;
    const txt = `T1 ${fmtSI(cu.t1 * o.sdiv * 10, 's')}  A ${fmtV(q1.a)} V  B ${fmtV(q1.b)} V   ·   T2 ${fmtSI(cu.t2 * o.sdiv * 10, 's')}  A ${fmtV(q2.a)} V  B ${fmtV(q2.b)} V   ·   ΔT ${fmtSI(dT, 's')}${dT > 0 ? '  1/ΔT ' + fmtSI(1 / dT, 'Hz') : ''}`;
    set('[data-cursori]', txt);
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
  B.risolte = 0; B.budget = PASSI_FOTOGRAMMA;
  const now = performance.now();
  // quanto del tempo analogico si riesce a calcolare (ultimo secondo)
  if (now - (B.contaT || 0) > 1000) { B.ritardo = B.richiesti > 0 && B.fatti < B.richiesti * 0.98 ? Math.round(100 * B.fatti / B.richiesti) : 0; B.richiesti = B.fatti = 0; B.contaT = now; }
  if (!B.bb.comps.length) { mostraProblemi(now); return; }
  if (inCorsa()) {
    avanza(S.ms);
    aggiornaIngressi();
    // media pubblicata ogni ≥ 30 ms simulati (o 300 ms veri, se la scheda è lenta)
    if (B.acc && (B.acc.t >= 30 || (B.acc.t > 0 && now - (B.pubT || 0) > 300))) { B.pub = media(B.acc); B.acc = null; B.pubT = now; }
  } else {
    // scheda ferma: i pin sono tutti liberi, le alimentazioni ci sono (USB collegato)
    if (B.tempo) {
      integra(B.ta + Math.min(0.1, (now - ultimoFrame) / 1000 || 0.016));
      if (B.acc && (B.acc.t >= 30 || now - (B.pubT || 0) > 300)) { B.pub = media(B.acc); B.acc = null; B.pubT = now; }
    } else {
      const r = attuale();
      B.pub = r ? media({ t: 1, ...JSON.parse(JSON.stringify(r.riass)) }) : null;
      if (r) rinfresca(r);
    }
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
// elementi animati a ogni fotogramma: querySelector una volta sola (si ricerca se l'elemento non è più nella pagina)
const elCache = new Map();
function el1(sel) {
  let x = elCache.get(sel);
  if (!x || !x.isConnected) { x = document.querySelector(sel); elCache.set(sel, x); }
  return x;
}
const attr = (x, k, v) => { if (x && x.getAttribute(k) !== v) x.setAttribute(k, v); };
function aggiornaVista(now) {
  if (elCache.size > 4000) elCache.clear();
  const pub = B.pub;
  for (const c of B.bb.comps) {
    const m = pub && pub.comp[c.id] || {};
    if (c.type === 'led') {
      const b = lum(m.i || 0), g = el1(`[data-glow="${c.id}"]`), l = el1(`[data-lens="${c.id}"]`);
      attr(g, 'opacity', (b * 0.9).toFixed(2));
      attr(l, 'fill-opacity', (0.55 + 0.45 * b).toFixed(2));
    } else if (c.type === 'seg7' || c.type === 'seg7x3') {
      const nd = c.type === 'seg7' ? 1 : 3;
      for (let j = 0; j < nd * 8; j++) {
        const x = el1(`[data-seg="${c.id}:${j}"]`);
        if (!x) continue;
        const b = lum(m['s' + j] || 0);
        attr(x, 'fill', b ? `rgb(${Math.round(70 + 185 * b)}, ${Math.round(20 + 40 * b)}, ${Math.round(20 + 30 * b)})` : '#3a1414');
      }
    } else if (c.type === 'buzzer') {
      const on = Math.abs(m.v || 0) > 1.5, g = el1(`[data-glow="${c.id}"]`);
      attr(g, 'opacity', on ? '0.9' : '0');
      if (typeof buzzSet === 'function') buzzSet('bb' + c.id, 2300, on && inCorsa() && B.suono && B.suono.has(c.id));
    } else if (c.type === 'motor') {
      const a = B.motAng = B.motAng || {}, v = m.v || 0;
      a[c.id] = ((a[c.id] || 0) + v * 200 * ((now - (B.motT || now)) / 1000)) % 360;
      const r = el1(`[data-rot="${c.id}"]`);
      if (r) r.setAttribute('transform', `translate(15 -18) rotate(${a[c.id].toFixed(1)})`);
    } else if (c.type === 'servo') {
      const r = el1(`[data-rot="${c.id}"]`), ang = angoloServo(c);
      if (r && ang !== null) r.setAttribute('transform', `rotate(${ang - 90} 10 -36)`);
    } else if (c.type === 'button') {
      const x = el1(`[data-act="press"][data-id="${c.id}"]`);
      attr(x, 'fill', B.premuti.has(c.id) ? '#9a9a9a' : '#555');
    }
  }
  B.motT = now;
  aggiornaStrumenti(pub);
  const ld2 = document.getElementById('bb-ld2');
  attr(ld2, 'fill', pub && pub.ld2 > 5e-5 ? '#7dffad' : '#2d4a33');
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
  const cop = h && coperto(h) ? (B.ingombri.find(r => h[0] > r.x0 && h[0] < r.x1 && h[1] > r.y0 && h[1] < r.y1) || {}).id : null;
  if (cop) { const c = B.bb.comps.find(c => c.id === cop); t = `sotto ${c ? c.label || K.TIPI[c.type].nome : 'un componente'} (foro coperto: si collega ai suoi piedini)`; }
  else if (h && B.net) {
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
  if (msgFisso) t = msgFisso + (t ? '  ·  ' + t : '');
  if (B.tempo && B.ritardo) t += (t ? ' · ' : '') + `simulazione nel tempo al ${B.ritardo}% del tempo reale (passo ${fmtSI(passoTempo(B.stato), 's')}): forme d'onda giuste, ma a tratti`;
  if (B.rallentato) { t += (t ? ' · ' : '') + 'circuito lento: alcune soluzioni rimandate'; B.rallentato = false; }
  if (el.textContent !== t) el.textContent = t;
  // evidenzia il nodo
  const g = $('#bb-nodo');
  const k = h ? h.join(',') + ':' + B.bb.wires.length + B.bb.comps.length : '';
  if (g.dataset.k === k) return;
  g.dataset.k = k;
  if (!h || !B.net || coperto(h)) { g.innerHTML = ''; return; }
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
  const v = B.vista, svg = $('#bb-svg');
  svg.setAttribute('viewBox', `${v.x * P} ${v.y * P} ${v.w * P} ${v.h * P}`);
  // nomi dei pin: leggibili da ~4 px sullo schermo in su, se no spariscono
  const scala = (svg.getBoundingClientRect().width || 1) / (v.w * P);
  svg.classList.toggle('lontano', scala * 6.5 < 3.6);
}
function zoom(f, cx, cy) {
  const v = B.vista, w = Math.min(MONDO.w * 2, Math.max(12, v.w * f)), h = w * v.h / v.w;
  if (cx === undefined) { cx = v.x + v.w / 2; cy = v.y + v.h / 2; }
  v.x = cx - (cx - v.x) * w / v.w; v.y = cy - (cy - v.y) * h / v.h; v.w = w; v.h = h;
  applicaVista();
}
function adatta() {
  // tutto quello che c'è: Nucleo, breadboard, componenti, fili (non lo spazio vuoto del mondo)
  let x0 = K.NUCLEO.x - 3, y0 = K.NUCLEO.y - 2, x1 = K.BB.x + K.BB.w + 1, y1 = K.NUCLEO.y + K.NUCLEO.h + 1;
  for (const r of B.ingombri || []) { x0 = Math.min(x0, r.x0 - 1); y0 = Math.min(y0, r.y0 - 1); x1 = Math.max(x1, r.x1 + 1); y1 = Math.max(y1, r.y1 + 2); }
  for (const w of B.bb.wires) for (const [x, y] of w.p) { x0 = Math.min(x0, x - 1); y0 = Math.min(y0, y - 1); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
  const svg = $('#bb-svg'), r = svg.getBoundingClientRect(), ar = r.height / Math.max(1, r.width) || 0.5;
  const v = B.vista, W = x1 - x0, H = y1 - y0;
  v.w = W; v.h = W * ar;
  if (v.h < H) { v.h = H; v.w = H / ar; }
  v.x = x0 - (v.w - W) / 2; v.y = y0 - (v.h - H) / 2;
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

// Interazione (tappa A, come Multisim/Tinkercad):
//   fili clic-clic: clic su un foro o un pin, clic sull'arrivo → filo a 90° con colore automatico;
//     clic fuori dai fori (o Alt+clic su un foro) = angolo; Esc annulla; Backspace toglie l'ultimo angolo.
//     Si può anche tirare: premi su un foro, trascina, lascia sull'arrivo.
//   trascina sul vuoto = rettangolo di selezione; Maiusc+trascina o rotella premuta = sposta la vista;
//   rotella = zoom sul puntatore; tasti R M C W F Canc Esc, ⌘/Ctrl+Z/Y/C/V/D/A (elenco con "?").
// Le scorciatoie valgono in tutta la pagina, tranne quando si scrive (campi, editor del codice) o con
// una finestra aperta: prima andavano solo con il fuoco sul disegno (vedi resoconto: difetto di R).
const SEGNALI = [K.COLORI_FILO[2], K.COLORI_FILO[3], K.COLORI_FILO[4], K.COLORI_FILO[5], K.COLORI_FILO[6], K.COLORI_FILO[7], K.COLORI_FILO[8], K.COLORI_FILO[9]];
const suFori = g => K.FORI.has(K.chiave(g[0], g[1]));
const suPiedino = (g, escludi) => B.bb.comps.some(c => !(escludi && escludi.has(c.id)) && K.piediniXY(c).some(p => p.x === g[0] && p.y === g[1]));
// foro coperto dal corpo di un componente (non dai suoi piedini): non si usa
const coperto = g => (B.ingombri || []).some(r => g[0] > r.x0 && g[0] < r.x1 && g[1] > r.y0 && g[1] < r.y1 && !r.pins.has(g[0] + ',' + g[1]));
const terminale = g => (suFori(g) && !coperto(g)) || suPiedino(g);
// percorso a 90° tra due punti: dai pin della Nucleo si esce in orizzontale, dalla breadboard in verticale
function angolo(a, b) {
  if (a[0] === b[0] || a[1] === b[1]) return [];
  const daNucleo = a[0] <= K.NUCLEO.x + K.NUCLEO.w, versoNucleo = b[0] <= K.NUCLEO.x + K.NUCLEO.w;
  return [daNucleo && !versoNucleo ? [b[0], a[1]] : versoNucleo ? [a[0], b[1]] : [a[0], b[1]]];
}
function percorso(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) out.push(...angolo(out[out.length - 1], pts[i]), pts[i]);
  // via i punti doppi e quelli in mezzo a un tratto dritto
  const s = out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
  return s.filter((p, i) => i === 0 || i === s.length - 1 || !((s[i - 1][0] === p[0] && p[0] === s[i + 1][0]) || (s[i - 1][1] === p[1] && p[1] === s[i + 1][1])));
}
// colore automatico: rosso per 5V/3V3, nero per GND, per i segnali un colore per nodo (lo stesso nodo, lo stesso colore)
function coloreAuto(a, b) {
  const net = K.netlist(B.bb);
  const nodi = [a, b].map(g => net.nodoDi(g[0], g[1])).filter(n => n >= 0).map(n => net.nodi[n]);
  const chiavi = nodi.flatMap(n => n.chiavi);
  if (nodi.some(n => n.alim.includes('GND')) || chiavi.some(k => k === 'bb:T-' || k === 'bb:B-')) return K.COLORI_FILO[1];
  if (nodi.some(n => n.alim.includes('5V') || n.alim.includes('3V3')) || chiavi.some(k => k === 'bb:T+' || k === 'bb:B+')) return K.COLORI_FILO[0];
  // un filo già presente sullo stesso nodo dà il colore
  for (const w of B.bb.wires) for (const q of [w.p[0], w.p[w.p.length - 1]]) { const n = net.nodoDi(q[0], q[1]); if (n >= 0 && nodi.some(x => x.i === n) && SEGNALI.includes(w.col)) return w.col; }
  const pin = nodi.flatMap(n => n.pins)[0];
  if (pin) { let h = 0; for (const ch of pin) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return SEGNALI[h % SEGNALI.length]; }
  const usati = B.bb.wires.map(w => w.col);
  return SEGNALI.find(c => !usati.includes(c)) || SEGNALI[B.bb.wires.length % SEGNALI.length];
}
function disegnaFiloInCorso() {
  const g = $('#bb-ghost');
  if (!B.filo) { g.innerHTML = ''; return; }
  const pts = percorso([...B.filo.pts, B.filo.cur]);
  const col = B.filo.col || (B.filo.col = coloreAuto(B.filo.pts[0], B.filo.pts[0]));
  const fine = terminale(B.filo.cur) && (B.filo.cur[0] !== B.filo.pts[0][0] || B.filo.cur[1] !== B.filo.pts[0][1]);
  g.innerHTML = `<polyline points="${pts.map(q => q.map(v => v * P).join(',')).join(' ')}" fill="none" stroke="${col}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" opacity=".85" stroke-dasharray="${fine ? '' : '5 3'}"/>` +
    `<circle cx="${B.filo.pts[0][0] * P}" cy="${B.filo.pts[0][1] * P}" r="4" fill="${col}"/>` +
    `<circle cx="${B.filo.cur[0] * P}" cy="${B.filo.cur[1] * P}" r="5" fill="none" stroke="${fine ? '#2fd470' : '#9aa0a6'}" stroke-width="1.6"/>`;
}
function iniziaFilo(g) { B.filo = { pts: [g], cur: g, col: null }; $('#bb-svg').classList.add('filo'); disegnaFiloInCorso(); messaggioStato('Filo: clicca l\'arrivo (un foro o un pin). Clic fuori dai fori o Alt+clic = angolo · Esc annulla'); }
function finisciFilo(g) {
  const pts = percorso([...B.filo.pts, g]);
  const w = { id: nuovoId('w'), p: pts, col: coloreAuto(B.filo.pts[0], g) };
  B.filo = null; disegnaFiloInCorso(); messaggioStato('');
  if (B.modo !== 'filo') $('#bb-svg').classList.remove('filo');
  modifica(bb => bb.wires.push(w));
  B.sel = new Set([w.id]); disegnaSelezione();
}
function annullaComando() {
  if (B.filo) { B.filo = null; disegnaFiloInCorso(); messaggioStato(''); if (B.modo !== 'filo') $('#bb-svg').classList.remove('filo'); return true; }
  if (B.posa) { B.posa = null; $('#bb-svg').classList.remove('posa'); $('#bb-ghost').innerHTML = ''; $('#bb-sel-aggancio').innerHTML = ''; document.querySelectorAll('.pal-voce.on').forEach(x => x.classList.remove('on')); messaggioStato(''); return true; }
  if (B.drag && B.drag.kind === 'muovi') {
    const d = B.drag; B.drag = null;
    B.bb = K.pulisciBreadboard(JSON.parse(d.prima)); $('#bb-svg').classList.remove('sposta'); $('#bb-sel-aggancio').innerHTML = ''; messaggioStato('');
    if (d.copia) { annulla(); B.redo.pop(); aggiornaBottoni(); } else cambiato(false);   // la copia annullata sparisce (e non resta da rifare)
    return true;
  }
  if (B.modo === 'filo') { impostaModo('sel'); return true; }
  if (B.sel.size) { B.sel.clear(); disegnaSelezione(); return true; }
  return false;
}
function impostaModo(m) {
  B.modo = m;
  $('#bb-svg').classList.toggle('filo', m === 'filo');
  $('#bb-t-sel').classList.toggle('on', m === 'sel'); $('#bb-t-filo').classList.toggle('on', m === 'filo');
  messaggioStato(m === 'filo' ? 'Modalità filo (W): clicca un foro o un pin per partire · Esc per tornare a selezionare' : '');
}
let msgFisso = '';
function messaggioStato(t) { msgFisso = t; aggiornaStato(); }

// ruota tutto quello che è selezionato (componenti attorno al loro centro, fili attorno al centro del filo)
function ruotaSel() {
  const ids = new Set(B.sel);
  if (!ids.size) return;
  modifica(bb => ruotaInPlace(ids, bb));
}
function ruotaInPlace(ids, bb = B.bb) {
  {
    for (const c of bb.comps) if (ids.has(c.id)) {
      const centro = cc => { const pp = K.piediniXY(cc), xs = pp.map(p => p.x), ys = pp.map(p => p.y); return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; };
      const c0 = centro(c);
      c.rot = ((c.rot || 0) + 1) % 4;
      const c1 = centro(c);
      c.x += Math.round(c0[0] - c1[0]); c.y += Math.round(c0[1] - c1[1]);
    }
    for (const w of bb.wires) if (ids.has(w.id)) {
      const xs = w.p.map(q => q[0]), ys = w.p.map(q => q[1]);
      const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2), cy = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
      w.p = w.p.map(([x, y]) => [cx - (y - cy), cy + (x - cx)]);
    }
  }
}
// sposta (M) / copia (C): la selezione segue il mouse fino al clic
function iniziaMuovi(copiaPrima) {
  if (!B.sel.size) { messaggioStato('Seleziona prima qualcosa (clic, o trascina un rettangolo)'); return; }
  if (copiaPrima) { copia(); incolla(0); }
  const g = B.hover || [0, 0], ora = JSON.stringify(B.bb);
  B.drag = { kind: 'muovi', start: g, prima: ora, mosso: false, copia: !!copiaPrima };
  $('#bb-svg').classList.add('sposta');
  messaggioStato((copiaPrima ? 'Copia' : 'Sposta') + ': muovi il mouse e clicca dove lasciarla · Esc annulla');
}
function spostaSelezione(dx, dy) {
  for (const c of B.bb.comps) if (B.sel.has(c.id)) { c.x += dx; c.y += dy; }
  for (const w of B.bb.wires) if (B.sel.has(w.id)) w.p = w.p.map(([x, y]) => [x + dx, y + dy]);
}

// aggancio: dove finirebbero i piedini dei componenti (verde = foro libero, rosso = fuori dai fori o
// occupato, arancione = due piedini diversi dello stesso componente sulla stessa fila)
function controllaAggancio(comps) {
  const ids = new Set(comps.map(c => c.id));
  const altri = { v: 1, comps: B.bb.comps.filter(c => !ids.has(c.id)), wires: B.bb.wires };
  const net = K.netlist(altri);
  const occupati = new Set(altri.comps.flatMap(c => K.piediniXY(c).map(p => K.chiave(p.x, p.y))));
  const out = [], avvisi = [];
  for (const c of comps) {
    const pp = K.piediniXY(c).map(p => ({ ...p, f: K.funzionePiedino(c, p.n), nodo: net.nodoDi(p.x, p.y) }));
    for (const p of pp) {
      let st = !suFori([p.x, p.y]) ? 'no' : occupati.has(K.chiave(p.x, p.y)) ? 'no' : 'ok';
      if (st === 'ok' && c.type !== 'jumper' && p.nodo >= 0 && pp.some(q => q !== p && q.nodo === p.nodo && q.f !== p.f)) st = 'fila';
      out.push({ ...p, st });
    }
    if (pp.some(p => out.find(o => o.x === p.x && o.y === p.y && o.st === 'fila'))) avvisi.push(`${c.label || K.TIPI[c.type].nome}: due piedini sulla stessa fila (sono collegati tra loro)`);
    else if (pp.some(p => !suFori([p.x, p.y]))) avvisi.push(`${c.label || K.TIPI[c.type].nome}: qualche piedino è fuori dai fori`);
  }
  const col = { ok: '#2fd470', no: '#ff4d4f', fila: '#ffa940' };
  $('#bb-sel-aggancio').innerHTML = out.map(p => `<circle cx="${p.x * P}" cy="${p.y * P}" r="4.6" fill="${col[p.st]}" fill-opacity=".28" stroke="${col[p.st]}" stroke-width="1.6"/>`).join('');
  return avvisi;
}

function wire() {
  const svg = $('#bb-svg');
  B.modo = 'sel';
  svg.addEventListener('contextmenu', e => { if (B.filo || B.posa) { e.preventDefault(); annullaComando(); } });
  svg.addEventListener('pointerdown', ev => {
    if (ev.button === 2) return;
    const m = mondo(ev), g = griglia(m), hit = colpito(ev);
    try { svg.setPointerCapture(ev.pointerId); } catch {}
    // sposta la vista: rotella premuta o Maiuscolo+trascina
    if (ev.button === 1 || (ev.shiftKey && !B.filo)) { ev.preventDefault(); svg.classList.add('pan'); B.drag = { kind: 'pan', start: [ev.clientX, ev.clientY], v: { ...B.vista } }; return; }
    if (B.posa) { const tipo = B.posa, rot = B.posaRot || 0; annullaComando(); aggiungi(tipo, g[0], g[1], rot); return; }
    if (B.drag && B.drag.kind === 'muovi') { finisciMuovi(); return; }
    if (B.filo) {
      const inizio = B.filo.pts[0];
      if (terminale(g) && !ev.altKey && (g[0] !== inizio[0] || g[1] !== inizio[1])) finisciFilo(g);
      else if (g[0] !== B.filo.pts[B.filo.pts.length - 1][0] || g[1] !== B.filo.pts[B.filo.pts.length - 1][1]) { B.filo.pts = percorso([...B.filo.pts, g]); disegnaFiloInCorso(); }
      return;
    }
    if (hit.act === 'press') { premi(hit.id, true); B.drag = { kind: 'press', id: hit.id }; return; }
    if (hit.act === 'enc') { const e = B.enc[hit.id] || [0, 0, 0]; B.enc[hit.id] = [e[0], e[1], 1]; aggiornaIngressi(); B.drag = { kind: 'encsw', id: hit.id }; return; }
    const vicinoAlForo = Math.hypot(m[0] - g[0], m[1] - g[1]) < 0.42;
    const suUnPiedino = vicinoAlForo && suPiedino(g) && !hit.act;
    // in modalità filo, su un foro libero o sul piedino di un componente: parte un filo (clic-clic, o trascinando)
    if (B.modo === 'filo' || suUnPiedino || (!hit.comp && !hit.wire && vicinoAlForo && terminale(g))) {
      if (B.modo === 'filo' && !terminale(g)) { messaggioStato('Un filo parte da un foro o da un pin'); return; }
      B.sel.clear(); disegnaSelezione();
      iniziaFilo(g);
      B.drag = { kind: 'filoGiu', start: g, mosso: false };
      return;
    }
    if (hit.comp) {
      if (!ev.ctrlKey && !ev.metaKey && !B.sel.has(hit.comp)) B.sel = new Set();
      if ((ev.ctrlKey || ev.metaKey) && B.sel.has(hit.comp)) B.sel.delete(hit.comp); else B.sel.add(hit.comp);
      disegnaSelezione();
      B.drag = { kind: 'comp', start: g, prima: JSON.stringify(B.bb), mosso: false };
      return;
    }
    if (hit.wire) {
      const w = B.bb.wires.find(w => w.id === hit.wire);
      if (!ev.ctrlKey && !ev.metaKey) B.sel = new Set();
      B.sel.add(w.id); disegnaSelezione();
      B.drag = { kind: 'wire', id: w.id, prima: JSON.stringify(B.bb), mosso: false, ...puntoFilo(w, m), start: g };
      return;
    }
    // sul vuoto: rettangolo di selezione
    if (!ev.ctrlKey && !ev.metaKey && B.sel.size) { B.sel.clear(); disegnaSelezione(); }
    B.drag = { kind: 'rett', da: m, a: m };
  });
  svg.addEventListener('pointermove', ev => {
    const m = mondo(ev), g = griglia(m);
    if (!B.hover || B.hover[0] !== g[0] || B.hover[1] !== g[1]) { B.hover = g; aggiornaStato(); }
    const d = B.drag;
    if (B.posa) {
      $('#bb-ghost').setAttribute('transform', `translate(${g[0] * P} ${g[1] * P})`);
      sagomaPosa();
      return;
    }
    $('#bb-ghost').removeAttribute('transform');
    if (B.filo) { B.filo.cur = g; if (d && d.kind === 'filoGiu' && (g[0] !== d.start[0] || g[1] !== d.start[1])) d.mosso = true; disegnaFiloInCorso(); return; }
    if (!d) return;
    if (d.kind === 'pan') {
      const r = svg.getBoundingClientRect(), k = B.vista.w / r.width;
      B.vista.x = d.v.x - (ev.clientX - d.start[0]) * k; B.vista.y = d.v.y - (ev.clientY - d.start[1]) * k;
      applicaVista();
    } else if (d.kind === 'comp' || d.kind === 'muovi') {
      const dx = g[0] - d.start[0], dy = g[1] - d.start[1];
      if (!dx && !dy) return;
      d.start = g; d.mosso = true;
      spostaSelezione(dx, dy);
      disegnaComponenti();
      const sel = B.bb.comps.filter(c => B.sel.has(c.id));
      if (sel.length) messaggioStato(controllaAggancio(sel).join(' · '));
    } else if (d.kind === 'wire') {
      const w = B.bb.wires.find(w => w.id === d.id);
      if (!w || (g[0] === d.start[0] && g[1] === d.start[1] && !d.mosso)) return;
      if (d.segmento !== undefined && d.punto === undefined) { w.p.splice(d.segmento + 1, 0, g); d.punto = d.segmento + 1; }
      if (d.punto !== undefined) w.p[d.punto] = g;
      d.mosso = true;
      disegnaComponenti();
    } else if (d.kind === 'rett') {
      d.a = m;
      const [x0, x1] = [Math.min(d.da[0], m[0]), Math.max(d.da[0], m[0])], [y0, y1] = [Math.min(d.da[1], m[1]), Math.max(d.da[1], m[1])];
      $('#bb-ghost').innerHTML = `<rect x="${x0 * P}" y="${y0 * P}" width="${(x1 - x0) * P}" height="${(y1 - y0) * P}" fill="#4f9dff" fill-opacity=".1" stroke="#4f9dff" stroke-dasharray="4 3"/>`;
    }
  });
  const fine = ev => {
    const d = B.drag;
    svg.classList.remove('pan');
    if (!d || d.kind === 'muovi') return;
    B.drag = null;
    if (d.kind === 'press') premi(d.id, false);
    else if (d.kind === 'encsw') setTimeout(() => { const e = B.enc[d.id] || [0, 0, 0]; B.enc[d.id] = [e[0], e[1], 0]; aggiornaIngressi(); }, 120);
    else if (d.kind === 'filoGiu') {
      // trascinato fino a un altro foro: il filo finisce lì; se no si continua a clic
      const g = B.hover;
      if (d.mosso && g && terminale(g) && (g[0] !== d.start[0] || g[1] !== d.start[1])) finisciFilo(g);
    } else if ((d.kind === 'comp' || d.kind === 'wire') && d.mosso) {
      $('#bb-sel-aggancio').innerHTML = ''; messaggioStato('');
      B.undo.push(d.prima); B.redo = [];
      B.bb = K.pulisciBreadboard(B.bb); cambiato();
    } else if (d.kind === 'rett') {
      $('#bb-ghost').innerHTML = '';
      const [x0, x1] = [Math.min(d.da[0], d.a[0]), Math.max(d.da[0], d.a[0])], [y0, y1] = [Math.min(d.da[1], d.a[1]), Math.max(d.da[1], d.a[1])];
      if (x1 - x0 < 0.3 && y1 - y0 < 0.3) return;
      const dentro = ([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
      for (const c of B.bb.comps) if (K.piediniXY(c).every(p => dentro([p.x, p.y]))) B.sel.add(c.id);
      for (const w of B.bb.wires) if (w.p.every(dentro)) B.sel.add(w.id);
      disegnaSelezione();
    }
  };
  svg.addEventListener('pointerup', fine);
  svg.addEventListener('pointercancel', fine);
  svg.addEventListener('pointerleave', () => { B.hover = null; aggiornaStato(); });
  svg.addEventListener('dblclick', ev => {
    const hit = colpito(ev);
    if (hit.comp && !B.filo) { apriPannello(hit.comp); return; }
    if (!hit.wire || B.filo) return;
    const w = B.bb.wires.find(w => w.id === hit.wire), pf = puntoFilo(w, mondo(ev));
    if (pf.punto > 0 && pf.punto < w.p.length - 1) modifica(() => { const x = B.bb.wires.find(x => x.id === w.id); x.p.splice(pf.punto, 1); });
  });
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const hit = colpito(ev);
    if (hit.act === 'enc') { scatto(hit.id, ev.deltaY > 0 ? 1 : -1); return; }
    if (hit.act === 'pot') { const c = B.bb.comps.find(c => c.id === hit.id); impostaPot(c, c.opt.pos + (ev.deltaY > 0 ? -0.02 : 0.02)); return; }
    const m = mondo(ev);
    zoom(Math.exp(Math.max(-0.5, Math.min(0.5, ev.deltaY * (ev.deltaMode ? 0.05 : 0.0015)))), m[0], m[1]);
  }, { passive: false });
  document.addEventListener('keydown', tasti);
  new ResizeObserver(() => { if (!B.vistaFatta && svg.getBoundingClientRect().width > 50) { B.vistaFatta = true; adatta(); } }).observe(svg);
}
function finisciMuovi() {
  const d = B.drag;
  B.drag = null;
  $('#bb-svg').classList.remove('sposta'); $('#bb-sel-aggancio').innerHTML = ''; messaggioStato('');
  if (!d.mosso) return;
  if (!d.copia) { B.undo.push(d.prima); B.redo = []; }   // copia e spostamento: un solo passo da annullare (l'incolla)
  B.bb = K.pulisciBreadboard(B.bb); cambiato();
}
// tasti: in tutta la pagina, tranne mentre si scrive o con una finestra aperta
function tasti(ev) {
  const t = ev.target;
  if (t && (t.closest('input, textarea, select, [contenteditable], .cm-editor') || t.isContentEditable)) return;
  if (document.querySelector('dialog[open]') || document.querySelector('.tour-card')) return;
  const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
  if (mod && k === 'z') { ev.preventDefault(); ev.shiftKey ? ripeti() : annulla(); }
  else if (mod && k === 'y') { ev.preventDefault(); ripeti(); }
  else if (mod && k === 'c') { if (B.sel.size) { ev.preventDefault(); copia(); } }
  else if (mod && k === 'v') { if (B.clip) { ev.preventDefault(); incolla(); } }
  else if (mod && k === 'd') { ev.preventDefault(); copia(); incolla(); }
  else if (mod && k === 'a') { ev.preventDefault(); B.sel = new Set([...B.bb.comps.map(c => c.id), ...B.bb.wires.map(w => w.id)]); disegnaSelezione(); }
  else if (mod || ev.altKey) return;
  else if (k === 'r') {
    ev.preventDefault();
    if (B.posa) { B.posaRot = ((B.posaRot || 0) + 1) % 4; sagomaPosa(); }                 // prima di posarlo
    else if (B.drag && (B.drag.kind === 'comp' || B.drag.kind === 'muovi')) { ruotaInPlace(B.sel); B.drag.mosso = true; disegnaComponenti(); const sel = B.bb.comps.filter(c => B.sel.has(c.id)); if (sel.length) messaggioStato(controllaAggancio(sel).join(' · ')); }   // mentre lo si sposta: un solo passo da annullare
    else ruotaSel();
  }
  else if (k === 'm') { ev.preventDefault(); iniziaMuovi(false); }
  else if (k === 'c') { ev.preventDefault(); iniziaMuovi(true); }
  else if (k === 'w') { ev.preventDefault(); if (B.hover && terminale(B.hover) && !B.filo) { impostaModo('filo'); iniziaFilo(B.hover); } else impostaModo('filo'); }
  else if (k === 'f') { ev.preventDefault(); adatta(); }
  else if (k === 'delete' || k === 'backspace') {
    if (B.filo) { ev.preventDefault(); if (B.filo.pts.length > 1) { B.filo.pts.pop(); disegnaFiloInCorso(); } else annullaComando(); }
    else if (B.sel.size) { ev.preventDefault(); elimina(); }
  }
  else if (k === 'escape') { if (annullaComando()) ev.preventDefault(); }
  else if (k === '?' || (ev.shiftKey && k === "'")) { ev.preventDefault(); $('#bb-aiuto').showModal(); }
}
function aggiornaBottoni() {
  const sel = B.sel.size > 0;
  $('#bb-elimina').disabled = !sel; $('#bb-copia').disabled = !sel; $('#bb-ruota').disabled = !sel;
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
    box.innerHTML = w ? `<span class="muted small">Filo: trascina un estremo per spostarlo, trascina il filo per piegarlo, doppio clic su un angolo per toglierlo · colore dalla tavolozza · R ruota · Canc elimina</span>`
      : `<span class="muted small">${B.bb.comps.length ? 'Clic su un componente per le sue proprietà · clic su un foro e clic sull\'arrivo = filo · rotella = zoom, Maiusc+trascina = sposta la vista · R ruota, M sposta, C copia, Canc elimina · ? = tutti i comandi' : 'Trascina un componente dalla palette a sinistra, o carica un esempio (Esempi…). Clic su un foro e clic sull\'arrivo per un filo. ? = tutti i comandi.'}</span>`;
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
  if (K.STRUMENTI.includes(c.type)) h += ' <button type="button" class="small" data-pannello>Pannello…</button> <span class="muted small">(anche con doppio clic sullo strumento)</span>';
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
  const pn = box.querySelector('[data-pannello]'); if (pn) pn.addEventListener('click', () => apriPannello(c.id));
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
// Avvio: barra degli strumenti del banco, palette a sinistra, finestra delle scorciatoie
const IC = {   // icone SVG locali (24×24, tratto = colore del testo)
  sel: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
  filo: '<path d="M4 18h6V6h10"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="6" r="2"/>',
  ruota: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  elimina: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/>',
  copia: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  incolla: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M9 11h6M9 15h4"/>',
  annulla: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  ripeti: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  piu: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M11 8v6M8 11h6"/>',
  meno: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M8 11h6"/>',
  adatta: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  png: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 8"/>',
  grande: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  aiuto: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5M12 17h.01"/>',
};
const ic = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
const CATEGORIE = [
  ['Base', ['res', 'pot', 'cap', 'jumper']],
  ['LED e display', ['led', 'seg7', 'seg7x3', 'diode']],
  ['Transistor', ['npn', 'pnp']],
  ['Ingressi', ['button', 'encoder']],
  ['Uscite', ['buzzer', 'servo', 'motor']],
  ['Strumenti', ['dmm', 'scope', 'gen', 'psu']],
];
const NOME_CORTO = { res: 'Resistore', pot: 'Potenziometro', cap: 'Condensatore', jumper: 'Ponticello', led: 'LED', seg7: 'Display 1 cifra', seg7x3: 'Display 3 cifre',
  diode: 'Diodo', npn: 'NPN BC107', pnp: 'PNP BC212', button: 'Pulsante', encoder: 'Encoder KY-040', buzzer: 'Buzzer', servo: 'Servo SG90', motor: 'Motore DC', dmm: 'Multimetro', scope: 'Oscilloscopio', gen: 'Generatore', psu: 'Alimentatore' };
function iconaComp(tipo) {
  const c = { id: 'ico', type: tipo, x: 0, y: 0, rot: 0, opt: Object.fromEntries(K.OPZIONI[tipo].map(([k, v]) => [k, v])) };
  return `<svg viewBox="0 0 10 10" data-icona="${tipo}"><g>${compSVG(c)}</g></svg>`;
}
function palette() {
  const box = $('#palette');
  if (!box) return;
  box.innerHTML = `<div class="pal-cerca"><input id="pal-cerca" type="search" placeholder="Cerca componente…" aria-label="Cerca componente"></div>` +
    CATEGORIE.map(([cat, tipi]) => `<div class="pal-cat" data-cat="${esc(cat)}"><h4>${esc(cat)}</h4><div class="pal-griglia">${tipi.map(t =>
      `<button type="button" class="pal-voce" data-tipo="${t}" title="${esc(K.TIPI[t].nome)} — trascinalo sulla breadboard, o clicca e poi clicca dove posarlo">${iconaComp(t)}<span>${esc(NOME_CORTO[t])}</span></button>`).join('')}</div></div>`).join('') +
    `<p class="pal-vuoto muted small" hidden>Nessun componente con questo nome.</p>`;
  // viewBox delle icone dalla forma vera
  box.querySelectorAll('svg[data-icona]').forEach(s => { try { const b = s.firstChild.getBBox(), m = 3; s.setAttribute('viewBox', `${b.x - m} ${b.y - m} ${b.width + 2 * m} ${b.height + 2 * m}`); } catch {} });
  $('#pal-cerca').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    let n = 0;
    box.querySelectorAll('.pal-voce').forEach(v => { const t = v.dataset.tipo, ok = !q || (NOME_CORTO[t] + ' ' + K.TIPI[t].nome).toLowerCase().includes(q); v.hidden = !ok; n += ok; });
    box.querySelectorAll('.pal-cat').forEach(c => { c.hidden = ![...c.querySelectorAll('.pal-voce')].some(v => !v.hidden); });
    box.querySelector('.pal-vuoto').hidden = n > 0;
  });
  // clic: si posa con un clic sul banco; trascinare: si lascia sul banco
  box.querySelectorAll('.pal-voce').forEach(v => {
    v.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      const t = v.dataset.tipo, x0 = ev.clientX, y0 = ev.clientY;
      let trascina = false;
      const muovi = e => {
        if (!trascina && Math.hypot(e.clientX - x0, e.clientY - y0) > 6) { trascina = true; scegli(t); }
        // sopra il disegno l'evento ci arriva da solo; fuori (palette) lo si inoltra, senza farlo risalire
        if (trascina && !(e.target.closest && e.target.closest('#bb-svg'))) $('#bb-svg').dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY }));
      };
      const su = e => {
        document.removeEventListener('pointermove', muovi); document.removeEventListener('pointerup', su);
        if (!trascina) { scegli(t); return; }
        const r = $('#bb-svg').getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          const svg = $('#bb-svg'), pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
          const q = pt.matrixTransform(svg.getScreenCTM().inverse()), g = griglia([q.x / P, q.y / P]);
          const rot = B.posaRot || 0; annullaComando(); aggiungi(t, g[0], g[1], rot);
        } else annullaComando();
      };
      document.addEventListener('pointermove', muovi); document.addEventListener('pointerup', su);
    });
  });
}
function scegli(t) {
  annullaComando();
  if (B.filo) return;
  B.posa = t; B.posaRot = 0; $('#bb-svg').classList.add('posa');
  document.querySelectorAll('.pal-voce').forEach(x => x.classList.toggle('on', x.dataset.tipo === t));
  sagomaPosa();
  messaggioStato(`${K.TIPI[t].nome}: clicca sulla breadboard dove posarlo · R ruota · Esc annulla`);
}
// sagoma del componente da posare (con la rotazione scelta) e aggancio dei suoi piedini
function sagomaPosa() {
  const t = B.posa;
  if (!t) return;
  $('#bb-ghost').innerHTML = `<g opacity=".65" transform="rotate(${(B.posaRot || 0) * 90})">${compSVG({ id: 'ghost', type: t, opt: Object.fromEntries(K.OPZIONI[t].map(([k, d]) => [k, d])) })}</g>`;
  if (!B.hover) return;
  const finto = { id: '_posa', type: t, x: B.hover[0], y: B.hover[1], rot: B.posaRot || 0, opt: Object.fromEntries(K.OPZIONI[t].map(([k, v]) => [k, v])) };
  messaggioStato(controllaAggancio([finto]).join(' · ') || 'Clicca per posarlo · R ruota · Esc annulla');
}
function monta() {
  const pane = $('#pane-breadboard');
  const b = (id, icona, titolo, testo = '') => `<button id="${id}" type="button" title="${esc(titolo)}">${ic(icona)}${testo ? `<span>${testo}</span>` : ''}</button>`;
  pane.innerHTML = `
    <div class="bb-barra">
      <div class="bb-strumento">${b('bb-t-sel', 'sel', 'Seleziona e sposta (Esc)')}${b('bb-t-filo', 'filo', 'Filo: clic su un foro, clic sull\'arrivo (W)')}</div>
      <div class="bb-strumento">${b('bb-ruota', 'ruota', 'Ruota di 90° (R)')}${b('bb-elimina', 'elimina', 'Elimina (Canc)')}${b('bb-copia', 'copia', 'Copia (⌘/Ctrl+C; C = copia e sposta)')}${b('bb-incolla', 'incolla', 'Incolla (⌘/Ctrl+V)')}</div>
      <div class="bb-strumento">${b('bb-annulla', 'annulla', 'Annulla (⌘/Ctrl+Z)')}${b('bb-ripeti', 'ripeti', 'Ripeti (⌘/Ctrl+Y)')}</div>
      <div class="bb-strumento">${b('bb-zin', 'piu', 'Zoom avanti (rotella)')}${b('bb-zout', 'meno', 'Zoom indietro (rotella)')}${b('bb-adatta', 'adatta', 'Adatta alla finestra (F)')}</div>
      <span id="bb-colori" class="bb-colori" title="Colore del filo selezionato"></span>
      <select id="bb-esempio" title="Circuiti pronti"><option value="">Esempi…</option><option value="15k">Cronometro 3 cifre (Prog_3digit, R11 = 15k come montato)</option><option value="1k5">Cronometro 3 cifre (R11 = 1,5k corretto)</option></select>
      <span class="tabs-sp"></span>
      <div class="bb-strumento">${b('bb-png', 'png', 'Scarica l\'immagine del montaggio (per le relazioni)', 'PNG')}${b('bb-svuota', 'elimina', 'Togli tutto', 'Svuota')}</div>
      <div class="bb-strumento">${b('bb-aiuto-btn', 'aiuto', 'Scorciatoie e guida (?)')}${b('bb-grande', 'grande', 'Banco a tutto schermo')}</div>
    </div>
    <div id="bb-prop" class="bb-prop"></div>
    <div class="bb-wrap"><svg id="bb-svg" tabindex="0" xmlns="${NS}">
      <defs><filter id="bb-blur" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="4"/></filter>
        <pattern id="bb-punti" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r=".8" fill="var(--banco-punto)"/></pattern></defs>
      <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#bb-punti)"/>
      <g id="bb-static">${disegnoStatico()}</g><g id="bb-comps"></g><g id="bb-wires"></g><g id="bb-prob"></g><g id="bb-nodo"></g><g id="bb-sel"></g><g id="bb-sel-aggancio"></g><g id="bb-ghost"></g>
    </svg></div>
    <div id="bb-problemi" class="bb-problemi small" hidden></div>
    <div id="bb-stato" class="bb-stato small mono"></div>
    <dialog id="bb-aiuto" class="scorciatoie">
      <form method="dialog">
        <h2>Banco di lavoro: comandi</h2>
        <table>
          <tr><td>Componente</td><td>Trascinalo dalla palette, o cliccalo e poi clicca sulla breadboard. Verde = si aggancia, rosso = fuori dai fori o occupato, arancione = due piedini sulla stessa fila.</td></tr>
          <tr><td>Filo</td><td>Clic su un foro o un pin, clic sull'arrivo: si fa da solo a 90°, rosso per 5V/3V3, nero per GND. Clic fuori dai fori o <kbd>Alt</kbd>+clic su un foro = angolo. Si può anche tirare tenendo premuto.</td></tr>
          <tr><td>Modificare un filo</td><td>Trascina un estremo per spostarlo, trascina il filo per piegarlo, doppio clic su un angolo per toglierlo, colore dalla tavolozza.</td></tr>
          <tr><td><kbd>W</kbd></td><td>filo (dal punto sotto il mouse, se è un foro)</td></tr>
          <tr><td><kbd>R</kbd></td><td>ruota la selezione di 90° (componenti, ponticelli e fili)</td></tr>
          <tr><td><kbd>M</kbd> / <kbd>C</kbd></td><td>sposta / copia la selezione: muovi il mouse e clicca</td></tr>
          <tr><td><kbd>Canc</kbd> o <kbd>⌫</kbd></td><td>elimina (durante un filo: toglie l'ultimo angolo)</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>annulla il comando in corso, poi toglie la selezione</td></tr>
          <tr><td><kbd>F</kbd></td><td>adatta tutto alla finestra</td></tr>
          <tr><td><kbd>V</kbd></td><td>cambia la vista al centro: Breadboard → Schema → Scheda e dispositivi (anche dai pulsanti in alto sul banco)</td></tr>
          <tr><td><kbd>B</kbd> (tenuto)</td><td>preme B1 sulla scheda, come prima</td></tr>
          <tr><td><kbd>R</kbd> mentre posi o sposti</td><td>ruota il componente prima di lasciarlo</td></tr>
          <tr><td>rotella</td><td>zoom sul puntatore (sulla manopola di encoder e potenziometro: la gira)</td></tr>
          <tr><td>rotella premuta o <kbd>Maiusc</kbd>+trascina</td><td>sposta la vista</td></tr>
          <tr><td>trascina sul vuoto</td><td>rettangolo di selezione (<kbd>⌘/Ctrl</kbd>+clic aggiunge o toglie)</td></tr>
          <tr><td><kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Y</kbd></td><td>annulla / ripeti</td></tr>
          <tr><td><kbd>⌘/Ctrl</kbd>+<kbd>C</kbd> <kbd>V</kbd> <kbd>D</kbd> <kbd>A</kbd></td><td>copia, incolla, duplica, seleziona tutto</td></tr>
        </table>
        <div class="right"><button type="button" id="bb-rivedi-tour" class="ghost">Rivedi la guida</button> <button class="primary">Ho capito</button></div>
      </form>
    </dialog>`;
  wire();
  palette();
  const btn = (id, fn) => $(id).addEventListener('click', () => { fn(); });
  btn('#bb-t-sel', () => { annullaComando(); impostaModo('sel'); });
  btn('#bb-t-filo', () => impostaModo(B.modo === 'filo' ? 'sel' : 'filo'));
  btn('#bb-ruota', ruotaSel); btn('#bb-elimina', elimina); btn('#bb-copia', copia); btn('#bb-incolla', () => incolla());
  btn('#bb-annulla', annulla); btn('#bb-ripeti', ripeti);
  btn('#bb-zin', () => zoom(1 / 1.25)); btn('#bb-zout', () => zoom(1.25)); btn('#bb-adatta', adatta);
  btn('#bb-png', esportaPNG);
  btn('#bb-aiuto-btn', () => $('#bb-aiuto').showModal());
  btn('#bb-rivedi-tour', () => { $('#bb-aiuto').close(); if (window.SVlayout) SVlayout.tour(); });
  btn('#bb-grande', () => { $('#pane-breadboard').classList.toggle('bb-grande'); setTimeout(adatta, 30); });
  $('#bb-esempio').addEventListener('change', e => {
    const v = e.target.value; e.target.value = '';
    if (!v) return;
    if (B.bb.comps.length && !confirm('Sostituisco il circuito della breadboard con l\'esempio? (Puoi tornare indietro con Annulla.)')) return;
    modifica(bb => { const x = K.esempioCronometro(v === '1k5' ? 1500 : 15000); bb.comps = x.comps; bb.wires = x.wires; });
    B.sel.clear(); disegnaSelezione();
  });
  btn('#bb-svuota', () => { if (B.bb.comps.length + B.bb.wires.length && confirm('Tolgo tutti i componenti e i fili? (Puoi tornare indietro con Annulla.)')) { modifica(bb => { bb.comps = []; bb.wires = []; }); B.sel.clear(); disegnaSelezione(); } });
  $('#bb-colori').innerHTML = K.COLORI_FILO.map(c => `<button class="bbcol" data-col="${c}" style="background:${c}" title="Colore del filo selezionato"></button>`).join('');
  $('#bb-colori').addEventListener('click', e => {
    const c = e.target.dataset && e.target.dataset.col;
    if (!c) return;
    B.colore = c;
    if ([...B.sel].some(id => B.bb.wires.some(w => w.id === id))) modifica(bb => { for (const w of bb.wires) if (B.sel.has(w.id)) w.col = c; });
    aggiornaBottoni();
  });
  impostaModo('sel');
  applicaVista();
  disegnaComponenti();
}
monta();
// per le prove (strumenti/prova-breadboard-browser.mjs) e per la console
Object.assign(B, { apriPannello, chiudiPannello, tracciaOsc, letturaDMM, lettura: letturaDisplay, premi, scatto, esportaPNG, impostaPot, modifica, K, ruotaSel, percorso, coloreAuto, impostaModo, annullaComando, controllaAggancio, seleziona: ids => { B.sel = new Set(ids); disegnaSelezione(); } });
