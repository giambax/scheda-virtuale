// sim-worker.js — esegue la scheda compilata. Il worker resta dentro il WebAssembly
// finché la scheda gira (Stop = la pagina chiude il worker); gli eventi escono a pacchetti.
import { runSim, trapMessage } from './sim-runtime.js?v=2026-11-26a';

onmessage = ev => {
  const { wasm, sab } = ev.data;
  let pend = '', last = 0;
  const out = t => {
    pend += t;
    const now = performance.now();
    if (now - last > 15 || pend.length > 200000) { postMessage({ out: pend }); pend = ''; last = now; }
  };
  try {
    const code = runSim(new WebAssembly.Module(wasm), sab, out, c => postMessage({ console: c }), () => { if (pend) { postMessage({ out: pend }); pend = ''; last = performance.now(); } });
    if (pend) postMessage({ out: pend });
    postMessage({ exit: code });
  } catch (e) {
    if (pend) postMessage({ out: pend });
    postMessage({ trap: trapMessage(e) });
  }
};
