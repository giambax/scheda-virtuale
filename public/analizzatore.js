'use strict';
/* Scheda Virtuale STM32 — analizzatore logico (scheda "Segnali").
 * Registra i cambi dei pin con il tempo simulato:
 *   "C ms porta livelli"  a fine di ogni millisecondo simulato (ingressi, uscite, timer)
 *   "G µs porta ODR"      subito a ogni HAL_GPIO_WritePin/TogglePin (tempo al µs)
 * Ogni porta ha un buffer circolare di LA_N cambi: la memoria non cresce.
 * Usa S, $, activePins, ARD, keyOf, parseKey di app.js. */

const LA_N = 50000;            // cambi tenuti per porta
const LA_CH = 8;               // canali
const LA = {
  ring: {}, cur: {}, lastT: 0,
  ch: Array(LA_CH).fill(''), auto: true, pinsKey: '',
  paused: false, end: 0, span: 20000,       // finestra in µs
  cur2: [null, null],                       // cursori A e B (µs)
  trig: { ch: -1, edge: 1, at: null },
};

function laRing(p) {
  return LA.ring[p] || (LA.ring[p] = { t: new Float64Array(LA_N), v: new Uint16Array(LA_N), head: 0, len: 0 });
}
function laPush(p, t, lv) {
  const r = laRing(p);
  if (r.len) { const last = (r.head + LA_N - 1) % LA_N; if (t < r.t[last]) t = r.t[last]; }
  const old = LA.cur[p] ?? 0;
  r.t[r.head] = t; r.v[r.head] = lv;
  r.head = (r.head + 1) % LA_N;
  if (r.len < LA_N) r.len++;
  if (t > LA.lastT) LA.lastT = t;
  // trigger: primo fronte giusto sul canale scelto
  const tg = LA.trig;
  if (tg.ch >= 0 && tg.at === null && LA.ch[tg.ch]) {
    const { p: tp, pin } = parseKey(LA.ch[tg.ch]);
    if (tp === p && ((old >> pin) & 1) !== ((lv >> pin) & 1) && ((lv >> pin) & 1) === tg.edge) tg.at = t;
  }
}
function laSet(p, t, lv) {
  if ((LA.cur[p] ?? -1) === lv) return;
  if (!LA.paused) laPush(p, t, lv);
  LA.cur[p] = lv;
}
function laOnC(ms, p, lv) { laSet(p, ms * 1000, lv); }
function laOnG(us, p, odr) {
  const port = S.ports[p];
  if (!port) return;
  let out = 0;
  for (let pin = 0; pin < 16; pin++) if (((port.moder >>> (2 * pin)) & 3) === 1 && !((port.otyper >>> pin) & 1)) out |= 1 << pin;
  if (!out) return;
  laSet(p, us, ((LA.cur[p] ?? 0) & ~out) | (odr & out));
}
function laReset() {
  Object.assign(LA, { ring: {}, cur: {}, lastT: 0, paused: false, end: 0, cur2: [null, null] });
  LA.trig.at = null;
  laButtons();
}
const laNow = () => Math.max(LA.lastT, S.ms * 1000);

// indice (in ordine di tempo, 0 = il più vecchio) dell'ultimo cambio con t <= tt, -1 se nessuno
function laFind(r, tt) {
  let lo = 0, hi = r.len - 1, k = -1;
  const base = (r.head + LA_N - r.len) % LA_N;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (r.t[(base + m) % LA_N] <= tt) { k = m; lo = m + 1; } else hi = m - 1;
  }
  return k;
}

// ------------------------------------------------------------------
// Canali
function laPins() {
  return activePins().filter(i => i.mode !== 3 && i.adcCh === undefined && !/USART/.test(i.func));
}
const laName = i => (i.label ? i.label.replace(/\s*\[.*\]$/, '') : (ARD[i.key] || i.key));
function laRenderChannels() {
  const pins = laPins();
  const key = pins.map(i => i.key + i.label).join();
  if (key === LA.pinsKey) return;
  LA.pinsKey = key;
  const keys = pins.map(i => i.key);
  if (LA.auto) LA.ch = Array.from({ length: LA_CH }, (_, k) => keys[k] || '');
  else LA.ch = LA.ch.map(k => keys.includes(k) ? k : '');
  const opts = '<option value="">—</option>' + pins.map(i => `<option value="${i.key}">${esc(laName(i))} (${i.key}${ARD[i.key] && laName(i) !== ARD[i.key] ? ' ' + ARD[i.key] : ''})</option>`).join('');
  $('#la-canali').innerHTML = LA.ch.map((k, n) => `<label>CH${n} <select data-ch="${n}">${opts}</select></label>`).join('');
  $$('#la-canali select').forEach(s => {
    s.value = LA.ch[+s.dataset.ch];
    s.addEventListener('change', () => { LA.auto = false; LA.ch[+s.dataset.ch] = s.value; laTrigOptions(); });
  });
  laTrigOptions();
}
function laTrigOptions() {
  const sel = $('#la-trig-ch');
  sel.innerHTML = '<option value="-1">nessuno</option>' + LA.ch.map((k, n) => k ? `<option value="${n}">CH${n} ${esc(laLabel(k))}</option>` : '').join('');
  sel.value = String(LA.trig.ch);
  if (sel.value !== String(LA.trig.ch)) { LA.trig.ch = -1; sel.value = '-1'; }
}
function laLabel(k) {
  const { p, pin } = parseKey(k);
  const i = pinInfo(p, pin);
  return i ? laName(i) : k;
}

// ------------------------------------------------------------------
// Tempo: formato e righello
// us = tempo in µs; res = risoluzione (decide i decimali); l'unità segue il valore
function laFmt(us, res) {
  const a = Math.abs(us) || res;
  const [div, u] = a >= 1e6 ? [1e6, 's'] : a >= 1e3 ? [1e3, 'ms'] : [1, 'µs'];
  const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(res / div) + 1e-9)));
  return (us / div).toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' ' + u;
}
function laFreq(dt) {
  const f = 1e6 / dt;
  const n = (v, u) => v.toLocaleString('it-IT', { maximumFractionDigits: v < 10 ? 3 : v < 100 ? 2 : 1 }) + ' ' + u;
  return f >= 1e6 ? n(f / 1e6, 'MHz') : f >= 1e3 ? n(f / 1e3, 'kHz') : n(f, 'Hz');
}
function laStep(span, px) {
  const raw = span * 80 / Math.max(1, px);
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map(m => m * e).find(s => s >= raw);
}

// ------------------------------------------------------------------
// Disegno
const LA_L = 96, LA_R = 10, LA_TOP = 24;
function laView(W) {
  const end = LA.paused ? LA.end : laNow();
  return { start: end - LA.span, end, x: t => LA_L + (t - (end - LA.span)) / LA.span * (W - LA_L - LA_R) };
}
function laDraw() {
  laRenderChannels();
  const cv = $('#scope');
  if (!cv.offsetParent) return;
  // trigger scattato: si ferma con il fronte a metà finestra
  const tg = LA.trig;
  if (!LA.paused && tg.ch >= 0 && tg.at !== null && laNow() >= tg.at + LA.span / 2) laPause(tg.at + LA.span / 2);
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const col = n => css.getPropertyValue(n).trim();
  ctx.fillStyle = col('--code-bg');
  ctx.fillRect(0, 0, W, H);
  const { start, end, x } = laView(W);
  // righello
  const step = laStep(LA.span, W - LA_L - LA_R);
  ctx.font = '10.5px ui-monospace, Menlo, monospace';
  ctx.lineWidth = 1;
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
    const xx = Math.round(x(t)) + .5;
    ctx.strokeStyle = col('--border');
    ctx.beginPath(); ctx.moveTo(xx, LA_TOP - 6); ctx.lineTo(xx, H); ctx.stroke();
    ctx.fillStyle = col('--muted');
    if (t >= 0) ctx.fillText(laFmt(t, step), xx + 3, 13);
  }
  const chans = LA.ch.map((k, n) => ({ k, n })).filter(c => c.k);
  if (!chans.length) { ctx.fillStyle = col('--muted'); ctx.fillText('Nessun canale: avvia un progetto e scegli i pin qui sopra.', LA_L, LA_TOP + 24); return; }
  const rowH = Math.max(26, Math.min(44, (H - LA_TOP - 6) / chans.length));
  const colors = ['#f59e0b', '#22c55e', '#3b82f6', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#84cc16'];
  chans.forEach(({ k, n }, r) => {
    const { p, pin } = parseKey(k);
    const y0 = LA_TOP + r * rowH, hi = y0 + 6, lo = y0 + rowH - 6;
    ctx.fillStyle = col('--text');
    ctx.font = '600 12px ui-monospace, Menlo, monospace';
    ctx.fillText(laLabel(k).slice(0, 9), 8, y0 + rowH / 2);
    ctx.fillStyle = col('--muted');
    ctx.font = '10px system-ui';
    ctx.fillText(`CH${n} ${k}`, 8, y0 + rowH / 2 + 12);
    const color = colors[n % colors.length];
    const rg = LA.ring[p];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (!rg || !rg.len) {
      const lv = ((LA.cur[p] ?? 0) >> pin) & 1;
      ctx.moveTo(LA_L, lv ? hi : lo); ctx.lineTo(W - LA_R, lv ? hi : lo);
    } else {
      const base = (rg.head + LA_N - rg.len) % LA_N;
      let k0 = laFind(rg, start);
      let lv, cx;
      if (k0 < 0) { k0 = 0; cx = x(rg.t[base]); lv = (rg.v[base] >> pin) & 1; }   // prima del primo dato: niente traccia
      else { cx = LA_L; lv = (rg.v[(base + k0) % LA_N] >> pin) & 1; }
      cx = Math.max(LA_L, cx);
      ctx.moveTo(cx, lv ? hi : lo);
      for (let j = k0 + 1; j < rg.len; j++) {
        const i = (base + j) % LA_N, t = rg.t[i];
        if (t > end) break;
        const nl = (rg.v[i] >> pin) & 1;
        if (nl !== lv) { const xx = x(t); ctx.lineTo(xx, lv ? hi : lo); ctx.lineTo(xx, nl ? hi : lo); lv = nl; }
      }
      ctx.lineTo(x(Math.min(end, laNow())), lv ? hi : lo);
    }
    ctx.stroke();
    ctx.strokeStyle = col('--border');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y0 + rowH - .5); ctx.lineTo(W, y0 + rowH - .5); ctx.stroke();
  });
  // trigger e cursori
  if (tg.at !== null && tg.ch >= 0) {
    const xx = x(tg.at);
    ctx.strokeStyle = col('--err') || '#e5484d'; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(xx, LA_TOP - 6); ctx.lineTo(xx, H); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col('--err') || '#e5484d'; ctx.fillText('T', xx + 3, LA_TOP - 1);
  }
  LA.cur2.forEach((t, n) => {
    if (t === null) return;
    const xx = Math.round(x(t)) + .5;
    if (xx < LA_L || xx > W - LA_R) return;
    ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1.5;
    ctx.setLineDash(n ? [6, 4] : []);
    ctx.beginPath(); ctx.moveTo(xx, LA_TOP - 6); ctx.lineTo(xx, H); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col('--accent'); ctx.font = '600 11px system-ui';
    ctx.fillText(n ? 'B' : 'A', xx + 3, LA_TOP + 8);
  });
  laMeasure();
}
function laMeasure() {
  const [a, b] = LA.cur2, res = Math.max(1, Math.pow(10, Math.floor(Math.log10(LA.span / 1000))));
  let s = 'Clic sul grafico: cursore A, poi B (si agganciano al fronte più vicino). Rotella: zoom. Trascina: sposta.';
  if (a !== null) s = `A = ${laFmt(a, res)}`;
  if (a !== null && b !== null) {
    const dt = Math.abs(b - a);
    s += `   B = ${laFmt(b, res)}   Δt = ${laFmt(dt, res)}` + (dt > 0 ? `   f = 1/Δt = ${laFreq(dt)}` : '');
  } else if (a !== null) s += '   (clic per il cursore B)';
  const el = $('#la-misura');
  if (el.textContent !== s) el.textContent = s;
}

// ------------------------------------------------------------------
// Comandi
function laPause(at) {
  LA.paused = true;
  LA.end = at ?? laNow();
  laButtons();
}
function laResume() {
  LA.paused = false;
  LA.trig.at = null;
  // dopo la pausa: riparte dal livello attuale dei pin
  const t = laNow();
  for (const p of Object.keys(LA.cur)) laPush(+p, t, LA.cur[p]);
  laButtons();
}
function laButtons() {
  const b = $('#la-pausa');
  if (b) b.textContent = LA.paused ? '▶ Riprendi' : '❚❚ Pausa';
}
function laZoom(f, tAt) {
  const W = $('#scope').clientWidth;
  const { start, end } = laView(W);
  const span = Math.min(60e6, Math.max(20, LA.span * f));
  if (!LA.paused) { LA.span = span; return; }   // dal vivo: resta attaccato a "adesso"
  const at = tAt ?? (start + end) / 2;
  const frac = (at - start) / LA.span;
  LA.span = span;
  LA.end = at - frac * span + span;
}
function laFit() {
  let t0 = Infinity;
  for (const r of Object.values(LA.ring)) if (r.len) t0 = Math.min(t0, r.t[(r.head + LA_N - r.len) % LA_N]);
  if (t0 === Infinity) return;
  if (!LA.paused) laPause();
  LA.span = Math.max(20, LA.end - t0);
}
// fronte più vicino a t (tra i canali scelti) entro tol µs
function laSnap(t, tol) {
  let best = t, bd = tol;
  for (const k of LA.ch) {
    if (!k) continue;
    const { p, pin } = parseKey(k);
    const r = LA.ring[p];
    if (!r || !r.len) continue;
    const base = (r.head + LA_N - r.len) % LA_N;
    const k0 = Math.max(0, laFind(r, t - tol));
    for (let j = Math.max(1, k0); j < r.len; j++) {
      const i = (base + j) % LA_N, ti = r.t[i];
      if (ti > t + tol) break;
      if (((r.v[i] ^ r.v[(base + j - 1) % LA_N]) >> pin) & 1 && Math.abs(ti - t) < bd) { bd = Math.abs(ti - t); best = ti; }
    }
  }
  return best;
}

function laWire() {
  const cv = $('#scope');
  $('#la-pausa').addEventListener('click', () => LA.paused ? laResume() : laPause());
  $('#la-zin').addEventListener('click', () => laZoom(0.5));
  $('#la-zout').addEventListener('click', () => laZoom(2));
  $('#la-tutto').addEventListener('click', laFit);
  $('#la-togli').addEventListener('click', () => { LA.cur2 = [null, null]; });
  $('#la-trig-ch').addEventListener('change', e => { LA.trig.ch = +e.target.value; LA.trig.at = null; });
  $('#la-trig-fr').addEventListener('change', e => { LA.trig.edge = +e.target.value; LA.trig.at = null; });
  const tAt = ev => { const W = cv.clientWidth, v = laView(W), r = cv.getBoundingClientRect(); return v.start + (ev.clientX - r.left - LA_L) / (W - LA_L - LA_R) * LA.span; };
  const usPerPx = () => LA.span / Math.max(1, cv.clientWidth - LA_L - LA_R);
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    laZoom(ev.deltaY > 0 ? 1.25 : 0.8, tAt(ev));
  }, { passive: false });
  let drag = null;
  cv.addEventListener('pointerdown', ev => {
    const t = tAt(ev), tol = 6 * usPerPx();
    const near = LA.cur2.findIndex(c => c !== null && Math.abs(c - t) < tol);
    drag = { x: ev.clientX, end: LA.end, moved: false, cursor: near };
    cv.setPointerCapture(ev.pointerId);
  });
  cv.addEventListener('pointermove', ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    if (drag.cursor >= 0) { LA.cur2[drag.cursor] = laSnap(tAt(ev), 6 * usPerPx()); return; }
    if (!LA.paused) { laPause(); drag.end = LA.end; }
    LA.end = drag.end - dx * usPerPx();
  });
  cv.addEventListener('pointerup', ev => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved) return;
    const t = laSnap(tAt(ev), 8 * usPerPx());
    const [a, b] = LA.cur2;
    if (a === null) LA.cur2[0] = t;
    else if (b === null) LA.cur2[1] = t;
    else LA.cur2[Math.abs(t - a) <= Math.abs(t - b) ? 0 : 1] = t;   // sposta il più vicino
  });
  cv.addEventListener('dblclick', () => { LA.cur2 = [null, null]; });
  laButtons();
}
laWire();
