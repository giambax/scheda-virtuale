// debug.js — debug passo passo nel sito (fase 2, punto E).
// ⏯ Debug compila il progetto preparato da strumenta.js (punti di arresto a ogni istruzione) con la HAL
// simulata in modo debug (sim_hal.c, SIM_DBG): la scheda si ferma sulla prima riga di main(), poi
//   ▶ Continua (F5) · ❚❚ Pausa · ⤼ Passo (F10, salta le funzioni) · ↧ Entra (F11) · ↥ Esci (⇧F11) · ■ Ferma
// Breakpoint: clic a sinistra dei numeri di riga (salvati per progetto). Scheda "Debug" in basso: stack,
// variabili locali di ogni funzione, globali e espressioni da osservare (nomi di variabili, anche a[2]).
// Usa S, $, esc, cmd, showTab, api di app.js, SVeditor di editor.js. Dal simulatore: righe "Y …".
const D = {
  mappa: null,        // { file: [{rel, righe, funzioni, globali}] } dell'ultima compilazione per il debug
  bp: {},             // rel → Set(righe chieste), salvati per progetto
  fermo: null,        // { id, rel, riga, perche, prof }
  frames: [], vars: [], selFrame: 0, raccolta: null,
  watch: [],
};
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const chiaveBP = () => 'sv-bp:' + (S.selId || ''), chiaveW = () => 'sv-watch:' + (S.selId || '');
let progetto = null;
function caricaProgetto() {
  progetto = S.selId;
  D.bp = {};
  try { for (const [rel, l] of Object.entries(JSON.parse(ls.get(chiaveBP())) || {})) D.bp[rel] = new Set(l); } catch {}
  try { D.watch = JSON.parse(ls.get(chiaveW())) || []; } catch { D.watch = []; }
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
// 0 niente, 1 breakpoint, 2 breakpoint che si sposta (riga senza istruzioni)
function statoBP(rel, r) {
  if (!D.bp[rel] || !D.bp[rel].has(r)) return 0;
  return !D.mappa || rigaVera(rel, r) === r ? 1 : 2;
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
  for (const [rel, s] of Object.entries(D.bp)) { const i = fileIdx(rel); if (i < 0) continue; for (const r of s) { const v = rigaVera(rel, r); if (v) ids.push((i + 1) * 100000 + v); } }
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
function testoVar(v) {
  if (v.elem && v.elem < v.dim) {
    const n = Math.min(Math.floor(v.dim / v.elem), 32), el = [];
    for (let i = 0; i < n; i++) el.push(valore(v.tipo, v.hex, i * v.elem, v.elem));
    return `[${el.join(', ')}${v.dim / v.elem > 32 ? ', …' : ''}]`;
  }
  return valore(v.tipo, v.hex, 0, v.dim);
}
// espressione da osservare: nome o nome[i] (cerca prima tra le locali della funzione scelta)
function osserva(expr) {
  const m = /^\s*([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(expr);
  if (!m) return 'solo nomi di variabili, o nome[indice]';
  const v = D.vars.find(x => x.dove === 'l' && x.f === D.frames[D.selFrame]?.i && x.nome === m[1]) || D.vars.find(x => x.dove === 'g' && x.nome === m[1]);
  if (!v) return 'non visibile qui';
  if (m[2] === undefined) return testoVar(v);
  if (!v.elem) return 'non è un array';
  const i = +m[2];
  if ((i + 1) * v.elem > Math.min(v.dim, 256)) return 'indice fuori dall\'array (o oltre i primi 256 byte)';
  return valore(v.tipo, v.hex, i * v.elem, v.elem);
}

// ------------------------------------------------------------------
// righe dal simulatore
window.dbgOnY = line => {
  const a = line.split(' ');
  if (a[1] === 'stop') { D.raccolta = { id: +a[2], perche: a[3], prof: +a[4], frames: [], vars: [] }; return; }
  if (a[1] === 'f' && D.raccolta) { D.raccolta.frames.push({ i: +a[2], nome: a[3], riga: +a[4] }); return; }
  if (a[1] === 'v' && D.raccolta) { D.raccolta.vars.push({ dove: a[2], f: +a[3], nome: a[4], tipo: a[5], elem: +a[6], dim: +a[7], hex: a[8] || '' }); return; }
  if (a[1] === 'fine' && D.raccolta) {
    const r = D.raccolta; D.raccolta = null;
    D.fermo = { id: r.id, perche: r.perche, prof: r.prof, ...daId(r.id) };
    D.frames = r.frames; D.vars = r.vars; D.selFrame = 0;
    if (D.fermo.rel) { showTab('code'); SVeditor.show(D.fermo.rel, D.fermo.riga); }
    SVeditor.ridisegnaDbg();
    disegna();
    return;
  }
  if (a[1] === 'via') { D.fermo = null; SVeditor.ridisegnaDbg(); disegna(); }
};
window.dbgOnEvent = m => {
  if (m.tipo === 'mappa') { D.mappa = m.mappa; D.fermo = null; mandaBP(); SVeditor.ridisegnaDbg(); disegna(); showTab('vars'); }
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
    ? `Fermo in ${f.rel ? f.rel.split('/').pop() : '?'}:${f.riga} — ${{ bp: 'breakpoint', passo: 'passo', pausa: 'pausa' }[f.perche] || f.perche}${D.frames[0] ? ' · ' + D.frames[0].nome + '()' : ''}`
    : D.mappa ? 'In esecuzione… (Pausa per fermarlo, o un breakpoint)' : 'Compilo per il debug…';
  // pannello "Debug"
  const box = $('#vars');
  if (!box) return;
  if (!f) { box.innerHTML = `<p class="empty">${inDebug() ? 'Il programma è in esecuzione: ❚❚ Pausa o un breakpoint per vedere stack e variabili.' : 'Premi ⏯ Debug: il programma si ferma sulla prima riga di main(). Clic a sinistra dei numeri di riga per i breakpoint.'}</p>`; return; }
  const fr = D.frames[D.selFrame] || {};
  const riga = v => `<tr><td class="mono">${esc(v.nome)}</td><td class="mono">${esc(testoVar(v))}</td><td class="muted small">${esc(tipoLeggibile(v))}</td></tr>`;
  const loc = D.vars.filter(v => v.dove === 'l' && v.f === fr.i), glob = D.vars.filter(v => v.dove === 'g');
  box.innerHTML = `<div class="dbg-griglia">
    <section><h4>Stack</h4><ol class="dbg-stack">${D.frames.map((x, k) => { const p = daId(x.riga); return `<li class="${k === D.selFrame ? 'on' : ''}" data-k="${k}"><b>${esc(x.nome)}()</b> <span class="muted small">${p.rel ? esc(p.rel.split('/').pop()) + ':' + p.riga : ''}</span></li>`; }).join('')}</ol></section>
    <section><h4>Variabili locali — ${esc(fr.nome || '')}()</h4>${loc.length ? `<table class="dbg-tab">${loc.map(riga).join('')}</table>` : '<p class="muted small">Nessuna (o non ancora dichiarate a questo punto).</p>'}</section>
    <section><h4>Da osservare</h4><table class="dbg-tab">${D.watch.map((w, k) => `<tr><td class="mono">${esc(w)}</td><td class="mono">${esc(osserva(w))}</td><td><button type="button" class="ghost small" data-tw="${k}" title="Togli">✕</button></td></tr>`).join('')}</table>
      <form class="dbg-watch"><input type="text" placeholder="nome o nome[2]" maxlength="60"><button type="submit" class="small">Aggiungi</button></form></section>
    <section><h4>Variabili globali</h4>${glob.length ? `<table class="dbg-tab">${glob.map(riga).join('')}</table>` : '<p class="muted small">Nessuna.</p>'}</section>
  </div>`;
  box.querySelectorAll('.dbg-stack li').forEach(li => li.addEventListener('click', () => { D.selFrame = +li.dataset.k; const p = daId(D.frames[D.selFrame].riga); if (p.rel) SVeditor.show(p.rel, p.riga); SVeditor.ridisegnaDbg(); disegna(); }));
  box.querySelectorAll('[data-tw]').forEach(b => b.addEventListener('click', () => { D.watch.splice(+b.dataset.tw, 1); ls.set(chiaveW(), JSON.stringify(D.watch)); disegna(); }));
  box.querySelector('.dbg-watch').addEventListener('submit', e => { e.preventDefault(); const v = e.target.querySelector('input').value.trim(); if (v && D.watch.length < 20) { D.watch.push(v); ls.set(chiaveW(), JSON.stringify(D.watch)); } disegna(); });
}
const tipoLeggibile = v => {
  const base = { f: 'float', d: 'double', u: 'senza segno', i: 'con segno', c: 'char', b: 'bool', p: 'puntatore', s: 'struttura' }[v.tipo] || v.tipo;
  return v.elem && v.elem < v.dim ? `array di ${Math.floor(v.dim / v.elem)} (${base}, ${v.elem} byte)` : `${base}, ${v.dim} byte`;
};
window.addEventListener('keydown', e => {
  if (!inDebug()) return;
  if (e.key === 'F5') { e.preventDefault(); passo('c'); }
  else if (e.key === 'F10') { e.preventDefault(); passo('n'); }
  else if (e.key === 'F11') { e.preventDefault(); passo(e.shiftKey ? 'o' : 's'); }
});
document.querySelector('.tab[data-tab="vars"]').textContent = 'Debug';
window.SVdbg = { statoBP, cambiaBP, rigaCorrente, D, passo, osserva };
caricaProgetto();
if (window.SVeditor) SVeditor.ridisegnaDbg();
