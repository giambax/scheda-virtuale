// devlogic.js — dispositivi collegati ai pin: tipi, ricerca automatica dalle etichette del .ioc
// e righe di configurazione per il simulatore. Copiato da scheda-virtuale/server.js (righe 315–459)
// senza la parte che legge/salva su disco (qui lo fa local-server.js con IndexedDB).
// Dispositivi collegati ai pin (display, encoder, pulsanti, LED, motori…), salvati per progetto
// in settings.json "devices". Se il progetto non ne ha di salvati si trovano dalle etichette del .ioc.
const DEV_TYPES = {
  seg7mux: { roles: n => [...'abcdefg', 'dp', ...Array.from({ length: n }, (_, i) => 'd' + (i + 1))] },
  seg7: { roles: () => [...'abcdefg', 'dp'] },
  led: { roles: () => ['pin'] },
  rgb: { roles: () => ['r', 'g', 'b'] },
  bar: { roles: n => Array.from({ length: n }, (_, i) => 'l' + (i + 1)) },
  button: { roles: () => ['pin'] },
  encoder: { roles: () => ['clk', 'dt', 'sw'] },
  pot: { roles: () => ['pin'] },
  uln: { roles: () => ['in1', 'in2', 'in3', 'in4'] },
  a4988: { roles: () => ['step', 'dir', 'en'] },
  servo: { roles: () => ['pin'] },
  dc: { roles: () => ['in1', 'in2', 'ena'] },
  buzzer: { roles: () => ['pin'] },
  keypad: { roles: () => ['r1', 'r2', 'r3', 'r4', 'c1', 'c2', 'c3', 'c4'] },
};
const devCount = d => d.type === 'seg7mux' ? Math.min(8, Math.max(2, d.opt.digits || 3)) : d.type === 'bar' ? Math.min(16, Math.max(2, d.opt.count || 8)) : 0;
// etichette CubeMX che fanno trovare il pin da solo (maiuscole, senza " [Blue PushButton]")
const ROLE_LABELS = {
  a: ['A', 'SEG_A', 'SEGA', 'A_SEG'], b: ['B', 'SEG_B', 'SEGB', 'B_SEG'], c: ['C', 'SEG_C', 'SEGC', 'C_SEG'], d: ['D', 'SEG_D', 'SEGD', 'D_SEG'],
  e: ['E', 'SEG_E', 'SEGE', 'E_SEG'], f: ['F', 'SEG_F', 'SEGF', 'F_SEG'], g: ['G', 'SEG_G', 'SEGG', 'G_SEG'], dp: ['DP', 'DOT', 'SEG_DP', 'PUNTO', 'DP_SEG'],
  step: ['STEP', 'STP'], dir: ['DIR'], en: ['EN', 'ENABLE', 'EN_STEP'], ena: ['ENA', 'EN_A', 'ENA_PWM', 'PWM_A', 'EN'],
  in1: ['IN1'], in2: ['IN2'], in3: ['IN3'], in4: ['IN4'],
  servo: ['SERVO', 'SERVO_PWM', 'PWM_SERVO'], buzzer: ['BUZZER', 'BUZ', 'CICALINO', 'BUZZ'], pot: ['POT', 'POTENZIOMETRO', 'POT1', 'TRIMMER'],
  led: ['LED', 'LED1', 'LED_EXT', 'LED_EST'], button: ['PULS', 'BTN', 'BUTTON', 'PULSANTE', 'P1', 'BTN1', 'PULS1', 'SW1'],
  r: ['R', 'LED_R', 'RED', 'ROSSO', 'RGB_R'], g_: ['LED_G', 'GREEN', 'VERDE', 'RGB_G'], b_: ['LED_B', 'BLUE', 'BLU', 'RGB_B'],
};
for (let i = 1; i <= 8; i++) ROLE_LABELS['d' + i] = ['D' + i, 'DIG' + i, 'DIGIT' + i, 'CIFRA' + i, 'COM' + i, 'DIG_' + i, 'D_' + i];
for (let i = 1; i <= 16; i++) ROLE_LABELS['l' + i] = ['L' + i, 'LED' + i, 'BAR' + i, 'LED_' + i];
for (let i = 1; i <= 4; i++) { ROLE_LABELS['r' + i] = ['R' + i, 'ROW' + i, 'RIGA' + i, 'ROW_' + i]; ROLE_LABELS['c' + i] = ['C' + i, 'COL' + i, 'COLONNA' + i, 'COL_' + i]; }
const ENC_PAIRS = [['CLK', 'DT'], ['CA', 'CB'], ['ENC_A', 'ENC_B'], ['ENCA', 'ENCB'], ['A_ENC', 'B_ENC'], ['ROT_A', 'ROT_B'], ['S1', 'S2']];
const ENC_SW = ['SW', 'ENC_SW', 'SW_ENC', 'ENC_BTN', 'KEY'];

function iocLabels(ioc) {
  const m = new Map();
  for (const [k, v] of Object.entries(ioc.pins || {})) {
    const lab = String(v.GPIO_Label || '').replace(/\s*\[.*\]\s*$/, '').trim().toUpperCase();
    if (lab && !m.has(lab)) m.set(lab, k);
  }
  return m;
}
function rolePins(type, n, labels, used, ioc) {
  const pins = {};
  for (const r of DEV_TYPES[type].roles(n)) {
    let names = ROLE_LABELS[r] || [];
    if (type === 'rgb') names = r === 'r' ? ROLE_LABELS.r : r === 'g' ? ROLE_LABELS.g_ : ROLE_LABELS.b_;
    if (type === 'led') names = ROLE_LABELS.led;
    if (type === 'button') names = ROLE_LABELS.button;
    if (type === 'servo') names = ROLE_LABELS.servo;
    if (type === 'buzzer') names = ROLE_LABELS.buzzer;
    if (type === 'pot') names = ROLE_LABELS.pot;
    if (type === 'a4988' && r === 'en') names = ROLE_LABELS.en;
    if (type === 'dc' && r === 'ena') names = ROLE_LABELS.ena;
    const k = names.map(x => labels.get(x)).find(k => k && !used.has(k));
    if (k) { pins[r] = k; used.add(k); }
  }
  if (type === 'encoder') {
    for (const [a, b] of ENC_PAIRS) if (labels.has(a) && labels.has(b) && !used.has(labels.get(a))) { pins.clk = labels.get(a); pins.dt = labels.get(b); break; }
    const sw = ENC_SW.map(x => labels.get(x)).find(k => k && !used.has(k));
    if (sw) pins.sw = sw;
  }
  return pins;
}
let devSeq = 0;
const newDevId = () => 'd' + Date.now().toString(36) + (devSeq++).toString(36);
function makeDevice(type, ioc, others = []) {
  const labels = iocLabels(ioc);
  const used = new Set(others.flatMap(d => Object.values(d.pins || {})));
  const opt = {};
  if (type === 'seg7mux') {
    let n = 0;
    while (n < 8 && ROLE_LABELS['d' + (n + 1)].some(x => labels.has(x))) n++;
    opt.digits = n >= 2 ? n : 3;
    opt.segLow = true; opt.digLow = false;          // anodo comune con transistor sugli anodi (5361BS + BC107/BC212)
  }
  if (type === 'bar') opt.count = 8;
  if (type === 'seg7') opt.anode = false;
  if (type === 'a4988') { opt.stepsRev = 200; opt.micro = 1; }
  if (type === 'buzzer') opt.kind = 'attivo';
  if (type === 'led') opt.color = 'red';
  const d = { id: newDevId(), type, pins: {}, opt };
  d.pins = rolePins(type, devCount(d), labels, used, ioc);
  if (type === 'button' && d.pins.pin) d.opt.pressed = /PULLDOWN/.test((ioc.pins[d.pins.pin] || {}).GPIO_PuPd || '') ? 1 : 0;
  if (type === 'button' && d.opt.pressed === undefined) d.opt.pressed = 0;
  return d;
}
// dispositivi trovati da soli: display (A…G, DP/DOT, D1…Dn) ed encoder (CLK/DT, CA/CB…)
function autoDevices(ioc) {
  const labels = iocLabels(ioc), out = [];
  if ([...'ABCDEFG'].every(s => ROLE_LABELS[s.toLowerCase()].some(x => labels.has(x)))) {
    const mux = ROLE_LABELS.d1.some(x => labels.has(x)) && ROLE_LABELS.d2.some(x => labels.has(x));
    out.push(makeDevice(mux ? 'seg7mux' : 'seg7', ioc, out));
    out[out.length - 1].id = 'auto0';
  }
  if (ENC_PAIRS.some(([a, b]) => labels.has(a) && labels.has(b))) { out.push(makeDevice('encoder', ioc, out)); out[out.length - 1].id = 'auto1'; }
  return out;
}
const PIN_RE = /^P[A-EH]\d{1,2}$/;
function cleanDevices(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 16).filter(d => d && DEV_TYPES[d.type]).map(d => {
    const opt = {};
    for (const [k, v] of Object.entries(d.opt || {})) if (/^\w{1,20}$/.test(k) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length < 40))) opt[k] = v;
    const c = { id: typeof d.id === 'string' && /^\w{1,40}$/.test(d.id) ? d.id : newDevId(), type: d.type, opt, pins: {} };
    if (typeof d.name === 'string') c.name = d.name.slice(0, 40);
    for (const r of DEV_TYPES[d.type].roles(devCount(c))) if (PIN_RE.test((d.pins || {})[r])) c.pins[r] = d.pins[r];
    return c;
  });
}
const PORT_IDX = { A: 0, B: 1, C: 2, D: 3, E: 4, H: 7 };
const pinNum = k => PIN_RE.test(k || '') ? PORT_IDX[k[1]] * 16 + Number(k.slice(2)) : -1;
const pinPP = k => `${PORT_IDX[k[1]]} ${Number(k.slice(2))}`;
// righe per il simulatore: gruppi "D" (indice = posizione del dispositivo × 4 + sottogruppo) e livelli a riposo "I"
function deviceSimLines(devices) {
  const out = ['D -'];
  devices.forEach((d, i) => {
    const P = r => pinNum(d.pins[r]), g = i * 4, o = d.opt || {};
    const L = (sub, sl, dl, digs, segs) => out.push(`D ${g + sub} L ${sl ? 1 : 0} ${dl ? 1 : 0} ${digs.length} ${digs.join(' ')} ${segs.length} ${segs.join(' ')}`);
    const segs = [...'abcdefg', 'dp'].map(P);
    switch (d.type) {
      case 'seg7mux': L(0, o.segLow, o.digLow, Array.from({ length: devCount(d) }, (_, n) => P('d' + (n + 1))), segs); break;
      case 'seg7': L(0, o.anode, 0, [-1], segs); break;
      case 'led': case 'buzzer': L(0, o.low, 0, [-1], [P('pin')]); break;
      case 'rgb': L(0, o.anode, 0, [-1], ['r', 'g', 'b'].map(P)); break;
      case 'bar': L(0, o.low, 0, [-1], Array.from({ length: devCount(d) }, (_, n) => P('l' + (n + 1)))); break;
      case 'dc': L(0, 0, 0, [-1], ['in1', 'in2', 'ena'].map(P)); break;
      case 'uln': out.push(`D ${g} U ${['in1', 'in2', 'in3', 'in4'].map(P).join(' ')}`); break;
      case 'a4988': out.push(`D ${g} S ${['step', 'dir', 'en'].map(P).join(' ')}`); break;
      case 'keypad': out.push(`D ${g} K ${DEV_TYPES.keypad.roles().map(P).join(' ')}`); break;
      case 'button': if (d.pins.pin) out.push(`I ${pinPP(d.pins.pin)} ${o.pressed ? 0 : 1}`); break;
      case 'encoder':   // il KY-040 ha le resistenze di pull-up su CLK e DT: a riposo valgono 1
        for (const r of ['clk', 'dt']) if (d.pins[r]) out.push(`I ${pinPP(d.pins[r])} 1`);
        break;
    }
  });
  return out;
}

export { DEV_TYPES, devCount, makeDevice, autoDevices, cleanDevices, deviceSimLines, pinPP };
