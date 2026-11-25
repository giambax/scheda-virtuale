// debug.js — debug passo passo nel sito (fase 2, punto E).
// ⏯ Debug compila il progetto preparato da strumenta.js (punti di arresto a ogni istruzione) con la HAL
// simulata in modo debug (sim_hal.c, SIM_DBG): la scheda si ferma sulla prima riga di main(), poi
//   ▶ Continua (F5) · ❚❚ Pausa · ⤼ Passo (F10, salta le funzioni) · ↧ Entra (F11) · ↥ Esci (⇧F11) · ■ Ferma
// Breakpoint: clic a sinistra dei numeri di riga (salvati per progetto). Scheda "Debug" in basso: stack,
// variabili locali di ogni funzione, globali e espressioni da osservare (nomi di variabili, anche a[2]).
// Punto H (25/11/2026): parametri delle funzioni, strutture campo per campo (anche periferiche e handle della HAL:
// htim3.Instance->CNT, GPIOA->ODR), enum per nome, espressioni in "Da osservare" (a + 1, x[i] > 3, p->campo…),
// modifica di una variabile da fermi (doppio clic sul valore), breakpoint con condizione e "dalla volta n"
// (clic destro sul pallino o sul margine).
// Usa S, $, esc, cmd, showTab, api di app.js, SVeditor di editor.js. Dal simulatore: righe "Y …".
const D = {
  mappa: null,        // { file: [{rel, righe, funzioni, globali}] } dell'ultima compilazione per il debug
  bp: {},             // rel → Set(righe chieste), salvati per progetto
  fermo: null,        // { id, rel, riga, perche, prof }
  frames: [], vars: [], selFrame: 0, raccolta: null,
  watch: [],
  tipi: {},           // tipo → [{ campo, off, dim, t, elem, tn }] (righe "Y t")
  enumi: {},          // tipo → { valore: nome } (righe "Y n")
  opzBP: {},          // rel → { riga: { cond, volte } } (breakpoint condizionali), salvati per progetto
};
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const chiaveBP = () => 'sv-bp:' + (S.selId || ''), chiaveW = () => 'sv-watch:' + (S.selId || ''), chiaveO = () => 'sv-bpopz:' + (S.selId || '');
let progetto = null;
function caricaProgetto() {
  progetto = S.selId;
  D.bp = {};
  try { for (const [rel, l] of Object.entries(JSON.parse(ls.get(chiaveBP())) || {})) D.bp[rel] = new Set(l); } catch {}
  try { D.watch = JSON.parse(ls.get(chiaveW())) || []; } catch { D.watch = []; }
  try { D.opzBP = JSON.parse(ls.get(chiaveO())) || {}; } catch { D.opzBP = {}; }
  D.mappa = null; D.fermo = null;
  if (window.SVeditor) SVeditor.ridisegnaDbg();
}
const salvaBP = () => ls.set(chiaveBP(), JSON.stringify(Object.fromEntries(Object.entries(D.bp).map(([r, s]) => [r, [...s]]))));
const inDebug = () => S.server.debug && (S.server.status === 'running' || S.server.status === 'building');
const fileIdx = rel => D.mappa ? D.mappa.file.findIndex(f => f.rel === rel) : -1;
// riga chiesta → riga vera di arresto (la prima riga con un'istruzione da lì in poi), o 0
function rigaVera(rel, r) {
  const i = fileIdx(rel);
  if (i < 0) return r;
  const righe = D.mappa.file[i].righe;
  return righe.find(x => x >= r) || 0;
}
// 0 niente, 1 breakpoint, 2 breakpoint che si sposta (riga senza istruzioni), 3 con condizione o "dalla volta n"
const opzDi = (rel, r) => (D.opzBP[rel] || {})[r] || null;
function statoBP(rel, r) {
  if (!D.bp[rel] || !D.bp[rel].has(r)) return 0;
  if (D.mappa && rigaVera(rel, r) !== r) return 2;
  return opzDi(rel, r) ? 3 : 1;
}
// clic destro: condizione e "dalla volta n" (mette il breakpoint se non c'è)
function opzioniBP(rel, r) {
  const o = opzDi(rel, r) || {};
  const cond = prompt('Fermati solo se è vera questa condizione (es. i == 5, contatore > 10 && x != 0).\nVuoto = sempre.', o.cond || '');
  if (cond === null) return;
  const v = prompt('Fermati dalla volta numero… (1 = la prima volta che ci passa)', String(o.volte || 1));
  if (v === null) return;
  const volte = Math.max(1, Math.min(1e6, parseInt(v, 10) || 1)), c = cond.trim().slice(0, 120);
  const m = D.opzBP[rel] || (D.opzBP[rel] = {});
  if (c || volte > 1) m[r] = { cond: c, volte }; else delete m[r];
  ls.set(chiaveO(), JSON.stringify(D.opzBP));
  const s = D.bp[rel] || (D.bp[rel] = new Set());
  s.add(r); salvaBP();
  mandaBP(); SVeditor.ridisegnaDbg();
}
function cambiaBP(rel, r) {
  const s = D.bp[rel] || (D.bp[rel] = new Set());
  if (s.has(r)) s.delete(r); else s.add(r);
  salvaBP();
  mandaBP();
  SVeditor.ridisegnaDbg();
}
function mandaBP() {
  if (!D.mappa || !inDebug()) return;
  const ids = [];
  for (const [rel, s] of Object.entries(D.bp)) { const i = fileIdx(rel); if (i < 0) continue; for (const r of s) { const v = rigaVera(rel, r), o = opzDi(rel, r); if (v) ids.push((i + 1) * 100000 + v + (o && o.volte > 1 ? '*' + o.volte : '')); } }
  cmd('B ' + [...new Set(ids)].join(' '));
}
const daId = id => { const f = Math.floor(id / 100000) - 1; return { rel: D.mappa && D.mappa.file[f] ? D.mappa.file[f].rel : null, riga: id % 100000 }; };
function rigaCorrente(rel) {
  if (!D.fermo) return 0;
  const fr = D.frames[D.selFrame];
  const id = fr ? fr.riga : D.fermo.id;
  const x = daId(id);
  return x.rel === rel ? x.riga : 0;
}

// ------------------------------------------------------------------
// valori: byte (esadecimale, little endian) → testo
function leggi(hex, off, n) { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(parseInt(hex.substr((off + i) * 2, 2) || '0', 16)); return v; }
function valore(tipo, hex, off, n) {
  if (n === 0) return '';
  if (tipo === 'f' && n === 4) { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, Number(leggi(hex, off, 4))); return String(+b.getFloat32(0).toPrecision(7)); }
  if (tipo === 'd' && n === 8) { const b = new DataView(new ArrayBuffer(8)); b.setBigUint64(0, leggi(hex, off, 8)); return String(+b.getFloat64(0).toPrecision(12)); }
  if (n > 8) return hex.substr(off * 2, Math.min(n, 16) * 2).replace(/(..)/g, '$1 ').trim() + (n > 16 ? ' …' : '');
  const u = leggi(hex, off, n);
  if (tipo === 'p') return '0x' + u.toString(16).padStart(8, '0');
  if (tipo === 'b') return u ? 'true' : 'false';
  if (tipo === 'i' || tipo === 'c') { const s = BigInt.asIntN(n * 8, u); return tipo === 'c' && s >= 32n && s < 127n ? `${s} '${String.fromCharCode(Number(s))}'` : String(s); }
  if (tipo === 'u') return String(u) + (n >= 2 && u > 9n ? `  (0x${u.toString(16)})` : '');
  return '0x' + u.toString(16);
}
// una "vista" su una variabile: { v (la variabile con i suoi byte), off, dim, tipo, elem, tn }
const vista = v => ({ v, off: 0, dim: v.dim, tipo: v.tipo, elem: v.elem, tn: v.tn });
const campiDi = tn => tn && D.tipi[tn];
function numeroDi(w) {
  const u = leggi(w.v.hex, w.off, Math.min(w.dim, 8));
  if (w.tipo === 'f' && w.dim === 4) { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, Number(u)); return b.getFloat32(0); }
  if (w.tipo === 'd' && w.dim === 8) { const b = new DataView(new ArrayBuffer(8)); b.setBigUint64(0, u); return b.getFloat64(0); }
  if (w.tipo === 'i' || w.tipo === 'c') return BigInt.asIntN(Math.min(w.dim, 8) * 8, u);
  return u;
}
// puntatore → variabile (o periferica) che contiene quell'indirizzo
function puntato(ind, tn) {
  const a = Number(ind);
  const v = D.vars.find(x => x.ind && a >= x.ind && a < x.ind + x.dim && (x.dove !== 'l' || x.f === D.frames[D.selFrame]?.i)) || D.vars.find(x => x.ind && a >= x.ind && a < x.ind + x.dim);
  if (!v || (a - v.ind) >= Math.min(v.dim, 256)) return null;
  return { v, off: a - v.ind, dim: v.dim - (a - v.ind), tipo: tn && campiDi(tn) ? 's' : (a === v.ind ? v.tipo : 'u'), elem: 0, tn: tn || (a === v.ind ? v.tn : '') };
}
function testoVista(w, prof = 0) {
  const campi = w.tipo === 's' && campiDi(w.tn);
  if (campi) {
    const parti = campi.slice(0, prof ? 3 : 4).map(c => `${c.campo}=${testoVista(campo(w, c), prof + 1)}`);
    return `{${parti.join(', ')}${campi.length > (prof ? 3 : 4) ? ', …' : ''}}`;
  }
  if (w.elem && w.elem < w.dim) {
    const n = Math.min(Math.floor(w.dim / w.elem), 32), el = [];
    for (let i = 0; i < n; i++) el.push(valore(w.tipo, w.v.hex, w.off + i * w.elem, w.elem));
    return `[${el.join(', ')}${w.dim / w.elem > 32 ? ', …' : ''}]`;
  }
  const t = valore(w.tipo, w.v.hex, w.off, w.dim);
  const en = D.enumi[w.tn];
  if (en && w.dim <= 8) { const n = numeroDi(w); if (en[String(n)]) return `${en[String(n)]} (${n})`; }
  if (w.tipo === 'p' && w.dim === 4) { const q = puntato(leggi(w.v.hex, w.off, 4), w.tn); if (q) return `${t} → ${q.v.nome}${q.off ? '+' + q.off : ''}`; }
  return t;
}
const campo = (w, c) => ({ v: w.v, off: w.off + c.off, dim: c.dim, tipo: c.t, elem: c.elem, tn: c.tn === '-' ? '' : c.tn });
// righe espandibili per una struttura (campo per campo, anche dentro le strutture)
function righeStruct(w, prof = 0) {
  const campi = campiDi(w.tn);
  if (!campi || prof > 3) return '';
  return `<table class="dbg-tab dbg-campi">${campi.map(c => { const x = campo(w, c), sub = x.tipo === 's' && campiDi(x.tn);
    return `<tr><td class="mono">${esc(c.campo)}</td><td class="mono" ${modificabile(x) ? `data-mod="${x.v.ind + x.off}:${x.tipo}:${x.dim}" title="Doppio clic per cambiarlo"` : ''}>${sub ? `<details><summary>${esc(testoVista(x))}</summary>${righeStruct(x, prof + 1)}</details>` : esc(testoVista(x))}</td></tr>`; }).join('')}</table>`;
}
const modificabile = w => w.v && w.v.ind && !(w.elem && w.elem < w.dim) && w.tipo !== 's' && w.dim >= 1 && w.dim <= 8;
function testoVar(v) {
  if (v.tn && (v.tipo === 's' || D.enumi[v.tn] || v.tipo === 'p')) return testoVista(vista(v));
  if (v.elem && v.elem < v.dim) {
    const n = Math.min(Math.floor(v.dim / v.elem), 32), el = [];
    for (let i = 0; i < n; i++) el.push(valore(v.tipo, v.hex, i * v.elem, v.elem));
    return `[${el.join(', ')}${v.dim / v.elem > 32 ? ', …' : ''}]`;
  }
  return valore(v.tipo, v.hex, 0, v.dim);
}
// espressioni da osservare (e condizioni dei breakpoint): variabili (prima le locali della funzione scelta), campi
// con . e ->, indici [ ], numeri (anche 0x…, 'a'), + - * / % << >> & | ^ ~ ! < > <= >= == != && || e parentesi.
// Le periferiche (GPIOA, TIM3, USART2…) si usano come variabili: GPIOA->ODR, TIM3->CNT, htim3.Instance->CNT.
class ErrEspr extends Error {}
function gettoniEspr(s) {
  const out = [], re = /\s*(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*|'(?:\\.|[^'])'|[A-Za-z_]\w*|->|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^~!<>()[\].])/y;
  let m, i = 0;
  while (i < s.length) { re.lastIndex = i; m = re.exec(s); if (!m) { if (/^\s*$/.test(s.slice(i))) break; throw new ErrEspr('non capisco «' + s.slice(i).trim().slice(0, 12) + '»'); } out.push(m[1]); i = re.lastIndex; }
  return out;
}
function valuta(expr) {
  const t = gettoniEspr(expr);
  let k = 0;
  const vede = x => t[k] === x, prendi = x => { if (t[k] !== x) throw new ErrEspr(`manca «${x}»`); k++; };
  const num = x => (x && x.w) ? (x.w.tipo === 's' ? (() => { throw new ErrEspr('è una struttura: scegli un campo'); })() : numeroDi(x.w)) : x;
  const arit = (a, b, f) => { a = num(a); b = num(b); if (typeof a === 'number' || typeof b === 'number') return f(Number(a), Number(b), false); return f(a, b, true); };
  const bool = x => { x = num(x); return x !== 0 && x !== 0n; };
  const LIV = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  function binaria(l) {
    if (l >= LIV.length) return unaria();
    let a = binaria(l + 1);
    while (LIV[l].includes(t[k])) {
      const op = t[k++], b = binaria(l + 1);
      if (op === '&&') a = bool(a) && bool(b) ? 1n : 0n;
      else if (op === '||') a = bool(a) || bool(b) ? 1n : 0n;
      else a = arit(a, b, (x, y, big) => {
        switch (op) {
          case '+': return x + y; case '-': return x - y; case '*': return x * y;
          case '/': if (y == 0) throw new ErrEspr('divisione per zero'); return big ? x / y : x / y;
          case '%': if (y == 0) throw new ErrEspr('divisione per zero'); return x % y;
          case '<<': case '>>': case '&': case '|': case '^': { if (!big) throw new ErrEspr('operatore solo per interi'); return op === '<<' ? x << y : op === '>>' ? x >> y : op === '&' ? x & y : op === '|' ? x | y : x ^ y; }
          case '==': return x == y ? 1n : 0n; case '!=': return x != y ? 1n : 0n;
          case '<': return x < y ? 1n : 0n; case '>': return x > y ? 1n : 0n; case '<=': return x <= y ? 1n : 0n; case '>=': return x >= y ? 1n : 0n;
        }
      });
    }
    return a;
  }
  function unaria() {
    if (vede('-')) { k++; const a = num(unaria()); return -a; }
    if (vede('+')) { k++; return num(unaria()); }
    if (vede('!')) { k++; return bool(unaria()) ? 0n : 1n; }
    if (vede('~')) { k++; const a = num(unaria()); if (typeof a !== 'bigint') throw new ErrEspr('~ solo per interi'); return ~a; }
    return dopo(primaria());
  }
  function primaria() {
    const x = t[k++];
    if (x === undefined) throw new ErrEspr('espressione incompleta');
    if (x === '(') { const a = binaria(0); prendi(')'); return a; }
    if (/^'/.test(x)) return BigInt((x[1] === '\\' ? { n: 10, t: 9, r: 13, 0: 0 }[x[2]] ?? x.charCodeAt(2) : x.charCodeAt(1)));
    if (/^(0[xX]|\d)/.test(x)) { const c = x.replace(/[uUlLfF]+$/, ''); return /[.eE]/.test(c) && !/^0[xX]/.test(c) ? Number(c) : BigInt(c); }
    if (/^[A-Za-z_]/.test(x)) {
      const fr = D.frames[D.selFrame]?.i;
      const v = D.vars.find(y => y.dove === 'l' && y.f === fr && y.nome === x) || D.vars.find(y => y.dove === 'g' && y.nome === x) || D.vars.find(y => y.dove === 'r' && y.nome === x);
      if (!v) throw new ErrEspr(`«${x}» non è visibile qui`);
      return { w: vista(v) };
    }
    throw new ErrEspr(`non mi aspettavo «${x}»`);
  }
  function dopo(a) {
    for (;;) {
      if (vede('.') || vede('->')) {
        const freccia = t[k++] === '->', nome = t[k++];
        if (!a || !a.w) throw new ErrEspr('. e -> solo dopo una variabile');
        let w = a.w;
        if (freccia && w.tipo === 'p') { const q = puntato(numeroDi(w), w.tn); if (!q) throw new ErrEspr('il puntatore non va a una variabile che conosco'); w = q; }
        const c = (campiDi(w.tn) || []).find(c => c.campo === nome);
        if (!c) throw new ErrEspr(campiDi(w.tn) ? `${w.tn} non ha il campo «${nome}»` : 'non conosco i campi di questo tipo');
        a = { w: campo(w, c) };
      } else if (vede('[')) {
        k++; const i = Number(num(binaria(0))); prendi(']');
        if (!a || !a.w) throw new ErrEspr('[ ] solo dopo un array');
        const w = a.w;
        if (!(w.elem && w.elem < w.dim)) throw new ErrEspr('non è un array');
        if (i < 0 || (i + 1) * w.elem > w.dim || w.off + (i + 1) * w.elem > 256) throw new ErrEspr('indice fuori dall\'array (o oltre i primi 256 byte)');
        a = { w: { ...w, off: w.off + i * w.elem, dim: w.elem, elem: 0 } };
      } else return a;
    }
  }
  const r = binaria(0);
  if (k < t.length) throw new ErrEspr(`non mi aspettavo «${t[k]}»`);
  return r;
}
function osserva(expr) {
  try {
    const r = valuta(expr);
    if (r && r.w) return testoVista(r.w);
    if (typeof r === 'number') return String(+r.toPrecision(10));
    return String(r) + (r > 9n || r < -9n ? `  (0x${(r < 0n ? BigInt.asUintN(32, r) : r).toString(16)})` : '');
  } catch (e) { return e instanceof ErrEspr ? e.message : 'errore: ' + e.message; }
}
// nuovo valore da scrivere (numero, 0x…, true/false, 'a', 1.5) → byte esadecimali little endian
function codifica(testo, tipo, dim) {
  const s = testo.trim();
  let v;
  if (tipo === 'f' || tipo === 'd') {
    const x = Number(s.replace(',', '.'));
    if (!Number.isFinite(x)) throw new ErrEspr('non è un numero');
    const b = new DataView(new ArrayBuffer(8));
    if (dim === 4) { b.setFloat32(0, x, true); return [...new Uint8Array(b.buffer, 0, 4)].map(x => x.toString(16).padStart(2, '0')).join(''); }
    b.setFloat64(0, x, true); return [...new Uint8Array(b.buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  if (/^(true|false)$/i.test(s)) v = /^t/i.test(s) ? 1n : 0n;
  else if (/^'.'$/.test(s)) v = BigInt(s.charCodeAt(1));
  else if (/^-?(0[xX][0-9a-fA-F]+|\d+)$/.test(s)) v = s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
  else throw new ErrEspr('scrivi un numero (anche 0x…, true/false o \'a\')');
  v = BigInt.asUintN(dim * 8, v);
  let h = '';
  for (let i = 0; i < dim; i++) { h += Number(v & 255n).toString(16).padStart(2, '0'); v >>= 8n; }
  return h;
}
function modifica(ind, tipo, dim, nome, attuale) {
  const t = prompt(`Nuovo valore per ${nome}`, attuale);
  if (t === null) return;
  try { cmd(`Z w ${ind} ${codifica(t, tipo, dim)}`); } catch (e) { alert(e.message); }
}

// ------------------------------------------------------------------
// righe dal simulatore
window.dbgOnY = line => {
  const a = line.split(' ');
  if (a[1] === 'stop') { D.raccolta = { id: +a[2], perche: a[3], prof: +a[4], frames: [], vars: [] }; return; }
  if (a[1] === 'f' && D.raccolta) { D.raccolta.frames.push({ i: +a[2], nome: a[3], riga: +a[4] }); return; }
  if (a[1] === 'v' && D.raccolta) { D.raccolta.vars.push({ dove: a[2], f: +a[3], nome: a[4], tipo: a[5], elem: +a[6], dim: +a[7], ind: +a[8], tn: a[9] === '-' ? '' : a[9], hex: a[10] || '' }); return; }
  if (a[1] === 't') { (D.tipi[a[2]] || (D.tipi[a[2]] = [])).push({ campo: a[3], off: +a[4], dim: +a[5], t: a[6], elem: +a[7], tn: a[8] === '-' ? '' : a[8] }); return; }
  if (a[1] === 'n') { (D.enumi[a[2]] || (D.enumi[a[2]] = {}))[a[4]] = a[3]; return; }
  if (a[1] === 'fine' && D.raccolta) {
    const r = D.raccolta; D.raccolta = null;
    const stessoPunto = D.fermo && D.fermo.id === r.id;   // rimandato dopo una modifica: resta sulla funzione scelta
    D.fermo = { id: r.id, perche: r.perche, prof: r.prof, ...daId(r.id) };
    D.frames = r.frames; D.vars = r.vars; if (!stessoPunto) D.selFrame = 0;
    // breakpoint con condizione: se è falsa si riparte subito (senza mostrare niente)
    if (r.perche === 'bp' && !stessoPunto) {
      const conds = Object.entries(D.opzBP[D.fermo.rel] || {}).filter(([rr, o]) => o.cond && rigaVera(D.fermo.rel, +rr) === D.fermo.riga);
      if (conds.length) {
        let vero = false, errore = '';
        for (const [, o] of conds) { try { if (num0(valuta(o.cond))) vero = true; } catch (e) { errore = e.message; vero = true; } }
        if (!vero) { D.fermo = null; cmd('Z c'); return; }
        if (errore) D.fermo.nota = 'condizione del breakpoint: ' + errore;
      }
    }
    if (D.fermo.rel) { showTab('code'); SVeditor.show(D.fermo.rel, D.fermo.riga); }
    SVeditor.ridisegnaDbg();
    disegna();
    return;
  }
  if (a[1] === 'via') { D.fermo = null; SVeditor.ridisegnaDbg(); disegna(); }
};
const num0 = x => { const n = x && x.w ? numeroDi(x.w) : x; return n !== 0 && n !== 0n; };
window.dbgOnEvent = m => {
  if (m.tipo === 'mappa') { D.mappa = m.mappa; D.tipi = {}; D.enumi = {}; D.fermo = null; mandaBP(); SVeditor.ridisegnaDbg(); disegna(); showTab('vars'); }
};
window.dbgOnReset = () => { D.fermo = null; D.raccolta = null; setTimeout(() => { mandaBP(); disegna(); }, 0); if (window.SVeditor) SVeditor.ridisegnaDbg(); };
window.dbgFrame = () => {
  if (S.selId !== progetto) caricaProgetto();
  const vis = !!S.server.debug && ['running', 'building'].includes(S.server.status);
  if (vis !== D.vis) { D.vis = vis; $('#dbgbar').hidden = !vis; document.querySelector('.tab[data-tab="vars"]').hidden = !vis && !D.fermo; if (!vis) { D.fermo = null; if (window.SVeditor) SVeditor.ridisegnaDbg(); } disegna(); }
};

// ------------------------------------------------------------------
// comandi
const passo = c => {
  if (!inDebug()) return;
  if (c !== 'p' && !D.fermo) return;
  cmd('Z ' + c);
  if (c !== 'p') { D.fermo = null; SVeditor.ridisegnaDbg(); disegna(); }   // riparte: il prossimo "Y stop" dirà dove si ferma
};
function disegna() {
  const bar = $('#dbgbar');
  if (!bar.dataset.fatto) {
    bar.dataset.fatto = 1;
    bar.innerHTML = `<div class="dbg-tasti">
      <button type="button" data-z="c" title="Continua fino al prossimo breakpoint (F5)">▶ Continua</button>
      <button type="button" data-z="p" title="Ferma il programma dove si trova">❚❚ Pausa</button>
      <button type="button" data-z="n" title="Passo: esegue la riga, senza entrare nelle funzioni (F10)">⤼ Passo</button>
      <button type="button" data-z="s" title="Entra nella funzione chiamata sulla riga (F11)">↧ Entra</button>
      <button type="button" data-z="o" title="Esci dalla funzione e fermati dopo la chiamata (Maiusc+F11)">↥ Esci</button>
      <button type="button" data-ferma title="Ferma il debug (la scheda si spegne)">■ Ferma</button></div>
      <span class="dbg-dove small"></span>`;
    bar.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => passo(b.dataset.z)));
    bar.querySelector('[data-ferma]').addEventListener('click', () => api('/api/stop', {}));
  }
  const f = D.fermo;
  bar.querySelectorAll('[data-z]').forEach(b => { b.disabled = b.dataset.z === 'p' ? !!f : !f; });
  bar.querySelector('.dbg-dove').textContent = f
    ? `Fermo in ${f.rel ? f.rel.split('/').pop() : '?'}:${f.riga} — ${{ bp: 'breakpoint', passo: 'passo', pausa: 'pausa' }[f.perche] || f.perche}${D.frames[0] ? ' · ' + D.frames[0].nome + '()' : ''}${f.nota ? ' · ' + f.nota : ''}`
    : D.mappa ? 'In esecuzione… (Pausa per fermarlo, o un breakpoint)' : 'Compilo per il debug…';
  // pannello "Debug"
  const box = $('#vars');
  if (!box) return;
  if (!f) { box.innerHTML = `<p class="empty">${inDebug() ? 'Il programma è in esecuzione: ❚❚ Pausa o un breakpoint per vedere stack e variabili.' : 'Premi ⏯ Debug: il programma si ferma sulla prima riga di main(). Clic a sinistra dei numeri di riga per i breakpoint.'}</p>`; return; }
  const fr = D.frames[D.selFrame] || {};
  const riga = v => { const w = vista(v), st = v.tipo === 's' && campiDi(v.tn);
    return `<tr><td class="mono">${esc(v.nome)}</td><td class="mono" ${modificabile(w) ? `data-mod="${v.ind}:${v.tipo}:${v.dim}" title="Doppio clic per cambiarlo"` : ''}>${st ? `<details><summary>${esc(testoVar(v))}</summary>${righeStruct(w)}</details>` : esc(testoVar(v))}</td><td class="muted small">${esc(tipoLeggibile(v))}</td></tr>`; };
  const loc = D.vars.filter(v => v.dove === 'l' && v.f === fr.i), glob = D.vars.filter(v => v.dove === 'g');
  box.innerHTML = `<div class="dbg-griglia">
    <section><h4>Stack</h4><ol class="dbg-stack">${D.frames.map((x, k) => { const p = daId(x.riga); return `<li class="${k === D.selFrame ? 'on' : ''}" data-k="${k}"><b>${esc(x.nome)}()</b> <span class="muted small">${p.rel ? esc(p.rel.split('/').pop()) + ':' + p.riga : ''}</span></li>`; }).join('')}</ol></section>
    <section><h4>Variabili locali — ${esc(fr.nome || '')}()</h4>${loc.length ? `<table class="dbg-tab">${loc.map(riga).join('')}</table>` : '<p class="muted small">Nessuna (o non ancora dichiarate a questo punto).</p>'}</section>
    <section><h4>Da osservare</h4><table class="dbg-tab">${D.watch.map((w, k) => `<tr><td class="mono">${esc(w)}</td><td class="mono">${esc(osserva(w))}</td><td><button type="button" class="ghost small" data-tw="${k}" title="Togli">✕</button></td></tr>`).join('')}</table>
      <form class="dbg-watch"><input type="text" placeholder="es. conta, x[2], htim3.Instance->CNT, GPIOA->ODR, a + 1" maxlength="80"><button type="submit" class="small">Aggiungi</button></form></section>
    <section><h4>Variabili globali</h4>${glob.length ? `<table class="dbg-tab">${glob.map(riga).join('')}</table>` : '<p class="muted small">Nessuna.</p>'}</section>
  </div>`;
  box.querySelectorAll('.dbg-stack li').forEach(li => li.addEventListener('click', () => { D.selFrame = +li.dataset.k; const p = daId(D.frames[D.selFrame].riga); if (p.rel) SVeditor.show(p.rel, p.riga); SVeditor.ridisegnaDbg(); disegna(); }));
  box.querySelectorAll('[data-mod]').forEach(td => td.addEventListener('dblclick', ev => { ev.preventDefault(); const [ind, tipo, dim] = td.dataset.mod.split(':'); const nome = td.parentNode.firstElementChild.textContent; const sum = td.querySelector('summary'); modifica(+ind, tipo, +dim, nome, (sum ? sum.textContent : td.textContent).split(/\s|→/)[0]); }));
  box.querySelectorAll('[data-tw]').forEach(b => b.addEventListener('click', () => { D.watch.splice(+b.dataset.tw, 1); ls.set(chiaveW(), JSON.stringify(D.watch)); disegna(); }));
  box.querySelector('.dbg-watch').addEventListener('submit', e => { e.preventDefault(); const v = e.target.querySelector('input').value.trim(); if (v && D.watch.length < 20) { D.watch.push(v); ls.set(chiaveW(), JSON.stringify(D.watch)); } disegna(); });
}
const tipoLeggibile = v => {
  const base = (v.tn && v.tipo === 's' ? v.tn : v.tn && v.tipo === 'p' ? v.tn + ' *' : v.tn && D.enumi[v.tn] ? 'enum ' + v.tn : '') || { f: 'float', d: 'double', u: 'senza segno', i: 'con segno', c: 'char', b: 'bool', p: 'puntatore', s: 'struttura' }[v.tipo] || v.tipo;
  return v.elem && v.elem < v.dim ? `array di ${Math.floor(v.dim / v.elem)} (${base}, ${v.elem} byte)` : `${base}, ${v.dim} byte`;
};
window.addEventListener('keydown', e => {
  if (!inDebug()) return;
  if (e.key === 'F5') { e.preventDefault(); passo('c'); }
  else if (e.key === 'F10') { e.preventDefault(); passo('n'); }
  else if (e.key === 'F11') { e.preventDefault(); passo(e.shiftKey ? 'o' : 's'); }
});
document.querySelector('.tab[data-tab="vars"]').textContent = 'Debug';
window.SVdbg = { statoBP, cambiaBP, opzioniBP, rigaCorrente, D, passo, osserva, codifica };
caricaProgetto();
if (window.SVeditor) SVeditor.ridisegnaDbg();
