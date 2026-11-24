// compiler-worker.js — clang in WebAssembly (YoWASP) in un worker che resta vivo:
// il compilatore si scarica e si prepara una volta sola, le compilazioni dopo sono veloci.
import { runClang } from '../vendor/yowasp-clang/gen/bundle.js';
import { buildProject } from './build.js?v=2026-11-24h';

let simFiles = null;
const loadSim = async () => simFiles || (simFiles = Object.fromEntries(await Promise.all(
  ['sim_hal.c', 'sim_pre.h', 'cmsis_gcc.h'].map(async f => [f, await (await fetch('../sim/' + f + '?v=2026-11-24h')).text()]))));

// header CMSIS/HAL della famiglia F4 forniti dal sito (strumenti/crea-pacchetto-hal.py)
let halPack = null;
const loadHal = async () => halPack || (halPack = await (await fetch('../vendor/stm32f4/pacchetto.json')).json());

let ready = null;
function warmup() {
  if (ready) return ready;
  const t0 = performance.now();
  let last = 0;
  ready = runClang(null, {}, {
    fetchProgress: ({ totalLength, doneLength }) => {
      const now = performance.now();
      if (now - last > 200 || doneLength === totalLength) { last = now; postMessage({ type: 'progress', total: totalLength, done: doneLength }); }
    },
  }).then(async () => {
    await Promise.all([loadSim(), loadHal()]);
    postMessage({ type: 'progress', ready: true, ms: performance.now() - t0 });
  });
  return ready;
}

onmessage = async ev => {
  const m = ev.data;
  if (m.type === 'warmup') return warmup();
  if (m.type === 'build') {
    let result;
    try {
      await warmup();
      result = await buildProject(m.files, await loadSim(), await loadHal(), { runClang });
    } catch (e) {
      result = { ok: false, errors: [{ file: '', line: 0, msg: 'Errore del compilatore: ' + (e && e.message || e) }] };
    }
    postMessage({ seq: m.seq, result }, result.wasm ? [result.wasm.buffer] : []);
  }
};
