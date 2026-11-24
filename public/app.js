'use strict';
/* Scheda Virtuale STM32 — interfaccia */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PORT_L = { 0: 'A', 1: 'B', 2: 'C', 3: 'D', 4: 'E', 7: 'H' };
const RESET_MODER = { 0: 0xA8000000, 1: 0x00000280 };
const BOARD_PULLUP = { 'PC13': 1 };
const ARD = { PA3: 'D0', PA2: 'D1', PA10: 'D2', PB3: 'D3', PB5: 'D4', PB4: 'D5', PB10: 'D6', PA8: 'D7', PA9: 'D8', PC7: 'D9', PB6: 'D10', PA7: 'D11', PA6: 'D12', PA5: 'D13', PB9: 'D14', PB8: 'D15', PA0: 'A0', PA1: 'A1', PA4: 'A2', PB0: 'A3', PC1: 'A4', PC0: 'A5' };
const TIMN = ['TIM1', 'TIM2', 'TIM3', 'TIM4', 'TIM5', 'TIM9', 'TIM10', 'TIM11'];
const TIMAF = [1, 1, 2, 2, 2, 3, 3, 3];
const TMAP = [[0,0,0,0,8],[0,1,0,0,9],[0,2,0,0,10],[0,3,0,0,11],[0,0,1,0,7],[0,0,1,1,13],[0,1,1,1,0],[0,1,1,1,14],[0,2,1,1,1],[0,2,1,1,15],
  [1,0,0,0,0],[1,0,0,0,5],[1,0,0,0,15],[1,1,0,0,1],[1,1,0,1,3],[1,2,0,0,2],[1,2,0,1,10],[1,3,0,0,3],
  [2,0,0,0,6],[2,0,0,1,4],[2,0,0,2,6],[2,1,0,0,7],[2,1,0,1,5],[2,1,0,2,7],[2,2,0,1,0],[2,2,0,2,8],[2,3,0,1,1],[2,3,0,2,9],
  [3,0,0,1,6],[3,1,0,1,7],[3,2,0,1,8],[3,3,0,1,9],[4,0,0,0,0],[4,1,0,0,1],[4,2,0,0,2],[4,3,0,0,3],[5,0,0,0,2],[5,1,0,0,3],[6,0,0,1,8],[7,0,0,1,9]];
const USART_AF = { 'PA9:7': 'USART1_TX', 'PA10:7': 'USART1_RX', 'PB6:7': 'USART1_TX', 'PB7:7': 'USART1_RX', 'PA2:7': 'USART2_TX', 'PA3:7': 'USART2_RX', 'PC6:8': 'USART6_TX', 'PC7:8': 'USART6_RX', 'PA11:8': 'USART6_TX', 'PA12:8': 'USART6_RX' };
const ADC_PIN = ['PA0','PA1','PA2','PA3','PA4','PA5','PA6','PA7','PB0','PB1','PC0','PC1','PC2','PC3','PC4','PC5'];
const STATUS_TXT = { idle: 'Pronta', building: 'Compilazione…', running: 'In esecuzione', stopped: 'Ferma', crashed: 'HardFault', error: 'Errori di compilazione' };

const S = {
  projects: [], selId: null, proj: null, files: [], ioc: { pins: {} }, curFile: null,
  server: {}, ports: {}, pwm: {}, adc: {}, adcVal: {},
  ms: 0, tick: 0, primask: 0, clocks: null,
  irq: {}, irqRate: {}, irqLast: null,
  uart: {}, uartSel: '2', serialChunks: [], baud: {},
  inputs: {}, warnCount: 0,
  pinsKey: '', dirty: true,
};
devInitState();

// ------------------------------------------------------------------
// API
const api = (p, body) => fetch(p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const cmd = (...lines) => api('/api/cmd', { lines });

// ------------------------------------------------------------------
// Scheda (SVG)
const HDR = {
  left1: { x: 70, y0: 262, labels: ['NC', 'IOREF', 'RESET', '3V3', '5V', 'GND', 'GND', 'VIN'], pins: [] },
  left2: { x: 70, y0: 430, labels: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'], pins: ['PA0', 'PA1', 'PA4', 'PB0', 'PC1', 'PC0'] },
  right1: { x: 330, y0: 262, labels: ['D15', 'D14', 'AREF', 'GND', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'], pins: ['PB8', 'PB9', '', '', 'PA5', 'PA6', 'PA7', 'PB6', 'PC7', 'PA9'] },
  right2: { x: 330, y0: 452, labels: ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'], pins: ['PA8', 'PB10', 'PB4', 'PB5', 'PB3', 'PA10', 'PA2', 'PA3'] },
};
function boardSVG() {
  const g = [];
  g.push(`<svg viewBox="0 0 400 640" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Scheda NUCLEO-F401RE">
  <defs>
    <filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="pcb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfbf8"/><stop offset="1" stop-color="#ecece6"/></linearGradient>
    <linearGradient id="usb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8eaee"/><stop offset="1" stop-color="#9aa0aa"/></linearGradient>
    <radialGradient id="cap" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#5aa0ff"/><stop offset="1" stop-color="#1450b8"/></radialGradient>
    <radialGradient id="capk" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#555"/><stop offset="1" stop-color="#111"/></radialGradient>
  </defs>
  <rect x="8" y="14" width="384" height="618" rx="16" fill="url(#pcb)" stroke="#cfcfc6"/>
  <g fill="#d6d6cf">${[[22, 28], [378, 28], [22, 618], [378, 618], [22, 172], [378, 172]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6"/><circle cx="${x}" cy="${y}" r="3" fill="#fff"/>`).join('')}</g>
  <rect x="172" y="2" width="56" height="34" rx="4" fill="url(#usb)" stroke="#7c828c"/>
  <rect x="182" y="10" width="36" height="10" rx="2" fill="#2c2f35"/>
  <text x="200" y="58" text-anchor="middle" font-size="9" fill="#8a8a82" font-family="system-ui">ST-LINK</text>
  <rect x="230" y="70" width="40" height="40" rx="3" fill="#1d1f23"/><rect x="236" y="76" width="28" height="28" rx="2" fill="#26292e"/>
  <g id="ld1"><circle cx="140" cy="72" r="6" fill="#3a2020" stroke="#bbb" stroke-width=".6"/><circle class="glow" cx="140" cy="72" r="5" fill="none"/></g>
  <text x="140" y="92" text-anchor="middle" font-size="8.5" fill="#777" font-family="system-ui">LD1 COM</text>
  <g id="ld3"><circle cx="320" cy="128" r="5" fill="#ff3b30" filter="url(#glow)"/></g>
  <text x="320" y="146" text-anchor="middle" font-size="8.5" fill="#777" font-family="system-ui">LD3 PWR</text>
  <line x1="18" y1="172" x2="382" y2="172" stroke="#c9c9c0" stroke-dasharray="4 5" stroke-width="1.5"/>
  <text x="30" y="122" font-size="11" font-weight="700" fill="#2b2b2b" font-family="system-ui">NUCLEO-F401RE</text>
  <text x="30" y="136" font-size="8.5" fill="#888" font-family="system-ui">scheda virtuale</text>`);
  // B1 e B2
  g.push(`<g id="b1" style="cursor:pointer"><rect x="72" y="188" width="44" height="44" rx="6" fill="#c9cbd0" stroke="#9a9ca2"/><circle id="b1cap" cx="94" cy="210" r="14" fill="url(#cap)" stroke="#0f3f93"/></g>
  <text x="94" y="246" text-anchor="middle" font-size="8.5" fill="#555" font-family="system-ui" font-weight="600">B1 USER</text>
  <g id="b2" style="cursor:pointer"><rect x="284" y="188" width="44" height="44" rx="6" fill="#c9cbd0" stroke="#9a9ca2"/><circle id="b2cap" cx="306" cy="210" r="14" fill="url(#capk)" stroke="#000"/></g>
  <text x="306" y="246" text-anchor="middle" font-size="8.5" fill="#555" font-family="system-ui" font-weight="600">B2 RESET</text>`);
  // LD2
  g.push(`<g id="ld2"><rect x="238" y="328" width="14" height="9" rx="2" fill="#dfe6df" stroke="#9fb39f"/><circle class="core" cx="245" cy="332.5" r="3.4" fill="#2d4a33"/><circle class="glow" cx="245" cy="332.5" r="7" fill="#35ff7a" opacity="0" filter="url(#glow)"/></g>
  <text x="245" y="350" text-anchor="middle" font-size="8.5" fill="#555" font-family="system-ui" font-weight="600">LD2</text>`);
  // MCU a 45°
  g.push(`<g transform="rotate(45 200 400)">`);
  for (let i = 0; i < 16; i++) {
    const o = 156 + i * 5.9;
    g.push(`<rect x="${o}" y="346" width="3" height="10" fill="#b9bcc2"/><rect x="${o}" y="444" width="3" height="10" fill="#b9bcc2"/><rect x="146" y="${o + 200}" width="10" height="3" fill="#b9bcc2"/><rect x="244" y="${o + 200}" width="10" height="3" fill="#b9bcc2"/>`);
  }
  g.push(`<rect x="154" y="354" width="92" height="92" rx="4" fill="#1b1d21"/><circle cx="166" cy="366" r="3" fill="#2c2f35"/></g>
  <text x="200" y="398" text-anchor="middle" font-size="10" fill="#d9dbe0" font-family="system-ui" font-weight="700">STM32</text>
  <text x="200" y="411" text-anchor="middle" font-size="8" fill="#a9adb5" font-family="system-ui">F401RET6</text>`);
  // morpho (decorativi)
  const morpho = [28, 42, 358, 372];
  for (const x of morpho) for (let i = 0; i < 19; i++) g.push(`<rect x="${x - 5}" y="${262 + i * 18.5 - 5}" width="10" height="10" fill="#26282c" rx="1"/><circle cx="${x}" cy="${262 + i * 18.5}" r="2" fill="#b39b55"/>`);
  // header Arduino
  for (const [key, h] of Object.entries(HDR)) {
    const left = key.startsWith('left');
    h.labels.forEach((lab, i) => {
      const y = h.y0 + i * 18, pin = h.pins[i] || '';
      g.push(`<rect x="${h.x - 7}" y="${y - 7}" width="14" height="14" fill="#141518" rx="1.5"/>`);
      g.push(`<circle class="hp${pin ? '' : ' np'}" data-pin="${pin}" cx="${h.x}" cy="${y}" r="3.2" fill="#c8a85a"/>`);
      const tx = left ? h.x + 13 : h.x - 13;
      g.push(`<text x="${tx}" y="${y + 3.2}" text-anchor="${left ? 'start' : 'end'}" font-size="9" fill="#444" font-family="ui-monospace,Menlo,monospace">${lab}${pin ? `<tspan fill="#9a9a92" font-size="7.5"> ${pin}</tspan>` : ''}</text>`);
    });
  }
  g.push(`<text x="70" y="248" text-anchor="middle" font-size="8" fill="#888" font-family="system-ui">CN6</text><text x="70" y="416" text-anchor="middle" font-size="8" fill="#888" font-family="system-ui">CN8</text>
  <text x="330" y="250" text-anchor="middle" font-size="8" fill="#888" font-family="system-ui">CN5</text><text x="330" y="440" text-anchor="middle" font-size="8" fill="#888" font-family="system-ui">CN9</text>
  <rect x="150" y="560" width="100" height="44" rx="4" fill="#e6e6df" stroke="#cfcfc6"/><text x="200" y="586" text-anchor="middle" font-size="9" fill="#9a9a92" font-family="system-ui">STM32 Nucleo-64</text>
  </svg>`);
  return g.join('');
}

function setupBoard() {
  $('#board').innerHTML = boardSVG();
  const b1 = $('#b1');
  const down = e => { e.preventDefault(); pressB1(true); };
  const up = () => pressB1(false);
  b1.addEventListener('pointerdown', down);
  b1.addEventListener('pointerup', up);
  b1.addEventListener('pointerleave', up);
  $('#b2').addEventListener('click', () => doReset());
  window.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'b' && !e.repeat && !isTyping(e)) pressB1(true); });
  window.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'b' && !isTyping(e)) pressB1(false); });
  $$('#board .hp').forEach(c => {
    if (!c.dataset.pin) return;
    c.addEventListener('pointerdown', e => { const k = c.dataset.pin; if (isInputPin(k)) { e.preventDefault(); holdPin(k, true); const up2 = () => { holdPin(k, false); window.removeEventListener('pointerup', up2); }; window.addEventListener('pointerup', up2); } });
    c.addEventListener('mouseenter', () => { c.setAttribute('r', '4.2'); });
    c.addEventListener('mouseleave', () => { c.setAttribute('r', '3.2'); });
    c.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'title')).textContent = (ARD[c.dataset.pin] || '') + ' · ' + c.dataset.pin;
  });
}
const isTyping = e => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);

let b1Down = false;
function pressB1(on) {
  if (b1Down === on) return;
  b1Down = on;
  $('#b1cap').setAttribute('r', on ? 12.5 : 14);
  holdPin('PC13', on);
}

// ------------------------------------------------------------------
// Pin
const keyOf = (p, pin) => 'P' + PORT_L[p] + pin;
function parseKey(k) { const p = +Object.keys(PORT_L).find(i => PORT_L[i] === k[1]); return { p, pin: +k.slice(2) }; }

function pinInfo(p, pin) {
  const port = S.ports[p];
  if (!port) return null;
  const key = keyOf(p, pin);
  const mode = (port.moder >>> (2 * pin)) & 3, pull = (port.pupdr >>> (2 * pin)) & 3, od = (port.otyper >>> pin) & 1;
  const af = pin < 8 ? (port.afrl >>> (4 * pin)) & 15 : (port.afrh >>> (4 * (pin - 8))) & 15;
  const ioc = S.ioc.pins[key] || {};
  const label = (ioc.GPIO_Label || '').trim();
  const exti = (port.exti >>> pin) & 1 ? { r: (port.rt >>> pin) & 1, f: (port.ft >>> pin) & 1 } : null;
  let func = '';
  if (mode === 2) {
    const t = TMAP.find(t => t[3] === p && t[4] === pin && TIMAF[t[0]] === af);
    if (t) func = `${TIMN[t[0]]}_CH${t[1] + 1}${t[2] ? 'N' : ''}`;
    else func = USART_AF[`${key}:${af}`] || `AF${af}`;
  }
  const adcCh = Object.keys(S.adc).find(ch => S.adc[ch] === key);
  const idle = pull === 1 ? 1 : pull === 2 ? 0 : BOARD_PULLUP[key] ? 1 : 0;
  return { p, pin, key, mode, pull, od, af, func, label, exti, adcCh, idle, level: (port.level >>> pin) & 1, pwm: S.pwm[key] };
}

function activePins() {
  const out = [];
  for (const p of Object.keys(S.ports).map(Number)) {
    for (let pin = 0; pin < 16; pin++) {
      const i = pinInfo(p, pin);
      if (!i) continue;
      const debug = (p === 0 && (pin === 13 || pin === 14)) || (p === 1 && pin === 3 && i.mode === 2 && i.af === 0);
      const osc = (p === 2 && (pin === 14 || pin === 15)) || p === 7;
      const resetMode = ((RESET_MODER[p] || 0) >>> (2 * pin)) & 3;
      if (debug || osc) continue;
      if (i.mode !== resetMode || i.exti || i.adcCh !== undefined || (i.label && !/^(TMS|TCK|SWO)$/.test(i.label))) out.push(i);
    }
  }
  return out;
}

function isInputPin(k) { const { p, pin } = parseKey(k); const i = pinInfo(p, pin); return i && i.mode === 0; }

// una pressione dura almeno 120 ms (un clic velocissimo cadrebbe dentro un solo ms simulato)
function holdPin(k, on) {
  const st = S.inputs[k] = S.inputs[k] || { held: false, latched: false };
  clearTimeout(st.timer);
  if (on) { st.held = true; st.since = performance.now(); sendInput(k); return; }
  if (!st.held) return;
  const wait = 120 - (performance.now() - (st.since || 0));
  const release = () => { st.held = false; sendInput(k); };
  if (wait > 0) st.timer = setTimeout(release, wait); else release();
}
function sendInput(k) {
  const { p, pin } = parseKey(k);
  const i = pinInfo(p, pin);
  const st = S.inputs[k] || {};
  const idle = i ? i.idle : (BOARD_PULLUP[k] ? 1 : 0);
  const v = st.held || st.latched ? 1 - idle : devRest(k);
  cmd(`I ${p} ${pin} ${v}`);
  const btn = document.querySelector(`.press[data-k="${k}"]`);
  if (btn) btn.classList.toggle('down', !!(st.held || st.latched));
}

function pinRowHTML(i) {
  const ard = ARD[i.key] ? `<span class="ard">${ARD[i.key]}</span>` : '';
  const lab = i.label ? `<span class="lab">${esc(i.label)}</span>` : '';
  const pull = ['', 'pull-up', 'pull-down', ''][i.pull];
  let cls = 'pin', desc = '', ctrl = '', tag = '';
  if (i.exti) tag += `<span class="tag exti">EXTI${i.pin} ${i.exti.r && i.exti.f ? '↑↓' : i.exti.r ? '↑' : '↓'}</span>`;
  if (i.adcCh !== undefined) {
    cls += ' an';
    desc = `Ingresso analogico · ADC1 canale ${i.adcCh}`;
    const v = S.adcVal[i.adcCh] ?? 0;
    ctrl = `<div class="adc"><input type="range" min="0" max="4095" value="${v}" data-ch="${i.adcCh}"><span class="mono small" data-adcv="${i.adcCh}">${(v * 3.3 / 4095).toFixed(2)} V</span></div>`;
  } else if (i.mode === 1) {
    cls += ' out';
    desc = `Uscita ${i.od ? 'open-drain' : 'push-pull'}`;
    ctrl = `<span class="lv" data-lv="${i.key}">${i.level}</span>`;
  } else if (i.mode === 0) {
    cls += ' in';
    desc = `Ingresso${pull ? ' con ' + pull : i.key === 'PC13' ? ' (pull-up sulla scheda)' : ' flottante'} · a riposo ${i.idle}`;
    const st = S.inputs[i.key] || {};
    ctrl = `<label class="latch"><input type="checkbox" data-latch="${i.key}" ${st.latched ? 'checked' : ''}>fisso</label><button class="press${st.held || st.latched ? ' down' : ''}" data-k="${i.key}">${i.key === 'PC13' ? 'Premi B1' : 'Premi'}</button><span class="lv" data-lv="${i.key}">${i.level}</span>`;
  } else if (i.mode === 2) {
    cls += ' out';
    desc = `Funzione alternativa AF${i.af} · ${i.func}`;
    if (/^TIM/.test(i.func)) ctrl = `<div class="pwm"><span class="small mono" data-pwmt="${i.key}"></span><div class="bar"><i data-pwmb="${i.key}" style="width:0"></i></div></div>`;
    else { cls = 'pin per'; ctrl = `<span class="small muted">${/USART2/.test(i.func) ? 'seriale USB' : ''}</span>`; }
  } else {
    cls += ' an';
    desc = 'Analogico';
  }
  const color = i.key === 'PA5' ? 'style="--c: var(--led)"' : '';
  return `<div class="${cls}" data-key="${i.key}" ${color}>
    <div class="ind" data-ind="${i.key}"></div>
    <div class="t"><div class="a">${i.key}${ard}${lab}${tag}</div><div class="d">${desc}</div></div>
    <div class="v">${ctrl}</div></div>`;
}

function renderPins() {
  const list = activePins();
  const key = JSON.stringify(list.map(i => [i.key, i.mode, i.pull, i.od, i.af, i.exti, i.adcCh, i.label]));
  if (key !== S.pinsKey) {
    S.pinsKey = key;
    const el = $('#pins');
    if (!list.length) { el.innerHTML = `<p class="empty">${S.server.status === 'running' ? 'Il programma non ha ancora configurato nessun pin.' : 'Avvia un progetto: qui compaiono i pin che il programma usa, con LED, pulsanti e cursori per interagire.'}</p>`; return; }
    const groups = [['Uscite', list.filter(i => i.mode === 1 || (i.mode === 2 && /^TIM/.test(i.func)))], ['Ingressi', list.filter(i => i.mode === 0)], ['Analogici', list.filter(i => i.adcCh !== undefined || (i.mode === 3))], ['Periferiche', list.filter(i => i.mode === 2 && !/^TIM/.test(i.func))]];
    el.innerHTML = groups.filter(g => g[1].length).map(([n, g]) => `<div class="group">${n}</div>` + g.map(pinRowHTML).join('')).join('');
    el.querySelectorAll('.press').forEach(b => {
      const k = b.dataset.k;
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); holdPin(k, true); });
      b.addEventListener('pointerup', () => holdPin(k, false));
      b.addEventListener('pointercancel', () => holdPin(k, false));
    });
    el.querySelectorAll('[data-latch]').forEach(c => c.addEventListener('change', () => {
      const k = c.dataset.latch;
      S.inputs[k] = S.inputs[k] || {};
      S.inputs[k].latched = c.checked;
      sendInput(k);
    }));
    el.querySelectorAll('input[type=range]').forEach(r => r.addEventListener('input', () => {
      const ch = r.dataset.ch, v = +r.value;
      S.adcVal[ch] = v;
      el.querySelector(`[data-adcv="${ch}"]`).textContent = (v * 3.3 / 4095).toFixed(2) + ' V';
      cmd(`V ${ch} ${v}`);
    }));
  }
  for (const i of list) {
    const ind = document.querySelector(`[data-ind="${i.key}"]`);
    const lv = document.querySelector(`[data-lv="${i.key}"]`);
    if (lv) lv.textContent = i.level;
    if (ind) {
      if (i.pwm && i.pwm.duty >= 0) {
        ind.classList.add('on');
        ind.style.opacity = 0.25 + 0.75 * i.pwm.duty / 1000;
      } else {
        ind.classList.toggle('on', !!i.level);
        ind.style.opacity = '';
      }
    }
    const pt = document.querySelector(`[data-pwmt="${i.key}"]`);
    if (pt) {
      const w = i.pwm;
      pt.textContent = w && w.duty >= 0 ? `${(w.duty / 10).toFixed(1)}% · ${fmtHz(w.freq)}` : w && w.freq ? `${i.level} · ${fmtHz(w.freq)}` : (i.level ? '1' : '0');
      document.querySelector(`[data-pwmb="${i.key}"]`).style.width = (w && w.duty >= 0 ? w.duty / 10 : i.level * 100) + '%';
    }
  }
}
const fmtHz = f => f >= 1e6 ? (f / 1e6).toFixed(2) + ' MHz' : f >= 1e3 ? (f / 1e3).toFixed(2) + ' kHz' : f + ' Hz';

function renderBoard() {
  const ld2 = pinInfo(0, 5);
  let b = 0;
  if (ld2) {
    if (ld2.pwm && ld2.pwm.duty >= 0 && ld2.mode === 2) b = ld2.pwm.duty / 1000;
    else if (ld2.mode === 1 || ld2.mode === 2) b = ld2.level;
  }
  const g = $('#ld2 .glow'), c = $('#ld2 .core');
  if (g) { g.setAttribute('opacity', b ? 0.25 + 0.75 * b : 0); c.setAttribute('fill', b ? '#7dffad' : '#2d4a33'); }
  const st = S.server.status;
  const ld1 = $('#ld1 .glow'), ld1c = $('#ld1 circle');
  const col = st === 'running' ? '#2bd968' : st === 'building' ? '#ffb020' : st === 'crashed' || st === 'error' ? '#ff3b30' : null;
  ld1c.setAttribute('fill', col || '#3a2020');
  ld1c.setAttribute('filter', col ? 'url(#glow)' : '');
  const act = new Set(activePins().map(a => a.key));
  $$('#board .hp').forEach(c => {
    const k = c.dataset.pin;
    if (!k) return;
    const { p, pin } = parseKey(k);
    const i = pinInfo(p, pin);
    const used = i && act.has(k);
    if (!used) { c.setAttribute('fill', '#c8a85a'); c.removeAttribute('filter'); c.style.cursor = ''; return; }
    const on = i.pwm && i.pwm.duty >= 0 ? i.pwm.duty > 0 : i.level;
    c.setAttribute('fill', on ? (i.mode === 0 ? '#5aa2ff' : '#ffb020') : '#5b5e66');
    c.setAttribute('filter', on ? 'url(#glow)' : '');
    c.style.cursor = i.mode === 0 ? 'pointer' : '';
  });
}

// ------------------------------------------------------------------
// Eventi dal simulatore
function onSimLine(line) {
  const a = line.split(' ');
  switch (line[0]) {
    case 'M': {
      const p = +a[1], h = x => parseInt(x, 16) >>> 0;
      S.ports[p] = Object.assign(S.ports[p] || { level: 0 }, { moder: h(a[2]), pupdr: h(a[3]), otyper: h(a[4]), afrl: h(a[5]), afrh: h(a[6]), exti: h(a[7]), rt: h(a[8]), ft: h(a[9]) });
      S.dirty = true;
      break;
    }
    case 'C': {
      const ms = +a[1], p = +a[2], lv = parseInt(a[3], 16);
      S.ports[p] = S.ports[p] || { moder: 0, pupdr: 0, otyper: 0, afrl: 0, afrh: 0, exti: 0, rt: 0, ft: 0 };
      S.ports[p].level = lv;
      if (window.laOnC) laOnC(ms, p, lv);
      if (ms > S.ms) S.ms = ms;
      S.dirty = true;
      break;
    }
    case 'W': {
      const k = keyOf(+a[1], +a[2]);
      S.pwm[k] = { duty: +a[3], freq: +a[4] };
      if (window.laOnW) laOnW(k, +a[3], +(a[5] ?? a[4]));
      S.dirty = true;
      break;
    }
    case 'G': if (window.laOnG) laOnG(+a[1], +a[2], parseInt(a[3], 16)); break;
    case 'K': S.clocks = a.slice(1).map(Number); renderClocks(); break;
    case 'A': {
      const ch = a[1], p = +a[2], pin = +a[3];
      if (p >= 0) S.adc[ch] = keyOf(p, pin);
      if (S.adcVal[ch] !== undefined) cmd(`V ${ch} ${S.adcVal[ch]}`);
      S.dirty = true;
      break;
    }
    case 'Q': onIrq(a.slice(1)); break;
    case 'T': S.ms = Math.max(S.ms, +a[1]); S.tick = +a[2]; S.primask = +a[3]; renderTime(); break;
    case 'U': appendSerial(a[1], hexToStr(a[2]), '', a[2]); break;
    case 'P': appendSerial('2', hexToStr(a[1]), 'pf', a[1]); break;
    case 'N': S.baud[a[1]] = +a[2]; serialBaudCheck(); break;
    case 'Y': if (window.dbgOnY) dbgOnY(a[1], a[2] || ''); break;
    case 'B': devOnB(a); break;
    case 'J': devOnJ(a); break;
  }
}
function hexToStr(h) {
  const b = new Uint8Array((h || '').length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return new TextDecoder('utf-8').decode(b);
}

function onIrq(parts) {
  const now = performance.now();
  const cur = {};
  for (const p of parts) { const [n, c] = p.split(':'); cur[n] = +c; }
  if (S.irqLast) {
    const dt = (now - S.irqLast.t) / 1000;
    for (const n of Object.keys(cur)) S.irqRate[n] = Math.max(0, (cur[n] - (S.irqLast.c[n] || 0)) / dt);
  }
  const changed = Object.keys(cur).filter(n => cur[n] !== S.irq[n]);
  S.irqLast = { t: now, c: cur };
  S.irq = cur;
  const el = $('#irqs');
  const names = Object.keys(cur).sort((x, y) => (x === 'SysTick') - (y === 'SysTick') || x.localeCompare(y));
  if (!names.length) { el.innerHTML = '<span class="muted small">Nessun interrupt finora.</span>'; return; }
  el.innerHTML = names.map(n => {
    const r = S.irqRate[n];
    const rate = r === undefined ? '' : r > 5 ? ` <span class="r">${Math.round(r * (1 / (S.server.speed || 1)))}/s</span>` : '';
    return `<span class="irq${changed.includes(n) && n !== 'SysTick' ? ' flash' : ''}" title="${n}_IRQHandler"><b>${n}</b> ×${cur[n].toLocaleString('it-IT')}${rate}</span>`;
  }).join('');
}

function renderClocks() {
  const k = S.clocks;
  if (!k) { $('#clocks').textContent = ''; return; }
  const m = v => (v / 1e6).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' MHz';
  $('#clocks').textContent = `SYSCLK ${m(k[0])} · APB1 ${m(k[2])} · APB2 ${m(k[3])}`;
}
function renderTime() {
  $('#simtime').textContent = 't = ' + (S.ms / 1000).toLocaleString('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' s';
  $('#tick').textContent = 'HAL_GetTick() = ' + S.tick.toLocaleString('it-IT');
  $('#primask').hidden = !(S.primask && S.server.status === 'running');
}

// ------------------------------------------------------------------
// Seriale
// ogni pezzo ricevuto: { n USART, text, hex, cls, ms tempo simulato }. La vista (testo/HEX, ora) si
// applica al momento del disegno, così cambiarla ridisegna tutto lo storico.
const SER = { hex: false, ts: false, bol: true };
function serialFmt(c) {
  const stamp = () => SER.ts ? `[${(c.ms / 1000).toFixed(3).replace('.', ',')} s] ` : '';
  let out = '';
  if (SER.hex && c.hex) {
    for (let i = 0; i < c.hex.length; i += 2) {
      if (SER.bol) { out += stamp(); SER.bol = false; }
      const b = c.hex.substr(i, 2).toUpperCase();
      out += b + ' ';
      if (b === '0A') { out += '\n'; SER.bol = true; }
    }
    return out;
  }
  for (const ch of c.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')) {
    if (SER.bol && ch !== '\n') { out += stamp(); SER.bol = false; }
    out += ch;
    if (ch === '\n') SER.bol = true;
  }
  return out;
}
function serialSpan(c) {
  const span = document.createElement('span');
  if (c.cls) span.className = c.cls;
  span.textContent = serialFmt(c);
  return span;
}
function appendSerial(n, text, cls, hex) {
  S.uart[n] = true;
  if (!S.serialChunks.length) { $('#serial').innerHTML = ''; SER.bol = true; }
  const c = { n, text, cls, hex, ms: S.ms };
  S.serialChunks.push(c);
  if (S.serialChunks.length > 20000) S.serialChunks.splice(0, 5000);
  if (n === S.uartSel || cls) {
    const term = $('#serial');
    const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;   // se l'utente è salito, non lo riporto giù
    term.appendChild(serialSpan(c));
    while (term.childNodes.length > 4000) term.removeChild(term.firstChild);
    if (atBottom) term.scrollTop = term.scrollHeight;
    if (cls === 'pf' && !S.pfNoted) {
      S.pfNoted = true;
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = '\n[printf non collegato alla UART: sulla scheda vera questo testo non uscirebbe. Definisci __io_putchar() che chiama HAL_UART_Transmit()]\n';
      term.appendChild(note);
      SER.bol = true;
    }
  }
  if (!$('#pane-serial').classList.contains('active')) $('#serial-dot').hidden = false;
  renderUartTabs();
}
function renderUartTabs() {
  const names = Object.keys(S.uart).sort();
  if (!names.includes(S.uartSel)) names.push(S.uartSel);
  const el = $('#uart-tabs');
  const html = names.sort().map(n => `<button data-u="${n}" class="${n === S.uartSel ? 'on' : ''}">USART${n}</button>`).join('');
  if (el.innerHTML !== html) {
    el.innerHTML = html;
    el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { S.uartSel = b.dataset.u; redrawSerial(); renderUartTabs(); serialBaudCheck(); }));
  }
}
function redrawSerial() {
  const term = $('#serial');
  term.innerHTML = '';
  SER.bol = true;
  for (const c of S.serialChunks) if (c.n === S.uartSel || c.cls) term.appendChild(serialSpan(c));
  term.scrollTop = term.scrollHeight;
}
// baud della USART scelta (da HAL_UART_Init del programma) contro quello del monitor
function serialBaudCheck() {
  const b = S.baud[S.uartSel], mon = +$('#serial-baud').value, w = $('#serial-baud-warn');
  w.hidden = !b || b === mon;
  if (b && b !== mon) w.textContent = `⚠ USART${S.uartSel} è configurata a ${b.toLocaleString('it-IT')} baud, il monitor a ${mon.toLocaleString('it-IT')}: sulla scheda vera leggeresti caratteri sbagliati.`;
  $('#serial-baud').title = b ? `Il programma usa USART${S.uartSel} a ${b} baud` : 'Baud del monitor (il programma non ha ancora inizializzato la UART)';
}
function serialDownload() {
  SER.bol = true;
  const txt = S.serialChunks.filter(c => c.n === S.uartSel || c.cls).map(serialFmt).join('');
  redrawSerial();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  a.download = `seriale-USART${S.uartSel}-${(S.proj && S.proj.name) || 'progetto'}${SER.hex ? '-hex' : ''}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Analizzatore logico (scheda "Segnali"): analizzatore.js

// ------------------------------------------------------------------
// Codice
const KW = new Set('if else for while do switch case default break continue return goto sizeof typedef struct union enum static volatile const extern register inline void char short int long float double signed unsigned _Bool bool true false NULL'.split(' '));
function highlight(src) {
  const out = [];
  const re = /(\/\*[\s\S]*?(?:\*\/|$))|(\/\/[^\n]*)|("(?:\\.|[^"\\\n])*")|('(?:\\.|[^'\\\n])*')|(^[ \t]*#[^\n]*)|(\b0[xX][0-9a-fA-F]+[uUlL]*\b|\b\d+(?:\.\d+)?[fFuUlL]*\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)|([\s\S])/gm;
  let m;
  while ((m = re.exec(src))) {
    const [t, com1, com2, str, chr, pp, num, fn, id] = m;
    if (com1 || com2) out.push(`<span class="co">${esc(t)}</span>`);
    else if (str || chr) out.push(`<span class="st">${esc(t)}</span>`);
    else if (pp) out.push(`<span class="pp">${esc(t)}</span>`);
    else if (num) out.push(`<span class="nu">${t}</span>`);
    else if (fn) out.push(KW.has(fn) ? `<span class="k">${fn}</span>` : `<span class="fn">${fn}</span>`);
    else if (id) {
      if (KW.has(id)) out.push(`<span class="k">${id}</span>`);
      else if (/_t$|TypeDef$|^GPIO_PinState$/.test(id)) out.push(`<span class="ty">${id}</span>`);
      else if (/^[A-Z][A-Z0-9_]{2,}$/.test(id)) out.push(`<span class="ma">${id}</span>`);
      else out.push(id);
    } else out.push(esc(t));
  }
  // spezza per righe mantenendo gli span aperti
  const html = out.join('');
  const lines = [];
  let open = [];
  for (const raw of html.split('\n')) {
    const prefix = open.join('');
    const tags = raw.match(/<span[^>]*>|<\/span>/g) || [];
    for (const tg of tags) { if (tg === '</span>') open.pop(); else open.push(tg); }
    lines.push(prefix + raw + '</span>'.repeat(open.length));
  }
  return lines;
}

function renderFiles() {
  const errs = S.server.buildErrors || [];
  const el = $('#files');
  el.innerHTML = S.files.map(f => {
    const has = errs.some(e => e.file && (e.file === f.rel || e.file.endsWith('/' + f.name) || e.file === f.name));
    return `<button data-f="${esc(f.rel)}" class="${f.rel === S.curFile ? 'on' : ''}${has ? ' haserr' : ''}">${esc(f.name)}</button>`;
  }).join('');
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { S.curFile = b.dataset.f; renderFiles(); renderCode(); }));
}
function renderCode(gotoLine) {
  const f = S.files.find(x => x.rel === S.curFile);
  const el = $('#code');
  if (!f) { el.innerHTML = '<p class="empty">Seleziona un progetto a sinistra.</p>'; return; }
  const errs = (S.server.buildErrors || []).filter(e => e.file && (e.file === f.rel || e.file.endsWith('/' + f.name) || e.file === f.name));
  const lines = highlight(f.content);
  const raw = f.content.split('\n');
  let inUc = false;
  const rows = lines.map((h, n) => {
    const r = raw[n] || '';
    const begin = /USER CODE BEGIN/.test(r), end = /USER CODE END/.test(r);
    if (begin) inUc = true;
    const uc = inUc && !begin;
    if (end) inUc = false;
    const le = errs.filter(e => e.line === n + 1);
    const msg = le.map(e => `<span class="emsg">⚠ ${esc(e.msg)}</span>`).join('');
    return `<tr id="L${n + 1}" class="${uc && !end ? 'uc' : ''}${le.length ? ' err' : ''}"><td class="ln">${n + 1}</td><td class="src">${h || ' '}${msg}</td></tr>`;
  });
  el.innerHTML = `<table>${rows.join('')}</table>`;
  if (window.dbgDecorate) dbgDecorate(f, el);
  const target = gotoLine || (window.dbgCurrentLine && dbgCurrentLine(f)) || (errs[0] && errs[0].line) || null;
  if (target) {
    const row = el.querySelector('#L' + target);
    // scorre solo il riquadro del codice, non tutta la pagina
    if (row) { el.scrollTop = Math.max(0, row.offsetTop - el.clientHeight / 2); if (gotoLine) row.classList.add('flash'); }
  } else {
    // salta alla prima sezione USER CODE significativa (es. callback)
    const idx = raw.findIndex(l => /^\s*int\s+main\s*\(/.test(l));
    const row = idx > 0 && el.querySelector('#L' + (idx + 1));
    el.scrollTop = row ? row.offsetTop - 8 : 0;
  }
}
function gotoError(e) {
  const f = S.files.find(x => e.file && (x.rel === e.file || e.file.endsWith('/' + x.name) || x.name === e.file));
  if (!f) return;
  S.curFile = f.rel;
  showTab('code');
  renderFiles();
  renderCode(e.line);
}

// ------------------------------------------------------------------
// Progetti
async function loadProjects() {
  S.projects = await api('/api/projects');
  renderProjects();
  updateButtons();
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (!ms) return '';
  if (s < 60) return 'ora';
  if (s < 3600) return Math.floor(s / 60) + ' min fa';
  if (s < 86400) return Math.floor(s / 3600) + ' h fa';
  return new Date(ms).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}
function renderProjects() {
  const q = $('#filter').value.toLowerCase();
  const byWs = {};
  for (const p of S.projects) if (!q || p.name.toLowerCase().includes(q) || p.workspace.toLowerCase().includes(q)) (byWs[p.workspace] = byWs[p.workspace] || []).push(p);
  const runningId = S.server.project && S.server.project.id;
  const live = ['running', 'building'].includes(S.server.status);
  $('#projlist').innerHTML = Object.entries(byWs).map(([ws, ps]) => `<div class="ws">${esc(ws)}</div>` + ps.map(p => `
    <button class="proj${p.id === S.selId ? ' sel' : ''}${p.supported ? '' : ' unsup'}" data-id="${p.id}" title="${esc(p.path)}">
      <span class="n">${esc(p.name)}${p.id === runningId && live ? '<span class="live"></span>' : ''}</span>
      <span class="m">${esc(p.board || p.mcu || 'micro sconosciuto')} · ${ago(p.modified)}${p.supported ? '' : ' · non supportato'}</span>
    </button>`).join('')).join('') || '<p class="muted small">Nessun progetto trovato in ~/STM32CubeIDE.</p>';
  $$('#projlist .proj').forEach(b => b.addEventListener('click', () => selectProject(b.dataset.id)));
}
async function selectProject(id, keepFile) {
  S.selId = id;
  renderProjects();
  updateButtons();
  const r = await api('/api/project?id=' + encodeURIComponent(id));
  if (r.error || S.selId !== id) return;   // nel frattempo è stato scelto un altro progetto
  S.proj = r.info;
  S.files = r.files;
  S.ioc = r.ioc || { pins: {} };
  if (!keepFile || !S.files.some(f => f.rel === S.curFile)) S.curFile = (S.files[0] || {}).rel;
  renderFiles();
  renderCode();
  S.pinsKey = '';
  S.dirty = true;
}

// ------------------------------------------------------------------
// Stato del server
function onState(st) {
  const prevProj = S.server.project && S.server.project.id;
  const prevStatus = S.server.status;
  S.server = st;
  const pill = $('#status');
  const s = st.paused && st.status === 'running' ? 'paused' : st.status;
  pill.className = 'pill ' + s;
  pill.textContent = s === 'paused' ? 'In pausa' : STATUS_TXT[st.status] || st.status;
  $('#projname').textContent = st.project ? st.project.name : '';
  $('#source').textContent = st.project ? (st.source === 'ide' ? 'lanciato da CubeIDE' : st.source === 'cubeide-build' ? 'compilato in CubeIDE' : '') : '';
  $('#auto').checked = !!st.auto;
  $('#safari').checked = st.openSafari !== false;
  if (st.platform === 'win32' && !document.body.classList.contains('win')) {
    document.body.classList.add('win');
    $('#safari-txt').textContent = 'Apri nel browser';
    $('#safari-sw').title = 'Quando lanci o compili da CubeIDE, apre il simulatore nel browser se non è già aperto';
  }
  $('#btn-pause').textContent = st.paused ? '▶ Riprendi' : '⏸ Pausa';
  $('#speed').value = String(st.speed || 1);
  document.title = (st.project && st.status === 'running' ? '▶ ' + st.project.name + ' — ' : '') + 'Scheda Virtuale STM32';
  if (st.project && st.project.id !== S.selId && (st.status === 'building' || (st.project.id !== prevProj))) selectProject(st.project.id);
  else if (st.project && st.project.id === S.selId && prevStatus !== st.status && st.status === 'building') selectProject(st.project.id, true);
  renderBanner();
  renderFiles();
  if (st.status === 'error') { renderCode(); }
  updateButtons();
  renderProjects();
  renderTime();
  S.dirty = true;
}
function updateButtons() {
  const st = S.server.status;
  const sel = S.projects.find(p => p.id === S.selId);
  const live = st === 'running';
  $('#btn-run').disabled = !sel || !sel.supported || st === 'building';
  $('#btn-run').textContent = S.server.project && S.server.project.id === S.selId && (live || st === 'crashed') && !S.server.debug ? '↻ Ricompila' : '▶ Avvia';
  $('#btn-debug').disabled = $('#btn-run').disabled;
  $('#btn-debug').classList.toggle('on', !!S.server.debug && live);
  $('#btn-reset').disabled = !(live || st === 'crashed' || st === 'stopped') || !S.server.project;
  $('#btn-pause').disabled = !live;
  $('#btn-stop').disabled = !live;
}
function renderBanner() {
  const st = S.server;
  const b = $('#banner');
  if (st.status === 'error' && st.buildErrors && st.buildErrors.length) {
    b.className = 'banner error';
    b.innerHTML = `<h4>Il progetto non compila nel simulatore</h4><ul>${st.buildErrors.slice(0, 8).map((e, i) => `<li>${e.file ? `<a data-e="${i}">${esc(e.file)}${e.line ? ':' + e.line : ''}</a> — ` : ''}<span class="mono small">${esc(e.msg)}</span></li>`).join('')}</ul>`;
    b.hidden = false;
    b.querySelectorAll('a').forEach(a => a.addEventListener('click', () => gotoError(st.buildErrors[+a.dataset.e])));
  } else if (st.status === 'crashed') {
    const last = [...document.querySelectorAll('.le.error')].pop();
    b.className = 'banner error';
    b.innerHTML = `<h4>La scheda si è fermata (HardFault)</h4><div>${last ? esc(last.querySelector('.tx').textContent) : ''} Premi ⟲ Reset per ripartire.</div>`;
    b.hidden = false;
  } else b.hidden = true;
}

// ------------------------------------------------------------------
// Registro
function addLog(e) {
  const el = $('#log');
  const d = document.createElement('div');
  d.className = 'le ' + e.level;
  const lvl = { info: 'info', warn: 'avviso', error: 'errore', stub: 'non sim.' }[e.level] || e.level;
  d.innerHTML = `<span class="tm">${new Date(e.t).toLocaleTimeString('it-IT')}</span><span class="lv">${lvl}</span><span class="tx"></span>`;
  d.querySelector('.tx').textContent = e.text;
  el.appendChild(d);
  while (el.childNodes.length > 400) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
  if ((e.level === 'warn' || e.level === 'error') && !$('#pane-log').classList.contains('active')) {
    S.warnCount++;
    $('#log-count').hidden = false;
    $('#log-count').textContent = S.warnCount;
  }
  if (e.level === 'warn') showWarnBanner(e.text);
}
let warnTimer = null;
function showWarnBanner(text) {
  const b = $('#banner');
  if (S.server.status === 'error' || S.server.status === 'crashed') return;
  b.className = 'banner warn';
  b.innerHTML = `<h4>Attenzione</h4><div></div>`;
  b.querySelector('div').textContent = text;
  b.hidden = false;
  clearTimeout(warnTimer);
  warnTimer = setTimeout(() => { if (b.classList.contains('warn')) b.hidden = true; }, 12000);
}

// ------------------------------------------------------------------
// Tabs, controlli
function showTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
  if (name === 'serial') $('#serial-dot').hidden = true;
  if (name === 'log') { S.warnCount = 0; $('#log-count').hidden = true; }
  try { localStorage.setItem('sv-tab', name); } catch {}
}
function resetSimState() {
  Object.assign(S, { ports: {}, pwm: {}, adc: {}, ms: 0, tick: 0, primask: 0, irq: {}, irqRate: {}, irqLast: null, uart: {}, serialChunks: [], baud: {}, pinsKey: '', pfNoted: false });
  for (const k of Object.keys(S.inputs)) { if (!S.inputs[k].latched) delete S.inputs[k]; }
  $('#serial').innerHTML = '';
  $('#irqs').innerHTML = '<span class="muted small">Nessun interrupt finora.</span>';
  if (window.laReset) laReset();
  serialBaudCheck();
  if (window.dbgOnReset) dbgOnReset();
  devOnReset();
  S.dirty = true;
}
async function doRun(debug) {
  if (!S.selId) return;
  $('#btn-run').disabled = true;
  $('#btn-debug').disabled = true;
  const r = await api('/api/run', { id: S.selId, source: 'ui', debug: debug === true });
  if (!r.ok && r.errors && r.errors.length) gotoError(r.errors.find(e => e.file) || {});
}
const doReset = () => api('/api/reset', {});

function wire() {
  $$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('#btn-run').addEventListener('click', () => doRun(false));
  $('#btn-debug').addEventListener('click', () => doRun(true));
  $('#btn-reset').addEventListener('click', doReset);
  $('#btn-stop').addEventListener('click', () => api('/api/stop', {}));
  $('#btn-pause').addEventListener('click', () => cmd(`P ${S.server.paused ? 0 : 1}`));
  $('#speed').addEventListener('change', e => cmd(`S ${e.target.value}`));
  $('#auto').addEventListener('change', e => api('/api/auto', { on: e.target.checked }));
  $('#safari').addEventListener('change', e => api('/api/safari', { on: e.target.checked }));
  $('#btn-help').addEventListener('click', () => $('#help').showModal());
  $('#btn-refresh').addEventListener('click', loadProjects);
  $('#filter').addEventListener('input', renderProjects);
  $('#serial-clear').addEventListener('click', () => { S.serialChunks = []; $('#serial').innerHTML = ''; SER.bol = true; });
  $('#serial-view').addEventListener('change', e => { SER.hex = e.target.value === 'hex'; redrawSerial(); });
  $('#serial-ts').addEventListener('change', e => { SER.ts = e.target.checked; redrawSerial(); });
  $('#serial-save').addEventListener('click', serialDownload);
  $('#serial-baud').addEventListener('change', serialBaudCheck);
  $('#serial-form').addEventListener('submit', e => {
    e.preventDefault();
    const inp = $('#serial-input');
    const eol = $('#serial-eol').value.replace('\\r', '\r').replace('\\n', '\n').replace('\\n', '\n');
    const bytes = new TextEncoder().encode(inp.value + eol);
    if (!bytes.length) return;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    cmd(`R ${S.uartSel} ${hex}`);
    inp.value = '';
  });
  try { const t = localStorage.getItem('sv-tab'); if (t) showTab(t); } catch {}
}

// ------------------------------------------------------------------
// Connessione al server
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'hello': {
        resetSimState();
        $('#log').innerHTML = '';
        for (const e of m.snap.log || []) addLog(e);
        S.warnCount = 0; $('#log-count').hidden = true;
        const sn = m.snap;
        [...Object.values(sn.M), ...Object.values(sn.C), ...Object.values(sn.W), ...Object.values(sn.A), ...Object.values(sn.B || {}), ...Object.values(sn.J || {}), sn.K, sn.Q, sn.T].filter(Boolean).forEach(onSimLine);
        for (const [n, hex] of Object.entries(sn.uart || {})) appendSerial(n === 'P' ? '2' : n, hexToStr(hex), n === 'P' ? 'pf' : '', hex);
        onState(m.state);
        if (window.dbgOnHello) dbgOnHello(m);
        break;
      }
      case 'status': onState(m.state); break;
      case 'reset': resetSimState(); break;
      case 'sim': for (const l of m.lines) onSimLine(l); break;
      case 'log': addLog(m); if (m.level === 'error') renderBanner(); break;
      case 'console': appendSerial('2', m.text, 'pf'); break;
      case 'ide': loadProjects(); break;
      case 'dbg': if (window.dbgOnEvent) dbgOnEvent(m); break;
      case 'bp': if (window.dbgOnBreakpoints) dbgOnBreakpoints(m.breakpoints); break;
      case 'vars': if (window.dbgOnVars) dbgOnVars(m.vars); break;
      case 'devices': devOnList(m); break;
    }
  };
  es.onerror = () => { $('#status').className = 'pill error'; $('#status').textContent = 'Server non raggiungibile'; };
}

function frame() {
  if (S.dirty) { S.dirty = false; renderPins(); renderBoard(); renderDevices(); }
  devFrame();
  if (window.laDraw && $('#pane-scope').classList.contains('active')) laDraw();
  if (window.dbgFrame) dbgFrame();
  requestAnimationFrame(frame);
}

setupBoard();
wire();
loadProjects().then(() => { if (!S.selId && S.projects[0]) selectProject(S.projects[0].id); });
connect();
setInterval(loadProjects, 20000);
requestAnimationFrame(frame);
