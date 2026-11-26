// schema.js — vista "Schema" (tappa C, come in Multisim): lo stesso circuito della breadboard in simboli
// IEC (europei, come a scuola), sempre sincronizzato. I simboli si dispongono da soli dalla netlist
// (Nucleo a sinistra, poi i componenti per distanza dai pin) e si possono spostare e ruotare a mano:
// le posizioni stanno nel file della breadboard ("schema"), quindi si salvano, si sincronizzano e
// viaggiano nei link. GND, 5V e 3V3 si disegnano con il loro simbolo vicino a ogni piedino (niente fili
// lunghi); gli altri nodi con fili a 90° (albero minimo tra i piedini). Esportabile in PNG.
// Punto K (25/11/2026, come Multisim): i simboli di massa e alimentazione si spostano (resta il filo al
// piedino), i fili si spostano e si piegano trascinandone un tratto e si colorano (colori della breadboard o
// scelti a mano: "schemaFili" e "schemaColori" nel file della breadboard); dalla palette si mettono componenti
// anche qui (sul banco vanno in un posto libero, fuori dai fori) e con lo strumento Filo (W) si collegano i
// piedini: ogni filo dello schema diventa un filo vero sulla breadboard, così il circuito si può fare tutto da qui.
// Usa BB e BB.K (breadboard.js / circuito.js), esc di app.js.
const B = window.BB, K = B.K;
const U = 10;                          // pixel per unità di griglia
const NS = 'http://www.w3.org/2000/svg';
const $ = s => document.querySelector(s);
const SC = { vista: { x: -4, y: -6, w: 120, h: 70 }, sel: null, selFilo: null, drag: null, sporco: true, fatto: false, modo: 'sel', filoDa: null, tmp: {} };

// ------------------------------------------------------------------
// Simboli: piedini [funzione, dx, dy] (unità) e disegno (px), a rotazione 0
const L = (x1, y1, x2, y2, w = 1.6) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>`;
const freccia = (x1, y1, x2, y2) => { const a = Math.atan2(y2 - y1, x2 - x1), h = 4; return L(x1, y1, x2, y2, 1.2) + `<path d="M${x2} ${y2} L${x2 - h * Math.cos(a - .5)} ${y2 - h * Math.sin(a - .5)} L${x2 - h * Math.cos(a + .5)} ${y2 - h * Math.sin(a + .5)} Z" fill="currentColor"/>`; };
const T = (x, y, t, a = 'middle', fs = 7) => `<text x="${x}" y="${y}" font-size="${fs}" text-anchor="${a}" fill="currentColor" stroke="none" font-family="ui-monospace, Menlo, monospace">${esc(t)}</text>`;
const scatola = (w, h, nome, sx, dx, passo = 2) => {   // blocco con piedini a sinistra (sx) e a destra (dx)
  const H = Math.max(sx.length, dx.length) * passo + 2;
  let s = `<rect x="${-w / 2 * U}" y="${-U}" width="${w * U}" height="${H * U}" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.6"/>` + T(0, -U - 4, nome, 'middle', 8);
  const y = i => i * passo + 1;
  sx.forEach(([f, t], i) => { s += L(-w / 2 * U - U, y(i) * U, -w / 2 * U, y(i) * U) + T(-w / 2 * U + 3, y(i) * U + 2.5, t, 'start'); });
  dx.forEach(([f, t], i) => { s += L(w / 2 * U, y(i) * U, w / 2 * U + U, y(i) * U) + T(w / 2 * U - 3, y(i) * U + 2.5, t, 'end'); });
  return { pins: [...sx.map(([f], i) => [f, -w / 2 - 1, y(i)]), ...dx.map(([f], i) => [f, w / 2 + 1, y(i)])], svg: s, scritte: true };
};
function simbolo(c) {
  const o = c.opt || {};
  switch (c.type) {
    case 'res': case 'jumper':
      if (c.type === 'jumper') return { pins: [['1', -1, 0], ['2', 1, 0]], svg: L(-U, 0, U, 0) };
      return { pins: [['1', -2, 0], ['2', 2, 0]], svg: L(-2 * U, 0, -12, 0) + L(12, 0, 2 * U, 0) + `<rect x="-12" y="-4.5" width="24" height="9" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.6"/>` };
    case 'pot': return { pins: [['1', -2, 0], ['3', 2, 0], ['W', 0, -2]], svg: L(-2 * U, 0, -12, 0) + L(12, 0, 2 * U, 0) + `<rect x="-12" y="-4.5" width="24" height="9" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.6"/>` + freccia(0, -2 * U, 0, -6) };
    case 'cap': return { pins: [['1', -2, 0], ['2', 2, 0]], svg: L(-2 * U, 0, -3, 0) + L(3, 0, 2 * U, 0) + L(-3, -8, -3, 8, 2.2) + L(3, -8, 3, 8, 2.2) + (o.c >= 1e-6 ? T(-8, -6, '+') : '') };
    case 'led': case 'diode': {
      let s = L(-2 * U, 0, -6, 0) + L(6, 0, 2 * U, 0) + `<path d="M-6 -7 L-6 7 L6 0 Z" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>` + L(6, -7, 6, 7, 1.8);
      if (c.type === 'led') s += freccia(0, -8, 7, -15) + freccia(4, -6, 11, -13);
      return { pins: [['A', -2, 0], ['K', 2, 0]], svg: s };
    }
    case 'button': return { pins: [['1', -2, 0], ['2', 2, 0]], svg: L(-2 * U, 0, -8, 0) + L(8, 0, 2 * U, 0) + L(-8, 0, 7, -6) + `<circle cx="-8" cy="0" r="1.6" fill="currentColor"/><circle cx="8" cy="0" r="1.6" fill="currentColor"/>` + L(0, -3, 0, -9, 1.2) + L(-4, -9, 4, -9, 1.2) };
    case 'npn': case 'pnp': {
      let s = `<circle cx="4" cy="0" r="11" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.4"/>` + L(-2 * U, 0, -1, 0) + L(-1, -7, -1, 7, 2.2) + L(-1, -3, 10, -2 * U + 2) + L(10, -2 * U + 2, 10, -2 * U) ;
      s += c.type === 'npn' ? freccia(-1, 3, 10, 2 * U - 2) + L(10, 2 * U - 2, 10, 2 * U) : freccia(10, 2 * U - 2, 0, 4) + L(-1, 3, 10, 2 * U - 2) + L(10, 2 * U - 2, 10, 2 * U);
      return { pins: [['B', -2, 0], ['C', 1, -2], ['E', 1, 2]], svg: s };
    }
    case 'buzzer': return { pins: [['+', -2, 0], ['-', 2, 0]], svg: L(-2 * U, 0, -8, 0) + L(8, 0, 2 * U, 0) + `<path d="M-8 -6 L8 -6 L8 4 A8 8 0 0 1 -8 4 Z" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.5"/>` + T(-12, -6, '+') };
    case 'motor': return { pins: [['1', -2, 0], ['2', 2, 0]], svg: L(-2 * U, 0, -9, 0) + L(9, 0, 2 * U, 0) + `<circle r="9" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.6"/>` + T(0, 3.5, 'M', 'middle', 10) };
    case 'servo': return scatola(5, 6, 'SERVO', [['GND', 'GND'], ['+', '+'], ['S', 'S']], []);
    case 'encoder': return scatola(5, 10, 'KY-040', [['CLK', 'CLK'], ['DT', 'DT'], ['SW', 'SW'], ['+', '+'], ['GND', 'GND']], []);
    // dispositivi I2C/SPI e sensori (punto L): blocchi con i piedini del modulo, l'indirizzo I2C nel nome
    case 'lcd16x2': case 'oled': case 'lm75': case 'mpu6050': case 'eeprom': case 'eeprom256': {
      const nome = { lcd16x2: 'LCD 16x2', oled: 'SSD1306', lm75: 'LM75', mpu6050: 'MPU6050', eeprom: '24C02', eeprom256: '24LC256' }[c.type];
      return scatola(6, 8, `${nome} 0x${(o.addr || 0).toString(16).toUpperCase()}`, [['SDA', 'SDA'], ['SCL', 'SCL']], [['VCC', 'VCC'], ['GND', 'GND']]);
    }
    case 'oledspi': return scatola(6, 14, 'SSD1306 SPI', [['D0', 'SCK'], ['D1', 'MOSI'], ['CS', 'CS'], ['DC', 'DC'], ['RES', 'RES']], [['VCC', 'VCC'], ['GND', 'GND']]);
    case 'hcsr04': return scatola(6, 8, 'HC-SR04', [['Trig', 'TRIG'], ['Echo', 'ECHO']], [['VCC', 'VCC'], ['GND', 'GND']]);
    case 'seg7': return scatola(6, 18, `${o.anode == 1 ? 'AC' : 'CC'} 5161`, K.SEGS.map(s => [s, s.toUpperCase()]), [['com', o.anode == 1 ? 'COM+' : 'COM−']]);
    case 'seg7x3': return scatola(6, 18, `${o.anode == 1 ? 'AC' : 'CC'} 5361`, K.SEGS.map(s => [s, s.toUpperCase()]), [['d1', 'DIG1'], ['d2', 'DIG2'], ['d3', 'DIG3']]);
    case 'dmm': return { pins: [['V', -2, 0], ['COM', 2, 0], ...(o.modo === 'A' ? [['A', 0, -2]] : [])], svg: L(-2 * U, 0, -10, 0) + L(10, 0, 2 * U, 0) + `<circle r="10" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.6"/>` + T(0, 4, o.modo === 'Ω' ? 'Ω' : o.modo, 'middle', 11) + (o.modo === 'A' ? L(0, -2 * U, 0, -10) : '') };
    case 'scope': return scatola(6, 6, 'OSC', [['A', 'A'], ['B', 'B'], ['GND', '⏚']], []);
    case 'gen': return { pins: [['+', 0, -3], ['COM', 0, 3]], svg: L(0, -3 * U, 0, -10) + L(0, 10, 0, 3 * U) + `<circle r="10" fill="var(--sch-fondo)" stroke="currentColor" stroke-width="1.6"/>` + `<path d="M-6 0 C-3 -7 0 -7 0 0 C0 7 3 7 6 0" fill="none" stroke="currentColor" stroke-width="1.4"/>` + T(5, -14, '+', 'start') };
    case 'psu': return { pins: [['+', 0, -3], ['-', 0, 3]], svg: L(0, -3 * U, 0, -4) + L(0, 4, 0, 3 * U) + L(-10, -4, 10, -4, 2) + L(-5, 4, 5, 4, 3.4) + T(8, -10, '+', 'start') + T(12, 3, `${o.v} V`, 'start') };
  }
  return { pins: [], svg: '' };
}
// blocco della Nucleo: solo i pin usati dal circuito
function simboloNucleo(pins) {
  const r = scatola(10, 0, 'NUCLEO-F401RE', [], pins.map(p => [p, p + (K.ARDUINO[p] ? ' ' + K.ARDUINO[p] : '')]), 5);
  return r;
}
const ruota = (x, y, r) => [[x, y], [-y, x], [-x, -y], [y, -x]][r & 3];

// ------------------------------------------------------------------
// Dalla netlist: simboli, posizioni (automatiche se mancano), fili
function costruisci() {
  const net = K.netlist(B.bb), nodi = net.nodi;
  const usati = new Set(net.comps.flatMap(cc => cc.pins.map(p => p.nodo)));
  const pinsMcu = [...new Set(nodi.filter(n => usati.has(n.i)).flatMap(n => n.pins))].sort();
  const items = [];
  const nuc = simboloNucleo(pinsMcu);
  items.push({ id: 'nucleo', sym: nuc, fun: p => p, label: '' });
  for (const cc of net.comps) if (!K.tavola(cc.c)) items.push({ id: cc.c.id, c: cc.c, sym: simbolo(cc.c), cc, label: cc.c.label || '' });
  // nodo di ogni piedino del simbolo
  const nodoDi = (it, f) => {
    if (it.id === 'nucleo') { const n = nodi.find(n => n.pins.includes(f)); return n ? n.i : -1; }
    const p = it.cc.pins.find(p => p.f === f || p.n === f);
    return p ? p.nodo : -1;
  };
  // disposizione automatica: colonne per distanza (in nodi) dai pin della scheda
  const sch = B.bb.schema || {};
  const pos = {};
  const alim = n => nodi[n] && nodi[n].alim.length > 0;
  const livello = new Map([['nucleo', 0]]);
  let fronte = new Set(nodi.filter(n => n.pins.length).map(n => n.i)), lv = 1, resto = items.filter(it => it.id !== 'nucleo');
  while (resto.length && lv < 12) {
    const qui = resto.filter(it => it.sym.pins.some(([f]) => fronte.has(nodoDi(it, f))));
    if (!qui.length) break;
    qui.forEach(it => livello.set(it.id, lv));
    resto = resto.filter(it => !qui.includes(it));
    fronte = new Set(qui.flatMap(it => it.sym.pins.map(([f]) => nodoDi(it, f)).filter(n => n >= 0 && !alim(n))));
    lv++;
  }
  resto.forEach(it => livello.set(it.id, lv));
  pos.nucleo = sch.nucleo || [0, 0, 0];
  const yPin = {}, xPin = {};   // y e x dei piedini già messi, per nodo (baricentro)
  const segna = it => { for (const [f, dx, dy] of it.sym.pins) { const n = nodoDi(it, f), [rx, ry] = ruota(dx, dy, pos[it.id][2]); if (n >= 0) { (yPin[n] = yPin[n] || []).push(pos[it.id][1] + ry); (xPin[n] = xPin[n] || []).push(pos[it.id][0] + rx); } } };
  // verso migliore: il piedino che va verso la colonna di prima sta a sinistra (rotazione 0 o 2)
  const verso = (it, x) => {
    let best = 0, bc = Infinity;
    for (const r of it.sym.scritte ? [0] : [0, 2]) {   // i blocchi con le scritte non si capovolgono (testo al rovescio)
      let c = 0;
      for (const [f, dx, dy] of it.sym.pins) { const n = nodoDi(it, f), xs = xPin[n]; if (!xs || alim(n)) continue; const [rx] = ruota(dx, dy, r); c += Math.abs(x + rx - xs.reduce((a, b) => a + b, 0) / xs.length); }
      if (c < bc - 1e-9) { bc = c; best = r; }
    }
    return best;
  };
  segna(items[0]);
  const colonne = new Map();
  for (const it of items.slice(1)) { const l = livello.get(it.id); (colonne.get(l) || colonne.set(l, []).get(l)).push(it); }
  for (const [l, col] of [...colonne.entries()].sort((a, b) => a[0] - b[0])) {
    const media = it => { const ys = it.sym.pins.flatMap(([f]) => yPin[nodoDi(it, f)] || []); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 1e9; };
    col.sort((a, b) => media(a) - media(b));
    let y = 0;
    for (const it of col) {
      const hs = it.sym.pins.map(p => p[2]), h0 = Math.min(0, ...hs), h1 = Math.max(0, ...hs);
      const yv = Math.max(y - h0, Math.round(media(it) < 1e9 ? media(it) : y - h0));
      const x = 16 + (l - 1) * 22;
      pos[it.id] = sch[it.id] || [x, yv, verso(it, x)];
      if (!sch[it.id]) y = yv + h1 + 5; else y = Math.max(y, pos[it.id][1] + h1 + 5);
      segna(it);
    }
  }
  // terminali di ogni nodo (posizione assoluta)
  const term = new Map();
  for (const it of items) for (const [f, dx, dy] of it.sym.pins) {
    const n = nodoDi(it, f);
    if (n < 0) continue;
    const [rx, ry] = ruota(dx, dy, pos[it.id][2]);
    (term.get(n) || term.set(n, []).get(n)).push({ x: pos[it.id][0] + rx, y: pos[it.id][1] + ry, it, f });
  }
  return { items, pos, term, nodi, net, nodoDi };
}
// percorso a 90° tra due terminali dello stesso nodo che non tocchi terminali o fili di altri nodi
// (se no sembrerebbero collegati): si prova a L nei due versi, poi a Z con il tratto in mezzo spostato
let tratti = [];   // [p, q, nodo] dei fili già messi
function instrada(a, b, n, term, nodi) {
  const A = [a.x, a.y], Bp = [b.x, b.y];
  const altri = [];
  for (const [m, ts] of term) if (m !== n && !nodi[m].alim.length) for (const t of ts) altri.push([t.x, t.y]);
  const su = (p, q, r) => (p[0] === q[0] && r[0] === p[0] && r[1] >= Math.min(p[1], q[1]) && r[1] <= Math.max(p[1], q[1])) || (p[1] === q[1] && r[1] === p[1] && r[0] >= Math.min(p[0], q[0]) && r[0] <= Math.max(p[0], q[0]));
  const sovrapposti = (p, q, r, t) => {   // due tratti sulla stessa retta che si sovrappongono
    if (p[0] === q[0] && r[0] === t[0] && p[0] === r[0]) return Math.min(Math.max(p[1], q[1]), Math.max(r[1], t[1])) > Math.max(Math.min(p[1], q[1]), Math.min(r[1], t[1]));
    if (p[1] === q[1] && r[1] === t[1] && p[1] === r[1]) return Math.min(Math.max(p[0], q[0]), Math.max(r[0], t[0])) > Math.max(Math.min(p[0], q[0]), Math.min(r[0], t[0]));
    return false;
  };
  const costo = pts => {
    let c = 0;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      c += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
      for (const r of altri) if (su(p, q, r)) c += 1000;
      for (const [r, t, m] of tratti) if (m !== n) { if (sovrapposti(p, q, r, t)) c += 500; if (su(p, q, r) || su(p, q, t)) c += 300; }
    }
    for (const r of pts.slice(1, -1)) for (const [x, y, m] of tratti) if (m !== n && (su(x, y, r))) c += 300;
    return c + pts.length * 2;
  };
  const cand = [[A, [Bp[0], A[1]], Bp], [A, [A[0], Bp[1]], Bp]];
  for (let d = 1; d <= 10; d++) for (const k of [d, -d]) {
    const mx = Math.round((A[0] + Bp[0]) / 2) + k, my = Math.round((A[1] + Bp[1]) / 2) + k;
    cand.push([A, [mx, A[1]], [mx, Bp[1]], Bp], [A, [A[0], my], [Bp[0], my], Bp]);
  }
  let best = null, bc = Infinity;
  for (const c of cand) { const pts = c.filter((p, i) => i === 0 || p[0] !== c[i - 1][0] || p[1] !== c[i - 1][1]); const v = costo(pts); if (v < bc) { bc = v; best = pts; } }
  return best;
}
// fili di un nodo: albero minimo (distanza "a 90°") tra i terminali, ogni lato a L
function fili(ts) {
  const out = [], dentro = [ts[0]], fuori = ts.slice(1);
  while (fuori.length) {
    let best = null;
    for (const a of dentro) for (const b of fuori) { const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y); if (!best || d < best.d) best = { a, b, d }; }
    out.push([best.a, best.b]);
    dentro.push(best.b); fuori.splice(fuori.indexOf(best.b), 1);
  }
  return out;
}

// ------------------------------------------------------------------
// Disegno
function disegna() {
  const svg = $('#sch-svg');
  if (!svg) return;
  SC.sporco = false;
  const { items, pos, term, nodi, net } = costruisci();
  SC.ultimo = { items, pos, term, nodi, net };
  const sch = B.bb.schema || {}, sf = B.bb.schemaFili || {};
  // colore di un nodo sulla breadboard (il primo filo che ci arriva), per "colori della breadboard"
  const colNodo = new Map();
  if (B.bb.schemaColori) for (const w of B.bb.wires) for (const q of [w.p[0], w.p[w.p.length - 1]]) { const n = net.nodoDi(q[0], q[1]); if (n >= 0 && !colNodo.has(n)) colNodo.set(n, w.col); }
  const tinta = c => c && c !== K.COLORI_FILO[1] && c !== K.COLORI_FILO[7] ? ` style="stroke:${c}"` : '';   // nero e bianco: il colore del tratto (si vede sui due temi)
  SC.fili = new Map();
  let s = '';
  // fili prima dei simboli
  const giunzioni = new Map();
  tratti = [];
  for (const [n, ts] of term) {
    const nd = nodi[n];
    if (nd.alim.length) {
      // simbolo di alimentazione vicino a ogni piedino
      // (si sposta trascinandolo: resta collegato al piedino con un filo a 90°; doppio clic lo riporta lì)
      for (const t of ts) {
        const gnd = nd.alim.includes('GND'), kg = 'g:' + t.it.id + ':' + t.f;
        const P = SC.tmp[kg] || sch[kg] || [t.x, t.y + (gnd ? 1 : -1)], x = P[0] * U, y = P[1] * U;
        const gambo = (t.x === P[0] || t.y === P[1] ? [[t.x, t.y], P] : [[t.x, t.y], [P[0], t.y], P]).map(q => q[0] * U + ',' + q[1] * U).join(' ');
        const sel = SC.sel === kg ? ' sch-sel' : '', col = tinta(colNodo.get(n));
        s += `<polyline class="sch-gambo" points="${gambo}"${col}/>`;
        if (gnd) s += `<g class="sch-alim${sel}" data-sch="${kg}"><rect class="presa" x="${x - 9}" y="${y - 4}" width="18" height="13" fill="transparent"/>${L(x - 7, y, x + 7, y, 2)}${L(x - 4.5, y + 3, x + 4.5, y + 3)}${L(x - 2, y + 6, x + 2, y + 6)}</g>`;
        else s += `<g class="sch-alim alto${sel}" data-sch="${kg}"><rect class="presa" x="${x - 9}" y="${y - 24}" width="18" height="26" fill="transparent"/><path d="M${x - 5} ${y} L${x + 5} ${y} L${x} ${y - 7} Z" fill="currentColor"/>${T(x, y - 10, nd.alim[0] === '5V' ? '+5V' : '+3V3')}</g>`;
      }
      continue;
    }
    if (ts.length < 2) { const t = ts[0]; s += `<circle cx="${t.x * U}" cy="${t.y * U}" r="2.4" fill="none" stroke="var(--sch-aperto)" stroke-width="1.2"><title>piedino non collegato</title></circle>`; continue; }
    for (let [a, b] of fili(ts)) {
      let k = chiaveFilo(a, b);
      if (k.inv) [a, b] = [b, a];
      k = k.k;
      const man = sf[k] || {}, pts = SC.tmp[k] || (man.p ? segui(man.p, a, b) : instrada(a, b, n, term, nodi));
      SC.fili.set(k, { pts, n });
      tratti.push(...pts.slice(1).map((q, i) => [pts[i], q, n]));
      s += `<polyline class="sch-filo${SC.selFilo === k ? ' sch-sel' : ''}" data-nodo="${n}" data-filo="${k}" points="${pts.map(q => q[0] * U + ',' + q[1] * U).join(' ')}"${tinta(man.col || colNodo.get(n))}/>`;
      for (const q of [a, b]) { const k = q.x + ',' + q.y; giunzioni.set(k, (giunzioni.get(k) || 0) + 1); }
    }
    // etichetta del nodo (pin STM32) vicino al primo terminale
    if (nd.pins.length) s += T(ts[0].x * U + 4, ts[0].y * U - 4, nd.pins[0], 'start', 6.5).replace('fill="currentColor"', 'fill="var(--sch-etichetta)"');
  }
  for (const [k, n] of giunzioni) if (n >= 2) { const [x, y] = k.split(',').map(Number); s += `<circle cx="${x * U}" cy="${y * U}" r="2.6" fill="currentColor"/>`; }
  for (const it of items) {
    const [x, y, r] = pos[it.id];
    const sel = SC.sel === it.id ? ' sch-sel' : '';
    let lab = '';
    if (it.c) {
      let v = '';
      if (it.c.type === 'res' || it.c.type === 'pot') v = K.scriviValore(it.c.opt.r).replace(' ', '');
      if (it.c.type === 'cap') v = K.scriviValore(it.c.opt.c, 'F').replace(' ', '');
      if (it.c.type === 'led') v = K.LED_COL[it.c.opt.color][2];
      if (it.c.type === 'npn' || it.c.type === 'pnp') v = it.c.type === 'npn' ? 'BC107' : 'BC212';
      // nei blocchi con le scritte il nome (U1) va sopra il titolo del blocco, non sopra il titolo
      const dy = it.sym.scritte && !(r % 2) ? 3.2 : r % 2 ? 3 : 1.6;
      lab = `<g class="sch-lab">${T(x * U, (y - dy) * U, it.label, 'middle', 8)}${v ? T(x * U, (y + (r % 2 ? 3.6 : 2.4)) * U, v, 'middle', 7) : ''}</g>`;
    }
    s += `<g class="sch-sim${sel}" data-sch="${it.id}" transform="translate(${x * U} ${y * U}) rotate(${r * 90})"><rect class="presa" x="-30" y="-30" width="60" height="60" fill="transparent"/>${it.sym.svg}</g>${lab}`;
  }
  if (SC.filoDa) s += `<circle cx="${SC.filoDa.x * U}" cy="${SC.filoDa.y * U}" r="5" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  $('#sch-disegno').innerHTML = s;
  // area di presa grande quanto il simbolo
  document.querySelectorAll('#sch-disegno [data-sch]').forEach(g => { try { const p = g.querySelector('.presa'); p.remove(); const b = g.getBBox(); g.insertAdjacentHTML('afterbegin', `<rect class="presa" x="${b.x - 3}" y="${b.y - 3}" width="${b.width + 6}" height="${b.height + 6}" fill="transparent"/>`); } catch {} });
  if (!SC.fatto && $('#sch-svg').getBoundingClientRect().width > 50) { SC.fatto = true; adatta(); }
  statoSchema(items);
  const cs = $('#sch-colori');
  if (cs) { cs.hidden = !SC.selFilo; const c = SC.selFilo && (sf[SC.selFilo] || {}).col; cs.querySelectorAll('[data-col]').forEach(b => b.classList.toggle('on', b.dataset.col === (c || ''))); }
  $('#sch-colbb').classList.toggle('on', !!B.bb.schemaColori);
  $('#sch-filo').classList.toggle('on', SC.modo === 'filo');
}
function statoSchema(items) {
  let t;
  if (SC.modo === 'filo') t = SC.filoDa ? `Filo da ${SC.filoDa.nome}: clicca il piedino d'arrivo (sul blocco della scheda: scegli il pin) · Esc annulla` : 'Filo (W): clicca un piedino, poi quello d\'arrivo: il filo si fa anche sulla breadboard · Esc per tornare a selezionare';
  else if (B.posa) t = `${K.TIPI[B.posa].nome}: clicca nello schema dove metterlo (sulla breadboard va in un posto libero) · Esc annulla`;
  else if (SC.selFilo) t = 'Filo: trascina un tratto per spostarlo (si piega da solo a 90°), colore qui sopra · doppio clic = percorso automatico';
  else if (SC.sel && SC.sel.startsWith('g:')) t = 'Simbolo di massa / alimentazione: trascinalo dove vuoi (resta collegato) · doppio clic lo riporta al piedino';
  else if (SC.sel) t = `${(items.find(i => i.id === SC.sel) || {}).label || 'Scheda'}: trascina per spostarlo, R ruota, Canc lo elimina · «Disponi» rimette tutto in automatico`;
  else t = 'Lo schema segue la breadboard. Trascina simboli, masse e tratti di filo per spostarli, R ruota; W = filo; dalla palette si aggiungono componenti; rotella = zoom, trascina il fondo per spostare la vista.';
  $('#sch-stato').textContent = t;
}
// fili a mano: chiave = i due piedini (in ordine), percorso salvato che segue i piedini se si spostano
const idTerm = t => t.it.id + '.' + t.f;
function chiaveFilo(a, b) { const x = idTerm(a), y = idTerm(b); return x <= y ? { k: x + '~' + y, inv: false } : { k: y + '~' + x, inv: true }; }
function pulisciPunti(p) {
  const s = p.filter((q, i) => i === 0 || q[0] !== p[i - 1][0] || q[1] !== p[i - 1][1]);
  return s.filter((q, i) => i === 0 || i === s.length - 1 || !((s[i - 1][0] === q[0] && q[0] === s[i + 1][0]) || (s[i - 1][1] === q[1] && q[1] === s[i + 1][1])));
}
function segui(p0, a, b) {
  const p = p0.map(q => [...q]);
  const sposta = (i, j, x, y) => { const q = p[i], v = p[j]; if (v && v !== q) { if (v[0] === q[0]) v[0] = x; else if (v[1] === q[1]) v[1] = y; } p[i] = [x, y]; };
  sposta(0, 1, a.x, a.y);
  sposta(p.length - 1, p.length - 2, b.x, b.y);
  const out = [p[0]];
  for (let i = 1; i < p.length; i++) { const q = out[out.length - 1], r = p[i]; if (q[0] !== r[0] && q[1] !== r[1]) out.push([r[0], q[1]]); out.push(r); }
  return pulisciPunti(out);
}
// tratto i del percorso spostato a c (y se orizzontale, x se verticale): agli estremi si aggiunge un angolo
function spostaTratto(p0, i, c) {
  let p = p0.map(q => [...q]);
  const orizz = p[i][1] === p[i + 1][1];
  if (i === 0) { p.unshift([...p[0]]); i = 1; }
  if (i + 1 === p.length - 1) p.push([...p[p.length - 1]]);
  const k = orizz ? 1 : 0;
  p[i][k] = c; p[i + 1][k] = c;
  return pulisciPunti(p);
}
// piedini disegnati (anche quelli non collegati), per lo strumento Filo
function piediniSchema() {
  const out = [];
  for (const it of SC.ultimo.items) {
    const [x, y, r] = SC.ultimo.pos[it.id];
    for (const [f, dx, dy] of it.sym.pins) { const [rx, ry] = ruota(dx, dy, r); out.push({ it, f, x: x + rx, y: y + ry, nome: it.id === 'nucleo' ? f : `${it.label || it.id} ${f}` }); }
  }
  return out;
}
// punto della breadboard che corrisponde a un piedino dello schema
const SEGNALI = ['GND', '3V3', '5V'];
function puntoBB(t) {
  if (t.it.id === 'nucleo' || t.sig) {
    const sig = t.sig || t.f, fori = [...K.FORI.values()].filter(h => h.net === sig && /^CN/.test(h.id));
    const liberi = fori.filter(h => !B.bb.wires.some(w => [w.p[0], w.p[w.p.length - 1]].some(q => q[0] === h.x && q[1] === h.y)));
    const h = (liberi.find(h => /^CN(7|10)-/.test(h.id)) || liberi[0] || fori[0]);
    return h ? [h.x, h.y] : null;
  }
  const c = t.it.c, p = c && K.piediniXY(c).find(p => p.n === t.f || K.funzionePiedino(c, p.n) === t.f);
  if (!p) return null;
  const f = K.FORI.get(K.chiave(p.x, p.y));
  if (!f) return [p.x, p.y];                        // fuori dalla breadboard: il filo va al piedino
  // sulla breadboard: un foro libero della stessa fila, il più vicino
  const usati = new Set([...B.bb.comps.flatMap(c => K.piediniXY(c).map(q => K.chiave(q.x, q.y))), ...B.bb.wires.flatMap(w => [w.p[0], w.p[w.p.length - 1]].map(q => K.chiave(q[0], q[1])))]);
  const liberi = [...K.FORI.values()].filter(h => h.net === f.net && !usati.has(K.chiave(h.x, h.y))).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  return liberi.length ? [liberi[0].x, liberi[0].y] : [p.x, p.y];
}
function collega(a, b) {
  const pa = puntoBB(a), pb = puntoBB(b);
  if (!pa || !pb) { $('#sch-stato').textContent = 'Non trovo dove collegarlo sulla breadboard'; return false; }
  if (pa[0] === pb[0] && pa[1] === pb[1]) return false;
  const w = { id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), p: B.percorso([pa, pb]), col: B.coloreAuto(pa, pb) };
  B.modifica(bb => bb.wires.push(w));
  return true;
}
// pin della scheda scelto a mano (il blocco della Nucleo mostra solo i pin già usati)
function chiediPin() {
  const v = (prompt('Collega a quale pin della scheda? (es. PA5, PC13, GND, 3V3, 5V)') || '').trim().toUpperCase().replace(/^\+/, '');
  if (!v) return null;
  if (SEGNALI.includes(v) || [...K.FORI.values()].some(h => h.net === v && /^CN/.test(h.id))) return { it: { id: 'nucleo' }, f: v, sig: SEGNALI.includes(v) ? v : null, nome: v };
  $('#sch-stato').textContent = `«${v}» non è un pin della NUCLEO-F401RE`;
  return null;
}
function clicFilo(m, ev) {
  const vicino = piediniSchema().map(t => ({ t, d: Math.hypot(t.x - m[0], t.y - m[1]) })).sort((a, b) => a.d - b.d)[0];
  let t = vicino && vicino.d < 0.8 ? vicino.t : null;
  // simbolo di massa / alimentazione: vale come quel segnale
  const g = ev.target.closest && ev.target.closest('[data-sch^="g:"]');
  if (!t && g) { const [, id, f] = g.dataset.sch.split(':'); const ts = [...SC.ultimo.term.values()].flat().find(x => x.it.id === id && x.f === f); const n = ts && SC.ultimo.nodi.find(nd => (SC.ultimo.term.get(nd.i) || []).includes(ts)); if (n) t = { it: { id: 'nucleo' }, f: n.alim[0], sig: n.alim[0], nome: n.alim[0], x: m[0], y: m[1] }; }
  if (!t && ev.target.closest && ev.target.closest('[data-sch="nucleo"]')) t = chiediPin();
  if (!t) { if (SC.filoDa) { SC.filoDa = null; disegna(); } return; }
  if (!SC.filoDa) { SC.filoDa = t; disegna(); return; }
  const a = SC.filoDa; SC.filoDa = null;
  if (!collega(a, t)) disegna();
}
function posaQui(tipo, xy) {
  const rot = B.posaRot || 0, [x, y] = B.postoLibero(tipo);
  const c = B.aggiungi(tipo, x, y, rot);
  if (c && !K.tavola(c)) salvaPos(c.id, [Math.round(xy[0]), Math.round(xy[1]), 0]);
  return c;
}
function applica() { const v = SC.vista; $('#sch-svg').setAttribute('viewBox', `${v.x * U} ${v.y * U} ${v.w * U} ${v.h * U}`); }
function adatta() {
  const g = $('#sch-disegno'), svg = $('#sch-svg');
  let b; try { b = g.getBBox(); } catch { return; }
  if (!b.width) return;
  const r = svg.getBoundingClientRect(), ar = r.height / Math.max(1, r.width) || 0.6, m = 30;
  let w = b.width + 2 * m, h = w * ar;
  if (h < b.height + 2 * m) { h = b.height + 2 * m; w = h / ar; }
  SC.vista = { x: (b.x + b.width / 2 - w / 2) / U, y: (b.y + b.height / 2 - h / 2) / U, w: w / U, h: h / U };
  applica();
}
function mondo(ev) { const svg = $('#sch-svg'), pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const q = pt.matrixTransform(svg.getScreenCTM().inverse()); return [q.x / U, q.y / U]; }
function salvaFilo(k, e) { B.modifica(bb => { const sf = { ...(bb.schemaFili || {}) }, v = { ...(sf[k] || {}), ...e }; for (const x of ['p', 'col']) if (v[x] === undefined) delete v[x]; if (v.p || v.col) sf[k] = v; else delete sf[k]; bb.schemaFili = sf; }); }
function salvaPos(id, p) { B.modifica(bb => { bb.schema = { ...(bb.schema || {}) }; bb.schema[id] = p; }); }

// ------------------------------------------------------------------
// Montaggio della vista e interazione
function monta() {
  const box = $('#vista-schema');
  box.innerHTML = `<div class="bb-barra sch-barra">
      <button type="button" class="small" id="sch-disponi" title="Rimette tutti i simboli in automatico">Disponi</button>
      <button type="button" class="small" id="sch-ruota" title="Ruota il simbolo scelto (R)">Ruota</button>
      <button type="button" class="small" id="sch-adatta" title="Adatta alla finestra (F)">Adatta</button>
      <button type="button" class="small" id="sch-filo" title="Filo: clic su un piedino e clic sull'arrivo; si fa anche sulla breadboard (W)">Filo</button>
      <button type="button" class="small" id="sch-colbb" title="Fili dello schema con i colori della breadboard">Colori breadboard</button>
      <span id="sch-colori" class="bb-colori" hidden title="Colore del filo scelto">${K.COLORI_FILO.map(c => `<button type="button" data-col="${c}" style="background:${c}" aria-label="colore ${c}"></button>`).join('')}<button type="button" data-col="" title="Automatico (colore e percorso)">auto</button></span>
      <span class="tabs-sp"></span>
      <span class="muted small">Simboli IEC · GND e alimentazioni con il loro simbolo</span>
      <button type="button" class="small" id="sch-png" title="Scarica lo schema in PNG (per le relazioni)">PNG</button>
    </div>
    <div class="sch-wrap"><svg id="sch-svg" xmlns="${NS}"><g id="sch-disegno"></g></svg></div>
    <div id="sch-stato" class="bb-stato small"></div>`;
  const svg = $('#sch-svg');
  svg.addEventListener('pointerdown', ev => {
    if (ev.button === 2) return;
    const g = ev.target.closest && ev.target.closest('[data-sch]'), m = mondo(ev);
    try { svg.setPointerCapture(ev.pointerId); } catch {}
    if (B.posa) { const tipo = B.posa; posaQui(tipo, m); B.annullaComando(); disegna(); return; }
    if (SC.modo === 'filo') { clicFilo(m, ev); return; }
    const fl = ev.target.closest && ev.target.closest('[data-filo]');
    if (!g && fl) {
      // tratto di filo: si sposta perpendicolarmente (orizzontale su e giù, verticale a destra e sinistra)
      const k = fl.dataset.filo, pts = SC.fili.get(k).pts;
      let i = 0, dm = Infinity;
      for (let j = 0; j < pts.length - 1; j++) { const [a, b] = [pts[j], pts[j + 1]], d = a[1] === b[1] ? Math.abs(m[1] - a[1]) + Math.max(0, Math.min(a[0], b[0]) - m[0], m[0] - Math.max(a[0], b[0])) : Math.abs(m[0] - a[0]) + Math.max(0, Math.min(a[1], b[1]) - m[1], m[1] - Math.max(a[1], b[1])); if (d < dm) { dm = d; i = j; } }
      SC.sel = null; SC.selFilo = k; SC.drag = { tipo: 'filo', k, i, pts0: pts, pts, mosso: false }; disegna(); return;
    }
    SC.selFilo = null;
    if (g && g.dataset.sch.startsWith('g:')) { const kg = g.dataset.sch, t = (B.bb.schema || {})[kg]; SC.sel = kg; const p0 = t ? [t[0], t[1]] : null; SC.drag = { tipo: 'alim', id: kg, da: m, p0, p: null }; disegna(); return; }
    if (g) { SC.sel = g.dataset.sch; const p = SC.ultimo.pos[SC.sel]; SC.drag = { tipo: 'sim', id: SC.sel, da: m, p0: [...p], p: [...p] }; disegna(); return; }
    SC.sel = null; SC.drag = { tipo: 'pan', da: [ev.clientX, ev.clientY], v: { ...SC.vista } }; disegna();
  });
  svg.addEventListener('pointermove', ev => {
    const d = SC.drag;
    if (!d) return;
    if (d.tipo === 'pan') { const r = svg.getBoundingClientRect(), k = SC.vista.w / r.width; SC.vista.x = d.v.x - (ev.clientX - d.da[0]) * k; SC.vista.y = d.v.y - (ev.clientY - d.da[1]) * k; applica(); return; }
    if (d.tipo === 'filo') {
      const m = mondo(ev), p = d.pts0, orizz = p[d.i][1] === p[d.i + 1][1], c = Math.round(orizz ? m[1] : m[0]);
      if (c === (orizz ? p[d.i][1] : p[d.i][0]) && !d.mosso) return;
      d.pts = spostaTratto(p, d.i, c); d.mosso = true; SC.tmp = { [d.k]: d.pts }; disegna(); return;
    }
    if (d.tipo === 'alim') {
      const m = mondo(ev), P = [Math.round(m[0]), Math.round(m[1])];
      if (d.p && P[0] === d.p[0] && P[1] === d.p[1]) return;
      d.p = P; SC.tmp = { [d.id]: P }; disegna(); return;
    }
    const m = mondo(ev), nx = d.p0[0] + Math.round(m[0] - d.da[0]), ny = d.p0[1] + Math.round(m[1] - d.da[1]);
    if (nx === d.p[0] && ny === d.p[1]) return;
    d.p = [nx, ny, d.p0[2]];
    const g = document.querySelector(`#sch-disegno [data-sch="${d.id}"]`);
    if (g) g.setAttribute('transform', `translate(${nx * U} ${ny * U}) rotate(${d.p0[2] * 90})`);
  });
  const fine = () => {
    const d = SC.drag; SC.drag = null; SC.tmp = {};
    if (d && d.tipo === 'sim' && (d.p[0] !== d.p0[0] || d.p[1] !== d.p0[1])) salvaPos(d.id, d.p);
    else if (d && d.tipo === 'alim' && d.p) salvaPos(d.id, [d.p[0], d.p[1], 0]);
    else if (d && d.tipo === 'filo' && d.mosso) salvaFilo(d.k, { p: d.pts });
  };
  svg.addEventListener('pointerup', fine); svg.addEventListener('pointercancel', fine);
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const m = mondo(ev), f = Math.exp(Math.max(-0.5, Math.min(0.5, ev.deltaY * 0.0015))), v = SC.vista;
    const w = Math.min(600, Math.max(15, v.w * f)), h = w * v.h / v.w;
    v.x = m[0] - (m[0] - v.x) * w / v.w; v.y = m[1] - (m[1] - v.y) * h / v.h; v.w = w; v.h = h; applica();
  }, { passive: false });
  svg.addEventListener('dblclick', ev => {
    const g = ev.target.closest && ev.target.closest('[data-sch^="g:"]'), fl = ev.target.closest && ev.target.closest('[data-filo]');
    if (g) B.modifica(bb => { if (bb.schema) delete bb.schema[g.dataset.sch]; });
    else if (fl) salvaFilo(fl.dataset.filo, { p: undefined });
  });
  $('#sch-colori').addEventListener('click', ev => { const b = ev.target.closest('[data-col]'); if (b && SC.selFilo) salvaFilo(SC.selFilo, b.dataset.col ? { col: b.dataset.col } : { p: undefined, col: undefined }); });
  $('#sch-colbb').addEventListener('click', () => B.modifica(bb => { if (bb.schemaColori) delete bb.schemaColori; else bb.schemaColori = 1; }));
  const modoFilo = v => { SC.modo = v ? 'filo' : 'sel'; SC.filoDa = null; SC.sel = null; SC.selFilo = null; svg.classList.toggle('filo', !!v); disegna(); };
  $('#sch-filo').addEventListener('click', () => modoFilo(SC.modo !== 'filo'));
  const eliminaSel = () => {
    if (SC.sel && SC.sel !== 'nucleo' && !SC.sel.startsWith('g:')) { const id = SC.sel; SC.sel = null; B.modifica(bb => { bb.comps = bb.comps.filter(c => c.id !== id); if (bb.schema) delete bb.schema[id]; }); }
  };
  const ruotaSel = () => { if (!SC.sel || SC.sel.startsWith('g:')) return; const p = SC.ultimo.pos[SC.sel]; salvaPos(SC.sel, [p[0], p[1], (p[2] + 1) % 4]); };
  $('#sch-ruota').addEventListener('click', ruotaSel);
  $('#sch-adatta').addEventListener('click', adatta);
  // «Disponi»: simboli e fili di nuovo automatici (i colori scelti a mano restano)
  $('#sch-disponi').addEventListener('click', () => { B.modifica(bb => { delete bb.schema; if (bb.schemaFili) for (const v of Object.values(bb.schemaFili)) delete v.p; }); SC.fatto = false; });
  $('#sch-png').addEventListener('click', esportaPNG);
  document.addEventListener('keydown', ev => {
    if (document.body.dataset.vista !== 'schema' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target; if (t && t.closest && t.closest('input, textarea, select, .cm-editor') || document.querySelector('dialog[open]')) return;
    const k = ev.key.toLowerCase();
    if (k === 'r') { ev.preventDefault(); ev.stopImmediatePropagation(); ruotaSel(); }
    else if (k === 'f') { ev.preventDefault(); ev.stopImmediatePropagation(); adatta(); }
    else if (k === 'w') { ev.preventDefault(); ev.stopImmediatePropagation(); modoFilo(SC.modo !== 'filo'); }
    else if (k === 'escape') { ev.preventDefault(); ev.stopImmediatePropagation(); if (B.posa) B.annullaComando(); if (SC.filoDa) { SC.filoDa = null; disegna(); } else if (SC.modo === 'filo') modoFilo(false); else { SC.sel = null; SC.selFilo = null; disegna(); } }
    else if (k === 'delete' || k === 'backspace') { ev.preventDefault(); ev.stopImmediatePropagation(); eliminaSel(); }
  }, true);
  new ResizeObserver(() => { if (!SC.fatto && svg.getBoundingClientRect().width > 50) { SC.fatto = true; disegna(); adatta(); } }).observe(svg);
}
async function esportaPNG() {
  const svg = $('#sch-svg').cloneNode(true), b = $('#sch-disegno').getBBox(), m = 30;
  const W = 2400, H = Math.round(W * (b.height + 2 * m) / (b.width + 2 * m));
  svg.setAttribute('viewBox', `${b.x - m} ${b.y - m} ${b.width + 2 * m} ${b.height + 2 * m}`);
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  // colori fissi (sfondo bianco, tratto nero), come su un foglio
  svg.setAttribute('style', 'color:#111;--sch-fondo:#fff;--sch-aperto:#c00;--sch-etichetta:#0050a0;background:#fff');
  svg.insertAdjacentHTML('afterbegin', `<rect x="${b.x - m}" y="${b.y - m}" width="${b.width + 2 * m}" height="${b.height + 2 * m}" fill="#fff"/><style>.sch-filo,.sch-gambo{fill:none;stroke:#111;stroke-width:1.6}.sch-sel rect{stroke:#111}</style>`);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  cv.getContext('2d').drawImage(img, 0, 0, W, H);
  URL.revokeObjectURL(url);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `schema-${(S.selId || 'progetto').replace(/[^\w\- ]/g, '_')}.png`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  SC.ultimoPNG = { w: W, h: H, byte: blob.size };
  return SC.ultimoPNG;
}
monta();
// sincronizzato con la breadboard: si ridisegna quando cambia il circuito (se la vista è aperta, se no dopo)
window.addEventListener('bb-cambiato', () => { SC.sporco = true; if (document.body.dataset.vista === 'schema') disegna(); });
window.addEventListener('sv-vista', e => { if (e.detail === 'schema' && SC.sporco) disegna(); if (e.detail === 'schema') setTimeout(() => { if (!SC.fatto) { SC.fatto = true; adatta(); } }, 30); });
// posa dalla palette trascinando sullo schema (breadboard.js chiama questa quando la vista è lo schema)
function posa(tipo, cx, cy) {
  const r = $('#sch-svg').getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return false;
  posaQui(tipo, mondo({ clientX: cx, clientY: cy }));
  return true;
}
window.SVschema = { SC, disegna, adatta, esportaPNG, costruisci, posa, collega, puntoBB, piediniSchema };
