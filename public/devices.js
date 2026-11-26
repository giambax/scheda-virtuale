'use strict';
/* Scheda Virtuale STM32 — dispositivi collegati ai pin (display, encoder, pulsanti, LED, motori…)
 * La configurazione è salvata dal server per progetto (/api/devices). Le luci (display, LED,
 * barre) arrivano dal simulatore come luminosità media su 40 ms ("B gruppo hex"), i motori
 * passo-passo come posizione ("J gruppo pos errori veloci x"). Gruppo = posizione × 4. */

const SEGS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];
const SEG_SHAPE = (() => {
  const h = (x0, x1, y) => `${x0},${y} ${x0 + 5},${y - 5} ${x1 - 5},${y - 5} ${x1},${y} ${x1 - 5},${y + 5} ${x0 + 5},${y + 5}`;
  const v = (x, y0, y1) => `${x},${y0} ${x + 5},${y0 + 5} ${x + 5},${y1 - 5} ${x},${y1} ${x - 5},${y1 - 5} ${x - 5},${y0 + 5}`;
  return { a: h(12, 68, 10), b: v(70, 12, 78), c: v(70, 82, 148), d: h(12, 68, 150), e: v(10, 82, 148), f: v(10, 12, 78), g: h(12, 68, 80) };
})();
const SEG_DIGIT = { 0x3F: '0', 0x06: '1', 0x5B: '2', 0x4F: '3', 0x66: '4', 0x6D: '5', 0x7D: '6', 0x7C: 'b', 0x07: '7', 0x27: '7', 0x7F: '8', 0x6F: '9', 0x67: '9',
  0x77: 'A', 0x39: 'C', 0x5E: 'd', 0x79: 'E', 0x71: 'F', 0x76: 'H', 0x38: 'L', 0x73: 'P', 0x3E: 'U', 0x40: '-', 0x5C: 'o', 0x54: 'n', 0x50: 'r', 0x00: ' ' };

const DEV_INFO = {
  seg7mux: { name: 'Display 7 segmenti multiplexato', short: '7 segmenti, più cifre' },
  seg7: { name: 'Display 7 segmenti (1 cifra)', short: '7 segmenti, 1 cifra' },
  encoder: { name: 'Encoder rotativo KY-040', short: 'Encoder KY-040' },
  button: { name: 'Pulsante', short: 'Pulsante' },
  led: { name: 'LED', short: 'LED' },
  rgb: { name: 'LED RGB', short: 'LED RGB' },
  bar: { name: 'Barra LED', short: 'Barra LED' },
  pot: { name: 'Potenziometro', short: 'Potenziometro (ADC)' },
  uln: { name: 'Motore passo-passo 28BYJ-48 + ULN2003', short: 'Stepper 28BYJ-48 (ULN2003)' },
  a4988: { name: 'Motore passo-passo + A4988/DRV8825', short: 'Stepper con A4988/DRV8825' },
  servo: { name: 'Servo SG90', short: 'Servo SG90 (PWM)' },
  dc: { name: 'Motore DC + L298N', short: 'Motore DC (L298N)' },
  buzzer: { name: 'Buzzer attivo', short: 'Buzzer' },
  keypad: { name: 'Tastierino 4×4', short: 'Tastierino 4×4' },
};
const ROLE_NAME = { pin: 'pin', clk: 'CLK', dt: 'DT', sw: 'SW', step: 'STEP', dir: 'DIR', en: 'EN', ena: 'ENA', r: 'R', g: 'G', b: 'B', dp: 'DP' };
const roleName = r => ROLE_NAME[r] || r.toUpperCase();
const devCount = d => d.type === 'seg7mux' ? Math.min(8, Math.max(2, d.opt.digits || 3)) : d.type === 'bar' ? Math.min(16, Math.max(2, d.opt.count || 8)) : 0;
function devRoles(d) {
  const n = devCount(d);
  switch (d.type) {
    case 'seg7mux': return [...SEGS, ...Array.from({ length: n }, (_, i) => 'd' + (i + 1))];
    case 'seg7': return SEGS;
    case 'rgb': return ['r', 'g', 'b'];
    case 'bar': return Array.from({ length: n }, (_, i) => 'l' + (i + 1));
    case 'encoder': return ['clk', 'dt', 'sw'];
    case 'uln': return ['in1', 'in2', 'in3', 'in4'];
    case 'a4988': return ['step', 'dir', 'en'];
    case 'dc': return ['in1', 'in2', 'ena'];
    case 'keypad': return ['r1', 'r2', 'r3', 'r4', 'c1', 'c2', 'c3', 'c4'];
    default: return ['pin'];
  }
}
const ALL_PINS = [...[...Array(16).keys()].map(i => 'PA' + i), ...[...Array(16).keys()].map(i => 'PB' + i), ...[...Array(16).keys()].map(i => 'PC' + i), 'PD2'];
const pinPP = k => { const { p, pin } = parseKey(k); return `${p} ${pin}`; };
const KEYS = ['1', '2', '3', 'A', '4', '5', '6', 'B', '7', '8', '9', 'C', '*', '0', '#', 'D'];

// chiamata da app.js subito dopo aver creato S
function devInitState() { Object.assign(S, { dev: { id: null, list: [], auto: true }, devB: {}, devJ: {}, devEdit: null, devKey: '', devAnim: {}, devPot: {}, devKeys: {}, devEnc: {} }); }

// ------------------------------------------------------------------
// Dati dal server e dal simulatore
async function devLoad(id) {
  const r = await api('/api/devices?id=' + encodeURIComponent(id));
  if (r.error || S.selId !== id) return;
  // vecchia configurazione del display a 1 cifra (localStorage, prima del 23/11/2026)
  let old = null;
  try { old = JSON.parse(localStorage.getItem('sv-seg7:' + id) || 'null'); } catch {}
  if (old && r.auto) {
    const list = r.devices.filter(d => d.type !== 'seg7');
    const auto7 = r.devices.find(d => d.type === 'seg7');
    if (old.map || auto7) list.unshift({ id: 'old7', type: 'seg7', pins: old.map || auto7.pins, opt: { anode: !!old.anode } });
    try { localStorage.removeItem('sv-seg7:' + id); } catch {}
    return devSave(list);
  }
  devSet(id, r);
}
function devSet(id, r) {
  S.dev = { id, list: r.devices || [], auto: !!r.auto };
  S.devKey = '';
  S.dirty = true;
}
function devSave(list, extra = {}) {
  return api('/api/devices', { id: S.dev.id || S.selId, devices: list, ...extra }).then(r => { if (!r.error) devSet(S.dev.id || S.selId, r); });
}
function devOnList(m) { if (m.id === S.dev.id) devSet(m.id, m); }
function devOnB(a) {
  const h = a[2] || '', v = new Uint8Array(h.length / 2);
  for (let i = 0; i < v.length; i++) v[i] = parseInt(h.substr(2 * i, 2), 16);
  S.devB[a[1]] = v;
  S.dirty = true;
}
function devOnJ(a) { S.devJ[a[1]] = a.slice(2).map(Number); S.dirty = true; }
function devOnReset() { S.devB = {}; S.devJ = {}; S.devAnim = Object.fromEntries(Object.entries(S.devAnim).filter(([k]) => k.endsWith('snd'))); S.dirty = true; }
// livello a riposo di un pin pilotato da un dispositivo (pulsante esterno, encoder), altrimenti -1
function devRest(k) {
  for (const d of S.dev.list) {
    if (d.type === 'button' && d.pins.pin === k) return d.opt.pressed ? 0 : 1;
    if (d.type === 'encoder' && (d.pins.clk === k || d.pins.dt === k)) return 1;
  }
  return -1;
}

// luminosità 0…1 di un'uscita: PWM del timer se il pin è in funzione alternativa, se no media del simulatore
function lightOf(k, avg, low) {
  if (!k) return 0;
  const { p, pin } = parseKey(k);
  const i = pinInfo(p, pin);
  if (i && i.mode === 2 && i.pwm && i.pwm.duty >= 0) return low ? 1 - i.pwm.duty / 1000 : i.pwm.duty / 1000;
  return avg;
}
const pinLv = k => { if (!k) return null; const { p, pin } = parseKey(k); const i = pinInfo(p, pin); return i ? i.level : null; };
const pinI = k => { if (!k) return null; const { p, pin } = parseKey(k); return pinInfo(p, pin); };
const glow = v => v > 0.02 ? (0.3 + 0.7 * Math.min(1, v)).toFixed(2) : '';

// ------------------------------------------------------------------
// Pannello
function digitSVG(di, dp = true) {
  return `<svg class="seg7" viewBox="-2 0 96 160"><g transform="skewX(-6) translate(14 0)">${
    SEGS.slice(0, 7).map(s => `<polygon class="s" data-seg="${di}:${s}" points="${SEG_SHAPE[s]}"/>`).join('')
  }</g>${dp ? `<circle class="s" data-seg="${di}:dp" cx="86" cy="150" r="5.5"/>` : ''}</svg>`;
}
function devBodyHTML(d) {
  const o = d.opt;
  switch (d.type) {
    case 'seg7mux': return `<div class="dvrow"><div class="digits">${Array.from({ length: devCount(d) }, (_, i) => digitSVG(i)).join('')}</div>
      <div class="dvinfo"><span class="muted small">Si legge</span><span class="dg" data-v="txt">—</span></div></div>`;
    case 'seg7': return `<div class="dvrow"><div class="digits">${digitSVG(0)}</div><div class="dvinfo"><span class="muted small">Cifra mostrata</span><span class="dg" data-v="txt">—</span></div></div>`;
    case 'led': return `<div class="dvrow"><span class="lamp" data-v="lamp" style="--c:${({ red: '#ff3b30', green: '#2fd470', yellow: '#ffd60a', blue: '#3b82f6', white: '#f5f5f5' })[o.color] || '#ff3b30'}"></span><span class="small mono" data-v="txt"></span></div>`;
    case 'rgb': return `<div class="dvrow"><span class="lamp rgb" data-v="lamp"></span><span class="small mono" data-v="txt"></span></div>`;
    case 'bar': return `<div class="dvrow"><div class="bar10">${Array.from({ length: devCount(d) }, (_, i) => `<i data-l="${i}"></i>`).join('')}</div></div>`;
    case 'button': return `<div class="dvrow"><button class="bigbtn" data-act="press" title="Tieni premuto">Premi</button>
      <label class="latch"><input type="checkbox" data-act="latch">fisso</label><span class="small muted" data-v="txt"></span></div>`;
    case 'encoder': return `<div class="dvrow"><button class="small" data-act="ccw" title="Uno scatto in senso antiorario">↺ Antiorario</button>
      <svg class="knob" viewBox="-50 -50 100 100" data-act="knob"><title>Rotella: gira · clic: premi SW</title><circle r="44" class="kb"/><circle r="32" class="kt"/><g data-v="rot"><rect x="-3" y="-30" width="6" height="16" rx="2" class="kn"/></g></svg>
      <button class="small" data-act="cw" title="Uno scatto in senso orario">Orario ↻</button></div>
      <div class="dvrow small"><button class="small ghost" data-act="ccw5" title="5 scatti veloci">↺↺ veloce</button><button class="small ghost" data-act="cw5" title="5 scatti veloci">veloce ↻↻</button>
      <label class="latch" title="Ogni fronte di CLK e DT rimbalza per qualche ms, come i contatti veri"><input type="checkbox" data-opt="bounce" ${o.bounce ? 'checked' : ''}>rimbalzi</label>
      <span class="mono muted" data-v="txt"></span></div>`;
    case 'pot': return `<div class="dvrow"><input type="range" min="0" max="4095" value="${S.devPot[d.id] ?? 2048}" data-act="pot" class="potr"><span class="mono small" data-v="txt"></span></div>`;
    case 'uln': return `<div class="dvrow">${shaftSVG()}<div class="coils">${[1, 2, 3, 4].map(n => `<span class="coil" data-c="${n}">${'ABCD'[n - 1]}</span>`).join('')}</div>
      <div class="dvinfo small"><span data-v="txt" class="mono"></span><span data-v="warn" class="warnt"></span></div></div>`;
    case 'a4988': return `<div class="dvrow">${shaftSVG()}<div class="dvinfo small"><span data-v="txt" class="mono"></span><span data-v="warn" class="warnt"></span></div></div>`;
    case 'servo': return `<div class="dvrow"><svg class="servo" viewBox="-60 -60 120 80"><rect x="-40" y="-14" width="80" height="34" rx="4" class="sb"/><g data-v="rot"><rect x="-5" y="-50" width="10" height="50" rx="5" class="sh"/></g><circle r="8" class="sc"/></svg>
      <div class="dvinfo small"><span data-v="txt" class="mono"></span><span data-v="warn" class="warnt"></span></div></div>`;
    case 'dc': return `<div class="dvrow">${shaftSVG(true)}<div class="dvinfo small"><span data-v="txt" class="mono"></span><span data-v="warn" class="warnt"></span></div></div>`;
    case 'buzzer': return `<div class="dvrow"><span class="buzz" data-v="lamp">♪</span><span class="small mono" data-v="txt"></span>
      <label class="latch" title="Fa sentire il buzzer dalle casse del computer"><input type="checkbox" data-act="sound" ${S.devAnim[d.id + 'snd'] ? 'checked' : ''}>suono</label><span data-v="warn" class="warnt small"></span></div>`;
    case 'keypad': return `<div class="dvrow"><div class="keypad">${KEYS.map((k, i) => `<button data-key="${i}">${k}</button>`).join('')}</div><span class="small muted" data-v="txt"></span></div>`;
  }
  return '';
}
function shaftSVG(fan) {
  return `<svg class="shaft" viewBox="-50 -50 100 100"><circle r="46" class="mb"/><g data-v="rot">${fan
    ? '<path d="M0 0 L-8 -40 A40 40 0 0 1 8 -40 Z M0 0 L34.6 20 A40 40 0 0 1 26.6 33 Z M0 0 L-26.6 33 A40 40 0 0 1 -34.6 20 Z" class="fan"/>'
    : '<rect x="-4" y="-40" width="8" height="40" rx="3" class="ptr"/>'}<circle r="7" class="hub"/></g></svg>`;
}
function devOptsHTML(d) {
  const o = d.opt, chk = (k, t, title = '') => `<label class="latch" title="${title}"><input type="checkbox" data-opt="${k}" ${o[k] ? 'checked' : ''}>${t}</label>`;
  const sel = (k, opts, cur) => `<select data-opt="${k}">${opts.map(([v, t]) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  switch (d.type) {
    case 'seg7mux': return `<label>cifre ${sel('digits', [2, 3, 4, 5, 6, 8].map(n => [n, n]), devCount(d))}</label>
      <label>segmenti accesi con ${sel('segLow', [[1, '0 (anodo comune)'], [0, '1 (catodo comune)']], o.segLow ? 1 : 0)}</label>
      <label>cifra accesa con ${sel('digLow', [[0, '1'], [1, '0']], o.digLow ? 1 : 0)}</label>`;
    case 'seg7': return `<label>segmenti accesi con ${sel('anode', [[0, '1 (catodo comune)'], [1, '0 (anodo comune)']], o.anode ? 1 : 0)}</label>`;
    case 'led': return `<label>colore ${sel('color', [['red', 'rosso'], ['green', 'verde'], ['yellow', 'giallo'], ['blue', 'blu'], ['white', 'bianco']], o.color)}</label>${chk('low', 'acceso con 0', 'LED tra 3,3 V e il pin')}`;
    case 'bar': return `<label>LED ${sel('count', [4, 5, 6, 8, 10, 12, 16].map(n => [n, n]), devCount(d))}</label>${chk('low', 'accesi con 0')}`;
    case 'rgb': return `<label>tipo ${sel('anode', [[0, 'catodo comune (1 = acceso)'], [1, 'anodo comune (0 = acceso)']], o.anode ? 1 : 0)}</label>`;
    case 'button': return `<label>collegamento ${sel('pressed', [[0, 'resistenza di pull-up: premuto = 0'], [1, 'resistenza di pull-down: premuto = 1']], o.pressed ? 1 : 0)}</label>`;
    case 'a4988': return `<label>passi/giro ${sel('stepsRev', [[200, '200 (1,8°)'], [400, '400 (0,9°)'], [48, '48 (7,5°)']], o.stepsRev || 200)}</label>
      <label>microstep ${sel('micro', [1, 2, 4, 8, 16, 32].map(n => [n, '1/' + n]), o.micro || 1)}</label>`;
    case 'buzzer': return `<label>tipo ${sel('kind', [['attivo', 'attivo (suona con 1 sul pin)'], ['passivo', 'passivo (serve un\'onda PWM)']], o.kind)}</label>`;
  }
  return '';
}
function pinOptions(cur, d) {
  const used = new Map();
  for (const x of S.dev.list) for (const [r, k] of Object.entries(x.pins || {})) if (x !== d) used.set(k, DEV_INFO[x.type].short);
  return `<option value="">—</option>` + ALL_PINS.map(k => {
    const lab = ((S.ioc.pins[k] || {}).GPIO_Label || '').replace(/\s*\[.*\]$/, '');
    const u = used.get(k);
    return `<option value="${k}" ${cur === k ? 'selected' : ''}>${k}${lab ? ' · ' + esc(lab) : ''}${u ? ' (già su ' + esc(u) + ')' : ''}</option>`;
  }).join('');
}
function devCardHTML(d, i) {
  const roles = devRoles(d), edit = S.devEdit === d.id;
  const pins = roles.filter(r => d.pins[r]).map(r => `<span><b>${roleName(r)}</b> ${d.pins[r]}</span>`).join('');
  const missing = roles.filter(r => !d.pins[r] && !['dp', 'sw', 'en', 'ena'].includes(r));
  return `<div class="dev" data-i="${i}">
    <div class="dh"><b>${DEV_INFO[d.type].name}</b>
      <button class="small${edit ? ' primary' : ' ghost'}" data-act="edit">${edit ? 'Fatto' : 'Pin e opzioni'}</button>
      <button class="small ghost" data-act="del" title="Togli il dispositivo">✕</button></div>
    ${edit ? `<div class="dcfg">${roles.map(r => `<label>${roleName(r)}<select data-role="${r}">${pinOptions(d.pins[r], d)}</select></label>`).join('')}</div>
      <div class="dopts">${devOptsHTML(d)}</div>`
    : `${devBodyHTML(d)}<div class="dpins small muted">${pins}${missing.length ? `<span class="warnt">non collegati: ${missing.map(roleName).join(', ')}</span>` : ''}</div>`}
  </div>`;
}

function renderDevices() {
  const card = $('#devcard');
  if (!card) return;
  const proj = S.selId;
  if (proj && S.dev.id !== proj && S.devLoading !== proj) { S.devLoading = proj; devLoad(proj).finally(() => { S.devLoading = null; }); }
  const key = JSON.stringify([S.dev, S.devEdit, Object.keys(S.ioc.pins || {}).length]);
  if (key !== S.devKey) {
    S.devKey = key;
    const list = S.dev.list;
    card.innerHTML = `<div class="ch"><h3>Dispositivi</h3><span class="muted small">${list.length ? (S.dev.auto ? 'trovati dalle etichette di CubeMX' : 'collegati ai pin') : ''}</span>
      <select id="devadd" title="Collega un dispositivo alla scheda"><option value="">+ Aggiungi…</option>${Object.entries(DEV_INFO).map(([t, x]) => `<option value="${t}">${x.short}</option>`).join('')}</select>
      ${S.dev.auto ? '' : '<button id="devauto" class="small ghost" title="Torna ai dispositivi trovati dalle etichette di CubeMX">Automatici</button>'}</div>
      ${list.length ? `<div class="devs">${list.map(devCardHTML).join('')}</div>` : `<p class="muted small" style="margin:8px 0 0">Nessun dispositivo. Aggiungine uno dal menu, oppure in CubeMX dai ai pin le etichette <code>A</code>…<code>G</code> (e <code>D1</code>, <code>D2</code>… per le cifre) o <code>CLK</code>/<code>DT</code> dell'encoder: si collegano da soli.</p>`}`;
    devWire(card);
  }
  devUpdate();
}

function devWire(card) {
  $('#devadd').addEventListener('change', e => { const t = e.target.value; if (!t) return; api('/api/devices', { id: S.dev.id, add: t }).then(r => { if (!r.error) { devSet(S.dev.id, r); S.devEdit = r.devices[r.devices.length - 1].id; } }); });
  const au = $('#devauto');
  if (au) au.addEventListener('click', () => { S.devEdit = null; devSave(null, { reset: true }); });
  card.querySelectorAll('.dev').forEach(el => {
    const i = +el.dataset.i, d = S.dev.list[i];
    const change = fn => { const list = JSON.parse(JSON.stringify(S.dev.list)); fn(list[i]); devSave(list); };
    el.querySelector('[data-act="edit"]').addEventListener('click', () => { S.devEdit = S.devEdit === d.id ? null : d.id; S.devKey = ''; S.dirty = true; });
    el.querySelector('[data-act="del"]').addEventListener('click', () => { const list = S.dev.list.filter((_, n) => n !== i); devSave(list); });
    el.querySelectorAll('[data-role]').forEach(s => s.addEventListener('change', () => change(x => { if (s.value) x.pins[s.dataset.role] = s.value; else delete x.pins[s.dataset.role]; })));
    el.querySelectorAll('[data-opt]').forEach(s => s.addEventListener('change', () => change(x => {
      const v = s.type === 'checkbox' ? s.checked : s.value;
      x.opt[s.dataset.opt] = typeof v === 'string' && /^-?\d+$/.test(v) ? (/(Low|anode|pressed)$/.test(s.dataset.opt) ? v === '1' : +v) : v;
    })));
    if (S.devEdit !== d.id) devWireBody(el, d, i);
  });
}

// ------------------------------------------------------------------
// Interazione
function holdDown(btn, on, off) {
  btn.addEventListener('pointerdown', e => { e.preventDefault(); btn.setPointerCapture(e.pointerId); btn.classList.add('down'); on(); });
  const up = () => { if (!btn.classList.contains('down')) return; btn.classList.remove('down'); off(); };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
}
// un clic velocissimo cadrebbe dentro un solo ms simulato: la pressione dura almeno 120 ms
function pressFor(k, v, rest) {
  const st = S.devAnim['p' + k] = S.devAnim['p' + k] || {};
  clearTimeout(st.t);
  if (v !== null) { st.since = performance.now(); cmd(`I ${pinPP(k)} ${v}`); return; }
  const wait = 120 - (performance.now() - (st.since || 0));
  const rel = () => cmd(`I ${pinPP(k)} ${rest}`);
  if (wait > 0) st.t = setTimeout(rel, wait); else rel();
}
// Encoder KY-040: a riposo CLK = DT = 1; ogni scatto sono 4 fronti (quadratura).
// Orario: scende CLK, poi DT, risale CLK, poi DT. Antiorario: prima DT.
function encTurn(d, dir, n = 1, fast = false) {
  const { clk, dt } = d.pins;
  if (!clk || !dt) return;
  const A = pinPP(clk), B = pinPP(dt), lines = [];
  const seq = dir > 0 ? [[A, 0], [B, 0], [A, 1], [B, 1]] : [[B, 0], [A, 0], [B, 1], [A, 1]];
  for (let k = 0; k < n; k++) seq.forEach(([pp, v], j) => {
    const gap = j === 0 ? (fast ? 8 : 50) : (fast ? 1 : 3);
    lines.push(`T ${gap} ${pp} ${v}`);
    if (d.opt.bounce) lines.push(`T 1 ${pp} ${1 - v}`, `T 1 ${pp} ${v}`, `T 1 ${pp} ${1 - v}`, `T 1 ${pp} ${v}`);
  });
  cmd(...lines);
  S.devEnc[d.id] = (S.devEnc[d.id] || 0) + dir * n;
  S.dirty = true;
}
function devWireBody(el, d, i) {
  const q = s => el.querySelector(s);
  if (d.type === 'button' && d.pins.pin) {
    const k = d.pins.pin, pr = d.opt.pressed ? 1 : 0, rest = 1 - pr;
    holdDown(q('[data-act="press"]'), () => pressFor(k, pr, rest), () => { if (!q('[data-act="latch"]').checked) pressFor(k, null, rest); });
    q('[data-act="latch"]').addEventListener('change', e => { if (e.target.checked) pressFor(k, pr, rest); else pressFor(k, null, rest); });
  }
  if (d.type === 'encoder') {
    for (const [a, dir, n, f] of [['ccw', -1, 1, false], ['cw', 1, 1, false], ['ccw5', -1, 5, true], ['cw5', 1, 5, true]]) q(`[data-act="${a}"]`).addEventListener('click', () => encTurn(d, dir, n, f));
    const knob = q('[data-act="knob"]');
    knob.addEventListener('wheel', e => { e.preventDefault(); encTurn(d, e.deltaY > 0 ? 1 : -1); }, { passive: false });
    // col dito: trascinando in tondo gira (uno scatto ogni 24°); un tocco senza girare preme SW
    let giro = null;
    knob.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      e.stopImmediatePropagation(); e.preventDefault();
      try { knob.setPointerCapture(e.pointerId); } catch {}
      const r = knob.getBoundingClientRect();
      giro = { c: [r.left + r.width / 2, r.top + r.height / 2], a: null, acc: 0, girato: false };
    });
    knob.addEventListener('pointermove', e => {
      if (!giro || e.pointerType !== 'touch') return;
      const a = Math.atan2(e.clientY - giro.c[1], e.clientX - giro.c[0]) * 180 / Math.PI;
      if (giro.a !== null) { let da = a - giro.a; if (da > 180) da -= 360; if (da < -180) da += 360; giro.acc += da; }
      giro.a = a;
      while (Math.abs(giro.acc) >= 24) { const dir = Math.sign(giro.acc); encTurn(d, dir); giro.acc -= dir * 24; giro.girato = true; }
    });
    const fineGiro = e => {
      if (!giro || e.pointerType !== 'touch') return;
      if (!giro.girato && d.pins.sw && e.type === 'pointerup') { pressFor(d.pins.sw, 0, -1); pressFor(d.pins.sw, null, -1); }
      giro = null;
    };
    knob.addEventListener('pointerup', fineGiro);
    knob.addEventListener('pointercancel', fineGiro);
    if (d.pins.sw) holdDown(knob, () => pressFor(d.pins.sw, 0, -1), () => pressFor(d.pins.sw, null, -1));
  }
  if (d.type === 'pot') {
    const r = q('[data-act="pot"]');
    const send = () => { const ch = ADC_PIN.indexOf(d.pins.pin); S.devPot[d.id] = +r.value; if (ch >= 0) { S.adcVal[ch] = +r.value; cmd(`V ${ch} ${r.value}`); } S.dirty = true; };
    r.addEventListener('input', send);
  }
  if (d.type === 'buzzer') q('[data-act="sound"]').addEventListener('change', e => { S.devAnim[d.id + 'snd'] = e.target.checked; if (!e.target.checked) buzzStop(d.id); });
  if (d.type === 'keypad') {
    el.querySelectorAll('[data-key]').forEach(b => holdDown(b, () => keyMask(d, i, +b.dataset.key, true), () => keyMask(d, i, +b.dataset.key, false)));
  }
}
function keyMask(d, i, k, on) {
  let m = S.devKeys[d.id] || 0;
  m = on ? m | (1 << k) : m & ~(1 << k);
  S.devKeys[d.id] = m;
  const send = () => cmd(`K ${i * 4} ${m.toString(16)}`);
  if (on) send(); else setTimeout(send, 60);
  S.dirty = true;
}

// buzzer: oscillatore WebAudio (solo dopo un clic, come vuole il browser)
let audioCtx = null;
const buzzOsc = {};
function buzzSet(id, freq, on) {
  if (!on) return buzzStop(id);
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let o = buzzOsc[id];
    if (!o) {
      const g = audioCtx.createGain(); g.gain.value = 0.04; g.connect(audioCtx.destination);
      const osc = audioCtx.createOscillator(); osc.type = 'square'; osc.connect(g); osc.start();
      o = buzzOsc[id] = { osc, g };
    }
    o.osc.frequency.value = Math.min(12000, Math.max(30, freq));
  } catch {}
}
function buzzStop(id) { const o = buzzOsc[id]; if (o) { try { o.osc.stop(); o.g.disconnect(); } catch {} delete buzzOsc[id]; } }

// ------------------------------------------------------------------
// Aggiornamento continuo
function devUpdate() {
  const card = $('#devcard');
  const running = S.server.status === 'running' && S.server.project && S.server.project.id === S.dev.id;
  card.querySelectorAll('.dev').forEach(el => {
    const i = +el.dataset.i, d = S.dev.list[i];
    if (!d || S.devEdit === d.id) return;
    const B = running ? S.devB[i * 4] : null, J = running ? S.devJ[i * 4] : null;
    const set = (sel, txt) => { const x = el.querySelector(`[data-v="${sel}"]`); if (x && x.textContent !== txt) x.textContent = txt; };
    const o = d.opt;
    switch (d.type) {
      case 'seg7mux': case 'seg7': {
        const nd = d.type === 'seg7' ? 1 : devCount(d);
        const low = d.type === 'seg7' ? !!o.anode : !!o.segLow;
        let txt = '';
        for (let di = 0; di < nd; di++) {
          let bits = 0, dp = false;
          SEGS.forEach((s, n) => {
            let v = B ? Math.min(1, B[di * 8 + n] / 255 * nd) : 0;
            if (d.type === 'seg7' && running) v = lightOf(d.pins[s], v, low);
            const x = el.querySelector(`[data-seg="${di}:${s}"]`);
            if (x) { const g = glow(v); x.classList.toggle('on', !!g); x.style.opacity = g; }
            if (v > 0.35) { if (n < 7) bits |= 1 << n; else dp = true; }
          });
          txt += (SEG_DIGIT[bits] ?? '?') + (dp ? '.' : '');
        }
        set('txt', running ? (txt.trim() ? txt : 'spento') : '—');
        break;
      }
      case 'led': case 'buzzer': {
        const v = running ? lightOf(d.pins.pin, B ? B[0] / 255 : 0, !!o.low) : 0;
        const lamp = el.querySelector('[data-v="lamp"]');
        if (d.type === 'led') { lamp.style.opacity = glow(v) || ''; lamp.classList.toggle('on', v > 0.02); set('txt', running ? (v > 0.98 ? 'acceso' : v > 0.02 ? `acceso al ${Math.round(v * 100)}%` : 'spento') : ''); break; }
        const i2 = pinI(d.pins.pin);
        let freq = 0, on = false, warn = '';
        if (o.kind === 'passivo') {
          if (i2 && i2.mode === 2 && i2.pwm && i2.pwm.duty > 0 && i2.pwm.duty < 1000) { freq = i2.pwm.freq; on = true; }
          else if (running && v > 0.02) warn = 'un buzzer passivo vuole un\'onda quadra: usa un canale timer in PWM';
          set('txt', on ? `suona a ${fmtHz(freq)}` : running ? 'muto' : '');
        } else {
          on = v > 0.02; freq = 2300;
          set('txt', on ? (v < 0.98 ? `suona (${Math.round(v * 100)}% del tempo)` : 'suona') : running ? 'muto' : '');
        }
        lamp.classList.toggle('on', on);
        set('warn', warn);
        buzzSet(d.id, freq, on && running && S.devAnim[d.id + 'snd']);
        break;
      }
      case 'rgb': {
        const c = ['r', 'g', 'b'].map((r, n) => running ? lightOf(d.pins[r], B ? B[n] / 255 : 0, !!o.anode) : 0);
        const lamp = el.querySelector('[data-v="lamp"]');
        lamp.style.background = c.some(x => x > 0.02) ? `rgb(${c.map(x => Math.round(40 + 215 * Math.min(1, x))).join(',')})` : '';
        lamp.classList.toggle('on', c.some(x => x > 0.02));
        set('txt', running ? `R ${Math.round(c[0] * 100)}% · G ${Math.round(c[1] * 100)}% · B ${Math.round(c[2] * 100)}%` : '');
        break;
      }
      case 'bar': el.querySelectorAll('[data-l]').forEach(x => { const n = +x.dataset.l; const v = running ? lightOf(d.pins['l' + (n + 1)], B ? B[n] / 255 : 0, !!o.low) : 0; x.classList.toggle('on', v > 0.02); x.style.opacity = glow(v); }); break;
      case 'button': set('txt', d.pins.pin ? `a riposo ${d.opt.pressed ? 0 : 1}, premuto ${d.opt.pressed ? 1 : 0}${running && pinLv(d.pins.pin) !== null ? ' · ora ' + pinLv(d.pins.pin) : ''}` : ''); break;
      case 'encoder': {
        set('txt', running ? `CLK ${pinLv(d.pins.clk) ?? '–'} DT ${pinLv(d.pins.dt) ?? '–'}${d.pins.sw ? ' SW ' + (pinLv(d.pins.sw) ?? '–') : ''}` : '');
        const r = el.querySelector('[data-v="rot"]');
        r.setAttribute('transform', `rotate(${(S.devEnc[d.id] || 0) * 18})`);
        break;
      }
      case 'pot': {
        const v = S.devPot[d.id] ?? 2048, ch = ADC_PIN.indexOf(d.pins.pin);
        // il simulatore riparte con l'ingresso a 0 V: gli mando subito la posizione del cursore
        if (running && ch >= 0 && !S.devAnim[d.id + 'sent']) { S.devAnim[d.id + 'sent'] = 1; S.adcVal[ch] = v; cmd(`V ${ch} ${v}`); }
        set('txt', ch < 0 ? (d.pins.pin ? `${d.pins.pin} non è un ingresso analogico` : '') : `${(v * 3.3 / 4095).toFixed(2)} V · ADC1 canale ${ch} · ${v}`);
        break;
      }
      case 'uln': {
        [1, 2, 3, 4].forEach(n => { const c = el.querySelector(`[data-c="${n}"]`); c.classList.toggle('on', running && pinLv(d.pins['in' + n]) === 1); });
        const pos = J ? J[0] : 0, ang = pos * 360 / 4096;
        S.devAnim[d.id] = ang;
        const mode = J ? J[3] & 3 : 0, pat = J ? J[3] >> 2 : 0;
        const ones = [1, 2, 4, 8].filter(b => pat & b).length;
        set('txt', `${pos} mezzi passi · ${ang.toFixed(1)}° · ${(pos / 4096).toFixed(2)} giri${mode ? ' · ' + (mode === 1 ? 'half-step' : ones === 1 ? 'full-step a 1 fase' : 'full-step a 2 fasi') : ''}`);
        set('warn', !J ? '' : [J[1] ? `sequenza sbagliata ${J[1]} volte (il rotore vibra invece di girare)` : '', J[2] ? `${J[2]} passi troppo veloci: il motore vero li perde (almeno ~2 ms per passo)` : ''].filter(Boolean).join(' · '));
        break;
      }
      case 'a4988': {
        const spr = (o.stepsRev || 200) * (o.micro || 1);
        const st = S.devAnim[d.id + 'st'] = S.devAnim[d.id + 'st'] || { pwm: 0, t: performance.now() };
        const si = pinI(d.pins.step), now = performance.now();
        // STEP generato da un timer in PWM: i passi sono la frequenza (il simulatore conta solo i fronti scritti dal codice)
        if (running && si && si.mode === 2 && si.pwm && si.pwm.duty > 0 && si.pwm.duty < 1000) {
          const en = !d.pins.en || pinLv(d.pins.en) === 0, dir = d.pins.dir && pinLv(d.pins.dir) === 1 ? 1 : -1;
          if (en) st.pwm += dir * si.pwm.freq * (now - st.t) / 1000 * (S.server.speed || 1);
        }
        st.t = now;
        const pos = (J ? J[0] : 0) + Math.round(st.pwm), ang = pos * 360 / spr;
        S.devAnim[d.id] = ang;
        set('txt', `${pos} passi · ${ang.toFixed(1)}° · ${(pos / spr).toFixed(2)} giri${d.pins.en ? ' · EN ' + (pinLv(d.pins.en) === 1 ? '1 (driver spento)' : '0 (acceso)') : ''}`);
        set('warn', J && J[1] ? `${J[1]} impulsi STEP con EN = 1: il driver è spento e il motore non si muove` : '');
        break;
      }
      case 'servo': {
        const i2 = pinI(d.pins.pin);
        let txt = '', warn = '';
        if (!running || !i2) txt = '';
        else if (i2.mode !== 2 || !i2.pwm || i2.pwm.duty < 0) warn = 'il servo vuole un segnale PWM da un canale timer (es. TIM2_CH1)';
        else {
          const f = i2.pwm.freq, pulse = f ? i2.pwm.duty / 1000 / f * 1000 : 0;
          const ang = Math.max(0, Math.min(180, (pulse - 1) * 180));
          S.devAnim[d.id] = ang - 90;
          txt = `${ang.toFixed(0)}° · impulso ${pulse.toFixed(2)} ms · ${fmtHz(f)}`;
          if (f < 40 || f > 60) warn = `frequenza ${fmtHz(f)}: il servo vuole 50 Hz (periodo 20 ms)`;
          else if (pulse < 0.9 || pulse > 2.1) warn = 'impulso fuori da 1–2 ms: il servo va a fine corsa';
        }
        set('txt', txt); set('warn', warn);
        break;
      }
      case 'dc': {
        const v = ['in1', 'in2', 'ena'].map((r, n) => running ? lightOf(d.pins[r], B ? B[n] / 255 : 0, false) : 0);
        const en = d.pins.ena ? v[2] : (running ? 1 : 0);
        const eff = (v[0] - v[1]) * en;
        S.devAnim[d.id + 'v'] = eff;
        const brake = running && v[0] > 0.5 && v[1] > 0.5;
        set('txt', !running ? '' : Math.abs(eff) < 0.02 ? (brake ? 'fermo (freno: IN1 = IN2 = 1)' : 'fermo') : `${eff > 0 ? 'avanti' : 'indietro'} · velocità ${Math.round(Math.abs(eff) * 100)}%`);
        set('warn', '');
        break;
      }
      case 'keypad': {
        const m = S.devKeys[d.id] || 0;
        set('txt', m ? 'premuti: ' + KEYS.filter((_, k) => m >> k & 1).join(' ') : 'righe in uscita, colonne in ingresso con pull-up');
        break;
      }
    }
  });
}
// animazioni dei motori (ogni fotogramma)
function devFrame() {
  const card = $('#devcard');
  if (!card) return;
  const now = performance.now();
  card.querySelectorAll('.dev').forEach(el => {
    const d = S.dev.list[+el.dataset.i];
    if (!d) return;
    const r = el.querySelector('[data-v="rot"]');
    if (!r) return;
    if (d.type === 'dc') {
      const a = S.devAnim[d.id + 'a'] || { ang: 0, t: now };
      a.ang += (S.devAnim[d.id + 'v'] || 0) * 1080 * (now - a.t) / 1000;
      a.t = now;
      S.devAnim[d.id + 'a'] = a;
      r.setAttribute('transform', `rotate(${a.ang % 360})`);
    } else if (d.type === 'uln' || d.type === 'a4988' || d.type === 'servo') {
      if (d.type === 'a4988') devUpdate();
      r.setAttribute('transform', `rotate(${S.devAnim[d.id] || 0})`);
    }
  });
}
