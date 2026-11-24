// circuito.js — la breadboard come circuito elettrico: forma della breadboard e della Nucleo,
// componenti e loro piedini, netlist (nodi) e solutore in continua (analisi nodale).
// Non tocca la pagina: lo usano breadboard.js (nel sito) e strumenti/prova-breadboard.mjs (in Node).
//
// Coordinate: una unità = un passo da 2,54 mm (0,1"). La Nucleo sta a sinistra (0…30 × 0…44),
// la breadboard da 830 punti a destra (BX, BY). Un componente ha il piedino 0 in (x, y) e
// gli altri piedini spostati secondo il tipo e la rotazione (rot = 0…3, quarti di giro).
//
// Modello elettrico (pensato per il laboratorio, non per Spice):
//   pin STM32 in uscita = generatore 0/3,3 V con ~40 Ω interni; in ingresso = aperto, più il
//   pull-up/pull-down interno (40 kΩ); 3V3 e 5V = generatori con 0,1 Ω; GND = riferimento.
//   LED e diodi = diodo "a tratti" (spento finché V < Vsoglia, poi Vsoglia + Rd·I);
//   BJT = modello a regioni: interdizione, zona attiva (Ic = β·Ib), saturazione (Vce = Vce,sat).
//   Condensatori: aperti in continua; con il tempo, modello di Eulero all'indietro (C/dt).

export const VDD = 3.3;
export const R_PULL = 40000;        // pull-up / pull-down interni
export const I_PIN_MAX = 0.025;     // 25 mA per pin (valore massimo assoluto del datasheet)
export const BX = 34, BY = 12;      // angolo della breadboard

// ------------------------------------------------------------------
// Nucleo-F401RE: connettori Morpho (CN7, CN10) e Arduino (CN5, CN6, CN8, CN9)
const CN7 = ['PC10', 'PC11', 'PC12', 'PD2', 'VDD', 'E5V', 'BOOT0', 'GND', 'NC', 'NC', 'NC', 'IOREF', 'PA13', 'RESET', 'PA14', '+3V3', 'PA15', '+5V', 'GND', 'GND',
  'PB7', 'GND', 'PC13', 'VIN', 'PC14', 'NC', 'PC15', 'PA0', 'PH0', 'PA1', 'PH1', 'PA4', 'VBAT', 'PB0', 'PC2', 'PC1', 'PC3', 'PC0'];
const CN10 = ['PC9', 'PC8', 'PB8', 'PC6', 'PB9', 'PC5', 'AVDD', 'U5V', 'GND', 'NC', 'PA5', 'PA12', 'PA6', 'PA11', 'PA7', 'PB12', 'PB6', 'NC', 'PC7', 'GND',
  'PA9', 'PB2', 'PA8', 'PB1', 'PB10', 'PB15', 'PB4', 'PB14', 'PB5', 'PB13', 'PB3', 'AGND', 'PA10', 'PC4', 'PA2', 'NC', 'PA3', 'NC'];
// Arduino, dall'alto in basso come sono disegnati
const CN6 = [['NC', ''], ['IOREF', ''], ['RESET', ''], ['+3V3', '3V3'], ['+5V', '5V'], ['GND', ''], ['GND', ''], ['VIN', '']];
const CN8 = [['PA0', 'A0'], ['PA1', 'A1'], ['PA4', 'A2'], ['PB0', 'A3'], ['PC1', 'A4'], ['PC0', 'A5']];
const CN5 = [['PB8', 'D15'], ['PB9', 'D14'], ['AVDD', 'AVDD'], ['GND', 'GND'], ['PA5', 'D13'], ['PA6', 'D12'], ['PA7', 'D11'], ['PB6', 'D10'], ['PC7', 'D9'], ['PA9', 'D8']];
const CN9 = [['PA8', 'D7'], ['PB10', 'D6'], ['PB4', 'D5'], ['PB5', 'D4'], ['PB3', 'D3'], ['PA10', 'D2'], ['PA2', 'D1'], ['PA3', 'D0']];
export const NUCLEO = { x: 0, y: 0, w: 30, h: 44 };
// segnale del connettore → nodo elettrico (alimentazioni comprese)
function segnale(s) {
  if (/^P[A-H]\d+$/.test(s)) return s;
  if (s === '+3V3' || s === 'VDD' || s === 'AVDD' || s === 'IOREF' || s === 'VBAT') return '3V3';
  if (s === '+5V' || s === 'U5V') return '5V';
  if (s === 'GND' || s === 'AGND') return 'GND';
  return null;
}

// tutti i fori: "x,y" → { id, net, nome }
export const FORI = new Map();
const foro = (x, y, id, net, nome) => FORI.set(x + ',' + y, { x, y, id, net, nome });
(function () {
  CN7.forEach((s, i) => { const n = i + 1; foro(1 + (n % 2 === 0 ? 1 : 0), 12 + (n - 1 >> 1), 'CN7-' + n, segnale(s) || 'cn7-' + n, `CN7-${n} ${s}`); });
  CN10.forEach((s, i) => { const n = i + 1; foro(27 + (n % 2 === 0 ? 1 : 0), 12 + (n - 1 >> 1), 'CN10-' + n, segnale(s) || 'cn10-' + n, `CN10-${n} ${s}`); });
  CN6.forEach(([s, a], i) => foro(5, 14 + i, 'CN6-' + (i + 1), segnale(s) || 'cn6-' + (i + 1), `CN6 ${a || s}${a && a !== s ? ' (' + s + ')' : ''}`));
  CN8.forEach(([s, a], i) => foro(5, 23 + i, 'CN8-' + (i + 1), s, `CN8 ${a} (${s})`));
  CN5.forEach(([s, a], i) => foro(24, 10 + i, 'CN5-' + (10 - i), segnale(s) || s, `CN5 ${a}${a !== s ? ' (' + s + ')' : ''}`));
  CN9.forEach(([s, a], i) => foro(24, 21 + i, 'CN9-' + (8 - i), s, `CN9 ${a} (${s})`));
  // breadboard: 63 colonne, file a–e (in alto) e f–j (in basso), 4 binari da 50 fori (gruppi da 5)
  const righe = 'abcdefghij';
  for (let c = 1; c <= 63; c++) for (let r = 0; r < 10; r++) {
    const y = BY + (r < 5 ? 3 + r : 5 + r);
    foro(BX + 1 + c, y, righe[r] + c, `bb:${c}${r < 5 ? 'u' : 'd'}`, `${righe[r]}${c}`);
  }
  const binari = [['T+', 0, 'binario + in alto'], ['T-', 1, 'binario − in alto'], ['B+', 17, 'binario + in basso'], ['B-', 18, 'binario − in basso']];
  for (const [b, dy, nome] of binari) for (let k = 0; k < 50; k++) foro(BX + 4 + Math.floor(k / 5) * 6 + k % 5, BY + dy, b + (k + 1), 'bb:' + b, nome);
})();
export const BB = { x: BX, y: BY, w: 68, h: 19 };
// piedino Arduino di un pin (D13…), per i nomi
export const ARDUINO = Object.fromEntries([...CN8, ...CN5, ...CN9].filter(([s]) => /^P/.test(s)).map(([s, a]) => [s, a]));

// ------------------------------------------------------------------
// Componenti
export const TIPI = {
  res: { nome: 'Resistore', pref: 'R' },
  led: { nome: 'LED', pref: 'D' },
  button: { nome: 'Pulsante', pref: 'SW' },
  jumper: { nome: 'Ponticello', pref: 'J' },
  seg7: { nome: 'Display 1 cifra (5161AS/BS)', pref: 'U' },
  seg7x3: { nome: 'Display 3 cifre (5361AS/BS)', pref: 'U' },
  npn: { nome: 'Transistor NPN (BC107)', pref: 'Q' },
  pnp: { nome: 'Transistor PNP (BC212)', pref: 'Q' },
  pot: { nome: 'Potenziometro', pref: 'RV' },
  diode: { nome: 'Diodo (1N4148)', pref: 'D' },
  cap: { nome: 'Condensatore', pref: 'C' },
  buzzer: { nome: 'Buzzer attivo', pref: 'BZ' },
  encoder: { nome: 'Encoder KY-040', pref: 'ENC' },
  servo: { nome: 'Servo SG90', pref: 'M' },
  motor: { nome: 'Motore DC', pref: 'M' },
  // strumenti (tappa B, come in Multisim): si mettono sul banco e si collegano con i fili
  dmm: { nome: 'Multimetro', pref: 'XMM' },
  scope: { nome: 'Oscilloscopio', pref: 'XSC' },
  gen: { nome: 'Generatore di funzioni', pref: 'XFG' },
  psu: { nome: 'Alimentatore da banco', pref: 'PS' },
};
export const STRUMENTI = ['dmm', 'scope', 'gen', 'psu'];
// opzioni di ogni tipo: [nome, valore iniziale, min, max] (numeri) o [nome, iniziale, [valori]] (scelta)
export const OPZIONI = {
  res: [['r', 330, 1, 1e7], ['span', 4, 2, 10]],
  led: [['color', 'red', ['red', 'green', 'yellow', 'blue', 'white']]],
  button: [],
  jumper: [['span', 2, 1, 20]],
  seg7: [['anode', 0, [0, 1]]],
  seg7x3: [['anode', 1, [0, 1]]],
  npn: [['beta', 200, 10, 1000]],
  pnp: [['beta', 160, 10, 1000]],
  pot: [['r', 10000, 100, 1e7], ['pos', 0.5, 0, 1]],
  diode: [],
  cap: [['c', 1e-4, 1e-12, 1]],
  buzzer: [],
  encoder: [],
  servo: [],
  motor: [],
  dmm: [['modo', 'V', ['V', 'A', 'Ω']], ['ac', 0, [0, 1]]],
  scope: [['va', 1, [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]], ['vb', 1, [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]],
    ['sdiv', 0.001, [1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2, 0.5]],
    ['trig', 'A', ['A', 'B']], ['fronte', 1, [0, 1]], ['livello', 1.5, -20, 20], ['modoT', 'auto', ['auto', 'normale', 'singolo']],
    ['ya', 0, -10, 10], ['yb', -2, -10, 10]],
  gen: [['forma', 'sin', ['sin', 'quadra', 'tri']], ['f', 1000, 0.1, 20000], ['amp', 1, 0, 10], ['off', 0, -10, 10]],
  psu: [['v', 5, 0, 12], ['ilim', 0.5, 0.001, 3]],
};
export const GEN_R = 50;          // resistenza d'uscita del generatore (come quelli da banco)
export const GEN_FMAX = 20000;    // oltre la simulazione nel tempo non tiene il passo (vedi breadboard.js)
export const LED_COL = { red: ['#ff3b30', 1.8, 'rosso'], green: ['#2fd470', 2.0, 'verde'], yellow: ['#ffd60a', 1.9, 'giallo'], blue: ['#4c8dff', 2.8, 'blu'], white: ['#f5f5f5', 2.8, 'bianco'] };
// pinout dei display (numero del piedino → funzione), come nei datasheet
const P5161 = { 1: 'e', 2: 'd', 3: 'com', 4: 'c', 5: 'dp', 6: 'b', 7: 'a', 8: 'com', 9: 'f', 10: 'g' };
const P5361 = { 1: 'e', 2: 'd', 3: 'dp', 4: 'c', 5: 'g', 6: 'nc', 7: 'b', 8: 'd3', 9: 'd2', 10: 'f', 11: 'a', 12: 'd1' };
export const SEGS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];

// piedini a rot = 0: [nome, dx, dy]
export function piedini(c) {
  const o = c.opt || {};
  switch (c.type) {
    case 'res': case 'jumper': return [['1', 0, 0], ['2', o.span || (c.type === 'res' ? 4 : 2), 0]];
    case 'led': return [['A', 0, 0], ['K', 1, 0]];
    case 'diode': return [['A', 0, 0], ['K', 4, 0]];
    case 'cap': return [['1', 0, 0], ['2', 1, 0]];
    case 'button': return [['1', 0, 0], ['2', 2, 0]];
    case 'buzzer': return [['+', 0, 0], ['-', 2, 0]];
    case 'motor': return [['1', 0, 0], ['2', 3, 0]];
    case 'npn': case 'pnp': return [['E', 0, 0], ['B', 1, 0], ['C', 2, 0]];
    case 'pot': return [['1', 0, 0], ['W', 2, 0], ['3', 4, 0]];
    case 'encoder': return [['CLK', 0, 0], ['DT', 1, 0], ['SW', 2, 0], ['+', 3, 0], ['GND', 4, 0]];
    case 'servo': return [['GND', 0, 0], ['+', 1, 0], ['S', 2, 0]];
    case 'dmm': return [['COM', 0, 0], ['V', 3, 0], ['A', 6, 0]];
    case 'scope': return [['A', 0, 0], ['B', 4, 0], ['GND', 8, 0]];
    case 'gen': return [['+', 0, 0], ['COM', 3, 0]];
    case 'psu': return [['+', 0, 0], ['-', 3, 0]];
    case 'seg7': {   // file da 5, a 0,6": in basso 1…5 da sinistra, in alto 10…6
      const out = [];
      for (let i = 0; i < 5; i++) out.push([String(1 + i), i, 6], [String(10 - i), i, 0]);
      return out.sort((a, b) => a[0] - b[0]);
    }
    case 'seg7x3': { // file da 6, a 0,4": in basso 1…6, in alto 12…7
      const out = [];
      for (let i = 0; i < 6; i++) out.push([String(1 + i), i, 4], [String(12 - i), i, 0]);
      return out.sort((a, b) => a[0] - b[0]);
    }
  }
  return [];
}
export function funzionePiedino(c, nome) {
  if (c.type === 'seg7') return P5161[nome];
  if (c.type === 'seg7x3') return P5361[nome];
  return nome;
}
export const ruota = (dx, dy, rot) => [[dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx]][rot & 3];
// piedini con le coordinate vere
export function piediniXY(c) {
  return piedini(c).map(([n, dx, dy]) => { const [rx, ry] = ruota(dx, dy, c.rot || 0); return { n, x: c.x + rx, y: c.y + ry }; });
}

// ------------------------------------------------------------------
// Dati salvati (".breadboard.json"): si controlla tutto, arrivano anche da link di altri
export const MAX_COMP = 150, MAX_FILI = 400, MAX_PIEGHE = 16;
const num = (v, min, max, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def; };
const coord = v => Math.round(num(v, -20, 140, 0));
export const COLORI_FILO = ['#e53935', '#212121', '#1e88e5', '#43a047', '#fdd835', '#fb8c00', '#8e24aa', '#ffffff', '#795548', '#9e9e9e'];
export function pulisciBreadboard(d) {
  const out = { v: 1, comps: [], wires: [] };
  if (!d || typeof d !== 'object') return out;
  const ids = new Set();
  const id = (v, p) => { let s = typeof v === 'string' && /^\w{1,24}$/.test(v) && !ids.has(v) ? v : p + Math.random().toString(36).slice(2, 9); ids.add(s); return s; };
  for (const c of Array.isArray(d.comps) ? d.comps.slice(0, MAX_COMP) : []) {
    if (!c || !TIPI[c.type]) continue;
    const opt = {};
    for (const [k, def, a, b] of OPZIONI[c.type]) {
      const v = (c.opt || {})[k];
      if (Array.isArray(a)) opt[k] = a.includes(v) ? v : def;
      else opt[k] = num(v, a, b, def);
    }
    if (opt.span !== undefined) opt.span = Math.round(opt.span);
    out.comps.push({ id: id(c.id, 'c'), type: c.type, x: coord(c.x), y: coord(c.y), rot: Math.round(num(c.rot, 0, 3, 0)), opt,
      label: String(c.label ?? '').replace(/[^\w\-+.,µΩ ]/g, '').slice(0, 12) });
  }
  for (const w of Array.isArray(d.wires) ? d.wires.slice(0, MAX_FILI) : []) {
    if (!w || !Array.isArray(w.p) || w.p.length < 2) continue;
    const p = w.p.slice(0, MAX_PIEGHE + 2).map(q => [coord(q && q[0]), coord(q && q[1])]);
    out.wires.push({ id: id(w.id, 'w'), p, col: COLORI_FILO.includes(w.col) ? w.col : COLORI_FILO[3] });
  }
  // posizioni dei simboli nella vista schema (schema.js): { id: [x, y, rot] }, solo per componenti che ci sono
  // (più "nucleo" per il blocco della scheda); se mancano si dispongono da soli
  if (d.schema && typeof d.schema === 'object' && !Array.isArray(d.schema)) {
    const ok = new Set([...out.comps.map(c => c.id), 'nucleo']), sch = {};
    for (const [k, v] of Object.entries(d.schema).slice(0, MAX_COMP + 1)) {
      if (!ok.has(k) || !Array.isArray(v)) continue;
      sch[k] = [Math.round(num(v[0], -500, 1500, 0)), Math.round(num(v[1], -500, 1500, 0)), Math.round(num(v[2], 0, 3, 0))];
    }
    if (Object.keys(sch).length) out.schema = sch;
  }
  return out;
}
// "4k7" → 4700, "1,5k" → 1500, "100n" → 1e-7, "2M2" → 2.2e6
export function leggiValore(s) {
  const m = /^\s*(\d+(?:[.,]\d*)?)\s*([pnuµmkKM]?)(\d*)\s*(?:Ω|ohm|F)?\s*$/i.exec(String(s));
  if (!m) return NaN;
  const mult = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, '': 1 }[m[2]];
  const v = parseFloat(m[1].replace(',', '.') + (m[3] ? (m[1].includes('.') || m[1].includes(',') ? '' : '.') + m[3] : ''));
  return v * mult;
}
export function scriviValore(v, u = 'Ω') {
  const f = (x, s) => (Math.round(x * 100) / 100).toString().replace('.', ',') + s;
  if (u === 'F') return v >= 1e-3 ? f(v * 1e3, ' mF') : v >= 1e-6 ? f(v * 1e6, ' µF') : v >= 1e-9 ? f(v * 1e9, ' nF') : f(v * 1e12, ' pF');
  return v >= 1e6 ? f(v / 1e6, ' MΩ') : v >= 1e3 ? f(v / 1e3, ' kΩ') : f(v, ' Ω');
}

// ------------------------------------------------------------------
// Netlist: dai fori, dai binari, dai fili e dai ponticelli ai nodi elettrici
export const chiave = (x, y) => x + ',' + y;
export function netlist(bb) {
  const par = new Map();
  const find = k => { let r = k; while (par.get(r) !== r) r = par.get(r); let q = k; while (par.get(q) !== r) { const n = par.get(q); par.set(q, r); q = n; } return r; };
  const nodo = (x, y) => { const f = FORI.get(chiave(x, y)); const k = f ? f.net : 'p:' + chiave(x, y); if (!par.has(k)) par.set(k, k); return k; };
  const unisci = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) par.set(ra, rb); };
  for (const f of FORI.values()) if (!par.has(f.net)) par.set(f.net, f.net);
  for (const w of bb.wires) unisci(nodo(w.p[0][0], w.p[0][1]), nodo(w.p[w.p.length - 1][0], w.p[w.p.length - 1][1]));
  for (const c of bb.comps) {
    const pp = piediniXY(c).map(p => nodo(p.x, p.y));
    if (c.type === 'jumper') unisci(pp[0], pp[1]);
  }
  // radice → numero del nodo; nomi: alimentazione, pin STM32, se no N1, N2…
  const radici = new Map(), nodi = [];
  const numero = k => {
    const r = find(k);
    if (!radici.has(r)) { radici.set(r, nodi.length); nodi.push({ i: nodi.length, chiavi: [], pins: [], alim: [], nome: '' }); }
    return radici.get(r);
  };
  for (const k of par.keys()) {
    const n = nodi[numero(k)];
    n.chiavi.push(k);
    if (/^P[A-H]\d+$/.test(k)) n.pins.push(k);
    if (k === '3V3' || k === '5V' || k === 'GND') n.alim.push(k);
  }
  let libero = 1;
  for (const n of nodi) n.nome = n.alim.length ? n.alim.join('+') : n.pins.length ? n.pins.join('+') : '';
  const diNodo = (x, y) => numero(nodo(x, y));
  const comps = bb.comps.map(c => ({ c, pins: piediniXY(c).map(p => ({ ...p, f: funzionePiedino(c, p.n), nodo: diNodo(p.x, p.y) })) }));
  for (const cc of comps) for (const p of cc.pins) { const n = nodi[p.nodo]; if (!n.nome) n.nome = 'N' + libero++; }
  return { nodi, comps, nodoDi: (x, y) => { const f = FORI.get(chiave(x, y)); const k = f ? f.net : 'p:' + chiave(x, y); return par.has(k) ? numero(k) : -1; } };
}

// ------------------------------------------------------------------
// Elementi del circuito (dalla netlist) — il solutore lavora su questi
// stato esterno per la soluzione: { pins: { PA5: {mode, pull, od, level} }, premuti: Set(id), pos: {id: 0…1},
//   enc: {id: [clk, dt, sw]}, b1: bool }
export const MOD = {
  RPIN: 40,         // resistenza interna di un'uscita (circa, a 3,3 V)
  VBE: 0.65, RBE: 20, VCESAT: 0.1, RSAT: 2, VD: 0.65, RD: 1, GOFF: 1e-9, RSW: 0.05, RALIM: 0.1,
  LED_RD: 2, SEG_RD: 2, I_LED_MAX: 0.020, I_SEG_MAX: 0.025,
};
export function elementi(net) {
  const el = [];                     // { k: tipo, n: [nodi], ... , comp, part }
  const usati = new Set();
  const G = net.nodi.findIndex(n => n.alim.includes('GND'));
  for (const { c, pins } of net.comps) {
    const o = c.opt, N = f => (pins.find(p => p.f === f || p.n === f) || {}).nodo;
    const add = e => { e.comp = c; el.push(e); for (const n of e.n) usati.add(n); };
    switch (c.type) {
      case 'res': add({ k: 'R', n: [N('1'), N('2')], r: o.r }); break;
      case 'led': add({ k: 'D', n: [N('A'), N('K')], vth: LED_COL[o.color][1], rd: MOD.LED_RD, led: true, imax: MOD.I_LED_MAX }); break;
      case 'diode': add({ k: 'D', n: [N('A'), N('K')], vth: MOD.VD, rd: MOD.RD }); break;
      case 'cap': add({ k: 'C', n: [N('1'), N('2')], c: o.c }); break;
      case 'button': add({ k: 'SW', n: [N('1'), N('2')], sw: 'p' }); break;
      case 'buzzer': add({ k: 'R', n: [N('+'), N('-')], r: 120, buzz: true }); break;
      case 'motor': add({ k: 'R', n: [N('1'), N('2')], r: 15, motor: true }); break;
      case 'npn': case 'pnp': add({ k: 'Q', n: [N('E'), N('B'), N('C')], s: c.type === 'npn' ? 1 : -1, beta: o.beta }); break;
      case 'pot': {
        const r = o.r, a = Math.max(1, r * o.pos), b = Math.max(1, r * (1 - o.pos));
        add({ k: 'R', n: [N('1'), N('W')], r: a, pot: 'a' }); add({ k: 'R', n: [N('W'), N('3')], r: b, pot: 'b' });
        break;
      }
      case 'encoder':   // KY-040: 10 kΩ di pull-up su CLK, DT e SW verso +; i contatti chiudono verso GND
        for (const [i, f] of ['CLK', 'DT', 'SW'].entries()) { add({ k: 'R', n: [N(f), N('+')], r: 10000 }); add({ k: 'SW', n: [N(f), N('GND')], sw: 'e' + i }); }
        break;
      case 'servo': add({ k: 'R', n: [N('+'), N('GND')], r: 1000, servo: true }); add({ k: 'R', n: [N('S'), N('GND')], r: 1e6 }); break;
      // multimetro: voltmetro 10 MΩ tra V e COM; amperometro 0,1 Ω tra A e COM (in serie!); ohmmetro: misura a parte
      case 'dmm':
        if (o.modo === 'V') add({ k: 'R', n: [N('V'), N('COM')], r: 1e7, misura: 'v' });
        else if (o.modo === 'A') add({ k: 'R', n: [N('A'), N('COM')], r: 0.1, misura: 'i' });
        else { add({ k: 'R', n: [N('V'), N('COM')], r: 1e12, misura: 'o' }); }
        break;
      // oscilloscopio: ingressi da 1 MΩ verso la sua massa
      case 'scope': add({ k: 'R', n: [N('A'), N('GND')], r: 1e6, misura: 'a' }); add({ k: 'R', n: [N('B'), N('GND')], r: 1e6, misura: 'b' }); break;
      case 'gen': add({ k: 'GEN', n: [N('+'), N('COM')], o }); break;
      case 'psu': add({ k: 'PSU', n: [N('+'), N('-')], v: o.v, ilim: o.ilim }); break;
      case 'seg7': case 'seg7x3': {
        const ac = o.anode == 1, nd = c.type === 'seg7' ? 1 : 3;
        for (let d = 0; d < nd; d++) {
          const com = c.type === 'seg7' ? N('com') : N('d' + (d + 1));
          SEGS.forEach((s, j) => {
            const sn = N(s);
            if (sn === undefined || com === undefined) return;
            add({ k: 'D', n: ac ? [com, sn] : [sn, com], vth: LED_COL.red[1], rd: MOD.SEG_RD, led: true, imax: MOD.I_SEG_MAX, seg: d * 8 + j });
          });
        }
        break;
      }
    }
  }
  // sorgenti: alimentazioni (GND è il riferimento, non un elemento) e pin STM32 dei nodi usati
  for (const n of net.nodi) {
    if (!usati.has(n.i)) continue;
    if (n.alim.length > 1) continue;
    if (n.alim[0] === '3V3') el.push({ k: 'V', n: [n.i], v: VDD, r: MOD.RALIM, alim: '3V3' });
    if (n.alim[0] === '5V') el.push({ k: 'V', n: [n.i], v: 5, r: MOD.RALIM, alim: '5V' });
    for (const p of n.pins) {
      el.push({ k: 'P', n: [n.i], pin: p });
      // sulla Nucleo: LD2 (verde, 510 Ω verso GND) su PA5; B1 su PC13 con 4,7 kΩ di pull-up
      if (p === 'PA5') el.push({ k: 'D', n: [n.i, G], vth: LED_COL.green[1], rd: 510, interno: 'LD2' });
      if (p === 'PC13') { el.push({ k: 'V', n: [n.i], v: VDD, r: 4700, interno: 'B1' }); el.push({ k: 'SW', n: [n.i, G], sw: 'b1', interno: 'B1' }); }
    }
  }
  return { el, usati, G };
}

// ------------------------------------------------------------------
// Solutore: nodi → incognite (GND fuori), eliminazione di Gauss; diodi e BJT a tratti, iterando
// finché le regioni sono coerenti. pinState: (pin) → { mode, pull, od, level }.
// LU con pivot parziale (la stessa matrice si riusa per molti passi nel tempo)
function fattorizza(A0, n) {
  const A = Float64Array.from(A0), perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  for (let i = 0; i < n; i++) {
    let p = i, m = Math.abs(A[i * n + i]);
    for (let r = i + 1; r < n; r++) { const v = Math.abs(A[r * n + i]); if (v > m) { m = v; p = r; } }
    if (m < 1e-30) A[i * n + i] = 1e-12;
    if (p !== i) { for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[p * n + c]; A[p * n + c] = t; } const t = perm[i]; perm[i] = perm[p]; perm[p] = t; }
    const d = A[i * n + i];
    for (let r = i + 1; r < n; r++) {
      const f = A[r * n + i] / d;
      A[r * n + i] = f;
      if (!f) continue;
      for (let c = i + 1; c < n; c++) A[r * n + c] -= f * A[i * n + c];
    }
  }
  return { A, perm };
}
function sostituisci({ A, perm }, b, n) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[perm[i]]; for (let c = 0; c < i; c++) s -= A[i * n + c] * y[c]; y[i] = s; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let c = i + 1; c < n; c++) s -= A[i * n + c] * x[c]; x[i] = s / A[i * n + i]; }
  return x;
}
// tensione del generatore di funzioni al tempo t (s)
export function valoreGen(o, t) {
  const ph = ((t * o.f) % 1 + 1) % 1;
  const w = o.forma === 'quadra' ? (ph < 0.5 ? 1 : -1) : o.forma === 'tri' ? (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph) : Math.sin(2 * Math.PI * ph);
  return o.off + o.amp * w;
}

// modello di un pin: [V, R] di un generatore verso massa, o null (aperto)
export function modelloPin(ps) {
  if (!ps) return null;
  if (ps.mode === 1 || (ps.mode === 2 && ps.af)) {
    if (ps.od) return ps.level ? (ps.pull === 1 ? [VDD, R_PULL] : null) : [0, MOD.RPIN];
    return [ps.level ? VDD : 0, MOD.RPIN];
  }
  if (ps.mode === 0 || ps.mode === 2) return ps.pull === 1 ? [VDD, R_PULL] : ps.pull === 2 ? [0, R_PULL] : null;
  return null;
}

// circ = { el, G, nodi }; st = stato esterno; prev = regioni di partenza (Map el → stato); cap = { el → [Vprev, dt] }
export function risolvi(circ, st, prev, capDt) {
  const nn = circ.nodi.length, G = circ.G;
  const idx = new Int32Array(nn).fill(-1);
  let n = 0;
  const usati = circ.usati;
  for (let i = 0; i < nn; i++) if (i !== G && usati.has(i)) idx[i] = n++;
  const I = i => (i === undefined || i < 0 || i === G ? -1 : idx[i]);
  const reg = new Map();
  for (const e of circ.el) if (e.k === 'D' || e.k === 'Q' || e.k === 'PSU') reg.set(e, prev && prev.has(e) ? prev.get(e) : 0);
  const spento = !!st.spento;   // ohmmetro: tutte le sorgenti spente
  const pinMod = new Map();
  for (const e of circ.el) if (e.k === 'P') pinMod.set(e, modelloPin(st.pins[e.pin]));
  const chiuso = e => e.sw === 'p' ? st.premuti.has(e.comp.id) : e.sw === 'b1' ? !!st.b1 : e.sw[0] === 'e' ? !!((st.enc[e.comp.id] || [])[+e.sw[1]]) : false;
  let V = new Float64Array(nn), giri = 0;
  // fattorizzazioni LU già fatte per questa matrice (cambia solo con regioni, pin, interruttori e passo):
  // nel tempo, a ogni passo cambiano solo i termini noti (generatore, condensatori) → basta la sostituzione
  const lu = circ._lu || (circ._lu = new Map());
  for (; giri < 60; giri++) {
    const A = new Float64Array(n * n), b = new Float64Array(n);
    let chiaveA = '';
    const g2 = (a, c, g) => { a = I(a); c = I(c); if (a >= 0) A[a * n + a] += g; if (c >= 0) A[c * n + c] += g; if (a >= 0 && c >= 0) { A[a * n + c] -= g; A[c * n + a] -= g; } };
    const fonte = (a, c, i) => { a = I(a); c = I(c); if (a >= 0) b[a] -= i; if (c >= 0) b[c] += i; };   // corrente i da a verso c
    const vsrc = (a, c, v, r) => { g2(a, c, 1 / r); fonte(a, c, -v / r); };                           // a−c = v + r·i
    const vccs = (x, y, a, c, gm, v0) => {   // corrente da x verso y = gm·(Va − Vc − v0)
      x = I(x); y = I(y); a = I(a); c = I(c);
      for (const [r, s] of [[x, 1], [y, -1]]) { if (r < 0) continue; if (a >= 0) A[r * n + a] += s * gm; if (c >= 0) A[r * n + c] -= s * gm; b[r] += s * gm * v0; }
    };
    for (let i = 0; i < n; i++) A[i * n + i] += 1e-9;   // gmin: niente nodi "sospesi"
    for (const e of circ.el) {
      switch (e.k) {
        case 'R': g2(e.n[0], e.n[1], 1 / e.r); break;
        case 'SW': if (e.n[0] !== undefined && e.n[1] !== undefined) { const c = chiuso(e); chiaveA += c ? 1 : 0; g2(e.n[0], e.n[1], c ? 1 / MOD.RSW : MOD.GOFF); } break;
        case 'V': if (spento) break; vsrc(e.n[0], G, e.v, e.r); break;
        case 'P': { const m = spento ? null : pinMod.get(e); chiaveA += m ? m[1] : '-'; if (m) vsrc(e.n[0], G, m[0], m[1]); break; }
        case 'C': { const cd = capDt && capDt.get(e); chiaveA += cd ? cd[1] : '-'; if (cd) vsrc(e.n[0], e.n[1], cd[0], cd[1] / e.c); else g2(e.n[0], e.n[1], MOD.GOFF); break; }
        case 'D': chiaveA += reg.get(e); if (reg.get(e)) vsrc(e.n[0], e.n[1], e.vth, e.rd); else g2(e.n[0], e.n[1], MOD.GOFF); break;
        case 'GEN': if (spento) break; vsrc(e.n[0], e.n[1], valoreGen(e.o, st.t || 0), GEN_R); break;
        case 'PSU': {
          if (spento) break;
          const r = reg.get(e); chiaveA += 'p' + r;
          if (r === 0) vsrc(e.n[0], e.n[1], e.v, MOD.RALIM);
          else { fonte(e.n[1], e.n[0], e.ilim); g2(e.n[0], e.n[1], 1e-6); }   // limite di corrente: esce ilim dal +
          break;
        }
        case 'IT': fonte(e.n[0], e.n[1], e.i); break;   // corrente di prova dell'ohmmetro
        case 'Q': {
          const [E, B, C] = e.n, s = e.s, r = reg.get(e);
          const [ba, bk] = s > 0 ? [B, E] : [E, B], [cx, cy] = s > 0 ? [C, E] : [E, C];
          chiaveA += 'q' + r;
          if (r === 0) { g2(B, E, MOD.GOFF); g2(C, E, MOD.GOFF); break; }
          vsrc(ba, bk, MOD.VBE, MOD.RBE);
          if (r === 1) { vccs(cx, cy, ba, bk, e.beta / MOD.RBE, MOD.VBE); g2(C, E, 1e-7); }
          else vsrc(cx, cy, MOD.VCESAT, MOD.RSAT);
          break;
        }
      }
    }
    let f = lu.get(chiaveA);
    if (!f) { f = fattorizza(A, n); if (lu.size > 64) lu.clear(); lu.set(chiaveA, f); }
    const x = sostituisci(f, b, n);
    V = new Float64Array(nn);
    for (let i = 0; i < nn; i++) if (idx[i] >= 0) V[i] = x[idx[i]];
    const v = i => (i === undefined || i < 0 || i === G ? 0 : V[i]);
    // regioni coerenti?
    const cambi = [];
    for (const e of circ.el) {
      if (e.k === 'D') {
        const vd = v(e.n[0]) - v(e.n[1]), on = reg.get(e);
        if (on && (vd - e.vth) / e.rd < -1e-9) cambi.push([e, 0]);
        else if (!on && vd > e.vth + 1e-6) cambi.push([e, 1]);
      } else if (e.k === 'PSU' && !spento) {
        const r = reg.get(e), vu = v(e.n[0]) - v(e.n[1]);
        if (r === 0 && (e.v - vu) / MOD.RALIM > e.ilim) cambi.push([e, 1]);
        else if (r === 1 && vu > e.v) cambi.push([e, 0]);
      } else if (e.k === 'Q') {
        const [E, B, C] = e.n, s = e.s, r = reg.get(e);
        const vbe = s * (v(B) - v(E)), vce = s * (v(C) - v(E)), ib = (vbe - MOD.VBE) / MOD.RBE;
        if (r === 0) { if (vbe > MOD.VBE + 1e-6) cambi.push([e, vce < MOD.VCESAT ? 2 : 1]); }
        else if (ib < -1e-9) cambi.push([e, 0]);
        else if (r === 1 && vce < MOD.VCESAT - 1e-6) cambi.push([e, 2]);
        else if (r === 2) { const ic = (vce - MOD.VCESAT) / MOD.RSAT; if (ic > e.beta * ib + 1e-9) cambi.push([e, 1]); }
      }
    }
    if (!cambi.length) break;
    // all'inizio si cambiano tutti, poi uno alla volta (così non si oscilla)
    for (const [e, r] of giri < 20 ? cambi : cambi.slice(0, 1)) reg.set(e, r);
  }
  return analizza(circ, st, V, reg, pinMod, chiuso, capDt, giri);
}

// correnti e controlli dopo la soluzione
function analizza(circ, st, V, reg, pinMod, chiuso, capDt, giri) {
  const G = circ.G, v = i => (i === undefined || i < 0 || i === G ? 0 : V[i]);
  const out = { V, reg, giri, led: new Map(), pin: {}, alim: {}, q: new Map(), comp: new Map(), cap: new Map() };
  const add = (c, k, val) => { const m = out.comp.get(c.id) || {}; m[k] = (m[k] || 0) + val; out.comp.set(c.id, m); };
  for (const e of circ.el) {
    switch (e.k) {
      case 'D': { const i = reg.get(e) ? (v(e.n[0]) - v(e.n[1]) - e.vth) / e.rd : 0; out.led.set(e, i); if (e.comp) add(e.comp, e.seg !== undefined ? 's' + e.seg : 'i', i); if (e.interno === 'LD2') out.ld2 = i; break; }
      case 'R': { const i = (v(e.n[0]) - v(e.n[1])) / e.r;
        if (e.misura) { const vv = v(e.n[0]) - v(e.n[1]); if (e.misura === 'v') { add(e.comp, 'v', vv); add(e.comp, 'v2', vv * vv); } else if (e.misura === 'i') { add(e.comp, 'i', i); add(e.comp, 'i2', i * i); } else if (e.misura === 'a' || e.misura === 'b') add(e.comp, e.misura, vv); break; }
        if (e.comp) { add(e.comp, e.pot ? 'i' + e.pot : 'i', i); if (e.buzz || e.motor) add(e.comp, 'v', v(e.n[0]) - v(e.n[1])); if (e.servo) add(e.comp, 'vcc', v(e.n[0]) - v(e.n[1])); } break; }
      case 'P': { const m = pinMod.get(e); out.pin[e.pin] = { i: m ? (m[0] - v(e.n[0])) / m[1] : 0, v: v(e.n[0]), drive: !!m && m[1] === MOD.RPIN }; break; }
      case 'V': if (e.alim) out.alim[e.alim] = (out.alim[e.alim] || 0) + (e.v - v(e.n[0])) / e.r; break;
      case 'Q': {
        const [E, B, C] = e.n, s = e.s, r = reg.get(e);
        const vbe = s * (v(B) - v(E)), vce = s * (v(C) - v(E)), ib = r ? (vbe - MOD.VBE) / MOD.RBE : 0;
        const ic = r === 1 ? e.beta * ib : r === 2 ? (vce - MOD.VCESAT) / MOD.RSAT : 0;
        out.q.set(e.comp.id, { r, ib, ic, vbe, vce });
        break;
      }
      case 'C': { const cd = capDt && capDt.get(e); const vc = v(e.n[0]) - v(e.n[1]); out.cap.set(e, vc); if (e.comp) add(e.comp, 'vc', vc); if (cd) add(e.comp, 'i', (vc - cd[0]) * e.c / cd[1]); break; }
      case 'SW': if (e.comp && e.comp.type === 'button') add(e.comp, 'chiuso', chiuso(e) ? 1 : 0); break;
      case 'GEN': add(e.comp, 'v', v(e.n[0]) - v(e.n[1])); break;
      case 'PSU': { const vu = v(e.n[0]) - v(e.n[1]), i = reg.get(e) === 0 ? (e.v - vu) / MOD.RALIM : e.ilim; add(e.comp, 'v', vu); add(e.comp, 'i', i); add(e.comp, 'cc', reg.get(e) === 1 ? 1 : 0); break; }
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Controlli "come in laboratorio" su una soluzione. Ritorna [{ cod, chiave, pins, comp, testo }]
export function controlli(circ, net, st, res) {
  const out = [];
  const fmt = i => (Math.abs(i) * 1000).toFixed(1).replace('.', ',') + ' mA';
  const nomePin = p => p + (ARDUINO[p] ? ` (${ARDUINO[p]})` : '');
  for (const [p, x] of Object.entries(res.pin)) {
    if (Math.abs(x.i) > I_PIN_MAX) out.push({ cod: 'ipin', chiave: p, pins: [p], testo: `${nomePin(p)}: ${x.i > 0 ? 'esce' : 'entra'} una corrente di ${fmt(x.i)}, oltre il massimo di 25 mA per pin. Metti una resistenza (o un transistor) tra il pin e il carico.` });
  }
  // uscite in conflitto nello stesso nodo
  for (const n of net.nodi) {
    if (n.pins.length < 2) continue;
    const out1 = n.pins.filter(p => { const m = modelloPin(st.pins[p]); return m && m[1] === MOD.RPIN; });
    const liv = new Set(out1.map(p => st.pins[p].level));
    if (liv.size > 1) out.push({ cod: 'conflitto', chiave: out1.join('+'), pins: out1, testo: `Uscite in conflitto: ${out1.map(nomePin).join(' e ')} sono collegate insieme e una dà 1, l'altra 0 (cortocircuito tra i due pin).` });
    if (n.alim.length && out1.length) out.push({ cod: 'pinalim', chiave: out1.join('+') + n.alim[0], pins: out1, testo: `${out1.map(nomePin).join(', ')} in uscita è collegato direttamente a ${n.alim[0]}.` });
  }
  for (const [e, i] of res.led) {
    if (!e.led || i <= e.imax) continue;
    const c = e.comp, seg = e.seg !== undefined ? ` segmento ${SEGS[e.seg % 8].toUpperCase()}${c.type === 'seg7x3' ? ' cifra ' + (1 + (e.seg >> 3)) : ''}` : '';
    out.push({ cod: 'iled', chiave: c.id + ':' + (e.seg ?? ''), comp: c.id, pins: [], testo: `${c.label || 'LED'}${seg}: passano ${fmt(i)}, oltre il massimo di ${fmt(e.imax)}${i > 0.05 ? ' — manca la resistenza in serie?' : '.'}` });
  }
  return out;
}

// corti tra alimentazioni (si vedono già dalla netlist, prima di risolvere)
export function corti(net) {
  const out = [];
  for (const n of net.nodi) if (n.alim.length > 1) out.push({ cod: 'corto', chiave: n.alim.join('+'), pins: [], alim: n.alim, testo: `Cortocircuito: ${n.alim.join(' e ')} sono collegati insieme. Sulla scheda vera l'alimentazione si spegne (o si brucia qualcosa): togli il filo che li unisce.` });
  return out;
}

// ingresso flottante: il nodo del pin non arriva a nessuna sorgente passando per elementi che conducono
export function flottanti(circ, net, st, res) {
  const out = [];
  const adj = new Map(), lega = (a, b) => { if (a === undefined || b === undefined || a < 0 || b < 0) return; (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  const fonti = new Set([circ.G]);
  const chiusoSW = e => e.sw === 'p' ? st.premuti.has(e.comp.id) : e.sw === 'b1' ? !!st.b1 : e.sw[0] === 'e' ? !!((st.enc[e.comp.id] || [])[+e.sw[1]]) : false;
  for (const e of circ.el) {
    if (e.k === 'R') lega(e.n[0], e.n[1]);
    else if (e.k === 'SW' && chiusoSW(e)) lega(e.n[0], e.n[1]);
    else if (e.k === 'D' && res.reg.get(e)) lega(e.n[0], e.n[1]);
    else if (e.k === 'Q' && res.reg.get(e)) { lega(e.n[0], e.n[1]); lega(e.n[0], e.n[2]); }
    else if (e.k === 'V') fonti.add(e.n[0]);
    else if (e.k === 'P') { const m = modelloPin(st.pins[e.pin]); if (m && m[1] === MOD.RPIN) fonti.add(e.n[0]); }
  }
  for (const e of circ.el) {
    if (e.k !== 'P') continue;
    const ps = st.pins[e.pin];
    if (!ps || ps.mode !== 0 || ps.pull) continue;
    if (e.pin === 'PC13') continue;   // sulla Nucleo ha già il suo pull-up
    const visto = new Set([e.n[0]]), coda = [e.n[0]];
    let ok = false;
    while (coda.length && !ok) { const a = coda.pop(); if (fonti.has(a)) ok = true; for (const b of adj.get(a) || []) if (!visto.has(b)) { visto.add(b); coda.push(b); } }
    if (!ok) out.push({ cod: 'flott', chiave: e.pin, pins: [e.pin], testo: `${e.pin}${ARDUINO[e.pin] ? ' (' + ARDUINO[e.pin] + ')' : ''} è un ingresso flottante: non è collegato a niente che gli dia un livello (pulsante aperto senza resistenza?). Metti una resistenza di pull-up/pull-down o attiva quella interna in CubeMX.` });
  }
  return out;
}

// ohmmetro del multimetro: tutte le sorgenti spente (come a circuito scollegato), 1 mA iniettato tra V e COM.
// Ritorna i ohm, Infinity se il circuito è aperto (OL), null se il multimetro non è in Ω.
export function misuraOhm(circ, comp) {
  const m = circ.el.find(e => e.comp && e.comp.id === comp.id && e.misura === 'o');
  if (!m || m.n[0] === undefined || m.n[1] === undefined) return m ? Infinity : null;
  const c2 = { ...circ, el: [...circ.el, { k: 'IT', n: [m.n[1], m.n[0]], i: 1e-3 }], _lu: new Map() };
  const r = risolvi(c2, { pins: {}, premuti: new Set(), enc: {}, b1: false, spento: true }, null, null);
  const vv = (m.n[0] === circ.G ? 0 : r.V[m.n[0]]) - (m.n[1] === circ.G ? 0 : r.V[m.n[1]]);
  const R = vv / 1e-3;
  return R > 4e7 ? Infinity : Math.max(0, R);
}

// livello logico letto da un ingresso: 1 sopra 0,7·VDD, 0 sotto 0,3·VDD, null in mezzo (incerto)
export const livello = vv => vv >= 0.7 * VDD ? 1 : vv <= 0.3 * VDD ? 0 : null;

// ------------------------------------------------------------------
// Circuito d'esempio: il cronometro a 3 cifre di Prog_3digit (display 5361BS ad anodo comune,
// anodi con NPN BC107 + PNP BC212, R base 47k / 15k, segmenti con 330 Ω verso i pin).
// rB = resistenza tra collettore dell'NPN e base del PNP (R11–R13).
export function esempioCronometro(rB = 15000) {
  const comps = [], wires = [];
  let n = 0;
  const C = (type, x, y, opt = {}, label = '', rot = 0) => comps.push({ id: 'e' + (n++), type, x, y, rot, opt: { ...Object.fromEntries(OPZIONI[type].map(([k, d]) => [k, d])), ...opt }, label });
  const W = (col, ...p) => wires.push({ id: 'w' + (n++), p, col });
  const X = c => BX + 1 + c, Y = r => BY + ('abcdefghij'.indexOf(r) < 5 ? 3 + 'abcdefghij'.indexOf(r) : 5 + 'abcdefghij'.indexOf(r));
  // foro del binario più vicino alla colonna c
  const bin = (b, c) => { let best = null; for (let k = 0; k < 50; k++) { const x = BX + 4 + Math.floor(k / 5) * 6 + k % 5; if (!best || Math.abs(x - X(c)) < Math.abs(best[0] - X(c))) best = [x, BY + ({ 'T+': 0, 'T-': 1, 'B+': 17, 'B-': 18 })[b]]; } return best; };
  const pin = s => { for (const f of FORI.values()) if (/^CN(7|10)-/.test(f.id) && f.nome.split(' ')[1] === s) return [f.x, f.y]; return null; };
  const [ROSSO, NERO, BLU, VERDE, GIALLO, ARANCIO, VIOLA, BIANCO, MARRONE, GRIGIO] = COLORI_FILO;
  // fili ordinati: dal connettore si esce di lato, si scende sotto la Nucleo (una corsia per filo),
  // si va a destra sotto la breadboard e si sale al foro
  let corsia = 0, uscitaCN10 = 0;
  const NW = (col, nome, dest) => {
    const a = pin(nome), y = NUCLEO.h + 2 + corsia++;
    const x = a[0] <= 2 ? -2 - corsia : NUCLEO.w - 1 + uscitaCN10++;
    W(col, a, [x, a[1]], [x, y], [dest[0], y], dest);
  };
  // alimentazioni: dal CN7 si esce a sinistra e si passa sopra la Nucleo fino ai binari in alto
  const AW = (col, nome, dest, k) => { const a = pin(nome); W(col, a, [-2 - k, a[1]], [-2 - k, -2 - k], [dest[0], -2 - k], dest); };
  AW(ROSSO, '+5V', [BX + 4, BY], 0);
  AW(NERO, 'GND', [BX + 5, BY + 1], 1);
  // display a cavallo del canale: piedini 12…7 sulla fila d, 1…6 sulla fila f (colonne 36…41)
  const DX = 36, colPin = num => num <= 6 ? DX + num - 1 : DX + 12 - num;
  C('seg7x3', X(DX), Y('d'), { anode: 1 }, 'U1');
  const DIG = ['PA8', 'PA9', 'PB10'];
  for (let d = 0; d < 3; d++) {
    const c0 = 2 + d * 10;
    // NPN (E-B-C) sulla fila e, colonne c0…c0+2; emettitore a GND
    C('npn', X(c0), Y('e'), {}, 'Q' + (1 + 2 * d));
    W(NERO, [X(c0), Y('a')], bin('T-', c0));
    // R base 47k in verticale a cavallo del canale: base (sopra) ↔ colonna c0+1 sotto, dove arriva D1/D2/D3
    C('res', X(c0 + 1), Y('c'), { r: 47000, span: 7 }, 'R' + (1 + d), 1);
    NW(GRIGIO, DIG[d], [X(c0 + 1), Y('j')]);
    // PNP (E-B-C) sulla fila e, colonne c0+5…c0+7; emettitore a +5V; R11 dal collettore NPN alla base PNP
    C('pnp', X(c0 + 5), Y('e'), {}, 'Q' + (2 + 2 * d));
    W(ROSSO, [X(c0 + 5), Y('a')], bin('T+', c0 + 5));
    C('res', X(c0 + 2), Y('c'), { r: rB, span: 4 }, 'R' + (11 + d));
    // collettore PNP → anodo della cifra (piedini 12, 9, 8)
    W(ARANCIO, [X(c0 + 7), Y('b')], [X(colPin([12, 9, 8][d])), Y('a')]);
  }
  // segmenti: dal piedino un filo alla colonna k, 330 Ω in verticale a cavallo del canale, sotto il filo dal pin
  const SEGPIN = { a: 'PC3', b: 'PC1', c: 'PA4', d: 'PA1', e: 'PA0', f: 'PC2', g: 'PC0', dp: 'PB4' };
  const COL = [BLU, VERDE, VIOLA, MARRONE, GIALLO, BLU, VERDE, VIOLA];
  SEGS.forEach((s, j) => {
    const num = +Object.keys(P5361).find(k => P5361[k] === s), k = 44 + 2 * j;
    W(GIALLO, [X(colPin(num)), num >= 7 ? Y('a') : Y('j')], [X(k), num >= 7 ? Y('a') : Y('b')]);
    C('res', X(k), Y('c'), { r: 330, span: 7 }, 'R' + (21 + j), 1);
    NW(COL[j], SEGPIN[s], [X(k), Y('j')]);
  });
  // PULS su PB0 verso 3V3 (nel .ioc ha il pull-down interno: premuto = 1)
  C('button', X(60), Y('h'), {}, 'SW1');
  NW(BIANCO, 'PB0', [X(62), Y('j')]);
  W(ROSSO, [X(60), Y('j')], bin('B+', 60));
  NW(ROSSO, '+3V3', bin('B+', 63));
  return pulisciBreadboard({ comps, wires });
}
