// bus.js — dispositivi I2C/SPI e sensori sulla breadboard (fase 3, punto L, 25/11/2026).
// La parte digitale (protocollo, registri, display) la simula sim/sim_bus.c; qui:
//  - dalla netlist della breadboard si ricava a quali pin del micro va ogni piedino e si manda la
//    configurazione al simulatore (righe "E …"), con i valori dei sensori (temperatura, distanza, inclinazione);
//  - si disegnano i dispositivi e si aggiornano LCD e OLED con le righe "F i L|O …" del simulatore;
//  - le EEPROM salvano nel progetto i byte scritti ("F i w ind hex");
//  - il pannello (doppio clic) dei sensori ha i cursori per cambiare le grandezze mentre il programma gira.
// Lo usa breadboard.js (import). Niente HTML dai dati: i testi del display vanno in textContent.
import * as K from './circuito.js?v=2026-11-26e';

export const TIPI_BUS = ['lcd16x2', 'oled', 'oledspi', 'lm75', 'mpu6050', 'eeprom', 'eeprom256', 'hcsr04'];
export const SENSORI = ['lm75', 'mpu6050', 'hcsr04', 'eeprom', 'eeprom256'];
const COD = { lcd16x2: 'L', oled: 'O', oledspi: 'O', lm75: 'T', mpu6050: 'M', eeprom: 'E', eeprom256: 'F', hcsr04: 'H' };
const MAXDEV = 16;
const pinNum = k => { const m = /^P([A-H])(\d+)$/.exec(k || ''); return m ? (m[1].charCodeAt(0) - 65) * 16 + +m[2] : -1; };
const hex2 = v => '0x' + v.toString(16).toUpperCase().padStart(2, '0');

// stato per componente: { i, riga (config mandata), lcd, oled, aggiornato }
export const BUS = { dev: new Map(), perIndice: [], problemi: [] };

// ------------------------------------------------------------------
// Configurazione dalla netlist
function nodoDi(cc, nome) { const p = cc.pins.find(p => p.n === nome); return p ? p.nodo : -1; }
// il nodo ha un pull-up? (resistenza verso 3V3/5V, o un modulo con le sue resistenze collegato lì)
function haPullup(net, n) {
  if (n < 0) return false;
  for (const cc of net.comps) {
    if (cc.c.type === 'res') {
      const [a, b] = cc.pins.map(p => p.nodo);
      const altro = a === n ? b : b === n ? a : -1;
      if (altro >= 0 && net.nodi[altro].alim.some(x => x === '3V3' || x === '5V')) return true;
    }
    if (TIPI_BUS.includes(cc.c.type) && cc.c.opt.pullup && cc.pins.some(p => p.nodo === n && (p.n === 'SDA' || p.n === 'SCL'))) return true;
  }
  return false;
}
// righe "E …" per il circuito; segna in BUS.problemi i collegamenti che non vanno
export function configBus(bb, net) {
  const righe = [], vecchi = BUS.dev;
  BUS.dev = new Map(); BUS.perIndice = []; BUS.problemi = [];
  if (!net) return righe;
  let i = 0;
  for (const cc of net.comps) {
    const c = cc.c;
    if (!TIPI_BUS.includes(c.type) || i >= MAXDEV) continue;
    const pin = nome => { const n = nodoDi(cc, nome); return n < 0 ? -1 : pinNum(net.nodi[n].pins[0]); };
    const alim = nome => { const n = nodoDi(cc, nome); return n < 0 ? [] : net.nodi[n].alim; };
    const vcc = alim('VCC'), gnd = alim('GND').includes('GND');
    let ok = gnd && (vcc.includes('3V3') || vcc.includes('5V'));
    const nome = `${c.label || c.id} (${K.TIPI[c.type].nome})`;
    if (!ok) BUS.problemi.push({ cod: 'alim', chiave: c.id, testo: `${nome}: VCC va a 3,3 V o 5 V e GND a massa, se no il dispositivo è spento e non risponde.` });
    if (c.type === 'hcsr04' && ok && !vcc.includes('5V')) { ok = false; BUS.problemi.push({ cod: 'alim', chiave: c.id, testo: `${nome}: l'HC-SR04 vuole 5 V (a 3,3 V non misura). Collega VCC al 5V della Nucleo.` }); }
    let scl = -1, sda = -1, cs = -1, dc = -1, rst = -1, pull = 0, addr = c.opt.addr || 0;
    if (c.type === 'oledspi') { scl = pin('D0'); sda = pin('D1'); cs = pin('CS'); dc = pin('DC'); rst = pin('RES'); if (cs < 0) cs = alim('CS').includes('GND') ? -1 : -2; }
    else if (c.type === 'hcsr04') { scl = pin('Trig'); sda = pin('Echo'); }
    else {
      scl = pin('SCL'); sda = pin('SDA');
      pull = haPullup(net, nodoDi(cc, 'SCL')) && haPullup(net, nodoDi(cc, 'SDA')) ? 1 : 0;
      if (scl < 0 || sda < 0) BUS.problemi.push({ cod: 'bus', chiave: c.id, testo: `${nome}: SDA e SCL vanno ai pin dell'I2C (es. I2C1: SCL = PB8/D15, SDA = PB9/D14).` });
    }
    const riga = `E ${i} ${COD[c.type]} ${addr} ${scl} ${sda} ${cs} ${dc} ${rst} ${pull} ${ok ? 1 : 0}`;
    const st = { i, c, riga, lcd: null, oled: null, agg: true, ...(vecchi.get(c.id) && vecchi.get(c.id).riga === riga ? { lcd: vecchi.get(c.id).lcd, oled: vecchi.get(c.id).oled } : {}) };
    BUS.dev.set(c.id, st); BUS.perIndice[i] = c.id;
    righe.push(riga, ...valori(c, i));
    i++;
  }
  return righe;
}
// grandezze del sensore e contenuto della memoria
export function valori(c, i) {
  const o = c.opt;
  if (c.type === 'lm75') return [`E ${i} v t ${o.t}`];
  if (c.type === 'mpu6050') return [`E ${i} v a ${o.roll} ${o.pitch}`];
  if (c.type === 'hcsr04') return [`E ${i} v d ${o.dist}`];
  if (K.EEPROM[c.type]) {
    const out = [];
    for (const [a, h] of c.mem || []) for (let k = 0; k < h.length; k += 512) out.push(`E ${i} m ${a + k / 2} ${h.slice(k, k + 512)}`);
    return out;
  }
  return [];
}

// ------------------------------------------------------------------
// Righe "F …" dal simulatore. salvaMem(c, ind, hex) scrive nella EEPROM del progetto.
let piuDi = null;    // "F+": seconda metà del framebuffer dell'OLED
export function onF(line, salvaMem) {
  const a = line.split(' ');
  if (a[0] === 'F+') { if (piuDi) { piuDi.oled.fb += a[1]; if (piuDi.oled.fb.length >= 2048) { piuDi.agg = true; piuDi = null; } } return; }   // il simulatore manda 500 byte per riga
  const id = BUS.perIndice[+a[1]], st = id && BUS.dev.get(id);
  if (!st) return;
  if (a[2] === 'L') st.lcd = { disp: +a[3], cur: +a[4], blink: +a[5], luce: +a[6], shift: +a[7], ac: +a[8], righe: +a[9], dd: a[10] || '', cg: a[11] || '' };
  else if (a[2] === 'O') { st.oled = { on: +a[3], inv: +a[4], contr: +a[5], seg: +a[6], com: +a[7], start: +a[8], pompa: +a[9], tutto: +a[10], fb: a[11] || '' }; piuDi = st; return; }   // si ridisegna quando arrivano tutti i 1024 byte
  else if (a[2] === 'w') salvaMem(st.c, +a[3], a[4] || '');
  st.agg = true;
}

// ------------------------------------------------------------------
// Disegno (unità SVG: 10 = un passo da 2,54 mm)
const lab = (t, x, y, a = 'middle', col = '#e8e8e8', fs = 3.6) => `<text x="${x}" y="${y}" font-size="${fs}" text-anchor="${a}" fill="${col}" font-family="sans-serif">${t}</text>`;
const pin = (x, y) => `<rect x="${x - 1.6}" y="${y - 1.6}" width="3.2" height="3.2" fill="#c9a227"/>`;
export function busSVG(c) {
  const id = c.id;
  switch (c.type) {
    case 'lcd16x2': {   // modulo 80×36 mm; piedini del PCF8574 a sinistra (verticali)
      let s = `<rect x="4" y="-12" width="312" height="140" rx="5" fill="#1d6b3a" stroke="#0e3d20"/><rect x="22" y="8" width="276" height="96" rx="3" fill="#0d0d0d"/>`;
      s += `<rect data-lcdfondo="${id}" x="30" y="22" width="260" height="68" rx="2" fill="#4a5a2a"/>`;
      s += `<g data-lcd="${id}" font-family="ui-monospace, Menlo, monospace" font-size="26" fill="#13220a"><text x="34" y="50"></text><text x="34" y="82"></text></g>`;
      s += `<rect x="-6" y="-5" width="16" height="40" rx="2" fill="#123b8a"/>` + ['GND', 'VCC', 'SDA', 'SCL'].map((t, k) => pin(0, k * 10) + lab(t, 12, k * 10 + 1.3, 'start', '#fff', 3.4)).join('');
      return s;
    }
    case 'oled': case 'oledspi': {
      const n = c.type === 'oled' ? 4 : 7, w = Math.max(n * 10 + 8, 120), x0 = (n - 1) * 5 - w / 2;
      const nomi = c.type === 'oled' ? ['GND', 'VCC', 'SCL', 'SDA'] : ['GND', 'VCC', 'D0', 'D1', 'RES', 'DC', 'CS'];
      return `<rect x="${x0}" y="-6" width="${w}" height="${w * 0.95}" rx="4" fill="#123b8a" stroke="#0a2457"/>` +
        nomi.map((t, k) => pin(k * 10, 0) + lab(t, k * 10, 6, 'middle', '#fff', 3)).join('') +
        `<rect x="${x0 + 6}" y="12" width="${w - 12}" height="${(w - 12) / 2 + 6}" fill="#050505"/>` +
        `<image data-oled="${id}" x="${x0 + 8}" y="15" width="${w - 16}" height="${(w - 16) / 2}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`;
    }
    case 'lm75': return `<rect x="-6" y="-34" width="42" height="30" rx="3" fill="#6a1b9a"/><rect x="8" y="-26" width="14" height="10" fill="#111"/>` + lab('LM75', 15, -8, 'middle', '#fff', 4) +
      ['VCC', 'GND', 'SDA', 'SCL'].map((t, k) => pin(k * 10, 0) + lab(t, k * 10, 6, 'middle', '#333', 3)).join('') + `<text data-valore="${id}" x="15" y="-38" font-size="5" text-anchor="middle" fill="#c0392b" font-family="sans-serif"></text>`;
    case 'mpu6050': return `<g data-incl="${id}"><rect x="-6" y="-52" width="42" height="48" rx="3" fill="#1e5aa8"/><rect x="8" y="-36" width="14" height="14" fill="#111"/>` + lab('GY-521', 15, -42, 'middle', '#fff', 4) + `</g>` +
      ['VCC', 'GND', 'SCL', 'SDA'].map((t, k) => pin(k * 10, 0) + lab(t, k * 10, 6, 'middle', '#333', 3)).join('') + `<text data-valore="${id}" x="15" y="-56" font-size="5" text-anchor="middle" fill="#1e5aa8" font-family="sans-serif"></text>`;
    case 'eeprom': case 'eeprom256': return `<rect x="-6" y="-30" width="42" height="26" rx="3" fill="#2e7d32"/><rect x="5" y="-24" width="20" height="10" rx="1" fill="#111"/>` +
      lab(c.type === 'eeprom' ? '24C02' : '24LC256', 15, -8, 'middle', '#fff', 3.6) + ['VCC', 'GND', 'SDA', 'SCL'].map((t, k) => pin(k * 10, 0) + lab(t, k * 10, 6, 'middle', '#333', 3)).join('');
    case 'hcsr04': return `<rect x="-36" y="-44" width="102" height="40" rx="3" fill="#1565c0"/>` +
      [-14, 44].map(x => `<circle cx="${x}" cy="-24" r="15" fill="#c0c4c8" stroke="#888"/><circle cx="${x}" cy="-24" r="10" fill="#333"/>`).join('') + lab('HC-SR04', 15, -36, 'middle', '#fff', 4) +
      ['VCC', 'Trig', 'Echo', 'GND'].map((t, k) => pin(k * 10, 0) + lab(t, k * 10, 6, 'middle', '#333', 3)).join('') + `<text data-valore="${id}" x="15" y="-48" font-size="5" text-anchor="middle" fill="#1565c0" font-family="sans-serif"></text>`;
  }
  return '';
}

// caratteri dell'HD44780 (ROM A00): l'ASCII da 0x20 a 0x7D è uguale; i codici 0–15 sono i caratteri personalizzati (CGRAM)
const A00 = { 0x5C: '¥', 0x7E: '→', 0x7F: '←', 0xDF: '°', 0xE4: 'µ', 0xF4: 'Ω', 0xFF: '█', 0xA5: '·' };
function riga(lcd, r) {
  let s = '';
  for (let k = 0; k < 16; k++) {
    const ind = (r ? 0x40 : 0) + (k + lcd.shift) % 40, v = parseInt(lcd.dd.substr(ind * 2, 2), 16);
    s += v < 16 ? '▒' : v >= 0x20 && v < 0x7E && v !== 0x5C ? String.fromCharCode(v) : A00[v] || '▯';
  }
  return s;
}
// a ogni fotogramma (breadboard.js): display e valori dei sensori
const canvas = new Map();
export function busFrame(el1, now) {
  for (const st of BUS.dev.values()) {
    const c = st.c;
    if (c.type === 'lcd16x2' && (st.agg || st.lcd && st.lcd.blink)) {
      const g = el1(`[data-lcd="${c.id}"]`), f = el1(`[data-lcdfondo="${c.id}"]`);
      if (!g) continue;
      const l = st.lcd, t = g.querySelectorAll('text');
      const on = l && l.disp;
      for (let r = 0; r < 2; r++) {
        let s = on ? riga(l, r) : '';
        if (on && (l.cur || (l.blink && (now / 400 | 0) % 2)) && (l.ac >= 0x40) === (r === 1)) {
          const k = ((l.ac & 0x3F) - l.shift + 40) % 40;
          if (k < 16) s = s.slice(0, k) + (l.blink && (now / 400 | 0) % 2 ? '█' : '_') + s.slice(k + 1);
        }
        if (t[r].textContent !== s) t[r].textContent = s;
      }
      if (f) f.setAttribute('fill', l && l.luce ? '#9bd13a' : '#4a5a2a');
      st.agg = false;
    } else if ((c.type === 'oled' || c.type === 'oledspi') && st.agg) {
      const im = el1(`[data-oled="${c.id}"]`);
      if (!im) continue;
      let cv = canvas.get(c.id);
      if (!cv) { cv = document.createElement('canvas'); cv.width = 128; cv.height = 64; canvas.set(c.id, cv); }
      const ctx = cv.getContext('2d'), img = ctx.createImageData(128, 64), o = st.oled;
      const acceso = o && o.on && o.pompa && o.fb.length >= 2048;
      const lum = acceso ? 0.45 + 0.55 * (o.contr / 255) : 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
        let v = 0;
        if (acceso) {
          const col = o.seg ? x : 127 - x, rr = ((o.com ? y : 63 - y) + o.start) & 63;
          v = o.tutto ? 1 : (parseInt(o.fb.substr(((rr >> 3) * 128 + col) * 2, 2), 16) >> (rr & 7)) & 1;
          if (o.inv) v ^= 1;
        }
        const p = (y * 128 + x) * 4;
        img.data[p] = v ? 160 * lum + 40 : 6; img.data[p + 1] = v ? 220 * lum + 30 : 6; img.data[p + 2] = v ? 255 * lum : 8; img.data[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      im.setAttribute('href', cv.toDataURL());
      st.agg = false;
    }
    const v = el1(`[data-valore="${c.id}"]`);
    if (v) {
      const s = c.type === 'lm75' ? `${String(c.opt.t).replace('.', ',')} °C` : c.type === 'hcsr04' ? `${(c.opt.dist / 10).toFixed(1).replace('.', ',')} cm` : c.type === 'mpu6050' ? `R ${c.opt.roll}° B ${c.opt.pitch}°` : '';
      if (v.textContent !== s) v.textContent = s;
    }
  }
}

// ------------------------------------------------------------------
// Proprietà e pannello
export function busProprieta(c, esc) {
  const o = c.opt, sel = (k, vals, f) => `<select data-k="${k}">${vals.map(v => `<option value="${v}" ${v === o[k] ? 'selected' : ''}>${esc(f(v))}</option>`).join('')}</select>`;
  let h = '';
  const ad = (K.OPZIONI[c.type].find(x => x[0] === 'addr') || [])[2];
  if (ad) h += ` <label>indirizzo ${sel('addr', ad, v => hex2(v) + (c.type === 'lcd16x2' ? (v >= 0x38 ? ' (PCF8574A)' : ' (PCF8574)') : ''))}</label>`;
  if (o.pullup !== undefined) h += ` <label>pull-up sul modulo ${sel('pullup', [1, 0], v => v ? 'sì (4,7 kΩ)' : 'no')}</label>`;
  if (SENSORI.includes(c.type)) h += ' <button type="button" class="small" data-pannello>Pannello…</button>';
  if (c.type === 'oledspi') h += ' <span class="muted small">D0 = SCK, D1 = MOSI; CS a massa se non usato</span>';
  return h;
}
// corpo del pannello: imposta(k, v, salva) cambia l'opzione (salva = alla fine del trascinamento)
export function busPannello(c, box, imposta, esc) {
  const o = c.opt, cur = (k, min, max, step, u, tit) => `<label class="sp-campo">${tit} <input type="range" data-n="${k}" min="${min}" max="${max}" step="${step}" value="${o[k]}"> <input type="number" data-n="${k}" min="${min}" max="${max}" step="${step}" value="${o[k]}"> ${u}</label>`;
  if (c.type === 'lm75') box.innerHTML = cur('t', -55, 125, 0.5, '°C', 'Temperatura') + '<p class="muted small">Registro 0 dell\'LM75: 9 bit, passi di 0,5 °C (es. 23,5 °C → 0x17 0x80).</p>';
  if (c.type === 'hcsr04') box.innerHTML = cur('dist', 20, 4500, 1, 'mm', 'Distanza') + '<p class="muted small">Echo resta alto 58 µs per ogni cm (andata e ritorno a 343 m/s). Oltre 4 m: nessuna eco (impulso di 38 ms).</p>';
  if (c.type === 'mpu6050') box.innerHTML = cur('roll', -180, 180, 1, '°', 'Rollio (attorno a X)') + cur('pitch', -90, 90, 1, '°', 'Beccheggio (attorno a Y)') +
    '<p class="muted small">Accelerazioni ±2 g: 16384 = 1 g. Muovendo i cursori il giroscopio misura la velocità di rotazione. All\'accensione l\'MPU6050 dorme: scrivi 0 in PWR_MGMT_1 (0x6B).</p>';
  if (K.EEPROM[c.type]) {
    const dim = K.EEPROM[c.type], b = new Uint8Array(dim).fill(0xff);
    for (const [a, h] of c.mem || []) for (let k = 0; k < h.length / 2; k++) b[a + k] = parseInt(h.substr(2 * k, 2), 16);
    const righe = [];
    for (let a = 0; a < Math.min(dim, 256); a += 16) righe.push(a.toString(16).padStart(4, '0') + '  ' + [...b.subarray(a, a + 16)].map(x => x.toString(16).padStart(2, '0')).join(' '));
    box.innerHTML = `<pre class="mono small sp-hex"></pre><p class="muted small">${dim > 256 ? 'Primi 256 byte di ' + dim + '. ' : ''}Il contenuto resta nel progetto (anche dopo Stop). Pagina da ${c.type === 'eeprom' ? 8 : 64} byte; dopo una scrittura la memoria lavora 5 ms e non risponde (NACK).</p><button type="button" class="small" data-svuota>Svuota (tutto 0xFF)</button>`;
    box.querySelector('pre').textContent = righe.join('\n');
    box.querySelector('[data-svuota]').addEventListener('click', () => imposta('mem', [], true));
    return;
  }
  box.querySelectorAll('input[data-n]').forEach(i => {
    i.addEventListener('input', () => { const v = +i.value; if (isFinite(v)) { box.querySelectorAll(`input[data-n="${i.dataset.n}"]`).forEach(x => { if (x !== i) x.value = v; }); imposta(i.dataset.n, v, false); } });
    i.addEventListener('change', () => { const v = +i.value; if (isFinite(v)) imposta(i.dataset.n, v, true); });
  });
}
