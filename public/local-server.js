// local-server.js — il "server" della scheda virtuale, ma dentro la pagina.
// app.js e devices.js sono gli stessi della versione per Mac: chiamano /api/… e
// ascoltano /api/events. Qui fetch ed EventSource vengono intercettati e la
// stessa API è fatta con IndexedDB (progetti per nome utente), un worker che
// compila (clang in WebAssembly) e un worker che esegue la scheda.
import { autoDevices, cleanDevices, makeDevice, deviceSimLines, pinPP, DEV_TYPES } from './devlogic.js';
import { makeInput, writeInput } from './sim-runtime.js';
import { readIoc, pinsFromMainH, mcuDefine } from './build.js';
import { unzipSync, zipSync } from '../vendor/fflate/esm/browser.js';

const dec = new TextDecoder();

import * as CFG from './config.js';
import { supabaseRemote, fintoRemote } from './remote.js';
import { sincronizza } from './sync.js';

// ------------------------------------------------------------------
// Utente e progetti in IndexedDB.
// Senza account (config.js vuoto): "utente" è solo un nome scelto, come nella fase 1.
// Con account: "utente" = 'account:<id>' (la copia locale dei progetti online, per l'offline).
const ACCOUNT = CFG.HA_ACCOUNT;
let user = '', shown = '';
let remote = null, account = null;   // con account: remote.js e {id, username, email}
if (!ACCOUNT) try { user = shown = localStorage.getItem('sv-utente') || ''; } catch {}

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('scheda-virtuale', 2);
    r.onupgradeneeded = ev => {
      if (ev.oldVersion < 1) r.result.createObjectStore('progetti', { keyPath: ['utente', 'nome'] });
      // progetti eliminati qui mentre ero offline (si eliminano online alla prossima sincronizzazione)
      if (ev.oldVersion < 2) r.result.createObjectStore('eliminati', { keyPath: ['utente', 'id'] });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const dbp = openDb();
async function tx(mode, fn, store = 'progetti') {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const dbGet = nome => tx('readonly', s => s.get([user, nome]));
const dbPut = rec => tx('readwrite', s => s.put(rec));
const dbAll = () => tx('readonly', s => s.getAll(IDBKeyRange.bound([user, ''], [user, '￿'])));

const dbDel = nome => tx('readwrite', s => s.delete([user, nome]));
// modifica fatta dall'utente: da sincronizzare
async function userPut(rec) {
  rec.modified = Date.now();
  if (ACCOUNT) rec.sync = { ...(rec.sync || {}), dirty: true };
  await dbPut(rec);
  syncSoon();
}

// ------------------------------------------------------------------
// Progetti da una cartella o da uno zip. files: { "percorso": Uint8Array }.
// Si accettano: un progetto CubeIDE (anche dentro altre cartelle), un intero workspace
// (più progetti), uno zip fatto su Windows (\ nei nomi) o un progetto "sciolto" con
// solo i .c/.h e il .ioc. Header CMSIS/HAL e Debug/ non si tengono: li dà il sito.
const SKIP_DIR = /(^|\/)(Drivers|Middlewares|Debug|Release|__MACOSX|\.settings|\.metadata)\//;
const USEFUL = f => /\.(c|h)$/.test(f) || /(^|\/)[^/]+\.ioc$/.test(f) || /(^|\/)\.cproject$/.test(f) || /(^|\/)\.scheda-virtuale\.json$/.test(f);
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
function info(rec) {
  const ioc = iocOf(rec);
  const dev = mcuDefine(ioc.mcu);
  return {
    id: rec.nome, name: rec.nome, workspace: 'Progetti di ' + shown, path: rec.nome,
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
  return [...src, ...inc].map(rel => ({ name: rel.split('/').pop(), rel, content: dec.decode(rec.files[rel]) }));
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
const compiler = new Worker(new URL('./compiler-worker.js', import.meta.url), { type: 'module' });
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
const compile = files => new Promise(res => { const seq = ++compSeq; compPending.set(seq, res); compiler.postMessage({ type: 'build', seq, files }); });

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
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
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
  if (state.project) devicesOf(state.project.id).then(r => { pushDevices(r.devices); go(); }); else go();
  setStatus('running', { buildErrors: [] });
}

async function runProject(id) {
  const rec = await dbGet(id);
  if (!rec) return { ok: false, errors: [{ file: '', line: 0, msg: 'Progetto non trovato' }] };
  const inf = info(rec);
  if (!inf.supported) {
    log('error', `${inf.name}: micro "${inf.mcu || '?'}" non supportato (per ora solo STM32F4, es. NUCLEO-F401RE)`);
    return { ok: false, errors: [{ file: '', line: 0, msg: 'Micro non supportato: ' + (inf.mcu || 'sconosciuto') }] };
  }
  stopSim();
  setStatus('building', { project: { id: inf.id, name: inf.name, workspace: inf.workspace, path: inf.path }, source: 'ui', buildErrors: [] });
  log('info', `Compilo ${inf.name}` + (compReady ? '' : ' (prima scarico il compilatore)'));
  const t0 = performance.now();
  const r = await compile(rec.files);
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
    case '/api/projects': return (await dbAll()).map(info).sort((a, b) => b.modified - a.modified);
    case '/api/project': {
      const rec = await dbGet(q.get('id'));
      if (!rec) return { error: 'progetto non trovato' };
      return { info: info(rec), files: projectFiles(rec), ioc: iocOf(rec) };
    }
    case '/api/run': return runProject(body.id);
    case '/api/stop': stopSim(); setStatus('stopped'); return { ok: true };
    case '/api/reset':
      if (lastWasm && state.project) { log('info', 'Reset'); startSim(lastWasm); return { ok: true }; }
      return { error: 'niente da resettare' };
    case '/api/cmd': {
      const lines = (Array.isArray(body.lines) ? body.lines : [body.line]).filter(l => typeof l === 'string' && /^[IVRSPTK][ -~]{0,1100}$/.test(l));
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
    for (const r of all) if (!String(r.utente).startsWith('account:')) m[r.utente] = (m[r.utente] || 0) + 1;
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
  async newProject(nome) {
    const m = await (await fetch('modello/nucleo-f401re.json')).json();
    nome = await freeName(nome);
    const enc = new TextEncoder(), files = {};
    for (const [k, v] of Object.entries(m.files)) {
      if (k.endsWith('.ioc')) files[nome + '.ioc'] = enc.encode(v.replace(/^ProjectManager\.ProjectName=.*$/m, 'ProjectManager.ProjectName=' + nome));
      else files[k] = enc.encode(v);
    }
    await userPut({ utente: user, nome, files, devices: null, sync: {} });
    return nome;
  },
  async rename(nome, nuovo) {
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
    if (state.project && state.project.id === nome) { stopSim(); setStatus('idle', { project: null }); }
    const rec = await dbGet(nome);
    if (ACCOUNT && rec && rec.sync && rec.sync.id) await tx('readwrite', s => s.put({ utente: user, id: rec.sync.id, version: rec.sync.version }), 'eliminati');
    await dbDel(nome);
    syncSoon();
  },
  // salva un file modificato nel sito
  async saveFile(nome, rel, content) {
    const rec = await dbGet(nome);
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
};

// ------------------------------------------------------------------
// Avvio dell'interfaccia: gli script "classici" della versione per Mac, in ordine
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.body.appendChild(s); });
}
if (ACCOUNT) {
  // account online: accesso/iscrizione prima di tutto il resto (auth.js)
  remote = CFG.BACKEND === 'finto' ? fintoRemote(CFG) : await supabaseRemote(CFG);
  const { accedi } = await import('./auth.js');
  account = await accedi(remote);
  user = 'account:' + account.id;
  shown = account.username;
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
for (const s of ['devices.js', 'app.js', 'web-ui.js']) await loadScript(s);
await import('./editor.js');
if (ACCOUNT) {
  syncNow();
  setInterval(syncNow, 60000);
  window.addEventListener('online', syncNow);
}
