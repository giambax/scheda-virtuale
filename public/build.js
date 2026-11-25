// build.js — compila un progetto CubeIDE in WebAssembly con la HAL simulata.
// Gira nel browser (compiler-worker.js) e in Node (prove da terminale).
// Stessa logica di build() in scheda-virtuale/server.js, ma con clang in
// WebAssembly (YoWASP) e un file system virtuale in memoria.

import { strumenta, PROLOGO } from './strumenta.js?v=2026-11-25k';

// Memoria lineare del WebAssembly (wasm-ld con --stack-first):
//   0x000000–0x700000  stack (se trabocca si esce sotto lo 0 → errore, come un HardFault)
//   0x700000–0x800000  registri delle periferiche (zone qui sotto)
//   0x800000–…         variabili del programma, poi heap
// [indirizzo vero, dimensione, indirizzo nel WebAssembly]
export const STACK_SIZE = 0x700000;
const WINDOWS = [
  [0x40000000, 0x30000, 0x700000],   // APB1, APB2, AHB1 (GPIO, RCC, DMA…)
  [0x50000000, 0x61000, 0x730000],   // AHB2 (USB OTG)
  [0xE0000000, 0x43000, 0x7A0000],   // core: ITM, DWT, NVIC, SysTick, SCB, DBGMCU
  [0x1FFF0000, 0x10000, 0x7F0000],   // system memory: UID, dimensione flash
];
export const GLOBAL_BASE = 0x800000;

function mapAddr(v) {
  for (const [a, n, w] of WINDOWS) if (v >= a && v < a + n) return w + (v - a);
  return null;
}

// riscrive le #define …_BASE con l'indirizzo nella memoria lineare
export function patchBases(txt) {
  const vals = {};
  const re = /^([ \t]*#define[ \t]+)(\w+_BASE(?:_NS)?)([ \t]+)([^\n]*?)([ \t]*(?:\/\*[^\n]*|\/\/[^\n]*)?)$/gm;
  const evalExpr = e => {
    const terms = e.replace(/[()]/g, '').split('+').map(t => t.trim()).filter(Boolean);
    let sum = 0;
    for (const t of terms) {
      const m = /^(0[xX][0-9A-Fa-f]+|\d+)[uUlL]*$/.exec(t);
      if (m) sum += Number(m[1]);
      else if (vals[t] !== undefined) sum += vals[t];
      else return null;
    }
    return sum;
  };
  return txt.replace(re, (all, pre, name, sp, expr, cmt) => {
    const v = evalExpr(expr);
    if (v === null) return all;
    vals[name] = v;
    const w = mapAddr(v);
    if (w === null) return all;
    return `${pre}${name}${sp}(0x${w.toString(16).toUpperCase()}UL) /* sim: 0x${v.toString(16).toUpperCase()} */${cmt ? ' ' + cmt.trim() : ''}`;
  });
}

const CORE_OVERRIDES = `
#ifndef SIM_CORE_OVERRIDES
#define SIM_CORE_OVERRIDES
void sim_NVIC_EnableIRQ(IRQn_Type IRQn);
void sim_NVIC_DisableIRQ(IRQn_Type IRQn);
void sim_NVIC_SetPendingIRQ(IRQn_Type IRQn);
void sim_NVIC_ClearPendingIRQ(IRQn_Type IRQn);
uint32_t sim_NVIC_GetPendingIRQ(IRQn_Type IRQn);
uint32_t sim_NVIC_GetEnableIRQ(IRQn_Type IRQn);
void sim_NVIC_SystemReset(void) __attribute__((noreturn));
#undef NVIC_EnableIRQ
#define NVIC_EnableIRQ sim_NVIC_EnableIRQ
#undef NVIC_DisableIRQ
#define NVIC_DisableIRQ sim_NVIC_DisableIRQ
#undef NVIC_SetPendingIRQ
#define NVIC_SetPendingIRQ sim_NVIC_SetPendingIRQ
#undef NVIC_ClearPendingIRQ
#define NVIC_ClearPendingIRQ sim_NVIC_ClearPendingIRQ
#undef NVIC_GetPendingIRQ
#define NVIC_GetPendingIRQ sim_NVIC_GetPendingIRQ
#undef NVIC_GetEnableIRQ
#define NVIC_GetEnableIRQ sim_NVIC_GetEnableIRQ
#undef NVIC_SystemReset
#define NVIC_SystemReset sim_NVIC_SystemReset
#endif
`;

const dec = new TextDecoder();
const text = v => typeof v === 'string' ? v : dec.decode(v);

// file del progetto: { "Prog/Core/Src/main.c": Uint8Array|string, … } → radice del progetto
export function projectRoot(files) {
  const k = Object.keys(files).filter(f => /(^|\/)Core\/Src\/main\.c$/.test(f)).sort((a, b) => a.length - b.length)[0];
  return k === undefined ? null : k.slice(0, k.length - 'Core/Src/main.c'.length);
}

export function parseCproject(txt) {
  const defs = new Set(), incs = new Set(), entries = [];
  const cfg = txt.split('<storageModule moduleId="cdtBuildSystem"')[1] || txt;
  const optRe = /<option ([^>]*[^/])>([\s\S]*?)<\/option>/g;
  let m;
  while ((m = optRe.exec(cfg))) {
    const vals = [...m[2].matchAll(/<listOptionValue[^>]*value="([^"]*)"/g)].map(x => x[1]);
    const sc = (m[1].match(/superClass="([^"]+)"/) || [])[1] || '';
    if (/c\.compiler\.option\.definedsymbols|c\.compiler\.option\.preprocessor\.def/.test(sc)) vals.forEach(v => defs.add(v));
    if (/c\.compiler\.option\.includepaths/.test(sc)) vals.forEach(v => incs.add(v));
    if (defs.size && incs.size && /linker/.test(sc)) break;
  }
  const se = (cfg.match(/<sourceEntries>([\s\S]*?)<\/sourceEntries>/) || [])[1] || '';
  for (const e of se.matchAll(/name="([^"]*)"/g)) entries.push(e[1]);
  return { defs: [...defs], incs: [...incs], entries };
}

export function readIoc(txt) {
  const pins = {};
  if (!txt) return { pins };
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^(P[A-H]\d{1,2})[^.]*\.(GPIO_Label|Signal|Mode|GPIO_PuPd|GPIO_ModeDefaultEXTI)=(.*)$/);
    if (!m) continue;
    pins[m[1]] = pins[m[1]] || {};
    pins[m[1]][m[2]] = m[3].replace(/\\:/g, ':');
  }
  const get = k => (txt.match(new RegExp('^' + k.replace(/\./g, '\\.') + '=(.*)$', 'm')) || [])[1];
  return { pins, tim: Object.fromEntries(txt.split(/\r?\n/).filter(l => /^TIM\d+\.(Prescaler|Period|Pulse|EncoderMode)/.test(l)).map(l => l.split('='))), sysclk: get('RCC.SYSCLKFreq_VALUE'), mcu: get('Mcu.UserName') || '', board: get('board') || '' };
}

// GCC accetta funzioni scritte dentro un'altra funzione (estensione GNU, es. void Display(){…}
// dentro main), clang no: le sposto subito prima della funzione che le contiene, con #line
// così errori e debugger indicano ancora la riga vera del file.
const NESTED_RE = /^(?:(?:static|inline)\s+)*(?:void|char|short|int|long|float|double|unsigned|signed|_Bool|bool|u?int(?:8|16|32|64)_t|[A-Za-z_]\w*_t)(?:\s+(?:int|long|char))*[\s*]+([A-Za-z_]\w*)\s*\([^;{}()]*\)\s*\{/;
export function hoistNested(src, file) {
  const n = src.length, moves = [], names = [];
  let depth = 0, topEnd = 0, outerStart = -1, stmt = true;
  const lineAt = i => src.slice(0, i).split('\n').length;
  // salta commenti, stringhe e caratteri; restituisce il nuovo indice
  const skip = i => {
    if (src[i] === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); return e < 0 ? n : e; }
    if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? n : e + 2; }
    if (src[i] === '"' || src[i] === "'") { const q = src[i]; let j = i + 1; while (j < n && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1; return j + 1; }
    if (src[i] === '#' && /(^|\n)[ \t]*$/.test(src.slice(Math.max(0, i - 200), i))) { let j = i; while (j < n && (src[j] !== '\n' || src[j - 1] === '\\')) j++; return j; }
    return -1;
  };
  for (let i = 0; i < n;) {
    const k = skip(i);
    if (k >= 0) { i = k; continue; }
    const c = src[i];
    if (depth >= 1 && stmt && /[A-Za-z_]/.test(c)) {
      const m = NESTED_RE.exec(src.slice(i, i + 400));
      if (m && !/^(if|while|for|switch|return|else|do|sizeof)$/.test(m[1])) {
        let j = i + m[0].length, d = 1;
        while (j < n && d > 0) { const k2 = skip(j); if (k2 >= 0) { j = k2; continue; } if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; }
        moves.push({ from: i, to: j, at: topEnd });
        names.push(m[1]);
        i = j;
        stmt = true;
        continue;
      }
    }
    if (c === '{') { if (depth === 0) outerStart = i; depth++; stmt = true; }
    else if (c === '}') { depth--; stmt = true; if (depth === 0) topEnd = i + 1; }
    else if (c === ';') { stmt = true; if (depth === 0) topEnd = i + 1; }
    else if (!/\s/.test(c)) stmt = false;
    i++;
  }
  if (!moves.length) return null;
  const q = JSON.stringify(file);
  let out = '', pos = 0;
  // inserimenti (prima della funzione esterna) e tagli (sostituiti da righe vuote) in ordine di posizione
  const ops = [];
  for (const mv of moves) {
    ops.push({ i: mv.at, ins: `\n#line ${lineAt(mv.from)} ${q}\n${src.slice(mv.from, mv.to)}\n#line ${lineAt(mv.at)} ${q}\n` });
    ops.push({ i: mv.from, cut: mv.to });
  }
  ops.sort((a, b) => a.i - b.i || (a.ins ? -1 : 1));
  for (const o of ops) {
    out += src.slice(pos, o.i);
    if (o.ins) { out += o.ins; pos = o.i; }
    else { out += src.slice(o.i, o.cut).replace(/[^\n]/g, ' '); pos = o.cut; }
  }
  out += src.slice(pos);
  return { text: `#line 1 ${q}\n` + out, names };
}


function parseDiagnostics(out) {
  const errs = [];
  const re = /^(.*?):(\d+):(\d+): (fatal error|error): (.*)$/gm;
  let m;
  while ((m = re.exec(out))) errs.push({ file: m[1].replace(/^\/?p\//, ''), line: +m[2], col: +m[3], msg: m[5] });
  if (!errs.length && /error/i.test(out)) errs.push({ file: '', line: 0, msg: out.trim().slice(0, 4000) });
  return errs.slice(0, 50);
}

// albero per il file system virtuale di YoWASP: "a/b/c.h" → { a: { b: { 'c.h': … } } }
function getP(tree, rel) {
  let t = tree;
  for (const p of rel.split('/').filter(Boolean)) { if (!t || typeof t !== 'object') return undefined; t = t[p]; }
  return t;
}
function put(tree, rel, data) {
  const parts = rel.split('/').filter(Boolean);
  let t = tree;
  for (const p of parts.slice(0, -1)) t = t[p] = (t[p] && typeof t[p] === 'object' && !(t[p] instanceof Uint8Array)) ? t[p] : {};
  t[parts[parts.length - 1]] = data;
}
async function hash(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const simHalCache = new Map();   // impronta degli header → sim_hal.o (vale finché il worker è vivo)

// files: file del progetto (percorsi relativi, come da cartella o zip); sim: { 'sim_hal.c', 'sim_pre.h', 'cmsis_gcc.h' }
// cc: { runClang } di @yowasp/clang
// pin con etichetta presi da main.h (#define LD2_Pin GPIO_PIN_5 / LD2_GPIO_Port GPIOA):
// servono quando il progetto non ha il .ioc
export function pinsFromMainH(txt) {
  const pins = {}, pin = {}, port = {};
  for (const m of txt.matchAll(/^\s*#define\s+(\w+)_Pin\s+GPIO_PIN_(\d+)\b/gm)) pin[m[1]] = +m[2];
  for (const m of txt.matchAll(/^\s*#define\s+(\w+)_GPIO_Port\s+GPIO([A-H])\b/gm)) port[m[1]] = m[2];
  for (const [lab, n] of Object.entries(pin)) if (port[lab]) pins[`P${port[lab]}${n}`] = { GPIO_Label: lab };
  return pins;
}

// main.h come lo scrive CubeMX, dalle etichette del .ioc (progetti con solo i .c e il .ioc)
export function mainHFromIoc(ioc) {
  const defs = Object.entries(ioc.pins || {}).filter(([, v]) => v.GPIO_Label).map(([k, v]) => {
    const lab = v.GPIO_Label.replace(/\s*\[.*\]\s*$/, '').trim().replace(/\W/g, '_');
    return `#define ${lab}_Pin GPIO_PIN_${+k.slice(2)}\n#define ${lab}_GPIO_Port GPIO${k[1]}`;
  });
  return `/* main.h generato dalla scheda virtuale (il progetto non lo aveva) */
#ifndef __MAIN_H
#define __MAIN_H
#include "stm32f4xx_hal.h"
void Error_Handler(void);
${defs.join('\n')}
#endif
`;
}

// micro del progetto → simbolo per gli header (es. STM32F401RETx → STM32F401xE)
export function mcuDefine(mcu) {
  const m = /^STM32F4(\d\d)(.)(.)/i.exec(mcu || '');
  return m ? `STM32F4${m[1]}x${m[3].toUpperCase()}` : null;
}

// files: file del progetto (percorsi relativi, come da cartella o zip); sim: { 'sim_hal.c', 'sim_pre.h', 'cmsis_gcc.h' }
// hal: header CMSIS/HAL forniti dal sito ({ files, ugNoUif }, vendor/stm32f4/pacchetto.json)
// cc: { runClang } di @yowasp/clang
export async function buildProject(files, sim, hal, cc, log = () => {}, opz = {}) {
  const T = { start: Date.now() };
  const root = projectRoot(files);
  if (root === null) return { ok: false, errors: [{ file: '', line: 0, msg: 'Non trovo Core/Src/main.c: scegli la cartella del progetto CubeIDE.' }] };
  const P = {};
  for (const [k, v] of Object.entries(files)) if (k.startsWith(root) && !k.startsWith(root + 'Drivers/')) P[k.slice(root.length)] = v;
  const iocName = Object.keys(P).find(f => !f.includes('/') && f.endsWith('.ioc'));
  const ioc = readIoc(iocName ? text(P[iocName]) : '');
  // header uguali per tutti (dal sito); del progetto restano solo Core/ e le sue cartelle
  for (const [k, v] of Object.entries(hal.files)) if (k.startsWith('Drivers/') || !P[k]) P[k] = v;
  if (!P['Core/Inc/main.h']) P['Core/Inc/main.h'] = mainHFromIoc(ioc);
  if (!P['Core/Inc/stm32f4xx_it.h']) P['Core/Inc/stm32f4xx_it.h'] = '/* generato */\n';

  const tree = { p: {}, inc: { cmsis: {}, device: {} }, sim: {}, o: {} };
  const cmsisDir = 'Drivers/CMSIS/Include/', devDir = 'Drivers/CMSIS/Device/ST/STM32F4xx/Include/';
  const halDir = 'Drivers/STM32F4xx_HAL_Driver/Inc/';

  // CMSIS core e device: istruzioni ARM sostituite + registri nella memoria lineare
  let fingerprint = hal.versione || '';
  for (const [f, v] of Object.entries(P)) {
    if (f.startsWith(cmsisDir) && f.endsWith('.h') && !f.slice(cmsisDir.length).includes('/')) {
      let t = text(v);
      const n = f.slice(cmsisDir.length);
      if (n === 'cmsis_gcc.h') t = sim['cmsis_gcc.h'];
      if (n === 'core_cm4.h') t = patchBases(t) + CORE_OVERRIDES;
      put(tree.inc.cmsis, n, t);
    } else if (f.startsWith(devDir) && f.endsWith('.h')) {
      put(tree.inc.device, f.slice(devDir.length), patchBases(text(v)));
    } else if (/\.(c|h)$/.test(f) && !f.startsWith('Drivers/CMSIS/')) {
      put(tree.p, f, v);
    }
  }
  // la HAL simulata dipende anche da stm32f4xx_hal_conf.h del progetto (moduli abilitati)
  fingerprint += text(P['Core/Inc/stm32f4xx_hal_conf.h']);
  put(tree.sim, 'sim_hal.c', sim['sim_hal.c']);
  put(tree.sim, 'sim_pre.h', sim['sim_pre.h']);

  let cp = { defs: ['USE_HAL_DRIVER'], incs: [], entries: ['Core'] };
  if (P['.cproject']) try { cp = parseCproject(text(P['.cproject'])); } catch {}
  let defs = cp.defs.filter(d => !/^DEBUG$/.test(d));
  if (!defs.some(d => /^STM32F4/.test(d))) {
    // senza .cproject (es. zip senza file nascosti): il micro dal .ioc, altrimenti quello della Nucleo-F401RE
    defs = ['USE_HAL_DRIVER', mcuDefine(ioc.mcu) || 'STM32F401xE'];
  }
  const dev = defs.find(d => /^STM32F4/.test(d));
  if (!tree.inc.device[dev.toLowerCase() + '.h'])
    return { ok: false, errors: [{ file: '', line: 0, msg: `Micro ${dev} non supportato dal simulatore (per ora STM32F401 e STM32F411).` }] };
  const std = new Set(['../Core/Inc', '../Drivers/STM32F4xx_HAL_Driver/Inc', '../Drivers/STM32F4xx_HAL_Driver/Inc/Legacy', '../Drivers/CMSIS/Device/ST/STM32F4xx/Include', '../Drivers/CMSIS/Include']);
  const extra = cp.incs.filter(i => !std.has(i) && i.startsWith('../')).map(i => 'p/' + i.slice(3));
  const incFlags = ['-I', 'inc/cmsis', '-I', 'inc/device', '-I', 'p/Core/Inc', '-I', 'p/' + halDir.slice(0, -1), '-I', 'p/' + halDir + 'Legacy', ...extra.flatMap(i => ['-I', i])];
  const ugNoUif = hal.ugNoUif !== false;
  const common = ['--target=wasm32-wasip1', '-c', '-std=gnu11', '-O1', '-w', '-funsigned-char', '-fno-common', '-fno-strict-aliasing',
    '-Wno-error=implicit-function-declaration', '-Wno-error=implicit-int', '-Wno-error=int-conversion',
    '-Wno-error=incompatible-pointer-types', '-Wno-error=incompatible-function-pointer-types', '-Wno-error=return-type',
    '-fno-color-diagnostics', '-DSIM_HOST', '-DSIM_WASM', ...defs.map(d => '-D' + d), ...incFlags];

  // sorgenti dell'utente
  const skip = new Set(['syscalls.c', 'sysmem.c', 'system_stm32f4xx.c']);
  const entries = (cp.entries.length ? cp.entries : ['Core']).filter(e => !/^(Drivers|Middlewares)(\/|$)/.test(e) && !/Startup/.test(e));
  let srcs = Object.keys(P).filter(f => f.endsWith('.c') && entries.some(e => f.startsWith(e + '/')) && !skip.has(f.split('/').pop()) && !/(^|\/)Startup\//.test(f));
  if (!srcs.includes('Core/Src/main.c')) return { ok: false, errors: [{ file: '', line: 0, msg: 'Non trovo Core/Src/main.c' }] };
  const notes = [];
  for (const f of srcs) {
    const h = hoistNested(text(P[f]), 'p/' + f);
    if (!h) continue;
    notes.push(`${f.split('/').pop()}: ${h.names.map(x => x + '()').join(', ')} è scritta dentro un'altra funzione (lo accetta solo GCC): nel simulatore la sposto fuori. Meglio scriverla prima di main().`);
    put(tree.p, f, h.text);
  }
  // debug passo passo (strumenta.js): punti di arresto, variabili e funzioni registrate; -O0 per vedere tutto
  const debug = opz.debug ? { file: [] } : null;
  if (debug) {
    put(tree.sim, 'sim_dbg.h', PROLOGO);
    for (let i = 0; i < srcs.length; i++) {
      const cur = getP(tree.p, srcs[i]);
      const r = strumenta(typeof cur === 'string' ? cur : text(cur !== undefined ? cur : P[srcs[i]]), i);
      put(tree.p, srcs[i], r.testo);
      debug.file.push({ rel: srcs[i], righe: r.righe, funzioni: r.funzioni, globali: r.globali });
    }
  }

  let out = '';
  const capture = { stdout: b => { if (b) out += dec.decode(b); }, stderr: b => { if (b) out += dec.decode(b); } };
  const run = async (args) => {
    try { const r = await cc.runClang(args, tree, capture); return { code: 0, files: r }; }
    catch (e) { if (e && e.files) return { code: e.code || 1, files: e.files }; throw e; }
  };
  const objs = {};
  // sorgenti dell'utente: un file per volta (errori con il nome giusto)
  T.compileStart = Date.now();
  const failed = [];
  for (let i = 0; i < srcs.length; i++) {
    const o = `o/u${i}.o`;
    const r = await run(['clang', ...(debug ? common.map(a => a === '-O1' ? '-O0' : a) : common), '-include', 'sim/sim_pre.h', ...(debug ? ['-include', 'sim/sim_dbg.h'] : []), '-Dmain=user_main', '-iquote', 'p/' + srcs[i].split('/').slice(0, -1).join('/'), 'p/' + srcs[i], '-o', o]);
    if (r.code) failed.push(srcs[i]);
    else objs[o] = r.files.o[`u${i}.o`];
  }
  T.user = Date.now() - T.compileStart;
  if (failed.length) return { ok: false, errors: parseDiagnostics(out), log: out, notes, T };

  // HAL simulata: dipende solo da header e simboli → riusata se non cambiano
  const key = await hash(fingerprint + defs.join(' ') + ugNoUif + (debug ? 'dbg' : '') + sim['sim_hal.c'] + sim['sim_pre.h']);
  T.halStart = Date.now();
  let halObj = simHalCache.get(key);
  T.halCached = !!halObj;
  if (!halObj) {
    // la HAL simulata a -O2 (il codice del progetto resta a -O1): stesso comportamento, giri di ciclo più veloci
    const r = await run(['clang', ...common.map(x => x === '-O1' ? '-O2' : x), ...(ugNoUif ? ['-DSIM_UG_NO_UIF'] : []), ...(debug ? ['-DSIM_DBG'] : []), 'sim/sim_hal.c', '-o', 'o/sim_hal.o']);
    if (r.code) return { ok: false, errors: parseDiagnostics(out), log: out, notes, T };
    halObj = r.files.o['sim_hal.o'];
    simHalCache.set(key, halObj);
  }
  T.hal = Date.now() - T.halStart;

  // link (+ funzioni HAL non simulate sostituite da "stub", come nella versione per Mac)
  T.linkStart = Date.now();
  const linkFlags = ['--target=wasm32-wasip1', '-Wl,--stack-first', '-Wl,-z,stack-size=' + STACK_SIZE, '-Wl,--global-base=' + GLOBAL_BASE, '-Wl,--error-limit=0', '-lm'];
  let stubs = [];
  const ltree = { o: { ...Object.fromEntries(Object.entries(objs).map(([k, v]) => [k.slice(2), v])), 'sim_hal.o': halObj } };
  for (let attempt = 0; attempt < 3; attempt++) {
    out = '';
    let r;
    try { r = { code: 0, files: await cc.runClang(['clang', ...Object.keys(ltree.o).map(f => 'o/' + f), '-o', 'scheda.wasm', ...linkFlags], ltree, capture) }; }
    catch (e) { if (!e || !e.files) throw e; r = { code: e.code || 1, files: e.files }; }
    if (!r.code) {
      T.link = Date.now() - T.linkStart;
      T.total = Date.now() - T.start;
      return { ok: true, wasm: r.files['scheda.wasm'], stubs, errors: [], log: out, notes, ioc, T, debug };
    }
    const undef = [...new Set([...out.matchAll(/undefined symbol: ([A-Za-z0-9_]+)/g)].map(m => m[1]))].filter(s => !stubs.includes(s));
    if (!undef.length) return { ok: false, errors: [{ file: '', line: 0, msg: 'Errore di link:\n' + out.trim() }], log: out, notes, T };
    const user = undef.filter(s => !/^(HAL_|HALEx_|LL_|USB|MX_)/.test(s) && !/^(SystemClock_Config)$/.test(s));
    if (user.length && attempt === 0) {
      const realMissing = user.filter(s => !/^(__|_)/.test(s));
      if (realMissing.length) return { ok: false, errors: realMissing.map(s => ({ file: '', line: 0, msg: `riferimento non definito a '${s}' (funzione o variabile usata ma mai scritta)` })), log: out, notes, T };
    }
    stubs.push(...undef);
    const code = '/* generato: funzioni non simulate */\nvoid __sim_stub(const char *);\n' +
      stubs.map(s => `int ${s}(void) { __sim_stub("${s}"); return 0; }`).join('\n') + '\n';
    const sr = await (async () => { try { return await cc.runClang(['clang', '--target=wasm32-wasip1', '-c', '-w', 'stubs.c', '-o', 'stubs.o'], { 'stubs.c': code }, capture); } catch (e) { return null; } })();
    if (!sr) return { ok: false, errors: [{ file: '', line: 0, msg: out }], log: out, notes, T };
    ltree.o['stubs.o'] = sr['stubs.o'];
  }
  return { ok: false, errors: [{ file: '', line: 0, msg: 'Link non riuscito' }], log: out, notes, T };
}
