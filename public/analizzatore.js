'use strict';
/* Scheda Virtuale STM32 — analizzatore logico (scheda "Segnali").
 * Registra i cambi dei pin con il tempo simulato:
 *   "C ms porta livelli"  a fine di ogni millisecondo simulato (ingressi, uscite, timer)
 *   "G µs porta ODR"      subito a ogni HAL_GPIO_WritePin/TogglePin (tempo al µs)
 * Ogni porta ha un buffer circolare di LA_N cambi: la memoria non cresce.
 *   "W porta pin duty f fesatta"  uscita PWM/OC di un timer: l'onda si ricostruisce (laPieces), non si registra
 * Canali automatici: prima i pin che commutano nei primi LA_AUTO_US, poi le uscite con etichetta, poi gli
 * ingressi EXTI; la scelta a mano resta salvata per progetto (localStorage "sv-la-ch:<id>").
 * Usa S, $, activePins, ARD, keyOf, parseKey di app.js. */

const LA_N = 50000;            // cambi tenuti per porta
const LA_CH = 16;              // canali
const LA_AUTO_US = 2e6;        // la scelta automatica si aggiorna nei primi 2 s simulati, poi resta ferma
const LA = {
  ring: {}, cur: {}, lastT: 0,
  cnt: {}, pwm: {},                         // cambi per pin (scelta automatica), tratti PWM per pin
  ch: Array(LA_CH).fill(''), auto: true, want: null, pinsKey: '',
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
  const diff = LA.cur[p] === undefined ? 0 : old ^ lv;
  if (diff) for (let pin = 0; pin < 16; pin++) if ((diff >> pin) & 1) { const k = keyOf(p, pin); LA.cnt[k] = (LA.cnt[k] || 0) + 1; }
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
// PWM/OC di un timer: un tratto per ogni cambio (t, duty 0..1, periodo µs); on = false quando non genera onda
function laOnW(k, duty, f) {
  const segs = LA.pwm[k] || (LA.pwm[k] = []);
  const on = duty >= 0 && f > 0, d = duty / 1000, per = on ? 1e6 / f : 0;
  const last = segs[segs.length - 1];
  if (last ? last.on === on && (!on || (last.d === d && last.per === per)) : !on) return;
  segs.push({ t: laNow(), on, d, per });
  if (segs.length > 2000) segs.shift();
}
function laReset() {
  Object.assign(LA, { ring: {}, cur: {}, lastT: 0, cnt: {}, pwm: {}, paused: false, end: 0, cur2: [null, null], pinsKey: '' });
  LA.trig.at = null;
  LA.want = laLoad();
  LA.auto = !LA.want;
  laButtons();
}
const laStoreKey = () => 'sv-la-ch:' + (S.selId ?? '');
function laLoad() { try { const v = JSON.parse(localStorage.getItem(laStoreKey())); return Array.isArray(v) ? v : null; } catch { return null; } }
function laSave() { try { if (LA.want) localStorage.setItem(laStoreKey(), JSON.stringify(LA.want)); else localStorage.removeItem(laStoreKey()); } catch {} }
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

// Fronti del canale k tra a e b: fn(t, livello) per il livello di partenza e poi a ogni cambio.
// Dove un timer genera PWM l'onda si ricostruisce da duty e periodo (fronti di salita a t0 + n·T);
// altrove si usano i cambi registrati. Restituisce false se i fronti superano max (onda troppo fitta).
function laWalk(k, a, b, fn, max = Infinity) {
  const { p, pin } = parseKey(k);
  const segs = LA.pwm[k] || [];
  let n = 0, last = null;
  const out = (t, lv) => { if (lv === last) return true; last = lv; return ++n <= max ? (fn(t, lv), true) : false; };
  // pezzi di [a, b] con lo stesso tratto PWM (o nessuno)
  let si = -1;
  for (let i = 0; i < segs.length && segs[i].t <= a; i++) si = i;
  let x = a;
  while (x < b) {
    const sg = si >= 0 ? segs[si] : null, y = Math.min(b, si + 1 < segs.length ? segs[si + 1].t : Infinity);
    if (sg && sg.on) {
      const hi = sg.d * sg.per;
      if (sg.d <= 0 || sg.d >= 1) { if (!out(x, sg.d >= 1 ? 1 : 0)) return false; }
      else {
        let c = Math.floor((x - sg.t) / sg.per), t0 = sg.t + c * sg.per;
        if (!out(x, x - t0 < hi ? 1 : 0)) return false;
        for (; (t0 = sg.t + c * sg.per) <= y; c++) {
          if (t0 > x && t0 <= y && !out(t0, 1)) return false;
          if (t0 + hi > x && t0 + hi <= y && !out(t0 + hi, 0)) return false;
        }
      }
    } else {
      const r = LA.ring[p];
      if (r && r.len) {
        const base = (r.head + LA_N - r.len) % LA_N;
        let j = laFind(r, x), t1 = x;
        if (j < 0) { j = 0; t1 = r.t[base]; }
        if (t1 <= y) {
          if (!out(t1, (r.v[(base + j) % LA_N] >> pin) & 1)) return false;
          for (j++; j < r.len; j++) {
            const i = (base + j) % LA_N;
            if (r.t[i] > y) break;
            if (!out(r.t[i], (r.v[i] >> pin) & 1)) return false;
          }
        }
      } else if (!out(x, ((LA.cur[p] ?? 0) >> pin) & 1)) return false;
    }
    x = y; si++;
  }
  return true;
}

// ------------------------------------------------------------------
// Canali
function laPins() {
  return activePins().filter(i => i.mode !== 3 && i.adcCh === undefined && !/USART/.test(i.func));
}
const laName = i => (i.label ? i.label.replace(/\s*\[.*\]$/, '') : (ARD[i.key] || i.key));
// scelta automatica: 0 commuta davvero (o è un PWM), 1 uscita con etichetta, 2 ingresso EXTI,
// 3 altra uscita; gli ingressi fissi (es. un pulsante senza interrupt) restano fuori
function laAutoCh(pins) {
  const rank = i => (LA.cnt[i.key] || 0) >= 2 || (i.pwm && i.pwm.duty >= 0) ? 0
    : i.mode === 1 && i.label ? 1 : i.exti ? 2 : i.mode === 1 || /^TIM/.test(i.func) ? 3 : 9;
  const keys = pins.map((i, n) => ({ k: i.key, r: rank(i), n })).filter(o => o.r < 9)
    .sort((a, b) => a.r - b.r || a.n - b.n).slice(0, LA_CH).map(o => o.k);
  return Array.from({ length: LA_CH }, (_, n) => keys[n] || '');
}
function laRenderChannels() {
  const pins = laPins();
  const keys = pins.map(i => i.key);
  // (anche dopo, se la scheda Segnali si apre la prima volta più tardi: i cambi contati ci sono già)
  const auto = LA.auto && (laNow() < LA_AUTO_US || !LA.ch.some(Boolean)) ? laAutoCh(pins) : null;
  const key = pins.map(i => i.key + i.label).join() + '|' + LA.auto + '|' + (auto || []).join();
  if (key === LA.pinsKey) return;
  LA.pinsKey = key;
  if (auto) LA.ch = auto;
  else if (!LA.auto) LA.ch = Array.from({ length: LA_CH }, (_, n) => keys.includes((LA.want || [])[n]) ? LA.want[n] : '');
  const opts = '<option value="">—</option>' + pins.map(i => `<option value="${i.key}">${esc(laName(i))} (${i.key}${ARD[i.key] && laName(i) !== ARD[i.key] ? ' ' + ARD[i.key] : ''})</option>`).join('');
  $('#la-canali').innerHTML = LA.ch.map((k, n) => `<label>CH${n} <select data-ch="${n}">${opts}</select></label>`).join('');
  $$('#la-canali select').forEach(s => {
    s.value = LA.ch[+s.dataset.ch];
    s.addEventListener('change', () => { LA.auto = false; LA.ch[+s.dataset.ch] = s.value; LA.want = LA.ch.slice(); laSave(); laTrigOptions(); laButtons(); });
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
  // con tanti canali il grafico si allunga e la scheda scorre
  const mh = Math.max(240, LA_TOP + 8 + 34 * LA.ch.filter(Boolean).length) + 'px';
  if (cv.style.minHeight !== mh) cv.style.minHeight = mh;
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
    const y0 = LA_TOP + r * rowH, hi = y0 + 6, lo = y0 + rowH - 6;
    ctx.fillStyle = col('--text');
    ctx.font = '600 12px ui-monospace, Menlo, monospace';
    ctx.fillText(laLabel(k).slice(0, 9), 8, y0 + rowH / 2);
    ctx.fillStyle = col('--muted');
    ctx.font = '10px system-ui';
    ctx.fillText(`CH${n} ${k}`, 8, y0 + rowH / 2 + 12);
    const color = colors[n % colors.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const tEnd = Math.min(end, laNow());
    let lv = null;
    const ok = laWalk(k, start, tEnd, (t, nl) => {
      const xx = Math.max(LA_L, x(t));
      if (lv === null) ctx.moveTo(xx, nl ? hi : lo);
      else { ctx.lineTo(xx, lv ? hi : lo); ctx.lineTo(xx, nl ? hi : lo); }
      lv = nl;
    }, W);
    if (!ok) {   // onda troppo fitta per lo zoom: banda piena (zooma per vedere i fronti)
      ctx.fillStyle = color + '55';
      ctx.fillRect(LA_L, hi, x(tEnd) - LA_L, lo - hi);
      ctx.moveTo(LA_L, hi); ctx.lineTo(x(tEnd), hi); ctx.moveTo(LA_L, lo); ctx.lineTo(x(tEnd), lo);
    } else if (lv !== null) ctx.lineTo(x(tEnd), lv ? hi : lo);
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
  const a = $('#la-auto');
  if (a) a.classList.toggle('on', LA.auto);
}
// fronti della finestra visibile in CSV: una riga per ogni istante in cui cambia almeno un canale
function laExport() {
  const W = $('#scope').clientWidth, { start, end } = laView(W), tEnd = Math.min(end, laNow());
  const chans = LA.ch.filter(Boolean);
  if (!chans.length) return;
  const ev = [];
  chans.forEach((k, c) => laWalk(k, start, tEnd, (t, lv) => ev.push([t, c, lv]), 200000));
  ev.sort((a, b) => a[0] - b[0]);
  const lv = chans.map(() => ''), rows = [['t_us', ...chans.map(k => `${laLabel(k)} (${k})`)].join(';')];
  for (let i = 0; i < ev.length; i++) {
    lv[ev[i][1]] = ev[i][2];
    if (i + 1 < ev.length && ev[i + 1][0] === ev[i][0]) continue;
    rows.push([ev[i][0].toFixed(3).replace('.', ','), ...lv].join(';'));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\r\n') + '\r\n'], { type: 'text/csv' }));
  a.download = `segnali-${(S.proj && S.proj.name) || 'progetto'}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
    let first = true;
    laWalk(k, t - tol, t + tol, ti => {
      if (first) { first = false; return; }   // il primo è il livello di partenza, non un fronte
      if (Math.abs(ti - t) < bd) { bd = Math.abs(ti - t); best = ti; }
    }, 10000);
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
  $('#la-auto').addEventListener('click', () => { LA.auto = true; LA.want = null; LA.pinsKey = ''; laSave(); laButtons(); });
  $('#la-esporta').addEventListener('click', laExport);
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
