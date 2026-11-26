// local-server.js — il "server" della scheda virtuale, ma dentro la pagina.
// app.js e devices.js sono gli stessi della versione per Mac: chiamano /api/… e
// ascoltano /api/events. Qui fetch ed EventSource vengono intercettati e la
// stessa API è fatta con IndexedDB (progetti per nome utente), un worker che
// compila (clang in WebAssembly) e un worker che esegue la scheda.
import { autoDevices, cleanDevices, makeDevice, deviceSimLines, pinPP, DEV_TYPES } from './devlogic.js?v=2026-11-26b';
import { makeInput, writeInput } from './sim-runtime.js?v=2026-11-26b';
import { readIoc, pinsFromMainH, mcuDefine } from './build.js?v=2026-11-26b';
import { unzipSync, zipSync } from '../vendor/fflate/esm/browser.js';

const dec = new TextDecoder();

import * as CFG from './config.js?v=2026-11-26b';
import { supabaseRemote, fintoRemote, leggiCorto } from './remote.js?v=2026-11-26b';
import { sincronizza } from './sync.js?v=2026-11-26b';
import { leggiLink, esercizioPulito } from './link.js?v=2026-11-26b';
import { pulisciBreadboard, daSalvare } from './circuito.js?v=2026-11-26b';

// ------------------------------------------------------------------
// Utente e progetti in IndexedDB.
// Senza account (config.js vuoto): "utente" è solo un nome scelto, come nella fase 1.
// Con account: "utente" = 'account:<id>' (la copia locale dei progetti online, per l'offline).
// Aperto da un link "Condividi"/"Esercizio" (#progetto=… / #esercizio=…, link.js): anteprima senza
// account né nome, in uno spazio a parte ("link:…"); "Salvalo nei miei progetti" la copia tra i propri.
// prima apertura: la pagina non è ancora sotto il service worker e si ricaricherà da sola (index.html) per
// avere COOP/COEP; qui ci si ferma, se no il compilatore partirebbe a scaricare llvm.core.wasm intero (75 MB)
// invece della versione brotli che dà il service worker
if ('serviceWorker' in navigator && !self.crossOriginIsolated && +(sessionStorage.getItem('sv-ricarica') || 0) < 2) await new Promise(() => {});
// link corto (#c=<id>, supabase/migrazione-4-condivisioni.sql): si legge il contenuto e si apre come un link lungo
const CORTO = /^#c=([A-Za-z0-9_-]{12})$/.exec(location.hash);
let LINK;
if (CORTO) {
  const r = await leggiCorto(CFG, CORTO[1]);
  LINK = r ? leggiLink(`#${r.tipo}=${r.dati}`) : { errore: 'Questo link corto non c\'è (più): chi l\'ha creato può averlo revocato, o è stato copiato male.' };
} else LINK = leggiLink(location.hash);
const ANTEPRIMA = !!LINK && !LINK.errore;
let ACCOUNT = CFG.HA_ACCOUNT && !ANTEPRIMA;
// ospite ("Continua come ospite"): tutto il sito, ma niente si salva — progetti solo in memoria (MEM),
// nessuna scrittura in IndexedDB né in localStorage; ricaricando o chiudendo la scheda si perde tutto
let OSPITE = false;
const MEM = { progetti: new Map(), eliminati: new Map() };
let user = '', shown = '';
let remote = null, account = null;   // con account: remote.js e {id, username, email}
if (ANTEPRIMA) user = shown = 'link:' + hashStr(location.hash);
else if (!ACCOUNT) try { user = shown = localStorage.getItem('sv-utente') || ''; } catch {}

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('scheda-virtuale', 3);
    r.onupgradeneeded = ev => {
      if (ev.oldVersion < 1) r.result.createObjectStore('progetti', { keyPath: ['utente', 'nome'] });
      // progetti eliminati qui mentre ero offline (si eliminano online alla prossima sincronizzazione)
      if (ev.oldVersion < 2) r.result.createObjectStore('eliminati', { keyPath: ['utente', 'id'] });
      // cartella del computer collegata (File System Access): l'handle, per utente
      if (ev.oldVersion < 3) r.result.createObjectStore('cartelle', { keyPath: 'utente' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
let dbp = null;   // si apre solo quando serve (l'ospite non lo apre mai)
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }
// negozio in memoria per l'ospite: le poche operazioni di IndexedDB che usa questo file
function memStore(store) {
  const m = MEM[store], k = key => JSON.stringify(key), dentro = (r, key) => (r instanceof IDBKeyRange ? r.includes(key) : k(r) === k(key));
  const chiave = rec => store === 'progetti' ? [rec.utente, rec.nome] : [rec.utente, rec.id];
  const ord = () => [...m.values()].sort((a, b) => k(chiave(a)) < k(chiave(b)) ? -1 : 1);
  return {
    get: key => ({ result: m.get(k(key)) && structuredClone(m.get(k(key))) }),
    put: rec => { m.set(k(chiave(rec)), structuredClone(rec)); return {}; },
    delete: r => { for (const v of [...m.values()]) if (dentro(r, chiave(v))) m.delete(k(chiave(v))); return {}; },
    getAll: r => ({ result: ord().filter(v => r === undefined || dentro(r, chiave(v))).map(v => structuredClone(v)) }),
  };
}
async function tx(mode, fn, store = 'progetti') {
  if (OSPITE) { const out = fn(memStore(store)); return out && 'result' in out ? out.result : out; }
  if (!dbp) dbp = openDb();
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const dbGet = nome => CARTELLA.prog.has(nome) ? Promise.resolve(copiaRec(CARTELLA.prog.get(nome).rec)) : tx('readonly', s => s.get([user, nome]));
const dbPut = rec => tx('readwrite', s => s.put(rec));
const dbAll = () => tx('readonly', s => s.getAll(IDBKeyRange.bound([user, ''], [user, '￿'])));

const dbDel = nome => tx('readwrite', s => s.delete([user, nome]));
// modifica fatta dall'utente: da sincronizzare
async function userPut(rec) {
  if (CARTELLA.prog.has(rec.nome)) return scriviCartella(rec);   // progetto della cartella collegata: sul disco
  rec.modified = Date.now();
  if (ACCOUNT) rec.sync = { ...(rec.sync || {}), dirty: true };
  await dbPut(rec);
  syncSoon();
}

// ------------------------------------------------------------------
// Cartella collegata (File System Access API, Chrome/Edge): i progetti CubeIDE della cartella scelta si
// leggono dal disco (Core/, .ioc, .cproject, .breadboard.json, .esercizio.json, .scheda-virtuale.json; mai
// Debug/ Release/ Drivers/) e si salvano sul disco: solo i file cambiati, con createWritable (scrive in un
// file temporaneo e lo sostituisce alla chiusura: atomico), avvisando se il file è cambiato sul disco nel
// frattempo. Non si cancella mai niente sul disco. Non entrano nella sincronizzazione (dbAll non li vede).
const CARTELLA = { radice: null, nome: '', stato: 'nessuna', prog: new Map() };   // prog: nome → { rec, dir, file: {rel: {h, mtime}} }
const SALTA_DIR = /^(Debug|Release|Drivers|Middlewares|\.settings|\.git|\.metadata|node_modules)$/;
const copiaRec = r => ({ ...r, files: { ...r.files }, sync: { ...(r.sync || {}) } });
async function leggiProgettoDisco(dir) {
  const files = {}, file = {};
  async function giro(d, rel, prof) {
    for await (const [nome, h] of d.entries()) {
      const r = rel + nome;
      if (h.kind === 'directory') { if (prof < 5 && !SALTA_DIR.test(nome)) await giro(h, r + '/', prof + 1); continue; }
      if (!USEFUL(r) && !/^\.breadboard\.json$/.test(r)) continue;
      if (prof === 0 && !/\.(ioc|json)$|^\.cproject$/.test(nome)) continue;   // in cima solo .ioc, .cproject e i nostri .json
      const f = await h.getFile();
      if (f.size > 2e6) continue;
      files[r] = new Uint8Array(await f.arrayBuffer());
      file[r] = { h, mtime: f.lastModified };
    }
  }
  await giro(dir, '', 0);
  return { files, file };
}
async function caricaCartella() {
  const radice = CARTELLA.radice;
  const nuovi = new Map();
  // la cartella è un progetto, o contiene progetti (cartelle con un .ioc o Core/Src/main.c)
  const eProgetto = async d => { for await (const [n, h] of d.entries()) { if (h.kind === 'file' && n.endsWith('.ioc')) return true; if (h.kind === 'directory' && n === 'Core') { try { await (await h.getDirectoryHandle('Src')).getFileHandle('main.c'); return true; } catch {} } } return false; };
  const dirs = [];
  if (await eProgetto(radice)) dirs.push(radice);
  else for await (const [n, h] of radice.entries()) if (h.kind === 'directory' && !SALTA_DIR.test(n) && await eProgetto(h)) dirs.push(h);
  for (const d of dirs.slice(0, 60)) {
    const { files, file } = await leggiProgettoDisco(d);
    if (!Object.keys(files).some(f => /^Core\/Src\/main\.c$/.test(f))) continue;
    let nome = '📂 ' + d.name, k = 2;
    while (nuovi.has(nome)) nome = `📂 ${d.name} (${k++})`;
    let devices = null;
    if (files['.scheda-virtuale.json']) { try { devices = cleanDevices(JSON.parse(dec.decode(files['.scheda-virtuale.json'])).devices); } catch {} delete files['.scheda-virtuale.json']; }
    const vecchio = CARTELLA.prog.get(nome);
    nuovi.set(nome, { rec: { utente: user, nome, files, devices, sync: {}, modified: Math.max(0, ...Object.values(file).map(x => x.mtime)), cartella: CARTELLA.nome }, dir: d, file, devicesScritti: JSON.stringify(devices), vecchio });
  }
  CARTELLA.prog = nuovi;
  CARTELLA.stato = 'collegata';
  return [...nuovi.keys()];
}
// scrive sul disco i file cambiati (mai cancellazioni)
async function scriviCartella(rec) {
  const p = CARTELLA.prog.get(rec.nome), enc = new TextEncoder();
  const uguali = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
  const scritti = [];
  const file = { ...rec.files };
  if (rec.devices && JSON.stringify(rec.devices) !== p.devicesScritti) file['.scheda-virtuale.json'] = enc.encode(JSON.stringify({ devices: rec.devices }, null, 1));
  for (const [rel, dati] of Object.entries(file)) {
    if (rel !== '.scheda-virtuale.json' && uguali(dati, p.rec.files[rel])) continue;
    if (rel.split('/').includes('..') || !(USEFUL(rel) || rel === '.breadboard.json')) continue;
    let info = p.file[rel];
    if (info) {
      const ora = await info.h.getFile();
      if (ora.lastModified !== info.mtime && !uguali(new Uint8Array(await ora.arrayBuffer()), p.rec.files[rel])
          && !confirm(`${rel} è cambiato sul disco (forse da CubeIDE) dopo che il sito l'ha letto. Sovrascrivo con la versione del sito?\n\nAnnulla: lascio il file del disco com'è.`)) throw new Error(`${rel.split('/').pop()}: non salvato, il file sul disco è più nuovo`);
    } else {
      let d = p.dir;
      const parti = rel.split('/');
      for (const x of parti.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true });
      info = { h: await d.getFileHandle(parti[parti.length - 1], { create: true }), mtime: 0 };
    }
    const w = await info.h.createWritable();      // file temporaneo, sostituito alla chiusura
    await w.write(dati);
    await w.close();
    info.mtime = (await info.h.getFile()).lastModified;
    p.file[rel] = info;
    if (rel === '.scheda-virtuale.json') p.devicesScritti = JSON.stringify(rec.devices);
    else p.rec.files[rel] = dati;
    scritti.push(rel);
  }
  p.rec.devices = rec.devices;
  p.rec.modified = Date.now();
  if (scritti.length) log('info', `Salvato sul disco (${CARTELLA.nome}): ${scritti.map(r => r.split('/').pop()).join(', ')}`);
}
// file cambiati da fuori (es. CubeIDE): ritorna l'elenco dei file aggiornati
async function controllaCartella(nome) {
  const p = CARTELLA.prog.get(nome);
  if (!p) return [];
  const prima = p.file;
  let letto;
  try { letto = await leggiProgettoDisco(p.dir); } catch { return []; }
  const cambiati = [];
  for (const [rel, x] of Object.entries(letto.file)) {
    if (rel === '.scheda-virtuale.json') continue;
    if (!prima[rel] || prima[rel].mtime !== x.mtime) {
      const a = letto.files[rel], b = p.rec.files[rel];
      if (!b || a.length !== b.length || a.some((v, i) => v !== b[i])) { p.rec.files[rel] = a; cambiati.push(rel); }
      prima[rel] = x;
    }
  }
  if (cambiati.length) p.rec.modified = Date.now();
  return cambiati;
}

// ------------------------------------------------------------------
// Progetti da una cartella o da uno zip. files: { "percorso": Uint8Array }.
// Si accettano: un progetto CubeIDE (anche dentro altre cartelle), un intero workspace
// (più progetti), uno zip fatto su Windows (\ nei nomi) o un progetto "sciolto" con
// solo i .c/.h e il .ioc. Header CMSIS/HAL e Debug/ non si tengono: li dà il sito.
const SKIP_DIR = /(^|\/)(Drivers|Middlewares|Debug|Release|__MACOSX|\.settings|\.metadata)\//;
const USEFUL = f => /\.(c|h)$/.test(f) || /(^|\/)[^/]+\.ioc$/.test(f) || /(^|\/)\.cproject$/.test(f) || /(^|\/)\.(scheda-virtuale|esercizio|breadboard)\.json$/.test(f);
const base = f => f.split('/').pop();

export function findProjects(input, fallback = 'progetto') {
  const files = {};
  for (const [k, v] of Object.entries(input)) {
    const n = k.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!n.endsWith('/') && USEFUL(n) && !/(^|\/)\._/.test(n)) files[n] = v;
  }
  const roots = new Map();     // radice → { loose }
  for (const f of Object.keys(files)) {
    if (base(f) !== 'main.c') continue;
    const m = /^(.*?)Core\/Src\/main\.c$/.exec(f);
    if (m && !SKIP_DIR.test(m[1])) { roots.set(m[1], { loose: false }); continue; }
    if (SKIP_DIR.test(f)) continue;
    let dir = f.slice(0, f.length - 'main.c'.length);
    if (/(^|\/)Src\/$/.test(dir)) dir = dir.slice(0, dir.length - 4);
    if (![...roots.keys()].some(r => dir.startsWith(r) && r !== dir)) roots.set(dir, { loose: true });
  }
  const list = [];
  const sorted = [...roots.keys()].sort((x, y) => y.length - x.length);   // prima i più annidati
  const taken = new Set();
  for (const root of sorted) {
    const { loose } = roots.get(root);
    const out = {};
    for (const [f, v] of Object.entries(files)) {
      if (!f.startsWith(root) || taken.has(f)) continue;
      const rel = f.slice(root.length);
      if (SKIP_DIR.test(rel)) continue;
      if (loose) {
        if (rel.includes('/') && !/^(Src|Inc)\/[^/]+$/.test(rel)) continue;
        const n = base(rel);
        if (n.endsWith('.c')) out['Core/Src/' + n] = v;
        else if (n.endsWith('.h')) out['Core/Inc/' + n] = v;
        else out[n] = v;
      } else {
        if (rel.includes('/') && !rel.startsWith('Core/') && !/\.(c|h)$/.test(rel)) continue;
        out[rel] = v;
      }
      taken.add(f);
    }
    const ioc = Object.keys(out).find(f => !f.includes('/') && f.endsWith('.ioc'));
    const nome = (ioc ? ioc.replace(/\.ioc$/, '') : root.replace(/\/$/, '').split('/').pop()) || fallback;
    list.push({ nome: nome.slice(0, 60), root, files: out });
  }
  return list.sort((x, y) => x.nome.localeCompare(y.nome));
}

async function freeName(nome) {
  if (!(await dbGet(nome))) return nome;
  for (let i = 2; ; i++) if (!(await dbGet(`${nome} (${i})`))) return `${nome} (${i})`;
}

// salva un progetto trovato da findProjects; replace: sostituisce quello con lo stesso nome
async function saveProject(p, replace = false) {
  const prev = await dbGet(p.nome);
  const nome = prev && !replace ? await freeName(p.nome) : p.nome;
  const files = { ...p.files };
  let devices = prev && replace ? prev.devices : null;
  const cfg = files['.scheda-virtuale.json'];
  delete files['.scheda-virtuale.json'];
  if (cfg) try { devices = cleanDevices(JSON.parse(dec.decode(cfg)).devices); } catch {}
  await userPut({ utente: user, nome, files, devices, sync: prev && replace ? prev.sync : {} });
  return nome;
}

function iocOf(rec) {
  const iocName = Object.keys(rec.files).find(f => !f.includes('/') && f.endsWith('.ioc'));
  const ioc = { ...readIoc(iocName ? dec.decode(rec.files[iocName]) : ''), file: iocName };
  // senza .ioc: le etichette dei pin da main.h
  if (!iocName && rec.files['Core/Inc/main.h']) ioc.pins = pinsFromMainH(dec.decode(rec.files['Core/Inc/main.h']));
  return ioc;
}
// consegna di un esercizio (file ".esercizio.json" nel progetto, vedi link.js) o null
function esercizioOf(rec) {
  const f = rec.files['.esercizio.json'];
  if (!f) return null;
  try { return esercizioPulito(JSON.parse(dec.decode(f)), rec.files); } catch { return null; }
}
// circuito della breadboard salvato nel progetto, già controllato (vedi circuito.js), o null
function breadboardOf(rec) {
  const f = rec.files['.breadboard.json'];
  if (!f) return null;
  try { const b = pulisciBreadboard(JSON.parse(dec.decode(f))); return daSalvare(b) ? b : null; } catch { return null; }
}
function info(rec) {
  const ioc = iocOf(rec);
  const dev = mcuDefine(ioc.mcu);
  return {
    id: rec.nome, name: rec.nome, workspace: rec.cartella ? '📂 Cartella «' + rec.cartella + '» (sul disco)' : ANTEPRIMA ? 'Aperto da un link' : 'Progetti di ' + shown, path: rec.nome,
    mcu: ioc.mcu || (ioc.file ? '' : 'STM32F401RETx?'), board: ioc.board || (ioc.file ? '' : 'senza .ioc: NUCLEO-F401RE'), modified: rec.modified, elfTime: 0,
    supported: !ioc.file || /^STM32F40?1|^STM32F411/i.test(ioc.mcu || '') || dev === 'STM32F401xE',
  };
}
function projZip(rec, tree, prefix) {
  for (const [k, v] of Object.entries(rec.files)) tree[prefix + k] = v;
  if (rec.devices) tree[prefix + '.scheda-virtuale.json'] = new TextEncoder().encode(JSON.stringify({ devices: rec.devices }));
}
function projectFiles(rec) {
  const order = ['main.c', 'stm32f4xx_it.c', 'stm32f4xx_hal_msp.c'];
  const skip = new Set(['syscalls.c', 'sysmem.c', 'system_stm32f4xx.c']);
  const src = Object.keys(rec.files).filter(f => /^Core\/Src\/[^/]+\.c$/.test(f) && !skip.has(f.slice(9)))
    .sort((a, b) => (order.indexOf(a.slice(9)) + 1 || 99) - (order.indexOf(b.slice(9)) + 1 || 99) || a.localeCompare(b));
  const inc = Object.keys(rec.files).filter(f => /^Core\/Inc\/[^/]+\.h$/.test(f) && !/^stm32f4xx_(hal_conf|it)\.h$/.test(f.slice(9))).sort();
  const sola = (esercizioOf(rec) || { sola: [] }).sola;
  return [...src, ...inc].map(rel => ({ name: rel.split('/').pop(), rel, content: dec.decode(rec.files[rel]), ro: sola.includes(rel) }));
}

// ------------------------------------------------------------------
// Stato ed eventi (come server.js)
const state = { status: 'idle', project: null, source: 'ui', auto: false, debug: false, openSafari: false, platform: 'web', canDebug: false, speed: 1, paused: false, buildErrors: [], startedAt: 0 };
const freshSnapshot = () => ({ M: {}, C: {}, W: {}, K: null, A: {}, Q: null, T: null, Y: {}, B: {}, J: {}, uart: {}, log: [] });
let snap = freshSnapshot();
const listeners = new Set();
function send(type, data) {
  const msg = { data: JSON.stringify({ type, ...data }) };
  for (const es of listeners) setTimeout(() => es.onmessage && es.onmessage(msg), 0);
}
function log(level, text) {
  const e = { t: Date.now(), level, text };
  snap.log.push(e);
  if (snap.log.length > 300) snap.log.shift();
  send('log', e);
}
function setStatus(s, extra = {}) {
  state.status = s;
  Object.assign(state, extra);
  send('status', { state: { ...state } });
}
function absorb(line) {
  const parts = line.split(' ');
  switch (line[0]) {
    case 'M': snap.M[parts[1]] = line; break;
    case 'C': snap.C[parts[2]] = line; break;
    case 'W': snap.W[parts[1] + '_' + parts[2]] = line; break;
    case 'K': snap.K = line; break;
    case 'A': snap.A[parts[1]] = line; break;
    case 'Q': snap.Q = line; break;
    case 'T': snap.T = line; break;
    case 'U': case 'P': {
      const k = line[0] === 'P' ? 'P' : parts[1];
      snap.uart[k] = ((snap.uart[k] || '') + (line[0] === 'P' ? parts[1] : parts[2])).slice(-60000);
      break;
    }
    case 'X': log('warn', line.slice(2)); return false;
    case 'E': log('error', line.slice(2)); return false;
    case 'S': log('stub', line.slice(2)); return false;
    case 'L': log('info', line.slice(2)); return false;
    case 'Z': case 'H': return false;
    case 'Y': snap.Y[parts[1]] = line; break;
    case 'B': snap.B[parts[1]] = line; break;
    case 'J': snap.J[parts[1]] = line; break;
  }
  return true;
}

// ------------------------------------------------------------------
// Compilatore (worker che resta vivo: il clang da ~100 MB si carica una volta sola)
const compiler = new Worker(new URL('./compiler-worker.js?v=2026-11-26b', import.meta.url), { type: 'module' });
let compSeq = 0;
const compPending = new Map();
let compReady = false;
let compStato = null;
compiler.onmessage = ev => {
  const m = ev.data;
  if (m.type === 'progress') {
    compStato = m;      // l'interfaccia può partire dopo (es. finché si sceglie il nome)
    window.dispatchEvent(new CustomEvent('sv-compilatore', { detail: m }));
    if (m.ready) compReady = true;
    return;
  }
  const p = compPending.get(m.seq);
  if (p) { compPending.delete(m.seq); p(m.result); }
};
compiler.onerror = e => log('error', 'Compilatore: ' + (e.message || 'errore'));
compiler.postMessage({ type: 'warmup' });
const compile = (files, debug = false) => new Promise(res => { const seq = ++compSeq; compPending.set(seq, res); compiler.postMessage({ type: 'build', seq, files, debug }); });

// ------------------------------------------------------------------
// Simulazione
let sim = null;        // { worker, sab }
let lastWasm = null;
let drivenPins = [];
function stopSim() {
  if (!sim) return;
  sim.worker.terminate();
  sim = null;
}
function simWrite(lines) { if (sim) writeInput(sim.sab, lines); }
async function pushDevices(devices) {
  if (!sim) return;
  simWrite(drivenPins.map(k => `I ${pinPP(k)} -1`));
  drivenPins = devices.flatMap(d => d.type === 'button' ? [d.pins.pin] : d.type === 'encoder' ? [d.pins.clk, d.pins.dt] : []).filter(Boolean);
  snap.B = {}; snap.J = {};
  simWrite(deviceSimLines(devices));
}
async function devicesOf(nome) {
  const rec = await dbGet(nome);
  if (!rec) return { devices: [], auto: true };
  if (Array.isArray(rec.devices)) return { devices: rec.devices, auto: false };
  return { devices: autoDevices(iocOf(rec)), auto: true };
}

function startSim(wasm) {
  stopSim();
  snap = { ...freshSnapshot(), log: snap.log };
  send('reset', {});
  state.startedAt = Date.now();
  state.paused = false;
  const sab = makeInput();
  const worker = new Worker(new URL('./sim-worker.js?v=2026-11-26b', import.meta.url), { type: 'module' });
  const s = { worker, sab };
  sim = s;
  let buf = '', batch = [], flushT = null;
  const flush = () => { flushT = null; if (batch.length) { send('sim', { lines: batch }); batch = []; } };
  worker.onmessage = ev => {
    if (sim !== s) return;
    const m = ev.data;
    if (m.out) {
      buf += m.out;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line && absorb(line)) batch.push(line);
      }
      if (!flushT) flushT = setTimeout(flush, 25);
    } else if (m.console) send('console', { text: m.console });
    else if ('exit' in m) {
      flush();
      sim = null;
      worker.terminate();
      if (m.exit === 42) { log('info', 'Reset software (NVIC_SystemReset): riavvio'); startSim(wasm); return; }
      log(m.exit ? 'error' : 'info', `Simulazione terminata (codice ${m.exit})`);
      setStatus('stopped');
    } else if (m.trap) {
      flush();
      sim = null;
      worker.terminate();
      log('error', m.trap);
      setStatus('crashed');
    }
  };
  worker.onerror = e => { log('error', 'La simulazione non parte: ' + (e.message || 'errore')); };
  // prima i comandi (velocità, dispositivi), poi parte: la scheda li legge all'avvio
  if (state.speed !== 1) writeInput(sab, [`S ${state.speed}`]);
  drivenPins = [];
  const go = () => worker.postMessage({ wasm, sab });
  // dispositivi I2C/SPI e sensori della breadboard (bus.js) prima di partire
  const bus = () => { if (state.project && window.bbSimLines) writeInput(sab, window.bbSimLines(state.project.id)); };
  if (state.project) devicesOf(state.project.id).then(r => { pushDevices(r.devices); bus(); go(); }); else go();
  setStatus('running', { buildErrors: [] });
}

async function runProject(id, debug = false) {
  const rec = await dbGet(id);
  if (!rec) return { ok: false, errors: [{ file: '', line: 0, msg: 'Progetto non trovato' }] };
  const inf = info(rec);
  if (!inf.supported) {
    log('error', `${inf.name}: micro "${inf.mcu || '?'}" non supportato (per ora solo STM32F4, es. NUCLEO-F401RE)`);
    return { ok: false, errors: [{ file: '', line: 0, msg: 'Micro non supportato: ' + (inf.mcu || 'sconosciuto') }] };
  }
  stopSim();
  setStatus('building', { project: { id: inf.id, name: inf.name, workspace: inf.workspace, path: inf.path }, source: 'ui', buildErrors: [], debug });
  log('info', `Compilo ${inf.name}${debug ? ' per il debug' : ''}` + (compReady ? '' : ' (prima scarico il compilatore)'));
  const t0 = performance.now();
  const r = await compile(rec.files, debug);
  for (const n of r.notes || []) log('info', n);
  if (!r.ok) {
    log('error', `Errori di compilazione (${r.errors.length})`);
    setStatus('error', { buildErrors: r.errors });
    return r;
  }
  const t = ((performance.now() - t0) / 1000).toFixed(1);
  log('info', `Compilato in ${t} s (sorgenti ${(r.T.user / 1000).toFixed(1)} s, HAL simulata ${r.T.halCached ? 'già pronta' : (r.T.hal / 1000).toFixed(1) + ' s'}, link ${(r.T.link / 1000).toFixed(1)} s) — avvio la scheda`);
  window.dispatchEvent(new CustomEvent('sv-compilato', { detail: { ms: performance.now() - t0, T: r.T } }));
  if (r.stubs.length) log('stub', 'Funzioni HAL non simulate (non fanno nulla): ' + r.stubs.join(', '));
  lastWasm = r.wasm;
  if (debug) send('dbg', { tipo: 'mappa', mappa: r.debug });
  startSim(r.wasm);
  return { ok: true, errors: [], stubs: r.stubs };
}

// ------------------------------------------------------------------
// Sincronizzazione con i progetti online (solo con account). La copia nel browser è sempre
// quella su cui si lavora; sync.js la allinea con quella online e non perde niente.
const enc = new TextEncoder();
let syncStato = { stato: ACCOUNT ? 'attesa' : 'locale', quando: 0, rapporto: null, errore: '' };
let syncTimer = null, syncRun = null, nonInviatiPrima = '';
function setSync(x) { syncStato = { ...syncStato, ...x }; window.dispatchEvent(new CustomEvent('sv-sync', { detail: syncStato })); }
function syncSoon() { if (!ACCOUNT) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 2000); setSync({ stato: navigator.onLine ? 'attesa' : 'offline' }); }
function localAdapter() {
  const seen = new Map();     // nome → modified letto all'inizio: se l'utente lo cambia durante la sincronizzazione vince lui
  const toText = files => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? v : dec.decode(v)]));
  const toBytes = files => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc.encode(v)]));
  return {
    async all() {
      const recs = await dbAll();
      for (const r of recs) seen.set(r.nome, r.modified);
      return recs.map(r => ({ nome: r.nome, files: toText(r.files), devices: r.devices ?? null, sync: r.sync || {} }));
    },
    async put(rec, old, daOnline) {
      const cur = await dbGet(old || rec.nome);
      if (cur && seen.has(cur.nome) && cur.modified !== seen.get(cur.nome)) {
        // cambiato qui mentre sincronizzavo: tengo il contenuto nuovo, aggiorno solo il collegamento.
        // Se intanto è arrivata una versione da online, la base resta quella vecchia: alla prossima
        // sincronizzazione è un conflitto e si tengono tutte e due le versioni.
        const s = cur.sync || {};
        cur.sync = daOnline && s.id === rec.sync.id ? { ...s, dirty: true }
          : { ...s, id: rec.sync.id ?? s.id, version: rec.sync.version ?? s.version, dirty: true };
        await dbPut(cur);
        return;
      }
      const nuovo = { utente: user, nome: rec.nome, files: toBytes(rec.files), devices: rec.devices ?? null, sync: rec.sync, modified: cur && old === rec.nome && !rec.sync.dirty ? cur.modified : Date.now() };
      await dbPut(nuovo);
      seen.set(rec.nome, nuovo.modified);
      if (old && old !== rec.nome) { await dbDel(old); seen.delete(old); }
    },
    async del(nome) { await dbDel(nome); },
    tombstones: () => tx('readonly', s => s.getAll(IDBKeyRange.bound([user, ''], [user, '\uffff'])), 'eliminati'),
    clearTombstone: id => tx('readwrite', s => s.delete([user, id]), 'eliminati'),
  };
}
async function syncNow() {
  if (!ACCOUNT || !account) return;
  if (syncRun) return syncRun;
  clearTimeout(syncTimer);
  setSync({ stato: 'in corso' });
  syncRun = sincronizza(localAdapter(), remote).then(rep => {
    setSync({ stato: 'ok', quando: Date.now(), rapporto: rep, errore: '' });
    for (const c of rep.conflitti) log('warn', `Conflitto su "${c.progetto}": era cambiato sia qui sia online. Tengo tutte e due le versioni: quella di qui ora si chiama "${c.copia}".`);
    if (rep.scaricati.length) log('info', 'Scaricati dal tuo account: ' + rep.scaricati.join(', '));
    if (rep.eliminatiQui.length) log('info', 'Eliminati da un altro computer: ' + rep.eliminatiQui.join(', '));
    const fuori = rep.nonInviati.map(x => x.nome).join('\n');      // avviso una volta, non a ogni giro
    if (fuori !== nonInviatiPrima) for (const x of rep.nonInviati) log('warn', `"${x.nome}" resta solo in questo browser: online ${x.motivo}. Elimina o esporta qualche progetto.`);
    nonInviatiPrima = fuori;
  }).catch(e => {
    const code = e && e.code;
    setSync({ stato: code === 'rete' ? 'offline' : code === 'sessione' ? 'sessione' : 'errore', errore: String(e && e.message || e) });
    if (code !== 'rete' && code !== 'sessione') log('error', 'Sincronizzazione non riuscita: ' + (e && e.message || e));
  }).finally(() => { syncRun = null; });
  return syncRun;
}

// ------------------------------------------------------------------
// API (stessi percorsi di server.js)
async function handle(url, body) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/state': return { ...state };
    case '/api/projects': return [...(await dbAll()), ...[...CARTELLA.prog.values()].map(p => p.rec)].map(info).sort((a, b) => b.modified - a.modified);
    case '/api/project': {
      const rec = await dbGet(q.get('id'));
      if (!rec) return { error: 'progetto non trovato' };
      return { info: info(rec), files: projectFiles(rec), ioc: iocOf(rec) };
    }
    case '/api/run': return runProject(body.id, !!body.debug);
    case '/api/stop': stopSim(); setStatus('stopped'); return { ok: true };
    case '/api/reset':
      if (lastWasm && state.project) { log('info', 'Reset'); startSim(lastWasm); return { ok: true }; }
      return { error: 'niente da resettare' };
    case '/api/cmd': {
      const lines = (Array.isArray(body.lines) ? body.lines : [body.line]).filter(l => typeof l === 'string' && /^[IVRSPTKBZE][ -~]{0,4000}$/.test(l));
      for (const l of lines) {
        if (l[0] === 'S') state.speed = parseFloat(l.slice(1)) || 1;
        if (l[0] === 'P') { state.paused = l.trim().endsWith('1'); send('status', { state: { ...state } }); }
      }
      simWrite(lines);
      return { ok: true, running: !!sim };
    }
    case '/api/devices': {
      const id = body ? body.id : q.get('id');
      const rec = await dbGet(id);
      if (!rec) return { error: 'progetto non trovato' };
      if (body) {
        if (body.reset) rec.devices = null;
        else {
          let list = body.devices ? cleanDevices(body.devices) : (await devicesOf(id)).devices;
          if (body.add && DEV_TYPES[body.add] && list.length < 16) list = [...list, makeDevice(body.add, iocOf(rec), list)];
          rec.devices = list;
        }
        await userPut(rec);
        const r = await devicesOf(id);
        if (state.project && state.project.id === id) pushDevices(r.devices);
        send('devices', { id, ...r });
        return r;
      }
      return devicesOf(id);
    }
    case '/api/watch': return { error: 'non disponibile' };
    case '/api/bp': return { breakpoints: {} };
    case '/api/auto': case '/api/safari': return { ok: true };
  }
  return { error: 'sconosciuto: ' + url.pathname };
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  let body = null;
  if (init.method === 'POST') try { body = JSON.parse(init.body || '{}'); } catch { body = {}; }
  let out;
  try { out = await handle(url, body); } catch (e) { out = { error: String(e && e.message || e) }; }
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
};
window.EventSource = class {
  constructor() {
    this.onmessage = null; this.onerror = null;
    listeners.add(this);
    setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'hello', state: { ...state }, snap, dbg: { state: 'off' }, breakpoints: {}, vars: null }) }), 0);
  }
  close() { listeners.delete(this); }
};

// ------------------------------------------------------------------
// Funzioni per la parte nuova dell'interfaccia (web-ui.js)
window.SV = {
  get user() { return user; },
  get compStato() { return compStato; },
  setUser(n) { user = shown = n; try { localStorage.setItem('sv-utente', n); } catch {} },
  get account() { return ACCOUNT ? account : null; },
  get ospite() { return OSPITE; },
  // cartella collegata (cartella.js)
  cartella: {
    supportata: typeof window.showDirectoryPicker === 'function',
    get stato() { return { stato: CARTELLA.stato, nome: CARTELLA.nome, progetti: [...CARTELLA.prog.keys()] }; },
    eCartella: nome => CARTELLA.prog.has(nome),
    // handle: dal selettore (o una cartella OPFS nelle prove)
    async collega(h) {
      CARTELLA.radice = h; CARTELLA.nome = h.name || 'cartella';
      if (!OSPITE) await tx('readwrite', s => s.put({ utente: user, h }), 'cartelle');
      return caricaCartella();
    },
    // all'avvio: l'handle salvato e il permesso (granted: si carica subito; prompt: serve un clic)
    async ricorda() {
      if (OSPITE) return 'nessuna';
      const r = await tx('readonly', s => s.get(user), 'cartelle').catch(() => null);
      if (!r || !r.h) return 'nessuna';
      CARTELLA.radice = r.h; CARTELLA.nome = r.h.name;
      const perm = r.h.queryPermission ? await r.h.queryPermission({ mode: 'readwrite' }) : 'granted';
      if (perm === 'granted') { await caricaCartella(); return 'collegata'; }
      CARTELLA.stato = 'permesso';
      return 'permesso';
    },
    async permesso() {
      const p = await CARTELLA.radice.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') throw new Error('Permesso negato: senza, il sito non può leggere la cartella.');
      return caricaCartella();
    },
    async scollega() { CARTELLA.prog.clear(); CARTELLA.radice = null; CARTELLA.stato = 'nessuna'; CARTELLA.nome = ''; if (!OSPITE) await tx('readwrite', s => s.delete(user), 'cartelle'); },
    ricarica: () => caricaCartella(),
    controlla: nome => controllaCartella(nome),
    // "Copia nel mio account": un progetto normale con gli stessi file (nome libero)
    async copia(nome) {
      const p = CARTELLA.prog.get(nome);
      if (!p) throw new Error('progetto non trovato');
      const nuovo = await freeName(nome.replace(/^📂\s*/, ''));
      const r = copiaRec(p.rec);
      delete r.cartella;
      await userPut({ utente: user, nome: nuovo, files: r.files, devices: r.devices, sync: {} });
      return nuovo;
    },
  },
  // ospite → account: i progetti aperti passano (in sessionStorage, solo per questa scheda) e dopo
  // l'accesso si copiano nell'account, con un nome libero se c'è già (come l'import della fase 1)
  async portaInAccount() {
    const recs = await dbAll(), dec2 = new TextDecoder();
    const dati = recs.map(r => ({ nome: r.nome, devices: r.devices ?? null, files: Object.fromEntries(Object.entries(r.files).map(([k, v]) => [k, dec2.decode(v)])) }));
    const testo = JSON.stringify({ quando: Date.now(), progetti: dati });
    if (testo.length > 4e6) throw new Error('I progetti sono troppo grandi da portare così: scarica lo zip e caricalo dopo aver fatto l\'accesso.');
    sessionStorage.setItem('sv-ospite-porta', testo);
    return dati.length;
  },
  get remote() { return remote; },
  syncNow: () => syncNow(),
  // modifiche non ancora online (progetti cambiati qui + eliminati qui)
  async pending() {
    const recs = await dbAll();
    const t = await tx('readonly', s => s.getAll(IDBKeyRange.bound([user, ''], [user, '\uffff'])), 'eliminati');
    return recs.filter(r => !r.sync || !r.sync.id || r.sync.dirty).length + t.length;
  },
  // all'uscita dall'account: via la copia locale (computer della scuola condivisi)
  async clearLocal() {
    for (const r of await dbAll()) await dbDel(r.nome);
    await tx('readwrite', s => s.delete(IDBKeyRange.bound([user, ''], [user, '\uffff'])), 'eliminati');
  },
  get syncStato() { return syncStato; },
  // progetti salvati nel browser senza account (fase 1, "nome utente" senza password)
  async oldUsers() {
    const all = await tx('readonly', s => s.getAll());
    const m = {};
    for (const r of all) if (!/^(account|link):/.test(r.utente)) m[r.utente] = (m[r.utente] || 0) + 1;
    return m;
  },
  // copia nell'account i progetti di un vecchio nome (quelli originali restano dove sono)
  async importOld(vecchio) {
    const all = await tx('readonly', s => s.getAll(IDBKeyRange.bound([vecchio, ''], [vecchio, '\uffff'])));
    const names = [];
    for (const r of all) names.push(await saveProject({ nome: r.nome, files: r.files, root: '' }, false).then(async n => { const rec = await dbGet(n); if (r.devices) { rec.devices = r.devices; await userPut(rec); } return n; }));
    return names;
  },
  findProjects,
  async exists(nome) { return !!(await dbGet(nome)); },
  // projs: elenco di findProjects; replace: sostituire quelli con lo stesso nome
  async addProjects(projs, replace) {
    const names = [];
    for (const p of projs) names.push(await saveProject(p, replace));
    return names;
  },
  // progetto nuovo dal modello Nucleo-F401RE (modello/nucleo-f401re.json)
  // esempio: id di public/esempi (progetto pronto con il circuito della breadboard)
  async newProject(nome, esempio) {
    const m = await (await fetch(esempio ? `esempi/${encodeURIComponent(esempio)}.json?v=2026-11-26b` : 'modello/nucleo-f401re.json?v=2026-11-26b')).json();
    nome = await freeName(nome || m.nome);
    const enc = new TextEncoder(), files = {};
    for (const [k, v] of Object.entries(m.files)) {
      if (k.endsWith('.ioc')) files[nome + '.ioc'] = enc.encode(v.replace(/^ProjectManager\.ProjectName=.*$/m, 'ProjectManager.ProjectName=' + nome));
      else files[k] = enc.encode(v);
    }
    await userPut({ utente: user, nome, files, devices: null, sync: {} });
    return nome;
  },
  async rename(nome, nuovo) {
    if (CARTELLA.prog.has(nome)) throw new Error('È un progetto della cartella collegata: si rinomina sul disco (o da CubeIDE).');
    nuovo = nuovo.trim().slice(0, 60);
    if (!nuovo || nuovo === nome) return nome;
    if (await dbGet(nuovo)) throw new Error(`Esiste già un progetto "${nuovo}".`);
    const rec = await dbGet(nome);
    const ioc = Object.keys(rec.files).find(f => !f.includes('/') && f.endsWith('.ioc'));
    if (ioc) {
      const t = dec.decode(rec.files[ioc]).replace(/^ProjectManager\.ProjectName=.*$/m, 'ProjectManager.ProjectName=' + nuovo);
      delete rec.files[ioc];
      rec.files[nuovo + '.ioc'] = new TextEncoder().encode(t);
    }
    if (state.project && state.project.id === nome) { stopSim(); setStatus('stopped', { project: null }); }
    await userPut({ ...rec, nome: nuovo });
    await dbDel(nome);
    return nuovo;
  },
  async remove(nome) {
    if (CARTELLA.prog.has(nome)) throw new Error('È un progetto della cartella collegata: dal sito non si cancella niente sul disco. Per toglierlo dall\'elenco scollega la cartella.');
    if (state.project && state.project.id === nome) { stopSim(); setStatus('idle', { project: null }); }
    const rec = await dbGet(nome);
    if (ACCOUNT && rec && rec.sync && rec.sync.id) await tx('readwrite', s => s.put({ utente: user, id: rec.sync.id, version: rec.sync.version }), 'eliminati');
    await dbDel(nome);
    syncSoon();
  },
  // salva un file modificato nel sito
  async saveFile(nome, rel, content) {
    const rec = await dbGet(nome);
    if ((esercizioOf(rec) || { sola: [] }).sola.includes(rel)) throw new Error(rel.split('/').pop() + ' è in sola lettura (lo dà l\'esercizio)');
    rec.files[rel] = new TextEncoder().encode(content);
    await userPut(rec);
  },
  unzip: buf => unzipSync(new Uint8Array(buf)),
  // un progetto o tutti in uno zip (per portarli su un altro computer)
  async exportZip(nome) {
    const all = nome ? [await dbGet(nome)] : await dbAll(), tree = {};
    for (const r of all) projZip(r, tree, `${r.nome}/`);
    return zipSync(tree, { level: 6 });
  },
  log,
  // --- Condividi / Esercizio (condividi.js) ---
  get anteprima() { return ANTEPRIMA ? { nome: LINK.nome, tipo: LINK.tipo } : null; },
  async esercizio(nome) { const rec = await dbGet(nome); return rec ? esercizioOf(rec) : null; },
  // circuito della breadboard (file ".breadboard.json" del progetto, breadboard.js) o null
  async breadboard(nome) { const rec = await dbGet(nome); return rec ? breadboardOf(rec) : null; },
  // quello che va nel link: file come testo, dispositivi, canali dell'analizzatore, consegna
  async perLink(nome) {
    const rec = await dbGet(nome);
    const files = {};
    for (const [k, v] of Object.entries(rec.files)) if (k !== '.esercizio.json' && k !== '.breadboard.json') files[k] = dec.decode(v);
    let canali = null;
    try { canali = JSON.parse(localStorage.getItem(laKey(nome))); } catch {}
    return { nome, files, devices: Array.isArray(rec.devices) ? rec.devices : null, canali: Array.isArray(canali) ? canali : null, esercizio: esercizioOf(rec), breadboard: breadboardOf(rec) };
  },
  // anteprima → "Salvalo nei miei progetti": si ricarica la pagina normale, che la copia (vedi in fondo)
  salvaAnteprima() {
    sessionStorage.setItem('sv-da-salvare', JSON.stringify({ ns: user, nome: LINK.nome }));
    location.replace(location.pathname + location.search);
  },
};
// canali scelti a mano nell'analizzatore (analizzatore.js usa la stessa chiave)
function laKey(nome) { return 'sv-la-ch:' + (ANTEPRIMA ? 'link:' : '') + nome; }

// anteprima: il progetto del link, sempre nuovo a ogni apertura (le prove fatte qui si perdono ricaricando)
async function preparaAnteprima() {
  const enc = new TextEncoder(), files = {};
  for (const [k, v] of Object.entries(LINK.files)) files[k] = enc.encode(v);
  if (LINK.esercizio) files['.esercizio.json'] = enc.encode(JSON.stringify(LINK.esercizio));
  if (LINK.breadboard) files['.breadboard.json'] = enc.encode(JSON.stringify(LINK.breadboard));
  // via le anteprime di altri link aperte più di un giorno fa
  const vecchie = await tx('readonly', s => s.getAll(IDBKeyRange.bound(['link:', ''], ['link:\uffff', '\uffff'])));
  for (const r of vecchie) if (r.utente !== user && Date.now() - (r.modified || 0) > 86400000) await tx('readwrite', s => s.delete([r.utente, r.nome]));
  for (const r of await dbAll()) await dbDel(r.nome);
  await dbPut({ utente: user, nome: LINK.nome, files, devices: LINK.devices ? cleanDevices(LINK.devices) : null, sync: {}, modified: Date.now() });
  try { if (LINK.canali) localStorage.setItem(laKey(LINK.nome), JSON.stringify(LINK.canali)); else localStorage.removeItem(laKey(LINK.nome)); } catch {}
}
// progetti dell'ospite che ha scelto "Crea un account" / "Entra" (vedi SV.portaInAccount): al massimo un'ora fa
async function portaDaOspite() {
  let x = null;
  try { x = JSON.parse(sessionStorage.getItem('sv-ospite-porta')); } catch {}
  try { sessionStorage.removeItem('sv-ospite-porta'); } catch {}
  if (!x || !Array.isArray(x.progetti) || Date.now() - x.quando > 3600000) return [];
  const enc = new TextEncoder(), nomi = [];
  for (const p of x.progetti.slice(0, 50)) {
    if (!p || typeof p.nome !== 'string' || !p.files || typeof p.files !== 'object') continue;
    const files = {};
    for (const [k, v] of Object.entries(p.files)) if (typeof v === 'string' && !k.split('/').includes('..')) files[k] = enc.encode(v);
    const nome = await freeName(p.nome.slice(0, 60).replace(/\//g, '-') || 'Progetto');
    await userPut({ utente: user, nome, files, devices: p.devices ? cleanDevices(p.devices) : null, sync: {} });
    nomi.push(nome);
  }
  return nomi;
}
// dopo "Salvalo nei miei progetti": copia dall'anteprima ai progetti dell'utente (con un nome libero)
async function salvaDaAnteprima() {
  let x;
  try { x = JSON.parse(sessionStorage.getItem('sv-da-salvare')); } catch {}
  sessionStorage.removeItem('sv-da-salvare');
  if (!x || typeof x.ns !== 'string' || !x.ns.startsWith('link:')) return null;
  const rec = await tx('readonly', s => s.get([x.ns, x.nome]));
  if (!rec) return null;
  const nome = await freeName(rec.nome);
  await userPut({ utente: user, nome, files: rec.files, devices: rec.devices, sync: {} });
  try {
    const ch = localStorage.getItem('sv-la-ch:link:' + rec.nome);
    if (ch) localStorage.setItem('sv-la-ch:' + nome, ch); else localStorage.removeItem('sv-la-ch:' + nome);
  } catch {}
  await tx('readwrite', s => s.delete(IDBKeyRange.bound([x.ns, ''], [x.ns, '\uffff'])));
  return nome;
}

// ------------------------------------------------------------------
// Avvio dell'interfaccia: gli script "classici" della versione per Mac, in ordine
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.body.appendChild(s); });
}
if (ANTEPRIMA) await preparaAnteprima();
else if (ACCOUNT) {
  // account online: accesso/iscrizione prima di tutto il resto (auth.js)
  remote = CFG.BACKEND === 'finto' ? fintoRemote(CFG) : await supabaseRemote(CFG);
  const { accedi } = await import('./auth.js?v=2026-11-26b');
  account = await accedi(remote);
  if (account && account.ospite) {
    // localStorage dell'ospite: solo in memoria (temi, schede, guida… non restano nel browser)
    const mem = new Map();
    const finto = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => { mem.set(String(k), String(v)); }, removeItem: k => { mem.delete(k); }, clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    try { Object.defineProperty(window, 'localStorage', { configurable: true, get: () => finto }); } catch {}
    OSPITE = true; ACCOUNT = false; account = null;
    user = 'ospite'; shown = 'ospite';
    try { sessionStorage.removeItem('sv-ospite-porta'); } catch {}
    setSync({ stato: 'locale' });
  } else {
    user = 'account:' + account.id;
    shown = account.username;
  }
} else if (!user) {
  // primo accesso senza account: solo il nome
  const d = document.getElementById('login');
  d.addEventListener('cancel', e => e.preventDefault());
  d.showModal();
  await new Promise(res => document.getElementById('login-form').addEventListener('submit', () => {
    const n = document.getElementById('login-nome').value.trim();
    if (n) { window.SV.setUser(n); res(); }
  }));
}
const salvato = ANTEPRIMA ? null : await salvaDaAnteprima();
const portati = ACCOUNT ? await portaDaOspite() : [];
for (const s of ['devices.js?v=2026-11-26b', 'app.js?v=2026-11-26b', 'analizzatore.js?v=2026-11-26b', 'web-ui.js?v=2026-11-26b']) await loadScript(s);
await import('./editor.js?v=2026-11-26b');
await import('./condividi.js?v=2026-11-26b');
await import('./debug.js?v=2026-11-26b');
await import('./breadboard.js?v=2026-11-26b');
await import('./segnala.js?v=2026-11-26b');
await import('./schema.js?v=2026-11-26b');
await import('./layout.js?v=2026-11-26b');
await import('./aggiorna.js?v=2026-11-26b');
await import('./cartella.js?v=2026-11-26b');
await import('./tocco.js?v=2026-11-26b');
if (LINK && LINK.errore) alert(LINK.errore);
if (portati.length) { log('info', `Portati nel tuo account dalla sessione da ospite: ${portati.join(', ')}`); await loadProjects(); await selectProject(portati[0]); }
if (OSPITE) await import('./ospite.js?v=2026-11-26b');
if (ANTEPRIMA || salvato) {
  await loadProjects();
  await selectProject(ANTEPRIMA ? LINK.nome : salvato);
  if (salvato) log('info', `Salvato nei tuoi progetti: ${salvato}`);
  window.dispatchEvent(new CustomEvent('sv-aperto-da-link'));
}
if (ACCOUNT) {
  syncNow();
  setInterval(syncNow, 60000);
  window.addEventListener('online', syncNow);
}
